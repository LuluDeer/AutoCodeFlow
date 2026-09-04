# AutoCodeFlow 第五轮真机 E2E 验证报告（VERIFY-round5）

- 验证人：第五轮真机验证 agent V
- 日期：2026-09-02
- 代码基线：`3e81ad7`（develop）
- 环境：Docker 26.1.4 + Compose v5.1.1，Linux 宿主（node v24.13.0）
- 隔离方式：全部构建/运行在 `git worktree add /tmp/acf-r5 HEAD` 中进行，`COMPOSE_PROJECT_NAME=acf-r5`；主仓除本报告外零改动
- 宿主端口占用侦察：5432（宿主 postgres）、6379（宿主 redis）、8111（metabase）、8005（flow2api）已被占用；本项目只用 3105/3106/9000/9001，无冲突。compose 内 postgres/redis 仅在 internal 网络，不发布宿主端口，无需改映射

## 0. 环境搭建记录

### 0.1 compose 编排（worktree 内，勿提交）

- `/tmp/acf-r5/docker-compose.r5.yml`：新增 `admin-api2` 服务（与 admin-api 同镜像、同 DB/Redis，宿主端口 3106）
- `/tmp/acf-r5/docker-compose.r5-exec.yml`：新增 `executor-node-2` 服务（address=executor-node-2:8002，MAX_CONCURRENT_TASKS=2）
- `/tmp/acf-r5/.env`：独立密钥（DB/JWT/EXECUTOR_SECRET/MINIO/CORS）
- 生产模式启动（`NODE_ENV=production`，`migrationsRun=true`），迁移自动执行
- CORS 校验拦截：`CORS_ORIGINS` 含 localhost 时生产模式启动即抛错（configuration.ts:148），改用 `http://r5verify.local`

### 0.2 【新发现 N1】全新数据库迁移链必失败（部署阻塞，P1）

生产模式（migrationsRun=true）在全新 DB 上启动，迁移连续在 3 处失败：

1. `1717473142691-AddMissingUniqueAndCompositeIndexes.ts:47-48`：对 `app_deployments` 建索引，但**全部迁移中没有任何一处 CREATE TABLE "app_deployments"**（实体在 `apps/admin-api/src/modules/application/entities/app-deployment.entity.ts:28`，仅存在于 entity，InitialSchema 亦无）。报错 `relation "app_deployments" does not exist`
2. `1717473142693-AddExecutorVersion.ts:9-11`：`ADD COLUMN "version" INTEGER`，与 InitialSchema `1717473142678-InitialSchema.ts:124` 遗留的 `"version" VARCHAR` 撞名。报错 `column "version" of relation "executors" already exists`
3. `1788274394054-RenameExecutorVersionColumn.ts:6`：无条件 `RENAME version TO executorVersion`，即使前序迁移成功也会因与实体 `executorVersion` 列冲突/语义错乱失败（该迁移时间戳最大却承担了本应发生在 2693 之前的职责）

**验证用 workaround（仅 worktree，未改主仓）**：
- 在 DB 预建 `app_deployments`（按实体列）
- worktree 补丁 4 个迁移文件使其幂等（InitialSchema 改名 executorVersion / 2691 加 CREATE TABLE IF NOT EXISTS / 2693 先 DROP IF EXISTS 再 ADD IF NOT EXISTS / 1788 加 DO $$ 守卫），重建镜像后迁移一次通过

**建议**：新增一条 CI 冒烟：空卷 `docker compose up admin-api` 必须健康；为 application 模块补建表迁移。

### 0.3 【新发现 N2】调度入队 100% 失败：`Priority should not be float`（P0）

- 现象：每条调度产生的 execution 先建 PENDING 行，随后立即置 FAILED，`errorMessage="Failed to enqueue execution: Priority should not be float"`
- 根因：`tasks.priority` 在 DB 中是 PG 字符串枚举 `task_priority_enum`（labels: low/normal/high/critical），而 TS `TaskPriority` 是数字枚举（1-4，task.entity.ts:24-29）。TypeORM 读出字符串 `'normal'`，`scheduler.service.ts:642` 将其原样塞进 BullMQ `queueOptions.priority`（BullMQ 要求整数）→ lua 校验抛错
- 波及：**所有 fixed_rate/cron/misfire 调度触发都无法进入队列**（80/80 失败）；manual 路径 `task.service.ts:306` 不传 priority，不受影响——本报告验证 2/3 因此全部改用 manual 触发
- 线索：`apps/admin-api/src/modules/scheduler/scheduler.service.ts:633-643`（queueOptions）、`1717473142684-AddApplicationAndTaskFields.ts:89`（enum 建列）、task.entity.ts:24-29（数字枚举）。修复方向：DB enum 与 TS enum 对齐，或 enqueue 前 normalize

