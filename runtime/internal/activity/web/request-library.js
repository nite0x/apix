import {openArchived,showReferences,moveRequest,lifecycleAPI,lifecycleButton} from './lifecycle-ui.js';
import { requestAPI, requestError } from './request-api.js';
import { loadSavedRequest } from './manual-request.js';

const $ = id => document.getElementById(id);
let collections = [], requests = [], loading = false, busy = false;
function element(tag, text, cls) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function action(text, label, handler) {
  const button = element('button', text, 'button small'); button.type = 'button'; button.setAttribute('aria-label', label);
  button.disabled = busy; button.addEventListener('click', handler); return button;
}
function notice(text = '', error = false) {
  $('library-feedback').textContent = text; $('library-feedback').hidden = !text;
  $('library-feedback').className = `detail-alert${error ? ' error' : ''}`;
}
function render() {
  const select = $('library-collection'), selected = select.value;
  select.replaceChildren(new Option('全部分组', ''), ...collections.map(item => new Option(item.name, item.id)));
  select.value = collections.some(item => item.id === selected) ? selected : '';
  $('collection-rename').disabled = $('collection-archive').disabled = busy || !select.value;
  const query = $('library-search').value.trim().toLowerCase();
  const names = new Map(collections.map(item => [item.id, item.name]));
  const filtered = requests.filter(item => (!select.value || item.collection_id === select.value) &&
    `${item.name} ${item.request.method} ${item.request.url} ${names.get(item.collection_id)}`.toLowerCase().includes(query));
  const list = document.createDocumentFragment();
  for (const item of filtered) {
    const row = element('div', null, 'request-library-row');
    const info = element('div', null, 'request-library-info');
    info.append(element('strong', item.name), element('span', `${item.request.method} ${item.request.url}`), element('small', names.get(item.collection_id)));
    const buttons = element('div', null, 'request-actions');
    buttons.append(action('复制', `复制接口 ${item.name}`,()=>mutate(async()=>{await lifecycleAPI(`/requests/${encodeURIComponent(item.id)}/duplicate`,undefined,'POST');await refreshLibrary();})),action('移动分组',`移动接口 ${item.name}`,()=>moveRequest(item,refreshLibrary)),action('引用与影响',`查看接口 ${item.name} 的引用`,()=>showReferences('request',item.id)),action('编辑 / 调试', `编辑接口 ${item.name}`, () => loadSavedRequest(item.id)),
      action('归档', `归档接口 ${item.name}`, () => mutate(async () => {
        if (!window.confirm(`归档接口“${item.name}”？已有执行记录会保留。`)) return;
        await requestAPI(`/requests/${encodeURIComponent(item.id)}`, null, 'DELETE');
        document.dispatchEvent(new window.CustomEvent('request-archived', { detail: item.id }));
        await refreshLibrary();
      })));
    row.append(info, buttons); list.append(row);
  }
  if (!filtered.length) list.append(element('p', requests.length ? '没有匹配的接口。' : '还没有保存接口。点击“新增接口”或导入请求，在执行页选择分组并保存。', 'empty'));
  $('request-library').replaceChildren(list);
}
async function mutate(operation) {
  if (busy) return; busy = true; render(); notice();
  try { await operation(); }
  catch (error) { notice(requestError(error), true); }
  finally { busy = false; render(); }
}
export async function refreshLibrary() {
  if (loading) return; loading = true; $('library-refresh').disabled = true;
  try {
    const groups = await requestAPI('/collections') || [];
    const results = await Promise.all(groups.map(item => requestAPI(`/requests?collection_id=${encodeURIComponent(item.id)}`)));
    collections = groups; requests = results.flatMap(items => items || []); render(); notice();
    document.dispatchEvent(new window.CustomEvent('request-collections-loaded', { detail: collections }));
  } catch (error) { notice(`读取接口库失败：${requestError(error)}`, true); }
  finally { loading = false; $('library-refresh').disabled = false; }
}
const dialog = $('collection-dialog'), form = $('collection-form');
let editingCollection = null;
function openCollection(item = null) {
  editingCollection = item; $('collection-dialog-title').textContent = item ? '重命名分组' : '新建分组';
  $('collection-name').value = item?.name || ''; $('collection-error').hidden = true;
  dialog.showModal(); $('collection-name').focus();
}
$('collection-create').addEventListener('click', () => openCollection());
$('collection-rename').addEventListener('click', () => openCollection(collections.find(item => item.id === $('library-collection').value)));
$('collection-cancel').addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const name = $('collection-name').value.trim(); if (!name) { $('collection-name').focus(); return; }
  busy = true; $('collection-submit').disabled = $('collection-cancel').disabled = true;
  try {
    const item = await requestAPI(editingCollection ? `/collections/${encodeURIComponent(editingCollection.id)}` : '/collections', { ...editingCollection, name }, editingCollection ? 'PATCH' : 'POST');
    dialog.close(); await refreshLibrary(); $('library-collection').value = item.id; render();
    if (!$('manual-collection').disabled) $('manual-collection').value = item.id;
  } catch (error) { $('collection-error').textContent = requestError(error); $('collection-error').hidden = false; }
  finally { busy = false; $('collection-submit').disabled = $('collection-cancel').disabled = false; render(); }
});
$('collection-archive').addEventListener('click', () => mutate(async () => {
  const item = collections.find(item => item.id === $('library-collection').value);
  if (!item || !window.confirm(`归档分组“${item.name}”？包含 ${requests.filter(request=>request.collection_id===item.id).length} 个接口；接口自身的归档状态保持不变，已有执行记录保留。`)) return;
  await requestAPI(`/collections/${encodeURIComponent(item.id)}`, null, 'DELETE');
  document.dispatchEvent(new window.CustomEvent('request-collection-archived', { detail: item.id }));
  await refreshLibrary();
}));
$('library-collection').addEventListener('change', render);
$('library-search').addEventListener('input', render);
$('library-refresh').addEventListener('click', refreshLibrary);
document.addEventListener('request-saved', refreshLibrary);

$('library-refresh').parentElement.append(lifecycleButton('已归档接口',()=>openArchived('request',refreshLibrary)),lifecycleButton('已归档分组',()=>openArchived('collection',refreshLibrary)));
