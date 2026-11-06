# AUTONOMY-STATE — 状态卡（R140 收尾交接版 · ≤50 行）

**基线**：`8996b82b`（`git log -1`）· **2 个落地提交**（均已由 Lead 复核）· **守卫链 101 段**（HEAD 实测：`test:guards:repo` **101/101 = exit 0**；末段 `check:coverage-floor` —— 本轮改的就是它）· 工作区干净
**会话**：第 140 轮 · 并行第 70 批 · 台账 writer（四份台账 + `artifacts/autonomy/R140/ledger.md`）

## 本轮落地（2 项，均已复核）
1. **覆盖率棘轮加「数据新鲜度」判据（`e5aa8e80`）**：
   - **缺口**：棘轮只读 `docs/health-baseline.json` 的 `coveragePct`，**不校验新鲜度** —— `generatedAt` 由 `scripts/health-snapshot.mjs:298` 写入却**无任何守卫读它** ⇒ 拿几周前的旧基线照样判绿；
   - **为什么现在要紧**：R138 扩到 node 后单端刷新 17–18s；再扩 admin-api（180–310s）/ web（774s）就是 **5–13min/端** ⇒ 会逼人复用旧快照（棘轮长期拿旧数字判绿，正是它要防的事）；
   - **修法**：基线每端可选 `maxAgeDays`（正整数，**粒度=自然日**）。声明了 ⇒ `generatedAt` 缺失/不可解析 ⇒ 红「无法判断新鲜度」；超期 ⇒ 红并点名过期天数+上限，且**不再比 floor**，报文给该端刷新跑法；未声明 ⇒ 不因新鲜度红（盲区写进头注，汇总行印「未声明 K 端」）；
   - **两端均 14 天并写 `maxAgeDaysWhy`**：原缺口是「几周前旧基线」（21 天必红）；下界由体检节奏定（解红唯一路径是 30–40min 全量体检 ⇒ 3–7 天「周末必红」、30+ 等于没判）；同一 `generatedAt` 是**文件级** ⇒ 两端不同窗口只会造「一绿一红」假分歧；
   - **实测**：`check:coverage-floor` **0**（比较 2 端；新鲜度判 2 端）· selftest **7 → 13**（**13/13 = 0**）· `size-caps` **0** · `script-main-guard` **0/0**；
   - **反证（均还原）**：① `generatedAt` 改 2026-10-01 ⇒ exit 1「已过期 37 天（上限 14 天）」+「不判覆盖率高低」；② 删某端 `maxAgeDays` ⇒ 不因新鲜度红、exit 0；
   - **已知盲区（写进头注）**：`--skip-heavy` 前移 `generatedAt` 但不重跑全量；单端刷新只改 `coveragePct` 不动 `generatedAt` ⇒ 真跑新了也解不了红。根治 = per-step 时间戳（生成物语义，本轮不动）。
2. **「错失计划落点策略」控件（F-2 · `8996b82b`）**：
   - **缺口**：`README.md:295`/`:830` 把 misfire 策略与 blockStrategy 并列宣称为执行策略能力，但**全前端无控件**（grep 只命中提交白名单）⇒ UI 用户只能拿到库默认 `ignore`，已渲染的「补偿触发」**永不产生**；
   - **修法**：`TaskFormTriggerSection.tsx` 在 blockStrategy 后加 `misfireStrategy` Select —— **仅 cron/fixed_rate 渲染**（后端 `scheduler.service.ts:1300-1306` 只对这两类判 misfire）⇒ 隐藏而非禁用；编辑态回填 `?? 'ignore'`；**周期触发下总是显式发有效值**（PATCH 缺省=保留旧值，缺省会留下旧 `fire_once`）、非周期 `preserve={false}` 缺省不发、**全程不发 null**（列 NOT NULL default ignore）；
   - **顺带删陈旧豁免**：`scripts/web-type-field-drift-baseline.json` 的 `Task missing:misfireStrategy`（手写类型已跟进 ⇒ 删条目才是收紧）；
   - **实测**：新用例 **5/5** · task-form-* + template-prefill **167 例 = 0** · `typecheck:web`/`lint:web`/`i18n-key-check`/`size-caps`/`check:user-facing-language`/`check-web-type-field-drift` 全 **0**；
   - **反证**：「仅 cron/fixed_rate」改恒真 ⇒ 用例③④ 红（2 failed | 3 passed，exit 1）；还原 ⇒ 5 passed；
   - **遗留**：create 态选 cron 后控件初始为空态（加 `initialValue` 会改「非周期缺省」口径，**未做**）；`TaskFormTriggerSection` 最长函数 **268/300**，下次该分区加字段建议外提子组件。

## 教训（246–249）
- **246 台账/守卫基线的「陈旧条目」也要删**：`missing:misfireStrategy` 豁免因手写类型跟进而失效 ⇒ 它成了**永远不可能再红的登记**；**删条目才是收紧**，登记代替删除会让棘轮永远收不紧（承 243：243 说内容该修不该登记，本条说已修好后登记该删不该留）；
- **247 判据的粒度必须与被测字段的粒度一致**：`generatedAt` 只有 `YYYY-MM-DD`（`localDateString`，无时刻）⇒ 用天数口径（`maxAgeDays`），小时级判断必然误红；设计判据先问「这个字段最细能分辨到哪」；
- **248 过期数据不该参与大小比较**：超期时只报「过期」、**不再比 floor** —— 过期数字的高低都不构成关于现在的结论；否则会出现「数据过期但覆盖率达标 ⇒ 绿」（同族 239：239 判测量是否成立，本条判数字是否属于现在）；
- **249 同一份数据源的两端不要给不同窗口**：`generatedAt` 是文件级的，两端不同 `maxAgeDays` 只会造「一绿一红」假分歧，读的人会去追不存在的端间差异；窗口该由**刷新路径**决定，不由各端「重测多贵」决定。

