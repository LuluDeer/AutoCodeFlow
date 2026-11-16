# P2 首批项 3：1280 全站视觉回归报告

- 范围：管理端 `apps/admin-web` 全部 20 个页面，两档视口 **1280×800**、**1280×720**；另抽查 375×812 四页、暗色 1280×720 三页。
- 方法：复用 `apps/admin-web/scripts/ux-walkthrough.mjs` 的 Playwright route 夹具（无后端、登录态注入），测量脚本 `apps/admin-web/scripts/visual-1280.mjs` 在浏览器内采集几何与排版指标，按五类可量化判据产出候选偏差，人工截图目检 + 浏览器探针逐条复核后再决定是否修复。
- 基线 HEAD：`f867c64d`（P2-1 / P2-2 已提交）。分支 `develop`，未 push、未动 main。

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| 1280 基线测量（修复前 before） | 20 页 × 2 视口 = 40 跑，`pageerror = 0`、body 横溢 = 0 |
| 1280 修复后复测（after） | 20 页 × 2 视口 = 40 跑，`pageerror = 0`、body 横溢 = 0 |
| 375×812 抽查 | 4 页（dashboard / tasks / inbox / executions），`pageerror = 0`、body 横溢 = 0 |
| 暗色 1280×720 抽查 | 3 页（dashboard / tasks / executions），`pageerror = 0`、body 横溢 = 0 |
| 明确偏差（判据命中且复核为真） | **1 类**：`task-templates` 卡片操作按钮文字横向重叠，**已修** |
| 登记「未修」偏差 | 0（其余候选经复核均为误报或合规设计，见第 4 节） |

## 2. 可量化判据

| 编号 | 判据 | 计入偏差的条件 |
| --- | --- | --- |
| A clipped | 内容被裁切 | 可见元素 bottom > 视口高 +1，且 doc / Content / 祖先链均无可纵向滚动容器 |
| B overlap | 控件重叠 | 两个可交互元素 rect 相交 >2px 且互不包含 |
| C truncated | 文字截断 | scrollWidth > clientWidth +1，容器固定宽 + overflow hidden/ellipsis/nowrap；无省略号的硬截断计入偏差，ellipsis 省略号单列参考 |
| D fontMismatch | 字号档位不一致 | 同一层级标签（h1–h4 / 卡片标题 / 表单 label）出现 ≥2 种 computed font-size |
| E spacing | 间距异常 | 相邻内容块间距为 0，或 >2 倍中位数 |

## 3. 前后汇总对照

来源：before `visual-report.baseline.json`，after `visual-report.json`。

| 判据 | before 命中 | after 命中 | 说明 |
| --- | --- | --- | --- |
| clipped（A 裁切） | 0 | 0 | 无真裁切 |
| overlap（B 重叠） | 64 | **0** | 60 条为 `task-templates` 真实偏差（已修）；4 条为表格操作列 icon 热区边界误报 |
| truncated（C 硬截断） | 2 | 0 | 2 条均为 `overflowX=visible` 标签行，无裁切容器，误报；after 新判据已排除 |
| truncatedEllipsis（参考，不计偏差） | 50 | 50 | antd 省略号 + hover tooltip，设计内合规 |
| fontMismatch（D 字号档位） | 0 | 0 | 同层级字号一致 |
| spacing（E 间距） | 0 | 0（1280） | 375 抽查 dashboard 1 条离群，复核为响应式网格跨行间距，误报 |
| pageerror | 0 | 0 | — |
| body 级横向溢出 | 0 | 0 | — |

## 4. 偏差清单与处置

### 4.1 已修复（明确偏差）

#### `task-templates` — 卡片操作按钮文字横向重叠（B overlap）

- **页面**：`/task-templates`，两视口 1280×800 / 1280×720。
- **现象**：模板卡片使用 antd `<Card>` 的 `actions` 数组渲染 5 个 link/text 按钮（使用此模板、预览、导出、编辑、删除）。窄卡片（`xl=6`，实测宽 241px）下 antd 把按钮压进等宽 `<li>`（约 48px 宽），按钮文字 `nowrap` 实际宽 66–108px 溢出 `<li>`，相邻按钮文字横向交叠。
- **修复前数值**（基线，每视口）：
  - overlap 配对 **30 对**；最大相交 **60×24px**（「使用此模板 ↔ 预览」），其余如「使用此模板 ↔ 导出」12×24、「预览 ↔ 导出」18×24、「导出 ↔ 编辑」18×24、「编辑 ↔ 删除」6×24。两视口合计 60 对。
