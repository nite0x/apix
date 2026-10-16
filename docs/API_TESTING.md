# 接口测试：批次、用例与执行记录

接口测试用于一个或多个接口的不同入参验证。各用例相互独立；需要登录、创建、查询等步骤依赖或响应变量传递时使用 Flow。

## 页面使用

启动 Runtime，打开 `http://127.0.0.1:4317/tests`，或从桌面端侧栏的「接口测试」进入。

- **测试批次**：查看本次任务的执行记录，按接口分组，展开后查看入参、断言的预期与实际值，以及底层请求响应详情。
- **临时测试**：「添加测试」或「新建用例」→ 填写用例名、请求和预期 →「仅运行本次」。不创建保存的用例。没有选中进行中批次时会新建批次，并在请求完成后自动结束。
- **保存用例**：新建用例，或将历史测试「另存为用例」。每组不同入参对应一个具名用例，可编辑、复制、移除。
- **重复验证**：勾选多个保存用例并运行。可创建新批次，也可加入已有批次；新批次会自动结束。从历史记录「重试用例」使用当前保存版本，并生成新的执行记录。
- **暂停规则**：页面和 MCP 共用已有执行器。遇到暂停时，在批次中选择继续、跳过或停止。有等待或运行中的请求时不能结束批次。

批次列表展示最近 100 个批次，用例列表最多展示 500 个保存用例。批次统计以**执行次数**为单位，包含重试；所有尝试都会保留，不会用后一次结果覆盖前一次。

## 数据含义

| 对象 | 职责 |
| --- | --- |
| TestBatch | 明确标识一次测试任务，包含多个接口、多个输入变体 |
| TestCase | 可选的可复用定义：名称、说明、请求、预期状态码及响应断言 |
| TestCaseRun | 一次尝试：批次、来源用例版本、请求快照、断言定义和结果 |
| APIRun | 已有的单次 HTTP 请求响应记录，通过 `api_run_id` 关联 |

批次 ID 同时作为兼容 Session 的 ID；批次元数据和结果单独持久化，以支持明确的生命周期、版本快照和并发结束保护。完成批次会同步结束兼容会话。不同 AI 必须显式传自己的批次 ID，不使用全局「当前批次」或时间窗口猜测归属。

批次状态：`running`、`completed`、`interrupted`。`completed` 表示任务结束，不表示所有测试通过。

| 测试结果 | 含义 |
| --- | --- |
| running | 请求在执行、排队或等待暂停规则 |
| passed | 已设置的全部断言符合预期 |
| failed | 请求完成，但至少一个断言失败 |
| error | 请求无法执行、超时、被停止或运行中断 |
| unverified | 请求完成，但未设置任何预期断言 |

HTTP 400、404 等可以是通过的测试。没有预期时，即使返回 200 也只标记为 `unverified`。传输错误和断言失败都会返回结构化结果，调用方应检查 `test_status`；它们不会阻止后续独立用例执行。

每次运行保留用例版本和预期快照。修改或移除保存用例不影响历史；移除后不能继续用其 ID 执行。HTTP 快照沿用原有脱敏和过期策略；底层请求被清理后，测试结果仍保留。历史脱敏字段必须替换后才能执行。

Runtime 重启会把未完成批次标为 `interrupted`，未完成尝试标为 `error`，不会自动重发请求。

## AI / MCP 调用

先开始批次，相关调用携带 `batch_id`，最后明确结束。新测试任务应创建新批次。

```js
begin_test_batch({"name":"用户接口参数校验"})

send_request({
  "batch_id":"<返回的批次 id>",
  "case_name":"缺少邮箱应返回 400",
  "method":"POST",
  "url":"http://127.0.0.1:8080/users",
  "body":"{}",
  "expected_status":400,
  "assertions":[
    {"source":"body","path":"error.code","operator":"equals","expected":"INVALID_EMAIL"}
  ]
})

get_test_batch({"batch_id":"<batch-id>"})
finish_test_batch({"batch_id":"<batch-id>"})
```

稳定用例可保存后执行：

```js
save_test_case({
  "test_case":{
    "name":"正常邮箱",
    "request":{
      "method":"POST",
      "url":"{{base_url}}/users",
      "body_type":"json",
      "body":"{\"email\":\"test@example.com\"}",
      "headers":[{"name":"Authorization","value":"Bearer {{token}}","enabled":true}]
    },
    "expected_status":201
  }
})

run_test_case({
  "batch_id":"<batch-id>",
  "case_id":"<返回的用例 id>",
  "variables":{"base_url":"http://127.0.0.1:8080","token":"<runtime-token>"}
})
```

`run_test_case` 也支持传 `test_case` 对象作为临时用例，和 `case_id` 二选一。每次请求仅使用显式变量，不继承上一用例响应中的 token 或 ID。同批次进入兼容执行器的调用串行处理，不同批次可独立运行。结束批次与预约用例由 SQLite 原子语句协调。

其他工具：`list_test_batches`、`list_test_cases`、`get_test_case`、`archive_test_case`。更新用例需要 `id` 和当前 `edit_version`，过期版本会报冲突。保存的用例是可编辑请求定义；认证字段建议使用占位符，在运行时传入变量。

## 断言

可选的 `expected_status` 接受 100–599。`assertions` 每项包含：

- `source`：`status`、`header` 或 `body`。
- `path`：响应头名称，或 `data.user.id`、`items.0.id` 等正文点路径；正文留空表示整个正文。
- `operator`：`equals`、`not_equals`、`contains` 或 `exists`。
- `expected`：文本形式的预期值，`exists` 不需要。

响应头名称不区分大小写，值比较沿用 Flow 的文本提取规则。缺失路径不会通过 `not_equals`；响应正文被截断时，正文断言会失败。

## REST

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/api/test-batches` | 列出 / 开始批次 |
| GET | `/api/test-batches/:id` | 获取统计与全部尝试 |
| POST | `/api/test-batches/:id/runs` | 执行 `{case_id}` 或 `{test_case}`，可附 `variables` |
| POST | `/api/test-batches/:id/finish` | 结束批次，有运行中尝试时返回 409 |
| GET / POST | `/api/test-cases` | 列出 / 保存新用例 |
| GET / PUT / DELETE | `/api/test-cases/:id` | 查看 / 带版本更新 / 归档用例 |

列表接受 `project_id`，默认 `default`。批次只能运行所属项目的保存用例。执行为同步调用；关闭页面可能中断当前请求，已产生记录仍保留。页面不会因网络错误自动重发请求。
