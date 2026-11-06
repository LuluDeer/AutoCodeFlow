# ADR-031: replay 决策前移——把「台账写哪一行」从两个判据收成一个

状态：Proposed（设计已定稿；**步骤 1、2 已落地**，见下方「落地进度」）
- 日期：2026-11-05
- 基线提交：`c535085d`（本文所有 `文件:行号` 在此时点逐行核对过；行号会随重构漂移，判据见附录 A 的锚点数下限）
- 落地进度：**步骤 1 已完成**（R60）：characterization test 先红（3 failed）→ 最小修复 → 反向验证（回退修复 ⇒ 3 failed）→ 定向 7 suites / 210 passed。§1.3 的两条静态推断**已被实测证实**（旧实现在「已批准调用被新 id 重提」时确实用不存在的 id 发起更新）。
- 落地进度：**步骤 2 已完成**（R63）：`opts.replayApproved` **已收进 `ToolCallContext`**（新增零依赖模块 `apps/admin-api/src/modules/agent/tools/tool-call-context.ts`：`ToolCallContext` / `ReplayDeclaration` / `buildToolCallContext` / `replayDriftMessage`）。`execute` 第 4 参改为 `declaration: ReplayDeclaration`，入口按**真实入参**构造**一次**上下文，调用方只能声明意图（`replayDeclared`）、**无法伪造身份**。判据：新用例在旧实现下 exit 1（TS2353：上下文对象在旧签名里不存在）→ 实现后 5 suites / 200 passed、`tsc --noEmit` exit 0；反向验证（`replayDeclared` 恒置 false ⇒ 那条 warn 断言红）exit 1。步骤 3–5 未做。
- 落地进度：**步骤 4 第二部分（R99）**：`execute` **578 → 503**、`tool-executor.service.ts` **843 → 771**，行为零变更。
  本刀只搬**纯格式化**：`execute` 里同一形状的「未执行落库行」重复了 **8 处**（每处 10–13 行、逐个手写 9 个字段）⇒ 抽成零副作用的纯构造器
  `apps/admin-api/src/modules/agent/tools/tool-call-row.util.ts` 的 `deniedRow` / `awaitingRow` / `tierOf`（**只算「这一行长什么样」，不写库**），
  并把整条调用不变的「身份四元组」收成一次 `rowIds` 构造。
  **事务边界未动**（Lead 硬裁决）：查审批 → 三分支 → 闸门 → 领取审批单这条链**仍完整留在 `execute` 内**，`persist` 闭包与 R60/R61 的「单判据 + 结清」语义原样保留。
  判据：定向 `tool-executor|agent-approvals|agent-runtime|agent|tool-call-row` ⇒ 45 suites / 811 passed / exit 0；`tsc` exit 0；`check:size-caps` exit 0。
  **反向验证**：让 `deniedRow` 返回空对象 ⇒ **8+ 条既有用例红**（横跨「闸门 DENY」「denied 审批单」「脱敏」「B-2 slug 归一」「B-3 澄清归属」「N3 策略指纹」六个 describe）⇒ 证明确实在被用。
  新构造器有独立单测（7 例），其中一条钉住「`approvalId` 缺省时**不得**写出该键（不是 null）」。
- 落地进度：**步骤 4/5 已开工（第一部分，R67）**：`execute` 函数体 **676 → 578**（目标 ≤600，达成），行为零变更。共四刀，全部只搬**计算**、副作用（落库/日志/熔断记账）仍留在 `execute` 里可被 spy 断言：
  · 刀1 入参归一/校验 → `apps/admin-api/src/modules/agent/tools/tool-executor.arg-parse.util.ts`（出口 `parseToolArguments`，失败文案只有一份实现）；
  · 刀2 结果整形与终局载荷 → `tool-executor.result-finalize.util.ts`（`finalizeToolResult`，注入 `sanitizeResult`/`sha256`/`maxChars` 以免造环；顺带消掉一个从未使用的死变量 `preview`）；
  · 刀3 失败/超时出口 → `tool-executor.failure-finalize.util.ts`（把「写类超时 = 结果未知、不记熔断」的三个后果一次算清）；
  · 刀4 在途台账写入 → 私有方法 `writeInFlightLedger`（判据仍是 `ledgerRowExists`，语义逐字保持）。
  判据（机读）：定向 `tool-executor|agent-approvals|agent-runtime` ⇒ 8 suites / 223 passed / exit 0；三个搬出模块各有**独立单测**（arg-parse 11 例、result-finalize 6 例、failure-finalize 6 例）；`tsc --noEmit` exit 0；`check:size-caps` exit 0（`execute` 578 < 已签 619，`tool-executor.service.ts` 843 < 已签 911）。
  **反向验证**：把 `finalizeToolResult` 换成返回空的假实现 ⇒ 14 failed（exit 1）；把 `finalizeToolFailure` 换成假实现 ⇒ 13 failed（exit 1）；还原 ⇒ 全绿。⇒ 搬出的段确实在被用，不是死代码。
  **未做（留在下一轮）**：`consume` 状态机与审批事务段（Lead 明令不碰）；`execute` 仍 578 行，距 300 行的全局阈值尚远，进一步拆分需另立项。
