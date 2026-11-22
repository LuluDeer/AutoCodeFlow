# R433 · 独立干净库全量迁移 up → 幂等 → down 回滚链实测报告

- 日期：2026-11-22（Asia/Shanghai）
- 执行者：子 agent `r433-migration-e2e`（lead 派发）
- 验收级别：**真实 PG 进程级**（独立库 146 全量迁移 + 最近 2 个迁移 down 回滚链）
- 写域：仅新建本报告；未改任何生产代码 / 迁移 / 既有脚本 / baseline / 其它 docs；未 revert / commit / push 任何工作树改动
- 关联：补 R314（`docs/AGENT_HANDOFF.md` 的「R314」段）只验 up + 二次幂等、**从未验 down()** 的缺口

## 环境（实测，非推测）

| 项 | 值 | 来源 |
|---|---|---|
| PG 容器 | `1Panel-postgresql-cFrN` | 任务给定 |
| 版本 | PostgreSQL 18.7 | `docker exec ... env` → `PG_VERSION=18.7` |
| 连接 | 127.0.0.1:5432 | 迁移 CLI 走 TCP（data-source.ts host/port） |
| 特权角色 | `user_bDWm8S`（有 CREATEDB；`autoflow` 无 CREATEDB） | 容器 env `POSTGRES_USER=user_bDWm8S` |
| 密码 | 容器 env `POSTGRES_PASSWORD`（占位 `PG_PW`，长度 15，实测可用） | `docker exec ... env`；未写进本报告明文 |
| 本地 socket | `-U user_bDWm8S -d postgres` trust，exit 0 | 实测 `select current_user` 返回 user_bDWm8S |
| 目标库 | `acf_migration_r433`（独立新建） | 本轮创建 |
| 严禁触碰库 | `autoflow`（主库）、`autoflow_ttfv_e2e` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 数据库名，不是指标名 -->（测试库） | 全程只连 acf_migration_r433；末尾复核两库仍在 |

## 探查（遵循 AGENTS.md 硬规则：CodeGraph 优先）

MCP `codegraph_explore` 未在本会话暴露，按规则走 CLI 兜底：
`export PATH="/home/zou/.codegraph/versions/v1.6.2/bin:$PATH"; codegraph ...`，projectPath = `/data/project/AutoCodeFlow`。索引 `Index is up to date`（2633 files / 52064 nodes）。

关键结论：
- `apps/admin-api/src/common/utils/migration-runner.util.ts`：`runMigrationsWithAdvisoryLock` 中 up = `runMigrations()`、down = `undoLastMigration()`（每次只回退最近一个）；no-op 通过在 up 前后比对 `migrations` 表行数实现，行数不变时打 `No migrations are pending`；全程会话级 `pg_advisory_lock(key=727412345678)` 包裹，finally 解锁。
- `apps/admin-api/src/migration-lock-cli.ts`：`migration:run`→up、`migration:revert`→down；日志前缀 `[migration-lock]`（与 CI 幂等断言一致）。
- `apps/admin-api/package.json` 脚本：`migration:run` / `migration:revert` 均指向该 CLI；`migrationsTransactionMode: "each"`（每迁移独立事务）。
- 0101 = `1790000000101-AddFunnelEvents.ts`：up 建 `funnel_events` + 2 索引（`idx_funnel_events_install_id_event_name`、`uq_funnel_events_dedupe_key`），down 逆序 DROP 两索引 + 表。
- 0102 = `1790000000102-AddTelemetryOptin.ts`：up 建 `telemetry_optin` + 1 索引（`uq_telemetry_optin_install_id`），down DROP 索引 + 表。
- 迁移文件排序尾部：`...0100 → 0101 → 0102`（0102 为最后一个迁移，故首次 revert 必回退 0102）；目录 147 个 `.ts`，其中 `migrations.spec.ts` 为测试文件，实际迁移 **146** 个（与实测 migrations 表 146 行吻合）。

## 六步逐条结果（真实 exit + 关键见证）

### 步骤 1 — 建独立库

