import { describe, expect, it } from 'vitest';
import { blankRequest, executionLink, historyDraft, readDraft, requestURL, toDraft, type RequestData } from './model';

describe('HTTP request editing contract', () => {
  it('round-trips duplicate query parameters, disabled entries and saved authentication', () => {
    const original: RequestData = {
      method: 'POST', url: 'http://localhost/api?existing=1', body_type: 'raw', body: '<text>',
      query_params: [{ name: 'tag', value: 'one', enabled: true }, { name: 'tag', value: 'two', enabled: true }, { name: 'off', value: 'kept', enabled: false }],
      headers: [{ name: 'X-Keep', value: 'off', enabled: false }], auth_config: { type: 'bearer', token: 'saved-secret' },
      timeout_ms: 45000, follow_redirects: false,
    };
    expect(readDraft(toDraft(original), original)).toEqual(original);
    expect(requestURL(original)).toBe('http://localhost/api?existing=1&tag=one&tag=two');
  });

  it('rejects redacted historical credentials, including encoded URL values', () => {
    const original: RequestData = { method: 'GET', url: 'https://example.test?key=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2' };
    expect(() => readDraft(toDraft(original), original)).toThrow('脱敏');
    const reused = historyDraft({ method: 'GET', url: 'https://example.test', auth_config: { type: 'api_key', in: 'query' } });
    expect(reused.request.auth_config).toBeUndefined();
    expect(reused.draft.query).toBe('REPLACE_API_KEY_NAME=••••••');
    expect(() => readDraft(reused.draft, reused.request)).toThrow('脱敏');
    expect(readDraft({ ...reused.draft, query: 'api-key=replaced-value' }, reused.request).query_params).toEqual([{ name: 'api-key', value: 'replaced-value', enabled: true }]);
  });

  it('drops disabled historical parameters while leaving explicit auth replacements', () => {
    const result = historyDraft({ method: 'GET', url: 'https://example.test', headers: [{ name: 'X-Disabled', value: 'omit', enabled: false }], auth_config: { type: 'bearer', redacted: true } });
    expect(result.request.headers).toEqual([]);
    expect(result.draft.headers).toBe('Authorization: ••••••');
    expect(result.redacted).toBe(true);
  });

  it('validates HTTP URLs, row syntax and JSON, and omits bodies for GET/HEAD', () => {
    const original = blankRequest();
    const draft = { ...toDraft(original), url: 'http://localhost/api', method: 'POST', bodyType: 'json', body: '{invalid' };
    expect(() => readDraft(draft, original)).toThrow('JSON');
    expect(() => readDraft({ ...draft, body: '{}', headers: 'broken-header' }, original)).toThrow('Header第 1 行');
    expect(() => readDraft({ ...draft, body: '{}', url: 'file:///etc/passwd' }, original)).toThrow('http://');
    expect(readDraft({ ...draft, method: 'GET' }, original)).toMatchObject({ body_type: 'none', body: '' });
  });

  it('links to exact persisted batch and flow ownership, including the selected step', () => {
    expect(executionLink({ batch_id: 'batch/1', test_run_id: 'test-2', step_id: 'older-step' })).toBe('/execution-records?batch=batch%2F1&step=test-2');
    expect(executionLink({ flow_id: 'flow-1', flow_run_id: 'flow-run-2', step_id: 'step-3' })).toBe('/execution-records?type=flow&id=flow-1&run=flow-run-2&step=step-3');
    expect(executionLink({})).toBeNull();
  });
});
