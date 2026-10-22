# Tauri 2 + Go sidecar

Tauri manages the native window, single instance and backend lifetime on macOS,
Windows and Linux. Go continues to embed the existing workspace and serve REST,
MCP and logs. No frontend framework or JavaScript bridge migration is required.
The loopback workspace receives no Tauri IPC capabilities; native process access
stays in Rust.

## Development and build

Install Node.js 22.20+, pnpm 9.15+, Go 1.23+, Rust 1.90+ and the
[platform prerequisites](https://v2.tauri.app/start/prerequisites/): Xcode command
line tools on macOS; Microsoft C++ Build Tools / Windows SDK and Rust MSVC on
Windows; WebKitGTK 4.1 and the documented native libraries on Linux.

```bash
pnpm install --frozen-lockfile
pnpm dev:desktop
pnpm build:desktop
```

Both Tauri hooks rebuild Go from source before compiling the shell. The binary is
named `src-tauri/binaries/apix-runtime-<Rust target triple>[.exe]` and bundled using
[Tauri externalBin](https://v2.tauri.app/develop/sidecar/). Missing toolchains or a
failed Go build abort packaging; an old sidecar is never a fallback. Generated
binaries, WSL resources and Cargo target files are ignored; Cargo.lock and the
pnpm lockfile are tracked.

Native output goes to `src-tauri/target/release/bundle/`: macOS `.app` / `.dmg`,
Windows NSIS `*-setup.exe`, Linux `.deb` / `.rpm` / `.AppImage`. With an explicit
`--target`, Cargo inserts that target directory before `release`. Build on the
target OS; cross compiling the standalone Go runtime remains independent.
Windows NSIS installs per user and bootstraps WebView2 when needed. Windows WSL
helpers for Linux amd64 and arm64 are included as resources and resolved through
`APIX_EXECUTOR_DIR`; standalone runtime sibling lookup remains supported.

Supported sidecar targets are macOS arm64/x64, Windows MSVC arm64/x64, and Linux
GNU arm64/x64. This does not by itself prove the installers on all architectures.
Universal macOS, musl, mobile and cross-OS desktop builds are not configured.
Signing, notarization and automatic updates require a separate release setup.

## Startup, data and shutdown

The shell starts only its own sidecar. It waits up to 30 seconds for one JSON
readiness line on stdout before loading its URL; regular Go logs stay on stderr
and are appended to `startup.log`. Startup failures or unexpected backend exits
show a native error dialog with diagnostics. Reopening focuses and restores the
existing window rather than creating another backend.

Desktop defaults to `127.0.0.1:4319` so saved MCP configurations survive restarts.
The browser development entry stays on port 4317. `APIX_ADDR` can override the
desktop port on `127.0.0.1`; `127.0.0.1:0` requests an ephemeral port for tests. Occupied ports
fail explicitly; the shell never reuses or stops another listener. When using an
ephemeral port, reinstall AI client configuration after every restart.

Data defaults preserve existing paths and the adjacent credentials key:

| Platform | Database |
| --- | --- |
| macOS | `~/Library/Application Support/dev.apix.desktop/apix.db` |
| Linux | `$XDG_DATA_HOME/dev.apix.desktop/apix.db`, default `~/.local/share/` |
| Windows desktop | `%LOCALAPPDATA%\Apix\data\apix.db` |

`APIX_DB_PATH` overrides the path. Logs live alongside the database. Do not run
desktop and browser runtimes against the same database at the same time; use a
separate `APIX_DB_PATH` for parallel development. Existing files are used in place;
there is no copying, credentials regeneration or database included in a bundle.

Closing the window or quitting writes `shutdown` to stdin, waits for the existing
Go HTTP / flow / managed-service cleanup, and then exits. The shell allows 35
seconds before forcing termination of its own sidecar. Parent process death
closes stdin; Go treats EOF as the same shutdown request on all three platforms.
This replaces the old Windows launcher's detached backend behavior. For a runtime
that must survive closing the UI, use `pnpm build:runtime` and run it separately.

Before migrating from the old Windows ZIP installation, close its window and
stop its detached backend. Replace old shortcuts with the NSIS-installed app.
The old manual installation is not automatically removed by NSIS.

## Verification

```bash
pnpm check
pnpm test:web
pnpm test:runtime
pnpm build:sidecar
pnpm test:sidecar
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
pnpm build:desktop
```

The sidecar smoke test uses temporary databases and ephemeral loopback ports. It
checks readiness, the embedded page, MCP handshake, explicit shutdown, stdin EOF,
closed log pipes after parent death and occupied-port rejection. It never starts configured user services. The native
CI matrix builds macOS, Windows and Linux installers as artifacts without
publishing a release. Window rendering, duplicate launch, quit and installation
still require verification on each real target platform.
