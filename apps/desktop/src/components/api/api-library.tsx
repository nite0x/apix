import { useMemo, useState } from 'react'
import {
  IconAlertTriangle,
  IconArchive,
  IconFileImport,
  IconFileText,
  IconLock,
  IconPlus,
  IconSearch,
  IconUsers,
  IconX,
} from '@tabler/icons-react'
import type { ApiCollectionGroup, ApiDefinition } from '../../data/api-catalog'
import { archiveRequest, importCurl } from '../../services/api-client'
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

type EditorState = { mode: 'create' | 'edit'; api?: ApiDefinition }

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
  const [importState, setImportState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<ApiDefinition | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)

  const collection = catalog.find((item) => item.id === collectionId) ?? catalog[0]
  const filteredApis = useMemo(() => {
    if (!collection) return []
    const normalized = query.trim().toLowerCase()
    if (!normalized) return collection.apis
    return collection.apis.filter((api) => `${api.method} ${api.name} ${api.url}`.toLowerCase().includes(normalized))
  }, [collection, query])
  const selectedApi = catalog.flatMap((item) => item.apis).find((api) => api.id === apiId) ?? null

  function chooseCollection(id: string) {
    setEditor(null)
    setCollectionId(id)
    setApiId(catalog.find((item) => item.id === id)?.apis[0]?.id ?? null)
  }

  function chooseApi(id: string) {
    setEditor(null)
    setApiId(id)
  }

  async function submitImport() {
    if (!importContent.trim()) return
    setImportState('sending')
    try {
      await onCatalogMutation(() => importCurl(importContent))
      setImportState('done')
    } catch {
      setImportState('error')
    }
  }

  function openCreate() {
    if (!collection) return
    setImportOpen(false)
    setEditor({ mode: 'create' })
  }

  function openEdit(api: ApiDefinition) {
    setEditor({ mode: 'edit', api })
  }

  function handleSaved(requestId: string) {
    setEditor(null)
    setApiId(requestId)
  }

  async function confirmArchive() {
    if (!archiveTarget) return
    setArchiving(true)
    setArchiveError(null)
    try {
      const target = archiveTarget
      await onCatalogMutation(() => archiveRequest(target.id))
      if (apiId === target.id) setApiId(null)
      if (editor?.api?.id === target.id) setEditor(null)
      setArchiveTarget(null)
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : 'Archive failed')
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div className="lib-overlay open" role="presentation">
      <section className="lib-modal" role="dialog" aria-modal="true" aria-label="接口库">
        <div className="lib-header">
          <div className="lib-title">接口库</div>
          <label className="lib-search">
            <IconSearch size={12} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索接口…" />
          </label>
          <button type="button" className={`lib-hbtn${importOpen ? ' active' : ''}`} onClick={() => setImportOpen((open) => !open)}>
            <IconFileImport size={12} /> 导入
          </button>
          <button type="button" className="lib-close" aria-label="Close API library" onClick={onClose}><IconX size={15} /></button>
        </div>

        {importOpen && (
          <div className="lib-import-bar">
            <textarea value={importContent} onChange={(event) => { setImportContent(event.target.value); setImportState('idle') }} rows={2} placeholder="Paste curl or raw HTTP request…" />
            <button type="button" onClick={() => void submitImport()} disabled={importState === 'sending' || !importContent.trim()}>
              {importState === 'sending' ? 'Importing…' : 'Import as draft'}
            </button>
            {importState === 'done' && <span className="lib-import-ok">Imported as a working copy</span>}
            {importState === 'error' && <span className="lib-import-error">Runtime unavailable or request is invalid</span>}
          </div>
        )}

        <CatalogFeedback
          state={catalogState}
          error={catalogError}
          isPreview={isPreview}
          blocking={catalog.length === 0}
          onRetry={onRetry}
        />

        {catalog.length > 0 && (
          <div className="lib-body">
            <div className="col-coll">
              <div className="col-coll-head"><span className="col-hl">Collections</span><button type="button" aria-label="New collection"><IconPlus size={12} /></button></div>
              <div className="coll-list">
                {catalog.map((item) => (
                  <button type="button" className={`coll-it${item.id === collection?.id ? ' active' : ''}`} key={item.id} onClick={() => chooseCollection(item.id)}>
                    <span className={`coll-icon coll-icon-${item.icon}`}><CollectionIcon icon={item.icon} /></span>
                    <span className="coll-info">
                      <span className="coll-nm">{item.name}</span>
                      <span className="coll-cnt">{item.apis.length} apis{item.apis.some((api) => api.aiUsage) ? ` · AI ${item.apis.reduce((sum, api) => sum + (api.aiUsage?.count ?? 0), 0)}×` : ''}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="col-apis">
              <div className="col-apis-head">
                <span className="col-apis-title">{collection?.name ?? 'APIs'}</span>
                <button type="button" aria-label="New API" onClick={openCreate} disabled={isPreview}><IconPlus size={12} /></button>
              </div>
              <div className="api-list">
                {filteredApis.length === 0 && <div className="api-list-empty">No matching APIs</div>}
                {filteredApis.map((api) => (
                  <button type="button" className={`api-it${api.id === selectedApi?.id && !editor ? ' active' : ''}`} key={api.id} onClick={() => chooseApi(api.id)}>
                    <span className={`api-m am-${api.method.toLowerCase()}`}>{api.method === 'DELETE' ? 'DEL' : api.method}</span>
                    <span className="api-nm">{api.name}</span>
                    {api.aiUsage && <span className="api-ai" title="Used by AI" />}
                  </button>
                ))}
              </div>
              <div className="col-apis-footer">
                <button type="button" className="api-add-btn" onClick={openCreate} disabled={isPreview}><IconPlus size={12} /> 新建接口</button>
              </div>
            </div>

            <div className="col-det">
              {editor ? (
                <ApiEditor
                  key={editor.mode === 'edit' ? `edit-${editor.api?.id}` : 'create'}
                  mode={editor.mode}
                  collectionId={editor.mode === 'edit' ? (editor.api?.collectionId ?? collection?.id ?? '') : (collection?.id ?? '')}
                  collectionName={editor.mode === 'edit' ? (editor.api?.collectionName ?? '') : (collection?.name ?? '')}
                  api={editor.api}
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
                <div className="det-empty"><IconFileText size={28} /><p>选择左侧接口</p></div>
              )}
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
      </section>
    </div>
  )
}
