import { json } from '@/lib/api';

export type TestCase = Record<string, any>;
export function parseObject(text: string, label: string, stringsOnly = false): Record<string, any> {
  const value = JSON.parse(text || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw new Error(`${label}需要是 JSON 对象`);
  if (stringsOnly && Object.values(value).some((item) => typeof item !== 'string'))
    throw new Error(`${label}需要是值为字符串的 JSON 对象`);
  return value;
}
export function parseArray(text: string, label: string, stringsOnly = false): any[] {
  const value = JSON.parse(text || '[]');
  if (!Array.isArray(value) || (stringsOnly && value.some((item) => typeof item !== 'string')))
    throw new Error(`${label}需要是${stringsOnly ? '字符串 ' : ''}JSON 数组`);
  return value;
}
export const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export interface CommandDraft {
  name: string;
  description: string;
  environment: string;
  program: string;
  cwd: string;
  args: string;
  timeout: string;
  expected: string;
  env: string;
  stdin: string;
  assertions: string;
  variables: string;
}
export function commandDraft(item?: TestCase): CommandDraft {
  const request = item?.command_request || {};
  return {
    name: item?.name || '命令行测试',
    description: item?.description || '',
    environment: request.environment_id || 'local',
    program: request.program || '',
    cwd: request.work_dir || '',
    args: pretty(request.args || []),
    timeout: String(request.timeout_seconds || 30),
    expected:
      item?.expected_exit_code === undefined ? (item ? '' : '0') : String(item.expected_exit_code),
    env: pretty(request.env || {}),
    stdin: request.stdin || '',
    assertions: pretty(item?.assertions || []),
    variables: '{}',
  };
}
export function readCommand(draft: CommandDraft, item?: TestCase) {
  if (!draft.name.trim() || !draft.program.trim()) throw new Error('请填写测试名称和执行程序');
  const timeout = Number(draft.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300)
    throw new Error('超时必须为 1 至 300 秒的整数');
  const expected = Number(draft.expected);
  if (
    draft.expected !== '' &&
    (!Number.isInteger(expected) || expected < 0 || expected > 2147483647)
  )
    throw new Error('预期退出码必须为非负整数');
  return {
    value: {
      ...(item?.id
        ? { id: item.id, edit_version: item.edit_version, project_id: item.project_id }
        : {}),
      type: 'command',
      name: draft.name.trim(),
      description: draft.description,
      command_request: {
        environment_id: draft.environment,
        program: draft.program,
        work_dir: draft.cwd,
        args: parseArray(draft.args, '启动参数', true),
        timeout_seconds: timeout,
        env: parseObject(draft.env, '环境变量', true),
        stdin: draft.stdin,
      },
      ...(draft.expected !== '' ? { expected_exit_code: expected } : {}),
      assertions: parseArray(draft.assertions, '输出断言'),
    },
    variables: parseObject(draft.variables, '运行变量', true),
  };
}
export async function executeTest(
  value: TestCase,
  variables: Record<string, string> = {},
  batchID?: string,
) {
  const batch = batchID ? { id: batchID } : await json('/test-batches', { name: value.name });
  let result: any;
  let finishWarning: string | undefined;
  try {
    result = await json(`/test-batches/${encodeURIComponent(batch.id)}/runs`, {
      test_case: value,
      variables,
    });
  } finally {
    if (!batchID) {
      try {
        await json(`/test-batches/${encodeURIComponent(batch.id)}/finish`, undefined);
      } catch (error) {
        finishWarning = `批次尚未结束：${error instanceof Error ? error.message : String(error)}。可在执行记录中查看。`;
      }
    }
  }
  return { result, batchID: batch.id as string, finishWarning };
}
