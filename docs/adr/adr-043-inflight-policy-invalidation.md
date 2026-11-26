# ADR-043: 在途策略失效（N14 interrupt）的接线边界与重开条件

状态：Accepted（决策为"暂不做完整接线 + 固化重开条件"）
- 日期：2026-11-26

## 动机（背景与判据来源）

strategy §12.3 N14 与 GCO §11.3 要求：`capability/changed` → interrupt 在途 + 下次工具 check 用新 policy + scopedRules 保住未被通配覆盖的 ask/deny，原文判词是"**不接此条则'引导在权限框架内'为空**"。这是 Workbench 治理链的核心，不是边角料。

工作台改造第 1–7 轮已把 N14 拆成三层落地：① 运行时代际（`policy-generation.service.ts:95`，counter 持久化到 `system_configs`，`capability.service.ts:605` 落库后 emit `capability.changed`，本服务订阅后 bump）；② scopedRules 纯分类（`workbench/scoped-rules.ts`，通配 allow 作废、显式 ask/deny fail-closed 保留）；③ commit 第五闸（`workbench.controller.ts` 的 quota 闸后、`sops.draft` 前，调 `classifyScopedRules`，通配 allow 命中即拒、draft 零调用）。三层均有单测/反证（workbench 8 suites/95 tests）。

但"interrupt 在途工具调用"这一维始终未接。第 5–8 轮连续四次评估（见 AGENT_HANDOFF 各轮段）后，CodeGraph 逐字确认了三个结构性事实：

1. `capability.changed` 当前**只有一个订阅者**——`PolicyGenerationService`（`policy-generation.service.ts:117-121`），它只 bump 代际，不标记/中断任何在途会话。
2. `AgentBoundaryService.check()`（`agent-boundary.service.ts:182`）每次调用都重读 **approval policy**（`:240` 的 `resolveApprovalPolicy()`），因此"下次工具 check 用新**审批** policy"这一维**已经成立**；缺的是 **capability 代际维度**的在途作废，两者是不同策略面。
3. `AgentSession` 实体（`entities/agent-session.entity.ts:139-234`）**没有 generation 字段**；`scopeJson` 虽是 jsonb 且被 boundary:545 消费，`create()` 写 `scopeJson: input.scope ?? {}`（`agent-session.service.ts:586`），但 **workbench 的 commit 路径不创建 agent 会话**（CodeGraph：`modules/workbench` 无 `agentSession`/`createSession` 调用），因此没有任何真实写入方会把方案卡的 `policyGeneration` 放进会话 scopeJson——直接加字段会造出"无写入方的假接线"。

## 决策（方案）

**本 ADR 的决策是：暂不实现 N14 的"在途 interrupt"完整链；把已落地的三层（代际 bump + scopedRules + commit 第五闸）视为 N14 当前交付边界；完整接线性质的改动必须按下面的方案 A 立项后单独实施。**

三条候选方案与裁决：

- **方案 A（推荐，需独立立项）**：显式建模"方案卡→agent 会话"的 generation 传递契约。① 在 `POST /workbench/commit` 生成方案卡时把 `policyGeneration` 作为**显式输出**返回（前端/调用方持有）；② agent 会话创建入口的 `scope` DTO 增加可选 `policyGeneration`，调用方（含 IM Intake→方案卡→会话的旅程）写入 `scopeJson.policyGeneration`；③ `AgentBoundaryService` 增加 `setGenerationProvider(fn)`（与既有 `setApprovals` 同型的装配缝，保持闸门纯函数、不读库），`check()` 在工具执行前比对会话 generation 与当前 generation，不符 ⇒ DENY（fail-closed，带可读理由）；④ `capability.changed` 的第二订阅者把受影响代际写进有界作废集合，供 provider 判定。四步全做 + 真 PG 进程内 e2e 断言"策略变更后旧会话工具调用被拒且零副作用"才算闭环。
- **方案 B（否）**：会话创建时无条件写当前 generation 到 scopeJson，boundary 直接比对。否因：没有真实写入方把方案卡 generation 传进会话创建（workbench 不建会话），写成"当前 generation"等于每次都相等、永不触发——是假绿。
- **方案 C（否）**：`capability.changed` 时全局 bump 一个进程内 flag，boundary 读 flag 一律 DENY 直到会话重启。否因：会误伤所有无关会话（无按会话/按代际粒度），把"策略收紧"放大成"全系统工具停摆"，误报代价远大于漏报。

