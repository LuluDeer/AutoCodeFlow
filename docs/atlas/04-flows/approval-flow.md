# MCP 审批流（DEP-04）：应用部署的二人审批

> 所属: docs/atlas/04-flows · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/application/app-deployment.service.ts、app-deployment.controller.ts、packages/mcp-server/src/tools.ts、apps/admin-web/src/api/applications.ts

## 审批状态机与时序

```
 提交人            admin-api (app-deployment)                    Executor              审计
   │                        │                                      │                    │
   │ deploy (manual/API Key/ │ application.approvalRequired=true?                    │
   │ MCP deploy_application) │        │                                              │
   │────────────────────────▶│ 是 → 建 status=PENDING + approvalStatus=pending_approval │
   │                        │     + approvalMeta{requestedBy,requestedByName,requestedAt}
   │                        │     （:716；in-flight 唯一部分索引仍占坑，并发部署 409）  │
   │                        │     冻结：不派发（pushDeployToExecutor 只在 approve 里跑）│
   │◀─ 201 {approvalStatus:"pending_approval", ...}（读面脱敏）                     │
   │                        │                                      │                    │
   │  ┌─ 三条出口（均 ADMIN 路由，cancel 由提交人走）────────────────────────────────┐ │
   │  │ ①approve（第二人）      ②reject（第二人）           ③cancel（仅提交人）      │ │
   │  │ service :793           service :847                service :899 附近        │ │
   │  │ assertSecondPerson(:976) 同左                     requestedBy!==actor.id   │ │
   │  │ 原子认领 UPDATE WHERE approvalStatus='pending_approval' → 并发双审只有首者生效 │ │
   │  │   ↓ APPROVED            ↓ REJECTED + status=FAILED  ↓ CANCELLED + status=FAILED
   │  │ pushDeployToExecutor    从不派发                    从不派发                 │ │
   │  │ （fire-and-forget，PENDING→DEPLOYING→RUNNING/FAILED 语义由推送链独占）        │ │
   │  │ triggerType 覆写为 approval + 审批人（FEAT-20）                       │ │
   │  └─────────审计 deployment.approve/reject/cancel（writeApprovalAudit，fail-open）─┘ │
   │                        │                                      │                    │
   │                        │──POST http://<addr>/api/apps/deploy ─▶（approve 之后才发生）│
```

状态取值：`DeploymentApprovalStatus`（`entities/app-deployment.entity.ts:28`）——`pending_approval` / `approved` / `rejected` / `cancelled`；NULL = 非审批路径。待审批行复用 `status=PENDING`（不扩 DeploymentStatus 枚举），天然被 in-flight 唯一部分索引挡并发。

## admin-api 路由（app-deployment.controller.ts）

| 方法 | 路径 | 鉴权 | 锚点 |
|---|---|---|---|
| GET | `/api/app-deployments?approvalStatus=pending_approval` | JWT | `:86` |
| GET | `/api/app-deployments/approvals/pending` | `@Roles(ADMIN)` | `:132`（审批收件箱） |
| POST | `/api/app-deployments/:id/approval/approve` | `@Roles(ADMIN)` | `:146` |
| POST | `/api/app-deployments/:id/approval/reject` | `@Roles(ADMIN)` | `:170` |
| POST | `/api/app-deployments/:id/approval/cancel` | `@Roles(ADMIN)` | `:187`（服务层限定提交人） |

## mcp-server 的 4 个审批工具（packages/mcp-server/src/tools.ts:895–990）

| 工具 | 后端调用 | 说明 |
|---|---|---|
| `list_pending_approvals` | `GET /app-deployments/approvals/pending` | 审批队列；行 id 喂给下面三个工具 |
| `approve_deployment` | `POST /app-deployments/:id/approval/approve` | 通过即派发；reason ≤200 字符入审计 |
| `reject_deployment` | `POST /app-deployments/:id/approval/reject` | 拒绝不派发；第二人规则同样适用 |
| `cancel_deployment` | `POST /app-deployments/:id/approval/cancel` | 提交人自助撤回 |

