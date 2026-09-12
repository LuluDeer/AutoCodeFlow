# ApplicationVersion 实体（application_versions 表）— 应用版本快照（不可变）

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/application/entities/application-version.entity.ts

## 所属模块与源文件

- 模块：[application 模块](../../01-apps/admin-api/modules/application.md)（`apps/admin-api/src/modules/application/`）
- 源文件：`apps/admin-api/src/modules/application/entities/application-version.entity.ts`

## 表名

`application_versions`（`@Entity("application_versions")`，迁移 `1717473142686-CreateApplicationVersionsTable` 建表，`1717473142701-AddApplicationVersionUniqueIndex` 加唯一索引）

## 字段表

主键 `id: uuid`（`@PrimaryGeneratedColumn("uuid")`）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `applicationId` | varchar NOT NULL | FK → `applications.id`（ManyToOne，`@JoinColumn({ name: "applicationId" })`，**onDelete: CASCADE**） |
| `version` | varchar NOT NULL | 版本号；与 applicationId 组合唯一（DB-004） |
| `gitCommit` | varchar nullable | 该版本对应的源码 commit |
| `snapshot` | jsonb NOT NULL | 版本创建时刻的应用配置快照（manifest/env/entrypoint 等）——回滚依据，创建后**不可变** |
| `sourceDeploymentId` | varchar nullable | 溯源：该版本由哪次部署产出（回滚链路用） |
| `status` | varchar NOT NULL，default `'released'` | 版本状态（字符串列非枚举，默认 released） |
| `createdBy` | varchar nullable | 创建人标识 |
| `description` | text nullable | 版本说明 |
| `createdAt` | timestamptz | `@CreateDateColumn` |

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `(applicationId, version)` | 实体 `@Index(…, { unique: true })`（迁移 `1717473142701`） | **DB-004：防并发创建时同一应用出现重复版本号** |
| `applicationId` | 实体 `@Index(["applicationId"])` | 按应用列版本 |
| `createdAt` | 实体 `@Index(["createdAt"])` | 排序 |
| `sourceDeploymentId` | 实体 `@Index(["sourceDeploymentId"])` | 部署→版本溯源 |
| FK | `applicationId` → `applications.id` CASCADE | 应用删除连坐版本行 |

## 关系

- **引用**：[application](application.md)（FK CASCADE）。
- **被引用**：[app-deployment](app-deployment.md) 部署/回滚流程按版本号与 snapshot 消费（应用层关联，无反向 FK 列在 deployments 表——部署行记录 `deployedVersion` 字符串）。

## 生命周期与写入方

写入方在 `ApplicationService` / `AppDeploymentService`（[application 模块](../../01-apps/admin-api/modules/application.md)）：

- **创建**：部署成功 / 版本推进时落一行（快照当时的应用配置）；`sourceDeploymentId` 记录产出部署。
- **更新**：设计上**只写不改**（不可变快照）；`status` 列存在但常规路径不翻转。
- **删除**：仅随应用级联删除；回滚 = 找到目标版本的 snapshot 重新下发，不删行。
- **只读消费方**：admin-web 版本列表、回滚端点（读 snapshot）。

## 常见改动场景

1. **加快照内容**：只改写入侧组装 snapshot 的代码（jsonb 列，无迁移）；历史行保持旧结构，读取侧需兼容。
2. **加字段**：实体 + 幂等迁移；注意唯一索引是 `(applicationId, version)`，改版本号语义需同步 DB-004 注释。
3. **改版本状态机**：`status` 是 varchar 非 PG enum（加值无 DDL 成本），但需同步查询过滤面。
4. 相关流程：[任务生命周期](../../04-flows/task-lifecycle.md)。
