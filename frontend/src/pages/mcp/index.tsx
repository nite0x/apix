import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, json } from '@/lib/api';
import { useDirty } from '@/lib/use-dirty';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Field, SelectField, ErrorAlert, PageHeader, EmptyState, CodeBlock } from '@/components/shared';
import { ResourceActions, ArchiveManager, BulkManager } from '@/components/lifecycle';
import { executeTest, parseObject, pretty, type TestCase } from '../commands/model';
import { ToolExecutionHistory, ToolRunResult } from '../commands/history';
import { EditorDialog, useEditorState } from '../commands/editor-dialog';
import type { CaseEditorProps } from '../commands';
import { mcpDraft, readMCP, schemaDefaults, parameterValue, type MCPDraft } from './model';

export function MCPCaseEditor({ item, open, onOpenChange, onSaved, batchID }: CaseEditorProps) {
  return <EditorDialog open={open} onOpenChange={onOpenChange} title={item?.id ? '编辑 MCP 测试用例' : '新建 MCP 测试用例'}>{(close, complete) => <MCPCaseForm key={item?.id || 'new'} item={item} onClose={close} onComplete={complete} onSaved={onSaved} batchID={batchID} />}</EditorDialog>;
}
function MCPCaseForm({ item, onClose, onComplete, onSaved, batchID }: { item?: TestCase | null; onClose: () => void; onComplete: () => void; onSaved?: CaseEditorProps['onSaved']; batchID?: string }) {
  const [draft, setDraft] = useState<MCPDraft>(() => mcpDraft(item));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  const queryClient = useQueryClient();
  const servers = useQuery<any[]>({ queryKey: ['mcp-servers'], queryFn: ({ signal }) => api('/mcp-servers', { signal }) });
  useDirty(dirty);
  useEditorState(dirty, pending);
  const update = (key: keyof MCPDraft, value: string) => { setDraft(previous => ({ ...previous, [key]: value })); setDirty(true); };
  const options = [{ value: '', label: '请选择服务器' }, ...(servers.data || []).map(server => ({ value: server.id, label: server.name }))];
  if (draft.server && !options.some(item => item.value === draft.server)) options.push({ value: draft.server, label: '原服务器已删除，请重新选择' });
  async function submit(intent: 'save' | 'run') {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try {
      const input = readMCP(draft, item);
      let resultBatch: string | undefined;
      if (intent === 'run') resultBatch = (await executeTest(input.value, input.variables, batchID)).batchID;
      else await json(item?.id ? `/test-cases/${encodeURIComponent(item.id)}` : '/test-cases', input.value, item?.id ? 'PUT' : 'POST');
      setDirty(false); await queryClient.invalidateQueries(); await onSaved?.(resultBatch); onComplete();
    } catch (failure) { setError(failure); } finally { lock.current = false; setPending(false); }
  }
  const text = (key: keyof MCPDraft, label: string, required = false) => <Field label={label}><Input aria-label={label} value={draft[key]} onChange={event => update(key, event.target.value)} required={required} /></Field>;
  const area = (key: keyof MCPDraft, label: string, rows = 4) => <Field label={label}><Textarea aria-label={label} rows={rows} value={draft[key]} onChange={event => update(key, event.target.value)} className="font-mono text-xs" spellCheck={false} /></Field>;
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit('save'); }}><fieldset disabled={pending} className="space-y-4">
    {text('name', '用例名称', true)}{text('description', '说明')}<SelectField label="MCP 服务器" value={draft.server} onValueChange={value => update('server', value)} options={options} disabled={pending} />{text('tool', '工具名称', true)}{area('args', '调用参数（JSON 对象）', 6)}
    <div className="grid gap-4 md:grid-cols-2"><SelectField label="预期工具结果" value={draft.expected} onValueChange={value => update('expected', value)} options={[{ value: '', label: '不设置预期' }, { value: 'false', label: '成功 · isError=false' }, { value: 'true', label: '业务错误 · isError=true' }]} disabled={pending} /><SelectField label="校验 outputSchema" value={draft.validateOutput} onValueChange={value => update('validateOutput', value)} options={[{ value: 'false', label: '不校验' }, { value: 'true', label: '校验工具声明的返回结构' }]} disabled={pending} /></div>
    {area('assertions', 'MCP 断言（JSON 数组）', 5)}<p className="text-xs text-muted-foreground">断言来源：structuredContent、text、isError、result；操作：equals、not_equals、contains、exists。路径示例：data.id。敏感参数可写为 {'{{token}}'}，运行时显式传值。</p>
    <details><summary className="cursor-pointer text-sm">查看断言示例</summary><CodeBlock value={[{ source: 'structuredContent', path: 'status', operator: 'equals', expected: 'paid' }]} /></details>{area('variables', '本次运行变量（JSON 对象）', 2)}
    {pretty(item?.mcp_request || {}).includes('••••') && <p className="text-sm text-destructive">此用例来自脱敏快照，请替换脱敏字段后再执行。</p>}
    <ErrorAlert error={error || servers.error} /><div className="flex flex-wrap gap-2"><Button type="submit">{pending ? '处理中…' : item?.id ? '保存修改' : '保存用例'}</Button><Button type="button" variant="outline" onClick={() => void submit('run')}>仅运行本次</Button><Button type="button" variant="ghost" onClick={onClose}>取消</Button></div>
  </fieldset></form>;
}

