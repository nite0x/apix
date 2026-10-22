// Environment discovery never starts a stopped WSL distribution. Checking is explicit.
export function environmentLabel(id) {
  if (!id || id === 'local') return '本机';
  const parts = id.split(':');
  try { return parts[0] === 'wsl' ? `WSL · ${decodeURIComponent(parts[1])}${parts[2] ? ' · ' + decodeURIComponent(parts[2]) : ''}` : id; }
  catch { return id; }
}
export async function loadEnvironments(select, selected = 'local', signal) {
  const response = await fetch('/api/execution-environments', { cache: 'no-store', signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '无法读取运行环境');
  if(signal?.aborted)return data;
  const items = Array.isArray(data.items) ? data.items : [{ id: 'local', name: '本机' }];
  if (selected && !items.some(item => item.id === selected)) items.push({ id: selected, name: environmentLabel(selected) });
  select.replaceChildren(...items.map(item => new Option(item.name || environmentLabel(item.id), item.id)));
  select.value = selected || 'local';
  return data;
}
export async function checkEnvironment(spec) {
  const response = await fetch('/api/execution-environments/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec), signal: AbortSignal.timeout(45000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '运行环境检查失败');
  return data;
}
export function withUser(id, user) {
  if (!id.startsWith('wsl:')) return id;
  const parts = id.split(':');
  return `wsl:${parts[1]}:${encodeURIComponent(user.trim())}`;
}
