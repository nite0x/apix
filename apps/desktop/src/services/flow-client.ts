import type { RequestData } from '../data/api-catalog'
import { API_BASE } from './api-client'

// ── Flow domain types (mirror the runtime JSON shapes) ───────────────────────

export interface FlowSettings {
  stop_on_error: boolean
  request_timeout_ms: number
}

export interface FlowVariableDefinition {
  name: string
  default_value?: string
  required: boolean
  secret: boolean
  description?: string
}

export interface FlowExtractor {
  name: string
  source: 'body' | 'header' | 'status'
  path?: string
  scope: 'run'
  secret: boolean
  required: boolean
}

export interface FlowStepConfig {
  timeout_ms?: number
  continue_on_error: boolean
  extractors: FlowExtractor[]
}

export interface FlowStep {
  id: string
  position: number
  type: 'http'
  name: string
  enabled: boolean
  source_api_request_id: string | null
  request: RequestData
  config: FlowStepConfig
}

export interface Flow {
  id: string
  project_id: string
  name: string
  description: string
  environment_id: string | null
  settings: FlowSettings
  variables: FlowVariableDefinition[]
  steps: FlowStep[]
  edit_version: number
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface FlowSummary {
  id: string
  project_id: string
  name: string
  description: string
  environment_id: string | null
  step_count: number
  edit_version: number
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type FlowRunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'
export type FlowRunStepStatus =
  | 'pending' | 'running' | 'paused' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'

export interface FlowRunStep {
  id: string
  flow_run_id: string
  flow_step_id: string | null
  position: number
  name_snapshot: string
  request_snapshot: RequestData
  status: FlowRunStepStatus
  api_run_id: string | null
  error_code?: string
  error_message?: string
  started_at: string | null
  finished_at: string | null
}

export interface FlowRun {
  id: string
  project_id: string
  flow_id: string | null
  flow_version: number
  flow_name_snapshot: string
  environment_id: string | null
  trigger_type: string
  status: FlowRunStatus
  current_step: number
  total_steps: number
  error_code?: string
  error_message?: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  steps?: FlowRunStep[]
}

// ── Errors ───────────────────────────────────────────────────────────────

/** Raised when a save is rejected because the server edit_version moved on. */
export class FlowConflictError extends Error {
  readonly current?: { id: string; edit_version: number; updated_at: string }
  constructor(current?: { id: string; edit_version: number; updated_at: string }) {
    super('flow version conflict')
    this.name = 'FlowConflictError'
    this.current = current
  }
}

async function json<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string; current?: FlowConflictError['current'] }
  if (response.status === 409) throw new FlowConflictError(data.current)
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`)
  return data
}

// ── Flow CRUD ────────────────────────────────────────────────────────────

export async function listFlows(projectId = 'default', includeArchived = false): Promise<FlowSummary[]> {
  const params = new URLSearchParams({ project_id: projectId, include_archived: String(includeArchived) })
  const flows = await fetch(`${API_BASE}/flows?${params.toString()}`).then(json<FlowSummary[] | null>)
  return flows ?? []
}

export async function createFlow(name?: string, projectId = 'default'): Promise<Flow> {
  return fetch(`${API_BASE}/flows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, name }),
  }).then(json<Flow>)
}

export async function getFlow(id: string): Promise<Flow> {
  return fetch(`${API_BASE}/flows/${encodeURIComponent(id)}`).then(json<Flow>)
}

/** Saves the full aggregate under optimistic concurrency. */
export async function putFlow(flow: Flow): Promise<Flow> {
  return fetch(`${API_BASE}/flows/${encodeURIComponent(flow.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(flow),
  }).then(json<Flow>)
}

export interface PatchFlowInput {
  name?: string
  description?: string
  environment_id?: string | null
  edit_version: number
}

/** Metadata-only update (sidebar rename). */
export async function patchFlow(id: string, input: PatchFlowInput): Promise<Flow> {
  return fetch(`${API_BASE}/flows/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<Flow>)
}

export async function deleteFlow(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/flows/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) {
    throw new Error(`Delete failed (${response.status})`)
  }
}

export async function restoreFlow(id: string): Promise<FlowSummary> {
  return fetch(`${API_BASE}/flows/${encodeURIComponent(id)}/restore`, { method: 'POST' }).then(json<FlowSummary>)
}

export async function duplicateFlow(id: string): Promise<Flow> {
  return fetch(`${API_BASE}/flows/${encodeURIComponent(id)}/duplicate`, { method: 'POST' }).then(json<Flow>)
}

// ── Flow runs ──────────────────────────────────────────────────────────────

export interface StartRunInput {
  expected_flow_version: number
  environment_id?: string
  variables?: Record<string, string>
}

export async function startFlowRun(flowId: string, input: StartRunInput): Promise<FlowRun> {
  return fetch(`${API_BASE}/flows/${encodeURIComponent(flowId)}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(json<FlowRun>)
}

export async function listFlowRuns(flowId: string, limit = 50): Promise<FlowRun[]> {
  const runs = await fetch(
    `${API_BASE}/flows/${encodeURIComponent(flowId)}/runs?limit=${limit}`,
  ).then(json<FlowRun[] | null>)
  return runs ?? []
}

export async function getFlowRun(id: string): Promise<FlowRun> {
  return fetch(`${API_BASE}/flow-runs/${encodeURIComponent(id)}`).then(json<FlowRun>)
}

export async function cancelFlowRun(id: string): Promise<FlowRun> {
  return fetch(`${API_BASE}/flow-runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).then(json<FlowRun>)
}

export async function resumeFlowRunStep(
  runId: string,
  stepRunId: string,
  action: 'continue' | 'skip' | 'stop',
): Promise<FlowRun> {
  return fetch(
    `${API_BASE}/flow-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepRunId)}/resume`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    },
  ).then(json<FlowRun>)
}
