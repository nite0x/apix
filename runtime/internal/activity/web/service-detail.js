import {environmentLabel} from './execution-environments.js';
const dialog = document.getElementById('service-detail');
const content = document.getElementById('service-detail-content');
const refresh = document.getElementById('service-detail-refresh');
const labels = { running: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停止', failed: '异常', cleanup_failed: '清理失败' };
const detail = { id: null, opener: null, controller: null, version: 0, timer: null, key: '' };

function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; }
function section(title, body) { const node = el('section', 'detail-section'); node.append(el('h3', '', title), body); return node; }
function pairs(values) {
  const list = el('dl', 'detail-pairs');
  for (const [name, value] of values) {
    const description = el('dd', '', value ?? '—');
    if (name === '检查时间') description.id = 'service-health-checked-at';
    list.append(el('dt', '', name), description);
  }
  return list;
}

function render(data) {
  const { definition: d, instance, health, logs } = data;
  const external = instance.owner === 'external';
  const owner = external ? '外部服务（仅复用）' : instance.owner === 'manual' ? '手动启动' : instance.owner ? `流程 ${instance.owner}` : '尚未启动';
  const fragment = document.createDocumentFragment();
  const summary = el('div', 'detail-summary');
  const status = el('div', 'detail-result'); status.append(el('strong', '', d.name), el('span', `badge status-${instance.status}`, labels[instance.status] || instance.status));
  summary.append(status, el('div', 'detail-url', d.health_url)); fragment.append(summary);
  fragment.append(section('运行状态', pairs([
    ['运行环境',environmentLabel(d.environment_id)], ['服务 ID', d.id], ['归属', owner], ['进程 PID', instance.pid || (external ? '外部进程，未接管' : '—')],
    ['健康检查', health.healthy ? '通过（HTTP 2xx）' : health.error || '未通过'], ['检查时间', new Date(health.checked_at).toLocaleString('zh-CN')],
  ])));
  fragment.append(el('p', 'detail-note', external ? '根据配置的健康检查地址发现已有服务，健康检查从服务所在环境发起；接口测试还需要 Windows 主程序能访问该地址。Apix 不接管或停止该进程，也无法读取它的 stdout/stderr；下方只展示 Apix 已保存的历史日志。' : '启动时优先复用已运行的实例。流程只清理自己启动的服务；复用其他流程或手动启动的服务时保留原有归属。'));
  fragment.append(section('启动配置', pairs([
    ['可执行文件', d.command], ['工作目录', d.work_dir], ['启动超时', `${d.startup_timeout_ms.toLocaleString('zh-CN')} ms`], ['健康检查地址', d.health_url],
  ])));
  if(instance.environment_error)fragment.append(el('p','detail-alert error',instance.environment_error));
  fragment.append(section('启动参数（按顺序）', el('pre', 'detail-code', JSON.stringify(d.args || [], null, 2))));
  const output = el('pre', 'detail-code', logs.length ? logs.map(line => `${new Date(line.time).toLocaleString('zh-CN')} [${line.stream}] ${line.message}`).join('\n') : '暂无已保存的服务日志。');
  output.tabIndex = 0;
  fragment.append(section('最近 100 条日志', output));
  const allLogs = el('a', 'text-button', '查看全部服务日志 →'); allLogs.href = `/logs?source=${encodeURIComponent(d.id)}`; allLogs.dataset.route = ''; fragment.append(allLogs);
  const previousTop = content.scrollTop; content.replaceChildren(fragment); content.scrollTop = previousTop;
}

async function load() {
  if (!detail.id || !dialog.open) return;
  clearTimeout(detail.timer); detail.controller?.abort();
  const version = ++detail.version; const controller = new AbortController(); detail.controller = controller; refresh.disabled = true;
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`/api/services/${encodeURIComponent(detail.id)}`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 404 ? '服务配置已不存在。' : `详情加载失败（HTTP ${response.status}），请重试。`);
    const data = await response.json(); if (version !== detail.version || !dialog.open) return;
    // Keep focus and selection when only the health check timestamp changes.
    const key = JSON.stringify({ ...data, health: { healthy: data.health.healthy } });
    content.querySelector('.detail-load-error')?.remove();
    if (key !== detail.key) { detail.key = key; render(data); }
    else document.getElementById('service-health-checked-at').textContent = new Date(data.health.checked_at).toLocaleString('zh-CN');
  } catch (error) {
    if (version !== detail.version || !dialog.open) return;
    if (!detail.key) content.replaceChildren();
    content.querySelector('.detail-load-error')?.remove();
    const message = error.name === 'AbortError' || error instanceof TypeError ? '暂时无法读取详情，请检查连接后刷新。' : error.message;
    const alert = el('div', 'detail-alert error detail-load-error', message); alert.setAttribute('role', 'alert'); content.prepend(alert);
  } finally {
    clearTimeout(timeout);
    if (version === detail.version && dialog.open) { refresh.disabled = false; detail.timer = setTimeout(load, 3000); }
  }
}

export function openServiceDetail(id, opener) {
  detail.controller?.abort(); clearTimeout(detail.timer); detail.version++;
  detail.id = id; detail.opener = opener; detail.key = '';
  content.replaceChildren(el('p', 'detail-empty', '正在读取服务配置、状态和日志…')); content.scrollTop = 0;
  if (!dialog.open) dialog.showModal(); load();
}

document.getElementById('service-detail-close').addEventListener('click', () => dialog.close());
refresh.addEventListener('click', () => { detail.key = ''; load(); });
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});
dialog.addEventListener('close', () => {
  detail.version++; detail.id = null; detail.controller?.abort(); clearTimeout(detail.timer);
  if (detail.opener?.isConnected) detail.opener.focus(); else document.getElementById('page-title').focus();
});
