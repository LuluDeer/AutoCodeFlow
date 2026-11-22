# R296 审批 granted 丢失唤醒竞态：专项修复方案（设计调研 R321）

> **受众**：主 agent / 实施 agent / 真实进程内集成验收方。
> **状态**：草稿 · **最后核对**：2026-11-21
> 本文只做 R296 的方案穷举、反证与实施设计（不改任何业务代码），产出一份任何一轮都能直接照做的决策文档；不覆盖前序轮次已落地的 R300 缓解代码本身的重写。文中每个「文件:行」均经 CodeGraph 1.6.2 逐字核实，核对清单见 [§1.5](#15-codegraph-逐字核对清单)。

---

## 0. 决策摘要

| 项 | 结论 |
|---|---|
| 推荐方案 | **E：markWaiting 成功后回读 granted + 窄 queue 端口补偿入队**（复用既有 `attachEventSink` 反向注册形态，新增一个拥有 queue 的独立 provider） |
| 核心不变式 | resume 入队的判定点从「grant 时的 session 快照」后移到「markWaiting 提交后」，因为只有后者才是状态稳定的时刻 |
| 幂等与防双跑 | `manualResumeDeduplicationId`（`resume-{sessionId}-{totalSteps}`）+ `expectTotalSteps`/`expectWaitingFor` 凭据 + `markRunning` CAS 三层；dedup 是优化，CAS 才是真正的双跑闸门 |
| 关键反证发现 | ① 单纯放宽 grant 端（A）会被 worker 的空转 skip 吃掉；② dedup 的 `id` 若与一个「已 active 但注定 skip」的 job 撞上，会**反向吞掉**补偿 job（[§3.2](#32-e-方案-dedup-幂等深审)）；③ D 复用的 sweep 目前**没有生产调用者**且阈值是 30 天 |
| 验收级别 | 真实进程内集成（真 Nest + 真 PG/Redis），用「gate 住 markWaiting」精确制造竞态窗口，断言自动 resume 副作用 |
| 需主 agent 裁决 | 见 [§7](#7-需主-agent-裁决的点)（共 5 点，含 README 挂链） |

---

## 1. 问题与证据

### 1.1 竞态时序图

```text
 管理员/HTTP                  requestApproval (tool-executor)            worker run()/队列
     |                                |                                       |
     |                    ① approvals.request() 落 pending                    |
     |                       tool-executor.service.ts:1318                     |
     |                                |                                       | session.status = running
     |     grant() 到达 ------------>|                                       |
     |     decideApproval :578        |                                       |
     |     读快照 :584 = running      |                                       |
     |     granted 分支 :644-651 判 false ⇒ 不 enqueueResume                   |
     |<---- 200 {resumed:false}       |                                       |
     |                    ② persistAwaiting() :1330                           |
     |                    ③ markWaiting() :1331 ⇒ waiting_input                |
     |                                |                                       |
     |              ✗ 此刻 approval=granted 但没有任何 job 会来消费             |
     |              ✗ 会话永久卡在 waiting_input（需人工手动 resume）           |
```

### 1.2 逐字证据表

| 事实 | 位置（文件:行，符号名） | 逐字要点 |
|---|---|---|
| 落单→挂起三步顺序 | `apps/admin-api/src/modules/agent/tools/tool-executor.service.ts:1318`（`requestApproval`） | `await this.approvals.request({...})` → `:1330 await persistAwaiting()` → `:1331 await this.sessions.markWaiting(session.id, ...)` |
| grant 读快照 | `apps/admin-api/src/modules/agent/agent.controller.ts:584`（`decideApproval`） | `const session = await this.sessions.requireById(sessionId)` |
| granted 分支判定 | `apps/admin-api/src/modules/agent/agent.controller.ts:644-651`（`decideApproval`） | `decision === "granted" && session.status === "waiting_input" && !(await this.approvals.hasPendingForSession(sessionId))` ⇒ `enqueueResume(...)` |
| 入队实现 | `apps/admin-api/src/modules/agent/agent.controller.ts:546`（`enqueueResume`） | `queue.add("run", {sessionId, reason, expectTotalSteps}, manualResumeJobOptions(...))` |
| queue 来源 | `apps/admin-api/src/modules/agent/agent.controller.ts:158`（constructor） | `@InjectQueue(AGENT_QUEUE_NAME) private readonly queue: Queue<AgentJobData>` |
| dedup id / job options | `apps/admin-api/src/modules/agent/runtime/agent-job-options.ts:33`（`manualResumeDeduplicationId`）, `:40`（`manualResumeJobOptions`） | `resume-${sessionId}-${totalSteps}`；`attempts:1`、`removeOnComplete:true`、`deduplication:{id,...}`、`reopenedFailure` 时才 `keepLastIfActive:true` |
| 唤醒凭据类型 | `apps/admin-api/src/modules/agent/runtime/agent-job-options.ts:59`（`RunOptions`） | `expectWaitingFor?: string; expectTotalSteps?: number` |
| run() 早消费 skip | `apps/admin-api/src/modules/agent/runtime/agent-runtime.service.ts:505`、`:516`（`run`） | `status === "running"` 直接 return `{status, steps}`，不重排 |
| markRunning CAS | `apps/admin-api/src/modules/agent/runtime/agent-session.service.ts:790`、`:811-821`（`markRunning`） | `status <> 'running' AND status NOT IN (terminal)` + 可选 `waitingFor IS NOT DISTINCT FROM :expect` + `totalSteps = :steps` |
| worker 并发 | `apps/admin-api/src/modules/agent/runtime/agent.processor.ts:27`（`AGENT_QUEUE_CONCURRENCY`） | `= 2`，`@Processor(..., { concurrency: 2 })` 在 `:42` |
| 会话服务无 queue | `apps/admin-api/src/modules/agent/runtime/agent-session.service.ts:509`（constructor）, `apps/admin-api/src/modules/agent/agent.module.ts:123` | `approvals` 是 `@Optional()` 依赖；注释明写「session service 刻意不依赖队列」，唯一注入 queue 的会话侧服务是 `AgentBacklogAutoReenqueueService`（`agent.module.ts:128`） |
| 反向注册先例 | `apps/admin-api/src/modules/agent/runtime/agent-session.service.ts:529`, `apps/admin-api/src/modules/agent/runtime/agent-approvals.service.ts:264`（`attachEventSink`） | 拥有能力的一侧把**最窄端口**注册给消费侧，避免成环 |
| 领域事件 + listener | `apps/admin-api/src/common/services/domain-event.module.ts:17`（`@Global`）, `apps/admin-api/src/modules/agent/runtime/funnel-success.listener.ts:33`（`FunnelSuccessListener`） | 终态走领域事件 + `onModuleInit` 订阅；bus 全进程 fail-open |
| 终态集合 | `apps/admin-api/src/modules/agent/entities/agent-session.entity.ts:110`（`AGENT_TERMINAL_STATUSES`） | `succeeded / failed / aborted / budget_exceeded` |

### 1.3 R300 已缓解的后果与仍存在的问题

- R300 在 `apps/admin-api/src/modules/agent/runtime/agent-approvals.service.ts:767`（`hasPendingOrGrantedForSession`）新增了 `status In(["pending","granted"])` 判据，并被 `apps/admin-api/src/modules/agent/runtime/agent-session.service.ts:2116`（`sweepAbandonedWaitingInput`）在 `:2113-2119` 用来跳过审批等待会话。
- **已缓解**：卡死的会话不再被等待输入超时扫描误收敛成 `failed`（否则用户已批准的会话会被误杀，granted 单成孤儿）。
- **仍未解决**：会话依旧卡在 `waiting_input`，granted 单无人 consume；R300 只是「不再二次伤害」，没有恢复执行。
- **额外发现（红队）**：`sweepAbandonedWaitingInput` 全仓库**没有生产调用者**——只有单测调用（`apps/admin-api/src/modules/agent/runtime/__tests__/agent-session.service.spec.ts:1164` 等）；且阈值 `STALE_WAITING_INPUT_TIMEOUT_MS` 是 30 天（`agent-session.service.ts:103`）。所以「靠 sweep 补偿」在任何合理时间尺度上都不成立（详见 [§2.4](#24-d-sweep-轮询补偿)）。

### 1.4 现有复现测试与当前断言

- 位置：`apps/admin-api/src/modules/agent/__tests__/agent-approvals.spec.ts:307`，用例名 `R296 竞态：落单后 grant（session 仍 running）再 markWaiting ⇒ 不得丢失唤醒`。
- 机制：可变 session 替身 `liveSession`（`:309-313`），`grantApproval` 在 `status="running"` 时调用（`:340`），随后 `:348` 手动 `liveSession.status = "waiting_input"`，全程无 tool-executor、无 DB。
- 当前断言（`:355-358`）：
  `expect({ resumedAtGrant: out.resumed, queueCalls: enqueue.mock.calls.length }).toEqual({ resumedAtGrant: false, queueCalls: 0 })`。
- 用例注释（`:353-354`）声明「修复后翻转为 `resumed=true` 且有 1 次入队」——**该期望与 E 方案不一致**：E 在竞态窗口内 grant 端本就**不**入队（这才是避免早消费的正确行为），翻转后的断言应检查「markWaiting 之后补偿入队 1 次 + 会话最终自动 resume」。此分歧列入 [§7](#7-需主-agent-裁决的点)。

### 1.5 CodeGraph 逐字核对清单

```bash
export PATH="/home/zou/.codegraph/versions/v1.6.2/bin:$PATH"
cd /data/project/AutoCodeFlow
codegraph status   # 开工时显示 Pending Changes: 12 added / 14 modified（其它 agent 的并行改动）；索引可查，所引行号均已逐字核对
codegraph node -f apps/admin-api/src/modules/agent/tools/tool-executor.service.ts --offset 1318 --limit 14
codegraph node -f apps/admin-api/src/modules/agent/agent.controller.ts --offset 578 --limit 85
codegraph node -f apps/admin-api/src/modules/agent/runtime/agent-job-options.ts --offset 33 --limit 25
codegraph node -f apps/admin-api/src/modules/agent/runtime/agent-session.service.ts --offset 1038 --limit 15
codegraph node -f apps/admin-api/src/modules/agent/runtime/agent-approvals.service.ts --offset 767 --limit 8
codegraph node -f apps/admin-api/src/modules/agent/runtime/agent-runtime.service.ts --offset 505 --limit 16
codegraph node -f apps/admin-api/src/modules/agent/runtime/agent.processor.ts --offset 20 --limit 8
```

---

## 2. 方案穷举

### 2.1 A：decideApproval 放宽到 running 就入队

- **机制**：把 `:646` 的 `session.status === "waiting_input"` 放宽为 `["running","waiting_input"].includes(...)`，带上凭据入队。
- **正确性论证**：grant 时若能看到 running 就入队，理论上覆盖了竞态窗口。
- **否决理由**：
  - worker-2 并发（`agent.processor.ts:27`）下 grant 端 job 与 markWaiting 后的其它 job 可同时存在；
  - **早消费**：grant 端 job 若被 worker 立刻取走，`run()` 在 `:516` 见 `running` 直接 skip，job 被 `removeOnComplete` 删除，dedup 键释放——会话随后 markWaiting 挂起，仍然无人恢复（[§3.1](#31-反例矩阵) A-1）；
  - **晚消费双跑**：若两个部分重叠的 job 都活到 markRunning，CAS 只能挡住一个进入推理循环，但两次 `queue.add` + 一次空转是真实资源浪费，且日志会误报「重复 resume」。
- **结论**：否决。除非同时改造 `run()` 的 skip 分支（把 running 变成「重排」），而那是热路径，风险外溢。

### 2.2 B：grant 时主动 markWaiting + 入队

- **机制**：decideApproval 在 granted 分支自己调 `markWaiting` 再入队，不依赖 tool-executor 的第三步。
- **正确性论证**：把「挂起」与「批准」合并到 grant 侧，消除窗口。
- **否决理由**：
  - **CAS 双跑**：tool-executor 的 `markWaiting`（`tool-executor.service.ts:1331`）与 grant 侧的 `markWaiting` 都写状态；两者都是 `Not(In(terminal))` 条件写（`agent-session.service.ts:1043-1046`），无 `expectTotalSteps` 凭据，谁后写谁覆盖 `waitingFor`；
  - **覆盖 running**：grant 在①之后③之前发生时，tool-executor 正处在本轮工具调用的执行中，grant 侧把会话翻成 waiting_input，worker 继续跑会写 step、可能覆盖状态或在 `run()` 循环里再次调用需要审批的工具，产生「状态说等审批、实际还在跑」（B-8 双跑守卫的翻版）；
  - `markWaiting` 返回 `void`（`:1038`），grant 侧拿不到「我赢了吗」，无法安全决定是否入队。
- **结论**：否决。

### 2.3 C：tool-executor 内穿透执行

- **机制**：`requestApproval` 在落单后不挂起，而是轮询/阻塞等待审批结果，拿到 granted 后在本进程直接执行被批工具。
- **正确性论证**：没有跨请求状态机，自然没有丢失唤醒。
- **否决理由**：
  - **boundary.check 语义**：审批闸门是纯函数判定（`tool-executor.service.ts:387-395` 的注释明确「纯函数、不读库」），让热路径同步等库/等人会把它变成有副作用的阻塞门；
  - **热路径**：审批可等数天（TTL 7 天，`agent-session.service.ts:2146`），worker 并发=2，一个挂起的请求会永久占用一个 worker 槽；
  - 与 R300 的「落单后立刻可处置」契约、fail-open 通知路径（`:1338`）全部冲突。
- **结论**：否决。

### 2.4 D：sweep 轮询补偿

- **机制**：新增一个短周期扫描，找 `waiting_input + waitingFor 以"等待审批"开头 + 有 granted 未 consume` 的会话，入队 resume。
- **正确性论证**：无论竞态窗口多小，最终一致性收敛。
- **否决理由 / 延迟上限**：
  - 复用现成的 `sweepAbandonedWaitingInput`（`agent-session.service.ts:2105`）**不成立**：它没有生产调用者（仅在单测被调用），阈值是 30 天（`:103`），即使接上 cron 也是「30 天后才补偿」；
  - 对齐 `AgentBacklogAutoReenqueueService` 的同款 cron（`agent-backlog-auto-reenqueue.service.ts:96`，`0 5,15,25,35,45,55 * * * *`，每 10 分钟）**仍要新建 provider + leader gate + 判据**，不是「复用」；
  - 10 分钟延迟对「用户正在等结果」的交互式审批不可接受；且加了 cron 后与 E 并存会形成双写来源。
- **结论**：否决为主修复；可作为 E 失败时的兜底（列入 [§6.2](#62-fail-closed-设计)），但需主 agent 裁决是否引入第二套补偿源。

### 2.5 E：markWaiting 后回读 granted + 窄 queue 端口补偿入队（推荐）

- **机制**：把入队判定点从 grant 快照后移到 markWaiting 提交之后。markWaiting 一旦成功写库，会话状态稳定为 `waiting_input`；此时回读审批单，若存在 `granted`（`scope='once'`、未 consume）且无其它 pending，则通过一个**只暴露 `enqueueIfGranted` 的窄端口**入队（端口实现拥有 queue，会话服务仍不依赖 queue）。
- **正确性论证**：
  - 竞态窗口内 grant（读 running，不入队）→ markWaiting 提交 → 补偿回读到 granted → 入队 → job 执行时会话已是 waiting_input → `markRunning` CAS 命中 → 重放 consume → 会话恢复。**覆盖了 A 的全部失败格**；
  - grant 发生在 markWaiting 之后 → 现有 decideApproval 分支（`:644-651`）照常入队；此时补偿回读要么发生在 grant 之前（读不到 granted，不入队）、要么撞上同一 dedup id（幂等）；
  - 两种时机的并集覆盖全部交错，不存在「两边都以为对方会处理」的空隙。
- **采纳理由**：改动面最小（一个新 provider + 一个 markWaiting 尾钩 + 一个新 approvals 查询），不碰 `run()` 热路径、不改 boundary 语义、不引入 cron；沿用仓库既有的 `attachEventSink` 反向注册形态，架构一致。
- **实施形态**（细节见 [§4](#4-推荐方案--精确实施步骤)）：
  - 新增 `AgentApprovalWakeupService`（独立 provider，拥有 `@InjectQueue`），暴露 `probe(sessionId)`；
  - `AgentSessionService.markWaiting` 成功写库后调用已注册的 `approvalWakeupProbe`（失败只 warn，fail-open）；
  - `AgentApprovalsService` 新增 `hasGrantAwaitingResumeForSession(sessionId)`（`scope='once'` + `status='granted'`）。

### 2.6 F：approval.request + markWaiting 事务原子化（第 6 方案）

- **机制**：用共享 `QueryRunner`/`EntityManager` 把 `approvals.request()` + `persistAwaiting()` + `markWaiting()` 包进一个事务；审批单在提交前对外不可见（READ COMMITTED），管理员只可能在提交后看到 pending，而那时会话已是 waiting_input，grant 侧快照必然正确。
- **正确性论证**：从结构上消灭窗口，不依赖任何补偿或时序假设；是正确的「治本」形态。
- **否决理由**：
  - `AgentApprovalsService.request`（`:432` 附近的 `decide` 同款风格）与 `AgentSessionService.markWaiting`（`:1043` 用 `this.sessions.update`）各用自有 Repository；要共享事务需要给两个服务加 `EntityManager` 注入重载或新增 `withTransaction` 编排层，爆炸半径大；
  - `notify.approvalRequested`（`:1338`）是外部副作用，无法进事务；
  - 管理员在事务未提交期间按审批键 grant 会收到 404（单不可见），是 UX 回退；
  - 与「会话服务刻意不依赖队列」平行的「服务不共享事务上下文」是当前分层假设，打破它要主 agent 级架构裁决。
- **结论**：作为「E 的长期结构性替代」记录，本轮不采纳；若 E 的 e2e 暴露补偿路径仍有不可覆盖的交错，再升级到 F。

---

## 3. 反证式审查

### 3.1 反例矩阵

| 方案 | 构造的反例 | 失败形态 | 判定 |
|---|---|---|---|
| A | grant job 在 markWaiting 前被 worker 取走 | `run()` `:516` skip → job 删除 → 会话卡死（A-1） | 双跑/丢失 |
| A | 两个 worker 各持一个 grant job，均活到 markWaiting | 两次 `queue.add`，一次空转；CAS 只挡住一个进循环 | 双跑 |
| B | grant 与 tool-executor 都写 markWaiting，无凭据 | 后写覆盖 `waitingFor`；worker 仍在本轮执行 → 状态与行为背离 | 竞态 |
| C | 管理员 3 天后才批准 | worker 槽被占 3 天，并发=2 直接耗尽 | 资源耗尽 |
| D | 接上 cron 但阈值仍是 30 天 | 用户等 30 天才恢复 | 延迟 |
| E | grant 发生在 markWaiting 与补偿回读之间 | 现有分支入队 + 补偿也入队 → **靠 dedup 幂等**（[§3.2](#32-e-方案-dedup-幂等深审)） | 需验证 |
| E | 补偿 job 在 markRunning 前会话已被人工 resume | `expectWaitingFor`/`expectTotalSteps` 凭据 + CAS 拒绝 → 让位 | 需验证 |
| F | 事务未提交时管理员按审批键 grant | `findByKey` 返回 null → 404 | UX 回退 |

### 3.2 E 方案 dedup 幂等深审

`manualResumeDeduplicationId(sessionId, totalSteps)`（`agent-job-options.ts:33`）返回 `resume-{sessionId}-{totalSteps}`；`persistAwaiting()`（`tool-executor.service.ts:1330`）只写 `agent_tool_calls` 台账行、`markWaiting`（`:1038`）只改 session 状态，**两者都不改 `totalSteps`**，所以竞态窗口内该 id 稳定。

1. **正常幂等**：补偿 job J2 与 decideApproval 的 J1 携带相同 `resume-{sessionId}-{totalSteps}` → BullMQ 对同 dedup id 的重复 `add` 是 no-op（6.7.2 的 `deduplication.id` 语义）。单测层面 `agent-resume-bullmq.spec.ts:71` 已验证旧 jobId 的稳定性形态。
2. **红队反例（关键）**：若 J1 已被 worker 取走并处于 `active`，但随后在 `run():516` 因 `running` skip——在 J1 真正 complete（释放 dedup 键）之前，J2 的 `add` 会因撞同 dedup id 被**吞掉**。结果 J1 空转完成、J2 被吞，会话照样卡死。这说明 **dedup 不是充分条件**。
3. **缓解**：
   - E-pure 推荐形态下，竞态窗口内 grant 端**不**入队（只有补偿一个来源），该反例只在「E+ 双侧触发」或「历史残留同名 job」时出现；
   - 补偿入队显式带 `expectWaitingFor = waitingFor`（markWaiting 写入的那个 `等待审批 ${approvalKey}`）与 `expectTotalSteps`；
   - 若主 agent 选择 E+（grant 端也入队），补偿 job 必须换**独立 dedup 命名空间**（如 `resume-wakeup-{sessionId}-{totalSteps}`）或设 `keepLastIfActive: true`，否则会踩中第 2 点。两个命名空间的 job 若同时存活，**由 `markRunning` CAS 保证只有一个进循环**（见 §3.3），dedup 仅作优化。

### 3.3 凭据是否防早消费

- `RunOptions.expectWaitingFor` / `expectTotalSteps`（`agent-job-options.ts:59`）在 `markRunning` 里以 `waitingFor IS NOT DISTINCT FROM :expect` 与 `totalSteps = :steps` 进 SQL 谓词（`agent-session.service.ts:818-821`）。
- 补偿 job 生成于 markWaiting **之后**，此时 waitingFor 已是 `等待审批 {approvalKey}`、totalSteps 与快照一致 ⇒ CAS 命中。
- 反例：补偿 job 延迟执行，期间会话被人工 resume（`waitingFor` 被清成 null）或被另一个审批改挂 ⇒ CAS 命中 0 行 ⇒ `run()` 返回让位（`:530-539`），不会把审批门翻成 running。
- 反例：补偿 job 跑在 grant 的单据被 **consume** 之后（例如重放已由别的 job 完成）⇒ 补偿回读 `granted` 为空 ⇒ 不入队；即使已入队，凭据仍匹配但 markRunning 因状态已不是 waiting_input 而失败。
- **结论**：凭据 + CAS 对「早消费/晚消费/人工介入」三类反例均成立；dedup 只负责减少重复 job，不承担正确性。

### 3.4 多副本 / worker-2 并发

- 补偿触发点在每个副本的 `markWaiting` 尾部，只有**执行该会话 worker** 的那一个副本会走到（会话归属单一 worker）；不存在多副本各补偿一次。
- 即便两个补偿 job 因 E+ 或人工 resume 交错并存，`AGENT_QUEUE_CONCURRENCY=2` 下只能有两个消费者，`markRunning` CAS（`agent.processor.ts:42` + `agent-session.service.ts:811`）只允许一个赢家；输家在 `run():530` 让位。
- 与 backlog 自动补偿（`agent-backlog-auto-reenqueue.service.ts:96` 的 cron）的交叠：backlog 判据针对 `pending` 积压，不看 granted，且 `waiting_input` 会话不计入积压，无交集。

### 3.5 数据丢失 / 重复副作用

- **丢失**：补偿回读必须在 markWaiting 的 UPDATE **提交之后**（TypeORM `update` 自动提交，Promise resolve 即已提交）；若放在之前，读到的还是 running，等于没补偿。
- **重复执行审批工具**：`consume`（`agent-approvals.service.ts:803`）是 `status='granted' → 'consumed'` 条件写，且策略指纹进谓词（`:788-796`）；一次点头只放行一次，补偿入队本身不会重复执行副作用。
- **fail-open 边界**：补偿端口抛错绝不冒泡到 `requestApproval`（否则审批申请本身失败）；与 DomainEventBus 的 fail-open 契约（`domain-event-bus.service.ts:8-11`）同款。

---

## 4. 推荐方案 + 精确实施步骤

### 4.1 文件级改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `apps/admin-api/src/modules/agent/runtime/agent-approvals.service.ts` | 新增 `hasGrantAwaitingResumeForSession(sessionId): Promise<boolean>`：`find({ where: { sessionId, scope:"once", status:"granted" }, take:1 })`，复用 `listForSession:411` 的 scope 过滤纪律（不能把 `scope='session'` 的派生授权算进来） |
| 2 | `agent-approval-wakeup.service.ts`（新建于 `apps/admin-api/src/modules/agent/runtime/` 目录，`<NEW>` 占位） | 新增 `AgentApprovalWakeupService`：注入 `@InjectQueue(AGENT_QUEUE_NAME)` 的 queue + `AgentApprovalsService` + `AgentSessionService`；暴露 `probe(sessionId)`：回读 session，条件 `status==="waiting_input" && waitingFor?.startsWith("等待审批") && !hasPendingForSession && hasGrantAwaitingResumeForSession` ⇒ `queue.add("run", {sessionId, reason:"resume:approval", expectTotalSteps, expectWaitingFor: waitingFor}, manualResumeJobOptions(sessionId, totalSteps, false))`；全程 try/catch 只 warn |
| 3 | `apps/admin-api/src/modules/agent/runtime/agent-session.service.ts` | 增加字段 `approvalWakeupProbe: ((sessionId:string)=>Promise<void>) \| null` + `attachApprovalWakeupProbe(probe)` 方法；在 `markWaiting`（`:1038`）的 `update` 命中后（`:1047` 的 else 分支）`await this.approvalWakeupProbe?.(id)`，try/catch 只 warn |
| 4 | `apps/admin-api/src/modules/agent/agent.module.ts` | 在 providers（`:120-166`）加入 `AgentApprovalWakeupService`；`AgentApprovalWakeupService` 的 `onModuleInit` 调 `sessions.attachApprovalWakeupProbe(this.probe.bind(this))`（与 `AgentSessionService` 构造器 `:529` 的反向注册同款，避免在 session 构造器里 new 依赖） |
| 5 | `apps/admin-api/src/modules/agent/__tests__/agent-approvals.spec.ts` | 改写 R296 用例（`:307`）：翻转断言为「markWaiting 之后 probe 触发 1 次入队」；新增「probe 幂等」用例；新增「非等待审批的 waiting_input 不入队」用例 |
| 6 | `agent-approval-wakeup.service.spec.ts`（新建于 `apps/admin-api/src/modules/agent/runtime/__tests__/` 目录） | 内存替身测 probe 的四条判定分支 + queue.add 参数（dedup id / 凭据） |

### 4.2 接线点

```text
 AgentSessionService.markWaiting (UPDATE 提交后)
        │ await approvalWakeupProbe?.(id)      ← 反向注册（端口）
        ▼
 AgentApprovalWakeupService.probe
        ├─ sessions.requireById → status/waitingFor/totalSteps
        ├─ approvals.hasPendingForSession  (:752)  ⇒ 有 pending 则让位
        ├─ approvals.hasGrantAwaitingResumeForSession (新) ⇒ 无 granted 则让位
        └─ queue.add("run", {expectTotalSteps, expectWaitingFor: waitingFor}, manualResumeJobOptions(...))
```

### 4.3 顺序与验证命令

1. **改动 1**（approvals 查询）。验证：`export PATH="/home/zou/.codegraph/versions/v1.6.2/bin:$PATH"; codegraph node -f apps/admin-api/src/modules/agent/runtime/agent-approvals.service.ts --offset 767 --limit 12` 确认与 `hasPendingOrGrantedForSession` 并列、语义不重叠。
2. **改动 2**（新 provider）。验证：`npx jest apps/admin-api/src/modules/agent/runtime/__tests__/agent-approval-wakeup.service.spec.ts --runInBand`（改动 6 落地后）。
3. **改动 3**（markWaiting 尾钩）。验证：`codegraph impact AgentSessionService.markWaiting -d 1` 确认所有调用方（tool-executor 只是其中之一）都是「挂起后无其它动作」，尾钩不会打断它们。
4. **改动 4**（module 接线）。验证：`npx jest apps/admin-api/src/modules/agent/__tests__/agent.controller.spec.ts --runInBand` + `npm run build --workspace=apps/admin-api`（Nest DI 解析成功，无循环依赖）。
5. **改动 5/6**（测试改写 + 新测）。验证：`npx jest apps/admin-api/src/modules/agent/__tests__/agent-approvals.spec.ts --runInBand` 全绿；旧断言（`:358`）已被新断言替换。
6. **文档守卫**：`node scripts/docs/check-docs.mjs --only=links` 与 `node scripts/docs/check-doc-style.mjs` 应 exit 0；孤儿项见 [§6.3](#63-文档守卫与-orphan)。

### 4.4 R296 单测的改写示例

```ts
// 在 :348 liveSession.status = "waiting_input" 之后，显式触发补偿端口（模拟 markWaiting 尾钩）
await wakeup.probe("s-race");
expect(enqueue).toHaveBeenCalledTimes(1);
const [, data, opts] = enqueue.mock.calls[0] as [string, any, any];
expect(data).toMatchObject({
  reason: "resume:approval",
  expectTotalSteps: 3,
  expectWaitingFor: "等待审批 apr-s-1-1700000000000",
});
expect(opts.deduplication.id).toBe("resume-s-race-3");
// 幂等：重复 probe 不再增加 job（BullMQ dedup 语义在此由 mock 模拟）
await wakeup.probe("s-race");
expect(enqueue).toHaveBeenCalledTimes(1);
```

---

## 5. 验收级别要求

### 5.1 分级判定

| 级别 | 本任务状态 | 能证明什么 |
|---|---|---|
| 静态探查 | 已完成（本文全部 file:line 经 CodeGraph 核实） | 代码看起来是这样 |
| 单测/内存替身 | 实施步骤 5/6 完成 | 分支逻辑成立、dedup 参数正确 |
| **真实进程内集成** | **必须达到（发布前置）** | 持久化、CAS、队列 job 状态与自动 resume 副作用真的发生 |
| 浏览器/真机 | 不要求 | — |

**对外汇报只引用「真实进程内集成」结果**；单测通过不等于 R296 修复。

### 5.2 真实进程内集成 e2e 设计

- **载体**：新建 `agent-approval-lost-wakeup.e2e-spec.ts`（位于 `apps/admin-api/test/` 目录），复用 `createTestApp()` / `loginAsAdmin()`（`apps/admin-api/test/helpers/app.helper.ts`），守卫 `DB_DATABASE` 必须是 test/e2e 库（照抄 `apps/admin-api/test/agent-approval-journey.e2e-spec.ts:22-26`）。只有 `AiService.chatMultimodal` 的答案是脚本化的（同文件 `:118-120`），真 PG / 真 Redis / 真 Nest / 真 BullMQ worker。
- **如何精确制造竞态窗口（核心）**：
  1. 在启动 agent run **之前**，`jest.spyOn(app.get(AgentSessionService), "markWaiting")`，包装成「先 `await gate`（一个可手动 resolve 的 Deferred），再调原方法」。此刻 worker 会走到 `requestApproval` 的 `:1331`，被 gate 卡在 markWaiting 门口；`:1318` 的 pending 单已经落库、session 仍是 running。
  2. 轮询 PG 的 `agent_approvals` 表拿到该会话 `status='pending'` 的审批键。
  3. 用第二个管理员调用 `POST /agent/approvals/:key/grant`（真 HTTP）；断言返回 `{resumed:false}`——证明 grant 确实读到了 running 快照，竞态窗口成立。
  4. `gate.resolve()` 放行；原 markWaiting 执行 → 尾钩 probe → 补偿入队。
  5. 轮询 `agent_sessions` 直到 `status` 离开 waiting_input 并最终收敛（复用 `waitForStep`，`agent-approval-journey.e2e-spec.ts:76`）；断言 `agent_approvals` 该行 `status='consumed'`、被批工具副作用真的落库（新建 task 行）。
  6. 反面断言：全程**不**调用手动 resume 端点；`queue.getJobs()` 里同名 dedup id 的 job 至多 1 个。
- **反例加测**：另起一例，在 gate 放行后、probe 的 job 执行前手动 resume（把 waitingFor 清空），断言补偿 job 的 `markRunning` CAS 让位、无双跑、无重复副作用。
- **清理**：afterAll 删测试行 + `jest.restoreAllMocks()` + `app.close()`（照抄 `agent-approval-journey.e2e-spec.ts:31-52`）。

### 5.3 验证命令

```bash
cd /data/project/AutoCodeFlow
# 前置：test/e2e PG + Redis 就绪，DB_DATABASE 形如 autoflow_test
export DB_DATABASE=autoflow_test
npx jest --config apps/admin-api/test/jest-e2e.json \
  apps/admin-api/test/agent-approval-lost-wakeup.e2e-spec.ts --runInBand
# 判据：用例 pass，且 PG 中该会话非 waiting_input、审批单 consumed、副作用行存在
```

---

## 6. 风险与回退

### 6.1 失败模式表

| 改动点 | 失败模式 | 影响 | fail-closed 处置 |
|---|---|---|---|
| `hasGrantAwaitingResumeForSession` | 误把 `scope='session'` 派生授权算进来 | 对只有会话级授权的会话误 resume | 谓词钉死 `scope='once'`（照抄 `listForSession:417-420`） |
| `markWaiting` 尾钩 | probe 抛错冒泡 | 审批申请路径失败（比原缺陷更重） | try/catch 只 warn，绝不 throw |
| `markWaiting` 尾钩位置 | 放在 UPDATE 之前 | 回读到 running，补偿失效 | 必须放在 `:1047` 的 `if (!marked.affected)` 判空之后（即命中成功的路径，`:1051` 之前） |
| 新 provider 接线 | Nest DI 成环 | AppModule 启动失败 | 采用反向注册（provider 调 session 的 attach 方法），不在 session 构造器注入 provider；`onModuleInit` 注册 |
| queue.add 失败 | Redis 抖动 | 补偿没入队，会话仍卡死 | warn + 保留 granted 单；D 兜底扫描（需主 agent 裁决是否加 cron） |
| dedup 吞 job | E+ 或残留同名 job | 补偿 job 被 no-op 吞掉 | E-pure 单来源；凭据 + CAS 兜底；必要时换 dedup 命名空间 |

### 6.2 fail-closed 设计

- 补偿是**旁路**：任何异常只 warn，不改审批单状态、不把会话往前推；宁可继续卡住（由人工 resume / D 兜底），不可制造双跑或错误 consume。
- `hasPendingForSession` 优先：还有其它 pending 单时不入队（与 decideApproval `:647` 同纪律），避免恢复后立刻再次挂起、白烧一轮 LLM。
- 配置闸门（可选）：`agent.approval.wakeupProbeEnabled`（默认 true）；关闭则尾钩不注册，行为退回 R300 现状，便于灰度。

### 6.3 文档守卫与 orphan

- `node scripts/docs/check-docs.mjs` 的 links / root-hygiene / bare-paths / readme-sync / ADR / 发版公告六项应绿；`node scripts/docs/check-doc-style.mjs` 应绿。
- **孤儿项**：orphan 判据（`scripts/docs/check-docs.mjs:83`）要求 docs 下文档能从 `docs/README.md` / 根 `README.md` / `docs/atlas/README.md` 走到，唯一豁免是 `docs/archive/`。本文件是新建的 `docs/plan/` 文档，未挂链 ⇒ `check-docs.mjs` 的 orphans 会红。
- **本切片只被允许写本文一个文件**，不修改 `README.md`（遵守任务书）。需主 agent 在 `docs/README.md:95` 附近补一行：

```text
| [plan/approval-lost-wakeup-fix.md](plan/approval-lost-wakeup-fix.md) | R296 审批 granted 丢失唤醒竞态的专项修复方案（方案穷举/反证/实施/验收） |
```

  挂链后重跑 `node scripts/docs/check-docs.mjs` 即全绿。挂链前可用 `node scripts/docs/check-docs.mjs --only=links` 单独确认链接面无死链。

---

## 7. 需主 agent 裁决的点 —— 已于 R321 收口裁决

主 agent（PM）裁决结论（2026-11-21），本方案转为**已拍板可执行**状态：

1. **E-pure vs E+** ⇒ **采纳 E-pure**：竞态窗口内 grant 端 `resumed=false` 保持现状语义（补偿发生在 markWaiting 后的尾钩），不要求 E+ 双侧入队。理由：不改已有 HTTP 响应语义、避开 §3.2 的 dedup 命名空间改造、风险更低。实施时把 R296 单测注释（:353-354）从「修复后 resumed=true」改为 E-pure 语义（grant 端仍 false，但尾钩补偿使会话最终离开 waiting_input）。
2. **架构先例** ⇒ **确认符合**：新增 `AgentApprovalWakeupService` 作为继 `AgentBacklogAutoReenqueueService` 之后第二个注入 queue 的 agent 侧独立服务；会话服务（AgentSessionService）仍不直接依赖 queue，架构意图不破坏。
3. **兜底补偿** ⇒ **不引入短周期 cron**：E-pure 尾钩已同步补偿；D 方案反证（无生产调用者 + 30 天阈值）表明 cron 兜底代价高收益低。queue.add 失败走 fail-closed warn + 保留人工 resume 路径（R300 后会话不会被误收敛，人工可恢复）。
4. **凭据字符串耦合** ⇒ **抽共享常量**：把 `等待审批 ${approvalKey}` 的前缀抽为共享常量（如 `WAITING_FOR_APPROVAL_PREFIX`），markWaiting 调用方与 sweep 前缀判据（agent-session.service.ts:2114）共用，避免漂移。这是低风险改进，纳入实施步骤。
5. **README 挂链** ⇒ **已完成**：主 agent 已在 `docs/README.md` 补 [§6.3](#63-文档守卫与-orphan) 的索引行，`check-docs.mjs` orphans 转绿。
