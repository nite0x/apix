export interface Pair {
  name: string;
  value: string;
  enabled: boolean;
}
export interface Assertion {
  source: string;
  path?: string;
  operator: string;
  expected?: string;
}
export interface Extractor {
  name: string;
  source: string;
  path?: string;
  scope?: string;
  required?: boolean;
  secret?: boolean;
}
export interface FlowStep {
  id: string;
  type: string;
  name: string;
  position: number;
  enabled: boolean;
  source_api_request_id?: string | null;
  source_status?: string;
  request: {
    method?: string;
    url?: string;
    query_params?: Pair[];
    headers?: Pair[];
    body_type?: string;
    body?: string;
    auth_config?: Record<string, string>;
    [key: string]: any;
  };
  sql?: { connection_id: string; mode: string; sql: string; params: unknown[]; max_rows: number };
  service?: { service_id: string; action: string };
  config: {
    phase?: string;
    failure_policy?: string;
    continue_on_error?: boolean;
    skip_if_missing_outputs?: boolean;
    expected_status?: number;
    expected_rows?: number;
    timeout_ms?: number;
    assertions: Assertion[];
    extractors: Extractor[];
  };
}
export interface FlowVariable {
  name: string;
  default_value?: string;
  description?: string;
  required: boolean;
  secret: boolean;
}
export interface Flow {
  id: string;
  name: string;
  description: string;
  steps: FlowStep[];
  variables: FlowVariable[];
  settings: { stop_on_error: boolean; request_timeout_ms: number };
  edit_version: number;
  archived_at?: string | null;
  updated_at?: string;
  [key: string]: any;
}
export const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const activeStatus = (status: string) => ['queued', 'running', 'paused'].includes(status);
export const display = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
export const isFinally = (step: FlowStep) => step.config?.phase === 'finally';
export const orderedSteps = (steps: FlowStep[]) => [
  ...steps.filter((step) => !isFinally(step)),
  ...steps.filter(isFinally),
];
export const outputReference = (stepID: string, name: string) =>
  '{{steps.' + stepID + '.outputs.' + name + '}}';
export const failurePolicy = (step: FlowStep) =>
  step.config.failure_policy || (step.config.continue_on_error ? 'continue' : 'inherit');
