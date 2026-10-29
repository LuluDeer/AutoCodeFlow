# web-ux 审计（2026-10-29 · 第 3 轮）

> 域：`apps/admin-web/src`（React 19 + Vite 8（rolldown）+ antd 6 + i18next）——交互、无障碍、包体与首屏。
> 只读审计：未修改任何源码、未跑全量测试、未做 git 写操作。

## 1 范围与方法

**代码探查（CodeGraph 优先）**：`codegraph status` 确认索引新鲜（1972 文件 / 38k 节点），随后按
`codegraph` 语义检索 + 定点 `read` 推进；admin-web 的路由/页面/hook 入口先用 `router-pages.tsx`
→ `router.tsx` → 页面逐个收窄，不整模块通读。配置面（`vite.config.ts`、`nginx.conf`、
`lighthouserc.json`、`package.json`）与全文检索（英文硬编码、`visibilityState`、
`aria-*`、`refetchInterval`、`catch {}`）走 grep，因为 CodeGraph 不索引这些判据。

**实际跑过的度量**（不是估算）：

1. 复用工作区内既有的 `apps/admin-web/dist`（与 `vite.config.ts` 当前内容一致：`vendor-charts` 等
   chunk 名与 manualChunks 定义吻合，`dist/index.html` 里 monaco 已不在 preload 列表，与 PERF-01 修复一致）
   → 解析 `dist/index.html` 的 `modulepreload` / `entry` / `stylesheet`，用 `gzip` 实测每块体积：

   | 指标 | 实测值 |
   |---|---|
   | 首屏请求数（22×modulepreload + entry + css） | **24** |
   | 首屏 JS+CSS 合计（gzip -6，与 nginx `gzip_comp_level 5` 同量级） | **623.9 KB** |
   | 其中 `vendor-charts`（recharts） | **382.0 KB raw / 108.3 KB gz = 17.3%** |
   | 其中 `i18n`（i18next + zh/en 词典） | **595.3 KB raw / 180.3 KB gz = 28.9%** |
   | 其中 entry `index-*.js` | 268.8 KB raw / 85.6 KB gz |

2. 词典源文件实测：`zh.ts` 234.6 KB raw / 73.6 KB gz，`en.ts` 240.6 KB raw / 66.5 KB gz（各 3591 行）。

3. 未跑 `npx vite build`——工作区 `dist` 已与当前 `vite.config.ts` 的 manualChunks 逐项吻合
   （vendor-charts / vendor-query / vendor-utils / vendor-react 四块俱全，monaco 不在 preload），
   重新构建只会再花 2–4 分钟并产出同名同尺寸产物；对结论无增量信息。若后续要求"绝对新鲜"的
   产物，验证命令是 `cd apps/admin-web && npx vite build && node -e "…"`（见 §2 末条）。

**去重比对过的既有条目**（读了正文，不是只看标题）：
`docs/AGENT-SWARM-PLAYBOOK.md` §7（data-3 / desktop-budget / TOOLS-04 / TOOLS-06 / desktop-resend /
doc-guard / obs-2 等，正在被另一 agent 修，本轮**零条**涉及）、`docs/archive/audits/audit-ledger-2026-10.md`
（R1–R6 全量）、`docs/archive/audits/ux-audit-2026-09-21.md`（P0-1…P2-9 已修清单）、
`docs/archive/audits/ux-v4-audit-redesign-2026-10-05.md`（桌面端，非本域）、`docs/audit-playbook.md`、
`docs/OPEN-DECISIONS.md`、`docs/PLAN-CLAIMS.md`（按关键词抽读）。

**逐焦点项的结论摘要**（含"查过且已覆盖"的部分，避免下一轮重复劳动）：