- **步骤 2 的体量代签（Lead 已批准，两笔）**：`apps/admin-api/src/modules/agent/tools/__tests__/tool-executor.service.spec.ts` **1448 → 1493**（+45）—— 唯一贡献是 2 条红→绿 characterization 用例，**删了就没有验收证据**，不接受「为过棘轮删测试」；`apps/admin-api/src/modules/agent/runtime/agent-runtime.service.ts` **986 → 987**（+1）—— 是**共享类型 import**，内联成字面量会把这个形状写两份，**正是本 ADR 要消灭的「两处各自推导」**，所以宁可 +1。回滚值：`1493 → 1448`、`987 → 986`。`execute` 函数体 **676**、`apps/admin-api/src/modules/agent/tools/tool-executor.service.ts` **911**（两者均已回到上一轮已签上限内，**不再加签**）。签名由 W1 写入 `scripts/source-size-baseline.json`。
- 实现现状（R60/R63 后，可作为步骤 4 的起点）：`execute` 入口读一次 `findToolCall` 得 `ledgerRowExists`，`persist` 与 `in_flight` 写入**共用**它；残留 `awaiting_approval` 行由既有的条件写 `settleToolCallByApprovalId` 结清；「声明重放但台账无行」只剩一条 warn，由 `ctx.replayDeclared` 驱动（**不再参与任何写入判定**）。步骤 4/5 仍待立项（`planApprovedReplays` 前移到 `run()` 边界、收敛 14 处 `persist`）。
- 前置：R57 的 `ToolCallLedger` 接缝判定 **blocked**（14 处 `persist` 调用点 + per-call 依赖）。本文是该 blocked 项登记的**重启条件之一**：先做 replay 决策前移，再回来做 ledger 接缝。
- 相关 ADR：[ADR-020](adr-020-agent-boundary-model.md)（边界闸门）、[ADR-026](adr-026-conditional-state-writes.md)（条件化状态写）、[ADR-027](adr-027-test-double-fidelity.md)（替身保真）

## 1. 动机

### 1.1 症状：同一个问题，两处独立推导

「这次工具调用该**新增**一行台账，还是**就地更新**已有的那一行？」——这个问题今天在 `ToolExecutorService.execute` 里被回答了两次，且两次的**判据不同源**：

| # | 位置 | 判据 | 用于 |
|---|---|---|---|
| 决策 ① | `apps/admin-api/src/modules/agent/tools/tool-executor.service.ts:359` → `:366` | `opts.replayApproved === true`（**调用方的口头承诺**） | 14 处 `persist` 写入的 insert/update |
| 决策 ② | `apps/admin-api/src/modules/agent/tools/tool-executor.service.ts:797` | `verdict.approvedApprovalKey && !approvedBySessionGrant`（**闸门回带的票**） | `in_flight` 那一行台账的 insert/update |

两个布尔值在正常路径上恰好同真同假，所以测试一直是绿的；但它们**不是同一个事实**。决策 ② 从未读过 `replayApproved`，决策 ① 也从未读过 `verdict`。

### 1.2 为什么现在抽不出去（R57 blocked 结论的证据复核）

`execute` 是一个 618 行的单函数（`:347`–`:964`），`persist` 闭包在 `:365`–`:387`：

- **14 处调用点**（本轮实测，与 R57 登记的「14 处非 2 处」一致）：`:396 :431 :484 :511 :538 :599 :620 :646 :666 :703 :743 :874 :892 :934`。
- **3 条写路径**在闭包内（`:366`–`:386`）：`recordToolCall` 插入 / `updateToolCallByToolCallId` 就地更新 / `!updated` 时兜底回插。
- **per-call 依赖**：闭包捕获 `replayApproved`（`:359`）、`session.id`、以及每个调用点各自的 `input.toolCallId`。把这三者提到接口签名上，`ToolCallLedger.persist(...)` 就退化成「带状态的 `execute` 别名」——这是 R57 判定停手的直接原因。

