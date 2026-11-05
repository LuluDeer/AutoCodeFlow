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

已修并提交：`dc3b1ffb`（GAP-3 服务端 + GAP-6 + 守卫保真）、
`574bbf3b`（TOOLS-01 / RT-1 / RT-2 / RT-3 / RT-5 / RT-6）。

剩余（来自首轮 27 条 findings，已去重）：

| 优先级 | id | 一句话 | 状态 / 主要落点 |
|---|---|---|---|
| P1 | TOOLS-02 | 审批 grant 后动作不会执行 | **已修 `d9660f52` + `c023df3d`**（文案按状态渲染 + 运行时确定性重放，执行体就地更新台账行） |
| P1 | TOOLS-03 | 三个写工具 schema↔执行体契约错位 | **已修 `cac3bbcb`** |
| P1 | desktop-poll | poll 下发 3 张只消费第 1 张 | **已修 `d566533c`** |
| P1 | data-1 | 挂起恢复不重开墙钟 | **已修 `c023df3d`** |
| P1 | data-2 | 保留期把 failed 的 steps/approvals 当可丢弃数据 | **已修 `c023df3d`** |
| P1 | obs-1 | 令牌指标记步数不是令牌量 | **已修 `ea2509a6`** |
| P2 | desktop-gap3 | 瞬态续跑全局 resend 打回在途单 | **已修 `d566533c`** |
| P2 | approval-replay | 已批准调用的确定性执行 | **已修 `c023df3d`** |
| P2 | data-3 | appendStep 撞 seq 唯一约束后异常逃出 run() | **已修 `9bce96fe`**（有限重试 + run() 兜底收敛） |
| P2 | desktop-budget | 瞬态失败吃工作预算、误报「迭代轮次已达上限」 | **已修 `a4947bd6`**（plan 抛错回退该轮 + 落盘 streak 封顶 20 + 如实 stopMessage） |
| P2 | TOOLS-04 | 工具超时不取消 → 双份副作用 | **已修 `a49ba0f5`**（AbortSignal 通道 + 写 tier「结果未知」+ 不计熔断；handler 消费 signal 仍为残差） |
| P2 | obs-2 | 文档承诺的「Admin Web 对话」入口不存在 | **已修 `cb9b75ec`**（新建会话弹窗；zh/en 词条 + 用例） |
| P3 | TOOLS-06 | 工具结果未脱敏就落库 | **已修 `a49ba0f5`**（结果/preview 脱敏，digest 保留，sha256 按原文） |
| P3 | desktop-resend | poll 关闭分支全局重发 | **已修 `a4947bd6`**（字段整体删除，逐张定向）；「待重发 id 只在内存」仍为 P3 残差（建议 claim ledger） |
| P3 | data-4 | tool_calls read 档清理不看会话状态 | **已修 `c023df3d`** |
| P3 | obs-3 | budget_exceeded 死入口/过时文案 | **已修 `ea2509a6` + `c023df3d`** |
| P3 | obs-4 | 标签漂移守卫 spec 不存在 | **已修 `ea2509a6`** |
| — | doc-guard | 文档指标名 ↔ 注册表自动比对 | **已做 `327de919`**（`scripts/check-metric-docs.mjs`，15 条 selftest，基线棘轮 + allowlist + 行内豁免，已接 CI） |

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
| **P0（流程）** | guards-chain-first-failure — **✅ R02 已收口（2026-11-05，见 §7.2）** | ~~`test:guards:repo` 是 `&&` 链，第一步红 ⇒ 后面 84 个守卫一个都没跑，而尾部仍在打印 ✔~~ | R01 实测：`test:docs` 的"孤儿文档"判据把 `docs/plan/rounds/AUTONOMY-{LOOP,STATE}.md` 判红 ⇒ 整链 `exit 1`。**R02 复核后修掉两半**：① 两份 docs 已接进 `docs/plan/rounds/README.md` 索引（判据面是 `checkOrphans` 的链接 BFS，入口 `docs/README.md:91`）；② 报告面 —— `check-docs.mjs` 改为「通过先打、失败后打、终态摘要收尾」+ `test:guards:repo` 链尾挂 `\|\| node scripts/guard-chain-fail.mjs $?`，**尾行不再可能是 ✔**。R01 的归因「守卫链报告成功」**不准确**：退出码一直是对的（exit 1），坏的是可见尾部。**剩余**（→ §7.2 P2）：链仍无原生逐条计数 |
| P1 | webhook-posture-cgnat | **`policy:"webhook"` 姿态仍把 `restricted`（CGNAT `100.64/10` + RFC2544 `198.18/15`）放在"开关开启就放行"组里** | `safe-http.util.ts` 的 `allowedWebhook`（`assertSafeHttpUrl` 同）。契约 `networkPolicy` 只管执行器出站五面 ⇒ R01 刻意未动。**风险**：`allowPrivateNetwork=true` 的 webhook/AI 目标仍可达阿里云元数据 `100.100.100.200`。收口二选一：给 webhook 面单独立语义契约 / 一并恒拒（会破 Tailscale webhook）。**必须先定契约再改代码** |
| P1 | admin-outbound-remaining-2-cells | `loopback@on` / `privateIPv4@off` 两格仍未收口（豁免账 2 条 5 格） | 需与 `compose`/`.env` 默认值 + 真机 `r5-dispatch-push` B4/B5 期望**同批**改（B5 实测 `127.0.0.1` 收到过 1 次请求） |
| P2 | contract-switch-semantics-count | 契约 `switch.semantics` 写「其余**五类**」却列了**六个**名字（`addresses` 实有 8 个 key） | 纯文案，**没有任何判据会因此红**（这是它一直没被发现的原因）；建议与"契约文案自检"一起做，判据落 `scripts/check-protocol-three-way.mjs` |
| P2 | four-way-ipv4mapped-single-state | 四向判据的 `ipv4Mapped` 只判**声明态** | 守卫尾注自述的覆盖边界；要判另一态必须复刻"按内嵌 IPv4 分类"逻辑（守卫明确不复刻实现）⇒ 需先解决"判据 vs 复刻"的取舍 |
| P3 | state-card-candidate-staleness | **状态卡候选清单滞后 5~8 轮**（6 条里 5 条已被 HEAD 推翻） | R01 实测：`registerTaskTools` 已 8 行聚合器、`dispatch` 513 行、`ConfigPage` 三 hook 已外提、`TaskDetailPage`/`TaskFormPage` 已收官、冒烟 harness 已可重入 ⇒ 取靶应读台账**末条**的"已知未收口"，不要读中间轮次 |
| P3 | diff-card-inline-columns | `Diff` 卡片内联 3 列（`token` 真实消费点） | `apps/admin-web` 页面 JSX；同 `task-list-columns` 轴，纯口径收益 |
| P3 | smoke-const-constants | `SH_MIN`/`MJS_MIN` 是人工常量（新增场景须同步 +1） | `scripts/verify-smoke-selftest.sh`；漏加 = 下界断言静默失效 |

