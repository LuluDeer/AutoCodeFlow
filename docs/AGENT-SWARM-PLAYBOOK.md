# 多 Agent 审计-修复循环（可复用编排）

> 面向「同一时刻至多 5 个子 Agent，持续对仓库做全方位优化/改造/修复」的
> **可复用流水线**。不是一次性报告：每次循环都按同一套域划分、写冲突规则与
> 验证矩阵执行，产出可提交的 commit，并把未修项登记回本文 §7 的 backlog。

最后核对：2026-11-05（最近一轮：R18 —— 展示口径钳底完成；协议层并发骨架已验、卡在造执行行，见 §7.17）

---

## 1. 为什么需要编排而不是「想到哪改到哪」

单 Agent 连续改代码有三个真实退化（本项目都踩过）：

1. **视野偏移**：注意力被最近一次提交吸引，长期缺口（SOP 工具从不下发）
   因为「不在当前文件里」而永远不被发现。
2. **测试锁定 bug**：既有测试会把错误行为写成期望（`availableTools` 的
   「内部工具经运行时另行注入」注释），单 Agent 顺着测试走就会继续错。
3. **证据不可复核**：没有「文件:行号 + 触发路径 + 为什么」的固定格式，
   结论无法被第二个人验证，也无法在代码重排后重新定位。

并行审计解决 1；固定判定标准与证据格式解决 2/3；**写域不重叠**解决并发
编辑冲突；**验证矩阵**解决「改完不知道有没有真的生效」。

---

## 2. 并发与写冲突规则（硬约束）

- **同一时刻 ≤ 5 个子 Agent**（用户约束，也是上下文与验证成本的上限）。
  - 2026-10-30 实测（实施轮 #18）：运行时**活跃子代理硬上限是 8**，不是调用方想要的
    10——一次性 `parallel()` 起 10 路时第 9 个直接抛 `subagent limit reached`，且整个
    脚本失败（已起的 8 个也作废）。要超过 5 路必须用**池化**：`pool(items, N, fn)`
    让每个 worker 循环取下一个任务，N ≤ 8。另：单次返回体过大会被截断（首波 10 域
    只剩 6 域），域数 > 6 时建议分批，或让子 Agent 把报告写到文件再回传路径。
- **审计阶段全部只读**：允许 grep/read/codegraph/单文件 jest，禁止编辑与
  git 写操作。5 路并行零冲突。
- **实现阶段一个域一个 writer**：域内文件归该 writer，跨域改动（实体 +
  迁移 + 前端 + 文档）由主会话合并，或拆成串行批次。
- 子 Agent 的任务指令必须显式包含：仓库绝对路径、CodeGraph 优先规则、
  「禁止编辑」或「只准改这些文件」、验证命令、输出 schema。**不要假设
  子 Agent 会自己读 AGENTS.md**。
- 子 Agent 报告与主会话结论冲突时，以**当前工作区代码**为准；审计报告
  里过期的 finding 直接丢弃（首轮就有一条：GAP-3 的 finish(failed) 缺陷
  在报告生成时已被修掉）。

---

## 3. 五个域（固定划分，按依赖而非按目录）

| id | 名称 | 主路径 | 关注点 |
|---|---|---|---|
| `runtime` | 中台推理循环与状态机 | `apps/admin-api/src/modules/agent/runtime/`、`entities/`、`agent.controller.ts` | 幂等/可恢复/双跑/预算/重试/状态迁移 |
| `tools` | 工具执行与边界安全 | `modules/agent/tools/`、`boundary/`、审批服务 | 白名单与下发一致性、scope、审批闭环、脱敏、超时副作用 |
| `desktop` | 桌面执行器 Agent | `apps/executor-desktop/src/agent/`、`main/`、`agent-worker/` | 协议、journal、崩溃恢复、沙箱、预算计数 |
| `data` | 数据完整性/迁移/队列/多实例 | `src/migrations/`、`entities/`、retention、outbox | 约束、索引、保留期、跨副本语义 |
| `obs` | 观测/前端/文档真实性 | `admin-web` Agent 页面、`metrics/`、ADR 与文档 | 指标失真、UI 无入口、文档与实现相反 |

域之间刻意**允许重叠引用**（例如 tools 会读到 runtime 的重放逻辑），但
**写域不重叠**。首轮实测：5 个域共 27 条 finding，其中 6 条 P1。

---

## 4. 循环的六个阶段

```text
S0 取证     git status / codegraph status / 最近提交 / 未提交工作区是否编译
S1 审计     5 路只读并行（workflow: agent-domain-audit）
S2 排序     按「真缺陷」标准过滤；P1 优先；同根因合并；丢弃过期事实
S3 实现     主会话或单 writer 子 Agent；每项先写失败用例再修
S4 验证     分层：单文件 jest → 模块 jest → tsc → eslint → 守卫脚本 → 全量
S5 提交     一个提交一组同根因修复；提交信息写「为什么」与反证方式
S6 落档     未修项登记 §7 backlog；更新 AGENT_HANDOFF 状态快照
```

