import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CodeBlock, EmptyState, Field, SelectField } from '@/components/shared';
import { api, json } from '@/lib/api';
import { act, labels, Modal, OpenButton, paths, TaskError, useTask, type Changed, type Resource } from './common';

export function References(props: { kind: string; id: string }) {
  // The existing reference endpoint supports only executable dependencies and request provenance.
  return ['service', 'database', 'mcp', 'request'].includes(props.kind) ? <ResourceReferences {...props}/> : null;
}
function ResourceReferences({ kind, id }: { kind: string; id: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['references', kind, id], queryFn: () => api<Array<{ kind: string; id: string; name: string; step?: string; running?: boolean; archived?: boolean }>>(`/lifecycle/${kind}/${encodeURIComponent(id)}/references`), enabled: open });
  return <><OpenButton onClick={() => setOpen(true)}>引用与影响</OpenButton><Modal open={open} onOpenChange={setOpen} title="引用与影响" description="执行时依赖需要先处理；来源关联保留副本；历史记录独立保留。"><TaskError error={q.error}/>{q.isPending ? <p>正在读取引用…</p> : q.data?.length ? q.data.map((item, i) => <article key={`${item.id}-${i}`} className="rounded-md border p-3"><Link className="font-medium text-primary underline-offset-4 hover:underline" onClick={() => setOpen(false)} to={item.kind === 'flow' ? `/flows?id=${encodeURIComponent(item.id)}` : item.kind === 'test_case' ? `/tests?id=${encodeURIComponent(item.id)}` : item.kind === 'draft' ? '/requests' : `/execution-records?batch=${encodeURIComponent(item.id)}`}>{item.name}{item.step ? ` / ${item.step}` : ''}</Link><p className="mt-1 text-sm text-muted-foreground">{item.running ? '执行中：阻止修改、归档和删除' : item.archived ? '定义已归档：保留引用，恢复时检查' : kind === 'request' ? '来源关联：保留定义副本，不自动重写' : '有效定义引用：先替换依赖或归档引用方'}</p></article>) : <p>没有定义引用；操作时仍会重新检查运行占用。</p>}</Modal></>;
}

function Restore({ kind, item, onChanged }: { kind: string; item: Resource; onChanged: Changed }) {
  const [open, setOpen] = useState(false); const [name, setName] = useState(item.name); const [collection, setCollection] = useState('');
  const task = useTask();
  const groups = useQuery({ queryKey: ['restore-collections'], queryFn: () => api<Resource[]>('/collections'), enabled: open && kind === 'request' });
  return <><OpenButton onClick={() => { setName(item.name); setOpen(true); task.setError(null); }}>恢复</OpenButton><Modal open={open} onOpenChange={setOpen} title={`恢复${labels[kind] || kind}`} pending={task.pending}><Field label="恢复名称"><Input aria-label="恢复名称" value={name} onChange={e => setName(e.target.value)} /></Field>{kind === 'request' ? <SelectField label="恢复到分组" value={collection} onValueChange={setCollection} options={[{ value: '', label: '保留原分组（必须有效）' }, ...(groups.data || []).map(g => ({ value: g.id, label: g.name }))]} /> : null}<p className="text-sm text-muted-foreground">{kind === 'mcp' ? '将验证连接并重新发现工具。工具结构变化时，相关用例需要检查后重新保存。' : '恢复保留原 ID；名称冲突时请改名，或取消。'}</p><TaskError error={groups.error || task.error}/><Button disabled={task.pending || !name.trim() || (kind === 'request' && groups.isPending)} onClick={() => void task.run(async () => { await json(`${paths[kind]}/${encodeURIComponent(item.id)}/restore`, { name, ...(kind === 'request' ? { collection_id: collection } : {}) }); await onChanged(); setOpen(false); })}>{task.pending ? '恢复中…' : '确认恢复'}</Button></Modal></>;
}