| 焦点 | 结论 |
|---|---|
| 路由 `React.lazy` | **全覆盖**：`router-pages.tsx` 25 个页面全部 `lazy()`，`router.tsx` 无静态页面导入；`MainLayout`/`RequireAdmin`/`PrivateRoute` 是壳层，按设计不 lazy |
| 重量级依赖进首屏 | `recharts` **进了**（共享 manualChunk + modulepreload）；monaco 已按 PERF-01 修好；antd 按组件分块（22 个 preload 里 9 条是 antd/rc-* 组件与图标碎块） |
| 首屏串行请求瀑布 | **无应用层瀑布**：`PrivateRoute` 只等 zustand 同步 hydration，各页面 query 并行发出；真实成本在"24 个资源请求 × HTTP/1.1"，见 WEB-2 |
| 表格分页 | **无遗漏**：16 个含 `<Table` 的页面/组件全部带 `pagination`；`TaskListPage`/`ExecutionsPage` 另有 keyset 游标分页器；`ApplicationDetailPage` 用 `virtual` 兜底单页渲染 |
| 搜索防抖 | **已覆盖**：`useDebounce`（300ms）用于 TaskList/Executions/UserManagement/ExecutorPackages/CommandPalette |
| 轮询退避 / 隐藏暂停 | 轮询侧**已覆盖**（TanStack `refetchIntervalInBackground` 默认 false + SopsPage/AgentSessionsPage/ExecutionsPage 显式 `visibilityState`）；**SSE 侧缺失**，见 WEB-3 |
| 三态（加载/空/错） | 列表页普遍齐全（`PageSkeleton` + `StateError` + 区分"筛选无匹配/真空"）；设置域漏一处，见 WEB-5 |
| 危险操作确认 | 删除/归档/回滚类均有 `Popconfirm`/`Modal.confirm`；**审批批准**单击即执行且无决策依据，见 WEB-4 |
| 表单错误定位到字段 | **已覆盖**：`TaskFormPage.tsx:648` `form.scrollToField(namePath, {behavior:'smooth', block:'center'})` + `TaskFormNavRail` 的 `aria-live` 播报 + `isFormValidationError` 静默分支（不重复弹 toast） |
| Drawer 焦点管理 | **已覆盖**：4 个 `<Drawer>`（Sops/AgentSessions/Projects/TaskDetail）全部接 `useDrawerA11y`（开→聚焦首元素，关→归还触发按钮），Esc 由 antd 默认开启 |
| 对话框焦点陷阱 / Esc | **已覆盖**：全部基于 antd `Modal`/`Drawer`（rc-dialog 自带 trap/`aria-modal`/Esc）；`CommandPalette` 另补了 `aria-labelledby`（`:808-810`） |
| 对比度 | **已覆盖**：`index.css:33-39`、`tokens.ts:134-144`、`a11y-focus.css:16-20` 已按 WCAG 逐对比值记录并加深（品牌绿 `#22C55E` 白底 2.28:1 → 亮面用 `#16A34A`/`#15803d`）；`#475569/#F8FAFC = 7.24:1`、`#94A3B8/#1A1E2F = 6.45:1` 均达标（我逐对复算过） |
| `aria-live` | 关键异步面有（`PasswordStrengthMeter`、`TaskFormNavRail`、`TaskListPage` 的 lastStatus 说明）；toast 依赖 antd 内建 `role="alert"` |
| i18n 硬编码 | `scripts/i18n-scan.mjs`（AST，只判 CJK）+ `i18n-key-check.mjs` 双守卫当前**通过**，无基线外中文新增；英文硬编码面我另行扫过（`title=/label=/placeholder=` 字面量），剩下的都是品牌名/技术标识（Slack/Webhook/`main`/`gpt-4o-mini`）——合规 |
| 无 UI 入口（后端有能力、前端零入口） | 逐 controller 抽路由（265 条）与前端字符串交叉比对 + 逐个检查 `api/*.ts` 的零调用导出：**未发现新的**此类缺口。既有的两条已登记未修（R4-A-10 全局审批收件箱、R6-A-12 CSV 导出入口，均标"暂缓"），本轮不重报；争议最大的 obs-2（chat 会话人工入口）已在 `cb9b75ec` 补上，我复核过入口与空态文案确实改了 |

## 2 未覆盖 / 未实测（如实写）

1. **未跑真机 Lighthouse / axe**：`apps/admin-web/lighthouserc.json` 的 a11y 门槛是 0.9，但 axe 只扫
   当前 DOM——"未打开的 Modal"（如 WEB-6 的新建会话弹窗）在门禁里永远是绿的，这条假绿是本轮
   WEB-6 的方法论依据，我没有实跑 lhci 去证明分数。验证方式：`cd apps/admin-web && npx lhci autorun`，
   或给该 Modal 补一条 `vitest + @testing-library` 的可访问名断言（更便宜）。
2. **未实测 HTTP/1.1 下的真实波次**：WEB-2 的"623.9 KB / 24 请求 ÷ 6 并发 = 4 波"是协议约束推算，
   未在目标部署（宝塔反代 + 内网）用 Chrome DevTools 抓 waterfall。验证方式：部署后
   Network 面板勾 "Disable cache + Slow 3G"，看 `vendor-charts` 是否出现在 `/login` 首屏瀑布里
   （WEB-1 的单点验证，10 秒可完成）。
3. **未逐条计数 `getSummary` 的 SQL 条数**：WEB-3 里"每拍约 8–10 条聚合查询"是按
   `metrics.service.ts:56-81`（4 个 `count()` + 1 个 `GROUP BY` + 1 个 `AVG`）+ `getExecutorStats`
   + `getSchedulerMetrics` 估的，未挂 pg 日志逐条数。验证方式：`pg_stat_statements` 或
   `log_min_duration_statement=0` 抓 3 秒窗口。
4. **未覆盖**：`apps/admin-web/e2e*` 的 Playwright 用例、`src/__tests__` 的 900+ 单测语义正确性
   （只把它们当"行为已被钉住"的信号读）；移动端 375px 真机布局（只在代码层核对了 `useIsMobile`
   覆盖率——`AppDeploymentPage/ApplicationDetailPage/ExecutorDetailPage/ExecutorPackagesPage/
   NotificationSettingsPage/RegistryPage` 六个含表格页没有卡片降级，但它们都有 `scroll.x`，
   无证据表明塌陷，故不作为 finding）；`ssr/预渲染`（本项目纯 SPA，无该面）。
5. **未验证**：`build.modulePreload.resolveDependencies` 在 Vite 8（rolldown）下的可用性与签名
   ——WEB-1 的备选修法依赖它，标"未验证"，落地前需查该版本类型定义。

## 3 发现总表