结论：**接缝的正确位置不在 `persist`，而在 `persist` 之上**。只要「写哪一行」在 `execute` 入口就已经是一个**数据**（而不是一条 IF 推导），`persist` 的 14 处调用点才可能收敛成同一个形状。

### 1.3 两个失真（R60 已由测试实测证实，不再是静态推断）

**(a) 模型重提已批准调用 ⇒ 在途台账打空。** 模型不服从「请勿重复提交」的提示、用一个**新的** `toolCallId` 重提同一调用时：`approvalKey` 只由 `(sessionId, toolName, 规范化 args)` 决定（`agent-approvals.service.ts:284`），所以审批仍然命中 `granted` ⇒ `verdict.approvedApprovalKey` 非空 ⇒ 进入 `:797` 分支，但该分支的注释写着「原台账行已存在（awaiting_approval），**就地**改成 in_flight」，实际传的是 `call.id`（**新 id**）而不是原行的 `toolCallId` ⇒ `updateToolCallByToolCallId` 命中 0 行、返回 `false`，而 `:800` 的返回值**没有被检查** ⇒ 这次调用**完全没有 in_flight 行**。同一位置 `:782` 的幂等闸也是按新 id 查的，因此对「已批准写调用重提」这一最危险的形态，崩溃窗口的痕迹与幂等保护同时失效。

**(b) 原行永久残留 `awaiting_approval`。** 承 (a)：终局 `persist`（`:934`）走插入（`replayApproved=false`）⇒ 新行落 `ok`，原行停在 `awaiting_approval`。它不会再被重放（其审批行已被 `consume` 成 `consumed`，`agent-runtime.service.ts:1235`–`:1237` 的 `granted` 过滤会排除它），于是这条行**永久**在审计面显示「等待审批」，而对应的审批单早已执行完毕。

这两条都不是并发竞态，是**单线程顺序执行下的确定性失真**——正因如此它们才值得在抽接口之前先修。

### 1.4 另一个已存在的语义差

`persist` 的 update 分支（`:370`–`:384`）写入 `toolName/tier/status/args/result/resultTruncated/errorMessage/durationMs/stateChangedAt`，**不写** `stepId` 与 `approvalId`；insert 分支（`recordToolCall`，`agent-session.service.ts:1946`）两者都写。所以「重放就地更新」与「新调用插入」产出的行**列集不同**。这不是 bug（重放本就该保留原审批单号），但它是「把 insert/update 当两种写入模式」必须显式建模的又一处证据：一个 `mode` 字段就应该同时决定列集与目标行。

### 1.5 证据锚点索引（复核时的定点入口）

| 事实 | 锚点 |
|---|---|
| `replayApproved` 由调用方给出 | `tool-executor.service.ts:359`（签名 `:347`–`:352`） |
| 14 处写入全部经 `persist` | `tool-executor.service.ts:365`–`:387`（闭包体），调用点 `:396 :431 :484 :511 :538 :599 :620 :646 :666 :703 :743 :874 :892 :934` |
| 决策 ② 的判据（**不带** `replayApproved`） | `tool-executor.service.ts:797` |
| 在途行按 `call.id` 更新（可能打空） | `tool-executor.service.ts:800` |
| 审批领取在副作用之前 | `tool-executor.service.ts:725`，副作用 `:834` |
| 重放发生在 `rebuildMessages` 之前 | `agent-runtime.service.ts:556`，`rebuildMessages` `:564` |
| 重放候选来源 + 传旗子 | `agent-runtime.service.ts:1225`（筛选 `:1229`–`:1240`，调用 `:1250`–`:1252`） |

## 2. 方案

### 2.1 目标调用序列

把「这次调用对应台账的哪一行」提前到 `execute` 调用**之前**算出来，作为参数传进去：

```text
run(sessionId)                                          agent-runtime.service.ts:510
  ├─ markRunning CAS（串行边界，保持不变）                :534
  ├─ plans = toolExecutor.planApprovedReplays(session)    ← 新：决策前移到这里
  │    每项 = { call, stepId, ctx }                       （读台账 + 读审批，纯查询，无副作用）
  ├─ for plan of plans → toolExecutor.execute(session, plan.call, plan.stepId, plan.ctx)
  └─ rebuildMessages()                                    :564（必须在重放之后，保持不变）
```

