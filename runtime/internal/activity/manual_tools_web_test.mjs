import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

async function setup(path) {
  const require = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url));
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: `http://localhost/${path}` });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  return dom;
}
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

test('manual SQL executes typed parameters once, renders safe tables, reuses history and retains drafts on errors/polling', async () => {
  const dom = await setup('databases');
  const $ = id => document.getElementById(id);
  let fail = false; let release; let defer = true;
  const writes = [];
  const connection = { id: 'db-1', name: '测试库', type: 'postgresql', database: 'test', host: 'localhost', port: 5432, username: 'test' };
  const history = [{ id: 1, connection_id: 'db-1', connection_name: '测试库', mode: 'query', sql: 'SELECT $1 AS value', params: ['history'], status: 'succeeded', row_count: 1, duration_ms: 3, started_at: new Date().toISOString() }];
  globalThis.fetch = async (path, options = {}) => {
    let result;
    if (path === '/api/database/connections') result = [connection];
    else if (path === '/api/database/executions') result = history;
    else if (path === '/api/database/execute') {
      const input = JSON.parse(options.body); writes.push(input);
      if (defer) await new Promise(resolve => { release = resolve; });
      result = fail ? { error: 'syntax error near bad' } : { columns: ['value', 'nullable', 'zero', 'flag'], rows: [{ value: '<img src=x onerror=alert(1)>', nullable: null, zero: 0, flag: false }], row_count: 1, rows_affected: 2, duration_ms: 4, truncated: false };
      return { ok: !fail, status: fail ? 500 : 200, json: async () => result };
    } else throw new Error(path);
    return { ok: true, status: 200, json: async () => structuredClone(result) };
  };
  const module = await import('./web/databases.js?manual-tools');
  const submit = () => $('sql-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  try {
    assert.equal($('sql-execute').disabled, true);
    await module.refreshDatabases(); await module.refreshSQLHistory();
    $('sql-run-connection').value = 'db-1'; $('sql-run-connection').dispatchEvent(new window.Event('change'));
    assert.match($('sql-driver-hint').textContent, /\$1/);
    $('sql-statement-input').value = 'SELECT $1 AS value'; $('sql-params-input').value = '{}';
    submit(); await tick(); assert.equal(writes.length, 0); assert.match($('sql-run-feedback').textContent, /JSON 数组/);
    $('sql-params-input').value = '["测试",123,null,false]';
    submit(); submit(); await tick();
    assert.equal(writes.length, 1); assert.equal($('sql-fields').disabled, true);
    assert.deepEqual(writes[0].params, ['测试', 123, null, false]); assert.equal(writes[0].timeout_ms, 30000);
    release(); await tick();
    assert.equal($('sql-live-result').hidden, false); assert.equal($('sql-live-result').querySelector('img'), null);
    assert.deepEqual([...$('sql-live-result').querySelectorAll('td')].map(cell => cell.textContent), ['<img src=x onerror=alert(1)>', 'NULL', '0', 'false']);
    await module.refreshDatabases(); await module.refreshSQLHistory();
    assert.equal($('sql-statement-input').value, 'SELECT $1 AS value'); assert.equal($('sql-run-connection').value, 'db-1');
    document.querySelector('.sql-fill-button').click(); assert.equal($('sql-params-input').value, '[\n  "history"\n]');
    defer = false; $('sql-mode').value = 'exec'; $('sql-mode').dispatchEvent(new window.Event('change'));
    assert.equal($('sql-max-rows').disabled, true);
    submit(); await tick(); assert.equal(writes.at(-1).mode, 'exec'); assert.match($('sql-live-result').textContent, /影响 2 行/);
    fail = true; $('sql-statement-input').value = 'bad SQL'; submit(); await tick();
    assert.match($('sql-run-feedback').textContent, /syntax error/); assert.equal($('sql-statement-input').value, 'bad SQL'); assert.equal($('sql-fields').disabled, false);
    $('sql-reset').click(); assert.equal($('sql-statement-input').value, ''); assert.equal($('sql-run-connection').value, 'db-1');
  } finally { dom.window.close(); }
});

test('service editor saves without starting, prevents duplicate launches, and retries failed starts using the saved definition', async () => {
  const dom = await setup('services');
  const $ = id => document.getElementById(id);
  const writes = []; let release; let fail = true;
  globalThis.fetch = async (path, options = {}) => {
    const input = JSON.parse(options.body); writes.push({ path, method: options.method, input });
    if (options.method === 'PUT') return { ok: true, status: 200, json: async () => input };
    if (fail) await new Promise(resolve => { release = resolve; });
    return { ok: !fail, status: fail ? 400 : 200, json: async () => fail ? { error: 'startup health check failed' } : { service_id: input.id, status: 'running', started: true } };
  };
  await import('./web/service-editor.js?manual-tools');
  const submit = id => $('service-form').dispatchEvent(new window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: $(id) }));
  const fill = () => {
    $('service-name').value = '测试服务'; $('service-work-dir').value = 'D:\\project\\example'; $('service-command').value = 'node';
    $('service-args').value = 'C:\\Program Files\\test server.js\n--port\n18888'; $('service-health-url').value = 'http://localhost:18888/health';
  };
  try {
    $('service-add').click(); fill(); submit('service-save'); await tick();
    assert.equal(writes.length, 1); assert.equal(writes[0].method, 'PUT'); assert.equal($('service-editor').open, false);
    assert.deepEqual(writes[0].input.args, ['C:\\Program Files\\test server.js', '--port', '18888']);
    assert.equal(writes[0].input.startup_timeout_ms, 30000);
    $('service-add').click(); fill(); submit('service-save-start'); submit('service-save-start'); await tick();
    assert.equal(writes.filter(item => item.method === 'POST').length, 1); assert.equal($('service-fields').disabled, true);
    $('service-editor-close').click(); assert.equal($('service-editor').open, true);
    release(); await tick();
    assert.match($('service-form-error').textContent, /配置已保存.*startup health check failed/);
    assert.equal($('service-name').value, '测试服务'); assert.equal($('service-fields').disabled, false);
    const count = writes.filter(item => item.method === 'PUT').length;
    fail = false; submit('service-save-start'); await tick();
    assert.equal(writes.filter(item => item.method === 'PUT').length, count);
    assert.equal(writes.filter(item => item.method === 'POST').length, 2);
    assert.equal(writes.at(-1).input.owner, 'manual'); assert.equal($('service-editor').open, false);
    assert.match($('service-editor-feedback').textContent, /已启动/);
  } finally { dom.window.close(); }
});
