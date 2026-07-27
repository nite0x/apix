# Apix Flow 完整设计与实现规格

状态：Proposed  
目标版本：Flow v1  
适用范围：`apps/desktop`、`runtime/internal/httpapi`，并与现有 `core.Session`、`api_runs` 兼容

## 1. 结论

Flow 必须是一个可长期保存和反复执行的“流程定义”，不能再用前端临时 `Session` 代替。

产品中需要明确区分四个对象：

| 对象 | 含义 | 是否长期保存 | 是否包含运行状态 |
|---|---|---:|---:|
| Flow | 用户编辑的流程定义 | 是 | 否 |
| Flow Step | Flow 中有序的请求步骤 | 是 | 否 |
| Flow Run | 一次 Flow 执行实例 | 是 | 是 |
| API Run | 一个 HTTP 请求的底层执行记录 | 是 | 是 |

现有 `core.Session` 继续表示 AI/MCP 调用产生的会话，不再承担 Flow 定义职责。现有 `api_runs` 继续作为单个 HTTP 请求的权威历史记录。

## 2. v1 产品原则

1. 点击 `New flow` 后立即调用后端创建，因此刷新页面不会丢失。
2. 编辑采用自动保存，同时必须显示清晰的保存状态并支持显式 Save。
3. Flow 名字可以随时修改，不能再根据第一个请求 URL 强制覆盖。
4. 删除采用软删除；历史运行不删除，当前正在运行的实例不受影响。
5. Flow Step 保存完整请求快照。它可以记录来源 API，但不能依赖临时 Working Copy 才能恢复。
6. Flow 定义没有 `running`、`paused`、`done` 等状态；这些只属于 Flow Run。
7. 运行前必须先完成当前 Flow 的保存，运行的是一个明确版本的快照。
8. v1 只支持顺序 HTTP Step，不在第一版引入分支、循环、SQL、延时或定时调度。

## 3. 用户体验

### 3.1 Sidebar

Sidebar 主列表由当前 Session 列表改为已保存 Flow 列表：

```text
Flows
  Checkout smoke test        Saved
  Create user flow           Saving…
  Untitled flow              Save failed

Recent runs
  保留现有 Run history 入口
```

每个 Flow Item 包含：

- Flow 名称；
- 保存异常标记，仅在 `saving/error/conflict` 时显示；
- 当前 Flow Run 的运行状态（如果有），但不能把状态写回 Flow；
- `…` 菜单：Rename、Duplicate、Delete；
- 单击打开 Flow Editor。

排序规则：

- 默认按 `updated_at DESC`；
- 当前选中的 Flow 不因一次自动保存而突然跳位，直到切换或重新加载列表；
- 已归档 Flow 不出现在默认列表中。

### 3.2 新建

点击 `New flow`：

1. `POST /api/flows`，body 可为空；
2. 后端创建名为 `Untitled flow` 的持久化 Flow；
3. 前端收到 Flow 后再导航到编辑器；
4. 创建失败时不生成假的本地 Flow，显示 Retry。

允许创建空 Flow，但空 Flow 的 Run 按钮必须禁用。

### 3.3 重命名

Topbar 的名称是可编辑字段：

- 单击名称或 Rename 进入编辑；
- Enter 或失焦提交；
- Escape 恢复原值；
- 去除首尾空格；
- 名称长度为 1–120 个字符；
- Flow 名称允许重复；
- 修改名字走与 Flow 一样的保存状态，不使用本地临时名称。

Sidebar 菜单中的 Rename 使用 `PATCH /api/flows/:id`，无需先加载完整 Flow。

### 3.4 保存

Topbar 必须显示：

- `Saved`：当前本地内容与服务器一致；
- `Unsaved changes`：内容已经修改但尚未发送；
- `Saving…`：请求进行中；
- `Save failed · Retry`：网络或服务端错误；
- `Conflict`：服务器版本发生变化。

保存策略：