`execute` 内部：

```text
execute(session, call, stepId, ctx)                      :347
  ├─ const ledger = ctx.ledger                           ← 唯一判据，不再有 IF 推导
  ├─ persist(...) ×14  →  读 ledger.mode                  :366 → :370（目标行 = ledger.toolCallId）
  ├─ consume(...)                                          :725（位置与原子性不变）
  ├─ in_flight 写入  →  读同一个 ledger.mode              :797 / :809（决策 ② 消失）
  └─ 终局 persist     →  读同一个 ledger.mode              :874 / :892 / :934
```

**决策 ① 与 ② 收敛为同一个值**：`ctx.ledger`。它由 `planApprovedReplays`（或新调用路径的构造器）在进入 `execute` 之前从**库里的行**推出来，而不是从任何一方口头承诺推出来。

### 2.2 per-call 上下文对象的形状与字段来源

```ts
/** 台账写入目标——execute 内部**唯一**允许的 insert/update 判据。 */
type LedgerTarget =
  | { mode: "insert" }
  | {
      mode: "update";
      /** 要更新的那一行（可能 ≠ 本次 call.id，见 §1.3(a)）。 */
      toolCallId: string;
      /** 原行上的审批单号；update 模式保留，insert 模式为 null。 */
      approvalId: string | null;
    };

/** 重放票据：非 null 表示「已批准待执行」的确定性重放。 */
interface ReplayTicket {
  approvalKey: string;
  approvalId: string;
  /** once = 进 execute 后被 consume；session = 常驻授权，永不 consume。 */
  scope: "once" | "session";
}

/** 一次工具调用的全部 per-call 输入。签名的**唯一**新增参数。 */
interface ToolCallContext {
  /** 逻辑标识：新调用 = call.id；重放 = 台账行的 toolCallId。 */
  toolCallId: string;
  /** 本步 id：新调用来自 run 循环；重放来自台账行。 */
  stepId: string | null;
  ledger: LedgerTarget;
  replay: ReplayTicket | null;
}
```

字段来源（全部**只查库、不猜**）：

| 字段 | 新调用（run 循环 `:1305`） | 重放（`replayApprovedToolCalls` `:1225`） |
|---|---|---|
| `toolCallId` | `call.id`（LLM 生成） | `row.toolCallId`（`:1242`） |
| `stepId` | 循环当前的 step id | `row.stepId`（`:1250` 现在就是这么传的） |
| `ledger.mode` | `findToolCall(sessionId, call.id)` 命中 ⇒ `update`，否则 `insert` | 恒 `update`（台账行**就是**重放候选的来源） |
| `ledger.approvalId` | 命中行的 `approvalId` | `row.approvalId` |
| `replay` | `null` | `{ approvalKey: row.approvalId, approvalId, scope }` |

**不变量 I1（本 ADR 的核心）**：`ledger.mode` 由「台账里**是否已有**这个 `toolCallId` 的行」唯一决定，与「这是不是重放」**解耦**。重放 ⇒ 必然 `update`；但 `update` ⇏ 重放（模型重提已批准调用同样是 update）。今天 `:797` 违反 I1（它用「有没有票」代替「有没有行」），这就是 §1.3 两个失真的根因。

**不变量 I2（不许动）**：`consume` 必须留在 `execute` 内部、闸门之后、副作用之前（`:725`），不得随决策一起前移。前移的只有「写哪一行台账」这个**纯数据决策**；审批领取是**带原子性的副作用**，与它挨着的那行 `in_flight` 才是它的事务邻居。

## 3. 影响面

### 3.1 可能变的行为（都必须有测试钉住）

