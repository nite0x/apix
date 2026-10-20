// Use persisted ownership IDs; requests with the same URL may belong to different batches.
export function executionBatchLink(record, className = 'text-button') {
  const query = new URLSearchParams();
  let path;
  if (record.batch_id) {
    path = '/test-collections'; query.set('batch', record.batch_id);
    if (record.test_run_id || record.step_id) query.set('step', record.test_run_id || record.step_id);
  } else if (record.flow_run_id && record.flow_id) {
    path = '/tests'; query.set('tab', 'records'); query.set('type', 'flow');
    query.set('id', record.flow_id); query.set('run', record.flow_run_id);
    if (record.step_id) query.set('step', record.step_id);
  }
  const link = document.createElement(path ? 'a' : 'span');
  link.className = path ? className : 'subtle';
  link.textContent = path ? '查看执行批次' : '未关联批次';
  if (path) { link.href = `${path}?${query}`; link.dataset.route = ''; }
  return link;
}

export function revealExecutionStep(id) {
  const element = document.getElementById(id);
  if (!element) return;
  element.focus({ preventScroll: true });
  element.scrollIntoView?.({ block: 'center' });
}
