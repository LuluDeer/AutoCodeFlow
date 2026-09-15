# 执行器 ↔ admin-api 协议契约
> 所属: docs/atlas/01-apps · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/executor/executor.controller.ts、apps/admin-api/src/modules/task/execution-callback.controller.ts 与 dto/execution-callback.dto.ts、apps/executor-node/src（admin-client.ts/callback.ts/main.ts）、apps/executor-python（main.py/routers/execute.py/scheduler.py）

本文是执行器（node/python/desktop 内核）与 admin-api 之间机器接口的**双向核实字段表**：左侧为字段，"发送方/接收方"标注实现位置。全局前缀 `/api`；admin 响应恒为 `{code, message, data}` 信封（执行器侧 `unwrapAdminResponseData` / `_unwrap_envelope` 解包）。

## 1. 注册（执行器 → admin）：POST /api/executors/register

- 鉴权：`@Public()` + 共享引导 token（`Authorization: Bearer`，`verifyExecutorToken`）。执行器侧用**静态 token** 发送（node `postWithStaticToken`；python `get_static_token`——动态 token 会被 401 拒绝）。
- 幂等：同 `(address, startupId)` 重复注册不轮换 token（N4），只按白名单更新元数据。

| 字段 | 类型 | 必填 | 发送方 |
|---|---|---|---|
| `appName` | string | ✅ | node `config.appName` / python `settings.app_name` |
| `address` | string | ✅ | `EXECUTOR_ADDRESS_PUBLIC || EXECUTOR_ADDRESS` |
| `type` | `"node"` / `"python"` | — | 硬编码 |
| `version` | string（`1.0.0`） | — | 硬编码 |
| `capabilities` | string[] | — | node：探测 `[shell,node,python?]`；python：`['python','shell']` |
| `runtime` | string[] | — | 仅 node 发送（同 capabilities 探测值） |
| `maxConcurrentTasks` / `maxConcurrent` | number | — | node 发 `maxConcurrent`；python 发 `maxConcurrentTasks` |
| `groupName` / `tags` / `description` | string / string[] | — | node 发 groupName；tags/description 仅 admin Swagger 示例可见，两个执行器均未发送 |
| `restartedAt` / `startupId` | string | — | 进程生命身份（startup-identity.ts / startup_identity.py） |

- 响应 `data`：执行器行（id/appName/address/status/…）+ `perExecutorToken`（新注册/重启时轮换，否则 null）+ `tokenHash`（N26，执行器采纳为回调令牌 HMAC 源）。

## 2. 动态令牌（执行器 → admin）：POST /api/executors/token

- 鉴权：`@Public()` + 共享 token。响应 201：`{ token, tokenHash }`。
- 请求体：`{ address, appName?, startupId? }`（node/python 均带 startupId）。
- 语义：`issueToken()` 按 `(address, startupId)` 幂等——同进程重取返回**当前** token；轮换只发生在首次签发、新 startupId（重启）或存量哈希失配。执行器侧 30 分钟刷新（到期前 5 分钟）、失败 30s 退避（node `middleware/auth.ts`；python `auth.py` 对等实现）。

## 3. 心跳（执行器 → admin）：POST /api/executors/heartbeat

- 鉴权：`@Public()` + per-executor 动态 token 或共享 token（`validateTokenByAddress`）；无效 401。
- 间隔：默认 30s（admin 侧注释 `EXECUTOR_HEARTBEAT_INTERVAL` 默认 30s = 2 次/分/执行器；连续 3 次未收到判 OFFLINE）。

| 字段 | 类型 | 发送方 |
|---|---|---|
| `address` | string | ✅ 两者 |
| `cpuUsage` / `memUsage` | number | node：os 采样（CPU 500ms 差分）；python：psutil |
| `runningTaskCount` | number | 运行计数（node Atomics / python 锁内计数） |
| `runningExecutionIds` | string[]（≤200） | 两者（STALE-01/E1：**必须恒发送**，空数组=空闲；admin 据此做"回调只是迟到"的活性保护） |
| `deadLetterCount` | number | 两者（落盘回调死信积压） |
| `maxConcurrentTasks` | number | 仅 node（E9：热更容量随心跳上报，1..10000 校验在 admin service） |
| `diskUsage` / `networkLatency` / `totalTaskCount` / `failedTaskCount` | number | admin DTO 支持但执行器未发送（diskUsage 仅 node `/health` 本地返回） |
| `restartedAt` / `startupId` | string | 两者 |

