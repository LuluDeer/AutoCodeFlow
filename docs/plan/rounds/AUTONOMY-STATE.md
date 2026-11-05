# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `6d92bbd4` · 工作区干净 · 守卫链 92 段 · `execute` 618 行（有可注入接缝）
**会话**：第 46 轮已收 · 44 轮产出（R01–R44，98 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本轮如实报 `functionLines` 未降）

## R44 结论（完成，**收益是接缝不是行数**）
- **选中 `boundary.recordOutcome`**（耦合最浅）：**2 个调用点**（`tool-executor.service.ts:877` / `:906`，实现 `agent-boundary.service.ts:594`），**不涉事务**；对照排除项：`sessions.*` **6+ 处**且**涉审批同段**、`approvals.consume`/`explainConsumeFailure` **就是事务边界**（立项禁止拆）。
- **改动**：新增 `tool-executor.outcome-recorder.ts`（接口 + 工厂，逐字委托），`execute` 经接缝调用 2 处；**`consume`/`consumedOneTimeApprovalKey` 一行未动**。
- **闸门**：用例 **686/686** · `typecheck` 0 · `guards:repo` **0（92 段）** · `size-caps` 0 · 全量默认 **7956** / 开关 **7956**（R43 基线 7955 ⇒ 不减少）。
- **接缝测试**：注入 spy 断言 `toHaveBeenCalledWith("s-1","get_task",false)` 与 `(…,true)` ⇒ **真调用**。
- **反向验证**：换抛异常空实现 ⇒ **exit 1**，红了 6 条（含 `granted 审批单 → 闸门放行`、`recordOutcome(true)`、`大结果截断`、`invoke 抛异常：熔断记账失败`、R40/R41 用例）⇒ 证明是必经路径；还原 ⇒ 0。
- **如实记账**：`execute` **618 → 618 未降**；service 非注释行 871→**876**（+5 接缝字段/import）、spec 1354→1370 —— 已按 `why` 签字，写明「结构性成本而非行数收益」，回滚值 871/1354。
- 提交 `6d92bbd4`；回滚 `git revert 6d92bbd4`。

## 方法论沉淀
(60) **接缝的价值不等于行数**：这一刀没缩短主链，但把「熔断记账」变成**可注入可测**，并让反向验证能一次点亮 6 条路径。⇒ 重构收益要分两种记账：**行数** 与 **可测性/可替换性**；只盯行数会误判这一刀为「无效」。

## 未收口（按优先级）
1. **下一刀候选 = `persist()` 的两处落库 → `ToolCallLedger` 接口**（只包 `recordToolCall` 一个方法）；**不要再直接碰 `sessions`**（6+ 处且涉审批同段，风险明显更高）。
2. **python 健康指标保真**（下轮主靶，小）：基线里 python 只有 `collected`（收集数），**拿不到 passed** —— 让守护数字能反映「通过数」或明确区分，避免未来误读。
3. 真机债：审批 PG 并发未验、`rolloutBatchClaimId` 真机未测、R18-B 三条重启条件（§7.19，blocked）。
4. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3；web 侧 `.env`。
5. 例行：`health:snapshot` 每 10 轮（下次 R52）。

## 下轮第一步（R45 = python 指标保真）
1. `git log -1 --oneline` 确认 `6d92bbd4`（**自己跑**）；
2. 立项 **`pytest-summary-fidelity`**：
   - **先查为什么没有汇总行**：本仓 pytest 配置（`pytest.ini`/`pyproject.toml`/`setup.cfg`/`conftest.py`）里有没有 `-q`/`--tb`/插件压制；给 `文件:行号`；
   - **两种做法二选一并说明**：**(a)** 让 pytest 输出可解析的 `N passed` 汇总（改配置属**开发者体验变更**，须说明影响）；**(b)** 不改 pytest，用 `--junitxml` 或 `--collect-only` + 结果解析得到 passed 数，写进 `health-snapshot.mjs`；
   - 判据：`health:snapshot --skip-heavy` 的 python 行**出现 passed 数**（或明确的 `passed=N` 字段），且**与直接跑 pytest 的真实结果一致**（贴两侧输出对照）；基线 JSON 同步更新；
   - **反向验证**：人为让 1 个 python 用例失败（临时改一个断言，随后还原）⇒ snapshot 的 python 项必须**显示失败**而不是仍 `collected`；
3. 回归：`test:docs` 0 · `guards:repo` 0（92 段）· `check:size-caps` 0。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、不可靠探针不能当判据、规范没稳定前别上机读守护、清空 backlog 要给机制证据、只记退出码不留输出=不可回溯、文本锚点不是定位手段、止损=换方法、两条路径收敛到唯一实现、改基线留标记并回填、拆不动时换维度、**接缝价值≠行数收益（60）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
