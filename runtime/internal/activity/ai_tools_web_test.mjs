import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

test('AI installation keeps the selected environment, prevents duplicate writes, reports backups and recovers from errors', async () => {
  const { JSDOM } = createRequire(import.meta.url)('jsdom');
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1:4317/ai-tools' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const $ = id => document.getElementById(id);
  let connection; let target = 'local'; let configured = false; let fail = false; let failRead = false; let release;
  const writes = [];
  globalThis.fetch = async (path, options = {}) => {
    if (options.method === 'POST') {
      writes.push({ path, body: JSON.parse(options.body) });
      await new Promise(resolve => { release = resolve; });
      if (fail) return { ok: false, status: 409, json: async () => ({ error: '配置已被其他程序修改' }) };
      configured = true;
      connection = { status: 'connected', tools_count: 39, environment: 'Windows', checked_at: '2026-10-19T06:00:00Z', duration_ms: 12 };
      return { ok: true, json: async () => ({ status: 'installed', backup: '/test/backup.json', connection }) };
    }
    if (failRead) return { ok: false, status: 500, json: async () => ({ error: '读取失败' }) };
    target = new URL(path, 'http://localhost').searchParams.get('target');
    return { ok: true, json: async () => ({
      target, endpoint: 'http://127.0.0.1:4317/mcp',
      targets: [{ id: 'local', name: 'WSL', home: '/home/test' }, { id: 'windows', name: 'Windows', home: '/mnt/c/Users/Test' }],
      clients: [
        { id: 'codex', name: 'Codex', status: configured ? 'configured' : 'available', connection, path: '/test/config.toml', snippet: '[mcp_servers.apix]' },
        { id: 'claude', name: 'Claude Code', status: 'blocked', error: '<script>conflict</script>', snippet: '{}' },
        { id: 'trae', name: 'TRAE', status: 'external', snippet: '{}', links: { '国内版': 'trae-cn://trae.ai-ide/mcp-import?type=http' } },
      ],
    }) };
  };
  const module = await import('./web/ai-tools.js?installation');
  try {
    await module.refreshAITools();
    assert.equal($('ai-clients').querySelectorAll('article').length, 3);
    assert.equal($('ai-clients').querySelector('script'), null);
    assert.match($('ai-clients').textContent, /<script>conflict/);
    assert.equal($('ai-clients').querySelectorAll('button.primary')[1].disabled, true);
    assert.match($('ai-clients').querySelector('a').href, /^trae-cn:/);
    $('ai-target').value = 'windows'; $('ai-target').dispatchEvent(new window.Event('change')); await tick();
    assert.equal(target, 'windows');
    const button = $('ai-clients').querySelector('button.primary');
    button.click(); button.click(); await tick();
    assert.equal(writes.length, 1); assert.equal($('ai-target').disabled, true);
    assert.deepEqual(writes[0].body, { target: 'windows' });
    release(); await tick();
    assert.match($('ai-feedback').textContent, /安装完成.*39 个可用工具.*backup.json/);
    assert.match(document.querySelector('[aria-label="Codex 连接状态"]').textContent, /连接成功.*39 个可用工具/);
    assert.equal($('ai-clients').querySelector('button.primary').disabled, true);
    assert.equal($('ai-target').value, 'windows');
    configured = false; await module.refreshAITools();
    fail = true; $('ai-clients').querySelector('button.primary').click(); await tick(); release(); await tick();
    assert.match($('ai-feedback').textContent, /其他程序修改/);
    assert.equal($('ai-clients').querySelector('button.primary').disabled, false);
    failRead = true; $('ai-reload').click(); await tick();
    assert.match($('ai-feedback').textContent, /读取安装配置失败/);
    assert.equal($('ai-clients').querySelector('button.primary').disabled, false);
    failRead = false; $('ai-reload').click(); await tick();
    assert.equal($('ai-target').value, 'windows');
  } finally { dom.window.close(); }
});