export const uniqueName = (items: { name: string }[], prefix: string) => {
  let index = 1;
  while (items.some((item) => item.name === `${prefix}_${index}`)) index++;
  return `${prefix}_${index}`;
};
export function blankStep(type = 'http'): FlowStep {
  const step: FlowStep = {
    id: crypto.randomUUID(),
    type,
    name: type === 'sql' ? '数据库检查' : type === 'service' ? '准备服务' : '新的请求',
    position: 0,
    enabled: true,
    source_api_request_id: null,
    request: {},
    config: { continue_on_error: false, extractors: [], assertions: [] },
  };
  if (type === 'http')
    step.request = {
      method: 'GET',
      url: '',
      query_params: [],
      headers: [],
      body_type: 'none',
      body: '',
    };
  if (type === 'sql')
    step.sql = { connection_id: '', mode: 'query', sql: '', params: [], max_rows: 100 };
  if (type === 'service') step.service = { service_id: '', action: 'start' };
  return step;
}
export function sourceChoices(step: FlowStep): [string, string][] {
  return step.type !== 'sql'
    ? [
        ['body', '响应体'],
        ['header', '响应头'],
        ['status', '状态码'],
      ]
    : step.sql?.mode === 'exec'
      ? [['rows_affected', '影响行数']]
      : [
          ['rows', '查询字段'],
          ['row_count', '查询行数'],
        ];
}
export function availableOutputs(steps: FlowStep[], target: FlowStep): [string, string][] {
  const choices: [string, string][] = [];
  for (const step of orderedSteps(steps)) {
    if (step.id === target.id) break;
    if (!step.enabled) continue;
    for (const output of step.config.extractors || [])
      if (variableName.test(output.name))
        choices.push([outputReference(step.id, output.name), step.name + ' → ' + output.name]);
  }
  return choices;
}
export function copyFlowSteps(steps: FlowStep[]): FlowStep[] {
  const ids = new Map(steps.map((step) => [step.id, crypto.randomUUID()]));
  const remap = (value: any): any =>
    typeof value === 'string'
      ? value.replace(
          /(\{\{\s*steps\.)([^{}\s.]+)(\.outputs\.[A-Za-z_][A-Za-z0-9_]*\s*\}\})/g,
          (all, prefix, id, suffix) => (ids.has(id) ? prefix + ids.get(id) + suffix : all),
        )
      : Array.isArray(value)
        ? value.map(remap)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]))
          : value;
  return structuredClone(steps).map((step) => ({ ...remap(step), id: ids.get(step.id)! }));
}
export function validateOutputReferences(steps: FlowStep[]): string {
  const previous = new Map<string, FlowStep>();
  for (const step of orderedSteps(steps)) {
    const values: unknown[] = [];
    if (step.type === 'http') {
      values.push(
        step.request.url,
        step.request.body,
        ...Object.values(step.request.auth_config || {}),
      );
      values.push(
        ...(step.request.headers || []).filter((item) => item.enabled).map((item) => item.value),
        ...(step.request.query_params || [])
          .filter((item) => item.enabled)
          .map((item) => item.value),
      );
    }
    if (step.sql)
      values.push(...(step.sql.params || []).filter((value) => typeof value === 'string'));
    values.push(
      ...(step.config.assertions || [])
        .filter((item) => item.operator !== 'exists')
        .map((item) => item.expected),
    );
    for (const value of values) {
      if (typeof value !== 'string') continue;
      for (const token of value.matchAll(/\{\{([^{}]+)\}\}/g)) {
        const key = token[1].trim();
        if (!key.startsWith('steps.')) continue;
        const reference = /^steps\.([^{}\s.]+)\.outputs\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(key);
        if (!reference) return '步骤“' + step.name + '”的输出引用格式无效。';
        const source = previous.get(reference[1]);
        if (!source) return '步骤“' + step.name + '”引用的输出来自已删除或位于后面的步骤。';
        if (step.enabled && !source.enabled)
          return '步骤“' + step.name + '”引用了已禁用步骤“' + source.name + '”的输出。';
        if (!(source.config.extractors || []).some((output) => output.name === reference[2]))
          return '步骤“' + step.name + '”引用的输出“' + reference[2] + '”不存在。';
      }
    }
    if (step.sql?.sql.includes('{{steps.')) return '步骤输出请通过 SQL 绑定参数传入。';
    previous.set(step.id, step);
  }
  return '';
}
export function validateDefinition(flow: Flow, running = false): string {
  if (!flow.name.trim() || flow.name.length > 120) return '流程名称需要 1–120 个字符。';
  const seen = new Set<string>();
  for (const variable of flow.variables) {
    if (!variableName.test(variable.name))
      return `变量“${variable.name}”的名称只能包含字母、数字、下划线，且不能以数字开头。`;
    if (seen.has(variable.name)) return `变量“${variable.name}”重复，请使用不同名称。`;
    if (variable.secret && variable.default_value) return '敏感变量请在运行前输入，不设置默认值。';
    seen.add(variable.name);
  }
  for (const step of flow.steps) {
    const names = new Set<string>();
    for (const extractor of step.config.extractors || []) {
      if (!variableName.test(extractor.name) || names.has(extractor.name))
        return `步骤“${step.name}”的提取变量名无效或重复。`;
      if (extractor.source === 'header' && !extractor.path?.trim())
        return `步骤“${step.name}”的响应头提取需要填写头名称。`;
      names.add(extractor.name);
    }
    for (const assertion of step.config.assertions || [])
      if (assertion.source === 'header' && !assertion.path?.trim())
        return `步骤“${step.name}”的响应头断言需要填写头名称。`;
    if (!running || !step.enabled) continue;
    if (step.type === 'http' && !step.request.url?.trim())
      return `请填写步骤“${step.name}”的请求地址。`;
    if (step.type === 'sql' && (!step.sql?.connection_id || !step.sql?.sql.trim()))
      return `请完善步骤“${step.name}”的数据库连接和 SQL。`;
    if (step.type === 'service' && !step.service?.service_id)
      return `请为步骤“${step.name}”选择服务。`;
  }
  if (running && !flow.steps.some((step) => step.enabled)) return '请至少添加并启用一个步骤。';
  return validateOutputReferences(flow.steps);
}
export function requestURL(request: FlowStep['request']) {
  try {
    const url = new URL(request.url || '');
    for (const pair of request.query_params || [])
      if (pair.enabled && pair.name) url.searchParams.append(pair.name, pair.value);
    return url.toString();
  } catch {
    return request.url || '';
  }
}
