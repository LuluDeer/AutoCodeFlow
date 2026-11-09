# ADR-039: `execute` 的事务边界 —— 能否安全再拆？

状态：Accepted（**结论：不值得拆**；有界性记入本 ADR，建议关闭 `execute-further-slimming`）
- 日期：2026-11-07
- 触发：backlog `execute-further-slimming = needs-adr`（ADR-031 步骤 4 已到安全边界）
- 相关 ADR：[ADR-031](adr-031-replay-decision-hoist.md)（步骤 1–4 的瘦身与「事务边界不跨函数」硬裁决）· [ADR-026](adr-026-conditional-state-writes.md)（条件状态写）
- 结论一句话：**`execute` 里没有事务可拆** —— 它的正确性建立在「单语句 CAS + 幂等条件写 + 严格因果顺序」上，拆函数会打断顺序而不带来任何原子性收益

## 1. 动机：搞清楚「事务边界」到底是什么

### 1.1 事实一：`execute` 里**零个显式事务**

`apps/admin-api/src/modules/agent/tools/tool-executor.service.ts:275` 的 `execute`（现 503 行）内
**没有任何** `dataSource.transaction` / `manager.*` / `queryRunner`（全区间 grep 为空）。
所有写入都是**独立语句**，逐条自己提交：

| 段（当前行号） | 写入动作 | 原子性来自 |
|---|---|---|
| `:301-345` | `findToolCall` → `persist` 闭包（`recordToolCall` / `updateToolCallByToolCallId`，失败退回插入） | **幂等**：条件更新 + 「行不在就插入」 |
| `:593-664` | `approvals.consume(key, policyFingerprint)` → `settleToolCallByApprovalId(...)` | **单语句 CAS**：`consume` 是一次带谓词的 `approvals.update(...)`，只看 `affected`（`runtime/agent-approvals.service.ts:788-826`），**没有外层事务** |
| `:665-699` | 在途台账（`writeInFlightLedger`） | 条件写 + 幂等闸（`findToolCall` 的既判） |

### 1.2 事实二：CAS 与落库**不在同一事务**，而且**不需要**

`consume` 的原子性由**单条带谓词的 UPDATE** 提供（`approvalKey + status=granted + policyFingerprint` 命中才 `affected>0`；`agent-approvals.service.ts:788` 起）。
它后面的台账写（`persist` / `settleToolCallByApprovalId`）是**另一条独立语句**。

**这不是缺陷，而是 R60/R61 的设计**：正确性靠三个不变量，而不是靠事务：

1. **顺序**：`闸门 → 领取（CAS）→ 副作用 → 台账` 的因果顺序不可换（`:593` 的段标题原文就是
   「**必须在副作用之前**」）；
2. **单判据**：是否重放只由「台账里有没有该 `toolCallId` 的行」（`:314` `ledgerRowExists`）判定，
   不读调用方的口头声明；
3. **可结清**：一次性单被领走后，同 `approvalId` 下残留的 `awaiting_approval` 行由
   `settleToolCallByApprovalId`（条件 UPDATE）结清 —— 天然幂等，不碰本次刚写的行。

### 1.3 事实三：真正的「事务」在**别处**，已各自收口

`execute` 依赖的三个写入面各自有明确的事务/原子性边界，**都不在 `execute` 里**：
`AgentSessionService` 的写入口（`recordToolCall` / `updateToolCallByToolCallId` / `settleToolCallByApprovalId`）、
`AgentApprovalsService.consume`（单语句 CAS）、`ExecutionStatus` 无关。
⇒ 想在 `execute` 里「优化事务边界」，前提是**先有事务** —— 但这里没有。

## 2. 方案对比

### 方案 A · 保持单事务语义（实际是「零事务」）+ 只做函数内分区注释（基线）

- **做法**：不改结构，只把 `:301/:365/:394/:405/:411/:456/:485/:576/:579/:593/:665/:700` 这些
  已有段标题整理成一张「段 → 不变量」对照表放进注释（本 ADR §1.1 就是这张表的雏形）。
- **事务边界**：**不动**（本来就没有事务，故无「拆开」风险）。
- **代价**：0 行收益；**风险**：0。
- **失效半径**：无变化。
- **迁移**：无。

### 方案 B · 把「审批查 + 三分支决策」抽成**纯函数**（输入快照 → 输出决策）

