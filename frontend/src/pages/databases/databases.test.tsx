import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import DatabasesPage from './index';
import { SQLResultTable } from './results';

const connection = {
  id: 'db-1',
  name: '测试库',
  type: 'postgresql',
  database: 'test',
  host: 'localhost',
  port: 5432,
  username: 'test',
  edit_version: 2,
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function page() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const router = createMemoryRouter([{ path: '*', element: <DatabasesPage /> }], {
    initialEntries: ['/databases'],
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return client;
}

describe('database workbench', () => {
  it('submits typed SQL once, keeps its draft across tabs and preserves a failed statement', async () => {
    const user = userEvent.setup();
    const writes: Record<string, unknown>[] = [];
    let release: (() => void) | undefined;
    let fail = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, options: RequestInit = {}) => {
        if (path === '/api/database/connections') return response([connection]);
        if (path === '/api/database/executions') return response([]);
        if (path === '/api/database/execute') {
          writes.push(JSON.parse(String(options.body)));
          if (!fail)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return fail
            ? response({ error: 'syntax error near bad' }, 400)
            : response({
                execution_id: 7,
                columns: ['value', 'nullable', 'zero', 'flag'],
                rows: [
                  { value: '<img src=x onerror=alert(1)>', nullable: null, zero: 0, flag: false },
                ],
                row_count: 1,
                duration_ms: 3,
              });
        }
        throw new Error(`Unexpected API ${path}`);
      }),
    );
    page();
    await user.click(await screen.findByRole('combobox', { name: '数据库连接' }));
    await user.click(await screen.findByRole('option', { name: '测试库 · PostgreSQL' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'SQL 语句' }), {
      target: { value: 'SELECT $1 AS value' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '绑定参数（JSON 数组）' }), {
      target: { value: '{}' },
    });
    await user.click(screen.getByRole('button', { name: '执行 SQL' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('JSON 数组');
    expect(writes).toHaveLength(0);
    fireEvent.change(screen.getByRole('textbox', { name: '绑定参数（JSON 数组）' }), {
      target: { value: '["测试",123,null,false]' },
    });
    const submit = screen.getByRole('button', { name: '执行 SQL' }).closest('form')!;
    fireEvent.submit(submit);
    fireEvent.submit(submit);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ params: ['测试', 123, null, false], timeout_ms: 30000 });
    await user.click(screen.getByRole('tab', { name: '连接管理' }));
    expect(await screen.findByRole('button', { name: '使用 测试库 执行 SQL' })).toBeDisabled();
    await act(async () => release?.());
    expect(screen.getByRole('tab', { name: '连接管理' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'SQL 执行' }));
    expect(screen.getByRole('textbox', { name: 'SQL 语句' })).toHaveValue('SELECT $1 AS value');
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('NULL')).toBeInTheDocument();
    expect(screen.getByText('false')).toBeInTheDocument();
    fail = true;
    fireEvent.change(screen.getByRole('textbox', { name: 'SQL 语句' }), {
      target: { value: 'bad SQL' },
    });
    await user.click(screen.getByRole('button', { name: '执行 SQL' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('syntax error near bad');
    expect(screen.getByRole('textbox', { name: 'SQL 语句' })).toHaveValue('bad SQL');
    expect(screen.getByRole('button', { name: '执行 SQL' })).toBeEnabled();
  });

  it('keeps stored passwords omitted while editing driver settings with optimistic versions', async () => {
    const user = userEvent.setup();
    const writes: Record<string, unknown>[] = [];
    const original = { ...connection, type: 'mysql', port: 80 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, options: RequestInit = {}) => {
        if (path === '/api/database/connections' && options.method === 'PUT') {
          const input = JSON.parse(String(options.body));
          writes.push(input);
          return response({ ...original, ...input });
        }
        if (path === '/api/database/connections') return response([original]);
        if (path === '/api/database/executions') return response([]);
        throw new Error(`Unexpected API ${path}`);
      }),
    );
    page();
    await user.click(screen.getByRole('tab', { name: '连接管理' }));
    await user.click(await screen.findByRole('button', { name: '编辑 测试库 的连接配置' }));
    expect(screen.getByRole('spinbutton', { name: '端口' })).toHaveValue(80);
    await user.click(screen.getByRole('combobox', { name: '数据库类型' }));
    await user.click(screen.getByRole('option', { name: 'Hologres' }));
    expect(screen.getByRole('spinbutton', { name: '端口' })).toHaveValue(80);
    await user.click(screen.getByRole('button', { name: '保存连接' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      id: 'db-1',
      type: 'hologres',
      ssl_mode: 'prefer',
      edit_version: 2,
      port: 80,
    });
    expect(writes[0]).not.toHaveProperty('password');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '编辑数据库连接' })).not.toBeInTheDocument(),
    );
  });

  it('opens full SQL cell values safely and paginates large result sets', async () => {
    const user = userEvent.setup();
    const value = '<script>evidence</script>' + '字段'.repeat(100);
    render(
      <SQLResultTable
        result={{
          columns: ['evidence'],
          rows: Array.from({ length: 101 }, (_, i) => ({ evidence: i === 0 ? value : i })),
          row_count: -1,
          rows_affected: 0,
          duration_ms: 2,
          truncated: true,
        }}
      />,
    );
    expect(screen.getAllByRole('row')).toHaveLength(101); // header + first 100 rows
    expect(screen.getByText(/总行数未知/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看第 1 行 evidence 字段的完整内容' }));
    expect(screen.getByRole('dialog', { name: '字段完整内容' })).toHaveTextContent(value);
    expect(document.querySelector('script')).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: '查看第 101 行 evidence 字段的完整内容' }),
    ).toHaveTextContent('100');
  });

  it('loads history rows on demand, retries result reads and retains its inspector while history refreshes', async () => {
    const user = userEvent.setup();
    let failResult = true,
      resultReads = 0;
    let history = [
      {
        id: 12,
        connection_id: 'db-1',
        connection_name: '历史库',
        sql: 'SELECT original',
        mode: 'query',
        status: 'succeeded',
        started_at: '2026-10-22T00:00:00Z',
        duration_ms: 2,
        row_count: 1,
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path === '/api/database/connections') return response([]);
        if (path === '/api/database/executions') return response(history);
        if (path === '/api/database/executions/12/result') {
          resultReads++;
          return failResult
            ? response({ error: 'temporarily unavailable' }, 503)
            : response({
                result: {
                  columns: ['value'],
                  rows: [{ value: '<script>retained</script>' }],
                  row_count: 1,
                  duration_ms: 2,
                },
              });
        }
        throw new Error(`Unexpected API ${path}`);
      }),
    );
    const client = page();
    await user.click(screen.getByRole('tab', { name: '执行记录' }));
    await screen.findByRole('button', { name: '查看结果' });
    expect(resultReads).toBe(0);
    await user.click(screen.getByRole('button', { name: '查看结果' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
    failResult = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(
      await screen.findByRole('button', { name: '查看第 1 行 value 字段的完整内容' }),
    ).toHaveTextContent('<script>retained</script>');
    history = [{ ...history[0], sql: 'SELECT changed', duration_ms: 10 }];
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['database-executions'] });
    });
    expect(screen.getByRole('dialog', { name: 'SQL 执行详情' })).toHaveTextContent(
      'SELECT original',
    );
    expect(document.querySelector('script')).toBeNull();
    expect(resultReads).toBe(2);
  });
});
