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

### 7.0-现状（**R132 重构 · R138 增行 · R139 收口 · R140 收口 · R141 收口 · R142 增行 · R143 收口 · R144 收口 · R145 收口 · R146 收口 · R147 收口 · R148 收口 · R149–R150 收口 · R151 收口 · R152 收口 · R153 收口** · **主表只放未修项：3 条**）

> **表头规则（R132 起，机械执行、不用再问）**：主表**只放「当前该做什么」**。
> 已收口项一律进 `§7.0-A`，主表只留**一行指针**。
> **清理阈值**：主表 `resolved` 行 ≥ 1 **或** 总行数 ≥ 5 ⇒ **触发清理**（把 resolved 行挪进 `§7.0-A`）。
> 判断只看**状态列**，不看轮次与日期：`resolved` 一律算已收口。
> **R138 增行说明**：R138 只读审计（`artifacts/autonomy/R138/`）把 5 条真缺口按状态词上台，
> 主表 **3 → 8 条**（`needs-fix` 5 / `unverified` 2 / `needs-ops` 1）。**`resolved` 仍为 0**
> ⇒ 没有一条可迁 `§7.0-A`，「总行数 ≥ 5」这条阈值本轮**只作提醒、不触发迁移**；
> 压主表的办法是**分类进池**（F-3 / F-4 / F-5 与 P3 三连已写进
> `docs/plan/rounds/AUTONOMY-STATE.md` 的候选池，不占主表）。
> **R139 收口说明**：R139 落地 3 个提交（`d7d27f39` / `66b87e16` / `4c88dac0`），
> 主表 **8 → 5 条** —— `ui-p2-1-sop-video-states` / `ui-p2-2-exec-packages-crosspage` /
> `ui-p2-3-sse-background-tab` 三条转为 `resolved`，按阈值规则迁入 `§7.0-A` 的 **A-3 本季收口（R139）**。
> **迁出的三条各自还带两条已收口的同型项**（P3-2 / P3-3 随 `4c88dac0` / `66b87e16` 修掉；
> F-3 OTel 宣称随 `d7d27f39` 收口）—— **F-3 此前不在主表，故不新增主表行**，
> 只在 `§7.0-A` 记一行。**P3-1（`SopsPage.tsx:1091` 指派弹窗错误态误报）本轮未修**，
> **只进候选池、不进主表**。
> **R140 收口说明**：R140 落地 2 个提交（`e5aa8e80` / `8996b82b`），主表 **5 → 3 条** ——
> 两条 `needs-fix` 转为 `resolved`：`coverage-floor-freshness`（棘轮补「数据新鲜度」判据）/
> `f-2-misfire-no-ui`（补 misfire 策略控件），按阈值规则（`resolved` ≥ 1 **且** 总行数 ≥ 5，两条都触发）
> 迁入 `§7.0-A` 的 **A-4 本季收口（R140）**；同批还在 A-4 记一行
> **`web-type-field-drift` 的 `missing:misfireStrategy` 陈旧豁免已删**（顺带项，此前不在主表）。
> 剩下 3 条**本轮一条都没动**：`ci-pg-race-unverified` / `web-flake-not-reproduced`（都需 CI 真跑或长窗口观测）、
> `release-notice-ops`（发布动作属运维）—— 三条的**重启条件都不在自治循环内**，故主表停在 3。
> **R141 收口说明**：R141 落地 2 个提交（`4484efbc` / `dabf3e10`），主表 **仍是 3 条** ——
> 本轮关闭的两项**此前都不在主表**（P3-1 只在候选池、F-4 只在候选池），按表头规则
> 「**不要往主表加再迁走**」⇒ 直接在 `§7.0-A` 新增一组 **A-5 本季收口（R141）** 记两行，
> **主表 3 条一行未动**。P3-1（`SopsPage.tsx:1091` 指派弹窗错误态误报）**本轮已修**
> （`4484efbc`：三态 `loading｜ready｜error`，失败态用既有 `StateError` + 重试、**不再报空态**）；
> F-4（模板导入端点）**本轮已做文档收口**（`dabf3e10`）。
> **R142 增行说明**：R142 落地 3 个提交（`87251fa6` / `57b9cc54` / `176ef68e`），
> 主表 **3 → 4 条** —— 新增 `coverage-snapshot-vs-full-health`。
> 这条**不是**「还没做」，而是**本轮扩端引入的结构性陷阱**：
> 覆盖率棘轮扩到 admin-api 时**只**接了 `scripts/coverage-snapshot.mjs` 这一条写基线的路径，
> 而 `scripts/health-snapshot.mjs:249` 的**同端 step 仍不带 `--coverage`**
> ⇒ 将来跑一次**全量体检**会把该 step 重写为「无 `coveragePct`」，棘轮**随即红**。
> 它属「**当前该做什么**」（属 `needs-fix`），故**进主表**。
> 本轮关闭的两项（F-5 导出入口 / F-4 文档口径）**此前都不在主表**
> （F-5 只在 R141 候选池），按表头规则「**不要往主表加再迁走**」
> ⇒ 直接在 `§7.0-A` 新增一组 **A-6 本季收口（R142）** 记两行，
> **主表其余 3 条一行未动**。
> **R143 收口说明**：R143 落地 4 个提交（`57f301a6` / `4d961b86` / `6a3f02ad` / `a70df980`），
> 主表 **4 → 3 条** —— `coverage-snapshot-vs-full-health` 转为 **resolved**
> （`57f301a6`：全量体检的 admin-api 默认环境步**接上带 coverage 的跑法**，
> 并**直接 import** `scripts/coverage-snapshot.mjs` 的 `ENDS["admin-api"]` ⇒ 跑法 args / cwd /
> json-summary 落点 / 选步规则**单一事实源**，**禁止内联第二份命令**；`code !== 0` 写
> `coveragePct: null` 不伪造。同提交新增 **`--only=<关键字>` 单步通道**
> （只重跑 label 命中的步、其余 step **原样沿用**；与 `--skip-heavy` **互斥 ⇒ exit 2**；
> 0 命中 ⇒ exit 1）—— 此前要验证这一步**必须跑 30–40 分钟全量**）。
> 按规则（`resolved` ≥ 1 触发清理）迁入 `§7.0-A` 的 **A-7 本季收口（R143）**。
> **教训已固化**：「**扩一个数据源时必须点名所有写入端**」（R142 只接了单端快照、
> 漏了全量体检 ⇒ 一次体检就把数据擦掉）—— 该条在 R142 已写进方法学 256，
> **但「写下」不等于「还清」**，直到本轮真跑一次体检才验证到 ⇒ 方法学 **258**。
> 本轮另外三件（A6b 三端补齐 / atlas 数字同步 / `--only` 单步通道）**此前都不在主表**
> （A6b 只在 R138 候选池），按表头规则「**不要往主表加再迁走**」⇒ **只在 `§7.0-A` 记行**。
> **R144 收口说明**：R144 落地 3 个提交（`8358ba0a` / `188accdc` / `a282a2d4`），
> **主表仍是 3 条** —— 本轮收口的两项**此前都不在主表**
> （i18n 守卫的既有红只在候选池、棘轮 per-step 时间戳只在候选池），按表头规则
> 「**不要往主表加再迁走**」⇒ 直接在 `§7.0-A` 新增一组 **A-8 本季收口（R144）** 记 3 行，
> **主表 3 条一行未动**。两项都是**修守卫自己**：① i18n 那 6 处「新增硬编码中文界面串」
> **判据没写错、采集面没收窄**（`apps/admin-web/src/test-setup.ts` 是 vitest `setupFiles`，
> 那两串只在测试失败时抛进日志、浏览器永不渲染）⇒ 修**扫描面**（显式 `SKIP_FILES` 确切文件名，
> `src/**/*.test.ts` 仍被扫）而**不登记豁免**（`baseline.accepted` 是「登记代替修复」）；
> ② 覆盖率棘轮的新鲜度只读**文件级** `generatedAt`（粒度=天）⇒ 一侧假绿
> （`--skip-heavy` 前移日期却不重测任何 step）、一侧假红（单端快照真跑了却不更新日期）
> ⇒ 每个 step 新增 **`measuredAt`**（该 step 跑完的真实时刻，小时级），判据
> 「**per-step 优先 → 回落文件级 → 都缺即红**」并让报文点名来源；`maxAgeDays` 保留 +
> 新增可选 `maxAgeHours`，**两者都声明时取更严者**（`min`）。
> **教训已固化**：**「假红」要先分清是判据错还是采集面错**（→ 262）、
> **守卫缺 selftest = 判据面本身没人守护**（→ 263）、
> **「日期/时间」字段要区分「文件级」与「测量级」**（→ 264）、
> **两个上限并存时取更严者，别定「谁优先」**（→ 265）。
> **R144 遗留、待办（不上主表）—— R145 已收口（`f10e2a76`，见 A-9 第 1 条）**：
> R144 当时 `node apps/admin-web/scripts/i18n-scan.mjs --selftest`（9 例）**只能手动跑**
> （`apps/admin-web/package.json` 的 `lint:i18n` 只串 `--check` + `i18n-key-check.mjs`，
> `ci.yml` 的 i18n step 也没有它；而 `scripts/check-guards-wired.mjs` 的采集面是
> `^check-.*\.mjs$` ⇒ **不会**替它报警）。R145 的修法是「**改入口、不改 CI**」：把 selftest
> 并进 `lint:i18n` 的脚本行 —— CI 的 admin-web step 调的正是 `npm run lint:i18n`
> ⇒ **本地与 CI 共用同一入口**，不重复、不动 action/runner 面。原文结论保留只为对账：
> **补了 selftest 却不接线 = 判据面仍然无人守护**（**该条已由 `f10e2a76` 还清**）。
>
> **R145 收口说明**：R145 落地 2 个提交（`f10e2a76` / `dc23ad9b`），**主表仍是 3 条** ——
> 本轮两项**此前都不在主表**（i18n 自检接线只在 R144 候选池第 1 条、MCP 错误码可读成因
> 只在 R143 候选池第 2 条），按表头规则「**不要往主表加再迁走**」⇒ 直接在 `§7.0-A`
> 新增一组 **A-9 本季收口（R145）** 记 2 行，**主表 3 条一行未动**。
> 两项都是**补最后一米**：① R144 给 `i18n-scan.mjs` 补了 `--selftest`（9 例）**却没人跑**
> ⇒ 并入 `lint:i18n`（**两次调用**，`--selftest` 与 `--check` **互斥**；**顺序固定先自检、
> 再主判据**；**未改 `ci.yml`**）；② `trigger_task` 被拒时 MCP 只透传后端 HTTP 错误
> （`API error (409): …`）⇒ 新增 `packages/mcp-server/src/error-hints.ts` 按**码**给
> `cause` + `nextStep`（3 条 A6b 码），`packages/mcp-server/src/api.ts` 的 `buildHttpError`
> **追加**提示，**未知码 / 无码 / 原型链键 ⇒ `null` ⇒ 既有输出逐字节不变**。
> **教训已固化**：**「绿」不等于「自检被跑到」**（→ 266）、
> **跨包复用的三种否决理由要分开写**（→ 267）、
> **兜底映射必须「未知即原样」**（→ 268）、
> **第二份事实源要自带复核命令与同步提示**（→ 269）。
> **R145 待办（不上主表、也不是收口项）—— R146 已收口（`a13f0b88`，见 A-10 第 1 条）**：
> **MCP 第二份码表的同步无 CI 守卫** ——
> `packages/mcp-server/src/error-hints.ts` 的键集合与后端
> `apps/admin-api/src/common/errors/catalog/task.ts` 的 A6b 码集合漂移时**不会有任何东西
> 变红**（只有头注的三条 `grep` 复核命令与人的自觉）。写域含根 `scripts/**` 或
> `packages/mcp-server/**` ⇒ 属**独立切片**，只进
> `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 1 条，**此处只留指针**。
> **原文结论保留只为对账**：**头注里的「两边都要看」是提醒、不是机制** ——
> R145 已写进方法学 269（「第二份事实源要自带复核命令与同步提示」）并**明确登记了
> 「同步仍靠人、无 CI 守卫即登记为遗留」**，但**「写下」不等于「还清」** ⇒ 直到 R146 真把
> 守卫做出来，这条才还清（→ 271）。

| # | id | 状态 | 为什么还没修 / 重启条件 |
|---|---|---|---|
| 1 | `ci-pg-race-unverified` | **unverified** | 真机 PG 并发自检已接 CI 与链（`npm run test:pg-race`，链第 98 段），本地只能验「无 PG ⇒ SKIP」与「有 PG ⇒ 2/2 通过」；**CI 真跑本地无法验证** |
| 2 | `web-flake-not-reproduced` | **unverified（推进一格）** | **B1（test 级判红）+ C1（`afterAll` 收窄窗口）生效后 2/2 全量绿、三口径浮空报文 0** ⇒ 不再是「可能被静默吞掉」。但 **R53 那次 `exit 1` 且 `passed=—`（无汇总行）指向的「进程中途被杀」未排除**，且当时 `signal` 未记录（R91 才补）⇒ 只推进一格，不等于根因定位。**R133–R135 已上线观测通道**：`web-flake-watch`（nightly、`continue-on-error` 不阻断、web 全量跑两遍、每轮日志带 `EXIT_N`、artifact 14 天、`meta.txt` 记环境；**有意不加 `--retry`**）⇒ 现在的问题是「有了持续采样」而非「无法观测」 |
| 3 | `release-notice-ops` | **needs-ops** | 发版公告已写（`docs/RELEASE-NOTES-ssrf-posture.md`），**发布动作属运维**，不在自治循环范围内 |

> **已收口 43 条见下节 `§7.0-A`**（本季 38 + R35 历史 5；按**唯一收口项**计 —— A-6 的「裁定不做」项与
> 指针行不重复计；A-14 第 3 条「F5 的可测化 / DOM 层断言」是 R152 新增的**独立收口项**
> ——它与第 2 条「F5 的判据落地」**不是同一件事**：一条是**产品行为**，一条是**判据本身**）——主表不重复列出；
> 各条的完整链条在 `docs/PLAN-CLAIMS.md`（R116 / R121 / R127 / R131 / **R139** / **R140** / **R141** / **R142** / **R143** / **R144** / **R145** / **R146** / **R147** / **R148** / **R149–R150** / **R151** / **R152** / **R153** 各组），此处只留「去哪查」。
>
> **R139 未上台的同类项**（刻意放候选池，避免主表膨胀）：F-4 模板导入端点已存在但文档/入口缺失、
> F-5 任务定义导入导出无控制台入口，以及 **P3-1**（`SopsPage.tsx:1091` 指派弹窗「可接单执行器读取失败」
> 被显示成「没有可接指派的执行器」并给出错误处置建议）—— 见
> `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」。
> **R141 已把其中 P3-1 与 F-4 收口**（见 **A-5**）；**R142 已把 F-5 的「导出定义」单入口收口**（见 **A-6**），
> **只剩 F-6（导入入口）** —— 而它是「**已裁定不做**」，不是待办。
>
> **R142 已收口的 F-5（指针）**：**F-5 任务定义导入/导出控制台无入口** —— 上一段写的
> 「已评估、待下轮做」**已过时**，本轮做掉的是**导出单入口**：
> 后端 `apps/admin-api/src/modules/task/task.controller.ts:185`（导入，有审计 `task.import`）/ `:776`（导出，**无审计**）；
> CLI `packages/acf-cli/src/commands/tasks.ts:725/754` 与 MCP
> `packages/mcp-server/src/tools/task-operations.ts:55/67` **都有**，**admin-web 0 命中** ⇒ 是缺口。
> 但**文档并未承诺控制台入口**（`docs/api-reference.md:590` 只写「跨环境迁移通道」）⇒ 属
> 「能力面不一致」而非「文档说谎」⇒ **不占主表**（主表会膨胀），只进状态卡候选池。
> **R142 切片（已落地）**：只做「**导出定义**」单入口，**导入不做**；**硬约束** ——
> `TaskDetailPage.tsx` 实测 **1034 / 上限 1039**、`TaskListPage.tsx` **711 / 上限 715**
> ⇒ **只剩 5 / 4 行余量**，**必须外提**（新建 `apps/admin-web/src/pages/task-detail/useTaskDefinitionExport.ts`），
> **不许调高 `maxLines`**；且该导出端点**不经 envelope** ⇒ 前端必须 `responseType: 'blob'`。
> **落地结果**：`TaskDetailPage` 非注释 1034→**1037 / 上限 1039**、最长函数 1012→**1010**
> （未调 ceiling、未用 ALLOW）；新用例 5/5、task-detail-* 回归 6 文件 23 例 = 0。
>
> **R143 已收口的 `coverage-snapshot-vs-full-health`（指针）**：见 **A-7** 第 1 条。
> **R143 遗留、刻意不上主表**：**MCP 侧 400/409 的可读成因未映射** ——
> `trigger_task` 的 description 已写清「仅 cron（非 cron ⇒ 400）、已有未消耗登记 ⇒ 409」，
> 但**错误文案仍是透传的后端 HTTP 错误**（CLI 已有错误映射**可复用**，MCP 无）。
> 它属「**能力面不一致**」而非「文档说谎」⇒ 进**主表会膨胀** ⇒ 只进
> `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 2 条，**此处只留指针**。
>
> **R144 已收口的两项（指针）**：见 **A-8** 第 1/2 条 ——
> ① `npm run lint:i18n` 的**既有红**（`apps/admin-web/src/test-setup.ts` 6 处）**由红转绿**（`8358ba0a`）；
> ② 覆盖率棘轮的新鲜度从**只认文件级日期**升级为**两级**（per-step `measuredAt` 小时级 →
> 回落文件级 `generatedAt` 天级）（`188accdc`）。两项**此前都不在主表**（都只在候选池）
> ⇒ 按「**不要往主表加再迁走**」**只在 `§7.0-A` 留痕**，主表**维持 3 条**。
>
> **R144 待办（不上主表、也不是收口项）—— R145 已收口（`f10e2a76`）**：**i18n 守卫的
> selftest 未接 CI** 已还清，见 **A-9** 第 1 条；本条只留对账痕迹（「写下」不等于「还清」——
> R144 在方法学 263 里已提示「补了 selftest 还要接线」，但它当时**只是一句提醒**，
> 接线本身留到了 R145）。
>
> **R145 已收口的两项（指针）**：见 **A-9** 第 1/2 条 ——
> ① i18n 守卫的 `--selftest`（9 例）**接进 `lint:i18n` 的脚本行**（`f10e2a76`；
> **未改 `ci.yml`** —— CI 的 admin-web step 调的就是 `npm run lint:i18n` ⇒ 同一入口）；
> ② MCP 侧**按码**补「成因 + 下一步」（`dc23ad9b`；`packages/mcp-server/src/error-hints.ts`，
> **未知码 ⇒ `null` ⇒ 既有输出逐字节不变**）。两项**此前都不在主表**（都只在候选池）
> ⇒ 按「**不要往主表加再迁走**」**只在 `§7.0-A` 留痕**，主表**维持 3 条**。
>
> **R145 待办（不上主表、也不是收口项）—— R146 已收口（`a13f0b88`，见 A-10 第 1 条）**：
> **MCP 第二份码表的同步无 CI 守卫** ——
> 见本节上方「R145 待办」段与 `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 1 条。
>
> **R146 已收口的两项（指针）**：见 **A-10** 第 1/2 条 ——
> ① MCP 第二份码表的**漂移闸**（`a13f0b88`；`scripts/check-mcp-error-hints.mjs`，
> **链 101 → 102**；判据②**只限 `TASK_FIRE_POINT_*` 族** ⇒ 不会第一天就红 428 条）；
> ② atlas `07-testing` 的**守卫接线数字刷新**（`d3e825b9`；**46 / 47 / 46**（2026-10-30 快照）
> → **91 / 89 / 88**（2026-11-07 实跑，HEAD `a13f0b88`））。两项**此前都不在主表**
> ⇒ 按「**不要往主表加再迁走**」**只在 `§7.0-A` 留痕**，主表**维持 3 条**。
>
> **R146 待办（不上主表、也不是收口项）**：**85 个判别型脚本尚无覆盖计数保护** ——
> 见本节上方「R146 待办」段与 `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 1 条。
>
> **R146 收口说明**：R146 落地 2 个提交（`a13f0b88` / `d3e825b9`），**主表仍是 3 条** ——
> 本轮两项**此前都不在主表**（MCP 码表漂移闸只在 R145 候选池第 1 条、atlas 守卫数字刷新
> 是 R146 才出现的文档面），按表头规则「**不要往主表加再迁走**」⇒ 直接在 `§7.0-A`
> 新增一组 **A-10 本季收口（R146）** 记 2 行，**主表 3 条一行未动**。
> 两项都是「**账面上写好了、但没有任何东西会替它报警**」：① R145 给 MCP 第二份码表写的
> 头注「新增/改名错误码时两边都要看」**是提醒、不是机制** ⇒ 新增
> `scripts/check-mcp-error-hints.mjs`（零依赖静态、~0.3s）：MCP 表里的每个码必须在后端码表
> **真实存在** + **后端 `TASK_FIRE_POINT_*` 族的每个码必须在 MCP 表里** + 两边都记 `status`
> 时必须一致；**5 类结构红**（码表读不出 / 表缺失或字面量不闭合 / 出现本守卫读不到的键形状 /
> 解析出 0 条 / 家族前缀被改名 ⇒ 0 个码）**绝不退化成「0 项漂移」**；**链 101 → 102**
> （追加在末尾，不动既有段位）。② `docs/atlas/07-testing/README.md` 的「现况」段写的是
> **2026-10-30 实跑**的 **46 / 47 / 46**（其间新增 45 个守卫 ⇒ **过期约一个半月**）⇒ 按
> **2026-11-07 实跑**（HEAD `a13f0b88`）更新为 **91 / 89 / 88**，日期与 HEAD 一并写明，
> 并保留一行注明「上一版是 2026-10-30 快照」；顺带补两处覆盖面事实
> （**「守卫数量」≠「受覆盖计数保护的守卫数量」**；**`--root` 支持面 82/91** 并逐个列出
> 不支持的 9 个）。
> **教训已固化**：**「永远红的守卫等于没有守卫」**（→ 270）、
> **第二份事实源必须配一条漂移闸**（→ 271）、
> **判据面塌方要结构红，不许退化成「0 项合规」**（→ 272）、
> **「现况数字」要带日期与 HEAD，并写明覆盖面边界**（→ 273）。
> **R146 待办（不上主表、也不是收口项）**：**85 个判别型脚本尚无覆盖计数保护** ——
> `check-guards-wired` 的扫描面 **98** 个（`check-*` ∪ `agent-*`）里**只有 13 个**登记了覆盖
> 计数 ⇒ 其余 **85 个**的**用例被删光不会有任何东西变红**（判据面在「守卫自己是否还在真的测
> 东西」这一层是空的）。属**独立一轮**（工作量 **L**、可分批）⇒ 进
> `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 1 条，**此处只留指针**。
> 另一条待办：**9 个守卫不支持 `--root`**（清单见 `docs/atlas/07-testing/README.md:151`）
> ⇒ **只有支持 `--root` 才能给守卫写 selftest 夹具**（selftest 需要在临时目录里造仓库），
> 这是本仓多数守卫能写 selftest 的前提；登记为候选池第 4 条。
> **—— 该条已由 R147（`980e53aa`）收口，见 A-11 第 1 条。**
>
> **R147 已收口的一项（指针）**：见 **A-11** 第 1 条 —— **9 个守卫补 `--root` 支持**
> （`980e53aa`；`--root` 支持面 **90 中 81 → 90/90**）。它属「**本轮买的是前提，不是自检**」：
> 只让最后 9 个守卫能指向临时目录里的夹具仓库，**没给它们写自检**。该项**此前不在主表**
> ⇒ 按「**不要往主表加再迁走**」**只在 `§7.0-A` 留痕**，主表**维持 3 条**。
>
> **R147 待办（不上主表、也不是收口项）**：**9 个守卫现在能写夹具自检了，但还没有写** ——
> 这才是**下一步的真实工作量**：本轮只把「**写不了**」变成「**还没写**」，判据面本身
> 仍**只有白盒保护**（8 个有内联/伴生自检，但都是把内部函数抽出来喂内存 fixture，或把
> 守卫脚本复制进夹具树 —— 按 `scripts/lib/guard-selftest.mjs` 头注的立场，那是「**测的是
> 函数，不是守卫**」；`process.exit(1)` 被删、参数解析把路径吃掉它都看不见）。⇒ R147 之后
> 才有**黑盒 CLI 夹具**（spawn 真主脚本 + `--root=<夹具>`）的可能，本轮只
> `check-brand-drift.selftest` 真用上（**+3 例**）。**可分批**，建议**先挑判据最脆的
> 2–3 个**（别一次做 9 个）；⚠ 新开测试文件要同步 `check-atlas-counts` 的
> 「mcp-server 10 文件」这类**小分母数字**（走 `--update` 机械同步，±5% 在小分母上退化成 ±0）。
> 只进 `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 1 条 + **下轮第一步**，
> **此处只留指针**。
>
> **R147 收口说明**：R147 落地 1 个提交（`980e53aa`），**主表仍是 3 条** ——
> 本轮这一项**此前不在主表**（它只是 R146 候选池第 4 条 + R146 待办的下半段），
> 按表头规则「**不要往主表加再迁走**」⇒ 直接在 `§7.0-A` 新增一组
> **A-11 本季收口（R147）** 记 1 行，**主表 3 条一行未动**。
> 本轮**不新增任何判据**，补的是**工具性前提**：`scripts/` 下 **90** 个 `check-*.mjs` 里
> **81** 个已支持 `--root`、**9** 个不支持 ⇒ 那 9 个**写不了夹具自检**（只能在真仓库上跑）
> ⇒ **其判据面没有黑盒自检保护**，改坏**没人发现**。修法是 9 个脚本统一六条口径：
> ① `--root <dir>` 与 `--root=<dir>` **两种形态都认**；② **缺省根仍按脚本位置锚定** ⇒
> 不传时 stdout 与改前**逐字节相同**；③ 缺值/空值/真空格误吞下一个开关 ⇒ **exit 2**；
> ④ 指向**不存在目录** ⇒ **exit 2**、**不静默回落到真仓库**；⑤ 指向**存在但不是本仓形状**
> 的树 ⇒ **结构红 exit 1**（一句话 + 实际查找路径，不是 ENOENT 栈）；⑥ 6 个内联 selftest 的
> `--selftest` 与 `--root` **互斥 ⇒ exit 2**。**链仍 102 段**（未碰链、未新增段）。
> 五处不是机械复制：`check-brand-drift.selftest` **+3 条黑盒 CLI 用例**（spawn 主脚本传
> `--root=<夹具>` ⇒ 主脚本吃掉 `--root` 必红；21 → 24）；`check-collaborator-self-call` 补
> 「**扫到 0 个 ⇒ 结构红 1**」堵 `walk()` 吞 ENOENT 的假绿；`check-source-text-contracts` 的
> `--root` **连两张登记表**按根解析（否则整棵树搬不走、只能测纯函数）；
> `check-spec-coupling-surfaces` 的自检临时报告改落 `os.tmpdir()`（**不再往仓库写盘**）；
> `check-npm-audit-exemptions` 区分**两类 cwd**（仓库根受 `--root`；`process.cwd()` 是
> 「用户敲的相对路径」的首选基准、**不改**）。
> atlas 的 `--root` 支持面同步（`docs/atlas/07-testing/README.md:151`）：**90 中 81 → 90/90**。
> **已知限度**：`check-protocol-three-way` 的判据是「三侧**真跑**对拍」⇒ 夹具树跑不动 ⇒
> 它的 `--root` 买的是「口径统一 + 绝不悄悄跑真仓库 + 探针落盘跟随根」，**不是**「判据可
> 夹具化」；其判据面自保由**既有**的 `--selftest`（**25** 例纯函数/内存行）承担。
> **教训已固化**：**「能不能写自检夹具」是守卫的工具性前提，不是加分项**（→ 274）、
> **「静默回落到真仓库」是最坏的假绿**（→ 275）、
> **「根」与「用户路径基准」是两类东西**（→ 276）。
>
> **R148 已收口的一项（指针）**：见 **A-12** 第 1 条 —— **3 个守卫补黑盒 CLI 夹具自检**
> （`14518900`；`check-source-text-contracts` **35 → 41** 例 /
> `check-sanitize-parity` **8 → 13** 例 / `check-collaborator-self-call` **9 → 15** 例）。
> 它属「**把 R147 买下的能力兑现成真的自检**」：**不新增任何判据**，只把
> **判据面**从「白盒（测函数，不是守卫）」升级到「**黑盒（spawn 真脚本 + `--root=<夹具>`）**」。
> 该项**此前不在主表**（只是 R147 候选池第 1 条 + R147 待办的下半段）⇒ 按
> 「**不要往主表加再迁走**」**只在 `§7.0-A` 留痕**，主表**维持 3 条**。
>
> **R148 待办（不上主表、也不是收口项）—— 指针已更新（3/9 已写）**：**9 个守卫的夹具自检
> 还剩 6 个没写**。**原指针（「9 个能写夹具自检了但还没写」）已被 R148 部分兑现** ——
> **3/9 已写**：`source-text-contracts`（**41** 例）/ `sanitize-parity`（**13** 例）/
> `collaborator-self-call`（**15** 例）。**剩 6 个**：
> ① `agent-event-limits` —— **原型已验证**（R148 落笔前可行性核对已过）⇒ **下轮首选**；
> ② `brand-drift.selftest` —— R147 已加 **3** 条黑盒用例（21 → 24）⇒ **可再补**（不是零基础）；
> ③ `npm-audit-exemptions` —— **已有 30+ fixture 用例** ⇒ **可能不缺**（须核对，不能假定）；
> ④ `protocol-three-way` —— **需重构判据形状**（把「探针执行」与「判据比对」拆开），
> 工作量 **M**、属判据形状改造 ⇒ **可能需要 ADR**；
> ⑤ `spec-coupling-surfaces` —— **report-only 设计** ⇒ 要写就得先把它改成判据型，
> **那是另一个决策**（不是「补测试」能顺手做掉的事）；
> ⑥ 其余按需。
> ⇒ **只进 `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 1 条 + 下轮第一步**，
> **此处只留指针**。⚠ **别把「3/9」读成「6/9 一样容易」** —— 剩下的 6 个里
> **有 2 个（④⑤）需要先改判据/设计**，不属于「照着 ① 抄一遍」的量（→ 279）。
>
> **R148 收口说明**：R148 落地 1 个提交（`14518900`），**主表仍是 3 条** ——
> 本轮这一项**此前不在主表**（只是 R147 候选池第 1 条 + R147 待办的下半段），
> 按表头规则「**不要往主表加再迁走**」⇒ 直接在 `§7.0-A` 新增一组
> **A-12 本季收口（R148）** 记 1 行，**主表 3 条一行未动**。
> 本轮**不新增任何判据、不碰链、不碰 CI**（链**仍 102 段**）。**最脆的 3 个**的选法 =
> **判据复杂 × 夹具可行 × 现有 selftest 离 CLI 有多远**，**刻意不按文件名顺序** ——
> 选中的第 1 个（`check-source-text-contracts`）正是**既有用例最多、却一条没碰换根路径**
> 的那个（**既有 35 条用例没有一条碰过 `applyRoot()`** ⇒ 把 `applyRoot()` 删掉，
> **35 条照样全绿**，而守卫会**静默读真仓库**）。
> **统一形态**：`runGuard(SELF, ["--root=<mkdtemp 夹具>"])` **spawn 真脚本**、断言
> **退出码 + 报错文本**；夹具建在 `os.tmpdir()` 的 `mkdtemp` 下、用完即删 ⇒
> **绝不往仓库写任何文件**。**互斥不构成障碍**：`--selftest` 与 `--root` 互斥管的是
> **同一次调用**，spawn 出的子进程**只带 `--root`**。
> **验证（真实 exit）**：三个 `--selftest` 全 **0**（**41/41 / 13/13 / 15/15**）·
> **主跑 0 且 stdout 与改动前逐字节相同**（writer 用 `git archive` 导出 `14518900^` 与
> `14518900` 到同一路径跑 `diff -q` 独立复核：三者 stdout 全 same，stderr 只差 node 警告的
> **PID**，归一化后全 same）· `check-guards-wired` **0**（**91 / 89 / 88 / 13** 四个数字
> **全不变**）· `test:guards:repo` **0（102/102）** · `size-caps` **0** · `atlas-counts` **0** ·
> `test:docs` **0** · `guard-liveness` **0** · `script-main-guard` **0**。
> **红演示（均还原）**：合规夹具改违规形态 ⇒ 对应用例 **exit 1**；另做**反方向**
> （违规改回合规 ⇒ 反例用例红）⇒ 两侧都有牙。
> **「自检面 88/89 不变」不是缺陷**：那三个数统计的是「**有几个守卫有自检文件**」，
> 本轮补的是**既有守卫的既有 `--selftest` 里的用例** ⇒ **分母不变、用例条数变**
> ⇒ 涨的是「**判据覆盖深度**」（41 / 13 / 15 例，其中黑盒夹具 6 / 5 / 6 条），
> **这是另一个量，必须另外报**（→ 277）。
> **盲区（已写进三个脚本的头注）**：`check-protocol-three-way` 判据是「三侧**真跑**对拍」
> ⇒ 夹具树跑不动；`check-spec-coupling-surfaces` 是 **report-only** ⇒ **不存在**
> 「违规 ⇒ exit 1」形态，**硬写就是改判据**（越界，→ 279）。
> **教训已固化**：**「工具到位 ≠ 判据被保护」**（→ 277）、
> **「既有 N 条用例一条都没碰过换根路径」是退化的典型形态**（→ 278）、
> **「report-only 守卫不存在『违规 ⇒ exit 1』形态」**（→ 279）。
>
> **R149–R150 收口说明**：两批**同属一个前端 / 守卫主题**，合并记一组。落地 **3 个提交**
> （`9db3abbc` / `b88db534` / `fdcff7de`），**主表仍是 3 条** —— 本轮三项**此前都不在主表**
> （守卫夹具是 R148 候选池第 1 条、F1/F2/F4 只在 R149 的只读审计里），按表头规则
> 「**不要往主表加再迁走**」⇒ 直接在 `§7.0-A` 新增一组 **A-13 本季收口（R149–R150）** 记 3 行，
> **主表 3 条一行未动**。
> 三项分别是：① **守卫夹具第 4 个**（`check-agent-event-limits` 从 **9 条全进程内** →
> **17 条编号用例，其中 10 条 spawn 真脚本**；链**仍 102 段**，判据未动）；
> ② **F2 + F4「读取失败当成没有数据」**（执行器详情一个 `error` 污染四个面 + SOP 抽屉两 Tab
> 无三态且 toast 文案指错对象）；③ **F1「下发到设备」静默截断**（只取前 100 行且丢弃 `total`，
> 被截掉的恰是最老、最可能仍在 `running` 的行）。
> **附带纠正一个计数口径**：**「用例多」≠「黑盒夹具有」** ⇒ 9 个 `--root` 守卫里
> **黑盒 CLI 夹具覆盖 6/9**（不是按用例条数数出来的 110/110）。
> **验证（真实 exit）**：`--selftest` **0**（17/17，且主跑 stdout 与改前**逐字节相同**
> 84B / `sha256 6c05b49e…a373`）· 前端新用例 **6/6 + 9/9** · `test:docs` **0** ·
> `size-caps` **0** · `guards-wired` **0** · `test:guards:repo` **0（102/102，段数未变）**。
> **教训已固化**：**「用例多」≠「黑盒夹具有」**（→ 280）、
> **黑盒夹具能抓到进程内用例结构上抓不到的东西**（→ 281）、
> **「一个失败点污染多个面」要逐面定策略**（→ 282）、
> **「确认面」的数据必须与它宣称的作用域一致**（→ 283）。
>
> **R148 待办（指针已由 R149 更新，`6/9` 到位）**：**9 个守卫的黑盒 CLI 夹具覆盖现为 6/9** ——
> `source-text-contracts` / `sanitize-parity` / `collaborator-self-call`（R148 的 3 个）+
> `brand-drift.selftest`（R147 的 3 条）+ `npm-audit-exemptions`（**31 条里仅 10 条真子进程**）+
> `agent-event-limits`（R149，**10 条 spawn**）。**剩 2 个**：
> ① `protocol-three-way` —— **不是缺 `--root`**，是判据为「三侧**真跑**对拍」⇒ 要**先拆
> 「探针执行」与「判据比对」**（**M**，可能需 ADR）；
> ② `spec-coupling-surfaces` —— **不是缺 `--root`**，是 **report-only 设计** ⇒ 要写夹具就得先把它
> 改成判据型（**需决策**，不是「补测试」能顺手做掉的事，→ 279）。
> ⚠ **别把「6/9」读成「再抄 3 遍」** —— 剩下 2 个都是**判据形状**问题，不是缺工具。
> **已有夹具核对表在 `artifacts/autonomy/R149/impl-fixture.md`**（`artifacts/` 被 gitignore、
> **不入库**）⇒ **结论已抄进台账**（本段与 A-13 第 1 条），核对表本体只在本地可查。
> ⇒ 只进 `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 3/4 条，**此处只留指针**。
>
> **R149–R150 新增待办（不上主表、也不是收口项）**：前端审计里的 **F3** 与 **F5** ——
> ① **F3 `TaskDetailPage` 执行记录 Tab 的错误态**（`useTaskExecutions` 的 `error` 被丢弃
> ⇒「暂无执行记录」；同页 `task` 有整页错误块、`stats` 有轮询，**唯独这个查询没有错误面**）；
> ② **F5 `ExecutorInstallWizardPage` 的 icon-only 按钮无可访问名**（「共享 Token 显示/隐藏」，
> 全仓 **93 处 icon-only 里唯一一处**未命名）。**两条都必须先外提**：该两页非注释行
> **1037/1039（余 2 行）** 与 **830/830（零余量）** ⇒ 不许调 ceiling、不许用 ALLOW，
> 照 R141 `pages/sops/AssignSopModal.tsx` / R150 `pages/application-detail/DeployToDevicesModal.tsx` 先例。
> ⇒ 进 `docs/plan/rounds/AUTONOMY-STATE.md`「状态卡候选池」第 1/2 条，**此处只留一行指针**。
> —— **该待办已由 R151 收口**：F3 **完整落地**（`e1303c19`）；F5 的 `aria-label` **已落地**、
> **自动化 DOM 测试也已在 R152 由 `c5d9fd69` 补上**（见 **A-14** 第 2 条与下方
> 「R151 新增待办」段）。

> **R151 收口说明**：本轮落地 **1 个提交**（`e1303c19`，F3 + F5 同批），**主表仍是 3 条** ——
> 两项**此前都不在主表**（F3/F5 只在 R149–R150 候选池第 1/2 条），按表头规则
> 「**不要往主表加再迁走**」⇒ 直接在 `§7.0-A` 新增一组 **A-14 本季收口（R151）** 记 2 行，
> **主表 3 条一行未动**。
> 两条的**共同前提**是「这两页本来改不动」：`TaskDetailPage` 非注释行 **1037/1039（剩 2 行）**、
> `ExecutorInstallWizardPage` **830/830（零余量）** ⇒ 一条**整块外提**、一条**等价压缩换行数**，
> **均未调 ceiling、均未用 `ALLOW`**（→ 240 的又一次应用）。
> **F3 = 「方向相反的两个结论共用一句空态」**：「这个任务从没执行过」会让人**立刻点「手动触发」**
> （本 Tab 右上就是它）⇒ **多一次真实执行**；「执行记录读不出来」应当**重试 / 报障**。
> **F5 = 「icon-only 控件的名字要说『马上要发生什么』」**：同一个按钮在显示 / 隐藏两态下
> **必须是两个名字**，静态标签会让读屏用户听到的标签与实际动作不符。
> **验证（真实 exit）**：新用例 **3/3** · `task-detail-*` / `install-wizard-baseline` 回归
> **3 文件 10 例 = 0** · `typecheck` / `lint` / `i18n-key` / `size-caps` / `user-facing-language`
> 全 **0** · `test:docs` **0** · `guards-wired` **0** · `test:guards:repo` **0（102/102，段数未变）**。
> **反证**：F3 错误分支改恒假 ⇒ **用例①② 双红**（2 failed | 1 passed，③ 真空态仍绿 ⇒ 说明它测的是
> 另一件事），还原 ⇒ 3/3 绿。
> **遗留（如实）**：**F5 没有自动化 DOM 测试** —— 真渲染测试卡在 **antd v6 `Select` 在 jsdom 里的
> 展开 / 选中交互**（本仓无「点选项」先例，`.ant-select-item-option` 实测点不到）；源码文本断言
> 又不被本仓判据接受（`check:source-text-contracts` 要求登记，且**证明不了 DOM 上确有名字**）
> ⇒ **正确解 = 先把「共享 Token 卡」外提成独立组件、再用 props 测三态 + a11y**（→ 286）。
> **另一条失败记录（不美化）**：计划中的「**覆盖率棘轮新鲜度收紧**」由 subagent 执行，
> **失败退出、未留任何改动** ⇒ **该项没做**，仍是候选池第 1 条。教训：**「派出去」不等于「做掉了」**，
> 台账只按**产出的 diff** 记账。
> **教训已固化**：**「方向相反的两个结论」不能共用一个空态文案**（→ 284）、
> **icon-only 控件的可访问名要说「马上要发生什么」，不是「它是什么」**（→ 285）、
> **「写不出测试」时要区分「不值得测」与「测试工具链不够」**（→ 286）。
> **R152 追加**（→ 287）：**判「测不了」之前，先确认是不是「路径没找对」** ——
> F5 的 DOM 断言**已由 `c5d9fd69` 补上**（三个 jsdom 坑：`combobox` 角色落在
> `.ant-select-content`、**两个** Select 要 `getAllByRole` 取第 0 个、**点击必须在 `waitFor`
> 之外**）⇒ **解法就在同一个仓库里**，当时只是**没找对路径**；「本仓无先例」是关于
> **怎么写**的，不是关于**能不能测**的。

> **R151 新增待办（不上主表、也不是收口项）**：
> ① **F5 的可测化** —— 把「**共享 Token 卡**」外提成独立组件、再补 a11y 测试
> （该页零余量，外提本身也是收益 ⇒ 一举两得，→ 286）；**✅ 已还清（`c5d9fd69`）** ——
> 最终解法**不是外提**、而是**真渲染直接测**（三个 jsdom 坑见下），新增
> `apps/admin-web/src/__tests__/install-wizard-token-a11y.test.tsx`（**2 例**，
> 新用例 2/2 · install-wizard 相关 5 文件 30 例=0 · chain 0（102/102），
> 反证两条都真转红并还原）⇒ 依据方法学 **246**（旧待办登记**不应保留**），本条**只保留指针**；
> ② **覆盖率棘轮新鲜度收紧**（R151 计划项、subagent 失败未做）—— 要求**声明了 `maxAgeHours`
> 的端必须有 per-step `measuredAt`**，否则红；注意**先给 python / admin-api 回填真实 `measuredAt`**
> （**只能真跑，不许手写**），再收紧判据。
> ⇒ 只进 `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 1/2 条，**此处只留指针**。
> ✅ **候选池第 1 条「覆盖率棘轮新鲜度收紧」已由 R152 收口**（`0f43ef89`，见 **A-15** 第 1 条）；
> **R152 新增待办**（不是收口项）：① `guards-repo-matrix` 失败报文补该守卫 stderr 摘要
> —— **✅ 已还清（R153 `90bdafcb`，见 A-16 第 1 条；依据方法学 246，本条只留对账痕迹）**；
> ② 未声明 `maxAgeHours` 的端仍是回落口径（建 admin-web / 全链 floor 时须同批声明 + 回填）。

