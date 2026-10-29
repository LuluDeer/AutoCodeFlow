# 第 3 轮并行审计汇总与实施清单（2026-10-29）

> 输入：7 份域报告的结构化结果（db / admin-web / runtime-perf / security / observability / ci-release / executors），
> 合计 **53 条 finding**（P1 5 / P2 33 / P3 15）。本文件是**汇总与排序**，不是第 8 份审计：
> 所有结论的取证与「未实测」标注都在各域报告里，这里只做去重、校准、冲突面分配、排期。
> 纪律：本文只新增这一个文件，**未改动任何源码**；工作区里已有的未提交改动均来自并行 agent，见 §1。

## 0. 输入口径

| 域 | 报告 | 条数 | P1 | P2 | P3 | 备注 |
|---|---|---:|---:|---:|---:|---|
| 数据库（schema/索引/迁移/计划） | [db.md](db.md) | 8 | 1 | 4 | 3 | 编号跳号（无 db-7/db-9），按原编号引用 |
| admin-web（交互/无障碍/包体） | [web-ux.md](web-ux.md) | 7 | 0 | 4 | 3 | — |
| 控制面运行时性能 | [runtime-perf.md](runtime-perf.md) | 8 | 0 | 6 | 2 | 全部为「常量 + 行数假设」估算，逐条标了未实测 |
| 安全 | [security.md](security.md) | 7 | 2 | 2 | 3 | 攻击链未动态复现（只读纪律） |
| 可观测性 | [observability.md](observability.md) | 8 | 1 | 6 | 1 | promtool / lhci / Grafana 均未实跑 |
| CI/CD 与发布工程 | [ci-release.md](ci-release.md) | 8 | 1 | 7 | 0 | 4 条在评审时已落地，见 §1 |
| 执行器（node/python） | [executors.md](executors.md) | 7 | 0 | 4 | 3 | 桌面端按并发纪律避让，未审 |
| **合计** | | **53** | **5** | **33** | **15** | 校准后 P1 = 6（rt-5 上调） |

**两个口径缺口，读结论前必须先知道：**

1. 归档目录里有 `sdk-dx.md`，但**没有进入本批结构化输入**（10 路并行中只汇到 7 路）。本文不臆测其内容，也未把它计入任何统计；合并进台账时需补一轮。
2. **热区被多个域主动回避**：`apps/admin-api/src/modules/agent/**`、`apps/executor-desktop/**` 两块（正在被另一个 agent 改）在 db / runtime / security / observability / executors 五份报告里都被显式跳过。所以「agent 域健康」这个结论**没有证据基础**，只能读作「本轮没看」。

## 1. 评审时对工作区的实测校正（防重复劳动，重要）

汇总时逐条对照了 HEAD `aefafd1d` + 工作区未提交改动。**以下 9 条的状态与报告正文不一致**，派发前按本表口径走：

| finding | 实测现状 | 证据 |
|---|---|---|
| db-1 | **主干修复已在工作区（未提交）**：0022/0049/0050/0051/0053/0055/0056 七条 `transaction=false` 迁移已加 `SET statement_timeout = 0` + `finally RESET`。**残差全未做**：无 `indisvalid` 自检（全仓零命中）、`check-index-drift.mjs` 无「CONCURRENTLY 必带豁免」静态断言、无 INVALID 索引 runbook | `git diff apps/admin-api/src/migrations/`；`grep -rn "CONCURRENTLY" migrations/` 命中 8 文件，唯 0054 只在类注释里提 CONCURRENTLY（非真调用），已核实 |
| CIR-01 | **部分已提交** `aefafd1d`：覆盖率 job 补 `--retryTimes=2`（ci.yml:232）。残差：PR 事件下覆盖率门仍不生效（分片 + nyc merge 未做） | `git show aefafd1d` |
| CIR-02 | **已提交** `aefafd1d`：新增 `desktop-selftests` job（ci.yml:1749-1766，随 push 跑 test:main + test:renderer）+ `check-desktop-selftests-wired` 判据④ | 同上 |
| CIR-03 | **已落地工作区（未提交）**：新增 `scripts/check-npm-audit-exemptions.mjs`，package.json 接线 `check:npm-audit(:selftest)`，ci-local 改调它 | `git status` / `git diff package.json` |
| CIR-04 | **已落地工作区（未提交）**：`scripts/ci-local.sh` 已补 `typecheck:specs`、`--coverage` 两处、acf-cli/mcp-server 的 build 前置、并改写过期头注 | `git diff scripts/ci-local.sh` |
| WEB-1 | **未修**：`vite.config.ts:161` 仍在，`dist/index.html` 仍 `modulepreload vendor-charts-Dn0XL3lI.js` | grep 两处 |
| WEB-3 | **未修**：`sse-client.ts` 全文无 `visibilitychange`/`visibilityState` | grep |
| OBS3-01 | **未修**：`grafana-dashboard.json:2333/:2485` 仍 `status="SUCCESS"`；`alerts.yml` 的 `runbook_url` 仍 0 条（阅读版 `runbook:` 14 条） | grep -c |
| db-2 / db-3 | **未修**：迁移里没有任何 `ON "tasks"` 的 `createdAt` 索引；`event_outbox` 仍只有 dispatchedAt/nextAttemptAt/eventId/leaseUntil 四个单列索引 | grep 迁移 DDL |
| rt-5 | **未修**：`auth.service.ts:656` 的执行体仍无 try/catch（`leaderGate` 之后直接 `await repo.delete`）。**口径差一**：实测 `@Cron(` 25 处（报告写 26），其中 3 处在 `modules/agent/**`（热区） | grep + sed |

> 结论：**CI 域的 P1/P2 主体已被并行工作区吃掉**，db-1 的止血也被吃掉一半。本轮 top 清单据此重排，不再重复这些已落地的工作，只排「残差」与「没人动」的部分。

## 2. 校准

### 2.1 上调 1 条

| id | 原判 | 现判 | 理由 |
|---|---|---|---|
| rt-5 | P2 | **P1** | 5 处 `@Cron` 无顶层异常闸，任一 `await` reject → 无 catch → `main.ts` 的 `unhandledRejection` → `gracefulFatalShutdown()` → `exit(1)`。这不是性能问题而是**可用性事故**：`detectStuckDeployments` 每 2min（720 次/天）、`detectLostExecutions` 每 5min（288 次/天）各暴露一次，池排队 waiting=280 水位下瞬态 DB 错误是常态。P1 判据「静默失效」成立——崩溃会重启，但每次重启都在打断在跑的执行。 |

### 2.2 合并 6 组（同一根因 / 同一落点，保留信息量最大的一条）

