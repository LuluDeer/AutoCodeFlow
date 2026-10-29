# @autocodeflow/sdk — AutoCodeFlow Node.js SDK

AutoCodeFlow 任务执行器（executor-node）侧的 Node.js/TypeScript SDK：
提供任务上下文（`TaskContext`）、结构化日志（`TaskLogger`）与 Admin API
回调客户端（`HttpClient`）。回调契约与 Python SDK
[`autoflow-sdk`](../autoflow-sdk/README.md) 完全对齐（第九轮），双端共用
`CallbackItemDto` 字段。平台侧完整说明见
[docs/sdk-guide.md](../../docs/sdk-guide.md)。

## 安装

```bash
npm install @autocodeflow/sdk
```

包为 scoped 公开包（`publishConfig.access = "public"`），产物为 tsup 构建的
CJS + ESM + d.ts（`dist/`）。

## Quickstart

任务脚本由执行器以子进程运行，环境变量注入见下表。`TaskContext.fromEnv()`
读取 `EXECUTION_ID` / `TASK_ID` / `TASK_NAME`（缺失即抛错）与
`AUTOFLOW_*` 回调凭证：

```ts
// tasks/sendReport.ts
import { TaskContext } from '@autocodeflow/sdk';

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
import { HttpClient } from '@autocodeflow/sdk';

// new HttpClient(baseURL?, token?, traceId?, executorAddress?)
const http = new HttpClient(process.env.ADMIN_API_URL, process.env.EXECUTOR_TOKEN);
// 或从 TaskEnv 派生：HttpClient.forAdminApi(ctx.env)

if (!http.enabled) throw new Error(http.disabledReason);
const tasks = await http.get('/api/tasks');
```

凭证缺失时构造不报错，但任何请求方法抛出带 `disabledReason` 的明确错误
（N23 fail-closed 语义，与 Python `CallbackDisabledError` 对齐）。

**重试与熔断（默认开启）**：`GET`/`HEAD` 等**幂等方法**在可重试状态下会自动重试 ——
`429/500/502/503/504` 或网络层错误，共 `maxRetries = 3`（总 4 次尝试），
指数退避 `1s → 2s → 4s`（封顶 `30s`），并尊重服务端 `Retry-After`（取 `max(退避, Retry-After)`）；
另有熔断器避免对已宕机的 admin 持续打。

**`POST`/`PUT`/`DELETE` 永不隐式重试**（`safeMethodsOnly: true`），所以「重复上报 / 重复触发外部副作用」
这类风险不会被 SDK 引入 —— 这正是当初只对幂等方法开重试的原因。唯一例外是终态回调直报通道（它自带重试语义）。

`401/403/timeout` 等错误会保留后端 message 后原样传播给任务代码；要完全关掉重试与熔断（恢复薄包装行为）传
`new HttpClient(..., { retry: null })`。

**`retry: null` 的确定形态**（DX-01，2026-10-29）：归一产物是
`{ ...DEFAULT_HTTP_RETRY, maxRetries: 0, breakerEnabled: false }`——
`maxRetries: 0` 是**零**重试（每次请求只尝试 1 次），`breakerEnabled: false` 是
**容错上限 ∞**（不累计失败、不再抛 `CircuitBreakerOpenError`，错误形态回到
`401/403/503` 的 axios 错误本身）。`null` 与 `undefined` 语义相反，别混用：
`{ retry: undefined }` / 不传 options = **走默认**（3 次重试 + 熔断开）；
只想关重试、保留熔断则传 `{ retry: { maxRetries: 0 } }`。
`normalizeRetry` / `DEFAULT_HTTP_RETRY` / `HttpRetryConfig` 均从包入口导出，可在自己的
测试里断言这套形状。

> 与 Python SDK 的差异：
> - 通用 `HttpClient`：node **有自动重试**（幂等方法 + 熔断），py **没有任何自动重试**
>   （重试决策留给任务代码）——迁移时注意这一格的方向；
> - 回调通道：两侧**都有**有界重试（node 总 4 次尝试、py 总 3 次，两边都封顶 5s 单次等待），
>   py 侧见 `CallbackClient.report` 的 `CALLBACK_MAX_ATTEMPTS`。

### 按稳定错误码分支

admin-api 的错误响应体带稳定码（`errorCode`）与插值参数（`params`）。SDK 把它们
**原样挂到被 reject 的错误上**（只读属性，`message` 的拼接语义逐字节不变），
脚本不必再匹配中文兜底文案：

