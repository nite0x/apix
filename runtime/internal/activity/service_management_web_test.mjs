import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test('service management edits existing definitions and confirms deletion with lifecycle guards and recovery', async t => {
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/services' });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {} });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, Option: dom.window.Option, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage });
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const $ = id => document.getElementById(id);
  const definition = { id: 'svc/1', name: 'Test service', work_dir: '/tmp/my api', command: 'node', args: ['server file.js', '--port', '18888'], health_url: 'http://localhost:18888/health', startup_timeout_ms: 45000 };
  let services = [
    { ...definition, status: 'stopped', owner: '' },
    ...['running', 'starting', 'stopping', 'cleanup_failed'].map(status => ({ id: status, name: status, status, owner: 'manual' })),
    { id: 'flow', name: 'flow', status: 'running', owner: 'flow-1' },
    { id: 'external', name: 'external', status: 'running', owner: 'external' },
  ];
  const writes = []; let failSave = false; let failDelete = false; let failLoad = false; let release;
  const result = (body, status = 200) => ({ status, ok: status < 400, json: async () => structuredClone(body) });
  globalThis.fetch = async (path, options = {}) => {
    const method = options.method || 'GET';
    if (method !== 'GET') writes.push({ path, method, input: options.body ? JSON.parse(options.body) : null });
    if (path.startsWith('/api/activity?')) return result({ services, requests: [], events: [], service_logs: [], event_cursor: 0, service_cursor: 0, time: new Date().toISOString() });
    if (path === '/api/services/svc%2F1' && method === 'GET') return failLoad ? result({ error: 'load failed' }, 500) : result({ definition });
    if (path === '/api/services' && method === 'PUT') {
      if (failSave) return result({ error: 'stop service before changing its definition' }, 400);
      await new Promise(resolve => { release = resolve; });
      Object.assign(definition, JSON.parse(options.body)); Object.assign(services[0], definition); return result(definition);
    }
    if (path === '/api/services/svc%2F1' && method === 'DELETE') {
      if (failDelete) return result({ error: 'stop service before deleting its definition' }, 400);
      await new Promise(resolve => { release = resolve; });
      services = services.filter(item => item.id !== definition.id); return result({ deleted: true });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  const button = (action, name = definition.name) => document.querySelector(`[aria-label="${action}服务 ${name}"]`);
  const submit = () => $('service-form').dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: $('service-save') }));
  try {
    await import('./web/app.js'); await tick();
    for (const name of ['running', 'starting', 'stopping', 'cleanup_failed', 'flow']) {
      assert.equal(button('编辑', name).disabled, true); assert.equal(button('删除', name).disabled, true);
    }
    assert.equal(button('编辑', 'external').disabled, false); assert.equal(button('删除', 'external').disabled, false);
    failLoad = true; button('编辑').click(); await tick();
    assert.match($('service-form-error').textContent, /load failed/); assert.equal($('service-save').disabled, true);
    $('service-editor-cancel').click(); failLoad = false;
    button('编辑').click(); await tick();
    assert.equal($('service-editor-title').textContent, '编辑服务'); assert.equal($('service-name').value, definition.name);
    assert.equal($('service-args').value, definition.args.join('\n')); assert.equal($('service-timeout').value, '45');
    assert.equal($('service-save-start').hidden, true);
    $('service-name').value = 'Edited service'; failSave = true; submit(); await tick();
    assert.equal($('service-editor').open, true); assert.equal($('service-name').value, 'Edited service'); assert.match($('service-form-error').textContent, /保存失败/);
    failSave = false; submit(); submit(); await tick();
    assert.equal(writes.filter(item => item.method === 'PUT').length, 2); assert.equal($('service-fields').disabled, true);
    release(); await tick();
    assert.equal($('service-editor').open, false); assert.equal(definition.id, 'svc/1'); assert.equal(definition.name, 'Edited service');
    assert.deepEqual(definition.args, ['server file.js', '--port', '18888']);
    assert.equal(writes.some(item => item.method === 'POST'), false); assert.ok(button('编辑'));
    $('service-add').click(); assert.equal($('service-editor-title').textContent, '新增服务'); assert.equal($('service-name').value, ''); assert.equal($('service-save-start').hidden, false); $('service-editor-cancel').click();
    button('删除').click(); assert.equal($('service-delete-name').textContent, definition.name);
    $('service-delete-cancel').click(); assert.equal(writes.some(item => item.method === 'DELETE'), false);
    button('删除').click(); failDelete = true; $('service-delete-confirm').click(); await tick();
    assert.equal($('service-delete').open, true); assert.match($('service-delete-error').textContent, /stop service/); assert.ok(button('删除'));
    failDelete = false; $('service-delete-confirm').click(); $('service-delete-confirm').click(); await tick();
    assert.equal(writes.filter(item => item.method === 'DELETE').length, 2); assert.equal($('service-delete-cancel').disabled, true);
    const cancel = new dom.window.Event('cancel', { cancelable: true }); $('service-delete').dispatchEvent(cancel); assert.equal(cancel.defaultPrevented, true);
    release(); await tick();
    assert.equal($('service-delete').open, false); assert.equal(button('删除'), null); assert.match($('service-editor-feedback').textContent, /历史日志已保留/);
    assert.equal(document.activeElement, $('service-add'));
  } finally { dom.window.close(); }
});
