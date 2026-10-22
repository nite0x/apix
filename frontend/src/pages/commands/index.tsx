import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, json } from '@/lib/api';
import { useDirty } from '@/lib/use-dirty';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Field, SelectField, ErrorAlert, PageHeader } from '@/components/shared';
import { commandDraft, executeTest, parseObject, pretty, readCommand, type CommandDraft, type TestCase } from './model';
import { ToolExecutionHistory, ToolRunResult } from './history';
import { EditorDialog, useEditorState } from './editor-dialog';

export function CommandFields({ draft, onChange, disabled = false }: { draft: CommandDraft; onChange: (draft: CommandDraft) => void; disabled?: boolean }) {
  const [check, setCheck] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const environments = useQuery<any>({ queryKey: ['execution-environments'], queryFn: ({ signal }) => api('/execution-environments', { signal }) });
  const update = (key: keyof CommandDraft, value: string) => onChange({ ...draft, [key]: value });
  const options = (environments.data?.items || [{ id: 'local', name: '本机' }]).map((item: any) => ({ value: item.id, label: item.name || item.id }));
  if (!options.some((item: any) => item.value === draft.environment)) options.push({ value: draft.environment, label: draft.environment });
  async function checkEnvironment() {
    if (checking) return;
    setChecking(true); setError(null);
    try { const result = await json('/execution-environments/check', { environment_id: draft.environment, program: draft.program, work_dir: draft.cwd, env: parseObject(draft.env, '环境变量', true) }); setCheck(result); update('environment', result.id); }
    catch (failure) { setError(failure); } finally { setChecking(false); }
  }
  const text = (key: keyof CommandDraft, label: string, props: Record<string, any> = {}) => <Field label={label}><Input aria-label={label} value={draft[key]} onChange={event => update(key, event.target.value)} disabled={disabled} {...props} /></Field>;
  const area = (key: keyof CommandDraft, label: string, rows = 3) => <Field label={label}><Textarea aria-label={label} value={draft[key]} onChange={event => update(key, event.target.value)} disabled={disabled} rows={rows} spellCheck={false} className="font-mono text-xs" /></Field>;
  return <div className="space-y-4">
    <div className="grid gap-4 md:grid-cols-2">{text('name', '测试名称', { required: true, maxLength: 512 })}{text('description', '说明')}</div>
    <div className="flex flex-wrap gap-3 items-end"><SelectField label="运行环境" value={draft.environment} onValueChange={value => update('environment', value)} options={options} disabled={disabled || checking} /><Button type="button" variant="outline" disabled={disabled || checking} onClick={() => void checkEnvironment()}>{checking ? '正在检查…' : '检查运行环境'}</Button></div>
    {check && <p role="status" className="text-sm text-muted-foreground">检查通过 · {check.program || check.work_dir}</p>}<ErrorAlert error={error || environments.error} />
    {text('program', '执行程序', { required: true, placeholder: 'bash、python3、node 或程序的绝对路径', spellCheck: false })}
    {text('cwd', '工作目录', { placeholder: '留空使用 Runtime 工作目录；填写时使用绝对路径', spellCheck: false })}
    {area('args', '启动参数（JSON 数组）')}
    <div className="grid gap-4 md:grid-cols-2">{text('timeout', '超时（秒）', { type: 'number', min: 1, max: 300, required: true })}{text('expected', '预期退出码', { type: 'number', min: 0, max: 2147483647, placeholder: '留空且无断言时标记为未验证' })}</div>
    {area('env', '环境变量（JSON 对象）')}{area('stdin', '标准输入 / 脚本正文', 5)}
    <p className="text-xs text-muted-foreground">脚本文件：参数填写脚本路径。内联脚本：bash 参数为 ["-s"]，python3 / node 参数为 ["-"]，在标准输入中填写代码。</p>
    {area('assertions', '输出断言（JSON 数组）', 4)}
    <p className="text-xs text-muted-foreground">stdout、stderr、exit_code 支持 equals、not_equals、contains、exists；JSON 输出支持点路径。敏感值建议写为 {'{{token}}'}，通过运行变量传入。</p>
    {area('variables', '运行变量（JSON 对象）', 2)}
    {pretty(draft).includes('••••') && <p className="text-sm text-destructive">此定义来自脱敏快照，请替换脱敏字段后再执行。</p>}
  </div>;
}

