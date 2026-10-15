export const statusNames = { queued: '排队中', pending: '待执行', running: '运行中', paused: '等待确认', succeeded: '已通过', failed: '失败', skipped: '已跳过', cancelled: '已取消' };
export const activeStatus = status => ['queued', 'running', 'paused'].includes(status);
export const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const display = value => typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
export const endpoint = step => step.type === 'sql' ? step.sql?.sql || '配置 SQL 查询' : step.type === 'service' ? step.service?.action === 'stop' ? '停止指定服务' : '启动或复用指定服务' : step.request?.url || '配置请求地址';
export function blankStep(type = 'http') {
  const step = { id: crypto.randomUUID(), type, name: type === 'sql' ? '数据库检查' : type === 'service' ? '准备服务' : '新的请求', position: 0, enabled: true, source_api_request_id: null, request: {}, config: { continue_on_error: false, extractors: [], assertions: [] } };
  if (type === 'http') step.request = { method: 'GET', url: '', query_params: [], headers: [], body_type: 'none', body: '' };
  if (type === 'sql') step.sql = { connection_id: '', mode: 'query', sql: '', params: [], max_rows: 100 };
  if (type === 'service') step.service = { service_id: '', action: 'start' };
  return step;
}
export function uniqueName(items, prefix) {
  let index = 1; while (items.some(item => item.name === `${prefix}_${index}`)) index++;
  return `${prefix}_${index}`;
}
export function validateDefinition(flow, running = false) {
  if (!flow.name.trim() || flow.name.length > 120) return '流程名称需要 1–120 个字符。';
  const seen = new Set();
  for (const variable of flow.variables) {
    if (!variableName.test(variable.name)) return `变量“${variable.name}”的名称只能包含字母、数字、下划线，且不能以数字开头。`;
    if (seen.has(variable.name)) return `变量“${variable.name}”重复，请使用不同名称。`;
    if (variable.secret && variable.default_value) return '敏感变量请在运行前输入，不设置默认值。';
    seen.add(variable.name);
  }
  for (const step of flow.steps) {
    const names = new Set();
    for (const extractor of step.config.extractors || []) {
      if (!variableName.test(extractor.name) || names.has(extractor.name)) return `步骤“${step.name}”的提取变量名无效或重复。`;
      if (extractor.source === 'header' && !extractor.path?.trim()) return `步骤“${step.name}”的响应头提取需要填写头名称。`;
      names.add(extractor.name);
    }
    for (const assertion of step.config.assertions || []) {
      if (assertion.source === 'header' && !assertion.path?.trim()) return `步骤“${step.name}”的响应头断言需要填写头名称。`;
    }
    if (!running || !step.enabled) continue;
    if (step.type === 'http' && !step.request.url.trim()) return `请填写步骤“${step.name}”的请求地址。`;
    if (step.type === 'sql' && (!step.sql?.connection_id || !step.sql?.sql.trim())) return `请完善步骤“${step.name}”的数据库连接和 SQL。`;
    if (step.type === 'service' && !step.service?.service_id) return `请为步骤“${step.name}”选择服务。`;
  }
  if (running && !flow.steps.some(step => step.enabled)) return '请至少添加并启用一个步骤。';
  return '';
}
export function requestURL(request) {
  try { const url = new URL(request.url); for (const pair of request.query_params || []) if (pair.enabled && pair.name) url.searchParams.append(pair.name, pair.value); return url.toString(); }
  catch { return request.url || ''; }
}
