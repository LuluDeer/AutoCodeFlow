# R441 — 生产发布 `:prod` 迁移路径空库全链真机复演

复演时间：2026-11-22 02:43–02:48（Asia/Shanghai）
执行者：`r441-prod-migration-replay`（子 agent），委托方 `lead`
断言目标：R433/R440 验证的都是 dev 变体（`ts-node -r tsconfig-paths/register src/...`），生产实际执行的 `:prod` 变体（`node dist/migration-lock-cli.js up`）从未真跑。本轮在空库上真机复演生产命令序列，验证 dist 编译产物 / 路径解析 / 模块解析是否可行——这是发布就绪的最后一块。

## 结论（核心）

**`:prod` 迁移路径可行，空库全链跑通，7 步全部 exit 0；与 R440 的 dev 路径结果一致，未发现 prod 必红缺陷。**

关键差异点全部实测通过：

- `node dist/migration-lock-cli.js up` 的 `require("./data-source")` / `require("./common/utils/migration-runner.util")` 均为编译后的**相对 require**，不依赖 `tsconfig-paths/register`；dist 内路径解析正常。
- `dist/migrations/` 下 0101/0102 的 `.js` 编译产物被正确加载，两条迁移记录落库。
- advisory lock（key=727412345678）正常获取/释放，与 boot 同键互斥语义在 prod 产物中保留。
- 发布前 `npm run build` 产出最新 dist（R327 教训），本轮 build exit 0、git 工作树未受影响（133 项未提交改动前后一致）。

## 7 步逐条结果

| 步骤 | 命令 / 动作 | exit | 关键见证 |
|---|---|---|---|
| 1 备份 | `docker exec 1Panel-postgresql-cFrN pg_dump -U user_bDWm8S -d autoflow_ttfv_e2e <!-- metric-docs:ignore-unknown 这是 PostgreSQL 数据库名，不是指标名 --> --schema-only > /tmp/opencode/r441-schema-backup.sql` | 0 | 113531 B，57 个 `CREATE TABLE`；另取全量 data dump 作精确恢复保险（158277 B，56 条 `COPY`） |
| 2 build | `cd apps/admin-api && npm run build` | 0 | prebuild 重生成 `install-script.content.ts` 无差异；`dist/migration-lock-cli.js`(927B)、`dist/data-source.js`、`dist/main.js`、0101/0102 `.js` 全部刷新到 02:45；git 状态 133→133 |
| 3 空库 | `DROP DATABASE IF EXISTS autoflow_ttfv_e2e; CREATE DATABASE autoflow_ttfv_e2e OWNER autoflow;`（`user_bDWm8S` 执行） <!-- metric-docs:ignore-unknown 这是 PostgreSQL 数据库名，不是指标名 --> | 0 | public 表数 = 0；owner = autoflow |
| 4 **`:prod` 迁移（核心）** | `cd apps/admin-api && <600 权限 env> npm run migration:run:prod`（`node dist/migration-lock-cli.js up`） | 0 | 57 表 / 146 迁移；`funnel_events` / `telemetry_optin` / `system_configs` 三表齐；0101/0102 记录在库；`[migration-lock] Migration advisory lock acquired (key=727412345678)`；**0 条 MODULE_NOT_FOUND / Cannot find module / SyntaxError**；日志无口令泄漏 |
| 5 prod 启动 + 真栈 spec | `cd apps/admin-web && <env> npx playwright test --config=playwright.northstar.config.ts`（webServer = `cd ../admin-api && node dist/main`） | 0 | `1 passed (9.3s)`；`login status 201`；真 Chrome 渲染严格值 1 / 代理值 / 警告 / 全局口径 / 无页面报错；反证有效 |
| 6 幂等 | 再次 `npm run migration:run:prod` | 0 | `[migration-lock] No migrations are pending`；0 条 `INSERT INTO migrations`；锁正常释放 |
| 7 恢复 | DROP+CREATE 后从全量 dump 精确恢复；清理临时口令与备份 | 0 | 57 表 / 146 迁移 / users=1 / config=1 / 五张业务表=0 / gate=false；端口 3105/5176 空闲；无残留进程；git 133 |

## 关键实测细节

### prod 与 dev 的差异点（本轮唯一新增覆盖）

