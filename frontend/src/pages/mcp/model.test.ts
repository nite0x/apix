import { expect, it } from 'vitest';
import { mcpDraft, parameterValue, readMCP, schemaDefaults } from './model';

it('preserves MCP edit versions and distinguishes explicit false from no expectation', () => {
  const item = {
    id: 'case',
    edit_version: 3,
    name: 'Order',
    expected_is_error: false,
    validate_output_schema: true,
    mcp_request: { server_id: 'server', tool_name: 'get_order', arguments: { id: '42' } },
    assertions: [
      { source: 'structuredContent', path: 'status', operator: 'equals', expected: 'paid' },
    ],
  };
  const draft = mcpDraft(item);
  expect(readMCP(draft, item).value).toMatchObject({
    id: 'case',
    edit_version: 3,
    expected_is_error: false,
    validate_output_schema: true,
    mcp_request: item.mcp_request,
    assertions: item.assertions,
  });
  expect(readMCP({ ...draft, expected: '' }, item).value).not.toHaveProperty('expected_is_error');
  expect(() => readMCP({ ...draft, variables: '{"secret":123}' }, item)).toThrow('值为字符串');
});
it('retains schema false and zero defaults and parses field values by type', () => {
  expect(
    schemaDefaults({
      properties: { enabled: { default: false }, count: { default: 0 }, name: {} },
    }),
  ).toEqual({ enabled: false, count: 0 });
  expect(parameterValue({ type: 'boolean' }, 'false')).toBe(false);
  expect(parameterValue({ type: 'number' }, '0')).toBe(0);
  expect(parameterValue({ type: 'string' }, '0042')).toBe('0042');
  expect(parameterValue({ type: 'object' }, '{"nested":true}')).toEqual({ nested: true });
});
