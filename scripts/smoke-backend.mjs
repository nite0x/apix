// Exercise the real standalone runtime over MCP, with a real MySQL-backed API.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const base = process.env.APIX_RUNTIME_URL || 'http://127.0.0.1:4317';
const release = existsSync(resolve(here, 'apix-runtime.exe')) ? here : resolve(root, 'release');
const configs = await (await fetch(`${base}/api/ai-tools`)).json();
const entry = JSON.parse(configs.clients.find(client => client.id === 'cursor').snippet).mcpServers.apix;
const child = spawn(entry.command, entry.args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const lines = createInterface({ input: child.stdout });
const pending = new Map();
function fail(error) {
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
  pending.clear();
}
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { fail(new Error('Invalid stdio MCP response')); return; }
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  clearTimeout(call.timer);
  if (message.error) call.reject(new Error(JSON.stringify(message.error)));
  else call.resolve(message.result);
});
child.on('error', fail);
child.on('exit', () => fail(new Error('MCP stdio process exited')));
child.stdin.on('error', fail);
let sequence = 0;
async function rpc(method, params, notification = false) {
  if (notification) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    return;
  }
  const id = ++sequence;
  return await new Promise((resolveCall, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 30000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function tool(name, args = {}) {
  const out = await rpc('tools/call', { name, arguments: args });
  if (out.isError) throw new Error(`${name}: ${JSON.stringify(out.structuredContent || out.content)}`);
  return out.structuredContent;
}
async function wait(runId) {
  for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
    const run = await tool('get_flow_run', { run_id: runId });
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`run ${runId} did not finish`);
}
function assert(value, message) { if (!value) throw new Error(message); }
try {
const report = { date: new Date().toISOString(), runtime: base, transport: 'stdio', runs: [] };
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'apix-mvp-smoke', version: '1' } });
await rpc('notifications/initialized', {}, true);
const tools = await rpc('tools/list', {});
report.tools = tools.tools.map(tool => tool.name);
for (const name of ['send_request', 'execute_sql', 'start_service', 'save_flow', 'run_flow', 'get_api_run', 'get_run_events']) assert(report.tools.includes(name), `missing ${name}`);
const connectionId = process.argv[2];
assert(connectionId, 'Create a MySQL connection in /databases first, then pass its connection ID: node smoke-backend.mjs CONNECTION_ID');
assert((await tool('list_database_connections')).items.some(item => item.id === connectionId), 'The selected database connection does not exist');
await tool('test_database_connection', { connection_id: connectionId });
await tool('save_service', { service: { id: 'demo-service', name: 'MySQL demo API', work_dir: release, command: resolve(release, process.platform === 'win32' ? 'apix-demo-service.exe' : 'apix-demo-service'), args: [], health_url: 'http://127.0.0.1:18767/health', startup_timeout_ms: 10000 } });
const flowFile = existsSync(resolve(release,'demo-flow.json')) ? resolve(release,'demo-flow.json') : resolve(root,'runtime/examples/demo-flow.json');
const definition = JSON.parse(await readFile(flowFile, 'utf8'));
for (const step of definition.flow.steps) { if (step.sql) step.sql.connection_id = connectionId; }
const saved = (await tool('save_flow', definition)).result;
for (let i = 0; i < 2; i++) {
  const accepted = (await tool('run_flow', { flow_id: saved.id, expected_flow_version: saved.edit_version })).result;
  const run = await wait(accepted.id);
  assert(run.status === 'succeeded', `normal flow failed: ${JSON.stringify(run)}`);
  assert(run.steps[2].result.row_count === 1, 'SQL verification missing');
  assert(run.steps[3].result.rows_affected === 1, 'test record cleanup missing');
  const response = await tool('get_api_run', { run_id: run.steps[1].api_run_id });
  assert(response.response_status === 201 && response.response_body.id, 'HTTP response inaccessible to AI');
  const service = await tool('get_service_status', { service_id: 'demo-service' });
  assert(service.status === 'stopped', 'service remains running after success');
  report.runs.push({ id: run.id, scenario: 'normal-repeat', status: run.status });
}
const start = definition.flow.steps[0];
const failFlow = (await tool('save_flow', { flow: { name: 'Expected failure smoke', steps: [start, { type: 'http', name: 'Wrong expectation', request: { method: 'GET', url: 'http://127.0.0.1:18767/health' }, config: { expected_status: 418 } }] } })).result;
let run = await wait((await tool('run_flow', { flow_id: failFlow.id })).result.id);
assert(run.status === 'failed' && run.steps[1].assertions[0].passed === false, 'incorrect expectation passed');
assert((await tool('get_service_status', { service_id: 'demo-service' })).status === 'stopped', 'failure left service running');
report.runs.push({ id: run.id, scenario: 'assertion-failure', status: run.status });
const cancelFlow = (await tool('save_flow', { flow: { name: 'Cancel smoke', steps: [start, { type: 'http', name: 'Slow request', request: { method: 'GET', url: 'http://127.0.0.1:18767/slow' }, config: { expected_status: 200 } }] } })).result;
const cancelRunId = (await tool('run_flow', { flow_id: cancelFlow.id })).result.id;
for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
  run = await tool('get_flow_run', { run_id: cancelRunId });
  if (run.steps[1].status === 'running') break;
  await new Promise(resolve => setTimeout(resolve, 50));
}
assert(run.steps[1].status === 'running', 'cancel scenario did not start');
await tool('cancel_flow_run', { run_id: cancelRunId });
run = await wait(cancelRunId);
assert(run.status === 'cancelled', 'run cancellation failed');
assert((await tool('get_service_status', { service_id: 'demo-service' })).status === 'stopped', 'cancellation left service running');
report.runs.push({ id: run.id, scenario: 'cancellation', status: run.status });
const events = await tool('get_run_events', { run_id: cancelRunId });
assert(events.items.some(event => event.type === 'flow_run.cleanup_finished'), 'cleanup event missing');
assert(events.items.at(-1).type === 'flow_run.finished', 'terminal event before cleanup');
const logs = await tool('get_service_logs', { service_id: 'demo-service' });
assert(logs.items.some(line => line.stream === 'stderr'), 'child service logs missing');
report.serviceLogLines = logs.items.length;
report.status = 'passed';
await mkdir(release, { recursive: true });
await writeFile(resolve(release, 'verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
} finally {
  child.stdin.end();
  lines.close();
  child.kill();
}
