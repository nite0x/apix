import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconAlertTriangle,
  IconArchive,
  IconDots,
  IconFileImport,
  IconFileText,
  IconFolderPlus,
  IconLock,
  IconPencil,
  IconPlus,
  IconSearch,
  IconUsers,
  IconX,
} from '@tabler/icons-react'
import type { ApiCollectionGroup, ApiDefinition } from '../../data/api-catalog'
import {
  CatalogError,
  archiveCollection,
  archiveRequest,
  createCollection,
  importCurl,
  updateCollection,
  type BackendCollection,
  type BackendWorkingCopy,
} from '../../services/api-client'
import type { CatalogLoadState } from '../../store/catalog-store'
import { CatalogFeedback } from '../catalog/catalog-feedback'
import { ApiDetail } from './api-detail'
import { ApiEditor } from './api-editor'

interface Props {
  catalog: ApiCollectionGroup[]
  catalogState: CatalogLoadState
  catalogError: string | null
  isPreview: boolean
  onClose: () => void
  onJumpToSession: () => void
  onRetry: () => void
  onCatalogMutation: (mutation: () => Promise<void>) => Promise<void>
}

type EditorState =
  | { mode: 'create' | 'edit'; api?: ApiDefinition }
  | { mode: 'import'; importedCopy: BackendWorkingCopy }

type CollectionFormState = { mode: 'create' } | { mode: 'rename'; collection: ApiCollectionGroup }

function CollectionIcon({ icon }: { icon: ApiCollectionGroup['icon'] }) {
  if (icon === 'lock') return <IconLock size={13} />
  if (icon === 'users') return <IconUsers size={13} />
  return <IconFileText size={13} />
}