| id | 优先级 | 一句话 | 落点 |
|---|---|---|---|
| WEB-1 | P2 | `recharts` 被提成共享 manualChunk 后进了首屏 modulepreload：登录页等无图表页面白付 108.3 KB gz（首屏 17.3%） | `apps/admin-web/vite.config.ts:161`、`apps/admin-web/dist/index.html:26` |
| WEB-2 | P3 | 首屏 24 个资源请求 / 623.9 KB gz，而部署 nginx 只有 `listen 80`（无 HTTP/2）→ 6 并发上限把首屏拆成 4 波；entry 里还整块吞了 ⌘K 才用的 `CommandPalette` | `apps/admin-web/nginx.conf:2`、`apps/admin-web/dist/index.html:20-47` |
| WEB-3 | P2 | 三条 SSE 长连接（metrics/executions/logs）在标签页隐藏时不断开：每 3s 一拍快照、每拍 8–10 条聚合 SQL，并占满默认 32 个 stream 槽位 | `apps/admin-web/src/api/sse-client.ts:188-227`、`src/hooks/useMetricsStream.ts:90-146`、`apps/admin-api/src/modules/metrics/metrics-stream.controller.ts:150-190` |
| WEB-4 | P2 | 审批单没有决策依据：理由只显示前 160 字符（hover 也是同一截断串）、入参从不展示，而"批准"单击即执行——审批人实际是在盲签一组具体参数 | `apps/admin-web/src/pages/AgentSessionsPage.tsx:469`、`:499-518`；`apps/admin-api/src/modules/agent/boundary/agent-boundary.service.ts:253-256` |
| WEB-5 | P2 | 「模型接入与分配」把**读取失败**渲染成"没有配置任何模型"（空表 + 一闪而过的 toast，无原位错误态/重试），与同目录三个子页的 UI-16 约定相反 | `apps/admin-web/src/pages/settings/AiProvidersSettings.tsx:51-63`、`:204-206` |
| WEB-6 | P3 | 「新建会话」弹窗的表单标签是 `<Text>` 而非 `<label>`：Select/Input/TextArea 对读屏**无可访问名**（且 lhci/axe 扫不到未打开的弹窗 → 门禁假绿） | `apps/admin-web/src/pages/AgentSessionsPage.tsx:665-700` |
| WEB-7 | P3 | i18n 词典两份全量随首屏：i18n chunk 180.3 KB gz（首屏最大单块），其中 zh 用户白下 `en` 66.5 KB gz；F-42 注释里的体积前提（"en ~140 KB raw / ~40 KB gzip"）与实测差约 4.5× | `apps/admin-web/src/i18n/index.ts:20-35`、`apps/admin-web/src/locales/{zh,en}.ts` |

## 4 逐条证据

### WEB-1（P2）`recharts` 进了首屏：108.3 KB gz 的 modulepreload

**现象**：`/login`、`/tasks` 等任何不含图表的页面，首屏 22 条 `<link rel="modulepreload">` 里都有
`vendor-charts-*.js`。recharts 只被三个 **lazy** 页面消费，用户不打开它们就完全用不上。

**逐字代码**

`apps/admin-web/vite.config.ts:155-161`：
```ts
        manualChunks(id: string) {
          // Split large vendor libraries into separate chunks
          const chunks: Array<[string, string[]]> = [
            ['vendor-react', ['react', 'react-dom', 'react-router-dom']],
            ['vendor-charts', ['recharts']],
```

`apps/admin-web/dist/index.html:26`（构建产物，22 条 preload 之一）：
```html
    <link rel="modulepreload" crossorigin href="/assets/vendor-charts-Dn0XL3lI.js">
```

recharts 的三个消费方（全部 lazy 页面，`router-pages.tsx` 里 `lazy(() => import('./pages/DashboardPage'))` 等）：
```
src/pages/DashboardPage.tsx:16          } from 'recharts';
src/pages/ExecutorDetailPage.tsx:8      import { LineChart, Line, XAxis, ... } from 'recharts';
src/components/dashboard/KpiSparkline.tsx:18  import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';
```

**触发路径**：打开 `https://<host>/login`（或任何首屏）→ 浏览器解析 `index.html` → 按 22 条
`modulepreload` 并发下载，其中一条就是 382 KB raw / 108.3 KB gz 的 recharts。与用户是否去
`/dashboard` 无关。

**影响与量级**：首屏 623.9 KB gz 里 108.3 KB（**17.3%**）是永不执行的代码；按 §1 的实测表，
它比 entry 自身（85.6 KB gz）还大。且这是同一类缺陷的**第二次出现**——`vite.config.ts:170-186`
的注释已经把机理写得很清楚：

```ts
            // 机理：manualChunks 把 monaco 提成**共享 chunk** 后，只要有静态
            // 可达模块与该 chunk 产生静态边（实测 entry 经 i18n/antd 那一片共享
            // 依赖即命中），Vite 就会把整个 chunk 当作 entry 的静态依赖预加载
            // ——GlueEditor 自己是不是 lazy 已经不重要了。
```
monaco 那一行被删了，`vendor-charts` 这一行留下了（同一文件、同一条判据）。另有回归守卫
`src/__tests__/monaco-first-paint.perf01.test.ts` 只钉 monaco，不钉 charts。

**最小修法**（两档，先做 A）：