> **R152 收口说明**：本轮落地 **2 个提交**（`0f43ef89` 棘轮新鲜度收紧 + `549cc485` SSRF 探针
> 并发互踩），**主表仍是 3 条** —— 两项**此前都不在主表**（棘轮那条是 R151 的**失败计划项**、
> SSRF 探针是**本轮两次链红才敢归因**的偶发红），按表头规则「**不要往主表加再迁走**」
> ⇒ 直接在 `§7.0-A` 新增一组 **A-15 本季收口（R152）** 记 2 行，**主表 3 条一行未动**。
> **两条的共同形状是「判据面里原来就有一条看起来能过的通道」**：
> ① **棘轮**：`--skip-heavy` 会**前移 `generatedAt`**（一步 full 都不跑）⇒ 没有 `measuredAt`
> 的端看起来「刚测过」；修法 = **声明了细粒度承诺就必须有细粒度证据**（缺失 ⇒ 红、不回落），
> 三端 `measuredAt` 全部**真跑回填**（19s / 165–190s / 204–210s，**零手写**，→ 290）。
> ② **SSRF 探针**：admin / node 两臂把探针**固定写进仓库目录** ⇒ 并发 / 被杀进程互踩、
> 报**随机 ENOENT**；同一脚本的 **python 臂早已 `mkdtempSync`** ⇒ 两臂是**同类漏网**（→ 289）。
> **验证（真实 exit）**：`check:coverage-floor` **0**（selftest **31/31**；per-step **3 端** /
> 回落 **0 端**）· `--skip-heavy` 后 `measuredAt` **6/6 逐字不变** · `check:ssrf-parity` **0** ·
> **6 并发全 exit 0 且零 probe 残留** · `test:docs` / `size-caps` / `guards-wired` 全 **0** ·
> `test:guards:repo` **0（102/102，段数未变）**。**链已连续三次全绿**（稳定性验证）。
> **过程（不美化）**：两个 writer 并发撞同一批文件、read-modify-write **一度丢掉 node 端的
> `measuredAt`** ⇒ **再跑一次真测**补回（不是手写）；Lead 裁决「**停手 + 只交验证报告**」，
> 最终由单一写者统一提交。
> **R152 新增待办（不上主表、也不是收口项）**：① **「逐轮全链红」这类偶发红要归因到具体守卫** ——
> 本轮两次链红都是 SSRF 探针，但当时只看到「第 6/102 段红」；建议在 `guards-repo-matrix` 的
> 失败报文里**带上该守卫自身的 stderr 摘要**（现在报文只有段号 + 命令 + 退出码，该守卫的输出
> 靠 `stdio: 'inherit'` 混在千行日志里 ⇒ 只能人工重跑归因）；② **未声明 `maxAgeHours` 的端仍是
> 回落口径**（当前**无承载者**，给 admin-web / 全链建 floor 时**须同批声明 + 回填 `measuredAt`**）。
> ⇒ 只进 `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 1 条与第 5 条，**此处只留指针**。
> **① 已还清（R153 `90bdafcb`，见 A-16 第 1 条）** —— 旧待办**不保留原句**（依据方法学 **246**
> 「陈旧登记要删不要留」），只留这条对账痕迹；② 仍是待办（R153 沿为候选池条目）。

> **R153 收口说明**：本轮落地 **2 个提交**（`90bdafcb` 链失败报文回放该段 stderr/stdout 尾部 +
> `1de83ccf` 修正 admin-web i18n step 的过时注释），**主表仍是 3 条** —— 两项**此前都不在主表**
> （报文那条是 R152 留下的**待办指针**、注释那条是 R152 候选池第 6 条），按表头规则
> 「**不要往主表加再迁走**」⇒ 直接在 `§7.0-A` 新增一组 **A-16 本季收口（R153）** 记 2 行，
> **主表 3 条一行未动**。
> **两条的共同形状：都不是「功能没做」，而是「已有的东西没把话说清楚」** ——
> ① **报文**：`spawnSync(..., { stdio: "inherit" })` 让子进程**直连终端**（实时性最好）但父进程
> **拿不到内容** ⇒ 失败报文只能报「第 k 段 exit N」；R152 两次链红都卡在这（真正原因是上方几十屏外
> 的 ENOENT）⇒ 修法 = **异步 `spawn` + 实时透传 + 环形缓冲（最近 20 行）**，失败时把两段尾部回放进
> 报文，并把**信号**也记进去（旧报文把「被 SIGTERM 杀」显示成 `exit 1`）。**只加信息、不改判定**
> （仍 fail-fast / 退出码原样传播 / 逐段行格式不变，→ 291、292）。
> ② **注释**：`ci.yml` 写「`lint:i18n` 只跑主跑」，而 R145 已改成**含自检**（→ 293）⇒ 下一个人会
> 误判「自检没人跑」，甚至以「反正没人跑」为由把自检摘掉。**只改注释**，未动任何 step 的
> action/runner/命令。
> **验证（真实 exit）**：`--list` **0**（解析 102 段）· `--only=1` **0** · `--from=101` **0** ·
> `check-script-main-guard` **0** · `check:actions-pinned` **0** · `check:runner-labels` **0** ·
> `check:workflow-yaml` **0** · `test:docs` / `size-caps` / `guards-wired` 全 **0** ·
> `test:guards:repo` **0（102/102，段数未变）**。
> **红演示（有牙证明）**：临时把链第 2 段换成 `echo 原因 >&2; exit 3`（跑完立即还原
> `package.json`）⇒ 报文在段号/退出码之外打印 `── stderr 尾部（最近 20 行）── │ the-real-reason:
> fixture exploded at step 3` 与 `── stdout 尾部（最近 20 行）── │ some-stdout-context`，
> 且**退出码仍是 3**。
> **R153 新增待办（不上主表、也不是收口项）**：**「链红的偶发红仍未被持久观测」** —— 本轮 SSRF
> 并发问题已修、也变成「一眼能归因」，但同类「并发互踩 / 临时产物」缺陷**没有持续观测通道**
> （`test:guards:repo` 一次只跑一遍 ⇒ 偶发红大概率不出现，修完也不知道会不会再犯）。**建议**：给
> `test:guards:repo` 加「**重复跑 N 次**」的慢通道（形态照 `web-flake-watch`：nightly、
> `continue-on-error` 不阻断、日志带 `EXIT_N`、artifact 留档）—— **只登记，不立项**。
> ⇒ 只进 `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 1 条，**此处只留指针**。



