# AUTONOMY-STATE — 状态卡（R208 收尾交接版 · ≤50 行）

**基线**：`3543f932`（R207，`git log -1`）· 本轮落地 **1 个提交**（R208「队列空转」真机验证 + 判据前提修正）· **守卫链 111 段**（本机实测 **106 段 exit 0**；第 55/107 段是环境既有缺口 —— `packages/{mcp-server,acf-cli}` 无 node_modules/dist，stash 后原版同样红；**未新增链段**）
**会话**：第 208 轮 · 并行第 136 批 · **单靶 + 1 个只读侦察子代理**（守卫基线侦察，R207）

## 本轮落地（R208 · 1 项 · 已复核）

**★「队列空转」真机验证（清 R207 自己登记的 `unverified`）—— 结论：接线行为正确，但判据文档写的「为什么成立」是错的。**
- **真机探针**（`npm run test:r207-queue-idle-live`，真 Redis 8.10.3 + BullMQ 9.x + **真 Worker**）**17/17 全绿**：阈值推导 · 表头语义 · `timestamp`/`attemptsStarted` 保真 · 无 worker ⇒ 停摆**让位** · worker 卡住 ⇒ **空转成立** · 两判据**互斥** · 放行恢复 ⇒ 不再报 · **清理残留 = 0**（查出来是 0，不是「我删了」）。**反证**：改坏 ⑨ ⇒ 16/17。
- **★ 真机推翻文档前提**：R206 写「waiting 是 **ZSET**（score=入队时间）⇒ 升序第一个最老」。**BullMQ 9.x 上错** —— `addStandardJob-9.lua` 是 `LPUSH`/`RPUSH`，`TYPE wait` = **`list`**。`wait` 是 **LIST（插入序）**，`timestamp` 只是字段。生产路径二者**恰好一致**；但 **delayed promote 会插表头**而 `timestamp` 仍是当初算 delay 的时刻 ⇒ **错位**，实测偏差 **2 小时**。
- **偏差方向安全**：只会让年龄**算小** ⇒ **只漏报、不误报**。精确取 `timestamp` 最小需扫全表（O(n) 往返），本端点是**无状态 GET** ⇒ 刻意接受并写进 §5。已就地修正 check 头注 / service 两处注释 / 判据文档 §1·§3.1·§5。
- **新脚本已登记** `script-main-guard-exempt.json`（守卫点名要求）；`package.json` 加 `test:r207-queue-idle-live`。

## 前轮留档（R207 · 1 项 · 链**未跑满**，见「验证」）

**★「队列空转」接线（R206 候选池第 1 条）** —— `docs/observability/agent-queue-idle-criterion.md` 的判据从「只有纯函数」变成**端到端可见**：接管台**第五个徽标**。
- **阈值由已有量推导**（R403）：`wallClockMs(1800000) × AGENT_QUEUE_CONCURRENCY(2) + heartbeat tick(30000) = 3,630,000`（60.5min）。**任一分量非法 ⇒ 0 ⇒ 不判定**（宁可漏报），**刻意不回落默认值**（否则「配置坏了」被伪装成「判定正常」）。
- **停摆优先让位**（`suppressedBy: "queue-stall"`）：复用 R205 的 `isQueueStalled` **本体**，`active` 传真实值 ⇒「有人在干活 + 最老 job 很老」**不被吞掉**。
- **防假事实**：读失败 ⇒ `degraded` 且 `idleStuck` 恒 false；服务缺席 ⇒ 显式 **503** `AGENT_QUEUE_IDLE_CHECK_UNAVAILABLE`。
- 落地文件：`agent-queue-idle-check.ts`（**追加**推导函数）· **新** `agent-queue-idle.service.ts` · `agent.controller.ts`(`GET sessions/queue-idle`) · `agent.module.ts` · error catalog · **新** `QueueIdleBadge.tsx` · `AgentAttentionBadges.tsx`(挂载) · `api/agent.ts` · zh/en 各 6 键 · 后端 spec 13 条 / 前端 spec 5 条。