### S1 的可复用 workflow 脚本（DSH `workflow` 工具）

脚本体由 `args.domains` 驱动，域表即 §3。核心片段：

```js
const results = await parallel(
  args.domains.map((d) => () =>
    agent(promptFor(d), {
      label: `audit:${d.id}`,
      phase: "audit",
      schema: findingsSchema, // findings[] + summary
    }),
  ),
);
return { audits: results.map((r, i) => ({ domain: args.domains[i].id, ...(r ?? {}) })) };
```

`promptFor(d)` 必须包含这些硬要求（首轮证明有效的部分）：

- 只读；审计范围 = 给定路径及其依赖；
- 先 CodeGraph（MCP `codegraph_explore`，退化 `codegraph explore`），
  再 grep/read；参考实现在 `/home/yongsheng/project/langgraph`、
  `/home/yongsheng/project/langchain`（引真实文件，不凭记忆）；
- 只报**能在真实调用路径上产生错误行为**的缺陷；必须给
  `文件:行号 + 逐字代码 + 触发路径 + 现有测试是否覆盖 + 最小修法 + 风险 + 测试`；
- 已修过的 GAP-1/2/5 不要重复报；工作区未提交的半成品要当作可疑对象审；
- 最多 6 条，按 P1/P2/P3 排序；没有真缺陷就返回空数组并说明验证了什么。

### S2 的判定标准（比「找到问题」更重要）

一条 finding 只有同时满足下面四条才进入实现队列：

1. 有**真实触发路径**（谁调用到它、什么输入/时序触发）；
2. 后果是错误行为（数据不一致、静默 no-op、语义与注释相反、安全绕过、
   泄漏、双跑、不可恢复、观测失真），不是风格/命名/「可以更好」；
3. 现有测试**没有**正确覆盖该行为（若测试覆盖了但行为仍错，说明测试
   把 bug 钉成了期望——这类优先修，并同时改测试）；
4. 修复方案能说清「改哪个判据/状态迁移/索引」，且不引入新的无界循环。

---

## 5. 验证矩阵（按改动面选，不许跳级）

| 改动 | 最小验证 |
|---|---|
| 单模块逻辑 | 该文件的 spec（先红后绿）+ `npx tsc -p tsconfig.json --noEmit` |
| 跨模块/状态机 | `jest src/modules/agent`（整模块）+ 三个 agent 守卫脚本 |
| 实体/迁移 | `check-migrations.mjs`（时间戳注册）+ 迁移 spec + 全量 jest |
| 队列/装配 | 抽出纯函数（如 job options）用 `validateOptions` 规则单测 + 装配级用例 |
| 守卫/脚本 | **它所在 CI job 的完整命令序列**（只跑自建守卫会假绿——本项目踩过两次） |
| 文档 | `node scripts/docs/check-docs.mjs`（4 条判据：死链 / 孤儿 / 根目录洁癖 / 正文裸路径） |

本项目命令要点：

```bash
cd apps/admin-api && npx --node-options=--experimental-vm-modules jest <path> --silent
node scripts/check-migrations.mjs
node scripts/check-conditional-writes.mjs   # ADR-026 条件写
node scripts/agent-runtime-check.mjs && node scripts/agent-boundary-check.mjs
node scripts/agent-trigger-check.mjs && node scripts/agent-sop-check.mjs
```

> `npx jest` 直接跑会报 `Must use import to load ES Module: @nestjs/common`
> （Node 24 + ESM 解析），必须带 `--node-options=--experimental-vm-modules`
> 或走 `npm test`。这是环境事实，不是代码缺陷。

---

## 6. 反模式清单（首轮实际踩到/差点踩到）

| 反模式 | 真实案例 | 防线 |
|---|---|---|
| 测试把 bug 钉成期望 | `availableTools` 断言「内部 SOP 工具不发」并注释「另行注入」（该通道不存在） | 修 bug 必须同时改断言，并在提交信息里点名 |
| 替身与生产契约漂移 | GAP-1 把 `markRunning` 改成返回 boolean，脚本替身仍返回 undefined → 守卫整段红 | ADR-027：替身实现同一契约；守卫脚本纳入改动面 |
| 只在单测注入，装配层零覆盖 | GAP-3 的 jobId 含单冒号被 BullMQ 拒绝，5 条单测全用 `jest.fn` 冒充入队口 | 把易错的选项/规则抽成纯函数并单测真实规则 |
| 「落终态再排补跑」 | failed 是终态，delayed job 回来被 `run()` 短路 = 静默 no-op | 可恢复性必须落在**非终态**上；用 CAS 消费唤醒凭据 |
| 固定 jobId + 保留 completed job | 同 id 再次 add 命中已完成 job，静默 no-op | `removeOnComplete: true`，且 id 不含 `:`（BullMQ 规则） |
| 阈值为默认值 | 清扫 30min = 墙钟 30min ⇒ 恢复必然立刻超时 | 阈值与预算的不变量要显式校验，恢复语义要单独设计 |
| 报过期事实 | 审计期间工作区被并发修改，首版缺陷已被修 | S2 以当前代码为准；行号+md5 只作定位参考 |

