import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  Bot,
  Braces,
  Database,
  FileClock,
  Server,
  Terminal,
  Workflow,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorAlert, PageHeader } from '@/components/shared';
import { useActivity } from '@/lib/activity';

const entries = [
  ['/services', '服务', '管理本地启动配置，查看服务状态与运行日志。', Server],
  ['/requests', '接口', '调试 HTTP 请求，保存接口与分组，查看执行记录。', Braces],
  ['/databases', '数据库', '管理连接，执行 SQL，查看查询结果和历史。', Database],
  ['/mcp-tools', 'MCP 工具', '连接 MCP 服务器，发现并调试工具。', Workflow],
  ['/commands', '命令行', '运行命令和脚本，验证输出并保存测试用例。', Terminal],
  ['/tests', '已保存用例', '管理可重复运行的 HTTP、MCP 和命令行用例。', FileClock],
  ['/logs', '日志', '实时查看运行事件及服务输出，按来源筛选。', FileClock],
  ['/ai-tools', 'AI 工具', '将 Apix 接入 Codex、Claude Code、Cursor 等工具。', Bot],
] as const;
export default function HomePage() {
  const q = useActivity();
  const d = q.data;
  return (
    <div className="space-y-6">
      <PageHeader title="主页" description="本地运行概况，从这里进入服务、接口和测试工作空间。" />
      <ErrorAlert error={q.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          [
            '/services',
            '运行中的服务',
            d?.running_services,
            `共 ${d?.services?.length ?? 0} 个已配置`,
          ],
          ['/requests', '最近接口执行', d?.requests?.length, '最近 50 条记录'],
          ['/logs', '已接收日志', d?.total_logs, '本次工作台接收'],
        ].map(([href, label, value, note]) => (
          <Link key={String(href)} to={String(href)}>
            <Card className="h-full gap-3 py-4 transition-shadow hover:shadow-sm">
              <CardHeader className="px-4">
                <CardDescription>{label}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-end gap-3 px-4">
                {q.isPending ? (
                  <Skeleton className="h-9 w-12" />
                ) : (
                  <strong className="text-3xl font-semibold tracking-tight">{value ?? '—'}</strong>
                )}
                <span className="pb-1 text-xs text-muted-foreground">{note}</span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {entries.map(([path, title, description, Icon]) => (
          <Card key={path} className="gap-4 py-5">
            <CardHeader className="px-5">
              <Icon className="mb-2 size-5 text-primary" />
              <CardTitle className="text-base">{title}</CardTitle>
              <CardDescription className="min-h-10 leading-5">{description}</CardDescription>
            </CardHeader>
            <CardContent className="px-5">
              <Button asChild variant="link" className="h-auto p-0">
                <Link to={path}>
                  打开{title}
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
