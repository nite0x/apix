import { parseArray, parseObject, pretty, type TestCase } from '../commands/model';

export interface MCPDraft { name: string; description: string; server: string; tool: string; args: string; expected: string; validateOutput: string; assertions: string; variables: string }
export function mcpDraft(item?: TestCase | null, server = ''): MCPDraft {
  return { name: item?.name || '', description: item?.description || '', server: item?.mcp_request?.server_id || server, tool: item?.mcp_request?.tool_name || '', args: pretty(item?.mcp_request?.arguments || {}), expected: item?.expected_is_error === undefined ? '' : String(item.expected_is_error), validateOutput: String(item?.validate_output_schema || false), assertions: pretty(item?.assertions || []), variables: '{}' };
}
export function readMCP(draft: MCPDraft, item?: TestCase | null) {
  if (!draft.name.trim() || !draft.server || !draft.tool.trim()) throw new Error('请填写用例名称、MCP 服务器和工具名称');
  return { value: { ...(item?.id ? { id: item.id, edit_version: item.edit_version, project_id: item.project_id } : {}), type: 'mcp', name: draft.name.trim(), description: draft.description, mcp_request: { server_id: draft.server, tool_name: draft.tool.trim(), arguments: parseObject(draft.args, '调用参数') }, assertions: parseArray(draft.assertions, 'MCP 断言'), validate_output_schema: draft.validateOutput === 'true', ...(draft.expected ? { expected_is_error: draft.expected === 'true' } : {}) }, variables: parseObject(draft.variables, '运行变量', true) };
}
export function schemaDefaults(schema: Record<string, any> = {}) {
  return Object.fromEntries(Object.entries(schema.properties || {}).filter(([, property]: [string, any]) => property.default !== undefined).map(([key, property]: [string, any]) => [key, property.default]));
}
export function parameterValue(property: Record<string, any>, value: string) {
  if (property.enum || ['boolean', 'number', 'integer', 'object', 'array'].includes(property.type)) return JSON.parse(value);
  return value;
}