export function ResourceActions({ kind, id, name, archived = false, onChanged = () => {} }: { kind: string; id: string; name: string; archived?: boolean; onChanged?: Changed }) {
  const [mode, setMode] = useState<'archive' | 'purge' | 'credentials' | null>(null); const [plan, setPlan] = useState<{token: string; historical_records_preserved?: number} | null>(null);
  const task = useTask();
  return <div className="flex flex-wrap items-center gap-2"><References kind={kind} id={id}/>{archived ? <Restore kind={kind} item={{ id, name }} onChanged={onChanged}/> : <OpenButton disabled={task.pending} onClick={() => { task.setError(null); setMode('archive'); }}>归档</OpenButton>}{kind !== 'collection' ? <OpenButton disabled={task.pending} onClick={() => void task.run(async () => { await act(kind, id, 'duplicate'); await onChanged(); })}>复制</OpenButton> : null}{archived ? <OpenButton disabled={task.pending} onClick={() => { setPlan(null); task.setError(null); setMode('purge'); void task.run(async () => setPlan(await json(`/lifecycle/${kind}/${encodeURIComponent(id)}/purge-preview`, {}))); }}>预览彻底删除</OpenButton> : null}{archived && kind === 'database' ? <OpenButton onClick={() => { task.setError(null); setMode('credentials'); }}>清除凭据</OpenButton> : null}<TaskError error={mode ? null : task.error}/><Modal open={mode !== null} onOpenChange={v => { if (!v) setMode(null); }} title={mode === 'purge' ? '彻底删除预览' : mode === 'credentials' ? '清除加密凭据' : `归档${labels[kind] || '资源'}`} pending={task.pending}><p>{mode === 'archive' ? `归档“${name}”后禁止新运行，已有历史保留，可以恢复。有效定义引用或运行占用会阻止操作。` : mode === 'credentials' ? `清除“${name}”的加密凭据？恢复后需要重新填写密码。` : plan ? `可彻底删除“${name}”配置，保留 ${plan.historical_records_preserved || 0} 条关联历史。此操作不可恢复，不会删除程序文件、远端服务或数据库。` : '正在检查引用、运行占用和清理范围…'}</p><TaskError error={task.error}/>{mode !== 'purge' || plan ? <Button variant={mode === 'purge' ? 'destructive' : 'default'} disabled={task.pending} onClick={() => void task.run(async () => { if (mode === 'credentials') await api(`${paths[kind]}/${encodeURIComponent(id)}/credentials`, { method: 'DELETE' }); else await act(kind, id, mode === 'purge' ? 'purge' : 'archive', mode === 'purge' ? { token: plan?.token } : {}); await onChanged(); setMode(null); })}>{mode === 'purge' ? '确认彻底删除' : mode === 'credentials' ? '确认清除凭据' : '确认归档'}</Button> : null}</Modal></div>;
}

export function ArchiveManager({ kind, onChanged = () => {} }: { kind: string; onChanged?: Changed }) {
  const [open, setOpen] = useState(false); const [search, setSearch] = useState(''); const [detail, setDetail] = useState<Resource | null>(null);
  const q = useQuery({ queryKey: ['archived', kind], queryFn: async () => {
    const items = await api<Resource[]>(`${paths[kind]}${kind === 'collection' ? '?status=archived' : kind === 'flow' ? '?include_archived=true' : '?archived=true'}`);
    return kind === 'flow' ? (items || []).filter(item => Boolean(item.archived_at)) : items || [];
  }, enabled: open });
  const changed = async () => { await q.refetch(); await onChanged(); };
  const items = (q.data || []).filter(item => JSON.stringify(item).toLowerCase().includes(search.toLowerCase()));
  return <><OpenButton onClick={() => setOpen(true)}>已归档{labels[kind]}</OpenButton><Modal open={open} onOpenChange={setOpen} title={`已归档${labels[kind]}`}><Input type="search" aria-label="搜索已归档资源" placeholder="搜索已归档资源" value={search} onChange={e => setSearch(e.target.value)}/><TaskError error={q.error}/>{q.isPending ? <p>正在读取…</p> : items.length ? items.map(item => <article key={item.id} className="space-y-3 rounded-md border p-3"><div className="flex items-center justify-between gap-3"><strong>{item.name}</strong><OpenButton onClick={() => setDetail(item)}>详情</OpenButton></div><p className="text-sm text-muted-foreground">{item.credentials_cleared ? '凭据已清除，恢复后需补填密码' : kind === 'request' && item.status === 'active' ? '所属分组已归档；恢复分组或移动到有效分组' : '配置和历史保留，可恢复原 ID'}</p><ResourceActions kind={kind} id={item.id} name={item.name} archived onChanged={changed}/></article>) : <EmptyState title="没有匹配的已归档资源"/>}</Modal><Modal open={detail !== null} onOpenChange={v => { if (!v) setDetail(null); }} title={detail?.name || '归档详情'}><CodeBlock value={detail}/></Modal></>;
}
