import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { RequestDetail, RequestRunContent } from './detail';
import type { RequestRun } from './model';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/', element }]);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe('persisted HTTP detail', () => {
  it('renders HTML and header names strictly as text and preserves response truncation evidence', async () => {
    const run: RequestRun = {
      id: 'run-1',
      status: 'succeeded',
      response_status: 200,
      request_snapshot: {
        method: 'POST',
        url: 'https://example.test?existing=one',
        query_params: [{ name: 'extra', value: 'two', enabled: true }],
        body_type: 'json',
        body: '{"valid":true}',
        headers: [{ name: 'X-Disabled', value: 'retained', enabled: false }],
      },
      response_body: '<img src=x onerror="window.injection=true">',
      response_headers: { '<script>': ['<unsafe>'] },
      response_truncated: true,
      response_size: 262144,
      flow_id: 'flow-1',
      flow_run_id: 'flow-run-1',
      step_id: 'step-1',
    };
    const user = mount(<RequestRunContent run={run} />);
    expect(screen.getByText(run.response_body as string)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/响应正文超过 256 KB/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看整组执行' })).toHaveAttribute(
      'href',
      '/execution-records?type=flow&id=flow-1&run=flow-run-1&step=step-1',
    );
    expect(screen.getByText('https://example.test/?existing=one&extra=two')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '请求' }));
    expect(screen.getByText('retained [未启用]')).toBeInTheDocument();
  });

  it('exposes a retryable missing-record error without showing stale content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: '这条执行记录已不存在' }), { status: 404 }),
      ),
    );
    const user = mount(<RequestDetail id="missing" open onOpenChange={() => {}} />);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('这条执行记录已不存在'),
    );
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '刷新详情' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
