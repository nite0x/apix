import { setupWorkspaceTabs } from './workspace-tabs.js';

const $ = id => document.getElementById(id);
const pending = new Set();
const feedback = new Map();
const expandedConnections = new Set();
let connections = [];
let loaded = false;
let loading = false;
let revision = 0;
let saving = false;
let deleting = false;
let deleteTarget = null;
let draftID = null;
let executions = [];
let historyLoading = false;
let historyKey = null;
let resultRevision = 0;
let editing = false;
let editorType = 'mysql';
let sqlRunning = false;
const driverLabels = { mysql: 'MySQL', postgresql: 'PostgreSQL', hologres: 'Hologres' };
const driverPorts = { mysql: 3306, postgresql: 5432, hologres: 80 };
const selectDatabaseTab = setupWorkspaceTabs('database-tabs');

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
	if (/context deadline exceeded|i\/o timeout|connect.*timed out/i.test(error.message)) return '连接超时，请检查主机、端口和网络连通性；VPC 地址需要本机可访问对应的专有网络。';
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
    const row = node('div', 'database-row');
    const icon = node('span', 'database-connection-icon', '▤'); icon.setAttribute('aria-hidden', 'true');
    const overview = node('div', 'database-overview');
    const heading = node('div', 'database-row-heading');
    const name = node('h3', 'database-name', connection.name); name.title = connection.name;
    heading.append(name, node('span', 'badge database-driver', driverLabels[connection.type || 'mysql'] || connection.type));
    const summary = node('div', 'database-summary');
    const schema = node('span', 'database-schema-name', connection.database || '待配置'); schema.title = connection.database || '';
    const address = connection.host ? `${connection.host.includes(':') ? `[${connection.host}]` : connection.host}:${connection.port}` : '旧配置待重新添加';
    const endpoint = node('span', 'database-address', address); endpoint.title = address;
    summary.append(schema, node('span', 'database-summary-divider', '·'), endpoint);
    overview.append(heading, summary);
    const list = node('dl', 'database-pairs');
    const detailPanel = node('div', 'database-connection-details');
    detailPanel.id = `database-details-${connection.id}`;
    detailPanel.hidden = !expandedConnections.has(connection.id);
    list.append(node('dt', '', '连接 ID'), node('dd', '', connection.id));
    if (connection.host) {
      list.append(node('dt', '', '主机'), node('dd', '', `${connection.host.includes(':') ? `[${connection.host}]` : connection.host}:${connection.port}`), node('dt', '', '库名'), node('dd', '', connection.database), node('dt', '', '用户名'), node('dd', '', connection.username));
      if (connection.ssl_mode) list.append(node('dt', '', 'SSL'), node('dd', '', connection.ssl_mode));
    } else { list.append(node('dt', '', '连接信息'), node('dd', '', '旧配置待重新添加')); }
    const actions = node('div', 'database-actions');
    const details = node('button', 'button small database-detail-toggle', detailPanel.hidden ? '详情' : '收起');
    details.type = 'button'; details.setAttribute('aria-label', `查看 ${connection.name} 的连接详情`);
    details.setAttribute('aria-controls', detailPanel.id); details.setAttribute('aria-expanded', String(!detailPanel.hidden));
    details.addEventListener('click', () => {
      detailPanel.hidden = !detailPanel.hidden;
      if (detailPanel.hidden) expandedConnections.delete(connection.id); else expandedConnections.add(connection.id);
      details.textContent = detailPanel.hidden ? '详情' : '收起';
      details.setAttribute('aria-expanded', String(!detailPanel.hidden));
    });
    const test = node('button', 'button small', pending.has(connection.id) ? '测试中…' : '测试连接');
    test.type = 'button'; test.disabled = pending.has(connection.id);
    test.setAttribute('aria-busy', String(pending.has(connection.id)));
    test.setAttribute('aria-label', `测试 ${connection.name} 的连接`);
    test.addEventListener('click', () => testConnection(connection));
    const edit = node('button', 'button small', '编辑');
    edit.type = 'button'; edit.disabled = pending.has(connection.id);
    edit.setAttribute('aria-label', `编辑 ${connection.name} 的连接配置`);
    edit.setAttribute('aria-haspopup', 'dialog'); edit.setAttribute('aria-controls', 'database-editor');
    edit.addEventListener('click', () => openEditor(connection));
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
    const settings = node('div', 'database-settings-actions'); settings.append(edit, remove);
    detailPanel.append(list, settings);
    const execute = node('button', 'button small database-execute', '执行 SQL'); execute.type = 'button';
    execute.disabled = sqlRunning; execute.setAttribute('aria-label', `使用 ${connection.name} 执行 SQL`);
    execute.addEventListener('click', () => {
      if (sqlRunning) return;
      $('sql-run-connection').value = connection.id; updateSQLHint();
      selectDatabaseTab($('sql-tab')); $('sql-statement-input').focus();
    });
    actions.append(execute, test, details); row.append(icon, overview, actions); card.append(row, detailPanel);
    const result = feedback.get(connection.id);
    if (result) {
      const text = node('div', `service-feedback${result.error ? ' error' : ''}`, result.message);
      text.setAttribute('role', result.error ? 'alert' : 'status'); card.append(text);
    }
    fragment.append(card);
  }
  if (!connections.length) {
    const empty = node('div', 'empty', '还没有数据库连接');
    empty.append(node('small', '', '点击“新增连接”添加 MySQL、PostgreSQL 或 Hologres，保存后即可测试连通性。'));
    fragment.append(empty);
  }
  $('databases').replaceChildren(fragment);
  renderHistoryConnections();
  renderSQLConnections();
}
function renderHistoryConnections() {
  const select = $('sql-connection');
  const selected = select.value;
  const names = new Map(executions.map(item => [item.connection_id, item.connection_name]));
  for (const item of connections) names.set(item.id, item.name);
  if (selected && !names.has(selected)) names.set(selected, selected);
  const all = node('option', '', '全部连接'); all.value = '';
  const options = [all];
  for (const [id, name] of names) { const option = node('option', '', name); option.value = id; options.push(option); }
  select.replaceChildren(...options); select.value = selected;
}

