import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import LogsPage from './index';
const activity = vi.hoisted(() => ({
  data: {
    services: [{ id: 'service', name: 'Test service' }],
    events: [] as any[],
    service_logs: [] as any[],
  },
  error: null,
}));
vi.mock('@/lib/activity', () => ({ useActivity: () => activity }));

it('freezes displayed logs while paused, clears only the screen, and retains source deep links', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const line = (sequence: number, message: string) => ({
    sequence,
    message,
    service_id: 'service',
    stream: 'stdout',
    time: `2026-10-22T15:00:0${sequence}Z`,
  });
  activity.data = { ...activity.data, service_logs: [line(1, 'original output')] };
  const ui = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/logs?source=service']}>
        <LogsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(ui());
  expect(screen.getByRole('log')).toHaveTextContent('original output');
  await userEvent.click(screen.getByRole('button', { name: '暂停显示' }));
  activity.data = {
    ...activity.data,
    service_logs: [line(1, 'original output'), line(2, 'later output')],
  };
  view.rerender(ui());
  expect(screen.getByRole('log')).not.toHaveTextContent('later output');
  await userEvent.click(screen.getByRole('button', { name: '继续显示' }));
  expect(screen.getByRole('log')).toHaveTextContent('later output');
  await userEvent.click(screen.getByRole('button', { name: '清空屏幕显示' }));
  expect(screen.queryByRole('log')).not.toBeInTheDocument();
  activity.data = {
    ...activity.data,
    service_logs: [
      line(1, 'original output'),
      line(2, 'later output'),
      line(3, '<script>new output</script>'),
    ],
  };
  view.rerender(ui());
  expect(screen.getByRole('log')).toHaveTextContent('<script>new output</script>');
  expect(screen.getByRole('log')).not.toHaveTextContent('original output');
  expect(document.querySelector('script')).toBeNull();
  expect(screen.getByRole('combobox', { name: '日志来源' })).toHaveTextContent('Test service');
});
