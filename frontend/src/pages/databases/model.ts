export type Driver = 'mysql' | 'postgresql' | 'hologres';

export interface DatabaseConnection {
  id: string;
  name: string;
  type: Driver;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  ssl_mode?: string;
  edit_version?: number;
  archived?: boolean;
  credentials_cleared?: boolean;
}

export interface SQLResult {
  execution_id?: number;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  rows_affected: number;
  duration_ms: number;
  truncated?: boolean;
}

export interface SQLExecution {
  id: number;
  connection_id: string;
  connection_name: string;
  connection_status?: string;
  sql: string;
  params?: unknown[];
  mode: 'query' | 'exec';
  status: string;
  started_at: string;
  duration_ms: number;
  row_count: number;
  rows_affected: number;
  truncated?: boolean;
  error?: string;
  batch_id?: string;
  test_run_id?: string;
  flow_id?: string;
  flow_run_id?: string;
  step_id?: string;
}

export const driverLabels: Record<Driver, string> = { mysql: 'MySQL', postgresql: 'PostgreSQL', hologres: 'Hologres' };
export const driverPorts: Record<Driver, number> = { mysql: 3306, postgresql: 5432, hologres: 80 };

export function databaseError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/context deadline exceeded|i\/o timeout|connect.*timed out/i.test(text)) return '连接超时，请检查主机、端口和网络连通性；VPC 地址需要本机可访问对应的专有网络。';
  if (text.includes('direct connection settings are missing')) return '此旧连接缺少连接信息，请重新编辑主机、端口、库名和账号。';
  if (text.includes('cannot decrypt database password')) return '无法解密连接密码，请使用原本地用户，或编辑连接更新密码。';
  if (text.includes('cannot encrypt database password')) return '密码加密保存失败，请检查本地用户和数据目录权限后重试。';
  if (text === 'database connection not found') return '连接配置已不存在，请刷新列表。';
  return error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')
    ? '无法确认操作结果，请检查 Runtime 连接后刷新执行记录，避免重复执行。'
    : text;
}

export function cellText(value: unknown): string {
  return value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
}

export function executionURL(record: SQLExecution): string | null {
  const query = new URLSearchParams();
  if (record.batch_id) {
    query.set('batch', record.batch_id);
    if (record.test_run_id || record.step_id) query.set('step', record.test_run_id || record.step_id || '');
  } else if (record.flow_run_id && record.flow_id) {
    query.set('type', 'flow');
    query.set('id', record.flow_id);
    query.set('run', record.flow_run_id);
    if (record.step_id) query.set('step', record.step_id);
  } else return null;
  return `/execution-records?${query}`;
}

export interface SQLDraft {
  connection_id: string;
  mode: 'query' | 'exec';
  sql: string;
  params: string;
  timeout: string;
  maxRows: string;
}

export const blankSQL: SQLDraft = { connection_id: '', mode: 'query', sql: '', params: '', timeout: '30', maxRows: '100' };

export function sqlPayload(draft: SQLDraft, connections: DatabaseConnection[]) {
  let params: unknown;
  try { params = JSON.parse(draft.params.trim() || '[]'); }
  catch { throw new Error('绑定参数必须是有效的 JSON 数组，例如 ["example", 123]。'); }
  if (!Array.isArray(params)) throw new Error('绑定参数必须是有效的 JSON 数组，例如 ["example", 123]。');
  if (!connections.some(item => item.id === draft.connection_id) || !draft.sql.trim()) throw new Error('请选择有效连接并填写 SQL 语句。');
  const timeout = Number(draft.timeout), maxRows = Number(draft.maxRows);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300 || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10000) {
    throw new Error('超时需为 1–300 秒，最多返回行数需为 1–10000 的整数。');
  }
  return { connection_id: draft.connection_id, mode: draft.mode, sql: draft.sql.trim(), params, timeout_ms: timeout * 1000, max_rows: maxRows };
}