function ServerEditor({ server, onClose, onComplete, onSaved }: { server?: any; onClose: () => void; onComplete: () => void; onSaved: (server: any) => void | Promise<void> }) {
  const [name, setName] = useState(server?.name || '');
  const [url, setURL] = useState(server?.url || '');
  const [timeout, setTimeout] = useState(String(server?.timeout_seconds || 30));
  const [headers, setHeaders] = useState(pretty(server?.headers || {}));
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  useDirty(dirty);
  useEditorState(dirty, pending);
  async function submit() {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try {
      const value = { ...server, name: name.trim(), url, timeout_seconds: Number(timeout), headers: parseObject(headers, '请求头', true) };
      if (!value.name || !value.url || !Number.isInteger(value.timeout_seconds) || value.timeout_seconds < 1 || value.timeout_seconds > 300) throw new Error('请填写服务器名称、有效地址及 1 至 300 秒的超时');
      const saved = await json(server ? `/mcp-servers/${encodeURIComponent(server.id)}` : '/mcp-servers', value, server ? 'PUT' : 'POST');
      setDirty(false); await onSaved(saved); onComplete();
    } catch (failure) { setError(failure); } finally { lock.current = false; setPending(false); }
  }
  return <form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-4" onChange={() => setDirty(true)}><fieldset disabled={pending} className="space-y-4"><Field label="服务器名称"><Input aria-label="服务器名称" required maxLength={256} value={name} onChange={event => setName(event.target.value)} /></Field><Field label="Streamable HTTP 地址"><Input aria-label="Streamable HTTP 地址" type="url" required placeholder="http://127.0.0.1:8080/mcp" value={url} onChange={event => setURL(event.target.value)} /></Field><Field label="超时（秒）"><Input aria-label="超时（秒）" type="number" min={1} max={300} required value={timeout} onChange={event => setTimeout(event.target.value)} /></Field><Field label="认证请求头（JSON 对象）"><Textarea aria-label="认证请求头（JSON 对象）" rows={5} spellCheck={false} className="font-mono text-xs" value={headers} onChange={event => setHeaders(event.target.value)} /></Field><p className="text-xs text-muted-foreground">例如 {'{"Authorization":"Bearer ..."}'}。请求头在本机加密保存；编辑时保留 •••••• 表示沿用原值，移除对应字段可删除请求头。</p><ErrorAlert error={error} /><div className="flex gap-2"><Button type="submit">{pending ? '保存中…' : '保存连接'}</Button><Button type="button" variant="ghost" onClick={onClose}>取消</Button></div></fieldset></form>;
}

function ToolParameters({ tool, args, setArgs, disabled, onInvalid }: { tool: any; args: string; setArgs: (value: string) => void; disabled: boolean; onInvalid: (invalid: boolean) => void }) {
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, string>>({});
  let values: Record<string, any> = {};
  try { values = parseObject(args, '调用参数'); } catch { /* Preserve incomplete JSON while editing. */ }
  const [fieldError, setFieldError] = useState<unknown>(null);
  function update(key: string, property: any, text: string) {
    setFieldDrafts(previous => ({ ...previous, [key]: text }));
    try {
      const current = parseObject(args, '调用参数');
      if (!text) delete current[key]; else current[key] = parameterValue(property, text);
      setArgs(pretty(current)); setFieldError(null); onInvalid(false);
    } catch (error) { setFieldError(error); onInvalid(true); }
  }
  return <div className="space-y-4"><div className="grid gap-4 md:grid-cols-2">{Object.entries(tool.inputSchema?.properties || {}).map(([key, raw]) => {
    const property = raw as any;
    const required = (tool.inputSchema.required || []).includes(key);
    const label = `${key}${required ? ' *' : ''}`;
    const value = fieldDrafts[key] ?? (values[key] === undefined ? '' : typeof values[key] === 'string' ? values[key] : JSON.stringify(values[key]));
    if (property.enum || property.type === 'boolean') return <SelectField key={key} label={label} value={values[key] === undefined ? '' : JSON.stringify(values[key])} onValueChange={text => update(key, property, text)} options={[{ value: '', label: '未设置' }, ...(property.enum || [true, false]).map((item: any) => ({ value: JSON.stringify(item), label: String(item) }))]} disabled={disabled} />;
    const complex = ['object', 'array'].includes(property.type);
    return <Field key={key} label={label} description={property.description}>{complex ? <Textarea aria-label={label} value={value} disabled={disabled} spellCheck={false} onChange={event => update(key, property, event.target.value)} /> : <Input aria-label={label} value={value} disabled={disabled} type={['number', 'integer'].includes(property.type) ? 'number' : 'text'} step={property.type === 'integer' ? '1' : 'any'} onChange={event => update(key, property, event.target.value)} />}</Field>;
  })}</div><ErrorAlert error={fieldError} /><Field label="调用参数（JSON 对象）" description="JSON 为最终输入，可表达组合结构；编辑参数字段会同步更新 JSON。"><Textarea aria-label="调用参数（JSON 对象）" rows={8} value={args} onChange={event => { setArgs(event.target.value); setFieldDrafts({}); setFieldError(null); onInvalid(false); }} disabled={disabled} className="font-mono text-xs" spellCheck={false} /></Field></div>;
}