```bash
docker exec 1Panel-postgresql-cFrN psql -U user_bDWm8S -d postgres -c "DROP DATABASE IF EXISTS acf_migration_r433"   # exit 0（NOTICE: does not exist, skipping）
docker exec 1Panel-postgresql-cFrN psql -U user_bDWm8S -d postgres -c "CREATE DATABASE acf_migration_r433"           # exit 0，输出 CREATE DATABASE
docker exec 1Panel-postgresql-cFrN psql -U user_bDWm8S -d postgres -tAc "SELECT datname FROM pg_database WHERE datname='acf_migration_r433'"
# → acf_migration_r433，exit 0
```

前置与建库均 exit 0。

### 步骤 2 — 全量 up（146 迁移）

```bash
cd apps/admin-api
DB_HOST=127.0.0.1 DB_PORT=5432 DB_USERNAME=user_bDWm8S DB_PASSWORD=PG_PW \
DB_DATABASE=acf_migration_r433 npm run migration:run
# exit 0；日志 2684 行 → /tmp/opencode/r433/step2-up1.log
```

关键见证（真实日志行）：
- `[migration-lock] Migration advisory lock acquired (key=727412345678) — running migrations (up)`
- 末尾：`CREATE TABLE IF NOT EXISTS "funnel_events" ...` + `CREATE INDEX ... idx_funnel_events_install_id_event_name` + `CREATE UNIQUE INDEX ... uq_funnel_events_dedupe_key` + `INSERT INTO "migrations" ... [1790000000101,"AddFunnelEvents1790000000101"]` + `COMMIT`
- 紧接：`CREATE TABLE IF NOT EXISTS "telemetry_optin" ...` + `CREATE UNIQUE INDEX ... uq_telemetry_optin_install_id` + `INSERT INTO "migrations" ... [1790000000102,"AddTelemetryOptin1790000000102"]` + `COMMIT`
- 收尾：`SELECT ... WHERE NOT indisvalid`（INVALID 索引自检）+ `pg_advisory_unlock(727412345678)`
- **噪音说明**：日志第 13 行 `error: error: relation "migrations" does not exist` 是首跑 no-op 检测 `countMigrations()` 在 migrations 表尚未创建时的预期探测（before=-1），**不是迁移失败**；进程最终 exit 0。

### 步骤 3 — 二次 up 幂等（no-op）

```bash
DB_...=acf_migration_r433 npm run migration:run
# exit 0；日志 → /tmp/opencode/r433/step3-up2.log
```

完整关键路径：`[migration-lock] Migration advisory lock acquired ...` → `SELECT count(*) FROM "migrations"` → `SELECT ... FROM "migrations" ORDER BY "id" DESC` → INVALID 索引自检 → `SELECT count(*) FROM "migrations"` → **`[migration-lock] No migrations are pending`** → `pg_advisory_unlock`。复现 CI `admin-api-migrations` job 的幂等断言，exit 0。

### 步骤 4 — 验证表 / migrations 记录 / 索引

```bash
psql -d acf_migration_r433 -tAc "select to_regclass('public.funnel_events'), to_regclass('public.telemetry_optin')"
# → funnel_events|telemetry_optin      exit 0

psql -d acf_migration_r433 -tAc "select count(*) from migrations; select name from migrations where name in (...);"
# → 146
# → AddFunnelEvents1790000000101
# → AddTelemetryOptin1790000000102      exit 0（各 1 行）

psql -d acf_migration_r433 -tAc "select indexname from pg_indexes where indexname in ('uq_funnel_events_dedupe_key','idx_funnel_events_install_id_event_name','uq_telemetry_optin_install_id') order by indexname;"
# → idx_funnel_events_install_id_event_name
# → uq_funnel_events_dedupe_key
# → uq_telemetry_optin_install_id      exit 0（三个索引全在）
```

### 步骤 5 — down 回滚链（revert 最近 2 个）

**revert #1**（回退 0102）：

```bash
DB_...=acf_migration_r433 npm run migration:revert
# exit 0；日志 → /tmp/opencode/r433/step5-revert1.log
```

