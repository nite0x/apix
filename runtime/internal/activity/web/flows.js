import { availableOutputs, copyFlowSteps, failurePolicy, isFinally, orderedSteps, outputReference, sourceChoices, activeStatus, blankStep, display, endpoint, requestURL, statusNames, uniqueName, validateDefinition } from './flow-model.js';
import { openRequestDetail } from './request-detail.js';
import { revealExecutionStep } from './execution-batch.js';

const root = document.getElementById('flow-workspace');
const state = { flows: [], flow: null, run: null, history: [], recordFlow: '', recordHistory: [], databases: [], services: [], open: new Set(), tabs: new Map(), rail: 'variables', mode: 'edit', dirty: false, revision: 0, saving: null, saveTimer: null, pollTimer: null, visible: false, loading: false, starting: false, error: '', notice: '', apiRuns: new Map(), apiErrors: new Set(), pollBusy: false };
let selection = 0;
let recordSelection = 0;
let dialog = null;
let targetStep = '';

function el(tag, cls, text) { const element = document.createElement(tag); if (cls) element.className = cls; if (text !== undefined) element.textContent = String(text); return element; }
function button(text, cls, action, label) { const item = el('button', cls || 'button', text); item.type = 'button'; if (label) item.setAttribute('aria-label', label); item.addEventListener('click', action); return item; }
function input(value, label, change, options = {}) {
  const field = el(options.multiline ? 'textarea' : 'input', 'fw-input');
  field.value = value ?? ''; field.setAttribute('aria-label', label); if (!options.multiline) field.type = options.type || 'text';
  field.placeholder = options.placeholder || ''; if (options.rows) field.rows = options.rows;
  if (options.max) field.maxLength = options.max;
  if (/请求地址|请求正文|SQL 参数|期望值|查询参数值|请求头值/.test(label)) {
    field.dataset.outputTarget = '';
    field.addEventListener('focus', () => { state.outputTarget = field; });
  }
  field.addEventListener('input', () => change(field.value, field)); return field;
}
function field(label, control, hint) { const wrap = el('label', 'fw-field'); wrap.append(el('span', 'fw-label', label), control); if (hint) wrap.append(el('small', 'fw-hint', hint)); return wrap; }
function select(value, label, choices, change) { const item = el('select', 'fw-input'); item.setAttribute('aria-label', label); for (const [key, name] of choices) item.add(new Option(name, key)); item.value = value ?? ''; item.addEventListener('change', () => change(item.value)); return item; }
function check(text, value, change) { const item = el('label', 'fw-check'); const box = el('input'); box.type = 'checkbox'; box.checked = value; box.addEventListener('change', () => change(box.checked)); item.append(box, document.createTextNode(text)); return item; }
function code(value) { return el('pre', 'fw-code', display(value)); }
function blank(title, description) { const item = el('div', 'fw-empty'); item.append(el('span', 'fw-empty-icon', '⌘'), el('h3', '', title), el('p', '', description)); return item; }
function section(title, description) { const item = el('section', 'fw-section'); item.append(el('h4', '', title)); if (description) item.append(el('p', 'fw-hint', description)); return item; }
function setError(message) { state.error = message; const target = root.querySelector('[data-flow-message]'); if (target) { target.textContent = message; target.hidden = !message; } }
function recordsView() { return new URLSearchParams(location.search).get('tab') === 'records'; }
function setLocation() {
  if (!state.visible) return;
  const query = new URLSearchParams({ tab: state.flow ? state.mode === 'run' ? 'records' : 'cases' : recordsView() ? 'records' : 'cases', type: 'flow' });
  if (state.flow) query.set('id', state.flow.id);
  if (state.run && state.mode === 'run') query.set('run', state.run.id);
  if (state.mode === 'run' && targetStep && state.run?.steps?.some(step => step.id === targetStep)) query.set('step', targetStep);
  const path = location.pathname === '/test-collections' ? '/test-collections' : '/tests';
  history.replaceState(null, '', `${path}?${query}`);
  window.dispatchEvent(new window.Event('testing-flow-location'));
}
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { cache: 'no-store', signal: AbortSignal.timeout(15000), ...options, ...(options.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}) });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return result;
}
function errorText(error) { return error.name === 'TimeoutError' || error instanceof TypeError ? '暂时无法确认操作结果，请检查 Runtime 连接后刷新重试。' : error.message; }
function saveLabel() { const label = root.querySelector('[data-save-state]'); if (label) { label.textContent = state.saving ? '正在保存' : state.dirty ? '有未保存的修改' : '所有更改已保存'; label.className = `fw-save-state${state.dirty ? ' dirty' : ''}`; } }
function changed(render = false) {
  state.dirty = true; state.revision++; setError(''); clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => { if (!validateDefinition(state.flow)) void saveFlow(); }, 900);
  if (render) renderWorkspace(); else saveLabel();
}
async function saveFlow() {
  clearTimeout(state.saveTimer);
  const invalid = root.querySelector('input:invalid, textarea:invalid');
  if (invalid) { setError(invalid.validationMessage); invalid.reportValidity(); return false; }
  if (!state.flow || !state.dirty) return true;
  if (state.saving) return state.saving;
  const validation = validateDefinition(state.flow); if (validation) { setError(validation); return false; }
  const promise = (async () => {
    try {
      while (state.dirty) {
        const issue = validateDefinition(state.flow); if (issue) { setError(issue); return false; }
        const version = state.revision;
        state.flow.steps = orderedSteps(state.flow.steps); state.flow.steps.forEach((step, index) => { step.position = index; });
        const saved = await api(`/flows/${encodeURIComponent(state.flow.id)}`, { method: 'PUT', body: structuredClone(state.flow) });
        if (state.revision === version) { state.flow.edit_version = saved.edit_version; state.flow.updated_at = saved.updated_at; state.dirty = false; }
        else state.flow.edit_version = saved.edit_version;
        state.flows = state.flows.map(item => item.id === saved.id ? { ...item, name: saved.name, step_count: saved.steps.length, edit_version: saved.edit_version, updated_at: saved.updated_at } : item);
      }
      setError(''); return true;
    } catch (error) {
      setError(error.status === 409 ? '此流程在其他位置发生了变更。你的编辑已保留，可点击“另存副本”保存当前内容。' : `保存失败：${errorText(error)}`);
      return false;
    }
  })();
  state.saving = promise; saveLabel();
  try { return await promise; } finally { state.saving = null; saveLabel(); }
}
export async function leaveFlows() { return !state.dirty || await saveFlow(); }
export function deactivateFlows() { state.visible = false; selection++; clearTimeout(state.pollTimer); if (dialog?.open && !state.starting) dialog.close(); }
export async function activateFlows() {
  state.visible = true;
  targetStep = new URLSearchParams(location.search).get('step') || '';
  if (targetStep) state.open.add(targetStep);
  const query = new URLSearchParams(location.search); const id = query.get('id'); const run = query.get('run');
  if (id && state.flow?.id !== id) { await openFlow(id, run); return; }
  if (id && run && state.run?.id !== run) { await openRun(run); return; }
  if (id && run && state.run?.id === run) state.mode = 'run';
  if (!id && state.flow) { if (!(await leaveFlows())) { setLocation(); renderWorkspace(); return; } state.flow = null; state.run = null; }
  if (id && !run && state.mode === 'run') { state.mode = 'edit'; renderWorkspace(); }
  await refreshFlows(); if (state.run && activeStatus(state.run.status)) schedulePoll();
  if (state.visible && targetStep) revealExecutionStep(`flow-run-step-${targetStep}`);
}
export async function refreshFlows() {
  if (state.loading) return; state.loading = true;
  const token = selection;
  try {
    state.flows = await api('/flows') || [];
    if (token !== selection) return;
    if (!state.flow && recordsView()) {
      if (!state.flows.some(flow => flow.id === state.recordFlow)) state.recordFlow = state.flows[0]?.id || '';
      await refreshRecordHistory();
      if (token !== selection) return;
    }
    if (state.flow && state.mode === 'run' && state.run) { await pollRun(); }
    else if (!state.dirty && !state.saving && state.flow) {
      const id = state.flow.id, revision = state.revision;
      const current = await api(`/flows/${encodeURIComponent(id)}`);
      if (token === selection && state.flow?.id === id && revision === state.revision && !state.dirty) state.flow = current;
    }
    if (state.error.startsWith('读取流程失败：')) state.error = '';
    if (state.visible) renderWorkspace();
  } catch (error) { state.error = `读取流程失败：${errorText(error)}`; if (state.visible) renderWorkspace(); }
  finally { state.loading = false; }
}
async function openFlow(id, runID) {
  if (!(await leaveFlows())) return;
  const token = ++selection;
  try {
    const flow = await api(`/flows/${encodeURIComponent(id)}`); if (token !== selection) return;
    state.flow = flow; state.run = null; state.dirty = false; state.revision = 0; state.error = ''; state.mode = 'edit'; state.open.clear(); state.tabs.clear();
    setLocation(); renderWorkspace();
    void loadContext(id);
    if (runID) await openRun(runID);
  } catch (error) { setError(`无法打开流程：${errorText(error)}`); }
}
async function loadContext(id) {
  const items = await Promise.allSettled([api(`/flows/${encodeURIComponent(id)}/runs`), api('/database/connections'), api('/services')]);
  if (state.flow?.id !== id) return;
  if (items[0].status === 'fulfilled') state.history = items[0].value || [];
  if (items[1].status === 'fulfilled') state.databases = items[1].value || [];
  if (items[2].status === 'fulfilled') state.services = items[2].value || [];
  for (const control of root.querySelectorAll('select[aria-label="数据库连接"]')) { const value = control.value; control.replaceChildren(new Option('请选择已配置的连接', ''), ...state.databases.map(item => new Option(item.name, item.id))); control.value = value; }
  for (const control of root.querySelectorAll('select[aria-label="本地服务"]')) { const value = control.value; control.replaceChildren(new Option('请选择已配置的服务', ''), ...state.services.map(item => new Option(item.name, item.id))); control.value = value; }
  renderRail();
}
function showDialog(title, description, content, submitText, submit) {
  if (dialog) { dialog.close(); dialog.remove(); }
  dialog = el('dialog', 'fw-dialog'); dialog.setAttribute('aria-labelledby', 'flow-dialog-title');
  const currentDialog = dialog;
  currentDialog.addEventListener('close', () => { currentDialog.querySelector('form')?.reset(); currentDialog.remove(); });
  const form = el('form'); const head = el('div', 'fw-dialog-head'); head.append(el('span', 'eyebrow', 'FLOW STUDIO'), el('h2', '', title)); head.lastChild.id = 'flow-dialog-title'; if (description) head.append(el('p', 'fw-hint', description));
  const body = el('div', 'fw-dialog-body'); body.append(content);
  const error = el('div', 'fw-message'); error.setAttribute('role', 'alert'); error.hidden = true;
  const actions = el('div', 'fw-dialog-actions'); const cancel = button('取消', 'button', () => dialog.close()); const confirm = el('button', 'button primary', submitText); confirm.type = 'submit'; actions.append(cancel, confirm);
  form.append(head, body, error, actions); dialog.append(form); document.body.append(dialog);
  let busy = false;
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; busy = true; confirm.disabled = cancel.disabled = true;
    try { await submit(); dialog.close(); }
    catch (issue) { error.textContent = errorText(issue); error.hidden = false; }
    finally { busy = false; confirm.disabled = cancel.disabled = false; }
  });
  dialog.showModal(); content.querySelector('input')?.focus();
}
function createFlow() {
  let name = ''; const content = field('流程名称', input('', '新流程名称', value => { name = value; }, { placeholder: '例如：订单创建与查询', max: 120 }));
  showDialog('从一个业务场景开始', '将准备、请求与验证串成可重复执行的测试。', content, '创建流程', async () => {
    if (!name.trim()) throw new Error('请为流程起一个名字。');
    if (!(await leaveFlows())) throw new Error('请先保存当前流程。');
    const created = await api('/flows', { method: 'POST', body: { name: name.trim() } }); state.flows.unshift({ ...created, step_count: 0 }); await openFlow(created.id);
  });
}
async function saveCopy() {
  const validation = validateDefinition(state.flow); if (validation) { setError(validation); return; }
  try {
    const copy = await api('/flows', { method: 'POST', body: { name: `${state.flow.name.slice(0, 114)} · 副本` } });
    const saved = await api(`/flows/${encodeURIComponent(copy.id)}`, { method: 'PUT', body: { ...structuredClone(state.flow), id: copy.id, edit_version: copy.edit_version, name: copy.name, steps: copyFlowSteps(state.flow.steps) } });
    state.dirty = false; state.flows.unshift({ ...saved, step_count: saved.steps.length }); await openFlow(saved.id);
  } catch (error) { setError(`另存失败：${errorText(error)}`); }
}
function addStep(type, phase = '') { const step = blankStep(type); if (phase) step.config.phase = phase; state.flow.steps.push(step); state.open.add(step.id); state.tabs.set(step.id, 'request'); changed(true); root.querySelector(`[data-step="${step.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
function renderWorkspace() {
  const fragment = document.createDocumentFragment(); const error = el('div', 'fw-message', state.error); error.dataset.flowMessage = ''; error.hidden = !state.error; error.setAttribute('role', 'alert'); fragment.append(error);
  if (!state.flow) { if (recordsView()) renderRecordLibrary(fragment); else renderLibrary(fragment); root.replaceChildren(fragment); return; }
  const flow = state.flow;
  const toolbar = el('div', 'fw-toolbar');
  const title = el('div', 'fw-title-group');
  title.append(button(state.mode === 'run' ? '← 执行记录' : '← 全部用例', 'fw-back', async () => { if (!(await leaveFlows())) return; state.flow = null; state.run = null; state.error = ''; setLocation(); await refreshFlows(); }), input(state.mode === 'run' ? state.run.flow_name_snapshot : flow.name, '流程名称', value => { flow.name = value; changed(); }, { max: 120 }));
  title.querySelector('input').readOnly = state.mode === 'run';
  const actions = el('div', 'fw-toolbar-actions'); const save = el('span', 'fw-save-state'); save.dataset.saveState = '';
  actions.append(save, button('另存副本', 'button small', saveCopy), button('保存', 'button small', () => void saveFlow()), button(state.starting ? '准备运行…' : '▶ 运行流程', 'button primary', runFlow)); actions.lastChild.disabled = state.starting;
  toolbar.append(title, actions); fragment.append(toolbar);
  const workspace = el('div', 'fw-studio'); const canvas = el('div', 'fw-canvas');
  const modebar = el('div', 'fw-modebar'); const modes = el('div', 'fw-segment');
  modes.append(button('流程编排', state.mode === 'edit' ? 'selected' : '', () => { state.mode = 'edit'; setLocation(); renderWorkspace(); }), button('执行结果', state.mode === 'run' ? 'selected' : '', () => { if (!state.run) { state.rail = 'history'; renderRail(); return; } state.mode = 'run'; setLocation(); renderWorkspace(); }));
  modebar.append(modes, el('span', 'fw-hint', state.mode === 'edit' ? '顺序执行 · 修改自动保存' : state.run ? `定义快照 v${state.run.flow_version}` : '从右侧选择运行记录')); canvas.append(modebar);
  if (state.mode === 'run' && state.run) renderRun(canvas); else renderSteps(canvas);
  const rail = el('aside', 'fw-rail'); rail.setAttribute('aria-label', '流程上下文'); rail.dataset.flowRail = ''; workspace.append(canvas, rail); fragment.append(workspace); root.replaceChildren(fragment); saveLabel(); renderRail();
}
function renderLibrary(fragment) {
  const header = el('div', 'fw-library-heading'); header.append(el('div', '', `${state.flows.length} 个多步用例`), button('＋ 新建多步用例', 'button primary', createFlow)); fragment.append(header);
  const grid = el('div', 'fw-library');
  for (const flow of state.flows) {
    const card = button('', 'fw-library-card', () => void openFlow(flow.id));
    const top = el('div', 'fw-library-card-top'); top.append(el('span', 'fw-library-icon', '⌘'), el('span', 'fw-hint', `${flow.step_count} STEPS`));
    card.append(top, el('h3', '', flow.name), el('p', 'fw-hint', flow.description || '准备数据，执行请求，验证每一个预期。'));
    const foot = el('div', 'fw-library-card-foot'); foot.append(el('span', '', new Date(flow.updated_at).toLocaleDateString('zh-CN')), el('span', '', '编辑用例 ↗')); card.append(foot); grid.append(card);
  }
  if (!state.flows.length) {
    const empty = blank('把业务场景保存为多步用例', '添加步骤卡片，让前一步的结果成为下一步的输入。每次运行都会留下独立的测试记录。');
    const preview = el('div', 'fw-preview'); for (const [index, text] of ['准备数据', '发送请求', '校验结果'].entries()) { const item = el('span'); item.append(el('b', '', `0${index + 1}`), document.createTextNode(text)); preview.append(item); }
    empty.append(preview, button('创建第一个多步用例', 'button primary', createFlow)); grid.append(empty);
  }
  fragment.append(grid);
}
async function refreshRecordHistory() {
  const token = ++recordSelection, id = state.recordFlow;
  const runs = id ? await api(`/flows/${encodeURIComponent(id)}/runs?limit=100`) : [];
  if (token === recordSelection && state.recordFlow === id) state.recordHistory = runs || [];
}
function renderRecordLibrary(fragment) {
  const panel = el('section', 'panel');
  const heading = el('div', 'panel-heading'); heading.append(el('h2', '', '多步用例执行记录'));
  if (state.flows.length) heading.append(field('选择多步用例', select(state.recordFlow, '选择多步用例执行记录', state.flows.map(flow => [flow.id, flow.name]), value => {
    state.recordFlow = value; state.recordHistory = []; renderWorkspace();
    void refreshRecordHistory().then(() => { setError(''); if (state.visible && !state.flow && recordsView()) renderWorkspace(); }).catch(error => setError(`读取流程失败：${errorText(error)}`));
  })));
  panel.append(heading);
  const list = el('div', 'testing-flow-records');
  for (const run of state.recordHistory) {
    const row = el('div', 'test-case-row'); const info = el('div', 'test-case-info');
    info.append(el('strong', '', run.flow_name_snapshot), el('small', '', `${new Date(run.created_at).toLocaleString('zh-CN')} · v${run.flow_version} · ${run.total_steps} 个步骤 · #${run.id.slice(0, 8)}`));
    const flowID = state.recordFlow;
    row.append(info, el('span', `fw-status ${run.status}`, statusNames[run.status] || run.status), button('查看执行结果', 'button small', () => void openFlow(flowID, run.id)));
    list.append(row);
  }
  if (!state.recordHistory.length) list.append(blank('还没有执行记录', state.flows.length ? '所选多步用例尚无运行记录，可在“测试用例”中打开并运行。' : '先在“测试用例”中创建并运行一个多步用例。'));
  panel.append(list, el('p', 'testing-record-note', '展示所选多步用例最近 100 次运行。')); fragment.append(panel);
}
function renderSteps(canvas) {
  const flow = state.flow; flow.steps = orderedSteps(flow.steps); flow.steps.forEach((step, index) => { step.position = index; }); const start = el('div', 'fw-boundary'); start.append(el('span', 'fw-boundary-dot'), el('strong', '', '流程输入'), button(`${flow.variables.length} 个共享变量 ↗`, 'fw-text-button', () => { state.rail = 'variables'; renderRail(); })); canvas.append(start);
  for (const phase of ['', 'finally']) {
    const group = el('section', 'fw-phase' + (phase ? ' fw-finally' : '')); group.setAttribute('aria-label', phase ? '收尾步骤' : '执行步骤');
    group.append(el('h3', 'fw-phase-title', phase ? '收尾步骤' : '执行步骤'));
    if (phase) group.append(el('p', 'fw-hint', '成功、失败或取消后都尝试执行；一项失败仍继续其他收尾。收尾区总时限 30 秒，之后释放本次启动的服务。'));
    const track = el('div', 'fw-track');
    const groupSteps = flow.steps.filter(step => isFinally(step) === Boolean(phase));
    groupSteps.forEach((step, groupIndex) => {
      const index = flow.steps.indexOf(step);
      const card = el('article', `fw-step${step.enabled ? '' : ' disabled'}`); card.dataset.step = step.id;
      const head = el('div', 'fw-step-heading'); const toggle = button('', 'fw-step-toggle', () => { if (state.open.has(step.id)) state.open.delete(step.id); else state.open.add(step.id); renderWorkspace(); }); toggle.setAttribute('aria-expanded', String(state.open.has(step.id)));
      const summary = el('div', 'fw-step-summary'); const upper = el('div', 'fw-step-summary-top'); upper.append(el('span', `fw-type ${step.type}`, step.type === 'http' ? step.request.method : step.type.toUpperCase()), el('strong', '', step.name || '未命名步骤'));
      const detail = el('span', 'fw-step-endpoint', endpoint(step)); summary.append(upper, detail);
      toggle.append(el('span', 'fw-step-index', String(index + 1).padStart(2, '0')), summary, el('span', 'fw-chevron', state.open.has(step.id) ? '−' : '+'));
      const ops = el('div', 'fw-step-ops');
      ops.append(check('启用', step.enabled, value => { step.enabled = value; changed(true); }));
      const up = button('↑', 'fw-icon-button', () => { const other = flow.steps.indexOf(groupSteps[groupIndex - 1]); [flow.steps[other], flow.steps[index]] = [flow.steps[index], flow.steps[other]]; changed(true); }, `上移步骤 ${index + 1}`); up.disabled = groupIndex === 0;
      const down = button('↓', 'fw-icon-button', () => { const other = flow.steps.indexOf(groupSteps[groupIndex + 1]); [flow.steps[other], flow.steps[index]] = [flow.steps[index], flow.steps[other]]; changed(true); }, `下移步骤 ${index + 1}`); down.disabled = groupIndex === groupSteps.length - 1;
      ops.append(up, down, button('⧉', 'fw-icon-button', () => { const copy = structuredClone(step); copy.id = crypto.randomUUID(); copy.name = `${step.name} · 副本`; flow.steps.splice(index + 1, 0, copy); changed(true); }, `复制步骤 ${index + 1}`), button('×', 'fw-icon-button', () => { flow.steps.splice(index, 1); changed(true); }, `删除步骤 ${index + 1}`)); ops.append(button(phase ? '移至执行' : '移至收尾', 'fw-text-button', () => {
        if (phase) { delete step.config.phase; delete step.config.skip_if_missing_outputs; }
        else step.config.phase = 'finally';
        changed(true);
      }, '切换步骤 ' + (index + 1) + ' 阶段'));
      head.append(toggle, ops); card.append(head);
      if (state.open.has(step.id)) {
        const body = el('div', 'fw-step-body'); body.append(field('步骤名称', input(step.name, `步骤 ${index + 1} 名称`, value => { step.name = value; upper.querySelector('strong').textContent = value || '未命名步骤'; changed(); })));
        const tabs = el('div', 'fw-card-tabs'); const content = el('div'); const selected = state.tabs.get(step.id) || 'request';
        const choices = [['request', step.type === 'http' ? '请求配置' : step.type === 'sql' ? 'SQL 配置' : '服务配置'], ['assertions', `断言 ${(step.config.assertions || []).length + (step.config.expected_status != null || step.config.expected_rows != null ? 1 : 0)}`], ['extractors', `响应提取 ${(step.config.extractors || []).length}`]];
        tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', `步骤 ${index + 1} 配置`);
        for (const [id, label] of choices) { if (step.type === 'service' && (id === 'extractors' || id === 'assertions')) continue; const tab = button(label, selected === id ? 'active' : '', () => { state.tabs.set(step.id, id); renderWorkspace(); }); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(selected === id)); tabs.append(tab); }
        body.append(tabs, outputPicker(step), content);
        if (selected === 'assertions') renderAssertions(content, step); else if (selected === 'extractors') renderExtractors(content, step); else renderRequest(content, step, detail);
        const policy = el('div', 'fw-step-policy');
        if (phase) {
          policy.append(el('p', 'fw-hint', '收尾失败会单独记录，并继续其他收尾步骤。'), check('引用的步骤输出不存在时跳过', step.config.skip_if_missing_outputs || false, value => { step.config.skip_if_missing_outputs = value; changed(); }));
        } else {
          policy.append(field('失败时', select(failurePolicy(step), '步骤 ' + (index + 1) + ' 失败策略', [['inherit', '遵循流程设置'], ['stop', '停止后续步骤'], ['continue', '继续后续步骤']], value => {
            if (value === 'inherit') delete step.config.failure_policy; else step.config.failure_policy = value;
            step.config.continue_on_error = false; changed();
          }), '继续执行会保留失败结论；显式收尾始终执行。'));
        }
        body.append(policy); card.append(body);
      } else { const meta = el('div', 'fw-step-meta'); meta.append(el('span', '', `${(step.config.assertions || []).length + (step.config.expected_status != null || step.config.expected_rows != null ? 1 : 0)} 项断言`), el('span', '', `${(step.config.extractors || []).length} 个输出变量`), el('span', '', phase ? '始终尝试收尾' : failurePolicy(step) === 'continue' ? '失败后继续' : failurePolicy(step) === 'stop' ? '失败后停止' : '遵循流程失败策略')); card.append(meta); }
      track.append(card);
    });
    const add = el('div', 'fw-add-step'); add.append(el('span', '', phase ? '＋ 添加收尾步骤' : '＋ 添加一个步骤'));
    for (const [type, label] of [['http', 'HTTP 请求'], ['sql', 'SQL 查询'], ['service', '服务准备']]) add.append(button(label, 'button small', () => addStep(type, phase), '添加' + (phase ? '收尾 ' : '执行 ') + label));
    track.append(add); group.append(track); canvas.append(group);
  }
  const end = el('div', 'fw-boundary end'); end.append(el('span', 'fw-boundary-dot'), el('span', '', '流程结束'), el('span', 'fw-hint', '汇总断言结果 · 保存运行记录')); canvas.append(end);
}
function outputPicker(step) {
  const area = el('div', 'fw-output-picker');
  const choices = availableOutputs(state.flow.steps, step);
  const control = select('', '插入步骤输出 ' + step.id, [['', '插入步骤输出…'], ...choices], reference => {
    if (!reference) return;
    const target = state.outputTarget;
    const card = target?.closest('[data-step]');
    if (!target || !root.contains(target) || card?.dataset.step !== step.id) {
      setError('先点击此步骤的请求地址、正文、参数或期望值，再选择需要插入的输出。');
      control.value = ''; return;
    }
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.value = target.value.slice(0, start) + reference + target.value.slice(end);
    target.dispatchEvent(new window.Event('input', { bubbles: true }));
    target.focus(); target.setSelectionRange(start + reference.length, start + reference.length);
    control.value = '';
  });
  control.disabled = !choices.length;
  area.append(control, el('small', 'fw-hint', choices.length ? '先将光标放在输入位置，再选择前面步骤的输出。' : '前面的步骤配置输出后，可在这里插入引用。'));
  return area;
}