- 任意定义字段变化后 600ms debounce 自动保存；
- `Cmd/Ctrl + S` 立即保存；
- Topbar 提供 Save 按钮，dirty 时可点击；
- 切换 Flow、运行 Flow 前先 flush pending save；
- 保存失败时保留本地 draft，不得用重新请求的数据静默覆盖；
- 页面关闭时仍为 dirty/error，使用 `beforeunload` 提示。

不要将“保存 Flow”和当前 `ManualForm` 中的“Save API”混为一谈：

- Save Flow：保存 Flow 和 Flow Steps；
- Save API：将某个 Step 的请求另存或更新到 API Library。

### 3.5 Step 编辑

Flow Editor 中每个 Step 是定义，不展示上一次执行的 response/status。

Step 支持：

- 添加空白 HTTP 请求；
- 从 API Library 添加；
- 从 curl/raw HTTP 导入；
- 编辑名称、method、URL、query、headers、body、auth；
- 上移、下移或拖拽排序；
- 启用/禁用；
- 删除；
- Duplicate；
- 配置失败策略和变量提取。

从 API Library 添加时，将请求内容复制成 Step 快照，同时保存可选的 `source_api_request_id`。之后 API Library 中的请求变化不得静默改写 Flow；未来可以单独提供 “Refresh from API”。

Step 名称默认取 API 名称，空白请求默认取 `METHOD path`，但用户手动改名后不能再自动覆盖。

### 3.6 删除

删除 Flow：

1. 显示确认框：`Delete “Flow name”? Run history will be kept.`
2. `DELETE /api/flows/:id`；
3. 后端设置 `archived_at`，不物理删除；
4. Sidebar 立即移除；
5. 如果删除的是当前 Flow，选择下一个 Flow；没有则显示空状态；
6. Toast 提供短时间 Undo，调用 restore endpoint；
7. 正在执行的 Flow Run 使用创建时快照继续运行。

### 3.7 运行

Topbar 提供独立 Run 按钮。

点击 Run：

1. flush 当前保存；
2. 校验至少有一个 enabled Step；
3. `POST /api/flows/:id/runs`，携带 `expected_flow_version`；
4. 后端生成 Flow 和所有 Step 的不可变快照；
5. 返回 `202 Accepted` 和 Flow Run；
6. UI 切换到 Run View，而不是把结果写进 Flow Editor；
7. Run View 通过 WebSocket/刷新获得步骤状态。

如果服务端版本与 `expected_flow_version` 不一致，返回 409，前端不得执行不确定版本。

## 4. 领域模型

### 4.1 Flow

```ts
interface Flow {
  id: string
  project_id: string
  name: string
  description: string
  environment_id: string | null
  settings: FlowSettings
  variables: FlowVariableDefinition[]
  steps: FlowStep[]
  edit_version: number
  created_by?: string
  updated_by?: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

interface FlowSettings {
  stop_on_error: boolean       // 默认 true
  request_timeout_ms: number   // 默认 60000，范围 1000–300000
}

interface FlowVariableDefinition {
  name: string
  default_value?: string
  required: boolean
  secret: boolean
  description?: string
}
```

约束：

- `name` trim 后 1–120；
- `description` 最大 2000；
- `edit_version` 每次成功写入加 1；
- secret variable 不能在 Flow 中保存 `default_value`；
- `archived_at != null` 表示已删除。

### 4.2 Flow Step

```ts
interface FlowStep {
  id: string
  position: number
  type: 'http'
  name: string
  enabled: boolean
  source_api_request_id: string | null
  request: RequestData
  config: FlowStepConfig
}

interface FlowStepConfig {
  timeout_ms?: number
  continue_on_error: boolean
  extractors: FlowExtractor[]
}

interface FlowExtractor {
  name: string
  source: 'body' | 'header' | 'status'
  path?: string
  scope: 'run'
  secret: boolean
  required: boolean
}
```

`RequestData` 直接复用当前 HTTP domain：

```ts
interface RequestData {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'
  url: string
  query_params: KeyValue[]
  headers: KeyValue[]
  body_type: 'none' | 'json' | 'text' | 'form' | 'multipart' | 'binary'
  body?: string
  auth_config?: Record<string, unknown>
}
```

