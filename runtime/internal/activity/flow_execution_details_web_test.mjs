import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

test('execution records show SQL inputs and rows, service operations, and HTTP details by type', async t => {
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/tests?tab=records&type=flow&id=flow-1&run=run-1' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, Option: dom.window.Option });
  const now = '2026-10-20T10:00:00Z';
  const step = (id, type, extra = {}) => ({ id, type, name_snapshot: id, status: 'succeeded', started_at: now, finished_at: now, ...extra });
  const query = { connection_id: 'db-1', mode: 'query', sql: 'SELECT name, active FROM users WHERE id=?', params: [42], max_rows: 100 };
  const run = { id: 'run-1', flow_name_snapshot: 'Mixed operations', flow_version: 1, status: 'succeeded', started_at: now, finished_at: now, total_steps: 10, steps: [
    step('query', 'sql', { sql_snapshot: query, result: { columns: ['name', 'active', 'optional'], rows: [{ name: '<img src=x onerror=alert(1)>', active: false, optional: null }], row_count: 1, duration_ms: 12 } }),
    step('update', 'sql', { sql_snapshot: { ...query, mode: 'exec', sql: 'UPDATE users SET active=1' }, result: { rows_affected: 0, duration_ms: 2 } }),
    step('empty', 'sql', { sql_snapshot: query, result: { columns: ['name'], rows: [], row_count: 0 } }),
    step('truncated', 'sql', { sql_snapshot: query, result: { columns: ['name'], rows: [{ name: 'saved' }], row_count: -1, truncated: true } }),
    step('sql-error', 'sql', { status: 'failed', sql_snapshot: query, error_message: 'query refused' }),
    step('start', 'service', { service_snapshot: { service_id: 'app', action: 'start' }, result: { service_id: 'app', status: 'running', pid: 42, owner: 'run-1', started: true } }),
    step('reuse', 'service', { service_snapshot: { service_id: 'app', action: 'start' }, result: { service_id: 'app', status: 'running', owner: 'external', started: false } }),
    step('stop', 'service', { service_snapshot: { service_id: 'app', action: 'stop' }, result: { service_id: 'app', status: 'stopped', pid: 0 } }),
    step('service-error', 'service', { status: 'cancelled', service_snapshot: { service_id: 'app', action: 'stop' } }),
    step('http', 'http', { api_run_id: 'api-1', request_snapshot: { method: 'GET', url: 'http://localhost/health' } }),
  ] };
  const flow = { id: 'flow-1', name: 'Mixed operations', steps: [], variables: [], settings: {}, edit_version: 1 };
  const fetched = [];
  globalThis.fetch = async url => {
    fetched.push(url);
    const routes = { '/api/flows/flow-1': flow, '/api/flow-runs/run-1': run, '/api/flows/flow-1/runs': [run], '/api/flows': [flow], '/api/database/connections': [], '/api/services': [], '/api/runs/api-1': { id: 'api-1', response_status: 200, duration_ms: 1, request_snapshot: run.steps.at(-1).request_snapshot, response_body: { ok: true } } };
    assert.ok(Object.hasOwn(routes, url), url);
    return { ok: true, status: 200, json: async () => structuredClone(routes[url]) };
  };
  const flows = await import('./web/flows.js');
  t.after(() => { flows.deactivateFlows(); dom.window.close(); });
  await flows.activateFlows();
  await new Promise(resolve => setImmediate(resolve));
  for (const control of [...document.querySelectorAll('.fw-result-toggle')]) if (control.getAttribute('aria-expanded') === 'false') {
    // Rendering replaces the cards; locate the current control each time.
    const current = [...document.querySelectorAll('.fw-result-toggle')].find(item => item.textContent === control.textContent);
    current.click();
  }
  const card = name => [...document.querySelectorAll('.fw-run-step')].find(item => item.querySelector('strong').textContent === name);
  assert.match(card('query').textContent, /SQL 执行快照/);
  assert.match(card('query').textContent, /SELECT name, active FROM users WHERE id=\?/);
  assert.match(card('query').textContent, /绑定参数/);
  assert.match(card('query').textContent, /42/);
  assert.deepEqual([...card('query').querySelectorAll('tbody td')].map(item => item.textContent), ['<img src=x onerror=alert(1)>', 'false', 'NULL']);
  assert.equal(card('query').querySelector('img'), null);
  assert.match(card('update').textContent, /影响行数0/);
  assert.equal(card('update').querySelector('table'), null);
  assert.match(card('empty').textContent, /返回 0 行/);
  assert.match(card('truncated').textContent, /总行数未知/);
  assert.match(card('truncated').textContent, /只展示已保存/);
  assert.match(card('sql-error').textContent, /query refused/);
  assert.match(card('sql-error').textContent, /绑定参数/);
  assert.match(card('start').textContent, /服务操作快照/);
  assert.match(card('start').textContent, /进程 PID42/);
  assert.match(card('start').textContent, /本次执行启动了服务/);
  assert.match(card('reuse').textContent, /本次执行复用了已有服务/);
  assert.match(card('stop').textContent, /停止操作已完成/);
  assert.match(card('service-error').textContent, /步骤已跳过或取消/);
  for (const name of ['query', 'update', 'sql-error', 'start', 'reuse', 'stop', 'service-error']) assert.doesNotMatch(card(name).textContent, /请求与响应|HTTP|响应头/);
  assert.match(card('http').textContent, /HTTP 200/);
  assert.ok(card('http').querySelector('button.fw-text-button'));
  assert.equal(fetched.filter(url => url.startsWith('/api/runs/')).length, 1);

  run.steps = [step('legacy-sql', 'sql', { status: 'failed' }), step('legacy-service', 'service', { status: 'running' })];
  [...document.querySelectorAll('button')].find(item => item.textContent === '刷新结果').click();
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  document.querySelectorAll('.fw-result-toggle')[1].click();
  assert.match(card('legacy-sql').textContent, /没有保存 SQL 输入快照/);
  assert.match(card('legacy-service').textContent, /没有保存服务操作快照/);
  assert.match(card('legacy-service').textContent, /步骤正在执行或等待确认/);
});
