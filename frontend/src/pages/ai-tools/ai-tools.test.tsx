import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, expect, test } from 'vitest';
import AIToolsPage from './index';
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AIToolsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
const targets = [
  { id: 'local', name: 'Linux', home: '/home/test' },
  { id: 'windows', name: 'Windows', home: 'C:/Users/Test' },
];

test('installation uses the selected system, prevents duplicate writes and reports backup after verification', async () => {
  const writes: Array<{ path: string; body: unknown }> = [];
  let installed = false;
  let release!: (value: Response) => void;
  const connection = {
    status: 'connected',
    tools_count: 39,
    environment: 'Windows',
    checked_at: '2026-10-22T01:00:00Z',
    duration_ms: 12,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit = {}) => {
      if (options.method === 'POST') {
        writes.push({ path, body: JSON.parse(String(options.body)) });
        const result = await new Promise<Response>((resolve) => {
          release = resolve;
        });
        installed = true;
        return result;
      }
      const target = new URL(path, 'http://localhost').searchParams.get('target');
      return response({
        target,
        targets,
        transport: 'stdio',
        clients: [
          {
            id: 'codex',
            name: 'Codex',
            status: installed ? 'configured' : 'available',
            path: `/${target}/config.toml`,
            snippet: '[mcp_servers.apix]',
            connection: installed ? connection : undefined,
          },
        ],
      });
    }),
  );
  const user = setup();
  await screen.findByText('/local/config.toml');
  expect(screen.getByText('stdio')).toBeInTheDocument();
  expect(screen.queryByText(/127\.0\.0\.1/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('combobox', { name: '目标系统' }));
  await user.click(screen.getByRole('option', { name: /Windows/ }));
  await screen.findByText('/windows/config.toml');
  const install = screen.getByRole('button', { name: 'Codex：一键安装' });
  await user.dblClick(install);
  expect(writes).toEqual([{ path: '/api/ai-tools/codex/install', body: { target: 'windows' } }]);
  expect(screen.getByRole('combobox', { name: '目标系统' })).toBeDisabled();
  release(response({ status: 'installed', backup: '/test/backup.json', connection }));
  await screen.findByText(/安装完成.*39 个可用工具.*backup.json/);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Codex：已配置' })).toBeDisabled());
  expect(screen.getByRole('status', { name: 'Codex 连接状态' })).toHaveTextContent('39 个可用工具');
});

test('late connection checks cannot overwrite another target and zero tools remain visible', async () => {
  const pending = new Map<string, (value: Response) => void>();
  const calls: Array<{ path: string; target: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit = {}) => {
      if (options.method === 'POST') {
        const { target } = JSON.parse(String(options.body));
        calls.push({ path, target });
        return await new Promise<Response>((resolve) => pending.set(target, resolve));
      }
      const target = new URL(path, 'http://localhost').searchParams.get('target');
      return response({
        target,
        targets,
        transport: 'stdio',
        clients: [
          {
            id: 'codex',
            name: 'Codex',
            status: 'configured',
            snippet: '{}',
            path: `/${target}/config.toml`,
          },
        ],
      });
    }),
  );
  const user = setup();
  await screen.findByText('/local/config.toml');
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(screen.getByRole('button', { name: 'Codex：测试连接' })).toBeDisabled();
  await user.click(screen.getByRole('combobox', { name: '目标系统' }));
  await user.click(screen.getByRole('option', { name: /Windows/ }));
  await waitFor(() => expect(calls).toHaveLength(2));
  pending.get('windows')!(
    response({ status: 'connected', tools_count: 0, environment: 'Windows' }),
  );
  await screen.findByText('0 个可用工具');
  pending.get('local')!(response({ status: 'connected', tools_count: 39, environment: 'Linux' }));
  await waitFor(() =>
    expect(screen.getByRole('status', { name: 'Codex 连接状态' })).toHaveTextContent(
      '0 个可用工具',
    ),
  );
  expect(screen.queryByText('39 个可用工具')).not.toBeInTheDocument();
});

test('a failed automatic handshake leaves configuration installed and allows a manual retry', async () => {
  let installed = false;
  let connection: unknown;
  const writes: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit = {}) => {
      if (options.method === 'POST') {
        writes.push(path);
        if (path.endsWith('/install')) {
          installed = true;
          connection = { status: 'failed', error: 'MCP 握手失败' };
          return response({ status: 'installed', backup: '/original.backup', connection });
        }
        connection = { status: 'connected', tools_count: 2 };
        return response(connection);
      }
      return response({
        target: 'local',
        targets,
        transport: 'stdio',
        clients: [
          {
            id: 'codex',
            name: 'Codex',
            status: installed ? 'configured' : 'available',
            snippet: '{}',
            connection,
          },
        ],
      });
    }),
  );
  const user = setup();
  await user.click(await screen.findByRole('button', { name: 'Codex：一键安装' }));
  await screen.findByText(/配置已保存.*MCP 握手失败.*original.backup/);
  expect(screen.getByRole('button', { name: 'Codex：已配置' })).toBeDisabled();
  const retry = screen.getByRole('button', { name: 'Codex：测试连接' });
  await waitFor(() => expect(retry).toBeEnabled());
  await user.click(retry);
  await screen.findByText('2 个可用工具');
  expect(writes).toEqual(['/api/ai-tools/codex/install', '/api/ai-tools/codex/test']);
});