提取器的 `path` v1 使用简单点路径，如 `data.user.id`，不实现完整 JSONPath。Header 名称不区分大小写。required extractor 找不到值时，Step 视为失败。

### 4.3 Flow Run

```ts
type FlowRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

interface FlowRun {
  id: string
  project_id: string
  flow_id: string | null
  flow_version: number
  flow_name_snapshot: string
  environment_id: string | null
  trigger_type: 'manual' | 'ai' | 'test'
  status: FlowRunStatus
  current_step: number
  total_steps: number
  started_at: string | null
  finished_at: string | null
  created_at: string
  error_code?: string
  error_message?: string
  steps?: FlowRunStep[]
}
```

### 4.4 Flow Run Step

```ts
type FlowRunStepStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'

interface FlowRunStep {
  id: string
  flow_run_id: string
  flow_step_id: string | null
  position: number
  name_snapshot: string
  request_snapshot: RequestData
  status: FlowRunStepStatus
  api_run_id: string | null
  started_at: string | null
  finished_at: string | null
  error_code?: string
  error_message?: string
}
```

Flow Run Step 只保存运行关联和必要快照。完整 response 仍由 `api_runs` 持有，不能在两张表重复保存。

## 5. SQLite 设计

将 HTTP schema 升级到 v3。v3 必须采用非破坏性 migration，不得继续 drop v2 的 API Library、Working Copy 和 Run 数据。

```sql
CREATE TABLE flows (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  settings       TEXT NOT NULL DEFAULT '{}',
  variables      TEXT NOT NULL DEFAULT '[]',
  edit_version   INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT,
  updated_by     TEXT,
  created_at     DATETIME NOT NULL,
  updated_at     DATETIME NOT NULL,
  archived_at    DATETIME
);

CREATE INDEX idx_flows_project_updated
  ON flows(project_id, updated_at DESC);

CREATE INDEX idx_flows_active
  ON flows(project_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE flow_steps (
  id                    TEXT PRIMARY KEY,
  flow_id               TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  position              INTEGER NOT NULL,
  type                  TEXT NOT NULL CHECK (type IN ('http')),
  name                  TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  source_api_request_id TEXT REFERENCES api_requests(id) ON DELETE SET NULL,
  request_data          TEXT NOT NULL,
  config                TEXT NOT NULL DEFAULT '{}',
  created_at            DATETIME NOT NULL,
  updated_at            DATETIME NOT NULL,
  UNIQUE(flow_id, position)
);

CREATE INDEX idx_flow_steps_order
  ON flow_steps(flow_id, position);

CREATE TABLE flow_runs (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  flow_id            TEXT REFERENCES flows(id) ON DELETE SET NULL,
  flow_version       INTEGER NOT NULL,
  flow_name_snapshot TEXT NOT NULL,
  flow_snapshot      TEXT NOT NULL,
  environment_id     TEXT REFERENCES environments(id) ON DELETE SET NULL,
  trigger_type       TEXT NOT NULL CHECK (trigger_type IN ('manual','ai','test')),
  status             TEXT NOT NULL CHECK (
    status IN ('queued','running','paused','succeeded','failed','cancelled')
  ),
  current_step       INTEGER NOT NULL DEFAULT 0,
  total_steps        INTEGER NOT NULL,
  variables_snapshot TEXT NOT NULL DEFAULT '{}',
  error_code         TEXT,
  error_message      TEXT,
  created_at         DATETIME NOT NULL,
  started_at         DATETIME,
  finished_at        DATETIME
);

CREATE INDEX idx_flow_runs_flow
  ON flow_runs(flow_id, created_at DESC);

CREATE INDEX idx_flow_runs_project
  ON flow_runs(project_id, created_at DESC);

CREATE TABLE flow_run_steps (
  id               TEXT PRIMARY KEY,
  flow_run_id      TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  flow_step_id     TEXT,
  position         INTEGER NOT NULL,
  name_snapshot    TEXT NOT NULL,
  request_snapshot TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (
    status IN ('pending','running','paused','succeeded','failed','skipped','cancelled')
  ),
  api_run_id       TEXT REFERENCES api_runs(id) ON DELETE SET NULL,
  error_code       TEXT,
  error_message    TEXT,
  started_at       DATETIME,
  finished_at      DATETIME,
  UNIQUE(flow_run_id, position)
);

CREATE INDEX idx_flow_run_steps_order
  ON flow_run_steps(flow_run_id, position);
```

