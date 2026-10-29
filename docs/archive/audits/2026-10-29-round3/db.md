# 数据库（schema / 索引 / 迁移 / 查询计划）审计（2026-10-29 · 第 3 轮）

> 审计员：db 域（只读）。审计对象：`apps/admin-api/src/migrations/**`、各模块 `entities/**`、
> 各 service 的 `find/findOne/createQueryBuilder/query` 查询构造、retention / 迁移执行器。
> 本报告只登记**未修且未登记**的问题；与既有 backlog 同源但形态不同的，逐条写明关系。

---

## 1 范围与方法

### 1.1 覆盖路径

| 面 | 实际读过的落点 |
|---|---|
| 迁移注册/锁 | `common/utils/migration-runner.util.ts`、`main.ts:160-175`、`config/configuration.ts:859-891`、`data-source.ts` |
| 迁移内容 | `migrations/` 全 119 条的**模式扫描**（`CREATE INDEX` 是否 CONCURRENTLY、`ADD COLUMN NOT NULL DEFAULT`、`ALTER COLUMN TYPE`、`ADD VALUE`、回填 UPDATE）+ 逐字精读 0049/0050/0051/0053/0054/0055/0056/0061/0065/0073/0037/1789900000002 |
| 实体索引 | 41 个 `*.entity.ts` 的 `@Index` 全量抽取（脚本 `/tmp/unnamed-indexes.mjs`），逐条与迁移 DDL 比对（脚本 `/tmp/check-unnamed.mjs`） |
| 查询构造 | `task.service.ts`（列表/执行列表/日志/stats）、`executor.service.ts`（scan/trend/terminal-states）、`sop.service.ts`（poll/list/sweep）、`outbox-dispatcher.service.ts`（claim/retention）、`artifacts.service.ts`、`ai-sop-session.service.ts`、`application.service.ts`、`app-deployment.service.ts`、`projects.service.ts`、`config.service.ts`、`audit.service.ts` |
| 保留期 | 全部 `@Cron` 清理点（audit / log-retention / artifacts / metrics-history / outbox / agent-session / ai-media / sop-media） |
| 守卫脚本 | 实跑 `node scripts/check-index-drift.mjs`、`node scripts/check-migrations.mjs`（均绿，见 §2） |

### 1.2 去重依据（先读后审）

已读并作为"不重复登记"基线：`docs/AGENT-SWARM-PLAYBOOK.md` §7（data-3 / desktop-budget / TOOLS-04 / TOOLS-06 /
desktop-resend / doc-guard）、`docs/archive/audits/audit-ledger-2026-10.md`（R1–R6 全部条目、含
"暂缓记录"）、`docs/PLAN-CLAIMS.md`（迁移逐条主张）、`docs/OPEN-DECISIONS.md`、`docs/CAPACITY-WHITEPAPER.md`、
`docs/QA-05-capacity-boundaries.md`、`docs/archive/audits/*.md`。

已确认**不重复**的既有条目（本报告刻意避开）：R2-B-13 keyset 重构、R4-A-12 applications 分页、
R6-B-1 死信 retention、R6-B-10 config_history 保留、R1-A-11 采样上限、NETOPT-3 系列索引补齐、
B-10 会话域 steps/tool_calls retention、data-3 的 seq 冲突重试、R2-B-4/B-13 等。

同轮其他域的产出也已横向比对（`ci-release.md` / `executors.md` / `observability.md` / `runtime-perf.md` /
`sdk-dx.md` / `web-ux.md`）：`CONCURRENTLY` 迁移超时（db-1）、`tasks` 列表索引与决胜键（db-2 / db-10）、
`event_outbox` claim 索引（db-3）三处在其他域报告中**零命中**，无重复。

### 1.3 方法说明

- 索引/查询匹配用"谓词形状 ↔ 索引列序/谓词"人工比对：**等值列在前、范围/排序列在后**，
  部分索引谓词是否被查询文本蕴含，`ORDER BY` 是否能由索引序直接满足（避免 Sort 节点）。
- 迁移面按"语句在**已上线大表**上的锁等级与耗时"分类，而不是按"写法是否漂亮"。
- 定量结论一律标注"需 EXPLAIN"：本会话**没有**可连的生产/测试 PG，未跑 `EXPLAIN (ANALYZE, BUFFERS)`。

---

## 2 未覆盖 / 未实测（如实写）

1. **没有任何 EXPLAIN 实测**。所有"扫全表 / 走 Sort / 锁多久"都是**结构判断**（谓词与索引形状不匹配），
   不是实测行数或耗时。需要定量时按 §4 各条的"验证方式"跑真库。
2. **未审 `apps/admin-api/src/modules/agent/**`、`agent/tools/**`**：另一 agent 正在该目录改代码
   （工作区有未提交改动），为免与其结论冲突且避免报过期事实，本报告不含 agent 会话/步骤/工具台账
   的查询与索引结论；其中 `agent_steps`/`agent_tool_calls` 只从**迁移侧**（0073）评锁与超时，
   不评其读面。
3. **未审 desktop / executor-node / executor-python 的本地存储**（无 SQL 面，且在域外）。
4. **未逐条验证 119 条迁移的 `down` 可逆性**：只精读 0049/0050/0061/0065/0073 与 1789900000002 的 down。
   其余 down 仅做模式扫描（`DROP` 与 `CREATE` 是否成对）。
5. **未审 `notification_silences` / `notification_channel_configs` / `execution_reports`（metrics 汇总表）**
   的读写形状——它们的行数由配置与日粒度决定，非高频表。
6. **未做容量/压测复现**：`docs/CAPACITY-WHITEPAPER.md` 与 QA-05 的结论本报告不重复、不复核，
   凡是"这个查询会拖垮 DB"的话都只到"结构性不匹配"为止。
7. **未跑全量 jest**（纪律：单次 ≤90s、只允许针对性）。迁移相关只跑了两个守卫脚本：
   - `node scripts/check-index-drift.mjs` → `63 个命名 @Index 声明已比对迁移 DDL；25 个未命名声明不比对` + `✔ 无漂移`
   - `node scripts/check-migrations.mjs` → `119 个迁移全部唯一且已注册；下一可用时间戳 1790000000075`
   这两个"绿"本身就是 §4 两条 finding 的前提（见 db-2、db-8 的"守卫为什么没抓到"）。
8. **未验证 Redis/BullMQ 侧的队列语义**（不在本域）。

---

## 3 发现总表