A. 删掉 `['vendor-charts', ['recharts']]` 这一行，让 recharts 落回各 lazy 页自己的 chunk，
   并确认 `dist/index.html` 不再出现 `vendor-charts`（与 PERF-01 对 monaco 的处理完全同构）。
   代价：recharts 可能在 DashboardPage / ExecutorDetailPage 各存一份（KpiSparkline 被
   Dashboard 引用，同 chunk）。**先量化再决定**：构建后 `du -k dist/assets/*.js | sort -n`，
   若两份合计 gz 超过 ~150 KB，走 B。

B. 保留共享 chunk，但在 Vite 里过滤首屏 preload 依赖（`build.modulePreload.resolveDependencies`,
   Vite 5+ 支持；Vite 8/rolldown 下**未验证**，见 §2.5），只对非首屏 chunk 去掉 preload。

配套：把 `monaco-first-paint.perf01.test.ts` 扩成 `first-paint-no-unused-vendor.test.ts`，
断言 `index.html` 的 preload 集合里不含 `vendor-charts` / `GlueEditor`（改回去即转红）。

**可借鉴的 OSS 做法**：Vercel/Next.js 默认不给非首屏依赖建共享 vendor chunk，只在
`next/dynamic` 边界内打包；Grafana 的前端拆包纪律是"每个 feature 一个 chunk，vendor 只按
框架/UI 库分，按需库不进 root"。判定点与 PERF-01 注释里写的一模一样：**共享 chunk 只要与
entry 有静态边就会被预加载**——所以"共享"与"懒"在 rollup 的 preload 语义下是互斥的。

---

### WEB-2（P3）首屏 24 个请求撞上 HTTP/1.1 的 6 并发上限

**现象**：首屏要 24 个资源（22 modulepreload + entry + css），而生产部署的 nginx **只监听明文 80
端口**，不可能协商 HTTP/2（h2 需要 TLS；本仓 nginx 无 ssl 配置）。HTTP/1.1 对同一 host 的并发
连接数是 6，于是首屏被切成至少 4 波，每波都要等上一波腾出连接。

**逐字代码**

`apps/admin-web/nginx.conf:1-2`：
```nginx
server {
    listen 80;
```
（全文无 `ssl_certificate` / `http2`；`apps/admin-web/lighthouserc.json` 里
`"uses-http2": "off"`——门禁主动关掉了这条断言，等于承认部署面没有 h2。）

`apps/admin-web/dist/index.html:20-47`（计数来源）：
```html
    <link rel="modulepreload" crossorigin href="/assets/rolldown-runtime-XKyaHtl9.js">
    … 共 22 条 modulepreload …
    <link rel="stylesheet" crossorigin href="/assets/index-DphamQae.css">
```

entry 里还整块装着「⌘K 才用」的命令面板（`dist` 中 `palette` 只出现在 entry chunk 内的 48 处，
`GlueEditor` 那份是 monaco 的调色板词）：
```
src/layouts/MainLayout.tsx:41  import CommandPalette from '../components/CommandPalette';
src/layouts/MainLayout.tsx:44  import ShortcutHelpModal from '../components/ShortcutHelpModal';
```

**触发路径**：任何首屏 → 24 个请求按 6 并发排队 → 高 RTT / 低带宽内网（本仓目标部署是宝塔内网）
下每波一个 RTT 的额外延迟，且 623.9 KB gz 的带宽占用不变。

**影响与量级**：比 WEB-1 轻（内网 RTT 20–40ms → 额外 ~3 个 RTT ≈ 100ms 量级），但它是
"再多加一个依赖就再掉一档"的结构性问题：当前 22 条 preload 里 9 条是 antd/rc-* 的单个组件与图标块
（`typography` 37.9 KB、`card` 23.1 KB、`breadcrumb` 13.6 KB、`modal` 8.8 KB、`space` 2.1 KB、
`Input` 1.2 KB、`SearchOutlined` 0.7 KB…）。P3 而非 P2 的理由：没有用户可见的功能错误，只是首屏字节与波次。

**最小修法**：

1. 把 `CommandPalette` 与 `ShortcutHelpModal` 改成 `lazy()` + `Suspense`（两者只在 ⌘K / `?`
   触发时挂载），entry 立刻瘦身——顺带解决"打开首屏即解析 48 处 palette 代码"。
2. 给 antd 建**一个** `vendor-antd` 强制块（`/node_modules/antd/`、`/node_modules/@ant-design/icons/`、
   `/node_modules/@rc-component/`），把这 9 个碎块并成 1–2 个请求。注意 WEB-1 的教训：antd 本就是
   首屏必需，合并**不会**引入"懒依赖被预载"问题（它已经在首屏）。
3. 部署侧如后续加证书，`listen 443 ssl; http2 on;`（nginx ≥1.25.1 语法）可一次性拿掉波次问题；
   这条属部署决策，不进前端 PR。

目标：preload 从 22 条降到 ≤10 条。

**可借鉴的 OSS 做法**：Vite 官方 `build.rollupOptions.output.manualChunks` 文档明确建议
"不要给每个库单独建 chunk，chunk 数本身是成本"；Ant Design Pro 的做法是把 antd 整体一个
vendor 块 + 业务按路由切；HTTP/1.1 下 6 并发是 RFC 7230 之后的浏览器惯例（Chrome/Firefox 均为 6）。

