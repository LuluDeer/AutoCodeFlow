# 迁移机制（TypeORM Migrations）

> 所属: docs/atlas/03-data · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/migrations/ · apps/admin-api/src/data-source.ts

## 目录与命名

- 目录：`apps/admin-api/src/migrations/`，当前 **60 个迁移文件**（另有 `migrations.spec.ts` 与 `__tests__/`）。
- 命名：`<13位毫秒时间戳>-<PascalCase名称>.ts`，如 `1790000000008-AddTaskProjectId.ts`。TypeORM（0.3.x）按类名末尾 13 位 timestamp 排序执行，类名必须形如 `AddTaskProjectId1790000000008`。
- 时间戳分两代：`17174731426xx` 系列（InitialSchema 时期，约 20 个）与 `178xx…/179xx…` 系列（后续演进），连续编号，无重复（有 spec 守卫，见下）。

## 生成与执行（package.json scripts，已核实）

apps/admin-api 下：

```bash
npm run migration:run       # 执行未应用迁移（生产部署用）
npm run migration:revert    # 回滚最近一个迁移
npm run migration:generate src/migrations/MyName   # 从实体 diff 生成迁移
# 底层共用：
npm run typeorm             # ts-node -r tsconfig-paths/register ./node_modules/typeorm/cli
```

三条 migration 命令均带 `-d src/data-source.ts`，走 **CLI 专用 DataSource**（`src/data-source.ts`）：

- 连接参数经 `src/config/env.ts` 的 `getEnvVar()` 收口读取（不经 Nest DI/ConfigModule）：`DB_HOST`（默认 localhost）、`DB_PORT`（默认 5432）、`DB_USERNAME`（默认 autoflow）、`DB_PASSWORD`、`DB_DATABASE`（默认 autoflow）、`NODE_ENV`（控制日志级别）。
- 实体 glob `src/modules/**/*.entity{.ts,.js}`（**模块根直放的实体也能加载**，如 `project/project.entity.ts`、`executor-package/executor-package.entity.ts`）；迁移 glob `src/migrations/*{.ts,.js}`。
- `synchronize: false`——schema 只能靠迁移演进。

运行面（App 启动）另有一套 `TypeOrmModule.forRootAsync` → `buildTypeOrmDataSourceOptions()`（`src/config/configuration.ts`）：`migrationsRun: NODE_ENV !== "development"`（**非 dev 启动时自动执行迁移**）、`synchronize` 由显式开关 `DB_SYNCHRONIZE` 收口（默认关闭）、`DB_READ_REPLICA_URL` 非空时启用读写分离（SELECT 走 replica，迁移恒走 master）。环境变量全表见 [06-infra](../../06-infra/)。

## migrations.spec.ts 的作用（DB-005 回归防护）

`src/migrations/migrations.spec.ts` 在单测中守护迁移目录的健全性：

1. 不存在重复 timestamp（重复时 TypeORM 退化为文件名字母序，跨平台不可靠）；
2. 每个迁移类名后缀 timestamp 与文件名一致；
3. timestamp 按文件名排序严格递增（执行顺序确定）；
4. 抽查代表性迁移（`AddTaskExecutorId`、`AddExecutionExitCode`、`AddAppDeploymentsInFlightUniqueIndex`、`AddExecutionLogLineLevel` 等）可被 TypeORM 解析且幂等（up `IF NOT EXISTS` / down `IF EXISTS`）。

该文件被迁移 glob 一并 require，因此内部做了环境自检（仅当自身是被执行的测试文件时才注册用例），避免 `migration:run` / e2e worker 误触发。

## 数量与关键节点（分期代表）

| 时期 | 代表迁移 | 内容 |
|---|---|---|
| 初始 | `1717473142678-InitialSchema` | 建 7 张核心表：`users`、`tasks`、`task_executions`、`execution_log_lines`、`executors`、`audit_logs`、`system_configs`（无 FK） |
| 早期补强 | `1717473142679-TaskExecutionForeignKey` | task 域唯一 DB FK：`task_executions.taskId → tasks.id` ON DELETE CASCADE（taskId varchar→uuid） |
| 早期补强 | `1717473142682/2683/2684/2691/2694` | executor token hash、性能索引、application 字段与 task_versions 索引、缺失唯一/复合索引、`executor_packages` 建表 |
| 软删 | `1717473142700-AddTaskSoftDelete` | `tasks.deletedAt`（DB-001） |
| 中期 | `1788274394054/4055`、`1788369816718`、`1788581485026` | executor 版本列重命名、`app_deployments` 建表、`tasks.executorId` pinning（R6） |
| 可观测 | `1788800000000`、`1788900000000`、`1789300000000` | `task_executions.exitCode`、`executors.deadLetterCount`、日志行 `level` 列 |
| 任务能力 | `1789200000000`、`1789400000000`、`1789500000000/0001`、`1789800000000` | 维护窗口、runbook、超时策略、任务级 secrets（SEC-02）、`task_templates` 建表+官方 seed |
| 架构级 | `1789900000002-PartitionExecutionLogLines` | **日志表按日 RANGE 分区**：PK 改 `(id, createdAt)`、存量在线搬迁、legacy 表保留回退 |
| 事件/审批 | `1789900000000`、`1790000000003/0012/0013` | 事件订阅、event outbox + 租约 + 死信 |
| 多租户 AUTH-01 | `1790000000007` ~ `1790000000015` | `projects`、task/executor/package 加 `projectId`、`project_members`（当前最新一个迁移） |
| 审计加固 | `1790000000006-AuditLogsAppendOnlyGuard` | `audit_logs` append-only 触发器（SEC-10） |

完整清单以 `ls apps/admin-api/src/migrations` 为准（60 个）。

## 常见改动场景：怎么加一个迁移

以"给 tasks 加一列"为例：

1. **改实体**：`task.entity.ts` 加 `@Column(...)`。
2. **写迁移**：新建 `src/migrations/<当前毫秒时间戳>-AddTaskXxx.ts`：
   - 类名 = `AddTaskXxx<timestamp>`，实现 `up/down`（generate 生成的骨架已满足命名）；
   - **建议幂等**：`ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS` / `CREATE INDEX IF NOT EXISTS`（存量脏数据先去重再建唯一索引，参考 `1789000000000` 在途部署唯一索引的 `ROW_NUMBER()` 去重先例）；
   - timestamp 取"当前毫秒"，**不得与现有重复、必须严格递增**（`migrations.spec.ts` 会拦）。
3. **验证**：`npm run typecheck` + `npm run test`（含 migrations.spec）；本地库 `npm run migration:run` 后 `npm run migration:revert` 验证 down。
4. **同步文档**：更新 [03-data/README.md](README.md) 索引与对应实体篇的"最后核对"日期。

注意：不要用 `DB_SYNCHRONIZE=true` 代替迁移（那是运行面逃生口，schema 漂移会让 generate 失真）；迁移里不要 import 业务 service（CLI 引导路径无 IoC 容器）。
