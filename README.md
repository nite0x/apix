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

Use Ubuntu WSL in `/home/nite/projects/apix` with Linux Node.js 22.20+, pnpm 9.15+, and Go 1.23+. Optional mise versions are declared in `.mise.toml`.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` and `pnpm dev:browser` start the Go runtime and open the workspace after a successful health check. They reuse an existing healthy runtime. For terminal-only startup, use `pnpm dev:backend`.

Web assets live in `runtime/internal/activity/web` and are embedded at Go build time. Restart the runtime after editing them.

Development keeps the existing database at `~/.local/share/dev.apix.desktop/apix.db` and its adjacent credentials key. This data path is retained to preserve existing data. Set `APIX_DB_PATH` for an isolated database. Direct executable startup defaults to `apix.db` in the caller's directory.

## Checks

```bash
pnpm check
pnpm test:web
pnpm test:runtime
pnpm build
```

`pnpm check` checks Web and tooling JavaScript syntax. Web tests use Node's test runner and jsdom. Go tests cover the backend.

## Standalone build

```bash
pnpm build
pnpm build:windows
```

The host build writes `apix-runtime` and the optional demo API to `release/`. The Windows build uses Linux Go and Python 3 to create `release/Apix_<version>_windows-x64.zip`. Its `Install.ps1` installs two standalone programs and creates an Apix desktop shortcut. The launcher runs the background server without a console and opens the browser on port 4319. See [Windows installation](docs/WINDOWS.md).

On Windows, `start.ps1` keeps data and logs in the release's `data` directory unless configured explicitly. The optional demo API is for smoke tests and is not started with the workspace.

## Repository layout

- `runtime/internal/activity/web`: the only UI source.
- `runtime`: Go runtime, REST, MCP, SQLite, and service management.
- `scripts`: development, standalone builds, and checks.
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
