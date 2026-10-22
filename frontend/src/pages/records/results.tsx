import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CodeBlock, EmptyState, ErrorAlert, StatusBadge } from '@/components/shared';
import { RequestDetail, RequestRunContent } from '@/pages/requests/detail';
export const runTarget = (run: any): string =>
  run.type === 'sql'
    ? `数据库 · ${run.execution_input?.connection_id || run.sql_snapshot?.connection_id || 'SQL'}`
    : run.type === 'service'
      ? `服务 · ${run.execution_input?.service_id || run.service_snapshot?.service_id || ''}`
      : run.type === 'command'
        ? `命令行 · ${run.command_request_snapshot?.program || ''}`
        : run.type === 'mcp'
          ? `MCP · ${run.mcp_result?.server?.name || run.mcp_request_snapshot?.server_id || ''} / ${run.mcp_request_snapshot?.tool_name || ''}`
          : `${run.request_snapshot?.method || 'HTTP'} ${run.request_snapshot?.url || ''}`;
export function duration(run: any): string {
  if (['running', 'queued', 'paused'].includes(run.status)) return '进行中';
  const result = run.command_result || run.execution_result || run.mcp_result || run.result;
  const ms = run.duration_ms ?? result?.duration_ms;
  if (ms != null) return `${ms} ms`;
  if (!run.finished_at || !run.started_at) return '—';
  return `${Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at))} ms`;
}
export function Assertions({ run }: { run: any }) {
  const assertions = run.assertions || [];
  return (
    <section aria-label="断言结果" className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {assertions.length
          ? `${assertions.length} 项断言 · ${assertions.filter((item: any) => item.passed).length} 项通过`
          : run.status === 'unverified'
            ? '本次执行没有设置预期断言，保留为“未验证”。'
            : '暂无断言结果。'}
      </p>
      {assertions.map((rule: any, index: number) => (
        <div key={index} className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <code className="text-xs">
              {rule.kind}
              {rule.path ? `.${rule.path}` : ''} · {rule.operator || 'equals'}
            </code>
            <StatusBadge status={rule.passed ? 'passed' : 'failed'} />
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">预期值</p>
              <CodeBlock value={rule.expected} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">实际值</p>
              <CodeBlock value={rule.actual} />
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
export function SQLSnapshot({
  input,
  result,
  status,
}: {
  input: any;
  result: any;
  status: string;
}) {
  const rows = result?.rows || [];
  const columns: string[] = result?.columns?.length
    ? result.columns
    : [...new Set<string>(rows.flatMap((row: any) => Object.keys(row)))];
  return (
    <div className="space-y-4">
      <section aria-label="SQL 执行快照" className="space-y-2">
        <h3 className="font-medium">SQL 执行快照</h3>
        {input ? (
          <>
            <p className="text-sm">
              数据库连接：{input.connection_id} · {input.mode === 'exec' ? '执行语句' : '查询'} ·
              最大返回行数 {input.max_rows || '默认'}
            </p>
            <CodeBlock value={input.sql} />
            <h4 className="text-sm font-medium">绑定参数</h4>
            <CodeBlock value={input.params || []} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">这条记录没有保存 SQL 输入快照。</p>
        )}
      </section>
      <section aria-label="SQL 结果" className="space-y-2">
        <h3 className="font-medium">{input?.mode === 'exec' ? 'SQL 执行结果' : 'SQL 查询结果'}</h3>
        {result &&
        ['rows', 'columns', 'row_count', 'rows_affected'].some((key) =>
          Object.hasOwn(result, key),
        ) ? (
          <>
            <p className="text-sm">
              {input?.mode === 'exec' ? '影响行数' : '返回行数'}：
              {input?.mode === 'exec'
                ? result.rows_affected
                : result.truncated
                  ? `已保存 ${rows.length} 行（总行数未知）`
                  : result.row_count}{' '}
              · {result.duration_ms ?? '—'} ms
            </p>
            {result.truncated ? (
              <p role="status" className="text-sm text-amber-700">
                查询结果已截断，仅展示已保存的部分数据。
              </p>
            ) : null}
            {input?.mode !== 'exec' && columns.length ? (
              <div className="max-h-96 overflow-auto rounded-md border">
                <Table aria-label="SQL 查询数据">
                  <TableHeader>
                    <TableRow>
                      {columns.map((column) => (
                        <TableHead key={column}>{column}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row: any, index: number) => (
                      <TableRow key={index}>
                        {columns.map((column) => (
                          <TableCell
                            key={column}
                            className="max-w-80 whitespace-pre-wrap break-all font-mono text-xs"
                          >
                            {Object.hasOwn(row, column)
                              ? row[column] === null
                                ? 'NULL'
                                : typeof row[column] === 'string'
                                  ? row[column]
                                  : JSON.stringify(row[column])
                              : '—'}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : input?.mode !== 'exec' ? (
              <p className="text-sm text-muted-foreground">查询完成，返回 0 行。</p>
            ) : null}
          </>
        ) : (
          <EmptyState
            title={
              ['pending', 'queued', 'running', 'paused'].includes(status)
                ? '步骤尚未完成'
                : '本次执行未保存结果'
            }
            description="旧记录可能没有结果快照。"
          />
        )}
      </section>
    </div>
  );
}
export function ServiceSnapshot({ input, result }: { input: any; result: any }) {
  return (
    <div className="space-y-4">
      <section aria-label="服务操作快照">
        <h3 className="mb-2 font-medium">服务操作快照</h3>
        <CodeBlock value={input || '这条记录没有保存服务操作快照。'} />
      </section>
      <section aria-label="服务操作结果">
        <h3 className="mb-2 font-medium">服务操作结果</h3>
        {result ? (
          <>
            <StatusBadge status={result.status || 'unknown'} />
            <p className="my-2 text-sm">
              服务 ID：{result.service_id || input?.service_id || '—'} · 进程 PID：
              {result.pid || '—'} · 归属：{result.owner || '—'}
            </p>
            <p className="text-sm text-muted-foreground">
              {input?.action === 'start'
                ? result.started
                  ? '本次执行启动了服务。'
                  : '本次执行复用了已有服务。'
                : result.status === 'stopped'
                  ? '停止操作已完成。'
                  : '服务仍由原启动方管理，请查看操作结果。'}
              此处为执行时快照，后续状态可能变化。
            </p>
            <CodeBlock value={result} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">本次执行未保存服务操作结果。</p>
        )}
      </section>
    </div>
  );
}
export function RunOutput({ run }: { run: any }) {
  const apiID = run.api_run_id || null;
  const [detail, setDetail] = useState(false);
  const http = useQuery({
    queryKey: ['request-run', apiID],
    queryFn: ({ signal }) => api(`/runs/${encodeURIComponent(apiID!)}`, { signal }),
    enabled: !!apiID,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1000 : false),
  });
  if (run.type === 'sql')
    return (
      <SQLSnapshot
        input={run.execution_input || run.sql_snapshot}
        result={run.execution_result || run.result}
        status={run.status}
      />
    );
  if (run.type === 'service')
    return (
      <ServiceSnapshot
        input={run.execution_input || run.service_snapshot}
        result={run.execution_result || run.result}
      />
    );
  if (run.type === 'command') {
    const result = run.command_result || run.result || {};
    return (
      <div className="space-y-3">
        <p className="text-sm">
          退出码：{result.exit_code ?? '—'} · {duration(run)}
        </p>
        {['stdout', 'stderr'].map((source) => (
          <section key={source}>
            <h3 className="mb-2 font-medium">{source}</h3>
            <CodeBlock value={result[source] || '（空）'} />
            {result[`${source}_truncated`] ? (
              <p role="status" className="text-sm text-amber-700">
                输出已截断，相关输出断言不能判为通过。
              </p>
            ) : null}
          </section>
        ))}
      </div>
    );
  }
  if (run.type === 'mcp')
    return <CodeBlock value={run.mcp_result || run.result || '暂无 MCP 调用结果'} />;
  return (
    <div className="space-y-3">
      <ErrorAlert error={http.error} />
      {http.data ? (
        <>
          <RequestRunContent run={http.data} />
          <Button variant="outline" onClick={() => setDetail(true)}>
            打开完整请求详情
          </Button>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {apiID ? '正在读取已保存的响应…' : '本次执行没有可用的请求详情。'}
        </p>
      )}
      <RequestDetail id={apiID} open={detail} onOpenChange={setDetail} />
    </div>
  );
}
export const runInput = (run: any) =>
  run.type === 'sql' || run.type === 'service'
    ? run.execution_input || run.sql_snapshot || run.service_snapshot
    : run.type === 'command'
      ? run.command_request_snapshot
      : run.type === 'mcp'
        ? run.mcp_request_snapshot
        : run.request_snapshot;
