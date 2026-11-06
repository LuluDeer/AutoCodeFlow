# AUTONOMY-STATE — 状态卡（R142 收尾交接版 · ≤50 行）

**基线**：`176ef68e`（`git log -1`）· **3 个落地提交**（均已由 Lead 复核）· **守卫链 101 段**（HEAD 实测：`test:guards:repo` **101/101 = exit 0**；末段 `check:coverage-floor`，**未新增链段**）· 工作区干净
**会话**：第 142 轮 · 并行第 72 批 · 台账 writer（四份台账 + `artifacts/autonomy/R142/ledger.md`）

## 本轮落地（3 项，均已复核）
1. **三处过期数字收口 + 语言欠账上限收紧到实测值（`87251fa6` · 纯文档/注释 + 一个基线上限）**：① `docs/deployment.md:775` 写 `@opentelemetry/api ^1.9.1`，实际 `apps/admin-api/package.json:47` 已 `^1.10.0`；② `docs/skills/manifest-contract.md:131` 与 `package.json` 的 `//check:template-manifest` 注释都写「22 例」，实跑 **23/23**；③ `scripts/user-facing-language-baseline.json` 的 `maxKnown` **9 → 8**（= 当前 `known[]` 条目数）。
   - **修法**：版本号**不再写死**，改为「以 package.json 的声明为准，当前 `^1.10.0`」+ 复核命令；计数改 23（并逐条核对该文件其它硬编码数字：name 正则 0,63 / description ≤500 / registry 5 份 / 官方 5 key / 能力域四值 / 退出码 0-1-2 —— **无第二处不一致**）；
   - **实测**：`test:docs` **0** · `check-template-manifest --selftest` **23/23** · `check:user-facing-language` **0**（8 处欠账、上限 8）· `size-caps` **0**；
   - **被否决的提法**：R141 候选池第 5 条「改 `Math.max(prev, len)`」**方向是反的** —— `--update` 在 `keys.length > prevCount && !force` 时**拒绝写盘**，`maxKnown = keys.length` 正是**正确收紧**，`Math.max` 会让上限**永不下降** = 把棘轮**废掉** ⇒ 本轮**收紧到实测值**、**不采纳**。
2. **F-5 任务详情补「导出定义」入口（`57b9cc54`）**：`GET /tasks/:id/export` 后端早已存在（`apps/admin-api/src/modules/task/task.controller.ts:776`），CLI（`packages/acf-cli/src/commands/tasks.ts:725/754`）与 MCP（`packages/mcp-server/src/tools/task-operations.ts:55/67`）都有，**控制台 0 命中** ⇒ 定位 = **能力面不一致**（`docs/api-reference.md:590` 只写「跨环境迁移通道」，**未承诺**控制台入口）⇒ **不改文档**。
   - **修法**：`api/tasks.ts` 的 `exportDefinition` **必须 `responseType:'blob'`**（该端点 `@Res()` 直写附件、**绕过全局信封**）；文件名只在 `Content-Disposition`，共享 client 的拦截器把 AxiosResponse 拆成 `res.data`（**头在那层就丢了**）⇒ per-request `transformResponse` **在拦截器之前**把头读进闭包；RFC 6266 两级回退 + `sanitizeExportFilename`（控制字符按**码点**剔除以避免 `no-control-regex`、截 120 字符），头缺失回落 `<task.name>-<UTC 时间戳>.json`。新 `pages/task-detail/useTaskDefinitionExport.ts`：`inFlightRef` **同步闸门** + `exporting` 界面态；失败走既有 `showApiError`（幂等不双弹）。**不加 `isAdmin` 门控**（读面操作，后端权限同 `GET /tasks/:id`）；
   - **体量**：`TaskDetailPage` 非注释 1034→**1037 / 上限 1039**、最长函数 1012→**1010**；**未调 ceiling、未用 ALLOW、未删逻辑**。**实测**：新用例 **5/5** · task-detail-* 回归 6 文件 **23 例 = 0** · `typecheck:web`/`lint:web`/`i18n-key-check`/`size-caps`/`check:user-facing-language` 全 **0**。**反证**：去掉 `responseType:'blob'` ⇒ 用例③红；去掉 `inFlightRef` ⇒ 用例①红（连点发 2 个请求），均逐字节还原。
