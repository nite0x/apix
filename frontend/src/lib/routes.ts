export function canonicalLocation(pathname: string, search: string): string | null {
  const query = new URLSearchParams(search);
  let path = pathname;
  if (path === '/activity') path = '/';
  if (['/flows', '/tests', '/test-collections', '/execution-records'].includes(path)) {
    const collection = path === '/test-collections';
    const records = path === '/execution-records' || collection || ['records', 'batches'].includes(query.get('tab') || '') || query.has('batch') || query.has('run');
    if (records) path = '/execution-records';
    query.delete('tab');
    if (collection) { query.delete('id'); query.delete('run'); query.delete('type'); }
    if (query.get('type') === 'single') query.delete('type');
  }
  const canonical = path + (query.size ? `?${query}` : '');
  return canonical === pathname + search ? null : canonical;
}