1. **模型重提已批准调用**（§1.3 a/b）：由「在途行打空 + 原行残留」变为「in_flight 与终局都落在原行」。这是**修缺陷**，不是回归；但「新工具调用新增一行」的既有语义必须逐字不变（`tool-executor.service.spec.ts:1175` 那条 `非重放路径仍走 insert`）。
2. **`priorCall` 幂等闸（`:782`）的命中率上升**：同一 `toolCallId` 的 `in_flight` 行现在真的存在了 ⇒ 崩溃重启后「结果未知，先核实」这条保护对已批准调用**才生效**。这是正向变化，但会让 `agent-runtime.service.spec.ts` 里任何假设「重放后无 in_flight 行」的桩需要复核。
3. **`totalToolCalls` 计数**：`recordToolCall` 会自增（`agent-session.service.ts:1986`–`:1993`），`updateToolCallByToolCallId` 不会。若 (a) 被修好，重提场景的自增次数从 1 降到 0 ⇒ 审批重放**不再吃速率预算**（与 `recordToolCall` 头注里「awaiting_approval 仍要计」的口径需要重新对齐一次，见步骤 3 的判据）。
4. **审批消费与 replay 的顺序**：**不变**。`consume` 仍在一处（`:725`），仍早于副作用（`:834`），仍由 `markRunning` 的 CAS（`:534`）保证单 worker 串行。本 ADR 明确**不**把 consume 提出来——那会把「原子领取」拆成「先查后领」，正是 TOCTOU 的原形。

### 3.2 失效半径

- **横向**：单会话单 worker（`markRunning` CAS，`:534`）⇒ 判错的影响**不跨会话**，也不会跨实例。
- **判错为 `insert` 而实际有行** ⇒ 撞 `(sessionId, toolCallId)` 唯一索引（GAP-5）⇒ 调用失败、**零副作用**（fail-closed 方向正确）。
- **判错为 `update` 而实际无行** ⇒ 更新 0 行。保留 `:386` 的兜底回插，最坏是「多一行台账」，审计完整、副作用仍只执行一次。
- **结论**：失效半径上界是**台账失真**，不触及「副作用执行次数」。这是选择「先修台账决策、后抽接口」的理由之一。
- **改动文件面**（预计）：`tool-executor.service.ts`、`agent-runtime.service.ts`（`:1225` 一带 + `:1305` 一带），以及两个 spec。**不改** `agent-approvals.service.ts`、**不改** `agent-boundary.service.ts`、**不改**表结构、**不改**事件契约。

### 3.3 不该变的东西（护栏）

- 闸门六道检查的判定与顺序（`agent-boundary.service.ts:182`–`:332`）。
- 审批键/参数摘要的口径（`buildKey` `:284`、`computeApprovalArgsDigest` `:899`）。
- 重放必须发生在 `rebuildMessages()` 之前（`agent-runtime.service.ts:551`–`:556` 的注释是契约，不是建议）。
- `denied` 行不计入 `totalToolCalls` 的口径（`agent-session.service.ts:1976`–`:1986`）。

## 4. 回滚路径

1. **单步回滚**：分步计划里每步一个 commit、且**不含 schema 变更**，`git revert <sha>` 即回到上一步，无需迁移、无需数据修复。（本轮已登记的基线回滚点 = `c535085d`。）
2. **语义回滚（跨步骤）**：步骤 4/5 引入双轨，用开关 `AGENT_REPLAY_CTX_HOIST`（默认 `false` = 老路径逐字不变）。回滚顺序是 **先关开关 → 观察一轮 → 再 revert**，而不是直接 revert——开关能让生产行为在**秒级**回到旧语义，revert 只是收拾代码。
3. **开关的合规前置**：新增 env 开关必须过 `check:env-switch-default-policy` 与 `check:env-entry-sweep`（`scripts/**`，**不由本 worker 改**，见附录 B）。
4. **不需要数据回滚**：不改表、不改事件 payload、不改唯一索引 ⇒ 没有「回滚后存量数据不兼容」这一类问题。

## 5. 分步计划

每步独立可验证、独立可回退。步骤 1–3 在本 worker 的写域（`apps/admin-api/**`）内即可完成；4–5 跨轮。

### 步骤 1 · 钉住现状，并做最小修复（R60 已落地）

- **实际做法**（与初稿计划的偏差，如实记录）：测试**没有**单开新文件，而是并入既有的 `…/agent/tools/__tests__/tool-executor.service.spec.ts` —— 只有那里能复用 `harness()`；新文件意味着把 170 行替身复制一遍（ADR-027 的复制式漂移风险远大于「基线涨 78 行」这件事）。新增 `describe("ToolExecutorService · 已批准调用被重提（R60 台账写入自洽）")` 4 例。
- **做**：先用 characterization test 复现「已批准调用被**新 `toolCallId`** 重提」三种后果（旧实现在这三条上必须红）：
  ① 本次执行**没有** `in_flight` 行（`recordToolCall` 从未以该状态被调用）；
  ② 对一行**不存在**的记录发起了就地更新（0 行更新被静默吞掉）；
  ③ 原 `awaiting_approval` 行**没有**被结清。
  再用**最小修复**让三者同时成立（详见本文开头的「实现现状」）：`ledgerRowExists` 单判据 + 0 行补偿 + 条件写结清。