```ts
import { getErrorCode, getErrorParams } from '@autocodeflow/sdk';

try {
  await http.post('/api/executions/callback', items);
} catch (e) {
  if (getErrorCode(e) === 'TASK_NOT_FOUND') {
    // 任务已被删除：不再重试，按业务语义收尾
    console.warn('task gone', getErrorParams(e)); // { taskId: '…' }
  }
  throw e;
}
```

无码时（老后端 / 非本机制的错误体）这两个属性**不存在**（而不是值为
`undefined`），`getErrorCode` 返回 `undefined`；`attachErrorCode(error)` 也可
单独复用于自定义拦截器。

## 执行器注入的环境变量

与 [docs/sdk-guide.md](../../docs/sdk-guide.md) 的注入表逐字一致：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `TASK_ID` | 当前任务的唯一标识 | `task_abc123` |
| `TASK_NAME` | 当前任务名称 | `fetch_data` |
| `EXECUTION_ID` | 本次执行记录的唯一标识 | `exec_xyz789` |
| `AUTOFLOW_<KEY>` | 触发参数，按参数名转大写后注入。**字符串是裸值**（不加引号），数字/布尔/数组/对象是对应 JSON 字面量 | `AUTOFLOW_SOURCE_URL=https://api.example.com` |
| `AUTOFLOW_PARAMS_JSON` | 整个参数的 JSON 对象（A-11R 起，协议 v5）。需要精确类型时读它：逐键通道的值恒为字符串（`ctx.getParam(key, fallback?)` 会自动优先本通道并还原真实类型） | `AUTOFLOW_PARAMS_JSON={"limit":100}` |
| `AUTOFLOW_ADMIN_API_URL` | Admin API 基地址（非机密路由信息，N23 起注入） | `AUTOFLOW_ADMIN_API_URL=http://admin-api:3105` |
| `AUTOFLOW_CALLBACK_TOKEN` | 本次执行的一次性回调 token（`v1.` HMAC，绑定 executionId、随 TTL 过期，N23 起注入） | `AUTOFLOW_CALLBACK_TOKEN=v1.<uuid>.<exp>.<hmac>` |
| `AUTOFLOW_EXECUTOR_ADDRESS` | 当前执行器注册地址（非机密路由信息，N27 起注入；SDK 经 `ctx.executorAddress`（Node）/ `ctx.executor_address`（Python）暴露并自动填入回调请求） | `AUTOFLOW_EXECUTOR_ADDRESS=executor-node:8002` |
| `AUTOFLOW_DEVICE_FINGERPRINT` | 当前执行器的稳定安装身份（非机密，协议 v6 起注入；SDK 经 `ctx.deviceFingerprint`（Node）/ `ctx.device_fingerprint`（Python）暴露并自动填入回调请求）。**回调的行身份**——两台执行器共用同一地址时（pull 模式允许），仅靠地址无法判断回调来自哪一行 | `AUTOFLOW_DEVICE_FINGERPRINT=<64 位小写十六进制>` |

兼容的旧式/手动覆盖变量（显式设置时优先）：`ADMIN_API_URL`、
`EXECUTOR_TOKEN`、`TRACE_ID`。

## 版本与发布

- 版本策略：与 `autoflow-sdk`（PyPI）、`autocodeflow-mcp-server` 走
  **lockstep** 单版本线，当前 `1.15.0`。<!-- x-release-please-version -->
- 发布管道：[.github/workflows/release.yml](../../.github/workflows/release.yml)。
  push tag `vX.Y.Z` 触发：版本一致性守卫（tag 必须等于本包
  `package.json` version，不一致直接 fail）→ `publish-npm` job
  （node 24，`npm ci && npm run build && npm publish --dry-run &&
  npm publish`），发布前经 GitHub `environment: release` 人工审批闸门。
- 凭证与 scope：GitHub secret `NPM_TOKEN`（npmjs Automation token），经
  `setup-node` 的 `registry-url` + `NODE_AUTH_TOKEN` 写入 `~/.npmrc`；
  包发布在 `@autocodeflow` scope 下，公开可见由
  `publishConfig.access = "public"` 保证（scoped 包默认 private）。
- 本地演练（不真发布）：

  ```bash
  cd packages/autocodeflow-node-sdk
  npm run build && npm publish --access public --dry-run
  ```

- 发布流程与矩阵说明见
  [docs/sdk-guide.md「SDK 矩阵」](../../docs/sdk-guide.md)。

> 版本随 autocodeflow lockstep 组同步发布(当前 1.15.0,与 mcp-server/acf-cli 同版)。<!-- x-release-please-version -->
