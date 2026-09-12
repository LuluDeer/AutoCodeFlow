# Application 实体（applications 表）— 应用注册

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/application/entities/application.entity.ts

## 所属模块与源文件

- 模块：[application 模块](../../01-apps/admin-api/modules/application.md)（`apps/admin-api/src/modules/application/`）
- 源文件：`apps/admin-api/src/modules/application/entities/application.entity.ts`
- 同文件导出：`ApplicationStatus` 枚举（`ACTIVE = "active"` / `DEPLOYING = "deploying"` / `FAILED = "failed"`）

## 表名

`applications`（`@Entity("applications")`，InitialSchema 迁移 `1717473142678` 建表，后续 `1717473142684-AddApplicationAndTaskFields` 扩列）

## 字段表

主键 `id: uuid`（`@PrimaryGeneratedColumn("uuid")`）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `name` | varchar NOT NULL，**unique** | 应用名（唯一） |
| `description` | varchar nullable | 描述 |
| `version` | varchar NOT NULL | 当前版本号 |
| `runtime` | varchar NOT NULL | 运行时标识（node/python 等，决定执行器侧拉起方式） |
| `status` | PG enum `ApplicationStatus`，default `'active'` | 应用级状态：`active` / `deploying` / `failed` |
| `gitRepo` | varchar nullable | 源码仓库 |
| `gitBranch` | varchar nullable | 分支 |
| `gitCommit` | varchar nullable | 当前 commit |
| `manifest` | jsonb nullable | 应用清单（含 entrypoint/env 默认值等，执行器按此拉起） |
| `env` | jsonb nullable | 环境变量覆盖 |
| `entrypoint` | varchar nullable | 启动入口 |
| `packageUrl` | varchar nullable | 包地址（私有 registry 分发路径，见 [executor-package](../../01-apps/admin-api/modules/executor-package.md)） |
| `approvalRequired` | boolean，default `false` | DEP-04：为 true 时 deploy() 把新部署冻结为待审批行，需第二人（≠ 申请人）审批后才推送 |
| `webhookSecret` | varchar nullable，**`select: false`** | 发布 webhook 的 HMAC-SHA256 校验密钥（`X-Hub-Signature-256: sha256=<hex>`，GitHub 同款约定）；默认查询不加载，防泄漏 |
| `projectId` | uuid nullable | AUTH-01：归属项目（迁移 `1790000000009` 加列 + FK ON DELETE SET NULL + 索引）；存量行不回填——NULL 归默认项目视图（`application.service.findAll` 按「IS NULL OR = 默认项目」）；**只加列不加关系，避免与 project 模块循环导入** |
| `ownerUserId` | integer nullable | NF-03：创建者用户 id，语义同 `tasks.ownerUserId`（NULL=无主仅 ADMIN 可改；写面守卫 `application.service.assertCanWrite`；**不加 FK**，悬垂 id=非本人 → 403 方向安全） |
| `createdAt` / `updatedAt` | timestamptz | `@CreateDateColumn` / `@UpdateDateColumn` |

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `name` | 列级 `unique` | 应用名唯一 |
| `status` | 实体 `@Index(["status"])` | 状态过滤 |
| `createdAt` | 实体 `@Index(["createdAt"])` | 列表排序 |
| `projectId` FK | 迁移 `1790000000009`：→ `projects.id` **ON DELETE SET NULL** + 索引 | 项目删除后应用归默认项目视图 |
| `ownerUserId` | 无 FK、无索引 | 故意悬垂安全设计 |

## 关系

- **引用**：[project](project.md)（DB FK SET NULL）；[user](user.md)（`ownerUserId` 弱引用）。
- **被引用**：
  - [application-version](application-version.md).`applicationId`（FK **CASCADE**）；
  - [app-deployment](app-deployment.md).`applicationId`（FK **CASCADE**）；
  - `tasks.applicationId`（`@OneToMany("Task", "application")`——注意 [task](task.md) 侧是无 DB FK 的弱引用，仅应用层关联）。

## 生命周期与写入方

写入方集中在 `ApplicationService` / `AppDeploymentService`（[application 模块](../../01-apps/admin-api/modules/application.md)）：

- **创建**：`ApplicationService.create`（注册应用 + 初始 manifest/env）。
- **更新**：`ApplicationService.update`（配置/版本推进）；webhook 发布路径解析 commit 后推进 `gitCommit`/`version`；`status` 随部署生命周期翻转（`deploying` ↔ `active`/`failed`）。
- **删除**：`ApplicationService.remove` → 版本与部署行级联删除，tasks 上的 `applicationId` 悬垂（无 FK）。
- **只读消费方**：admin-web 应用页、执行器运行时查询（manifest/env 下发）。

## 常见改动场景

1. **加字段**：实体 + 迁移（幂等模板参考 `1790000000009`）+ 若进 manifest 快照语义需同步 [application-version](application-version.md)。
2. **改审批/灰度行为**：`approvalRequired` 之外的推进状态都在 [app-deployment](app-deployment.md) 的 rollout/approval 列，勿在本表扩枚举。
3. **接项目过滤**：新列表查询遵循「`projectId IS NULL OR = DEFAULT_PROJECT_ID`」归入默认项目视图的既有约定（`DEFAULT_PROJECT_ID` 常量在 [project](project.md) 实体文件导出）。
4. 相关流程：[任务生命周期](../../04-flows/task-lifecycle.md)、[审批流](../../04-flows/approval-flow.md)。