- **修法**：移除 Card `actions` 数组，改为卡片 body 末尾自绘按钮行：`marginTop: 8; display: flex; flexWrap: wrap; gap: 4`。空间不足时按钮自然折行，与执行器卡片（`ExecutorCardGrid.tsx`）、应用卡片（`ApplicationListPage.tsx`）同一套既有惯例。
  - 操作项、图标、文案、`isOfficial` 条件渲染、Popconfirm、Tooltip、icon-only 删除按钮 `aria-label`、loading 状态全部保留不变。
- **修复后数值**（after 复测，两视口）：

  | 视口 | overlap 配对 | 硬截断 | pageerror | body 横溢 | 顶栏高 | 首块 top–bottom |
  | --- | --- | --- | --- | --- | --- | --- |
  | 1280×800 | **0** | 0 | 0 | 否（docSw=1280） | 56px | 76–139 |
  | 1280×720 | **0** | 0 | 0 | 否（docSw=1280） | 56px | 76–139 |

  按钮折成两行（「使用此模板 / 预览」「导出 / 编辑 / 删除」），间距清晰，无文字交叠。
- **改动文件**：`apps/admin-web/src/pages/TaskTemplatesPage.tsx`。
- **前后对照截图**：
  - before：`before/task-templates-1280x800.png`、`before/task-templates-1280x720.png`
  - after：`after/task-templates-1280x800.png`、`after/task-templates-1280x720.png`
  - （PNG 被根 `.gitignore` 的 `*.png` 规则忽略，仅本地留存对照，不入库。）

### 4.2 复核后不计偏差（误报 / 合规设计）

| 归类 | 页面 | 说明 |
| --- | --- | --- |
| icon 热区边界相叠 | `executions`、`executor-packages` | 表格操作列相邻 icon-only 按钮，透明 padding/热区边界轻微相叠（最大 16×13px），16px 图标本体不重叠；截图目检排列均匀，不计偏差。 |
| Devtools 浮标 | 全站 | TanStack Query Devtools 右下角浮标（`.tsqd-parent-container` 子树），开发期工具非产品 UI，脚本已排除。 |
| 省略号截断 | 多列表格 / 标题 | antd `.ant-typography-ellipsis` / `.ant-table-cell-ellipsis` 省略号 + hover tooltip，设计内合规，单列 `truncatedEllipsis` 参考项。 |
| 无裁切容器超宽 | `task-templates` 标签行 | `overflowX=visible` 的 Space 行 scrollWidth>clientWidth，文字可自由换行，不计截断。 |
| 表格横向滚动 | `projects`、`applications`、`artifacts` | `.ant-table-content` scrollWidth>clientWidth 且 `overflowX=auto`，合规横向滚动，非裁切。 |
| 375 响应式跨行间距 | `dashboard`（375×812） | 单列卡片堆叠后跨行间距 94px（中位数 16px），属响应式网格自然跨行间距，非零间距/挤压；本轮未改 dashboard。 |

### 4.3 说明项（非产品缺陷）

- `audit`：顶部红色 toast「fixture missing: GET /audit/actions」为前端 route 夹具缺口（真实后端有该接口），非产品 UI 缺陷。

## 5. 逐页几何基线（before，修复前）

`h` = body 级横向溢出（1=有）；`v` = 纵向可滚（1=有，内容超出视口，在 layout 外层滚动，属既有布局）；表格列为首屏可见行 / 总行数。顶栏高除 login 外均 56px。

| 页面 | 路径 | 800 h/v | 800 首屏行 | 720 h/v | 720 首屏行 |
| --- | --- | --- | --- | --- | --- |
| login | /login | 0/0 | — | 0/0 | — |
| dashboard | /dashboard | 0/1 | — | 0/1 | — |
| tasks | /tasks | 0/0 | 5/5 | 0/1 | 5/5 |
| task-detail | /tasks/t-1001 | 0/1 | — | 0/1 | — |
| task-templates | /task-templates | 0/1 | — | 0/1 | — |
| executions | /executions | 0/1 | 6/7 | 0/1 | 6/7 |
| applications | /applications | 0/0 | 4/5 | 0/0 | 4/5 |
| app-detail | /applications/app-2001 | 0/0 | — | 0/1 | — |
| executors | /executors | 0/1 | 5/6 | 0/1 | 4/6 |
| executor-detail | /executors/ex-3001 | 0/1 | 0/5* | 0/1 | 0/5* |
| executor-packages | /executor-packages | 0/0 | 4/5 | 0/0 | 4/5 |
| projects | /projects | 0/0 | 5/6 | 0/0 | 5/6 |
| project-detail | /projects/p-1001 | 0/0 | 1/1 | 0/0 | 1/1 |
| artifacts | /artifacts | 0/1 | 5/6 | 0/1 | 5/6 |
| inbox | /inbox | 0/1 | — | 0/1 | — |
| sops | /sops | 0/0 | 4/5 | 0/0 | 4/5 |
| agent-sessions | /agent-sessions | 0/0 | 5/6 | 0/0 | 5/6 |
| audit | /audit | 0/0 | 5/6 | 0/1 | 5/6 |
| settings | /settings | 0/0 | — | 0/1 | — |
| registry | /registry | 0/0 | 7/8 | 0/1 | 7/8 |