| 合并后 | mergedFrom | 合并理由 |
|---|---|---|
| `SEC-R3-1/2/3` | SEC-R3-1 + SEC-R3-2 + SEC-R3-3 | **同一根因**：机器面把「集群共享令牌」当 per-executor 等价凭据，`authz.via` 全仓无消费方。三个落点（heartbeat/register 回传 tokenHash、pull 取走含明文 secrets 的队列、RT-LOG 注入他人日志）修法同构：**凭据外发/私有数据读取面要求 `via==="per-executor"`**。拆成三条会做三遍同一判定 |
| `db-1+db-5` | db-1 + db-5 | 同一落点（`apps/admin-api/src/migrations/**` + 迁移守卫链）与同一负责人；db-1 残差是「发现机制」，db-5 是「存量两条大表 DDL 不合纪律」，一个 PR 收口迁移安全面。db-5 的 0073 必须先去重再 `CREATE UNIQUE INDEX CONCURRENTLY`（不能同事务），与 db-1 的 timeout 豁免是同一套写法 |
| `db-2+db-10` | db-2 + db-10 | 同一端点 `GET /tasks`、同一文件 `task.service.ts`、同一条迁移 + 同一次排序改造：缺 `(createdAt,id)` 索引（db-2）与 OFFSET 分支缺 id 决胜键（db-10）是同一个分页契约的两半，分开做会出现「加了索引仍漏行」 |
| `db-3+rt-6` | db-3 + rt-6 | 同一子系统 `outbox-dispatcher`：claim 查询无匹配 partial index（db-3）与恢复吞吐 5 行/5s 对不上入队面（rt-6）是同一个「claim 形状」问题；rt-6 的积压计数正需要 db-3 的 partial index 才便宜。附带的文档漂移（矩阵写 batch=1，实为 5）同批改 |
| `rt-3+rt-7` | rt-3 + rt-7 | 同一文件 `task.service.ts` 的两个「日志数据面读放大」：终态事件载荷带 ≤512KB logs（rt-3）与日志 SSE 的 `findOne` 整行含 logs（rt-7）。一个是出口投影、一个是入口投影，一次改完 |
| `rt-4+OBS3-03+rt-8` | rt-4 + OBS3-03 + rt-8 | 同一族：SSE 服务端「每条连接各自一套循环」+ 容量分母缺席。rt-4 把取数改成单快照泵（O(连接)→O(1)）、OBS3-03 让 `sse_streams_limit` 在零流副本上也有值（否则 Σ 分母缺项）、rt-8 顺手把 1s 空转定时器改事件驱动。三处都在 `metrics/*stream*`，验证命令同一条 |
| `WEB-1+WEB-3+WEB-5` | WEB-1 + WEB-3 + WEB-5 | 三条都 S 级、都在 `apps/admin-web/**`、互不重叠，合成一个「前端三小修」PR 由同一人做，避免三次上下文切换（recharts 预载 / 后台标签页停 SSE / 设置页错误态） |
| `OBS3-04+OBS3-05+OBS3-06` | OBS3-04 + OBS3-05 + OBS3-06 | 都是「告警跑不通的那一段」：5xx 日志缺 route（runbook 让你按 route 过滤，做不到）、取数失败零日志零指标、`runbook_url` 一条没接线（阅读版 14 条 `runbook:` 从不被读）。三条都 S 级且都在 `config/monitoring` + 各自一处代码，合成一批 |

### 2.3 降级 / 不独立立项（4 条剔除结论，2 条不单列）

见 §7。原则：**没有证据支撑的幅度/因果一律不进清单**，只保留可复核的代码事实与可验证的结构结论。

### 2.4 已落地 → 不再派发（4 条）

CIR-01（残差另记）、CIR-02、CIR-03、CIR-04。其中 CIR-03/04 仍在工作区未提交，**先去评审提交，不要重做**；CIR-01 的残差（PR 覆盖率门 = 分片 `--coverage` + `nyc merge`）单独立项，不混在缺陷修复里。

## 3. 实施清单（top 12，按建议顺序）

排序规则：**P1 先行 → 同档按「静默性 × 成本」**（会静默出错数据的排前，越便宜越前）→ **热冲突项靠后并串行**。
工作量：S ≤1h / M 半天 / L >1 天。冲突：`hot` = 与并行 agent 写域（agent runtime/tools/desktop）或当前 dirty 的迁移/脚本重叠，`warm` = 同文件邻近需串行，`cold` = 无重叠。

| 序 | id | 域 | P | 量 | 冲突 | 一句话 |
|---:|---|---|---|---|---|---|
| 1 | OBS3-01 | observability | P1 | S | cold | 看板用大写 `SUCCESS` 过滤小写枚举 → 成功率面板永远 No data、异常面板反把成功算进去 |
| 2 | SEC-R3-1/2/3 | security | P1 | M | warm | 共享令牌被当 per-executor 凭据：可轮换他人明文令牌、读走他人回调密钥、取走含明文 secrets 的队列载荷 |
| 3 | rt-5 | runtime | **P1** | M | warm | 5 处 `@Cron` 无异常闸，一次瞬态 DB 错误 = 整实例 `exit(1)` |
| 4 | db-1+db-5 | db | P1 | L | hot | 迁移安全面收口：INVALID 索引无人发现 + 两条大表非并发 DDL 会在 boot 上锁/超时 |
| 5 | rt-3+rt-7 | runtime | P2 | S | warm | 终态事件带 ≤512KB logs 广播，唯一消费方只要首行；日志 SSE 每次轮询整行含 logs |
| 6 | rt-4+OBS3-03+rt-8 | runtime/obs | P2 | M | warm | `/metrics/stream` 每条连接每 3s 各跑 7 条 SQL；且容量分母只在抢到槽位的副本上存在 |
| 7 | rt-2 | runtime | P2 | M | warm | S3 日志背填每页「读回整对象→拼接→`gzipSync` 全量」：O(页数²) + 秒级阻塞事件循环 |
| 8 | db-2+db-10 | db | P2 | M | hot | `GET /tasks` 既没有 `(createdAt,id)` 索引也没有 id 决胜键：慢 + OFFSET 翻页漏行重行 |
| 9 | db-3+rt-6 | db/runtime | P2 | M | hot | outbox claim 无匹配 partial index，且恢复吞吐 5 行/5s 落后入队面 1.5-2 个数量级 |
| 10 | WEB-4 | admin-web | P2 | M | cold | 审批单只显示 160 字符理由、从不显示入参，而「批准」单击即执行——盲签具体参数 |
| 11 | WEB-1+WEB-3+WEB-5 | admin-web | P2 | S | cold | recharts 进首屏预载（108.3 KB gz）、后台标签页三条 SSE 不断开、设置页把读取失败渲染成「没配置」 |
| 12 | OBS3-04/05/06 | observability | P2 | S | cold | 5xx 日志没有 route/traceId、指标取数失败静默保留旧值、31 条告警 0 条 `runbook_url` |

> 下文与 §4 索引里的 `T1`…`T12` 即指本表序 1…12。

### 逐条展开

#### 1. OBS3-01 — 看板 status 大小写（P1 / S / cold）

- **落点**：`docs/observability/grafana-dashboard.json:2485`（面板 702 成功率）、`:2781`（面板 705 异常绝对值）、`:2333`/`:2519`（value mapping）；契约侧 `apps/admin-api/src/modules/metrics/runtime-metrics.ts:24-30`、`apps/admin-api/src/modules/task/execution-terminal.ts:201-203`（枚举小写 `success`）。
- **最小修法**：两处 `SUCCESS` → `success`，同步 value mapping；面板 702 补 `fieldConfig.defaults.noValue`。**顺手把判据做成守卫**：新 spec 用 `fs` 读 dashboard JSON + `alerts.yml`，抽 `metric{label="value"}` matcher 断言取值 ∈ `RUNTIME_COUNTERS[metric].labelValueSets`（同型先例 `common/middleware/__tests__/observability-hygiene.guard.spec.ts`）。
- **验证**：`npx jest src/modules/metrics --silent`；反证——把 expr 改回 `SUCCESS` 必须转红。现有 `check-alerts-rules.mjs` 只比指标名，看不见 label 取值，故必须加 spec 而不是改守卫。
- **为什么排第一**：一改就恢复「成功率」这条被反复引用的容量前提（白皮书的 95% 门就架在它上面），成本不到一小时。

#### 2. SEC-R3-1/2/3 — 共享令牌的越权面（P1 / M / warm）

