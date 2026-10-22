import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import RecordsPage from './index';
vi.mock('@/components/lifecycle',()=>({RecordActions:()=>null,RetentionPolicy:()=>null}));
vi.mock('@/pages/commands',()=>({CommandCaseEditor:()=>null}));
vi.mock('@/pages/mcp',()=>({MCPCaseEditor:()=>null}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function mount(path:string){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});const router=createMemoryRouter([{path:'/execution-records',element:<RecordsPage/>}],{initialEntries:[path]});render(<QueryClientProvider client={client}><RouterProvider router={router}/></QueryClientProvider>);return{client,router};}
it('opens a purged flow run from the immutable snapshot and renders typed SQL data',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>{if(input==='/api/flows/deleted')return response({error:'not found'},404);if(input==='/api/flow-runs/run')return response({id:'run',flow_id:null,flow_name_snapshot:'Historical checkout',flow_version:2,status:'succeeded',created_at:'2026-01-01T00:00:00Z',total_steps:1,steps:[{id:'sql-step',name_snapshot:'Stored SQL',type:'sql',status:'succeeded',sql_snapshot:{connection_id:'db',mode:'query',sql:'SELECT name FROM users WHERE id=?',params:[42]},result:{rows:[{name:'<script>untrusted</script>'}],columns:['name'],row_count:1},assertions:[]}]});return response([]);}));
 mount('/execution-records?type=flow&id=deleted&run=run&step=sql-step');await screen.findByText('原流程已彻底删除，历史快照独立保留。');expect(screen.getByText('Historical checkout')).toBeInTheDocument();expect(await screen.findByRole('table',{name:'SQL 查询数据'})).toHaveTextContent('<script>untrusted</script>');expect(document.querySelector('script')).toBeNull();expect(screen.queryByRole('link',{name:'查看流程定义'})).not.toBeInTheDocument();
});
it('opens the exact batch attempt from a deep link and keeps the selected tab during refresh',async()=>{
 let updated=false;const batch=()=>({id:'batch',name:'Saved batch',source:'',status:'completed',created_at:'2026-01-01T00:00:00Z',counts:{total:2,passed:1,failed:1},runs:[{id:'first',name:'First attempt',type:'command',status:'passed',command_request_snapshot:{program:'echo'},command_result:{exit_code:0,stdout:'first'}},{id:'second',name:'Exact attempt',type:'command',status:updated?'passed':'failed',command_request_snapshot:{program:'echo',args:['hello']},command_result:{exit_code:0,stdout:updated?'updated output':'retained output'},assertions:[]}]});
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>{if(input.startsWith('/api/execution-records?'))return response({items:[batch()],total:1});if(input==='/api/test-batches/batch')return response(batch());return response([]);}));
 const {client,router}=mount('/execution-records?batch=batch&step=second');expect(await screen.findByRole('dialog')).toHaveTextContent('Exact attempt');await userEvent.click(screen.getByRole('tab',{name:'执行输出'}));expect(screen.getByText('retained output')).toBeInTheDocument();updated=true;await client.invalidateQueries({queryKey:['test-batch','batch']});await waitFor(()=>expect(screen.getByText('updated output')).toBeInTheDocument());expect(screen.getByRole('tab',{name:'执行输出'})).toHaveAttribute('aria-selected','true');expect(router.state.location.search).toContain('step=second');
});
