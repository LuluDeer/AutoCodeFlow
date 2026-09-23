# executor 模块 — 执行器注册 / 心跳 / 派发 / 身份

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-23 · 对应代码: apps/admin-api/src/modules/executor

## 职责

执行器机群的管理面与派发面：注册（含 per-executor token 签发）、心跳采集、在线状态维护（stale offline / 优雅停机）、任务派发选址（过滤 + 负载评分 + 容量占坑）、token 轮换与校验、安装命令下发。是 admin-api 与三种执行器之间的信任锚点。

## 目录结构与关键文件

```
modules/executor/
├── executor.module.ts              装配；export ExecutorService（task/scheduler/artifacts 共用）
├── executor.controller.ts          @Controller("executors") 全部路由
├── executor.service.ts             核心服务（约 4200 行：register/heartbeat/dispatch/token）
├── executor-score.util.ts          computeExecutorLoadScore（CORE-05 加权评分）
├── executor-address-conflict.util.ts    ARCH-34 P0：address 冲突跟踪器（进程生命时序判据）
├── executor-deployment-affinity.util.ts ARCH-35 P1：部署归属偏好分区（partitionByDeploymentAffinity）
├── executor-fingerprint.util.ts         ARCH-36：deviceFingerprint 校验 + 冲突/漂移观测
├── install-script.content.ts       install.sh 单一事实源（与仓库根 scripts/install.sh 互为拷贝）
├── entities/executor.entity.ts     executors 表（address 唯一索引）
└── entities/executor-metrics-history.entity.ts  心跳指标历史
```

三个 util 均为**纯内存、零 IO、有界**的观测/决策辅助，状态放在 `ExecutorService` 的**实例字段**
（Nest provider 单例）而非模块级单例——模块级可变状态会跨测试文件泄漏（仓库已有
`__resetTruncationWarnStateForTest` 的前科）。

## 路由（controller 前缀 `executors`，实际路径 `/api/executors`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/register` | `@Public()` | 注册/重注册；同一 (address,startupId) 幂等，同进程重注册不轮换 token |
| POST | `/heartbeat` | `@Public()`（处理器内 `validateTokenByAddress`） | 指标 + `runningExecutionIds`/`deadLetterCount`/热更新 `maxConcurrentTasks` |
| POST | `/token` | `@Public()` | 机器凭据签发/校验通道 |
| POST | `/offline` | `@Public()` | 优雅停机下线（emit `executor.offline`） |
| GET | `/` `/groups` `/tags` | JWT | 列表与去重集合 |
| GET | `/install-cmd` | `@Roles(ADMIN)` | 生成 `curl …/install.sh \| bash -s -- --api-url … --secret …` |
| GET | `/install.sh` | `@Public()` + 空 `@Roles()` | 下发安装脚本常量 |
| GET | `/artifact/executor-node.tar.gz` | `@Public()` + 共享 token（Bearer 或 `?token=`） | 内置 node 执行器分发包 |
| PATCH | `/:id`、POST `/:id/reload-config`、`/:id/set-offline`、POST `/:id/rotate-token`、DELETE `/:id` | `@Roles(ADMIN)` | 管理干预 |
| GET | `/:id/executions`、`/:id/metrics` | JWT | 该执行器执行记录与指标 |

## 关键机制

### 派发选址（ExecutorService.dispatch）

```
task.executorId 非空 ──► pinning：只投该执行器（离线/满载即失败，不回退机群）
否则按序过滤：
  executorAppName 精确匹配 → executorGroup → executorTags（AND 子集，硬性能力）
  → executorAffinityTags（OR，软路由意向）→ executorAntiAffinityTags（排除）
  → capabilities 含 task.runtime（执行器未声明 capabilities 时放行）
候选池 cap 500 → computeExecutorLoadScore 排序（负载 50% + CPU 25% + 内存 25%
  + 长任务惩罚 10%，CORE-05：惩罚项由 tasks.estimatedDurationSec 聚合而来）
→ ARCH-35 P1 部署归属偏好分区（partitionByDeploymentAffinity，开关
  EXECUTOR_PREFER_DEPLOYED 默认 true）：查 app_deployments 中 status='running'
  且命中本任务 applicationId 的行 → 命中的执行器整体前置（组内保持评分序）
  **must 插在排序之后**（排序前分区会被随后的全量 sort 打散）；**不改评分**
  （决策日志的 score 必须始终是真实负载分，否则"为什么选这台"无法回溯）
逐候选原子占坑（QA-05/BUG-22：无版本谓词，容量与在线同条 UPDATE 内复查）：
  UPDATE executors SET runningTaskCount = runningTaskCount + 1
  WHERE id=? AND status='online' AND runningTaskCount < maxConcurrentTasks
命中 → axios POST <address>/api/execute  {executionId, task, params}
       timeout=(task.timeout||300+10)s，Authorization: Bearer 共享 token，
       traceparent 透传（OBS-01），SSRF 守卫 assertSafeExecutorUrl（F-3）
失败 → GREATEST(runningTaskCount-1,0) 回滚占坑后重试下一候选 / 抛错
```

`dispatchBroadcast`（`executeMode=broadcast`）：同样过滤后 `Promise.allSettled` 并行投全体候选（亲和标签把广播收窄为命中子集），不占坑。

### 注册与身份（SEC-03 / N4）

