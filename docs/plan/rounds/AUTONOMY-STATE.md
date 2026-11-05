# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `8b3f3781` · 工作区干净 · 守卫链 92 段 · **健康基线四端 now 全有通过数**
**会话**：第 47 轮已收 · 45 轮产出（R01–R45，99 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本轮自曝两次操作失误并修复）

## R45 结论（完成，方案 b）
- **根因**：`apps/executor-python/pytest.ini` 的 `addopts = -q --cov=. …` **已含 `-q`**，旧实现**又传一个 `-q`** ⇒ 实际 `-qq` ⇒ **汇总行被压掉**（尾部只剩 coverage 表）。对照：`python3 -m pytest -q` 无 `passed` 行；`python3 -m pytest` 有 `1692 passed in 174.65s`。
- **做法 b（零侵入）**：`--junitxml` + 解析，拿到结构化数据；顺带去掉多余 `-q`，日志尾部恢复 `N passed`。
- **对照一致**：XML 解析 `passed=1692` vs pytest 实测 `1692 passed`（`failed=0 errors=0 skipped=0 total=1692`）；基线里 `collected` 字段已消失，改为 `passed=1692 / failed=0 / total=1692`。
- **反向验证**：临时 `test_r45_probe.py`（`assert False`）⇒ `PROBE_EXIT=1`，XML 解析 `{total:1, failed:1, passed:0}` ⇒ python 项**会显示 failure**；**用例已删除、`git status` 干净**（教训 58 遵守）。
- **顺带修 main-guard**：`health-snapshot.mjs` 原先 **`import` 就会执行 `main()`**。
- 回归：`docs` 0 · `guards:repo` **0（92 段）** · `size-caps` 0。提交 `8b3f3781`。

## 本轮两次真实失误（自曝，值得记）
① `import { readJunit }` 直接触发 `main()` ⇒ **意外跑了一轮全量健康检查**（已中止）；
② 修 guard 时用 `pkill -f "health-snapshot"` ⇒ **误杀了自己的 shell**（命令行里也含该字符串）。
⇒ 教训：**(61) 脚本必须有 main-guard；`pkill -f` 会匹配到自己的命令行**。

## 未收口（按优先级）
1. **新增轻量检查：`scripts/*.mjs` 必须有 main-guard**（下轮主靶）—— 防止下一个人/agent 在 `import` 时又触发副作用（本轮实际发生过）。
2. `execute` 接口化下一刀候选：`persist()` 两处落库 → `ToolCallLedger`（**不要再直接碰 `sessions`**）。
3. 真机债：审批 PG 并发未验、`rolloutBatchClaimId` 真机未测、R18-B 三条重启条件（blocked）。
4. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3；web 侧 `.env`；`xfail` 的 XML `skipped` 语义未覆盖。
5. 例行：`health:snapshot` 每 10 轮（下次 R52 → 现在已可给出四端真实通过数）。

## 下轮第一步（R46 = main-guard 检查）
1. `git log -1 --oneline` 确认 `8b3f3781`（**自己跑**）；
2. 立项 **`script-main-guard-check`**：
   - 新增守卫（如 `scripts/check-script-main-guard.mjs`）：遍历 `scripts/**/*.mjs`，断言每个**可执行**脚本都有 main-guard 形态（`if (import.meta.url === pathToFileURL(process.argv[1]).href)` 或该仓既有等价写法），**且** `import` 时不产生副作用；
   - **先跑红**：现状下有多少脚本缺 guard（贴清单与计数）；**逐个补或登记豁免**（纯库文件应豁免：无顶层副作用且不导出 main）；
   - **反向验证（必须做）**：故意新建一个无 guard 且顶层有副作用的小脚本 ⇒ 守卫 **exit 1 点名**；删除 ⇒ 0；
   - **接链**：段数 **92 → 93**，`[k/N]` 可见，**删接线能红**；
   - 判据：`guards:repo` 93 段全跑 exit 0；`test:docs` 0；`size-caps` 0；
3. **禁止**用 `pkill -f`（教训 61）；杀进程用精确 PID。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 7 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、不可靠探针不能当判据、规范没稳定前别上机读守护、清空 backlog 要给机制证据、只记退出码不留输出=不可回溯、文本锚点不是定位手段、止损=换方法、两条路径收敛到唯一实现、改基线留标记并回填、拆不动时换维度、接缝价值≠行数收益、**main-guard 与 pkill -f 自伤（61）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
