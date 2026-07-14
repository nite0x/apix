import { useEffect, useMemo, useRef, useState } from 'react'
import { IconApi, IconSearch, IconSend, IconTimeline } from '@tabler/icons-react'
import { allApis, type ApiCollectionGroup, type ApiDefinition } from '../../data/api-catalog'

interface RequestSelection {
  method: string
  url: string
  api?: ApiDefinition
}
interface Props {
  mode: 'flow' | 'step'
  catalog: ApiCollectionGroup[]
  statusMessage?: string | null
  onClose: () => void
  onSelect: (selection: RequestSelection) => void
}

export function RequestPicker({ mode, catalog, statusMessage, onClose, onSelect }: Props) {
  const [tab, setTab] = useState<'blank' | 'library'>('blank')
  const [method, setMethod] = useState('GET')
  const [url, setUrl] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(allApis(catalog)[0]?.id ?? null)
  const rootRef = useRef<HTMLDivElement>(null)
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const items = allApis(catalog)
    return normalized ? items.filter((api) => `${api.method} ${api.name} ${api.url}`.toLowerCase().includes(normalized)) : items
  }, [catalog, query])
  const selectedApi = allApis(catalog).find((api) => api.id === selectedId)

  useEffect(() => {
    function handlePointer(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose()
    }
    window.addEventListener('mousedown', handlePointer)
    return () => window.removeEventListener('mousedown', handlePointer)
  }, [onClose])

  return (
    <div ref={rootRef} className={`nr-popover open ${mode === 'step' ? 'step-pop' : 'flow-pop'}`} role="dialog" aria-label={mode === 'step' ? 'Add next step' : 'Start new flow'}>
      <div className={`nr-context ${mode}`}>{mode === 'step' ? 'Append a request after the current step.' : 'Start a fresh API run. This creates a separate flow in Live.'}</div>
      <div className="nr-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'blank'} className={`nr-tab${tab === 'blank' ? ' active' : ''}`} onClick={() => setTab('blank')}>空白请求</button>
        <button type="button" role="tab" aria-selected={tab === 'library'} className={`nr-tab${tab === 'library' ? ' active' : ''}`} onClick={() => setTab('library')}>从接口库选择</button>
      </div>

      {tab === 'blank' && (
        <div className="nr-pane active">
          <div className="nr-url-row">
            <select className="nr-sel" value={method} onChange={(event) => setMethod(event.target.value)}>{['GET', 'POST', 'PUT', 'DELETE'].map((item) => <option key={item}>{item}</option>)}</select>
            <input className="nr-inp" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" autoFocus />
          </div>
          <button type="button" className="nr-open-btn" disabled={!url.trim()} onClick={() => onSelect({ method, url })}>
            <IconTimeline size={12} /> {mode === 'step' ? 'Add to current flow' : 'Start new flow'}
          </button>
        </div>
      )}

      {tab === 'library' && (
        <div className="nr-pane active">
          {statusMessage && catalog.length === 0 ? (
            <div className="catalog-status compact" role="status">{statusMessage}</div>
          ) : (
            <>
              <label className="nr-search"><IconSearch size={12} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索接口…" /></label>
              <div className="nr-api-list">
                {catalog.map((collection) => {
                  const collectionApis = results.filter((api) => api.collectionId === collection.id)
                  if (collectionApis.length === 0) return null
                  return (
                    <div key={collection.id}>
                      <div className="nr-sec-lbl">{collection.name}</div>
                      {collectionApis.map((api) => (
                        <button type="button" className={`nr-api-it${selectedId === api.id ? ' selected' : ''}`} key={api.id} onClick={() => setSelectedId(api.id)}>
                          <span className={`api-m am-${api.method.toLowerCase()}`}>{api.method}</span>{api.name}
                        </button>
                      ))}
                    </div>
                  )
                })}
              </div>
              <button type="button" className="nr-use-btn" disabled={!selectedApi} onClick={() => selectedApi && onSelect({ method: selectedApi.method, url: selectedApi.url, api: selectedApi })}>
                {mode === 'step' ? <IconApi size={12} /> : <IconSend size={12} />} {mode === 'step' ? 'Add selected API' : 'Start with selected API'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
