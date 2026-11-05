# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `6764ff10` · 工作区干净 · 守卫链 93 段全绿 · **python 四种终态测量矩阵已闭环**
**会话**：第 58 轮已收 · 56 轮产出（R01–R56，116 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；三轮探针实验均同轮删除并核实干净）

## R56 结论（完成，**体检器无需修**）
- **XML 第一手事实**：fixture 异常 ⇒ `<error message="failed on setup with …RuntimeError…">`（pytest **exit 1**）；collection error ⇒ `<error message="collection failure">`（pytest **exit 2**）；两者 `testsuite errors="1" failures="0"`。
- **collection error 时**：junitxml **仍写出**（574B）；体检器 **python 行仍可读**：`errors=1 / failed=0 / passed=0 / total=1`，该步 exit 记为 **2**（如实记录）。
- **基线语义**：`errors=N` 显示；**不计入 failed**；**不误计为 passed**。
- **正向**：探针 ⇒ `errors=1 / passed=0 / failed=0`；删除后 ⇒ `passed=1692 / skipped=0 / errors=0`（与 R55 一致）、`git status` 干净。
- **反向验证**：把 `failed` 改成 `failures+errors`（重复计入）⇒ `{total:1, failed:1, errors:1, passed:-1}` ⇒ **判据红**（passed 变负）；还原 ⇒ 绿。
- 回归：`docs` 0 · `guards:repo` **0（93 段）** · `size-caps` 0。提交 `6764ff10`。

## 测量矩阵状态（本会话累计）
`passed / failed / errors / skipped(xfail 计入) / collection-error 时仍可读` —— **全部有实测证据**；失败输出会落盘（R54），链内/单独调用差异已钉（R49/R50）。⇒ **今后读基线的数字可以当真**。

## 未收口（按优先级）
1. **`execute` 接口化第 2 刀**（下轮主靶）：`persist()` 两处落库 → `ToolCallLedger` 接口（**不要碰 `sessions`**）。
2. 体检器可细化：区分「步骤 exit≠0」与「数字异常」两种红（小，非必须）。
3. jest/vitest 侧无 XML 级 `errors` 语义核对（不同工具，需单独立项）。
4. 两个真机脚本（R51/R52）待接链（需 CI postgres；本期无法验证 CI 真跑）。
5. R18-B 协议层并发（blocked，§7.19 三条重启条件）。
6. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3；web 侧 `.env`；flaky 根源待复发取证。
7. 可选低成本：把四种终态的实测速查表写进 `docs/operations.md`。

## 下轮第一步（R57）
1. `git log -1 --oneline` 确认 `6764ff10`（**自己跑**）；
2. 立项 **`execute-ledger-seam`**（接口化第 2 刀，闸门同 R44）：
   - **选点**：`persist()` 的两处落库调用（台账写）→ 抽成 `ToolCallLedger` 接口（**只包 `recordToolCall` 一个方法**）；
   - **先看看 R44 的接缝怎么做的**，保持同构（可注入 + 逐字委托 + 工厂），别发明第二种风格；
   - **闸门（缺一不可）**：① 零行为变更（相关用例全绿 + `typecheck:api` 0）；② **接缝测试**：注入 spy ⇒ 断言 `execute` 真的调用它；③ `guards:repo` 93 段不变；④ `size-caps` 只降不升（若升必须给数字与理由）；⑤ 全量两态通过数不减少（≥7956/7956）；
   - **反向验证**：把注入实现换成抛异常 ⇒ 必须有用例红（贴名字）；
   - **止损**：若两处 persist 与 `consume` 共享事务上下文 ⇒ **停手记 blocked**（§7-A 写清需要先引入事务抽象），**不第 3 次硬试**；
3. 若时间允许：把四种终态速查表写进 `docs/operations.md`（**记得同步 `check-ops-runbook` 自检夹具**）。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、不可靠探针不能当判据、规范没稳定前别上机读守护、清空 backlog 要给机制证据、只记退出码不留输出=不可回溯、文本锚点不是定位手段、止损=换方法、两条路径收敛到唯一实现、改基线留标记并回填、拆不动时换维度、接缝价值≠行数收益、main-guard 与 pkill 自伤、假红根因可能在自己改动里、Lead 文档也在门禁内、同命令两上下文不同=环境依赖先取证、验收必须用链内同形式、判据针对命令形式、验证并发须证明平台真并发、唯一证据链=正向+反向+引擎错误码、绿色门禁覆盖不到处靠定期体检、防它的工具也会犯同错、测量工具分支覆盖缺口是误判入口。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
