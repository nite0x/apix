import { useId, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Inbox } from 'lucide-react';
import { errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="toolbar">{actions}</div>}
    </div>
  );
}
export function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid min-w-0 gap-1.5 text-sm font-medium">
      <span>{label}</span>
      {children}
      {description && (
        <span className="text-xs font-normal leading-5 text-muted-foreground">{description}</span>
      )}
    </label>
  );
}
export function SelectField({
  label,
  value,
  onValueChange,
  options,
  disabled,
  placeholder,
}: {
  label?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  // Radix reserves an empty value for the placeholder; map API filter values locally.
  const sentinel = '__apix_empty__';
  const select = (
    <Select
      value={value || sentinel}
      onValueChange={(v) => onValueChange(v === sentinel ? '' : v)}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={label || placeholder || '选择'} className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value || sentinel} value={option.value || sentinel}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return label ? (
    <div className="grid min-w-36 gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {select}
    </div>
  ) : (
    select
  );
}
export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle className="size-4" />
      <AlertDescription>{errorMessage(error)}</AlertDescription>
    </Alert>
  );
}
export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-10 text-center text-muted-foreground">
      <Inbox className="mb-1 size-7 opacity-50" />
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-lg text-xs leading-5">{description}</p>}
    </div>
  );
}
export function CodeBlock({ value }: { value: unknown }) {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '—');
  } catch {
    text = String(value);
  }
  return (
    <pre
      tabIndex={0}
      className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-3 text-xs leading-5"
    >
      {text}
    </pre>
  );
}
export const JsonView = CodeBlock;
const statuses: Record<string, string> = {
  running: '运行中',
  starting: '启动中',
  stopping: '停止中',
  stopped: '已停止',
  cleanup_failed: '清理失败',
  failed: '失败',
  error: '执行错误',
  passed: '通过',
  succeeded: '已完成',
  completed: '已结束',
  cancelled: '已取消',
  timed_out: '超时',
  interrupted: '已中断',
  unverified: '未验证',
  active: '有效',
  archived: '已归档',
};
export function StatusBadge({ status }: { status: string }) {
  const failed = ['failed', 'error', 'cleanup_failed', 'timed_out'].includes(status);
  return (
    <Badge
      variant={
        failed
          ? 'destructive'
          : ['running', 'passed', 'succeeded'].includes(status)
            ? 'default'
            : 'secondary'
      }
    >
      {statuses[status] || status || '—'}
    </Badge>
  );
}
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  onConfirm,
  pending = false,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description: string;
  children?: ReactNode;
  onConfirm: () => void | Promise<void>;
  pending?: boolean;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>();
  const lock = useRef(false);
  async function confirm() {
    if (lock.current || pending) return;
    lock.current = true;
    setWorking(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!working && !pending) onOpenChange(value);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <ErrorAlert error={error} />
        <DialogFooter>
          <Button
            variant="outline"
            disabled={working || pending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={working || pending}
            onClick={() => void confirm()}
          >
            {working || pending ? '处理中…' : '确认'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