---

### WEB-3（P2）SSE 长连接不随页面隐藏断开：每 3 秒 8–10 条聚合 SQL / 连接

**现象**：全站轮询都遵守"页面隐藏即暂停"（TanStack `refetchIntervalInBackground` 默认 false，
`ExecutionsPage.tsx:338` 的注释还把这条写成了约定），但**三条 SSE 流没有**：`createSseClient`
只在 `onerror` 时退避重连，从不看 `document.visibilityState`。用户把 Dashboard / 执行器列表 /
执行记录页留在后台标签，服务端每 3 秒照跑一遍聚合查询并推送。

**逐字代码**

`apps/admin-web/src/api/sse-client.ts:188-224`（建流与唯一的断开路径）：
```ts
  const connect = async () => {
    if (closed) return;
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    …
    es.onerror = () => {
      es?.close();
      es = null;
      scheduleReconnect();
    };
  };
```
（全文无 `visibilitychange`/`hidden`；`grep -rn "visibilityState" src` 只命中
`SopsPage.tsx:188`、`AgentSessionsPage.tsx:237`、`ExecutorInstallWizardPage.tsx:374` 三个**轮询**页。）

`apps/admin-web/src/hooks/useMetricsStream.ts:90-96`：
```ts
  useEffect(() => {
    if (!enabled || !queryClient) {
      setStatus('connecting');
      return;
    }

    const client = createSseClient({
```
（`enabled` 只由登录态/路由切换控制，隐藏标签不会翻它。）

服务端一拍的成本，`apps/admin-api/src/modules/metrics/metrics-stream.controller.ts:129-155`：
```ts
        const [summary, executors, scheduler] = await Promise.all([
          this.metrics.getSummary().catch(…),
          this.metrics.getExecutorStats().catch(…),
          this.metrics.getSchedulerMetrics().catch(…),
        ]);
```
`apps/admin-api/src/modules/metrics/metrics.service.ts:56-81`：`getSummary` 自身就是
4 个 `count()` + 1 个 `task_executions` `GROUP BY status` + 1 个 `AVG(duration)`（我逐行读过）。

**触发路径**：值班人打开 `/dashboard`（`DashboardPage.tsx:117` `useMetricsStream()`）或
`/executors`（`useExecutorLive.ts:141` `useMetricsStream({ enabled: canStream })`）或
`/executions`（`ExecutionsPage.tsx:366` `useExecutionsStream()`）→ 切到别的标签/最小化窗口 →
连接与推送继续。`ExecutionDetailPage` 的日志流（`components/ExecutionLogSection.tsx:245`）同理。

**影响与量级**：单连接 ≈ 8–10 条聚合 SQL / 3 秒 ≈ **160–200 条/分钟**（表是
`task_executions` 这类会随执行量增长的大表）。槽位面：controller 头注写明"默认 32
（`METRICS_STREAM_MAX_GLOBAL`）"，超限**返回真 503**。于是"几块常开监控屏 + 若干忘关的运维标签"
就能把槽位吃满，让真正需要看板的人拿到 503——这是可靠性退化而不是纯省流量。另外隐藏标签里
`setQueryData` 仍会触发 React 重渲染（`useMetricsStream.ts:109-117`），后台标签的 CPU 也白烧。

**最小修法**（一处改、三处受益）：在 `createSseClient` 的返回对象里挂 Page Visibility：

```ts
const onVis = () => {
  if (document.visibilityState === 'hidden') { es?.close(); es = null; clearTimer(); paused = true; }
  else if (paused) { paused = false; attempt = 0; void connect(); }
};
document.addEventListener('visibilitychange', onVis);
// close() 里 removeEventListener
```
要点：`hidden` 时**不要**走 `scheduleReconnect`（否则会在后台每 30s 重建一次）；`visible` 时
立即重连并重置 `attempt`（隐藏不是失败，不该继承退避）。`close()` 里必须摘掉监听（防泄漏）。

**可借鉴的 OSS 做法**：TanStack Query 的 `refetchIntervalInBackground: false`（本仓已在用）；
MDN Page Visibility API 的推荐用法即"隐藏时停掉主动拉取，回前台补一次"；Grafana 的
`refresh` 下拉在标签隐藏时暂停（`dashboard/dashboard_srv` 里的 visibility 处理是同一形态）。

---

### WEB-4（P2）审批单缺决策依据 + 单击即执行

**现象**：`/agent-sessions` 详情抽屉的「审批单」页签只给出 `toolName` + 一段**通用模板**
理由，理由还被 `.slice(0, 160)` 截断；工具入参从不展示。而"批准"按钮单击就直接执行副作用
（grant → 服务端自动 resume → 重放并真正执行写工具），没有二次确认、没有影响面摘要、不可撤销。

**逐字代码**

