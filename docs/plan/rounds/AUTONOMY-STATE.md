# AUTONOMY-STATE — 状态卡（R139 收尾交接版 · ≤50 行）

**基线**：`4c88dac0`（`git log -1`）· **3 个落地提交**（均已由 Lead 复核）· **守卫链 101 段**（HEAD 实测：`test:guards:chain` 按 `&&` 切 **101** 段；第 11/12 段仍是 `check:actions-pinned` / `check:runner-labels`，末段 `check:coverage-floor`，**第 34 段** = `check:user-facing-language`）· 工作区干净
**会话**：第 139 轮 · 并行第 69 批

## 本轮落地（3 项，均已复核）
1. **OTel「traces 已交付」宣称收口（纯文档 · `d7d27f39`）**：
   - README 特性表/技术栈/profile 注释把 traces 当已交付（含 `--profile jaeger`），教程 01 写「开启 OTEL 后可到 Jaeger 查全链路」；
   - **实测**：admin-api 直接依赖只有 `@opentelemetry/api`（`apps/admin-api/package.json:47`）、**无 sdk-*/exporter**（仓内 `sdk-metrics` 命中全在 `node_modules` 传递依赖），`OTEL_EXPORTER_OTLP` 在 `.ts` **0 命中**，而 `docs/deployment.md:785` **自认「平台 span 尚未出站」** ⇒ **Jaeger UI 恒空**；
   - **修法**：区分「Jaeger profile 可启动」与「span 尚未出站（仅进程内 `[trace]` 日志）」+ 给升级路径（`TracerProvider` + `OTEL_EXPORTER_OTLP_ENDPOINT`→`jaeger:4317`）；README.zh/en 走 **readme-sync 口径重生成**；`docs/deployment.md` **一行未动**（它是可信来源）；
   - **实测**：`test:docs` **0** · `check:brand-drift` **0**（21/21）· `check-size-caps` **0**。
2. **UI P2-1 三态 + P3-3 rejection + P2-3 后台 SSE（`66b87e16`）**：
   - P2-1：一个 `length===0` 混表达「加载中/失败/真空」⇒ 新增 `pages/sop-from-video/{useVideoProviders.ts,ProviderStatusAlert.tsx}`（`loading|ready|error` + reload 重试 + 卸载守卫）；失败用既有 `StateError` 带**重试**，`disabled` = 加载中 **或** (ready 且真空) ⇒ **失败态不禁用**；
   - P3-3：`saveDraft` 裸 `await validateFields()` ⇒ 全仓最后一个常驻 unhandledRejection 漏点 ⇒ 改 try/catch（校验错误不是请求错误）；
   - P2-3：`paused` 恒 false + 末尾无条件 `void connect()` ⇒ 「页面一出生就在后台标签」时从未发生 visible→hidden 转换 ⇒ 流在后台常驻并退避重连、白占 32 个 stream 槽位 ⇒ 改 `startsHidden` 不建流（node/SSR 无 `document` 行为不变）；
   - **实测**：定向 vitest 21 例 **0**；回归 21 文件 **156 例 = 0**；`typecheck:web`/`lint:web`/`i18n-key-check`/`size-caps` 全 **0**（页面 471→429 非注释行 / 473→455 函数）；
   - **反证**：① 红 2 绿 8；② 红 1（抓到 `ValidationError` + `[ACF][unhandledRejection]`）绿 8；③ 红 2（`FakeEventSource` 多建 1 条）绿 8。