- **落点**：`apps/admin-api/src/modules/executor/executor.controller.ts:509`（heartbeat 回传 tokenHash）、`:586-600`（`/executors/pull` 不看 `authz.via`）、`executor.service.ts:7380`（共享令牌分支）、`:2941`（register 非幂等轮换并回传明文）、`:7557`（`getCallbackSecretById` 直返 tokenHash）、`task/execution-callback.controller.ts:479-497`（RT-LOG 共享令牌兜底不校验归属）。
- **最小修法**：统一一条判据——**返回凭据或行私有数据的机器面，必须 `authz.via === "per-executor"`**，共享令牌一律 403（复用 `INVALID_EXECUTOR_TOKEN` 避免新增可枚举面）。① heartbeat/register 在 shared 分支 `tokenHash`/`perExecutorToken` 返回 null，且该行已有 tokenHash 时禁止轮换；② pull / agent-collab/poll / terminal-states 的 shared 分支只允许取 commands、拒绝 `wantTask`（`EXECUTOR_ALLOW_SHARED_TOKEN_READ_FACES` 默认 false 兜底）；③ RT-LOG 只接受 v1 令牌或该行 per-executor 令牌。
- **验证**：新增 `pull.shared-token.spec`（shared + 他人 address → 403 且队列长度不变）、heartbeat spec（shared → `tokenHash === null`）、RT-LOG spec（shared + 他人 execId → 403 且 `execution_log_lines` 行数不变）。守卫链跑 `npm run test:guards:repo`，并确认 `apps/admin-api/src/common/guards/__tests__/route-authz-matrix.spec.ts` 覆盖到这三条路由（新端点要进矩阵，否则又是一次「写了不接线」）。
- **注意**：这条**不需要改共享令牌模型**（ARCH-36-R3 已登记其上限），只收窄「共享凭据能做什么」，兼容旧执行器。

#### 3. rt-5 — cron 异常闸（P1 上调 / M / warm）

- **落点**：`auth/auth.service.ts:656`、`audit/audit.service.ts:151`、`executor/executor.service.ts:6135`（detectLostExecutions）、`:6256`（stuck deployments）、`application/app-deployment.service.ts:2913`。对照 `scheduler.service.ts` 的 4 处已是 `await this.guardTick(...)` 一行。
- **最小修法**：把 `guardTick` 语义提升为公共设施 `common/utils/cron-guard.util.ts`（`guardedCron(name, logger, body)`），5 处套上；新增 `scripts/check-cron-guard.mjs` 机械闸（扫 `@Cron` 方法体必须有 try/catch 或调用 `guardedCron`）并挂进 `test:guards:repo`。**注意**：实测 25 处 `@Cron`，其中 `modules/agent/**` 3 处属热区——守卫先只覆盖非 agent 的 22 处，agent 的 3 处等并行 agent 收工后再纳（否则会把它正在写的文件判红）。
- **验证**：`node scripts/check-cron-guard.mjs --selftest && node scripts/check-cron-guard.mjs`；反证——还原 `auth.service.ts` 后守卫必须报出这 5 处；单测 mock repo 抛错，断言 cron 方法 **resolve** 且 `logger.warn` 被调。

#### 4. db-1+db-5 — 迁移安全面收口（P1 / L / hot）

- **落点**：`apps/admin-api/src/migrations/1790000000061-*.ts:33-42`（普通 `CREATE INDEX` 在事务内持 SHARE 锁）、`…0073-*.ts:33-43`（全表去重 DELETE + 唯一索引同事务）；残差面 `apps/admin-api/src/main.ts:171`（boot 迁移之后）、`scripts/check-index-drift.mjs`、`docs/`（runbook）。
- **已修部分**（不要重做）：7 条 `transaction=false` 迁移的 `SET statement_timeout = 0` + `finally RESET` 已在工作区。
- **最小修法**：① 启动自检——迁移执行器之后 `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid`，非空则 ERROR + 计数器（这是唯一能发现「`IF NOT EXISTS` 命中 INVALID 索引」的手段，全仓 `indisvalid` 目前零命中）；② `check-index-drift.mjs` 加静态断言：含 `CONCURRENTLY` 的迁移必须同时有 `transaction=false` 与 `statement_timeout` 豁免（不依赖 DB，可进 CI）；③ 0061 改 `transaction=false` + `CREATE INDEX CONCURRENTLY`；④ 0073 拆两步：去重 DELETE 改分批（复用 `cappedBatchedDelete`）+ timeout 豁免，再在**独立** `transaction=false` 迁移里 `CREATE UNIQUE INDEX CONCURRENTLY`；⑤ 补运维 runbook：已存在的 INVALID 索引 `DROP INDEX CONCURRENTLY IF EXISTS` 后重建，或 `REINDEX INDEX CONCURRENTLY`（down 不还原被删重复行要写进头注）。
- **验证**：`node scripts/check-index-drift.mjs --selftest && node scripts/check-index-drift.mjs`、`node scripts/check-migrations.mjs`、迁移 spec（断言含 CONCURRENTLY 的文件带豁免）；自检用单测 mock `pg_index` 返回一行断言 ERROR。
- **冲突 hot**：`migrations/**` 与 `scripts/check-migrations.mjs` 当前 dirty（另一个 agent 正在改 0022/0049/…/0056）。**动手前先取号**（下一个时间戳 1790000000075）并与该 agent 串行，避免新迁移编号撞车。

#### 5. rt-3+rt-7 — 日志投影（P2 / S / warm）

- **落点**：`task/task.service.ts:5146-5156`（载荷带 `logs`，DTO 上限 `dto/execution-callback.dto.ts:159` `@MaxLength(512_000)`）、`:4084`（日志 SSE 的 `findOne` 无 select）；消费侧 `notification/execution-events.listener.ts:88`、转发侧 `executions-stream.controller.ts:112-115`、`execution-events-relay.service.ts:199-202`。
- **最小修法**：`emitTerminalEvent` 把 `logs` 换成派生字段 `logHead`（首行硬切 500 字符，与 `errorSummary` 同上限），从 `ExecutionTerminalEventPayload` 删除 `logs`；listener 改读 `logHead` 去掉 `.split("\n")[0]`；relay 的 publish 加 payload 大小护栏（>8KB warn）；`flush()` 的 `findOne` 加 `select: { id, status, taskId, logStorage, logObjectKey }`。
- **验证**：`npx jest src/modules/task --silent`；反证——单测喂 `cb.logs` = 512KB，断言 emit 的 payload 无 `logs` 且 `logHead.length ≤ 500`；另一条断言 `findOne` 的 select 键集不含 `logs`。`viaRelay` 载荷、admin-web 消费方、既有断言三处要同改。

#### 6. rt-4+OBS3-03+rt-8 — SSE 扇出与容量分母（P2 / M / warm）

- **落点**：`metrics/metrics-stream.controller.ts:130-178`（每连接一套 3s 循环）、`metrics/metrics.service.ts:55-86`（每拍 6 条 SQL，含 2 条 30 天窗口聚合）、`:140-154`（`getExecutorStats` 无投影全表 `find()`）、`task/task.service.ts:4007`（`sse_streams_limit` 只在 `acquireSseSlot` 成功路径写）、`config/monitoring/alerts.yml:203`（Σ(active)/Σ(limit)）、`metrics/executions-stream.controller.ts:136-143`（1s 空转定时器）。
- **最小修法**：① **单一快照泵**：进程内 3s 算一次 `snapshot()`，再 `for(conn) conn.write()`——连接只订阅不取数，成本从 O(连接) 降到 O(1)；② `getSummary` 的 GROUP BY + AVG 合成一条（`AVG(duration) FILTER (WHERE status='success')`）；③ `getExecutorStats` 加 8 列 select 白名单；④ `TaskService`/`MetricsStreamSlotService` 在 `onModuleInit` 发布一次 `active=0, limit=<config>`；⑤ 空闲 ping 改单定时器事件驱动（收帧即重置），保持 `metrics-stream` 与 `executions-stream` 口径一致。
- **验证**：`npx jest src/modules/metrics --silent`；反证——开 2 条连接断言 `getSummary` 每拍只被调 1 次；零流状态下 `curl /api/metrics | grep '^autoflow_sse_streams_limit'` 必须有值；`jest.getTimerCount()` 断言每连接只有 1 个活跃 timer。

