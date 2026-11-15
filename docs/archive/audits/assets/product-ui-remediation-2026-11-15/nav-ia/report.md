# P1-6 导航 IA 整改 + 命令面板路由补全 — 验收报告

日期：2026-11-15　分支：develop　范围：`apps/admin-web`（MainLayout / CommandPalette / locales / 相关测试）

## 1. 原 → 新 导航结构对照

### 旧结构（HEAD，6 个折叠组，2 个单子项组 + 1 个 7 项大杂烩）

| 分组 | 子项（旧标签） |
| --- | --- |
| 概览（g-overview，单子项） | 控制台 |
| 任务（g-tasks） | 任务调度、任务模板 |
| 执行（g-executions，单子项） | 执行记录 |
| 执行器（g-executors） | 执行器列表、执行器包 |
| 应用（g-applications） | 应用管理、包注册中心 |
| 系统（g-system，7 项大杂烩） | 用户管理、SOP 管理、Agent 会话、通知设置、审计日志、项目管理、系统设置 |

### 新结构（2 个直达叶子 + 6 个分组，每组 2–3 项）

| 层级 | 键 | 路由 | 中文 | 英文 | admin |
| --- | --- | --- | --- | --- | --- |
| 直达叶子 | — | `/dashboard` | 控制台 | Dashboard | 否 |
| 直达叶子 | — | `/executions` | 执行记录 | Runs | 否 |
| 分组 自动化（g-tasks） | 子项 | `/tasks` | 任务 | Tasks | 否 |
| | 子项 | `/task-templates` | 模板 | Templates | 否 |
| 分组 节点（g-executors） | 子项 | `/executors` | 执行器 | Executors | 否 |
| | 子项 | `/executor-packages` | 执行器包 | Packages | **是** |
| 分组 应用（g-applications） | 子项 | `/applications` | 应用 | Applications | 否 |
| | 子项 | `/registry` | 注册中心 | Registry | 否 |
| 分组 组织（g-org） | 子项 | `/users` | 用户 | Users | **是** |
| | 子项 | `/projects` | 项目 | Projects | 否 |
| 分组 治理（g-gov） | 子项 | `/audit` | 审计 | Audit | **是** |
| | 子项 | `/notifications` | 通知 | Notifications | **是** |
| | 子项 | `/settings` | 设置 | Settings | 否 |
| 分组 辅助（g-assist） | 子项 | `/sops` | SOP | SOPs | **是** |
| | 子项 | `/agent-sessions` | Agent 会话 | Agent sessions | **是** |

- 层级计数：分组 6 个（≤7）；另加 2 个直达叶子，顶层可见行共 8 行，1280/375 一屏可容纳。
- 命名：移除「调度/列表/管理」近义后缀，改用场景词；图标只挂叶子页面项，分组节点不再带图标（消除父子同图标）。
- 英文标签全部缩短，侧栏宽度保持 220px 未改、`index.css` 未动；浏览器实测英文侧栏标签零截断（`truncation: []`）。

## 2. 菜单键与 admin 门控保持方式

- `ADMIN_ONLY_MENU_KEYS` 集合不变：`/executor-packages`、`/audit`、`/users`、`/notifications`、`/sops`、`/agent-sessions`。
- 普通用户过滤：分组子项按上述集合剔除；整组剔空后不再渲染该分组（`MainLayout` 过滤链路）。
- `/projects`、`/settings` 确认为非 admin 可达；旧命令面板误标的 adminOnly 已纠正。
- 路由层 `RequireAdmin` 另有 `/executors/install`、`/sops/from-video` 两个未进菜单的 admin 路由，保持原状不变。
- 命令面板 `page` 静态分组同样按 `adminOnly` + `isAdmin` 过滤；普通用户看不到 admin-only 页面条目（单测覆盖）。
- 顶栏「当前项目」切换器（`[data-testid="project-switcher"]`）保留在头部，未被菜单重排挤掉（见 1280 截图）。

