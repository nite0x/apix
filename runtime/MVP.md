# Apix 服务端测试 MVP

这一版可以独立运行，供 AI 通过 MCP 调用，也可以直接调用 REST API。完成的主要能力是：发送 HTTP 请求、执行 MySQL / PostgreSQL / Hologres SQL、启停本地服务，以及把这些操作保存为顺序执行的测试流程。运行记录、检查结果和日志会保存下来，不需要打开页面。

Runtime 已嵌入工作台页面。启动后打开 `http://127.0.0.1:4317/` 进入主页，通过左侧导航切换：主页 `/` 显示运行概况，服务 `/services` 查看状态和启停服务，接口 `/requests` 查看最近 50 条执行记录，数据库 `/databases` 管理 MySQL 连接，接口测试 `/tests` 按批次查看不同入参的验证结果并管理可复用用例，测试流程 `/flows` 编排有步骤依赖的业务流程，日志 `/logs` 查看运行事件及服务 stdout/stderr。侧边栏支持折叠为图标导航，悬停或键盘聚焦显示名称，当前页面高亮，并在本机浏览器记住折叠状态；窄屏默认折叠。服务、接口和日志每秒自动更新，支持接口搜索、日志来源筛选和暂停显示；服务卡片的“查看日志”可直接跳转并筛选对应服务。各页面地址支持直接打开、刷新和浏览器前进后退。自定义 `APIX_ADDR` 时使用相应地址。

接口测试支持临时用例、保存用例、批量运行、独立重试和断言预期/实际对比。AI 使用 `begin_test_batch` 开始本次任务，后续调用显式携带 `batch_id`，结束时调用 `finish_test_batch`；不需要为独立接口输入变体创建 Flow。完整调用示例见成品包内的 `API_TESTING.md`（源码位置为 `docs/API_TESTING.md`）。

点击接口记录打开右侧详情抽屉，分为“响应”“请求”“执行记录”：查看请求 URL、查询参数、请求头和正文，以及响应状态、响应头、正文、起止时间、耗时和错误。JSON 自动格式化，文本/HTML 按文本展示；执行中的请求会自动更新，关闭可按 Esc。详情复用数据库中的执行快照，旧记录也能查看。

记录范围为应用层快照，不包含抓包、DNS/TCP/TLS 分段耗时或每次重定向。常见凭证字段脱敏；响应正文最多保留前 256 KB，超过会明确标记，未保存的部分无法恢复。新版耗时包含读取正文的时间，旧记录保留当时的值；正文读取失败时仍保留已收到的状态、响应头及部分正文。

服务卡片提供“启动”“停止”和“查看详情”。启动时优先定位并复用已运行的服务，未发现时才使用保存的配置创建进程；状态查询也会通过健康地址发现外部运行的服务。详情展示命令、参数、工作目录、超时、PID、归属、实时健康检查和最近 100 条日志，每 3 秒更新，也可手动刷新。继续使用原来的数据目录才能保留配置和历史。测试流程管理中的服务由对应流程负责停止和清理，外部服务显示“外部运行中”，页面不会接管停止权。

页面随可执行程序分发，不需要启动 Vite 或安装前端依赖。页面、MCP 和 REST 共用执行能力与历史记录。

- **手动 SQL**：在“数据库 → SQL 执行”选择连接、填写 SQL 并执行。MySQL 使用 `?`，PostgreSQL / Hologres 使用 `$1`、`$2` 绑定参数；参数填写为 JSON 数组。查询模式展示结果表格，执行模式用于写入或 DDL，直接提交并展示影响行数。可以配置超时和返回行数，从历史记录“填入编辑器”再次调试。
- **手动服务**：在“服务”点击“新增服务”，填写名称、工作目录、启动程序、参数、健康检查地址和启动超时，选择“仅保存”或“保存并启动”。参数每行一个，程序路径和参数分开填写。启动失败会保留已保存的配置，可在服务列表查看状态、日志和重试启动。

## 启动

Windows 成品无需安装 Go 或启动页面。从项目根目录运行启动脚本，配置和日志默认保存在 `release/data`：