export function ApiLibrary({
  catalog,
  catalogState,
  catalogError,
  isPreview,
  onClose,
  onJumpToSession,
  onRetry,
  onCatalogMutation,
}: Props) {
  const [collectionId, setCollectionId] = useState(catalog[0]?.id ?? '')
  const [apiId, setApiId] = useState<string | null>(catalog[0]?.apis[0]?.id ?? null)
  const [query, setQuery] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importContent, setImportContent] = useState('')
  const [importState, setImportState] = useState<'idle' | 'sending' | 'error'>('idle')
  const [importError, setImportError] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [importSaving, setImportSaving] = useState(false)
  const [confirmImportExit, setConfirmImportExit] = useState(false)
  const pendingImportExitRef = useRef<(() => void) | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<ApiDefinition | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)

  // Collection management state.
  const [collectionForm, setCollectionForm] = useState<CollectionFormState | null>(null)
  const [collectionName, setCollectionName] = useState('')
  const [collectionDescription, setCollectionDescription] = useState('')
  const [collectionSaving, setCollectionSaving] = useState(false)
  const [collectionFormError, setCollectionFormError] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [archiveCollectionTarget, setArchiveCollectionTarget] = useState<ApiCollectionGroup | null>(null)
  const [archiveCollectionError, setArchiveCollectionError] = useState<string | null>(null)
  const [archivingCollection, setArchivingCollection] = useState(false)

  const collection = catalog.find((item) => item.id === collectionId) ?? catalog[0]
  const filteredApis = useMemo(() => {
    if (!collection) return []
    const normalized = query.trim().toLowerCase()
    if (!normalized) return collection.apis
    return collection.apis.filter((api) => `${api.method} ${api.name} ${api.url}`.toLowerCase().includes(normalized))
  }, [collection, query])
  const selectedApi = catalog.flatMap((item) => item.apis).find((api) => api.id === apiId) ?? null
  const collectionOptions = useMemo(() => catalog.map((item) => ({ id: item.id, name: item.name })), [catalog])

  // Keep the selection valid whenever the single shared catalog changes: keep the
  // current collection if it survives, fall back to the next one when it is
  // archived, and never leave a selection pointing at a removed collection/API.
  useEffect(() => {
    if (editor?.mode === 'import') return
    if (catalog.length === 0) {
      if (collectionId !== '') setCollectionId('')
      if (apiId !== null) setApiId(null)
      return
    }
    const current = catalog.find((item) => item.id === collectionId)
    if (!current) {
      const next = catalog[0]
      setCollectionId(next.id)
      setApiId(next.apis[0]?.id ?? null)
      return
    }
    if (apiId && !current.apis.some((api) => api.id === apiId)) {
      setApiId(current.apis[0]?.id ?? null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog])

  const requestImportExit = useCallback((action: () => void) => {
    if (editor?.mode === 'import') {
      if (importSaving) return
      pendingImportExitRef.current = action
      setConfirmImportExit(true)
      return
    }
    action()
  }, [editor?.mode, importSaving])

  const handleImportSavingChange = useCallback((value: boolean) => {
    setImportSaving(value)
  }, [])

  const handleCreateCollectionInline = useCallback(async (name: string) => {
    let created: BackendCollection | null = null
    await onCatalogMutation(async () => {
      created = await createCollection({ name: name.trim() })
    })
    if (!created) throw new Error('新建 Collection 失败')
    const result = created as BackendCollection
    return { id: result.id, name: result.name }
  }, [onCatalogMutation])

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || editor?.mode !== 'import') return
      // Shell owns the general Escape shortcut. Capture this one first so an
      // unsaved import always goes through the confirmation flow.
      event.preventDefault()
      event.stopImmediatePropagation()
      if (confirmImportExit) {
        pendingImportExitRef.current = null
        setConfirmImportExit(false)
        return
      }
      requestImportExit(onClose)
    }
    window.addEventListener('keydown', handleEscape, true)
    return () => window.removeEventListener('keydown', handleEscape, true)
  }, [confirmImportExit, editor?.mode, onClose, requestImportExit])

  function chooseCollection(id: string) {
    requestImportExit(() => {
      setEditor(null)
      setCollectionId(id)
      setApiId(catalog.find((item) => item.id === id)?.apis[0]?.id ?? null)
    })
  }

  function chooseApi(id: string) {
    requestImportExit(() => {
      setEditor(null)
      setApiId(id)
    })
  }

  async function submitImport() {
    if (!importContent.trim()) return
    setImportState('sending')
    setImportError(null)
    try {
      // Import parses into a Working Copy draft; it never saves on its own.
      const copy = await importCurl(importContent)
      setImportState('idle')
      setImportOpen(false)
      setImportContent('')
      setImportSaving(false)
      setEditor({ mode: 'import', importedCopy: copy })
    } catch (error) {
      setImportState('error')
      setImportError(
        error instanceof CatalogError && error.kind === 'offline'
          ? '无法连接本地运行时，请确认服务已启动后重试。'
          : error instanceof Error
            ? error.message
            : '无法解析该请求，请检查 cURL 或 Raw HTTP 格式。',
      )
    }
  }

  function openCreate() {
    requestImportExit(() => {
      setImportOpen(false)
      setEditor({ mode: 'create' })
    })
  }

  function openEdit(api: ApiDefinition) {
    requestImportExit(() => setEditor({ mode: 'edit', api }))
  }

  function openCollectionCreate() {
    requestImportExit(() => {
      setMenuFor(null)
      setCollectionName('')
      setCollectionDescription('')
      setCollectionFormError(null)
      setCollectionForm({ mode: 'create' })
    })
  }

  function openCollectionRename(group: ApiCollectionGroup) {
    requestImportExit(() => {
      setMenuFor(null)
      setCollectionName(group.name)
      setCollectionDescription('')
      setCollectionFormError(null)
      setCollectionForm({ mode: 'rename', collection: group })
    })
  }

  function handleSaved(requestId: string, savedCollectionId?: string) {
    setImportSaving(false)
    setEditor(null)
    if (savedCollectionId) setCollectionId(savedCollectionId)
    if (requestId) setApiId(requestId)
  }

  async function confirmArchive() {
    if (!archiveTarget) return
    setArchiving(true)
    setArchiveError(null)
    try {
      const target = archiveTarget
      await onCatalogMutation(() => archiveRequest(target.id))
      if (apiId === target.id) setApiId(null)
      if (editor && editor.mode !== 'import' && editor.api?.id === target.id) setEditor(null)
      setArchiveTarget(null)
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : 'Archive failed')
    } finally {
      setArchiving(false)
    }
  }

  async function submitCollectionForm() {
    const name = collectionName.trim()
    if (!name) {
      setCollectionFormError('请填写 Collection 名称')
      return
    }
    if (!collectionForm) return
    setCollectionSaving(true)
    setCollectionFormError(null)
    try {
      if (collectionForm.mode === 'create') {
        let created: BackendCollection | null = null
        await onCatalogMutation(async () => {
          created = await createCollection({ name, description: collectionDescription.trim() || undefined })
        })
        if (created) {
          const result = created as BackendCollection
          setCollectionId(result.id)
          setApiId(null)
        }
      } else {
        const id = collectionForm.collection.id
        await onCatalogMutation(async () => {
          await updateCollection(id, { name, description: collectionDescription.trim() || undefined })
        })
        setCollectionId(id)
      }
      setCollectionForm(null)
    } catch (error) {
      setCollectionFormError(error instanceof Error ? error.message : '保存失败')
    } finally {
      setCollectionSaving(false)
    }
  }

  async function confirmArchiveCollection() {
    if (!archiveCollectionTarget) return
    setArchivingCollection(true)
    setArchiveCollectionError(null)
    try {
      const target = archiveCollectionTarget
      await onCatalogMutation(() => archiveCollection(target.id))
      // Move selection to the next available collection when the current one is archived.
      if (collectionId === target.id) {
        const remaining = catalog.filter((item) => item.id !== target.id)
        const next = remaining[0]
        setCollectionId(next?.id ?? '')
        setApiId(next?.apis[0]?.id ?? null)
      }
      setArchiveCollectionTarget(null)
    } catch (error) {
      setArchiveCollectionError(error instanceof Error ? error.message : 'Archive failed')
    } finally {
      setArchivingCollection(false)
    }
  }

  const hasCollections = catalog.length > 0
  const showBody = hasCollections || editor?.mode === 'import'
  const showEmptyCta = !hasCollections && !editor && catalogState === 'empty'

  return (
    <div className="lib-overlay open" role="presentation">
      <section className="lib-modal" role="dialog" aria-modal="true" aria-label="接口库">
        <div className="lib-header">
          <div className="lib-title">接口库</div>
          <label className="lib-search">
            <IconSearch size={12} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索接口…" />
          </label>
          <button
            type="button"
            className={`lib-hbtn${importOpen ? ' active' : ''}`}
            onClick={() => {
              if (editor?.mode === 'import') {
                requestImportExit(() => { setEditor(null); setImportOpen(true) })
              } else {
                setImportOpen((open) => !open)
              }
            }}
            disabled={importSaving}
          >
            <IconFileImport size={12} /> 导入
          </button>
          <button type="button" className="lib-close" aria-label="Close API library" onClick={() => requestImportExit(onClose)} disabled={importSaving}><IconX size={15} /></button>
        </div>

        {importOpen && (
          <div className="lib-import-bar">
            <textarea value={importContent} onChange={(event) => { setImportContent(event.target.value); setImportState('idle'); setImportError(null) }} rows={2} placeholder="Paste curl or raw HTTP request…" />
            <button type="button" onClick={() => void submitImport()} disabled={importState === 'sending' || !importContent.trim()}>
              {importState === 'sending' ? 'Importing…' : 'Import as draft'}
            </button>
            {importState === 'error' && importError && <span className="lib-import-error">{importError}</span>}
          </div>
        )}

        <CatalogFeedback
          state={catalogState}
          error={catalogError}
          isPreview={isPreview}
          blocking={catalog.length === 0}
          onRetry={onRetry}
        />

        {showEmptyCta && (
          <div className="lib-empty-cta">
            <IconFolderPlus size={30} />
            <p className="lib-empty-title">还没有任何 Collection</p>
            <p className="lib-empty-sub">
              {isPreview
                ? '当前为 Preview 数据，写操作已禁用。'
                : '创建第一个 Collection，然后就可以新建或导入接口。'}
            </p>
            {!isPreview && (
              <button type="button" className="ed-btn primary" onClick={openCollectionCreate}>
                <IconFolderPlus size={13} /> 新建 Collection
              </button>
            )}
          </div>
        )}

        {showBody && (
          <div className="lib-body">
            <div className="col-coll">
              <div className="col-coll-head">
                <span className="col-hl">Collections</span>
                <button type="button" aria-label="New collection" onClick={openCollectionCreate} disabled={isPreview || importSaving}><IconPlus size={12} /></button>
              </div>
              <div className="coll-list">
                {catalog.map((item) => (
                  <div className={`coll-row${item.id === collection?.id ? ' active' : ''}`} key={item.id}>
                    <button type="button" className={`coll-it${item.id === collection?.id ? ' active' : ''}`} onClick={() => chooseCollection(item.id)} disabled={importSaving}>
                      <span className={`coll-icon coll-icon-${item.icon}`}><CollectionIcon icon={item.icon} /></span>
                      <span className="coll-info">
                        <span className="coll-nm">{item.name}</span>
                        <span className="coll-cnt">{item.apis.length} apis{item.apis.some((api) => api.aiUsage) ? ` · AI ${item.apis.reduce((sum, api) => sum + (api.aiUsage?.count ?? 0), 0)}×` : ''}</span>
                      </span>
                    </button>
                    {!isPreview && (
                      <button
                        type="button"
                        className="coll-menu-btn"
                        aria-label={`Collection 操作：${item.name}`}
                        aria-haspopup="menu"
                        aria-expanded={menuFor === item.id}
                        onClick={() => setMenuFor((current) => (current === item.id ? null : item.id))}
                        disabled={importSaving}
                      >
                        <IconDots size={13} />
                      </button>
                    )}
                    {menuFor === item.id && (
                      <div className="coll-menu" role="menu" aria-label={`${item.name} 操作`}>
                        <button type="button" role="menuitem" onClick={() => openCollectionRename(item)}><IconPencil size={12} /> 重命名</button>
                        <button type="button" role="menuitem" className="danger" onClick={() => { setMenuFor(null); setArchiveCollectionError(null); setArchiveCollectionTarget(item) }}><IconArchive size={12} /> 归档</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="col-apis">
              <div className="col-apis-head">
                <span className="col-apis-title">{collection?.name ?? 'APIs'}</span>
                <button type="button" aria-label="New API" onClick={openCreate} disabled={isPreview || importSaving}><IconPlus size={12} /></button>
              </div>
              <div className="api-list">
                {collection && filteredApis.length === 0 && (
                  <div className="api-list-empty">{query.trim() ? 'No matching APIs' : '该 Collection 暂无接口'}</div>
                )}
                {filteredApis.map((api) => (
                  <button type="button" className={`api-it${api.id === selectedApi?.id && !editor ? ' active' : ''}`} key={api.id} onClick={() => chooseApi(api.id)} disabled={importSaving}>
                    <span className={`api-m am-${api.method.toLowerCase()}`}>{api.method === 'DELETE' ? 'DEL' : api.method}</span>
                    <span className="api-nm">{api.name}</span>
                    {api.aiUsage && <span className="api-ai" title="Used by AI" />}
                  </button>
                ))}
              </div>
              <div className="col-apis-footer">
                <button type="button" className="api-add-btn" onClick={openCreate} disabled={isPreview || importSaving}><IconPlus size={12} /> 新建接口</button>
              </div>
            </div>

            <div className="col-det">
              {editor?.mode === 'import' ? (
                <ApiEditor
                  key="import"
                  mode="import"
                  collectionId={collection?.id ?? ''}
                  collectionName={collection?.name ?? ''}
                  importedCopy={editor.importedCopy}
                  collections={collectionOptions}
                  onCreateCollection={isPreview ? undefined : handleCreateCollectionInline}
                  onCatalogMutation={onCatalogMutation}
                  onSaved={handleSaved}
                  onCancel={() => setEditor(null)}
                  onSavingChange={handleImportSavingChange}
                />
              ) : editor ? (
                <ApiEditor
                  key={editor.mode === 'edit' ? `edit-${editor.api?.id}` : 'create'}
                  mode={editor.mode}
                  collectionId={editor.mode === 'edit' ? (editor.api?.collectionId ?? collection?.id ?? '') : (collection?.id ?? '')}
                  collectionName={editor.mode === 'edit' ? (editor.api?.collectionName ?? '') : (collection?.name ?? '')}
                  api={editor.api}
                  collections={editor.mode === 'create' ? collectionOptions : undefined}
                  onCreateCollection={editor.mode === 'create' && !isPreview ? handleCreateCollectionInline : undefined}
                  onCatalogMutation={onCatalogMutation}
                  onSaved={handleSaved}
                  onCancel={() => setEditor(null)}
                />
              ) : selectedApi ? (
                <ApiDetail
                  key={selectedApi.id}
                  api={selectedApi}
                  context="library"
                  onJumpToSession={onJumpToSession}
                  onEdit={() => openEdit(selectedApi)}
                  onArchive={() => { setArchiveError(null); setArchiveTarget(selectedApi) }}
                />
              ) : (
                <div className="det-empty">
                  <IconFileText size={28} />
                  <p>{collection && collection.apis.length === 0 ? '该 Collection 暂无接口' : '选择左侧接口'}</p>
                  {collection && collection.apis.length === 0 && !isPreview && (
                    <button type="button" className="ed-btn primary" onClick={openCreate}><IconPlus size={13} /> 新建接口</button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {collectionForm && (
          <div className="lib-confirm-overlay" role="presentation" onClick={() => !collectionSaving && setCollectionForm(null)}>
            <div className="lib-confirm lib-form" role="dialog" aria-modal="true" aria-label={collectionForm.mode === 'create' ? '新建 Collection' : '重命名 Collection'} onClick={(event) => event.stopPropagation()}>
              <div className="lib-confirm-title">{collectionForm.mode === 'create' ? '新建 Collection' : '重命名 Collection'}</div>
              <label className="ed-field">
                <span className="ed-lbl">名称</span>
                <input
                  className="ed-inp"
                  autoFocus
                  value={collectionName}
                  placeholder="Collection 名称"
                  aria-label="Collection 名称"
                  onChange={(event) => { setCollectionName(event.target.value); setCollectionFormError(null) }}
                  onKeyDown={(event) => { if (event.key === 'Enter') void submitCollectionForm() }}
                />
              </label>
              <label className="ed-field">
                <span className="ed-lbl">描述（可选）</span>
                <textarea
                  className="ed-ta"
                  rows={2}
                  value={collectionDescription}
                  placeholder="用途说明（可选）"
                  aria-label="Collection 描述"
                  onChange={(event) => setCollectionDescription(event.target.value)}
                />
              </label>
              {collectionFormError && <div className="lib-confirm-error"><IconAlertTriangle size={12} /> {collectionFormError}</div>}
              <div className="lib-confirm-acts">
                <button type="button" className="ed-btn" onClick={() => setCollectionForm(null)} disabled={collectionSaving}>取消</button>
                <button type="button" className="ed-btn primary" onClick={() => void submitCollectionForm()} disabled={collectionSaving || !collectionName.trim()}>
                  {collectionSaving ? '保存中…' : collectionForm.mode === 'create' ? '创建' : '保存'}
                </button>
              </div>
            </div>
          </div>
        )}

        {archiveCollectionTarget && (
          <div className="lib-confirm-overlay" role="presentation">
            <div className="lib-confirm" role="alertdialog" aria-modal="true" aria-label="确认归档 Collection">
              <div className="lib-confirm-icon"><IconArchive size={18} /></div>
              <div className="lib-confirm-title">归档 Collection</div>
              <p className="lib-confirm-body">
                确认归档 <strong>{archiveCollectionTarget.name}</strong>？归档后该 Collection 及其接口会从接口库中移除，可在后端恢复。
              </p>
              {archiveCollectionError && <div className="lib-confirm-error"><IconAlertTriangle size={12} /> {archiveCollectionError}</div>}
              <div className="lib-confirm-acts">
                <button type="button" className="ed-btn" onClick={() => setArchiveCollectionTarget(null)} disabled={archivingCollection}>取消</button>
                <button type="button" className="ed-btn primary danger" onClick={() => void confirmArchiveCollection()} disabled={archivingCollection}>
                  {archivingCollection ? '归档中…' : '归档'}
                </button>
              </div>
            </div>
          </div>
        )}

        {archiveTarget && (
          <div className="lib-confirm-overlay" role="presentation">
            <div className="lib-confirm" role="alertdialog" aria-modal="true" aria-label="确认归档">
              <div className="lib-confirm-icon"><IconArchive size={18} /></div>
              <div className="lib-confirm-title">归档接口</div>
              <p className="lib-confirm-body">
                确认归档 <strong>{archiveTarget.name}</strong>？归档后将从接口库、搜索与选择器中移除，可在后端恢复。
              </p>
              {archiveError && <div className="lib-confirm-error"><IconAlertTriangle size={12} /> {archiveError}</div>}
              <div className="lib-confirm-acts">
                <button type="button" className="ed-btn" onClick={() => setArchiveTarget(null)} disabled={archiving}>取消</button>
                <button type="button" className="ed-btn primary danger" onClick={() => void confirmArchive()} disabled={archiving}>
                  {archiving ? '归档中…' : '归档'}
                </button>
              </div>
            </div>
          </div>
        )}

        {confirmImportExit && (
          <div className="lib-confirm-overlay" role="presentation">
            <div className="lib-confirm" role="alertdialog" aria-modal="true" aria-label="放弃导入">
              <div className="lib-confirm-icon"><IconAlertTriangle size={18} /></div>
              <div className="lib-confirm-title">放弃导入</div>
              <p className="lib-confirm-body">导入的内容尚未保存，离开后将被丢弃且不会生成已保存接口。确认放弃？</p>
              <div className="lib-confirm-acts">
                <button type="button" className="ed-btn" onClick={() => { pendingImportExitRef.current = null; setConfirmImportExit(false) }}>继续编辑</button>
                <button
                  type="button"
                  className="ed-btn primary danger"
                  onClick={() => {
                    const action = pendingImportExitRef.current
                    pendingImportExitRef.current = null
                    setConfirmImportExit(false)
                    action?.()
                  }}
                >
                  放弃导入
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
