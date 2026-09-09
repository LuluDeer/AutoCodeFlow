# 回调示例任务（Python SDK）

演示 `autoflow-sdk` 的**主动回调**：任务运行中把阶段性成功/失败信息，
用执行器注入的 per-execution token 上报给 Admin API。

- 入口脚本：[callback_report.py](./callback_report.py)
- 任务配置样例：[task.example.json](./task.example.json)
- Node 版对应示例：[../callback-report-node/callback_report.js](../callback-report-node/callback_report.js)

## 前置条件（executor 侧）

回调凭证由执行器自动注入，无需在任务参数里传 token：

| 变量 | 注入版本 | 说明 |
|------|---------|------|
| `AUTOFLOW_ADMIN_API_URL` | N23 起 | Admin API 基地址（非机密路由信息） |
| `AUTOFLOW_CALLBACK_TOKEN` | N23 起 | 一次性 `v1.` HMAC token，绑定本次 executionId，随任务超时+15 分钟宽限过期 |
| `AUTOFLOW_EXECUTOR_ADDRESS` | N27 起 | 执行器注册地址；SDK 自动补进回调项，缺省时不发送该字段 |

平台自带的 executor-python / executor-node 均已注入上述变量。**旧版自建
执行器**不注入 → `ctx.callback.enabled` 为 `False`，任何上报调用抛
`CallbackDisabledError`（fail-closed）。本示例在不可回调时降级为
"只打日志、继续执行"，正好演示能力探测的正确姿势。

## 运行

### 方式一：平台执行

1. admin 后台「任务管理 → 新建任务」，runtime 选 `python`；
2. glue 脚本粘贴 `callback_report.py` 全部内容，或 entrypoint 填
   `examples/callback-report/callback_report.py`；
3. 任务参数：`mode`（`success` / `fail`，默认 success）、`source_url`（可选）；
4. 触发执行后在「执行详情」的时间线与日志区可看到主动回调产生的记录。

也可以直接把 `task.example.json` 的内容作为 `POST /api/tasks` 请求体
（补上 `executorId` 等必填字段）。

### 方式二：本地模拟（不注入凭证 → 走降级分支）

```bash
cd examples/callback-report
pip install autoflow-sdk            # 或 pip install -e ../../packages/autoflow-sdk

export EXECUTION_ID=exec-local-001
export TASK_ID=callback-demo
export TASK_NAME=回调演示
python callback_report.py           # 输出 callback_used: false
```

### 方式三：本地模拟（注入凭证 → 验证成功/失败两条上报路径）

需要一个可达的 Admin API（本地默认 `http://localhost:3105`）：

```bash
export EXECUTION_ID=exec-local-001
export TASK_ID=callback-demo
export TASK_NAME=回调演示
export AUTOFLOW_ADMIN_API_URL=http://localhost:3105
export AUTOFLOW_CALLBACK_TOKEN="<admin-api 签发的 v1. 回调 token>"
export AUTOFLOW_EXECUTOR_ADDRESS=executor-python:8001
python callback_report.py           # mode 缺省 success → report_success

AUTOFLOW_SOURCE_MODE=ignore python callback_report.py 2>/dev/null
AUTOFLOW_MODE=fail python callback_report.py            # → report_failure 后 re-raise
```

> token 手动获取不便时，最省事的验证方式仍是方式一（平台触发后
> executor 自动注入合法 token）。

## 关键 API 对照（与 Node SDK 等价）

| 动作 | Python | Node |
|------|--------|------|
| 能力探测 | `ctx.callback.enabled` | `ctx.http.enabled` |
| 成功上报 | `ctx.report_success(summary=..., duration_ms=...)` | `await ctx.reportSuccess({ summary, durationMs })` |
| 失败上报 | `ctx.report_failure(e, failure_reason="script_error")` | `await ctx.reportFailure(e, { failureReason: "script_error" })` |
| 批量/自定义字段 | `ctx.callback.report([{...}])` | `await ctx.http.post('/api/executions/callback', [{...}])` |
| 不可用异常 | `CallbackDisabledError` | 请求方法 rejects `Error("HttpClient is disabled...")` |
