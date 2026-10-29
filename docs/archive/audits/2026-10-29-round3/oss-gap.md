# OSS 对照审计（2026-10-29 · 第 3 轮）

> 只读审计。**本文件是本次唯一的写操作**：未改动任何源码 / 配置 / 迁移 / 其他文档，未做 git 写操作。
> 审计员：OSS 对照域。目标不是「我们少什么功能」，而是「同样一个问题，别人用什么语义解决、那个语义我们缺不缺、
> 补上要付什么代价」。每条都读了两侧代码，不采信 README 宣称。

---

## 1 方法

### 1.1 对照对象（本地 clone，depth=1，只读）

| 项目 | 许可 | 读的位置 | 为什么选它 |
|---|---|---|---|
| **trigger.dev** | Apache-2.0（部分 `ee/`） | `internal-packages/run-engine/**`、`packages/core/src/v3/**`、`packages/trigger-sdk/src/v3/**`、`internal-packages/database/prisma/schema.prisma` | 与我们的形态最接近：**持久化 run + 服务端决定重试 + worker 是外在进程**。它的 run-engine 就是「我们 BullMQ + callback 面」的另一种解法 |
| **argo-workflows** | Apache-2.0 | `pkg/apis/workflow/v1alpha1/workflow_types.go`、`workflow/controller/{retry_tweak.go,operator.go}`、`workflow/util/retry/retry.go`、`workflow/executor/plugins/rpc/plugin.go` | 把「重试 / 挂起 / 扇出 / 钩子 / 扩展点」全部**写进声明式 spec**，是「编排原语该有哪些字段」最完整的字典 |
| **langgraph** | MIT | `libs/langgraph/langgraph/{types.py,pregel/_retry.py,pregel/main.py}`、`libs/checkpoint/langgraph/checkpoint/base/__init__.py` | 长跑 Agent 循环的**检查点/中断/恢复**语义参考实现（我们 `modules/agent` 的同题不同解） |
| **windmill** | **AGPL-3.0** | `backend/windmill-api/src/{approvals.rs,jobs.rs}` | 唯一把「审批」做成**一等执行原语**（含自审批禁止）的开源实现 |
| **OpenHands** | MIT | `src/types/agent-server/core/base/common.ts`、`src/api/agent-server-adapter.ts`、`src/manifests/**` | Agent 工具调用的**风险定级 → 确认策略**链路，以及声明式扩展清单 |

> 未读：n8n / temporal / dagger（本轮 5 个本地仓已足够覆盖 10 条缺口，网络检索只会引入「宣称」而非代码；
> 见 §2 未覆盖第 6 条）。

### 1.2 本项目现状核实（不假设缺失）

按 `AGENTS.md` §1：先 `codegraph status` 确认索引新鲜（**1,986 文件 / 38,329 节点 / up to date**），
再 `codegraph explore` 定位符号，最后只对命中区间用 `read`/`sed` 取逐字代码。查过的面：

| 面 | 探查入口 | 结论落点 |
|---|---|---|
| 执行/重试语义 | `codegraph explore "task retry maxRetries attempt backoff"` → `retry-backoff.util.ts` / `task.processor.ts` / `executor.service.ts` | G1 / G2 |
| Agent 循环与检查点 | `codegraph explore "agent runtime loop checkpoint resume state"` → `agent-runtime.service.ts`(1073 行) | G5 |
| 挂起与审批门 | `agent_approvals` 实体 + `CreateAgentApprovals` 迁移 + `agent.controller.ts` | G3 / G4 |
| SOP 工作流 | `modules/sop/**`（SOP = **文档**+版+指派+澄清，不是 DAG 引擎）+ `task.entity.dependencies` | G6 |
| 事件总线/outbox | `event-subscriptions/outbox-dispatcher.service.ts`（租约 + 死信 + 保留期） | §5（强项） |
| 可观测性 | `common/tracing/tracing.service.ts`、`config/configuration.ts`、`prometheus-metrics.service.ts` | G9 |
| 插件/扩展点 | `agent/tools/tool-registry.ts`（47 工具静态数组）、`packages/mcp-server`（出站） | G8 |
| 版本化与回滚 | `task_versions` + `pinnedVersion` + `applyPinnedVersionSnapshot` | §5（强项） |
| 多租户 | `task.entity.projectId`(nullable)、`task_executions` 无 projectId、`project-access.service.ts` | §7（与 B-12 同源，不新立项） |

### 1.3 纪律

- 每条缺口的「我们现状」都指向**当前工作区文件**的行号，均由 `grep -n` / `sed -n` 当场取得。
- 「对方怎么做的」只引**实现文件**（不是 docs/README），每处 3–5 行关键代码或接口形态。
- 许可：**借设计可以，禁止复制代码**。逐条给许可提示；AGPL 项目另加红线说明。

---

## 2 未覆盖

| # | 未覆盖项 | 原因 | 怎么补 |
|---|---|---|---|
| 1 | **未跑任何测试/压测**。所有「成本 S/M/L」是按改动面估算，不是实测工时 | 只读纪律 + 工作区有并行 agent 的未提交改动 | 每条给了验收命令；实施时按条跑 |
| 2 | **未起一台执行器做端到端对照**（G2 的重试落点、G3 的超时收束都需要真执行器） | 无执行器集群；`docker-compose.demo.yml` 未联调 | 按 G2/G3 各自的「反证」构造两只假执行器 |
| 3 | **未读 trigger.dev 的 `ee/`**（企业版目录），结论只基于 Apache-2.0 部分 | 许可边界，且 ee 内容不构成「可借鉴设计」的前提 | 需要时按许可单独评估 |
| 4 | **windmill 只读了审批面**（`approvals.rs` / `jobs.rs` 的 suspend+resume），未读其 flow 引擎与 worker 调度 | AGPL：读代码做设计对照即可，不必读全 | 若要做 flow 引擎对照，另开一轮并先过许可评审 |
| 5 | **argo 的 controller 运行时行为未跑**（只读类型定义 + 重试/亲和/钩子的实现函数），`RetryAffinity` 的 pod 亲和实际生效未验证 | 无 K8s 集群 | 不影响结论：本条借的是「字段语义」，不是它的生效方式 |
| 6 | **未联网查 temporal / dagger / n8n** | 5 个本地仓已能覆盖 10 条；再引入只能拿到 README 级宣称，违反本轮「读代码取证」纪律 | 若需要「持久化执行引擎」深度对照，下一轮专门做 temporal（其 `WorkflowTask`/`ActivityTask` 语义与 G1/G5 直接可比） |
| 7 | **`apps/executor-desktop/**` 未读** | 与 G1–G10 均无交集（桌面端不参与重试预算/审批/编排） | 不补 |
| 8 | **`modules/agent/**` 属第 3 轮已登记的热区**（INDEX §6：另一 agent 正在改） | 本轮引用了它的**只读证据**（G3/G4/G5），行号可能漂移 | 派发 G3/G4/G5 前按 `git log -1 -- <file>` 复核行号；见 §7 |

---

## 3 缺口总表

| id | 一句话 | 对方 | 我们 | 成本 |
|---|---|---|---|---|
| **G1** | 重试策略每次入队现读任务当前配置，且只有 `retryCount` 一个整数，没有 attempt 级台账 | trigger.dev `lockedRetryConfig` + `TaskRunAttempt` | `task.entity.ts:166-178` 现读；`task_execution.retryCount` 单列 | M |
| **G2** | 重试可落回**刚失败的那台执行器**；退避无上限（`retryDelay × 2^n` 裸增长） | argo `RetryAffinity.nodeAntiAffinity` + `GetFailHosts`；`Backoff.cap/maxDuration` | `selectLeastLoaded()` 无排除项；`jitteredRetryDelayMs` 无 cap | S/M |
| **G3** | 挂起态（等审批/等澄清）**没有超时**，也没有超时后的默认动作 | trigger.dev waitpoint `completedAfter`；argo `SuspendTemplate.duration` | `agent_approvals` 表**无任何时间列**（除 createdAt） | S |
| **G4** | 审批人不校验「是不是他自己发起的」；会话表**根本没有 creator 列** | windmill `require_not_self_approval()` | `agent.controller.ts:276-278` 注释自认「谁持 ADMIN 谁可处置」 | S/M |
| **G5** | 无节点级检查点：不能从第 N 步回放/分叉，每次 resume 全量重建消息 | langgraph `BaseCheckpointSaver` + `get_state_history` + `put_writes` | `rebuildMessages()` 读全部 steps + 全部 tool_calls | L |
| **G6** | DAG 只有**任务粒度静态边**，只在 SUCCESS 扇出，无动态扇出/join/每边输出契约 | argo `withItems`/`outputs`；langgraph `Send` | `dependencies: Record<别名, taskId>` + `$upstream` 哨兵 | L |
| **G7** | 执行失败/结束后**没有任何可编排的出口钩子**（补偿、回滚、清理都无处挂） | argo `onExit` / `Hooks[exit]` | 失败路径零编排（下游扇出仅 SUCCESS） | M |
| **G8** | 工具/步骤类型是编译期静态数组，第三方无法注册（出站 MCP 有，入站无） | argo `ExecutorPlugin`(sidecar RPC)；OpenHands manifest 注册表 | `tool-registry.ts:127` 静态 47 条 | L |
| **G9** | 有 span 骨架但**默认关闭、parentSpanId 恒 null、agent 侧零 span**，跨进程无 trace 树 | trigger.dev 全量 OTel + attempt/tool span | `configuration.ts:740-742`；`tracing.service.ts:98-125`；`modules/agent` 零 `startSpan` | M |
| **G10** | 触发面**没有幂等键**：客户端重试 / 网络超时重放 = 第二条执行 | trigger.dev `idempotencyKeys` + `IdempotencyKey` 列 | `TriggerTaskDto` 只有 `params` + `version` | S |

