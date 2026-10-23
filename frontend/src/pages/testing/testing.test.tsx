import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { HTTPCaseEditor, RunCasesDialog } from './case-editor';
vi.mock('@/components/lifecycle', () => ({ BulkManager: () => null, ResourceActions: () => null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function mount(element: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter([{ path: '*', element }], { initialEntries: ['/tests'] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
it('retains case input after conflicts and protects disabled header pairs', async () => {
  let body: any;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string, options: RequestInit = {}) => {
      body = JSON.parse(String(options.body));
      return response({ error: 'version conflict' }, 409);
    }),
  );
  const saved = vi.fn();
  mount(
    <HTTPCaseEditor
      open
      onOpenChange={() => {}}
      item={{
        id: 'case',
        edit_version: 4,
        name: 'Saved case',
        request: {
          method: 'POST',
          url: 'http://localhost/check',
          body_type: 'json',
          body: '{}',
          auth_config: { type: 'bearer', token: 'kept' },
          headers: [
            { name: 'X-Test', value: 'kept', enabled: true },
            { name: 'X-Disabled', value: 'original', enabled: false },
          ],
        },
        assertions: [],
      }}
      onSaved={saved}
    />,
  );
  fireEvent.change(await screen.findByLabelText('请求地址'), {
    target: { value: 'http://localhost/edited' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('草稿已保留'));
  expect(screen.getByLabelText('请求地址')).toHaveValue('http://localhost/edited');
  expect(body.request.auth_config).toEqual({ type: 'bearer', token: 'kept' });
  expect(body.edit_version).toBe(4);
  expect(body.request.headers).toContainEqual({
    name: 'X-Disabled',
    value: 'original',
    enabled: false,
  });
  expect(saved).not.toHaveBeenCalled();
});
it('runs selected cases once into one batch and finishes it after partial failures', async () => {
  const writes: string[] = [];
  const finished = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options: RequestInit = {}) => {
      if (!options.method) return response([]);
      writes.push(input);
      if (input === '/api/test-batches') return response({ id: 'batch' });
      if (input.endsWith('/runs') && JSON.parse(String(options.body)).case_id === 'bad')
        return response({ error: 'needs review' }, 409);
      return response({ id: 'run' });
    }),
  );
  mount(
    <RunCasesDialog ids={['good', 'bad']} open onOpenChange={() => {}} onFinished={finished} />,
  );
  fireEvent.click(screen.getByRole('button', { name: '开始测试' }));
  fireEvent.click(screen.getByRole('button', { name: '正在执行…' }));
  await waitFor(() => expect(screen.getByText('bad：needs review')).toBeInTheDocument());
  expect(writes.filter((path) => path === '/api/test-batches')).toHaveLength(1);
  expect(writes.filter((path) => path.endsWith('/runs'))).toHaveLength(2);
  expect(writes.at(-1)).toBe('/api/test-batches/batch/finish');
  expect(finished).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: '查看已保存结果' })).toHaveAttribute(
    'href',
    '/execution-records?batch=batch',
  );
});
