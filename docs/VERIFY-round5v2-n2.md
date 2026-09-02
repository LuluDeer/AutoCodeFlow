# AutoCodeFlow 第五轮修复复验报告（VERIFY-round5v2-n2）

- 验证人：第五轮复验 agent V2
- 日期：2026-09-02
- 代码基线：`d2be430`（develop HEAD；含 `2642293` N2-N6 修复 + `d2be430` N1 迁移链修复）
- 针对对象：`docs/VERIFY-round5-e2e.md`（V 首轮真机验证）发现的 N1(P1)/N2(P0) 及 N3/N6
- 环境：Docker 26.1.4 + Compose v5.1.1，Linux 宿主
- 隔离方式：`git worktree add /tmp/acf-r5v2 HEAD`（分离头指针 d2be430），`COMPOSE_PROJECT_NAME=acf-r5v2`；worktree 内新增 `docker-compose.r5v2.yml`（端口覆盖：admin-api `13105:3105`、executor-node `18002:8002`）与独立密钥 `.env`，主仓除本报告外零改动
- 宿主端口侦察：metabase(8111)、flow2api(8005) 等容器在跑，5432/6379/3001/80 已占用；本项目全部使用独立映射（13105/18002），postgres/redis 仅 internal 网络不发布宿主端口，与他人零冲突

## 0. 环境与验证路径说明

### 0.1 迁移执行位置确认（任务要求先确认）

迁移**不是** compose 单独 entrypoint/step 执行：`apps/admin-api/Dockerfile` 的 CMD 为 `node dist/main.js`，无迁移脚本调用。迁移在 **admin-api 应用启动 bootstrap 路径内**由 TypeORM 执行——`app.module.ts:165` 配置 `migrationsRun: cfg.get("app.nodeEnv") !== "development"`，本验证 `NODE_ENV=production`，即数据源初始化（TypeOrmCoreModule init）时自动跑全量迁移。首轮报告 0.1 节"生产模式（migrationsRun=true）迁移自动执行"与此一致。

### 0.2 服务拓扑

- `postgres:16-alpine` + `redis:7-alpine`（全新命名卷 `acf-r5v2_postgres_data` / `acf-r5v2_redis_data`，启动前确认库内 0 张表）
- `admin-api` 单实例（宿主 13105）
- `executor-node` 容器化 executor（内网 address=`executor-node:8002`，`ADMIN_API_URL=http://admin-api:3105`；**未设置** `EXECUTOR_ALLOW_PRIVATE_NETWORK`——首轮结论 private-lan 地址默认放行，本轮复证成立）

### 0.3 任务创建（API 登录 + camelCase）

`POST /api/auth/login`（`{"username":"admin",...}`）→ `POST /api/tasks`：

| 任务 | triggerType | fixedRate | cron | timeout | priority（API 返回值） |
|---|---|---|---|---|---|
| r5v2-fixed-rate-15s | fixed_rate | 15 | — | 10 | `'normal'`（PG 字符串枚举原样返回，即 N2 根因现场） |
| r5v2-cron-30s | cron | — | `*/30 * * * *`（5 字段=每 30 分钟，:00/:30 触发） | 10 | `'normal'` |
| r5v2-fr15-default-timeout | fixed_rate | 15 | — | **0（DB 默认值，见 §4 观察2）** | `'normal'` |
| r5v2-fr15-timeout120 | fixed_rate | 15 | — | **120（> 周期，N6 隔离用）** | `'normal'` |

注：DTO 校验 `id` 为可选但会按 uuid 解析传字符串报 500（`invalid input syntax for type uuid`，与首轮无关的小刺，未深究）；6 字段 cron 表达式被 DTO 拒绝（校验器强制 5 字段）。

## 1. N2 核心回归：调度入队与执行 —— ✅ 通过

**首轮现象**：所有调度产生的 execution 100% 置 FAILED，`errorMessage="Failed to enqueue execution: Priority should not be float"`（80/80）。

**本轮结果**（观察窗口 15:10-15:36 UTC，≥4 周期充分满足）：

### 1.1 execution 状态分布（DB 直查）

