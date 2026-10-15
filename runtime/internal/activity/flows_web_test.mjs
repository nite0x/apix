import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { blankStep, requestURL, uniqueName, validateDefinition } from './web/flow-model.js';

test('Flow definitions enforce variable names, extractor paths, and run prerequisites', () => {
  const flow = { name: '测试流程', variables: [], steps: [] };
  assert.equal(validateDefinition(flow), '');
  assert.match(validateDefinition(flow, true), /至少/);
  flow.steps.push(blankStep());
  assert.match(validateDefinition(flow, true), /请求地址/);
  flow.steps[0].request.url = '{{base_url}}/orders';
  assert.equal(validateDefinition(flow, true), '');
  flow.variables.push({ name: 'bad name' });
  assert.match(validateDefinition(flow), /变量/);
  flow.variables = [{ name: 'token', secret: true, default_value: 'do-not-save' }];
  assert.match(validateDefinition(flow), /敏感/);
  flow.variables = [{ name: 'token' }, { name: 'token' }];
  assert.match(validateDefinition(flow), /重复/);
  flow.variables = [];
  flow.steps[0].config.extractors.push({ name: 'token', source: 'header', path: '' });
  assert.match(validateDefinition(flow), /响应头提取/);
  assert.equal(uniqueName([{ name: 'var_1' }, { name: 'var_3' }], 'var'), 'var_2');
});

test('run request display merges only enabled query parameters', () => {
  assert.equal(requestURL({ url: 'https://example.com/check?keep=1', query_params: [{ name: 'service', value: 'resolved-value', enabled: true }, { name: 'off', value: 'no', enabled: false }] }), 'https://example.com/check?keep=1&service=resolved-value');
  assert.equal(blankStep('sql').sql.mode, 'query');
  assert.equal(blankStep('service').service.action, 'start');
});

test('new Runtime Flow page preserves edits after saving and retains drafts on conflict', async () => {
  const require = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url));
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/flows?id=flow-test' });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, Option: dom.window.Option });
  const writes = [];
  const saved = { id: 'flow-test', name: '测试场景', description: '', environment_id: null, edit_version: 1, variables: [], settings: { stop_on_error: true, request_timeout_ms: 60000 }, steps: [], updated_at: new Date().toISOString() };
  let conflict = false;
  globalThis.fetch = async (url, options = {}) => {
    let body = [];
    if (url === '/api/flows/flow-test' && options.method === 'PUT') {
      const value = JSON.parse(options.body); writes.push(value);
      if (conflict) return { status: 409, ok: false, json: async () => ({ error: 'flow version conflict' }) };
      Object.assign(saved, value, { edit_version: value.edit_version + 1 }); body = structuredClone(saved);
    } else if (url === '/api/flows/flow-test') body = structuredClone(saved);
    else if (url === '/api/flows') body = [{ ...saved, step_count: saved.steps.length }];
    return { status: 200, ok: true, json: async () => body };
  };
  const module = await import('./web/flows.js');
  await module.activateFlows();
  const tick = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
  await tick();
  const set = (label, value) => { const control = document.querySelector(`[aria-label="${label}"]`); assert.ok(control, label); control.value = value; control.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const click = text => { const control = [...document.querySelectorAll('#flow-workspace button')].find(item => item.textContent === text); assert.ok(control, text); control.click(); };
  set('流程名称', '第一次保存'); click('保存'); await tick();
  assert.equal(writes.at(-1).name, '第一次保存');
  // Inputs stay mounted after saving: their callbacks must still mutate the live draft.
  set('流程名称', '保存后的第二次修改'); click('保存'); await tick();
  assert.equal(writes.at(-1).name, '保存后的第二次修改');
  assert.equal(writes.at(-1).edit_version, 2);
  click('HTTP 请求');
  set('请求地址', 'http://localhost/health');
  click('响应提取 0'); click('＋ 添加提取规则');
  set('提取 1 变量名', 'service_name'); set('提取 1 路径', 'service');
  click('保存'); await tick();
  assert.equal(writes.at(-1).steps[0].config.extractors[0].path, 'service');
  conflict = true; set('流程名称', '本地草稿'); click('保存'); await tick();
  assert.match(document.querySelector('[data-flow-message]').textContent, /另存副本/);
  assert.equal(document.querySelector('[aria-label="流程名称"]').value, '本地草稿');
  assert.equal(await module.leaveFlows(), false);
  module.deactivateFlows(); dom.window.close();
});