```powershell
.\release\start.ps1
```

如果使用解压后的成品包，直接在解压目录运行 `.\start.ps1`。按 `Ctrl+C` 停止 Runtime。

升级已有版本时，先停止旧 Runtime，再替换程序；继续使用原来的 `APIX_DB_PATH`，即可看到原有接口历史和日志。若此前使用项目内的 `release/start.ps1`，数据默认在 `D:\project\apix\release\data`，新版可明确指定：

```powershell
.\release\request-details\start.ps1 -DataDirectory 'D:\project\apix\release\data'
```

源码启动有两种方式，任选一种：

```powershell
# 在项目根目录，需要已安装 pnpm、Node.js 和 Go
pnpm dev:backend
```

```powershell
# 在 runtime 目录，需要 Go
go run .
```

不要同时启动两个 Runtime 占用同一个端口。

默认地址为 `http://127.0.0.1:4317`，健康检查为 `GET /health`。Runtime 只允许绑定本机回环地址。

运行前可以设置以下环境变量：

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `APIX_ADDR` | Runtime 监听地址 | `127.0.0.1:4317` |
| `APIX_DB_PATH` | Apix 自己的 SQLite 配置和运行记录文件 | 当前工作目录的 `apix.db` |
| `APIX_LOG_PATH` | Runtime JSON 日志文件 | SQLite 文件所在目录的 `runtime.log` |
| `APIX_MYSQL_DSN` | 仅随附 demo-service 自身使用的 MySQL 连接串；Apix 数据库连接通过页面填写 | 运行示例服务时设置 |
| `APIX_DEMO_ADDR` | 随附示例服务监听地址 | `127.0.0.1:18767` |

`APIX_DB_PATH` 是工具自己的存储位置，与被测 MySQL 数据库不同。需要稳定保存历史时，请配置固定的绝对路径。

例如在 PowerShell 中设置后再启动：

```powershell
$env:APIX_DB_PATH = 'D:\apix-data\apix.db'
$env:APIX_LOG_PATH = 'D:\apix-data\runtime.log'
$env:APIX_MYSQL_DSN = 'test_user:YOUR_PASSWORD@tcp(127.0.0.1:3306)/test_db?parseTime=true&charset=utf8mb4'
.\release\apix-runtime.exe
```

Apix 的数据库连接直接填写主机、端口、库名、用户名和密码，不再支持环境变量连接方式。密码在本机加密保存，不会出现在连接列表、保存响应或操作日志中。上面的 `APIX_MYSQL_DSN` 仅由随附的示例 API 服务读取，不用于新增 Apix 连接。

## AI 连接

MCP 使用 Streamable HTTP，连接地址：

```text
http://127.0.0.1:4317/mcp
```

在支持 HTTP MCP 的客户端中添加这个地址。不同客户端的配置文件格式不同，以客户端支持的格式为准。正常的本机原生 MCP 客户端不需要浏览器 Origin；如果通过浏览器连接，需要在启动 Runtime 前用 `APIX_MCP_ALLOWED_ORIGINS` 配置允许的准确 Origin，多个用逗号分隔。

主要工具：

| 任务 | MCP 工具 |
| --- | --- |
| 发送单个请求 | `send_request` |
| 开始、查看、结束接口测试批次 | `begin_test_batch`、`list_test_batches`、`get_test_batch`、`finish_test_batch` |
| 保存、读取、运行及归档独立测试用例 | `save_test_case`、`list_test_cases`、`get_test_case`、`run_test_case`、`archive_test_case` |
| 保存、列出、测试、删除数据库连接 | `save_database_connection`、`list_database_connections`、`test_database_connection`、`delete_database_connection` |
| 执行 SQL | `execute_sql` |
| 保存、列出服务 | `save_service`、`list_services` |
| 手动启停、查看详情、状态和日志 | `start_service`、`stop_service`、`get_service_details`、`get_service_status`、`get_service_logs` |
| 保存、列出、读取流程 | `save_flow`、`list_flows`、`get_flow` |
| 运行、查询历史、取消流程 | `run_flow`、`get_flow_run`、`list_flow_runs`、`cancel_flow_run` |
| 读取 HTTP 步骤的请求和响应 | `get_api_run`，参数为步骤的 `api_run_id` |
| 处理现有暂停规则 | `resume_flow_step`、`resume_request_step` |
| 查看事件和单次操作结果 | `get_run_events`、`get_operation` |

