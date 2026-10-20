import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

test('execution links select the exact batch and expand HTTP, MCP, command and SQL records', async t => {
  const { JSDOM } = createRequire(import.meta.url)('jsdom');
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/requests' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, location: dom.window.location, history: dom.window.history, Option: dom.window.Option, localStorage: dom.window.localStorage });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {} });
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const now = new Date().toISOString();
  const request = { method: 'GET', url: 'http://localhost/example', query_params: [], headers: [], body_type: 'none' };
  const attempts = ['http', 'mcp', 'command'].map((type, i) => ({ id: `attempt-${i}`, type, name: type, request_snapshot: request, status: 'passed', assertions: [], started_at: now, mcp_request_snapshot: { server_id: 'server', tool_name: 'tool' }, command_request_snapshot: { program: 'node' } }));
  const counts = { total: 3, running: 0, passed: 3, failed: 0, errors: 0, unverified: 0 };
  const batch = { id: 'older-batch', name: '目标批次', status: 'completed', created_at: now, counts, runs: attempts };
  const newer = { ...batch, id: 'newer-batch', name: '另一个批次', runs: [] };
  const runs = [
    { id: 'api-one', batch_id: batch.id, test_run_id: attempts[0].id, step_id: 'different-mcp-session-step', request_snapshot: request, status: 'succeeded', response_status: 200, started_at: now },
    { id: 'api-two', batch_id: newer.id, test_run_id: 'another-attempt', request_snapshot: request, status: 'succeeded', started_at: now },
    { id: 'standalone', request_snapshot: request, status: 'failed', started_at: now },
  ];
  const flow = { id: 'flow', name: '数据库回归', edit_version: 1, updated_at: now, settings: { stop_on_error: true, request_timeout_ms: 60000 }, variables: [], steps: [] };
  const flowRun = { id: 'flow-run', flow_id: flow.id, flow_name_snapshot: flow.name, flow_version: 1, status: 'succeeded', created_at: now, total_steps: 1, variables: {}, steps: [{ id: 'sql-step', type: 'sql', name_snapshot: 'SQL 查询', status: 'succeeded', request_snapshot: {}, result: { columns: ['value'], rows: [{ value: 1 }], row_count: 1 }, assertions: [] }] };
  const sql = { id: 7, connection_id: 'db', connection_name: '测试库', mode: 'query', sql: 'SELECT 1', params: [], status: 'succeeded', started_at: now, duration_ms: 2, row_count: 1, flow_id: flow.id, flow_run_id: flowRun.id, step_id: 'sql-step' };
  let missingBatch = false;
  const writes = [];
  const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(value) });
  globalThis.fetch = async (path, options = {}) => {
    if (options.method && options.method !== 'GET') writes.push(path);
    if (path.startsWith('/api/activity?')) return response({ services: [], requests: [], events: [], service_logs: [], event_cursor: 0, service_cursor: 0, time: now });
    if (path.startsWith('/api/runs?')) return response(runs);
    if (path.startsWith('/api/runs/')) return response(runs.find(run => path.endsWith(run.id)));
    if (path === '/api/test-batches') return response([newer, batch]);
    if (path === `/api/test-batches/${batch.id}`) return missingBatch ? response({ error: '目标批次已不存在' }, 404) : response(batch);
    if (path === `/api/test-batches/${newer.id}`) return response(newer);
    if (path.startsWith('/api/database/executions/')) return response({ result: flowRun.steps[0].result });
    if (path === '/api/database/executions') return response([sql, { ...sql, id: 8, flow_id: '', flow_run_id: '', step_id: '' }]);
    if (path === '/api/flows') return response([{ ...flow, step_count: 1 }]);
    if (path === `/api/flows/${flow.id}`) return response(flow);
    if (path === `/api/flows/${flow.id}/runs`) return response([flowRun]);
    if (path === `/api/flow-runs/${flowRun.id}`) return response(flowRun);
    if (path === '/api/test-cases' || path.startsWith('/api/collections') || path.startsWith('/api/requests') || path === '/api/database/connections' || path === '/api/services') return response([]);
    throw new Error(`Unexpected request: ${path}`);
  };
  const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
  const navigate = async path => { history.pushState(null, '', path); window.dispatchEvent(new window.PopStateEvent('popstate')); await tick(); };
  const { executionBatchLink } = await import('./web/execution-batch.js');
  const testing = await import('./web/testing.js');
  try {
    await import('./web/app.js'); await tick();
    const rows = document.querySelectorAll('#requests tr');
    const links = [...rows].map(row => row.querySelector('a[data-route]'));
    assert.equal(new URL(links[0].href).searchParams.get('batch'), batch.id);
    assert.equal(new URL(links[0].href).searchParams.get('step'), attempts[0].id);
    assert.equal(new URL(links[1].href).searchParams.get('batch'), newer.id);
    assert.equal(links[2], null);
    assert.match(rows[2].textContent, /未关联批次/);
    links[0].click(); await tick();
    let target = document.getElementById(`test-attempt-${attempts[0].id}`);
    assert.equal(location.pathname, '/test-collections');
    assert.match(document.querySelector('.testing-detail h2').textContent, /目标批次/);
    assert.equal(target.open, true);
    assert.equal(document.activeElement, target);
    assert.equal(new URLSearchParams(location.search).get('step'), attempts[0].id);
    // Each protocol uses the same durable batch/run identifiers.
    for (const attempt of attempts.slice(1)) {
      const link = executionBatchLink({ batch_id: batch.id, test_run_id: attempt.id }); document.body.append(link);
      link.click(); await tick();
      target = document.getElementById(`test-attempt-${attempt.id}`);
      assert.equal(target.open, true); assert.equal(document.activeElement, target); link.remove();
    }
    // Opening request details also offers the same navigation and closes the dialog.
    await navigate('/requests');
    document.querySelector('[aria-label="查看请求 api-one"]').click(); await tick();
    assert.equal(document.getElementById('request-detail').open, true);
    document.querySelector('#detail-content a[data-route]').click(); await tick();
    assert.equal(document.getElementById('request-detail').open, false);
    assert.equal(document.getElementById(`test-attempt-${attempts[0].id}`).open, true);
    await navigate('/databases');
    const sqlLink = document.querySelector('#sql-executions a[data-route]');
    assert.equal(new URL(sqlLink.href).searchParams.get('run'), flowRun.id);
    assert.equal(new URL(sqlLink.href).searchParams.get('step'), sql.step_id);
    document.querySelector('.sql-result-button').click(); await tick();
    document.querySelector('#sql-result-context a[data-route]').click(); await tick();
    target = document.getElementById('flow-run-step-sql-step');
    assert.equal(document.getElementById('sql-result').open, false);
    assert.equal(new URLSearchParams(location.search).get('run'), flowRun.id);
    assert.equal(new URLSearchParams(location.search).get('step'), sql.step_id);
    assert.equal(target.querySelector('button').getAttribute('aria-expanded'), 'true');
    assert.equal(document.activeElement, target);
    // Deep links remain valid after reloading / navigating back.
    await testing.activateTesting();
    assert.equal(document.getElementById('flow-run-step-sql-step').querySelector('button').getAttribute('aria-expanded'), 'true');
    assert.equal(writes.length, 0, 'navigation must never rerun a request or SQL');
    missingBatch = true;
    await navigate(`/test-collections?batch=${batch.id}&step=${attempts[0].id}`);
    assert.match(document.querySelector('[data-testing-message]').textContent, /已不存在/);
  } finally { testing.deactivateTesting(); dom.window.close(); }
});