- **做法**：`decideApprovalOutcome({existingApproval, currentPolicyFingerprint, sessionGrant})`
  → `{kind: "denied"|"consumed"|"policy_mismatch"|"proceed", message}`；`execute` 只按决策落库。
- **事务边界**：**不拆**（纯函数无 IO）。但**并非全部可抽**：`consume` 是 CAS 且它的
  `affected` **就是决策结果**（`:601` 的 `claimed` 决定走「成功」还是「claim lost」分支）
  ⇒ **CAS 必须留在命令式流程里**，可抽的只有**三个拒绝分支**（`:411` denied / `:435` consumed /
  `:456` 指纹不符）。
- **需要的数据**是否已就绪？**已就绪**：三处输入（`existingApproval` 已查、`currentPolicyFingerprint` 已算、
  `sessionGrant` 已判）全部是内存值 ⇒ **不引入二次读**，不会读到不一致状态。
- **代价**：`execute` 约省 **25–35 行**；新增一个纯函数文件 + 单测。
- **风险**：低，但**收益同样低**（只搬「格式化拒绝理由 + 选 kind」这部分）。

### 方案 C · 拆成两个事务（决策事务 / 落库事务）+ 幂等键

- **事务边界**：**新增**两个事务（注意：现状是零事务）。**这是本 ADR 最关键的判断** ——
  C 不是「拆已有事务」，而是**凭空引入事务**。
- **为什么可能不安全**（必须写清）：
  1. **CAS 失效窗口**：决策事务里读 `granted`、落库事务里再写，中间没有 CAS 谓词 ⇒ 两实例可同时通过；
     要救必须把 CAS 也搬进第二个事务，那第一个事务就白开了；
  2. **审批单泄漏**：若「领取」在事务 1 提交、事务 2 回滚 ⇒ 单已 consumed 而台账无对应行 ⇒
     该单永久作废（用户被要求重新审批），且**没有任何行承载这个事实**（审计面无法解释）；
  3. **反向泄漏**：若「领取」放事务 2 而台账写在事务 1 ⇒ 台账说「已批准执行」而单尚未 consuming ⇒
     重启后可能二次执行（**重复副作用**）；
  4. **R60/R61 的单判据语义依赖**「一条语句成功/失败即事实」，事务边界把「事实」变成「一段时间」，
     而 `execute` 的恢复路径（`in_flight` 崩溃点判定 `:665`）正是按「单语句已落地」设计的。
- **若要这么做必须先满足什么**：① 有一个**跨事务的幂等键**（如 `(sessionId, toolCallId)` 唯一约束
  且写入在**同一**语句内 upsert）；② 领取与「台账 in_flight」合进**同一条**语句（否则仍有窗口）；
  ③ 恢复路径改为读「事务日志」而不是读台账行。
  ⇒ 这三条等于**重写执行器核心语义**，与「瘦身」目标无关。
- **迁移**：可能要加唯一约束（迁移）；**失效半径**：重复执行 / 审批单永久作废 / 漏结清，三者都会**静默**发生（无日志）。

### 方案 D · 把整条「审批查 → 三分支 → 闸门 → 领取」搬进一个协作者类

- **做法**：`ApprovalResolutionCollaborator`（同进程、同顺序，只是换文件）。
- **事务边界**：不拆。
- **收益**：`execute` 可省 **~150 行**（最大收益）；**但被 R99 的硬裁决直接禁止**：
  「**不许**把『查审批 → 三分支 → 闸门 → 领取审批单事务』这条链拆到多个函数（会打断 R60/R61 修好的
  『单判据 + 结清』语义）」。
- ⇒ 记录在此**仅为完整**：技术上可行、收益最大、但**违背已生效的裁决**，除非先推翻那条裁决（需新 ADR）。

## 3. 推荐：**方案 A**（记入有界性并关闭 backlog），可选叠加 **B** 的一小部分

判定依据（三条）：

1. **没有事务可拆**（§1.1/§1.2）—— 任何以「优化事务边界」为名的拆分都在解决一个不存在的问题；
2. **C 会引入新风险且不可观测**（§2 方案 C 的四条），而它的收益是「更小的函数」，与风险完全不成比例；
3. **D 被现行裁决禁止**；**B 可做但收益仅 25–35 行**，且真正危险的分支（CAS）**抽不出去** ——
   边际收益低于「再动一次执行器核心」的风险。

⇒ **建议把 `execute` 的有界性写进本 ADR 并关闭 backlog 条目 `execute-further-slimming`**。
若将来确要再瘦，**先做 B**（低风险、可逆），不要碰 C/D。