function renderHistory() {
  const query = $('sql-search').value.trim().toLowerCase();
  const connectionID = $('sql-connection').value;
  const items = executions.filter(item => (!connectionID || item.connection_id === connectionID) && `${item.sql} ${item.connection_name} ${item.error || ''}`.toLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  $('sql-total').textContent = `${items.length} 条`;
  for (const item of items) {
    const row = node('tr');
    const statement = node('td');
    const preview = node('button', 'sql-statement'); preview.type = 'button';
    preview.append(node('span', `sql-mode${item.mode === 'query' ? '' : ' sql-mode-exec'}`, item.mode === 'query' ? '查询' : '执行'), node('code', 'sql-preview', item.sql));
    preview.title = item.sql;
    preview.setAttribute('aria-label', `查看 SQL 执行详情：${item.sql}`);
    preview.setAttribute('aria-haspopup', 'dialog'); preview.setAttribute('aria-controls', 'sql-result');
    preview.addEventListener('click', () => openSQLResult(item));
    statement.append(preview);
    const connection = node('td', 'sql-connection-name', item.connection_name); connection.title = `${item.connection_name} · ${item.connection_id}`;
    const status = node('td');
    status.append(node('span', `sql-status ${item.status === 'succeeded' ? 'response-ok' : item.status === 'running' ? 'response-pending' : 'response-error'}`, { succeeded: '成功', running: '执行中', failed: '失败' }[item.status] || item.status));
    if (item.status === 'succeeded') status.append(node('small', 'sql-row-count', item.mode === 'query' ? (item.truncated ? '结果已截断' : `返回 ${item.row_count} 行`) : `影响 ${item.rows_affected} 行`));
    const action = node('td', 'sql-action');
    const view = node('button', 'text-button sql-result-button', item.status === 'succeeded' && item.mode === 'query' ? '查看结果' : '查看详情');
    view.type = 'button'; view.setAttribute('aria-haspopup', 'dialog'); view.setAttribute('aria-controls', 'sql-result');
    view.addEventListener('click', () => openSQLResult(item));
    action.append(view);
    const reuse = node('button', 'text-button sql-fill-button', '填入编辑器'); reuse.type = 'button';
    reuse.disabled = sqlRunning || item.status === 'running';
    reuse.addEventListener('click', () => fillSQL(item)); action.append(reuse);
    const time = node('td', 'sql-time', new Date(item.started_at).toLocaleString('zh-CN', { hour12: false }));
    row.append(statement, connection, status, node('td', 'sql-duration', item.status === 'running' ? '—' : `${item.duration_ms} ms`), time, action);
    fragment.append(row);
  }
  if (!items.length) {
    const row = node('tr'); const cell = node('td', 'empty', query || connectionID ? '没有匹配的 SQL 执行记录' : '还没有 SQL 执行记录'); cell.colSpan = 6;
    if (!query && !connectionID) cell.append(node('small', '', '从现在开始，通过 MCP、接口或测试流程执行的 SQL 会自动显示在这里。'));
    row.append(cell); fragment.append(row);
  }
  $('sql-executions').replaceChildren(fragment);
}

function renderSQLResult(result, content = $('sql-result-content')) {
  if (!result) {
    content.replaceChildren(node('p', 'detail-empty', '此记录未保存查询结果，请重新执行 SQL 后查看。'));
    return;
  }
  const summary = node('p', result.truncated ? 'detail-alert' : 'detail-note', result.truncated
    ? `显示前 ${result.rows.length} 行，结果已截断，总行数未知。`
    : `返回 ${result.row_count} 行 · ${result.duration_ms} ms`);
  const scroll = node('div', 'sql-result-scroll');
  scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '查询结果表格');
  const table = node('table', 'sql-result-table');
  const head = node('thead'); const headings = node('tr');
  for (const column of result.columns) { const th = node('th', '', column); th.scope = 'col'; headings.append(th); }
  head.append(headings);
  const body = node('tbody');
  for (const [rowIndex, row] of result.rows.entries()) {
    const tr = node('tr');
    for (const column of result.columns) {
      const value = row[column];
      const text = value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
      const cell = node('td', value === null ? 'sql-null' : '');
      if (value === null || text === '') cell.textContent = text;
      else {
        const preview = node('button', 'sql-cell-preview', text);
        preview.type = 'button'; preview.title = '点击查看完整内容';
        preview.setAttribute('aria-label', `查看第 ${rowIndex + 1} 行 ${column} 字段的完整内容`);
        preview.setAttribute('aria-haspopup', 'dialog'); preview.setAttribute('aria-controls', 'sql-cell-detail');
        preview.addEventListener('click', () => {
          $('sql-cell-context').textContent = `第 ${rowIndex + 1} 行 · ${column}`;
          $('sql-cell-value').textContent = text;
          $('sql-cell-detail').showModal();
        });
        cell.append(preview);
      }
      tr.append(cell);
    }
    body.append(tr);
  }
  if (!result.rows.length) {
    const row = node('tr'); const cell = node('td', 'empty', '查询成功，没有返回数据'); cell.colSpan = Math.max(1, result.columns.length);
    row.append(cell); body.append(row);
  }
  table.append(head, body); scroll.append(table); content.replaceChildren(summary, scroll);
}

