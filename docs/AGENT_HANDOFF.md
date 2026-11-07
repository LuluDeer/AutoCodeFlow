# AutoCodeFlow Agent Handoff

> **受众**：接手下一轮会话的 agent · **状态**：内部 · **最后核对**：2026-11-05
> 跨会话交接文档：新会话从这里恢复。
> 状态以代码与 `docs/archive/reports/optimization-notes.md` 为准，文档可能滞后。

更新时间：2026-11-05（最近一次交付：见 `git log -1 --format=%h`）
当前分支：`develop`

> 本文件是跨会话交接文档，**状态以 `docs/PLAN-CLAIMS.md` 与代码为准**。
> 头部这两行曾互相矛盾（原写 2026-09-28 / `codex/executor-client-ui`，而本文件第 50-51 行写 2026-10-06 / `develop`），已按 git 事实校正：`git log -1` = 2026-10-26 `643cf3f1`，`git rev-parse --abbrev-ref HEAD` = `main`。

## 目录

- [状态快照](#状态快照)
- [状态快照（历史）](#状态快照历史)
- [会话恢复速查](#会话恢复速查)
- [开发准则](#开发准则)
- [长期路线图状态](#长期路线图状态)
- [下一步建议（按优先级）](#下一步建议按优先级)
- [未覆盖验证项](#未覆盖验证项)
- [本轮变更要点（参考）](#本轮变更要点参考)
- [发版链路打通专项（2026-09-19，v1.5.0 发版轮）](#发版链路打通专项2026-09-19v150-发版轮)
  - [① release-please 被历史 PR 永久卡住（发版阻塞）](#-release-please-被历史-pr-永久卡住发版阻塞)
  - [② acf-cli 漏进 manifest → Release PR 把它从 1.4.3 倒退到 1.0.0](#-acf-cli-漏进-manifest--release-pr-把它从-143-倒退到-100)
  - [③ e2e-full-windows 长期全红：venv 相对路径在 cd 之后失效](#-e2e-full-windows-长期全红venv-相对路径在-cd-之后失效)
  - [④ 文档站版本声明不在 release-please 管理面内 → 每次发版必红 + 文档站停部署](#-文档站版本声明不在-release-please-管理面内--每次发版必红--文档站停部署)
  - [⑤ PyPI Trusted Publishing 未登记 → publish-pypi 失败](#-pypi-trusted-publishing-未登记--publish-pypi-失败)
  - [⑥ SDK 发版抢占 GitHub latest → 全量装机用户桌面更新 404（结构性复发）](#-sdk-发版抢占-github-latest--全量装机用户桌面更新-404结构性复发)
  - [v1.5.0 发布结果](#v150-发布结果)
  - [方法学教训（两条，可复用）](#方法学教训两条可复用)

## 状态快照

- **R154（2026-11-07，第 154 轮 · 并行第 84 批 · 台账 writer）**：**覆盖率计数登记 13→25（两批）· 发现「有计数行但数字恒 0」形态**（链条见 PLAN-CLAIMS 的 R154 组）。落地 **2 项**（`347e616b` 第一批 9 条 + `8004ebd8` 第二批 3 条），已由 Lead 复核，链 **102/102** 全绿；**§7.0 主表维持 3 条**。
- **`347e616b` `feat(guards)`：覆盖率计数登记 13 → 22（R154，第一批 9 条）**。**背景**：`check-guards-wired` 的判据④只保护**已登记**的守卫 ⇒ 登记表外的守卫**用例被删光不会有任何东西变红**（「判据面塌方」的真实风险面）；登记表当时 **13 条** / 扫描面 **98 条**。
- **本轮最有价值的发现：「有计数行，但数字恒 0」** —— 这 9 条**早就在打印 `COVERAGE_CASES` 计数行，但口径传的是 `subprocess`（恒为 0）** ⇒ 「**有计数行、数字恒 0**」——看起来被覆盖，实际 **floor 0 对任何用例数都成立（0 ≤ 0 恒真）⇒ 没有任何下界** ⇒ **任何「只看有没有计数行」的判据都会被它骗过**。**根因**：这些守卫的用例是用 `push(name, fn)` 注册的（`scripts/lib/guard-selftest.mjs` 的 `reportCases` 口径），`subprocess` 在该文件里**根本不存在** ⇒ 计数恒 0；`printCoverageBanner` 数不出来时**如实报 0 是对的**（不编数字），但**没人核对过 0 的含义**。
- **修法**：9 条的 `printCoverageBanner(import.meta.url, "subprocess")` 换成真实注册口径 `"push"` ⇒ 计数从 0 变成 **31 / 7 / 7 / 6 / 6 / 5 / 5 / 5 / 5**；登记表按「**历史规模约一半**」取 floor（**15 / 3 / 3 / 3 / 3 / 2 / 2 / 2 / 2**）；`scopePrefix` 同步加 9 个 basename；`$comment` 记录这一形态并说明「**为什么先扩 9 条不一次扩 76 条**」（floor 必须来自**实测**、且要**逐条**验证「删了会红」）。**9 条**：`check-coverage-floor`（31）· `check-ops-runbook`（7）· `check-optional-dep-silent-noop`（7）· `check-reserved-slots-consumer`（6）· `check-race-selftests-wired`（6）· `check-env-entry-sweep`（5）· `check-env-switch-default-policy`（5）· `check-executor-node-env-hermetic`（5）· `check-posture-matrix-tables`（5）。
- **验证（真实 exit；本轮回执在 HEAD `8004ebd8` 独立复核）**：`test:docs` **0** · `size-caps` **0** · `check:guards-wired` **0**（**覆盖计数 25 个已登记 / 73 未登记**，扫描面 **98**；第一批落地时是 **22 / 76**）· `test:guards:repo` **0（102/102，段数未变）**；落地项另验 9 个守卫 `--selftest` **全部 exit 0** · `check-script-main-guard` **0** · `check:atlas-counts` **0**。
- **第二批（`8004ebd8`）：同形态再 3 条** —— `check-destructive-global-commands` / `check-script-main-guard` / `check-ssrf-three-way-matrix`，口径 `subprocess` → `push`（计数各 **3**）、登记 floor **1**。**floor=1 的含义**：只保证「用例被删到只剩 **0–1** 条会红」，**不保证「删掉 3 条里的 1 条会红」**（小样本固有上限，**不要读成全面保护**；提高强度要先补用例，属另一轮）。红演示：`check-script-main-guard` 的 floor 临时改 **9** ⇒ 判据④红并点名「**用例计数 3 < 下界 9**」⇒ 还原 **0**。**方法学：不新增编号、并入 294**（当前最大 **296**）。
- **红演示（`347e616b` 的有牙证明）**：把 `check-ops-runbook` 的 floor 临时改成 **99**（> 实测 7）⇒ 判据④**立刻红**并点名「**用例计数 7 < 下界 99 —— 用例被删了一大半（或整族被掏空）**」；还原 ⇒ **0** ⇒ **计数不是摆设**。
- **配套**：`docs/atlas/07-testing/README.md` 的「登记表只覆盖 13 个 / 另有 85 个」更新为 **22 / 76**（`8004ebd8` 第二批后该文档已是 **25 / 73**），并把「**有计数行但恒 0**」这个更隐蔽的形态写进文档。
- **§7.0**：主表**维持 3 条**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`）—— 本轮这一项**此前不在主表**（是 R146 起的待办指针 / 候选池第 1 条），按「不要往主表加再迁走」只在 **A-17 本季收口（R154）** 记 **1 行**；**R146 待办指针已更新**：「85 个尚无覆盖计数保护」⇒「**73 个未登记（25 已登记）**；**且其中一批是『有计数行但恒 0』形态，需要先修口径再登记**（R154 已修 12 条，**还剩 3 条**）」。
- **遗留（≤2 条要点）**：① **「有计数行但恒 0」还剩 3 条没修** —— 实测仍是 `COVERAGE_CASES: 0` 的只剩：`check-guard-liveness`（push=**1**）· `check-categories-single-source`（check=**1**）· `check-cross-end-consistency`（check=**1**）⇒ **计数只有 1 ⇒ floor 只能是 0（= 无保护）⇒ 必须先补用例、再登记**（不要登记成装饰）；② 承前两轮、**本轮无承载者**：「**链红的偶发红仍未被持久观测**」（R153 遗留①）与「**未声明 `maxAgeHours` 的端仍是回落口径**」（R152 遗留①）。
- **下一轮第一步**：建议「**剩余 3 条『有计数行但恒 0』：先补用例、再登记**」（**S–M**；写域 `scripts/check-*.mjs` + `scripts/coverage-registry.json`；判据：每条**先把口径换成真实注册方式**、**证明 `COVERAGE_CASES` 与 `--selftest` 报告的用例数一致且 > 1**、**再**登记 floor ≥ 1（floor 0 不是保护）；`check:guards-wired`=**0** 且登记数上涨；`test:guards:repo`=**0** 且段数 **102** 不变；**红演示**每条至少一次「floor 调高 ⇒ 点名」）。

- **R153（2026-11-07，第 153 轮 · 并行第 83 批 · 台账 writer）**：**链失败报文回放该段的 stderr/stdout 尾部 + CI 的过时注释修正**（链条见 PLAN-CLAIMS 的 R153 组）。落地 **2 项**，均已由 Lead 复核，链 **102/102** 全绿；**§7.0 主表维持 3 条**。
- **`90bdafcb` `feat(guards)`：守卫矩阵失败时回放该段的 stderr/stdout 尾部**。**症状**：`test:guards:repo` 失败时只有三行——段号 + 命令 + 退出码；R152 实测**两次链红**（均在**第 6/102 段** `check:ssrf-parity`）都只看到「第 6 段 exit 1」，而真正原因（并发互踩的 ENOENT）在**上方几十段输出**里，得人肉往上翻几百行 —— 守卫的诊断信息在**它自己的 stderr** 里，报文没带过来。**根因**：`spawnSync(..., { stdio: "inherit" })` —— 子进程输出直接进终端，**父进程看不到内容**，只能拿退出码。**修法**：改异步 `spawn`，stdout/stderr **边跑边透传**（保留原有实时可见性与长段进度感）+ 各留**环形缓冲（最近 20 行）**；失败时把两段尾部原样回放进失败报文 ⇒「**红在哪一段**」与「**这一段为什么红**」落在同一处；顺带把**信号**也记进报文（旧报文只报 `code`，被 `SIGTERM` 杀的段 `code` 为 null、以前显示成 `exit 1`，看不出是信号），该段完全无输出时**显式说明「大概率是信号」**。**不变语义**：仍 fail-fast、仍**原样传播退出码**、仍逐段打印 `[k/N] <cmd> => exit N`。
- **`1de83ccf` `docs(ci)`：修正 admin-web i18n step 的过时注释**。**症状**：`ci.yml` 该 step 的注释写「`npm run lint:i18n` **只跑主跑**」，而 R145（`f10e2a76`）已把它改成 `i18n-scan --selftest && i18n-scan --check && i18n-key-check` ⇒ **注释与实现相反**，会让下一个人**误判**「i18n-scan 的自检没人跑」。**修法**：注释说明三件事 —— ① `lint:i18n` 现在**已包含** i18n-scan 自检；② 为什么必须**两次调用**（`--selftest` 与 `--check` **互斥**，混用 ⇒ exit 2）且**顺序固定**（自检是主判据的前置体检）；③ 下面单独列的 `i18n-key-check --selftest` **不是重复**，是**另一个判据**（缺键）的自检。**只改注释**，未动任何 step 的 action/runner/命令。
- **验证（真实 exit；本轮台账 writer 在 HEAD `1de83ccf` 独立复核）**：`test:docs` **0** · `size-caps` **0** · `guards-wired` **0** · `test:guards:repo` **0（102/102，段数未变）**；落地项另验 `--list`=**0**（解析 102 段）、`--only=1`=**0**、`--from=101`=**0**（单段/断点模式未受影响）、`check-script-main-guard`=**0**、`check:actions-pinned`=**0**、`check:runner-labels`=**0**、`check:workflow-yaml`=**0**。
- **红演示（`90bdafcb` 的有牙证明）**：临时把链第 2 段换成 `echo 原因 >&2; exit 3` 的夹具（跑完立即还原 `package.json`）⇒ 报文在原有段号/退出码之外打印 `── stderr 尾部（最近 20 行）── │ the-real-reason: fixture exploded at step 3` 与 `── stdout 尾部（最近 20 行）── │ some-stdout-context`，且**退出码仍是 3**（原样传播未变）。
- **§7.0**：主表**维持 3 条**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`）—— 本轮两项**此前都不在主表**，按「不要往主表加再迁走」只在 **A-16 本季收口（R153）** 记 2 行；**R152 留的待办①（`guards-repo-matrix` 失败报文补 stderr 摘要）已还清**（`90bdafcb`，依据方法学 **246**，旧待办只留对账痕迹）；新增待办指针：**「链红的偶发红仍未被持久观测」** —— 本轮 SSRF 并发问题已修，但同类「并发互踩 / 临时产物」缺陷**没有持续观测通道**；可考虑给 `test:guards:repo` 加「**重复跑 N 次**」的慢通道（形态照 `web-flake-watch`）—— **只登记，不立项**。
- **下一轮第一步**：建议「**85 个判别型脚本补覆盖计数登记（第一批约 10 个）**」（**L** 但可分批；价值：这些脚本的**用例被删光不会有任何东西变红**，是「**判据面塌方**」的真实风险面；写法照 `scripts/lib/` 既有覆盖计数机制；判据：`check:guards-wired` 的「覆盖计数 13 个」数字上涨 + 每个新登记的守卫 `--selftest` 仍 **0** + `test:guards:repo`=**0** 且**段数 102 不变**）。

- **R152（2026-11-07，第 152 轮 · 并行第 82 批 · 台账 writer）**：**覆盖率棘轮新鲜度收紧 + SSRF 三端探针并发互踩**（链条见 PLAN-CLAIMS 的 R152 组）。落地 **2 项**，均已由 Lead 复核，链 **102/102** 全绿；**链已连续三次全绿**（稳定性验证）。**本批另两条已由上一组台账落过账，此处不重复**：`c5d9fd69`（F5 的 DOM 层 a11y 断言，见下 R151 条目）、`c2241b4b`（R151 的 F5 欠账更正 + 方法学 287）。
- **`0f43ef89` `feat(guards)`：声明了 `maxAgeHours` 的端必须有 per-step `measuredAt`**。**症状**：R144 的「回落」口径是**洞**不是保守 —— `npm run health:snapshot -- --skip-heavy` 会**前移 `generatedAt`**（既有语义，**一步 full 都不跑**）⇒ 没有 `measuredAt` 的端看起来「刚测过」；R152 之前三端是**「声明了 `maxAgeHours=336` 却根本没有 `measuredAt`」**的矛盾状态。**修法**：① 三端**真跑回填（零手写）**：executor-node `--only` **19s** / admin-api **165–190s** / executor-python **204–210s**，三条 exit 0，pct **88.88 / 92.77 / 87.45**；② 判据收紧：声明 `maxAgeHours` ⇒ **缺 `measuredAt` 即红且不回落**，报文点名「无法判断新鲜度 / 文件级 `generatedAt` 会被 `--skip-heavy` 前移」+ 该端刷新命令；**未声明**的端保留天级回落并**显式登记为已知盲区**；③ 基线每端新增 `measuredAtPolicy`。selftest **27 → 31**（关键反例㉑：声明 hours + 缺 `measuredAt` + `generatedAt` **400 天**旧 ⇒ 红的理由必须是「缺 per-step 时间戳」而**不是**「已过期」）。
- **`549cc485` `fix(guards)`：SSRF 三端探针改用私有临时目录**。**症状**：`check:ssrf-parity` **随机**红、报「缺 `.__r10_probe.cjs`」这类 ENOENT —— 本轮**两次链红都是它**（均第 **6/102** 段），重跑就好、找不到稳定复现。**根因**：admin / node 两臂探针**固定写进仓库目录** + `try/finally` 删除 ⇒ 并发 / 被杀进程互踩（A 写 → B 写 → A 的 `finally` 删 → **B 的 spawn 拿不到文件**）；被杀进程还会把探针**永久留在仓库**（未被 `.gitignore` 覆盖 ⇒ 污染 `git status`）。**同一脚本的 python 臂早已 `mkdtempSync`** ⇒ 两臂是**同类漏网**。**修法**：两臂改 `mkdtempSync(os.tmpdir())` 私有目录 + `finally` 里 `rmSync({recursive:true})` 整目录删，**探针内容零改动**（靠两个**绝对路径**环境变量定位被测模块）；写域仅 `scripts/ssrf-category-matrix.mjs`（**+12/−4**）。
- **验证（真实 exit；本轮台账 writer 在 HEAD `549cc485` 独立复核）**：`check:coverage-floor` **0**（selftest **31/31**；**per-step 3 端 / 回落 0 端 / 未声明 0 端**）· `--skip-heavy` 后 `measuredAt` **6/6 逐字不变** · `check:ssrf-parity` **0** · **6 并发全 exit 0 且两 app 目录零 probe 残留** · `test:docs` **0** · `size-caps` **0** · `guards-wired` **0** · `test:guards:repo` **0（102/102）**。
- **反证**：棘轮 —— 删某端 `measuredAt` ⇒ **exit 1** 点名该端 + 给刷新命令，还原 ⇒ **0**；探针 —— **并发本身即是反证**（改前并发必然互踩、改后 6 并发全绿且零残留）。
- **⚠ 过程（不美化）**：棘轮那条由**两个 writer 并发撞同一批文件**（基线 JSON + 守卫脚本），read-modify-write **一度丢掉 node 端的 `measuredAt`** ⇒ 补法是**再跑一次真测**（19s）写回，**不是手写时间戳**；Lead 裁决「**停手 + 只交验证报告**」，最终由 Lead 复核统一提交 ⇒ 本条证据链是 **Lead 的那次提交**。
- **§7.0**：主表**维持 3 条**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`）—— 本轮两项**此前都不在主表**，按「不要往主表加再迁走」只在 **A-15 本季收口（R152）** 记 2 行；新增两条待办指针：① `guards-repo-matrix` 失败报文补**该段 stderr 摘要**；② 未声明 `maxAgeHours` 的端仍是回落口径（建 admin-web / 全链 floor 时须同批声明 + 回填）。
- **下一轮第一步**：建议「**`guards-repo-matrix` 失败报文补该守卫 stderr 摘要**」（**S**；写域 `scripts/guards-repo-matrix.mjs`；判据：故意让某段红时，报文里能看到**该段自己的 stderr 前几行**，而不是只有段号 + 退出码；`test:guards:repo`=0 且**段数 102 不变**；**红演示**：注入一个必红段，看报文是否点名原因）。

- **R151（2026-11-07，第 151 轮 · 并行第 81 批 · 台账 writer）**：**执行记录读失败不再说「暂无执行记录」+ 补 icon-only 按钮可访问名（F3+F5）**（链条见 PLAN-CLAIMS 的 R151 组）。落地 **1 项（含 F3+F5）**，已由 Lead 复核，链 **102/102** 全绿。
- **`e1303c19` `fix(web)`：F3（P3）任务详情「执行记录」Tab**：`useTaskExecutions` 的 `error` 被丢弃（页面只解构 `data`/`isLoading`）⇒ 读失败时表格渲染「暂无执行记录」。而「这个任务**从没执行过**」与「执行记录**读不出来**」是**方向相反的结论**：前者会让人**立刻手动触发一次**（本 Tab 右上就是「手动触发」）⇒ **多一次真实执行**；后者应当**重试或报障**。同页 `task` 有整页错误块、`stats` 失败时整块不渲染（宁可缺席也不撒谎），唯独该查询**既无错误分支、又有明确空态文案** ⇒ **三处口径不一致**。修法：把「执行记录」Tab 的**整块 UI + 列定义外提**到 `pages/task-detail/ExecutionsTab.tsx`（`TaskDetailPage` 只剩 **2 行余量**，错误分支无处可放），补**三态**：`execError` ⇒ 复用既有 `StateError` + **重试**（`refetch`），**不渲染**「暂无执行记录」、**不渲染**缓存旧行；无错且空 ⇒ **保留**「暂无执行记录」（**真空态逐字未改**）。
- **同提交 F5（P3）安装向导「共享 Token 显示/隐藏」**：icon-only `Button` **无可访问名** —— 全仓 **93 处 icon-only 控件里唯一缺的一处**（其余 92 处要么在 `Form.Item` 下有 label、要么自带 `aria-label`）⇒ 读屏用户听到的只有「按钮」。修法：补 `aria-label`，**名称随状态联动**（「显示共享 Token」/「隐藏共享 Token」）—— 读屏用户听到的是**马上要发生什么**，不是一个静态标签（→ 285）。
- **新增 3 个 i18n 键**（zh/en 成对）：`taskDetail.execLoadFail` + `install.tokenShow` / `install.tokenHide`。**体量**：`TaskDetailPage` 由 **1037/1039 降下来**（整块外提）；`ExecutorInstallWizardPage` 原本 **830/830 零余量** ⇒ 把该按钮 5 行属性表压成 4 行**净省 1 行**（等价压缩换行数，方法学 240）；**两者未调 ceiling、未用 `ALLOW`**。
- **验证（真实 exit）**：新用例 **3/3** · `task-detail-*` / `install-wizard-baseline` 回归 **3 文件 10 例 = 0** · `typecheck` / `lint` / `i18n-key` / `size-caps` / `user-facing-language` 全 **0** · `test:docs` **0** · `guards-wired` **0** · `test:guards:repo` **0（102/102）**。
- **反证**：错误分支改恒假（`execError ? … : …` ⇒ `false ? … : …`）⇒ **用例①② 双红**（**2 failed | 1 passed** —— ③ 真空态**仍绿**，说明它测的确实是另一件事）；还原 ⇒ **3/3 绿**。
- **链 102 段**（HEAD `e1303c19` 实测）：`test:guards:repo` **102/102 = exit 0**（**未新增链段、未碰链、未碰 CI**）。
- **⚠ 遗留（如实，很重要）：F5 没有自动化 DOM 测试**。两条路都失败：① 真渲染测试卡在 **antd v6 `Select` 在 jsdom 里的展开 / 选中交互**（本仓**无「点选项」既有先例**，实测 `.ant-select-item-option` **点不到**）⇒ 走不到「共享 Token 卡」那一步；② 源码文本断言**不被本仓判据接受**（`check:source-text-contracts` 要求登记，且读源码**证明不了 DOM 上确有名字**）。**正确解**：把「共享 Token 卡」**整体外提成独立组件**（该页零余量，外提本身也是收益），用 **props 直接测三态 + a11y**（→ 286）。
- **✅ R152 补记（`c5d9fd69`）：F5 的 DOM 层断言已补上（三个 jsdom 坑）** —— 上条欠账记的是**F5 落地提交时**的状态（**当时记的是真话**），但「测不了」这个**结论是错的**：**它其实可测** —— ① `combobox` 角色落在 **`.ant-select-content`** 里（不是 `.ant-select-selector`）；② 页面**两个** Select（类型/平台）⇒ 必须 `getAllByRole('combobox')` 取**第 0 个**；③ 选中后「下一步」的 `disabled` 要**等 React 提交** ⇒ **点击必须在 `waitFor` 之外**（在 `waitFor` 回调里点会**重复触发**、状态被反复重置 ⇒ 表现为「**永远走不到第 2 步**」）。新增 `apps/admin-web/src/__tests__/install-wizard-token-a11y.test.tsx`（**2 例**）：① 名称**随状态联动**；② 该屏**不留无名按钮**。**验证**：新用例 **2/2** · install-wizard 相关 **5 文件 30 例 = 0** · `typecheck:web`/`lint:web`/`size-caps` 全 **0** · `chain` **0（102/102）**。**反证（两条都真转红并还原）**：① 断言名改成不存在的名字 ⇒ 用例①**红**；② **删掉组件里的 `aria-label`** ⇒ 用例①②**双红** ⇒ 证明它真在**读 DOM 上的名字**、不是恒真。⇒ **最终解法不是「外提 + props 测」，而是真渲染直接测** ⇒ 方法学 **287**（判「测不了」前先确认是不是**路径没找对**）。
- **⚠ 一条失败记录（不美化）**：原计划第二条线「**收紧覆盖率棘轮的新鲜度判据**」（要求声明了 `maxAgeHours` 的端必须有 per-step `measuredAt`，否则红）—— **执行该任务的 subagent 失败退出、未留下任何改动**（无部分写入）⇒ **该项没做**，仍在候选池第 1 条。教训：**「派出去」不等于「做掉了」**，台账只按**产出的 diff** 记账。
- **§7.0**：主表**维持 3 条**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`）—— 本轮两项**此前都不在主表**（只在 R149–R150 候选池），按「不要往主表加再迁走」只在 **A-14 本季收口（R151）** 记 2 行；新增两条待办指针：**F5 可测化** 与 **覆盖率棘轮新鲜度收紧**。**R152 补记**：**F5 可测化已还清（`c5d9fd69`，见上）** ⇒ **A-14 现记 3 行**（F3 / F5 判据 / F5 的 DOM 断言），**已收口 40 → 41**；**候选池首位仍是「覆盖率棘轮新鲜度收紧」**（R151 失败项，正在重做）。
- **下一轮第一步**：建议「**覆盖率棘轮新鲜度收紧**（重做 R151 的失败项）」—— 判据：三端都有**真实** `measuredAt`（由 `--only` **真跑回填**，不许手写）+ 声明 `maxAgeHours` 的端**缺 `measuredAt` 即红** + selftest 增例 **≥3** + `check:coverage-floor`=**0** + `test:guards:repo`=**0** 且**段数 102 不变**。


- **R149（2026-11-07，第 149 轮 · 并行第 79 批）+ R150（第 150 轮 · 并行第 80 批）· 台账 writer**：**两个同主题批次合并记一组 —— 守卫黑盒覆盖 6/9 + 前端「读取失败当成没有数据」两条 + 「下发到设备」静默截断**（链条见 PLAN-CLAIMS 的 R149–R150 组）。落地 **3 项**，均已由 Lead 复核，链 **102/102** 全绿。
- **`9db3abbc` `check-agent-event-limits` 补黑盒 CLI 夹具（黑盒覆盖 6/9）**：R147 给 9 个守卫补了 `--root`、R148 给 3 个补了黑盒夹具，本轮做第 4 个。该脚本既有 **9 条断言一条都没经过 CLI 入口**（全进程内）⇒ 改后 **17 条编号用例，其中 10 条 spawn 真脚本**。覆盖：合规 ⇒ 0（用「16 条」**异构值**证明根真换成夹具、**不是回落真仓库**）／批上限改小 ⇒ 1／单条上限改大 ⇒ 1（**两个方向都有牙**）／非算术字面量 ⇒ 1 结构红／缺文件 ⇒ 1 可读一句话（**显式断言无 ENOENT 栈帧**）／空树 ⇒ 1 逐文件点名／`--root` 不存在 ⇒ 2／裸 `--root` ⇒ 2／`--selftest`+`--root` ⇒ 2。
- **`b88db534` 执行器详情 / SOP 抽屉把「读取失败」当「没有数据」（F2+F4）**：F2（P2）`metrics` / `executions` 的 `error` 被丢弃 ⇒ **一个失败点污染四个面**（统计「暂无性能数据」/ 趋势「暂无历史采样」/ 活跃卡静默回落却仍标「每 30s 轮询」/ 执行历史「暂无历史执行记录」）⇒ 三句**互相印证的假事实**。F4（P3）SOP 抽屉两 Tab 无 `loading`、无错误态，`openDetail` 失败只弹**文案错**的 toast（说「SOP **列表**加载失败」）+ **无重试**。修法复用既有 `StateError`：**聚合口径的面错误优先于数据**（旧聚合继续画会被读成「现在就是这样」）、**快照性质的面保留数值 + 标注过期 + 就地重试**。体量 `ExecutorDetailPage` 858/863、`SopsPage` 964/996（**未外提、未调 ceiling、未用 ALLOW**）；新增 6 个 i18n 键（zh/en 成对）。
- **`fdcff7de` 「下发到设备」弹窗不再静默截断部署行（F1）**：只取**前 100 行**且**丢弃 `total`**，后端按 `createdAt DESC` ⇒ **被截掉的恰是最老、最可能仍在 `running`** 的长期驻留实例；而弹窗是**破坏性动作的确认面**，宣称「全集」实际「最新 100 条」⇒ 缺席设备只会被读成「这台机器没部署过」。修法照抄同文件 `ReleasesTab` 的 P8 形态：保住 `total`（`deps.total ?? rows.length`，旧后端不带 `total` 时**按未截断处理、不谎报**）+ `Alert type=warning`（带 total/shown/hidden 与「这些更早的记录里可能仍有正在运行的设备」）+ **真空态与截断态分开**（新词条 `deployEmptyUnknown` 带数字）+ 快照包地址三态显式化。该页原本 **1302/1302（零余量）** ⇒ 弹窗整块 JSX **外提**成 `pages/application-detail/{DeployToDevicesModal.tsx,deploy-pkg-state.ts}`，页面降到 **1253/1302**。
- **验证（真实 exit）**：`--selftest` **0**（**17/17**）且主跑 **0**、**stdout 与改前逐字节相同**（84B，`sha256 6c05b49e…a373`，`cmp` IDENTICAL）· 前端新用例 **6/6 + 9/9** · 相关回归 15 文件 76 例 + 3 文件 14 例 + 8 文件 76 例 = **0** · `test:docs` **0** · `size-caps` **0** · `guards-wired` **0**（89/88 不变）· `test:guards:repo` **0**。
- **反证（均真转红并还原）**：守卫侧三向 —— A 夹具上限 `2048→8192` ⇒ **4/17 红**；B **删掉 `process.exit(1)`** ⇒ **5/17 红，且进程内用例全绿、只有 CLI 面抓到**（黑盒夹具的价值本身，同时暴露全仓通病：**失败分支后无 `return` 只靠 `process.exit`**）；C 短路互斥 ⇒ **1/17 红**且 1s 内无残留进程（已加 `ACF_EVENT_LIMITS_SELFTEST_CHILD` **防 fork 炸弹**）。前端 —— F2 还原 ⇒ **2 failed / 1 passed**；F4 还原 ⇒ **3 failed**；F1 三向（`truncated = false` / 一律 `deployEmpty` / 丢弃 `total`）各红。
- **链 102 段**（HEAD `fdcff7de` 实测）：`test:guards:repo` **102/102 = exit 0**（**未新增链段、未碰链**）。
- **黑盒 CLI 夹具覆盖 6/9**：`source-text-contracts` / `sanitize-parity` / `collaborator-self-call`（R148）+ `brand-drift.selftest` + `npm-audit-exemptions`（**31 条里仅 10 条真子进程**）+ `agent-event-limits`（R149）。剩 2 个**不是缺 `--root`**，是**判据形状**问题。**「用例多」≠「黑盒夹具有」**（→ 280）。
- **前端 P2 两条已清**：F1（`fdcff7de`）、F2（`b88db534`）；同批 F4（P3）一并清。**剩 F3（`TaskDetailPage` 执行记录错误态，余 **2 行**）与 F5（`ExecutorInstallWizardPage` icon-only 按钮无可访问名，**零余量**）⇒ 两条都必须先外提**，只进候选池 + §7.0 留指针。
- **只读审计（`artifacts/autonomy/R149/assess-frontend.md`，gitignore 不入库）**：**P1 0 / P2 2 / P3 3**。**已核实无缺陷（勿重复上报）**：F-2 misfire 已修（R140）、F-5 导出已修（R142）、分页钳制四处已实现、跨页选中已无同型、入口面 **219 path / 255 方法全比对无新缺口**、全量 JSX 扫描 **93 处 icon-only 仅 1 处未命名**、模态焦点与 SSE 守卫齐全。
- **§7.0**：主表**维持 3 条**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`）—— 本轮三项**此前都不在主表**，按「不要往主表加再迁走」只在 **A-13 本季收口（R149–R150）** 记 3 行；待办指针已更新为「9 个守卫黑盒覆盖 **6/9**，剩 `protocol-three-way` / `spec-coupling-surfaces`（**都不是缺 `--root`**）」，并新增 F3/F5 两条待办（**都必须先外提**）。
- **下一轮第一步**：建议 **F3 + F5 同批**（都是「必须先外提才能改」的小项；写域 `apps/admin-web/src/pages/TaskDetailPage.tsx` + `pages/ExecutorInstallWizardPage.tsx` + 新建外提文件 + locales + 测试）—— **判据**：先红后绿的单测 + `typecheck:web` / `lint:web` / `size-caps`（**必须 0，靠外提而不是调 ceiling**）/ `i18n-key-check` / `test:guards:repo`=0 且**段数 102 不变**。

- **R148（2026-11-07，第 148 轮 · 并行第 78 批 · 台账 writer）**：**3 个守卫补黑盒 CLI 夹具自检**（判据面从「白盒」升到「黑盒」，链条见 PLAN-CLAIMS 的 R148 组）。
- **`14518900` 3 个守卫补黑盒 CLI 夹具自检**：R147（`980e53aa`）给 9 个守卫补了 `--root <dir>` ⇒ 它们**能**指向临时目录里的夹具仓库，**但自检还没写** ⇒ 那 9 个守卫的**判据面**仍只有**白盒**保护（把内部函数抽出来喂内存 fixture，或把守卫脚本复制进夹具树 —— 按 `scripts/lib/guard-selftest.mjs` 头注的立场，那是「**测的是函数，不是守卫**」）。**最硬的一条证据**：`check-source-text-contracts` 既有 **35** 条用例**一条都没碰过 `applyRoot()`** —— 那正是 R147 唯一会换根的地方 ⇒ **把 `applyRoot()` 里那两行删掉，35 条照样全绿**，而守卫会**静默读真仓库**（最坏的那种假绿）。
- **修法（3 个脚本、统一形态）**：`runGuard(SELF, ["--root=<mkdtemp 夹具>"])` **spawn 真脚本**、断言**退出码 + 报错文本**；夹具建在 `os.tmpdir()` 的 `mkdtemp` 下、**用完即删** ⇒ **绝不往仓库写任何文件**；**互斥不构成障碍**（`--selftest` 与 `--root` 互斥管的是**同一次调用**，spawn 出的子进程**只带 `--root`**）；每个脚本头注补「**自检覆盖了什么 / 没覆盖什么**」小节（**盲区写在脚本里**，不只写台账）。**选法 = 判据复杂 × 夹具可行 × 现有 selftest 离 CLI 有多远，刻意不按文件名顺序**：① `check-source-text-contracts` **35 → 41** 例（两张登记表 × 各 4~5 条判据 + 启发式扫描器 `LOOKBACK`/`LOOKAHEAD`；既有用例一条没碰换根 ⇒ 退化风险最高）；② `check-sanitize-parity` **8 → 13** 例（4 判据 × 6 入口 × 全 `apps/admin-api/src` 字面量扫描；**6 个入口路径全是模块加载期常量** ⇒ 既有 8 条 100% 进程内）；③ `check-collaborator-self-call` **9 → 15** 例（正则静态分析 + `ALLOW` 阈值 + 双前缀；新增含「**扫到 0 个协作者 ⇒ 结构红 1**」—— R147 新增的那条判据此前**只在真仓库上跑过**）。
- **验证（真实 exit）**：三个 `--selftest` 全 **0**（**41/41 / 13/13 / 15/15**）· **主跑 0 且 stdout 与改动前逐字节相同**（writer 独立复核：`git archive` 导出 `14518900^` 与 `14518900` 到**同一路径**跑 `diff -q` ⇒ 三者 stdout 全 same，stderr 只差 node 警告的 **PID**，归一化后全 same）· `test:docs` **0** · `size-caps` **0** · `check:guards-wired` **0** · `test:guards:repo` **0** 且末行「解析 **102** 段 / 执行 **102** 段 / diff 空」。体量 3 文件 **+609/−5**。
- **红演示（均还原）**：合规夹具改成违规形态 ⇒ 对应用例 **exit 1**（`source-text` ㉛ / `sanitize` 正例 / `collaborator` ⑨）；另做**反方向**（违规改回合规 ⇒ 反例用例红）⇒ 两侧都有牙。
- **自检面 88/89（未变）但**判据覆盖深度**涨了**：那三个数统计的是「**有几个守卫有自检文件**」，本轮补的是**既有守卫的既有 `--selftest` 里的用例** ⇒ **分母不变、用例条数变** ⇒ 涨的是**判据覆盖深度**（41 / 13 / 15 例，其中黑盒夹具 **6 / 5 / 6** 条）。**这是两个不同的量，必须分开报**（→ 277）。`check-guards-wired` 的**覆盖计数仍 13**（登记是另一个写域）。
- **盲区（已写进三个脚本头注）**：夹具是**自检手写的最小样本**、不是真仓；`check-sanitize-parity` 的共享实现是「真实现的逐字节副本」⇒ 真实现被改弱时正例夹具也会红（**重复信号**，不是假绿）；`check-protocol-three-way` 判据是「三侧**真跑**对拍」⇒ 夹具树跑不动 ⇒ **判据面仍无夹具保护**；`check-spec-coupling-surfaces` 是 **report-only** ⇒ **不存在**「违规 ⇒ exit 1」形态，**硬写就是改判据**（越界，→ 279）。
- **链 102 段**（HEAD `14518900` 实测）：`test:guards:repo` **102/102 = exit 0**（**未新增链段、未碰链**）。
- **§7.0**：主表**维持 3 条**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`）—— 本轮这一项**此前不在主表**，按「不要往主表加再迁走」只在 **A-12 本季收口（R148）** 记 1 行；**「9 个守卫的夹具自检」待办已部分兑现（3/9 已写）**，指针更新为：**剩 6 个** = `agent-event-limits`（原型已验证）/ `brand-drift.selftest`（R147 已加 3 条黑盒用例，可再补）/ `npm-audit-exemptions`（已有 30+ fixture 用例，可能不缺）/ `protocol-three-way`（**需重构判据形状**）/ `spec-coupling-surfaces`（**report-only，要改设计**）/ 其余按需 ⇒ 进候选池第 1 条 + §7.0 留指针。**别把「3/9」读成「6/9 一样容易」** —— 剩下 6 个里**有 2 个需要先改判据/设计**。
- **下一轮第一步**：**`check-agent-event-limits` 夹具落盘**（**S**，原型已验证；写域 `scripts/check-agent-event-limits.mjs`）—— 顺带把 `npm-audit-exemptions` 的 30+ fixture 用例与 `brand-drift` 的 R147 黑盒用例**一起核对**，确认「已有夹具」的守卫清单**准确**。**判据**：`--selftest` = **0** 且**红演示真红**；`check-guards-wired` = **0**；`test:guards:repo` = **0** 且**段数不变 102**。

- **R147（2026-11-07，第 147 轮 · 并行第 77 批 · 台账 writer）**：**9 个守卫补 `--root` 支持**（判据面可夹具化的**前提**，链条见 PLAN-CLAIMS 的 R147 组）。
- **`980e53aa` 9 个守卫补 `--root`**：本仓守卫的约定是「**仓库根当参数传，别硬编码 `process.cwd()`**」，`--root <dir>` 是这条约定的唯一执行面 —— 它让守卫能指向**临时目录里的夹具仓库**（selftest 必须造假仓库、**不能碰真仓库**）。实测 `scripts/` 下 **90** 个 `check-*.mjs` 里 **81** 个已支持、**9** 个不支持（`check-agent-event-limits` / `check-brand-drift`（+`.selftest`）/ `check-collaborator-self-call` / `check-npm-audit-exemptions` / `check-protocol-three-way` / `check-sanitize-parity` / `check-source-text-contracts` / `check-spec-coupling-surfaces`）⇒ 那 9 个**写不了夹具自检**（只能在真仓库上跑）⇒ **其判据面没有黑盒自检保护**，改坏**没有任何东西会变红**。**修法（9 个脚本、同一口径，与 `check-agent-stub-fidelity` / `check-mcp-error-hints` 同款）**：① `--root <dir>` 与 `--root=<dir>` **两种形态都认**；② **缺省根仍按脚本位置锚定** ⇒ 不传时 stdout 与改前**逐字节相同**；③ 缺值/空值/真空格误吞下一个开关 ⇒ **exit 2**；④ 指向**不存在目录** ⇒ **exit 2**、**不静默回落到真仓库**；⑤ 指向**存在但不是本仓形状**的树 ⇒ **结构红 exit 1**（一句话 + 实际查找路径，不是 ENOENT 栈）；⑥ 6 个内联 selftest 的 `--selftest` 与 `--root` **互斥 ⇒ exit 2**。每个头注补「**仓库根从哪来**」小节。
- **五处不是机械复制**：`check-brand-drift.selftest` **+3 条黑盒 CLI 用例**（spawn 主脚本传 `--root=<夹具>`：合规 ⇒ 0 / 破坏后 ⇒ 1 / 不存在 ⇒ 2 ⇒ 主脚本吃掉 `--root` 必红；**21 → 24**）；`check-collaborator-self-call` 补「**扫到 0 个 ⇒ 结构红 1**」堵 `walk()` 吞 ENOENT 的假绿；`check-source-text-contracts` 的 `--root` **连两张登记表**按根解析（否则整棵树搬不走、只能测纯函数）；`check-spec-coupling-surfaces` 的自检临时报告改落 `os.tmpdir()`（**不再往仓库写盘**）；`check-npm-audit-exemptions` 区分**两类 cwd** —— **仓库根**受 `--root`，**`process.cwd()`**（用户敲的相对路径的**首选**基准）**不改**（实证：`cd /tmp` 时 `--dir apps/admin-api` 必须回落到夹具根）。
- **验证（真实 exit）**：9 个主跑全 **0**（stdout 与改前**逐字节相同**，writer 抽验 3 个亦然）· `--root=<不存在>` 与裸 `--root` **全部 2** · 每个脚本夹具面均实测（合规 ⇒ 0 / 破坏后 ⇒ 1 / 非本仓形状的树 ⇒ 结构红 1）· `test:docs` **0** · `size-caps` **0**（基线条目 98 / ALLOW 2 / warn 582）· `check:guards-wired` **0** · `test:guards:repo` **0** 且末行「解析 **102** 段 / 执行 **102** 段 / diff 空」。体量 10 文件 **+748/−41**。
- **`--root` 支持面 90/90**：atlas `docs/atlas/07-testing/README.md:151` 由「90 中 81」→「**90 个现已全部支持**」，并保留「R147 之前是 90 中 81、9 个不支持」+ 逐个清单（→ 273：**数字 + 日期/HEAD + 上一版变了什么**）。
- **链 102 段**（HEAD `980e53aa` 实测）：`test:guards:repo` **102/102 = exit 0**（**未新增链段、未碰链**）。
- **已知限度（写进头注）**：`check-protocol-three-way` 的判据是「三侧**真跑**对拍」⇒ 夹具树跑不动 ⇒ 它的 `--root` 买的是「口径统一 + 绝不悄悄跑真仓库 + 探针落盘跟随根」，**不是**「判据可夹具化」；其判据面自保由**既有** `--selftest`（**25** 例纯函数/内存行）承担。
- **§7.0**：主表**维持 3 条**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`）—— 本轮这一项**此前不在主表**，按「不要往主表加再迁走」只在 **A-11 本季收口（R147）** 记 1 行；**「9 个守卫现在能写夹具自检了，但还没有写」作为待办**（不是收口项，**可分批**、先挑判据最脆的 2–3 个）进候选池第 1 条 + §7.0 留指针。R146 的「9 个守卫不支持 `--root`」待办**已还清**。
- **下一轮第一步**：**给那 9 个守卫补 selftest 夹具**（先做 **2–3 个最脆的**，别一次做 9 个；写域 `scripts/check-*.mjs` + 各自 `.selftest.mjs`）—— 现在工具到位了，判据面值得被自检保护；建议先挑 `check-protocol-three-way` **之外**、判据最脆的。**判据**：`--selftest` = 0 且**夹具用例真能红**（红演示）；`check-guards-wired` = 0（**自检面从 88/89 涨**）；`test:guards:repo` = 0 且**段数不变**（若变化必须说明并同步）；`size-caps` = 0。⚠ 新开测试文件要同步 `check-atlas-counts` 的「mcp-server 10 文件」这类**小分母数字**（`--update` 机械同步；±5% 在小分母上退化成 ±0）。

- **R146（2026-11-07，第 146 轮 · 并行第 76 批 · 台账 writer）**：MCP **错误提示表 ↔ 后端码表的漂移闸**（链 101 → 102）+ atlas **守卫接线数字刷新**（链条见 PLAN-CLAIMS 的 R146 组）。
- **`a13f0b88` MCP 码表漂移闸**：R145（`dc23ad9b`）在 `packages/mcp-server/src/error-hints.ts` 建了「已知后端错误码 → 成因 + 下一步」的**第二份**表（跨包读后端码表**结构性不可行**：MCP 包 `tsconfig` 的 `rootDir: ./src` ⇒ 跨树相对导入 **TS6059**；发布物只有 `dist`）。头注只写「新增/改名错误码时两边都要看」⇒ **靠人记 = 没有守卫**：后端加减一个 A6b 码，MCP 表**静默过期**（新码退回裸 HTTP 文案），**无任何信号**。**修法**：新增 `scripts/check-mcp-error-hints.mjs`（零依赖静态、~0.3s）—— 判据①（**不限族**）MCP 表里每个码必须在后端码表**真实存在**；判据②（**只限 `TASK_FIRE_POINT_*` 族**）后端 A6b 族每个码必须在 MCP 表里；判据③ 两边都记 `status` 时必须一致（当前 MCP 表不记 ⇒ 真仓库上空跑，已由 selftest 反证会红）。**判据②的边界是本守卫最容易写错的地方**：后端码表 **431** 个码 vs MCP 表**刻意只收 3 条** ⇒ 写成「每个后端码都要在表里」第一天就红 **428** 条且永远红 ⇒ **永远红的守卫等于没有守卫**（豁免是全局的，真漂移也一起被豁免）；selftest 用例②是**控制组**（`TASK_NOT_FOUND` 不在表里必须 exit 0）。**5 类结构红**（不退化成「0 项漂移」）：码表读不出/分片数不符、表缺失或字面量不闭合、出现**非裸标识符键**（本守卫读不到的形状）、表解析出 **0 条**、后端 A6b 家族解析出 **0 个码**。解析复用 `scripts/lib/error-catalog.mjs` 的 `readCatalog()`（同一份口径，不另写正则）；MCP 侧自写深度扫描器（零依赖 job 里 `typescript` 不可用）。**接线**：`package.json` 加 `check:mcp-error-hints`（`--selftest && 主跑`）+ 挂进 `test:guards:chain`；**链 101 → 102**（**追加末尾，不动既有段位**）；`ci.yml` 加 step；`docs/health-baseline.{json,md}` 段数同步（生成物机械同步）。
- **`d3e825b9` atlas 守卫接线数字刷新**：`docs/atlas/07-testing/README.md` 的「现况」段写的是 **2026-10-30 实跑**的 **46 / 47 / 46**，其间新增 **45** 个守卫 ⇒ **过期约一个半月**（46 与 91 是两个不同的工程状态）。按 **2026-11-07 实跑**（HEAD `a13f0b88`）更新为 **91 / 89 / 88**，**日期与 HEAD 一并写明**，并保留一行注明「上一版是 2026-10-30 快照」（免被读成同日两个数打架）。顺带补两处**覆盖面事实**：① **「守卫数量」≠「受覆盖计数保护的守卫数量」**（判别型脚本 **98** 个，**只有 13 个**登记了覆盖计数，其余 **85 个尚无覆盖计数保护**）；② **`--root` 支持面 91 个里 82 个**，并**逐个列出**不支持的 **9** 个（清单见 `docs/atlas/07-testing/README.md:151`）—— 写具体数若不写清口径就会变成新谎言。
- **验证（真实 exit）**：`test:docs` **0** · `size-caps` **0** · `check:guards-wired` **0** · `test:guards:repo` **0（102/102）**；落地侧另有 `node scripts/check-mcp-error-hints.mjs` 主跑 **0**（后端码表 **431** 码 · A6b 族 **3** 个 · MCP 表 **3** 条 · 0 项漂移）、`--selftest` **0（10/10）**、`check:atlas-counts` **0**、`script-main-guard` **0**、`workflow-yaml` **0**、`check:actions-pinned` **0**、`check:runner-labels` **0**。
- **反证（均还原）**：① 表里加 `TASK_FIRE_POINT_GHOST` ⇒ **exit 1** 点名「后端已不存在」；② 后端**新增** `TASK_FIRE_POINT_BRAND_NEW` ⇒ **exit 1** 点名「未进 MCP 表」（**这才是缺口的真实形态**：①防「为还不存在的码写成因」、②防「后端加码而表静默过期」）；selftest 另含控制组（非 A6b 码不在表里 ⇒ **0**）、`status` 不一致、字符串键结构红、表被清空结构红、家族前缀被改名结构红、未知参数/坏 `--root` ⇒ **exit 2**。
- **链 102 段**（HEAD `d3e825b9` 实测）：`test:guards:repo` **102/102 = exit 0**（**新增 1 段** = `check:mcp-error-hints`，**追加在末尾**，既有段位未动）。
- **守卫现况**（2026-11-07 实跑，HEAD `a13f0b88`）：**91** 个 check 脚本 / **89** 个有自检 / **88** 个两面都跑；判别型脚本扫描面 **98** 个（`check-*` ∪ `agent-*`），**只有 13 个**登记了覆盖计数 ⇒ **85 个尚无覆盖计数保护**。
- **§7.0**：主表**维持 3 条**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`）—— 本轮两项**此前都不在主表**，按「不要往主表加再迁走」只在 **A-10 本季收口（R146）** 记 2 行；**「85 个判别型脚本补覆盖计数登记」作为待办**（不是收口项）进候选池 + §7.0 留指针。
- **下一轮第一步**：**9 个守卫补 `--root` 支持**（工作量 **S–M**，写域 `scripts/check-{agent-event-limits,brand-drift,collaborator-self-call,npm-audit-exemptions,protocol-three-way,sanitize-parity,source-text-contracts,spec-coupling-surfaces}.mjs`）—— **只有支持 `--root` 才能给守卫写 selftest 夹具**（selftest 需在临时目录里造仓库），这是本仓多数守卫都有 selftest 的前提。**判据**：`node scripts/check-guards-wired.mjs` 仍 **0** + 每个改动的守卫 `--selftest`（若已有）仍 **0** + `size-caps` **0** + `test:guards:repo` **0**（**段数应仍 102**，若变化必须说明并同步）。

- **R145（2026-11-07，第 145 轮 · 并行第 75 批 · 台账 writer）**：i18n 守卫**自检接进门禁** + MCP **已知错误码补「成因 + 下一步」**（链条见 PLAN-CLAIMS 的 R145 组）。
- **`f10e2a76` i18n 守卫自检接进门禁**：R144（`8358ba0a`）给 `apps/admin-web/scripts/i18n-scan.mjs` 补了 `--selftest`（**9 例**），但**没有任何地方跑它**（`lint:i18n` 只串 `--check` + `i18n-key-check.mjs`，`ci.yml` 的 admin-web step 调的就是这条；`scripts/check-guards-wired.mjs` 的采集面是 `^check-.*\.mjs$` ⇒ 不替它报警）⇒ 它的**判据面（采集面 + `SKIP_FILES` + 模式互斥）无人守护**，将来改坏不会有任何东西变红。**修法 = 改入口、不改 CI**：`lint:i18n` 改为 `--selftest && --check && i18n-key-check` —— **两次调用**（两者**互斥 ⇒ 混用 exit 2**，不定义优先级）、**先自检再主判据**、**未改 `ci.yml`**（CI 的 admin-web step 调的就是 `npm run lint:i18n` ⇒ 本地与 CI 共用同一入口，不动 action/runner 面）。
- **`dc23ad9b` MCP 已知后端错误码补「成因 + 下一步」**：R143 让 `trigger_task` 能带 `consumeNextFirePoint`，但被拒时 MCP 只把后端 HTTP 错误**透传** ⇒ 模型看到 `API error (409): <后端文案>`，**为什么**被拒、**下一步**做什么全靠它猜；CLI 侧早有这层（`packages/acf-cli/src/error-code.ts`）⇒ 两客户端对**同一次失败**可读性差一档。**根因**：错误面只有「状态码 → 一句话」的通用映射，**没有「按码」的成因层**。**修法**：新增 `packages/mcp-server/src/error-hints.ts` 按**码**给 `cause` + `nextStep`（**3 条 A6b 码**），`api.ts` 的 `buildHttpError` 在既有文案后**追加**；**未知码 / 无码 / 原型链键 ⇒ `null` ⇒ 既有输出逐字节不变**。**「包内第二份」而非复用**（三种否决**分档**）：跨包读 `apps/admin-web/src/locales/generated/*` 或后端码表**结构性不可行**（`rootDir: ./src` ⇒ **TS6059**；发布物只有 `dist`）、复用 `acf-cli` 分类表**语义不对**（按类别的一句话会给出**错误建议** —— 重读不会让登记变可消耗）、只有「耦合不好看」才是**偏好**。头注列**四处事实源** + **三条复核命令** + 「新增/改名时两边都要看」；**不做全量码表**；英文（输出对象是模型），**未复制** zh/en 文案。**测试并入既有 `api.test.ts`（未新开** —— 新开会撞 `check-atlas-counts` 的「mcp-server 10 文件」数字，文档不在写域）：9 条（39 → **48**）。
- **验证（真实 exit）**：`test:docs` **0** · `size-caps` **0** · `check:guards-wired` **0** · `test:guards:repo` **0（101/101）**；落地侧另有 `npm run lint:i18n` **0**（输出含 `✔ i18n-scan selftest 通过：9/9`，**在 `--check` 之前**；writer 复跑 3.41s）、`check:actions-pinned` **0（13/13）**、`check:runner-labels` **0（7/7）**、`packages/mcp-server` 全包 **10 文件/341 例 = 0**、`typecheck:mcp` **0**、`test:mcp-tool-surface` **0（56 工具）**。
- **反证（均还原）**：① **「摘掉 selftest 仍绿」** —— 直接跑**旧入口的等价命令**（`--check && i18n-key-check`，**不改任何文件**）⇒ **exit 0** 而输出里 `selftest` 行命中 **0** ⇒ **「绿」只证明主判据过，不证明自检执行过**（接线类改动的判据必须是「输出里有没有那一段」，不是「退出码是不是 0」）；接回复跑 ⇒ 0 且 9/9。② MCP 临时关掉映射 ⇒ **4 红**（409/400/端到端），而「未知码原样」5 条**仍绿**（它判的是「不追加」）；还原 ⇒ 0。
- **链 101 段**（HEAD `dc23ad9b` 实测）：`test:guards:repo` **101/101 = exit 0**（末段仍是 `check:coverage-floor`，**未新增链段**）。
- **§7.0**：主表**维持 3 条**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`）—— 本轮两项**此前都不在主表**，按「不要往主表加再迁走」只在 **A-9 本季收口（R145）** 记 2 行；**「MCP 第二份码表的同步无 CI 守卫」作为待办**（不是收口项）进候选池 + §7.0 留指针。**R144 的「i18n selftest 未接 CI」待办已还清**。
- **下一轮第一步**：**MCP 第二份码表的同步守卫**（工作量 **S**，写域 `packages/mcp-server/src/**` + 根 `scripts/**`）—— 一条守卫比对 `packages/mcp-server/src/error-hints.ts` 的键集合与后端 `apps/admin-api/src/common/errors/catalog/task.ts` 的 A6b 码集合，不一致即红；**判据**：后端新增/改名 A6b 错误码时守卫红。⚠ 新增测试文件要同步 `check-atlas-counts` 的「mcp-server 10 文件」数字（小分母上容差退化成 ±0）。

- **R144（2026-11-07，第 144 轮 · 并行第 74 批 · 台账 writer）**：i18n 硬编码守卫**采集面收窄**（+ 补 `--selftest`）+ 覆盖率棘轮 **per-step `measuredAt`**（小时级新鲜度）+ 生成物同步（链条见 PLAN-CLAIMS 的 R144 组）。
- **`8358ba0a` i18n 守卫排除测试基础设施文件 + 补 selftest**：`npm run lint:i18n` **exit 1**（**既有红，非本轮引入**）报 6 处「新增硬编码中文界面串」，全在 `apps/admin-web/src/test-setup.ts` 的两个浮空 rejection 收割器（`:149/150/175/176`）—— 它们是**开发者/CI 诊断信息**，只在测试失败时抛进日志、**浏览器永不渲染、连用例本身都读不到** ⇒ 判据（「会显示给中文用户以外观感的硬编码中文串」）**没写错**，是**采集面**把 vitest `setupFiles` 也算进来了。**修扫描面、不登记豁免**：`SKIP_FILES = {test-setup.ts, test-setup-scheduler-guard.ts}`（**确切文件名**，不是通配；`src/**/*.test.ts` **仍被扫**，selftest 用例⑤钉住），**不写进** `i18n-baseline.json` 的 `accepted`（「登记代替修复」）；`--file` 人工探针不受影响；未知参数 / `--root` 缺 `src/` ⇒ **exit 2**。该脚本**此前没有 selftest** ⇒ 新增 `--selftest` **9 例**（真子进程 + 临时夹具树）。
- **`188accdc` 覆盖率棘轮加 per-step `measuredAt`（小时级）**：旧新鲜度只读**文件级** `generatedAt`（粒度=天）⇒ ① `--skip-heavy` 前移日期却**一步全量都不跑** ⇒ **假绿**（「上次的覆盖率 + 今天的日子」）；② 单端快照 `coverage:node` **真跑了测试却不更新** `generatedAt` ⇒ **真刷了数据反而解不了红**（R140 盲区）。**只增字段、不改 `generatedAt` 既有语义**（它仍是「文件生成日期」，改语义会让历史基线一夜失效）：每个 step 新增 `measuredAt` = **该 step 跑完的真实时刻**（ISO 8601 带时刻 UTC 秒精度），时刻与字段名由 `coverage-snapshot.mjs` 导出 `isoTimestamp()` / `MEASURED_AT`、**两个写基线脚本 import 同一份**；**沿用不是重测 ⇒ 时间戳不许刷新**（`effectiveSteps` 复用 `prev.steps` 的**原对象** ⇒ **结构保证**）。判据：**per-step（小时级）优先 → 缺失回落文件级（天级，兼容旧基线）→ 都缺 ⇒ 红「无法判断新鲜度」**，报文明说**来源 + 时刻 + 粒度**；`measuredAt` 在但**写坏 ⇒ 红且不回落**。`maxAgeDays` **保留** + 新增可选 `maxAgeHours`，**都声明时取更严者**（`min`；三端 14 天 / 336 小时）；失败步**也记** `measuredAt`。
- **`a282a2d4` 生成物同步**：`docs/health-baseline.md` 由**脚本**重写（executor-node 步 `17s → 18s`；顶部说明改为「本次只重跑 executor-node 全量（`--only`），其余 step 沿用上次基线、未重跑，其 `coveragePct` 一并保留」）。**生成物不手改数字。**
- **验证（真实 exit）**：`test:docs` **0** · `size-caps` **0** · `check:guards-wired` **0** · `test:guards:repo` **0（101/101）**；落地侧另有 `npm run lint:i18n` **0**（**此前红，现转绿**）、`i18n-scan --selftest` **0（9/9）**、`i18n-key-check` **0**、`check:coverage-floor` **0**（3 端；per-step 1 / 回落 2）、`check-coverage-floor --selftest` **27/27**、`health:snapshot --skip-heavy` **0** 且 executor-node `measuredAt` **跑前跑后不变（6/6）**、`--only="executor-node 全量"` **0**、main-guard **0/0**。
- **反证（均还原）**：① 临时副本把 `SKIP_FILES` 改空 ⇒ `--check` **exit 1**（6 处逐条复现 `test-setup.ts:149/150/175/176`）+ selftest **用例④ 转红（1/9）**；删副本、真脚本复跑 ⇒ **0**（**未**用 `git checkout`）；② 某端 `measuredAt` 改成很旧的时刻 ⇒ `check:coverage-floor` **exit 1** 且点名「已过期 889 小时（≈37.0 天；上限 336 小时 —— 取更严者）… 来源=该 step 的 per-step `measuredAt`」**且不判覆盖率高低**；还原 ⇒ 0。
- **链 101 段**（HEAD `a282a2d4` 实测）：`test:guards:repo` **101/101 = exit 0**（末段仍是 `check:coverage-floor`，**未新增链段**）。
- **棘轮新鲜度现为两级**：**per-step `measuredAt`（小时级）→ 回落文件级 `generatedAt`（天级）→ 都缺即红**；无 `measuredAt` 的旧 step 仍走回落（`--skip-heavy` 仍能骗过它们，写进头注的已知盲区）。**覆盖率棘轮纳管 3 端**：python **87.45** / node **88.88** / admin-api **92.76**（floor 取观测下界；admin-api 实测 92.77 ⇒ 提示「可上调」，是否上调由人决定）。
- **`npm run lint:i18n` 由红转绿**：本季「既有红」里**唯一可自主清的**已清；`test-setup.ts` 文案一字未改（**改的是扫描面，不是文案**）。
- **§7.0**：主表**维持 3 条**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`）—— 本轮两项**此前都不在主表**，按「不要往主表加再迁走」只在 **A-8 本季收口（R144）** 记 3 行；**「i18n 守卫的 selftest 未接 CI」作为待办**（不是收口项）进候选池 + §7.0 留指针。
- **下一轮第一步**：**i18n 守卫 selftest 接 CI**（工作量 **S**）—— 把 `node scripts/i18n-scan.mjs --selftest` 并入 `apps/admin-web/package.json` 的 `lint:i18n` 或 `ci.yml` 的 i18n step（`scripts/check-guards-wired.mjs` 的采集面是 `^check-.*\.mjs$`，**不会**替它报警）。**改 CI 片段前先跑 `check:actions-pinned` 与 `check:runner-labels`**；判据：`npm run lint:i18n` 仍 **0** 且 selftest **真跑**（9/9）。

- **R143（2026-11-07，第 143 轮 · 并行第 73 批 · 台账 writer）**：全量体检接上 admin-api coverage（+ `--only` 单步通道）+ A6b 三端齐（Web/CLI/MCP）+ atlas 数字同步（链条见 PLAN-CLAIMS 的 R143 组）。
- **`57f301a6` 全量体检接 admin-api coverage + `--only` 单步重跑**：R142 只接了单端快照 `coverage-snapshot.mjs`，**漏了**全量体检 `health-snapshot.mjs` ⇒ 任何人跑一次全量体检都会把 admin-api step 重写成「无 `coveragePct`」，棘轮立刻红「拿不到覆盖率数据」—— **接线只接了一半**。修法：该步改跑带 coverage 的命令，并**直接 `import`** `scripts/coverage-snapshot.mjs` 的 `ENDS["admin-api"]`（跑法 args / cwd / json-summary 落点 / 选步规则**单一事实源**，**禁止内联第二份命令**：少 ESM 开关 ⇒ 全套件红 `createRequireEsmError`，少内存参数 ⇒ OOM）；`code !== 0` 写 `coveragePct: null`（不伪造、不沿用旧值）。**新增 `--only=<关键字>`**：只重跑 label 命中的步、**其余 step 原样沿用**；与 `--skip-heavy` **互斥 ⇒ exit 2**；0 命中 ⇒ exit 1 并列出可选 step；`--only=metrics` 是历史别名。**真跑** `--only="admin-api 全量（默认环境"` ⇒ exit 0 / **175s** / **92.77** / 8077-8077（此前验证这一步必须跑 30–40 分钟全量）。
- **`4d961b86` CLI `task trigger --consume-next-fire-point`（A6b 残差）**：后端已有、Web（R138 `35238b20`）已有，**CLI 仍无入口** ⇒ 脚本化路径缺失。帮助文案写清「仅 cron（非 cron ⇒ 400）、已有未消耗登记 ⇒ 409、**只跳一次不是暂停**、可与 `--params` 同用」；body **表驱动**「只收显式旗标」⇒ 都不给时仍是单参 `post`、请求体**逐字节一致**。`tasks.ts` 三项度量**正好顶死基线**（1025/997/27.3）⇒ **净零改写**（两处等价折行 + `Partial<>` + filter 表驱动），实测 **1022/996/27.0**，**未调高 ceiling、未用 ALLOW、未删逻辑**。
- **`6a3f02ad` MCP `trigger_task` 支持 `consumeNextFirePoint`（A6b 残差）**：可选 `z.boolean().optional()`；handler **只收显式给出的键**（`=== true` 才加键，`false` 与缺省都不发）⇒ 请求体与 A6b 落地前**逐字节一致**（发 `false` 会让「未传」与「传 false」不再等价）。既有 `tools.test.ts` 三条断言仍绿、该文件 178 条绿；该文件非注释行 2181 **恰在基线顶格** ⇒ 新用例**独立成文件**（8 条，走 SDK **真解析** `z.object(schema).parse(args)`）。**遗留**：400/409 的可读成因未在 MCP 侧映射 ⇒ **只进候选池**。
- **`a70df980` atlas 同步 07-testing 的测试数字**：`node scripts/check-atlas-counts.mjs --update`（守卫自带机械同步入口，**只改数字、不动文字**）：acf-cli 15→**16**、mcp-server 9→**10**（本轮两个新测试文件）；顺带同步 admin-web 285→**291**、admin-api `it/test` 静态计数 7306→**7312**。守卫判据是「文档不许**大幅**撒谎」（±5%），而在 16/10 这种**小分母上容差退化成 ±0 例** ⇒ 新增 1 个测试文件就红（刻意如此）。
- **验证（真实 exit）**：`test:docs` **0** · `size-caps` **0** · `check:guards-wired` **0** · `test:guards:repo` **0（101/101）**；落地侧另有 `check:coverage-floor` **0**（3 端）、selftest **19/19**、`health:snapshot --skip-heavy` **0** 且**三端 pct 跑前跑后全在**（92.77/88.88/87.45）、`acf-cli` **16 文件/458 例 = 0**、`mcp-server` **10 文件/332 例 = 0**、`check:atlas-counts` **0**（12 个数字点）。**反证（均还原）**：① 去掉体检步的 coverage 参数 ⇒ 真跑 162s 后该 step 无 pct ⇒ floor **exit 1「拿不到覆盖率数据」**；② CLI「未传恒发 `false`」⇒ 用例②/②b 双红；③ MCP「缺省恒加 `false`」⇒ 3 条红、「显式 `false` 也发」⇒ 1 条红。
- **链 101 段**（HEAD `a70df980` 实测）：`test:guards:repo` **101/101 = exit 0**（末段仍是 `check:coverage-floor`，**未新增链段**）。**覆盖率棘轮现纳管 3 端**：python **87.45** / node **88.88** / admin-api **92.76**（floor 取观测下界）。
- **§7.0**：主表 **4 → 3 条** —— `coverage-snapshot-vs-full-health` **resolved**（`57f301a6`）并按规则迁入 **A-7 本季收口（R143）**；同组记 3 行：A6b 三端补齐（Web `35238b20` / CLI `4d961b86` / MCP `6a3f02ad`）、atlas 数字同步（`a70df980`）、体检 `--only` 单步通道（`57f301a6`）。**MCP 的「400/409 可读成因未映射」刻意不上主表**（会膨胀主表）⇒ 进状态卡候选池，§7.0 只留指针。
- **下一轮第一步**：**棘轮 per-step 时间戳** —— `--skip-heavy` 会前移 `generatedAt` 但**不重跑全量** ⇒ 数据新但没重测；根治需给 step 记各自时间戳。写域：`scripts/health-snapshot.mjs` + `scripts/check-coverage-floor.mjs` + `scripts/coverage-snapshot.mjs`。判据：`npm run health:snapshot -- --skip-heavy` = 0 且**不误判新鲜度** + `npm run check:coverage-floor` = 0 + selftest 增例。⚠ `generatedAt` 是**文件级日期**，per-step 时间戳需**新增字段**，**不要改 `generatedAt` 的既有语义**。

- **R142（2026-11-07，第 142 轮 · 并行第 72 批 · 台账 writer）**：三处过期事实收口 + F-5「导出定义」控制台入口 + 覆盖率棘轮扩到 admin-api（第三端）（链条见 PLAN-CLAIMS 的 R142 组）。
- **`87251fa6` 三处过期数字收口 + 语言欠账上限收紧**：`docs/deployment.md:775` 写 `@opentelemetry/api ^1.9.1`，实际 `apps/admin-api/package.json:47` 已 `^1.10.0` ⇒ **不再写死版本号**，改为「以 package.json 的声明为准，当前 `^1.10.0`」+ 复核命令（写死新值只是把腐烂点换个位置）；该段既有正确披露（span 尚未出站 / 不引 sdk-*/exporter / 零 import）一字未动。`docs/skills/manifest-contract.md:131` 与 `package.json` 的 `//check:template-manifest` 注释「22 例」→ **23**。`scripts/user-facing-language-baseline.json` 的 `maxKnown` **9 → 8**（= 当前 `known[]` 条目数）。**被否决的提法**：R141 候选池第 5 条「改 `Math.max(prev, len)`」**方向是反的** —— `--update` 在 `keys.length > prevCount && !force` 时**拒绝写盘**，`maxKnown = keys.length` 正是**正确收紧**，`Math.max` 会让上限**永不下降** = 把棘轮废掉 ⇒ 本轮**收紧到实测值**、**不采纳**。
- **`57b9cc54` F-5 任务详情补「导出定义」入口**：后端 `GET /tasks/:id/export` 早已存在（`apps/admin-api/src/modules/task/task.controller.ts:776`，读权限同 `GET /tasks/:id`），CLI（`packages/acf-cli/src/commands/tasks.ts:725/754`）与 MCP（`packages/mcp-server/src/tools/task-operations.ts:55/67`）都有，**控制台 0 命中** ⇒ 「跨环境迁移通道」只有一半能用。定位 = **能力面不一致**，不是文档说谎（`docs/api-reference.md:590` 只写「跨环境迁移通道」）⇒ 不改文档。**只做导出，不做导入**（导入需读本地文件、控制台无场景，且与 CLI 重复）⇒ 导入登记为「**已裁定不做**」。修法：`api/tasks.ts` 的 `exportDefinition` **必须 `responseType:'blob'`**（该端点 `@Res()` 直写附件、**绕过全局信封**）；文件名只在 `Content-Disposition`，共享 client 的响应拦截器把 AxiosResponse 拆成 `res.data`（**头在那层就丢了**）⇒ 用 per-request `transformResponse` **在拦截器之前**把头读进闭包；RFC 6266 两级回退 + `sanitizeExportFilename`（控制字符按**码点**剔除以避免 `no-control-regex`、截 120 字符），头缺失回落 `<task.name>-<UTC 时间戳>.json`。新 `apps/admin-web/src/pages/task-detail/useTaskDefinitionExport.ts`：`inFlightRef` **同步闸门** + `exporting` 界面态；失败走既有 `showApiError`（幂等不双弹）。**不加 `isAdmin` 门控**（读面操作，后端权限同 `GET /tasks/:id`）。体量：`TaskDetailPage` 1034→**1037 / 上限 1039**、最长函数 1012→**1010**；**未调 ceiling、未用 ALLOW**。
- **`176ef68e` 覆盖率棘轮扩到 admin-api（第三端）+ 双 step 选步确定性**：`scripts/coverage-snapshot.mjs` 扩 `--end=admin-api`（真跑 `npx jest --coverage --coverageReporters=json-summary --maxWorkers=2`，**必须 `--maxWorkers=2`** 否则本机 12 worker 被 SIGTERM），读 `coverage/coverage-summary.json` 的 `total.lines.pct` 合并进**默认环境** admin-api step。**双 step 陷阱**：`docs/health-baseline.json` 有**两个**含 admin-api 的 step（默认环境 / `SELFTEST_SKIP_ENV_FILE=1`），旧 `.find` 只取第一个 ⇒ 改为**确定性规则**（label 含 hint 且**不含** `SELFTEST_SKIP_ENV_FILE`）；若只剩 SELFTEST 那步有 pct ⇒ **红**，不许拿错的数据顶替。floor **92.76**（当次真实实测、未取整放宽）+ `maxAgeDays: 14`（与另两端一致）。selftest **13 → 19 例**。**补记（同属 R142 收尾的并行提交 `b409bb17`）** —— `coverage:api` **三次**真跑 **92.76 / 92.77 / 92.77**（148s/175s/150s）⇒ 本端有 **±0.01pt（≈1 条语句）的 run-to-run 抖动**（插桩/收集顺序造成的末位语句归属漂移，**不是测量错误**）⇒ **floor 保持 92.76 = 观测下界**（取 92.77 会让下一次跑出 92.76 时**误红**，比「偶尔提示可上调」更坏）；`docs/health-baseline.json` 记最近一次实测 **92.77**，**是否上调由人决定、不由脚本自动跟涨**。
- **验证（真实 exit）**：`test:docs` **0** · `size-caps` **0** · `check:guards-wired` **0** · `test:guards:repo` **0（101/101）**；落地侧另有 `coverage:api` **0**（lines **92.76%**、148s）、`check:coverage-floor` **0**（比较 **3** 端 / 新鲜度判 3 端）、selftest **19/19**、web 新用例 **5/5** + task-detail-* 回归 6 文件 **23 例 = 0**、`typecheck:web`/`lint:web`/`i18n-key-check`/`check:user-facing-language` 全 **0**。
- **反证（均还原）**：① 去掉 `responseType:'blob'` ⇒ 用例③红；② 去掉 `inFlightRef` ⇒ 用例①红（连点发 2 个请求）；③ admin-api floor 调 99.99 ⇒ exit 1「差 7.23pt」；④ 删默认环境步 pct 只留 SELFTEST ⇒ exit 1「拿不到覆盖率数据」（**未**拿 99.5 顶替）。
- **链 101 段**（HEAD `176ef68e` 实测）：`test:guards:repo` **101/101 = exit 0**（末段仍是 `check:coverage-floor`，**未新增链段**）。**覆盖率棘轮现纳管 3 端**：python **87.45** / node **88.88** / admin-api **92.76**。
- **§7.0**：主表 **3 → 4 条**（新增 `coverage-snapshot-vs-full-health`）。新增那条**不是**旧账，而是 **R142 扩端引入的结构性陷阱** ⇒ 属「当前该做什么」，**进主表**。F-5 与 F-4 此前**不在主表** ⇒ 按「不要往主表加再迁走」，只在 **A-6 本季收口（R142）** 记两行（外加 F-6 导入 = **已裁定不做**）。
- **下一轮第一步**：**health-snapshot 接 admin-api coverage** —— `scripts/health-snapshot.mjs:249` 的 admin-api 默认环境步**仍未带 `--coverage`** ⇒ 将来跑一次**全量体检**会把该 step 重写为「无 `coveragePct`」、棘轮**随即红**。判据：`npm run health:snapshot -- --skip-heavy` = 0 且 admin-api step 的 `coveragePct` 不丢；再跑 `npm run check:coverage-floor` = 0。写域：`scripts/health-snapshot.mjs`（+ 可能的 `docs/health-baseline.*` 由脚本重生成）。

- **R141（2026-11-07，第 141 轮 · 并行第 71 批 · 台账 writer）**：P3-1 指派弹窗错误态误报收口 + F-4 模板导入端点的文档口径收口（链条见 PLAN-CLAIMS 的 R141 组）。
- **`4484efbc` P3-1 SOP 指派弹窗三态**：`openAssign` 先 `setAssignable([])` 再发请求 ⇒ 请求在途 100–300ms 内就渲染「**没有可接指派的执行器——先在桌面端启用 Agent**」；请求失败时该警告**永久**留着（唯一提示是会消失的 toast）、弹窗内无重试、确认键因此**永久置灰** ⇒ 用户卡在「无处可走」的死路。根因 = 把「读取失败」与「读到空列表」压成**同一个信号**（一个数组 + 一条 toast），违反本仓纪律「读取失败 ≠ 数据为空」（同仓 `ExecutorPackagesPage` 已修，本页漏网）。
  修法：新增 `pages/sops/useAssignableExecutors.ts`（三态 `loading｜ready｜error` + `reload()` + `useRaceGuard` 序号守卫，失败时清空候选）、`pages/sops/AssignableExecutorPicker.tsx`（**loading 只给 Spin 不报空态**；**ready 且真空**才渲染 `sops.assignEmpty`；error 用全站既有 `StateError` +「重新加载」；**不复用**空态词条）、`pages/sops/AssignSopModal.tsx`（弹窗外提）；新增词条 `sops.assignLoading` / `sops.assignableError.title` / `.retry`（中英成对）。**确认键 `disabled: !executorId` 保持原样** —— 失败态无可选执行器是**事实**，缺陷在「灰着且无处可走」⇒ 由重试路径解决。体量：`SopsPage` 非注释行 **996→945**、最长函数 **1062→1016**（均低于基线）；4 个新文件各 <90 行、**无需**登记基线；**未调高 ceiling、未用 ALLOW**。
- **`dabf3e10` F-4 模板导入文档收口（纯文档零代码）**：`manifest-contract.md` 写「导入端点本轮未做」，而 `api-reference.md` 的 openapi 生成附录已列出该端点 ⇒ **两份文档自相矛盾**；且「未做」是**过期事实** —— 端点在 `99a6b62e` 就落地（**晚于**建档 `5810367b`）。修法：「未做」节整节改写为「**已落地，但当前没有任何客户端入口**」+ 随端点落地的全部事实（`@WriteGuard` scope=authenticated、审计 `task_template.import` 记 key/version/contentHash/configSource、OpenAPI、生成类型、审计标签、单测）；`:19`「没有第四步」→「第四步已兑现 / 没有第五步」；**新增一节写明「导入官方清单必然 409」**（registry 5 份清单与 seed 5 个官方 key 完全同名 ⇒ **入口即坑**，这也解释了当前**不应**补前端/CLI 入口）；`api-reference.md` **主表**补一行（409/400 边界：**不是** upsert、不覆盖既有行），**附录段逐字节未变**（sha256 前后一致）。附注：`:3` 日期取 **2026-11-06** —— 新鲜度守卫按 **UTC** 取 today（本机 `date -u` = 2026-11-06T21:55Z），写 11-07 会被判「日期在未来」。
- **验证（真实 exit）**：新用例 **4/4**；sops-* 回归 4 文件 **27 例 = 0**；`typecheck:web`/`lint:web`/`i18n-key-check`/`check:user-facing-language`/`size-caps` 全 **0**；文档侧 `test:docs` **0（30/30）**、`check:api-reference` **0（219 路径）**、`check:interface-maps` **0**、`check:template-manifest` **0（23/23）**。
- **反证（均还原）**：把「仅 ready 且真空才渲染空态」改成恒真 ⇒ 用例①②③ 红（1 failed | 3 passed，AssertionError: expected ant-alert-title to be null）；还原 ⇒ 4 passed。
- **链 101 段**（HEAD `dabf3e10` 实测）：`test:guards:repo` **101/101 = exit 0**（末段仍是 `check:coverage-floor`）。
- **§7.0**：主表 **维持 3 条**（`ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops`）—— 本轮关闭的 P3-1 与 F-4 **此前都不在主表**，按规则**不往主表加再迁走**，只在 **A-5 本季收口（R141）** 记两行；**F-5 本轮未做 ⇒ 不进主表**，只进候选池（已带 `文件:行号` 指针）。
- **剩余 backlog**：**F-5 导出定义单入口**（控制台无入口，但**文档并未承诺**控制台入口）；coverage 扩 admin-api（180–310s，**先解双 step 标签**：`docs/health-baseline.json` 里两个含 admin-api 的 step，`.find` 只取第一个）/ web（774s）；棘轮 **per-step 时间戳**（`--skip-heavy` 前移 `generatedAt` 的盲区）；`docs/deployment.md:775` 版本漂移（`^1.9.1` vs 实际 `^1.10.0`）；`check-user-facing-language.mjs --update` 会把 `maxKnown` 下调为 `keys.length`；`manifest-contract.md:131` 写「22 例」实为 23。
- **下一轮第一步**：**F-5 导出定义单入口**（工作量 **M**）—— 改 `apps/admin-web/src/api/tasks.ts`（加 blob 下载，**必须 `responseType:'blob'`**，该端点**不经 envelope**）、`TaskDetailPage.tsx:571` 附近加按钮、新建 `pages/task-detail/useTaskDefinitionExport.ts` 外提、zh/en 各加键、新增 `__tests__/task-detail-export.test.tsx`。**硬约束**：`TaskDetailPage` 实测 **1034 / 上限 1039**、`TaskListPage` **711 / 上限 715** ⇒ **只剩 5 / 4 行余量 ⇒ 必须外提，不许调高 `maxLines`**；判据 = 先红后绿的单测 + `typecheck:web`/`lint:web`/`size-caps`/`test:guards:repo`。

- **R140（2026-11-07，第 140 轮 · 并行第 70 批 · 台账 writer）**：两条 `needs-fix` 收口 —— 覆盖率棘轮补「数据新鲜度」判据 +
  README 一直宣称的 misfire 策略**终于有控件**（链条见 PLAN-CLAIMS 的 R140 组）。
- **`e5aa8e80` 棘轮新鲜度判据**：旧守卫只读 `coveragePct`，而 `generatedAt` 由 `scripts/health-snapshot.mjs:298` 写入却
  **没有任何守卫读它** ⇒ 几周前的旧基线照样判绿；再扩 admin-api（180–310s）/ web（774s）就是 5–13min/端，会逼人复用旧快照。修法：每端可选
  `maxAgeDays`（正整数，粒度=**自然日**，因 `generatedAt` 只有 `YYYY-MM-DD`）——缺失/不可解析 ⇒ 红「无法判断新鲜度」；超期 ⇒ 红并点名过期天数+上限且
  **不再比 floor**（过期数字的高低都没意义）；未声明 ⇒ 不判新鲜度（汇总行印「未声明 K 端」，盲区写进头注）。两端均
  **14 天** + `maxAgeDaysWhy`（下界由 30–40min 全量体检节奏定；`generatedAt` 是**文件级** ⇒ 两端不同窗口只会造「一绿一红」假分歧）。selftest **7 → 13**。
- **`8996b82b` F-2 misfire 控件**：README `:295`/`:830` 与 blockStrategy 并列宣称，但**全前端无控件**（grep 只命中提交白名单）⇒ UI 用户只能拿到库默认
  `ignore`，已渲染的「补偿触发」**永不产生**。`TaskFormTriggerSection.tsx` 在 blockStrategy 后加 Select：**仅 cron/fixed_rate 渲染**（隐藏而非禁用，对齐后端
  `scheduler.service.ts:1300-1306`）、编辑态回填 `?? 'ignore'`、**周期触发下总是显式发有效值**（PATCH 缺省=留旧值）、非周期 `preserve={false}` 缺省不发、
  **全程不发 null**（列 NOT NULL）。顺带删 `web-type-field-drift` 的 `missing:misfireStrategy` **陈旧豁免**（手写类型已跟进 ⇒ 删条目才是收紧）。
- **验证（真实 exit）**：`test:docs` **0** · `size-caps` **0** · `check:guards-wired` **0** · `test:guards:repo` **0（101/101）**；落地侧另有
  `check:coverage-floor` **0**（+ selftest **13/13**）、web 新用例 **5/5** · task-form 系 **167 例 = 0** ·
  `typecheck:web`/`lint:web`/`i18n-key-check`/`check:web-type-field-drift` 全 **0**。**反证（均还原）**：① `generatedAt` 改 2026-10-01 ⇒ exit 1
  「已过期 37 天（上限 14 天）」+「不判覆盖率高低」；② 删某端 `maxAgeDays` ⇒ 不因新鲜度红、exit 0；③ 「仅 cron/fixed_rate」改恒真 ⇒ 用例③④ 红（2 failed | 3 passed）。
- **链 101 段**（HEAD `8996b82b` 实测）：`test:guards:repo` **101/101 = exit 0**；**末段正是 `check:coverage-floor`**（本轮改的就是它）。
- **§7.0**：主表 **5 → 3 条**（`coverage-floor-freshness` / `f-2-misfire-no-ui` 转 `resolved` ⇒ 迁入 **A-4（R140）**，同批在 A-4 记一行陈旧豁免删除）；
  剩 `ci-pg-race-unverified` / `web-flake-not-reproduced` / `release-notice-ops` —— 三条重启条件**都不在自治循环内**。
- **剩余 backlog**：coverage 扩 admin-api（180–310s，**先解双 step 标签**：`docs/health-baseline.json` 里两个含 admin-api 的 step，`.find` 只取第一个）/ web（774s）；棘轮
  **per-step 时间戳**（`--skip-heavy` 前移 `generatedAt` 的盲区）；**P3-1** `SopsPage.tsx:1091` 指派弹窗错误态误报；**F-4** 模板导入端点无入口；**F-5** 任务定义导入导出无控制台入口；
  `docs/deployment.md:775` 版本漂移（`^1.9.1` vs 实际 `^1.10.0`）。
- **下一轮第一步**：**P3-1（`SopsPage.tsx:1091`）** —— 把「可接单执行器读取失败/加载中」误报成「没有可接指派的执行器」并给出错误处置建议；判据 = 一个**先红后绿**的单测 +
  `typecheck:web` / `lint:web` / `size-caps` / `test:guards:repo`。**先查 `scripts/source-size-baseline.json`**：该页若已顶格，按方法学 240 用「等价压缩 + 外提」换行数，**不许调高 ceiling**。

- **R139（2026-11-07，第 139 轮 · 并行第 69 批 · 台账 writer）**：UI P2 三条全部收口 + OTel「traces 已交付」的错误宣称收口 +
  「登记代替修复」这条欠债**真正修掉**（链条见 PLAN-CLAIMS 的 R139 组）。
- **`d7d27f39` OTel 宣称（纯文档）**：README/教程把 traces 当已交付（含 `--profile jaeger`）；实测直接依赖只有 `@opentelemetry/api`、**无
    sdk-*/exporter**，`OTEL_EXPORTER_OTLP` 在 `.ts` **0 命中**，而 `docs/deployment.md:785` 自认「span 未出站」⇒ **Jaeger
    UI 恒空**；修法：区分「profile 可启动」与「span 未出站（仅进程内 `[trace]` 日志）」+ 给升级路径，README.zh/en 走 readme-sync 重生成。
- **`66b87e16` P2-1 三态 + P3-3 rejection + P2-3 后台 SSE**：一个 `length===0` 混表达三态 ⇒ 新增 `useVideoProviders`（三态 +
    重试 + 卸载守卫）/ `ProviderStatusAlert`（失败**不禁用**、带重试）；裸 `validateFields()` ⇒ 全仓最后一个常驻 unhandledRejection 漏点，改
    try/catch；`paused` 恒 false + 无条件 `void connect()` ⇒ 后台标签常驻、白占 32 个 stream 槽位，改 `startsHidden` 不建流。
- **`4c88dac0` P2-2 跨页选中 + P3-2 末页删空 + `Universal` 真中文化**：`selectedIds` 无清空路径 ⇒
    翻页后批量删除**零反馈**、跨页混选时提示与作用域不符；结果集任一变化即清空，删除前空则清空+提示、部分残留**按可见行收窄并告知**；本页清空且 `page>1` ⇒
    **回退上一页**（只按**成功删除**条数算）；`Universal` 走既有 `install.type.*` 词条（基线 known **9→8**、页面 773→678，**未上调**）。
- **验证（真实 exit）**：定向 vitest 21 例 **0** / 38 例 **0**；回归 21 文件 **156 例 =
    0**；`typecheck:web`/`lint:web`/`i18n-key-check`/`size-caps`/`user-facing-language` 全
    **0**；`test:guards:repo` **0（101/101）**；`test:docs` **0**。**反证**：① 红 2 绿 8；② 红 1（`ValidationError` +
    `[ACF][unhandledRejection]`）绿 8；③ 红 2 绿 8；④ P2-2/P3-2 还原 ⇒ **5 条红**（红在「last call `page:1`」）恢复 ⇒ 5/5
    绿。**链 101 段**（HEAD 实测，第 34 段 = `check:user-facing-language`）。
- **并发冲突与裁决**：两个 writer 一度**同时改写** `package-meta.ts` / `ExecutorPackagesPage.tsx` /
    `scripts/user-facing-language-baseline.json` ⇒ 语言守卫**第 34 段**转红（「基线陈旧」）；Lead 裁决「**保留 i18n 方案**」＝**真中文化 >
    登记代替修复**并重新划界。**任务书前提被实测推翻**：任务书写「测试默认英文 locale、push 用例应仍显示 `Universal`」——实测
    `apps/admin-web/src/test-setup.ts:69` **全局钉 `autoflow-lang='zh'`** ⇒ 测试渲染「通用」，断言改为
    `getByText('通用')`（**判据未放宽**，java/shell 反证保留）；英文界面仍 `Universal`。
- **§7.0**：主表 **8 → 5 条**（三条 P2 转 `resolved` 迁入 `§7.0-A` 的 **A-3（R139）**）；**P3-1 未修 ⇒ 只进候选池、不进主表**；F-3
    此前不在主表 ⇒ 只记一行。**下一步**：`f-2-misfire-no-ui`（README 宣称可配但全前端无控件 ⇒ 界面已渲染的「补偿触发」在 UI 用户手里永不产生）——先由 Lead
    裁定「**补控件 vs 收 README 口径**」。

- **R138（2026-11-07，自治优化循环第 138 轮 · 并行第 68 批 · 台账 writer）**：覆盖率棘轮扩到
  executor-node（**并修掉「测量失败仍绿」**）+ A6b「消耗下一个 cron 计划点」前端入口。
  - **`47b63253` 棘轮扩 node**：新增 `scripts/coverage-snapshot.mjs`（`npm run coverage:node`：
    真跑 `jest --coverage --coverageReporters=json-summary`、**先删陈旧 summary**、只取
    `total.lines.pct`、合并进 `docs/health-baseline.json` **既有 node 步**，不重排不丢步）；
    node 步带 `--coverage`；`check-coverage-floor.mjs` 加「`step.code≠0` 或 `signal` 非空 ⇒ 红
    （**pct 不可信**）」+ 跑法按端取 + selftest **4→7** + node floor **88.88**。
  - **`35238b20` A6b 入口**：`api/tasks.ts` trigger 第 4 参（**仅 `=== true` 加键** ⇒ 未勾选逐字节
    不变）；两处弹窗**仅 cron** 渲染、**隐藏而非禁用**（对齐后端 400）；开弹窗重置；文案
    `firePoint.consume.*`；2 文件 **12 例**。
  - **验证（真实 exit）**：`coverage:node` **0**（88.88%）· `check:coverage-floor` **0**（比较 2 端）·
    selftest **7/7** · `test:guards:repo` **0（101/101）** · `size-caps` **0** · vitest 12 例 **0** ·
    `typecheck:web`/`lint:web`/`i18n-key-check` 全 **0** · 既有 17 spec/125 例 **0**。
  - **反证**：floor→`99.99` ⇒ **1**「差 11.11pt」；`code→1` ⇒ **1**「pct 不可信」（**旧实现为绿**）；
    「仅 cron」改恒真 ⇒ 两页用例③各红；删 api 加键 ⇒ 用例③④红。均复原。
  - **链 / 数字**：链 **101 段**（HEAD 实测）；四端沿用上次全量（admin-api **8077/0** · web **2394** ·
    node **1866** · python **1981** cov **87.45%**）；**node coveragePct 88.88 已进基线**
    （`metrics.segments` 100→101，其余未动）。
  - **审计**（报告在 gitignore 的 `artifacts/autonomy/R138/`）：状态卡「三端都没开 `--coverage`」的
    **前提被实测推翻**（配置/阈值/CI 早已存在，真缺口只是快照脚本不传）；另登 F-2~F-5 与
    P2×3 / P3×3；`lint:i18n` **本轮开始前就是红**（存量债，非本轮引入）。
  - **§7.0**：主表 3 → **8 条**（新增 5 条 `needs-fix`）；F-3/F-4/F-5 与 P3 三连进候选池。
  - **下一步**：UI P2 三连（写域 `SopFromVideoPage.tsx` + `ExecutorPackagesPage.tsx` +
    `api/sse-client.ts`；判据 = 先红后绿单测 + `typecheck:web`/`lint:web`/`size-caps`/
    `test:guards:repo`）。

- **R137（2026-11-07，自治优化循环第 137 轮 · 台账补到 R136）**：flaky 观测通道上线 +
  加 CI 片段踩两道守卫 + 两次链红都是「定点断言没跟结构一起改」。
  - **`web-flake-watch`**（`e6c8a8b4` / `7c23f939` / `3100c082`）：**不阻断**
    （`continue-on-error: true`）、仅 `schedule || workflow_dispatch`、web 全量**跑两遍**、
    每轮日志单独存并带 `EXIT_N`、artifact 保留 **14 天**、`meta.txt` 记
    `date`/`head`/`node`/`swap`/`event`；**有意不加 `--retry`**（retry 会把 flake 洗成「看起来稳定」）；
    **cron nightly `'20 3 * * *'`**（月度采样仅 12 样本/年，对偶发 flake 无诊断价值）。
  - **加 CI 片段踩了两道既有守卫**：`check:actions-pinned`（**链第 11 段**，3 处可变引用 ⇒
    固定 **40 位 SHA**，**复用仓内既有引用、不编造**）；`check:runner-labels`（**链第 12 段**，
    `ubuntu-latest` ⇒ **`ubuntu-24.04`**，与仓内 30 处既有写法一致）。⇒ 改 workflow 前先跑这两道。
  - **两次链红都不在代码**：① 状态卡**代码围栏未标语言**（链第 1 段；
    ⇒ **Lead 自己的文件也在门禁里**）；② `06-infra/deployment-and-ci.md` 的 **CI job 数 38→39**
    （链第 24 段）。已补进 `docs/operations.md` 检查单：**⑧ CI job 数** / **⑨ 迁移数双写点**
    （`ADMIN_DOC` + `06-infra:36`，**别改 `03-data`**）/ **通用规则：定点断言要按守卫报错逐个手改，
    `atlas:refresh` 只管量级层**。
  - **健康基线 / 链**：**链 101 段**（第 **101 段** = `check:coverage-floor`）；
    四端数字沿用 R129 全量快照（admin-api 8077/0 · web 2394 · node 1866 · python 1981 cov 87.45%）。
    > ⚠️ 该 101 是**工作树**实测：`check:coverage-floor` 相关文件当时是 **W1 在途未提交**改动，
    > **HEAD 上是 100 段** ⇒ 待 W1 提交后才与 HEAD 一致。
  - **§7.0**：主表仍 **3 条未修**（`ci-pg-race-unverified` / `web-flake-not-reproduced` /
    `release-notice-ops`）；`web-flake` 行补记「已有持续采样通道」，状态不变。
  - **下一步**：`ci-pg-race` 仍 `unverified`（CI 真跑本地无法验证）；flake 转为「等 nightly 采样」；
    发版公告发布属运维。

- **R131（2026-11-07，自治优化循环第 131 轮 · 台账补到 R130）**：全量体检**无退步** +
  体检日期本地化 + 可选依赖守卫扩面。
  - **R129 全量体检**（`0f9c415a`，23m10s、**六步全 exit 0**、`signal` 全 `null`）：
    admin-api **8077 / 0**（suites 473/473，两态同）· web **2394 / 1 skipped** ·
    node **1866 / 13 skipped**（total 1879）· python **1981 / 1 skipped**（cov **87.45%**）·
    **链 100 段** · 迁移 **142**。对比 R118 **无退步**（admin-api +7 是新增用例）：
    web/node/python 持平、链 99→100。swap 达 99.5% 仍未被杀（web 步 `--no-file-parallelism`）。
  - **生成物不手改**：`docs/health-baseline.md` 里手插的「段数滞后说明」被真跑自然消除
    （`grep` = 0）——该文件由脚本整篇重写，快照写真 100 后加注失效；手删会被覆盖且掩盖「99 已过期」。
  - **R130 体检日期本地化**（`1d973a57`）：`toISOString().slice(0,10)` 是 UTC ⇒ UTC+8 凌晨跑会差一天。
    改为 `localDateString(now, timeZone)` 用 `Intl.DateTimeFormat('sv-SE')`（**不用固定时移**，DST 会错）；
    判据 = 12 条行为用例（含 Asia/Shanghai 00:30、NY 冬/夏 00:30）+ **一条接线判据**（源码文本断言，
    **其弱点已就地标注**）。基线头部现已为 **2026-11-07**。
  - **R128 可选依赖守卫扩面**（`dbd42020`）：2 种声明 × 5 种调用形态，selftest **4→7**，
    **扩面后真仓库仍 0 命中**（⇒ 上一版是判据面窄、不是漏抓 bug）；头注**列明 4 条盲区**。
    同批把「定向 `--testPathPatterns` 必须含被改动模块名」写进 `docs/operations.md:1648`。
  - **§7.0**：`adr-038` → **resolved（步骤 1–5 全完成）**；其余四条保持。
  - **下一步**：`execute` 再瘦身需事务设计 ADR；CI 真机 PG race 真跑仍 `unverified`；
    web flake 推进一格；发版公告发布属运维。

- **R127（2026-11-07，自治优化循环第 127 轮 · 台账补到 R126）**：ADR-038 **全流程闭合** +
  一条**类级真 bug**（可选依赖静默 no-op）与其守卫上线，**链 99→100**。
  - **ADR-038（方案 B：广播占坑独立列）已 Accepted（已实现）**：`7c751ca7` 定稿 →
    步骤 1 判据 `5ac4b812`（**J1 量错对象、J2 才是真判据**）→ 步骤 2 加列 `5351e3e5`
    （**`down` 在真库跑过，用「迁移前就存在的行」证明零回填**）→ 步骤 3 写路径 + 两处容量谓词
    改「两列之和」+ J2 转绿 `784b0373`（**J2 首版是假绿，自查后补强**）→ 步骤 4 `a18cde1c`/`a7ed1a3d`
    （**N=3 对账含重复回调**、反向验证红、DTO 不暴露、**剩余风险=只观察不写脚本**，观察项进 ADR §9.1）。
  - **类级真 bug**（`8cb188f3`）：`releaseBroadcastSlot` 依赖**可选** `?:` + **只改调用点没接线** ⇒
    `?.()` **静默 no-op** ⇒ 广播释放从不发生、计数永久泄漏、**测试全绿**。修法=依赖改**必填**
    （漏接线 `TS2345`）。新守卫 `check:optional-dep-silent-noop`（三条件同时命中即红；
    红演示/防误报 logger/规则不自匹配三条防呆都做了实验，真仓库 0 命中）⇒ **链 99→100**。
  - **两处计数滞后**：`atlas` 守卫读 `ADMIN_DOC`（`01-apps/admin-api/README.md`，**不是** `03-data`）；
    `infra-doc-counts` 在 `06-infra/deployment-and-ci.md:36`。
  - **运维文档**：`docs/operations.md:1635` 新增「执行器容量口径：单播 + 广播两列（ADR-038）」。
  - **健康基线**（沿用 R118 全量快照）：admin-api **8070 / 0**（suites 473/473）· web **2394 / 1 skipped** ·
    node **1866 / 13 skipped** · python **1981 / 1 skipped**（cov **87.45%**）· 链 **100 段**。
  - **下一步**：§7.0 未修 4 条 —— `execute` 再瘦身（需事务设计 ADR）· CI 真机 PG race 真跑（`unverified`）·
    web flake（推进一格）· 发版公告发布（运维）。

- **R121（2026-11-06，自治优化循环第 121 轮 · 台账补 R116→R121）**：三本台账补一轮，
  **`r18b` 与 `r18b-harness-model-a` 双双 resolved**（oracle 闭合），**ADR-038 立项**。
  - **R18-B 最终答案**（`bbe9da50`）：那 1/10 违反**既不是产品问题也不是抖动**，而是
    **harness 在失败路径删执行行**造成的记账假象（真 PG 反向对照已证「删行必然破不变量」；
    A 段 10/10 成立、B 段删行必破、C 段广播扇出是设计固有破裂）。dump 实证
    `snapAtStart=0 / claimed=1 / inFlight=1 / finalCount=2`（心跳窗口可见行 > 事后行）。
    修法 = 容量不足**保留行置 `pending`**（对齐生产）+ **区分 `rowsAtSnapshot` 与 `inFlight`**，
    判据用前者、不变量用后者 ⇒ **20 轮 0 违反**；降级缝仍能打红（`R110_STRIP_GREATEST` 6/6、
    `R118_FORCE_LEAST` 4/4）。
  - **ADR-038**（`7c751ca7`，只设计）：广播扇出占坑 vs 心跳下限**同列冲突**；推荐**方案 B**
    （独立列 `broadcastReservedCount`，容量=两列和、心跳下限只管单播行，零用户可见变化、
    与 ADR-037 正交；在线加列 + `DROP COLUMN` 回滚、不设开关）。**步骤 1 判据已定稿**：
    **J2 是真判据**（今日必红），**J1 绿不触发否决**（它量的是计数，缺陷在行数口径）。
  - **慢通道**：`test:heartbeat-race` 挂 CI 的 **needs-env**（链外、15m 超时、无 docker ⇒ SKIP exit 0）；
    主门禁仍 **99 段**。
  - **健康基线（R118 全量重跑）**：admin-api **8070 / 0**（suites 473/473）· web **2394 / 1 skipped** ·
    node **1866 / 13 skipped**（total 1879）· python **1981 / 1 skipped**（cov **87.45%**）· 链 **99 段**。
    对比上次基线 **无退步**（admin-api +16、node +1、web/python 持平）。
  - **下一步**：ADR-038 步骤 1 落地（J2 判据先红→绿）；`execute` 再瘦身需事务设计 ADR；
    CI 真机 PG race 的真跑仍 `unverified`。

- **R116（2026-11-06，自治优化循环第 116 轮 · 台账更新 R104→当前）**：三本台账补齐 R104→R116，
  **`r18b-protocol-heartbeat-dispatch` 从 `blocked` 改为 `resolved`**。
  - **R18-B 链条**（最重要）：`blocked` 约 40 轮 → R106 复现为**活缺陷**（harness 20/20 违反 I1）→
    方案 B 被否（永久饥饿 I2）→ 方案 C **两次证伪**（窗口生产不可达；合并事务反而**打开**该窗口）→
    R108 收敛为**单条原子 UPDATE**（`docs/adr/adr-037-heartbeat-lower-bound-atomic.md`，提交 `8f25b481`；
    共享表达式 `52aa593b`；harness oracle 同源 `80a9d262`）→ R111 §5b 定性
    **生产属模型 B、无残窗、不需要加锁**（`121a7f77`）。
  - **真实遗留**：harness 自身仍用**模型 A**（CTE 同时做计数+1 与插行）⇒ 测的是生产不可达路径；
    需改成「先插行提交、再单独 +1」（已作为 `§7.0` 第 5 条 `r18b-harness-model-a` 登记）。
  - **新守卫**：`check:categories-single-source`（链 96→97）· `check:destructive-global-commands`
    （链 98→99；起因 `docker rm -f acf-r16-*` 杀掉并发实例容器致 1/20 假违反）。
  - **当前健康基线**（`docs/health-baseline.json` 上次快照）：admin-api **8054 / 0**（suites 472/472）·
    web **2394 / 1 skipped** · node **1865 / 13 skipped**（total 1878）· python **1981 / 1 skipped**
    （cov **87.45%**）· 链 **99 段**（按 `&&` 切分实测）。
  - **浮空 rejection**：B1（test 级判红）+ C1（`afterAll` 收窄窗口）已生效，全量 2/2 绿、三口径浮空 0；
    **边界**：jsdom teardown 在所有 hook 之后 ⇒ 仍由 `dangerouslyIgnoreUnhandledErrors` 兜。
  - **两处已知偏差（登记不自改，均在写域外）**：`docs/health-baseline.md` 的「守卫链段数」仍记 **97**
    （实测 99，快照滞后）；`docs/adr/adr-037` 状态行仍写「实现未落地」（R108 已落地，状态行滞后）。
  - **下一步（按 §7.0）**：① harness 改模型 B（第 5 条，needs-fix）；② 事务设计 ADR（`execute` 再瘦身前置）；
    ③ CI 真机 PG race 的**真跑**本地无法验证（`unverified`）。

- **R104（2026-11-06，自治优化循环第 104 轮 · 台账补齐）**：R60–R103 的已结项补进 `docs/PLAN-CLAIMS.md`，`§7` 重算为**当前 5 条真实 backlog**。
  - **当前健康基线**（`docs/health-baseline.json`，R98 全量）：admin-api **8054 passed / 0 failed**（suites 472/472）· web **2394 passed / 1 skipped** · node **1865 / 13 skipped** · python **1981 / 1 skipped**（cov **87.45%**）· 链 **98 段全绿**。
  - **下一步（二选一）**：① 事务设计 ADR（`execute` 再瘦身的前置，步骤 4 已到安全边界）；② 复核 R18-B 的重启条件（协议版本化 + 双写兼容窗口）。
  - **尚未闭环**：CI 真机 PG race 的**真跑**本地无法验证（`unverified`）；发版公告已写，发布动作属运维。

- **R59（2026-11-05，自治优化循环第 59 轮 · 完成 b）**：「加断言必须同步夹具」机检化。
  - **新增**：`scripts/lib/guard-selftest.mjs` 的 **`expectRequiredFixtures()`**（缺失项清单，空=全覆盖）。
  - **接入**：`check-ops-runbook` selftest 新用例（夹具 6 行 vs `REQUIRED_CHECKLIST`）⇒ **7/7**。
  - **判据**：删夹具第③条 ⇒ **exit 1** 点名 `夹具缺必需项「admin-api-full」`；还原 ⇒ **7/7**。**反向验证**：助手改恒真 ⇒ 红用例变绿（有牙）。
  - **未新增守卫** ⇒ 链 **93 段**不变；guards-wired 0。
  - **验证**：docs 0；size-caps 0；guards:repo **0（93 段）**。
  - **下一步第一步**：把助手接入其余 4 个带 `REQUIRED_*` 的守卫，各做一次"删夹具 ⇒ 红"验证。

- **R58（2026-11-05，自治优化循环第 58 轮 · 完成）**：UPGRADING 头部刷新 + sha 可解析守护。
  - **旧基线**：`main=3159ad86`、`develop=e3cb0797`，`git cat-file -e` 均 **exit 0**（缺陷是头部停在 2026-11-02）。
  - **刷新**：头部 → `R58 刷新：2026-11-05，git log -1 --oneline ⇒ 907879f0` + **核实方法** + **覆盖范围**（不夸大），旧基线保留为历史。
  - **守护**：扩展 `check:upgrade-notes`（不新增段，仍 **93**）：头部每个 sha 必须 `git cat-file -e` 可解析；**头部不存在则跳过**（夹具兼容）。
  - **红→绿**：写 `deadbeef` ⇒ **exit 1 点名**；还原 ⇒ **0**；链内同形式 **0**。
  - **踩坑**：加断言后 selftest 正例红（夹具无该头）⇒ 链第 86 段红，已修（R49 同型第二次）。
  - **验证**：docs 0；size-caps 0；guards:repo **0（93 段）**；main-guard 0。
  - **下一步第一步**：把 python 四终态速查表补进 `docs/operations.md`（同步夹具 + 链内同形式验收）。

- **R57（2026-11-05，自治优化循环第 57 轮 · blocked）**：`execute` 第 2 刀（`ToolCallLedger`）**勘察后停手，零代码改动**。
  - **事实**：`persist` 是 `execute` 内闭包（`:365`），**14 处调用**（非立项说的两处），内含 3 条写路径、依赖 `replayApproved`/`sessionId`/`toolCallId`；**不与 consume 共享事务**。
  - **止损**：触发「3+ 处交叉调用需改签名」⇒ 停手；`PLAYBOOK §7-A` 记 `needs-env@8aef4eef` + 三条重启条件。
  - **闸门**：guards:repo **0（93 段）**；size-caps **0**；定向/typecheck/全量未跑（无代码改动）。
  - **下一步第一步**：下一刀必须选**不捕获 per-call 变量**的协作者（R44 的 `boundary.recordOutcome` 就是范例）；或先独立立项做「replay 决策前移」。

- **R56（2026-11-05，自治优化循环第 56 轮 · 完成）**：junitxml `errors` 语义（python 四终态测全）。
  - **XML 事实**：fixture 异常 ⇒ `<error message="failed on setup …">`（exit 1）；collection error ⇒ `<error message="collection failure">`（exit 2）；两者 `testsuite errors="1"`。
  - **collection error 时**：junitxml **仍写出**；python 行**可读**（`errors=1/failed=0/passed=0`，步 exit=2）⇒ 体检器无需修。
  - **反向验证**：把 errors 并进 failed ⇒ `passed=-1`（**判据红**）；还原 ⇒ 绿。
  - **成文**：基线模板新增 errors 语义说明。
  - **验证**：docs 0；size-caps 0；guards:repo **0（93 段）**。
  - **下一步第一步**：把四种终态结论合并成一节速查表写进 `docs/operations.md`。

- **R55（2026-11-05，自治优化循环第 55 轮 · 完成）**：junitxml 的 `skipped` 语义钉住。
  - **XML 事实**：skip ⇒ `<skipped type="pytest.skip"/>`；**xfail ⇒ `<skipped type="pytest.xfail"/>`**（聚合 `tests=1694 / skipped=2`）。
  - **解析**：`readJunit()` ⇒ `passed=1692 / skipped=2`（`passed = tests − failures − errors − skipped`，**不误计**）。
  - **正向/反向**：加探针 ⇒ skipped=2 passed=1692；把 `skipped` 改成常量 0 ⇒ `passed=1694`（**判据红**），还原 ⇒ 绿；删探针 ⇒ skipped=0 passed=1692、`git status` 干净。
  - **成文**：基线模板新增「xfail 计入 skipped」的实测说明。
  - **验证**：docs 0；size-caps 0；guards:repo **0（93 段）**。
  - **下一步第一步**：补一个 `errors` 探针（fixture 里 raise）确认 `errors` 分类，把 python 四种终态全部钉住。

- **R54（2026-11-05，自治优化循环第 54 轮 · flake 已定性）**：`admin-web` 退步项。
  - **复跑**：`npx vitest run` ⇒ `285 files passed` / **2357 passed | 1 skipped (2358)** / **exit 0**（与 R42 一致）。
  - **定性 flake**：复跑即绿 + `git log 62e980be..HEAD -- apps/admin-web` 无提交 + 通过数逐字相同；**不稳定源未定位**（R53 明细被体检器丢弃）。
  - **修复（工具）**：`health-snapshot.mjs` 失败步骤**落盘完整输出**到 `artifacts/health-logs/` ⇒ 下次复发可直接定位；**未加 retry**。
  - **基线**：web 行改回 `exit 0`，依据写在行内。
  - **验证**：guards:repo **0（93 段）**；docs 0；size-caps 0；main-guard 0。
  - **下一步第一步**：下次任一端非 0，先读 `artifacts/health-logs/` 的落盘输出拿失败用例名，再判 flake/真回归。

- **R53（2026-11-05，自治优化循环第 53 轮 · 部分完成）**：改动检查单第⑥条完成；**体检未跑完**（如实）。
  - **第⑥条**：`docs/operations.md` 第 ⑥ 行（`--only <k>` 复现 / R51+R52 真机脚本属**慢通道**不进链）+ `REQUIRED_CHECKLIST` 第 6 条 + **夹具同步**；链内同形式 `npm run check-ops-runbook` **exit 0**（selftest 6/6）；反向验证删第⑥行 ⇒ exit 1 点名。
  - **体检未完成**：日志停在 `全链 guards:repo`，无 `SNAPSHOT=` 行；`health-baseline.json` 里 `parsed=92` 而当前链 93 ⇒ **文件未更新**（硬证据）。→ 不给"有无退步"结论。
  - **退步候选**：本次 `admin-web 全量 … exit 1`（R42 基线 0/2357）⇒ 下轮先诊断它。
  - **验证**：docs 0；size-caps 0；ops-runbook 0；main-guard 0。
  - **下一步第一步**：`cd apps/admin-web && npx vitest run` 抓失败用例名，再重跑 `health:snapshot` 取真实 delta。

- **R52（2026-11-05，自治优化循环第 52 轮 · 三组验证通过）**：真实 PG 验证 rollout claim（部分唯一索引 + 条件 UPDATE）。
  - **索引定义**（逐字）：`migrations/1790000000095-AddRolloutBatchClaim.ts:79-83` `uq_app_deployments_rollout_claim` on `app_deployments("applicationId") WHERE "rolloutBatchClaimId" IS NOT NULL`。
  - **组1**：10/10 恰好一条 affected=1（含 A/B 互换轮）。**组2**：跨批次同 application ⇒ **23505 + 约束名**。**组3**：DROP INDEX 后**两条都成功** ⇒ 索引是唯一防线。
  - **栈**：只起 postgres:16-alpine；autocommit 单语句（沿用 R51 教训，不在事务里 Promise.all）。
  - **未接链**（需 docker）⇒ `needs-env`。
  - **容器**：`acf-r52-pg` 已删，残留 0；历史栈未动。
  - **验证**：typecheck 0；docs 0；size-caps 0；main-guard 0；guards:repo **0（93 段）**。
  - **下一步第一步**：CI 增 postgres service 后，把 R51/R52 两个真机脚本一起接进 `check:race-selftests-wired`（先绿再接、删引用要能红）。

- **R51（2026-11-05，自治优化循环第 51 轮 · 真机验证通过）**：真实 PG 验证审批消费 CAS。
  - **栈**：只起 `postgres:16-alpine`；两条独立 `pg.Client` 跑与 `agent-approvals.service.ts:788` 同形的裸 SQL 条件 UPDATE。
  - **结果**：**10/10** 恰好一条 `affected=1`，输家 `affected=0` 且行状态 `consumed`（= `not_granted`），**无两枚同时可用**。
  - **反向验证**：去掉 `status='granted'` ⇒ **connA=1 connB=1** ⇒ 证明平台真能并发打同一行（非串行假绿）。
  - **踩坑**：首版 `BEGIN` + `Promise.all` 自锁（10 分钟无输出，按作业 id kill）；autocommit 单语句才对。
  - **未接链**（保持 **93 段**）：需 docker/PG，CI 无此环境 ⇒ 记 `needs-env`（重启条件：CI 加 postgres service 或本地慢通道）。
  - **容器**：`acf-r51-pg` 已删，残留 0；`acf-*` 8 个历史栈未动。
  - **验证**：typecheck 0；docs 0；size-caps 0；main-guard 0；guards:repo **0（93 段）**。
  - **下一步第一步**：CI 增加 postgres service 后把该用例接进 `check:race-selftests-wired`（先绿再接、删引用要能红）。

- **R50（2026-11-05，自治优化循环第 50 轮 · 完成）**：矩阵 `--only` 单段复现 + 改动检查单第⑤条。
  - **A**：`--only 88` ⇒ 执行 **1 段**（末行「单段复现模式」）；`--only 999` ⇒ **exit 2** + 越界信息；默认整链 **93 段 / exit 0**；反向验证忽略参数 ⇒ 执行 93 段 ⇒ 判据红。顺带修单段模式下 `executed` 为空导致的误报。
  - **B**：`docs/operations.md` 第⑤条（验收用链内同形式含 `--selftest`）+ `REQUIRED_CHECKLIST` 第 5 条 + **同步自检夹具**；链内同形式 **exit 0**、`--selftest` **6/6**；反向验证删命令形式 ⇒ **exit 1 点名**。
  - **假绿教训**：第⑤条首版只匹配 `/--selftest/`，被说明文字满足；改为双条件 `all:[npm run check:ops-runbook, --selftest]` 才真红。
  - **验证**：guards:repo **0（93 段）**；docs 0；size-caps 0；guards-wired 0。
  - **下一步第一步**：把 `--only` 用法写进改动检查单第 ⑥ 条（单段复现入口）。

- **R49（2026-11-05，自治优化循环第 49 轮 · 根因已定位并修复）**：第 88/93 段「链内红 / 单独绿」。
  - **根因**：链内该段是 `npm run check:ops-runbook`（= `--selftest && 主跑`），R47 验收只跑了主跑 ⇒ 「绿」是假的；R47 新增的「改动检查单」断言**漏同步自检夹具** ⇒ `selftest 1/6` 红（确定性，故两次链内都红）。
  - **修**：只给 fixture 补「改动检查单」小节（判据强度不变）；`--selftest` **6/6**、链内/单独形式均 **exit 0**。
  - **判据**：整链 **exit 0**，末行「解析 93 / 执行 93 / diff 空」，`[88/93] … => exit 0`。
  - **未降级**：无删/跳过/放宽；自检仍 6 条用例。
  - **验证**：docs 0；size-caps 0；guards-wired 0。
  - **下一步第一步**：把「验收某段必须用链内同形式（含 `--selftest`）」写进 `docs/operations.md` 改动检查单第 ⑤ 条，并给矩阵入口加 `--only <k>`。

- **R47（2026-11-05，自治优化循环第 47 轮 · 完成；回归被阻塞）**：**改动检查单**（文档 + 机读守护）。
  - **落点**：`docs/operations.md`「改动检查单」4 行（ci.yml→`check:guards-wired` / executor-node→`digest:regen` / 全量→`--maxWorkers=2` / 链键→先 grep 读者）。
  - **守卫**：**扩展** `check:ops-runbook`（`REQUIRED_CHECKLIST` + `sectionOf("改动检查单")`）⇒ 链段数 **93 不变**。
  - **判据**：红（先加断言、文档缺节）**exit 1** → 绿 **exit 0**；反向验证删第③条 `--maxWorkers=2` ⇒ **exit 1 点名**，还原 ⇒ 0。
  - **阻塞（需 Lead）**：`docs/plan/rounds/AUTONOMY-STATE.md:10` 引用已删除的 `一个已删除的临时探针脚本` ⇒ `test:docs` 裸路径判据红 ⇒ **链在第 1/93 段断**；该文件 Lead 独占，我不改。
  - **验证**：size-caps **0**；ops-runbook **0**；test:docs **1（阻塞）**；guards:repo **1（同因）**。
  - **下一步第一步**：Lead 把 `AUTONOMY-STATE.md:10` 的悬空路径改成描述或放进围栏代码块 → 重跑 `guards:repo` 确认 93/93。

- **R46（2026-11-05，自治优化循环第 46 轮 · 完成）**：**main-guard 守卫**（防 import 触发副作用），链 **92 → 93 段**。
  - **红**：169 个 `.mjs` 中 **5 个**「有 export + 顶层有动作」缺 guard（`inject-openapi-en` / `check-agent-write-sanitize` / `check-credential-columns` / `check-spec-coupling-surfaces` / `gen-vscode-launch`）+ **40 个**无 export 的 CLI 未登记豁免。
  - **绿**：5 个补 guard（业务逻辑未改）+ 豁免清单 `scripts/script-main-guard-exempt.json`（写明"有 export 一律不许豁免"）；守卫 exit 0，selftest 3/3。
  - **反向验证**：注入有 export + 顶层 `process.exit` 的脚本 ⇒ **exit 1 点名**；删除 ⇒ 0。
  - **链**：93 段全跑 exit 0（末行「解析 93 / 执行 93 / diff 空」）；删接线 ⇒ `guards-wired` exit 1 点名；CI step 曾插错位置致**假红**，已修。
  - **验证**：docs 0；size-caps 0；guards-wired 0。
  - **下一步第一步**：把「改 `ci.yml` 后立刻跑 `check:guards-wired`」写进 `docs/operations.md` 的改动检查单。

- **R45（2026-11-05，自治优化循环第 45 轮 · 完成 b）**：python 项反映**通过数** —— 基线最后一块短板补齐。
  - **根因**：`pytest.ini` 的 `addopts` 已含 `-q`，健康脚本又传一个 ⇒ 实际 `-qq` ⇒ 汇总行被压掉（尾部只剩 coverage 表）。
  - **改法（b，零侵入）**：`--junitxml=<tmp>` + 新增 `readJunit()`（匹配带 `tests="N"` 的 `<testsuite>`），临时文件跑完即删；顺带去多余 `-q`。
  - **实测**：python 行 ⇒ `passed=1692 / failed=0 / errors=0 / skipped=0 / total=1692`（与 `1692 passed in 174.65s` 一致）；`collected` 字段消失。
  - **反向验证**：临时 `assert False` 用例 ⇒ XML `{"total":1,"failed":1,"passed":0}` ⇒ 能显示 failure；用例已删、`git status` 干净。
  - **顺手修**：加 main-guard（import 不再触发全量体检 —— 本轮因缺它两次误触）。
  - **验证**：docs 0；size-caps 0；guards:repo **0（92 段）**。
  - **下一步第一步**：加一条轻量检查断言 `scripts/*.mjs` 有 main-guard（防下一次 import 又跑全量）。

- **R44（2026-11-05，自治优化循环第 44 轮 · 完成）**：`execute` 接口化第一刀 —— 抽出 `boundary.recordOutcome` 为 **`OutcomeRecorder`** 接缝。
  - **选中理由**：2 个调用点（`:877`/`:906`）、不参与 `consume` 事务、3 标量参数 + void；`sessions.*`（6+ 处、与审批同段）与 `approvals.consume`（=事务边界）排除。
  - **改动**：新文件 `tool-executor.outcome-recorder.ts` + 类体接缝字段 + 2 处调用改走接缝；**`consume` 区域未动**。
  - **闸门**：定向 **686/686**、typecheck **0**、guards:repo **0（92 段）**、size-caps **0**（`execute` 618 未变；service 871→876、spec 1354→1370，签字含回滚值）、全量 **7956 / 7956**（≥7955/7955）。
  - **接缝测试**：spy 断言失败/成功两条路径都调用 `recordOutcome`（真调用）。
  - **反向验证**：抛异常空实现 ⇒ **exit 1**，红 6 条具名用例（`执行成功：小结果原样回传；recordOutcome(true)` 等）；还原 ⇒ 0。
  - **下一步第一步**：第 2 个协作者**别再碰 `sessions`**（6+ 处且与审批同段）；先把 `persist()` 收敛成 `ToolCallLedger`（只包 `recordToolCall` 一个方法），再谈其它。

- **R43（2026-11-05，自治优化循环第 43 轮 · 部分完成）**：`execute` 拆分第 1 刀（纯段提取）。
  - **拆出**：结果落库载荷整形 → `tool-executor.result-payload.util.ts` 的 `buildPersistedResultPayload(...)`（不碰 DB/事件/状态机；`consume` 区域未动）。
  - **度量**：`execute` **619 → 618**；`tool-executor.service.ts` 非注释行 **871 未上升**；size-caps **无违规**。**只降 1 行是实数字。**
  - **闸门**：定向 **685/685**、typecheck **0**、guards:repo **0（92 段）**、全量默认 **7955 / 开关 7955**（R42 基线 7954/7955 ⇒ 不减少）。
  - **反向验证**：假实现 ⇒ **exit 1（3 failed）**，还原 ⇒ 0。**回滚**：`git revert 45d7a194`。
  - **为什么只一刀**：剩余体积全在耦合调用链（verdict 跨 3 service、两处 persist、超时分支、熔断记账）——"只拆纯段"约束下不可搬。
  - **下一步第一步**：立项做 `execute` 的**接口化**（approvals/sessions/boundary 收敛成 3 个可注入协作者 + 各自单测），再谈缩短主链。

- **R42（2026-11-05，自治优化循环第 42 轮 · 完成/全量）**：健康体检 —— **无退步**。
  - **实测**（≈12 分钟，后台跑，admin-api `--maxWorkers=2`）：admin-api **7954/466**（默认 exit 0）· **7955/466**（开关 exit 0）· web **2357** · node **1514** · python collected **1692** · 全链 **92/92 `diff 空`**。
  - **结论**：四端 exit 0、失败 0、通过数只增、套件 465→466、守卫 92 持平、缺口 0 持平、迁移 141 持平、blocked 仍 1（R18-B）。
  - **记账偏差（已修）**：对比表"上次"里 admin-api 默认 7940 是 R32 实验遗留值（真实基线 7947）⇒ 真实净增 **+7 / +8**。
  - **顺带**：规则⑥ 正向单测已补（`sanitize-secrets.util.spec.ts`，25/25 exit 0）。
  - **验证**：docs 0；size-caps 0；guards:repo **0（92 段）**。
  - **下一步第一步**：把 `health:snapshot` 固定为每 10 轮例行（实证 12 分钟可后台跑完），让"退步"始终有真实 delta。

- **R41（2026-11-05，自治优化循环第 41 轮 · 完成）**：失败路径 `errorMessage` 脱敏。
  - **两侧差异**：结果侧过 `sanitizeSecrets`（`agent-sanitize.util.ts:84` → `common/utils/sanitize-secrets.util.ts` 唯一实现）；失败侧 `err.message` 原样落库（`:883`）并回显模型（`:890`）。
  - **改动**：唯一实现新增规则 ⑥ **连接串内嵌凭据**（短密码 DSN 原本漏网）；`tool-executor.service.ts:835` `safeMsg = sanitizeString(msg)`，两个出口改用。
  - **判据**：红 **exit 1（1 failed/65）**（先卡 Bearer、再卡 `supersecret`）→ 绿 **exit 0（66/66）**；相关回归 **0（709 passed）**；反向验证撤脱敏 ⇒ **exit 1**，恢复 ⇒ 0。
  - **可诊断性**：模型文案保留 `【调用失败】` + 主消息 `upstream 401`，不含明文。
  - **棘轮**：service 871 / functionLines 619；spec 1354 / 455（回滚值已写）。
  - **验证**：定向 0；typecheck 0；docs 0；size-caps 0；guards:repo **0（92 段）**。
  - **下一步第一步**：给规则 ⑥ 补**正向单测**（在 `sanitize-secrets` 自己的 spec 里钉住 `postgres://u:p@h/db → postgres://u:[REDACTED]@h/db`）。

- **R40（2026-11-05，自治优化循环第 40 轮 · 接线完成）**：执行失败提示接到**两个出口**（第 3 次尝试，改用 CodeGraph 结构性锚点）。
  - **anchor**：`execute`(method) :292 起；consume 块 **:709–:781**；**陷阱**：`:780` 是同条件表达式的"审批重放路径"（不调 consume），R39 的字符串锚点因此匹配到 2 处。
  - **改动**：hoist `consumedOneTimeApprovalKey` + 出口① `errorMessage`(:881) 与出口② `【调用失败】`(:886) 拼接 `buildConsumeDenialMessage("execution_failed_after_consume", …)`；未改状态机、未加第二个文案函数。
  - **判据**：红（未接线）**exit 1（1 failed/64）** → 绿 **exit 0（65/65）**；相关回归 **0（156 passed）**；反向验证撤接线 ⇒ **exit 1**，恢复 ⇒ 0。
  - **棘轮**（附回滚值）：service 867→870、functionLines 612→617、spec 1301→1326。
  - **验证**：定向 0；typecheck 0；docs 0；size-caps 0；guards:repo **0（92 段）**。
  - **下一步第一步**：处理「失败路径 `errorMessage` 未脱敏」（与结果侧落库脱敏口径不一致），同样先用 CodeGraph 定锚点。

- **R38（2026-11-05，自治优化循环第 38 轮 · 已补文案）**：I3 裁决落地（`consumed` 不回退 `granted`）+ 失败提示可操作。
  - **旧文案不可操作**：`审批单 <key> 已被另一次调用使用（一张批准单只放行一次）——本次调用未执行。`（`tool-executor.service.ts:683-694`）。
  - **改动**：抽纯函数 `buildConsumeDenialMessage()`（只拼字符串），补「**该授权已消耗，请重新申请审批**」+ `policy_changed` 补「本次调用未执行」。
  - **判据**：红（旧文案）⇒ **exit 1（3 failed）** `Expected substring: "已消耗"` → 绿 ⇒ **exit 0（3/3）**；相关回归 **0（128 passed）**；**反向验证**改回旧文案 ⇒ **exit 1（2 failed）**，还原 ⇒ 0。
  - **§7-A**：`approval-consumed-before-execute` 标 **`已裁定·维持 fail-closed@82e90872`（不再跟踪）**。
  - **验证**：定向 0（128 passed）；typecheck 0；docs 0；size-caps 0；guards:repo **0（92 段）**。
  - **下一步第一步**：把「执行失败（已 consumed）」路径（`failed` 分支）也补同类可操作提示，保持两条失败路径口径一致。

- **R37（2026-11-05，自治优化循环第 37 轮 · 无缺陷仅加判据）**：`agent_approvals` 消费唯一性。
  - **现有防护**：`agent-approvals.service.ts:788-845` 条件 UPDATE（CAS，谓词含 `status='granted'` / `scope='once'` / 策略指纹）；输家经 `explainConsumeFailure()`（`:848-870`）+ 调用方明确 `denied` 文案（`tool-executor.service.ts:670-700`）。
  - **新增判据**：`agent-approvals.spec.ts` +1 条 **R37 并发用例**（有状态 CAS 替身）⇒ 恰好一个赢（I1）+ 输家 `not_granted`（I2）⇒ **25/25 exit 0**。
  - **反证**：把落败分支 `return false;`（`:838`）改 `return true;` ⇒ **exit 1（2 failed/23）** 点名该用例；还原 ⇒ 0。
  - **I3 取舍**：先领单再执行 ⇒ 工具失败不可重试（文档写明的 fail-closed）⇒ 入 §7-A `proposal@ef3a8e9b` **待裁**。
  - **真机降级（如实）**：未起两实例；缺真实 PG 并发 UPDATE 行为验证。
  - **验证**：定向 0；typecheck 0；docs 0；size-caps 0；race-wired 0；guards:repo **0（92 段）**。
  - **下一步第一步**：请 Lead 就 I3 口径表态（`consumed` 是否允许执行失败回退 `granted`）；不改则从 §7-A 标「已裁定·维持 fail-closed」。

- **R36（2026-11-05，自治优化循环第 36 轮 · (C)）**：SSRF 探针可靠性查清 + 口径④工具化。
  - **R33 的 exit 1 不可复现**：`check-ssrf-deny-parity` **3/3 exit 0**、`npm run check:ssrf-parity`（组合 4 条）**exit 0**；且该守卫失败时点名「地址 + 缺在哪侧」、selftest 已有注入差异用例 ⇒ **观测不可复现**（R33 未留输出，无法回溯）。
  - **处置**：不降级、不放宽；结论写入 `PLAYBOOK §7.0` R36 复核说明。
  - **新工具**：`scripts/backlog-stale.mjs` + `npm run backlog:stale`（口径④，**不接链**）；样例 `since=2026-09-26`（40 天）⇒ 出现、恢复 ⇒ 消失（均 exit 0）。
  - **验证**：docs **0**；size-caps **0**；wired **0**；`check:ssrf-parity` **0**；guards:repo **0（92 段）**。
  - **下一步第一步**：`backlog:stale` 纳入每周例行（不接链）；下次再遇守卫红，**先把完整输出落盘**（教训 168）。

- **R35（2026-11-05，自治优化循环第 35 轮 · 完成）**：**主表消费** —— 5 条 `needs-reading` 全判完，主表 **5 → 0**，无真缺陷。
  - **判定**：`diff-card-inline-columns` / `reserved-slots-semantics-vs-inflight` = **仅设计说明**（证据：密列在 web `grep tokenHash` **0 命中**；`executor.service.ts:3287-3297` 配对校验兜住）；`iana-special-purpose-sweep` / `release-path-race` / `running-minus-reserved-drift` = **已被 HEAD 推翻**（`safe-http.util.ts:666-669`、`heartbeat-count.util.ts:21`、`executor-metrics.ts:23`+`ExecutorDetailPage.tsx:342`）。
  - **§7-A**：全部条目补 `since=2026-11-05`（`grep -c` = **76** = 74 + 新入 2，与条目数一致）⇒ 口径④可机械判定。
  - **§7.0 主表**：改为**判定结论表**（条目 0 条 + 5 条处置记录），不是简单的空表。
  - **验证**：docs **0**；size-caps **0**；guards:repo **0（92 段）**。
  - **下一步第一步**：用 `since=` 筛「超 30 天未立项」，命中项标 `stale@sha`（或删并留痕），并写成 npm script（不接链）。

- **R34（2026-11-05，自治优化循环第 34 轮 · 完成）**：**backlog 处置** —— 主表 **82 → 5**，新建 **§7-A 历史建议池**。
  - **数字闭合**：82 = 主表 **5**（`needs-reading@6d991576`）+ §7-A 池 **74**（`proposal` 66 + `needs-env` 8）+ 标废 **3**（R33 已证）。
  - **§7-A**：附录性质、明写「**不逐轮跟踪**」+ 捞回方式（按 id grep）；`needs-env` 8 条**逐条**写了重启条件。
  - **§7.0 主表**：5 条带 `kind@sha`；§7.1–§7.22 旧表整块替换为 22 行「R34 迁移」说明（原句去处 → `artifacts/autonomy/R34/disposal-map.md`）。
  - **反向验证选 (ii)**（不设机读守卫）：纯文档 + 口径连续两轮变 + 中文散文易造假守卫；给出两条可复制的 `node -e` 替代检查（实测 exit 0）。
  - **未做**：口径④「30 天自动入池」需条目先有 `since=YYYY-MM-DD` 字段（当前只有 `@sha`）。
  - **验证**：docs **0**；size-caps **0**（PLAYBOOK 553 行，未变长）；guards:repo **0（92 段）**。
  - **下一步第一步**：给主表 5 条用 CodeGraph 逐条定位 `文件:行号` 出判定，并给 §7-A 条目补 `since=` 以支持口径④。

- **R33（2026-11-05，自治优化循环第 33 轮 · 部分完成）**：backlog 卫生（按 HEAD `1f21e386` 复核 §7.1–§7.22）。
  - **对账闭合**：**82 = 仍成立 7 + 推翻 3 + 无法判定 72**（逐条编号与原句见 `artifacts/autonomy/R33/before.md`）。
  - **推翻 3 条（附命令证据）**：`doc-guard`（`check:metric-docs` 在位 ⇒ exit 0）、`guards-chain-native-accounting`（`test:guards:repo` 指向矩阵 ⇒ exit 0）、`guard-chain-fail-no-segment`（兜底脚本已删 ⇒ `test -f` exit 1）。
  - **72 条 `unverified@1f21e386`**：建议型待裁定 / 需真机 / 需逐条 CodeGraph 追踪 ⇒ 按「无证据不删」**保留原文**（本轮**未删任何条目**）。
  - **PLAYBOOK §7 未新建 section**：只在标题下加一行复核结论 + 3 条推翻行就地标注。
  - **验证**：docs **0**；size-caps **0**；guards:repo **0（92 段）**。
  - **下一步第一步**：按 §7.x 分批复核（每轮 10 条 `unverified`），用 CodeGraph 给 `文件:行号` 判定，直到清零；不要再一次性扫全表。

- **R32（2026-11-05，自治优化循环第 32 轮 · 完成）**：基线可比性。
  - **(a)** `health-snapshot` 自动对比 **`docs/health-baseline.json`**（入库的机器可读基线；md 排版会变、`artifacts/` 会随 clone 消失）；首份写「首份基线，无可比项」+ exit 0；差值核对 `segments 90→92 = +2`、`migrations 139→141 = +2`。
  - **顺带修**：`--skip-heavy` 首版会写空 steps **擦掉 R31 全量** ⇒ 改为**复用上次全量 + 显著标注「沿用上次基线」**。
  - **(b)** pytest 拿不到通过数（本仓不打印 `N passed`）⇒ 基线写 `collected`（收集数）+ **无条件语义标注**，并由 `verifyOutputs()` **断言存在**（删掉 ⇒ exit 1）。
  - **反向验证**：删对比段 ⇒ exit 1；删 python 标注 ⇒ exit 1；恢复 ⇒ exit 0。
  - **验证**：`--skip-heavy` **0**（秒级）；docs **0**；size-caps **0**；guards:repo **0（92 段）**。全量**沿用 R31**（未重跑，已标注）。
  - **下一步第一步**：下一次真跑全量后，基线的步骤行才会产生**真实** delta（本轮步骤行显示「—」是语义正确：没重跑就没有变化）。

- **R31（2026-11-05，自治优化循环第 31 轮 · 完成）**：**全仓健康基线**落地。
  - `scripts/health-snapshot.mjs` + `npm run health:snapshot` → **`docs/health-baseline.md`**（已进 `docs/README.md` 索引；`--skip-heavy` 可秒级重建度量）。
  - **实测**：admin-api 默认 **0**（465/465 suites、**7947 passed**）/ 开关态 **0**（**7947**）· admin-web **0**（**2357**）· executor-node **0**（**1514 / 13 skipped**）· python **0**（collected **1692**、coverage **87.48%**）· 全链 **0**（**92/92**）。度量：段数 92 / 缺口 0 / blocked 1 / 迁移 141。
  - **不进链**（全量 25–35 分钟会毁掉「提交前跑一遍」）；链段数仍 92，`guards-wired` 0。
  - **一致性**：文件与实测逐行一致；python「规模=收集数」与「7947 = R28 的 7946 + R30 新增 1 条」均已在文件内注明。
  - **下一步第一步**：下次跑完 `health:snapshot` 时把「与上次基线对比」表填上（本轮是首份，无上次可比）。

- **R30（2026-11-05，自治优化循环第 30 轮 · 无缺陷仅加判据）**：`rolloutBatchClaimId` 认领唯一性。
  - **现有 CAS**：`app-deployment-rollout.collaborator.ts:600-606` 条件更新 `WHERE "rolloutBatchClaimId" IS NULL`；
    结构底线 = 部分唯一索引；输家出口 `:625-647`（`batches.delete` + `ok:false` + `blockedReason`）；释放 `:894-896` ⇒ **无缺陷**。
  - **补齐**：`app-deployment.rollout-multi-instance.spec.ts` +1 反证用例（CAS `affected=0` ⇒ `ok=false` + 明确 blockedReason + 不调 upgrade + 源码契约「落败必 `batches.delete`」）⇒ **19/19 exit 0**。
  - **反证**：删掉 `IS NULL` 谓词 ⇒ `app-deployment.rollout` 全套 **exit 1（2 failed/65）**，点名既有静态契约两条；还原 ⇒ **0**。
  - **真机**：**未跑（降级，如实）** —— 按立项"第一次跑不动就停"；结构底线已在 DB 层，记为"确定性判据成立、真机未测"。
  - **验证**：定向 0（65 passed）；typecheck 0；docs 0；size-caps 0；guards:repo **0（92 段）**。
  - **一次真红（已修）**：首版让 spec 读实现源码（未登记 `source-text-contracts.json`）⇒ 链第 83 段红；改为只断言可观测输出。
  - **下一步第一步**：若要补真机，复用 R03/R14 harness 跑两实例 N≥10 轮，断言「同批次成功认领 ≤1 + 输家收到 blockedReason + 无批次卡在已认领未执行」。

- **R29（2026-11-05，自治优化循环第 29 轮 · 完成 a）**：**bundle digest 摩擦收口** —— `npm run digest:regen` 一键回填 ①，失败信息直接给命令（第 5 次复发终结）。
  - **诊断**：① `source-digest`=源码语义摘要（**本地可算**）；② 产物字节哈希=**ncc 产物**（`dist/` gitignored ⇒ **只能 CI**）。现成机制只有 `--print`（打印不写回）。**按历史复发 5/5 都是 ①**。
  - **改动**：`--regen`（复用 `digestOf`、只改 `source-digest:` 一行、结构错**拒写**、跑完提示"② 由 CI"）+ 失败信息含 `npm run digest:regen` + `package.json` 加 `digest:regen` + `docs/operations.md` 新增一节（①②对照表 + 5 次复发史）。
  - **判据**：红（旧版，`main.ts` 加一行注释）⇒ **exit 1**、散文处置、无 `digest:regen`；绿 ⇒ **exit 1 且带命令** → 执行 `digest:regen` ⇒ **exit 0**（`951da98a… → 445d219b…`）→ 复检 **0**。
  - **反向验证**：删提示三行 ⇒ `--selftest` **exit 1**（`输出缺少片段 "npm run digest:regen"`）；恢复 **10/10**。
  - **实验改动已全部撤销**（`main.ts` 无改动、清单已复原）。
  - **验证**：guards:repo **0（92 段）**；docs 0；size-caps 0；bundle-drift（干净）0。
  - **下一步第一步**：日常改 `executor-node/src` 后直接 `npm run digest:regen`（已入 `docs/operations.md`）；② 字节哈希继续由 CI 回填。

- **R28（2026-11-05，自治优化循环第 28 轮 · 闭环）**：**admin-api 全量两态实测成功**。
  - **手段**：`--maxWorkers=2` + 后台 + 落盘（默认 12 worker × swap 8G 见底 ⇒ 前两轮被 SIGTERM）；两态各 6–7 分钟。
  - **实测**：默认 ⇒ **465/465 suites、7946/7946 tests、exit 0**；开关态 ⇒ **同 465/465、7946/7946、exit 0**。
  - **与预期 7920 的差异**：R26 那次 4 个 suite failed to load ⇒ 大部分用例没计进 total；本轮它们全部加载通过（R26 的 C1 + R27 的 `count` 替身）⇒ total **7920 → 7946（+26）**，套件总数仍 465（无新增、无跳过）。
  - **SIGTERM 归因**：无内核 OOM 直接证据（dmesg 需 sudo），但证据指向并发度/内存压力（12 worker 两次被杀 vs mw2 跑完 + swap 已满）。
  - **docs**：`docs/operations.md`「量尺」补并发度与两态命令 + 本次实测数字。
  - **验证**：guards:repo **0（92 段）**；docs 0；size-caps 0。
  - **下一步第一步**：把「本机全量用 `--maxWorkers=2`」作为默认习惯（已入文档）；若要根治，属机器资源（swap/内存）而非仓库问题。

- **R27（2026-11-05，自治优化循环第 27 轮 · 部分完成）**：补 `execRepo.count` 替身（R16 遗留）+ 量尺入文档。
  - **根因**：`executor.service.ts:3805-3818` 心跳用 `execRepo.count(...)` 统计在途执行数作下限；该 spec 第 2 个构造形参（`@InjectRepository(TaskExecution)`）只给了 `{ find }` 裸对象。
  - **修法**：复用 security spec 范式 `count: jest.fn().mockResolvedValue(0)`；本夹具无执行行 ⇒ 在途=0 是**业务事实**，19 条断言不改。
  - **判据**：定向 **exit 0（19/19）**；**反向验证**（注释掉替身）⇒ **exit 1**（2 failed）⇒ 未跳过；缺口登记 **1 → 0**，守卫仍 **0**。
  - **docs**：`docs/operations.md`「admin-api 全量测试的量尺」—— 必须 `npm test --`；`npx jest` 打挂 614 suite（与开关无关）。
  - **验证**：guards:repo **0（92 段）**；docs 0；size-caps 0；typecheck 0。
  - **如实**：**全量两态未实测**（两次被 SIGTERM）；可引用 R26 基线 7918/7920，预期 7920/7920。
  - **下一步第一步**：在空闲机器上重跑 `npm test` 与 `SELFTEST_SKIP_ENV_FILE=1 npm test`，确认 7920/7920 并把实测数字补进台账。

- **R26（2026-11-05，自治优化循环第 26 轮 · 部分完成）**：**纠正 R25 的测量假象** + 收敛 C1 批次。
  - **纠错**：R25 的「57 个 spec 依赖 `.env`」来自 `npx jest` —— 该调用在本机把 **614 个 suite** 打挂（`Must use import to load ES Module: @nestjs/common`），**与开关无关**（同 spec：npx 两态红、`npm test --` 51 passed）。正确全量 **7920 例**，真实缺口 **4 suite / 2 tests**。
  - **分类**：C1 = 3（Joi 必填 `DB_PASSWORD` 等）· C2 = 0 · C3 = 0 · 另有 1 项「非环境缺口」（`executor-stale-snapshot-write` 缺 `execRepo.count` 替身，**两态都失败**，R16 遗留）。
  - **收敛**：`apps/admin-api/test/setup-env-file.ts`（开关 + 最小夹具值）+ `jest.setupFiles` ⇒ 3 个 suite 从红转绿。
  - **缺口登记**：`scripts/env-switch-known-gaps.json` **1 → 1（换条目）**；守卫**收紧**为硬要求（必须有 `setupFiles`，不再接受豁免）。
  - **验证**：guards:repo **0（92 段）**；docs 0；size-caps 0；typecheck 0；admin 全量 **1（7918 passed / 2 failed，预存缺口）**。
  - **下一步第一步**：补 `executor-stale-snapshot-write.spec.ts` 的 `execRepo.count` 替身（看清它的 exec 仓库注入方式），消掉最后 2 个失败并删除该缺口条目。

- **R25（2026-11-05，自治优化循环第 25 轮 · 部分完成）**：`SELFTEST_SKIP_ENV_FILE` 默认策略成文 + 守卫（**92 段链**）；**admin-api jest 实测打挂 57 个 spec ⇒ 回滚并登记缺口**。
  - **约定**：`docs/operations.md`「自检环境隔离（SELFTEST_SKIP_ENV_FILE）」三条款；机制 = `hermeticEnv()`（`HERMETIC_ENV` 冻结开关）。
  - **守卫** `check:env-switch-default-policy`（selftest 5/5）：断言约定成文 + python 夹具默认开 + admin jest（setup **或** 登记缺口）+ node 结构化豁免 + 自检脚本按行判定"起应用进程必须经 hermeticEnv"。
  - **真实红**：初跑 6 项，其中 2 项是假阳（判据改"同行既有启动动作又有入口路径"后消失）；收敛后 **exit 0**。
  - **关键发现**：给 admin jest 加 `setupFiles` 后全量 **1846 用例 57 失败** ⇒ 57 个 spec 依赖开发者 `.env`；已回滚并登记 `scripts/env-switch-known-gaps.json`（review_by 2026-12-05，过期即红）。
  - **判据**：红 exit 1 → 绿 exit 0；反向验证（删缺口登记）⇒ exit 1 点名；删接线 ⇒ `guards-wired` exit 1 点名。
  - **验证**：guards:repo **0（92 段）**；guards-wired 0；docs 0；size-caps 0；admin 定向 0；admin 全量对照 1（57 failed）← 缺口依据。web/node/python 全量本轮未重跑（未改其运行代码）。
  - **下一步第一步**：甄别 admin-api 那 57 个依赖 `.env` 的 spec（自带夹具值 vs 真依赖本机环境），收敛后加 `setupFiles` 并删除缺口登记。

- **R24（2026-11-05，自治优化循环第 24 轮）**：**`.env` 读入面四端清扫**（91 段链）。
  - **executor-python 有真运行期入口**：`config.py:142-144` `SettingsConfigDict(env_file='.env')`（pydantic 实例化即读）；本地 `.env` 未入库且含真 admin-api 地址，`conftest` 的 `os.environ.setdefault` **拦不住**（框架先写 `os.environ`）⇒ 加 `config_env_file.py` 三态开关 + `conftest.py` **默认 `=1`**。
  - **admin-web 无运行期入口**（vite 只做构建期注入）⇒ **钉事实**：守卫断言 `apps/admin-web/src` 无 `dotenv`/`parseEnv`。
  - **四端清扫守卫** `check-env-entry-sweep`（selftest 5/5）：链 **90 → 91 段**，`[91/91]` 可见；删接线 ⇒ `guards-wired` exit 1 点名。
  - **判据**：python 红→绿（投毒 `.env` 断言 `exit 1 → 4/4 exit 0`，含【对照】）；web 反向验证（注入运行期 dotenv ⇒ exit 1 点名 → 删除 exit 0）。
  - **验证**：guards:repo **0（91 段）**；guards-wired 0；docs 0；size-caps 0；admin-web 全量 **0（2357 passed）**；python 全量 **0**。
  - **下一步第一步**：按 §7.22 P1 固化「`SELFTEST_SKIP_ENV_FILE` 默认策略」并让守卫断言（自检脚本必须显式传、测试夹具默认开），避免将来新自检忘了传又静默读开发者 `.env`。

- **R23（2026-11-05，自治优化循环第 23 轮）**：**executor-node `.env` hermeticity 收口**（R04 语义覆盖到 node 侧）。
  - **事实**：node 侧 `.env` 加载**只有一处** —— `apps/executor-node/src/main.ts:2-4`（无条件 `dotenv.config`）；测试**恰好**碰不到（jest 排除 `!src/main.ts` + 无 spec 导入 main）⇒ 巧合不是判据。
  - **改动**：新增 `src/config/env-file.ts`（`SELFTEST_SKIP_ENV_FILE` 三态，逐字对齐 admin R04）+ `main.ts` 受开关约束 + 守卫 `check-executor-node-env-hermetic`（四条：加载点唯一/受约束/只认 "1"/测试不导入 main；selftest 5/5）。
  - **判据**：红（helper 临时恒 true）⇒ **2 条红 exit 1**；绿 ⇒ **5/5 exit 0**；核心断言=伪造投毒 `.env` 后进程环境未被污染（含【对照】）。
  - **接链**：`test:guards:chain` **89 → 90 段**，`[90/90]` 可见；删接线 ⇒ `check:guards-wired` **exit 1** 点名。
  - **验证**：guards:repo **0（90 段）**；guards-wired 0；docs 0；size-caps 0；node 全量 **0（1514 passed）**，默认无开关与 `=1` 两态都 0；bundle-drift 0（回填 55→56，②待 CI）。
  - **下一步第一步**：按 §7.21 P3 核查 `apps/admin-web`（vite 注入）与 `apps/executor-python`（`load_dotenv`）是否有同类无约束入口。

- **R22（2026-11-05，自治优化循环第 22 轮）**：**`test:guards:repo` 已指向矩阵入口**（Lead 批准替代 ADR）。
  - `package.json`：新增内部键 **`test:guards:chain`**（原 89 段链，唯一事实源）+ `test:guards:repo` / `:matrix` 均指向 `scripts/guards-repo-matrix.mjs`（**2 插 1 删**，未重排）。
  - **链尾兜底 `guard-chain-fail.mjs` 已退役**（banner 统一）；`test:docs` 的裸路径指针判据抓到 7 处引用 ⇒ 已全部改为"（R22 已退役）"。
  - **必须记住的坑**：换指针会打瞎一切"字符串展开链"的工具 —— `check-guards-wired` 的 `expandNpmScripts` 一度让 79 个守卫全误报"未接线"；修法是展开时把矩阵入口**等价代入** `test:guards:chain`。
  - **判据**：红（第 28 段注入）⇒ **exit 7 + 点名第 28/90 条**；绿 ⇒ **exit 0 + 89 条 `[k/89]`**；等量性 89/89/89 diff 空；反向验证（少跑一条）⇒ exit 1。
  - **验证**：guards:repo 0（89/89）；`:report` 89/89 全过；guards-wired 0；docs 0；size-caps 0；admin 定向 0；`ci.yml` 未改（步骤数不变）。
  - **下一步第一步**：观察一轮真实使用（本地/CI 各跑一次 `test:guards:repo`），确认逐条输出在长日志里可读、无"段号与 `:report` 不一致"的漂移。

- **R21（2026-11-05，自治优化循环第 21 轮 · 换靶落地）**：**守卫框架 meta 改造**（只加可观测性，链结构未动）。
  - 新增 `npm run test:guards:repo:matrix`（`scripts/guards-repo-matrix.mjs`）：**运行期**从 `package.json` 切分 89 段 → `[k/89] <cmd> => exit N` → 失败**点名第 k 条** + **原样 `exit N`** → 跑完**等量性断言**（与**独立重新解析**比对）。
  - **红对比**：同一注入（第 28/90 段 `exit 7`）——旧链 **exit 7 但 `第 k 条` 命中数 = 0（不点名）**；新入口 **exit 7 + 点名**。
  - **绿**：89/89 全 `exit 0`，末行「解析 89 段 / 执行 89 段 / diff 空」。
  - **反向验证**：硬编码少一条 ⇒ **exit 1**（`持有 88 段 / 独立解析 89 段`）。第一次做这条时因"自证自洽"失败，已修并记入教训。
  - **验证**：guards:repo（旧链）0；新入口 0（89/89）；guards-wired 0；docs 0；size-caps 0。`package.json` 仅 +1 行。
  - **下一步第一步**：写状态卡/ADR 决定是否把 `test:guards:repo` **替换**为矩阵入口（并把 `guard-chain-fail.mjs` 的兜底文案换成"第 k 条"），CI 只跑一遍。

- **R20（2026-11-05，自治优化循环第 20 轮 · 止损生效）**：**R18-B 记 blocked**（派发指派根因未收敛），换靶任务已登记未开始。
  - **已确证**：执行行由生产创建（trigger 201 ⇒ `task_executions`=1、`pending`、`executorId=NULL`）；"执行器离线"是夹具缺陷（stale sweep 判 offline，日志实拍），补 10s 保活后稳定 `online` **仍不指派**；日志中**没有**针对本执行的派发尝试。
  - **未确证**：trigger→dispatch 那一跳为什么没落实到本行（候选：outbox/`dispatchedAt`、消费侧 leader、`dispatch-decision-log` 拒绝记录）⇒ 按"根因未明不许动手" + 第 3 次止损 ⇒ **blocked**。
  - **假证据纠正**：R19 的 `hb_ms`（43654/182935ms）含我的轮询等待 ⇒ `claim_at_ms < hb_ms` 恒真；改为先 await 心跳再轮询后：`hb_ms=220/40ms`、`claim_at_ms=5–6ms`（交错真实、对象缺失）。
  - **换靶任务（未开始）**：`scripts/check-guards-wired.mjs:424-425` —— 89 段 `&&` 链改运行期解析/逐条报告/失败点名；判据+反向验证已写进 PLAYBOOK §7.19 P1。
  - **验证**：定向 0；typecheck 0；guards:repo（89 段）0；docs 0；size-caps 0；race-wired 0；reserved-slots 0；guard-harness 16/16。容器残留 0。
  - **下一步第一步**：做 §7.19 P1 换靶（守卫框架 meta 改造）；若中途拿到 §7.19 三条重启条件之一 ⇒ 再回 R18-B。

- **R19（2026-11-05，自治优化循环第 19 轮 · 继续 R18-B）**：**执行行已由生产创建 ✓，但派发未指派 ⇒ 判定仍不可信（第 2 次卡 → 下轮 blocked/换靶）**。
  - **路径 1（真 API）**：登录 JWT → 注册执行器（push 指向本地 stub）→ `POST /api/tasks`（复用 demo-failure-seed 的定义形状）→ `POST /api/tasks/:id/trigger`，四步 200/201/201/201。
  - **达成**：`task_executions` 由**生产代码**插入（计数 1，`status=pending`，`executorId=NULL`）。
  - **卡点**：40s 内 `executorId` 恒 NULL ⇒ 未走 `claimExecutorSlotForExecution`（`executor-dispatch-slot.collaborator.ts:105-118`）⇒ 本执行器在途恒 0 ⇒ I1/I2/I3 不可判定。候选：队列消费未跑 / 缺 `targetExecutorId`·`appId`（`executor.service.ts:4463`）/ 派发段另有闸。
  - **判据**：`inFlight===0` 继续判红（不许假绿）⇒ `--rounds=1` **exit 1**；同时证明「心跳 201 + 交错 `claim_at_ms=6ms < hb_ms=43654ms`」——交错有、行有，**判定对象没有**。
  - **接链**：**未接**（未绿）；「删引用能红」不适用。
  - **验证**：定向 0；typecheck 0；guards:repo（89）0；docs 0；size-caps 0；race-wired 0；reserved-slots 0；guard-harness 16/16。容器残留 0。
  - **下一步第一步**：只读定位三选一 —— 查 `dispatch-decision-log` 与 BullMQ 队列深度，3 分钟即可区分「消费侧没跑 / 选机前置不满足 / 派发闸拦下」；若仍是"指派"卡住 ⇒ **blocked 换靶**。

- **R18（2026-11-05，自治优化循环第 18 轮）**：**A 完成（展示钳底）· B 部分完成（协议层骨架已验、卡点明确）**。
  - **A**：新增纯函数 `apps/admin-web/src/utils/executor-metrics.ts::resolveRunningCount`（`null ⇒ occupied`；否则 `max(occupied - reserved, 0)`）+ `hasMeaningfulReservation`；`ExecutorDetailPage` 两处改用它，**只动展示不动存储**。判据：spec 7/7（含【对照】负数）；helper 临时回退 ⇒ 2 条红 exit 1 → 恢复 7/7 绿；既有「越界」断言按新语义由 `1` 收紧为 `0`（理由写在用例里），页面级 11/11。
  - **B**：`scripts/executor-protocol-layer-race-selftest.mjs`（真 PG/Redis + 真实例 + 真 HTTP）——注册 201、**心跳 10/10 轮 201**、**交错 10/10 被证明**（`claim_at_ms≈5-6ms < hb_ms≈170-220ms`）。**卡点**：占坑必须伴随执行行，SQL 造行被 `task_executions` NOT NULL（`taskId`/`taskName`）+ `tasks` 外键挡住 ⇒ `claimed=0`。**两次尝试后停手**，改为 `claimed===0` 时**主动判红**（不许假绿），当前 exit 1；**不接进绿链**，只留 `npm run test:executor-protocol-layer-race` 诊断入口。
  - **验证**：web tsc 0；admin 定向 523/523；typecheck:api 0；guards:repo（89 段）0；docs 0；size-caps 0（web 861→863）；race-wired 0；reserved-slots 0；guard-harness 16/16。
  - **下一步第一步**：按 §7.17 P1 —— 用真 API 建 application→task 拿到**真实执行行**，再并发心跳，把 B 做完（不要为了绿而放宽 `claimed===0` 判据）。

- **R17（2026-11-05，自治优化循环第 17 轮）**：**`reservedSlots` 无消费点 ⇒ 走「路 B」守卫**（R16 台账 P2 收口）。
  - **事实**：写入 3 类（心跳客户端上报覆盖写 + 两处重启清零）；消费 8 处全是展示/DTO/schema/控制器转发/执行器上报侧，**派发容量面零命中**；实体注释与迁移头注写死「派发闸门绝不读本列」。
  - **选择**：路 B（守卫），因为无消费点 ⇒ 加下限是死代码。
  - **守卫**：`scripts/check-reserved-slots-consumer.mjs` —— 容量面零容忍 + 其它面必须带理由登记 + 写入自洽约束/设计注释不许消失 + **全仓零命中也是红**；接进 `test:guards:repo`（**89 段**）与 CI。
  - **判据**：fixture selftest 6/6；**真实仓库**造假消费点 ⇒ exit 1 点名"容量判定面"，删除 ⇒ exit 0；守卫首跑抓到一处漏登记读者（`misc-2xx-response.dto.ts`，schema-only）。
  - **验证**：定向 523/523；typecheck 0；guards:repo（89）0；docs 0；size-caps 0；race-wired 0；guards-wired 0（79 个 check-* 全被 CI 执行）。
  - **遗留**：① 有人真要用它做容量判断时，需**同时**补在途下限（复用 `resolveHeartbeatRunningTaskCount`），守卫那条要改成"必须引用该纯函数"；② 详情页 `runningTaskCount − reservedSlots` 在 R16 后可能为负，展示层要 clamp。
  - **下一步第一步**：按 §7.16 P2 修展示口径（clamp ≥0 或改用 `runningTaskCount` 为准），顺带补一条展示层单测。

- **R16（2026-11-05，自治优化循环第 16 轮 · 真机并发第 3 轴）**：**心跳覆盖写 vs 派发原子占坑的 lost update（超卖）**，真机两连接 **20/20 轮复现**，已修（无 schema/迁移）。
  - **写语义**：心跳 = **客户端上报值覆盖写**（`executor-heartbeat-report.collaborator.ts:192-210` 只做范围校验；落库 `repo.update({id}, patch)`）；派发 = **原子 `+1` + 容量谓词**（`executor-dispatch-slot.collaborator.ts:105-118`）；释放 = `GREATEST(count-1,0)`（`:238`）。
  - **修法**：落库前取 `max(客户端上报, 服务端在途占坑数)`（非终态执行行 pending/running/waiting），纯函数 `heartbeat-count.util.ts`；不加 CAS（会丢心跳 ⇒ stale sweep 误杀）。
  - **判据**：确定性 spec 5/5（含【对照】复现"朴素覆盖写丢占坑"）；**临时回退 resolver ⇒ 2 条红 exit 1**，恢复 ⇒ 5/5 绿。真机 harness：**现状 20 轮 I1 全违反 exit 1**；`--fixed` **20 轮全绿 exit 0**。
  - **踩坑记录（两个假绿都修了）**：`psql -tAc` 把 `UPDATE 0` 当占坑成功；`spawnSync` 起心跳把并发压成串行。修完立刻从"6/6 假绿"变成"20/20 真红"。
  - **验证**：定向 523/523；typecheck 0；guards:repo（88）0；docs 0；size-caps 0（4446，why 含回落）；race-wired 0（4 条真机用例在链内，删引用能红）。
  - **未做**：全栈（真 HTTP 心跳 + 真调度派发）验收留 §7.15 P1；`reservedSlots` 同族列的下限校验留 P2。
  - **下一步第一步**：按 §7.15 P1 把真机做到全栈（admin-api + 执行器 stub，并发心跳与派发 N≥10 轮），验证协议层不引入新窗口。

- **R15（2026-11-05，自治优化循环第 15 轮）**：**派生密钥运维债收口** —— 手册 + 启动告警 + 机读守卫；**并推翻 ADR-030 §5.4 的错误假设**。
  - **ADR 修正（先改 ADR 再改文档）**：换派生密钥**不会吊销**已签发令牌 —— 校验只用 `bcrypt.compare(出示值, 行上 tokenHash)`（`executor-credentials.collaborator.ts:209/245/297`），从不重新派生。实测：K1≠K2 派生值不同，但旧令牌校验仍 `true`。ADR 新增 **§5.5**：受影响的是**跨实例幂等**与**下次按需轮换**；回调 HMAC 短暂失效至同步新哈希；无数据丢失；**回退可行**（写回旧 K；已轮换的令牌不复活）。
  - **手册**：`docs/operations.md`「轮换 per-executor 令牌派生密钥」（语义/流程：灰度一台→全量→回退/失效半径表/'不要在高峰做'/三条禁止）+ `UPGRADING §14` 交叉引用。
  - **启动告警**：`config/token-derivation-posture.ts`（R06 形状，模块顶层纯函数 + `main.ts` 一次接线）—— 密钥全空 / 回落成 `EXECUTOR_SECRET` 两种静默退化都点名风险并指向手册。
  - **机读守卫**：`scripts/check-ops-runbook.mjs`（`test:guards:repo` 87→**88 段** + CI 步骤）断言「该节存在 + 三要素齐全 + main.ts 真调用 + 告警指向手册 + UPGRADING 交叉引用」。
  - **判据**：fixture selftest 6/6；**真实仓库**删「失效半径」⇒ exit 1 点名、删 `main.ts` 接线 ⇒ exit 1 点名、还原 exit 0；告警 spec 5/5。
  - **验证**：docs 0；guards:repo（88）0；size-caps 0（main.ts 281→284，why 含回落）；typecheck 0；定向 25/25；guards-wired 0。真机 `unverified`（纯文档 + 启动期函数 + 静态守卫，无运行时变更）。
  - **下一步第一步**：按 PLAYBOOK §7.14 P1 执行上线动作（`EXECUTOR_TOKEN_EPOCH_MODE=on`，用新手册的灰度/观察/回退步骤），并把观察项做成只读指标（P2）。

- **R14（2026-11-05，自治优化循环第 14 轮）**：**ADR-030 ②′ 落地** —— per-executor 令牌的**跨实例幂等成立**。
  - **迁移** `1790000000097-AddExecutorTokenRotationEpoch`（`integer NOT NULL DEFAULT 0`，metadata-only 零回填、不建索引）：**在有数据的库上真跑** up（列就位、存量行 epoch=0）→ down（列删、行仍在）→ 再 up（幂等），三次都 exit 0；`check:migrations` 0。
  - **派生 + CAS**：`token = HMAC-SHA256(K, identity‖\0‖startupId‖epoch)`；轮换 = `WHERE "tokenRotationEpoch"=:epoch` 条件更新。**输家**用自算令牌做 `bcrypt.compare` 命中即返回**同一枚**（不落明文）；有界 2 轮后随机兜底（不回调 rotateToken，避免无限递归）。
  - **门控**：`EXECUTOR_TOKEN_EPOCH_MODE` **默认 off** ⇒ 行为逐字节不变（618/618 定向全绿）。
  - **真机**：两实例 mode=on **10 轮 × 4 并发 ⇒ 不同令牌 1、命中 hash 1、exit 0**（I1–I4 全成立）；混跑 A=on/B=off **6 轮 ⇒ 不幂等但不打死令牌**，exit 0。
  - **一次真红（如实）**：首跑两实例全 **500** —— 派生密钥为空抛错，按 ADR §5.4 补「回落 EXECUTOR_SECRET」后转绿；未触及止损线。
  - **守卫连带修复**：语言欠账 / ADR-026 无条件写 / env-drift（`.env.example` 两键）/ 凭据列误判（`tokenRotationEpoch` 登记 not-a-credential）/ atlas 迁移数 140→141 / 体量 4314→4419。
  - **验证**：typecheck 0；guards:repo（87）0；docs 0；size-caps 0；migrations 0；race-wired 0。
  - **下一步第一步**：按 PLAYBOOK §7.13 P1 做**上线动作**（逐实例升级 → 统一置 `on`），并观察 `foreign-rotation` WARN 是否清零；清零后删 R13 过渡告警段、体量回落。

- **R13（2026-11-05，自治优化循环第 13 轮 · ADR 级）**：**ADR-030 落地决策** + **跨实例双轮换症状告警**（不改行为）。
  - **ADR-030**（`docs/adr/adr-030-executor-token-cross-instance-idempotency.md`，Accepted 设计）：三方案对比 —— ① Redis 明文缓存**否决**（挂了就**静默**退回已确诊缺陷 + 凭据明文进中间件）；② 原始「只存 hash + 唯一键」**走不通**（拿不回明文 ⇒ 409 重试会再轮换），**精化 ②′ 采纳**（确定性派生 `HMAC(K, identity‖startupEpoch‖rotationEpoch)` + `tokenRotationEpoch` 列 CAS，失败方**重算出同一枚**再 bcrypt 复核）；③ 单写者 lease **否决**（不解决明文问题，且与 R03/R11 语义互撞）。
  - **必写项**：回滚（revert + `DROP COLUMN`，且不打断在跑执行器）、灰度（混跑新×新幂等/新×旧不幂等 ⇒ 逐实例升级 + `EXECUTOR_TOKEN_EPOCH_MODE` 门）、迁移守规（`1790000000097` / up+down / metadata-only 零回填 / 不建索引）、失效半径量化表。
  - **过渡措施（已交付）**：`classifyTokenCacheMiss()` 三态归因（`verified` / `stale-own-rotation` / `foreign-rotation`），服务层对第三态打 WARN（每身份每 TTL 去重）⇒ 把「跨实例双轮换」从静默变可见。
  - **验证**：admin 定向 **531/531**；typecheck 0；guards:repo（87）0；docs 0；size-caps 0（4288→4314，写明落地后回落）；migrations 0（无迁移）；race-wired 0。**本轮无真机面**（未起容器，残留 0）。
  - **下一步第一步**：按 ADR-030 §5.2/§6 落地 ②′ —— 先写 `1790000000097-AddExecutorTokenRotationEpoch.ts`（up+down + `check:migrations`），再改派生与 CAS，最后起**两实例**跑 N≥10 轮。

- **R12（2026-11-05，自治优化循环第 12 轮 · 执行子代理 · 真机并发第二轴）**：**`issueToken` 的 `(address,startupId)` 幂等在并发下完全失效**，按身份串行化修复；真机用例接链 + 新增接线守卫。
  - **缺陷**：幂等判断是「同步读进程内缓存 → await 轮换」⇒ 并发请求都能在写入前读到 miss，各轮换一次。真机 4 并发 × **6/6 轮都是 4 枚不同令牌**（先返回者拿死令牌 ⇒ 401 ⇒ 再取 ⇒ 又一轮换）。
  - **修法**：新增 `KeyedSerializer`（同 key 串行 / 异 key 并发 / 失败不毒化 / 清空即删键），把「读缓存→复核→轮换→回填」整段包进 `tokenIssueSerializer.run(identityKey, …)`。无 schema / 无迁移 / 返回形状不变。
  - **判据**：真机 `--rounds=6` **exit 1**（红）→ `--rounds=10` **exit 0**（平均不同令牌数 4.00 → **1.00**，I1/I2/I3 全成立）；确定性 spec **6/6**（含**对照**「不加串行器 = 4 次轮换」）。
  - **防腐烂**：两条真机用例接进 `test:guards:selftests`；新增 `check:race-selftests-wired`（离线，挂 `test:guards:repo` + CI）。反向验证：fixture 5/5（四个反例）+ **真实仓库删引用 ⇒ exit 1 点名、还原 ⇒ exit 0**。
  - **验证**：admin 定向 527/527；typecheck 0；guards:repo（87）0；docs 0；size-caps 0（+4 行，why 已写）；guards-wired 0；migrations 0（无迁移）。
  - **容器**：`acf-*` 7 个属本仓 `acf` compose 项目、已跑 31h~5d（**早于本会话 ⇒ 非本轮残留**，卷有真实数据 ⇒ 未动）；`heuristic_solomon`/`metabase`/`flow2api` 非本项目未动；本轮 `acf-r12-*` 已清，残留 0。
  - **下一步第一步**：按 §7.11 P1 立项 **token 幂等的跨实例面**（先写 ADR：Redis 明文缓存 vs 只存哈希+DB 幂等键），这是本轮修复留下的唯一硬边界。

- **R11（2026-11-05，自治优化循环第 11 轮 · 执行子代理 · 换轴到真机并发）**：**执行器注册的「指纹命中」写路径补 install 身份 CAS**，关闭一个**跨写覆盖窗口**；历史担心的**接管 CAS 竞态本身真机未复现**。
  - **真机回归（新建）**：`scripts/executor-register-race-selftest.mjs`（docker PG + 真 admin-api，`npm run test:executor-register-race`），每轮 4 场景 × N 轮，断言 I1 恰好一行 / I2 恰好一个赢家 / I3 行身份=赢家 / I4 赢家可恢复重注册。**未改代码 10 轮 A/B/C：11/11 通过 ⇒ E-1 接管 CAS 真机成立**。
  - **测试自身的两个坑（已修，否则结论会错）**：指纹生成器曾把不同种子塌成同一指纹（假红）；曾断言「输家也能重注册」（与 ADR-017 §5 fail-closed 相悖）。
  - **真正修掉的缺陷**：`register()` 按指纹命中 → 尾部 `update({id})` **无谓词**；并发接管走 `update({id, status: OFFLINE})` CAS 打同一行 ⇒ 接管先提交、回归方旧快照后落库会把身份改回旧安装（接管方令牌失效 ⇒ 401 死循环）。修法 = 谓词改为判定时读到的 `deviceFingerprint`（不钉 status，保 R55-A1 语义）；affected=0 ⇒ 409。
  - **判据**：`executor.register-takeover-cas.spec.ts` 新增 R11 用例（repo 替身在判定与写之间注入并发接管）——未修实现 **register 成功返回且行身份被覆盖（红）**；修后 **409 且身份保持（绿）**。
  - **验证**：真机 10 轮 × 4 场景全绿（13/13，第 6 轮出现反向次序 ⇒ 并发交错真实发生）；admin 定向 521/521；typecheck 0；guards:repo（86）0；docs 0；size-caps 0（`executor.service.ts` +17/+21，why 已写）。
  - **下一步第一步**：按 §7.10 P1 继续换轴压**运行时并发**（下一轴建议 `issueToken` 幂等签发 或 `rolloutBatchClaimId` 的唯一索引 CAS 真机并发）。

- **R10（2026-11-05，自治优化循环第 10 轮 · 执行子代理）**：**把 SSRF 判定的三端对齐从间接保证变成守门判据**（§7.8 P1 收口）。
  - **旧守卫的盲区**：它比的是**地址清单**是否镜像 ⇒ 抓漏项、抓不到「同地址不同判定」。R09 的 `192.0.0.192` 三端清单都有、判定却差一类 ⇒ 旧守卫全绿而该地址四姿态全放行。
  - **新守卫**：输入源 = **契约 `networkPolicy`**（`addresses.*.examples` + `metadataAddresses`），三端探针**真跑**实现导出判定（admin/node 用各自 `ts-node/register`，python 用裸 `python3`）；比**决策轴**（放行/开关放行/恒拒），标签不同但行为相同只提示（当前 4 条）。主机名不进矩阵（三端判在不同层）。豁免清单默认空、须 why≥20 字 + review_by（过期即红）、只覆盖登记的 side。
  - **反向验证**：python 侧注入偏差（元数据判成 `None`）⇒ **exit 1** 且点名 `100.100.100.200`/`192.0.0.192` 的 `python=public`；**还原 ⇒ exit 0**。
  - **接线**：`check:ssrf-parity` 串联旧/新两个守卫 ⇒ `test:guards:repo` 自动覆盖；新守卫 selftest 3/3。
  - **验证**：parity **0**；three-way **0**（selftest 25/25 未变）；protocol-sync **0**；guards:repo（86）**0**；docs **0**；size-caps **0**；upgrade-notes **0**；typecheck **0**；三端单测 admin 75/75、node 40/40、python 全量（见日志）。
  - **下一步第一步**：按 §7.9 P2 扩矩阵到**闸的放行逻辑**（各端导出 allow/deny 矩阵），或统一「主机名分类」接口后把 `localhost` 类纳入矩阵。

- **R09（2026-11-05，自治优化循环第 9 轮 · 执行子代理）**：**Oracle 元数据 `192.0.0.192` 入恒拒表** —— 拒绝清单漏项，四姿态 × 两态此前**全放行**（比 R07 更硬：连开关都不需要）。
  - **IANA 事实（先核后改）**：`192.0.0.0/24` = IETF Protocol Assignments（RFC 6890 §2.1），整段 Source/Destination/Forwardable/Globally Reachable 全 False + 脚注「不更具体登记即不可用」；`192.0.0.192` 不在任何例外里 ⇒ 应拒。段内 5 条合法例外**核对后保持原状**（清单见 `artifacts/autonomy/R09/iana-check.md`）。
  - **修前实测**：三端分类器一致把 192.0.0.192 判 **public**（admin）/ null（node）/ None（python）⇒ 四姿态 webhook-off/on、executor-off/on 全 allow。
  - **改法（复用 R08 机制）**：契约 `metadataAddresses` 增 `192.0.0.192/32`；三端生成物重生成；**分类层**同步收口（admin `classifyAddressRisk` / node `classifyRestrictedIpv4` → `reserved`，ADR-029 §7 说明理由；不新开枚举）。
  - **判据**：红 `npm test -- --testPathPatterns ssrf-deny-matrix` **exit 1**（3 条）→ 绿 **75/75 exit 0**；`check:protocol-three-way` **0**、selftest **24 → 25**（新增【R09 三端覆盖】：metadata 每个地址必须在三端测试里出现）、四向 0 格；`check:ssrf-deny-parity` **0**。
  - **验证**：guards:repo（86 段）0；docs 0；size-caps 0；upgrade-notes 0（UPGRADING §13）；protocol-sync 0；typecheck:api 0；三端单测 admin 75/75、node 40/40、python 全量 0（覆盖 87.46%）。bundle source-digest 已回填（**②字节哈希待 CI**）。
  - **下一步第一步**：把 python 面并入 `check:ssrf-deny-parity`（§7.8 P1 仍在：本轮用三向覆盖判据缓解，parity 守卫本体仍只两端）。

- **R08（2026-11-05，自治优化循环第 8 轮 · 执行子代理；含 recover 收口）**：**落地 R07 裁决方案② —— 契约 `networkPolicy.metadataAddresses`（云元数据地址恒拒），三端同读**。
  - **recover**：开局盘点发现工作区已实质完成（ADR 在、契约段在、三端实现与生成物在）⇒ 选 **(c) 只差验证与台账**，不回滚重做（清单见 `artifacts/autonomy/R08/recover.log`）。
  - **ADR**：`docs/adr/adr-029-metadata-addresses-outbound-deny.md`（05:43 先于代码，含动机/形状/三端同读/影响面/回滚）。
  - **契约**：`protocol.json` 的 `networkPolicy.metadataAddresses = {addresses:["100.100.100.200/32"], enforcement:"deny-before-classification"}`；语义：任何 posture × 任何开关都 DENY、判定先于风险分类、取代文档里对元数据地址的模糊覆盖。**不 bump 协议版本**。
  - **三端同读**：生成器扩为产出 admin/node/python 三份 `protocol-metadata-addresses` 生成物；`check:protocol-sync` diff 路径加入 admin 生成目录。admin 6 处插入点（含 webhook 字面量/解析态、executor/git 的 check、pinned 两处）；node 在**开关早退之前**判定 + 分类器归 `reserved`；python `classify_restricted_address` 先判。
  - **判据**：红 `npm test -- --testPathPatterns ssrf-deny-matrix` **exit 1**（`✕ webhook 姿态：开关开启也拒`）→ 绿 **exit 0（72/72）**；`check:protocol-three-way` **0**、selftest **22→24**、四向 0 格；`check:ssrf-deny-parity` **0**（两端面，python 缺口进 §7.7 P1）。
  - **验证**：guards:repo（86 段）**0**；docs **0**；size-caps **0**；upgrade-notes **0**；protocol-sync **0**；typecheck:api **0**；三端单测 admin 72 / node 38 / **python 全量 0（覆盖 87.46%）**。`check:desktop-bundle-drift` 首次红 → 已回填 `executor-node-bundle.sha256` 的 source-digest（54→55 输入），**②字节哈希待 CI 回填**。
  - **下一步第一步**：按 §7.7 P1 给 `check:ssrf-deny-parity` 补**python 面**（当前只比对两端）；`192.0.0.192` 按 Lead 指示留 R09。

- **R07（2026-11-05，自治优化循环第 7 轮 · 执行子代理，基线 `a316155c`）**：`policy:'webhook'` 面 `restricted` 核契约 —— **契约自相矛盾 ⇒ 停手待裁决（本轮零代码变更）**。
  - **三问结论**：⑴ `protocol.json` 的 `networkPolicy` **只管执行器出站五面**（`$comment` 首句 + 「admin 侧接线不在本批」）⇒ 不覆盖 webhook 面；webhook 面的事实契约是 `docs/deployment.md:197-199` + `docs/api-reference.md:1021` + `safe-http.util.ts:44-52` docstring，都写「放行 loopback/restricted/private-LAN，**云元数据恒拒**」。⑵ node/python **没有** webhook 姿态（只有执行器出站），无参考实现。⑶ admin **不是**"三侧一致中的离群者"：三个姿态里执行器面与 git 面都**恒拒** restricted，**只有 webhook 面随开关放行**。
  - **矛盾（实测）**：`100.100.100.200`（阿里云元数据）⇒ `classifyAddressRisk` 判 **restricted**，而 webhook 姿态放行 restricted ⇒ **开关一开即可达**，与文档「云元数据恒拒」冲突。
  - **附带发现**：`192.0.0.192`（Oracle 元数据）被判 **`public`** ⇒ 全姿态放行（含已对齐的执行器面）——分类器与契约 `reserved` 定义不一致，已登记 §7.6 独立立项。
  - **三方案待裁**：①webhook 面 restricted 恒拒（破 Tailscale，需 UPGRADING）②契约新增 `metadataAddresses` 恒拒（推荐，需改契约）③改文档降级承诺。落点附录已写好在 `artifacts/autonomy/R07/contract-first.md`。
  - **验证（改动为零）**：`check:protocol-three-way` 0（selftest 22/22、四向 0 格）、`test:docs` 0、`check:size-caps` 0、`check:ssrf-parity` 0、`test:guards:repo`（86 段）0。
  - **下一步第一步**：Lead 裁定上述三方案之一；裁定后照 `contract-first.md` 附录直接落地（无需重新探查）。

- **R06（2026-11-05，自治优化循环第 6 轮 · 执行子代理，基线 `610c4b44`）**：**补 R05 的破坏性变更公告** —— 升级段 + 启动期告警 + 升级回归用例（新守卫）。
  - **缺陷**：R05 收口执行器出站姿态后（内网执行器须显式开开关、同机 `127.0.0.1` 恒拒），`docs/UPGRADING.md` §9 仍写「破坏性变更：无」⇒ 存量自托管部署升级后**静默**失去全部派发能力。
  - **症状（实测）**：`status=failed failureReason=script_error errorMessage=…在拒绝名单内…— 已拒绝对外请求`（R05 真机 smoke）；本轮新增启动告警并用 **dist 真跑**捕获到真实那一行。
  - **改动**：`docs/UPGRADING.md` 新增 **§11**（谁受影响 / 症状 / 两条修法 / 自查 / 回滚 `git revert fbd85d26`）+ §9 口径修正；新 `apps/admin-api/src/config/executor-posture.ts` + `main.ts` 模块顶层接线 + spec 4/4；新守卫 `scripts/check-upgrade-notes.mjs`（selftest 6/6）并接入 `test:guards:repo` 与 `ci.yml`。
  - **判据**：红 `node scripts/check-upgrade-notes.mjs` **exit 1**（4 项）→ 绿 `npm run check:upgrade-notes` **exit 0**。
  - **验证**：`test:docs` 0；`test:guards:repo`（86 段）0、1446 ✔；`check:size-caps` 0（`main.ts` +3 已写 why）；`check:guards-wired`/`check:workflow-yaml` 0；`typecheck:api` 0；定向 17 suites/199 tests 0。**未验证**：派发侧真机沿用 R05（本轮未重跑 docker）。
  - **下一步第一步**：发版前刷新 `docs/UPGRADING.md` 头部「核实基线」（仍是 2026-11-02 的 commit）；随后取 §7.5 的 `webhook-posture-cgnat`（同族第二处）。

- **R05（2026-11-05，自治优化循环第 5 轮 · 执行子代理，基线 `6259eaaa`）**：**P1 协议两格 `loopback@on` / `privateIPv4@off` 收口 —— 实现 / 契约 / 真机 smoke 期望 / 四向豁免 四方对齐**。
  - **哪一侧错：实现侧**。`apps/admin-api/src/common/utils/safe-http.util.ts` 的 `allowedExecutor = public | private-lan(恒放行) | (flag && loopback)` 与契约相反（契约：私网需开关、loopback 恒拒）；node/python 与契约一致 ⇒ admin 唯一离群者。**次生错误侧**是真机 smoke 的 B4/B5 期望（把「开关放通 loopback」写死）。
  - **改法**：两处判定改 `public | (flag && private-lan)`；smoke B4/B5 取样地址 loopback → admin 容器**私网 IP**（B4 摘开关重建 / B5 恢复）；`verify-smoke-stack.sh` 与 `docker-compose.yml` 的 admin-api 默认开该开关（拓扑需要，`.env.example` 默认仍 false）；删 allowlist 2 条 5 格并把「空表」规则改**有条件**（零分叉允许空、有分叉仍红 + 两条 selftest）。
  - **判据（红→绿）**：红 `npm test -- --testPathPatterns ssrf-deny-matrix` **exit 1**（3 条新/改用例：默认只放行 public、off 态私网四例全拒、on 态私网放行但 loopback 恒拒）→ 绿 **17/17 exit 0**；`check:protocol-three-way` **exit 0**，selftest **20 → 22**，四向 **5 格不一致 → 0 格**。
  - **验证**：`test:api` 全量 **460 suites / 7,904 exit 0**（首跑抓出 2 个 spec 涟漪并修）；`test:guards:repo`(85) exit 0；`test:docs` / `check:size-caps` / `check:ssrf-parity` / `check:compose-service-env` / `test:env-drift` / `test:compose-sandbox` 全 0。
  - **真机**（docker 26.1.4，实跑 `verify-smoke-stack.sh up` + `verify-smoke-dispatch-push.sh`）：B1–B3 绿；**B4 七条全绿**（私网地址 + 无开关 ⇒ 监听器 0 次 + 「已拒绝对外请求」+ 占坑回滚 6→6）；**B5 八条全绿**（同址 + 开关 ⇒ 1 次 + RUNNING + Bearer/载荷断言）。首跑还修掉脚本自身 3 个缺陷：helper 定义晚于使用、docker 报错被 `2>&1 >/dev/null` 吞掉、`.before5` 未清理。
  - **部署影响（必须让用户看见）**：内网执行器现在**必须**显式 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`；**同机 `127.0.0.1` 执行器不再可用**（契约「打自己回环没有合法拓扑」）⇒ 需在 `docs/UPGRADING.md` 补升级说明（已进 §7.5 P1）。
  - **下一步第一步**：`docs/UPGRADING.md` 补「内网/回环执行器」升级段 + 一条升级回归用例；随后取 §7.5 的 `webhook-posture-cgnat`（与本轮同族的第二处）。

- **R04（2026-11-05，自治优化循环第 4 轮 · 执行子代理，基线 `cfdc9fad`）**：**修掉「自检读开发者本机 `.env`」——让本地全链重新可信**（R03 §7.3 的 P1）。
  - **缺陷**：`apps/admin-api/.env` 在开发态是**符号链接 → 仓库根 `.env`**（gitignored），自检以 `cwd=apps/admin-api` 起 admin-api 子进程 ⇒ 夹具只给 18 个键、另外 **133 个**从开发者环境注入 ⇒ 执行器 `fetchToken`/心跳/回调全 **401** ⇒ `test:pull-dispatch` ④⑤ 红，而 CI 绿 ⇒ 「本机红、CI 绿」。
  - **根因（比 R03 多一层）**：`.env` 有**三个入口** —— ① `apps/admin-api/src/main.ts:31` 的模块级 dotenv preload（W-22，早于 `import app.module`）② `app.module.ts:70` 的 `ConfigModule.forRoot({envFilePath})` ③ `data-source.ts:14` 的 `dotenv.config()`。**只给 ② 加 `ignoreEnvFile` 时套件仍然红**（① 在 Nest 启动前就把 133 键灌进 `process.env`），补 ① 后 10/10 绿但仍剩 1 行注入（③ 的迁移子进程）⇒ 三个入口全关 ⇒ `injected env` **1 → 0**。
  - **改法（开关式，默认关、生产零变化）**：新 `apps/admin-api/src/config/selftest-env.ts`（`SELFTEST_SKIP_ENV_FILE === "1"`）+ 三入口全受同一开关；新 `scripts/lib/selftest-hermetic.mjs`（`hermeticEnv()` / `scanAdminSpawns()` / `readEnvFileValue()`）；8 个起 admin-api 的自检（含迁移子进程）接线；`.env.example` 文档化；`check:guard-harness` +5 条判据（16/16）。
  - **判据（红→绿）**：红 `test:guards:selftests` **exit 1**（`test:pull-dispatch` ④⑤，401 × 37）；绿 同一命令在**有** `.env` 符号链接与**无**该链接两态**均 exit 0**（各 21 套件全 0 失败）。「不许藏起来」四条机读证明：夹具密钥(29)≠开发态密钥(64) 且认证成功 / 单测 4/4 / 接线扫描 8/8（负例句必红）/ 三入口与键名字面量同源。
  - **验证**：`test:guards:selftests` 0/0（两态）；`test:guards:repo`（85 段）0；`test:docs` 0；`check:size-caps` 0（`main.ts` 275→278，why 已写）；`check:guards-wired` 0；`test:env-drift` 0；`check:guard-harness` 16/16；`typecheck:api` 0；定向回归 20 suites / 259 tests 0。**未验证**：docker 真机 `verify-smoke-*` ⇒ `unverified`。
  - **下一步第一步**：取 P1 协议两格 `loopback@on` / `privateIPv4@off`（顺序见 §7.3：先改 `verify-smoke-dispatch-push.sh` 的 B4/B5 取样地址 → 两处判定 → `compose`/`.env` 默认值 → 删豁免两条）。

- **R03（2026-11-05，自治优化循环第 3 轮 · 执行子代理，基线 `eb0ec1fd`）**：**修掉「跨实例灰度批次在创建窗口内被另一实例的周期回收器判死」**（R02 留的 `unverified` 一跑就是它），并归因出「本机 `.env` 污染自检」。
  - **换靶理由**：R02 回执写 `test:guards:selftests` 未跑。本轮首跑 **exit 1**，断在 `test:arch31-rollout` 断言 ③（`终态 rolloutState：failed / 耗时=2s`；另一实例在 `started` 后 **1.1s** 打 `Marked 1 interrupted rollout deployment(s) as failed after restart`）。⇒ 按 Lead 指令「红 = 主靶」，P1 两格顺延。
  - **根因**：`apps/admin-api/src/modules/application/app-deployment-rollout.collaborator.ts:699-706` 批次创建后先排 `scheduleRolloutTick(5s)`，**租约只在 tick 里写**（`:1623`），而回收器（`:1663`，判据 `:1683-1705`，**每实例** 30s 跑）以「同 batchId 任一行 `leasedAt` 新鲜」为存活判据 ⇒ 5s 空窗内一行都没租约 ⇒ 刚创建的批次被**合法**判死（概率 ≈ 5/30 ≈ 17%）。F-9b 上一轮修的是兄弟行，**没覆盖 owner 行自己**。
  - **改法**：创建期**先写租约再排 tick**（函数体 +1 行），解释放方法头注；不调 `ROLLOUT_TICK_MS`/`ROLLOUT_LEASE_GRACE_MS`，不动回收器判据。`scripts/source-size-baseline.json` 该文件 +1/+1（`nonCommentLines 1238→1239`、`functionLines 328→329`）并在 `why` 写明 R03 与回滚方式。
  - **反证**：新增确定性单测「R03：创建即写租约」（把「DB 此刻的真相」喂给回收器，不靠时序运气）——旧码 **exit 1**（`Received: undefined`）→ 新码 rollout 全量 **4 suites/64 tests exit 0**；真机 `npm run test:arch31-rollout` **23 通过/1 失败 → 24 通过/0 失败 exit 0**。
  - **验证**：`typecheck:api` **exit 0**；`test:guards:repo`（85 段）**exit 0**；`check:size-caps` **exit 0**；`test:guards:selftests` 本机 **1**（白点前移到 `test:pull-dispatch`，与本轮无关）/ **移开 `apps/admin-api/.env` 符号链接后 0（21 套件全绿）**。**未验证**：CI 实跑、真机 docker 栈 `verify-smoke-*` ⇒ `unverified`。
  - **⚠️ 给下一个会话的强信号（本地门禁 ≠ CI 的第二种形态）**：`apps/admin-api/.env` 是**符号链接到仓库根 `.env`**（gitignored）。自检给 admin-api 子进程传 `EXECUTOR_SECRET=pull-dispatch-executor-secret`，但 `ConfigModule.forRoot({envFilePath:'.env'})` 经该链接读到**本机** 64 字符的 `EXECUTOR_SECRET` ⇒ 执行器 `fetchToken`/心跳/回调全 **401** ⇒ `test:pull-dispatch` ④⑤ 红。CI 无该链接故绿。⇒ **看到这类红先做「移开 .env 重跑」归因**，别当代码缺陷改（修法见 PLAYBOOK §7.3 P1）。
  - **下一步第一步**：先修 §7.3 的 `selftest-env-hermeticity`（给 `ConfigModule` 加 hermetic 开关 + 自检接线），让本地全链可信；再取 P1 两格（顺序写在 §7.3：B4/B5 取样地址 → 两处判定 → compose/.env 默认值 → 删豁免两条）。

- **R02（2026-11-05，自治优化循环第 2 轮 · 执行子代理，基线 `49345111`）**：**修掉「守卫链断了还在尾巴上打 ✔」，并纠正 R01 的归因**。
  - **缺陷（先纠错）**：R01 记的是「守卫链在失败时报告成功」。实测**只对一半** —— `npm run test:guards:repo` 失败时**退出码一直是正确的 1**，`scripts/docs/check-docs.mjs` 的 `main()` 也确实 `return 1`；坏的是**报告面**：旧 `main()` 按 `CHECKS` 声明顺序逐条打印，失败判据 `orphans` 排第 2，后面 3 条通过的判据继续打 ✔，**没有终态摘要行**；叠加 `test:guards:repo` 是 85 段 `&&` 链（`package.json:110`）⇒ 整链中断时**可见最后 3 行全是 ✔**（✘ 在第 46 行）。**退出码是唯一的真话，而没人读退出码。**
  - **改法（三件，都是加旁路，不动判据口径）**：① `scripts/docs/check-docs.mjs` 报告契约 —— 通过先打、失败后打、**最后一行永远是终态摘要**（`✘ 判据失败：X/Y` / `✔ 判据全过：Y/Y`），并新增 `--root=<dir>` 测试注入面；② 新增 `guard-chain-fail.mjs（R22 已退役）`，`package.json` 链尾挂 `|| node guard-chain-fail.mjs（R22 已退役） $?` —— 任一守卫失败时尾行是 `✘ 守卫链中断（exit N）`，**`$?` 原样传播**（实测中段 exit 9 传到最外层仍是 9），全绿时不执行；③ 新增 `scripts/guards-repo-report.mjs` / `npm run test:guards:repo:report` —— 逐条计数，名单**运行期从 `package.json` 解析**（无第二份名单）。孤儿文档本身：在 `docs/plan/rounds/README.md` 加「自治循环（常设）」表把两篇接上（判据真读的是 `docs/README.md:91 → plan/rounds/README.md` 这条链接链，**不是** `PLAN-CLAIMS.md`）。
  - **反证（成对，先写用例再改实现）**：3 条 CLI 黑盒用例（失败时尾行必须是 ✘ / ✘ 之后不许再有 ✔ / 全绿时尾行必须是 ✔ 这个**正例控制组**）在旧代码上 → `node scripts/docs/check-docs.selftest.mjs` **exit 1，33 通过 / 3 失败**；改完 → **exit 0，36/36**。链面两条：临时放孤儿文档 ⇒ `test:guards:repo` **exit 1** 且尾行是 ✘ 横幅；临时把第 2 段换成 `process.exit(9)` ⇒ 链 **exit 9**、尾行仍是 ✘（证明不是「第一步红」特例）。
  - **验证**：`test:docs` **exit 0**；`test:guards:repo` **exit 0**（85 段全跑）；`test:guards:repo:report --all` **exit 0**，**85/85 `[exit 0]`**；`check:guards-wired`（+selftest 28/28）exit 0；`check:size-caps` exit 0（基线 98 未动）。**R02 的 `unverified` 已由 R03 补齐**：`test:guards:selftests` 首跑 **exit 1**（红在 `test:arch31-rollout` 断言 ③，跨实例灰度被另一实例回收器判死；**非 R02 引入**），修复见下方 R03 快照。
  - **刻意不做**：不把链换成执行器 —— `scripts/check-guards-wired.mjs:424-425` 靠展开 `test:guards` 的**字符串**判定「自检有没有接线」，换成执行器会让 74 个守卫的自检面全盲 ⇒ 判据③ 假红。⇒ 进 PLAYBOOK §7.2（P2，meta-守卫改造）。
  - **下一步第一步**：取 R01 遗留的 P1 `loopback@on` / `privateIPv4@off` 两格（需 `compose`/`.env` 默认值 + 真机 B4/B5 同批）；或先做 §7.2 的 `guards-chain-native-accounting`（要先改造 `check-guards-wired` 的展开面）。

- **R01（2026-11-05，自治优化循环第 1 轮 · 执行子代理，基线 `a88b0831`）**：**修掉「执行器开关一开就能打 CGNAT 段里的云元数据」**。
  - **缺陷**：`apps/admin-api/src/common/utils/safe-http.util.ts:95-98`（`allowedExecutor`）与 `:836-841`（`assertSafeExecutorUrl.check`）把 `restricted` 档（CGNAT `100.64/10` + RFC2544 `198.18/15`）放在"开关开启才放行"组里；契约 `networkPolicy.addresses.cgnat.allowedUnderPrivateNetwork=false`，node/python 两态都拒 ⇒ admin 是唯一离群者（第十三轮四向检查 `grid:cgnat@on:admin` 登记在豁免账里）。`100.64/10` 含阿里云元数据 `100.100.100.200`，且 `::ffff:100.64.0.1` 折回 IPv4 后同档 ⇒ dispatch / broadcast / reload-config / package push 四条出站面可打元数据端点。
  - **改法**：`restricted` 从**执行器姿态**的开关解锁组摘出（两处判定），开关只剩 loopback 一个效果。刻意不新增 `AddressRisk` 成员（198.18/15 属 IANA special-purpose，契约 `reserved` 口径同样恒拒）；刻意不动 `policy:"webhook"` 姿态（契约不管这条面）⇒ 已进 PLAYBOOK §7.1。
  - **豁免同批销账**：改完实现后 `check-protocol-three-way` 当场红（`豁免腐烂（1 格）grid:cgnat@on:admin`）⇒ 删条目 `admin-cgnat-grouped-into-restricted` ⇒ 复跑 exit 0（登记格 6 → 5，逐格不一致 3 → 2）。顺手把该 JSON 的 `$comment` 陈腐统计改成「当前 4 逐格 + 3 向量」+ 新增 **✄ 已销账（勿重新登记）** 一节。
  - **验证**：`safe-http.util.spec` + `ssrf-deny-matrix.spec` 由 **3 红/63 绿 → 66/66 绿**（先红后绿，红的三条正是被翻转的三条）；`test:api` **459 suites / 7,896 tests exit 0**；`typecheck:api` exit 0；`check:protocol-three-way` 主跑 exit 0 + selftest 20/20；`check:size-caps` / `check:ssrf-deny-parity` exit 0；**84 个守卫逐个实跑全 exit 0**。**未验证**：真机 `r5-dispatch*`（需 docker）⇒ `unverified`。
  - **⚠️ 给下一个会话的强信号**：`npm run test:guards:repo` 目前**整链在第一步就停** —— `test:docs` 的"孤儿文档"判据红在 `docs/plan/rounds/AUTONOMY-{LOOP,STATE}.md`（没被索引引用），后面 84 个守卫**一个都没跑**，而尾部仍打印 4 个 ✔。修复落点在 `docs/**`（Lead 写域）。**别把尾部绿色当成"守卫全绿"。**
  - **下一步第一步**：修 `test:docs` 的孤儿文档（或把 `test:docs` 移出 `&&` 链），再取 `loopback@on` / `privateIPv4@off` 两格（需 compose/.env 默认值 + 真机 B4/B5 同批）。

- **本轮（2026-11-02 文档治理续，develop）**：两件，都属「把规范变成判据」而非再写一遍规范。
  - **① 新鲜度判据升级**：`check-doc-style` 此前只判「文件里有没有『最后核对』这四个字」——于是 `2026-09`（月粒度）与「正文提到这个词」都能过。现要求**标记行必须带到日的 `YYYY-MM-DD`**，并拒绝未来日期与非日历日；同时把 `docs/atlas/**`（131 篇）按**目录级**纳入（扫描面下界 100，目录被改名/搬空即结构红）。**围栏感知**：只写在代码块里的「示例日期」不算声明（否则模板会把判据洗绿）。自检 18 → **28/28**。
  - **改前红 → 改后绿**：新判据首跑实测红 **5 篇**（4 篇 `2026-09` 月粒度 + `atlas/README.md` 只有正文提及）。4 篇按**排除批量规范化提交 `a6d7c4ea` 后的真实内容提交日**改为「最后更新」（`agent.md`→11-01、`ai.md`→10-28、`sop.md`→10-19、`executor-desktop/agent.md`→10-28），**不伪造核对日**；`atlas/README.md` 补文首标记。
  - **② `PLAN-CLAIMS.md` 3420 → 817 行**：860–3420 的历史轮次/里程碑/审计叙事按轮次边界迁到 `docs/plan/rounds/`（8 篇 + 索引），单篇 65–584 行，**正文逐字节保留**（校验：8 块逐行 diff，除审计轮文件的 5 处相对链接按新位置重写为 `../../archive/…` 外零差异）。**迁移时间戳分配表刻意不迁**：`check-migrations` 与 6 个迁移结构 spec 直接读本文件那一段，迁了 CI 立刻红。
  - **验证**：`test:docs`（check-docs 5 项 + doc-style 3 判据 + 自检 28/28）、`check:atlas-counts` / `check:interface-maps` / `check:infra-doc-counts` / `check:sdk-docs-truthfulness` / `check:guards-wired` / `check:migrations`（138 行全注册）/ `check:release-config` / `check:desktop-rollback-path` 全 exit 0。
  - **如实**：`deploy/frp/frpc.toml` 与品牌资产（SVG/PNG/图标 + `scripts/brand/*`）是并行工作流的未提交改动，本轮未纳入；`main` 仍未镜像 develop（两篇冲突文件留待发布合并）。

- **本轮（2026-10-31 OSS 对照调研首轮 → 五项落地，main）**：
  - **背景**：对 `open_sourse/` 下 10 个开源项目（codex / opencode / openclaw / hermes-agent / paperclip / claude-mem / cc-switch / claude-code / claw-code / awesome-llm-apps）做了五段流水线：单项目调研 → **对抗式复核**（逐条打开被引用代码证伪/证实，并核「我方缺口是否成立」）→ 横切切片 → **反方论证** → 优先级收敛。产物全在 `open_sourse/agent_talk/`（三级目录 + 采纳判据 + 实施顺序）。
  - **最重要的产出是「推翻了什么」**：对抗式复核排掉 **6 条假缺口**（Node 执行器无沙箱 / 缺执行期 claim / 无 token 预算 / 缺 `X-Accel-Buffering` / 工具调用无批内并发 `READ_TOOL_CONCURRENCY=4` / 缺能力收窄 `getAgentCapabilities` 租约 fail-closed——这些我们本来就有），反方论证另**否决 2 条**（命令前缀 DSL 在我方**没有 argv 载体**；审计「入队 vs 落盘」我们本就无队列）。照单全收会造成 8 处重复造轮子。
  - **本批交付 `db125558`（五项）**：① **可执行代码源准入门**（最高危真实缺陷：自动化会话经 `create_task_from_template.overrides` 零审批把 `glueSource` 送到执行器；新增第⑦道闸 + `DenyReason.executable_source_in_automation` + `effectBound` 必填）② **沙箱内存上限次序守卫**（**上工即抓出 4 处真实反转**：容器 1G vs 任务 2048MB，含 staging；修正为 768/512，与 staging 既有「内存上限成组下调」模式同构）③ **SOP 正文供应链扫描**（安装诱饵 / 远程脚本直入 shell / 凭据×外发；publish 在写版本行前裁决，默认 `warn`）④ **折叠摘要带 `toolCallId`** + 「截断不切半截 id」硬化 ⑤ **环境类失败不烧重试预算**（**规格前提被实施证据修正**：回调上报的失败本就终态不重试，门禁只在派发路径可达；修正已回写 S4 切片）。
  - **验证**：admin-api 全量 **395 套件 / 6907 例全绿**；`npm run test:guards:repo` 全链 **exit 0**（含新接线：47 个 `check-*.mjs` 全部被 CI 与本地执行）；两个新守卫自检 16/16 与 14/14；`check:atlas-counts` / `check:metric-docs` / `tsc` / `eslint` 全绿。
  - **进行中**：provider 密钥走 SEC-02 信封（S1-C4）、部署验证失败自动回滚（S6-6-2）、`agent_tool_calls.stateChangedAt` + `appendStep` 终态谓词（S3-C2，迁移 **1790000000083** 已在 `PLAN-CLAIMS.md` 登记）、admin-web 手写类型棘轮（S3-C3）。
  - **下轮入口**：`docs/ROADMAP.md` 的「对照调研批次」表 + `docs/PLAN-CLAIMS.md` 的「OSS 对照调研批次」段是**本批的唯一索引**（每条都指向 `agent_talk/` 里带 `file:line` 的候选）。待做最高优先：**S3-C5 `recoverStaleExecutions` 的「不得覆盖更新工作」护栏**（P0/数据丢失档，依赖 S3-C2 终态语义）。
  - **两个待你拍板/知悉**：① **容器路径任务内存上限 2048 → 768MB** 是产品级权衡（见 `OPEN-DECISIONS.md` A4，一行可回退）；② 实施 agent 主动上报了它**未**覆盖的旁路（`trigger_task.params`、`overrides` 顶层 `applicationId`、`deploy` 的 `env`），已登记为后续候选。

- **本轮（2026-10-31 事实核查轮 → 决策/计划文档与代码对齐，main）**：
  - **背景**：本仓的「OSS 对照调研」会话（产物在 `/home/yongsheng/project/open_sourse/agent_talk/`）在核对开源项目时意外发现——**本仓自己的决策文档已经偏离代码**，且偏离方向是「把已做完的事写成待办」⇒ 会让后续会话返工。于是对 `OPEN-DECISIONS.md` / `ROADMAP.md` / `PLAN-CLAIMS.md` / 本文件逐条做了事实核查（283 行报告：`agent_talk/02_cross_analysis/02-acf-docs-vs-code-audit.md`）。
  - **本批已修（全部带双向证据：文档原话 + 代码 file:line）**：
    - `OPEN-DECISIONS.md` **D8 整条与代码相反**——原文写「审批只有申请没有批准、`markWaiting()` 生产零调用方 ⇒ 5 个 approvalRequired 工具永久不可执行」；实际已闭环（独立实体 + 条件写 grant/deny + 一次性 consume + 7 天 TTL + 四眼原则），6 个提交 `1b4d799d/d249b5c2/e23125b5/26d1751c/2ebe3da3/31f15a43`。**整条移入「已结案」并附证据链**。
    - `OPEN-DECISIONS.md` **D7 现状过期**——桶键已由 per-IP 名额表封顶（`executor-aware-throttler.guard.ts:240-252`，提交 `b683ae3a`），原「换个头就得到全新桶、速率无上限」不成立；保留原文并就地标注，残留仅「12000/min 需真机压测」。
    - `OPEN-DECISIONS.md` **A3 自我矛盾**——「缺 `executor online` 逆操作是真实缺口」被同文件 D7-2 实测否决（心跳/注册无条件置回 ONLINE），改为「已被 D7-2 否决，不再列为待办」。
    - `OPEN-DECISIONS.md` **D4 计数错**（66 → 实测 **73**，`error-code-coverage.test.ts:35` 的 `UNCLASSIFIED_BASELINE`）、**A2 版本锚点错**（「落后 1.15.x 十余个 minor」→ 实际主线已 **2.0.0**）。
    - `ROADMAP.md:56` **把已交付能力写成缺口**——「还缺中台 SOP 指派/审批」；实际 `sop.controller.ts:423 @Post(":id/assign")` + `:280 assignable-executors` + `SopsPage` 指派 Tab 均已存在，剩余只有 Windows 真机。
  - **验证**：`npm run test:docs` → 自检 30/30 + 死链/孤儿/根目录/裸路径/三语切片 5 项全绿；`node scripts/check-sdk-docs-truthfulness.mjs` → 10/10 + 主跑通过。
  - **顺带发现的未修项（非文档类，留给后续拍板）**：根 `package.json` 版本 `1.11.0` 落后 `version.txt` `2.0.0`（DT-03：`release-please-config.json` 未纳管 `/package.json`）；`OPEN-DECISIONS.md` 里 A3/B1/B3/D7 的引用行号有 1–130 行漂移（建议后续统一「符号名 + 行号」定位）。
  - **下轮入口**：本仓的 OSS 对照调研仍在进行（R3 横切切片 → R4 优先级收敛 → R5 分批实施），实施项会按 `agent_talk/03_recommendations/` 的判据打分后进入本仓。

- **本轮（2026-10-29 第五十五轮 → 上下文窗口闭环预算（第 6 轮 P2），main）**：
  - **`7631c64d`**：窗口判定是开环估算（不算 55 个工具 schema、不预留输出、不消费 provider `usage.prompt_tokens`）→「估算没超、provider 400」直接把会话打成 failed。`ContextWindowOptions` 加 `measuredTokens`/`reservedTokens`：占用 = max(估算, 实测) + 预留，折叠预算同样扣预留；运行时每轮 `reserved = 2000(输出) + 首次/折叠后工具 schema`，provider 返回后记录 `tokensIn` 作下一轮实测下限，折叠后清零。
  - **验证**：admin-api tsc 0；agent **382 例**（+3：预留触发折叠、实测高于估算、折叠后 tokensAfter 含预留）；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：第 6 轮 P2 剩余（screenshot 等待竞态、ExecutionLogSection 其它、分区表 COUNT、告警 slot-missed 面板等）。

- **本轮（2026-10-29 第五十四轮 → 重放渲染语义修复（第 6 轮 P2），main）**：
  - **`a2f6e82e`**：① 截断结果 `{truncated, sha256, preview(, full)}` 被 `JSON.stringify().slice()` 从中间切断 → 模型收到非法 JSON 前缀；现在有 full 用首尾裁剪（抽到 `tool-result-shaping.ts`，同时打断 runtime↔executor import 环），只有 preview 则明确「仅预览 + sha256 + 请重新查询」。② `skipped: approval|wall_clock` 的 denied 调用重放被说成「调用未成功」（与实时【未执行】语义相反，模型不会重提）→ 按原因渲染【未执行】文案。
  - **验证**：admin-api tsc 0；agent **379 例**（+4）；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：第 6 轮 P2 剩余（上下文折叠开环估算/工具 schema 预算、screenshot 等待、ExecutionLogSection 其它、分区表 COUNT 等）。

- **本轮（2026-10-29 第五十三轮 → 槽位冲销幂等 + SSE 拒绝计数（第 6 轮 P2），main）**：
  - **`60e46e71`**：广播执行的重复回调会再次冲销同一台执行器（`GREATEST(...,0)` 只防负数不防虚低 → 容量闸超发）。按 `(executionId, address)` Redis SETNX 一次性闸（TTL 10min，fail-open 释放 + warn）。
  - **`b45e4a83`**：`/metrics/stream`、`/executions/stream` 与日志流共用槽位服务，但拒绝只在日志流计数——另两条被拒时告警全静默。计数下沉到槽位服务（三条流一个 series），help/runbook 注明共享容量；+1 用例。
  - **验证**：admin-api tsc 0；task **1574 例**（+1 幂等）、slot 新 1 例；check-metric-docs/check-alerts-rules 全绿；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：第 6 轮 P2 剩余（screenshot 等待竞态、ExecutionLogSection 其它、告警 slot-missed 面板、分区表 COUNT 等）。

- **本轮（2026-10-29 第五十二轮 → Web 可访问性/性能/错误态（第 6 轮 P2），main）**：
  - **`0c490079`**：① JSON 浮层只有鼠标能开（role=button + tabIndex 的死焦点）→ 受控 Popover + Enter/Space + `aria-expanded/aria-haspopup`；② 日志行数每次渲染 split（搜索每键一次）→ `useMemo`；③ `ArtifactsList` 加载失败丢弃 error、空 list 直接 null（被当成「无产物」）→ StateError 可重试 + zh/en 文案；新增 2 条用例（错误态→重试成功、键盘展开/收起）。
  - **验证**：admin-web tsc 0；artifacts-list 8 例、log-json-render 11 例；全量 web 见本轮末尾复核。
  - **下轮入口**：第 6 轮 P2 剩余（槽位冲销幂等、SSE 槽位拒绝计数/告警、`screenshot` 等待、`ExecutionLogSection` 其它竞态）。

- **本轮（2026-10-29 第五十一轮 → 第 6 轮 P2 批（SOP 索引/N+1 + Web 状态竞态），main）**：
  - **`7e0ece5f`**：① `sop_clarifications` 无 `resolution/createdAt` 索引，5 分钟兜底扫描 seq scan+Sort（表无 retention）→ 迁移 **0080** partial 索引（只装未答复行，CONCURRENTLY + 超时豁免，实体显式命名）；② 兜底扫描 2×N 串行点查（最多 200 往返）→ 一次 `In()` 批读（新增 `AgentSessionService.findStatusByIds`），R33-A2 条件 UPDATE 语义不变。
  - **`f4c3f409`**：① `SopsPage` 切条目先清场（否则新抽屉短暂渲染上一条的版本/指派/澄清，失败时永久串数据）；② `SopFromVideoPage` 草稿回填改为「session 变化驱动」单一 effect（修复 URL 深链续跑不回填、切会话保留上一条正文的问题），删掉重复写入路径。
  - **验证**：admin-api tsc 0；sop **269 例**、迁移注册 **125**（下一 0081）、对称 0 违规、索引漂移 0（66 命名）；admin-web tsc 0、SOP 页面 15 例；全量套件见本轮末尾复核。
  - **下轮入口**：第 6 轮 P2 剩余（槽位冲销幂等、SSE 槽位拒绝计数/告警、LogWindow 键盘可达、日志行数 useMemo、ArtifactsList 错误态等）。

- **本轮（2026-10-29 第五十轮 → 日志读分区裁剪（第 6 轮审计 P1 收口），main）**：
  - **`3b0d17f7`**：`execution_log_lines` 按 `createdAt` 分区，但 REST/SSE 两条读路径只按 `executionId` 过滤 → PG 无法裁剪、每次读全部分区各扫一遍（30 天保留 ⇒ ×31）。新增 `logPartitionWindow(exec)`（执行开始-1h ~ 终态/now+1h），REST 与 SSE 都下推 `createdAt BETWEEN`；REST 的 count 同谓词（避免同谓词扫两遍）；无时间戳时退化为旧行为。
  - **验证**：admin-api tsc 0；task 模块 **1573 例**（含新增分区谓词断言）；全量 admin-api 见本轮末尾复核。
  - **六轮审计 P1 四条至此全部收口**：①分区裁剪（本轮）②cronSlotsMissed 导出/告警（48 轮）③guards-wired 只认 run 段（47 轮）④Agent 工具在途台账/幂等闸（49 轮）。
  - **下轮入口**：第 6 轮 P2 清单（槽位冲销幂等、web 状态竞态、screenshot、SSE 槽位拒绝计数等 26 条）。

- **本轮（2026-10-29 第四十九轮 → 工具在途台账 + 同 id 幂等闸（第 6 轮审计 P1），main）**：
  - **`7ad640b0`**：「闸门放行 → 结果落库」之间此前无持久痕迹，崩溃后 resume 只能回「结果缺失」→ 模型重提导致 deploy/trigger/rollback 双份副作用。实现：`AgentToolCall.status` 新增 `in_flight`（副作用前落一行，final persist 就地更新；审批重放用 update 不重复插入）；执行入口发现同 id `in_flight` 行 → **不执行**、回「结果未知，先核实再决定是否重提」；replay 渲染同款文案；`ToolInvokeContext.idempotencyKey=<sessionId>:<toolCallId>` 透传（供后续服务端幂等接入）；前端状态词表/颜色/文案补齐。
  - **验证**：admin-api tsc 0；tool-executor **45 例**（+2）；agent 模块 **375 例**；全量 admin-api **6775 例**全绿；check-enum-drift 绿；eslint 0。
  - **下轮入口**：日志分区裁剪（P1 剩余）、P2 槽位冲销幂等 / 告警 slot-missed 面板 / web 状态竞态。

- **本轮（2026-10-29 第四十八轮 → cron 丢拍指标 + 告警（第 6 轮审计 P1），main）**：
  - **`c3acce3c`**：`cronSlotsMissed` 早已在进程内采集，却从未导出 Prometheus/无告警——10-28 丢拍事故唯一直接信号在监控面完全静默。新 counter `autoflow_scheduler_cron_slots_missed_total`（0 值基线也渲染）+ 同批导出 `misfires_skipped_dependencies_total`；alerts.yml `AUTOFLOW_SCHEDULER_SLOT_MISSED`（`increase>0` 1m，critical，runbook 注明丢拍不自动补发、需人工补跑）；指标字典与映射表补两行。
  - **验证**：admin-api tsc 0；metrics spec **50 例**（+1）；check-alerts-rules / check-metric-docs 全绿；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：第 6 轮 INDEX 其余 P1（日志分区裁剪、Agent 工具在途台账/幂等键），P2 槽位冲销幂等、web 状态竞态。

- **本轮（2026-10-29 第四十七轮 → 第 6 轮审计 P1/P3 跟进，main）**：
  - **`b9710d30`**：① `check-guards-wired` 判据①② 原先对**整份 workflow 文本**子串匹配——把守卫名只写进 step `name:`（或 env/artifact path）即可误绿；新增 `readWorkflowRunText()` 只匹配 `run:` 段，selftest 增用例 ㉑（名字只在 step name → 必须红），21/21。② `ExecutionWakeService.waiters` 超时后不回收空 Set/键（webhook wait 超时是常态）→ 比较引用后回收，补 3 条用例。
  - **验证**：check-guards-wired selftest **21/21**、实扫 44 守卫全接线；admin-api tsc 0；task 模块 **1573 例**；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：第 6 轮 INDEX 其余 P1（分区裁剪、cronSlotsMissed 指标、agent in-flight 台账），以及 P2 槽位冲销幂等 / web 状态竞态。

- **本轮（2026-10-29 第四十六轮 → 八域并行审计（8 agent 同时）+ 幂等键回归修复，main）**：
  - **编排**：按当前目标「同一时刻至多 10 个 agent」用 workflow 并行起 **8 个子代理**（运行时 active child 上限就是 8，10 会在第 9 个 spawn 处报 `subagent limit reached`）——admin-api 核心 / web / 执行器两端 / desktop / 数据库 / 可观测性 / CI-守卫-文档 / Agent×langgraph，全部只读审计，产 **43 条**（P1 4 / P2 26 / P3 13），归档 `docs/archive/audits/2026-10-29-round6/`（含 raw 输出；末尾被工具输出截断，agent 域最后几条缺失）。
  - **立即修复（`48056ad9`）**：审计报出的 P2 是**我上一轮引入的回归**——入站 webhook 去重键在副作用之前占位，`trigger`/`sendAll` 抛错时键不释放 → 上游重投被判 `deduplicated` 200，可重试故障变成永久丢失（任务不执行/告警不达）。修法：记住 `replayKey`，失败（含告警 0 渠道 502）时 `deleteKey` 再 rethrow。
  - **审计 Top P1（下轮候选）**：① `execution_log_lines` 按 createdAt 分区但读路径无分区键（每次日志读 ×31 分区）；② `cronSlotsMissed` 进程内计数从未导出 Prometheus/无告警（10-28 丢拍事故的唯一信号仍 JSON-only）；③ `check-guards-wired` 判据仍对整份 workflow 文本做子串（step name/env/artifact path 里出现即误绿）；④ Agent 写工具执行前无在途台账、无幂等键（崩溃恢复必重复副作用）。
  - **验证**：admin-api tsc 0；task webhook 去重 6 例、告警控制器 16 例；`check-docs` 绿。
  - **下轮入口**：按 round6 INDEX 逐条收（先 P1 四条，其中 guards-wired 与 agent in-flight ledger 都是 M）。

- **本轮（2026-10-29 第四十五轮 → 按依赖别名透传上游输出（G6 第二步），main）**：
  - **`df1119f9`**：legacy `$upstream` 只能透传「本次触发的那一个上游」整块上下文，多上游 DAG 没有数据契约。新增 `$upstream("别名")` / `$upstream("别名").result.foo`（别名 = `dependencies` 的键，**无需迁移**、不触碰 GIN 表达式索引）；`injectUpstreamContext` 扩展第三参 aliases，未知别名解析为 **null**（显式缺失，不把哨兵当普通参数）；扇出侧**按需**批量取每个依赖的最新执行（一次 IN + 500 行帽），本次触发的上游直接用刚完成的执行行；无别名声明的存量扇出零新增查询。
  - **验证**：admin-api tsc 0；哨兵单测 **11 例**（+4）；task 模块 **1569 例**；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：G6 第三步（动态扇出 `fanout.over`，L 级、建议先评审）、G5 检查点（L 级）、rt-2 结构性解法。

- **本轮（2026-10-29 第四十四轮 → 失败边扇出的行为证据（G6 测试收口），main）**：
  - **`623233a9`**：上一轮实现了 `runOnUpstreamFailure`，但只有依赖闸门单测、缺**端到端扇出**证据。补两条：FAILED 回调 + 声明失败边的下游 → 照常入队；FAILED 回调 + 未声明 → 不入队（既有语义未被放宽）。
  - **验证**：task 模块 **1565 例**全绿；eslint 0。
  - **下轮入口**：G6 第二步（每边输出 `$upstream("<别名>")`，需扩展哨兵语法与解析期校验）、G5 检查点（L 级）、rt-2 结构性解法。

- **本轮（2026-10-29 第四十三轮 → 任务表单暴露失败边（G6 UI），main）**：
  - **`f32e0cee`**：后端 `runOnUpstreamFailure` 上轮已落地但表单无入口（API-only 等于不存在）。执行策略分区新增「上游失败时也触发」复选框（默认关闭，tooltip 说明补偿/清理语义）；任务类型补字段；提交白名单 `TASK_DTO_PAYLOAD_KEYS` 补键（该白名单按 CreateTaskDto 全量键 `satisfies`，漏加会被静默剥掉——本轮测试当场抓到）；重新生成 `api-types.ts`（openapi 刷新后 +520 行）。
  - **验证**：admin-web tsc 0；任务表单 12 例；全量 admin-web 见本轮末尾复核。
  - **下轮入口**：G6 第二步（每边输出 `$upstream("<别名>")`）、G5 检查点（L 级）、rt-2 结构性解法。

- **本轮（2026-10-29 第四十二轮 → 依赖失败边（G6 第一步），main）**：
  - **`bf9fa94d`**：依赖扇出只在上游 SUCCESS 时触发，失败/超时/取消不触发任何下游——「失败补偿/清理」无法编排。新增任务级 `runOnUpstreamFailure`（迁移 0079，metadata-only，**不改** dependencies 的 value 形态以免 `idx_tasks_dependencies_values_gin` 表达式失配）：失败终态也进入扇出入口、只挑声明该位的下游；依赖闸门 `acceptFailure` 接受上游失败终态（**RUNNING/PENDING 仍不算满足**），调度 misfire 补偿闸同口径；DTO/openapi/i18n 同步。
  - **验证**：admin-api tsc 0；依赖闸门 **10 例**（+4 失败边语义）；task 模块 **1563 例**；迁移注册 124（下一 0080）、对称 0 违规；api-i18n 1645 节点；api-reference 218 路径；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：G6 第二步（每边输出 `$upstream("<别名>")`）、G5 检查点（L 级）、rt-2 结构性解法、任务表单暴露失败边开关。

- **本轮（2026-10-29 第四十轮 → get_session_steps（G5 只读切片），main）**：
  - **`bce6abf4`**：上下文折叠后模型无法复核早期步骤（摘要只剩事件名 + 截断预览）。新增 `get_session_steps`（read tier）：`seq` 倒序分页（`beforeSeq`）、返回正序；投影 `seq/role/content(≤300)/toolCallsJson/createdAt`，工具只回名称；会话隔离靠 `ctx.sessionId`；缺上下文拒绝。定位为 langgraph `get_state_history()` 的**只读等价物**（不提供分叉/回放，注释写明）。
  - **验证**：admin-api tsc 0；binder **28 例**（+3）；agent 模块 **373 例**；全量 admin-api 见本轮末尾复核；eslint 0。
  - **下轮入口**：G5 第二步（节点级检查点/分叉，L 级）、G6 失败边（S 但需 db 索引兼容评审）、rt-2 结构性解法。

- **本轮（2026-10-29 第三十九轮 → 会话导出 UI + 守卫链全绿复核，main）**：
  - **`4909db8c`**：会话抽屉新增「导出转录」按钮（调用 `GET /agent/sessions/:id/export`，下载 `agent-session-<id>.json`，带进行态与失败提示；测试钉住 Blob/参数/URL 回收）；顺带修掉 openapi 刷新后 `check-user-facing-language` 判红的一处英文帧名（`AiSopSessionController.turnStream` summary 改为中文，帧名保留在描述/实现）。
  - **守卫链复核**：`npm run test:guards:repo` 首跑只红一条（上述语言守卫，已修），复跑 **exit 0**（含迁移对称/索引漂移/条件写/发布六层/语言/错误码/api-i18n/api-reference/response-schema 等全链）。
  - **验证**：admin-web tsc 0；审批页 **14 例**；全量 admin-web 见本轮末尾复核。
  - **下轮入口**：G5 第二步（节点级检查点/分叉，L 级）、G6 失败边（S 但需 db 索引兼容评审）、rt-2 结构性解法。

- **本轮（2026-10-29 第三十八轮 → 会话转录导出 + openapi 产物补齐，main）**：
  - **`27eb0261`**：新增 `GET /agent/sessions/:id/export`（自包含 JSON：会话 + 全部步骤 + 工具调用 + 审批单），用于事故复盘/工单附件；权限与详情页一致，落库前已脱敏。顺带把**落后于代码的 openapi 产物补齐**：206 → 218 路径、16 条中文文案补英文（`check:api-i18n` 1642 节点全覆盖）、附录重新生成、响应 schema 棘轮 240 → 241/254 并 `--update` 基线（selftest 25/25）。
  - **验证**：admin-api tsc 0；controller 导出用例 +1；api-i18n / api-reference / response-schema（含 selftest）全绿；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：G5 第二步（节点级检查点/分叉，L 级）、G6（DAG 扇出）、rt-2 结构性解法、守卫审计剩余项。

- **本轮（2026-10-29 第三十七轮 → 会话发起人可见（G4 前端半边），main）**：
  - **`7b3abcfa`**：G4 后端已把 `createdBy` 落库并暴露，前端此前没有呈现——治理面看不到「谁发起」，四眼开关即使打开也不可自查。抽屉头部新增「发起人」标签（`user:alice` → `alice`；`system:cron` → `系统（cron）`），类型与中英文案同步，测试钉住渲染。
  - **验证**：admin-web tsc 0；审批页 13 例（含新增断言）；全量 admin-web 见本轮末尾复核；eslint 0。
  - **下轮入口**：G5（节点级检查点/回放）、G6（DAG 扇出）、rt-2 结构性解法、守卫审计剩余项。

- **本轮（2026-10-29 第三十六轮 → 会话发起人 + 审批四眼原则开关（G4），main）**：
  - **`3b0cd7b8`**：`agent_sessions` 没有 creator 列——「不能自己批自己」不是漏判而是**无数据可判**；现有四眼靠「对 Agent 永久禁用审批工具」实现，挡不住人类自批。本轮落地：迁移 0078 加 `createdBy varchar(64) NULL`（存量 NULL=未知）；三处建会话入口写发起人（controller `user:<name>` / 事件 `system:event:<type>` / cron `system:cron`）；响应 DTO 暴露；策略开关 `AGENT_BLOCK_SELF_APPROVAL`（默认 **false** 以免单人部署被卡死）开启后发起人不能 granted 自己的审批单（403 `AGENT_APPROVAL_SELF_DENIED`，拒绝仍允许），存量 NULL 只 warn 不拦。
  - **验证**：admin-api tsc 0；审批控制器 +3、session create +1；迁移注册 123（下一 0079）、对称 0 违规；`gen:error-i18n` 426 码；env-drift 227 键全覆盖；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：G5（节点级检查点/回放）、G6（DAG 扇出）、rt-2 结构性解法、守卫审计剩余项。

- **本轮（2026-10-29 第三十五轮 → 触发面幂等键（G10），main）**：
  - **`353b6628`**：`POST /tasks/:id/execute` 此前每次调用都建新执行行——客户端重试/网关重放/脚本重跑 = 第二次真实副作用（`blockStrategy` 只防「同参正在跑」）。新增 `Idempotency-Key` 头（8-128 字符）：同键同参 24h 内重放 → 409 `TASK_IDEMPOTENCY_REPLAY`；同键**不同参** → 409 `TASK_IDEMPOTENCY_KEY_REUSED`（绝不静默返回旧结果）；Redis 不可用 → fail-open；触发失败 `release()` 释放键（否则重试被当 replay，把可重试故障变永久失败）。无迁移（Redis SETNX + 载荷指纹）。
  - **验证**：admin-api tsc 0；幂等单测 **5 例** + 控制器 **5 例**；`gen:error-i18n`（425 码中英齐备）；api-reference 206 路径一致；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：rt-2 结构性解法（每页独立对象+manifest，与既有 S3 集成契约冲突需专门设计）、G5/G6（节点级检查点/DAG 扇出）等 OSS 大项、守卫审计剩余项。

- **本轮（2026-10-29 第三十四轮 → get_tool_call_result 实现（P4 收口），main）**：
  - **`819a7f0d`**：上下文摘要此前承诺「可用工具回读」而运行时没有该工具（上轮已改措辞）。本轮补上能力：截断结果在**脱敏原文 ≤32KB** 时一并存 `full`；新增 `get_tool_call_result(toolCallId)`（read tier），执行体按 `{sessionId, toolCallId}` 查询——`sessionId` 由执行器注入 `ctx.sessionId`，**不在工具参数里**（模型可控参数若含会话 id 即跨会话读取漏洞）；有全文给 `full`，只有预览时给 `preview+sha256+note`（不假装完整）；摘要措辞恢复合法指向该工具。价值：模型不必为「再看一眼输出」重跑有副作用的工具（trigger/approve/update）。
  - **验证**：admin-api tsc 0；agent+tools **365 例**（+9：会话隔离/全文/预览/缺上下文/超 32KB/摘要措辞）；agent 运行时静态守卫全绿；全量 admin-api 见本轮末尾复核；eslint 0。
  - **下轮入口**：rt-2 结构性解法（每页独立对象+manifest，与既有 S3 集成契约冲突需专门设计）、守卫审计剩余项（并行流 A 档 4 条）。

- **本轮（2026-10-29 第三十三轮 → 丢失执行清扫去日志正文（rt-1），main）**：
  - **`6d043056`**：`detectLostExecutions` 每 5 分钟最多物化 2 万行，旧实现整行 `getMany()`（连 `logs` text / `result`/`params` jsonb），循环只读 5 个字段，再把 `exec.logs` 读回来拼一行系统提示——每行最多 512KB 的纯搬运。改为**列投影**（5 列）+ **SQL 侧表达式** `logs: () => COALESCE("logs",'') || '…'`：语义逐字节一致，但不再搬运日志正文。
  - **验证**：admin-api tsc 0；executor spec **375 例**全绿（13 条 detectLostExecutions 分支）；全量 admin-api 见本轮末尾复核；eslint 0。
  - **下轮入口**：rt-2 结构性解法（每页独立对象+manifest，与既有集成契约冲突需专门设计）、守卫审计剩余项（并行流 A 档 4 条）。

- **本轮（2026-10-29 第三十二轮 → SDK 跨语言 getParam 对齐（SDK-DX-09），main）**：
  - **`b6bb7d21`**：node `ctx.getParam()` 一直大小写不敏感，python `get_param()` 是 `dict.get` 精确匹配——同一份任务代码跨语言移植会**静默拿到 None**（执行器注入键的大小写取决于配置形态）。改为精确优先、否则按大写取第一个匹配（与 node 逐字同语义）；sdk-guide 能力矩阵与 docs-site python 页同步标注。
  - **核对（无需再改）**：SDK-DX-01（`retry:null` 已归一为 `false`）、DX-02（sdk-guide 已改写为「node 有重试 + 熔断」的真实口径）、DX-03（README 版本/最低 Python 已对齐）、DX-07（示例已用 `ctx.getParam`）、DX-08（4 个 ADMIN-only 工具描述都有 `ADMIN only.` 前缀）。
  - **验证**：autoflow-sdk pytest **179 例**全绿（+1 大小写折叠/精确优先）；文档检查通过。
  - **下轮入口**：rt-2 结构性解法（每页独立对象+manifest）、守卫审计剩余项（并行流 A 档 4 条）、OBS/RT 余项。

- **本轮（2026-10-29 第三十一轮 → SDK 返回值语义与日志环溢出可见化（SDK-DX-04），main）**：
  - **`a32270a5`**：`ctx.success()/failure()` 的 `output`/`message`/`logsDropped` 全仓零消费（executor 读子进程 stdout，不读脚本返回值），而文档称「`TaskResult.logs` 随 worker 上报」。取审计的降级路线：`TaskLogger` 每次环溢出（首次 + 每 1000 条）向 **stderr** 打一行可读告警（stderr 被捕获进执行日志，是唯一真正到达管理员的通道；直接 `console.warn` 避免自我驱逐）；文档改为「便捷返回值，执行器不读取；需上报请走 ctx.http/logger」。
  - **验证**：autocodeflow-node-sdk jest **148 例**全绿（+1 溢出告警）；SDK tsc 0；`check-sdk-docs-truthfulness` 通过。
  - **下轮入口**：SDK-DX 余项（01 retry:null 空操作 / 02 文档与实现相反 / 03 README 版本落后 / 07 getParam 示例 / 08 ADMIN-only 前缀 / 09 getParam 大小写跨语言）、rt-2 结构性解法、守卫审计剩余项。

- **本轮（2026-10-29 第三十轮 → WEB-2 收口：entry 拆分 + HTTP/2 部署口径，main）**：
  - **`6c422580`**：命令面板/快捷键速查从 entry 拆成按需 chunk（`lazy` + 打开才挂载），构建后 entry **0 处 palette**、两个独立 chunk 按需拉取；**热键归属修正**——面板原自带 ⌘K 监听，懒加载后会「未挂载→无法唤起」，监听上移 `MainLayout`，面板加 `hotkeys` 开关并传 `false`（避免双监听抵消）；新增 4 条**源码级**回归守卫 + 1 条行为用例（未挂载时 Ctrl+K 仍能唤起）。部署侧把「浏览器只在 TLS 上协商 h2」写进 nginx.conf 与 deployment.md：推荐 TLS 终止在反代；若本容器直供 TLS 则加 443 + `http2 on;`。
  - **验证**：admin-web tsc 0；**2172 例全绿**（262 套件，+5）；`vite build` 通过（entry ~159KB，palette/shortcut 独立 chunk）；eslint 0。
  - **下轮入口**：rt-2 结构性解法（每页独立对象+manifest）、守卫审计剩余项（并行流 A 档 4 条）、OBS/RT 余项。

- **本轮（2026-10-29 第二十九轮 → rt-2 残差：日志背填字节帽（含一次回撤），main）**：
  - **`bfe3c38d`**：日志背填页数有帽但**累计字节**无帽——单页 64MB × 200 页可写出超过 `MAX_LOG_BYTES` 的对象，读取面 100MB cap 会拒读，形成「黑洞对象」（用户侧日志永久打不开）。现在累计超帽即停 + warn。
  - **回撤 `a5765412`**：本轮先做了「有界缓冲（32MB）+ 批量落盘」以消除 O(P²)，但并行流已把写面 gzip 换成异步版（`d4a1319a`），并用集成测试钉住「每页一次 append 上传、第二次内容为累积全文」的语义——缓冲改变了该语义、6 条集成用例转红。按「测试钉住的既有契约优先」回撤，只保留兼容的字节帽；O(P²) 的结构性解法（每页独立对象 + manifest）与之一并留待后续，已在代码注释登记。
  - **验证**：admin-api tsc 0；backfill 11 例（task.service + S3 集成）全绿；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：WEB-2（nginx HTTP/2，需部署形态决策）、rt-2 结构性解法（独立页对象+manifest）、守卫审计剩余项。

- **本轮（2026-10-29 第二十九轮 → S3 日志背填 O(P²) 消除（rt-2），main）**：
  - **`a836789a`**：旧实现每页一次 `storeLogLines(...,{append:true})`，S3 append 的真实语义是「读回整对象 → 拼接 → 全量 gzipSync → 覆盖写」——200 页累计约 4GB 压缩量（终值 40MB，100 倍放大）+ 每页一次同步 gzip（事件循环阻塞）+ 峰值 ~200MB/请求。改为**有界缓冲（32MB）+ 批量落盘**：写入次数从 P 降到 ≤4 次，压缩量回 O(N)；不全攒完是刻意的内存上界（两条并发背填不会顶穿容器）；顺带补累计字节帽 MAX_LOG_BYTES（避免写出读取面拒读的「黑洞对象」）。DB 模式保持逐页（append 是便宜 INSERT）。
  - **验证**：admin-api tsc 0；backfill **10 例**（+1：S3 两页合并为一次 put，内容 `a\nb\nc`）；全量 admin-api 见本轮末尾复核；eslint 0。
  - **下轮入口**：WEB-2（nginx HTTP/2，需部署形态决策）、守卫审计剩余项（并行流 A 档 4 条）、rt 余项（rt-6 已做、rt-3/4/7/8 已核对）。

- **本轮（2026-10-29 第二十八轮 → 删除死代码 TraceService/TraceModule（OBS3-07），main）**：
  - **`9cef9270`**：`req.traceId` 的消费已由 OBS3-04 落地（5xx/22P02 日志行带 trace），但配套 `TraceService`/`TraceModule` **从未被任何模块 import**（运行期不存在）。而 `main.ts`/中间件头注仍宣称「Cross-service request tracing」——与事实不符。删除死代码 + 4 条随附单测；注释改为事实口径：**请求域关联**（生成/回显 `X-Trace-Id`、写 `req.traceId` 供异常过滤器），**不做**出站透传；真正跨进程追踪走 opentelemetry 开关 + W3C traceparent。
  - **验证**：admin-api tsc 0；common 套件 **682 例**全绿；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：WEB-2（nginx HTTP/2，需部署形态决策）、守卫审计剩余项、OBS/RT 余项（rt-2 S3 背填 O(P²) 仍待做）。

- **本轮（2026-10-29 第二十七轮 → waiting_input 总上限（PK-19 续），main）**：
  - **`502f7bc7`**：上一轮给审批加了 7 天 TTL，但 waiting_input 还包含「等待澄清」等人工输入面——没有 TTL 时同样永久挂着。补一条总上限：`STALE_WAITING_INPUT_TIMEOUT_MS = 30 天`，`sweepAbandonedWaitingInput` 扫 `waiting_input AND updatedAt < now-30d` 收敛为 failed（写明「等待输入超时…数据完好，可重新发起」）；**仍挂未过期审批的会话跳过**（交给审批 TTL 流程，避免两套规则互抢）；复用同一 10 分钟 Leader cron。
  - **验证**：admin-api tsc 0；agent session spec **46 例**（+3）；全量 admin-api 见本轮末尾复核；eslint 0。
  - **并行流**：T4 收官（4 条守卫迁共享 harness，58 条用例）+ audit 计数判据 + e2e 文档重写已提交；其下轮入口仍是守卫 A 档剩余 4 条（interface-maps/failure-reasons/desktop-selftests-wired/migrations），本会话不触碰。
  - **下轮入口**：WEB-2（nginx HTTP/2，需部署形态决策）、守卫审计剩余项、OBS/RT 余项。

- **本轮（2026-10-29 第二十六轮 → 三个入站 webhook 全部收口（SEC-R3-4 收尾），main）**：
  - **`09120d54`**：`applications` CI 发布回调是第三个可重放面——重放同一签名会再写一遍版本元数据，并在 `triggerDeploy` 时对所有 RUNNING 部署**再发起一轮滚动升级**（CI 重试/抓包重放 = 重复发布）。按同款 SETNX 去重：命中返回 `{deduplicated:true}`（200）、不 update、不升级；`@Optional` 注入 + ApplicationModule 显式提供 Redis。
  - **`94fbd7a7`（自查发现的安全回归）**：上一轮把 `X-AutoFlow-Delivery` 放进去重键，但 HMAC 只覆盖 `${timestamp}.${rawBody}`——delivery 头不在签名范围内，攻击者改一个头就能绕过去重。修法：键**只用签名**（`sha256(signature)`），delivery 仅用于日志；新增反证用例「同一签名 + 两个不同 delivery → 键必须相同」。
  - **验证**：admin-api tsc 0；task webhook 去重 **5 例**、applications **31 例**；全量 admin-api 见本轮末尾复核；eslint 0。
  - **下轮入口**：WEB-2（nginx HTTP/2，需部署形态决策）、守卫审计剩余项、OBS/RT 余项。

- **本轮（2026-10-29 第二十五轮 → 入站 webhook 幂等去重（SEC-R3-4），main）**：
  - **`2f7954e9`**：签名 + ±5min 窗只证明「新鲜」，证明不了「没被重放」。同一 (taskId, 签名) 窗内再来一次时，旧实现会再建一条 execution（清理/发布/对账类任务重复执行），告警回调则整渠道再扇出一遍。新增 `RedisLockService.setIfAbsent`（原子 SET NX PX）；任务 webhook 与告警 webhook 均在验签后按 `webhook:<scope>:<sha256(delivery|signature)>` 抢占 10 分钟键，命中返回 `{deduplicated:true}`（200 让投递方停重试）且不触发/不扇出；新增可选头 `X-AutoFlow-Delivery`。**fail-open**（Redis 挂了 warn 后继续——去重是加固不是可用性前提），@Optional 注入保证单测/极简装配行为逐字节不变。
  - **验证**：admin-api tsc 0；task webhook **23 例**（+4）、notification **371 例**（+1）；全量 admin-api 见本轮末尾复核；eslint 0。
  - **残差**：applications CI webhook 是第三个可重放面（同一 util、不同 handler），下一轮按同一模式接入。
  - **下轮入口**：applications webhook 去重、WEB-2（nginx HTTP/2，需部署形态决策）、守卫审计剩余项。

- **本轮（2026-10-29 第二十四轮 → 工具参数保守修复（Agent 鲁棒性），main）**：
  - **`cea9f7c3`**：真实模型常把 `tool_call.arguments` 写成「包在 Markdown 围栏里 / 前后夹解释 / 末尾多逗号」。旧实现直接 `JSON.parse`——这些**无歧义**的语法噪音会让本可成功的调用变成 error，模型只能重试（浪费一轮 token 与延迟）。新增 `repairToolArguments`：依次尝试「原始 → 去围栏 → 去前后散文（截取本体）→ 去尾逗号」，命中即用；**缺值/缺括号一律不猜**（猜错参数比报错更难查），失败文案带「已尝试 N 种保守修复」+ 原始片段。参考 langchain `parse_partial_json` 的取舍。
  - **验证**：admin-api tsc 0；tool-executor **42 例**（+8，含 execute 端到端修复）；agent 模块 **357 例**；全量 admin-api 见本轮末尾复核；eslint 0。
  - **下轮入口**：WEB-2（nginx HTTP/2，需部署形态决策）、SEC-R3-4（webhook 重放，需产品决策）、守卫审计剩余项（并行流推进中）。

- **本轮（2026-10-29 第二十三轮 → 包级 CHANGELOG 解冻（SDK-DX-05），main）**：
  - **`1fc494d5`**：四个已发布包的 CHANGELOG 冻结在 1.9.0 而 manifest 已是 1.15.0（6 个 release 无记录）。根因结构性：release-please 只有 root `.` 条目，版本经 extra-files 广播但不写包级 CHANGELOG。取审计 B 案：四份 CHANGELOG 改**指针 stub**（`<!-- stub-version: X -->` + 指向根 CHANGELOG + 原因说明），新增可测的 `checkChangelogStubs`——缺标记或版本不一致即红（stub 不会再静默冻结）；release-config 守卫从五层升为**六层**。
  - **验证**：`check-release-config` 实扫全绿、`--selftest` **20 例**（+3：一致→绿 / 过期→红 4 条 / 旧完整文件→红 4 条）；check-docs、sdk-docs-truthfulness、publishable-wiring 全绿；release-hygiene 在 CI 环境下通过（本地缺 token 属预期）。
  - **下轮入口**：WEB-2（nginx HTTP/2，需部署形态决策）、SEC-R3-4（webhook 重放，需产品决策）、守卫审计剩余项（并行流已推进到第 6–7 轮：rt-2 止血 / T4 二三批 / 恒定时间守卫）。

- **本轮（2026-10-29 第二十二轮 → 审批单 TTL 收口（PK-19），main）**：
  - **`2ebe3da3`**：`agent_approvals` 的 pending 单此前没有有效期——没人点的审批让会话**永久** waiting_input（既不执行也不失败），看板上永远挂着「待审批」。修法：新增 `expired` 状态（varchar 列，无需迁移；与 denied 区分「谁关的」）+ `expireStalePending`（只扫 pending 且 createdAt < cutoff，条件写钉住 pending，绝不覆盖人工结论）+ `sweepStaleApprovals`（复用既有 10 分钟 Leader cron；收敛三要素：仍 waiting_input / waitingFor 是审批 / 已无 pending 单，缺一不可）。TTL=7 天。前端补 `expired` 词表/徽标（灰）与中英文案。
  - **验证**：admin-api tsc 0；approvals 过期 3 例 + session 收口 4 例；**全量 admin-api 6724 例全绿**；admin-web tsc 0、**2167 例全绿**（首跑有 1 例 flaky，重跑通过）；enum drift / error-i18n / user-facing-language 守卫全绿。
  - **下轮入口**：WEB-2（nginx HTTP/2，需部署形态决策）、SDK-DX-05、守卫审计 T4（并行流正在推进：index-drift 已改成 spawn 断言退出码 + `--root`）、SEC-R3-4。

- **本轮（2026-10-29 第二十一轮 → Agent 能力承诺与事实对齐，main）**：
  - **`9bcb79db`**：两处「提示词/注释说的能力」与实现不符——① 上下文摘要告诉模型「可用工具回读」历史步骤，但运行时**没有**这个工具（get_tool_call_result 一直是 P4 未做），模型会去调一个不存在的名字并浪费一轮推理；改为「需要时请按 id 重新调用相应工具查询，不要凭摘要猜测」。② `TOOL_RESULT_MAX_CHARS` / `AgentToolCall.resultJson` 注释写「完整结果落库、可回读」，实现是截断时只存脱敏 preview + sha256；注释与 UI 提示同步改为事实口径。
  - 与 SEC-R3-5 同一条纪律：**系统对外的承诺必须与事实一致**；测试钉住摘要措辞。
  - **验证**：admin-api tsc 0；agent-context + tool-executor 48 例；全量 admin-api 见本轮末尾复核。
  - **核对**：第 4 轮守卫审计的 T1（alerts expr 体检）与 T2/T3（条件写、迁移对称）已由并行流落地；T4（自检统一断言退出码）体量大、尚未做，仍是守卫假绿的元层风险。
  - **下轮入口**：T4 切片（先给 `check-index-drift`/`check-enum-drift` 的自检补退出码断言）、WEB-2（需部署形态决策）、SDK-DX-05、SEC-R3-4。

- **本轮（2026-10-29 第二十轮 → 全仓回归基线 + 裁剪边界修复，main）**：
  - **`66d417d5`**：上一轮首尾裁剪在 `max < marker.length` 的极端输入下会把预算钳成 0、内容只剩标记（比 max 还长）。改为 budget<8 时退化为纯前缀（`slice(0,max)`），测试断言长度 ≤ max。默认 2000 永不触发，但纯函数契约必须成立。
  - **全仓回归基线（本轮实测，五个套件并行跑 —— 恰好演示「同一时刻 ≤5」的编排）**：
    - admin-api：**6717 例**（含 agent 342）
    - admin-web：vitest 全绿（exit 0）
    - executor-node：**1401 例**（54 套件，13 skip）
    - executor-python：全量 **88.29% ≥ 86%**（exit 0）
    - packages/mcp-server：**324 例**
    - executor-desktop：`test:main` selftest 全绿（含 zip 交叉验证）
    - packages/autoflow-sdk：**178 例**
    - `test:guards:repo`：**全绿**（含迁移对称 122 个/违规 0、索引漂移 65 命名/24 未命名、enum drift 36、release 配置五层一致性、守卫接线 44）
  - **下轮入口**：WEB-2（nginx HTTP/2——需部署形态决策：当前 nginx 只 listen 80、无 TLS，浏览器 h2 必须有 TLS 终止层）、SDK-DX-05（CHANGELOG 冻结在 1.9.0）、守卫审计未做项、SEC-R3-4（webhook 重放，需产品决策）。

- **本轮（2026-10-29 第十九轮 → Agent 工具结果「首尾保留」裁剪，main）**：
  - **`54489468`（Agent 质量）**：超长工具结果此前 `slice(0, 2000)` 只留头部；对 `get_execution_logs` 这类载荷，异常栈/退出码/结论几乎总在**尾部**，模型只看到开头 INFO 行就基于不完整事实继续推理。改为 `shapeToolResultForModel`：70% 预算给头、其余给尾，中段用「省略 N 字符」标记替代（模型能判断还有多少没看到）。与 langchain 文本裁剪 / 日志查看器「保留首尾」惯例一致；持久化路径不变（截断仍落 preview+sha256）。
  - **验证**：admin-api tsc 0；agent 模块 **342 例**（+3 helper 用例）；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：WEB-2（nginx HTTP/2，需部署形态决策）、SDK-DX-05（CHANGELOG 冻结）、守卫审计未做项、migration-symmetry 全量命中、SEC-R3-4（webhook 重放，需产品决策）。

- **本轮（2026-10-29 第十八轮 → SEC-R3-5：授权证据语义修正，main）**：
  - **`a1cd7e09`（P3 安全）**：`assertCanOperate` 曾在第一行无条件落「已校验」证据，于是 `assertCanOperate(row, null)`（webhook 等机器面）在**零判定**的情况下留下证据。今天 webhook 路由是 scope:"public" 不需要它，所以不可利用；但只要有 project-role 路由复用 `trigger(...)` 漏传 user（R-02 两次真实漏传），A2-B 拦截器会读到假证据放行。修法：证据 = 「判定为允许」（OPA/Cedar decision log 只记结论），主体缺失时**先返回、不落证**；其余分支保持既有落证位置（拒绝分支以异常收尾，拦截器 next 不会被调用）。
  - **验证**：admin-api tsc 0；guards + task.service **417 例**（+1：主体缺失后无 `task:operate` 证据）；全量 admin-api 见本轮末尾复核。
  - **下轮入口**：WEB-2（nginx HTTP/2，需部署形态决策）、SDK-DX-05（CHANGELOG 冻结）、守卫审计未做项、migration-symmetry 全量命中、SEC-R3-4（webhook 重放窗口）需产品决策。

- **本轮（2026-10-29 第十七轮 → Agent 只读工具并行 + 守卫跟进，main）**：
  - **`6ff593ca`（Agent 能力）**：模型一次给出多个 tool_calls 时运行时会逐个串行执行——两个无依赖的只读查询延迟相加。现在**整批都是 read tier** 且墙钟未过期时按 ≤4 路并行（结果保持原始调用顺序回灌）；批里出现 write/dangerous 就退回原严格串行循环——写顺序与「第 2 个需审批 ⇒ 同批其余不执行」的挂起语义不变。参考 langgraph「独立调用并发、有状态/需审批调用串行」的纪律。
  - **`f1da9398`**：`agent-runtime-check` 的静态断言跟上 OBS3-02 的 label 收敛（`tool: this.metricToolLabel(input.toolName)`），直写模型函数名视为回归。
  - **验证**：admin-api tsc 0；agent 模块 **339 例**（+2 并行/串行行为）；**全量 admin-api 6705 例全绿**（29s）；agent 运行时/边界/SOP 三个守卫脚本全绿；eslint 0。
  - **下轮入口**：WEB-2（nginx HTTP/2，需部署形态决策）、SDK-DX-05（CHANGELOG 冻结）、守卫审计未做项、migration-symmetry 全量命中；Agent 侧可继续对照 langgraph 看「工具结果截断策略 / 中断恢复语义」是否还有可借鉴项。

- **本轮（2026-10-29 第十六轮 → rt-6 排空循环，main）**：
  - **rt-6 续（`5db72689`）**：上一轮把 outbox 批量 5→20、并发 3→10；本轮把 `scanOnce` 改成**排空循环**——只要本轮取满（可能还有积压）就立即 claim 下一批，不再等下一个 5s tick；上限 `OUTBOX_DRAIN_MAX_BATCHES=3`（最多 60 行/tick，下游挂起最坏 90s），到顶打一条「backlog remains」WARN。旧「整批饱和」提示在排空后已不准确，替换。
  - **验证**：admin-api tsc 0；outbox **43 例**（+2：取满立即再 claim、per-tick 上限）；全量 admin-api 见本轮末尾复核。
  - **核对（并行流已落地）**：rt-7（日志流列投影）、WEB-1/3/4/5（recharts 首屏、SSE 后台不重连、审批单可看见要执行的参数——`ToolArgsView` + `ToolArgsView` 关联）、SEC/EXEC/OBS 大部分条目。
  - **下轮入口**：WEB-2（nginx HTTP/2，需部署形态决策）、SDK-DX-05（CHANGELOG 冻结在 1.9.0，release 工具面）、守卫审计未做项、migration-symmetry 全量命中。

- **本轮（2026-10-29 第十五轮 → rt-8 事件驱动保活 + rt-6 恢复吞吐，main）**：
  - **rt-8（P3，`5e1d85bf`）**：`/executions/stream` 曾每秒醒一次判断「是否该 ping」（250 条连接 = 250 次/s 的 Promise + abort listener 成对分配），而 ping 周期是 30s。改为 `setTimeout(idlePingMs)` 单定时器 + **每写一帧重置**（与日志流同口径），连接生命周期只剩 `waitAbort(signal)`；定时器 `unref()`。删掉失效的 `waitCancellable`。
  - **rt-6（P2，`b443364c`）**：outbox 恢复速率是 `BATCH/INTERVAL` 的乘积——5 行/5s = 1 行/s，比入队面（≈22 行/s）低 1.5 个量级；一次 10 分钟下游故障要 3.6-14 小时排空，且期间只有「积压增长」告警、没有恢复中信号。`BATCH` 5→20、`CONCURRENCY` 3→10；构造期断言改为「租约 ≥ 单行上界 × 波数」（20 行两波 30s < 60s 租约，不扩大重复投递窗）。同步修正 `ARCH-MULTI-INSTANCE-MATRIX.md` 的陈旧口径（仍写 BATCH=1）。
  - **验证**：admin-api tsc 0；metrics 130 例、outbox 42 例全绿；check-docs 绿；eslint 0。
  - **核对（并行流已落地）**：rt-7（日志流 findOne 改列投影，只取 status/taskId/logStorage/logObjectKey/startTime/id）。
  - **并行流**：正在做第 4 轮 T3（migration symmetry：up 用 CONCURRENTLY 的迁移，down 也必须 CONCURRENTLY + 会话级超时豁免）与前端词条；本会话未触碰其编辑。
  - **下轮入口**：rt-6 的排空循环（claim 到空为止，再提一个量级）、WEB-2（nginx HTTP/2）、SDK-DX 余项、守卫审计未做项、migration-symmetry 其余命中。

- **本轮（2026-10-29 第十四轮 → rt-4 共享快照 + 守卫自检接线，main）**：
  - **rt-4（P2，`f60cad8e`）**：`/metrics/stream` 的快照按**连接**生成——每条 Dashboard 连接每 3s 各自重跑 `getSummary`（4 COUNT + 30 天 GROUP BY/AVG）+ `getExecutorStats` + 调度器 Redis；32 连接 ≈75 SQL/s（64 条是 30 天聚合），扩到 300 连接即 600 SQL/s，监控自己会打满 DB 池。新增 `MetricsSnapshotCacheService`：**单飞 + 2s TTL** 跨连接复用同一份快照，协议零变化；单查询失败只降级该段并进 `errors`（连接照发 error 帧），失败结果也进缓存。控制器删掉连接内联计算与失效的 `logQueryFailure`。
  - **守卫自检接线（`1a6e2161`）**：把上一轮 `check-guards-wired --selftest`（临时假根复现「注释步骤算接线」「npm run 前缀误配」两种误绿）接进 `test:guards:repo` 与 CI guards job——有自检但没人跑 = 同一种失效。
  - **验证**：admin-api tsc 0；metrics 模块 **130 例**（+5 单飞/TTL/失败降级/invalidate）；`check-guards-wired --selftest` 4/4、实扫 44 个守卫全部接线；ci.yml PyYAML 解析通过；全量 admin-api 套件见本轮末尾复核。
  - **并行流**：已提交第 4 轮守卫审计的 T5（枚举漂移/用户语言补牙）、T2（重启 sweep 状态写补谓词，被 ADR-026 扩面当场抓到的真实违规）与汇总文档；本会话未触碰其编辑。
  - **下轮入口**：WEB-2（nginx HTTP/2）、rt-6（outbox 恢复吞吐）、rt-7/rt-8（日志 SSE 整行/1s 定时器）、SDK-DX 余项、守卫审计未做 6 项。

- **本轮（2026-10-29 第十三轮 → rt-4 切片：executor 统计投影；核对三项审计已落地，main）**：
  - **rt-4 切片（`169f6feb`）**：`getExecutorStats()` 无 `select` 全表物化 `Executor`（含 `tokenHash` 等凭据列）后只取 8 个字段，而 `/metrics/stream` **每条连接每 3s** 触发它。改为显式投影 8 列 + 测试钉住 select 键集。rt-4 的共享快照泵（跨连接复用一次 SQL）仍待做。
  - **核对（并行流已落地，不重复劳动）**：rt-3（终态事件载荷改 `logHead` 首行摘要、监听方不再 `.split("
")`）、OBS3-05（渲染取数失败有 `autoflow_metrics_render_error_total` + 日志）、OBS3-06（31 条告警补 `runbook_url` + 相对 `runbook:` 回退映射）。
  - **验证**：admin-api tsc 0；metrics 模块 125 例（+1）；eslint 0。
  - **残差**：`check-guards-wired --selftest` 仍未接进 CI/`test:guards:repo`（`ci.yml`/`package.json` 持续被并行流编辑，待其落定一行接线）；rt-4 共享泵、WEB-2、rt-6/7/8 待做。
  - **并行流**：正在重写条件写/枚举漂移/用户语言三条守卫 + `app-deployment.service.ts`，本会话未触碰其编辑。

- **本轮（2026-10-29 第十二轮 → 「守卫的守卫」补牙齿，main）**：
  - **第 4 轮守卫审计的第一条落地**：`check-guards-wired` 的判据是纯子串匹配，审计用临时假根实证了两种**误绿**——① 把 CI 步骤注释掉（`# node scripts/check-x.mjs`）仍被判为已接线；② workflow 写 `npm run check:all` 时 `includes("npm run check")` 命中，无法区分「间接带跑」与「没接线」。修法：剥 YAML 注释、文件名/npm script 名都加边界匹配；ALLOWLIST 结构化（`report-only` 必须写理由、`covered-elsewhere` 必须有 `mustProve` 且文件存在）、陈旧豁免报错并清掉一条从未被扫到的死豁免；新增 `--selftest`（临时假根复现两种误绿 + 豁免校验，4/4）。
  - **验证**：`--selftest` 4/4；实扫 44 个 check-*.mjs 全部接线；eslint/prettier 未涉及（纯脚本）。
  - **残差**：`--selftest` 尚未接进 CI/`test:guards:repo`（`ci.yml`/`package.json` 正被并行流修改，避免同文件夹带，待其落定后一行接线）。
  - **并行流**：正在重写 `check-conditional-writes` / `check-enum-drift` / `check-user-facing-language`（同一份守卫审计的其它条目），本会话只提交了自己的脚本，未触碰其编辑。
  - **下轮入口**：接 selftest 进 CI；继续按守卫审计评分表处理条件写/枚举漂移/用户语言三条的判据强度；随后 OBS3-05/06/07、WEB-2、rt-3/rt-4。

- **本轮（2026-10-29 第十一轮 → 指标基数与容量分母治理，main）**：
  - **OBS3-02（P2）**：`autoflow_agent_tool_calls_total{tool}` 直接取模型返回的函数名 → 每次幻觉一个新 series（Prometheus 基数爆炸、渲染内存随会话线性增长）。写入侧把**不在工具注册表里的名字归并为 `unknown`**（仍可观测「有越界调用」，但不建永久 series）；纠正注释里「已知标签组合全部 inc(0)」的失实承诺，并加测试断言基线工具名必须真实存在。
  - **OBS3-08（P3）**：`autoflow_agent_llm_retry_total{result}` 的恢复面三值（approved_replay / resume_queued / resume_enqueue_failed）此前未登记——现补 0 值基线与 help，并用测试钉住 result 全集。
  - **OBS3-03（P2）**：`autoflow_sse_streams_limit` 只在抢占槽位时写 → 从未开流的副本没有 limit series，容量告警 `Σ(active)/Σ(limit)` 分母缺副本、占用率最多放大「副本数」倍。`TaskService.onModuleInit` 启动即发布 `active=0 + limit`（配置值），活跃值仍由占用/释放更新。
  - **已核对（并行流先前落地）**：OBS3-01（看板 label 大小写，当前看板 0 处 `SUCCESS` + dashboard-label-values 守卫）与 OBS3-04（5xx 日志统一出口带 method/path/errorCode/traceId）。
  - **验证**：admin-api tsc 0；agent+metrics **462 例**；task service **324 例**；`check-alerts-rules`（指标清单 52 / gauge 23 / 31 条规则语义级对账）全绿；eslint 0。
  - **剩余观测项**：OBS3-05（渲染取数失败只吞——已有 render_error 指标，需核对是否有日志/陈旧信号）、OBS3-06（runbook_url 0 条接线）、OBS3-07（traceId 全仓无人读/模块死代码）。
  - **下轮入口**：OBS3-05/06/07、WEB-2（nginx HTTP/2）、rt-3/rt-4（SSE 投影与连接级取数）、SDK-DX 余项。

- **本轮（2026-10-29 第十轮 → EXEC-02 收编：去掉 preexec_fn 死锁面，main）**：
  - **EXEC-02（P2）**：执行器是多线程进程，而 POSIX 的 `preexec_fn`（fork 后、exec 前跑 Python）被 CPython 明确标注可能死锁——同一面共 4 处（任务 spawn、uv、git clone/fetch/checkout），prepare 还跑在 `asyncio.to_thread` 里。改为「新 exec 的单线程 launcher」`task_launcher.py`：`start_new_session=True` 在内核/posix_spawn 层先建会话（child 内零 Python，消除 kill 早到导致 killpg 打到自己的窗口）→ launcher 逐条 setrlimit（单条失败可见降级）→ 还原 SIGPIPE/SIGXFZ/SIGXFSZ 为 SIG_DFL（SIG_IGN 跨 exec 继承会改任务信号语义）→ `execvpe`（PID 不变，树杀语义不变）；`_kill_process_tree` 加「pgid == 执行器自身组则不 killpg」底线。limits 双层校验 + fail-closed（绝不在「限制没生效」的形态下继续）。
  - **验证**：真跑断言子进程 `pid==pgrp==sid`、NOFILE/AS/FSIZE 在第一条指令前生效、exec 后 SIGPIPE 为 SIG_DFL；目标套件 81 例、全量 **1481 passed / 0 failed，覆盖 88.29% ≥ 86%**（task_launcher 100%、sandbox 96%、execute 86%）；先红证明旧实现会返回 `preexec_fn`；win32 路径逐字节未变。docs/deployment.md 的陈旧引用同步更正。
  - **残差**：每次 spawn +约 15ms；win32 仍无 RLIMIT（与改前一致）；launcher 依赖 `sys.executable`，冻结解释器为空时 fail-closed。
  - **下轮入口**：WEB-2（nginx HTTP/2）、OBS3-02/03/04（指标标签/容量分母/5xx 日志）、rt-3/rt-4（SSE 投影，若并行流未覆盖）、SDK-DX 余项。

- **本轮（2026-10-29 第九轮 → params 折叠冲突前置 + 回调严格度对账，main）**：
  - **EXEC-07b（P2）**：执行器的折叠冲突闸在 accept 阶段（派发之后）——用户提交任务时看不到，只在触发后收到执行器 400。admin 侧补同一判据：`findDispatchParamKeyCollisions`（与执行器同规则）+ `TaskParamsNoKeyCaseCollision` DTO 约束挂到 Create/TriggerTask 的 params（PATCH 经 PartialType 继承），保存/触发即 400；测试直接加载 `protocol.json` 的 8 条 `params.keyUniqueness` 向量逐条对账，另有约束单测（冲突/放行/非法键/多组排序/畸形）。
  - **EXEC-06（P3）核对**：审计判断「python `model_validate()` lax」**已过时**——生成模型是 `ConfigDict(strict=True)`，实测字符串 `"1"`/浮点 `1.0` 均被拒，与 node `z.number().int()` 同结论，**无需改代码**；把该事实钉成两端契约测试，防生成器未来退回 lax。
  - **EXEC-02（P2，子代理进行中，未提交）**：POSIX 任务启动器 `task_launcher.py`——把 setsid/rlimit 从 `preexec_fn`（多线程进程 fork 后跑 Python，CPython 明确警告可死锁）搬到**新 exec 的单线程解释器**里，再 `execvpe` 真实命令（PID/进程组不变，树杀路径不受影响）；limits 白名单 + fail-closed（不合规不启动，绝不静默无限制执行）。当前工作区已出现 `task_launcher.py` 与 execute.py/sandbox.py 改动，等其报告后独立复核再提交。
  - **验证（本轮已提交部分）**：admin-api tsc 0；DTO/executor 146 例 + task 模块 **1540 例**全绿；executor-node 全量 **1401 例**；executor-python 协议契约 21 例；eslint 0。
  - **并发提示**：并行流正在做基础设施 wave（workflows/config/新守卫脚本），本会话只提交自己的显式路径。
  - **下一轮入口**：复核并提交 EXEC-02；随后 WEB-2（nginx HTTP/2）、OBS 余项、rt-3/rt-4（SSE 投影，若并行流未覆盖）。

- **本轮（2026-10-29 第八轮 → 执行器三项审计收编：单一模型/参数折叠/env 清单，main）**：
  - **EXEC-01（P2）**：python `/execute` 的「SDK 优先 + 本地 fallback」双源删除——SDK 那份是客户端模型（`task: TaskConfig`、无 `secrets`），一旦被 import，4 处 `req.task.get(...)` 全部 AttributeError（每任务 500）且凭据被静默丢弃，协议闸门也拦不住（dump 里 task 已是 dict、secrets 缺失）。现在只有一份本地模型（`task: dict` + `secrets`），新增 11 条 AST 静态守卫（反证：旧文件 4 条转红）；SDK 客户端模型补上 `secrets` 字段并注明「client ≠ executor 反序列化模型」，atlas 的陈旧描述同步更正。
  - **EXEC-07（P3）**：`{"limit":1,"LIMIT":2}` 两个键都过闸、注入时折叠成同一个 `AUTOFLOW_LIMIT`，后者静默覆盖前者。两端在 accept 阶段 400 拒绝（`param_key_case_collision`，文案逐字节相同），协议新增 8 条向量；顺带修掉 python `$` 在末尾换行前匹配导致的 `"LIMIT\n"` 判定分叉（改 `fullmatch`，两端各加用例）。
  - **EXEC-05（P3）**：`protocol.json` 新增 `envForward` 三桶清单（common 24 / runtimeOnly 每端带 reason / neverForward），两端集合一字未动、只补注释；双向守卫解析对方真实源码，断言「自己 == common ∪ 专属」「common 与对方逐项相等」「每条差异有理由」「neverForward 无交集」，只登记现状不扩面。
  - **验证**：executor-node 全量 **1399 例**（54 套件，13 skip）；executor-python 全量带覆盖率闸 **87.69% ≥ 86%，exit 0**（首次 79.65% 是「编辑与测试并发」造成的行号错位，静默窗口复跑即恢复——已作为教训记录）；admin-api parity 9 例；`check:protocol-sync` 无 diff；check-guards-wired（40）/user-facing-language/error-i18n/error-migration 全绿。
  - **下一轮入口**：EXEC-02（preexec_fn 多线程死锁）、EXEC-06（CallbackPayload 严格度）、EXEC-07b（admin 源头闸同规则前置）、WEB-1/2/3（若并行流未覆盖）。

- **本轮（2026-10-29 第七轮 → 热表迁移并发化 + 日志写入归属 + 执行器跨端项，main）**：
  - **db-5（P2）**：0061 改为 `transaction=false` + `CREATE INDEX CONCURRENTLY` + 会话级 statement_timeout 豁免（executor_metrics_history 是每执行器每 30s 一行的百万行表，普通建索引持 SHARE 锁会冻住心跳落库）；0073 拆成「只做幂等去重」+ 新迁移 0077（`CREATE UNIQUE INDEX CONCURRENTLY` 建同一 partial 唯一索引，既有库 no-op）。0073 的 down 改空操作（删除的重复行不可恢复，不伪造数据）。
  - **SEC-R3-3（P2）**：`POST /executions/:id/logs` 的共享令牌兜底改为**直接拒绝**——共享令牌不携带行身份，路径 executionId 由调用方自报，没有第二事实源可校验归属；任何执行器都能写任意执行的日志＝伪造取证。正常日志走 `v1.` 单执行 HMAC 或 per-address/per-executor 令牌；拒绝时日志退回终态回调，不丢结果（与 callback 的共享兜底刻意不同：那边是旧版结果上报主路径）。端点契约注释同步。
  - **执行器跨端（子代理进行中）**：EXEC-01（python `/execute` 第三份模型，SDK 分支一旦生效会 `AttributeError` 且丢 secrets）、EXEC-07/05（params 大小写折叠冲突、env 转发白名单两端差异清单）。开工时已确认与并行流写域不重叠。
  - **验证**：admin-api tsc 0；迁移套件 **327 例**；日志流控制器 10 例；**隔离 worktree 检出 HEAD：tsc 0 + 迁移+日志 337 例全绿**；check-migrations（122 个 / 下一可用 0078）与 check-index-drift 全绿；eslint 0。
  - **并发提示**：并行流仍在提交（本轮已被其 commit 抢先两次：`7629c6c5` leader 门禁修复与本轮无冲突）；本会话所有提交均 `git commit --only -- <paths>`，未再发生索引夹带。
  - **下一轮入口**：收编执行器子代理产出（EXEC-01/05/07），随后 EXEC-02（preexec_fn 线程死锁）、WEB-1/2/3（若并行流未覆盖）、以及把 `check-cron-guard` 之外的审计守卫继续接线。

- **本轮（2026-10-29 第六轮 → 数据层三修（db-1 残差/db-2/db-3）+ 执行器跨端一致性，main）**：
  - **db-2**：迁移 `1790000000075` 建 `idx_tasks_created_at_id (createdAt DESC, id DESC)`（CONCURRENTLY + 会话级 `statement_timeout` 豁免）；`Task` 实体把未命名的 `@Index(["createdAt"])` 换成显式命名声明，让 `check-index-drift` 覆盖（此前 25 个未命名声明是盲区）。`GET /tasks` 不再全表读+Sort。
  - **db-3**：迁移 `1790000000076` 建 partial index `("createdAt") WHERE "dispatchedAt" IS NULL AND "deadLettered" = false`（谓词与 claim SQL 逐字对应）；死信/已投递行不进索引，`ORDER BY createdAt` 由索引序满足。实体补同名声明。
  - **db-1 残差**：`runMigrationWithAdvisoryLock` 在 up 迁移后自检 `pg_index.indisvalid`——CONCURRENTLY 被超时取消会留下无效同名索引，`IF NOT EXISTS` 重跑永不修复。自检 fail-open（查询失败只 warn），发现时 ERROR + 处置步骤（确认无构建中 → `DROP INDEX CONCURRENTLY` → 重跑迁移）。
  - **验证**：admin-api tsc 0；迁移套件 54 套件 322 例（+2 结构 spec）；task/event-subscriptions/runner 1961 例；**隔离 worktree 检出 HEAD：迁移+runner 55 套件 330 例全绿**；`check-migrations`（121 个 / 下一可用 0077）与 `check-index-drift`（65 命名 / 24 未命名）全绿。
  - **并发提交事故（第二次，反向）**：本会话已 `git add` 的 9 个数据层文件，被并行 agent 的 `catch-all` 提交（`3004fa8f`，标题是 SDK）一起带走——内容全部在 HEAD 且隔离验证通过，但归属/提交信息错误。教训升级：**共享工作区里不要预先 stage**；要么「add + commit 原子完成」，要么用 `git commit --only -- <paths>`。已在 playbook 记录。
  - **并行流状态**：rt-5 cron 闸、dashboard label、SDK 可靠性层、文档纠偏等已由并行流提交；本会话只负责上述数据层与执行器跨端项。
  - **下一轮入口**：db-5（0061/0073 非并发 DDL 拆分）、EXEC-01/02/05/06/07（执行器跨端余项）、SEC-R3-3（日志写入归属决策）、WEB-1/2/3（若并行流未覆盖）。

- **本轮（2026-10-29 第五轮 → 共享令牌身份收紧（SEC P1）+ 并行 CRON-GUARD 收编，main）**：
  - **交付（`c150a434`）SEC-R3-1/2（P1）**：`authenticateMachineRequest` 的 `via` 全仓无消费方 ⇒ 集群共享令牌与行令牌等价，任意执行器可用他人 address：①pull 走含**已解密任务 secrets** 的队列（RPOP 不可回滚）；②读他人终态执行记录；③心跳/注册拿回调 HMAC 密钥 `tokenHash`；④注册用新 startupId 轮换他人令牌（身份接管）；⑤SOP 协作面以他人身份轮询。修法：pull / terminal-states / SOP 协作要求 `via === "per-executor"`；心跳共享令牌仍可用但扣留 tokenHash；注册只在「该行尚无 per-executor 凭据」时引导发放，已有凭据时禁止轮换并扣留 tokenHash（`credentialWithheld`）。新增 shared-token 安全 spec 6 例。
  - **交付（`a5a39411`）**：收编并行流的 CRON-GUARD util（`guardedCron`，6 条单测）——executor.service 的 3 处 @Cron 接线与 SEC 修改同文件、无法按 hunk 拆分，已随上一提交落地；commit message 如实披露。
  - **验证**：admin-api tsc 0；executor + sop 模块 **58 套件 1341 例**全绿；**HEAD 在隔离 worktree + 真实 node_modules 下 tsc 0**（证明 HEAD 可编译，不受并行流未提交改动干扰）。
  - **并发说明**：同仓并行流正在实现审计波（cron-guard、dashboard label、SSE 可见性、SDK、web 设置页等）。本会话只提交自己的显式路径；`executor.service.ts` 因双方同文件，SEC 提交带入了其 3 处 CRON-GUARD 接线（已在提交信息说明）。
  - **下一轮入口**：SEC-R3-3（日志写入归属：需决策是否放弃 legacy 共享令牌写日志）、db-1 残差（invalid index 自检/runbook）、db-2/db-3/db-5（排序键/outbox partial index/并发 DDL）、executors 跨端一致性（EXEC-01/03/04）。派发前对照 HEAD。

- **本轮（2026-10-29 第四轮 → CI/本地门禁对齐 + 桌面锚点 + 依赖安全 + 审计波归档，main）**：
  - **编排**：3 个写线程并行（桌面 claim ledger、npm-audit 单一事实源+ci-local、主会话做 CI/迁移/依赖），写域不重叠；施工中发现**同仓并行 agent 已从审计转入实现**（cron-guard、dashboard label、SSE 可见性、SDK 文档等同时在改），本会话一律只提交自己的显式路径，未触碰其工作区改动。
  - **交付（`aefafd1d`）CIR-01/02**：新增 `desktop-selftests` job 让 60 个桌面 selftest 随 develop push 跑（原先只在 PR/手动门控 job 里）、给 `check-desktop-selftests-wired` 补「必须存在随 push 运行的 test:main」判据（只认 YAML run 行，反证转红）；覆盖率 job 补 `--retryTimes=2`（它是唯一无重试的 jest 运行）。
  - **交付（`84e4c906`）db-1**：7 条 `transaction=false` 的 CONCURRENTLY 迁移补会话级 `SET statement_timeout=0` + finally RESET（连接池 30s 会取消建索引并留下 indisvalid=false 索引，IF NOT EXISTS 永不修复）；`check-migrations` 增加对应静态判据（注释先剥离），负例实测报错。
  - **交付（`f5336d1f`）CIR-03/04**：npm-audit 豁免判定抽成 `scripts/check-npm-audit-exemptions.mjs`（GHSA 为键、fail-closed、--retries 只重试瞬时失败），CI 与 ci-local 共用；ci-local 补齐 `typecheck:specs`、两处 `--coverage`、acf-cli/mcp-server 的 build 前置与 mcp probe，并修正过期阈值/头注。顺带修掉 dependency-review 解析器把注释里的 `known='...'` 当成活跃清单的盲点。
  - **交付（`e28be1be`）desktop claim ledger**：待重发 id 落 `<workDir>/agent-journal/requeue.json`（原子写、结构校验、7 天陈旧、fail-open），poll 后处理前记账、终态回报后撤锚、恢复时并入定向重发但丢弃 awaiting_reply 的 id；3 张上限填满的轮次不做「未返回即删」对账。〔2026-10-30 更新：这条已被重做为「证据计数」——点名要重发却没返回的 id 记 misses，连续 5 轮才删，其余保留并下一轮继续 requeue；截断轮/未请求不计数。见 `requeue-ledger.ts` 的 `markMissing`/`REQUEUE_MISS_DROP_THRESHOLD`。全量 selftest 450 ✔/0 ✘。〕
  - **交付（`3652dea6`）依赖安全**：修掉两条当天新披露且可修的 moderate CVE（qs→6.17.1、@hono/node-server→2.1.5，只动 lockfile、不加豁免）；顺带修出 executor-node `persistExecutorInstanceId` 回落丢 opts 的环境依赖 bug（开发机恒红/CI 恒绿）。
  - **归档（`d3ac7d92`）**：第 3 轮并行审计全量 8 域 53 条 + INDEX（含工作区实测校正、合并分组、rt-5 上调 P1）。
  - **验证**：executor-node 1321 例、mcp-server 321 例、admin-api 迁移套件 314 例全绿；desktop tsc + agent-host selftest 全绿；新守卫 selftest 31 条；check-dependency-review(+selftest)、check:guards-wired（39 脚本）、check-docs、PyYAML ci.yml 解析全绿；npm audit 5 面 exit 0。
  - **下一轮入口**：SEC-R3-1/2/3（共享令牌 ≠ per-executor：pull 可收割他人明文 secrets）为最高优先；随后 OBS3-01（看板 label 大小写）、db-1 残差（invalid index 自检）、db-2/3/5。派发前先对照 HEAD——并行流可能已落地（cron-guard / dashboard label / SSE / SDK 文档正在被改）。

- **本轮（2026-10-29 第三轮 → backlog 收尾：数据/工具/桌面/前端/守卫五路并行，main）**：
  - **编排**：3 个实现线程并行（桌面预算与重发、工具超时与脱敏、主会话做 appendStep + 前端），互不写同一文件；同时发现**同仓还有另一路并行 agent**（doc-guard 与 CI 审计报告出现在工作区）——已按新纪律「只读复核 → 跑其守卫 → 显式路径收编」处理。
  - **交付（`9bce96fe`）data-3**：appendStep 的 23505 真正重试（3 次，重算 MAX(seq)，非唯一冲突不重试）；run() 循环体加兜底 catch——未预期异常收敛 failed 而不是被 processor 吞掉留下 30 分钟僵尸 running。
  - **交付（`a49ba0f5`）TOOLS-04/06**：超时先 abort 再 reject（AbortSignal 经 AgentApiClient 可选第二参透传）；写/危险 tier 超时改「结果未知 + 先只读核实、不要重试」，且不计入熔断；结果落库前脱敏（digest 保留、sha256 按原文、content 保留事实）。
  - **交付（`cb9b75ec`）obs-2**：「新建 Agent 会话」入口（类型/标题/可选 JSON 上下文），补上设计文档承诺的人工对话；zh/en 词条 + i18n 双守卫 + 2 条 UI 用例。
  - **交付（`a4947bd6`）desktop-budget/resend**：plan 抛错回退该轮 iterate（墙钟不回退），宿主落盘 `transientRequeues` 并在连续 20 次无产出后继以「LLM 链路持续不可用」收敛；彻底删除 `resendAssignmentsOnNextPoll` 全局通道，关闭分支逐张定向重发。反证：旧码 tick16 复现「迭代轮次已达上限」，新码 tick20 才以链路原因收敛。
  - **收编（`327de919`/`f7dee8c3`）并行产出**：DOC-GUARD（文档指标名 ↔ 注册表双向比对 + 基线棘轮 + 15 条 selftest + CI 接线）与第 3 轮 CI/CD 审计归档（11 条未登记项，已排进 playbook §7）。
  - **验证**：admin-api **380 套件 6603 例**全绿；admin-web **255 文件 2126 例**全绿；desktop tsc 0 + 三个相关 selftest 全绿（子代理全量 `test:main` 377 项 exit 0）；`check:metric-docs`（15/15 + 实扫）、`check-guards-wired`（38 个脚本全部接线）、`check-docs`、迁移/条件写守卫全绿。
  - **残差**：AbortSignal 无 handler 消费（取消仍是通知）；瞬态回退只覆盖「plan 未返回」；待重发 id 仍只在内存（建议 claim ledger）；CIR-01~07 待做。
  - **下一轮入口**：playbook §7 的 CIR-04/03/01/02（成本低、对 CI 可信度收益高）+ desktop claim ledger + TOOLS-04 的 handler 可中断化。

- **本轮（2026-10-29 第二轮 → 审计 backlog 清偿：审批文案/自由文本/桌面丢单/清扫观测，main）**：
  - **审计编排**：首轮 5 路只读审计的 backlog 按优先级清偿；并行启动第二轮补审（data 完整性/迁移/多实例、obs 指标/UI/文档真实性）补首轮输出截断的缺口。
  - **交付（`d9660f52`）TOOLS-02**：grant 后重放文案按审批单真实状态渲染（granted→「立即用相同参数重新提交」/denied→不得重试/consumed→已执行/pending→等待审批）。根因：执行只在模型重提时发生，而旧文案叫它「请勿重复提交」⇒ 已批准动作永不执行、会话还收敛成 succeeded（假成功）。审批读取口用 `setApprovals` 装配式注入，只在有待审批行时查询，未装配/读失败 fail-open 回落 pending 文案。
  - **交付（`0ce35425`）TOOLS-05**：`AgentToolSpec.freeTextFields` + 扫描跳过 DANGEROUS_PATTERNS（保留长度/深度闸）。多行 SOP YAML/正文、update_task 脚本 patch、澄清答复此前必被 `invalid_params` 拒；刻意不豁免 `trigger_task.params`（既有安全用例要求扫）。
  - **交付（`d566533c`）桌面两缺陷**（子代理实现 + 主会话独立复跑）：poll 多张指派只消费第 1 张 → 合法但本轮不跑的收进 deferred，跑完按 id 定向重发；GAP-3 瞬态续跑改按 id（全局 resend 会把 awaiting_reply 的单重建 journal 重跑、随后答复被 ACK 丢弃），入口加窄守卫 + 每 id 只回排一次。验证：desktop tsc 0、agent-host selftest 全绿（354 断言；反证还原旧实现 15 项转红）。
  - **交付（`1143c0f5`）RT-4**：陈旧 running 清扫逐会话记 `autoflow_agent_sessions_total{kind,status}` + 一条聚合 ERROR 通知（不逐条推送，避免告警风暴）。
  - **过程事故（如实）**：`git add -A` 把子代理正在写的桌面文件卷进了 TOOLS-05 的提交，已用 `reset --soft` 拆分为两个独立提交（`0ce35425` + `d566533c`），历史干净、工作区无遗留。教训：并发子代理工作时只用显式路径 `git add`，永不用 `-A`。
  - **验证**：admin-api tsc 0；agent 模块 17 套件 317 例全绿；边界 53 例；四个 agent 守卫脚本待本轮末复跑；desktop agent-host selftest 全绿。
  - **同轮续批（第二轮补审后）**：
    - **第二轮补审**（并行 2 路，补首轮输出截断的缺口）：data 域 4 条（2×P1）、obs 域 5 条（1×P1）。核心结论：GAP 系列修复本身正确，但**两个跨模块接缝没合上**——挂起恢复不重开墙钟、保留期把可恢复态当可丢弃数据；观测面则是「指标名/help 承诺令牌量、实际记步数」。
    - **交付（`c023df3d`）TOOLS-02 硬化 + 数据审计 #1/#2/#4**：①runtime 在 markRunning 之后、rebuildMessages 之前确定性重放「awaiting_approval + granted」的调用（执行体新增 `replayApproved` 就地更新原台账行，避开 GAP-5 唯一索引、不重复累加计数）；②markRunning 从 waiting_input 恢复时重开墙钟（等待时间不是工作时间；成本闸门仍累计）；③保留期删除加 EXISTS 复查 + reopenForResume 条件写加「steps 未清理」谓词 + controller 对已清理上下文的 failed 会话如实拒绝恢复；④read 档 tool_calls 清理加终态闸。
    - **交付（`ea2509a6`）观测审计 P1/P3**：`recordRuntime(name, labels, value)`，令牌指标传实际令牌数（此前是步数，成本低 2~3 个数量级），`alerts.yml` 的 dimension→direction；新建承诺已久的 `agent-metrics-labels.spec.ts`（kind/终态/labelValueSets 三方比对）；前端移除 budget_exceeded 的死「恢复」入口；设计文档 02 §7.1 改为实际六条指标 + 残差注记，§5.1 如实标注「仅 HTTP，暂无 UI」。
  - **下一轮入口**：playbook §7 剩余项——data-3（appendStep 序列冲突重试）、desktop-budget、TOOLS-04/06、desktop-resend 残差、obs-2（chat UI 做还是摘）、doc-guard（文档指标名自动比对）。

- **本轮（2026-10-29 → 多 Agent 审计-修复循环第 1 轮：5 路并行审计 + 11 条修复，main）**：
  - **编排**：按用户要求「同一时刻至多 5 个 agent」跑了一轮只读审计流水线（runtime / tools / desktop / data / obs 五域，workflow `agent-domain-audit`），产出 **27 条 finding（6×P1 / 10×P2 / 其余 P3）**，每条带文件:行号、逐字代码、触发路径、现有测试覆盖判断、最小修法、langgraph/langchain 对照。方法论文档化为 [`AGENT-SWARM-PLAYBOOK.md`](AGENT-SWARM-PLAYBOOK.md)（域划分、写冲突规则、验证矩阵、反模式、未修 backlog）。
  - **交付 1（`dc3b1ffb`）GAP-3 服务端 + GAP-6**：原半成品把瞬态耗尽会话落 `failed` 再排 delayed job——failed 是终态，job 回来被 `run()` 短路，续跑**永远不会发生**；且「每会话一次」用进程内 Set（多副本 N 次、重启无限）。改为：`claimAutoResume`（迁移 0074 `autoResumeCount` 条件写）→ 先入队 → 挂起 `waiting_input(auto_resume)` → job 走同一条 `run()`。顺带修出 GAP-6：对 `failed` 会话点「恢复」此前是静默 no-op（controller 回 ok:true、job 入队、run() 立刻让位），新增 `reopenForResume` 条件写；`budget_exceeded` 明确拒绝。**守卫保真**：GAP-1 改了 `markRunning` 返回契约但 `scripts/agent-runtime-check.mjs` 替身仍返回 undefined ⇒ `test:agent` 在 HEAD 上整段红，替身按 ADR-027 补齐。
  - **交付 2（`574bbf3b`）首轮审计 P1/P2 六条**：①TOOLS-01 —— `availableTools` 用 `AGENT_TOOL_SPECS` 过滤，6 个 `sop_*` 内部工具**从不下发给模型**（白名单有、闸门认得、执行体已绑定，唯独模型看不到），SOP 全链路静默不可用；测试还把「另行注入」写成期望（该通道不存在）。②RT-1 —— 我刚写的 jobId `auto-resume:${id}` 只有 1 个冒号（2 段），BullMQ `validateOptions` 在写 Redis 前直接抛错，自动续跑 100% 排不进去且额度被烧；抽纯函数 + 单测复刻规则。③RT-3 —— delayed job 裸 sessionId 唤醒会接管 60s 内转去等审批的会话，改为 job 携带 `expectWaitingFor` + `markRunning` CAS（`IS NOT DISTINCT FROM`）。④RT-2 —— 清扫阈值 30min＝出厂墙钟 30min，恢复必然立刻 `budget_exceeded`；人工 reopen 现在给新墙钟窗口（成本闸门仍累计，自动/审批路径不重置）。⑤RT-6 —— 循环内复查终态，被清扫后立即停手。⑥RT-5 —— 兜底台账按最长保留期记 write。
  - **交付 3（`cac3bbcb`）TOOLS-03**：`deploy_app` 的 schema 用 name 而 scope/执行体用 applicationId（scope 恒不命中或部署空 id）；模板工具读不存在的 `templateId`（恒 NOT_FOUND）且丢弃必填 name；`create_application` 丢 version/runtime（23502）。三者按 schema 对齐。
  - **验证**：admin-api **377 套件 6560 例**全绿（改前基线同量级）；agent 模块 17 套件 307 例；`tsc` 0；改动文件 eslint 0；`check-migrations`（119 个、下一可用 1790000000075）/`check-conditional-writes`/`check-guards-wired`/`check-docs` 全绿；四个 agent 守卫脚本全绿。
  - **未修（backlog 见 playbook §7）**：TOOLS-02（审批 grant 后动作不会执行——P1，需状态迁移或确定性重放）、desktop-poll（poll 下发 3 张只消费第 1 张——P1）、desktop GAP-3 全局 resend、续跑吞迭代预算、工具超时不取消、危险模式扫描阻断多行 SOP 正文、工具结果未脱敏落库、清扫绕开 finish。
  - **下一轮入口**：playbook §7 backlog 按优先级取；建议先 TOOLS-02 + desktop-poll 两条 P1，再 TOOLS-05/04。

- **本轮（2026-10-06 → N-07 macOS 侦察 + N-08 SOP 生态演示包，Linux 侧 develop）**：
  - **N-07 done（macOS GUI 后端侦察稿）**：`docs/design/agent-and-deployment/13-executor-gui-macos.md`（新）+ roadmap 两处同步（§2 矩阵行 + §9.9 残差行）。**结论=可行性成立但缓议（2026-10 不立项）**：与 12 号 Wayland 的「本质冲突」不同，七条不变量在 macOS 全部有承载形态（CGEvent 注入 + NSWorkspace/CGWindowList 免权限复核 + ScreenCaptureKit 窗口级截图）；张力不在「能不能复核」而在「TCC 进程级一次性授权 = 复核是本进程自律」——与 Windows 同构非否决级。缓议三理由：真机验证条件缺席（本稿零实测如实声明）、N-05 上游未通、macOS C/S 需求信号为零；签名/公证流水线（TCC 硬前置）若因发布成熟度先行可作为重开触发器。重开触发条件 + S0 POC 判定门四项实测清单见该稿 §5。12 号 §5.3「独立侦察」待拍板项就此收口。
  - **N-08 done（SOP 生态演示包）**：`scripts/demo-seed.mjs` 扩展——3 条演示 SOP（demo-sop- 前缀：browser/filesystem/gui 三能力域各一，frontmatter 按发布门全绿形态手写），**零配置链设计 = platform 验收锚点引用 seed 自建任务 id**（uuid——复核会话 scope 闸门精确比对 id，传任务名会被拒）；幂等 = draft 按 slug 复用 + 已发布不动（不覆盖演示期间人工改动）。`demo-seed.selftest` 16→18 例（SOP 分页契约 + frontmatter 行级结构 + 07 §6.1 正文骨架 + GUI 前置条件）；另用 admin-api 编译产物 `validateFrontMatter strict` **真发布门**离线过 3/3。**真机 e2e**：acf-repro PG(15499)/Redis(16399) 起真 admin-api（迁移追平 …0053）——首轮 3 任务 + 3 SOP 起草发布，二轮完全幂等，版本快照 v1.0.0 + frontmatter 内嵌任务 id 绑定核验。教程 05（`docs/tutorials/05-sop-agent-demo.md` 新，三档前置分层：零配置内容面 / 需 LLM Key 执行面 / GUI X11 面）+ index 五篇化。
  - **顺带抓 1 契约缺陷（若直连真实环境 seed 必死）**：`/api/sop` 列表返回 `{items,total}` **无 totalPages/pageSize 元数据**（与 tasks 端点全元数据形态不同）——既有 `listAll` 的严格校验（totalPages mismatch 即抛）对它会炸；修 = 新增 `listAllSops`/`aggregateSopPages`/`sopPageCount` 专用契约（total 推导页数 + id 唯一性），不动既有严格路径。另 publish 返回 `{sop, version: SopVersion 实体}`，日志取 `version.version`。
  - **子代理平台 note**：Explore 子代理启动仍报 reasoning-level-missing（今日一次），按降级纪律主会话直落。
  - **遗留/下轮**：任务池 N-01~N-13 全清（N-05 维持暂缓待 DashScope）；三项低优先滚动项（见记忆/板）。

- **本轮（2026-10-06 → 接手 Win 侧交接 + N-06 打包接线双项完成，Linux 侧 develop）**：
  - **接手验证**：拉取 c46d88c6..555bd81d（Win 侧升级战役 + 5 轮 CI 收绿）；按 HANDOFF-2026-10-05 §三清单本机全绿——test:api 4567 / node 1056（13 skip）/ web / cli / mcp / desktop / typecheck / bundle-drift / docs-sync 全 PASS；仅 2 个本机环境项：python 套件 `python`→`python3` 别名缺失（CLI 名问题非代码）+ test_sandbox 两个 rlimit 预存红（2026-09-26 已登记）；`check:env-drift` 脚本名已改 `test:env-drift`（交接文档口径过期，新名绿）。
  - **N-06 done（打包接线双项，07 §4.2 完整形态）**：① AgentHost+CollabClient 整体拆入 `src/agent-worker/main.ts` 独立子进程（esbuild 单文件 bundle + ELECTRON_RUN_AS_NODE + stdio JSON 行协议），主进程只留定时器/配置热同步/身份状态机/托盘快照；worker 崩溃 tick 自愈、身份替换 disableAndStopAfterWork、退出硬杀（journal 恢复兜底）。② 打包态 Playwright：esbuild 内联 playwright-core（electron 启动器链 alias 到 stub 包，防 223MB electron 资产入包；ncc 0.45 实测做不到故换 bundler），browsers.json/package.json 走 packageRoot 契约，Chromium 经 ACF_BUNDLE_PLAYWRIGHT 发布门只装 headless-shell（266MB；`ACF_PLAYWRIGHT_REQUIRED=1` 硬闸）。守卫三层：agent-worker-bundle.sha256 双闸（语义+CI 重打字节）入 desktop-bundle-drift job、check-desktop-agent-packaging.mjs 18 锚点、test:main 真 bundle 冒烟。**验收**：本机 AppImage 1.7.1 解包——包内 electron 跑包内 worker ready 探针 PASS + 包内浏览器 launch PASS；test:main 全绿（41 selftest）。**踩坑**：ncc externals 不拦 node_modules 深层 require；esbuild alias 须包目录；spawnSync env 必须嵌 `env:` 键（自检抓到）。**遗留**：win/mac 包内解包对账未做（staged 校验已上）；N-05 仍暂缓，下轮候选顺位不变。
  - **子代理平台 note**：Explore 子代理启动仍报 reasoning-level-missing，按降级纪律主会话直落（与 2026-10-02 同型，第三次复现）。

- **本轮（2026-10-02 → metrics DI 根因收口 + N-02③ 温和下放实施 + Win 侧对账简报，develop 工作区）**：子代理平台全天复现 reasoning-level-missing，按既有降级纪律主会话直落。**改动尚未提交**（16 文件在工作区，等用户确认后一次 commit 推 develop）。
  - **metrics 守卫 DI 之谜根因收口**（c900865e 遗留"成因待查"）：Nest `reflectConstructorParams` 合并 self-declared deps 用**原型链敏感**的 `Reflect.getMetadata`——基类 JwtAuthGuard 构造器 index[1] 的 `@Inject(API_KEY_AUTH_FACADE)` 沿原型链覆写子类 MetricsScraperAuthGuard index[1] 的 ConfigService 类型推断 → 按不存在 token 解析失败 → @Optional 吞成 undefined（strict-clone 探针实证 Nest 报 "argument API_KEY_AUTH_FACADE at index [1]"；TS 6 对 `ConfigService | undefined` 的元数据 emit 正确，嫌疑排除）。修复=守卫参数显式 `@Inject(ConfigService)`；DI 装配回归测试组入 spec（真装配断言 + 上游行为锁定）。**Nest 上游 issue 待报**（reflectOptionalParams 用 getOwnMetadata 而 self-deps 未做同样限定，同文件注释自相矛盾）。
  - **N-02③ 产品拍板（AskUserQuestion 留痕）：温和下放并实施完毕**——executor.controller PATCH `:id` / reload-config 移除 @Roles(ADMIN)，判定下沉 assertCanManageMetadata（ADMIN 短路 + 项目 editor+；projectId=null 平台级执行器非 ADMIN 恒 403；@Optional 缺席退化仅 ADMIN fail-closed）；A2 声明 `@WriteGuard("executor",{scope:"ownership"})` + `executor:write` 落证 + 穷举守卫清单显式登记；rotate-token/set-offline/DELETE 与 executor-package 不动；admin-web 详情页按钮拆分（列表页批量入口维持 ADMIN）。**验收**：RBAC 矩阵 +6、admin-api 253 套件 4206 例绿（基线 4199 只增）、admin-web 176 套件 1346 例绿、双端 lint/tsc 绿、swagger/api-types 同批（纯描述 diff）。N-02 整条 **done 销账**（①②④ 轮 28 已复核兑现）。
  - **N-05 前置拍板：暂缓**（DashScope 暂不开通；条目已注记，下轮候选顺位 N-06 > N-07/N-08）。
  - **Win 侧对账简报落档 `docs/archive/handoffs/handoff-2026-10-02.md`**（v1.7.0 发版对账 + N-14/N-15 + chaos 七场景 + 9 条真缺陷清单；npm 三包 1.7.0 registry 实测；PyPI 本机网络未复核如实注明）。上会话遗留"N-14 kill 链路未实测备注"**未找到**（穷尽 PLAN-CLAIMS/CHAOS/AGENT_HANDOFF/atlas；候选=场景③D3/场景⑤E3/QA-03 py trace 遗留），未强行改。

- **本轮（2026-09-28 → 轮 30：executor-desktop 客户端 UI 全面深度优化，codex/executor-client-ui）**：用户在 codex 基线（`f45f1049`/`cdfbb247`/`b68afe5d` 已完成体系化重构与图标收口）之上，认为 zcode 接手那轮「很一般」，指定**均衡全面升维**（视觉精致 + 排版节奏 + 交互反馈三路并进），聚焦 `apps/executor-desktop` 渲染层。
  - **方法**：先通读 renderer 全部页面与 2289 行 app.css 建立问题台账，按自测守卫锚点安全增强；每步跑 `renderer.selftest` + `tsc --noEmit` + `vite build` 三件套，最后用 `e2e/screenshots.cjs` 真实启动应用逐页截图，并经两轮独立视觉评审迭代（第一轮抓出"大片死空/ID裸露/应用卡片无锚点/已停止态平淡"四处真实短板并逐条修复，第二轮确认升维）。
  - **视觉/排版升维**：
    - 状态页 hero 横幅从「孤立小圆点」重构为**状态图块 + 内嵌状态点**（`.hero-glyph`/`.hero-indicator-dot`），加动态图标（online=activity / offline=warning / 其余=server）与运行徽章；「已停止」态副文案与标题对比度补强（此前灰字几乎不可读）。
    - 连接信息行加图标（server/link/globe）；Agent 卡片加状态点（复用 `.agent-status-dot`）。
    - Tab 栏加**激活指示条**（`.tab.active::after`）；标题栏品牌图标收口到公共 `Icon` 组件。
    - 应用卡片加**色块头像**（`.app-avatar`，首字母/未知态 `?`）；应用工作目录路径改为**芯片样式**；执行 ID 改为**可点击复制芯片**（替代裸露原始数据）。
    - 历史组头统计改为**摘要胶囊**（`.history-stat-summary`），成功/失败计数只在非零时显示，减少零碎感。
    - 空态（Apps/History）加**引导文案 + 引导按钮**；Wizard 欢迎页加**品牌 hero 块**（`.wizard-hero`）。
    - 日志区字号 12→12.5、行高 1.7→1.75、对比度提升；历史/应用列表区 `flex:1` 收尾，消除宽屏下部大片纯黑死空。
  - **交互/一致性升维**：
    - **结构化日志着色全面统一**：把 `FormattedLogText` 从 StatusWindow 提取为共享组件，Status/History/Apps 三个日志查看器统一「时间/级别/正文」三段着色（此前仅 Status 有）。
    - **图标体系扩展 12 枚**（copy/box/activity/cpu/server/play/stop/eye/eye-off/info/download/clock/layout），全部走同一 24 viewBox / currentColor / 1.8 描边规范；为 15+ 个纯文字按钮补充图标（启动/停止/清空/清除/确认/定位/查看日志/测试连接/检查更新等），消除「纯文字按钮」与「图标按钮」混用的不一致。
    - 运行中徽章加**脉冲点**（CSS `::before` 生成，替代硬编码 `●` 字符）；pending/保存中按钮加 `icon-spin` 旋转反馈。
    - 「已停止」徽章从复用 offline 改为独立 `.badge-stopped`（对比度更清晰）；停止态 hero 卡片加边框与微渐变。
  - **验证**：`renderer.selftest` 全绿（设计 token/可访问性/对比度/焦点/布局/IPC 锚点/F-21/F-22/F-37/DSK-05/PERF-DSK-01/SEC-DSK-01/EXP-04/05/06/09 等全部守卫）；`tsc --noEmit` 0 错；`vite build` 绿；`npm run test:main` 全绿（含 agent-host e2e 与全部主进程自测）；`e2e/screenshots.cjs` 16 页截图全部生成且两轮视觉评审确认升维。
  - **未动**：主进程业务逻辑、admin-web/api、IPC 契约、CSP、自测守卫语义。新增文件 `components/FormattedLogText.tsx`。
  - **下一步（可选）**：窗口默认尺寸与内容密度的联动（宽屏下部仍偏空，需产品定默认窗宽）；历史失败行加「重跑」闭环；未知应用的「重新识别」引导。

---

更新时间：2026-10-06（N-07 侦察稿 + N-08 SOP 演示包 done；详情见状态快照首条）
当前分支：`develop`

## 状态快照（历史）

- **本轮（2026-09-27 → 轮 29：N-12 / N-09 / N-11 / N-10 四项推进，develop）**：轮 28 后继续（轮 27/28 详见下两条快照）。**全部提交已推送且 CI 逐笔验证绿**。
  - **N-12（ARCH-23 OpenAPI→前端类型）→ 三批落地，覆盖率 34→50（16.3%→24.0%）**。**★ 认领前复核改变了任务定位**：生成链路**早已全通**（openapi.json 已提交、`gen:api-types` 可跑、CI `api-types-drift` 三道闸齐备），重跑零 diff；卡住的**真因在后端**——实测 208 个 2xx 里 **174 个（84%）没有 schema**（只写 `description:""`），没有 schema 就没有可生成类型。缺口：Task 27 / sop 13 / Executors 12 / App Deployment 11 / System Config 11 …
    - **交付①守卫**（`74afb6f8` + `9b5758fa`）：`check-openapi-response-schema.mjs`（23 项有齿自检）——覆盖率**只增不减棘轮**，按 `METHOD PATH CODE` 条目钉住（非只记百分比，否则"补 3 个又删 3 个"被掩盖），接入 CI `api-types-drift`。**★ 该守卫首版有假绿**：只看 `res.content` 是否存在，把「引用了**空壳 schema**（实体类无 @ApiProperty → `properties:{}`）」也算已覆盖——实测**9 条既有条目本来就是空壳**。已修为：空壳不算覆盖 + 单独计数 + **新增空壳即红** + `--report` 列清单。
    - **交付②补覆盖**：Auth 5（TOTP setup/enable/disable + sessions 列表 + revoke-others）+ Application 4 + Projects 8（`9b8bb0f5`）+ Executor Package 4（`fcfffc36`）。**过程中纠正多处我自己写错的契约**（"文档按想象写"比没有 schema 更坏）：`totpDisable` 返回 `{disabled}` 而非 `{enabled}` 且对未开启账号返回 `{disabled:false}` 仍 200（幂等）；Projects 的 `findOne/create/update` 返回**实体**不带 `myRole`（故拆 `ProjectEntityDto`）；`myRoles` 实际是 `{userId,isAdmin,memberships[]}` 而非我臆测的映射形态；`platform`/`filename` 实体为 nullable 而非非空。
    - **顺带纠正一个契约层问题（非安全缺陷）**：`ExecutorPackage.filePath`（"Absolute file path on the server"）**真的会进响应体**。该控制器类级 `@Roles(ADMIN)` → **泄漏面仅限管理员，不构成对不可信用户的泄漏**；但不该进对外契约文档 → DTO 显式排除。**未改运行时行为**（响应体仍含，仅契约不声明），已在 commit 写明供后续决定。
    - **过程教训（如实）**：`74afb6f8` 只跑了自建守卫就提交，**没跑同 job 的既有 PK-15 空 schema 守卫**，CI 当场红（`Application` 空壳超白名单）。与既有 lint 教训（"改前只跑了 check:lint-gates 配置面"）同型——**新增/修改守卫后必须跑它所在 job 的完整命令序列**。
    - **导出 e2e 的方法论注记**：需 PG+Redis，且**不能用带历史迁移残留的库**（本机 `autocodeflow` 库在半迁移态失败：`type "task_blockstrategy_enum" does not exist`）；正解是建干净临时库（`DROP/CREATE DATABASE acf_openapi_gen`）导出、用完即删。
  - **N-09（QA-10 微基准）→ 补 load-score 场景 + CI 接线，并当场暴露一个真实生产缺陷（已修）**（`9b5758fa`）。**① 新增 `load-score` 场景**：与既有 `dispatch-decision` 刻意区分——后者度量"500 候选筛选+排序"（O(n log n) 主导），前者度量**单点公式**；两者退化诱因不同，单点退化会被排序噪声淹没。**② ★ 该场景当场暴露注册/心跳采纳域不对称**：心跳经 `isAdoptableMaxConcurrentTasks` 钳正整数 1..10000（注释写明"防止写入荒谬容量饿死派发闸门"），而 **register 路径零校验**（DTO 连 `@IsInt`/`@Min` 都没有）。实测后果：`maxConcurrentTasks:0` 落库后 ① `runningTaskCount/0` → **Infinity**（`Infinity.toFixed(3)` 仍为 Infinity，JSON 序列化成 **null**，决策日志 score 失真）② `selectLeastLoaded` 容量闸 `0 < 0` 恒 false → **该执行器被永久排除在派发之外**（"注册成功、永远收不到一个任务"，与 P0-2 bindAddress 同型）。修法与心跳**同口径**（非法值视同未上报，不写 DB）。+5 例回归，**反证**：还原未校验版本 → 4 例转红。**③ CI 接线**：新 `benchmark` job，`selftest` 每次 push 跑（逻辑闸）、阈值门只 schedule/手动跑（共享 runner 抖动会假红，假红的闸等于没有闸）。
  - **N-11（Linux 打包/自动更新）→ 更新链元数据守卫**（`b2a70876`）。复核：`dist:linux`、`electron-updater`、updater 模块、CI job、release-desktop 三平台打包+uv 校验**均已在位**；缺的是「更新链」可静态验证的那一半。**为什么必须静态拦**：electron-updater 靠三处元数据对齐（builder 的 `artifactName` ↔ latest-*.yml 的 url ↔ publish/updater 源语义），错位时**打包成功、安装成功、更新永远 404**，而 updater 对 4xx/5xx **一律静默 log.warn** → 用户侧只是"点检查更新没反应"，**CI 全绿**。本仓实爆两次（`desktop-v1.5.1` 嵌套 `AppImage:` 键致 scheme 校验三平台全挂；`v1.5.0` SDK 抢 `latest` release）。守卫 14 项自检，**反证**：复现嵌套形态 → exit 1。**修了守卫首版假阳性**：只支持 publish 列表形态，而本仓用映射形态 → 误报"无 publish 段"（与 N-12 教训同型：**守卫首版必须先喂真实配置**）。
  - **N-10（Electron e2e）→ 补计划点名三场景，7/7 真跑通**（`8e4893e2`）。**认领前复核发现计划与实现交集为空**：计划写"注册/托盘/任务面板"，原 spec 覆盖的是"启动/preload/主窗口/退出"。按 IPC 真实契约补测（走 preload 通道，不断言主进程内部对象）。**④ 顺带修复长期失守的守卫**：既有「通道白名单不漂移」用例**当时是红的**——白名单 32 个、运行时 **41** 个，漏 9 个；**长期无人发现因为该 job 是 PR/dispatch 门控、develop push 不跑**。**反证**：注入 `probeExtraChannel` 并**按 CI 口径 `npm run build` 重建 dist**（关键——e2e 跑 prebuilt `dist/`，不重建则改动不被拾取，我第一轮反证因此假绿）→ 用例转红；还原+重建 → 绿。
  - **待办**：轮 29 余项 N-06（host 拆子进程 + Playwright 分发）；轮 30 N-05（需 DashScope）、N-07（macOS GUI 侦察）、N-08（SOP 演示包）；滚动项 Xorg 复跑/跨机；N-02③（能力扩张，待产品拍板）。
- **本轮（2026-09-27 → 轮 28：N-04 迁移收尾 + N-02 复核销账，develop）**：轮 27 三项清偿后继续推进（三项详见下一条快照，均已推送且 CI 绿）。
  - **N-04（i18n 迁移收尾）→ done（两个 commit）**。**★ 先修正任务前提**：计划行写「清点未迁移页面并完成」，实测基线 105 处**并非都需迁移**——逐文件回读源码按「中文串是否真的会渲染给用户」分四类：**REACHABLE 40**（`api/tasks.ts` 36 + `api/event-subscriptions.ts` 4，`Error.message` 经 `StateError`（:44-47 实测读 `error.message`）直渲）／**FALLBACK 55**（全部是「可选 `t` 参数的中文缺省值」）／**DATA 5**／**DEAD 4**／DEFAULT 1。
    - **首刀**（`cfb92293`）：清出 `executor-mode.ts` 的死 `labels` 映射（值从未被渲染——循环只取 `Object.keys`，展示由 `TaskFormPage:568-576` 按 field 逐项 `t(...)`）；**守卫补「基线陈旧」反向检查**——此前只查「新增」不查「陈旧」，导致**迁移完成后基线不会自己缩小**、"已接受 N 处"只增不减、**迁移进度无法从该数字读出**（本项目已实测踩到，正是那 4 条死数据）。反证：塞不存在的串 → exit 1。
    - **续批**（`fe6cf8b2`）：**40 处 REACHABLE 全部迁移**。`api/tasks.ts` 14 个调用点改 `i18n.t(...)`（非组件文件引用 i18n 单例，与 `api/client.ts` 的 `http.error.*` 同模式）+ 16 个新 key，**英文侧保留同等信息量**（页号/数字，排障缺一个就要复现）；`event-subscriptions.ts` 的 4 处经复核是**第二处同型死代码**（`EVENT_TYPE_OPTIONS.label` 从无消费方：Select 走 `t(eventTypeLabelKey(o.value))`、Tag 走 `eventTypeLabel(v)` 返回 `found.value` 即英文名）→ 改纯 `{value}` 清单。**基线 101 → 61**。
    - **口径澄清（供后续会话判据一致）**：N-04 的「硬编码中文源码守卫零豁免」应理解为**用户可见面零豁免**，而非"基线必须清零"——剩余 61 处是设计性 fallback（可选 `t` 缺省值 55 + DATA 5 + DEFAULT 1），强行改掉反而降低纯函数可测性与可直调性。
    - 验证：admin-web **1265/1265 全绿**（528 套件）+ `tsc -b` 0 + build 绿 + lint 0 errors + `lint:i18n` 通过（无陈旧项）。
  - **N-02（ADR-013 保留缺口清偿）→ 复核后转 blocked（`55893ee7` + 入板）**。计划纪律要求「逐项复核现状」，四项实测后**性质与原判断不同**：① **已兑现**（2026-09-15 TASK-SCOPE-01，且 `configuration.ts:390` 实测 `TASK_OPERATE_SCOPE === "any" ? "any" : "owner"` —— **默认即收紧档 owner**，宽松需显式声明，比原设想更进一步）；② **已兑现**（AUTH-02-B `0318dfe`）；④ **已兑现**（`ProjectsPage.tsx` 用 `isAdminUser` 门控）；**③ 复核后判定为「能力扩张」而非缺口** —— 实测 `executor.controller.ts` **全部写端点**均带 `@Roles(UserRole.ADMIN)`、`executor-package.controller.ts:118` 更是**类级** `@Roles(ADMIN)`，即现状**比项目角色细分更严**；故「细分」真实含义是**把权限下放给项目 editor/admin**（能改执行器元数据/轮换令牌/删执行器的席位变多），与 ADR-013 §2「只增放行、不收紧」方向相反，**必须产品拍板**。附实测：`executor.projectId`/`executor_packages.projectId` 两列**已存在**（迁移 1790000000009）但**全仓零处读用**（模块内 grep 仅命中实体定义，计数=1）——拍板后可直接接判定，无需再动迁移。ADR-013 §3 已追加 2026-09-27 更新段为事实源。
  - **待办（轮 29/30）**：N-06 打包接线（host 拆子进程 + Playwright 分发）、N-10 Electron e2e 扩例入 CI、N-11 Linux 打包/自动更新真机、N-05 P7d 端到端（需 DashScope）、N-07 macOS GUI 侦察、N-08 SOP 演示包、N-09 微基准 CI 接线、N-12 ARCH-23 复核销账。
  - **CI 状态**：轮 27 三项（`36314393614`，14m16s）**全绿**；轮 28 各次 push 的 run 随后续 push 正常 superseded（cancelled 为 concurrency 语义，非失败）。
- **本轮（2026-09-27 → 2026-10 期轮 27：N-01 / N-03 / N-13 三项清偿，develop）**：用户指令「作为负责人推进后续所有开发任务」。先把 `DEVELOPMENT-PLAN-2026-10.md` 的 N-01~N-13 任务池**注册进 PLAN-CLAIMS**（此前只存在于计划文档，而认领板是唯一认领事实源），然后按建议排期执行轮 27 三项。
  - **N-01（turbo 增量接入）→ 结论：不接入；交付 no-hoisting 守卫 + A/B 实测报告**（commit `a4fe0aea`）。沙箱 worktree 实测证伪 ARCH-28 §2 的「turbo 可增量接入、风险低」判断：**turbo 多包模式与本仓 ARCH-20 no-hoisting 互斥**——根一旦声明 `workspaces`，**8 个子项目 `npm ci` 全部 exit 1**（ERESOLVE，撞 ARCH-28 §1.5 的 161 处版本分裂）。三个让回退极难归因的放大器：① 报错文本**与被跑项目无关**（在 executor-node 里跑，报的是 admin-api 的 ioredis/typeorm）；② **部分列出时红一半绿一半**（仅列 docs-site → docs-site exit 1、其余 exit 0），最易被当 flake；③ 既有 lockfile-integrity 守卫的红**指向错误修法**（文案说"运行 npm install 同步"，而 `--legacy-peer-deps` 会把 hoist 写进根 lockfile，1→866 条目，固化破坏）。另测 runner 委派语义（turbo 按 workspace 根的 packageManager 委派，与子项目各自声明 npm 必然冲突）。单包模式缓存生效但对 CI 无收益（每 job 独立 runner）。**真实 A/B**：本机 8 包串行 28.1s → turbo 多包冷 6.2s / 热 0.02s。**交付**：`check-no-hoisting.mjs`（5 判据结构守卫 + 13 项有齿自检）接入 CI + `docs/ARCH-28b-turbo-adoption.md`（9 节实测报告）+ ARCH-28 §5.1 回填。**CI 关键路径实测（run 36300739454）**：瓶颈是 `selftests` 544s（串行自检 **518s**）与 `admin-web-build` 320s（vitest 286s），`npm ci` 仅占 2.5~10%——turbo 用不上（不是包级任务）。
  - **N-13（BUG-04 复查机制化）→ 机制落地 + 实质复查提前执行 + 顺带清偿 1 条豁免**（commit `e60c182e`）。**机制**：`check-dependency-review.mjs` 把「等人记得复查」变成「到期即红」——到期当天 fail-closed、CI 活跃豁免 ↔ 脚本注册表**双向**一致（未登记/僵尸豁免/日期漂移三类）、解析失败不放过，接入 CI。18 项有齿自检。**★ 复查核心发现**：SEC-06 当年登记的「10-01 评估 overrides 强升」计划，**两条里有一条会砸掉整条 S3 链路**——用**真实 MinIO 服务端**逐条验证：`query-string@9` → `qs.stringify is not a function`（ESM-only）；`stream-json@3` → **`require('minio')` 本身抛 MODULE_NOT_FOUND**（v3 改名 `src/jsonl/parser.js` 小写 + exports map，而 minio `notification.js:7` 硬 require `stream-json/jsonl/Parser.js`；且 `minio.js:32` **无条件 eager require**，故整条链路全废）。该破坏**不会被现有测试发现**（`s3-log-storage.spec.ts:14` 是 `jest.mock("minio")`）。**已落地**：唯一安全的 `decode-uri-component@0.5.0` override（真实 MinIO e2e 4/4 + 全量 3790 例全绿），`GHSA-vcc3-ghjq-m6fr` 清偿；`stream-json` 到期动作改为 **DO_NOT_OVERRIDE**（写进 CI 注释与注册表，避免后人重走死路）。上游状态：minio npm 最新仍 8.0.7（2026-02-27，**7 个月未发版**）。**自检抓到首版解析器自身缺陷**：全块扫 GHSA 会把注释里"已清偿"的散文当活跃豁免报红 → 改为只认 CI 的 `known='...'` 变量。
  - **N-03（覆盖率棘轮续期）→ 四档地板全部上探**（commit `8c282e4c`）。实测 stmts 87.64→**88.59**、branches 76.40→**77.58**、funcs 80.60→**82.45**、lines 88.56→**89.54**；地板 84/75/78/85 → **87/76/81/88**（反证：临时改成 99 → exit 1 并打印 `Coverage for functions (82.45%) does not meet "global" threshold (99%)`，证明地板真在生效）。**三处定向补测 +56 例（226→229 套件、3790→3846 例）**：① `agent-runtime.service.ts` **0%→fn/lines/stmts 100%**（P2 推理循环此前一行未测——补测可重入/闸门位置/失败归因三条运行时不变量的实现本身）；② `sop.controller.ts` **0%→100%**（ADMIN 管理面：跨工单答复防线、指派目标解析、工作副本语义、媒体响应头防注入）；③ `sop.service.ts` 读面+校验面+清洗面（fn 21%→46%）。**反证 6 条全部实测转红后还原**。**纪律**：不写凑数弱断言。**如实**：洼地未清完（tool-binder 59% / task.controller 57% / clamd-scan 42% 等留轮 28）。
  - **验证**：admin-api 229 套件 **3846 例全绿** + tsc 0 + 新文件 eslint 0；12 个仓库守卫全绿（含新增两个双跑）；npm audit 4→2；CI YAML 经 yaml.safe_load 校验。三次提交全部推送 develop。

- **本轮（2026-09-26 → SOP 操作面补齐 + 设置面 taskExecution 覆盖，develop）**：又一处「无 UI 即功能不可用」——**指派是 P5 的核心动作却只能 curl/MCP/Agent 工具发起**（`sopsApi.assign` 在客户端存在但从未被任何页面调用），澄清附件（截图/录屏）在 UI 完全不可见。①新增 `GET /sop/assignable-executors`：**当前租约内**声明 agent:sop 的执行器——列表投影刻意剥离短效租约字段（快照会误导），指派面走独立端点；`ExecutorService.listSopCapableExecutors` 逐台复用 `getAgentCapabilities` 的同一份 TTL 判定（不另造租约语义）。②SopsPage 指派对话框（版本 contentHash 可辨 + 执行器按租约过滤，空列表显式提示「先在桌面端启用 Agent」）+ failed/stalled/cancelled 工单行内「重派」（预填原版本）。③回传媒体可见：指派级媒体清单（端点已存在但零消费）+ 澄清条目 mediaRefs 附件按钮；查看走鉴权 blob + objectURL 新开页（直链 401，与 artifacts download 同写法）。④desktop 设置面 Agent 组补「任务执行方式」细粒度覆盖——P7e 前半的 isolated-runner 此前只能改配置文件触达；消毒层 ENUM 已含该键，零新面绕过。**验证**：admin-web tsc 0 + build 绿 + lint 0 errors + i18n 守卫通过 + vitest **1265 项全绿**；admin-api tsc 0 + nest build 绿；agent-sop-check **144 项**（+2）；desktop 主 tsc 0 + renderer build/selftest 绿。**残差**：可接单执行器判定是 N+1 查询（N≤100，规模上千需 SQL 侧 JSONB 过滤）；接管答复对已终结指派不投递（重派即恢复路径）。**下一步**：P7d 后半端到端与打包接线仍需外部环境（真实 LLM/部署机/打包产物）；macOS/Linux GUI 后端需对应平台。
- **本轮（2026-09-26 → 收敛性切片：澄清兜底 + 人工接管 + 发送重试 + 媒体清理，develop）**：沿链路推演故障挖出四个「无声死锁/泄漏」点并全部收口。①**复核兜底**：复核会话失败（LLM 不可用/预算触顶/崩溃）或 succeeded 但没调答复工具时，澄清行永远 NULL、指派永远 blocked（blocked 又被失联扫描豁免）——循环无声死锁（11 §6「澄清无人回 → 转人工」从未实现）。修法：`evaluateStuckClarifications` 纯判定（sop-timeout.ts）+ 同一 @Cron 扫描接线：会话终态/缺失立即兜底、running 超 `SOP_CLARIFICATION_REVIEW_TTL_MS`（默认 30min）兜底 → escalated_to_human + blocked 解除 + 升级通知。②**人工接管死路**：P6 收口给升级行放了回复按钮，但 replyClarification 对 resolution 已置位的行幂等返回——升级行的 resolution 在入账时就已置 escalated_to_human，**人答了也落不了库**。修法：幂等豁免 escalated 行（接管改 resolution + updatedAt 前移使投递游标重新未覆盖）；已答复行仍严格幂等。③**发送失败自愈**：sendClarification 网络失败时 journal 停在 awaiting_reply、中台从没收到。修法：journal 记 `lastSendError`，同 tick 先试快恢复、跨 tick 用同一幂等键重试（服务端去重不产生第二条澄清），成功清除。④**媒体泄漏**：sop-media 头注写了「30 天保留清理按目录整删」但服务从未存在，截图/录屏（单文件可达 100MB）无限累积。修法：`AgentMediaRetentionService`（每日 @Cron 03:15 + LeaderGate 门禁，对齐 ARCH-31 §5 先例）目录粒度磁盘回收 + DB 行同步删，`AGENT_MEDIA_RETENTION_DAYS` 默认 7（roadmap §11 决策值）；两键已进双 .env.example。**验证**：agent-sop-check **142 项**（+11：兜底纯判定/sweep 行为/接管幂等边界/媒体清理真实临时目录行为）；desktop test:main **32 套全绿**（agent-host e2e +第 15 节发送重试）；admin-api tsc 0 + nest build 绿 + lint gates 绿。**残差**：SopsPage 重派按钮（客户端已有 sopsApi.assign，小 UI 增量）；接管答复对已终结指派不投递（恢复 = 重派，不为「复活终态」引入复杂度）。
- **本轮（2026-09-26 → 可见性收口：Agent 会话查看页 + 澄清投递状态，develop）**：P2 遗留的「Admin Web 会话查看页」补齐——HTTP 面自 P2 存在但**零 UI 消费**，运维只能查库（同 P7c agentEnabled「无 UI 即功能不可用」教训）。①`AgentSessionsPage`（ADMIN-only 路由门控 + 菜单隐藏）：列表（kind/status 筛选 + 用量列 + 生效预算行）、详情抽屉（推理步骤逐条 provider/model/令牌/时延、工具调用 tier/status/denied 理由、子会话因果链、scope/context/result JSON）、恢复动作（唯一写动作，沿用服务端终态守卫）；②SopsPage 澄清条目按游标 `lastReplyDeliveredAt` 显示「执行器已确认/待执行器确认」——运维可据此判断澄清环卡在哪一端；③交付复核会话在回报含 `isolatedRun` 时提示可参考该证据（仍按不可信自述对待，独立验证职责边界不变）。**验证**：admin-web tsc 0 + build 绿 + lint 0 errors + i18n 守卫通过（新页面硬编码中文被扫描器抓出后改走 i18n）+ vitest **1265 项全绿**（含 zh/en key 对齐）；admin-api tsc 0 + nest build 绿；agent-sop-check **131 项**（+1）。**下一步**：P7d 后半端到端（需真实 LLM 与部署环境）、打包接线（host 拆子进程 + Playwright 浏览器分发）、macOS/Linux GUI 后端。
- **本轮（2026-09-26 → P7e 前半：isolated-runner 直接执行路径，develop）**：09 §6 档位实现顺序的最后一轴补齐——`taskExecution` 从「配置了但无运行时行为」变为真实档位。①`TASK_EXECUTION_SPEC` 放开 `isolated-runner`（预设仍只放开 minimal/standard）；②新增 `agent/isolated-runner.ts`——desktop 本地**独立执行端点**（08 §2.4 方案 A）：交付时直接在本机执行一次候选，**复用试跑的同一套 process 沙箱**（解释器封闭枚举/env 白名单/路径域/树杀，不另造执行器）、**不复用 /execute**（manifest 劫持防护信任前提相反，shared-runner 故意不提供）；③来源标记 `agent:sop:<address>` 由平台代码打（ADR-022 决策 5）；④双重档位闸（host 判 + runner 内部再判，deploy-only 如实拒绝）；⑤执行证据（ok/refusal/exitCode/output 摘要进回报 `isolatedRun`，全文落 `isolated-runs/run-N.log`）——执行发生在验收通过、包已交付**之后**，失败不翻转交付判定（证据如实上交由中台复核判定）；打包器排除 `isolated-runs/`。**关键语义**：中台上限不变——本地开 isolated-runner 而中台 cap 是 standard 仍被钳回 deploy-only，须显式放宽到 developer+（与 GUI app-scoped 同款集中管控）。**验证**：desktop test:main **32 套全绿**（+isolated-runner 13 项；agent-host e2e +第 13 节与 deploy-only 反断言；permission-profile 自检更新）；tsc 0 + lint gates 绿。**残差**：直接执行目前只在交付时刻发生一次，按平台任务语义的常驻执行（调度/重试/守护）仍走既有 deploy 通道（属 P7d 后半端到端闭环，需真实 LLM 与部署环境）；`codeExecution=host` × `isolated-runner` 组合被沙箱如实拒绝（host 档仍未实现）。
- **本轮（2026-09-26 → P7d 执行器侧鲁棒性：澄清闭环 + 崩溃恢复，develop）**：P7c 残差 ④ 兑现——澄清循环自此**端到端闭环**（此前执行器发出澄清后 host 直接返回，中台的回复永远回不到循环里）。①**中台**：`pollPending` 投递 `clarification_reply` 条目（resolution 已落定且晚于游标 `lastReplyDeliveredAt`，轮次升序，≤20 条/次；**投递不推游标**=至少一次投递）；新增 `POST /agent-collab/assignments/:id/clarifications/ack`（归属三向校验 + 未回复不可确认 + 游标**单调推进**）；`resendAssignments` 支持 `[id]` 数组按单定向重发（原 `true` 全量+重排队行为不变）。②**执行器**：新增 `assignment-journal.ts`（`<workDir>/agent-journal/<id>.json`，tmp+rename 原子写、结构校验、assignmentId 路径消毒、7 天陈旧清理）；host 消费回复——**先落盘后消费**（幂等键先持久化，崩溃重发同键被中台去重）→ answered/sop_amended **续跑**（问答历史进规划/诊断上下文；sop_amended 附修订版全量载荷，交付对账锚前移；`AgentLoopResult` 新增 `counters` 回传落盘，闸门预算跨续跑/崩溃不清零）→ 终态后才 ACK；escalated_to_human 回复如实回报 failed 终结（升级后无自动答复）。③**崩溃重领**：running 阶段崩溃 → 重启后首次 poll 按 id 重发重跑（工作区/历史/计数从日志恢复）。④**长跑心跳**：循环期间每 60s reportProgress——真实缺陷：超时扫描对 in_progress 超 10min 无心跳判 stalled，而单轮 LLM 循环完全可能超 10 分钟。**验证**：agent-sop-check **130 项**（+19）；desktop test:main **31 套全绿**（+assignment-journal 14 项；agent-host e2e 新增 5 节：回复续跑→ACK / 升级终结 / awaiting_reply 重启续跑 / running 按单重发重跑 / ACK 失败重发不二次消费）；admin-api tsc 0 + nest build 绿 + lint gates 绿；agent-runtime/boundary/trigger-check 0 失败。**残差**：包→审批→部署端到端（deploy_application + DEP-04 + 拉包部署 + 中台验收）需真实 LLM 与部署环境（P7d 后半）；host 拆子进程与打包态浏览器分发留打包接线；崩溃重跑是「从感知重跑 + 历史注入」而非断点续跑（重复提问由中台轮次计数兜底）；`inflight` 字段仍保留未消费（存活判定由 progress 心跳承担）。
- **本轮（2026-09-26 → P7c Windows 切片，develop）**：①桌面 `app-scoped` + 精确进程名白名单，Windows Win32 固定脚本执行 `focus/click/type/press/screenshot/wait`，每次动作复核权限和前台进程，截图只取目标窗口并进媒体回传；规划/诊断循环能把 GUI 观察交给下一轮 LLM，单指派 40 步上限。②Agent 状态进托盘和状态窗；配置身份（URL/token/address/workDir）变化时等待旧指派完成和能力撤销再重建 Host。③服务端把短效 Agent 能力从普通 runtime 能力分列，30 秒续报、2 分钟租约；SOP 按有效能力指派，poll 一次交付一单并用 CAS 防并发重复领取；桌面 tick 全段单飞行，上报/撤销串行，策略收紧后再次核对指派能力。④澄清回复在执行器侧尚无恢复/ACK，服务端暂不投递、不推进游标，留 P7d。**验证**：desktop test:main + renderer selftest、SOP 检查、admin-api TypeScript 与目标 Jest 均通过；Windows 冒烟覆盖聚焦成功和动作拒绝路径。**残差**：真实 GUI 点击/输入/成功截图需交互桌面验收；默认中台 standard 禁 GUI，显式放宽方可用；macOS/Linux 后端、澄清/崩溃恢复与包→部署闭环属后续切片。
- **本轮（2026-09-26 → P6 收口：超时治理 + 升级环人工答复，develop）**：①**超时治理（11 §6）**——`sop-timeout.ts` 纯判定（判定与执行分离，check 脚本可完整断言）：无人领取 >30min → failed（可换机重派）/ 领取后心跳停滞 >10min → stalled；**blocked 不参与失联判定**（等中台澄清回复的责任在中台侧，不是执行器失联——语义要点）。SopService @Cron 每 5 分钟扫描 + leader 门禁（多副本不判 leader 会重复置态）+ fail-open 通知；TTL 配置 `SOP_ASSIGNMENT_CLAIM_TTL_MS/PROGRESS_TTL_MS`（configuration/Joi/双 env.example 三处同步）。②**升级环收口**——escalated_to_human 此前只有通知没有答复路径，升级后环就断了：新增 `POST /sop/assignments/:id/clarifications/:cid/reply`（ADMIN-only；校验澄清归属防跨工单答复；resolution 限 answered/sop_amended）+ SopsPage 澄清条目回复 UI；人工与中台 Agent 走**同一个** replyClarification（同一道幂等/校验/修订闸门）。**验证**：agent-sop-check **111 项**（+9）；admin-web tsc/lint 0；admin-api tsc/lint 0；四套 agent 套件 0 失败。

- **本轮（2026-09-26 → 写工具执行体绑定 + 中台独立验证，develop）**：①**写工具绑定（P3 遗留承诺兑现）**——incident/sop_authoring 白名单里的 trigger_task/retry_execution/kill_execution/pause_task/resume_task/create_application/create_task_from_template/deploy_application/deploy_app 自 P3 起从未绑定执行体（模型一调即「尚未实现」，事件处置与 SOP 编排两大场景残废），现全部绑进 ToolBinder：trigger 显式 triggerTypeOverride=agent（执行行可辨 Agent 触发，缺口 6）、retry 与 mcp-server 同语义（回放原 params，NF-06 无原生端点）、deploy 走**方案 C**（直调 deploy，DEP-04 pending_approval 透传，不新增审批机制）；user=undefined 沿用「系统内部调用」守卫语义。②**审批闸补齐**——update_task/rollback_task_version/upgrade_deployment/stop_deployment 加逐工具 approvalRequired（03 §2 需审批项，全局写策略放宽也不放行）。③**完成回报 → 中台独立验证**（04 §3 ⑤）——completed 回报触发 sop_review 复核会话：scope = SOP 本身 + acceptance kind=platform 任务集合（trigger_task 的 scope 闸收窄）；sop_review 白名单加 trigger_task（仍无 sop_publish/sop_draft）；执行器自述以 untrustedResult 标注进上下文；验证起不来 fail-open（完成回报不被吞）。**验证**：agent-sop-check **102 项**（+23：审批闸 4 / 绑定 9 / 验证会话 5 / 既有回归）、四套 agent 套件 0 失败、tsc 0、nest build 绿（DI 装配含 TaskTemplateModule/AppDeploymentService）。

- **本轮（2026-09-25 → P7d 前半：候选应用交付通道，develop）**：07 §3.3 关键一笔兑现——「Agent 负责写、既有链路负责跑」。①`zip-writer.ts`：零依赖 store-only ZIP（CRC32 向量 + 自解析回读 + 穿越/绝对路径/超限写入层防线 + 条件 `unzip -t` 独立交叉验证——本机真跑且过）；②`package-candidate.ts`：manifest.yaml（runtime 由 interpreter 映射 / entrypoint / 来源标记 sop+version+contentHash）+ 工作区源文件，观测产物排除，入口缺失如实抛；③admin `POST /agent-collab/assignments/:id/candidate-package`：agent:sop 闸 + 归属校验 + **复用 ExecutorPackageService.create**（PK 魔数/后缀白名单/SEC-05 逐项生效，candidate-package 是既有校验链的新入口不是旁路）；来源标记由平台代码打（uploadedBy=agent:sop:<executorId>，ADR-022 决策 5）；版本 +agent.<ts> 构建元数据幂等交付；④host 交付流：delivered → 打包 → 上传 → packageRef 进回报；打包/上传失败如实回报 deliver_failed（交付失败≠验收失败，中台可区分「做不出来」与「没交上去」）。**验证**：desktop test:main **25 套全绿**（+package-candidate 19 项）；agent-host e2e 19 项（multipart 上传 + packageRef）；agent-sop-check **79 项**（+7）；tsc/lint/迁移守卫全绿。**残差**：包→deploy 端到端（deploy_application + DEP-04 + 拉包部署）属 P7d 后半（需真实 LLM 与部署环境）；isolated-runner 属 P7e。

- **本轮（2026-09-25 → P7c 前置增量：Agent 设置面 + 状态可见，develop）**：P7b 提交后发现「agentEnabled 没有任何设置界面——用户无法开启 Agent」，功能不可用即缺陷。增量：①ConfigPage 新增「Agent（实验性）」组——总开关 / 权限预设下拉（**未实现的三档显示为禁用**：选了也会被解析层钳回，界面与行为一致比可点更重要）/ codeExecution 覆盖（host 显示禁用）/ 浏览器域名白名单 textarea；②保存走既有 config:save 通道——**零新面绕过消毒层**（ENUM/STRING_LIST/BOOLEAN_FIELDS 已覆盖全部新字段）；③`agent:get-status` IPC（getAgentHostStatus，只读）+ 状态行（working/processed/lastOutcome/生效档位，进组与保存后刷新，与未保存表单解耦）；④config:save 热同步 syncAgentHostWithConfig（启停轮询不销毁 host，失败不阻塞保存）；⑤preload 暴露 getAgentStatus（旧版容错降级，同 getAutoLaunch 先例）。**验证**：desktop 主 tsconfig / selftest tsconfig tsc 0、renderer.selftest EXIT 0、test:main 全链 EXIT 0。**下一步**：P7c（桌面 GUI + 托盘状态）或 P7d（端到端闭环 + isolated-runner）。

- **本轮（2026-09-25 → P7b：浏览器能力 + 媒体回传 + Agent 托管，develop）**：用户指令「继续推进后续的开发 持续保持推进 不要中途停止」。P7a 续批（LLM relay + 真实试跑）之上交付 roadmap §9.5：
  - **kill-tree**（agent/kill-tree.ts）：跨平台进程树终止——POSIX spawnDetached（detached 进程组 + kill(-pid)）、Windows taskkill /T /F；spawnWithTreeTimeout 打包进 trial-run，**修复 P7a 残差**「超时只杀单进程、孙进程泄漏」（selftest 实测孙进程死亡）。真缺陷：taskkill /F 后进程以 exit code 1 触发 close，与 killTree 回调**竞速**产生 killed=false/exitCode=1 失真快照——修为 killed 同步置位（语义=「终止信号已发出」）+ timedOut 时 exitCode 归 null。
  - **browser.ts**：AgentBrowserSession——7 个封闭动作（navigate/click/type/press/screenshot/extract_text/wait，无 evaluate/exec）；**每次导航过域名白名单**（SOP constraints ∪ 档位 allowedDomains，空白名单拒绝启动也禁一切导航）；全新临时 profile（不携带用户登录态，hostAccess=none 语义保持——两道闸独立不互相冒充）；截图落 workspace/screenshots、录屏（recordVideo）close 时落 browser-recordings。
  - **媒体回传**：collab-client.uploadMedia（手拼 multipart）→ admin-api POST /agent-collab/assignments/:id/media（agent:sop 能力闸 + 指派归属校验）→ agent_media 表（**迁移 1790000000042**）+ 落盘 uploads/agent-media/<assignmentId>/（100MB 上限、文件名封闭、路径越界终检）→ mediaPath 是澄清 mediaRefs 唯一合法引用形态（validateMediaRefs 放行 /api/sop/media/；**R35-A1 更正**：原先放行并要求匹配的 `/api/agent-collab/media/` 从不是路由，现仅作灰度/存量宽容）；ADMIN 下载端点 GET /api/sop/media/:id。
  - **runtime 协议扩展**：plan/diagnose 可带 browser:[actions]（≤40 步）——先看页面再写代码；页面文本/截图/录屏 mediaPath 进下一轮上下文；能力闸 = SOP capabilities 含 browser 且 playwright 探测可用。
  - **agent-host.ts（托管）**：tick() = poll → 缓存 sopPolicy → 领单 → 能力上报（browser 按探测如实声明）→ 沙箱 → 策略合并 → runAgentLoop → 回报 completed/failed/**澄清**；单飞行防并发；兜底 catch 把循环外意外也如实回报 failed。**端到端 selftest**（本地 http server 全真模拟中台，17 项）：completed / 澄清 / **中台压档 minimal → 档位闸拒 → failed 且本地 standard 没有偷偷试跑** / 单飞行。
  - **agentEnabled 总开关**：默认 false（ADR-022 显式开启）；config-store + 布尔消毒；syncAgentHostWithConfig() 接进 index.ts（app ready + config 热同步；30s 定时器驱动 tick；Agent 失败只记日志绝不影响桌面主链）。
  - **验证**：desktop test:main **24 套全绿**（+kill-tree 9 / +browser 20（真浏览器节按环境如实跳过）/ +agent-host 17）；agent-sop-check **72 项**（+8 媒体通道断言）；tsc 0、lint、迁移注册（87 个）/枚举漂移/多字节/lint-gates 全绿。
  - **残差（如实）**：真浏览器节需 npx playwright install chromium；打包态浏览器分发留 P7d；host 拆独立子进程（07 §4.2 完整形态）留 P7d（当前重活已全在子进程，host 只做 I/O 编排）；托管状态进托盘 UI 留 P7c。
  - **下一步**：P7c（桌面 GUI + 托盘状态）或 P7d（端到端闭环 + isolated-runner + 平台侧来源标记）。

- **本轮（2026-09-25 → P7a 续批：LLM 接入 + 真实试跑执行体，develop）**：用户指令「继续推进后续开发」。P7a 骨架已提交（343d7274/a42c7f6d），本轮兑现其登记残差「LLM 真实接入 + 真实试跑执行体」：
  - **admin-api LLM relay**：`POST /agent-collab/llm`（`sop-collab.controller.ts`）——执行器 Agent 的推理经中台代跑，**API key 不出服务端**、令牌记中台 metrics 可归因、企业只需在中台配额。过 `authenticateAgent`（token + `agent:sop` 能力闸）；载荷钳位（messages ≤64 条 / 单条 ≤100KB / role 白名单——tool 往返不对执行器开放）；provider 未启用时 chatMultimodal fail-open 透传空 content，执行器按「模型不可用」降级。SopModule 引入 AiModule。
  - **desktop `trial-run.ts`（process 沙箱）**：`runTrialInSandbox` 是所有「在本机执行生成代码」的必经点——档位闸（`off` 拒绝 / `host` **如实报未实现**而非静默降级）→ 解释器封闭枚举（python/python3/node；node 走 `ELECTRON_RUN_AS_NODE=1` 复用 Electron 可执行文件，双环境同一路径）→ entry 经 workspace 路径域 → **env 白名单**（凭据零透出，selftest 注入伪凭据实测；强制 `PYTHONUTF8=1`——I18N-01 教训在源头掐断）→ cwd 锁定 + 超时（1..300s）+ 输出 64KB/流封顶。`parseAcceptanceCommand` 只认 `<interpreter> <工作区脚本>` 封闭形态（`-c` 内联码无可校验锚点，如实拒）。
  - **desktop `collab-client.ts`**：协作 HTTP 客户端（node:http——lib ES2020 无 DOM/fetch 类型；poll/capability/clarify/progress/complete/llmRelay），Bearer token + address 双标识，超时 socket 强制销毁，**全部失败收敛为 `{ok:false}` 绝不抛**。
  - **desktop `runtime.ts`（装配）**：LLM 严格 JSON 协议（plan→`{files,entry,notes}` / diagnose→`{action,question?,files?}`）+ `extractJsonObject` 容错解析 + 验收执行（kind=command 经沙箱、platform 留中台独立验证、**无 acceptance 绝不 delivered**）。
  - **selftest 抓出真缺陷 #3（本批最有价值发现）**：`diagnose` 里 `return action as LoopNextAction` 强转——LLM 的 `clarify` 与循环的 `needs_clarification` 是两个名字，强转通过编译但**语义错位**：「请求澄清」静默变 retry，继续烧轮次、澄清永不上报。修法：显式映射表 + 未知名如实抛协议违规。前两号缺陷（symlink 跟随 / realpath 抛 ENOENT）见上批快照。
  - **验证**：desktop `test:main` **20 套全绿**（新增 trial-run 31 项 / collab-client 21 项 / runtime 15 项）；`agent-sop-check` 扩到 **64 项**（+6 relay 断言）；tsc（desktop 主 tsconfig / selftest tsconfig / admin-api）0 错误；admin-api sop lint 清零。**残差（如实）**：端到端 spike 需 DashScope 账号；试跑超时的进程树残留（Windows kill 单进程，P7b 换 tree-kill）；`agentEnabled` 托管生命周期（desktop 拉起 Agent 子进程）留 P7b 批次。
  - **下一步**：P7b（浏览器能力 Playwright + 截图/录屏回传 + agent-process 托管）或按用户优先级调整。

- **本轮（2026-09-25 → agent-and-deployment P7a 执行器 Agent 骨架，develop）**：用户指令「继续工作区的文档开发任务」。接手时工作区躺着三个未接线的 agent 模块（perception / workspace / permission-profile）+ 四篇未提交的 ADR（019–022），且 `npx tsc -p tsconfig.json --noEmit` **是红的**（permission-profile 的 `'custom'` 未纳入 `allowedProfiles` 判定的类型收窄）。本轮修通编译并补齐 P7a 骨架：
  - **编译错误修复**：`presetAllowed` 判定补 `local.preset === 'custom'` 分支——`allowedProfiles` 只枚举预设名，若把 `'custom'`（细粒度覆盖场景）当成「中台未授权」而整体压回 minimal，**用户改一个轴会连带丢掉其它轴**（一次配置变更静默降级整台机器的能力）。已加专项断言钉住。
  - **新建 `gates.ts`（07 §7.1 硬闸门）**：迭代 15 / 墙钟 2h / 澄清 5 / 试跑 30 / 依赖安装 10。两条纪律落成代码：①闸门在**动作之前**判（末判 = 副作用已发生，闸门形同虚设）；②墙钟自**首次迭代**起算、resume 不重置（否则 2h 上限可反复续命）。`normalizeLimits` 对非法值回落默认值——**fail-safe 到「有闸」，不是到「永久拒一切」**（回落到 0 与无闸同样错）。
  - **新建 `loop.ts`（07 §7 迭代循环）**：感知→规划→试跑→诊断的状态机外壳，LLM/试跑以 `LoopHandlers` **依赖注入**（控制流是 ADR-022 里安全相关的部分，做成不依赖 Electron/网络/模型的纯函数才能在 `test:main` 里完整断言）。★ 档位闸**独立于**次数闸且在试跑**之前**：off 档下一次 `trialRun` 都不发生（off 是高合规企业唯一会选的档，绕过它该档就只是一句注释）；澄清触顶 → 转人工且**不再**调 plan（不烧令牌）；触顶是**合法终态**带 `stopReason`，不抛（中台要能区分「做不了」与「崩了」）；handler 抛错收敛为 `outcome='error'` 不冒泡。
  - **档位接进配置链**：`config-store.ts` 新增六个 `agent*` 键 + defaults（默认 **minimal** 而非 standard——信任模型变更必须「显式开启」，升级不得凭空获得「在本机试跑生成代码」的能力）；`config-sanitize.ts` 新增 `ENUM_FIELDS` / `STRING_LIST_FIELDS` 消毒。09 §4.1 点名的踩坑风险：conf 15 移除 JSON schema 后坏值**静默落盘**，`sandbox` 拼成 `sandox` 不报错、界面照常显示、解析层却回落最保守档——「配置看起来生效了、行为却是另一套」且零日志。消毒策略：非法值归一化为 `''`（= 不覆盖，跟随预设）而**不删键**（删键 = 保留旧值，界面无法反映「刚选的没生效」）。另加 `permissionsFromConfig` 映射层（AppConfig 键名 → 档位轴名）。
  - **★ 自检抓出两个真实缺陷（写测试时发现，非预置）**：① `listWorkspaceFiles` **跟随 symlink**——`resolveWithinWorkspace` 只校验**输入**路径、管不到 walk 到达的路径，工作区里一个指向域外的链接就把域外文件列进 Agent 观察面，沙箱可见性边界被悄悄扩大（改为遇链接跳过）；② `resolveWithinWorkspace` 内 `realpathSync(workspaceRoot)` 在工作区不存在时抛 ENOENT，**打破本模块「返回 ok:false、绝不抛」的契约**——调用方是 LLM 驱动的路径解析，抛出去即一次会话崩溃（catch 后收敛为 ok:false）。
  - **五套 selftest 全部接进 `npm run test:main`**：permission-profile（默认最保守/未实现档位钳回/min(本地,中台)/离线沿用本地）、workspace（真实 fs：穿越·绝对路径·盘符·home 全拒 + symlink 逃出域外 + 指派间互不可见）、perception（探测**绝不抛**——`command not found` 是环境事实不是异常，不收敛成 `available:false` 则「没装 python」这一最需要报告的场景直接崩；只读；可序列化）、gates（off-by-one、墙钟续命、fail-safe 上限）、loop（档位闸、澄清转人工、resume、抛错收敛）。
  - **验证**：tsc（desktop 主配置 + selftest 配置）0 错误；`test:main` **17 套全绿**；`check:lint-gates` 绿；`check:desktop-bundle-drift` 摘要一致（42 输入文件，未触碰 bundle）。**反证均有牙**（逐条实测转红）：删档位闸 → "off 档必须产出 permission_denied"；`>=` 改 `>` → "恰好允许 15 次（实测 16）"；恢复 symlink 跟随 → "列目录不得跟随指向域外的 symlink"；去枚举消毒 → "必须归一化为 ''"。
  - **文档同步**：roadmap 新增 §9.4（P7a 状态 + 关键判断 + 两个缺陷 + 验收）、ADR 索引补 019–022（此前四篇 ADR 已写但未进索引）、新建 `docs/atlas/01-apps/executor-desktop/agent.md`、README 状态表补 P4–P7a、本条快照。
  - **残差（如实）**：①LLM 与真实试跑执行体未接（P7a 后续批次，`loop.ts` 已留注入口）；②P7b 浏览器能力未做，能力域**如实**只报 `filesystem`/`http`（不得声明 browser，否则中台可行性预检会把需要浏览器的 SOP 派过来然后卡住）；③默认预设 `standard` 与否待拍板（09 §7），当前默认 minimal；④P7d 的执行器侧协作 API client 未写（中台侧 `sop-collab.controller.ts` 已就绪）。
  - **下一步（roadmap 剩余）**：P7a 收口（接 LLM + 试跑执行体，跑 07 §9 的真实 SOP spike 验证「通用 Agent 自主实现」是否成立）→ P7b 浏览器能力。

- **本轮（2026-09-25 → agent-and-deployment P5/P6 落地，develop）**：用户指令「继续推进文档内的所有工作」。按 roadmap 实现并交付 P5（SOP 协议）+ P6（澄清循环·中台侧）：
  - **P5 SOP 协议**：`modules/sop`（迁移 `1790000000041` 四张表：sops / sop_versions / sop_assignments / sop_clarifications）；front-matter 严格校验（未知键拒绝、acceptance 必填、capabilities 枚举按 07 §7 取代 requiredTools、maxRounds ≤5、allowedDomains 裸域名；草稿宽松）；6 个 SOP 工具（sop_list/get/draft/publish/assign/reply_clarification）以**独立 `AGENT_INTERNAL_TOOL_SPECS`** 进注册表（43 parity 镜像不破坏，合流集 49）、ToolBinder 绑定、白名单更新；`sop_publish` 逐工具默认审批（发布权=间接指令注入权，边界闸门为此新增 `spec.approvalRequired` 位）；Admin Web SOP 管理页（/sops，RequireAdmin）。
  - **P6 澄清循环**：agent-collab 协作 API 全套（poll 长轮询 ≤25s + sopPolicy 下发 / capability / clarifications / progress / complete），鉴权复用 `validateTokenByAddress` + **显式 `agent:sop` 能力闸**（空能力 ≠ 通用，fail-closed）；澄清 → `sop_review` 会话（parentSessionId 串联、scope 只授权被复核的 SOP）；`maxRounds` 触顶强制 `escalated_to_human` + 通知（**不起会话不烧令牌**）；`sop_amended` 发 patch 新版本（与人工发布同一道严格校验）；question 脱敏+钳位、mediaRefs 只认平台内路径（SSRF 转嫁封死）、complete 幂等 attempt、执行器上报全部按不可信处理。
  - **关键判断（文档已记）**：sops 主表=工作副本（published 可编辑）而 sop_versions 是不可变真身（执行器永远读版本表）；内容未变拒绝重复发布；协作协议暂不进 protocol.json（非三方共有语义，P7 进 agentCollab 段）。
  - **验证**：新增 `agent-sop-check.mjs`（58 项断言：front-matter 17 项行为 + SopService 发布/指派/澄清/完成行为 + 边界闸门 SOP 工具行为 + 协作 API 结构 + env 同步）接进 `npm run test:sop`；tsc（api/web）0、nest build 绿（sop↔agent forwardRef 装配验证）、四套既有 agent 断言 + lint + 迁移/枚举漂移/多字节守卫全绿。
  - **残差（如实）**：①P6 视频推理实测需 DashScope 账号（链路就绪）；②反向用例（SOP 植入恶意指令→执行器拒绝）待 P7 执行器 Agent 落地后跑；③P5 的 front-matter 与 autoapp-skill.md 对齐在 P7 起草真实 SOP 时收敛。
  - **下一步（roadmap 剩余）**：P7 执行器 Agent（P7a spike：ADR-022 + 权限档位 minimal/standard + executor-desktop 骨架）。

- **本轮（2026-09-25 → agent-and-deployment P4 收口 + 全批次提交，develop）**：用户指令「继续推进工作区待完成任务」。接手时工作区躺着一整批未提交的 agent-and-deployment 成果（P0 双模部署 / P1 Qwen provider / P2 运行时底座 / P3 工具+边界 / P4 触发器半成品），P4 触发器代码已写完但四条收口线未闭合。本轮闭合：
  - **P4 缺口①：会话通知（设计文档 02 §7.2，P3 遗留的「审批通知推送留 P4」兑现）**：新增 `AgentNotifyService`——成功且有结论→INFO / 失败·预算超限→ERROR / 待审批→WARNING / 无结论（summary 空）与 aborted **不通知**（静默成功是刻意设计：运维 Agent 有事才说话）；挂 `AgentSessionService.finish()`（终态唯一收敛点，「已是终态提前返回」守卫同时防 resume 撞车双发）与 `ToolExecutorService.requestApproval`；**通知传更新后快照**（静默语义读新 summary，传旧值就判错）；全链 fail-open + 总开关 `AGENT_NOTIFY_ENABLED`（configuration/Joi/双 .env.example 齐）。
  - **P4 缺口②：agent.* 配置的 .env.example 三处同步纪律从 P2 起就漏了**——AGENT_BUDGET_*/AGENT_TRIGGER_*/AGENT_NOTIFY_ENABLED 全部补进双 .env.example。
  - **验证面**：`agent-trigger-check.mjs` 扩到 12 节（新增通知节：分级/静默/fail-open 行为断言走「转译产物 require 改写 + NotificationService 打桩」的 harness 边界；+ env 三处同步结构断言）。
  - **部署脚本跨平台修复（selftest 21/29 → 29/29）**：三类同源陷阱——①`check_port` 探测 `netstat -ltnp`（Git Bash 不认）与 `lsof -ti`（macOS 端口空闲时退出 1）非零 + pipefail 静默打死脚本（`2>/dev/null` 压文本压不住退出码，陷阱 #2 变体）→ 探测尾部 `|| true`；②`have python3` 被 Microsoft Store 占位 stub 骗过（command -v 判存在、实跑必败非零）→ 实跑 `--version` 验真再用；③selftest 的 JSON 深校验从 python3 换 node（npm run 调起时 node 是硬前提）+ Windows 上「8 阶段全程」断言按平台如实跳过（预检 fail 是正确行为，不造假绿）。陷阱 #7/#8 已记入 roadmap P0 陷阱表。
  - **文档**：roadmap P4 置 ✅ 已实现（含关键判断与验收）；atlas agent.md 补 trigger/ 目录、通知机制、触发器/事件的常见改动场景；P0-P4 全批次连同设计文档 12 篇、迁移 1790000000040、三套 agent 检查脚本、qwen 两套、部署自检一起提交。
  - **验证**：tsc（api/web）0 错误、nest build 绿、四套 agent 断言（runtime 66 / boundary 98 / trigger 37+31 通知 / qwen 34+44）、deploy selftest **29/29**、lint 0、多字节/枚举漂移/迁移注册守卫全绿。**残差（如实）**：①DashScope 真实账号端到端、②P2 要求的内置 Agent 对 admin-api P99 影响 <5% 压测、③真实多副本 leader 门禁实测——三者均需本环境不具备的 DB/Redis/账号/多机；④admin-web 会话查看页仍留待「先有数据再看」（roadmap P2 表有记录）。

- **本轮（2026-09-21 → 生产故障专项：凭据按原名注入 + 中文日志乱码，develop）**：用户报「后台触发执行任务报错 `RuntimeError: 缺少飞书凭证…`（乱码形态 `ȱ�ٷ���ƾ֤…`）／客户端与中台日志都乱码／界面里凭据参数像是没填」，并问「是应用包的问题还是我们项目的问题」。**定位结论：是我们项目的问题，应用包无罪**——应用脚本按提示读 `os.environ["FEISHU_APP_ID"]` 完全正确，是平台两侧（注入通道 + 编码）各有一个真实缺陷。两个缺陷同源**同一次执行**：`SEC-02 续`（凭据注入名不对）+ `I18N-01`（Windows 上中文日志变乱码）。
  - **根因①｜凭据根本没按提示的名字注入（SEC-02 续）**：secrets 此前与 params **合并走同一条通道**，统一加 `AUTOFLOW_` 前缀——平台报错文案教用户配 `FEISHU_APP_ID`，实际注入的却是 `AUTOFLOW_FEISHU_APP_ID`。脚本照提示读裸名**永远是空串**，用户照提示配置也永远配不对；第三方 SDK 更无解（boto3 认 `AWS_ACCESS_KEY_ID`、openai 认 `OPENAI_API_KEY`，这些名字由 SDK 决定，脚本无法改写成带前缀形态）。修法：派发载荷新增**独立 `secrets` 字段**（admin-api `buildDispatchSecrets`，push/pull/broadcast 四条派发路径齐发），执行器侧 `secret-env.ts` / `secret_env.py` 按**原名**再注入一份；params 通道**一字不动**（存量脚本零回归，两种读法并存）。带**名字闸门**：白名单 `[A-Za-z_][A-Za-z0-9_]*` + 保留名拒绝（`PATH`/`PYTHON*`/`AUTOFLOW_*`/执行器密钥/白名单透传变量）——原名注入意味着用户键名会**直接成为子进程环境变量名**，一个名为 `PATH` 的 secret 会让子进程连解释器都找不到，任务以与凭据无关的形态失败。三端（admin DTO / node / python）规则**重述并互钉**（`secret-key-map.parity.spec.ts` 逐条比对两侧集合，实测抓出 python 侧小写条目未大写化、`npm_config_cache` 可绕过闸门的真缺陷）。
  - **根因②｜中文任务日志在 Windows 上必然乱码（I18N-01）**：Windows 上 Python 的 stderr 取 `locale.getpreferredencoding()`（实测 cp936/GBK），而**用户脚本里那句"重配 stdout"管不到 stderr**（`sys.stdout.reconfigure()` 只作用于 stdout），异常回溯走 stderr 仍是 GBK 字节；执行器用 `StringDecoder('utf8')` 解这两个流 → 报错文案变成 `ȱ�ٷ���ƾ֤…`。**最有价值的诊断信息被销毁**（用户原文是「缺少飞书凭证：请在平台 secrets 配置 FEISHU_APP_ID」，乱码后完全不可读，直接拖长排查）。修法：只对 python runtime 注入 `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`（node 恒 UTF-8；shell 编码归脚本作者，执行器不自作主张），注入点放在 params 之后（用户参数不得覆盖），并在 secret 闸门里**拒绝 `PYTHON*` 前缀**——否则一个名为 `PYTHONIOENCODING` 的 secret 就能让乱码故障复发（两处修复的交叉点）。
  - **根因③｜控制台根本没有凭据入口（用户所说「参数没有填」的真相）**：此前 admin-web **完全没有** secrets 编辑入口，而执行器报错文案却在教用户「请在平台 secrets 配置 FEISHU_APP_ID」——一条**在 UI 上无法执行**的指令。本轮补 `SecretsEditor` + 表单接线；**上一轮留下的半成品在此收口**：i18n 文案键整体缺失导致界面渲染裸 key（`secretsEditor.alertTitle` 这种标识符）、`SECRET_MASK` 导入未使用导致 `tsc -b` 直接失败、编辑态未接线已有凭据的展示源。
  - **顺带挖出并修掉一个更危险的缺陷（掩码回写）**：读路径对所有凭据叶子回字面量 `******`，而控制台要显示既有键就**必然持有掩码**——原来的 PATCH 是**整体替换**语义，于是"打开编辑页 → 只改超时 → 保存"会把 `******` 当真实凭据落库：**真实值不可逆损毁，而界面上键还在、任务却报「缺少凭据」**（正是本次故障最难查的形态）。修法：PATCH 改**逐键合并**（`mergeSecretsOnUpdate`）——键缺省 = 保留／掩码叶子 = 保留／`null` 叶子 = 删除／其它值 = 加密覆盖；编辑器只外发"本次变更"，前端再加一道**掩码闸门**（`applySecretsPayload`，掩码永不出浏览器）。两侧独立设防：后端是权威（CLI/MCP/直连 API 也受保护），前端是纪律。
  - **验证**：admin-api **3135**（含新增 merge 矩阵 + task.service PATCH 用例）、admin-web **1059**（+20：`secrets-editor` 14 / `task-form-secrets` 3 / `i18n-source-guard` 18 中的新增部分）、executor-node **863**（+41：`secret-env` / `execute.i18n-encoding`）、executor-python `test_secret_env.py` 44 例；三侧 tsc/eslint 0。新增评测面：**i18n 源码守卫**（`t('...')` 字面量 key ⊆ 字典定义面）——既有的中英集合比对**拦不住"两边都没加"**这一形态（界面渲染裸 key 既不报错也不影响构建），本次故障正是它漏掉的。
  - **配套（面向用户）**：`docs/app-development-guide.md` 新增凭据注入说明（凭据走**原名**、参数走 `AUTOFLOW_` 前缀、保留名清单），`docs/api-reference.md` 的 `secrets` 条目重写为双通道 + 逐键合并语义。桌面端内嵌 executor-node bundle 按 ADR-005 **同 commit 重打**（`0ba5af66…`，2547kB）——漏打这一份 = 用户装的新客户端仍然复现同一故障。
  - **残差（如实）**：①「保存为模板」**刻意不携带 secrets**（模板 config 是明文、且会被多个任务复用，带凭据等于把密文之外的东西扩散出去），从模板建任务需重新配置凭据——已由 `SecretsEditor` 空态文案提示，未做模板级凭据引用；② 凭据的**逐键删除**依赖前端显式发 `null`，CLI/MCP 若按"整体替换"直觉只发想保留的键，实际语义是**合并保留**（更安全的方向，但 API 语义变更需在 SDK 文档中明示）；③ 既有键的**改名**会同时发 `原键: null` + `新键: 值`（避免留下一把仍有效的旧凭据），但该行为没有 CLI 侧对等实现；④ `PYTHONIOENCODING` 只解决 Python 侧编码，执行器自身日志（winston/uvicorn）在非 UTF-8 控制台的显示不在本轮范围。

- **本轮（2026-09-20 → 第四轮批次 NETOPT-7/8，主控编排 + 2 路只读探查 + 2 路执行子代理（用户约束：同时最多 2 个 agent），develop）**：用户指令「全方位探索优化的地方，多维度多角度。用 codegraph 快速推进了解状态，然后推进优化。每次同时只能调用2个agent干活」。镜头避开前三轮已扫维度（探查代理先对齐黑名单只报净新）：**NETOPT-7 = admin-web 前端运行时正确性深潜（axios 取消语义/晚到响应竞态/定时器旧闭包）+ desktop 渲染层 IPC 兜底**；**NETOPT-8 = 数据生命周期一致性（S3 孤儿/outbox 无界/应用删除执行器残留/分批 DELETE 双闸）+ registry-npm compose 加固 + 运维文档如实化**。两路探查 14 条候选，主控逐条回读源码复验 **14/14 成立**后认领（7aa967ab）。**14/14 全部落地**（执行 lane 各自一条一 commit 全部带反证），主树复验：admin-api **3135/3135**（190 suites，+28）、admin-web **982/982**（114 files，+8）、executor-node **699**（+11）、registry selftest 绿、tsc/eslint 0（admin-api/admin-web/executor-node 三侧）。commit：NETOPT-7 = 2886eaf1/9043356b/59dac0a9/7c8bb0db/1a70284a/ffc99f7c；NETOPT-8 = 1d9c7a99/1c8631af/e0032b38/c41fd22d/76e4494f/890a1bff/470acf42/f9a1ecb6；收口 docs（本条+台账 done+atlas 同步）随后。**零新增迁移**。
  - **P2｜axios 拦截器不识别取消**（2886eaf1）：全 api 层无 isCancel 判定——主动 abort（翻页/卸载/refetch 压制）走「安全方法重试」睡 1s 用同一 aborted signal 重发再抛，最终弹假「网络连接失败」toast；无 config 的 CanceledError 还会在 originalRequest._retryCount 上 TypeError。拦截器最顶部 `axios.isCancel || ERR_CANCELED` 直接 reject（一并消 TypeError 面）。
  - **P2｜完整日志跨执行串页**（9043356b）：ExecutionDetailPage handleLoadFullLogs 无 seq 守卫（同文件 levelFetchSeq 有防，一个有防一个没防）——重试链导航切执行后旧执行的 200 页慢速拉取晚到回写 setFullLogs，新执行详情显示旧日志且复制/下载连带串页。照抄 levelFetchSeq 形态补守卫，U2 重置 effect 内自增使在途整体失效。
  - **P2｜删除应用执行器侧永久残留**（c41fd22d）：应用 remove() 只删 DB 行+admin zip，部署行 CASCADE 静默删除使 /app-stop 通路不可达，执行器 apps/<appId>/ 在 PROTECTED_WORKDIR_NAMES 永不清扫且无 uninstall 路由——磁盘无界残留 + daemon 继续跑。修法：admin 删前查部署行、删后 allSettled 逐 deploymentId stop→uninstall（pinned axios+5s，执行器全挂仅 warn 应用照删）；executor-node 新 POST /app-uninstall（verifyToken 内、段白名单+resolve 双闸、先停 daemon 后 rm -rf 幂等）。
  - **P2｜task_executions 90d retention 删行 → S3 日志对象永久孤儿**（1c8631af）：S3 GC 候选只能来自存活行（logObjectKey 指针），行先死对象从此无 GC 信号；LOG_RETENTION_DAYS≥90 或 S3 长故障 60 天窗口均触发。修法：分批 DELETE 前先 SELECT victims 回收 S3 对象、remove 失败行剔出本批留待下轮，非 S3 部署逐字节不变。
  - **P2｜event_outbox 只增不删**（e0032b38）：每出站事件一行（含 jsonb payload）永久堆积，全仓零 delete、模块零 @Cron。修法：每日 03:55 @Cron **接 LeaderGate**，dispatched 行 30d 分批删除；event_outbox_dead_letters 90d 连同源行同一事务先死信后源行（FK 顺序要求）。
  - **P2｜三处分批 DELETE 漏配 LOG-RETENTION-01 双闸**（1d9c7a99）：cleanupOldTaskExecutions/cleanupExpiredMetricsHistory/audit retentionDelete 均为无上限 do…while——反证最有牙：affected 恒满批用例在未修代码上**真实 OOM 挂死**（与 log-retention-cleanup 记录的挂死形态一致）。抽 common/utils/cappedBatchedDelete（轮数+墙钟）统一三站点。
  - **P2 桌面双修**（1a70284a/ffc99f7c）：ConfigPage 首屏 Promise.all 补 catch（配置损坏不再永久「加载中」）；HistoryPage fetchLog try/catch/finally（readLog reject 不再永久加载+每 1.5s/5s 重复 unhandled rejection，catch 终止轮询）。
  - **P3 批**：AppDeploymentPage 三处 setTimeout 经 ref 取最新 fetchAll+卸载清理（59dac0a9）、ApplicationDetailPage fetchApp seq 守卫含 404 比对后 nav（7c8bb0db）、产物清盘后 1000/批 SET artifacts=NULL 对齐 30/90d 窗口（76e4494f）、S3GC 文档如实化（890a1bff，operations.md+compose+atlas 同步）、备份清单拆分私有发布包（470acf42）、registry-npm compose 补加固四件套+selftest 6 断言（f9a1ecb6）。
  - **残差（如实）**：levelFetchSeq 同族问题（切执行后旧 level 过滤响应晚到仍可回写 filteredLogs，seq 不随 execId 自增，NETOPT-7② 未越权扩修）；event_subscription_dead_letters 属用户可重放资产未做自动清；admin 侧删除扇出为 await 式（单台不可达最多 +2×5s）；⑤⑥ 桌面守卫为静态结构性断言（渲染层无 DOM 测试设施）；**复验观察**：executor-node callback.sharding 与 admin-web 各 1 例在三套全量并行抢 CPU 时假红，空载复跑全绿（负载型 flake，本轮未触碰相应 spec）。

- **本轮（2026-09-19/20 → 第三轮批次 NETOPT-5/6，主控编排 + 2 路探查 + 2 路执行（含 1 次接管续完），develop）**：用户指令「继续进行多轮」的第三轮。镜头：admin-api 剩余模块（auth/通知/registry/health）+ 测试质量竞态；executor-python 逐模块 + 桌面渲染层 + 消费端契约（mcp/CLI/node-sdk）+ e2e 卫生。**17 条净新发现（5 P2 / 12 P3）全部落地**，共 17 commit。**主树复验**：admin-api 188 套件 **3107/3107**（+32）、executor-python pytest **882**（+7）、executor-node **688**（+6，bundle sha 回填 fba4a0cd…）、registry-pypi **108**（+12）、mcp-server 115、acf-cli 125、node-sdk 91、desktop test:main/test:renderer 绿。commit：NETOPT-5 = 50486ee3/ba595fc5/448db780/e892dd06/303f1b57/5c66866f/c78329f2；NETOPT-6 = 9b1d01c6/edd02a62/0aec14d5 + 接管 647301ad/d4f3bd22/3dea2f30/bafc9a61/e70c56b3/f1715e02/f1cb0d04。**接管纪律实跑先例**：NETOPT-6 代理死于基础设施错误（非任务错误）——git log 显示死前已提交 ①②⑨、工作树留 test_zip_channel.py 半成品；按「盘点 → 派接管代理带 take-over 指令不重做」续完，半成品被沿用转绿并在 commit 注明接手。
  - **P2｜isSilenced 忽略 scope/applicationId**（50486ee3）：应用级静默此前=**全平台消音**（`!silence.taskId` 恒真匹配一切），且失败方向是吞告警——isSilenced 补 scope 分支 + notify 链透传 applicationId；顺带修 `durationMinutes:"abc"` 落成永久静默的 DTO 校验缺口。channelType 如实化为「仅作范围记录」（扇出前判定无法按渠道）。
  - **P2｜健康检查 redis 客户端无视 REDIS_TLS**（ba595fc5）：TLS 部署下 readiness 恒 not_ready → 健康实例被编排器反复摘除。透传 redis.tls 对齐 BullMQ 侧配置源；同批 checkScheduler getJobs→getJobCounts（积压数千时逐 job hgetall 风暴）+ 公开拨测 5s TTL（HEALTH_PUBLIC_CACHE_TTL_MS，0=关闭）。
  - **P2｜OIDC 二跳绕 SSRF 闸**（448db780）：token_endpoint/JWKS（来自 discovery 响应体）裸 axios + 跟随重定向——把 client_secret+授权码 POST 出去的一跳是全仓唯一没装闸的出站。补 assertAndPinHttpUrl + pinnedAxiosConfig + maxRedirects:0。
  - **P2｜node-sdk 熔断 half-open 探测槽永久卡死**（9b1d01c6）：4xx 既不 onFailure 也不 onSuccess → probeInFlight 永不清 → 客户端进程内永久砖死（python 侧 PK-09 try/finally 形态没镜像）。补齐 + 头注释 parity 前提修正。
  - **P2｜解释器池 LRU 断火在跑任务**（edd02a62）：回收否决权只查 venv 依赖，「声明版本无 requirements」的池解释器直跑路径无保护，且 mtime 只在安装时写——活跃版本最优先被回收。补在跑执行否决权（liveness 接线）。
  - **P3 批**：TOTP 重放防护（迁移 1790000000031 users.lastTotpCounter 原子占位，e892dd06）、registry-pypi 读取路径补包名安全闸（303f1b57）、rollout spec fake timers 消假红（5c66866f）、mcp/CLI analyze 类超时 30s→120s（d4f3bd22）、zip 下载 asyncio.timeout 真总预算（647301ad，沿用前任半成品测试）、requirements 解析双侧对齐 + BOM（3dea2f30）、桌面渲染层 ErrorBoundary（bafc9a61，静态守卫——仓库无 DOM 测试设施）、e2e 用例 3/4 补断言 + 每分钟 cron 任务清理 + 编号/键序修正（e70c56b3）、超时/隔离注释如实化（f1715e02）、死分支删除（0aec14d5）。
  - **残差（如实）**：channelType 按渠道裁剪、depsFiredAt 周期对账 sweeper（第二轮遗留）、「下载预算与任务剩余超时取 min」、per-task uid 真隔离——均为行为变更待拍板；e2e ⑦ 与 nginx -t 未真机跑（docker 不可用）；index-drift 守卫对 25 处未命名 @Index 只计数。

- **本轮（2026-09-19 → 第二轮深潜批次 NETOPT-3/4，主控编排 + 2 路深潜探查 + 2 路执行子代理，develop）**：用户指令「继续进行多轮」。第二轮换深潜镜头（第一轮已扫干净的常规维度不重翻）：DB 索引↔查询交叉核对 / 事务正确性 / scheduler 深潜 / CI 供应链安全 / compose 加固 / i18n 与长驻内存 / 执行器协议边界 / 文档漂移抽样，共 **17 条净新发现（7 P2 / 10 P3）**，全部落地（NETOPT-3 后端 6 条 / NETOPT-4 外围 11+2 条，13 commit + 编排者 CI 接线 1 commit），全部带反证。**主树复验**：admin-api 187 套件 **3075/3075**（+24）、executor-node **682 通过**（+6）、admin-web 路由错误边界 +9 例 + build 绿、tsc/eslint 0、75 迁移无撞号（预分配 1790000000029/30 已用，下一可用 1790000000031）。commit：NETOPT-3 = e87b293/81a5ace/00031b3/1edf6b5/ade2332/a03e6dc；NETOPT-4 = 35f207d/9b19369/8c86ec8/033d585/8093d3e/3bf7b8e/d649574；接线 1098d4d。
  - **P2｜实体声明索引从未落进迁移（PK-10 同型第三次重演）**（e87b293）：task_executions 的 `@Index(["status"])`/`@Index(["taskId","status"])` 在 57 个迁移里都不存在——PENDING 兜底清扫每 2 分钟 O(全表) 游走。迁移 1790000000029 补 `(taskId,status)`+`(status,createdAt)`+`config_history(createdAt)`，实体声明对齐；新增 `scripts/check-index-drift.mjs` 守卫（27 命名声明全比对、剥注释防自指误报、CI 已接 1098d4d）。
  - **P2｜依赖扇出失败永久静默丢**（81a5ace）：顶层吞错 + claim 先行 + 重复回调不重放 = 全仓唯一「核心编排语义无任何兜底」路径。迁移 1790000000030 加 `depsFiredAt` 旁路标记列：扇出成功落标记、重复回调遇 NULL 重放、trigger 失败 CAS 回滚 lastTriggerTime、单下游失败逐任务隔离。残差：无周期对账 sweeper（执行器整批重试覆盖崩溃窗）。
  - **P2｜CI 供应链硬化**（35f207d）：ci.yml 补顶层 `permissions: contents: read`（secret-scan 单独 security-events: write）；发布链两个持 token action SHA 钉死（git ls-remote 实取）；新增 dependabot.yml；redis zip 下载补实测 SHA256 校验。
  - **P2｜admin-web 路由零 errorElement**（033d585）：页面渲染错误/懒加载 chunk 失败此前全落 react-router 内置英文调试页（main.tsx 的 ErrorBoundary 在 RouterProvider 外层接不到）——根路由挂 RouteErrorBoundary（chunk 失效三类判定→刷新提示，复用 ErrorFallback 形态与 i18n，zh/en 同批）。
  - **P2｜executor-node 回调落盘原子化**（8093d3e）：node 侧 writeFileSync 直写（python 是 tmp+rename），半写文件被毒丸化后绕过 A6 对账、整批终态永久丢——对齐 tmp→rename + .tmp 纳入 TTL 清扫 + bundle sha256 同 commit 回填（05993801…）。
  - **P2｜pg-backup.sh 假成功空备份**（9b19369）：无 pipefail 时 pg_dump 失败被 gzip exit 0 掩盖——补 pipefail + <1KB 判失败。
  - **其余**：checkMisfires 挂 Leader 晋升点（failover 后 FIRE_ONCE 兑现）、分页 page @Max(10000)、getAllExecutions ILIKE 转义（API-09 util 第三处落点）、Grafana 口令 `:?`、promtail cap_drop/read_only/tmpfs、docs 三篇漂移修正（docker-compose.md 两处安全语义反向、executors-comparison.md 鉴权缺省姿态写反、CI 计数 26→37/43→48）、双 nginx conf S-08 头继承修复 + try_files =404（第一轮遗留）。
  - **残差（如实）**：depsFiredAt 周期对账 sweeper 未建；NETOPT-3③ fail-open 降级路径不补跑 misfire；index-drift 守卫对 25 处未命名 @Index 只计数不强推；nginx `-t` 本机不可跑（无 docker）；「并发双重复回调败者先落标记」窄竞态已在代码注释记录。

- **本轮（2026-09-19 → 净新优化批次 NETOPT-1/2，主控编排 + 2 路只读探查代理 + 2 路执行子代理，develop）**：用户指令「全方位探索优化的地方，多维度多角度，用 codegraph 快速推进了解状态，然后推进优化」。两路只读探查代理先对齐黑名单（optimization-notes 十三轮 / DEEP_REVIEW 145 条 / REVIEW_REMEDIATION_VERIFICATION 归档 / HANDOFF 快照）**只报净新**，共 **19 条（1 P1 / 3 P2 / 15 P3）**，全部带 file:line 证据与周边代码复核；其中 4 条溯源自 `docs/archive/reviews/round4-concurrency.md`「已记录但未进入 145 条处置清单」的漏网项。两路执行子代理足迹不相交并行落地（NETOPT-1 后端 admin-api 域 11 条 / NETOPT-2 边缘域 acf-cli+nginx+desktop+web 构建 8 条），**14 commit 全部在申报足迹内**（主控 `git diff --name-only` 审计零越界），**19/19 全部落地、全部带反证**。**主树复验**：admin-api 185 套件 **3051/3051**（基线 3036，+15）、acf-cli **121**（+9）、executor-desktop 自检 **11** 个全绿（+3）、admin-web build 绿（dist .br 84→0 / .gz 82，monaco 首屏守卫 5/5）、tsc/eslint 0。commit：NETOPT-1 = 6513754/f2ed090/012ed62/ec62263/d0e3ff8/85e0312/95b230c/82bc518；NETOPT-2 = ffed6cc/3ee5fda/5486510/cb5824c/5882a08/fcda92a。
  - **P1｜rolloutTick/probeDeployment fire-and-forget 无兜底 → 一次 DB 抖动整实例退出**（6513754，净新项里性价比最高）。`app-deployment.service.ts` 的 `void this.rolloutTick(...)`/`void this.probeDeployment(...)` 方法体此前零 try/catch，而 main.ts 的 `unhandledRejection` → gracefulFatalShutdown → exit(1)——灰度推进 tick 期间一次瞬时 DB 故障 = 单实例部署服务中断。修法：拆 wrapper+inner 加顶层兜底（记 error 不外抛、不改批次/行状态），tick 出错且批次在途则续排下一 tick，对齐 outbox-dispatcher「全程兜底绝不外抛」纪律。反证：catch 改 rethrow → 3 例全红。
  - **P2｜round4 漏网三连**（012ed62/ec62263/d0e3ff8）：① task_executions 日清理从单条无界 DELETE（峰值行长事务锁表、阻塞回调路径条件 UPDATE）改 `id IN (SELECT...LIMIT 5000)` 分批（照抄同文件 R-09 模式），audit 侧每批各自 bypass 事务；② `triggerDependentTasks` 收窄 `.select(id, dependencies)`——此前每次 SUCCESS 回调都全实体扫 tasks 表（glueSource/runbook/secrets 密文全部物化后丢弃）；③ handleCallback 循环内逐条 task 点查改批前 `In()` 建 Map；④ getSummary 聚合加 30 天时间界 + getTodayReport 并发首访 23505 兜底重读。
  - **P2｜acf-cli 两条「假绿」退出码通道关闭**（ffed6cc）：`task trigger --wait` 轮询超时此前静默 exit 0（>10min 长任务必触发，CI 里 `acf task trigger --wait && deploy` 假绿）→ exitCode=1 + `--wait-timeout` 选项；`exec tail` SSE 断流（未收 done 帧）此前同样 exit 0 → `sawDone` 判据 + 断流 exitCode=1。
  - **其余**：SSE 日志流轮询 abort 监听器成对移除（每连接最多 ~1800 滞留闭包）；detectLostExecutions 补 take(1000)（批量写刻意未做——会绕过 A1 状态机/事件/槽位释放语义）；订阅 consecutiveFailures 改 DB 内原子自增（并发丢更新）；executions-stream 残留 `?access_token=` 注释与 A5 现实对齐；CI coverage job 错峰（PR 只跑 4 分片门，每 push 少跑一遍 3000+ 全量）；nginx 双配置静态资源链对齐 + index.html no-cache（防发版后启发式缓存指向已删 hash chunk 白屏）；vite 停产 .br 死产物（stock nginx 无 brotli 模块，注释承诺与产物行为相反——PERF-01 同型）；桌面 logs:getToday 尾部窗口读（主进程不再整读整天日志）、子进程输出按行缓冲（结构化日志通道不再静默失效）、os.setPriority 替代一次性 powershell。
  - **遗留观察（如实，未动）**：① admin-web nginx.conf 静态资产 location 因 add_header 继承陷阱历来丢 S-08 安全头（本次 index.html location 已逐条重复避免同坑）；② default.conf 静态段缺 `try_files $uri =404`；③ 本机无 docker，nginx `-t` 与 nginx-sse-selftest 未实跑（改动为对既有生产指令的镜像复制，逐条人工核对）；④ NETOPT-1⑦ SSE 轮询监听器修复无独立用例（控制器 spec 完全 mock 该路径）。

- **本轮（2026-09-19 → 「超棒的体验」专项批次，develop，主控 + 4 路只读体验审计 agent）**：用户指令「作为负责人继续在 develop 推进审查、开发和优化，目标是超棒的体验」。先跑 4 路**只读**审计（admin-web 交互 / admin-web 性能 / admin-api / executor+desktop），每条候选缺陷都由主控**回读源码独立复验**后才采纳，并显式记录「已核实无需改动」项以防重复翻案。共 **9 个 commit、19 个真实缺陷**，全部带反证测试（临时回退产品代码 → 用例转红 → 恢复），CI 逐 commit 全绿。**基线上调**：admin-api 3001→**3014** 例、admin-web 881→**953** 例、executor-node 670→**676** 例。
  - **P1｜PERF-01：monaco 编辑器被打进首屏，代价 651 KB gzip**（本轮最有价值的一条，也是唯一「注释断言与实测行为完全相反」的缺陷）。`vite.config.ts` 的 manualChunks 有一行 `['vendor-monaco', [...]]`，注释写着「monaco 主包不进首屏 chunk」，**实测恰恰相反**：产物 `dist/index.html` 里同时有 `<link rel="modulepreload" href="/assets/vendor-monaco-*.js">` 与 `<link rel="stylesheet" href="/assets/vendor-monaco-*.css">`，而 vendor-monaco 是 **2.53 MB raw / 651 KB gzip**，外加 74 KB render-blocking CSS——是首屏最大一笔，登录页用户完全用不到。机理：manualChunks 把 monaco 提成**共享 chunk** 后，只要有静态可达模块与该 chunk 产生静态边（实测 entry 经 i18n/antd 那一片共享依赖即命中），Vite 就把整个 chunk 当 entry 的静态依赖预加载——`GlueEditor` 是不是 lazy 已不重要。删掉该条目后走 Vite 默认分包，monaco 全部收进 lazy 的 `GlueEditor` chunk，index.html 里 monaco 的两条引用双双消失。**教训**：配置注释、配置代码、产物行为三者可以完全不一致，只有**读产物**才能发现；守卫也因此直接读 `dist/index.html` 而不是读配置。
    - 连带修了一个会让守卫**空转**的 CI 顺序问题：`admin-web-build` 原先 `npm test` 排在 `npm run build` **之前**，而该守卫读构建产物 → 会永远 skip、永远绿。已把 build 提到 test 之前，并让守卫在 CI 里读到产物缺失时**显式报错**而不是安静跳过（宁可红一次提醒排序，也不要一个看着在、其实不在的闸）。
  - **P1｜EXP-01：`sandbox_unavailable` 四端枚举缺失 → 回调被 400 拒 → **整批**终态丢失**。python 执行器自 F-1 起就会产出 `sandbox_unavailable`（bwrap 缺失 / 用户命名空间被禁），而四端枚举都没有它：admin 回调 DTO 的 `@IsIn` 命中即 400，python 把 4xx 当**不可重试**并放弃**整批**（`_send_callback_batch_with_retry`）——一台配错沙箱的执行器会让该机**所有**任务的终态回调永远送不出去，连同批最多 99 个无关的成功任务一起丢失，用户看到它们永远停在「运行中」。而既有契约测试只把契约与自身比对、**从不校验 python 的实际产出面**。修法：补齐 protocol.json / admin / node / autoflow-sdk **四端**枚举，并新增「产出面 ⊆ 契约面」守卫（驱动**真实**的 `_refine_failure_reason` 跑 ~18 条消息）。**注意**：首版只改了三端，是 CI 的既有守卫 `scripts/check-failure-reasons.mjs`（覆盖四端）抓出了漏掉的 autoflow-sdk——**先读仓库既有守卫覆盖面，再决定"改几处"**。
  - **P1｜PERF-03：执行列表回传 512 KB 级的 text 列**。`getExecutions` / `getAllExecutions` 取整行，而 `task_executions.logs` 单条上限 512_000 字符（回调 DTO 的 `@MaxLength`）——一页 20 行满载近 10 MB，全部经 SQL/JSON/网络后被前端原样丢弃（列表只渲染 status/executorAddress/startTime/duration/errorMessage，详情页日志走独立端点 + SSE）。修法：由 **TypeORM 元数据**派生投影列（全集 − 重型文本排除表）。**方向性刻意选「排除表」而非「包含表」**：包含表在实体新增列时会把新列**静默丢掉**（读面少字段不报错、只显示空白），正是本轮反复在修的那类静默损坏；排除表则新列默认入选。
  - **P1｜API-01：`reload-config` 用 401 表达业务失败 → 把管理员踢下线**。executor 离线/不可达时返回 401，而前端 401 拦截器是**共享的安全机制**（尝试刷新令牌，失败则 `logout()` + 跳登录）。于是"执行器离线"这个普通业务状况会导致**管理员被登出**。修法：离线/不可达改 **503**、执行器持有令牌与签发不一致改 **502**，前端拦截器不动（正确做法是停止误用 401，而不是削弱安全机制）。
  - **第二批（同日，继续推进）**：在第一批 9 个 commit 之后又交付 **6 个 commit / 8 个缺陷**，同样逐条带反证、CI 全绿。
    - **P2｜PERF-06：SSE 日志追加是 O(n²)**。`setStreamLines(prev => [...prev, line])` 每来一行付一遍整数组拷贝，而渲染体里**无条件** `streamLines.join('\n')` 再付一遍整串拼接——20k 行时每个渲染都在拼 20k 段字符串，SSE 回调与渲染同在主线程，页面随日志增长越来越卡。修法两步：到达的行入 ref 缓冲 + `requestAnimationFrame` 合并成"一帧最多一次 setState"（并 `cancelAnimationFrame` 防卸载后 setState）；`join` 用 `useMemo` 缓存（依赖只有真正决定结果的 `streamLines`/`data?.logs`）。行为层守卫用**显式桩掉的 rAF + 手动泵帧**，使"一帧内 50 行只触发 1 次更新"成为确定性断言。
    - **P2｜PERF-10：安装向导等待轮询不判可见性**。第 5 步轮询「新执行器是否上线」，而用户的**标准动作正是切到另一台机器去装**——标签长时间隐藏，12 次请求全打在用户看不到的时刻。本仓**已有三处同款守卫**（ExecutionsPage/ExecutionDetailPage/AppDeploymentPage），本页漏改。修法：`visibilityState !== 'visible'` 时跳过本次请求、只续期下一次；**计时不暂停**（否则切回来会发现"60s 还没到"，与倒计时显示矛盾）。
    - **P2｜EXP-06：Python 环境诊断在保存配置后不刷新**。诊断 effect 依赖只有 `[active]`，于是用户在这一页改完 uvPath / 解释器池 / 下载预算并保存后，诊断块**仍显示旧值**——而它的全部意义就是回答"我配的到底生效了没有"。修法：抽出 `refreshPyEnv()`，切页照旧 + **保存成功后**再调一次（只在成功分支）。
    - **P2｜API-07：分页 DTO 混入任务过滤字段，`/users` 契约公示了不生效的参数**。根因在分层：`PaginationDto` 把任务专用的 `name`/`status`/`runtime` 混进"分页"这个通用概念，被 6 个 DTO 继承、出现在**所有**分页端点的参数表上；`GET /users` 契约写着 `name` —— "Fuzzy search by task name"，而 `usersService.findAll` **完全忽略它** → `?name=alice` 静默返回未过滤的全量列表且 200，调用方无法分辨"没有匹配"与"过滤没生效"。修法：新增纯分页基类 `PageQueryDto`，`PaginationDto extends` 它（既有 6 个 DTO 行为不变），users / config-history 改继承纯基类。**纯契约收窄**：openapi.json 的 diff 是 54 行纯删除、零新增。
    - **P2｜API-09：审计搜索的 LIKE 元字符未转义 + `action` 白名单过严**。① `username` 过滤直接拼 `` `%${input}%` ``，而 ILIKE 里 `%`/`_` 是通配符——运维搜真的含下划线的用户名 `zhang_san` 会**命中 `zhangXsan` 这类无关账号**，搜 `%` 命中全部；审计场景里"多给证据"比少给证据更容易误导。② `action` 要求 `^[a-zA-Z0-9_.\-\s]+$` 否则 400，但注入风险早已由**绑定参数**消除，白名单只剩副作用：中文 / `:` / `/` 这类正常搜索词直接吃 400。修法：新增 `escapeLikePattern()`（**先**转义 `\` 再转义 `%`/`_`，顺序不能反），两处共用；白名单放宽为只限长度。安全性是**变强**：旧白名单挡的是"特殊字符"，而真正可利用的 `%`/`_` 它没挡（`_` 还在白名单里，`username` 分支更是完全没有白名单）。
    - **CI 抓到的一个真实漏网（值得记）**：PERF-10 守卫里 `String.replace(regex)` **漏传替换串**，`tsc -b` 报 TS2554，`admin-web-build` 与 `windows-admin-web` 两个 job 同时变红。**本地为什么没抓到**：我跑的是 `tsc --noEmit -p tsconfig.app.json`，而 CI 跑的是 `npm run build` 里的 **`tsc -b`**（solution-style，**包含 `src/__tests__/**`**）——前者不含测试文件，给出了虚假的"0 error"。**教训：核对某子项目"CI 实际跑什么"再跑**（本仓 admin-web 的构建即类型检查且覆盖测试）。
    - **第二批的守卫补强**：所有"读源码做断言"的守卫一律**先剥注释**——本轮两次踩到"注释里引用了旧写法，被守卫当成缺陷本身"（API-09 的头注与源码注释都写了旧白名单正则作反例，导致误报且红得毫无线索）；字符串断言做**空白归一**（prettier 折行不该让守卫变红，那是判据失效而非漏网）。
    - **第二批基线上调**：admin-api 3014→**3036**（185 suites）、admin-web 953→**970**（110 files）、executor-node 676（33 suites，EXP-02 后不变）。
  - **P1｜PERF-02：DAG 依赖边集恒空**（功能损坏，不是"慢"）。`dependencies` 被排除在 `TASK_PROJECTION_WHITELIST` 之外（请求即 400），而 DAG 的边集**只**来自该字段 → 页面永远显示「该任务没有依赖其他任务」，「触发整条链」退化成单任务。
  - **UX 系列（8 条，全部为暗色/语义/诚实性类用户可见缺陷）**：UX-01 `--color-secondary` 是**表面色**却当正文色用，暗面卡上对比度 **1.13:1**（Dashboard 是登录后落地页，KPI 脚注/热力条百分比全糊成同色）；UX-02 登录页暗色下仍是亮底、卡片标题 `#333` 对比度 **1.31:1**；UX-03 三处「警告档」取到 `--color-ring`（双主题都是品牌绿）→ 失败 2 次比失败 1 次看起来更健康、P99 300ms 显示绿色、CPU 70% 与 20% 同为绿色；UX-04 剪贴板「假成功」（2 处密钥复制无 await/无 catch **无条件**置「已复制」，而密钥明文只显示一次——非 HTTPS 下用户带着空剪贴板关掉弹窗就再也拿不回来）；UX-05 读取失败被谎报成「暂无数据」（TasksTab 失败后渲染「暂无任务」+「创建第一个任务」引导按钮）；UX-06 四处直接渲染后端裸枚举；UX-07 ADMIN 门控在 profile 失败时**永久转圈**（无提示无重试）；UX-08 settings 整页仍用裸 `<Spin/>` 而非 UI-08 契约要求的骨架屏；UX-09 键盘焦点环是 antd 旧默认蓝 `#1677FF`；UX-10 模板分类标签在英文界面下露中文；UX-11 错误提示绕过 `getErrMsg` 直接取 `.message`（露 axios 英文技术串 `Request failed with status code 400`）。
    - **UX-09 的取舍值得单独记**：最"合理"的修法是用 `--color-accent`（品牌绿）统一，但实测 **#22C55E 在亮面 #FFFFFF/#F1F5F9 上只有 2.28:1 / 2.08:1，低于 WCAG 2.2 SC 1.4.11 对焦点指示器要求的 3:1**——为颜色一致性牺牲"键盘用户看得见焦点"是把 a11y 换成好看。故新设专用令牌 `--color-focus-ring`（亮 #16A34A 3.30:1 / 暗 #22C55E 7.25:1），并让守卫**自己算对比度**，不把选色依据留成注释里的口头承诺。同理 `--color-ring`（MASTER 语义 #0F172A）当焦点环在暗面仅 **1.08:1**，等于没有。
  - **EXP 系列（desktop/executor，3 条）**：EXP-04 状态页 `getStatus()` 无 `.catch` → 配置损坏时 `statusLoaded` 永远 false，**启动按钮永久灰色不可点**且页内无任何提示（同文件 `getTodayLogs()` 本就有 `.catch`，属遗漏）；EXP-05 「主进程日志 (main.log)」是**幽灵条目**（logger 实际落盘名是 `executor-YYYY-MM-DD.log`，因 `existsSync` 守卫该条目永不出现）→ **昨天的桌面端日志从 UI 完全不可达**；EXP-09 `listLogFiles()` 无 `typeof` 守卫也无 `.catch` → 旧版 preload 下**同步抛 TypeError → React 卸载整棵树 → 窗口只剩背景色**（正是 `preload/index.ts:40-42` 记录过的事故形态）。
  - **EXP-03｜加了参数但大部分调用点没跟上**（形态值得单独记）：「中台直达探针」（F-3 为"子进程活着但中台链路断了"而加）需要 `heartbeat.start(port, adminApiUrl)`，而全仓 5 处调用点**只有 1 处**传了它，漏传的恰好是**用户最常走的四条**（开机自启 / 点「启动执行器」/ 改配置保存 / 向导保存）。不报错、不让测试变红、不产生日志，只让功能静默退化成修复前的样子。修法：收敛为**全仓唯一入口** `startHeartbeat()`，守卫断言「ipc-handlers 里直接调用恰好 1 处、index.ts 里恰好 0 处」。
  - **EXP-02｜uv 缺失遮蔽解释器归因**：建 venv 分支原先**先** `resolveUvForExecute()`、**后** `ensureInterpreter()`。`uv is not available...` 既不匹配解释器规则、也不含 `解释器 <X.Y> 无法获取` 骨架 → 落到兜底 `unknown`；而 **python 在同一情形报 `interpreter_unavailable`**。后果是**分类语义丢失**：运维按该分类筛"该预填解释器的机器"时，node 上的这类失败全部落进 `unknown` 桶被筛掉。修法：把 `ensureInterpreter()` 提前（`ensureVersion()` 走解释器池，**不需要 uv**）。
  - **API-02｜400 校验失败的字段级原因对用户不可见**：`message` 固定为 "Validation failed"，真正的字段原因在 `data` 里，而**两个前端消费方（`getErrMsg` 与 axios 拦截器）都只读 `data.message`**，从不读 `data.data` → 排障时只能看到"校验失败"而看不到哪个字段。修法：把原因折进 `message`（保留 `data` 里的原始数组以兼容）。
  - **回归（本机 Windows）**：admin-api **3014**/183 suites；admin-web **953**/108 files；executor-node **676**/7 skipped/33 suites；executor-python 868/3 skipped；desktop `test:main` 全部 selftest + `test:renderer` 全过；`lint:all` 0 error；`check-failure-reasons` / `docs-site sync-check` / `lint-gates` 三个仓库守卫全绿。CI 9 个 run 逐条全绿。
  - **产物同步（ADR-005）**：改 `executor-node/src/callback.ts` 与 `routes/execute.ts` 各重打一次 ncc 内嵌 bundle（2469→2474→2475kB），两次**本机(Windows)与 CI Ubuntu 独立重打得到同一哈希**（`cee23087…` / `dc8abcda…`），再次印证 ncc 0.44 的跨平台字节确定性。
  - **三条方法学教训（都实际踩到）**：① **`executor-node` 跑的是 Jest 不是 vitest**——首版 EXP-02 守卫误用 vitest 形态（`import { describe } from 'vitest'` + `expect(x, msg)` 第二参数），导致该子项目 **65 个测试文件**整套无法加载；写守卫前先确认该子项目的 test runner。② **`expect(x, message)` 是 vitest 专有**，Jest 的 `expect` 只吃一个参数，断言消息要靠注释或断言值表达。③ **源码字符串断言必须做空白归一**：prettier 会按行宽把调用折行，"代码没变只是换行"不该让守卫变红（那是判据失效而非漏网）。
- **上一轮（2026-09-18 → develop 同步 + 全局体验/执行器关联深度排查批次，主控 + 5 路并行审计 agent）**：`develop` 此前是 `main` 的**严格祖先**（0 ahead / 11 behind），`git merge --ff-only main` 快进同步（`6640437..d72e396`），随后在 develop 上做深度排查。本批**全部为已实测的真缺陷**，每条都配了**反证测试**（临时回退产品代码 → 用例转红 → 恢复），并把 3 个 P0 的成因写进代码注释。
  - **P0-1｜executor-node 的 requirements 校验不分 runtime（python 任务的 pip 依赖被全部误拒）**：`routes/execute.ts` 入口对**所有** runtime 一律套 npm 命名正则，于是 python 任务的 `requests>=2.31`（**正是 admin DTO 里写明的示例**）、`rich==13.7.1`、`requests[socks]==2.31`、`flask~=3.0`、`zope.interface>=5`、带 marker 的 `requests ; python_version<"3.8"` **全部 400**；而同一个包在 executor-python 上正常——正是 CONTRACT §3.3「全对等」要求消除的那类分歧。**反向更危险**：npm 正则**接受** `-r` / `--index-url` 这类单 token，而它们会被原样 push 进 `uv pip install` argv（包索引劫持）。修法：按 runtime 分流（python 用 python 的判据：非空且不以 `-` 开头），并在 `uv pip install` 前加**第二道闸门**（`ensurePythonVenv` 内）覆盖 manifest ∪ 包内 requirements.txt 的合并结果——入口闸门只看任务声明的依赖，够不到后两个来源。反证：回退分流分支 → 2 例转红。
  - **P0-2｜桌面执行器只监听 127.0.0.1，push 派发永远到不了它（v1.5.2 已发布）**：executor-node 的 `config.bindAddress` 默认 `127.0.0.1`（E-25 为裸机安全而设），容器由 `docker-compose` 显式设 `0.0.0.0`，**桌面端当时漏了**（`git show 23edcd8` 不含任何 desktop 文件）。桌面注册的是向导填入的**局域网地址**，admin 按该地址 POST，而进程只听 loopback → 每次派发 `ECONNREFUSED`。表现是"注册成功、托盘绿灯、**永远收不到一个任务**"，且未设 `EXECUTOR_PULL_MODE`（push 模式）没有兜底。修法：把子进程 env 抽成**纯函数** `buildExecutorChildEnv`（放 `uv-paths.ts`，Electron-free 以便自检），补 `BIND_ADDRESS`；**同时补 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`**——ssrf-guard 默认 fail-closed，而桌面要下载的 `packageUrl` 按构造就是私网的（admin 用 `API_BASE_URL` 拼），缺了它 zip 渠道任务的下载会被**执行器自己**的闸门拒掉，而 git/纯依赖任务正常（表现为"有些任务莫名失败"）。反证：从纯函数删掉 `BIND_ADDRESS` → 自检立即断言失败。
  - **P0-3｜node 在上传包解压后才读 manifest（包内数据→任务配置）**：`loadManifest(workDir)` 原在 zip 解压**之后**，于是上传者只要在包里塞一份 `manifest.yaml` 就能改掉任务的 entrypoint/requirements/runtime。python 侧一直是"git 后、解压前"（`load_manifest` 在 zip 块之前），两侧**次序相反**。修法：把 manifest 读取移到**git clone 之后、zip 解压之前**，与 python 逐字对齐（git 渠道仍能读到仓库自带的 manifest）。
    - **附带修正一条"名字与断言背离"的假绿测试**：既有用例名叫 `a package-supplied manifest.yaml cannot hijack the entrypoint`，但它的断言是 `expect(manifestLoadedAfterExtract).toBe(true)` ——把**有漏洞的次序**钉成了期望值（所以 bug 在、测试也绿）。已把断言翻正，并在注释里写明"名字与断言背离"这一形态。
  - **P1｜python 缓存池解析在含空格路径下静默丢弃全部条目**：`interpreters.py` 用 `line.split()` 取 `parts[-1]` 当路径，而 `<key>` 不含空白、**路径可以含**（`C:\Program Files\interpreters`、`/opt/my pool/...`）。含空格时只拿到最后一段 → 既非绝对路径也不在池内 → 该行被丢弃 → **池里有解释器却报空池** → 该机上所有声明 `runtimeVersion` 的任务必然 `interpreter_unavailable`。node 侧不受影响（用 `uv python list --output-format json`，其注释还专门写了"文本列空白对齐随版本变化"）。修法：按**首个空白串**切分（`split(None, 1)`）。反证：回退 `parts[-1]` → 用例转红（实测 `[]`）。
  - **P1｜python 的解释器下载预算错用了本地建 venv 的 60s**：三处 `_ensure_interpreter(..., timeout=UV_VENV_TIMEOUT_SECONDS)` 用的 60s 是"在**本地**建 venv"的量级，而下载要走网络（默认 ~30MB 的 python-build-standalone）。node 读的是 `config.interpreterDownloadTimeoutMs`（默认 **300s**），两侧不对等。新增 `_interpreter_download_timeout()` 读 `settings.interpreter_download_timeout_seconds`（默认 300，非法/缺省回落 300，**绝不回落 0**）。反证：让该函数返回 60 → 用例转红（`assert 60 == 300.0`）。
  - **P1｜桌面端两处键名/文案陷阱**：(a) 设置页写 `INTERPRETER_DOWNLOAD_TIMEOUT_MS`，而 executor-node 只读 `..._SECONDS` → **用户填的值完全不生效**（且若真按秒解析，300000 会被钳成 24 小时）；改为**两键都收、毫秒优先**（保留 compose 既有语义不变）。(b) 「对外地址」placeholder 承诺"留空自动检测"，但主进程**没有任何自动检测**：留空会回落 `executorHost` 的默认 `0.0.0.0`，而 admin 把 `0.0.0.0/8` 归为 `reserved` 并**无条件拒绝**（连私网开关也不放行）→ 用户照做就得到一个"注册成功、显示在线、永远派发不到"的执行器。改文案 + 留空时用第一块网卡兜底，并在 env 构造函数里再加一道（通配地址不下发）。
  - **P1｜node 从不发送结构化解释器快照**：python 在 `_interpreter_failure_result` 里把 `{requested, resolved, reason, detail, pool}` 放进 `result.interpreter`（admin 早已有 DTO 与落库路径），node 只发一句文本 → 同一类失败两个执行器留痕能力不对等。新增 `InterpreterUnavailablePrepareError` 携带快照并在 `pushCallback` 带出。**顺带抓到一个我自己差点引入的静默失配**：`poolSummary()` 返回本地 camelCase `installDir`，而线上契约与 `admin-web` 的 `normalizePool` 只读 snake_case **`install_dir`** ——直接下发会让"池目录"一栏永远渲染成 `-`（看着有数据其实读不到）。已按契约形状转换，并用**键集合**断言钉住。反证：删掉 `result` 分支 → `undefined` 转红；改回 camelCase → 键集合断言转红。
  - **P1｜zip 安全三处不一致（node ↔ python）**：(a) 压缩比按**已遍历前缀**逐条即时比较，于是同一个包换个条目顺序结论相反（既误杀正常包，又可被顺序操纵绕过），node 侧的 `zip-guard` 却用整包总量——两者对同一包给相反结论；改为**整包汇总 + 写出任何字节前判定**。(b) bzip2(12)/lzma(14) node 拒绝、python 接受 → 同一个包"在 python 上成功、在 node 上失败"；node 只用 zlib 解不开它们，故按**更严的一侧**对齐（python 侧同样拒绝）并给出可操作文案（点名方法号 + 只支持 0/8 + 建议重打包）。(c) 条目名含 NUL 时 node 拒绝、python **静默截断**（`zipfile` 在首个 NUL 处截断，`evil.py\0.txt` 变成 `evil.py`，可绕过按扩展名的检查）→ 统一拒绝，且必须查 `orig_filename`（`filename` 已被截断、NUL 在那里不可见）。反证：分别回退三处 → 各自的用例转红（python 侧实测 `DID NOT RAISE`）。
  - **P1/P2｜admin-web 读面缺口**：(a) 解释器失败分因映射漏收 `mirror_unreachable` / `download_timeout`（正是私有化内网镜像下最需要立刻分辨的两类），漏收不会报错、只是把**裸 token** 渲染给运维；同时删掉**幽灵分因** `cache_miss`（两个执行器都不产出它）。(b) `RETRYABLE_ERROR_LABELS` 漏收 `interpreter_unavailable` → **中文标签漏进英文界面**（消费处 `?? o.label` 静默兜底，中英字典里其实早有词条，只是没人接上）。(c) 提交校验失败时**只有一条 1×1px 的读屏区域**，视力正常的用户屏幕毫无变化（出错字段在视口外时更会以为"按钮没反应"）→ 补浮层提示 + `form.scrollToField`。(d) Dashboard「最近失败」直接渲染**裸枚举并截断 12 字符**，于是 `interpreter_unavailable` 显示成 `interpreter_…`（既非中文也非英文）→ 收敛到新的读面唯一事实源 `utils/failure-reason-label.ts`（Dashboard / ExecutionCompare 共用，ExecutionDetailPage 的富映射仍独立因为它还承载 color/hint）。(e) 状态下拉的 `busy` 是**死选项**（admin 的 `ExecutorStatus` 只有 online/offline，"忙碌"由 runningCount/max 表达）→ 删除，并把未知状态**保守**渲染成离线（宁可误报离线也不把不可用涂成在线）。(f) `Executor` 接口漏声明 `interpreters`（后端 `findAll()` 是展开实体，字段**一直在响应体里**）。
  - **P1｜模板回退丢字段（三个映射方向）**：`runtimeVersion` 与 `codeSource` 在"表单→模板"（`task-template-config-from-form.ts`）、"Task→模板"（`task-template-extract.ts`）、"模板→表单"（`task-template-prefill.ts`）**三个方向全漏**，于是"存为模板 → 从模板建任务"会静默丢掉用户显式做过的选择：版本丢失 → 任务落回宿主默认解释器（用户以为钉住了 3.7 并为它预填了缓存卷）；来源丢失更隐蔽 —— `gitRepo`/`applicationId` 还在，后端只能按迁移期隐式推断还原来源，用户选过的通道被悄悄改写。两个键都是 `CreateTaskDto` 的合法字段（模板 config 就是按 CreateTaskDto 子集校验的），后端一直收得下，只是前端没发。
    - **修的过程中发现纯映射层不够**：`runtimeVersion`/`codeSource` **不在表单字段树里**（各自组件自持 state），`setFieldsValue` 对它们无效 —— 预填必须像编辑态回填那样显式同步到 state，否则"看着修好了、其实没生效"。已在模板预填 effect 里补 `setRuntimeVersion` / `setCodeSource`（复用提交路径的同一组纯函数，保证模板里的值与真实提交逐字一致）。反证：双向回退 → 2 例转红。
  - **P2/P3｜执行器生命周期与桌面接线**：新增 `GET /executors/runtime-config` 回传**后端有效判死阈值**（`heartbeatInterval × multiplier`，默认 90s）与列表截断上限；前端列表/卡片/详情三处此前**各自硬编码** 2 分钟与 5 分钟，于是后端判死后最长约 3.5 分钟里 UI 仍把心跳画成绿色"刚刚"——现三处同源（取不到回退 90s，方向**保守**：只提前标黄，绝不把真离线的节点涂绿）。空名单推送改为只推 **ONLINE** 行（控制器 `@ApiBody` 与按钮文案承诺的就是"全部在线"，旧实现对离线机器产生一整片连接失败）。`logLevel` 从"无生产者无消费者的死字段"变成全链生效（桌面设置页 → `buildExecutorChildEnv` → node 的 winston 读 `LOG_LEVEL`，白名单校验、非法回落 info）。删掉两个**注册了但 preload 从未暴露**的死 IPC handler。桌面新增「监听地址」控件（bind host 此前只在向导里硬编码、事后无法修改）。
  - **回归（本机 Windows）**：`typecheck:all` **7 工程 0 错**；`lint:all` 0 error；`check:protocol-sync` 绿（生成物零漂移）；executor-node **628**（基线 613）、executor-python **800**（基线 769）、admin-api **2968**（基线 2961）、admin-web 新增/改动用例全绿、desktop main+renderer selftest 全过、acf-cli 与 mcp-server（113）全过。
  - **产物同步（ADR-005）**：`apps/executor-node/src` 改动 → ncc 0.44 重打内嵌 bundle（2385kB → 2396kB），**同目录重复构建字节一致**（确定性已验证两次），新期望 sha256 `dced4db5…` 回填 `executor-node-bundle.sha256` 并校验 manifest == artifact。**如实登记的遗留**：本机（Windows 工作区）产出与 CI Ubuntu runner **必然不同**（ncc 的 module id 由**真实绝对路径**派生，见 `docs/design/python-task-upload-and-multiversion/BUNDLE-DRIFT-FINDING.md`），故 `desktop-bundle-drift` 需以 CI 侧 actual 回填后方能转绿——这是该闸的**既有**遗留动作，不是本批引入（协作期间曾有一版在源码仍在变动时取的快照被写进 manifest，已按"以实测为准"校正，避免提交一个对不上的期望值）。
  - **两条重要的方法学教训（都实际踩到，供后续会话避坑）**：
    1. **`npx tsc --noEmit` 在 `apps/admin-web` 下等于什么都没检查**：该目录的 `tsconfig.json` 是 `{"files": [], "references": [...]}` 的 solution-style 配置。我一度据此宣布"tsc 0 错"，随后用 `tsc -p tsconfig.app.json` 才发现真有 3 个错（含一个未定义标识符）。**根级 `typecheck:all` 用的是 `tsc -b` / `-p <真实配置>`，必须以它为准。**
    2. **admin-web 全量套件在负载下会产出超时假红**：`vite.config.ts` 里已有记录（空闲 2 红 / 中等负载 14 红 / 高负载 31 红，全部是 `Exceeded timeout` 而非断言失败）。本批并发跑 4 个套件时确实复现（3 轮各挂 1 个**不同的**用例，单跑全过）。**判定方法：把改动 stash 掉、用同一文件组合跑基线** —— 基线同样挂相同的用例，即可确认是预存 flaky 而非本批回归。**结论：admin-web 全量请串行单跑，且不要与其它套件并发。**
- **上一轮（2026-09-15 → kill/logs 两端共有响应契约化：新增生成的 KillResponse/LogsResponse 并接进两侧运行时，主控）**：A3-C 残差收口（commit c941ac9）后，协议面只剩 `kill/deploy/update-package/logs` 载荷未 schema 化。先盘点两侧端点：`/deploy`、`/app-stop`、`/app-status`、`/update-package*` 是 executor-node **独有**（python 无对应 router，按「修改纪律」不拉进共享契约）；两侧**共有**的 `/execute`、`/kill`、`/config/reload`、`/health*`、`/logs/{id}` 里只剩 kill/logs 没收，本批收口这两个**响应**。
  - **形态**：`protocol.json` 新增两个顶层 object schema，均 `additionalProperties:false`（生成 zod `.strict()` / pydantic `extra="forbid"`，给输出契约最强约束——两侧现状都只回声明字段、无额外键）。`KillResponse={ok:boolean}`（200 true / 404 false 语义写进 description）；`LogsResponse={lines:string[],totalLines:integer≥0,hasMore:boolean}`。现共 **7 个** schema。
  - **运行时接线**：node `routes/execute.ts` 新增 `killBody(ok)`（safeParse 不过即 throw 走 500），kill 五个返回点（404 一处 + 200 四处）全改走它；`routes/logs.ts` 成功页过 `LogsResponseSchema` 后才发送。python `routers/execute.py` 新增 `_kill_body(ok)`（`ProtocolKillResponse.model_validate(...).model_dump()`），三处返回改走它；`routers/logs.py` 返回前过 `ProtocolLogsResponse`（本地 response_model 管序列化，生成物管两侧形状不漂移）。
  - **三个跨语言/生成器坑（都钉在向量注释/README 里）**：① node `protocol-schemas.spec.ts` 有一份**手写 SCHEMAS 映射**（刻意逐个 import 证明生成物），新增 schema 必须同步补 import + 映射，否则 meta 守卫与全部新向量假红；python 侧 `_SCHEMAS` 是 `getattr` 动态构建、自动覆盖。② pydantic lax 会把 `'yes'/'true'/0/1` 强转 bool（zod 拒绝一切非布尔），故 `ok-not-boolean` 非法向量改用两侧默认模式都拒绝的 `"maybe"`（实测 'yes'/'true'/1/0 被 lax 接受、'maybe'/2/[]/{} 被拒）。③ zod `.strict()` 把未知键报在**根路径**（键名在 `issue.keys`），pydantic forbid 报在该键 loc，两侧错误定位不同形、无法用单一共享 `expectErrorPath` 表达，故「多余键拒绝」**不放进共享向量**，改由两侧各自运行时测试断言。
  - **反证有牙**：node `execute.spec.ts`（404 + 在跑 200 两条真实 kill 出参过生成 schema、strict 拒多余键）、`logs.spec.ts`（真实分页过 schema + strict）；python `test_kill.py`（404 出参过生成物 + forbid + `_kill_body` 两分支）、`test_logs.py`（真实分页过生成物 + forbid）。把任一出参改回裸字面量/加未声明键，对应用例立即红。
  - **产物同步（ADR-005）**：ncc 0.44 重打内嵌 bundle（2279kB→2280kB），两次重打哈希字节一致（确定性验证通过），新期望 sha256 `9c6487635c37558f7cc850dc78d76afc5484734965e68977171e82e997fda483` 回填 `executor-node-bundle.sha256`（含变更记录），并 grep 确认 killBody/logs 闸门代码确已进 bundle。生成器连跑两次产物字节一致（幂等），`check:protocol-sync` 的 git diff 在提交后即绿（未提交时显示本批新增属预期）。
  - **回归（本机 Windows，串行实跑）**：typecheck:all 7 工程 0 错；eslint 改动文件 0 问题；py_compile 净；enum-drift / check-migrations / consumer-routes 守卫全绿；executor-node **418/418**、executor-python **394/394**（全量 3:04）、admin-api 全量见提交说明；向量 node 39、python 46（protocol_schemas + contract）全绿。
  - **仍登记的残差（如实，不在本批）**：① `deploy`/`update-package` 载荷未 schema 化——executor-node **独有**，python 补齐对应端点前不进共享契约；② python `/execute` 的协议闸门仍是 lax `model_validate(req.model_dump())`（留待与反序列化模型一起评估）；③ logs 查询参数两端行为差异（node clamp vs python FastAPI Query(ge/le) 直接 422）属 query 参数、不在本次响应 schema 范围；④ 其余仍是 ADR-013 产品拍板、真机 24h soak/多机拓扑、上游 minio（BUG-04）等非纯代码项。
- **上一轮（2026-09-15 → A3-C 残差收口：ConfigReload/HealthReady 接进两侧运行时，主控，commit c941ac9）**：A3-C 当时只把最核心的 `ExecuteRequest` 接进运行时，`ConfigReloadRequest/ConfigReloadResponse/HealthReadyResponse` 三个生成物仍「只被测试消费」（README/交接均如实登记为残差）。本轮把它们接进 node/python 两侧 `/config/reload`、`/health/ready` 的真实运行路径。
  - **接线时抓到一个真实三方漂移**：node 的 `/config/reload` 响应用 camelCase（`updatedFields`/`ignoredFields`），而 `protocol.json` 与 python 都是 snake_case（`updated_fields`/`ignored_fields`）——node 是三方里唯一的漂移点；前端不读这两个字段、全仓无其他代码消费方，已对齐为 snake_case（这正是「把生成物接进运行时」才会暴露的问题，纯向量测试发现不了）。
  - **node（executor-node）**：`routes/config.ts` 在数值下界手检**之后**、任何 `config` 写入**之前**加 `ConfigReloadRequestSchema.safeParse` 闸门（手检保留更具体的 400 文案，闸门兜手检抓不到的类型/形状错误，如数值传字符串、`adminApiUrls` 传非数组）；两处出参经新 `buildReloadResponse()` 过 `ConfigReloadResponseSchema` 后才发送。`routes/health.ts` ready/not_ready 三个分支统一经新 `sendReady()` 过 `HealthReadyResponseSchema`。
  - **python（executor-python）**：`routers/config.py` 同序（手检 → 协议闸门 → 写入），两处返回经 `_conform_response()` 过生成物；`routers/health.py` 的 `_readiness()` 三分支统一经 `_ready_json()` 过 `ProtocolHealthReadyResponse`。**关键细节**：协议请求闸门用 `model_validate(raw, strict=True)`——pydantic 默认 lax 会把字符串 `"4"` 强转成 int（zod/JSON Schema 的 `type:integer` 都不强转），非 strict 会让两侧对同一载荷一个 400、一个洗白，已用 strict 对齐（有向量与端点用例钉住）。
  - **顺带修一个本机基线假红**：`admin-api` 的 `audit-append-only.spec.ts` 静态扫描用 shell `grep`，Windows 本机无 grep 必红（CI 在 Linux 正常）。改为与 `write-guard-coverage.spec.ts` 同款的 Node 递归遍历，语义不变、跨平台。
  - **反证有牙**：两侧 config/health 用例都用**生成的** schema 现校验真实出参（`safeParse`/`model_validate`），并各加「畸形类型 → 400 且不写入」用例；把出参改回 camelCase / 退回旧状态值 / 去掉 strict，对应用例立即红。
  - **产物同步（ADR-005）**：executor-node 源码改动 → ncc 0.44 重打内嵌 bundle（2275kB→2279kB），两次重打哈希字节一致（确定性验证通过），回填 `apps/executor-desktop/executor-node-bundle.sha256`（新期望哈希 `5d009e01…`），并 grep 确认新闸门代码确已进 bundle。`protocol.json` 未改 → 两侧生成物零漂移（`check:protocol-sync` 绿）。
  - **回归（本机 Windows，串行实跑）**：typecheck:all 7 工程全绿；enum-drift / check-migrations / protocol-sync / consumer-routes 守卫全绿；eslint/ruff 等价检查（py_compile）净；executor-node **406/406**、executor-python **382/382**、admin-api **2702/2702**（基线那例 grep 假红已消除）、desktop main+renderer selftest 全过。
  - **仍登记的残差（如实，不在本批）**：① `kill/deploy/update-package/logs` 载荷未 schema 化（属单端实现细节，按「修改纪律」不拉进共享契约）；② python `/execute` 的协议闸门仍是 lax `model_validate(req.model_dump())`（输入已被 FastAPI 模型先解析，收紧 blast radius 大于本批收益，留待与 ExecuteRequest 反序列化模型一起评估）；③ 其余仍是 ADR-013 产品拍板、真机 24h soak/多机拓扑、上游 minio（BUG-04）等非纯代码项。
- **上一轮（2026-09-15 → A7：registry 上传面收敛，主控）**：§七六个优先方向（A1~A6）与 A2-B / A3-C 全部收口后，回到评审存档方向里**唯一的真实安全面**——§七「registry 面收敛（pypi 加固 + token 鉴权）」，A2 审计曾把它如实登记为「任意已登录用户可传 PyPI 包」。
  - **问题不是理论风险**：`POST /registry/pypi/upload` 此前声明 `scope: "authenticated"`，而任务的 `requirements` 正是从这个私有 PyPI `uv pip install`。任何账号都能抢注/覆盖一个内部包名，让下游**所有**引用它的任务装到攻击者的代码——任务依赖投毒。前端菜单对所有登录用户可见，无任何角色门禁。
  - **形态（三层）**：① 角色门控 `@Roles(UserRole.ADMIN)`（按 A2 规则，有 `@Roles` 就不再需要 `@WriteGuard`，故原 `authenticated` 声明移除）；② `name` / `version` 加 PEP 508 / PEP 440 **字符级白名单**——这两个值会原样转发给上游 pypiserver（它用其拼存储路径），把输入卫生甩给下游是老毛病；③ 上传**成功与失败都落审计**（`registry.pypi.upload`，记 userId/username/resourceId=`<name>==<version>`/filename/size/ip），投毒面必须可追溯。前端同步按角色禁用上传入口（普通用户不看点必 403 的按钮）。
  - **一个刻意的取舍**：审计写入失败**不**阻断上传（DB 抖动不该让运维传不了包），但必须 `logger.error` 留痕并明确写出「投毒面失去可追溯性」——静默吞掉等于审计形同虚设，这条取舍由独立用例钉住。
  - **一个刻意的不做**：没有引入专用 upload token（评审原文提到「token 鉴权」）。那需要先确认是否存在 CI/流水线上传的真实场景，谁签发、谁轮换是运维决策；凭空加一种凭据类型只会扩大攻击面。已登记为残差。
  - **反证有牙（两处实测）**：① 去掉 `@Roles(ADMIN)` → 元数据断言 + 「普通 user 403」2 例立即转红；② 去掉包名正则 → 「包名非法 400」1 例转红。
  - **验收**：admin-api registry **17/17**（既有 9 + 新增 8）+ A2 守卫扫描 **65/65** + tsc 0 + eslint 0；admin-web registry 页面 **12/12**（既有 10 + 新增 2）+ `tsc -b` 0 + eslint 0。
  - **残差（如实）**：① 未引入专用 upload token（见上）；② 仅约束了**上传**面，`GET /registry/{pypi,npm}/packages` 仍是任意登录用户可读（包名列表属低敏信息，暂不收紧）；③ 上游 pypiserver 自身未做鉴权加固（admin-api 用 Basic 转发，`REGISTRY_PASS` 未配时为空密码）——属部署基线，非本轮范围。
- **本轮（2026-09-14 → ARCH-A3-C：把生成的 schema 接进两侧 `/execute` 运行时，主控）**：A3 完整形态（commit `c835815`）落地后登记的残差就是一句「生成物尚未接进运行时校验」——**契约只被测试消费，等于没生效**：删掉手检、端点照收不误，协议也不会红。本轮把它做掉，并顺带收口一个已登记的跨端漂移 + 修一个真 bug。
  - **形态**：`protocol.json` 的 `schemas` 补 `TaskConfig.timeout` 的 `0..86400` 边界（此前**协议没写、实现却在做**——node 一直按 0 或 1..86400 拒绝、python 静默 clamp，这正是「把 schema 接进运行时」才暴露出来的那类漂移）；两侧 `/execute` 各加一道闸门（node `ExecuteRequestSchema.safeParse` 放在既有手检**之后**，python `ProtocolExecuteRequest.model_validate` 放在**登记表之前**）。
  - **两个位置选择都是有理由的，改了就会出事**：① node 闸门放在手检**之后**，是因为手检的 400 文案更具体且已被既有用例钉住（如 `/Invalid task timeout/`），闸门兜的是手检没覆盖的部分；② python 闸门放在 `register_live_execution` **之前**，是因为——
  - **修掉的真 bug（python）**：`accept_execution` 原先把 E-19 的 `requirements` 手检放在 `register_live_execution` **之后**，畸形载荷被拒时 live 条目不会注销。后果不是「多一条 400」：live 表是重复领取守卫与心跳活性上报的数据源，残留条目让该 executionId 在本执行器上**永久**被当成「已在运行」——admin 的每一次重试都撞 400，心跳还会上报一个并不存在的执行。闸门与手检现已统一前移到登记之前。
  - **修掉的 500→400（node）**：`executionId` 传非字符串时，`isSafeExecutionIdSegment` 的 `RegExp.test` 会做隐式类型转换放行，随后 `path.join(workDir, executionId)` 抛 TypeError 被外层 catch 兜成 **500**。畸形输入该是 400，已加 `typeof` 守卫（这条是被新增的「向量驱动端点」用例逼出来的）。
  - **反证有牙（实测）**：把 python 闸门置空（`model_validate` 换成 `pass`）→ `tests/test_execute_protocol_gate.py` **8 例立即转红**（含泄漏回归 `test_rejected_execution_leaves_no_live_entry`）。node 侧新增「`schemaVectors.ExecuteRequest.invalid` 每一条都必须让 `POST /execute` 返回 400」——少了这层，schema 就只是被测试引用的产物。
  - **验收**：executor-node **26 套件 399/399**（A3 后 386 → +3 新向量 → +10 向量驱动端点用例）+ tsc 0 + eslint 0；executor-python **370 passed**（基线 356，+3 向量 +12 闸门用例；1 例 `test_git_checkout_to_failed_clone_cleans_partial_cache` 为本机沙箱 `safe-delete-bulk-guard` 拦截 `rmtree` 的**环境假红**——该用例只调 `git_checkout_to`，完全不经过本轮改动的代码）。
  - **代价（如实）**：内嵌执行器的 ncc bundle 因此内联 zod，**2111kB → 2275kB**，是它首次引入第三方运行时依赖（ADR-005 同 commit 回填哈希 `5f54799d…`）。
  - **CI 抓到的真回归（本机 26 个 spec 全绿却漏了它）**：`selftests`（pull 全链路**真派发**）红在 `task.requirements: Expected array, received null`。原因不是实现错了，是**协议写错了**：admin 的 `Task.requirements` 是 `jsonb NULL` 列，任务没配依赖时派发载荷里就是字面 `null`，而我把协议写成 `"type": "array"`（不含 null）。**这是「契约必须描述真实载荷，不能描述想象中的载荷」的实例**——本机所有 spec 都只喂了理想载荷，只有真派发路径喂了真实的 null。修法：协议改 `["array","null"]`，并把 `{ "requirements": null }` 补成一条 **valid 向量**（两侧 schema spec 都会断言它）+ python 侧一条「null requirements 必须被接受」的运行时用例。**教训：给契约加字段约束前，先去查 admin 实体该列的 nullability——nullable 列必然会在派发载荷里出现字面 null。**（ADR-005 回填哈希 `a41b3e7d…`。）
  - **残差（如实）**：① `ConfigReloadRequest` / `ConfigReloadResponse` / `HealthReadyResponse` 三个生成物仍只被测试消费（`/config/reload`、`/health/ready` 各有手检与类型，改动面大于收益）；② `kill` / `deploy` / `update-package` / `logs` 端点载荷未 schema 化；③ `autocodeflow_sdk` 的 `TaskConfig` 三字段归一化逻辑生成物不表达；④ python 侧**没有**替换 FastAPI 的 `ExecuteRequest`（`task` 保持 dict，全代码库按字典访问，替换要动 2000+ 行）——两个模型分工不同：那个是反序列化，这个是协议校验。
  - **CI 收口**：run `34910840767` **全绿**（50 job / 46 success / 4 skipped / 0 failure）。途中三次红灯均为**真实问题**而非抖动：① `selftests`——协议把 `TaskConfig.requirements` 写成不含 null 的纯 array，而 admin 的该列是 nullable jsonb，pull 全链路真派发喂了字面 `null`；② `admin-api-test`——协议 timeout 向量的 `rejectedBy` 由 `admin-api` 改为三方共同拦截后，admin-api 侧契约用例仍钉着旧值；③ 两处修完即绿。**本机 26 个 spec 全绿却漏掉 ①，原因是所有向量喂的都是理想载荷**——已把 `{ "requirements": null }` 补成 valid 向量，并给契约加了「改字段约束前先查 admin 实体该列 nullability」的纪律。
  - **⚠️ 本轮事故（本机，非 CI）**：`git stash push <file>` 被 SIGTERM 中断后，仓库 `.git/refs/` 目录**整体消失**、`objects/pack/*.pack` 丢失（仅剩 `.idx`），git 判定「not a git repository」。**已恢复**：`.git` 备份在 `E:\softwareData\coding\AutoCodeFlow.git.bak.20260915`（损坏原件 `...git.broken-20260915`）；从 GitHub 重新 fetch 对象（所有提交均已推送，无未推送提交丢失）并用 `update-ref` 重建 `develop` / `main` / `origin/*`，`git status` 复核只剩本轮改动的 6 个文件。**教训：本机不要对 `.git` 用 `git stash`（尤其是带 pathspec 的），改用文件副本做隔离验证。**
- **本轮（2026-09-14 → A3 完整形态的两个 CI 红灯修复，主控）**：commit `c835815` 推上去后 run `34902946918` 有三个红。
  - **`docker-multiarch-build (executor-node)` ×2**：新建的 `src/protocol-schemas.spec.ts` 用了 `import protocol from "../../../packages/executor-protocol/protocol.json"`，而 executor-node 的 Docker 构建上下文只有 `apps/executor-node`（`COPY tsconfig.json` + `COPY src ./src`），`resolveJsonModule` 把仓库根的 `packages/` 拉进 tsc 编译图 → TS2307。改成与既有 `__tests__/executor-protocol-contract.spec.ts` 一致的「运行期 `readFileSync` + 向上找仓库根」，并在文件头写明**为什么不能写 `import`**（否则下一个人会改回去）。
  - **`desktop-bundle-drift`**：`routes/execute.ts` 的 `isSafeExecutionIdSegment` 由模块私有改为 `export`（供 spec 与协议 pattern 做逐字符比对）——**仅加导出也改变 ncc 的运行时导出图**。按 ADR-005 重打并回填；本地 ncc 0.44 重打产物哈希 `3dca07ba…` 与 CI 实跑的 actual **逐字符一致**，可确认本地与 CI 产物字节确定性对齐、漂移源就是这一个 export（不是环境差异）。
  - **保留 `export` 而不是回退**：若把正则复制到 spec 里做比对，该断言就退化成「两份正则互相比较」的永真断言——正是 A3 要消灭的漂移。
  - **验收**：**CI run `34903870972` 全绿**（50 job / 46 success / 4 skipped / 0 failure）。
- **本轮（2026-09-14 用户授权「剩下的全部推进」→ ARCH-A3 完整形态：schema 化 + zod/pydantic 双生成，主控）**：§七六个优先方向全收口后，回到 A3 自己登记的残差——A3 最小切片只钉了 `readiness` / `timeout` / `failureReason` 三段向量，**载荷形状**仍未 schema 化。
  - **侦察先于动手（避免造重复轮子）**：以为要从零设计载荷 schema，实际 `packages/autoflow-sdk/autoflow_sdk/models.py` 里**已有一份 pydantic 的 `ExecuteRequest`/`TaskConfig`**（python 执行器优先 import 它，缺席时退回 `routers/execute.py` 的本地 fallback）。真正的漂移不是「没有 schema」，而是**三份 schema 各自演进**：node 手写 interface / python SDK model（+ 本地 fallback）/ admin 拼接字面量。所以正确落点是**收进已有的 `protocol.json`**，而不是再造第四份。
  - **形态**：`protocol.json` 新增 `schemas`（JSON Schema 2020-12 **受控子集**：type 含数组 nullable / properties / required / additionalProperties / items / enum / minimum / maximum / pattern / default / `$ref`）+ `schemaVectors`（每 schema 的 valid/invalid 样本）。零依赖 node 生成器 `scripts/generate-executor-protocol.mjs` 产出 `executor-node/src/generated/protocol.schemas.ts`（zod）与 `executor-python/generated/protocol_schemas.py`（pydantic）。
  - **两条刻意的严格性（否则契约会悄悄失效）**：① 生成器遇到**受控子集外的关键字直接报错退出**——静默跳过等于契约失效，而且是永远不会变红的那种失效（本项目第四次踩同类坑）；② **内联嵌套对象被拒绝**，必须先抽成顶层 schema 再 `$ref`（zod 侧会生成匿名类型，两侧形状无法对齐）。
  - **反证有牙**：两侧 spec 不只断言「被拒绝」，还断言**拒绝发生在 `expectErrorPath` 指定的字段**——只断言被拒绝会退化成永真。另有两条把生成物与运行时钉在一起（防 schema 沦为只被测试消费的摆设）：node 侧 `executionId` 的 pattern 与运行时守卫 `isSafeExecutionIdSegment` **逐字符比对**；python 侧协议的 valid 样本必须能被 `routers/execute.py` **真正在用**的请求模型接受。
  - **验收**：executor-node **26 套件 386/386**（基线 360，+26）+ tsc 0 + eslint 0；executor-python **356/356**（+26）。新增 CI job `executor-protocol-drift`。
  - **踩坑**：① zod 的 `.regex()` **只收 RegExp 不收字符串**（要生成 `new RegExp("...")`）；② pydantic 的可变默认值必须 `default_factory=list`，直接 `default=[]` 会报错；③ JSON Schema 里「无 properties 的 object」= 自由字典，必须用 `null` 与「空对象类型」区分开，否则生成器会把 `params` 误判成内联嵌套对象。
  - **残差（如实）**：① **生成物尚未接进两侧 `/execute` 的运行时校验**——node 侧现有 `if (!executionId || !body.task)` + `isSafeExecutionIdSegment` 与 schema 语义等价（故未替换）；python 侧改成生成物需先处理 `req.task.get(...)` 的多处字典式访问与 `merge_task_with_manifest` 的入参类型，且会与「timeout 越界 python 侧 clamp」的既有漂移纠缠——属行为变更，留作下一步；② `kill` / `deploy` / `update-package` / `logs` 等端点载荷未 schema 化（先只收协议面最核心三个，避免把只属于一端的实现细节拉进共享契约）；③ `autocodeflow_sdk` 的 `TaskConfig` 有 `timeoutSeconds/timeout/timeout_seconds` 三字段归一化逻辑，生成物不表达该行为——两者关系待收口。
  - **下轮建议**：① 把生成物接进两侧 `/execute` 运行时校验（node 侧替换等价手写检查；python 侧先解决 `req.task` 的字典式访问）；② ADR-013 待拍板项（project-role 是否收紧为 ownership）；③ 生产真机项不变（QA-05 24h 长稳、多主机拓扑、desktop-e2e-smoke windows runner）。
- **本轮（2026-09-14 用户授权「剩下的全部推进」→ ARCH-A2-B 写面授权缺省拒绝，主控）**：§七六个优先方向全收口后，回到 A2 自己的残差——**声明不是强制**。
  - **问题（A2 落地时就已如实登记）**：`@WriteGuard("task", { scope: "ownership" })` 是**纯元数据**。漏声明会被穷举扫描抓住，但**声明了 ownership 却没人在 service 里调 `assertCanWrite`**，扫描照样全绿——「缺省拒绝」并没有实现，只是把文档写进了装饰器。
  - **形态（两层，缺一不可）**：① **落证**：真正的校验函数（`task.service.assertCanWrite` / `assertCanOperate`、`application.service.assertCanWrite`、`event-subscription.service.assertCanManage`）在执行时向 `AsyncLocalStorage` 作用域落一条 `resource:kind` 证据（**先落证再判定**——ADMIN 放行同样是授权决策；作用域外为 no-op，定时任务不受影响）；② **核对**：全局 `WriteGuardEnforcementInterceptor` 读取声明，在端点**成功返回前**核对证据，缺证直接 500。
  - **两个刻意的语义选择**：① **只在成功路径核对**——属主校验失败本身抛 403，不能被改写成 500（否则真实拒绝原因被吞、前端拿不到「你不是属主」；参数校验 400 同理，此时没走到属主校验是正常时序）；② **用 500 而不是 403**——这是装配/实现缺陷而非客户端错误，必须在监控里被看见，不能被当成普通 403 吞掉。
  - **一个易踩的实现坑**：必须在 `runOwnershipScope()` 回调**内部订阅**上游 Observable（用 `new Observable(s => run(() => next.handle().subscribe(s)))`）。只在回调里**创建** Observable 的话，handler 的真实执行落在 ALS 作用域之外，证据全丢、全端点假红。已由「异步 handler 中落证同样有效」一例钉住。
  - **强制开出来的真实漂移（本轮最大价值）**：22 处 `ownership` 声明逐端点核对后——
    - `trigger` / `pause` / `resume`（`TaskController` 三处 + `batch/*` 三处 + `TaskBatchController` 三处，共 9）只调 `assertCanOperate`（**只显式拒绝项目 viewer，不校验属主**）。这不是 ownership，是「这里**没有**属主校验」的既成事实（ADR-013：「任何登录用户可 trigger」的宽松语义待产品拍板后才收紧）→ 新增 `project-role` scope 如实登记，并强制给 reason 说明为什么不收紧（避免拿 ownership 当同义词糊弄）。
    - `killExecution` / `analyzeExecution` / `suggestSchedule` **一处属主校验都没有**：任意登录用户可终止他人任务的执行、可对他人执行跑 AI 分析、可拉他人任务历史做排期建议。这三个端点的声明本来就是 `ownership`，故**按声明补上校验**（`assertCanWriteExecution`：execution → 所属 task 行 → 属主判定；`taskId` 缺失时 403 而非放行）。
  - **验收**：admin-api **170 套件 2694/2694**（+32：拦截器行为 13 + 落证反证 8 + 越权专项 8 + 扫描对账 3）+ tsc 0 + eslint 0；**CI run `34899182760` 全绿**（49 job / 0 failure，`api-types-drift` 绿说明未触及契约面；`admin-api-test` 跑 e2e，真实 AppModule 下拦截器确已生效）。
  - **反证有牙（三层）**：① 删掉 `task.service.assertCanWrite` 里那一行 `recordOwnershipAssertion` → 落证 spec 3 例 + 声明/落证对账 1 例**立即转红**（实测）；② 合成控制器上「未落证→500」「错 resource→500」「只落 operate 证不能冒充 ownership→500」逐条钉住；③ 声明/落证对账对扫描器自身带规模下界（≥4 个落证方），防「扫不到东西」的永真断言。
  - **残差（如实）**：① **只覆盖 HTTP 请求面**——定时任务/进程启动逻辑不在 ALS 作用域内，落证是 no-op、拦截器也不参与（这类路径的授权需另立机制）；② `project-role` 九个端点的**属主收紧仍未做**（ADR-013 待产品拍板，本轮只做到「如实声明 + 运行时强制」）；③ `authenticated` / `token` / `public` 三种 scope 仍只有声明层约束，没有运行时强制（前者的「已登录」由全局 `JwtAuthGuard` 保证，后两者的凭据校验在各端点内，形态差异大暂不统一）；④ `RegistryController.uploadPypiPackage`（A2 轮已登记）仍为「任意已登录用户可传 PyPI 包」。
  - **下轮建议**：① A3 完整形态（ExecuteRequest / ConfigReload / 运维端点的 zod + pydantic 双生成 schema，仓库目前无 zod 依赖，需新引入）；② 把 `authenticated` scope 也纳入运行时强制（需先统一 API-Key 主体的 `req.user` 形态）；③ 生产真机项不变（QA-05 24h 长稳、多主机拓扑、desktop-e2e-smoke windows runner）。
- **本轮（2026-09-14 用户授权「剩下的全部推进」→ ARCH-A5 SSE 短效票据，主控）**：A4 收口并推全绿后，按评审 §七做 A5 的**后半程**（前半 `createSseClient` 单一实现已由 F-08 落地）。
  - **问题（评审点名的 P2 已知风险）**：EventSource 不支持自定义请求头，三条 SSE 长连接（`/metrics/stream`、`/executions/stream`、`/logs/stream`）此前直接把 **access token（15min TTL）** 拼进 `?access_token=`。查询串会被 nginx access log、浏览器历史、Referer 记录——等于把一枚 15 分钟有效的**全权**令牌写进日志。
  - **形态**：新增 `POST /auth/sse-ticket`（常规 bearer 头）签发 **30s TTL、`type=sse_ticket`** 的专用票据。与 access token 共用 `ver` 会话版本快照 ⇒ 登出/改密后已签发票据即时失效；不落库、不参与刷新，是 access token 的**派生物**而非替代品。**两道门**：`extractJwtFromRequest` 只在三条 `/stream` 路径后缀上读取 `?ticket=`（路径门）；`validate` 的类型门只放行 `access` / `sse_ticket`（类型门）——refresh token 不能借道，票据也开不了任何 REST 端点。
  - **关键取舍：旧 `?access_token=` 通道整体撤销**，而不是并行新增一条 ticket 通道。留着它等于泄漏面一点没缩小（谁都能继续用老方式）。撤销是**破坏性变更**，但三个消费方全在 admin-web 内、本轮一并迁移，无外部使用方。
  - **admin-web 侧的三条新失败模式（本改动引入，必须钉住）**：建流从同步变异步后——① **重连必须换新票**（票据仅 30s，复用旧值必然 401）；② **换票失败**（401/网络）与断线同处理：退避重试，而不是建一个必然失败的连接；③ **换票期间组件卸载**要丢弃票据、不建流（否则泄漏一条幽灵长连接）。已由新增 `sse-client-ticket.test.ts` 5 例钉住。
  - **验收**：admin-api **167 套件 2643/2643**（+7）+ tsc 0 + eslint 0；admin-web **733 用例**（新增 5 例专项）+ `tsc -b` 0 + eslint 0。**反证有牙**：把 `access_token` 加回查询串白名单 → 「旧通道已撤销」两例立即红；把 TTL 抬回分钟级 → 「有效期必须 < 60s」语义守卫红。
  - **踩坑**：① admin-web 三个既有 SSE 测试原本**同步**断言 `FakeEventSource.instances.length`，改异步后全绿变红——需在各 `advanceTimersByTime` 之后补 `await act(async () => {})` 冲刷微任务；② 后台跑全量 vitest 时**不要同时改被测文件**（本轮因此误报 2 例红，事后单独复跑全绿）。
  - **残差（如实）**：① **未做「单次使用」**（评审原稿提到）——需要在建流路径引入 Redis 共享状态，等于把 SSE 可用性与 Redis 绑定；而票据已是 30s + 路径受限，日志泄漏（事后读取）本就拿不到有效凭据。取舍与理由写进了 `api/sse.ts` 与 `auth.service.ts` 注释；② 长期路线（`fetch()` + `ReadableStream` 自实现 SSE 客户端、彻底消除「凭据入 URL」）未做——F-08 已把三套实现合并为 `createSseClient`，届时只需换建连方式；③ openapi/api-types 产物按「CI drift 日志回填」流程同步（本机无 PG/Redis）。
  - **下轮建议**：① A6 回调可靠性分层（`GET /executors/:address/terminal-states` 对账端点 + 死信对账，同样需走 CI 回填产物）；② A3 完整形态（schema 化）；③ A2-B（`assertCanWrite` 提为守卫内强制）。生产真机项不变。
- **本轮（2026-09-14 用户授权「剩下的全部推进」→ ARCH-A6 回调可靠性分层，主控）**：评审 §七六个优先方向的**最后一项**。
  - **先核查再动手（与 A4 同款教训）**：评审给的三个子项里，「重试预算改时长型（24h TTL）+ 毒丸轮数上限」**已由 E-05 落地**（node `CALLBACK_FILE_MAX_RETRIES = 150` + base 5s / cap 600s 指数退避 ≈ 24.0h；python 侧 base 1s ≈ 23.6h），不重复造轮子。真正缺的是**对账**。
  - **问题**：死信目录此前是**单向终点**——文件进去就再也出不来，且**磁盘上不记录它为什么进来**。于是两类死信长得一模一样，处置却完全相反：
    - ① **重发预算耗尽**（约 24h）：典型成因是 admin 长时间不可达（滚动升级 / 网络分区）。admin 恢复后**很可能仍值得重发**——若 admin 还没把该执行终态化（stale sweep 要等执行器心跳超时才跑），回调是它唯一能得知结果、并释放执行器槽位的通道。
    - ② **毒丸**（> 64MB / 坏 JSON）：重发永远失败，只等人来看。
  - **形态（三端共载）**：
    - admin-api 新增**只读**对账端点 `GET /executors/:address/terminal-states?since=&limit=`（`@Public()` + `@WriteGuard(scope:'token')` + `validateTokenByAddress`，与 heartbeat/pull 同款机器面）。返回已终态执行清单，按终态时间**升序**（便于按水印增量消费）；水印列是 `COALESCE(endTime, createdAt)`（endTime 在部分终态路径下可为 NULL）；`since` 缺省 24h、最老钳到 30 天；`limit` 默认 500 上限 2000；额外回 `hasMore` 与 `serverTime`（供执行器校正时钟偏差后再算 since）。
    - **严格只读**：不改执行行、不释放槽位、不写审计——多一条写状态的路就多一处状态机分叉，A1 收口白做。对账只是让执行器**不再做无用功**。
    - 执行器落盘死信时写 `.deadletter.json` **侧车**（reason / poison / deadLetteredAt / requeues），对账据此分三层：**终态→删**；**未终态 + 非毒丸→重新入队**（轮数归零重走 24h 预算、救回次数 +1，上限 3）；**未终态但毒丸或救回次数用尽→保留待人工**。node（`callback.ts` + 新 `dead-letter-sidecar.ts`）与 python（`routers/execute.py`）同语义、**同磁盘布局**。
  - **三条设计约束（都写进了代码注释，改前请读）**：① **零死信则零请求**——健康执行器不产生任何额外流量，对账不是新的心跳；② **取不到就什么都不做**——admin 不可达 / 响应形状不对时原样返回，**绝不**把「没拿到终态清单」退化成「都没终态」（那会把毒丸一股脑推回重发队列，白烧一轮 24h 预算）；③ **救回次数有上限**——执行行若已被删除，永远查不到终态，没上限会在「死信→重发→再死信」之间无限往返。
  - **验收**：admin-api 新增 19 例（终态集合与 `execution-terminal.ts` 同源、hasMore 截断、limit 钳位、空令牌 fail-closed、since 非法/过老回退）；executor-node **360/360**（新增 17 例对账专项 + file-logger 2 例侧车口径）；executor-python **330**（新增 18 例）+ 修正 3 处既有用例的 `glob('callback-*.json')`（侧车会被同一个 glob 命中）。tsc 0 / eslint 0。**CI**：run `34893061056` 全绿（49 job / 0 failure）；产物按「CI drift 日志回填」同步（`0fab547` 代码 + `89bec10` 产物），回填后 openapi.json **235047 字节 / 150 paths** 与 CI 日志逐字一致。
  - **踩坑**：① **侧车会让 `getDeadLetterCount` 翻倍**——上报的是「积压了多少条没送出去的回调」，侧车不是回调；node `getDeadLetterCount` 与 python `_refresh_dead_letter_count` 都要排除它，`file-logger` 的 `removeOlderThan` 还得加 `exclude` 选项，否则 `MAX_DEAD_LETTER_FILES` 的保留名额被侧车吃掉一半（实测 52 份死信只留 25 份）。② `reconcileDeadLetters()` **不能用 `getDeadLetterDir()`**（会 mkdir）——只读动作会在零死信的健康执行器上凭空造出一个空目录，触发既有断言。③ **`npm run build:executor`（Git Bash）会把 ncc 产物写到 `E://e//softwareData//...` 幻影目录**：脚本用 `pwd` 得到 `/e/softwareData/...`，node 把它当相对路径解析。正确姿势是 `cd apps/executor-node && ../executor-desktop/node_modules/.bin/ncc build src/main.ts -o ../executor-desktop/resources/executor-node --source-map --no-cache`（**相对路径，与 CI 同款**），再手动回填 `apps/executor-desktop/executor-node-bundle.sha256`。
  - **残差（如实）**：① 超过 8MB 的死信**不解析**（为一个 executionId 去 parse 几十 MB 不划算），超大载荷死信只能人工清理；② `hasMore=true` 时只处置已拿到的那部分，其余等下一轮（收敛依赖「删掉的文件不再进下一轮窗口」）；③ openapi / api-types 产物仍走 CI drift 回填（本机无 PG/Redis）。
  - **下轮建议**：① A3 完整形态（ExecuteRequest / ConfigReload / 运维端点的 zod + pydantic 双生成 schema）；② A2-B（`assertCanWrite` 提为守卫内强制，真正实现「缺省拒绝」）。生产真机项不变（QA-05 24h 长稳、多主机拓扑、desktop-e2e-smoke windows runner）。
- **本轮（2026-09-14 用户授权「剩下的全部推进」→ ARCH-A4 契约单一事实源收口，主控）**：A1/A3 已收口并推全绿，接着做评审 §七 A4。**先核查评审给的 6 个子项，发现 4 项此前已由 PK-02/PK-03/PK-15 落地**（nest-cli 已启用 `@nestjs/swagger/plugin`、Update* DTO 已换 `PartialType(CreateXxxDto)`、Executor 端点已 DTO 化、`openapi-empty-schema-whitelist.json` + `api-types-drift` job 已在 CI 拦空 schema）——**不重复造轮子**，只做剩余 2 项。
  - **① mcp/CLI 路由面快照守卫**（新 `scripts/check-consumer-routes.mjs` + CI `consumer-routes` job + `npm run test:consumer-routes`）：admin-api 有 148 条 openapi 路径，而 mcp-server 与 acf-cli 各自**硬编码**了 73 条路由字符串，**两者零编译期耦合**（不用生成的 api-types、也不 import admin-api）。后果是 admin-api 改一次路由在 admin-web 侧会红（`api-types-drift` 闸），在 mcp/CLI 侧却**完全静默**——只有用户真调用那个 MCP 工具 / CLI 子命令时才 404，且 404 会被信封拆包层吞成空错误体。
    - **两个设计要点**：① 路径模板归一——`${taskId}` 与 openapi 的 `{id}` 都替换成 `{}`，**参数名不同不算漂移**（否则会满屏误报）；② **扫描器自身带规模下界**（关键）——正则一旦因源码风格变化匹配不到东西，「0 条路由 → 0 条缺失」是**永真断言**，守卫会静默失效。故每个来源设下界（mcp ≥20 / cli ≥25），低于下界直接判失败：**宁可红也不能假装绿**。当前 mcp 39 条 + cli 34 条全部命中。
    - **反证有牙**：把 acf-cli 的 `/tasks/${id}/pause` 改成 `pause2` → 守卫红并精确点名 `packages\acf-cli\src\commands\tasks.ts:449`。
  - **② contract-fixtures 分发 `channelList`**：通知渠道 id 此前有**三份**手写副本、零耦合——admin-api 的 `AlertChannel` 枚举（派生 openapi union）、六个 channel 实现类的 `name = "..."`（**真正决定「告警能发到哪」的是这份**）、admin-web `AlarmConfig` 的选项列表。**落本项时实测已经漂了**：`feishu` 在枚举里、在实现类里、在通知设置页里都在，**唯独任务表单的告警渠道选择器里没有**——后端能发的渠道前端选不中。这正好是 A4 要防的那类漂移的第一次实证。
    - 修法：`contract.json` 增 `channelList` 作单一事实源；admin-api 新 spec 断言「枚举值集合 == 六个实现类 name 集合 == 契约」（两条互补：一条防实现类多，一条把缺口点名到具体渠道）；admin-web 把选项提升为模块级导出 `ALARM_CHANNEL_OPTIONS(t)`（顺带不再每次渲染重建数组）、补 feishu 与中英文案，新测试断言选项集合 == 契约，且**每个选项的 i18n 键真实存在**（i18next 缺键时回退返回键名本身，故「label === key」即等于没翻译）。
    - **反证有牙**：把 AlarmConfig 的 feishu 选项删掉 → 前端契约用例立即红。
  - **验收**：admin-api **167 套件 2636/2636**（+4）+ tsc 0 + eslint 0；admin-web **84 文件 728/728**（+3）+ `tsc -b` 0 + eslint 0；守卫 selftest 7 组断言通过。
  - **残差（如实）**：① 评审说的 `callbackContract` 常量**没放进 contract-fixtures**——A3 已建 `packages/executor-protocol/protocol.json` 专门承载执行器↔admin 的回调契约，再放一份会**制造两个事实源**，故如实登记为「已由 A3 以更好的形态覆盖」而不是照抄评审措辞；② 守卫只覆盖**字面量**路由，`get(url, {...})` 这类拼装路径（exec.ts 流式日志下载）不在覆盖面；③ `NotificationSettingsPage` 的 `CHANNEL_LABELS` 键集未纳入机检（函数未导出、当前 6 项齐全）。
  - **下轮建议**：① A5 SSE 客户端统一（前半 `createSseClient` 已由 F-08 落地，剩余是短效 ticket 升级，文档标为中期路线）；② A6 回调可靠性分层；③ A3 完整形态（schema 化）；④ A2-B。生产真机项不变。
  - **⚠ 下轮开工前必读（A5/A6 的硬前置）**：A5（短效 ticket）与 A6（`GET /executors/:address/terminal-states` 对账端点）**都要新增 REST 端点**，而 `apps/admin-api/openapi.json` 是**机器生成产物**：
    - **本机生成不了**——`npm run swagger:export` 委托 `test/openapi-export.e2e-spec.ts`，**实测需要真实 PG + Redis**（重试 10 次后失败）。旧脚本 `apps/admin-api/scripts/export-openapi.ts` 里那套「离线装配技巧」（`manualInitialization` / OfflineQueue stub）只适用于**已停用**的 ts-node 路径，**不能照搬到 Jest 路径**（已实测踩过）。
    - **手改也不可靠**——openapi.json 的 `paths` 与 `components.schemas` **都不是字母序而是插入序**（= 控制器/装饰器求值序），新增端点的 key 落位无从推断。A3 那次手改能成，是因为改的是**原地修改**（枚举删一项、加一个 503 响应），不涉及插入序。
    - **可用办法**：故意带着过期的 openapi.json 推送 → CI 的 `api-types-drift` job 会执行 `git diff --exit-code -- openapi.json` 并把**完整 unified diff 打进 job 日志** → 从日志取回生成物精确回填本地，再跑 `npm run gen:api-types`（这个纯吃 JSON，本机可跑）重新生成 api-types.ts。代价是**多一个 CI 周期的红**，不要误判为回归。
    - 顺序建议：先落 admin-api + admin-web 代码与测试（本地全绿），再单开一个 commit 处理产物同步。
- **本轮（2026-09-14 用户授权「剩下的全部推进」→ ARCH-A3 执行器协议契约化最小切片，主控）**：A1 收口完成并推送（run `34868480667` = 48 job / 44 success + 4 skipped / 0 failure）。接着按优先级做 **A3**，只取评审建议的最小切片：**readiness + timeout + failureReason**。
  - **形态选择**：照既有 `packages/contract-fixtures`（QA-07 信封契约，4 个客户端包共载一份 `contract.json`）的**同构模式**，新建 `packages/executor-protocol/protocol.json` 作为单一事实源，四方（admin-api / executor-node / executor-python / autoflow-sdk）加载同一份文件断言。评审原稿说的「zod + pydantic 双生成 schema」是完整形态，成本大得多且会引入构建期依赖；先用「共享测试向量」把已达成一致的语义钉死，边际收益最高、风险最低。
  - **侦察出的三处真实不一致**（评审说的「注释里的 parity」在本地实证确实存在）：① **`admin-api /api/health/ready` 恒返 200**——不就绪只在 body 里写 `status:"not_ready"`。而 K8s readinessProbe 与主流 LB **只看 HTTP 状态码**，等于 DB 与 Redis 全挂也不会被摘流量，**就绪探针形同虚设**。这是本轮最有价值的发现。改为就绪 200 / 不就绪 503，并按契约补 `reason`（非空字符串）；② **readiness 判定维度各缺一块**——node 只看资源（admin 不可达照样报 ready）、python 只看 admin 连通性（CPU 打满照样报 ready）。两侧统一为「资源 + admin 连通性」，阈值同为 90%；③ **failureReason 语义越界**——admin 的 `@IsIn` 用的是**全集**，而 `stale_recovered` 是 admin 的 stale sweep 写入的溯源标记、语义上只有 admin 才该写；python 侧则**完全没有枚举约束**，只靠字符串字面量。收窄为「执行器可上报子集 = 全集 − admin 内部专用」，并同步 `packages/autoflow-sdk` 的 `VALID_FAILURE_REASONS`（其注释本就声明与 admin DTO 同步；否则 SDK 本地放行、admin 却 400，且**一个非法取值会拒掉整批回调**）。
  - **统一 `status` 值域 `unready` → `not_ready`**；python 的 503 载荷去掉 `HTTPException` 的 `detail` 包裹（与 node 的扁平载荷、契约「payload 外不得再包自定义键」冲突）。**契约如实记录 admin-api 有全局响应信封、执行器没有**——readiness payload 分别落在 `data` 下与顶层，用 `perComponent[*].bodyPath` 显式钉死，避免后续有人按执行器的扁平形态去解析 admin 的探针响应。
  - **timeout 越界策略不一致的处理（取舍）**：`executor-node` 拒绝（400）、`executor-python` 夹紧到边界。admin 侧 `@Min(0) @Max(86400)` 已前置拦截，正常派发路径执行器收不到越界值 → 属**纵深防御层漂移**而非活跃事故。**没有强行改 python**（clamp→reject 是行为变更），而是把契约向量标为 `rejectedBy:"admin-api"` ——**如实记录差异而非假装一致**；已在契约 README 与认领板登记为残差。
  - **验收**：admin-api **166 套件 2632/2632**（+9 = 契约 7 + readiness 2）+ `tsc --noEmit` 0 + eslint 0；executor-node **24 套件 341/341**（+8）+ tsc 0 + eslint 0；executor-python **312 通过**；autoflow-sdk 新 spec 3/3；admin-web `tsc -b` 0（生成类型已同步）。**反证有牙（4 处逐一验证，非口头声明）**：DTO 还原为全集 → 契约用例红；controller 还原为恒 200 → readiness 两例红；node `status` 还原 `unready` → 2 例红；python 还原旧值域与旧判定维度 → 3 例红。
  - **踩坑/新知**：① 生成物同步——本机无 PG/Redis 跑不了 `swagger:export`（需完整 AppModule 引导），按生成规则**手工同步**了 `openapi.json` 与 `api-types.ts` 两处（failureReason enum 去掉一项、/health/ready 增 503 响应），由 CI 的 `api-types-drift` 闸作最终校验；② 测试里向上找仓库根**不要硬编码 `../`×N**（层数随文件位置漂移，本轮第一次就写错成 7 层），改为按标记文件向上查找；③ `os.freemem` 与 `os.cpus` 一样**不可重定义**（`jest.spyOn` 抛 Cannot redefine property），要钉死内存水位只能整模块 mock。
  - **残差（如实）**：① timeout 越界的执行器侧策略两端不一致（见上）；② 评审 A3 完整形态（ExecuteRequest / ConfigReload / 运维端点的 schema 化）未做；③ A2-B 仍未做。
  - **CI 两处红灯与根治（`a4ce1c4`，run `34876211696` = 48 job / 44 success + 4 skipped / 0 failure）**：本地全绿的 A3 推上去红了两个非测试 job，两个都是真问题、且都值得记住。① **`desktop-bundle-drift` 是我自己的疏漏**——A3 改了 `executor-node/src`（callback/health），**没有按 ADR-005 重打 desktop ncc bundle**。`apps/executor-node/src` 与 `apps/executor-desktop/resources/executor-node` 是两份物理副本，靠 manifest `executor-node-bundle.sha256` 钩住；本轮按 CI 同款命令（`ncc build src/main.ts -o ../executor-desktop/resources/executor-node --source-map --no-cache`）重打并回填 `d8385732…`。**教训：改 executor-node 源码后的收尾清单里必须有「重打 bundle + 回填 manifest」这一步，否则本地再绿也白搭。** ② **`docs-site-build` 是判据没跟上语义**——`sync-check.mjs` 判据③ 硬编码了旧假设「admin 枚举 == py 白名单」，而 A3 的语义正是把它改成「py 白名单 == 枚举 − admin 内部专用」，判据不改必然红。改为以 `protocol.json` 为单一事实源做四条不变量机检；`sync-check.selftest.mjs` 基线补 `protocol.json` 并新增 3 例（白名单 == 全集−内部专用放行 / 白名单残留内部专用值拦截 / 契约 `all` 落后于枚举拦截）。**顺带修掉一处长期失真**：站点 `sdk-python.md` / `capability-matrix.md` 写「BUG-10 九类」，实为**全集 11 项、可上报 10 项**——该表述用中文数字，sync-check 的数字判据**匹配不到**，盲区存在已久；已改文案并在 `contract.md` 补可上报子集语义。
  - **下轮建议**：① A4 契约单一事实源收口；② A5 SSE 客户端统一；③ A6 回调可靠性分层；④ A3 完整形态（schema 化）；⑤ A2-B。生产真机项不变。
- **本轮（2026-09-14 用户授权「剩下的全部推进」→ ARCH-A1 执行状态机收口，主控）**：上一轮盘点结论是「唯一成规模的剩余工作是 §七 20 个架构方向（A1~A6 优先）」，A2 已 done。本轮自主选 **A1**（优先级仅次于 A2）。
  - **侦察出的三类真实不一致**（评审 §七 A1 的判断在本地得到实证）：① **常量漂移**——`OPEN_EXECUTION_STATUSES` 早就存在，但 `task.service` 两处（回调落库 / kill）各抄一份 `[PENDING, RUNNING]` 字面量，`s3-log-object-retention.service` 另抄一份终态数组，将来加状态必漏改（PK-01 同型）；② **批量恢复路径缺兜底**——驱动差异下「`affected>0` 但 `raw` 为空」时，6 处里只有 COVER_EARLY 一处写了快照兜底，`recoverStaleExecutions` 直接读 `result.raw` → **静默漏释放执行器槽位**；③ **丢失执行扫描没有 RETURNING**——释放用的是请求前快照 `exec.executorAddress`，而该地址在 dispatch HTTP 返回后才落库，秒级完成的执行其快照仍为 null，用它释放会 no-op 使 `runningTaskCount` **永久虚高**（`task.service` 回调路径的注释早已自证此坑，扫描路径一直在踩）。
  - **形态**：新 `apps/admin-api/src/modules/task/execution-terminal.ts`——`transitionToTerminal(repo, {ids, patch, from?, addressSnapshot?, manager?})` / `transitionOneToTerminal` 作为**唯一入口**，一次给全三件事：统一终态保护门、`RETURNING` winner 判定、raw 形状归一化（数组/单对象/空）+ 快照兜底；`OPEN_EXECUTION_STATUSES` / `TERMINAL_EXECUTION_STATUSES` / `isTerminalStatus` 成为单一事实源。**选用纯函数而非 Nest service**（评审原稿写 `ExecutionTerminalService`）：无状态、只依赖传入的 Repository/EntityManager；做成 service 会让 executor 模块为一个工具函数 import task 模块，凭空引入循环依赖面（ARCH-24 已因 DI 环挂死过一次）。
  - **一处自己引入又自己抓回的隐患（值得记住）**：最初写的兜底是「`affected>0` 且 raw 空 → 按**全部** ids 编造 rows」。这在单 id 路径没问题，但批量路径下 `affected < ids.length`（批次里有一部分已被并发终态化、且无从分辨是哪几条）时会把未跃迁的行也算成 winner → **超量释放槽位**（`runningTaskCount` 打成负数 → 反复超发压垮执行器），比原来「漏释放」更糟。已收敛为**只在 `affected === ids.length` 时兜底**（等式成立说明这批 id 全部通过门槛，命名无歧义），并补了钉死这条边界的用例。
  - **顺带清理**：`task.service` 回调路径与 kill 路径各自手写了一版 `result.raw` 解析（且与 scheduler/executor 两处口径不同），改为直接读统一入口返回的 `rows`；`task.processor` 三处硬编码（`isTerminal` 五元素数组 ×1、`writable: [PENDING, RUNNING]` ×2）改为 `isTerminalStatus` / `OPEN_EXECUTION_STATUSES`（该文件的写是「持久化 worker 自有字段」、status 可能非终态，故只做常量收口未改走入口）。
  - **验收**：admin-api **164 套件 2623/2623**（2610 基线只增 +13 = 入口契约 12 例 + 反证 1 例）+ `tsc --noEmit` 0 错 + eslint 0 错。**反证有牙**：临时把 executor.service 的释放改回旧实现（用 `exec.executorAddress` 快照）→ 新增用例「prefers the RETURNING executorAddress over a null pre-scan snapshot」立即转红（旧实现下释放根本不发生）。
  - **10 例旧 SQL 形状断言逐条核对后更新**（非放宽、非删除）：失败清单全是 4 个改造点的旧形状断言（如 `expect.stringContaining('"status" = :status')` → 实际 `'"id" IN (:...ids) AND "status" IN (:...gate)'`），逐个确认是形状变化而非行为回归后才改。另给 3 处 spec 的 QB mock 补 `returning`（旧调用点不取 RETURNING 故 mock 里没有）。
  - **踩坑**：用 Python 批量给 spec 补 `returning` 时以文本模式回写，把三个文件整体改成了 **CRLF**（eslint 报 10875 个 `Delete ␍`）——**以后批量改仓库文本文件必须用 `newline=""` 保留原换行**，本轮已由 `eslint --fix` 复原（git diff 干净）。
  - **残差（如实）**：① `executor.service.markStaleOffline` 的 Executor 表条件 UPDATE+RETURNING 未并入——它是**执行器**状态机不是执行状态机、且无槽位释放语义，强行并入会稀释入口契约；② A2-B（`assertCanWrite` 提为守卫内强制）仍未做，A2 的声明仍只是契约。
  - **下轮建议**：① A3 执行器协议契约化最小切片（timeout=0 / readiness）；② A4 契约单一事实源收口；③ A5 SSE 客户端统一；④ A6 回调可靠性分层；⑤ A2-B。生产真机项不变（QA-05 24h、多主机拓扑）。
- **本轮（2026-09-14 盘点「还有什么要推进」→ E-07 残差收口 + A2 写面守卫装饰器化 + nginx-sse 阈值根治，4 commit，主控）**：用户问「继续看看还有什么要推进的」。先做全盘核查（认领板 + DEEP_REVIEW §七）得到结论：**唯一成规模的剩余工作是 §七 20 个架构方向（A1~A6 优先）**，其余为需外部条件项（真机/长稳/拍板）。用户选定 **A2**。
  - **`9d11578` E-07 残差收口（停机 abort 在飞长轮询）**：DR-FIX-ALL 声明的两项残差之一。此前停机只 `clearInterval`，**在飞的那轮长轮询（服务端阻塞至多 25s）仍在飞**——窗口末端带回的任务在 drain 阶段照样被 `acceptExecution` 领取执行，与「停机第一步停止取件」相悖，进程也多挂至多 25s。修：`admin-client` 的 `request`/`performRequest`/`postLong` 增可选 `signal` 并在**取消时短路**（不 failover 重试——同一个已 aborted 的 signal 会立刻再拒一次、白烧 500ms 退避 ×N；不记 warn）；`pull.ts` 每轮建 `AbortController`，`stopPullLoop()` 从「只 clearInterval」改为「clearInterval + abort 在飞请求」，finally 摘除句柄、catch 对 abort 记 info（预期中止，不污染告警面）。**这不是美化是真缺陷**——关掉了「停机后仍会接新任务」的窗口。验收：executor-node **333/333（+4）** + tsc 0 + eslint 0；**反证有牙**（注释掉 `abort()` → 对应用例立即红，且暴露悬挂会污染后续用例 → 已给测试加兜底定时器使未来回归「只红不瘫」）。ADR-005：`executor-node/src` 改动后按 CI 同款命令重打 desktop bundle，manifest 回填 `fd472155…`。
  - **`89b408d` ARCH-A2 写面守卫装饰器化 done**（DEEP_REVIEW §七 A2，评审 §1.2 第 2 条根治项）：根因是**归属守卫在 service 内手工调用、缺「缺省拒绝」机制**，R-02/R-03 类漂移必然再发。形态=新 `@WriteGuard(resource, { scope, reason? })` **纯元数据**装饰器（不改运行时行为）+ **穷举扫描 spec**（`write-guard-coverage.spec.ts`）：遍历 25 个控制器、用 Nest 真实元数据键（METHOD_METADATA）识别 **98 个写端点**，逐个断言授权形态已显式声明（`@Roles` 非空 **或** `@WriteGuard`）；scope 与 `@Public()` 必须自洽（token/public→必须 `@Public()` 且 reason 非空；ownership/authenticated→不得 `@Public()`）；两者不得共存；免 JWT 端点清单（14 个 token/public）钉死，新增即红。**扫描器自身带守卫**（关键）：① prototype getter 在原型上访问会因 this 无依赖抛错（`ExecutionsStreamController.idlePingMs`）→ 只取「数据属性且值为函数」；② 元数据键写错会造成「扫不到任何东西」的**永真断言** → 断言规模下界 + 抽样钉住已知端点。**扫出 53 个写端点从未声明过授权形态**（正是评审点名的面）：逐端点核实真实授权模型后补声明——ownership 31（task 15 / task-batch 4 / event-subscription 3 等）/ authenticated 8（api-keys 3 / auth 5 / registry.uploadPypiPackage / task-template 3 / users.update / task.create）/ token 9（executor 5 / execution-callback 1 / artifacts.upload 1 / app-deployment.heartbeat 1 / executor-package.pushResult 1）/ public 5（application.webhook + alerts.webhook + auth 登录三步）。验收：admin-api **163 套件 2610/2610**（2604 基线只增 +6 = 本扫描测试）+ tsc 0 + eslint 0；反证有牙（移除 `UsersController.update` 一处声明 → 立即红并精确点名）。**残差（如实）**：① 声明是**契约不是强制**——`@WriteGuard('x', {scope:'ownership'})` 拦不住 service 忘记写归属校验；根治需 A2-B（把 `assertCanWrite` 提升为守卫内强制），要先统一各资源域的 id 解析方式，本轮不做；② `RegistryController.uploadPypiPackage` 实测为「任意已登录用户可传 PyPI 包」（无 @Roles 无属主校验）——按**现状如实声明**并写进审计清单，加固属 §七「registry 面收敛」方向。**高效做法沉淀**：核实 53 个端点的授权模型时，先用脚本导出「装饰器行 + 方法签名」的紧凑清单（比逐个打开文件快一个数量级），再只对不确定的几个读 handler/服务实现。
  - **`ff3d8ee` nginx-sse selftest 红灯根治**：run 34857560563 报 ΔRSS=206MB 撞固定上限 200MB。**先自证本轮无任何 admin-api 代码改动**→判定阈值本身有问题。根因=**阈值与可配负载无关**：`NGINX_SSE_CONNS` 可配（默认 500）而上限写死 200MB，等于把「连接数」当「泄漏」测（1000 条必红、100 条形同虚设），且 500 条档只剩 3% 余量（实测 412KB/连接），GC 时机噪声即可越界。改为**按连接推导**（512KB/连接 + 32MB 固定余量 → 默认 282MB），实测基线与推导写进注释；⑦ soak 档（连接数固定 3）仍用 200MB 绝对值，**未被顺手放宽**。
  - **`3ed4e29` 认领板卫生**：DR-FIX-ALL 行两处 E-07 残差注记标记已闭环；QA-05/BUG-19 备注早已写「四档全部达成 + 白皮书产出」但状态仍 `claimed`——补「状态澄清」句（交付面 done，claimed 仅因剩余项 24h 长稳 / 多主机拓扑属生产真机验证），防后续会话误判为未交付。
  - **本轮环境新知**：`gh run watch` 会因代理断连报 `EOF` 并 exit 1，**这不是 CI 失败**，判据要回到 `gh run view <id> --json status,conclusion` 重查（本轮一次误报）。
  - **下轮建议**：① A2-B（把 `assertCanWrite` 提为守卫内强制，真正实现「缺省拒绝」）；② A1 执行状态机收口；③ A3 执行器协议契约化最小切片（timeout=0 / readiness）；④ 生产真机项不变（QA-05 24h、多主机拓扑）。
- **本轮（2026-09-14 CI 迭代：`gh` 看 action 报错 → 逐类根治，8 commit，run 34854946055 全绿，主控）**：用户指令「gh看action的报错 解决」。轮1~7 的 7 个批次此前一直**只在本地跑过、从未推送**，因此 CI 从未执行过其中的新增测试——首跑一次性暴露 8 类问题（**4 类是轮1~7 新增测试的自报绿从未被 CI 验证过**）。逐轮 push→`gh run list`→`gh run view --job <id> --log-failed`→根因修复，8 commit 收口：
  - **`69d8a47` admin-api-test**：ARCH-001 用例组重建 `process.env` 时用 `ORIGINAL_ENV` 继承，CI job 级弱口令 `admin123` 漏进生产 fail-fast 断言。修复=`STRONG_PRODUCTION_ENV` 补 `INITIAL_ADMIN_PASSWORD`。**教训：jest 里重建 env 必须显式覆盖 job 级变量，不能靠 `ORIGINAL_ENV` 兜底。**
  - **`f989627` selftests 建库竞态**：`database "autoflow_arch31o_…" does not exist`。根因=**官方 Postgres 镜像 entrypoint 在 initdb 阶段先起临时服务（`listen_addresses=''`）**，容器内 socket 版 `pg_isready` 此时即返回 0，`CREATE DATABASE` 落在窗口内失败且未检查返回码。修复=新 `scripts/pg-provision.lib.mjs`（**host TCP 就绪 + 有界重试 + 检查返回码**），7 个 selftest 接入。
  - **`776c70e` desktop-bundle-drift**：manifest `executor-node-bundle.sha256` 陈旧。重打回填（`4e100f37…`）。
  - **`e05b714` docker-multiarch-build ×2**：`Cannot find module '/scripts/gen-install-script-content.mjs'`。根因=镜像构建上下文是 `apps/admin-api`，`../../scripts` 解析成 `/scripts` 不存在。修复=上下文内薄包装 `apps/admin-api/scripts/prebuild-install-script.mjs`。
  - **`c595645` executor-node-test E-27 单飞失效（真 race 非 flaky）**：现象 `Received: 4`（应 ≤2），本地 8 跑 1 红。根因=等待者复用在途刷新的判据用**时间戳**，而该时间戳取自 `performTokenRefresh()` 开头捕获的 `now`，早于任何等待者入场——只有"刷新启动与等待者入场落在同一毫秒"才成立，跨毫秒边界全体 fall-through，N 个并发 401 各自再发一次 `/token`。修复=**单调序号 `refreshFetchSeq`**（每次真实 fetch 成功自增）+ 用例重复 25 轮放大边界；**已反证有牙**（临时把 `>` 改 `<`，第 1 轮即报 4 次）。同 commit 顺带：`EXECUTOR_ALLOW_PRIVATE_NETWORK` 取值兼容 `1`（此前注释/报错都写 `=1` 而实现只认 `'true'`，文档-实现分叉）+ config.spec 补 7 条取值矩阵。
  - **`bf4d572` e2e-full 两例稳定红**：ⅰ 用例 45——`@Post("pull")` 缺 `@HttpCode` 默认回 201，与端点自身 `@ApiResponse(200)` 及用例判定矛盾 → 显式 200；ⅱ 用例 46——`rotateToken()` 未驱逐 F-5 `tokenValidationCache`（键 `sha256(address|token)`，TTL 60s，仅缓存正结果），被撤销旧 token 仍命中正缓存，有 60s 失效窗口 → 缓存值结构改带 `address`，新增 `evictTokenValidationsFor(address)`，`rotateToken()`/`removeById()` 均调用。同 commit：`.eslintrc.js` 把 E-38 生成物 `install-script.content.ts` 加进 `ignorePatterns`（`lint --fix` 会用 prettier 改写生成物，而守卫在另一个 job 校验——本会话第二次撞到，这次根治）。
  - **`92515c2` selftests arch31-rollout（statuses=failed,failed）**：SSRF 豁免只给了 admin-api 实例，**执行器进程没有**，而真正去下载部署包 zip 的是执行器（部署包源是回环静态服务器）。修复=执行器 env 补 `EXECUTOR_ALLOW_PRIVATE_NETWORK: 'true'`；已直接实测 dist 产物复现拒绝与放行两态。
  - **`6735083` selftests nginx-sse（502）**：DEP-HA-1 把 conf 上游改成变量形态（`set $admin_api_upstream admin-api:3105` + `resolver 127.0.0.11`），selftest 的替换正则仍匹配旧形态 → 未替换 → 走 Docker DNS resolver，host 网络下不可达。修复=替换 token 改 `admin-api:3105` 并换成 IP 字面量，断言同步改判变量形态。
  - **结论（权威核对）**：run **`34854946055` @ `6735083`** = 48 job，**44 success + 4 skipped + 0 failure**。关键 job 全绿：`admin-api-test`、`executor-node-test`、`e2e-full`、`selftests`（10 脚本串行全过，含此前从未执行过的 pull-dispatch / qa05-callback-tier / oidc-sso / nginx-sse / ha-compose / registry-npm）、`desktop-bundle-drift`、`docker-multiarch-build`。4 个 skipped 为 push 事件下的既有门控（PR/dispatch 触发）：`desktop-linux-bundle`、`desktop-macos-bundle`、`desktop-e2e-smoke`、`e2e-full-windows`。
  - **方法论沉淀（重要）**：① **「提交没推送 → CI 没跑过 → 新测试的自报绿是假的」**——8 个问题里 4 个（selftests 的 rollout / nginx-sse、e2e-full 的用例 45/46）都是轮1~7 新增、从未在 CI 执行过的测试首跑暴露。② **selftests 是串行 10 脚本，前一个红后面不跑**，必须预期逐轮暴露、勿一次改多脚本赌运气。③ **判断 job 清单必须用 `gh run view --json jobs --jq`**——文本输出会被 `head` 截断导致漏报失败 job（本会话已踩坑）。④ 判定真红/假红先看失败类型：`Exceeded timeout` = 预算问题，断言失败 = 真回归。
  - **本机测试基线**：executor-node 23 套件 **329/329**（+7）+ tsc 0 + lint 0；admin-api 162 套件 **2604** 用例（+2），本机 2603 绿 + 1 例为沙箱 `node-safe-delete-shim` 拦 `fs.unlinkSync` 制造的**假红**（`application.service.spec.ts:617` 的 `finally` 抛错被记成失败，断言其实通过；CI 无此 shim）。
  - **下轮建议**：① 生产真机项不变（QA-05 24h 长稳、多主机拓扑）；② §七 20 个架构方向（A1~A6 优先）为季度级演进；③ `desktop-e2e-smoke` 在 windows runner 的「Process failed to launch」仍为 v1.2.0 起文档化的既有现象（PR-only 非门禁），留 QA-12 CI 形态专项。
- **本轮（2026-09-14 DEEP_REVIEW 修复编排 轮1~7 全量独立复核 + 测试可靠性收口，主控）**：承接 `67cad65`（轮7 = P3 打磨 56 项，批次 4 收官）后，对 HEAD 做了一次**不采信自报数字**的全量独立回归。**结论：DEEP_REVIEW 编号修复项（R-*/F-*/E-*/PK-*）轮1~7 全部清偿，批次关闭**（`docs/PLAN-CLAIMS.md` 的 DR-FIX-ALL 已置 `done`）。
  - **全量验证（本机实测）**：admin-api **162 套件 2602/2602** + `tsc` 0 错 · executor-node **23 套件 322/322** · executor-python **305/305** · admin-web **83 文件 725/725** + `tsc -b` 0 错 · desktop `tsc` 0 + renderer selftest 绿 · mcp **113** · acf-cli **97+1skip** · node-sdk **69** · python 五包 **112/31/34/21/19**（autoflow-sdk / http / ai / notify / db，隔离 venv）· registry-pypi **84** · check-migrations **68** 唯一（下一可用 1790000000024）+ selftest 绿 · enum-drift **13/13** · openapi↔api-types **零漂移**（重跑 `gen:api-types` 无 diff，R-18 `maxItems:500` 已落）。
  - **复核新发现并修复 4 处「超时假红」测试缺陷（非代码回归，此前各轮自报均为绿）**：① executor-node `scheduler.spec` 版本漂移用例——假时钟需推进 600+ 拍，空闲 <1s 但并发下破 5s 默认上限（显式 30s 预算 + 原因注释）；② `callback.sharding.spec` 死信用例——E-05 把 `CALLBACK_FILE_MAX_RETRIES` 由 60 提到 150 后循环变 170 轮，15s 上限不足（提到 60s + 注释）；③ admin-web `execution-detail-trace.test.tsx` **首个用例承担惰性 `await import()` 的整张 ExecutionDetailPage 依赖图转译**（实测 19.5s 撞 20s 上限）→ 导入提升至模块顶层后 **19.5s → 0.8s**（根因级修复）；④ `notification-silences.test.tsx` 首渲染 ~2s 撞默认 5s（文件级 `vi.setConfig({ testTimeout: 20_000 })`）。
  - **系统性收口**：admin-web `vite.config.ts` 增设 `testTimeout: 30_000`——同一 HEAD 三次实测空闲 **2 红** / 中负载 **14 红** / 高负载 **31 红**，**逐条核对全部为 `Exceeded timeout` 而非断言失败**；抬至 30s 后 **83/83 文件、725/725 用例全绿**。证据链与推导写进配置注释（jsdom + antd 重型页面：83 文件累计 transform ~110s / import ~710s，5s 默认上限不现实）。
  - **教训沉淀（重要）**：**并发跑多套重型测试会制造超时假红**——本会话首轮四套件并行时 admin-web 报 31 红、executor-node 报 2 红，**串行/无负载复跑即转绿**。今后判定「真红/假红」必须先看失败类型（`Exceeded timeout` = 预算问题；断言失败 = 真回归），并**串行**复跑确认，勿据并发结果改代码。
  - **基线**：develop 领先 origin **10 commit**（轮1~7 + 本轮，待用户决定 push 时机，延续既有纪律）。**下轮建议**：① 生产真机项不变（QA-05 24h 长稳、多主机拓扑）；② §七 20 个架构方向（A1~A6 优先）为季度级演进，可另立任务；③ 若 CI 上 admin-web 仍见超时类红，参照本次 30s 结论调整 CI 侧预算。
- **本轮（2026-09-14 DEEP_REVIEW 修复编排 轮3 = P2-S 分域第一批，main-A 两会话并行 + 主控复核收敛，`bca6934`+`342bb75`）**：范围 22 项——执行器批 8 项（E-05/E-06/E-07/E-08/E-11/E-15/E-19/E-44）+ packages/CI 批 14 项（PK-06/07/08/11/12/13/16/17/18/22/23/24/28 + E-13/PK-15）。**主控独立复核（真跑全部套件）后有两处实质修正**：① **E-05 预算推导错误**——原实现 60 轮 + base/cap 的注释与测试都写「≈24h」，按门控实算只有 ≈9.0h（node）/≈8.6h（python）；改为 150 轮（node ≈24.0h / python ≈23.6h）并把 budget 求和推导写进两侧测试，防常量单改再漂移。② **ADR-005 desktop ncc bundle 漂移**——round2 起对 `executor-node/src`（pull/execute）的改动从未重打 `resources/executor-node`，`desktop-bundle-drift` 守卫此前必红；本轮 `ncc --source-map --no-cache` 重打并随执行器批同 commit 提交（bundle 内含 stopPullLoop/slotPreReserved/activeWorkdir 等新符号已核）。**基线**：executor-node jest 22 套件 **290** 绿 + tsc 0 错 · executor-python **268** 绿 · admin-api tsc 0 错 + jest migrations 24 套件 **135** 绿 · check-migrations **67** 全注册 + selftest 绿 · mcp-server **113** · node-sdk **69** · acf-cli **95+1skip** · python 四包 + autoflow-sdk **199**。**残差（如实）**：E-07 仅停 pull 循环，在飞长轮询未 abort（需 postLong 支持 AbortSignal）；PK-17 脱敏为 opt-in 钩子（无内建默认掩码，调用方须传 redactor）；acf-cli `config-security` 的 conf 首载 5s 超时为 Windows 冷启动 flake（本批复跑未复现，非本批引入）；openapi 重导出本机无 PG/Redis 无法验证（本批仅实体 `@Index` 注记，非 swagger 面）。**下轮建议**：① 轮3 剩余 P2-S 分域（安全 R-07/R-08/R-14/R-25/E-04/E-09/E-10/E-25/F-05；性能 R-09/R-10/R-15/R-24/PK-09/F-10/F-11/F-12；CI/测试 E-18/E-32/E-33/E-41/PK-26/F-38；一致性 R-12/PK-10/PK-14/PK-19/PK-20/PK-31/PK-32）；② PK-02/PK-03 仍需有栈（PG+Redis）环境重导出 openapi；③ 本批未 push（延续用户决定 push 时机的纪律）。
- **本轮（2026-09-14 push 收敛 + UI-18 pull 入站推送面收口，主会话）**：① **push**：本地 7 commit（含防 CI drift 的 openapi/api-types 重导出）与远端并行 19 commit（R22~R23 批：LeaderGate、NF-05 UI 半场、文档卫生等）合并推送——rebase 因 handoff 嵌套冲突改走 merge（冲突 3 文件：executor.service 构造函数 leaderGate+pullService 并集、ADR 索引随远端三列格式、handoff 条目并集去重），合并后四端全量绿（admin-api 2509/node 279/py 253/web 665）+ swagger 重导出字节级核对后 push，**CI run 34770002165 首红**（两处）→ 修复后 **run 34770860613 全绿**。② **CI 假红两处修复（8080f3a/0d19d1c）**：ⅰ executor-python 版本漂移节流用例——`time.monotonic()` 基点随机器而异（CI runner 新启动仅数秒，`now - 0.0 < 600s` 使首测告警即被节流，本地开机久侥幸绿）→ 固定时钟注入（now=1e6）+ 去 caplog 依赖；ⅱ desktop-bundle-drift（W-18 守卫）——ARCH-32 改了 executor-node 源码使 `apps/executor-desktop/resources/executor-node` 内嵌 bundle 过期 → `npm run build:executor` 重打提交。**教训：改 executor-node/python 源码必须重打 desktop bundle**（守卫已拦截，勿手改产物）。③ **UI-18 done**：批量 reload-config 目标剔除 pull 执行器（全 pull 直接 warning、部分剔除在确认弹窗标注跳过台数）+ ExecutorDetailPage 派发模式 Tag 与 pull 时「配置热更新」disabled+tooltip（并发上限随下次拉取/心跳生效）+ zh/en 各 7 key；测试只增 admin-web +4 = **669/669**（executor-pull-gating）+ tsc -b 0 错 + lint 0 error。
- **本轮（2026-09-14 剩余任务池清偿：BUG-07/DSK-01/QA-05/BUG-04，主会话）**。用户授权「接下来的任务全部搞定」后逐项清偿可本地/CI 闭环项：
  - **`BUG-07` done（Windows 真机窗口依赖消除）**：R14 真机验证过的三条进程级链路（P-7/P-9/P-10）此前无持续守卫（单测只断言参数形态不产生真实进程树）——新 `scripts/bug07-windows-selftest.mjs`：① detached spawn + `process.kill(pid,'SIGBREAK')` 走真实 GenerateConsoleCtrlEvent 路径断言优雅收尾；② windowsHide 任务进程 + detached 孙进程 → `taskkill /T /F` → CIM 命令行特征探测整树全灭；③ windowsHide 形态任务树正常起。挂入 ci.yml windows-node-tests（每次 push 真跑）；Linux skip 退 0。
  - **`DSK-01` done（macOS 真机依赖消除）**：electron-builder mac 段/dist:mac/icon.icns 早已就绪，缺的只是执行环境——ci.yml 新 desktop-macos-bundle job（macos-latest = 真实 macOS）：dist:mac 打 dmg/zip × x64+arm64 → artifact；CSC_IDENTITY_AUTO_DISCOVERY=false 跳签名（正式分发签名留产品流程）；PR/workflow_dispatch 触发（与 linux bundle 同姿态）。
  - **`QA-05` 第四阶段 done（四档全数通过，单节点参考基线）**：① 1000 任务/分→实测 1223/min 100% p95 29ms；② 500 并发→500/500 p95 25ms；③ SSE 500 连接→500/500 保持到期建连 p95 218ms；④ 回调 10k/分→**实测 90181 条/分**（9 倍）100% 零 429。**工具两发现**：ⅰ `--max-rpm` 是聚合预算且写请求双耗——只抬 `--callback-rate` 被 max-rpm=55 钳到 ~60 req/min（三组对照实测钉死），README 已显著标注；ⅱ per-execution 回调 token 为 stateless HMAC 带过期，长压测须按窗口续签。`load-test-stack.sh` 补 `THROTTLE_CALLBACK_LIMIT`（默认 600）放大。记录落 docs/QA-05-capacity-boundaries.md §8；CAPACITY-WHITEPAPER 可引用为单实例基线。
  - **`BUG-04` 跟踪结论更新（非闭环）**：minio 上游自 RELEASE.2025-10-15 停止发版，2026 年披露 advisory 的 patched_versions（≥ RELEASE.2026-04-14）**声而未发**——「等上游」仍是最优解；缓解=可选 profile + internal 网络，默认部署零暴露。
  - **仍开放的需拍板项（非本会话可代劳）**：ADR-013 非成员 trigger 收紧、release-please main 合并习惯、API JWT 60d 缩短评估、desktop Linux 更新链签名。
- **本轮（2026-09-14 剩余任务池清偿完成 + CI 迭代 5 轮全绿，主会话）**：接上轮，BUG-07/DSK-01/QA-05/BUG-04 四项收口过程中暴露并根治了三个潜伏已久的 CI/工具问题：
  - **CI 根治① desktop-linux-bundle「既有红」**（v1.3.0 起文档化 fail 的真实根因）：bundle-executor 的 ncc 对 executor-node 全项目（tsconfig include）类型检查，而 CI 的 desktop job 只 npm ci executor-desktop——373 错全灭（本地无法复现因依赖在位）。修复=linux/macos/e2e-smoke 三 job 补装 executor-node 依赖。
  - **CI 根治② secret-scan allowlist 从未生效**：.gitleaks.toml paths 正则内联 # 注释（Go 正则字面量）——gitleaks-action 全历史扫描 22 findings 全为 fixture 假凭据。修复=单行正则 + 测试文件名模式（.spec/.test/.selftest）。
  - **CI 新知③ Windows 信号投递边界**（BUG-07 迭代 5 轮的收敛）：SIGBREAK 经 process.kill → ENOSYS（Node 官方只模拟 SIGINT/SIGTERM/SIGKILL）、child.kill 假成功（libuv 不上抛 GCTE 失败）、自投递经 GCTE 亦不可达（CREATE_NO_WINDOW console 语义）——**结论：Windows 信号投递只能来自控制台键盘事件，无法 API 复现**。最终形态=①a 跨进程投递 best-effort skip（文档化原因）+ ①b 源级回归守卫（main.ts 双信号注册）+ ②③ 真跑绿（taskkill /T /F 整树全灭 + windowsHide 形态）。
  - **DSK-01 done**：desktop-macos-bundle workflow_dispatch 实测绿（dmg/zip × x64+arm64）；两处次生修复=package.json homepage（linux/deb 元数据必需）+ dist 调用 `--publish never`（repository 字段触发默认 GitHub publisher 缺 GH_TOKEN）。
  - **遗留（如实，非本批任务面）**：desktop-e2e-smoke 仍红——electron 在 windows runner「Process failed to launch」3/3，v1.2.0 起文档化的既有现象（PR-only 非门禁），疑显示层/Playwright 形态问题，独立于本批改动，留 QA-12 CI 形态专项。
  - **需产品拍板（不可代劳）**：ADR-013 非成员 trigger 收紧、release-please main 合并习惯、API JWT 60d、desktop Linux 更新链签名。
- **任务认领板：`docs/PLAN-CLAIMS.md`（多会话并行认领唯一事实源，开工前必读；含 2026-09-08 起的「H2 新任务段」41 任务点 + 「迁移时间戳分配表」常设段）；长期计划：`docs/archive/plans/development-plan-2026-09h2.md`（H2 版，2026-09-08 建账）；上期计划：`docs/archive/plans/development-plan-2026-09.md`（销账台账用）**
- **本轮（2026-09-14 UI-17 执行器列表双徽标，主会话）**：EXE-VER-1/ARCH-32 配套 UI 收口（handoff 上轮建议③①两小件同批，子代理第 3 次 reasoning-level-missing 全量直落）。① **admin-api 读面**：findAll 逐行投影 `versionCompliant`（isVersionCompliant(executorVersion, EXECUTOR_MIN_VERSION) 派生值不落库；门禁关/未上报版本恒 true）——中心端下限是配置、执行器版本在行上，合规态是两者的派生，读面计算最简且零迁移；② **admin-web**：ExecutorListPage status 列追加两枚条件 Tag——pull 执行器紫色「Pull 回连」（默认 push 不渲染防噪，U16 死信同款纪律）+ versionCompliant===false 火橙色「版本过低」（tooltip 提示升级、不引用具体下限值——minVersion 未从接口下发，避免再扩契约）；zh/en 各 4 key；api/executors.ts Executor 接口补两可选字段（旧快照兼容）；③ **测试**：admin-api +2（findAll 投影矩阵）= **2498/2498** · admin-web 新 executor-list-badges +3（pull 渲染/缺省不渲染、合规两态、双 Tag 并存）= **662/662** + tsc -b 0 错 + lint 0 error（27 warnings 全存量，stash 对照确认）。**基线**：admin-api 2498 · admin-web 662 · executor-node 279 · executor-python 253 · develop 领先 origin 6 commit（待 push）。**下轮建议**：① push 时机由用户定（本批 6 commit 含 ARCH-32/EXE-VER-1/DEP-HA-1/UI-17 四任务）；② 生产真机项不变（QA-05 24h、BUG-07、DSK-01）；③ 可选拓展：批量操作条对 pull 执行器禁用 reload-config 类入站推送（当前对其静默失败可接受，产品级优化）。
- **本轮（2026-09-13 ARCH-32 执行器 pull 模式派发（NAT 回连），主会话）**。背景：部署成熟度评估第 5 项（跨 NAT 执行器不可达）经用户确认「多层 NAT 场景存在」后转正立项。裁定 ADR-015：**长轮询拉取**（弃 WebSocket 反连——与 DEP-HA-1 多副本轮询冲突需 sticky/实例注册表；长轮询每请求独立、任意副本可应答、复用既有出站通道）。
  - **核心形态**：执行器 `EXECUTOR_PULL_MODE=true` 注册自报 `dispatchMode=pull`（迁移 1790000000019 默认 push 零影响）；调度侧全部既有选择语义不变（pinning/appName/group/tags/亲和/loadScore/原子占坑），仅传输层分支——占坑成功后 LPUSH 派发载荷（含 traceparent/pushedAt）到 Redis `acf:pull:{executorId}`；执行器空闲槽位时长轮询 `POST /executors/pull`（服务端 500ms 间隔 RPOP、waitMs 钳位 ≤55s、per-executor token 鉴权）取件走既有 acceptExecution/回调链。never-pulled 兜底=载荷 TTL 丢弃 + 既有 stale sweep，零新增后台任务；广播逐台入队；长轮询任意 admin 副本可应答（与 DEP-HA-1 天然兼容）。
  - **真机实测发现的关键缺陷**：executor-node admin-client post 硬编码 10s 超时，必然误杀 25s 服务端等待窗口（现象=拉取请求全部 timeout，载荷永远取不到）——新增 `postLong`（40s，覆盖窗口+余量且 < 反代 60s 读超时），其余调用维持 10s。
  - **领取核心双端抽取**：node `acceptExecution`（routes/execute.ts 校验/容量/登记主体，HTTP 路由退化为薄适配层）/ python `accept_execution`（+ExecutionRejected）——HTTP 与 pull 两入口共用同一路径杜绝漂移；node 领取被拒补发 failed 回调防 admin 僵尸 RUNNING 行；python pull 循环延迟导入防 scheduler↔routers 模块环。
  - **真机自检 `npm run test:pull-dispatch` 9/9**：执行器地址设 `unreachable-nat-host.invalid:9999`（push 必失败）跑通注册→触发→入队→取件→glue 执行→回调 **SUCCESS**——成功本身即零入站依赖的证明；result 携带 `dispatchMode=pull/status=queued` 传输分支证据。
  - **基线与状态**：admin-api **2496/2496**（2479 基线只增 +17：pull 队列 5/dispatch 分支 3/pull 端点 5/迁移结构 4 等）+ tsc/eslint 0 错 · executor-node **279/279**（+4）· executor-python **253/253**（+3）· develop 领先 origin 5 commit（待 push）。
  - **下轮建议**：① admin-web 执行器列表展示 dispatchMode 徽标（列已在读面）；② 生产真机项不变（QA-05 24h、BUG-07、DSK-01）；③ EXE-VER-1 回显的版本合规态进 admin-web 列表徽标（两小件可同批）。
- **本轮（2026-09-13 部署成熟度收尾批次：EXE-VER-1 + DEP-HA-1 + 文档卫生，主会话）**。背景：主会话完成「中台部署 + 分布式多平台执行器安装/配置/连接」两线成熟度评估（结论=核心链路已达可交付成熟阶段；评估识别的三项可落地优化经用户拍板「可你自己安排」后本轮实施；跨 NAT pull 模式回连与需真机项评估为暂不立项）。子代理平台两次派发均失败（reasoning-level-missing）→ 主会话直落。
  - **`eb5b64e` EXE-VER-1 执行器最低版本门禁 + 版本漂移提醒 done**：新 env `EXECUTOR_MIN_VERSION`（默认空=关，零行为变化；Joi 点分数字 1~4 段）——① register 时执行器 version 低于下限 403（落 service 层 registerExecutor 顶部、先于落库/发 token 副作用；报文含 minVersion+升级指引「重跑 install-cmd/换 artifact」；未上报版本的存量执行器放行+warn 不锁死；畸形版本 NaN→放行防锁死机队）；② heartbeat 请求体增可选 version（不落库），响应加法回显 minVersion/versionCompliant（门禁关=null/true，旧消费方无感）；③ 两端执行器新增单源常量 EXECUTOR_VERSION（register+心跳共用），消费回显打 10 分钟节流漂移 warn；node register catch 透传服务端报文（原日志只见 axios 403 无法定位版本问题）；④ 零依赖版本比较 util（不引 semver）。**测试**：admin-api **2479/2479**（2458 基线只增 +21：util 13/门禁矩阵 5/回显 3）+ tsc/eslint 0 错 · executor-node **275/275**（+2）· executor-python **250/250**（+3）。
  - **`30801d2` DEP-HA-1 admin-api 多副本部署配方 done**（ARCH-31 行为已闭环但无菜谱的收口）：① infra/nginx/default.conf 三处 proxy_pass（通用 /api/、SSE 专用位置、socket.io）全改「resolver 127.0.0.11 valid=10s + server 级 set 变量」运行时再解析——**SSE 位置同改是关键点**：静态 proxy_pass 启动期解析后永久缓存单 IP，HA 下长流钉死地址；X-Upstream 取证头 always；② 新 docker-compose.ha.yml override（`ports: !reset []` 清空 3105 宿主端口防 scale 冲突 + 共享卷 admin_uploads:/app/uploads 保 uploads 一致性；要求 Compose v2.24+）；③ 新真机自检 `npm run test:ha-compose` **4/4 本机全绿**（admin-api 桩 --scale 2 + 真实 conf 原件，20 请求命中 2 副本 12:8；不构建 admin-api 镜像——多实例行为由 arch31 套件覆盖，职责分离）；④ deployment.md 尾部「多副本（HA）部署」段（步骤/nginx 行为/约束表/升级回滚）+ 环境变量表 EXECUTOR_MIN_VERSION 行 + compose admin-api 头注扩容指引；nginx -t 与 compose config 双校验绿。
  - **AGENT_HANDOFF.md 冲突标记清理**：v1.3.0 收编合并遗留的孤儿 `<<<<<<< HEAD`（已提交入库）删除。
  - **基线与状态**：admin-api 2479 · admin-web 659（未触碰）· executor-node 275 · executor-python 250 · develop 领先 origin 3 commit（待 push）。
  - **下轮建议**：① 跨 NAT 执行器 pull 模式回连（评估第 5 项）仅在出现跨网执行器接入需求时立项，否则过度工程；② 生产真机项不变（QA-05 24h、BUG-07、DSK-01）；③ 可选小件：执行器版本合规态进 admin-web 列表徽标（EXE-VER-1 回显字段已就绪，需读面透出 executorVersion 对比）。
- **本轮（2026-09-13 R23 全仓排查清偿批：编排会话 + 4 执行子代理两波并行，17 commit 待 push）**：
  - **文档卫生 6 commit**：handoff 残留 `<<<<<<< HEAD` 冲突标记清理（2f9ff85）；Fast refresh 注记 ×18→×21 实测复核（8353ab7）；ADR 索引补 013 行 + 014 行格式修复（8053ee8）；多实例矩阵头部「验证尚未执行」陈旧口径对齐收尾实测（a67a606）；H2 §10 快照警示注记（c11ae1a）；optimization-notes 停更注记（1411480）。另 PLAN-CLAIMS 主表 DOC-06 重复行去重 + SEC-NEW-2 记账翻转 done（4f3730c）。
  - **代码小修 5 commit**：acf-cli `unwrap` 判据对齐 mcp-server「data 键 + code 为数值」——业务实体误解包分叉消除，95+1skip 净增 3（86cc939）；**/health swagger example 补 tasks**——decorator 与 openapi.json 手工同步（canonical 往返校验 + gen:api-types 零 diff + health spec 23 绿；本机无 docker/PG/Redis 无法真导出，**push 后 CI 首跑实测通过（run 34768313679 全绿 46 job，重导出与手工同步逐字节一致）**），atlas 偏差注记收敛（69f3a4a）；executor.service 三处 as any 收敛为精确类型，纯编译期（98b1494）；registry-npm jwt verify someProp 死键清理 + selftest 防回归断言（1f5c838）；node-sdk package-lock 内部旧名 @autoflow/sdk 收敛（手工两处，npm 重生成会波及 engines/peer 噪音故弃）（c9ec296）。
  - **`d3f4406`+`0658c5c`+`1796b71` LeaderGate 落地（矩阵 §5 建议项兑现）**：新 common/leader-gate（@Global，独立 lock key `cron:leader` 不复用 scheduler:leader，TTL 30s + TTL/2 extendLock demote + 15s 竞选重试，Redis 抛错 fail-open 与 scheduler 同款语义；@Optional 注入缺席即旁路，既有 spec 零改动）。**grep 复核推翻矩阵旧账：无门禁 @Cron 实为 7 文件 10 处**（原记 8 处漏 artifacts-retention 与 WIKI-LOG-S3GC 的 s3-log-object-retention），全部接入；admin-api 全量 **154 套件/2469 绿（+11）**。多实例 `cron:leader` 单点性真机验证留环境轮。
  - **`ce4fb0d`+`9e3af06` NF-05 UI 半场 done**：通知设置页补齐 feishu（webhookUrl + 可选加签 secret，沿用 SECRET_FIELD_RE 掩码/免必填豁免路径）与 webhook（`url`，对齐后端 N32 形状）的配置表单 + 静默渠道徽标 + 测试发送选项 + 渠道描述六渠道枚举；+3 用例。
  - **R23-I18N-B1 复核销账（零改动）**：先前「admin-web 33 文件/200+ 行硬编码中文残留」为扫描口径误报（JSX/块注释被计入）——字符串感知精扫 5 个 top 页面**非注释硬编码实为 0**（ui-10 系列 8c23dcf/83472ed/98302f9/e1db128 已迁净），Dashboard 趋势 dataKey 中文键为 round 12 既定保留（匹配后端数据值）。后续轮勿再按旧口径立 i18n 任务。
  - **基线**：admin-api **2469/2469**（154 套件，+11）· admin-web **662/662**（+3）· acf-cli 95+1skip（+3）· node-sdk 63 · typecheck:all 七链绿（本机 desktop 链曾因 electron-updater node_modules 漂移伪红，补装后 EXIT=0——CI npm ci 无此问题）· lint 0 error/27 既有 warning。develop 领先 origin **17 commit**（R23 全批，待用户决定 push）。
  - **排查批产出但不可本地闭环（如实登记）**：需环境 11 项（BUG-07 Windows detached/DSK-01 macOS/QA-05 24h 长稳/BUG-17 24h 门禁/裸机部署/ARM64 真机/QA-06 混沌/clamd/keyring/企业 IdP OIDC/反代派发留验）；需拍板 2 结构项 + 小项（ADR-013 非成员 trigger 收紧、release-please main 合并习惯根治、API JWT 60d 缩短评估、desktop Linux 更新链无签名）；拓展未立项（执行器令牌缓存 Redis 化、OpenTelemetry 全链、NF-02 fail-fast 分支策略、BUG-04 等上游 minio）。
- **上轮（2026-09-13 CI 治理：annotations 3 errors/23 warnings 排查 + multiarch 卡死根治，主会话）**。**追加实测（74cb6ec）**：原生 arm64 方案上线后出现一次新红灯——setup-buildx 拉 moby/buildkit 镜像遇 Docker Hub connection reset（第三方网络瞬断，run 34761485357）。最终形态：**弃 setup-buildx-action（docker-container driver），单平台原生构建改用 runner 自带 docker driver**——buildkit 镜像拉取点彻底消失（零 Docker Hub 依赖，除基础镜像层），type=gha 缓存随之移除（docker driver 不支持；原生构建 ~86s 冷构建可接受）。复测 run 34761893176：6/6 全绿，arm64 admin-api 秒级区间，CI multiarch 从此无第三方镜像源依赖。
  - **3 errors 根因与修复（6b04da3）**：① admin-api-test 红 = lint error（并行会话新文件 executor-shared-token.guard.ts 的 `{}` 空对象类型撞 no-empty-object-type）→ Record 精确类型；② api-types-drift 红 = 远端 pushResult 改 guard 形态后未重导出 → 重导出 openapi/api-types（authorization header 参数移除为有意契约变化）；③ multiarch (executor-node) 45min 超时 → 初步加 gha 缓存。GlueEditor useCallback 缺 t 依赖一并修复；deprecated actions 升级（qemu/buildx/build-push/gitleaks v4/v4/v7/v3）；admin-web 659 / admin-api 2458（并入并行会话新测试）全绿。
  - **`42c4559` multiarch 卡死根治（用户报「同位卡死 5+ 次、重跑偶发能过」）**：根因 = **QEMU 模拟 arm64**——admin-api 依赖树最大，QEMU 下 npm ci 慢到像挂死（非死锁，是模拟性能抖动，重跑偶发过）。彻底方案 = 弃 QEMU，改 **GitHub 原生 arm64 runner**（ubuntu-24.04-arm，public repo 免费）+ ubuntu-latest 双 job 并行各构建单平台，matrix exclude 保证 镜像×平台 恰 6 job（fail-fast: false），timeout 显式 20min，gha 缓存按 镜像×平台 分 scope。**实测（run 34761164921）：6/6 全绿，arm64 admin-api 76 秒**（此前 45min+ 卡死），最慢 job 86 秒，全程无 QEMU 无偶发挂死——同一处卡死的根因级消除。
  - **遗留注记**：Fast refresh（react-refresh/only-export-components）×21 warning 为 UI-04「组件文件伴生导出纯函数」的既有设计取舍，保留不动（2026-09-13 复核：admin-web `npx eslint src` 实测 0 errors / 27 warnings，其中该规则 21 条，×18 为过期计数）；gitleaks v3 行为差异（SARIF 上报移除）如有需要回看 ci.yml secret-scan job。
- **发布轮（2026-09-13 v1.3.0：R15~R21 七轮产物发布，主会话）**：
  - **发布物**：push develop（12 commit）→ main 合并（e974e23）→ **Release PR #5（人工开）合并** → 人工 tag v1.3.0 → release.yml run 34755702543 全绿（version-guard 7s ✓ / publish-pypi ✓ / publish-npm ×2 ✓，无 environment 审批等待）→ **npm autocodeflow-mcp-server@1.3.0 / npm @autocodeflow/sdk@1.3.0 / PyPI autoflow-sdk 1.3.0 三包上架**；冒烟：npx mcp-server@1.3.0 --version=1.3.0（VERSION 常量同步验证）、PyPI venv 真装 1.3.0；GitHub Release 对象已建。
  - **⚠️ R19 修复方向证伪（如实修正）**：实测发现 `command` 是 release-please-action@v4 的**无效 input**（run 34755386601 warning 列出合法 inputs 无 command；两个 step 实际都跑默认 manifest 模式）——R19「补 github-release step」方案无效，tag 自动化未打通。发布轮连环实测定位出真正的三层阻断：① v1.2.0 人工 tag 时**缺 GitHub Release 对象**（release-please 以 GitHub Releases 为「已发布」事实源，缺失即状态机卡死）→ 已补建（gh release create v1.2.0 --verify-tag）恢复状态机；② 历史非规范 merge 标题（"Merge develop — handoff…"）触发 conventional 解析错误（unexpected token at 1:6）→「No user facing commits found since 96b4679」——5 个 feat commit 被吞，release-please 拒绝开 PR；③ release-please 只认 bot 形态（head=release-please--branches--main）的 Release PR，手工 PR 不被状态机接纳。**处置**：按 v1.1.1/v1.2.0 先例人工开 Release PR #5（三包 lockstep bump + CHANGELOG×3 + DOC-09 六页声明同步，e3f0016）+ 人工 tag。workflow 已回退无效的 command input 写法（保留双 step 形态无害；若未来要自动化，方向=修 gh 页面 merge 习惯或升级 action 或接受人工 tag 兜底）。
  - **遗留**：① release-please 自动化仍以人工 tag 兜底收尾（三层阻断中②是根治点：main 上 merge commit 标题需规范或改 squash 合并习惯，涉及协作流程变更，留产品/运维拍板）；② docs/release-checklist.md 的 v1.3.0 验证点已按实测结果回写（github-release step 未达预期，人工路径仍为主路径）。
- **本轮（2026-09-13 第二十~二十一轮：SSO 组映射 + 发布就绪度，主会话直落）**：
  - **`82c70c6` R20 SSO 组→角色映射 done（ADR-014 修订）**：`OIDC_GROUPS_CLAIM`（默认 groups）+ `OIDC_ADMIN_GROUPS`（逗号清单，默认空）——**仅 JIT 建号时生效**：命中清单建 ADMIN，否则 USER，清单空恒 USER。安全边界（刻意不做）：已绑定/存量账号角色不随 IdP 组反向改写（防 IdP 误配提权与「IdP 降级 vs 平台提权」打架）；ADMIN 自动化生效需 AUTO_PROVISION 与 ADMIN_GROUPS 双开关同时显式开。validateIdToken 归一组声明（数组/单字符串）。测试 +4（默认/命中/缺失/存量不改写），admin-api **2389/2389**。
  - **`e039d12` R21 发布就绪度 done**：release-checklist.md 区分「部署锚点 tag」与「包发布管道」并增补 v1.3.0 起的 github-release step 实测 checklist（自动 tag/自动触发/人工降兜底/abort 备选）；sdk-guide 恢复路径补 R19 注记；**version-guard 本地干跑 PASS**（模拟 tag v1.2.0，5 处 version 一致）；sync-check 七面绿。
  - **基线**：admin-api 2389 · admin-web 659 · mcp-server 108 · acf-cli 93 · docs-site build+sync-check 绿。develop 领先 origin **11 commit**（R15~R21 七轮产物，待 push）。
  - **下轮建议**：① **v1.3.0 发布轮（最高优先）**：push develop → develop→main → Release PR 合并实测 R19 github-release step 全自动链（version-guard 干跑已 PASS）；② 生产真机项不变（QA-05 24h/BUG-07/DSK-01）；③ 拓展候选（按需）：SDK 层项目域消费、SCIM/组同步深水区（ADR-014 已注记不做，除非产品要求）。
- **本轮（2026-09-13 第十七~十九轮连推：通知渠道豁免 + 项目域生态消费 + 发布管道根因修复，主会话直落）**：
  - **`c7ef8eb` R17 通知渠道私网豁免开关 done**：`NOTIF_ALLOW_PRIVATE_NETWORK`（默认 false 零行为变化）——企业微信/钉钉/Slack/飞书/自定义 webhook 五渠道共用（内网自建网关场景，第十五轮 deployment.md 注记的扩展项兑现）；email 走 SMTP 不受影响；webhook 渠道 ConfigService @Optional 注入（存量测试装配零改动）。channels.spec +7（54→61，含元数据恒拒代表性断言），admin-api 全量 **2385/2385**。
  - **`6b42f54` R18 项目域生态消费 done**：mcp-server 新 registerProjectTools 只读三工具（list_projects——描述写明读面过滤与 myRole 能力预检语义 / get_project_members / get_my_project_roles；成员写面 ADMIN-only 刻意不在自动化面暴露）mcp 100→**108**；acf-cli 新 `acf project list|members`（表格+--json 双形态、myRole 着色）acf-cli 89→**93**。
  - **`26e41f3` R19 发布管道根因修复 done（v1.2.0 遗留建议①的定位结论）**：release-please-action@v4 把命令拆为 release-pr（默认）/ github-release——原 workflow 只有默认 step，**从未运行 github-release**，Release PR 合并后永远无人打 tag，v1.1.1/v1.2.0 均人工收尾。此前「merge commit 检测失败」假设是次级因素。修复=补第二 step（command: github-release，同 PAT/config/manifest）：Release PR 合并（merge commit 即 push main）→ 自动打 tag → PAT 已解级联 → release.yml 全链自动。development.md 记录根因/修复/abort 复现备选（Release PR 改 squash 合并）；v1.3.0 发布时实测。docs-site build 绿（死链检查）+ sync-check 七面无 drift。
  - **基线**：admin-api 2385 · mcp-server 108 · acf-cli 93 · admin-web 659 · docs-site build+sync-check 绿。develop 领先 origin 8 commit（五轮产物，待用户决定 push 时机）。
  - **下轮建议**：① v1.3.0 发布轮（本仓 8 commit + 上轮 5 commit 已含 AUTH-04/R17~R19 全部，走 develop→main 验证 github-release step 自动化）；② 生产形态真机（QA-05 24h、BUG-07、DSK-01）；③ 拓展候选：SSO 组→角色映射（ADR-014 边界注记）、SDK 消费 /projects 读面。
- **本轮（2026-09-13 第十六轮：AUTH-04 OIDC SSO 全栈，主会话直落；子代理平台仍故障，轻量试探后继续降级直落）**：
  - **`584b45e` AUTH-04 done（认领板最后一个可本地开发项，企业拓展大件）**：OIDC 授权码模式（confidential client，server-side code exchange）。① 无状态 state：state+nonce 打包 HMAC-SHA256（密钥复用 JWT_REFRESH_SECRET）放 HttpOnly SameSite=Lax cookie（10min、Path 收窄 callback），多实例无共享会话依赖，callback 双向比对 query/cookie state，timingSafeEqual 常时比较；② ID Token 验签：RS256 + JWKS（node:crypto 零新依赖），iss（尾斜杠归一）/aud/exp（±60s）/iat（拒未来）/nonce 全量校验，alg 白名单防 alg=none/HS256 混淆；③ 身份绑定三级（ADR-014 核心裁定）：oidcSub 精确（迁移 1790000000016 可空+唯一部分索引，存量零回填）→ username 首登绑定（已绑其他 sub 拒绝不静默换绑）→ JIT 建号（OIDC_AUTO_PROVISION 默认 false 保守；true 时 USER 角色+随机占位密码不走密码面）；④ token 经 URL #fragment 回传（不进服务器/代理日志），前端落地页即抹 history；⑤ 出站走 assertSafeHttpUrl + OIDC_ALLOW_PRIVATE_NETWORK 豁免（内网 Keycloak 场景，云元数据恒拒）。前端：登录页 SSO 按钮（status 开关驱动）+ SsoCompletePage（fragment 解析/StrictMode 幂等消费/错误指引）+ zh/en 各 10 key。**测试**：service spec 17（真 RS256 签发验签矩阵/state HMAC 篡改过期/绑定三级矩阵）+ controller spec 7 + SsoCompletePage 4；**真机自检 `npm run test:oidc-sso` 13/13**（内置 loopback mock IdP：discovery/JWKS/authorize/token 四端点 RS256 真签真验 + 真实 admin-api 全流程：status→login 302+cookie→回调发令牌→令牌实访 /auth/profile→二次登录 sub 稳定绑定→code 重放拒→state 篡改拒→JIT 建号恰一行）。踩坑记录：① node:crypto 的 KeyObject.export 需直接在 public KeyObject 上调（createPublicKey(publicKey) 在 Node 24/jest 下报 ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE）；② crypto.sign oneshot 形态是 `sign(alg, data, keyObject)`，传字符串 outputEncoding 报 callback 类型错；③ selftest 首版 signIdToken 丢了 input 拼接只发签名段，被 service 验签「malformed」拒绝——真机套件反向抓住自检脚本自身缺陷（修后 13/13）。
  - **基线与状态**：admin-api **2378/2378**（2354→+24 OIDC）· tsc/eslint 0 error · admin-web **659/659**（+8：sso 4 + 既有 mock 补齐后回归）· build/lint 绿 · openapi/api-types 已重导出（oidc 端点 3 处）· 迁移 check **61 项绿（下一号 1790000000017）**。**认领板清至仅剩环境依赖项**：BUG-04（上游 minio）/BUG-07（Windows）/DSK-01（macOS）。
  - **下轮建议**：① 生产形态真机轮（QA-05 24h 长稳、BUG-07、DSK-01）；② release-please merged-PR 检测排查（可试 squash 合并或升级 action 版本，解则发布全自动）；③ 拓展候选：通知渠道私网豁免开关同款扩展（deployment.md 已注记）、MCP/CLI 消费 /projects 新读面、SSO 组→角色映射（ADR-014 已留边界注记）。
- **本轮（2026-09-13 第十五轮：AUTH-02 后续 + ARCH-31 双投缺陷修复 + AI loopback 修复，主会话直落；子代理平台故障「Cannot start subagent: reasoning-level-missing」降级为主会话实施，两任务均按「侦察→实施→真机验证→提交」纪律走）**：
  - **`14fc883` AUTH-02-B 项目读面过滤 + admin-web 项目管理页 done**：GET /projects 从「全员可读全量」收紧为按主体过滤（ADMIN 全量；普通用户「默认项目 ∪ 成员项目」，每行附 myRole；ADR-013 §6 追加裁定：读面过滤不触「只增放行不收紧」写面原则，且端点此前零消费方无破坏面；详情端点保持可读）；admin-web 新增 api/projects.ts + ProjectsPage（列表/我的角色徽标/成员管理 Drawer：ADMIN 增删改角色、普通用户只读）+ /projects 路由 + 系统分组菜单 + zh/en 各 21 key；controller 读面矩阵 +4、ProjectsPage 组件 4 例；openapi/api-types 实测零漂移（该端点历史无 swagger response schema；DTO 视图行对齐 DEP-01 AppReleaseRow 接口先例）。
  - **`e4bed26` ARCH-31 重复投递边界端到端闭环 + 生产级缺陷修复（本轮最重要发现）**：新真机套件 `npm run test:arch31-outbox-dup`（scripts/arch31-outbox-duplication-selftest.mjs）——双真实 admin-api 共享 PG16/Redis7（空库迁移链真跑）+ loopback HTTP 接收端 + 5 个派发失败终态执行（无执行器 → BUG-21 修复后发 execution.failed），断言每订阅恰 N 条 / 签名头齐备 / ≥2 个补投周期（OUTBOX_SCAN_INTERVAL_MS=5s）零重复 / outbox 全部结清。**首跑实证每订阅收 10 条（期望 5）**：诊断区分「补投重复」（attempts≥2）vs「事件双发」（双行 attempts=0），outbox 10 行 + 双行同刻落库锁定后者；进一步用一次性 diag spec 启动完整 AppModule 数总线监听器（execution.failed 3 = dispatcher + notification + 多余 dispatcher），锁定根因——**`OUTBOUND_DISPATCHER_TOKEN`/`OUTBOX_DISPATCHER_TOKEN` 的 useFactory 别名让同一实例挂在同模块两个 provider wrapper 下，Nest callModuleInitHook 对每个暴露 onModuleInit 的 wrapper 各调一次 → subscribe() 双跑 → 总线监听器翻倍**（构造器仅 1 次、单模块单 provider， 常规单测装配不复现）。修复 = 两派发器 onModuleInit 幂等护栏（busListeners 非空 / scanTimer 已在即短路；OutboxDispatcher 二次 init 还会让扫描 timer 双份跑）+ 「重复 init 不重复注册」回归锁单测。修复后 **13/13 全绿**（恰一次投递、outbox 5 行、稳定窗零重复）。矩阵文档第 4 项更新为端到端闭环 + 缺陷记录。
  - **AI/Ollama loopback 真 bug 修复 + 两私网豁免开关（同 commit）**：ai.service.callOllama 默认 host `http://localhost:11434` 被 assertSafeHttpUrl（拒 loopback）拦截——README 宣称的本地 Ollama 接入开箱即坏（无测试固化该拒绝，属疏漏非取舍）。落地 `assertSafeHttpUrl(rawUrl, opts?)` 可选 `allowPrivateNetwork`（镜像 assertSafeExecutorUrl 姿态：loopback/restricted/private-LAN 放行，link-local 云元数据与 reserved **恒拒**；缺省逐字节不变）+ env `AI_ALLOW_PRIVATE_NETWORK` / `EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK`（默认 false 零行为变化；事件订阅创建/更新校验与 outbox 派发前复核共用后者——开启即信任所有登录用户可向内网发签名 webhook，.env.example/deployment.md 写明）；默认拒绝 localhost 语义由既有 ai.spec 固化保留，新增放行/元数据恒拒用例 +5。通知渠道本批不动（deployment.md 注记可同款扩展）。
  - **UI-10 拾遗核查收官（零改动）**：全量甄别 admin-web 组件/settings 的中文残留（剔除注释行后逐处核对消费方）——真实渲染级硬编码仅剩 3 处且全为「t 已注入时的防御 fallback」（FailureTopList.unknownError 组件内部已传 t('failureTop.unknown')、groupBuckets 生产路径已传 t('groupFilter.ungrouped')、SecuritySettings.deviceLabel 页内传 t），round14「UI-10 第三阶段已基本完成」的校正成立，任务关闭不再挂板。
  - **基线与状态**：admin-api **2354/2354**（2332→2354：+4 读面矩阵 +2 ai +3 safe-http +1 回归锁 −合并口径）· tsc/eslint 0 error · admin-web **655/655**（651→655）· tsc/build/lint 0 error · openapi/api-types 零漂移 · 真机套件 test:arch31-outbox-dup **13/13**（docker 全真跑）。**行为变化注意**：GET /projects 非管理员响应从全量变为过滤视图（无消费方，无破坏面）；生产部署如需本地 Ollama/内网订阅，显式开对应开关。
  - **下轮建议**：① 生产形态真机验证（QA-05 24h 长稳档、BUG-07 Windows detached、DSK-01 macOS 打包、AUTH-04 OIDC 可选）；② release-please 对「GitHub 合并提交」的 merged-PR 检测排查（v1.2.0 遗留建议①，若解则发布全自动）；③ AUTH-04 / 通知渠道私网开关按需扩展；④ 下轮发布 CHANGELOG 沿用「本轮实际变更源」句式。
- **Wiki 优化批次 II + 远端收敛（2026-09-13，orchestrator + 3 并行执行子代理）**：认领板大件清零后的 wiki 遗留方向三件（PLAN-CLAIMS「Wiki 优化批次」段）：
  - **WIKI-AUTH-REVOC 访问令牌即时撤销（b0ceb56 + dc1a262）**：users.sessionVersion（迁移 1790000000017）+ access JWT `ver` claim（generateTokens 单点签发）+ jwt.strategy 校验失配 401；bump 点=logout（revokeAllForUser）/改密（users.service.update 带 password），均原子自增；无 ver 存量令牌兼容放行（边界文档化）；jwt.strategy 每请求本就查用户故近零成本。+15 例。
  - **WIKI-LOG-S3GC S3 日志对象保留期回收（6f251c6 + 58d48d7，接手两次失联代理半成品）**：log-retention 新姊妹服务 s3-log-object-retention——非 s3 驱动 no-op；按 task_executions（s3+终态+finishedAt 早于 logRetention.days 截止）批 200×50 轮 keyset 分页，remove 后守卫清 logObjectKey；fail-open 不抛出；03:35 错峰 cron。+13 例（前任未写测试由接手代理补全）。
  - **WIKI-PKG-GUARD push-result 认证守卫化（072c022 + 764decf）**：内联 verifyExecutorToken 提升为 ExecutorSharedTokenGuard（复用 util 逐字节透传），push-result 接线守卫、download 双凭据不动。+12 例。
  - **远端收敛（合并 0aad82e + S3GC 收编 3dee66c）**：远端 develop 领先 13 commit（第十六~二十一轮：AUTH-04 OIDC SSO 全栈 584b45e、SSO 组映射、发布管道修复等，见下方远端会话条目）；共享树被中断的 `git pull` 卡在 3 文件冲突态，主控解合并——user.entity 双列并存（sessionVersion+oidcSub）、双 AGENT_HANDOFF/PLAN-CLAIMS 条目并集；**迁移撞号修复**：远端 AddUsersOidcSub@1790000000016 已随 v1.3.0 发布至 main——故维持其编号不变，重编号**本地的 WIKI-OPT-2 AddConfigHistoryMetadata 为 1790000000018**（该迁移从未发布，升级路径零孤儿记录；类名/spec/注释/认领板/atlas 同步）。S3GC 分支经 worktree 隔离验证后 fast-forward 收编，临时 worktree/分支已清理。
  - **基线（本轮收口）**：admin-api **2458/2458**（153 套件，含远端 OIDC 用例与本批 40 例）+ tsc 绿 · admin-web **659/659** + tsc -b 绿 · check-migrations 63 个唯一已注册（下一可用 1790000000019）。

- **发布（2026-09-13 v1.2.0：第十四轮 win 侧接棒的收尾发布，主会话）**：
  - **触发源**：`5e0e3b4` feat(mcp) 补齐 DEP-04 部署审批工具组——`registerDeploymentTools` 内新增 `list_pending_approvals` / `approve_deployment` / `reject_deployment` / `cancel_deployment` 4 工具（直连 `/app-deployments/approvals/pending` 与 `/app-deployments/:id/approval/{approve,reject,cancel}`，第二人规则由服务端强制），配套 vitest 用例 +9，develop/main CI 全绿。
  - **Release PR #4**：push main（`0cde512`）后 release-please 正确算出 minor **1.2.0**。**linked-versions 漂移如期复现**（第九轮记录的行为：只联动「本轮有候选发布的组件」）——两 SDK 无受管路径提交未被 bump，会在 tag 时被 version-guard 拦截 → 沿 v1.1.1 先例（`1d8752a`）在 PR 内 `76f92c0` 补齐三包 lockstep（node package.json/lock/CHANGELOG + py pyproject/`__version__`/CHANGELOG，两包 CHANGELOG 记「lockstep 版本对齐，本包无行为变更」+ manifest 三包同 1.2.0）+ **DOC-09 版本声明同步**（源头 `docs/sdk-guide.md` + 站点 6 页，1.1.1→1.2.0）。合并前本地验证：sync-check 七面绿 + guard 等价模拟 PASS。
  - **打 tag（仍走人工）**：合并 `96b4679` 后 release-please run `34705535091` 依旧 abort（"There are untagged, merged release PRs outstanding - aborting"）——`4cbdffc` 的 token 修复只解决「tag 触发 release.yml」，不解决「自动创建 tag」。沿 v1.1.1 先例：轻量 tag **v1.2.0 → `96b4679`**（PR 合并提交，树内容已含全部对齐）手动推送。
  - **Release run `34705950823` 全绿**：version-guard ✓ → 三个 publish job 成功（**本轮未出现 `environment: release` 审批等待**，v1.1.1 时需 owner 经 API `pending_deployments` 放行，如实记录）。**registry 实测**：npm `@autocodeflow/sdk@1.2.0` · npm `autocodeflow-mcp-server@1.2.0` · PyPI `autoflow-sdk 1.2.0` 均为 latest。
  - **善后**：develop 已 ff 至 `96b4679`（发布物同步，develop/main 零漂移）。发布 PR 上 `desktop-e2e-smoke`/`desktop-linux-bundle` 两红为 release PR 既有现象（PR #3 当时同款 fail、非门禁、push 事件按路径过滤不跑这两个 job）。
  - **遗留建议**：① 若要全自动打 tag，需排查 release-please 对「GitHub 合并提交」的 merged-PR 检测（可试 squash 合并或升级 action 版本）；② 下轮发布 CHANGELOG 里「本轮实际变更源」句式继续沿用即可。
- **Wiki 优化批次（2026-09-13，orchestrator + 4 并行执行子代理）**：来源=repo-wiki（基于 9b4aec6 生成的 53 篇 wiki）提取的扩展点/优化建议，逐条对照源码确认 4 项可落地缺陷/缺口，认领于 PLAN-CLAIMS「Wiki 优化批次」段：
  - **WIKI-OPT-1 健康检查硬化（bd0cb32）**：checkTasks()/checkExecutors() 补 try/catch（此前任一 reject 击穿 getFullHealth 的 Promise.all→HTTP 500）；tasks 纳入 components 聚合；队列积压/执行器在线比例阈值抽为 5 个 HEALTH_* 配置项（Joi+configuration+.env.example 三处同批）；HEALTH_CACHE_TTL_MS 短 TTL 缓存（默认 0=关闭行为不变）。health spec 12→23。
  - **WIKI-OPT-2 配置历史强化（aa3d2e0，接手失联代理半成品收尾）**：batchUpsert 事务化（repo.manager.transaction 单事务）；config_history 增 valueType/isSecret 两可空列（迁移 1790000000018，原登记 1790000000016 后因与已发布的 AUTH-04 迁移撞号重编号，分配表已登记已落盘）；rollback 对已删配置恢复历史行元数据（NULL 行回退默认值零破坏）；历史读面按行级 isSecret 掩码（防删除/取消 secret 后暴露旧值）。
  - **WIKI-OPT-3 AI cron 校验前置（dbd7ce4）**：suggestSchedule 对 AI 返回 cron 用 node-cron validate 校验，非法→warn+fallback:true，防非法 cron 落库致调度崩溃。ai spec 17→20。
  - **WIKI-OPT-4 MCP unwrap 收紧（9d0278d）**：判据收紧为「data 键 + code 为数值」（对齐 ResponseInterceptor），消除业务实体 data+message 被误解包截断的已知边界；mcp-server 105→108。
  - **验证与更正**：主控复跑 admin-api 2373/2373（148 套件，基线 2292 只增）+ tsc 0 错、mcp-server 108/108；子代理报告的 mcp tools.ts TS2589 经复验为**本地 node_modules 漂移伪红**（CI 同 lockfile typecheck 绿、本机 npm ci 后绿），仓库零缺陷。
  - **遗留（如实）**：① health.controller /health 的 Swagger example 缺 tasks 项——openapi.json 由需真实 PG/Redis 的 e2e 用例生成，本机无 docker/无栈，强改源会触发 api-types-drift 红，偏差已在 atlas health.md 注记（有栈环境跑一次 `npm run swagger:export` 即收敛）；② acf-cli client.ts 仍为宽松信封启发式（与 mcp 新判据并存，fixtures 描述已对齐）；③ wiki 中更大件扩展方向未在本批立项：访问令牌撤销黑名单/会话版本（page-16）、S3 日志对象与 DB 行保留策略对齐（page-47）、executor push-result 专用守卫（page-29）、OpenTelemetry（OBS-01 既有）。
- **此前（2026-09-12 第十三轮：多实例一致性收口 + AUTH-02 项目级角色 + 三处真实缺陷，主会话）**——完整小结见 `docs/archive/progress/progress-round13-2026-09-12.md`：
  - **ARCH-31 多实例一致性（矩阵第 5 项 🔴→🟡，代码完成 + 真机验证）**：灰度批次四条破坏路径逐条闭合——① **心跳 hydration**（非属主实例从 DB 行痕迹重建只读上下文，心跳不再被静默丢弃；无痕迹行零额外 DB 往返）② **失败 claim**（条件 UPDATE 认领在途行，只有赢家自动回滚）③ **并发批次互斥**（canary 启动前查在途灰度行 → `ok:false` + `blockedReason` 含持有者实例）④ **活性租约**（tick 刷新 `leasedAt/leasedBy`，重启 sweep 跳过租约新鲜 60s 的行——滚动重启不再误杀另一实例的灰度）。**新真机套件** `scripts/arch31-multi-instance-selftest.mjs`（`npm run test:arch31-multi-instance`）：两个真实 admin-api 进程共享同一 PG16+Redis7（空库迁移链真跑）**15/15 通过**——核心断言「A 保存渠道配置 → 刷新前 B 仍是默认值（实证改造前多实例必然失效）→ 一个读穿周期后 B 读到 A 的值」，静默跨实例 + 调度 Leader 恰一持有者同验。
  - **AUTH-02 项目级角色 done（ADR-013）**：`project_members`（迁移 1790000000015，(projectId,userId) 唯一、FK 级联、**不回填任何成员行**）+ 三档角色 viewer/editor/admin（全局 ADMIN 恒全量放行）+ 端点 `GET/POST/PATCH/DELETE /projects/:id/members` 与 `GET /projects/me/roles`（成员管理保持 ADMIN-only，避免嵌套提权链）。**只增放行不收紧**：写面 = NF-03 属主守卫 **或** 项目 ≥editor（无主存量行可由项目成员接管）；执行类写面（trigger/pause/resume 含批量）透传主体并按 **viewer 拒绝**（NF-03 遗留归属闭合）；ProjectAccessService 缺席/API-Key 主体整体旁路、查询抖动 fail-open + warn。**保留缺口**：非成员仍可 trigger（既有宽松语义，收紧属破坏性变更，ADR-013 待产品拍板）。
  - **BUG-17 nginx SSE 长流验证 done**：`scripts/nginx-sse-selftest.mjs`（`npm run test:nginx-sse`）用 `infra/nginx/default.conf` **原件**起真实 nginx 容器 + **自带探针执行器**（接受派发不回报 + 周期心跳）把执行钉在 RUNNING，**19/19 通过**——流式契约（首帧不迟滞 = 缓冲关闭的行为证据）、专用位置长流不断连 + 保活帧 ≤45s、事件穿透（回调 → 终态 winner → 领域事件 → executions/stream 帧经 nginx 到达 + 日志流 `[DONE]` 收尾）、三条 SSE 并发、长流期间普通请求 <5s、RSS 受控。24h 档（`NGINX_SOAK_SECONDS=86400`）留目标环境作为上线门禁。
  - **三处真实缺陷修复**：**BUG-21** 派发阶段失败（执行器离线/无匹配/派发超时）此前**从不发领域事件**（processor 直调通知绕过 ARCH-21 出口）→ Dashboard 终态流/FEAT-07 出站 webhook/通知订阅者三方全漏；改为终态落库成功后 `publishTerminalEventForDispatch`，通知回归订阅者统一发出。**BUG-22** 派发占坑 UPDATE 的 `.andWhere("version = :version")` 把**良性并发变硬失败**（单执行器 + worker 并发 5 → 首个占坑后其余全部 affected=0 → 抛 "No available executor" → 执行直接 FAILED）：移除冗余版本谓词（容量/在线不变量由同条 WHERE 原子保证），压测复测 **40%/65% → 100%（100/100，429=0）**，cap10 档 conflict 归零、失败主因换成真实 at capacity。**静默 CRUD 不进内存热路径**：`POST/GET/DELETE /notification/silences` 只写 DB，而 `isSilenced` 读进程内 Map → 管理台新建的静默**要等重启才生效**（单实例亦然）；create → `adoptPersistedSilence`、delete → `forgetSilence` + 删库双删。**空库多实例种子竞态**：两副本同时启动都看到 `count=0` → 都 INSERT 种子管理员 → 输家吞 23505 未捕获 → **第二个副本启动崩溃**；输家复核「已有用户」后跳过。
  - **工程陷阱（顺带修掉）**：`nest build`（`deleteOutDir=true`）在带批量删除保护的环境里**静默失败（退出码 0 但 dist 未刷新）**→ 压测/e2e 脚本拿旧产物跑（现象：改了代码结果不变，本轮实测踩到）。`scripts/load-test-stack.sh` 与 `scripts/e2e-full.sh` 已追加 `npx tsc -p tsconfig.build.json` 兜底刷新产物。
  - **基线与状态**：admin-api **2332/2332**（2296→2332 只增）· tsc/eslint 0 error · admin-web 651/651 · openapi + api-types 已重导出无 drift · 真机套件 15/15 + 19/19 · 压测 100@25 容量放开档 100/100。**上轮（第二轮）已完成的渠道配置跨实例持久化**（`NotificationConfigStore` 读穿 + `notification_channel_configs` 表）本轮真机实证有效。
  - **下轮建议**：① ARCH-31 剩余 outbox 行级 claim（`FOR UPDATE SKIP LOCKED`）+ 真机清单第 3 项（心跳落非属主实例的真实灰度推进，需执行器 + 可达 git 源）；② QA-05/BUG-19 四档目标验收（500 并发/1000 RPM/SSE 500/回调 10k）+ 服务端 Prometheus 水位 + 白皮书定稿；③ 版本发布（v1.2.0 lockstep，需推送 develop→main + release-please Release PR）；④ AUTH-02 后续（项目列表按成员过滤读面、admin-web 权限门控 UI）；⑤ 需真机/外部条件项：DSK-01 macOS 打包、BUG-07 Windows detached 信号、BUG-17 24h 档、AUTH-04 OIDC（可选）。
- **此前（2026-09-12 第十二轮：UI-10 全站 i18n 第二阶段——壳层+核心工作流 6 页，主会话）**：
  - **UI-10 第二阶段 done（6 commit，claimed 持续）**：在上一阶段 i18n 基础设施+LoginPage 示范之上，迁移**壳层 + 核心工作流页**共 6 页/约 260 key——① **MainLayout 壳层（b3a7ff4）**：导航六大分组/面包屑路由名/主题三态按钮（含 aria 动态态描述）/用户菜单/全部 aria-label 与 tooltip（skip-link/主导航/logo/侧栏折叠/移动抽屉/搜索/帮助/通知）走 key，菜单改 buildMenuItems(t) 组件内构造（语言切换即时生效），主题 tooltip 用 {{label}} 插值；② **Dashboard（58f1d53）**：KPI 四卡/成功率/平均耗时/趋势档位/执行器资源/调度延迟/失败榜/最近失败全走 key；streamStatusBadge 改为返回 labelKey 由调用侧 t() 渲染；趋势 Legend formatter 走 i18n（dataKey 保持稳定中文键匹配数据）；③ **TaskList（ef282a2）**：STATUS_CONFIG/TRIGGER_LABEL 改接收 t 的工厂，列/筛选/批量操作条/触发弹窗（含 Trans 强标签 + {{count}}/{{name}} 插值）/空态/分页全迁；④ **Executions（11315f4）**：STATUS_MAP 工厂化，列/状态映射/对比按钮（{{max}}）/kill 确认/空态全迁；⑤ **ExecutorList（4df37c2）**：heartbeatLabel 工厂化（{{min}}），上线/离线通知插值，列/状态/资源条（idx 映射 CPU/内存/磁盘）/心跳/死信 tooltip/快速添加 Modal 全迁。**每页迁移默认 zh 渲染逐字不变 + 相关套件逐批验证**；i18n-infra 的「zh/en key 集合一致」测试自动守卫漏翻。**admin-web 651/651 全绿 + tsc/build/lint 0 error（本机逐批+收尾全量复跑）**。
  - **基线与状态**：admin-web 651/651 · e2e-full 44/44 · executor-python 247/247 · 其余基线同第十一轮（admin-api 2263/mcp 100/node-sdk 63/py-sdk 111/registry-pypi 68/executor-node 273/acf-cli 89 · desktop e2e 3/3）。
  - **下轮建议**：① **UI-10 第三阶段**（全站剩余约 52 文件/5000+ 硬编码中文：form 密集页 ApplicationList/TaskForm/ExecutionDetail/TaskDetail/ApplicationDetail、执行器详情/安装/包、settings 三 Tab/通知/审计/用户、Registry/CommandPalette 及公共组件——按「每批多页+全量验证」持续推进，越晚越贵）；② **AUTH-02**（C 类项目级角色细化，需产品拍板角色模型）；③ **QA-05 四档容量目标 + 服务端水位**（生产形态，留部署轮）；④ **BUG-07/DSK-01/P0-2 生产留验项**（B 类需特定环境）；⑤ **AUTH-04**（OIDC SSO 可选）。
- **上轮（2026-09-11 第十一轮：P0-2/DSK-05/DOC-08/UI-10 四连闭环，主会话）**：
  - **P0-2 done（5e58c12）**：DEP-04 审批正向闭环——e2e 新增用例 36（第二人 approve → 201+approved+actedByName 记录 → 30s 内部署行离开 pending 进入 push 链），补上旧 30~35 全失败路径的正向锚；full e2e **44/44 绿**；VERIFY 文档 docs/archive/verifies/verify-round11-dep04-approval.md。
  - **DOC-08 done（f1a4b67）**：windows-findings 长尾逐项终态核对（文档追加清偿段）——W-03/W-05 测试平台化本机复核 executor-python 247/247 0 skip、executor-node 273/273；W-08 requirements-dev.txt 实证；W-09B loop 噪音 QA-11 已修；W-07/12/13/20/22/24~26/27/28 均 P-批修复在位。**留产品决策 2 项（非缺陷）**：W-10（GBK 解码体验级）、W-06（flaky 观察，复跑全绿）。
  - **DSK-05 done（335748f）**：ARM64 镜像矩阵本机核验——装 buildx 0.17.1 + QEMU binfmt（qemu-aarch64），docker-container builder（--platform linux/amd64,linux/arm64）下 admin-api / executor-node / executor-python **三镜像双架构构建全部通过**（CI docker-multiarch-build 同款形态）；Dockerfile 全 alpine/slim 无 native 依赖；非 root adduser 与 uv venv 探针 arm64 路径实际执行。deployment.md 补核验记录。ARM 真机运行冒烟留部署轮。
  - **UI-10 第一阶段 done（e853ef6，claimed 持续）**：i18n 基础设施（i18next@23+react-i18next@15；src/i18n/index.ts 单一实例，lng=localStorage 显式切换>默认 zh——产品基线一致性，测试环境 navigator=en-US 不误切；fallback zh 防裸 key）+ src/locales/{zh,en}.ts 双语字典 + **LoginPage 全量示范页迁移**（文案/aria/校验消息全走 key）+ i18n 专项测试 5 例（key 集合一致防漏翻/默认 zh/切换/setLanguage 生效/fallback）。admin-web **651/651** + tsc/build/lint 0 error。**剩余**：19 页约 63+ 硬编码中文逐页迁移（越晚越贵）。
  - **基线与状态**：e2e-full 44/44 · admin-web 651/651（+5 i18n）· executor-python 247/247 · 其余基线同第十轮（admin-api 2263/mcp 100/node-sdk 63/py-sdk 111/registry-pypi 68/executor-node 273/acf-cli 89）。
  - **下轮建议**：① **UI-10 全站逐页迁移**（基础设施已就绪，逐页搬 key 即可，越晚越贵——建议下一轮主攻）；② **AUTH-02**（C 类项目级角色细化，需产品拍板角色模型）；③ **QA-05 四档容量目标 + 服务端水位**（生产形态，留部署轮）；④ **BUG-07/DSK-01/P0-2 生产留验项**（B 类需特定环境）；⑤ **AUTH-04**（OIDC SSO 可选）。
- **上轮（2026-09-11 第十轮：全量接管 + 本机闭环 9 项 + QA-12/QA-05 实跑，主会话）**：
  - **接管声明（29f87eb）**：用户确认「无其他 agent 在干」→ 主会话接管控板全部未完成项，板上落 A/B/C 三层可执行性分层与执行序（A=本机可闭环 / B=需特定环境 / C=需裁定），纪律=一任务一提交 + 逐条变更日志。
  - **销账 9 项（d964e28 claims 复核）**：① **BUG-18 done**——私服链路隔离加固 + 契约自检闸 + 真机端到端全链闭环（live 42 断言 + executor 侧 12/12 + e2e 用例 44 + gitRepo 写面校验 f685d4e）；② **AUTH-01 done**——project 模块复核（CRUD 全 + 默认项目语义 + 22 例绿）；③ **ARCH-25 done**——runtime 注册表（spec 6/6）；④ **UI-13 done**——desktop renderer 抽 CSS 变量（selftest 绿）；⑤ **UI-09 done**——375px 真机走查 2/2 绿；⑥ **QA-01 done**——e2e 43/43 + 移动端走查扩列；⑦ **QA-08 done**——月度迁移演练 job；⑧ **QA-09 done**——红线清单 + 14 例 e2e（P0-1）；⑨ **NF-04 done**——affinity 前端验收（admin-web 646/646）。
  - **QA-12 done（3c6d5d3）**：desktop Electron 冒烟 `e2e/desktop-smoke.spec.js` 3 例（首启 wizard 渲染 / preload 桥 + config:get 脱敏 + 通道白名单逐元素比对 / 干净退出）+ `test:e2e` + @playwright/test devDep + CI `desktop-e2e-smoke`（windows-latest，PR/手动）。**本机 `npm run test:e2e` 3/3 绿**。可测试性小改：index.ts 支持 `ELECTRON_USER_DATA_DIR` env 覆盖 userData（e2e 隔离用户配置）；window-manager.ts renderer 路径双探测（裸 electron getAppPath===dist/main vs 打包 <app>/dist）。
  - **QA-05 实跑（36645c5 + ab4355f，claimed 不标 done）**：新 `scripts/load-test-stack.sh` 编排（PG/Redis→admin-api 空库迁移+三档限流显式放大→executor-node online→load-test 透传，SKIP_DOCKER 可复用本机栈）；本机单节点 tasks/SSE 实测。**真实发现 ①（load-test bug，已修）**：SSE 场景挂死——`ApiClient.request` 非 stream 路径在 fetch resolve（仅响应头）后 finally 拆 abort 桥，`child.abort()` 传不进 body reader，`read()` 永不返回；修复=request() 增 `stream` 选项（SSE 保留桥至读完 body），selftest 26 组无回归，修复后 4 连接 100% hold 到期。**真实发现 ②（调度语义，登记建议）**：单 executor 突发并发触发「No available executor (all at capacity or concurrency conflict)」居高——`executor.service.ts` 派发条件 UPDATE（runningTaskCount+1 + version CAS）防 TOCTOU，同一版本行并发派发仅一成功，maxRetry=0 时直落 failed；账单：20@5=75%、100@25=40%、MAX_CONCURRENT 10→40 时 100@25=65%，429 全 0。缓解方向：多执行器+亲和摊薄版本竞争 / 冲突类错误业务侧显式 maxRetry。**未完成（如实）**：500 并发/1000 RPM/SSE 500 连接/回调 10k 四档目标验收 + 服务端 Prometheus 水位 + callback 场景，留生产形态真机轮。
  - **基线与状态**：admin-web 646/646 · admin-api 2263/2263 · executor-node 273/273 · executor-python 247/247 · mcp 100/100 · node-sdk 63/63 · py-sdk 111/111 · registry-pypi 68/68 · acf-cli 89/89 · desktop test:main/renderer/e2e 全绿 · load-test selftest 26 组。
  - **下轮建议**：① AUTH-02（C 类，项目级角色细化 + NF-03 trigger/pause 写面归属，需产品拍板角色模型）；② DOC-08（windows-findings 长尾清偿，随 BUG-07 滚动）；③ QA-05 剩余四档 + 服务端水位（生产形态）；④ 大件 UI-10（i18n，越晚越贵）；⑤ 待用户动作：`RELEASE_PLEASE_TOKEN` 已配置（29f87eb ⑤-b 已办），`desktop-linux-bundle` AppImage 打包步骤 PR 上偶红（环境性非门禁）。
- **上轮（2026-09-11 第九轮：主干合并 + 1.1.1 发布 + 真机验证，主会话）**：
  - **main 恢复干净**：回退未发布的 mcp-server 1.1.1 部分发布（`5a98f10`）后 main 三红→一红；`0e461d7` **develop→main 集成合并**（45+ commit：FEAT-19-B/ARCH-25/UI-16-B 五批/NF-04/ARCH-31/UI-09/UI-12/Query 二期等），main 仅剩的 `e2e-full` 陈旧红随之消除。
  - **v1.1.1 发布完成（三包已上架 + 真机安装冒烟通过）**：
    ① release-please 产出 Release PR #3（三包 → 1.1.1）；② **发现 linked-versions 只联动「本轮有候选发布的组件」**——node-sdk 无路径内提交被跳过，会在 tag 时被 version-guard 拦（fail 安全）→ 在发布 PR 内补齐 node-sdk（package.json/lock/CHANGELOG/manifest）+ **DOC-09 版本声明同步**（源头 sdk-guide + 站点 6 页，1.1.0→1.1.1）；③ 合并 `ee3f0c8` → release-please 打 **tag v1.1.1**；④ `release.yml` run 34576901825：**version-guard success** → `environment: release` 审批由主会话以仓库 owner 身份（API `pending_deployments` 批准，用户反馈「Actions 里看不到待批项」）放行 → **三包 publish 全部 success**：npm `autocodeflow-mcp-server@1.1.1`（latest）、npm `@autocodeflow/sdk@1.1.1`、PyPI `autoflow-sdk==1.1.1`；⑤ **真机安装冒烟**：`npx -y autocodeflow-mcp-server@1.1.1 --version` → **1.1.1**（恰验证本轮 VERSION 常量对齐修复）· `npm i @autocodeflow/sdk@1.1.1` + require 导出正常 · 真实 PyPI `pip install autoflow-sdk==1.1.1` → `__version__=1.1.1`。
  - **修复「tag 不级联」根因（`4cbdffc`）**：实测证伪 workflow 注释里的假设——GitHub 抑制所有由 `GITHUB_TOKEN` 产生的事件（含 `on:push:tags`），故 release-please 默认 token 打的 tag **不触发** release.yml（现象：tag 已生成、Release 流水线零 run）。改为 `token: ${{ secrets.RELEASE_PLEASE_TOKEN || github.token }}`（未配 secret 行为不回归），并在 development.md / sdk-guide.md / docs-site release.md 写明：**需在仓库配 secret `RELEASE_PLEASE_TOKEN`**（fine-grained PAT：Contents R/W + Pull requests R/W）才能全自动；本轮的恢复路径是以人工凭据重推同名 tag（内容不变、未发布任何产物，安全）。
  - **真机验证（本 ubuntu，用户授权）**：
    · **BUG-18 私服 live 自检 42 断言 / 0 跳过 / 0 清理失败**——真实 Verdaccio 容器（npm publish/install、未认证拒绝、重复版本拒绝、token 不泄漏）+ 真实 uvicorn PyPI fixture（认证上传、PEP 503 索引、幂等重传、篡改重复拒绝、pip 消费私服包）。脚本自陈未覆盖：真实 admin-api/executor compose 派发链路。
    · **全链 e2e 43/43 通过（1.7m）**——真实 PostgreSQL 16 + Redis 7 + admin-api(:3105) + executor-node(:8002) + admin-web vite(:5176) + 真实 chromium（`bash scripts/e2e-full.sh`，含例 23/24，此前 CI 上曾挂跟踪）。
    · desktop 主进程自检本机全绿；PR 上 `desktop-linux-bundle` 唯一红在 `Build AppImage + deb (x64)` 打包步骤（环境性，非版本 bump 引入，且该 job 仅在 PR 事件跑、不进 main 门禁）。
  - **BUG-18 真机补证第二阶段（executor 侧派发自检，12/12 绿）**：新增 `scripts/bug18-private-registry-dispatch-selftest.mjs`（根 `npm run test:private-registry:dispatch`）——起真实 `executor-node` 进程（`dist/main.js`，`NPM_REGISTRY_URL/TOKEN` 指向临时 Verdaccio），`POST /api/execute` 一个 `requirements` 指向私服的节点任务，断言：依赖确实由 executor 装进 `<workDir>/.node_modules/<taskId>/node_modules` + lock 记录私服地址（证明来源）、**执行目录与依赖目录均无 .npmrc / _authToken 痕迹**、临时 npm 配置目录用后即删、进程输出无 token 泄漏；派发失败时相关断言显式 skip（不空过）。仍需 admin-api + DB 才能覆盖的「任务经平台创建→派发」链路如实标注为未覆盖。**踩坑记录**：executor 经 dotenvx 注入 `.env`（注入优先于 spawn env，故无法用 env 关鉴权）→ 脚本按 config 同序读 `EXECUTOR_SHARED_TOKEN || EXECUTOR_SECRET` 作调用凭据；依赖目录按 `task.id` 归并（非 executionId）。
  - **UI-12 收口（`40021f0`）**：第一阶段唯一缩水项 **TaskFormPage 无障碍补齐**——五分区 `role="region"` + aria-label（读屏可按区跳转）、锚点条 div→`nav` 具名、新增 `role="status"`+`aria-live` 校验失败播报（antd 只在字段旁标红、读屏不主动播报；补首条错误 + 待修正项数摘要）；+3 例。**admin-web 646/646**（基线 643 只增）· tsc 绿 · lint 0 error。
  - **基线与状态**：四源版本 1.1.1 · sync-check 七面绿 · admin-web 646/646 · mcp 100/100 · node-sdk 63/63 · py-sdk 111/111 · registry-pypi 68/68 · executor-node 273/273 · executor-python 247/247 · admin-api 2263/2263 · acf-cli 89/89。
  - **仍需用户动作（非阻塞）**：① 配置仓库 secret **`RELEASE_PLEASE_TOKEN`**（fine-grained PAT：Contents R/W + Pull requests R/W）→ 下轮发布即可全自动（本轮因 GITHUB_TOKEN 不级联、由人工重推 tag 触发）；② `desktop-linux-bundle` 的 `Build AppImage + deb` 步骤在 PR 上偶红（环境性、非门禁），如关注可单独排查。
- **上轮（2026-09-11 第八轮：在途三组产物收口 + UI-16-B 两批 + 私服链路加固，主会话）**：
  - **在途三组产物逐组验收入库（零丢失，3 组 5 commit）**：工作区遗留 22 文件按任务切三组——① `4e3a0f8` **UI-12 无障碍第一阶段**（接手 006 在途半成品；MainLayout/CommandPalette/LoginPage + 新 styles/a11y-focus.css + 22 例）；② `f4bfa04` **UI-16-B 第三批**（ExecutorPackagesPage 错误态 + loadSeq 竞态守卫 + 4 例）；③ `f68c715`+`124980d` **BUG-18 私服加固 + 契约自检闸**（详见下）。**方法注记**：接手前先 `git status --short` + `git diff --cached --stat` 双查（上轮有索引误带前科），提交时按路径精确 add 分三组；每组先跑该子项目套件再提交。
  - **UI-12 无障碍第一阶段 done（4e3a0f8）**：MainLayout（#main-content landmark + skip-link 落点、用户菜单 div→button 并给 aria-haspopup/aria-expanded、移动端遮罩裸 div→button 键盘可收起、头部图标按钮 aria-label）+ CommandPalette（dialog 可访问名 aria-labelledby、combobox↔listbox 的 aria-controls/aria-activedescendant 让 ↑↓ 高亮可播报、关闭后焦点归还宿主）+ LoginPage（标题↔Form aria-labelledby 关联、登录/动态码失败改页内 role=alert 常驻块并接管焦点，替代瞬时 toast）+ 独立 a11y-focus.css（:focus-visible 统一焦点环，作用域 .autoflow-layout 不污染登录页）。测试 +22（a11y-focus 14 + a11y-login-page 8，手写断言零新增依赖）。**缩水如实**：TaskFormPage 焦点/aria 未覆盖（长期避让的在途三方冲突文件）；axe/读屏真机扫描留真机轮。
  - **UI-16-B 第三/四批 done（f4bfa04 + d9039dd）**：第三批 ExecutorPackagesPage（listPackages 失败 → StateError；loadSeq 竞态守卫保证快速重入/卸载时只最新请求可写状态）+ 4 例；第四批补 3 个 P2 页——**NotificationSettingsPage**（渠道列表失败且无缓存 → StateError，替代 Card loading 后空白；静默规则列表失败 → StateError 不落「暂无静默规则」）、**settings/index**（执行器 Token / 系统配置 / 变更历史 / AI 配置四处读请求失败各接 StateError+重试，此前为永久 Spin / 空表 / 空白 Modal / 永久 Spin）、**DashboardPage**（summary/trend/executors/failures 任一失败 → 整页 StateError + 四路 refetch，不再以骨架/空数字掩盖失败）+ 5 例（`ui16-batch4-error-state.test.tsx`）。UI-16-B 累计 9 页；第五批 `cfe7e0f` 收尾剩余 4 页——settings 三 Tab（ApiKeysSettings 列表 / EventSubscriptionsSettings 订阅+死信两路 / SecuritySettings 会话卡）+ ExecutorInstallWizardPage（listLatest 由「仅 toast」改为 packagesError 页内 StateError + loadPackages 可重试，此前失败后步骤二选择器静默为空），4 例。**UI-16 权威盘点 13 页真实缺口至此清零（五批 13 页）**，admin-web 643/643。统一约定：只覆盖读请求失败，写操作继续 toast（UI-15）。
  - **BUG-18 私服链路加固 + 契约自检闸（f68c715 + 124980d，状态 in_progress）**：① executor-node 凭据不再落任务树——.npmrc/.npm-globalrc 迁至 `mkdtemp` 临时目录（目录 0700/文件 0600），经 `npm_config_userconfig/globalconfig` 显式指向，npm 子进程 close 后 finally 删除、清理失败上抛（绝不静默留凭据）；带 token 安装保持 `--ignore-scripts`。② executor-python：uv 固定 0.8.17（requirements + Dockerfile 构建期 `uv venv --no-project` 实测校验，非 root HOME/UV_CACHE_DIR 显式化）；`PYPI_REGISTRY_URL` 双闸校验（config 启动期 + ensure_venv 使用期，仅 http(s)、禁 userinfo/query/fragment、`hide_input_in_errors` 防凭据回显）；uv/pip 子进程改最小环境白名单（`UV_NO_CONFIG=1`、`PIP_CONFIG_FILE=os.devnull`、独立 UV_CACHE_DIR，剥离 PIP_*/UV_*/PYTHONPATH 与执行器凭据）。③ 新 `scripts/bug18-private-registry-selftest.mjs`：22 项源码契约断言 + 可选 live 模式（临时 loopback PyPI uvicorn / 一次性 Verdaccio 容器，finally 全清理 + 输出脱敏，永不触碰仓库 compose 卷）；根 `test:private-registry[:live]`；CI 新增 `private-registry-contract` job（--dry-run，零依赖）。④ **desktop bundle 同 commit 重打**（`resources/executor-node/index.js`——上轮教训：executor-node src 改动必须同批重打，否则 desktop-bundle-drift 红）。**未完成（如实）**：真实 admin-api/executor compose 派发 + 生产凭据回环未跑，故 claims 标 in_progress 不标 done。
  - **CI 首跑与修复（run 34568599731）**：39 job 成功（含新 `private-registry-contract`）、2 skipped（desktop-linux-bundle / e2e-full-windows 条件跳过）、1 红=**windows-node-tests (executor-node)**——新用例把 cwd 写死 `/tmp/test-workdir/...`，Windows 上 `path.join` 产出 `\tmp\test-workdir\...` 故 2 例失败。修复（`124980d`）= 断言改 `path.join(testConfig.workDir, …)`（与路由侧 `path.join(config.workDir, executionId)` 同口径）、「userconfig 不在任务目录」改与 `opts.cwd` 比对。**Windows CI 再次直接产生收益**（第 N 次：跨平台断言必须平台无关）。
  - **基线（本轮收口）**：admin-web **643/643**（72 文件，基线 605，+38）· executor-node **273/273** · executor-python **247/247** · 私服契约自检 22/22 · 双端 tsc 绿 · lint 0 error / 21 既有 warning。
  - **release 基础设施修复（main 三红 → 一红）**：会话中途发现 release-please PR #2 已被合并（`6b9cfd5`，非本会话操作），main 随即三红。**根因**：该 PR 只 bump 了 `packages/mcp-server` 1.1.0→1.1.1 的 package.json/package-lock/manifest/CHANGELOG，未同步 `src/index.ts` 的 `VERSION` 常量、也未 bump 另两包 → ① mcp-server-test / windows-node-tests 的「VERSION stays in sync with package.json」红；② docs-site-build + Deploy Docs Site 的 DOC-09 lockstep 一致性强校验红。即 **release-please 配置未固化 DOC-05 的 lockstep 裁定**（缺 `linked-versions` 插件，单包 fix commit 即可产出「部分发布」），叠加硬编码版本常量未登记 `extra-files`（DOC-05 记录的首跑观察点成真）。**处置**：develop `e67750e` + main `5a98f10`——① `release-please-config.json` 增 `linked-versions`（三包同组同步 bump）；② mcp-server `src/index.ts` 两处 + `autoflow_sdk/__init__.py` 的 `__version__` 加 `x-release-please-version` 注解并登记 extra-files；③ 核实 npm（`autocodeflow-mcp-server` 最新 1.1.0）/PyPI（`autoflow-sdk` 最新 1.1.0）/GitHub Releases 均无 1.1.1 产物 → 版本从未发布，故 `git revert 8a65fe1` 恢复一致 1.1.0。**结果**：Deploy Docs Site（main）转绿 · develop CI 全绿（含 43 例 e2e）· main CI 仅剩 `e2e-full`。
  - **main 残余红的定性（如实）**：main `e2e-full` 在修复前的上一次 main run（34437791288）即已红，且 main 落后 develop 45+ commit（缺 FEAT-19-B/ARCH-25/UI-16-B/Query 二期/NF-04/ARCH-31/UI-09/UI-12 等）→ 判定为**主干陈旧**，正解是 develop→main 合并（发布动作）。
  - **下轮建议**：① **develop→main 合并**（main 落后 45+ commit，合并后 e2e-full 应随 develop 修复转绿；会触发 release-please 新 PR → v* tag → release.yml 三包发布，需 environment 审批与 NPM_TOKEN/PYPI_API_TOKEN；发布后务必同步站点/sdk-guide 版本声明（DOC-09 七面机检会卡））；② UI-09 真实 375px 浏览器验收；③ QA-05/BUG-18/ARCH-31 真机与真 PostgreSQL 验证；④ e2e 例 23/24（QA-01）；⑤ AUTH-02（依赖 AUTH-01 拍板）。
- **上轮（2026-09-11 第七轮：在途产物收口 + 三项新交付，主会话）**：
  - **在途 44 文件分组入库（第六轮子代理遗留，零丢失）**：按任务切成 7 个干净 commit——① `fe1badb` QA-05 压测脚本场景化改造 + 容量边界白皮书（load-test 重写为可编排场景，selftest 26 组过）；② `c01f477` ARCH-31 outbox DB lease/row claim + 矩阵文档同步；③ `710fbbc` UI-13 desktop renderer 抽 CSS 变量 + 新增 renderer.selftest.mjs（根 `test:desktop` 串联）；④ `204e78b` NF-04 亲和约束在模板预填/抽取链路闭环；⑤ `7787821` Query 推广第二阶段——api 层统一 AbortSignal + `tasksApi.listAll` 分页聚合（pageSize 上限 100、并发窗口 6、响应一致性校验、取消后不启下一窗口）+ 四页换装；⑥ `bacd209` UI-09 页头超长任务名溢出与窄屏工具条换行；⑦ `421d0eb` claims/计划状态校正。分组时踩坑：**首次 `git add` + `commit` 把索引里此前已暂存的 admin-web 文件误带入 desktop commit**，已 `git reset HEAD~3` 后按路径精确重做（内容零丢失）——**提交前必须 `git status --short` 确认索引干净**。
  - **`91535cf` FEAT-19-B：outbox 终态落独立死信表（接手子代理在途半成品）**：新实体 `EventOutboxDeadLetter` + 迁移 `1790000000013`（outboxId 唯一 + FK ON DELETE CASCADE）；终态路径事务化——事务内先写死信、再条件 finalize（leaseToken/leaseUntil 守卫），`affected≠1` 抛 `StaleOutboxOwnerError` 整体回滚，源行保持可重试；outbound 派发器 `parkDeadLetter` 返回持久化结果并聚合 `deadLetterPersistenceFailures`，outbox **死信未可靠落库时绝不回写 dispatchedAt**（否则订阅死信 API 查不到 = 事件永久丢失）。迁移结构 spec 5 例 + outbox 用例同步；`docs/PLAN-CLAIMS.md` 分配表已登记 1790000000013（check-migrations 58 项过）。
  - **`cc68083` ARCH-25：任务 runtime 注册表**：新 `modules/runtime`（types 协议 / builtin-runtimes 三项 / registry service / @Global module），app.module 接入（唯一改动点）；`TaskRuntime` 枚举与 DTO `@IsEnum` **零变更** → 零迁移、零 openapi 影响；注册表为描述层（未知 runtime `get()` 返回 null，fail-open；重复注册须显式 override）；6 例单测含「枚举值 ↔ 注册表键」一致性与 deno 示例注册；`docs/development.md` 增「任务 runtime 注册表」节。
  - **`bc7dd1d` UI-16-B 第一批：页内错误态补齐**：盘点 19 个 page 文件，发现 UI-16 行标 done 属信息滞后（仅覆盖 audit + Registry 两页），仍有 10+ 页 toast-only；本批补 **TaskListPage**（query error → StateError + 重试 refetch）与 **AppDeploymentPage**（fetchAll 失败置 loadError → StateError；失败态不再叠加「该应用尚未部署」空态），新增 `ui16-state-error` 5 例行为断言。缩水如实：写操作失败仍走 toast、首屏 PageSkeleton 归 UI-08 遗留；剩余页清单已写入 claims（TaskDetail/NotificationSettings/UserManagement/ExecutorPackages/ApplicationList/TaskForm(在途避让)/ExecutorInstallWizard/Executions/Login）。
  - **事故与纪律**：子代理（code-explorer 侦察岗）**越权实时写代码**，致 `outbox-dispatcher.service.ts` 缺 import、4 个 jest 套件编译红；已广播 + 定向制止、shutdown 违规成员、主会话接手补全。**教训：子代理即「只读」也必须显式禁止写入，并在广播后核查文件 mtime**；另 `task-form-ui06` 一条用例在全量并发下 5s 窗超时（单跑绿），按既有纪律显式放宽至 15s（断言不变）。
  - **基线（本轮收尾）**：admin-api **2253/2253**（上一轮 2193 起，含 +54 在途 +6 本轮新例）· admin-web **605/605** + `tsc -b` 绿 · check-migrations 58 项绿 · desktop renderer selftest / load-test selftest / demo-seed selftest 全过。
  - **`89108cf` FEAT-19-B 收尾（接手子代理最后一批微调）**：outbox 行「已 settled」判定把 `persistenceFailures === 0` 提升为前置必要条件（原与 `targetCount` 并列，死信持久化失败时仍可能被判为已投递）；实体/派发器/迁移注释统一到 `event_outbox_dead_letters` + 迁移 `1790000000013`；admin-api **2263/2263**（141 套件）。
  - **UI-16-B 第二批（b81172a）**：ExecutionsPage / ExecutorListPage / UserManagementPage 三页补页内错误态（解构 query 的 `error`+`refetch`，标题各自标注数据块），用例扩至 8 例。权威盘点来自 scout-002 对 24 个 page 文件的全量核查：UI-16 真实缺口 13 页，本轮已补 5 页，剩余 8 页（NotificationSettings / Dashboard / settings×4 / Wizard / ApiKeys / EventSubscriptions / Security）留后续批，清单已写入 claims。踩坑：`ExecutorListPage` 的错误块若塞进「卡片视图/表格视图」三元分支内会因「三元每支单根元素」触发 JSX 语法错 → 错误块必须与三元并列。
  - **在途（下轮接手先看这里）**：**UI-12 无障碍第一阶段由 scout-002 异步实施中**，限定足迹=`apps/admin-web/src/layouts/MainLayout.tsx`、`src/components/CommandPalette.tsx`、新增 `src/__tests__/a11y-focus.test.tsx`（零新增依赖、手写行为断言）。接手时先 `git status` + 跑 `cd apps/admin-web && npx vitest run src/__tests__/a11y-focus.test.tsx` 与 `npx tsc -b` 验收，再登记 claims（UI-12 行现为 claimed/006，需改 Owner 与 hash）。若工作区只剩这两个文件改动而测试文件缺失，说明子代理中断，需补齐测试后入库。
  - **下轮建议**：① UI-16-B 第二批（TaskDetail/NotificationSettings/UserManagement/ExecutorPackages，避让在途页）；② UI-09 真实 375px 浏览器验收（半场未销账）；③ QA-05 真实容量验收（脚本与白皮书已就绪，缺真实压测数据）；④ AUTH-02（依赖 AUTH-01 拍板）；⑤ e2e 例 23/24（QA-01）。
- **本轮（2026-09-10 第四轮 Wave2：三路子代理 + ECO-04 发布演练，主会话）**：
  - **api-types-drift 二次复发修复（61abdfa）**：NF-04（7494289）把 executorAffinityTags/executorAntiAffinityTags 加入 `CreateTaskDto`，却未重跑 canonical 导出器（test/openapi-export.e2e-spec.ts）与 admin-web `gen:api-types`，致 openapi.json 落后源码 → drift job 又红（与上轮双写方根因同源，教训=改 DTO 必重导出）。修复=经 Jest 导出路径（唯一写入方）重导出 openapi.json（+14 行两字段）+ gen:api-types 同步生成物（+4 行）；**二次导出幂等验证通过**（无二次漂移）。push 后 CI run **34493150403 全 48 jobs 绿，0 失败**——**develop 近期首次整轮绿**。PLAN-CLAIMS NF-04 行已补 61abdfa + 协作注记。
  - **CI 修复链（develop push 连红根治）：api-types-drift 双红根因=openapi.json 双写入方（Jest e2e spec vs ts-node 脚本）md5 不一致——裁定 Jest 路径为 canonical writer，swagger:export 委托 e2e spec（a47e395）；nest build rootDir 回归（scripts/ 目录入编译面致 dist/src/main.js）→ tsconfig.build.json 排除（同 commit）；chromium 安装 flake（runner 自带 google-chrome apt 源 Hash Sum mismatch，deb822 格式 .sources 文件）→ 安装前禁源（63903ff+ab18c8c）；e2e 例 4/8/9/10 ReferenceError: API is not defined（page.evaluate 回调浏览器侧无 Node 作用域 API）→ addInitScript 注入 window.__E2E_API__ + evaluate 内 18 处改引用（a32486f+09b9506）；红线例 32/33/34/35/38/39 契约对齐（POST 默认 201 非 200/pending-inbox 是 GET/webhook @Public DTO 先行 400+签名缺失统一 401/订阅建读是登录面非 ADMIN 面/死信重放陌生 id 404 防枚举）（ede0093..067812a）。**e2e-full 现仅剩例 23/24**（UI-06 后 executorId 残留清理回归，QA-01 挂跟踪待真机复现）。
  - **Wave2 三路子代理交付**：001=FEAT-16（GET /executions/stream SSE+useExecutionsStream+ExecutionsPage 事件驱动）+FEAT-17（queries.ts 扩 11 hooks 八面换装，保留面如实声明）；003=UI-09 旧半场（三页表格响应式+MainLayout off-canvas 抽屉+8 例，3351eb9）；002=P0-3（docs-site GitHub Pages 发布管道+base 路径）+DOC-09（sync-check 七面机检+selftest 14/14，存量 4 项 drift 人工裁定同步）。当前工作区另有 UI-09 Dashboard/ExecutionDetail 移动适配代码与测试，但真实 375px 浏览器验收尚未完成，不能据此销账。3351eb9+0826b5d。
  - **ECO-04 v1.1.0 发布演练全链 done**：develop→main 大合并（414 commit 零冲突）→ release-please 首跑 Release PR #1（三包 lockstep 1.0.1→1.1.0）→ 合并 → tag 重推触发 release.yml → **waiting=environment release 审批闸门（需用户在 Actions UI 批准）**。运维注记：Actions 权限已开（write+PR approve）；Pages 已 API 启用；**docs-site 已上线 https://luludeer.github.io/AutoCodeFlow/**（1.1.0）；lockfile name 债登记（node-sdk lock 内部旧名 @autoflow/sdk，publish 不受影响）。
  - **基线**：admin-api **2193/2193** · admin-web **554/554** · docs-site build+sync-check 七面绿 · e2e-full 41/43（23/24 挂跟踪）。
  - **待用户动作**：①GitHub Actions UI 批准 release environment（v1.1.0 三包发布）；②Settings→Pages 已 API 代启（无需动作）。
  - **2a85b13 销账后 CI 补记（QEMU 抖动）**：2a85b13 为 docs-only（仅 AGENT_HANDOFF.md + docs/PLAN-CLAIMS.md，apps/executor-node 零改动），push 触发 CI run **34494055815** 时 docker-multiarch-build (executor-node) 在 build-push-action（linux/amd64,linux/arm64）步骤卡死 >13min（基线该 job ~2min，同 run 前一次全绿 run 34493150403 同 job 15:03:43→15:05:39），判定为 infra 抖动非代码问题（构建输入与 61abdfa 全绿态逐字节一致）。处置：cancel 该 run → `gh run rerun --failed` 重跑该 job（新 job 102954957370）→ 16:26:00→16:28:05 成功 2min05s。**run 34494055815 现全绿。**
  - **ARCH-31 多实例兼容矩阵 documented/blocked（盘点轮；outbox lease/dead-letter follow-up 已落地）**：`docs/ARCH-MULTI-INSTANCE-MATRIX.md` 已完成 15 项进程内单例状态矩阵、风险分级（🟢/🟡/🔴）、逐项失效路径、outbox 行级 claim / silence Redis 化方案评估与真机双实例验证清单 5 条；这仅代表盘点/评估完成，不代表多实例整体实现完成。结论：调度链（Redis Leader + DB 条件 claim）已多实例安全；outbox lease/dead-letter 代码已落地（`1790000000013` `CreateEventOutboxDeadLetters` 属于 FEAT-19-B/ARCH-31 follow-up），但真实 PostgreSQL 迁移执行、多实例锁竞争/事务隔离仍 pending；🔴 高 = 通知静默/渠道配置（无持久化）/灰度批次（单写者）/本地文件系统；🟡 中 = 执行器令牌缓存逐实例 TTL、8 个未接 Leader 门禁 @Cron。未完成项按 silence（跨实例读穿/Redis 同步）、channel config（共享持久化/Redis）、rollout（批次状态与心跳跨实例协调）拆分，outbox 保留真实 PostgreSQL 双实例竞争验证；真机双实例验证留验；PLAN-CLAIMS ARCH-31 行保持 documented/blocked，勿标 done。
- **上轮（2026-09-10 NF-02 直落，主会话）**：
  - `03e23d1` **NF-02 执行编排 UI done**：TaskFormPage 上游依赖多选（纯逻辑层 task-dependencies.ts，空集显式 null 对齐 N28）+ DAG「触发整条链」按钮 + dashboard-ui04 时间炸弹测试修复（固定日期滚出 7 天窗实爆，改相对日期）；admin-web **538/538**（527 只增 +11）。
  - 缩水声明：fail-fast 失败分支策略未做（需后端新列+迁移+调度语义变更，见 claims 板备注）。
- **上轮（2026-09-09 第三轮 Wave1 验收收口，主会话）**：
  - **Wave1 四路员工子代理交付验收入库**：AUTH-01 多租户 Project 第一批（ff0e644，迁移 1790000000007~009，2137→2176 只增 +39）/ ARCH-24 读写分离（7210e3b+e5db222）/ DSK-02+03 Linux 打包+自动更新（c4a0fbc）/ ARCH-23 导出管道（1bd4d1c+00ef578）。
  - `1bd4d1c` **EventSubscriptionModule DI 解析期环根治**（AUTH-01 加模块改变 DI 求值序暴露的挂死）：两派发器改 ModuleRef 运行时懒取（构造器互注入+useFactory 别名=解析期环，@Optional 拦不住「解析中」）；同 commit 附 ARCH-23 导出脚本/e2e spec + multer/hono audit 抬升。
  - `00ef578` **ARCH-23 收口**：ci.yml api-types-drift job（重导出+重生成双 git diff 闸）+ admin-web openapi-typescript 生成入口；openapi.json（138 paths）与 api-types.ts（7052 行）生成物入库（.gitignore 反转）。
  - `53d95b3` mcp-server lockfile 同步（hono 4.13.7 override 生效）。
  - **注记**：c4a0fbc message 声称的 desktop-linux-bundle CI job 实际未随 commit 入库，00ef578 补交。
  - **基线（收口复跑）**：admin-api **2185/2185** · admin-web **527/527** · 双端 tsc 绿 · 导出两次 md5 一致（字节级幂等）。
  - **留验**：ARCH-23 drift job CI 首验；AUTH-01 Project 二批（角色细化=AUTH-02）；DSK-02 Ubuntu 真机构建；FEAT-19 outbox 补投真机外发；FEAT-19/ARCH-31 真实 PostgreSQL 双实例 lease/row claim 锁竞争与事务隔离验证；P0-2 审批双人真机。
- **上轮（2026-09-09 接手第二轮：两波 20+ 任务清偿，接手会话）**：
  - **主会话直落 4 件**：`3bbe177` ARCH-29 迁移时间戳分配表建账（47 迁移回填归属）+ `scripts/check-migrations.mjs` 撞号/漏登校验（selftest 11 例）+ CI check-migrations job + PR 检查清单改指分配表（分配规则=在盘最大+1）；`ba04183`/`9b1e59c` 两波认领登记；`d528978` QA-08 CI 月度迁移演练（schedule 每月 1 日，主套件旁路，typeorm --check 漂移检查 + revert→重跑 down 路径）；`32ee795` DOC-07 operator 升级 runbook（operations.md：前置检查/步骤判据/回滚/已知坑）。
  - **Wave1（5 路并行，9 任务 done）**：FEAT-18 KILLED 终态事件（ef55581）+ FEAT-19 webhook at-least-once outbox（迁移 1790000000003，e34b018+ab23cee，Symbol 令牌解 DI 成环）；FEAT-13 保存为模板（baa91b1）+ FEAT-14 /releases 版本追溯 Tab（2f49ea7）+ FEAT-15 事件订阅 UI（d450a36）；NF-06 MCP retry_execution/deploy_app（9e76802，侦察坐实 4 处 brief 与真实契约偏差按实落地）+ NF-07 CLI executor rotate/offline（11b349e）；SEC-NEW-3 py 补注册链（85bca38，真实现）+ QA-11 strict warnings（a2aa9f6，filterwarnings=error 不缩水，顺修 2 例 flaky）；P0-1 安全红线 e2e 14 例三 describe（7bf0e24，SSRF/RBAC/审批第二人规则，CI 首验）。FEAT-19 后续迁移 `1790000000012` lease 与 `1790000000013` `CreateEventOutboxDeadLetters`（属于 FEAT-19-B/ARCH-31 follow-up）已落盘并登记 ARCH-29；outbox lease/dead-letter 代码已落地，但真实 PostgreSQL 迁移执行、多实例锁竞争/事务隔离仍 pending；未虚构 commit hash。
  - **Wave2（5 路并行，11 任务 done）**：FEAT-20 部署 triggerType/operator 落库（迁移 1790000000004，f640832）+ NF-01 api_keys.scopes 词表 task:trigger（迁移 1790000000005，b92c39c）；UI-15 mutation 反馈一致性 19 处收口（3eec70c）+ UI-16 StateError 补齐（6019529）；SEC-09 限流三档分域（3fc5359）+ SEC-10 审计防篡改 append-only 触发器+验证工具（迁移 1790000000006，2a44927，真机验证过）；NF-05 飞书渠道含官方加签（4a256f5）+ ARCH-30 AI 分析服务化 AiAnalysisService+指标（f573109）；P0-4 ADR-012 safeStorage 拍板（e6b9ff0）+ SEC-NEW-1 desktop token 加密 enc:ss:（8fe9fe1）+ BUG-12 desktop IPC 复审双修（49a75bb）。
  - `5b26982` api-reference 契约面汇总核对（FEAT-20 列值优先/NF-01 词表段/execution.killed/feishu 渠道）。
  - **收尾基线（全量复跑）**：admin-api **2136/2136**（2037 起 +99）· admin-web **527/527**（480 起 +47）· executor-node 266 · executor-python **234**（strict 0 warning）· mcp-server **98** · acf-cli **82** · node-sdk 61 · autoflow-sdk 110 · registry-pypi 68 · desktop selftest 双套件绿。双端 tsc/build/lint 绿，51 迁移 check-migrations 绿（下一号 1790000000007）。
  - **留验/后续**：P0-1 e2e 14 例 CI 首验；outbox 补投/kill 事件真机外发；desktop Linux keyring 真机加密往返；审批第二人规则双人真机（P0-2）；ECO-04 v1.1.0 需用户 secrets；SEC-10 dead_letters 对 outbox 路径仅日志级（FK 哨兵拒收，需表结构演进）。

- **本轮（2026-09-08 H2 计划建账，主会话）**：
  - 盘点确认 DEP-04 前端（374bbe8）与销账（403b0ad）已全部入库，工作区干净，九套件基线 2037/480/266/222/74/84/61/110/68 有效。
  - 新建 `docs/archive/plans/development-plan-2026-09h2.md`：P0 清偿 4 项（QA-09 收尾/DEP-04 真机/docs-site host/safeStorage 拍板）+ 遗留 bug 池 7 项 + 功能补漏 FEAT-13~20 + 新功能 NF-01~08 + 架构 ARCH-28~31 + UI-15~16 + QA-11~12 + SEC-10 + DOC-07~09，共 41 个新任务点全部注册入 PLAN-CLAIMS「H2 新任务段」。
  - 里程碑建议：轮 17 清偿速通 → 18 发布+生态（ECO-04 v1.1.0，需用户配 NPM_TOKEN/PYPI_API_TOKEN secrets）→ 19 部署域收口（outbox/KILLED 事件）→ 20 安全纵深（safeStorage/审计防篡改）→ 21 压测容量 → 22 架构二期 → 23 平台扩展 → 24 体验三期 → 25 隔离预研（AUTH-01 拍板）→ 26 i18n。

- **本轮（2026-09-08 win 侧接棒首轮，接手会话）**：
  - `21842fe` 接手建户：PLAN-CLAIMS 复核销账 BUG-03（QA-02 coverage 91.6/81.34/78.47/90.6 超额覆盖目标 75/65/62/75）+ BUG-11（W-16 已 95363aa 闭环，assets 图标含 ico/icns 均在库）；认领 DEP-04（迁移 1790000000002 独占声明）。
  - `abc6e82` **DEP-04 后端 done**：迁移 1790000000002（app_deployments.approvalStatus/approvalMeta 可空列 + applications.approvalRequired 默认 false + 审批待办部分索引，幂等）；deploy() 门控——approvalRequired 应用冻结为 pending_approval 行（approvalMeta 记提交者）**零派发**，待审批行复用 status=pending 天然受 in-flight 部分唯一索引约束（零索引重建）；approve/reject/cancel 三动作——原子认领（UPDATE WHERE approvalStatus='pending_approval'，并发双审批仅首者生效 409）+ 第二人规则（审批者≠提交者 403，脏数据放行+warn）+ reject/cancel 落 FAILED 离开 in-flight + reason≤200；upgrade/stop 对待审批行 409；审计 deployment.approve/reject/cancel（AuditModule 接线 @Optional fail-open）；GET /app-deployments?approvalStatus= 过滤 + /approvals/pending 待办。+24 例（迁移结构 7+service 15+controller 适配 2），admin-api **2037/2037**（2015 只增）tsc 绿。
  - `374bbe8` **DEP-04 前端+docs done**：AppDeploymentPage 待审批行操作区（批准/拒绝 reason Modal/提交者本人撤回 Popconfirm）+ 状态列审批徽标 + 审批待办 Alert + 第二人规则前端禁用 + deploy pending_approval 响应提示；ApplicationListPage 编辑表单「部署审批」Switch；api/applications.ts approve/reject/cancel 封装 + approvalStatus/approvalMeta/approvalRequired 类型；+8 例 UI 测试，admin-web **480/480**（472 只增）+ tsc -b/build/lint 0 errors 绿；api-reference.md 审批流契约（端点/状态机/第二人规则/原子认领/索引约束）。
  - 接手基线复跑（win 侧 80+ 轮后全量盘点）：admin-api 2015→2037 · admin-web 472→480 · executor-node 266 · executor-python 222 · acf-cli 74 · mcp-server 84 · node-sdk 61 · autoflow-sdk 110 · registry-pypi 68 全绿。
  - 交接更正：executor-python unraisable 修复已由 win 侧 86bf0ef 实施（跨会话记忆中"已定位未实施"过期）。
  - 真机轮留验：双人账号第二人规则全链（提交者被禁用审批+他人放行后真机派发）；单管理员团队开启审批后只能 cancel 自撤（文档已写明）。
- 上一轮（2026-09-08 第十六轮·批 subagent-T 终验收）：- 最新提交：见 `git log -1`
- **任务认领板：`docs/PLAN-CLAIMS.md`（多会话并行认领唯一事实源，开工前必读）；中期计划：`docs/archive/plans/development-plan-2026-09.md`（105 任务分级排期）**
- 本轮（2026-09-08 第十六轮·批 subagent-T 终验收，主会话）：
  - `e9bddce` **AUTH-05 交接项（001）单台高危二次确认 done**：ExecutorDetailPage 轮换改受控 Modal（Alert 警示+Descriptions 影响清单+reason 可选 TextArea ≤200 超限拦截）；新增删除执行器入口同形态；reason 链路与 admin-api 契约逐字对齐（空 reason 不发 body）；+10 例。
  - `409d9f3` **QA-03（001）两阶段整体 done（+94 例，297→472）**：第二阶段四页深交互 38 例——TaskList（筛选组合/批量触发暂停/克隆链路 -copy-XXXX 命名）、ApplicationDetail（回滚三重门控/同步任务门控）、Registry（上传拦截/npm Tab/空态兜底）、ApiKeys（scope 三级/payload 精确/吊销门控——吊销失败无 onError 如实断言未虚报）。
  - `c98e870` **ARCH-20（002）核查补齐 done（非纯销账）**：16 子项目逐包盘点，发现真实缺口并修复——typecheck:web 坏链（引用不存在 script）改 tsc -b；六子项目零测试/typecheck 入口补齐（node-sdk/py-libs×4/desktop）；Makefile 三目标委托根 scripts 消除双清单漂移；typecheck:all 7 环逐条真跑验证（node-sdk 61/lib-http 18/lib-ai 25/lib-notify 18/lib-db 8/desktop selftest）。未引 pnpm-workspace（no-hoisting 保持）。
  - `939bfc0` **SEC-07（002）容器最小权限 done**：复核双 executor Dockerfile non-root 已在位（Q-08/Q-09 先例）；增量=compose 双执行器 cap_drop ALL+no-new-privileges（回滚纪律注释）；deployment.md 容器安全段（真机三步清单）。本机无 docker，build/容器内验证如实留真机轮。
  - `cc5aff8` **SEC-08（002）CSP/HSTS 收紧 done**：部署形态侦察（admin-web 独立 nginx 不同 origin+生产 Swagger 已关+纯 JSON 响应）→ 生产 CSP 收至最严（default-src/script-src 'self'/frame-ancestors none/upgrade-insecure-requests，逐指令理由注记）+HSTS 半年+Referrer-Policy same-origin；开发/测试宽松分支；security-headers.util 工厂+supertest 7 例。
  - 主会话顺手修：s3-log-storage MAX_LOG_BYTES 例第三参显式 15s（coverage 全量并发偶发超 5s 默认窗，188 行先例同形态）并补提交（002 批内未入库）。
- **总终验收基线（全绿，复跑确认）**：admin-api **2015/2015**（接手时 1370）+ tsc ✓ + coverage 90.5/78.3/82.2/91.4 门槛卡点 · admin-web **472/472**（接手时 160）+ build/tsc ✓ · executor-node 266 · executor-python 222 · docs-site build ✓ · 全端 typecheck:all ✓
- **第十六轮子代理批次收官总账（批 C~T 共 16 批，001/002/003/004 轮换参与；截至 2026-09-08 收官时）**：P0+P1 全清；P2 清至仅剩真机硬依赖族（AUTH-01/02 需产品拍板、DSK 全族+BUG-07/11/12/17~20 真机、DEP-04 依赖 AUTH-03 已解锁可下轮、ECO-04 需 secrets）；P3 清至 UI-09/10/12/13、QA-10、SEC-NEW-1、SEC-09（可选）。累计新增测试 **+1150 例**，全部「行为断言」纪律（两处 flaky 治理为显式超时放宽非弱断言）。此处 UI-13「清至」是该历史快照中的未完成清单，不代表当前状态或已验收。
- 本轮（2026-09-08 第十六轮·批 subagent-S 终验收，主会话）：
  - `c98e870`+`939bfc0`+`cc5aff8` **ARCH-20 复核补齐 + SEC-07 + SEC-08（002）done**：ARCH-20=16 子项目逐包核查补三类缺口（admin-web typecheck:web 坏链改 tsc -b / node-sdk+desktop+4 py 库六项 test/typecheck 入口新增 / typecheck:all 补至 7 环全绿）+ Makefile test/lint/typecheck 收敛委托根 scripts，逐条真跑验证（node-sdk 61/61、py 库 18/25/18/8、desktop selftest 过）；SEC-07=executor Dockerfile non-root 复核已在位（Q-08/Q-09），增量=compose 双 executor `cap_drop:[ALL]`+`no-new-privileges` + deployment.md「容器安全」段（本机无 docker，build 与任务可跑留真机轮）；SEC-08=helmet 配置工厂 `buildHelmetOptions`（生产 CSP 显式指令集逐条理由/HSTS 半年+子域不 preload/Referrer-Policy same-origin；开发宽松保留），CSP 依据=部署形态侦察（admin-web 独立 nginx 不同源、admin-api 纯 JSON、生产 Swagger 已关、SSE 同源 connect-src self 覆盖）；+7 例 supertest 端到端。
  - `29e4092`（含 DOC-05 四文件入库，归属记档）→ `d7e1c72` **UI-11（001）命令面板动作区 done**：侦察坐实 FEAT-09 面板已存在（四分组搜索/防抖/键盘导航全齐），本任务=增强 §6.3 动作区——置顶「操作」分组（新建任务/创建应用，零输入键盘直达）+ 任务行内动作（触发/暂停/恢复按状态出键，actingKey 互斥+跳详情+失败 toast）+ isAdmin 门控（admin-only 项隐藏）；MainLayout 零改动（触发体验四项核对全既有）。admin-web **424/424**（基线 418，+6）+ build/tsc ✓。
  - `29e4092`+`77a4d94` **DOC-05+06（002）done**：DOC-05=release-please 选型裁定（中文 conventional commits 原生解析/三包 lockstep 无需 per-package/node+py 混合仓支持，胜 changesets）——衔接设计 release.yml 本体零改动（Release PR→合并→tag v*→恰好触发既有 release.yml，include-component-in-tag:false 保证裸 tag 匹配）；release-please.yml（actionlint 过）+config+manifest 基线 1.0.1+development.md DOC-05 节。DOC-06=tutorials/ 四篇（模板两方式/私服依赖含 publish 链/多执行器含 loadScore 公式与 canary 契约/告警值班含静默 API+HMAC+runbook 双通路+停 Redis 演练），字段逐条对照源码；docs-site「教程」分组接入，build 死链检查绿。
- **主会话终验收基线（全绿）**：admin-web **424/424**（基线 418，+6）+ build ✓ · admin-api 2008（本批未触）· docs-site build 死链绿
- 真机轮留验：release-please 首跑观察点（三包 version 收敛人工核对/__version__ extra-files 同步/GITHUB_TOKEN tag 级联触发，development.md 已固化）· ⌘K 双主题走查
- 交接项累计：执行器页单台 rotate-token/删除二次确认 Modal+reason 输入（API 已就绪）
- 本轮（2026-09-08 第十六轮·批 subagent-R 终验收，主会话）：
  - `bbb7e8a` **UI-07（001）执行器列表/详情升级 done**：卡片/表格双视图（ViewToggle localStorage 记忆，表格视图与 QA-03 的 13 例锚定断言零改动）；分组聚合 CheckableTag 条（扁平 string[] 数据下裁定树形过度）；批量 reload-config/rotate-token（ADMIN 门控对齐 W2；轮换高危二次确认 Modal 列受影响台+重注册警示+新 token 集中展示）；实时状态复用 UI-14 的 /metrics/stream executors 段（**零 admin-api 改动**——侦察确认流字段全量覆盖列表需求，不做逐执行器心跳端点；useExecutorLive 字段级覆盖轮询值+断线轮询兜底+连接状态点）。+22 例，admin-web 415（后随 002 增至 418）。
  - `28c6c7d` **AUTH-05（002）审计增强 done**：AuditQueryDto 加 resourceId 精确筛选（Project 未做缩水声明，AUTH-01 前置）+ admin-web audit 页资源 ID 输入框；CSV 导出 ADMIN 已有核实零改动；**高危操作 reason API 侧**——rotate-token/DELETE executor 接受可选 reason（≤200）经 auditHighRisk 写审计（@Optional 注入 best-effort）；前端二次确认 Modal 留交接（001/UI-07 同期在碰该页）。
  - `a1355a5` **FEAT-10（002）通知模板变量 done**：渠道 config 可选 titleTemplate/contentTemplate（**零迁移**——走既有 ChannelConfigStore 写穿，1790000000002 未占用）；renderTemplate 纯函数（单 pass 阻断递归注入/未知变量保留原文/8KB 截断标记/fail-open 回退默认）；sendToChannels 按渠道渲染独立副本，无模板完全旁路；通知设置页可折叠模板面板。render-template 矩阵 14 例。
  - 顺手治理：s3-log-storage coverage 全量偶发 5s 超时显式放宽 15s（5cd6ac0，flaky 治理断言不变）。
- **主会话终验收基线（全绿）**：admin-api **2008/2008**（基线 1975，+33）+ tsc ✓ + coverage 90.51/78.31/82.16/91.44 门槛卡点 · admin-web **418/418**（基线 390，+28）+ build ✓
- 真机轮留验：模板渲染钉钉/企业微信真机外发 · SSE 3s 实时刷新断线重连 · 批量轮换重注册全链
- 交接项：执行器页 rotate-token/删除的**前端二次确认 Modal + reason 输入**（API 已就绪，UI-07 已做批量版 Modal，单台版留下批）
- 本轮（2026-09-08 第十六轮·批 subagent-Q 终验收，主会话）：
  - `48e4909` **UI-06（001）任务表单重构 done（高危区行为等价）**：Steps 四步 → 单页五分区+左侧 Anchor 锚点条+sticky 提交条，全部 Form.Item 同时挂载（分步挂载缺陷土壤消除，第八轮 missing 兜底保留为双保险改锚点滚动）；Glue 区保持原 step3 语义（创建前锁定占位/成功后解锁）；payload 纯函数链逐字节复用、templateId 预填/N28 null 语义不变。TriggerPreview 零新依赖（trigger-preview.ts 手写 5 字段 cron 解析与 admin-api cronMatchesAt 同口径+逐分钟墙钟推算+Intl timezone，18 例）；pinning/broadcast 输入期互斥禁用（N17 前置）。admin-web **390/390**（基线 362，+28）+ build/tsc/eslint ✓；既有 40 例表单测试适配后语义不变全绿。
  - `f53b095`+`d61b364` **ECO-05（002）SDK 文档站 done**：packages/docs-site 独立 VitePress 1.6.4（中文七页导航：快速开始/双 SDK 参考/能力矩阵/示例库/契约/发布），内容全部从 ECO-01 矩阵/sdk-guide/双 README/examples 重组零臆造（版本号写现值 1.0.1）；lockfile 隔离（独立 package-lock，7 个运行时包零触碰）；CI 尾部轻量 docs-site-build job（死链 fail build 即验收，不部署 host 留后）；构建 5.93s 绿+preview 冒烟全 200。站点为镜像视图纪律：SDK 内容先改源头文档再同步（写进两侧 README）。
- **主会话终验收基线（全绿）**：admin-web **390/390**（基线 362，+28）+ build ✓ · docs-site build ✓ · admin-api 1975（本批未触）
- 真机轮留验：锚点条滚动高亮/表单全链真浏览器走查（UI-06）· 文档站 host 决策（GitHub Pages 或其他）
- 本轮（2026-09-08 第十六轮·批 subagent-P 终验收，主会话）：
  - `7a9188f`+`68e4170` **DEP-02+03（001）灰度发布+健康检查+自动回滚 done**：upgrade-all 新可选 `rollout:{strategy:canary|all,percentage}`（缺省 all 逐字节零破坏）；canary 分台 ceil(N×p%)≥1 台 → 心跳 RUNNING 确认 → admin-api 侧主动探测（manifest healthCheck 声明 path/port/interval/failThreshold，**执行器零改动零 bundle 重打**；buildProbeUrl 纯函数六形态含 IPv6）；批次失败五路判定 → 已升级台自动 rollbackDeploymentToPrevious 落 rolled_back；rolloutState/rolloutMeta 新列（迁移 1790000000001）；重启 sweep 把 pending/probing 标 failed（不自动恢复，契约写明）。+32 例，admin-api **1975/1975**（基线 1936）。admin-web rolloutState Tag 避让 002 留下批。
  - `abc9c91`+`872c4e8`+`957577b` **ARCH-26+UI-14 第一阶段（002）done**：TanStack Query 基础设施（QueryClient 全局 staleTime 30s/retry 2/focus 不重取；queries.ts 七 hooks+queryKey 工厂+invalidateExecutionData）+ 两示范页改造（DashboardPage/ExecutionsPage，发现并合并 trend 双请求）；新端点 GET /metrics/stream（3s 快照推 summary/executors/scheduler/errors，fail-open 降级帧+15s ping+独立 MetricsStreamSlotService 32 槽+runtime gauge）；Dashboard 接 useMetricsStream（setQueryData 直写 query 缓存与轮询互斥共存，断线 3s×2^n 封顶 30s 重连）。零迁移零 lockfile 变更。+7 api/+9 web 专项。全站推广留后续。
- **主会话终验收基线（全绿）**：admin-api **1975/1975**（基线 1936，+39）+ tsc ✓ + coverage 90.44/78.06/82.07/91.4 门槛卡点 · admin-web **362/362**（基线 353，+9）+ build ✓
- 事故记档：001 自留 WIP 曾误入 stash 又 pop 回滚，零丢失完整恢复并立即入库——**「add 后立即 commit」纪律同样适用于子代理自留 WIP**。
- 真机轮留验：三执行器灰度 1+2+坏包自动回滚实测 · Dashboard 双 Tab SSE 槽位与重连观察 · rolloutState Tag（admin-web 避让遗留）
- 本轮（2026-09-08 第十六轮·批 subagent-O 终验收，主会话）：
  - `abc9c91` **ARCH-26（002）TanStack Query 渐进引入第一阶段 done**：新 `src/api/queries.ts` 薄层 hooks（queryKey 工厂 metrics/executions/scheduler 层级前缀 + useMetricsSummary/useMetricsTrend/useExecutorStats/useRecentFailures/useSchedulerMetrics/useSchedulerStats/useExecutionsList 七 hooks + invalidateExecutionData 写后失效辅助）+ main.tsx 全局默认（staleTime 30s 对齐原轮询节奏/retry 2/refetchOnWindowFocus:false 防多 Tab 聚焦请求风暴）；示范页两处=DashboardPage（六个 useRequest 轮询换 query hooks，trend 主卡与 sparkline 卡 days=7 同 key 合并请求消除重复拉取）+ ExecutionsPage（筛选参数进 queryKey，15s 轮询可见性 useEffect 兜底，kill 后 invalidate 列表+Dashboard 缓存）。**引依赖说明**：@tanstack/react-query 5.102.8 初始提交即入 lockfile（UserManagementPage 早已消费 useQuery），本批零 lockfile 变更。其余 13 处 ahooks 页面原样（渐进路线全站推广留后续）。
  - `872c4e8`+`957577b`+`c9a9d3d` **UI-14（002）实时推送统一第一阶段 done（Dashboard 汇总流示范）**：admin-api 新 GET /metrics/stream（@Res() 直写+@SkipTimeout 同 logs/stream 先例；3s 快照 {summary,executors,scheduler,errors} 复用既有三读面零新 SQL；查询失败 fail-open 降级 null 段+error 帧不终止流；空闲 15s ": ping" 保活）+ 新 MetricsStreamSlotService 独立槽位（默认 32 METRICS_STREAM_MAX_GLOBAL，与日志流分开计数——容量画像不同；占用在写 SSE 头前超限真 503；释放幂等+finally 双保险）+ runtime gauge autoflow_metrics_streams_active/limit（BUG-05 同款通道渲染侧零改动）+ configuration metricsStream 节三 env + jwt.strategy SSE 白名单增 /metrics/stream（?access_token= 回退）；admin-web 新 useMetricsStream（EventSource 常驻+快照 setQueryData 直写 queryClient 缓存与 ARCH-26 hooks 共享——SSE 活跃轮询空转、断线 hooks 节奏兜底；退避重连 3s×2^n 封顶 30s；卸载清理）+ Dashboard 页头三态连接状态点。
  - **测试基线**：admin-api +7 例（隔离验证 **1943/1943**，基线 1936 只增不减）+ coverage 90.14/77.84/81.83/91.08 过 75/69/84/84 门槛 · admin-web +9 专项+24 既有适配（**362/362**，基线 353 只增不减）+ tsc -b/build ✓。协作注记：001/DEP-02+03 application 足迹零触碰（其 rollout spec 在途红例经其 7a9188f 自行入库，stash 隔离坐实非我引入）。
- 本轮（2026-09-08 第十六轮·批 subagent-O 终验收，主会话）：
  - `d8158a2`+`e24e49c`+`aa2b2f1` **AUTH-03（002）限权 API Key done**：api_keys 表（迁移 1790000000000：sha256 唯一索引/前 8 位 prefix 展示/明文仅创建响应回显一次/revokedAt 软删+expiresAt）+ `/api-keys` CRUD 全 JWT（非本人 404）；JwtAuthGuard 保持唯一 APP_GUARD，@Optional facade 注入分流 `acf_` 前缀（JWT 是 base64 段不可能命中）——api-keys/auth/users 前缀对 API Key 一律 401（防被窃 Key 自管提权）；scope 三级矩阵（readonly 只读/trigger +POST trigger/manage 全量，403 带所需 scope 提示）；lastUsedAt 每分钟节流防写放大；审计 create/revoke/used/auth_failure 全 fail-open。admin-web settings 末位 API Keys Tab（一次性明文回显+复制+吊销「立即 401」警示）。admin-api **1936/1936**（+51）· admin-web 303（+6）。TOTP/会话回归零破坏。
  - `04c82ee`+`816531d` **SEC-06（001）供应链 done**：npm-audit 升 moderate+矩阵补 executor-desktop 漏审；GHSA 豁免机制（重试后 JSON 提取比对，minio 链上游未解核实（逐版查证），豁免仅 2 条复查 2026-10-01，未登记新漏洞 fail-closed）；lockfile-integrity job（7 包 npm ci --dry-run）；gitleaks 双保险（pre-commit rev 固定+.gitleaks.toml allowlist 逐条理由+CI action 全量历史）。**意外收获：executor-desktop electron-builder→fast-uri 链 1 high 顺手修复**（04c82ee），audit low 归零。
  - `5b15134`~`85877c6` **QA-03 第一阶段（001）done +56 例**：五个零覆盖高频页补核心交互（ExecutionsPage 13/ExecutorListPage 13/UserManagement 9/AuditLog 8/NotificationSettings 7）；类型与 unhandled rejection 收口。admin-web **353/353**（基线 297）。第二阶段：ApplicationDetail/Registry/TaskList 深交互+API Keys 页测试。
- **主会话终验收基线（全绿）**：admin-api **1936/1936** + tsc ✓ + coverage 卡点 · admin-web **353/353**（44 套件）+ build/tsc ✓
- 真机轮留验：API Key 触发→吊销→立即 401 全链实测 · gitleaks CI 首跑 allowlist 验证
- 本轮（2026-09-08 第十六轮·批 subagent-N 压轴，主会话总终验收）：
  - `dff036d`+`5141962`+`e207958`+`54f9f6a`+`4228097` **OBS-01（002）OpenTelemetry 分布式追踪 done（可观测性 2.0 收官）**：架构裁定=只用 @opentelemetry/api 1.9.1 + 自实现极薄 span 管理（不引 sdk-*/exporter——无 collector 部署，span 树以进程内结构化日志承载，升级路径写入 deployment.md，埋点零改动可挂 SDK）；span 树 task.trigger→enqueue→dispatch.http→callback.receive 四站点父子串联；**W3C traceparent 全链贯穿**：traceId 落 task_executions（迁移 1789900000003 可空+索引）→ dispatch 头透传 → 执行器读头注入任务 env AUTOFLOW_TRACE_ID（用户参数不可覆盖）→ 六 pushCallback 站点（node）/_run_and_callback 双路径（py）回传 → admin 关联；OTEL_ENABLED 默认 false 零开销零行为变化，畸形头 fail-open；compose jaeger profile 预置（未启用零资源）；admin-web 详情页 traceId 展示+复制。缩水如实：执行器侧不做完整 span 树（预案内）、py kill 链路无 trace 关联（registry 先移除，注记）、Jaeger URL 不硬编码（纪律）。
  - **主会话五端总终验收（全绿）**：admin-api **1884/1884**（+38）+ tsc ✓ + coverage 门槛卡点 · admin-web **297/297**（+4）+ build ✓ · executor-node **266/266**（+4，bundle 无漂移）· executor-python **222/222**（+5）
- **第十六轮子代理批次总账（批 C~N，主会话派工+统一验收）**：P1 任务全部清零——CORE-01~06 · OBS-01~05 · SEC-01~05 · UI-01~05+08 · QA-02 两阶段 · ECO-01/03 · FEAT-01/02/04/05/06/08~12 · W2 · BUG-01/02/05~10/13~16 · QA-04/06 · ARCH-20/21/22/27 · DOC-01/02/03/04 全 done。测试基线从接手时 admin-api 1370/admin-web 160 增长到 **admin-api 1884 · admin-web 297 · executor-node 266 · executor-python 222**（全端 tsc/build/coverage 卡点绿）。剩余 unclaimed 53 项：P2/P3 长尾（AUTH 多租户族/DSK 桌面族/DEP-02~04/BUG 真机族/ECO-04~05/OBS-02 配套等）——多数依赖真机环境或产品拍板（AUTH-01 scope/DSK 真机/OBS-01 真机链路验证），按计划书 §10 编排滚入后续轮次。
- 本轮（2026-09-08 第十六轮·批 subagent-M 终验收，主会话）：
  - `907af4f`+`a3012ca` **DOC-01（002）PR 检查项机制 done**：新建 .github/PULL_REQUEST_TEMPLATE.md——「API 变更？」四查（端点+api-reference 同批/breaking 影响面+四客户端包同批/env 三处登记引 W-22 前科/迁移时间戳防撞号）+「平台影响？」（bundle 同 commit/真机矩阵）+交付纪律段；development.md「PR 前检查清单」节交叉引用。
  - `726e2ec` **CORE-03 收尾「保存为模板」UI done（整体闭环）**：TaskDetailPage 页头 extra → Modal（名称/描述/分类）→ task-template-extract.ts 白名单抽取 17 项 CreateTaskDto 真实声明字段（priority 双形态归一，排除 id/status/glue 等非配置键）→ POST /task-templates；+7 例，admin-web **293/293**（基线 286）。glue 任务模板化留后续评估。
  - `2fa4888`+`1dab41e` **SEC-05（001）上传面纵深 done**：侦察结论=解压主战场在 executor-node deploy.ts（admin-api 不解压），**双侧同规则双闸**——zip-guard 双端同语义零依赖（EOCD+中央目录解析：解压比 ≤100/条目 ≤10000/单文件 ≤1GiB/全包 ≤2GiB/嵌套探测 1 层/zip64 与 CD 篡改 fail-closed，九项 env 走 Joi）；clamd 可选钩子 CLAMD_ENABLED 默认 false，true 时 fail-closed（无 verdict ≠ 放行）。恶意样件集 12+ 例程序化构造全拒（42MiB 高比/条目洪泛/嵌套套娃/EICAR/截断/zip64）。executor-node bundle 同 commit 重打。admin-api **1846/1846**（+27）· executor-node **262/262**（+14）。缩水：update-package 未接线（本就不自动解压，文档注明）。
- 本轮（2026-09-08 第十六轮·压轴，002 子代理）：
  - `dff036d`+`5141962`+`e207958`+`54f9f6a`+`4228097` **OBS-01（002）OpenTelemetry 分布式追踪 done（第十六轮最后一项）**：**api-only 方案**（@opentelemetry/api 1.9.1，不引 sdk-*/exporter——无 collector 部署，span 树以 admin-api 进程内 `[trace]` 结构化日志承载，埋点按 OpenAPI 语义收敛，未来接 Jaeger/Tempo 只挂 SDK TracerProvider 埋点零改动）；OTEL_ENABLED **默认 false 零开销短路**；traceId 落库 `task_executions.traceId`（迁移 1789900000003 可空列+索引，幂等）；W3C traceparent 双向契约（dispatch 头透传→执行器 env `AUTOFLOW_TRACE_ID`（params 不可覆盖）→回调回传头→admin 解析关联）；执行详情页 traceId 展示+「复制 traceId」按钮（跳转 URL 留配置项不硬编码）；compose jaeger profile 预置（未启用零资源）；docs api-reference「Distributed Tracing」契约段+deployment「OTEL / Jaeger」段（架构论证+升级路径）。**缩水（如实）**：执行器侧不做完整 span 树（计划预案内）；py kill 路径 `_push_killed_callback` 不回传 traceparent（registry 条目先移除，文档注记）。+51 例（api 38/node 4/py 5/web 4）。**基线：admin-api 1884/1884**（1846 只增）+ coverage 90.64/78.58/82.15/91.6 过门槛 · **executor-node 266/266**（262 只增，bundle 同 commit 重打）· **executor-python 222/222**（217 只增）· **admin-web 297/297**（293 只增）+ build/tsc ✓。真机轮留验：OTEL_ENABLED=true 双执行器混布 + UI 复制 traceId 到真 Jaeger 检索。
- **主会话终验收基线（全绿）**：admin-api **1846/1846** + tsc ✓ + coverage 卡点 · admin-web **293/293** + build ✓ · executor-node **262/262**（bundle 无漂移）
- 真机轮留验：PR 模板真实渲染走查 · 存模板→模板页→建任务全链路 · clamd 容器联通+EICAR 端到端 · Windows Expand-Archive 恶意包拒绝
- 本轮（2026-09-08 第十六轮·批 subagent-L 终验收，主会话）：
  - `7ea1ddb`+`13b4c91` **ARCH-22（002）execution_log_lines 按日 RANGE 分区 done**：单迁移 1789900000002 三态守卫式（已分区幂等重入/存量普通表在线搬迁四步 RENAME→建父表（联合 PK (id,createdAt)——侦察坐实 id 无外部消费方零破坏）→INSERT SELECT 搬迁+setval 序列对齐→legacy 保留人工清理/新库直建+预建 9 日分区），中断自动续走；清理服务双路径=分区库 DETACH PARTITION+DROP（双安全闸：边界不可解析跳过+时钟回拨绝不 DETACH 未来分区）+legacy DELETE fallback；每日预建未来 7 天分区；LOG_PARTITION_ENABLED 默认 true（只影响清理路径不影响 schema）。测试为 SQL 结构断言（本机无 PG 约定，先例同形态），真机 DDL 语义+10× 时长如实留真机轮。+32 例，operations.md 运维段含演练/回滚步骤。
  - `0b98ec7`+`0902318`+`1f80433` **UI-08（001）三态标准化 done**：ErrorFallback 增强（Result+重试+复制错误信息 clipboard 降级）+新 StateError 页内错误块+PageSkeleton（table/cards 双形态）+PageFallback 骨架化；17 页三态盘点表入库，15 页接入（骨架屏替换裸 Spin、TaskTemplates/ApplicationList 两页 StateError 标杆）；**UI-03 低频 9 页 PageHeader 遗留清零**。缩水：toast-only 页 StateError 逐页补齐留后续（两页标杆模式已固化）。admin-web **286/286**（基线 278，+8）+ build/tsc ✓；被改页既有 23 例测试复核全绿。
- **主会话终验收基线（全绿）**：admin-api **1819/1819**（基线 1787，+32）+ tsc ✓ · admin-web **286/286**（基线 278，+8）+ build ✓
- 真机轮留验：ARCH-22 存量库升级演练（≥100 万行基线→migration:run→中断续跑→DETACH 时长对比→legacy 人工 DROP，步骤固化 operations.md）· UI-08 双主题骨架/错误块走查
- 本轮（2026-09-08 第十六轮·批 subagent-K 终验收，主会话）：
  - `50c648b`+`dfd73bf` **UI-05（001）执行详情页信息架构 done**：antd Tabs 四页签（日志默认/时间线·报告=ExecutionReportPanel 迁入/重试链/参数与产物=**ArtifactsList 单点接入闭环 FEAT-05 UI 半场**），Tab key 走 ?tab= searchParams 记忆；日志查看器加 300ms 防抖关键词搜索高亮（log-search.ts 纯函数+mark 双主题 ≥4.5:1，不改变文本流复制下载保真）；失败定位卡片（failure-runbook.ts 镜像 mcp FAILURE_RUNBOOK 十二类+runbook pre-wrap+跳时间线锚点+重新触发快捷）。**虚拟滚动缩水决策**：保持 fromLine/limit 服务端分页（limit 封顶 2000）+OBS-03 聚合渲染策略已是常数成本，不引 react-window（零 lockfile 变更），注记入板。admin-web **278/278**（基线 264，+14）+ build/tsc ✓；既有 log-level/sse/truncated-logs 三测试文件零改动全绿。
  - `11cd26e`+`807bc3e`+`457531a` **CORE-05+06（002 打包）done**：CORE-05 loadScore 新公式 `0.5×loadRatio+0.25×cpu+0.25×mem+0.1×longTaskPenalty`（executor-score.util 共享纯函数，前三项与旧实现逐字节一致零回归；估时查询失败降级不断调度）；tasks.estimatedDurationSec 可空列（迁移 1789900000001）+DTO 校验+saveVersion 快照纳入。CORE-06 缺口侦察=直方图/P99/prom series 均已存在零重做，真实缺口仅 Grafana——补 row 5 两面板（P99/均值 timeseries + 瞬时 stat）；per-task 直方图缩为全局（label 爆炸，预案内）。admin-api **1787/1787**（基线 1750，+37），coverage 90.65/78.69/81.49/91.64 门槛全过。
- **主会话终验收基线（全绿）**：admin-api **1787/1787** + tsc ✓ + coverage 卡点 · admin-web **278/278** + build ✓
- 真机轮留验：Tab 双主题+万行日志搜索体感（UI-05）· 双执行器长/短任务分布断言（CORE-05）· Grafana row5 数据面（CORE-06）
- 本轮（2026-09-08 第十六轮·批 subagent-J 终验收，主会话）：
  - `11721b1`+`568d480` **UI-04（001）Dashboard 重构五项 done**：KpiSparkline（7 天窗——后端日粒度下 24h 无意义，缩水声明）/FailureTopList（Top5 聚合+次数色阶+跳详情；失败率无分母不展示）/ExecutorHeatBars（CPU/内存双条 85/65 阈值色阶）/SchedulerLatencyCard（p99/avg/last 三数字，CORE-06 后端字段已存在纯前端呈现）/DashboardEmptyGuide（totalTasks===0 引导创建）。五新组件独立文件+纯函数伴生，theme tokens 双主题不破。admin-web **264/264**（基线 253，+11）+ build/tsc ✓。零迁移零 admin-api 改动。
  - `3b76a30`+`da0b4d1`+`cc17e38`+`af8e083` **QA-02 两阶段整体 done（002，branches 冲 75 达成）**：第二阶段 +63 例（executor dispatch/乐观锁/broadcast 全分支矩阵、task findAll/统计/SSE 槽位/回滚补偿、application 状态机与 spawnAsync 边角、notification 渠道分流/静默/silenceStore 写穿）；coverage 排除 bootstrap 面（main.ts/app.module/migrations 等 7 项逐条理由入库，分母口径变化已注记）；四指标 **91.6/81.34/78.47/90.6**（branches 75 达成超 3.47），门槛上调 **75/69/84/84**。零业务源码改动、零真 bug（+63 例直绿）。admin-api **1750/1750**（基线 1652，+98 两阶段合计）。
- **主会话终验收基线（全绿）**：admin-api **1750/1750** + tsc ✓ + coverage 门槛卡点 · admin-web **264/264** + build ✓
- 真机轮留验：Dashboard 双主题走查与五卡真数据渲染（UI-04）· coverage 新门槛 CI 首跑（QA-02）
- 本轮（2026-09-07 第十六轮·批 subagent-I 终验收，主会话）：
  - `167f886`+`7fce990` **UI-03（001）布局升级 done**：侧边栏六大分组 IA（概览/任务/执行/执行器/应用/系统，antd v6 受控 openKeys+onOpenChange，持久化 localStorage 含脏键回退），任意页面 ≤2 跳达成（IA 表留档）；Sider 折叠态持久化+测试锚点；PageHeader 标准组件（面包屑显式传参，tokens 只读复用）高频 8 页替换完成（低频 9 页留清单，props 化单点接入即可）。admin-web **253/253**（基线 239，+14）+ build/tsc ✓。
  - `f5e5594`+`d64b8c1` **QA-02 第一阶段（002）coverage 提升 done（超额）**：实测基线已高于计划书滞后的 68/58/56/69——本轮 +49 例定向补测（s3-log-storage 流式读边角/scheduler Leader 边角/部署状态机与 completed 事件载荷/心跳鉴权/task.controller 44 方法主链（新 spec）/event-subscription 七端点（新 spec）/config 脱敏矩阵（新 spec）），四指标 82.46/65.35/71.33/82.46→**83.98/69.29/73.07/83.32**，门槛同步上调 83/68/72/82（各留 ≥0.7 余量，CI 卡点通过）。零源码改动、零真 bug 发现（计划点名的心跳裁剪已有完整边界矩阵）。第二阶段建议：主攻 branches（73.07→75，缺口集中 executor.service/task.service/application.service/notification.service 大文件），main.ts 等 bootstrap 建议入排除名单。
- **主会话终验收基线（全绿）**：admin-api **1652/1652**（基线 1603，+49）+ tsc ✓ · admin-web **253/253**（基线 239，+14）+ build ✓
- 真机轮留验：分组折叠/折叠态双主题走查（UI-03）· coverage 门槛 CI 首跑观察（QA-02）
- 本轮（2026-09-07 第十六轮·批 subagent-H 终验收，主会话；**注意：003/004 子代理已删除，后续批次仅 001/002 可派**）：
  - `e54b092`+`76e86b4` **UI-01+UI-02（001，打包实施）设计系统令牌+明暗主题 done**：theme/tokens.ts 程序化镜像 MASTER.md（单一常量源，antd token 与 CSS 变量两处消费防漂移）+ index.css 变量注入（dark 面 #020617 OLED）+ ThemeProviders（darkAlgorithm + colorPrimary=#22C55E）+ zustand persist 三态主题 store（light/dark/system 跟随 matchMedia）+ MainLayout 头部三态循环按钮 + index.html 防 FOUC；字体 @fontsource/fira-code+fira-sans（lockfile +61 行最小变更）；双主题适配=壳层+Dashboard/执行器趋势图/SSE 日志区。admin-web **239/239**（基线 225，+14）。缩水如实：axe 未做（无浏览器环境，改对比度人工核算+高频页抽查，真机轮 Playwright+axe 补扫）；硬编码色值清缴面=壳层+4 高频页约 40 处，其余约 30 处散点留 UI-03~08 顺带。
  - `c962d7a`+`c57bc3e`+`b35ac85` **FEAT-07（002）Webhook 出站事件 done**：event-subscriptions 独占模块（10 文件 1509 行）+ 迁移 1789900000000 两表（订阅+死信）；CRUD+死信查看/replay（JWT：ADMIN 全量/普通用户自有+系统级；url 双层守卫=@IsUrl+assertSafeHttpUrl DNS 逐地址 SSRF 深校验+出站前复核；secret 服务端代生成一次性回显后恒脱敏）；OutboundEventDispatcher 按 ARCH-21 接入形态注册 bus 监听器（主链零改动），**签名与 applications 发版 webhook 逐字节一致**（X-Hub-Signature-256 sha256=hex(timestamp.rawBody) ±5min 窗，实测断言）+ maxRedirects=0；重试=进程内 3 次 1s/2s/4s 指数退避→终败落死信+replay（跨进程 outbox 不做，api-reference 如实声明重启丢在途窗口）。补两个发布点：executor.offline（三路 OFFLINE 翻转每台恰一次）+ deployment.completed（心跳终态落库后），均 @Optional+fail-open。+18 例，admin-api **1603/1603**（基线 1585）。
- **主会话终验收基线（全绿）**：admin-api **1603/1603**（基线 1585，+18）+ tsc ✓ · admin-web **239/239**（基线 225，+14）+ build ✓
- 真机轮留验：双主题全页走查+axe 补扫（UI-01/02）· 订阅真实端点收 execution.failed 验签+重试时序（FEAT-07）· ANTD v6 fontFamilyCode 消费验证
- 本轮（2026-09-07 第十六轮·批 subagent-G 终验收，主会话）：
  - `0b97477`+`cd4f0fb` **SEC-03（002）登录安全升级 done**：① TOTP 两步验证（用户级 opt-in）——totp.util 自实现 RFC 6238（HMAC-SHA1/6 位/30s/±1 步漂移，附录 B 六组官方参考向量测试全过），四端点 setup/enable/verify（@Public+限流+错码计入锁定）/disable（需密码或有效码防被窃 JWT 单独关 2FA）；login 契约写死 200+{totpRequired:true}，未启用用户零变化。② 会话管理——access token 增 sid 声明（=refresh jti），refresh_tokens 落 userAgent/ip，GET /auth/sessions（当前标记）/DELETE :id（属主校验）/revoke-others（无 sid fail-safe 吊销全部）。admin-web：登录二段式 + 设置末位「安全设置」Tab（otpauth 文本+secret 复制替代二维码——零新依赖，lockfile 零变更）。迁移 1789800000001。+69 例（api 57/web 12）。
  - `323b442`+`0933d72`+`de681b8` **ARCH-21（003）领域事件总线 done（红线达成）**：DomainEventBus（原生 EventEmitter 封装，不引依赖；emit fail-open；@Global+@Optional 零 spec 破坏）；handleCallback winner 分支终态后 emit execution.completed/failed；**task.service.ts 零 NotificationService import/注入**，notifyCallbackFailure+审计兜底整体迁入 ExecutionEventsListener（九参数语义逐行等价）。顺带闭合 OBS-02 AlertsController 缺 taskRepo provider 的启动级注入缺口（ADR-008 形态，spec 全 mock 掩盖）。ADR-011 记录事件契约；**有意语义变化：通知从回调响应前同步改为可能在途**（真机轮观察）。范围注记：processor AI+dispatch 失败通知直调保留（验收口径=task.service）；KILLED 未 emit（类型预留）；timeout 折叠进 failed（等价）。FEAT-07 铺路就绪（出站 webhook=注册 execution.* 监听器即可）。+28 例。
  - `7302328`+`114cc94`+`999d30b` **CORE-03（004，会话中断后替补接手收尾）任务模板与一键克隆 done**：后端 task_templates 实体+迁移 1789800000000（幂等 seed 5 官方模板，与 mcp TASK_TEMPLATES 同口径）+CRUD+instantiate 端点（POST /task-templates/:id/instantiate 承担 templateId 展开语义——避开 003 的 task.service 足迹）+config 走 CreateTaskDto 语义校验防脏模板，+30 例；前端 TaskTemplatesPage 模板页/路由/侧边栏菜单/TaskListPage 挂载点+TaskFormPage ?templateId= 预填（timeoutSeconds→timeout 桥接、失败降级空白表单），+16 例。「保存为自定义模板」UI 入口与模板市场 CORE-12 留后续。
- **主会话终验收基线（全绿）**：admin-api **1585/1585**（92 suites，基线 1483，+102）+ tsc ✓ · admin-web **225/225**（基线 197，+28）+ build ✓
- 真机轮留验：SEC-03 真实验证器绑定+错码锁定 · ARCH-21 失败告警异步派发到达观察 · CORE-03 模板页→使用→预填→提交全链
- ⚠️ 流程注记：004 子代理会话在本批中途中断（后端已提交、前端 4 文件半成品在工作区），由主会话指示后按侦察→盘点→续作模式接手完成——**子代理中断后其未提交产物留在共享工作区，接手者先 git status/PLAN-CLAIMS 交叉盘点再续作，勿重做勿覆盖**。
- 本轮（2026-09-07 第十六轮·批 003-G，员工 003 子代理会话——ARCH-21 领域事件总线）：
  - `323b442`+`0933d72`+docs **ARCH-21 done**：进程内 DomainEventBus（原生 EventEmitter 封装薄服务，不引 @nestjs/event-emitter；emit fail-open——监听器同步抛错/异步 reject 只记日志绝不冒泡主链；@Global 模块恒提供 + TaskService @Optional 注入零 spec 破坏）；handleCallback winner 分支终态 UPDATE 后 emit execution.completed/failed（emit 时机=旧通知直调点，「每个失败执行一次告警/每个终态一个事件」不变量保持，重复回调不重发）；**红线达成：task.service.ts 零 NotificationService import/注入**，notifyCallbackFailure+审计兜底整体迁入 notification 模块 ExecutionEventsListener（taskRepo 回查告警配置，九参数通知语义逐行等价）。顺带闭合 OBS-02 AlertsController 缺 taskRepo provider 的启动级注入缺口（forFeature([Task])）。ADR-011 载明事件契约与 FEAT-07 接入形态。**范围注记**：processor isLastAttempt 的 AI+通知直调保留（验收口径=task.service 解耦）；KILLED 未 emit（载荷类型预留）；execution.timeout 折叠进 execution.failed（status 区分，与旧语义等价）；依赖扇出不动。测试 +22 总线/监听器 + 6 主链改写（admin-api 1584 passed；唯一红=004 在途 task-template.migration.spec 非我足迹）。遗留：通知改异步派发为有意语义变化（ADR-011 后果段），真机轮观察失败告警到达；outbox/at-least-once 归 FEAT-07。
- 本轮（2026-09-07 第十六轮·批 subagent-F 终验收，主会话）：
  - `8301cff`+`2a169a5` **OBS-02（001）告警路由到通知渠道 done**：新端点 POST /api/alerts/webhook（@Public + HMAC-SHA256：时间戳 ±5min 窗+X-Hub-Signature-256 rawBody 常数时间比较，复用 applications 发版 webhook 先例；ALERT_WEBHOOK_SECRET 未配置 503 安全缺省，鉴权失败统一 401 防枚举）；Alertmanager v2 载荷纯函数映射（firing→error/全 resolved→info，两态都发，多告警合并，空载荷 400）；runbook 兑现=annotations.runbook_url 优先+labels.taskId 查 tasks.runbook 拼段（FEAT-11 消费点，零迁移）；外发走既有 sendAll，全渠道 skipped 502 供 Alertmanager 重试。+19 例，Alertmanager 侧加签反代部署件已在 observability README §3.5 文档化。
  - `e2574bd`+`029a987`+`0365803` **ECO-01（002）SDK 统一矩阵+官方示例 done（路线图 #10 收口）**：sdk-guide 23 项能力矩阵逐项对齐（每项源码证据路径）+5 条差异裁定（不收敛项写明理由）；补齐两个对等缺口——node ctx.reportSuccess/reportFailure（py 端孪生）+ py HttpClientError 可判别错误子类（零破坏）；官方示例 4 件（回调 py/node + 私服依赖 py/node，每件=入口+README+task.example.json，API 逐行核源，本地降级路径烟测过）。autoflow-sdk 110/110 · node-sdk 61/61。fromEnv 抛错 vs from_env 兜底的失败模式分歧留后续 breaking 拍板。
  - `3e982a6`+`c0c31b5` **DEP-01（004）/releases 统一资源 done**：GET /applications/:id/releases 只读聚合（版本×最近部署一屏追溯；无部署版本行也出现、synthetic 行归一历史数据；分页 50/上限 200；排序纯函数）；零迁移；operator 恒 null 带 operatorMissingReason 标注、triggerType 推导规则已知限制均如实文档化；旧端点保留过渡期 alias。+12 例。
- **主会话终验收基线（全绿）**：admin-api **1483/1483**（+31，基线 1452）+ tsc ✓ · autoflow-sdk **110** · node-sdk **61** · acf-cli 74 · mcp-server 84（本批未触，复跑确认）
- 真机轮留验：OBS-02 全链（Prometheus→Alertmanager→加签反代→/api/alerts/webhook→WECOM 5min 内）· ECO-01 四示例端到端（平台触发+私服真装+回调 token）· DEP-01 一屏追溯 · fromEnv 失败模式统一（breaking，双 SDK 同批）
- 本轮（2026-09-07 第十六轮·批 004-F，员工 004 子代理会话——DEP-01 /releases 统一资源）：
  - `3e982a6`+`c0c31b5` **DEP-01 done**：新只读聚合端点 `GET /applications/:id/releases`（一行=一次版本发布：版本号/包地址取 application_versions 快照当次值，deployedAt/deploymentStatus/deploymentCount/executorAddress/runMode 按 deployedVersion 聚合「最近一次」app_deployments；无部署版本行也出现；有部署无快照历史数据合成 synthetic 行；分页默认 50/上限 200 双重截断；排序=最近部署时刻降序，releaseSortTimestampMs 纯函数）。**零迁移**（纯读视图未占时间戳，1789700000000 仍归 002/ECO-01）。已知来源缺失如实标注：operator=createdBy 列恒 null（写入路径未填充+audit 不覆盖部署写面，行带 operatorMissingReason）；triggerType 按部署行状态面推导（upgrade 指纹/manual/unknown），落库化留后续 schema。旧端点 `/applications/:id/versions` 与 `GET /app-deployments` 原样保留为过渡期 alias（不删除不重定向）。测试 +12 例；admin-api **1483/1483**（+19 为 001/OBS-02 并行入库）+ tsc ✓。**移交/遗留**：admin-web ApplicationDetailPage 消费 releases 契约（docs/api-reference.md「Releases」段已文档化）；triggerType 持久化列；真机一屏追溯验收留真机轮。
- 本轮（2026-09-07 第十六轮·批 subagent-E 终验收，主会话）：
  - `5c0a7b5`+`2c0fe7e`+`221253e` **CORE-02（002）重试策略精细化 done**：① retryableErrors 表单化（retry-policy.ts 九类中文映射剔除 killed/stale_recovered，空集显式 null 的 N28 语义，后端本就绪零改动）；② retryDelay ±20% jitter（retry-backoff.util 纯函数随机源注入，四处 enqueue 边界注入数值方案：trigger/rollback/scheduler.enqueue/scheduleRetryAfterRecovery）；③ attempt 链可视化（retry-chain.ts 兄弟行 retryCount 拼装+间断截断，ExecutionDetailPage 重试链 Card+预算 Tag+下次重试近似时刻，手动提前重试指路既有 trigger）。零迁移（1789700000000 预留未用）。下次重试时间为近似值（BullMQ delayed 精确时刻不落库，精确值留后续）。
  - `dd88d0a`+`8088766`+`fb466d7` **OBS-04（001）执行报告消费+时间线 done**：新端点 GET /tasks/:id/executions/:execId/report 一次合并 task_executions 行+created→started→finished 三段时间线（与 DB 时间戳一致，与 mcp-server ECO-03 buildExecutionTimeline 同语义）+execution_reports 当日聚合行；reportRepo @Optional 注入零破坏；ExecutionDetailPage 挂 ExecutionReportPanel（Steps 时间线缺省「—」+AI 分析段+报告段存在才渲染）。缩水说明：execution_reports 无单执行级写入方（仅 MetricsService 日聚合懒生成），按计划预案降级为「时间线+AI 分析」主体，零 schema 变更。
  - `7a5c589`+`2571c2c` **FEAT-05 UI 半场（003）done**：新 api/artifacts.ts（blob+objectURL 下载，参照 executor-packages.download，直链会 401）+ ArtifactsList 组件（name/size/sha8/逐行 loading，空态不渲染）+ TaskDetailPage 产物段最小插入；ExecutionDetailPage 侧入口留待复用 <ArtifactsList execId={execution.id}/> 单点接入。
- **主会话终验收基线（全绿）**：admin-api **1452/1452**（74 suites，1434 基线 +18）+ tsc ✓ · admin-web **197/197**（165 基线 +32）+ build ✓ · executor-python 217 · executor-node 248（本批未触）
- 真机轮留验：CORE-02 retryableErrors 命中/不命中各一例+重试链 UI 断言 · OBS-04 report 端点真实数据渲染 · FEAT-05 artifacts 端到端一例（上传→列表→下载）
- ⚠️ 流程注记：002 为验证隔离两次 stash 001 在途文件（已原样归还）；001 docs commit 8088766 顺带入库 002 的 5 个新文件（内容逐字节一致，归属已注记）——**并行 hunk 隔离协作连续两轮实操可行，但 stash 交错与顺带入库仍是事故高发点，同文件强冲突任务仍应错峰认领**。
- 本轮（2026-09-07 第十六轮·批 subagent-D 终验收，主会话）：
  - `c24f61d`+`f62b776` **CORE-04（001）超时策略分级 done**：tasks.timeoutAction 三动作（kill 缺省 / kill_retry=超时终态后按既有重试预算 re-enqueue，triggerType=timeout_retry，预算耗尽退化 kill / notify_only=admin 不额外下发终止指令，告警仍由失败通知路径保证一次）+ timeoutWarnRatio（0-90 预警阈值，每执行至多一次 WARNING）；纯决策层 timeout-policy.util 两端共享；迁移 1789500000000 可空零破坏；版本快照纳入两字段；admin-web 表单 Radio+阈值/详情展示（序列化纯逻辑 pages/timeout-policy.ts，清空须发 null 的 N28 语义）
  - `d7e7c84`+`7bd9378`+`a0ae1b3` **SEC-02（002）任务 secrets 加密落库 done**：新增 tasks.secrets 独立 jsonb 列（方案 B——params 是普通运行参数且被列表/版本快照明文消费，整体加密伤审计面）；AES-256-GCM `enc:v1:` 自描述信封（嵌套逐叶加密+幂等）；SEC_SECRETS_KEY 未配置降级明文 warn 一次（零破坏升级，Joi/configuration/.env.example 已登记）；写路径全加密/读路径永久脱敏 ****** /dispatch 解密与 params 合并注入执行器 env（secrets 胜出、明文不二次入库、解密失败不裸派发）；迁移 1789500000001
  - `7e0c1c7`+`1b12073`+`c739024`+`ef0e7e6` **FEAT-05（004）执行产物通道后端+双执行器 done**（详见下方 004 批注）：artifacts 链路 admin-api/executor-python/executor-node 三半场全闭合，node bundle 同 commit 重打（重打幂等已验证）
  - **主会话终验收基线（全绿）**：admin-api **1434/1434**（73 suites，1370 基线 +64）+ tsc ✓ · executor-python **217/217** · executor-node **248/248**（bundle 无漂移）· admin-web **165/165** + build ✓（160 基线）
  - 移交：FEAT-05 admin-web UI 半场（产物列表+blob 下载，见 ef0e7e6/api-reference「Artifacts」）；真机轮留验=CORE-04 三动作各一例 + warn 接线（processor 持 warned 标记调 util）+ SEC-02 备份泄露演练
  - ⚠️ 流程注记：三子代理并行下迁移时间戳曾撞号（001/002 同选 1789500000000，migrations.spec 抓住后 002 改 1789500000001）——后续并行轮次建议认领时预分配迁移时间戳段；shared 文件（task.service.ts/create-task.dto.spec.ts/executor.service.spec.ts）hunk 隔离提交已实操验证可行但成本高，能避让尽量避让
- 本轮（2026-09-07 第十六轮·批 004，员工 004 子代理会话——FEAT-05 执行产物通道）：
  - `7e0c1c7` admin-api：迁移 `1789600000000-AddExecutionArtifacts`（task_executions.artifacts jsonb 可空列）+ 新 `modules/artifacts`（PUT 上传复用包上传通道 memoryStorage 100MB + 机器鉴权复用回调凭据形态；GET `/tasks/executions/:execId/artifacts[/:name]` JWT 守卫 + 裸文件名防路径穿越 + 流式；每日 TTL 清理搭车 LOG_RETENTION_DAYS，根目录 `LOG_ARTIFACT_DIR` 可覆盖）+ CallbackItemDto.artifacts 校验（≤20/裸名/sha256）+ handleCallback 非空清单落库（缺省不擦除）；admin-api 隔离 worktree **1389/1389** 全绿
  - `1b12073` executor-python：`artifacts.py` collect（`<workDir>/artifacts/` ≤20/≤100MB/跳过子目录·超限·非法名）+ httpx multipart PUT + `gather_artifacts_for_callback` 仅入成功项；execute.py 预建目录+注入 `AUTOFLOW_ARTIFACTS_DIR`+终态回调附清单（best-effort）；**217/217**
  - `c739024` executor-node：`src/artifacts.ts` 对等实现（global fetch+FormData/Blob）+ callback.ts CallbackRequest.artifacts + execute.ts prepare/runTask 接入；jest **248/248**；`resources/executor-node/index.js` **同 commit 重打**（本机验证改前空重打逐字节一致，CI bundle-drift 守卫安全）
  - 验收数据链路（截图→artifacts/→PUT→回调清单→task_executions.artifacts→JWT 下载）双执行器均闭合
  - **移交 admin-web（未做）**：执行/任务详情页新增「产物」列表（GET `/tasks/executions/:execId/artifacts`）+ 逐条下载（GET `.../artifacts/:name`，用 axios blob + objectURL，参照 executor-packages.ts 的 download 写法，因 JWT 仅从 Header 取）；api-reference.md「Artifacts」小节已文档化三端点
  - 注：本会话 shared 文件（app.module.ts / task.service.ts）严格 hunk 隔离提交，未卷入 001(CORE-04)/002(SEC-02) 在途半成品；工作区 executor.service.spec 红为 002 SecretsCryptoService 未 mock 所致，非我引入、未触碰
- 本轮（2026-09-07 第十六轮·批 001-C，员工 001 会话；详见认领板变更日志）：
  - `6297f21` **ECO-03**：MCP 工具面扩容 4 工具——get_execution_timeline（OBS-04 时间线+失败三联卡对齐 BUG-10 分类）/list_dead_letters（心跳 deadLetterCount 聚合）/create_task_from_template（5 官方模板，字段全走 CreateTaskDto 白名单）/get_scheduler_health（leader/queue/latency 四段重塑）；mcp-server **79/79**
  - `a00438b` **QA-07**：共享契约 fixture——`packages/contract-fixtures/contract.json` 单一事实源（envelope/passthrough/2xx 区间/错误体形态/knownHeuristicEdge+knownDivergence），四端消费同一向量（acf-cli 74 · mcp-server 84 · node-sdk 53 · autoflow-sdk 105）；审计副产两处修复：CLI detailFromData 空串 message 遮蔽 error 兜底；knownDivergence 留档 cli/mcp 宽松启发式 vs node/py-sdk 严格三键分歧（真实流量不受影响，待统一）
  - `9e93e22` **FEAT-11**：任务 runbook 字段——迁移 1789400000000（tasks.runbook 可空 text）+ DTO/实体 + 通知双路径透传（dispatch 失败/回调失败 notifyFailureWithConfig 增尾参）+ admin-web 表单 TextArea/详情展示条目（**OBS-02 告警 runbook 链接的前置已就位**）；admin-api **1370/68** · admin-web **160/160** + build ✓
  - 未竟移交：CORE-04（超时策略分级）/CORE-02（重试策略精细化）已侦察未开工（触达面：task.processor timeout 路径+DTO+admin-web 表单），无在途半成品；QA-09 e2e 套件化剩余仍归 main-A
- 测试基线（本会话收工时点，全绿）：
  - admin-api **1370/1370**（68 suites）· admin-web vitest **160/160** + build ✓
  - acf-cli **74/74** · mcp-server **84/84** · autocodeflow-node-sdk **53/53** · autoflow-sdk **105/105**
  - 全端 tsc ✓（admin-api/acf-cli/mcp-server/node-sdk 均复验）
- 本轮（2026-09-07 第十六轮·批一，main-A 会话；详见认领板变更日志）：
  - `84ff261` 计划+认领板入库；`f0c5f32` **W2 前端半场**——执行器管理写操作（编辑/配置热更/设置离线/轮换Token）非 admin 隐藏（API 半场 executor.controller.ts+rbac.spec.ts 在途归并行会话，其提交后 W2 整体闭环）
  - `313d203` **BUG-08/N41**：executor-node register 失败自愈——auth.ts setOnTokenAcquired 钩子 + maybeReRegister（已注册短路+in-flight 去重），token 恢复后补注册回填富元数据（admin 同 startupId register 幂等不轮换已复核）；bundle 同 commit 重打；executor-node **235/235**
  - `780dbcf` **BUG-09/QA8**：python 停机树杀后 live 回调收口——await_background_tasks_after_kill 窗口 + _run_and_callback CancelledError 落盘守卫 + lifespan 顺序钉死（杀树→flush→drain）；executor-python **201/201**
  - `0a4d5c0` **QA-04**：docs/VERIFY-MATRIX.md 真机矩阵 checklist（平台/拓扑/按变更类型必跑）
  - `0409000` **FEAT-03**：孤儿组件 ExecutionCompare（零引用）拆出 ExecutionCompareModal 接回 ExecutionsPage 多选对比；admin-web 93/93
  - 复核销账：**BUG-02**（sweep 重试预算第十四轮已实现+测试）；**BUG-01/N51**（401 重签重试 R11 已实现，收口改进在 executor.controller.ts 被并行会话占用→blocked，且该重试路径无专项测试）
  - `3caabb4` **BUG-05**：SSE 活跃流 gauge（autoflow_sse_streams_active/limit）——runtime-gauges 模块级注册表+task.service 占用/释放两点埋点+prom 绝对值渲染；observability README 字典补录 4 runtime counter+2 gauge（此前后台字典滞后）；admin-api **1179/1179** + lint 0
  - 批五~批七（01:04-02:00，main-A 持续推进）：`SEC-01 复审四项`（BUG-13 CLI 401 刷新自愈+refreshToken 入库 / BUG-14 MCP AUTOCODEFLOW_API_REFRESH_TOKEN 长驻自愈 / BUG-15 SDK 契约对称性 / BUG-16+12 复审）→ docs/archive/audits/sec-01-review-report.md，新发现 desktop token 明文落盘→SEC-NEW-1；`BUG-06` S3 回退指针语义（replace STALE 指针/append 孤儿行，storeLogLines 全量并入+指针收回）；`FEAT-02` 依赖 DAG 可视化（dag-layout 纯函数+TaskDependencyGraph+详情页 Tab）；`CORE-01` 优先级 UI 化（双形态契约 utils/priority）；`ECO-02` acf exec tail（SSE）+ task lint；`DOC-04` ADR-001~010；`FEAT-12` pypi 索引页增强；`BUG-10` 失败分类细化四端联动（git_fetch/dependency_install/runtime_missing）。基线：admin-api 1218 · executor-node 240 · executor-python 206 · autoflow-sdk 100 · acf-cli 66 · mcp-server 46 · registry-pypi 52 · admin-web 118。⚠️ 流程事故复盘：共享 index 暂存碰撞（dc82ac7 顺带带走 main-A 已暂存的 ECO-02 文件，无内容丢失）——**add 后立即 commit，禁长时暂存**。
  - ⚠️ 并行会话在途（勿动）：W1 通知设置页/W2 API 半场/应用三页面+MainLayout/logout.test/app-deployment-race.test.tsx（该文件 tsc 在途报错，全量 build 被其阻塞）
- 测试基线（全绿）：
  - admin-api **870/870** (jest, 53 suites) + eslint **0/0** + coverage 地板（68/58/56/69）
  - executor-node **158/158** · executor-python **115/115** · autoflow-sdk **91/91**
  - admin-web vitest **35/35** · Playwright E2E **29/29**（pinned 全链 4 例）
  - acf-cli **48** · mcp-server **52** · registry-pypi **33** · autocodeflow-node-sdk **43** · autocodeflow-notify **7**
  - 全端 tsc ✓ · admin-web build ✓ · `scripts/ci-local.sh` 本机等价 11 job 全绿
- 本轮（2026-09-03 第八轮，A/B/C/D 四路 → W1/W2 修复 → V 真机 5/5 → W P1 击穿修复；详见 `docs/archive/progress/progress-round8-2026-09-03.md`、`docs/archive/verifies/verify-round8-e2e.md`）：
- 本轮（2026-09-03 第六轮，A/B/C/D 四路并行 → audit triage → F1/F2/F3 三路修复 → V 真机验证 6/6 PASS；详见 `docs/archive/progress/progress-round6-2026-09-03.md`、`docs/archive/verifies/verify-round6-e2e.md`）：
- 本轮（2026-09-02 第三轮，4 并行 stream + 集成 + 文档验收，7 个 commit）：
  - `8bb3790` **调度器多实例（P0）**：Leader Election（`scheduler:leader` 锁 TTL 30s、TTL/2 续约校验、Redis 挂时 fail-open）+ `claimTaskTrigger` 条件 UPDATE 原子领取；recoverStaleExecutions 分批；TASK-007 依赖深度上限 64；TASK-008 SSE 并发上限（per-execution 4 / global 64，超限 503）；DB-001 task 软删除；DB-003 N+1 收敛
  - `7851ebd` **通知/AI/Webhook**：NOTIF-002 摘要脱敏截断；NOTIF-003 silences 上限 1000 + 定时清理；AI-002 `fallback` 标记（task 层响应已透传）；APP-001 webhook 失败统一 401；APP-002 缺 API_BASE_URL fail-fast；ARCH-003 上传走 `UploadApplicationDto`
  - `723efbf` **架构（ARCH-001..008）**：CORS 白名单 `CORS_ALLOWED_ORIGINS`；**/uploads 强制鉴权**（JWT 或 executor 共享 token）；全局限流 60/min；`REDIS_TLS`；`DB_SYNCHRONIZE` 显式；swagger 生产关闭；unhandledRejection 优雅退出；死代码 4 处删除
  - `b1fbbef` **数据库（DB-002/004/005/006/007）**：日志保留清理服务（`LOG_RETENTION_DAYS`=30，每日 03:30 分批 DELETE）；application_version 唯一索引；迁移 2685→2694 重命名（幂等）；username varchar(128)；system_config.value 显式 text；migrations.spec 时间戳唯一性守卫
  - `eadedca` **executor-node**：包下载携带 `Authorization: Bearer <共享token>`，跨主机重定向剥离 token
  - `295e3b1` **文档验收阶段发现的 2 个代码 bug 修复**：configuration.ts 补注册 `sse` 配置节（此前 `SSE_MAX_STREAMS_*` env 覆盖是死代码，task.service.ts 读不到）+ CreateExecutorPackageDto 删除必填 `filePath`/`fileSize`（服务端从上传文件推导，真实 multipart 请求被全局 ValidationPipe 400 拒绝）
  - 新增环境变量：`CORS_ALLOWED_ORIGINS`、`THROTTLE_LIMIT`/`THROTTLE_TTL`、`REDIS_TLS`/`REDIS_TLS_REJECT_UNAUTHORIZED`、`DB_SYNCHRONIZE`、`LOG_RETENTION_DAYS`、`SSE_MAX_STREAMS_PER_EXECUTION`/`SSE_MAX_STREAMS_GLOBAL`（自 `295e3b1` 起真正生效）；`API_BASE_URL` 上传包时必需
- 本轮（2026-09-02 第四轮，全新对抗性排查：4 路只读 audit → 负责人 triage → 7 路 fix，5 个代码 commit；详见 `docs/archive/progress/progress-round4-2026-09-02.md` 与 `docs/review_round4_*.md`）：
  - `d2613d6` **调度/任务链 2P0+2P1**：触发去重锁被 watchdog 无限续期致每任务只触发一次（acquireLock 新增 renew 选项，trigger 锁 renew:false）；依赖任务链死代码（worker 永不写 SUCCESS）迁入 handleCallback 赢家路径；多页日志回填丢页（storeLogLines append 语义）；COVER_EARLY 盲写改条件 UPDATE
  - `b0aa67f` **安全 2P1+6P2**：RolesGuard 全局注册 + config 写端点/共享 token/executor-package 收紧 @Roles(ADMIN)（@Public 机器端点用空 @Roles() 覆盖）；heartbeat/register 列注入白名单（原 Object.assign 可覆写 tokenHash 成持久后门）；SSRF 层新增 assertSafeExecutorUrl 接入 dispatch/broadcast/reload/push + 3 通知渠道；登录枚举时序拉平；callback 限流 + token 校验 60s 缓存；trust proxy 改 `TRUST_PROXY=true` 才启用；SSE 仅 /logs/stream 路径接受 `?access_token=`；config/history 与 audit 筛选 QueryDto（修恒 400）
  - `f792e10` **executor-python 1P0+1P1+12 项**：shell entrypoint 注入（白名单+位置参数，对齐 node 6062bee）；日志 10MB/64MB 上限；回调重试退避；git 缓存 hash 盐；REQUIRE_TOKEN fail-closed 等
  - `f0f61e5` **executor-node 5P1+8 项**：callback ≤100 分片 + dead-letter 毒文件终态；部署子进程 env 白名单（共享 token 不再透传给被管应用）；NODE_PATH 修 requirements 不可解析；BoundedLogBuffer；TTL 磁盘回收；共享下载器（Bearer+deadline+防穿越）；spawnSync→async；进程组 kill
  - `75c8d2b` **客户端契约 2P0+7P1**：CLI login accessToken（原字段名错致 CLI 全 401）；应用编辑不发 name；安装向导走 install-cmd（后端删坏 curlCmd）；包下载带 auth fetch；AI 分析字段对齐；SSE 参数名；trigger executorId 移除
  - 新增环境变量：`TRUST_PROXY`（默认 false——**nginx 后部署必须设 true**，否则限流键/审计 IP 全变代理 IP）、`EXECUTOR_ALLOW_PRIVATE_NETWORK`（默认 false：executor 出站放行私网段但拒 loopback/元数据；**同机 127.0.0.1 executor 部署必须设 true**）
- 本轮（2026-09-02 第五轮，收尾 + **首次真机验证**：4 代码流 + V/W1/W2/V2，7 个代码 commit；详见 `docs/archive/progress/progress-round5-2026-09-02.md`、`docs/archive/verifies/verify-round5-e2e.md`、`docs/archive/verifies/verify-round5v2-n2.md`）：
  - `0a7ebcb` 依赖扇出 10s DB claim（双上游并发只触发一次）+ checkDependencies take 兜底；storeLogLines DB 路径事务化；**可观测性**：SchedulerMetricsService（tick/claimed/skipped/failed 进程内计数）+ BullMQ 队列深度 + `GET /metrics/scheduler`（零新依赖）
  - `1864597` executor-node flake 元凶坐实：file-logger spec 用 UTC 日期而生产按本地时区（超前时区机器每天 8 小时确定性失败）；4 spec 确定性化，5 连跑全绿 + 5 种 TZ 交叉
  - `51469d6` audit 两端点收紧 ADMIN；删除孤儿 install-token 端点；admin-web 角色门控（role 唯一来源 `GET /auth/profile`——登录响应无 user 字段；RequireAdmin 路由守卫 + 菜单隐藏 + settings 写禁用）
  - `9e8f2ae` CLI/MCP P1 补全（applications CRUD、deploy upgrade/stop、task versions/rollback/compare、executor get、audit list）+ 5 个既有契约 bug 顺带修 + 两包 vitest 基建
  - `2642293` **真机发现 N2(P0) 修复**：PG enum 列运行时返回字符串 label（'normal'），原样传 BullMQ 致**所有调度入队 100% 失败**（单测全 mock queue 故从未暴露）——normalizeTaskPriority 入队边界归一化；N3 readyClient 消 ~15s 假 Leader；N4 register 幂等（同 address+startupId 不再轮换 token）；N5 stale cutoff 动态化；N6 去重锁 TTL 按触发周期（修 15s 任务被压成 300s）
  - `d2be430` **真机发现 N1(P1) 修复**：全新 DB 迁移链 3 处断裂（app_deployments 无建表、version 列撞名、rename 时序）幂等化 + CreateAppDeploymentsTable 补偿迁移 + migrations.spec describe 守卫（修 typeorm CLI 崩）；docker postgres 空库 24/24 + 存量续跑数据无损双验证
  - V 真机验证（`b2be111`）：Leader Election 双实例 80 execution 无重复、kill 后 35s 接管；LOG-11 S3 对象闭环；负载均衡精确 2+2——**三项全通过**；V2 复验 N2/N6/N3/N1 修复全部生效（96/96 success）
- 本轮（2026-09-03 第六轮，详见 `docs/archive/progress/progress-round6-2026-09-03.md`、`docs/archive/verifies/verify-round6-e2e.md`）：
  - **N6 残留抖动修复**：fixed_rate 去重锁 TTL 改 `周期−500ms`（`TRIGGER_DEDUP_JITTER_BUFFER_MS`，claim 窗口同源）——真机复验 15s 任务 11 个 gap 全部 14.999–15.001s、零 30s 级 gap（修复前 15/30 混合）
  - **任务 API 契约**：CreateTaskDto.id UUID 校验（字符串 400/重复 409 含软删预检与 23505 兜底）；**executor pinning**（tasks.executorId 新列迁移 25 + dispatch pinned 分支：在线只派目标/离线 executor_offline/不存在 unknown；与 broadcast 互斥）——真机三语义 PASS
  - **install.sh 闭环**：`install-script.content.ts` 单一事实源 + `GET /executors/install.sh`（@Public text/plain）+ install-cmd 重建 curl|bash + N15 参数注入校验（六种注入 exit 1 零落盘）+ 逐字节漂移守卫
  - **audit N7-N15 修复**：N7 executions 两端点交叉类型白名单失效→显式 DTO（CLI 同步删 limit）；N8 SSE 30s 掐断→`@SkipTimeout()`；N9 executor-node worker Map 泄漏→5min 惰性回收；N10 CLI --wait 漏 killed；N11 通知/AI config 收紧 ADMIN + 密码脱敏（GET /executors 复核后**不**收紧，理由见 controller 注释）；N12 mcp-server 30s 超时+错误文案；N13 admin-web pause/resume 类型修正
  - **CI 流水线**（`.github/workflows/ci.yml` 重写 12 jobs）：develop/main 双分支触发 + acf-cli/mcp-server/admin-web lint 补齐 + admin-api e2e（真机修绿 37/37，含 migrations.spec e2e worker 崩溃修复）+ 迁移链双轮幂等 job；admin-api lint（存量 154 errors）与 coverage 阈值两个 step 注释保留待清偿
- ⚠️ 第六轮部署注意：
  - **GET /notification/channels、/ai/config 已收紧 ADMIN**：admin-web 的 NotificationSettingsPage/settings 普通用户读面将 403，前后端需同批发布（第七轮补前端门控/降级 UI）
  - acf-cli 需随轮重新分发（executions 请求移除 limit + killed 终态）
  - mcp-server 需随轮重新分发（30s 超时 + 错误文案）
  - 迁移 25（tasks.executorId）为幂等 ADD COLUMN，例行窗口执行即可
- 本轮（2026-09-03 第七轮，详见 `docs/archive/progress/progress-round7-2026-09-03.md`、`docs/archive/verifies/verify-round7-e2e.md`、`docs/archive/verifies/verify-round7v2-fixes.md`）：
  - **依赖/质量清偿**：四端 npm audit 官方源清偿（browserslist HIGH 等全消，executor-node qs 经 overrides 升级，admin-api 残留 3 moderate 属 minio 链上游未修）+ CI `npm-audit` job（--audit-level=high）；admin-api eslint **163→0/0**（tsconfig.eslint.json 修解析错误根因 + no-unused-vars 下划线约定固化）；coverageThreshold 地板化（68/58/56/69）恢复 CI coverage
  - **可观测性**：prom-client 15.1.3 落地 `GET /api/metrics`（8 条 autoflow_scheduler_* series + 进程默认指标，JwtAuthGuard 姿态同 /metrics/scheduler，`METRICS_PROMETHEUS_ENABLED` 开关）——真机 counters 单调增长验证
  - **RBAC 收尾**：admin-web /notifications RequireAdmin + settings AI Tab 非 admin 降级（组件测试先例建立）
  - **audit N17-N24 修复**：N17 pinning 互斥 PATCH 绕过（合并态兜底校验，真机复验）；N18/N21 registry-pypi 哈希 sidecar + 上传防重（流式 1MiB + 同哈希幂等/异哈希 409）；N19 TaskFormPage 消费 executorId（executor-mode.ts 纯函数层）；N20 MCP update_task + CLI --executor；N22 新端点 POST /api/notification/send；N23 node-sdk fromEnv required 收敛（回调凭证可选 disabled client）；N24 install.sh 删假 URL 分支
  - **真机验证闭环**：V 五渠道外发全通（含 SMTP 会话）+ prom 端点 + N17 互斥；抓到 V1-V5（config 与外发解耦/SSRF fail-open 无反馈/deny 缺 198.18 与 100.64 段/未知 key 500/死 env 引用）→ W 全修 → V2 真机复验通过
- ⚠️ 第七轮部署注意：
  - **POST /api/notification/send 新端点**（登录态可发通知）与 **/api/metrics**（JWT）新增，若前端有 WAF/网关需放行
  - **通知外发 config-first**：PATCH 渠道配置现在真实生效（此前仅 env 生效）——存量环境若 env 与已保存 config 不一致，行为会变
  - **SSRF deny 扩大**：198.18.0.0/15、100.64.0.0/10 段通知外发/executor 出站均被拒（TUN/CGNAT 环境 executor 部署注意）
  - install.sh 不再尝试远程下载 artifact（明确失败语义），目标机安装需 executor-packages 通道或项目 checkout
  - acf-cli/mcp-server 需随轮重新分发（--executor 选项 / update_task 工具）
- 本轮（2026-09-03 第八轮，详见 `docs/archive/progress/progress-round8-2026-09-03.md`、`docs/archive/verifies/verify-round8-e2e.md`）：
  - **per-execution 回调 token（N23 根治）**：`v1.<execId>.<exp>.<hmac>` 域分离 HMAC（key=HMAC(secret,固定域)），TTL=timeout+900s；executor-node 注入 AUTOFLOW_CALLBACK_TOKEN/AUTOFLOW_ADMIN_API_URL/AUTOFLOW_EXECUTOR_ADDRESS（extra 通道，SEC-01 白名单不动）；admin `v1.` 分支验证（候选 secret + per-executor tokenHash 回退 + executionId 逐 item 绑定，fail-closed）；node-sdk fromEnv 自动启用；双端 spec 钉死同一测试向量防算法漂移
  - **install.sh artifact 通道**：`GET /executors/artifact/executor-node.tar.gz`（共享 token fail-closed）+ bundle 脚本——真机从 artifact 装出执行器注册 online；`scripts/ci-local.sh` 13 job 本机等价（push 无凭证期间验收通道）；registry-npm verdaccio healthcheck 修复（localhost→127.0.0.1 恒 unhealthy bug）+ 加固 + README
  - **Playwright E2E 25/25**：新增 9 例（角色门控/AI Tab 降级零请求/四模式/executorId 残留服务端复核）；**抓到 P0**——TaskFormPage 分步渲染 validateFields 只回当前挂载字段，创建 UI 完全不可用 → getFieldsValue(true)+分步兜底，fixme 转正
  - **audit N25-N32**：N25(P1) `::ffff:` IPv4-mapped IPv6 绕过 SSRF 分类 → normalizeIpForClassification 归一（含 ::/96 与完整 IPv6 危险段）；N26 回调 token 密钥缺口（tokenHash 是 bcrypt → 改双端以 tokenHash 字符串为 HMAC key，register 回传+采纳+60s 缓存验签）；N27 SDK 自动补 executorAddress；N28 admin-web 模式清理 delete→显式 null；N29 通知 test 面真实 results；N30 registry-pypi 并发上传 os.link 原子防重；N31 /api/metrics 并发 render 串行化
  - **真机 P1 击穿修复（V 抓到）**：executor-node fetchToken 不拆信封 + Nest POST 201 误判 200 → token 恒 undefined → 心跳每 30s 旋转 token（9 分钟 14 次）→ 回调 token 稳态必 401。三层修复：fetchToken 拆信封/2xx 区间；admin issueToken 幂等（startupId 稳态永不轮换+内存缓存明文+legacy 60s 窗）；心跳响应回传 tokenHash 三点采纳
- 本轮（2026-09-03 第九轮，A/B/C/D 四路 → V 真机 5/5 + audit N33-N36 → W 收尾修复；详见 `docs/archive/progress/progress-round9-2026-09-03.md`、`docs/archive/verifies/verify-round9-e2e.md`）：
  - **python 侧 token 链对齐**：executor-python `_fetch_token` 三缺口（201 误判/未拆信封/缺 startupId）修复——动态 token 首次真正生效；register/heartbeat 采纳 tokenHash（三点不变量补齐）
  - **autoflow-sdk 回调能力**（node-sdk 对等）：from_env 读三变量（排除出 params）+ CallbackClient（enabled/disabled_reason）+ report_success/failure；executor-python 注入回调三变量（HMAC 移植，与 admin/node 三方同测试向量逐字节一致）
  - **回调 401 分类观测**：`autoflow_execution_callback_auth_total{result}` 七分类 series（controller 埋点 util 保持纯函数）
  - **webhook 配置面补全**（V2 遗留）：PATCH channels/webhook 合法 + config-first + URL query 脱敏 + 掩码回显守卫
  - **Playwright 29/29**：pinned 部署全链 4 例（在线/离线/不存在/全 UI 闭环）
  - **P1 修复（V 抓到）**：python register 用动态 token 打 bootstrap 端点 401（R9 修复揭开）→ 改静态 token + 状态码检查；**N33-N36**：issuedTokenCache 有界化（1000/24h）、artifact query token 风险标注、ci-local 差异声明
- **里程碑（2026-09-05）**：**v1.0.1 三包发布完成**（npm `@autocodeflow/sdk` + `autocodeflow-mcp-server` 1.0.1、PyPI `autoflow-sdk` 1.0.1，双版本可回溯）；**develop→main 发版合并完成**（main 与 develop 树一致，两父 merge commit `bddac27`，main CI 全绿）；**Windows 深度测试任务书就绪**：`docs/archive/plans/windows-testing-plan.md`（R13 基线→R14 功能冒烟→R15 修复批→R16 desktop 打包，含 13 项已知平台风险点与问题回传模板——Win 机器拉取后按此推进）
- 本轮（2026-09-06 第十五轮，gh 凭证打通后首度 CI 真跑；员工 001/002/005/006 四波编排 + 主控亲修；存在并行会话同期协作，e0c30ef/1734958 为其产物）：
  - **CI 红灯清偿**：push 后首跑三红灯——e2e-full 根因为**实体↔迁移链漂移**（task_versions/config_history/execution_reports/executor_metrics_history 4 表 + applications.packageUrl/webhookSecret + executor_packages 4 列从未建过迁移，历史靠 DB_SYNCHRONIZE=true 掩盖，空库纯迁移链上任务创建直接 500——「mock 一切不等于能跑」第五轮教训再验证）；admin-api-test 败于 lint（spec 内 require()）；executor-node-test 败于 Linux 侧 kill 时序（assertion timing）。均已在 e0c30ef 修复，后续 run **24 job 全绿**（含 29 例 e2e）。
  - **部署链路加固**（6ed5b21，admin-api 1098→1123）：R4 spawnSync→spawnAsync（clone 120s 不再冻结全进程）；R5 在途部署部分唯一索引+23505→409（upgrade 保持 UPGRADING 防多实例滚动升级互撞）；R6 卡死扫描 createdAt→updatedAt；R8 push/stop 接入 assertSafeExecutorUrl；R9 包上传 diskStorage+流式哈希+rename 落位+下载 pipeline（500MB 不再驻留内存）；R16/R18。
  - **桌面 IPC 安全**（bbb93de）：path-domain.ts 路径域校验 util + selftest 基建（npm run test:main）；任意文件读/executionId 逃逸/任意程序启动三口子闭合；托盘 online 合并注册状态；https 探测修正；心跳句柄清理。
  - **包契约**（634803f）：notify 非 2xx 可观测+返回 bool+webhook 通道；ai base_url 统一基址语义+围栏解析健壮化（notify 7→18、ai 10→25）。
  - **006 审计 S1-S16**（第三/四波修复落地）：S1(高) admin-web nginx proxy_pass 尾斜杠剥离 /api 前缀——生产部署全部 API 404（dev 代理无 rewrite 故 e2e 从未暴露）；S2/S7 deploy.sh 健康路径+两份 nginx client_max_body_size；S3(数据破坏) system-config 掩码回写哨兵守卫；S4/S5 registry 上传超时+npm 服务账号凭证；S6 Windows zip 条目校验（PowerShell .NET 枚举+纯函数）；S8/S13/S15 audit CSV 注入/400 化/ParseIntPipe；S9 执行器端口回环+REQUIRE_TOKEN=true（连通性推演过）；S10/S11 pypi 上传 50MB 上限+.egg 收敛；S12/S14 clone 分支语义+死 import；S16 settings 历史列对齐。
  - **006 QA 批次**（QA1-QA10 全消）：QA1 deploy.sh 断言字符串（S2 修复自身引入，闭环）；QA2 nginx 210m→510m（执行器包 500MB 上限对齐）；QA3 SSE 空闲 15s ': ping' 帧（nginx 60s 读超时下 S3 存储任务日志流必断）；QA4/QA5/QA6 部署守卫补 UPGRADING/PENDING 卡死清扫/快照 23505 容忍；QA7 form-data 显式依赖；QA8 spawnAsync CAP+进程组杀；QA9 上传孤儿清理；QA10 Content-Disposition 消毒。
  - **流程注记**：并行会话与本会话同时操作同一工作树（e0c30ef/1734958 及 6ed5b21 内夹带 prettier 重排）——提交前必须 git pull --rebase + diff 盘点，员工报告与 git 实际状态要交叉核对。
  - 测试基线刷新：admin-api **1170**（60 套件）+ lint 0/0 · executor-node **227** · registry-pypi **50** · notify **18** · ai **25** · admin-web **87** · executor-desktop selftest 过 · **CI 24 job 全绿终态（run 34035565675，commit 2342743）**——期间两轮返程红：desktop-bundle-drift（round-15 改 executor-node src 忘重打 bundle；W-18 守卫按预期拦截，教训=executor-node 源码改动与 bundle 重打必须同 commit）。
  - 本轮遗留（下一轮候选）：executorAuthMiddleware 彻底移除（12 例测试迁移到 verifyToken）；admin-web api/config.ts ConfigHistory 类型同步；QA8 detached 对 Windows 信号行为的深度验证；nginx SSE 专 location（现靠 15s ping 保活）；大规模并发压测/真机矩阵（长期未覆盖项）。
- 本轮（2026-09-06 第十四轮，员工 SubAgent 001/002/006 主力（003/004 触模型日限由 general-purpose 兜底）→ QA 审查 10 项 → 修复闭环）：
  - **executor-python 可靠性三件套**（153→197）：E2 回调失败落盘+后台重试环+dead-letter（token 永不落盘、重放现取动态 token 走自愈；停机 drain 10s）；E6 同任务串行锁（按 loop 分桶）+git cache per-repo 互斥；E8 磁盘 TTL 回收（workdir/.git_cache/.venvs/logs，TTL 7d/周期 6h/首跑延迟 600s env 可配，活跃目录保护 fail-safe）+dead-letter 目录 TTL 清扫+清理移入 to_thread；心跳恒报 deadLetterCount。
  - **admin-api P2**（1014→1098）：sweep 条件 UPDATE 赢家兑现重试预算（hasRetryBudget→kill best-effort→scheduleRetryAfterRecovery 入队，STALE_RECOVERY_RETRY_ENABLED 开关）；failureReason 新增 stale_recovered；deadLetterCount 实体列+幂等迁移+心跳采纳（0..100000）。
  - **admin-api 安全收口**（006 审计 R1-R19）：application/app-deployment 全链 @Roles(ADMIN)+env 读面全链脱敏（含 QA1 闭合的 deployment.env/relations/snapshot.env 三处绕过）；SSRF maxRedirects:0（6 出站点）+assertSafeGitRepoUrl；通知 test 端点 ADMIN+override 请求级化（不再写全局 store）；账号过期锁原子重置；ai/test ADMIN；pid @IsInt；currentPassword 不回显；3xx 确定性拒绝不重试+文案明示。
  - **admin-web**（83→87）：死信三态可视化（详情/列表）；截断日志"加载完整日志"分页兜底（对齐 fromLine/limit≤2000 契约）；stale_recovered 映射；U13 类型修正。
  - **流程注记**：004 员工在模型日限触发前留下 R1/R2/R3 半成品（含掩码回写真实 env 的数据损坏缺陷），兜底 agent 已修复补齐——员工 SubAgent 中断后必须 diff 盘点其遗留。
  - 测试基线刷新：admin-api **1098**（58 套件）· executor-python **197** · admin-web **87** · executor-node 218（本轮未动）· 包类 218→本轮未动。
  - 本轮遗留（下一轮候选）：deployFromGit spawnSync 阻塞事件循环（R4 后半，需异步化）；R5-R9（部署 TOCTOU/卡死误判/stop 语义/推送 SSRF/上传流式化）；R13 Electron IPC 路径校验；R14/R22 python 包通知/AI 契约；python 停机树杀后 live 回调不在 drain 范围（QA8，可由 P2 收敛）。
- 本轮（2026-09-06 第十三轮，三路只读审查 P/E/U 共 33 项 → 5 路并行修复落地 21 项 → 全量回归）：
  - **admin-api**（1014/1014）：BullMQ `defaultJobOptions` 终态保留策略（completed 1h/1000、failed 24h/5000，Redis 无界堆积根治）；`@Processor("task-queue",{concurrency:5})` 消除大 timeout 任务队头阻塞（核实 @nestjs/bullmq 11 单对象形式 concurrency 会被静默丢弃，须用第二参数）；SIGTERM 15s 强制退出兜底（`shutdown-guard.util.ts`）；心跳白名单采纳 `maxConcurrentTasks`（1..10000 校验，E9 admin 侧）。
  - **executor-node**（218/218，ncc bundle 已重打）：心跳上报 `maxConcurrentTasks`（热更后下个心跳回传，E9 node 侧）；`logsDir` 改 lazy getter 修复 workDir 热更写读分裂（E10）；死信清理 `filesOnly` 与计数口径对齐（E12）；callbacks/ 顶层孤儿 .meta 24h 回收（E13）。
  - **executor-python**（153/153，+25 用例）：心跳上报 `runningExecutionIds`（accept 即注册/终态摘除/≤200，E1——此前 null 被跳过活性保护，prepare 阶段超阈值即被误判 FAILED 且经 429→重试链可双跑）；重复 executionId 400 守卫（E7）；`POST /api/executions/:id/kill` 端点（E4）；停机杀任务进程树（E5）；回调走 `request_with_self_heal` 且 401 可重试（E3）。
  - **admin-web**（83/83 + lint 0）：SSE 与 axios 同源（复用 getApiBaseUrl，U1）；全站 `pollingWhenHidden:false`+兜底 interval 可见性门控（U3）；执行器详情实时卡改用 metrics.current（U5）；Dashboard 失败列表消费 failureReason/exitCode 并链执行详情（U6）；pending 筛选（U9）；error≠不存在三详情页 Result+重试（U7）；执行器历史表 taskName/exitCode/整行跳转（U10）。
  - **packages**：autocodeflow-http 变更方法默认不自动重试（`safe_methods_only`，U4）；autoflow-sdk 回调 enabled 仅要求 url+token + 双 SDK 信封拆包（U14）；acf-cli 补 exitCode/failureReason/runningExecutionIds（U11）；mcp-server 新增 get_executor_metrics + 描述如实（U12）。
  - 本轮遗留（下一轮候选）：sweep 对 worker 崩溃型 RUNNING 行 re-enqueue 重试语义（P2，需产品拍板）；python 回调落盘/死信（E2）、git/venv 并发锁（E6）、磁盘 TTL 回收（E8）；admin-web 截断日志走分页端点兜底（U2）；deadLetterCount 中台侧落库可见（U16）；python kill 端点响应体若与 node 契约有差异需真机核对。
  - 测试基线刷新：admin-api **1014**（57 套件）· executor-node **218** · executor-python **153** · admin-web **83** · acf-cli **53** · mcp-server **63** · node-sdk **49** · autoflow-sdk **100** · autocodeflow-http **18**。
- **里程碑（2026-09-05 Windows 轮，R13-R16 全完成，Windows 侧接手主导）**：项目首个非 Linux 平台全验证（Win11 26200 / Node 24.17 / Python 3.12-uv / WSL2 mirrored 网络跑 PG16+Redis7）。findings **W-01~W-26**、生产修复 **P-1~P-20**（`docs/archive/reports/windows-findings.md`）：
  - **5 枚生产级缺陷修复**：executor-python `os.setsid/killpg` 全任务崩（P-1/2）；venv `bin/python` 布局（P-3）；`['python3']` 硬编码致 python glue 全挂——两处均为单测全 mock 未暴露、人工审查发现（P-3/4）；entrypoint `/xxx` 逃逸守卫绕过（P-5，安全）；shell glue 缺 glueLanguage fallback + win32 `.cmd` 化（P-11）；控制台 Ctrl 事件波及任务/后台 SIGBREAK 缺失/desktop stop() SIGTERM 失效（P-9/10/12，R-08 全景收口）
  - **R-01/R-03 治本**：`.gitattributes` 全仓 LF + renormalize（admin-api eslint 37078→0、install.sh 字节守卫转绿）；`killProcessTree` win32 升级为 `taskkill /T /F` 树杀（超时/取消/停止三链孙进程实测 0 残留）
  - **双平台绿灯基线**：executor-node 164/164（3 连跑稳）、executor-python **128/128 零 skip**、admin-api 887/887 + eslint 0/0（含 W-22 守卫 3 例与 W-21 requirements 11 例）、acf-cli 48、mcp-server 61、registry-pypi 33、admin-web 35 + e2e **16/16**（16 例版；W-12 闭环：29 例全量版已由 Linux 侧入库根级 `e2e-full.spec.js` + `playwright.e2e.config.js`，test#16 同步 W-13 修复）
  - **R14 真链路 9/9**：注册上线、四类任务全链、fixed_rate 15.007s±0.02s、超时树杀、token 轮换+reload-config、日志回收无 EBUSY、中文空格 WORK_DIR、优雅退出 SIGBREAK 链 rc=0x0；**补 executor-python Windows 真链路 6/6**（uvicorn/注册/心跳/glue/callback-token/venv-P-3 直连实证；发现 admin 不转发 requirements 的功能缺口，跨平台）
  - **R-04 专项（W-19/P-13）**：任务 env 白名单两侧补齐 Windows 系统+home/identity 变量族（python 侧此前零 Windows 变量；Git-Bash 的 HOME 恰好掩盖了退化）；双侧白名单安全测试 + 真链路 homedir/getuser 实证
  - **R16 路线图 #12 收口**：electron-builder NSIS 安装包 Windows 首产（100.6MB）；ncc 内置 executor 独立注册+真实任务验证；新发现 W-16 assets 图标未入库（体验）/W-18 prebuilt bundle 跟踪（漂移风险）
  - **固化**：Windows CI job（executor-node/acf-cli/mcp-server + admin-web，`ci.yml`）；desktop bundle 漂移守卫 `desktop-bundle-drift`（W-18 闭环：ncc 字节确定性已验证，离线重打+git diff 把关）；deployment.md 新增 Windows 章节（手动路线/taskkill 警告/shell 语义）；install.sh 平台探测；requirements-dev.txt ×2
  - ✅ Linux 复验义务已闭环（2026-09-05，凭证配好后推送）：CI run 33943007134 **22 job 全绿**（ubuntu 18：executor-node 162 / executor-python 127 / admin-api 873 等零回归；windows 4：executor-node/acf-cli/mcp-server/admin-web 固化基线）。Windows CI 首跑即抓出并修复 W-20（env 白名单 win32 大小写语义失效，P-14/15）——双平台 CI 交叉验证的直接收益
  - **W-12 销账**（Linux 侧）：29 例根级 e2e 基线入库（`e2e-full.spec.js` + `playwright.e2e.config.js`）；Windows 首跑暴露登录节流级联 429 → 定位 **W-22/P-16**（`@Throttle` 装饰器求值期读 `process.env`，`.env` 文件对 `LOGIN_THROTTLE_LIMIT` 原为死配置，仅真实进程环境生效——容器部署从未暴露）→ main.ts 预载 `.env` + app.module 动态 import 修复；修复后 Windows 纯 `.env` 栈 **29/29** 全绿
  - **W-21 requirements 端到端接通**（产品决策：接通）：admin-api 实体 jsonb 列（幂等迁移）+ DTO 结构校验 + normalize（trim/拒 option 形 `-` 前缀）+ version snapshot 收录 + dispatch 透传零改动（manifest `as any` 路径现真实落库）；admin-web 任务表单 Select tags（逗号不切分，pip spec 合法含逗号）+ 空集显式 null（N28 PATCH 语义）+ 详情页展示；sdk-guide 补字段行。基线刷新：**admin-api 884 · admin-web 40 · e2e 29/29**，CI run 33947112177 **22/22 全绿**
  - **Windows 侧续推（同日，Windows agent）**：① W-21 补遗——`syncTasksFromManifest` 回归两例（requirements 透传进 create 载荷 + 'already exists' 隔离），manifest→任务链路自此有守（aa9429f）；② **W-18 永久闭环**——CI 新增 `desktop-bundle-drift` 守卫（离线重打 ncc bundle + git diff，产物与源码不同步即红；ncc 0.44 字节确定性/禁网可跑已在 Windows 侧预验证，首跑即绿，37a5de3）；③ **W-28：Windows 全栈 e2e 接入 CI**（方案 A：仅 PR/workflow_dispatch 触发，不占 develop push）——复用同一 `e2e-full.sh` 编排（参数化 WORK_DIR 至 C:/tmp，node 盘符解析），PG 用 runner 预装服务（postgres/root）、redis 用 redis-windows portable zip，见 findings W-28；④ 修正本人一处状态误判（"W-12 未推"实为已在共享历史，见 findings W-28 状态澄清）。CI 现状：develop push 24/24（含守卫），PR/dispatch 另加 windows e2e（首跑已验证 success，298s，run 33967431348）
- 本轮（2026-09-04 第十轮，A/B/C/D 四路 → W 收尾 N37-N42；详见 `docs/archive/progress/progress-round10-2026-09-04.md`）：
  - **可观测性**：docs/observability/（Grafana dashboard 11 panels + 6 条告警规则 + README 抓取配置/指标字典，series 与源码逐字核对零偏差）
  - **SDK 发布管道**（路线图 #10 收尾）：release.yml（tag 触发 + version-guard 四处版本一致性 + npm/PyPI 发布 + environment: release 审批门）；双 SDK README + sdk-guide 矩阵；修掉 autoflow-sdk 未声明 pydantic 依赖的发布级 bug
  - **旋转 token 即时对齐**：窗口评估实为最坏 30min（60s 缓存掷硬币 + 离线级联）→ executor-node 401 自愈（forceTokenRefresh + 单次重试，窗口收敛到一次往返）+ admin rotateToken 播种 issuedTokenCache（UI 展示的 token 即执行器采纳的 token，零二次轮换）
  - **audit N37-N42 全消**：webhook 优先级链修正（显式参数 > 已保存且启用 config > env，ChannelConfigStore 增 enabled 跟踪）；api-reference 补 /notification/send 行与 rotate-token 双端区分；sdk-guide python 判据 ctx.http→ctx.callback.enabled（原文档照写即 AttributeError）；TaskContext 敏感字段 repr=False；release 审批门
- ⚠️ 第十轮部署注意：
  - **webhook URL 语义翻转**：显式请求参数现在优先于已保存渠道 config（且 disabled 渠道 config 不再生效）——依赖第九轮"config-first 覆盖一切"行为的消费方需复查
  - release.yml 首用前需配置 NPM_TOKEN / PYPI_API_TOKEN secrets 与 GitHub Environments（release）审批人
  - executor-node 需随轮重新部署（401 自愈）
- ⚠️ 第九轮部署注意：
  - autoflow-sdk 新回调 API（report_success/failure）——python 任务代码升级 SDK 后即可用回调
  - webhook 渠道现在可 PATCH 配置且 config-first（保存 url 优先于逐请求参数）——行为对依赖旧"参数优先"语义的消费方是变更
  - executor-python 需随轮重新部署（token 链修复 + 回调注入）
- ⚠️ 第八轮部署注意：
  - **回调 token 依赖共享 secret 同源**：EXECUTION_CALLBACK_SECRET 可选（缺省回落共享 token）；admin UI 手动旋转 token 后长运行执行器需 register/token/心跳对齐（三点已自动化，sdk-guide 有约束说明）
  - `POST /executors/token` 语义变化：幂等签发（不再每次旋转）——依赖旋转行为的消费方（若有）需复查
  - ~~executor-python 疑似同款信封 bug~~ ✅ 第九轮已修复（信封拆包+2xx+startupId+tokenHash 采纳+回调注入全链对齐）
  - install.sh 现支持 artifact 下载（EXECUTOR_ARTIFACT_DIR，默认 <cwd>/artifacts，需先跑 bundle 脚本）
- ⚠️ 部署注意事项：
  - **/uploads 鉴权是破坏性变更**：executor-node 必须升级到含 `eadedca` 的版本，否则下载应用包 401
  - **第四轮 RBAC 是行为变更**：普通用户访问 config 写端点/executor-packages 全部改判 403；前端未做角色门控（可见但操作 403），admin-web 需与 admin-api 同批发布（SSE `?access_token=`、编辑不发 name、下载带 auth 均依赖新后端）
  - **acf-cli 必须重新分发**：`75c8d2b` 前所有 CLI 登录即失效链（token=undefined）
  - executor-node/python 建议随轮升级（callback 分片、env 白名单、注入修复）；部署的应用若曾偷读 EXECUTOR_SHARED_TOKEN 会因 env 白名单失效
  - DB-005 重命名迁移会在已有环境重跑一次（幂等 up/down，安全）；DB-002 唯一索引迁移重写 application_version 表，建议维护窗口执行
  - SSE 并发计数为进程内：多实例实际上限 = 实例数 × 64
- 工作区：干净

## 会话恢复速查

```bash
# ARCH-20（根级聚合入口，per-app 安装模型不变）：npm run test:unit / typecheck:all / lint:all / test:api / demo:seed 等
# 各子项目独立运行命令（仍可用）:
cd apps/admin-api && npx jest && npx tsc --noEmit -p tsconfig.json
cd apps/executor-node && npx jest
cd apps/executor-python && python3 -m pytest -q
cd apps/admin-web && npm run lint && npm run build
cd packages/acf-cli && npx tsc --noEmit
cd packages/mcp-server && npx tsc --noEmit
```

注意：
- `apps/executor-desktop/resources/executor-node/`（内嵌 executor-node 的 ncc bundle）是生成物，**不入库**（F-19 后 .gitignore）；源码改 `apps/executor-node/src` 后走 `npm run build:executor` 重打，哈希跟踪在 `apps/executor-desktop/executor-node-bundle.sha256`。
- admin-api 全局 `ResponseInterceptor` 把成功响应包成 `{ code, message, data }`，admin-web 在 `src/api/client.ts` 的 axios interceptor 自动拆包；CLI 与 MCP 已在 `packages/acf-cli/src/client.ts` 与 `packages/mcp-server/src/index.ts` 加上对称拆包逻辑（2026-09-02）。
- 文档可能比代码旧，以代码+测试交叉校验。

## 开发准则

1. 小步提交：一个方向一批改动，先补测试再改实现，提交前跑该子项目验证命令。
2. 每次提交信息用中文 conventional commits（feat/fix/docs/chore/refactor/test）。
3. 功能落地后同步更新 `docs/api-reference.md` 与 `docs/archive/reports/optimization-notes.md` 的状态标记。
4. 会话结束前更新本文件「状态快照」并提交。

## 长期路线图状态

| # | 方向 | 状态 |
|---|------|------|
| 1 | 版本历史与发布快照 | ✅ 已完成（含回滚） |
| 2 | 执行失败原因分类 | ✅ 已完成（executor 侧可再细化） |
| 3 | Webhook / API 认证模型 | ✅ 已完成（rawBody+时间戳 HMAC，Public 路由强制 secret） |
| 4 | 任务超时 / 时区 / 重试 | ✅ 已完成（trigger/rollback/scheduled 三入队路径均带 attempts+指数退避，processor 失败 rethrow 使 BullMQ 重试生效，均有单测） |
| 5 | 执行器重启恢复 + 负载感知 | ✅ 已完成（心跳携带 runningTaskCount，dispatch 按 loadScore=runningTaskCount/max 选最低负载 + 乐观锁防超发，广播模式不占计数，callback 释放槽位，均有单测） |
| 6 | 应用包版本隔离 | ✅ 已完成（不可变 release 目录 + current 软链 + 回退） |
| 7 | 心跳 / 注册稳定化 | ✅ 已完成（连通性自检、退避重试） |
| 8 | Admin Web 与 E2E | ✅ E2E 35/35（Linux x86_64）；平台矩阵未覆盖 |
| 9 | CLI 与 MCP 能力对齐 | ✅ 已完成本轮 P0（CLI: task CRUD/pause/resume/kill/logs/executions、app deploy/deployments/versions；MCP: get_application/deploy_application/kill_execution/pause_task/resume_task/list_deployments + 已有 list/get/analyze 套件）。ResponseInterceptor 拆包已在 CLI/MCP 两侧 client 解决 |
| 10 | SDK 统一与示例 | ⬜ 未系统梳理 |
| 11 | 日志外置存储（MinIO/S3） | ✅ 已完成（`LOG_STORAGE_DRIVER=s3` 可选驱动；callback 写入时优先 S3 失败回退 DB；读取时按 `exec.logStorage` 分流；集成测试 6/6） |
| 12 | 桌面执行器跨平台 | ⬜ 未验证 |

## 下一步建议（按优先级）

> **当前（2026-09-14）**：ARCH-A2 与 **A2-B 均已 done**。剩余项如下：
>
> 1. **架构演进（季度级，唯一成规模）**：§七 20 个架构方向——**A1 / A2 / A3（最小切片）/ A4 / A5 / A6 已 done，A2-B、A3-B（完整形态）亦已 done（均 2026-09-14）**——§七六个优先方向全部收口，A2 的「声明→强制」与 A3 的「载荷 schema 单一事实源」两个闭环均已完成。剩余可推进项：① **把 A3 生成物接进两侧 `/execute` 运行时校验**（node 侧现有手检与 schema 语义等价，可直接替换；python 侧需先解决 `req.task` 的字典式访问与 `merge_task_with_manifest` 入参类型，并与 timeout clamp 漂移一并裁决）；② `kill` / `deploy` / `update-package` / `logs` 端点载荷的 schema 化（先只收了协议面核心三个）。注：zod 已作为 executor-node 依赖引入（`3.25.76`，与 mcp-server 既有版本一致）。
> 2. **（原 A2-B，已 done）** ~~把 `assertCanWrite` 提升为守卫内强制~~：已由 ALS 断言证据通道 + `WriteGuardEnforcementInterceptor` 落地（声明 `ownership`/`project-role` 的写端点拿不出证据即 500）。顺带修出两处真实漂移：`trigger`/`pause`/`resume` 只做项目角色校验→改声明 `project-role`；`killExecution`/`analyzeExecution`/`suggestSchedule` 无属主校验→补上。剩余的是 ADR-013 待拍板的「project-role 是否收紧为 ownership」。
> 3. **需产品拍板（不可代劳）**：ADR-013 非成员 trigger 收紧、release-please main 合并习惯、API JWT 60d 缩短评估、desktop Linux 更新链签名。
> 4. **需真机/长稳环境**：QA-05 24h 长稳、多主机（跨机）拓扑、macOS/Windows/ARM64 部署、通知渠道实测、私有 npm/PyPI 仓库集成。
> 5. **QA-12 CI 形态专项**：`desktop-e2e-smoke` 在 windows runner 的「Process failed to launch」（v1.2.0 起文档化，PR-only 非门禁）。
> 6. ~~**已知面（A2 审计发现，未立项）**：`RegistryController.uploadPypiPackage` 为「任意已登录用户可传 PyPI 包」~~ ✅ **A7 已收口**（详见下方「状态快照」A7 条目）：上传面收敛为 `@Roles(ADMIN)` + 包名/版本字符白名单 + 成功/失败双向审计；前端同步按角色禁用入口。**未**引入专用 upload token（需先确认是否有 CI/流水线上传场景，谁签发谁轮换是运维决策），已登记为残差。
>
> 以下为历史轮次遗留清单（保留供追溯）：

> 第九轮交接 6 项中 5 项已在第十轮完成。以下为第十轮后剩余：

1. ~~CI push 真跑~~ ✅ 2026-09-04 闭环：gh 凭证到位后三轮修复（node 24 + autoflow-sdk-node lock 官方源重生成 + python jobs respx/python -m + audit 重试），**13 jobs 全绿**；剩余 release 首发演练（打 tag 前需配 NPM_TOKEN/PYPI_API_TOKEN secrets 与 Environments(release) 审批人）。
2. ~~autoflow-sdk-node 旧重复包清理~~ ✅ 2026-09-04 第十一轮已删除（@autocodeflow/sdk 0.1.0 旧 Node 重复包，全仓无消费方；npm 名现由 packages/autocodeflow-node-sdk@1.0.0 发布，无冲突；git 历史保留，未另建归档分支）。
3. ~~executor-python 401 自愈对齐 + reload-config 必然 401~~ ✅ 第十一轮已完成（request_with_self_heal + issueToken 幂等复用，真机实证）。遗留 N51 文档化事实：admin-api 重启后（签发缓存冷）任一执行器的首次 reload-config 会报错一次（rotate-on-push 固有，执行器一个心跳内自对齐后重试即成功）。
4. 跨平台矩阵（需真机）；minio 链 3 moderate 等上游发版。

## 未覆盖验证项

- macOS / Windows / ARM64 部署
- 通知渠道（企业微信/钉钉/邮件）实测
- 私有 npm/PyPI 仓库集成
- 大规模并发压测
- ~~多执行器负载均衡~~ ✅ 第五轮真机通过（双 executor 4 并发精确 2+2、无超卖）
- ~~LOG-11 S3 真机 E2E~~ ✅ 第五轮真机通过（minio 对象 + gunzip 内容一致 + API 读取闭环）
- ~~Leader Election 双实例~~ ✅ 第五轮真机通过（80 execution 无重复、kill 后 35s 接管；V2 复验修复后 96/96 success）

## 本轮变更要点（参考）

- **admin-api**：
  - `task.controller.ts` 新增 `GET /tasks/executions/:execId` 与 `GET /tasks/executions/:execId/logs`（compat alias，供 CLI/MCP 直接按 execId 查询）。
  - `task.service.ts` `getExecutionLogs` / `streamExecutionLogs` 增加 S3 分流；`storeLogLines` callback 路径优先 S3 上传 + 失败回退 DB；新增 enqueue 失败时把 PENDING 行标 FAILED（防 Redis 挂时悬挂）。
  - `executor.entity.ts` 把 executor 上报字段 `version` 重命名为 `executorVersion`，新增 TypeORM `@VersionColumn() version: number`（乐观锁）；`address` 加唯一索引 `uq_executors_address`。
  - `executor.service.ts` `selectLeastLoaded` / `dispatch` / `getTags` / `findAll` 加 `take` 上限；broadcast 路径保留全量（注释说明）。
  - `scheduler.service.ts` 新增「PENDING 超时回收」（10 分钟 grace 后置 FAILED）+ `schedulingTasks` Set 防 reload 与 scheduleOne 同 task 并发注册。
  - `main.ts` `POST /api/executions/callback` 路由单独配 55mb JSON limit（兼容批量回调），其它路由仍 1mb cap。
  - `verify-executor-token.util.ts` fail-closed timingSafeEqual（与 executor-node 端符号对齐）。
  - `task-execution.entity.ts` 新增 `logStorage` / `logObjectKey` 列；迁移 `1717473142690-AddExecutionLogStorage.ts`。
- **executor-node**：deploy/execute/health/logs 路径加固；connectivity 重试；file-logger 截断 marker 与 admin-api LOG-01 检测对齐。
- **admin-web**：`Executor.version → executorVersion`、`auth /me → /profile`、executor shared-token 路由迁移、`any` → `unknown`、未用 imports 删、空 catch 加注释、`_pollStartTime` state 移除；lint 0 errors。
- **acf-cli**：HTTP client 自动拆 ResponseInterceptor envelope；`task create/update/delete/pause/resume/kill/logs`、`app deploy/deployments/versions`、`task executions` 全部走正确路径与字段名。
- **mcp-server**：同 HTTP 拆包；新增 `kill_execution` / `pause_task` / `resume_task` / `list_deployments`；已有 `get_application` / `deploy_application` / `get_execution_logs` 配套。
- **docker-compose.yml**：minio profile（端口 9000/9001，volume，healthcheck）+ admin-api 注入 7 项 `LOG_STORAGE_*` 默认值。

---

## 发版链路打通专项（2026-09-19，v1.5.0 发版轮）

从「CLI 改名 + 接入发布链路」到「v1.5.0 四包全发布」的一整轮，共挖出并修复
**6 个真实缺陷**，其中 4 个只在**真正发版那天**才暴露。按发现顺序：

### ① release-please 被历史 PR 永久卡住（发版阻塞）

推送 main 后 release-please 成功退出但拒绝开 Release PR：
`⚠ There are untagged, merged release PRs outstanding - aborting`。

**根因不是「手工打了 tag」**——钉到代码级：`manifest.ts:1146-1157` 的
`findMergedReleasePullRequests()` 只用 `hasAllLabels(['autorelease: pending'], pr.labels)`
判定 outstanding，**完全不看 tag 是否存在**。PR #4 的标签实测是
`autorelease: pending`（#1–#3 都是 `tagged`），而 v1.2.0 tag 确实打在它的
merge commit 上——tag 打了、标签没更新，于是永久卡死。
**修法**：把 PR #4 标签改回 `autorelease: tagged`（与 #1–#3 一致）即解除。

### ② acf-cli 漏进 manifest → Release PR 把它从 1.4.3 倒退到 1.0.0

卡点解除后 release-please 首次真开 PR（#9），立刻暴露：同批四包中三个正常走
1.4.3→1.5.0，唯独 acf-cli **倒退**到 1.0.0。根因：`release-please-manifest.json`
是「上次发到哪了」的基线，acf-cli 进了 config 却漏进 manifest → 基线丢失 →
被当全新包从 1.0.0 起算。这是上一轮「漏进 linked-versions 卡在 1.0.0」换了
形态复发（那次永不 bump，这次版本倒退）。
**修法**：补 manifest 条目 + 给 `scripts/check-release-config.mjs` 加**第 ⑤ 层**
（config.packages ↔ manifest 双向对齐）。selftest 8 例 / 6 反例，mutation 验证
有牙（移除条目 → 精确报 ⑤ 并 exit 1）。

### ③ e2e-full-windows 长期全红：venv 相对路径在 cd 之后失效

`env: 'apps/executor-python/.venv/Scripts/python.exe': No such file or directory`。
不是「venv 没装」（CI 日志可见 pip 安装成功），而是：探测分支在**脚本工作目录**
测出相对路径，启动段却 `cd apps/executor-python` 后再用它 → 失效 → 进程根本没
起 → 空等 60s 超时，把人引向「服务起得慢」。对照 executor-node 用 `node dist/main.js`
（命令名，与 cwd 无关）所以从不踩坑。
**修法**：转绝对路径 + 加启动前 `-x` 断言（真出问题时立刻报错，不等 60s）。
修后**用例 49（Python 执行器全链）在 Windows 上首次真正通过**。
注：该 job 只在 PR 事件触发，历史只真跑过 2 次、两次都红，push 轮全是
skipped 故长期看不出来。

### ④ 文档站版本声明不在 release-please 管理面内 → 每次发版必红 + 文档站停部署

release-please 只 bump 代码侧，docs-site 五个页面的版本声明无人同步。后果比
CI 红更严重：`docs-site-deploy.yml` 跑同一个 sync-check，**失败即不部署**——
即每次发版后文档站停止更新、停在旧版本误导用户。历史已红 2 次。
**修法**：10 处声明加 `x-release-please-version` 标记 + 五个 md 登记进
extra-files（路径须写 `/packages/docs-site/...` 根路径形态，release-please 的
`addPath()` 禁止 `../`）。
顺带修：`release.md` 版本矩阵表格里的版本号长期漂移却是**校验盲区**（守卫只
认「当前 X.Y.Z」/「lockstep X.Y.Z」两种措辞，表格行不匹配）。判据改为「凡带
标记的行必须等于事实源」，让判据面与 release-please 更新面**同源**。

### ⑤ PyPI Trusted Publishing 未登记 → publish-pypi 失败

`invalid-publisher: valid token, but no corresponding publisher`。不是配置写错：
`a4dad9b` 在工作流里完成了 OIDC 迁移，并把登记写成 **commit message 里的
「发布前唯一待办的外部手动步骤」**——commit message 不是清单，没人会翻。
v1.4.3 及以前走 `secrets.PYPI_API_TOKEN`，掩盖了缺口；v1.5.0 是第一次真正走
OIDC，必然失败。**修法**：在 pypi.org 登记 Trusted Publisher（参数已固化进
`docs/release-checklist.md` 4.2.1 与 release.yml 注释）。

### ⑥ SDK 发版抢占 GitHub latest → 全量装机用户桌面更新 404（结构性复发）

客户端报 `Cannot find latest.yml ... releases/download/v1.5.0/latest.yml 404`。
electron-updater 的 github provider **硬编码查 `/releases/latest`**
（`GitHubProvider.js:162`），**无法**指定 tag（`channel` 只改文件名不改 latest
选择）。而 round-14 把桌面解耦成 `desktop-v*` 后，**两条 tag 线仍共用同一个
GitHub Releases 池**：`v*` Release 是 SDK 发版产物、**0 资产**，一旦比
desktop-v* 新就抢占 latest。**每次 SDK 发版都会复发**。
**修法**：`release.yml` 新增 `demote-sdk-release` job，自动把 `v*` Release 标为
prerelease（GitHub latest 判定排除 prerelease）→ 永久退出竞争。
- 未采纳 `skip-github-release`：其 action 描述是 "do not try to **tag** releases"，
  启用会连 tag 都不打、`release.yml` 由 tag 触发 → **彻底断掉发布链路**。
- 未采纳「同一 repo 改用具体 release assets」：源码已证无指定 tag 的入口。

### v1.5.0 发布结果

`@autocodeflow/sdk` / `autocodeflow-mcp-server` / `@autocodeflow/cli`（**首次
发布**，包名从被占用的 `acf-cli` 改来）/ `autoflow-sdk`(PyPI) 四包全部 1.5.0；
文档站线上 1.5.0；自动打 tag 与自动建 Release **均已打通**（此前
「人工 tag 仍是主路径」的清单已更新为废弃）。

### 方法学教训（两条，可复用）

1. **仓库外的手动步骤必须写进发版清单，不能只写进 commit message**。本轮 ⑤
   （PyPI 登记）与 ⑥（latest 核对）都是这个模式：工作流改了、外部步骤没做、
   发版当天才炸，且报错**不指向**缺失的那一步，排查成本高。
2. **判定"修好了"必须看可观测事实，不能看 CI 绿**。本轮多次遇到「CI 绿但没
   验证到」：e2e job 因并发取消显示 skipped、`gh run rerun` 后 Release PR 判定
   `remained the same` 而没重算 extra-files——都靠回到日志/API 逐条核对才定位。