#### 7. rt-2 — S3 日志背填（P2 / M / warm）

- **落点**：`task/task.service.ts:4728-4737`（每页读回 + 拼接 + 覆盖写，挂在回调请求内）、`task/log-storage/s3-log-storage.ts:84`（`gzipSync` 同步压缩）；常量 `:4922` `MAX_PAGES=200`、`:21` `MAX_LOG_BYTES=100MB`。
- **最小修法**：① **一行止血**：`gzipSync` → `await promisify(gzip)(buf)`（走线程池，消掉秒级全进程停摆）；② 结构性：append-in-place 改为每页独立对象（`execution-logs/<id>/part-N.log.gz`）+ manifest，读面流式拼接，消 O(P²)；③ 保守版兜底：`MAX_PAGES` 200→20 并显式标注截断。
- **验证**：`npx jest src/modules/task/log-storage --silent`；反证——`jest.spyOn` 断言异步 gzip 被调用；结构化那步断言 `put` 调用次数 = 页数且每次 body ≤ 单页。
- **注**：与既有 W-5（读面深翻页）、BUG-06（append 正确性）同代码路径但不同轴，别合并成一个 PR。

#### 8. db-2+db-10 — `GET /tasks` 的分页契约（P2 / M / hot）

- **落点**：`task/entities/task.entity.ts:129`（未命名 `@Index(["createdAt"])` 死声明）、`task/task.service.ts:2039-2061`（keyset 分支 + 每页 `getCount()`）、`:2208-2211`（OFFSET 分支只有单键排序）、`:1789`（默认 `{ createdAt: "DESC" }`）；同文件 `:3282-3285` 是已修好的对照（FIX-5.3），`audit.service.ts:175-177` 同型。
- **最小修法**：新迁移 `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_created_at_id" ON "tasks" ("createdAt" DESC, "id" DESC)`（按 db-1 的写法带 timeout 豁免）；实体改显式命名 `@Index("idx_tasks_created_at_id", ["createdAt","id"])` 以进入 `check-index-drift` 比对集；OFFSET 分支补 `.addOrderBy("task.id", dir)`；每页 `getCount()` 改「首页才取 total，翻页用 hasMore」；抽 `applyStableOrder(qb, pk, dir)` 供 tasks/executions/audit 三处共用。
- **验证**：`node scripts/check-index-drift.mjs`（命名后不再落进「未命名不比对」的 25 条盲区）+ `node scripts/check-migrations.mjs` + specs 断言组装 SQL 含 `"task"."id"`（不需真库）；`npx jest src/modules/task --silent -t order`。
- **冲突 hot**：新迁移要取号（见第 4 条）；`task.service.ts` 与第 5 条同文件，**串行做**（先第 5 条再本条）。

#### 9. db-3+rt-6 — outbox claim 与恢复吞吐（P2 / M / hot）

- **落点**：`event-subscriptions/outbox-dispatcher.service.ts:294-313`（claim CTE 谓词）、`:68/77/82`（5s / batch 5 / 并发 3）、`:520-533`（死信只置 `deadLettered`，`dispatchedAt` 仍 NULL，保留 90 天）、`:282`（`scanning` 整轮丢弃）、`docs/ARCH-MULTI-INSTANCE-MATRIX.md:191`（写 batch=1，实为 5）。
- **最小修法**：① 加与谓词逐字对应的 partial index（CONCURRENTLY + 豁免）：`ON "event_outbox" ("createdAt") WHERE "dispatchedAt" IS NULL AND "deadLettered" = false`，实体补同名显式 `@Index`；② 恢复吞吐与积压挂钩：`batchSize = clamp(backlogDepth/100, 5, 100)`（深度用 5s 节流的 COUNT）、并发 `min(batchSize,10)`，租约安全由 `OUTBOX_LEASE_MS=60s > 单行 15s 上界` 的构造期断言保证；③ 暴露 `autoflow_outbox_undispatched_total` 与 `drain_rate_per_s`（让「积压 × 速率」可算 ETA）；④ 校正矩阵文档并写清 1→5 的取舍。
- **验证**：`npx jest src/modules/event-subscriptions --silent` + 迁移 spec 断言 claim SQL 的 WHERE ⊆ 索引谓词；反证——积压 1000 行时断言 claim 的 `LIMIT` 参数 > 5；`node scripts/check-metric-docs.mjs`（新增指标要进文档）。
- **冲突 hot**：同样要取号；`check-metric-docs` 的 baseline 变动与第 12 条同批。

#### 10. WEB-4 — 审批的决策依据（P2 / M / cold）

- **落点**：`apps/admin-web/src/pages/AgentSessionsPage.tsx:465-472`（`reason.slice(0,160)`，hover 取同一串）、`:431`（`argsJson.slice(0,160)`）、`:504`（`onClick={() => void decideApproval(a.approvalKey,'grant')}` 单击即执行）；后端理由模板 `agent/boundary/agent-boundary.service.ts:245-258`。
- **最小修法**：① 审批行按 `toolCalls.find(c => c.approvalId === a.approvalKey)` 关联，渲染 `argsJson` 的结构化键值视图（`awaiting_approval` 台账行挂起前已落库带 args+approvalId，detail 已返回 toolCalls，**纯前端可做**）；② 去掉 `.slice(0,160)`，改 `Typography.Paragraph ellipsis={{rows:3,expandable:true}}` 或 Tooltip 挂全文；③ 「批准」前加 `Modal.confirm`，正文列 toolName + 参数摘要 + 「立即执行且不可撤销」；拒绝保持单击。
- **验证**：`npx vitest run src/pages/AgentSessionsPage` + 新用例（pending 审批显示入参且不截断 / grant 需二次确认）。`lint:i18n` 双语气（新增词条）。
- **注**：与 TOOLS-02 / R3-B-12（审批闭环能否走通）不同条——那两条是流程，本条是流程走通之后（225ab7a6/d249b5c2/e23125b5）的决策依据缺口。

#### 11. WEB-1+WEB-3+WEB-5 — 前端三小修（P2 / S / cold）

