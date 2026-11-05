# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `d335483e` · 工作区干净 · **R18-B 已记 blocked（3/3 止损生效）**
**会话**：第 22 轮已收 · 20 轮产出（R01–R20，56 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；R20 主动纠正自己的假证据，做对了）

## ⚠ 事实纠正（推翻我 R18/R19 两张卡的证据）
R19 我引用的「交错证据 `claim_at_ms=6ms < hb_ms=43654ms`」**是假的**：`hb_ms` 被脚本自己的轮询等待污染 ⇒ 不等式恒真。R20 改为「先 await 心跳、后实测」得 `hb_ms=220/40ms` vs `claim_at_ms=5–6ms` ⇒ **交错真实存在，但当时引用的那个数字不能作为证据**。凡我引用过该数字的结论，证据源已作废（结论本身——「交错发生」——仍成立，靠新度量）。

## R18-B：**BLOCKED**（PLAYBOOK §7.19 已登记）
- **阻塞对象**：协议层「心跳 vs 派发占坑」并发判定（I1/I2/I3）无法建立——派发从未落到本执行行。
- **已确证三点**：① 执行行由生产创建 ✓（`POST /api/tasks/:id/trigger` 201 ⇒ `task_executions`=1、`status=pending`、`executorId=NULL`）；② **「离线」已排除**（R19 的 offline 来自 stale sweep：日志实拍 `status='offline'`, `offlineReason='stale_timeout'`, `consecutiveHeartbeatMisses >= 2`；补 10s 保活心跳后稳定 `online`，候选池非空，**仍不指派**）；③ **日志里没有任何针对本执行的派发尝试**，只有心跳/指标/stale sweep 与 `WHERE "dispatchedAt" IS NULL`、`status='waiting'` 的扫描。
- **未收敛**：trigger→dispatch 那一跳为何没落到本行（候选：outbox/`dispatchedAt` 阶段未走到 / 消费侧 leader 未持有 / `dispatch-decision-log` 有拒绝记录）。**根因未明 ⇒ 按规则不动手**。
- **重启条件**（三条，任一满足才回 R18-B）：见 §7.19；**禁止**再发明造数 SQL、**禁止**放宽 `inFlight===0 ⇒ 红`。
- 回归：定向 0 · `typecheck` 0 · `guards:repo`(89 段全跑) 0 · `docs` 0 · `size-caps` 0 · `race-wired` 0 · `reserved-slots` 0 · `guard-harness` 16/16；容器 `acf-r18/19/20-*` 残留 0，`acf-*` 未动。

## 方法论沉淀
㊸ **自纠比自证更值钱**：R16 抓到压测脚本假绿、R20 抓到「交错证据」被轮询污染 —— 两次都是**自己的证据先错**。⇒ 以后凡是「A 时间 < B 时间」这类不等式证据，必须先把两侧的计时起点与等待行为写清，否则不许当证据。

## 未收口（按优先级）
1. **换靶任务必须开工**（R20 预算耗尽未开始）：守卫框架 meta 改造 —— `scripts/check-guards-wired.mjs:424-425` 把 **89 段 `&&` 链**改成「运行期解析 / 逐条独立报告 / 失败即停且点名」；判据已固化（注入失败守卫能**点名** + 反向验证能回旧行为）。
2. R18-B 三条重启条件（§7.19）。
3. 并发轴仍缺：`rolloutBatchClaimId` CAS / `agent_approvals` consume。
4. `executor-node` `.env` 约束；`desktop-bundle-drift` 字节哈希待 CI；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3 越界态提示。

## 下轮第一步（R21 = 换靶开工，**本轮必须落地**）
1. `git log -1 --oneline` 确认 `d335483e`（**自己跑**）；
2. 立项 **`guard-chain-meta`**：读 `check-guards-wired.mjs:424-425` 现状（字符串展开面）→ 改为**运行期解析** + 逐条独立报告 + 失败即停点名；
3. 判据（红→绿）：现状下注入一个**必然失败的守卫** ⇒ 报告能点名该守卫且 exit≠0（不做链尾兜底也算）；改造后同注入 ⇒ 点名更精确、**逐条 [exit N] 可读**；反向验证 = 移除新机制回到旧行为能红；
4. 全链回归 `guards:repo` **89 段全跑且 exit 0**（改造不能少跑任何一条 —— 这是最容易翻车的点）；
5. 若改造面过大（涉及 CI yml + 89 段全重排）⇒ **先写 ADR** 再动，或降级为「只加逐条报告 + 点名，不动链结构」。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、**不等式证据要先审计时起点（㊸）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