### 7.2 R02（2026-11-05）新增未修项

R02 收口了 §7.1 的 P0 `guards-chain-first-failure`（细节见 `docs/PLAN-CLAIMS.md` 的 R02 条目），
**没收口的是它下面那层结构问题**：

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| **P2（流程）** | guards-chain-native-accounting | `test:guards:repo` 仍是**扁平 85 段 `&&` 链**，没有原生逐条计数；中断时「跑了多少条」只能靠旁路工具补 | 旁路已落地：`npm run test:guards:repo:report`（`scripts/guards-repo-report.mjs`，名单运行期从 `package.json` 解析，无第二份名单；R02 实测 85/85）。**要做成默认路径**，必须先让接线判据认识执行器：`scripts/check-guards-wired.mjs:424-425` 展开的是 `test:guards` 的**字符串**，改成执行器 ⇒ 74 个守卫的自检面全盲 ⇒ 判据③ 假红。所以这是一次 **meta-守卫改造**（含它自己的 fixture 与基线），不是一次脚本替换 |
| **P2（流程）** | guard-chain-fail-no-segment | 链尾 `\|\| node scripts/guard-chain-fail.mjs $?` 只能**原样传播**首个失败的退出码，拿不到「第几段失败」 | 要拿到段号得把链拆成进程（同上条，被接线判据挡着）。当前取舍：**可见性优先**（尾行必须红），段号交给 `test:guards:repo:report` 的 `[exit N] <name>` 行 |
| P3 | check-docs-root-injection | `check-docs.mjs` 的 `--root=` 只是**测试注入面**，主跑仍固定 `REPO_ROOT` | R02 新增；若别的守卫也想「黑盒跑真 CLI + 临时仓库」，可把这个模式（`--root=<dir>` + `spawnSync` 断言尾行）抽成 `scripts/lib/` 共享件，现在只有 `scripts/docs/check-docs.mjs` 一处 |

### 7.3 R03（2026-11-05）新增未修项

