import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { blankStep } from './web/flow-model.js';

const tick = async () => { for (let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve)); };

test('unified testing preserves legacy links, flow save guards and execution routing across all three views', async t => {
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
    if (path === '/api/test-batches') return result([batch]);
    if (path === '/api/test-batches/batch-1') return result(batch);
    if (path === '/api/test-cases' || path === '/api/database/connections' || path === '/api/services') return result([]);
    throw new Error('Unexpected request: ' + path);
  };
  const click = async text => {
    const button = [...document.querySelectorAll('#testing-workspace button')].find(node => node.textContent === text && !node.closest('[hidden]'));
    assert.ok(button, text); button.click(); await tick();
  };
  const selected = key => document.querySelector('[data-test-tab="' + key + '"]').getAttribute('aria-selected');
  const flows = await import('./web/flows.js');
  const testing = await import('./web/testing.js');
  try {
    await import('./web/app.js'); await tick();
    assert.equal(location.pathname, '/tests');
    assert.equal(new URLSearchParams(location.search).get('run'), run.id);
    assert.equal(document.title, 'Apix · 测试');
    assert.equal(document.querySelector('.page-nav a[aria-label="测试"]').getAttribute('aria-current'), 'page');
    assert.equal(document.querySelector('.page-nav a[href="/flows"]'), null);
    assert.equal(selected('records'), 'true');
    assert.equal(document.getElementById('flow-workspace').hidden, false);
    assert.equal(writes.length, 0);

    await click('流程编排');
    assert.equal(selected('cases'), 'true');
    history.pushState(null, '', '/flows?id=flow-1&run=flow-run-1'); window.dispatchEvent(new window.PopStateEvent('popstate')); await tick();
    assert.equal(selected('records'), 'true');
    assert.ok(document.querySelector('.fw-run-summary'));
    await click('流程编排');
    const name = document.querySelector('[aria-label="流程名称"]'); name.value = '保留的业务草稿'; name.dispatchEvent(new window.Event('input'));
    conflict = true;
    const typeFilter = document.querySelector('[data-testing-type]');
    typeFilter.value = 'single'; typeFilter.dispatchEvent(new window.Event('change')); await tick();
    assert.equal(typeFilter.value, 'flow');
    await click('测试批次');
    assert.equal(selected('cases'), 'true');
    assert.equal(new URLSearchParams(location.search).get('tab'), 'cases');
    assert.equal(document.querySelector('[aria-label="流程名称"]').value, '保留的业务草稿');
    assert.match(document.querySelector('[data-flow-message]').textContent, /另存副本/);
    conflict = false; await click('测试批次');
    assert.equal(selected('batches'), 'true');
    assert.equal(flow.name, '保留的业务草稿');
    assert.equal(document.getElementById('flow-workspace').hidden, true);
    assert.equal(document.querySelector('.test-attempt'), null);
    await click('查看执行记录 →');
    assert.equal(selected('records'), 'true');
    assert.ok(document.querySelector('.test-attempt'));
    assert.equal(new URLSearchParams(location.search).get('batch'), batch.id);

    const type = document.querySelector('[data-testing-type]');
    assert.equal(type.getAttribute('aria-label'), '记录类型');
    assert.equal(type.options[1].textContent, '业务流程记录');
    type.value = 'flow'; type.dispatchEvent(new window.Event('change')); await tick();
    assert.match(document.querySelector('.testing-flow-records').textContent, /订单业务验证/);
    await click('查看执行结果');
    assert.equal(new URLSearchParams(location.search).get('run'), run.id);
    assert.equal(selected('records'), 'true');
    await click('← 执行记录');
    recordFailure = true; await testing.refreshTesting();
    assert.match(document.querySelector('[data-flow-message]').textContent, /history unavailable/);
    recordFailure = false; await testing.refreshTesting();
    assert.ok(document.querySelector('.testing-flow-records .test-case-row'));
    assert.equal(document.querySelector('[data-flow-message]').hidden, true);

    await click('测试用例');
    await click(document.querySelector('.fw-library-card').textContent);
    await click('▶ 运行流程');
    assert.equal(selected('records'), 'true');
    assert.equal(new URLSearchParams(location.search).get('run'), 'flow-run-2');
    const launch = writes.find(write => write.method === 'POST');
    assert.equal(launch.path, '/api/flows/flow-1/runs');
    assert.equal('batch_id' in launch.body, false);

    history.pushState(null, '', '/tests?batch=batch-1'); window.dispatchEvent(new window.PopStateEvent('popstate')); await tick();
    assert.equal(selected('records'), 'true'); assert.ok(document.querySelector('.test-attempt'));
    history.pushState(null, '', '/tests'); window.dispatchEvent(new window.PopStateEvent('popstate')); await tick();
    assert.equal(selected('cases'), 'true');
    assert.equal(document.querySelector('[data-testing-type]').value, 'single');
    assert.equal(document.querySelector('[data-testing-type]').getAttribute('aria-label'), '用例类型');
    const tab = document.querySelector('[data-test-tab="cases"]');
    tab.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await tick();
    assert.equal(selected('batches'), 'true');
    document.querySelector('.page-nav a[aria-label="测试集合"]').click(); await tick();
    assert.equal(location.pathname, '/test-collections');
    assert.equal(document.title, 'Apix · 测试集合');
    assert.equal(selected('records'), 'true');
    assert.equal(document.querySelectorAll('.page-nav a[aria-current="page"]').length, 1);
    assert.equal(document.querySelector('.page-nav a[aria-current="page"]').getAttribute('aria-label'), '测试集合');
    assert.ok(document.querySelector('.testing-batches').textContent.includes(batch.name));
    assert.ok(document.querySelector('.test-attempt'));
    const resultFilter = document.querySelector('[aria-label="筛选测试结果"]');
    resultFilter.value = 'failed'; resultFilter.dispatchEvent(new window.Event('change'));
    assert.match(document.querySelector('.testing-detail').textContent, /没有符合筛选条件的结果/);
    const allResults = document.querySelector('[aria-label="筛选测试结果"]');
    allResults.value = 'all'; allResults.dispatchEvent(new window.Event('change'));
    document.querySelector('.test-attempt summary').click();
    assert.equal(document.querySelector('.test-attempt').open, true);
    assert.match(document.querySelector('.test-attempt-body').textContent, /请求快照.*断言结果/s);
    assert.equal(document.querySelector('.page-heading').hidden, true);
    assert.equal(document.querySelector('.testing-toolbar').hidden, true);
    assert.equal(document.querySelector('[data-testing-types]').hidden, true);
    assert.equal(document.querySelector('[data-testing-hint]').hidden, true);
    assert.equal(document.querySelector('#testing-view-panel').getAttribute('role'), 'region');
    document.querySelector('.testing-detail a[data-route]').click(); await tick();
    assert.equal(location.pathname, '/tests');
    assert.equal(selected('batches'), 'true');
    assert.equal(document.querySelector('.page-heading').hidden, false);
    assert.equal(document.querySelector('.testing-toolbar').hidden, false);
    history.pushState(null, '', '/test-collections?tab=cases&type=flow&batch=batch-1'); window.dispatchEvent(new window.PopStateEvent('popstate')); await tick();
    assert.equal(selected('records'), 'true');
    assert.equal(document.getElementById('flow-workspace').hidden, true);
    assert.ok(document.querySelector('.test-attempt'));
    document.querySelector('.page-nav a[aria-label="测试"]').click(); await tick();
    assert.equal(location.pathname, '/tests');
    assert.equal(selected('cases'), 'true');
    assert.equal(document.querySelector('.page-nav a[aria-current="page"]').getAttribute('aria-label'), '测试');
  } finally {
    testing.deactivateTesting(); flows.deactivateFlows(); dom.window.close();
  }
});