1. **模块解析**：`dist/migration-lock-cli.js` 第 3-4 行为 `require("./data-source")` + `require("./common/utils/migration-runner.util")`。tsconfig `module: commonjs`，`nest build` 把 TS 路径别名编译为相对 require，因此 prod 运行**不需要** `tsconfig-paths/register`。实测从空库到 146 条迁移全部执行，无任何模块解析报错。
2. **迁移文件发现**：`data-source.ts` 的 migrations glob 在编译产物中相对 `__dirname` 解析；`dist/migrations/1790000000101-AddFunnelEvents.js`、`1790000000102-AddTelemetryOptin.js` 被真实加载（`INSERT INTO migrations` 命中两条，日志末尾可见其 DDL：`CREATE TABLE IF NOT EXISTS "funnel_events"` / `"telemetry_optin"` + 唯一索引）。
3. **seed 来源**：与 R440 一致——迁移本身不建 admin/config。空库迁移后 `users=0`、`system_configs=0`；seed 在 `node dist/main` 的 bootstrap（`UsersService.onModuleInit()`）产生。步骤 5 的 prod 启动补齐了 seed，并让 `/auth/login` 201，证明「prod 迁移产物 + prod 启动 + seed」全链路可用。
4. **口令安全**：`INITIAL_ADMIN_PASSWORD=admin123`（8 字符，非弱值集合）由 Playwright 进程 env 继承；本机未设 `NODE_ENV=production`，不触发弱口令 fail-fast（与 R440 同边界）。DB 口令从 `.env` 经 600 权限临时 env 文件注入，dotenv 不覆盖外部已设键（`DB_DATABASE=autoflow_ttfv_e2e` 覆盖生效 <!-- metric-docs:ignore-unknown 这是目标数据库名，不是指标名 -->）；日志全文 `grep` 口令值无命中。

### 与 R440（dev 路径）一致性

- 空库迁移后表/迁移数、关键三表、0101/0102 记录：**一致**。
- advisory lock 键与获取/释放日志：**一致**。
- 幂等 no-op 行为：**一致**。
- prod 启动 + northstar spec `1 passed` / login 201：**一致**。
- 结论：R440 验证的 dev 变体与生产实际走的 prod 变体在空库全链上**等价可用**，发布路径无 dev/prod 分叉风险。

## 库恢复确认（共享测试库）

复演前基线：`57 表 / 146 迁移 / users=1 / system_configs=1 / task_templates=5 / projects=1 / refresh_tokens=2 / audit_logs=2 / funnel_events=0 / telemetry_optin=0 / executors=0 / tasks=0 / task_executions=0 / telemetry.ttfv.enabled=false`。

复演结束最终态（与复演前逐项一致）：

```text
tables=57  migrations=146  users=1  system_configs=1
task_templates=5  projects=1  refresh_tokens=2  audit_logs=2
funnel_events=0  telemetry_optin=0  executors=0  tasks=0  task_executions=0
telemetry.ttfv.enabled = false
```

- 恢复采用「DROP+CREATE OWNER autoflow → psql -f 全量 dump（ON_ERROR_STOP=1）」，`exit 0` 且无 error/FATAL，非依赖 spec 自清理，保证逐字节回到基线。
- 端口 3105/5176 均空闲；无残留 `dist/main` / vite / playwright / chrome / `migration-lock-cli` 进程。
- 临时口令文件 `/tmp/opencode/r441-db.env`、schema 备份 `r441-schema-backup.sql`、全量备份 `r441-full-backup.sql` 已删除（均曾 600 权限）；见证日志保留在 `/tmp/opencode/r441-*.log`、`r441-*dump.err`。
- 源码工作树仍为 133 项未提交改动（与本轮开始时一致，未计入本报告），未 revert / commit / push，未改任何生产代码/spec/config/baseline/既有 docs/CI；本轮唯一新增文件为本报告（git 状态 133 → 134，增量为该报告）。

## 边界（诚实标注）

- 本机 PG 18.7（Alpine），**非 GH Actions 生产环境**；结论是「`:prod` 命令本机真机复演通过」，**不是「生产已验证」**。
- 未覆盖 PG 16-alpine（CI service 版本）差异：迁移 SQL 在 18.7 通过（`uuid_generate_v4()`、`CREATE INDEX IF NOT EXISTS` 等语法在 16 兼容），但这是 18.7 证据。
- 未重跑 `npm ci`：node_modules 已就位，与全新安装后等价状态；build 已证明 dist 产出完整。
- 系统 Chrome（`/usr/bin/google-chrome`）真跑，未执行 `playwright install`。
- 未验证 `migration:revert:prod`（`node dist/migration-lock-cli.js down`）：本轮目标仅为发布 up 路径；R433/R440 已覆盖 dev revert 路径，prod down 为同一 CLI 的 `direction="down"` 分支，不在本轮范围。

## 证据文件（/tmp/opencode/）

- `r441-build.log` — build exit 0
- `r441-prod-migrate.log` — 空库 `:prod` 迁移全量查询日志（146 迁移，136 KB）
- `r441-prod-migrate-idempotent.log` — 幂等 no-op 日志
- `r441-northstar.log` — prod 启动 + 真栈 spec `1 passed`
- `r441-restore.log` — 恢复日志（无错误）
- `r441-dump.err` / `r441-fulldump.err` — 备份 stderr（空）

## 建议

无 prod 必红缺陷，发布前最后一个验证块已补齐。**建议关闭 R441。**
