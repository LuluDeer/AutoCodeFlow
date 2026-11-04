# 多 Agent 审计-修复循环（可复用编排）

> 面向「同一时刻至多 5 个子 Agent，持续对仓库做全方位优化/改造/修复」的
> **可复用流水线**。不是一次性报告：每次循环都按同一套域划分、写冲突规则与
> 验证矩阵执行，产出可提交的 commit，并把未修项登记回本文 §7 的 backlog。

最后核对：2026-11-05（最近一轮：R05 收口协议两格 —— 实现/契约/真机期望/豁免四方对齐，见 §7.5）

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

---

## 8. 一轮结束的交付标准

- [ ] 工作区干净：`git status --short` 无未提交改动（或明确说明遗留）
- [ ] `tsc` 0 错；改动文件的 eslint 0 错
- [ ] 模块级 jest 全绿；守卫脚本全绿；迁移守规（若有新迁移）
- [ ] 提交信息写清：症状 → 根因 → 修法 → 验证 → 反证方式
- [ ] §7 backlog 已更新；`docs/AGENT_HANDOFF.md` 状态快照追加本轮
- [ ] 没有把「看起来能跑」当证据：每条修复至少有一个会在还原后转红的用例
