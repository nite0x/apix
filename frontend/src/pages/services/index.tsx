import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Play, Plus, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { ArchiveManager, BulkManager, References, ResourceActions } from '@/components/lifecycle';
import { CodeBlock, ConfirmDialog, EmptyState, ErrorAlert, Field, PageHeader, SelectField, StatusBadge } from '@/components/shared';
import { api, json } from '@/lib/api';
import { useActivity } from '@/lib/activity';
import { useDirty } from '@/lib/use-dirty';

export function environmentLabel(id = 'local'): string {
  if (id === 'local') return '本机';
  try { const [, distribution, user] = id.split(':'); return id.startsWith('wsl:') ? `WSL · ${decodeURIComponent(distribution)}${user ? ` · ${decodeURIComponent(user)}` : ''}` : id; } catch { return id; }
}
const schema = z.object({
  name: z.string().trim().min(1, '请填写服务名称'), command: z.string().trim().min(1, '请填写启动程序'), work_dir: z.string().trim().min(1, '请填写工作目录'),
  args: z.string(), env: z.string(), health_url: z.url('请输入完整的健康检查地址').refine(v => /^https?:\/\//.test(v), '健康检查仅支持 HTTP 或 HTTPS'),
  timeout: z.number().int().min(1, '超时至少 1 秒').max(300, '超时最多 300 秒'), environment_id: z.string(), user: z.string(),
});
type Form = z.infer<typeof schema>;
const defaults: Form = { name: '', command: '', work_dir: '', args: '', env: '{}', health_url: 'http://127.0.0.1:8080/health', timeout: 30, environment_id: 'local', user: '' };
function parseEnv(text: string): Record<string, string> { const value = JSON.parse(text || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(v => typeof v !== 'string')) throw new Error('环境变量需要是值为字符串的 JSON 对象。'); return value; }
function withUser(id: string, user: string) { return id.startsWith('wsl:') ? `wsl:${id.split(':')[1]}:${encodeURIComponent(user.trim())}` : id; }

export function ServiceEditor({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void | Promise<unknown> }) {
  const editing = id !== null; const draftID = useRef(id || crypto.randomUUID()); const version = useRef(0); const savedSignature = useRef(''); const hydrated = useRef(false); const lock = useRef(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [pending, setPending] = useState(false); const [error, setError] = useState<unknown>(); const [checkResult, setCheckResult] = useState('');
  const form = useForm<Form>({ resolver: zodResolver(schema), defaultValues: defaults });
  useDirty(form.formState.isDirty);
  const detail = useQuery({ queryKey: ['service-edit', id], queryFn: ({ signal }) => api(`/services/${encodeURIComponent(id!)}`, { signal }), enabled: editing, staleTime: 0, refetchOnWindowFocus: false });
  const environments = useQuery({ queryKey: ['execution-environments'], queryFn: ({ signal }) => api('/execution-environments', { signal }) });
  useEffect(() => {
    if (!detail.data || hydrated.current) return;
    hydrated.current = true; const d = detail.data.definition; version.current = d.edit_version || 0;
    form.reset({ name: d.name, command: d.command, work_dir: d.work_dir, args: (d.args || []).join('\n'), env: JSON.stringify(d.env || {}, null, 2), health_url: d.health_url, timeout: d.startup_timeout_ms / 1000, environment_id: d.environment_id || 'local', user: decodeURIComponent((d.environment_id || '').split(':')[2] || '') });
  }, [detail.data, form]);
  const selectedEnvironment = form.watch('environment_id');
  const items: { id: string; name: string }[] = [...(environments.data?.items || [{ id: 'local', name: '本机' }])];
  if (!items.some(item => item.id === selectedEnvironment)) items.push({ id: selectedEnvironment, name: environmentLabel(selectedEnvironment) });
  const loading = editing && detail.isPending;
  async function save(values: Form, start: boolean) {
    if (lock.current) return; lock.current = true; setPending(true); setError(null);
    try {
      const definition = { id: draftID.current, edit_version: version.current, name: values.name, command: values.command, work_dir: values.work_dir, args: values.args.split(/\r?\n/).filter(line => line.trim()), env: parseEnv(values.env), health_url: values.health_url, startup_timeout_ms: values.timeout * 1000, environment_id: withUser(values.environment_id, values.user) };
      const signature = JSON.stringify({ ...definition, edit_version: 0 });
      if (signature !== savedSignature.current) { const saved = await json('/services', definition, 'PUT'); version.current = saved.edit_version || 0; savedSignature.current = signature; await onChanged(); }
      if (start) await json(`/services/${encodeURIComponent(draftID.current)}/start`, { owner: 'manual' });
      form.reset(values); onClose();
    } catch (e) { setError(start && savedSignature.current ? new Error(`配置已保存，启动未完成：${e instanceof Error ? e.message : String(e)}。请检查状态和日志后重试。`) : e); } finally { lock.current = false; setPending(false); await onChanged(); }
  }
  function close() { if (pending) return; if (form.formState.isDirty) setDiscardOpen(true); else onClose(); }
  async function check() {
    if (lock.current) return; lock.current = true; setPending(true); setError(null); setCheckResult('');
    try { const values = form.getValues(); const result = await json('/execution-environments/check', { environment_id: withUser(values.environment_id, values.user), program: values.command.trim(), work_dir: values.work_dir.trim(), env: parseEnv(values.env) }); if (result.id) { form.setValue('environment_id', result.id, { shouldDirty: true }); form.setValue('user', decodeURIComponent(result.id.split(':')[2] || ''), { shouldDirty: true }); } setCheckResult(`检查通过 · ${result.name} · ${result.program || result.work_dir || ''}`); await environments.refetch(); } catch (e) { setError(e); } finally { lock.current = false; setPending(false); }
  }
  return <><ConfirmDialog open={discardOpen} onOpenChange={setDiscardOpen} title="放弃服务配置？" description="未保存的修改将丢失。" onConfirm={onClose} /><Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="sm:max-w-2xl" showCloseButton={!pending}><DialogHeader><DialogTitle>{editing ? '编辑服务' : '新增服务'}</DialogTitle><DialogDescription>配置启动程序和健康检查；保存配置与启动服务分别执行。</DialogDescription></DialogHeader><ErrorAlert error={detail.error || error} />{loading ? <Skeleton className="h-64" /> : <form onSubmit={form.handleSubmit(values => save(values, false))} className="space-y-4" aria-busy={pending}><fieldset disabled={pending || (editing && !detail.data)} className="space-y-4"><div className="form-grid"><Field label="服务名称"><Input aria-label="服务名称" {...form.register('name')} /></Field><SelectField label="运行环境" value={selectedEnvironment} onValueChange={value => { form.setValue('environment_id', value, { shouldDirty: true }); form.setValue('user', decodeURIComponent(value.split(':')[2] || ''), { shouldDirty: true }); setCheckResult(''); }} options={items.map(item => ({value: item.id, label: item.name}))} /></div>{selectedEnvironment.startsWith('wsl:') && <Field label="WSL 用户"><Input {...form.register('user')} /></Field>}<Field label="工作目录"><Input aria-label="工作目录" {...form.register('work_dir')} /></Field><Field label="启动程序"><Input aria-label="启动程序" {...form.register('command')} /></Field><div className="form-grid"><Field label="启动参数" description="每行一个参数，保留原始顺序。"><Textarea aria-label="启动参数" rows={4} {...form.register('args')} /></Field><Field label="环境变量" description="JSON 对象，值必须是字符串。"><Textarea aria-label="环境变量" rows={4} spellCheck={false} {...form.register('env')} /></Field></div><div className="form-grid"><Field label="健康检查地址"><Input aria-label="健康检查地址" {...form.register('health_url')} /></Field><Field label="启动超时（秒）"><Input type="number" min={1} max={300} {...form.register('timeout', { valueAsNumber: true })} /></Field></div><Button type="button" variant="outline" onClick={() => void check()}>检查运行环境</Button>{checkResult && <p role="status" className="text-primary">{checkResult}</p>}{Object.entries(form.formState.errors).map(([name, issue]) => <p role="alert" key={name} className="text-destructive">{issue.message}</p>)}</fieldset><DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={close}>取消</Button><Button type="submit" disabled={pending || (editing && !detail.data)}>{pending ? '处理中…' : editing ? '保存修改' : '仅保存'}</Button>{!editing && <Button type="button" disabled={pending} onClick={form.handleSubmit(values => save(values, true))}>保存并启动</Button>}</DialogFooter></form>}</DialogContent></Dialog></>;
}

function ServiceDetail({ id, onClose }: {id: string; onClose: () => void}) {
  const q = useQuery({ queryKey: ['service-detail', id], queryFn: ({ signal }) => api(`/services/${encodeURIComponent(id)}`, { signal }), refetchInterval: 3000 });
  const d = q.data?.definition; const instance = q.data?.instance; const health = q.data?.health;
  return <Dialog open onOpenChange={value => { if (!value) onClose(); }}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>{d?.name || '服务详情'}</DialogTitle><DialogDescription>运行状态、启动配置及最近 100 条日志。</DialogDescription></DialogHeader><ErrorAlert error={q.error} />{d ? <div className="stack"><div className="toolbar"><StatusBadge status={instance.status} /><span>{environmentLabel(d.environment_id)}</span><Button size="sm" variant="outline" onClick={() => void q.refetch()}>刷新详情</Button></div><dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">{[['服务 ID', d.id], ['健康地址', d.health_url], ['PID', instance.pid || '—'], ['归属', instance.owner || '尚未启动'], ['健康检查', health?.healthy ? '通过' : health?.error || '未通过'], ['检查时间', health?.checked_at ? new Date(health.checked_at).toLocaleString('zh-CN') : '—'], ['启动程序', d.command], ['工作目录', d.work_dir], ['启动超时', `${d.startup_timeout_ms} ms`]].map(([label,value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-all">{value}</dd></div>)}</dl>{instance.owner === 'external' && <p className="text-sm text-muted-foreground">服务由外部进程管理，Apix 只复用该实例；请在原启动位置停止。</p>}<ErrorAlert error={instance.environment_error} /><h3 className="font-medium">启动参数</h3><CodeBlock value={d.args} /><h3 className="font-medium">最近日志</h3><CodeBlock value={q.data.logs?.map((line: any) => `${new Date(line.time).toLocaleString('zh-CN')} [${line.stream}] ${line.message}`).join('\n') || '暂无日志'} /><Button asChild variant="outline"><Link to={`/logs?source=${encodeURIComponent(id)}`}>查看全部服务日志</Link></Button></div> : <Skeleton className="h-64" />}</DialogContent></Dialog>;
}

