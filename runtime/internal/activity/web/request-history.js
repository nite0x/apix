import { requestAPI, requestError } from './request-api.js';
import { openRequestDetail } from './request-detail.js';
import { loadManualRequest } from './manual-request.js';

const $ = id => document.getElementById(id);
let runs = [], loading = false, pending = new Set(), version = 0, renderKey = '';
function node(tag, text, cls) { const item = document.createElement(tag); if (text != null) item.textContent = text; if (cls) item.className = cls; return item; }
function notice(text = '') { $('history-feedback').textContent = text; $('history-feedback').hidden = !text; }
function render() {
  const query = $('request-search').value.trim().toLowerCase(), status = $('history-status').value, pinned = $('history-pinned').checked;
  const key = JSON.stringify([runs, query, status, pinned, [...pending]]);
  if (key === renderKey) return; renderKey = key;
  const rows = runs.filter(run => (!status || run.status === status) && (!pinned || run.is_pinned) &&
    `${run.request_snapshot.method} ${run.request_snapshot.url}`.toLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const run of rows) {
    const row = node('tr', null, 'request-row'), request = node('td'), info = node('div', null, 'request-cell');
    const button = (text, label, handler) => {
      const item = node('button', text, 'text-button'); item.type = 'button'; item.setAttribute('aria-label', label);
      item.disabled = pending.has(run.id); item.addEventListener('click', handler); return item;
    };
    const url = button(run.request_snapshot.url, `查看请求 ${run.id}`, event => openRequestDetail(run.id, event.currentTarget));
    url.classList.add('request-url'); url.title = run.request_snapshot.url;
    info.append(node('span', run.request_snapshot.method, `method ${run.request_snapshot.method.toLowerCase()}`), url);
    request.append(info);
    const reuse = node('td', null, 'history-reuse');
    reuse.append(button('填入编辑器', `填入请求 ${run.id}`, () => loadManualRequest(run.id)));
    const actions = node('td', null, 'history-actions');
    actions.append(button(run.is_pinned ? '取消固定' : '固定', `固定请求 ${run.id}`, () => mutate(run, async () => {
      await requestAPI(`/runs/${encodeURIComponent(run.id)}/pin`, { pinned: !run.is_pinned }, 'POST');
      run.is_pinned = !run.is_pinned;
    })), button('删除', `删除请求 ${run.id}`, () => mutate(run, async () => {
      if (!window.confirm('删除这条执行记录？此操作无法恢复，已保存的接口定义不受影响。')) return;
      await requestAPI(`/runs/${encodeURIComponent(run.id)}`, null, 'DELETE');
      runs = runs.filter(item => item.id !== run.id);
    })));
    row.append(request, node('td', run.response_status ?? run.status), node('td', `${run.duration_ms ?? 0} ms`),
      node('td', new Date(run.started_at).toLocaleString('zh-CN', { hour12: false })), reuse, actions);
    fragment.append(row);
  }
  if (!rows.length) { const row = node('tr'), cell = node('td', runs.length ? '没有匹配的执行记录。' : '还没有执行记录。', 'empty'); cell.colSpan = 6; row.append(cell); fragment.append(row); }
  $('requests').replaceChildren(fragment);
}
async function mutate(run, operation) {
  if (pending.has(run.id)) return; pending.add(run.id); version++; render(); notice();
  try { await operation(); document.dispatchEvent(new Event('request-history-changed')); }
  catch (error) { notice(requestError(error)); }
  finally { pending.delete(run.id); render(); }
}
export async function refreshRequestHistory() {
  if (loading || pending.size) return; loading = true; const token = version;
  try { const items = await requestAPI('/runs?summary=true&limit=200'); if (token === version) { runs = items || []; render(); notice(); } }
  catch (error) { notice(`读取历史失败：${requestError(error)}`); }
  finally { loading = false; }
}
$('request-search').addEventListener('input', render);
$('history-status').addEventListener('change', render);
$('history-pinned').addEventListener('change', render);
$('history-refresh').addEventListener('click', refreshRequestHistory);
document.addEventListener('manual-request-completed', refreshRequestHistory);
