import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  throw new Error('Build the Tauri Windows installer on Windows with Rust MSVC and Microsoft C++ Build Tools. For a standalone cross-compiled Go backend, use pnpm build:runtime with GOOS=windows.');
}
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url)), 'build', '--bundles', 'nsis', ...process.argv.slice(2)], {
  stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