### 7.0-A-已收口（**只留「去哪查」：结论 + 收口提交 + 方法学编号**）

> 口径：每条 **1 行**。详细证据/链条在 `docs/PLAN-CLAIMS.md` 对应轮次组，这里**不复制正文**。

#### A-1 本季收口（R108–R131）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | `r18b-protocol-heartbeat-dispatch` | **resolved**（含 oracle 闭合；生产属模型 B、无残窗） | `8f25b481` / `121a7f77` / `bbe9da50` | 218–222 |
| 2 | `r18b-harness-model-a` | **resolved**（改为「保留行置 `pending`」对齐生产） | `bbe9da50` | 221 |
| 3 | `adr-038-broadcast-occupancy` | **resolved**（步骤 1–5 全完成，方案 B） | `7c751ca7` / `5ac4b812` / `5351e3e5` / `784b0373` / `a18cde1c` / `a7ed1a3d` / `dbd42020` | 223–227 |
| 4 | `execute-further-slimming` | **closed（ADR-039）** | `b3e11966`（ADR）/ `0b22db1c`（批次） | 233 |

**`execute-further-slimming` 为什么 closed（ADR-039 否证前提）**：`execute` 内**0 个显式事务**
（全区间 grep `dataSource.transaction` / `manager.*` / `queryRunner` 为空）——本仓执行器核心是
「**无事务 + 单语句 CAS**」，正确性靠**三条不变量**：① 严格顺序（闸门→领取 CAS→副作用→台账）；
② 单判据（是否重放只看台账里有没有该 `toolCallId` 的行 = `ledgerRowExists`）；
③ 可结清（`settleToolCallByApprovalId` 条件 UPDATE 天然幂等）。
⇒ 「优化事务边界」是**误导性提法**：没有事务可拆。若将来确需再瘦，**只做 ADR-039 §方案 B**
（抽三个拒绝分支，省 **25–35 行**）；**不得**拆事务（C 案三类失败全**静默**：
重复执行 / 审批单永久作废 / 漏结清，都无日志、只能靠对账查询发现）。