\* `executor-detail` 表格首屏 0 行：表格位于详情头部卡片下方、首屏视口内未展开到 tbody，截图目检页面正常，非裁切。

after 复测两档 40 跑：body 横溢 0；纵向可滚 21 跑（与基线一致，既有布局外层滚动）；无裁切 / 重叠 / 硬截断 / 字号档位不一致 / 间距异常。

## 6. 补充抽查

### 6.1 375×812（移动端）

| 页面 | pageerror | 横溢 | 候选偏差 |
| --- | --- | --- | --- |
| dashboard | 0 | 否 | spacing 1 条离群，复核为响应式跨行间距（误报） |
| tasks | 0 | 否 | 无 |
| inbox | 0 | 否 | 无 |
| executions | 0 | 否 | 无 |

机读：`visual-report-375.json`；截图：`after/<page>-375x812.png`。

### 6.2 暗色 1280×720

| 页面 | pageerror | 横溢 | 候选偏差 |
| --- | --- | --- | --- |
| dashboard | 0 | 否 | 无 |
| tasks | 0 | 否 | 无 |
| executions | 0 | 否 | 无 |

机读：`visual-report-dark.json`；截图：`after/<page>-1280x720-dark.png`。

## 7. 门禁结果（本轮实测）

| 门禁 | 结果 | 说明 |
| --- | --- | --- |
| `npm run typecheck:web` | ✅ 通过（exit 0） | `tsc -b` 无类型错误。 |
| `npm run lint:web` | ✅ 通过（0 error） | `eslint .`：2 条 warning 均为存量（`AgentSessionsPage.tsx`、`useDeployModalData.ts` 的 exhaustive-deps），非本轮改动文件。 |
| `cd apps/admin-web && npm run lint:i18n` | ✅ 通过（exit 0） | 无新增硬编码中文串、无缺键。 |
| `npm run check:size-caps` | ✅ 通过（exit 0） | 基线条目 98 个未新增；改动文件未触发 warn，无需重签既有条目。 |
| 相关 vitest（逐文件单跑） | ✅ 18/18 通过 | `task-templates-page.test.tsx` 9 例、`task-templates-error-state.test.tsx` 1 例、`template-category-label.ux10.test.ts` 8 例。 |

### 复跑的测试文件

- `src/__tests__/task-templates-page.test.tsx`（9 passed）
- `src/__tests__/task-templates-error-state.test.tsx`（1 passed）
- `src/__tests__/template-category-label.ux10.test.ts`（8 passed）

> 环境备注：本轮收尾阶段宿主提交内存曾一度耗尽（Committed Bytes 21.17GB / Limit 21.41GB），导致 dev server（rolldown worker OOM panic）、worker fork 短暂无法拉起；内存释放后上述门禁与浏览器复测均已串行复跑通过。重型命令按单文件 / 单批串行执行，未并行 fork。

## 8. 证据路径

- 机读报告（after 全站两档）：`docs/archive/audits/assets/product-ui-remediation-2026-11-15/visual-1280/visual-report.json`
- 修复前基线备份：`…/visual-1280/visual-report.baseline.json`
- 375 抽查：`…/visual-1280/visual-report-375.json`
- 暗色抽查：`…/visual-1280/visual-report-dark.json`
- 修复前截图：`…/visual-1280/before/`（40 张，20 页 × 2 视口，PNG 不入库）
- 修复后截图：`…/visual-1280/after/`（1280 两档 40 张 + 375 四张 + 暗色三张，PNG 不入库）
- 测量脚本：`apps/admin-web/scripts/visual-1280.mjs`

## 9. 回滚点

- 本轮唯一产品代码改动：`apps/admin-web/src/pages/TaskTemplatesPage.tsx`（Card `actions` → body 内 flex-wrap 按钮行）。回滚单文件即可还原基线布局。
- 基线测量数据见 `visual-report.baseline.json` 与 `before/` 截图。
- 提交前工作区基线 HEAD `f867c64d`；按页面粒度提交，便于单页回滚。