- **落点**：`apps/admin-web/vite.config.ts:161`（`['vendor-charts',['recharts']]`）→ `dist/index.html:26` 的 modulepreload，实测 382.0 KB raw / 108.3 KB gz，占首屏 623.9 KB gz 的 17.3%，而 recharts 只被 3 个 lazy 页面消费；`src/api/sse-client.ts:188-227`（只有 `connect`/`onerror`，全文无 `visibilitychange`）；`src/pages/settings/AiProvidersSettings.tsx:51-63`（唯一失败处理是 `showApiError`，`data` 保持 null → 空表）与 `:204-228`。
- **最小修法**：① 删 `vendor-charts` 那行（与 PERF-01 对 monaco 同构），把守卫扩成 `first-paint-no-unused-vendor`（断言 preload 不含 `vendor-charts`/`GlueEditor`）；② `createSseClient` 内挂 Page Visibility：hidden → `es?.close(); es=null; clearTimer(); paused=true`（**不要**走 `scheduleReconnect`，否则后台每 30s 重建）；visible 且 paused → `attempt=0; void connect()`（隐藏不是失败，不继承退避）；`close()` 里 `removeEventListener`；③ `AiProvidersSettings` 加 `loadError` 状态，渲染 `<StateError onRetry={() => void load()} />` 且 error 时**不渲染空表与分配区**，补 zh/en 词条。
- **验证**：`npx vitest run src/api/sse-client src/pages/settings` + 新用例（`visibilitychange` → 断言 `EventSource.close` 被调且无退避定时器；回前台断言重连且 `attempt` 归零；mock `listProviders` reject → 出现 StateError 且无空表）；构建后 `grep -c vendor-charts dist/index.html` 必须为 0，并 `du -k dist/assets/*.js` 确认没被复制成两份。

#### 12. OBS3-04/05/06 — 告警链路的三处断点（P2 / S / cold）

- **落点**：`common/filters/http-exception.filter.ts:181-184`（5xx 日志只有 message+stack，无 method/path/errorCode/traceId；`request.url` 只进响应体 `:194`）；`modules/metrics/prometheus-metrics.service.ts:657`/`:698`（`catch { return; }` 保留旧值，该类从 :74 到 :705 无一条日志）、`:633-639`（池句柄不可读渲染成 `max=0`）；`config/monitoring/alerts.yml`（31 条 `- alert:`，`runbook_url` **0 条**）与 `docs/observability/alerting-rules.yml:63`（14 处 `runbook:` 从不被读）、`notification/alert-webhook.mapping.ts:106`（只认 `runbook_url`）。
- **最小修法**：① 5xx 出口统一 `Unhandled exception: ${method} ${url.pathname} [${errorCode ?? "NO_CODE"}] trace=${traceId ?? "-"}: ${msg}`（**去 query**，避免把 SSE 票据写进日志），`QueryFailedError` 两分支同样补；② 指标服务注入 Logger + 两个 catch 改限流 warn，新增 `autoflow_metrics_render_error_total{query}`（走 `recordRuntime`，登记 `labelValueSets`，文档同步）；③ 31 条各加 `runbook_url: <绝对 URL>#<alertname 小写>`，`extractRunbookUrl` 加回退 `annotations.runbook_url ?? annotations.runbook`，守卫升级为「接线版每条必须有 http(s) 绝对 URL」。
- **验证**：`npm run test:alerts`（`check-alerts-rules.mjs` 三层对账）+ `npx jest src/common/filters src/modules/metrics --silent` + `node scripts/check-metric-docs.mjs`；反证——把一条 `runbook_url` 写成相对路径，守卫须转红。

## 4. 全量 finding 索引（53 条，处置一栏是唯一口径）

> 落点取主落点（完整清单见各域报告）。处置：`T#` = top 清单第 # 条；`D` = deferred；`R` = 剔除/降级结论；`已落地` = 无需再派。

### 4.1 db（8）

| id | P | 落点 | 处置 |
|---|---|---|---|
| db-1 | P1 | `migrations/1790000000049-*.ts:33-40`、`main.ts:171` | **T4**（工作区已修 7 条迁移的超时豁免，残差＝自检+守卫+runbook） |
| db-2 | P2 | `task/task.service.ts:2039-2061`、`task.entity.ts:129` | **T8** |
| db-3 | P2 | `event-subscriptions/outbox-dispatcher.service.ts:294-313` | **T9** |
| db-5 | P2 | `migrations/…0061:33-42`、`…0073:33-43` | **T4** |
| db-10 | P2 | `task/task.service.ts:2208-2211` | **T8** |
| db-4 | P3 | `ai/ai-sop-session.service.ts:113-118` | D（并入「列表读面族」：索引 + 投影，与 db-8 同批） |
| db-8 | P3 | `artifacts/artifacts.service.ts:246-251` | D（同上，需 keyset 立项） |
| db-6 | P3 | `application/application.service.ts:217-228` | D + R（与台账 R4-A-12 同源，只补索引面，不单列） |

### 4.2 admin-web（7）

| id | P | 落点 | 处置 |
|---|---|---|---|
| WEB-1 | P2 | `apps/admin-web/vite.config.ts:161`、`dist/index.html:26` | **T11** |
| WEB-3 | P2 | `src/api/sse-client.ts:188-227` | **T11** |
| WEB-4 | P2 | `src/pages/AgentSessionsPage.tsx:465-472/:504` | **T10** |
| WEB-5 | P2 | `src/pages/settings/AiProvidersSettings.tsx:51-63` | **T11** |
| WEB-6 | P3 | `src/pages/AgentSessionsPage.tsx:665-700` | D（无障碍批次）+ R（「门禁假绿」副结论剔除） |
| WEB-2 | P3 | `apps/admin-web/nginx.conf:2`、`dist/index.html:20-47` | D（先定部署面要不要 h2） |
| WEB-7 | P3 | `src/i18n/index.ts:20-35` | D（F-42 取舍未定案，先只更正注释里的体积数字） |

### 4.3 runtime-perf（8）

| id | P | 落点 | 处置 |
|---|---|---|---|
| rt-1 | P2 | `executor/executor.service.ts:6135-6246` | D（异常闸由 T3 覆盖；keyset/select/重入闸需实测内存预算）+ R（OOMKill 幅度剔除） |
| rt-2 | P2 | `task/task.service.ts:4728-4737`、`log-storage/s3-log-storage.ts:84` | **T7** |
| rt-3 | P2 | `task/task.service.ts:5146-5156` | **T5** |
| rt-4 | P2 | `metrics/metrics-stream.controller.ts:130-178` | **T6** |
| rt-5 | P2→**P1** | `auth/auth.service.ts:656` 等 5 处 | **T3** |
| rt-6 | P2 | `outbox-dispatcher.service.ts:68/77/82`、`ARCH-MULTI-INSTANCE-MATRIX.md:191` | **T9** |
| rt-7 | P3 | `task/task.service.ts:4084` | **T5** |
| rt-8 | P3 | `metrics/executions-stream.controller.ts:136-143` | **T6** + R（不单列，审计自述不构成容量问题） |

### 4.4 security（7）

| id | P | 落点 | 处置 |
|---|---|---|---|
| SEC-R3-1 | P1 | `executor/executor.service.ts:7380/:2941`、`executor.controller.ts:509` | **T2** |
| SEC-R3-2 | P1 | `executor.controller.ts:586`、`executor-pull.service.ts:585/604` | **T2** |
| SEC-R3-3 | P2 | `task/execution-callback.controller.ts:479-497` | **T2** |
| SEC-R3-4 | P2 | `common/utils/webhook-hmac.util.ts:65-80` | D（需幂等键契约 + 先确认公网暴露面） |
| SEC-R3-5 | P3 | `task/task.service.ts:1094`、`write-guard-enforcement.interceptor.ts:73-85` | D（今日不可利用；随下次 guard 重构） |
| SEC-R3-6 | P3 | `executor-python/Dockerfile:5`、`requirements.txt:5`、`docker-compose.yml` | D（并入供应链批次：CIR-05/07/08） |
| SEC-R3-7 | P3 | `executor/executor.service.ts:7684` | D（需一次性 bootstrap token 端点，feature 级） |

### 4.5 observability（8）

