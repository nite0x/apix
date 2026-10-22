import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, json } from '@/lib/api';
import { useDirty } from '@/lib/use-dirty';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CodeBlock, ConfirmDialog, ErrorAlert, Field, SelectField } from '@/components/shared';
interface EditorProps {
  item?: any;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onSaved?: (batchID?: string) => void | Promise<void>;
  batchID?: string;
}
export function HTTPCaseEditor({ item, open, onOpenChange, onSaved, batchID }: EditorProps) {
  const [value, setValue] = useState<any>({});
  const [headers, setHeaders] = useState('{}');
  const [query, setQuery] = useState('[]');
  const [assertions, setAssertions] = useState('[]');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const lock = useRef(false);
  const client = useQueryClient();
  useDirty(open && dirty);
  useEffect(() => {
    if (open) {
      setValue(
        structuredClone({
          type: 'http',
          name: '',
          description: '',
          assertions: [],
          ...item,
          request: {
            method: 'GET',
            url: '',
            body_type: 'none',
            body: '',
            headers: [],
            query_params: [],
            ...item?.request,
          },
        }),
      );
      setHeaders(
        JSON.stringify(
          Object.fromEntries(
            (item?.request?.headers || [])
              .filter((pair: any) => pair.enabled)
              .map((pair: any) => [pair.name, pair.value]),
          ),
          null,
          2,
        ),
      );
      setQuery(JSON.stringify(item?.request?.query_params || [], null, 2));
      setAssertions(JSON.stringify(item?.assertions || [], null, 2));
      setDirty(false);
      setError(null);
    }
  }, [open, item]);
  const close = (next: boolean) => {
    if (pending) return;
    if (!next && dirty) {
      setConfirmClose(true);
      return;
    }
    onOpenChange(next);
  };
  const patch = (part: any) => {
    setValue((old: any) => ({ ...old, ...part }));
    setDirty(true);
  };
  const request = (part: any) => patch({ request: { ...value.request, ...part } });
  const submit = async (intent: 'save' | 'run') => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      const headerValues = JSON.parse(headers || '{}');
      if (
        !headerValues ||
        Array.isArray(headerValues) ||
        typeof headerValues !== 'object' ||
        Object.values(headerValues).some((v) => typeof v !== 'string')
      )
        throw new Error('请求头需要是值为字符串的 JSON 对象。');
      const queryValues = JSON.parse(query || '[]');
      if (!Array.isArray(queryValues)) throw new Error('查询参数需要是 JSON 数组。');
      const definitions = JSON.parse(assertions || '[]');
      if (!Array.isArray(definitions)) throw new Error('响应断言需要是 JSON 数组。');
      if (!value.name?.trim() || !value.request?.url?.trim())
        throw new Error('请填写用例名称和请求地址。');
      const expected = value.expected_status;
      if (
        expected !== undefined &&
        expected !== '' &&
        (!Number.isInteger(Number(expected)) || Number(expected) < 100 || Number(expected) > 599)
      )
        throw new Error('HTTP 状态码范围为 100–599。');
      const payload = {
        ...value,
        type: 'http',
        request: {
          ...value.request,
          headers:
            headers ===
            JSON.stringify(
              Object.fromEntries(
                (item?.request?.headers || [])
                  .filter((pair: any) => pair.enabled)
                  .map((pair: any) => [pair.name, pair.value]),
              ),
              null,
              2,
            )
              ? item?.request?.headers || []
              : [
                  ...(item?.request?.headers || []).filter((pair: any) => !pair.enabled),
                  ...Object.entries(headerValues).map(([name, value]) => ({
                    name,
                    value,
                    enabled: true,
                  })),
                ],
          query_params: queryValues,
        },
        assertions: definitions,
        expected_status: expected === undefined || expected === '' ? undefined : Number(expected),
      };
      if (intent === 'save') {
        await json(
          value.id ? `/test-cases/${encodeURIComponent(value.id)}` : '/test-cases',
          payload,
          value.id ? 'PUT' : 'POST',
        );
        setDirty(false);
        await client.invalidateQueries({ queryKey: ['test-cases'] });
        await onSaved?.();
        onOpenChange(false);
      } else {
        const batch = batchID
          ? { id: batchID }
          : await json<any>('/test-batches', { name: value.name });
        await json(`/test-batches/${encodeURIComponent(batch.id)}/runs`, { test_case: payload });
        if (!batchID) await json(`/test-batches/${encodeURIComponent(batch.id)}/finish`, {});
        setDirty(false);
        await onSaved?.(batch.id);
        onOpenChange(false);
      }
    } catch (issue) {
      setError(
        (issue as any)?.status === 409
          ? new Error(
              '用例在其他位置发生了变更，当前草稿已保留。可关闭后重新载入，或复制为新用例。',
            )
          : issue,
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit('save');
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {value.id ? '编辑测试用例' : batchID ? '添加本次 HTTP 测试' : '新建 HTTP 测试用例'}
              </DialogTitle>
              <DialogDescription>保存请求副本与断言，可独立重复运行。</DialogDescription>
            </DialogHeader>
            <fieldset disabled={pending} className="my-5 space-y-4">
              <Field label="用例名称">
                <Input
                  aria-label="用例名称"
                  required
                  value={value.name || ''}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
              <Field label="说明">
                <Input
                  aria-label="说明"
                  value={value.description || ''}
                  onChange={(e) => patch({ description: e.target.value })}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-[130px_1fr]">
                <SelectField
                  label="请求方法"
                  value={value.request?.method || 'GET'}
                  onValueChange={(method) => request({ method })}
                  options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(
                    (method) => ({ value: method, label: method }),
                  )}
                />
                <Field label="请求地址">
                  <Input
                    aria-label="请求地址"
                    required
                    value={value.request?.url || ''}
                    onChange={(e) => request({ url: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="请求头（JSON 对象）">
                <Textarea
                  aria-label="请求头（JSON 对象）"
                  className="font-mono text-xs"
                  value={headers}
                  onChange={(e) => {
                    setHeaders(e.target.value);
                    setDirty(true);
                  }}
                />
              </Field>
              <Field label="查询参数（JSON 数组）">
                <Textarea
                  aria-label="查询参数（JSON 数组）"
                  className="font-mono text-xs"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setDirty(true);
                  }}
                />
              </Field>
              <SelectField
                label="正文类型"
                value={value.request?.body_type || 'none'}
                onValueChange={(body_type) => request({ body_type })}
                options={[
                  { value: 'none', label: '无正文' },
                  { value: 'json', label: 'JSON' },
                  { value: 'text', label: '文本' },
                  { value: 'form', label: '表单' },
                ]}
              />
              <Field label="请求正文">
                <Textarea
                  aria-label="请求正文"
                  rows={5}
                  className="font-mono text-xs"
                  value={value.request?.body || ''}
                  onChange={(e) => request({ body: e.target.value })}
                />
              </Field>
              <Field label="预期状态码" description="可留空，没有断言时标记为未验证。">
                <Input
                  aria-label="预期状态码"
                  type="number"
                  min={100}
                  max={599}
                  value={value.expected_status ?? ''}
                  onChange={(e) => patch({ expected_status: e.target.value })}
                />
              </Field>
              <Field
                label="响应断言（JSON 数组）"
                description="来源支持 body、header、status；比较支持 equals、not_equals、contains、exists。"
              >
                <Textarea
                  aria-label="响应断言（JSON 数组）"
                  rows={5}
                  className="font-mono text-xs"
                  value={assertions}
                  onChange={(e) => {
                    setAssertions(e.target.value);
                    setDirty(true);
                  }}
                />
              </Field>
              <details>
                <summary className="cursor-pointer text-sm">查看断言示例</summary>
                <CodeBlock
                  value={[
                    {
                      source: 'body',
                      path: 'error.code',
                      operator: 'equals',
                      expected: 'INVALID_EMAIL',
                    },
                  ]}
                />
              </details>
              {JSON.stringify(value.request || {}).includes('••••') ? (
                <p role="status" className="text-sm text-amber-700">
                  请求来自脱敏快照，请替换脱敏字段后再执行。
                </p>
              ) : null}
            </fieldset>
            <ErrorAlert error={error} />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => close(false)}
              >
                取消
              </Button>
              {!value.id ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void submit('run')}
                >
                  {batchID ? '运行到当前批次' : '仅运行本次'}
                </Button>
              ) : null}
              <Button disabled={pending}>{value.id ? '保存修改' : '保存用例'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="放弃用例修改？"
        description="关闭后将丢弃本次未保存的编辑。"
        onConfirm={() => {
          setDirty(false);
          onOpenChange(false);
        }}
      />
    </>
  );
}
export function RunCasesDialog({
  ids,
  open,
  onOpenChange,
  onFinished,
}: {
  ids: string[];
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onFinished?: (batchID: string) => void | Promise<void>;
}) {
  const [target, setTarget] = useState('new');
  const [name, setName] = useState('用例回归');
  const [variables, setVariables] = useState('{}');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [resultID, setResultID] = useState('');
  const lock = useRef(false);
  const client = useQueryClient();
  const batches = useQuery({
    queryKey: ['test-batches'],
    queryFn: ({ signal }) => api<any[]>('/test-batches', { signal }),
    enabled: open,
  });
  useEffect(() => {
    if (open) {
      setTarget('new');
      setName(`用例回归 · ${new Date().toLocaleString('zh-CN')}`);
      setVariables('{}');
      setError(null);
      setFailures([]);
      setResultID('');
    }
  }, [open]);
  const execute = async () => {
    if (lock.current || !ids.length) return;
    lock.current = true;
    setPending(true);
    setError(null);
    setFailures([]);
    try {
      const values = JSON.parse(variables);
      if (
        !values ||
        Array.isArray(values) ||
        typeof values !== 'object' ||
        Object.values(values).some((value) => typeof value !== 'string')
      )
        throw new Error('变量需要是值为字符串的 JSON 对象。');
      if (target === 'new' && !name.trim()) throw new Error('请填写批次名称。');
      const batch = target === 'new' ? await json<any>('/test-batches', { name }) : { id: target };
      setResultID(batch.id);
      const issues: string[] = [];
      for (const id of ids) {
        try {
          await json(`/test-batches/${encodeURIComponent(batch.id)}/runs`, {
            case_id: id,
            variables: values,
          });
        } catch (issue) {
          issues.push(`${id}：${issue instanceof Error ? issue.message : String(issue)}`);
        }
        await client.invalidateQueries({ queryKey: ['test-batch', batch.id] });
      }
      if (target === 'new') await json(`/test-batches/${encodeURIComponent(batch.id)}/finish`, {});
      await client.invalidateQueries({ queryKey: ['execution-records'] });
      if (issues.length) {
        setFailures(issues);
        return;
      }
      onOpenChange(false);
      await onFinished?.(batch.id);
    } catch (issue) {
      setError(issue);
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!pending) onOpenChange(value);
      }}
    >
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void execute();
          }}
        >
          <DialogHeader>
            <DialogTitle>运行 {ids.length} 个测试用例</DialogTitle>
            <DialogDescription>
              用例独立执行，不传递前一次响应。新批次运行后自动结束。
            </DialogDescription>
          </DialogHeader>
          <fieldset disabled={pending} className="my-5 space-y-4">
            <SelectField
              label="运行到"
              value={target}
              onValueChange={setTarget}
              options={[
                { value: 'new', label: '新建测试批次' },
                ...(batches.data || [])
                  .filter((item) => item.source !== 'flow' && item.status === 'running')
                  .map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
            {target === 'new' ? (
              <Field label="新批次名称">
                <Input
                  aria-label="新批次名称"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            ) : null}
            <Field label="运行变量（JSON 对象）">
              <Textarea
                aria-label="运行变量（JSON 对象）"
                className="font-mono text-xs"
                value={variables}
                onChange={(e) => setVariables(e.target.value)}
              />
            </Field>
          </fieldset>
          <ErrorAlert error={error || batches.error} />
          {failures.length ? (
            <div role="alert" className="my-4 space-y-2">
              <p className="text-sm font-medium">部分用例未能运行，已完成结果已保存：</p>
              {failures.map((text, i) => (
                <p key={i} className="break-all text-xs text-destructive">
                  {text}
                </p>
              ))}
              {resultID ? (
                <Button variant="outline" asChild>
                  <Link to={`/execution-records?batch=${encodeURIComponent(resultID)}`}>
                    查看已保存结果
                  </Link>
                </Button>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              关闭
            </Button>
            <Button disabled={pending || !!resultID}>{pending ? '正在执行…' : '开始测试'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
