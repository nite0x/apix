import { executionBatchLink } from './execution-batch.js';

const dialog = document.getElementById('request-detail');
const content = document.getElementById('detail-content');
const refreshButton = document.getElementById('detail-refresh');
const detail = { id: null, controller: null, timer: null, version: 0, key: '', opener: null, tab: 'response' };
const statusLabels = { running: '执行中', succeeded: '请求完成', failed: '执行失败', timed_out: '请求超时', cancelled: '已取消' };
const triggerLabels = { ai: 'AI 调用', manual: '手动执行', flow: '测试流程', test: '接口测试' };

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function section(title, child) {
  const element = el('section', 'detail-section');
  element.append(el('h3', '', title), child);
  return element;
}

function textBlock(value, fallback = '（空）') {
  let text = value;
  if (typeof value !== 'string' && value !== undefined) text = JSON.stringify(value, null, 2);
  return el('pre', 'detail-code', text === undefined || text === '' ? fallback : text);
}

function requestBody(value, type) {
  if (type === 'json' && value) {
    try { return textBlock(JSON.parse(value)); } catch { /* Keep incomplete/non-JSON bodies readable. */ }
  }
  return textBlock(value);
}

function pairs(entries, fallback) {
  if (!entries.length) return el('p', 'detail-empty', fallback || '（空）');
  const list = el('dl', 'detail-pairs');
  for (const [name, value] of entries) list.append(el('dt', '', name), el('dd', '', value ?? '—'));
  return list;
}

function keyValues(values) {
  return pairs((values || []).map(item => [item.name || '（未命名）', `${item.value}${item.enabled ? '' : '  [未启用]'}`]));
}

