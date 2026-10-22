import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, json } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BulkManager, ResourceActions } from '@/components/lifecycle';
import { CodeBlock, EmptyState, ErrorAlert, PageHeader, SelectField } from '@/components/shared';
import { CommandCaseEditor } from '@/pages/commands';
import { MCPCaseEditor } from '@/pages/mcp';
import { HTTPCaseEditor, RunCasesDialog } from './case-editor';
export default function TestingPage() {
  const [params, setParams] = useSearchParams();
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<any>(null);
  const [kind, setKind] = useState('');
  const [runIDs, setRunIDs] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const client = useQueryClient();
  const navigate = useNavigate();
  const cases = useQuery({
    queryKey: ['test-cases', archived],
    queryFn: ({ signal }) =>
      api<any[]>(`/test-cases${archived ? '?archived=true' : ''}`, { signal }),
  });
  const detailID = params.get('id') || '';
  const detail = useQuery({
    queryKey: ['test-case', detailID],
    queryFn: ({ signal }) => api<any>(`/test-cases/${encodeURIComponent(detailID)}`, { signal }),
    enabled: !!detailID,
  });
  useEffect(() => {
    setSelected(new Set());
  }, [archived]);
  useEffect(() => {
    if (cases.data)
      setSelected(
        (old) =>
          new Set(
            [...old].filter((id) => cases.data.some((item) => item.id === id && !item.archived)),
          ),
      );
  }, [cases.data]);
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['test-cases'] }),
      client.invalidateQueries({ queryKey: ['test-case'] }),
    ]);
  };
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => json(path, body || {}),
    onSuccess: refresh,
    onError: setError,
  });
  const openEditor = (item: any) => {
    setEditor(item);
    setKind(item.type || 'http');
  };
  const changed = async (batchID?: string) => {
    await refresh();
    if (batchID) navigate(`/execution-records?batch=${encodeURIComponent(batchID)}`);
  };
  const items = (cases.data || []).filter(
    (item) =>
      (type === 'all' || (item.type || 'http') === type) &&
      `${item.name} ${item.description} ${item.id}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="space-y-5">
      <PageHeader
        title="已保存用例"
        description="管理、归档和重复运行 HTTP、MCP 与命令行用例。"
        actions={
          <>
            <BulkManager kind="test_case" onChanged={refresh} />
            <Button onClick={() => openEditor({ type: 'http', name: '' })}>新建 HTTP 用例</Button>
            <Button
              variant="outline"
              onClick={() => openEditor({ type: 'mcp', name: '', mcp_request: {} })}
            >
              新建 MCP 用例
            </Button>
            <Button
              variant="outline"
              onClick={() => openEditor({ type: 'command', name: '', command_request: {} })}
            >
              新建命令行用例
            </Button>
          </>
        }
      />
      <ErrorAlert error={cases.error || error} />
      <div className="flex flex-wrap items-end gap-3">
        <Input
          aria-label="搜索已保存用例"
          type="search"
          className="max-w-md"
          placeholder="名称、说明或用例 ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <SelectField
          label="用例类型"
          value={type}
          onValueChange={setType}
          options={[
            { value: 'all', label: '全部类型' },
            { value: 'http', label: 'HTTP' },
            { value: 'mcp', label: 'MCP' },
            { value: 'command', label: '命令行' },
          ]}
        />
        <Button variant="outline" onClick={() => setArchived(!archived)}>
          {archived ? '返回有效用例' : '已归档用例'}
        </Button>
        <Button variant="outline" onClick={() => cases.refetch()}>
          刷新
        </Button>
        <Button
          variant="outline"
          disabled={!items.length}
          onClick={() => setSelected(new Set(items.map((item) => item.id)))}
        >
          全选当前搜索结果
        </Button>
        <Button disabled={archived || !selected.size} onClick={() => setRunIDs([...selected])}>
          运行所选 {selected.size ? `(${selected.size})` : ''}
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {items.map((item) => (
          <Card key={item.id}>
            <CardHeader>
              <div className="flex items-start gap-3">
                <Checkbox
                  aria-label={`选择用例 ${item.name}`}
                  checked={selected.has(item.id)}
                  disabled={archived}
                  onCheckedChange={(checked) =>
                    setSelected((old) => {
                      const next = new Set(old);
                      if (checked === true) next.add(item.id);
                      else next.delete(item.id);
                      return next;
                    })
                  }
                />
                <div className="min-w-0 flex-1">
                  <CardTitle>
                    <Button
                      variant="link"
                      className="h-auto p-0 text-base"
                      onClick={() => setParams({ id: item.id })}
                    >
                      {item.name}
                    </Button>
                  </CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.type || 'http'} · v{item.edit_version} · {item.description || '无说明'}
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {item.needs_review ? (
                <p role="status" className="text-sm text-amber-700">
                  MCP 工具结构已变化，需检查并重新保存。
                </p>
              ) : null}
              {item.source_status && item.source_status !== 'active' ? (
                <p className="text-sm text-muted-foreground">
                  来源接口已归档或删除，保留请求副本。
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setParams({ id: item.id })}>
                  详情
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({ path: `/test-cases/${encodeURIComponent(item.id)}/duplicate` })
                  }
                >
                  复制
                </Button>
                {!item.archived ? (
                  <>
                    <Button variant="outline" size="sm" onClick={() => openEditor(item)}>
                      编辑
                    </Button>
                    <Button size="sm" onClick={() => setRunIDs([item.id])}>
                      运行
                    </Button>
                  </>
                ) : null}
                <ResourceActions
                  kind="test_case"
                  id={item.id}
                  name={item.name}
                  archived={item.archived}
                  onChanged={refresh}
                />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {!cases.isPending && !items.length ? (
        <EmptyState
          title="没有匹配的用例"
          description={
            archived
              ? '已归档用例可恢复后继续使用。'
              : '保存 HTTP、MCP 或命令行用例后，在这里查找和重复运行。'
          }
        />
      ) : null}
      <Dialog
        open={!!detailID}
        onOpenChange={(open) => {
          if (!open) setParams({});
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>用例详情 · {detail.data?.name || ''}</DialogTitle>
            <DialogDescription>持久化定义与来源状态</DialogDescription>
          </DialogHeader>
          <ErrorAlert error={detail.error} />
          {detail.data ? (
            <>
              <p className="text-sm text-muted-foreground">
                {detail.data.type || 'http'} · v{detail.data.edit_version} ·{' '}
                {detail.data.archived ? '已归档' : '使用中'}
                {detail.data.source_status ? ` · 来源接口：${detail.data.source_status}` : ''}
              </p>
              <CodeBlock value={detail.data} />
              {!detail.data.archived ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setParams({});
                      openEditor(detail.data);
                    }}
                  >
                    编辑用例
                  </Button>
                  <Button
                    onClick={() => {
                      setParams({});
                      setRunIDs([detailID]);
                    }}
                  >
                    运行用例
                  </Button>
                </div>
              ) : (
                <ResourceActions
                  kind="test_case"
                  id={detailID}
                  name={detail.data.name}
                  archived
                  onChanged={refresh}
                />
              )}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <HTTPCaseEditor
        item={editor}
        open={kind === 'http'}
        onOpenChange={(open) => {
          if (!open) setKind('');
        }}
        onSaved={changed}
      />
      <MCPCaseEditor
        item={editor}
        open={kind === 'mcp'}
        onOpenChange={(open) => {
          if (!open) setKind('');
        }}
        onSaved={changed}
      />
      <CommandCaseEditor
        item={editor}
        open={kind === 'command'}
        onOpenChange={(open) => {
          if (!open) setKind('');
        }}
        onSaved={changed}
      />
      <RunCasesDialog
        ids={runIDs}
        open={!!runIDs.length}
        onOpenChange={(open) => {
          if (!open) setRunIDs([]);
        }}
        onFinished={async (batchID) => {
          setRunIDs([]);
          navigate(`/execution-records?batch=${encodeURIComponent(batchID)}`);
        }}
      />
    </div>
  );
}
export { HTTPCaseEditor, RunCasesDialog } from './case-editor';
