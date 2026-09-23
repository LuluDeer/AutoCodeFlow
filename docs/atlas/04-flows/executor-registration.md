# 执行器注册 / 心跳 / 动态令牌 / 身份信任链

> 所属: docs/atlas/04-flows · 最后核对: 2026-09-23 · 对应代码: apps/admin-api/src/modules/executor/executor.service.ts、executor.controller.ts、executor-address-conflict.util.ts、executor-fingerprint.util.ts、apps/executor-node/src/middleware/auth.ts、startup-identity.ts、device-identity.ts

## 注册与令牌签发时序

```
 Executor                          admin-api (executor.controller.ts)                DB executors
    │                                        │                                          │
    │ ①POST /api/executors/register          │                                          │
    │   Authorization: Bearer <共享引导token> │ verifyExecutorToken                       │
    │   {appName,address,capabilities,       │ (common/utils/verify-executor-token.util.ts)│
    │    startupId,restartedAt,              │                                          │
    │    deviceFingerprint,...}              │                                          │
    │───────────────────────────────────────▶│ ExecutorService.registerExecutor (:575)  │
    │                                        │  ├─ observeAddressConflict（ARCH-34）      │
    │                                        │  ├─ observeDeviceFingerprint（ARCH-36）    │
    │                                        │  │   ↑ 两者都必须在 DB 写入**之前**        │
    │                                        │  ├─ register (:463)                       │
    │                                        │  │   新行: repo.create 白名单(F-7) ───────▶ INSERT status=ONLINE
    │                                        │  │   旧行+重启: failRunningExecutionsAfterRestart(:419)
    │                                        │  │            + runningTaskCount=0        │
    │                                        │  ├─ sameProcess = (startupId 相同 且 tokenHash 已存在)
    │                                        │  └─ rotateToken (:1556) 或复用            │
    │                                        │      randomBytes(32).hex → bcrypt cost12 ─▶ UPDATE tokenHash
    │◀─── { executor行, perExecutorToken|null, tokenHash } ─────────────────────────────┤
    │   perExecutorToken=null = 同进程幂等重注册（不轮换，防轮换风暴 N4）                  │
    │                                        │                                          │
    │ ②POST /api/executors/token（30 分钟刷新，到期前 5min；失败 30s 退避）                │
    │───────────────────────────────────────▶│ issueToken (:1614)：缓存内同 startupId 且  │
    │◀─── { token, tokenHash } 201           │ bcrypt 复核通过 → 返回当前 token；否则轮换  │
    │                                        │                                          │
    │ ③POST /api/executors/heartbeat（默认 30s）                                          │
    │───────────────────────────────────────▶│ validateTokenByAddress (:1715)：          │
    │   {cpuUsage,memUsage,runningTaskCount, │   per-executor bcrypt → 共享 token 兜底    │
    │    runningExecutionIds,deadLetterCount,│   （正结果缓存 60s，负结果不缓存 F-5）       │
    │    maxConcurrentTasks,startupId,       │ heartbeat (:676) 白名单采纳 → ONLINE/lastHeartbeat
    │    deviceFingerprint}                  │ + observeAddressConflict / observeDeviceFingerprint
    │◀─── { executor行, tokenHash 回显 }      │ （tokenHash 回显 R9/W3：执行器每次心跳采纳为 HMAC 源）│
```

## 关键代码锚点

