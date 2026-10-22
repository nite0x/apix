import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock, EmptyState, ErrorAlert, PageHeader, SelectField } from '@/components/shared';
import { AIRemoval } from '@/components/lifecycle';
import { api, json } from '@/lib/api';

interface Connection {
  status: string;
  tools_count?: number;
  error?: string;
  checked_at?: string;
  duration_ms?: number;
  environment?: string;
}
interface AIClient {
  id: string;
  name: string;
  status: string;
  path?: string;
  snippet: string;
  error?: string;
  connection?: Connection;
  links?: Record<string, string>;
}
interface AIConfig {
  target: string;
  endpoint: string;
  targets: Array<{ id: string; name: string; home: string }>;
  clients: AIClient[];
}
const labels: Record<string, string> = {
  available: '未配置',
  configured: '已配置',
  external: '应用内确认',
  blocked: '需要检查',
};
const aiKey = (target: string) => ['ai-tools', target];
function ConnectionStatus({ client, testing }: { client: AIClient; testing: boolean }) {
  const c = client.connection;
  const title = testing
    ? '正在验证连接…'
    : c?.status === 'connected'
      ? '连接成功'
      : c?.status === 'failed'
        ? '连接失败'
        : c?.status === 'unconfigured'
          ? '配置未就绪'
          : '尚未测试';
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${client.name} 连接状态`}
      className="space-y-1 rounded-md bg-muted/60 p-3 text-sm"
    >
      <strong>{title}</strong>
      {!testing && c?.status === 'connected' ? (
        <span className="ml-2">{c.tools_count ?? 0} 个可用工具</span>
      ) : null}
      {!testing && c?.error ? <p className="break-words text-destructive">{c.error}</p> : null}
      {!testing && c?.checked_at ? (
        <p className="text-xs text-muted-foreground">
          {c.environment} · {new Date(c.checked_at).toLocaleTimeString('zh-CN', { hour12: false })}{' '}
          验证 · {c.duration_ms} ms
        </p>
      ) : !testing && !c ? (
        <p className="text-xs text-muted-foreground">
          {client.status === 'available'
            ? '安装后自动进行 MCP 连接验证'
            : client.status === 'external'
              ? '验证 MCP 服务；导入结果请在目标工具中确认'
              : '验证 MCP 握手和工具列表'}
        </p>
      ) : null}
    </div>
  );
}

export default function AIToolsPage() {
  const [target, setTarget] = useState('local');
  const [installing, setInstalling] = useState(false);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);
  const locks = useRef(new Set<string>());
  const installingRef = useRef(false);
  const external = useRef<{ id: string; target: string } | null>(null);
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: aiKey(target),
    queryFn: ({ signal }) =>
      api<AIConfig>(`/ai-tools?target=${encodeURIComponent(target)}`, { signal }),
    refetchOnWindowFocus: false,
  });
  const updateClient = useCallback(
    (selected: string, id: string, patch: Partial<AIClient>) => {
      queryClient.setQueryData<AIConfig>(aiKey(selected), (old) =>
        old
          ? { ...old, clients: old.clients.map((c) => (c.id === id ? { ...c, ...patch } : c)) }
          : old,
      );
    },
    [queryClient],
  );
  const testConnection = useCallback(
    async (id: string, selected: string) => {
      const key = `${selected}/${id}`;
      if (locks.current.has(key) || installingRef.current) return;
      locks.current.add(key);
      setTesting(new Set(locks.current));
      try {
        const connection = await json<Connection>(`/ai-tools/${encodeURIComponent(id)}/test`, {
          target: selected,
        });
        updateClient(selected, id, { connection });
      } catch (e) {
        updateClient(selected, id, {
          connection: {
            status: 'failed',
            error: `连接测试失败：${e instanceof Error ? e.message : String(e)}`,
          },
        });
      } finally {
        locks.current.delete(key);
        setTesting(new Set(locks.current));
      }
    },
    [updateClient],
  );
  useEffect(() => {
    if (!q.data || q.isFetching || installingRef.current) return;
    for (const client of q.data.clients)
      if (client.status === 'configured' && !client.connection)
        void testConnection(client.id, q.data.target);
  }, [q.data, q.isFetching, testConnection]);
  useEffect(() => {
    const verify = () => {
      if (document.visibilityState === 'hidden' || !external.current || installingRef.current)
        return;
      const pending = external.current;
      external.current = null;
      void testConnection(pending.id, pending.target);
    };
    window.addEventListener('focus', verify);
    document.addEventListener('visibilitychange', verify);
    return () => {
      window.removeEventListener('focus', verify);
      document.removeEventListener('visibilitychange', verify);
    };
  }, [testConnection]);
  const install = async (client: AIClient) => {
    const selected = q.data?.target || target,
      key = `${selected}/${client.id}`;
    if (
      installingRef.current ||
      q.isFetching ||
      locks.current.has(key) ||
      client.status !== 'available'
    )
      return;
    installingRef.current = true;
    setInstalling(true);
    setError(null);
    setMessage('正在安装并验证 MCP 连接…');
    locks.current.add(key);
    setTesting(new Set(locks.current));
    try {
      const result = await json<{ status: string; backup?: string; connection?: Connection }>(
        `/ai-tools/${encodeURIComponent(client.id)}/install`,
        { target: selected },
      );
      updateClient(selected, client.id, { status: 'configured', connection: result.connection });
      const connected = result.connection?.status === 'connected';
      setMessage(
        `${result.status === 'installed' ? '安装完成' : '已配置'}。${connected ? `连接成功，${result.connection?.tools_count ?? 0} 个可用工具。` : `配置已保存，连接验证未通过：${result.connection?.error || '请点击“测试连接”重试'}。`}请在 AI 工具中重新加载 MCP 或重启会话，并确认启用 apix。${result.backup ? ` 原配置备份：${result.backup}` : ''}`,
      );
      await queryClient.invalidateQueries({ queryKey: aiKey(selected) });
    } catch (e) {
      setMessage('');
      setError(e);
    } finally {
      locks.current.delete(key);
      setTesting(new Set(locks.current));
      installingRef.current = false;
      setInstalling(false);
    }
  };
  const copy = async (snippet: string) => {
    try {
      await navigator.clipboard.writeText(snippet);
      setMessage('已复制配置');
    } catch {
      setMessage('浏览器无法访问剪贴板，请从配置区域手动选择并复制。');
    }
  };
  const data = q.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title="AI 工具"
        description="将 Apix 接入常用 AI 工具，让 AI 调试接口、查询数据库和管理服务。"
        actions={
          <Button
            variant="outline"
            disabled={q.isFetching || installing}
            onClick={() => {
              setError(null);
              setMessage('');
              void q.refetch();
            }}
          >
            重新检测
          </Button>
        }
      />
      <Card>
        <CardContent className="space-y-4 pt-5">
          <SelectField
            label="目标系统"
            value={target}
            disabled={q.isFetching || installing}
            onValueChange={(v) => {
              setTarget(v);
              setError(null);
              setMessage('');
            }}
            options={
              data?.targets.map((t) => ({ value: t.id, label: `${t.name} · ${t.home}` })) || [
                { value: 'local', label: '本地系统' },
              ]
            }
          />
          <div className="text-sm">
            <span className="text-muted-foreground">MCP 地址：</span>
            <code className="break-all">{data?.endpoint || '正在读取…'}</code>
          </div>
        </CardContent>
      </Card>
      {q.error ? <ErrorAlert error={q.error} /> : null}
      {error ? <ErrorAlert error={error} /> : null}
      {message ? (
        <p role="status" className="rounded-md border bg-muted/40 p-3 text-sm">
          {message}
        </p>
      ) : null}
      {q.isPending ? (
        <EmptyState title="正在检测 AI 工具…" />
      ) : !data ? (
        <EmptyState title="暂时无法读取安装配置" description="请点击重新检测重试。" />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2" aria-busy={installing}>
          {data.clients.map((client) => {
            const checking = testing.has(`${data.target}/${client.id}`),
              busy = installing || q.isFetching || checking;
            return (
              <Card key={client.id}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="text-base">{client.name}</CardTitle>
                    <Badge variant={client.status === 'configured' ? 'default' : 'secondary'}>
                      {labels[client.status] || client.status}
                    </Badge>
                  </div>
                  <CardDescription>
                    {client.id === 'claude'
                      ? 'Claude Code 的用户级配置，适用于 CLI 和 Code 会话。'
                      : client.status === 'external'
                        ? '在目标工具中确认导入，返回后自动测试所选环境的 MCP 连接。'
                        : '添加用户级 MCP 连接，在各项目中使用 Apix。'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {client.path ? (
                    <code className="block break-all text-xs text-muted-foreground">
                      {client.path}
                    </code>
                  ) : null}
                  {client.error ? (
                    <p className="break-words text-sm text-destructive">{client.error}</p>
                  ) : null}
                  <ConnectionStatus client={client} testing={checking} />
                  <details className="space-y-2">
                    <summary className="cursor-pointer text-sm font-medium">
                      查看配置 / 手动安装
                    </summary>
                    <CodeBlock value={client.snippet} />
                    <Button size="sm" variant="outline" onClick={() => void copy(client.snippet)}>
                      复制配置
                    </Button>
                  </details>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`${client.name}：测试连接`}
                      disabled={busy || !['configured', 'external'].includes(client.status)}
                      onClick={() => void testConnection(client.id, data.target)}
                    >
                      {checking ? '测试中…' : client.connection ? '重新测试' : '测试连接'}
                    </Button>
                    {client.links ? (
                      Object.entries(client.links)
                        .filter(([, href]) => /^(https?:|trae:|trae-cn:)/i.test(href))
                        .map(([name, href]) => (
                          <Button key={name} size="sm" asChild>
                            <a
                              href={href}
                              onClick={() => {
                                external.current = { id: client.id, target: data.target };
                                setMessage(
                                  '请在目标工具中确认导入，返回后自动测试所选环境的 MCP 连接；也可点击“测试连接”。',
                                );
                              }}
                            >
                              安装到 {name}
                            </a>
                          </Button>
                        ))
                    ) : client.status === 'external' ? (
                      <p className="text-xs text-muted-foreground">
                        请按配置说明在目标工具中手动安装。
                      </p>
                    ) : (
                      <Button
                        size="sm"
                        aria-label={`${client.name}：${client.status === 'configured' ? '已配置' : client.status === 'blocked' ? '请检查配置' : '一键安装'}`}
                        disabled={busy || client.status !== 'available'}
                        onClick={() => void install(client)}
                      >
                        {installing && checking
                          ? '安装中…'
                          : client.status === 'configured'
                            ? '已配置'
                            : client.status === 'blocked'
                              ? '请检查配置'
                              : '一键安装'}
                      </Button>
                    )}
                    {['configured', 'blocked', 'external'].includes(client.status) ? (
                      <AIRemoval
                        client={client}
                        target={data.target}
                        onChanged={() =>
                          queryClient.invalidateQueries({ queryKey: aiKey(data.target) })
                        }
                      />
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