function date(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function requestURL(request) {
  try {
    const url = new URL(request.url);
    for (const item of request.query_params || []) if (item.enabled && item.name) url.searchParams.append(item.name, item.value);
    return url.toString().replaceAll(encodeURIComponent('••••••'), '••••••');
  } catch { return request.url || '—'; }
}

function render(run) {
  const request = run.request_snapshot || {};
  const fragment = document.createDocumentFragment();
  const summary = el('div', 'detail-summary');
  const result = el('div', 'detail-result');
  result.append(el('span', `method ${String(request.method).toLowerCase()}`, request.method || '—'));
  const failed = ['failed', 'timed_out', 'cancelled'].includes(run.status) || run.response_status >= 400;
  result.append(el('strong', failed ? 'response-error' : run.status === 'running' ? 'response-pending' : 'response-ok', run.response_status ? `HTTP ${run.response_status}` : statusLabels[run.status] || run.status));
  result.append(el('span', 'subtle', `${run.status === 'running' ? '执行中' : `${run.duration_ms ?? 0} ms`} · ${triggerLabels[run.trigger_type] || run.trigger_type}`));
  result.append(executionBatchLink(run));
  summary.append(result, el('div', 'detail-url', requestURL(request)));
  fragment.append(summary);
  if (run.error_code || run.error_message) {
    const error = el('div', 'detail-alert error'); error.setAttribute('role', 'alert');
    error.append(el('strong', '', run.error_code || '执行失败'), el('div', '', run.error_message || '请求未完成，请检查目标地址和服务状态。'));
    fragment.append(error);
  }
  if (run.response_truncated) fragment.append(el('div', 'detail-alert', '响应正文超过 256 KB，以下只显示已保存的前 256 KB；此前未保存的部分无法恢复。'));

  const tabs = el('div', 'detail-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '请求详情内容');
  const panels = el('div', 'detail-panels');
  const responsePanel = el('div', 'detail-tab-panel');
  if (run.response_status) {
    const headers = Object.entries(run.response_headers || {}).flatMap(([name, values]) => (Array.isArray(values) ? values : [values]).map(value => [name, value]));
    responsePanel.append(section('响应正文', textBlock(run.response_body, '（空响应体）')), section('响应头', pairs(headers)));
    responsePanel.append(el('p', 'detail-note', `${run.response_truncated ? '已读取至少' : '已读取'} ${(run.response_size || 0).toLocaleString('zh-CN')} 字节${run.status === 'failed' ? ' · 正文读取失败，内容可能不完整' : ''}。JSON 显示为格式化后的已保存数据，文本和 HTML 仅作为文本展示。`));
  } else responsePanel.append(el('p', 'detail-empty', run.status === 'running' ? '请求正在执行，完成后会自动显示返回结果。' : '未收到 HTTP 响应，执行错误已显示在上方。'));

  const requestPanel = el('div', 'detail-tab-panel');
  let urlParams = [];
  try { urlParams = [...new URL(request.url).searchParams]; } catch { /* Invalid URL is already shown in the summary. */ }
  requestPanel.append(section('URL 中的参数', pairs(urlParams)), section('配置的查询参数', keyValues(request.query_params)), section('请求头', keyValues(request.headers)), section(`请求正文 · ${request.body_type || 'none'}`, requestBody(request.body, request.body_type)));
  if (request.auth_config) requestPanel.append(section('身份验证', textBlock(request.auth_config)));
  requestPanel.append(el('p', 'detail-note', '请求快照为变量替换后的配置。上方 URL 合并了已启用的查询参数；自动生成的认证值、传输层请求头不在此快照中。'));

  const executionPanel = el('div', 'detail-tab-panel');
  executionPanel.append(section('执行记录', pairs([
    ['执行 ID', run.id], ['执行状态', statusLabels[run.status] || run.status], ['开始时间', date(run.started_at)],
    ['结束时间', date(run.finished_at)], ['耗时', run.status === 'running' ? '执行中' : `${run.duration_ms ?? 0} ms`],
    ['调用来源', triggerLabels[run.trigger_type] || run.trigger_type], ['会话 / 流程 ID', run.session_id || '—'], ['步骤 ID', run.step_id || '—'],
    ['接口定义 ID', run.api_request_id || '—'], ['工作副本 ID', run.working_copy_id || '—'], ['环境 ID', run.environment_id || '—'],
    ['正文已截断', run.response_truncated ? '是，保留前 256 KB' : '否'],
  ])), el('p', 'detail-note', '保存应用层请求与返回快照、开始/结束时间及错误信息；未记录 DNS、TCP、TLS 分段耗时和重定向的每一跳。旧记录耗时采用当时保存的值。'));

  const definitions = [['response', '响应', responsePanel], ['request', '请求', requestPanel], ['execution', '执行记录', executionPanel]];
  function activate(index, focus = false) {
    detail.tab = definitions[index][0];
    definitions.forEach(([id, , panel], position) => {
      const button = tabs.children[position]; const active = position === index;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; panel.hidden = !active;
      if (active && focus) button.focus();
    });
  }
  for (const [id, label, panel] of definitions) {
    const button = el('button', '', label); button.type = 'button'; button.id = `detail-tab-${id}`;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `detail-panel-${id}`);
    panel.id = `detail-panel-${id}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id); panel.tabIndex = 0;
    const index = definitions.findIndex(item => item[0] === id);
    button.addEventListener('click', () => activate(index));
    button.addEventListener('keydown', event => {
      const target = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
      if (target !== null) { event.preventDefault(); activate(target, true); }
    });
    tabs.append(button); panels.append(panel);
  }
  activate(Math.max(0, definitions.findIndex(([id]) => id === detail.tab))); fragment.append(tabs, panels); content.replaceChildren(fragment);
}

async function loadDetail() {
  if (!detail.id || !dialog.open) return;
  clearTimeout(detail.timer); detail.controller?.abort();
  const controller = new AbortController(); detail.controller = controller;
  const version = ++detail.version; refreshButton.disabled = true;
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(detail.id)}`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 404 ? '这条执行记录已不存在，可能已被清理或删除。' : `详情加载失败（HTTP ${response.status}），请重试。`);
    const run = await response.json();
    if (version !== detail.version || !dialog.open) return;
    content.querySelector('.detail-load-error')?.remove();
    const key = JSON.stringify(run); if (key !== detail.key) { detail.key = key; render(run); }
    if (run.status === 'running') detail.timer = setTimeout(loadDetail, 1000);
  } catch (error) {
    if (version !== detail.version || !dialog.open) return;
    const message = error.name === 'AbortError' || error instanceof TypeError ? '暂时无法读取详情，请检查连接后点击“刷新详情”。' : error.message;
    if (!detail.key) content.replaceChildren();
    content.querySelector('.detail-load-error')?.remove();
    const alert = el('div', 'detail-alert error detail-load-error', message); alert.setAttribute('role', 'alert'); content.prepend(alert);
  } finally { clearTimeout(timeout); if (version === detail.version) refreshButton.disabled = false; }
}

export function openRequestDetail(id, opener) {
  detail.controller?.abort(); clearTimeout(detail.timer); detail.version++;
  detail.id = id; detail.key = ''; detail.opener = opener; detail.tab = 'response';
  content.replaceChildren(el('p', 'detail-empty', '正在读取已保存的请求与返回…')); content.scrollTop = 0;
  if (!dialog.open) dialog.showModal();
  loadDetail();
}

document.getElementById('detail-close').addEventListener('click', () => dialog.close());
refreshButton.addEventListener('click', loadDetail);
dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
dialog.addEventListener('close', () => {
  detail.version++; detail.id = null; detail.controller?.abort(); clearTimeout(detail.timer);
  if (detail.opener?.isConnected) detail.opener.focus(); else document.getElementById('request-search').focus();
});
