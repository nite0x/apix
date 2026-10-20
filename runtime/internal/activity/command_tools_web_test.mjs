import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

test('command workspace validates arguments, executes once, retains drafts, and shares cases and run snapshots', async () => {
  const { JSDOM } = createRequire(import.meta.url)('jsdom');
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/commands' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, Option: dom.window.Option });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const writes = []; const cases = []; let releaseCall; let failSave = false;
  const batch = { id: 'command-batch', name: 'script regression', status: 'completed', created_at: new Date().toISOString(), counts: { total: 1, passed: 1, failed: 0, errors: 0, unverified: 0, running: 0 }, runs: [] };
  globalThis.fetch = async (path, options = {}) => {
    const input = options.body ? JSON.parse(options.body) : {}; if (options.method) writes.push({ path, input, method: options.method }); let value;
    if (path === '/api/commands/environment') value = { platform: 'linux', work_dir: '/home/test', output_limit: 262144 };
    else if (path === '/api/test-batches' && options.method === 'POST') value = { ...batch, status: 'running' };
    else if (path.endsWith('/runs')) {
      await new Promise(resolve => { releaseCall = resolve; });
      const item = input.test_case || cases[0]; const result = { exit_code: 0, stdout: '<script>attack()</script>', stderr: 'diagnostic', duration_ms: 15 };
      const assertions = [{ kind: 'exit_code', operator: 'equals', expected: 0, actual: 0, passed: true }];
      batch.runs = [{ id: 'command-run', type: 'command', name: item.name, command_request_snapshot: item.command_request, expected_exit_code: 0, command_result: result, request_snapshot: {}, status: 'passed', assertions, assertion_definitions: item.assertions || [], started_at: new Date().toISOString(), case_id: cases[0]?.id }];
      value = { type: 'command', test_status: 'passed', command_result: result, assertions, duration_ms: 15, batch_id: batch.id, test_run_id: 'command-run' };
    } else if (path === '/api/test-cases' && options.method === 'POST') {
      if (failSave) return { status: 400, ok: false, json: async () => ({ error: 'save failed' }) };
      value = { ...input, id: 'command-case', edit_version: 1 }; cases.push(value);
    } else if (path === '/api/test-cases') value = cases;
    else if (path === '/api/flows') value = [];
    else if (path === '/api/test-batches') value = [batch];
    else if (path.startsWith('/api/test-batches/')) value = batch;
    else value = {};
    return { status: 200, ok: true, json: async () => structuredClone(value) };
  };
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const fill = (label, value, scope = '#command-workspace') => { const input = document.querySelector(`${scope} [aria-label="${label}"]`); assert.ok(input, label); input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const click = (text, scope = '#command-workspace') => { const b = [...document.querySelectorAll(`${scope} button`)].find(b => b.textContent === text); assert.ok(b, text); b.click(); };
  const module = await import('./web/command-tools.js'); await module.refreshCommands();
  assert.match(document.querySelector('[data-command-environment]').textContent, /linux.*\/home\/test/);
  fill('测试名称', 'inline python'); fill('执行程序', 'python3'); fill('启动参数（JSON 数组）', '["-"]'); fill('标准输入 / 脚本正文', 'print("done")');
  fill('启动参数（JSON 数组）', '[123]'); click('执行命令'); await tick(); assert.match(document.querySelector('[data-command-notice]').textContent, /字符串 JSON 数组/); assert.equal(writes.length, 0);
  fill('启动参数（JSON 数组）', '["-"]'); click('执行命令'); await tick(); click('执行命令'); assert.equal(writes.filter(w => w.path.endsWith('/runs')).length, 1);
  releaseCall(); await tick(); assert.ok(writes.some(w => w.path.endsWith('/finish'))); assert.match(document.querySelector('[data-command-result]').textContent, /退出码 0.*15 ms/); assert.equal(document.querySelectorAll('[data-command-result] script').length, 0);
  const link = document.querySelector('[data-command-result] a[data-route]'); assert.equal(link.textContent, '查看执行批次'); assert.equal(new URL(link.href).searchParams.get('batch'), batch.id); assert.equal(new URL(link.href).searchParams.get('step'), 'command-run');
  await module.refreshCommands(); assert.equal(document.querySelector('[aria-label="标准输入 / 脚本正文"]').value, 'print("done")');
  failSave = true; click('保存测试用例'); await tick(); assert.match(document.querySelector('[data-command-notice]').textContent, /save failed/); assert.equal(document.querySelector('[aria-label="执行程序"]').value, 'python3');
  failSave = false; click('保存测试用例'); await tick(); assert.equal(cases[0].type, 'command'); assert.deepEqual(cases[0].command_request.args, ['-']); assert.equal(cases[0].expected_exit_code, 0);
  history.replaceState(null, '', '/tests?tab=cases'); const testing = await import('./web/testing.js'); await testing.activateTesting();
  assert.equal(document.querySelector('.test-cases'), null);
  history.replaceState(null, '', '/execution-records'); await testing.activateTesting(); await tick(); assert.match(document.querySelector('.testing-run-target').textContent, /命令行 · python3/);
  document.querySelector('.test-attempt').click();
  document.querySelector('[data-run-tab="output"]').click();
  assert.match(document.querySelector('#test-run-panel-output').textContent, /退出码 0/); assert.equal(document.querySelectorAll('.test-run-drawer script').length, 0);
  click('另存为用例', '.test-run-drawer'); assert.equal(document.querySelector('dialog[open] [aria-label="执行程序"]').value, 'python3'); fill('标准输入 / 脚本正文', 'print("edited draft")', 'dialog[open]'); await testing.refreshTesting(); assert.equal(document.querySelector('dialog[open] [aria-label="标准输入 / 脚本正文"]').value, 'print("edited draft")'); click('关闭 ×', 'dialog[open]');
  testing.deactivateTesting(); dom.window.close();
});
