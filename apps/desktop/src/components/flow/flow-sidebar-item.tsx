import { useState } from 'react'
import { IconDots, IconRoute } from '@tabler/icons-react'
import { useFlowStore, type SaveState } from '../../store/flow-store'
import { useFlowRunStore } from '../../store/flow-run-store'
import type { FlowSummary } from '../../services/flow-client'

const RUN_DOT: Record<string, string> = {
  queued: 'd-idle', running: 'd-run', paused: 'd-paused',
  succeeded: 'd-done', failed: 'd-err', cancelled: 'd-err',
}

interface Props {
  summary: FlowSummary
  active: boolean
  onOpen: () => void
  onRequestRename: () => void
  onRequestDelete: () => void
}

export function FlowSidebarItem({ summary, active, onOpen, onRequestRename, onRequestDelete }: Props) {
  const saveState = useFlowStore((s) => s.saveStateById[summary.id]) as SaveState | undefined
  const duplicateFlow = useFlowStore((s) => s.duplicateFlow)
  const runIds = useFlowRunStore((s) => s.runIdsByFlow[summary.id])
  const latestRun = useFlowRunStore((s) => (runIds && runIds[0] ? s.runsById[runIds[0]] : undefined))
  const [menuOpen, setMenuOpen] = useState(false)

  const showSaveBadge = saveState === 'saving' || saveState === 'error' || saveState === 'conflict'
  const saveBadge = saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed' : 'Conflict'

  return (
    <div className={`si flow-si${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
      <button type="button" className="flow-si-open" onClick={onOpen}>
        <span className="si-icon"><IconRoute size={13} /></span>
        <span className="si-label">{summary.name}</span>
        {showSaveBadge && <span className={`flow-si-badge b-${saveState}`}>{saveBadge}</span>}
        {latestRun && <span className={`sdot ${RUN_DOT[latestRun.status] ?? 'd-idle'}`} title={latestRun.status} />}
      </button>
      <button type="button" className="flow-si-menu-btn" aria-label="Flow menu" onClick={() => setMenuOpen((v) => !v)}>
        <IconDots size={14} />
      </button>
      {menuOpen && (
        <div className="flow-si-menu" onMouseLeave={() => setMenuOpen(false)}>
          <button type="button" onClick={() => { setMenuOpen(false); onRequestRename() }}>Rename</button>
          <button type="button" onClick={() => { setMenuOpen(false); void duplicateFlow(summary.id) }}>Duplicate</button>
          <button type="button" className="danger" onClick={() => { setMenuOpen(false); onRequestDelete() }}>Delete</button>
        </div>
      )}
    </div>
  )
}
