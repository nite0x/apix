import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.env.APIX_OUTPUT_DIR || 'release');
mkdirSync(output, { recursive: true });
const suffix = (process.env.GOOS || (process.platform === 'win32' ? 'windows' : process.platform)) === 'windows' ? '.exe' : '';
for (const [target, name] of [['.', 'apix-runtime'], ['./cmd/demo-service', 'apix-demo-service']]) {
  const result = spawnSync(process.env.APIX_GO || 'go', ['build', '-trimpath', '-ldflags=-s -w', '-o', resolve(output, name + suffix), target], {
    cwd: resolve(root, 'runtime'), stdio: 'inherit', windowsHide: true, env: { ...process.env, CGO_ENABLED: '0' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
copyFileSync(resolve(root, 'scripts/start-backend.ps1'), resolve(output, 'start.ps1'));
copyFileSync(resolve(root, 'runtime/GUIDE.md'), resolve(output, 'README.md'));
copyFileSync(resolve(root, 'docs/API_TESTING.md'), resolve(output, 'API_TESTING.md'));
copyFileSync(resolve(root, 'runtime/examples/demo-flow.json'), resolve(output, 'demo-flow.json'));
copyFileSync(resolve(root, 'scripts/smoke-backend.mjs'), resolve(output, 'smoke-backend.mjs'));
console.log(`Apix workspace built in ${output}`);