function keyValueEditor(container, title, pairs, onChange) {
  const area = section(title); pairs.forEach((pair, index) => {
    const row = el('div', 'fw-kv-row'); row.append(check('启用', pair.enabled, value => { pair.enabled = value; changed(); }), input(pair.name, `${title}名称 ${index + 1}`, value => { pair.name = value; changed(); }, { placeholder: '名称' }), input(pair.value, `${title}值 ${index + 1}`, value => { pair.value = value; changed(); }, { placeholder: '值，支持 {{变量}}' }), button('×', 'fw-icon-button', () => { pairs.splice(index, 1); changed(true); }, `删除${title} ${index + 1}`)); area.append(row);
  }); area.append(button(`＋ 添加${title}`, 'fw-text-button', () => { pairs.push({ name: '', value: '', enabled: true }); onChange(pairs); changed(true); })); container.append(area);
}
function renderRequest(container, step, summary) {
  if (step.type === 'http') {
    const request = step.request; const urlrow = el('div', 'fw-url-row'); urlrow.append(select(request.method, '请求方法', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(value => [value, value]), value => { request.method = value; changed(true); }), input(request.url, '请求地址', value => { request.url = value; summary.textContent = value || '配置请求地址'; changed(); }, { placeholder: 'https://api.example.com 或 {{base_url}}/path' })); container.append(urlrow);
    keyValueEditor(container, '查询参数', request.query_params || (request.query_params = []), value => { request.query_params = value; });
    keyValueEditor(container, '请求头', request.headers || (request.headers = []), value => { request.headers = value; });
    const body = section('请求正文'); body.append(select(request.body_type, '正文类型', [['none', '无正文'], ['json', 'JSON'], ['text', 'Text'], ['form', 'Form URL Encoded']], value => { request.body_type = value; changed(true); }));
    if (request.body_type !== 'none') body.append(input(request.body, '请求正文', value => { request.body = value; changed(); }, { multiline: true, rows: 6, placeholder: '{ "user_id": "{{user_id}}" }' })); container.append(body);
  } else if (step.type === 'sql') {
    const sql = step.sql;
    const databaseType = state.databases.find(item => item.id === sql.connection_id)?.type || 'mysql';
    const positional = databaseType === 'postgresql' || databaseType === 'hologres';
    container.append(field('数据库连接', select(sql.connection_id, '数据库连接', [['', '请选择已配置的连接'], ...state.databases.map(item => [item.id, `${item.name} · ${item.type || 'mysql'}`])], value => { sql.connection_id = value; changed(true); })), field('操作类型', select(sql.mode, 'SQL 操作类型', [['query', '查询'], ['exec', '执行语句']], value => { sql.mode = value; delete step.config.expected_rows; step.config.assertions = []; step.config.extractors = []; changed(true); })), field('SQL 语句', input(sql.sql, 'SQL 语句', value => { sql.sql = value; summary.textContent = value; changed(); }, { multiline: true, rows: 5, placeholder: positional ? 'SELECT * FROM orders WHERE id = $1' : 'SELECT * FROM orders WHERE id = ?' })));
    container.append(el('p', 'fw-hint', positional ? 'PostgreSQL / Hologres 使用 $1、$2 等占位符，参数按顺序绑定。' : 'MySQL 使用 ? 占位符，参数按顺序绑定。'));
    const params = input(JSON.stringify(sql.params || []), 'SQL 参数', (value, control) => { try { const values = JSON.parse(value); if (!Array.isArray(values)) throw new Error(); sql.params = values; control.setCustomValidity(''); changed(); } catch { control.setCustomValidity('参数必须是 JSON 数组'); setError('SQL 参数必须是 JSON 数组，尚未保存此输入。'); } }, { placeholder: '["{{order_id}}"]' }); container.append(field('绑定参数', params, '使用 JSON 数组；变量作为完整参数传入，例如 ["{{order_id}}"]。'));
    if (!state.databases.length) container.append(el('p', 'fw-hint', '先在“数据库”页面配置连接，然后刷新此流程。'));
  } else {
    container.append(field('本地服务', select(step.service.service_id, '本地服务', [['', '请选择已配置的服务'], ...state.services.map(item => [item.id, item.name])], value => { step.service.service_id = value; changed(); })), field('服务操作', select(step.service.action, '服务操作', [['start', '启动或复用服务'], ['stop', '停止本流程启动的服务']], value => { step.service.action = value; changed(true); })), el('p', 'fw-hint', '优先复用健康服务；流程结束后，Runtime 会清理本次流程启动的服务。'));
  }
}

