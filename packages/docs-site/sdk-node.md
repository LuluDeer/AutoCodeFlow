# Node.js SDK — @autocodeflow/sdk

> 重组自 [packages/autocodeflow-node-sdk/README.md](https://github.com/LuluDeer/AutoCodeFlow/blob/main/packages/autocodeflow-node-sdk/README.md)
> 与 SDK 源码（`src/context.ts` / `src/http-client.ts` / `src/logger.ts` / `src/types.ts`）。

AutoCodeFlow 任务执行器（executor-node）侧的 Node.js/TypeScript SDK：
提供任务上下文（`TaskContext`）、结构化日志（`TaskLogger`）与 Admin API
回调客户端（`HttpClient`）。回调契约与 Python SDK `autoflow-sdk` 完全对齐。

## 安装

```bash
npm install @autocodeflow/sdk
```

包为 scoped 公开包（`publishConfig.access = "public"`），产物为 tsup 构建的
CJS + ESM + d.ts（`dist/`）。当前版本 **2.3.0**（与 py SDK lockstep）。<!-- x-release-please-version -->

## TaskContext

```ts
import { TaskContext } from '@autocodeflow/sdk';
```

| 成员 | 说明 |
|------|------|
| `TaskContext.fromEnv()` | 从执行器注入的环境变量构造；缺 `EXECUTION_ID` / `TASK_ID` / `TASK_NAME` 任一即**抛错**（worker 侧早失败利于排障） |
| `TaskContext.create(env)` | 显式构造 `TaskEnv`（测试/自托管场景） |
| `ctx.executionId` / `ctx.taskId` / `ctx.taskName` | 任务标识（`fromEnv` 必填三件） |
| `ctx.executorAddress` | 执行器注册地址（`AUTOFLOW_EXECUTOR_ADDRESS`，N27）；旧版执行器上为 `undefined` |
| `ctx.deviceFingerprint` | 执行器稳定安装身份（`AUTOFLOW_DEVICE_FINGERPRINT`，协议 v6）；旧版执行器上为 `undefined` |
| `ctx.getParam(key, fallback?)` | 读取触发参数（**大小写不敏感**，优先 `AUTOFLOW_PARAMS_JSON` 真实类型，旧执行器回落逐键 `AUTOFLOW_<KEY>` 并尽力还原类型） |
| `ctx.env` | 解析后的完整 `TaskEnv`（含 `params`） |
| `ctx.http` | Admin API 回调客户端（见下） |
| `ctx.logger` | 结构化日志器（见下） |

### 凭据与上下文 env 识别（fromEnv）

| 变量 | 映射 | 说明 |
|------|------|------|
| `AUTOFLOW_ADMIN_API_URL` | `env.adminApiUrl` | Admin API 基地址 |
| `AUTOFLOW_CALLBACK_TOKEN` | `env.executorToken` | 一次性 per-execution token |
| `AUTOFLOW_EXECUTOR_ADDRESS` | `env.executorAddress` | 执行器地址（N27） |
| `AUTOFLOW_DEVICE_FINGERPRINT` | `env.deviceFingerprint` | 执行器稳定安装身份（协议 v6） |
| `AUTOFLOW_PARAMS_JSON` | `env.params` | 触发参数类型化 JSON 对象（协议 v5，供 `ctx.getParam()` 优先读取） |
| `ADMIN_API_URL` / `EXECUTOR_TOKEN` / `TRACE_ID` | 同上对应字段 | 旧式手动覆盖变量，**显式设置时优先** |

> 提示：推荐使用 `ctx.getParam(key, fallback?)` 读取触发参数——`fromEnv()` 会自动解析 `AUTOFLOW_PARAMS_JSON` 并在旧执行器上回落逐键 `AUTOFLOW_<KEY>`（大小写不敏感，与 Python `ctx.get_param()` 语义对齐）；直接读取 `process.env.AUTOFLOW_X`（字符串裸值）同样可用。

## HttpClient（回调 + 通用请求）

```ts
import { HttpClient } from '@autocodeflow/sdk';

// new HttpClient(baseURL?, token?, traceId?, executorAddress?)
const http = new HttpClient(process.env.ADMIN_API_URL, process.env.EXECUTOR_TOKEN);
// 或从 TaskEnv 派生：HttpClient.forAdminApi(ctx.env)

if (!http.enabled) throw new Error(http.disabledReason);
const tasks = await http.get('/api/tasks');   // 返回已解包的 body（envelope 剥离）
```

| API | 说明 |
|-----|------|
| `http.get/post/put/delete(url, data?)` | 泛型请求，返回**已解包**的 `{code,message,data}` envelope `data`；非信封 body 原样返回 |
| `http.enabled` / `http.disabledReason` | 凭据缺失时可构造但 disabled；任何请求方法 rejects `HttpClientDisabledError`（继承 `Error`，包入口已导出，fail-closed，原因含缺失变量名） |
| executorAddress 自动补齐 | 对 `/api/executions/callback` 请求，数组项缺 `executorAddress` 时自动补（显式书写不被覆盖）；其他端点透传（N27） |
| 默认超时 | 10 s（axios 全局，回调与通用请求同一客户端） |
| 错误形态 | axios error 携带 `response.status`；拦截器把 4xx/5xx envelope 的 `message` 追加进 `error.message` |
| 重试 | **有自动重试（默认开启）**：幂等方法（`GET`/`HEAD`/`OPTIONS`）在 `429/500/502/503/504` 与网络层错误上重试 `maxRetries=3`（总 4 次尝试），退避 `1s→2s→4s` 封顶 `30s`、与 `Retry-After` 取大；`POST`/`PUT`/`DELETE` 默认不重试，**唯一例外**是终态回调 `POST /api/executions/callback`（豁免 `safeMethodsOnly`，任何 `≥500`/429/网络错误都重试，单次等待封顶 5 s） |
| 熔断 | 进程内熔断器：连续 5 次可熔断失败 → open 60 s → half-open 单探测；open 期间请求直接抛 `CircuitBreakerOpenError`（`send()` 循环头） |
| 关闭可靠性层 | `new HttpClient(..., { retry: null })` → 归一为 `maxRetries: 0` + `breakerEnabled: false`（**零重试 + 不熔断**，错误形态回到薄包装）；`{ retry: undefined }` / 不传 options = 走默认。`normalizeRetry` / `DEFAULT_HTTP_RETRY` / `HttpRetryConfig` 均从包入口导出，可自行断言 |

## 回调便捷方法（ECO-01 起）

```ts
// 成功上报：executionId 固定本执行、executorAddress 自动补齐
await ctx.reportSuccess({ summary: 'done', durationMs: 1234 });

// 失败上报：error 字符串化截断至 4 KB；failureReason 默认 'script_error'
try {
  await doWork();
} catch (e) {
  await ctx.reportFailure(e, { summary: 'mid-way failed', failureReason: 'script_error' });
  return ctx.failure('work failed');
}
```

| API | 说明 |
|-----|------|
| `ctx.reportSuccess(options?)` | `{ summary?, durationMs? }`；`summary` 进回调项 `logs`（截断 512 KB） |
| `ctx.reportFailure(error, options?)` | `{ summary?, durationMs?, failureReason? }`；`errorMessage` 截断 4 KB；`failureReason` **本地白名单早拒**（12 项 = `packages/executor-protocol/protocol.json` 的 `executorReportable`，与 py `callback.py` 逐值同源）：非法值**同步抛 `TypeError`**（方法非 `async`，故 `ctx.reportFailure(...).catch(...)` 接不到，用 `try { await … } catch`）；合法值不匹配时不会白烧一次 HTTP 400 |
| `ERROR_MESSAGE_MAX_LENGTH` / `LOGS_MAX_LENGTH` | 导出常量 `4096` / `512000`（与 py 同值） |

需要批量/自定义字段时手拼 payload：

```ts
await ctx.http.post('/api/executions/callback', [
  { executionId: ctx.executionId, status: 'success', durationMs: 800 },
]);
```

回调契约字段（`CallbackItemDto`）：`executionId` / `status: success|failed` /
`executorAddress` / `deviceFingerprint` / `exitCode` / `logs` /
`errorMessage` / `failureReason` / `durationMs` / `artifacts` / `result`。
per-execution token 只对该端点有效，越权或过期一律 401（fail-closed）。

## TaskLogger

```ts
ctx.logger.info('task started', { executionId: ctx.executionId });
ctx.logger.warn('retrying', { attempt: 2 });
ctx.logger.error('unexpected', { err: String(e) });
```

| API | 说明 |
|-----|------|
| `debug/info/warn/error(message, meta?)` | 四级结构化日志；写对应 `console.*` 并保留内存副本，`meta` 为可选结构化元数据 |
| `logger.getLogs()` | 返回已收集条目的浅拷贝 |
| `logger.clear()` | 清空缓冲 |
| `ctx.success(msg?, output?)` / `ctx.failure(msg?, output?)` | 构造 `TaskResult`（**便捷返回值**：执行器以子进程 stdout 为执行日志来源，**不读取**脚本返回值；`output`/`message` 不会自动上报，需要上报请走 `ctx.http` 或写进 `ctx.logger`） |

## 结果构造器

```ts
return ctx.success('all done', { rows: 42 });   // TaskResult{ success: true, message, output, logs }
return ctx.failure('boom', { partial: state }); // TaskResult{ success: false, ... }
```

## 公开导出清单

- **类与函数 / 常量**：`TaskContext`、`ERROR_MESSAGE_MAX_LENGTH`、`LOGS_MAX_LENGTH`、`TaskLogger`、`HttpClient`、`HttpClientDisabledError`、`CircuitBreakerOpenError`、`getErrorCode`、`getErrorParams`、`attachErrorCode`、`normalizeRetry`、`DEFAULT_HTTP_RETRY`
- **类型导出**：`ReportSuccessOptions`、`ReportFailureOptions`、`HttpClientError`、`HttpRetryConfig`、`TaskEnv`、`TaskResult`、`LogEntry`、`LogLevel`

## 下一步

- [能力矩阵](capability-matrix)：与 py SDK 的差异逐条裁定
- [官方示例库](https://github.com/LuluDeer/AutoCodeFlow/tree/main/examples)
