# Apix 项目说明

## 执行环境：仅使用 Ubuntu WSL

- 本项目的开发、依赖安装、运行、构建、测试、类型检查、格式化和 Git 命令都必须在 Ubuntu WSL 中执行，使用 Linux 版工具链。
- 当前有效工作目录是 `/home/nite/projects/apix`，Windows 访问路径是 `\\wsl$\Ubuntu\home\nite\projects\apix`。
- `D:\project\apix` 是迁移前保留的副本，不要在那里运行命令、修改源码或安装依赖，除非用户明确要求处理该副本。
- 不要直接调用 Windows 的 `node.exe`、`npm.cmd`、`pnpm.cmd`、`go.exe`、`cargo.exe`、`git.exe` 或 PowerShell 启动脚本来开发、构建或测试 Apix；也不要复用 Windows 的依赖和构建产物。
- Codex 可以保持 Windows native 模式。此时 Windows shell 只作为调用 `wsl.exe` 的入口，项目命令必须转入 Ubuntu 执行。不要为了本项目修改 Codex 的全局 Agent environment，以免影响其他 Windows 项目。
- Windows 浏览器可以访问 WSL 中的本地页面，用于预览和界面验证；浏览器所在系统不改变 Apix 必须在 WSL 运行的要求。
- 如果 WSL 或 Linux 工具链不可用，应说明具体问题并在 WSL 中修复，不得静默改用 Windows 工具链。

## 如何执行命令

如果 Codex 的 shell 在 Windows，使用以下形式。外层引号使用 PowerShell 单引号，避免 Linux 命令里的 `$` 等内容被 PowerShell 提前展开。

```powershell
wsl -d Ubuntu --exec bash -lc 'cd /home/nite/projects/apix && pnpm dev:browser'
wsl -d Ubuntu --exec bash -lc 'cd /home/nite/projects/apix && pnpm check'
wsl -d Ubuntu --exec bash -lc 'cd /home/nite/projects/apix/runtime && go test ./...'
```

如果 Codex 已在 Ubuntu WSL，直接在项目目录执行 Linux 命令，无需再次嵌套调用 `wsl`。

首次开始工作时，确认 `pwd` 指向有效工作目录、`uname -s` 输出 `Linux`、`node -p process.platform` 输出 `linux`。检查 `command -v node pnpm go git`，实际使用的项目工具不能来自 `/mnt/c`、`/mnt/d` 等 Windows 挂载目录。

## 项目结构和常用命令

- `runtime/internal/activity/web`：唯一 Web 工作台 UI，随 Go 构建内嵌。
- `runtime`：Go 后端，管理本地数据并提供 REST、MCP 和日志服务。
- `scripts`：开发启动、检查和独立程序打包脚本；Windows 桌面入口使用 Go + Microsoft Edge WebView2；不使用 Rust 工具链。

以下命令均在 WSL 项目根目录执行，除非另有注明：

```bash
pnpm install --frozen-lockfile
pnpm dev:browser                   # 启动 Go 后端并打开内嵌工作台
pnpm check
pnpm test:web                     # 工作台界面测试
pnpm build:runtime
pnpm build:windows                 # WSL 中交叉编译 Windows 独立程序
cd runtime && go test ./...         # Go 测试
```

根据本次修改选择必要检查；单纯修改文档时无需重新构建或运行整套测试。

## 运行和验证

- Apix 工作台及后端：`http://127.0.0.1:4317/`；健康检查为 `/health`。
- 启动前检查端口和已有进程，复用属于本项目的健康服务，避免重复启动或停止无关服务。
- 本机默认开发数据库为 `~/.local/share/dev.apix.desktop/apix.db`，配套密钥为同目录下的 `apix.db.credentials.key`。验证时保留现有数据，不要误用 Windows 副本里的数据库或覆盖密钥。
- 本项目中的外部业务服务配置可能指向 Windows Java 或 PowerShell 程序；这不代表它们已经迁到 Linux。没有用户明确要求时，不要启动这些外部服务来代替 Apix 自身的验证。
- 默认使用 `pnpm dev:browser`，只访问 `http://127.0.0.1:4317/`。Web 资源内嵌在 Go 程序中，修改后需重启后端。Windows 打包也必须使用 WSL 中的 Linux Go 交叉编译。
- 流程编排、会话人工处理及暂停规则的产品设计暂缓；保留现有执行行为，不因 UI 清理扩展或重写这些能力。
- 保留已有未提交修改，不擅自提交、推送或重置工作区。
