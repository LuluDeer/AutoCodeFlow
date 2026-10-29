# 多 Agent 审计-修复循环（可复用编排）

> 面向「同一时刻至多 5 个子 Agent，持续对仓库做全方位优化/改造/修复」的
> **可复用流水线**。不是一次性报告：每次循环都按同一套域划分、写冲突规则与
> 验证矩阵执行，产出可提交的 commit，并把未修项登记回本文 §7 的 backlog。

最后核对：2026-10-29（首轮实跑：5 路只读审计 → 2 个提交，见 §7）

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

```
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
| 文档 | `node scripts/docs/check-docs.mjs`（死链/孤儿/裸路径） |

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

已修并提交：`dc3b1ffb`（GAP-3 服务端 + GAP-6 + 守卫保真）、
`574bbf3b`（TOOLS-01 / RT-1 / RT-2 / RT-3 / RT-5 / RT-6）。

剩余（来自首轮 27 条 findings，已去重）：

| 优先级 | id | 一句话 | 主要落点 |
|---|---|---|---|
| P1 | TOOLS-02 | 审批 grant 后动作不会执行：重放文案叫模型「勿重复提交」，而执行只可能发生在重提时 | `agent.controller.ts` grant 分支 + `agent-runtime.service.ts` 重放文案 + 台账状态 |
| P1 | TOOLS-03 | ~~deploy_app / create_task_from_template / create_application 契约错位~~ | **已修（`574bbf3b` 后续批次）** |
| P1 | desktop-poll | poll 单轮可下发 3 张指派，host 只消费第 1 张，其余既不执行也不重投（中台永远 in_progress） | `agent-host.ts` 分拣 + `resendAssignmentIds` |
| P2 | desktop-gap3 | 瞬态续跑用全局 `resendAssignments`，会把等答复的单打回 running 并 ACK 丢弃答复 | `agent-host.ts:741` 改定向 id + `awaiting_reply` 守卫 |
| P2 | desktop-budget | 续跑把链路抖动记进工作预算：15 次 503 后上报「迭代轮次已达上限」 | `journal.counters` 与迭代闸的分离 |
| P2 | TOOLS-04 | 工具超时只 reject 不取消：副作用仍在继续，台账记 timeout、模型重试 → 双份副作用 | `withTimeout` + handler AbortSignal + 「结果未知」文案 |
| P2 | TOOLS-05 | 危险模式扫描对所有字符串生效：多行 SOP 正文/脚本必被 invalid_params 拒 | `agent-boundary.service.ts` 字段级豁免 |
| P3 | TOOLS-06 | 工具结果未脱敏就落库（类注释承诺参数与结果都脱敏） | `tool-executor.service.ts` recordToolCall 前 sanitize |
| P3 | RT-4 | 陈旧 running 清扫绕开 `finish()`：不推 ERROR 通知、不计会话指标（需聚合限流） | `sweepStaleRunning` |
| P3 | data/obs | 其余（指标标签漂移、UI 入口缺失、文档与实现相反）见首轮审计原文 | 各域 |

> 首轮完整 finding 原文（含逐字代码、触发路径、修法、langgraph 对照）在
> 该轮会话的 workflow 输出里；本表只保留可执行摘要。

---

## 8. 一轮结束的交付标准

- [ ] 工作区干净：`git status --short` 无未提交改动（或明确说明遗留）
- [ ] `tsc` 0 错；改动文件的 eslint 0 错
- [ ] 模块级 jest 全绿；守卫脚本全绿；迁移守规（若有新迁移）
- [ ] 提交信息写清：症状 → 根因 → 修法 → 验证 → 反证方式
- [ ] §7 backlog 已更新；`docs/AGENT_HANDOFF.md` 状态快照追加本轮
- [ ] 没有把「看起来能跑」当证据：每条修复至少有一个会在还原后转红的用例
