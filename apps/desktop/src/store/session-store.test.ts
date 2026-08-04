import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore, type Session } from './session-store'

const session: Session = {
  id: 'manual-1',
  type: 'manual',
  name: 'API test',
  status: 'idle',
  startedAt: 1,
  currentStep: 2,
  totalSteps: 2,
  steps: [
    { id: 'step-1', type: 'manual-input', status: 'error' },
    { id: 'step-2', type: 'manual-input', status: 'done' },
  ],
}

beforeEach(() => {
  useSessionStore.setState({ sessions: [session], activeSessionId: session.id })
})

describe('session step removal', () => {
  it('removes the first manual API test step and updates progress metadata', () => {
    useSessionStore.getState().removeStep(session.id, 'step-1')

    const updated = useSessionStore.getState().sessions[0]
    expect(updated.steps.map((step) => step.id)).toEqual(['step-2'])
    expect(updated.totalSteps).toBe(1)
    expect(updated.currentStep).toBe(1)
  })

  it('leaves unrelated sessions unchanged when the step does not exist', () => {
    useSessionStore.getState().removeStep(session.id, 'missing')
    expect(useSessionStore.getState().sessions[0]).toBe(session)
  })
})

describe('Scratch session creation', () => {
  it('starts an ephemeral multi-request workspace with one blank request', () => {
    useSessionStore.setState({ sessions: [], activeSessionId: null })

    const id = useSessionStore.getState().startScratchSession()
    const scratch = useSessionStore.getState().sessions[0]

    expect(scratch.id).toBe(id)
    expect(scratch.type).toBe('manual')
    expect(scratch.name).toBe('Scratch')
    expect(scratch.status).toBe('draft')
    expect(scratch.steps).toHaveLength(1)
    expect(scratch.steps[0].type).toBe('manual-input')

    const sameId = useSessionStore.getState().startScratchSession()
    expect(sameId).toBe(id)
    expect(useSessionStore.getState().sessions).toHaveLength(1)

    useSessionStore.getState().appendManualStep(id)
    expect(useSessionStore.getState().sessions[0].status).toBe('draft')
    expect(useSessionStore.getState().sessions[0].steps).toHaveLength(2)

    useSessionStore.getState().resetScratchSession(id)
    expect(useSessionStore.getState().sessions[0].steps).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0].status).toBe('draft')
  })

  it('preserves the local Scratch when backend sessions finish loading', () => {
    useSessionStore.setState({ sessions: [], activeSessionId: null })
    const scratchId = useSessionStore.getState().startScratchSession()
    useSessionStore.getState().setSessions([{
      id: 'ai-1',
      type: 'ai',
      name: 'AI run',
      status: 'running',
      startedAt: 1,
      steps: [],
    }])

    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual([scratchId, 'ai-1'])
    expect(useSessionStore.getState().activeSessionId).toBe(scratchId)
  })
})
