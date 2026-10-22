import {openAIRemoval,lifecycleButton} from './lifecycle-ui.js';
const $ = id => document.getElementById(id);
let data;
let loading;
let installing = false;
const testing = new Set();
let externalInstall;
const labels = { available: '未配置', configured: '已配置', external: '应用内确认', blocked: '需要检查' };
function el(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
async function request(path, options) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(90000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function feedback(message, error = false) {
  $('ai-feedback').textContent = message;
  $('ai-feedback').classList.toggle('error', error);
  $('ai-feedback').hidden = !message;
}
function connectionPanel(client) {
  const checking = testing.has(`${data.target}/${client.id}`);
  const connection = client.connection;
  const state = checking ? 'testing' : connection?.status || 'untested';
  const panel = el('div', `ai-connection ai-connection-${state}`);
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');
  panel.setAttribute('aria-label', `${client.name} 连接状态`);
  const title = checking ? '正在验证连接…' : state === 'connected' ? '连接成功' : state === 'failed' ? '连接失败' : state === 'unconfigured' ? '配置未就绪' : '尚未测试';
  panel.append(el('strong', '', title));
  if (!checking && state === 'connected') panel.append(el('span', 'ai-tool-count', `${connection.tools_count} 个可用工具`));
  if (!checking && connection?.error) panel.append(el('p', '', connection.error));
  if (!checking && connection?.checked_at) {
    const time = new Date(connection.checked_at);
    if (Number.isFinite(time.getTime())) panel.append(el('small', '', `${connection.environment} · ${time.toLocaleTimeString('zh-CN', { hour12: false })} 验证 · ${connection.duration_ms} ms`));
  } else if (!checking && !connection) panel.append(el('small', '', client.status === 'available' ? '安装后自动进行 MCP 连接验证' : client.status === 'external' ? '验证 MCP 服务；导入结果请在 TRAE 中确认' : '验证 MCP 握手和工具列表'));
  return panel;
}
function render() {
  $('ai-endpoint').textContent = data.endpoint;
  $('ai-target').replaceChildren(...data.targets.map(target => {
    const option = el('option', '', `${target.name} · ${target.home}`);
    option.value = target.id;
    return option;
  }));
  $('ai-target').value = data.target;
  const cards = data.clients.map(client => {
    const card = el('article', 'ai-card');
    card.dataset.client = client.id;
    const heading = el('div', 'ai-card-heading');
    heading.append(el('h3', '', client.name), el('span', `badge ai-status-${client.status}`, labels[client.status] || client.status));
    card.append(heading, el('p', 'ai-client-note', client.id === 'claude' ? 'Claude Code 的用户级配置，适用于 CLI 和 Code 会话。' : client.id === 'trae' ? '打开浏览器所在系统的 TRAE，在导入窗口确认安装。' : '添加用户级 MCP 连接，在各项目中使用 Apix。'));
    if (client.path) card.append(el('code', 'ai-config-path', client.path));
    if (client.error) card.append(el('p', 'ai-client-error', client.error));
    card.append(connectionPanel(client));
    const details = el('details', 'ai-config');
    details.append(el('summary', '', '查看配置 / 手动安装'));
    const code = el('pre', 'detail-code', client.snippet);
    code.tabIndex = 0;
    const copy = el('button', 'button small', '复制配置');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(client.snippet); copy.textContent = '已复制'; }
      catch {
        const selection = window.getSelection();
        const range = document.createRange(); range.selectNodeContents(code);
        selection.removeAllRanges(); selection.addRange(range);
        feedback('浏览器无法访问剪贴板，已选中配置，请手动复制。');
      }
    });
    details.append(code, copy);
    card.append(details);
    const actions = el('div', 'ai-card-actions');
    const check = el('button', 'button ai-test-button', testing.has(`${data.target}/${client.id}`) ? '测试中…' : client.connection ? '重新测试' : '测试连接');
    check.type = 'button';
    check.dataset.client = client.id;
    check.dataset.available = String(client.status === 'configured' || client.status === 'external');
    check.setAttribute('aria-label', `${client.name}：测试连接`);
    check.addEventListener('click', () => testConnection(client.id, data.target));
    actions.append(check);
    if(client.status==='external'&&!client.links){actions.append(el('p','manual-tool-hint',client.snippet));}
    else if (client.links) {
      for (const [name, href] of Object.entries(client.links)) {
        const link = el('a', 'button primary', `安装到 ${name}`);
        link.href = href;
        link.addEventListener('click', () => {
          externalInstall = { id: client.id, target: data.target };
          feedback('请在 TRAE 中确认导入，返回本页面后自动测试所选环境的 MCP 连接；也可点击“测试连接”。');
        });
        actions.append(link);
      }
    } else {
      const button = el('button', 'button primary', client.status === 'configured' ? '已配置' : client.status === 'blocked' ? '请检查配置' : '一键安装');
      button.type = 'button';
      button.dataset.available = String(client.status === 'available');
      button.dataset.client = client.id;
      button.setAttribute('aria-label', `${client.name}：${button.textContent}`);
      button.addEventListener('click', () => install(client.id));
      actions.append(button);
    }
    if(client.status==='configured'||client.status==='blocked'||client.status==='external')actions.append(lifecycleButton(client.status==='external'?'手动移除说明':'移除配置',()=>openAIRemoval(client,data.target,refreshAITools)));
    card.append(actions);
    return card;
  });
  $('ai-clients').replaceChildren(...cards);
  setBusy(Boolean(loading) || installing);
}
function setBusy(value) {
  $('ai-target').disabled = value;
  $('ai-reload').disabled = value;
  $('ai-clients').setAttribute('aria-busy', String(value));
  $('ai-clients').querySelectorAll('button[data-available]').forEach(button => {
    button.disabled = value || button.dataset.available !== 'true' || testing.has(`${data?.target}/${button.dataset.client}`);
  });
}
async function install(id) {
  if (installing || loading || testing.has(`${data.target}/${id}`)) return;
  const target = data.target;
  const key = `${target}/${id}`;
  installing = true; testing.add(key); render(); feedback('正在安装并验证 MCP 连接…');
  try {
    const result = await request(`/api/ai-tools/${encodeURIComponent(id)}/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) });
    const client = data.clients.find(item => item.id === id);
    client.status = 'configured';
    client.connection = result.connection;
    const connected = result.connection?.status === 'connected';
    feedback(`${result.status === 'installed' ? '安装完成' : '已配置'}。${connected ? `连接成功，${result.connection.tools_count} 个可用工具。` : `配置已保存，连接验证未通过：${result.connection?.error || '请点击“测试连接”重试'}。` }请在 AI 工具中重新加载 MCP 或重启会话，并确认启用 apix。${result.backup ? ` 原配置备份：${result.backup}` : ''}`, !connected);
    await refreshAITools(target);
  } catch (error) { feedback(error.message, true); }
  finally { testing.delete(key); installing = false; if (data) render(); setBusy(false); }
}
async function testConnection(id, target) {
  const key = `${target}/${id}`;
  if (testing.has(key) || installing || loading) return;
  testing.add(key);
  if (data?.target === target) render();
  try {
    const connection = await request(`/api/ai-tools/${encodeURIComponent(id)}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) });
    if (data?.target === target) {
      const client = data.clients.find(item => item.id === id);
      if (client) client.connection = connection;
    }
  } catch (error) {
    if (data?.target === target) {
      const client = data.clients.find(item => item.id === id);
      if (client) client.connection = { status: 'failed', error: `连接测试失败：${error.message}` };
    }
  } finally {
    testing.delete(key);
    if (data?.target === target) render();
  }
}
export async function refreshAITools(target = $('ai-target').value || 'local') {
  if (loading) return loading;
  setBusy(true);
  loading = (async () => {
    try {
      data = await request(`/api/ai-tools?target=${encodeURIComponent(target)}`);
      render();
    } catch (error) {
      if (data) $('ai-target').value = data.target;
      feedback(`读取安装配置失败：${error.message}`, true);
      if (!data) $('ai-clients').replaceChildren(el('div', 'empty', '暂时无法读取，请点击“重新检测”重试。'));
    } finally {
      loading = null; setBusy(installing);
      if (!installing && data?.target === target) {
        for (const client of data.clients) if (client.status === 'configured' && !client.connection) testConnection(client.id, target);
      }
    }
  })();
  return loading;
}
function verifyExternalInstall() {
  if (!externalInstall || document.visibilityState === 'hidden' || installing || loading) return;
  const pending = externalInstall; externalInstall = null;
  testConnection(pending.id, pending.target);
}
window.addEventListener('focus', verifyExternalInstall);
document.addEventListener('visibilitychange', verifyExternalInstall);
$('ai-target').addEventListener('change', () => { feedback(''); refreshAITools(); });
$('ai-reload').addEventListener('click', () => { feedback(''); refreshAITools(); });