另有入口工具 `deploy_application` / `deploy_app_by_name`（tools.ts:754/:808）：响应 `approvalStatus=pending_approval` 时不派发，直接在 tool 结果里附 note 提示走审批闭环——AI Agent 无需离开会话即可完成"提交 → 另一人审批"。

## admin-web 侧入口

- API 封装：`apps/admin-web/src/api/applications.ts:170–174`（approve/reject/cancel 三个调用）。
- 页面：`apps/admin-web/src/pages/AppDeploymentPage.tsx`（待审批行的通过/拒绝/撤回操作）；文案在 `locales/zh.ts`/`en.ts`（approval 相关键）；行为有测试守卫 `__tests__/app-deployment-approval.test.tsx`。

## 排查入口

| 现象 | 先看哪里 |
|---|---|
| 部署提交后执行器没收到任何请求 | `app_deployments.approvalStatus` 是否 `pending_approval`（冻结是设计行为，非故障） |
| 提交即 409 | 该应用已有 in-flight 行（含挂着的待审批行），`GET /api/app-deployments?approvalStatus=pending_approval` 找到并处置 |
| approve 报 403 | 第二人规则命中：approvalMeta.requestedBy === 审批人 id；换人或由提交人 cancel 后重提 |
| approve 报 409 "already decided" | 并发审批，首者已生效——刷新行状态即可 |
| approve 后执行器侧仍无部署 | 行 status 已转 DEPLOYING/FAILED？看 statusMessage 与 admin-api 日志 `Approved deploy push failed`（推送链 fire-and-forget） |
| 审计缺痕 | audit 是 fail-open：查 admin-api warn 日志 + `audit_logs` 中 action 前缀 `deployment.` |

## 失败分支与边界

- **409**：应用已有 in-flight 部署（含挂着的待审批行）→ `ConflictException`（isInFlightUniqueViolation，:745 附近）。待审批行会一直占坑，须 approve/reject/cancel 三选一释放。
- **第二人规则**：`assertSecondPerson`（:976）比较 `approvalMeta.requestedBy === actor.id` → 403；API-key 主体的 userId 即属主用户 id（同域可比）。任一侧未知（理论不可达）放行并 warn，避免脏数据卡死审批链。
- **并发双审批**：原子认领 `UPDATE ... WHERE approvalStatus='pending_approval'`，`affected=0` → 409 "already decided by a concurrent action"。
- **approve 后推送失败**：推送链 fire-and-forget，行转 `status=FAILED`（PENDING→DEPLOYING→FAILED 由 pushDeployToExecutor 独占）——审批记录不回滚，可重新发起部署。
- **审计 fail-open**：`writeApprovalAudit` 写 `audit_logs`（action: `deployment.approve/reject/cancel`）失败只 warn，不阻断主链。

## 常见改动场景

- **给某应用开/关审批**：`applications.approvalRequired` 字段（`application.service.ts` 更新面）；开关只影响新提交，存量 pending 行仍按原状态机走完。
- **新增审批出口**（如超时自动拒绝）：仿 `cancelDeployment` 的"findPendingApproval → 原子认领 → 终态 + 审计"四段式；切勿绕过原子认领直接 UPDATE。
- **改审批元数据**：`approvalMeta` 是 JSONB 自由结构，前端展示依赖 `requestedByName/actedByName`——增删键先看 admin-web 渲染。
- **MCP 侧加工具**：照 tools.ts DEP-04 段落的 `server.tool` 模式 + [MCP 工具](../05-interfaces/mcp-tools.md)登记。

## 相关文档

- [application 模块](../01-apps/admin-api/modules/application.md) · [app-deployment 实体](../03-data/entities/app-deployment.md) · [application 实体](../03-data/entities/application.md)
- [mcp-server 包](../02-packages/mcp-server.md) · [admin-web README](../01-apps/admin-web/README.md)
- [audit-log 实体](../03-data/entities/audit-log.md) · [安全模型](security-model.md)