## 4. 影响面与失效半径

| 方案 | 失败模式 | 可观测信号 |
|---|---|---|
| A | 无（不改） | — |
| B | 纯函数把某个 `kind` 判错 ⇒ 走错拒绝分支 | 既有 `denied` / `consumed` / 策略指纹三组用例；`buildConsumeDenialMessage` 的文案断言 |
| C | ①重复执行 ②审批单永久作废 ③漏结清 | ①同一 `toolCallId` 出现两行 `ok` ②`agent_approvals.status=consumed` 但无对应 `ok` 台账行 ③`awaiting_approval` 行长期不减 —— **三者都静默**，只有靠对账查询发现 |
| D | 与 A 相同（同顺序），但引入一层间接 | 无新增信号 |

## 5. 回滚

1. **本 ADR 无实现** ⇒ 无需回滚；若将来按方案 B 实施，改动是**单个 commit**（新增纯函数文件 + `execute` 内替换），
   `git revert` 即可整体回退。
2. **无数据迁移**：三个方案都不动 schema（方案 C 若加唯一约束**才**需要迁移，而它已被否决）。
3. **不设特性开关**：本仓已三次裁决「双轨开关 = 制度化的两种承诺」（ADR-032 §4.3 / ADR-033 §4.3 / ADR-035 §4.2）；
   `execute` 是安全关键路径（审批 + 副作用），一个「用旧路径还是新路径」的开关等于**同时维护两套语义**。

## 6. 分步计划

### 步骤 1 · 把有界性写成可核验的注释（方案 A）—— 建议本 ADR 落地时一并做

- **做**：在 `execute` 顶部把 §1.1 的「段 → 不变量」表写成注释（段标题已存在，只需补一张总表）。
- **红→绿判据**：`npm test -- --testPathPatterns "tool-executor"` ⇒ exit 0（纯注释）；`tsc` exit 0。
- **失败如何退**：注释改动，`git checkout --` 即可。

### 步骤 2 · 关闭 backlog 条目

- **做**：`execute-further-slimming` 从 `needs-adr` → **closed（有界性见 ADR-039）**（台账由 Lead 维护）。
- **判据**：台账里该条目引用本 ADR 编号且状态为 closed。

### 步骤 3 ·（可选，仅在将来确需瘦身时）方案 B

- **做**：抽 `decideApprovalOutcome` 纯函数，只覆盖三个**拒绝**分支（`denied` / `consumed` / `policy_mismatch`）；
  CAS (`consume`) 与结清**留在原位**。
- **红→绿判据**：先写「三组拒绝分支的 kind + 文案」纯函数单测（应红：函数不存在），实现后绿；
  且 `execute` 的既有 6 组审批用例保持绿。
- **失败如何退**：单 commit revert。

## 7. 明确不做

1. **本轮零实现改动**（只出 ADR）。
2. **不引入事务**（方案 C 否决）：现状零事务是正确的，不是遗漏。
3. **不把「审批查 → 三分支 → 闸门 → 领取」拆到多个函数**（方案 D 否决，R99 硬裁决）。
4. **不为瘦身而瘦身**：`execute` 503 行 / 771 行文件是本 ADR 认定的**安全边界**，
   后续任何改动必须**先证明它不改变 §1.2 的三个不变量**。
5. **不改 `consume` 的 CAS 语义**（ADR-030/031 已定）。

## 8. 关联

- 相关 ADR：[ADR-031](adr-031-replay-decision-hoist.md)（步骤 1–4 与硬裁决）、[ADR-030](adr-030-executor-token-cross-instance-idempotency.md)（CAS 幂等范式）、[ADR-026](adr-026-conditional-state-writes.md)（条件状态写）
- 代码（证据锚点，逐处 `文件:行号`）：
  `apps/admin-api/src/modules/agent/tools/tool-executor.service.ts:275`（`execute` 起点）、
  同文件 `:314`（`ledgerRowExists` 单判据）、同文件 `:321`（`persist` 闭包起点）、
  同文件 `:394`（审批单消费段）、同文件 `:485`（闸门段）、同文件 `:601`（领取 CAS）、同文件 `:665`（在途台账段）、
  `apps/admin-api/src/modules/agent/runtime/agent-approvals.service.ts:788`（`consume` 单语句 CAS 起点）
- 计划项：R60/R61（单判据 + 结清）、R67/R99（纯段外提与安全边界）、R132（本 ADR）
