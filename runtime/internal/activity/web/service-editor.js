const $ = id => document.getElementById(id);
const dialog = $('service-editor');
const form = $('service-form');
let saving = false;
let draftID = null;
let savedSignature = '';
let opener = null;

function notice(id, text = '', error = false) {
  const element = $(id); element.textContent = text; element.hidden = !text;
  element.classList.toggle('error', error); element.setAttribute('role', error ? 'alert' : 'status');
}

async function api(path, body, method) {
  const response = await fetch(`/api/services${path}`, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function changed() { document.dispatchEvent(new Event('service-configuration-changed')); }

$('service-add').addEventListener('click', event => {
  if (saving) return;
  opener = event.currentTarget; draftID = crypto.randomUUID(); savedSignature = '';
  form.reset(); notice('service-form-error'); dialog.showModal();
});

for (const id of ['service-editor-close', 'service-editor-cancel']) $(id).addEventListener('click', () => { if (!saving) dialog.close(); });
dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); });

export function closeServiceEditor() { if (!saving && dialog.open) dialog.close(); }

form.addEventListener('submit', async event => {
  event.preventDefault(); if (saving) return;
  const start = event.submitter?.id !== 'service-save';
  const definition = {
    id: draftID, name: $('service-name').value.trim(), work_dir: $('service-work-dir').value.trim(),
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
  const signature = JSON.stringify(definition);
  try {
    if (savedSignature !== signature) { await api('', definition, 'PUT'); savedSignature = signature; changed(); }
    if (start) {
      const result = await api(`/${encodeURIComponent(draftID)}/start`, { owner: 'manual' }, 'POST');
      notice('service-editor-feedback', result.started ? `“${definition.name}”已启动。` : `“${definition.name}”已复用已有运行实例。`);
    } else notice('service-editor-feedback', `已保存“${definition.name}”，可在服务列表中点击“启动”。`);
    dialog.close();
  } catch (error) {
    notice('service-form-error', `${savedSignature === signature ? '配置已保存，启动未完成' : '保存失败'}：${error.message}。可查看服务状态和日志后重试。`, true);
  } finally {
    saving = false; $('service-fields').disabled = false;
    for (const id of ['service-editor-close', 'service-editor-cancel', 'service-save', 'service-save-start']) $(id).disabled = false;
    $('service-save-start').textContent = '保存并启动'; form.setAttribute('aria-busy', 'false'); changed();
  }
});
