# Apix 项目说明

## 执行环境

- 可以在当前 macOS、Linux、Windows 或 Ubuntu WSL 环境中执行开发、依赖安装、运行、构建、测试、类型检查、格式化和 Git 命令，无需为了切换系统另行确认。
- 以当前会话实际打开的项目工作区为准，不强制使用固定路径或 WSL 副本。
- `D:\project\apix` 是迁移前保留的副本，不要在那里运行命令、修改源码或安装依赖，除非用户明确要求处理该副本。
- 使用与实际执行环境兼容的工具链，不跨系统复用依赖和构建产物；在 WSL 中执行时使用 Linux 工具链。
- 不要为了本项目修改 Codex 的全局 Agent environment，以免影响其他项目。
- 如果所需工具链不可用，应说明具体问题；涉及特定平台的功能和打包，以项目脚本及目标平台要求为准。

## 如何执行命令

默认在当前系统的 shell 中直接执行项目命令。选择 Ubuntu WSL 时，可从 Windows 使用 `wsl -d Ubuntu --exec bash -lc '项目命令'` 进入 Linux 环境，并先切换到对应项目目录。

首次开始工作时，确认实际工作目录、操作系统和工具链路径。macOS/Linux 可使用 `pwd`、`uname -s`、`node -p process.platform` 和 `command -v node pnpm go git`；Windows PowerShell 可使用 `Get-Location`、`node -p process.platform` 和 `Get-Command node,pnpm,go,git`。检查结果应与所选执行环境一致。

## 项目结构和常用命令

- `runtime/internal/activity/web`：唯一 Web 工作台 UI，随 Go 构建内嵌。
- `runtime`：Go 后端，管理本地数据并提供 REST、MCP 和日志服务。
- `src-tauri`：Tauri 2 桌面窗口、单实例和 Go sidecar 生命周期管理；桌面构建需要 Rust 1.90+ 及目标平台依赖。
- `scripts`：开发启动、检查、Go sidecar 和独立后端打包脚本。

以下命令均在当前项目根目录执行，除非另有注明：

```bash
pnpm install --frozen-lockfile
pnpm dev:browser                   # 启动 Go 后端并打开内嵌工作台
pnpm dev:desktop                   # 构建 Go sidecar 并启动 Tauri 桌面窗口
pnpm check
pnpm test:web                     # 工作台界面测试
pnpm build:runtime
pnpm build:desktop                 # 在当前平台构建 Tauri 安装包
pnpm build:windows                 # 在 Windows 使用 Rust MSVC 构建 NSIS 安装包
pnpm test:sidecar                  # 先构建 sidecar，再验证握手、MCP 和退出清理
cd runtime && go test ./...         # Go 测试
```

根据本次修改选择必要检查；单纯修改文档时无需重新构建或运行整套测试。

## 运行和验证

- Apix 工作台及后端：`http://127.0.0.1:4317/`；健康检查为 `/health`。
- 启动前检查端口和已有进程，复用属于本项目的健康服务，避免重复启动或停止无关服务。
- 默认开发数据库按平台保留：macOS 为 `~/Library/Application Support/dev.apix.desktop/apix.db`，Linux 为 `~/.local/share/dev.apix.desktop/apix.db`，配套密钥为同目录下的 `apix.db.credentials.key`。验证时保留现有数据，不要误用 Windows 副本里的数据库或覆盖密钥。
- 本项目中的外部业务服务配置可能指向 Windows Java 或 PowerShell 程序；这不代表它们已经迁到 Linux。没有用户明确要求时，不要启动这些外部服务来代替 Apix 自身的验证。
- 默认使用 `pnpm dev:browser`，只访问 `http://127.0.0.1:4317/`。Web 资源内嵌在 Go 程序中，修改后需重启后端。桌面版默认使用回环端口 4319，由 Tauri 启动并在退出时清理 sidecar；APIX_ADDR=127.0.0.1:0 可用于隔离验证。Windows 安装包在 Windows 使用 Rust MSVC 构建，具体见 docs/DESKTOP.md。
- 流程编排、会话人工处理及暂停规则的产品设计暂缓；保留现有执行行为，不因 UI 清理扩展或重写这些能力。
- 保留已有未提交修改，不擅自提交、推送或重置工作区。