| id | P | 落点 | 处置 |
|---|---|---|---|
| OBS3-01 | P1 | `docs/observability/grafana-dashboard.json:2485/:2781` | **T1** |
| OBS3-02 | P2 | `agent/runtime/agent-runtime.service.ts:515` | D（**热区**：等并行 agent 收工按新行号重做） |
| OBS3-03 | P2 | `task/task.service.ts:4007`、`alerts.yml:203` | **T6** |
| OBS3-04 | P2 | `common/filters/http-exception.filter.ts:181-184` | **T12** |
| OBS3-05 | P2 | `metrics/prometheus-metrics.service.ts:657/:698` | **T12** |
| OBS3-06 | P2 | `config/monitoring/alerts.yml`、`alert-webhook.mapping.ts:106` | **T12** |
| OBS3-07 | P2 | `common/middleware/trace-id.middleware.ts:13`、`common/trace/trace.module.ts` | D（删死代码 + 让 `req.traceId` 有消费者，随 T12 的日志行一起做更省） |
| OBS3-08 | P3 | `agent/runtime/agent-runtime.service.ts:305/442/458` | D（**热区**，同 OBS3-02） |

### 4.6 ci-release（8）

| id | P | 落点 | 处置 |
|---|---|---|---|
| CIR-01 | P2 | `.github/workflows/ci.yml:172` | 已落地（`aefafd1d` 补 `--retryTimes`）；残差 D（PR 覆盖率门 = 分片冒烟 + 合并闸） |
| CIR-02 | P1 | `ci.yml:1742/1767/1777` | 已落地（`aefafd1d`：`desktop-selftests` job + 判据④），仅需回归 |
| CIR-03 | P2 | `scripts/ci-local.sh:186-193` | 已落地工作区（`check-npm-audit-exemptions.mjs`），待评审提交 |
| CIR-04 | P2 | `scripts/ci-local.sh:130-135` 等 | 已落地工作区（五处对齐），待评审提交 |
| CIR-05 | P2 | `.github/workflows/*.yml` 的 132 处 `uses:`、`ci.yml:524` | D（供应链批次，见下） |
| CIR-06 | P2 | `deploy.sh:1457/:1463-1512` | D（需 staging 演练 + 交互决策，代码内无法自证） |
| CIR-07 | P2 | `deploy.sh:1448-1458`、四个 app Dockerfile | D（供应链批次，需重建镜像窗口） |
| CIR-08 | P2 | `.github/workflows/release.yml:164-171` | D（需 npmjs 侧登记，发版窗口） |

### 4.7 executors（7）

| id | P | 落点 | 处置 |
|---|---|---|---|
| EXEC-01 | P2 | `executor-python/routers/execute.py:77-90` | D（潜伏：SDK 不可 import）+ R（「每个任务 500」剔除） |
| EXEC-02 | P2 | `executor-python/routers/execute.py:916-924` | D（需进程隔离重构 + 复现构造）+ R（「永久挂起」因果强度剔除） |
| EXEC-03 | P2 | `executor-node/src/zip-safety.ts:176-207`、`executor-python/zip_safety.py:179-252` | D（需 Windows 真机夹具） |
| EXEC-04 | P2 | `executor-node/src/commands.ts:94-100`、`pull.ts:188-195` | D（与 EXEC-06/07 同走协议补丁 + `PROTOCOL_VERSION` bump） |
| EXEC-05 | P3 | `executor-node/src/env-whitelist.ts:7-22`、`execute.py:849-864` | D（先加对等守卫锁死漂移，再谈去留） |
| EXEC-06 | P3 | `execute.py:2522` vs `:2363` | D（随协议 bump） |
| EXEC-07 | P3 | `executor-node/src/param-env.ts:84-143`、`execute.py:1730/4253` | D（需三端契约 vectors 同批） |

## 5. deferred（本轮不做，附一句为什么）

| id | 为什么这轮不做 | 前置/触发条件 |
|---|---|---|
| CIR-01（残差） | 主体已落地，残差是「PR 路径的覆盖率门」——要改分片 job 的 coverage 汇总，属门禁架构改动，不能和缺陷修复混一个 PR | 先有 `nyc merge` 的验证用例 |
| CIR-02 / CIR-03 / CIR-04 | **已落地**（前者已提交，后两者在工作区），本轮只做评审与提交，重复做就是浪费 | 评审通过即可关闭 |
| CIR-05 / CIR-07 / CIR-08 / SEC-R3-6 | 供应链 pin 是四处机械改（action SHA / 镜像 digest / pip hash / npm provenance），要动 `.github/**`、`deploy.sh`、四个 Dockerfile、`requirements.lock`；本轮 `.github` 与 `deploy.sh` 刚被 CIR 修复动过，混一起评审成本反而高 | 下一个发布窗口，一次做完 |
| CIR-06 | 回滚「旧代码跑新 schema」需 `DROP COLUMN` 夹具 + staging 演练，且要产品决定 `--allow-schema-ahead` 的交互姿态 | 有 staging 主机 |
| SEC-R3-4 | webhook 重放要先定幂等键形态（`SETNX webhook:{taskId}:{signature}` 还是 `task_executions.webhookSignature` 唯一列），后者是迁移 + 契约 | 先确认 webhook 面是否公网可达 |
| SEC-R3-5 | 今日不可利用（该路由 `scope="public"`，拦截器不消费该证据），P3；改的是授权证据的落证语义，值得单独一轮 | 有 project-role 路由要复用 `trigger()` 时**必须先修** |
| SEC-R3-7 | 一次性 bootstrap token 是新端点（签发/兑换/审计），feature 级；短期只能做安装说明层面的缓解 | 与 SEC-R3-1 同批设计 |
| OBS3-02 / OBS3-08 | 落点在 `modules/agent/**`（并行 agent 正在改，行号会漂）；且 OBS3-02 的归一函数要同时改三处调用点 | 该 agent 收工后按新行号重做 |
| OBS3-07 | 删死代码 + 给 `req.traceId` 找消费者，与 T12 的 5xx 日志行是同一处代码，**跟着 T12 顺手做**比单独立项便宜 | T12 落地时打包 |
| EXEC-01 | 潜伏：`requirements.txt`/`Dockerfile`/`.venv` 都没有 `autocodeflow_sdk`（实测 `ModuleNotFoundError`），无当前触发路径；但**一旦装 SDK 就是 100% 500**，需在装 SDK 的 PR 里同时删掉那个 `try: import` 分支 | 有人要复用 SDK 模型时 |
| EXEC-02 | `preexec_fn` 在多线程进程不安全是 CPython 文档级事实，但改成 `start_new_session` + `/bin/sh` rlimit 包装要动进程隔离层，且需复现构造（fork 瞬间持锁）才能证明修好了 | 有 Python 执行器压测环境 |
| EXEC-03 | Windows 归一化（保留设备名/尾随点空格/大小写折叠/同目标重复）逻辑清楚，但验证必须在 Windows 宿主上跑夹具 | 有 Windows runner 窗口 |
| EXEC-04 / EXEC-05 / EXEC-06 / EXEC-07 | 四条都是「两端契约闸松紧不一」，正确形态是**一次协议补丁 + `PROTOCOL_VERSION` bump + 三端 vectors 同批**；分开改会让三端短暂不同步 | 下一次协议版本升级 |
| db-4 / db-6 / db-8 | 同族（列表读面缺索引 + 全表 COUNT + 过度投影），P3 且收益有限；db-8 还需 keyset 重构立项，db-6 依赖 R4-A-12 的分页决策 | keyset 分页批次 |
| WEB-2 | 首屏 24 请求撞 HTTP/1.1 6 并发，前提是「部署面没有 h2」——要不要上 TLS/h2 是部署决策，先拍板再改打包 | 部署面 h2 决策 |
| WEB-6 | 无障碍正确（`<Text>` 不是 `<label>`），但要连带 onCancel 重置与 Form 校验，属无障碍专项；且 lhci 门禁要扩到未打开弹窗成本更高 | admin-web 无障碍批次 |
| WEB-7 | i18n 双份词典 180.3 KB gz 是首屏最大单块，但 F-42 是「正确性 vs 体积」的**已定案取舍**；本轮只做它自己开的第 4 步（更正注释里失真的体积数字） | 维护者重新拍板懒加载 |
| rt-1 | 异常闸由 T3 覆盖；剩下「OFFSET→keyset + select 白名单 + 重入闸 + `LOST_SWEEP_MAX` 20000→2000」需要先实测单行宽与容器内存预算（本轮无部署数据） | 有 EXPLAIN + 内存限额数据 |

