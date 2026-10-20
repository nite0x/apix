import { activateFlows, deactivateFlows, refreshFlows, leaveFlows } from './flows.js';
import { openCommandCaseEditor } from './command-tools.js';
import { openMCPCaseEditor } from './mcp-tools.js';
import { openRequestDetail } from './request-detail.js';
import { revealExecutionStep } from './execution-batch.js';

const root = document.getElementById('testing-workspace');
const flowRoot = document.getElementById('flow-workspace');
const state = { type: 'single', viewRevision: 0, batches: [], cases: [], batch: null, tab: 'cases', active: false, loading: false, working: false, picked: new Set(), open: new Set(), filter: 'all', timer: null, error: '', message: '', signature: '', selection: 0, paused: null };
let mounted = false;
let editor = null;
let editorDirty = false;
let targetStep = '';

function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); return node; }
function button(text, action, cls = 'button') { const item = el('button', cls, text); item.type = 'button'; item.addEventListener('click', action); return item; }
function field(label, value = '', type = 'input') { const wrap = el('label'); const input = el(type); input.value = value; input.setAttribute('aria-label', label); input.addEventListener('input', () => { editorDirty = true; }); wrap.append(el('span', '', label), input); return { wrap, input }; }
function display(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
function clock(value) { return new Date(value).toLocaleString('zh-CN'); }
function pill(status) { return el('span', `test-pill ${status}`, ({ passed: '通过', failed: '断言失败', error: '执行错误', unverified: '未验证', running: '进行中', completed: '已结束', interrupted: '已中断' })[status] || status); }
function summary(counts) { return `${counts.total} 次执行 · 通过 ${counts.passed} · 失败 ${counts.failed} · 错误 ${counts.errors} · 未验证 ${counts.unverified}`; }
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { cache: 'no-store', ...options, ...(options.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}) });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function notice(error = '', message = '') { state.error = error; state.message = message; const node = root.querySelector('[data-testing-message]'); if (node) { node.textContent = error || message; node.hidden = !node.textContent; node.className = `detail-alert testing-message${error ? ' error' : ''}`; node.setAttribute('role', error ? 'alert' : 'status'); } }
function isFlowView() { return state.type === 'flow' && state.tab !== 'batches'; }
function isCollectionView() { return location.pathname === '/test-collections'; }
function testingPath() { return location.pathname === '/test-collections' ? '/test-collections' : '/tests'; }
function readRoute() {
  if (isCollectionView()) { state.tab = 'records'; state.type = 'single'; return; }
  const query = new URLSearchParams(location.search);
  state.tab = ['cases', 'batches', 'records'].includes(query.get('tab')) ? query.get('tab') : query.has('batch') || location.pathname === '/test-collections' ? 'records' : 'cases';
  state.type = query.get('type') === 'flow' && state.tab !== 'batches' ? 'flow' : 'single';
}
function locationForBatch() {
  if (!state.active || isFlowView() || !['/tests', '/test-collections'].includes(location.pathname)) return;
  const query = new URLSearchParams({ tab: state.tab });
  if (state.batch && state.tab !== 'cases') query.set('batch', state.batch.id);
  if (targetStep && state.batch?.runs?.some(run => run.id === targetStep)) query.set('step', targetStep);
  history.replaceState(null, '', `${testingPath()}?${query}`);
}
async function switchView(tab, type = state.type) {
  if (isFlowView() && !(await leaveFlows())) return;
  state.viewRevision++; state.selection++;
  state.tab = tab; state.type = tab === 'batches' ? 'single' : type;
  state.signature = '';
  if (isFlowView()) history.pushState(null, '', `${testingPath()}?tab=${tab}&type=flow`);
  else {
    const query = new URLSearchParams({ tab });
    if (state.batch && tab !== 'cases') query.set('batch', state.batch.id);
    history.pushState(null, '', `${testingPath()}?${query}`);
  }
  await showView();
}
function bindTabKeys(tabs) {
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const controls = [...tabs.querySelectorAll('[role="tab"]')];
    const index = controls.indexOf(event.target); if (index < 0) return;
    event.preventDefault();
    const target = event.key === 'Home' ? controls[0] : event.key === 'End' ? controls.at(-1)
      : controls[(index + (event.key === 'ArrowLeft' ? -1 : 1) + controls.length) % controls.length];
    target.focus(); target.click();
  });
}
function mount() {
  if (mounted) return; mounted = true; root.replaceChildren();
  const toolbar = el('div', 'testing-toolbar'); const tabs = el('div', 'testing-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '测试视图');
  for (const [key, name] of [['cases', '测试用例'], ['batches', '测试批次'], ['records', '执行记录']]) {
    const tab = button(name, () => void switchView(key), 'testing-tab'); tab.dataset.testTab = key; tab.id = `testing-tab-${key}`;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'testing-view-panel'); tabs.append(tab);
  }
  bindTabKeys(tabs);
  const actions = el('div', 'testing-actions'); actions.dataset.testingActions = '';
  const batch = button('＋ 新建批次', openBatchEditor); batch.dataset.batchAction = ''; actions.append(batch);
  const add = button('＋ 新建用例', openCaseTypeChooser, 'button primary'); add.dataset.caseAction = ''; actions.append(add);
  toolbar.append(tabs, actions);
  const panel = el('div'); panel.id = 'testing-view-panel'; panel.setAttribute('role', 'tabpanel');
  const types = el('label', 'testing-type-filter'); types.dataset.testingTypes = '';
  const typeLabel = el('span'); typeLabel.dataset.testingTypeLabel = '';
  const typeSelect = el('select'); typeSelect.dataset.testingType = ''; typeSelect.id = 'testing-type-select';
  typeSelect.append(new Option('独立调用', 'single'), new Option('业务流程', 'flow'));
  typeSelect.addEventListener('change', async () => {
    const requested = typeSelect.value; typeSelect.value = state.type;
    await switchView(state.tab, requested);
  });
  types.append(typeLabel, typeSelect);
  const hint = el('p', 'testing-view-hint'); hint.dataset.testingHint = '';
  const message = el('div', 'detail-alert testing-message'); message.dataset.testingMessage = ''; message.hidden = true;
  const typePanel = el('div'); typePanel.id = 'testing-type-panel'; typePanel.setAttribute('role', 'region');
  const content = el('div'); content.dataset.testingContent = '';
  typePanel.append(content, flowRoot); panel.append(types, hint, message, typePanel); root.append(toolbar, panel);
}
async function showView() {
  render();
  if (isFlowView()) await activateFlows();
  else { deactivateFlows(); await refreshTesting(); }
}
function blank(title, text) { const node = el('div', 'testing-empty'); node.append(el('h2', '', title), el('p', '', text)); return node; }
function render() {
  mount();
  const collection = isCollectionView();
  root.setAttribute('aria-label', collection ? '测试集合' : '测试工作区');
  root.querySelector('.testing-toolbar').hidden = collection;
  root.querySelectorAll('[data-test-tab]').forEach(node => { const selected = node.dataset.testTab === state.tab; node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1; });
  const viewPanel = root.querySelector('#testing-view-panel');
  viewPanel.setAttribute('role', collection ? 'region' : 'tabpanel');
  if (collection) { viewPanel.removeAttribute('aria-labelledby'); viewPanel.setAttribute('aria-label', '执行记录'); }
  else { viewPanel.removeAttribute('aria-label'); viewPanel.setAttribute('aria-labelledby', `testing-tab-${state.tab}`); }
  const typeSelect = root.querySelector('[data-testing-type]');
  const typeLabel = state.tab === 'records' ? '记录类型' : '用例类型';
  root.querySelector('[data-testing-type-label]').textContent = typeLabel;
  typeSelect.setAttribute('aria-label', typeLabel); typeSelect.value = state.type; typeSelect.disabled = state.working;
  typeSelect.options[0].textContent = state.tab === 'records' ? '独立调用记录' : '独立调用';
  typeSelect.options[1].textContent = state.tab === 'records' ? '业务流程记录' : '业务流程';
  root.querySelector('[data-testing-types]').hidden = collection || state.tab === 'batches';
  root.querySelector('[data-testing-hint]').hidden = collection;
  const typePanel = root.querySelector('#testing-type-panel');
  typePanel.setAttribute('aria-label', state.tab === 'batches' ? '测试批次' : typeSelect.selectedOptions[0].textContent);
  root.querySelector('[data-testing-hint]').textContent = state.tab === 'cases'
    ? isFlowView() ? '按顺序执行多个步骤，传递数据并验证完整业务场景。' : '每个用例验证一次 HTTP 请求、MCP 工具调用或命令执行，各用例独立运行。'
    : state.tab === 'batches' ? '组织本次要验证的独立用例，查看进度并管理批次。'
    : isFlowView() ? '查看业务流程每次运行的步骤、断言与结果。' : '选择测试批次，查看其中每次独立调用的输入、断言与结果。';
  root.querySelectorAll('[data-case-action]').forEach(node => { node.hidden = state.tab !== 'cases' || isFlowView(); });
  root.querySelector('[data-batch-action]').hidden = state.tab !== 'batches';
  root.querySelector('[data-testing-content]').hidden = isFlowView();
  flowRoot.hidden = !isFlowView();
  root.querySelectorAll('.testing-toolbar button').forEach(node => { node.disabled = state.working; });
  notice(state.error, state.message);
  if (isFlowView()) return;
  const signature = JSON.stringify([state.type, state.tab, state.batches, state.cases, state.batch, state.working, state.filter, state.paused]);
  if (signature === state.signature) return; state.signature = signature;
  const content = root.querySelector('[data-testing-content]');
  content.replaceChildren(state.tab === 'cases' ? renderCases() : renderBatches(state.tab === 'records'));
}
function renderBatches(records = false) {
  const layout = el('div', 'testing-layout'); const list = el('aside', 'panel testing-batches'); list.setAttribute('aria-label', '测试批次列表');
  for (const batch of state.batches) {
    const item = button('', () => selectBatch(batch.id, state.tab), 'testing-batch'); item.setAttribute('aria-pressed', String(state.batch?.id === batch.id));
    item.append(el('strong', '', batch.name), el('small', '', `${clock(batch.created_at)} · ${batch.counts.total} 次执行`), el('small', '', `通过 ${batch.counts.passed} / 失败 ${batch.counts.failed + batch.counts.errors}`), pill(batch.status)); list.append(item);
  }
  if (!state.batches.length) list.append(blank('还没有测试批次', 'AI 开始测试后会自动出现在这里，也可以手动新建。'));
  const detail = el('section', 'panel testing-detail'); const batch = state.batch;
  if (!batch) { detail.append(blank('每次测试，都有自己的记录', '一个批次可以包含多个接口、不同入参。打开批次查看每个用例的预期与实际结果。')); layout.append(list, detail); return layout; }
  const heading = el('div', 'panel-heading'); const title = el('div'); title.append(el('h2', '', batch.name), el('small', 'subtle', `${clock(batch.created_at)} · #${batch.id.slice(0, 8)}`));
  const actions = el('div', 'testing-actions'); actions.append(pill(batch.status));
  if (!records && batch.status === 'running') { const add = button('＋ 添加测试', () => openCaseEditor(null, true)); const addMCP = button('＋ MCP 测试', () => openMCPCaseEditor(null, { batchID: batch.id, onSaved: async () => { await refreshTesting(); } })); addMCP.disabled = state.working; const addCommand = button('＋ 命令行测试', () => openCommandCaseEditor(null, { batchID: batch.id, onSaved: async () => { await refreshTesting(); } })); addCommand.disabled = state.working; actions.append(addMCP, addCommand); add.disabled = state.working; const finish = button('结束批次', () => perform(async () => { await api(`/test-batches/${batch.id}/finish`, { method: 'POST' }); }, '批次已结束')); finish.disabled = state.working || batch.counts.running > 0; actions.append(add, finish); }
  heading.append(title, actions); const counts = el('div', 'testing-summary'); counts.append(el('span', '', summary(batch.counts)));
  const filter = el('select', 'testing-filter'); filter.setAttribute('aria-label', '筛选测试结果'); for (const [value, text] of [['all', '全部结果'], ['failed', '断言失败'], ['error', '执行错误'], ['passed', '通过'], ['unverified', '未验证'], ['running', '进行中']]) filter.add(new Option(text, value)); filter.value = state.filter; filter.addEventListener('change', () => { state.filter = filter.value; render(); }); if (records) counts.append(filter); detail.append(heading, counts);
  if (!records) {
    const overview = el('div', 'testing-batch-overview');
    overview.append(el('p', '', '批次保存本次测试任务的进度与结果；用例的每次尝试都保留独立记录。'), button('查看执行记录 →', () => void switchView('records', 'single'), 'button primary'));
    detail.append(overview); layout.append(list, detail); return layout;
  }
  if (isCollectionView()) {
    const manage = el('a', 'button', '查看测试批次');
    manage.href = `/tests?tab=batches&batch=${encodeURIComponent(batch.id)}`; manage.dataset.route = '';
    actions.append(manage);
  } else actions.append(button('查看测试批次', () => void switchView('batches', 'single')));
  if (state.paused) { const paused = el('div', 'detail-alert'); paused.append(el('strong', '', '测试正在等待暂停规则确认')); for (const [action, label] of [['continue', '继续请求'], ['skip', '跳过'], ['stop', '停止']]) paused.append(button(label, async event => { event.currentTarget.disabled = true; try { await api(`/steps/${state.paused.id}/resume`, { method: 'POST', body: { action } }); await refreshTesting(); } catch (error) { notice(error.message); event.currentTarget.disabled = false; } })); detail.append(paused); }
  const runs = (batch.runs || []).filter(run => state.filter === 'all' || run.status === state.filter);
  const groups = new Map();
  for (const run of runs) { const request = run.request_snapshot; const key = run.type === 'command' ? `命令行 ${run.command_request_snapshot?.program || ''}` : run.type === 'mcp' ? `MCP ${run.mcp_result?.server?.name || run.mcp_request_snapshot?.server_id} / ${run.mcp_request_snapshot?.tool_name}` : `${request.method} ${request.url.split('?')[0]}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(run); }
  for (const [endpoint, attempts] of groups) { const section = el('section'); section.append(el('h3', 'test-endpoint', `${endpoint} · ${attempts.length} 次执行`)); for (const run of attempts) section.append(renderAttempt(run)); detail.append(section); }
  if (!runs.length) detail.append(blank(batch.counts.total ? '没有符合筛选条件的结果' : '等待添加测试', batch.counts.total ? '切换结果筛选查看其他用例。' : '在“测试批次”中添加测试，执行后即可在这里查看结果。'));
  layout.append(list, detail); return layout;
}
function renderAttempt(run) {
  const details = el('details', 'test-attempt'); details.open = state.open.has(run.id); details.addEventListener('toggle', () => { if (details.open) state.open.add(run.id); else state.open.delete(run.id); });
  details.id = `test-attempt-${run.id}`; details.tabIndex = -1;
  details.classList.toggle('execution-target', run.id === targetStep);
  const title = el('summary'); const chevron = el('span', 'test-attempt-chevron'); chevron.setAttribute('aria-hidden', 'true'); title.append(chevron, pill(run.status), el('strong', '', run.name), el('small', '', `${clock(run.started_at)}${run.case_version ? ` · 用例 v${run.case_version}` : ' · 临时用例'} · #${run.id.slice(0, 8)}`));
  const body = el('div', 'test-attempt-body'); const request = run.request_snapshot;
  const snapshot = el('section', 'test-attempt-section'); snapshot.append(el('h4', 'test-section-title', '请求快照'), el('pre', 'detail-code', display(run.type === 'command' ? run.command_request_snapshot : run.type === 'mcp' ? run.mcp_request_snapshot : { method: request.method, url: request.url, query_params: request.query_params, headers: request.headers, body: request.body }))); body.append(snapshot);
  const assertions = run.assertions || [];
  const results = el('section', 'test-attempt-section'); const resultHeading = el('h4', 'test-section-title', '断言结果');
  const passed = assertions.filter(assertion => assertion.passed).length;
  resultHeading.append(el('span', 'test-section-meta', assertions.length ? `${assertions.length} 项 · ${passed} 项通过${passed < assertions.length ? ` · ${assertions.length - passed} 项失败` : ''}` : '暂无断言结果')); results.append(resultHeading);
  const list = el('div', 'test-assertions');
  for (const assertion of assertions) {
    const row = el('div', `test-assertion${assertion.passed ? '' : ' is-failed'}`); const heading = el('div', 'test-assertion-heading'); const target = el('div', 'test-assertion-target'); target.append(el('code', '', `${assertion.kind}${assertion.path ? `.${assertion.path}` : ''}`), el('span', 'test-assertion-operator', assertion.operator || 'equals')); heading.append(target, pill(assertion.passed ? 'passed' : 'failed'));
    const values = el('dl', 'test-assertion-values');
    for (const [label, value] of [['预期值', assertion.expected], ['实际值', assertion.actual]]) { const pair = el('div'); pair.append(el('dt', '', label), el('dd', '', display(value) ?? '—')); values.append(pair); }
    row.append(heading, values); list.append(row);
  }
  results.append(list);
  if (run.expected_status && !assertions.length) results.append(el('p', '', `预期 HTTP ${run.expected_status}`));
  body.append(results);
  if (run.error_message) body.append(el('p', 'response-error', run.error_message));
  if (run.status === 'unverified') body.append(el('p', '', '本次请求没有设置预期断言，因此保留为“未验证”。'));
  const actions = el('div', 'testing-actions test-attempt-actions');
  if (run.api_run_id) actions.append(button('请求与响应详情', event => openRequestDetail(run.api_run_id, event.currentTarget)));
  else if (run.finished_at && run.type !== 'mcp' && run.type !== 'command') body.append(el('p', '', '本次执行没有可用的请求详情。'));
  if (run.type === 'command') { const response = el('section', 'test-attempt-section'); const data = run.command_result || {}; response.append(el('h4', 'test-section-title', `命令执行结果 · 退出码 ${data.exit_code ?? '—'} · ${data.duration_ms ?? 0} ms`)); for (const source of ['stdout', 'stderr']) { response.append(el('h4', 'test-section-title', source), el('pre', 'detail-code', data[source] || '（空）')); if (data[`${source}_truncated`]) response.append(el('p', 'response-error', '输出已截断，相关输出断言不能判为通过。')); } body.append(response); }
  if (run.type === 'mcp') { const response = el('section', 'test-attempt-section'); response.append(el('h4', 'test-section-title', 'MCP 返回结果'), el('pre', 'detail-code', display(run.mcp_result))); body.append(response); }
  actions.append(button('另存为用例', () => openCaseEditor(run.type === 'command' ? { type: 'command', name: run.name, command_request: run.command_request_snapshot, expected_exit_code: run.expected_exit_code, assertions: run.assertion_definitions || [] } : run.type === 'mcp' ? { type: 'mcp', name: run.name, mcp_request: run.mcp_request_snapshot, expected_is_error: run.expected_is_error, validate_output_schema: run.validate_output_schema, assertions: run.assertion_definitions || [] } : { name: run.name, request: run.request_snapshot, expected_status: run.expected_status, assertions: run.assertion_definitions || [] })));
  if (run.case_id) { const retry = button('重试用例', () => openRunEditor([run.case_id])); retry.disabled = state.working; actions.append(retry); }
  body.append(actions); details.append(title, body); return details;
}
function renderCases() {
  const panel = el('section', 'panel'); const heading = el('div', 'panel-heading'); heading.append(el('h2', '', `已保存用例 · ${state.cases.length}`));
  const runSelected = button('运行所选用例', () => openRunEditor([...state.picked]), 'button primary'); runSelected.disabled = state.working || !state.picked.size; runSelected.dataset.runSelected = ''; heading.append(runSelected); panel.append(heading);
  const list = el('div', 'test-cases');
  for (const item of state.cases) {
    const row = el('div', 'test-case-row'); const pick = el('input', 'testing-pick'); pick.type = 'checkbox'; pick.checked = state.picked.has(item.id); pick.setAttribute('aria-label', `选择用例 ${item.name}`); pick.addEventListener('change', () => { if (pick.checked) state.picked.add(item.id); else state.picked.delete(item.id); runSelected.disabled = state.working || !state.picked.size; });
    const info = el('div', 'test-case-info'); info.append(el('strong', '', item.name), el('small', '', item.type === 'command' ? `命令行 · ${item.command_request.program}` : item.type === 'mcp' ? `MCP · ${item.mcp_request.tool_name}` : `${item.request.method} ${item.request.url}`), el('small', '', `v${item.edit_version} · ${item.type === 'command' ? (item.expected_exit_code === undefined ? '未设置退出码预期' : `预期退出码 ${item.expected_exit_code}`) : item.type === 'mcp' ? (item.expected_is_error === undefined ? '未设置工具结果预期' : `预期 isError=${item.expected_is_error}`) : item.expected_status ? `预期 ${item.expected_status}` : '未设置状态码预期'} · ${item.assertions.length} 条响应断言`));
    const actions = el('div', 'testing-actions'); for (const [name, action] of [['运行', () => openRunEditor([item.id])], ['编辑', () => openCaseEditor(item)], ['复制', () => openCaseEditor({ ...item, id: undefined, edit_version: 0, name: `${item.name}（副本）` })], ['移除', () => openArchiveEditor(item)]]) { const control = button(name, action, 'button small'); control.disabled = state.working; actions.append(control); }
    row.append(pick, info, actions); list.append(row);
  }
  if (!state.cases.length) list.append(blank('把稳定的测试保存下来', '每组入参对应一个具名用例。可以新建，也可以从测试批次中的执行记录另存。'));
  panel.append(list); return panel;
}
async function selectBatch(id, tab = 'records') {
  const selection = ++state.selection;
  try { const batch = await api(`/test-batches/${encodeURIComponent(id)}`); if (selection !== state.selection) return; state.batch = batch; state.paused = null; state.tab = tab; state.type = 'single'; state.filter = 'all'; state.signature = ''; render(); locationForBatch(); }
  catch (error) { notice(error.message); }
}
export async function refreshTesting() {
  if (isFlowView()) { await refreshFlows(); return; }
  if (state.loading) return; state.loading = true;
  const selection = state.selection; const id = state.batch?.id;
  try {
    const results = await Promise.allSettled([api('/test-batches'), api('/test-cases'), id ? api(`/test-batches/${id}`) : Promise.resolve(null)]);
    let error = ''; results.forEach(result => { if (result.status === 'rejected') error = result.reason.message; });
    if (results[0].status === 'fulfilled') state.batches = results[0].value;
    if (results[1].status === 'fulfilled') { state.cases = results[1].value; const ids = new Set(state.cases.map(item => item.id)); state.picked = new Set([...state.picked].filter(value => ids.has(value))); }
    if (selection === state.selection && results[2].status === 'fulfilled' && results[2].value) state.batch = results[2].value;
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
function openCaseTypeChooser() {
  const d = dialog('新建测试用例');
  d.content.append(el('p', '', '选择要验证的调用类型。'));
  const choices = el('div', 'testing-case-choices');
  for (const [name, description, open] of [
    ['HTTP 请求', '验证接口入参与响应', () => openCaseEditor()],
    ['MCP 工具', '验证工具参数与返回结果', () => openMCPCaseEditor(null, { onSaved: async id => { if (id) await selectBatch(id); await refreshTesting(); } })],
    ['命令行', '验证程序退出码与输出', () => openCommandCaseEditor(null, { onSaved: async id => { if (id) await selectBatch(id); await refreshTesting(); } })],
  ]) {
    const choice = button('', () => { d.element.close(); open(); }, 'testing-case-choice');
    choice.append(el('strong', '', name), el('small', '', description)); choices.append(choice);
  }
  d.content.append(choices);
}
function openBatchEditor() {
  const d = dialog('新建测试批次'); const name = field('批次名称', '', 'input'); name.input.required = true; name.input.placeholder = '例如：用户接口参数校验'; d.content.append(name.wrap); const save = button('创建批次', () => d.form.requestSubmit(), 'button primary'); d.actions.append(save);
  d.form.addEventListener('submit', async event => { event.preventDefault(); lockDialog(d, true); d.showError(''); try { const batch = await api('/test-batches', { method: 'POST', body: { name: name.input.value } }); editorDirty = false; d.element.close(); await selectBatch(batch.id, 'batches'); await refreshTesting(); } catch (error) { d.showError(error.message); } finally { lockDialog(d, false); } }); name.input.focus();
}
function headersObject(request) { return Object.fromEntries((request.headers || []).filter(item => item.enabled).map(item => [item.name, item.value])); }
function openCaseEditor(item = null, temporary = false) {
  if (item?.type === 'command') return openCommandCaseEditor(item, { batchID: temporary && state.batch?.status === 'running' ? state.batch.id : undefined, onSaved: async id => { if (id) await selectBatch(id); await refreshTesting(); } });
  if (item?.type === 'mcp') return openMCPCaseEditor(item, { batchID: temporary && state.batch?.status === 'running' ? state.batch.id : undefined, onSaved: async id => { if (id) await selectBatch(id); await refreshTesting(); } });
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
        const batch = state.batch?.status === 'running' ? state.batch : await api('/test-batches', { method: 'POST', body: { name: value.name } });
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
  const target = field('运行到', '', 'select'); target.input.add(new Option('新建测试批次', 'new')); for (const batch of state.batches.filter(item => item.status === 'running')) target.input.add(new Option(batch.name, batch.id));
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
function openArchiveEditor(item) { const d = dialog('移除保存的用例'); d.content.append(el('p', '', `移除“${item.name}”？已有测试记录和断言结果会保留。`)); d.actions.append(button('取消', () => d.element.close()), button('移除用例', async () => { lockDialog(d, true); try { await api(`/test-cases/${item.id}`, { method: 'DELETE' }); d.element.close(); await refreshTesting(); } catch (error) { d.showError(error.message); } finally { lockDialog(d, false); } }, 'button danger')); }
export async function activateTesting() {
  const revision = ++state.viewRevision; state.selection++;
  targetStep = new URLSearchParams(location.search).get('step') || '';
  if (targetStep) { state.open.add(targetStep); state.filter = 'all'; }
  state.active = true; mount(); readRoute(); state.signature = ''; render();
  const query = new URLSearchParams(location.search);
  if (!isFlowView() && query.get('batch') && query.get('batch') !== state.batch?.id) await selectBatch(query.get('batch'), state.tab);
  if (revision !== state.viewRevision || !state.active) return;
  await showView(); clearTimeout(state.timer);
  if (revision !== state.viewRevision || !state.active) return;
  if (targetStep && !isFlowView()) revealExecutionStep(`test-attempt-${targetStep}`);
  const poll = async () => { if (!state.active) return; if (!isFlowView()) await refreshTesting(); if (state.active) state.timer = setTimeout(poll, 1500); }; state.timer = setTimeout(poll, 1500);
}
export function deactivateTesting() { state.active = false; state.viewRevision++; state.selection++; clearTimeout(state.timer); deactivateFlows(); }
window.addEventListener('testing-flow-location', () => { if (state.active) { readRoute(); state.signature = ''; render(); } });
window.addEventListener('beforeunload', event => { if (editorDirty && editor?.open) { event.preventDefault(); event.returnValue = ''; } });