#### A-2 R35 消化批次（历史 · 原「§7.0 主表」5 条）

| # | id | 轮次 | 四选一结论 | 证据 |
|---|---|---|---|---|
| 1 | `diff-card-inline-columns` | §7.1 | **仅设计说明** → §7-A `proposal` | `grep tokenHash apps/admin-web/src/pages/ExecutorDetailPage.tsx` ⇒ **0 命中**（服务端密列从不进 web）⇒ 卡片内联哪 3 列是**展示选择**，不是缺陷 |
| 2 | `iana-special-purpose-sweep` | §7.8 | **已被 HEAD 推翻** | `apps/admin-api/src/common/utils/safe-http.util.ts:666-669` 已有 `192.0.0.192` 处理 + `192.0.0.0/24`（RFC 7335 全 False）整段说明 ⇒ 剩余地址无需改 |
| 3 | `release-path-race` | §7.15 | **已被 HEAD 推翻** | `apps/admin-api/src/modules/executor/heartbeat-count.util.ts:21` `resolveHeartbeatRunningTaskCount`（R16 取大修法）已覆盖"释放后仍不低于在途"的形态 |
| 4 | `running-minus-reserved-drift` | §7.16 | **已被 HEAD 推翻** | `apps/admin-web/src/utils/executor-metrics.ts:23` `resolveRunningCount` + `ExecutorDetailPage.tsx:342` 已调用 ⇒ 负值被 clamp |
| 5 | `reserved-slots-semantics-vs-inflight` | §7.16 | **仅设计说明** → §7-A `proposal` | `apps/admin-api/src/modules/executor/executor.service.ts:3287-3297` 已写明二者不同源，并有 `reservedSlots <= effectiveRunningCount` 配对校验兜住 ⇒ 语义不同**不是缺陷** |

**A-2 结论：主表 5 → 0**（3 条已被 HEAD 推翻、2 条移入 `§7-A` 的 `proposal` 池，均带 `since=`）。

#### A-3 本季收口（R139）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | `ui-p2-1-sop-video-states` | **resolved**（三态显式化 `loading｜ready｜error`；失败态用既有 `StateError` 带**重试**，`disabled` 只在「加载中 或 (ready 且真空)」时为真） | `66b87e16` | 242 |
| 2 | `ui-p2-2-exec-packages-crosspage` | **resolved**（结果集任一变化即清空 `selectedIds`；删除前空则清空+提示、部分残留先按可见行**收窄并如实告知**；顺带把 `Universal` 债**真中文化**而非登记） | `4c88dac0` | 243–244 |
| 3 | `ui-p2-3-sse-background-tab` | **resolved**（`startsHidden` 时不建流、首连交给 visible 分支；node/SSR 无 `document` 行为不变） | `66b87e16` | 242 |
| 4 | （同型项）P3-2 末页删空误报 | **resolved**（新增 `afterRemoved(removed)`：本页清空且 `page>1` ⇒ 回退上一页，只按**成功删除**条数算） | `4c88dac0` | —（随 P2-2 同批） |
| 5 | （同型项）P3-3 草稿校验 rejection | **resolved**（`validateFields` 改 try/catch：校验错误不是请求错误 ⇒ 不发请求、不走 `showApiError`） | `66b87e16` | —（随 P2-1 同批） |
| 6 | （同型项）F-3 OTel「traces 已交付」宣称 | **resolved**（区分「Jaeger profile 可启动」与「span 尚未出站（仅进程内 `[trace]` 日志）」，给出 TracerProvider + OTLP 升级路径；**此前不在主表，故不新增主表行**） | `d7d27f39` | 242 |

> **A-3 备注**：第 4/5/6 条是随第 1/2 条一起修掉的**同型项**（R138 审计的 P3 三连与 F-3），
> **本轮之前都不在主表**（主表只放「当前该做什么」），故只在 `§7.0-A` 留痕。
> **P3-1（`SopsPage.tsx:1091` 指派弹窗错误态误报）本轮未修** ⇒ **只进候选池、不进主表**
> （**R141 已修**，收口见 **A-5**）。
> 本轮方法学 **244 / 245**（并行 writer 撞同一文件按根因裁决 / 守卫转红先定位段位归属）
> 属**轮次级**记账，完整表述见 `docs/PLAN-CLAIMS.md` 的 R139 组。

#### A-4 本季收口（R140）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | `coverage-floor-freshness` | **resolved**（基线每端可选 `maxAgeDays`（正整数，粒度=自然日）：缺失/不可解析 ⇒ 红「无法判断新鲜度」；超期 ⇒ 红并点名过期天数+上限、**不再比 floor**、报文给刷新跑法；未声明 ⇒ 不因新鲜度红但汇总行印「未声明 K 端」。两端均取 14 天并写 `maxAgeDaysWhy`；selftest **7 → 13**） | `e5aa8e80` | 247–249 |
| 2 | `f-2-misfire-no-ui` | **resolved**（`TaskFormTriggerSection.tsx` 在 blockStrategy 后加 `misfireStrategy` Select：**仅 cron/fixed_rate 渲染**（隐藏而非禁用）、编辑态回填 `?? 'ignore'`、周期触发下**总是显式发有效值**、非周期 `preserve={false}` 缺省不发、**全程不发 null**；新用例 5/5） | `8996b82b` | 246 |
| 3 | （同型项）`web-type-field-drift` 的 `missing:misfireStrategy` 陈旧豁免 | **resolved**（手写类型已跟进 ⇒ 该登记**永远不可能再红**；**删条目才是收紧**，留着它基线就烂成豁免单。此前不在主表，故不新增主表行） | `8996b82b` | 246 |

> **A-4 备注**：第 3 条是随第 2 条一起删掉的**已陈旧登记**（不是本条需求的一部分，是
> `check-web-type-field-drift` 的欠账清理）—— 本轮之前不在主表，故只在 `§7.0-A` 留痕。
> **主表剩 3 条**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`），
> 三条的重启条件都不在自治循环内。本轮方法学 **246–249** 的完整表述见
> `docs/PLAN-CLAIMS.md` 的 R140 组；其中 **248（过期数据不参与大小比较）** 与
> **249（同一数据源的两端不给不同窗口）** 是本轮**判据设计**层面的两条，可复用到其它棘轮。

#### A-5 本季收口（R141）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | `ui-p3-1-sop-assign-error-state` | **resolved**（指派弹窗取数三态显式化 `loading｜ready｜error`：**loading 只给 Spin 不报空态**、**ready 且真空**才渲染 `sops.assignEmpty`、**error** 用既有 `StateError` +「重新加载」按钮；**不复用**空态词条；失败时清空候选；带序号守卫防连点时旧响应覆盖新状态；确认键 `disabled: !executorId` 保持原样——失败态无可选执行器是**事实**，缺陷在「灰着且无处可走」⇒ 由重试路径解决。`SopsPage` 非注释行 996→945、最长函数 1062→1016，4 个新文件各 <90 行、**无需**登记基线） | `4484efbc` | 253 |
| 2 | （同型项）F-4 模板导入端点的文档口径 | **resolved**（`manifest-contract.md` 的「本轮未做」是**过期事实**——端点在 `99a6b62e` 落地、**晚于**建档 `5810367b` ⇒ 整节改写为「已落地，但当前没有任何客户端入口」并列出全部事实；`:19`「没有第四步」改为「第四步已兑现 / 没有第五步」；**新增一节写明「导入官方清单必然 409」**（registry 5 份清单与 seed 5 个官方 key 完全同名 ⇒ 入口即坑）；`api-reference.md` **主表**补一行（409/400 边界），**附录段逐字节未变**。此前不在主表，故不新增主表行） | `dabf3e10` | 250–252 |

> **A-5 备注**：本组两条**此前都不在主表**（P3-1 与 F-4 都只在 R138 审计的候选池里），
> 按表头规则「**不要往主表加再迁走**」⇒ **只在 `§7.0-A` 留痕，主表 3 条一行未动**
> （`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`，
> 三条的重启条件都不在自治循环内）。
> **F-5（任务定义导入/导出无控制台入口）本轮未做** ⇒ **不进主表**（主表会膨胀），
> 只进状态卡候选池，并在 §7.0 的「R141 未上台同类项」段留了**带 `文件:行号` 的指针**
> （后端 `task.controller.ts:185/776`、CLI `commands/tasks.ts:725/754`、MCP
> `tools/task-operations.ts:55/67`；admin-web 0 命中）。
> **（R142 已做掉「导出定义」单入口，见 A-6 第 1 条；「导入」裁定不做，见 A-6 第 3 条。）**
> 本轮方法学 **250–253** 的完整表述见 `docs/PLAN-CLAIMS.md` 的 R141 组；
> 其中 **251（补入口前先问会不会撞已知拒绝）** 与 **253（读取失败 ≠ 空列表）** 可复用到其它 UI 缺口。

#### A-6 本季收口（R142）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | （同型项）F-5 任务定义「导出定义」控制台入口 | **resolved**（后端 `apps/admin-api/src/modules/task/task.controller.ts:776` 早已存在、CLI `packages/acf-cli/src/commands/tasks.ts:725/754` 与 MCP `packages/mcp-server/src/tools/task-operations.ts:55/67` 都有，**admin-web 0 命中** ⇒ 属「能力面不一致」而非「文档说谎」，`docs/api-reference.md:590` 从未承诺控制台入口 ⇒ **不占主表**。**只做导出**：`api/tasks.ts` 的 `exportDefinition` **必须 `responseType:'blob'`**（该端点 `@Res()` 直写附件、**绕过全局信封**）；文件名只在 `Content-Disposition`，而共享 client 的响应拦截器把 AxiosResponse 拆成 `res.data`（**头在那层就丢了**）⇒ 用 per-request `transformResponse` **在拦截器之前**把头读进闭包；RFC 6266 两级回退（`filename*=UTF-8''` → `filename="…"` → 裸 `filename=`）+ `sanitizeExportFilename`（路径分隔符→`-`、控制字符按**码点**剔除以避免 `no-control-regex`、Windows 保留字符替换、截 120 字符），头缺失回落 `<task.name>-<UTC 时间戳>.json`。新 `pages/task-detail/useTaskDefinitionExport.ts`：`inFlightRef` **同步闸门** + `exporting` 界面态（ref 管**同一 tick** 第二击，loading/disabled 管**用户意图**）；失败走既有 `showApiError`（幂等不双弹）。**不加 `isAdmin` 门控**——导出是**读面**操作、后端权限与 `GET /tasks/:id` 同档。体量：`TaskDetailPage` 1034→**1037 / 上限 1039**、最长函数 1012→**1010**（**未调 ceiling、未用 ALLOW、未删逻辑**）；新用例 5/5、task-detail-* 回归 6 文件 23 例 = 0） | `57b9cc54` | 254 / 255 |
| 2 | （同型项）三处过期数字收口 + 语言欠账上限收紧 | **resolved**（`docs/deployment.md:775` 的 `@opentelemetry/api` **不再写死版本号**、改为「以 `apps/admin-api/package.json` 的声明为准，当前 `^1.10.0`」+ 复核命令；`docs/skills/manifest-contract.md:131` 与 `package.json` 的 `//check:template-manifest` 注释「22 例」→ **23**；`scripts/user-facing-language-baseline.json` 的 `maxKnown` **9 → 8**（= 当前 `known[]` 条目数）。**被否决的提法**：R141 候选池第 5 条「改 `Math.max(prev, len)`」**方向是反的**——`--update` 在 `keys.length > prevCount && !force` 时**拒绝写盘**，`maxKnown = keys.length` 正是**正确收紧**，`Math.max` 会让上限**永不下降** = 把棘轮**废掉** ⇒ 本轮**收紧到实测值**、**不采纳**） | `87251fa6` | 254 / 255 |
| 3 | （裁定不做）F-6 任务定义「导入」控制台入口 | **裁定不做（非待办）** —— 导入需读**本地文件**（浏览器挑本地 JSON），控制台**无对应场景**，且与 CLI `acf task import` 功能**重叠**；官方五模板清单导入**必然 409**（`docs/skills/registry.json` 的 5 份清单 key 与迁移 seed 的官方 5 key 完全同名 ⇒ **入口即坑**）。⇒ 登记为「**已裁定不做**」而非 backlog；需要时走 **CLI / MCP** 既有通道 | —（R142 裁定） | 251（承 R141） |
| 4 | （指针）F-4 模板导入端点的文档口径 | **resolved**（R141 已收口，见 **A-5** 第 2 条；此处**只作指针**，避免 A-5 与 A-6 各写一半） | `dabf3e10` | 250–252 |

> **A-6 备注**：本组第 1/2 条**此前都不在主表**（F-5 只在 R141 候选池），
> 按表头规则「**不要往主表加再迁走**」⇒ **只在 `§7.0-A` 留痕**；
> **主表本轮 3 → 4 条**，新增的那条是 `coverage-snapshot-vs-full-health`
> —— 它**不是**「还没做的旧账」，而是 **R142 扩覆盖率端时引入的结构性陷阱**
> （`scripts/health-snapshot.mjs:249` 的 admin-api 默认环境步**不带 `--coverage`**
> ⇒ 跑一次全量体检就会**擦掉** `coveragePct`、棘轮随即红）⇒ 属「**当前该做什么**」，**进主表**。
> 第 3 条是**「刻意不做」**（导入入口）—— 登记为裁定，**不是**待办；
> 第 4 条是 R141 的收口，**只作指针**，避免 A-5 与 A-6 各写一半。
> 本轮方法学 **254–257** 的完整表述见 `docs/PLAN-CLAIMS.md` 的 R142 组；
> 其中 **256（扩数据源时同时点名所有写入端）** 与 **257（选步必须写确定性规则）**
> 可复用到任何「多写入端 + 多匹配」的棘轮设计。

#### A-7 本季收口（R143）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | `coverage-snapshot-vs-full-health` | **resolved**（R142 扩端引入的结构性陷阱已闭合）：`scripts/health-snapshot.mjs` 的 admin-api **默认环境步**改跑**带 coverage** 的命令，并**直接 `import`** `scripts/coverage-snapshot.mjs` 的 `ENDS["admin-api"]` ⇒ 跑法 args / cwd / json-summary 落点 / 选步规则**单一事实源**（**禁止内联第二份命令** —— 少 `--node-options=--experimental-vm-modules` ⇒ 全套件红 `createRequireEsmError`；少内存参数 ⇒ 套件 OOM；两份副本迟早漂移）。读数走 `readJestCoverage`（`total.lines.pct`）；`code !== 0` 写 `coveragePct: null`（**不伪造、不沿用旧值**）。label 仍以「admin-api 全量（默认环境」开头且**不含** `SELFTEST_SKIP_ENV_FILE` ⇒ 与棘轮 hint/exclude **互相可区分**（承 257）。**真跑** `--only="admin-api 全量（默认环境"` ⇒ exit 0 / **175s** / **92.77** / 8077-8077；`check:coverage-floor` 0（3 端）、selftest 19/19、`health:snapshot --skip-heavy` 0 且**三端 pct 跑前跑后全在**（92.77/88.88/87.45）、chain 101/101。**反证**：去掉 coverage 参数 ⇒ 真跑 162s 后该 step 无 pct ⇒ floor **exit 1「拿不到覆盖率数据」**） | `57f301a6` | 258 |
| 2 | （同型项）A6b `consumeNextFirePoint` 的 **CLI** 入口 | **resolved**（`acf task trigger --consume-next-fire-point`：帮助文案写清「仅 cron（非 cron ⇒ 400）、已有未消耗登记 ⇒ 409、**只跳一次不是暂停**、可与 `--params` 同用」；body **表驱动**「只收显式旗标」⇒ 都不给时仍是单参 `post`、请求体与改动前**逐字节一致**；README 补一行。体量：`tasks.ts` 三项度量**正好顶死基线**（1025/997/27.3）⇒ **净零改写**（两处等价折行 + opts 改 `Partial<>` + filter 表驱动替代 `if`），实测 **1022/996/27.0**，**未调高 ceiling、未用 ALLOW、未删逻辑**。新用例 5/5、`acf-cli` 全包 **16 文件/458 例** = 0、`typecheck:cli` 0、`check:cli-doc` 0） | `4d961b86` | 260 |
| 3 | （同型项）A6b `consumeNextFirePoint` 的 **MCP** 入口 | **resolved**（`trigger_task` 加可选 `consumeNextFirePoint`（`z.boolean().optional()`）；description 与参数描述写清同样三个边界；handler **只收显式给出的键**（`=== true` 才加键，**`false` 与缺省都不发**）⇒ 请求体与 A6b 落地前**逐字节一致**（发 `false` 会让「未传」与「传 false」不再等价，而两者在后端本是同一个默认）。既有 `tools.test.ts` 三条断言仍绿、该文件全 **178 条**绿；该文件非注释行 2181 **恰在基线顶格** ⇒ 新用例**独立成文件**（8 条，走 SDK **真解析** `z.object(schema).parse(args)`）。`mcp-server` 全包 **10 文件/332 例** = 0、`typecheck:mcp` 0、`test:mcp-tool-surface` 0（56 tools；**重建 dist 后** stdio 握手实测 inputSchema 已含该 boolean 键）。**遗留**：400/409 的可读成因未在 MCP 侧映射 ⇒ **只进候选池**，不上主表） | `6a3f02ad` | 260 |
| 4 | （同型项）atlas 07-testing 的测试数字同步 | **resolved**（`node scripts/check-atlas-counts.mjs --update` —— 守卫**自带的机械同步入口**，**只改数字、不动文字**：acf-cli 15→**16**、mcp-server 9→**10**（本轮两个新测试文件）；顺带同步另两处**早已过期**的数字：admin-web 285→**291**、admin-api `it/test` 静态计数 7306→**7312**。守卫判据是「文档不许**大幅**撒谎」（±5% 容差），而在 16/10 这种**小分母上容差退化成 ±0 例** ⇒ 新增 1 个测试文件就红（**刻意如此**：新增几十个不该红，少写/多写一个数量级必须红）。`check:atlas-counts` 0（12 个数字点全在门槛内）、`test:docs` 0） | `a70df980` | 261 |

