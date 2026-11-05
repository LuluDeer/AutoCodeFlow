# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `45c6e590` · 工作区干净 · 守卫链 92 段 · 并发第 5 轴已判（无缺陷）
**会话**：第 39 轮已收 · 37 轮产出（R01–R37，85 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本轮按「无缺陷仅加判据」如实收口）

## R37 结论（**无缺陷仅加判据**）
- **现有防护正确**：`agent-approvals.service.ts:788-845` 用**条件 UPDATE（CAS）** —— `WHERE approvalKey ∧ status='granted' ∧ scope='once' ∧ policyFingerprint=当前`，`affected=0` 即未领取，只有 `affected>0` 才发事件返回 true（I1）；输家经 `explainConsumeFailure()`（`:848-870`）得到 `policy_changed | not_granted | missing`，调用方落 `denied` + 明确文案（`tool-executor.service.ts:670-700`，I2）。
- **新增判据**：`agent-approvals.spec.ts` +1 条 R37 并发用例（**有状态 CAS 替身**），断言 `sort(results) === [false,true]`（恰好一个赢）与 `explainConsumeFailure === "not_granted"`。
- **反证**：把落败分支 `return false;`（`:838`）改成 `return true;` ⇒ **exit 1（2 failed/23）** 并点名该用例；还原 ⇒ **exit 0（25/25）**。
- **真机降级（如实）**：未起两实例，改用有状态替身做确定性并发；**仍缺「真实 PG 并发 UPDATE」的引擎行为验证**。
- 回归：定向 25/25 · `typecheck` 0 · `guards:repo` **0（92 段）** · `docs` 0 · `size-caps` 0 · `race-wired` 0（未改 executor-node，无需 digest）。提交 `45c6e590`。

## ✅ Lead 裁决（本轮定）：I3 维持 fail-closed
- **决定**：`consumed` **不允许**在「执行失败」后自动回退为 `granted`。
- **理由**：① 审批是安全敏感物，**自动复活 = 在状态已变化后重放一次旧授权**；② 回退会让「一次授权两次使用」成为可能，而 CAS 的全部价值正是不允许这件事；③ 失败后的正确路径是**重新申请审批**（审计链完整、人再看一眼上下文）。
- **代价（如实）**：工具执行失败后用户必须重新走审批，多一步操作 —— 换掉的是「静默重放」风险。
- **配套要求**：失败路径必须给用户**明确可操作**的提示（「本次授权已消耗，请重新申请审批」），不能只说 `denied` 了事 —— 这是 R38 的验收点。

## 未收口（按优先级）
1. **R38：落实上面裁决**（小、明确）：① 把 §7-A 该条标 `已裁定·维持 fail-closed` 且**从此不再跟踪**；② 检查/补齐失败路径的用户提示，加一条断言（红→绿）。
2. 真机两实例未跑（R37 降级）：`agent_approvals` 的**真实 PG 并发 UPDATE** 行为未验（§7-A needs-env）。
3. `rolloutBatchClaimId` 真机未测（R30 降级）；R18-B 三条重启条件（§7.19，blocked）。
4. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3；web 侧 `.env`；python 通过数。
5. §7-A 池 76 条 + 本轮新增 1 条 —— 用 `npm run backlog:stale` 定期扫（不接链）。

## 下轮第一步（R38）
1. `git log -1 --oneline` 确认 `45c6e590`（**自己跑**）；
2. 立项 **`approval-fail-closed-policy`**：
   - **判定现状**：工具执行失败时，用户看到的文案是什么（`tool-executor.service.ts:670-700` 附近）？是否明确「授权已消耗、需重新申请」？给 `文件:行号` + 实际输出；
   - **不足则补**：改文案/加提示（**不改 CAS 语义**），判据 = **新增/修改断言先红后绿**（旧文案不含「重新申请」⇒ 红；补后绿）；
   - **同时**：`PLAYBOOK §7-A` 该条标 `已裁定·维持 fail-closed`（Lead 裁决，附理由一句），并说明「不再跟踪」；
   - **反向验证**：把提示改回旧文案 ⇒ 断言必须红；
3. 回归：`apps/admin-api` 定向 + `typecheck:api` · `guards:repo` 0（92 段）· `test:docs` · `check:size-caps`。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、不可靠探针不能当判据、规范没稳定前别上机读守护、清空 backlog 要给机制证据、只记退出码不留输出=不可回溯。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
