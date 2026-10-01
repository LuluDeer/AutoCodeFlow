# i18n 硬编码中文守卫

## 这是什么

`scripts/i18n-scan.mjs` 用 TypeScript 官方 parser 扫 `src/` 下的 `JsxText` 与
字符串字面量，找出**会渲染到界面上的硬编码中文**。这类串在英文界面下不会随
语言切换，造成中英混排。

```bash
node scripts/i18n-scan.mjs           # 盘点：列出所有疑似硬编码中文串
node scripts/i18n-scan.mjs --check   # 守卫：只报「不在基线里」的新增项（CI 用）
```

## 为什么要用 AST 而不是 grep

本仓库中文注释占比极高。以 `pages/TaskFormPage.tsx` 为例：

| 口径 | 行数 |
|---|---|
| 含中文的行（grep） | 350 |
| 其中带引号、看起来像串的行 | 72 |
| **真实的硬编码界面串** | **0**（72 行全是 `//` 注释里的中文引号，如 `"执行器去哪拿代码"`） |

grep 口径把注释算进来，会把 0 处说成 350 处，直接误导迁移排期——本项目确实
发生过一次「清单列了 5 个文件 ~950 处，实际这 5 个文件全部已迁移完毕」。
所以守卫走 AST：注释由 parser 天然排除，`{/* */}` JSX 注释也不会被误判。

（另：本脚本曾有一版手写字符串状态机，被文件里一个反引号带偏状态后**整个文件
被静默跳过**，得出「共 14 文件、TaskFormPage 无命中」的假绿。改用 AST 后该
类问题不复存在——这也是不自己写 lexer 的原因。）

## 基线怎么用

`i18n-baseline.json` 记录**已接受**的存量串，按 `文件 → 串内容` 比对
（**不按行号**——行号会随无关编辑漂移，用它做基线每次改动都会误报）。

命中基线 = 放行；不在基线 = 守卫失败。因此这个守卫拦的是**新增**硬编码，不会
一上来就红一片然后被人关掉。

### N-04 完成态：基线从 61 收缩到 1（2026-10-01）

N-04 的验收目标是「**硬编码中文源码守卫零豁免**」。基线的历史峰值是 105 处，
轮 28 清出两处死代码（`executor-mode.ts` 4 条、`api/event-subscriptions.ts`
4 条）后降到 61；本轮把剩余 61 处逐条回读源码重审，**61 → 1**：

- **60 处迁移**：它们全是「可选 t 参数的中文缺省值」惯用法（`describeCron(expr, t?)`
  / `formatRelativeTime(v, t?)` / `priorityTag(v, t?)` / `failureRunbookAction(fr, t?)`
  等）——屏上调用点全部传 `t`，中文只在直调（测试）与「调用方忘传 t」时出现。
  迁移形态统一为**缺省回落 i18n 单例**（`const T = t ?? ((k) => i18n.t(k))`，
  非组件文件直引单例，与 `api/tasks.ts` 的 N-04 先例同模式）：中文从源码消失、
  直调路径跟随当前语言（测试环境默认 zh，旧锚定逐字不变）、忘传 t 的调用点
  从「永远中文」变成「跟随用户语言」。三处连兜底一起清除：
  `priorityTag`/`TIMEOUT_ACTION_OPTIONS` 的中文 `label` 字段删除（展示统一由
  调用方按 value 走 i18n）、`aggregateFailureTop` 的 `unknownError` 改必传、
  `failure-runbook.ts` 的 16 条中文映射表删除（文案唯一来源 = locales 的
  `runbook.*`，键集注册表 `RUNBOOK_ACTION_T_KEY` 导出供测试锚定）。
  顺带修一个真缺陷：`describeCron` 此前即便传 `t` 也用硬编码 `DOW_ZH` 拼星期，
  英文界面会漏出「一、二、三」——现走 locales 既有而未接线的 `cron.desc.dow.*`
  双语键（en 侧为 Sun/Mon/…）。
- **1 处保留（零豁免不可达项）**：`i18n/index.ts` 的语言名 `'中文'`——语言
  切换器里该词以母语自称，**所有语言下都应显示「中文」**（英文界面显示
  "Chinese" 反而是错的）。它不是「待迁移」，是「迁移无意义」；守卫 AST 口径
  无法表达「这串正确」，故留在基线并在此记录理由。这是基线里唯一不可清零项。

zh/en 双侧 key 集合由 `__tests__/i18n-infra.test.tsx` 比对，`t()` 引用的 key
真实性由 `i18n-source-guard.test.ts` 检查，本守卫拦新增硬编码——三者互补。

### 守卫的边界（桌面端不在扫描范围）

本守卫只扫 `apps/admin-web/src`。**executor-desktop 的渲染层是另一张地图**，
守卫对其不可见，不要把「admin-web 守卫绿」误读为「桌面端已双语」：

- 托盘/主进程文案已按 `TRAY_TEXTS` 双语常量表收口
  （`apps/executor-desktop/src/main/tray-texts.ts`，含 agent-status-view）。
- **ConfigPage**（设置页）已收编：文案在
  `apps/executor-desktop/src/renderer/i18n.ts` 的 `CFG_TEXTS`（zh/en 扁平键表，
  与托盘同范式；语言判定 `navigator.language` en* → en），键位对齐由
  `renderer.selftest.mjs` 静态断言。
- 其余 renderer 页面（AppsPage/StatusWindow/HistoryPage/Wizard 及 App.tsx、
  UpdateBanner、ErrorBoundary 等组件）仍是硬编码中文（DESIGN-AUDIT-2026-09-22
  记录约 5600 字），需另立任务逐页迁移（先抽外层 chrome，再逐页，照
  ConfigPage 的 `cfg.*` 键表先例）。

### 新增条目要写理由

往 `accepted` 里加串时，请在该 PR 里说明为什么它不需要 `t()`。默认应该是
**迁移**：`t('key')` + `zh.ts`/`en.ts` 成对补词条（两侧 key 必须齐平，
`__tests__/i18n-infra.test.tsx` 会比对集合，`i18n-source-guard.test.ts` 会
检查 `t()` 引用的 key 真实存在）。

## 与既有两条 i18n 测试的分工

| 守卫 | 拦什么 |
|---|---|
| `i18n-infra.test.tsx` | zh/en **key 集合不一致**（漏翻） |
| `i18n-source-guard.test.ts` | `t()` 引用了**字典里不存在的 key**（界面渲染裸 key） |
| 本守卫（`i18n-scan.mjs --check`） | **新写的硬编码中文界面串**（漏迁移） |

三者互补，缺一不可：漏定义会让用户读到 `secretsEditor.alertTitle` 这种标识符
（看起来像功能坏了），漏迁移则表现为中英混排。
