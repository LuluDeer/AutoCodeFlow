# AUTONOMY-STATE — 状态卡（R138 收尾交接版 · ≤50 行）

**基线**：`35238b20`（`git log -1`）· **5 worker 并行** · **守卫链 101 段**（HEAD 实测：`test:guards:chain` 按 `&&` 切 **101** 段，第 11/12 段仍是 `check:actions-pinned` / `check:runner-labels`，末段 `check:coverage-floor`）· 工作区干净
**会话**：第 138 轮 · 并行第 68 批

## 本轮落地（2 项，均已复核）
1. **覆盖率棘轮扩 executor-node + 修「测量失败仍绿」**（`47b63253`）：
   - `npm run coverage:node` 真跑 `jest --coverage --coverageReporters=json-summary`（**先删陈旧 summary**、只取 `total.lines.pct`，合并进 `docs/health-baseline.json` **既有 node 步**，不重排不丢步）；node floor **88.88**（首建取实测，未取整）；
   - 判据新增「`step.code≠0` **或** `signal` 非空 ⇒ 红（**pct 不可信**）」+ `END_LABEL_HINTS` 加 node + 跑法按端取 + selftest **4→7**；
   - **实测**：`coverage:node` **0**（88.88%，17–18s）· `check:coverage-floor` **0**（比较 2 端）· selftest **7/7 = 0** · `test:guards:repo` **0（101/101）** · `size-caps` **0**；
   - **反证**：floor→`99.99` ⇒ **1**「差 11.11pt」；`code→1` ⇒ **1**「pct 不可信」（**旧实现此处为绿**）。均复原。
2. **A6b「消耗下一个 cron 计划点」入口**（`35238b20`）：
   - `api/tasks.ts` trigger 第 4 参（**仅 `=== true` 加键** ⇒ 未勾选逐字节不变）；两处弹窗**仅 cron** 渲染、**隐藏而非禁用**（对齐后端 400）；开弹窗重置；文案 `firePoint.consume.*`；2 文件 **12 例**；
   - **实测**：vitest 12 例 **0** · `typecheck:web` **0** · `lint:web` **0** · `i18n-key-check` **0** · `size-caps` **0**（两页非注释行 **1039→1034** / **715→711**，**上限未上调**）；
   - **反证**：「仅 cron」改恒真 ⇒ 两页用例③各红；删 api 加键 ⇒ 用例③④红。均复原。

## 教训（238–241）
- **238 状态卡的「前提」也要核**：状态卡写「三端都没开 `--coverage`」，实测三端配置/阈值/CI **早已存在**，真缺口只有一行「快照脚本不传 `--coverage`」——照前提立项＝重做一遍已有功能；
- **239 守卫要同时判「数字」与「测量是否成功」**：只看 `coveragePct` 不看 `step.code`/`signal`，测试套件挂了照样绿，因为数字是**上一轮的旧值**（旧值是真的，只是属于另一个状态）；
- **240 已签上限用满的文件，用「等价压缩 + 外提」换行数**：不调高 ceiling、不 ALLOW 关灯；出路不是「不做」；
- **241 并行写者会让全链在别人的段位红**：判红**先定位段位归属**（这段是谁的在途改动/哪个写域），再看是不是自己。

## 剩余 backlog（`§7.0` 现有 **8** 条的性质）
- **`needs-fix` 5**：`coverage-floor-freshness`（新，不校验 `generatedAt` 新鲜度）· `f-2-misfire-no-ui`（新，README 宣称但全前端无控件）· `ui-p2-1-sop-video-states` · `ui-p2-2-exec-packages-crosspage` · `ui-p2-3-sse-background-tab`（后三条均带 `文件:行号`）；
- **`unverified` 2**：`ci-pg-race-unverified`（需 CI 真跑，本地不可解）· `web-flake-not-reproduced`（nightly `web-flake-watch` 已有持续采样，等观测）；
- **`needs-ops` 1**：`release-notice-ops`（公告已写，发布属运维）。

## 候选池（已排序，**不进主表**）
1. **UI P2 三连**（`SopFromVideoPage.tsx:268` / `ExecutorPackagesPage.tsx:523` / `api/sse-client.ts:314`）——已上台，作下轮首项；
2. **F-2 misfire 无控件**——已上台，待裁定「补控件 vs 收 README 口径」；
3. **覆盖率扩 admin-api**（估 180–310s；node 已跑通模板，web 774s 且插桩有 flake 史 ⇒ 排在后面）；
4. **F-3 OTel traces 收文档口径**（`README.md:298`/`:831` 宣称已交付，实无 SDK/exporter；`deployment.md:785` 自认 span 未出站）——纯文档收口，无代码；
5. **F-4 / F-5 入口**（模板导入端点已存在但文档写「本轮未做」、前端/CLI/MCP 无入口；任务定义导入导出 CLI/MCP 有、控制台无）；
6. **P3 三连**（`SopsPage.tsx:1091` / `ExecutorPackagesPage.tsx:507` / `SopFromVideoPage.tsx:213`）。

## 下轮第一步（建议：UI P2 三连）
- **写域**：`apps/admin-web/src/pages/SopFromVideoPage.tsx` + `apps/admin-web/src/pages/ExecutorPackagesPage.tsx` + `apps/admin-web/src/api/sse-client.ts`（**三文件同 owner**，互不重叠）；
- **判据**：先红后绿的单测（每条至少一条会**在还原后转红**的用例）+ `typecheck:web` + `lint:web` + `node scripts/check-size-caps.mjs` + `npm run test:guards:repo`；
- **注意**：两页已顶格（`functionLines` 1012 / 893）⇒ 只许净降或等价压缩（教训 240）；`sse-client.ts` 改可见性语义须覆盖「后台不建流 / 回前台补建」两条，别只改一行 `void connect()`。

## 方法学（累积）
只信「命令 + 真实 exit code」；**数字要写明哪个状态的实测**；**Lead 自己的文件也在门禁里**；**定点断言要手改**；**棘轮只向收紧方向走**；**数据缺失即红**；**否证一个提法比实现它更有价值**；**「现在没坏」≠「可以拆」**；**零回填要用「迁移前就存在的行」证明**；**写域边界 = 停手 + 给可粘贴内容**；**「判据没红」≠「问题不存在」**；**判据要盯正确对象**；**否决条件只对真判据生效**；**台账按证据记**；**测量工具会撒谎**（累计 5 次）；**同一列两种相反语义会互相抵消**；**不变量有适用范围**；**没有 dump 不归因产品**；文档与实测要对账；验收用链内同形式；收紧判据后复验原反例；守卫防「先咬自己」；**守卫头注要与实现一致、盲区要写出来**；**生成物不手改**；**元数据也会撒谎**；**行为判据 ≠ 接线判据**；**flake 不许 retry 掩盖**；**采样频率匹配时间尺度**；**改 CI 片段先跑 actions-pinned/runner-labels**；**版本与 SHA 复用仓库惯例**；前缀式清理/固定临时路径是并行互杀源；样本量不足的绿不算绿；「期望值同源」≠ oracle 成立；假 oracle 要删；抖动段不挂门禁；基线撞上限不许调上限；**基线只来自真跑**；一次只改一个文件；定位代码块只用 CodeGraph；断言源码文本必须登记；**不编造 sha**；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**；**状态卡的前提也要核**（238）；**判「数字」也要判「测量是否成功」**（239）；**顶格文件用等价压缩换行数**（240）；**判红先定位段位归属**（241）。