## 前轮留档（R192 · 3 项）
**① 修掉一个「CI 一直红着」的既存缺陷（本轮最高价值）** —— `node scripts/agent-boundary-check.mjs` 在 HEAD 上**退出 1**（`denied 落库` / `awaiting_approval 落库`）。**根因**：**R99（`61e9c0fa`，ADR-031 步骤 4）** 把台账行构造块搬进 `apps/admin-api/src/modules/agent/tools/tool-call-row.util.ts` 的 `deniedRow()` / `awaitingRow()`，而断言仍**只读** `tool-executor.service.ts` 的源码文本 ⇒ 字面量不在了 ⇒ **判据失真，却没有任何东西发现它**（它不在 jest 里、主跑只打印「✘」不阻断 PR、没人跑）。**修法**（判据强度不变、覆盖面扩大，照 R157 对 web 源码断言的同类处理）：**两处一起读** —— 既要求构造器里写着这两个 `status`（**定义处**），也要求执行体**真的调用了**这两个构造器（否则「定义了但没人用」也会绿）⇒ exit 0，**CI 的 admin-api job 恢复绿**。（→ 310）
**② 4 个 `agent-*` 守卫补 `--selftest`（`0df0d731`）** —— **两个前提被实测推翻**：(a) `check-guards-wired.mjs` 的 `scanGuards()` **只收 `/^check-.*\.mjs$/`** ⇒ `agent-*` **从不在判据③ 扫描面**（文件头 :861 自己写了）⇒ 登记 `SELFTEST_ALLOWLIST` 会立刻报「陈旧自检豁免」⇒ **`covered-elsewhere` / `one-side` 不可执行**，豁免表**一个字节没动**；(b) 四守卫的判据本体**未被 jest spec 完全覆盖**（trigger 13 / boundary 约 20 / runtime 6 / sop 约 30 组断言零覆盖）⇒ 不能豁免 ⇒ 全走 **B**：把**纯源码文本断言**抽成 `checkSourceTextGroups(rootDir)`，**主跑与自检共用同一个函数**（结构上排除「自检抄一份判据」），`--selftest` 自建夹具 + 跑**真子进程** + 断言退出码与报错文本 + 每条反例配**正例控制组**，**入口分派放在 `require("typescript")` 之前** ⇒ 自检零依赖能进本地门禁；`test:agent` / `test:sop` 改成 `--selftest && 主跑`（**两面只接同一个入口**）。**边界如实写进头注**：转译+运行层夹具跑不了 ⇒ 自检只覆盖**纯文本层**（= jest **不**覆盖的那一半）。顺带修 1 条 trigger 判据失真（`scope: {}` 命中的其实是 **cron 路径**）⇒ 计数 79 → 80。
**③ 覆盖率登记 34 → 54（三批 24 条）+ `protocol-three-way` 判据层抽取（`6631eb89`）** —— 登记侧**一处真实踩坑**：初版按「我以为的注册函数名」写 helper ⇒ 哨兵立刻结构红并点名「**守卫打印 17，源码里实际数出 10**」⇒ **helper 名字是判据的一部分**（→ 311）；并修 **HEAD 的一处坏状态**（并发写者提交了登记却没提交对应文件 ⇒ **中间提交是红的** ⇒ 登记表与它引用的守卫**必须同一个提交**，→ 312）。抽取侧：R160 只读评估证实**接线层完全裸奔**（9 条变异现有 25 条自检**一条都抓不到**）；结论「值得拆、**不需要 ADR**」；本步**只搬代码**（新增 `scripts/lib/protocol-three-way-judge.mjs` 非注释 536，抽出期望推导 10 函数 + 比对 6 函数 + 8 常量 + **新增导出 `judgeAll`**；主脚本 1699 → **1061**，**探针执行留在主脚本**）⇒ **买到「可测试性」不是「保护」**（→ 313）。