async function openSQLResult(item) {
  const version = ++resultRevision;
  $('sql-result-context').textContent = `${item.connection_name} · ${new Date(item.started_at).toLocaleString('zh-CN', { hour12: false })}`;
  $('sql-result-statement').textContent = item.sql;
  $('sql-result-params').textContent = JSON.stringify(item.params || [], null, 2);
  $('sql-result-parameters').hidden = !item.params?.length;
  $('sql-result-content').replaceChildren(node('p', 'detail-empty', '正在读取查询结果…'));
  if (!$('sql-result').open) $('sql-result').showModal();
  if (item.status !== 'succeeded' || item.mode !== 'query') {
    const failed = item.status === 'failed' || Boolean(item.error);
    const info = node('div', failed ? 'detail-alert error' : 'detail-note', item.error || (failed ? '执行失败，未返回详细错误。' : item.status === 'running' ? 'SQL 正在执行中，请稍后关闭详情并重新查看。' : `执行成功 · 影响 ${item.rows_affected} 行 · ${item.duration_ms} ms`));
    if (failed) info.setAttribute('role', 'alert');
    $('sql-result-content').replaceChildren(info);
    return;
  }
  try {
    const response = await fetch(`/api/database/executions/${encodeURIComponent(item.id)}/result`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (version === resultRevision) renderSQLResult(data.result);
  } catch (error) {
    if (version !== resultRevision) return;
    const alert = node('div', 'detail-alert error', `读取查询结果失败：${errorText(error)}`); alert.setAttribute('role', 'alert');
    const retry = node('button', 'button small', '重试'); retry.type = 'button'; retry.addEventListener('click', () => openSQLResult(item));
    $('sql-result-content').replaceChildren(alert, retry);
  }
}
$('sql-cell-close').addEventListener('click', () => $('sql-cell-detail').close());
$('sql-cell-detail').addEventListener('close', () => { $('sql-cell-value').textContent = ''; $('sql-cell-context').textContent = ''; });
$('sql-result-close').addEventListener('click', () => $('sql-result').close());
$('sql-result').addEventListener('close', () => { if ($('sql-cell-detail').open) $('sql-cell-detail').close(); resultRevision++; $('sql-result-content').replaceChildren(); });

export async function refreshSQLHistory() {
  if (historyLoading) return;
  historyLoading = true;
  try {
    const response = await fetch('/api/database/executions', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    const items = await response.json();
    if (!response.ok) throw new Error(items.error || `HTTP ${response.status}`);
    const key = JSON.stringify(items);
    if (key !== historyKey) { executions = items; historyKey = key; renderHistoryConnections(); renderHistory(); }
    message('sql-feedback', '');
  } catch (error) { message('sql-feedback', `读取 SQL 记录失败：${errorText(error)}`, true); }
  finally { historyLoading = false; }
}
$('sql-search').addEventListener('input', renderHistory);
$('sql-connection').addEventListener('change', renderHistory);
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
    if (!sqlRunning) message('sql-run-feedback', `读取连接失败：${errorText(error)}。请点击页面上方“刷新”重试。`, true);
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
  for (const id of ['database-name', 'database-type', 'database-ssl-mode', 'database-host', 'database-port', 'database-schema', 'database-username', 'database-password', 'database-save', 'database-editor-close', 'database-editor-cancel']) $(id).disabled = value;
  $('database-save').textContent = value ? '保存中…' : '保存连接';
}
function updateDriverFields(changePort = false) {
  const type = $('database-type').value;
  if (changePort && (!$('database-port').value || Number($('database-port').value) === driverPorts[editorType])) $('database-port').value = driverPorts[type];
  editorType = type;
  $('database-ssl-field').hidden = type === 'mysql';
  $('database-driver-hint').textContent = type === 'mysql' ? '默认端口 3306，SQL 使用 ? 绑定参数。' : type === 'hologres' ? '使用 PostgreSQL 协议，默认端口 80。SQL 使用 $1、$2 绑定参数；VPC 地址需要本机网络可达。' : '默认端口 5432，SQL 使用 $1、$2 绑定参数。';
}
function openEditor(connection = null) {
  editing = !!connection;
  draftID = connection?.id || crypto.randomUUID();
  $('database-form').reset();
  $('database-editor-title').textContent = editing ? '编辑数据库连接' : '新增数据库连接';
  if (connection) {
    for (const [id, key] of [['database-name', 'name'], ['database-host', 'host'], ['database-port', 'port'], ['database-schema', 'database'], ['database-username', 'username']]) $(id).value = connection[key] || '';
  }
  $('database-type').value = connection?.type || 'mysql';
  $('database-ssl-mode').value = connection?.ssl_mode || 'prefer';
  $('database-password').placeholder = editing ? '留空保留原密码' : '数据库密码（允许为空）';
  $('database-password-hint').textContent = editing ? '密码在本机加密保存。留空保留原密码，填写新密码则更新。' : '密码在本机加密保存。保存后即可测试连接，无需重启。';
  updateDriverFields();
  message('database-form-error', ''); $('database-editor').showModal();
}
$('database-add').addEventListener('click', () => openEditor());
$('database-type').addEventListener('change', () => updateDriverFields(true));
for (const id of ['database-editor-close', 'database-editor-cancel']) $(id).addEventListener('click', () => $('database-editor').close());
$('database-editor').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
$('database-editor').addEventListener('close', () => $('database-form').reset());
$('database-form').addEventListener('submit', async event => {
  event.preventDefault(); if (saving) return;
  const connection = {
    id: draftID, name: $('database-name').value.trim(), host: $('database-host').value.trim(),
    type: $('database-type').value,
    port: Number($('database-port').value), database: $('database-schema').value.trim(),
    username: $('database-username').value.trim(),
  };
  if (!editing || $('database-password').value !== '') connection.password = $('database-password').value;
  if (connection.type !== 'mysql') connection.ssl_mode = $('database-ssl-mode').value;
  if (!connection.name || !connection.host || !connection.database || !connection.username || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535) { message('database-form-error', '请填写连接名称、主机、库名和用户名，端口范围为 1–65535。', true); return; }
  message('database-form-error', ''); setSaving(true);
  try {
    const saved = await request('', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(connection) });
    revision++; feedback.delete(saved.id); connections = [...connections.filter(item => item.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
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
  if ($('sql-result').open) $('sql-result').close();
  if (!saving && $('database-editor').open) $('database-editor').close();
  if (!deleting && $('database-delete').open) $('database-delete').close();
}

function renderSQLConnections() {
  const select = $('sql-run-connection');
  const selected = select.value;
  const placeholder = node('option', '', connections.length ? '请选择数据库连接' : '暂无连接，请先在“连接管理”新增'); placeholder.value = '';
  select.replaceChildren(placeholder, ...connections.map(connection => {
    const option = node('option', '', `${connection.name} · ${driverLabels[connection.type || 'mysql'] || connection.type}`);
    option.value = connection.id; return option;
  }));
  select.value = connections.some(connection => connection.id === selected) ? selected : '';
  updateSQLHint();
}

function updateSQLHint() {
  const connection = connections.find(item => item.id === $('sql-run-connection').value);
  $('sql-driver-hint').textContent = connection
    ? `${connection.name} · ${connection.database || '未配置库名'} · ${connection.type === 'mysql' || !connection.type ? '使用 ? 绑定参数。' : '使用 $1、$2 绑定参数。'}`
    : '请先选择连接；没有连接时可前往“连接管理”新增。';
  $('sql-mode-hint').textContent = $('sql-mode').value === 'exec' ? '写入与结构变更会直接提交，执行后显示影响行数。' : '查询结果以表格展示，执行记录自动保存。';
  $('sql-max-rows').disabled = $('sql-mode').value === 'exec';
  $('sql-execute').disabled = !connection || sqlRunning;
  document.querySelectorAll('.database-execute').forEach(button => { button.disabled = sqlRunning; });
}

function resetSQLResult() {
  $('sql-live-result-content').replaceChildren(node('p', 'detail-empty', '执行 SQL 后，查询数据、影响行数或错误信息会显示在这里。'));
}

function fillSQL(item) {
  if (sqlRunning) return;
  selectDatabaseTab($('sql-tab'));
  $('sql-run-connection').value = item.connection_id;
  $('sql-mode').value = item.mode;
  $('sql-statement-input').value = item.sql;
  $('sql-params-input').value = item.params?.length ? JSON.stringify(item.params, null, 2) : '';
  $('sql-params-input').closest('details').open = Boolean(item.params?.length);
  updateSQLHint(); resetSQLResult();
  message('sql-run-feedback', $('sql-run-connection').value ? '已填入历史 SQL，可修改后执行。' : '已填入历史 SQL，原连接已不存在，请重新选择连接。');
  $('sql-statement-input').focus(); $('sql-form').scrollIntoView?.({ block: 'start', behavior: 'smooth' });
}

$('sql-run-connection').addEventListener('change', updateSQLHint);
$('sql-mode').addEventListener('change', updateSQLHint);
$('sql-reset').addEventListener('click', () => {
  if (sqlRunning) return;
  const connectionID = $('sql-run-connection').value;
  $('sql-form').reset(); $('sql-run-connection').value = connectionID;
  updateSQLHint(); message('sql-run-feedback', ''); resetSQLResult(); $('sql-statement-input').focus();
});
$('sql-form').addEventListener('submit', async event => {
  event.preventDefault(); if (sqlRunning) return;
  const connectionID = $('sql-run-connection').value;
  const sql = $('sql-statement-input').value.trim();
  let params;
  try { params = JSON.parse($('sql-params-input').value.trim() || '[]'); if (!Array.isArray(params)) throw new Error(); }
  catch { message('sql-run-feedback', '绑定参数必须是有效的 JSON 数组，例如 ["example", 123]。', true); return; }
  const timeout = Number($('sql-timeout').value); const maxRows = Number($('sql-max-rows').value);
  if (!connections.some(item => item.id === connectionID) || !sql) { message('sql-run-feedback', '请选择有效连接并填写 SQL 语句。', true); return; }
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300 || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10000) { message('sql-run-feedback', '超时需为 1–300 秒，最多返回行数需为 1–10000 的整数。', true); return; }
  const mode = $('sql-mode').value;
  sqlRunning = true; updateSQLHint(); $('sql-fields').disabled = true; $('sql-reset').disabled = true; $('sql-execute').disabled = true;
  $('sql-execute').textContent = '执行中…'; $('sql-form').setAttribute('aria-busy', 'true');
  const content = $('sql-live-result-content');
  content.setAttribute('aria-busy', 'true');
  content.replaceChildren(node('p', 'detail-note', 'SQL 正在执行，请等待结果…'));
  renderHistory(); message('sql-run-feedback', 'SQL 正在执行，请等待结果…');
  try {
    const response = await fetch('/api/database/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connection_id: connectionID, sql, params, mode, timeout_ms: timeout * 1000, max_rows: maxRows }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (mode === 'query') renderSQLResult(result, content);
    else content.replaceChildren(node('p', 'detail-note', `执行成功 · 影响 ${result.rows_affected} 行 · ${result.duration_ms} ms`));
    message('sql-run-feedback', 'SQL 执行完成，可在下方查看本次结果，或从执行记录回看。');
  } catch (error) {
    const alert = node('p', 'detail-alert error', `SQL 执行失败：${errorText(error)}`);
    alert.setAttribute('role', 'alert'); content.replaceChildren(alert);
    message('sql-run-feedback', 'SQL 执行失败，请查看下方的错误信息。', true);
  }
  finally {
    sqlRunning = false; $('sql-fields').disabled = false; $('sql-reset').disabled = false;
    $('sql-execute').textContent = '执行 SQL →'; $('sql-form').setAttribute('aria-busy', 'false'); updateSQLHint();
    content.setAttribute('aria-busy', 'false');
    if (!document.querySelector('[data-page="databases"]').hidden && !$('sql-panel').hidden) $('sql-live-result').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    await refreshSQLHistory(); renderHistory();
  }
});
updateSQLHint();
