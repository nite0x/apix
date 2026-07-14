import { IconApi, IconTimeline, IconX } from '@tabler/icons-react'
import type { ApiDefinition } from '../../data/api-catalog'
import type { Step } from '../../store/session-store'
import { ApiDetail } from './api-detail'

interface Props {
  api: ApiDefinition
  source: 'run' | 'library'
  step?: Step
  onClose: () => void
  onJumpToSession: () => void
}
export function ApiDrawer({ api, source, step, onClose, onJumpToSession }: Props) {
  return (
    <>
      <button type="button" className="dim show" aria-label="Close API detail" onClick={onClose} />
      <aside className="drawer open" aria-label="API detail">
        <div className="dr-topbar">
          <button type="button" className="dr-close" aria-label="Close" onClick={onClose}><IconX size={14} /></button>
          <div className={`dr-from${source === 'run' ? ' exec' : ''}`}>
            {source === 'run' ? <IconTimeline size={11} /> : <IconApi size={11} />}
            {source === 'run' ? `来自执行步骤 · ${step?.method ?? api.method} ${step?.url ?? api.url}` : '接口库'}
          </div>
        </div>
        <div className="dr-content">
          <ApiDetail
            api={api}
            context={source}
            runContext={source === 'run' ? {
              request: step?.requestBody?.split('\n')[0] ?? `${api.method} ${api.url}`,
              authorization: step?.resolvedVars?.length ? 'Bearer ••••••••••••' : undefined,
              rule: step?.ruleName,
            } : undefined}
            onJumpToSession={onJumpToSession}
          />
        </div>
      </aside>
    </>
  )
}