见证：`running migrations (down)` → `DROP INDEX IF EXISTS "uq_telemetry_optin_install_id"` → `DROP TABLE IF EXISTS "telemetry_optin"` → `DELETE FROM "migrations" WHERE ... [1790000000102,"AddTelemetryOptin1790000000102"]` → `COMMIT` → `pg_advisory_unlock`。
中间态 psql：`funnel_events|`（telemetry_optin 已 NULL），0101/0102 记录剩 1 条（0101 仍存在），exit 0。

**revert #2**（回退 0101）：

```bash
DB_...=acf_migration_r433 npm run migration:revert
# exit 0；日志 → /tmp/opencode/r433/step5-revert2.log
```

见证：`running migrations (down)` → `DROP INDEX IF EXISTS "uq_funnel_events_dedupe_key"` → `DROP INDEX IF EXISTS "idx_funnel_events_install_id_event_name"` → `DROP TABLE IF EXISTS "funnel_events"` → `DELETE FROM "migrations" WHERE ... [1790000000101,"AddFunnelEvents1790000000101"]` → `COMMIT` → `pg_advisory_unlock`。

**回滚终态**（psql exit 0）：

```text
select to_regclass('public.funnel_events'), to_regclass('public.telemetry_optin')  →  |   （两表均 NULL）
select count(*) from migrations where name in (0101,0102)                          →  0   （记录消失）
select count(*) from migrations                                                    →  144  （146−2，正好回退两个）
```

无不可逆守卫拒绝：0101/0102 的 down() 均为明确的 DROP 索引 + DROP 表，两迁移全部成功回退。

### 步骤 6 — 清理 + 无残留确认

```bash
docker exec 1Panel-postgresql-cFrN psql -U user_bDWm8S -d postgres -c "DROP DATABASE acf_migration_r433"
# exit 0，输出 DROP DATABASE

SELECT count(*) FROM pg_database WHERE datname='acf_migration_r433'           → 0      （无残留，exit 0）
SELECT datname FROM pg_database WHERE datname IN ('autoflow','autoflow_ttfv_e2e') /* metric-docs:ignore-unknown 这是 PostgreSQL 数据库名，不是指标名 */
# → autoflow / autoflow_ttfv_e2e 均在（未触碰，exit 0） <!-- metric-docs:ignore-unknown 这是 PostgreSQL 数据库名，不是指标名 -->
```

## 是否形成可复跑脚本

本轮按任务允许的「一次性执行 + 报告记录命令与实证」路径完成，**未新建** verify-migration-roundtrip 脚本。全部原始日志保留在 `/tmp/opencode/r433/`：`step1-create.log`、`step2-up1.log`、`step3-up2.log`、`step5-revert1.log`、`step5-revert2.log`、`step6-drop.log`（临时目录，会话结束后可能清理；如需长期留档建议后续做成 export + main-guard 的脚本纳入 `scripts/`）。

## 边界 / 未覆盖（诚实）

- 本轮只断言 0101/0102 两表 + 三索引 + migrations 表行数/记录；**未逐一校验其余 144 张表结构**（全量 up 成功 + 行数 146 是它们的存在性证据，非逐列/逐约束比对）。
- down 链只回退最近 2 个迁移（0102/0101），**未验证全量 146 个迁移的 down 序列**；其余迁移此前无 down 实测。
- up 首跑日志含 `relation "migrations" does not exist` 的探测噪音（预期，已说明），CI 若用严格 grep 匹配「ERROR」需注意豁免该行。
- 密码来自容器 env，未写明文进报告；仅本会话使用。
- PG 18.7、独立库场景；未覆盖生产 HA 双副本并发迁移竞跑（本次单进程）。

## 结论与建议

- **补上了 R314 的 down() 全链验证缺口**：真实 PG 进程级验证「空库全量 up(146) → 二次 up no-op → revert 0102 → revert 0101 → 两表消失 + 记录清除 → 库清理无残留」全程 exit 0，是 R290–R433 未提交改动发布就绪的最后一块证据。
- **建议纳入常规发布检查**：把 CI `admin-api-migrations` job 从「空库全链 + 二次幂等」扩展到「追加最近 N（如 2）个迁移的 revert 链 + 表/记录消失断言」，可低成本堵住「down() 写了从没跑」这类风险；本轮已证明该检查在当前迁移链上可通过。
