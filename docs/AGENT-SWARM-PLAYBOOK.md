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

### 7.0 主表（R34 迁移后 · 每轮最多消化 10 条）

口径：只有 `needs-reading@6d991576` 留在主表（需逐条读实现才能判定）；建议型/需真机条目已入 `§7-A 历史建议池`，标废条目留痕在 `artifacts/autonomy/R34/disposal-map.md`。**主表 5 条（目标 ≤15）。**

| # | kind | id | 轮次 | 一句话 |
|---|---|---|---|---|
| 1 | `needs-reading@6d991576` | `diff-card-inline-columns` | §7.1 | `Diff` 卡片内联 3 列（`token` 真实消费点） |
| 2 | `needs-reading@6d991576` | `iana-special-purpose-sweep` | §7.8 | `192.0.0.0/24` 段内还有 5 条**已核对未改**的地址 |
| 3 | `needs-reading@6d991576` | `release-path-race` | §7.15 | 释放路径 `GREATEST(count-1,0)` 与心跳并发时同样可能被覆盖（本轮 I2 未复现，因释放后计数已能回 |
| 4 | `needs-reading@6d991576` | `running-minus-reserved-drift` | §7.16 | 详情页「实际运行 = `runningTaskCount − reservedSlots`」在 R16 后可能为**负* |
| 5 | `needs-reading@6d991576` | `reserved-slots-semantics-vs-inflight` | §7.16 | `reservedSlots` 的语义是"pull 预留**未领取**"，与「服务端在途执行」不是同一集合 |

已修并提交：`dc3b1ffb`（GAP-3 服务端 + GAP-6 + 守卫保真）、
`574bbf3b`（TOOLS-01 / RT-1 / RT-2 / RT-3 / RT-5 / RT-6）。

剩余（来自首轮 27 条 findings，已去重）：

| 优先级 | id | 一句话 | 状态 / 主要落点 |
|---|---|---|---|
| P1 | TOOLS-02 | 审批 grant 后动作不会执行 | **已修 `d9660f52` + `c023df3d`**（文案按状态渲染 + 运行时确定性重放，执行体就地更新台账行） |
| P1 | TOOLS-03 | 三个写工具 schema↔执行体契约错位 | **已修 `cac3bbcb`** |
| P1 | obs-1 | 令牌指标记步数不是令牌量 | **已修 `ea2509a6`** |
| P2 | TOOLS-04 | 工具超时不取消 → 双份副作用 | **已修 `a49ba0f5`**（AbortSignal 通道 + 写 tier「结果未知」+ 不计熔断；handler 消费 signal 仍为残差） |
| P2 | obs-2 | 文档承诺的「Admin Web 对话」入口不存在 | **已修 `cb9b75ec`**（新建会话弹窗；zh/en 词条 + 用例） |
| P3 | TOOLS-06 | 工具结果未脱敏就落库 | **已修 `a49ba0f5`**（结果/preview 脱敏，digest 保留，sha256 按原文） |
| P3 | obs-3 | budget_exceeded 死入口/过时文案 | **已修 `ea2509a6` + `c023df3d`** |
| P3 | obs-4 | 标签漂移守卫 spec 不存在 | **已修 `ea2509a6`** |

**第 3 轮并行审计（8 域 53 条，归档 `docs/archive/audits/2026-10-29-round3/`）**

已由本会话修掉的：

| id | 一句话 | 状态 |
|---|---|---|
| CIR-02 | desktop selftest 只挂 PR 门控 job，主干零覆盖 | **已修 `aefafd1d`**（新增 push 触发 job + 守卫判据④） |
| CIR-01 | 覆盖率 job 是唯一无重试的 jest 运行 | **部分 `aefafd1d`**（补 --retryTimes=2）；PR 上仍不跑覆盖率（待分片+nyc merge） |
| db-1 | CONCURRENTLY + 30s statement_timeout 留下 INVALID 索引 | **止血 `84e4c906`**（7 条迁移加会话级豁免 + 守卫）；残差：存量 indisvalid 自检/runbook |
| CIR-03 | ci-local 的 npm audit 无豁免清单 → 本地必红 | **已修 `f5336d1f`**（单一事实源脚本，CI/local 共用） |
| CIR-04 | ci-local 缺 typecheck:specs / --coverage / build 前置 | **已修 `f5336d1f`** |
| （顺带） | executor-node qs / mcp-server @hono/node-server 两条可修 CVE；instance-id 回落丢 opts | **已修 `3652dea6`** |

下一轮候选（**派发前先对照 HEAD**：同仓可能有并行流已落地）：

