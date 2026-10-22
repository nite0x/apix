export interface Pair { name: string; value: string; enabled: boolean }
export interface RequestData {
  method: string;
  url: string;
  query_params?: Pair[];
  headers?: Pair[];
  body_type?: string;
  body?: string;
  auth_config?: { type?: string; in?: string; name?: string; redacted?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}
export interface Collection { id: string; name: string; description?: string; [key: string]: unknown }
export interface SavedRequest { id: string; name: string; collection_id: string; description?: string; request: RequestData }
export interface WorkingCopy { id: string; name?: string; api_request_id?: string; edit_version: number; request: RequestData; [key: string]: unknown }
export interface RequestRun {
  id: string;
  status: string;
  request_snapshot: RequestData;
  response_status?: number;
  response_body?: unknown;
  response_headers?: Record<string, string | string[]>;
  response_size?: number;
  response_truncated?: boolean;
  duration_ms?: number;
  started_at?: string;
  finished_at?: string;
  trigger_type?: string;
  error_code?: string;
  error_message?: string;
  is_pinned?: boolean;
  batch_id?: string;
  test_run_id?: string;
  flow_run_id?: string;
  flow_id?: string;
  session_id?: string;
  step_id?: string;
  api_request_id?: string;
  working_copy_id?: string;
  environment_id?: string;
}
export interface Draft {
  name: string;
  description: string;
  collectionId: string;
  method: string;
  url: string;
  query: string;
  headers: string;
  bodyType: string;
  body: string;
}

export const blankRequest = (): RequestData => ({ method: 'GET', url: '', query_params: [], headers: [], body_type: 'none', body: '' });
export const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function toDraft(request: RequestData, metadata: Partial<SavedRequest> = {}): Draft {
  const pairs = (rows: Pair[] | undefined, separator: string) => (rows || []).filter(row => row.enabled).map(row => `${row.name}${separator}${row.value}`).join('\n');
  const type = request.body_type || (request.body ? 'raw' : 'none');
  return {
    name: metadata.name || '', description: metadata.description || '', collectionId: metadata.collection_id || '',
    method: request.method || 'GET', url: request.url || '', query: pairs(request.query_params, '='), headers: pairs(request.headers, ': '),
    bodyType: ['form', 'x-www-form-urlencoded'].includes(type) ? 'urlencoded' : ['none', 'json', 'raw', 'urlencoded'].includes(type) ? type : 'raw',
    body: request.body || '',
  };
}

export function parseRows(text: string, separator: ':' | '=', label: string): Pair[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    const at = line.indexOf(separator);
    if (at < 1 || !line.slice(0, at).trim()) throw new Error(`${label}第 ${index + 1} 行格式有误，请使用 ${separator === ':' ? '名称: 值' : 'key=value'}。`);
    return [{ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim(), enabled: true }];
  });
}

export function hasRedactions(request: RequestData): boolean {
  if (JSON.stringify(request).includes('••••')) return true;
  try { return decodeURIComponent(request.url || '').includes('••••'); } catch { return false; }
}

export function readDraft(draft: Draft, original: RequestData): RequestData {
  let url: URL;
  try { url = new URL(draft.url.trim()); } catch { throw new Error('请输入有效的请求地址。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('请求地址需要以 http:// 或 https:// 开头。');
  const bodyType = ['GET', 'HEAD'].includes(draft.method) ? 'none' : draft.bodyType;
  const request: RequestData = {
    ...original, method: draft.method, url: draft.url.trim(),
    query_params: [...parseRows(draft.query, '=', 'Query 参数'), ...(original.query_params || []).filter(row => !row.enabled)],
    headers: [...parseRows(draft.headers, ':', 'Header'), ...(original.headers || []).filter(row => !row.enabled)],
    body_type: bodyType, body: bodyType === 'none' ? '' : draft.body,
  };
  if (hasRedactions(request)) throw new Error('请先替换历史快照中已脱敏的字段，再发送或保存请求。');
  if (bodyType === 'json' && request.body?.trim()) {
    try { JSON.parse(request.body); } catch { throw new Error('Body 不是有效的 JSON，请检查后再发送。'); }
  }
  return request;
}

export function historyDraft(request: RequestData): { request: RequestData; draft: Draft; redacted: boolean } {
  // Historical auth values are redacted by the server and must never be replayed as credentials.
  const safe: RequestData = { ...request, query_params: (request.query_params || []).filter(row => row.enabled), headers: (request.headers || []).filter(row => row.enabled), auth_config: undefined };
  const draft = toDraft(safe);
  const auth = request.auth_config;
  if (['bearer', 'basic'].includes(auth?.type || '') && !(request.headers || []).some(row => row.enabled && row.name.toLowerCase() === 'authorization')) {
    draft.headers += `${draft.headers ? '\n' : ''}Authorization: ••••••`;
  } else if (auth?.type === 'api_key') {
    const name = auth.name || 'REPLACE_API_KEY_NAME';
    if (auth.in === 'query') draft.query += `${draft.query ? '\n' : ''}${name}=••••••`;
    else draft.headers += `${draft.headers ? '\n' : ''}${name}: ••••••`;
  }
  return { request: safe, draft, redacted: hasRedactions(request) || !!auth?.redacted || !!auth?.type };
}

export function requestURL(request: RequestData): string {
  try {
    const url = new URL(request.url);
    for (const item of request.query_params || []) if (item.enabled && item.name) url.searchParams.append(item.name, item.value);
    return url.toString().replaceAll(encodeURIComponent('••••••'), '••••••');
  } catch { return request.url || '—'; }
}

export function formatTime(value?: string): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

export function executionLink(run: Pick<RequestRun, 'batch_id' | 'test_run_id' | 'step_id' | 'flow_run_id' | 'flow_id'>): string | null {
  const query = new URLSearchParams();
  if (run.batch_id) {
    query.set('batch', run.batch_id);
    if (run.test_run_id || run.step_id) query.set('step', run.test_run_id || run.step_id!);
  } else if (run.flow_run_id && run.flow_id) {
    query.set('type', 'flow'); query.set('id', run.flow_id); query.set('run', run.flow_run_id);
    if (run.step_id) query.set('step', run.step_id);
  } else return null;
  return `/execution-records?${query}`;
}
