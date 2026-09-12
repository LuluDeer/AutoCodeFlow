# autocodeflow-node-sdk — Node.js/TypeScript SDK

> 所属: docs/atlas/02-packages · 最后核对: 2026-09-13 · 对应代码: packages/autocodeflow-node-sdk

## 职责

npm 包 `@autocodeflow/sdk`（v1.2.0，scoped 公开发布，`publishConfig.access=public`）：Node/TS 版任务运行时基础件，是 Python SDK（autoflow-sdk）的**镜像实现**（ECO-01 能力矩阵逐项对齐）——给跑在 executor-node 上的任务脚本提供 TaskContext、结构化日志与 admin-api 回调客户端。

依赖（package.json 核实）：运行时仅 `axios ^1.6.0`；构建用 `tsup`（`--format cjs,esm --dts`，双格式 + 类型）；engines `node>=20`。测试 jest（根目录 `npm run test:node-sdk`，typecheck 走 `npm run typecheck:node-sdk`）。

## 目录结构与关键文件

```
packages/autocodeflow-node-sdk/
├── package.json          name @autocodeflow/sdk, main dist/index.js, module dist/index.mjs
├── src/
│   ├── index.ts          唯一出口（下面"公开 API 面"全部经此导出）
│   ├── context.ts        TaskContext + 字段上限常量（ECO-01）
│   ├── http-client.ts    HttpClient（axios 封装：Bearer/X-Trace-Id/信封拆包/executorAddress 盖章）
│   ├── logger.ts         TaskLogger（debug/info/warn/error/getLogs）
│   ├── types.ts          TaskEnv / TaskResult / LogEntry / LogLevel
│   └── __tests__/        context / http-client / logger / contract（契约向量）
```

## 公开 API 面（src/index.ts 核实）

```ts
export { TaskContext } from './context';
export type { ReportSuccessOptions, ReportFailureOptions } from './context';
export { ERROR_MESSAGE_MAX_LENGTH, LOGS_MAX_LENGTH } from './context';
export { TaskLogger } from './logger';
export { HttpClient } from './http-client';
export type { TaskEnv, TaskResult, LogEntry, LogLevel } from './types';
```

### TaskContext（context.ts）

- `TaskContext.fromEnv()`：必需 `EXECUTION_ID` / `TASK_ID` / `TASK_NAME`（缺则 throw）。回调凭证解析优先级：legacy `ADMIN_API_URL`/`EXECUTOR_TOKEN` > executor 注入的 `AUTOFLOW_ADMIN_API_URL`/`AUTOFLOW_CALLBACK_TOKEN`（N23）；另取 `AUTOFLOW_EXECUTOR_ADDRESS`（N27）与 `TRACE_ID`。
- `TaskContext.create(env)`：显式构造（测试/非标注入用）。
- 结果构建：`success(message?, output?)` / `failure(message?, output?)` → `TaskResult`，自动附带 `logger.getLogs()` 收集的结构化日志。
- 回调快捷：`reportSuccess({summary?, durationMs?})` / `reportFailure(error, {summary?, durationMs?, failureReason='script_error'})` → `POST /api/executions/callback`；`error` 经 `stringifyError`（Error 取 message、对象走 JSON）截断到 `ERROR_MESSAGE_MAX_LENGTH = 4096`，summary 截断到 `LOGS_MAX_LENGTH = 512_000`（与 admin-api CallbackItemDto 上限一致）。
- 便捷 getter：`executionId` / `taskId` / `taskName` / `executorAddress`。

### HttpClient（http-client.ts）

- `new HttpClient(baseURL?, token?, traceId?, executorAddress?)`；`TaskContext.fromEnv()` 经 `HttpClient.forAdminApi(env)` 构建。
- **enabled 降级语义**（N23，与 Python SDK 对齐）：`baseURL`+`token` 齐备才 `enabled`；禁用时任何请求方法抛出带 `disabledReason` 的清晰错误——构造不失败，fail-closed 在请求时。
- 请求拦截器：自动 `Authorization: Bearer`、有 traceId 时 `X-Trace-Id`；默认 10s 超时（与 Python SDK 一致）。
- 响应侧：错误时把信封内 `message` 追加进 axios 错误文案；成功时**自动拆 `{code,message,data}` 信封**（U14）。
- 对 `/api/executions/callback` 的 `post` 自动为缺失 `executorAddress` 的回调项盖章（N27），任务代码无需硬编码执行器地址。

### TaskLogger

`debug/info/warn/error(message, meta?)` 收集结构化 `LogEntry`，`getLogs()` 随 TaskResult 一并回传给执行器。

## 与 autoflow-sdk 的能力对齐

| 能力 | Node | Python |
|---|---|---|
| 上下文构造 | `TaskContext.fromEnv()/create()` | `TaskContext.from_env()` / 构造器 |
| 成功/失败上报 | `reportSuccess/reportFailure` | `report_success/report_failure` |
| 错误/日志截断 | 4096 / 512000（同名常量） | 4096 / 512000（同值常量） |
| 客户端禁用降级 | `http.enabled` + `disabledReason` | `callback.enabled` + `disabled_reason` |
| failureReason 校验 | 薄客户端，交 admin DTO 校验 | **客户端白名单校验，非法值 raise ValueError**（刻意分歧，见 docs/sdk-guide.md） |
| executorAddress | 自动盖章（N27） | 自动盖章（N27） |

## 与其他组件的关系

- **被依赖**：apps/executor-node 下发的 Node 任务脚本是主要消费者（执行器注入 `EXECUTION_ID` 与 `AUTOFLOW_*` 凭证）；用户也可在自己的 Node 项目里安装。
- **回调契约源头**：admin-api 的 [execution-callback DTO](../04-flows/execution-callback.md)；契约行为由 [contract-fixtures](contract-fixtures.md) 的 `src/__tests__/contract.test.ts` 锁定。
- **发布**：lockstep 三包之一，version-guard 守卫 `package.json` 的 version；构建产物 `dist/`（cjs+esm+dts）。
- docs-site 的 Node SDK 页面重组自本包 README（[docs-site](docs-site.md)）。

## 常见改动场景

**如何加一个 SDK 方法**：先在 [autoflow-sdk](autoflow-sdk.md) 侧确认镜像语义（或同步新增，见 [扩展 SDK 能力](../08-workflows/add-new-sdk-capability.md)）→ 在 `src/` 对应模块实现 → `src/index.ts` 导出 → `__tests__/` 补 jest → 若涉回调字段，同步 contract-fixtures append-only 向量 → 三包 lockstep bump 版本。

## 相关文档

- [包生态总览](README.md) · [Python SDK 镜像](autoflow-sdk.md)
- [executor-node](../01-apps/executor-node/README.md) · [Node SDK 接口地图](../05-interfaces/sdks.md)
