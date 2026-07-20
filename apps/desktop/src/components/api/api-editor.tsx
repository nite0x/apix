import { useEffect, useMemo, useRef, useState } from 'react'
import { IconAlertTriangle, IconDeviceFloppy, IconLoader, IconPlus, IconTrash, IconX } from '@tabler/icons-react'
import type { ApiDefinition, RequestKeyValue } from '../../data/api-catalog'
import {
  CatalogConflictError,
  createRequest,
  createWorkingCopyForRequest,
  discardWorkingCopy,
  getRequest,
  saveWorkingCopy,
  updateWorkingCopy,
  type BackendWorkingCopy,
} from '../../services/api-client'
import {
  BODY_TYPES,
  METHODS,
  blankKeyValue,
  buildRequestData,
  emptyModel,
  hasUnsavedChanges,
  modelFromApi,
  modelFromBackendRequest,
  validateModel,
  type EditorModel,
} from './api-editor-model'

interface Props {
  mode: 'create' | 'edit' | 'import'
  collectionId: string
  collectionName: string
  api?: ApiDefinition
  /** Draft produced by cURL/Raw HTTP import; seeds the form in `import` mode. */
  importedCopy?: BackendWorkingCopy
  /** Collections the imported draft can be saved into (import mode only). */
  collections?: { id: string; name: string }[]
  onCatalogMutation: (mutation: () => Promise<void>) => Promise<void>
  onSaved: (requestId: string, collectionId?: string) => void
  onCancel: () => void
}

