# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `3db8e663` · 工作区干净 · ADR-030 ②′ **已落地**（mode 默认 off）
**会话**：第 15 轮已收 · 14 轮产出（R01–R14，40 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（每步一提交、失败如实报、容器自清，均已生效）

## R14 结论（完成）—— 跨实例 token 幂等成立
- **迁移** `1790000000097-AddExecutorTokenRotationEpoch`（`integer NOT NULL DEFAULT 0`，metadata-only 零回填、不建索引）：up **exit 0**；**在有数据的库上**实测「存量行 epoch 默认 0」→ down **exit 0**（列删、**数据行仍在**）→ 再 up 幂等 exit 0；`check:migrations` **0**（141 个迁移全部注册）。
- **派生 + CAS**：`token = HMAC-SHA256(K, identity‖\0‖startupId‖epoch)`；轮换 = `UPDATE … WHERE "tokenRotationEpoch"=:epoch`；**输家**用自算令牌 `bcrypt.compare` 新哈希，命中即返回**同一枚**（全程不落明文）；有界 2 轮重试后随机兜底（**不回调 `rotateToken`**，避免 mode=on 递归）—— `executor.service.ts:6550` 附近 `mintEpochToken()`。
- **真机两实例**：**10 轮 × 4 并发**（交替打两实例）⇒ 每轮 `201×4`、**不同令牌 1**、命中 DB hash **1** ⇒ **I1/I2/I3/I4（跨实例幂等）全 ✔**，无反向次序。
- **混跑**（A=on / B=off）**6 轮**：**不幂等**（每轮 2–3 枚，正是 ADR §5.2 预期），但**命中 hash 恒 1** + 「竞态后再取必得可用令牌」 ⇒ **不打死令牌**，exit 0。
- 回归：定向 **618/618（含 mode=off 全绿）** · `typecheck` 0 · `guards:repo`(87) 0 · `docs` 0 · `size-caps` 0 · `race-wired` 0 · `migrations` 0；`acf-r14-*` 自清残留 0，`acf-*` 7 个历史栈未动。
- **过程中抓到的真风险**：首跑两实例全 **500**（派生密钥为空抛错）→ 补「回落 `EXECUTOR_SECRET`」后转绿。这条要是没被真机跑到，上线即全机队 401 —— **真机验证的价值实证**。
- 提交：`45458e52`(迁移) + `62bcb88d`(派生+CAS) + `f0745ebd`(接链) + `3db8e663`(台账)。

## 未收口（按优先级）
1. **派生密钥轮换语义未落地**（§7.13 P2）：换 `EXECUTOR_TOKEN_DERIVATION_SECRET` = **全机队令牌立即失效**，需运维手册段 + **启动告警**（这轮必须补，否则运维会踩）。
2. **`EXECUTOR_TOKEN_EPOCH_MODE=on` 是运维决策**（§7.13 P1）：逐实例升级 → 统一开 → 观察 `foreign-rotation` WARN 清零。可加 `tokenRotationEpoch` **只读观测指标**帮助判断「轮换风暴是否已止」。
3. 真机并发仍缺 3 轴（心跳 `runningTaskCount` 覆盖写 vs 派发占坑 / `rolloutBatchClaimId` CAS / `agent_approvals` consume）。
4. `check:desktop-bundle-drift` 字节哈希待 CI；executor-node `.env` 约束（§7.4）；守卫框架 meta 改造（§7.2）；`UPGRADING.md` 头部基线。

## 下轮第一步（R15 = 收尾这摊运维债）
1. `git log -1 --oneline` 确认 `3db8e663`（**自己跑**）；
2. 立项 **`derivation-key-runbook`**：① `docs/operations.md` 写「换派生密钥 = 全机队立即失效」的**运维流程**（灰度分批、回退、观察指标）；② **启动告警**：`EXECUTOR_TOKEN_EPOCH_MODE=on` 但派生密钥与 `EXECUTOR_SECRET` 相同 / 缺失时告警；③ 可选：`tokenRotationEpoch` 只读观测（若成本低）；
3. 判据：运维手册**能被机读守护**（如 `check-ops-runbook` 断言段落存在 + 关键命令可执行），红→绿成对；启动告警要有反向判据（删掉告警逻辑 ⇒ 测试红）。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 7 次。
- **只信命令 + 真实 exit code**；回执会错归因（R01→R02）、我会错摘要（㊱）、别编 sha（㊲）、未复现如实写（R11/R12/R13）、**证据文件不存在就说不存在**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
