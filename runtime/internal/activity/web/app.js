'use strict';
import { refreshCommands } from './command-tools.js';
import { refreshMCP } from './mcp-tools.js';
import { refreshAITools } from './ai-tools.js';
import { openServiceDetail } from './service-detail.js';
import { refreshDatabases, refreshSQLHistory, closeDatabaseDialogs } from './databases.js';
import { leaveFlows } from './flows.js';
import { activateTesting, deactivateTesting, refreshTesting } from './testing.js';
import { closeServiceEditor, openServiceEditor, openServiceDelete } from './service-editor.js';
import { refreshLibrary } from './request-library.js';
import { refreshRequestHistory } from './request-history.js';
(() => {
  const $ = id => document.getElementById(id);
  const state = { services: [], requests: [], logs: [], eventCursor: null, serviceCursor: null, totalLogs: 0, paused: false, busy: false, timer: null, serviceKey: '' };
  const serviceActions = new Map();
  const serviceFeedback = new Map();
  const sidebarPreference = 'apix.sidebar.collapsed';
  const narrowScreen = window.matchMedia('(max-width: 760px)');
  let sidebarCollapsed = narrowScreen.matches;
  try {
    const saved = localStorage.getItem(sidebarPreference);
    if (saved !== null) sidebarCollapsed = saved === 'true';
  } catch { /* Navigation remains usable when browser storage is unavailable. */ }
  function setSidebarCollapsed(collapsed, persist = false) {
    sidebarCollapsed = collapsed;
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    const label = collapsed ? '展开侧边栏' : '折叠侧边栏';
    const toggle = $('sidebar-toggle');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    toggle.querySelector('.nav-label').textContent = label;
    $('sidebar-backdrop').hidden = collapsed || !narrowScreen.matches;
    if (persist) {
      try { localStorage.setItem(sidebarPreference, String(collapsed)); } catch { /* Storage is optional. */ }
    }
  }
  setSidebarCollapsed(sidebarCollapsed);
  $('sidebar-toggle').addEventListener('click', () => setSidebarCollapsed(!sidebarCollapsed, true));
  $('sidebar-backdrop').addEventListener('click', () => setSidebarCollapsed(true, true));
  narrowScreen.addEventListener('change', () => setSidebarCollapsed(sidebarCollapsed));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && narrowScreen.matches && !sidebarCollapsed && !document.querySelector('dialog[open]')) {
      setSidebarCollapsed(true, true);
      $('sidebar-toggle').focus();
    }
  });
  const pages = {
    '/ai-tools': { id: 'ai-tools', title: 'AI 工具', eyebrow: 'CONNECT YOUR AI', description: '一键将 Apix 接入常用 AI 工具，让 AI 直接调试接口、查询数据库和管理服务。' },
    '/': { id: 'home', title: '主页', eyebrow: 'RUNTIME OVERVIEW', description: '本地运行概况，从这里进入服务、接口和日志。' },
    '/services': { id: 'services', title: '服务', eyebrow: 'LOCAL SERVICES', description: '新增、编辑或删除本地服务配置，手动启停服务，查看状态和运行日志。' },
    '/requests': { id: 'requests', title: '接口', eyebrow: 'API REQUESTS', description: '调试 HTTP 请求、导入 cURL、管理接口库与执行历史。' },
    '/databases': { id: 'databases', title: '数据库', eyebrow: 'DATABASE CONNECTIONS', description: '手动执行 SQL、查看结果，管理 MySQL、PostgreSQL 和 Hologres 连接。' },
    '/commands': { id: 'commands', title: '命令行', eyebrow: 'COMMAND TESTING', description: '运行命令和脚本，验证退出码与输出，保存用例并追踪测试记录。' },
    '/mcp-tools': { id: 'mcp-tools', title: 'MCP 工具', eyebrow: 'MCP TOOL TESTING', description: '连接 MCP 服务器，发现和调试工具，保存用例并验证调用结果。' },
    '/tests': { id: 'tests', title: '已保存用例', eyebrow: 'SAVED TEST CASES', description: '管理、归档和重复运行 HTTP、MCP 与命令行用例。' },
    '/flows': { id: 'tests', title: '流程', eyebrow: 'FLOWS', description: '创建、编辑与运行测试流程。' },
    '/execution-records': { id: 'tests', title: '执行记录', eyebrow: 'EXECUTION RECORDS', description: '统一查看流程和集合测试的执行进度、输入、断言与结果。' },
    '/logs': { id: 'logs', title: '日志', eyebrow: 'LIVE LOGS', description: '运行事件与服务输出实时汇总，支持来源筛选和暂停显示。' },
  };
  function showPage(focus = false, activate = true) {
    if (['/flows', '/execution-records', '/tests', '/test-collections'].includes(location.pathname)) {
      const query = new URLSearchParams(location.search);
      const collection = location.pathname === '/test-collections';
      const records = location.pathname === '/execution-records' || collection || ['records', 'batches'].includes(query.get('tab')) || query.has('batch') || query.has('run');
      query.delete('tab');
      if (collection) { query.delete('id'); query.delete('run'); query.delete('type'); }
      if (query.get('type') === 'single') query.delete('type');
      const path = `${records ? '/execution-records' : location.pathname === '/tests' ? '/tests' : '/flows'}${query.size ? '?' + query : ''}`;
      if (location.pathname + location.search !== path) history.replaceState(null, '', path);
    }
    const page = pages[location.pathname] || pages['/'];
    if ($('request-detail').open) $('request-detail').close();
    if ($('service-detail').open) $('service-detail').close();
    closeDatabaseDialogs();
    closeServiceEditor();
    document.querySelectorAll('[data-page]').forEach(element => { element.hidden = element.dataset.page !== page.id; });
    document.querySelectorAll('.page-nav a').forEach(link => {
      if (pages[link.pathname] === page) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.title = `Apix · ${page.title}`;
    document.querySelector('.page-heading').hidden = false;
    $('page-title').textContent = page.title; $('page-eyebrow').textContent = page.eyebrow; $('page-description').textContent = page.description;
    applyLogSource();
    if (page.id === 'requests') { refreshLibrary(); refreshRequestHistory(); }
    if (page.id === 'ai-tools') refreshAITools();
    if (page.id === 'logs') renderLogs();
    if (page.id === 'databases') { refreshDatabases(); refreshSQLHistory(); }
    if (page.id === 'mcp-tools') refreshMCP();
    if (page.id === 'commands') refreshCommands();
    if (activate) { if (page.id === 'tests') activateTesting(); else deactivateTesting(); }
    if (focus) { if (!document.querySelector('.page-heading').hidden) $('page-title').focus({ preventScroll: true }); window.scrollTo(0, 0); }
  }
  async function navigate(path) {
    if (['/tests', '/test-collections', '/flows', '/execution-records'].includes(location.pathname) && !(await leaveFlows())) return;
    if (location.pathname + location.search !== path) history.pushState(null, '', path);
    showPage(true);
    if (narrowScreen.matches) setSidebarCollapsed(true, true);
  }
  const serviceLabels = { running: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停止', failed: '异常', cleanup_failed: '清理失败' };
  const eventLabels = { 'runtime.started': 'Apix 已启动', 'runtime.stopped': 'Apix 已停止', 'tool.started': '开始调用工具', 'tool.finished': '工具执行结束', 'session:start': '开始执行会话', 'session:done': '会话已完成', 'session:error': '会话执行失败', 'session:stopped': '会话已停止', 'step:start': '开始执行接口', 'step:done': '接口执行完成', 'step:error': '接口执行失败', 'step:paused': '接口等待确认', 'step:skipped': '接口已跳过', 'flow_run.started': '测试流程开始', 'flow_run.step_started': '开始执行步骤', 'flow_run.step_finished': '步骤执行结束', 'flow_run.step_paused': '步骤等待确认', 'flow_run.variable_extracted': '已提取流程变量', 'flow_run.cleanup_started': '开始清理本次服务', 'flow_run.cleanup_finished': '服务清理结束', 'flow_run.finished': '测试流程结束' };
  function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; }
  function clock(value, ms = false) { const date = new Date(value); if (!Number.isFinite(date.getTime())) return '—'; return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, ...(ms ? { fractionalSecondDigits: 3 } : {}) }); }
  function empty(message, hint) { const el = node('div', 'empty', message); if (hint) el.append(node('small', '', hint)); return el; }
  function setOnline(online) { $('connection').textContent = online ? '实时同步中' : '连接中断，正在重试'; $('connection-dot').className = `dot ${online ? '' : 'offline'}`; $('log-dot').className = `dot ${online ? '' : 'offline'}`; }
  function renderServices() {
    $('running-count').textContent = state.services.filter(s => s.status === 'running').length;
    $('services-note').textContent = `共 ${state.services.length} 个已配置`;
    $('service-total').textContent = `${state.services.length} 个服务`;
    const key = JSON.stringify([state.services, [...serviceActions], [...serviceFeedback]]); if (key === state.serviceKey) return; state.serviceKey = key;
    const fragment = document.createDocumentFragment();
    for (const service of state.services) {
      const card = node('div', 'service-card');
      const top = node('div', 'service-top'); const name = node('span', 'service-name', service.name); name.title = service.name;
      const badge = node('span', `badge status-${service.status}`); if (service.status === 'running') badge.append(node('span', 'dot')); badge.append(document.createTextNode(serviceLabels[service.status] || service.status)); top.append(name, badge);
      const url = node('div', 'service-url', service.health_url); url.title = service.health_url;
      const external = service.owner === 'external';
      const bottom = node('div', 'service-bottom'); const owner = external ? '复用外部服务' : service.owner === 'manual' ? '手动启动' : service.owner ? `流程 ${service.owner.slice(0, 8)}` : '尚未启动'; bottom.append(node('span', '', service.pid && service.status === 'running' ? `PID ${service.pid} · ${owner}` : owner));
      const actions = node('div', 'service-actions');
      const logs = node('a', 'text-button', '查看日志 →'); logs.href = `/logs?source=${encodeURIComponent(service.id)}`; logs.dataset.route = '';
      const details = node('button', 'text-button', '查看详情'); details.type = 'button'; details.setAttribute('aria-label', `查看 ${service.name} 的服务详情`); details.setAttribute('aria-haspopup', 'dialog'); details.setAttribute('aria-controls', 'service-detail'); details.addEventListener('click', () => openServiceDetail(service.id, details));
      const pending = serviceActions.get(service.id); const running = service.status === 'running';
      const managedByFlow = !!service.owner && service.owner !== 'manual' && !external && ['running', 'starting', 'stopping', 'cleanup_failed'].includes(service.status);
      const transitioning = ['starting', 'stopping'].includes(service.status);
      const label = pending === 'start' ? '启动中…' : pending === 'stop' ? '停止中…' : transitioning ? `${serviceLabels[service.status]}…` : external ? '外部运行中' : managedByFlow ? '流程管理中' : running ? '停止' : service.status === 'cleanup_failed' ? '重试停止' : '启动';
      const action = running || service.status === 'cleanup_failed' ? 'stop' : 'start';
      const control = node('button', `button small service-control ${action}`, label); control.type = 'button'; control.disabled = !!pending || transitioning || managedByFlow || external;
      control.setAttribute('aria-label', `${label} ${service.name}`); control.setAttribute('aria-busy', String(!!pending || transitioning));
      control.title = external ? '健康检查已发现正在运行的服务，可直接复用；请在原启动位置停止。' : managedByFlow ? '该服务由测试流程管理，请通过对应流程停止或清理。' : action === 'start' ? '优先复用已有服务，未发现时使用已保存的配置启动' : '停止这个手动启动的服务';
      control.addEventListener('click', () => changeService(service, action));
      const locked = !!pending || (!external && ['running', 'starting', 'stopping', 'cleanup_failed'].includes(service.status));
      const edit = node('button', 'button small', '编辑'); edit.type = 'button'; edit.disabled = locked;
      edit.setAttribute('aria-label', `编辑服务 ${service.name}`); edit.setAttribute('aria-haspopup', 'dialog'); edit.setAttribute('aria-controls', 'service-editor');
      edit.title = locked ? '请先停止服务并完成清理，再编辑配置' : '编辑服务启动配置';
      edit.addEventListener('click', () => openServiceEditor(service.id, edit));
      const remove = node('button', 'button small danger', '删除'); remove.type = 'button'; remove.disabled = locked;
      remove.setAttribute('aria-label', `删除服务 ${service.name}`); remove.setAttribute('aria-haspopup', 'dialog'); remove.setAttribute('aria-controls', 'service-delete');
      remove.title = locked ? '请先停止服务并完成清理，再删除配置' : '删除服务配置，保留历史日志';
      remove.addEventListener('click', () => openServiceDelete(service, remove));
      actions.append(details, logs, edit, remove, control); bottom.append(actions); card.append(top, url, bottom);
      const feedback = serviceFeedback.get(service.id); if (feedback) { const message = node('div', `service-feedback ${feedback.error ? 'error' : ''}`, feedback.message); message.setAttribute('role', feedback.error ? 'alert' : 'status'); card.append(message); }
      fragment.append(card);
    }
    if (!state.services.length) fragment.append(empty('还没有配置服务', '点击“新增服务”填写配置并启动，也可以通过 MCP 添加。'));
    $('services').replaceChildren(fragment);
    const selected = $('log-source').value;
    $('log-source').replaceChildren(new Option('全部来源', 'all'), new Option('运行事件', 'runtime'), ...state.services.map(s => new Option(s.name, s.id)));
    $('log-source').value = selected === 'all' || selected === 'runtime' || state.services.some(s => s.id === selected) ? selected : 'all';
  }
  async function changeService(service, action) {
    if (serviceActions.has(service.id)) return;
    serviceActions.set(service.id, action); serviceFeedback.delete(service.id); renderServices();
    try {
      const response = await fetch(`/api/services/${encodeURIComponent(service.id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: 'manual' }), signal: AbortSignal.timeout(330000) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      const current = state.services.find(item => item.id === service.id); if (current) { current.status = result.status; current.pid = result.pid; current.owner = result.owner; }
      serviceFeedback.set(service.id, { message: action === 'start' ? result.started ? '服务已启动' : '已定位并复用正在运行的服务' : result.status === 'running' ? '已保留复用服务，由原启动方管理' : '服务已停止', error: false });
    } catch (error) {
      const message = error.name === 'TimeoutError' || error instanceof TypeError ? '未能确认操作结果，请检查连接、服务状态和日志后重试。' : error.message;
      serviceFeedback.set(service.id, { message: `${action === 'start' ? '启动' : '停止'}失败：${message}`, error: true });
    } finally { serviceActions.delete(service.id); renderServices(); refresh(); }
  }
  function addLogs(data) {
    if (data.reset_events) state.logs = state.logs.filter(l => l.source !== 'runtime');
    if (data.reset_services) state.logs = state.logs.filter(l => l.source === 'runtime');
    const names = new Map(state.services.map(s => [s.id, s.name])); const known = new Set(state.logs.map(l => l.key)); let added = 0;
    for (const event of data.events) {
      const payload = event.payload || {}; const key = `runtime:${event.sequence}`; if (known.has(key)) continue;
      const failed = payload.status === 'failed' || /error/.test(event.type); const parts = [eventLabels[event.type] || event.type, payload.name, payload.tool, payload.status, payload.error_code].filter(Boolean);
      state.logs.push({ key, source: 'runtime', sourceName: 'Apix', time: event.time, level: failed ? 'ERROR' : 'INFO', message: parts.join(' · '), reference: event.run_id }); added++; known.add(key);
    }
    for (const line of data.service_logs) { const key = `service:${line.sequence}`; if (known.has(key)) continue; state.logs.push({ key, source: line.service_id, sourceName: names.get(line.service_id) || line.service_id, time: line.time, level: line.stream === 'stderr' ? 'STDERR' : line.stream === 'stdout' ? 'STDOUT' : 'SYSTEM', message: line.message }); added++; known.add(key); }
    state.totalLogs += added;
    state.logs.sort((a, b) => new Date(a.time) - new Date(b.time) || a.key.localeCompare(b.key)); if (state.logs.length > 1000) state.logs = state.logs.slice(-1000);
    $('logs-count').textContent = state.totalLogs.toLocaleString('zh-CN');
    if ((added || data.reset_events || data.reset_services) && !state.paused) renderLogs();
  }
  function renderLogs() {
    const source = $('log-source').value; const logs = state.logs.filter(line => source === 'all' || line.source === source); const output = $('log-output'); const previousTop = output.scrollTop; const fragment = document.createDocumentFragment();
    for (const line of logs) { const row = node('div', 'log-line'); row.append(node('span', 'log-time', clock(line.time, true)), node('span', `log-level ${line.level.toLowerCase()}`, line.level)); const sourceName = node('span', 'log-source-name', line.sourceName); sourceName.title = line.sourceName; const message = node('span', 'log-message', line.message); if (line.reference) { const ref = node('small', '', `#${line.reference.replace(/^session-/, '').slice(0, 8)}`); ref.title = line.reference; message.append(ref); } row.append(sourceName, message); fragment.append(row); }
    if (!logs.length) { const blank = node('div', 'log-empty', source === 'all' ? '等待活动日志…' : '该来源暂无日志'); blank.append(node('span', '', '通过 MCP 执行操作后，运行事件和服务输出会出现在这里。')); fragment.append(blank); }
    output.replaceChildren(fragment); output.scrollTop = $('autoscroll').checked ? output.scrollHeight : previousTop;
  }
  function applyLogSource() {
    const source = new URLSearchParams(location.search).get('source') || 'all';
    const select = $('log-source');
    // Keep a linked service selected while definitions load, or after it was removed.
    if (![...select.options].some(option => option.value === source)) select.add(new Option(source, source));
    select.value = source;
  }
  async function refresh() {
    if (state.busy) return; state.busy = true; $('refresh').disabled = true; clearTimeout(state.timer); let delay = 1000;
    try {
      const query = new URLSearchParams(); if (state.eventCursor !== null) query.set('event_after', state.eventCursor); if (state.serviceCursor !== null) query.set('service_after', state.serviceCursor);
      const response = await fetch(`/api/activity?${query}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const data = await response.json();
      state.services = data.services; state.requests = data.requests; state.eventCursor = data.event_cursor; state.serviceCursor = data.service_cursor;
      renderServices(); applyLogSource(); $('requests-count').textContent = state.requests.length; if (location.pathname === '/requests') refreshRequestHistory(); addLogs(data); setOnline(true); $('error-banner').hidden = true; $('updated').textContent = `最近同步 ${clock(data.time)}`; if (data.more) delay = 100;
      if (location.pathname === '/databases') refreshSQLHistory();
    } catch (error) { setOnline(false); delay = 3000; $('error-banner').textContent = '暂时无法连接 Apix。正在自动重试，已加载的记录会保留。'; $('error-banner').hidden = false; }
    finally { state.busy = false; $('refresh').disabled = false; state.timer = setTimeout(refresh, delay); }
  }
  document.addEventListener('click', event => {
    const link = event.target.closest('a[data-route]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(link.pathname + link.search);
  });
  window.addEventListener('popstate', () => showPage(true));
  window.addEventListener('testing-flow-location', () => showPage(false, false));
  window.addEventListener('testing-page-location', () => showPage(false, false));
  $('refresh').addEventListener('click', () => { refresh(); if (location.pathname === '/ai-tools') refreshAITools(); if (location.pathname === '/databases') { refreshDatabases(); refreshSQLHistory(); } if (['/flows', '/execution-records', '/tests', '/test-collections'].includes(location.pathname)) refreshTesting(); if (location.pathname === '/mcp-tools') refreshMCP(); if (location.pathname === '/commands') refreshCommands(); if (location.pathname === '/requests') { refreshLibrary(); refreshRequestHistory(); } });
  $('log-source').addEventListener('change', () => {
    const query = new URLSearchParams(location.search);
    if ($('log-source').value === 'all') query.delete('source'); else query.set('source', $('log-source').value);
    history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}`); renderLogs();
  });
  $('autoscroll').addEventListener('change', () => { if (!state.paused) renderLogs(); });
  $('pause').addEventListener('click', () => { state.paused = !state.paused; $('pause').setAttribute('aria-pressed', String(state.paused)); $('pause').textContent = state.paused ? '继续显示' : '暂停显示'; $('log-live').textContent = state.paused ? 'PAUSED' : 'LIVE'; $('log-live').classList.toggle('paused', state.paused); $('log-status').textContent = state.paused ? '日志显示已暂停，后台继续接收' : '每秒自动更新'; if (!state.paused) renderLogs(); });
  document.addEventListener('manual-request-completed', refresh);
  document.addEventListener('request-history-changed', refresh);
  document.addEventListener('service-configuration-changed', event => {
    const id = event.detail?.deletedID;
    if (id) { state.services = state.services.filter(service => service.id !== id); serviceFeedback.delete(id); renderServices(); }
    refresh();
  });
  window.addEventListener('online', refresh); showPage(); refresh();
})();
