# workbench 模块 — 业务工作台（方案卡确定性闸门 + 限权会话 + 发布四眼审批）

> 所属: docs/atlas/01-apps/admin-api/modules · 最后更新: 2026-11-27（新建，按当前 HEAD 逐段核对源码） · 对应代码: apps/admin-api/src/modules/workbench
> 设计决策: [ADR-042 三端职责划分与纵向切片优先](../../../../adr/adr-042-workbench-vertical-slice.md) · [ADR-044 企业管控 + 客户端自主工作台的治理边界](../../../../adr/adr-044-enterprise-control-client-autonomy.md) · [ADR-045 方案卡发布的四眼审批与系统代理发布](../../../../adr/adr-045-sop-release-four-eyes.md)

## 职责

业务工作台的**方案卡 → SOP 草稿 → 限权会话 → 四眼发布**闭环（ADR-042 纵向切片：业务用户的自主工作面）。三张 controller 分工：

| Controller | 面 | 角色档 |
|---|---|---|
| `workbench.controller.ts` | 方案卡 preview/commit、rewind、Part 投影、旧 sop_authoring 会话面 | 混合（ADMIN / ADMIN+USER） |
| `workbench-session.controller.ts` | prompt-first 交互面：chat 会话、SSE、续问、取消、审批处置 | 类级 ADMIN+USER，审批 grant/deny 收窄到 ADMIN |
| `release-retry.controller.ts` | ADR-045 发布链的失败重试窄端点 | 全 ADMIN |

一句话：**preview/commit 是纯确定性的本地校验链（不调 LLM 不落 SOP），AI 只做展示增强且永不进判定；会话面把业务用户限进服务端钉死的 kind/scope/creator 里；发布权经四眼审批由系统代理执行，业务人员永不拿到 publish 权**。

## 目录结构与关键文件

```text
modules/workbench/
├── workbench.controller.ts              方案卡 preview/commit/rewind/Part + 旧 sop_authoring 会话面
├── workbench-session.controller.ts      prompt-first 交互面（chat-sessions / SSE / 续问 / 取消 / 审批处置）
├── release-retry.controller.ts          ADR-045 发布失败重试窄端点（全 ADMIN）
├── preview-validator.ts                 ★ buildPreview 确定性闸门 + cardHash + rebuild/draft 纯函数
├── workbench-ai-planner.service.ts      useAi=true 时展示增强（输出永不进 card/cardHash/eligible）
├── policy-generation.service.ts         N14 运行时策略代际（counter + 持久化，capability 写操作即 bump）
├── scoped-rules.ts                      N14 commit 第五闸：通配 allow 随代际切换失效
├── rewind-fence.ts / rewind-runner.ts   N18 代际围栏纯判定 + 服务端消费层（在途写入作废）
├── part-model.ts / part-projection.service.ts   N10 Part 投影（按会话归属投影可见面）
├── context-budget.ts                    N12 相对预算单位（RU）投影，不虚构 token
├── release-approval.service.ts          ADR-045 编排：requestRelease → 四眼 → 系统代理发布
├── release-policy.adapter.ts            ADR-045 策略指纹端口适配
├── workbench-blob.store.ts              Part 大字段 blob 读写
├── workbench-sessions.port.ts           ★ 会话窄端口（create/enqueue/findById/readSummary 四方法）
├── workbench-session-interaction.port.ts / .adapter.ts   交互面端口与适配（SSE/消息/审批）
└── dto/                                 请求/响应 DTO（whitelist + forbidNonWhitelisted）
```

端口与依赖全部走 `@Optional` + token 别名（`useExisting`）：`CapabilityActivationRecorder`→CapabilityActivationService、`QUOTA_HARD_LIMIT_GATE`→QuotaService、`REWIND_*`→PolicyGenerationService/AuditService/空源、`WORKBENCH_SESSIONS_PORT`→AgentSessionService+agent-jobs、`WORKBENCH_SESSION_INTERACTION_PORT`→适配层、`RELEASE_*_PORT` 四端口接 ReleaseApprovalService。缺席（手动 new / 裁剪部署）⇒ 对应端点报 `DEPENDENCY_UNAVAILABLE`（503），绝不回空壳；既有 preview/commit 五闸语义逐字不变。

## 路由

### 方案卡 + rewind + Part（`workbench.controller.ts`，前缀 `workbench`，JwtAuthGuard）

