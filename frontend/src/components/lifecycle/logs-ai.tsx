import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CodeBlock, Field, SelectField } from '@/components/shared';
import { api, json } from '@/lib/api';
import { Modal, OpenButton, TaskError, useTask, type Changed } from './common';

interface LogSource {
  id: string;
  name: string;
  deleted?: boolean;
  archived?: boolean;
  count: number;
}
interface LogLine {
  sequence: number;
  time: string;
  stream: string;
  source_name: string;
  message: string;
}
interface LogFilters {
  source: string;
  q: string;
  level: string;
  after: string;
  before: string;
  offset: number;
}
const initialFilters: LogFilters = {
  source: '',
  q: '',
  level: '',
  after: '',
  before: '',
  offset: 0,
};
function range(filters: LogFilters) {
  return {
    source: filters.source,
    ...(filters.after ? { after: new Date(filters.after).toISOString() } : {}),
    ...(filters.before ? { before: new Date(filters.before).toISOString() } : {}),
  };
}
function LogsContent() {
  const [filters, setFilters] = useState(initialFilters);
  const [query, setQuery] = useState(initialFilters);
  const [preview, setPreview] = useState<{
    token: string;
    count: number;
    source: string;
    after?: string;
    before: string;
  } | null>(null);
  const task = useTask();
  const sources = useQuery({
    queryKey: ['log-sources'],
    queryFn: () => api<LogSource[]>('/service-log-sources'),
  });
  const q = useQuery({
    queryKey: ['stored-logs', query],
    queryFn: () =>
      api<{ total: number; items: LogLine[] }>(
        '/service-logs?' +
          new URLSearchParams({
            ...range(query),
            q: query.q,
            level: query.level,
            offset: String(query.offset),
            limit: '100',
          }),
      ),
  });
  const field = (key: keyof LogFilters, value: string) =>
    setFilters((old) => ({ ...old, [key]: value, offset: 0 }));
  return (
    <>
      <p className="text-sm text-muted-foreground">
        每个服务最多保留 2,000 条，单条正文最多 8 KB。查询包含 Apix
        运行事件及已归档、已删除配置的服务日志。
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="已存日志来源"
          value={filters.source}
          disabled={task.pending}
          onValueChange={(v) => field('source', v)}
          options={[
            { value: '', label: '全部来源' },
            ...(sources.data || []).map((item) => ({
              value: item.id,
              label: `${item.name}${item.deleted ? ' · 已删除' : item.archived ? ' · 已归档' : ''} (${item.count})`,
            })),
          ]}
        />
        <Field label="日志文本">
          <Input
            type="search"
            disabled={task.pending}
            value={filters.q}
            onChange={(e) => field('q', e.target.value)}
          />
        </Field>
        <SelectField
          label="日志级别"
          value={filters.level}
          disabled={task.pending}
          onValueChange={(v) => field('level', v)}
          options={[
            { value: '', label: '全部级别' },
            ...['stdout', 'stderr', 'manager', 'info', 'error'].map((value) => ({
              value,
              label: value.toUpperCase(),
            })),
          ]}
        />
        <Field label="日志开始时间">
          <Input
            type="datetime-local"
            disabled={task.pending}
            value={filters.after}
            onChange={(e) => field('after', e.target.value)}
          />
        </Field>
        <Field label="日志结束时间">
          <Input
            type="datetime-local"
            disabled={task.pending}
            value={filters.before}
            onChange={(e) => field('before', e.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={q.isFetching || task.pending}
          onClick={() => {
            setQuery({ ...filters, offset: 0 });
            if (JSON.stringify(filters) === JSON.stringify(query)) void q.refetch();
          }}
        >
          查询存储日志
        </Button>
        <OpenButton
          disabled={task.pending}
          onClick={() =>
            void task.run(async () =>
              setPreview(await json('/service-logs/cleanup-preview', range(filters))),
            )
          }
        >
          按来源和时间预览清理
        </OpenButton>
      </div>
      <p className="text-xs text-muted-foreground">
        清理范围仅按所选来源和时间计算，不受文本及级别筛选影响；执行前会展示总数。
      </p>
      <TaskError error={q.error || sources.error || task.error} />
      <p className="text-sm">
        共 {q.data?.total || 0} 条 · 当前 {q.data?.items.length || 0} 条
      </p>
      <CodeBlock
        value={
          q.isPending
            ? '正在读取…'
            : q.data?.items
                .map(
                  (line) =>
                    `${new Date(line.time).toLocaleString('zh-CN')} [${line.stream}] ${line.source_name}: ${line.message}`,
                )
                .join('\n') || '没有匹配的日志'
        }
      />
      <div className="flex gap-2">
        <OpenButton
          disabled={q.isFetching || query.offset === 0}
          onClick={() => setQuery((old) => ({ ...old, offset: Math.max(0, old.offset - 100) }))}
        >
          上一页
        </OpenButton>
        <OpenButton
          disabled={q.isFetching || query.offset + 100 >= (q.data?.total || 0)}
          onClick={() => setQuery((old) => ({ ...old, offset: old.offset + 100 }))}
        >
          下一页
        </OpenButton>
      </div>
      <Modal
        open={preview !== null}
        onOpenChange={(v) => {
          if (!v) setPreview(null);
        }}
        title="删除已存日志"
        pending={task.pending}
      >
        {preview ? (
          <p>
            将永久删除 {preview.count} 条日志。范围：{preview.source || '全部来源'}，
            {preview.after || '最早'} 至 {preview.before}。不会删除测试结果与断言，Runtime
            本地日志文件按原方式保留。
          </p>
        ) : null}
        <TaskError error={task.error} />
        <Button
          variant="destructive"
          disabled={task.pending || !preview}
          onClick={() =>
            void task.run(async () => {
              await json('/service-logs/cleanup', { token: preview?.token });
              setPreview(null);
              await q.refetch();
              await sources.refetch();
            })
          }
        >
          确认删除已存日志
        </Button>
      </Modal>
    </>
  );
}
export function LogManager() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <OpenButton onClick={() => setOpen(true)}>查询与清理已存日志</OpenButton>
      <Modal open={open} onOpenChange={setOpen} title="查询与清理已存日志">
        {open ? <LogsContent /> : null}
      </Modal>
    </>
  );
}

