# Rollback 语义对照表（PK-31，DEEP_REVIEW 0ef3bbe）

> 两个「rollback」端点命名相近但**本质不同**：一个回滚**代码**到 gitCommit，一个回滚**任务配置**到历史快照。调用方误用会导致「以为回滚了配置，实际触发了一次旧代码执行」或反之。本表钉死两者差异，Swagger 描述与控制器注释均引用本文。

| 维度 | `POST /api/tasks/:id/rollback`（Git rollback） | `POST /api/tasks/:id/versions/:versionId/rollback`（Version rollback） |
|---|---|---|
| **回滚目标** | 指定 **gitCommit** 指向的**代码版本** | 指定 `:versionId` 指向的**任务配置快照** |
| **动什么** | 改写 `task.gitCommit` 字段 | `Object.assign(task, version.snapshot)` 整体覆盖任务配置字段 |
| **是否触发执行** | **是**：创建 PENDING `TaskExecution`（triggerType=`rollback`）并入队 `taskQueue` | **否**：只落配置 + 写一条新版本快照，不创建执行、不入队 |
| **是否 checkout 仓库代码** | 否（只改 DB 里的 gitCommit 字段，下次执行时执行器才 checkout） | 否 |
| **适用任务类型** | 仅 **Git 类任务**（非 Git 类 400） | 任意有版本快照的任务 |
| **请求体** | `RollbackTaskDto`：`{ gitCommit: string(4-40 hex), params?: object }` | **无请求体**（回滚目标即 `:versionId` 路径参数） |
| **鉴权守卫** | `assertCanWriteProjectAware` + `assertCanOperate`（写面 + 执行面） | `assertCanWriteProjectAware`（仅写面） |
| **审计 action** | `task.rollback` | `task.rollbackToVersion` |
| **幂等性** | 不幂等：每次调用都新建一条执行行 + 改 gitCommit | 不严格幂等：重复恢复同一快照结果一致，但每次都新增一条 version 记录 |
| **service 方法** | `TaskService.rollback(id, dto, user)`（task.service.ts:1318） | `TaskService.rollbackToVersion(taskId, versionId, user)`（task.service.ts:2270） |

## 选择指南

- **「我要让任务回到某个 git 提交的代码跑一遍」** → 用 `:id/rollback`（gitCommit）。
- **「我要把任务的配置（调度、参数、环境变量等）恢复到历史某一版，但不动代码」** → 用 `:id/versions/:versionId/rollback`（快照）。

## 备注

- 两者都改写任务配置面，均要求写权限（ADMIN 或属主）。
- `:id/rollback` 会**触发一次执行**——这是它与快照回滚最大的行为差异，调用方需预期会产生新的执行记录与队列任务。
