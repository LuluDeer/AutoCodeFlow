# 执行回调 / 日志 / 产物上报

> 所属: docs/atlas/04-flows · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/task/execution-callback.controller.ts、execution-callback-token.util.ts、task.service.ts、log-storage/s3-log-storage.ts、apps/admin-api/src/modules/artifacts、apps/executor-node/src/callback.ts

## 回调主时序（含三层 secret 解析）

```
 Executor(task-worker)            admin-api                                           DB / 存储
    │                                  │                                                 │
    │ collectTerminalArtifacts          │                                                 │
    │  PUT /api/executions/:id/artifacts/:name?sha256=<hex> (artifacts.controller.ts:51)  │
    │─────────────────────────────────▶│ Bearer 执行器 token → artifacts.service.saveArtifact(:105)
    │                                  │ 原子写 uploads/artifacts/<execId>/<name>（≤20 个/单个 ≤100MB）
    │ pushCallback → 批线程（1s 取批，批≤100，同 executionId 覆盖去重，恒补 executorAddress）
    │                                  │                                                 │
    │ POST /api/executions/callback    │                                                 │
    │ Authorization: Bearer <token>    │ ParseArrayPipe(CallbackItemDto)（>100 整批 400，空批 400）│
    │─────────────────────────────────▶│ ┌─ token 以 "v1." 开头？                          │
    │                                  │ │  verifyPerExecutionCallbackToken(:236)：        │
    │                                  │ │  ① resolveCallbackSecrets(:318)：              │
    │                                  │ │     EXECUTION_CALLBACK_SECRET → DB executor.sharedToken
    │                                  │ │     → env executor.sharedToken                 │
    │                                  │ │  ② 全落空 → verifyAgainstPerExecutorSecrets(:297)
    │                                  │ │     逐地址取 tokenHash 作为 HMAC key（N26）      │
    │                                  │ │  ③ 过期/坏签名 401（N32 分类计数）；每个 item 的    │
    │                                  │ │     executionId 必须等于 token 绑定 id（绑定不匹配 401）│
    │                                  │ └─ 否则逐地址 validateTokenByAddress；共享 token 兜底仅限
    │                                  │    批内单一地址（TASK-001）                        │
    │                                  │ handleCallback (task.service.ts:1825) 逐 item：    │
    │                                  │  ① 行存在性 → 不存在记 not_found                   │
    │                                  │  ② executorAddress 与行比对 → mismatch 拒绝        │
    │                                  │  ③ 终态条件 UPDATE ... WHERE status IN (pending,running)
    │                                  │     RETURNING executorAddress ──────────────────▶ task_executions
    │◀─ { results:[{executionId,success,error?}] }（恒 200，逐条回执）                     │
    │                                  │  winner：releaseExecutorSlot → emitTerminalEvent →
    │                                  │  kill_retry(SUCCESS 扇出在后续步) → storeLogLines  │
```

## 回调 token 格式（三方钉死，N23）

```
v1.<executionId>.<expiresAtUnixSec>.<hmacHex>
key     = HMAC-SHA256(secret, "autocodeflow:execution-callback:v1")   ← 域分离
hmacHex = HMAC-SHA256(key, "v1.<executionId>.<expiresAtUnixSec>")
```

- 算法三处共享同一测试向量：admin `execution-callback-token.util.ts`、node `apps/executor-node/src/execution-callback-token.ts`、python `apps/executor-python/.../execution_callback_token.py`——单侧改动即红测试。
- 令牌只授权**恰好一个 executionId**，过期 fail-closed；执行器以 `tokenHash`（注册时下发的 per-executor 令牌哈希原文）为签名 secret 注入任务子进程 env `AUTOFLOW_CALLBACK_TOKEN`，任务代码永不接触共享 token（SEC-01）。
- TTL = timeout+900s（不限时任务取 31536000s）——见 [executor-node 执行管线](../01-apps/executor-node/execution-pipeline.md)。

## 日志双通道与分区表

