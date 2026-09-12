# application 模块 — 应用、版本与部署

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/application

## 职责

管理"应用（Application）"生命周期：应用 CRUD 与 zip 包上传、CI/CD 发版 webhook（HMAC）、版本快照（ApplicationVersion）、部署（AppDeployment = 应用实例 × 执行器）的部署/升级/停止/回滚、灰度发布（rollout）与双人审批（approval）。

## 目录结构与关键文件

```
modules/application/
├── application.module.ts      imports: TaskModule(forwardRef)、ExecutorModule、AiModule、AuditModule
├── application.controller.ts  @Controller("applications")
├── application.service.ts     应用 CRUD + 上传落盘 + manifest 任务同步 + AI 健康分析
├── app-deployment.controller.ts  @Controller("app-deployments")
├── app-deployment.service.ts  部署状态机：deploy/upgrade/stop/rollback/审批/灰度/心跳
├── entities/
│   ├── application.entity.ts          applications 表（uuid 主键）
│   ├── application-version.entity.ts  application_versions 表（(applicationId,version) 唯一）
│   └── app-deployment.entity.ts       app_deployments 表 + 状态/审批/灰度/触发枚举
└── dto/                       application / app-release / app-release-webhook / rollout / app-deployment DTO
```

## 实体速览

- **Application**：`name`（唯一）、`version`、`runtime`、`status`（active/deploying/failed）、git 三元组、`manifest`/`env`（jsonb）、`entrypoint`、`packageUrl`、`approvalRequired`（DEP-04 开关）、`webhookSecret`（`select: false`，HMAC 验签密钥）、`projectId`（可空，[project.md](project.md) 归属）、`ownerUserId`（NF-03 属主）。
- **AppDeployment**：`applicationId`、`executorAddress/executorId`、`status`（pending/deploying/running/stopped/failed/upgrading）、`runMode`（once/daemon/scheduled）、`deployedCommit/deployedVersion`、`env` 覆盖、`pid`、`lastHeartbeat`，以及批次列 `rolloutState/rolloutMeta`（DEP-02/03）、审批列 `approvalStatus/approvalMeta`（DEP-04）、触发列 `triggerType/operator`（FEAT-20）。
- **ApplicationVersion**：版本快照 `snapshot`（jsonb）、`sourceDeploymentId`、`createdBy`。

## 路由

**ApplicationController（`applications`）**：

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/applications`（`?projectId=`） | JWT | 列表；`"default"` = 默认项目视图（含未分配行） |
| GET | `/applications/:id` | JWT | 详情 |
| POST / PUT / DELETE | `/applications`、`/:id` | `@Roles(ADMIN)` | CRUD（写面经属主/项目角色守卫） |
| POST | `/applications/upload` | `@Roles(ADMIN)` | zip 包上传（multipart，200MB 上限） |
| POST | `/applications/webhook` | `@Public()` + HMAC | CI 发版入口（见下） |
| GET | `/applications/:id/versions`、`/:id/releases` | JWT | 版本历史 / 统一发布追溯（releases 分页默认 50、上限 200） |
| POST | `/applications/:id/upgrade-all`、`/:id/rollback/:deploymentId` | ADMIN + OPS_THROTTLE | 全量升级（支持 canary 灰度）/ 回滚 |
| POST | `/applications/:id/sync-tasks`、`/:id/analyze` | `@Roles(ADMIN)` | manifest 任务自动注册 / AI 健康分析 |

`upload` 校验链：`.zip` 扩展名 → ZIP 魔数（`PK\x03\x04`）→ `assertZipSafe`（zip-bomb guard，阈值 env `ZIP_*`）→ 可选 clamd 扫描（`CLAMD_ENABLED`，fail-closed 503）→ `API_BASE_URL` 未配置直接 500（R9b：先校验后写盘，失败清理孤儿 zip）。

`webhook` 验签（APP-001）：头 `X-Hub-Signature-256` = `sha256=HMAC_SHA256(webhookSecret, "${timestamp}.${rawBody}")`，头 `X-AutoCodeFlow-Timestamp` ±5min 时间窗，恒定时间比较；应用不存在/无 secret/签名错等**所有失败统一同一 401 文案**防应用名枚举，精确原因只进服务端日志。`triggerDeploy=true` 时对全部 RUNNING 部署并行触发 `upgrade`。

**AppDeploymentController（`app-deployments`）**：GET 列表（可按 `approvalStatus` 过滤）/详情；POST `applications/:appId/deploy`（ADMIN）；GET `approvals/pending`、POST `:id/approval/approve|reject|cancel`（DEP-04 双人审批：审批人 ≠ 申请人，service 强制；cancel 仅限申请人）；POST `:id/upgrade`、`:id/stop`（ADMIN + OPS_THROTTLE）；POST `heartbeat`（`@Public()`，执行器带 `X-Executor-Token`，经 `ExecutorService.validateExecutorToken` 按 deployment 关联的 executor 校验后回报应用进程状态）。

## 关键机制：部署状态机（简化）

```
deploy(ADMIN 或审批放行)
  → AppDeployment(status=pending) → 向执行器下发（ExecutorService）→ deploying
  → 执行器 heartbeat（X-Executor-Token）回写 pid/lastHeartbeat → running