> **A-7 备注**：第 1 条是本轮**关闭主表项**（`coverage-snapshot-vs-full-health`），
> 按规则（`resolved` ≥ 1 触发清理）从主表迁入本组 ⇒ **主表 4 → 3 条**；
> 第 2/3/4 条**此前都不在主表**（A6b 只在 R138 候选池），
> 按表头规则「**不要往主表加再迁走**」⇒ **只在 `§7.0-A` 留痕**。
> **教训已固化**：「**扩一个数据源时必须点名所有写入端**」（R142 只接单端快照、漏全量体检
> ⇒ 一次体检就把数据擦掉）—— 该条 R142 已写进方法学 256，但**「写下」不等于「还清」**，
> 直到本轮真跑一次体检才验证到 ⇒ 沉淀为方法学 **258**（见 `docs/PLAN-CLAIMS.md` 的 R143 组）。
> 本轮方法学 **258–261** 的完整表述见 `docs/PLAN-CLAIMS.md` 的 R143 组；
> 其中 **259（「只跑一部分」的模式要写死互斥与复用）**、**260（多客户端补齐到同一语义）**
> 与 **261（小分母上容差退化成 ±0）** 分别可复用到**子集重跑开关**、**能力面补齐**、
> **计数型守卫**三类设计。

#### A-8 本季收口（R144）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | （既有红）i18n 硬编码守卫的**采集面收窄** + 补 `--selftest` | **resolved**（`npm run lint:i18n` **由红转绿**）：6 处报错全在 `apps/admin-web/src/test-setup.ts` 的两个浮空 rejection 收割器（`:149/150/175/176`），它们是**开发者/CI 诊断信息** —— 只在测试失败时抛进日志，**浏览器永不渲染、连用例本身都读不到** ⇒ 判据（「会显示给中文用户以外观感的硬编码中文串」）**没写错**，是**采集面**把 vitest `setupFiles` 也算进了判据面。**修扫描面、不登记豁免**：`SKIP_FILES = {test-setup.ts, test-setup-scheduler-guard.ts}`（**确切文件名**，不是 `*test*` 通配；`src/**/*.test.ts` **仍被扫**，selftest 用例⑤钉住；目录级排除原样）；**不写进** `i18n-baseline.json` 的 `accepted`（「登记代替修复」⇒ 判据面会随每次新增诊断串膨胀）；`--file` 人工探针**不受排除影响**；未知参数 / `--root` 缺 `src/` ⇒ **exit 2**（拒绝静默忽略）。该脚本**此前没有 selftest**（判据面本身无人守护）⇒ 新增 `--selftest` **9 例**（真实子进程 + `mkdtempSync` 临时夹具树，断言真实 exit code）：字符串/JsxText 命中、**注释不命中**、**被排除文件不命中**、**`*.test.ts` 仍被扫**、基线命中放行、陈旧项报错、`--selftest` 与 `--check` 混用 ⇒ **exit 2**、盘点模式 exit 0。验证：`lint:i18n` **0**（主判据）、`--selftest` **9/9**、`i18n-key-check` **0**、chain **101/101**。**反证**：临时副本把 `SKIP_FILES` 改空 ⇒ `--check` **exit 1**（6 处逐条复现）+ 用例④ 转红（**1/9**）；删副本复跑 ⇒ 0（**未**用 `git checkout`） | `8358ba0a` | 262 / 263 |
| 2 | （同型项）覆盖率棘轮加 **per-step `measuredAt`**（小时级新鲜度） | **resolved**（**棘轮新鲜度现为两级**）：旧判据只读**文件级** `generatedAt`（`YYYY-MM-DD`，粒度=天）⇒ ① `--skip-heavy` 前移日期却**一步全量都不跑** ⇒ **假绿**（「上次的覆盖率 + 今天的日子」）；② 单端快照 `coverage:node` **真跑了测试却不更新** `generatedAt` ⇒ **真刷了数据反而解不了红**（R140 盲区）。**只增字段、不改既有语义**：`generatedAt` 仍是「文件生成日期」；每个 step 新增 `measuredAt` = **该 step 跑完的真实时刻**（ISO 8601 带时刻 UTC 秒精度），时刻与字段名由 `coverage-snapshot.mjs` 导出 `isoTimestamp()` / `MEASURED_AT`、**两个写基线脚本 import 同一份**（单一事实源）。**沿用不是重测 ⇒ 时间戳不许刷新**（靠 `effectiveSteps` 复用 `prev.steps` 的**原对象**、`--only` 只按位替换 ⇒ **结构保证**；`--skip-heavy` 仍前移 `generatedAt` 但新增 stderr 明说「未重跑任何 step」）。判据：**per-step（小时级）优先 → 缺失回落文件级（天级，兼容旧基线）→ 都缺 ⇒ 红「无法判断新鲜度」**，报文明说**来源 + 时刻 + 粒度**；`measuredAt` 在但**写坏 ⇒ 红且不回落**；未来时刻按 0 小时算只提示。`maxAgeDays` **保留** + 新增可选 `maxAgeHours`，**都声明时取更严者**（`min(days×24, hours)`；三端 14 天 / 336 小时）；失败步**也记** `measuredAt`。验证：`check:coverage-floor` **0**（3 端；per-step 1 / 回落 2）、selftest **19 → 27**、`--skip-heavy` **0** 且 executor-node `measuredAt` **跑前跑后不变（6/6）**、`--only="executor-node 全量"` **0**（该步被更新）。**反证**：某端 `measuredAt` 改旧 ⇒ **exit 1** 且点名「已过期 889 小时（≈37.0 天；上限 336 小时 —— 取更严者）… 来源=该 step 的 per-step `measuredAt`」**且不判覆盖率高低**；还原 ⇒ 0。**写进头注的已知误判**：手改 json、无 `measuredAt` 的旧 step、时钟回拨 | `188accdc` | 264 / 265 |
| 3 | （同型项）生成物同步：`docs/health-baseline.md` 由真跑重写 | **resolved**（`--only="executor-node 全量"` + `--skip-heavy` 两次真跑后**由脚本**重写：executor-node 步耗时 `17s → 18s`；顶部说明改为「**本次只重跑 executor-node 全量**（`--only`）：其余 step 沿用上次基线、未重跑，其 `coveragePct` 一并保留（不是被擦掉）」。**生成物不手改数字** —— 改判据/改脚本，让生成器自己写） | `a282a2d4` | 264 |

> **A-8 备注**：本组两条**此前都不在主表**（i18n 守卫的既有红只在候选池、
> 棘轮 per-step 时间戳只在候选池），按表头规则「**不要往主表加再迁走**」
> ⇒ **只在 `§7.0-A` 留痕，主表 3 条一行未动**（`ci-pg-race-unverified` /
> `web-flake-not-reproduced` / `release-notice-ops`，三条重启条件都不在自治循环内）。
> 第 3 条是**生成物同步**，不是判据变更 —— 它由 `health-snapshot` 自己写，
> 台账域**不碰数字**（与 R143 的 atlas 同步同型：机械同步入口只改数字、不动文字）。
> 本轮方法学 **262–265** 的完整表述见 `docs/PLAN-CLAIMS.md` 的 R144 组；
> 其中 **262（假红先分清判据错还是采集面错）** 与 **263（缺 selftest = 判据面无人守护）**
> 可复用到任何「守卫报红 / 新增守卫」的场合，**264（文件级 vs 测量级时间字段）** 与
> **265（两个上限取更严者）** 可复用到任何「新鲜度 / 棘轮 / 双口径」设计。
> **待办不在本组**：i18n selftest 接 CI —— **R145 已收口（`f10e2a76`，见 A-9 第 1 条）**。

#### A-9 本季收口（R145）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | （R144 遗留）i18n 守卫自检**接进门禁** | **resolved**（不是「红」，是**缺口**）：R144（`8358ba0a`）给 `apps/admin-web/scripts/i18n-scan.mjs` 补了 `--selftest`（**9 例**），但**没有任何地方跑它** —— `apps/admin-web/package.json` 的 `lint:i18n` 只串 `--check` + `i18n-key-check.mjs`，`ci.yml` 的 admin-web step 调的就是这条，而 `scripts/check-guards-wired.mjs` 的采集面是 `^check-.*\.mjs$` ⇒ **不替它报警** ⇒ 它的**判据面（采集面 + `SKIP_FILES` + 模式互斥）仍无人守护**，将来改坏不会有任何东西变红。**修法（改入口、不改 CI）**：`lint:i18n` = `node scripts/i18n-scan.mjs --selftest && node scripts/i18n-scan.mjs --check && node scripts/i18n-key-check.mjs` —— **两次调用**而非混用（`--selftest` 与 `--check` **互斥 ⇒ 混用 exit 2**，R144 已定，**不定义优先级**）；**顺序固定「先自检、再主判据」**（自检红时主判据的绿不可信）；**未改 `ci.yml`** —— CI 的 admin-web step 调的就是 `npm run lint:i18n` ⇒ **本地与 CI 共用同一入口**，不重复、**不动 action/runner 面**。`apps/admin-web/scripts/README-i18n-guard.md` 补 22 行。验证：`npm run lint:i18n` **0** 且输出含 `✔ i18n-scan selftest 通过：9/9` **在 `--check` 之前**（writer 复跑 3.41s / exit 0）、`check:actions-pinned` **0（13/13）**、`check:runner-labels` **0（7/7）**、`check:guards-wired` **0**、`size-caps` **0**、chain **101/101**。**反证（不改文件即可复现）**：直接跑**旧入口的等价命令** `node scripts/i18n-scan.mjs --check && node scripts/i18n-key-check.mjs` ⇒ **exit 0** 而 `selftest` 行命中 **0** ⇒ **「绿」不等于「自检被跑到」**；接回复跑 ⇒ 0 且 9/9） | `f10e2a76` | 266 |
| 2 | （同型项）MCP 已知后端错误码补**「成因 + 下一步」** | **resolved**：R143 让 `trigger_task` 能带 `consumeNextFirePoint`，但被拒时 MCP 只把后端 HTTP 错误**透传** ⇒ 模型看到 `API error (409): <后端文案>`，**为什么**被拒、**下一步**做什么全靠它猜；CLI 侧早有这层（`packages/acf-cli/src/error-code.ts`）⇒ 两个客户端对**同一次失败**可读性差一档。**根因**：错误面只有「状态码 → 一句话」的通用映射，**没有「按码」的成因层**。**修法**：新增 `packages/mcp-server/src/error-hints.ts` —— **按码**（不是按类别）给 `cause` + `nextStep`，当前收 **3 条 A6b 码**（`TASK_FIRE_POINT_ALREADY_CONSUMED` / `_NOT_CRON` / `_UNRESOLVABLE`）；`packages/mcp-server/src/api.ts` 的 `buildHttpError` 在既有文案后**追加**；**未知码 / 无码 / 原型链键 ⇒ `null` ⇒ 既有输出逐字节不变**。**为何是「包内第二份」**（三种否决**分档**，见 267）：读 `apps/admin-web/src/locales/generated/*` 或 `apps/admin-api/src/common/errors/catalog/task.ts` 是**结构性不可行**（`rootDir: ./src` ⇒ 跨树相对导入 **TS6059**；发布物只有 `dist`）；复用 `acf-cli` 的分类表是**语义不对**（按类别的一句话会给出**错误建议** —— 重读不会让登记变可消耗）；**只有「耦合不好看」才是偏好**。⇒ **显式第二份**，头注列**四处事实源** + **三条复核命令** + 「新增/改名错误码时两边都要看」；**刻意不做全量码表**（三百多个码必然腐化）；语言用**英文**（输出对象是模型），**未复制** zh/en 文案。**测试并入既有文件**（**未新开** —— 新开会撞 `check-atlas-counts` 的「mcp-server 10 文件」数字，文档不在写域）：9 条（39 → **48**），主判据 = 409 含成因 + 「不要重发」、400 含成因 + **两条出路**、**未知码逐字节不变**。验证：全包 **10 文件/341 例 = 0**（`tools.test.ts` 178 条与 R143 的 8 条未动）、`typecheck:mcp` **0**、`test:mcp-tool-surface` **0（56 工具）**、`size-caps` **0**、chain **101/101**。**反证**：临时让映射恒返回 `null` ⇒ **4 红**，而「未知码原样」5 条**仍绿**（它判的是「不追加」，不是「追加得对」）；还原 ⇒ 0。**遗留**：第二份表的同步**无 CI 守卫** ⇒ 见候选池第 1 条） | `dc23ad9b` | 267–269 |

> **A-9 备注**：本组两条**此前都不在主表**（i18n 自检接线只在 R144 候选池第 1 条、
> MCP 错误码可读成因只在 R143 候选池第 2 条），按表头规则「**不要往主表加再迁走**」
> ⇒ **只在 `§7.0-A` 留痕，主表 3 条一行未动**（`ci-pg-race-unverified` /
> `web-flake-not-reproduced` / `release-notice-ops`，三条重启条件都不在自治循环内）。
> 第 1 条是**给已有判据补执行入口**，第 2 条是**给已有错误面补按码的成因层** ——
> 两条都不是新增能力面，而是「**写了却没人跑 / 只有一端有**」这同一类缺口的两个样本：
> 前者缺**入口**，后者缺**第二个客户端**。
> 本轮方法学 **266–269** 的完整表述见 `docs/PLAN-CLAIMS.md` 的 R145 组；
> 其中 **266（「绿」不等于「自检被跑到」）** 与 **268（兜底映射必须「未知即原样」）**
> 可复用到任何「接线 / 加映射」的场合，**267（三种否决理由分档）** 与
> **269（第二份事实源自带复核命令）** 可复用到任何「要不要复用、不能复用时怎么写第二份」的取舍。
> **待办不在本组**：MCP 第二份码表的同步守卫（见本节上方「R145 待办」段）——
> 头注能降低漂移概率，**不能替代判据**。