- **红→绿判据**（机读，实跑记录）：`cd apps/admin-api && npm test -- --testPathPatterns "tool-executor.service" -t "R60 台账写入自洽"` ⇒ 修复前 **3 failed / 1 passed / exit 1**，修复后 **4 passed / exit 0**；反向验证（把源码回退、只留测试）⇒ 再次 **3 failed / exit 1**。
- **若失败如何退**：若旧实现本来就是绿的 ⇒ **§1.3 的静态推断不成立**，立刻停手、只交勘察结论；**不许**改生产代码去凑绿。（本轮未触发这条退路：旧实现确实红。）
- **替身保真副作用（须知）**：修复新增了一次协作方法调用 `settleToolCallByApprovalId`，同批修了 `create-task-from-template.approval.spec.ts` 的替身（缺该方法 ⇒ 真调用时 `is not a function`，正是 ADR-027 记的那类事故形态）。
- **体量代价**：`tool-executor.service.ts` 非注释行 876→911、`execute` 函数体 619→678；spec 1370→1448 ⇒ 需 Lead 代签 `scripts/source-size-baseline.json`（回滚值 876/619/1370）。

### 步骤 2 · 引入纯函数判据（等价重构，行为零变化）

- **做**：新增 `ledgerTargetFor(sessionId, callId, existingRow)` 纯函数与 §2.2 的类型；`execute` 内部用它替换 `:366` 的 `!replayApproved || !input.toolCallId` 推导（此时 `opts.replayApproved` 仍在，但只用于**构造** `ledgerTarget`，不再直接参与写入判定）。
- **红→绿判据**：`npm test -- --testPathPatterns "tool-executor.service"` 全绿（`:1146`「replayApproved：更新原台账行」与 `:1175`「非重放路径仍走 insert」两条是红线，一条都不许改）；新增纯函数单测覆盖 4 组合（`insert/update` × `toolCallId` 有/无）全绿。
- **若失败如何退**：单 commit revert（纯函数此时无其它调用方）。

### 步骤 3 · 消灭决策 ②（`in_flight` 改读同一判据）

- **做**：`:797` 分支改读 `ctx.ledger.mode`，并按 `ledger.toolCallId` 写（而不是 `call.id`）；**检查** `updateToolCallByToolCallId` 的返回值，为 `false` 时显式回插 + `logger.warn`（复用 `:386` 的兜底语义，不新增写路径种类）。
- **红→绿判据**：把步骤 1 的两条断言**反转**（`updateToolCallByToolCallId` 必须收到**原行 id**；`recordToolCall` 只被调用 **1** 次）——反转后的测试在改前**红**、改后**绿**；再跑 `npm test -- --testPathPatterns "tool-executor.service"` 全绿。若反转前就是绿 ⇒ 步骤 1 建错了，停。
- **若失败如何退**：revert 该 commit，同时把断言反转回步骤 1 的形态（同一 commit 内成对修改，不允许出现「断言已反转、代码未改」的中间态提交）。

### 步骤 4 · 决策前移到 `run()` 边界（双轨）

- **做**：新增 `planApprovedReplays(session)`（把 `agent-runtime.service.ts:1225` 的候选筛选 + ctx 构造搬进去，**返回计划不执行**）；`replayApprovedToolCalls` 退化为「拿计划 → 逐个 `execute`」；`execute` 接受 `ctx`，`opts.replayApproved` 作为兼容层翻译成 `ctx`；开关 `AGENT_REPLAY_CTX_HOIST` 默认 `false`。
- **红→绿判据**：`npm test -- --testPathPatterns "agent-runtime.service"` 全绿，且重放用例（`:2133`）的四条断言**全部保留**——只允许把第 4 个参数（`{ replayApproved: true }`）的形状断言改成 `ctx` 形状，**不允许删断言**（尤其是 `:2168` 的「重放早于第一次 LLM 调用」）。开关 off 时该用例再跑一遍必须逐字等价。
- **若失败如何退**：关 `AGENT_REPLAY_CTX_HOIST`（秒级回旧行为）→ 观察 → revert。

