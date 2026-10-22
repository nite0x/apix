import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import RequestsPage from './index';
import { type RequestData, type WorkingCopy } from './model';

vi.mock('@/components/lifecycle', () => ({
  ArchiveManager: () => null,
  BulkManager: () => null,
  References: () => null,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter([{ path: '/requests', element: <RequestsPage /> }], {
    initialEntries: ['/requests'],
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

function respond(value: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('request workspace', () => {
  it('imports without sending, preserves advanced fields and prevents duplicate saves', async () => {
    const request: RequestData = {
      method: 'POST',
      url: 'http://localhost/api',
      body_type: 'raw',
      body: '<text>',
      query_params: [
        { name: 'tag', value: 'one', enabled: true },
        { name: 'tag', value: 'two', enabled: true },
        { name: 'off', value: 'kept', enabled: false },
      ],
      headers: [{ name: 'X-Keep', value: 'off', enabled: false }],
      auth_config: { type: 'bearer', token: 'preserve-auth' },
    };
    let copy: WorkingCopy = { id: 'copy-1', request, edit_version: 1 };
    let saved = false;
    const writes: { path: string; body: any }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, options: RequestInit = {}) => {
        const path = String(input);
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(String(options.body)) : null;
        if (method !== 'GET') writes.push({ path, body });
        if (path === '/api/collections') return respond([{ id: 'group-1', name: 'My APIs' }]);
        if (path === '/api/requests?collection_id=group-1')
          return respond(
            saved ? [{ id: 'api-1', collection_id: 'group-1', name: 'Imported API', request }] : [],
          );
        if (path === '/api/import/curl') return respond(copy, 201);
        if (path === '/api/working-copies/copy-1' && method === 'PUT') {
          copy = { ...body, edit_version: 2 };
          return respond(copy);
        }
        if (path === '/api/working-copies/copy-1/save') {
          saved = true;
          return respond({ ...copy, api_request_id: 'api-1', edit_version: 3 });
        }
        throw new Error(`Unexpected ${method} ${path}`);
      }),
    );
    const user = mount();
    await user.click(screen.getByRole('tab', { name: '接口管理' }));
    await user.click(screen.getByText('导入 cURL / 原始 HTTP'));
    await user.type(screen.getByLabelText('请求内容'), 'curl http://localhost/api');
    await user.click(screen.getByRole('button', { name: '解析到编辑器' }));
    await waitFor(() =>
      expect(screen.getByLabelText('请求地址')).toHaveValue('http://localhost/api'),
    );
    expect(writes.some((write) => write.path === '/api/runs')).toBe(false);
    await user.type(screen.getByLabelText('接口名称'), 'Imported API');
    // Choose a real collection via the Radix Select popup.
    await user.click(screen.getByRole('combobox', { name: '保存分组' }));
    await user.click(screen.getByRole('option', { name: 'My APIs' }));
    const saveButton = screen.getByRole('button', { name: '保存接口' });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    await waitFor(() => expect(screen.getByText('接口已保存到接口库。')).toBeInTheDocument());
    expect(writes.filter((write) => write.path.endsWith('/save'))).toHaveLength(1);
    const update = writes.find((write) => write.path === '/api/working-copies/copy-1');
    expect(update?.body.request).toEqual(request);
  });

  it('retains edited input on a version conflict and exposes save-as-new recovery', async () => {
    const request: RequestData = {
      method: 'GET',
      url: 'http://localhost/original',
      headers: [],
      query_params: [],
      body_type: 'none',
      body: '',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, options: RequestInit = {}) => {
        const path = String(input);
        if (path === '/api/collections') return respond([{ id: 'group-1', name: 'My APIs' }]);
        if (path === '/api/requests?collection_id=group-1')
          return respond([
            { id: 'api-1', collection_id: 'group-1', name: 'Existing API', request },
          ]);
        if (path === '/api/requests/api-1')
          return respond({ id: 'api-1', collection_id: 'group-1', name: 'Existing API', request });
        if (path === '/api/working-copies')
          return respond({
            id: 'copy-1',
            api_request_id: 'api-1',
            name: 'Existing API',
            edit_version: 1,
            request,
          });
        if (path === '/api/working-copies/copy-1' && options.method === 'PUT')
          return respond({ error: 'changed elsewhere' }, 409);
        if (path === '/api/working-copies/copy-1/discard') return respond(null, 204);
        throw new Error(`Unexpected ${options.method || 'GET'} ${path}`);
      }),
    );
    const user = mount();
    await user.click(screen.getByRole('tab', { name: '接口管理' }));
    await user.click(await screen.findByRole('button', { name: '编辑接口 Existing API' }));
    const url = await screen.findByLabelText('请求地址');
    await user.clear(url);
    await user.type(url, 'http://localhost/edited');
    await user.click(screen.getByRole('button', { name: '保存接口' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('本地编辑已保留'));
    expect(url).toHaveValue('http://localhost/edited');
    expect(screen.getByRole('button', { name: '重新载入接口' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '另存为新接口' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '保存分组' })).not.toBeDisabled(),
    );
    expect(url).toHaveValue('http://localhost/edited');
  });

  it('shows a persisted transport failure instead of losing the run', async () => {
    const request: RequestData = {
      method: 'GET',
      url: 'http://localhost/unreachable',
      query_params: [],
      headers: [],
      body_type: 'none',
      body: '',
    };
    let runs = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path === '/api/collections') return respond([]);
        if (path === '/api/working-copies')
          return respond({ id: 'copy-1', edit_version: 1, request });
        if (path === '/api/runs') {
          runs++;
          return respond(
            {
              id: 'run-failed',
              status: 'failed',
              request_snapshot: request,
              error_code: 'CONNECTION_FAILED',
              error_message: 'connection refused',
            },
            502,
          );
        }
        throw new Error(`Unexpected ${path}`);
      }),
    );
    const user = mount();
    await user.type(screen.getByLabelText('请求地址'), request.url);
    const send = screen.getByRole('button', { name: '发送请求' });
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() =>
      expect(screen.getByText('请求执行失败，详情和记录已保留。')).toBeInTheDocument(),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('connection refused');
    expect(runs).toBe(1);
    expect(screen.getByLabelText('请求地址')).toHaveValue(request.url);
  });
});