- `register()`：按 address 查找——新行走字段白名单 `repo.create`（F-7：绝不透传 caller 数据，防 `id`/`tokenHash`/`status` 注入）；重启检测（`restartedAt`/`startupId` 基线变化）→ `failRunningExecutionsAfterRestart` + `runningTaskCount=0`。
- `registerExecutor()`：注册 + 首次/重启时 `rotateToken()`（`randomBytes(32).hex`，bcrypt cost 12 存 `tokenHash`）；同进程重注册返回 `perExecutorToken=null`（防轮换风暴）。
- 校验：`validateTokenByAddress(address, token)`——先 bcrypt 比对 `tokenHash`，失败回退共享 token `EXECUTOR_SECRET`（timingSafeEqual）；正结果缓存 60s（负结果不缓存）。共享 token 来源顺序：DB 轮转值 → env。

#### 身份冲突观测（ARCH-34 / ARCH-36）

两个跟踪器**并存不互替**，且都必须在任何 DB 写入**之前**调用（register 会就地改写被共享行的
`appName`/`capabilities`/`startupId`，而「本次上报是否新增了一个指纹」这个事件只在本刻可见）：

| 跟踪器 | 判据 | 判定结果 | 处置 |
|---|---|---|---|
| `observeAddressConflict`（ARCH-34 P0） | 「**被顶替的**进程生命重新上报」——**不是**「同 address 出现不同 startupId」（后者是正常重启的形状，会致每次重启误报） | 两台机器的进程生命在并存 | ERROR 日志 + 通知，10min 按 `(address,startupId)` 节流 |
| `observeDeviceFingerprint`（ARCH-36 / ADR-017 阶段 2） | 同 `address` 出现**第二个不同**指纹 | 两台机器/两份安装共用一行（**直接证据**，不依赖上报节奏） | ERROR 日志 + 通知（载荷列出**全部**并存指纹），10min 按 `(address,fingerprint)` 节流 |
| 同上 | 同一指纹上报了一个**新** `address` | 机器换网/换 IP，**正常** | 仅 info 日志，**不告警**（否则每次换网都告警＝狼来了） |

- **分工**：ARCH-34 管**进程生命**、不依赖新字段（对未上报 `startupId` 的存量执行器仍有效）；
  ARCH-36 管**安装身份**、判据更硬但要求协议 v3。迁移期两者并存；阶段 3 落地后 ARCH-34 仍保留作
  交叉校验——它覆盖一种指纹判不出的形态（**同机同 kind 同 workDir 的两个实例会共享指纹**）。
- 两者**独立外发、刻意不去重**：一台机器同时命中两条判据会收到两条告警（证据面不同）；运营侧用
  **同一条**处置动作收敛两者——给每台机器唯一的 `EXECUTOR_ADDRESS_PUBLIC`。
- 两者都 **fail-open**：观测/通知的任何失败（含 `notificationService` 缺席、`sendAll` 同步抛错）
  都绝不影响注册/心跳主链。观测设施本身不能成为新的故障源。

### 心跳与活性

- `markStaleOffline()` `@Cron("*/30 * * * * *")`：`lastHeartbeat` 早于 `EXECUTOR_HEARTBEAT_INTERVAL`(默认 30000ms) × `EXECUTOR_HEARTBEAT_TIMEOUT_MULTIPLIER`(默认 3) 的 ONLINE 行置 OFFLINE，随后逐台 emit `executor.offline` 领域事件 + `notifyExecutorOffline` 通知。
- `detectLostExecutions()` `@Cron("0 */5 * * * *")`：核对执行器本地在跑与 DB RUNNING 的差集。
- `cleanupOfflineExecutors()` 每小时删除 OFFLINE 超 7 天的行。
- 心跳采纳白名单：`maxConcurrentTasks` 仅收 1..10000 整数（E9）、`deadLetterCount` 0..100000（U16）、`runningExecutionIds` 逐项 `^[A-Za-z0-9_-]+$` 且裁剪至 200（CONSISTENCY-02）、`deviceFingerprint` 仅收 64 位小写十六进制（ARCH-36；**缺省/非法一律不动 DB**——否则旧执行器每 30s 的心跳会把已存指纹历史擦成 NULL）。

## 与其他模块的关系

- 依赖 [task](task.md)：Task/TaskExecution 实体读侧 + `SecretsCryptoService`（`forwardRef` 双向环，task 模块 export 加密服务）。
- 被 [task](task.md)（dispatch/kill/日志回填 token）、[scheduler](scheduler.md)（stale sweep 重试兑现）、[artifacts](artifacts.md)（上传凭据校验）、notification（executor 上/下线通知）依赖。
- 发布事件：`executor.offline`（三路翻转点：心跳超时 sweep / 优雅停机 markOffline / 管理台 setOfflineById），被 event-subscriptions / notification 消费。

## 常见改动场景

- 调整派发策略：`dispatch` 过滤链 + `executor-score.util.ts` 权重；注意广播路径 `dispatchBroadcast` 的过滤链需同步修改（两处实现）。
- 新增心跳字段：entity 加列 + 迁移 + heartbeat 白名单采纳函数（范围校验模式照抄 `isAdoptableMaxConcurrentTasks`）。
- 新增执行器自报**身份**类字段（非指标列）：除上面三步外还要定「三态采纳」——**缺省/非法一律不动 DB**（照抄 `interpreters`/`deviceFingerprint`），并想清楚观测点是否必须在 DB 写入**之前**。
- 安装脚本改动：`install-script.content.ts` 与仓库根 `scripts/install.sh` 必须两处同步（有测试守卫做逐字节比对）。

## 相关文档

- [task](task.md) · [scheduler](scheduler.md) · [executor-package](executor-package.md) · [artifacts](artifacts.md)
- [执行器注册流程](../../../04-flows/executor-registration.md)（规划路径）
- [executor-node](../../../01-apps/executor-node/README.md) / [executor-python](../../../01-apps/executor-python/README.md)（规划路径）