| 方法 | 路径 | 角色 | 用途 |
|---|---|---|---|
| POST | `/api/workbench/preview` | ADMIN, USER | 方案卡预览 + 确定性校验（N7 反幻觉闸门）：不调 LLM、不落 SOP；返回 `eligible` / `checks` / `cardHash` / `policyGeneration`；`useAi=true` 且 AI 装配时追加 `plannerMode` / `aiSuggestions` 展示字段 |
| POST | `/api/workbench/commit` | ADMIN, USER | 确认方案卡落 SOP **draft**（不自动发布）；五道闸（见下）+ ADR-045 三态 `approvalStatus`（submitted/failed/not_requested）回带 |
| POST | `/api/workbench/rewind` | ADMIN | N18 代际围栏：作废旧代际在途异步写入与通知并留审计；**当前无前端入口**（前端仅审计页把 `workbench.rewind` 动作作 i18n 标签展示，无 API 调用点） |
| POST | `/api/workbench/part/project` | ADMIN, USER | N10 按服务端 Part + 会话归属投影可见面（大字段仅可见时从 blob 读回） |
| GET | `/api/workbench/sessions` | ADMIN, USER | 列当前登录用户自己创建的工作台会话（`listOwn`；createdBy/kind/scope 不可由客户端指定） |
| POST | `/api/workbench/sessions` | ADMIN, USER | 运行我的 SOP 草稿：SOP 限 draft + 本人（ADMIN 可代跑）→ 起限权 Agent 会话并入 agent-jobs 队列 |
| GET | `/api/workbench/sessions/:id` | ADMIN, USER | 读回会话进度（步骤/工具调用/审批/产物；防枚举：不存在与越权统一 404；审批项 `canDecide` 自带四眼过滤） |

### 交互面（`workbench-session.controller.ts`，前缀 `workbench`，类级 ADMIN, USER）

| 方法 | 路径 | 角色 | 用途 |
|---|---|---|---|
| POST | `/api/workbench/chat-sessions` | ADMIN, USER | prompt-first 发起会话（无需先 preview/commit）：kind 由服务端从 prompt 推导；首条 user 消息落库并同步入队 |
| GET | `/api/workbench/sessions/:id/stream` | ADMIN, USER | 会话事件 **SSE** 时间线：JWT 或 30s 短效 `?ticket=`（`POST /auth/sse-ticket`）建流，`?fromSeq=` 断线续传；owner 校验（ADMIN 任意 / USER 仅自己）；`@SkipThrottle` |
| POST | `/api/workbench/sessions/:id/messages` | ADMIN, USER | 追加用户消息并恢复执行（运行中走 step 边界注入，挂起的重新入队；终态会话如实回 `ok:false` + `rejected_terminal`） |
| POST | `/api/workbench/sessions/:id/cancel` | ADMIN, USER | 协作式中止请求（cooperative abort，不伪造终态） |
| POST | `/api/workbench/sessions/:id/approvals/:approvalKey/decide` | grant/deny 仅 ADMIN；withdraw 仅 owner | 审批处置：四眼（申请人自批报 `AGENT_APPROVAL_SELF_DENIED`，`user:<id>` 与 `user:<username>` 双口径都挡）；applied=false 如实回 `ok:false` |

### 发布重试（`release-retry.controller.ts`，前缀 `workbench`，全 ADMIN）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/workbench/release-approvals/:approvalKey/retry` | ADR-045 一键重试：仅「**consume 之前**的失败」白名单内 `expectedReason` 可重跑发布；`publish_failed` 表示 consume 已完成，调用被拒以防重复发布 |
| POST | `/api/workbench/release-approvals/request` | R92：审批**发起**失败后由 ADMIN 重新发起审批单（只 requestRelease，不 decide/consume/publish，四眼边界不变） |

> ADR-045 的**批准与拒绝**不在本模块：复用 [agent](agent.md) 模块既有的 `POST /api/agent/sessions/:id/approvals/:approvalKey/grant|deny`（ADMIN-only）；granted 后由 `release-outcome.audit.ts` 调 `ReleaseApprovalService.releaseByApprovalKey` 完成 hash 比对 + consume + **系统代理发布**——业务人员永不拿到 publish 权。

## 会话 kind 全集（来源 `SESSION_TOOL_ALLOWLIST`，agent/tools/tool-registry.ts）

工作台自身只创建 `sop_authoring`（运行我的草稿，scope 钉 `{sops:[sopId]}`、triggerSource=`workbench`）与 prompt 推导的三种；**全集 7 种**见 [agent 模块](agent.md) 工具白名单一节：

| kind | 工具姿态 | 与工作台的关系 |
|---|---|---|
| `chat` | 不限（null，等价管理员本人操作） | prompt 无 SOP/计划意图时的缺省推导 |
| `sop_authoring` | 读 + SOP 起草/发布/指派 + 建应用/建任务/部署/建组 | 工作台「运行我的草稿」与 SOP 意图 prompt 都落这里（发布仍逐工具审批） |
| `plan` | 纯只读（写/destructive 由 plan-agent-gate 恒拒，N11/ADR-044） | prompt 含计划/拆解意图时推导 |
| `sop_review` | 读 + `sop_reply_clarification` + `trigger_task` | ADR-045 发布审批会话（release-approval.service 起，主管四眼批准用） |
| `ops_watch` | 纯只读（定时巡检） | 不由工作台创建 |
| `incident` | 读 + 收敛性写（触发/重试/暂停/终止） | 不由工作台创建 |
| `app_scaffold` | 读 + 建应用/建任务/部署/建组 | 不由工作台创建 |

