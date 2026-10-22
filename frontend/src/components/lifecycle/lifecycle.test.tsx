import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { vi, expect, test } from 'vitest';
import { AIRemoval, ArchiveManager, BulkManager, RecordActions, RetentionPolicy, LogManager } from '../lifecycle';

const response = (data: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type':'application/json' } });
function setup(ui: ReactNode) { const client = new QueryClient({ defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}} });render(<QueryClientProvider client={client}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);return userEvent.setup(); }

test('restoring an archived connection preserves the new name on conflict and uses its original ID', async()=>{
  let archived=true, conflict=true; const writes:Array<{path:string;body:unknown;method:string}>=[]; const changed=vi.fn();
  vi.stubGlobal('fetch',vi.fn(async(path:string,options:RequestInit={})=>{
    if((options.method||'GET')==='GET')return response(archived?[{id:'db-1',name:'Database',host:'localhost'}]:[]);
    writes.push({path,body:JSON.parse(String(options.body)),method:options.method||'GET'});
    if(conflict)return response({error:'名称冲突，请改名后恢复'},409);archived=false;return response(null,204);
  }));
  const user=setup(<ArchiveManager kind="database" onChanged={changed}/>);
  await user.click(screen.getByRole('button',{name:'已归档数据库连接'}));
  await user.click(await screen.findByRole('button',{name:'恢复'}));
  const name=screen.getByRole('textbox',{name:'恢复名称'});await user.clear(name);await user.type(name,'Unique name');await user.click(screen.getByRole('button',{name:'确认恢复'}));
  await screen.findByText('名称冲突，请改名后恢复');expect(name).toHaveValue('Unique name');conflict=false;
  await user.click(screen.getByRole('button',{name:'确认恢复'}));await waitFor(()=>expect(changed).toHaveBeenCalledTimes(1));
  expect(writes[1]).toEqual({path:'/api/database/connections/db-1/restore',body:{name:'Unique name'},method:'POST'});expect(writes.some(w=>w.method==='DELETE')).toBe(false);
});

test('record cleanup requires its preview token and keeps a concurrent protection failure visible',async()=>{
  const writes:string[]=[];const removed=vi.fn();vi.stubGlobal('fetch',vi.fn(async(path:string)=>{writes.push(path);return path.endsWith('/cleanup-preview')?response({token:'preview',name:'batch',runs:3,http_records:2,sql_records:1}):response({error:'记录已固定，请重新预览'},409);}));
  const user=setup(<RecordActions record={{id:'batch',status:'completed'}} onRemoved={removed}/>);
  await user.click(screen.getByRole('button',{name:'清理整组记录'}));await screen.findByText(/3 条执行、2 条 HTTP 详情、1 条 SQL 记录/);expect(writes).toHaveLength(1);
  await user.click(screen.getByRole('button',{name:'确认永久清理'}));await screen.findByText('记录已固定，请重新预览');expect(removed).not.toHaveBeenCalled();expect(screen.getByRole('dialog')).toBeVisible();expect(writes).toEqual(['/api/execution-records/batch/cleanup-preview','/api/execution-records/cleanup']);
});

test('bulk purge reports protected resources and submits only individually previewed tokens',async()=>{
  const writes:unknown[]=[];vi.stubGlobal('fetch',vi.fn(async(path:string,options:RequestInit={})=>{if((options.method||'GET')==='GET')return response([{id:'one',name:'One',summary:'HTTP',archived:true},{id:'two',name:'Two',summary:'MCP',archived:true}]);if(path.endsWith('/one/purge-preview'))return response({token:'one-token',kind:'test_case',id:'one',historical_records_preserved:3});if(path.endsWith('/two/purge-preview'))return response({error:'有定义引用'},409);writes.push(JSON.parse(String(options.body)));return response({items:[{id:'one',status:'succeeded'}]});}));
  const user=setup(<BulkManager kind="test_case"/>);await user.click(screen.getByRole('button',{name:'资源批量管理'}));await user.click(screen.getByRole('checkbox',{name:'已归档资源'}));await user.click(await screen.findByRole('checkbox',{name:'选择批量资源 One'}));await user.click(screen.getByRole('checkbox',{name:'选择批量资源 Two'}));await user.click(screen.getByRole('button',{name:'预览彻底删除'}));await screen.findByText('Two：受保护 · 有定义引用');await screen.findByText(/One：可彻底删除配置，保留 3 条关联历史/);
  expect(writes).toHaveLength(0);await user.click(screen.getByRole('button',{name:'确认彻底删除可删除项'}));await screen.findByText('逐项操作结果');expect(writes).toEqual([{items:[{kind:'test_case',id:'one',action:'purge',token:'one-token'}]}]);
});