const operators = [['equals', '等于'], ['not_equals', '不等于'], ['contains', '包含'], ['exists', '存在']];
function renderAssertions(container, step) {
  const config = step.config; const area = section('定义通过的条件', '全部断言通过，才算这个步骤通过。响应字段按文本比较，缺失字段始终判为失败。');
  const property = step.type === 'sql' ? 'expected_rows' : 'expected_status';
  if (step.type === 'http' || step.sql?.mode === 'query') {
    area.append(check(step.type === 'sql' ? '校验查询行数' : '校验 HTTP 状态码', config[property] != null, checked => { if (checked) config[property] = step.type === 'sql' ? 1 : 200; else delete config[property]; changed(true); }));
    if (config[property] != null) {
      const value = input(config[property], step.type === 'sql' ? '期望行数' : '期望状态码', (value, control) => { const number = Number(value); const min = step.type === 'sql' ? 0 : 100; const max = step.type === 'sql' ? Number.MAX_SAFE_INTEGER : 599; if (!value || !Number.isInteger(number) || number < min || number > max) { control.setCustomValidity('请输入有效范围内的整数'); setError(step.type === 'sql' ? '期望行数需要非负整数。' : 'HTTP 状态码范围为 100–599。'); return; } control.setCustomValidity(''); config[property] = number; changed(); }, { type: 'number' }); area.append(value);
    }
  }
  if (step.type === 'http' || step.type === 'sql') {
    (config.assertions || []).forEach((assertion, index) => {
      const row = el('div', 'fw-rule'); row.append(el('span', 'fw-rule-index', `CHECK ${index + 1}`));
      const grid = el('div', 'fw-rule-grid'); grid.append(field('来源', select(assertion.source, `断言 ${index + 1} 来源`, sourceChoices(step), value => { assertion.source = value; assertion.path = ''; changed(true); })));
      if (['body', 'header', 'rows'].includes(assertion.source)) grid.append(field(assertion.source === 'header' ? '响应头名称' : '字段路径', input(assertion.path, `断言 ${index + 1} 路径`, value => { assertion.path = value; changed(); }, { placeholder: assertion.source === 'rows' ? '0.name · 第 1 行的 name 字段' : assertion.source === 'header' ? 'Content-Type' : 'data.id · 留空检查整个响应' })));
      grid.append(field('条件', select(assertion.operator, `断言 ${index + 1} 条件`, operators, value => { assertion.operator = value; changed(true); })));
      if (assertion.operator !== 'exists') grid.append(field('期望值', input(assertion.expected, `断言 ${index + 1} 期望值`, value => { assertion.expected = value; changed(); }, { placeholder: '按文本比较' })));
      row.append(grid, button('移除断言', 'fw-text-button muted', () => { config.assertions.splice(index, 1); changed(true); })); area.append(row);
    }); area.append(button(step.type === 'sql' ? '＋ 添加字段断言' : '＋ 添加响应断言', 'button small', () => { (config.assertions ||= []).push({ source: sourceChoices(step)[0][0], path: '', operator: 'exists', expected: '' }); changed(true); }));
  }
  container.append(area);
}
function renderExtractors(container, step) {
  const area = section('让结果成为下一步的输入', step.type === 'sql' ? '查询字段使用 0.name 等路径；输出可通过步骤引用使用，也兼容原有共享变量。' : '字段路径示例：data.token、items.0.id；输出可通过步骤引用使用，也兼容原有共享变量。');
  (step.config.extractors || []).forEach((extractor, index) => {
    const row = el('div', 'fw-rule'); row.append(el('span', 'fw-rule-index', `OUTPUT ${index + 1}`)); const grid = el('div', 'fw-rule-grid');
    grid.append(field('保存为变量', input(extractor.name, `提取 ${index + 1} 变量名`, value => { extractor.name = value; changed(); renderRail(); }, { placeholder: '例如 token' })), field('提取来源', select(extractor.source, `提取 ${index + 1} 来源`, sourceChoices(step), value => { extractor.source = value; extractor.path = ''; changed(true); })));
    if (['body', 'header', 'rows'].includes(extractor.source)) grid.append(field('字段路径 / 响应头', input(extractor.path, `提取 ${index + 1} 路径`, value => { extractor.path = value; changed(); }, { placeholder: extractor.source === 'rows' ? '0.id' : extractor.source === 'header' ? 'X-Request-ID' : 'data.token' })));
    const options = el('div', 'fw-rule-options'); options.append(check('必须提取成功', extractor.required, value => { extractor.required = value; changed(); }), check('敏感值', extractor.secret, value => { extractor.secret = value; changed(); }), button('移除提取', 'fw-text-button muted', () => { step.config.extractors.splice(index, 1); changed(true); })); row.append(grid, options); area.append(row);
  }); area.append(button('＋ 添加提取规则', 'button small', () => { const items = step.config.extractors ||= []; items.push({ name: uniqueName(items, 'value'), source: sourceChoices(step)[0][0], path: '', scope: 'run', required: true, secret: false }); changed(true); })); container.append(area);
}
function renderRail() {
  const rail = root.querySelector('[data-flow-rail]'); if (!rail || !state.flow) return;
  const tabs = el('div', 'fw-rail-tabs');
  for (const [id, label] of [['variables', '变量'], ['history', '运行记录'], ['settings', '设置']]) { const tab = button(label, state.rail === id ? 'active' : '', () => { state.rail = id; renderRail(); if (id === 'history') void loadContext(state.flow.id); }); tab.setAttribute('aria-pressed', String(state.rail === id)); tabs.append(tab); }
  const content = el('div', 'fw-rail-content'); rail.replaceChildren(tabs, content);
  if (state.rail === 'variables' && state.mode === 'run') renderRunVariables(content);
  else if (state.rail === 'variables') renderVariables(content);
  else if (state.rail === 'history') renderHistory(content);
  else if (state.mode === 'run') content.append(el('p', 'fw-hint', '本次运行使用已保存的定义快照。切换到“流程编排”修改下一次运行的设置。'));
  else renderSettings(content);
}
function renderRunVariables(container) {
  const run = state.run; container.append(el('div', 'eyebrow', 'RUN CONTEXT'), el('h3', '', '本次运行的变量'), el('p', 'fw-hint', '按步骤顺序合并输入和提取结果。敏感值显示为遮罩；运行记录独立于当前流程定义。'));
  const values = new Map(Object.entries(run.variables || {}).map(([name, value]) => [name, { value, source: '流程默认值 / 运行输入' }]));
  for (const step of run.steps || []) for (const variable of step.result?.extracted_variables || []) values.set(variable.name, { value: variable.secret ? '••••••' : variable.value, source: step.name_snapshot });
  if (!values.size) container.append(el('p', 'fw-hint', '尚无输入或提取结果。'));
  for (const [name, variable] of values) { const pair = el('div', 'fw-run-variable'); pair.append(el('code', '', name), el('div', '', variable.value), el('small', '', `来源 · ${variable.source}`)); container.append(pair); }
  const info = el('div', 'fw-context-note'); info.append(el('strong', '', `定义版本 v${run.flow_version}`), el('p', '', `运行 ID · ${run.id}`)); container.append(info);
}
function renderVariables(container) {
  const title = el('div', 'fw-rail-heading'); title.append(el('span', 'eyebrow', 'FLOW VARIABLES'), el('h3', '', '在步骤之间共享数据')); container.append(title, el('p', 'fw-hint', '定义初始值，或由响应提取生成。每次运行独立，使用 {{变量名}} 引用。'));
  state.flow.variables.forEach((variable, index) => {
    const card = el('div', 'fw-variable');
    card.append(field('变量名', input(variable.name, `变量 ${index + 1} 名称`, value => { variable.name = value; changed(); })), field(variable.secret ? '运行时输入' : '默认值', input(variable.secret ? '' : variable.default_value, `变量 ${index + 1} 默认值`, value => { variable.default_value = value; changed(); }, { placeholder: variable.secret ? '敏感值仅在运行前输入' : '初始值，可在运行前覆盖' })));
    if (variable.secret) card.querySelectorAll('input')[1].disabled = true;
    card.append(field('说明', input(variable.description, `变量 ${index + 1} 说明`, value => { variable.description = value; changed(); }, { placeholder: '这个变量用来做什么' })));
    const options = el('div', 'fw-rule-options'); options.append(check('运行前必填', variable.required, value => { variable.required = value; changed(); }), check('敏感', variable.secret, value => { variable.secret = value; if (value) variable.default_value = ''; changed(true); }), button('删除', 'fw-text-button muted', () => { state.flow.variables.splice(index, 1); changed(true); })); card.append(options); container.append(card);
  });
  container.append(button('＋ 添加流程变量', 'button small fw-wide', () => { state.flow.variables.push({ name: uniqueName(state.flow.variables, 'var'), default_value: '', required: false, secret: false, description: '' }); changed(true); }));
  const outputs = state.flow.steps.flatMap(step => (step.config.extractors || []).map(item => ({ ...item, step: step.name })));
  if (outputs.length) { const list = section('步骤输出', '这些变量由前面的卡片生成，无需重复定义。'); for (const item of outputs) { const row = el('div', 'fw-output'); row.append(el('code', '', `{{${item.name}}}`), el('small', '', `← ${item.step}`)); list.append(row); } container.append(list); }
  const note = el('div', 'fw-context-note'); note.append(el('strong', '', '变量的生效顺序'), el('p', '', '环境值 → 流程默认值 → 运行输入 → 步骤提取。后面的值覆盖前面的同名值。')); container.append(note);
}
function renderHistory(container) {
  container.append(el('div', 'eyebrow', 'RUN HISTORY'), el('h3', '', '每一次验证，都有记录'));
  if (!state.history.length) container.append(el('p', 'fw-hint', '还没有运行过。准备好步骤后，点击上方“运行流程”。'));
  for (const run of state.history) {
    const item = button('', 'fw-history-item', () => void openRun(run.id)); const top = el('div', 'fw-history-top'); top.append(el('span', `fw-status ${run.status}`, statusNames[run.status] || run.status), el('span', 'fw-hint', `v${run.flow_version}`));
    item.append(top, el('span', '', new Date(run.created_at).toLocaleString('zh-CN', { hour12: false })), el('small', 'fw-hint', `${run.total_steps} 个步骤 · ${run.id.slice(0, 8)}`)); container.append(item);
  }
}
function renderSettings(container) {
  const flow = state.flow; container.append(el('div', 'eyebrow', 'FLOW SETTINGS'), el('h3', '', '执行约定'), field('流程说明', input(flow.description, '流程说明', value => { flow.description = value; changed(); }, { multiline: true, rows: 3, max: 2000 })), check('步骤失败时停止流程', flow.settings.stop_on_error, value => { flow.settings.stop_on_error = value; changed(); }), el('p', 'fw-hint', '步骤自身的“失败后继续”优先。即使继续执行，出现失败时整个测试仍标记为失败。'));
  container.append(field('默认步骤超时（秒）', input(flow.settings.request_timeout_ms / 1000, '默认步骤超时', (value, control) => { const seconds = Number(value); if (!value || seconds < 1 || seconds > 300 || !Number.isInteger(seconds)) { control.setCustomValidity('请输入 1–300 的整数'); setError('默认超时范围为 1–300 秒。'); return; } control.setCustomValidity(''); flow.settings.request_timeout_ms = seconds * 1000; changed(); }, { type: 'number' })));
}
async function runFlow() {
  if (state.starting) return;
  const problem = validateDefinition(state.flow, true); if (problem) { setError(problem); return; }
  if (!(await saveFlow())) return;
  if (!state.flow.variables.length) { await launch({}); return; }
  const values = {}; const content = el('div', 'fw-run-input-form');
  for (const variable of state.flow.variables) { const control = input('', `运行变量 ${variable.name}`, value => { values[variable.name] = value; }, { type: variable.secret ? 'password' : 'text', placeholder: variable.default_value || '留空继承默认值或环境值' }); control.autocomplete = 'off'; content.append(field(`${variable.name}${variable.required ? ' · 运行前必填' : ''}`, control, variable.description)); }
  showDialog('为本次运行准备输入', '这里的值只影响本次运行，留空继承默认值或环境值。敏感输入的运行变量记录会被遮罩。', content, '开始运行', async () => { await launch(Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '')), true); });
}
async function launch(variables, throwErrors = false) {
  if (state.starting) return; state.starting = true; state.error = ''; renderWorkspace();
  try {
    if (!(await saveFlow())) throw new Error('请先修正并保存流程定义。');
    const run = await api(`/flows/${encodeURIComponent(state.flow.id)}/runs`, { method: 'POST', body: { expected_flow_version: state.flow.edit_version, variables } });
    state.run = run; state.mode = 'run'; state.open.clear(); state.history = [run, ...state.history.filter(item => item.id !== run.id)]; setLocation(); await pollRun(); schedulePoll();
  } catch (error) { setError(`启动失败：${errorText(error)}`); if (throwErrors) throw error; }
  finally { state.starting = false; renderWorkspace(); }
}
async function openRun(id) {
  try { state.run = await api(`/flow-runs/${encodeURIComponent(id)}`); state.mode = 'run'; state.open.clear(); if (targetStep) state.open.add(targetStep); state.error = ''; setLocation(); renderWorkspace(); await pollRun(); schedulePoll(); if (state.visible && targetStep) revealExecutionStep(`flow-run-step-${targetStep}`); }
  catch (error) { setError(`无法读取运行记录：${errorText(error)}`); }
}
function schedulePoll() { clearTimeout(state.pollTimer); if (state.visible && state.run && activeStatus(state.run.status)) state.pollTimer = setTimeout(async () => { await pollRun(); schedulePoll(); }, 1200); }
async function pollRun() {
  if (!state.run || state.pollBusy === state.run.id) return;
  const id = state.run.id; state.pollBusy = id;
  try {
    const run = await api(`/flow-runs/${encodeURIComponent(id)}`); if (state.run?.id !== id) return;
    const old = JSON.stringify(state.run); state.run = run;
    state.history = [run, ...state.history.filter(item => item.id !== run.id)];
    const ids = [...new Set((run.steps || []).map(step => step.api_run_id).filter(value => value && !state.apiRuns.has(value) && !state.apiErrors.has(value)))];
    const records = await Promise.allSettled(ids.map(value => api(`/runs/${encodeURIComponent(value)}`)));
    records.forEach((record, index) => { if (record.status === 'fulfilled') state.apiRuns.set(ids[index], record.value); else state.apiErrors.add(ids[index]); });
    if (state.run?.id === id && state.visible && state.mode === 'run' && (old !== JSON.stringify(run) || ids.length)) renderWorkspace();
  } catch (error) { setError(`运行状态同步失败：${errorText(error)}`); }
  finally { if (state.pollBusy === id) state.pollBusy = false; }
}
function renderRun(canvas) {
  const run = state.run; const steps = run.steps || []; const assertions = steps.flatMap(step => step.assertions || []);
  const summary = el('section', `fw-run-summary ${run.status}`); const heading = el('div', 'fw-run-summary-heading'); heading.append(el('span', `fw-status ${run.status}`, statusNames[run.status] || run.status), el('strong', '', run.status === 'succeeded' ? assertions.length ? '已执行的断言全部通过。' : '操作已完成，未配置断言。' : run.status === 'failed' ? '发现了需要关注的结果。' : '正在验证你的流程。'));
  const actions = el('div', 'fw-run-actions'); actions.append(button('刷新结果', 'button small', () => { state.apiErrors.clear(); void pollRun(); })); if (activeStatus(run.status)) actions.append(button('停止运行', 'button small danger', async () => { try { await api(`/flow-runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST' }); await pollRun(); } catch (error) { setError(errorText(error)); } })); heading.append(actions);
  const stats = el('div', 'fw-run-stats'); for (const [value, label] of [[`${steps.filter(step => !activeStatus(step.status) && step.status !== 'pending').length}/${run.total_steps}`, '步骤完成'], [`${assertions.filter(item => item.passed).length}/${assertions.length}`, '断言通过'], [run.finished_at && run.started_at ? `${Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at))} ms` : '进行中', '总耗时']]) { const item = el('div'); item.append(el('strong', '', value), el('span', '', label)); stats.append(item); } summary.append(heading, stats); canvas.append(summary);
  if (run.error_message) canvas.append(el('div', 'fw-message', run.error_message)); if (run.cleanup_error) canvas.append(el('div', 'fw-message', `清理失败：${run.cleanup_error}`));
  if (Object.keys(run.variables || {}).length) { const inputs = el('details', 'fw-run-input-snapshot'); inputs.append(el('summary', '', '查看本次输入与流程默认值')); for (const [name, value] of Object.entries(run.variables)) { const pair = el('div', 'fw-output'); pair.append(el('code', '', name), el('span', '', value)); inputs.append(pair); } canvas.append(inputs); }
  const track = el('div', 'fw-track fw-run-track');
  let lastPhase = null;
  for (const [index, step] of steps.entries()) {
    const phase = step.phase || '';
    if (phase !== lastPhase) { track.append(el('h3', 'fw-phase-title', phase === 'finally' ? '收尾步骤' : '执行步骤')); lastPhase = phase; }
    const card = el('article', `fw-step fw-run-step ${step.status}`); const open = state.open.has(step.id) || !state.tabs.has(step.id) && ['failed', 'paused'].includes(step.status);
    card.id = `flow-run-step-${step.id}`; card.tabIndex = -1;
    card.classList.toggle('execution-target', step.id === targetStep);
    const head = button('', 'fw-result-toggle', () => { if (open) state.open.delete(step.id); else state.open.add(step.id); state.tabs.set(step.id, 'visited'); renderWorkspace(); }); head.setAttribute('aria-expanded', String(open));
    const label = el('div', 'fw-step-summary'); label.append(el('strong', '', step.name_snapshot), el('small', 'fw-step-endpoint', step.type === 'sql' ? `SQL · ${step.sql_snapshot?.sql || '未保存 SQL'}` : step.type === 'service' ? `SERVICE · ${step.service_snapshot?.action === 'stop' ? '停止' : '启动或复用'} · ${step.service_snapshot?.service_id || '—'}` : `${step.request_snapshot?.method || 'HTTP'} ${step.request_snapshot?.url || ''}`));
    const elapsed = step.started_at && step.finished_at ? `${Math.max(0, Date.parse(step.finished_at) - Date.parse(step.started_at))} ms` : '—';
    head.append(el('span', 'fw-step-index', String(index + 1).padStart(2, '0')), label, el('span', `fw-status ${step.status}`, statusNames[step.status] || step.status), el('span', 'fw-hint', elapsed), el('span', 'fw-chevron', open ? '−' : '+')); card.append(head);
    if (open) renderStepResult(card, step); track.append(card);
  }
  if (!steps.length) track.append(el('p', 'fw-hint', '正在准备执行步骤…')); canvas.append(track);
}
function renderStepResult(card, step) {
  const body = el('div', 'fw-step-body');
  if (step.error_message) body.append(el('div', 'fw-message', step.error_message));
  if (step.status === 'paused') { const actions = el('div', 'fw-rule-options'); for (const [action, label] of [['continue', '继续执行'], ['skip', '跳过步骤'], ['stop', '停止流程']]) { const control = button(label, 'button small', async () => { control.disabled = true; try { await api(`/flow-runs/${encodeURIComponent(state.run.id)}/steps/${encodeURIComponent(step.id)}/resume`, { method: 'POST', body: { action } }); await pollRun(); } catch (error) { setError(errorText(error)); } finally { control.disabled = false; } }); actions.append(control); } body.append(actions); }
  if ((step.assertions || []).length) {
    const checks = section('断言结果'); checks.setAttribute('aria-label', '断言结果');
    for (const assertion of step.assertions) { const result = el('div', `fw-check-result ${assertion.passed ? 'passed' : 'failed'}`); result.append(el('strong', '', assertion.passed ? '✓ 通过' : '× 失败'), el('span', '', `${assertion.kind} ${assertion.path || ''} · ${operators.find(item => item[0] === assertion.operator)?.[1] || '等于'}`), el('div', '', `期望：${assertion.operator === 'exists' ? '存在' : display(assertion.expected)}  ·  实际：${display(assertion.actual)}`)); checks.append(result); } body.append(checks);
  }
  if (step.result?.extracted_variables?.length) {
    const outputs = section('输出变量 · 本次运行'); outputs.setAttribute('aria-label', '提取结果');
    for (const variable of step.result.extracted_variables) { const pair = el('div', 'fw-output'); pair.append(el('code', '', step.flow_step_id ? outputReference(step.flow_step_id, variable.name) : variable.name), el('span', '', variable.secret ? '••••••' : variable.value)); outputs.append(pair); } body.append(outputs);
  }
  if (step.type === 'sql') renderSQLResult(body, step);
  else if (step.type === 'service') renderServiceResult(body, step);
  else if (step.api_run_id) {
    const apiRun = state.apiRuns.get(step.api_run_id); const response = section('请求与响应');
    if (apiRun) {
      response.append(el('div', 'fw-response-status', `HTTP ${apiRun.response_status ?? '—'} · ${apiRun.duration_ms ?? 0} ms`), el('div', 'fw-result-url', requestURL(apiRun.request_snapshot)), code(apiRun.response_body));
      const details = el('details', 'fw-response-details'); details.append(el('summary', '', '请求配置与响应头'), code({ request: apiRun.request_snapshot, response_headers: apiRun.response_headers })); response.append(details, button('打开完整请求详情 ↗', 'fw-text-button', event => openRequestDetail(apiRun.id, event.currentTarget)));
      if (apiRun.response_truncated) response.append(el('p', 'fw-hint', '响应内容较大，展示已保存的前 256 KB。'));
    } else response.append(el('p', 'fw-hint', state.apiErrors.has(step.api_run_id) ? '请求记录暂不可用，点击上方“刷新结果”重试。' : '正在载入请求记录…'));
    body.append(response);
  } else if (!step.type || step.type === 'http') {
    const request = section('HTTP 请求快照'); request.append(code(step.request_snapshot || {}), el('p', 'fw-hint', resultUnavailable(step))); body.append(request);
  } else if (step.result) {
    const { extracted_variables, ...operationResult } = step.result;
    if (Object.keys(operationResult).length) body.append(code(operationResult));
  }
  card.append(body);
}

function resultUnavailable(step) {
  if (['pending', 'queued'].includes(step.status)) return '步骤尚未执行。';
  if (['running', 'paused'].includes(step.status)) return '步骤正在执行或等待确认，完成后显示结果。';
  if (['skipped', 'cancelled'].includes(step.status)) return '步骤已跳过或取消，没有保存执行结果。';
  return '本次执行未保存结果，请查看执行错误；旧记录可能没有结果快照。';
}
function resultPairs(entries) {
  const list = el('dl', 'fw-result-pairs');
  for (const [label, value] of entries) list.append(el('dt', '', label), el('dd', '', value ?? '—'));
  return list;
}
function renderSQLResult(body, step) {
  const command = step.sql_snapshot;
  const input = section('SQL 执行快照'); input.setAttribute('aria-label', 'SQL 执行快照');
  if (command) {
    input.append(resultPairs([['数据库连接', command.connection_id], ['操作类型', command.mode === 'exec' ? '执行语句' : '查询'], ['最大返回行数', command.max_rows || '默认']]), code(command.sql), el('h4', '', '绑定参数'), code(command.params || []));
    input.append(el('p', 'fw-hint', 'SQL 与绑定参数按本次快照展示；旧记录可能保留变量引用，敏感值以脱敏内容显示。'));
  } else input.append(el('p', 'fw-hint', '这条记录没有保存 SQL 输入快照。'));
  const output = section(command?.mode === 'exec' ? 'SQL 执行结果' : 'SQL 查询结果'); output.setAttribute('aria-label', 'SQL 结果');
  const result = step.result;
  if (!result || !['rows', 'columns', 'row_count', 'rows_affected'].some(key => Object.hasOwn(result, key))) output.append(el('p', 'fw-hint', resultUnavailable(step)));
  else {
    output.append(resultPairs([[command?.mode === 'exec' ? '影响行数' : '返回行数', command?.mode === 'exec' ? result.rows_affected : result.truncated ? `已保存 ${(result.rows || []).length} 行（总行数未知）` : result.row_count], ['执行耗时', result.duration_ms == null ? '—' : `${result.duration_ms} ms`]]));
    if (result.truncated) output.append(el('p', 'fw-message', '查询结果超过最大返回行数，以下只展示已保存的部分数据。'));
    if (command?.mode !== 'exec') {
      const rows = result.rows || [], columns = result.columns?.length ? result.columns : [...new Set(rows.flatMap(row => Object.keys(row)))];
      if (columns.length) {
        const wrap = el('div', 'fw-result-table'); const table = el('table'); table.setAttribute('aria-label', 'SQL 查询数据');
        const caption = el('caption', '', 'SQL 查询数据'); const head = el('thead'), header = el('tr'), data = el('tbody');
        for (const column of columns) { const cell = el('th', '', column); cell.scope = 'col'; header.append(cell); } head.append(header);
        for (const row of rows) { const record = el('tr'); for (const column of columns) record.append(el('td', '', Object.hasOwn(row, column) ? row[column] === null ? 'NULL' : display(row[column]) : '—')); data.append(record); }
        table.append(caption, head, data); wrap.append(table); output.append(wrap);
      }
      if (!rows.length) output.append(el('p', 'fw-hint', '查询完成，返回 0 行。'));
    }
  }
  body.append(input, output);
}
function renderServiceResult(body, step) {
  const command = step.service_snapshot;
  const input = section('服务操作快照'); input.setAttribute('aria-label', '服务操作快照');
  if (command) input.append(resultPairs([['服务 ID', command.service_id], ['操作', command.action === 'stop' ? '停止服务' : '启动或复用服务']]));
  else input.append(el('p', 'fw-hint', '这条记录没有保存服务操作快照。'));
  const output = section('服务操作结果'); output.setAttribute('aria-label', '服务操作结果');
  const result = step.result;
  if (!result || !Object.hasOwn(result, 'status')) output.append(el('p', 'fw-hint', resultUnavailable(step)));
  else {
    const statuses = { running: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停止', failed: '异常', cleanup_failed: '清理失败' };
    const owner = result.owner === 'external' ? '外部服务' : result.owner === 'manual' ? '手动启动' : result.owner;
    output.append(resultPairs([['服务 ID', result.service_id || command?.service_id], ['操作后状态', statuses[result.status] || result.status], ['进程 PID', result.pid || '—'], ['归属', owner || '—']]));
    if (command?.action === 'start' && result.status === 'running') output.append(el('p', 'fw-hint', result.started ? '本次执行启动了服务。' : '本次执行复用了已有服务。'));
    if (command?.action === 'stop') output.append(el('p', 'fw-hint', result.status === 'stopped' ? '停止操作已完成。' : result.status === 'running' ? '服务仍在运行；复用的服务由原启动方管理。' : '停止操作未完成，请查看执行错误。'));
    output.append(el('p', 'fw-hint', '以上为本次操作时保存的结果；流程收尾清理或后续操作可能已改变服务状态。'));
  }
  body.append(input, output);
}
window.addEventListener('beforeunload', event => { if (state.dirty || state.saving) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('keydown', event => { if (state.visible && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveFlow(); } });
