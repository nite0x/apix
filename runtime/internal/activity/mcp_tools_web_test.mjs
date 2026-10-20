import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

test('MCP workspace discovers tools, preserves drafts, prevents duplicate calls, and shares saved cases and history', async () => {
  const { JSDOM } = createRequire(import.meta.url)('jsdom');
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/mcp-tools' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, Option: dom.window.Option });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const servers = [{ id: 'server-1', name: 'Orders', url: 'http://localhost/mcp', timeout_seconds: 30, edit_version: 1, headers: { Authorization: '••••••' } }];
  const tool = { name: 'get_order', description: '<img src=x onerror=alert(1)>', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, outputSchema: { type: 'object' } };
  const savedCases = []; const writes = []; let failDiscovery = false; let releaseCall;
  const batch = { id: 'batch-1', name: 'MCP regression', status: 'completed', created_at: new Date().toISOString(), counts: { total: 1, passed: 1, failed: 0, errors: 0, unverified: 0, running: 0 }, runs: [] };
  globalThis.fetch = async (path, options = {}) => {
    const input = options.body ? JSON.parse(options.body) : {};
    if (options.method) writes.push({ path, input, method: options.method });
    let result;
    if (path === '/api/mcp-servers') result = servers;
    else if (path.endsWith('/discover')) {
      if (failDiscovery) return { status: 400, ok: false, json: async () => ({ error: 'handshake failed' }) };
      result = { server_name: 'fixture', tools: [tool], duration_ms: 12 };
    } else if (path === '/api/test-cases' && options.method === 'POST') { result = { ...input, id: 'case-1', edit_version: 1 }; savedCases.push(result); }
    else if (path === '/api/test-cases') result = savedCases;
    else if (path === '/api/test-batches' && options.method === 'POST') result = { ...batch, status: 'running' };
    else if (path === '/api/test-batches') result = [batch];
    else if (path.endsWith('/runs')) {
      await new Promise(resolve => { releaseCall = resolve; });
      const definition = input.test_case || savedCases[0];
      batch.runs.push({ id: 'run-1', type: 'mcp', name: definition.name, status: 'passed', request_snapshot: {}, mcp_request_snapshot: definition.mcp_request, mcp_result: { server: servers[0], response: { structuredContent: { status: '<script>attack()</script>' } } }, expected_is_error: false, assertions: [{ kind: 'isError', operator: 'equals', expected: false, actual: false, passed: true }], assertion_definitions: [], started_at: new Date().toISOString() });
      result = { type: 'mcp', batch_id: batch.id, test_run_id: batch.runs.at(-1).id, test_status: 'unverified', duration_ms: 15, mcp_result: batch.runs.at(-1).mcp_result };
    } else if (path.startsWith('/api/test-batches/')) result = batch;
    else if (options.method === 'PUT') { Object.assign(servers[0], input, { edit_version: 2 }); result = servers[0]; }
    else result = {};
    return { status: 200, ok: true, json: async () => structuredClone(result) };
  };
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const click = (text, scope = '#mcp-workspace') => { const b = [...document.querySelectorAll(`${scope} button`)].find(b => b.textContent === text); assert.ok(b, text); b.click(); };
  const fill = (label, value) => { const input = document.querySelector(`[aria-label="${label}"]`); assert.ok(input, label); input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const module = await import('./web/mcp-tools.js'); await module.refreshMCP();
  click('测试连接并获取工具'); await tick();
  assert.match(document.querySelector('[data-mcp-feedback]').textContent, /连接成功/);
  assert.equal(document.querySelectorAll('#mcp-workspace img').length, 0);
  fill('id *', '10001'); assert.deepEqual(JSON.parse(document.querySelector('[aria-label="调用参数（JSON 对象）"]').value), { id: '10001' });
  await module.refreshMCP(); assert.match(document.querySelector('[aria-label="调用参数（JSON 对象）"]').value, /10001/);
  click('执行工具'); await tick(); click('执行工具'); await tick();
  assert.equal(writes.filter(w => w.path.endsWith('/runs')).length, 1);
  releaseCall(); await tick(); assert.ok(writes.some(w => w.path.endsWith('/finish'))); assert.match(document.querySelector('.mcp-live-result').textContent, /未验证/);
  const link = document.querySelector('.mcp-live-result a[data-route]'); assert.equal(link.textContent, '查看执行批次'); assert.equal(new URL(link.href).searchParams.get('batch'), batch.id); assert.equal(new URL(link.href).searchParams.get('step'), 'run-1');
  click('保存为测试用例'); await tick();
  fill('用例名称', 'order paid'); fill('MCP 断言（JSON 数组）', '[{"source":"structuredContent","path":"status","operator":"equals","expected":"paid"}]');
  click('保存用例', 'dialog[open]'); await tick(); assert.equal(savedCases[0].type, 'mcp'); assert.equal(savedCases[0].mcp_request.tool_name, 'get_order');
  click('编辑连接'); await tick(); fill('服务器名称', 'Orders updated'); click('保存连接', 'dialog[open]'); await tick();
  assert.equal(writes.find(w => w.method === 'PUT').input.headers.Authorization, '••••••');
  failDiscovery = true; click('测试连接并获取工具'); await tick(); assert.match(document.querySelector('[data-mcp-feedback]').textContent, /handshake failed/);
  failDiscovery = false; click('测试连接并获取工具'); await tick(); assert.match(document.querySelector('[data-mcp-feedback]').textContent, /连接成功/);
  history.replaceState(null, '', '/tests?tab=cases');
  const testing = await import('./web/testing.js'); await testing.activateTesting();
  assert.match(document.querySelector('#testing-workspace').textContent, /MCP · get_order/);
  click('编辑', '#testing-workspace'); await tick(); assert.equal(document.querySelector('dialog[open] [aria-label="工具名称"]').value, 'get_order'); click('关闭 ×', 'dialog[open]');
  click('执行记录', '#testing-workspace'); await tick();
  assert.match(document.querySelector('.test-endpoint').textContent, /MCP .*get_order/);
  assert.match(document.querySelector('.test-attempt-body').textContent, /MCP 返回结果/); assert.equal(document.querySelectorAll('#testing-workspace script').length, 0);
  testing.deactivateTesting(); dom.window.close();
});