---

## 7. 2026-10-29 首轮 backlog（未修项，按优先级）

> **R33 复核（2026-11-05，基线 `1f21e386`）**：本节（§7.1–§7.22）共 **82** 条。**3 条已被 HEAD 推翻**（`doc-guard` / `guards-chain-native-accounting` / `guard-chain-fail-no-segment`，已就地标注并附命令证据）、**7 条仍成立且已补证据**、**72 条 `unverified@1f21e386`**（建议型条目待裁定 / 需真机 / 需逐条读实现 —— 按「**无证据不删**」保留原文）。逐条编号与原句留痕见 `artifacts/autonomy/R33/before.md`。**对账闭合：82 = 3 + 7 + 72。**

### 7.0-现状（**R131 刷新** · **7 行：4 条未修 + 3 条 resolved 留痕**）

> 口径：只放**今天仍然成立**的未修项。已被 HEAD 推翻或已钉成守卫的历史条目不再跟踪（原文留在 §7-A 与各轮 artifacts）。
> **R116 → R121 变更**：
> ① `r18b-protocol-heartbeat-dispatch` **resolved（含 oracle 闭合）** —— 产品侧 R108/R111 已闭合，
> harness 侧 R120 收口（那 1/10 违反是 **harness 自己删行**造成的记账假象，`bbe9da50`，20 轮 0 违反）；
> ② `r18b-harness-model-a` **resolved** —— 同一提交把「容量不足即删行」改为「保留行置 `pending`」
> 并对齐生产，故原「harness 用模型 A」的表征已消失；
> ③ **新增** `adr-038-broadcast-occupancy` = **needs-implementation**（ADR-038 只出设计，步骤 1 判据已定稿：
> **J2 才是真判据，J1 绿不触发否决**）；
> ④ `web-flake-not-reproduced` 仍为「推进一格」（B1+C1 下 2/2 绿、三口径浮空 0）。
> **R127 变更**：`adr-038-broadcast-occupancy` **needs-implementation → resolved**（步骤 1–4 全完成，ADR 标 Accepted（已实现））；
> 另：`optional-dep-silent-noop` 守卫已落地（链 99→100，**不入 backlog**，记入已结项）。
> **R131 变更**：`adr-038-broadcast-occupancy` 由「R125 收口」细化为 **步骤 1–5 全部完成**（ADR 状态行已标「已实现，步骤 1–5 全部完成」）；其余四条保持。