> 成本口径：S ≤1h、M 半天、L >1 天（与第 3 轮 INDEX §3 同口径）。

---

## 4 逐条

### G1 重试决策不随运行锁定，且没有 attempt 级台账

**对方怎么做的**

trigger.dev 把「这次 run 允许怎么重试」在**触发时锁定进 run 行**，之后所有重试判定都读这一份
（`lockedRetryConfig`），且每次尝试有独立的 `TaskRunAttempt` 行：

- [`retrying.ts#L49-L60`](https://github.com/triggerdotdev/trigger.dev/blob/HEAD/internal-packages/run-engine/src/engine/retrying.ts#L49-L60)
  ```ts
  export async function retryOutcomeFromCompletion(
    prisma, runStore, { runId, attemptNumber, error, retryUsingQueue, retrySettings }
  ): Promise<RetryOutcome> { /* 服务端单点决定 retry | fail_run | cancel_run */ }
  ```
- [`retrying.ts#L141-L160`](https://github.com/triggerdotdev/trigger.dev/blob/HEAD/internal-packages/run-engine/src/engine/retrying.ts#L141-L160) — 没有 worker 给的 retrySettings 时，**退回锁定配置**算下一次：
  ```ts
  const retrySettings = retrySettingsFromLockedConfig(run.lockedRetryConfig, attemptNumber);
  if (!retrySettings) return { outcome: "fail_run", sanitizedError };
  return { outcome: "retry", method: "queue", settings: retrySettings, ... };
  ```
- [`schema.prisma#L1277-L1278`](https://github.com/triggerdotdev/trigger.dev/blob/HEAD/internal-packages/database/prisma/schema.prisma#L1277-L1278) — `maxAttempts Int?` + `lockedRetryConfig Json?` 与 run 同在
- [`schema.prisma#L1927-L1957`](https://github.com/triggerdotdev/trigger.dev/blob/HEAD/internal-packages/database/prisma/schema.prisma#L1927-L1957) — `model TaskRunAttempt { number / status / startedAt / completedAt / usageDurationMs }`

**我们现状**

- `apps/admin-api/src/modules/task/task.service.ts:2896-2912`：入队时**现读 `task.maxRetry` / `task.retryDelay`** 拼 BullMQ 选项——
  `attempts: Math.max(1, task.maxRetry ?? 1)`。任务行在运行中被编辑（`update_task` 是 Agent 的 approvalRequired 工具之一），
  在跑的重试预算随之改变；`pinnedVersion` 只钉了**代码快照**（`task.processor.ts:196-222`），没钉重试策略。
- `apps/admin-api/src/modules/task/entities/task-execution.entity.ts:246`：`@Column({ type:"int", default:0 }) retryCount` ——
  全仓没有任何 attempt 级行。"第 2 次尝试在 12:03 因 X 失败、耗时 41s" 这类事实无法还原，只能看到终态那一行。
- 两套预算并存且互不知情：BullMQ `attempts`（job 级）+ `retryCount`（执行行级，`executor.service.ts:1557-1594`）。

**增量落地建议（M）**

1. 迁移：`task_executions` 加 `retryPolicySnapshot jsonb`（触发时从任务行拷 `{maxRetry, retryDelay, retryableErrors}`），
   `retryBudgetExhausted()` 与该次入队的 `attempts` 一律读快照，不再读 `task.*`；
2. 新表 `task_execution_attempts`（`executionId, attemptNo, status, startedAt, endedAt, failureReason, exitCode, errorMessage`），
   在入队成功 / 回调落终态两处各插一行；`executionId + attemptNo` 唯一；
3. 执行详情页与 CSV 导出读新表（`execution-csv.ts` 的列集合加 `attemptNo`）。

**风险**：① 快照列与既有 `taskVersion` 语义重叠，需在头注写清「钉代码 vs 钉策略」；② 存量行 snapshot 为 NULL ⇒ 退化为现读（保持行为不变，不做回填）；③ 新表是高频写表，必须走 `rt-3` 的载荷裁剪纪律（attempt 行不存 logs）。

**许可**：Apache-2.0。设计（「锁定配置 + attempt 行」）可直接借鉴；`retrying.ts` 的 TS 实现不得逐段翻译。

---

### G2 重试不避开刚失败的执行器；退避无上限

**对方怎么做的**

argo 把「重试去哪」写进声明式 spec：`RetryStrategy.Affinity` + 控制器在**新建 pod 时**把「已经失败过的宿主」加成反亲和。

- [`workflow_types.go#L2377-L2379`](https://github.com/argoproj/argo-workflows/blob/HEAD/pkg/apis/workflow/v1alpha1/workflow_types.go#L2377-L2379)
  ```go
  // RetryAffinity prevents running steps on the same host.
  type RetryAffinity struct { NodeAntiAffinity *RetryNodeAntiAffinity `json:"nodeAntiAffinity,omitempty"` }
  ```
- [`retry_tweak.go#L27-L40`](https://github.com/argoproj/argo-workflows/blob/HEAD/workflow/controller/retry_tweak.go#L27-L40) — 重试时收集历史失败宿主：
  ```go
  hostNames := wfretry.GetFailHosts(nodes, retryNodeName)
  pod.Spec.Affinity = wfretry.AddHostnamesToAffinity(hostLabel, hostNames, pod.Spec.Affinity)
  ```
- [`retry.go#L10-L29`](https://github.com/argoproj/argo-workflows/blob/HEAD/workflow/util/retry/retry.go#L10-L29) — `GetFailHosts` 递归收 `Phase ∈ {Failed,Error} && Type==Pod` 的 `HostNodeName`
- 退避三件套带**上界**：[`workflow_types.go#L2356-L2370`](https://github.com/argoproj/argo-workflows/blob/HEAD/pkg/apis/workflow/v1alpha1/workflow_types.go#L2356-L2370) `Backoff{ Duration, Factor, MaxDuration, Cap }`

**我们现状**

- `apps/admin-api/src/modules/executor/executor.service.ts:4430-4510`：`selectLeastLoaded()` 的过滤维度只有
  `group / tags / runtime / runtimeVersion / 容量` —— **没有「排除上次失败的执行器」这一维**，连参数位都没有。
  注释里明确写了评分与候选池（`:4441-4457`），就是没有亲和这一轴。
- `apps/admin-api/src/modules/executor/executor.service.ts:1581-1620`：`scheduleRetryAfterRecovery()` 新建 PENDING 执行行时
  拷了 `taskId/params/triggerType/taskVersion/retryCount/mutexGroupId`，**没拷 `executorId/executorAddress`**，
  于是新执行的派发是「重新择优」，可能回到刚失败那台（`failureReason=TIMEOUT` 的机器大概率还是那台机器的老问题）。
- `apps/admin-api/src/modules/task/retry-backoff.util.ts:48`：`const base = delaySec * 1000 * Math.pow(2, effectiveAttempt - 1);`
  —— 无 cap、无 maxDuration。`maxRetry=10, retryDelay=60` ⇒ 第 10 次尝试退避约 **17 小时**（BullMQ 侧再乘一次 `2^(n-1)`，见 `task.service.ts:2906-2911`）。

**增量落地建议（S/M）**

1. `selectLeastLoaded(opts)` 加**可选尾参** `excludeAddresses?: string[]`（零参数调用行为不变，与 `runtimeVersion` 同款）；
   `dispatch` / `dispatchBroadcast` 三站点共享；
2. `scheduleRetryAfterRecovery()` 把原执行的 `executorAddress` 塞进新执行的**不派发提示**（新增列 `avoidExecutorAddress varchar(255) nullable`），
   派发时转成 `excludeAddresses`；若排除后无候选，**回退到不排除**并 warn（避免重试被亲和性饿死——这点必须显式写，argo 靠 K8s 调度器兜底，我们没有）；
3. 退避上界：`retry-backoff.util.ts` 增加 `MAX_RETRY_DELAY_MS = 30min` 常量并 `Math.min`；`retryDelay` 的 DTO 侧已有上界，不需要动。

**风险**：① 「始终同一台机器失败」时排除会把它永久踢出候选 → 必须保留回退分支与 warn 计数；② 新列要进 `check-index-drift` 的比对集（否则又是一条未登记列）；③ 与 `SEC-R3-1/2/3`（T2）同文件 `executor.service.ts`，**串行做**。

**许可**：Apache-2.0。`GetFailHosts` 的语义（收集历史失败宿主 → 反亲和）可借；Go 实现不复制。

---

### G3 挂起态没有超时，也没有超时后的默认动作

**对方怎么做的**

- trigger.dev：waitpoint 创建时就带 deadline，`timeoutAt` 一路回传，**到期由协调器主动收束**：
  [`wait.ts#L80-L100`](https://github.com/triggerdotdev/trigger.dev/blob/HEAD/packages/trigger-sdk/src/v3/wait.ts#L80-L100)
  ```ts
  function createToken(options?: { idempotencyKey?; timeout?: string | Date; ... }) { ... }
  ```
  [`types.ts#L122`](https://github.com/triggerdotdev/trigger.dev/blob/HEAD/internal-packages/run-engine/src/engine/waitpointCoordinator/types.ts#L122) — `completedAfter: Date`；[`storeCoordinator.ts#L61`](https://github.com/triggerdotdev/trigger.dev/blob/HEAD/internal-packages/run-engine/src/engine/waitpointCoordinator/storeCoordinator.ts#L61) 同名字段进协调器。
- argo：挂起模板自带时长，到期**自动恢复**而不是等人：
  [`workflow_types.go#L3727-L3731`](https://github.com/argoproj/argo-workflows/blob/HEAD/pkg/apis/workflow/v1alpha1/workflow_types.go#L3727-L3731)
  ```go
  type SuspendTemplate struct {
    // Duration is the seconds to wait before automatically resuming a template.
    Duration string `json:"duration,omitempty"`
  }
  ```

**我们现状**

- `apps/admin-api/src/migrations/1790000000067-CreateAgentApprovals.ts:21-34`：`agent_approvals` 的全部列是
  `id / approvalKey / sessionId / toolName / reason / status / decidedBy / decidedAt / createdAt`，**再叠加
  `1790000000068` 只加了 `consumedAt`** —— 没有任何 `expiresAt` / `deadline` / `timeoutAction` 列。
- 后果链：`agent_session.status = "waiting_input"`（`entities/agent-session.entity.ts:50-57`）是**终态之外的悬挂态**，
  `agent-session-retention.service.ts:182-198` 明确「pending 审批单不自动消失，交人工处置」——
  一张没人看的审批单能让会话永久挂在 `waiting_input`，占着「未收敛会话」的账，不出现在任何告警里。
- 唯一相关的兜底是 `run()` 开头的「30 分钟陈旧 running 清扫」，它**只扫 running，不碰 waiting_input**（`agent-runtime.service.ts:300-320`）。

**增量落地建议（S）**

1. 迁移：`agent_approvals` 加 `"expiresAt" TIMESTAMPTZ` + `"timeoutAction" varchar(16) default 'deny'`（`deny` / `escalate`，默认 deny = fail-closed）；
   建表时按 `reason` 的工具档位给默认 TTL（`dangerous` 1h、`approvalRequired` 24h），**可被会话预算里的字段覆盖**；
2. `AgentApprovalsService` 加 `expireStale()`，挂在既有 `AgentSessionRetentionService` 的 cron 上（同一个 cron 内顺带，不新增定时器）；
   到期把单翻 `expired`（新状态）并 `settleToolCallByApprovalId(key,"denied","审批超时未处置")`，随后复用既有 resume 链路让模型看到「被拒」；
3. 运营面：`agent_approvals` 已有 `idx_agent_approvals_status_createdAt`，加一个 `autoflow_agent_approvals_pending_age_seconds` 指标（走 `recordRuntime` + `labelValueSets` 登记）。

**风险**：① 新增状态值要同步 `AGENT_APPROVAL_STATUSES`（`entities/agent-approval.entity.ts:32-45`）、admin-web 的徽章映射、`agent-boundary-check.mjs` 的判据；
② 「到期自动拒绝」会改变既有用户预期（现在挂着就一直等）——建议 `timeoutAction` 默认 `deny` 但**首版只发通知不自动拒**，灰度一轮再切，避免把「慢审批」变成「误拒」；
③ 与 G4 同一个迁移窗口，建议合并一次迁移。

**许可**：Apache-2.0（trigger.dev / argo）。「deadline 落库 + 到期收束」是通用设计，无许可问题。

---

### G4 审批人不校验「是不是自己发起的」（四眼原则靠删能力实现）

**对方怎么做的**

windmill 把「不能自己批自己」做成**审批时的身份判定**，记录触发者邮箱，resume 时比对（管理员豁免）：

- [`jobs.rs#L6232-L6247`](https://github.com/windmill-labs/windmill/blob/HEAD/backend/windmill-api/src/jobs.rs#L6232-L6247)
  ```rust
  fn require_not_self_approval(authed: &ApiAuthed, approval_conditions: &ApprovalConditions, trigger_email: &str) -> error::Result<()> {
      if approval_conditions.self_approval_disabled && !authed.is_admin && authed.email.eq(trigger_email) {
          return Err(Error::PermissionDenied("Self-approval is disabled for this flow step".to_string()));
      }
      Ok(())
  }
  ```
- [`jobs.rs#L5383-L5393`](https://github.com/windmill-labs/windmill/blob/HEAD/backend/windmill-api/src/jobs.rs#L5383-L5393) — 条件装配（`user_auth_required` / `user_groups_required` / `self_approval_disabled`）
- [`jobs.rs#L5318-L5333`](https://github.com/windmill-labs/windmill/blob/HEAD/backend/windmill-api/src/jobs.rs#L5318-L5333) — 注释点明「owner 也不能自批，owner 快捷方式只豁免鉴权要求」
- 审批面形态：[`approvals.rs#L25-L30`](https://github.com/windmill-labs/windmill/blob/HEAD/backend/windmill-api/src/approvals.rs#L25-L30)、[`#L94-L113`](https://github.com/windmill-labs/windmill/blob/HEAD/backend/windmill-api/src/approvals.rs#L94-L113)（`ResumeSchema` + `ApprovalFormDetails`）

**我们现状**

- `apps/admin-api/src/modules/agent/agent.controller.ts:276-278` 注释逐字写着：
  「审批单本身不校验调用方会话，**谁持 ADMIN 谁可处置**」。`decideApproval()`（`:261-330`）只校验
  `approval.sessionId === session.id` + 条件写 `pending → granted`，**没有 `decidedBy ≠ 发起人` 的任何判定**。
- 更硬的事实：`agent_sessions` 表**没有 creator 列**（`entities/agent-session.entity.ts` 全文无 `createdBy/userId/requester`），
  所以「发起人是谁」今天在审批链路上**不可得**——不是漏判，是无数据可判。
- 现在的四眼原则靠**删能力**实现：`agent/tools/tool-registry.ts:92-98` 的 `HARD_DISABLED_REASON` 把「审批类工具」对 Agent 永久禁用
  （「若 Agent 既能发起部署又能自行审批，双人原则被彻底架空」）。这挡住的是 Agent 自批，挡不住**人类操作员自批**：
  同一个管理员点 `POST /agent/sessions` 发起会话、再点 `grant`，闭环成立。

**增量落地建议（S/M）**

1. 迁移：`agent_sessions` 加 `"createdBy" varchar(64)`（存量行 NULL = 未知，不做回填；NULL 时按「不可判定」处理并 warn）；
   新建会话的三处入口（`agent.controller` 的 create、`sop-review` 派生、cron 派生的 `ops_watch`）写当前主体，系统主体写 `system:<cron名>`；
2. `AgentApprovalsService.decide()` 加判定：`approval.decidedBy === session.createdBy` ⇒ 403 `AGENT_APPROVAL_SELF_DENIED`，
   **仅豁免 `role=admin` 且配置 `agent.policy.allowSelfApproval=true`**（默认 false，与 windmill 相反的默认值选择需评审）；
3. 顺带补「审批人资格」：`ApprovalPolicy` 已有 `allowDangerous` 等字段（`boundary/agent-boundary.service.ts:52-76`），
   加 `approverRoles: string[]`，在 `decide()` 里校验（这一条是 windmill `user_groups_required` 的等价物）。

**风险**：① 单人部署（POC / demo）会**立刻卡死所有审批** → 必须给 `allowSelfApproval` 的显式逃生口并写进部署文档；
② `createdBy` 为 NULL 的存量会话若一律拒绝会破坏在跑的会话，故取「warn + 放行」并计数；
③ 与 G3 同一迁移窗口；④ 与 `route-authz-matrix.spec.ts`（253 路由）无冲突（不改路由 class）。

**许可**：**windmill 是 AGPL-3.0**。此条只借「在 resume 边界比对触发者身份」这一个设计判断，
**不得**复制 `jobs.rs` 的代码、不得复制其 resume-secret URL 方案（见 §6 第 1 条）。

---

### G5 无节点级检查点：不能从第 N 步回放/分叉，每次 resume 全量重建

**对方怎么做的**

langgraph 的检查点是**带父指针的不可变快照链**，「读到最新」「列出历史」「写部分结果」是三件独立的事：

- [`base/__init__.py#L262-L343`](https://github.com/langchain-ai/langgraph/blob/HEAD/libs/checkpoint/langgraph/checkpoint/base/__init__.py#L262-L343) — 抽象面：
  `get_tuple(config)` / `list(...)` / `put(...)` / `put_writes(...)` / `delete_thread(...)`
  ```python
  def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None: ...
  def put(self, config, checkpoint, metadata, new_versions) -> RunnableConfig: ...
  def put_writes(self, config, writes, task_id, task_path="") -> None: ...
  ```
- [`pregel/main.py#L1514`](https://github.com/langchain-ai/langgraph/blob/HEAD/libs/langgraph/langgraph/pregel/main.py#L1514) `get_state_history()`、
  [`#L2617`](https://github.com/langchain-ai/langgraph/blob/HEAD/libs/langgraph/langgraph/pregel/main.py#L2617) `update_state()` —— 时间旅行 / 从任意快照分叉
- [`types.py#L903-L928`](https://github.com/langchain-ai/langgraph/blob/HEAD/libs/langgraph/langgraph/types.py#L903-L928) `interrupt()`：挂起即「在快照上开一个待填的洞」，恢复是 `Command(resume=...)` 填洞，**不是重跑整个循环**

**我们现状**

- `apps/admin-api/src/modules/agent/runtime/agent-runtime.service.ts:823-895`：`rebuildMessages(sessionId)` 每次 resume
  都把**全量** steps + 全量 tool_calls 读出来重放成 messages；
- `apps/admin-api/src/modules/agent/runtime/agent-session.service.ts:252-257`：`listSteps()` **无 limit、无投影**（`find({ where, order })` 全列）；
  `:259-264` `listToolCalls()` 同形。一个 200 步的会话每次 resume 物化 200 + ~400 行。
- 没有「快照」概念：`agent_steps` 是 append-only 台账，不是 checkpoint。因此今天做不到
  「从第 37 步重跑」/「在第 37 步分叉出另一条会话」/「对比第 37 步与第 41 步的上下文差异」。
- 已有的确定性重放（`replayApprovedToolCalls()`，`:648-686`）只有「审批已批准但未执行」一个场景。

**增量落地建议（L，分两步）**

**第一步（M，只解决成本与可诊断性，不引入新模型）**：
1. `listSteps` / `listToolCalls` 加 `limit` + 列白名单；resume 时只读 `seq > lastFoldedSeq` 的尾段 +
   一次「折叠摘要行」（会话折叠已存在，见 `:866` 的 `if (s.role !== "assistant" || s.summary) continue;`），把 `O(全量)` 降到 `O(尾段)`；
2. 每轮结束写一行 `agent_sessions.lastCheckpointStepId`（尾部指针），resume 从它开始。
   这一步**不改语义**（重放规则不变），只把重建变便宜，与 `db-4/db-8`（列表读面族）同批。

**第二步（L，可选项，需评审）**：引入 `agent_session_checkpoints(sessionId, seq, parentSeq, stateJson, createdAt)`，
在「工具执行前」与「工具执行后」各落一次（对应 langgraph 的 `put` 与 `put_writes` 两个时机）——
前者保证崩溃后不会重复副作用，后者保证已发生的副作用不会被重放。**只有这一步才能支持分叉回放。**

**风险**：① `modules/agent/**` 是第 3 轮已登记热区，改动必须与写入方串行；② 第二步的 `stateJson` 会让表体积快速增长
（需按既有 retention `agent-session-retention.service.ts` 同步加保留期，否则又是一条 db 级隐患）；
③ 折叠语义与检查点语义**会打架**（折叠丢 tool_calls，检查点要完整），必须明确「检查点存原始、折叠存视图」；
④ 不要为此引入 langgraph 的 BSP/通道模型（见 §6 第 3 条）。

**许可**：MIT（langgraph）。`BaseCheckpointSaver` 的**接口形状**（get/put/put_writes/history）可借鉴；Python 实现不复制，
也不要引入 `@langchain/langgraph` 依赖（跨生态，且我们已有自己的循环）。

---

### G6 DAG 只有任务粒度静态边，只在成功时扇出

**对方怎么做的**

- argo：扇出是**模板上的字段**（列表 / 参数展开），join 由 DAG 的依赖集合表达：
  [`workflow_types.go#L1783-L1788`](https://github.com/argoproj/argo-workflows/blob/HEAD/pkg/apis/workflow/v1alpha1/workflow_types.go#L1783-L1788)
  ```go
  // WithItems expands a step into multiple parallel steps from the items in the list
  WithItems []Item `json:"withItems,omitempty" protobuf:"bytes,5,rep,name=withItems"`
  ```
  同类字段在 DAG task 上另有定义 [`#L3646-L3651`](https://github.com/argoproj/argo-workflows/blob/HEAD/pkg/apis/workflow/v1alpha1/workflow_types.go#L3646-L3651)
- langgraph：动态扇出走**运行时**决定的 `Send` 列表（map-reduce），不是静态边：
  [`types.py#L738`](https://github.com/langchain-ai/langgraph/blob/HEAD/libs/langgraph/langgraph/types.py#L738) `class Send:`
- 两者的共同点：**边的两端有数据契约**（argo `outputs.parameters` → 下游 `inputs.parameters`），且 join 语义显式（all-of / any-of）

**我们现状**

- 边的形态：`apps/admin-api/src/modules/task/entities/task.entity.ts:146-149`
  ```ts
  @Column({ type: "jsonb", nullable: true }) dependencies: Record<string, string>;
  ```
  —— 值只能是**任务 id**（`dto/create-task.dto.ts:45`、约束 `dependency-map.constraint.ts`），键只是显示名。
  没有「这条边传什么」，也没有「哪次上游执行」。
- 判定粒度是**任务的最新一次执行**，不是本次运行的上游执行：`dependency-gate.util.ts:36-56`
  （`where: { taskId: In(dependencyIds) }, order: { createdAt: "DESC" }` 取每任务最新行判 SUCCESS）。
- 扇出**只在成功路径**：`task.service.ts:5892-5894`（`if (patch.status === SUCCESS) await this.triggerDependentTasks(...)`）、
  `:5755`（重复回调补扇出，同样要求 `status === SUCCESS`）。失败/超时/取消**不触发任何下游**，包括「补偿任务」这种最常见的需要。
- 已有的微弱数据传递是全局哨兵：`task.service.ts:312` `UPSTREAM_SENTINEL = "$upstream"`、`:386-400` 深遍历替换、
  `:4467` 仅当有下游声明哨兵才读上游行。它是**一个上游的整块上下文**，不是每边输出。

**增量落地建议（L，拆成三小步，每步独立可上线）**

1. **S — 失败边**：`dependencies` 支持 `{ "<别名>": { "taskId": "...", "on": ["success"] | ["failure"] | ["always"] } }`，
   解析期归一化（老形态 string ⇒ `on: ["success"]`，零迁移）。这一步让「失败补偿/清理」可编排，成本最低、收益最高的 20%。
2. **M — 每边输出**：`$upstream` 哨兵扩展为 `$upstream("<别名>")`，取值来自该上游**本次**执行的 `result` 字段
   （需要把 `depsFiredAt` 那套「哪次上游」的关联从 `latest` 改成「触发本次扇出的那次执行 id」，`triggerDependentTasks(completedTaskId, completedExecutionId)` 已有该 id，只是没用它建边）。
3. **L — 动态扇出**：新增 `fanout: { over: "$params.<key>", task: "<id>" }` 形态，一次触发 N 条子执行 + 一个聚合步。
   **不建议**在本轮做（见 §6 第 3 条，不要引入 langgraph 的图模型）。argo 的 `withItems` 只是字段形状参考。

**风险**：① `dependencies` 是 jsonb 且已有 GIN 表达式索引 `idx_tasks_dependencies_values_gin`（迁移 `1790000000053`），
形态从 `Record<string,string>` 变成 `Record<string,object>` 会让该索引的表达式**失效**——必须先写迁移把表达式改成兼容两种形态的 IMMUTABLE 函数，
否则 B-3 那次优化被本改动悄悄回退（这是本条目最大的坑，必须与 db 侧一起评审）；
② 失败边会让「一次失败触发一片下游」，需要同一把 `claimDependencyTrigger` 去重 + 深度上限（既有 `detectCycle` 只防环，不防扇出宽度）；
③ `on: ["failure"]` 的执行行 `triggerType` 要新增取值，`execution-csv.ts` 与前端筛选器同改。

**许可**：Apache-2.0（argo）/ MIT（langgraph）。字段语义可借，实现不复制。

---

### G7 执行失败/结束后没有任何可编排的出口钩子

**对方怎么做的**

argo 在三个层级（workflow / step / dag-task）都提供「无论主任务成功失败都跑」的钩子：

- [`workflow_types.go#L386-L388`](https://github.com/argoproj/argo-workflows/blob/HEAD/pkg/apis/workflow/v1alpha1/workflow_types.go#L386-L388)
  ```go
  // onExit ... irrespective of the success, failure, or error of the primary workflow.
  OnExit string `json:"onExit,omitempty" protobuf:"bytes,17,opt,name=onExit"`
  ```
- [`#L1811-L1813`](https://github.com/argoproj/argo-workflows/blob/HEAD/pkg/apis/workflow/v1alpha1/workflow_types.go#L1811-L1813) — step 级 `Hooks LifecycleHooks`
  （注释：`OnExit` 已 deprecated，推荐 `Hooks[exit]`；另有 `error` 钩子）
- [`#L386-L388`](https://github.com/argoproj/argo-workflows/blob/HEAD/pkg/apis/workflow/v1alpha1/workflow_types.go#L386-L388) 与
  [`#L464`](https://github.com/argoproj/argo-workflows/blob/HEAD/pkg/apis/workflow/v1alpha1/workflow_types.go#L464) 分别覆盖 workflow 级与 spec 级

**我们现状**

- 失败路径**零编排**：`task.service.ts:5892-5894` 只在 `SUCCESS` 扇出；`:5747-5756` 的补扇出也要求 SUCCESS。
  timeout 的处置是一个**闭集枚举**而不是可编排动作：`task.service.ts:5846-5875` 的 `kill_retry` 分支。
- `task.entity.ts` 全文没有任何 `onFailure` / `onExit` / `hooks` / `cleanup` 字段（对照同文件 `:146` 的 `dependencies`——
  编排能力只存在于「依赖」这一个维度）。
- 现有的「收尾」全部是**代码内硬编码**：应用部署失败回滚走 `app-deployment.service.ts` 的自有状态机，
  执行器包清理走 retention cron。用户无法声明「这个任务失败后跑另一个任务」。

**增量落地建议（M）**

1. 复用 G6 第 1 步的 `on` 语义即可覆盖 80% 的补偿需求（`on: ["failure"]` / `["always"]`）——**先做 G6-1，本条不必独立立项**；
2. 本条真正独有的是**执行级钩子**（不依赖任务图）：`task.entity` 加 `exitHook: { taskId, on: "always"|"failure"|"success", params?: Record<string,unknown> }`，
   在 `emitTerminalEvent` 的唯一出口（`task/execution-terminal.ts`）之后触发一次，`triggerType="exit_hook"`；
3. 钩子的执行必须**不可递归**（钩子任务自身的 exitHook 不触发）——在触发前查一次 `triggerType`，避免无限链；
   并给钩子一次独立的超时（复用 `timeout-policy.util.ts`）。

**风险**：① 钩子触发失败不能改变主执行的终态（主执行已 committed），必须 best-effort + 审计；
② `emitTerminalEvent` 是 `rt-3`（T5）正在动的出口，**同文件串行**；
③ 钩子会产生「用户没预期的执行行」，需在 `/tasks/executions` 的默认过滤里可见（否则变成幽灵执行）。

**许可**：Apache-2.0（argo）。字段名与语义可借。

---

### G8 工具/步骤类型不可第三方扩展（出站 MCP 有，入站无）

**对方怎么做的**

- argo：第三方步骤 = **sidecar 进程 + 一条固定 RPC**，主仓不需要知道它是什么：
  [`workflow_types.go#L1299-L1306`](https://github.com/argoproj/argo-workflows/blob/HEAD/pkg/apis/workflow/v1alpha1/workflow_types.go#L1299-L1306)
  ```go
  type ExecutorPlugin struct { metav1.ObjectMeta; Spec ExecutorPluginSpec }
  type ExecutorPluginSpec struct { Sidecar ExecutorPluginSidecar }
  ```
  [`rpc/plugin.go#L12-L28`](https://github.com/argoproj/argo-workflows/blob/HEAD/workflow/executor/plugins/rpc/plugin.go#L12-L28)
  ```go
  func New(address, token string) executorplugins.TemplateExecutor {
    return &plugin{Client: rpc.New(address, token, 30*time.Second, wait.Backoff{...})}
  }
  func (p *plugin) ExecuteTemplate(ctx, args, reply) error { return p.Call(ctx, "template.execute", args, reply) }
  ```
  —— 契约只有 `template.execute(args, reply)` 一个方法名。
- OpenHands：扩展是**声明式清单 + 宿主生成 UI**，不是往核心塞代码：
  [`manifests/types.ts#L1-L30`](https://github.com/All-Hands-AI/OpenHands/blob/HEAD/src/manifests/types.ts#L1-L30)
  （`SETUP_VERSION` / `SetupFieldType` 闭集 / `SETUP_PLACEHOLDER_NAMESPACES`）
  [`manifests/manifest-registry.ts#L13-L19`](https://github.com/All-Hands-AI/OpenHands/blob/HEAD/src/manifests/manifest-registry.ts#L13-L19) `createSetupRegistry(...)`
  [`manifests/manifest-sources.ts#L18-L29`](https://github.com/All-Hands-AI/OpenHands/blob/HEAD/src/manifests/manifest-sources.ts#L18-L29) `SETUP_REGISTRY`

**我们现状**

- Agent 的工具集是**编译期静态数组**：`apps/admin-api/src/modules/agent/tools/tool-registry.ts:127`
  `export const AGENT_TOOL_SPECS: readonly AgentToolSpec[] = [...]`（头注自称「47 个收编的工具，对齐 mcp-server/src/tools.ts」），
  每个 spec 是 TS 字面量（`:86` 的 `approvalRequired?`、`:76` 的 `freeTextFields?`）。
  加一个工具 = 改源码 + 发版；边界（`agent-boundary.service.ts`）、执行器（`tool-executor.service.ts:546-552` 的
  `ALL_AGENT_TOOL_SPECS` 过滤）、MCP 侧 `tools.ts`、前端工具名映射**四处同时改**。
- 我们**有出站** MCP（`packages/mcp-server` 把 ACF 暴露给外部 Agent，56 工具），也**没有入站**：
  admin-api 侧没有任何 MCP client（`grep -il mcp apps/admin-api/src` 的命中全是 agent 自己的工具名/配置 DTO）。
- 现状的合理性：47 个工具全部由我们自己执行，白名单/审批/限流都建立在「静态可知的工具集」上——
  这正是本轮不想直接推翻的原因（见 §6）。

**增量落地建议（L）**

1. **先落「工具描述符表」而不是「动态注册」**：迁移建 `agent_tool_descriptors(name, tier, schemaJson, approvalRequired, freeTextFields, enabled, source)`，
   把 `tool-registry.ts` 的 47 条**生成**进去（构建期脚本 + 守卫断言「源码常量 ⊆ 表），运行期读表。
   这一步不引入外部执行，但让工具面可版本化、可按租户开关；
2. 第二步才允许 `source = "remote-mcp"`：一个受控的出站 MCP client（`ALLOWED_MCP_HOSTS` 白名单 + 复用 `safe-http.util.ts` 的
   `assertAndPinHttpUrl`），工具调用走 `tool-executor.service` 的既有闸门（boundary → 审批 → 限流 → 审计）；
3. 远程工具的 `tier` **强制 minimum `write`**、`approvalRequired` 强制 true（fail-closed），无 schema 的远程工具直接拒。

**风险**：① 这是唯一一条会**扩大安全边界**的改动（远程代码进我们的执行链），必须绑定 SSRF 白名单 + 审批 + 逐工具开关；
② 描述符表与 `agent-boundary-check.mjs` / `route-authz-matrix` 的判据要同步（否则「写了不接线」再现）；
③ 工作量真实评估见 §8：排在最后，且前提是 G9 可观测性先到位（否则远程工具的黑盒调用不可诊断）。

**许可**：Apache-2.0（argo）/ MIT（OpenHands）。只借「sidecar 单方法 RPC」「声明式清单 + 宿主渲染」两种形态。

---

### G9 没有跨进程 trace 树：span 默认关闭、父子关系恒 null、agent 侧零 span

**对方怎么做的**

trigger.dev 把 OTel 做到「每次 attempt / 每次工具调用都是一个 span」，trace 能在 UI 里展开：

- [`retrying.ts#L49`](https://github.com/triggerdotdev/trigger.dev/blob/HEAD/internal-packages/run-engine/src/engine/retrying.ts#L49) 的重试决策本身就是 span 内的动作（`run-engine` 全域走 `tracer`）
- [`wait.ts#L243-L244`](https://github.com/triggerdotdev/trigger.dev/blob/HEAD/packages/trigger-sdk/src/v3/wait.ts#L243-L244) —— 连 waitpoint 都往 span 上挂属性：
  ```ts
  if (body.timeoutAt) { span.setAttribute("timeoutAt", body.timeoutAt.toISOString()); }
  ```
- [`concurrencyLimits.ts#L16-L20`](https://github.com/triggerdotdev/trigger.dev/blob/HEAD/packages/trigger-sdk/src/v3/concurrencyLimits.ts#L16-L20) —— 每个 SDK 动作都 `import { tracer }`，即「默认全程有 trace」
- 独立包：`internal-packages/tracing`、`internal-packages/otel-*`（不是我们这种「只有 API 层」方案）

**我们现状**

- 有骨架，但**默认是关的**：`apps/admin-api/src/config/configuration.ts:739-742`
  ```ts
  // OBS-01: ... 默认 false——零开销零行为变化（TracingService 全方法短路）
  tracing: { enabled: process.env.OTEL_ENABLED === "true" },
  ```
- span **不成树**：`apps/admin-api/src/common/tracing/tracing.service.ts:98-125` 的 `startSpan()` 把所有 span 写成
  `[trace] start span=... trace=... name=...` 的**日志行**，且 `:110` 明写
  `parentSpanId: null, // 进程内跨异步上下文的父关系在本仓库跨度上不落库`。
- 只有 5 个埋点站点（`task.trigger` / `dispatch.http` / `callback.receive`×2 / `scheduler.enqueue` / `pull`），
  **`modules/agent/**` 零 `startSpan`**（`grep -rn startSpan modules/agent | wc -l` = 0）——
  也就是说 Agent 的每一轮 LLM 调用、每一次工具执行，在 trace 上完全不存在。这正好是「最需要看」的那一段。
- 附带：`TraceModule` 注册了但 `TraceService` 只有 spec/module 两处引用（第 3 轮 OBS3-07 已登记）。

**增量落地建议（M）**

1. **保持 OTel API-only 架构不变**（我们不引 `sdk-*`/exporter，见 `tracing.service.ts:14-21` 的架构决策），但补三样：
   ① `parentSpanId` 从 `AsyncLocalStorage` 里取当前 spanId（`TraceService.storage` 已经存在，只需扩展存 `{traceId, spanId}`）；
   ② span 结束行改为**结构化 JSON**（`{event:"span.end", traceId, spanId, parentSpanId, name, durationMs, attrs}`），
   让 Loki 能按 `parentSpanId` 建树；
   ③ 新增 `agent.turn` / `agent.tool_call` / `llm.request` 三个 span（分别包 `agent-runtime.service.ts` 的循环体、
   `tool-executor.service.ts` 的执行体、`ai.service` 的调用），属性带 `sessionId/stepSeq/toolName/tokensIn/tokensOut`。
2. 把 `tracing.enabled` 的默认值改成 `true`（现在是 false）——先决条件是 ②，否则只是多打日志。
3. 与 OBS3-07 合并：删 `TraceService` 死代码、让 `req.traceId` 有消费者，这两条是同一次改动。

**风险**：① 默认开启会增加日志量（`startSpan/endSpan` 各一行 × 每轮），需要 Loki 侧配额评估；
② `AsyncLocalStorage` 在 BullMQ processor 与 SSE 长连接里的传播需要显式 `runWithTrace`（否则父子断裂，又是一堆 `parentSpanId=null`）；
③ 与 `modules/agent/**` 热区冲突，串行做。

**许可**：Apache-2.0（trigger.dev）。OTel 语义是标准，无许可问题。

---

### G10 触发面没有幂等键

**对方怎么做的**

trigger.dev 把幂等键做成一等参数与一等列：

- [`idempotencyKeys.ts#L8-L15`](https://github.com/triggerdotdev/trigger.dev/blob/HEAD/packages/trigger-sdk/src/v3/idempotencyKeys.ts#L8-L15)
  ```ts
  export const idempotencyKeys = { create: createIdempotencyKey, reset: resetIdempotencyKey };
  ```
- [`wait.ts#L80-L100`](https://github.com/triggerdotdev/trigger.dev/blob/HEAD/packages/trigger-sdk/src/v3/wait.ts#L80-L100) —— 连 `createToken` 都接受 `idempotencyKey`
- 落库侧有 `IdempotencyKey` 模型，且 waitpoint 协调器在 key 过期时**显式处理**：
  [`legacyPostgresCoordinator.ts#L241`](https://github.com/triggerdotdev/trigger.dev/blob/HEAD/internal-packages/run-engine/src/engine/waitpointCoordinator/legacyPostgresCoordinator.ts#L241) `//the idempotency key has expired`

**我们现状**

- `apps/admin-api/src/modules/task/dto/trigger-task.dto.ts:5-28`：`TriggerTaskDto` 只有两个字段 ——
  `params?`（带 64KB 体积闸）与 `version?`（版本钉定）。**没有 `idempotencyKey`**。
- `POST /tasks/:id/execute` 的语义因此是「每次调用创建一个新执行行」。客户端超时重试、网关重放、
  脚本里 `for` 循环重跑一次 = 第二条执行行 = 第二次真实副作用。
- 部分场景被别的东西挡住了，但那不是幂等：`blockStrategy`（`task/block-strategy-gate.ts:1-40`）判的是
  「**同参**是否正在跑/排队」，只在 `discard`/`cover_early` 且**在跑窗口内**生效；执行完再重放照样创建新行。

**增量落地建议（S）**

1. 迁移：`task_executions` 加 `"idempotencyKey" varchar(128)` + 唯一索引
   `UNIQUE ("taskId","idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`（partial，存量行不受影响）；
2. `TriggerTaskDto` 加 `idempotencyKey?: string`（`@Length(8,128)`）；`TaskService.trigger()` 在 `INSERT` 前用
   `INSERT ... ON CONFLICT DO NOTHING RETURNING`，冲突则**返回既有执行行**（HTTP 200 + `deduplicated: true`），不新建；
3. 语义边界写进 DTO 描述：键的作用域是 `(taskId)`，生命周期与执行行同寿（retention 一起清），
   与 `blockStrategy` 正交（前者防重放、后者防并发）；`rollback` / `dependency` / `cron` 三条路径**不带键**（它们本身就是新语义）。

**风险**：① partial unique 索引要按 `db-1` 的纪律写（`CREATE UNIQUE INDEX CONCURRENTLY` + `transaction=false` + timeout 豁免）；
② 客户端可能用同一个键重放**不同** `params`——必须校验「同键不同参」返回 409 而不是静默返回旧行（否则是数据错乱）；
③ 与 `SEC-R3-4`（入站 webhook 重放）**同一份幂等键契约**，建议合并一次设计（见 §7）。

**许可**：Apache-2.0（trigger.dev）。“幂等键 + partial unique + ON CONFLICT 返回既有行”是通用模式，无许可问题。

---

## 5 我们更强的地方

> 这一节不是自我安慰：以下 6 条的**语义强度**确实高于对照对象，建议在后续改动中**明确保护**，
> 尤其不要让 §4 的增量把它们的性质改掉。

### 5.1 版本钉定重放是「派发载荷覆盖 + 库内零写入 + fail-closed」

`apps/admin-api/src/modules/task/task.processor.ts:196-222`：`pinnedVersionId` 只覆盖派发载荷
（`applyPinnedVersionSnapshot`），任务行零写入；版本行取不到时 **fail-closed** 抛 `TASK_PINNED_VERSION_GONE`，
注释明写「宁可执行失败，也不静默改跑当前配置」。`entities/task-version.entity.ts:13-16` 的
`ux_task_versions_taskId_version` 唯一约束 + `:30` `snapshot: Record<string, any>`。

对照：trigger.dev 的 deployment 钉定是**平台自动**（`schema.prisma#L2735-L2736` `workerDeploymentId`），
用户无法「拿第 3 版再跑一次」；argo 的模板版本完全靠 Git。**我们的「按版本快照重放」是用户可选且带 fail-closed 的**，
这一条别被 G1 的「retryPolicySnapshot」改坏——两者要分列，不要合成一个「钉定」概念。

### 5.2 互斥组带「N 并发 + device/global 两种作用域」

`apps/admin-api/src/modules/application/entities/mutex-group.entity.ts:42`（`maxConcurrentPerDevice`，DB CHECK 兜底下界）
与 `:52`（`scope: "device" | "global"`，`global` 时占坑判定不带设备条件，跨设备竞态由
`mutex_groups` 行 `FOR UPDATE` 关闭）。执行行还带**创建时的组快照** `task_executions.mutexGroupId`（`:306`），
组被删/改不影响在跑执行。

对照：argo 的 `Mutex`（`workflow_types.go#L1958-L1961`）只有「互斥」没有「N」；`Semaphore`
（`:1948-L1956`）的配额存在 **ConfigMap 或外部 DB**（`SyncDatabaseRef`），不是我们这种「库内行 + 占坑事务」。
也就是说：**我们用一个可事务化的行同时表达了「互斥」和「计数信号量」**，而且免了外部状态。

### 5.3 `blockStrategy` 的「同参重复工作」判定

`apps/admin-api/src/modules/task/block-strategy-gate.ts:1-40`：三种策略（`discard`/`cover_early`/`serial`），
判定键是**规范化后的参数**（`:49-70` `canonicalizeParams`：对象键排序、数组保序、`undefined` 归一），
而不是「同任务」。注释里记录了一次真实事故（「发货程序按订单传参：A 订单在发，B 订单的触发会被覆盖」）。

对照：trigger.dev 需要作者**手工**传 `idempotencyKey` 才有等价能力；argo 的 `synchronization` 是「互斥」不是「去重」。
**自动的、按语义参数的去重判定，我们独有。**

### 5.4 审批单的确定性幂等键 + 单次消费 + 批准/执行两个时刻分列

`apps/admin-api/src/modules/agent/entities/agent-approval.entity.ts:52-61`：`approvalKey` 是
`sha256(toolName + 规范化参数) 前 16 位` 的**确定性**键（注释记录了「原实现用 `Date.now()` ⇒ 23505 分支是死代码」的修复），
唯一约束保证同参重试命中同一张单；`:81` 的 `decidedAt` 与 `:93` 的 `consumedAt` **分列**，
注释明写「批准了但从未执行——正是审计要能看见的那一类」。

对照：windmill 的审批是「签名 resume URL + `Approval` 列表」（`approvals.rs#L94-L113`），
看不到「批了但没执行」这个状态；trigger.dev 的 waitpoint 也没有「决策时刻 vs 消费时刻」的分离。
这一条是我们比所有对照对象都强的审计语义。

### 5.5 预算在会话创建时快照

`apps/admin-api/src/modules/agent/entities/agent-session.entity.ts:76-82`（会话级预算快照的设计注释）+
`:139-141`（`budgetJson: AgentBudget | null`）+ `:83`（`maxSteps`）+ `runtime/agent-budget.service.ts`（174 行，轮次/令牌/墙钟/工具调用数四道闸）。
注释理由：「管理员事后调小全局上限，不应该追溯性地让正在跑的会话突然超限失败」。

对照：5 个 OSS 项目里没有一个做「预算随会话快照」——trigger.dev 的 `maxAttempts` 虽然**锁定**（`lockedRetryConfig`），
但那是重试次数，不是资源预算。**我们的「快照语义」比它们更彻底**（这也正是 G1 建议的方向，可以复用同一套写法）。

### 5.6 机械闸门集合（45 个 `check-*.mjs` + 路由授权矩阵 + 契约向量）

`scripts/check-index-drift.mjs`（63 个命名 `@Index` ↔ 迁移 DDL）、`scripts/check-conditional-writes.mjs`（条件写基线 0）、
`apps/admin-api/scripts/check-route-authz-matrix.mjs`（253 路由 / 33 控制器分级）、
`packages/contract-fixtures/contract.json`（ADR-027 测试替身保真度）、`scripts/generate-executor-protocol.mjs`
（12 schema 双端逐字节一致）。第 3 轮 `docs-truth.md` 已核实其中 10 个判据并实跑。

对照：argo 有 e2e（`workflow/controller/operator_test.go` 数千行）、trigger.dev 有 `knip` 未用导出检查、
windmill 有 `sqlx` 编译期查询校验——但**没有一个是「文档 ↔ 代码 ↔ DB 三方对账」的闸门**。
我们的闸门链是**在「AI 改代码」这个前提下**建的，那正是它们不需要的东西。

---

### 5.7 SOP 是「可机器校验的执行契约」，不是文档

`apps/admin-api/src/modules/sop/entities/sop.entity.ts:9-17` 把 SOP 定义成「文档 + 契约」的合体：
`bodyMarkdown` 给人/LLM，`frontMatterJson` 给平台校验。而 front-matter 的字段是**可判定的**：
`sop-frontmatter.ts:62-63` 的 `capabilities?: SopCapability[]` + `acceptance: SopAcceptanceItem[]`，
`:159` 的 `strict` 发布校验（`acceptance` 必填、未知键拒绝）。头注 `:8-9` 明写它为什么重要：
「SOP 会成为**另一个 Agent 的执行依据**——front-matter 里的 acceptance / capabilities / constraints
就是跨 Agent 指令通道的结构化部分」。

对照：5 个 OSS 项目里没有任何一个把「人的作业规程」做成**带结构化验收项 + 能力声明 + 发布期严格校验**的一等实体
（argo 的 template / windmill 的 flow 都是「可执行代码」，不是「可校验的契约」；
OpenHands 的 manifest 是给 UI 的 `SetupRegistry`，不承载验收语义）。
这一条是我们在「Agent 与人共写同一套规程」这个方向上的**独立设计**，G6 建议的 DAG 边扩展**不应**取代它。

## 6 明确不建议照搬

### 6.1 windmill 的「签名 resume URL」审批面（AGPL + 破坏我们的路由分类体系）

windmill 的审批链接形如 `…/jobs_u/resume/{job_id}/{resume_id}/{secret}?approver=x`
（[`approvals.rs#L119`](https://github.com/windmill-labs/windmill/blob/HEAD/backend/windmill-api/src/approvals.rs#L119) 的正则即为此形态），
**无登录会话**，靠路径里的 secret 做能力凭证。三个理由不适用：

1. **许可**：windmill 是 AGPL-3.0，复制该实现（哪怕「改写成 TS」）在强 copyleft 下风险不可控；
2. **架构冲突**：我们的授权面是 `route-authz-matrix` 的 253 路由分类（`role-gated` 112 / `declared-token` 22 / …），
   一个无鉴权的 capability URL 无法归入任何既有 class，会让该守卫的「每条路由都有明确 class」判据失效；
3. **审计纪律**：`decidedBy` 来自 URL query（`?approver=`）等于**自报身份**，与 ADR-026 的条件写/审计留痕纪律相反。
   我们要的等价能力是「在一处集中处置 + 记 `decidedBy`」，这已经在 G4 里以「校验 `decidedBy`」的形态实现。

### 6.2 argo 的 K8s 原语（ConfigMap semaphore / pod anti-affinity / sidecar 插件）

`SemaphoreRef.ConfigMapKeyRef` / `SyncDatabaseRef`（[`workflow_types.go#L1948-L1956`](https://github.com/argoproj/argo-workflows/blob/HEAD/pkg/apis/workflow/v1alpha1/workflow_types.go#L1948-L1956)）、
`RetryNodeAntiAffinity`、`ExecutorPluginSidecar`——**全部假设有一个 K8s 控制面在替你持有状态**。
我们没有 K8s 控制面：执行器是自注册的 HTTP/pull 进程（ADR-017），调度状态在 PG 行与 BullMQ 里。
照搬会引入「我们不拥有的调度层」，且 `RetryAffinity` 的语义在「执行器 = 任意人的机器」下不等价
（argo 反亲和是「换一台健康节点」，我们的场景可能是「**根本没有第二台**」——所以 G2 必须带回退分支）。

**可以借的只有字段语义**（`on`/`cap`/`excludeAddresses`），实现必须是 PG/内存级。

### 6.3 langgraph 的「图 + 通道 + superstep（BSP）」执行模型

langgraph 的 `pregel` 把一次执行切成 superstep，节点读通道、写通道，检查点落在 superstep 边界。
这套模型与我们的现状**根本冲突**：

1. 我们的 Agent 循环是**台账重放**（`agent_steps` append-only + `rebuildMessages`），
   一次「轮」里可以有多个工具调用、可以中途挂起（`waiting_input`），且每一步都要落审计行；
2. 改成 BSP 会把 `modules/agent/**`（1000+ 行 runtime + 1863 行 spec）整体重写，而它是第 3 轮已登记热区；
3. 我们的条件写纪律（ADR-026）要求**每次状态迁移是一条条件 UPDATE**，通道式状态更新会绕开它。

**只借两个点**：`put_writes` 的「副作用前/后各落一次」与 `get_state_history` 的「按 seq 列出快照」——
这两点用「一张 `agent_session_checkpoints` 表」就能表达（G5 第二步），不需要整套引擎。

### 6.4 trigger.dev 的 run-engine（Postgres `SKIP LOCKED` + 自研 queue + Redis 协调器）

`internal-packages/run-engine` 是「PG 行锁队列 + Redis 协调 + 快照/等待点/批量」的一整套。
我们已经有**两套**异步面：BullMQ（任务执行）与 `event_outbox`（事件派发），
第 3 轮 `db-3+rt-6`（T9）刚刚在为 outbox 的 claim 形状补 partial index。
再引入第三套队列会：① 与 T9 的索引/吞吐结论直接矛盾；② 把「执行在哪排队」变成三个事实源；
③ run-engine 的 OOM 重试、machine preset、checkpoint system 等能力**大部分我们不需要**（我们的执行在用户机器上，不在我们的容器里）。

**只借「attempt 行 + 锁定配置」两个数据形状**（G1），不借运行时。

### 6.5 OpenHands 的 LLM 风险分析器（每次工具调用多一次 LLM 调用）

`src/api/agent-server-adapter.ts:757-768` 的 `LLMSecurityAnalyzer` / `PatternSecurityAnalyzer` / `PolicyRailSecurityAnalyzer` 三选一，
`getConversationConfirmationPolicy()`（`:744-755`）在 LLM 分析器下用 `ConfirmRisky{ threshold:"HIGH", confirm_unknown:true }`。
「按这次调用的内容动态定级」这个**方向**值得借，但 `LLMSecurityAnalyzer` 本身不建议：

1. 我们的工具调用已经是 LLM 驱动的，前面再挂一次 LLM 判风险 ⇒ 延迟翻倍、成本翻倍，且**引入了第二个可被注入的模型**；
2. 我们已有等价且更便宜的两层：静态 `tier`（read/write/dangerous）+ 参数危险模式扫描
   （`agent-boundary.service.ts` 的 `DANGEROUS_PATTERNS` 与 `freeTextFields` 例外）。
   **值得单独借的只有 `confirm_unknown: true` 的 fail-closed 语义**——即「定不出级 ⇒ 当高风险走审批」，
   这一条可以纯规则实现（S 级，可并入 G4）。

---

## 7 与第 3 轮已有 finding 的关系

> 目的：**不重复立项**。下表只保留「同一条问题换个说法」的判定；标「新」的才是真正的新增面。

| 本条 | 与既有 finding 的关系 | 处置建议 |
|---|---|---|
| **G1** attempt 台账 | **新**。与 `rt-1`（`detectLostExecutions` 无异常闸/无重入闸）**不同轴**：那是「扫描器崩」，这是「重试无历史」。与 `db-*` 无关 | 独立立项。落点 `task.service.ts` 与 `db-2+db-10`（T8）同文件 → 串行 |
| **G2** 重试亲和 + 退避上界 | **新**。`runtime-perf.md` 与 `db.md` 均未提亲和性；退避上界也未登记 | 独立立项，但 **`executor.service.ts` 与 SEC-R3-1/2/3（T2）、rt-5 同文件** → warm，排在 T2 之后 |
| **G3** 挂起无超时 | **新**。与 `WEB-4`（T10，审批 UI 只显示 160 字符理由、单击即执行）**是同一条链路的不同环节**：WEB-4 是「看不到依据」，G3 是「永远等下去」。两条的验收命令不同，**不合并**，但建议同一人连续做（同一张表） | 独立立项（S） |
| **G4** 自审批禁止 | **是 `DEP-04` 的同一原则、不同落点**。`tool-registry.ts:92-98` 的 `HARD_DISABLED_REASON` 已用「申请人 ≠ 审批人」这条原则**挡住 Agent 自批**；G4 指出的残留是**人类操作员自批**。属于「同一问题的不同表述」，但修法完全不同（前者删能力、后者查身份） | **合并到 DEP-04 名下作为其扩展**，不新开编号；若 DEP-04 已关闭，则以「DEP-04 残差」立项 |
| **G5** 检查点/分叉 | **新语义面**，但与 `db-4/db-8`（列表读面族：缺索引 + 全表 COUNT + 过度投影）在 `listSteps`/`listToolCalls` 上**重叠**。G5 第一步（加 limit + 列白名单）**就是** db-4/db-8 的同族改动 | 第一步并入「列表读面族」批次；第二步（检查点表）独立立项，且在 `modules/agent/**` 热区解锁后 |
| **G6** DAG 静态边/成功-only | **新**。`FEAT-21` 的 `$upstream` 哨兵是本条现状的一部分（已在仓），不是既有 finding | 独立立项。**注意**：改 `dependencies` 形态会让迁移 `1790000000053` 的 GIN 表达式失效 → 必须与 `db-3+rt-6`（T9）同批评审 |
| **G7** 出口钩子 | **新**。与 `task.service.ts:5846-5875` 的 `kill_retry`（超时处置闭集）相邻但不同面 | 优先用 G6 第 1 步的 `on:["failure"]` 覆盖；真正的执行级钩子再独立立项（M） |
| **G8** 工具扩展点 | **新**。`sdk-dx` 域的 MCP 部分讲的是**出站**（把 ACF 暴露给外部 Agent），本条是**入站** | 独立立项，排最后（唯一扩大安全边界的改动） |
| **G9** trace 树 | **与 `OBS3-07` 是同一问题**：`OBS3-07` 写的是「删 `TraceService` 死代码 + 让 `req.traceId` 有消费者」，G9 写的是「span 不成树 + agent 零 span + 默认关」。同一文件、同一根因 | **合并进 OBS3-07**，把它的范围从「清理死代码」扩为「让 trace 可查询」，一次做完 |
| **G10** 幂等键 | **与 `SEC-R3-4` 是同一问题的入口/出口两侧**：`SEC-R3-4` 是「入站 webhook 重放无幂等键」，G10 是「出站触发无幂等键」。`security.md` 自己也写了「要先定幂等键形态（`SETNX` 还是唯一列）」——**同一个契约决策** | **合并为一个「幂等键契约」立项**：先定形态（推荐 partial unique 列），再同时落 webhook 与触发两个面 |

**没有关系（避免被误合并）**：

- `rt-4+OBS3-03+rt-8`（SSE 扇出/容量分母）与 G9 **无关**：那是「取数成本」，这是「因果可见性」。
- `db-1`（迁移安全面）与 G1/G3/G4/G10 的**新迁移**有关，但那是纪律（CONCURRENTLY + timeout 豁免），不是同一 finding。
- `EXEC-01..07`（执行器协议）与 G2 有关（派发载荷要带 `avoidExecutorAddress`），属「同一 PR 的两个边」，需协调但不同条。

---

## 8 建议实施顺序

排序规则（沿用 INDEX §3）：**先做「一改就有反馈、且不扩大安全边界」的 → 同档按成本升序 → 热区/同文件串行**。

| 序 | id | 量 | 冲突 | 为什么排这里 |
|---:|---|---|---|---|
| 1 | **G10** 幂等键 | S | warm（`migrations/**`） | 成本最低、收益最直接（防重复执行的**真实副作用**）；且与 `SEC-R3-4` 共用一次契约决策，先定形态能省一轮设计 |
| 2 | **G3** 挂起超时 | S | cold-偏 warm（`agent_approvals` 与 G4 共表） | 与 G4 共用一次迁移；「永久挂起」是当前最容易被运营问到的一条 |
| 3 | **G4** 自审批禁止 | S/M | 同上 | 与 G3 同一迁移窗口（`agent_sessions.createdBy` + `agent_approvals.expiresAt` 一次做完）；是安全红线的残留 |
| 4 | **G2** 重试亲和 + 退避上界 | S/M | **warm**（`executor.service.ts`，与 T2/rt-5 同文件） | 排 T2 之后；一条 `Math.min` + 一个可选尾参 + 一列，收益是「重试不再回到坏机器」 |
| 5 | **G9/OBS3-07** trace 可查询 | M | warm（`modules/agent/**` + `common/tracing/**`） | 排在这里是因为**它是 G1/G5/G8 的诊断前提**：没有 trace，后续三条的验收只能靠日志猜 |
| 6 | **G1** attempt 台账 + 锁定策略 | M | warm（`task.service.ts`，与 T8 同文件） | 依赖第 4 条的「重试路径已经收口」，否则台账会记录两套预算的混合结果 |
| 7 | **G7** 出口钩子（若 G6-1 未先做） | M | warm（`execution-terminal.ts` = T5 落点） | 与 T5（rt-3+rt-7 日志投影）串行；也可被 G6-1 的 `on:["failure"]` 吸收 |
| 8 | **G5** 检查点（第一步并入列表读面族） | M | **hot**（`modules/agent/**`） | 第一步并进 `db-4/db-8` 批次；第二步等 agent 热区解锁 |
| 9 | **G6** DAG 边语义（S→M→L 三步） | L | hot（`migrations/**` + `task.service.ts` + GIN 索引） | 第 1 步（`on` 语义）可以提前到第 5 位之后单独做；第 2/3 步必须与 db 侧同批，否则会悄悄回退 B-3 的索引优化 |
| 10 | **G8** 工具扩展点 | L | cold（`tool-registry.ts` + 新表） | 唯一扩大安全边界的改动，必须在 G9 可观测性到位、且 G4 的审批身份校验落地之后 |

**三个跨条目的前置约束（写在这里避免实施时踩）**：

1. **迁移取号**：G1/G3/G4/G10 各需新迁移，当前最大编号为 `1790000000073`，下一个是 `1790000000074`。
   按第 3 轮 INDEX §6 的纪律，`migrations/**` 是 hot 区，**动手前先取号并与该 agent 串行**；
   G3 与 G4 建议合并成一条迁移，G10 一条，G1 两条（快照列 + attempt 表）。
2. **同文件串行**（同一人做，不要并行）：`executor.service.ts`（T2 → G2）、`task.service.ts`（T5 → T8 → G1 → G6-2）、
   `agent/**`（G3/G4 → G9 → G5）、`execution-terminal.ts`（T5 → G7）。
3. **验收必须带反证**（本仓既有纪律）：每条都写了「还原修复后什么东西必须转红」的形态，实施时不要只写「正向通过」的用例。

---

## 附：本文件的取证清单（便于复核）

| 主张 | 取证命令 |
|---|---|
| OSS 侧 39 处引用（argo 14 / trigger.dev 13 / windmill 6 / langgraph 5 / OpenHands 3） | `sed -n '<range>p' <path>` 于 `/home/yongsheng/project/.acf-oss-ref/<repo>`，行号与引文逐字一致 |
| 我们侧行号 | `grep -n` / `sed -n` 于工作区；`codegraph status` 确认索引 1,986 文件 / 38,329 节点 up to date |
| `agent_approvals` 无超时列 | `sed -n '21,34p' apps/admin-api/src/migrations/1790000000067-CreateAgentApprovals.ts` + `ls migrations | grep -i approval`（只有 0067/0068，0068 只加 `consumedAt`） |
| `agent_sessions` 无 creator | `grep -n "createdBy\|userId\|requester" .../entities/agent-session.entity.ts` → 零命中 |
| agent 侧零 span | `grep -rn startSpan apps/admin-api/src/modules/agent | wc -l` → `0` |
| 扇出仅 SUCCESS | `sed -n '5890,5895p'` 与 `sed -n '5747,5760p'` `apps/admin-api/src/modules/task/task.service.ts` |
| 触发面无幂等键 | `sed -n '1,28p' apps/admin-api/src/modules/task/dto/trigger-task.dto.ts` → 仅 `params` + `version` |
| 工具集是静态数组 | `grep -n "AGENT_TOOL_SPECS" apps/admin-api/src/modules/agent/tools/tool-registry.ts`（`:127` 定义）+ `grep -rn "mcp" apps/admin-api/src -il`（无 MCP client） |