| id | 优先级 | 一句话 | 落点 |
|---|---|---|---|
| db-1 | **P1** | CONCURRENTLY 建索引的迁移没有关掉连接级 `statement_timeout=30s`：超时失败会留下 **INVALID 索引**，而 `IF NOT EXISTS` 让重跑**静默跳过**，唯一约束/覆盖索引永久缺失且无任何守卫能发现 | `migrations/1790000000049:37`、`0050:55`、`0051`、`0053`、`0055`、`0056`、`config/configuration.ts:890`、`0037:46`（对照先例） |
| db-2 | **P2** | `GET /tasks` 的排序键 `(createdAt DESC, id DESC)` **没有任何索引**（实体 `@Index(["createdAt"])` 是死声明，且恰好落在守卫的"未命名不比对"盲区），注释却声称"外层仍走 `(createdAt, id)` 范围扫描"；每页再加一次全表 `COUNT` | `modules/task/entities/task.entity.ts:129`、`modules/task/task.service.ts:2039-2040`、`:2052`、`:2061`、`:2208-2211` |
| db-3 | **P2** | `event_outbox` 的 claim 查询 `WHERE dispatchedAt IS NULL AND deadLettered=false ORDER BY createdAt LIMIT 5` 没有匹配索引（缺 partial index；`deadLettered` 完全无索引），每 5s 扫一遍"NULL 集合"（含 90 天死信行） | `modules/event-subscriptions/outbox-dispatcher.service.ts:294-313`、`migrations/1790000000003:50-60`、`1790000000012:20-24` |
| db-5 | **P2** | 近两条迁移在**既有热表**上用非 CONCURRENTLY 建索引/做大范围 DELETE（`executor_metrics_history`、`agent_tool_calls`），持 SHARE/行锁阻塞心跳与工具记账写入，且受同一个 30s 超时约束（失败 = 迁移失败 = boot 循环） | `migrations/1790000000061:41`、`migrations/1790000000073:34-43` |
| db-4 | P3 | `ai_sop_sessions.listMine` 用 `(createdBy)` 过滤 + `updatedAt DESC` 排序，两者都无索引（唯一索引是 `createdAt`）；`findAndCount` 再全表 COUNT；并把 `messagesJson`（整段对话）等 3 个 jsonb 列读出来只为取 `mediaCount/title` | `modules/ai/ai-sop-session.service.ts:113-118`、`modules/ai/entities/ai-sop-session.entity.ts:24` |
| db-8 | P3 | `execution_artifacts` 列表 `ORDER BY createdAt DESC, id DESC` + `OFFSET` 分页，但索引只有单列 `(taskId)`/`(applicationId)`；不带过滤时=全表扫 + 排序 + 全表 COUNT | `modules/artifacts/artifacts.service.ts:246-251`、`migrations/1790000000065:68-76` |
| db-6 | P3 | `applications.findAll()` 无 `take` 且 `ORDER BY createdAt` 无索引（与 R4-A-12 同源，形态不同：那条讲"无分页"，本条讲"排序列无索引 + 死声明") | `modules/application/application.service.ts:217-228`、`modules/application/entities/application.entity.ts:20` |
| db-7 | P3 | `getExecutionStats` 先 `GROUP BY status` 取各态计数，再发一次 `count(*)` 同一索引区间扫两遍（`total` 就是各态计数之和） | `modules/task/task.service.ts:3695-3709` |
| db-9 | P3 | SOP poll 每 tick 用**无 LIMIT** 的 `find()` 拉该执行器全部 open 工单（含 3 个重型 jsonb 列），再对每张单发一次澄清查询（循环内查询 = N+1） | `modules/sop/sop.service.ts:623-631`、`:684-689`、`:692-700` |
| db-10 | **P2** | `GET /tasks` 的 OFFSET 分支只按单个键排序、**没有 id 决胜键**：同值行（批量创建的任务共享同一 `now()`；`sortBy=priority` 大量并列）在翻页时会漏行/重行，而同一文件的执行列表分支早已补了决胜键并写明理由 | `modules/task/task.service.ts:2208-2211`（对照 `:3282-3285` 的 FIX-5.3） |

> 共 10 条；§5 给出实施顺序，返回给汇总方的结构化结果只含前 8 条（db-7 / db-9 见本报告正文）。

---

## 4 逐条证据

### db-1（P1）CONCURRENTLY 建索引 + 30s statement_timeout = 留下 INVALID 索引，且重跑永不修复

**现象**
生产迁移由 boot 路径执行（`main.ts` → `runMigrationsWithAdvisoryLock`），跑在**连接池**的连接上，
而连接池对每条语句设了硬超时 30s；`CREATE INDEX CONCURRENTLY` 本身是**一条语句**，同样受这个超时约束。
仓库里唯一处理过这个问题的两条迁移（0037、1789900000002）都是"包在事务里"用 `SET LOCAL statement_timeout = 0`；
而所有 CONCURRENTLY 迁移都声明了 `transaction = false`（否则 CONCURRENTLY 根本不能在事务块内执行），
**`SET LOCAL` 在没有事务时会退化成警告 + 无效**——于是这一类迁移既不能照抄 0037 的写法，又确实什么都没关。

**逐字代码**

```ts
// apps/admin-api/src/config/configuration.ts:888-890（每个池连接都带）
      // L-4: per-statement hard timeout (30s) via pg connection option — fails
      // slow/blocked queries instead of pinning a pooled connection forever.
      statement_timeout: 30000,
```

```ts
// apps/admin-api/src/migrations/1790000000049-AddExecutionTaskCreatedAtIndex.ts:33-40
  /** CONCURRENTLY 不能在事务内执行——本迁移不走外层事务（见类注释） */
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_task_executions_task_id_created_at_id"
      ON "task_executions" ("taskId", "createdAt" DESC, "id" DESC)
```

同类（`transaction = false` 且无 timeout 豁免）还有：`0050:55`（`CREATE UNIQUE INDEX CONCURRENTLY idx_tasks_name_unique`，
**唯一约束**）、`0053:38`、`0055:64`、`0056:55`、`0022:36`；`0051:30` 是 `DROP INDEX CONCURRENTLY`，
不产生 invalid 索引，但同样会被 30s 掐断而把"建新索引 + 删旧索引"这对收尾拆成半步。
对照先例——仓库自己已经写下这个陷阱：