R03 收口了 R02 留下的 `unverified`（跨实例灰度在「创建窗口」内被周期回收器判死，见 `docs/PLAN-CLAIMS.md` 的 R03 条目）。
**本轮买的教训是「本地门禁 ≠ CI」的第二种形态**，所以下面第 1 项优先于业务项：

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| ~~P1（门禁可信度）~~ **✅ R04 已收口（详见 §7.4）** | selftest-env-hermeticity | **20+ 个自检会读到开发者本机的 `.env`** ⇒ 「本机红、CI 绿」，且红点离改动很远，极容易被误判成自己写坏了 | 实证：`apps/admin-api/.env`（符号链接 → 仓库根 `.env`，`.gitignore` 里）让 `test:pull-dispatch` ④⑤ 全红（执行器 `fetchToken`/心跳/回调 **401**）。三条归因：stash 本轮改动仍红 / 只移执行器 `.env` 仍红 / **只移这个符号链接 → 21 套件全绿**。机制：自检传 `EXECUTOR_SECRET=pull-dispatch-executor-secret`（`scripts/pull-dispatch-selftest.mjs:55`），而 `ConfigModule.forRoot({envFilePath:'.env'})` 读到本机 64 字符的 `EXECUTOR_SECRET`。**修法三选一**：① 给 `ConfigModule.forRoot` 加 `ignoreEnvFile: process.env.SELFTEST_HERMETIC === '1'`（改一行应用配置，默认关、生产零变化）+ 自检子进程置位；② 自检把 admin-api 子进程的 cwd 指到临时目录、只放最小 `.env`（要评估 `WORK_DIR`/uploads 等 cwd 相对路径）；③ 自检统一 helper（同 `pg-provision` 助手的位置）集中处理 env 隔离。**先做 ①**，改动面最小且可逐脚本接线 |
| ~~P1（协议一致性）~~ **✅ R05 已收口（详见 §7.5）** | admin-outbound-remaining-2-cells | `loopback@on` / `privateIPv4@off` 两格仍与契约相反（R01 就登记在案，R03 顺延） | 真阻碍**不是代码**，是**期望**：`scripts/verify-smoke-dispatch-push.sh` 的 B4/B5 现在把「开关开启 ⇒ 放通 **loopback**」写成期望（`:27`/`:60`/`:701-750`），而契约 `networkPolicy.addresses.loopback.allowedUnderPrivateNetwork=false` + `switch.semantics`「开关只放行 privateIPv4，其余一律仍拒」。对齐顺序必须是：**① 先改 B4/B5 的取样地址**（loopback → 私网地址，语义变成「默认拒 / 开关放通私网」）→ ② 改 `safe-http.util.ts` 的两处判定（private-lan 受开关、loopback 恒拒）→ ③ 同批改 `compose`/`.env` 的 `EXECUTOR_ALLOW_PRIVATE_NETWORK` 默认值（**admin-api 默认 false 会让默认栈调度不到私网执行器**，这条是部署面风险）→ ④ 删 `scripts/protocol-four-way-allowlist.json` 两条（腐烂检测会当场逼删）。真机跑不了就标 `unverified`，不许谎报 |
| P3 | rollout-lease-micro-window | 创建期写租约后仍留**微秒级**窗口（行已 pending、租约还没写） | 已刻意保留：把租约写在「行标记成功之后」是为了避免「claim 落败时留下 60s 假活租约」。要彻底关闭得让行与租约同一条 UPDATE 写（jsonb 合并），属独立小项 |

### 7.4 R04（2026-11-05）结论与新增未修项

**收口**：§7.3 的 P1 `selftest-env-hermeticity` 已完成（`SELFTEST_SKIP_ENV_FILE=1` ⇒ **三个** `.env`
入口全部跳过；默认关 ⇒ 生产/CI 零变化）。实测：本机开发态 `.env` 符号链接**存在**与**移开**两种
状态下 `test:guards:selftests` 均 **exit 0**，`injected env` 行数 **1 → 0**。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| P2 | env-leak-key-bisect | **没有逐键二分** `133 键里到底是哪几个打掉 401` | 现在不需要（开关已把"读不读 `.env`"定死）。若将来要收紧「哪些键允许来自环境」，再做二分：把根 `.env` 复制到临时文件、逐半删键、`npm run test:pull-dispatch` 观察 401 是否消失。**别再用「移开整个 .env」当证据**——那是本轮之前的手段，粒度太粗 |
| P2 | executor-env-hermeticity | **executor-node 侧**的 `.env` 加载未做同样约束 | `apps/executor-node/src` 自己有一套 config（`apps/executor-node/.env`，本机 232 字节）。R03/R04 实验证明它**不是** 401 的主因，但同类风险仍在：自检起 executor 子进程时它仍会读自己的 `.env`。要做需先数清它的入口（同 77 号教训），再决定是否复用 `SELFTEST_SKIP_ENV_FILE` 语义 |
| P3 | hermetic-env-file-discovery | 开关是"跳过 `.env`"，不是"用指定的 `.env`" | 若将来某个自检**需要**一份受控 `.env`（而不是纯 env 变量），应扩展成 `SELFTEST_ENV_FILE=<path>`（仍默认关）。当前 8 个自检都靠显式 env，无需此能力 |

### 7.5 R05（2026-11-05）结论与新增未修项