upgrade → upgrading → 拉新 packageUrl 重启；stop → stopped
灰度 upgradeAllWithRollout：canary 百分比 → 健康探测 → promoted → 全量；失败自动回滚已升级台
审批：approvalRequired=true 时 deploy 冻结为 pending + approvalStatus=pending_approval
version 快照在发版/部署链路写入 application_versions，rollback 由快照恢复字段后重新升级
```

## 与其他模块的关系

- **依赖 [executor.md](executor.md)（规划中）**：部署下发、心跳 token 校验（`validateExecutorToken`）。
- **依赖 [task.md](task.md)（下一批次，forwardRef）**：`syncTasksFromManifest` 把 manifest 注册成 Task；task 模块也引用本模块（循环依赖经 `forwardRef` + `ModuleRef` lazy 解耦，`application.service.onModuleInit` 里 `moduleRef.get(TaskService, { strict: false })`，取不到则仅 warn 降级——manifest 自动注册停用但不影响启动）。
- **依赖 [ai.md](ai.md)（规划中）**：`analyzeHealth` 聚合执行统计后交 AI 评估。
- **依赖 [audit.md](audit.md)**：审批决策留痕（DEP-04）。
- **依赖 [project.md](project.md)**：`assertCanWriteProjectAware` 查项目角色（lazy，避免模块环）；列表按 `projectId` 过滤。
- **被执行器依赖**：`packageUrl` 下载安装包（`/uploads` 静态面由 main.ts 的 upload-auth 中间件保护，token 见 [../README.md](../README.md)）；`heartbeat` 回调。
- **被 [project.md](project.md) 语义约束**：应用 `projectId` 可空 = 未分配（归默认项目视图），删除项目时 FK ON DELETE SET NULL。

## 常见改动场景

- **给应用加字段**：`application.entity.ts` + 迁移；如需进 webhook/DTO 同步改 `dto/application.dto.ts`、`app-release-webhook.dto.ts`。
- **加部署动作**：优先放 `app-deployment.service.ts`（状态机集中），controller 挂 `@Roles(ADMIN)` + `@Throttle({ default: OPS_THROTTLE })`；触发语义记得落 `triggerType/operator`（FEAT-20 惯例）。
- **改上传校验**：zip-bomb 阈值走 env（`ZIP_*`），clamd 走 `CLAMD_*`，见 [../README.md](../README.md) 的 config 收口说明。
- **改 webhook 验签**：签名算法/时间窗在 `application.controller.webhook`；注意保持"所有失败路径同一 401 文案"的防枚举约束。
- **排查"上传成功但执行器拉不到包"**：查 `applications.packageUrl` 的 host 是否是执行器可达的 `API_BASE_URL`（上传时 fail-fast 要求已配置）；`/uploads` 静态面需要 JWT 或执行器 token，匿名 401 是预期行为。
- **排查"部署卡在 pending"**：`approvalRequired=true` 的应用部署行 `approvalStatus=pending_approval`，需要第二人走 `POST /app-deployments/:id/approval/approve`；批次类失败（canary 中断）重启 admin-api 后行级 `rolloutState=failed`，不会自动续跑。

## 相关文档

- 执行器：[executor.md](executor.md)（下一批次）；项目归属：[project.md](project.md)；审计：[audit.md](audit.md)
- 部署审批流：[../../04-flows/approval-flow.md](../../../04-flows/approval-flow.md)（规划中）
- 执行回调链路：[../../04-flows/execution-callback.md](../../../04-flows/execution-callback.md)
