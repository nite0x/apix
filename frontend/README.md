# Frontend

The React/TypeScript workspace uses Vite, Tailwind CSS and locally maintained
shadcn/ui components over Radix. Go serves the built workspace and the existing
REST/MCP APIs; Tauri loads that same workspace from its managed sidecar.

## Development

```sh
pnpm install --frozen-lockfile
pnpm dev:backend                 # builds embedded UI, then starts/reuses Go on 4317
pnpm dev:frontend                # optional Vite HMR on 1420, proxies REST to 4317
```

Use the Go URL to verify production embedding and CSP. Vite uses `/` during
development; production assets use `/activity/ui/`. Build artifacts live under
`runtime/internal/activity/web/dist/` and are ignored by Git. All repository
runtime/sidecar build entrypoints build the frontend first. Before invoking Go
commands directly from a clean checkout, run `pnpm build:web`.

## Structure

- `src/App.tsx`: lazy route boundaries, navigation and mobile Sheet.
- `src/components/ui`: official shadcn sources, customized for density, Chinese
  close labels, scrolling and CSP-compatible Select viewport styles.
- `src/components/shared.tsx`: form fields, status/error/empty states, safe code
  display and asynchronous confirmation dialogs.
- `src/components/lifecycle`: archive/restore, references, bulk actions, record
  cleanup, retention and stored logs. Server preview tokens remain authoritative.
- `src/lib`: API error/persisted-run handling, combined abort/timeout signals,
  activity cursors, legacy route normalization and aggregated dirty-navigation
  protection.
- `src/pages`: feature-owned workspaces. Drafts are controlled local state;
  TanStack Query manages server data and polling. Polling must not reset editors.

Complex SQL results use paginated shadcn Tables and full-value inspectors.
Specialized JSON, request, flow and log views remain domain components. Never
render target output as HTML. Runtime events show summary fields rather than
dumping arbitrary payload objects.

## Verification

```sh
pnpm check                      # TypeScript, React Hooks lint and tooling syntax
pnpm format:check
pnpm test:web                   # Vitest + Testing Library, behavior/model tests
pnpm test:runtime               # build web, then all Go tests
pnpm build:runtime              # production frontend embedded in standalone Go
```

For real browser → API → SQLite → rendered-history verification, use the
[isolated Playwright workflow](e2e/README.md). It covers route refresh/aliases,
responsive screenshots, service save-only operations, HTTP and flow execution,
history persistence and SQL validation. Desktop native packages require the
platform-specific Rust/Tauri dependencies and are built in the desktop CI matrix.

## CSP

Go generates a unique style nonce per document and supplies it through a meta
tag. The entrypoint sets the `get-nonce` convention for Radix scroll locking, and
Select passes the nonce explicitly to its viewport stylesheet. Keep the CSP
strict; do not introduce `unsafe-inline` scripts/styles to accommodate components.

## Adding components

```sh
pnpm dlx shadcn@latest add <component>
```

Check generated imports against `@/lib/utils`, preserve local nonce handling,
and run formatting, type checking and affected behavior tests after generation.
The component registry may change; review generated changes like application code.
