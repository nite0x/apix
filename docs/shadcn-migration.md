# shadcn/ui migration

Branch: `feat/shadcn-ui-migration`, based on main `9ecdd5c`.

## Delivery stages

1. Inventory and architecture: record routes, behavior contracts and decisions.
2. Foundation: React/TypeScript/Vite, Tailwind/shadcn components, API/query layer, navigation, Go embedding and build integration.
3. Service vertical slice: environment checks, editing, lifecycle, status and logs.
4. Workspace migration: HTTP, SQL, MCP, commands, AI tools, home and logs.
5. Testing migration: cases, flows, execution records, immutable snapshots and lifecycle management.
6. Verification: behavior tests, browser/API integration, production build and Go checks.
7. Cutover: remove legacy renderer/styles/tests, update documentation and CI.

Each completed stage receives a separate Git commit. Feature work may proceed concurrently; commits include only completed units.

## Route and behavior inventory

| Route | Required behavior |
| --- | --- |
| `/`, `/activity` | Status, counters, links and runtime connection feedback |
| `/services` | Filters, CRUD, environment selection/checks, save/start distinction, start/stop, details/logs |
| `/requests` | Collections, import, library, draft/send/save/copy/conflicts, response/history reuse and management |
| `/databases` | Connections/credentials/checks, SQL typed parameters, safe results/cell detail and history |
| `/mcp-tools` | Transports/auth/environment, discovery, schema input, execution, saved cases and history |
| `/commands` | Program/args/cwd/environment/stdin/timeout, execution, assertions, cases and history |
| `/ai-tools` | Target OS, discovery, install preview/apply/manual instructions, safe fingerprinted removal |
| `/tests` | Search/filter/edit/copy/archive/restore/run saved cases, linked snapshots |
| `/flows` | Existing step types/order/finally, inputs/outputs/references/assertions, copy/save/version conflict/run |
| `/execution-records` | Filter/search/paginate, batch/run deep links, polling/cancel/retry, typed immutable details |
| `/test-collections` | Compatibility with existing execution-record links |
| `/logs` | Incremental polling, sources, pause/autoscroll, bounded display, stored queries and preview cleanup |

Cross-cutting: dirty drafts survive polling/errors; submit actions cannot double-execute; stale responses cannot replace current data; non-success persisted runs retain details; names/content render as text; archived/deleted definitions retain historical evidence; restores retain IDs; destructive cleanup uses server previews/tokens and rechecks protections.

## Architecture decisions

- Keep Go APIs and Tauri sidecar protocol. No backend business/schema changes are intended.
- New source lives in `frontend/`. Production assets are generated beneath `runtime/internal/activity/web/dist/`; source and generated assets are separate.
- React Router owns routing, including legacy query compatibility. TanStack Query owns server state; local controlled state owns drafts. React Hook Form/Zod validate appropriate structured forms.
- shadcn/ui source is maintained locally over Radix primitives, with Tailwind and semantic CSS variables. UI density remains appropriate for a desktop developer tool. Specialized SQL/JSON/log views remain domain components.
- Build frontend before Go embedding in every build/test/package entrypoint. Production requires no Node process or remote CDN.
- No product redesign of flow orchestration, human handling or pause rules (AGENTS.md constraint).
- Existing 19 browser test files are a behavior inventory; replace DOM-ID coupling with component/user-interaction tests and retain pure-model assertions.
- Migration is authorized to make local commits, not to push or publish.

## Validation record

Foundation: `pnpm build:web` passed; API/dirty-navigation tests passed (5 assertions/tests across 2 files); `go test ./internal/activity` passed with the new static asset mount. Full-feature checks follow after all modules are integrated.

## Decision log

- 2026-10-22: Use isolated feature modules during parallel implementation; shared component/API contracts are coordinated centrally. Retain all existing API semantics rather than inventing per-page operations absent from the backend.

- Foundation: official `shadcn` CLI generated the local Radix-based components. Multiple editor dirty scopes are aggregated into one router blocker. Go dependencies downloaded successfully using the configured proxy; the older environment startup note about blocked downloads is stale.

## Stage 3 — service vertical slice

Implemented the service page, controlled RHF/Zod editor, canonical execution-environment checks, optimistic edit versions, save-only/save-and-start retry semantics, owner-aware controls, polled details/logs, and shared lifecycle dialogs. The route guard now uses a shadcn AlertDialog. Targeted tests: 16 passed across API, dirty-navigation, service and lifecycle suites. New assets remain staged alongside legacy entrypoints until the final cutover.

## Stage 4 — workspaces

Migrated home, HTTP requests/collections, database connections and SQL, MCP tools, command execution/case editors, AI tool integration and live logs. Feature suites passed: requests 10, databases 8, tools 9, AI tools 3 (30 total). Dedicated large-cell inspectors and 100-row SQL result pagination avoid mounting all 10,000 possible rows. Password omission, masked header preservation, edit versions and real backend batch ownership semantics remain intact. Live logs retain pause/autoscroll/source deep links and screen-only clearing. Application routes are lazy-loaded. API cancellation now combines caller signals with operation timeouts.