未登记 kind → 空集（拒绝一切，fail-closed）。交互面的 kind 推导是**纯函数** `inferWorkbenchSessionKind`（`/sop|草稿|起草|流程文档/ → sop_authoring`；`/计划|方案|规划|拆解步骤/ → plan`；否则 `chat`）——DTO 根本没有 kind 字段，whitelist 剥除/拒绝客户端自报。

## 方案卡确定性闸门（N7/N12/N14/N18/N20 核心）

`buildPreview`（preview-validator.ts）是**唯一事实源**，纯本地纯内存：不调 LLM、不落库。

- **cardHash**：对 card 规范化 JSON（`stableStringify` 递归按键排序）取 sha256 截 **16 hex**——插入顺序不敏感，预览与提交之间的留痕锚点。
- **闸门项**：`goal` 非空 ≤500 字符；`cadence` 必须 once/hourly/daily/weekly/monthly（触发语句**查表回读**，无格式化分支）；`capabilityId` 命中白名单 `browser/gui/filesystem/http`（取自 SOP 真实能力域，未命中 fail 且 `eligible=false`，未指定 warn）；`budget.maxTurns` 默认 10、硬上限 `PREVIEW_MAX_TURNS_CAP=20`（超限截断 warn 不放行自由增长，非法值回落默认）。
- **eligible=false 的卡 commit 必须真的挡住**：commit 服务端用 `rebuildCardFromInput` 从 goal/cadence/params **重建同一张卡**（刻意不接收 card 入参，客户端改卡片字段影响不了结果），比对 `expectedCardHash` 后仍判 `eligible`。
- **代际围栏**：`policyGeneration` = sha256(策略快照) 截 16 hex，快照 = `policyVersion + 能力白名单 + maxTurnsCap`，与 agent-approvals 的 policyFingerprint 同型。生产由 `PolicyGenerationService` 的运行时 counter 注入（capability 写操作 emit 后立即换代际）；commit 第三闸比对客户端带来的 `expectedPolicyGeneration`，第五闸（scoped-rules）在 draft 落库前**再读一次**——两次读取之间策略变更 ⇒ 通配 allow 作废、拒绝落库。
- **AI enhance 不进判定**：`WorkbenchAiPlannerService.enhance` 只在 `preview?useAi=true` 时被调，以确定性卡为锚向模型要「步骤/风险/建议能力」，输出**只能**影响 `plannerMode` / `aiSuggestions` 两个展示字段——绝不进入 card / cardHash / eligible / checks；15s 硬超时（`WORKBENCH_PLANNER_TIMEOUT_MS`），超时/解析失败/`@Optional` 缺 AiService 一律回落 deterministic。AI 建议永不进 cardHash 的含义：同一输入下闸门结论与留痕 hash 与模型可用性**完全无关**。

### commit 五道闸（顺序固定，逐字不动）

| # | 闸 | 失败语义 |
|---|---|---|
| ① | `expectedCardHash` 与服务端重建一致（16 hex 正则） | 401 VALIDATION_FAILED：卡被篡改/入参不匹配 |
| ② | 重建卡 `eligible=true` | 闸门未过的卡不允许落库 |
| ③ | `expectedPolicyGeneration` = 当前运行时代际 | 策略已变更 ⇒ 旧卡作废，重新预览 |
| ④ | 配额硬阈值（N20 fail-close；gate 自身读配额失败 fail-open） | 429 RATE_LIMITED；发生在 draft 落库**之前**，`sops.draft`/`activation.record` 零调用 |
| ⑤ | scoped-rules 通配 allow 代际失效判定（构造失败 warn+放行，判定为空放行） | 通配授权已随代际切换失效 ⇒ 拒绝落库 |

落库只 draft（`buildDraftPayloadFromCard`：capabilities 只放真实能力域、acceptance 用 `platform/task_status/success` 机器可判定占位、triggerText/budget/cardHash 落 body；slug=`workbench-<cardHash 前 8 位>`；组装结果必须过草稿级 front-matter 校验）；激活记账（`workbench.commit`）与发布审批发起失败审计均为 fire-and-forget 旁路，绝不回滚已成功的 commit。

## rewind（N18 代际围栏）

