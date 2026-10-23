import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import FlowsPage from './index';
vi.mock('@/components/lifecycle', () => ({ BulkManager: () => null, ResourceActions: () => null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter([{ path: '/flows', element: <FlowsPage /> }], {
    initialEntries: ['/flows?id=flow'],
  });
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
it('retains live drafts after successful saves and version conflicts', async () => {
  let value = {
    id: 'flow',
    name: '原流程',
    description: '',
    steps: [],
    variables: [],
    settings: { stop_on_error: true, request_timeout_ms: 60000 },
    edit_version: 1,
  };
  let conflict = false;
  const writes: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options: RequestInit = {}) => {
      if (input === '/api/flows/flow' && options.method === 'PUT') {
        const body = JSON.parse(String(options.body));
        writes.push(body);
        if (conflict) return response({ error: 'conflict' }, 409);
        value = { ...body, edit_version: body.edit_version + 1 };
        return response(value);
      }
      if (input === '/api/flows/flow') return response(value);
      return response([]);
    }),
  );
  mount();
  const title = await screen.findByLabelText('流程名称');
  fireEvent.change(title, { target: { value: '第一次保存' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(screen.getByText(/定义版本 v2/)).toBeInTheDocument());
  fireEvent.change(title, { target: { value: '第二次修改' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(writes.at(-1).name).toBe('第二次修改'));
  expect(writes.at(-1).edit_version).toBe(2);
  await waitFor(() => expect(screen.getByText(/定义版本 v3/)).toBeInTheDocument());
  conflict = true;
  fireEvent.change(title, { target: { value: '本地保留草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('另存副本'));
  expect(title).toHaveValue('本地保留草稿');
});
it('preserves invalid SQL parameter text across tabs and permits saving after correction', async () => {
  const { blankStep } = await import('./model');
  const sql = blankStep('sql');
  sql.sql!.connection_id = 'db';
  sql.sql!.sql = 'SELECT ?';
  const value = {
    id: 'flow',
    name: 'SQL flow',
    description: '',
    steps: [sql],
    variables: [],
    settings: { stop_on_error: true, request_timeout_ms: 60000 },
    edit_version: 1,
  };
  let saved: any;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options: RequestInit = {}) => {
      if (input === '/api/flows/flow' && options.method === 'PUT') {
        saved = JSON.parse(String(options.body));
        return response({ ...saved, edit_version: saved.edit_version + 1 });
      }
      if (input === '/api/flows/flow') return response(value);
      return response([]);
    }),
  );
  mount();
  const params = await screen.findByLabelText('SQL 参数');
  fireEvent.change(params, { target: { value: '["unfinished' } });
  await userEvent.click(screen.getByRole('tab', { name: '断言' }));
  await userEvent.click(screen.getByRole('tab', { name: 'SQL 配置' }));
  expect(screen.getByLabelText('SQL 参数')).toHaveValue('["unfinished');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() =>
    expect(
      screen
        .getAllByRole('alert')
        .some((element) => element.textContent?.includes('无效的 SQL JSON 参数')),
    ).toBe(true),
  );
  expect(saved).toBeUndefined();
  fireEvent.change(screen.getByLabelText('SQL 参数'), { target: { value: '[42]' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(saved?.steps[0].sql.params).toEqual([42]));
});
