import { useRef, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ErrorAlert } from '@/components/shared';
import { json } from '@/lib/api';

export const paths: Record<string, string> = { service: '/services', database: '/database/connections', mcp: '/mcp-servers', request: '/requests', collection: '/collections', test_case: '/test-cases', flow: '/flows' };
export const labels: Record<string, string> = { service: '服务配置', database: '数据库连接', mcp: 'MCP 服务器连接', request: '接口', collection: '接口分组', test_case: '独立用例', flow: '业务流程' };
export type Changed = () => unknown | Promise<unknown>;
export interface Resource { id: string; name: string; summary?: string; archived?: boolean; credentials_cleared?: boolean; status?: string; [key: string]: unknown }
export interface ActionResult { id: string; status: string; error?: string; new_id?: string }
export function useTask() {
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (task: () => unknown | Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try { await task(); } catch (e) { setError(e); } finally { lock.current = false; setPending(false); }
  };
  return { pending, error, setError, run };
}
export function Modal({ open, onOpenChange, title, description, children, pending = false }: { open: boolean; onOpenChange: (v: boolean) => void; title: string; description?: string; children: ReactNode; pending?: boolean }) {
  return <Dialog open={open} onOpenChange={v => { if (!pending) onOpenChange(v); }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" onEscapeKeyDown={e => { if (pending) e.preventDefault(); }} onPointerDownOutside={e => { if (pending) e.preventDefault(); }}><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description || '查看操作范围，确认后执行。'}</DialogDescription></DialogHeader><div className="space-y-4">{children}</div></DialogContent></Dialog>;
}
export function TaskError({ error }: { error: unknown }) { return error ? <ErrorAlert error={error} /> : null; }
export function ActionReport({ items }: { items: ActionResult[] }) {
  return items.length ? <div role="status" className="space-y-2 rounded-md border p-3"><h3 className="font-medium">逐项操作结果</h3>{items.map((r, i) => <p key={`${r.id}-${i}`} className="text-sm">{r.id}：{r.status === 'succeeded' ? '成功' : '失败'}{r.new_id ? `，副本 ID ${r.new_id}` : ''}{r.error ? ` · ${r.error}` : ''}</p>)}</div> : null;
}
export async function act(kind: string, id: string, action: string, extra: Record<string, unknown> = {}) {
  const result = await json<{ items: ActionResult[] }>('/lifecycle/actions', { items: [{ kind, id, action, ...extra }] });
  const row = result.items?.[0];
  if (!row || row.status !== 'succeeded') throw new Error(row?.error || '操作失败，请重新读取资源状态。');
  return row;
}
export function OpenButton({ onClick, children, disabled = false }: { onClick: () => void; children: ReactNode; disabled?: boolean }) { return <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onClick}>{children}</Button>; }
