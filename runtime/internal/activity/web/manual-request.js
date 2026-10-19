import { setupWorkspaceTabs } from './workspace-tabs.js';
import { openRequestDetail } from './request-detail.js';
import { requestAPI } from './request-api.js';

const $ = id => document.getElementById(id);
const form = $('manual-form');
const selectRequestTab = setupWorkspaceTabs('request-tabs');
function showExecution() { selectRequestTab($('request-execute-tab')); }
let busy = false;
let revision = 0;
let workingCopy = null;
let originalRequest = {};
let dirty = false, conflicted = false, sourceUnavailable = false;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function feedback(message = '', error = false) {
  const element = $('manual-feedback');
  element.textContent = message;
  element.hidden = !message;
  element.className = `detail-alert${error ? ' error' : ''}`;
  element.setAttribute('role', error ? 'alert' : 'status');
}

function syncBody() {
  const disabled = ['GET', 'HEAD'].includes($('manual-method').value);
  $('manual-body-type').disabled = disabled;
  $('manual-body-field').hidden = disabled || $('manual-body-type').value === 'none';
  $('manual-body-hint').hidden = !disabled;
}

function parseRows(text, separator, label) {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    const at = line.indexOf(separator);
    if (at < 1 || !line.slice(0, at).trim()) throw new Error(`${label}第 ${index + 1} 行格式有误，请使用 ${separator === ':' ? '名称: 值' : 'key=value'}。`);
    return [{ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim(), enabled: true }];
  });
}

function hasRedactions(request) {
  if (JSON.stringify(request).includes('••••')) return true;
  // Redacted query values in historical URLs are percent-encoded.
  try { return decodeURIComponent(request.url || '').includes('••••'); } catch { return false; }
}

function readRequest() {
  const url = $('manual-url').value.trim();
  if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('请求地址需要以 http:// 或 https:// 开头。');
  const method = $('manual-method').value;
  const bodyType = ['GET', 'HEAD'].includes(method) ? 'none' : $('manual-body-type').value;
  const request = {
    ...originalRequest, method, url,
    query_params: [...parseRows($('manual-query').value, '=', 'Query 参数'), ...(originalRequest.query_params || []).filter(row => !row.enabled)],
    headers: [...parseRows($('manual-headers').value, ':', 'Header'), ...(originalRequest.headers || []).filter(row => !row.enabled)],
    body_type: bodyType,
    body: bodyType === 'none' ? '' : $('manual-body').value,
  };
  if (hasRedactions(request)) throw new Error('请先替换历史快照中已脱敏的字段，再发送请求。');
  if (bodyType === 'json' && request.body.trim()) {
    try { JSON.parse(request.body); } catch { throw new Error('Body 不是有效的 JSON，请检查后再发送。'); }
  }
  return request;
}

const api = (path, body, method = 'POST') => requestAPI(path, body, method);

function display(value) {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return value == null ? '（空）' : JSON.stringify(value, null, 2);
}

function renderResponse(run) {
  const root = $('manual-response');
  const heading = node('div', 'manual-response-heading');
  const failed = ['failed', 'timed_out', 'cancelled'].includes(run.status) || run.response_status >= 400;
  heading.append(node('h3', '', '本次响应'), node('strong', failed ? 'response-error' : 'response-ok', run.response_status ? `HTTP ${run.response_status}` : run.status), node('span', 'subtle', `${run.duration_ms ?? 0} ms`));
  const details = node('button', 'button small', '请求与响应详情');
  details.type = 'button';
  details.addEventListener('click', () => openRequestDetail(run.id, details));
  heading.append(details);
  root.replaceChildren(heading);
  if (run.error_message) root.append(node('p', 'response-error', run.error_message));
  if (run.response_truncated) root.append(node('p', 'subtle', '响应正文已截断，最多保留 256 KB。'));
  root.append(node('pre', 'detail-code', display(run.response_body)));
  const headers = node('details', 'manual-response-headers');
  headers.append(node('summary', '', '响应 Headers'), node('pre', 'detail-code', display(run.response_headers)));
  root.append(headers);
  root.hidden = false;
}