## 验证 / 红演示（R208 · 真实 exit）
- **验证**：真机探针 **17/17 exit 0** · `agent-queue*` **4 套 30 例全绿** · `size-caps` · `test:docs` · `check-script-main-guard`(+selftest 3/3) · `check-guards-wired`(98) 全 **0**。
- **反证**：把探针 ⑨ 的断言改坏 ⇒ **16/17 红**。
- ⚠️ **仍有边界**：探针复刻接线层**读法** + 调**生产纯函数**判定，**没有**起完整 NestJS 进程打真实 HTTP；也**没有**覆盖「worker 事件循环阻塞 ⇒ 心跳过期」（那是停摆判据的误报窗口）。

## 前轮留档（R207 · 真实 exit）
- **验证**：后端新 spec **13/13** · `src/modules/agent/__tests__` **15 套 148 例全绿**（`--runInBand`）· 前端新 spec **5/5** · web 相关 9 套 **54 例全绿** · `typecheck`(api/web) · `size-caps` · `test:docs` · `check-web-type-drift` · `lint:i18n`(3239/3640) · `check:error-i18n`(434) · `check:error-migration`(595 文件 0 裸异常) · `check:api-error-format` · `gen-api-reference --check`(223 paths) · `check:guards-wired`(98) · `lint:api` · `lint:web` **全 0**。
- **红演示（3 处，均已实测）**：阈值回落魔法数 ⇒ ②③⑥ 红 · 去掉 `degraded` 守卫 ⇒ ⑤b 红 · `suppressed` 并进 `degraded` 分支 ⇒ 前端 ④ 红。
- ⚠️ **`test:guards:repo` 未跑满**：第 55 段（`test:mcp-tool-surface`）与第 107 段（`lint:cli`）红，**均已 stash 后复跑证实是环境既有缺口**（`packages/{mcp-server,acf-cli}` 无 node_modules/dist），与本轮无关；其余 **106 段 exit 0**。

## 前轮留档（R192 · 验证）
- **验证**：`test:guards:repo` **0（102/102，段数未变）** · `check:guards-wired` **0**（自检面 **91/90 不变**、豁免 **0 新增**、**54 已登记 / 44 未登记**，扫描面 **98**）· 4 个 `agent-*` 的 `--selftest` **全 0**（9/7/8/8）· 4 个主跑 **全 0** · `test:agent` **0** · `test:sop` **0** · `size-caps` **0** · `check-script-main-guard` **0** · `check:atlas-counts` **0** · `test:docs` **0**。
- **红演示**：floor 临时改 **99**（> 实测 11）⇒ 判据④**红**并点名「**用例计数 11 < 下界 99**」；还原 ⇒ 0。另：初版 helper 名写错时哨兵**主动结构红并点名两个数字** ⇒ **判据自己抓到了判据的错**。

## 教训（406–407，接 405）
- **406「单测能证明『给定观测时判定正确』，不能证明『观测本身正确』」** —— R207 的 13 条后端用例全绿，但喂的全是**我自己 stub 的 queue**；错的恰好是「真实队列长什么样」。⇒ 凡判据依赖外部系统事实（排序/事务/锁语义），**必须有一次真机断言**。
- **407「真机探针红了，先问『红的是产品还是探针』」** —— 本轮 ⑩ 第一次红，根因是探针把「很老」的 job 排在了残留 job 之后。改探针前先读它的构造假设，否则会把「探针 bug」写成「产品 bug」。

## 前轮教训（404–405，接 403）
- **404「让位 ≠ 读不到」** —— 两者都会让徽标**不显示**，但一个是**完整判定**、另一个是**判定坏了**。压成同一条分支的实现**更简洁且能过 3 条测试**（实测：合并后只有第 ④ 条红）⇒ 必须**分别**钉住两种「不显示」。
- **405「反证要先问『这条用例真的能失败吗』」** —— `degraded` 守卫的**第一版反证没红**：让 `waiting` 抛错时最老 job 本就是 `null`（判据恒 false ⇒ 有没有守卫都一样绿）；换 `workers` 抛错又被「停摆让位」吞掉。**只有 `paused` 抛错**才对靶心。⇒ 「加了一条反证」≠「反证有效」。