下面的 JSON 都是对应工具的参数，不是 HTTP MCP 协议报文。

## 成品验证示例

为示例 API 服务配置 `APIX_MYSQL_DSN` 并启动 Runtime 后，在 `/databases` 添加同一测试库的连接，复制列表中的连接 ID，然后在另一终端执行：

```powershell
node scripts/smoke-backend.mjs YOUR_CONNECTION_ID
```

解压后的成品包内也包含脚本，在包目录执行 `node .\smoke-backend.mjs YOUR_CONNECTION_ID`。验证脚本需要 Node.js；Runtime 本身不需要。

该脚本通过 MCP 使用随附的 `apix-demo-service.exe`，真实验证启动服务、接口写入 MySQL、SQL 查验、删除本次数据和自动停止服务。还会验证错误状态码预期和运行取消，结果写入 `release/verification.json`。使用测试数据库；示例服务会创建 `apix_demo_users` 表。

完整示例流程参数在 `runtime/examples/demo-flow.json`（成品包内为 `demo-flow.json`）。脚本默认连接 `http://127.0.0.1:4317`；自定义 Runtime 地址时设置 `APIX_RUNTIME_URL`。

## 配置数据库

支持 `type: "mysql"`、`"postgresql"` 和 `"hologres"`。默认端口分别为 3306、5432 和 80；Hologres 使用 PostgreSQL 协议。新增连接时未传 `type` 默认使用 MySQL；更新连接时省略 `type` 则保留原数据库类型。旧连接迁移后继续使用 MySQL，可以点击“编辑”切换类型，密码留空保留原密码。

PostgreSQL / Hologres 支持 `ssl_mode`：`prefer`（默认）、`require`、`verify-full` 和 `disable`。`verify-full` 验证证书和主机名，使用操作系统或 PostgreSQL 客户端环境配置的信任证书。Hologres 主机、端口和数据库以实例控制台为准；VPC 地址需要 Runtime 所在机器可达该网络。

SQL 参数按数据库原生语法绑定：MySQL 使用 `?`，PostgreSQL / Hologres 使用 `$1`、`$2` 等。例如 `SELECT $1::text AS value` 配合 `params: ["hello"]`。SQL 执行、连接测试和测试流程根据已保存的类型自动选择驱动，执行记录保持统一。

数据库页面的“SQL 执行记录”自动展示最近 100 条 SQL，支持按连接筛选和搜索语句或错误信息。点击语句可展开完整 SQL、绑定参数和失败原因，列表同时显示状态、耗时、执行时间及返回或影响行数。成功的查询可点击“查看结果”，以表格查看字段和数据，空值显示为 `NULL`；空结果保留字段名，截断结果提示已保存行数与总行数未知。通过 MCP `execute_sql`、`POST /api/database/execute` 和测试流程执行的 SQL 及返回结果统一保存到本地 SQLite，重启后仍可查看。结果仅在打开时加载，不会随列表自动刷新重复传输。原版本未保存的 SQL 无法追溯，旧记录未保存的查询结果需要重新执行 SQL 后查看。连接测试不作为 SQL 执行记录。

可通过 `GET /api/database/executions` 读取最近记录，使用 `connection_id` 查询参数获取指定连接的最近 100 条记录。

打开 `http://127.0.0.1:4317/databases`，点击“新增连接”，填写连接名称、主机、端口（默认 3306）、库名、用户名和密码，保存后点击“测试连接”。密码允许为空，保存后立即生效，无需重启或配置环境变量。已有连接在重新进入页面或点击“刷新”时更新。旧版连接保留名称和 ID，需重新填写直接连接信息后才能使用；也可以删除后重新添加。