export interface CaseEditorProps { item?: TestCase | null; open: boolean; onOpenChange: (open: boolean) => void; onSaved?: (batchID?: string) => void | Promise<void>; batchID?: string }
export function CommandCaseEditor({ item, open, onOpenChange, onSaved, batchID }: CaseEditorProps) {
  return <EditorDialog open={open} onOpenChange={onOpenChange} title={item?.id ? '编辑命令行测试用例' : '新建命令行测试用例'}>{(close, complete) => <CommandEditorForm key={item?.id || 'new'} item={item || undefined} onClose={close} onComplete={complete} onSaved={onSaved} batchID={batchID} />}</EditorDialog>;
}
function CommandEditorForm({ item, onClose, onComplete, onSaved, batchID }: { item?: TestCase; onClose: () => void; onComplete: () => void; onSaved?: CaseEditorProps['onSaved']; batchID?: string }) {
  const [draft, setDraft] = useState(() => commandDraft(item));
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const lock = useRef(false);
  const queryClient = useQueryClient();
  useDirty(dirty);
  useEditorState(dirty, pending);
  async function submit(intent: 'save' | 'run') {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try {
      const input = readCommand(draft, item);
      let resultBatch: string | undefined;
      if (intent === 'run') resultBatch = (await executeTest(input.value, input.variables, batchID)).batchID;
      else await json(item?.id ? `/test-cases/${encodeURIComponent(item.id)}` : '/test-cases', input.value, item?.id ? 'PUT' : 'POST');
      setDirty(false); await queryClient.invalidateQueries(); await onSaved?.(resultBatch); onComplete();
    } catch (failure) { setError(failure); } finally { lock.current = false; setPending(false); }
  }
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit('save'); }}><fieldset disabled={pending} className="space-y-4"><CommandFields draft={draft} onChange={value => { setDraft(value); setDirty(true); }} disabled={pending} /><ErrorAlert error={error} /><div className="flex flex-wrap gap-2"><Button type="submit">{pending ? '处理中…' : item?.id ? '保存修改' : '保存用例'}</Button><Button type="button" variant="outline" onClick={() => void submit('run')}>仅运行本次</Button><Button type="button" variant="ghost" onClick={onClose}>取消</Button></div></fieldset></form>;
}

export default function CommandsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'history' ? 'history' : 'execute';
  const [draft, setDraft] = useState(() => commandDraft());
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [output, setOutput] = useState<any>(null);
  const lock = useRef(false);
  const queryClient = useQueryClient();
  const environment = useQuery<any>({ queryKey: ['command-environment'], queryFn: ({ signal }) => api('/commands/environment', { signal }) });
  useDirty(dirty);
  async function submit(intent: 'run' | 'save') {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(null); setMessage('');
    try {
      const input = readCommand(draft);
      if (intent === 'save') { await json('/test-cases', input.value); setMessage('用例已保存，可在“已保存用例”中重复运行。'); setDirty(false); }
      else { const out = await executeTest(input.value, input.variables); setOutput(out); if (out.finishWarning) setError(out.finishWarning); }
      await queryClient.invalidateQueries({ queryKey: ['tool-history', 'command'] });
    } catch (failure) { setError(failure); } finally { lock.current = false; setPending(false); }
  }
  return <div className="space-y-6"><PageHeader title="命令行" description="执行命令和脚本，验证退出码与输出，保存用例并追踪执行记录。" />
    <Tabs value={tab} onValueChange={value => { const next = new URLSearchParams(params); next.set('tab', value); setParams(next, { replace: true }); }}><TabsList><TabsTrigger value="execute">命令执行</TabsTrigger><TabsTrigger value="history">执行记录</TabsTrigger></TabsList>
      <TabsContent value="execute" forceMount hidden={tab !== 'execute'}><div className="grid gap-6 xl:grid-cols-2 items-start"><Card><CardHeader><CardTitle>执行命令或脚本</CardTitle><CardDescription>{environment.data ? `执行环境 ${environment.data.platform} · Runtime 工作目录 ${environment.data.work_dir} · 每个输出流最多保留 256 KB` : '正在读取执行环境…'}</CardDescription></CardHeader><CardContent><form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit('run'); }}><fieldset disabled={pending} className="space-y-4"><CommandFields draft={draft} onChange={value => { setDraft(value); setDirty(true); }} disabled={pending} /><ErrorAlert error={error || environment.error} />{message && <p role="status" className="text-sm text-emerald-700">{message}</p>}<div className="flex flex-wrap gap-2"><Button type="submit">{pending ? '处理中…' : '执行命令'}</Button><Button type="button" variant="outline" onClick={() => void submit('save')}>保存测试用例</Button><Button variant="ghost" asChild><Link to="/tests">已保存用例</Link></Button></div></fieldset></form></CardContent></Card><Card><CardHeader><CardTitle>本次执行结果</CardTitle></CardHeader><CardContent aria-busy={pending}><ToolRunResult result={output?.result} batchID={output?.batchID} /></CardContent></Card></div></TabsContent>
      <TabsContent value="history"><ToolExecutionHistory kind="command" /></TabsContent>
    </Tabs>
  </div>;
}