form.addEventListener('input', () => { revision++; dirty = true; updateDraftState(); });
form.addEventListener('change', () => { revision++; dirty = true; updateDraftState(); });
$('manual-method').addEventListener('change', syncBody);
$('manual-body-type').addEventListener('change', syncBody);
async function newRequest() {
  if (busy || !replaceAllowed()) return;
  setBusy(true);
  try {
    await discardCopy();
    fillDraft({ method: 'GET', url: '', headers: [], query_params: [], body_type: 'none', body: '' });
    showExecution(); feedback(); $('manual-url').focus();
  } catch (error) { showExecution(); showOperationError(error); }
  finally { setBusy(false); }
}
$('manual-reset').addEventListener('click', newRequest);
$('library-new').addEventListener('click', newRequest);

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  let request;
  try { request = readRequest(); } catch (error) { feedback(error.message, true); return; }
  revision++; setBusy(true);
  $('manual-send').textContent = '发送中…';
  form.setAttribute('aria-busy', 'true');
  $('manual-response').hidden = true;
  feedback('请求执行中，正在等待响应…');
  try {
    await syncWorkingCopy(request);
    const run = await api('/runs', { working_copy_id: workingCopy.id });
    renderResponse(run);
    feedback(run.error_message ? '请求执行失败，详情和记录已保留。' : '请求已完成，已保存执行记录。', !!run.error_message);
    document.dispatchEvent(new Event('manual-request-completed'));
  } catch (error) { showOperationError(error); }
  finally {
    setBusy(false);
    $('manual-send').textContent = '发送请求 →';
    form.setAttribute('aria-busy', 'false');
    syncBody();
  }
});

export async function loadManualRequest(id) {
  if (busy || !replaceAllowed()) return;
  showExecution();
  const version = ++revision;
  let locked = false;
  feedback('正在读取历史请求…');
  try {
    const run = await api(`/runs/${encodeURIComponent(id)}`, null, 'GET');
    if (version !== revision || busy) return;
    const request = run.request_snapshot;
    if (!request) throw new Error('该记录没有可用的请求快照。');
    setBusy(true); locked = true;
    await discardCopy();
    fillDraft({ ...request, query_params: (request.query_params || []).filter(row => row.enabled), headers: (request.headers || []).filter(row => row.enabled), auth_config: undefined });
    $('manual-method').value = request.method;
    // Preserve uncommon methods found in imported/history requests.
    if (!$('manual-method').value) { $('manual-method').add(new Option(request.method, request.method)); $('manual-method').value = request.method; }
    $('manual-url').value = request.url || '';
    const pairs = (rows, separator) => (rows || []).filter(row => row.enabled).map(row => `${row.name}${separator}${row.value}`).join('\n');
    $('manual-query').value = pairs(request.query_params, '=');
    $('manual-headers').value = pairs(request.headers, ': ');
    const authType = request.auth_config?.type;
    if (['bearer', 'basic'].includes(authType) && !(request.headers || []).some(row => row.enabled && row.name.toLowerCase() === 'authorization')) {
      $('manual-headers').value += `${$('manual-headers').value ? '\n' : ''}Authorization: ••••••`;
    } else if (authType === 'api_key') {
      if (request.auth_config.in === 'query') $('manual-query').value += `${$('manual-query').value ? '\n' : ''}${request.auth_config.name || 'REPLACE_API_KEY_NAME'}=••••••`;
      else $('manual-headers').value += `${$('manual-headers').value ? '\n' : ''}${request.auth_config.name || 'REPLACE_API_KEY_NAME'}: ••••••`;
    }
    const type = request.body_type || (request.body ? 'raw' : 'none');
    $('manual-body-type').value = ['form', 'x-www-form-urlencoded'].includes(type) ? 'urlencoded' : type;
    if (!$('manual-body-type').value) $('manual-body-type').value = 'raw';
    $('manual-body').value = request.body || '';
    dirty = true; updateDraftState();
    syncBody();
    $('manual-response').hidden = true;
    feedback(hasRedactions(request) || request.auth_config?.redacted ? '已填入历史请求。请重新填写认证信息，替换脱敏值及 REPLACE_API_KEY_NAME 占位名称后再发送。' : '已填入历史请求，可修改后发送。');
    $('manual-url').focus();
    form.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  } catch (error) { if (version === revision) feedback(`读取请求失败：${error.message}`, true); }
  finally { if (locked) setBusy(false); }
}

