export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any) { super(message); this.name = 'ApiError'; }
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const url = path.startsWith('/api/') || path === '/api' ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  const headers = new Headers(options.headers);
  if (options.body != null && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const timeout = AbortSignal.timeout(url === '/api/runs' ? 70000 : (!options.method || options.method === 'GET') ? 15000 : url === '/api/execution-environments/check' ? 45000 : 330000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, { cache: 'no-store', ...options, headers, signal });
  if (response.status === 204) return null as T;
  const text = await response.text();
  let data: any;
  try { data = text ? JSON.parse(text) : null; } catch { throw new ApiError(`服务返回了无效响应（HTTP ${response.status}）`, response.status, null); }
  if (!response.ok) {
    // A failed HTTP target is a persisted run, not a failed write to the runtime.
    if (url === '/api/runs' && data?.id && data?.request_snapshot) return data as T;
    throw new ApiError(data?.error || `操作失败（HTTP ${response.status}）`, response.status, data);
  }
  return data as T;
}
export function json<T = any>(path: string, body: unknown, method = 'POST') { return api<T>(path, { method, body: JSON.stringify(body) }); }
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' || error instanceof TypeError ? '未能确认操作结果，请检查连接后刷新重试。' : error.message;
  return error == null ? '' : String(error);
}
