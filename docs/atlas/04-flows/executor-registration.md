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
    │───────────────────────────────────────▶│ validateTokenByAddress（指纹优先定位行，      │
    │   {cpuUsage,memUsage,runningTaskCount, │   address 兜底）：per-executor bcrypt →        │
    │    runningExecutionIds,deadLetterCount,│   共享 token 兜底（正结果缓存 60s，负不缓存 F-5）│
    │    maxConcurrentTasks,startupId,       │ heartbeat 白名单采纳 → ONLINE/lastHeartbeat    │
    │    deviceFingerprint}                  │ + observeAddressConflict / observeDeviceFingerprint
    │◀─── { executor行, tokenHash 回显 }      │ （tokenHash 回显 R9/W3：执行器每次心跳采纳为 HMAC 源）│
```

## 关键代码锚点

| 环节 | 锚点 | 语义 |
|---|---|---|
| 路由 | `apps/admin-api/src/modules/executor/executor.controller.ts`（register/heartbeat/token/offline 均 `@Public()`，处理器内自行验签） | 机器面独立于人面 JWT |
| 注册幂等键 | `executor.service.ts` `register()`：**ADR-017 阶段 3 起先按 `deviceFingerprint` 定位行**（稳定安装身份），`address` 兜底（legacy 执行器/采集失败）；命中即复用原行并更新 `address`（换 IP = 同机换地址，不产生新行）。进程生命身份 `(startupId)` 用于 token 幂等（N4） | 同 `(指纹,startupId)` 重注册不轮换 token；同地址不同指纹按派发模式分叉（push 409 / pull 各自成行；**push 409 的接管例外**：占位行已被 sweep 判 OFFLINE 且静默超 `EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS`（缺省 5min，`executor.addressTakeoverSilenceMs` 可覆盖）时，视为前一轮安装已遗弃该地址，允许新指纹接管复用该行——`canTakeOverAbandonedAddressRow`，P1-A 2026-10-25 容器重建指纹漂移死锁修复；判活行（ONLINE，或 OFFLINE 但静默未超窗）维持 409） |
| 重启检测 | `hasExecutorRestarted`（比较 `restartedAt`/`executorStartupId` 基线） | 命中即 `failRunningExecutionsAfterRestart`（终态化 RUNNING 执行 + 释放槽位 + 按预算重试）。**ADR-017 阶段 3 起匹配维度优先按行身份 `executorId`**（存量执行行 `executorId IS NULL` 时回落 `executorAddress`，行为与引入前一致）——地址在同址多行并存时不再唯一，纯按地址会把**另一台机器正在跑的健康执行**误判成 `EXECUTOR_RESTART` |
| 字段白名单 | `executor.service.ts:488` 附近 F-7 注释块 | `repo.create` 显式字段——caller 永远写不了 `id/tokenHash/status/runningTaskCount/version` |
| 令牌轮换 | `executor.service.ts:1556` `rotateToken()` | `randomBytes(32).toString("hex")`，bcrypt cost 12 存 `tokenHash`（select:false 列），明文只在响应出现一次 |
| token 端点幂等 | `executor.service.ts:1614` `issueToken()` | 进程内 `issuedTokenCache`（TTL `TOKEN_ISSUE_CACHE_TTL_MS`）同 startupId 复用前仍 bcrypt 复核存量哈希——管理台手动轮换不会被旧缓存复活 |
| 校验 | `executor.service.ts` `validateTokenByAddress(address, token, deviceFingerprint?)` | per-executor bcrypt → 失败回退共享 token（DB `executor.sharedToken` → env `EXECUTOR_SECRET`，timingSafeEqual）；正缓存 60s。**ADR-017 阶段 3 起指纹优先定位**：机器面统一走 `resolveExecutorRow()`（指纹优先；地址命中多行且本次无指纹 → **fail-closed** 拒绝，绝不任取一行）；只做凭据校验、不定位行的面（回调/产物上传）用 `validateTokenByAddressAnyRow` 逐候选试 |
| 槽位冲销 | `block-strategy-gate.ts` `releaseExecutorSlotByAddress`（executor/scheduler/task 三处共用） | **单条原子语句**：`UPDATE executors SET runningTaskCount = GREATEST(…-1,0) WHERE id = (SELECT id FROM executors WHERE address = :addr)`——地址唯一性判定与冲销同一语句求值（无 TOCTOU、不给回调主链新增可抛错往返）；子查询多行时 PG 报错（**刻意不盲减别人的计数**）。调用方持有 `executorId` 时走无歧义的 `releaseExecutorSlotById` |
| 心跳采纳白名单 | `heartbeat()` :676 + `isAdoptableMaxConcurrentTasks`（E9，1..10000）/ `isAdoptableDeadLetterCount`（U16，0..100000）/ `runningExecutionIds` 逐项 `^[A-Za-z0-9_-]+$` 裁剪 10000（CONSISTENCY-02 / NETOPT-C P2-1） | 执行器上报面不可信，先过范围校验再落列 |
| 指纹冲突/漂移观测 | `executor-fingerprint.util.ts` `DeviceFingerprintTracker` + `executor.service.ts` `observeDeviceFingerprint()`（register/heartbeat 两处接线，共用**同一个** tracking 实例） | ARCH-36（ADR-017 阶段 2）+ 阶段 3 提升：**纯内存、零 IO**（热路径，心跳 30s/台）。判据两方向——同 `address` 出现第二个不同指纹 = **硬冲突**（直证，非时序推断）→ ERROR + 通知 + 10min 按 `(address,fingerprint)` 节流；同一指纹换新 `address` = **地址漂移**（换网，正常）→ 仅 info。**阶段 3 起指纹还是 register/heartbeat 的定位键**，冲突从「观测告警」升级为「push 模式注册 409 拒绝 / pull 模式各自成行」（ADR-017 §4/§5）。与 ARCH-34 的 `observeAddressConflict` **并存不互替**：后者不依赖新字段、对存量执行器仍有效，且覆盖「同机同 kind 同 workDir 两实例共享指纹」这种指纹判不出的形态 |
| 地址冲突观测 | `executor-address-conflict.util.ts` `ExecutorAddressConflictTracker` + `observeAddressConflict()` | ARCH-34 P0：判据是「**被顶替的**进程生命重新上报」（不是「同 address 不同 startupId」——后者是正常重启的形状） |
| 30 分钟轮换节奏 | `apps/executor-node/src/middleware/auth.ts`（python 对等 `auth.py`） | 到期前 5 分钟刷新；401 后 30s 退避重签 |

## 心跳字段语义速查

| 字段 | 必发 | 用途 |
|---|---|---|
| `address` | ✅ | **ADR-017 阶段 3 起为可达性元数据**（行定位键是 `deviceFingerprint`）；仅 legacy（未上报指纹）执行器仍按它定位。push 模式行间唯一（partial 索引），pull 允许重复 |
| `cpuUsage`/`memUsage` | — | 评分（`executor-score.util.ts`）与指标历史 |
| `runningTaskCount` | — | 与 DB 占坑计数对账 |
| `runningExecutionIds` | **必须恒发**（空数组=空闲） | stale sweep 的"回调只是迟到"活性保护（CONSISTENCY-02）；缺失 = 旧版执行器，admin 跳过该保护 |
| `deadLetterCount` | — | 回调死信积压观测 |
| `maxConcurrentTasks` | — | 容量热更（仅 node，1..10000） |
| `startupId`/`restartedAt` | — | 重启检测基线 |
| `deviceFingerprint` | —（协议 v3 起建议发） | **ADR-017 阶段 3 起是注册/心跳的行定位键**：`sha256(deviceId:installSalt)` 64 位小写十六进制。命中即复用原行 + 更新 address（换 IP 不产生幽灵行）。缺省/非法 → 走 legacy（`legacy:{address}` 兜底键），行为与引入前一致；同地址不同指纹按派发模式分叉（push 409 / pull 各自成行；**push 409 的接管例外**：占位行已被 sweep 判 OFFLINE 且静默超 `EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS`（缺省 5min，`executor.addressTakeoverSilenceMs` 可覆盖）时，视为前一轮安装已遗弃该地址，允许新指纹接管复用该行——`canTakeOverAbandonedAddressRow`，P1-A 2026-10-25 容器重建指纹漂移死锁修复；判活行（ONLINE，或 OFFLINE 但静默未超窗）维持 409） |

### 回调面的行身份（协议 v6，ADR-017 阶段 3 方案 C）

执行器 → 中台的**终态回调**（`POST /executions/callback`）同样可选携带 `deviceFingerprint`（协议 v6 起，三端同批）：

| 层级 | 判据 | 覆盖的令牌形态 |
|---|---|---|
| ① `deviceFingerprint` → 行 | 回调自报指纹，服务端查库解析行 id（按 **executionId** 分键） | **所有**（含共享/legacy token） |
| ② 凭据归属行 | presented token 的 bcrypt 命中行（`resolveCredentialExecutorId`） | 仅 per-executor 令牌 |
| ③ 地址相等 | `executorAddress` 相等 | legacy 兜底 |

拿到行身份后要求 `row === task_executions.executorId`，不一致即拒（`executor_identity_mismatch`）。三级都拿不到 → 只走 ③，行为与引入前逐字节一致。

- **为什么需要 ①**：共享/legacy token 是**全机队单一密钥、不绑定任何行**，② 对它恒为 null；而 pull 模式允许同址多行并存（ADR-017 §5），③ 的「地址相等」在同址下恒真、无法区分行——① 用执行器自报的稳定安装身份补上这一层。
- **安全边界（如实）**：指纹是**自报**值且随执行器列表对任何登录用户可见，与 `executorAddress` 同等可探知，故 ① **不提升对抗"已持共享令牌"攻击者的强度**（该强度上限由"共享令牌是全机队单一密钥"决定，属独立议题）。它解决的是**诚实执行器的归属**：同址第二台如实上报自己的指纹，admin 据此与派发目标正确区分，而不是靠"地址碰巧相等"误判成功。
- **按 executionId 分键（易错点）**：同批次里可以有两个**同址但不同行**的执行（ADR-017 §5），各自上报自己的指纹。指纹映射必须按 `executionId` 分键，且解析要发生在批次地址去重守卫**之前**——按 address 分键会把第二条判到第一条的行上，**误拒合法回调**（本轮实测发现并修掉的自身缺陷，已补控制器级反证）。
- **兼容性红线**：字段**可选**，缺省时逐级回落，**绝不因缺该字段拒绝合法回调**（旧执行器、采集失败、经 SDK 直接回调的任务代码都可能不带）。

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
