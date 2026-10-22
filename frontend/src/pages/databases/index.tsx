import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { api, json } from '@/lib/api';
import { useDirty } from '@/lib/use-dirty';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog, EmptyState, ErrorAlert, Field, PageHeader, SelectField, StatusBadge } from '@/components/shared';
import { ArchiveManager, BulkManager, ResourceActions } from '@/components/lifecycle';
import { blankSQL, databaseError, driverLabels, driverPorts, executionURL, sqlPayload, type DatabaseConnection, type Driver, type SQLDraft, type SQLExecution, type SQLResult } from './model';
import { SQLExecutionDetail, SQLResultTable } from './results';

export { SQLExecutionDetail, SQLResultTable } from './results';

const drivers = Object.entries(driverLabels).map(([value, label]) => ({ value, label }));
const connectionSchema = z.object({
  name: z.string().trim().min(1, '请填写连接名称。'),
  host: z.string().trim().min(1, '请填写主机。'),
  database: z.string().trim().min(1, '请填写数据库名。'),
  username: z.string().trim().min(1, '请填写用户名。'),
  port: z.coerce.number().int().min(1).max(65535),
  type: z.enum(['mysql', 'postgresql', 'hologres']),
  ssl_mode: z.string(),
  password: z.string(),
});

interface ConnectionForm {
  name: string; host: string; database: string; username: string; port: string; type: Driver; ssl_mode: string; password: string;
}

