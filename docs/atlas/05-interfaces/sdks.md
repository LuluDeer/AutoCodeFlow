# 双 SDK 能力对照（autoflow-sdk vs @autocodeflow/sdk）
> 所属: docs/atlas/05-interfaces · 最后核对: 2026-09-13 · 对应代码: packages/autoflow-sdk/autoflow_sdk、packages/autocodeflow-node-sdk/src

## 定位

两个 SDK 都跑在**执行器的任务子进程**里：注入环境变量 → `TaskContext` 读取上下文 → 任务代码可选地主动回调 Admin API（`POST /api/executions/callback`）。回调契约完全对齐（第九轮），双端共用 `CallbackItemDto` 字段；平台侧总说明见 `docs/sdk-guide.md`。版本走 lockstep 单版本线（当前 1.2.0，与 mcp-server 同步，`release.yml` version-guard 强制）。

## 能力对照表

| 能力 | Python `autoflow-sdk` | Node `@autocodeflow/sdk` |
|---|---|---|
| 分发 | PyPI；内网 `pip install --index-url http://<registry-pypi>/simple` | npm `@autocodeflow/sdk`（scoped 公开包）；内网 Verdaccio |
| 运行时/依赖 | Python ≥ 3.9；httpx、pyyaml、pydantic≥2 | TypeScript；axios；产物 CJS+ESM+d.ts（tsup） |
| 上下文入口 | `TaskContext.from_env()` | `TaskContext.fromEnv()`（缺 `EXECUTION_ID/TASK_ID/TASK_NAME` 即抛错；`TaskContext.create(env)` 测试用） |
| 字段访问 | `ctx.task_id` / `ctx.execution_id` / `ctx.task_name` / `ctx.get_param("source_url")`（读 `AUTOFLOW_SOURCE_URL`） | `ctx.taskId` / `ctx.executionId` / `ctx.taskName` / 参数经 env `AUTOFLOW_*` |
| 回调客户端 | `CallbackClient`（暴露为 `ctx.callback`）；`ctx.report_success(summary=…, duration_ms=…)`、`ctx.report_failure(e, failure_reason="script_error")` | `HttpClient`（暴露为 `ctx.http`）；`ctx.reportSuccess(options)`、`ctx.reportFailure(error, options)`，也可 `ctx.http.post('/api/executions/callback', [item])` |
| 凭证缺失行为 | 抛 `CallbackDisabledError`（指明缺失变量，fail-closed）；`ctx.callback.enabled` 探测 | 构造不报错，调用抛 `http.disabledReason` 错误；`ctx.http.enabled` 探测 |
| 通用 HTTP 客户端 | `HttpClient` / `AsyncHttpClient`（httpx.Response；`HttpClientError`） | `HttpClient`（axios，10s 超时；`HttpClient.forAdminApi(ctx.env)` 派生） |
| 结构化日志 | `ctx.log` + `get_logger()`（logging） | `ctx.logger`（`TaskLogger`，收集 LogEntry 并随 `TaskResult` 附带） |
| 结果对象 | `TaskResult`（`result.py`） | `ctx.success(msg, extra)` / `ctx.failure(msg)` 构造 `TaskResult` |
| 协议模型 | `ExecuteRequest` / `ExecuteResult` / `TaskConfig`（pydantic） | `types.ts`（`TaskEnv` / `TaskResult` / `LogEntry` / `LogLevel`） |
| 重试 | 无隐式重试（双端一致），401/403/timeout 保留后端 message 传播 | 同左 |

## 初始化（两端一致的 env 注入表）

| 变量 | 说明 |
|---|---|
| `TASK_ID` / `TASK_NAME` / `EXECUTION_ID` | 任务/执行标识（Node 缺失即抛错） |
| `AUTOFLOW_<KEY>` | 触发参数按参数名转大写注入 |
| `AUTOFLOW_ADMIN_API_URL` | Admin API 基地址（N23 起） |
| `AUTOFLOW_CALLBACK_TOKEN` | per-execution 一次性 token（`v1.<uuid>.<exp>.<hmac>`，绑定 executionId，随 TTL 过期） |
| `AUTOFLOW_EXECUTOR_ADDRESS` | 当前执行器注册地址（N27 起），自动补进回调体 |

**执行器共享 token 绝不进任务子进程**（SEC-01）；Node 另兼容旧式 `ADMIN_API_URL` / `EXECUTOR_TOKEN` / `TRACE_ID`（显式设置时优先）。

## 回调契约（双端一致）

