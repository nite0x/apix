import { IconApi, IconHistory, IconPlayerPlay, IconPlayerStop, IconSearch } from '@tabler/icons-react'
import type { Session } from '../../store/session-store'

interface Props {
  session: Session | null
  onReview: () => void
  onStop: () => void
  onSearch: () => void
  onLibrary: () => void
  onRunHistory: () => void
}

export function Topbar({
  session,
  onReview,
  onStop,
  onSearch,
  onLibrary,
  onRunHistory,
}: Props) {
  const pill = !session ? '' :
    session.status === 'paused' ? 'pill pl-paused' :
    session.type === 'manual' ? 'pill pl-manual' :
    session.status === 'running' ? 'pill pl-run' :
    session.status === 'done' ? 'pill pl-done' :
    session.status === 'failed' ? 'pill pl-err' :
    'pill pl-manual'

  const pillText = !session ? '' :
    session.status === 'running'
      ? `Running · step ${session.steps.filter(s => s.status === 'done').length + 1}`
      : session.status === 'paused'
        ? 'Paused by rule'
      : session.status === 'done'
        ? `Done · ${session.steps.filter(s => s.type !== 'think').length} steps`
        : session.status === 'failed'
          ? `Failed · step ${session.steps.findIndex(s => s.status === 'error') + 1}`
          : session.status === 'stopped' ? 'Stopped' : 'Manual'

  const titleStyle =
    session?.type === 'manual' ? { fontFamily: 'monospace', fontSize: '12px' } : {}

  return (
    <div className="topbar">
      {session ? (
        <>
          <div className="tb-title" style={titleStyle}>
            <span>{session.name}</span>
            {session.currentStep && (
              <small>
                {`Step ${session.currentStep} of ${session.totalSteps ?? session.steps.length}`}
              </small>
            )}
          </div>
          <div className={pill}>
            <div className="porb" />
            <span>{pillText}</span>
          </div>
        </>
      ) : (
        <div className="tb-title" style={{ color: '#bbb' }}>Apix</div>
      )}

      {session?.status === 'paused' && (
        <>
          <button type="button" className="tb-btn tb-review" onClick={onReview}><IconPlayerPlay size={13} /> Review</button>
          <button type="button" className="tb-btn tb-stop" onClick={onStop}><IconPlayerStop size={13} /> Stop</button>
          <div className="tb-sep" />
        </>
      )}
      <button type="button" className="tb-search" aria-label="搜索接口" onClick={onSearch}><IconSearch size={13} /> 搜索接口… <kbd>⌘K</kbd></button>
      <button type="button" className="tb-btn" aria-label="打开接口库" onClick={onLibrary}><IconApi size={13} /> 接口库</button>
      <button type="button" className="tb-btn" aria-label="打开请求历史" onClick={onRunHistory}><IconHistory size={13} /> 请求历史</button>
    </div>
  )
}
