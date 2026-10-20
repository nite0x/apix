import {openArchived,showReferences,lifecycleButton,openBulkManager} from './lifecycle-ui.js';
import { executionBatchLink } from './execution-batch.js';
import { attachExecutionHistory } from './execution-history.js';
let executionHistory = null;
const root = document.getElementById('mcp-workspace');
const state = { servers: [], server: '', tools: [], discovery: null, tool: '', working: false, loading: false, generation: 0 };
let mounted = false;
let dirty = false;
let activeDialog = null;
const node = (tag, cls = '', text) => { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = String(text); return n; };
const pretty = value => JSON.stringify(value, null, 2);
function button(text, action, cls = 'button') { const n = node('button', cls, text); n.type = 'button'; n.addEventListener('click', action); return n; }
function field(text, value = '', tag = 'input') { const wrap = node('label'); const input = node(tag); input.value = value; input.setAttribute('aria-label', text); input.addEventListener('input', () => { dirty = true; }); wrap.append(node('span', '', text), input); return { wrap, input }; }
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { cache: 'no-store', ...options, ...(options.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}) });
  if (response.status === 204) return null;
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
}
function object(text, label) { const value = JSON.parse(text || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label}需要是 JSON 对象`); return value; }
function feedback(text = '', error = false) { const n = root.querySelector('[data-mcp-feedback]'); if (n) { n.textContent = text; n.hidden = !text; n.className = `detail-alert${error ? ' error' : ''}`; n.setAttribute('role', error ? 'alert' : 'status'); } }
function mount() {
  if (mounted) return; mounted = true;
  const panel = node('section', 'panel'); const heading = node('div', 'panel-heading'); const intro = node('div'); intro.append(node('h2', '', 'MCP 服务器'), node('p', '', '通过 Streamable HTTP 连接服务器，发现工具并验证调用结果。'));
  heading.append(intro, button('＋ 添加服务器', () => openServerEditor(), 'button primary'),lifecycleButton('已归档服务器',()=>openArchived('mcp',refreshMCP)),lifecycleButton('批量管理',()=>openBulkManager('mcp',refreshMCP)));const search=field('搜索服务器','','input');search.input.type='search';search.input.placeholder='服务器名称或地址';search.input.oninput=()=>{state.serverQuery=search.input.value;const matches=state.servers.filter(s=>`${s.name} ${s.url}`.toLowerCase().includes(state.serverQuery.toLowerCase()));if(!matches.some(s=>s.id===state.server)){state.server=matches[0]?.id||'';clearTools();}renderConnection();};heading.append(search.wrap); panel.append(heading);
  const config = node('div', 'mcp-connection'); const server = field('当前服务器', '', 'select'); server.input.dataset.mcpServer = '';
  server.input.addEventListener('change', () => { state.server = server.input.value; clearTools(); renderConnection(); });
  const actions = node('div', 'mcp-actions'); actions.append(button('编辑连接', () => openServerEditor(state.servers.find(s => s.id === state.server))), button('归档连接', archiveServer),lifecycleButton('引用与影响',()=>showReferences('mcp',state.server)), button('测试连接并获取工具', discover, 'button primary'));
  config.append(server.wrap, actions); const info = node('p', 'subtle'); info.dataset.mcpConnectionInfo = ''; panel.append(config, info);
  const message = node('div', 'detail-alert'); message.dataset.mcpFeedback = ''; message.hidden = true; panel.append(message);
  const workspace = node('div', 'mcp-layout'); const tools = node('aside', 'panel mcp-tools'); tools.setAttribute('aria-label', 'MCP 工具列表'); tools.dataset.mcpTools = '';
  const editor = node('section', 'panel mcp-tool-editor'); editor.dataset.mcpToolEditor = ''; workspace.append(tools, editor); root.replaceChildren(panel, workspace); renderConnection(); renderTools();
  executionHistory = attachExecutionHistory(root, 'mcp', '工具调用');
}
function clearTools() { state.generation++; state.tools = []; state.tool = ''; state.discovery = null; renderTools(); feedback(); }
function renderConnection() {
  mount(); const select = root.querySelector('[data-mcp-server]'); select.replaceChildren(new Option('请选择服务器', ''));
  for (const s of state.servers.filter(s=>!state.serverQuery||`${s.name} ${s.url}`.toLowerCase().includes(state.serverQuery.toLowerCase()))) select.add(new Option(s.name, s.id)); select.value = state.server; select.disabled = state.working;
  const selected = state.servers.find(s => s.id === state.server);
  root.querySelector('[data-mcp-connection-info]').textContent = selected ? `${selected.url} · 超时 ${selected.timeout_seconds} 秒${state.discovery ? ` · 已连接 ${state.discovery.server_name} · ${state.tools.length} 个工具 · ${state.discovery.duration_ms} ms` : selected.discovered_at ? ` · 上次发现 ${new Date(selected.discovered_at).toLocaleString('zh-CN')}，请重新发现以确认工具有效` : ' · 尚未测试连接'}` : '添加并选择一个服务器开始测试。';
  root.querySelector('.panel-heading button').disabled = state.working;
  root.querySelectorAll('.mcp-tool').forEach(n => { n.disabled = state.working; });
  root.querySelectorAll('.mcp-actions button').forEach(n => { n.disabled = state.working || !selected; });
}
export async function refreshMCP() {
  mount(); void executionHistory.refresh(); if (state.loading || state.working) return; state.loading = true;
  try { state.servers = await api('/mcp-servers'); if (!state.servers.some(s => s.id === state.server)) { state.server = state.servers[0]?.id || ''; clearTools(); } renderConnection(); }
  catch (error) { feedback(error.message, true); } finally { state.loading = false; }
}
async function discover() {
  if (state.working || !state.server) return; state.working = true; const generation = ++state.generation; const server = state.server; renderConnection(); feedback('正在握手并获取工具列表…');
  try { const result = await api(`/mcp-servers/${encodeURIComponent(server)}/discover`, { method: 'POST' }); if (generation !== state.generation) return; state.discovery = result; state.tools = result.tools || []; state.tool = state.tools[0]?.name || ''; renderTools(); feedback(`连接成功，发现 ${state.tools.length} 个工具。`); }
  catch (error) { state.tools = []; state.tool = ''; state.discovery = null; renderTools(); feedback(error.message, true); }
  finally { state.working = false; renderConnection(); }
}
function renderTools() {
  if (!mounted) return; const list = root.querySelector('[data-mcp-tools]'); const editor = root.querySelector('[data-mcp-tool-editor]'); list.replaceChildren(node('h2', '', `工具 · ${state.tools.length}`));
  for (const tool of state.tools) { const b = button('', () => { if (state.working) return; state.tool = tool.name; renderTools(); }, 'mcp-tool'); b.setAttribute('aria-pressed', String(tool.name === state.tool)); b.append(node('strong', '', tool.name), node('small', '', tool.description || '无说明')); list.append(b); }
  if (!state.tools.length) list.append(node('p', 'empty', '测试连接后，工具会显示在这里。'));
  const tool = state.tools.find(t => t.name === state.tool); editor.replaceChildren();
  if (!tool) { editor.append(node('div', 'empty', '选择工具后可编辑参数、执行调用或保存测试用例。')); return; }
  editor.append(node('h2', '', tool.name), node('p', 'mcp-description', tool.description || '此工具没有提供说明。'));
  const schema = node('details'); schema.append(node('summary', '', '参数与返回结构'), node('pre', 'detail-code', pretty({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }))); editor.append(schema);
  const form = node('form', 'mcp-call-form'); const args = field('调用参数（JSON 对象）', '{}', 'textarea'); args.input.rows = 8; args.input.spellcheck = false;
  const fields = node('div', 'mcp-parameter-fields'); const controls = [];
  for (const [key, property] of Object.entries(tool.inputSchema?.properties || {})) {
    const required = (tool.inputSchema.required || []).includes(key); const label = `${key}${required ? ' *' : ''}`; const f = field(label, '', property.enum || property.type === 'boolean' ? 'select' : ['object', 'array'].includes(property.type) ? 'textarea' : 'input');
    f.input.dataset.parameter = key; f.input.required = required;
    if (f.input.tagName === 'SELECT') { f.input.add(new Option('未设置', '')); for (const value of property.enum || [true, false]) f.input.add(new Option(String(value), JSON.stringify(value))); }
    if (property.type === 'number' || property.type === 'integer') { f.input.type = 'number'; f.input.step = property.type === 'integer' ? '1' : 'any'; }
    if (property.description) f.wrap.append(node('small', 'subtle', property.description));
    if (property.default !== undefined) f.input.value = f.input.tagName === 'SELECT' || ['object', 'array'].includes(property.type) ? JSON.stringify(property.default) : String(property.default);
    controls.push({ key, property, input: f.input }); fields.append(f.wrap);
    f.input.addEventListener('input', () => { try { const values = object(args.input.value, '调用参数'); const value = f.input.value; if (value === '' && !required) delete values[key]; else values[key] = f.input.tagName === 'SELECT' || ['number', 'integer', 'object', 'array'].includes(property.type) ? JSON.parse(value) : value; args.input.value = pretty(values); } catch { /* An incomplete form value can still be edited. */ } });
  }
  const initial = {}; for (const { key, property } of controls) if (property.default !== undefined) initial[key] = property.default; args.input.value = pretty(initial);
  args.input.addEventListener('input', () => { try { const values = object(args.input.value, '调用参数'); for (const { key, property, input } of controls) { const value = values[key]; input.value = value === undefined ? '' : input.tagName === 'SELECT' || ['object', 'array'].includes(property.type) ? pretty(value) : String(value); } } catch { /* Keep the JSON draft intact. */ } });
  // JSON is authoritative and can express schema combinations beyond simple fields.
  const run = button('执行工具', () => form.requestSubmit(), 'button primary'); const save = button('保存为测试用例', () => { try { const request = { server_id: state.server, tool_name: tool.name, arguments: object(args.input.value, '调用参数') }; openMCPCaseEditor({ type: 'mcp', name: tool.name, mcp_request: request, expected_is_error: false }); } catch (error) { feedback(error.message, true); } });
  const actions = node('div', 'mcp-actions'); actions.append(run, save); form.append(fields, args.wrap, actions); const result = node('div', 'mcp-live-result'); result.setAttribute('aria-live', 'polite');
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (state.working) return; let request;
    try { request = { server_id: state.server, tool_name: tool.name, arguments: object(args.input.value, '调用参数') }; } catch (error) { feedback(error.message, true); return; }
    state.working = true; renderConnection(); form.querySelectorAll('button,input,select,textarea').forEach(n => { n.disabled = true; }); result.replaceChildren(node('p', '', '正在调用工具…')); feedback();
    let batch;
    try {
      batch = await api('/test-batches', { method: 'POST', body: { name: `MCP 调试 · ${tool.name}` } });
      const out = await api(`/test-batches/${batch.id}/runs`, { method: 'POST', body: { test_case: { type: 'mcp', name: tool.name, mcp_request: request, assertions: [] } } });
      result.replaceChildren(node('h3', '', `本次执行 · ${out.test_status === 'error' ? '执行错误' : '未验证'} · ${out.duration_ms} ms`), node('pre', 'detail-code', pretty(out.mcp_result)));
      result.append(executionBatchLink({ batch_id: batch.id, test_run_id: out.test_run_id }, 'button'));
    } catch (error) { result.replaceChildren(node('p', 'response-error', error.message)); }
    finally { if (batch) { try { await api(`/test-batches/${batch.id}/finish`, { method: 'POST' }); } catch (error) { feedback(`批次尚未结束：${error.message}。可在测试记录中查看。`, true); } } state.working = false; renderConnection(); form.querySelectorAll('button,input,select,textarea').forEach(n => { n.disabled = false; }); }
  });
  editor.append(form, result);
}
function dialog(title) {
  if (activeDialog?.open) activeDialog.close(); activeDialog?.remove(); dirty = false;
  const element = node('dialog', 'testing-editor mcp-editor'); element.setAttribute('aria-label', title); activeDialog = element;
  const heading = node('div', 'detail-heading'); heading.append(node('h2', '', title), button('关闭 ×', () => element.close(), 'button small'));
  const form = node('form'); const content = node('div', 'testing-form'); const error = node('div', 'detail-alert error'); error.hidden = true; error.setAttribute('role', 'alert'); const actions = node('div', 'database-dialog-actions'); form.append(content, error, actions); element.append(heading, form); document.body.append(element);
  element.addEventListener('close', () => { dirty = false; }); element.showModal();
  return { element, form, content, actions, error: message => { error.textContent = message; error.hidden = !message; }, lock: value => { element.querySelectorAll('button,input,select,textarea').forEach(n => { n.disabled = value; }); element.oncancel = event => { if (value) event.preventDefault(); }; } };
}
function openServerEditor(server) {
  const d = dialog(server ? '编辑 MCP 服务器' : '添加 MCP 服务器'); const name = field('服务器名称', server?.name || ''); name.input.required = true; name.input.maxLength = 256;
  const url = field('Streamable HTTP 地址', server?.url || ''); url.input.type = 'url'; url.input.required = true; url.input.placeholder = 'http://127.0.0.1:8080/mcp';
  const timeout = field('超时（秒）', server?.timeout_seconds || 30); timeout.input.type = 'number'; timeout.input.min = 1; timeout.input.max = 300; timeout.input.required = true;
  const headers = field('认证请求头（JSON 对象）', pretty(server?.headers || {}), 'textarea'); headers.input.spellcheck = false; headers.input.rows = 5;
  d.content.append(name.wrap, url.wrap, timeout.wrap, headers.wrap, node('p', 'subtle', '例如 {"Authorization":"Bearer ..."}。请求头在本机加密保存；编辑时保留 •••••• 表示沿用原值，移除对应字段可删除请求头。'));
  d.actions.append(button('保存连接', () => d.form.requestSubmit(), 'button primary'));
  d.form.addEventListener('submit', async event => { event.preventDefault(); let value; try { value = { ...server, name: name.input.value, url: url.input.value, timeout_seconds: Number(timeout.input.value), headers: object(headers.input.value, '请求头') }; if (Object.values(value.headers).some(v => typeof v !== 'string')) throw new Error('请求头值必须是字符串'); } catch (error) { d.error(error.message); return; }
    d.lock(true); try { const saved = await api(server ? `/mcp-servers/${server.id}` : '/mcp-servers', { method: server ? 'PUT' : 'POST', body: value }); d.element.close(); state.server = saved.id; clearTools(); await refreshMCP(); feedback('连接已保存，可测试连接并获取工具。'); } catch (error) { d.error(error.message); } finally { d.lock(false); } }); name.input.focus();
}
function archiveServer() {
  const server = state.servers.find(s => s.id === state.server); if (!server) return; const d = dialog('归档 MCP 服务器连接'); d.content.append(node('p', '', `归档“${server.name}”的连接配置？不会停止远端 MCP 服务。加密认证信息和测试记录保留；有效用例引用需要先替换或归档。`));
  d.actions.append(button('取消', () => d.element.close()), button('归档连接', async () => { d.lock(true); try { await api(`/mcp-servers/${server.id}/archive`, { method: 'POST' }); d.element.close(); state.server = ''; clearTools(); await refreshMCP(); } catch (error) { d.error(error.message); } finally { d.lock(false); } }, 'button danger'));
}
export async function openMCPCaseEditor(item = null, options = {}) {
  const d = dialog(item?.id ? '编辑 MCP 测试用例' : '新建 MCP 测试用例');
  const name = field('用例名称', item?.name || ''); name.input.required = true;
  const description = field('说明', item?.description || ''); const server = field('MCP 服务器', '', 'select'); server.input.required = true; server.input.add(new Option('请选择服务器', ''));
  const tool = field('工具名称', item?.mcp_request?.tool_name || ''); tool.input.required = true;
  const args = field('调用参数（JSON 对象）', pretty(item?.mcp_request?.arguments || {}), 'textarea'); args.input.rows = 6;
  const expected = field('预期工具结果', '', 'select'); for (const [value, text] of [['', '不设置预期'], ['false', '成功 · isError=false'], ['true', '业务错误 · isError=true']]) expected.input.add(new Option(text, value)); expected.input.value = item?.expected_is_error === undefined ? '' : String(item.expected_is_error);
  const output = field('校验 outputSchema', '', 'select'); output.input.add(new Option('不校验', 'false')); output.input.add(new Option('校验工具声明的返回结构', 'true')); output.input.value = String(item?.validate_output_schema || false);
  const assertions = field('MCP 断言（JSON 数组）', pretty(item?.assertions || []), 'textarea'); assertions.input.rows = 5;
  const variables = field('本次运行变量（JSON 对象）', '{}', 'textarea');
  d.content.append(name.wrap, description.wrap, server.wrap, tool.wrap, args.wrap, expected.wrap, output.wrap, assertions.wrap, node('p', 'subtle', '断言来源：structuredContent、text、isError、result；操作：equals、not_equals、contains、exists。路径示例：data.id。敏感参数建议填写 {{token}}，执行时传入变量。'), variables.wrap);
  const example = node('details'); example.append(node('summary', '', '查看断言示例'), node('pre', 'detail-code', '[{"source":"structuredContent","path":"status","operator":"equals","expected":"paid"}]')); d.content.append(example);
  if (pretty(item?.mcp_request || {}).includes('••••')) d.content.append(node('p', 'response-error', '此用例来自脱敏快照，请替换脱敏字段后再执行。'));
  d.actions.append(button(item?.id ? '保存修改' : '保存用例', () => { d.form.dataset.intent = 'save'; d.form.requestSubmit(); }, 'button primary'), button('仅运行本次', () => { d.form.dataset.intent = 'run'; d.form.requestSubmit(); }));
  d.lock(true);
  try { const servers = await api('/mcp-servers'); for (const s of servers) server.input.add(new Option(s.name, s.id)); const selected = item?.mcp_request?.server_id || state.server || servers[0]?.id || ''; if (selected && !servers.some(s => s.id === selected)) server.input.add(new Option('原服务器已删除，请重新选择', selected)); server.input.value = selected; } catch (error) { d.error(error.message); } finally { d.lock(false); }
  d.form.addEventListener('submit', async event => {
    event.preventDefault(); let value, values;
    try {
      const definitions = JSON.parse(assertions.input.value || '[]'); if (!Array.isArray(definitions)) throw new Error('断言需要是 JSON 数组'); values = object(variables.input.value, '运行变量'); if (Object.values(values).some(v => typeof v !== 'string')) throw new Error('运行变量值必须是字符串');
      value = { ...(item?.id ? { id: item.id, edit_version: item.edit_version, project_id: item.project_id } : {}), type: 'mcp', name: name.input.value, description: description.input.value, mcp_request: { server_id: server.input.value, tool_name: tool.input.value, arguments: object(args.input.value, '调用参数') }, assertions: definitions, validate_output_schema: output.input.value === 'true', ...(expected.input.value ? { expected_is_error: expected.input.value === 'true' } : {}) };
    } catch (error) { d.error(error.message); return; }
    d.lock(true); d.error(''); let batch;
    try {
      if (d.form.dataset.intent === 'run') {
        batch = options.batchID ? { id: options.batchID } : await api('/test-batches', { method: 'POST', body: { name: value.name } });
        await api(`/test-batches/${batch.id}/runs`, { method: 'POST', body: { test_case: value, variables: values } });
        if (!options.batchID) await api(`/test-batches/${batch.id}/finish`, { method: 'POST' });
      } else await api(item?.id ? `/test-cases/${item.id}` : '/test-cases', { method: item?.id ? 'PUT' : 'POST', body: value });
      d.element.close(); if (options.onSaved) await options.onSaved(batch?.id); else { const link = node('a', 'button', batch ? '查看测试结果' : '查看已保存用例'); link.href = batch ? `/tests?batch=${encodeURIComponent(batch.id)}` : '/tests?tab=cases'; link.dataset.route = ''; feedback(batch ? '测试已完成，结果已保存。' : '用例已保存。'); root.querySelector('[data-mcp-feedback]')?.append(' ', link); }
    } catch (error) { d.error(error.message); } finally { d.lock(false); }
  }); name.input.focus();
}
window.addEventListener('beforeunload', event => { if (dirty && activeDialog?.open) { event.preventDefault(); event.returnValue = ''; } });