| 任务 | success | failed |
|---|---|---|
| r5v2-fixed-rate-15s | 51 | 9（全部为 executor 注册前的 "No online executors match..."，预期行为） |
| r5v2-cron-30s | 1 | 0 |
| r5v2-fr15-default-timeout | 33 | 0 |
| r5v2-fr15-timeout120 | 11 | 0 |

**executor 在线（15:14:48 注册）之后：96/96 全部 success，0 FAILED；首轮 80/80 FAILED → 本轮 0 入队失败。**

### 1.2 "Priority should not be float" 检索

- `docker logs acf-r5v2-admin-api-1` 全量检索：**0 条**
- DB `task_executions."errorMessage" LIKE '%Priority%'`：**0 行**

### 1.3 成功执行链日志（dispatch → executor → 回调 success）

admin-api：
```
3:15:00 PM  LOG [ExecutorService] Dispatching task "r5v2-fixed-rate-15s" to executor executor-node:8002 (runningTasks=1)
```
executor-node：
```
2026-09-02T15:35:45.379Z [INFO] Glue script written to /data/tasks/fe572be1-.../glue_script.js (70 bytes)
2026-09-02T15:35:45.379Z [INFO] Running task r5v2-fixed-rate-15s [fe572be1-...]: node glue_script.js
```
成功 execution 明细样例（`9aa97204-ac2b-4fbe-b712-a793afae4641`，fixed_rate 触发）：`status=success, executorAddress=executor-node:8002, duration=24ms, start/end 齐全`。

### 1.4 成功日志内容（logs API）

```
GET /api/tasks/executions/fe572be1-2e76-473b-982c-509dea9cde45/logs
→ 200 {"lines":["[r5v2-n2] fixed_rate tick at 2026-09-02T15:35:45.395Z",""],"totalLines":2,"hasMore":false}
```
（LOG_STORAGE_DRIVER=db 路径；与 glue 脚本 `console.log('[r5v2-n2] fixed_rate tick at', ...)` 输出一致）

## 2. N6 复验：去重 TTL 与 timeout 解耦 —— ✅ 通过（遗留亚秒抖动如实记录）

### 2.1 修复语义

`computeTriggerDedupTtlMs`（scheduler.service.ts:72-80）：fixed_rate → `max(fixedRate*1000, 1000)`，cron → `1000`，manual → `5000`——不再取 `max(timeout, ...)`。

### 2.2 决定性证据：timeout=120s 的 15s 任务未被压制

r5v2-fr15-timeout120（fixedRate=15, **timeout=120**）。旧代码 TTL=max(120,15)=120s → 每 120s 至多 1 次；若压制仍存在，5 分钟窗口只能有 ~3 条。实测 **300s 内 12 条**（15:31:15 → 15:36:15，全 success）。

Redis 锁 TTL 采样（lock:task:trigger:7fdfd854...，即 fixed_rate 任务）：
```
15:24:46 PTTL=14192ms   （新设≈14.2s ≈ 周期15s，扣除相位差）
15:24:49 PTTL=11088ms   （线性衰减）
15:24:55 PTTL=4867ms
15:24:58 PTTL=1764ms → 过期 → 下一 tick 重新获取
```
**TTL≈周期而非 timeout，N6 修复生效。**

### 2.3 相邻 execution 时间差样本（fr15-default-timeout，33 条）

```
gap_s: 30,30,16,15,30,29,30,30,30,15,15,30,30,15,30,30,30,30,15,15,15,30,30,30,30,15,30,30,30,30,30,30
```
- **节奏结论**：触发不再被 timeout 压制（首轮"300s 一触发"消除，每周期都尝试触发），长期平均 ≈ 25.8s（825s/32 gap）
- **如实记录**：gaps 呈 **15s/30s 混合**而非稳定 ≈15s——这正是首轮报告 §1.3/§4 已记录的遗留 ⚠️（去重锁 TTL=周期，acquire 相位滞后 tick 数十 ms，下一 tick 落在锁窗口内被跳过，即 interval/2×interval 亚秒竞态）。该项**不属于本次 N2-N6 修复范围**（修复只把 TTL 从 max(timeout,…) 改为周期），建议后续按首轮建议（TTL=周期-缓冲或 interval+上限）跟进，否则短周期任务的实测频率只有标称的 ~55%-100% 波动

## 3. N3 复验：Leader 竞选启动竞态 —— ✅ 通过

