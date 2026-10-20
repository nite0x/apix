import {openArchived,showReferences,lifecycleButton,openBulkManager} from './lifecycle-ui.js';
const $ = id => document.getElementById(id);
const dialog = $('service-editor');
const form = $('service-form');
let saving = false;
let draftID = null;
let savedSignature = '';
let opener = null;
let editing = false;
let editVersion=0;
let loading = false;
let loadController = null;
const deleteDialog = $('service-delete');
let deleteTarget = null;
let deleteOpener = null;
let deleting = false;

function notice(id, text = '', error = false) {
  const element = $(id); element.textContent = text; element.hidden = !text;
  element.classList.toggle('error', error); element.setAttribute('role', error ? 'alert' : 'status');
}

async function api(path, body, method, signal) {
  const response = await fetch(`/api/services${path}`, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function changed(detail) { document.dispatchEvent(new window.CustomEvent('service-configuration-changed', { detail })); }

function setLoading(value) {
  loading = value;
  $('service-fields').disabled = value;
  $('service-save').disabled = value;
  $('service-save-start').disabled = value;
  form.setAttribute('aria-busy', String(value));
}

function openEditor(trigger, edit) {
  opener = trigger; editing = edit; savedSignature = '';
  form.reset();editVersion=0; notice('service-form-error');
  $('service-editor-title').textContent = edit ? '编辑服务' : '新增服务';
  $('service-save').textContent = edit ? '保存修改' : '仅保存';
  $('service-save').classList.toggle('primary', edit);
  $('service-save-start').hidden = edit;
  dialog.showModal();
}

$('service-add').addEventListener('click', event => {
  if (saving || loading) return;
  draftID = crypto.randomUUID(); openEditor(event.currentTarget, false);
});

export async function openServiceEditor(id, trigger) {
  if (saving || loading) return;
  draftID = id; openEditor(trigger, true); setLoading(true);
  notice('service-form-error', '正在读取服务配置…');
  const controller = new AbortController(); loadController = controller;
  try {
    const { definition: d } = await api(`/${encodeURIComponent(id)}`, undefined, 'GET', controller.signal);
    if (controller.signal.aborted || !dialog.open) return;
    editVersion=d.edit_version||0;$('service-name').value = d.name; $('service-work-dir').value = d.work_dir;
    $('service-command').value = d.command; $('service-args').value = (d.args || []).join('\n');
    $('service-health-url').value = d.health_url; $('service-timeout').value = d.startup_timeout_ms / 1000;
    notice('service-form-error'); setLoading(false); $('service-name').focus();
  } catch (error) {
    if (!controller.signal.aborted && dialog.open) notice('service-form-error', `读取配置失败：${error.message}。请关闭后重试。`, true);
  } finally {
    if (loadController === controller) loadController = null;
  }
}

export function openServiceDelete(service, trigger) {
  if (deleting) return;
  deleteTarget = service; deleteOpener = trigger;
  const name=$('service-delete-name');name.textContent=service.name;const warning=$('service-delete-description');warning.replaceChildren(document.createTextNode('归档“'),name,document.createTextNode(`”的配置？历史日志已保留${service.owner==='external'?'；外部进程继续运行':''}。有效流程引用需要先处理。`));
  notice('service-delete-error'); deleteDialog.showModal();
}

$('service-delete-cancel').addEventListener('click', () => { if (!deleting) deleteDialog.close(); });
deleteDialog.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
deleteDialog.addEventListener('close', () => {
  deleteTarget = null;
  if (deleteOpener?.isConnected) deleteOpener.focus(); else $('service-add').focus();
});
$('service-delete-confirm').addEventListener('click', async () => {
  if (deleting || !deleteTarget) return;
  const service = deleteTarget;
  deleting = true; $('service-delete-confirm').disabled = true; $('service-delete-cancel').disabled = true;
  $('service-delete-confirm').textContent = '归档中…'; notice('service-delete-error');
  try {
    await api(`/${encodeURIComponent(service.id)}/archive`, undefined, 'POST');
    changed({ deletedID: service.id }); deleteDialog.close(); $('service-add').focus();
    notice('service-editor-feedback', `已归档“${service.name}”的服务配置，历史日志已保留。`);
  } catch (error) { notice('service-delete-error', `归档失败：${error.message}`, true); }
  finally {
    deleting = false; $('service-delete-confirm').disabled = false; $('service-delete-cancel').disabled = false;
    $('service-delete-confirm').textContent = '归档服务';
  }
});

for (const id of ['service-editor-close', 'service-editor-cancel']) $(id).addEventListener('click', () => { if (!saving) dialog.close(); });
dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
dialog.addEventListener('close', () => {
  loadController?.abort(); loadController = null; setLoading(false);
  if (opener?.isConnected) opener.focus(); else $('service-add').focus();
});

export function closeServiceEditor() {
  if (!saving && dialog.open) dialog.close();
  if (!deleting && deleteDialog.open) deleteDialog.close();
}

form.addEventListener('submit', async event => {
  event.preventDefault(); if (saving || loading) return;
  const start = !editing && event.submitter?.id !== 'service-save';
  const definition = {
    id: draftID,edit_version:editVersion, name: $('service-name').value.trim(), work_dir: $('service-work-dir').value.trim(),
    command: $('service-command').value.trim(), args: $('service-args').value.split(/\r?\n/).filter(line => line.trim() !== ''),
    health_url: $('service-health-url').value.trim(), startup_timeout_ms: Number($('service-timeout').value) * 1000,
  };
  if (!definition.name || !definition.work_dir || !definition.command) { notice('service-form-error', '请填写服务名称、工作目录和启动程序。', true); return; }
  try { if (!['http:', 'https:'].includes(new URL(definition.health_url).protocol)) throw new Error(); }
  catch { notice('service-form-error', '健康检查地址需要是完整的 HTTP 或 HTTPS 地址。', true); return; }
  if (!Number.isInteger(definition.startup_timeout_ms) || definition.startup_timeout_ms < 1000 || definition.startup_timeout_ms > 300000) { notice('service-form-error', '启动超时需为 1–300 秒。', true); return; }
  saving = true; $('service-fields').disabled = true;
  for (const id of ['service-editor-close', 'service-editor-cancel', 'service-save', 'service-save-start']) $(id).disabled = true;
  form.setAttribute('aria-busy', 'true'); $('service-save-start').textContent = start ? '启动中…' : '保存并启动';
  notice('service-form-error'); notice('service-editor-feedback');
  const signature = JSON.stringify({...definition,edit_version:0});
  try {
    if (savedSignature !== signature) { const saved=await api('', definition, 'PUT');editVersion=saved.edit_version||0; savedSignature = signature; changed(); }
    if (start) {
      const result = await api(`/${encodeURIComponent(draftID)}/start`, { owner: 'manual' }, 'POST');
      notice('service-editor-feedback', result.started ? `“${definition.name}”已启动。` : `“${definition.name}”已复用已有运行实例。`);
    } else notice('service-editor-feedback', editing ? `已更新“${definition.name}”的服务配置，下次启动时生效。` : `已保存“${definition.name}”，可在服务列表中点击“启动”。`);
    dialog.close();
  } catch (error) {
    notice('service-form-error', `${savedSignature === signature ? '配置已保存，启动未完成' : '保存失败'}：${error.message}。可查看服务状态和日志后重试。`, true);
  } finally {
    saving = false; $('service-fields').disabled = false;
    for (const id of ['service-editor-close', 'service-editor-cancel', 'service-save', 'service-save-start']) $(id).disabled = false;
    $('service-save-start').textContent = '保存并启动'; form.setAttribute('aria-busy', 'false'); changed();
  }
});

$('service-add').parentElement.append(lifecycleButton('已归档服务',()=>openArchived('service',()=>changed())));

$('service-add').parentElement.append(lifecycleButton('批量管理',()=>openBulkManager('service',()=>changed())));