3. **覆盖率棘轮扩到 admin-api（第三端）+ 双 step 选步确定性（`176ef68e`）**：admin-api 的覆盖率配置与 CI `--coverage` **早已存在**，但体检/快照脚本**从不传** `--coverage` ⇒ 该端没有 `coveragePct`、棘轮**读不到**。
   - **修法**：`scripts/coverage-snapshot.mjs` 扩 `--end=admin-api`（真跑 `npx jest --coverage --coverageReporters=json-summary --maxWorkers=2`，**必须 `--maxWorkers=2`** 否则本机 12 worker 被 SIGTERM），读 `coverage/coverage-summary.json` 的 `total.lines.pct`，合并进**默认环境** admin-api step。**双 step 陷阱**：`docs/health-baseline.json` 有**两个**含 admin-api 的 step，旧 `.find` 只取第一个 ⇒ 改为**确定性规则**（label 含 hint 且**不含** `SELFTEST_SKIP_ENV_FILE`）；只剩 SELFTEST 那步有 pct ⇒ **红**，不许拿错数据顶替。floor **92.76**（真实实测、**未取整放宽**）+ `maxAgeDays: 14`；selftest **13 → 19 例**；
   - **实测**：`coverage:api` **0**（lines **92.76%**、148s）· `check:coverage-floor` **0**（比较 **3** 端 / 新鲜度判 3 端）· selftest **19/19**。**反证**：floor 调 99.99 ⇒ exit 1「差 7.23pt」；删默认环境步 pct 只留 SELFTEST ⇒ exit 1「拿不到覆盖率数据」（**未**拿 99.5 顶替）。**棘轮现纳管 3 端**：python **87.45** / node **88.88** / admin-api **92.76**。

## 教训（254–257）
- **254 「指向事实源」优于「写死正确值」**：版本号这类**会腐烂的字面量**，写死新值只是把腐烂点换个位置；改成「以 package.json 的声明为准 + 复核命令」后文档自己不会成为下一个腐烂点。判据 = **这份字面量的真实来源在哪？**来源存在 ⇒ 指向它；来源不存在 ⇒ 才写死，并写明怎么复核；
- **255 收紧上限要真的收紧**：`maxKnown` 是「登记项数上限」这张豁免的**裸数字**，多 1 就留了一个「能再登记一条欠账而不红」的口子 ⇒ 9→8。反向也成立：`Math.max(prev, len)` 会让上限**永不下降** = 把棘轮废掉 ⇒ **否证一个提法比实现它更有价值**；
- **256 扩一个数据源时要同时检查「谁还会重写这份数据」**：本轮**只**接了 `coverage-snapshot.mjs` 这一条写基线的路径，而 `scripts/health-snapshot.mjs:249` 的同端 step **仍不带 `--coverage`** ⇒ 这是「**接线只接了一半**」的另一形态：新增**读取端**时必须把**所有写入端**一起点名；
- **257 双 step / 多匹配选步必须写确定性规则，不能靠「碰巧第一个」**：`docs/health-baseline.json` 里两个 step 的 label 都含 "admin-api"，旧 `.find` 只取第一个 ⇒ 文件顺序一变就**静默比错**。承 236/245：匹配必须唯一且可解释，匹配到 0 个或 >1 个都要显式处置。

## 剩余 backlog（`§7.0` 主表 **4** 条，本轮 3 → 4）
- **`needs-fix` 1**：`coverage-snapshot-vs-full-health`（**R142 扩端引入的结构性陷阱** ⇒ 属「当前该做什么」，**进主表**）；
- **`unverified` 2**：`ci-pg-race-unverified`（需 CI 真跑 PG，本地不可解）· `web-flake-not-reproduced`（nightly `web-flake-watch` 已有持续采样，等观测）；
- **`needs-ops` 1**：`release-notice-ops`（公告已写，发布属运维）；
- 后三条**重启条件都不在自治循环内** ⇒ 主表停在 4 是事实，不是漏收。**F-5 与 F-4 此前不在主表** ⇒ 按「不要往主表加再迁走」只在 **A-6（R142）** 留痕；**F-6（导入入口）= 已裁定不做**，不是待办。