### 步骤 5 · 收口（ledger 接缝的重启条件达成）

- **做**：删 `opts.replayApproved`、删 `:797` 的第二推导、`persist` 的 14 处调用点改为构造 `RecordToolCallInput` 由统一的 `ledger` 决定落点。
- **红→绿判据**：`codegraph callers replayApproved` 返回 **0** 处；`npm test -- --testPathPatterns "tool-executor|agent-runtime|agent-approvals"` 全绿；`npm test -- --testPathPatterns "replay-context"`（反转后形态）全绿。
- **若失败如何退**：`git revert` 步骤 3–5 的三个 commit（台账写入口回到「两判据」状态，行为与 R59 前逐字一致）。
- **收口之后**：`ToolCallLedger` 接口才可抽——那时 `persist` 需要的全部 per-call 输入都是 `ToolCallContext` 的字段，接口签名里不再出现散落的 `sessionId/toolCallId/replayApproved`。

## 6. 明确不做

- **本轮不写业务代码**：`apps/admin-api/src/**` 零改动。本文交付的是设计 + 勘察 + 一条文档守卫命令。
- **不抽 `ToolCallLedger` 接口**：那是步骤 5 之后的一轮（本 ADR 只为它清障）。
- **不动 `consume` 的位置与原子性**（不变量 I2）；不动审批单表结构、不动锚点事件契约。
- **不改 `scripts/**`**：所有新增守卫（含附录 A 的接线）需 Lead 代签或 W1 落地，见附录 B。
- **不重查 §1.2 的语义结论**（14 处 / 3 条写路径 / per-call 依赖），按前序轮次结论直接采用，本轮只做**实测复核**（本轮实测仍为 14 处）。

## 7. 替代方案（被否）

- **方案 A：把 `sessionId / toolCallId / replayApproved` 塞进 `ToolCallLedger` 接口。** 前轮已否：接口退化成「带状态的 `execute` 别名」，14 处调用点每处都要知道自己的 per-call 变量，抽象收益为负。
- **方案 B：让 `persist` 自己查台账判断 insert/update。** 否：每次写入多一次 SELECT（14 处 ⇒ 最多 14 次额外读）；且在 `in_flight` 写与终局写之间行可能被保留期清理 ⇒ 判据会在同一次调用内**抖动**；更糟的是把决策藏进最深层——今天 `:797` 的问题正是这么长出来的。
- **方案 C：只用 `opts.replayApproved` 单判据（把 `:797` 改成读它）。** 否：`replayApproved` 是**调用方的口头承诺**，而「台账里有没有这行」是**库里的事实**。模型重提路径根本不带这个旗子，改完会让已批准调用重新插行并把原行永久留在 `awaiting_approval`（§1.3 b 原样保留）。

## 8. 关联

- 计划项：R57 `persist` 接缝 blocked 的重启条件（replay 决策前移 + per-call 上下文对象）、TOOLS-02（确定性重放）、GAP-5（`(sessionId, toolCallId)` 唯一索引）、A1 审批闭环（实施轮 #12 申请侧 / #14 执行侧）、S1-C2（会话级同参免审）、C2（`stateChangedAt`）、N3（策略指纹 fail-closed）
- 相关 ADR：[ADR-020](adr-020-agent-boundary-model.md) · [ADR-026](adr-026-conditional-state-writes.md) · [ADR-027](adr-027-test-double-fidelity.md)
- 既有测试锚点：`apps/admin-api/src/modules/agent/tools/__tests__/tool-executor.service.spec.ts:1146`、`:1175`；`apps/admin-api/src/modules/agent/runtime/agent-runtime.service.spec.ts:2133`、`:2166`、`:2168`

---

## 附录 A · 一次性校验命令（本 ADR 的机器判据）

`scripts/**` 不在本 worker 写域，因此**不新增守卫脚本**；下面是等价的临时判据，已实跑并记录真实退出码。建议 Lead 把同一组断言接进 `scripts/docs/check-docs.mjs`（见附录 B）。

**现状（红）** —— ADR 文件不存在时：

```text
FAIL
- ADR 文件不存在: docs/adr/adr-031-replay-decision-hoist.md
EXIT=1
```

**写完后（绿）** —— 同一命令，退出码 0：

```text
OK: ADR-031 结构断言全通过（小节 6 项 + 状态行 + 证据锚点 + README 索引）
EXIT=0
```

