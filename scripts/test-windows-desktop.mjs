// Linux tooling builds the test; the Windows executable is the test subject.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux' || !process.env.WSL_DISTRO_NAME) throw new Error('Run this acceptance test in Ubuntu WSL.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = resolve(root, 'release/windows-x64');
for (const file of ['Apix.exe', 'apix-runtime.exe']) {
  if (!existsSync(resolve(release, file))) throw new Error('Run pnpm build:windows before pnpm test:windows-desktop.');
}
execFileSync(process.env.APIX_GO || 'go', ['test', '-c', '-o', resolve(release, 'apix-desktop-test.exe'), './cmd/apix'], {
  cwd: resolve(root, 'runtime'), stdio: 'inherit', env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
});
const windowsTemp = execFileSync('cmd.exe', ['/d', '/c', 'echo', '%TEMP%'], { cwd: '/mnt/c', encoding: 'utf8' }).trim();
const base = realpathSync(execFileSync('wslpath', ['-u', windowsTemp], { encoding: 'utf8' }).trim());
const directory = mkdtempSync(resolve(base, 'apix-desktop-test-'));
let code = 1;
try {
  for (const file of ['Apix.exe', 'apix-runtime.exe', 'apix-desktop-test.exe']) copyFileSync(resolve(release, file), resolve(directory, file));
  const preview = execFileSync('wslpath', ['-w', resolve(directory, 'desktop-preview.png')], { encoding: 'utf8' }).trim();
  const result = spawnSync(resolve(directory, 'apix-desktop-test.exe'), ['-test.v', '-test.timeout=180s', '-apix-desktop-acceptance', '-apix-desktop-preview=' + preview], { cwd: directory, stdio: 'inherit' });
  if (existsSync(resolve(directory, 'desktop-preview.png'))) copyFileSync(resolve(directory, 'desktop-preview.png'), resolve(root, 'release/windows-desktop-preview.png'));
  if (result.error) throw result.error;
  code = result.status ?? 1;
} finally {
  const actual = realpathSync(directory);
  if (dirname(actual) !== base || !basename(actual).startsWith('apix-desktop-test-') || actual === base || !actual.startsWith(base + sep)) throw new Error('Unexpected desktop-test directory; cleanup stopped.');
  rmSync(actual, { recursive: true, maxRetries: 30, retryDelay: 100 });
}
process.exitCode = code;
