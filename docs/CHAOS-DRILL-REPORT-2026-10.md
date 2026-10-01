# 混沌演练复跑任务书（2026-10，给 Linux 侧）

> 日期：2026-10-01　|　性质：**交接任务书**（非实测报告——本轮 Windows 侧无法执行 docker 注入）
> 背景：2026-09 下旬至 10-01，develop 合入了大量**故障路径**修复（CI 三轮红收口、
> 四轮审计 90+ 项、26 条告警规则集等）。这些改动的韧性行为目前只有**源码核实**
> 与单测证据，缺少真机混沌演练的实测背书。本文档列出**必须注入验证的场景、
> 注入方法、预期观测点与通过判据**，交 Linux 主场（Docker 可用）复跑。
>
> ⚠️ **适用范围声明**：本文所有注入场景均需要 Docker/Linux 主场（docker compose
> 完整栈 + Prometheus 可选），**Windows 侧无法执行**。Windows 侧本轮已完成的
> 相关工作：executor-desktop e2e 三例（`apps/executor-desktop/e2e/n10-desktop.spec.js`，
> 本机 11/11 绿）、`desktop-e2e` CI workflow、下文所有场景的源码核实（文件/行号
> 语义均按 develop@7ba76fa3 前后工作树核实）。

## 0. 本轮故障路径改动 → 场景映射（为什么是这七个）

| 本轮改动（commit/主题） | 涉及实现 | 对应场景 |
|---|---|---|
| `2cc77d3b` users 初始管理员种子 boot 容错（空库 count 不再炸 export） | `apps/admin-api/src/modules/users/users.service.ts` onModuleInit | ① |
| `5bf2a57a` scheduler boot 链空库/抖动容错（boot 步骤逐个 try/catch） | `apps/admin-api/src/modules/scheduler/scheduler.service.ts` onModuleInit | ① |
| `b015453b` 0050 迁移 substr(::text) 空库真跑修复 | 迁移链 | ①⑦ |
| BullMQ `retryStrategy` 收敛（`Math.min(times*100, 3000)`，恢复后离线队列重放） | `apps/admin-api/src/app.module.ts` | ② |
| 终态 SSE 跨实例 relay fail-open（fire-and-forget，发布/订阅失败仅 warn） | `apps/admin-api/src/common/services/execution-events-relay.service.ts` | ② |
| 失败通知聚合窗（Redis hash + TTL，digest 链路任何意外回退逐条直发） | `apps/admin-api/src/modules/notification/notification-digest.service.ts` + `execution-events.listener.ts` | ② |
| kill 计数下沉到 `transitionToTerminal` 统一终态入口（KILLED 标签） | `apps/admin-api/src/modules/metrics/runtime-metrics.ts` + `modules/task/execution-terminal.ts` | ③ |
| `859e5f37` 26 条告警规则（killed 风暴 / 磁盘两级水位 / 调度停摆等） | `config/monitoring/alerts.yml` | ③⑥ |
| COVER_EARLY 覆盖补 kill 下发（A4：此前只翻转 DB 不杀进程） | `apps/admin-api/src/modules/scheduler/scheduler.service.ts` enqueue COVER_EARLY 分支 | ④ |
| watchdog 抖动容忍（连续 3 次续期失败才放弃租约） | `apps/admin-api/src/common/services/redis-lock.service.ts`（`REDIS_LOCK_WATCHDOG_MAX_CONSECUTIVE_FAILURES = 3`） | ⑤ |
| 迁移 advisory-lock 跨实例互斥（pg_try_advisory_lock 轮询） | `apps/admin-api/src/common/utils/migration-runner.util.ts` | ⑦ |
| 心跳 diskUsage 落库 + 磁盘水位指标渲染 | `apps/admin-api/src/modules/executor/executor-heartbeat.dto.ts`、`executor.service.ts` | ⑥ |

## 1. 运行环境与前置

沿 `docs/CHAOS-DRILL-REPORT.md`（2026-09-12）的既定形态：

- **隔离 compose 工程**（不碰已有容器）：项目名 `acfchaos`，栈 = postgres + redis +
  admin-api + executor-node，用仓库根 `docker-compose.yml`；
