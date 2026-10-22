import { describe, expect, it } from 'vitest';
import { blankSQL, cellText, executionURL, sqlPayload, type DatabaseConnection, type SQLExecution } from './model';

const connection: DatabaseConnection = { id: 'db', name: '测试库', type: 'postgresql' };

describe('SQL command validation', () => {
  it('preserves bound parameter types and rejects non-array JSON before executing', () => {
    const draft = { ...blankSQL, connection_id: 'db', sql: ' SELECT $1 ', params: '["测试",123,null,false,{"id":1}]' };
    expect(sqlPayload(draft, [connection])).toMatchObject({ sql: 'SELECT $1', timeout_ms: 30000, params: ['测试', 123, null, false, { id: 1 }] });
    expect(() => sqlPayload({ ...draft, params: '{}' }, [connection])).toThrow('JSON 数组');
    expect(() => sqlPayload({ ...draft, params: '[broken]' }, [connection])).toThrow('JSON 数组');
  });

  it('requires an active explicit connection and enforces timeout and row limits', () => {
    const draft = { ...blankSQL, connection_id: 'archived', sql: 'SELECT 1' };
    expect(() => sqlPayload(draft, [connection])).toThrow('有效连接');
    expect(() => sqlPayload({ ...draft, connection_id: 'db', timeout: '301' }, [connection])).toThrow('1–300');
    expect(() => sqlPayload({ ...draft, connection_id: 'db', maxRows: '10001' }, [connection])).toThrow('1–10000');
  });
});

it('keeps false, zero, NULL, structured and HTML-looking SQL values intact as text', () => {
  expect([null, false, 0, '', '<script>value</script>', { source: 'x' }].map(cellText)).toEqual(['NULL', 'false', '0', '', '<script>value</script>', '{"source":"x"}']);
});

it('links SQL to its persisted flow step instead of guessing from SQL text', () => {
  const execution = { flow_id: 'flow a', flow_run_id: 'run-b', step_id: 'step-c' } as SQLExecution;
  const url = new URL(executionURL(execution)!, 'http://localhost');
  expect(url.pathname).toBe('/execution-records');
  expect(Object.fromEntries(url.searchParams)).toEqual({ type: 'flow', id: 'flow a', run: 'run-b', step: 'step-c' });
  expect(executionURL({} as SQLExecution)).toBeNull();
});
