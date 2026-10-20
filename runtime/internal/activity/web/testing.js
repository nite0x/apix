import { activateFlows, deactivateFlows, refreshFlows, leaveFlows } from './flows.js';
import { openCommandCaseEditor } from './command-tools.js';
import { openMCPCaseEditor } from './mcp-tools.js';
import { openRequestDetail } from './request-detail.js';

const root = document.getElementById('testing-workspace');
const flowRoot = document.getElementById('flow-workspace');
const state = { type: 'all', viewRevision: 0, batches: [], batch: null, tab: 'cases', active: false, loading: false, working: false, filter: 'all', batchQuery: '', batchType: 'all', query: '', order: 'sequence', timer: null, error: '', message: '', signature: '', selection: 0, paused: null };
let mounted = false;
let editor = null;
let editorDirty = false;
let targetStep = '';
let toolbar = null;
let runDrawer = null;
let drawerKey = '';
let drawerTab = 'assertions';
const resultTypes = [['all', '全部', 'total'], ['failed', '断言失败', 'failed'], ['error', '执行错误', 'errors'], ['passed', '通过', 'passed'], ['unverified', '未验证', 'unverified'], ['running', '进行中', 'running']];

function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); return node; }
function button(text, action, cls = 'button') { const item = el('button', cls, text); item.type = 'button'; item.addEventListener('click', action); return item; }
function field(label, value = '', type = 'input') { const wrap = el('label'); const input = el(type); input.value = value; input.setAttribute('aria-label', label); input.addEventListener('input', () => { editorDirty = true; }); wrap.append(el('span', '', label), input); return { wrap, input }; }
function display(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
function clock(value) { return new Date(value).toLocaleString('zh-CN'); }
function pill(status) { return el('span', `test-pill ${status}`, ({ passed: '通过', failed: '断言失败', error: '执行错误', unverified: '未验证', running: '进行中', completed: '已结束', interrupted: '已中断' })[status] || status); }
function summary(counts) { return `通过 ${counts.passed} · 断言失败 ${counts.failed} · 执行错误 ${counts.errors}`; }
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { cache: 'no-store', ...options, ...(options.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}) });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function notice(error = '', message = '') { state.error = error; state.message = message; const node = root.querySelector('[data-testing-message]'); if (node) { node.textContent = error || message; node.hidden = !node.textContent; node.className = `detail-alert testing-message${error ? ' error' : ''}`; node.setAttribute('role', error ? 'alert' : 'status'); } }
function isFlowView() { return state.type === 'flow'; }
function readRoute() {
  const query = new URLSearchParams(location.search);
  const legacyCollection = location.pathname === '/test-collections';
  state.tab = location.pathname === '/execution-records' || legacyCollection || query.get('tab') === 'batches' || query.get('tab') === 'records' || query.has('batch') || query.has('run') ? 'records' : 'cases';
  state.type = !legacyCollection && !query.has('batch') && query.get('type') !== 'single' && (query.has('id') || query.has('run')) ? 'flow' : 'all';
}
function locationForBatch() {
  if (!state.active || isFlowView() || !['/flows', '/execution-records', '/tests', '/test-collections'].includes(location.pathname)) return;
  const query = new URLSearchParams();
  if (state.batch) query.set('batch', state.batch.id);
  if (targetStep && state.batch?.runs?.some(run => run.id === targetStep)) query.set('step', targetStep);
  history.replaceState(null, '', `/execution-records${query.size ? '?' + query : ''}`);
  window.dispatchEvent(new window.Event('testing-page-location'));
}
function mount() {
  if (mounted) return; mounted = true; root.replaceChildren();
  toolbar = el('div', 'testing-toolbar');
  const actions = el('div', 'testing-actions'); actions.dataset.testingActions = '';
  const batch = button('＋ 新建集合测试', openBatchEditor); batch.dataset.batchAction = ''; actions.append(batch);
  toolbar.append(actions);
  const panel = el('div'); panel.id = 'testing-view-panel'; panel.setAttribute('role', 'region');
  const message = el('div', 'detail-alert testing-message'); message.dataset.testingMessage = ''; message.hidden = true;
  const typePanel = el('div'); typePanel.id = 'testing-type-panel'; typePanel.setAttribute('role', 'region');
  const content = el('div'); content.dataset.testingContent = '';
  typePanel.append(flowRoot, content); panel.append(message, typePanel); root.append(panel);
  (document.querySelector('.heading-actions') || root).append(toolbar);
}
async function showView() {
  render();
  if (isFlowView() || state.tab === 'cases') await activateFlows();
  else { deactivateFlows(); await refreshTesting(); }
}
function blank(title, text) { const node = el('div', 'testing-empty'); node.append(el('h2', '', title), el('p', '', text)); return node; }
function render() {
  mount();
  root.setAttribute('aria-label', state.tab === 'records' ? '执行记录工作区' : '流程工作区');
  root.querySelector('#testing-view-panel').setAttribute('aria-label', state.tab === 'records' ? '执行记录' : '流程');
  toolbar.hidden = state.tab !== 'records' || isFlowView();
  root.querySelector('#testing-type-panel').setAttribute('aria-label', state.tab === 'records' ? '执行记录' : '流程列表');
  toolbar.querySelector('[data-batch-action]').hidden = state.tab !== 'records' || isFlowView();
  root.querySelector('[data-testing-content]').hidden = isFlowView() || state.tab === 'cases';
  flowRoot.hidden = state.tab === 'records' && !isFlowView();
  toolbar.querySelectorAll('button').forEach(node => { node.disabled = state.working; });
  notice(state.error, state.message);
  if (isFlowView() || state.tab === 'cases') return;
  const signature = JSON.stringify([state.type, state.tab, state.batches, state.batch, state.working, state.paused]);
  if (signature === state.signature) return; state.signature = signature;
  const content = root.querySelector('[data-testing-content]');
  const focused = content.contains(document.activeElement) ? document.activeElement : null;
  const focusLabel = focused?.getAttribute('aria-label');
  const cursor = focused?.selectionStart;
  const listScroll = content.querySelector('.testing-batch-items')?.scrollTop || 0;
  const resultScroll = content.querySelector('.testing-results')?.scrollTop || 0;
  content.replaceChildren(renderBatches());
  content.querySelector('.testing-batch-items').scrollTop = listScroll;
  const results = content.querySelector('.testing-results'); if (results) results.scrollTop = resultScroll;
  if (focusLabel) {
    const next = [...content.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === focusLabel);
    next?.focus({ preventScroll: true });
    if (cursor != null && next?.type === 'search') next.setSelectionRange(cursor, cursor);
  }
  if (targetStep && runDrawer?.open) updateRunDrawer();
}
function searchInput(label, placeholder, value, change) {
  const input = el('input', 'testing-search'); input.type = 'search'; input.placeholder = placeholder;
  input.setAttribute('aria-label', label); input.value = value; input.addEventListener('input', () => change(input.value)); return input;
}
function runTarget(run) {
  if (run.type === 'sql') return `数据库 · ${run.execution_input?.connection_id || 'SQL'}`;
  if (run.type === 'service') return `服务 · ${run.execution_input?.service_id || ''} · ${run.execution_input?.action === 'stop' ? '停止' : '启动'}`;
  if (run.type === 'command') return `命令行 · ${run.command_request_snapshot?.program || ''}`;
  if (run.type === 'mcp') return `MCP · ${run.mcp_result?.server?.name || run.mcp_request_snapshot?.server_id || ''} / ${run.mcp_request_snapshot?.tool_name || ''}`;
  return `${run.request_snapshot?.method || 'HTTP'} ${run.request_snapshot?.url || ''}`;
}
function duration(run) {
  if (run.status === 'running') return '进行中';
  const result = run.command_result || run.execution_result || run.mcp_result;
  const ms = run.duration_ms ?? result?.duration_ms;
  if (ms != null) return `${ms} ms`;
  if (!run.finished_at || !run.started_at) return '—';
  const elapsed = new Date(run.finished_at) - new Date(run.started_at);
  return Number.isFinite(elapsed) && elapsed >= 0 ? `${elapsed} ms` : '—';
}
function runReason(run) {
  if (run.error_message) return run.error_message;
  const failed = (run.assertions || []).filter(item => !item.passed);
  if (failed.length) {
    const first = failed[0];
    const operator = ({ not_equals: '不等于 ', contains: '包含 ', exists: '存在 ' })[first.operator] || '';
    return `${first.kind}${first.path ? `.${first.path}` : ''} · 预期 ${operator}${display(first.expected) ?? '—'}，实际 ${display(first.actual) ?? '—'}${failed.length > 1 ? ` · 共 ${failed.length} 项断言失败` : ''}`;
  }
  return ({ passed: '所有预期验证通过', failed: '断言未通过，请查看预期值与实际值', error: '执行未完成，请查看错误详情', running: '正在执行，结果将自动更新', unverified: '未设置预期断言' })[run.status] || run.status;
}
function renderBatchItems(container) {
  container.replaceChildren();
  const query = state.batchQuery.trim().toLowerCase();
  const batches = state.batches.filter(batch => (state.batchType === 'all' || (batch.source === 'flow' ? 'flow' : 'collection') === state.batchType)
    && `${batch.name} ${batch.id}`.toLowerCase().includes(query));
  for (const batch of batches) {
    const item = button('', () => selectBatch(batch.id), 'testing-batch'); item.setAttribute('aria-pressed', String(state.batch?.id === batch.id));
    const meta = el('div', 'testing-batch-top'); meta.append(el('span', 'testing-kind', batch.source === 'flow' ? '多步流程' : '集合测试'), pill(batch.status));
    item.append(meta, el('strong', '', batch.name), el('small', '', `${clock(batch.created_at)} · ${batch.counts.total} 次执行`), el('small', 'testing-batch-counts', summary(batch.counts)));
    const pending = (batch.counts.unverified || 0) + (batch.counts.running || 0);
    if (pending) item.append(el('small', '', `未验证 ${batch.counts.unverified || 0} · 进行中 ${batch.counts.running || 0}`));
    container.append(item);
  }
  if (!batches.length) container.append(blank(state.batches.length ? '没有匹配的记录' : '还没有执行记录', state.batches.length ? '换个关键词或记录类型试试。' : '开始执行后，记录会自动保存在这里。'));
}
function renderBatches() {
  const layout = el('div', 'testing-layout'); const list = el('aside', 'panel testing-batches'); list.setAttribute('aria-label', '执行记录列表');
  const tools = el('div', 'testing-list-tools'); const listHeading = el('div', 'testing-list-heading'); listHeading.append(el('h2', '', '执行批次'), el('span', 'subtle', `${state.batches.length} 条`));
  const items = el('div', 'testing-batch-items');
  const search = searchInput('搜索执行记录', '搜索名称或批次 ID', state.batchQuery, value => { state.batchQuery = value; renderBatchItems(items); });
  const type = el('select', 'testing-filter'); type.setAttribute('aria-label', '筛选记录类型');
  for (const [value, text] of [['all', '全部类型'], ['collection', '集合测试'], ['flow', '多步流程']]) type.add(new Option(text, value));
  type.value = state.batchType; type.addEventListener('change', () => { state.batchType = type.value; renderBatchItems(items); });
  tools.append(listHeading, search, type); list.append(tools, items); renderBatchItems(items);
  const detail = el('section', 'panel testing-detail'); const batch = state.batch;
  if (!batch) { detail.append(blank('每次测试，都有自己的记录', '接口、数据库、MCP、命令行和服务执行都会归入批次。打开批次查看输入与结果。')); layout.append(list, detail); return layout; }
  const heading = el('div', 'panel-heading'); const title = el('div'); title.append(el('h2', '', batch.name), el('small', 'subtle', `${clock(batch.created_at)} · #${batch.id.slice(0, 8)}`));
  const actions = el('div', 'testing-actions'); actions.append(pill(batch.status));
  if (batch.source !== 'flow' && batch.status === 'running') { const add = button('＋ 添加测试', () => openCaseEditor(null, true)); const addMCP = button('＋ MCP 测试', () => openMCPCaseEditor(null, { batchID: batch.id, onSaved: async () => { await refreshTesting(); } })); addMCP.disabled = state.working; const addCommand = button('＋ 命令行测试', () => openCommandCaseEditor(null, { batchID: batch.id, onSaved: async () => { await refreshTesting(); } })); addCommand.disabled = state.working; actions.append(addMCP, addCommand); add.disabled = state.working; const finish = button('结束批次', () => perform(async () => { await api(`/test-batches/${batch.id}/finish`, { method: 'POST' }); }, '批次已结束')); finish.disabled = state.working || batch.counts.running > 0; actions.append(add, finish); }
  heading.append(title, actions);
  const counts = el('div', 'testing-summary'); counts.setAttribute('role', 'group'); counts.setAttribute('aria-label', '筛选测试结果');
  const results = el('div', 'testing-results'); results.setAttribute('aria-label', '用例执行结果');
  for (const [value, text, key] of resultTypes) {
    const filter = button('', () => { state.filter = value; counts.querySelectorAll('button').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.filter === value))); renderResults(results, batch); }, `testing-result-filter ${value}`);
    filter.dataset.filter = value; filter.setAttribute('aria-pressed', String(state.filter === value)); filter.append(el('span', '', text), el('strong', '', batch.counts[key] || 0)); counts.append(filter);
  }
  detail.append(heading, counts);
  if (batch.source === 'flow') {
    const link = el('a', 'button small', '查看步骤详情'); link.href = '/execution-records?type=flow&run=' + encodeURIComponent(batch.id); link.dataset.route = ''; actions.append(link);
  }
  if (state.paused) { const paused = el('div', 'detail-alert'); paused.append(el('strong', '', '测试正在等待暂停规则确认')); for (const [action, label] of [['continue', '继续请求'], ['skip', '跳过'], ['stop', '停止']]) paused.append(button(label, async event => { event.currentTarget.disabled = true; try { await api(`/steps/${state.paused.id}/resume`, { method: 'POST', body: { action } }); await refreshTesting(); } catch (error) { notice(error.message); event.currentTarget.disabled = false; } })); detail.append(paused); }
  const resultTools = el('div', 'testing-result-tools');
  const runSearch = searchInput('搜索执行用例', '搜索用例、目标或错误信息', state.query, value => { state.query = value; renderResults(results, batch); });
  const order = el('select', 'testing-filter'); order.setAttribute('aria-label', '结果展示方式');
  for (const [value, text] of [['sequence', '按执行顺序'], ['issues', '异常优先'], ['target', '按目标分组']]) order.add(new Option(text, value));
  order.value = state.order; order.addEventListener('change', () => { state.order = order.value; renderResults(results, batch); });
  resultTools.append(runSearch, order); detail.append(resultTools, results); renderResults(results, batch);
  layout.append(list, detail); return layout;
}
function renderResults(container, batch) {
  container.replaceChildren();
  const query = state.query.trim().toLowerCase();
  const runs = (batch.runs || []).filter(run => (state.filter === 'all' || run.status === state.filter) && `${run.name} ${runTarget(run)} ${run.error_message || ''} ${run.id}`.toLowerCase().includes(query));
  if (state.order === 'issues') runs.sort((a, b) => Number(['failed', 'error'].includes(b.status)) - Number(['failed', 'error'].includes(a.status)));
  const caption = el('div', 'testing-result-caption', `显示 ${runs.length} / ${(batch.runs || []).length} 条执行`); caption.setAttribute('role', 'status'); container.append(caption);
  if (!runs.length) { container.append(blank(batch.counts.total ? '没有符合筛选条件的结果' : '等待添加测试', batch.counts.total ? '切换结果筛选或调整关键词。' : '在上方添加测试，执行后即可在这里查看结果。')); return; }
  const columns = el('div', 'testing-result-columns'); columns.setAttribute('aria-hidden', 'true');
  for (const text of ['结果', '用例 / 执行目标', '执行时间', '耗时', '']) columns.append(el('span', '', text)); container.append(columns);
  const list = el('div', 'testing-result-list'); list.setAttribute('role', 'list');
  let previousGroup = '';
  const ordered = state.order === 'target' ? runs.toSorted((a, b) => runTarget(a).localeCompare(runTarget(b))) : runs;
  for (const run of ordered) {
    if (state.order === 'target' && runTarget(run) !== previousGroup) { previousGroup = runTarget(run); const group = el('div', 'test-endpoint', previousGroup); group.setAttribute('role', 'listitem'); list.append(group); }
    const item = el('div', 'testing-result-item'); item.setAttribute('role', 'listitem'); item.append(renderAttempt(run)); list.append(item);
  }
  container.append(list);
}
function renderAttempt(run) {
  const row = button('', () => openRunDrawer(run.id), 'test-attempt'); row.id = `test-attempt-${run.id}`;
  row.setAttribute('aria-label', `查看执行详情：${run.name}`); row.setAttribute('aria-haspopup', 'dialog'); row.setAttribute('aria-pressed', String(targetStep === run.id));
  const info = el('span', 'testing-result-info'); info.append(el('strong', '', run.name), el('small', 'testing-run-target', runTarget(run)));
  if (['failed', 'error'].includes(run.status)) info.append(el('small', 'testing-run-reason', runReason(run)));
  const time = el('time', 'testing-run-time', clock(run.started_at)); time.dateTime = run.started_at;
  const arrow = el('span', 'testing-run-arrow', '›'); arrow.setAttribute('aria-hidden', 'true');
  row.append(pill(run.status), info, time, el('span', 'testing-run-duration', duration(run)), arrow); return row;
}
function closeRunDrawer(updateLocation = true) {
  if (!runDrawer) return;
  const drawer = runDrawer; runDrawer = null;
  const opener = document.getElementById(`test-attempt-${targetStep}`); targetStep = ''; drawerKey = '';
  if (drawer.open) drawer.close(); drawer.remove();
  root.querySelectorAll('.test-attempt').forEach(node => node.setAttribute('aria-pressed', 'false'));
  if (state.active && updateLocation) locationForBatch();
  if (opener && !document.querySelector('dialog[open]')) opener.focus({ preventScroll: true });
}
function openRunDrawer(id) {
  if (!state.batch?.runs?.some(run => run.id === id)) return;
  targetStep = id; drawerTab = 'assertions'; drawerKey = '';
  if (!runDrawer) {
    runDrawer = el('dialog', 'request-detail test-run-drawer'); runDrawer.setAttribute('aria-labelledby', 'test-run-title');
    const drawer = runDrawer;
    drawer.addEventListener('close', () => { if (runDrawer === drawer) closeRunDrawer(); });
    drawer.addEventListener('cancel', event => { event.preventDefault(); closeRunDrawer(); });
    document.body.append(runDrawer);
  }
  updateRunDrawer();
  if (!runDrawer.open) runDrawer.showModal();
  root.querySelectorAll('.test-attempt').forEach(node => node.setAttribute('aria-pressed', String(node.id === `test-attempt-${id}`)));
  locationForBatch();
}
function updateRunDrawer() {
  const run = state.batch?.runs?.find(item => item.id === targetStep); if (!run) { closeRunDrawer(); return; }
  const key = JSON.stringify([run, state.working]); if (key === drawerKey) return; drawerKey = key;
  const scroll = runDrawer.querySelector('.detail-content')?.scrollTop || 0;
  const hadFocus = runDrawer.contains(document.activeElement);
  const activeTab = hadFocus ? document.activeElement?.dataset.runTab : null;
  const heading = el('div', 'detail-heading'); const title = el('div'); title.append(el('div', 'eyebrow', '执行详情')); const name = el('h2', '', run.name); name.id = 'test-run-title'; title.append(name);
  const close = button('关闭 ×', () => closeRunDrawer(), 'button small'); close.setAttribute('aria-label', '关闭执行详情'); heading.append(title, close);
  const content = el('div', 'detail-content'); const overview = el('section', `testing-run-overview ${run.status}`);
  const meta = el('div', 'testing-actions'); meta.append(pill(run.status), el('span', 'subtle', duration(run))); overview.append(meta, el('p', 'testing-run-conclusion', runReason(run)), el('div', 'detail-url', runTarget(run))); content.append(overview);
  const tabs = el('div', 'detail-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '执行详情内容');
  const definitions = [['assertions', '断言结果', renderAssertions(run)], ['input', '执行输入', renderRunInput(run)], ['output', '执行输出', renderRunOutput(run)], ['metadata', '记录信息', renderRunMetadata(run)]];
  const panels = el('div');
  function activate(index, focus = false) {
    drawerTab = definitions[index][0];
    definitions.forEach(([id, , panel], i) => { const tab = tabs.children[i]; const selected = i === index; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; panel.hidden = !selected; if (selected && focus) tab.focus(); });
  }
  for (const [id, label, panel] of definitions) {
    const tab = button(label, () => activate(definitions.findIndex(item => item[0] === id)), ''); tab.dataset.runTab = id;
    tab.id = `test-run-tab-${id}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `test-run-panel-${id}`);
    panel.id = `test-run-panel-${id}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0;
    panel.classList.add('testing-run-panel'); tabs.append(tab); panels.append(panel);
  }
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const index = [...tabs.children].indexOf(event.target); if (index < 0) return; event.preventDefault();
    activate(event.key === 'Home' ? 0 : event.key === 'End' ? definitions.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + definitions.length) % definitions.length, true);
  });
  activate(Math.max(0, definitions.findIndex(item => item[0] === drawerTab))); content.append(tabs, panels);
  const actions = el('div', 'testing-actions detail-foot');
  if (run.api_run_id) actions.append(button('请求与响应详情', event => openRequestDetail(run.api_run_id, event.currentTarget)));
  if (!run.type || ['http', 'mcp', 'command'].includes(run.type)) actions.append(button('另存为用例', () => openCaseEditor(run.type === 'command' ? { type: 'command', name: run.name, command_request: run.command_request_snapshot, expected_exit_code: run.expected_exit_code, assertions: run.assertion_definitions || [] } : run.type === 'mcp' ? { type: 'mcp', name: run.name, mcp_request: run.mcp_request_snapshot, expected_is_error: run.expected_is_error, validate_output_schema: run.validate_output_schema, assertions: run.assertion_definitions || [] } : { name: run.name, request: run.request_snapshot, expected_status: run.expected_status, assertions: run.assertion_definitions || [] })));
  if (run.case_id) { const retry = button('重试用例', () => openRunEditor([run.case_id])); retry.disabled = state.working; actions.append(retry); }
  runDrawer.replaceChildren(heading, content, actions); content.scrollTop = scroll;
  if (hadFocus) (tabs.querySelector(`[data-run-tab="${activeTab}"]`) || close).focus({ preventScroll: true });
}
function codeSection(title, value, copy = false) {
  const section = el('section', 'test-attempt-section'); const heading = el('h3', 'test-section-title', title); const text = display(value) ?? '（空）';
  if (copy) heading.append(button('复制', async event => { const control = event.currentTarget; try { await navigator.clipboard.writeText(text); control.textContent = '已复制'; } catch { control.textContent = '复制失败，请手动选择'; } }, 'button small'));
  section.append(heading, el('pre', 'detail-code', text)); return section;
}
function renderAssertions(run) {
  const results = el('div'); const assertions = run.assertions || []; const passed = assertions.filter(assertion => assertion.passed).length;
  results.append(el('p', 'testing-assertion-summary', assertions.length ? `${assertions.length} 项断言 · ${passed} 项通过 · ${assertions.length - passed} 项失败` : run.status === 'running' ? '执行中，断言结果将在完成后更新。' : run.status === 'unverified' ? '本次执行没有设置预期断言，因此保留为“未验证”。' : run.status === 'error' ? '执行发生错误，暂无断言结果。' : '暂无断言结果。'));
  for (const assertion of assertions) {
    const row = el('section', `test-assertion${assertion.passed ? '' : ' is-failed'}`); const heading = el('div', 'test-assertion-heading'); const target = el('div', 'test-assertion-target'); target.append(el('code', '', `${assertion.kind}${assertion.path ? `.${assertion.path}` : ''}`), el('span', 'test-assertion-operator', assertion.operator || 'equals')); heading.append(target, pill(assertion.passed ? 'passed' : 'failed'));
    const values = el('dl', 'test-assertion-values');
    for (const [label, value] of [['预期值', assertion.expected], ['实际值', assertion.actual]]) { const pair = el('div'); pair.append(el('dt', '', label), el('dd', '', display(value) ?? '—')); values.append(pair); }
    row.append(heading, values); results.append(row);
  }
  if (run.expected_status && !assertions.length) results.append(el('p', '', `预期 HTTP ${run.expected_status}`)); return results;
}
function renderRunInput(run) {
  const panel = el('div'); const input = run.type === 'sql' || run.type === 'service' ? run.execution_input : run.type === 'command' ? run.command_request_snapshot : run.type === 'mcp' ? run.mcp_request_snapshot : run.request_snapshot;
  panel.append(codeSection(({ sql: 'SQL 执行快照', service: '服务执行快照', command: '命令执行快照', mcp: 'MCP 调用快照' })[run.type] || 'HTTP 请求快照', input, true)); return panel;
}
function renderRunOutput(run) {
  const panel = el('div');
  if (run.type === 'command') {
    const data = run.command_result || {}; panel.append(el('p', 'testing-assertion-summary', `退出码 ${data.exit_code ?? '—'} · ${duration(run)}`));
    for (const source of ['stdout', 'stderr']) { panel.append(codeSection(source, data[source] || '（空）', true)); if (data[`${source}_truncated`]) panel.append(el('p', 'response-error', '输出已截断，相关输出断言不能判为通过。')); }
  } else if (run.type === 'mcp') panel.append(codeSection('MCP 返回结果', run.mcp_result, true));
  else if (run.type === 'sql' || run.type === 'service') panel.append(codeSection(run.type === 'sql' ? 'SQL 执行结果' : '服务执行结果', run.execution_result, true));
  else panel.append(el('p', 'detail-empty', run.api_run_id ? '打开“请求与响应详情”查看保存的 HTTP 响应正文、响应头和请求信息。' : run.status === 'running' ? '正在执行，等待响应。' : '本次执行没有可用的请求详情。'));
  if (run.error_message) panel.prepend(codeSection('执行错误', run.error_message, true)); return panel;
}
function renderRunMetadata(run) {
  const panel = el('div'); const pairs = el('dl', 'detail-pairs');
  for (const [label, value] of [['执行 ID', run.id], ['批次', state.batch.name], ['批次 ID', state.batch.id], ['开始时间', clock(run.started_at)], ['结束时间', run.finished_at ? clock(run.finished_at) : '—'], ['耗时', duration(run)], ['用例版本', run.case_version ? `v${run.case_version}` : '临时用例']]) pairs.append(el('dt', '', label), el('dd', '', value));
  panel.append(pairs); return panel;
}
async function selectBatch(id) {
  const selection = ++state.selection;
  try { const batch = await api(`/test-batches/${encodeURIComponent(id)}`); if (selection !== state.selection) return; if (state.batch?.id !== batch.id) { closeRunDrawer(); targetStep = ''; state.query = ''; } state.batch = batch; state.paused = null; state.tab = 'records'; state.type = 'all'; deactivateFlows(); state.filter = 'all'; state.signature = ''; render(); locationForBatch(); }
  catch (error) { notice(error.message); }
}
export async function refreshTesting() {
  if (isFlowView() || state.tab === 'cases') { await refreshFlows(); return; }
  if (state.loading) return; state.loading = true;
  const selection = state.selection; const id = state.batch?.id;
  try {
    const results = await Promise.allSettled([api('/test-batches'), id ? api(`/test-batches/${id}`) : Promise.resolve(null)]);
    let error = ''; results.forEach(result => { if (result.status === 'rejected') error = result.reason.message; });
    if (results[0].status === 'fulfilled') state.batches = results[0].value;
    if (selection === state.selection && results[1].status === 'fulfilled' && results[1].value) state.batch = results[1].value;
    if (selection === state.selection && !state.batch && state.batches.length) state.batch = await api(`/test-batches/${state.batches[0].id}`);
    if (state.batch?.counts.running) { try { const session = await api(`/sessions/${state.batch.id}`); if (selection === state.selection) state.paused = session.steps?.find(step => step.status === 'paused') || null; } catch { /* REST-only runs do not create a legacy session. */ } } else state.paused = null;
    if (error) notice(`读取测试失败：${error}`); else if (state.error.startsWith('读取测试失败：')) notice();
    render();
  } catch (error) { notice(`读取测试失败：${error.message}`); render(); }
  finally { state.loading = false; }
}
async function perform(action, message = '') { if (state.working) return; state.working = true; render(); notice(); try { await action(); notice('', message); } catch (error) { notice(error.message); } finally { state.working = false; await refreshTesting(); render(); } }
function dialog(title) {
  if (editor) editor.remove(); editorDirty = false;
  editor = el('dialog', 'testing-editor'); editor.setAttribute('aria-label', title);
  const heading = el('div', 'detail-heading'); heading.append(el('h2', '', title), button('关闭 ×', () => editor.close(), 'button small'));
  const form = el('form'); const content = el('div', 'testing-form'); const error = el('div', 'detail-alert error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const actions = el('div', 'database-dialog-actions'); form.append(content, error, actions); editor.append(heading, form); document.body.append(editor);
  const showError = message => { error.textContent = message; error.hidden = !message; };
  editor.showModal();
  return { form, content, actions, showError, element: editor };
}
function lockDialog(d, locked) { d.element.querySelectorAll('button,input,select,textarea').forEach(item => { item.disabled = locked; }); d.element.oncancel = event => { if (locked) event.preventDefault(); }; }
function openBatchEditor() {
  const d = dialog('新建测试批次'); const name = field('批次名称', '', 'input'); name.input.required = true; name.input.placeholder = '例如：用户接口参数校验'; d.content.append(name.wrap); const save = button('创建批次', () => d.form.requestSubmit(), 'button primary'); d.actions.append(save);
  d.form.addEventListener('submit', async event => { event.preventDefault(); lockDialog(d, true); d.showError(''); try { const batch = await api('/test-batches', { method: 'POST', body: { name: name.input.value } }); editorDirty = false; d.element.close(); await selectBatch(batch.id); await refreshTesting(); } catch (error) { d.showError(error.message); } finally { lockDialog(d, false); } }); name.input.focus();
}
function headersObject(request) { return Object.fromEntries((request.headers || []).filter(item => item.enabled).map(item => [item.name, item.value])); }
function openCaseEditor(item = null, temporary = false) {
  if (item?.type === 'command') return openCommandCaseEditor(item, { batchID: temporary && state.batch?.source !== 'flow' && state.batch?.status === 'running' ? state.batch.id : undefined, onSaved: async id => { if (id) await selectBatch(id); await refreshTesting(); } });
  if (item?.type === 'mcp') return openMCPCaseEditor(item, { batchID: temporary && state.batch?.source !== 'flow' && state.batch?.status === 'running' ? state.batch.id : undefined, onSaved: async id => { if (id) await selectBatch(id); await refreshTesting(); } });
  const d = dialog(temporary ? '添加本次测试' : item?.id ? '编辑测试用例' : '新建测试用例'); const original = item?.request || {};
  const name = field('用例名称', item?.name || ''); name.input.required = true; name.input.placeholder = '例如：缺少邮箱时返回 400';
  const description = field('说明', item?.description || '');
  const method = field('请求方法', '', 'select'); for (const value of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) method.input.add(new Option(value, value)); method.input.value = original.method || 'GET';
  const url = field('请求地址', original.url || ''); url.input.required = true; url.input.placeholder = 'http://127.0.0.1:8080/users'; const row = el('div', 'test-field-row'); row.append(method.wrap, url.wrap);
  const bodyType = field('正文类型', '', 'select'); for (const [value, text] of [['none', '无正文'], ['json', 'JSON'], ['text', '文本'], ['form', '表单']]) bodyType.input.add(new Option(text, value)); bodyType.input.value = original.body_type || (original.body ? 'json' : 'none');
  const body = field('请求正文', original.body || '', 'textarea');
  const headers = field('请求头（JSON 对象）', JSON.stringify(headersObject(original), null, 2), 'textarea');
  const query = field('查询参数（JSON 数组）', JSON.stringify(original.query_params || [], null, 2), 'textarea');
  const status = field('预期状态码', item?.expected_status ?? ''); status.input.type = 'number'; status.input.min = '100'; status.input.max = '599'; status.input.placeholder = '可留空；没有断言时标记为未验证';
  const assertions = field('响应断言（JSON 数组）', JSON.stringify(item?.assertions || [], null, 2), 'textarea');
  const help = el('p', '', '断言支持 body、header、status；比较方式为 equals、not_equals、contains、exists。body 路径使用 data.user.id 这样的点路径。');
  const example = el('details'); example.append(el('summary', '', '查看断言示例'), el('pre', 'detail-code', '[{"source":"body","path":"error.code","operator":"equals","expected":"INVALID_EMAIL"}]'));
  d.content.append(name.wrap, description.wrap, row, headers.wrap, query.wrap, bodyType.wrap, body.wrap, status.wrap, assertions.wrap, help, example);
  if (JSON.stringify(original).includes('••••')) d.content.append(el('p', 'response-error', '此请求来自脱敏快照，请替换脱敏字段后再执行。'));
  const save = button(item?.id ? '保存修改' : '保存用例', () => { d.form.dataset.intent = 'save'; d.form.requestSubmit(); }, 'button primary'); d.actions.append(save);
  if (!item?.id) d.actions.append(button('仅运行本次', () => { d.form.dataset.intent = 'run'; d.form.requestSubmit(); }));
  d.form.addEventListener('submit', async event => {
    event.preventDefault(); d.showError(''); let value;
    try {
      const headerValues = JSON.parse(headers.input.value || '{}'); if (!headerValues || Array.isArray(headerValues) || typeof headerValues !== 'object' || Object.values(headerValues).some(value => typeof value !== 'string')) throw new Error('请求头需要是值为字符串的 JSON 对象。');
      const queryValues = JSON.parse(query.input.value || '[]'); if (!Array.isArray(queryValues)) throw new Error('查询参数需要是 JSON 数组，每项包含 name、value、enabled。');
      const definitions = JSON.parse(assertions.input.value || '[]'); if (!Array.isArray(definitions)) throw new Error('响应断言需要是 JSON 数组。');
      value = { ...(item?.id ? { id: item.id, edit_version: item.edit_version, project_id: item.project_id, api_request_id: item.api_request_id } : {}), name: name.input.value, description: description.input.value, request: { ...original, method: method.input.value, url: url.input.value, body_type: bodyType.input.value, body: body.input.value, headers: Object.entries(headerValues).map(([name, value]) => ({ name, value, enabled: true })), query_params: queryValues }, assertions: definitions, ...(status.input.value ? { expected_status: Number(status.input.value) } : {}) };
    } catch (error) { d.showError(error.message); return; }
    lockDialog(d, true);
    try {
      if (d.form.dataset.intent === 'run') {
        const batch = state.batch?.source !== 'flow' && state.batch?.status === 'running' ? state.batch : await api('/test-batches', { method: 'POST', body: { name: value.name } });
        const ownsBatch = state.batch?.id !== batch.id;
        state.working = true; await selectBatch(batch.id); editorDirty = false; d.element.close(); render();
        const result = await api(`/test-batches/${batch.id}/runs`, { method: 'POST', body: { test_case: value } });
        if (ownsBatch) await api(`/test-batches/${batch.id}/finish`, { method: 'POST' });
        await selectBatch(result.batch_id);
      } else await api(item?.id ? `/test-cases/${item.id}` : '/test-cases', { method: item?.id ? 'PUT' : 'POST', body: value });
      editorDirty = false; d.element.close(); await refreshTesting(); notice('', d.form.dataset.intent === 'run' ? '本次测试已记录' : '用例已保存');
    } catch (error) { if (d.element.open) d.showError(error.message); else notice(error.message); } finally { state.working = false; lockDialog(d, false); render(); }
  }); name.input.focus();
}
function openRunEditor(ids) {
  if (!ids.length) return; const d = dialog(`运行 ${ids.length} 个测试用例`); const name = field('新批次名称', `接口回归 · ${new Date().toLocaleString('zh-CN')}`); name.input.required = true;
  const target = field('运行到', '', 'select'); target.input.add(new Option('新建测试批次', 'new')); for (const batch of state.batches.filter(item => item.source !== 'flow' && item.status === 'running')) target.input.add(new Option(batch.name, batch.id));
  const variables = field('运行变量（JSON 对象）', '{}', 'textarea'); d.content.append(target.wrap, name.wrap, variables.wrap, el('p', '', '各用例独立执行，不传递前一次响应中的 token 或 ID。可以使用 {{base_url}}、{{token}} 等变量。新批次在所选用例全部执行后自动结束。'));
  const run = button('开始测试', () => d.form.requestSubmit(), 'button primary'); d.actions.append(run);
  target.input.addEventListener('change', () => { name.wrap.hidden = target.input.value !== 'new'; name.input.required = target.input.value === 'new'; });
  d.form.addEventListener('submit', async event => {
    event.preventDefault(); let values;
    try { values = JSON.parse(variables.input.value); if (!values || Array.isArray(values) || typeof values !== 'object' || Object.values(values).some(value => typeof value !== 'string')) throw new Error('变量需要是值为字符串的 JSON 对象。'); } catch (error) { d.showError(error.message); return; }
    lockDialog(d, true); state.working = true; render(); d.showError('');
    let batch;
    try {
      batch = target.input.value === 'new' ? await api('/test-batches', { method: 'POST', body: { name: name.input.value } }) : { id: target.input.value };
      await selectBatch(batch.id); editorDirty = false; d.element.close();
      const failures = [];
      for (const id of ids) { try { await api(`/test-batches/${batch.id}/runs`, { method: 'POST', body: { case_id: id, variables: values } }); } catch (error) { failures.push(error.message); } await refreshTesting(); }
      if (target.input.value === 'new') await api(`/test-batches/${batch.id}/finish`, { method: 'POST' });
      notice(failures.length ? failures.join('；') : '', failures.length ? '' : `${ids.length} 个用例已完成，结果已保存`);
    } catch (error) { if (d.element.open) d.showError(error.message); else notice(error.message); }
    finally { state.working = false; lockDialog(d, false); await refreshTesting(); render(); }
  });
}
export async function activateTesting() {
  const revision = ++state.viewRevision; state.selection++;
  closeRunDrawer(false);
  targetStep = new URLSearchParams(location.search).get('step') || '';
  if (targetStep) { state.filter = 'all'; state.query = ''; }
  state.active = true; mount(); readRoute(); state.signature = ''; render();
  const query = new URLSearchParams(location.search);
  if (!isFlowView() && query.get('batch') && query.get('batch') !== state.batch?.id) {
    const requestedStep = targetStep; await selectBatch(query.get('batch'));
    if (revision !== state.viewRevision || !state.active) return;
    targetStep = requestedStep;
  }
  if (revision !== state.viewRevision || !state.active) return;
  await showView(); clearTimeout(state.timer);
  if (revision !== state.viewRevision || !state.active) return;
  if (targetStep && !isFlowView() && state.batch?.runs?.some(run => run.id === targetStep)) openRunDrawer(targetStep);
  const poll = async () => { if (!state.active) return; if (!isFlowView()) await refreshTesting(); if (state.active) state.timer = setTimeout(poll, 1500); }; state.timer = setTimeout(poll, 1500);
}
export function deactivateTesting() { state.active = false; closeRunDrawer(); if (toolbar) toolbar.hidden = true; state.viewRevision++; state.selection++; clearTimeout(state.timer); deactivateFlows(); }
window.addEventListener('testing-flow-location', () => { if (state.active) { readRoute(); state.signature = ''; render(); if (!isFlowView() && state.tab === 'records') { deactivateFlows(); void refreshTesting(); } } });
window.addEventListener('beforeunload', event => { if (editorDirty && editor?.open) { event.preventDefault(); event.returnValue = ''; } });