`rewind-fence.ts` 只做纯判定，`RewindRunner` 是服务端消费层：代际只读服务端注入的 `PolicyGenerationService`（客户端任何代际锚点不参与判定）；在途写入只从服务端 `RewindAsyncWriteSource` 取，作废集合不进入 apply（NotificationService 无撤回 API，作废即「不扇出」，不新建通知接口）；每次执行记一条字面量 action 审计（`detail.invalidatedCount` = 作废数）。**当前无前端入口**：admin-web 无任何 rewind API 调用点（仅审计页展示该动作的 i18n 标签），端点为 ADR-044 治理链预留的运维面。

## 与其他模块的关系

- **[agent](agent.md)**：工作台不直接依赖 BullMQ/agent provider 装配——经 `WORKBENCH_SESSIONS_PORT`（create/enqueue/findById/readSummary 四方法）与 `WORKBENCH_SESSION_INTERACTION_PORT` 借窄能力；生产由 WorkbenchModule 适配器接真实 `AgentSessionService` + agent-jobs 队列（与 agent.controller 入队同口径：jobId=sessionId 去重、attempts=1）。会话执行走 agent 的边界闸门七道检查（工作台会话 kind/scope 已在创建时钉死）。ADR-045 的审批处置复用 agent 既有 grant/deny 端点；装配期 `forwardRef`，环是装配期的不是运行期调用环。
- **[sop](sop.md)**：commit 调 `SopService.draft` 落工作副本（不改 SOP 发布链——发布仍走 sop 的不可变版本快照）；`buildDraftPayloadFromCard` 的 front-matter 对齐 `sop-frontmatter.validateFrontMatter` 草稿档（strict:false）；能力白名单取自 `SOP_CAPABILITIES`。运行我的草稿要求 `status === "draft"`（已发布不许跑）且 `createdBy` 归属本人。
- **[ai](ai.md)**：`@Optional` 注入，仅 `useAi=true` 的展示增强（15s 超时回落），缺席时 preview 语义逐字不变。
- **capability-activation**：commit 的激活记账（`workbench.commit`）与第四闸配额硬阈值（`QUOTA_HARD_LIMIT_GATE`→QuotaService）；记账 fail-open 只 warn。
- **[audit](audit.md)**：发布审批发起失败（R92）、rewind 执行、发布结果（release-outcome.audit.ts，在 agent 模块侧）走审计旁路，fire-and-forget。
- **与 agent 模块的边界**：agent 是**常驻自主运维 Agent 运行时**（多轮推理循环、预算、触发器），workbench 是**业务用户的确定性工作台**（方案卡、限权会话、四眼发布）——workbench 自己没有推理循环，会话本体与工具闸门全在 agent 域；与 sop 的边界：sop 管协议全生命周期（起草→发布→指派→澄清），workbench 只负责「把一张已通过闸门的卡变成 draft + 发起发布审批」，不碰 publish。

## 常见改动场景

- **改闸门项/白名单/预算上限**：只改 `preview-validator.ts`——preview 与 commit 共用 `buildPreview` 单一事实源，不存在第二份生成逻辑；改 `PREVIEW_MAX_TURNS_CAP` 等**参与代际求值**的项会让所有在途卡作废（重新 preview 即可，这是设计行为不是回归）。
- **加 AI 增强字段**：只进 `PlanCardAiSuggestionsDto` 与 `aiSuggestions` 展示面；任何想进 card/cardHash/eligible 的改动都是越界——确定性语义一字不改是本模块的验收锚点（有专门断言）。
- **加会话面端点**：放 `workbench-session.controller.ts`（`workbench.controller.ts` 已在 size-caps 棘轮上）；必须走 `WORKBENCH_SESSION_INTERACTION_PORT`，owner 校验复用 `assertOwner`（ADMIN 任意 / USER 仅 `user:<id>` 或 `user:<username>` 双口径）。
- **改 kind 推导**：`inferWorkbenchSessionKind` 纯函数（有单测）；新增意图正则前先确认目标 kind 在 `SESSION_TOOL_ALLOWLIST` 已登记（未登记 = 空集拒绝一切）。
- **给 rewind 加前端入口**：先确认 ADR-044 治理链验收口径；端点已就绪（rewindRunner 缺席报 `DEPENDENCY_UNAVAILABLE`），前端加调用点即可，无需改后端。

## 相关文档

- [ADR-042 · 三端职责划分与纵向切片优先](../../../../adr/adr-042-workbench-vertical-slice.md) · [ADR-044 · 治理边界](../../../../adr/adr-044-enterprise-control-client-autonomy.md) · [ADR-045 · 四眼审批与系统代理发布](../../../../adr/adr-045-sop-release-four-eyes.md)
- [agent 模块](agent.md)（运行时、边界闸门七道、grant/deny 端点） · [sop 模块](sop.md)（SOP 生命周期与 front-matter 契约） · [ai 模块](ai.md)（LLM 出口）