### 0.4 【观察 N3】Leader 竞选启动竞态（fail-open 窗口，自愈）

每次 admin-api 启动首条日志均为：

```
WARN [SchedulerService] Leader election unavailable (Cannot read properties of undefined (reading 'set')); degrading to leader so scheduling is not stopped
```

即 `SchedulerService.onModuleInit → tryAcquireLeadership → acquireLock` 先于 `RedisLockService.onModuleInit` 初始化 ioredis client 执行，`this.client` 为 undefined 抛错，走 fail-open 降级为"假 Leader"。15s 后重试（`SCHEDULER_LEADER_RETRY_MS=15000`，scheduler.service.ts:32）补拿真锁，自愈**静默**（`wasLeader=true` 不打日志）。双实例同时启动时存在最长 ~15s 的双降级-Leader 窗口，由 enqueue 的 DB claim 兜底。线索：`redis-lock.service.ts:18-32`、`scheduler.module.ts:18`（providers 声明顺序）、`scheduler.service.ts:94-137`。建议：RedisLockService 构造器内创建 client（勿依赖 onModuleInit 时序），或在 tryAcquireLeadership 判空 client。

## 1. 验证项 1：Leader Election 双实例 + 触发锁回归 —— ✅ 通过（d2613d6 回归有效）

### 1.1 步骤

1. `COMPOSE_PROJECT_NAME=acf-r5 docker compose -f docker-compose.yml -f docker-compose.r5.yml up -d postgres redis admin-api`（后加 admin-api2，共 2 实例，同 DB/Redis）
2. API 登录 → 建 `triggerType=fixed_rate, fixedRate=15, timeoutSeconds=10` 的 node 任务（id `1075af80-3af8-4ca0-ab2d-6f8b64b49be9`）
3. 观察 ≥20 分钟的 execution 产生节奏、Leader 日志、Redis 锁；随后 `docker kill` Leader 观察接管

### 1.2 结果

| 检查点 | 结果 | 证据 |
|---|---|---|
| a) 执行记录按周期持续产生（不再"只触发一次"） | ✅ | Leader 注册日志 `Re-scheduled fixed_rate task "r5-fixed-rate-lock-regression" every 15s`（11:43:00）；此后持续产生 **80 条** execution（11:43:15 → 12:04:44+），穿越 kill-Leader 事件前后 |
| b) 无重复触发 | ✅ | 全部 80 行 createdAt 无同周期重复（每 tick 至多 1 行）；触发锁 `lock:task:trigger:<taskId>` 正常过期（TTL=max(timeout,fixedRate)s） |
| c) 仅一个 Leader | ✅ | `redis-cli GET lock:scheduler:leader` 单一 lockId（api1=`4ce8...`）；api2 日志 `staying follower` / `reload skipped: not the scheduler leader`；api1 重启后 `Scheduler leadership lost (another instance acquired the leader lock)` 让位，锁值不变（`9cec...`） |
| d) kill Leader 后接管 | ✅（35s，略超 ≤30s 目标） | 11:47:19 `docker kill acf-r5-admin-api-1`（SIGKILL）→ api2 于 11:47:54 `Scheduler leadership acquired`（间隔 35s，上界=锁 TTL 残余 30s + 15s 重试周期）→ 11:48:15 恢复周期触发。空档期（11:47:15→11:48:15）无触发、无双触发、无双 Leader |

### 1.3 附带观察（⚠️ 不判失败，但建议跟进）

- **触发节奏抖动**：dedup 锁 TTL 恰等于 fixedRate（`enqueue()` 里 `lockTTL=max(timeout*1000, fixedRate*1000)`），acquire 相位滞后 tick 约 10-35ms，导致相邻 tick 与锁过期呈亚秒级竞态——实测节奏在 15s/30s 之间抖动（11:43-11:47 段多为 30s，11:48 后多段 15s），长期平均≈fixedRate。若 task 用默认 timeout=300s，TTL=300s，fixed_rate<300s 的任务**每个锁窗口只触发一次**（如 15s 任务实际 300s 一触发）——建议 minIntervalMs 与 TTL 解耦（如 TTL=interval+timeout 上限、或 dedup 锁 TTL 取 interval-缓冲）。线索：`scheduler.service.ts:499-507`
- kill-Leader 的 35s 接管由"TTL 30s + 15s 重试"决定，若要满足 ≤30s 硬指标，可将 verify/retry 周期收紧至 TTL/3
- 因 N2（priority 入队失败），本项验证的是"触发锁/触发行"语义；队列消费层不可达属 N2 范畴

## 2. 验证项 2：LOG-11 S3 日志 E2E —— ✅ 通过