## 剩余 backlog（`§7.0` 主表 **3** 条，本轮 5 → 3）
- **`unverified` 2**：`ci-pg-race-unverified`（需 CI 真跑 PG，本地不可解）· `web-flake-not-reproduced`（nightly `web-flake-watch` 已有持续采样，等观测）；
- **`needs-ops` 1**：`release-notice-ops`（公告已写，发布属运维）；
- 三条**重启条件都不在自治循环内** ⇒ 主表停在 3 是事实，不是漏收。

## 候选池（已排序，**不进主表**；均从 R139 候选池继承，仍未做）
1. **P3-1 指派弹窗错误态**——`SopsPage.tsx:1091` 把「可接单执行器读取失败/加载中」显示成「没有可接指派的执行器」并给出错误处置建议（与 P2-1 同型）⇒ **下轮首项**；
2. **`check-user-facing-language.mjs --update` 反向拉低上限**——它写 `maxKnown: keys.length` ⇒ 建议 `Math.max(prev, len)`（本轮 known 9→8 是手工改的；自动化会把上限往下拽，棘轮方向反了）；
3. **`docs/deployment.md:775` 版本漂移**——文档钉 `@opentelemetry/api ^1.9.1`，实际 `apps/admin-api/package.json:47` 是 `^1.10.0`；
4. **F-4 模板导入端点无入口**——端点已存在，但文档 `docs/skills/manifest-contract.md:136` 与 `docs/api-reference.md:1600` **自相矛盾**（一处说本轮未做、一处已写），且前端/CLI/MCP 无入口；
5. **F-5 任务定义导入/导出控制台无入口**——CLI/MCP 有，控制台无；
6. **coverage 扩 admin-api**（估 180–310s；web 774s 且插桩有 flake 史，排后）——**先解双 step 标签**：`docs/health-baseline.json` 有两个含 admin-api 的 step，`.find` 只取第一个 ⇒ 会静默比错那一个；
7. **棘轮 per-step 时间戳**——根治 `--skip-heavy` 前移 `generatedAt` 的盲区（与第 6 项可同一轮）。

## 下轮第一步（建议 P3-1 `SopsPage.tsx:1091`）
- **缺口**：把「可接单执行器读取失败 / 加载中」误报成「没有可接指派的执行器」，并给出**错误处置建议**（同 P2-1 的「一个布尔表达三态」形态）；
- **判据**：一个**先红后绿**的单测（失败态与加载态各自可辨、失败态带重试且不锁死主操作）+ `typecheck:web` / `lint:web` / `size-caps` / `test:guards:repo`；
- **注意**：先查 `scripts/source-size-baseline.json` —— 该页若已顶格，按方法学 240「等价压缩 + 外提」换行数，**不许调高 ceiling**。

## 方法学（累积）
只信「命令 + 真实 exit code」；**数字要写明哪个状态的实测**；**Lead 自己的文件也在门禁里**；**定点断言要手改**；**棘轮只向收紧方向走**；**数据缺失即红**；**否证一个提法比实现它更有价值**；**「现在没坏」≠「可以拆」**；**零回填要用「迁移前就存在的行」证明**；**写域边界 = 停手 + 给可粘贴内容**；**「判据没红」≠「问题不存在」**；**判据要盯正确对象**；**否决条件只对真判据生效**；**台账按证据记**；**测量工具会撒谎**（累计 5 次）；**同一列两种相反语义会互相抵消**；**不变量有适用范围**；**没有 dump 不归因产品**；文档与实测要对账；验收用链内同形式；收紧判据后复验原反例；守卫防「先咬自己」；**守卫头注要与实现一致、盲区要写出来**；**生成物不手改**；**元数据也会撒谎**；**行为判据 ≠ 接线判据**；**flake 不许 retry 掩盖**；**采样频率匹配时间尺度**；**改 CI 片段先跑 actions-pinned/runner-labels**；**版本与 SHA 复用仓库惯例**；前缀式清理/固定临时路径是并行互杀源；样本量不足的绿不算绿；「期望值同源」≠ oracle 成立；假 oracle 要删；抖动段不挂门禁；基线撞上限不许调上限；**基线只来自真跑**；一次只改一个文件；定位代码块只用 CodeGraph；断言源码文本必须登记；**不编造 sha**；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**；**状态卡的前提也要核**（238）；**判「数字」也要判「测量是否成功」**（239）；**顶格文件用等价压缩换行数**（240）；**判红先定位段位归属**（241）；**任务书的前提也要实测核**（242）；**登记代替修复是反模式**（243）；**并行撞同一文件按根因裁决**（244）；**守卫转红先定位段位归属**（245）；**陈旧登记要删不要留**（246）；**判据粒度对齐字段粒度**（247）；**过期数据不参与大小比较**（248）；**同一数据源两端同一窗口**（249）。
