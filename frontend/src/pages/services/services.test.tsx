import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ServicesPage, { ServiceEditor } from './index';

afterEach(() => vi.unstubAllGlobals());
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function renderEditor(id: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ServiceEditor id={id} onClose={onClose} onChanged={onChanged} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client, onClose, onChanged };
}
function fillNew() {
  fireEvent.change(screen.getByLabelText('服务名称'), { target: { value: 'Demo API' } });
  fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/tmp/demo' } });
  fireEvent.change(screen.getByLabelText('启动程序'), { target: { value: 'node' } });
  fireEvent.change(screen.getByLabelText('启动参数'), {
    target: { value: 'server file.js\n\n--port\n18888' },
  });
}
describe('service editor migration', () => {
  it('validates JSON before writing and save-only prevents duplicate writes and pending dismissal', async () => {
    const writes: any[] = [];
    let release: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit = {}) => {
        if (url === '/api/execution-environments')
          return response({ items: [{ id: 'local', name: '本机' }] });
        writes.push({ url, method: options.method, body: JSON.parse(String(options.body)) });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return response({ ...writes.at(-1).body, edit_version: 1 });
      }),
    );
    const { client, onClose } = renderEditor();
    fillNew();
    fireEvent.change(screen.getByLabelText('环境变量'), { target: { value: '{"PORT":18888}' } });
    fireEvent.click(screen.getByRole('button', { name: '仅保存' }));
    expect(await screen.findByText('环境变量需要是值为字符串的 JSON 对象。')).toBeInTheDocument();
    expect(writes).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('环境变量'), { target: { value: '{"PORT":"18888"}' } });
    fireEvent.click(screen.getByRole('button', { name: '仅保存' }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    expect(screen.getByLabelText('服务名称')).toBeDisabled();
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      url: '/api/services',
      method: 'PUT',
      body: {
        name: 'Demo API',
        args: ['server file.js', '--port', '18888'],
        env: { PORT: '18888' },
      },
    });
    release?.();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(writes.some((item) => item.url.endsWith('/start'))).toBe(false);
    client.clear();
  });
  it('retries failed startup without creating or saving the same definition again', async () => {
    const writes: any[] = [];
    let starts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit = {}) => {
        if (url === '/api/execution-environments')
          return response({ items: [{ id: 'local', name: '本机' }] });
        const body = JSON.parse(String(options.body));
        writes.push({ url, method: options.method, body });
        if (url === '/api/services') return response({ ...body, edit_version: 2 });
        if (url.endsWith('/start')) {
          starts++;
          return starts === 1
            ? response({ error: 'start unavailable' }, 503)
            : response({ started: true });
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    const { client, onClose } = renderEditor();
    fillNew();
    fireEvent.click(screen.getByRole('button', { name: '保存并启动' }));
    expect(await screen.findByText(/start unavailable/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('服务名称')).toHaveValue('Demo API');
    fireEvent.click(screen.getByRole('button', { name: '保存并启动' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(writes.filter((item) => item.url === '/api/services')).toHaveLength(1);
    const savedID = writes.find((item) => item.url === '/api/services').body.id;
    expect(writes.filter((item) => item.url.endsWith('/start'))).toHaveLength(2);
    expect(
      writes
        .filter((item) => item.url.endsWith('/start'))
        .every((item) => item.url === `/api/services/${encodeURIComponent(savedID)}/start`),
    ).toBe(true);
    client.clear();
  });
  it('retains edited inputs and original concurrency version after conflict and background refetch', async () => {
    let definition = {
      id: 'svc/1',
      edit_version: 7,
      name: 'Original',
      command: 'node',
      work_dir: '/tmp/demo',
      args: ['server file.js'],
      env: {},
      health_url: 'http://127.0.0.1:8080/health',
      startup_timeout_ms: 45000,
      environment_id: 'local',
    };
    const writes: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit = {}) => {
        if (url === '/api/execution-environments')
          return response({ items: [{ id: 'local', name: '本机' }] });
        if (url === '/api/services/svc%2F1') return response({ definition });
        if (url === '/api/services') {
          writes.push(JSON.parse(String(options.body)));
          return response({ error: '编辑版本冲突，请重新载入' }, 409);
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    const { client, onClose } = renderEditor('svc/1');
    await waitFor(() => expect(screen.getByLabelText('服务名称')).toHaveValue('Original'));
    expect(screen.queryByRole('button', { name: '保存并启动' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('服务名称'), { target: { value: 'My unsaved edit' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByText(/编辑版本冲突/)).toBeInTheDocument();
    expect(writes[0]).toMatchObject({
      id: 'svc/1',
      edit_version: 7,
      name: 'My unsaved edit',
      startup_timeout_ms: 45000,
    });
    definition = { ...definition, edit_version: 8, name: 'Concurrent edit' };
    await client.invalidateQueries({ queryKey: ['service-edit', 'svc/1'] });
    expect(screen.getByLabelText('服务名称')).toHaveValue('My unsaved edit');
    expect(onClose).not.toHaveBeenCalled();
    client.clear();
  });
});

it('protects external and flow-owned processes and editing of active managed services', async () => {
  const services = [
    { id: 'external', name: 'External service', status: 'running', owner: 'external' },
    { id: 'flow', name: 'Flow service', status: 'running', owner: 'flow-1' },
    { id: 'manual', name: 'Manual service', status: 'running', owner: 'manual' },
    { id: 'stopped', name: 'Stopped service', status: 'stopped', owner: '' },
  ].map((item) => ({ ...item, environment_id: 'local', health_url: 'http://localhost/health' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({ services, events: [], service_logs: [], event_cursor: 0, service_cursor: 0 }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ServicesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText('External service');
  function card(name: string) {
    return within(screen.getByText(name).closest('[data-slot="card"]') as HTMLElement);
  }
  expect(card('External service').getByRole('button', { name: '外部运行中' })).toBeDisabled();
  expect(card('External service').getByRole('button', { name: '编辑' })).toBeEnabled();
  expect(card('Flow service').getByRole('button', { name: '流程管理中' })).toBeDisabled();
  expect(card('Flow service').getByRole('button', { name: '编辑' })).toBeDisabled();
  expect(card('Manual service').getByRole('button', { name: '停止' })).toBeEnabled();
  expect(card('Manual service').getByRole('button', { name: '编辑' })).toBeDisabled();
  expect(card('Stopped service').getByRole('button', { name: '启动' })).toBeEnabled();
  expect(card('Stopped service').getByRole('button', { name: '编辑' })).toBeEnabled();
  client.clear();
});