export default function MCPPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'history' ? 'history' : 'execute';
  const [serverID, setServerID] = useState('');
  const [query, setQuery] = useState('');
  const [discovery, setDiscovery] = useState<any>(null);
  const [toolName, setToolName] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [output, setOutput] = useState<any>(null);
  const [serverEditor, setServerEditor] = useState<{ server?: any } | null>(null);
  const [caseItem, setCaseItem] = useState<TestCase | null>(null);
  const [invalidFields, setInvalidFields] = useState(false);
  const lock = useRef(false);
  const generation = useRef(0);
  const queryClient = useQueryClient();
  const servers = useQuery<any[]>({ queryKey: ['mcp-servers'], queryFn: ({ signal }) => api('/mcp-servers', { signal }) });
  const matches = (servers.data || []).filter(server => `${server.name} ${server.url}`.toLowerCase().includes(query.toLowerCase()));
  const selected = matches.find(server => server.id === serverID) || matches[0];
  const tools: any[] = discovery && discovery.serverID === selected?.id ? discovery.tools || [] : [];
  const tool = tools.find(item => item.name === toolName) || tools[0];
  const draftKey = `${selected?.id}:${tool?.name}`;
  const args = drafts[draftKey] ?? pretty(schemaDefaults(tool?.inputSchema));
  useDirty(dirty);
  function clearTools() { generation.current++; setDiscovery(null); setToolName(''); setOutput(null); setError(null); setMessage(''); setInvalidFields(false); }
  async function changed() { clearTools(); await queryClient.invalidateQueries({ queryKey: ['mcp-servers'] }); }
  async function discover() {
    if (lock.current || !selected) return;
    lock.current = true; setPending(true); setError(null); setMessage('正在握手并获取工具列表…');
    const token = ++generation.current;
    try {
      const result = await json(`/mcp-servers/${encodeURIComponent(selected.id)}/discover`, undefined);
      if (token !== generation.current) return;
      setDiscovery({ ...result, serverID: selected.id }); setToolName(result.tools?.[0]?.name || ''); setMessage(`连接成功，发现 ${result.tools?.length || 0} 个工具。`);
    } catch (failure) { setDiscovery(null); setToolName(''); setMessage(''); setError(failure); }
    finally { lock.current = false; setPending(false); }
  }
  function caseDefinition() { if (invalidFields) throw new Error('请修正参数字段中的 JSON 格式，或直接编辑调用参数 JSON。'); return { type: 'mcp', name: tool.name, mcp_request: { server_id: selected.id, tool_name: tool.name, arguments: parseObject(args, '调用参数') }, assertions: [] }; }
  async function run() {
    if (lock.current || !tool || !selected) return;
    lock.current = true; setPending(true); setError(null); setMessage('');
    try {
      const out = await executeTest(caseDefinition()); setOutput(out);
      if (out.finishWarning) setError(out.finishWarning);
      await queryClient.invalidateQueries({ queryKey: ['tool-history', 'mcp'] });
    } catch (failure) { setError(failure); } finally { lock.current = false; setPending(false); }
  }
  return <div className="space-y-6"><PageHeader title="MCP 工具" description="通过 Streamable HTTP 连接服务器，发现工具并验证调用结果。" actions={<><Button onClick={() => setServerEditor({})} disabled={pending}>添加服务器</Button><ArchiveManager kind="mcp" onChanged={changed} /><BulkManager kind="mcp" onChanged={changed} /></>} />
    <Tabs value={tab} onValueChange={value => { const next = new URLSearchParams(params); next.set('tab', value); setParams(next, { replace: true }); }}><TabsList><TabsTrigger value="execute">工具调用</TabsTrigger><TabsTrigger value="history">执行记录</TabsTrigger></TabsList>
      <TabsContent value="execute" forceMount hidden={tab !== 'execute'} className="space-y-6"><Card><CardHeader><CardTitle>服务器连接</CardTitle></CardHeader><CardContent className="space-y-4"><div className="flex flex-wrap gap-3 items-end"><Field label="搜索服务器"><Input aria-label="搜索服务器" placeholder="服务器名称或地址" value={query} disabled={pending} onChange={event => { setQuery(event.target.value); clearTools(); }} /></Field><SelectField label="当前服务器" value={selected?.id || ''} onValueChange={value => { setServerID(value); clearTools(); }} options={[{ value: '', label: '请选择服务器' }, ...matches.map(server => ({ value: server.id, label: server.name }))]} disabled={pending} /><Button onClick={() => void discover()} disabled={pending || !selected}>{pending ? '处理中…' : '测试连接并获取工具'}</Button>{selected && <><Button variant="outline" onClick={() => setServerEditor({ server: selected })} disabled={pending}>编辑连接</Button><ResourceActions kind="mcp" id={selected.id} name={selected.name} onChanged={changed} /></>}</div><p className="text-sm text-muted-foreground break-all">{selected ? `${selected.url} · 超时 ${selected.timeout_seconds} 秒${discovery?.serverID === selected.id ? ` · 已连接 ${discovery.server_name} · ${tools.length} 个工具 · ${discovery.duration_ms} ms` : selected.discovered_at ? ` · 上次发现 ${new Date(selected.discovered_at).toLocaleString('zh-CN')}，请重新发现以确认工具有效` : ' · 尚未测试连接'}` : '添加并选择一个服务器开始测试。'}</p><ErrorAlert error={error || servers.error} />{message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}</CardContent></Card>
        <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)] items-start"><Card><CardHeader><CardTitle>工具 · {tools.length}</CardTitle></CardHeader><CardContent className="space-y-2">{tools.map(item => <Button key={item.name} variant={item.name === tool?.name ? 'secondary' : 'ghost'} className="w-full h-auto justify-start text-left whitespace-normal py-3" disabled={pending} aria-pressed={item.name === tool?.name} onClick={() => { setToolName(item.name); setOutput(null); setInvalidFields(false); }}><span className="min-w-0"><span className="block font-medium break-all">{item.name}</span><span className="block text-xs text-muted-foreground line-clamp-3">{item.description || '无说明'}</span></span></Button>)}{!tools.length && <EmptyState title="尚未获取工具" description="测试连接后，工具会显示在这里。" />}</CardContent></Card>
          <Card><CardHeader><CardTitle>{tool?.name || '工具调用'}</CardTitle><CardDescription>{tool?.description || '选择工具后可编辑参数、执行调用或保存测试用例。'}</CardDescription></CardHeader><CardContent className="space-y-5">{tool ? <><details><summary className="cursor-pointer text-sm">参数与返回结构</summary><CodeBlock value={{ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }} /></details><form className="space-y-4" onSubmit={event => { event.preventDefault(); void run(); }}><ToolParameters key={draftKey} tool={tool} args={args} setArgs={value => { setDrafts(previous => ({ ...previous, [draftKey]: value })); setDirty(true); }} disabled={pending} onInvalid={setInvalidFields} /><div className="flex gap-2"><Button type="submit" disabled={pending}>{pending ? '正在调用…' : '执行工具'}</Button><Button type="button" variant="outline" disabled={pending} onClick={() => { try { setCaseItem({ ...caseDefinition(), expected_is_error: false }); } catch (failure) { setError(failure); } }}>保存为测试用例</Button></div></form>{output && <ToolRunResult result={output.result} batchID={output.batchID} />}</> : <EmptyState title="请选择工具" />}</CardContent></Card>
        </div>
      </TabsContent><TabsContent value="history"><ToolExecutionHistory kind="mcp" /></TabsContent>
    </Tabs>
    <EditorDialog open={!!serverEditor} onOpenChange={open => !open && setServerEditor(null)} title={serverEditor?.server ? '编辑 MCP 服务器' : '添加 MCP 服务器'}>{(close, complete) => <ServerEditor key={serverEditor?.server?.id || 'new'} server={serverEditor?.server} onClose={close} onComplete={complete} onSaved={async saved => { setServerID(saved.id); await changed(); setMessage('连接已保存，可测试连接并获取工具。'); }} />}</EditorDialog>
    <MCPCaseEditor item={caseItem} open={!!caseItem} onOpenChange={open => !open && setCaseItem(null)} onSaved={async () => { setDirty(false); setMessage('用例已保存，可在“已保存用例”中重复运行。'); }} />
  </div>;
}
