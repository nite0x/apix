import { setupWorkspaceTabs } from './workspace-tabs.js';

const labels = { running: '执行中', passed: '通过', failed: '断言失败', error: '执行错误', unverified: '未验证' };
function el(tag, cls = '', text) { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = String(text); return n; }
function button(text, action) { const n = el('button', 'button small', text); n.type = 'button'; n.addEventListener('click', action); return n; }
function code(value) { return el('pre', 'detail-code', typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '暂无结果'); }
function batchLink(id) { const link = el('a', 'button small', '查看批次'); link.href = '/execution-records?batch=' + encodeURIComponent(id); link.dataset.route = ''; return link; }
async function api(path) {
 const response = await fetch('/api' + path, { cache: 'no-store' });
 const value = await response.json();
 if (!response.ok) throw new Error(value.error || 'HTTP ' + response.status);
 return value;
}

// Both workspaces keep their execution form mounted while browsing history.
export function attachExecutionHistory(root, kind, executeLabel) {
 const prefix = kind === 'command' ? 'command' : 'mcp';
 const title = kind === 'command' ? '命令行' : 'MCP';
 const tabs = el('div', 'workspace-tabs'); tabs.id = prefix + '-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', title + '工作区');
 const execute = el('section'); execute.id = prefix + '-execute-panel'; execute.setAttribute('role', 'tabpanel'); execute.setAttribute('aria-labelledby', prefix + '-execute-tab');
 execute.append(...root.childNodes);
 const historyPanel = el('section', 'panel execution-history'); historyPanel.id = prefix + '-history-panel'; historyPanel.setAttribute('role', 'tabpanel'); historyPanel.setAttribute('aria-labelledby', prefix + '-history-tab'); historyPanel.hidden = true;
 for (const [key, text] of [['execute', executeLabel], ['history', '执行记录']]) {
  const tab = button(text, () => {}); tab.className = ''; tab.id = prefix + '-' + key + '-tab'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(key === 'execute')); tab.setAttribute('aria-controls', prefix + '-' + key + '-panel'); tabs.append(tab);
 }
 const heading = el('div', 'panel-heading'); const count = el('span', 'subtle', '最近 200 条');
 const refreshButton = button('刷新记录', () => void load());
 heading.append(el('h2', '', title + '执行记录'), count, refreshButton);
 const filters = el('div', 'request-library-tools');
 const searchLabel = el('label', 'library-search'); searchLabel.append(el('span', '', '搜索记录'));
 const search = el('input'); search.type = 'search'; search.placeholder = '名称、程序 / 工具或批次'; search.setAttribute('aria-label', '搜索' + title + '执行记录'); searchLabel.append(search);
 const statusLabel = el('label'); statusLabel.append(el('span', '', '执行状态')); const status = el('select'); status.setAttribute('aria-label', title + '执行状态'); status.add(new Option('全部状态', ''));
 for (const [value, text] of Object.entries(labels)) status.add(new Option(text, value)); statusLabel.append(status); filters.append(searchLabel, statusLabel);
 const feedback = el('div', 'detail-alert error'); feedback.setAttribute('role', 'alert'); feedback.hidden = true;
 const scroll = el('div', 'request-scroll'); const table = el('table'); const head = el('thead'); const header = el('tr');
 for (const text of ['执行', '状态', '耗时', '执行时间', '批次', '操作']) header.append(el('th', '', text));
 head.append(header); const rows = el('tbody'); table.append(head, rows); scroll.append(table); historyPanel.append(heading, filters, feedback, scroll); root.replaceChildren(tabs, execute, historyPanel);
 let items = [], loaded = false, pending = null, activeDialog = null;
 function render() {
  rows.replaceChildren();
  const query = search.value.trim().toLowerCase();
  const matches = items.filter(item => (!status.value || item.status === status.value) && [item.name, item.target, item.batch_name].some(value => String(value || '').toLowerCase().includes(query)));
  count.textContent = '最近 200 条 · ' + items.length + ' 条记录';
  for (const item of matches) {
   const row = el('tr'); const name = el('td'); name.append(el('strong', '', item.name), el('small', 'execution-history-target', item.target));
   const result = el('td'); result.append(el('span', 'test-pill ' + item.status, labels[item.status] || item.status));
   const batch = el('td', '', item.batch_name); const actions = el('td'); actions.append(button('查看详情', () => void openDetail(item)), batchLink(item.batch_id));
   row.append(name, result, el('td', '', item.status === 'running' ? '—' : item.duration_ms + ' ms'), el('td', '', new Date(item.started_at).toLocaleString('zh-CN')), batch, actions); rows.append(row);
  }
  if (!matches.length) { const row = el('tr'); const cell = el('td', 'empty', loaded ? items.length ? '没有符合筛选条件的记录' : '暂无执行记录，执行后会自动保存在这里。' : '正在读取执行记录…'); cell.colSpan = 6; row.append(cell); rows.append(row); }
 }
 async function load() {
  if (pending) return pending;
  refreshButton.disabled = true; historyPanel.setAttribute('aria-busy', 'true'); feedback.hidden = true; render();
  pending = (async () => {
   try { items = await api('/test-runs?type=' + kind); loaded = true; render(); }
   catch (error) { feedback.textContent = '读取执行记录失败：' + error.message; feedback.hidden = false; if (!loaded) { rows.replaceChildren(); } }
   finally { pending = null; refreshButton.disabled = false; historyPanel.setAttribute('aria-busy', 'false'); }
  })();
  return pending;
 }
 async function openDetail(item) {
  activeDialog?.close(); activeDialog?.remove();
  const d = el('dialog', 'execution-history-dialog testing-editor'); activeDialog = d; d.setAttribute('aria-label', title + '执行详情');
  const top = el('div', 'detail-heading'); top.append(el('h2', '', item.name), button('关闭 ×', () => d.close())); const content = el('div', 'execution-history-detail'); content.append(el('p', '', '正在读取执行详情…')); d.append(top, content); document.body.append(d); d.showModal();
  async function read() {
   content.replaceChildren(el('p', '', '正在读取执行详情…'));
   try {
    const run = await api('/test-runs/' + encodeURIComponent(item.id));
    if (!d.open || activeDialog !== d) return;
    content.replaceChildren(el('span', 'test-pill ' + run.status, labels[run.status] || run.status), batchLink(run.batch_id), el('h3', '', '执行输入'), code(kind === 'command' ? run.command_request_snapshot : run.mcp_request_snapshot));
    if (run.error_message) content.append(el('p', 'response-error', run.error_message));
    if (kind === 'command') {
     const result = run.command_result || {};
     content.append(el('h3', '', '命令执行结果 · 退出码 ' + (result.exit_code ?? '—')));
     for (const stream of ['stdout', 'stderr']) { content.append(el('h4', '', stream), code(result[stream] || '（空）')); if (result[stream + '_truncated']) content.append(el('p', 'response-error', '输出已截断')); }
    } else content.append(el('h3', '', 'MCP 返回结果'), code(run.mcp_result));
    content.append(el('h3', '', '断言结果'), run.assertions?.length ? code(run.assertions) : el('p', '', '本次执行没有断言结果。'));
   } catch (error) { if (d.open && activeDialog === d) content.replaceChildren(el('p', 'response-error', error.message), button('重试读取', () => void read())); }
  }
  await read();
 }
 search.addEventListener('input', render); status.addEventListener('change', render);
 const initialTab = new URLSearchParams(location.search).get('tab') === 'history' ? 'history' : 'execute';
 tabs.querySelectorAll('[role="tab"]').forEach(tab => tab.setAttribute('aria-selected', String(tab.id === prefix + '-' + initialTab + '-tab')));
 const select = setupWorkspaceTabs(tabs.id, tab => {
  const selected = tab.id === prefix + '-history-tab';
  if (location.pathname === (kind === 'command' ? '/commands' : '/mcp-tools')) {
   const query = new URLSearchParams(location.search); query.set('tab', selected ? 'history' : 'execute'); history.replaceState(null, '', location.pathname + '?' + query);
  }
  if (selected) void load();
 });
 return { refresh() { const tab = tabs.querySelector('#' + prefix + (new URLSearchParams(location.search).get('tab') === 'history' ? '-history-tab' : '-execute-tab')); select(tab); return pending; } };
}