#### A-10 本季收口（R146）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | （R145 遗留）MCP 错误提示表 ↔ 后端码表的**漂移闸** | **resolved**（不是「红」，是**缺口**）：R145（`dc23ad9b`）在 `packages/mcp-server/src/error-hints.ts` 建了「已知后端错误码 → 成因 + 下一步」的**第二份**表（跨包读后端码表**结构性不可行**：MCP 包 `tsconfig` 的 `rootDir: ./src` ⇒ 跨树相对导入 **TS6059**；发布物只有 `dist`）。头注只写了「新增/改名错误码时两边都要看」⇒ **靠人记 = 没有守卫**：后端加减一个 A6b 码，MCP 表就**静默过期**（新码退回裸 HTTP 文案、无成因与下一步），**无任何信号**。**修法**：新增 `scripts/check-mcp-error-hints.mjs`（零依赖静态，~0.3s）—— 判据①（**不限族**）MCP 表里每个码必须在后端码表**真实存在**；判据②（**只限 `TASK_FIRE_POINT_*` 族**）后端 A6b 族每个码必须在 MCP 表里；判据③ 两边都记 `status` 时必须一致（当前 MCP 表不记 ⇒ 真仓库上空跑，已由 selftest 反证会红）。**判据②的边界是本守卫最容易写错的地方**：后端码表 **431** 个码、MCP 表**刻意只收 3 条**（R145 头注：全量码表必然腐化）⇒ 若写成「每个后端码都要在表里」第一天就红 **428** 条且永远红 ⇒ **永远红的守卫等于没有守卫**（豁免是全局的，真漂移来了也一起被豁免掉）；selftest 用例②是这条边界的**控制组**（`TASK_NOT_FOUND` 不在表里必须 **exit 0**）。**5 类结构红**（绝不退化成「0 项漂移」）：码表读不出/分片数不符、MCP 表缺失或字面量不闭合、表里出现**非裸标识符键**（字符串键/计算键/展开 —— 那是「本守卫读不到它」的形状，必须点名）、MCP 表解析出 **0 条**、后端 A6b 家族解析出 **0 个码**（家族前缀被改名 ⇒ 判据②退化成「空集合永远合规」）。**解析复用** `scripts/lib/error-catalog.mjs` 的 `readCatalog()`（与 `gen:error-i18n`/`check:error-i18n` **同一份口径**，不另写正则）；MCP 侧自写深度扫描器（`typescript` 在零依赖的 `test:guards` job 里不可用）。**接线**：`package.json` 加 `check:mcp-error-hints`（`--selftest && 主跑`）并挂进 `test:guards:chain`；**链 101 → 102**（**追加在末尾，不动既有段位** —— 段位是别的守卫与台账的定位锚，插中间会让所有后续编号错位）；`ci.yml` 加 step；`docs/health-baseline.{json,md}` 的 `metrics.segments` 与度量表/对比表同步（**生成物机械同步，不手改数字**）。**验证（真实 exit）**：主跑 **0**（「后端码表 **431** 个码 · A6b 族 **3** 个 · MCP 表 **3** 条 · 记录 status 并可核的 **0** 条」）· `--selftest` **0（10/10）** · `test:guards:repo` **0（解析 102 段 / 执行 102 段 / diff 空）** · `size-caps` **0** · `guards-wired` **0**（91 / 89 / 88）· `atlas-counts` **0** · `test:docs` **0** · `script-main-guard` **0** · `workflow-yaml` **0** · `actions-pinned` **0** · `runner-labels` **0**。**反证（均还原）**：① 表里加 `TASK_FIRE_POINT_GHOST` ⇒ **exit 1** 点名「后端已不存在」；② 后端**新增** `TASK_FIRE_POINT_BRAND_NEW` ⇒ **exit 1** 点名「未进 MCP 表」（**这才是缺口的真实形态**：①防「为还不存在的码写成因」、②防「后端加码而表静默过期」）。selftest 另含 6 条（控制组 / `status` 不一致 / 字符串键结构红 / 表被清空结构红 / 家族前缀被改名结构红 / 未知参数与坏 `--root` ⇒ exit 2） | `a13f0b88` | 270 / 271 / 272 |
| 2 | （同型项）atlas `07-testing` 的**守卫接线数字刷新** | **resolved**（**过期约一个半月**）：`docs/atlas/07-testing/README.md` 的「现况」段写的是 **2026-10-30 实跑**的数字（**46** 个 check 脚本 / **47** 个有自检 / **46** 个两面都跑），其间新增 **45** 个守卫 ⇒ 过期。**「不写具体数」与「写具体数」各有各的坏法**：不写 ⇒ 信息量为零且描述性说法同样会漂移；写 ⇒ 没有生成入口就必然腐烂（这张表的数字**不在** `check-atlas-counts` 的机械同步面内，是**实跑输出**，只能人工核）⇒ 处置不是二选一，而是「**写具体数 + 写清口径（日期 + HEAD + 上一版是什么）**」。按 **2026-11-07 实跑**（HEAD `a13f0b88`）更新为 **91 / 89 / 88**，**日期与 HEAD 一并写明**，并**保留一行**注明「上一版是 2026-10-30 快照」（否则会被读成「同一天的两个数打架」）。**顺带补两处覆盖面事实**（此前读者会**高估**体系强度边界）：① **「守卫数量」≠「受覆盖计数保护的守卫数量」** —— 判别型脚本 **98** 个（`check-*` ∪ `agent-*`）里**只有 13 个**登记了覆盖计数，其余 **85 个尚无覆盖计数保护**；② **`--root <dir>` 支持面 91 个里 82 个**，并**逐个列出**不支持的 **9** 个（`check-agent-event-limits` / `check-brand-drift`（+`.selftest`）/ `check-collaborator-self-call` / `check-npm-audit-exemptions` / `check-protocol-three-way` / `check-sanitize-parity` / `check-source-text-contracts` / `check-spec-coupling-surfaces`）—— **写具体数若不写清口径就会变成新谎言**。**验证**：`check:atlas-counts` **0** · `test:docs` **0** · `size-caps` **0** | `d3e825b9` | 273 |

> **A-10 备注**：本组两条**此前都不在主表**（MCP 码表漂移闸只在 R145 候选池第 1 条、
> atlas 数字刷新是 R146 才出现的文档面），按表头规则「**不要往主表加再迁走**」
> ⇒ **只在 `§7.0-A` 留痕，主表 3 条一行未动**（`ci-pg-race-unverified` /
> `web-flake-not-reproduced` / `release-notice-ops`，三条重启条件都不在自治循环内）。
> 第 1 条是「**写下的义务没有执行的判据**」（与 266 同型：头注里的「两边都要看」是**提醒**，
> 记忆没有版本也没有 exit code）；第 2 条是「**现况数字会腐烂**」（46/47/46 挂了**一个半月**
> 没人发现，因为它**看起来和真的一样**）。
> 本轮方法学 **270–273** 的完整表述见 `docs/PLAN-CLAIMS.md` 的 R146 组；
> 其中 **270（「永远红的守卫等于没有守卫」）** 与 **272（判据面塌方要结构红）**
> 可复用到任何「新增集合包含型守卫」的场合，**271（第二份事实源必须配漂移闸）**
> 可复用到任何「不能复用真值源 ⇒ 只能写第二份」的取舍，**273（现况数字要带日期与 HEAD）**
> 可复用到任何写台账现况数字的场合。
> **待办不在本组**：**85 个判别型脚本尚无覆盖计数保护**（只有 13 个登记了）——
> 见本节上方「R146 待办」段与 `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 1 条；
> 另一条：**9 个守卫不支持 `--root`** ⇒ 候选池第 4 条 —— **该条已由 R147 收口（见 A-11）**。

#### A-11 本季收口（R147）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | （R146 遗留）**9 个守卫补 `--root` 支持**（判据面可夹具化的前提） | **resolved**（不是「红」，是**工具性前提的缺口**）：本仓守卫的约定是「**仓库根当参数传，别硬编码 `process.cwd()`**」，`--root <dir>` 是这条约定的唯一执行面 —— 它让守卫能指向**临时目录里的夹具仓库**（selftest 必须造假仓库、**不能碰真仓库**）。实测 `scripts/` 下 **90** 个 `check-*.mjs` 里 **81** 个已支持、**9** 个不支持（`check-agent-event-limits` / `check-brand-drift`（+`.selftest`）/ `check-collaborator-self-call` / `check-npm-audit-exemptions` / `check-protocol-three-way` / `check-sanitize-parity` / `check-source-text-contracts` / `check-spec-coupling-surfaces`）⇒ 那 9 个**写不了夹具自检**（只能在真仓库上跑）⇒ **其判据面没有黑盒自检保护**，改坏**没有任何东西会变红**。**根因**：判据面的**自保能力**取决于「守卫能不能被搬到假仓库上跑」，而这条**能力本身没有守卫**（它只是 90 个脚本各自的 argv 解析习惯）⇒ **能力面的缺口不会自己报红**，它只让「将来该写的那些自检」**根本写不出来**。**修法（9 个脚本、同一口径，与 `check-agent-stub-fidelity` / `check-mcp-error-hints` 同款）**：① `--root <dir>` 与 `--root=<dir>` **两种形态都认**；② **缺省根仍按脚本位置锚定** ⇒ 不传时 stdout 与改前**逐字节相同**（没有一处 `process.cwd()` 被当成仓库根 ⇒ 从子目录误跑不会扫空目录、不会假绿）；③ 缺值 / 空值 / **真空格误吞下一个开关** ⇒ **exit 2**；④ 指向**不存在目录** ⇒ **exit 2**、**不静默回落到真仓库**（「以为在跑夹具、实际跑的是真仓库」是最坏的假绿 —— 且**用法错误(vs)判据红**必须是 2 与 1 两个出口）；⑤ 指向**存在但不是本仓形状**的树 ⇒ **结构红 exit 1**（一句话 + 实际查找的路径，**不是 ENOENT 栈**）；⑥ **6 个内联 selftest** 的 `--selftest` 与 `--root` **互斥 ⇒ exit 2**（对照组钉在真仓库上，换根会让它失去意义；互斥比静默忽略诚实）。每个脚本头注补「**仓库根从哪来（`--root`）**」小节。**五处不是机械复制**：`check-brand-drift.selftest` **+3 条黑盒 CLI 用例**（spawn **主脚本**传 `--root=<夹具>`：合规 ⇒ 0 / 破坏后 ⇒ 1 / 不存在 ⇒ 2）⇒ 主脚本若吃掉 `--root` 必红（**21 → 24**）；`check-collaborator-self-call` 补「**扫到 0 个 ⇒ 结构红 1**」，堵 `walk()` 吞 ENOENT 造成的假绿（判据面塌陷绝不能以「0 个文件、0 处违规」结账）；`check-source-text-contracts` 的 `--root` **连两张登记表**都按根解析（否则「登记表是脚本旁边的常量」会让整棵树搬不走、自检只能测纯函数）；`check-spec-coupling-surfaces` 的自检临时报告改落 `os.tmpdir()`（**不再往仓库写盘**）；`check-npm-audit-exemptions` 区分**两类 cwd** —— **仓库根**（默认审计面 + `--dir`/`--replay` 的**回落**基准）受 `--root`，**`process.cwd()`**（用户敲在命令行上的相对路径的**首选**基准）**不改**（实证：`cd /tmp` 时 `--dir apps/admin-api` 必须回落到夹具根而非被 cwd 抢走，混为一谈会**改变行为**）。**atlas 数字同步**：`docs/atlas/07-testing/README.md:151` 的 `--root` 支持面「90 中 81」→ **「90 个现已全部支持」**，并保留「R147 之前是 90 中 81、9 个不支持」+ 逐个清单。**验证（真实 exit）**：9 个主跑全 **0**（stdout 与改前**逐字节相同**）· `--root=<不存在>` 与裸 `--root` **全部 2** · 每个脚本夹具面均实测（合规 ⇒ 0 / 破坏后 ⇒ 1 / 非本仓形状的树 ⇒ 结构红 1）· `check-guards-wired` **0** · `size-caps` **0** · `test:guards:repo` **0** 且末行「解析 **102** 段 / 执行 **102** 段 / diff 空」（**链仍 102，未新增段**）。体量 10 文件 **+748/−41**。**已知限度（写进头注）**：`check-protocol-three-way` 的判据是「三侧**真跑**对拍」⇒ 夹具树跑不动 ⇒ 它的 `--root` 买的是「口径统一 + 绝不悄悄跑真仓库 + 探针落盘跟随根」，**不是**「判据可夹具化」；其判据面自保由**既有** `--selftest`（**25** 例纯函数/内存行）承担 | `980e53aa` | 274–276 |

> **A-11 备注**：本组唯一一条**此前不在主表**（只是 R146 候选池第 4 条 + R146 待办的下半段），
> 按表头规则「**不要往主表加再迁走**」⇒ **只在 `§7.0-A` 留痕，主表 3 条一行未动**
> （`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`，
> 三条重启条件都不在自治循环内）。
> 本组是「**买前提**」而不是「**还债**」：R147 只把「**写不了夹具自检**」变成「**还没写**」。
> 若台账只写「9 个已支持 `--root`」，下一个读者会以为**债还清了** ⇒ 必须当场把
> 「**还差什么**」登记出来（→ 274 第③条）。
> 本轮方法学 **274–276** 的完整表述见 `docs/PLAN-CLAIMS.md` 的 R147 组；
> 其中 **274（能写自检夹具是工具性前提）** 可复用到任何「补测试/补守卫」的排期判断，
> **275（静默回落到真仓库是最坏的假绿）** 可复用到任何「带默认值的输入参数」设计，
> **276（根 vs 用户路径基准）** 可复用到任何 CLI 的 cwd 语义改动。
> **待办不在本组**：**9 个守卫现在能写夹具自检了，但还没有写**（**可分批**，先挑判据最脆的
> 2–3 个）—— 见本节上方「R147 待办」段与 `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 1 条；
> 另一条：**85 个判别型脚本尚无覆盖计数保护** ⇒ 候选池第 2 条。
> —— **该待办已由 R148 部分兑现（3/9 已写），指针已更新，见 A-12 与「R148 待办」段。**

#### A-12 本季收口（R148）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | （R147 遗留）**3 个守卫补黑盒 CLI 夹具自检**（判据面从「白盒」升到「黑盒」） | **resolved**（不是「红」，是**判据面没有黑盒保护**）：R147（`980e53aa`）给 9 个守卫补了 `--root <dir>` ⇒ 它们**能**指向临时目录里的夹具仓库，**但自检还没写** ⇒ 那 9 个守卫的**判据面**仍只有**白盒**保护（把内部函数抽出来喂内存 fixture，或把守卫脚本复制进夹具树 —— 按 `scripts/lib/guard-selftest.mjs` 头注的立场，那是「**测的是函数，不是守卫**」：`process.exit(1)` 被删、参数解析把路径吃掉、根被静默回落到真仓库，它都看不见）。**最硬的一条证据**：`check-source-text-contracts` 既有 **35** 条用例**一条都没碰过 `applyRoot()`** —— 那正是 R147 唯一会换根的地方 ⇒ **把 `applyRoot()` 里那两行删掉，35 条照样全绿**，而守卫会**静默读真仓库**（最坏的那种假绿，= 275 同族）。**修法（3 个脚本，统一形态）**：`runGuard(SELF, ["--root=<mkdtemp 夹具>"])` **spawn 真脚本**、断言**退出码 + 报错文本**（文本断言是关键：只看退出码分不清「判据红」与「脚本自己崩了」）；夹具建在 `os.tmpdir()` 的 `mkdtemp` 下、**用完即删** ⇒ **绝不往仓库写任何文件**；**互斥不构成障碍**（`--selftest` 与 `--root` 互斥管的是**同一次调用**，spawn 出的子进程**只带 `--root`**）；每个脚本头注补「**自检覆盖了什么 / 没覆盖什么**」小节（**盲区必须写在脚本里**，台账会被翻过去，头注是下一个改它的人**一定会看到**的东西）。**三个守卫**（选法 = 判据复杂 × 夹具可行 × 现有 selftest 离 CLI 有多远，**刻意不按文件名顺序**）：`check-source-text-contracts`**35 → 41** 例（两张登记表 × 各 4~5 条判据 + 一张启发式扫描器 `LOOKBACK`/`LOOKAHEAD`；**既有用例一条没碰换根** ⇒ 退化风险最高）；`check-sanitize-parity` **8 → 13** 例（4 判据 × 6 入口 × 全 `apps/admin-api/src` 字面量扫描；**6 个入口路径全是模块加载期常量** ⇒ 既有 8 条 **100% 进程内**）；`check-collaborator-self-call` **9 → 15** 例（正则静态分析 + `ALLOW` 阈值 + 双前缀；既有 9 条里 7 条纯字符串、只 1 条读真源码；新增含「**扫到 0 个协作者 ⇒ 结构红 1**」—— **R147 新增的那条判据此前只在真仓库上跑过**，没有任何东西证明「0 个文件 ⇒ 0 处违规 ⇒ 绿」这个退化形态真的会红，= 272 同族）。**验证（真实 exit）**：三个 `--selftest` 全 **0**（**41/41 / 13/13 / 15/15**）· **主跑 0 且 stdout 与改动前逐字节相同**（writer 独立复核：`git archive` 导出 `14518900^` 与 `14518900` 到**同一路径**跑 `diff -q` ⇒ 三者 stdout 全 **same**，stderr 只差 node 警告里的 **PID**，归一化后全 **same**）· `check-guards-wired` **0**（**91 / 89 / 88 / 13** 四个数字**全不变**）· `test:guards:repo` **0（102/102，段数未变）** · `size-caps` **0** · `atlas-counts` **0** · `test:docs` **0** · `guard-liveness` **0** · `script-main-guard` **0**。**红演示（均还原）**：合规夹具改违规形态 ⇒ 对应用例 **exit 1**；另做**反方向**（违规改回合规 ⇒ 反例用例红）⇒ 两侧都有牙。**「自检面 88/89 不变」不是缺陷**：那三个数统计的是「**有几个守卫有自检文件**」，本轮补的是**既有守卫的既有 `--selftest` 里的用例** ⇒ **分母不变、用例条数变** ⇒ 涨的是「**判据覆盖深度**」（41 / 13 / 15 例，其中黑盒夹具 6 / 5 / 6 条），**这是另一个量，必须另外报**（→ 277）。**盲区（已写进三个脚本头注）**：夹具是**自检手写的最小样本**、不是真仓；`check-sanitize-parity` 的共享实现是「真实现的逐字节副本」⇒ 真实现被改弱时正例夹具也会红（**重复信号**，不是假绿，但读报告要分清根因）；`check-protocol-three-way` 判据是「三侧**真跑**对拍」⇒ 夹具树没有 `node_modules`/`python3` **跑不动**；`check-spec-coupling-surfaces` 是 **report-only** ⇒ **不存在**「违规 ⇒ exit 1」形态，**硬写就是改判据**（越界，→ 279） | `14518900` | 277–279 |