`apps/admin-web/src/pages/AgentSessionsPage.tsx:463-472`（理由列；截断发生在**数据层**）：
```tsx
    {
      title: t('agents.col.reason'),
      ellipsis: true,
      render: (_, a) => (
        <Text style={{ fontSize: 12 }} type="secondary">
          {a.reason.slice(0, 160)}
        </Text>
      ),
    },
```
`apps/admin-web/src/pages/AgentSessionsPage.tsx:499-509`（批准：一次点击即处置）：
```tsx
            <Button
              size="small"
              type="primary"
              loading={decidingKey === a.approvalKey}
              disabled={decidingKey !== null && decidingKey !== a.approvalKey}
              onClick={() => void decideApproval(a.approvalKey, 'grant')}
            >
```
理由文本本身的形状，`apps/admin-api/src/modules/agent/boundary/agent-boundary.service.ts:253-256`：
```ts
    if (spec.tier === "write" && policy.writeRequiresApproval) {
      return {
        kind: "NEED_APPROVAL",
        spec,
        message: `写类工具 ${toolName} 需人工审批。`,
      };
```
审批键**绑定具体参数**，`apps/admin-api/src/modules/agent/runtime/agent-approvals.service.ts:45-49`：
```ts
    const digest = createHash("sha256")
      …
    return `apr-${sessionId}-${digest}`;
```
（键 = `sha256(toolName|规范化参数)` 前 16 位——即"批准这张单"等于"批准这一组具体参数"。）

**触发路径**：`/agent-sessions` → 状态筛选 `waiting_input`（列表行有橙色「待审批」徽标，
`needsApprovalBadge`）→ 点「查看」→ 抽屉「审批单」页签 → 看到「需要审批 · `<tool>`」+
「写类工具 `<tool>` 需人工审批。」→ 点「批准」。

**影响与量级**：审批闸门的**全部价值**是"人替系统看一眼这次要做什么"，而现在人看不到要做什么：
① 入参（改哪个文件/哪个配置/写到哪个地址）完全不在审批单上；② 理由模板里没有资源标识
（`agent-boundary.service.ts` 的三处 NEED_APPROVAL 消息都只插 `toolName`，`:236-258`）；③ 160 字符截断且
hover 也看不到全文——rc-table 的 `title` 取自同一个 children 串（`@rc-component/table/es/Cell/index.js:19-24`：
`if (ellipsisConfig && …) { if (typeof children === 'string' …) title = children.toString(); … }`，
此处 children 就是被 slice 过的字符串）。要判断只能切到「工具调用」页签，用 `toolName` 肉眼
匹配（同名调用可能多条），而那里的 `argsJson` 同样只显示前 160 字符
（`AgentSessionsPage.tsx:427-435`）。对一个 `write`/`dangerous` 工具，这实质是盲签。

**最小修法**（纯前端，不动后端契约）：

1. 审批行按 `toolCalls.find(c => c.approvalId === a.approvalKey)` 关联
   （`api/agent.ts` 的 `AgentToolCall` 已含 `approvalId` + `argsJson`，`openDetail` 已把 `toolCalls` 取回本地；
   而 `awaiting_approval` 台账行在挂起**之前**就已落库并带 `args` + `approvalId`——见
   `apps/admin-api/src/modules/agent/tools/tool-executor.service.ts:291-301`；恢复时运行时正是按这个状态回捞，见
   `agent-runtime.service.ts:654`），
   在审批行/展开区渲染 `argsJson` 的结构化视图（键值对表格，不截断，长值单独可滚动）。
2. 去掉 `.slice(0, 160)`，改用 antd 的 `Typography.Paragraph ellipsis={{ rows: 3, expandable: true }}`
   （或 `Tooltip` 挂完整 `reason`）——理由与入参属"审批人必须能读全"的文本。
3. 「批准」前加一次 `Modal.confirm`，正文列出 `toolName` + 参数摘要 + 「批准后将立即执行且不可撤销」
   （与 TaskListPage 删除任务的 Popconfirm 同款纪律）；「拒绝」保持单击（无害且常见）。
4. 配套断言：`agent-sessions-page-b14` 增加"pending 审批显示入参且不截断"用例。

**可借鉴的 OSS 做法**：GitHub Actions 的 Environment 审批页在批准前展示 job 名、触发者与
`workflow` 上下文；Linear/Jira 的审批流把"要变更的字段 diff"放在批准按钮上方；LangGraph 的
`interrupt`/human-in-the-loop 规范要求 resume 时携带 `payload`（即"这次要做什么"必须可见）。

**与既有条目的关系**：`playbook §7` 的 TOOLS-02（审批 grant 后动作不执行）与 `audit-ledger`
R3-B/B-12（审批闭环，曾标"feature 级暂缓"）解决的是**流程能否走通**；本条是在流程已走通
（`225ab7a6` + `d249b5c2` + `e23125b5` 之后）的**决策质量**缺口，不是同一条。

---

### WEB-5（P2）「模型接入与分配」把读取失败渲染成"没有配置任何模型"

**现象**：该页 `load()` 失败只弹一条 toast，随后 `data` 保持 `null`，页面如实渲染成
"provider 列表为空 + 分配下拉全空"。用户看到的是「没配模型」，实际是「没读到」。

**逐字代码**

`apps/admin-web/src/pages/settings/AiProvidersSettings.tsx:51-63`：
```tsx
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await aiApi.listProviders());
    } catch (err) {
      showApiError(err);
    } finally {
      setLoading(false);
    }
  }, []);
```
`apps/admin-web/src/pages/settings/AiProvidersSettings.tsx:204-228`（渲染面：没有 error 分支）：
```tsx
    <Card
      style={{ marginTop: 16 }}
      loading={loading}
      title={t('aiProviders.title')}
      …
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={providers}
```
（`providers = data?.providers ?? []`，`:118`。整文件 import 里**没有** `StateError`。）