```
cb.logs ──▶ LOG_TRUNCATION_MARKER 命中（执行器截到 ~10KB）?
              ├─ 是 → backfillFullLogsFromExecutor（task.service.ts:1570 附近）
              │        GET http://<addr>/api/logs/:execId?fromLine&limit=2000 分页回捞，失败回退截断日志
              └─ 否 → storeLogLines (task.service.ts:1484)
                       ├─ LOG_STORAGE_DRIVER=s3：gzipSync → S3LogStorage.put（objectKey execution-logs/<execId>.log.gz，
                       │   解压上限 MAX_LOG_BYTES=100MB，s3-log-storage.ts:21/:62/:81）；执行行 logStorage='s3' 存指针
                       │   S3 失败 → 回退 DB 行并收回指针 logStorage='db'（BUG-06）
                       └─ db：execution_log_lines 分区表逐行（lineNumber+level 复合索引，level 由 log-level.util.ts 文本推断）
读取：GET /api/tasks/executions/:execId/logs（fromLine/limit≤2000/level SQL 下推）；SSE /logs/stream
```

## 重复回调幂等语义

- 终态条件 UPDATE `affected=0` = 已终态（重复回调或与 worker finally 赛跑）：直接返回 `success:true`，**不重复释放槽位**（首个 winner 已释放），计 `duplicate`。
- 例外闭环：若上次 winner 在 `storeLogLines` 抛错导致日志未落库，重复回调经 `persistCallbackLogsIfMissing` 补写日志再返回（task.service.ts:1764 附近）。
- winner 计数恰好一次：`autoflow_callback_business_total`（not_found/address_mismatch/accepted/duplicate/error）+ `autoflow_execution_result_total`（仅 winner 记）。
- 产物清单 `artifacts` 仅在回调携带非空清单时写入——重复/兜底回调不会擦除已有清单。

## 失败分支与自愈

- **执行器侧重试**：`apps/executor-node/src/callback.ts` 每批最多 5 次指数退避 → 落盘 `WORK_DIR/callbacks/callback-*.json` → 重发 ≤5 轮 → `dead-letter/`（python 对等）。死信积压经心跳 `deadLetterCount` 上报观测。
- **日志超限回捞**：LOG-01 分页推进依赖执行器响应 `{lines,totalLines,hasMore}`。
- **整批被 DTO 拒绝**：任一字段超限（logs ≤512000 字符、errorMessage ≤4096、批 ≤100）→ 400 整批——执行器侧已按上限预截断（logs 头尾各 5KB）。
- **401 分类观测**：`execution-callback-metrics.service.ts`（missing_token/bad_address/legacy_shared_invalid/v1_expired/v1_bad_signature/v1_binding_mismatch/ok），排查回调 401 先看该指标。

## 相关配置项（环境变量）

| 变量 | 默认 | 作用 |
|---|---|---|
| `EXECUTION_CALLBACK_SECRET` | 空（回退共享 token） | v1 token 的首选 HMAC secret（`configuration.ts:213`） |
| `THROTTLE_CALLBACK_LIMIT` / `THROTTLE_CALLBACK_TTL` | 60 / 60000 | 回调限流（per IP，NAT 部署需调高） |
| `LOG_STORAGE_DRIVER` / `LOG_STORAGE_*` | db | 日志双通道开关与 S3/MinIO 连接 |
| `ARTIFACT_*`（目录覆写） | `uploads/artifacts` | 产物落盘根（`artifacts.constants.ts:21`） |

## 常见改动场景

- **改 `CallbackItemDto` 字段**：必须与执行器 `CallbackRequest`（node callback.ts / python）逐字段同步，并复核执行器预截断值；超限即整批 400。
- **改 HMAC 算法/前缀**：三端共享测试向量，必须同轮改 + 对齐测试向量；且考虑在跑任务手中旧 token 的过渡期。
- **换日志后端**：实现 `S3LogStorage` 同接口（put/getStream/remove/objectKey），保留"失败回退 DB + 指针收回"语义。

## 相关文档

- [task 模块](../01-apps/admin-api/modules/task.md) · [artifacts 模块](../01-apps/admin-api/modules/artifacts.md) · [execution-log-line 实体](../03-data/entities/execution-log-line.md)
- [执行器协议契约](../01-apps/executor-contract.md)（CallbackItemDto 双向字段表）
- [executor-node 执行管线](../01-apps/executor-node/execution-pipeline.md) · [任务全生命周期](task-lifecycle.md) · [安全模型](security-model.md)
