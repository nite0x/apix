import { useEffect, useMemo, useRef, useState } from 'react'
import { IconLayoutSidebarRight, IconSearch } from '@tabler/icons-react'
import { allApis, type ApiCollectionGroup, type ApiDefinition } from '../../data/api-catalog'

interface Props {
  catalog: ApiCollectionGroup[]
  onClose: () => void
  onSelect: (api: ApiDefinition) => void
}

export function ApiSearch({ catalog, onClose, onSelect }: Props) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const items = allApis(catalog)
    return (normalized ? items.filter((api) => `${api.method} ${api.name} ${api.url} ${api.collectionName}`.toLowerCase().includes(normalized)) : items).slice(0, 8)
  }, [catalog, query])

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setActiveIndex(0) }, [query])

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') onClose()
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    }
    if (event.key === 'Enter' && results[activeIndex]) onSelect(results[activeIndex])
  }

  return (
    <section className="search-modal open" role="dialog" aria-modal="true" aria-label="Search APIs">
      <div className="sm-inp-row">
        <IconSearch size={15} />
        <input ref={inputRef} className="sm-inp" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleKeyDown} placeholder="搜索接口名称、路径…" />
        <button type="button" className="sm-esc" onClick={onClose}>ESC</button>
      </div>
      <div className="sm-section">
        <div className="sm-sec-lbl">接口</div>
        {results.length === 0 && <div className="search-empty">No matching APIs</div>}
        {results.map((api, index) => (
          <button
            type="button"
            className={`sm-item${index === activeIndex ? ' focus' : ''}`}
            key={api.id}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => onSelect(api)}
          >
            <span className={`sm-method am-${api.method.toLowerCase()}`}>{api.method}</span>
            <span className="sm-name">{api.url.replace('{{base_url}}', '')}</span>
            <span className="sm-coll">{api.collectionName}</span>
            <span className="sm-hint"><IconLayoutSidebarRight size={11} /> 打开详情</span>
          </button>
        ))}
      </div>
      <div className="sm-footer"><kbd>↑↓</kbd> 导航 <kbd>↵</kbd> 打开详情 <kbd>ESC</kbd> 关闭</div>
    </section>
  )
}