syncBody();

function updateDraftState() {
  $('manual-draft-state').textContent = dirty ? '未保存修改' : workingCopy?.api_request_id ? '已载入保存的接口' : '临时请求';
  $('manual-save-new').hidden = !workingCopy?.api_request_id;
  $('manual-reload').hidden = !conflicted || !workingCopy?.api_request_id;
  $('manual-collection').disabled = !!workingCopy?.api_request_id;
}
function setBusy(value) {
  busy = value;
  $('manual-fields').disabled = value;
  for (const id of ['manual-reset', 'manual-save', 'manual-save-new', 'manual-reload', 'manual-import-submit', 'library-new']) $(id).disabled = value;
  form.setAttribute('aria-busy', String(value));
}
function replaceAllowed() {
  return !dirty || window.confirm('当前请求有未保存的修改，确定放弃并切换？');
}
async function discardCopy() {
  if (workingCopy) await api(`/working-copies/${encodeURIComponent(workingCopy.id)}/discard`, null);
}
async function syncWorkingCopy(request) {
  workingCopy = workingCopy
    ? await api(`/working-copies/${encodeURIComponent(workingCopy.id)}`, { ...workingCopy, request }, 'PUT')
    : await api('/working-copies', { name: $('manual-name').value.trim() || '手动请求', source_type: 'manual', request });
  return workingCopy;
}
function showOperationError(error) {
  if (error.status === 409 || error.status === 404) conflicted = true;
  feedback(conflicted ? '接口或草稿已在别处变更。本地编辑已保留，请重新载入接口，或另存为新接口。' : error.message, true);
  updateDraftState();
}
function fillDraft(request, copy = null, metadata = {}) {
  revision++;
  workingCopy = copy; originalRequest = structuredClone(request); conflicted = false; sourceUnavailable = false;
  form.reset();
  $('manual-name').value = metadata.name || copy?.name || '';
  $('manual-description').value = metadata.description || '';
  const collection = metadata.collection_id || '';
  if (collection && ![...$('manual-collection').options].some(option => option.value === collection)) $('manual-collection').add(new Option('原分组', collection));
  $('manual-collection').value = collection;
  $('manual-method').value = request.method || 'GET';
  if (!$('manual-method').value) { $('manual-method').add(new Option(request.method, request.method)); $('manual-method').value = request.method; }
  $('manual-url').value = request.url || '';
  const pairs = (rows, separator) => (rows || []).filter(row => row.enabled).map(row => `${row.name}${separator}${row.value}`).join('\n');
  $('manual-query').value = pairs(request.query_params, '=');
  $('manual-headers').value = pairs(request.headers, ': ');
  const type = request.body_type || (request.body ? 'raw' : 'none');
  $('manual-body-type').value = ['form', 'x-www-form-urlencoded'].includes(type) ? 'urlencoded' : type;
  if (!$('manual-body-type').value) $('manual-body-type').value = 'raw';
  $('manual-body').value = request.body || '';
  const count = [...(request.query_params || []), ...(request.headers || [])].filter(row => !row.enabled).length;
  $('manual-preserved').textContent = [count ? `保留 ${count} 条未启用的参数 / Header。` : '', request.auth_config ? '已保存的认证配置将完整保留。' : ''].filter(Boolean).join(' ');
  $('manual-preserved').hidden = !$('manual-preserved').textContent;
  dirty = false; syncBody(); updateDraftState(); $('manual-response').hidden = true;
}
export async function loadSavedRequest(id) {
  if (busy || !replaceAllowed()) return;
  showExecution();
  setBusy(true);
  try {
    const saved = await api(`/requests/${encodeURIComponent(id)}`, null, 'GET');
    const copy = await api('/working-copies', { api_request_id: saved.id });
    try { await discardCopy(); }
    catch (error) { await api(`/working-copies/${encodeURIComponent(copy.id)}/discard`, null); throw error; }
    fillDraft(copy.request, copy, saved);
    feedback('已载入接口。编辑后可保存更改，或直接发送调试。');
    $('manual-url').focus(); form.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  } catch (error) { showOperationError(error); }
  finally { setBusy(false); }
}
$('manual-save').addEventListener('click', async () => {
  if (busy) return;
  try {
    const name = $('manual-name').value.trim(), collection = $('manual-collection').value;
    if (!name || !collection) throw new Error('请填写接口名称并选择分组；没有分组时，先在接口库中新建。');
    if (sourceUnavailable || conflicted) throw new Error('原接口已归档或变更，请重新载入，或另存为新接口。');
    const request = readRequest();
    setBusy(true); await syncWorkingCopy(request);
    workingCopy = await api(`/working-copies/${encodeURIComponent(workingCopy.id)}/save`, {
      name, collection_id: collection, description: $('manual-description').value,
    });
    dirty = false; conflicted = false; feedback('接口已保存到接口库。'); updateDraftState();
    document.dispatchEvent(new Event('request-saved'));
  } catch (error) { showOperationError(error); }
  finally { setBusy(false); }
});
$('manual-save-new').addEventListener('click', async () => {
  if (busy) return; setBusy(true);
  try {
    await discardCopy(); workingCopy = null; conflicted = false; sourceUnavailable = false; dirty = true;
    updateDraftState(); feedback('已转为新接口草稿。请选择分组和名称，再点击“保存接口”。');
  } catch (error) { showOperationError(error); }
  finally { setBusy(false); }
});
$('manual-reload').addEventListener('click', () => { if (workingCopy?.api_request_id) void loadSavedRequest(workingCopy.api_request_id); });
$('manual-import-submit').addEventListener('click', async () => {
  if (busy || !replaceAllowed()) return;
  showExecution();
  const content = $('manual-import-text').value.trim();
  if (!content) { feedback('请先粘贴 cURL 或原始 HTTP 请求。', true); return; }
  setBusy(true);
  let imported;
  try {
    imported = await api('/import/curl', { content });
    try { await discardCopy(); } catch (error) {
      await api(`/working-copies/${encodeURIComponent(imported.id)}/discard`, null); throw error;
    }
    fillDraft(imported.request, imported); dirty = true; updateDraftState();
    $('manual-import-text').value = ''; $('manual-import-panel').open = false;
    feedback('已解析为草稿，尚未发送或保存。请检查内容后操作。');
  } catch (error) { showOperationError(error); }
  finally { setBusy(false); }
});
document.addEventListener('request-collections-loaded', event => {
  const select = $('manual-collection'), selected = select.value;
  select.replaceChildren(new Option('选择分组', ''), ...event.detail.map(item => new Option(item.name, item.id)));
  if (workingCopy?.api_request_id && selected && !event.detail.some(item => item.id === selected)) select.add(new Option('已归档分组', selected));
  select.value = selected; updateDraftState();
});
function markArchived() { sourceUnavailable = true; conflicted = true; feedback('原接口或分组已归档。当前编辑已保留，可另存为新接口。', true); updateDraftState(); }
document.addEventListener('request-archived', event => { if (workingCopy?.api_request_id === event.detail) markArchived(); });
document.addEventListener('request-collection-archived', event => { if (workingCopy?.api_request_id && $('manual-collection').value === event.detail) markArchived(); });
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
updateDraftState();