> **A-12 备注**：本组唯一一条**此前不在主表**（只是 R147 候选池第 1 条 + R147 待办的下半段），
> 按表头规则「**不要往主表加再迁走**」⇒ **只在 `§7.0-A` 留痕，主表 3 条一行未动**
> （`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`，
> 三条重启条件都不在自治循环内）。
> 本组与 A-11 是**同一件债的两半**：A-11 买的是「**能写**」（工具性前提），A-12 才是
> 「**已写**」（保护本身）⇒ 两组**必须分开记**，否则「9 个已支持 `--root`」会被读成
> 「9 个已受保护」（→ 277）。
> 本轮方法学 **277–279** 的完整表述见 `docs/PLAN-CLAIMS.md` 的 R148 组；
> 其中 **277（工具到位 ≠ 判据被保护；且「自检面」与「判据覆盖深度」是两个量）**
> 可复用到任何「补测试/补守卫」的排期判断与**现况数字**口径，
> **278（新引入的变量必须自带用例；覆盖率看路径覆盖不看用例数）**
> 可复用到任何「加了开关/参数」的改动，**279（report-only 守卫没有『违规 ⇒ exit 1』形态）**
> 可复用到任何「要不要给某个守卫补红演示」的取舍（**先问它的失败形态是什么**）。
> **待办不在本组**：**9 个守卫的夹具自检还剩 6 个没写**（**3/9 已写**）——
> 见本节上方「R148 待办」段与 `docs/plan/rounds/AUTONOMY-STATE.md`「候选池」第 1 条；
> 另一条：**85 个判别型脚本尚无覆盖计数保护** ⇒ 候选池第 2 条。
> —— **该待办已由 R149 推进到 6/9，指针已更新，见 A-13 与「R148 待办（指针已由 R149 更新）」段。**

#### A-13 本季收口（R149–R150）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | （R148 遗留）**守卫夹具第 4 个：`check-agent-event-limits` 补黑盒 CLI 夹具**（黑盒覆盖 6/9） | **resolved**（不是「红」，是**判据面仍全在进程内**）：R148 给 3 个守卫补了黑盒 CLI 夹具，本守卫是第 4 个候选 —— 它的既有 **9 条断言一条都没经过 CLI 入口**（全进程内直调内部函数）⇒ 与 `check-source-text-contracts` 同类的退化形态（→ 278）。**修法**：改后 **17 条编号用例、其中 10 条 spawn 真脚本**（`runGuard(SELF, ["--root=<mkdtemp 夹具>"])`，照 R148 统一形态）；黑盒面覆盖：合规 ⇒ **0**（夹具里写「16 条」这种**异构值** ⇒ 证明根真的换成了夹具、**不是回落真仓库**，= 275 的正面证据）／批上限改小 ⇒ **1** 点名「不自洽」+ 两个数／单条上限改大 ⇒ **1**（**两个方向都有牙**）／非算术字面量 ⇒ **1** 结构红／缺文件 ⇒ **1** 可读一句话（**显式断言无 ENOENT 栈帧**）／空树 ⇒ **1** 逐文件点名／`--root` 不存在 ⇒ **2**／裸 `--root` ⇒ **2**／`--selftest`+`--root` ⇒ **2**。**验证（真实 exit）**：`--selftest` **0**（**17/17**）· 主跑 **0** 且 **stdout 与改动前逐字节相同**（**84B**，`sha256 6c05b49e…a373`，`cmp` **IDENTICAL**）· `size-caps` **0** · `guards-wired` **0**（**89 / 88 不变**）· `test:guards:repo` **0（102/102，段数未变）** · 无残留 `/tmp/acf-event-limits-*`。**红演示三向（均还原）**：**A** 夹具侧单条上限 `2048 → 8192` ⇒ **4/17 红**；**B** 守卫侧**删掉 `process.exit(1)`** ⇒ **5/17 红，且进程内用例全绿、只有 CLI 面抓到**（黑盒夹具的价值本身，同时暴露全仓通病：**失败分支后无 `return`、只靠 `process.exit`**）；**C** 短路互斥 ⇒ **1/17 红**且递归被一层截断（**1s、无残留进程**；已加 `ACF_EVENT_LIMITS_SELFTEST_CHILD` **防 fork 炸弹**）。**顺带产出「已有夹具」核对表（只读）** —— **「用例多」≠「黑盒夹具有」**：`check-brand-drift.selftest` 24/24 ✅（3 条真黑盒）／`check-npm-audit-exemptions` 31/31 ⚠️（**仅 10 条**真子进程，**21 条进程内**）／`check-protocol-three-way` 25/25 ❌（0 黑盒，spawn 的是**被测实现**不是守卫自己）／`check-spec-coupling-surfaces` 30/30 ❌（0 黑盒）⇒ **黑盒 CLI 夹具覆盖 6/9**；剩 2 个**不是缺 `--root`**，是**判据形状**问题。**盲区 5 条已写进头注**：`ESCAPE_WORST_FACTOR=2` 改不到／只验常量值不验实际用法／迷你 TS 片段不覆盖 `readonly`/`as const`／文件系统边界未测／`Function()` 恶意构造成本未验。**已有夹具核对表本体在 `artifacts/autonomy/R149/impl-fixture.md`**（gitignore、**不入库** ⇒ 结论已抄进本表与 §7.0） | `9db3abbc` | 280–281 |
| 2 | （R149 只读审计）**F2 + F4：把「读取失败」当「没有数据」** | **resolved**（同一型，本仓已修过多次的**漏网**）：**F2（P2）执行器详情** —— `metrics` / `executions` 两个查询的 `error` 被丢弃 ⇒ **一个失败点污染四个面**：性能统计「暂无性能数据」、24h 趋势「暂无历史采样」、活跃卡**静默回落**到进页快照**却仍标「每 30s 轮询」**、执行历史「该执行器暂无历史执行记录」，三句**互相印证的假事实**把用户引向「设备是新的 / 采样没开」。**F4（P3）SOP 详情抽屉** —— `versions`/`assignments` 两 Tab **无 `loading`、无错误态**；`openDetail` 失败只弹**文案错**的 toast（说「SOP **列表**加载失败」，实际失败的是**详情**；列表刷新是页内 15s 轮询那条独立链路）+ **无重试**。**根因**：查询层 `error` 没被解构 ⇒ `undefined` 与「后端返回空桶/空列表」在渲染层**不可区分**，而空数组在后端契约里是**业务事实**（= 253 同族）。**修法（复用全站既有 `components/StateError`，不自造）**：F2 —— 解构 `error` + `refetch`；**统计/趋势错误优先于数据**（语义是「近 7 天/24h 的聚合结论」，拿旧聚合继续画会被读成「现在就是这样」，**比空态更糟**）；**活跃卡相反**（数值是真的、只是时刻旧）⇒ **保留数值** + 标注改「轮询已中断」+ `Alert` 明说「下方为进入页面时的快照值」+ **就地重试**（三块信息**同屏**才可诊断）；执行历史错误时**不渲染**「暂无历史执行记录」（已加载行保留）。F4 —— 加 `detailLoading`/`detailError` + 抽屉内 `StateError` **就地重试** + 两 Tab `loading` 且**错误时撤掉空态** + toast 改「详情」文案。新增 **6 个 i18n 键**（zh/en 成对，沿用 `executorDetail.*` / `sops.*`）。**体量**：`ExecutorDetailPage` **858/863**（fn 989/997）、`SopsPage` **964/996**（fn 1045/1062）；**未外提新文件、未调 ceiling、未用 ALLOW、未删逻辑**。**验证**：新用例 **6/6**；相关回归 15 文件 76 例=**0**（另 4 文件 24 例）；`typecheck`/`lint`/`i18n-key`/`size-caps`/`user-facing-language` 全 **0**；`chain` **0（102/102）**。**反证**：F2 还原 ⇒ **2 failed / 1 passed**；F4 还原 ⇒ **3 failed**；均恢复后全绿。**已知取舍（如实）**：轮询偶发失败时趋势/统计会**短暂**以错误块替换旧图（下一拍自愈）；执行历史失败保留旧行、分页 `total` 为**缓存值** | `b88db534` | 282 |
| 3 | （R149 只读审计）**F1：「下发到设备」弹窗静默截断部署行** | **resolved**：弹窗取部署行只拿**前 100 行**且**丢弃 `total`**（`deploymentsApi.list(app.id, 1, 100)`）；后端按 `createdAt DESC` 排序 ⇒ **被截掉的恰是最老的行**，而最老的行恰是最可能**仍在 `running`** 的长期驻留实例。弹窗是**破坏性动作的确认面**，它宣称「这是可下发的设备全集」，实际是「最新 100 条」⇒ 缺席设备的用户只会得到「这台机器没部署过」**这一种解释**（真相是分页窗口），两者**处置完全不同**。**根因**：同文件 `ReleasesTab` **早已修过同类截断**（P8：`truncated` + `Alert type=warning` + 出口按钮）⇒ 此处是**同类漏网**；且 `deps.total` 被直接丢弃 ⇒ 渲染层**无法区分「真空」与「被截断」**。**修法（照抄 P8 形态，不自造）**：**保住 `total`**（`deps.total ?? rows.length` —— 旧后端不带 `total` 时回落实取行数、**按未截断处理，不谎报截断**）；`total > 已取行数` ⇒ `Alert type=warning`「本应用共有 {{total}} 条…此处仅列出最近 {{shown}} 条；还有 {{hidden}} 条更早的记录未显示（**这些更早的记录里可能仍有正在运行的设备**）」+「查看部署实例」出口；**真空态与截断态分开**（`total === 0` ⇒「暂无部署行」；`rows.length === 0` 但 `total > 0` ⇒ **不能**说「没有部署」，新词条 `deployEmptyUnknown` **带数字**）；顺带把「快照包地址」**三态显式化**（此前「确定没有」与「没读到」都表现为**什么都不显示**）。**体量**：该页原本 **1302/1302（零余量）** ⇒ 弹窗整块 JSX **外提**成 `pages/application-detail/{DeployToDevicesModal.tsx,deploy-pkg-state.ts}`（新文件均 <600 非注释行 / <300 函数 ⇒ **无需登记基线**），页面降到 **1253/1302**；**未调 ceiling、未用 ALLOW、未删逻辑**。**验证**：新用例 **9/9**；`application-detail-*` 3 文件 14 例=**0**；更宽回归 8 文件 76 例=**0**；`typecheck`/`lint`（**0 error 0 warning**）/`i18n-key`/`size-caps`/`user-facing-language` 全 **0**；`chain` **0（102/102）**。**反证三条（均真转红并还原）**：A 还原截断提示（`truncated = false`）／B 还原真空态判断（一律 `deployEmpty`）／C 还原「丢弃 `total`」 | `fdcff7de` | 283 |

> **A-13 备注**：本组三条**此前都不在主表**（守卫夹具是 R148 候选池第 1 条；F1/F2/F4 只在
> R149 的只读审计 `artifacts/autonomy/R149/assess-frontend.md` 里，而该审计本身**不入库**）
> ⇒ 按表头规则「**不要往主表加再迁走**」**只在 `§7.0-A` 留痕，主表 3 条一行未动**
> （`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`，
> 三条重启条件都不在自治循环内）。
> **两条线的共同点**：第 1 条是**判据面**（守卫还连着吗），第 2/3 条是**数据面**
> （失败被渲染成空 / 截断被渲染成全集）—— 都是「**屏幕上显示的东西在替你编一个事实**」。
> **同批只读审计的结论（P1 0 / P2 2 / P3 3）**：F1/F2/F4 已修，**F3/F5 未修**
> ⇒ 都进 `docs/plan/rounds/AUTONOMY-STATE.md`「状态卡候选池」前列 + §7.0 留指针
> （两条都**必须先外提**：`TaskDetailPage` 只剩 **2 行**、`ExecutorInstallWizardPage` **零余量**）。
> **已核实无缺陷（勿重复上报）**：F-2 misfire 已修（R140）、F-5 导出已修（R142）、
> 分页钳制四处已实现、跨页选中已无同型、入口面 **219 path / 255 方法**全比对无新缺口、
> 全量 JSX 扫描 **93 处 icon-only 仅 1 处未命名**、模态焦点与 SSE 守卫齐全。
> 本轮方法学 **280–283** 的完整表述见 `docs/PLAN-CLAIMS.md` 的 R149–R150 组；
> 其中 **280（「用例多」≠「黑盒夹具有」）** 可复用到任何「报夹具覆盖」的场合（**先问 spawn 的是谁**），
> **281（黑盒夹具能抓到进程内用例结构上抓不到的东西）** 是「判据面最终形态是退出码就必须 spawn 进程」
> 的正面证据，**282（一个失败点污染多个面要逐面定策略）** 可复用到任何「共享查询的错误呈现」，
> **283（确认面的数据必须与它宣称的作用域一致）** 可复用到任何**破坏性动作的确认面**。
> **待办不在本组**：`protocol-three-way` / `spec-coupling-surfaces` 的黑盒夹具
> （见本节上方「R148 待办（指针已由 R149 更新）」段与候选池第 3/4 条）；
> F3 / F5 两个前端小项（候选池第 1/2 条，**两条都必须先外提**）。


#### A-14 本季收口（R151）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | （R149–R150 候选池第 1 条）**F3（P3）任务详情「执行记录」Tab 把「读不出来」渲染成「没执行过」** | **resolved**：`useTaskExecutions` 的 `error` 被丢弃（页面只解构 `data` / `isLoading`）⇒ 查询失败时表格渲染「暂无执行记录」。而「这个任务**从没执行过**」与「执行记录**读不出来**」是**方向相反的结论**：前者会让人**立刻手动触发一次**（本 Tab 右上就是「手动触发」）⇒ **多一次真实执行**；后者应当**重试 / 报障** —— **同一句文案让人做相反的事**（→ 284）。**同页自带反例**：`task` 有整页错误块、`stats` 失败时**整块不渲染**（宁可缺席也不撒谎），唯独该查询**既无错误分支、又有明确空态文案** ⇒ **三处口径不一致**，错的那处恰好**带破坏性后果**。**根因**：`error` 未被解构 ⇒ `undefined` 与「后端返回空列表」在渲染层**不可区分**（= 253 同族）。**修法**：「执行记录」Tab 的**整块 UI + 列定义外提**到 `pages/task-detail/ExecutionsTab.tsx`（该页只剩 **2 行余量**，错误分支**无处可放**），补**三态** —— `execError` ⇒ 复用既有 `StateError` + **重试**（`refetch`），**不渲染**「暂无执行记录」、**不渲染**缓存旧行（错误态**整段替换**表格）；无错且空 ⇒ **保留**「暂无执行记录」（**真空态逐字未改**）。**外提前例照抄** R150 `pages/application-detail/DeployToDevicesModal.tsx` / R141 `pages/sops/AssignSopModal.tsx`（新文件均 <600 非注释行 / <300 函数 ⇒ **不新增基线条目，仍 98 条**）。**体量**：`TaskDetailPage` 由 **1037/1039 降下来**；**未调 ceiling、未用 `ALLOW`**。**验证**：新用例 **3/3**；`task-detail-*` / `install-wizard-baseline` 回归 **3 文件 10 例 = 0**；`typecheck` / `lint` / `i18n-key` / `size-caps` / `user-facing-language` 全 **0**；`chain` **0（102/102）**。**反证**：错误分支改恒假 ⇒ **用例①② 双红**（**2 failed \| 1 passed**，③ 真空态**仍绿** ⇒ 说明它测的确实是**另一件事**），还原 ⇒ **3/3 绿** | `e1303c19` | 284 |
| 2 | （R149–R150 候选池第 2 条）**F5（P3）安装向导「共享 Token 显示/隐藏」icon-only 按钮无可访问名** | **resolved（判据落地 + 已补 DOM 层断言 `c5d9fd69`；测试欠账如实登记且已被补上）**：全仓 **93 处 icon-only 控件里唯一缺的一处**（其余 92 处要么在 `Form.Item` 下有 `label`、要么自带 `aria-label`）⇒ 读屏用户听到的只有「按钮」：既不知道它做什么、也**不知道点下去是显示还是隐藏**；而它落在**安装流程的令牌卡片**上（`EXECUTOR_SHARED_TOKEN`，泄露风险面）⇒ 不是形式主义。**修法**：补 `aria-label`，**名称随状态联动**（「显示共享 Token」/「隐藏共享 Token」）—— 读屏用户听到的是**马上要发生什么**，不是静态标签（→ 285）。**体量**：该页原本 **830/830 零余量** ⇒ 把该按钮 **5 行属性表压成 4 行净省 1 行**（**等价压缩换行数**，→ 240）；**未调 ceiling、未用 `ALLOW`**。**遗留（如实）**：**F5 没有自动化 DOM 测试** —— ① 真渲染测试卡在 **antd v6 `Select` 在 jsdom 里的展开 / 选中交互**（本仓**无「点选项」既有先例**，实测 `.ant-select-item-option` **点不到**）⇒ 走不到「共享 Token 卡」那一步；② 源码文本断言**不被本仓判据接受**（`check:source-text-contracts` 要求登记，且读源码**证明不了 DOM 上确有名字**）。⇒ **正确解 = 先把「共享 Token 卡」整体外提成独立组件、再用 props 直接测三态 + a11y**（→ 286），留作下一轮；指针见「R151 新增待办」段与候选池第 2 条。**⚠ R152 更正**：该欠账**已补 DOM 层断言（`c5d9fd69`）** —— 上面那段「遗留」记录的是**F5 落地提交时的状态**（**当时记的是真话**），但「测不了」这个**结论是错的**（**它其实可测**，三个 jsdom 坑见**本组第 3 条**）⇒ 引出方法学 **287** | `e1303c19`（判据）+ `c5d9fd69`（DOM 断言） | 285–287 |
| 3 | （R151 新增待办第 1 条 / 候选池第 2 条）**F5 的可测化 —— 补上「共享 Token 显示/隐藏」按钮的 DOM 层 a11y 断言** | **resolved（✅ 已还清）**：R151 记的欠账「**F5 没有自动化 DOM 测试**」——当时两条路都失败（① 真渲染卡在 antd v6 `Select` 在 jsdom 里的展开/选中交互，本仓**无「点选项」先例**；② 源码文本断言**不被本仓判据接受**（`check:source-text-contracts` 要登记，且**证明不了 DOM 上确有名字**））——**记录的是当时的事实（真话）**，但由此得出的「测不了」**这个结论是错的**：**它其实可测**，关键是三个 jsdom 坑 —— ① `combobox` 角色落在 **`.ant-select-content`** 里（不是 `.ant-select-selector`）；② 页面**两个** Select（类型/平台）⇒ 必须 `getAllByRole('combobox')` 取**第 0 个**；③ 选中后「下一步」的 `disabled` 要**等 React 提交** ⇒ **点击必须在 `waitFor` 之外**（在 `waitFor` 回调里点会**重复触发**、状态被反复重置 ⇒ 表现为「**永远走不到第 2 步**」）。**交付**：`apps/admin-web/src/__tests__/install-wizard-token-a11y.test.tsx`（**2 例**）—— ① 名称**随状态联动**（「显示共享 Token」⇄「隐藏共享 Token」，且**旧名必须消失**）；② 该屏**不留无名按钮**（遍历所有 `<button>`：无文字 + 无 `aria-label` + 无 `title` + 无 `aria-labelledby` 一律判红）。**验证**：新用例 **2/2**；install-wizard 相关 **5 文件 30 例 = 0**；`typecheck` / `lint` / `size-caps` 全 **0**；`chain` **0（102/102）**。**反证（两条都真转红并还原）**：① 断言名改成不存在的名字 ⇒ 用例①**红**；② **删掉组件里的 `aria-label`** ⇒ 用例①②**双红** ⇒ 证明它真在**读 DOM 上的名字**、不是恒真。⇒ **最终解法不是「外提组件 + props 测」，而是真渲染直接测** ⇒ 引出方法学 **287**（判「测不了」前先确认是不是**路径没找对**） | `c5d9fd69` | 286–287 |

