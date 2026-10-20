import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFile} from 'node:fs/promises';
const tick=async()=>{for(let i=0;i<15;i++)await new Promise(resolve=>setImmediate(resolve));};

test('saved cases have a separate searchable lifecycle with safe editing, copies, archive and restore',async t=>{
 const dom=new JSDOM(await readFile(new URL('./web/index.html',import.meta.url),'utf8'),{url:'http://localhost/tests'});
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,location:dom.window.location,history:dom.window.history,Option:dom.window.Option,Event:dom.window.Event});
 t.mock.method(globalThis,'setTimeout',()=>0);document.getElementById('testing-workspace').hidden=false;
 let rows=[{id:'http-1',name:'HTTP check',type:'http',edit_version:1,request:{method:'GET',url:'http://example.test'},assertions:[]},{id:'cmd-1',name:'Command check',type:'command',edit_version:1,command_request:{program:'echo',args:['hello']},assertions:[]}];
 const writes=[];let conflict=false;
 const result=(value,status=200)=>({status,ok:status<400,json:async()=>structuredClone(value)});
 globalThis.fetch=async(path,options={})=>{
  const method=options.method||'GET';if(method!=='GET')writes.push({path,method,body:JSON.parse(options.body||'{}')});
  if(path==='/api/test-cases'||path==='/api/test-cases?archived=true')return result(rows.filter(item=>Boolean(item.archived)===path.includes('archived=true')));
  const id=decodeURIComponent(path.split('/')[3]||'');const item=rows.find(item=>item.id===id);
  if(method==='PUT'){if(conflict)return result({error:'case changed; reload'},409);Object.assign(item,JSON.parse(options.body),{edit_version:item.edit_version+1});return result(item);}
  if(method==='DELETE'){item.archived=true;return result(null,204);}
  if(path.endsWith('/restore')){item.archived=false;return result(item);}
  if(path.endsWith('/duplicate')){const copy={...item,id:'copy',name:item.name+' · 副本',edit_version:1};rows.push(copy);return result(copy,201);}
  if(path==='/api/test-batches')return result([]);
  throw new Error(`${method} ${path}`);
 };
 const click=async text=>{const button=[...document.querySelectorAll('button')].find(node=>node.textContent===text&&!node.closest('[hidden]'));assert.ok(button,text);button.click();await tick();};
 try{
  const testing=await import('./web/testing.js');await testing.activateTesting();await tick();
  assert.equal(location.pathname,'/tests');assert.equal(document.getElementById('flow-workspace').hidden,true);
  assert.equal(document.querySelectorAll('.testing-case-list article').length,2);
  const search=document.querySelector('[aria-label="搜索已保存用例"]');search.value='Command';search.dispatchEvent(new window.Event('input'));assert.equal(document.querySelectorAll('.testing-case-list article').length,1);
  search.value='HTTP';search.dispatchEvent(new window.Event('input'));await click('编辑');
  const name=document.querySelector('dialog[open] [aria-label="用例名称"]');name.value='edited HTTP';conflict=true;
  document.querySelector('dialog[open] form').dispatchEvent(new window.Event('submit',{cancelable:true}));await tick();assert.match(document.querySelector('dialog[open]').textContent,/case changed/);assert.equal(name.value,'edited HTTP');
  conflict=false;document.querySelector('dialog[open] form').dispatchEvent(new window.Event('submit',{cancelable:true}));await tick();assert.equal(rows[0].id,'http-1');assert.equal(rows[0].edit_version,2);
  await click('复制');assert.equal(rows[2].id,'copy');assert.equal(rows[2].edit_version,1);
  await click('归档');await click('确认归档');assert.equal(rows[0].archived,true);
  await click('已归档用例');assert.equal(document.querySelectorAll('.testing-case-list article').length,1);assert.equal(document.querySelector('.testing-case-list input').disabled,true);
  await click('详情');assert.equal([...document.querySelectorAll('dialog[open] button')].some(node=>node.textContent==='编辑用例'),false);await click('恢复用例');assert.equal(rows[0].archived,false);
  assert.equal(writes.some(item=>item.path.includes('/runs')),false);
 }finally{dom.window.close();}
});