function KeyValueRows({
  label,
  rows,
  onChange,
}: {
  label: string
  rows: RequestKeyValue[]
  onChange: (rows: RequestKeyValue[]) => void
}) {
  function update(index: number, patch: Partial<RequestKeyValue>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }
  return (
    <div className="kv-block">
      <div className="kv-block-head">
        <span>{label}</span>
        <button type="button" className="kv-add" onClick={() => onChange([...rows, blankKeyValue()])}>
          <IconPlus size={11} /> Add
        </button>
      </div>
      {rows.length === 0 && <div className="kv-empty">None</div>}
      {rows.map((row, index) => (
        <div className={`kv-row${row.enabled ? '' : ' disabled'}`} key={index}>
          <input
            type="checkbox"
            className="kv-tog"
            checked={row.enabled}
            aria-label={`Enable ${row.name || 'row'}`}
            onChange={(event) => update(index, { enabled: event.target.checked })}
          />
          <input className="kv-inp kv-name" value={row.name} placeholder="Name" onChange={(event) => update(index, { name: event.target.value })} />
          <input className="kv-inp kv-val" value={row.value} placeholder="Value" onChange={(event) => update(index, { value: event.target.value })} />
          <button type="button" className="kv-del" aria-label="Remove row" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
            <IconTrash size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function ApiEditor({ mode, collectionId, collectionName, api, importedCopy, collections, onCatalogMutation, onSaved, onCancel }: Props) {
  const initial = useMemo(() => {
    if (mode === 'edit' && api) return modelFromApi(api)
    if (mode === 'import' && importedCopy) {
      return modelFromBackendRequest({ name: importedCopy.name ?? '', request: importedCopy.request })
    }
    return emptyModel()
  }, [mode, api, importedCopy])
  const [model, setModel] = useState<EditorModel>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [importCollectionId, setImportCollectionId] = useState(() => collectionId || collections?.[0]?.id || '')
  const wcRef = useRef<BackendWorkingCopy | null>(mode === 'import' ? importedCopy ?? null : null)
  const creatingRef = useRef<Promise<BackendWorkingCopy> | null>(null)

  // A fresh import is always unsaved until the user promotes it into the catalog.
  const dirty = mode === 'import'
    ? true
    : mode === 'edit' && api
      ? hasUnsavedChanges(model, api)
      : Boolean(
          model.name.trim()
          || model.description.trim()
          || model.url.trim()
          || model.body.trim()
          || model.bodyType !== 'none'
          || model.auth.mode !== 'none'
          || model.headers.length
          || model.queryParams.length,
        )

  useEffect(() => () => {
    const draft = wcRef.current
    wcRef.current = null
    if (draft) void discardWorkingCopy(draft.id).catch(() => undefined)
  }, [])

  function patch(next: Partial<EditorModel>) {
    setModel((current) => ({ ...current, ...next }))
    setError(null)
  }

  async function ensureWorkingCopy(): Promise<BackendWorkingCopy> {
    if (wcRef.current) return wcRef.current
    if (creatingRef.current) return creatingRef.current
    creatingRef.current = createWorkingCopyForRequest(api!.id)
      .then((copy) => { wcRef.current = copy; return copy })
      .finally(() => { creatingRef.current = null })
    return creatingRef.current
  }

  async function persistCreate(): Promise<string> {
    const created = await createRequest({
      collection_id: collectionId,
      name: model.name.trim(),
      description: model.description.trim() || undefined,
      request: buildRequestData(model),
    })
    return created.id
  }

  async function persistEdit(): Promise<string> {
    const draft = await ensureWorkingCopy()
    let synced: BackendWorkingCopy
    try {
      synced = await updateWorkingCopy(draft, buildRequestData(model))
    } catch (err) {
      if (err instanceof CatalogConflictError) throw err
      await discardWorkingCopy(draft.id).catch(() => undefined)
      wcRef.current = null
      throw err
    }
    wcRef.current = synced
    const saved = await saveWorkingCopy(synced.id, {
      collection_id: collectionId,
      name: model.name.trim(),
      description: model.description,
    })
    await discardWorkingCopy(synced.id).catch(() => undefined)
    wcRef.current = null
    return saved.api_request_id ?? api!.id
  }

  async function persistImport(): Promise<{ id: string; collectionId: string }> {
    const draft = wcRef.current
    if (!draft) throw new Error('导入草稿已失效，请重新导入')
    const synced = await updateWorkingCopy(draft, buildRequestData(model))
    wcRef.current = synced
    const saved = await saveWorkingCopy(synced.id, {
      collection_id: importCollectionId,
      name: model.name.trim(),
      description: model.description,
    })
    await discardWorkingCopy(synced.id).catch(() => undefined)
    wcRef.current = null
    return { id: saved.api_request_id ?? '', collectionId: importCollectionId }
  }

  async function handleSave() {
    const invalid = validateModel(model)
    if (invalid) {
      setError(invalid.message)
      return
    }
    if (mode === 'import' && !importCollectionId) {
      setError('请选择要保存到的 Collection')
      return
    }
    setSaving(true)
    setError(null)
    try {
      let requestId = ''
      let savedCollectionId: string | undefined
      await onCatalogMutation(async () => {
        if (mode === 'create') {
          requestId = await persistCreate()
        } else if (mode === 'edit') {
          requestId = await persistEdit()
        } else {
          const result = await persistImport()
          requestId = result.id
          savedCollectionId = result.collectionId
        }
      })
      onSaved(requestId, savedCollectionId)
    } catch (err) {
      if (err instanceof CatalogConflictError) {
        setConflict(true)
      } else {
        setError(err instanceof Error ? err.message : 'Save failed')
      }
    } finally {
      setSaving(false)
    }
  }

  async function reloadFromServer() {
    if (!api) return
    setSaving(true)
    try {
      const draft = wcRef.current
      wcRef.current = null
      if (draft) await discardWorkingCopy(draft.id).catch(() => undefined)
      const fresh = await getRequest(api.id)
      setModel(modelFromBackendRequest({ name: fresh.name, description: fresh.description, request: fresh.request }))
      setConflict(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reload failed')
    } finally {
      setSaving(false)
    }
  }

  async function keepLocalCopy() {
    const draft = wcRef.current
    wcRef.current = null
    if (draft) await discardWorkingCopy(draft.id).catch(() => undefined)
    setConflict(false)
  }

  function discardDraftAndClose() {
    const draft = wcRef.current
    wcRef.current = null
    if (draft) void discardWorkingCopy(draft.id).catch(() => undefined)
    onCancel()
  }

  function cancelEditor() {
    // Closing an unsaved import silently would drop the parsed draft: confirm first.
    if (mode === 'import' && dirty) {
      setConfirmClose(true)
      return
    }
    discardDraftAndClose()
  }

  function discardChanges() {
    if (mode === 'edit' && api) {
      const draft = wcRef.current
      wcRef.current = null
      if (draft) void discardWorkingCopy(draft.id).catch(() => undefined)
      setModel(modelFromApi(api))
      setConflict(false)
      setError(null)
    } else if (mode === 'import') {
      discardDraftAndClose()
    } else {
      cancelEditor()
    }
  }

  const title = mode === 'create' ? '新建接口' : mode === 'import' ? '导入接口' : '编辑接口'
  const saveLabel = saving ? '保存中…' : mode === 'create' ? '创建' : mode === 'import' ? '保存到接口库' : '保存修改'
  const discardLabel = mode === 'edit' ? '丢弃修改' : mode === 'import' ? '丢弃导入' : '清空'
  const dirtyLabel = mode === 'import' ? '未保存导入' : '未保存修改'
  const headCollectionName = mode === 'import'
    ? (collections?.find((item) => item.id === importCollectionId)?.name ?? collectionName)
    : collectionName

  return (
    <div className="api-editor">
      <div className="ed-head">
        <div className="ed-head-main">
          <span className="ed-title">{title}</span>
          <span className="ed-coll">{headCollectionName}</span>
          {dirty && <span className="ed-dirty">{dirtyLabel}</span>}
        </div>
        <button type="button" className="ed-close" aria-label="关闭编辑器" onClick={cancelEditor} disabled={saving}><IconX size={15} /></button>
      </div>

      {conflict && (
        <div className="ed-conflict" role="alert">
          <IconAlertTriangle size={14} />
          <span>该接口已在别处被修改。请重新加载最新版本，或保留你的本地修改后再次保存。</span>
          <div className="ed-conflict-acts">
            <button type="button" onClick={() => void reloadFromServer()}>重新加载</button>
            <button type="button" onClick={() => void keepLocalCopy()}>保留本地副本</button>
          </div>
        </div>
      )}

      <div className="ed-body">
        {mode === 'import' && (
          <label className="ed-field">
            <span className="ed-lbl">Collection</span>
            <select
              className="ed-inp"
              value={importCollectionId}
              onChange={(event) => { setImportCollectionId(event.target.value); setError(null) }}
            >
              {(collections ?? []).length === 0 && <option value="">无可用 Collection</option>}
              {(collections ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        )}

        <label className="ed-field">
          <span className="ed-lbl">名称</span>
          <input className="ed-inp" value={model.name} onChange={(event) => patch({ name: event.target.value })} placeholder="接口名称" />
        </label>

        <label className="ed-field">
          <span className="ed-lbl">描述</span>
          <textarea className="ed-ta" rows={2} value={model.description} onChange={(event) => patch({ description: event.target.value })} placeholder="接口说明（可选）" />
        </label>

        <div className="ed-urlrow">
          <select className="ed-method" value={model.method} onChange={(event) => patch({ method: event.target.value as EditorModel['method'] })}>
            {METHODS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <input className="ed-inp ed-url" value={model.url} onChange={(event) => patch({ url: event.target.value })} placeholder="https://api.example.com/path" />
        </div>

        <KeyValueRows label="Query Params" rows={model.queryParams} onChange={(rows) => patch({ queryParams: rows })} />
        <KeyValueRows label="Headers" rows={model.headers} onChange={(rows) => patch({ headers: rows })} />

        <div className="ed-field">
          <span className="ed-lbl">Body</span>
          <div className="ed-bodyrow">
            <select className="ed-method" value={model.bodyType} onChange={(event) => patch({ bodyType: event.target.value })}>
              {BODY_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          {model.bodyType !== 'none' && (
            <textarea className="ed-ta ed-code" rows={4} value={model.body} onChange={(event) => patch({ body: event.target.value })} placeholder="请求体内容" />
          )}
        </div>

        <div className="ed-field">
          <span className="ed-lbl">Auth</span>
          <div className="ed-bodyrow">
            <select
              className="ed-method"
              value={model.auth.mode}
              onChange={(event) => patch({ auth: { ...model.auth, mode: event.target.value as EditorModel['auth']['mode'] } })}
            >
              <option value="none">None</option>
              <option value="bearer">Bearer</option>
              <option value="basic">Basic</option>
              <option value="api_key">API Key</option>
              <option value="raw">Raw JSON</option>
            </select>
          </div>
          {model.auth.mode === 'bearer' && (
            <input className="ed-inp" value={model.auth.token} placeholder="Token" onChange={(event) => patch({ auth: { ...model.auth, token: event.target.value } })} />
          )}
          {model.auth.mode === 'basic' && (
            <div className="ed-urlrow">
              <input className="ed-inp" value={model.auth.username} placeholder="Username" onChange={(event) => patch({ auth: { ...model.auth, username: event.target.value } })} />
              <input className="ed-inp" value={model.auth.password} placeholder="Password" onChange={(event) => patch({ auth: { ...model.auth, password: event.target.value } })} />
            </div>
          )}
          {model.auth.mode === 'api_key' && (
            <div className="ed-urlrow">
              <select className="ed-method" value={model.auth.apiKeyIn} onChange={(event) => patch({ auth: { ...model.auth, apiKeyIn: event.target.value as 'header' | 'query' } })}>
                <option value="header">Header</option>
                <option value="query">Query</option>
              </select>
              <input className="ed-inp" value={model.auth.apiKeyName} placeholder="Key" onChange={(event) => patch({ auth: { ...model.auth, apiKeyName: event.target.value } })} />
              <input className="ed-inp" value={model.auth.apiKeyValue} placeholder="Value" onChange={(event) => patch({ auth: { ...model.auth, apiKeyValue: event.target.value } })} />
            </div>
          )}
          {model.auth.mode === 'raw' && (
            <textarea className="ed-ta ed-code" rows={4} value={model.auth.raw} placeholder='{ "type": "custom", ... }' onChange={(event) => patch({ auth: { ...model.auth, raw: event.target.value } })} />
          )}
        </div>
      </div>

      {error && <div className="ed-error">{error}</div>}

      <div className="ed-foot">
        <button type="button" className="ed-btn ghost" onClick={discardChanges} disabled={saving || !dirty}>
          {discardLabel}
        </button>
        <div className="ed-foot-right">
          <button type="button" className="ed-btn" onClick={cancelEditor} disabled={saving}>取消</button>
          <button type="button" className="ed-btn primary" onClick={() => void handleSave()} disabled={saving || (mode === 'edit' && !dirty)}>
            {saving ? <IconLoader size={13} /> : <IconDeviceFloppy size={13} />} {saveLabel}
          </button>
        </div>
      </div>

      {confirmClose && (
        <div className="lib-confirm-overlay" role="presentation">
          <div className="lib-confirm" role="alertdialog" aria-modal="true" aria-label="放弃导入">
            <div className="lib-confirm-icon"><IconAlertTriangle size={18} /></div>
            <div className="lib-confirm-title">放弃导入</div>
            <p className="lib-confirm-body">导入的内容尚未保存，关闭后将被丢弃且不会生成已保存接口。确认放弃？</p>
            <div className="lib-confirm-acts">
              <button type="button" className="ed-btn" onClick={() => setConfirmClose(false)}>继续编辑</button>
              <button type="button" className="ed-btn primary danger" onClick={discardDraftAndClose}>放弃导入</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