export default function ServicesPage() {
  const activity = useActivity(); const client = useQueryClient(); const [search, setSearch] = useState(''); const [status, setStatus] = useState(''); const [owner, setOwner] = useState(''); const [environment, setEnvironment] = useState('');
  const [editor, setEditor] = useState<{id: string | null} | null>(null); const [detail, setDetail] = useState<string | null>(null); const [pending, setPending] = useState<Set<string>>(() => new Set()); const locks = useRef(new Set<string>()); const [error, setError] = useState<unknown>(); const [message,setMessage] = useState('');
  const changed = async () => { await client.invalidateQueries({ queryKey: ['activity'] }); };
  const services: any[] = activity.data?.services || [];
  const filtered = services.filter(item => (!search || `${item.name} ${item.command} ${item.health_url}`.toLowerCase().includes(search.toLowerCase())) && (!status || item.status === status) && (!environment || (item.environment_id || 'local') === environment) && (!owner || (owner === 'flow' ? item.owner && !['manual','external'].includes(item.owner) : item.owner === owner)));
  async function control(service: any, action: string) {
    if (locks.current.has(service.id)) return; locks.current.add(service.id); setPending(new Set(locks.current)); setError(null); setMessage('');
    try { const result = await json(`/services/${encodeURIComponent(service.id)}/${action}`, { owner: 'manual' }); setMessage(action === 'start' ? result.started ? '服务已启动' : '已定位并复用正在运行的服务' : result.status === 'running' ? '已保留复用服务，由原启动方管理' : '服务已停止'); } catch (e) { setError(e); } finally { locks.current.delete(service.id); setPending(new Set(locks.current)); await changed(); }
  }
  return <div className="stack"><PageHeader title="服务" description="管理本地服务配置，手动启停，查看状态和运行日志。" actions={<><ArchiveManager kind="service" onChanged={changed} /><BulkManager kind="service" onChanged={changed} /><Button onClick={() => setEditor({ id: null })}><Plus />新增服务</Button></>} /><div className="panel toolbar"><Field label="搜索服务"><Input type="search" placeholder="名称、启动程序或健康地址" value={search} onChange={e => setSearch(e.target.value)} /></Field><SelectField label="运行状态" value={status} onValueChange={setStatus} options={[{value:'',label:'全部状态'},...['running','stopped','failed','starting','stopping','cleanup_failed'].map(value=>({value,label:({running:'运行中',stopped:'已停止',failed:'异常',starting:'启动中',stopping:'停止中',cleanup_failed:'清理失败'} as Record<string,string>)[value]}))]} /><SelectField label="服务归属" value={owner} onValueChange={setOwner} options={[{value:'',label:'全部归属'},{value:'manual',label:'手动启动'},{value:'external',label:'外部复用'},{value:'flow',label:'流程使用'}]} /><SelectField label="运行环境" value={environment} onValueChange={setEnvironment} options={[{value:'',label:'全部运行环境'},...Array.from(new Set<string>(services.map(s=>s.environment_id||'local'))).map(value=>({value,label:environmentLabel(value)}))]} /></div><ErrorAlert error={activity.error || error} />{message && <p role="status" className="text-primary">{message}</p>}{activity.isPending ? <Skeleton className="h-48" /> : !filtered.length ? <EmptyState title={services.length ? '没有匹配的服务' : '还没有配置服务'} description="新增启动配置后，可保存或启动服务。" /> : <div className="grid gap-3 xl:grid-cols-2">{filtered.map(service => {
    const busy = pending.has(service.id); const external = service.owner === 'external'; const transitioning = ['starting','stopping'].includes(service.status); const flowOwned = service.owner && !['manual','external'].includes(service.owner) && ['running','starting','stopping','cleanup_failed'].includes(service.status); const locked = busy || (!external && ['running','starting','stopping','cleanup_failed'].includes(service.status)); const stop = ['running','cleanup_failed'].includes(service.status);
    return <Card key={service.id} className="gap-3 py-4"><CardHeader className="px-4"><div className="flex items-center justify-between gap-3"><CardTitle className="min-w-0 truncate text-base">{service.name}</CardTitle><StatusBadge status={service.status} /></div><p className="break-all text-xs text-muted-foreground">{service.health_url}</p></CardHeader><CardContent className="space-y-3 px-4"><p className="text-xs text-muted-foreground">{environmentLabel(service.environment_id)} · {external ? '外部复用' : service.owner === 'manual' ? '手动启动' : service.owner ? '流程管理' : '尚未启动'}{service.pid ? ` · PID ${service.pid}` : ''}</p><ErrorAlert error={service.environment_error} /><div className="toolbar"><Button size="sm" variant="outline" onClick={() => setDetail(service.id)}>查看详情</Button><Button size="sm" variant="outline" asChild><Link to={`/logs?source=${encodeURIComponent(service.id)}`}>日志</Link></Button><Button size="sm" variant="outline" disabled={locked} onClick={() => setEditor({id:service.id})}>编辑</Button><Button size="sm" disabled={busy || transitioning || flowOwned || external} onClick={() => void control(service, stop ? 'stop' : 'start')}>{stop ? <Square /> : <Play />}{busy ? '处理中…' : external ? '外部运行中' : flowOwned ? '流程管理中' : stop ? '停止' : '启动'}</Button></div>{locked ? <References kind="service" id={service.id} /> : <ResourceActions kind="service" id={service.id} name={service.name} onChanged={changed} />}</CardContent></Card>;
  })}</div>}{editor && <ServiceEditor key={editor.id || 'new'} id={editor.id} onClose={() => setEditor(null)} onChanged={changed} />}{detail && <ServiceDetail id={detail} onClose={() => setDetail(null)} />}</div>;
}