3. **UI P2-2 跨页选中 + P3-2 末页删空 + `Universal` 真中文化（`4c88dac0`）**：
   - P2-2：`selectedIds` 无清空路径 ⇒ 翻页后批量删除**零反馈**、跨页混选时确认框条数与批量条不符（**破坏性操作作用域≠提示**）⇒ 结果集任一变化即清空，删除前空则清空+提示、部分残留**先按可见行收窄并如实告知**（`execPkg.batchStale` / `batchNarrowed`）；
   - P3-2：删除成功后无条件 `load()` ⇒ 末页删空渲染「暂无包」而上一页还有满页包（**事实性错误**）⇒ 新增 `afterRemoved(removed)`：本页清空且 `page>1` ⇒ 回退上一页（只按**成功删除**条数算）；
   - **顺带把「`Universal` 面向用户英文文案」这条已登记欠债真正修掉**：改走既有 `install.type.node|python|universal` 词条 + 新增 `packageTypeOptions(t)`；常量与上传弹窗外提到 `pages/executor-packages/`（页面 **773→678** 非注释行 / **929→860** 函数，**基线未上调**）；语言基线 known **9→8**；
   - **实测**：定向 vitest 38 例 **0**；回归 21 文件 **156 例 = 0**；`typecheck:web`/`lint:web`/`i18n-key-check`/`size-caps`/`check:user-facing-language` 全 **0**；`test:guards:repo` **0（101/101）**；
   - **反证**：还原实现 ⇒ P2-2/P3-2 的 **5 条用例红**（红在「last call `page:1`」）恢复 ⇒ 5/5 绿；守卫读取面扩到「页面 + `package-meta.ts`」两处，**判据强度未放宽**。

## 教训（242–245）
- **242 状态卡/任务书的「前提」也要实测核**：任务书写「测试默认英文 locale、push 用例应仍显示 `Universal`」——实测 `apps/admin-web/src/test-setup.ts:69` **全局钉 `localStorage['autoflow-lang']='zh'`** ⇒ 测试渲染「通用」，断言改为 `getByText('通用')`（**判据未放宽**，java/shell 反证保留）；英文界面确实仍是 `Universal`（`apps/admin-web/src/locales/en.ts:1833`）⇒ **债是真的，任务书的 locale 前提是错的**（承 238，对象从**状态卡**扩到**任务书**）；
- **243 「登记代替修复」是反模式 —— 欠债搬家不算修好**：`Universal` 从页面搬到 `package-meta.ts` 仍红（守卫读的是**内容**不是**位置**）⇒ 正确解是**真中文化**（走既有 i18n 词条）⇒ 登记只是把债搬进基线，**基线变短才是修好**；
- **244 并行 writer 撞同一文件时，裁决按「哪种方案更接近根因」，不按谁先到**：本轮 i18n 方案 vs 登记方案，Lead 选 i18n；按「谁先写到」裁决会保住一个明知不修根因的方案；
- **245 守卫转红先定位「段位归属」**：本轮语言守卫**第 34 段**转红（「基线陈旧」），成因在**别人写域**（两个 writer 同时改 `package-meta.ts` / `ExecutorPackagesPage.tsx` / `scripts/user-facing-language-baseline.json`）⇒ 承 241 的具体化：段位归属 = **哪一段**守卫 + **谁的在途改动**，不是「这条守卫是不是我关心的」。⇒ Lead 裁决「**保留 i18n 方案**」＝**真中文化 > 登记代替修复**，并重新划界。

## 剩余 backlog（`§7.0` 现有 **5** 条的性质）
- **`needs-fix` 2**：`coverage-floor-freshness`（棘轮不校验 `generatedAt` 新鲜度）· `f-2-misfire-no-ui`（README 宣称可配但全前端无控件）；
- **`unverified` 2**：`ci-pg-race-unverified`（需 CI 真跑，本地不可解）· `web-flake-not-reproduced`（nightly `web-flake-watch` 已有持续采样，等观测）；
- **`needs-ops` 1**：`release-notice-ops`（公告已写，发布属运维）。