### 2.1 步骤

1. `--profile minio up -d minio`；`.env` 置 `LOG_STORAGE_DRIVER=s3, LOG_STORAGE_ENDPOINT=minio:9000, LOG_STORAGE_BUCKET=autoflow-logs`，`--force-recreate` 双 admin-api（bucket 由 S3LogStorage `ensureBucket()` 自动创建）
2. executor-node 接入：**宿主进程方案因防火墙受阻**（容器可回访宿主已发布端口 3105，但访问宿主自监听端口 8202 超时——docker bridge → host INPUT 链丢弃），改用 compose 容器化 executor（`up -d --build executor-node executor-node-2`，内网 address=`executor-node:8002`）
3. EXECUTOR_ALLOW_PRIVATE_NETWORK 语义实测：address 用私网段（172.20.0.1 / executor-node 内网 DNS）默认放行（private-lan），未设置该变量即通过；与 round-4 结论一致
4. 建 manual 任务（glueSource 输出 3 行日志）→ `POST /api/tasks/:id/trigger`
5. `mc` 验证 + logs API 验证

### 2.2 结果

- 执行成功：execution `4c767d33-4deb-4699-8422-579bfbb39564` → `status=success, executorAddress=executor-node:8002, logStorage=s3, logObjectKey=execution-logs/4c767d33-4deb-4699-8422-579bfbb39564.log.gz`
- `mc ls`（minio/mc 容器，alias r5 → localhost:9000）：
  ```
  [2026-09-02 12:08:29 UTC] 108B STANDARD execution-logs/4c767d33-4deb-4699-8422-579bfbb39564.log.gz
  ```
- `mc cat ... | 解压` 内容与脚本输出逐行一致：
  ```
  [s3-e2e] line1 hello from executor
  [s3-e2e] line2 key=VALUE_XYZ
  [s3-e2e] done at 2026-09-02T12:08:28.363Z
  ```
- `GET /api/tasks/5140de18.../executions/4c767d33.../logs`（JWT）→ 200：
  ```json
  {"lines":["[s3-e2e] line1 hello from executor","[s3-e2e] line2 key=VALUE_XYZ","[s3-e2e] done at 2026-09-02T12:08:28.363Z"],"totalLines":3,"hasMore":false}
  ```
- 结论：S3 gzip 落盘 + 对象 key 回写 + API 流式解压读回，全链路 ✅

### 2.3 附带观察

- 【观察 N4】executor 共享 token 场景下，任意一次额外 `register` 都会 `rotateToken()`（`executor.controller.ts:127`）作废该 address 的 per-executor token。本次验证中一个残留的旧 executor 进程每 30s 重试 register，导致 token 轮换风暴（admin 日志每 30s 一条 `Rotated token for executor ...`）。心跳因 `validateTokenByAddress` 的共享 token 兜底（`executor.service.ts:983-995`）仍成功，未造成执行失败，但 per-executor token 机制在此场景形同虚设。清理残留进程后轮换停止。多进程/同机双副本部署时建议 register 幂等（startupId 未变则不 rotate）
- 【观察 N5】卡死执行的回收窗口：dispatch 已发出但 callback 丢失的 execution（本次验证初期残留进程吞掉一次 dispatch，状态 running→timeout 兜底成功），`recoverStaleExecutions` 的 initialCutoff 固定 1 小时（`scheduler.service.ts` DEFAULT_STALE_MS），短 timeout 任务的卡死行仍要等最多 1 小时才被扫描

## 3. 验证项 3：双 executor 负载均衡与槽位释放 —— ✅ 通过

### 3.1 步骤

两 executor 在线（`executor-node:8002` 与 `executor-node-2:8002`，均 maxConcurrentTasks=2，通过 `PATCH /api/executors/:id` 归一容量）。建 8s/6s 长耗时 node 任务，**并发触发 4 次**（连续 4×`POST /tasks/:id/trigger`），t+3s 采样 `GET /api/executors` 的 runningTaskCount，结束后统计 execution 分布。

### 3.2 结果

- Round 1（8s 任务×4）：dispatch 日志（两实例各自 worker 消费）
  ```
  api1 : Dispatching to executor-node:8002   (runningTasks=1) → again (runningTasks=2)
  api2 : Dispatching to executor-node-2:8002 (runningTasks=1) → again (runningTasks=2)
  ```
  终态：4/4 success，分布 `executor-node:8002=2 / executor-node-2:8002=2`
