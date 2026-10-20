# Apix User Guide

Apix runs as one local Web workspace at `http://127.0.0.1:4317/`. The same Go process provides the UI, REST API, and MCP endpoint.

## Startup

From the project root in Ubuntu WSL:

```bash
pnpm dev
```

Use `pnpm dev:backend` to start only the runtime. Restart after changing embedded Web assets. A standalone release can run without Node.js or a separate frontend build.

Development keeps the existing database and credentials key in `~/.local/share/dev.apix.desktop/`. For standalone configuration and alternate data directories, see [the runtime guide](../runtime/GUIDE.md).

## Requests and the interface library

Open **接口** (`/requests`).

- Enter the method, URL, query parameters, headers, and request body to send a temporary request.
- Expand **导入 cURL / 原始 HTTP**, paste the request, and choose **解析到编辑器**. Importing creates a reviewable draft; it does not send the request or save an interface.
- Create a collection in **接口库**, then enter an interface name, select its collection, and choose **保存接口**.
- Search the library by name, method, URL, or collection. Choose **编辑 / 调试** to load a saved interface. Sending a request and saving its definition are separate actions.
- Edits preserve disabled parameters, duplicate query parameters, and existing authentication configuration. Saved credentials are not reconstructed from redacted history.
- If another editor changes an interface, the draft stays in the editor. Reload the saved interface or choose **另存为新接口**, then save under a new name.
- Archive interfaces or collections to hide them from the library. Execution history is separate and remains available.

The request history shows the most recent 200 runs. Search by method or URL, filter by execution state, pin useful records, or delete an execution record. **填入编辑器** copies a historical request for another manual attempt or for saving as an interface. Replace redacted authentication values before executing or saving.

## Other workspace pages

- **数据库**: manage MySQL, PostgreSQL, and Hologres connections; execute SQL and inspect saved results.
- **服务**: configure and manually start or stop local services; inspect service details and logs.
- **MCP 工具**: connect Streamable HTTP servers, discover and call tools, and save reusable tests. See [MCP testing](MCP_TESTING.md).
- **命令行**: run one-shot programs or scripts, validate exit codes and output, and save cases. See [command testing](COMMAND_TESTING.md).
- **测试**: manage **测试用例** (single-step and multi-step), organize **测试批次**, and inspect **执行记录**. See [API testing](API_TESTING.md).
- **日志**: inspect runtime events and service output.

Flow supports ordered execution cards and explicit cleanup. Ordinary MCP session UI and pause-rule management UI remain deferred.

## Card-based Flow tests

Open **测试 → 测试用例**, then set **用例类型** to **业务流程** in the Runtime Web workspace (`http://127.0.0.1:4317/tests?tab=cases&type=flow`). Legacy `/flows?id=…&run=…` links still open the corresponding editor or result.
Create a Flow, then arrange HTTP, SQL, or service cards in execution order. Expand a card to edit
its request, name, assertions, response extractors, and failure policy. Flow
changes save automatically; running first flushes the saved definition and
records its version.

- Define shared variables in the right-hand Flow panel. Names use letters,
  digits, and underscores, starting with a letter or underscore. Reference them
  in requests using `{{token}}` or `{{order_id}}`.
- Variable precedence is environment, Flow default, run input, then response
  extraction. Every run starts independently. Blank run inputs inherit defaults
  or environment values. Required Flow variables must be available before a run;
  values produced by earlier cards should instead use a required extractor.
- Sensitive Flow variables have no saved default; provide their values under
  the input dialog shown before starting a run. Run input and extraction records
  mask values marked sensitive.
- Extract values from a response body, header, or status into run variables.
  Body paths use dot notation (`data.id`, `items.0.id`), not JSONPath. An empty
  body path selects the entire body. Required missing extractions fail the step.
- Assert an expected HTTP status or add response assertions using **等于**,
  **不等于**, **包含**, or **存在**. Comparisons use text; missing values fail
  every operator. All assertions must pass. Available outputs are retained even when an assertion or another required extraction fails, so cleanup can use created resource IDs.
- Add cleanup cards in **收尾步骤**, or move an existing card there. They run
  after the body on success, failure, or cancellation, in the displayed order.
  Cleanup uses an independent 30-second total budget and attempts every cleanup
  card even if another fails. Existing service ownership cleanup runs afterward.
  Runtime crashes are marked interrupted; cleanup is not guaranteed after a crash.
- Extract SQL query fields with source `rows` and paths such as `0.id` or
  `0.name`; `row_count` checks the exact result count and cannot pass on a
  truncated result. SQL exec steps support `rows_affected`. Checks use the same
  text operators as HTTP. SQL NULL is an existing field with an empty text value;
  a missing field fails all operators.
