import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') throw new Error('Build the Windows release in Ubuntu WSL using Linux Go and Node.js.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'release/windows-x64');
execFileSync(process.execPath, [resolve(root, 'scripts/build-runtime.mjs')], {
  cwd: root, stdio: 'inherit', env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', APIX_OUTPUT_DIR: output },
});
mkdirSync(output, { recursive: true });
for (const arch of ['amd64', 'arm64']) {
  const directory=resolve(output,'executors', 'linux-'+arch);
  mkdirSync(directory,{recursive:true});
  execFileSync(process.env.APIX_GO || 'go',['build','-trimpath','-ldflags=-s -w','-o',resolve(directory,'apix-executor'),'./cmd/apix-executor'],{
    cwd:resolve(root,'runtime'),stdio:'inherit',env:{...process.env,GOOS:'linux',GOARCH:arch,CGO_ENABLED:'0'},
  });
  const checksum=createHash('sha256').update(readFileSync(resolve(directory,'apix-executor'))).digest('hex');
  writeFileSync(resolve(directory,'apix-executor.sha256'),checksum+'  apix-executor'+String.fromCharCode(10));
}

execFileSync(process.env.APIX_GO || 'go', ['build', '-trimpath', '-ldflags=-s -w -H=windowsgui', '-o', resolve(output, 'Apix.exe'), './cmd/apix'], {
  cwd: resolve(root, 'runtime'), stdio: 'inherit', env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
});
for (const name of ['Apix.exe', 'apix-runtime.exe', 'apix-demo-service.exe']) {
  const checksum = createHash('sha256').update(readFileSync(resolve(output, name))).digest('hex');
  writeFileSync(resolve(output, `${name}.sha256`), `${checksum}  ${name}\n`);
}
copyFileSync(resolve(root, 'scripts/install-windows.ps1'), resolve(output, 'Install.ps1'));
copyFileSync(resolve(root, 'docs/WINDOWS.md'), resolve(output, 'README-Windows.md'));
copyFileSync(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'));
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const archive = resolve(root, `release/Apix_${version}_windows-x64.zip`);
const files = ['executors/linux-amd64/apix-executor','executors/linux-amd64/apix-executor.sha256','executors/linux-arm64/apix-executor','executors/linux-arm64/apix-executor.sha256','Apix.exe', 'apix-runtime.exe', 'Apix.exe.sha256', 'apix-runtime.exe.sha256', 'Install.ps1', 'README-Windows.md', 'LICENSE'];
execFileSync('python3', ['-c', 'import pathlib,sys,zipfile; base=pathlib.Path(sys.argv[1]); archive=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED); [archive.write(base/name,name) for name in sys.argv[3:]]; archive.close()', output, archive, ...files], { stdio: 'inherit' });
const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${checksum}  ${archive.split('/').at(-1)}\n`);
console.log(`Windows desktop package: ${archive}\nRun Install.ps1 on Windows to create the desktop shortcut. The desktop workspace uses port 4319 and a separate data directory.`);