Migration 注意事项：

- `httpSchemaVersion` 从 2 升至 3；
- v2 → v3 只创建新表和索引；
- 新安装仍一次创建完整 schema；
- migration 必须在事务中执行；
- migration 测试必须证明已有 collection/request/working-copy/api-run 仍存在。

## 6. REST API

所有接口沿用 `/api` 前缀。

### 6.1 Flow CRUD

```text
GET    /flows?project_id=default&include_archived=false
POST   /flows
GET    /flows/:id
PATCH  /flows/:id
PUT    /flows/:id
DELETE /flows/:id
POST   /flows/:id/restore
POST   /flows/:id/duplicate
```

#### POST /flows

Request：

```json
{
  "project_id": "default",
  "name": "Untitled flow"
}
```

`name` 可省略。返回 `201` 和完整 Flow。

#### GET /flows

返回 Flow Summary，不携带完整 `steps.request`，避免 Sidebar 加载过多数据：

```json
[
  {
    "id": "flow-id",
    "project_id": "default",
    "name": "Checkout smoke test",
    "description": "",
    "environment_id": null,
    "step_count": 3,
    "edit_version": 7,
    "created_at": "...",
    "updated_at": "...",
    "archived_at": null
  }
]
```

#### PUT /flows/:id

用于保存完整 aggregate。Body 包含 `edit_version`、metadata、settings、variables、steps。

服务端在一个事务中：

1. 校验当前 `edit_version`；
2. 更新 Flow；
3. upsert body 中的 Step；
4. 删除 body 中不存在的旧 Step；
5. 将 position 归一化为 `0..n-1`；
6. `edit_version + 1`；
7. 返回服务器标准化后的完整 Flow。

#### PATCH /flows/:id

只允许修改 `name`、`description`、`environment_id`，同样必须带 `edit_version`。主要用于 Sidebar rename。

#### DELETE /flows/:id

软删除，成功返回 `204`。重复删除也返回 `204`。不得删除 `flow_runs`。

#### POST /flows/:id/restore

清除 `archived_at`，返回恢复后的 Flow Summary。

#### POST /flows/:id/duplicate

在事务中复制 Flow 和 Step，名称默认为 `Original name copy`，返回 `201`。

### 6.2 Flow Run API

```text
POST /flows/:id/runs
GET  /flows/:id/runs?limit=50
GET  /flow-runs/:id
POST /flow-runs/:id/cancel
POST /flow-runs/:id/steps/:stepRunId/resume
```

创建 Run：

```json
{
  "expected_flow_version": 7,
  "environment_id": "optional-env-id",
  "variables": {
    "user_id": "123"
  }
}
```

返回 `202`：

```json
{
  "id": "run-id",
  "flow_id": "flow-id",
  "flow_version": 7,
  "status": "queued",
  "current_step": 0,
  "total_steps": 3
}
```

Resume：

```json
{
  "action": "continue",
  "modified_request": null
}
```

`action` 为 `continue | skip | stop`。

### 6.3 错误约定

| HTTP | 含义 |
|---:|---|
| 400 | JSON 或字段格式错误 |
| 404 | Flow/Run 不存在 |
| 409 | `edit_version` 或期望运行版本冲突 |
| 422 | Flow 存在但不可运行，例如没有有效 Step |
| 500 | 持久化或未分类内部错误 |

409 返回当前服务器版本：

```json
{
  "error": "flow version conflict",
  "current": {
    "id": "flow-id",
    "edit_version": 8,
    "updated_at": "..."
  }
}
```

## 7. 并发与冲突

前后端沿用 Working Copy 已有的 optimistic concurrency 思路。