- Round 2（6s 任务×4）：t+3s 采样 `r5-exec-node-2 running=2, executor-node-1 running=2`（满载且不超卖）；终态 2+2 全部 success
- 槽位释放：callback 后 runningTaskCount 归零（t+6s 采样 0/0），无泄漏
- 无超卖：两轮 runningTaskCount 从未超过 maxConcurrentTasks=2；`dispatch()` 的乐观锁条件 UPDATE（`runningTaskCount < max AND version=:v`，executor.service.ts:591-602）有效

### 3.3 附带观察

- 【观察 N6】同一秒内两实例并发 dispatch 时存在计数可见性竞争 + 分数并列：api1 的第 2 次 dispatch 仍选 `executor-node:8002`（此时另一台已被 api2 占 1 槽，两台分数并列，稳定排序复选首候选）。最终分布仍均衡（2+2），但"最小负载优先"在跨实例并发窗口内退化为"各自粘住一个候选"。容量上限不受影响；若追求严格均衡，可在并列时用 `random()`/address 哈希打散

## 4. 新发现问题汇总（只记录未修）

| # | 级别 | 摘要 | 线索 |
|---|---|---|---|
| N1 | P1（部署阻塞） | 全新 DB 迁移链 3 处必失败（app_deployments 无建表迁移；executors.version VARCHAR/INTEGER 撞名；1788 rename 时序错误） | `migrations/1717473142691-*:47-48`、`1717473142693-*:9-11`、`1717473142678-InitialSchema.ts:124`、`1788274394054-*:6` |
| N2 | P0 | 调度入队 100% 失败 `Priority should not be float`：DB priority 为字符串枚举，TS 为数字枚举，`enqueue` 原样传 BullMQ。所有 fixed_rate/cron 触发不能真正执行 | `scheduler.service.ts:633-643`、`task.entity.ts:24-29`、`migrations/1717473142684-*:89` |
| N3 | P2 | Leader 竞选启动竞态：RedisLockService client 在 onModuleInit 才创建，首个 acquireLock 必抛错 → fail-open 假 Leader（静默自愈，双实例同启有 ~15s 双降级窗口） | `redis-lock.service.ts:18-32`、`scheduler.service.ts:94-137` |
| N4 | P2 | 共享 token 下任意 register 都 rotate per-executor token，多进程/双副本同机部署会互相作废 token（共享 token 兜底使心跳不中断） | `executor.controller.ts:127`、`executor.service.ts:947-995` |
| N5 | P3 | 卡死 execution 的 stale 扫描 initialCutoff 固定 1h，短 timeout 任务回收延迟最长 1h | `scheduler.service.ts` recoverStaleExecutions |
| N6 | P3 | 跨实例并发 dispatch 的分数并列粘滞（不超卖，但非严格最小负载） | `executor.service.ts:570-614` |
| — | ⚠️ | fixed_rate dedup 锁 TTL=周期，与 tick 边界亚秒竞态导致节奏在 interval/2×interval 抖动；默认 timeout=300s 时短周期任务被压制为 300s 一触发 | `scheduler.service.ts:499-507` |
| — | ⚠️ | kill Leader 实测 35s 接管（TTL30s+retry15s 上界），略超 ≤30s 验收目标 | `scheduler.service.ts:29-32,141-148` |

## 5. 验证结论

| 验证项 | 结果 |
|---|---|
| 1. Leader Election 双实例 + 触发锁回归（d2613d6） | ✅ 通过（80 条 execution 持续产生、无重复、单 Leader、35s 接管） |
| 2. LOG-11 S3 日志 E2E | ✅ 通过（minio 对象可 mc 验证并解压，logs API 返回一致内容） |
| 3. 双 executor 负载均衡 | ✅ 通过（两轮 4 并发均 2+2、无超卖、槽位释放） |

第四轮 d2613d6 对"触发锁被 watchdog 无限续期"的修复在真机回归有效：调度锁正确过期、每周期都能重新获取、kill Leader 后无状态残留。但 N2（priority 入队失败）使所有调度任务在队列层不可用，属本轮新引入的最高优先级问题（疑似 1717473142684 迁移引入 PG 枚举后即存在，第四轮未做生产模式真机触发验证故未暴露）。

## 6. 环境清理确认

- [x] `COMPOSE_PROJECT_NAME=acf-r5 docker compose -f docker-compose.yml -f docker-compose.r5.yml -f docker-compose.r5-exec.yml --profile minio down -v --remove-orphans`（含 minio、双 admin-api、双 executor、postgres/redis 数据卷）
- [x] `git worktree remove --force /tmp/acf-r5`
- [x] 清理 `/tmp/acf-r5-exec1`、`/tmp/acf-r5-exec2`（宿主 executor 目录）及宿主临时文件
- [x] 宿主 executor 进程（8202/8302）已终止；未触碰 metabase/flow2api 等他人容器
- [x] 主仓无代码改动，仅本报告
