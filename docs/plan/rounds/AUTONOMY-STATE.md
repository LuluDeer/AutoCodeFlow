# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `21d19dac` · 工作区干净 · 守卫链 92 段 · backlog 已复核（对账闭合）
**会话**：第 35 轮已收 · 33 轮产出（R01–R33，81 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本轮坚持「无证据不删」，做对了）

## R33 结论（部分完成，但**过程是对的**）
- **对账闭合**：`N=82 = 仍成立 7 + 推翻 3 + 无法判定 72`。
- **3 条真推翻（均附命令证据）**：`doc-guard`（`check:metric-docs` 已存在，exit 0）· `guards-chain-native-accounting`（`test:guards:repo` 已含矩阵入口，exit 0）· `guard-chain-fail-no-segment`（`test -f scripts/guard-chain-fail.mjs` ⇒ exit 1，文件已退役）。
- **对照 2 条**：`check-docs-root-injection` 仍成立（grep exit 0）；`ssrf-parity-python-face` 的探针**本身不可靠**（exit 1）⇒ 归入「无法判定」，**没有把不可靠探针当判定依据**。
- **没删任何条目**（无证据不删）；`before.md` 留痕原句；未新建 section，就地标注。回归：`test:docs` 0 · `guards:repo` **0（92 段）** · `size-caps` 0。提交 `21d19dac`。
- **遗留问题**：72 条 `unverified@1f21e386` 若按「每轮 10 条」去消化，要 **7 轮纯行政工作** —— 这不划算。

## ✅ Lead 裁定：给 backlog 定一条**处置口径**（本轮定，下轮执行）
不要背着 72 条滚动。分类处置：
1. **`proposal@sha`（建议型 / 设计取舍待定）** ⇒ 移入 `PLAYBOOK §7-A 历史建议池`，**不再逐轮跟踪**；只有被立项时才捞回主表；
2. **`needs-env@sha`（需真机 / 外部环境 / 外部凭据）** ⇒ 同样入 §7-A，**每条写一句「什么条件下可重启」**；
3. **`needs-reading@sha`（需逐条读实现才能判定）** ⇒ **保留 §7 主表**，每轮**最多 10 条**分批判定（只有这一类值得继续花时间）；
4. **防腐**：主表条目 **30 天未被立项且无新证据** ⇒ 自动移入 §7-A（入库时间戳即可机械判定）。
目标：**主表条目数 82 → ≤15**，把「历史包袱」与「活的问题」分开。

## 未收口（按优先级）
1. **执行上面的处置口径**（下轮主靶，机械活、可核验）：主表 82 → ≤15，§7-A 建池，每条带 `kind@sha` 与（needs-env 的）重启条件。
2. 真机并发轴：`rolloutBatchClaimId` 真机未测（R30 降级）；`agent_approvals` consume 未压。
3. R18-B 三条重启条件（§7.19，blocked）。
4. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3 越界态提示；web 侧 `.env` 影响面；python 通过数（需改 pytest 配置）。
5. `ssrf-parity` 探针不可靠（exit 1 但含义未明）—— 探针本身可能是个真缺陷，值得单独立项（别混进 backlog 卫生）。

## 下轮第一步（R34）
1. `git log -1 --oneline` 确认 `21d19dac`（**自己跑**）；
2. 立项 **`backlog-disposal`**：按上面四条口径机械迁移 + 主表瘦身：
   - 判据：**主表条目数 82 → ≤15**（贴前后数字）；§7-A 每条带 `kind@sha`（proposal / needs-env / needs-reading 不许混）；needs-env 逐条有重启条件；**主表剩余条目必须全部是 needs-reading 或已有真实证据**；
   - **反向验证**：构造一条违反口径的条目（例如 needs-env 缺重启条件）⇒ 若你为此加了守卫则必须红；**若不加守卫，就要在回执里说明为什么这类文档口径不值得机读守护**（两者择一，说清）；
   - 回归：`test:docs` 0（**大改 docs 必踩**）· `guards:repo` 0（92 段）· `size-caps` 0（PLAYBOOK 可能变长/变短）。
3. 完成后主表应可直接作为下轮「每轮 10 条 needs-reading」的输入队列。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、**不可靠的探针不能当判据（R33 第⑤条）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
