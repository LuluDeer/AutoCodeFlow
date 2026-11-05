# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `c06fec1e` · 工作区干净 · 守卫链 93 段全绿 · 基线把 skipped 钉住了
**会话**：第 57 轮已收 · 55 轮产出（R01–R55，115 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本轮探针**同轮删除**并核实干净）

## R55 结论（完成）
- **XML 第一手事实**：skip ⇒ `<skipped type="pytest.skip" …/>`；**xfail ⇒ `<skipped type="pytest.xfail" …/>`**（聚合 `<testsuite tests="1694" skipped="2" failures="0" errors="0">`；pytest 汇总行 `1692 passed, 1 skipped, 1 xfailed`）。
- **基线语义**：python 行**显示 `skipped=N`**；**passed 未误计** —— `passed = tests − failures − errors − skipped`（实测 `{total:1694, skipped:2, passed:1692}`）；模板已写明「**xfail 计入 skipped**」。
- **正向**：加 2 用例 ⇒ `skipped=2 / passed=1692 / total=1694`（passed 未增）；删除后 ⇒ `skipped=0 / passed=1692`（与 R53 一致），`git status` **干净**。
- **反向验证**：把 `readJunit()` 的 `skipped` 写死为 0 ⇒ **`{total:1694, skipped:0, passed:1694}`（红：把 skip/xfail 当通过）**；还原 ⇒ 绿。
- 回归：`docs` 0 · `guards:repo` **0（93 段）** · `size-caps` 0。提交 `c06fec1e`。

## 方法论沉淀
(70) **测量工具的每一个「未覆盖分支」都是下一次误判的入口**：`skipped=0` 因为从未被测过，一旦出现 skip 就会把「跳过」算成「通过」——**而基线的任务恰恰是发现退步**。⇒ 测量工具的分支覆盖，优先级应与被测代码同级。

## 未收口（按优先级）
1. **python 四种终态还差 `errors`（collection error / fixture 抛错）**：下轮补齐（小），完成测量矩阵。
2. jest/vitest 侧的 `skipped` 取自各自汇总行，**未做 XML/结构化核对**（不同工具，语义可能不同）—— 别混做，可另立一轮。
3. 两个真机脚本（R51/R52）待接链（需 CI postgres；本期无法验证 CI 真跑）。
4. R18-B 协议层并发（blocked，§7.19 三条重启条件）。
5. `execute` 接口化下一刀：`persist()` → `ToolCallLedger`（不要碰 `sessions`）。
6. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3；web 侧 `.env`；flaky 根源待复发取证。

## 下轮第一步（R56）
1. `git log -1 --oneline` 确认 `c06fec1e`（**自己跑**）；
2. 立项 **`junit-errors-semantics`**（收尾测量矩阵）：
   - 临时加一个 **fixture 抛异常**的用例（在 fixture 里 `raise`）和一个**collection error**（模块级 `raise` 或 import 失败）探针（**同轮删除并核实干净**）；
   - 判据：`health:snapshot --skip-heavy` 的 python 行必须**把 error 计入 `errors` 而非 `failed`/`passed`**（贴 XML 节点事实 + 基线前后对照）；
   - **反向验证**：把 `errors` 并入 `failed`（或忽略）⇒ 判据必须红；还原 ⇒ 绿；
   - **注意**：collection error 会让 pytest **退出码非 0**，此时 `health-snapshot` 必须**仍然产出可读的 python 行**（不能因此整段缺失）—— 这也是判据之一；
3. 完成后基线恢复正常（passed 1692 / skipped 0 / errors 0）且 `git status` 干净；
4. 回归：`test:docs` 0 · `guards:repo` 0（93 段，链内同形式）· `check:size-caps` 0。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、不可靠探针不能当判据、规范没稳定前别上机读守护、清空 backlog 要给机制证据、只记退出码不留输出=不可回溯、文本锚点不是定位手段、止损=换方法、两条路径收敛到唯一实现、改基线留标记并回填、拆不动时换维度、接缝价值≠行数收益、main-guard 与 pkill 自伤、假红根因可能在自己改动里、Lead 文档也在门禁内、同命令两上下文不同=环境依赖先取证、验收必须用链内同形式、判据针对命令形式、验证并发须证明平台真并发、唯一证据链=正向+反向+引擎错误码、绿色门禁覆盖不到处靠定期体检、防它的工具也会犯同错、**测量工具的分支覆盖缺口就是下一次误判的入口（70）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