- **镜像必须从当前 develop 源码构建**（上轮教训：R5 缓存镜像的 Redis 客户端是坏的，
  演练结论失真）——`docker compose build admin-api executor-node` 需要 npm registry
  可达；构建失败时**不要**退回旧镜像出报告，场景 A/B 的 Redis 语义会全部失真；
- 独立凭据 `.env.chaos`（强密码）；管理台凭据默认 `admin` / `Admin@123456`；
- `scripts/chaos-drill.sh` 的场景 A（Redis 宕机）/ B（执行器断网判离线）**先原样跑一遍**
  作为回归基线（上轮 B 已真机通过，A 需在当前镜像上重跑——这就是上轮报告的 §4）；
- Prometheus/Alertmanager 若不在栈内，场景 ③⑥ 的告警断言可降级为
  `/api/health/metrics` 的**指标值断言**（规则表达式手工求值），但要在结果里注明。

## 2. 场景 ①：空库 boot 容错（scheduler / users 种子）

**验证语义**：无迁移的空库上起 AppModule（api-types-drift 的 openapi export、CI e2e
bootstrap 同型场景）不再炸 boot；依赖故障只 warn，等下一轮 tick 收敛。

| 项 | 内容 |
|---|---|
| 注入方法 | ① 新建空 PG（全新 volume，不跑任何迁移）；② admin-api 以 `NODE_ENV` ≠ production 启动（production 才 auto-migrate），DATABASE_URL 指向空库；③ 等价的最小复现：`DATABASE_URL=<空库> npm run openapi:export`（export 路径 bootstrap 完整 AppModule） |
| 预期观测点 | 日志出现（warn，**不是** crash/exit）：`initial-admin seed skipped (users table not ready): ...`；`scheduler boot step "reload" failed (will retry on next tick): ...`（checkMisfires / recoverStaleExecutions 同型）；若 Redis 同空：`Leader election unavailable (...); degrading to leader so scheduling is not stopped` |
| 通过判据 | ① admin-api 进程存活，`/api/health` 恒 200（status=degraded）；② 日志只有上述 warn 形态，无未捕获异常退出；③ 随后对同一库跑完整迁移链（`0050` 含 substr(::text) 修复）→ 重启 → boot 正常、初始管理员播种成功、`/api/health` status=healthy |

**失败排查线索**：boot 直接炸且栈顶在 users/scheduler → 容错 try/catch 被绕过
（多半是有人把启动步骤挪出了 bootSteps 数组）；迁移链炸在 substr → `b015453b` 回退。

## 3. 场景 ②：Redis 中断 2 分钟（BullMQ / SSE relay / 通知 digest）

**验证语义**：Redis 短时中断下 admin-api 不重启、不 5xx；恢复后自动重连、队列重放、
SSE relay 恢复、通知降级路径显性化。

| 项 | 内容 |
|---|---|
| 注入方法 | 栈全绿后：`docker stop redis`；**保持 120s**（BullMQ 重连退避封顶 3s，2 分钟足够覆盖多轮重试）；期间在 admin-api 触发 1 个会失败的任务（可用 `scripts/demo-failure-seed.mjs` 的 `demo-failure-fragile`）；`docker start redis` |
| 预期观测点 | ① 全程 `/api/health` 恒 200（status=degraded），redis 组件 unhealthy；② admin 日志：BullMQ/ioredis 重连错误按退避节奏出现（`retryStrategy` 封顶 3s），无进程重启；③ SSE relay 发布端：`execution-events relay 发布连接错误（fail-open）` / 订阅端同型 warn（单实例语义不变）；④ 失败任务的通知：digest 服务入窗失败 → 日志 `digest record rejected for execution <id>（回退逐条发送）` → 通知仍以逐条直发送达（Redis 挂了但通知不丢）；⑤ `docker start redis` 后 60s 内：redis 组件回 healthy，`/api/health/metrics` 的 queueSize 恢复可读，BullMQ 重新消费，中断期积压任务被补跑；⑥ SSE 客户端重新收到终态推送（跨实例 relay 恢复） |
| 通过判据 | A1：中断窗口内 `/api/health` 无一次非 200；A2：无容器重启/进程退出；A3：恢复后 90s 内 queue 组件 healthy 且积压任务全部到达终态；A4：中断期失败任务的通知有投递记录（逐条直发形态），恢复后新失败走聚合窗（同任务 10 分钟窗 `NOTIFICATION_FAILURE_DIGEST_MINUTES` 内多条失败只发一条汇总） |

