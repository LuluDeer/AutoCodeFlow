# Rollback 语义对照表（PK-31，DEEP_REVIEW 0ef3bbe）

> 两个「rollback」端点命名相近但**本质不同**：一个回滚**代码**到 gitCommit，一个回滚**任务配置**到历史快照。调用方误用会导致「以为回滚了配置，实际触发了一次旧代码执行」或反之。本表钉死两者差异，Swagger 描述与控制器注释均引用本文。
>
> 2026-10-24（R1，部署模型评审 §4.2）新增**应用回滚**对照（见下节）：旧应用 rollback 端点已拆为「设为当前版本」与「下发到设备」两个显式动作，旧端点降级为 deprecated alias。

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

---

## 应用回滚对照（R1，2026-10-24 部署模型评审 §4.2）

旧 `POST /api/applications/:id/rollback/:targetId` 把「按版本快照恢复应用当前字段」与「对全部 RUNNING 部署行下发升级」捆绑为一个动作——命名「回滚」掩盖了「改配置 + 全量滚动升级」的组合语义（评审 P6）。R1 拆为两个显式动作；旧端点保留一版作为 **deprecated alias**（行为逐字节不变，下一版本删除）。

| 维度 | `POST /api/applications/:id/set-current-version`（设为当前版本） | `POST /api/applications/:id/deploy-version`（下发到设备） | `POST /api/applications/:id/rollback/:targetId`（deprecated alias） |
|---|---|---|---|
| **动什么** | 只按版本快照恢复应用当前字段（version/gitCommit/gitBranch/packageUrl/env/entrypoint/manifest/runtime） | 先做与 set-current-version **完全相同**的字段恢复，再对部署行逐台 upgrade | 字段恢复 + 全部 RUNNING 部署行 upgrade（= 左两列的组合） |
| **是否下发设备** | **否**（响应 `dispatched:false`，绝不读写部署行） | **是**：`executorIds` 缺省=全部 RUNNING 行（与旧 rollback 一致）；显式点名=仅这些执行器对应的 RUNNING 行 | **是**（恒全部 RUNNING 行，不可点名） |
| **点名下发** | — | 支持：无部署行（`no_deployment`）/ 行状态不可下发（`not_running`）/ upgrade 被拒（`upgrade_rejected`）进 `skipped` 明细不报错 | 不支持 |
| **目标参数** | body `{versionId}`（`application_versions.id`，uuid） | body `{versionId, executorIds?}` | 路径 `:targetId`（版本快照 id **或** legacy 部署行 id——后者只恢复 version/commit，`packageUrlRestored:false`） |
| **校验/错误码** | 版本不存在 404；他应用/无版本号/非 released 400（与 rollback 快照路径同一套） | 同左（恢复前置校验，失败即整单 4xx） | 快照路径同左；legacy 行路径另有「部署行不存在 400 / 无 deployedVersion 400」 |
| **触发痕迹** | 不写部署行（无） | `triggerType=rollback` + 操作人（JWT 用户名） | 同 deploy-version 缺省路径 |
| **既有语义披露** | — | upgrade 链会把部署行 `startCommand` **覆写为恢复后的 `app.entrypoint`**（部署时自定义的启动命令丢失，A-4） | 同左 |
| **CLI** | `acf app set-current-version <appId> <versionId>` | `acf app deploy-version <appId> <versionId> [--executors <id1,id2>]` | 无（CLI 从未暴露 app rollback） |

### 选择指南

- **「我只想把中台记录面改回某版本（版本号/包地址/入口/环境变量），不动任何设备」** → `set-current-version`。
- **「把某版本真正推到设备（全部或指定几台）」** → `deploy-version`（缺省全量；`executorIds` 点名做定向灰度）。
- **「行为与历史版本完全一致的旧调用」** → deprecated alias（过渡期保留，新调用方禁止使用）。

### 备注

- 两端点均 ADMIN + 中档限流（与旧 rollback 写面一致）；旧端点本无独立审计落证，新端点同样不新增。
- admin-web 版本行已切换为「设为当前版本」（安全色）+「下发到设备」（危险色，弹窗按执行器勾选、仅 RUNNING 行可勾选），并在下发确认**前**展示该版本快照是否含 `packageUrl`（取代旧的事后 `packageUrlRestored=false` warning）。
- 渐进式回滚（先切 1 台观察）另有 `POST /applications/:id/upgrade-all` 的 `rollout.strategy=canary` + `version` 定向——注意该路径**也会先改写中台应用当前字段**，与 deploy-version 的「先恢复再下发」同源。
