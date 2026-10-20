import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('execution records combine filters, keep drawer context while polling, and retain durable deep links', async t => {
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/execution-records' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, Option: dom.window.Option });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector('button')?.focus(); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const now = '2026-10-20T11:37:50Z';
  const base = { request_snapshot: { method: 'GET', url: 'http://localhost/health' }, assertions: [], started_at: now, finished_at: '2026-10-20T11:37:51Z' };
  const batch = { id: 'batch-1', name: '协议回归', created_at: now, status: 'completed', counts: { total: 4, passed: 1, failed: 1, errors: 1, running: 1, unverified: 0 }, runs: [
    { ...base, id: 'passed', name: '健康检查', status: 'passed' },
    { ...base, id: 'failed', name: '状态码校验', status: 'failed', assertions: [{ kind: 'status', operator: 'equals', expected: 201, actual: 200, passed: false }] },
    { ...base, id: 'error', type: 'command', name: '连接错误', status: 'error', error_message: '<img src=x> connection refused', command_request_snapshot: { program: 'python3' }, command_result: { exit_code: 1, duration_ms: 12, stdout: 'output', stderr: 'failed' } },
    { ...base, id: 'running', name: '等待响应', status: 'running', finished_at: undefined },
  ] };
  const flow = { ...batch, id: 'flow-batch', source: 'flow', name: '订单流程', runs: [] };
  const reads = []; const writes = [];
  t.mock.method(globalThis, 'fetch', async (path, options = {}) => {
    if (options.method) writes.push(path); else reads.push(path);
    return { ok: true, status: 200, json: async () => structuredClone(path === '/api/test-batches' ? [batch, flow] : path.endsWith('/flow-batch') ? flow : batch) };
  });
  const testing = await import('./web/testing.js');
  const field = (label, value, event = 'input') => { const input = document.querySelector(`[aria-label="${label}"]`); input.value = value; input.dispatchEvent(new window.Event(event, { bubbles: true })); return input; };
  const results = () => [...document.querySelectorAll('.test-attempt')].map(node => node.id);
  try {
    await testing.activateTesting();
    assert.equal(document.querySelector('.heading-actions [data-batch-action]').textContent, '＋ 新建集合测试');
    assert.deepEqual(results(), ['test-attempt-passed', 'test-attempt-failed', 'test-attempt-error', 'test-attempt-running']);
    assert.equal(document.querySelector('.test-endpoint'), null, 'default presentation must preserve execution order');
    assert.equal(document.querySelector('.testing-detail pre'), null, 'snapshots must not expand the results list');
    assert.match(document.querySelector('.testing-batch-counts').textContent, /通过 1 · 断言失败 1 · 执行错误 1/);
    assert.equal(document.querySelector('[data-filter="failed"] strong').textContent, '1');
    assert.equal(document.querySelector('[data-filter="error"] strong').textContent, '1');
    assert.match(document.getElementById('test-attempt-failed').textContent, /预期 201，实际 200/);
    field('筛选记录类型', 'flow', 'change');
    assert.equal(document.querySelectorAll('.testing-batch').length, 1);
    assert.match(document.querySelector('.testing-batch').textContent, /订单流程/);
    field('搜索执行记录', '不存在');
    assert.equal(document.querySelectorAll('.testing-batch').length, 0);
    field('搜索执行记录', ''); field('筛选记录类型', 'all', 'change');
    field('结果展示方式', 'issues', 'change');
    assert.deepEqual(results().slice(0, 2), ['test-attempt-failed', 'test-attempt-error']);
    field('搜索执行用例', 'refused');
    assert.deepEqual(results(), ['test-attempt-error']);
    document.querySelector('[data-filter="failed"]').click();
    assert.equal(results().length, 0, 'search and status filters must be combined');
    document.querySelector('[data-filter="all"]').click(); field('搜索执行用例', '');
    field('结果展示方式', 'target', 'change'); assert.equal(document.querySelectorAll('.test-endpoint').length, 2);
    document.getElementById('test-attempt-error').click();
    const drawer = document.querySelector('.test-run-drawer');
    assert.equal(drawer.open, true); assert.equal(new URLSearchParams(location.search).get('step'), 'error');
    assert.match(drawer.querySelector('.testing-run-conclusion').textContent, /<img src=x> connection refused/);
    assert.equal(drawer.querySelector('img'), null, 'execution text must never become HTML');
    const outputTab = drawer.querySelector('[data-run-tab="output"]'); outputTab.focus();
    outputTab.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.equal(document.activeElement.dataset.runTab, 'assertions');
    drawer.querySelector('[data-run-tab="output"]').click();
    drawer.querySelector('.detail-content').scrollTop = 80;
    batch.runs[2].command_result.stderr = 'updated diagnostic';
    batch.runs[3].status = 'passed'; batch.counts.running = 0; batch.counts.passed = 2;
    await testing.refreshTesting();
    assert.equal(document.querySelector('.test-run-drawer'), drawer, 'polling must preserve the open modal');
    assert.equal(drawer.open, true); assert.equal(drawer.querySelector('[data-run-tab="output"]').getAttribute('aria-selected'), 'true');
    assert.match(drawer.querySelector('#test-run-panel-output').textContent, /updated diagnostic/);
    assert.equal(drawer.querySelector('.detail-content').scrollTop, 80);
    assert.equal(document.querySelector('[data-filter="passed"] strong').textContent, '2');
    drawer.dispatchEvent(new window.Event('cancel', { cancelable: true }));
    assert.equal(document.querySelector('.test-run-drawer'), null);
    assert.equal(document.activeElement.id, 'test-attempt-error');
    assert.equal(new URLSearchParams(location.search).has('step'), false);
    field('结果展示方式', 'sequence', 'change');
    const search = field('搜索执行用例', '健康'); search.focus(); search.setSelectionRange(1, 1);
    batch.name = '协议回归 · 已更新'; await testing.refreshTesting();
    assert.equal(document.activeElement.getAttribute('aria-label'), '搜索执行用例');
    assert.equal(document.activeElement.value, '健康'); assert.equal(document.activeElement.selectionStart, 1);
    history.replaceState(null, '', '/execution-records?batch=batch-1&step=failed');
    await testing.activateTesting();
    assert.equal(document.querySelector('.test-run-drawer').open, true);
    assert.match(document.querySelector('#test-run-title').textContent, /状态码校验/);
    assert.equal(document.querySelector('[aria-label="搜索执行用例"]').value, '', 'a deep-linked attempt must be visible despite a prior search');
    assert.equal(writes.length, 0, 'browsing must not repeat executions');
    assert.equal(reads.some(path => path.includes('/test-runs/')), false, 'batch snapshots already contain attempt details');
  } finally { testing.deactivateTesting(); dom.window.close(); }
});