interface RemovalPreview {
  path?: string;
  difference?: string;
  instructions?: string;
  status: string;
  can_remove: boolean;
  fingerprint?: string;
}
export function AIRemoval({
  client,
  target,
  onChanged = () => {},
}: {
  client: { id: string; name: string; status?: string };
  target: string;
  onChanged?: Changed;
}) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState('');
  const task = useTask();
  const q = useQuery({
    queryKey: ['ai-removal-preview', client.id, target],
    queryFn: () =>
      json<RemovalPreview>(`/ai-tools/${encodeURIComponent(client.id)}/removal-preview`, {
        target,
      }),
    enabled: open,
  });
  return (
    <>
      <OpenButton
        onClick={() => {
          setDone('');
          task.setError(null);
          setOpen(true);
        }}
      >
        {client.status === 'external' ? '手动移除说明' : '移除配置'}
      </OpenButton>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="移除 AI 工具中的 Apix 配置"
        pending={task.pending}
      >
        <p className="text-sm">
          目标系统：{target} · 工具：{client.name}
        </p>
        <p className="text-sm text-muted-foreground">
          只移除 Apix 连接项；保留其他设置，不卸载工具、不删除 Apix 数据、不停止 Runtime。
        </p>
        <TaskError error={q.error || task.error} />
        {done ? (
          <p role="status">{done}</p>
        ) : q.isPending ? (
          <p>正在预览配置变更…</p>
        ) : q.data ? (
          <>
            <CodeBlock value={q.data.path || '由目标工具管理'} />
            {q.data.difference ? <CodeBlock value={q.data.difference} /> : null}
            {q.data.instructions ? (
              <p className="whitespace-pre-wrap text-sm">{q.data.instructions}</p>
            ) : null}
            {q.data.can_remove ? (
              <Button
                variant="destructive"
                disabled={task.pending || q.isFetching}
                onClick={() =>
                  void task.run(async () => {
                    const result = await json<{ backup: string }>(
                      `/ai-tools/${encodeURIComponent(client.id)}/remove`,
                      { target, fingerprint: q.data.fingerprint },
                    );
                    setDone(`已验证移除。原配置备份：${result.backup}`);
                    await onChanged();
                  })
                }
              >
                备份并确认移除
              </Button>
            ) : (
              <p>
                {q.data.status === 'absent'
                  ? '已验证当前没有 Apix 配置。'
                  : '自动操作已停止；请按上述说明手动处理。'}
              </p>
            )}
          </>
        ) : null}
      </Modal>
    </>
  );
}