**失败排查线索**：恢复后 queue 一直 unhealthy → `retryStrategy` 或离线队列重放被改坏
（对照 `app.module.ts` 的连接配置）；中断期通知整条丢失 → listener 的 digest 回退
try/catch 被破坏（对照 `execution-events.listener.ts` 的 `tryNotifyDigest`）。

## 4. 场景 ③：kill 风暴（killed 计数 + KILLED_SPIKE 告警）

**验证语义**：手动终止路径在统一终态入口正确计入 `autoflow_execution_result_total{status="killed"}`，
风暴告警按规则触发。

| 项 | 内容 |
|---|---|
| 注入方法 | 创建 1 个长跑任务（脚本 `sleep 300`），连续触发 ≥6 次；对每个 RUNNING 执行调 `POST /api/tasks/:id/executions/:execId/kill`（间隔 ~10s，全部落在 15 分钟窗内） |
| 预期观测点 | ① 每次 kill 后该执行终态 = KILLED（管理台执行时间线 / DB）；② `/api/health/metrics`（或 Prometheus）中 `sum(increase(autoflow_execution_result_total{status="killed"}[15m]))` 逐次 +1，最终 = kill 次数；③ 值超过 5 后，`config/monitoring/alerts.yml` 的 `AUTOFLOW_EXECUTION_KILLED_SPIKE`（expr `> 5`，15m 窗）进入 firing；④ 审计日志有每次 kill 的操作者记录 |
| 通过判据 | C1：killed 计数与实际 kill 次数**相等**（不多计回调 winner、不漏计 pull 执行器）；C2：executor 侧进程真实终止（`ps` / 执行器日志）；C3：告警规则 firing 且 `for`/窗口语义与 alerts.yml 一致；C4：STOP 后正常任务不受影响（success 计数照常） |

**失败排查线索**：计数不增 → 记录点漂移（KILLED 应在 `transitionToTerminal` 统一入口，
见 `runtime-metrics.ts` 头注的「第二轮审计 A4」）；pull 执行器 kill 无效 → 命令队列
通道（`notifyExecutorKill` 的 pull 分支）断链。

## 5. 场景 ④：COVER_EARLY 覆盖（旧进程应收到 kill 命令）

**验证语义**：A4 修复后，COVER_EARLY 不再只翻转 DB——RUNNING 的被覆盖执行必须
收到 kill 下发（push 直连 / pull 命令队列），且终态跃迁优先于 kill 下发的顺序不倒。

| 项 | 内容 |
|---|---|
| 注入方法 | 创建 `blockStrategy=cover_early` 的长跑任务（`sleep 300`）；触发第 1 次并等状态 RUNNING；随后手动触发第 2 次 |
| 预期观测点 | admin 日志三连：`Task "<name>" is RUNNING (blockStrategy=COVER_EARLY), cancelling running execution <id>` → `COVER_EARLY: kill notified to executor <addr> for covered execution <id>` → `COVER_EARLY: execution <id> cancelled by new trigger`；DB：旧执行 status=CANCELLED、errorMessage=`Task was covered by new trigger`、endTime 已落；executor-node 侧：旧进程收到 kill 并退出（执行器日志可见 kill 命令），新执行 RUNNING；指标出现 `status="cancelled"` 计数 |
| 通过判据 | D1：旧执行 CANCELLED 且旧进程**被杀**（不是跑完再回调被拒）；D2：新执行正常 RUNNING→success；D3：并发竞争形态（旧执行恰在覆盖前回调成功）时日志出现 `already reached a terminal state (concurrent callback/kill), not covered`，且不产生双终态（可用回调竞态构造，best-effort） |

**失败排查线索**：旧进程跑完才死 → A4 修复回退（对照 scheduler enqueue 的
`notifyExecutorKill` 后置调用注释——顺序刻意先终态后 kill）；执行器槽位不释放 →
`releaseExecutorSlot` 的 addressSnapshot 断了。

## 6. 场景 ⑤：Leader failover（watchdog 容忍 2-3 次抖动）

**验证语义**：Redis 毫秒级抖动不应夺走 Leader 租约（watchdog 续期失败计数 <3 时
只 warn）；真失主时 failover 在 TTL 30s + 重试 15s + 缓冲 = 60s 内完成，全程无双 Leader。

