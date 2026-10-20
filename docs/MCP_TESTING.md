# MCP 工具测试（第一版）

在 `http://127.0.0.1:4317/mcp-tools` 或侧边栏 **MCP 工具** 中使用。
本版支持 Streamable HTTP、静态认证请求头与超时配置；不包含 stdio、交互式 OAuth 登录、服务端请求模型采样或人工补充输入。流程编排保持原有行为。

## 连接和调试

1. 添加服务器，填写名称、HTTP/HTTPS MCP 地址和超时（1–300 秒）。
2. 如需认证，填写 JSON 请求头，例如 `{"Authorization":"Bearer ..."}`。请求头在本机加密保存，复用现有凭据保护机制和密钥文件。编辑时 `••••••` 表示保留原值；删除相应字段表示移除请求头。URL 不接受用户密码和敏感查询参数。
3. 点击 **测试连接并获取工具**。此操作只握手并读取完整分页工具列表，不执行业务工具。
4. 选择工具，使用参数表单或 JSON 编辑器填写参数。JSON 编辑器可表达嵌套对象及复杂参数结构。
5. 点击 **执行工具**。每次手动调试创建独立测试批次和记录；未设置预期的调用标记为 `unverified`，包括工具返回业务错误的情况。

每次测试在独立连接中完成握手、工具发现和一次调用，不继承其他测试的服务端会话。`tools/call` 失败或超时不会自动重发；远端操作是否已完成需要结合其业务结果判断。

## 保存、重复运行和历史

从工具编辑区选择 **保存为测试用例**，设置用例名称、预期工具结果、断言和可选 outputSchema 校验。
保存用例在 **接口测试 → 已保存用例** 中与 HTTP 用例共同管理，可编辑、复制、移除或勾选批量运行。
HTTP 和 MCP 用例可以进入同一个测试批次，统计与批次结束规则一致。
进行中的批次也可通过 **＋ MCP 测试** 添加独立测试。

MCP 用例的敏感参数建议使用 `{{token}}` 等占位符，在运行变量中显式传入字符串值。变量只替换参数中的字符串值，不继承上一用例结果。保存的参数定义与 HTTP 用例相同，是可编辑配置；不要把真实业务凭据写进保存的参数或断言。

历史保留用例版本、参数快照、预期、工具定义、服务器配置快照（请求头已遮蔽）、耗时、返回内容和断言预期/实际值。已识别敏感字段、认证头值和本次敏感参数值会脱敏。
结果快照最多保留约 256 KB，大结果以明确标记的预览保存；断言使用完整实时返回值，过大的断言证据以预览保存。
编辑或移除用例、删除服务器不影响既有记录；原服务器删除后，保存用例需重新选择连接才能运行。
Runtime 重启会中断未完成批次并把运行中的用例记为错误，不会重发调用。

## 断言

- `expected_is_error`：匹配工具的 `isError`，允许把预期业务错误设置为通过。
- `validate_output_schema`：校验工具声明的 `outputSchema` 与 `structuredContent`；未声明或结构不匹配时断言失败。
- `assertions[].source`：`structuredContent`、`text`、`isError`、`result`。
- `path`：点路径，例如 `data.id`、`items.0.name`；留空表示整个来源。`text` 是所有文本块按换行连接的文本；指定路径时会尝试把它解析为 JSON。
- `operator`：`equals`、`not_equals`、`contains`、`exists`。缺失路径不通过任何操作；比较沿用文本语义，布尔值写作 `"false"` / `"true"`。

握手、网络、超时和 JSON-RPC 协议错误属于执行错误，与业务返回的 `isError` 分开记录。没有任何预期时不判定为通过。

## REST / AI 共用执行

服务器接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/api/mcp-servers` | 列表 / 添加 |
| PUT / DELETE | `/api/mcp-servers/:id` | 带 edit_version 更新 / 移除 |
| POST | `/api/mcp-servers/:id/discover` | 握手并发现工具 |

用例、运行和批次继续使用 `/api/test-cases`、`/api/test-batches`。
MCP 用例结构如下：

```json
{
  "type": "mcp",
  "name": "查询订单",
  "mcp_request": {
    "server_id": "<server-id>",
    "tool_name": "get_order",
    "arguments": {"order_id": "10001"}
  },
  "expected_is_error": false,
  "validate_output_schema": true,
  "assertions": [
    {"source": "structuredContent", "path": "status", "operator": "equals", "expected": "paid"}
  ]
}
```

AI 可通过 `list_mcp_servers`、`discover_mcp_tools` 找到服务器和工具，然后复用 `begin_test_batch`、`save_test_case`、`run_test_case`、`get_test_batch`、`finish_test_batch`。页面与 AI 使用同一个 MCP 客户端及测试执行模块。