- Reference a named output with `{{steps.STEP_ID.outputs.NAME}}`. In an expanded
  card, place the cursor in a URL, body, parameter, or expected value, then use
  **插入步骤输出**. References bind to stable IDs and survive renaming; whole-flow
  copies remap them. Deleting/disabling the producer, removing an output, or
  moving it behind its consumer prevents saving until references are corrected.
  SQL parameters preserve the output's type when the entire parameter is a
  reference; SQL statements retain native bound placeholders.
- Qualified references never fall back to shared variables. Missing outputs
  fail before an operation executes. Cleanup cards can explicitly opt into
  **引用的步骤输出不存在时跳过**; the skip reason remains in run history.
- Step failure policy offers **遵循流程设置**, **停止后续步骤**, and
  **继续后续步骤**. A failed card still makes the run fail, and the first body
  failure is retained separately from cleanup failures. A successful body with
  failed cleanup is marked failed. Existing `continue_on_error` and
  `stop_on_error` settings retain their previous behavior when
  `failure_policy` is omitted; `{{name}}` references also remain supported.
  Without assertions, completion means operations executed, not verified success.
- **运行流程** opens run cards with request/response details, timing, assertion
  results, and extracted variables. **运行记录** in the right panel reopens
  historical Flow runs. Editing a Flow never changes an existing run snapshot.
  Execution details follow the step type: HTTP shows requests and responses;
  SQL shows the statement, bound parameters, returned rows or affected row count;
  service steps show the operation, saved status, PID, ownership, and whether a
  service was started or reused. SQL parameters are saved after substitution
  with sensitive values masked; older records may still contain placeholders.
  Service results describe the operation at execution time, before later cleanup.

The Web page uses the Runtime that serves it; no separate frontend dev server
is needed. Rebuild and restart the Runtime after changing embedded Web assets.


## 一键接入 AI 工具

在工作台侧边栏打开 **AI 工具**，选择配置安装环境，然后点击目标工具的 **一键安装**。

- **Codex**：写入用户的 `~/.codex/config.toml`，支持运行环境的 `CODEX_HOME`。
- **Claude Code**：写入用户的 `~/.claude.json`，支持运行环境的 `CLAUDE_CONFIG_DIR`。此入口用于 Claude Code，Claude 桌面聊天的连接器需另行配置。
- **Cursor**：写入用户的 `~/.cursor/mcp.json`。
- **VS Code / Copilot**：写入默认用户配置目录的 `Code/User/mcp.json`。使用自定义 Profile 或含注释的 JSON 配置时，可展开卡片复制配置手动合并。
- **TRAE**：点击国际版或国内版安装链接，在浏览器中允许打开 TRAE，再在应用的导入窗口确认。链接始终打开浏览器所在系统的应用，不受页面的安装环境选择影响。

Apix 在 WSL 运行时会尝试识别 Windows 用户目录，提供独立的 **Windows** 安装环境；Linux 与 Windows 配置不会混用。无法识别时可以复制配置，在目标工具中手动添加。安装位置会显示在各工具卡片中。

安装仅添加名为 `apix` 的 MCP 服务，保留已有设置和其他 MCP 服务。修改已有文件前，会在相同目录创建 `*.apix-backup-*` 备份；重复安装相同配置不会再次写入。遇到同名不同配置、停用配置、无效配置或符号链接时会停止安装，原文件保持不变，请先检查或手动合并。

安装后保持 Apix 运行，在 AI 工具中重新加载 MCP 或开启新会话，并确认启用 `apix`。安装后会自动验证 MCP 握手和工具列表，卡片显示连接成功或失败、可用工具数量、最近验证时间和耗时。已配置的工具在打开页面时也会自动验证；测试结果在本次 Apix 运行期间保留 5 分钟，可随时点击 **重新测试**。选择 Windows 安装环境时，验证请求实际从 Windows 发起；其他环境使用 Apix 所在系统发起请求。连接测试不会执行任何业务工具。

“已配置”仅表示配置文件已就绪，“连接成功”表示所选环境能够访问 Apix 的 MCP 服务；应用内的启用、信任和会话加载状态请在目标工具中确认。安装成功但连接失败时配置仍会保留，修复网络或启动 Apix 后可单独重试连接，无需重新安装。TRAE 导入需要在应用内确认，返回页面后自动验证所选环境的 MCP 服务，不能据此判断 TRAE 是否已完成导入。地址来自当前 Apix 监听地址；更改端口后需要同步更新工具里的配置。

配置格式参考：[Codex MCP](https://developers.openai.com/codex/mcp/)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)、[Cursor MCP](https://cursor.com/docs/mcp)、[TRAE 安装链接](https://docs.trae.cn/ide_mcp-server-install-links)、[VS Code MCP](https://code.visualstudio.com/docs/agent-customization/mcp-servers)。