test('connection tests isolate environments, prevent duplicate requests, recover from failure and preserve zero tools', async () => {
  const { JSDOM } = createRequire(import.meta.url)('jsdom');
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1:4317/ai-tools' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const $ = id => document.getElementById(id);
  const pending = new Map(); const calls = [];
  const connections = {};
  let rejectNext = false;
  globalThis.fetch = async (path, options = {}) => {
    if (options.method === 'POST') {
      const { target } = JSON.parse(options.body); calls.push({ path, target });
      if (rejectNext) { rejectNext = false; return { ok: false, status: 500, json: async () => ({ error: '<img src=x>连接异常' }) }; }
      const value = await new Promise(resolve => pending.set(target, resolve));
      connections[target] = value;
      return { ok: true, json: async () => value };
    }
    const target = new URL(path, 'http://localhost').searchParams.get('target');
    return { ok: true, json: async () => ({
      target, endpoint: 'http://127.0.0.1:4317/mcp',
      targets: [{ id: 'local', name: 'WSL', home: '/home/test' }, { id: 'windows', name: 'Windows', home: '/mnt/c/Users/Test' }],
      clients: [{ id: 'codex', name: 'Codex', status: 'configured', path: '/test/config.toml', snippet: '{}', connection: connections[target] }],
    }) };
  };
  const module = await import('./web/ai-tools.js?connection-tests');
  try {
    await module.refreshAITools(); await tick();
    assert.equal(calls.length, 1); assert.equal(calls[0].target, 'local');
    assert.match($('ai-clients').textContent, /正在验证连接/);
    const check = document.querySelector('.ai-test-button');
    assert.equal(check.disabled, true); check.click(); await tick(); assert.equal(calls.length, 1);
    $('ai-target').value = 'windows'; $('ai-target').dispatchEvent(new window.Event('change')); await tick();
    assert.equal(calls.length, 2); assert.equal(calls[1].target, 'windows');
    pending.get('windows')({ status: 'connected', tools_count: 0, environment: 'Windows', checked_at: '2026-10-19T06:00:00Z', duration_ms: 2 }); await tick();
    assert.match($('ai-clients').textContent, /连接成功.*0 个可用工具/);
    pending.get('local')({ status: 'connected', tools_count: 39, environment: 'WSL', checked_at: '2026-10-19T06:00:00Z', duration_ms: 5 }); await tick();
    assert.match($('ai-clients').textContent, /0 个可用工具/);
    assert.doesNotMatch($('ai-clients').textContent, /39 个可用工具/);
    rejectNext = true; document.querySelector('.ai-test-button').click(); await tick();
    assert.match($('ai-clients').textContent, /连接失败.*连接异常/);
    assert.equal($('ai-clients').querySelector('img'), null);
    assert.doesNotMatch($('ai-clients').textContent, /0 个可用工具/);
    document.querySelector('.ai-test-button').click(); await tick();
    pending.get('windows')({ status: 'connected', tools_count: 2, environment: 'Windows', checked_at: '2026-10-19T06:01:00Z', duration_ms: 6 }); await tick();
    assert.match($('ai-clients').textContent, /连接成功.*2 个可用工具/);
    await module.refreshAITools(); await tick();
    assert.equal(calls.length, 4);
    assert.match($('ai-clients').textContent, /2 个可用工具/);
  } finally { dom.window.close(); }
});

test('failed automatic verification keeps installation complete and allows a manual retry', async () => {
  const { JSDOM } = createRequire(import.meta.url)('jsdom');
  const dom = new JSDOM(await readFile(new URL('./web/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1:4317/ai-tools' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  let installed = false;
  let connection;
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    if (options.method === 'POST') {
      calls.push(path);
      if (path.endsWith('/install')) {
        installed = true; connection = { status: 'failed', error: 'MCP 握手失败', environment: 'WSL', checked_at: '2026-10-19T06:00:00Z', duration_ms: 5 };
        return { ok: true, json: async () => ({ status: 'installed', connection, backup: '/original.backup' }) };
      }
      connection = { status: 'connected', tools_count: 39, environment: 'WSL', checked_at: '2026-10-19T06:00:30Z', duration_ms: 5 };
      return { ok: true, json: async () => connection };
    }
    return { ok: true, json: async () => ({
      target: 'local', endpoint: 'http://127.0.0.1:4317/mcp', targets: [{ id: 'local', name: 'WSL', home: '/home/test' }],
      clients: [{ id: 'codex', name: 'Codex', status: installed ? 'configured' : 'available', snippet: '{}', connection }],
    }) };
  };
  const module = await import('./web/ai-tools.js?installation-probe-failure');
  try {
    await module.refreshAITools();
    document.querySelector('#ai-clients button.primary').click(); await tick();
    assert.match(document.getElementById('ai-feedback').textContent, /安装完成.*配置已保存.*握手失败.*original.backup/);
    assert.equal(document.querySelector('#ai-clients button.primary').disabled, true);
    assert.equal(document.querySelector('.ai-test-button').disabled, false);
    assert.match(document.getElementById('ai-clients').textContent, /连接失败/);
    document.querySelector('.ai-test-button').click(); await tick();
    assert.match(document.getElementById('ai-clients').textContent, /连接成功.*39 个可用工具/);
    assert.deepEqual(calls, ['/api/ai-tools/codex/install', '/api/ai-tools/codex/test']);
  } finally { dom.window.close(); }
});
