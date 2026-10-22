import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFile} from 'node:fs/promises';
const tick=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
test('service editor checks WSL as the selected user, pins it on save and retains drafts on failure',async t=>{
 const dom=new JSDOM(await readFile(new URL('./web/index.html',import.meta.url),'utf8'),{url:'http://localhost/services'});
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,Event:dom.window.Event,Option:dom.window.Option,location:dom.window.location});
 const $=id=>document.getElementById(id);
 let saved;let checked;let fail=false;
 const result=(data,status=200)=>({ok:status<400,status,json:async()=>structuredClone(data)});
 globalThis.fetch=async(path,options={})=>{
  if(path==='/api/execution-environments')return result({items:[{id:'local',name:'Windows 本机'},{id:'wsl:Ubuntu:',name:'WSL · Ubuntu'}]});
  if(path==='/api/execution-environments/check'){
   checked=JSON.parse(options.body);if(fail)return result({error:'Ubuntu 中找不到 pnpm'},400);
   return result({id:'wsl:Ubuntu:nite',name:'WSL · Ubuntu · nite',program:'/home/nite/.local/bin/pnpm',work_dir:'/home/nite/projects/app'});
  }
  if(path==='/api/services'&&options.method==='PUT'){saved=JSON.parse(options.body);return result({...saved,edit_version:1});}
  throw new Error('unexpected '+path);
 };
 try{
  await import('./web/service-editor.js');
  $('service-add').click();await tick();
  $('service-environment').value='wsl:Ubuntu:';$('service-environment').dispatchEvent(new dom.window.Event('change'));
  assert.equal($('service-user-field').hidden,false);
  $('service-user').value='nite';$('service-name').value='WSL API';$('service-work-dir').value='/home/nite/projects/app';$('service-command').value='pnpm';$('service-args').value='dev\n--port\n8080';$('service-health-url').value='http://127.0.0.1:8080/health';$('service-env').value='{"PATH":"/home/nite/.local/bin:/usr/bin:/bin"}';
  fail=true;$('service-check-environment').click();await tick();
  assert.match($('service-environment-result').textContent,/找不到 pnpm/);
  assert.equal($('service-work-dir').value,'/home/nite/projects/app');
  assert.equal($('service-save').disabled,false);
  fail=false;$('service-check-environment').click();await tick();
  assert.equal(checked.environment_id,'wsl:Ubuntu:nite');assert.equal(checked.program,'pnpm');
  assert.equal($('service-environment').value,'wsl:Ubuntu:nite');
  assert.match($('service-environment-result').textContent,/检查通过/);
  $('service-form').dispatchEvent(new dom.window.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:$('service-save')}));
  await tick();
  assert.equal(saved.environment_id,'wsl:Ubuntu:nite');assert.deepEqual(saved.args,['dev','--port','8080']);assert.equal(saved.env.PATH,'/home/nite/.local/bin:/usr/bin:/bin');
  assert.equal($('service-editor').open,false);
 }finally{dom.window.close();}
});
