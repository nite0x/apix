import { expect, it } from 'vitest';
import { canonicalLocation } from './routes';
it('preserves batch and immutable flow deep links while normalizing legacy routes', () => {
  expect(canonicalLocation('/tests', '?tab=records&type=single&batch=b&step=s')).toBe(
    '/execution-records?batch=b&step=s',
  );
  expect(canonicalLocation('/flows', '?id=deleted&run=r&type=flow&step=s')).toBe(
    '/execution-records?id=deleted&run=r&type=flow&step=s',
  );
  expect(canonicalLocation('/test-collections', '?id=c&run=r&batch=b')).toBe(
    '/execution-records?batch=b',
  );
  expect(canonicalLocation('/activity', '')).toBe('/');
  expect(canonicalLocation('/requests', '')).toBeNull();
  expect(canonicalLocation('/flows', '?id=f')).toBeNull();
});