- 端点：`POST {AUTOFLOW_ADMIN_API_URL}/api/executions/callback`，体为 `CallbackItemDto[]`（单批 ≤100）。
- 字段：`executionId`（必填，只能为本执行）、`status: success|failed`、`executorAddress`、`logs`（≤512,000 字符）、`errorMessage`（≤4,096 字符）、`failureReason`（admin-api `ExecutionFailureReason` 枚举，非法值 Python 侧抛 `ValueError`，默认 `script_error`）、`durationMs`。
- per-execution token 只授权**本 executionId** 的回调，越权/过期 401（fail-closed）。
- `executionId` / `executorAddress` 由 SDK 自动补齐（N27），显式书写的值不会被覆盖。

## 刻意分歧（对接时注意）

1. **凭证变量集合不同**：Python 只读 `AUTOFLOW_ADMIN_API_URL` / `AUTOFLOW_CALLBACK_TOKEN`（不读旧式变量）；Node 额外兼容旧式/手动覆盖变量。
2. **错误暴露形态不同**：Python 抛异常类型（`CallbackDisabledError` / `ValueError` / `HttpClientError`）；Node 走 `enabled` 标志 + `disabledReason` 字符串。
3. **同步/异步**：Python 提供同步 `HttpClient` 与 `AsyncHttpClient` 两个类；Node 单一 axios 客户端 + async 方法。
4. **结果构造**：Node 的 `ctx.success()/failure()` 会自动附带 logger 收集的结构化日志；Python 的 `TaskResult` 与 logging 体系解耦。
5. Python 侧 `failure_reason` 校验在客户端（非法值本地 `ValueError`），Node 侧交给后端枚举校验。

## 安装与产物

| | Python `autoflow-sdk` | Node `@autocodeflow/sdk` |
|---|---|---|
| 安装 | `pip install autoflow-sdk`；内网：`pip install --index-url http://<registry-pypi>/simple autoflow-sdk` | `npm install @autocodeflow/sdk`；内网指向 Verdaccio |
| 产物 | sdist + wheel（`python -m build`） | tsup 构建 CJS + ESM + d.ts（`dist/`） |
| 仓库根自测 | `npm run test:sdk-py`（pytest） | `npm run test:node-sdk`（jest + coverage） |
| 发布验证 | `python -m build` 本地演练 | `npm publish --dry-run` 结构校验 |

## Quickstart 模板（双端）

Python（任务脚本由执行器以子进程运行）：

```python
from autoflow_sdk import TaskContext

ctx = TaskContext.from_env()
ctx.log.info(f"task {ctx.task_id} started, execution={ctx.execution_id}")
if ctx.callback.enabled:                       # 旧执行器不注入凭证时为 False
    ctx.report_success(summary=f"{rows} rows", duration_ms=1200)
# 失败路径：
#   ctx.report_failure(e, failure_reason="script_error")
```

Node：

```ts
import { TaskContext } from '@autocodeflow/sdk';

export default async function main() {
  const ctx = TaskContext.fromEnv();
  if (ctx.http.enabled) {
    await ctx.reportSuccess({ logs: `done: ${rows} rows`, durationMs: 1200 });
  }
  return ctx.success('all done', { rows });   // 自动附带 logger 收集的结构化日志
}
```

底层批量回调：Python `ctx.callback.report([...])` / Node `ctx.http.post('/api/executions/callback', [...])`，均自动补齐 `executionId` / `executorAddress`（显式书写不被覆盖，N27）。

## 常见坑

- 旧执行器不注入回调凭证 → `ctx.callback.enabled / ctx.http.enabled` 为 False，结果仍由执行器统一上报，任务代码必须走 `if enabled` 分支而不是硬编码调用。
- 回调成功≠幂等豁免：重复回调 admin-api 业务层同样可能回 true，不要用响应判断"是否第一次上报"。
- 不要在回调体里写共享 token 或其他机密（会进入执行日志/审计链路）。

## 相关文档

- [../02-packages/autoflow-sdk.md](../02-packages/autoflow-sdk.md) / [../02-packages/autocodeflow-node-sdk.md](../02-packages/autocodeflow-node-sdk.md) — 包实现、测试与发布细节
- [../04-flows/execution-callback.md](../04-flows/execution-callback.md) — 回调时序与 token 校验
- [../01-apps/executor-python/README.md](../01-apps/executor-python/README.md) / [../01-apps/executor-node/README.md](../01-apps/executor-node/README.md) — env 注入方