同目录三个子页都有：`ApiKeysSettings.tsx:29/323`、`EventSubscriptionsSettings.tsx:42/305`、
`SecuritySettings.tsx:27`——只有本文件漏了。

**触发路径**：设置页 →「模型接入与分配」→ 此时 admin-api 502 / 网络断开 / 迁移后表不存在
→ 一次 toast 闪过（3 秒后消失）→ 表格 `暂无数据`、三个用途下拉只有「跟随全局」。

**影响与量级**：运维/管理员据此判断"还没接入模型"，最可能的下一步是**重新添加一份 provider**
（重复配置、密钥再录一次）或误认为"推理能力未配置"而回滚版本——这是典型的"读失败被当成空态"
导致的运维误导。修复成本约 10 行。

**最小修法**：

```tsx
const [loadError, setLoadError] = useState<unknown>(null);
// load(): 进入 setLoadError(null)；catch 里 setLoadError(err)（保留 toast 也可以）
// 渲染：{loadError ? <StateError error={loadError} title={t('aiProviders.loadFailed')}
//          onRetry={() => void load()} /> : <Table …/>}
```
并在 `loadError` 时**不要**渲染空表与分配区（避免"空"被解读成事实）。新增 zh/en 词条
`aiProviders.loadFailed`（`lint:i18n` 会强制要求两语齐全）。

**可借鉴的 OSS 做法**：本仓自己的 UI-16 先例（列表页原位错误块 + 重试）；Vercel Dashboard 的
"Failed to load" 卡片不伪装成空态；TanStack 的 `isError`/`error` 与 `data` 三态区分就是为了
避免这个混淆。

---

### WEB-6（P3）新建会话弹窗：标签不是 label，控件对读屏无名

**现象**：`cb9b75ec` 新增的「新建会话」弹窗，三个字段的标题是 `<Text type="secondary">`，
既不是 `<label>`，也没有 `htmlFor`/`id` 关联，更没走 antd `Form.Item`（后者会自动生成
`label[for]`）。读屏用户进入弹窗只听到"组合框"、"编辑框"，不知道在填什么。

**逐字代码**

`apps/admin-web/src/pages/AgentSessionsPage.tsx:665-676`：
```tsx
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Text type="secondary">{t('agents.createKind')}</Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              value={createKind}
              onChange={setCreateKind}
```
（`:679` / `:689` 的 Title / Context 两段同型：`<Text>` + `<Input>` / `<Input.TextArea>`，
全弹窗无 `id`、无 `htmlFor`、无 `aria-label`。）

**触发路径**：`/agent-sessions` → 页头「新建会话」（移动端在筛选区操作行）→ 弹窗打开 →
用 NVDA/VoiceOver 逐 Tab 走：`Select` 只报"组合框 chat"、`Input` 只报"编辑框"。

**影响与量级**：WCAG 2.1 SC 1.3.1（信息与关系）/4.1.2（名称、角色、值）；键盘可达、Esc、焦点陷阱
都由 antd Modal 兜住，**唯独名字缺失**。另一个后果是门禁假绿：`lighthouserc.json` 的
`categories:accessibility ≥ 0.9` 是 error 级，但 axe 只扫当前 DOM，未打开的 Modal 内容永远
不在扫描范围——这类缺陷只能靠单元断言或人工。

**最小修法**：改成 antd `Form` + `Form.Item name label`（最省事，自动 `htmlFor`/`id`/
`aria-describedby`，且顺带获得字段级校验），或最小改动给每个控件补
`id="agents-create-kind"` + `<label htmlFor="agents-create-kind">…</label>`。
断言用 `@testing-library`：`getByLabelText(t('agents.createKind'))` 能拿到 Select 即通过
（现在会抛 not found——这就是"改回去会转红"的反证）。顺带修一处体验问题：`onCancel` 只
`setCreateOpen(false)`，不重置 `createTitle/createContext`，下次打开残留上次输入
（`:662`）。

**可借鉴的 OSS 做法**：WAI-ARIA APG 的 Forms 模式（每个控件必须有可编程名称）；
antd 官方 Form 文档"label 与控件自动关联"是这条的默认实现。

---

### WEB-7（P3）i18n 词典两份全量随首屏；F-42 的体积前提与实测差 4.5×

**现象**：i18n chunk 是首屏最大单块（595.3 KB raw / 180.3 KB gz，占首屏 28.9%），因为它
**同步** import 了 zh + en 两份完整词典。F-42 的决策注释用一个体积前提为"同步"做了辩护，
而那个前提比实测小了约 4.5 倍。

**逐字代码**

`apps/admin-web/src/i18n/index.ts:20-35`（F-42 的原始理由）：
```ts
// F-42（UIUX 审计 P1-3）：en 改为**静态 import 同步注册**，取代 2026-09-18
// 网络性能审计「en 按需分包」的决策。原因：动态包让 initI18n 必须 await 其落定
// 后才能 i18n.init，而 React 树在模块求值后立即挂载——这段异步窗口里组件拿着
// **未初始化**的 i18next 渲染，真机出现两类竞态形态…
// （en/zh 两包都很小（en 产物 ~140KB raw / ~40KB gzip），正确性优先…
```
实测（`wc -c` + `gzip -6`）：`zh.ts` 234.6 KB raw / **73.6 KB gz**、`en.ts` 240.6 KB raw /
**66.5 KB gz**；构建产物 `dist/assets/i18n-*.js` = 595.3 KB raw / **180.3 KB gz**。

