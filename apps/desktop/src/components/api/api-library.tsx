import { useMemo, useState } from 'react'
import {
  IconFileImport,
  IconFileText,
  IconLock,
  IconPlus,
  IconSearch,
  IconUsers,
  IconX,
} from '@tabler/icons-react'
import type { ApiCollectionGroup, ApiDefinition } from '../../data/api-catalog'
import { importCurl } from '../../services/api-client'
import { ApiDetail } from './api-detail'

interface Props {
  catalog: ApiCollectionGroup[]
  onClose: () => void
  onJumpToSession: () => void
}

function CollectionIcon({ icon }: { icon: ApiCollectionGroup['icon'] }) {
  if (icon === 'lock') return <IconLock size={13} />
  if (icon === 'users') return <IconUsers size={13} />
  return <IconFileText size={13} />
}

export function ApiLibrary({ catalog, onClose, onJumpToSession }: Props) {
  const [collectionId, setCollectionId] = useState(catalog[1]?.id ?? catalog[0]?.id ?? '')
  const [apiId, setApiId] = useState<string | null>(catalog[1]?.apis[0]?.id ?? catalog[0]?.apis[0]?.id ?? null)
  const [query, setQuery] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importContent, setImportContent] = useState('')
  const [importState, setImportState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')

  const collection = catalog.find((item) => item.id === collectionId) ?? catalog[0]
  const filteredApis = useMemo(() => {
    if (!collection) return []
    const normalized = query.trim().toLowerCase()
    if (!normalized) return collection.apis
    return collection.apis.filter((api) => `${api.method} ${api.name} ${api.url}`.toLowerCase().includes(normalized))
  }, [collection, query])
  const selectedApi = catalog.flatMap((item) => item.apis).find((api) => api.id === apiId) ?? null

  function chooseCollection(id: string) {
    setCollectionId(id)
    setApiId(catalog.find((item) => item.id === id)?.apis[0]?.id ?? null)
  }

  async function submitImport() {
    if (!importContent.trim()) return
    setImportState('sending')
    try {
      await importCurl(importContent)
      setImportState('done')
    } catch {
      setImportState('error')
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
            <div className="col-apis-head"><span className="col-apis-title">{collection?.name ?? 'APIs'}</span><button type="button" aria-label="New API"><IconPlus size={12} /></button></div>
            <div className="api-list">
              {filteredApis.length === 0 && <div className="api-list-empty">No matching APIs</div>}
              {filteredApis.map((api) => (
                <button type="button" className={`api-it${api.id === selectedApi?.id ? ' active' : ''}`} key={api.id} onClick={() => setApiId(api.id)}>
                  <span className={`api-m am-${api.method.toLowerCase()}`}>{api.method === 'DELETE' ? 'DEL' : api.method}</span>
                  <span className="api-nm">{api.name}</span>
                  {api.aiUsage && <span className="api-ai" title="Used by AI" />}
                </button>
              ))}
            </div>
            <div className="col-apis-footer"><button type="button" className="api-add-btn"><IconPlus size={12} /> 新建接口</button></div>
          </div>

          <div className="col-det">
            {selectedApi ? <ApiDetail key={selectedApi.id} api={selectedApi} context="library" onJumpToSession={onJumpToSession} /> : (
              <div className="det-empty"><IconFileText size={28} /><p>选择左侧接口</p></div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
