import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import MCPPage from './index';

afterEach(() => vi.unstubAllGlobals());
it('discovers tools, synchronizes JSON parameters, prevents duplicate calls and retains masked server headers', async () => {
  const server = {
    id: 'server',
    name: 'Orders',
    url: 'http://localhost/mcp',
    timeout_seconds: 30,
    edit_version: 4,
    headers: { Authorization: '••••••' },
  };
  const writes: { url: string; value: any; method: string }[] = [];
  let release: (() => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit = {}) => {
      const value = options.body ? JSON.parse(String(options.body)) : undefined;
      if (options.method) writes.push({ url, value, method: options.method });
      let result: any = [];
      if (url === '/api/mcp-servers') result = [server];
      if (url.endsWith('/discover'))
        result = {
          server_name: 'fixture',
          duration_ms: 5,
          tools: [
            {
              name: 'get_order',
              description: '<img src=x onerror=attack()>',
              inputSchema: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
              },
            },
          ],
        };
      if (url === '/api/test-batches') result = { id: 'batch' };
      if (url.endsWith('/runs')) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        result = {
          test_status: 'unverified',
          test_run_id: 'run',
          mcp_result: { response: { content: '<script>attack()</script>' } },
        };
      }
      if (options.method === 'PUT') {
        Object.assign(server, value);
        result = server;
      }
      return new Response(JSON.stringify(result));
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MCPPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '测试连接并获取工具' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: '测试连接并获取工具' }));
  expect(await screen.findByText('连接成功，发现 1 个工具。')).toBeInTheDocument();
  expect(container.querySelector('img')).toBeNull();
  fireEvent.change(screen.getByLabelText('id *'), { target: { value: '10001' } });
  expect(
    JSON.parse((screen.getByLabelText('调用参数（JSON 对象）') as HTMLTextAreaElement).value),
  ).toEqual({ id: '10001' });
  fireEvent.click(screen.getByRole('button', { name: '执行工具' }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: '正在调用…' }));
  expect(writes.filter((item) => item.url.endsWith('/runs'))).toHaveLength(1);
  release?.();
  expect(await screen.findByText('未验证')).toBeInTheDocument();
  expect(container.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '编辑连接' }));
  const dialog = await screen.findByRole('dialog', { name: '编辑 MCP 服务器' });
  fireEvent.change(within(dialog).getByLabelText('服务器名称'), {
    target: { value: 'Orders updated' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存连接' }));
  await waitFor(() =>
    expect(writes.find((item) => item.method === 'PUT')?.value.headers.Authorization).toBe(
      '••••••',
    ),
  );
  expect(writes.find((item) => item.method === 'PUT')?.value.edit_version).toBe(4);
  client.clear();
});
