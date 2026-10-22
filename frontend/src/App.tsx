import { lazy, Suspense, useEffect, useState } from 'react';
import { createBrowserRouter, redirect, Link, NavLink, Outlet, useLocation, useRouteError } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, Bot, Braces, CheckCheck, Database, FileClock, Home, ListTree, Menu, PanelLeftClose, RefreshCw, Server, Terminal, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { canonicalLocation } from '@/lib/routes';
import { useActivity } from '@/lib/activity';
import { DirtyProvider } from '@/lib/use-dirty';
import { cn } from '@/lib/utils';
const ServicesPage = lazy(() => import('@/pages/services'));
const HomePage = lazy(() => import('@/pages/home'));
const RequestsPage = lazy(() => import('@/pages/requests'));
const DatabasesPage = lazy(() => import('@/pages/databases'));
const MCPPage = lazy(() => import('@/pages/mcp'));
const CommandsPage = lazy(() => import('@/pages/commands'));
const AIToolsPage = lazy(() => import('@/pages/ai-tools'));
const LogsPage = lazy(() => import('@/pages/logs'));
const TestingPage = lazy(() => import('@/pages/testing'));
const FlowsPage = lazy(() => import('@/pages/flows'));
const RecordsPage = lazy(() => import('@/pages/records'));
import { ErrorAlert, PageHeader } from '@/components/shared';

const navigation = [
  ['/', '主页', Home], ['/services', '服务', Server], ['/requests', '接口', Braces], ['/databases', '数据库', Database], ['/mcp-tools', 'MCP 工具', Workflow], ['/commands', '命令行', Terminal], ['/tests', '已保存用例', CheckCheck], ['/flows', '流程', ListTree], ['/execution-records', '执行记录', FileClock], ['/logs', '日志', Activity], ['/ai-tools', 'AI 工具', Bot],
] as const;

function AppShell() {
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('apix.sidebar.collapsed') === 'true'; } catch { return false; } });
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation(); const client = useQueryClient(); const activity = useActivity();
  useEffect(() => { setMobileOpen(false); const title = navigation.find(([path]) => path === location.pathname)?.[1] || '工作台'; document.title = `Apix · ${title}`; document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true }); }, [location.pathname]);
  function toggle() { setCollapsed(v => { try { localStorage.setItem('apix.sidebar.collapsed', String(!v)); } catch { /* Storage is optional. */ } return !v; }); }
  return <DirtyProvider><TooltipProvider><div className="min-h-screen md:flex">
    {mobileOpen && <button aria-label="收起侧边栏" className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setMobileOpen(false)} />}
    <aside aria-label="工作台导航" className={cn('fixed inset-y-0 left-0 z-40 flex flex-col border-r bg-card transition-[width,transform] md:sticky md:top-0 md:h-screen', collapsed ? 'w-16' : 'w-48', mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0')}>
      <Link to="/" className="flex h-14 shrink-0 items-center gap-2 border-b px-5" aria-label="Apix 主页"><span className="text-2xl font-bold tracking-tighter text-primary">a·</span>{!collapsed && <strong className="text-lg tracking-tight">apix</strong>}</Link>
      {!collapsed && <p className="px-4 pt-5 pb-2 text-[10px] font-semibold tracking-widest text-muted-foreground">工作空间</p>}
      <nav aria-label="主导航" className="flex-1 space-y-1 overflow-y-auto p-2">{navigation.map(([path, label, Icon]) => <NavLink key={path} to={path} end={path === '/'} title={collapsed ? label : undefined} aria-label={label} className={({ isActive }) => cn('flex min-h-9 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted', isActive ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground', collapsed && 'justify-center px-2')}><Icon className="size-4 shrink-0" />{!collapsed && <span>{label}</span>}</NavLink>)}</nav>
      <Button variant="ghost" className="m-2 justify-start" aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'} aria-expanded={!collapsed} onClick={toggle}><PanelLeftClose className="size-4" />{!collapsed && '折叠侧边栏'}</Button>
    </aside>
    <div className="min-w-0 flex-1"><header className="flex h-14 items-center justify-between gap-3 border-b bg-card px-4 md:px-6"><div className="flex items-center gap-2"><Button size="icon" variant="ghost" className="md:hidden" aria-label="打开导航" onClick={() => setMobileOpen(true)}><Menu /></Button><span className="text-xs text-muted-foreground">本地测试工作台</span></div><div className="flex items-center gap-3"><span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className={cn('size-1.5 rounded-full', activity.isError ? 'bg-destructive' : activity.data ? 'bg-primary' : 'bg-amber-500')} />{activity.isError ? '连接中断，正在重试' : activity.data ? '实时同步中' : '正在连接'}</span><Button size="sm" variant="outline" aria-label="刷新工作台" onClick={() => void client.invalidateQueries()}><RefreshCw className="size-3.5" />刷新</Button></div></header><main id="main-content" className="mx-auto max-w-[1680px] space-y-5 p-4 md:p-6"><Suspense fallback={<Skeleton className="h-64 w-full" />}><Outlet /></Suspense></main><footer className="px-6 pb-4 text-[10px] text-muted-foreground">Apix · 本地工作台</footer></div>
  </div></TooltipProvider></DirtyProvider>;
}
function NotFoundPage() { return <div className="stack"><PageHeader title="页面未找到" description="请从侧栏选择工作台页面。" /><Button asChild><Link to="/">返回主页</Link></Button></div>; }
function RouteError() { return <main className="mx-auto max-w-3xl space-y-4 p-8"><PageHeader title="页面暂时无法加载" /><ErrorAlert error={useRouteError()} /><Button asChild><Link to="/">返回主页</Link></Button></main>; }
function legacyLoader({ request }: { request: Request }) { const url = new URL(request.url); const canonical = canonicalLocation(url.pathname, url.search); return canonical ? redirect(canonical) : null; }
export const router = createBrowserRouter([{ element: <AppShell />, errorElement: <RouteError />, children: [{ path: '/', element: <HomePage /> }, { path: '/services', element: <ServicesPage /> }, { path: '/requests', element: <RequestsPage /> }, { path: '/databases', element: <DatabasesPage /> }, { path: '/mcp-tools', element: <MCPPage /> }, { path: '/commands', element: <CommandsPage /> }, { path: '/ai-tools', element: <AIToolsPage /> }, { path: '/logs', element: <LogsPage /> }, { path: '/tests', loader: legacyLoader, element: <TestingPage /> }, { path: '/flows', loader: legacyLoader, element: <FlowsPage /> }, { path: '/execution-records', loader: legacyLoader, element: <RecordsPage /> }, { path: '/test-collections', loader: legacyLoader, element: <RecordsPage /> }, { path: '/activity', loader: legacyLoader, element: <HomePage /> }, { path: '*', element: <NotFoundPage /> }] }]);