- 所有 PUT/PATCH 必须携带客户端最后看到的 `edit_version`；
- SQL 更新使用 `WHERE id = ? AND edit_version = ?`；
- affected rows 为 0 时返回 409；
- 前端不能 last-write-wins；
- Conflict UI 提供：
  - `Reload server version`；
  - `Duplicate my version`；
- 不提供会静默覆盖服务器的 “Force save”。

同一个 Flow 的自动保存请求必须串行执行。保存 A 结束前发生修改 B，A 返回后仍保持 dirty，并继续保存 B，不能误显示 Saved。

## 8. 执行语义

### 8.1 快照

创建 Flow Run 时，在一个事务中保存：

- `flow_version`；
- Flow metadata/settings/variables 快照；
- 所有 enabled Step 的名称和 request/config 快照；
- Run 输入变量的脱敏快照。

之后 Flow 的编辑、重命名和删除都不影响该 Run。

### 8.2 顺序执行

Flow Executor 在后端运行，不在 React 中循环请求：

1. Run `queued → running`；
2. 按 position 执行 enabled Step；
3. Step `pending → running`；
4. 将 Step 请求快照传入现有 `executionService.Run`；
5. `RunCommand.SessionID = flow_run.id`；
6. `RunCommand.StepID = flow_run_step.id`；
7. 将返回的 `api_run.id` 写入 `flow_run_steps.api_run_id`；
8. 提取变量；
9. 根据 Step 结果和 `continue_on_error` 决定继续或停止；
10. 最终 Run 进入 `succeeded`、`failed` 或 `cancelled`。

HTTP 4xx/5xx 仍遵循当前 API Run 语义：请求传输成功即 `api_run.succeeded`。如果 Flow 需要把 HTTP status 视为失败，应以后由 assertion 配置实现，不要在 Flow Executor 中另造相反语义。

### 8.3 变量

变量合并顺序从低到高：

1. Environment variables；
2. Flow variable default；
3. 创建 Run 时传入的 variables；
4. 前序 Step extractor 产生的 variables。

支持在 URL、query、headers、body 中使用 `{{name}}`。`{{base_url}}` 来自 Environment 的 `base_url`。

安全要求：

- Environment secret 不复制到 Flow；
- secret variable 不在 API JSON 中返回明文；
- Flow Run 只持久化脱敏后的变量快照；
- request/response 继续使用现有 `api_runs` 的 redaction；
- 日志和 WebSocket event 不发送 secret 明文。

### 8.4 Pause Rules

Flow 执行必须使用现有 RuleEngine 的 before/after 规则，不能再实现一套不兼容规则。

- before rule 命中：Flow Run 和 Flow Run Step 都进入 `paused`；
- Continue：可选使用修改后的 request snapshot 继续；
- Skip：Step 进入 `skipped`，继续下一个；
- Stop：当前 Step 和 Run 进入 `cancelled`；
- after rule 命中：保存 API Run 后暂停，再由用户决定继续或停止。

实现时建议把当前 `core.Executor` 中规则检查、pause channel 和事件发送提取为可复用协调器；不要让 Flow 定义重新变成 `core.Session`。

### 8.5 Cancel

- cancel endpoint 必须幂等；
- queued/running/paused 可 cancel；
- completed Run 再次 cancel 返回当前状态；
- 使用 context cancellation 中断正在进行的 HTTP 请求；
- 后续 pending Step 标记为 `cancelled`。

## 9. WebSocket 事件

继续使用现有 `/ws/logs`，新增事件类型：

```text
flow_run.started
flow_run.step_started
flow_run.step_paused
flow_run.step_finished
flow_run.variable_extracted
flow_run.finished
```

公共 envelope：

```json
{
  "type": "flow_run.step_finished",
  "session_id": "flow-run-id",
  "step_id": "flow-run-step-id",
  "payload": {}
}
```

保留 `session_id` 字段仅用于兼容当前 Hub envelope，其值对 Flow event 表示 `flow_run.id`。前端按 event `type` 路由到 `flow-run-store`，不能塞回 `session-store`。

