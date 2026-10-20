const root = document.getElementById('command-workspace');
let mounted = false;
let working = false;
let dialog = null;
let dirty = false;
let environment = null;
let pageFields = null;
const el = (tag, cls = '', text) => { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = String(text); return n; };
const pretty = value => JSON.stringify(value, null, 2);
function button(text, action, cls = 'button') { const n = el('button', cls, text); n.type = 'button'; n.addEventListener('click', action); return n; }
function field(label, value = '', tag = 'input') { const wrap = el('label'); const input = el(tag); input.value = value; input.setAttribute('aria-label', label); wrap.append(el('span', '', label), input); return { wrap, input }; }
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { cache: 'no-store', ...options, ...(options.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}) });
  if (response.status === 204) return null;
  const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value;
}
function jsonObject(text, name) { const value = JSON.parse(text || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(v => typeof v !== 'string')) throw new Error(`${name}需要是值为字符串的 JSON 对象`); return value; }
function notice(text = '', error = false) { const n = root?.querySelector('[data-command-notice]'); if (n) { n.replaceChildren(document.createTextNode(text)); n.hidden = !text; n.className = `detail-alert${error ? ' error' : ''}`; n.setAttribute('role', error ? 'alert' : 'status'); } }
function fields(item, modal = false) {
  const request = item?.command_request || {}; const content = el('div', 'command-fields');
  const name = field(modal ? '用例名称' : '测试名称', item?.name || (modal ? '' : '命令行测试')); name.input.required = true; name.input.maxLength = 512;
  const description = field('说明', item?.description || '');
  const program = field('执行程序', request.program || ''); program.input.required = true; program.input.placeholder = '例如：bash、python3、node 或程序的绝对路径'; program.input.spellcheck = false;
  const cwd = field('工作目录', request.work_dir || ''); cwd.input.placeholder = '留空使用 Runtime 工作目录；填写时使用绝对路径'; cwd.input.spellcheck = false;
  const args = field('启动参数（JSON 数组）', pretty(request.args || []), 'textarea'); args.input.rows = 3; args.input.spellcheck = false;
  const timeout = field('超时（秒）', request.timeout_seconds || 30); timeout.input.type = 'number'; timeout.input.min = 1; timeout.input.max = 300; timeout.input.required = true;
  const expected = field('预期退出码', item?.expected_exit_code ?? (modal ? '' : 0)); expected.input.type = 'number'; expected.input.min = 0; expected.input.max = 2147483647; expected.input.placeholder = '留空且无断言时标记为未验证';
  const config = el('div', 'command-config'); config.append(timeout.wrap, expected.wrap);
  const env = field('环境变量（JSON 对象）', pretty(request.env || {}), 'textarea'); env.input.rows = 3; env.input.spellcheck = false;
  const stdin = field('标准输入 / 脚本正文', request.stdin || '', 'textarea'); stdin.input.rows = 5; stdin.input.spellcheck = false; stdin.input.placeholder = '执行脚本文件：参数填脚本路径。内联脚本：bash 参数填 ["-s"]，python3 / node 参数填 ["-"]，在这里填写代码。';
  const assertions = field('输出断言（JSON 数组）', pretty(item?.assertions || []), 'textarea'); assertions.input.rows = 4; assertions.input.spellcheck = false; assertions.input.placeholder = '[{"source":"stdout","operator":"contains","expected":"完成"}]';
  const variables = field('运行变量（JSON 对象）', '{}', 'textarea'); variables.input.rows = 2; variables.input.spellcheck = false;
  content.append(name.wrap, description.wrap, program.wrap, cwd.wrap, args.wrap, config, env.wrap, stdin.wrap, assertions.wrap, el('p', 'manual-tool-hint', 'stdout、stderr、exit_code 支持 equals、not_equals、contains、exists；输出为 JSON 时可填写点路径。敏感环境变量或参数建议保存为 {{token}}，在运行变量中显式传值。'), variables.wrap);
  if (pretty(request).includes('••••')) content.append(el('p', 'response-error', '此定义来自脱敏快照，请替换脱敏字段后再执行。'));
  return { content, program: program.input, read() {
    const argumentsValue = JSON.parse(args.input.value || '[]'); if (!Array.isArray(argumentsValue) || argumentsValue.some(v => typeof v !== 'string')) throw new Error('启动参数需要是字符串 JSON 数组，每项对应一个参数');
    const definitions = JSON.parse(assertions.input.value || '[]'); if (!Array.isArray(definitions)) throw new Error('输出断言需要是 JSON 数组');
    return { value: { ...(item?.id ? { id: item.id, edit_version: item.edit_version, project_id: item.project_id } : {}), type: 'command', name: name.input.value, description: description.input.value, command_request: { program: program.input.value, args: argumentsValue, work_dir: cwd.input.value, env: jsonObject(env.input.value, '环境变量'), stdin: stdin.input.value, timeout_seconds: Number(timeout.input.value) }, ...(expected.input.value !== '' ? { expected_exit_code: Number(expected.input.value) } : {}), assertions: definitions }, variables: jsonObject(variables.input.value, '运行变量') };
  } };
}
async function execute(value, variables, batchID) {
  const batch = batchID ? { id: batchID } : await api('/test-batches', { method: 'POST', body: { name: value.name } });
  try { return { batch, result: await api(`/test-batches/${encodeURIComponent(batch.id)}/runs`, { method: 'POST', body: { test_case: value, variables } }) }; }
  finally { if (!batchID) { try { await api(`/test-batches/${batch.id}/finish`, { method: 'POST' }); } catch (error) { notice(`批次尚未结束：${error.message}。可在测试记录中查看。`, true); } } }
}
function resultLink(batchID) { const link = el('a', 'button', '查看测试记录'); link.href = `/tests?batch=${encodeURIComponent(batchID)}`; link.dataset.route = ''; return link; }
function renderResult(out) {
  const result = out.result; const data = result.command_result || {}; const target = root.querySelector('[data-command-result]'); target.replaceChildren();
  const labels = { passed: '通过', failed: '断言失败', error: '执行错误', unverified: '未验证' }; const heading = el('div', 'command-result-heading'); heading.append(el('span', `test-pill ${result.test_status}`, labels[result.test_status] || result.test_status), el('span', '', `退出码 ${data.exit_code ?? '—'} · ${result.duration_ms} ms`), resultLink(out.batch.id)); target.append(heading);
  if (result.test_error) target.append(el('p', 'response-error', result.test_error));
  for (const source of ['stdout', 'stderr']) { const section = el('section', 'command-output'); section.append(el('h3', '', source)); if (data[`${source}_truncated`]) section.append(el('p', 'response-error', '输出已截断，相关输出断言不能判为通过。')); section.append(el('pre', 'detail-code', data[source] || '（空）')); target.append(section); }
  const assertions = result.assertions || []; if (assertions.length) { target.append(el('h3', '', `断言结果 · ${assertions.filter(a => a.passed).length}/${assertions.length} 通过`)); for (const a of assertions) { const row = el('div', 'command-assertion'); row.append(el('span', `test-pill ${a.passed ? 'passed' : 'failed'}`, a.passed ? '通过' : '失败'), el('code', '', `${a.kind}${a.path ? `.${a.path}` : ''} ${a.operator}`), el('pre', 'detail-code', pretty({ expected: a.expected, actual: a.actual }))); target.append(row); } }
}
function mount() {
  if (mounted || !root) return; mounted = true;
  const layout = el('div', 'command-layout'); const panel = el('section', 'panel'); const heading = el('div', 'panel-heading'); const title = el('div'); title.append(el('h2', '', '执行命令或脚本'), el('p', '', '填写程序和独立参数，执行后保存退出码、输出与断言。')); heading.append(title); panel.append(heading);
  const info = el('p', 'command-environment'); info.dataset.commandEnvironment = ''; info.textContent = '正在读取执行环境…'; panel.append(info);
  const form = el('form', 'manual-tool-form command-form'); pageFields = fields(null); form.append(pageFields.content);
  const actions = el('div', 'command-actions'); actions.append(button('执行命令', () => { form.dataset.intent = 'run'; form.requestSubmit(); }, 'button primary'), button('保存测试用例', () => { form.dataset.intent = 'save'; form.requestSubmit(); }));
  const saved = el('a', 'button', '已保存用例'); saved.href = '/tests?tab=cases'; saved.dataset.route = ''; actions.append(saved);
  const message = el('div', 'detail-alert'); message.dataset.commandNotice = ''; message.hidden = true; form.append(actions, message); panel.append(form);
  const output = el('section', 'panel command-result-panel'); output.append(el('div', 'panel-heading')); output.firstChild.append(el('h2', '', '本次执行结果')); const result = el('div', 'command-result'); result.dataset.commandResult = ''; result.setAttribute('aria-live', 'polite'); result.append(el('p', '', '执行后在这里查看 stdout、stderr、退出码与断言。')); output.append(result); layout.append(panel, output); root.replaceChildren(layout);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (working) return; let input; try { input = pageFields.read(); } catch (error) { notice(error.message, true); return; }
    working = true; form.querySelectorAll('button,input,select,textarea').forEach(n => { n.disabled = true; }); notice(''); result.setAttribute('aria-busy', 'true');
    try {
      if (form.dataset.intent === 'save') { await api('/test-cases', { method: 'POST', body: input.value }); notice('用例已保存，可在“已保存用例”中重复运行。'); }
      else { result.replaceChildren(el('p', '', '正在执行命令…')); renderResult(await execute(input.value, input.variables)); }
    } catch (error) { notice(error.message, true); }
    finally { working = false; result.setAttribute('aria-busy', 'false'); form.querySelectorAll('button,input,select,textarea').forEach(n => { n.disabled = false; }); }
  });
}
export async function refreshCommands() {
  mount(); if (!root) return;
  if (!environment) { try { environment = await api('/commands/environment'); } catch (error) { notice(error.message, true); return; } }
  root.querySelector('[data-command-environment]').textContent = `执行环境 ${environment.platform} · Runtime 工作目录 ${environment.work_dir} · 每个输出流最多保留 256 KB`;
}
export function openCommandCaseEditor(item = null, options = {}) {
  if (dialog?.open) dialog.close(); dialog?.remove(); dirty = false;
  const d = el('dialog', 'testing-editor command-editor'); dialog = d; const title = item?.id ? '编辑命令行测试用例' : '新建命令行测试用例'; d.setAttribute('aria-label', title);
  const heading = el('div', 'detail-heading'); heading.append(el('h2', '', title), button('关闭 ×', () => d.close(), 'button small'));
  const form = el('form'); const inputFields = fields(item, true); const error = el('div', 'detail-alert error'); error.hidden = true; error.setAttribute('role', 'alert'); const actions = el('div', 'database-dialog-actions');
  actions.append(button(item?.id ? '保存修改' : '保存用例', () => { form.dataset.intent = 'save'; form.requestSubmit(); }, 'button primary'), button('仅运行本次', () => { form.dataset.intent = 'run'; form.requestSubmit(); }));
  form.append(inputFields.content, error, actions); d.append(heading, form); document.body.append(d);
  form.addEventListener('input', () => { dirty = true; }); d.addEventListener('close', () => { dirty = false; });
  const lock = value => { d.querySelectorAll('button,input,select,textarea').forEach(n => { n.disabled = value; }); d.oncancel = event => { if (value) event.preventDefault(); }; };
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (form.dataset.working) return; let input; try { input = inputFields.read(); } catch (e) { error.textContent = e.message; error.hidden = false; return; }
    form.dataset.working = 'true'; lock(true); error.hidden = true;
    try { let batchID;
      if (form.dataset.intent === 'run') { const out = await execute(input.value, input.variables, options.batchID); batchID = out.batch.id; }
      else await api(item?.id ? `/test-cases/${item.id}` : '/test-cases', { method: item?.id ? 'PUT' : 'POST', body: input.value });
      d.close(); if (options.onSaved) await options.onSaved(batchID);
    } catch (e) { error.textContent = e.message; error.hidden = false; }
    finally { delete form.dataset.working; lock(false); }
  }); d.showModal(); inputFields.program.focus();
}
window.addEventListener('beforeunload', event => { if (dirty && dialog?.open) { event.preventDefault(); event.returnValue = ''; } });
