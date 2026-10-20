import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { blankStep } from './web/flow-model.js';

const tick = async () => { for (let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve)); };

test('separate flow and execution record pages preserve deep links, navigation state and drafts', async t => {
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/flows?id=flow-1&run=flow-run-1' });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {} });
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, Option: dom.window.Option, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage });
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const step = blankStep(); step.request.url = 'http://localhost/health';
  const flow = { id: 'flow-1', name: '订单业务验证', description: '', variables: [], settings: { stop_on_error: true, request_timeout_ms: 60000 }, steps: [step], edit_version: 1, updated_at: new Date().toISOString() };
  const run = { id: 'flow-run-1', flow_id: flow.id, flow_name_snapshot: flow.name, flow_version: 1, total_steps: 1, status: 'succeeded', created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: new Date().toISOString(), steps: [] };
  const batch = { id: 'batch-1', name: '参数回归', status: 'running', created_at: new Date().toISOString(), counts: { total: 1, passed: 1, failed: 0, errors: 0, unverified: 0, running: 0 }, runs: [{ id: 'attempt-1', name: '正常参数', status: 'passed', request_snapshot: { method: 'GET', url: 'http://localhost/health' }, assertions: [], started_at: new Date().toISOString() }] };
  const flowBatch = { ...batch, id: run.id, source: 'flow', name: flow.name, status: 'completed' };
  const saved = { id: 'case-1', name: '健康检查', request: { method: 'GET', url: 'http://localhost/health' }, assertions: [], edit_version: 1 };
  const writes = []; let conflict = false; let recordFailure = false;
  const result = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
  globalThis.fetch = async (path, options = {}) => {
    if (options.method) writes.push({ path, method: options.method, body: JSON.parse(options.body || '{}') });
    if (path.startsWith('/api/activity?')) return result({ services: [], requests: [], events: [], service_logs: [], event_cursor: 0, service_cursor: 0, time: new Date().toISOString() });
    if (path === '/api/flows') return result([{ ...flow, step_count: 1 }]);
    if (path === '/api/flows/flow-1' && options.method === 'PUT') {
      if (conflict) return result({ error: 'flow version conflict' }, 409);
      Object.assign(flow, JSON.parse(options.body), { edit_version: flow.edit_version + 1 }); return result(flow);
    }
    if (path === '/api/flows/flow-1') return result(flow);
    if (path.startsWith('/api/flows/flow-1/runs')) {
      if (options.method === 'POST') return result({ ...run, id: 'flow-run-2' }, 202);
      if (recordFailure) return result({ error: 'history unavailable' }, 500);
      return result([run]);
    }
    if (path.startsWith('/api/flow-runs/')) return result({ ...run, id: path.split('/').at(-1) });
    if (path === '/api/test-batches') return recordFailure ? result({ error: 'history unavailable' }, 500) : result([batch, flowBatch]);
    if (path === '/api/test-batches/' + flowBatch.id) return result(flowBatch);
    if (path === '/api/test-cases') return result([saved]);
    if (path === '/api/test-batches/batch-1') return result(batch);
    if (path === '/api/test-cases' || path === '/api/database/connections' || path === '/api/services') return result([]);
    throw new Error('Unexpected request: ' + path);
  };
  const click = async text => {
    const button = ['流程', '执行记录'].includes(text) ? document.querySelector('.page-nav a[aria-label="' + text + '"]') : [...document.querySelectorAll('#testing-workspace button')].find(node => node.textContent === text && !node.closest('[hidden]'));
    assert.ok(button, text); button.click(); await tick();
  };
  const selected = key => document.querySelector('.page-nav a[aria-label="' + (key === 'records' ? '执行记录' : '流程') + '"]').getAttribute('aria-current') === 'page' ? 'true' : 'false';
  const flows = await import('./web/flows.js');
  const testing = await import('./web/testing.js');
  try {
    await import('./web/app.js'); await tick();
    assert.equal(location.pathname, '/execution-records');
    assert.equal(new URLSearchParams(location.search).get('run'), run.id);
    assert.equal(document.title, 'Apix · 执行记录');
    assert.equal(document.querySelectorAll('[data-test-tab]').length, 0);
    assert.equal(document.querySelectorAll('.page-nav a[href="/flows"]').length, 1);
    assert.equal(document.querySelectorAll('.page-nav a[href="/execution-records"]').length, 1);
    assert.equal(document.querySelector('[data-testing-type]'), null);
    assert.equal(document.querySelector('[data-test-tab="batches"]'), null);
    assert.equal(document.querySelector('.page-nav a[href="/test-collections"]'), null);
    assert.equal(selected('records'), 'true');
    assert.ok(document.querySelector('.fw-run-summary'));
    assert.equal(writes.length, 0);

    await click('流程编排');
    const name = document.querySelector('[aria-label="流程名称"]'); name.value = '保留的业务草稿'; name.dispatchEvent(new window.Event('input'));
    conflict = true; await click('执行记录');
    assert.equal(selected('cases'), 'true');
    assert.equal(document.querySelector('[aria-label="流程名称"]').value, '保留的业务草稿');
    assert.match(document.querySelector('[data-flow-message]').textContent, /另存副本/);
    conflict = false; await click('执行记录');
    assert.equal(selected('records'), 'true');
    assert.equal(flow.name, '保留的业务草稿');
    assert.equal(document.getElementById('flow-workspace').hidden, true);
    assert.ok(document.querySelector('.test-attempt'));
    const records = [...document.querySelectorAll('.testing-batch')];
    assert.equal(records.length, 2);
    assert.match(records[0].textContent, /集合测试.*参数回归/);
    assert.match(records[1].textContent, /多步流程.*订单业务验证/);
    assert.ok([...document.querySelectorAll('.testing-detail button')].some(node => node.textContent === '结束批次'));
    assert.equal([...document.querySelectorAll('.testing-detail button')].some(node => node.textContent === '查看测试批次'), false);
    assert.equal([...document.querySelectorAll('.testing-detail button')].some(node => node.textContent === '查看执行记录 →'), false);

    document.querySelector('.testing-result-filter[data-filter="failed"]').click();
    assert.match(document.querySelector('.testing-detail').textContent, /没有符合筛选条件的结果/);
    document.querySelector('.testing-result-filter[data-filter="all"]').click();
    document.querySelector('.test-attempt').click();
    assert.equal(document.querySelector('.test-run-drawer').open, true);
    assert.match(document.querySelector('.test-run-drawer').textContent, /断言结果/);
    document.querySelector('[data-run-tab="input"]').click();
    assert.match(document.querySelector('#test-run-panel-input').textContent, /HTTP 请求快照/);
    document.querySelector('[aria-label="关闭执行详情"]').click();

    document.querySelectorAll('.testing-batch')[1].click(); await tick();
    assert.equal(new URLSearchParams(location.search).get('batch'), flowBatch.id);
    assert.equal([...document.querySelectorAll('.testing-detail button')].some(node => node.textContent === '结束批次'), false);
    document.querySelector('.testing-detail a').click(); await tick();
    assert.equal(new URLSearchParams(location.search).get('run'), run.id);
    assert.ok(document.querySelector('.fw-run-summary'));
    await click('← 执行记录');
    assert.equal(selected('records'), 'true');
    assert.equal(document.getElementById('flow-workspace').hidden, true);
    assert.ok(document.querySelector('.test-attempt'));
    recordFailure = true; await testing.refreshTesting();
    assert.match(document.querySelector('[data-testing-message]').textContent, /history unavailable/);
    recordFailure = false; await testing.refreshTesting();
    assert.equal(document.querySelector('[data-testing-message]').hidden, true);

    await click('流程');
    assert.equal(selected('cases'), 'true');
    assert.ok(document.querySelector('.fw-library-card'));
    assert.equal(document.querySelector('.test-cases'), null);
    assert.equal(document.querySelector('[data-case-action]'), null);
    assert.equal(document.querySelector('[data-testing-type]'), null);
    await click(document.querySelector('.fw-library-card').textContent);
    assert.equal(document.querySelector('[data-testing-content]').hidden, true);
    await click('▶ 运行流程');
    assert.equal(selected('records'), 'true');
    assert.equal(new URLSearchParams(location.search).get('run'), 'flow-run-2');
    const launch = writes.find(write => write.method === 'POST');
    assert.equal(launch.path, '/api/flows/flow-1/runs');
    assert.equal('batch_id' in launch.body, false);

    for (const url of ['/tests?batch=batch-1', '/tests?tab=batches&batch=batch-1', '/test-collections?tab=cases&type=flow&batch=batch-1', '/flows?tab=batches&type=single&batch=batch-1']) {
      history.pushState(null, '', url); window.dispatchEvent(new window.PopStateEvent('popstate')); await tick();
      assert.equal(location.pathname, '/execution-records');
      assert.equal(selected('records'), 'true');
      assert.equal(new URLSearchParams(location.search).get('batch'), batch.id);
      assert.equal(document.getElementById('flow-workspace').hidden, true);
      assert.ok(document.querySelector('.test-attempt'));
      assert.equal(document.querySelector('[data-testing-type]'), null);
    }
    for (const url of ['/flows?tab=records&type=single', '/flows?tab=records&type=flow']) {
      history.pushState(null, '', url); window.dispatchEvent(new window.PopStateEvent('popstate')); await tick();
      assert.equal(document.querySelectorAll('.testing-batch').length, 2);
    }
    document.querySelector('.page-nav a[aria-label="流程"]').click(); await tick();
    assert.equal(selected('cases'), 'true');
    assert.ok(document.querySelector('.fw-library-card'));
    assert.equal(document.querySelector('.test-cases'), null);
    assert.equal(document.querySelector('[data-case-action]'), null);
    assert.equal(location.pathname, '/flows');
    assert.equal(document.title, 'Apix · 流程');
    assert.equal(document.querySelector('.testing-toolbar').hidden, true);
    await click('执行记录');
    assert.equal(location.pathname, '/execution-records');
    assert.equal(document.title, 'Apix · 执行记录');
    assert.equal(document.querySelectorAll('.page-nav a[aria-current="page"]').length, 1);
    assert.equal(document.querySelector('#testing-view-panel').getAttribute('role'), 'region');
    // Direct page loads and browser history select the matching page without tab parameters.
    history.pushState(null, '', '/execution-records?batch=batch-1'); window.dispatchEvent(new window.PopStateEvent('popstate')); await tick();
    assert.equal(selected('records'), 'true');
    assert.ok(document.querySelector('.test-attempt'));
    history.pushState(null, '', '/flows?id=flow-1'); window.dispatchEvent(new window.PopStateEvent('popstate')); await tick();
    assert.equal(selected('cases'), 'true');
    assert.equal(document.title, 'Apix · 流程');
    assert.ok(document.querySelector('[aria-label="流程名称"]'));
  } finally {
    testing.deactivateTesting(); flows.deactivateFlows(); dom.window.close();
  }
});