Windows 使用当前用户的 DPAPI 保护密码，重启 Runtime 后仍可使用；换用户或迁移到其他机器时需重新配置密码。其他平台使用 AES-GCM，密钥保存在 SQLite 文件旁的 `.credentials.key` 文件中（仅当前用户可读写），备份时需同时保留该文件。连接列表、保存响应和操作记录不返回密码。

删除连接需在页面确认，只移除 Apix 的连接配置并释放连接池，不会删除远端数据库、表或历史记录。引用该连接的 Flow 需重新配置，否则后续 SQL 步骤会报告连接不存在。已开始的 SQL 不保证被取消。

调用 `save_database_connection`：

```json
{
  "connection": {
    "id": "mysql-test",
    "name": "本地测试数据库",
    "host": "127.0.0.1",
    "port": 3306,
    "database": "test_db",
    "username": "test_user",
    "password": "YOUR_PASSWORD"
  }
}
```

REST `PUT /api/database/connections` 的正文直接传上面的 `connection` 对象。密码只用于写入；更新连接时不传 `password` 可保留原密码，传空字符串则保存空密码。主机、库名和用户名必填，不再接受 `dsn_env` 字段。

然后调用 `test_database_connection`：

```json
{"connection_id":"mysql-test"}
```

SQL 分两种模式：`query` 返回数据行，`exec` 执行写入并返回 `rows_affected`。每次执行一条语句；MySQL 使用 `?`，PostgreSQL / Hologres 使用 `$1`、`$2` 等占位符，通过 `params` 传值。

调用 `execute_sql`：

```json
{
  "command": {
    "connection_id": "mysql-test",
    "mode": "query",
    "sql": "SELECT id, name FROM apix_demo_users WHERE id = ?",
    "params": [123],
    "timeout_ms": 5000,
    "max_rows": 100
  }
}
```

查询结果包含 `columns`、`rows`、`row_count` 和 `truncated`。结果超过 `max_rows` 时，`truncated` 为 `true`，`row_count` 为 `-1`，不能把它当成准确的总行数。

## 配置本地服务

项目随附 `release/apix-demo-service.exe`，可以用它验证完整闭环。它使用启动 Runtime 时设置的 `APIX_MYSQL_DSN`，启动时创建 `apix_demo_users` 表，MySQL 中需要已有指定数据库，以及建表、写入、查询和删除权限。

下面按当前项目在 `D:\project\apix` 举例。路径换成实际位置后，调用 `save_service`：

```json
{
  "service": {
    "id": "demo-service",
    "name": "示例用户服务",
    "work_dir": "D:\\project\\apix\\release",
    "command": "D:\\project\\apix\\release\\apix-demo-service.exe",
    "args": [],
    "health_url": "http://127.0.0.1:18767/health",
    "startup_timeout_ms": 30000
  }
}
```

`command` 是可执行文件，参数分别放到 `args` 中。工作目录必须已存在。启动后只有健康检查返回 2xx 才算就绪；启动超时、取消或提前退出，会清理本次启动的进程树。

手动测试可以调用：

```text
start_service {"service_id":"demo-service"}
get_service_status {"service_id":"demo-service"}
get_service_details {"service_id":"demo-service"}
get_service_logs {"service_id":"demo-service","after":0}
stop_service {"service_id":"demo-service"}
```

启动优先复用 Runtime 中已运行的实例，保留 PID 和原归属；同一服务并发启动时等待首次启动完成并共享实例。如果配置的健康地址已返回 2xx，则复用外部服务（`owner: external`，不接管 PID），不新建进程；已有响应但非 2xx 时提示检查现有服务，不再重复启动。返回 `started: false` 表示本次没有创建进程。服务身份按配置的 `health_url` 判断，请为不同服务配置各自准确的健康地址。

新建的手动服务使用 `manual` 归属，需要手动停止；关闭 Runtime 时也会清理。Flow 新建的服务属于那次运行。复用其他归属的服务时，Flow 的停止步骤和结束清理都保留该服务，原启动方仍可停止它。外部服务不受停止、流程清理或 Runtime 关闭影响；其 stdout/stderr 不由 Apix 采集，详情中的日志仅为 Apix 已保存的历史。

