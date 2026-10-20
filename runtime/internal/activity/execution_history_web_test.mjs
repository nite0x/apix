import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachExecutionHistory } from './web/execution-history.js';

const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

for (const kind of ['command', 'mcp']) {
 test(kind + ' history tabs preserve drafts, filter records and load details only when opened', async () => {
  const path = kind === 'command' ? '/commands' : '/mcp-tools';
  const dom = new JSDOM('<div id="workspace"><input value="keep draft"></div>', { url: 'http://localhost' + path });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, Option: dom.window.Option });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const requests = []; let failed = false; let detailFailed = false;
  const item = { id: 'run-1', type: kind, name: '原始执行', target: kind === 'command' ? 'python3' : 'lookup', batch_id: 'batch-1', batch_name: '回归批次', status: 'passed', duration_ms: 12, started_at: new Date().toISOString() };
  globalThis.fetch = async url => {
   requests.push(url);
   if (failed || detailFailed && url.endsWith('/run-1')) return { ok: false, status: 500, json: async () => ({ error: 'history unavailable' }) };
   return { ok: true, status: 200, json: async () => structuredClone(url.includes('?type=') ? [item] : { ...item, command_request_snapshot: { program: 'python3' }, command_result: { exit_code: 0, stdout: '<em>literal</em>', stderr: '' }, mcp_request_snapshot: { server_id: 'server-1', tool_name: 'lookup' }, mcp_result: { text: '<em>literal</em>' }, assertions: [] }) };
  };
  const root = document.getElementById('workspace');
  const controller = attachExecutionHistory(root, kind, '执行');
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const click = text => { const target = [...document.querySelectorAll('button')].find(n => n.textContent === text); assert.ok(target, text); target.click(); };
  try {
   assert.equal(requests.length, 0);
   tabs[1].click(); await tick();
   assert.equal(root.querySelector('[role="tabpanel"]').hidden, true);
   assert.equal(new URLSearchParams(location.search).get('tab'), 'history');
   assert.deepEqual(requests, ['/api/test-runs?type=' + kind]);
   assert.match(root.querySelector('tbody').textContent, /原始执行.*12 ms.*回归批次/s);
   const search = root.querySelector('input[type="search"]'); search.value = '不存在'; search.dispatchEvent(new window.Event('input'));
   assert.match(root.querySelector('tbody').textContent, /没有符合/);
   search.value = '回归'; search.dispatchEvent(new window.Event('input'));
   const status = root.querySelector('select'); status.value = 'error'; status.dispatchEvent(new window.Event('change'));
   assert.match(root.querySelector('tbody').textContent, /没有符合/);
   status.value = ''; status.dispatchEvent(new window.Event('change'));
   detailFailed = true; click('查看详情'); await tick();
   assert.match(document.querySelector('dialog').textContent, /history unavailable/);
   detailFailed = false; click('重试读取'); await tick();
   const detail = document.querySelector('dialog');
   assert.match(detail.textContent, /literal/); assert.equal(detail.querySelector('em'), null);
   assert.equal(detail.querySelector('a').getAttribute('href'), '/execution-records?batch=batch-1');
   await controller.refresh(); assert.equal(detail.open, true);
   click('关闭 ×');
   failed = true; click('刷新记录'); await tick();
   assert.match(root.querySelector('[role="alert"]').textContent, /history unavailable/);
   failed = false; click('刷新记录'); await tick();
   assert.equal(root.querySelector('[role="alert"]').hidden, true);
   tabs[0].click();
   assert.equal(root.querySelector('input').value, 'keep draft');
   assert.equal(root.querySelector('[role="tabpanel"]').hidden, false);
   tabs[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await tick();
   assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  } finally { dom.window.close(); }
 });
}
