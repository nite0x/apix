import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWeb } from './build-web.mjs';

buildWeb();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = {
  'aarch64-apple-darwin': ['darwin', 'arm64'],
  'x86_64-apple-darwin': ['darwin', 'amd64'],
  'x86_64-pc-windows-msvc': ['windows', 'amd64'],
  'aarch64-pc-windows-msvc': ['windows', 'arm64'],
  'x86_64-unknown-linux-gnu': ['linux', 'amd64'],
  'aarch64-unknown-linux-gnu': ['linux', 'arm64'],
};
const target = process.env.TAURI_ENV_TARGET_TRIPLE || process.argv[2]
  || /^host: (.+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1];
if (!targets[target]) throw new Error(`Unsupported desktop target: ${target}. Use a native macOS, Windows MSVC, or Linux GNU target.`);
const [goos, goarch] = targets[target];
const binary = resolve(root, `src-tauri/binaries/apix-runtime-${target}${goos === 'windows' ? '.exe' : ''}`);

function build(output, entry, os, arch) {
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.tmp${os === 'windows' ? '.exe' : ''}`;
  try {
    const env = { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: '0' };
    delete env.GOROOT;
    delete env.GOTOOLDIR;
    execFileSync(process.env.APIX_GO || 'go', ['build', '-trimpath', '-ldflags=-s -w', '-o', temporary, entry], {
      cwd: resolve(root, 'runtime'), env, stdio: 'inherit', windowsHide: true,
    });
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// Every Tauri dev/build runs this hook: a failed Go build aborts packaging and
// can never silently ship a previously built sidecar.
build(binary, '.', goos, goarch);
if (goos === 'windows') {
  for (const arch of ['amd64', 'arm64']) {
    build(resolve(root, `src-tauri/resources/executors/linux-${arch}/apix-executor`), './cmd/apix-executor', 'linux', arch);
  }
}
console.log(`Go sidecar ready: ${binary}`);