```ts
// apps/admin-api/src/migrations/1790000000037-NormalizeUploadedVersionStatus.ts:39-46
    // 第四轮审计（A1）: 全表 UPDATE 的 statement_timeout 守卫。连接池带
    // 连接级 statement_timeout=30s（configuration.ts extra），极端大的
    // application_versions 表上扫描可能超时。SET LOCAL 依赖本迁移运行在
    // TypeORM 的 per-migration 事务内（…本迁移未声明 transaction=false）
    await queryRunner.query(`SET LOCAL statement_timeout = 0`);
```

**触发路径**
1. 生产库 `task_executions` / `tasks` 已经很大（迁移 0049 自述"task_executions 是最高频写入大表"，
   0056 自述"tasks 行数可能上万"）；
2. 发布新版本 → `admin-api` boot → `runMigrationsWithAdvisoryLock` → 执行 0049/0050/0053/0055/0056 中任一条；
3. 索引构建耗时 > 30s → PG 用 `statement_timeout` 取消该语句 → **该迁移在 `migrations` 表里没有记录**，
   但磁盘上留下了 `indisvalid = false` 的索引（PG 文档 *Building Indexes Concurrently*：
   "If a problem arises while building the index concurrently, the index will be left as invalid…
   it will be ignored for querying purposes"）；
4. 进程退出/重启（boot 失败会重启）→ 重跑同一条迁移 → `IF NOT EXISTS` 命中那个**同名 INVALID 索引** →
   `NOTICE: relation already exists, skipping` → 迁移被记为已应用 → **索引永远不会被建起来**，
   而 `0050` 丢的是 `tasks.name` 的**唯一约束**（重复任务名重新成为可能，而写面的 23505→409 分流变成死代码）。
5. 全仓库**没有任何**检测 `indisvalid` 的地方（`grep -rn "indisvalid"` 零命中），
   `check-index-drift.mjs` 只读迁移**文本**，必然报"无漂移"（实测输出即如此）。

**影响与量级**
- 静默失效：性能索引（0049/0053/0055/0056）缺失后，对应热查询退回全表扫/排序；**没有任何告警**。
- 数据完整性（0050）：`tasks.name` 唯一性丢失。写面 `create` 只在"预检查重名"的 best-effort 路径上拦截，
  并发窗口内可产生同名任务；`PLAN-CLAIMS.md:422` 的"写面 23505→409 对齐"随之失效。
- 频率：每次发布都可能命中；一旦命中就是**永久**（后续迁移不会重建它）。
- 具体阈值（多少行会 >30s）**需实测**：`EXPLAIN` 无用，应做 `CREATE INDEX CONCURRENTLY` 计时或按
  `pg_relation_size('task_executions')` 估算；本报告不给编造数字。

**最小修法**
1. 给每个 `transaction = false` 的 CONCURRENTLY 迁移加**会话级**豁免并在 finally 复位
   （不能照抄 `SET LOCAL`，无事务时它无效）：
   ```ts
   public async up(q: QueryRunner) {
     await q.query(`SET statement_timeout = 0`);
     try {
       await q.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ...`);
     } finally {
       await q.query(`RESET statement_timeout`);   // 必须复位：连接会归还池
     }
   }
   ```
2. 在迁移执行器（`runMigrationsWithAdvisoryLock` 之后）加一次**启动自检**：
   `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;` → 非空则 ERROR 日志 + 指标
   （宁可吵，也不要静默）。
3. 反向补漏：对已存在的 INVALID 索引要有明确动作。`IF NOT EXISTS` 会跳过，故需要
   `DROP INDEX CONCURRENTLY IF EXISTS <name>` 再重建（或 `REINDEX INDEX CONCURRENTLY <name>`），
   建议做成一次性运维脚本并在 docs 记一条 runbook。
4. 守卫侧（可选但便宜）：在 `check-index-drift.mjs` 里加一条"CONCURRENTLY 语句所在迁移必须声明
   `transaction = false` 且含 `statement_timeout` 豁免"的静态断言——这条不依赖 DB，能进 CI。

**可借鉴的 OSS 做法**
- PostgreSQL 官方文档 *Building Indexes Concurrently*（并发建索引失败会留下 invalid 索引、且必须 drop 后重建）——
  这是本条最权威的依据。
- `squawk`（PostgreSQL migration linter）把"迁移里的 DDL 锁等级 / 非并发建索引"做成静态规则，
  与本仓库 `check-*-drift` 守卫同构，可作为第 4 步的实现参考。
- Rails/`strong_migrations` 的同类取舍：它默认**禁止**在迁移里做大表 DDL，要求显式 `safety_assured` 包裹——
  对应到本仓库就是"每个 CONCURRENTLY 迁移必须显式声明超时豁免"。

---

### db-2（P2）`GET /tasks` 的排序键没有索引；实体声明是死的，且正好落在守卫盲区

**现象**
任务列表有两条分页路径，**排序键都是 `(createdAt DESC, id DESC)`**：keyset 分支显式 `orderBy`，
OFFSET 分支用 `sortBy` 白名单（默认 `createdAt`）。而 `tasks` 表上**不存在**任何以 `createdAt` 开头的索引。
实体里那句 `@Index(["createdAt"])` 是**未命名**的（TypeORM 会生成哈希名），而 `synchronize=false` +
迁移是 schema 唯一来源 ⇒ 这句声明从未落库。同一处注释却写着"外层仍走 `(createdAt, id)` 范围扫描"。

**逐字代码**

```ts
// apps/admin-api/src/modules/task/entities/task.entity.ts:127-132
@Index(["status"])
@Index(["applicationId"])
@Index(["createdAt"])                 // ← 未命名；迁移里没有对应 DDL（已逐条核对）
@Index("idx_tasks_name_unique", ["name"], { unique: true })
```

```ts
// apps/admin-api/src/modules/task/task.service.ts:2039-2040（keyset 分支）
      .orderBy("task.createdAt", "DESC")
      .addOrderBy("task.id", "DESC");
// :2052 每页都发一次全表 COUNT
    const total = await qb.getCount();
// :2061 注释断言（与 schema 事实相反）
      // 索引：子查询是 PK 单行查找，外层仍走 (createdAt, id) 范围扫描。
```

```ts
// apps/admin-api/src/modules/task/task.service.ts:2208-2211（OFFSET 分支，默认 sortKey=createdAt）
    qb.orderBy(`task.${sortKey}`, dir);
    qb.skip((p.page - 1) * p.pageSize).take(p.pageSize);
    const [list, total] = await qb.getManyAndCount();
