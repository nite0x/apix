# Apix

**Agent Programmable Interface eXecution** — a local-first desktop developer tool for MCP-assisted API debugging, workflow execution, and run console logs.

## Status

Apix is an early public release. The current codebase includes the desktop
shell, local runtime, WebSocket event stream, HTTP collection management, and
manual request execution. Expect the product surface and internal contracts to
evolve quickly while the core workflow settles.

## Repository Layout

```text
apix/
  apps/desktop         React + TypeScript + Vite UI
  src-tauri            Tauri desktop shell and sidecar wiring
  runtime              Go local runtime service, HTTP API, WebSocket logs, SQLite owner
```

## Prerequisites

- Node.js 20+
- pnpm 9+
- Go 1.23+
- Rust stable
- Tauri system dependencies for your OS

## Environment Management

This repository is configured for reproducible local tooling with `mise` and
`rustup`.

```bash
brew install mise
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

Enable `mise` in zsh:

```bash
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc
eval "$(mise activate zsh)"
```

Install the project toolchain:

```bash
mise trust
mise install
```

Rust is pinned by `rust-toolchain.toml`; Node, pnpm, Go, and Rust are declared in
`.mise.toml`.

## Install Dependencies

```bash
pnpm install
```

`pnpm-workspace.yaml` manages the frontend workspace packages under `apps/*`
and `src-tauri`.

## Start Development

Start the full local development environment with one command:

```bash
pnpm dev
```

This starts the React/Vite dev server, the Go runtime service, and the Tauri
desktop shell together. `concurrently` keeps all process logs in one terminal
and stops the group when one process exits.

## Start Modules Independently

Run the React frontend only:

```bash
pnpm dev:frontend
```

Run the Go runtime only:

```bash
pnpm dev:backend
```

Run the Tauri desktop shell only:

```bash
pnpm dev:tauri
```

Build the Go sidecar binary for the current platform:

```bash
pnpm build:sidecar
```

Legacy aliases are still available:

```bash
pnpm dev:web
pnpm dev:runtime
pnpm dev:desktop
```

`pnpm dev:tauri` expects the frontend and backend ports to be available. For
normal development, prefer `pnpm dev`.

## Build

```bash
pnpm build
```

## Development Workflow

See [docs/development-workflow.md](docs/development-workflow.md) for the
recommended branch naming, commit style, merge flow, and GitHub collaboration
workflow.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup expectations, branch
conventions, and pull request guidance.

## License

Apix is licensed under the GNU Affero General Public License v3.0 only.
See [LICENSE](LICENSE).

## Ports

- React/Vite frontend: `http://127.0.0.1:1420`
- Go runtime HTTP API: `http://127.0.0.1:4317`
- Runtime health endpoint: `GET http://127.0.0.1:4317/health`
- Runtime log stream: `GET ws://127.0.0.1:4317/ws/logs`

## Runtime Contract

The Go service owns local SQLite access and exposes local APIs for the desktop app.

- HTTP base URL: `http://127.0.0.1:4317`
- Health endpoint: `GET /health`
- Log stream: `GET /ws/logs` WebSocket
- Default SQLite file: `runtime/apix.db` when launched from the runtime directory, or `apix.db` relative to the caller

## Notes

- Tauri is configured to package the Go service as a sidecar via `src-tauri/binaries/apix-runtime-*`.
- Feature modules can be added under `apps/desktop/src`.
- Monaco Editor and React Flow can be introduced later without changing the module boundaries.