| 环节 | 锚点 | 语义 |
|---|---|---|
| 路由 | `apps/admin-api/src/modules/executor/executor.controller.ts`（register/heartbeat/token/offline 均 `@Public()`，处理器内自行验签） | 机器面独立于人面 JWT |
| 注册幂等键 | `executor.service.ts:463` `register()` 按 address 查行 + `(address, startupId)` 进程生命身份（`apps/executor-node/src/startup-identity.ts` 生成） | 同 `(address,startupId)` 重注册不轮换 token（N4） |
| 重启检测 | `hasExecutorRestarted`（比较 `restartedAt`/`executorStartupId` 基线） | 命中即 `failRunningExecutionsAfterRestart`（:419，终态化 RUNNING 执行 + 释放槽位 + 按预算重试） |
| 字段白名单 | `executor.service.ts:488` 附近 F-7 注释块 | `repo.create` 显式字段——caller 永远写不了 `id/tokenHash/status/runningTaskCount/version` |
| 令牌轮换 | `executor.service.ts:1556` `rotateToken()` | `randomBytes(32).toString("hex")`，bcrypt cost 12 存 `tokenHash`（select:false 列），明文只在响应出现一次 |
| token 端点幂等 | `executor.service.ts:1614` `issueToken()` | 进程内 `issuedTokenCache`（TTL `TOKEN_ISSUE_CACHE_TTL_MS`）同 startupId 复用前仍 bcrypt 复核存量哈希——管理台手动轮换不会被旧缓存复活 |
| 校验 | `executor.service.ts:1715` `validateTokenByAddress()` | per-executor bcrypt → 失败回退共享 token（DB `executor.sharedToken` → env `EXECUTOR_SECRET`，timingSafeEqual）；正缓存 60s |
| 心跳采纳白名单 | `heartbeat()` :676 + `isAdoptableMaxConcurrentTasks`（E9，1..10000）/ `isAdoptableDeadLetterCount`（U16，0..100000）/ `runningExecutionIds` 逐项 `^[A-Za-z0-9_-]+$` 裁剪 200（CONSISTENCY-02） | 执行器上报面不可信，先过范围校验再落列 |
| 指纹冲突/漂移观测 | `executor-fingerprint.util.ts` `DeviceFingerprintTracker` + `executor.service.ts` `observeDeviceFingerprint()`（register/heartbeat 两处接线，共用**同一个** tracking 实例） | ARCH-36（ADR-017 阶段 2）：**纯内存、零 IO**（热路径，心跳 30s/台）。判据两方向——同 `address` 出现第二个不同指纹 = **硬冲突**（直证，非时序推断）→ ERROR + 通知 + 10min 按 `(address,fingerprint)` 节流；同一指纹换新 `address` = **地址漂移**（换网，正常）→ 仅 info。含 `stats()` 观测口径（`reportsWithFingerprint/reports` 覆盖率、`conflictRate`）。与 ARCH-34 的 `observeAddressConflict` **并存不互替**：后者不依赖新字段、对存量执行器仍有效，且覆盖「同机同 kind 同 workDir 两实例共享指纹」这种指纹判不出的形态 |
| 地址冲突观测 | `executor-address-conflict.util.ts` `ExecutorAddressConflictTracker` + `observeAddressConflict()` | ARCH-34 P0：判据是「**被顶替的**进程生命重新上报」（不是「同 address 不同 startupId」——后者是正常重启的形状） |
| 30 分钟轮换节奏 | `apps/executor-node/src/middleware/auth.ts`（python 对等 `auth.py`） | 到期前 5 分钟刷新；401 后 30s 退避重签 |

## 心跳字段语义速查

| 字段 | 必发 | 用途 |
|---|---|---|
| `address` | ✅ | 行定位键 |
| `cpuUsage`/`memUsage` | — | 评分（`executor-score.util.ts`）与指标历史 |
| `runningTaskCount` | — | 与 DB 占坑计数对账 |
| `runningExecutionIds` | **必须恒发**（空数组=空闲） | stale sweep 的"回调只是迟到"活性保护（CONSISTENCY-02）；缺失 = 旧版执行器，admin 跳过该保护 |
| `deadLetterCount` | — | 回调死信积压观测 |
| `maxConcurrentTasks` | — | 容量热更（仅 node，1..10000） |
| `startupId`/`restartedAt` | — | 重启检测基线 |
| `deviceFingerprint` | — | ARCH-36（ADR-017 阶段 2）：稳定设备身份 `sha256(deviceId:installSalt)`，64 位小写十六进制。**只采集与观测，不参与定位**；缺省/非法**不动 DB**（不是"置 NULL"）；用于「同址双指纹 = 硬冲突」告警与「同指纹换址 = 换网漂移」info 日志。协议 v3 起可用，v1/v2 执行器不发该字段则中台行为与引入前一致 |