WebSocket 断线重连后必须调用 `GET /flow-runs/:id` 重新同步，不能假设事件完整。

## 10. Desktop 状态设计

新增：

```text
apps/desktop/src/services/flow-client.ts
apps/desktop/src/store/flow-store.ts
apps/desktop/src/store/flow-run-store.ts
apps/desktop/src/components/flow/flow-editor.tsx
apps/desktop/src/components/flow/flow-topbar.tsx
apps/desktop/src/components/flow/flow-sidebar-item.tsx
apps/desktop/src/components/flow/flow-delete-dialog.tsx
apps/desktop/src/components/flow/flow-run-view.tsx
```

`flow-store` 建议状态：

```ts
interface FlowStore {
  summaries: FlowSummary[]
  entities: Record<string, Flow>
  drafts: Record<string, Flow>
  selectedFlowId: string | null
  listState: 'idle' | 'loading' | 'ready' | 'error'
  saveStateById: Record<string, 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'>
  errorById: Record<string, string | undefined>

  loadFlows(): Promise<void>
  selectFlow(id: string): Promise<void>
  createFlow(): Promise<Flow>
  updateDraft(id: string, updater: (draft: Flow) => Flow): void
  flushSave(id: string): Promise<Flow>
  renameFlow(id: string, name: string): Promise<void>
  duplicateFlow(id: string): Promise<Flow>
  deleteFlow(id: string): Promise<void>
  restoreFlow(id: string): Promise<void>
}
```

关键规则：

- `entities` 是服务器最后确认版本；
- `drafts` 是用户正在编辑的版本；
- 不允许用 `loadFlows` 的 summary 覆盖已打开的 dirty draft；
- 不使用当前 `session-store.updateSession` 编辑 Flow；
- `ManualForm` 的 request state 应改为由 `FlowStep` draft 驱动；
- Working Copy 只在用户明确选择 “Save API” 时创建或更新，不再承担 Flow Step 自动保存。

`session-store` 保留给 AI/MCP Session 和兼容页面，逐步从 Sidebar 主导航移出。

## 11. Backend 文件建议

```text
runtime/internal/httpapi/domain.go
  增加 Flow/FlowStep/FlowRun/FlowRunStep DTO

runtime/internal/httpapi/migrate.go
  v3 非破坏性 migration

runtime/internal/httpapi/flow_repository.go
  Flow aggregate CRUD、archive/restore/duplicate、Flow Run persistence

runtime/internal/httpapi/flow_routes.go
  Flow 和 Flow Run REST routes

runtime/internal/httpapi/flow_execution.go
  后端顺序执行、cancel、pause/resume

runtime/internal/httpapi/routes.go
  注册 flowRoutes 和 flowRunRoutes

runtime/internal/app/app.go
  为 Flow Executor 注入 RuleEngine、Hub 和 HTTP execution service
```

Repository 不要把所有新逻辑继续堆进当前 `repository.go`。Flow aggregate 的写入必须使用 transaction。

## 12. 校验

保存 Flow 时服务端统一校验：

- Flow 名称和 description 长度；
- environment 属于相同 project；
- Step ID 在 Flow 内唯一；
- position 可排序且最终归一化；
- type 为已支持值；
- enabled HTTP Step 的 method、URL 合法；
- source API 存在时属于当前 project；
- timeout 范围合法；
- extractor name 合法且不重复；
- variable name 使用 `[A-Za-z_][A-Za-z0-9_]*`；
- secret variable 不包含 default value。

不要只在前端校验。

## 13. 测试要求

### 13.1 Go

至少覆盖：

- create/list/get/update Flow；
- aggregate update 正确新增、修改、删除、重排 Step；
- edit version 冲突返回 409；
- archive 后默认列表不可见；
- restore；
- duplicate 后 Step ID 全部重新生成；
- 删除来源 API 后 Flow Step 快照仍可读取；
- v2 → v3 migration 不丢已有 HTTP domain 数据；
- Run 使用固定 Flow version 快照；
- 顺序运行和 `continue_on_error`；
- variable substitution/extraction；
- pause continue/skip/stop；
- cancel 幂等；
- 删除 Flow 不删除历史 Run。

