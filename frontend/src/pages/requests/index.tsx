import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, json } from '@/lib/api';
import { useDirty } from '@/lib/use-dirty';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  ConfirmDialog,
  EmptyState,
  ErrorAlert,
  Field,
  PageHeader,
  SelectField,
  StatusBadge,
} from '@/components/shared';
import { ArchiveManager, BulkManager, References } from '@/components/lifecycle';
import { BatchLink, RequestDetail, RequestRunContent } from './detail';
import {
  blankRequest,
  formatTime,
  historyDraft,
  methods,
  readDraft,
  toDraft,
  type Collection,
  type Draft,
  type RequestData,
  type RequestRun,
  type SavedRequest,
  type WorkingCopy,
} from './model';

interface Library {
  groups: Collection[];
  items: SavedRequest[];
}
interface Confirmation {
  title: string;
  description: string;
  action: () => Promise<void> | void;
  children?: ReactNode;
}

function operationError(error: unknown): string {
  if (error instanceof Error && ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name))
    return '未能确认操作结果，请检查连接后刷新重试。当前输入已保留。';
  return error instanceof Error ? error.message : String(error);
}

export default function RequestsPage() {
  const client = useQueryClient();
  const [tab, setTab] = useState('execute');
  const [original, setOriginal] = useState<RequestData>(blankRequest);
  const [draft, setDraft] = useState<Draft>(() => toDraft(blankRequest()));
  const [copy, setCopy] = useState<WorkingCopy | null>(null);
  const copyRef = useRef<WorkingCopy | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [response, setResponse] = useState<RequestRun | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [filterCollection, setFilterCollection] = useState('');
  const [search, setSearch] = useState('');
  const [importText, setImportText] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [historyStatus, setHistoryStatus] = useState('');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [collectionEditor, setCollectionEditor] = useState<{
    original: Collection | null;
    name: string;
  } | null>(null);
  const [collectionError, setCollectionError] = useState<unknown>(null);
  const [moving, setMoving] = useState<{ item: SavedRequest; collectionId: string } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  useDirty(dirty);

  const library = useQuery({
    queryKey: ['requests-library'],
    queryFn: async ({ signal }): Promise<Library> => {
      const groups = (await api<Collection[]>('/collections', { signal })) || [];
      const requests = await Promise.all(
        groups.map((group) =>
          api<SavedRequest[]>(`/requests?collection_id=${encodeURIComponent(group.id)}`, {
            signal,
          }),
        ),
      );
      return { groups, items: requests.flatMap((items) => items || []) };
    },
  });
  const history = useQuery({
    queryKey: ['request-history'],
    queryFn: ({ signal }) => api<RequestRun[]>('/runs?summary=true&limit=200', { signal }),
    enabled: tab === 'history',
  });
  const groups = library.data?.groups || [];
  const groupNames = new Map(groups.map((group) => [group.id, group.name]));
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['requests-library'] });
  };
  const refreshHistory = async () => {
    await client.invalidateQueries({ queryKey: ['request-history'] });
    await client.invalidateQueries({ queryKey: ['activity'] });
  };

  function setWorkingCopy(value: WorkingCopy | null) {
    copyRef.current = value;
    setCopy(value);
  }
  function change<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }
  function fill(
    request: RequestData,
    workingCopy: WorkingCopy | null = null,
    metadata: Partial<SavedRequest> = {},
  ) {
    setOriginal(structuredClone(request));
    setDraft(toDraft(request, { name: workingCopy?.name || '', ...metadata }));
    setWorkingCopy(workingCopy);
    setDirty(false);
    setConflicted(false);
    setResponse(null);
    setError(null);
    setTab('execute');
  }
  async function perform(action: () => Promise<void>, draftOperation = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await action();
    } catch (problem) {
      const status =
        problem && typeof problem === 'object' && 'status' in problem ? problem.status : null;
      if (draftOperation && (status === 409 || status === 404)) {
        setConflicted(true);
        setError('接口或草稿已在别处变更。本地编辑已保留，请重新载入接口，或另存为新接口。');
      } else setError(operationError(problem));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function discardCopy() {
    if (copyRef.current)
      await json(`/working-copies/${encodeURIComponent(copyRef.current.id)}/discard`, null);
  }
  async function syncCopy(request: RequestData): Promise<WorkingCopy> {
    const current = copyRef.current;
    const updated = current
      ? await json<WorkingCopy>(
          `/working-copies/${encodeURIComponent(current.id)}`,
          { ...current, request },
          'PUT',
        )
      : await json<WorkingCopy>('/working-copies', {
          name: draft.name.trim() || '手动请求',
          source_type: 'manual',
          request,
        });
    setWorkingCopy(updated);
    return updated;
  }
  function replaceDraft(action: () => Promise<void>) {
    if (busyRef.current) return;
    if (dirty)
      setConfirmation({
        title: '放弃当前请求的修改？',
        description:
          '当前请求有未保存的修改。继续后将切换编辑内容，已保存的接口和执行记录不受影响。',
        action: () => perform(action, true),
      });
    else void perform(action, true);
  }
  function newRequest() {
    replaceDraft(async () => {
      await discardCopy();
      fill(blankRequest());
      setMessage('已创建临时请求。');
    });
  }
  function loadSaved(id: string) {
    replaceDraft(async () => {
      const saved = await api<SavedRequest>(`/requests/${encodeURIComponent(id)}`);
      const next = await json<WorkingCopy>('/working-copies', { api_request_id: saved.id });
      try {
        await discardCopy();
      } catch (problem) {
        await json(`/working-copies/${encodeURIComponent(next.id)}/discard`, null);
        throw problem;
      }
      fill(next.request, next, saved);
      setMessage('已载入接口。编辑后可保存更改，或直接发送调试。');
    });
  }
  function reuseHistory(id: string) {
    replaceDraft(async () => {
      const run = await api<RequestRun>(`/runs/${encodeURIComponent(id)}`);
      if (!run.request_snapshot) throw new Error('该记录没有可用的请求快照。');
      const reused = historyDraft(run.request_snapshot);
      await discardCopy();
      fill(reused.request);
      setDraft(reused.draft);
      setDirty(true);
      setMessage(
        reused.redacted
          ? '已填入历史请求。请重新填写认证信息，替换脱敏值及 REPLACE_API_KEY_NAME 占位名称后再发送。'
          : '已填入历史请求，可修改后发送。',
      );
    });
  }
  function importRequest() {
    if (!importText.trim()) {
      setError('请先粘贴 cURL 或原始 HTTP 请求。');
      return;
    }
    replaceDraft(async () => {
      const next = await json<WorkingCopy>('/import/curl', { content: importText.trim() });
      try {
        await discardCopy();
      } catch (problem) {
        await json(`/working-copies/${encodeURIComponent(next.id)}/discard`, null);
        throw problem;
      }
      fill(next.request, next);
      setDirty(true);
      setImportText('');
      setMessage('已解析为草稿，尚未发送或保存。请检查内容后操作。');
    });
  }
  function execute(event: FormEvent) {
    event.preventDefault();
    void perform(async () => {
      const request = readDraft(draft, original);
      setResponse(null);
      setMessage('请求执行中，正在等待响应…');
      const current = await syncCopy(request);
      const run = await api<RequestRun>('/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ working_copy_id: current.id }),
        signal: AbortSignal.timeout(70000),
      });
      setResponse(run);
      setMessage(
        run.error_message ? '请求执行失败，详情和记录已保留。' : '请求已完成，已保存执行记录。',
      );
      await refreshHistory();
    }, true);
  }
  function save() {
    void perform(async () => {
      if (!draft.name.trim() || !draft.collectionId)
        throw new Error('请填写接口名称并选择分组；没有分组时，先在接口管理中新建。');
      if (conflicted) throw new Error('原接口已归档或变更，请重新载入，或另存为新接口。');
      const request = readDraft(draft, original);
      const current = await syncCopy(request);
      const saved = await json<WorkingCopy>(
        `/working-copies/${encodeURIComponent(current.id)}/save`,
        {
          name: draft.name.trim(),
          collection_id: draft.collectionId,
          description: draft.description,
        },
      );
      setWorkingCopy(saved);
      setDirty(false);
      setConflicted(false);
      setMessage('接口已保存到接口库。');
      await refresh();
    }, true);
  }
  function saveAsNew() {
    void perform(async () => {
      await discardCopy();
      setWorkingCopy(null);
      setConflicted(false);
      setDirty(true);
      setMessage('已转为新接口草稿。请选择分组和名称，再点击“保存接口”。');
    }, true);
  }
  function archiveRequest(item: SavedRequest) {
    setConfirmation({
      title: '归档接口',
      description: `归档“${item.name}”？配置和历史保留，已有引用会在服务端重新检查。`,
      action: () =>
        perform(async () => {
          await api(`/requests/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
          if (copyRef.current?.api_request_id === item.id) {
            setConflicted(true);
            setMessage('原接口已归档。当前编辑已保留，可另存为新接口。');
          }
          await refresh();
        }),
    });
  }
  function archiveCollection() {
    const item = groups.find((group) => group.id === filterCollection);
    if (!item) return;
    setConfirmation({
      title: '归档分组',
      description: `归档“${item.name}”？包含 ${(library.data?.items || []).filter((request) => request.collection_id === item.id).length} 个接口。接口自身归档状态不变，执行记录保留。`,
      action: () =>
        perform(async () => {
          await api(`/collections/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
          setFilterCollection('');
          if (copyRef.current?.api_request_id && draft.collectionId === item.id) {
            setConflicted(true);
            setMessage('原分组已归档。当前编辑已保留，可另存为新接口。');
          }
          await refresh();
        }),
    });
  }
  async function saveCollection(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !collectionEditor?.name.trim()) return;
    const editing = collectionEditor;
    busyRef.current = true;
    setBusy(true);
    setCollectionError(null);
    try {
      const item = await json<Collection>(
        editing.original
          ? `/collections/${encodeURIComponent(editing.original.id)}`
          : '/collections',
        { ...editing.original, name: editing.name.trim() },
        editing.original ? 'PATCH' : 'POST',
      );
      setCollectionEditor(null);
      setFilterCollection(item.id);
      if (!copyRef.current?.api_request_id)
        setDraft((current) => ({ ...current, collectionId: item.id }));
      await refresh();
    } catch (problem) {
      setCollectionError(operationError(problem));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function pinRun(run: RequestRun) {
    void perform(async () => {
      await json(`/runs/${encodeURIComponent(run.id)}/pin`, { pinned: !run.is_pinned });
      await refreshHistory();
    });
  }
  function deleteRun(run: RequestRun) {
    setConfirmation({
      title: '删除执行记录',
      description:
        '删除这条执行记录？此操作无法恢复，已保存的接口定义不受影响。固定或被引用的记录受保护。',
      action: () =>
        perform(async () => {
          await api(`/runs/${encodeURIComponent(run.id)}`, { method: 'DELETE' });
          await refreshHistory();
        }),
    });
  }

  const requestRows = (library.data?.items || []).filter(
    (item) =>
      (!filterCollection || item.collection_id === filterCollection) &&
      `${item.name} ${item.request.method} ${item.request.url} ${groupNames.get(item.collection_id) || ''}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const runRows = (history.data || []).filter(
    (run) =>
      (!historyStatus || run.status === historyStatus) &&
      (!pinnedOnly || run.is_pinned) &&
      `${run.request_snapshot?.method || ''} ${run.request_snapshot?.url || ''}`
        .toLowerCase()
        .includes(historySearch.trim().toLowerCase()),
  );
  const groupOptions = [
    { value: '', label: '选择分组' },
    ...groups.map((group) => ({ value: group.id, label: group.name })),
  ];
  if (draft.collectionId && !groups.some((group) => group.id === draft.collectionId))
    groupOptions.push({ value: draft.collectionId, label: '原分组（可能已归档）' });
  const bodyDisabled = ['GET', 'HEAD'].includes(draft.method);
  const preserved = [...(original.query_params || []), ...(original.headers || [])].filter(
    (row) => !row.enabled,
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="接口"
        description="管理接口库、调试 HTTP 请求，并查看持久化的执行记录。"
        actions={
          <Button onClick={newRequest} disabled={busy}>
            新增接口
          </Button>
        }
      />
      <ErrorAlert error={error} />
      {message ? (
        <p role="status" className="rounded-md border bg-muted/40 p-3 text-sm">
          {message}
        </p>
      ) : null}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="接口工作区">
          <TabsTrigger value="manage">接口管理</TabsTrigger>
          <TabsTrigger value="execute">接口执行</TabsTrigger>
          <TabsTrigger value="history">执行记录</TabsTrigger>
        </TabsList>
        <TabsContent value="manage" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>接口库</CardTitle>
                  <CardDescription>保存可重复使用的接口，按分组管理。</CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setCollectionError(null);
                      setCollectionEditor({ original: null, name: '' });
                    }}
                  >
                    新建分组
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void library.refetch()}
                    disabled={library.isFetching}
                  >
                    刷新接口库
                  </Button>
                  <ArchiveManager kind="request" onChanged={refresh} />
                  <ArchiveManager kind="collection" onChanged={refresh} />
                  <BulkManager kind="request" onChanged={refresh} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid items-end gap-3 sm:grid-cols-[200px_1fr_auto_auto]">
                <SelectField
                  label="分组"
                  value={filterCollection}
                  onValueChange={setFilterCollection}
                  options={[
                    { value: '', label: '全部分组' },
                    ...groups.map((group) => ({ value: group.id, label: group.name })),
                  ]}
                />
                <Field label="搜索接口">
                  <Input
                    type="search"
                    aria-label="搜索接口"
                    placeholder="名称、方法、URL 或分组"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </Field>
                <Button
                  variant="outline"
                  disabled={!filterCollection || busy}
                  onClick={() => {
                    const group = groups.find((item) => item.id === filterCollection);
                    if (group) {
                      setCollectionError(null);
                      setCollectionEditor({ original: group, name: group.name });
                    }
                  }}
                >
                  重命名分组
                </Button>
                <Button
                  variant="outline"
                  disabled={!filterCollection || busy}
                  onClick={archiveCollection}
                >
                  归档分组
                </Button>
              </div>
              <ErrorAlert error={library.error} />
              {library.isPending ? (
                <p role="status">正在读取接口库…</p>
              ) : requestRows.length ? (
                <div className="divide-y rounded-md border">
                  {requestRows.map((item) => (
                    <article
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-4 p-4"
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <h3 className="font-medium">{item.name}</h3>
                        <p className="break-all font-mono text-xs">
                          <Badge variant="outline" className="mr-2">
                            {item.request.method}
                          </Badge>
                          {item.request.url}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {groupNames.get(item.collection_id)}
                          {item.description ? ` · ${item.description}` : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => loadSaved(item.id)}
                          disabled={busy}
                          aria-label={`编辑接口 ${item.name}`}
                        >
                          编辑 / 调试
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              await json(
                                `/requests/${encodeURIComponent(item.id)}/duplicate`,
                                null,
                              );
                              await refresh();
                            })
                          }
                        >
                          复制
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setMoving({ item, collectionId: item.collection_id })}
                        >
                          移动分组
                        </Button>
                        <References kind="request" id={item.id} />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          aria-label={`归档接口 ${item.name}`}
                          onClick={() => archiveRequest(item)}
                        >
                          归档
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="没有匹配的接口"
                  description="新增接口或导入请求，在执行页填写名称和分组后保存。"
                />
              )}
              <details className="rounded-md border p-4">
                <summary className="cursor-pointer text-sm font-medium">
                  导入 cURL / 原始 HTTP
                </summary>
                <div className="mt-4 space-y-3">
                  <Field
                    label="请求内容"
                    description="解析后可以审阅、调试或保存，不会自动发送请求。"
                  >
                    <Textarea
                      aria-label="请求内容"
                      rows={5}
                      spellCheck={false}
                      placeholder="curl https://example.com/api"
                      value={importText}
                      onChange={(event) => setImportText(event.target.value)}
                    />
                  </Field>
                  <Button onClick={importRequest} disabled={busy}>
                    解析到编辑器
                  </Button>
                </div>
              </details>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="execute" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>手动执行接口</CardTitle>
                  <CardDescription>直接调试，或命名保存到接口库。</CardDescription>
                </div>
                <Button variant="outline" onClick={newRequest} disabled={busy}>
                  清空请求
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={execute} className="space-y-4" aria-busy={busy}>
                <fieldset disabled={busy} className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-3">
                    <Field label="接口名称">
                      <Input
                        aria-label="接口名称"
                        value={draft.name}
                        maxLength={200}
                        onChange={(event) => change('name', event.target.value)}
                        placeholder="临时请求可留空，保存时填写"
                      />
                    </Field>
                    <SelectField
                      label="保存分组"
                      value={draft.collectionId}
                      onValueChange={(value) => change('collectionId', value)}
                      options={groupOptions}
                      disabled={!!copy?.api_request_id || busy}
                    />
                    <Field label="说明">
                      <Input
                        aria-label="说明"
                        value={draft.description}
                        onChange={(event) => change('description', event.target.value)}
                        placeholder="可选"
                      />
                    </Field>
                  </div>
                  <div className="grid items-end gap-3 sm:grid-cols-[144px_minmax(0,1fr)_auto]">
                    <SelectField
                      label="请求方法"
                      value={draft.method}
                      onValueChange={(value) => change('method', value)}
                      options={[...new Set([...methods, draft.method])].map((method) => ({
                        value: method,
                        label: method,
                      }))}
                    />
                    <Field label="请求地址">
                      <Input
                        aria-label="请求地址"
                        type="url"
                        required
                        value={draft.url}
                        onChange={(event) => change('url', event.target.value)}
                        placeholder="http://127.0.0.1:8080/api/example"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </Field>
                    <Button type="submit">{busy ? '发送中…' : '发送请求'}</Button>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Query 参数" description="每行 key=value，支持同名参数">
                      <Textarea
                        aria-label="Query 参数"
                        rows={4}
                        value={draft.query}
                        onChange={(event) => change('query', event.target.value)}
                        placeholder={'page=1\nkeyword=测试'}
                        spellCheck={false}
                        className="font-mono text-xs"
                      />
                    </Field>
                    <Field label="Headers" description="每行 Header-Name: value">
                      <Textarea
                        aria-label="Headers"
                        rows={4}
                        value={draft.headers}
                        onChange={(event) => change('headers', event.target.value)}
                        placeholder={'Authorization: Bearer ...\nAccept: application/json'}
                        spellCheck={false}
                        className="font-mono text-xs"
                      />
                    </Field>
                  </div>
                  <div className="max-w-xs">
                    <SelectField
                      label="Body 类型"
                      value={bodyDisabled ? 'none' : draft.bodyType}
                      onValueChange={(value) => change('bodyType', value)}
                      options={[
                        { value: 'none', label: '无 Body' },
                        { value: 'json', label: 'JSON' },
                        { value: 'raw', label: '文本' },
                        { value: 'urlencoded', label: 'URL Encoded' },
                      ]}
                      disabled={bodyDisabled || busy}
                    />
                  </div>
                  {bodyDisabled ? (
                    <p className="text-xs text-muted-foreground">GET / HEAD 请求不发送 Body。</p>
                  ) : draft.bodyType !== 'none' ? (
                    <Field label="请求 Body">
                      <Textarea
                        aria-label="请求 Body"
                        rows={8}
                        value={draft.body}
                        onChange={(event) => change('body', event.target.value)}
                        spellCheck={false}
                        className="font-mono text-xs"
                      />
                    </Field>
                  ) : null}
                  {preserved || original.auth_config ? (
                    <p className="text-xs text-muted-foreground">
                      {preserved ? `保留 ${preserved} 条未启用的参数 / Header。` : ''}
                      {original.auth_config ? ' 已保存的认证配置将完整保留。' : ''}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">
                      {dirty
                        ? '未保存修改'
                        : copy?.api_request_id
                          ? '已载入保存的接口'
                          : '临时请求'}
                    </Badge>
                    <Button type="button" variant="outline" onClick={save}>
                      保存接口
                    </Button>
                    {copy?.api_request_id ? (
                      <Button type="button" variant="outline" onClick={saveAsNew}>
                        另存为新接口
                      </Button>
                    ) : null}
                    {conflicted && copy?.api_request_id ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => loadSaved(copy.api_request_id!)}
                      >
                        重新载入接口
                      </Button>
                    ) : null}
                  </div>
                </fieldset>
              </form>
            </CardContent>
          </Card>
          {response ? (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>本次响应</CardTitle>
                  <Button variant="outline" size="sm" onClick={() => setDetail(response.id)}>
                    请求与响应详情
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <RequestRunContent run={response} />
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle>接口执行记录</CardTitle>
                  <CardDescription>最近 200 条记录，已保存的接口定义独立保留。</CardDescription>
                </div>
                <Button
                  variant="outline"
                  onClick={() => void history.refetch()}
                  disabled={history.isFetching}
                >
                  刷新历史
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="搜索记录">
                  <Input
                    type="search"
                    aria-label="搜索记录"
                    value={historySearch}
                    onChange={(event) => setHistorySearch(event.target.value)}
                    placeholder="URL 或请求方法"
                  />
                </Field>
                <SelectField
                  label="执行状态"
                  value={historyStatus}
                  onValueChange={setHistoryStatus}
                  options={[
                    { value: '', label: '全部状态' },
                    { value: 'running', label: '执行中' },
                    { value: 'succeeded', label: '已完成' },
                    { value: 'failed', label: '失败' },
                    { value: 'timed_out', label: '超时' },
                    { value: 'cancelled', label: '已取消' },
                  ]}
                />
                <div className="flex h-9 items-center gap-2">
                  <Checkbox
                    id="request-history-pinned"
                    checked={pinnedOnly}
                    onCheckedChange={(value) => setPinnedOnly(value === true)}
                  />
                  <Label htmlFor="request-history-pinned">仅看固定</Label>
                </div>
              </div>
              <ErrorAlert error={history.error} />
              {history.isPending ? (
                <p role="status">正在读取执行记录…</p>
              ) : runRows.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>请求</TableHead>
                      <TableHead>响应</TableHead>
                      <TableHead>耗时</TableHead>
                      <TableHead>执行时间</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runRows.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell className="max-w-[360px]">
                          <Badge variant="outline">{run.request_snapshot?.method}</Badge>
                          <Button
                            variant="link"
                            className="h-auto max-w-full justify-start whitespace-normal break-all px-0 text-left"
                            onClick={() => setDetail(run.id)}
                          >
                            {run.request_snapshot?.url || run.id}
                          </Button>
                          {run.is_pinned ? <Badge variant="secondary">已固定</Badge> : null}
                        </TableCell>
                        <TableCell>
                          {run.response_status ? (
                            `HTTP ${run.response_status}`
                          ) : (
                            <StatusBadge status={run.status} />
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {run.duration_ms ?? 0} ms
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatTime(run.started_at)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            <BatchLink run={run} />
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => reuseHistory(run.id)}
                              disabled={busy}
                            >
                              填入编辑器
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => pinRun(run)}
                            >
                              {run.is_pinned ? '取消固定' : '固定'}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy || run.is_pinned || run.status === 'running'}
                              onClick={() => deleteRun(run)}
                            >
                              删除
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState
                  title="没有匹配的执行记录"
                  description="发送请求后，执行记录会自动保留在这里。"
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      <Dialog
        open={!!collectionEditor}
        onOpenChange={(open) => {
          if (!open && !busy) setCollectionEditor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{collectionEditor?.original ? '重命名分组' : '新建分组'}</DialogTitle>
            <DialogDescription>分组用于组织已保存的接口。</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveCollection} className="space-y-4">
            <Field label="分组名称">
              <Input
                aria-label="分组名称"
                required
                autoFocus
                value={collectionEditor?.name || ''}
                onChange={(event) =>
                  setCollectionEditor((current) =>
                    current ? { ...current, name: event.target.value } : null,
                  )
                }
                disabled={busy}
              />
            </Field>
            <ErrorAlert error={collectionError} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCollectionEditor(null)}
                disabled={busy}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                保存分组
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!moving}
        onOpenChange={(open) => {
          if (!open && !busy) setMoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移动接口</DialogTitle>
            <DialogDescription>
              移动“{moving?.item.name}”，保留接口 ID、引用和历史。
            </DialogDescription>
          </DialogHeader>
          <SelectField
            label="目标分组"
            value={moving?.collectionId || ''}
            onValueChange={(collectionId) =>
              setMoving((current) => (current ? { ...current, collectionId } : null))
            }
            options={groups.map((group) => ({ value: group.id, label: group.name }))}
          />
          <ErrorAlert error={error} />
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setMoving(null)}>
              取消
            </Button>
            <Button
              disabled={busy || !moving?.collectionId}
              onClick={() =>
                void perform(async () => {
                  if (!moving) return;
                  await json(`/requests/${encodeURIComponent(moving.item.id)}/move`, {
                    collection_id: moving.collectionId,
                  });
                  if (copyRef.current?.api_request_id === moving.item.id)
                    setDraft((current) => ({ ...current, collectionId: moving.collectionId }));
                  setMoving(null);
                  await refresh();
                })
              }
            >
              确认移动
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
        title={confirmation?.title || '确认操作'}
        description={confirmation?.description || ''}
        pending={busy}
        onConfirm={async () => {
          const action = confirmation?.action;
          setConfirmation(null);
          await action?.();
        }}
      />
      <RequestDetail
        id={detail}
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      />
    </div>
  );
}

export { RequestDetail } from './detail';