- 响应 `data`：心跳后的执行器行 + `tokenHash` 回显（R9/W3：执行器每次心跳采纳，保持回调令牌密钥与 admin 侧轮换同步）。

## 4. 下线通知（执行器 → admin）：POST /api/executors/offline

请求 `{ address }`，鉴权同心跳；响应 `{ success: true }`。优雅停机最后一步调用（node main.ts `notifyOffline` / python main.py `notify_offline`）。

## 5. 任务派发（admin → 执行器）：POST http://<executorAddress>/api/execute

- 调用方：admin `ExecutorService.dispatchExecution / dispatchBroadcast`（HTTP 超时 `(task.timeout || 300) + 10` 秒；`assertSafeExecutorUrl` SSRF 前置）。
- 鉴权：`Authorization: Bearer <共享 token>`；`traceparent` 头（admin OTEL 开启时注入，执行器 fail-open 读取）。
- 请求体：`{ executionId, task, params }`。`task` 关键字段（TaskPayload / CreateTask DTO 对齐）：

| task 字段 | 说明 |
|---|---|
| `id` / `name` | 任务标识（per-task 串行与 venv/.node_modules 目录名来源） |
| `runtime` | `node` / `python` / `shell`（缺省 node/python 各自默认） |
| `entrypoint` | node 缺省 `index.js`；python 缺省 `main.py` |
| `timeout` | 秒；`0`=不限时（node），python 侧夹取 1..86400 |
| `requirements` | 依赖清单（node→npm，python→uv pip；glue 任务强制清空） |
| `gitRepo` / `gitCommit` / `gitBranch` | git 载体（缺省 ref：commit > branch > `main`） |
| `glueSource` / `glueLanguage` | 内联脚本（`javascript`/`python`/`shell`；snake_case 别名兼容） |

- 执行器响应：`{ status: 'accepted', executionId }`（python 额外 `executorAddress`）；同步校验失败 400；容量满 `429 {error:'Executor is at capacity'}`；重复领取 400。

## 6. 终止（admin → 执行器）：POST http://<addr>/api/executions/:executionId/kill

admin 侧 `notifyExecutorKill`：共享 token、空请求体、3s 超时、best-effort（失败仅 warn）。执行器：200 `{ok:true}`（已终止/已结束/已取消）或 404 `{ok:false}`（不在运行表）。

## 7. 配置热更（admin → 执行器）：POST http://<addr>/api/config/reload

admin 入口 `POST /api/executors/:id/reload-config`（ADMIN-only，R11：重用当前动态 token 而非轮换；401 最多重签重试一次）。推送体：`{ maxConcurrentTasks?, taskTimeoutSeconds?, heartbeatIntervalSeconds?, adminApiUrl?, adminApiUrlInternal?, adminApiUrlExternal? }`；node 额外接受 `adminApiUrls` 与 `workDir/WORK_DIR`（热切换带绝对路径/symlink/运行中执行守卫）；python 侧 `heartbeatIntervalSeconds` 校验 ≥5。两侧请求在数值下界手检之后、任何写入之前还过一道**生成的** `ConfigReloadRequest` 协议闸门（兜手检抓不到的类型/形状错误；python 用 `strict=True` 以与 zod 一致、不做字符串→数字强转）。响应（字段名以 executor-protocol 为准，snake_case，两侧一致）：`{ success, message, updated_fields, ignored_fields }`，出参均经生成的 `ConfigReloadResponse` 校验后才发送；`ignored_fields` 显式回报请求里本端不认识的键，不静默成功。

## 8. 终态回调（执行器 → admin）：POST /api/executions/callback