## 3. 验收命令与关键输出

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/__tests__/main-layout-sider.test.tsx src/__tests__/command-palette.test.tsx src/__tests__/mobile-ui09.test.tsx` | 3 文件 **38 passed**（act()/getComputedStyle 警告为既有 antd motion 噪音，非失败） |
| `npx eslint <5 个改动文件>` | **exit 0**，无告警 |
| `npm run typecheck:web`（`npx tsc -b`） | **exit 0**，本任务文件无报错 |
| `npm run lint:i18n` | i18n-scan selftest **9/9**；硬编码中文守卫通过；i18n-key-check 仅剩并行 agent 的 `TaskImportModal.tsx`、`TemplateImportModal.tsx` 动态键未登记基线，**不属本任务文件** |

浏览器走查（Playwright + chromium-1234，dev server 5177，无后端夹具兜底）：

- 1280 中文侧栏、1280 英文侧栏：菜单结构如上；英文标签 `scrollWidth ≤ clientWidth`，无溢出。
- 375 移动端：汉堡按钮唤起抽屉，遮罩出现，`drawerOpen: true`。
- 1280 暗色：侧栏/头部深色，无白底残留。
- ⌘K 面板：零输入「操作」+「管理页面」两组；管理页面列出全部 15 个可达页面，`missingInPalette: []`；点击「执行器包」跳转 `/executor-packages` 成功（`paletteNavUrl`）。

## 4. 截图绝对路径

目录：`E:\softwareData\coding\AutoCodeFlow\docs\archive\audits\assets\product-ui-remediation-2026-11-15\nav-ia\`

- `sidebar-zh-1280.png` — 中文 1280 侧栏
- `sidebar-en-1280.png` — 英文 1280 侧栏（无截断）
- `sidebar-zh-375-drawer.png` — 375 移动端抽屉 + 遮罩
- `sidebar-zh-dark-1280.png` — 暗色 1280
- `palette-zh-1280.png` — ⌘K 管理页面分组
- `report.md` — 本报告

## 5. 待提交文件清单（精确路径，均为修改；无新增受跟踪文件）

1. `apps/admin-web/src/layouts/MainLayout.tsx` — 新 IA 菜单结构、叶子/分组类型收窄、角色过滤、Tooltip 分支、面包屑补 sops/agent-sessions
2. `apps/admin-web/src/components/CommandPalette.tsx` — `page` 静态分组、15 条页面入口、分组装配与渲染分支、admin 过滤
3. `apps/admin-web/src/locales/zh.ts` — nav 标签/分组、palette 新键、placeholder/aria（**注意**：同文件含并行 agent 的 `taskImport.*`、`templates.*` 键，提交时按文件整体纳入）
4. `apps/admin-web/src/locales/en.ts` — 成对英文键值，与 zh 键集一致（同上共享文件）
5. `apps/admin-web/src/__tests__/main-layout-sider.test.tsx` — 新分组/可见页/admin 隐藏/脏键过滤/点击辅助
6. `apps/admin-web/src/__tests__/command-palette.test.tsx` — 管理页面分组断言、admin 隐藏用例
7. `apps/admin-web/src/__tests__/mobile-ui09.test.tsx` — 分组「自动化」/子项「任务」点击路径

不入库（gitignored 探针产物，位于 `apps/admin-web/test-results/`）：`nav-ia-probe.mjs`、`nav-ia-probe-report.json`。

## 6. 风险与回滚点

- 回滚：还原上述 7 个文件即可回到 HEAD 旧 IA；菜单展开键持久化在 localStorage，`readMenuOpenKeys(validKeys)` 会过滤残留脏键并回退默认展开 `['g-tasks']`，旧缓存不会导致白屏。
- 共享文件风险：`zh.ts`/`en.ts` 与并行 agent 的导入闭环改动同文件交织；编排方合并时不要按 hunk 拆散提交，避免键集单侧缺失。
- 门控风险：admin 集合与 `router.tsx` 的 `RequireAdmin` 已逐一核对；若后续新增 admin 页面，需同时补菜单键集合与面板 `adminOnly` 标记。
- 侧栏宽度未改：英文靠缩短标签解决截断；未来新增长英文菜单项需复测 1280/1440 截断。

## 7. 未覆盖项

- 非 admin 角色的真实浏览器走查未跑（仅单测断言面板/菜单隐藏）；普通用户视角的侧边栏渲染未截图。
- 面板每条页面入口的关键词收窄与逐条跳转未逐一点击；仅抽检「执行器包」跳转 `/executor-packages`。
- 英文面板条目未单独截图（英文侧栏已验证无截断，面板文案复用 nav/palette 同套键）。
- 浏览器走查中若干 502 / SSE 重连提示属夹具缺口（探针未完整复制 ux-walkthrough 的全量夹具），非产品缺陷；与既有走查报告列名的四个 404 端点同类。
- 顶层可见行计数为 8（6 分组 + 2 直达叶子）；审计第 408 行「一级入口不超过 7 个」与第 227–228 行具体分组建议（3 场景组 + 系统拆 3 组 + 2 叶子）存在 1 个条目的口径冲突，本轮按审计具体分组建议落地，分组数 6 ≤ 7。