## 前轮教训（310–313）
- **310「判据自己会腐烂，且比产品代码更难发现」** —— `agent-boundary-check` 的两条断言在 R99 重构后**已失真**，却①不在 jest 里、②主跑只打印不阻断 PR、③没人跑 ⇒ **CI 一直红着**。纪律：**源码文本断言必须绑定「它读的那个文件 / 那段代码的所有者」**；被搬迁的代码要在**同一提交**里更新所有「按路径读它」的断言（承 250/303）。
- **311「helper 名字是判据的一部分」** —— 登记表 `helper` 与守卫 `printCoverageBanner` 第二参**必须逐字相同**；猜一个「语义上应该对」的名字会让哨兵结构红。**判据的输入不是「意思对」而是「字面对」**。
- **312「登记表与它引用的文件必须同一个提交」** —— 分开提交会留下一个**中间提交是红的**，而 CI 只看 HEAD ⇒「我先提登记表、文件稍后补」这个习惯会把主干钉红。
- **313「抽取买到可测试性，不是保护」** —— 把判据从 I/O 里拔出来、纯函数化、搬进 lib，只让它**能被测**；**没有夹具就仍然裸奔**（本轮反证：删一整支 `hardFailures` 后自检仍 25/25 全绿）。⇒ 拆分类重构的**验收必须包含「装夹具之后才敢说保护」**。

## 剩余 backlog（`§7.0` 主表 **3** 条）
`ci-pg-race-unverified`（需真机并发）· `web-flake-not-reproduced`（**partially-resolved**：3 个形态中 2 真缺陷 + 1 时序假设已修；`coverage:web` 连续 exit 0；**不声称根除**；nightly 采样通道已上线但**尚无样本** ⇒ `unverified@4ef8b24d`）· `release-notice-ops`（需运维窗口）。

## 候选池（已排序）
1. **探针补「真 HTTP 端点」一层**（S）—— 现状验证到「接线层读法 + 生产纯函数」，**没有**起完整 NestJS 打 `GET /agent/sessions/queue-idle`。要补：起 admin-api（需 PG+Redis，本机都有）+ 登录取 JWT ⇒ 断言响应字段与 `suppressedBy` 的线上形态。
2. **停摆判据的误报窗口**（M）—— 「worker 事件循环阻塞 ⇒ 心跳过期 ⇒ `workers=0`」这一类本轮**没覆盖**，是 `queue-stall` 的已知误报源。
3. **自动补 enqueue**（M）—— 要定「谁补 / 补几次 / 怎么防反复补」⇒ **独立立项**。
4. **五个徽标加低频自动刷新**（S）—— 现状都只随主列表刷新；五个徽标**同时**出现时
   运营的注意力是稀缺资源 ⇒ 可考虑「只轮询最严重的那一个」（**待定**，需先问价值）。
5. **`saveDeadLetter` 死代码**（S）· **判据⑨「跟随变量」盲区**（M，R168 已登记「只登记不立项」）。
6. **`§7.0` 主表 3 条**（**外部阻塞**）：`ci-pg-race-unverified` · `web-flake-not-reproduced` ·
   `release-notice-ops`。

**已完成里程碑**：**前端 P3 九条全部修完**（R188–R195）· **R169 审计 17 条全闭环** ·
**`no-explicit-any` 三段全开、73 → 0**（R196）· **「读失败渲染成没有」在 admin-web 已清零**（R197）·
**「异常接管台」五个徽标齐了且全部接线完成**（R198/R199/R203/R205/**R207**）· **五个判据严格互补**
（待接管 · 卡住 · 积压 · 停摆 · 空转）· **两级阈值不变式**（R200）。

## 方法学（累积，末条 = 407）
407 探针红了先问红的是产品还是探针 · 406 单测证不了「观测本身正确」·
405 反证要先问「这条用例真的能失败吗」· 404 让位 ≠ 读不到（两者都要单独建模）·
403 阈值不该是魔法数，应**由某个已有量推导**（本仓的墙钟预算就是「单 job 合理耗时上界」）·
402 说「做不到」必须写出**查了哪些 API/源码**，**能指到行号**才算查过（否则它变成永久路障）·
401 注册表类观测用**计数接口** · 400 「读不到」有两种形态 ⇒ **部分失败要单独建模** ·
399 加新判据先列「已有判据各覆盖哪一格」