## 保存一个完整测试流程

下面的流程可配合随附的示例服务使用：

- `GET /health` 返回 2xx。
- `POST /users` 接收姓名，写入 MySQL 的 `apix_demo_users` 表，返回状态码 `201` 和包含 `id`、`name` 的 JSON。
- 表中对应记录可以通过 `SELECT id FROM apix_demo_users WHERE id = ?` 查询。

先完成上述数据库和服务配置，再调用 `save_flow`。流程优先复用已运行的示例服务，否则负责启动它。以后测试自己的业务时，再替换服务配置、接口和表结构。

```json
{
  "flow": {
    "name": "创建用户并检查数据库",
    "settings": {"stop_on_error": true, "request_timeout_ms": 10000},
    "steps": [
      {
        "position": 0,
        "type": "service",
        "name": "启动服务并等待就绪",
        "service": {"service_id": "demo-service", "action": "start"},
        "config": {"timeout_ms": 35000}
      },
      {
        "position": 1,
        "type": "http",
        "name": "创建用户",
        "request": {
          "method": "POST",
          "url": "http://127.0.0.1:18767/users",
          "body_type": "json",
          "body": "{\"name\":\"apix-mvp-test\"}",
          "headers": [{"name": "Content-Type", "value": "application/json", "enabled": true}]
        },
        "config": {
          "expected_status": 201,
          "extractors": [{"name": "user_id", "source": "body", "path": "id", "scope": "run", "required": true}]
        }
      },
      {
        "position": 2,
        "type": "sql",
        "name": "确认用户已写入",
        "sql": {
          "connection_id": "mysql-test",
          "mode": "query",
          "sql": "SELECT id FROM apix_demo_users WHERE id = ?",
          "params": ["{{user_id}}"],
          "timeout_ms": 5000,
          "max_rows": 100
        },
        "config": {"expected_rows": 1}
      },
      {
        "position": 3,
        "type": "sql",
        "name": "删除本次创建的用户",
        "sql": {
          "connection_id": "mysql-test",
          "mode": "exec",
          "sql": "DELETE FROM apix_demo_users WHERE id = ?",
          "params": ["{{user_id}}"]
        }
      },
      {
        "position": 4,
        "type": "service",
        "name": "停止服务",
        "service": {"service_id": "demo-service", "action": "stop"}
      }
    ]
  }
}
```

MCP 保存流程时，未写 `enabled` 的步骤默认启用，`stop_on_error` 默认是 `true`。HTTP 检查在 `config.expected_status`，SQL 查询行数检查在 `config.expected_rows`。

`expected_rows` 检查返回的数据行数，不是 `SELECT COUNT(*)` 的字段值。`SELECT COUNT(*)` 即使计数为零，也通常返回一行。需要验证是否存在一条记录时，请直接查询匹配的记录。

HTTP 提取器使用简单点路径，如 `id` 或 `data.user.id`。SQL 变量只替换整个参数值 `"{{user_id}}"`，语句保持该数据库的原生占位符（MySQL 为 `?`，PostgreSQL / Hologres 为 `$1`、`$2`）；不要把变量直接拼接进 SQL。

失败时后续普通步骤会停止。因此示例中的删除 SQL 不保证在前面失败后执行，需要根据已创建的数据手动补清理。服务停止另有保障：无论成功、失败还是取消，Flow 都会清理本次运行启动的服务；不需要依赖最后的停止步骤被执行。

修改已有流程时，先用 `get_flow` 读取当前 `edit_version`，再在 `save_flow` 的 `flow` 中带上 `id` 和这个版本。这样不会无意覆盖其他修改。

## 运行与查看结果

`save_flow` 返回记录过的操作包装：`{"operation_id":"...","result":{"id":"流程ID",...}}`。取 `result.id` 调用 `run_flow`：

```json
{"flow_id":"流程ID"}
```

`run_flow` 立即返回：

```json
{"operation_id":"启动操作ID","result":{"id":"运行ID"}}
```

