# Apix

**Apix — Agentic Procedural Interface eXecution**

Apix is a local API debugging and testing workspace. A Go process serves the Web UI, REST API, and MCP endpoint at `http://127.0.0.1:4317/`. The UI is embedded in the executable.

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

Web assets live in `runtime/internal/activity/web` and are embedded at Go build time. Restart the runtime after editing them.

Development keeps the existing database and adjacent credentials key in `~/Library/Application Support/dev.apix.desktop/` on macOS, `$XDG_DATA_HOME/dev.apix.desktop/` (default `~/.local/share/`) on Linux, or `%LOCALAPPDATA%\dev.apix.desktop\` on Windows. Set `APIX_DB_PATH` for an isolated database. Direct executable startup defaults to `apix.db` in the caller's directory.

## Checks

```bash
pnpm check
pnpm test:web
pnpm test:runtime
pnpm build
```

`pnpm check` checks Web and tooling JavaScript syntax. Web tests use Node's test runner and jsdom. Go tests cover the backend.

## Desktop and standalone builds

```bash
pnpm dev:desktop                 # Tauri window + freshly built Go sidecar
pnpm build                       # native Tauri installer (same as build:desktop)
pnpm build:windows               # Windows only: NSIS installer with Rust MSVC
pnpm build:runtime               # standalone Go backend in release/
pnpm build:sidecar && pnpm test:sidecar
```

Tauri 2 owns the desktop window and Go sidecar. The same Go binary serves the embedded workspace, REST and MCP; the desktop loads it after a readiness handshake. Reopening the app focuses the existing window. Closing the window or quitting gracefully stops the owned backend and its managed resources. For an always-on MCP runtime, run the standalone backend instead.

Desktop MCP stays at `http://127.0.0.1:4319/mcp` by default; browser development stays on 4317. Windows retains `%LOCALAPPDATA%\Apix\data`; macOS and Linux retain the developer data directories above. Data and credentials are never included in installers. See [desktop build and lifecycle](docs/DESKTOP.md) and [Windows installation](docs/WINDOWS.md).

The host backend build writes `apix-runtime` and the optional demo API to `release/`. On Windows, `start.ps1` keeps data and logs in the release's `data` directory unless configured explicitly. The demo API is not started with the workspace.

## Repository layout

- `runtime/internal/activity/web`: the only UI source.
- `runtime`: Go runtime, REST, MCP, SQLite, and service management.
- `src-tauri`: Tauri desktop shell and native installer configuration.
- `desktop`: small startup screen and icon source; the workspace UI stays embedded in Go.
- `scripts`: development, sidecar and standalone builds, and checks.
- `docs`: [user guide](docs/user-guide.md), [development workflow](docs/development-workflow.md).

## Endpoints

- Workspace: `http://127.0.0.1:4317/`
- Health: `GET /health`
- MCP: `/mcp`
- REST: `/api`
- Execution events: `GET /api/events`

See the [standalone runtime guide](runtime/GUIDE.md) for configuration and examples.

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).