### 13.2 React/Vitest

至少覆盖：

- New Flow 等待后端成功后显示；
- 修改后状态 `dirty → saving → saved`；
- 保存期间再次编辑不会错误显示 Saved；
- Save error 保留输入并可 Retry；
- rename Enter/blur/Escape；
- delete confirm 与 Undo；
- dirty Flow 切换前 flush；
- 409 conflict 不覆盖本地 draft；
- Step add/delete/duplicate/reorder；
- Run 前先 save，save 失败时不启动 Run；
- WebSocket 事件只更新 Flow Run store。

### 13.3 手工验收

1. 新建 Flow，输入名字和两个请求，刷新应用，内容完整存在。
2. 离线编辑导致 Save failed；恢复 runtime 后 Retry 成功，内容未丢失。
3. Sidebar 和 Topbar 都能改名，刷新后仍正确。
4. 删除 Flow 后列表消失，Undo 后恢复。
5. 删除 Flow 后仍能在 Run History 查看旧 Run。
6. 编辑并保存 Flow v2，运行；运行期间继续编辑为 v3，当前 Run 仍显示 v2 快照。
7. 两个窗口编辑同一 Flow，旧版本保存得到 Conflict，且不会覆盖新版本。

## 14. 实现顺序

建议拆成四个可独立验证的阶段。

### Phase 1：持久化定义

- v3 migration；
- Flow/FlowStep domain 和 repository；
- CRUD、rename、archive、restore、duplicate；
- Go tests。

完成标准：curl 可以完整创建、更新、重排、删除和恢复 Flow。

### Phase 2：Desktop 编辑体验

- `flow-client`、`flow-store`；
- Sidebar Flow 列表；
- Topbar rename/save state；
- Flow Step 编辑、删除、排序；
- autosave、Cmd/Ctrl+S、conflict UI；
- React tests。

完成标准：刷新不丢 Flow，用户能明确看到保存、改名和删除。

### Phase 3：Flow Run

- Flow Run tables/repository/routes；
- 后端 Flow Executor；
- Run View 和 Flow Run Store；
- API Run 关联、variables、cancel；
- execution tests。

完成标准：关闭或刷新前端不会中断后端顺序执行，历史结果可恢复。

### Phase 4：Pause Rules 与清理

- 抽取可复用的 rule/pause coordinator；
- Flow Run WebSocket events；
- continue/skip/stop；
- 将 Flow 编辑逻辑完全移出 `session-store`；
- 保留 legacy AI/MCP Session 兼容。

## 15. 明确不在 v1 中实现

- 条件分支和循环；
- 并行 Step；
- 定时调度；
- 多人实时协作；
- 完整 JSONPath；
- Flow 模板市场；
- 自动跟随 API Library 最新版本；
- 将旧 Session 自动转换成 Flow；
- 永久物理删除 UI。

这些能力可以在当前模型上扩展，不应阻塞保存、改名、删除和顺序运行的基本闭环。

## 16. 对当前代码的替换关系

- 当前 `startNewFlow()` 创建本地 `manual-*` Session 的逻辑应删除；
- `Session.status === 'draft'` 不再表示 Flow；
- `updateSession()` 不再用于 Flow 名称和 Step；
- `ManualForm.send()` 不再通过 `updateSession()` 自动改 Flow 名；
- 当前 ManualForm 的自动 Working Copy 保存不能被当成 Flow 保存；
- Sidebar 的 Live/Recent Session 分组改为 Flow 列表，AI/MCP Session 可移入单独 Activity/Run 页面；
- Timeline 编辑模式接收 `Flow`/`FlowStep`，运行模式接收 `FlowRun`/`FlowRunStep`，不要继续用一个混合类型。

最终判断标准很简单：用户刷新应用后，Flow 的名字、顺序、请求内容和配置全部仍在；用户能看见是否已经保存；删除 Flow 不会破坏历史；每次执行都能指出自己运行的是哪个 Flow version。
