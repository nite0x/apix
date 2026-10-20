import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

test('execution records list attempts, preserve snapshot drafts and retry a saved case without a case bank', async () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/tests?tab=records' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, Option: dom.window.Option });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const counts = { total: 2, passed: 1, failed: 1, errors: 0, running: 0, unverified: 0 };
  const batch = { id: 'batch-1', name: '用户接口参数验证', created_at: new Date().toISOString(), status: 'completed', counts, runs: [
    { id: 'r1', name: '正常邮箱', request_snapshot: { method: 'POST', url: 'http://localhost/users', body: '{"email":"a@b.com"}' }, assertions: [{ kind: 'status', expected: 201, actual: 201, passed: true }], assertion_definitions: [], expected_status: 201, status: 'passed', started_at: new Date().toISOString(), case_version: 1, case_id: 'case-1' },
    { id: 'r2', name: '缺少邮箱', request_snapshot: { method: 'POST', url: 'http://localhost/users', body: '{}' }, assertions: [{ kind: 'status', expected: 400, actual: 500, passed: false }], assertion_definitions: [], status: 'failed', started_at: new Date().toISOString() },
  ] };
  const saved = { id: 'case-1', name: '正常邮箱', edit_version: 1, request: batch.runs[0].request_snapshot, assertions: [], expected_status: 201 };
  const writes = []; const reads = [];
  globalThis.fetch = async (path, options = {}) => {
    let body = []; if (!options.method) reads.push(path);
    if (options.method) {
      const input = options.body ? JSON.parse(options.body) : {}; writes.push({ path, method: options.method, input });
      if (path === '/api/test-cases') { Object.assign(saved, input, { id: 'case-1', edit_version: 1 }); body = saved; }
      else if (path === '/api/test-batches') body = { ...batch, id: 'new-batch', status: 'running' };
      else if (path.endsWith('/runs')) body = { batch_id: 'new-batch', test_status: 'passed' };
      else body = { ...batch, id: 'new-batch' };
    } else if (path === '/api/test-batches') body = [batch];
    else if (path.startsWith('/api/test-batches/')) body = { ...batch, id: path.endsWith('new-batch') ? 'new-batch' : batch.id };
    else if (path === '/api/test-cases') body = [saved];
    return { status: 200, ok: true, json: async () => structuredClone(body) };
  };
  const module = await import('./web/testing.js');
  const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
  const click = (text, scope = '#testing-workspace') => { const node = [...document.querySelectorAll(`${scope} button`)].find(node => node.textContent === text); assert.ok(node, text); node.click(); };
  const set = (label, value) => { const node = document.querySelector(`[aria-label="${label}"]`); assert.ok(node, label); node.value = value; node.dispatchEvent(new window.Event('input', { bubbles: true })); };
  await module.activateTesting();
  assert.equal(document.querySelectorAll('.test-endpoint').length, 0);
  assert.equal(document.querySelectorAll('.test-attempt').length, 2);
  assert.match(document.querySelector('.testing-summary').textContent, /断言失败1.*执行错误0.*通过1/);
  assert.match(document.querySelector('#testing-workspace').textContent, /缺少邮箱/);
  document.querySelector('.test-attempt').click();
  click('另存为用例', '.test-run-drawer'); set('用例名称', '缺少用户名'); set('请求地址', 'http://localhost/users'); set('预期状态码', '400');
  await module.refreshTesting();
  assert.equal(document.querySelector('[aria-label="用例名称"]').value, '缺少用户名');
  document.querySelector('.testing-editor form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  const write = writes.find(item => item.path === '/api/test-cases'); assert.ok(write); assert.equal(write.input.expected_status, 400);
  click('重试用例', '.test-run-drawer');
  document.querySelector('.testing-editor form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  assert.ok(writes.some(item => item.path === '/api/test-batches/new-batch/runs' && item.input.case_id === 'case-1'));
  assert.ok(writes.some(item => item.path.endsWith('/new-batch/finish')));
  history.replaceState(null, '', '/flows'); await module.activateTesting(); await tick();
  assert.equal(document.querySelector('.test-cases'), null);
  assert.equal(document.querySelector('[data-case-action]'), null);
  assert.equal(reads.includes('/api/test-cases'), false);
  assert.equal(writes.some(item => item.method === 'DELETE'), false);
  module.deactivateTesting(); dom.window.close();
});
