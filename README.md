# Apix

**Apix — Agentic Procedural Interface eXecution**

Apix is a local API debugging and testing workspace. A Go process serves the embedded Web UI and REST API at `http://127.0.0.1:4317/`. Local AI clients connect to MCP over stdio, without an IP address or port.

## Features

- Send HTTP requests and inspect persisted responses, errors, and execution history.
- Organize saved interfaces into collections; import cURL or raw HTTP, review, debug, and save.
- Search saved interfaces; pin, filter, delete, and reuse request history.
- Manage database connections and execute MySQL, PostgreSQL, and Hologres SQL.
- Manage local service definitions and inspect service output and runtime logs.
- Discover and test external MCP tools over Streamable HTTP; save cases and inspect results with the [MCP testing workflow](docs/MCP_TESTING.md).
- Execute command-line programs or scripts, assert exit codes and stdout/stderr, and reuse cases through [command testing](docs/COMMAND_TESTING.md).
- Run independent test batches and reusable cases through the [API testing workflow](docs/API_TESTING.md).
- Existing Flow pages remain available. Flow and pause-rule product design is deferred; the UI consolidation does not extend it.

## Development

Use the current macOS, Linux, Windows or WSL workspace with Node.js 22.20+, pnpm 9.15+, and Go 1.23+. Desktop development additionally requires Rust 1.90+ and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Optional mise versions are declared in `.mise.toml`.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` and `pnpm dev:browser` start the Go runtime and open the workspace after a successful health check. They reuse an existing healthy runtime. For terminal-only startup, use `pnpm dev:backend`.

The React/TypeScript UI lives in `frontend/`, using shadcn/ui and Tailwind CSS. Runtime and desktop build commands compile it into `runtime/internal/activity/web/dist/` before Go embeds it. Restart the runtime to load newly embedded assets. For frontend HMR, run `pnpm dev:frontend` alongside the backend and open `http://127.0.0.1:1420/`; Vite proxies the existing APIs to port 4317. See [frontend development](frontend/README.md).

Development keeps the existing database and adjacent credentials key in `~/Library/Application Support/dev.apix.desktop/` on macOS, `$XDG_DATA_HOME/dev.apix.desktop/` (default `~/.local/share/`) on Linux, or `%LOCALAPPDATA%\dev.apix.desktop\` on Windows. Set `APIX_DB_PATH` for an isolated database. Direct executable startup defaults to `apix.db` in the caller's directory.

## Checks

```bash
pnpm check
pnpm test:web
pnpm test:runtime
pnpm build
```

`pnpm check` runs TypeScript, React Hooks lint and tooling syntax checks. Web tests use Vitest, Testing Library and jsdom. `pnpm format:check` verifies frontend formatting. `pnpm test:runtime` builds the embedded UI before running Go tests; before running Go commands directly from a clean checkout, run `pnpm build:web`. For real browser/API/persistence verification, see the [isolated Playwright workflow](frontend/e2e/README.md).

## Desktop and standalone builds

```bash
pnpm dev:desktop                 # Tauri window + freshly built Go sidecar
pnpm build                       # native Tauri installer (same as build:desktop)
pnpm build:windows               # Windows only: NSIS installer with Rust MSVC
pnpm build:runtime               # standalone Go backend in release/
pnpm build:sidecar && pnpm test:sidecar
```

Tauri 2 owns the desktop window and Go sidecar. The same Go binary serves the embedded workspace, REST and MCP; the desktop loads it after a readiness handshake. Reopening the app focuses the existing window. Closing the window or quitting gracefully stops the owned backend and its managed resources. For an always-on MCP runtime, run the standalone backend instead.

Desktop workspace defaults to port 4319; browser development stays on 4317. MCP uses `apix-runtime mcp-stdio --socket <local socket or named pipe>`. The **AI 工具** page generates the complete command for each client. Keep Apix running while using MCP. Windows retains `%LOCALAPPDATA%\Apix\data`; macOS and Linux retain the developer data directories above. Data and credentials are never included in installers. See [desktop build and lifecycle](docs/DESKTOP.md) and [Windows installation](docs/WINDOWS.md).

The host backend build writes `apix-runtime` and the optional demo API to `release/`. On Windows, `start.ps1` keeps data and logs in the release's `data` directory unless configured explicitly. The demo API is not started with the workspace.

## Repository layout

- `frontend`: React workspaces, local shadcn/ui components, themes and tests.
- `runtime/internal/activity/web/dist`: generated frontend assets embedded in Go.
- `runtime`: Go runtime, REST, MCP, SQLite, and service management.
- `src-tauri`: Tauri desktop shell and native installer configuration.
- `desktop`: small startup screen and icon source; the workspace UI stays embedded in Go.
- `scripts`: development, sidecar and standalone builds, and checks.
- `docs`: [user guide](docs/user-guide.md), [development workflow](docs/development-workflow.md).

## Endpoints

- Workspace: `http://127.0.0.1:4317/`
- Health: `GET /health`
- MCP: stdio via the local runtime command; no TCP MCP endpoint
- REST: `/api`
- Execution events: `GET /api/events`

See the [standalone runtime guide](runtime/GUIDE.md) for configuration and examples.

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).