admin-api 启动日志（14:58:05，容器单次启动、无重启）中与 leader 相关的全部内容：

```
LOG [SchedulerService] Scheduler leadership acquired — this node is now the leader
```

- 首轮必现的 `WARN [SchedulerService] Leader election unavailable (Cannot read properties of undefined (reading 'set')); degrading to leader...`：**0 条**
- 全日志检索 "degrading to leader" / "Leader election unavailable"：**0 条**
- leader 在应用启动同秒即抢到真锁（非 fail-open 降级后再自愈）；`GET /api/tasks/scheduler/stats` 返回 `isLeader: true`

## 4. N1 存量路径抽查（全新 DB 场景） —— ✅ 通过

### 4.1 迁移执行结果

- 启动前确认全新卷：`information_schema.tables` 计数 **0**
- admin-api 启动后：`migrations` 表 **24/24 行**（含新增补偿迁移 `CreateAppDeploymentsTable1788274394055`），与 `src/migrations/` 目录迁移数一致
- 建表 **13 张**，`app_deployments` 存在（首轮断点 1 的缺失表）
- 启动日志零迁移报错、零 ERROR；admin 种子用户创建成功；容器 `healthy`

### 4.2 按任务说明，存量库续跑已由 W2 验证，本轮不重复

## 5. 附带验证与观察

- **cron 路径全链**：`*/30 * * * *`（5 字段=分钟粒度，每 30 分钟）任务在 15:30:00 整点触发、入队、执行 **success**——首轮因 N2 从未验证过 cron 真实执行，本轮补上
- **观察 A（遗留，非新引入）**：§2.3 的 15/30s 节奏抖动（TTL=周期 亚秒竞态），首轮 ⚠️ 项仍未修
- **观察 B（文档纠偏）**：`tasks.timeout` 列默认值为 **0**（entity/DB 均是），首轮报告所称"默认 timeout=300s"不成立——timeout=0 时旧代码 TTL=max(0,15)=15s，与修复后相同；N6 的实际收益场景是 **timeout > fixedRate**（本轮以 timeout=120 实证）
- **观察 C（小刺）**：`POST /api/tasks` 传自定义字符串 `id` 报 500（uuid 解析失败），DTO 层 `@IsString() @IsOptional()` 与 DB uuid 列不匹配，建议补 `@IsUUID()` 或忽略该字段
- executor 注册日志：`Registered to admin-api (runtimes: shell, node, maxConcurrent: 10)`；心跳正常，无 register 轮换风暴（N4 生效侧证）

## 6. 验证结论

| 复验项 | 结果 | 关键证据 |
|---|---|---|
| N2(P0) 调度入队 | ✅ **通过** | executor 在线后 96/96 success、0 failed；"Priority should not be float" 日志/DB 双零；fixed_rate + cron 两路径均真机执行成功 |
| N6 去重 TTL 解耦 | ✅ **通过** | timeout=120s 任务 300s 内 12 次触发（旧代码 ≤3 次且间隔 120s）；锁 TTL 实测≈周期 15s |
| N3 Leader 启动竞态 | ✅ **通过** | 启动即 `Scheduler leadership acquired`，无 fail-open 告警 |
| N1 全新 DB 迁移 | ✅ **通过** | 空卷 24/24 迁移、13 表、app_deployments 存在、零报错、应用 healthy |
| （遗留）节奏抖动 15/30s | ⚠️ 未修（首轮已知 ⚠️，非本轮修复范围） | gap 样本见 §2.3 |

首轮 N2(P0)（调度 100% 不可用）与 N1(P1)（全新 DB 无法部署）两项部署阻塞缺陷经真机复验确认已修复；N3/N6 修复在真机生效。遗留的节奏抖动属首轮已记录 ⚠️，建议另立跟进项。

## 7. 环境清理确认

- [x] `COMPOSE_PROJECT_NAME=acf-r5v2 docker compose -f docker-compose.yml -f docker-compose.r5v2.yml down -v --remove-orphans`（postgres/redis/admin-api/executor-node 及全部数据卷）
- [x] `git worktree remove --force /tmp/acf-r5v2`
- [x] 容器/卷/网络无 acf-r5v2 残留；未触碰 metabase/flow2api 等他人容器
- [x] 主仓无代码改动，仅本报告
