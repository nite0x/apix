import { openRequestDetail } from './request-detail.js';

const $ = id => document.getElementById(id);
const form = $('manual-form');
let busy = false;
let revision = 0;
let workingCopy = null;

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
    method, url,
    query_params: parseRows($('manual-query').value, '=', 'Query 参数'),
    headers: parseRows($('manual-headers').value, ':', 'Header'),
    body_type: bodyType,
    body: bodyType === 'none' ? '' : $('manual-body').value,
  };
  if (hasRedactions(request)) throw new Error('请先替换历史快照中已脱敏的字段，再发送请求。');
  if (bodyType === 'json' && request.body.trim()) {
    try { JSON.parse(request.body); } catch { throw new Error('Body 不是有效的 JSON，请检查后再发送。'); }
  }
  return request;
}

async function api(path, body, method = 'POST') {
  const response = await fetch(`/api${path}`, {
    method, cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  // Transport failures return HTTP 502 with the persisted run and its details.
  if (!response.ok && !(path === '/runs' && result.id && result.request_snapshot)) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

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

form.addEventListener('input', () => { revision++; });
$('manual-method').addEventListener('change', syncBody);
$('manual-body-type').addEventListener('change', syncBody);
$('manual-reset').addEventListener('click', () => {
  if (busy) return;
  revision++; workingCopy = null;
  form.reset(); syncBody(); feedback();
  $('manual-response').hidden = true;
  $('manual-url').focus();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  let request;
  try { request = readRequest(); } catch (error) { feedback(error.message, true); return; }
  revision++; busy = true;
  $('manual-fields').disabled = true;
  $('manual-reset').disabled = true;
  $('manual-send').textContent = '发送中…';
  form.setAttribute('aria-busy', 'true');
  $('manual-response').hidden = true;
  feedback('请求执行中，正在等待响应…');
  try {
    workingCopy = workingCopy
      ? await api(`/working-copies/${encodeURIComponent(workingCopy.id)}`, { ...workingCopy, request }, 'PUT')
      : await api('/working-copies', { name: '手动请求', source_type: 'manual', request });
    const run = await api('/runs', { working_copy_id: workingCopy.id });
    renderResponse(run);
    feedback(run.error_message ? '请求执行失败，详情和记录已保留。' : '请求已完成，已保存执行记录。', !!run.error_message);
    document.dispatchEvent(new Event('manual-request-completed'));
  } catch (error) { feedback(`发送失败：${error.message}`, true); }
  finally {
    busy = false;
    $('manual-fields').disabled = false;
    $('manual-reset').disabled = false;
    $('manual-send').textContent = '发送请求 →';
    form.setAttribute('aria-busy', 'false');
    syncBody();
  }
});

export async function loadManualRequest(id) {
  if (busy) return;
  const version = ++revision;
  feedback('正在读取历史请求…');
  try {
    const run = await api(`/runs/${encodeURIComponent(id)}`, null, 'GET');
    if (version !== revision || busy) return;
    const request = run.request_snapshot;
    if (!request) throw new Error('该记录没有可用的请求快照。');
    form.reset(); workingCopy = null;
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
    syncBody();
    $('manual-response').hidden = true;
    feedback(hasRedactions(request) || request.auth_config?.redacted ? '已填入历史请求。请重新填写认证信息，替换脱敏值及 REPLACE_API_KEY_NAME 占位名称后再发送。' : '已填入历史请求，可修改后发送。');
    $('manual-url').focus();
    form.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  } catch (error) { if (version === revision) feedback(`读取请求失败：${error.message}`, true); }
}

syncBody();