| 优先级 | id | 一句话 | 备注 |
|---|---|---|---|
| P1 | SEC-R3-1/2 | 共享令牌被当 per-executor 凭据：pull 收割他人明文 secrets、终态读他人执行清单、心跳/注册外发 HMAC 密钥、SOP 协作面以他人身份轮询 | **已修 `c150a434`**：pull/terminal-states/SOP 要求 per-executor；心跳扣留 tokenHash；注册只在「该行尚无凭据」时引导发放、已有凭据禁止轮换。残差 SEC-R3-3（`POST /executions/:id/logs` 的共享令牌兜底仍需决策是否放弃 legacy） |
| P2 | SEC-R3-3 | `POST /executions/:id/logs` 的共享令牌兜底不校验执行归属（可写任意执行的日志） | **已修 `b1e5186a`**（拒绝共享令牌；正常日志走 v1/按地址令牌；与 callback 的共享兜底刻意不同） |
| P1 | OBS3-01 | Grafana 成功率面板用 `status="SUCCESS"`（实际小写）→ 永远 No data | **已修（并行流）**：label 改小写 + dashboard-label-values 守卫（当前看板 0 处大写） |
| P2 | OBS3-02 | `tool` 标签取模型输出（无界） | **已修 `9a58e8e3`**：写入侧把注册表外的名字归并 `unknown`；基线工具名必须真实存在 |
| P2 | OBS3-03 | `sse_streams_limit` 只在开流时发布 → 容量告警分母缺副本 | **已修 `9a58e8e3`**：TaskService.onModuleInit 启动即发 active=0 + limit |
| P2 | OBS3-04 | 5xx 日志缺 method/route/errorCode/traceId | **已修（并行流）**：统一出口带四字段 |
| P3 | OBS3-08 | llm_retry 的 result 有 3 个未登记取值 | **已修 `9a58e8e3`**：登记 approved_replay/resume_queued/resume_enqueue_failed + help |
| P1 | rt-5 | 5 处 `@Cron` 无顶层异常闸 → unhandledRejection → graceful shutdown | **util 已收编 `a5a39411`**（executor.service 3 处接线随 `c150a434`）；其余模块接线在并行流工作区，派发前确认 |
| P2 | db-1 残差 | 存量 INVALID 索引自检（`pg_index.indisvalid`）+ 修复 runbook | **已做**：迁移执行器 up 后自检（fail-open），发现即 ERROR + 处置步骤；runner 单测 +2 |
| P2 | db-2 | `/tasks` 排序键无索引（未命名 @Index 从未落库） | **已做**：迁移 0075 `(createdAt DESC, id DESC)` CONCURRENTLY + 实体显式命名（drift 守卫覆盖） |
| P2 | db-3 | outbox claim 与索引不匹配、死信每 5s 回堆 | **已做**：迁移 0076 partial index（谓词与 claim 逐字对应） |
| P2 | db-5 | 0061/0073 在热表上非并发 DDL | **已做 `b1e5186a`**：0061 改 CONCURRENTLY + 超时豁免；0073 只留幂等去重、唯一索引拆到 0077（CONCURRENTLY） |
| P2 | WEB-1/3/5、SDK-DX-01/02 | recharts 首屏预载、后台标签页 SSE 不断开、设置页错误态；SDK retry:null 空操作、文档与代码相反 | **并行流疑似在修**，派发前对照 |
| P2 | EXEC-01 | python `/execute` 第三份模型（SDK 分支） | **已修 `c59741fa`**：单一本地模型（task=dict + secrets），AST 守卫防回归；SDK 客户端模型补 secrets |
| P2 | EXEC-07 | params 键名折叠冲突（limit/LIMIT 静默覆盖） | **已修 `c59741fa`**：两端 accept 阶段 400（逐字节同文案）+ 协议 8 条向量；顺带对齐 python fullmatch（`"LIMIT\n"` 分叉） |
| P3 | EXEC-05 | env 转发白名单两端不同集、无守卫 | **已修 `c59741fa`**：protocol.json `envForward` 三桶清单 + 双向源码守卫（只登记现状，不扩面） |
| P3 | EXEC-03/04 | zip Windows 归一化 / 未知命令静默丢弃 | **已修 `988c220b`**（双端归一化 + 未知命令如实上报） |
| P3 | EXEC-06 | CallbackPayload 两端严格度 | **已核对+钉住 `27670e50`**：生成模型本就是 `strict=True`（审计判断「python lax」已过时）；两端契约测试钉住「字符串数字被拒」防生成器退回 lax |
| P2 | EXEC-02 | python `preexec_fn`（fork 后 exec 前跑 Python，多线程进程可死锁） | **已修 `e22fd5e7`**：新 exec 的单线程 launcher（`start_new_session` 在建会话 → setrlimit → 还原 SIGPIPE → `execvpe`，PID/树杀语义不变）；4 处 spawn 面全覆盖，fail-closed；全量 python 1481 例 / 覆盖 88.29% |
| P2 | EXEC-07b | admin 源头闸未加折叠冲突判定 | **已修 `27670e50`**：DTO 约束挂到 Create/TriggerTask（保存/触发即 400），判据直接对账 protocol.json 的 8 条向量 |

> **并行工作区纪律（新增）**：本仓可能同时有多个 agent/会话在写。提交永远用
> **显式路径** `git add <file…>`，不要 `-A`；发现非本会话产生的改动先读、
> 跑它的守卫/selftest，再决定收编（提交信息里如实标注来源），不要静默覆盖。
> **提交前必须 `git diff --cached --stat`**：显式 add 不会清掉别人**已 staged**
> 的条目，`git commit` 会把它们一起带走（本仓实测发生过一次：一个内容等价的
> 测试文件 rename 被卷进了 CI 提交）。若索引不干净，先 `git restore --staged`
> 只留自己的路径。