**回归面（`test:docs`）** —— 本 ADR 落入既有文档守卫的判据面，实跑 `npm run test:docs` ⇒ `EXIT=0`（`check-docs` 的死链/孤儿/裸路径 + `check-doc-style` 的单 H1/层级/围栏语言全绿）。落地过程中被它抓到的两条真问题，记在这里供后续 ADR 作者省一轮：

1. **正文裸路径指针**：写了尚不存在的未来文件名（`…/__tests__/replay-context.spec.ts`）⇒ 该守卫要求裸路径必须指向真实文件。写法约定：未来文件用省略号形态（含 `…`）或改为不带路径的描述。
2. **代码围栏必须标语言**：ADR 同样受约束（含 `\`\`\`text`）；`check-docs` 头注里「ADR 裸围栏不再豁免」的用例正是这条。

命令（自仓库根执行，零依赖，秒级）：

```bash
node -e '
const fs=require("fs");
const p="docs/adr/adr-031-replay-decision-hoist.md";
const req=["动机","方案","影响面","回滚","分步计划","明确不做"];
let errs=[];
if(!fs.existsSync(p)){ errs.push("ADR 文件不存在: "+p); }
else {
  const t=fs.readFileSync(p,"utf8");
  const heads=t.split("\n").filter(l=>/^##\s/.test(l));
  for(const k of req){ if(!heads.some(h=>h.includes(k))) errs.push("缺少小节: "+k); }
  if(!/^状态：Proposed/m.test(t)) errs.push("状态行缺失或不是 Proposed");
  const anchors=(t.match(/tool-executor\.service\.ts:\d+/g)||[]).length;
  if(anchors<3) errs.push("证据锚点(tool-executor.service.ts:NNN)不足 3 处，实际 "+anchors);
  const idx=fs.readFileSync("docs/adr/README.md","utf8");
  const hit=(idx.match(/\[ADR-031\]\(adr-031-replay-decision-hoist\.md\)/g)||[]).length;
  if(hit!==1) errs.push("README 索引 ADR-031 行出现 "+hit+" 次（要求恰好 1 次）");
}
if(errs.length){ console.error("FAIL\n- "+errs.join("\n- ")); process.exit(1); }
console.log("OK: ADR-031 结构断言全通过（小节 " + req.length + " 项 + 状态行 + 证据锚点 + README 索引）");
'
```

断言清单（六条，缺一即红）：

| # | 断言 | 为什么它是判据而不是装饰 |
|---|---|---|
| 1 | ADR 文件存在 | 「写了 ADR」与「没写」的唯一区别 |
| 2 | 六个 `##` 小节各含 动机/方案/影响面/回滚/分步计划/明确不做 | 缺「回滚」的 ADR 只是一份提案；缺「明确不做」的 ADR 会在评审时被默认可扩 |
| 3 | `状态：Proposed` 行存在 | 防止本文被当成 Accepted 而被引用为现行契约 |
| 4 | `tool-executor.service.ts:NNN` 锚点 ≥ 3 | **防「无证据的架构文」**：所有断言都必须可回到具体行 |
| 5 | README 索引恰好 1 行 | 防「文件在、没人找得到」与「重复登记」两种腐烂 |
| 6 | 全部通过才 exit 0 | 判据必须是退出码，不能是人眼读输出 |

## 附录 B · 建议的守卫接线（需 Lead / W1 落地，本 worker 不改 `scripts/**`）

1. **接进 `scripts/docs/check-docs.mjs`**：把附录 A 的六条断言作为该守卫的一个 section，并补 `--selftest` 用例（**必须含反例**：把 ADR 里 `## 4. 回滚路径` 删掉 ⇒ 必须红；把 README 索引行删掉 ⇒ 必须红）。只加正例的守卫在仓库里有前科（见 `check:docs` 头注的「自检写了但没接线」）。
2. **`check:guards-wired`**：新守卫有 `--selftest` 就必须同时进本地门禁与 CI（`test:docs` 已在 `test:guards:chain` 里，若并入 `check-docs.mjs` 则自动满足）。
3. **`scripts/source-size-baseline.json`**：本 ADR **不需要**代签——本轮零源码改动。后续步骤 2/3/5 会改 `tool-executor.service.ts`（当前 1435 行）：若届时该文件在体量棘轮里，按「只减不增」规则，**拆函数会降行数**，只会是回滚值下调方向；需要 Lead 代签时回执会单独写明 `文件 X 1435→N（回滚值 1435）`。
