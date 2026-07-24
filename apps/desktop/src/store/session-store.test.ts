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
