# 命令行 / 脚本测试（第一版）

打开 `http://127.0.0.1:4317/commands`，或在侧边栏选择 **命令行**。
程序在 Apix Runtime 所在系统执行。当前开发环境是 Ubuntu WSL，使用 Linux 程序、路径和依赖；Windows 浏览器只负责显示页面。

## 执行

- **执行程序**：填写程序名称或绝对路径。名称使用 Runtime 启动时的 PATH 查找；自定义程序建议使用绝对路径。
- **工作目录**：可留空沿用 Runtime 工作目录；填写时使用绝对路径。相对脚本文件路径以此目录为基准。
- **启动参数**：字符串 JSON 数组，每项是一个完整参数，支持空参数和包含空格的参数。不会自动展开 `$VAR`、`$(...)`、通配符或 shell 操作符。
- **环境变量**：值为字符串的 JSON 对象，在 Runtime 环境基础上覆盖并传给子进程。环境变量中的 PATH 用于子进程后续查找程序；顶层执行程序仍按 Runtime PATH 查找。
- **标准输入 / 脚本正文**：传给程序的 stdin。执行已有脚本时，在参数中填写脚本路径。内联脚本可使用 `bash` 配合 `["-s"]`，或者 `python3` / `node` 配合 `["-"]`，再在此字段填写脚本。
- **超时**：默认 30 秒，可设为 1–300 秒。

例如内联 Python 脚本：程序填 `python3`，参数填 `["-"]`，标准输入填写：

```python
import json
print(json.dumps({"ok": True, "count": 3}))
```

如果要使用 shell 语法，显式选择 `bash` 等解释器，并通过 `-c` 参数或 stdin 传入代码。
所有验证均使用独立的一次性命令，不启动已配置的外部业务服务，也不修改流程编排。

## 预期和结果

页面默认预期退出码 `0`。也可填写非零退出码验证预期失败；留空且不设置其他断言时记录为 `unverified`，退出码 0 不会自动代表通过。
无法启动、超时、取消、信号终止或进程树清理失败属于 `error`，与已完成进程的非零退出码分开记录。

断言的 `source` 支持：

| 来源 | 含义 | 路径 |
| --- | --- | --- |
| `exit_code` | 进程退出码 | 留空 |
| `stdout` | 标准输出文本 | 可留空；若有点路径则解析为 JSON |
| `stderr` | 标准错误文本 | 可留空；若有点路径则解析为 JSON |

操作符支持 `equals`、`not_equals`、`contains`、`exists`。缺失字段不通过任何断言。比较沿用文本语义，布尔值写作 `"true"` / `"false"`。

```json
[
  {"source":"stdout","path":"ok","operator":"equals","expected":"true"},
  {"source":"stdout","path":"count","operator":"equals","expected":"3"}
]
```

stdout、stderr 分别捕获最多 256 KB 原始数据，作为文本显示（无效 UTF-8 替换为占位字符）。持续输出超过限制时仍继续排空管道，避免进程阻塞。被截断的流会明确标记，对该流的输出断言不会通过；退出码仍可单独验证。
命令退出后清理本次进程组 / Job 中残留的后代；超时、请求取消和 Runtime 正常关闭时也会终止本次进程树。命令不自动重试。

## 保存和批次

**保存测试用例**只保存定义，不启动进程。保存后可在 **接口测试 → 已保存用例** 中编辑、复制、移除、勾选运行。也能从历史记录另存为用例。
HTTP、MCP 和命令行用例可以共用测试批次。在进行中的批次选择 **＋ 命令行测试**，可添加临时测试。

每次执行保留用例版本、命令输入快照、预期、stdout/stderr、退出码、耗时、截断标记与断言预期/实际值。修改或移除用例不会改写旧记录；重试使用当前保存的版本。
敏感环境变量、参数和断言建议保存为 `{{token}}` 等占位符，执行时通过运行变量显式传入字符串值。保存的定义属于可编辑配置，不要把真实业务凭据写进脚本、环境变量或断言。已识别的敏感环境变量、长参数中的敏感值、敏感运行变量和 JSON 字段会在执行快照与结果中脱敏。

Runtime 重启会将未完成批次标为中断、运行中的尝试标为错误，不会重新执行命令。强制杀死 Runtime 与正常关闭不同，不保证完成进程清理。

## REST / MCP

执行环境信息：`GET /api/commands/environment`（系统名称、Runtime 工作目录、输出限制；不返回环境变量）。
用例、批次和执行仍使用 `/api/test-cases`、`/api/test-batches`。命令行用例结构：

```json
{
  "type": "command",
  "name": "Python 脚本冒烟",
  "command_request": {
    "program": "python3",
    "args": ["-"],
    "work_dir": "/home/nite/projects/apix",
    "env": {},
    "stdin": "print('done')\n",
    "timeout_seconds": 30
  },
  "expected_exit_code": 0,
  "assertions": [
    {"source":"stdout","operator":"contains","expected":"done"}
  ]
}
```

AI 复用 `begin_test_batch`、`save_test_case`、`run_test_case`、`get_test_batch` 和 `finish_test_batch`；页面和 MCP 走同一个命令执行器与结果记录逻辑。运行时变量只替换字符串值，各用例之间不会继承输出。