这是异步运行。`operation_id` 记录“启动流程”这次工具调用，**测试是否通过要看运行 ID 对应的 Flow 结果**。

调用 `get_flow_run` 查询：

```json
{"run_id":"运行ID"}
```

`queued`、`running`、`paused` 表示运行尚未结束；`succeeded`、`failed`、`cancelled` 是最终状态，服务清理已经结束。结果中查看：

- `steps`：每一步的类型、状态、错误和结果。
- `assertions`：检查项目、预期值、实际值及是否通过。
- HTTP 步骤的 `api_run_id`：对应现有完整请求与响应记录。
- `cleanup_error`：服务清理失败的原因，需要继续处理。

取消使用 `cancel_flow_run {"run_id":"运行ID"}`，然后继续查询直到最终状态。如果现有暂停规则触发，用 `resume_flow_step` 传入 `run_id`、对应 `step_id` 和 `action`（`continue`、`skip` 或 `stop`）处理，无需页面。

## 日志与历史

Runtime 操作事件会写入 `APIX_LOG_PATH` 的 JSON 日志文件，也会保存到 SQLite。服务 stdout/stderr 使用独立的持久化日志，单个服务保留最近 2,000 条，过长单条日志截断。

```text
get_run_events {"run_id":"运行ID","after":0,"limit":200}
get_service_logs {"service_id":"demo-service","after":0}
get_operation {"operation_id":"单次操作ID"}
```

事件和服务日志的 `sequence` 是游标。下次查询把最后收到的序号作为 `after`，即可获取新记录。停止并重新启动 Runtime 后，已有配置和记录仍可以查询。重启前没完成的运行会标记为中断失败，便于识别。

Runtime 日志记录执行元数据，不写入 MySQL 连接串和密码。接口、SQL 结果属于运行记录；被测服务自身输出也会原样进入服务日志，请让被测服务避免打印密码和令牌。

## REST 入口

需要脚本直接访问时，可以使用同一套后端能力：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | Runtime 健康检查 |
| `GET /api/database/connections`、`PUT /api/database/connections` | 列出、保存数据库连接 |
| `POST /api/database/connections/:id/test` | 测试数据库连接 |
| `DELETE /api/database/connections/:id` | 删除 Apix 连接配置，成功返回 204，不删除远端数据库 |
| `POST /api/database/execute` | 执行 SQL，正文直接传 `command` 内的对象 |
| `GET /api/database/executions/:id/result` | 读取 SQL 记录保存的结果，返回 `{"result": ...}`；旧记录或无结果时 `result` 为 `null`，记录不存在返回 404 |
| `GET /api/services`、`PUT /api/services` | 列出、保存服务，正文直接传 `service` 内的对象 |
| `POST /api/services/:id/start`、`POST /api/services/:id/stop` | 手动启停服务 |
| `GET /api/services/:id/status`、`GET /api/services/:id/logs?after=0` | 查询服务状态、日志 |
| `GET /api/services/:id` | 服务配置、运行状态、实时健康检查及最近 100 条日志 |
| `GET /api/flows`、`POST /api/flows` | 列出、创建 Flow |
| `PUT /api/flows/:id` | 保存 Flow 的完整定义，需要 `edit_version` |
| `POST /api/flows/:id/runs` | 异步启动 Flow |
| `GET /api/flow-runs/:id` | 查询 Flow 运行 |
| `POST /api/flow-runs/:id/cancel` | 取消 Flow 运行 |
| `GET /api/events?run_id=运行ID&after=0` | 查询执行事件 |
| `GET /api/operations/:id` | 查询单次 MCP 操作记录 |

REST 创建流程需要两步：先 `POST /api/flows` 传 `{"name":"流程名称"}`，获取新流程的 `id` 和 `edit_version`；再 `PUT /api/flows/:id` 保存带有步骤的完整 Flow 对象及 `edit_version`。PUT 正文不使用 MCP 的 `{"flow":...}` 包装，并请显式设置每个步骤的 `enabled: true`。完整 Flow 路由以 `internal/httpapi/flow_routes.go` 为准。