## 失败分支与自愈

- **401 自愈**：per-executor token 校验失败（如 admin 侧手动 `POST /api/executors/:id/rotate-token`）→ 心跳/token 端点返回 401 → 执行器 30s 退避后调 `/api/executors/token` 重签；`/token` 端点本身持共享 token 可通行（共享 token 是机器面最后兜底）。node 侧 `middleware/auth.ts` 自动完成，无需重启。
- **心跳丢失判死**：`executor.service.ts:1492` `markStaleOffline()` `@Cron("*/30 * * * * *")`——`lastHeartbeat` 早于 `EXECUTOR_HEARTBEAT_INTERVAL × EXECUTOR_HEARTBEAT_TIMEOUT_MULTIPLIER`（默认 30s×3）的 ONLINE 行置 OFFLINE，逐台 emit `executor.offline` + `notifyExecutorOffline`。
- **执行器重启残留**：register/heartbeat 均做重启检测（双保险），失败 RUNNING 执行由 admin 侧终态化并按重试预算 re-enqueue，不依赖执行器自首。
- **优雅停机**：`POST /api/executors/offline`（`notifyOffline`）→ markOffline → emit `executor.offline`（三路翻转点之一，另两路是心跳 sweep 与管理台 `set-offline`）。
- **僵尸行清理**：`cleanupOfflineExecutors()` 每小时删 OFFLINE 超 7 天行；`detectLostExecutions()` 每 5 分钟核对执行器本地在跑与 DB RUNNING 差集。

## 相关配置项（环境变量）

| 变量 | 默认 | 作用 |
|---|---|---|
| `EXECUTOR_SECRET`（或 `EXECUTOR_SHARED_TOKEN`） | 空=开发态放行 | 机器面共享引导/兜底 token（`configuration.ts:176`） |
| `EXECUTOR_HEARTBEAT_INTERVAL` | 30000 | 心跳间隔 |
| `EXECUTOR_HEARTBEAT_TIMEOUT_MULTIPLIER` | 3 | 判死倍数 |
| `EXECUTOR_ADDRESS_PUBLIC` / `EXECUTOR_ADDRESS` | — | 注册回填的可达地址（`EXECUTOR_ADDRESS_PUBLIC || EXECUTOR_ADDRESS`） |

## 常见改动场景

- **改轮换时机**：动 `registerExecutor` 的 `sameProcess` 判定或 `issueToken` 缓存语义前，先理解 N4 轮换风暴背景；三方回调 HMAC 以 `tokenHash` 为源（N26），轮换会连带失效在跑任务的 `AUTOFLOW_CALLBACK_TOKEN`。
- **新增心跳字段**：entity 加列 + 迁移 + 白名单采纳（照抄 `isAdoptableMaxConcurrentTasks` 范围校验模式）+ [executor-contract](../01-apps/executor-contract.md) 字段表同步。
- **改判死灵敏度**：两个 env 之外还有 stale sweep 的 `STALE_LIVENESS_ABSOLUTE_FLOOR_MS`（30min）/`_MULTIPLIER`（6），见 [scheduler 模块](../01-apps/admin-api/modules/scheduler.md)。

## 相关文档

- [executor 模块](../01-apps/admin-api/modules/executor.md) · [executor 实体](../03-data/entities/executor.md)
- [执行器协议契约](../01-apps/executor-contract.md) · [executor-node 总览](../01-apps/executor-node/README.md)
- [任务全生命周期](task-lifecycle.md) · [安全模型](security-model.md)