## 候选池（已排序，**不进主表**）
1. **health-snapshot 接 admin-api coverage**（工作量 **S**，下一轮第一步）—— `scripts/health-snapshot.mjs:249` 的 admin-api 默认环境步**不带 `--coverage`** ⇒ 跑一次**全量体检**（30–40min）就会把该 step 重写为「无 `coveragePct`」、棘轮**随即红**。修法 = 该步接上 `--coverage --coverageReporters=json-summary` 并解析 `total.lines.pct`（**同 executor-node 臂** `scripts/health-snapshot.mjs:265-287`），且「读不到 pct ⇒ 写 null 而非沿用旧值」。**判据**：`npm run health:snapshot -- --skip-heavy` = 0 且 admin-api step 的 `coveragePct` 不丢；再跑 `npm run check:coverage-floor` = 0；
2. **棘轮 per-step 时间戳** —— 根治 `--skip-heavy` 前移 `generatedAt` 但**不重跑全量**的盲区（生成物语义）；**可与 1 同轮做**（同一写域 `scripts/health-snapshot.mjs`）；
3. **`npm run lint:i18n` 的既有红** —— `apps/admin-web/src/test-setup.ts:149/150/175/176` 六处硬编码中文界面串。本轮**实测确认非新引入**（该文件最后一次改动是 `61a0bc27`（R102-C1），与本轮三提交无关；stash 本切片后同样红）⇒ 修好即可让该门禁**可用**（不是本轮引入的债，但它是**既有红**里唯一可自主清的）；
4. **CLI/MCP 补 A6b `consumeNextFirePoint`** —— 前端已有（`apps/admin-web/src/api/tasks.ts` 的 `tasksApi.trigger` 第 4 参 + 3 条词条，R138 落地），**CLI/MCP 仍零入口** ⇒ F-1 残差，工作量 M；
5. ~~`manifest-contract.md:131` 写「22 例」实为 23~~ —— **已随 R142 修**（`87251fa6`），**无需再做**；
6. ~~`docs/plan/rounds/AUTONOMY-STATE.md` 里「自相矛盾」措辞已随 R141 收口过时~~ —— **已按实际改写**（本文件整篇刷新为 R142 收尾交接版，**不再是待办**）。

## 方法学（累积）
只信「命令 + 真实 exit code」；**数字要写明哪个状态的实测**；**Lead 自己的文件也在门禁里**；**定点断言要手改**；**棘轮只向收紧方向走**；**数据缺失即红**；**否证一个提法比实现它更有价值**；**「现在没坏」≠「可以拆」**；**零回填要用「迁移前就存在的行」证明**；**写域边界 = 停手 + 给可粘贴内容**；**「判据没红」≠「问题不存在」**；**判据要盯正确对象**；**否决条件只对真判据生效**；**台账按证据记**；**测量工具会撒谎**（累计 5 次）；**同一列两种相反语义会互相抵消**；**不变量有适用范围**；**没有 dump 不归因产品**；文档与实测要对账；验收用链内同形式；收紧判据后复验原反例；守卫防「先咬自己」；**守卫头注要与实现一致、盲区要写出来**；**生成物不手改**；**元数据也会撒谎**；**行为判据 ≠ 接线判据**；**flake 不许 retry 掩盖**；**采样频率匹配时间尺度**；**改 CI 片段先跑 actions-pinned/runner-labels**；**版本与 SHA 复用仓库惯例**；前缀式清理/固定临时路径是并行互杀源；样本量不足的绿不算绿；「期望值同源」≠ oracle 成立；假 oracle 要删；抖动段不挂门禁；基线撞上限不许调上限；**基线只来自真跑**；一次只改一个文件；定位代码块只用 CodeGraph；断言源码文本必须登记；**不编造 sha**；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**；**状态卡的前提也要核**（238）；**判「数字」也要判「测量是否成功」**（239）；**顶格文件用等价压缩换行数**（240）；**判红先定位段位归属**（241）；**任务书的前提也要实测核**（242）；**登记代替修复是反模式**（243）；**并行撞同一文件按根因裁决**（244）；**守卫转红先定位段位归属**（245）；**陈旧登记要删不要留**（246）；**判据粒度对齐字段粒度**（247）；**过期数据不参与大小比较**（248）；**同一数据源两端同一窗口**（249）；**过期事实先核时间戳再改文档**（250）；**补入口前先问会不会撞已知拒绝**（251）；**日期按守卫时区口径写**（252）；**读取失败 ≠ 空列表**（253）；**指向事实源优于写死正确值**（254）；**收紧上限要真的收紧**（255）；**扩数据源时同时点名所有写入端**（256）；**多匹配选步必须写确定性规则**（257）。