```

索引事实（`grep -rn 'ON "tasks"' migrations/*.ts` 全量）：`idx_tasks_status`、`idx_tasks_trigger_type`、
`idx_tasks_status_trigger_type`、`idx_tasks_applicationId`、`idx_tasks_deleted_at`、`idx_tasks_project_id`、
`idx_tasks_name_unique`、`idx_tasks_dependencies_values_gin`、`idx_tasks_status_id`。
**唯一与排序相关的是 `(status, id)`**——只在 `status` 等值时才能提供 `id` 序，对 `createdAt` 序完全无用。

**守卫为什么没抓到**

```text
$ node scripts/check-index-drift.mjs
check-index-drift: 63 个命名 @Index 声明已比对迁移 DDL；25 个未命名声明不比对（新代码应显式命名）
✔ 无漂移
```
脚本头注自述："未命名的 `@Index(...)`（TypeORM 生成哈希名）无法与 DDL 对应——跳过并在汇总里报数"。
`tasks [createdAt]` 正好是那 25 个之一。这与 `check-index-drift.mjs` 头注里自己讲的历史教训
（NETOPT-3①：「声明了数十个迁移周期从未落库，PENDING 兜底清扫被迫 O(log n)→全表游走」）**是同一形态的复发**。

**触发路径**
`GET /api/tasks`（admin-web `TaskListPage`，`api/tasks.ts:676` 的 `client.get('/tasks', …)`）：
1. 默认无过滤 → `SELECT … FROM tasks ORDER BY "createdAt" DESC, "id" DESC LIMIT 21`；
2. 规划器只能「Seq Scan + Sort(top-N)」或「按 PK 走 + Sort」，两种都要读全表；
3. 同一次请求里 `getCount()`（keyset）或 `getManyAndCount()` 的 COUNT（OFFSET）再扫一遍；
4. 带 `status` 过滤时能借 `(status, id)` 缩小集合，但 `createdAt` 排序仍是额外 Sort 节点。

**影响与量级**
- 每个列表请求 = 一次全表读 + 排序 + 一次全表 COUNT。表规模线性放大：万级 tasks 只是几十 ms；
  十万~百万级（长跑实例 + 每分钟 cron 任务）时单请求进入数百 ms~秒级，并且**并发几个用户就饱和**。
- 讽刺点：keyset 分页是为了"深翻页恒定成本"才做的（`db-13` 重构），但它的前提（排序列有索引）不成立，
  所以 keyset 只省掉了 OFFSET 的跳过成本，**没有**省掉排序与全表扫描。
- 具体行数与耗时**需 EXPLAIN 定量**：`EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM tasks ORDER BY "createdAt" DESC, id DESC LIMIT 21;`
  （判定依据：出现 `Seq Scan on tasks` + `Sort`，而非 `Index Scan using …`）。

**最小修法**
1. 新迁移（CONCURRENTLY，按 db-1 的写法带 timeout 豁免）：
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_created_at_id" ON "tasks" ("createdAt" DESC, "id" DESC);`
   down：`DROP INDEX CONCURRENTLY IF EXISTS`。
2. 实体里把死声明**换成同名显式声明**（顺序 `["createdAt","id"]`，守卫只比列名序列，不比方向）：
   `@Index("idx_tasks_created_at_id", ["createdAt", "id"])` —— 这样它进入 `check-index-drift` 的比对集，
   以后不会再悄悄漂移。
3. 顺带：`getCount()` 每页一次全表 COUNT。短期可改为"首页才算 total，翻页用 `hasMore` 判定"；
   若契约要求恒有 total，至少让它走 `(createdAt)` 索引的 index-only scan。

**可借鉴的 OSS 做法**
- Mastodon / GitLab 的 keyset 分页实践：**游标列必须有复合索引**（Mastodon 为 `(account_id, id)` 建索引），
  否则 keyset 退化成"每页都排序"。本条的索引就是 `(createdAt DESC, id DESC)` 这一形态。
- `pgautoindex`/`pg_qualstats` 一类"按真实查询建议索引"的工具可用于第 3 步的 total 取舍验证。

---

### db-3（P2）`event_outbox` claim 查询与索引不匹配：每 5s 扫全 NULL 集（含 90 天死信）

**现象**
outbox 补投每 `5_000ms` 跑一轮（`OUTBOX_SCAN_INTERVAL_MS`），每轮一条 `FOR UPDATE SKIP LOCKED` 的 claim CTE。
谓词 4 项、排序 1 项：`dispatchedAt IS NULL` / `deadLettered = false` / `nextAttemptAt` /
`leaseUntil` / `ORDER BY createdAt`。表上的索引是 4 个**单列**索引（`dispatchedAt`、`nextAttemptAt`、
`eventId`、`leaseUntil`）——**没有 `createdAt` 索引，没有 `deadLettered` 索引，也没有与本谓词匹配的 partial index**。

**逐字代码**

```sql
-- apps/admin-api/src/modules/event-subscriptions/outbox-dispatcher.service.ts:294-313
          WITH "claimable" AS (
            SELECT "id"
            FROM "event_outbox"
            WHERE "dispatchedAt" IS NULL
              AND "deadLettered" = false
              AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= $1)
              AND ("leaseUntil" IS NULL OR "leaseUntil" <= $1)
            ORDER BY "createdAt" ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
```

```ts
// apps/admin-api/src/migrations/1790000000003-CreateEventOutbox.ts:49-60
      CREATE INDEX IF NOT EXISTS "idx_event_outbox_dispatchedAt"
      ON "event_outbox" ("dispatchedAt")
      …
      CREATE INDEX IF NOT EXISTS "idx_event_outbox_nextAttemptAt"
      ON "event_outbox" ("nextAttemptAt")
      …
      CREATE INDEX IF NOT EXISTS "idx_event_outbox_eventId"
      ON "event_outbox" ("eventId")
```

死信行**不会**离开这个集合——终态只写 `deadLettered=true`：

```ts
// outbox-dispatcher.service.ts:520-533（死信收尾）
              deadLettered: true,
              attempts,
              nextAttemptAt: null,
              leaseUntil: null,
```

**触发路径**
1. 任一订阅方持续失败（webhook 5xx / 网络断）→ 该事件超过 `MAX_OUTBOX_ATTEMPTS` → 写 `event_outbox_dead_letters`
   并把源行置 `deadLettered=true`，**`dispatchedAt` 仍为 NULL**；
2. 死信保留 90 天（`OUTBOX_DEAD_LETTER_RETENTION_DAYS = 90`，`outbox-dispatcher.service.ts:118`）；
3. 期间每 5s 的 claim：`dispatchedAt IS NULL` 走单列索引拿到**全部 NULL 行**（= 待投 + 全部死信），
   逐行回堆判 `deadLettered` 与两个时间列，再对剩余行排序取 5 条；
4. 死信积累到几十万行后，每 5s 一次、每次几十万次回堆 —— 而这一轮真正要投的可能只有 0~5 条。

**影响与量级**
- 结构性：工作队列的扫描成本与**历史失败量**成正比，而不是与"待投量"成正比。死信是**不会自愈**的数据
  （90 天才清），所以故障一次就把之后 90 天的每 5s tick 都拖慢。
- 具体倍数**需 EXPLAIN**：`EXPLAIN (ANALYZE, BUFFERS)` 上述 SQL（把 `$1..$3` 换成字面量），
  看 `Rows Removed by Filter` 与 `Buffers`；判据是"是否走到 `idx_event_outbox_dispatchedAt` 且
  `Rows Removed by Filter` ≈ 死信行数"。
- 次生风险：claim 用了 `FOR UPDATE SKIP LOCKED` 且是 UPDATE 语句，扫描期间持有行锁；
  扫描越久，与 `markFastPathDelivered` / 死信收尾的租约 CAS 争用窗口越大。

**最小修法**
1. 加一条与谓词**逐字对应**的 partial index（CONCURRENTLY）：
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_event_outbox_pending"
     ON "event_outbox" ("createdAt")
     WHERE "dispatchedAt" IS NULL AND "deadLettered" = false;
   ```
   这样 `ORDER BY createdAt` 由索引序直接满足、死信行完全不进索引。
   （`nextAttemptAt`/`leaseUntil` 继续作残余过滤即可；若退避行很多，再考虑
   `("nextAttemptAt")` 上的第二个 partial index。）
2. 实体补同名显式 `@Index("idx_event_outbox_pending", ["createdAt"], { where: "..." })`，
   让 `check-index-drift` 覆盖它（该脚本只比名字/表/列序，不比较谓词——谓词一致性靠迁移 spec 钉）。
3. 迁移 spec 里加一条断言：claim SQL 的 WHERE 子句字符串 ⊆ 索引谓词的等价集合（仓库已有
   「索引/谓词对齐」的 spec 先例，见 `1790000000053` 的注释）。

**可借鉴的 OSS 做法**
- Rails 8 `solid_queue`：就绪队列用的正是"partial index + 谓词只覆盖可执行行"这一形态
  （`ready` 索引的谓词排除 `finished_at` 非空的行），本条的 `WHERE dispatchedAt IS NULL AND deadLettered=false`
  是同一思路。
- `pgmq`（Postgres 消息队列）：claim 语句固定 `ORDER BY vt` 且要求 `vt` 上有索引——"claim 的排序键必须可索引"
  是队列表设计的硬约束。

---

### db-5（P2）近两条迁移在既有热表上做非并发 DDL（0061 / 0073）

**现象**
`0061` 给 `executor_metrics_history`（每个执行器每 30s 一行；仓库自述 2,880 行/天/执行器）加列并建两列索引；
`0073` 给 `agent_tool_calls`（每次工具调用一行）先做**全表自连接去重 DELETE**、再建**唯一索引**。
两条都没有 `transaction = false` / `CONCURRENTLY`，因此：普通 `CREATE INDEX` 持有 **SHARE 锁**（阻塞该表所有
INSERT/UPDATE/DELETE 直到建完），且整个迁移受 30s `statement_timeout` 约束（见 db-1）。

**逐字代码**

```ts
// apps/admin-api/src/migrations/1790000000061-AddExecutorIdToExecutorMetricsHistory.ts:33-42
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executor_metrics_history" ADD COLUMN IF NOT EXISTS "executorId" uuid`,
    );
    …
      `CREATE INDEX IF NOT EXISTS "IDX_executor_metrics_history_executor_created" ON "executor_metrics_history" ("executorId", "createdAt")`,
```

```ts
// apps/admin-api/src/migrations/1790000000073-AddAgentToolCallUniqueToolCallId.ts:33-43
      DELETE FROM "agent_tool_calls" a
      USING "agent_tool_calls" b
      WHERE a."sessionId" = b."sessionId"
        AND a."toolCallId" = b."toolCallId"
        …
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_tool_calls_session_toolCallId"
      ON "agent_tool_calls" ("sessionId", "toolCallId")
      WHERE "toolCallId" IS NOT NULL
```

**触发路径**
1. 版本升级 → boot 迁移；
2. `0061` 建索引期间：`executor_metrics_history` 的写入被 SHARE 锁挡住 → 心跳落库
   （`executor.service.ts:3824` 的 `metricsHistoryRepo.save`）排队 → 心跳处理变慢；
   `0061` 的第二列索引在 30 天保留期下是**百万行级**表（6 台执行器 ≈ 52 万行；100 台 ≈ 860 万行）。
3. `0073` 更重：先去重 DELETE（全表 + 自连接，逐行加行锁），再建唯一索引（SHARE 锁挡住
   `agent_tool_calls` 的每一次工具记账 = agent 循环的每一步）。
4. 若任一步 > 30s：语句被 `statement_timeout` 取消 → 迁移失败 → **boot 失败**（本迁移无 `transaction=false`，
   所以不会留 invalid 索引，但会留下"已删的重复行"这种**不可回滚的数据变更**：TypeORM 的 `each` 模式
   会回滚整个迁移的事务，故这一步实际是安全的——**前提是**它真在事务里；0061/0073 都未声明 `transaction=false`，
   已确认 `data-source.ts:40` 为 `migrationsTransactionMode: "each"`）。

**影响与量级**
- 可见性：这里的问题**不会静默**（失败会挡住 boot），但代价是"升级窗口内写路径被冻住"：
  心跳被冻 → 执行器被判离线；工具记账被冻 → agent 循环卡在每一步。
- 阈值**需实测**：按 `pg_total_relation_size` + 本机 index build 速率估算；不建议在报告里拍数字。
- 与 db-1 的区别：db-1 是"失败后静默缺失"，本条是"成功也阻塞写入 / 失败则 boot 不过"。

**最小修法**
1. `0061`：改成 `transaction = false` + `CREATE INDEX CONCURRENTLY`（+ db-1 的 timeout 豁免）。
   `ADD COLUMN`（可空、无默认）本身是瞬时元数据操作，留在事务里无所谓。
2. `0073`：拆成两步——(a) 去重 DELETE 改**分批**（复用仓库现成的 `cappedBatchedDelete`，
   `common/utils/…`）并在同一连接上做 timeout 豁免；(b) `CREATE UNIQUE INDEX CONCURRENTLY` 放
   `transaction = false` 的独立迁移（顺序敏感：先去重、后建唯一索引，两者不能同事务，因为 CONCURRENTLY 不能在事务里）。
3. 两条都补 down 的可逆性说明（0061 的 down 已可逆；0073 的 down 只丢索引，被删的重复行不可恢复——
   应在头注写清"down 不还原数据"，现在头注只讲 up 的去重）。

**可借鉴的 OSS 做法**
- `strong_migrations`（Rails）：把"加索引不加 concurrently"直接判为危险迁移并拒绝执行——把这条规则
  静态化进 `scripts/check-*.mjs` 与本仓库的守卫体系最契合。
- `pg_repack` / `REINDEX CONCURRENTLY` 的存在本身就是 PG 官方对"索引维护不能长时间独占写"的答案。

---

### db-4（P3）`ai_sop_sessions.listMine`：过滤/排序列都无索引 + `findAndCount` 全表 COUNT + 拉全量 jsonb

**现象**
列表按 `createdBy` 等值过滤、`updatedAt DESC` 排序，但表的唯一索引是 `(createdAt)`；
`findAndCount` 会对同一 `where` 再发一次 `COUNT(*)`；而 `findAndCount` 未指定 `select`，会把
`messagesJson`（整段多轮对话，含全部提问/回答）、`mediaJson`、`draftJson` 三个 jsonb 全部读出来，
只为在内存里算 `mediaCount` 与 `title`。

**逐字代码**

```ts
// apps/admin-api/src/modules/ai/ai-sop-session.service.ts:113-118
    const [rows, total] = await this.repo.findAndCount({
      where: { createdBy },
      order: { updatedAt: "DESC" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
```

```ts
// apps/admin-api/src/modules/ai/entities/ai-sop-session.entity.ts:23-24
@Entity("ai_sop_sessions")
@Index("idx_ai_sop_sessions_createdAt", ["createdAt"])
```

**触发路径**
`GET /ai/sop-sessions?page=`（视频转 SOP 的"我的会话"列表）→ 无 `createdBy` 索引 ⇒ seq scan 全表 +
按 `updatedAt` 排序 + `COUNT(*)` 全表；每行再带上整段对话 jsonb（TOAST 读放大）。

**影响与量级**
- 表**有** retention（`ai-media-retention.service.ts:135` 按 `createdAt` 删 30 天前的会话，
  已核实），所以规模有上界、不构成无界膨胀；真正的问题是每次列表请求都是**全表扫 + 排序 + 全表 COUNT**
  ——成本与"所有用户的 30 天会话数"成正比，而不是与"我自己的会话数"成正比。
- jsonb 读放大：`messagesJson` 是多轮对话全文（含模型输出），`findAndCount` 未投影 ⇒ 每行都带 TOAST 读。
  量级取决于对话长度，**需实测**：`EXPLAIN (ANALYZE, BUFFERS)` 看 `Buffers` 中 toast 页占比。

**最小修法**
1. 迁移加 `CREATE INDEX CONCURRENTLY idx_ai_sop_sessions_created_by_updated ON ai_sop_sessions ("createdBy", "updatedAt" DESC)`
   （等值列在前、排序列在后，一次吃满）；实体补同名显式 `@Index`。
2. `findAndCount` → `findAndCount({ select: { id, status, createdAt, updatedAt, mediaJson, draftJson } })`
   把 `messagesJson` 摘出去（它是唯一的"大"列；`draftJson` 只取 `title` 亦可）。
3. 若"全部会话"视图不是产品需求，另加 `status` 过滤 + partial index。

**可借鉴的 OSS 做法**
- TypeORM 的 `select` 投影（只选列）与 Prisma 的 `select` 同构——列表端点永远显式投影是这类仓库的通行做法；
  本仓库在任务执行列表已这么做（`execution-list-projection.ts`），本条是漏网的同类。

---

### db-8（P3）`execution_artifacts` 列表：排序键无索引 + OFFSET + 全表 COUNT

**现象**
`GET /artifacts?applicationId=&taskId=&page=` 用 `findAndCount` + `ORDER BY createdAt DESC, id DESC` + `skip/take`，
但两张索引都是**单列**（`(taskId)`、`(applicationId)`）：命中过滤后仍需排序；两个过滤都不传时
（服务注释写明"都不传=全量分页"）就是全表扫 + 全表排序 + 全表 COUNT。

**逐字代码**

```ts
// apps/admin-api/src/modules/artifacts/artifacts.service.ts:246-251
    const [rows, total] = await this.artifactIndexRepo.findAndCount({
      where,
      order: { createdAt: "DESC", id: "DESC" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
```
```ts
// apps/admin-api/src/migrations/1790000000065-ExecutionArtifactsIndex.ts:69-76
      CREATE INDEX IF NOT EXISTS "idx_execution_artifacts_task"
      ON "execution_artifacts" ("taskId")
      …
      CREATE INDEX IF NOT EXISTS "idx_execution_artifacts_application"
      ON "execution_artifacts" ("applicationId")
```

**触发路径**
应用详情页"产物"标签 → 按 `applicationId` 翻页。产物行数 = 每次执行 × 清单条目数（构建产物多则几十条/次），
随执行次数线性增长，且 TTL 清理由 `artifacts-retention` 按执行行置空 jsonb 时同步删（`0065` 头注"两侧始终同宽"），
所以**保留期内**的行数是执行量 × 产物数。

**影响与量级**
- 排序 + COUNT 的双扫，与 db-2 同形态但表更小；主要风险是"不带过滤参数"的全量分页路径。
- 需实测：`EXPLAIN (ANALYZE)` 看是否出现 `Sort`，以及 `count(*)` 的耗时占比。

**最小修法**
1. 把两条索引升级成 `(taskId, createdAt DESC, id DESC)` / `(applicationId, createdAt DESC, id DESC)`
   （新迁移 CONCURRENTLY；旧单列索引可保留一轮再删，遵循仓库 `0051` 的"先建后删"纪律）。
2. 服务层：无任何过滤时直接 400 或强制 `applicationId/taskId` 二选一（当前"全量分页"没有消费方，
   见 `artifacts.controller` 的路由注册）。
3. `findAndCount` → keyset（`(createdAt, id)` 元组游标，仓库已有 `keyset-cursor.util.ts` 现成实现）。

**可借鉴的 OSS 做法**
- 与 db-2 同：keyset 的排序键必须有复合索引；分页元数据用 `hasMore` 而非恒等 total，
  这是 GitHub/Slack 一类 API 的通行取舍（`Link: rel="next"` 而非 `total`）。

---

### db-6（P3）`applications.findAll()` 无 `take` 且 `ORDER BY createdAt` 无索引

**与既有条目的关系**：`audit-ledger-2026-10.md` R4-A-12「applications findAll 无分页（暂缓）」登记的是
**响应面无分页**；本条登记的是"**排序列无索引 + 实体死声明**"这个数据库面事实——修 R4-A-12 时如果把
`skip/take` 推到 SQL 而不加索引，问题会从"无界响应"变成"每页全表排序"，故必须先加索引再分页。

**逐字代码**

```ts
// apps/admin-api/src/modules/application/application.service.ts:217-228
  async findAll(projectId?: string): Promise<Application[]> {
    const findOptions: {
      order: { createdAt: "DESC" };
      where?: Record<string, unknown>;
    } = { order: { createdAt: "DESC" } };
    …
    const rows = await this.repo.find(findOptions);
```
```ts
// apps/admin-api/src/modules/application/entities/application.entity.ts:19-22
@Index(["status"])
@Index(["createdAt"])            // ← 未命名；迁移里无 (createdAt) DDL（与 db-2 同形态）
@Index("idx_applications_mutex_group", ["mutexGroupId"])
```

**触发路径 / 影响**：应用列表（部署中心首页）每次刷新 → 全表读 + 排序。应用数通常 < 千，实际影响小，
但它是同一类"死声明 + 排序列无索引"的第二处，属于**模式性**问题（应与 db-2 一起收口）。

**最小修法**：`CREATE INDEX CONCURRENTLY idx_applications_created_at ON applications ("createdAt" DESC, "id" DESC)`；
实体改显式命名；分页随 R4-A-12 一起做。

**可借鉴的 OSS 做法**：同 db-2。

---

### db-7（P3）`getExecutionStats` 对同一索引区间扫两遍

**现象**
先 `GROUP BY status` 取各状态计数，再单独 `count({ where: { taskId } })` 取总数——而 `total` 就是
各状态计数之和（同一 `taskId` 行集，无其他过滤）。

**逐字代码**

```ts
// apps/admin-api/src/modules/task/task.service.ts:3695-3709
    const [recent, statusRows, total] = await Promise.all([
      this.execRepo.find({ where: { taskId }, order: { createdAt: "DESC", id: "DESC" }, take: 20, … }),
      this.execRepo.createQueryBuilder("e")
        .select("e.status", "status")
        .addSelect("COUNT(*)", "count")
        .where("e.taskId = :taskId", { taskId })
        .groupBy("e.status")
        .getRawMany(),
      this.execRepo.count({ where: { taskId } }),
    ]);
```

**触发路径**：任务详情页统计卡（`GET /tasks/:id/stats`）；每次请求 3 个查询，其中一个纯冗余。

**影响与量级**：单次多扫一遍 `(taskId, createdAt)` 索引区间。高频执行的任务（每分钟 cron × 数月）
该区间可达十万行级 ⇒ 每次详情页多一次十万行的 index-only count。**量级需实测**。

**最小修法**：删掉第三个查询，`total = statusRows.reduce((s, r) => s + Number(r.count), 0)`；
加一条单测钉住"不再发 count 查询"（既有 spec 用 `getManyAndCount` 的计数断言可仿照）。

**可借鉴的 OSS 做法**：单次聚合 + 内存求和是统计类端点的常规做法（避免对同一谓词二次扫描）；
GraphQL/REST 的 stats 端点普遍只发一条聚合查询。

---

### db-10（P2）`GET /tasks` 的 OFFSET 分支缺 id 决胜键：同值行翻页漏行/重行

**现象**
任务列表的 OFFSET 分支最终只下发了**一个**排序列（`task.${sortKey}`），没有 `id` 次级键。而 `createdAt`
在 PG 里是 `now()`（事务开始时间）——**同一事务里批量创建的任务共享同一个 `createdAt`**；`sortBy=priority`
（只有 4 个取值）时的并列更多。OFFSET 分页在没有全序时，翻页边界上的同值行顺序由执行计划决定，
**每页都可能不同** ⇒ 静默漏行/重行。同一文件的执行列表分支已经踩过并修好了这个坑：

```ts
// apps/admin-api/src/modules/task/task.service.ts:2208-2211（任务列表 OFFSET 分支——缺决胜键）
    // F-03 排序（sortKey 已过白名单，无注入面）
    qb.orderBy(`task.${sortKey}`, dir);
    qb.skip((p.page - 1) * p.pageSize).take(p.pageSize);
```

```ts
// apps/admin-api/src/modules/task/task.service.ts:3282-3285（执行列表——已修，逐字对照）
      // FIX-5.3: id 决胜键（同 getExecutions——createdAt 非唯一，OFFSET 翻页
      // 无决胜键会漏行/重行）。
      .orderBy("e.createdAt", "DESC")
      .addOrderBy("e.id", "DESC")
```

任务列表默认排序的来源（`task.service.ts:1789-1791`）：
```ts
    let order: Record<string, "ASC" | "DESC"> = { createdAt: "DESC" };
```

**触发路径**
1. 任何一次"一个事务里建多个任务"的操作——例如 `application.service.ts:1510`/`:1634` 的部署链路
   批量 `taskService.create(...)`（同一 `now()`）；
2. 用户翻到第 2 页（`?page=2`）→ 同 `createdAt` 的那批行在边界上 → 顺序不稳定 → 第 1 页出现过的行
   重复出现，或某行两页都不出现；
3. 同样适用于 `sortBy=priority|status` 这类低基数列（并列极多），以及 `sortOrder=asc`。

**影响与量级**
- 静默的数据正确性问题（HTTP 200、行数对得上、内容错），排查成本极高——审计域当年就是因此给
  `audit_logs` 补了 `id` 次级键（`audit.service.ts:175-177` 的 A-8 注释，同一结论）。
- 影响面：批量建任务的用户 + 任何按低基数列排序的翻页。频率取决于业务，但**只要发生就无法被测试发现**
  （单页断言永远绿）。
- 定量不需要 EXPLAIN：这是全序缺失的确定性结论；构造 `SELECT … ORDER BY "createdAt" LIMIT 20 OFFSET 20`
  在同值行集合上执行两次即可复现顺序不稳定（并行计划下）。

**最小修法**
在 OFFSET 分支补次级键，方向与主键一致（`sortOrder` 对 id 同样生效，保持全序即可）：

```ts
    qb.orderBy(`task.${sortKey}`, dir).addOrderBy("task.id", dir);
```

并加一条 spec：两次相同 `ORDER BY` 的 SQL 文本必须含 `"task"."id"`（断言 DTO→SQL 的组装，不需要真库）。
注意不要顺手改 keyset 分支——它本来就是 `(createdAt, id)` 元组，语义正确。

**可借鉴的 OSS 做法**
- 分页全序（total order）是 keyset/OFFSET 的共同前提：Rails 的 `cursor_pagination`、GitLab 的
  `KeysetPagination` 都强制"游标键集合必须是唯一约束的子集"，同一论断在 OFFSET 下同样成立。
- 与 `audit_logs` 的 A-8、执行列表的 FIX-5.3 是同一根因的三处落点——建议抽成
  `applyStableOrder(qb, primaryKey, dir)` 供三处共用，防第四次复发。

---

### db-9（P3）SOP poll：无 LIMIT 的 open 工单全量拉取 + 逐单澄清查询（N+1）

**现象**
poll 每 tick 拉该执行器**全部**未终态工单（无 `take`），注释只说"每轮最多投递 3 张"但**查询本身不设上限**；
随后对每张单再发一次澄清查询（`pendingReplyItems`）。实体含 `resultJson`/`progressJson`/`capabilitySnapshotJson`
三个 jsonb 列，全量实体化。

**逐字代码**

```ts
// apps/admin-api/src/modules/sop/sop.service.ts:623-631
    const open = (
      await this.assignments.find({
        where: {
          targetExecutorId: input.executorId,
          status: In(activeStatuses),
        },
        order: { createdAt: "ASC" },
      })                       // ← 无 take
    ).sort(…);
```
```ts
// apps/admin-api/src/modules/sop/sop.service.ts:684-689（循环内一次查询）
    for (const a of open) {
      if (items.length >= POLL_ITEMS_MAX) break;
      for (const reply of await this.pendingReplyItems(a)) {
```

**触发路径**：执行器 poll（500ms 级）→ 每次 tick 一次 `find` + 每张 open 单一次澄清 `getMany`。
索引 `idx_sop_assignments_targetExecutorId_status` 覆盖了谓词，但 `ORDER BY createdAt` 仍需排序
（索引第三列不是 createdAt），且 `pendingReplyItems` 是典型 N+1。

**影响与量级**：单执行器 open 工单数量决定成本（通常个位数 → 影响小，但"卡住不推进"的工单会长期留在
open 集合里，此时每 tick 的成本随积压线性增长）。**需实测**工单积压分布的 p99。

**最小修法**
1. `find` 加 `select`（只要 `id/sopId/status/pulledAt/createdAt/lastReplyDeliveredAt`），不实体化三个 jsonb；
2. `pendingReplyItems` 批量化：一次 `assignmentId IN (:...ids)` 查回全部澄清行，再按 `assignmentId` 分组；
3. 若"每轮只投 3 张"是产品契约，就加 `take: POLL_ASSIGNMENTS_MAX * k`（k 覆盖 resend/requeue 需要的旧单），
   把"扫描无界"关掉；否则把注释改成如实描述。

**可借鉴的 OSS 做法**：批量预取（`IN (...)` + 内存分组）替代循环内单查询是 ORM N+1 的标准解法
（Rails `includes`/`preload`、TypeORM `relations`/`In()`）。

---

## 5 建议实施顺序（收益 ÷ 风险）

| 顺序 | id | 为什么这个顺序 | 验证 |
|---|---|---|---|
| 1 | **db-1** | 唯一 P1：静默、不可自愈（`IF NOT EXISTS` 让重跑无效）、且 0050 涉及**唯一约束**。改动是"给已有迁移加两行 + 启动自检"，不动业务逻辑，风险最低 | 在**非空大表**副本上跑 `migration:run` 计时；人为把 `statement_timeout` 设 1ms 复现 INVALID 索引，再验证自检能报出；`node scripts/check-migrations.mjs` |
| 2 | **db-10** | 一行代码 + 一条 spec，零 schema 变更，消除的是**静默错数据**（翻页漏/重行）。收益÷风险最高，且与 audit/executions 两处既有修法同源（可顺手抽 helper 防第四次复发） | 单文件 spec 断言 SQL 含 `"task"."id"`；`GET /tasks?page=1/2` 对同 `createdAt` 批量行做两次翻页对比 |
| 3 | **db-2** | 单条 CONCURRENTLY 索引，收益最大面（任务列表是全站最高频列表）；先把死声明转成命名声明，顺带把守卫盲区补上 | `EXPLAIN` 前后对比（Seq Scan+Sort → Index Scan）；`node scripts/check-index-drift.mjs` 仍绿；迁移 spec 断言索引/排序键对齐 |
| 4 | **db-3** | 一条 partial index，风险低；防的是"一次订阅故障拖 90 天"的尾部风险 | `EXPLAIN` claim SQL；注入 10 万死信行后看 `Rows Removed by Filter`；`arch31-outbox-*` 三个 selftest |
| 5 | **db-5** | 需要拆迁移（0073 拆两步），比 1–4 重，但属于"下次发布就会踩"的窗口问题 | 迁移在既有数据副本上重放；`agent-runtime-check.mjs` + 迁移 spec |
| 6 | **db-8 / db-4 / db-6** | 三条同形态（排序列无复合索引 / findAndCount），可**合并成一个迁移 + 一次实体命名收敛**，一次评审 | `EXPLAIN`；`check-index-drift`；各自模块 jest 单文件 |
| 7 | **db-7 / db-9** | 纯请求内优化，零 schema 变更，可随时插入；db-9 的批量化要动 poll 语义，需 `agent-sop-check.mjs` + sop spec | 单文件 jest（先红后绿：断言查询次数） |

**统一收口建议**（跨条目，成本很低）：
- 把 `check-index-drift.mjs` 的"未命名声明只报数"升级为**棘轮**：未命名声明数只减不增（当前 25），
  并要求新增实体一律命名——这能一次性关掉 db-2/db-6/db-8 这类"死声明 + 守卫跳过"的复发面。
- 新增一条静态守卫：`transaction = false` 的迁移若含 `CONCURRENTLY`，必须出现 `statement_timeout` 豁免
  （db-1 的 CI 版防线，不依赖 DB）。
