# Apix Tauri

Tauri desktop shell for `apps/desktop`.

## Development

The normal development command is run from the repository root:

```bash
pnpm dev
```

It starts the React/Vite dev server, Go runtime, and Tauri together.

To run only the Tauri desktop shell after the frontend and backend are already
available:

```bash
pnpm dev:tauri
```

Equivalent manual flow from the repository root:

```bash
pnpm build:sidecar
pnpm --dir src-tauri tauri dev
```

For three separate terminals:

```bash
pnpm dev:frontend
pnpm dev:backend
pnpm dev:tauri
```

In dev mode, Tauri loads the frontend from:

```text
http://127.0.0.1:1420
```

The Rust app checks `http://127.0.0.1:4317/health` on startup. If the runtime is already running, Tauri reuses it. Otherwise it starts the bundled `apix-runtime` sidecar and stops that child process when the app exits.

## Build

```bash
pnpm build
```

The Tauri build runs:

```bash
pnpm --dir ../apps/desktop build
```

and packages the generated static files from:

```text
apps/desktop/dist
```

## Rust Commands

- `open_file_dialog`: opens a native file picker and returns the selected path, or `null` when canceled.