- 鉴权（三选一）：① 执行器 per-executor/共享 token（Bearer，`verifyExecutorToken`）；② 每执行一次性令牌 `Authorization: Bearer v1.<executionId>.<expiresAt>.<hmac>`（N23，HMAC 校验限定本批 executionId，过期 401）；③ 兼容头 `X-Executor-Token`（node admin-client 恒随发）。
- 限流：默认 60 次/分/IP（`THROTTLE_CALLBACK_LIMIT/TTL` 可调）。
- 批量：`CallbackItemDto[]`，**>100 条整批 400**，空批 400（执行器侧按 100 切批）。
- 响应：`{ results: [{ executionId, success, error? }] }`（逐条处理结果，如 "Execution not found"）。

CallbackItemDto 字段（apps/admin-api/src/modules/task/dto/execution-callback.dto.ts，执行器 `CallbackRequest`/payload 与之一一对应）：

| 字段 | 校验 | 说明 |
|---|---|---|
| `executionId` | UUID v4，必填 | 执行 ID |
| `status` | `success` \| `failed`，必填 | 终态 |
| `executorAddress` | 可选 string | per-address token 校验/审计（node/python 恒补齐） |
| `exitCode` | 可选 int | 进程退出码 |
| `logs` | 可选，≤512000 字符 | 原始日志（执行器侧先截到 ~10k，超限触发 admin LOG-01 全量回捞） |
| `errorMessage` | 可选，≤4096 字符 | 失败信息（执行器截到 4000） |
| `failureReason` | 可选，enum | `package_fetch_failed` / `dependency_install_failed` / `git_fetch_failed` / `runtime_missing` / `script_error` / `timeout` / `executor_offline` / `executor_restart` / `killed` / `unknown` |
| `durationMs` | 可选 int ≥0 | 墙钟耗时 |
| `artifacts` | 可选，≤20 项 | `[{name, size, sha256}]`；name 匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$`，sha256 为 64 位十六进制 |
| `traceparent` | 非 DTO 字段 | node 放在回调头回传（OBS-01）；python 放头，载荷字段被 DTO whitelist 剥离 |

## 9. 产物上传（执行器 → admin）：PUT /api/executions/:execId/artifacts/:name

- 实现：admin `artifacts.controller.ts`（multipart，落 `uploads/artifacts/<execId>/<name>`）；查询串带 `?sha256=<hex>`。
- 鉴权：Bearer 执行器 token（node `artifacts.ts uploadOne` / python `artifacts.py` 同一 token 链）。
- 下载（人/前端侧）：`GET /api/tasks/executions/:execId/artifacts/:name`（流式）。

## 10. 日志回捞（admin → 执行器）：GET http://<addr>/api/logs/:executionId?fromLine=&limit=

admin LOG-01 触发：`limit=2000` 分页推进，依赖 `hasMore`。执行器响应 `{ lines: string[], totalLines: number, hasMore: boolean }`（node 流式逐行；python 全量读后切片）。executionId 均做路径穿越防护。

## 兼容性红线（改动前必读）

1. `CallbackItemDto` 任一字段超限 → **整批**被 ParseArrayPipe 拒绝；执行器侧已按 DTO 上限预截断（logs 10k / errorMessage 4000 / 批 100）。
2. 心跳缺省 `runningExecutionIds` = 旧版执行器语义，admin 会跳过 prepare 期活性保护——字段可以短，不能省。
3. 回调令牌算法三方钉死（node `execution-callback-token.ts`、python `execution_callback_token.py`、admin `execution-callback-token.util.ts` 共享同一测试向量），单侧改动即红测试。
4. 派发响应必须是 2xx + `{status:'accepted'}` 形态；admin 把非 2xx 视为派发失败并回滚容量占坑。

## 相关文档

- [执行器注册流程](../04-flows/executor-registration.md) · [回调上报](../04-flows/execution-callback.md) · [任务生命周期](../04-flows/task-lifecycle.md)
- [admin-api executor 模块](admin-api/modules/executor.md) · [admin-api artifacts 模块](admin-api/modules/artifacts.md)
- [executor-node 执行管线](executor-node/execution-pipeline.md) · [三种执行器对比](executors-comparison.md)
