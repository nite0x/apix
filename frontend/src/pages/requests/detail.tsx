import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { CodeBlock, ErrorAlert, StatusBadge } from '@/components/shared';
import { executionLink, formatTime, requestURL, type RequestRun } from './model';

export function BatchLink({ run }: { run: Pick<RequestRun, 'batch_id' | 'test_run_id' | 'step_id' | 'flow_run_id' | 'flow_id'> }) {
  const path = executionLink(run);
  return path ? <Button variant="link" size="sm" asChild><Link to={path}>查看整组执行</Link></Button> : <span className="text-xs text-muted-foreground">未关联批次</span>;
}

function Pairs({ values }: { values: [string, unknown][] }) {
  return values.length ? <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(100px,180px)_1fr]">{values.map(([name, value], index) => <div className="contents" key={`${name}-${index}`}><dt className="text-sm text-muted-foreground break-all">{name}</dt><dd className="text-sm whitespace-pre-wrap break-all">{value == null ? '—' : String(value)}</dd></div>)}</dl> : <p className="text-sm text-muted-foreground">（空）</p>;
}

export function RequestRunContent({ run }: { run: RequestRun }) {
  const request = run.request_snapshot || { method: '', url: '' };
  let urlPairs: [string, unknown][] = [];
  try { urlPairs = [...new URL(request.url).searchParams]; } catch { /* URL remains visible. */ }
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{request.method}</Badge><StatusBadge status={run.status} />{run.response_status ? <Badge variant={run.response_status >= 400 ? 'destructive' : 'default'}>HTTP {run.response_status}</Badge> : null}<span className="text-sm text-muted-foreground">{run.duration_ms ?? 0} ms</span><BatchLink run={run} /></div>
    <p className="break-all font-mono text-sm">{requestURL(request)}</p>
    {run.error_message || run.error_code ? <ErrorAlert error={`${run.error_code || '执行失败'}：${run.error_message || '请求未完成，请检查目标地址和服务状态。'}`} /> : null}
    {run.response_truncated ? <p role="status" className="rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900">响应正文超过 256 KB，仅显示已保存的前 256 KB；未保存的部分无法恢复。</p> : null}
    <Tabs defaultValue="response">
      <TabsList aria-label="请求详情内容"><TabsTrigger value="response">响应</TabsTrigger><TabsTrigger value="request">请求</TabsTrigger><TabsTrigger value="execution">执行记录</TabsTrigger></TabsList>
      <TabsContent value="response" className="space-y-4">
        {run.response_status ? <><h3 className="text-sm font-medium">响应正文</h3><CodeBlock value={run.response_body ?? '（空响应体）'} /><h3 className="text-sm font-medium">响应头</h3><Pairs values={Object.entries(run.response_headers || {}).flatMap(([name, values]) => (Array.isArray(values) ? values : [values]).map(value => [name, value] as [string, unknown]))} /><p className="text-xs text-muted-foreground">已读取{run.response_truncated ? '至少' : ''} {(run.response_size || 0).toLocaleString('zh-CN')} 字节。文本和 HTML 仅作为文本展示。</p></> : <p className="text-sm text-muted-foreground">{run.status === 'running' ? '请求正在执行，完成后会自动显示返回结果。' : '未收到 HTTP 响应，执行错误已显示在上方。'}</p>}
      </TabsContent>
      <TabsContent value="request" className="space-y-4">
        <h3 className="text-sm font-medium">URL 中的参数</h3><Pairs values={urlPairs} />
        <h3 className="text-sm font-medium">配置的查询参数</h3><Pairs values={(request.query_params || []).map(row => [row.name, `${row.value}${row.enabled ? '' : ' [未启用]'}`])} />
        <h3 className="text-sm font-medium">请求头</h3><Pairs values={(request.headers || []).map(row => [row.name, `${row.value}${row.enabled ? '' : ' [未启用]'}`])} />
        <h3 className="text-sm font-medium">请求正文 · {request.body_type || 'none'}</h3><CodeBlock value={request.body || '（空）'} />
        {request.auth_config ? <><h3 className="text-sm font-medium">身份验证</h3><CodeBlock value={request.auth_config} /></> : null}
        <p className="text-xs text-muted-foreground">请求快照为变量替换后的配置。上方 URL 合并已启用的查询参数，自动生成的认证值及传输层请求头不在快照中。</p>
      </TabsContent>
      <TabsContent value="execution"><Pairs values={[
        ['执行 ID', run.id], ['执行状态', run.status], ['开始时间', formatTime(run.started_at)], ['结束时间', formatTime(run.finished_at)],
        ['耗时', run.status === 'running' ? '执行中' : `${run.duration_ms ?? 0} ms`], ['调用来源', run.trigger_type], ['会话 / 流程 ID', run.session_id],
        ['步骤 ID', run.step_id], ['接口定义 ID', run.api_request_id], ['工作副本 ID', run.working_copy_id], ['环境 ID', run.environment_id], ['正文已截断', run.response_truncated ? '是' : '否'],
      ]} /><p className="mt-4 text-xs text-muted-foreground">保存应用层请求和返回快照、开始结束时间及错误信息；未记录 DNS、TCP、TLS 分段耗时和每次重定向。</p></TabsContent>
    </Tabs>
  </div>;
}

export function RequestDetail({ id, open, onOpenChange }: { id: string | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const query = useQuery({ queryKey: ['request-run', id], queryFn: ({ signal }) => api<RequestRun>(`/runs/${encodeURIComponent(id || '')}`, { signal }), enabled: open && !!id,
    refetchInterval: query => query.state.data?.status === 'running' ? 1000 : false,
  });
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl"><DialogHeader><DialogTitle>请求与响应详情</DialogTitle><DialogDescription>已保存的请求快照、响应及执行信息</DialogDescription></DialogHeader><div><Button size="sm" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>刷新详情</Button></div><ErrorAlert error={query.error} />{query.isPending ? <p role="status">正在读取已保存的请求与返回…</p> : query.data ? <RequestRunContent run={query.data} /> : null}</DialogContent></Dialog>;
}
