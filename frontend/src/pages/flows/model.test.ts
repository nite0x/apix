import { describe, expect, it } from 'vitest';
import {
  availableOutputs,
  blankStep,
  copyFlowSteps,
  failurePolicy,
  isFinally,
  orderedSteps,
  outputReference,
  requestURL,
  sourceChoices,
  uniqueName,
  validateDefinition,
  type Flow,
} from './model';
const flow = (patch: Partial<Flow> = {}): Flow => ({
  id: 'flow',
  name: '测试流程',
  description: '',
  steps: [],
  variables: [],
  settings: { stop_on_error: true, request_timeout_ms: 60000 },
  edit_version: 1,
  ...patch,
});
describe('flow contracts', () => {
  it('validates variable naming, sensitive defaults, header extraction and run prerequisites', () => {
    const value = flow();
    expect(validateDefinition(value)).toBe('');
    expect(validateDefinition(value, true)).toContain('至少');
    value.steps.push(blankStep());
    expect(validateDefinition(value, true)).toContain('请求地址');
    value.steps[0].request.url = '{{base_url}}/users';
    expect(validateDefinition(value, true)).toBe('');
    value.variables = [{ name: 'bad name', secret: false, required: false }];
    expect(validateDefinition(value)).toContain('名称');
    value.variables = [{ name: 'token', secret: true, required: true, default_value: 'secret' }];
    expect(validateDefinition(value)).toContain('敏感');
    value.variables = [
      { name: 'token', secret: false, required: false },
      { name: 'token', secret: false, required: false },
    ];
    expect(validateDefinition(value)).toContain('重复');
    value.variables = [];
    value.steps[0].config.extractors = [{ name: 'token', source: 'header', path: '' }];
    expect(validateDefinition(value)).toContain('响应头提取');
    expect(uniqueName([{ name: 'var_1' }, { name: 'var_3' }], 'var')).toBe('var_2');
  });
  it('preserves step output references across names and whole-flow copies, rejects missing producers', () => {
    const producer = blankStep();
    producer.id = 'producer';
    producer.request.url = 'http://localhost/create';
    producer.config.extractors = [{ name: 'id', source: 'body', path: 'id' }];
    const consumer = blankStep('sql');
    consumer.sql!.connection_id = 'db';
    consumer.sql!.sql = 'SELECT * FROM users WHERE id=?';
    consumer.sql!.params = [outputReference(producer.id, 'id')];
    const cleanup = blankStep();
    cleanup.config.phase = 'finally';
    cleanup.request.url = 'http://localhost/' + outputReference(producer.id, 'id');
    const value = flow({ steps: [producer, consumer, cleanup] });
    expect(validateDefinition(value, true)).toBe('');
    expect(availableOutputs(value.steps, consumer)).toEqual([
      [outputReference('producer', 'id'), producer.name + ' → id'],
    ]);
    producer.name = '重命名';
    expect(validateDefinition(value, true)).toBe('');
    const copies = copyFlowSteps(value.steps);
    expect(copies[0].id).not.toBe(producer.id);
    expect(copies[1].sql!.params[0]).toBe(outputReference(copies[0].id, 'id'));
    expect(copies[2].request.url).toContain(outputReference(copies[0].id, 'id'));
    expect(validateDefinition(flow({ steps: copies }), true)).toBe('');
    producer.enabled = false;
    expect(validateDefinition(value)).toContain('禁用');
    producer.enabled = true;
    expect(validateDefinition(flow({ steps: [consumer, producer, cleanup] }))).toContain('后面');
    expect(validateDefinition(flow({ steps: [consumer, cleanup] }))).toContain('删除');
    producer.config.extractors = [];
    expect(validateDefinition(value)).toContain('不存在');
  });
  it('keeps finally order and legacy failure defaults while respecting SQL source modes', () => {
    const main = blankStep();
    const cleanup = blankStep('sql');
    cleanup.config.phase = 'finally';
    expect(orderedSteps([cleanup, main])).toEqual([main, cleanup]);
    expect(isFinally(main)).toBe(false);
    expect(failurePolicy(main)).toBe('inherit');
    main.config.continue_on_error = true;
    expect(failurePolicy(main)).toBe('continue');
    main.config.failure_policy = 'stop';
    expect(failurePolicy(main)).toBe('stop');
    expect(sourceChoices(cleanup)).toEqual([
      ['rows', '查询字段'],
      ['row_count', '查询行数'],
    ]);
    cleanup.sql!.mode = 'exec';
    expect(sourceChoices(cleanup)).toEqual([['rows_affected', '影响行数']]);
  });
  it('displays only enabled query pairs and forbids interpolation directly into SQL', () => {
    expect(
      requestURL({
        url: 'https://example.com/check?keep=1',
        query_params: [
          { name: 'tag', value: 'one', enabled: true },
          { name: 'tag', value: 'two', enabled: true },
          { name: 'off', value: 'no', enabled: false },
        ],
      }),
    ).toBe('https://example.com/check?keep=1&tag=one&tag=two');
    const step = blankStep('sql');
    step.sql!.sql = 'SELECT {{steps.id.outputs.value}}';
    expect(validateDefinition(flow({ steps: [step] }))).toContain('绑定参数');
  });
});