> 首轮完整 finding 原文（含逐字代码、触发路径、修法、langgraph 对照）在
> 该轮会话的 workflow 输出里；本表只保留可执行摘要。

### 7.1 R01（2026-11-05）新增未修项

优先级 = 收益/风险比，不是"谁先被提到"。**派发前先对照 HEAD**（本仓并行流多）。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| **P0（流程）** | guards-chain-first-failure — **✅ R02 已收口（2026-11-05，见 §7.2）** | ~~`test:guards:repo` 是 `&&` 链，第一步红 ⇒ 后面 84 个守卫一个都没跑，而尾部仍在打印 ✔~~ | R01 实测：`test:docs` 的"孤儿文档"判据把 `docs/plan/rounds/AUTONOMY-{LOOP,STATE}.md` 判红 ⇒ 整链 `exit 1`。**R02 复核后修掉两半**：① 两份 docs 已接进 `docs/plan/rounds/README.md` 索引（判据面是 `checkOrphans` 的链接 BFS，入口 `docs/README.md:91`）；② 报告面 —— `check-docs.mjs` 改为「通过先打、失败后打、终态摘要收尾」+ `test:guards:repo` 链尾挂 `\|\| node guard-chain-fail.mjs（R22 已退役） $?`，**尾行不再可能是 ✔**。R01 的归因「守卫链报告成功」**不准确**：退出码一直是对的（exit 1），坏的是可见尾部。**剩余**（→ §7.2 P2）：链仍无原生逐条计数 |

### 7.2 R02（2026-11-05）新增未修项

R02 收口了 §7.1 的 P0 `guards-chain-first-failure`（细节见 `docs/PLAN-CLAIMS.md` 的 R02 条目），
**没收口的是它下面那层结构问题**：

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 1 / 标废 2），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.3 R03（2026-11-05）新增未修项

R03 收口了 R02 留下的 `unverified`（跨实例灰度在「创建窗口」内被周期回收器判死，见 `docs/PLAN-CLAIMS.md` 的 R03 条目）。
**本轮买的教训是「本地门禁 ≠ CI」的第二种形态**，所以下面第 1 项优先于业务项：

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.4 R04（2026-11-05）结论与新增未修项

**收口**：§7.3 的 P1 `selftest-env-hermeticity` 已完成（`SELFTEST_SKIP_ENV_FILE=1` ⇒ **三个** `.env`
入口全部跳过；默认关 ⇒ 生产/CI 零变化）。实测：本机开发态 `.env` 符号链接**存在**与**移开**两种
状态下 `test:guards:selftests` 均 **exit 0**，`injected env` 行数 **1 → 0**。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.5 R05（2026-11-05）结论与新增未修项

**收口**：§7.3 的 P1 `admin-outbound-remaining-2-cells` 已完成 —— admin 执行器出站姿态与契约逐格一致
（私网需开关、loopback 恒拒），四向检查 **5 格不一致 → 0 格**、豁免账 **2 条 → 0 条**、
真机 B4/B5 在**私网取样地址**下八条/七条全绿。

> **R34 迁移**：本轮 4 条已按 Lead 口径处置（主表 0 / §7-A 4 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

**R06 补充（2026-11-05）**：上表 P1 的「公告」已完成 —— `docs/UPGRADING.md` **§11** 写了谁受影响 /
实测症状 / 两条修法 / 自查 / 回滚；`main.ts` 在模块顶层打**启动期可操作告警**（点名开关 + 两条修法 +
指向文档）；新增守卫 `check:upgrade-notes`（四条机读判据）+ spec 4 条，并将 §9 的「破坏性变更：无」
同步改成「1 条」。**仍待办**：`docs/UPGRADING.md` 头部的「核实基线」段还是 2026-11-02 的 commit，
发版前应刷新（不阻塞本轮）。

### 7.6 R07（2026-11-05）待裁决项（无代码变更）

R07 按「先契约后实现」核 webhook 面，结论是**契约自相矛盾** ⇒ 停手待裁决（细节见 `docs/PLAN-CLAIMS.md` 的 R07 条目）。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.7 R08（2026-11-05）收口与新增未修项

**收口**：§7.6 的 P1 `webhook-posture-cgnat-decision` 已按 Lead 裁决**方案②**落地 ——
契约新增 `networkPolicy.metadataAddresses`（任何 posture × 任何开关都 DENY），三端从**生成物**同读，
文档三处口径统一 + `UPGRADING §12`。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.8 R09（2026-11-05）收口与新增未修项

**收口**：§7.7 的 P1 `oracle-metadata-classified-public` —— `192.0.0.192` 已入
`networkPolicy.metadataAddresses`（复用 R08 机制），且三端**分类函数**对元数据地址返回 `reserved`
（ADR-029 §7 追加说明）。修前实测四姿态 × 两态**全放行**；修后三端标签一致、四姿态恒拒。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 1 / §7-A 2 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.9 R10（2026-11-05）收口与新增未修项