**触发路径**：任何首屏。中文环境的用户从不下拉语言菜单，却仍下载 66.5 KB gz 的英文词典。

**影响与量级**：zh 用户可省 66.5 KB gz（首屏 -10.7%），en 用户省 73.6 KB gz。**注意这不是
"推翻 F-42"**：F-42 拒绝的是"裸 async init + 立即渲染"，并明确写了恢复拆分的**前置条件**——
"必须同时给挂载树加 i18n ready 门控（等 `isInitialized` 再渲染）"。本条是把那个前置条件补上，
再拿回 10% 首屏，而不是把旧 bug 放回来。

**最小修法**：

1. `i18n/index.ts` 里的 `import en from '../locales/en'` 改成 `const loadEn = () => import('../locales/en')`
   按需注册（`await loadEn()` 后再 `i18n.addResourceBundle`）；`initI18n()` 改为 `await` 目标语言资源（zh 仍同步静态 import，作为 fallback 永远在场——保证不出现裸 key）。
2. `main.tsx` 挂载前加门控：`await initI18n()` 后再 `createRoot(...).render(...)`（模块顶层
   await，Vite 支持 ESM TLA；或用 `<Suspense>` + ready 标志）。这是 F-42 明文要求的那一步。
3. 反证用例：vitest 断言"模块求值完成时 `i18n.isInitialized === true`"且渲染首帧不出现
   含 `.` 的裸 key（现有 `i18n-source-guard.test.ts` 可扩展）。
4. 顺带更正 F-42 注释里的体积数字（`140KB/40KB` → 实测值），否则下一个人还会基于错的
   前提做决策。

**可借鉴的 OSS 做法**：i18next 官方 lazy-loading 指南的标准形态就是"按语言 namespace 动态
加载 + 在 i18n `initialized` 事件（或 `useSuspense`）之后再渲染"；react-i18next 提供
`useSuspense: true` 直接给出这个门控语义。

**与既有条目的关系**：与 F-42（`i18n/index.ts` 头注）**同源但形态不同**——F-42 是"正确性 vs
体积"的取舍决定，本条是"F-42 记录的体积前提已失真 + 它自己开出的补救条件从未落地"。
若维护者认为体积取舍已定案，可只执行第 4 步（改注释），本条即降为文档修正。

## 5 建议实施顺序（收益 ÷ 风险）

| 顺序 | 条目 | 收益 | 风险 | 建议验证 |
|---|---|---|---|---|
| 1 | **WEB-1**（删 vendor-charts manualChunk） | 首屏 -108.3 KB gz（-17.3%），改 1 行 + 1 条断言 | 极低（与 PERF-01 同构，已有先例） | `npx vite build` → 断言 `dist/index.html` 无 `vendor-charts`；`du -k dist/assets/*.js` 看 recharts 是否重复 |
| 2 | **WEB-5**（AI 设置页错误态） | 消除"读失败=没配置"的运维误判 | 低（10 行 + 2 条词条） | 单测：mock `aiApi.listProviders` reject → 断言出现 `StateError` 与重试按钮，且**不**出现空表 |
| 3 | **WEB-4**（审批依据 + 确认） | 审批闸门从"盲签"变"可核"；写工具的高危面 | 中（改决策 UI，需新增词条与断言） | `agent-sessions-page-b14` 增 2 例：pending 审批展示入参；grant 需二次确认 |
| 4 | **WEB-3**（SSE 隐藏断开） | 后台标签不再烧 160–200 SQL/分钟，释放 stream 槽位 | 中（连接生命周期，需防"隐藏后不再重连"） | `sse-client` 单测：dispatch `visibilitychange` → 断言 `EventSource.close` 被调用且无退避定时器；回前台断言重连且 `attempt` 归零 |
| 5 | **WEB-6**（弹窗 label） | a11y 合规 + 补上台面下的门禁盲区 | 低（可局部改），若改 Form 则为中等改动 | `getByLabelText` 三类控件可取；Esc/焦点不回归 |
| 6 | **WEB-2**（preload 瘦身 / vendor-antd） | 首屏请求 22→≤10，HTTP/1.1 波次 4→≤2 | 中（chunk 策略影响缓存粒度与首屏体积，必须构建后比对总量） | 构建后逐块比对 `du -k`，总量不得上升；断言 preload 条数上限 |
| 7 | **WEB-7**（词典按语言分包） | 中文用户首屏 -66.5 KB gz | 中高（要动 `initI18n` + 挂载门控，F-42 点名的竞态面） | 断言"求值完成即 initialized" + 首帧无裸 key；EN 全页走查（`nav.*` 那批曾在切 EN 时裸奔） |

> 1→2 可在同一次提交里做（都是"改一处 + 加断言"，互不冲突）；3/4 需各自独立提交（都可回滚）；
> 6/7 属"结构性优化"，建议在 1–5 落地并观测一次构建体积后再排。
