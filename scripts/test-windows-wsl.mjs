// Run from Ubuntu WSL with Linux Node and Go; Windows binaries are test subjects.
import {execFileSync,spawnSync} from 'node:child_process';
import {copyFileSync,cpSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {basename,dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.platform!=='linux'||!process.env.WSL_DISTRO_NAME)throw new Error('Run this acceptance test in Ubuntu WSL.');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const distro=process.argv.slice(2).find(arg=>arg!=='--')||process.env.WSL_DISTRO_NAME;
const release=resolve(root,'release/windows-x64');
const buildEnv={...process.env,GOOS:'windows',GOARCH:'amd64',CGO_ENABLED:'0'};
for(const [target,name] of [['./integration','apix-acceptance.exe'],['./internal/executionenv','apix-executor-test.exe'],['./internal/mcpbridge','apix-bridge-test.exe']]){
 execFileSync(process.env.APIX_GO||'go',['test','-c','-o',resolve(release,name),target],{cwd:resolve(root,'runtime'),env:buildEnv,stdio:'inherit'});
}
// Use the same local-disk placement as the real Windows installation. In some
// Windows configurations UNC-launched binaries cannot use HTTP loopback reliably.
const tempWindows=execFileSync('cmd.exe',['/d','/c','echo','%TEMP%'],{cwd:'/mnt/c',encoding:'utf8'}).trim();
const tempLinux=execFileSync('wslpath',['-u',tempWindows],{encoding:'utf8'}).trim();
const base=realpathSync(tempLinux);
const directory=mkdtempSync(resolve(base,'apix-acceptance-'));
let code=0;
try{
 for(const name of ['apix-runtime.exe','apix-acceptance.exe','apix-executor-test.exe','apix-bridge-test.exe'])copyFileSync(resolve(release,name),resolve(directory,name));
 cpSync(resolve(release,'executors'),resolve(directory,'executors'),{recursive:true});
 for(const [name,args] of [
  ['apix-executor-test.exe',['-test.v','-test.timeout=60s']],
  ['apix-bridge-test.exe',['-test.v','-test.timeout=60s']],
  ['apix-acceptance.exe',['-test.v','-test.timeout=180s','-apix-wsl-distro='+distro]],
 ]){
  const result=spawnSync(resolve(directory,name),args,{cwd:directory,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0){code=result.status||1;break;}
 }
}finally{
 // Delete only the newly created test directory after checking its resolved
 // parent and prefix. Installed Apix files and user databases are never touched.
 const actual=realpathSync(directory);
 if(dirname(actual)!==base||!basename(actual).startsWith('apix-acceptance-')||actual===base||!actual.startsWith(base+sep))throw new Error('Unexpected acceptance-test directory; cleanup stopped.');
 rmSync(actual,{recursive:true});
}
process.exitCode=code;
