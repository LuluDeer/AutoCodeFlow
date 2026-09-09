# 回调示例任务（Node SDK）

演示 `@autocodeflow/sdk` 的**主动回调**：任务运行中把阶段性成功/失败信息，
用执行器注入的 per-execution token 上报给 Admin API。

- 入口脚本：[callback_report.js](./callback_report.js)
- 任务配置样例：[task.example.json](./task.example.json)
- Python 版对应示例：[../callback-report/callback_report.py](../callback-report/callback_report.py)

## 前置条件（executor 侧）

回调凭证由执行器自动注入，无需在任务参数里传 token：

| 变量 | 注入版本 | 说明 |
|------|---------|------|
| `AUTOFLOW_ADMIN_API_URL` | N23 起 | Admin API 基地址（非机密路由信息） |
| `AUTOFLOW_CALLBACK_TOKEN` | N23 起 | 一次性 `v1.` HMAC token，绑定本次 executionId，随任务超时+15 分钟宽限过期 |
| `AUTOFLOW_EXECUTOR_ADDRESS` | N27 起 | 执行器注册地址；SDK 自动补进回调项，缺省时不发送该字段 |

平台自带的 executor-node / executor-python 均已注入上述变量。**旧版自建
执行器**不注入 → `ctx.http.enabled` 为 `false`，任何请求方法 rejects
`Error("HttpClient is disabled...")`（fail-closed）。本示例在不可回调时
降级为"只打日志、继续执行"，正好演示能力探测的正确姿势。

## 运行

### 方式一：平台执行

1. admin 后台「任务管理 → 新建任务」，runtime 选 `node`；
2. glue 脚本粘贴 `callback_report.js` 全部内容，或 entrypoint 填
   `examples/callback-report-node/callback_report.js`；
3. 任务参数：`mode`（`success` / `fail`，默认 success）、`summary`（可选）；
4. **依赖**：任务配置 `requirements: ["@autocodeflow/sdk"]`（glue 脚本忽略
   requirements，需在 entrypoint 打包任务中使用；glue 场景把 SDK 的
   `require` 换成平台预装路径或用 npm 包管理器预置）。executor-node 会把
   依赖装到任务隔离目录并注入 `NODE_PATH`，`require('@autocodeflow/sdk')`
   直接可用。

也可以直接把 `task.example.json` 的内容作为 `POST /api/tasks` 请求体
（补上 `executorId` 等必填字段）。

### 方式二：本地模拟（不注入凭证 → 走降级分支）

```bash
cd examples/callback-report-node
npm install @autocodeflow/sdk        # 或 monorepo 内 npm link

export EXECUTION_ID=exec-local-001
export TASK_ID=callback-demo-node
export TASK_NAME=回调演示Node
node callback_report.js              # 输出 callback_used: false
```

### 方式三：本地模拟（注入凭证 → 验证成功/失败两条上报路径）

需要一个可达的 Admin API（本地默认 `http://localhost:3105`）：

```bash
export EXECUTION_ID=exec-local-001
export TASK_ID=callback-demo-node
export TASK_NAME=回调演示Node
export AUTOFLOW_ADMIN_API_URL=http://localhost:3105
export AUTOFLOW_CALLBACK_TOKEN="<admin-api 签发的 v1. 回调 token>"
export AUTOFLOW_EXECUTOR_ADDRESS=executor-node:8002
node callback_report.js              # mode 缺省 success → reportSuccess

AUTOFLOW_MODE=fail node callback_report.js   # → reportFailure 后 re-throw
```

> token 手动获取不便时，最省事的验证方式仍是方式一（平台触发后
> executor 自动注入合法 token）。

## 关键 API 对照（与 Python SDK 等价）

| 动作 | Node | Python |
|------|------|--------|
| 能力探测 | `ctx.http.enabled` | `ctx.callback.enabled` |
| 成功上报 | `await ctx.reportSuccess({ summary, durationMs })` | `ctx.report_success(summary=..., duration_ms=...)` |
| 失败上报 | `await ctx.reportFailure(e, { failureReason: "script_error" })` | `ctx.report_failure(e, failure_reason="script_error")` |
| 批量/自定义字段 | `await ctx.http.post('/api/executions/callback', [{...}])` | `ctx.callback.report([{...}])` |
| 不可用异常 | 请求方法 rejects `Error("HttpClient is disabled...")` | `CallbackDisabledError` |
