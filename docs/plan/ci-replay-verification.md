# R440 — `north-star-real-e2e` CI job 空库→迁移→真栈 spec 命令序列本机复演

复演时间：2026-11-22 02:28–02:32（Asia/Shanghai）
执行者：`r440-ci-replay`（子 agent），委托方 `lead`
断言目标：R439 只做静态 CI 配置守卫、未真跑；本轮验证「空库 → migration:run → build → 两个真栈 spec」这条串联序列在本机真机是否可行，判断 CI 防复发闸会不会必红。

## 结论（先给结果）

**CI job 命令序列可行，全链无必红点。** 7 步全部 exit 0：

| 步骤 | 命令 / 动作 | exit | 关键见证 |
|---|---|---|---|
| 1 备份 | `docker exec ... pg_dump --schema-only autoflow_ttfv_e2e <!-- metric-docs:ignore-unknown 这是 PostgreSQL 数据库名，不是指标名 --> > /tmp/opencode/r440-schema-backup.sql` | 0 | 105840 B，57 个 `CREATE TABLE` |
| 2 建空库 | `DROP DATABASE IF EXISTS autoflow_ttfv_e2e; CREATE DATABASE autoflow_ttfv_e2e OWNER autoflow;` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 数据库名，不是指标名 -->（`user_bDWm8S`，superuser/CREATEDB） | 0 | public schema 表数 0（真空库）；drop 前无活动连接 |
| 4 build（job 顺序在前） | `cd apps/admin-api && npm run build` | 0 | `dist/main.js` 生成；prebuild 重生成的 `install-script.content.ts` 与 HEAD 无差异 |
| 3 migration:run | `cd apps/admin-api && npm run migration:run` | 0 | 57 表 / 146 迁移；`funnel_events`、`telemetry_optin`、`system_configs` 三表齐 |
| 5a northstar spec | `cd apps/admin-web && npx playwright test --config playwright.northstar.config.ts` | 0 | `1 passed (9.6s)`；`login status 201` |
| 5b telemetry spec | `cd apps/admin-web && npx playwright test --config playwright.telemetry.config.ts` | 0 | `3 passed (15.8s)`；`login status 201`；cleanup gate=false、funnel/optin/exec/task/exec=0 |
| 6 恢复 | 校验库/端口/进程/工作树 + 删临时口令文件 | 0 | 57 表 / 146 迁移 / users=1 / config=1 / config_history=0 / 五张业务表=0 / gate=false |

与 R439 静态守卫结论**一致**：序列本身在真机跑通，空库迁移后两 spec 全绿；R439「命令可行性依据 R436/R437 分开跑、未验证串联」的缺口已补齐。

## 关键实测细节

### 空库迁移的真实副作用（重要更正）
任务书 step 3 预期「迁移后初始 admin seed 创建（users=1）」。**实测：迁移后 `users=0`、`system_configs=0`。** CodeGraph 追踪确认 seed 不在 `migration:run`，而在后端 bootstrap 的 `UsersService.onModuleInit()`（`apps/admin-api/src/modules/users/users.service.ts:65-100`）：

- `count()>0` 直接 return；否则读 `configService.get("initialAdmin.password")`（即 env `INITIAL_ADMIN_PASSWORD`）；
- 未设置则 warn `INITIAL_ADMIN_PASSWORD not set — skipping admin seed` 并跳过；
- 设置则 bcrypt 建 `admin`（`isActive=true`）。

因此**空库→迁移后必须有后端 bootstrap 才产生 admin**。CI 的两个 config webServer 都跑 `cd ../admin-api && node dist/main` 并继承 Playwright 进程 env——复演中我在 Playwright 进程 env 显式 `export INITIAL_ADMIN_PASSWORD=admin123`（与 CI job env 逐字一致，不取 `.env` 的 14 字符值），两个 spec 的 `/auth/login` 均 201，证明 seed 口令链路通。

### `admin123` 启动校验边界
`configuration.ts:999-1175` 的弱口令 fail-fast 整块被 `if (process.env.NODE_ENV === "production")` 包住，`admin123` 虽在 `weakValues` 集合，但 CI job 与复演都未设 `NODE_ENV=production`，因此不触发。CI 保持非 production 即可。

