# @autoflow/sdk — AutoCodeFlow Node.js SDK

AutoCodeFlow 任务执行器（executor-node）侧的 Node.js/TypeScript SDK：
提供任务上下文（`TaskContext`）、结构化日志（`TaskLogger`）与 Admin API
回调客户端（`HttpClient`）。回调契约与 Python SDK
[`autoflow-sdk`](../autoflow-sdk/README.md) 完全对齐（第九轮），双端共用
`CallbackItemDto` 字段。平台侧完整说明见
[docs/sdk-guide.md](../../docs/sdk-guide.md)。

## 安装

```bash
npm install @autoflow/sdk
```

包为 scoped 公开包（`publishConfig.access = "public"`），产物为 tsup 构建的
CJS + ESM + d.ts（`dist/`）。

## Quickstart

任务脚本由执行器以子进程运行，环境变量注入见下表。`TaskContext.fromEnv()`
读取 `EXECUTION_ID` / `TASK_ID` / `TASK_NAME`（缺失即抛错）与
`AUTOFLOW_*` 回调凭证：

```ts
// tasks/sendReport.ts
import { TaskContext } from '@autoflow/sdk';

export default async function main() {
  const ctx = TaskContext.fromEnv();
  ctx.logger.info('task started', { executionId: ctx.executionId });

  const rows = await doWork();

  // 主动回调 Admin API（N23 per-execution token）。旧版执行器不注入凭证，
  // 此时 ctx.http.enabled === false，结果仍由执行器统一上报。
  if (ctx.http.enabled) {
    // executorAddress 由 SDK 用 AUTOFLOW_EXECUTOR_ADDRESS 自动补齐（N27），
    // 显式书写的值不会被覆盖；executionId 必须为本次执行。
    await ctx.http.post('/api/executions/callback', [
      {
        executionId: ctx.executionId,
        status: 'success',
        logs: `report done: ${rows} rows`,
        durationMs: 1200,
      },
    ]);
  }

  // success()/failure() 构造 TaskResult（自动附带 logger 收集的结构化日志）
  return ctx.success('all done', { rows });
}
```

失败上报：

```ts
try {
  await doWork();
} catch (e) {
  await ctx.http.post('/api/executions/callback', [
    {
      executionId: ctx.executionId,
      status: 'failed',
      errorMessage: String(e),
      failureReason: 'script_error', // timeout / killed / unknown 等
    },
  ]);
  return ctx.failure('work failed');
}
```

### HttpClient 直用

不经 `TaskContext` 也可独立构造（如自托管/测试环境显式给凭证）：

```ts
import { HttpClient } from '@autoflow/sdk';

// new HttpClient(baseURL?, token?, traceId?, executorAddress?)
const http = new HttpClient(process.env.ADMIN_API_URL, process.env.EXECUTOR_TOKEN);
// 或从 TaskEnv 派生：HttpClient.forAdminApi(ctx.env)

if (!http.enabled) throw new Error(http.disabledReason);
const tasks = await http.get('/api/tasks');
```

凭证缺失时构造不报错，但任何请求方法抛出带 `disabledReason` 的明确错误
（N23 fail-closed 语义，与 Python `CallbackDisabledError` 对齐）。

## 执行器注入的环境变量

与 [docs/sdk-guide.md](../../docs/sdk-guide.md) 的注入表逐字一致：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `TASK_ID` | 当前任务的唯一标识 | `task_abc123` |
| `TASK_NAME` | 当前任务名称 | `fetch_data` |
| `EXECUTION_ID` | 本次执行记录的唯一标识 | `exec_xyz789` |
| `AUTOFLOW_<KEY>` | 触发参数，按参数名转大写后注入 | `AUTOFLOW_SOURCE_URL=https://api.example.com` |
| `AUTOFLOW_ADMIN_API_URL` | Admin API 基地址（非机密路由信息，N23 起注入） | `AUTOFLOW_ADMIN_API_URL=http://admin-api:3105` |
| `AUTOFLOW_CALLBACK_TOKEN` | 本次执行的一次性回调 token（`v1.` HMAC，绑定 executionId、随 TTL 过期，N23 起注入） | `AUTOFLOW_CALLBACK_TOKEN=v1.<uuid>.<exp>.<hmac>` |
| `AUTOFLOW_EXECUTOR_ADDRESS` | 当前执行器注册地址（非机密路由信息，N27 起注入；SDK 经 `ctx.executorAddress`（Node）/ `ctx.executor_address`（Python）暴露并自动填入回调请求） | `AUTOFLOW_EXECUTOR_ADDRESS=executor-node:8002` |

兼容的旧式/手动覆盖变量（显式设置时优先）：`ADMIN_API_URL`、
`EXECUTOR_TOKEN`、`TRACE_ID`。

## 版本与发布

- 版本策略：与 `autoflow-sdk`（PyPI）、`autocodeflow-mcp-server` 走
  **lockstep** 单版本线，当前 `1.0.0`。
- 发布管道：[.github/workflows/release.yml](../../.github/workflows/release.yml)。
  push tag `vX.Y.Z` 触发：版本一致性守卫（tag 必须等于本包
  `package.json` version，不一致直接 fail）→ `publish-npm` job
  （node 20，`npm ci && npm run build && npm publish`）。
- 凭证：GitHub secret `NPM_TOKEN`（npmjs Automation token），经
  `setup-node` 的 `registry-url` + `NODE_AUTH_TOKEN` 写入 `~/.npmrc`；
  scoped 包公开可见由 `publishConfig.access = "public"` 保证。
- 本地演练（不真发布）：

  ```bash
  cd packages/autocodeflow-node-sdk
  npm run build && npm publish --access public --dry-run
  ```

- 发布流程与矩阵说明见
  [docs/sdk-guide.md「SDK 矩阵」](../../docs/sdk-guide.md)。
