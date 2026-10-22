import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CodeBlock, ErrorAlert, StatusBadge } from '@/components/shared';
import { cellText, databaseError, executionURL, type SQLExecution, type SQLResult } from './model';

const pageSize = 100;

/** SQL values stay text, including JSON, HTML-looking strings, NULL, false and zero. */
export function SQLResultTable({ result }: { result: SQLResult | null | undefined }) {
  const [cell, setCell] = useState<{ context: string; text: string } | null>(null);
  const [page, setPage] = useState(0);
  if (!result) return <p className="text-sm text-muted-foreground">此记录未保存查询结果，请重新执行 SQL 后查看。</p>;
  const rows = result.rows ?? [], columns = result.columns ?? [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">{result.truncated
      ? `显示前 ${rows.length} 行，结果已截断，总行数未知。`
      : `返回 ${result.row_count} 行 · ${result.duration_ms} ms`}</p>
    <div className="max-h-[55vh] overflow-auto rounded-md border" role="region" aria-label="查询结果表格" tabIndex={0}>
      <Table>
        <TableHeader><TableRow>{columns.map((column, index) => <TableHead key={`${index}-${column}`} className="sticky top-0 whitespace-nowrap bg-muted">{column}</TableHead>)}</TableRow></TableHeader>
        <TableBody>{rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((row, rowIndex) => <TableRow key={currentPage * pageSize + rowIndex}>
          {columns.map((column, columnIndex) => {
            const value = row[column], text = cellText(value), position = currentPage * pageSize + rowIndex + 1;
            return <TableCell key={`${columnIndex}-${column}`} className="max-w-80 font-mono text-xs">
              {value === null || text === '' ? <span className={value === null ? 'italic text-muted-foreground' : ''}>{text}</span>
                : <Button type="button" variant="ghost" className="h-auto max-w-80 justify-start px-0 py-1 text-left font-mono text-xs" aria-label={`查看第 ${position} 行 ${column} 字段的完整内容`} onClick={() => setCell({ context: `第 ${position} 行 · ${column}`, text })}>
                  <span className="block truncate">{text}</span>
                </Button>}
            </TableCell>;
          })}
        </TableRow>)}</TableBody>
      </Table>
      {!rows.length && <p className="p-8 text-center text-sm text-muted-foreground">查询成功，没有返回数据</p>}
    </div>
    {rows.length > pageSize && <div className="flex items-center justify-end gap-3 text-sm">
      <span>第 {currentPage + 1} / {Math.ceil(rows.length / pageSize)} 页 · 每页 {pageSize} 行</span>
      <Button type="button" size="sm" variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button>
      <Button type="button" size="sm" variant="outline" disabled={(currentPage + 1) * pageSize >= rows.length} onClick={() => setPage(currentPage + 1)}>下一页</Button>
    </div>}
    <Dialog open={cell !== null} onOpenChange={open => { if (!open) setCell(null); }}>
      <DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>字段完整内容</DialogTitle><DialogDescription>{cell?.context}</DialogDescription></DialogHeader><CodeBlock value={cell?.text ?? ''} /></DialogContent>
    </Dialog>
  </div>;
}

export function SQLExecutionDetail({ execution, open = true, onOpenChange }: { execution: SQLExecution; open?: boolean; onOpenChange: (open: boolean) => void }) {
  const result = useQuery({
    queryKey: ['database-result', execution.id],
    queryFn: ({ signal }) => api<{ result: SQLResult | null }>(`/database/executions/${execution.id}/result`, { signal }),
    enabled: open && execution.mode === 'query' && execution.status === 'succeeded',
    staleTime: 0,
    retry: false,
  });
  const batchURL = executionURL(execution);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
    <DialogHeader><DialogTitle>SQL 执行详情</DialogTitle><DialogDescription>{execution.connection_name} · {new Date(execution.started_at).toLocaleString('zh-CN')}</DialogDescription></DialogHeader>
    <div className="flex flex-wrap items-center gap-3"><StatusBadge status={execution.status} />{batchURL ? <Link className="text-sm text-primary underline underline-offset-4" to={batchURL}>查看执行批次</Link> : <span className="text-xs text-muted-foreground">未关联批次</span>}</div>
    <CodeBlock value={execution.sql} />
    {!!execution.params?.length && <section className="space-y-2"><h3 className="text-sm font-medium">绑定参数</h3><CodeBlock value={execution.params} /></section>}
    {execution.error || execution.status === 'failed' ? <ErrorAlert error={execution.error || '执行失败，未返回详细错误。'} />
      : execution.status === 'running' ? <p role="status">SQL 正在执行中，请稍后重新查看。</p>
        : execution.mode === 'exec' ? <p className="text-sm">执行成功 · 影响 {execution.rows_affected} 行 · {execution.duration_ms} ms</p>
          : result.isPending ? <p role="status" className="text-sm">正在读取查询结果…</p>
            : result.error ? <div className="space-y-3"><ErrorAlert error={databaseError(result.error)} /><Button variant="outline" onClick={() => void result.refetch()}>重试</Button></div>
              : <SQLResultTable key={execution.id} result={result.data?.result} />}
  </DialogContent></Dialog>;
}
