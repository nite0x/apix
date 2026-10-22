import { describe, expect, it, vi } from 'vitest';
import { api, ApiError, json } from './api';

describe('runtime API contract', () => {
  it('returns persisted HTTP failures so their evidence remains viewable', async () => {
    const run = { id: 'failed-run', request_snapshot: { url: 'http://localhost' }, error_code: 'connection_refused' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(run), { status: 502 })));
    expect(await json('/runs', { request: { url: 'http://localhost' } })).toEqual(run);
  });
  it('preserves conflict payload and caller cancellation', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '版本冲突', edit_version: 3 }), { status: 409 }));
    vi.stubGlobal('fetch', fetcher); const controller = new AbortController();
    await expect(api('/requests/x', { signal: controller.signal })).rejects.toMatchObject({ status: 409, data: { edit_version: 3 } });
    expect(fetcher.mock.calls[0][1].signal).toBe(controller.signal);
  });
  it('does not treat arbitrary failed operations as persisted runs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'x', error: 'protected', request_snapshot: {} }), { status: 409 })));
    await expect(json('/requests', {})).rejects.toBeInstanceOf(ApiError);
  });
  it('supports no-content deletes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    expect(await api('/requests/x', { method: 'DELETE' })).toBeNull();
  });
});