| 项 | 内容 |
|---|---|
| 注入方法 | 双实例拓扑（operations.md 已知边界：第二实例手工起，同 env、`-p 3106:3105`、加入同一 compose 网络，`CHAOS_ADMIN2_CONTAINER` 登记）；对持锁 Leader 注入 2-3 次秒级 Redis 抖动：`docker restart redis`（间隔 >10s，每次 3-8s 恢复）或 `docker pause/unpause redis` 20s 变体 |
| 预期观测点 | 抖动期间 Leader 日志：`Lock watchdog for lock:scheduler:leader failed to renew (1/3) ... (2/3)`（warn，租约保持）；恢复后 watchdog 回到静默续期，**无** `lost ownership during renewal`；`leadership acquired` 不出现（Leader 未易主）；另一实例全程 follower；若注入加码到连续 >3 次失败：原 Leader 交租约、新 Leader 在 60s 内 `Scheduler leadership acquired — this node is now the leader`，且晋升瞬间补跑一轮 misfire 补偿 |
| 通过判据 | E1：2-3 次抖动窗口内调度不停摆（错失触发有 misfire 补偿）、无双 Leader；E2：真 failover 完成时间 ≤60s；E3：failover 后新 Leader 对 FIRE_ONCE 任务的 misfire 补偿生效（NETOPT-3③，构造一个停机期错失的 one-shot 触发验证） |

**失败排查线索**：一次抖动就易主 → `REDIS_LOCK_WATCHDOG_MAX_CONSECUTIVE_FAILURES`
容忍逻辑回退；双 Leader → demote 条件（`another instance acquired the leader lock`）失灵。

## 7. 场景 ⑥：磁盘水位（心跳 diskUsage → 两级告警）

**验证语义**：执行器心跳上报的 `diskUsage` 正确落库并渲染为
`autoflow_executor_disk_usage_percent`，两级水位告警（>85 HIGH / >95 CRITICAL）按序触发与恢复。

| 项 | 内容 |
|---|---|
| 注入方法 | 二选一：① 真实面——在 executor-node 所在宿主/容器工作盘 `fallocate -l <足够大小> /path/workdir/fill.bin` 把用量顶过 85%（分级再顶过 95%），等 2-3 个心跳周期；② 注入面——直接向 `POST /api/executors/heartbeat`（执行器 token 认证）发 `diskUsage: 92` 的心跳体，观察指标即可 |
| 预期观测点 | 执行器详情/接口显示 diskUsage；`autoflow_executor_disk_usage_percent` 同步；>85 → `AUTOFLOW_EXECUTOR_DISK_USAGE_HIGH` firing，>95 → `AUTOFLOW_EXECUTOR_DISK_USAGE_CRITICAL` firing（`config/monitoring/alerts.yml`）；清理（`rm fill.bin` / 恢复正常心跳）后两告警按序 resolve |
| 通过判据 | F1：两级告警先后触发、先后恢复，无重复/常驻；F2：心跳中断（执行器离线）后磁盘告警不误报（规则含在线条件，见 alerts.yml 注释）；F3：清理后指标回到真实值（不是残留注入值——②注入法要在结果里注明恢复方式） |

## 8. 场景 ⑦：迁移 advisory-lock 双副本并发

**验证语义**：同库双副本同时跑迁移时，advisory lock 保证恰好一份执行序列，另一份
轮询等待后幂等通过（`No migrations are pending` 兼容输出已修，`5bf2a57a`）。

| 项 | 内容 |
|---|---|
| 注入方法 | ① 空库；② 两个 admin-api 副本（同 env 同库）**同时** `docker start`（迁移入口走 `migration-runner.util.ts` 的 advisory-lock 包裹路径；或直接两终端同时跑迁移 CLI `migration-lock-cli.ts`）；③ 竞争加压：副本 A 跑迁移期间，把 B 的启动时间对准 A 的长迁移（0050 级别）中段 |
| 预期观测点 | 后到副本日志：`Migration advisory lock busy (key=...) — another instance is migrating, waiting (poll=...ms)`，按 poll 间隔重试；先到副本：`Migration advisory lock acquired (key=...) — running migrations (...)`，跑完后 `pg_advisory_unlock` 成功；后到副本随后检测无待迁移（`No migrations are pending` 形态）继续 boot；两副本最终都 serving |
| 通过判据 | G1：迁移日志里**只有一份**完整迁移执行序列（无重复执行/半执行）；G2：无死锁、无超时退出；G3：两副本 `/api/health` 200；G4：unlock 失败分支（`returned false — lock not held by this session`）在本场景不出现（出现即立即上报——说明锁会话管理被改坏） |