> **A-14 备注**：本组**三条**（F3 / F5 判据 / F5 的 DOM 断言）**此前都不在主表**（F3/F5 只在 R149–R150 候选池第 1/2 条，
> 而它们的来源是一次**不入库**的只读审计 `artifacts/autonomy/R149/assess-frontend.md`）
> ⇒ 按表头规则「**不要往主表加再迁走**」**只在 `§7.0-A` 留痕，主表 3 条一行未动**
> （`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`，
> 三条重启条件都不在自治循环内）。
> **两条的共同前提是「改不动」**：一条**整块外提**（`TaskDetailPage` 余 **2 行**）、
> 一条**等价压缩换行数**（`ExecutorInstallWizardPage` **0 余量**）—— **两条都没碰 ceiling**。
> **第 3 条是 R152 的补记**（`c5d9fd69`）——它**不改前两条的结论**，只**还清一条欠账**：
> 「F5 的可测化」这条**待办指针**已按方法学 **246**（旧待办登记不应保留）标注为**已还清**。
> 这正是 240 的正面样本：**顶格文件要换「等价表达」，不换阈值**。
> **F3 与 F5 表面上一个是数据面、一个是 a11y 面，共同的判据缺陷是「一个通道里塞了两个相反的结论」**：
> F3 是「**空**」（没执行过 / 读不出来），F5 是「**名字**」（显示 / 隐藏）——
> **同一个位置只表达了两件事里的一件，另一件就变成了谎言**。
> **本轮方法学 284–286 的完整表述见 `docs/PLAN-CLAIMS.md` 的 R151 组**：
> **284**（方向相反的两个结论不能共用空态文案）可复用到任何「空态 + 错误态同位置」的场合；
> **285**（icon-only 名字要说「马上要发生什么」）可复用到任何**双态控件**的可访问名；
> **286**（区分「不值得测」与「工具链不够」）是**「判据不许降级」的另一面** ——
> 写不出测试时**先改结构、再换工具，不改判据**；
> **287**（R152 补记，判「测不了」前先确认是不是**路径没找对**）是 **286 的续集** ——
> 「本仓无先例」是关于**怎么写**的，不是关于**能不能测**的；**解法常已在仓里**，只是没找对路径。
> **待办不在本组**：**覆盖率棘轮新鲜度收紧**
> （R151 计划项、subagent 失败未做）⇒ 见「R151 新增待办」段与候选池第 1 条。
> （**F5 的可测化**已由 R152 收口 ⇒ **在本组第 3 条**。）

#### A-15 本季收口（R152）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | （R151 新增待办第 2 条 / 候选池第 1 条 —— **R151 的失败项，本轮重做**）**覆盖率棘轮新鲜度收紧：声明了 `maxAgeHours` 的端必须有 per-step `measuredAt`** | **resolved**：R144 的「回落」口径是**洞**不是保守 —— 判据是「per-step `measuredAt` 优先，缺失则回落文件级 `generatedAt`（天粒度）」，而 `npm run health:snapshot -- --skip-heavy` 会**前移 `generatedAt`**（既有语义，**一步 full 都不跑**）⇒ 没有 `measuredAt` 的端看起来「刚测过」；R152 之前三端是**「声明了 `maxAgeHours=336` 却根本没有 `measuredAt`」**的矛盾状态（承诺小时级新鲜度、全靠天级回落）。**修法**：① 三端**真跑回填**（executor-node `--only` **19s** / admin-api **165–190s** / executor-python **204–210s**，全 **exit 0**，pct **88.88 / 92.77 / 87.45**）；② **判据收紧**：声明了 `maxAgeHours` ⇒ **缺 `measuredAt` 即红且不回落**，报文点名「该端没有 per-step 时间戳 ⇒ 新鲜度不可信（文件级 `generatedAt` 会被 `--skip-heavy` 前移）」+ 给该端**刷新命令**；**未声明**的端保留天级回落并**显式登记为已知盲区**；③ 基线每端新增 **`measuredAtPolicy`**。**selftest 27 → 31**，关键反例㉑：声明 hours + 缺 `measuredAt` + `generatedAt` **极旧（400 天）** ⇒ **红的理由必须是「缺 per-step 时间戳」而不是「已过期」**。**验证**：`check:coverage-floor` **0**（**per-step 3 端 / 回落 0 端**）· selftest **31/31** · `--skip-heavy` 后 `measuredAt` **6/6 逐字不变** · `chain` **0（102/102）**。**反证**：删某端 `measuredAt` ⇒ **exit 1** 点名 + 刷新命令，还原 ⇒ **0**。**过程**：两个 writer 并发撞同一批文件、**一度丢掉 node 的 `measuredAt`** ⇒ 用**再跑一次真测**（19s）补回而非手写（→ 290） | `0f43ef89` | 288、290 |
| 2 | （R152 本轮实测两次链红才归因）**`check:ssrf-parity` 随机红：SSRF 三端探针固定写进仓库目录 ⇒ 并发互踩** | **resolved**：`check:ssrf-parity` **随机**变红、报「缺 `.__r10_probe.cjs`」这类 **ENOENT**，本轮**两次链红都是它**（均第 **6/102** 段）、重跑就好 ⇒ 表面像 flake，实为**确定性竞态**。**根因**：admin / node 两臂的探针**固定写进仓库目录**（两臂各把探针写在自家 app 目录下、文件名同为 `.__r10_probe.cjs`）并 `try/finally` 删除 ⇒ 两个并发进程（或一个被 `SIGTERM`/`SIGKILL` 杀掉的进程）**互踩**：A 写 → B 写 → **A 的 `finally` 删掉** → **B 的 spawn 拿不到文件**；被杀进程还会把探针**永久留在仓库**（未被 `.gitignore` 覆盖 ⇒ 污染 `git status`）。这正是本仓既有方法学点名过的「**固定临时路径 = 并行互杀源**」，而**同一脚本的 python 臂早已 `mkdtempSync`** ⇒ admin / node 是**同类漏网**（→ 289）。**修法**：两臂改为每次调用 `mkdtempSync(os.tmpdir())` **私有目录**（与 python 臂同款），`finally` 里 `rmSync({recursive:true})` **整目录删**；**探针内容零改动**（靠 `ACF_ADMIN_UTIL` / `ACF_NODE_GUARD` 两个**绝对路径**环境变量定位被测模块，与探针所在目录无关）。写域只有 `scripts/ssrf-category-matrix.mjs`（**+12/−4**），**判据零改动**。**验证**：`ssrf-category-matrix` **0** · `check:ssrf-parity` **0**（三端 25 个 IP 字面量决策逐条相同、零豁免）· **6 个并发实例同时跑全部 exit 0**（改前这种并发必然互踩）· 两个 app 目录**零 probe 残留** · `chain` **0（102/102）**。**反证**：**并发本身即是反证**（该缺陷的判据面就是并发） | `549cc485` | 289 |

> **A-15 备注**：本组两条**此前都不在主表**（棘轮那条是 R151 的**失败计划项**、SSRF 探针是
> **本轮两次链红才敢归因**的偶发红）⇒ 按表头规则「**不要往主表加再迁走**」**只在 `§7.0-A` 留痕，
> 主表 3 条一行未动**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`）。
> **两条的判据缺陷是同一个形状：判据面里本来就有一条「看起来能过」的通道** ——
> 棘轮那条是**时间粒度混用**（契约写小时、证据只有天，而天级证据可被**不测量的命令**前移）；
> SSRF 那条是**共享可变路径**（固定临时文件名 ⇒ 并发/被杀进程互踩，且**一遍单跑照样全绿**）。
> 因此两条的验证都**不能只写「跑一遍绿」**：棘轮要看 `--skip-heavy` 后 `measuredAt` **逐字不变**
> 与「**per-step 3 / 回落 0**」，探针要看「**6 并发全绿 + 零残留**」。
> **288–290 的完整表述见 `docs/PLAN-CLAIMS.md` 的 R152 组**：
> **288**（回落口径不是保守是洞）可复用到任何「缺失即回落」的新鲜度/完整性判据；
> **289**（固定临时路径 = 并行互杀源，第三次复现）要求**修反模式时扫同一文件的所有同类臂**；
> **290**（并发丢数据要重测不要手写）是「**台账按证据记**」在**并发现场**的那一面 ——
> 手填的时间戳与真跑**格式完全一样**，判据永远发现不了。
> **待办不在本组**（指针见「R152 收口说明」段与候选池第 1/5 条）：
> ① `guards-repo-matrix` 失败报文补**该段自身的 stderr 摘要**（本轮两次链红只能看到段号）；
> ② **未声明 `maxAgeHours` 的端仍是回落口径**（当前无承载者，建 admin-web / 全链 floor 时
> **须同批声明 + 回填**）。




#### A-16 本季收口（R153）

| # | id | 结论 | 收口提交 | 方法学 |
|---|---|---|---|---|
| 1 | （R152 新增待办① —— 指针，**本轮还清**）**`guards-repo-matrix` 失败报文补该段自身的 stderr/stdout 尾部** | **resolved**：`test:guards:repo` 失败时只有三行（段号 + 命令 + 退出码），实际排障**不够** —— R152 实测**两次链红**（均第 **6/102** 段 `check:ssrf-parity`）都只看到「第 6 段 exit 1」，真原因（并发互踩的 ENOENT）在**上方几十段输出**里，得人肉往上翻几百行。**根因**：`spawnSync(..., { stdio: "inherit" })` ⇒ 子进程输出**直连终端**，父进程**看不到内容**、只能拿退出码（「红在哪一段」有、「这一段为什么红」没有）。**修法**：改**异步 `spawn`**，stdout/stderr **边跑边透传**（保留实时性与长段进度感）+ 各留**环形缓冲（最近 20 行）**；失败时把两段尾部**原样回放进失败报文**；顺带把**信号**也记进报文（旧报文只报 `code`，被 `SIGTERM` 杀的段 `code=null`、以前显示成 `exit 1`），该段零输出时**显式说明「大概率是信号」**。**不变语义**：仍 fail-fast / **退出码原样传播** / 仍逐段打印 `[k/N] <cmd> => exit N` ⇒ **只加信息、不改判定**（→ 291、292）。**验证**：`--list` **0**（102 段）· `--only=1` **0** · `--from=101` **0** · `check-script-main-guard` **0** · `chain` **0（102/102，段数未变）**。**红演示**：把链第 2 段换成 `echo 原因 >&2; exit 3`（跑完立即还原 `package.json`）⇒ 报文额外打印 `── stderr 尾部（最近 20 行）── │ the-real-reason: fixture exploded at step 3` 与 `── stdout 尾部（最近 20 行）── │ some-stdout-context`，且**退出码仍是 3** | `90bdafcb` | 291、292 |
| 2 | （R152 候选池第 6 条）**`ci.yml` admin-web i18n step 的过时注释** | **resolved**：该 step 注释写「`npm run lint:i18n` **只跑主跑**」，而 R145（`f10e2a76`）已把它改成 `i18n-scan --selftest && i18n-scan --check && i18n-key-check` ⇒ **注释与实现相反**，会让下一个人**误判**「i18n-scan 的自检没人跑」，甚至以「反正没人跑」为由把自检**摘掉**。**修法**：注释改为说明三件事 —— ① `lint:i18n` 现在**已包含** i18n-scan 自检；② 为什么必须**两次调用**（`--selftest` 与 `--check` **互斥**，混用 ⇒ **exit 2**）且**顺序固定**（自检是主判据的前置体检）；③ 下面单独列的 `i18n-key-check --selftest` **不是重复**，是**另一个判据**（缺键）的自检。**只改注释**，未动任何 step 的 action/runner/命令（→ 293）。**验证**：`check:actions-pinned` **0** · `check:runner-labels` **0** · `check:workflow-yaml` **0** · `chain` **0（102/102）** | `1de83ccf` | 293 |

> **A-16 备注**：本组两条**此前都不在主表**（第 1 条是 R152 留下的**待办指针**、第 2 条是 R152
> **候选池第 6 条**）⇒ 按表头规则「**不要往主表加再迁走**」**只在 `§7.0-A` 留痕，主表 3 条一行
> 未动**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`）。
> **两条的共同形状：不是「功能没做」，而是「已有的东西没把话说清楚」** ——
> 一条是**诊断信息没跟着失败结论走**（人要往上翻几百行），一条是**注释与实现相反**（人会被注释
> 误导）⇒ 修的都是「**读的人会看错**」，而不是行为。
> **因此两条的验证都不能只写「跑一遍绿」**：报文那条要**红演示**（注入必红段 ⇒ 报文里真的出现
> 该段 stderr/stdout 尾部，且**退出码仍是 3**），注释那条要**三条 CI 判据**兜着
> （`check:workflow-yaml` 尤其关键 —— 改 YAML 必须有解析判据）。
> **291–293 的完整表述见 `docs/PLAN-CLAIMS.md` 的 R153 组**：
> **291**（可观测性要落到「失败时能直接看到原因」——R21 解决「红在哪段」、R153 解决「这段为什么红」）；
> **292**（`stdio: "inherit"` 与「可诊断」互斥 ⇒ 要实时性又要可回放，只能**双向 pipe + 实时透传 +
> 环形缓冲**，不是二选一；且**信号与退出码要分开记**）；
> **293**（注释也会与实现相反、且比代码更难发现 ⇒ **改了脚本语义就要 grep 一遍注释里的同一说法**；
> **「注释说没做」比「注释没说」更危险**）。
> **待办不在本组**（指针见「R153 收口说明」段与候选池第 1 条）：
> **「链红的偶发红仍未被持久观测」** —— 同类「并发互踩 / 临时产物」缺陷没有**持续观测通道**；
> 可给 `test:guards:repo` 加「**重复跑 N 次**」的慢通道（形态照 `web-flake-watch`）—— **只登记，不立项**。

### 7.0 主表（**R132 起已并入 `§7.0-A`**）

本小节原口径是「只有 `needs-reading@sha` 留在主表」。R35 已把 5 条逐条判完（主表 0 条），
R132 又把那 5 条**明细整体迁入 `§7.0-A` 的 A-2** —— 原因是「标题写 0 条、表里还挂着 5 行」
正是本次要消除的形态：**主表只放当前该做什么**。


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