**收口**：§7.8 的 P1 `ssrf-parity-python-face` —— 新增 `scripts/check-ssrf-three-way-matrix.mjs`
（三端**判定**矩阵守卫）+ `scripts/ssrf-category-matrix.mjs`（真跑探针）+ 豁免清单
`scripts/ssrf-category-parity-exemptions.json`（默认空）；`check:ssrf-parity` 串联两者。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.10 R11（2026-11-05）换轴到真机并发：结论与新增未修项

R01–R10 全吃 SSRF/契约/守卫线，边际收益递减 ⇒ R11 换轴测**运行时并发正确性**。
本轮建立真机并发回归（`scripts/executor-register-race-selftest.mjs`，docker PG + 真 admin-api），
**历史担心的接管 CAS 竞态真机未复现**；但用**代码层注入判据**稳定复现并修掉一个**相邻写窗口**
（`register()` 指纹命中路径无谓词 ⇒ 可被并发接管后覆盖）。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.11 R12（2026-11-05）真机并发第二轴（token 幂等）+ 真机用例接链

**收口**：`issueToken` 的 `(address,startupId)` 幂等在**并发下完全失效**（真机 4 并发 × 6 轮
每轮 4 次轮换）⇒ 按身份串行化后 10 轮稳定 1 次；两条真机用例接进 `test:guards:selftests`，
并新增「引用存在」守卫（`check:race-selftests-wired`，含双层反向验证）。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.12 R13（2026-11-05）跨实例 token 幂等：ADR 结论与落地排期

**结论**：ADR-030 采纳 **②′（确定性派生 + `tokenRotationEpoch` CAS）**；否决 ①（Redis 明文缓存：
失效时**静默**退回已确诊缺陷 + 把凭据明文搬进中间件）、③（单写者 lease：不解决「输家拿不到明文」，
且与 R03/R11 语义互撞）。本轮只落**症状告警**（行为零改变），改实现 + 迁移排下一轮。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.13 R14（2026-11-05）ADR-030 ②′ 落地：跨实例 token 幂等成立

**结论**：确定性派生 + `tokenRotationEpoch` CAS 已落地，`EXECUTOR_TOKEN_EPOCH_MODE` **默认 off**。
真机两实例（mode=on）10 轮 × 4 并发 **两实例返回同一枚令牌**；混跑（新×旧）按 ADR §5.2 不幂等
但**不打死令牌**。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.14 R15（2026-11-05）派生密钥运维债收口（含 ADR 假设被推翻）

**收口**：ADR-030 §7.12-P2。交付手册（`docs/operations.md` 一节 + `UPGRADING §14`）、
启动告警（`config/token-derivation-posture.ts` + `main.ts` 接线）、机读守卫
（`scripts/check-ops-runbook.mjs`，`test:guards:repo` **87→88 段**，CI 同步）。
**并修正 ADR-030 §5.4 的错误假设**：换派生密钥**不吊销**已签发令牌（实测），
受影响的是跨实例幂等与下次按需轮换；回退可行。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.15 R16（2026-11-05）真机并发第 3 轴：心跳 vs 派发占坑

**结论**：心跳的 `runningTaskCount` 是**客户端快照覆盖写**，与派发的**原子 +1** 打同一列 ⇒
窗口内落地的占坑会被抹掉 ⇒ **超卖**（真机两连接 20/20 轮复现）。修法 = 落库前取
`max(客户端上报, 服务端在途占坑数)`（纯函数 `heartbeat-count.util.ts`），无 schema/迁移。
**真机证据是「真 PG + 生产 SQL 形状的两条独立连接」**，不是全栈 HTTP。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 1 / §7-A 2 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.16 R17（2026-11-05）`reservedSlots`：无消费点 ⇒ 守卫钉事实

**结论**：R16 台账里的 P2 —— 同族列 `reservedSlots` **当前没有任何容量消费点**
（派发/容量面零命中，其余 8 处是展示/透传/schema/上报侧，逐条登记），
故按立项走**路 B**：不加死代码，改为 `check:reserved-slots-consumer` 守卫
（`test:guards:repo` **88→89 段** + CI）。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 2 / §7-A 1 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.17 R18（2026-11-05）展示口径钳底完成；协议层并发只到「骨架已验、卡在造前置数据」

**A（完成）**：`resolveRunningCount` 纯函数（`apps/admin-web/src/utils/executor-metrics.ts`），
`reserved > occupied` 时显示 **0** 而非退回 occupied；页面两处改用它；只动展示不动存储。

**B（部分完成，卡点明确）**：协议层 harness 已能起真 admin-api + 真 HTTP 心跳（10/10 轮 201）
并**证明交错发生**（`claim_at_ms 5–6ms < hb_ms 170–220ms`）；但**占坑侧造不出执行行**
（`task_executions` 的 NOT NULL `taskId`/`taskName` + `tasks` 外键），故在 `claimed===0` 时**主动判红**。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.18 R19（2026-11-05）协议层并发：行有了，指派没有（第 2 次卡 → 下轮 blocked/换靶）