| # | id | 状态 | 为什么还没修 / 重启条件 |
|---|---|---|---|
| 1 | `r18b-protocol-heartbeat-dispatch` | **resolved（含 oracle 闭合）** | 曾 `blocked` 约 40 轮。R106 复现为**活缺陷**（harness 20/20 违反 I1）⇒ R108 收敛为**单条原子 UPDATE**（ADR-037，`8f25b481`）⇒ R111 §5b 定性**生产属模型 B、无残窗、不需要加锁**（`121a7f77`）⇒ **R120 oracle 闭合**：残余的 1/10 违反经 dump 定位为 **harness 在失败路径删行**的记账假象（真 PG 反向对照证「删行必然破不变量」），改为**保留行置 `pending` + 区分 `rowsAtSnapshot`/`inFlight`** ⇒ **20 轮 0 违反**，两条降级缝仍能打红（6/6、4/4）（`bbe9da50`）。方案 B（永久饥饿 I2）与方案 C（窗口生产不可达、且合并事务反而**打开**该窗口）均被否 |
| 2 | `execute-further-slimming` | **needs-adr** | `execute` 已瘦到 **503** 行且步骤 4 到了安全边界（事务边界不跨函数）；再瘦身**需要事务设计 ADR**，不能靠搬代码 |
| 3 | `ci-pg-race-unverified` | **unverified** | 真机 PG 并发自检已接 CI 与链（`npm run test:pg-race`，链第 98 段），本地只能验「无 PG ⇒ SKIP」与「有 PG ⇒ 2/2 通过」；**CI 真跑本地无法验证** |
| 4 | `web-flake-not-reproduced` | **unverified（推进一格）** | **B1（test 级判红）+ C1（`afterAll` 收窄窗口）生效后 2/2 全量绿、三口径浮空报文 0** ⇒ 不再是「可能被静默吞掉」。但 **R53 那次 `exit 1` 且 `passed=—`（无汇总行）指向的「进程中途被杀」未排除**，且当时 `signal` 未记录（R91 才补）⇒ 只推进一格，不等于根因定位 |
| 5 | `r18b-harness-model-a` | **resolved**（R120） | 曾登记为「harness 用模型 A ⇒ 测生产不可达路径」。R120 的修法**把表征消掉了**：容量不足时**保留行置 `pending`**（不再删行，与生产「先提交行、再占坑」同形）+ 判据改用 `rowsAtSnapshot`。**注意**：不变量 `计数 ≤ 非终态行数` 仍**只对单播成立**（广播扇出是设计固有破裂 → 第 6 条）。证据 `bbe9da50` |
| 6 | `adr-038-broadcast-occupancy` | **resolved**（步骤 1–5 全完成） | 广播扇出占坑与心跳下限**同列冲突**（`:6034` 每台 +1 / `:5852-5855` 占用标记只落一个地址 ⇒ `counter=1/rows=0`；`:6022-6025` 依赖「少计靠心跳覆写」，与 R108「不得改小」相反）。**方案 B 已实施**：步骤 1 判据（`5ac4b812`，J1 量错对象 ⇒ J2 才是真判据）→ 步骤 2 加列 `broadcastReservedCount` + 真库跑 `down` 证明零回填（`5351e3e5`）→ 步骤 3 写路径 + 两处容量谓词改「两列之和」+ J2 转绿（`784b0373`，**J2 首版假绿已补强**）→ 步骤 4 N=3 对账含重复回调 + DTO 不暴露 + **剩余风险只观察不写脚本**（`a18cde1c`/`a7ed1a3d`）。步骤 5 文档/展示已完成 ⇒ ADR 状态行标 **Accepted（已实现，步骤 1–5 全部完成）**；运维口径落在 `docs/operations.md:1635` |
| 7 | `release-notice-ops` | **needs-ops** | 发版公告已写（`docs/RELEASE-NOTES-ssrf-posture.md`），**发布动作属运维**，不在自治循环范围内 |

### 7.0 主表（R35 消化后 · **0 条**）

口径：只有 `needs-reading@sha` 留在主表。**R35 已把 R34 遗留的 5 条逐条判完，主表清空**：

| # | id | 轮次 | 四选一结论 | 证据（命令 / `文件:行号`） |
|---|---|---|---|---|
| 1 | `diff-card-inline-columns` | §7.1 | **仅设计说明** → §7-A `proposal` | `grep tokenHash apps/admin-web/src/pages/ExecutorDetailPage.tsx` ⇒ **0 命中**（服务端密列从不进 web）⇒ 卡片内联哪 3 列是**展示选择**，不是缺陷 |
| 2 | `iana-special-purpose-sweep` | §7.8 | **已被 HEAD 推翻** | `apps/admin-api/src/common/utils/safe-http.util.ts:666-669` 已有 `192.0.0.192` 处理 + `192.0.0.0/24`（RFC 7335 全 False）整段说明 ⇒ 剩余地址无需改 |
| 3 | `release-path-race` | §7.15 | **已被 HEAD 推翻** | `apps/admin-api/src/modules/executor/heartbeat-count.util.ts:21` `resolveHeartbeatRunningTaskCount`（R16 取大修法）已覆盖"释放后仍不低于在途"的形态 |
| 4 | `running-minus-reserved-drift` | §7.16 | **已被 HEAD 推翻** | `apps/admin-web/src/utils/executor-metrics.ts:23` `resolveRunningCount` + `ExecutorDetailPage.tsx:342` 已调用 ⇒ 负值被 clamp |
| 5 | `reserved-slots-semantics-vs-inflight` | §7.16 | **仅设计说明** → §7-A `proposal` | `apps/admin-api/src/modules/executor/executor.service.ts:3287-3297` 已写明二者不同源，并有 `reservedSlots <= effectiveRunningCount` 配对校验兜住 ⇒ 语义不同**不是缺陷** |

**结论：主表 5 → 0**（3 条已被 HEAD 推翻并移出、2 条移入 §7-A `proposal` 池，均带 `since=`）。


> **R36 复核（2026-11-05）**：R33 观察到的 `check-ssrf-deny-parity` **exit 1 不可复现** —— 实测 `node scripts/check-ssrf-deny-parity.mjs` **3/3 exit 0**、`npm run check:ssrf-parity`（组合 4 条）**exit 0**；且该守卫的失败信息本就点名「地址 + 缺在哪一侧」并有注入差异的 selftest 用例 ⇒ 归为**观测不可复现**，不是真差异、也不是探针 bug。
## 7-A 历史建议池（附录 · **不逐轮跟踪**）

**本池不逐轮跟踪**：条目按 R34 口径从主表迁出，只为**留痕**。
- **proposal@6d991576**：建议型 / 设计取舍待定 —— 需 Lead 裁定或先立项才会再动；
- **needs-env@6d991576**：需真机/外部环境/外部凭据 —— 每条都写了「什么条件下可重启」。

