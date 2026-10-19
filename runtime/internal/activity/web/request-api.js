export async function requestAPI(path, body, method = 'GET') {
  const response = await fetch(`/api${path}`, {
    method, cache: 'no-store', signal: AbortSignal.timeout(path === '/runs' ? 70000 : 15000),
    ...(body == null ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok && !(path === '/runs' && result.id && result.request_snapshot)) {
    const error = new Error(result.error || `操作失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return result;
}
export function requestError(error) {
  return error.name === 'TimeoutError' || error instanceof TypeError
    ? '未能确认操作结果，请检查连接后刷新重试。' : error.message;
}
