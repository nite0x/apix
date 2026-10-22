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

## Stage 5 — cases, flows and execution records

Migrated saved cases, HTTP/MCP/command editors, flow definitions and typed steps, assertions/extractors/output references, run inputs, execution batches and immutable flow results. Preserved version conflicts, incremental saves, selected result tabs, archived/deleted dependencies and purged-definition snapshots. Regression fixes include React StrictMode save lifecycle, invalid SQL JSON drafts across tab changes, environment-provided required variables and dirty lifecycle action protection. Existing route aliases/query links are normalized without losing batch/run/step IDs.

## Stage 6 — verification and production entry

Switched the Go document to the compiled React entry, retaining all page paths.
Assets use hashed immutable URLs and actual MIME types. Each document receives a
fresh style nonce; Radix scroll locking uses the global nonce convention and
SelectViewport receives its explicit nonce. Real-browser CSP errors identified
the latter integration requirement; scripts/styles remain protected without
`unsafe-inline`. Mobile navigation now uses a focus-managed shadcn Sheet.

Executed validation:

- TypeScript, ESLint React Hooks rules/exhaustive dependencies, tooling syntax and Prettier checks passed.
- 21 frontend test files / 59 behavior/model tests passed.
- Existing 19 legacy test files / 39 tests passed before removal, as a baseline cross-check.
- Full `go test ./...` passed, including embedded asset/API tests.
- Production Playwright suite passed on the isolated runtime: all routes and aliases, 1440/390px screenshots, no document overflow, service save/edit/archive without starting programs, real HTTP request persistence/reload/pin, SQL validation, flow execution and durable run/step links.
- Explicit Go executable sidecar checks passed: readiness/workspace/MCP and shutdown, EOF, closed parent pipes, plus occupied-port refusal.

Native Tauri windows and macOS/Windows/Linux installers were not executed in the
headless cloud environment (Rust/native GUI prerequisites are absent). Their CI
matrix remains configured; the Go sidecar protocol and production embedded UI
were exercised locally. No user database, credentials or configured external
business services were used; browser tests used `/tmp/apix-shadcn-e2e/`.

Decision details: SQL records use existing execution-batch management (there is
no SQL-specific pin/hide API). Step output selection copies and displays a
reference for pasting instead of inserting at the former cursor position.

## Stage 7 — cutover and cleanup

Removed the 32 original HTML/JavaScript/CSS files and 19 DOM-ID-based test files.
Go embeds only `web/dist`; the old static filename whitelist and old asset route
are removed. New test entrypoints use Vitest/Testing Library. Removed unused
`cn`, duplicate direct Radix packages and the unused TanStack Table dependency.
Updated README, AGENTS, frontend architecture instructions and CI: frontend
changes trigger the native desktop matrix, and a dedicated browser job builds and
runs an isolated production runtime with Playwright evidence artifacts.

The final service regression also covers selected-user WSL environment checks,
canonical environment IDs, unchanged edit versions and saving without launching
WSL. This is a mocked UI contract test; host-specific WSL execution remains
covered by existing Go/platform acceptance tests.

### Behavior test replacement map

| Previous test area | Replacement evidence |
| --- | --- |
| AI installation/verification/removal | `pages/ai-tools/ai-tools.test.tsx`, lifecycle tests |
| Service management/manual service/environment | `pages/services/services.test.tsx`, real browser service workflow |
| Collections/import/request drafts/history | `pages/requests/{model,requests,detail}.test.*`, real HTTP persistence workflow |
| Database editor/manual SQL/results/history | `pages/databases/{model,databases}.test.*`, browser SQL validation workflow |
| MCP server/tool/history | `pages/mcp/{model,index}.test.*`, shared command execution helpers |
| Command execution/cases/history | `pages/commands/{model,index}.test.*` |
| Saved-case lifecycle/edit/retry/batches | `pages/testing/testing.test.tsx`, lifecycle tests, records tests |
| Flow models/output references/order/failure policies | `pages/flows/model.test.ts` |
| Flow save/conflict/draft/navigation | `pages/flows/flows.test.tsx`, `lib/use-dirty.test.tsx`, browser flow workflow |
| Execution records/layout/typed details/purged definitions | `pages/records/records.test.tsx`, request detail tests, browser immutable run links |
| Archive/restore/bulk/cleanup/retention/stored logs | `components/lifecycle/lifecycle.test.tsx` |
| Live logs, pause, clear, source selection, safe output | `pages/logs/logs.test.tsx` |
| Legacy routes, static assets, CSP | `lib/routes.test.ts`, nonce test, Go activity test and production browser suite |

### Stage commits

1. `e8d89d6` — inventory and behavior baseline.
2. `4a2498d` — engineering foundation and build pipeline.
3. `8affb58` — service vertical slice and lifecycle components.
4. `06b1845` — request/database/tool/overview workspaces.
5. `3888162` — saved cases, flows and execution records.
6. `2af63b4` — production/browser/sidecar verification and source formatting.
7. Final cleanup commit — legacy removal, CI and documentation.

Final cutover validation: 60/60 frontend tests, 7/7 production browser tests,
full Go regression, frozen-lockfile installation, standalone release build,
sidecar lifecycle/MCP checks, YAML parsing and diff/format/type/Hooks checks all
passed. The browser suite was repeated against the final `release/apix-runtime`
with legacy sources/routes removed; `/activity/assets/app.js` returns 404.
The dedicated test backend was stopped after verification. Local changes are
committed on the migration branch; no remote push or release was performed.
