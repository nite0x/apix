import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { LogManager } from '@/components/lifecycle';
import { EmptyState, ErrorAlert, PageHeader, SelectField } from '@/components/shared';
import { useActivity } from '@/lib/activity';

type LogLine = {
  key: string;
  time: string;
  stream: string;
  source: string;
  sourceName: string;
  message: string;
};
const eventNames: Record<string, string> = {
  'runtime.started': 'Apix 已启动',
  'runtime.stopped': 'Apix 已停止',
  'tool.started': '开始调用工具',
  'tool.finished': '工具执行结束',
  'session:start': '开始执行会话',
  'session:done': '会话已完成',
  'session:error': '会话执行失败',
  'session:stop': '会话已停止',
};
export default function LogsPage() {
  const q = useActivity();
  const [params, setParams] = useSearchParams();
  const source = params.get('source') || 'all';
  const [cleared, setCleared] = useState<Set<string>>(() => new Set());
  const [paused, setPaused] = useState(false);
  const [auto, setAuto] = useState(true);
  const [frozen, setFrozen] = useState<LogLine[]>([]);
  const output = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => {
    const names = new Map<string, string>((q.data?.services || []).map((s: any) => [s.id, s.name]));
    const events: LogLine[] = (q.data?.events || []).map((e: any) => ({
      key: `e:${e.sequence}`,
      time: e.time,
      stream: e.type.includes('error') ? 'error' : 'info',
      source: 'runtime',
      sourceName: '运行事件',
      message: [
        eventNames[e.type] || e.type,
        e.payload?.name,
        e.payload?.tool,
        e.payload?.status,
        e.payload?.error_code,
        e.run_id ? `#${e.run_id}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    }));
    const services: LogLine[] = (q.data?.service_logs || []).map((line: any) => ({
      key: `s:${line.sequence}`,
      time: line.time,
      stream: line.stream,
      source: line.service_id,
      sourceName: names.get(line.service_id) || line.service_id,
      message: line.message,
    }));
    return [...events, ...services]
      .sort((a, b) => a.time.localeCompare(b.time) || a.key.localeCompare(b.key))
      .slice(-1000);
  }, [q.data]);
  const shown = (paused ? frozen : lines).filter(
    (line) => !cleared.has(line.key) && (source === 'all' || line.source === source),
  );
  const lastShownKey = shown.at(-1)?.key;
  useEffect(() => {
    if (auto && !paused && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [lastShownKey, auto, paused, source]);
  const options = [
    { value: 'all', label: '全部来源' },
    { value: 'runtime', label: '运行事件' },
    ...(q.data?.services || []).map((s: any) => ({ value: s.id, label: s.name })),
  ];
  if (!options.some((option) => option.value === source))
    options.push({ value: source, label: source });
  return (
    <div className="stack">
      <PageHeader
        title="日志"
        description="运行事件与服务输出实时汇总。时间使用本地时区，最多显示最近 1,000 条。"
        actions={<LogManager />}
      />
      <div className="panel toolbar">
        <SelectField
          label="日志来源"
          value={source}
          onValueChange={(value) => setParams(value === 'all' ? {} : { source: value })}
          options={options}
        />
        <label className="flex h-9 items-center gap-2">
          <Checkbox checked={auto} onCheckedChange={(value) => setAuto(value === true)} />
          自动滚动
        </label>
        <Button
          variant="outline"
          aria-pressed={paused}
          onClick={() => {
            if (!paused) setFrozen(lines);
            setPaused((v) => !v);
          }}
        >
          {paused ? '继续显示' : '暂停显示'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setCleared(new Set(lines.map((line) => line.key)));
            setFrozen([]);
          }}
        >
          清空屏幕显示
        </Button>
        <Badge variant={paused ? 'secondary' : 'default'}>{paused ? '已暂停' : 'LIVE'}</Badge>
        <span className="text-xs text-muted-foreground">{shown.length} 条</span>
      </div>
      <ErrorAlert error={q.error} />
      {!shown.length ? (
        <EmptyState
          title="等待活动日志"
          description="通过工作台或 MCP 执行操作后，运行事件和服务输出会出现在这里。"
        />
      ) : (
        <div
          ref={output}
          tabIndex={0}
          role="log"
          aria-live="off"
          aria-label="实时日志内容"
          className="h-[65vh] overflow-auto rounded-lg border bg-card p-3 font-mono text-xs leading-6"
        >
          {shown.map((line) => (
            <div key={line.key} className="flex items-start gap-3 border-b border-border/40 py-0.5">
              <time className="shrink-0 text-muted-foreground">
                {new Date(line.time).toLocaleTimeString('zh-CN', { hour12: false })}
              </time>
              <span
                className="w-20 shrink-0 truncate text-muted-foreground"
                title={line.sourceName}
              >
                {line.sourceName}
              </span>
              <span
                className={
                  line.stream === 'stderr' || line.stream === 'error'
                    ? 'text-destructive'
                    : 'text-foreground'
                }
              >
                <span className="mr-2 text-[10px] uppercase opacity-60">{line.stream}</span>
                <span className="whitespace-pre-wrap break-all">{line.message}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