**进展**：路径 1（真 API）跑通「登录 → 注册执行器（push 指向本地 stub）→ `POST /api/tasks` →
`POST /api/tasks/:id/trigger`」，**执行行确实由生产代码创建**（`task_executions` = 1，`status=pending`）。
**卡点**：40s 内 `executorId` 恒 `NULL` ⇒ 未走 `claimExecutorSlotForExecution`
（`executor-dispatch-slot.collaborator.ts:105-118`）⇒ 本执行器在途恒 0 ⇒ I1/I2/I3 不可判定。
心跳协议面 201、交错被证明（`claim_at_ms=6ms < hb_ms=43654ms`），但**判定对象缺失**，故保持判红。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.19 R20（2026-11-05）**R18-B 记 blocked**：派发指派根因未收敛（第 3 次，止损生效）

> **blocked 登记**（本仓第一条正式 blocked 条目）
> **阻塞对象**：协议层并发判定（R18-B）——需要「生产把执行行指派给被测执行器」这一步发生。
> **已确证**：① 执行行由生产创建（`POST /api/tasks/:id/trigger` ⇒ 1 行 `pending`、`executorId=NULL`）；
> ② 「执行器离线」已排除（stale sweep 判 offline 是夹具缺陷，补保活心跳后稳定 `online`，仍不指派）；
> ③ 日志中**没有**针对本执行的派发尝试（只有心跳/指标/stale sweep/`WHERE "dispatchedAt" IS NULL` 与 `status='waiting'` 扫描）。
> **未能确证**：trigger 之后那一步为什么没落实到本行（候选：outbox/`dispatchedAt` 阶段未走到；消费侧 leader 未持有；`dispatch-decision-log` 有拒绝记录）。
> **已试路径**：真 API 全链（login→register→create task→trigger）、SQL 硬造（被 NOT NULL/FK 挡住，已弃）、保活心跳、180s 等待。
> **重启条件（满足其一即可重启，不需要再换造数方式）**：
> ① `dispatch-decision-log`（`dispatch-decision-log.schema.ts`）里查到**针对本执行的拒绝原因**；
> ② 查到 `WHERE "dispatchedAt" IS NULL` 那张表在本夹具里**有/没有**本执行的行（有 ⇒ 消费侧问题；没有 ⇒ 写入侧问题）；
> ③ 确认消费侧 leader/processor（`task.processor.ts:62` 的 `@Processor("task-queue")`）在本夹具里确实在跑。
> **禁止**：为让用例变绿而放宽 `inFlight===0 ⇒ 红`；禁止再发明新的造数 SQL。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.20 R21（2026-11-05）守卫框架 meta：让 89 段链「说得清」

**成果**：新增并列入口 `npm run test:guards:repo:matrix`（`scripts/guards-repo-matrix.mjs`）——
**运行期**从 `package.json` 切分 89 段、逐条 `[k/89] <cmd> => exit N`、失败**点名第 k 条**并**原样传播退出码**；
**旧链一字未改**，两者并存一轮。等量性：解析 89 / 执行 89 / diff 空。
红证据：同一注入（第 28/90 段失败）下，旧链只给兜底 banner（`第 k 条` 命中数 = **0**），新入口 **exit 7 + 点名**。

> **R34 迁移**：本轮 4 条已按 Lead 口径处置（主表 0 / §7-A 4 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.21 R23（2026-11-05）executor-node `.env` hermeticity（R04 语义覆盖到 node 侧）

**事实**：node 侧 `.env` 加载入口**只有一处** —— `apps/executor-node/src/main.ts:2-4`，且是**无条件**的。
测试**恰好**碰不到它（jest `collectCoverageFrom` 排除 `!src/main.ts`，全仓无 spec 导入 main）——**巧合不是判据**。
**改动**：加 `SELFTEST_SKIP_ENV_FILE` 三态开关（逐字对齐 admin R04）+ `check:executor-node-env-hermetic`
守卫（加载点唯一且受约束 / 开关只认 `"1"` / 测试不导入 main）；`test:guards:chain` **89 → 90 段**。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

### 7.22 R24（2026-11-05）`.env` 读入面清扫：四端全收口

| 端 | 读入形态 | 处置 |
|---|---|---|
| admin-api | R04 三入口（preload / ConfigModule / data-source） | 已受 `SELFTEST_SKIP_ENV_FILE` 约束（R04） |
| executor-node | `src/main.ts` 一处 `dotenv.config` | 已收口（R23） |
| **executor-python** | **`config.py:142-144` pydantic `SettingsConfigDict(env_file='.env')`（实例化即读）** | **R24 收口**：开关 + `conftest.py` 默认干净 |
| admin-web | vite **构建期**读 `.env*` 注入 `import.meta.env`；`src` 无 dotenv | **不是运行期污染** ⇒ 守卫钉事实 |

守卫 `check-env-entry-sweep`（selftest 5/5）覆盖四端；`test:guards:chain` **90 → 91 段**。