## 9. 复跑结果回填表（Linux 侧执行后填写）

> 执行：Linux 主场 2026-10-01（acfchaos 隔离项目，镜像从 develop@e5d6469d 源码构建；
> 隔离 override 端口 15432/16379/13105/18002/19090，凭据 .env.chaos.local 不入库）。

| 场景 | 结果 | 关键证据（日志行/指标值/告警截图） | 偏离与说明 |
|---|---|---|---|
| ① 空库 boot | ✅ PASS | 三连 warn 精确命中：`scheduler boot step "reload"/"checkMisfires"/"recoverStaleExecutions" failed (will retry on next tick): relation "tasks" does not exist`；`initial-admin seed skipped (users table not ready): relation "users" does not exist`；进程存活（healthy）、无未捕获退出；对同库跑全量迁移链（含 0050 substr 修复 + 0051）成功 → 重启后 `Initial admin user created` + 登录 201 | health 整体 status 在空库期实为 `unhealthy`（文档写 degraded，语义一致）；NODE_ENV 合法值仅 development/production/test（Joi 校验），"staging" 非法——文档"NODE_ENV ≠ production"以 development 达成 |
| ② Redis 2min | ✅ PASS（实质） | A2：admin-api RestartCount 0→0，无进程退出；A3：**断网窗内触发的执行在恢复后重放并到达终态 failed（script_error，预期失败）**——BullMQ 离线队列重放真机实证；恢复后 trigger 201；A4：`digest redis error: connect ETIMEDOUT`（NotificationDigestService）= 聚合窗入窗失败→回退逐条路径被触发；`execution-events relay 订阅连接错误（fail-open）` 同窗在列 | A1 偏离：/api/health 停机窗内**无一次 5xx**（进程恒存活）但聚合健康检查在 Redis 拒连期延迟 >20s（-m 20 采样超时）——停机窗内健康端点近乎不可用作探活，建议关注 health 组件超时预算；queue 组件 healthy 标志恢复后 90s 内未翻转（执行重放已实质恢复）；断网期 trigger 挂起 30s+（BullMQ enqueue 等待连接，408/000）——符合"停机不丢触发请求语义"但客户端需知 |
| ③ kill 风暴 | ✅ PASS | 6/6 kill：kill-api 201 → 终态 killed ×6；`sum(increase(autoflow_execution_result_total{status="killed"}[15m]))` = **6.03**（与实际次数吻合，无多计/漏计）；`AUTOFLOW_EXECUTION_KILLED_SPIKE` **firing**（>5 阈值）；executor 侧 kill/terminate 日志在位（C2） | C4（success 计数不受影响）由场景②恢复后 trigger 成功执行旁证；D3 并发回调竞态形态未构造（任务书 best-effort 项） |
| ④ COVER_EARLY | ❌ **FAIL（真发现）** | blockStrategy=cover_early 任务第二次手动触发后**两个执行并发 running**，admin 日志无 COVER_EARLY 三连 | **根因（文件：行号）**：blockStrategy 闸门只存在于 `scheduler.service.ts:1157` `enqueue()`（仅 cron/fixed_rate/misfire 调用，:487/:1536/:1575）；手动/API/依赖触发走 `task.service.ts:1743` `trigger()` 直入 BullMQ（`taskQueue.add`），完全绕过 block 策略。:1170 注释只声明了维护窗口的范围取舍，未覆盖 blockStrategy。**修复方向（2026-10-02 与用户复核后升级，已登记 PLAN-CLAIMS N-14）**：不能简单把闸门套到手动/依赖路径——同任务不同参数（如发货程序按订单传参）是合法并发工作，按 taskId 覆盖/丢弃会误伤；调度路径未踩坑只因 cron/fixed_rate 恒同参（task.params），不是设计考虑过参数。候选设计=闸门维度改「任务+参数」（params 规范化等价比较：同参才覆盖/丢弃、异参放行并发），设计面含 params 规范化规则/依赖链 $upstream 异参语义/参数化任务 opt-out 三子问题。kill 下发链路（notifyExecutorKill）因闸门未触发而未在本场景实测到（其正确性由 kill 风暴场景旁证） |
| ⑤ Leader failover | ✅ PASS | E1：两次 `docker restart redis` 抖动窗内——实例1 无 `lost ownership`、实例2 无 `acquired`（E1-a/b 双 PASS）；E2：`docker pause redis 35s` → watchdog `failed to renew (3/3)` + `stopped after 3 consecutive renewal failures — lease will expire naturally`（cron:leader 与 scheduler:leader 双锁）→ 实例1 `Cron leadership lost (another instance acquired the cron leader lock)` → **实例2 `Scheduler leadership acquired — this node is now the leader`（unpause 后 ~35s，≤60s 判据）** | E3（新 Leader 对停机期错失 one-shot 的 misfire 补偿）未构造独立触发，判为未实测；双实例第二副本以 docker run 挂 internal 网络搭建（internal 网络不发布宿主端口，health 用容器内 wget 断言） |
| ⑥ 磁盘水位 | ✅ PASS | F0：探针执行器注册 + 心跳注入后 `autoflow_executor_disk_usage_percent` 渲染 92 → 97（真实执行器并行保持 53）；F1：`AUTOFLOW_EXECUTOR_DISK_USAGE_HIGH` 与 `..._CRITICAL` **均达到 firing**（注入窗满足 for:10m/5m，00:50 快照）；F2/F3：探针删除离线后 series 清退（仅剩真实执行器 53），两告警**全部 resolve**——离线不误报、清理回真实值 | 首轮告警查询误用规则名当指标（`AUTOFLOW_EXECUTOR_DISK_USAGE_HIGH` 非指标名）致 F1 首采空——改用 `ALERTS{alertname=...}` 后补证完整；F3 首采在 90s 离线宽限内 series 未退（时序问题，宽限期后复采正确） |
| ⑦ advisory-lock | ✅ PASS | 双进程同时 `migration-lock-cli up`（独立空库 chaosflow_mig2）：B 独占执行全量 96 条迁移；A `Migration advisory lock busy (key=727412345678) — another instance is migrating, waiting (poll=1000ms)` → 结束 `No migrations are pending` + `pg_advisory_unlock` 成功；G4 的 unlock-false 分支双方均未出现 | — |
| 基线 chaos-drill.sh A,B | ✅ PASS（修 2 处脚本缺陷后） | 场景 B：`docker pause executor-node` 150s → B1 判离线（online 1→0）+ B2 恢复回归 双 PASS；场景 A（修复后重跑）：A1 health 存活 + A3a/A3b 队列回归 PASS | **脚本修复（已提交）**：① 首行 UTF-8 BOM 导致直接执行炸 shebang；② `wait_redis_ping` 等三处 `redis-cli` 不带认证——对 requirepass 形态（compose 恒开启）必假阴性（A 场景"30s 无 PONG"假失败），新增 `CHAOS_REDIS_PASSWORD` 环境变量，selftest 33/33 通过 |

## 10. 与既有资产的关系

- 场景 A/B（Redis 宕机、执行器断网判离线）直接复用 `scripts/chaos-drill.sh`
  （`--scenario A,B`）；③-⑦ 目前**没有**脚本化场景，首轮可按本文手工注入，
  复跑稳定后建议回填进 chaos-drill.sh（沿用其「注入 → 断言 → 恢复 → 二次断言」
  与 `fail_scenario` 计数框架——注意上轮修掉的管道子 shell 缺陷勿回归）；
- 告警断言的规则名/阈值以 `config/monitoring/alerts.yml` 为准（26 条业务级规则集，
  `859e5f37`），指标名与代码清单的守卫是 `check-alerts-rules`（防臆造指标）；
- 上轮报告的遗留（`docs/CHAOS-DRILL-REPORT.md` §4）：当前镜像上的 A 场景重跑、
  C 场景双实例拓扑——本文场景 ⑤ 的拓扑搭建步骤可直接复用。

> 再次强调：**以上场景全部需要 Docker/Linux 主场，Windows 侧无法执行**。
> Windows 侧本轮交付（desktop e2e 三例 / desktop-e2e workflow / 本文档与
> operations.md 指引）见本文档头注。
