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

---

## 8. 一轮结束的交付标准

- [ ] 工作区干净：`git status --short` 无未提交改动（或明确说明遗留）
- [ ] `tsc` 0 错；改动文件的 eslint 0 错
- [ ] 模块级 jest 全绿；守卫脚本全绿；迁移守规（若有新迁移）
- [ ] 提交信息写清：症状 → 根因 → 修法 → 验证 → 反证方式
- [ ] §7 backlog 已更新；`docs/AGENT_HANDOFF.md` 状态快照追加本轮
- [ ] 没有把「看起来能跑」当证据：每条修复至少有一个会在还原后转红的用例