**收口**：§7.3 的 P1 `admin-outbound-remaining-2-cells` 已完成 —— admin 执行器出站姿态与契约逐格一致
（私网需开关、loopback 恒拒），四向检查 **5 格不一致 → 0 格**、豁免账 **2 条 → 0 条**、
真机 B4/B5 在**私网取样地址**下八条/七条全绿。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| ~~P1（部署影响）~~ **✅ R06 已收口（公告 + 启动告警 + 判据）** | internal-executor-flag-now-required | 内网执行器现在**必须**显式开 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`；**同机 `127.0.0.1` 执行器不再可用** | 契约要求（`privateIPv4.allowedUnderPrivateNetwork=true` / `loopback=false`）。compose 默认栈已开；但**裸机 + 同机回环**的既有部署会在升级后立刻被 `EXECUTOR_HOST_BLOCKED` 拒。**落点**：`docs/UPGRADING.md` 增一节（v2.0.x → 下个版本）+ `docs/deployment.md` 的「执行器地址」段补一句「回环不可用，请用 LAN 地址或开开关」；发布前必须有一条升级回归用例 |
| P2 | webhook-posture-cgnat | `policy:'webhook'` 姿态仍把 `restricted`（CGNAT/RFC2544）放在开关解锁组 | 与 R01 同源（`assertSafeHttpUrl`/`allowedWebhook`）。契约 `networkPolicy` 只管执行器出站五面 ⇒ 要动得先立一条 webhook 面的契约。**与 R05 是同一族缺陷的第二处**，建议下一轮直接做 |
| P2 | smoke-helper-order-guard | 真机脚本的「helper 定义晚于首次使用」只能靠跑起来才发现 | R05 实地踩到（`recreate_api` 在 step 5 调用、定义在 step 6 ⇒ 报「重建失败」）。建议：`bash -n` 之外补一条静态判据（扫描 `scripts/verify-smoke-*.sh`：调用的函数名必须在其调用点之前出现定义），或至少把 helper 集中到 `verify-smoke-common.sh` |
| P3 | allowlist-empty-state-doc | 豁免账现在**故意为空**（顶格收口） | `judgeAllowlist` 已改成有条件（零分叉允许空、有分叉仍红），并有两条 selftest 双向钉住。将来若有人把它改回「必须非空」，会立刻红并在错误里说明原因 |

**R06 补充（2026-11-05）**：上表 P1 的「公告」已完成 —— `docs/UPGRADING.md` **§11** 写了谁受影响 /
实测症状 / 两条修法 / 自查 / 回滚；`main.ts` 在模块顶层打**启动期可操作告警**（点名开关 + 两条修法 +
指向文档）；新增守卫 `check:upgrade-notes`（四条机读判据）+ spec 4 条，并将 §9 的「破坏性变更：无」
同步改成「1 条」。**仍待办**：`docs/UPGRADING.md` 头部的「核实基线」段还是 2026-11-02 的 commit，
发版前应刷新（不阻塞本轮）。

### 7.6 R07（2026-11-05）待裁决项（无代码变更）

R07 按「先契约后实现」核 webhook 面，结论是**契约自相矛盾** ⇒ 停手待裁决（细节见 `docs/PLAN-CLAIMS.md` 的 R07 条目）。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| **P1（待 Lead 裁定）** | webhook-posture-cgnat-decision | `policy:'webhook'` 面「`restricted` 随开关放行」 vs 文档承诺「云元数据恒拒」——`100.100.100.200`（阿里云元数据）实测落在 `restricted` ⇒ 三开关任一开启即可达 | 契约在 `docs/deployment.md:197-199` + `docs/api-reference.md:1021` + `safe-http.util.ts:44-52` docstring；实现 `safe-http.util.ts:90-93`/`:394-399`。**三方案**：①恒拒（破坏 Tailscale，需 UPGRADING）②契约新增 `metadataAddresses` 恒拒（推荐，需改契约）③改文档降级承诺。**裁定后落点见 artifacts/autonomy/R07/contract-first.md 附录** |
| **P1（独立立项）** | oracle-metadata-classified-public | `192.0.0.192`（Oracle Cloud 元数据）被分类为 **`public`** ⇒ **所有**姿态放行（含 R05 已对齐的执行器面） | 契约 `addresses.reserved.$comment` 已把该类定义为「IANA special-purpose」而 `192.0.0.0/24` 正属其中（RFC 7335）⇒ **分类器与契约不一致**。修法是**分类器**改动（admin `SSRF_DENY_HOST_PATTERNS` + node `ssrf-guard.ts` + python `network_policy.py`），必须三端同批，`check:ssrf-deny-parity` 会盯着 |
| P3 | webhook-face-contract-gap | webhook / AI / 通知面在 `protocol.json` **完全没有契约段** | 它的事实契约目前是"三行 deployment.md + 一段 docstring"，没有机器可判形态 ⇒ 建议裁定后给它一个契约段（与 `networkPolicy` 并列），并让 `check:protocol-three-way` 覆盖它 |

### 7.7 R08（2026-11-05）收口与新增未修项

**收口**：§7.6 的 P1 `webhook-posture-cgnat-decision` 已按 Lead 裁决**方案②**落地 ——
契约新增 `networkPolicy.metadataAddresses`（任何 posture × 任何开关都 DENY），三端从**生成物**同读，
文档三处口径统一 + `UPGRADING §12`。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| **P1（判据缺口）** | ssrf-parity-python-face | `check:ssrf-deny-parity` **只比对两端**（admin 矩阵 ↔ executor-node `ssrf-deny-parity.spec.ts`），**python 不在守卫面内** | 本轮三端同读靠「同一份生成物 + python 自己的 pytest」保证，属**间接**保证。要真正三端覆盖：给 python 建一份 parity 清单（或让守卫静态解析 `tests/test_ssrf_guard.py` 的地址表），并把守卫改成三端矩阵比对。**注意**：改动会让现有"反向不校验"的宽松语义收紧，需同批给出豁免机制 |
| ~~P1（R09 已立项）~~ **✅ R09 已收口** | oracle-metadata-classified-public | `192.0.0.192`（Oracle Cloud 元数据）被判 **`public`** ⇒ 四姿态全放行 | 根因是**分类器**缺 `192.0.0.0/24`（契约 `reserved` 已含该类，属"分类器与契约不一致"）；与 `metadataAddresses` 是两条不同修法。Lead 指示：**R09 独立立项**，本轮不动 |
| P3 | metadata-addresses-cidr | 三端 matcher 目前只支持**单主机**（`/32`）条目 | 契约里 `addresses` 允许写 CIDR，但三端都是「取斜杠前地址做等价比较」⇒ 写 `/24` 会静默不命中。建议：要么契约 `$comment` 里明确"只允许 /32"，要么三端改用真 CIDR 判定（admin 需自写、python 可 `ipaddress`、node 需按位判） |

### 7.8 R09（2026-11-05）收口与新增未修项

**收口**：§7.7 的 P1 `oracle-metadata-classified-public` —— `192.0.0.192` 已入
`networkPolicy.metadataAddresses`（复用 R08 机制），且三端**分类函数**对元数据地址返回 `reserved`
（ADR-029 §7 追加说明）。修前实测四姿态 × 两态**全放行**；修后三端标签一致、四姿态恒拒。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| ~~P1（判据缺口，仍在）~~ **✅ R10 已收口** | ssrf-parity-python-face | `check:ssrf-deny-parity` 只比对两端（admin↔node） | R09 用「三端覆盖判据」在 `check:protocol-three-way` 里直接盯三端**测试文件**（缓解），但 parity 守卫本体仍不含 python。彻底收口需给 python 建 parity 清单文件并改守卫为三端矩阵比对（含反向豁免机制） |
| P2 | iana-special-purpose-sweep | `192.0.0.0/24` 段内还有 5 条**已核对未改**的地址 | 清单与理由见 `artifacts/autonomy/R09/iana-check.md` §4（PCP/TURN anycast 全球可达、DS-Lite 前缀、dummy、NAT64 发现——拒了会误伤合法拓扑）。**没有"元数据/凭据"证据就不动**，这是本轮定下的口径 |
| P3 | metadata-cidr-matcher | 三端 matcher 仍只支持单主机（/32）条目 | 与 §7.7 P3 同一条；`metadataAddresses` 现在有两条 /32，若将来要写网段需先决定 matcher 语义 |

### 7.9 R10（2026-11-05）收口与新增未修项

**收口**：§7.8 的 P1 `ssrf-parity-python-face` —— 新增 `scripts/check-ssrf-three-way-matrix.mjs`
（三端**判定**矩阵守卫）+ `scripts/ssrf-category-matrix.mjs`（真跑探针）+ 豁免清单
`scripts/ssrf-category-parity-exemptions.json`（默认空）；`check:ssrf-parity` 串联两者。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| **P2（覆盖面）** | ssrf-matrix-classification-layer-only | 新矩阵守卫覆盖的是**分类层**，不覆盖**闸的放行逻辑** | 即：它保证三端把同一地址归成同一类，**不**保证三端在「该类 + 某开关」下给出同一放行结论。后者仍靠各端单测 + `check:protocol-three-way` 的第四面（admin 两入口互比 + 逐格 × 两态）。扩到闸层需要定义「放行结论」的机读导出接口（各端都要能导出 allow/deny 矩阵） |
| **P2（覆盖面）** | ssrf-matrix-hostname-not-covered | 主机名（`localhost` / `*.localhost`）**不进矩阵** | 三端在**不同层**判它：node/python 在名字层判 loopback，admin 只在 DNS 结果层判（`classifyAddressRisk` 只处理字面量）⇒ 塞进字面量矩阵会造层错配的假差异。要覆盖需先统一「主机名分类」的接口 |
| P3 | ssrf-matrix-label-diffs-4 | 4 条地址在 admin 与 node/python 的**标签**不同但决策相同 | `0.0.0.0` / `::` / `224.0.0.1` / `239.255.255.250`：admin 并入 `reserved`，node/python 分 `unspecified`/`multicast`。刻意**不登记豁免**（决策轴一致即非缺陷）；若将来要统一标签，改分类器 ⇒ 需三端同批 |

### 7.10 R11（2026-11-05）换轴到真机并发：结论与新增未修项

R01–R10 全吃 SSRF/契约/守卫线，边际收益递减 ⇒ R11 换轴测**运行时并发正确性**。
本轮建立真机并发回归（`scripts/executor-register-race-selftest.mjs`，docker PG + 真 admin-api），
**历史担心的接管 CAS 竞态真机未复现**；但用**代码层注入判据**稳定复现并修掉一个**相邻写窗口**
（`register()` 指纹命中路径无谓词 ⇒ 可被并发接管后覆盖）。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| **P1（覆盖面）** | runtime-concurrency-only-one-axis | 运行时并发面目前只有**执行器注册**这一轴 | 同族高风险面还没测：`issueToken` 的幂等签发（R9 的 `(address,startupId)` 复用）、心跳对 `runningTaskCount` 的覆盖写 vs 派发占坑、`rolloutBatchClaimId` 的唯一索引 CAS（R03/R05 已修过租约但**未在真机并发**下压过）、`agent_approvals` 一次性 consume。建议按「一轴一轮」继续换轴压 |
| **P2（判据强度）** | race-window-needs-injected-interleaving | 真机 10 轮没触发交叉写窗口（窗口极窄） | 现在的红来自 repo 替身注入。要真正压出来需要**人为延迟**（DB 层 sleep / before-commit hook）或加乐观锁版本列（后者要 ADR + 迁移）。在此之前**不许**把「真机 10 轮绿」写成「竞态不存在」 |
| P3 | race-selftest-not-in-offline-chain | `test:executor-register-race` **不进** `test:guards:repo`（需 docker，~2min） | 现挂在 `package.json` 独立脚本，靠 `test:guards:selftests` 面另行调度。若要进门禁，建议放 `test:guards:selftests` 并在 CI 用 service container 起 PG |

### 7.11 R12（2026-11-05）真机并发第二轴（token 幂等）+ 真机用例接链

**收口**：`issueToken` 的 `(address,startupId)` 幂等在**并发下完全失效**（真机 4 并发 × 6 轮
每轮 4 次轮换）⇒ 按身份串行化后 10 轮稳定 1 次；两条真机用例接进 `test:guards:selftests`，
并新增「引用存在」守卫（`check:race-selftests-wired`，含双层反向验证）。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| **P1（幂等的跨实例面）** | token-idempotency-cross-instance | 串行器只在**单进程**内生效：两个 admin-api 实例并发签发同一身份仍各轮换一次，先返回的令牌立刻作废 | 需要共享存储（Redis 存明文 + TTL）或改设计（只存哈希、签发幂等键由 DB 唯一约束保证）。**属 ADR 级决策**（涉及凭据明文出仓、失效半径、回滚），不是补丁 |
| **P2（真机面覆盖）** | runtime-concurrency-axes-remaining | 真机并发目前覆盖 **2 轴**（注册接管 CAS / token 签发幂等） | 仍缺：心跳 `runningTaskCount` 覆盖写 vs 派发占坑、`rolloutBatchClaimId` 唯一索引 CAS、`agent_approvals` 一次性 consume、`issueToken` 与 `rotateToken`（管理面）互踩。建议一轴一轮 |
| P3 | race-selftests-in-selftests-chain | 两条真机用例挂在 `test:guards:selftests`（需 docker，分钟级） | 已由 `check:race-selftests-wired` 钉住「必须在链里」；但**离线开发**仍可能长期不跑。若要更强的日常覆盖，建议给它们加 `--rounds=2` 的快速模式并挂到 pre-push |

### 7.12 R13（2026-11-05）跨实例 token 幂等：ADR 结论与落地排期

**结论**：ADR-030 采纳 **②′（确定性派生 + `tokenRotationEpoch` CAS）**；否决 ①（Redis 明文缓存：
失效时**静默**退回已确诊缺陷 + 把凭据明文搬进中间件）、③（单写者 lease：不解决「输家拿不到明文」，
且与 R03/R11 语义互撞）。本轮只落**症状告警**（行为零改变），改实现 + 迁移排下一轮。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| **P1（下一轮开工项）** | token-epoch-derivation | 按 ADR-030 §4/§6 落地 ②′：`tokenRotationEpoch` 迁移 + `issueToken`/`rotateToken` 派生 + CAS + 两实例真机 N≥10 轮 | 实施顺序（ADR §5.2）：迁移 → 派生（`EXECUTOR_TOKEN_EPOCH_MODE=off` 默认关）→ 两实例用例接链 → 全绿后默认 `on` → 删本轮的症状告警段（`executor.service.ts` 回落 4288） |
| **P2（凭据面）** | derivation-secret-lifecycle | 派生密钥 `EXECUTOR_TOKEN_DERIVATION_SECRET`（缺省回落 `EXECUTOR_SECRET`）的轮换语义未定 | 换密钥 ⇒ **所有派生令牌立即失效**（执行器 401 后自愈，代价是一次全机队轮换）。需要一条"换密钥的运维手册" + 启动告警，与本轮 ADR 同批或下一轮补 |
| P3 | epoch-column-reserved | `tokenRotationEpoch` 必须**只增不跳号**（跳号会让两枚不同令牌对应同一行；回退会让历史令牌复活） | CAS 严格 `= :epoch`；`down()` 后列消失，无回退面（ADR §5.4 已记）；实现时补一条"epoch 单调"的确定性用例 |

### 7.13 R14（2026-11-05）ADR-030 ②′ 落地：跨实例 token 幂等成立

**结论**：确定性派生 + `tokenRotationEpoch` CAS 已落地，`EXECUTOR_TOKEN_EPOCH_MODE` **默认 off**。
真机两实例（mode=on）10 轮 × 4 并发 **两实例返回同一枚令牌**；混跑（新×旧）按 ADR §5.2 不幂等
但**不打死令牌**。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| **P1（上线动作）** | token-epoch-mode-rollout | `EXECUTOR_TOKEN_EPOCH_MODE` 何时置 `on` 属**运维决策**，不在代码里 | 上线顺序：逐实例升级 → 全绿后统一置 `on` → 观察 `foreign-rotation` WARN 是否消失（该 WARN 仍是 R13 的过渡措施，`on` 之后应清零，届时可删该段并把 `executor.service.ts` 体量回落） |
| **P2（密钥生命周期）** | derivation-secret-lifecycle | 换 `EXECUTOR_TOKEN_DERIVATION_SECRET` = **全部派生令牌立即失效**（一次全机队轮换） | 需要运维手册 + 启动告警；现已在 `.env.example` 注释里写明，但没有强制提示（§7.12 P2 仍未收口） |
| P3 | epoch-observation | `tokenRotationEpoch` 目前只有 CAS 用途，无观测面 | 建议加一个只读指标（按 epoch 分布）用于判断"轮换风暴是否已止"——正是本轮要治的症状 |

### 7.14 R15（2026-11-05）派生密钥运维债收口（含 ADR 假设被推翻）

**收口**：ADR-030 §7.12-P2。交付手册（`docs/operations.md` 一节 + `UPGRADING §14`）、
启动告警（`config/token-derivation-posture.ts` + `main.ts` 接线）、机读守卫
（`scripts/check-ops-runbook.mjs`，`test:guards:repo` **87→88 段**，CI 同步）。
**并修正 ADR-030 §5.4 的错误假设**：换派生密钥**不吊销**已签发令牌（实测），
受影响的是跨实例幂等与下次按需轮换；回退可行。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| **P1（上线动作，仍未做）** | token-epoch-mode-rollout | `EXECUTOR_TOKEN_EPOCH_MODE` 从 `off` 置 `on` 仍是**运维动作**，代码默认 `off` | 顺序见 §7.13 P1；现在手册已具备（灰度/观察/回退），可以按手册执行。执行后观察 `foreign-rotation` 告警是否清零，清零即可删 R13 过渡段并把 `executor.service.ts` 体量回落 |
| **P2（观测面）** | epoch-and-authz-metrics | 手册要求的两个观察项（`foreign-rotation` 告警频率、执行器 401 率）目前只能看日志/HTTP 计数 | 建议加只读指标：按 `tokenRotationEpoch` 分布 + 令牌校验 401 计数按地址聚合，届时手册的"观察"步骤可换成看板 |
| P3 | runbook-thresholds-unmeasured | 手册的「5–10 分钟」「401 率与基线持平」是**建议阈值**，本环境无生产流量可测 | 上线演练后回填真实数字（本轮已在 verify.log 标注"非实测"） |

### 7.15 R16（2026-11-05）真机并发第 3 轴：心跳 vs 派发占坑

**结论**：心跳的 `runningTaskCount` 是**客户端快照覆盖写**，与派发的**原子 +1** 打同一列 ⇒
窗口内落地的占坑会被抹掉 ⇒ **超卖**（真机两连接 20/20 轮复现）。修法 = 落库前取
`max(客户端上报, 服务端在途占坑数)`（纯函数 `heartbeat-count.util.ts`），无 schema/迁移。
**真机证据是「真 PG + 生产 SQL 形状的两条独立连接」**，不是全栈 HTTP。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| **P1（把真机做到全栈）** | heartbeat-dispatch-fullstack | 本轮压的是 SQL 层写冲突，未压协议层（鉴权/DTO/调度器选机） | 起 admin-api + 一个执行器 stub，并发 `POST /api/executors/heartbeat` 与调度器派发，N≥10 轮断言同一组 I1/I2/I3；可复用 R14 的两实例 harness 骨架 |
| **P2（同族列）** | other-self-reported-counts | `reservedSlots`、`deadLetterCount` 也是客户端自述 + 服务端使用 | `reservedSlots` 有 `≤ runningTaskCount` 配对校验（`executor.service.ts:3286-3296`），但**没有**与"服务端在途"取大的下限；派发闸若开始消费它，会出现同型超卖 ⇒ 消费前先补同样的下限 |
| P3 | release-path-race | 释放路径 `GREATEST(count-1,0)` 与心跳并发时同样可能被覆盖（本轮 I2 未复现，因释放后计数已能回落） | 若将来出现"计数虚高不下"的现场，先查是否心跳把 `-1` 盖掉；同一修法（取大不行，需要"取大 + 允许减到在途"）已被本轮实现覆盖 |

### 7.16 R17（2026-11-05）`reservedSlots`：无消费点 ⇒ 守卫钉事实

**结论**：R16 台账里的 P2 —— 同族列 `reservedSlots` **当前没有任何容量消费点**
（派发/容量面零命中，其余 8 处是展示/透传/schema/上报侧，逐条登记），
故按立项走**路 B**：不加死代码，改为 `check:reserved-slots-consumer` 守卫
（`test:guards:repo` **88→89 段** + CI）。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| **P1（消费点出现时）** | reserved-slots-floor-when-consumed | 守卫只保证"现在没人消费"，**不保证**"将来消费时会有下限" | 一旦有人要拿它做容量判断：不要只登记 `KNOWN_READERS`，而应**同时**补「不低服务端在途占坑」的下限（复用 `heartbeat-count.util.ts` 的 `resolveHeartbeatRunningTaskCount`，别复制），并把守卫的 `CAPACITY_SURFACES` 那条改成"该文件必须引用该纯函数" |
| **P2（展示口径）** | running-minus-reserved-drift | 详情页「实际运行 = `runningTaskCount − reservedSlots`」在 R16 后可能为**负**（`runningTaskCount` 被抬到在途下限，而 `reservedSlots` 仍是客户端上报值） | 展示层应 clamp 到 ≥0，或改为"以 `runningTaskCount` 为准、`reservedSlots` 仅作副标题"。属展示口径，不影响放行 |
| P3 | reserved-slots-semantics-vs-inflight | `reservedSlots` 的语义是"pull 预留**未领取**"，与「服务端在途执行」不是同一集合 | 若将来真要给它加下限，**不能**直接套 R16 的公式（那会把"预留"和"在途"混为一谈），需要先定二者的换算口径 |

### 7.17 R18（2026-11-05）展示口径钳底完成；协议层并发只到「骨架已验、卡在造前置数据」

**A（完成）**：`resolveRunningCount` 纯函数（`apps/admin-web/src/utils/executor-metrics.ts`），
`reserved > occupied` 时显示 **0** 而非退回 occupied；页面两处改用它；只动展示不动存储。

**B（部分完成，卡点明确）**：协议层 harness 已能起真 admin-api + 真 HTTP 心跳（10/10 轮 201）
并**证明交错发生**（`claim_at_ms 5–6ms < hb_ms 170–220ms`）；但**占坑侧造不出执行行**
（`task_executions` 的 NOT NULL `taskId`/`taskName` + `tasks` 外键），故在 `claimed===0` 时**主动判红**。

| 优先级 | id | 一句话 | 现已核实的事实 / 建议落点 |
|---|---|---|---|
| **P1（B 的正解）** | protocol-race-with-real-task | 协议层并发要有"真任务"才能造执行行 | 用真 API 建 application→task→（触发一次派发）拿到真实执行行，再并发心跳；或在 CI 里 seed 一个最小 task（SQL 需先摸清 `tasks` 的 NOT NULL 列集合）。**不要**为了绿而把 `claimed===0` 判成 ok |
| **P2（执行行与占坑的原子性）** | claim-then-row-window | 生产的 `claimExecutorSlotForExecution(candidate, execution)` 要求执行行**已存在**，故 R16 的下限总能看见它；但"行已建、占坑未成"与"占坑已成、行未建"两个中间态哪个可达，**未验证** | 若存在"占坑已成、行未建"的顺序，则 R16 下限会漏算 ⇒ 需要把两者放进**同一事务**（并加断言复检） |
| P3 | display-clamp-i18n | 钳底 0 后，预留说明文案在越界态不显示，但页面没有"数据不一致"的提示 | 可在越界态给一条轻量提示（当前刻意不显示，避免误导；若运维需要可加） |

---

## 8. 一轮结束的交付标准

- [ ] 工作区干净：`git status --short` 无未提交改动（或明确说明遗留）
- [ ] `tsc` 0 错；改动文件的 eslint 0 错
- [ ] 模块级 jest 全绿；守卫脚本全绿；迁移守规（若有新迁移）
- [ ] 提交信息写清：症状 → 根因 → 修法 → 验证 → 反证方式
- [ ] §7 backlog 已更新；`docs/AGENT_HANDOFF.md` 状态快照追加本轮
- [ ] 没有把「看起来能跑」当证据：每条修复至少有一个会在还原后转红的用例