**暂缓期的真实边界**（不是遗漏，是本 ADR 明示的当前交付范围）：approval policy 维度的"下次 check 用新策略"已成立；capability 代际维度只在 commit 闸生效，**在途 agent 工具调用不会被 capability 变更中断**。

## 影响面（后果与代价）

- 正向：把连续四轮的"要不要现在做"决策一次性固化，避免后续会话反复探查同一问题又反复推迟（已发生过 4 次）；给出可执行的最小完整方案 A 与明确的验收线，重开时不必重新设计。
- 代价：在途中断能力暂缺——管理员收回能力后，已在运行的 agent 会话下一次工具调用仍按旧 capability 状态执行，直到该会话结束或重新 commit。鉴于当前 workbench 的 commit 是短事务（方案卡→draft），在途窗口有限；且四眼审批 + approval policy 实时重读提供了一层独立护栏，风险可控但不为零，须如实对外说明。
- 验收：方案 A 实施后必须以真 PG 进程内 e2e 为准（策略变更 emit → 旧 generation 会话工具调用被拒 → 零副作用落库），不以单测或"接口返回成功"代替（AGENTS §4.4）。

## 替代方案（被否）

- "再堆一层纯函数/骨架"（前几轮多次差点这么做）：没有真实消费方的 listener 或判定层无法做副作用验收，是 AGENTS §4.5 明确反对的半成品。
- "在 boundary 里直接 import PolicyGenerationService 读当前 generation"：boundary 的设计纪律是纯函数闸门、不读库/不注入服务；破坏它会让 40+ 用例的替身装配全部失效。
- "靠 approval policy 指纹覆盖 capability 代际"：两者是不同策略面（审批配置 vs 能力注册表），用前者冒充后者会在能力被收回但审批策略没变时漏判。

## 回滚

- 本 ADR 只固化决策、不改生产代码，无运行期回滚。
- 若方案 A 实施后发现 `setGenerationProvider` 装配破坏既有 boundary 单测/真链：按 setApprovals 先例保留 `@Optional` 缺席跳过路径，摘掉 provider 装配即回到当前边界（approval policy 实时重读 + commit 第五闸），不影响既有功能。
- 若 generation 传递契约引入前端/IM 旅程的形状变化：保持 `policyGeneration` 为可选字段，缺省即当前行为（不中断），逐调用方灰度。

## 分步计划

1. （本 ADR）固化三层已交付边界 + 方案 A + 重开条件；更新 strategy/GCO 的 N14 状态指向本 ADR。
2. 独立立项：按方案 A 四步实施，写域切分为 generation 输出（workbench）/ 会话 scope 写入（agent-session + DTO）/ boundary 装配缝 / 事件订阅作废集合，各写域互斥并行。
3. 真 PG 进程内 e2e 断言在途中断的实际副作用；通过后把 N14 从 🟡 升 ✅。
4. 若重开条件未出现（见下），保持当前边界，不实施。

## 明确不做（本轮）

- 不改 `AgentBoundaryService` 的构造签名或纯函数性质。
- 不在 `AgentSession` 上新增不可空列/迁移（scopeJson 复用即可，且当前无真实写入方，不制造假字段）。
- 不把 capability 代际与 approval policy 指纹混为一谈。
- 不在全局维度一律 DENY（方案 C）。

## 重开触发条件（满足任一即启动方案 A）

1. IM 一等入口的"企微@→方案卡→审批→交付"旅程需要"审批后能力被收回即中断在途执行"的语义（N6 真实网关上线后会出现）。
2. 出现 >1 个真实调用方需要把方案卡 generation 传给 agent 会话（当前 0 个）。
3. 真机/生产事故证明"收回能力后在途执行仍产生副作用"造成了实际损失。

## 证据锚点

- `apps/admin-api/src/modules/workbench/policy-generation.service.ts:95,117-121`（代际 counter + capability.changed 订阅）
- `apps/admin-api/src/modules/capability/capability.service.ts:605`（能力写后 emit）
- `apps/admin-api/src/modules/workbench/workbench.controller.ts:103,317-321`（scopedRules 合成 + commit 第五闸）
- `apps/admin-api/src/modules/agent/boundary/agent-boundary.service.ts:182,240,545`（check 重读 approval policy + scopeJson 消费）
- `apps/admin-api/src/modules/agent/entities/agent-session.entity.ts:139-234`（无 generation 字段）
- `apps/admin-api/src/modules/agent/runtime/agent-session.service.ts:586`（scopeJson 写入口）
