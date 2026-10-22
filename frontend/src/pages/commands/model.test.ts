import { describe, it, expect, vi, afterEach } from 'vitest';
import { commandDraft, executeTest, parseArray, parseObject, readCommand } from './model';

afterEach(() => vi.unstubAllGlobals());
describe('command definitions', () => {
  it('validates independent string arguments and variable objects before writing', () => {
    const draft = { ...commandDraft(), program: 'python3', args: '[123]' };
    expect(() => readCommand(draft)).toThrow('字符串 JSON 数组');
    expect(() => parseObject('{"secret":123}', '运行变量', true)).toThrow('值为字符串');
    expect(() => parseArray('{}', '输出断言')).toThrow('JSON 数组');
    expect(() => readCommand({ ...draft, args: '["-"]', timeout: '301' })).toThrow('1 至 300');
  });
  it('retains edit concurrency version and explicit zero expected exit code', () => {
    const item = { id: 'case', edit_version: 7, project_id: 'project', name: 'inline Python', command_request: { program: 'python3', args: ['-'], stdin: 'print("done")', environment_id: 'wsl:Ubuntu:alice' }, expected_exit_code: 0 };
    const draft = commandDraft(item);
    const out = readCommand(draft, item);
    expect(out.value).toMatchObject({ id: 'case', edit_version: 7, project_id: 'project', expected_exit_code: 0, command_request: { args: ['-'], stdin: 'print("done")', environment_id: 'wsl:Ubuntu:alice' } });
    expect(readCommand({ ...draft, expected: '' }, item).value).not.toHaveProperty('expected_exit_code');
  });
});
describe('test execution lifecycle', () => {
  it('finishes an owned batch even when execution fails', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      if (url === '/api/test-batches') return new Response(JSON.stringify({ id: 'batch-1' }));
      if (url.endsWith('/runs')) return new Response(JSON.stringify({ error: 'execution failed' }), { status: 500 });
      return new Response(null, { status: 204 });
    }));
    await expect(executeTest({ name: 'test' })).rejects.toThrow('execution failed');
    expect(requests).toEqual(['/api/test-batches', '/api/test-batches/batch-1/runs', '/api/test-batches/batch-1/finish']);
  });
  it('does not finish a caller-owned batch', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ test_status: 'passed' })));
    vi.stubGlobal('fetch', fetcher);
    const out = await executeTest({ name: 'test' }, {}, 'existing');
    expect(out.batchID).toBe('existing');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.length).toBe(2);
  });
  it('reports finish failure without dropping persisted execution output', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/test-batches') return new Response(JSON.stringify({ id: 'batch' }));
      if (url.endsWith('/runs')) return new Response(JSON.stringify({ test_status: 'passed', test_run_id: 'run' }));
      return new Response(JSON.stringify({ error: 'busy' }), { status: 409 });
    }));
    const out = await executeTest({ name: 'test' });
    expect(out.result.test_run_id).toBe('run');
    expect(out.finishWarning).toContain('busy');
  });
});
