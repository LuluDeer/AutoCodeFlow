# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `3bdf8c2f` · 工作区干净 · 守卫链 93 段全绿 · web 基线已回到 exit 0
**会话**：第 56 轮已收 · 54 轮产出（R01–R54，114 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本轮坚持「无证据不猜」且顺手修了诊断工具）

## R54 结论（flaky 已定性；工具缺陷已修）
- **取证不可得（工具缺陷）**：R53 体检器**只保留汇总行、丢弃子进程输出** ⇒ 失败用例名丢失。**这本身是缺陷，已修**。
- **复跑实测**：`Test Files 285 passed (285)` / `Tests 2357 passed | 1 skipped (2358)` / **`WEB_EXIT=0`**。
- **定性 = flaky**（三条依据）：① 同命令同代码复跑全绿；② `git log 62be…HEAD -- apps/admin-web` **无 web 提交**；③ 通过数与 R42 **逐字相同**（2357 / 1 skipped），无增删用例。**不稳定源未定位**（明细已丢）⇒ 不猜、不加 `--retry`。
- **修复（做对的事）**：`health-snapshot.mjs` 改为**失败即把完整子进程输出落盘**到 `artifacts/health-logs/<step>-<ts>.log` 并打印路径 ⇒ **下次复发可直接拿到失败用例名**。
- **基线**：web 行改回 `exit 0`，行内写明依据（「R53 那次 exit 1 为 flaky，未复现」）。
- 回归：`guards:repo` **0（93 段）** · `docs` 0 · `size-caps` 0 · main-guard 0。提交 `3bdf8c2f`。

## 方法论沉淀
(69) **同一个错误会在「用来防它的工具」里复发**：教训(54) 说「只记退出码不留输出 = 证据不可回溯」，而**体检器本身**就犯了这个错。⇒ 修好一个纪律后，要**回头检查承载该纪律的工具**是否自己也遵守。

## 未收口（按优先级）
1. **flaky 根源**（有证据才做）：等下次复发时用 `artifacts/health-logs/` 的输出定位；**不许无依据地改 `isolate`/串行**。
2. **junior 测量缺口：junit `skipped`/`xfail` 语义未覆盖**（R45 遗留，`skipped=0` 从未被测过）—— 下轮主靶，让基线的 `skipped` 数可信。
3. 两个真机脚本（R51/R52）待接链（需 CI postgres；本期无法验证 CI 真跑）。
4. R18-B 协议层并发（blocked，§7.19 三条重启条件）。
5. `execute` 接口化下一刀：`persist()` → `ToolCallLedger`（不要碰 `sessions`）。
6. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3；web 侧 `.env`。

## 下轮第一步（R55）
1. `git log -1 --oneline` 确认 `3bdf8c2f`（**自己跑**）；
2. 立项 **`junit-skipped-semantics`**（测量保真，小）：
   - 在 `apps/executor-python` 临时加一个 `@pytest.mark.skip` 用例与一个 `xfail` 用例（**同轮删除并核实 `git status` 干净** —— 教训 58）；
   - 判据：`npm run health:snapshot -- --skip-heavy` 的 python 行必须显示 **`skipped=N`（N=你加的数量）** 且 **passed 不把它算进去**；贴前后对照；
   - **反向验证**：把 junit 解析里对 `skipped` 的处理改坏（例如忽略 `skipped` 属性）⇒ 判据必须红；还原 ⇒ 绿；
   - 若 junit 的 `xfail` 表现为 `skipped` 或 `failure`，**写清实际表现**并让基线语义与之匹配（不许含糊）；
3. 回归：`test:docs` 0 · `guards:repo` 0（93 段，链内同形式）· `check:size-caps` 0。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、不可靠探针不能当判据、规范没稳定前别上机读守护、清空 backlog 要给机制证据、只记退出码不留输出=不可回溯、文本锚点不是定位手段、止损=换方法、两条路径收敛到唯一实现、改基线留标记并回填、拆不动时换维度、接缝价值≠行数收益、main-guard 与 pkill 自伤、假红根因可能在自己改动里、Lead 文档也在门禁内、同命令两上下文不同=环境依赖先取证、验收必须用链内同形式、判据针对命令形式、验证并发须证明平台真并发、唯一证据链=正向+反向+引擎错误码、绿色门禁覆盖不到处靠定期体检、**防它的工具也会犯同一个错（69）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
