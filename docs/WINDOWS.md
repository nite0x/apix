# Windows 桌面安装

将 Windows 成品 ZIP 解压，右键运行 `Install.ps1`，或在当前目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

程序安装到当前用户的 `%LOCALAPPDATA%\Programs\Apix`，并创建桌面快捷方式 **Apix**，无需管理员权限。

双击快捷方式即可启动后台程序并打开浏览器工作台：`http://127.0.0.1:4319/`。再次双击会复用同一个后台进程，不会重复启动。关闭浏览器后后台程序继续运行，可在任务管理器中结束 `apix-runtime.exe`。

桌面版使用独立数据目录 `%LOCALAPPDATA%\Apix\data`，不会导入、覆盖 WSL 数据或旧桌面版数据。开发工作台继续使用端口 4317。Windows 数据库密码由当前 Windows 用户的 DPAPI 保护。

旧桌面上的 Apix portable 目录和 setup 安装包会整体移入 `%LOCALAPPDATA%\Apix\backups`，保留原文件及可能存在的数据。

启动失败时查看 `%LOCALAPPDATA%\Apix\data\startup.log` 和 `runtime.log`。安装包只包含程序和说明，不含数据库、密码或个人配置。

## 源码打包

在 Ubuntu WSL 项目根目录运行 `pnpm build:windows`。Linux Go 交叉编译运行时和无控制台启动程序，Python 3 标准库生成 `release/Apix_<版本>_windows-x64.zip` 及其 SHA-256 校验文件。安装和启动程序都不使用 Tauri。


## Windows 和 WSL 统一管理

只需安装 Windows 版 Apix。在“服务 → 新增服务”选择“Windows 本机”或“WSL · 发行版”，填写对应系统内的绝对工作目录、启动程序和独立参数。WSL 用户留空时使用发行版默认用户，保存后固定为实际用户；也可显式指定该发行版中的其他用户。

点击“检查运行环境”可以检查目录及启动程序的实际位置。WSL 启动会读取用户的 Bash 登录环境；若 Node、pnpm 等仅在交互式 shell 中配置，请在服务的“环境变量”JSON 中设置正确的 Linux PATH，或填写可执行文件的绝对路径。不会自动把 Windows PATH 当作 Linux 工具链使用。Windows 的批处理脚本仍需显式使用 cmd.exe 或 PowerShell 作为启动程序。

首次检查或保存 WSL 配置时，Apix 将随安装包提供的 Linux 助手准备到该用户的 ~/.cache/apix/executors/<内容哈希>/，无需在 WSL 安装另一套 Apix、Node 或 Go。助手不开放端口、不保存另一份业务数据库，按需随执行启动。WSL 本身及所选发行版需要预先安装；当前助手支持 Linux x86_64 和 aarch64。

服务必须以前台方式运行。健康检查和已有实例复用在服务所在环境执行；正常停止、启动失败和控制连接关闭会清理本次执行的进程组。外部服务仍只复用、不接管或停止。助手意外失联时显示清理失败，不会根据可能重用的 PID 盲目终止进程。服务详情中的 PID 是运行环境内的 PID。

服务列表轮询只枚举发行版状态，不会唤醒已停止的发行版；显式检查、保存和启动 WSL 服务可能启动该发行版。WSL 暂不可用时保留配置和历史日志。

“命令行”测试也可选择运行环境，输入、参数、超时、输出限制和历史快照保持一致。服务在 WSL 内健康，并不保证 Windows 主程序能访问它；HTTP 接口测试和数据库连接仍从 Windows 发起，请另行确认网络可达性。

## WSL 中的 AI 工具

在“AI 工具”选择“WSL · 发行版”，然后为 Codex、Claude Code、Cursor 或 VS Code / Copilot 安装配置。配置操作在目标 Linux 用户下执行，保留原有其他 MCP 配置，修改前保存备份，遇到不同的 apix 配置或并发修改时停止覆盖。

WSL 客户端使用 stdio 调用同一安装目录中的 apix-runtime.exe mcp-stdio，再连接 Windows 的本机 HTTP MCP。此入口仅转发工具，不启动第二套数据库或工作台；无需修改 NAT / mirrored 网络设置或开放局域网端口。需要启用 WSL 的 Windows 程序互操作功能，且安装目录必须可从 WSL 访问。AI 工具的命令执行限制也需要允许该桥接程序运行。

“测试连接”会从所选 Linux 环境实际调用 Windows 桥接程序，验证 MCP 握手和工具列表。主程序未运行、互操作被禁用或安装目录已移动时会报告失败；不会误报为已连接。Windows 正式版 MCP 地址通常为 http://127.0.0.1:4319/mcp，开发版为 4317，实际配置使用正在运行的主程序地址。

TRAE 的 WSL 桥接不提供一键导入，请使用支持 stdio 的客户端，或切换到 Windows 环境配置 Windows TRAE。

## 开发验收

所有构建、检查和交叉编译在 Ubuntu WSL 中完成：

```bash
pnpm check
pnpm test:web
cd runtime
go test ./...
go test -race ./internal/executionenv ./internal/commandrunner ./internal/localservice ./internal/aiinstall ./internal/mcpbridge
cd ..
pnpm build:windows
```

可选的真实 Windows / WSL 验收使用临时数据库和自建测试服务，不复用、修改或启动用户已有的业务服务。在 WSL 中执行 pnpm build:windows 后，运行 pnpm test:windows-wsl -- Ubuntu。脚本使用 Linux Go 交叉编译测试程序，将测试目标复制到 Windows 本地临时目录，通过 WSL 互操作执行，并在结束后仅清理本次创建的临时目录。

该验收覆盖 Windows / WSL 服务启停、WSL 子进程清理、Windows 主进程异常退出及 WSL stdio MCP 连接同一运行时。Windows 本机回环检测单独运行；失败时不能把完整 MCP 验收标记为通过。部分 Windows 配置下，从 WSL 的 UNC 共享目录直接运行程序会导致本机 HTTP 访问异常，因此测试目标按真实安装方式放在 Windows 本地磁盘。未提供发行版参数时使用当前 WSL_DISTRO_NAME。