## 6. 冲突面地图

| 文件域 | 状态 | 受影响的 finding | 处置 |
|---|---|---|---|
| `apps/admin-api/src/modules/agent/**`（runtime / tools / trigger / sessions） | **hot**（并行 agent 正在改，含未提交的 `agent-host.ts`、新增 `requeue-ledger.ts`） | OBS3-02、OBS3-08、rt-5 的 3 处 `@Cron`、WEB-4 的后端理由模板 | 一律延后或纯前端绕开；派发前按新行号复核 |
| `apps/executor-desktop/**`（`src/main/agent/**`） | **hot** | CIR-02 的判据载体（48 个 selftest）已落地，本轮不再动 | 只读回归 |
| `apps/admin-api/src/migrations/**` + `scripts/check-migrations.mjs` | **hot**（7 条迁移 dirty） | db-1、db-5、db-2/db-10（新迁移）、db-3/rt-6（新迁移） | **先取号 1790000000075**，与并行 agent 串行；新迁移文件与既有 dirty 文件不重叠，但注册表同一处 |
| `scripts/**`（`ci-local.sh`、`check-migrations.mjs`、`check-npm-audit-exemptions.mjs`、`check-dependency-review.mjs`）、`package.json` | **hot**（多个未提交改动，`scripts/**` 同时有两人在动） | CIR-03、CIR-04、rt-5 的新守卫接线（`test:guards:repo`）、T12 的 `check-alerts-rules` 升级 | 先评审提交，再在其之上加守卫，避免同一文件两处 diff |
| `apps/admin-api/src/modules/task/task.service.ts` | warm（同文件 4 条） | rt-3、rt-7（T5）、db-2/db-10（T8）、OBS3-03（T6）、rt-2（T7）、SEC-R3-5（后续） | T5 → T8 → T6 串行，同一人做 |
| `apps/admin-api/src/modules/executor/executor.service.ts` + `executor.controller.ts` | warm（同文件 3 条） | SEC-R3-1/2/3（T2）、rt-5 的 2 处 cron、rt-1（后续） | T2 先做（含 heartbeat/pull/register），rt-5 随后 |
| `config/monitoring/alerts.yml` + `docs/observability/**` | warm | OBS3-01（T1）、OBS3-03（T6）、OBS3-06（T12） | 三处都改这个文件，按 T1 → T6 → T12 顺序 |
| `apps/admin-web/src/**` | cold（仅被 T10/T11 触及） | WEB-1/2/3/4/5/6/7 | T10 → T11；WEB-2/6/7 延后 |
| `apps/executor-node/**`、`apps/executor-python/**` | cold | EXEC-01…07（全部延后） | 下一轮协议批次 |
| `.github/workflows/**`、`deploy.sh`、`Dockerfile*` | warm（刚被 CIR-01/02 动过） | CIR-05…08、SEC-R3-6/7 | 下一轮供应链批次一次做完 |

## 7. 被剔除的结论（rejected，6 条）

> 原则：**没有证据的幅度与因果不进清单**。以下只剔除「结论/立项形态」，代码事实与可验证部分仍保留在 deferred。

| id | 剔除的是什么 | 理由 |
|---|---|---|
| WEB-6 | 「lhci/axe 扫不到未打开的 Modal ⇒ 门禁假绿」这个副结论 | 未实跑 `npx lhci autorun`，纯方法论推断。保留本体（`<Text>` 不是 `<label>`、控件无可访问名、`onCancel` 不重置）——那些是可直接读到的代码事实 |
| rt-1 | 「20k×50KB ⇒ 1GB 峰值 ⇒ OOMKill」的幅度判定 | 依赖容器内存限额与真实行宽，本轮无部署数据（审计自己也标注未实测）。保留：OFFSET 分页、`getMany()` 全实体、无重入闸、无异常闸 |
| EXEC-01 | 「一旦能 import SDK，每个任务 500」的后果判定 | 前置条件不成立（实测 `ModuleNotFoundError`，三处依赖清单都无该包）。保留：第三份协议模型是漂移源，删掉那个 `try: import` 分支是纯清理 |
| EXEC-02 | 「fork 期死锁 ⇒ 任务永久挂起、槽位被钉死」的因果链 | `preexec_fn` 多线程不安全是 CPython 文档级事实，但死锁未复现（90s 内无法构造持锁线程）。保留：改用 `start_new_session` + `/bin/sh` rlimit 包装，与 node 侧同形 |
| db-6 | 作为独立 finding 立项 | 报告自己标了 `duplicateOf: R4-A-12`；「无分页」结论已在台账，本条只补「`createdAt` 无索引」这一面 → 并入 db-4/db-8 的同族延后批次，不单列 |
| rt-8 | 作为独立 finding 立项 | 审计自述「**不构成容量问题**」、定 P3 的唯一理由是「两处 SSE 口径不一致会被后来者抄走」→ 并入 T6 顺手改，不占独立排期 |

## 8. 未覆盖合并清单（各域 uncovered 去重后）

**A. 「结论有，但没实测」——所有涉及行数/耗时/锁时长/RSS 的数字都属此类，不得当作容量依据**

1. 无 EXPLAIN (ANALYZE, BUFFERS)：db 全域、rt-1/rt-3/rt-4/rt-6 的量级、OBS3-03 的放大倍数，全是「谓词形状 ↔ 索引形状」的结构判断；阈值（多少行会 >30s）需实测，报告刻意没编数字。
2. 无 profiling / 压测：rt-2、rt-4 的核秒/内存峰值是「常量 × 行数假设」的算术，非实测；`node --prof`/`--cpu-prof` 一次没跑。
3. 无真机前端：lhci / axe 未跑；`vite build` 未重跑（复用工作区已有 dist，chunk 名与配置逐项吻合）；375px 真机布局未验；HTTP/1.1 的「24 请求 ÷ 6 = 4 波」是按协议推算，未抓 waterfall。
4. 无 promtool：本机无该二进制；未起 compose monitoring profile，面板「No data」与错色未目视确认；`redis_exporter` 的指标名是外部镜像契约，未核验。
5. 安全侧攻击链未动态复现（只读纪律 + 无执行器集群）：SEC-R3-1/2/3 建议在 `compose.demo` 起两台执行器，持 A 的共享令牌打 `heartbeat{address:B}` 断言 `tokenHash` 非 null，再打 `pull` 断言返回 B 的载荷含 secrets。
6. CI 侧：无 GitHub 凭证，历史 run 的墙钟分位不可得（「最慢 job」来自 `timeout-minutes` + 仓库自己的 run 记录）；flaky 比例无跨 run 归因数据；四份 compose overlay 未联调（本机 docker 不可用）；`deploy.sh rollback` 未演练；release-desktop 三平台未打包。
7. 执行器侧：Windows 真机解压未测（EXEC-03 仅源码级）；`preexec_fn` 死锁未复现（EXEC-02）；EXEC-01 的触发环境未实测。

