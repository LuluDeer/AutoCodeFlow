# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `d0f35911` · 工作区干净 · 守卫链 92 段
**会话**：第 32 轮已收 · 30 轮产出（R01–R30，77 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本会话多次自纠假绿/假数字/自己的误用）

## R30 结论（**无缺陷，仅加判据** —— 这是正常且正确的结果）
- **现有 CAS 正确**：`app-deployment-rollout.collaborator.ts:600-606` —— `UPDATE … SET "rolloutBatchClaimId"=:batchId WHERE "id"=:id AND "rolloutBatchClaimId" IS NULL`（只写 owner 行）；结构底线 = 部分唯一索引 `UNIQUE("applicationId") WHERE claim IS NOT NULL`；输家出口 `:625-647`（`batches.delete` + warn + `ok:false` + `blockedReason="another rollout batch is in flight…"`）；释放 `:894-896`（按批次置 NULL，幂等）。
- **新增反证用例**（1 条）：CAS 干净落败（`affected=0`）⇒ `ok=false` + 明确 `blockedReason` + **不调 upgrade**；定向 **19/19**、rollout 全套 **65 passed**。
- **判据**：破坏 CAS（删掉 `.andWhere('"rolloutBatchClaimId" IS NULL')`）⇒ **exit 1（2 failed/63 passed）**，点名两条**既有**静态契约用例；还原 ⇒ **exit 0（65 passed）**。**如实说明**：抓出「CAS 被删」的是既有用例，新增用例验证的是失败时的对外行为，二者互补不是替代。
- **真机未跑（如实降级）**：本轮没启动两实例 harness（预算用于读实现 + 反证 + 破坏验证）；该不变量结构底线在 DB 唯一索引，真机额外信息有限 ⇒ 记「确定性判据成立、真机未测」，**不冒充已验证**。
- 回归：`typecheck` 0 · `guards:repo` **0（92 段）** · `docs` 0 · `size-caps` 0 · `race-wired` 0 · `source-text-contracts` 0。
- 提交：`0bc99eab` · `f6446f2b` · `d0f35911`。

## 本轮的一处真错（已修复，值得记）
首版 spec 断言「失败分支必然调用 `batches.delete`」时**读取了实现源码文本** ⇒ 触发本仓 `source-text-contracts` 登记要求，链第 **83/92** 段 **exit 1** 并点名该 spec。已改为只断言**可观测输出**（不登记，因为该行为由 `collaborator.ts:625` 的既有实现保证）。
**教训**：本仓有「断言源码文本必须登记」的门禁 —— 写测试时优先断言**可观测行为**，把源码文本断言当作最后手段。

## 未收口（按优先级）
1. **全仓健康快照缺失**（建议下轮）：我们最近只单独跑过各个 app 的全量（R24/R28），**没有一次「四端 + 全链 + 度量」的合并基线**；没有基线就无法判断后续退步。
2. 真机并发轴：`rolloutBatchClaimId` 真机未测（R30 降级）；`agent_approvals` consume 未压。
3. R18-B 三条重启条件（§7.19，blocked）。
4. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3 越界态提示；web 侧 `.env` 影响面（§7.22 P2）。
5. 机器层 swap 已满（不在仓库范围；全量用 `--maxWorkers=2`）。

## 下轮第一步（R31 = 建健康基线）
1. `git log -1 --oneline` 确认 `d0f35911`（**自己跑**）；
2. 立项 **`health-snapshot`**：产出一份**可重复的健康基线**（`docs/health-baseline.md`，由脚本生成更好）：
   - **四端全量**：admin-api（`npm test -- --maxWorkers=2`，两态）、admin-web、executor-node、executor-python（pytest）—— 贴真实 passed/failed + exit code；
   - **全链**：`guards:repo` 92 段 + 末行自证；
   - **度量**：守卫段数、缺口登记条目数（当前 0）、已知 blocked 数（1 = R18-B）、`source-size-baseline` 计数；
   - 判据：**脚本或文档能被重复执行**（一条命令重建基线），并让 `test:docs` 保持 0；
   - 若某端全量跑不动 ⇒ 如实标未测（R27 教训㊽），不要用预期值填充。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、**断言源码文本要登记（R30）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