> **R34 迁移**：本轮 3 条已按 Lead 口径处置（主表 0 / §7-A 3 / 标废 0），原句与去处见 `artifacts/autonomy/R34/disposal-map.md`。

---


## 7-A 历史建议池（附录 · **不逐轮跟踪**）

**本池不逐轮跟踪**：条目按 R34 口径从主表迁出，只为**留痕**。
- **proposal@6d991576**：建议型 / 设计取舍待定 —— 需 Lead 裁定或先立项才会再动；
- **needs-env@6d991576**：需真机/外部环境/外部凭据 —— 每条都写了「什么条件下可重启」。

**捞回方式**：立项时按 id `grep` 本池取原句；若需要更多上下文，读 `artifacts/autonomy/R34/disposal-map.md`（含原句与去处）或对应轮次台账。

| id | kind | 轮次 | 一句话 | 重启条件（仅 needs-env 有） |
|---|---|---|---|---|
| `desktop-poll` | `proposal@6d991576` | §None | poll 下发 3 张只消费第 1 张 | — |
| `data-1` | `proposal@6d991576` | §None | 挂起恢复不重开墙钟 | — |
| `data-2` | `proposal@6d991576` | §None | 保留期把 failed 的 steps/approvals 当可丢弃数据 | — |
| `desktop-gap3` | `proposal@6d991576` | §None | 瞬态续跑全局 resend 打回在途单 | — |
| `approval-replay` | `proposal@6d991576` | §None | 已批准调用的确定性执行 | — |
| `data-3` | `proposal@6d991576` | §None | appendStep 撞 seq 唯一约束后异常逃出 run() | — |
| `desktop-budget` | `proposal@6d991576` | §None | 瞬态失败吃工作预算、误报「迭代轮次已达上限」 | — |
| `desktop-resend` | `proposal@6d991576` | §None | poll 关闭分支全局重发 | — |
| `data-4` | `proposal@6d991576` | §None | tool_calls read 档清理不看会话状态 | — |
| `webhook-posture-cgnat` | `proposal@6d991576` | §7.1 | **`policy:"webhook"` 姿态仍把 `restricted`（CGNAT `100.64/10` + R | — |
| `admin-outbound-remaining-2-cells` | `needs-env@6d991576` | §7.1 | `loopback@on` / `privateIPv4@off` 两格仍未收口（豁免账 2 条 5 格） | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `contract-switch-semantics-count` | `proposal@6d991576` | §7.1 | 契约 `switch.semantics` 写「其余**五类**」却列了**六个**名字（`addresses` 实有  | — |
| `four-way-ipv4mapped-single-state` | `proposal@6d991576` | §7.1 | 四向判据的 `ipv4Mapped` 只判**声明态** | — |
| `state-card-candidate-staleness` | `proposal@6d991576` | §7.1 | **状态卡候选清单滞后 5~8 轮**（6 条里 5 条已被 HEAD 推翻） | — |
| `smoke-const-constants` | `proposal@6d991576` | §7.1 | `SH_MIN`/`MJS_MIN` 是人工常量（新增场景须同步 +1） | — |
| `check-docs-root-injection` | `proposal@6d991576` | §7.2 | `check-docs.mjs` 的 `--root=` 只是**测试注入面**，主跑仍固定 `REPO_ROOT` | — |
| `selftest-env-hermeticity` | `proposal@6d991576` | §7.3 | **20+ 个自检会读到开发者本机的 `.env`** ⇒ 「本机红、CI 绿」，且红点离改动很远，极容易被误判成自己写 | — |
| `admin-outbound-remaining-2-cells` | `proposal@6d991576` | §7.3 | `loopback@on` / `privateIPv4@off` 两格仍与契约相反（R01 就登记在案，R03 顺延） | — |
| `rollout-lease-micro-window` | `proposal@6d991576` | §7.3 | 创建期写租约后仍留**微秒级**窗口（行已 pending、租约还没写） | — |
| `env-leak-key-bisect` | `proposal@6d991576` | §7.4 | **没有逐键二分** `133 键里到底是哪几个打掉 401` | — |
| `executor-env-hermeticity` | `proposal@6d991576` | §7.4 | **executor-node 侧**的 `.env` 加载未做同样约束 | — |
| `hermetic-env-file-discovery` | `proposal@6d991576` | §7.4 | 开关是"跳过 `.env`"，不是"用指定的 `.env`" | — |
| `internal-executor-flag-now-required` | `proposal@6d991576` | §7.5 | 内网执行器现在**必须**显式开 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`；**同机  | — |
| `webhook-posture-cgnat` | `proposal@6d991576` | §7.5 | `policy:'webhook'` 姿态仍把 `restricted`（CGNAT/RFC2544）放在开关解锁组 | — |
| `smoke-helper-order-guard` | `needs-env@6d991576` | §7.5 | 真机脚本的「helper 定义晚于首次使用」只能靠跑起来才发现 | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `allowlist-empty-state-doc` | `proposal@6d991576` | §7.5 | 豁免账现在**故意为空**（顶格收口） | — |
| `webhook-posture-cgnat-decision` | `proposal@6d991576` | §7.6 | `policy:'webhook'` 面「`restricted` 随开关放行」 vs 文档承诺「云元数据恒拒」——`1 | — |
| `oracle-metadata-classified-public` | `proposal@6d991576` | §7.6 | `192.0.0.192`（Oracle Cloud 元数据）被分类为 **`public`** ⇒ **所有**姿态放 | — |
| `webhook-face-contract-gap` | `proposal@6d991576` | §7.6 | webhook / AI / 通知面在 `protocol.json` **完全没有契约段** | — |
| `ssrf-parity-python-face` | `proposal@6d991576` | §7.7 | `check:ssrf-deny-parity` **只比对两端**（admin 矩阵 ↔ executor-node  | — |
| `oracle-metadata-classified-public` | `proposal@6d991576` | §7.7 | `192.0.0.192`（Oracle Cloud 元数据）被判 **`public`** ⇒ 四姿态全放行 | — |
| `metadata-addresses-cidr` | `proposal@6d991576` | §7.7 | 三端 matcher 目前只支持**单主机**（`/32`）条目 | — |
| `ssrf-parity-python-face` | `proposal@6d991576` | §7.8 | `check:ssrf-deny-parity` 只比对两端（admin↔node） | — |
| `metadata-cidr-matcher` | `proposal@6d991576` | §7.8 | 三端 matcher 仍只支持单主机（/32）条目 | — |
| `ssrf-matrix-classification-layer-only` | `proposal@6d991576` | §7.9 | 新矩阵守卫覆盖的是**分类层**，不覆盖**闸的放行逻辑** | — |
| `ssrf-matrix-hostname-not-covered` | `proposal@6d991576` | §7.9 | 主机名（`localhost` / `*.localhost`）**不进矩阵** | — |
| `ssrf-matrix-label-diffs-4` | `proposal@6d991576` | §7.9 | 4 条地址在 admin 与 node/python 的**标签**不同但决策相同 | — |
| `runtime-concurrency-only-one-axis` | `needs-env@6d991576` | §7.10 | 运行时并发面目前只有**执行器注册**这一轴 | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `race-window-needs-injected-interleaving` | `needs-env@6d991576` | §7.10 | 真机 10 轮没触发交叉写窗口（窗口极窄） | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `race-selftest-not-in-offline-chain` | `proposal@6d991576` | §7.10 | `test:executor-register-race` **不进** `test:guards:repo`（需 do | — |
| `token-idempotency-cross-instance` | `proposal@6d991576` | §7.11 | 串行器只在**单进程**内生效：两个 admin-api 实例并发签发同一身份仍各轮换一次，先返回的令牌立刻作废 | — |
| `runtime-concurrency-axes-remaining` | `needs-env@6d991576` | §7.11 | 真机并发目前覆盖 **2 轴**（注册接管 CAS / token 签发幂等） | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `race-selftests-in-selftests-chain` | `needs-env@6d991576` | §7.11 | 两条真机用例挂在 `test:guards:selftests`（需 docker，分钟级） | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `token-epoch-derivation` | `needs-env@6d991576` | §7.12 | 按 ADR-030 §4/§6 落地 ②′：`tokenRotationEpoch` 迁移 + `issueToken` | 有 docker 或真实外部服务/凭据、或出现对应现场证据时可重启（维护者可评估并入 CI 慢通道） |
| `derivation-secret-lifecycle` | `proposal@6d991576` | §7.12 | 派生密钥 `EXECUTOR_TOKEN_DERIVATION_SECRET`（缺省回落 `EXECUTOR_SECRE | — |
| `epoch-column-reserved` | `proposal@6d991576` | §7.12 | `tokenRotationEpoch` 必须**只增不跳号**（跳号会让两枚不同令牌对应同一行；回退会让历史令牌复活） | — |
| `token-epoch-mode-rollout` | `proposal@6d991576` | §7.13 | `EXECUTOR_TOKEN_EPOCH_MODE` 何时置 `on` 属**运维决策**，不在代码里 | — |
| `derivation-secret-lifecycle` | `proposal@6d991576` | §7.13 | 换 `EXECUTOR_TOKEN_DERIVATION_SECRET` = **全部派生令牌立即失效**（一次全机队轮 | — |
| `epoch-observation` | `proposal@6d991576` | §7.13 | `tokenRotationEpoch` 目前只有 CAS 用途，无观测面 | — |
| `token-epoch-mode-rollout` | `proposal@6d991576` | §7.14 | `EXECUTOR_TOKEN_EPOCH_MODE` 从 `off` 置 `on` 仍是**运维动作**，代码默认 ` | — |
| `epoch-and-authz-metrics` | `proposal@6d991576` | §7.14 | 手册要求的两个观察项（`foreign-rotation` 告警频率、执行器 401 率）目前只能看日志/HTTP 计数 | — |
| `runbook-thresholds-unmeasured` | `proposal@6d991576` | §7.14 | 手册的「5–10 分钟」「401 率与基线持平」是**建议阈值**，本环境无生产流量可测 | — |
| `heartbeat-dispatch-fullstack` | `needs-env@6d991576` | §7.15 | 本轮压的是 SQL 层写冲突，未压协议层（鉴权/DTO/调度器选机） | 有 docker + 30 分钟预算：起 admin-api + 执行器 stub，并发心跳与派发，N≥10 轮断言同组 I1/I2/I3 |
| `other-self-reported-counts` | `proposal@6d991576` | §7.15 | `reservedSlots`、`deadLetterCount` 也是客户端自述 + 服务端使用 | — |
| `reserved-slots-floor-when-consumed` | `proposal@6d991576` | §7.16 | 守卫只保证"现在没人消费"，**不保证**"将来消费时会有下限" | — |
| `protocol-race-with-real-task` | `proposal@6d991576` | §7.17 | 协议层并发要有"真任务"才能造执行行 | — |
| `claim-then-row-window` | `proposal@6d991576` | §7.17 | 生产的 `claimExecutorSlotForExecution(candidate, execution)` 要求 | — |
| `display-clamp-i18n` | `proposal@6d991576` | §7.17 | 钳底 0 后，预留说明文案在越界态不显示，但页面没有"数据不一致"的提示 | — |
| `dispatch-assignment-unverified` | `proposal@6d991576` | §7.18 | 三种候选原因**均未验证**：① trigger 只入队、消费侧（BullMQ processor / leader c | — |
| `interleaving-without-subject` | `proposal@6d991576` | §7.18 | 交错发生 ≠ 判定有效：本轮 `claim_at_ms < hb_ms` 成立、心跳 201，但**被观测对象**（本执 | — |
| `heartbeat-latency-budget` | `proposal@6d991576` | §7.18 | 夹具里心跳耗时 6–43s（bcrypt 校验 + 队列压力） | — |
| `guards-chain-runtime-parse` | `proposal@6d991576` | §7.19 | `test:guards:repo` 是 89 段 `&&` 链：任一段失败只留一条兜底报错，**不点名是哪段** | — |
| `interleaving-metric-hygiene` | `proposal@6d991576` | §7.19 | R19 的 `hb_ms` 被自己轮询污染 ⇒ `claim_at_ms < hb_ms` 恒真（假证据） | — |
| `fixture-needs-keepalive` | `proposal@6d991576` | §7.19 | 夹具里执行器会被 stale sweep 判 offline（`consecutiveHeartbeatMisses > | — |
| `replace-chain-with-matrix` | `proposal@6d991576` | §7.20 | R22 已把 `test:guards:repo` 指向矩阵入口、链定义搬进 `test:guards:chain`、退 | — |
| `equivalence-must-be-independent` | `proposal@6d991576` | §7.20 | **反向验证第一次失败**：让"执行序列"与"自己持有的列表"自比 ⇒ 硬编码少一条也自洽通过 | — |
| `matrix-not-in-ci` | `proposal@6d991576` | §7.20 | 矩阵入口**未接 CI**（否则整条 89 段链在 CI 跑两遍；R22 已确认 CI 步骤数未变） | — |
| `pointer-swap-breaks-expanders` | `proposal@6d991576` | §7.20 | **换指针会打断一切"字符串展开链"的工具**：R22 实测 `check-guards-wired` 的 `expan | — |
| `node-side-env-file-hermetic` | `proposal@6d991576` | §7.21 | 若 node 侧曾有同类缺口，**本轮已收口** | — |
| `other-apps-env-hermetic` | `proposal@6d991576` | §7.21 | R24 核查结论：**executor-python 有真运行期入口**（`config.py:142-144` pyd | — |
| `bundle-digest-after-src-change` | `proposal@6d991576` | §7.21 | 改 `executor-node/src/main.ts` 必触发 `check:desktop-bundle-drif | — |
| `skip-env-file-default-policy` | `proposal@6d991576` | §7.22 | R25：约定已成文（`docs/operations.md`「自检环境隔离」）+ 守卫 `check:env-switc | — |
| `web-env-dotenv-presence` | `proposal@6d991576` | §7.22 | `apps/admin-web/.env` 未入库但存在于开发机（含真实 IP 的 `VITE_API_URL_EXTE | — |
| `env-entry-sweep-not-selftested-in-ci` | `proposal@6d991576` | §7.22 | 新守卫的 selftest 已在 CI step 里（`--selftest` + 主跑） | — |
## 8. 一轮结束的交付标准

- [ ] 工作区干净：`git status --short` 无未提交改动（或明确说明遗留）
- [ ] `tsc` 0 错；改动文件的 eslint 0 错
- [ ] 模块级 jest 全绿；守卫脚本全绿；迁移守规（若有新迁移）
- [ ] 提交信息写清：症状 → 根因 → 修法 → 验证 → 反证方式
- [ ] §7 backlog 已更新；`docs/AGENT_HANDOFF.md` 状态快照追加本轮
- [ ] 没有把「看起来能跑」当证据：每条修复至少有一个会在还原后转红的用例
