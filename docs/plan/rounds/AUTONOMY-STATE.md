# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `a4e616f2` · 工作区干净 · 守卫链 92 段
**会话**：第 40 轮已收 · 38 轮产出（R01–R38，87 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本轮只改文案、未动 CAS/状态机，守住了边界）

## R38 结论（已补文案，**只改提示**）
- **现状判定**：旧文案 `审批单 <key> 已被另一次调用使用（一张批准单只放行一次）——本次调用未执行。`（`tool-executor.service.ts:683-694`）⇒ **不可操作**（没说「授权已消耗、请重新申请审批」）；`policy_changed` 分支原本已含「重新发起审批」。
- **改动**：抽出纯函数 `buildConsumeDenialMessage(reason, approvalKey)`，补「**该授权已消耗，请重新申请审批后再执行**」+ `policy_changed` 补「本次调用未执行」；新增 `consume-denial-message.spec.ts`（3 条）。
- **判据红→绿**：旧文案 ⇒ **exit 1（3 failed）**（`Expected substring: "已消耗" / "重新申请审批"`）→ 补后 **exit 0（3/3）**；相关回归 `tool-executor|agent-approvals|agent-approval-policy` **128 passed exit 0**。
- **反向验证**：改回旧句 ⇒ **exit 1（2 failed/1 passed）**；还原 ⇒ 0。
- **§7-A 收口**：`approval-consumed-before-execute` = **`已裁定·维持 fail-closed@82e90872`（不再跟踪）**，附理由，后续由 `backlog:stale` 自然处理。
- **体量棘轮**：文案纯函数化使 `tool-executor.service.ts` 变长（非注释行 **841 → 855**、export **11 → 12**）⇒ 已按 `why` 规范签字并写明**回滚值**，且注明「execute 主链 612 行的拆分属独立立项」。
- 回归：定向 128 · `typecheck` 0 · `guards:repo` **0（92 段）** · `docs` 0 · `size-caps` 0。提交 `6c861c25` + `a4e616f2`。
- **i18n 现状**：提示是后端**中文硬编码**（无 i18n 资源，grep 未发现）⇒ 只需覆盖中文；纯函数已收成唯一出口，将来迁移成本低。

## 未收口（按优先级）
1. **`failed` 分支口径不一致**（下轮主靶，小）：工具执行失败（已 `consumed`、落 `failed`）的提示**没有**同类可操作指引 —— 与 R38 刚补的消费失败路径不一致。
2. **回归体检**（建议 R40）：R31 建了健康基线，之后 8 轮改了不少代码/测试 —— 应跑一次 `health:snapshot` 拿**真实 delta**（含 `scrolled`/跳过数变化），确认无退步。
3. 真机债：`agent_approvals` 的 PG 并发行为未验；`rolloutBatchClaimId` 真机未测；R18-B 三条重启条件（blocked）。
4. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3；web 侧 `.env`；python 通过数（需改 pytest 配置）。
5. §7-A 池（76 + 1）不逐轮跟踪，用 `npm run backlog:stale` 定期扫。

## 下轮第一步（R39）
1. `git log -1 --oneline` 确认 `a4e616f2`（**自己跑**）；
2. 立项 **`failed-branch-message`**：把「执行失败（已 consumed）」路径也补上同类可操作指引（如「本次授权已消耗且执行失败，如需重试请重新申请审批」）；
   - 判据：**先红后绿**（旧文案缺指引 ⇒ 断言红）+ **反向验证**（改回 ⇒ 红）；
   - **优先复用** R38 抽出的纯函数（同族文案走同一出口，别再写第二份）；若该函数签名需扩展，说明兼容性；
   - **不改状态机**：`failed` 分支的语义（不可重试、需重新申请）若与现状不同，先判定再动手，**别顺手改状态流转**；
3. 回归：`apps/admin-api` 定向 + `typecheck:api` · `guards:repo` 0（92 段）· `test:docs` · `check:size-caps`（体量棘轮若触发按 `why` 规范签字）。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、不可靠探针不能当判据、规范没稳定前别上机读守护、清空 backlog 要给机制证据、只记退出码不留输出=不可回溯。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
