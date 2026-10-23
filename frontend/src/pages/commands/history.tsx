import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { CodeBlock, ErrorAlert, EmptyState, SelectField, StatusBadge } from '@/components/shared';

export function BatchLink({ batchID, step }: { batchID: string; step?: string }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <Link
        to={`/execution-records?${new URLSearchParams({ batch: batchID, ...(step ? { step } : {}) })}`}
      >
        查看执行批次
      </Link>
    </Button>
  );
}
export function ToolRunResult({ result, batchID }: { result: any; batchID?: string }) {
  if (!result)
    return <EmptyState title="执行后查看结果" description="结果及断言会保存在执行记录中。" />;
  const data = result.command_result;
  const assertions = result.assertions || [];
  return (
    <section className="space-y-4" aria-live="polite">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={result.test_status || result.status || 'unverified'} />
        <span className="text-sm text-muted-foreground">
          {data ? `退出码 ${data.exit_code ?? '—'} · ` : ''}
          {result.duration_ms ?? 0} ms
        </span>
        {batchID && <BatchLink batchID={batchID} step={result.test_run_id || result.id} />}
      </div>
      <ErrorAlert error={result.test_error || result.error_message} />
      {data ? (
        ['stdout', 'stderr'].map((source) => (
          <div key={source} className="space-y-2">
            <h3 className="font-medium">{source}</h3>
            {data[`${source}_truncated`] && (
              <p className="text-sm text-destructive">输出已截断，相关输出断言不能判为通过。</p>
            )}
            <CodeBlock value={data[source] || '（空）'} />
          </div>
        ))
      ) : (
        <>
          <h3 className="font-medium">MCP 返回结果</h3>
          <CodeBlock value={result.mcp_result} />
        </>
      )}
      <h3 className="font-medium">
        断言结果
        {assertions.length
          ? ` · ${assertions.filter((item: any) => item.passed).length}/${assertions.length} 通过`
          : ''}
      </h3>
      {assertions.length ? (
        assertions.map((item: any, index: number) => (
          <div className="rounded-md border p-3 space-y-2" key={index}>
            <StatusBadge status={item.passed ? 'passed' : 'failed'} />
            <code className="ml-2 text-xs">
              {item.kind || item.source}
              {item.path ? `.${item.path}` : ''} {item.operator}
            </code>
            <CodeBlock value={{ expected: item.expected, actual: item.actual }} />
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">本次执行没有断言结果。</p>
      )}
    </section>
  );
}
export function ToolExecutionHistory({ kind }: { kind: 'command' | 'mcp' }) {
  const title = kind === 'command' ? '命令行' : 'MCP';
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<any>(null);
  const history = useQuery<any[]>({
    queryKey: ['tool-history', kind],
    queryFn: ({ signal }) => api(`/test-runs?type=${kind}`, { signal }),
    refetchInterval: 5000,
  });
  const detail = useQuery<any>({
    queryKey: ['tool-run', selected?.id],
    queryFn: ({ signal }) => api(`/test-runs/${encodeURIComponent(selected.id)}`, { signal }),
    enabled: !!selected,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : false),
  });
  const items = (history.data || []).filter(
    (item) =>
      (!status || item.status === status) &&
      [item.name, item.target, item.batch_name].some((value) =>
        String(value || '')
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Input
          className="max-w-md"
          aria-label={`搜索${title}执行记录`}
          placeholder="名称、程序 / 工具或批次"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <SelectField
          label="执行状态"
          value={status}
          onValueChange={setStatus}
          options={[
            { value: '', label: '全部状态' },
            ...Object.entries({
              running: '执行中',
              passed: '通过',
              failed: '断言失败',
              error: '执行错误',
              unverified: '未验证',
            }).map(([value, label]) => ({ value, label })),
          ]}
        />
        <Button
          variant="outline"
          onClick={() => void history.refetch()}
          disabled={history.isFetching}
        >
          刷新记录
        </Button>
        <span className="text-xs text-muted-foreground">
          最近 200 条 · {history.data?.length || 0} 条记录
        </span>
      </div>
      <ErrorAlert error={history.error} />
      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {['执行', '状态', '耗时', '执行时间', '批次', '操作'].map((text) => (
                <TableHead key={text}>{text}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <p className="font-medium">{item.name}</p>
                  <p className="text-xs text-muted-foreground break-all">{item.target}</p>
                </TableCell>
                <TableCell>
                  <StatusBadge status={item.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {item.status === 'running' ? '—' : `${item.duration_ms} ms`}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {new Date(item.started_at).toLocaleString('zh-CN')}
                </TableCell>
                <TableCell>{item.batch_name}</TableCell>
                <TableCell>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setSelected(item)}>
                      查看详情
                    </Button>
                    <BatchLink batchID={item.batch_id} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {!items.length && (
        <EmptyState title={history.isPending ? '正在读取执行记录…' : '暂无匹配的执行记录'} />
      )}
      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selected?.name || `${title}执行详情`}</DialogTitle>
          </DialogHeader>
          <ErrorAlert error={detail.error} />
          {detail.isPending ? (
            <p>正在读取执行详情…</p>
          ) : detail.data ? (
            <>
              <h3 className="font-medium">执行输入</h3>
              <CodeBlock
                value={
                  kind === 'command'
                    ? detail.data.command_request_snapshot
                    : detail.data.mcp_request_snapshot
                }
              />
              <ToolRunResult result={detail.data} batchID={detail.data.batch_id} />
            </>
          ) : (
            <Button onClick={() => void detail.refetch()}>重试读取</Button>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
