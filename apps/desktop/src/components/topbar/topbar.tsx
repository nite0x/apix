import { IconApi, IconPlayerPlay, IconPlayerStop, IconSearch } from '@tabler/icons-react'
import type { Session } from '../../store/session-store'

interface Props {
  session: Session | null
  onReview: () => void
  onStop: () => void
  onSearch: () => void
  onLibrary: () => void
}

export function Topbar({ session, onReview, onStop, onSearch, onLibrary }: Props) {
  if (!session) {
    return (
      <div className="topbar">
        <div className="tb-title" style={{ color: '#bbb' }}>Select a session</div>
      </div>
    )
  }

  const pill =
    session.status === 'paused' ? 'pill pl-paused' :
    session.status === 'draft' ? 'pill pl-paused' :
    session.status === 'running' ? 'pill pl-run' :
    session.status === 'done' ? 'pill pl-done' :
    session.status === 'failed' ? 'pill pl-err' :
    'pill pl-manual'

  const pillText =
    session.status === 'running'
      ? `Running · step ${session.steps.filter(s => s.status === 'done').length + 1}`
      : session.status === 'paused'
        ? 'Paused by rule'
        : session.status === 'draft'
          ? 'Draft flow'
      : session.status === 'done'
        ? `Done · ${session.steps.filter(s => s.type !== 'think').length} steps`
        : session.status === 'failed'
          ? `Failed · step ${session.steps.findIndex(s => s.status === 'error') + 1}`
          : session.status === 'stopped' ? 'Stopped' : 'Manual'

  const titleStyle =
    session.type === 'manual' ? { fontFamily: 'monospace', fontSize: '12px' } : {}

  return (
    <div className="topbar">
      <div className="tb-title" style={titleStyle}>
        <span>{session.status === 'draft' ? 'Untitled flow' : session.type === 'manual' ? session.name : session.name}</span>
        {(session.currentStep || session.status === 'draft') && <small>{session.status === 'draft' ? 'Draft' : `Step ${session.currentStep} of ${session.totalSteps ?? session.steps.length}`}</small>}
      </div>
      <div className={pill}>
        <div className="porb" />
        <span>{pillText}</span>
      </div>
      <div className="tb-sep" />
      {session.status === 'paused' && (
        <>
          <button type="button" className="tb-btn tb-review" onClick={onReview}><IconPlayerPlay size={13} /> Review</button>
          <button type="button" className="tb-btn tb-stop" onClick={onStop}><IconPlayerStop size={13} /> Stop</button>
          <div className="tb-sep" />
        </>
      )}
      <button type="button" className="tb-search" onClick={onSearch}><IconSearch size={13} /> 搜索接口… <kbd>⌘K</kbd></button>
      <button type="button" className="tb-btn" onClick={onLibrary}><IconApi size={13} /> 接口库</button>
    </div>
  )
}