## 候选池（已排序，**不进主表**）
1. **`f-2-misfire-no-ui`**——README 宣称 misfire 策略可配但**全前端无控件**（`grep -rn misfireStrategy apps/admin-web/src --include=*.tsx` = 0），实体默认 `IGNORE` ⇒ **界面已渲染的「补偿触发」在 UI 用户手里永不产生**（只有 API/CLI 用户能配）⇒ 下轮首项；
2. **`coverage-floor-freshness`**——棘轮**只读数字、不校验新鲜度**（`generatedAt` 无任何守卫读它）⇒ 扩到 admin-api（180–310s）/ web（774s）后会长期拿旧基线判绿；
3. **P3-1 指派弹窗错误态**——`SopsPage.tsx:1091` 把「可接单执行器读取失败/加载中」显示成「没有可接指派的执行器」并给出错误处置建议（与 P2-1 同型，修法见 R138 审计 `artifacts/autonomy/R138/assess-ui.md` P3-1 段）；
4. **F-4 模板导入入口**（端点已存在但文档写「本轮未做」，前端/CLI/MCP 无入口）· 5. **F-5 任务导入导出入口**（CLI/MCP 有，控制台无）；
6. **coverage 扩 admin-api**——估 180–310s（node 模板已跑通；web 774s 且插桩有 flake 史 ⇒ 排在后面）；
7. **`docs/deployment.md:775` 版本漂移**——文档钉 `@opentelemetry/api ^1.9.1`，实际 `apps/admin-api/package.json:47` 是 `^1.10.0`；
8. **`check-user-facing-language.mjs --update` 会自动下调 `maxKnown`**——本轮 known 9→8 是**手工**改的；脚本 `--update` 直接写 `maxKnown: keys.length` ⇒ 建议改 `Math.max(prev, len)`（否则「上限」会被基线长度反向拉低，棘轮方向反了）。

## 下轮第一步（建议：`f-2-misfire-no-ui`）
- **先由 Lead 裁定「补控件 vs 收 README 口径」**：默认按**收 README 口径 + 保留后端**的最小改动（README 写成「本期仅 API/CLI 可配」）；**若 Lead 认为该补控件**，判据是：① 控件的读写面与后端 `misfireStrategy` 字段一一对应（不新增后端语义）；② 有「加载中/失败/真空」三态与重试；③ 先红后绿单测；④ 文案走既有 i18n（不新增面向用户的英文硬编码）；
- **注意**：`README.md:295` / `:828`（zh 同源）是**三语同步**面，改口径须走 readme-sync 口径重生成，**不许手改译文**。

## 方法学（累积）
只信「命令 + 真实 exit code」；**数字要写明哪个状态的实测**；**Lead 自己的文件也在门禁里**；**定点断言要手改**；**棘轮只向收紧方向走**；**数据缺失即红**；**否证一个提法比实现它更有价值**；**「现在没坏」≠「可以拆」**；**零回填要用「迁移前就存在的行」证明**；**写域边界 = 停手 + 给可粘贴内容**；**「判据没红」≠「问题不存在」**；**判据要盯正确对象**；**否决条件只对真判据生效**；**台账按证据记**；**测量工具会撒谎**（累计 5 次）；**同一列两种相反语义会互相抵消**；**不变量有适用范围**；**没有 dump 不归因产品**；文档与实测要对账；验收用链内同形式；收紧判据后复验原反例；守卫防「先咬自己」；**守卫头注要与实现一致、盲区要写出来**；**生成物不手改**；**元数据也会撒谎**；**行为判据 ≠ 接线判据**；**flake 不许 retry 掩盖**；**采样频率匹配时间尺度**；**改 CI 片段先跑 actions-pinned/runner-labels**；**版本与 SHA 复用仓库惯例**；前缀式清理/固定临时路径是并行互杀源；样本量不足的绿不算绿；「期望值同源」≠ oracle 成立；假 oracle 要删；抖动段不挂门禁；基线撞上限不许调上限；**基线只来自真跑**；一次只改一个文件；定位代码块只用 CodeGraph；断言源码文本必须登记；**不编造 sha**；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**；**状态卡的前提也要核**（238）；**判「数字」也要判「测量是否成功」**（239）；**顶格文件用等价压缩换行数**（240）；**判红先定位段位归属**（241）；**任务书的前提也要实测核**（242）；**登记代替修复是反模式**（243）；**并行撞同一文件按根因裁决**（244）；**守卫转红先定位段位归属**（245）。