test('retention cannot be enabled without previewing the current day count and never immediately cleans',async()=>{
  const writes:Array<{path:string;body:unknown}>=[];vi.stubGlobal('fetch',vi.fn(async(path:string,options:RequestInit={})=>{if((options.method||'GET')==='GET')return response({enabled:false,days:30});writes.push({path,body:JSON.parse(String(options.body))});return path.endsWith('/preview')?response({days:30,eligible:2,protected:1,items:[{name:'Pinned batch',eligible:false,reason:'已固定'}]}):response({enabled:true,days:30});}));
  const user=setup(<RetentionPolicy/>);await user.click(screen.getByRole('button',{name:'自动保留策略'}));await user.click(await screen.findByRole('checkbox',{name:'启用自动清理'}));await user.click(screen.getByRole('button',{name:'保存保留策略'}));await screen.findByText('启用前请先预览当前保留天数的影响。');expect(writes).toHaveLength(0);
  await user.click(screen.getByRole('button',{name:'预览保留策略影响'}));await screen.findByText('符合期限 2 组 · 受保护 1 组');await user.click(screen.getByRole('button',{name:'保存保留策略'}));await screen.findByText(/自动清理已启用；下次定时检查或重启/);expect(writes.map(w=>w.path)).toEqual(['/api/retention-policy/preview','/api/retention-policy']);
});

test('AI removal previews the selected target and refuses modified configuration without a fingerprint action',async()=>{
  const writes:Array<{path:string;body:unknown}>=[];vi.stubGlobal('fetch',vi.fn(async(path:string,options:RequestInit)=>{writes.push({path,body:JSON.parse(String(options.body))});return response({target:'windows',path:'C:/config/mcp.json',status:'modified',can_remove:false,difference:'headers 已被修改',instructions:'请在目标工具中审阅并手动移除'});}));
  const user=setup(<AIRemoval client={{id:'cursor',name:'Cursor'}} target="windows"/>);await user.click(screen.getByRole('button',{name:'移除配置'}));await screen.findByText('headers 已被修改');expect(screen.queryByRole('button',{name:'备份并确认移除'})).not.toBeInTheDocument();expect(writes).toEqual([{path:'/api/ai-tools/cursor/removal-preview',body:{target:'windows'}}]);
});

test('stored log deletion only executes after a scoped preview and confirmation',async()=>{
  const writes:Array<{path:string;body:unknown}>=[];vi.stubGlobal('fetch',vi.fn(async(path:string,options:RequestInit={})=>{if((options.method||'GET')==='GET')return response(path.includes('/service-log-sources')?[]:{total:1,items:[{sequence:1,time:'2026-10-22T00:00:00Z',stream:'stdout',source_name:'demo',message:'retained output'}]});writes.push({path,body:JSON.parse(String(options.body))});return path.endsWith('/cleanup-preview')?response({token:'log-token',count:1,source:'全部来源',before:'2026-10-22T00:00:00Z'}):response({removed:1});}));
  const user=setup(<LogManager/>);await user.click(screen.getByRole('button',{name:'查询与清理已存日志'}));await screen.findByText(/retained output/);await user.click(screen.getByRole('button',{name:'按来源和时间预览清理'}));await screen.findByText(/将永久删除 1 条日志/);expect(writes).toEqual([{path:'/api/service-logs/cleanup-preview',body:{source:''}}]);await user.click(screen.getByRole('button',{name:'确认删除已存日志'}));await waitFor(()=>expect(writes).toHaveLength(2));expect(writes[1]).toEqual({path:'/api/service-logs/cleanup',body:{token:'log-token'}});
});

test('flow archive lists use include_archived and exclude active definitions',async()=>{
  const reads:string[]=[];vi.stubGlobal('fetch',vi.fn(async(path:string)=>{reads.push(path);return response([{id:'active',name:'Active flow'},{id:'retired',name:'Retired flow',archived_at:'2026-10-22T00:00:00Z'}]);}));
  const user=setup(<ArchiveManager kind="flow"/>);await user.click(screen.getByRole('button',{name:'已归档业务流程'}));await screen.findByText('Retired flow');expect(screen.queryByText('Active flow')).not.toBeInTheDocument();expect(reads).toEqual(['/api/flows?include_archived=true']);
});
