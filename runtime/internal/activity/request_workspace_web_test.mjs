import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

test('request workspace manages collections, imports, drafts, conflicts and history without legacy UI', async t => {
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/requests' });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  let confirm = true;
  dom.window.confirm = () => confirm;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, Option: dom.window.Option });
  const $ = id => document.getElementById(id);
  const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
  const input = (id, value) => { $(id).value = value; $(id).dispatchEvent(new window.Event('input', { bubbles: true })); };
  const submit = id => $(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const groups = [], saved = new Map(), copies = new Map(), writes = [];
  let next = 0, conflict = false, failedPin = false;
  const request = { method: 'POST', url: 'http://localhost/api?existing=1', query_params: [{ name: 'tag', value: 'one', enabled: true }, { name: 'tag', value: 'two', enabled: true }, { name: 'off', value: 'kept', enabled: false }], headers: [{ name: 'X-Keep', value: 'off', enabled: false }], body_type: 'raw', body: '<text>', auth_config: { type: 'bearer', token: 'preserve-auth' } };
  let runs = [{ id: 'run-1', status: 'succeeded', request_snapshot: request, response_status: 200, is_pinned: false, started_at: new Date().toISOString() }];
  globalThis.fetch = async (path, options = {}) => {
    const method = options.method || 'GET', data = options.body ? JSON.parse(options.body) : null;
    if (method !== 'GET') writes.push({ path, method, data });
    const result = (body, status = 200) => ({ status, ok: status < 400, json: async () => structuredClone(body) });
    if (path === '/api/collections') {
      if (method === 'GET') return result(groups.filter(item => !item.archived));
      const item = { ...data, id: `group-${++next}` }; groups.push(item); return result(item, 201);
    }
    const groupMatch = path.match(/^\/api\/collections\/(.+)$/);
    if (groupMatch) {
      const item = groups.find(item => item.id === groupMatch[1]);
      if (method === 'DELETE') { item.archived = true; return result(null, 204); }
      Object.assign(item, data); return result(item);
    }
    if (path.startsWith('/api/requests?')) return result([...saved.values()].filter(item => item.collection_id === new URLSearchParams(path.split('?')[1]).get('collection_id') && !item.archived));
    const requestMatch = path.match(/^\/api\/requests\/(.+)$/);
    if (requestMatch) {
      const item = saved.get(requestMatch[1]);
      if (method === 'DELETE') { item.archived = true; return result(null, 204); }
      return result(item);
    }
    if (path === '/api/import/curl') {
      const item = { id: `copy-${++next}`, request, edit_version: 1, source_type: 'curl_import' }; copies.set(item.id, item); return result(item, 201);
    }
    if (path === '/api/working-copies') {
      const item = { ...data, id: `copy-${++next}`, request: data.api_request_id ? saved.get(data.api_request_id).request : data.request, edit_version: 1 };
      copies.set(item.id, item); return result(item, 201);
    }
    const copyMatch = path.match(/^\/api\/working-copies\/([^/]+)(?:\/(save|discard))?$/);
    if (copyMatch) {
      let item = copies.get(copyMatch[1]);
      if (copyMatch[2] === 'discard') { item.discarded = true; return result(null, 204); }
      if (conflict) return result({ error: 'changed elsewhere' }, 409);
      if (copyMatch[2] === 'save') {
        const id = item.api_request_id || `api-${++next}`;
        saved.set(id, { ...data, id, collection_id: saved.get(id)?.collection_id || data.collection_id, request: item.request });
        item = { ...item, api_request_id: id, edit_version: item.edit_version + 1 };
      } else { assert.equal(data.edit_version, item.edit_version); item = { ...item, ...data, edit_version: item.edit_version + 1 }; }
      copies.set(item.id, item); return result(item);
    }
    if (path === '/api/runs?summary=true&limit=200') return result(runs);
    const pin = path.match(/^\/api\/runs\/(.+)\/pin$/);
    if (pin) {
      if (failedPin) return result({ error: 'pin rejected' }, 500);
      runs.find(item => item.id === pin[1]).is_pinned = data.pinned; return result(null, 204);
    }
    const run = path.match(/^\/api\/runs\/(.+)$/);
    if (run) {
      if (method === 'DELETE') { runs = runs.filter(item => item.id !== run[1]); return result(null, 204); }
      return result(runs.find(item => item.id === run[1]));
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  const manual = await import('./web/manual-request.js');
  const library = await import('./web/request-library.js');
  const history = await import('./web/request-history.js');
  try {
    await t.test('collections can be created and renamed while preserving metadata', async () => {
      await library.refreshLibrary(); $('collection-create').click(); input('collection-name', 'My APIs'); submit('collection-form'); await tick();
      assert.equal(groups.length, 1); assert.equal($('manual-collection').value, groups[0].id);
      groups[0].description = 'keep-description'; await library.refreshLibrary();
      $('collection-rename').click(); input('collection-name', 'Renamed'); submit('collection-form'); await tick();
      assert.equal(groups[0].name, 'Renamed'); assert.equal(groups[0].description, 'keep-description');
    });
    await t.test('import is reviewable and saving preserves duplicate, disabled and authentication fields', async () => {
      $('request-manage-tab').click();
      assert.equal($('manual-import-panel').closest('[role=tabpanel]').id, 'request-manage-panel');
      input('manual-import-text', 'curl http://localhost/api'); $('manual-import-submit').click(); await tick();
      assert.equal($('request-execute-panel').hidden, false);
      assert.equal(saved.size, 0); assert.equal(writes.some(item => item.path === '/api/runs'), false);
      assert.equal($('manual-body').value, '<text>'); assert.equal($('manual-body-type').value, 'raw');
      input('manual-name', 'Imported API'); $('manual-collection').value = groups[0].id;
      $('manual-save').click(); $('manual-save').click(); await tick();
      assert.equal(saved.size, 1); const item = [...saved.values()][0];
      assert.deepEqual(item.request.query_params, request.query_params);
      assert.deepEqual(item.request.headers, request.headers); assert.deepEqual(item.request.auth_config, request.auth_config);
      assert.equal(writes.filter(item => item.path.endsWith('/save')).length, 1);
      assert.match($('request-library').textContent, /Imported API/);
    });
    await t.test('conflicts retain local edits and can be recovered by saving a new interface', async () => {
      const id = [...saved.keys()][0]; $('request-manage-tab').click();
      document.querySelector('[aria-label="编辑接口 Imported API"]').click(); await tick();
      assert.equal($('request-execute-panel').hidden, false);
      input('manual-url', 'http://localhost/edited'); conflict = true; $('manual-save').click(); await tick();
      assert.equal($('manual-url').value, 'http://localhost/edited'); assert.match($('manual-feedback').textContent, /已保留/);
      assert.equal($('manual-reload').hidden, false);
      $('request-manage-tab').click(); confirm = false; await manual.loadSavedRequest(id); assert.equal($('request-manage-panel').hidden, false); assert.equal($('manual-url').value, 'http://localhost/edited');
      $('request-execute-tab').click(); confirm = true; conflict = false; $('manual-save-new').click(); await tick();
      assert.equal($('manual-collection').disabled, false); $('manual-collection').value = groups[0].id;
      input('manual-name', 'My recovery'); $('manual-save').click(); await tick();
      assert.equal(saved.size, 2); assert.equal(saved.get(id).request.url, request.url);
    });
    await t.test('history supports filters, pin errors, confirmation, and deletion without deleting saved APIs', async () => {
      await history.refreshRequestHistory();
      $('request-history-tab').click();
      const executionsBefore = writes.filter(item => item.path === '/api/runs').length;
      document.querySelector('[aria-label="填入请求 run-1"]').click(); await tick();
      assert.equal($('request-execute-panel').hidden, false); assert.equal($('manual-url').value, request.url);
      assert.equal(writes.filter(item => item.path === '/api/runs').length, executionsBefore);
      $('request-history-tab').click();
      failedPin = true; document.querySelector('[aria-label="固定请求 run-1"]').click(); await tick();
      assert.equal(runs[0].is_pinned, false); assert.match($('history-feedback').textContent, /pin rejected/);
      failedPin = false; document.querySelector('[aria-label="固定请求 run-1"]').click(); await tick();
      assert.equal(runs[0].is_pinned, true); assert.match($('requests').textContent, /取消固定/);
      $('history-status').value = 'failed'; $('history-status').dispatchEvent(new window.Event('change')); assert.match($('requests').textContent, /没有匹配/);
      $('history-status').value = ''; $('history-status').dispatchEvent(new window.Event('change'));
      confirm = false; document.querySelector('[aria-label="删除请求 run-1"]').click(); await tick(); assert.equal(runs.length, 1);
      confirm = true; document.querySelector('[aria-label="删除请求 run-1"]').click(); await tick();
      assert.equal(runs.length, 0); assert.equal(saved.size, 2);
    });
    await t.test('new interface opens execution after confirming replacement of a dirty draft', async () => {
      $('request-manage-tab').click(); confirm = false; $('library-new').click(); await tick();
      assert.equal($('request-manage-panel').hidden, false); assert.equal($('manual-url').value, request.url);
      confirm = true; $('library-new').click(); await tick();
      assert.equal($('request-execute-panel').hidden, false); assert.equal($('manual-url').value, '');
    });
    await t.test('archiving hides saved interfaces and collections without altering execution data', async () => {
      input('library-search', 'Imported API'); assert.match($('request-library').textContent, /Imported API/); assert.doesNotMatch($('request-library').textContent, /My recovery/);
      document.querySelector('[aria-label="归档接口 Imported API"]').click(); await tick();
      assert.doesNotMatch($('request-library').textContent, /Imported API/);
      $('library-collection').value = groups[0].id; $('library-collection').dispatchEvent(new window.Event('change'));
      $('collection-archive').click(); await tick();
      assert.equal(groups[0].archived, true); assert.equal($('library-collection').options.length, 1);
    });
  } finally { dom.window.close(); }
});
