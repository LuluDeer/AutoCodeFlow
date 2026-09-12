# AppDeployment 实体（app_deployments 表）— 应用部署记录（含审批/灰度/触发标注列）

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/application/entities/app-deployment.entity.ts

## 所属模块与源文件

- 模块：[application 模块](../../01-apps/admin-api/modules/application.md)（`apps/admin-api/src/modules/application/`）
- 源文件：`apps/admin-api/src/modules/application/entities/app-deployment.entity.ts`
- 同文件导出 4 个枚举：`DeploymentStatus`（6 值）、`RunMode`（3 值）、`DeploymentApprovalStatus`（DEP-04）、`RolloutState`（DEP-02/03）、`DeploymentTriggerType`（FEAT-20）

## 表名

`app_deployments`（`@Entity("app_deployments")`，迁移 `1788274394055-CreateAppDeploymentsTable` 建表）

## 字段表

主键 `id: uuid`（`@PrimaryGeneratedColumn("uuid")`）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `applicationId` | varchar NOT NULL | FK → `applications.id`（ManyToOne CASCADE） |
| `executorAddress` | varchar NOT NULL | 部署所在执行器地址（按 address 关联执行器，非 FK，同 [task-execution](task-execution.md) 风格） |
| `executorId` | varchar nullable | 逻辑执行器 id（已知时填） |
| `status` | PG enum `DeploymentStatus`，default `'pending'` | 6 值：`pending` / `deploying` / `running` / `stopped` / `failed` / `upgrading`。**待审批行复用 pending**（不扩枚举，见下 approvalStatus） |
| `runMode` | PG enum `RunMode`，default `'daemon'` | `once` / `daemon` / `scheduled` |
| `deployedCommit` | varchar nullable | 当前部署的 git commit |
| `deployedVersion` | varchar nullable | 当前部署的版本号 |
| `startCommand` | varchar nullable | 覆盖启动命令（缺省回落 manifest entrypoint） |
| `env` | jsonb nullable | 本次部署环境变量覆盖 |
| `pid` | int nullable | 执行器上报的进程 PID（daemon 模式） |
| `lastHeartbeat` | timestamp nullable | 执行器对该运行中应用的心跳 |
| `statusMessage` | text nullable | 人类可读进度/错误信息 |
| `deployedAt` | timestamp nullable | 完成部署时刻 |
| `rolloutState` | varchar nullable | DEP-02/03（迁移 `1790000000001`）：灰度批次推进状态 `RolloutState`——`pending`/`probing`/`promoted`/`failed`/`rolled_back`；NULL=非批次路径 |
| `rolloutMeta` | jsonb nullable | DEP-02/03：批次元数据 `{ batchId, role, strategy, percentage, upgradedIds, failureReason?, rolledBackTo? }` |
| `approvalStatus` | varchar nullable | DEP-04（迁移 `1790000000002`）：审批推进状态 `DeploymentApprovalStatus`——`pending_approval`/`approved`/`rejected`/`cancelled`；NULL=非审批路径 |
| `approvalMeta` | jsonb nullable | DEP-04：审批痕迹 `{ requestedBy, requestedByName, requestedAt, actedBy?, actedByName?, actedAt?, reason? }` |
| `triggerType` | varchar nullable | FEAT-20（迁移 `1790000000004`）：触发动作语义 `DeploymentTriggerType`——`manual`/`upgrade`/`rollback`/`approval`；NULL=存量行未标注（varchar 可空承载，避免 PG enum ALTER 扩值成本） |
| `operator` | varchar nullable | FEAT-20：触发操作人用户名（JWT `user.username`）；NULL=存量行/机器路径（心跳等） |
| `createdAt` / `updatedAt` | timestamptz | `@CreateDateColumn` / `@UpdateDateColumn` |

注意：`rolloutState`/`approvalStatus`/`triggerType` 三列都是 **varchar 非 PG enum**——值域由 TS 枚举约束，加值无需迁移（源码注释明确此取舍）。

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `applicationId` | 实体 `@Index(["applicationId"])` | 按应用列部署 |
| `(applicationId, status)` | 实体复合 `@Index` | 应用详情过滤 |
| `status` | 实体 `@Index(["status"])` | 状态过滤 |
| `idx_app_deployments_executor_address_status` | `(executorAddress, status)` | 执行器维度统计 |
| `uq_app_deployments_application_in_flight` | `(applicationId)` **UNIQUE 部分索引**，`WHERE status IN ('pending','deploying')`（迁移 `1789000000000`，建索引前先折叠存量重复在途行并在 statusMessage 打标） | **同一应用至多一个在途/待审批部署**——审批行复用 pending 因此天然被约束 |
| FK | `applicationId` → `applications.id` CASCADE | 应用删除连坐部署行 |

## 关系

- **引用**：[application](application.md)（FK CASCADE）；执行器（`executorAddress` 字符串弱引用，同 [executor](executor.md)）。
- **被引用**：[application-version](application-version.md).`sourceDeploymentId`（溯源，字符串引用）；`event_outbox`/订阅死信在 `deployment.completed` 事件里携带部署 id（[event-outbox](event-outbox.md)）。

## 生命周期与写入方

写入方集中在 `AppDeploymentService`（[application 模块](../../01-apps/admin-api/modules/application.md)）：

- **创建（pending）**：deploy 入口（manual）；`approvalRequired=true` 时冻结为待审批行（`approvalStatus=pending_approval`，triggerType=approval）；灰度批次路径创建 probing 行。
- **更新**：执行器回调（status→running/failed、pid、lastHeartbeat、deployedCommit/Version）；升级（upgrading，triggerType=upgrade）、回滚（triggerType=rollback）、审批推进（approved/rejected/cancelled + approvalMeta）。
- **删除**：随应用级联；正常运维不删行（历史审计）。
- **只读消费方**：admin-web 部署页（按 triggerType/operator 标注来源）、执行器心跳路径。

## 常见改动场景

1. **加触发/审批/灰度状态值**：对应 TS 枚举加值即可（varchar 列无 DDL），同步前端映射与 service 分支。
2. **改 DeploymentStatus 枚举**：是 **PG enum**——加值需 `ALTER TYPE` 迁移，注意与 partial unique index 的 `WHERE status IN (...)` 谓词联动。
3. **加字段**：实体 + 幂等迁移（列扩展模板参考 `1790000000001`–`1790000000004` 三连迁移）。
4. 相关流程：[审批流](../../04-flows/approval-flow.md)、[执行器注册](../../04-flows/executor-registration.md)。