function ConnectionEditor({ connection, onClose, onSaved, onDirtyChange }: {
  connection: DatabaseConnection | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [id] = useState(() => connection?.id ?? crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const { register, watch, getValues, setValue, handleSubmit, formState: { isDirty } } = useForm<ConnectionForm>({ defaultValues: {
    name: connection?.name ?? '', host: connection?.host ?? '', database: connection?.database ?? '',
    username: connection?.username ?? '', port: String(connection?.port ?? 3306), type: connection?.type ?? 'mysql',
    ssl_mode: connection?.ssl_mode ?? 'prefer', password: '',
  } });
  const type = watch('type');
  useEffect(() => { onDirtyChange(isDirty); return () => onDirtyChange(false); }, [isDirty, onDirtyChange]);
  const close = () => { if (!busyRef.current) { if (isDirty) setConfirmClose(true); else onClose(); } };
  const save = handleSubmit(async values => {
    if (busyRef.current) return;
    const parsed = connectionSchema.safeParse(values);
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.path.includes('port') ? '端口范围为 1–65535。' : issue.message).join(' ')); return; }
    const { password, ssl_mode, ...settings } = parsed.data;
    const input = {
      ...settings, id, edit_version: connection?.edit_version ?? 0,
      ...(type === 'mysql' ? {} : { ssl_mode }),
      ...(!connection || connection.credentials_cleared || password !== '' ? { password } : {}),
    };
    busyRef.current = true; setBusy(true); setError(null);
    try { await json('/database/connections', input, 'PUT'); await onSaved(); onClose(); }
    catch (cause) { setError(databaseError(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  });
  return <>
    <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{connection ? '编辑数据库连接' : '新增数据库连接'}</DialogTitle><DialogDescription>连接密码在本机加密保存。保存配置不会修改远端数据库。</DialogDescription></DialogHeader>
      <form onSubmit={save} className="space-y-4" aria-busy={busy}>
        <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
          <Field label="连接名称"><Input aria-label="连接名称" {...register('name')} /></Field>
          <SelectField label="数据库类型" value={type} onValueChange={value => {
            const currentPort = getValues('port');
            if (!currentPort || Number(currentPort) === driverPorts[type]) setValue('port', String(driverPorts[value as Driver]), { shouldDirty: true });
            setValue('type', value as Driver, { shouldDirty: true });
          }} options={drivers} />
          <Field label="主机"><Input aria-label="主机" placeholder="127.0.0.1" autoComplete="off" {...register('host')} /></Field>
          <Field label="端口"><Input aria-label="端口" type="number" min={1} max={65535} {...register('port')} /></Field>
          <Field label="数据库名"><Input aria-label="数据库名" {...register('database')} /></Field>
          <Field label="用户名"><Input aria-label="用户名" autoComplete="off" {...register('username')} /></Field>
          <Field label="密码" description={connection && !connection.credentials_cleared ? '留空保留原密码；填写新密码则更新。' : '数据库密码允许为空。'}><Input aria-label="密码" type="password" autoComplete="new-password" placeholder={connection && !connection.credentials_cleared ? '留空保留原密码' : '数据库密码（允许为空）'} {...register('password')} /></Field>
          {type !== 'mysql' && <SelectField label="SSL 模式" value={watch('ssl_mode')} onValueChange={value => setValue('ssl_mode', value, { shouldDirty: true })} options={['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].map(value => ({ value, label: value }))} />}
        </fieldset>
        <p className="text-xs text-muted-foreground">{type === 'mysql' ? '默认端口 3306，SQL 使用 ? 绑定参数。' : `${type === 'hologres' ? '使用 PostgreSQL 协议，默认端口 80；VPC 地址需要本机网络可达。' : '默认端口 5432。'}SQL 使用 $1、$2 绑定参数。`}</p>
        <ErrorAlert error={error} />
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={close}>取消</Button><Button type="submit" disabled={busy}>{busy ? '保存中…' : '保存连接'}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
    <ConfirmDialog open={confirmClose} onOpenChange={setConfirmClose} title="放弃连接修改？" description="尚未保存的连接配置会丢失。" onConfirm={onClose} />
  </>;
}

function ConnectionCard({ connection, running, execute, refresh, onDirtyChange }: {
  connection: DatabaseConnection; running: boolean; execute: () => void; refresh: () => Promise<void>; onDirtyChange: (dirty: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false), [testing, setTesting] = useState(false), [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null), [editing, setEditing] = useState(false);
  const testingRef = useRef(false);
  const test = async () => {
    if (testingRef.current) return;
    testingRef.current = true; setTesting(true); setError(null); setMessage('');
    try { await api(`/database/connections/${encodeURIComponent(connection.id)}/test`, { method: 'POST' }); setMessage(`连接成功 · ${new Date().toLocaleTimeString('zh-CN')}`); }
    catch (cause) { setError(databaseError(cause)); }
    finally { testingRef.current = false; setTesting(false); }
  };
  const address = connection.host ? `${connection.host.includes(':') ? `[${connection.host}]` : connection.host}:${connection.port}` : '旧配置待重新填写';
  return <Card>
    <CardContent className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0"><div className="flex items-center gap-2"><h3 className="font-medium">{connection.name}</h3><Badge variant="secondary">{driverLabels[connection.type] ?? connection.type}</Badge></div><p className="mt-1 break-all text-sm text-muted-foreground">{connection.database || '待配置'} · {address}</p></div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={running} onClick={execute} aria-label={`使用 ${connection.name} 执行 SQL`}>执行 SQL</Button>
          <Button size="sm" variant="outline" disabled={testing} onClick={() => void test()} aria-label={`测试 ${connection.name} 的连接`}>{testing ? '测试中…' : '测试连接'}</Button>
          <Button size="sm" variant="outline" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls={`database-details-${connection.id}`}>{expanded ? '收起' : '详情'}</Button>
          <Button size="sm" variant="outline" disabled={testing} onClick={() => setEditing(true)} aria-label={`编辑 ${connection.name} 的连接配置`}>编辑</Button>
          <ResourceActions kind="database" id={connection.id} name={connection.name} onChanged={refresh} />
        </div>
      </div>
      {expanded && <dl id={`database-details-${connection.id}`} className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-md bg-muted p-3 text-sm">
        <dt>连接 ID</dt><dd className="break-all font-mono">{connection.id}</dd><dt>主机</dt><dd className="break-all">{address}</dd><dt>数据库</dt><dd>{connection.database || '待配置'}</dd><dt>用户名</dt><dd>{connection.username || '待配置'}</dd>{connection.ssl_mode && <><dt>SSL</dt><dd>{connection.ssl_mode}</dd></>}
      </dl>}
      {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}<ErrorAlert error={error} />
    </CardContent>
    {editing && <ConnectionEditor connection={connection} onClose={() => setEditing(false)} onSaved={refresh} onDirtyChange={onDirtyChange} />}
  </Card>;
}

export default function DatabasesPage() {
  const queryClient = useQueryClient();
  const connectionsQuery = useQuery({ queryKey: ['database-connections'], queryFn: ({ signal }) => api<DatabaseConnection[]>('/database/connections', { signal }), refetchInterval: 10000 });
  const historyQuery = useQuery({ queryKey: ['database-executions'], queryFn: ({ signal }) => api<SQLExecution[]>('/database/executions', { signal }), refetchInterval: 3000 });
  const connections = connectionsQuery.data ?? [], history = historyQuery.data ?? [];
  const [tab, setTab] = useState('sql');
  const [newConnection, setNewConnection] = useState(false), [editorDirty, setEditorDirty] = useState(false);
  const [search, setSearch] = useState(''), [driver, setDriver] = useState('');
  const [historySearch, setHistorySearch] = useState(''), [historyConnection, setHistoryConnection] = useState('');
  const [draft, setDraft] = useState<SQLDraft>({ ...blankSQL });
  const [cleanDraft, setCleanDraft] = useState(JSON.stringify(blankSQL));
  const [running, setRunning] = useState(false), [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<SQLResult | undefined>(), [resultMode, setResultMode] = useState<'query' | 'exec'>('query');
  const [resultVersion, setResultVersion] = useState(0);
  const [notice, setNotice] = useState(''), [inspection, setInspection] = useState<SQLExecution | null>(null);
  const runningRef = useRef(false);
  useDirty(editorDirty || JSON.stringify(draft) !== cleanDraft);
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: ['database-connections'] }); };
  const selected = connections.find(item => item.id === draft.connection_id);
  const historyNames = new Map(history.map(item => [item.connection_id, item.connection_name]));
  for (const connection of connections) historyNames.set(connection.id, connection.name);
  const visibleConnections = connections.filter(item => (!driver || item.type === driver) && `${item.name} ${item.type} ${item.host ?? ''} ${item.database ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const visibleHistory = history.filter(item => (!historyConnection || item.connection_id === historyConnection) && `${item.sql} ${item.connection_name} ${item.error ?? ''}`.toLowerCase().includes(historySearch.toLowerCase()));
  const patch = (change: Partial<SQLDraft>) => setDraft(current => ({ ...current, ...change }));
  const fill = (item: SQLExecution) => {
    if (runningRef.current) return;
    setDraft({ ...blankSQL, connection_id: connections.some(connection => connection.id === item.connection_id) ? item.connection_id : '', mode: item.mode, sql: item.sql, params: item.params?.length ? JSON.stringify(item.params, null, 2) : '' });
    setResult(undefined); setError(null); setTab('sql');
    setNotice(connections.some(connection => connection.id === item.connection_id) ? '已填入历史 SQL，可修改后执行。' : '已填入历史 SQL，原连接已归档或删除，请明确选择有效连接后重新执行。');
  };
  const execute = async (event: React.FormEvent) => {
    event.preventDefault();
    if (runningRef.current) return;
    let payload: ReturnType<typeof sqlPayload>;
    try { payload = sqlPayload(draft, connections); }
    catch (cause) { setError(databaseError(cause)); return; }
    runningRef.current = true; setRunning(true); setError(null); setResult(undefined); setNotice('SQL 正在执行，请等待结果…');
    setResultMode(payload.mode);
    try {
      const value = await json<SQLResult>('/database/execute', payload);
      setResult(value); setResultVersion(version => version + 1); setCleanDraft(JSON.stringify(draft)); setNotice('SQL 执行完成，可在下方查看本次结果，或从执行记录回看。');
    } catch (cause) { setError(databaseError(cause)); setNotice('SQL 执行失败，请查看错误信息。'); }
    finally { runningRef.current = false; setRunning(false); void queryClient.invalidateQueries({ queryKey: ['database-executions'] }); }
  };
  return <div className="space-y-5">
    <PageHeader title="数据库" description="管理 MySQL、PostgreSQL 和 Hologres 连接，手动执行 SQL 并查看历史结果。" actions={<Button variant="outline" onClick={() => { void connectionsQuery.refetch(); void historyQuery.refetch(); }}>刷新</Button>} />
    <ErrorAlert error={connectionsQuery.error ? databaseError(connectionsQuery.error) : null} />
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList><TabsTrigger value="connections">连接管理</TabsTrigger><TabsTrigger value="sql">SQL 执行</TabsTrigger><TabsTrigger value="history">执行记录</TabsTrigger></TabsList>
      <TabsContent value="connections" className="space-y-4">
        <div className="flex flex-wrap items-center gap-3"><Input className="max-w-sm" type="search" aria-label="搜索数据库连接" placeholder="名称、类型、主机或库名" value={search} onChange={event => setSearch(event.target.value)} /><SelectField value={driver} onValueChange={setDriver} label="筛选数据库类型" options={[{ value: '', label: '全部类型' }, ...drivers]} /><div className="ml-auto flex flex-wrap gap-2"><ArchiveManager kind="database" onChanged={refresh} /><BulkManager kind="database" onChanged={refresh} /><Button onClick={() => setNewConnection(true)}>新增连接</Button></div></div>
        <p className="text-xs text-muted-foreground">{connections.length} 个连接</p>
        {connectionsQuery.isPending ? <p role="status">正在读取数据库连接…</p> : visibleConnections.length ? visibleConnections.map(connection => <ConnectionCard key={connection.id} connection={connection} running={running} execute={() => { patch({ connection_id: connection.id }); setTab('sql'); }} refresh={refresh} onDirtyChange={setEditorDirty} />) : <EmptyState title={connections.length ? '没有匹配的数据库连接' : '还没有数据库连接'} description="新增 MySQL、PostgreSQL 或 Hologres 连接，保存后即可测试连通性。" />}
      </TabsContent>
      <TabsContent value="sql" className="space-y-4">
        <Card><CardHeader><CardTitle>手动执行 SQL</CardTitle></CardHeader><CardContent>
          <form className="space-y-4" onSubmit={event => void execute(event)} aria-busy={running}>
            <fieldset disabled={running} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2"><SelectField label="数据库连接" value={draft.connection_id} onValueChange={connection_id => patch({ connection_id })} options={[{ value: '', label: connections.length ? '请选择数据库连接' : '暂无连接，请先新增' }, ...connections.map(connection => ({ value: connection.id, label: `${connection.name} · ${driverLabels[connection.type]}` }))]} /><SelectField label="执行模式" value={draft.mode} onValueChange={mode => patch({ mode: mode as SQLDraft['mode'] })} options={[{ value: 'query', label: '查询（返回结果）' }, { value: 'exec', label: '执行（写入或结构变更）' }]} /></div>
              <p className="text-xs text-muted-foreground">{selected ? `${selected.name} · ${selected.database ?? '未配置库名'} · ${selected.type === 'mysql' ? '使用 ? 绑定参数。' : '使用 $1、$2 绑定参数。'}` : '请选择有效连接；没有连接时可前往“连接管理”新增。'}</p>
              <Field label="SQL 语句"><Textarea className="min-h-40 font-mono" aria-label="SQL 语句" value={draft.sql} onChange={event => patch({ sql: event.target.value })} spellCheck={false} placeholder="SELECT * FROM example WHERE id = ?" /></Field>
              <Field label="绑定参数（JSON 数组）" description="保留字符串、数字、布尔值和 null 的类型。使用参数绑定，不要把不可信输入拼接到 SQL。"><Textarea className="min-h-20 font-mono" aria-label="绑定参数（JSON 数组）" value={draft.params} onChange={event => patch({ params: event.target.value })} spellCheck={false} placeholder={'["example", 123, null, false]'} /></Field>
              <div className="grid gap-4 sm:grid-cols-2"><Field label="超时（秒）"><Input type="number" min={1} max={300} aria-label="超时（秒）" value={draft.timeout} onChange={event => patch({ timeout: event.target.value })} /></Field><Field label="最多返回行数"><Input type="number" min={1} max={10000} disabled={draft.mode === 'exec'} aria-label="最多返回行数" value={draft.maxRows} onChange={event => patch({ maxRows: event.target.value })} /></Field></div>
              <p className="text-xs text-muted-foreground">{draft.mode === 'exec' ? '写入与结构变更会直接提交，执行后显示影响行数。' : '查询结果以表格展示，执行记录自动保存。'}</p>
            </fieldset>
            <div className="flex flex-wrap gap-2"><Button type="submit" disabled={running || !selected}>{running ? '执行中…' : '执行 SQL'}</Button><Button type="button" variant="outline" disabled={running} onClick={() => { const next = { ...blankSQL, connection_id: draft.connection_id }; setDraft(next); setCleanDraft(JSON.stringify(next)); setResult(undefined); setError(null); setNotice(''); }}>清空 SQL</Button></div>
            {notice && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}<ErrorAlert error={error} />
          </form>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>本次执行结果</CardTitle></CardHeader><CardContent aria-busy={running}>
          {running ? <p className="text-sm" role="status">SQL 正在执行，请等待结果…</p> : result ? resultMode === 'exec' ? <p className="text-sm">执行成功 · 影响 {result.rows_affected} 行 · {result.duration_ms} ms</p> : <SQLResultTable key={resultVersion} result={result} /> : <p className="text-sm text-muted-foreground">执行 SQL 后，查询数据、影响行数或错误信息会显示在这里。</p>}
        </CardContent></Card>
      </TabsContent>
      <TabsContent value="history" className="space-y-4">
        <div className="flex flex-wrap items-center gap-3"><Input className="max-w-sm" type="search" aria-label="搜索 SQL 执行记录" placeholder="SQL、连接名称或错误" value={historySearch} onChange={event => setHistorySearch(event.target.value)} /><SelectField label="筛选历史连接" value={historyConnection} onValueChange={setHistoryConnection} options={[{ value: '', label: '全部连接' }, ...Array.from(historyNames, ([value, label]) => ({ value, label }))]} /><p className="ml-auto text-xs text-muted-foreground">{visibleHistory.length} 条 · 最近 100 条</p></div>
        <ErrorAlert error={historyQuery.error ? databaseError(historyQuery.error) : null} />
        {historyQuery.isPending ? <p role="status">正在读取 SQL 执行记录…</p> : !visibleHistory.length ? <EmptyState title="没有匹配的 SQL 执行记录" description="通过工作台、MCP 或流程执行的 SQL 会自动显示在这里。" /> : <div className="overflow-x-auto rounded-md border"><Table>
          <TableHeader><TableRow><TableHead>SQL</TableHead><TableHead>数据库连接</TableHead><TableHead>状态</TableHead><TableHead>耗时</TableHead><TableHead>执行时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
          <TableBody>{visibleHistory.map(item => { const url = executionURL(item); return <TableRow key={item.id}>
            <TableCell className="max-w-xs"><Button variant="ghost" className="h-auto max-w-xs justify-start px-0 text-left" onClick={() => setInspection(item)} aria-label={`查看 SQL 执行详情：${item.sql}`}><span className="truncate font-mono text-xs">{item.sql}</span></Button><p className="text-xs text-muted-foreground">{item.mode === 'query' ? '查询' : '执行'}</p></TableCell>
            <TableCell>{item.connection_name}{item.connection_status && item.connection_status !== 'active' && <p className="text-xs text-muted-foreground">{item.connection_status === 'archived' ? '原连接已归档' : '原连接已删除'}</p>}</TableCell>
            <TableCell><StatusBadge status={item.status} />{item.status === 'succeeded' && <p className="mt-1 text-xs text-muted-foreground">{item.mode === 'query' ? item.truncated ? '结果已截断' : `返回 ${item.row_count} 行` : `影响 ${item.rows_affected} 行`}</p>}</TableCell>
            <TableCell className="whitespace-nowrap">{item.status === 'running' ? '—' : `${item.duration_ms} ms`}</TableCell><TableCell className="whitespace-nowrap text-xs">{new Date(item.started_at).toLocaleString('zh-CN')}</TableCell>
            <TableCell><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setInspection(item)}>{item.mode === 'query' && item.status === 'succeeded' ? '查看结果' : '查看详情'}</Button><Button size="sm" variant="outline" disabled={running || item.status === 'running'} onClick={() => fill(item)}>填入编辑器</Button>{url && <Button size="sm" variant="link" asChild><Link to={url}>查看执行批次</Link></Button>}</div></TableCell>
          </TableRow>; })}</TableBody>
        </Table></div>}
      </TabsContent>
    </Tabs>
    {newConnection && <ConnectionEditor connection={null} onClose={() => setNewConnection(false)} onSaved={refresh} onDirtyChange={setEditorDirty} />}
    {inspection && <SQLExecutionDetail key={inspection.id} execution={inspection} onOpenChange={open => { if (!open) setInspection(null); }} />}
  </div>;
}
