# Windows 桌面安装（Tauri 2 + Go sidecar）

运行 Tauri 生成的 `Apix_*_setup.exe`（NSIS，当前用户安装，无需管理员权限）。安装程序包含 Tauri 桌面壳、Go 后端及 Linux x86_64 / aarch64 WSL 执行助手，并处理 Microsoft Edge WebView2 Evergreen Runtime 的安装。离线环境请先安装 [Microsoft WebView2 Evergreen Standalone Installer](https://developer.microsoft.com/microsoft-edge/webview2/)。

再次打开会唤起已有窗口。本地 MCP 统一使用 stdio，通过命令启动连接，无需 IP 或端口。**关闭窗口或退出应用会停止本次桌面启动的后端及其托管资源**；需要持续运行 MCP 时，使用独立的 `apix-runtime.exe`。不再提供旧版 `Apix.exe --background` 或 ZIP / Install.ps1 安装方式。

旧版数据目录 `%LOCALAPPDATA%\Apix\data` 原地保留，数据库及相邻凭据密钥继续使用；不会复制或覆盖 WSL 数据。升级前请退出旧 Apix 并结束旧版遗留的 `apix-runtime.exe`，否则端口占用会明确报错，不会接管旧进程。旧版手动安装的快捷方式请移除或改为新程序；NSIS 不负责卸载旧版 ZIP 安装。

启动失败查看上述目录的 `startup.log` 和 `runtime.log`。安装包不含用户数据库或个人配置。完整构建、平台要求及生命周期说明见 [桌面构建说明](DESKTOP.md)。

在 Windows 项目目录使用 Node.js 22.20+、pnpm 9.15+、Go 1.23+、Rust 1.90+ MSVC、Microsoft C++ Build Tools 和 Windows SDK：

```powershell
pnpm install --frozen-lockfile
pnpm dev:desktop
pnpm build:windows
```

成品位于 `src-tauri/target/release/bundle/nsis/`。不再使用 Linux Go 交叉编译整个 Windows 桌面壳；独立 Go 后端仍可使用 `GOOS=windows` 交叉编译。

## Windows 和 WSL 统一管理

只需安装 Windows 版 Apix。在“服务 → 新增服务”选择“Windows 本机”或“WSL · 发行版”，填写对应系统内的绝对工作目录、启动程序和独立参数。WSL 用户留空时使用发行版默认用户，保存后固定为实际用户；也可显式指定该发行版中的其他用户。

点击“检查运行环境”可以检查目录及启动程序的实际位置。WSL 启动会读取用户的 Bash 登录环境；若 Node、pnpm 等仅在交互式 shell 中配置，请在服务的“环境变量”JSON 中设置正确的 Linux PATH，或填写可执行文件的绝对路径。不会自动把 Windows PATH 当作 Linux 工具链使用。Windows 的批处理脚本仍需显式使用 cmd.exe 或 PowerShell 作为启动程序。

首次检查或保存 WSL 配置时，Apix 将随安装包提供的 Linux 助手准备到该用户的 ~/.cache/apix/executors/<内容哈希>/，无需在 WSL 安装另一套 Apix、Node 或 Go。助手不开放端口、不保存另一份业务数据库，按需随执行启动。WSL 本身及所选发行版需要预先安装；当前助手支持 Linux x86_64 和 aarch64。

服务必须以前台方式运行。健康检查和已有实例复用在服务所在环境执行；正常停止、启动失败和控制连接关闭会清理本次执行的进程组。外部服务仍只复用、不接管或停止。助手意外失联时显示清理失败，不会根据可能重用的 PID 盲目终止进程。服务详情中的 PID 是运行环境内的 PID。

服务列表轮询只枚举发行版状态，不会唤醒已停止的发行版；显式检查、保存和启动 WSL 服务可能启动该发行版。WSL 暂不可用时保留配置和历史日志。

“命令行”测试也可选择运行环境，输入、参数、超时、输出限制和历史快照保持一致。服务在 WSL 内健康，并不保证 Windows 主程序能访问它；HTTP 接口测试和数据库连接仍从 Windows 发起，请另行确认网络可达性。

## WSL 中的 AI 工具

在“AI 工具”选择“WSL · 发行版”，然后为 Codex、Claude Code、Cursor 或 VS Code / Copilot 安装配置。配置操作在目标 Linux 用户下执行，保留原有其他 MCP 配置，修改前保存备份，遇到不同的 apix 配置或并发修改时停止覆盖。

Windows 本机及 WSL 客户端都使用 stdio 调用同一安装目录中的 `apix-runtime.exe mcp-stdio --socket <命名管道>`，通过仅当前用户可访问的 Windows 命名管道连接后端，不经过 TCP。此入口仅转发工具，不启动第二套数据库或工作台；无需修改 NAT / mirrored 网络设置或开放端口。WSL 需要启用 Windows 程序互操作，且安装目录必须可从 WSL 访问。AI 工具的命令执行限制也需要允许该桥接程序运行。

桥接建立连接后，会保持 AI 客户端的 stdio 会话，并每 2 秒检查后端 MCP 会话。Apix 重启或会话失效时自动重新握手、刷新工具列表；重连失败按 250 毫秒到 5 秒退避，直到后端恢复或客户端关闭。无需重新打开 AI 会话。首次启动桥接时仍要求 Apix 已运行。

每次工具调用先进行无副作用的连接检查，遇到断线最多等待 10 秒恢复；工具本身仍遵循调用方的执行时限。后端长期未恢复时，本次调用返回不可用，后台继续重连。已经发出的工具调用若丢失响应，会报告结果未知，不会自动重放，以免重复执行请求、SQL 或命令。请先检查执行记录再决定是否重试。

“测试连接”会从所选环境实际启动 stdio 命令，验证 MCP 握手和工具列表。主程序未运行、互操作被禁用或安装目录已移动时会报告失败。工作台端口变化不影响 MCP 配置；数据库路径或可执行文件位置变化后需更新配置。旧版标准 HTTP 配置可在备份后升级为 stdio；含自定义字段或停用标记的配置请手动审阅。

TRAE 的 WSL 桥接不提供一键导入，请使用支持 stdio 的客户端，或切换到 Windows 环境配置 Windows TRAE。

## 开发验收

```bash
pnpm check
pnpm test:web
pnpm test:runtime
pnpm build:sidecar
pnpm test:sidecar
pnpm build:windows
```

`test:sidecar` 使用临时数据库和随机回环端口，检查握手、工作台、MCP、正常退出、控制管道 EOF 和端口冲突，不启动用户已有业务服务。桌面窗口、重复打开、Windows 安装/卸载及 WSL 互操作仍需在真实 Windows 上验收。

可选 Windows / WSL 后端验收继续使用 `pnpm test:windows-wsl -- Ubuntu`，在 WSL 中交叉编译测试程序并通过互操作运行，不依赖桌面壳。先用 `GOOS=windows GOARCH=amd64 APIX_OUTPUT_DIR=release/windows-x64 pnpm build:runtime` 准备后端，再用 `node scripts/build-sidecar.mjs x86_64-pc-windows-msvc` 构建助手，并把 `src-tauri/resources/executors` 复制到 `release/windows-x64/executors`。测试只清理本次创建的临时目录。
