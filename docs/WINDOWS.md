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
