import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const dir of ['scripts']) {
  for (const file of readdirSync(resolve(root, dir))) {
    if (/\.(m?js)$/.test(file)) execFileSync(process.execPath, ['--check', resolve(root, dir, file)], { stdio: 'inherit' });
  }
}
console.log('JavaScript syntax checks passed.');