**B. 「本轮没人看」——不要读作健康**

8. `apps/admin-api/src/modules/agent/**`、`agent/tools/**`：被 5 个域显式跳过（并行 agent 写域）。其中「agent 会话/步骤/工具台账的读面查询与索引」「工具调用的指标标签」「桌面 agent 的日志落盘管道」三块**零覆盖**。
9. `apps/executor-desktop/**`（`src/main/agent/**`）：同上。
10. 未审模块：`notification_silences` / `notification_channel_configs` / `execution_reports`（非高频表）、registry 上传面、notification 渠道的出站重试节奏（只看监听器侧）、BullMQ job 生命周期内的锁续期（`RedisLockService.renew` 只顺带读过注释）、trace/AsyncLocalStorage 的每请求开销。
11. 未验证的边界：`execution_log_lines` 分区管理在跨月/时钟漂移/时区边界的行为（每日 cron 预建分区存在，边界未实测）；分区表无 `createdAt` 谓词时的裁剪成本（仅结构观察，未列 finding）。
12. 按纪律不重复的：`docs/CAPACITY-WHITEPAPER.md` / QA-05 的容量结论、OIDC 协议级攻击（ADR-014 已有 13 例真机套件）、`agent` 域既有台账条目。

**C. 本轮汇总自身没做的事**

13. **没有重跑任何测试**：只做了 9 次静态核对（见 §1）。`npm run test:guards:repo`、`test:alerts`、任何 jest/vitest 都没跑——清单里每条都写了「跑哪个」，但**没验证这些命令在当前工作区是否绿**（工作区有未提交改动，跑出来也不代表主干）。
14. 没有评估各域报告之间的**结论冲突**：已知 3 处需要人工裁决——① WEB-3 说「三条 SSE 不断开」而 rt-4 说「SSE 取数成本 O(连接)」，两条修法正交（客户端停连 vs 服务端快照泵），可同时做；② OBS3-03 与 rt-4 都改 SSE 容量语义，必须同一个 PR，否则 Σ 分母与快照成本会各改一半；③ db-1 已在工作区修了超时豁免，而 db 报告仍写「未修」——以 §1 为准。

## 9. 下一步

1. **先关已落地的**：评审并提交 CIR-03/CIR-04 与 db-1 的超时豁免改动（工作区已就绪），避免它们与新的守卫/迁移改动混在一个 PR。
2. **按 T1→T12 派发**，每条的验收必须带**反证**（把修复还原后守卫/用例要转红）——这是本仓库既有纪律，也是这批 finding 里「守卫假绿」反复出现的根因（`check-index-drift` 只比命名声明、`check-alerts-rules` 只比指标名、`check-guards-wired` 只看文件名）。
3. **热区解锁后再补一轮**：`modules/agent/**` 与 `executor-desktop/**` 收工后，把 OBS3-02/08、rt-5 的 3 处 agent cron、以及「agent 读面索引」一次性审掉——这是本轮最大的覆盖缺口。
4. 台账登记：本文的 T1–T12 与 deferred 表建议同步进 `docs/archive/audits/audit-ledger-2026-10.md`，避免下一轮重复审同一条。

---

## 10. 实施回填（2026-10-29 13:00，DSH 会话）

> 口径：本节只记**已提交**的落地与验证，未提交的一律不算。commit 均为 main 线性历史。

| 条目 | 状态 | commit | 验证 / 反证 |
|---|---|---|---|
| OBS3-01（P1 看板 SUCCESS 大小写） | ✅ | `0265269e` | 新增 `dashboard-label-values.spec`（12 例，注册表为唯一事实源）；反证：改回 `SUCCESS` → 红 |
| OBS3-04（5xx 日志四字段） | ✅ | `0265269e` | 7 例；反证：旧格式 → 5 红。path 去 query（SSE 票据不进日志） |
| OBS3-05（指标渲染失败静默） | ✅ | `0265269e` | 新指标 `autoflow_metrics_render_error_total{query}`（固定枚举）；反证：去限流 → 6 次调用断言红 |
| OBS3-06（31 条告警无 runbook_url） | ✅ | `0265269e` | 判据升级为「绝对 URL + 锚点必须命中真实 slug」；反证：相对路径 / 错锚点 → 红 |
| doc-guard（指标文档） | ✅ 加固 | `0265269e` | 告警名与指标共用前缀 → 按 `- alert:` 装载告警名（大小写归一）放行；selftest 17/17 |
| rt-3（终态载荷 512KB logs） | ✅ | `be9aa10b` | 524,512B → 225B（2331×）；反证：改回 `logs` → 2 红 |
| rt-7（日志 SSE 整行 findOne） | ✅ | `be9aa10b` | 列投影；**审计清单漏了 `startTime`**（漏选会让超时预警静默失效）已修正并加用例 |
| WEB-1（recharts 进首屏） | ✅ | `39dd4001` | 首屏 −104.7KiB（−16.6%）；守卫扩为 first-paint-no-unused-vendor + 1.8MB 上界 |
| WEB-3（SSE 后台重连） | ✅ | `39dd4001` | hidden → close + paused（不走退避）；反证：还原 → 5 红 |
| WEB-5（读失败渲染成空配置） | ✅ | `39dd4001` | 反证：还原 → 2 红（旧 DOM 实测有 `.ant-table` + "No data"） |
| WEB-4（审批盲签） | ✅ | `39dd4001` | 入参只读展示 + 理由全文 + 批准二次确认；反证：`slice(0,160)` → 全文用例红 |
| rt-5（@Cron 无异常闸） | ✅ | `05904b9a` + `9e8b3540` | 实为 **7 处**（审计 5 处 + 机械扫描补 2 处）；新增 `check-cron-guard`（selftest 11/11）并接线 |
| SEC-R3-1/2（共享令牌=per-executor 身份） | ✅（并行流） | `c150a434` | 由并发 Claude 会话按本清单落地；残差 SEC-R3-3 已记 |
| SDK-DX-01/02/03/06/07/08 | ✅ | `3004fa8f` | `{retry:null}` 真关重试+熔断（dist + 真 HTTP 实测）；10 个 ADMIN-only 前缀（审计 4 个） |
| DT-01/02/04/05/08/09/10/11/12 | ✅ | `92cfafa6` | 逐条带复核命令；**DT-04/DT-05 两条审计误判**按现场值处理（孤儿 spec 与 `e2e/legacy/`） |
| 死链判据误报代码块 | ✅ 修 | `92cfafa6` | `extractLinks` 先剥围栏；selftest +2（块内不查 / 块后仍查） |
| sdk-dx / docs-truth / oss-gap 三份报告 | ✅ 归档 | `92cfafa6` / `d3ac7d92` | 本目录 |

**本轮未做（按 §8 deferred 原样保留）**：db-1 残差（`indisvalid` 自检 + CONCURRENTLY 静态断言）、db-2/db-3（新索引，取号 1790000000075）、rt-2（S3 回填 O(P²)）、rt-4+OBS3-03（SSE 快照泵）、SEC-R3-3/4/5、CIR-05 供应链 pin、G1–G10（OSS 缺口）、DX-04/05/09。

**验收基线**：admin-api `383 套件 / 6658 例` 全绿；admin-web `258 文件 / 2150 例` 全绿；`test:guards:repo` 除 `check:desktop-bundle-drift`（并发会话改桌面源码后未回填 bundle 摘要，属其写域）外全绿；tsc / lint / i18n 全绿。
