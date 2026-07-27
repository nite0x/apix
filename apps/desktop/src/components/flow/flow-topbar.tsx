import { useEffect, useRef, useState } from 'react'
import { IconApi, IconHistory, IconSearch } from '@tabler/icons-react'
import { useFlowStore, type SaveState } from '../../store/flow-store'
import type { Flow } from '../../services/flow-client'

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Save failed',
  conflict: 'Conflict',
}

interface Props {
  flow: Flow
  onSearch: () => void
  onLibrary: () => void
  onRunHistory: () => void
}

export function FlowTopbar({ flow, onSearch, onLibrary, onRunHistory }: Props) {
  const saveState = useFlowStore((s) => s.saveStateById[flow.id] ?? 'saved')
  const updateDraft = useFlowStore((s) => s.updateDraft)
  const flushSave = useFlowStore((s) => s.flushSave)
  const reloadServerVersion = useFlowStore((s) => s.reloadServerVersion)
  const duplicateFlow = useFlowStore((s) => s.duplicateFlow)

  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(flow.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  useEffect(() => {
    if (!editing) setNameDraft(flow.name)
  }, [flow.name, editing])

  function commitName() {
    const trimmed = nameDraft.trim()
    setEditing(false)
    if (trimmed && trimmed !== flow.name) {
      updateDraft(flow.id, (draft) => ({ ...draft, name: trimmed }))
    } else {
      setNameDraft(flow.name)
    }
  }

  return (
    <div className="topbar flow-topbar-restored">
      <div className="tb-title flow-topbar-main">
        {editing ? (
          <input
            ref={inputRef}
            className="flow-name-input"
            value={nameDraft}
            maxLength={120}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName()
              if (e.key === 'Escape') { setNameDraft(flow.name); setEditing(false) }
            }}
          />
        ) : (
          <button type="button" className="flow-name" onClick={() => setEditing(true)} title="Rename flow">
            {flow.name}
          </button>
        )}
        <div className={`flow-save-state s-${saveState}`} role="status" aria-live="polite">
          <span className="porb" />
          <span>{SAVE_LABEL[saveState]}</span>
          {saveState === 'error' && (
            <button type="button" className="linkish" onClick={() => void flushSave(flow.id)}>Retry</button>
          )}
          {saveState === 'conflict' && (
            <>
              <button type="button" className="linkish" onClick={() => void reloadServerVersion(flow.id)}>Reload</button>
              <button type="button" className="linkish" onClick={() => void duplicateFlow(flow.id)}>Duplicate mine</button>
            </>
          )}
        </div>
      </div>
      <button type="button" className="tb-search" aria-label="搜索接口" onClick={onSearch}>
        <IconSearch size={13} /> 搜索接口… <kbd>⌘K</kbd>
      </button>
      <button type="button" className="tb-btn" aria-label="打开接口库" onClick={onLibrary}>
        <IconApi size={13} /> 接口库
      </button>
      <button type="button" className="tb-btn" aria-label="打开请求历史" onClick={onRunHistory}>
        <IconHistory size={13} /> 请求历史
      </button>
    </div>
  )
}