- **口径④（30 天未立项自动入池）**：`npm run backlog:stale`（纯手工工具，**刻意不接链** —— 口径还会变）读本池 `since=`，输出「超 30 天未立项」清单；发现陈旧条目不是失败（exit 0），交给人工处置。

**捞回方式**：立项时按 id `grep` 本池取原句；若需要更多上下文，读 `artifacts/autonomy/R34/disposal-map.md`（含原句与去处）或对应轮次台账。

| id | kind | 轮次 | since | 一句话 | 重启条件（仅 needs-env 有） |
|---|---|---|---|---|---|
| `execute-ledger-seam` | `needs-env@8aef4eef` | §7.23 | `since=2026-11-05` | 把 `execute` 的 `persist()` 收敛成 `ToolCallLedger` 接缝 —— **R57 勘察后停手**：`persist` 是 `execute` 内的**单一闭包**（`:365`）却有 **14 处调用点**（`:396 431 484 511 538 599 620 646 666 703 743 874 892 934`），且闭包内含 replay 分支（`recordToolCall` / `updateToolCallByToolCallId` 两条路径）+ 依赖 `replayApproved`/`sessionId`/`toolCallId` 三个外部上下文 ⇒ 触发立项止损条款（3+ 处交叉调用需改签名）。**重启条件**：① 先把 replay 决策前移到调用点（拆成新写 / 就地更新两个方法）；② 引入 per-call 上下文对象替代闭包捕获；③ 之后才谈 `ToolCallLedger{record(input, ctx)}`。 | — |
| `approval-consumed-before-execute` | **`已裁定·维持 fail-closed@82e90872`**（不再跟踪） | §7.23 | `since=2026-11-05` | `tool-executor.service.ts:662-700` 是「**先领单再执行**」：工具执行失败时审批单已 `consumed` ⇒ 无法重试（I3）。**R37 判定**：这是**刻意的 fail-closed 取舍**（注释：宁可少执行一次让管理员重新批准，不可多执行一次），不是缺陷；若业务要求「失败可重试」需 Lead 裁决改口径（例如执行失败 ⇒ 退回 `granted`） | — **Lead 裁决（R38）**：`consumed` **不**回退 `granted` —— 自动复活＝在状态已变后重放旧授权，会让 CAS 的价值归零；正确路径是**重新申请审批**（审计链完整）。配套：失败提示已补「已消耗 / 请重新申请审批」（`buildConsumeDenialMessage`）。**本池不再跟踪**，后续由 `backlog:stale` 自然处理。 |
| `diff-card-inline-columns` | `proposal@019a5fa1` | §7.1 | `since=2026-11-05` | `Diff` 卡片内联 3 列（`token` 真实消费点）—— **R35 判为设计说明**：`tokenHash` 等密列从不进 web（grep 0 命中），内联哪 3 列纯属展示选择 | — |
| `reserved-slots-semantics-vs-inflight` | `proposal@019a5fa1` | §7.16 | `since=2026-11-05` | `reservedSlots`（pull 预留未领取）与「服务端在途执行」不同源 —— **R35 判为设计说明**：`executor.service.ts:3287-3297` 已写明并配对校验，无需改语义 | — |
| `desktop-poll` | `proposal@6d991576` | §None | `since=2026-11-05` | poll 下发 3 张只消费第 1 张 | — |
| `data-1` | `proposal@6d991576` | §None | `since=2026-11-05` | 挂起恢复不重开墙钟 | — |
| `data-2` | `proposal@6d991576` | §None | `since=2026-11-05` | 保留期把 failed 的 steps/approvals 当可丢弃数据 | — |
| `desktop-gap3` | `proposal@6d991576` | §None | `since=2026-11-05` | 瞬态续跑全局 resend 打回在途单 | — |
| `approval-replay` | `proposal@6d991576` | §None | `since=2026-11-05` | 已批准调用的确定性执行 | — |
| `data-3` | `proposal@6d991576` | §None | `since=2026-11-05` | appendStep 撞 seq 唯一约束后异常逃出 run() | — |
| `desktop-budget` | `proposal@6d991576` | §None | `since=2026-11-05` | 瞬态失败吃工作预算、误报「迭代轮次已达上限」 | — |
| `desktop-resend` | `proposal@6d991576` | §None | `since=2026-11-05` | poll 关闭分支全局重发 | — |
| `data-4` | `proposal@6d991576` | §None | `since=2026-11-05` | tool_calls read 档清理不看会话状态 | — |
| `webhook-posture-cgnat` | `proposal@6d991576` | §7.1 | `since=2026-11-05` | **`policy:"webhook"` 姿态仍把 `restricted`（CGNAT `100.64/10` + R | — |
| `admin-outbound-remaining-2-cells` | `needs-env@6d991576` | §7.1 | `since=2026-11-05` | `loopback@on` / `privateIPv4@off` 两格仍未收口（豁免账 2 条 5 格） | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `contract-switch-semantics-count` | `proposal@6d991576` | §7.1 | `since=2026-11-05` | 契约 `switch.semantics` 写「其余**五类**」却列了**六个**名字（`addresses` 实有 | — |
| `four-way-ipv4mapped-single-state` | `proposal@6d991576` | §7.1 | `since=2026-11-05` | 四向判据的 `ipv4Mapped` 只判**声明态** | — |
| `state-card-candidate-staleness` | `proposal@6d991576` | §7.1 | `since=2026-11-05` | **状态卡候选清单滞后 5~8 轮**（6 条里 5 条已被 HEAD 推翻） | — |
| `smoke-const-constants` | `proposal@6d991576` | §7.1 | `since=2026-11-05` | `SH_MIN`/`MJS_MIN` 是人工常量（新增场景须同步 +1） | — |
| `check-docs-root-injection` | `proposal@6d991576` | §7.2 | `since=2026-11-05` | `check-docs.mjs` 的 `--root=` 只是**测试注入面**，主跑仍固定 `REPO_ROOT` | — |
| `selftest-env-hermeticity` | `proposal@6d991576` | §7.3 | `since=2026-11-05` | **20+ 个自检会读到开发者本机的 `.env`** ⇒ 「本机红、CI 绿」，且红点离改动很远，极容易被误判成自己写 | — |
| `admin-outbound-remaining-2-cells` | `proposal@6d991576` | §7.3 | `since=2026-11-05` | `loopback@on` / `privateIPv4@off` 两格仍与契约相反（R01 就登记在案，R03 顺延） | — |
| `rollout-lease-micro-window` | `proposal@6d991576` | §7.3 | `since=2026-11-05` | 创建期写租约后仍留**微秒级**窗口（行已 pending、租约还没写） | — |
| `env-leak-key-bisect` | `proposal@6d991576` | §7.4 | `since=2026-11-05` | **没有逐键二分** `133 键里到底是哪几个打掉 401` | — |
| `executor-env-hermeticity` | `proposal@6d991576` | §7.4 | `since=2026-11-05` | **executor-node 侧**的 `.env` 加载未做同样约束 | — |
| `hermetic-env-file-discovery` | `proposal@6d991576` | §7.4 | `since=2026-11-05` | 开关是"跳过 `.env`"，不是"用指定的 `.env`" | — |
| `internal-executor-flag-now-required` | `proposal@6d991576` | §7.5 | `since=2026-11-05` | 内网执行器现在**必须**显式开 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`；**同机 | — |
| `webhook-posture-cgnat` | `proposal@6d991576` | §7.5 | `since=2026-11-05` | `policy:'webhook'` 姿态仍把 `restricted`（CGNAT/RFC2544）放在开关解锁组 | — |
| `smoke-helper-order-guard` | `needs-env@6d991576` | §7.5 | `since=2026-11-05` | 真机脚本的「helper 定义晚于首次使用」只能靠跑起来才发现 | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `allowlist-empty-state-doc` | `proposal@6d991576` | §7.5 | `since=2026-11-05` | 豁免账现在**故意为空**（顶格收口） | — |
| `webhook-posture-cgnat-decision` | `proposal@6d991576` | §7.6 | `since=2026-11-05` | `policy:'webhook'` 面「`restricted` 随开关放行」 vs 文档承诺「云元数据恒拒」——`1 | — |
| `oracle-metadata-classified-public` | `proposal@6d991576` | §7.6 | `since=2026-11-05` | `192.0.0.192`（Oracle Cloud 元数据）被分类为 **`public`** ⇒ **所有**姿态放 | — |
| `webhook-face-contract-gap` | `proposal@6d991576` | §7.6 | `since=2026-11-05` | webhook / AI / 通知面在 `protocol.json` **完全没有契约段** | — |
| `ssrf-parity-python-face` | `proposal@6d991576` | §7.7 | `since=2026-11-05` | `check:ssrf-deny-parity` **只比对两端**（admin 矩阵 ↔ executor-node | — |
| `oracle-metadata-classified-public` | `proposal@6d991576` | §7.7 | `since=2026-11-05` | `192.0.0.192`（Oracle Cloud 元数据）被判 **`public`** ⇒ 四姿态全放行 | — |
| `metadata-addresses-cidr` | `proposal@6d991576` | §7.7 | `since=2026-11-05` | 三端 matcher 目前只支持**单主机**（`/32`）条目 | — |
| `ssrf-parity-python-face` | `proposal@6d991576` | §7.8 | `since=2026-11-05` | `check:ssrf-deny-parity` 只比对两端（admin↔node） | — |
| `metadata-cidr-matcher` | `proposal@6d991576` | §7.8 | `since=2026-11-05` | 三端 matcher 仍只支持单主机（/32）条目 | — |
| `ssrf-matrix-classification-layer-only` | `proposal@6d991576` | §7.9 | `since=2026-11-05` | 新矩阵守卫覆盖的是**分类层**，不覆盖**闸的放行逻辑** | — |
| `ssrf-matrix-hostname-not-covered` | `proposal@6d991576` | §7.9 | `since=2026-11-05` | 主机名（`localhost` / `*.localhost`）**不进矩阵** | — |
| `ssrf-matrix-label-diffs-4` | `proposal@6d991576` | §7.9 | `since=2026-11-05` | 4 条地址在 admin 与 node/python 的**标签**不同但决策相同 | — |
| `runtime-concurrency-only-one-axis` | `needs-env@6d991576` | §7.10 | `since=2026-11-05` | 运行时并发面目前只有**执行器注册**这一轴 | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `race-window-needs-injected-interleaving` | `needs-env@6d991576` | §7.10 | `since=2026-11-05` | 真机 10 轮没触发交叉写窗口（窗口极窄） | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `race-selftest-not-in-offline-chain` | `proposal@6d991576` | §7.10 | `since=2026-11-05` | `test:executor-register-race` **不进** `test:guards:repo`（需 do | — |
| `token-idempotency-cross-instance` | `proposal@6d991576` | §7.11 | `since=2026-11-05` | 串行器只在**单进程**内生效：两个 admin-api 实例并发签发同一身份仍各轮换一次，先返回的令牌立刻作废 | — |
| `runtime-concurrency-axes-remaining` | `needs-env@6d991576` | §7.11 | `since=2026-11-05` | 真机并发目前覆盖 **2 轴**（注册接管 CAS / token 签发幂等） | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `race-selftests-in-selftests-chain` | `needs-env@6d991576` | §7.11 | `since=2026-11-05` | 两条真机用例挂在 `test:guards:selftests`（需 docker，分钟级） | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `token-epoch-derivation` | `needs-env@6d991576` | §7.12 | `since=2026-11-05` | 按 ADR-030 §4/§6 落地 ②′：`tokenRotationEpoch` 迁移 + `issueToken` | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `derivation-secret-lifecycle` | `proposal@6d991576` | §7.12 | `since=2026-11-05` | 派生密钥 `EXECUTOR_TOKEN_DERIVATION_SECRET`（缺省回落 `EXECUTOR_SECRE | — |
| `epoch-column-reserved` | `proposal@6d991576` | §7.12 | `since=2026-11-05` | `tokenRotationEpoch` 必须**只增不跳号**（跳号会让两枚不同令牌对应同一行；回退会让历史令牌复活） | — |
| `token-epoch-mode-rollout` | `proposal@6d991576` | §7.13 | `since=2026-11-05` | `EXECUTOR_TOKEN_EPOCH_MODE` 何时置 `on` 属**运维决策**，不在代码里 | — |
| `derivation-secret-lifecycle` | `proposal@6d991576` | §7.13 | `since=2026-11-05` | 换 `EXECUTOR_TOKEN_DERIVATION_SECRET` = **全部派生令牌立即失效**（一次全机队轮 | — |
| `epoch-observation` | `proposal@6d991576` | §7.13 | `since=2026-11-05` | `tokenRotationEpoch` 目前只有 CAS 用途，无观测面 | — |
| `token-epoch-mode-rollout` | `proposal@6d991576` | §7.14 | `since=2026-11-05` | `EXECUTOR_TOKEN_EPOCH_MODE` 从 `off` 置 `on` 仍是**运维动作**，代码默认 ` | — |
| `epoch-and-authz-metrics` | `proposal@6d991576` | §7.14 | `since=2026-11-05` | 手册要求的两个观察项（`foreign-rotation` 告警频率、执行器 401 率）目前只能看日志/HTTP 计数 | — |
| `runbook-thresholds-unmeasured` | `proposal@6d991576` | §7.14 | `since=2026-11-05` | 手册的「5–10 分钟」「401 率与基线持平」是**建议阈值**，本环境无生产流量可测 | — |
| `heartbeat-dispatch-fullstack` | `needs-env@6d991576` | §7.15 | `since=2026-11-05` | 本轮压的是 SQL 层写冲突，未压协议层（鉴权/DTO/调度器选机） | 有 docker + 30 分钟预算：起 admin-api + 执行器 stub，并发心跳与派发，N≥10 轮断言同组 I1/I2/I3 |
| `other-self-reported-counts` | `proposal@6d991576` | §7.15 | `since=2026-11-05` | `reservedSlots`、`deadLetterCount` 也是客户端自述 + 服务端使用 | — |
| `reserved-slots-floor-when-consumed` | `proposal@6d991576` | §7.16 | `since=2026-11-05` | 守卫只保证"现在没人消费"，**不保证**"将来消费时会有下限" | — |
| `protocol-race-with-real-task` | `proposal@6d991576` | §7.17 | `since=2026-11-05` | 协议层并发要有"真任务"才能造执行行 | — |
| `claim-then-row-window` | `proposal@6d991576` | §7.17 | `since=2026-11-05` | 生产的 `claimExecutorSlotForExecution(candidate, execution)` 要求 | — |
| `display-clamp-i18n` | `proposal@6d991576` | §7.17 | `since=2026-11-05` | 钳底 0 后，预留说明文案在越界态不显示，但页面没有"数据不一致"的提示 | — |
| `dispatch-assignment-unverified` | `proposal@6d991576` | §7.18 | `since=2026-11-05` | 三种候选原因**均未验证**：① trigger 只入队、消费侧（BullMQ processor / leader c | — |
| `interleaving-without-subject` | `proposal@6d991576` | §7.18 | `since=2026-11-05` | 交错发生 ≠ 判定有效：本轮 `claim_at_ms < hb_ms` 成立、心跳 201，但**被观测对象**（本执 | — |
| `heartbeat-latency-budget` | `proposal@6d991576` | §7.18 | `since=2026-11-05` | 夹具里心跳耗时 6–43s（bcrypt 校验 + 队列压力） | — |
| `guards-chain-runtime-parse` | `proposal@6d991576` | §7.19 | `since=2026-11-05` | `test:guards:repo` 是 89 段 `&&` 链：任一段失败只留一条兜底报错，**不点名是哪段** | — |
| `interleaving-metric-hygiene` | `proposal@6d991576` | §7.19 | `since=2026-11-05` | R19 的 `hb_ms` 被自己轮询污染 ⇒ `claim_at_ms < hb_ms` 恒真（假证据） | — |
| `fixture-needs-keepalive` | `proposal@6d991576` | §7.19 | `since=2026-11-05` | 夹具里执行器会被 stale sweep 判 offline（`consecutiveHeartbeatMisses > | — |
| `replace-chain-with-matrix` | `proposal@6d991576` | §7.20 | `since=2026-11-05` | R22 已把 `test:guards:repo` 指向矩阵入口、链定义搬进 `test:guards:chain`、退 | — |
| `equivalence-must-be-independent` | `proposal@6d991576` | §7.20 | `since=2026-11-05` | **反向验证第一次失败**：让"执行序列"与"自己持有的列表"自比 ⇒ 硬编码少一条也自洽通过 | — |
| `matrix-not-in-ci` | `proposal@6d991576` | §7.20 | `since=2026-11-05` | 矩阵入口**未接 CI**（否则整条 89 段链在 CI 跑两遍；R22 已确认 CI 步骤数未变） | — |
| `pointer-swap-breaks-expanders` | `proposal@6d991576` | §7.20 | `since=2026-11-05` | **换指针会打断一切"字符串展开链"的工具**：R22 实测 `check-guards-wired` 的 `expan | — |
| `node-side-env-file-hermetic` | `proposal@6d991576` | §7.21 | `since=2026-11-05` | 若 node 侧曾有同类缺口，**本轮已收口** | — |
| `other-apps-env-hermetic` | `proposal@6d991576` | §7.21 | `since=2026-11-05` | R24 核查结论：**executor-python 有真运行期入口**（`config.py:142-144` pyd | — |
| `bundle-digest-after-src-change` | `proposal@6d991576` | §7.21 | `since=2026-11-05` | 改 `executor-node/src/main.ts` 必触发 `check:desktop-bundle-drif | — |
| `skip-env-file-default-policy` | `proposal@6d991576` | §7.22 | `since=2026-11-05` | R25：约定已成文（`docs/operations.md`「自检环境隔离」）+ 守卫 `check:env-switc | — |
| `web-env-dotenv-presence` | `proposal@6d991576` | §7.22 | `since=2026-11-05` | `apps/admin-web/.env` 未入库但存在于开发机（含真实 IP 的 `VITE_API_URL_EXTE | — |
| `env-entry-sweep-not-selftested-in-ci` | `proposal@6d991576` | §7.22 | `since=2026-11-05` | 新守卫的 selftest 已在 CI step 里（`--selftest` + 主跑） | — |
## 8. 一轮结束的交付标准

- [ ] 工作区干净：`git status --short` 无未提交改动（或明确说明遗留）
- [ ] `tsc` 0 错；改动文件的 eslint 0 错
- [ ] 模块级 jest 全绿；守卫脚本全绿；迁移守规（若有新迁移）
- [ ] 提交信息写清：症状 → 根因 → 修法 → 验证 → 反证方式
- [ ] §7 backlog 已更新；`docs/AGENT_HANDOFF.md` 状态快照追加本轮
- [ ] 没有把「看起来能跑」当证据：每条修复至少有一个会在还原后转红的用例
