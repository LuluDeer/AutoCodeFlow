# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `7465907b` · 工作区干净 · 守卫链 92 段
**会话**：第 41 轮已收 · 39 轮产出（R01–R39，88 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本轮两次接线失败后**停手回滚**，守住了止损纪律）

## R39 结论（**部分完成**：文案契约已补，**接线未做**）
- **现状语义（已核实）**：失败后审批行**保持 `consumed`**（consume 之后不再触碰审批行，`tool-executor.service.ts:866-877`），落库 `status: error|timeout`、`errorMessage: msg`，回给模型 `【调用失败】${msg}` ⇒ **不可重试，须重新申请** —— 与 R37/R38 的 fail-closed 裁决**一致，无冲突**。
- **已完成**：复用 R38 的 `buildConsumeDenialMessage`（**未写第二个文案函数**），新增 reason `execution_failed_after_consume`，**签名不变、老三种 reason 文案逐字不变**（向后兼容）；`consume-denial-message.spec.ts` +1 断言。
- **判据红→绿**：新 reason 暂返回旧式文案 ⇒ **exit 1（1 failed/3 passed，`Expected substring: "已消耗"`）** → **exit 0（4/4）**；相关回归 **155 passed**；反向验证改回旧式 ⇒ exit 1，恢复 ⇒ 0。
- **未完成（如实）**：**接线没做** —— 需 hoist `consumedOneTimeApprovalKey`，而 `if (verdict.approvedApprovalKey && !approvedBySessionGrant) {` 在该文件有 **2 处**（`:707`/`:778`），**文本锚点不唯一**，两次尝试后按「验证失败 2 次即回滚」停手，源码保持可运行。⇒ **用户目前仍看不到新提示**。
- **顺带发现（独立立项候选）**：失败路径的 `errorMessage` **不脱敏**（`msg` 直接落库），与结果侧「落库前脱敏」不一致。
- 回归：定向 4/4 + 155 passed · `typecheck` 0 · `guards:repo` **0（92 段）** · `docs` 0 · `size-caps` 0（棘轮 855→861，回滚值已写）。提交 `7465907b`。

## 方法论沉淀
(55) **文本锚点不是定位手段**：同一文件里 `if (verdict.approvedApprovalKey && !approvedBySessionGrant)` 出现两处 ⇒ 任何「找到这段然后插入」的做法都会歧义失败。**改结构性位置必须用 CodeGraph 拿行号/符号边界**，不要用字符串匹配去认块。

## 未收口（按优先级）
1. **接线（同一阻塞第 3 次 = 止损线）**：用 CodeGraph 精确锁定 `:778` 的 consume 块，hoist `consumedOneTimeApprovalKey`，把提示接到**落库**与**回给模型**两个出口。**若这次仍失败 ⇒ 记 blocked 换靶**（不许第 4 次）。
2. **失败路径 `errorMessage` 不脱敏**（新发现，独立立项候选）。
3. 回归体检：R31 建基线后已过 10 轮，应跑 `health:snapshot` 拿真实 delta。
4. 真机债：审批 PG 并发未验、`rolloutBatchClaimId` 真机未测、R18-B 三条重启条件（blocked）。
5. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3；web 侧 `.env`；python 通过数。

## 下轮第一步（R40 = 接线，最后一试）
1. `git log -1 --oneline` 确认 `7465907b`（**自己跑**）；
2. 立项 **`failed-branch-wiring`**：
   - **用 CodeGraph**（`codegraph explore` / `codegraph node tool-executor` / `--symbols-only` 拿行号）**先打印出 `:778` 附近 consume 块的真实边界**（起始行/结束行/所属函数），再动手；**不允许再用字符串匹配找块**（教训 55）；
   - hoist `consumedOneTimeApprovalKey` 到块作用域外，把 R39 的文案接到**两个出口**：① 落库 `errorMessage`；② 回给模型的 `【调用失败】…` 文案；
   - 判据：**端到端可观测** —— 一条用例断言「执行失败后，落库 `errorMessage` 与返回给模型的文案**都含**『已消耗』+『重新申请审批』」；旧实现红 → 新实现绿；
   - **反向验证**：撤掉接线（只留纯函数）⇒ 该用例必须红；
3. 若再次失败 ⇒ **记 blocked + 换靶到「失败路径脱敏」或「回归体检」**，并在 §7-A 登记重启条件。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、不可靠探针不能当判据、规范没稳定前别上机读守护、清空 backlog 要给机制证据、只记退出码不留输出=不可回溯、**文本锚点不是定位手段（55）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