### 顺序说明
CI job 原文顺序是 build → migration:run（ci.yml:2365-2371），任务书文字先写 migration 再写 build 但注明「按 job 顺序先 build 再 migrate 更精确」；本轮**按 job 顺序执行 build → migration:run**。两者对本序列无依赖冲突（build 只产 dist，migration 只写库）。

### 跳过项与等价前提
- `npm ci ×2`（job step3-4）：本轮未重跑，因 node_modules 已就位（与 `npm ci` 后等价状态）。这不是未验证点；R439 关注的空库串联已覆盖。
- `npx playwright install --with-deps chromium`（job step7）：本机 `/usr/bin/google-chrome` + `PLAYWRIGHT_CHROMIUM_CHANNEL=chrome` 已可用，跳过安装；两 spec 用系统 Chrome 真跑通过。

## 库恢复确认（共享测试库）

复演前基线：`57 表 / 146 迁移 / users=1 / system_configs=1 / funnel_events=0 / telemetry_optin=0 / executors=0 / tasks=0 / task_executions=0 / gate=false`。

复演结束最终态（drop→重建→迁移→两 spec→afterAll 清理→手工清 config_history）：

```text
tables=57  migrations=146  users=1  system_configs=1  config_history=0
funnel_events=0  telemetry_optin=0  executors=0  tasks=0  task_executions=0
telemetry.ttfv.enabled = false
admin: username=admin role=admin isActive=true
```

- 两个 spec 的 afterAll 已清各自造数；northstar 遗留 3 行 `config_history`（id 1-3，时间戳与复演一致，因库是刚重建的）已手工删除，回到原始 0 行。
- 端口 3105/5176 均空闲；无残留 `dist/main` / vite / playwright / chrome 进程。
- 临时口令 env 与 PG helper 脚本（`/tmp/opencode/r440-env.sh`、`r440-pg.mjs`）已删除；日志与 schema 备份保留在 `/tmp/opencode/r440-*.log`、`r440-schema-backup.sql`（均 600）。
- 源码工作树仍为 132 项未提交改动（与本轮开始时一致），未 revert / commit / push，未改任何生产代码/spec/config/baseline/既有 docs/CI。本轮唯一新增文件为本报告。

## 发现的 CI 风险

**未发现必红风险。** 上一轮最担心的「空库迁移后 admin 口令不匹配 → spec 登录 401」已实测排除：只要 webServer 进程继承 `INITIAL_ADMIN_PASSWORD`，seed 与 spec 登录用同一个值，登录 201。剩余为环境差异而非序列缺陷：

1. **PG 版本差异**：本机 `PostgreSQL 18.7 (Alpine)`，CI service 为 `postgres:16-alpine`。迁移 SQL 在 18.7 跑通（含 `uuid_generate_v4()`、`CREATE INDEX IF NOT EXISTS` 等），16 与 18 在这些语法上兼容；但这是真机 18.7 证据，不是 16-alpine 证据。
2. **非 GH Actions runner**：本机是开发者主机（system Chrome、已有 node_modules、localhost PG/Redis 容器），不是 `ubuntu-24.04` + npm ci 全新安装 + PG/Redis service 容器。本轮是「命令序列真机复演」，**不是「CI 已验证」**。
3. **CI 全新 `npm ci` 后 `dist` 是否存在**：job 在 `npm run build` 后立刻 `migration:run`，再让 webServer `node dist/main`；build 已在本轮证明产出 `dist/main.js`，链路完整。

## 证据文件（600 权限，/tmp）

- `/tmp/opencode/r440-schema-backup.sql` — 复演前 schema 备份（105840 B，57 表）
- `/tmp/opencode/r440-build.log` — build exit 0
- `/tmp/opencode/r440-migrate.log` — migration:run exit 0（146 迁移落库日志）
- `/tmp/opencode/r440-northstar.log` — 1 passed + `[R436-WITNESS]` 全流程
- `/tmp/opencode/r440-telemetry.log` — 3 passed + `[R437-WITNESS]` 全流程（含 cleanup）

复演命令原文、逐条 exit code 与关键日志均已记入本文件；所有 passed 均为真跑结果，无伪造。
