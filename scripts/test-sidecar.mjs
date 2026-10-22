import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = /^host: (.+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))[1];
const executable = resolve(root, process.argv[2] || `src-tauri/binaries/apix-runtime-${target}${process.platform === 'win32' ? '.exe' : ''}`);
const directory = mkdtempSync(join(tmpdir(), 'apix-sidecar-'));
const children = [];

function launch(name, address = '127.0.0.1:0') {
  const child = spawn(executable, [], {
    cwd: directory,
    env: { ...process.env, APIX_DESKTOP_SIDECAR: '1', APIX_ADDR: address, APIX_DB_PATH: join(directory, name, 'apix.db'), APIX_LOG_PATH: join(directory, name, 'runtime.log') },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exit = new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolveExit({ code, signal, stderr }));
  });
  return { child, exit };
}

async function withTimeout(promise, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${description} timed out`)), 40000); })]);
  } finally { clearTimeout(timer); }
}

try {
  for (const mode of ['shutdown', 'eof', 'parent-pipes-closed']) {
    const { child, exit } = launch(mode);
    const ready = new Promise((resolveReady, reject) => {
      let output = '';
      child.stdout.on('data', data => {
        output += data;
        if (output.includes('\n')) {
          try { resolveReady(JSON.parse(output.trim())); } catch (error) { reject(error); }
        }
      });
      exit.then(result => reject(new Error(`Exited before readiness: ${JSON.stringify(result)}`)), reject);
    });
    const message = await withTimeout(ready, 'readiness');
    assert.equal(message.type, 'ready');
    const url = new URL(message.url);
    assert.equal(url.hostname, '127.0.0.1');
    assert.notEqual(url.port, '0');
    const health = await fetch(new URL('/health', url));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { service: 'apix-runtime', status: 'ok' });
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
    execFileSync(executable, ['mcp-probe', '--url', new URL('/mcp', url).href], { timeout: 15000, windowsHide: true, stdio: 'pipe' });
    if (mode === 'shutdown') child.stdin.write('shutdown\n');
    else {
      if (mode === 'parent-pipes-closed') {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      child.stdin.end();
    }
    const result = await withTimeout(exit, mode);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.match(readFileSync(join(directory, mode, 'runtime.log'), 'utf8'), /runtime.stopped/);
    console.log(`Sidecar ${mode}: readiness, workspace, MCP and clean exit passed.`);
  }

  const occupied = createServer();
  await new Promise(resolveListen => occupied.listen(0, '127.0.0.1', resolveListen));
  try {
    const { exit } = launch('occupied', `127.0.0.1:${occupied.address().port}`);
    const result = await withTimeout(exit, 'occupied port');
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /bind|address|listen/i);
    console.log('Occupied port: failed without reusing or stopping the existing listener.');
  } finally { await new Promise(resolveClose => occupied.close(resolveClose)); }
} finally {
  await Promise.all(children.map(child => new Promise(resolveExit => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
    child.once('exit', resolveExit);
    child.kill();
  })));
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
