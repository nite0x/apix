const $ = id => document.getElementById(id);
const pending = new Set();
const feedback = new Map();
let connections = [];
let loaded = false;
let loading = false;
let revision = 0;
let saving = false;
let deleting = false;
let deleteTarget = null;
let draftID = null;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function message(id, text, error = false) {
  const element = $(id);
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle('error', error);
  element.setAttribute('role', error ? 'alert' : 'status');
}
async function request(path = '', options = {}) {
  const response = await fetch(`/api/database/connections${path}`, {
    cache: 'no-store', signal: AbortSignal.timeout(15000), ...options,
  });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function errorText(error) {
  if (error.message.includes('direct connection settings are missing')) return '此旧连接缺少连接信息，请删除后重新填写主机、端口、库名和账号。';
  if (error.message.includes('cannot decrypt database password')) return '无法解密此连接的密码，请使用保存连接时的本地用户，或删除后重新添加。';
  if (error.message.includes('cannot encrypt database password')) return '密码加密保存失败，请检查本地用户和数据目录权限后重试。';
  if (error.message === 'database connection not found') return '连接配置已不存在，请刷新列表。';
  return error.name === 'TimeoutError' || error instanceof TypeError
    ? '无法确认操作结果，请检查 Runtime 连接后刷新重试。' : error.message;
}
function render() {
  $('database-total').textContent = `${connections.length} 个连接`;
  const fragment = document.createDocumentFragment();
  for (const connection of connections) {
    const card = node('article', 'database-card');
    const heading = node('div', 'service-top');
    heading.append(node('h3', 'database-name', connection.name), node('span', 'badge status-running', 'MySQL'));
    const list = node('dl', 'database-pairs');
    list.append(node('dt', '', '连接 ID'), node('dd', '', connection.id));
    if (connection.host) {
      list.append(node('dt', '', '主机'), node('dd', '', `${connection.host.includes(':') ? `[${connection.host}]` : connection.host}:${connection.port}`), node('dt', '', '库名'), node('dd', '', connection.database), node('dt', '', '用户名'), node('dd', '', connection.username));
    } else { list.append(node('dt', '', '连接信息'), node('dd', '', '旧配置待重新添加')); }
    const actions = node('div', 'database-actions');
    const test = node('button', 'button small', pending.has(connection.id) ? '测试中…' : '测试连接');
    test.type = 'button'; test.disabled = pending.has(connection.id);
    test.setAttribute('aria-busy', String(pending.has(connection.id)));
    test.setAttribute('aria-label', `测试 ${connection.name} 的连接`);
    test.addEventListener('click', () => testConnection(connection));
    const remove = node('button', 'button small danger', '删除');
    remove.type = 'button'; remove.disabled = pending.has(connection.id);
    remove.setAttribute('aria-label', `删除 ${connection.name} 的连接配置`);
    remove.setAttribute('aria-haspopup', 'dialog'); remove.setAttribute('aria-controls', 'database-delete');
    remove.addEventListener('click', () => {
      deleteTarget = connection;
      $('database-delete-description').textContent = `确定删除“${connection.name}”的连接配置？`;
      message('database-delete-error', '');
      $('database-delete').showModal();
    });
    actions.append(test, remove); card.append(heading, list, actions);
    const result = feedback.get(connection.id);
    if (result) {
      const text = node('div', `service-feedback${result.error ? ' error' : ''}`, result.message);
      text.setAttribute('role', result.error ? 'alert' : 'status'); card.append(text);
    }
    fragment.append(card);
  }
  if (!connections.length) {
    const empty = node('div', 'empty', '还没有数据库连接');
    empty.append(node('small', '', '点击“新增连接”添加 MySQL 连接配置，保存后即可测试连通性。'));
    fragment.append(empty);
  }
  $('databases').replaceChildren(fragment);
}
export async function refreshDatabases() {
  if (loading) return;
  loading = true;
  const version = revision;
  try {
    const items = await request();
    if (version !== revision) return;
    connections = items; loaded = true; render();
    if ($('database-feedback').dataset.loadError === 'true') message('database-feedback', '');
    $('database-feedback').dataset.loadError = 'false';
  } catch (error) {
    message('database-feedback', `读取连接失败：${errorText(error)}`, true);
    $('database-feedback').dataset.loadError = 'true';
    if (!loaded) { $('databases').replaceChildren(node('div', 'empty', '暂时无法读取连接，请点击上方“刷新”重试。')); $('database-total').textContent = '—'; }
  } finally { loading = false; }
}
async function testConnection(connection) {
  if (pending.has(connection.id)) return;
  pending.add(connection.id); feedback.delete(connection.id); render();
  try {
    await request(`/${encodeURIComponent(connection.id)}/test`, { method: 'POST' });
    feedback.set(connection.id, { message: `连接成功 · ${new Date().toLocaleTimeString('zh-CN')}`, error: false });
  } catch (error) {
    feedback.set(connection.id, { message: `连接失败：${errorText(error)}`, error: true });
  } finally { pending.delete(connection.id); render(); }
}
function setSaving(value) {
  saving = value;
  for (const id of ['database-name', 'database-host', 'database-port', 'database-schema', 'database-username', 'database-password', 'database-save', 'database-editor-close', 'database-editor-cancel']) $(id).disabled = value;
  $('database-save').textContent = value ? '保存中…' : '保存连接';
}
$('database-add').addEventListener('click', () => {
  draftID = crypto.randomUUID();
  $('database-form').reset(); message('database-form-error', ''); $('database-editor').showModal();
});
for (const id of ['database-editor-close', 'database-editor-cancel']) $(id).addEventListener('click', () => $('database-editor').close());
$('database-editor').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
$('database-editor').addEventListener('close', () => $('database-form').reset());
$('database-form').addEventListener('submit', async event => {
  event.preventDefault(); if (saving) return;
  const connection = {
    id: draftID, name: $('database-name').value.trim(), host: $('database-host').value.trim(),
    port: Number($('database-port').value), database: $('database-schema').value.trim(),
    username: $('database-username').value.trim(), password: $('database-password').value,
  };
  if (!connection.name || !connection.host || !connection.database || !connection.username || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535) { message('database-form-error', '请填写连接名称、主机、库名和用户名，端口范围为 1–65535。', true); return; }
  message('database-form-error', ''); setSaving(true);
  try {
    const saved = await request('', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(connection) });
    revision++; connections = [...connections.filter(item => item.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
    loaded = true; render(); $('database-editor').close();
    $('database-feedback').dataset.loadError = 'false'; message('database-feedback', `已保存“${saved.name}”，可点击“测试连接”检查连通性。`);
  } catch (error) { message('database-form-error', `保存失败：${errorText(error)}`, true); }
  finally { setSaving(false); }
});
$('database-delete-cancel').addEventListener('click', () => $('database-delete').close());
$('database-delete').addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
$('database-delete-confirm').addEventListener('click', async () => {
  if (!deleteTarget || deleting) return;
  const connection = deleteTarget;
  deleting = true; $('database-delete-confirm').disabled = true; $('database-delete-cancel').disabled = true;
  $('database-delete-confirm').textContent = '删除中…'; message('database-delete-error', '');
  try {
    await request(`/${encodeURIComponent(connection.id)}`, { method: 'DELETE' });
    revision++; connections = connections.filter(item => item.id !== connection.id); feedback.delete(connection.id); render();
    $('database-delete').close(); $('database-add').focus();
    $('database-feedback').dataset.loadError = 'false'; message('database-feedback', `已删除“${connection.name}”的连接配置。`);
  } catch (error) { message('database-delete-error', `删除失败：${errorText(error)}`, true); }
  finally { deleting = false; $('database-delete-confirm').disabled = false; $('database-delete-cancel').disabled = false; $('database-delete-confirm').textContent = '删除连接'; }
});
export function closeDatabaseDialogs() {
  if (!saving && $('database-editor').open) $('database-editor').close();
  if (!deleting && $('database-delete').open) $('database-delete').close();
}
