# ADR-029: 执行器桌面端 V2 渲染层——独立渲染层 + Electron 外壳，Tauri 暂不采用

状态：Accepted

## 背景

V1 渲染层是手写 CSS：`styles/pages.css` 2,403 行、`components.css` 848 行，页面级覆盖占
63%，缺少「有行为、有变体、有令牌」的原语层。结果是每轮 UI 调整都在补丁式堆样式，
观感始终停在「能用」而不是「像个成熟客户端」。

同时存在一条技术选型疑问：是否改用 Rust（Tauri / Dioxus / GPUI 等）重写客户端。
该问题把「壳层语言」与「UI 质量」混在了一起——实际决定观感的是组件体系、排版密度、
动效与键盘路径，而不是壳层语言。

约束：

- V1 主进程已有 15.8k 行能力（进程监管、托盘、自启、更新器、配置、日志、Agent），
  这些是真实资产，不能为了换壳一次性丢弃；
- 客户端要带 `executor-node` / `playwright` / `uv` 等 sidecar，安装包体积的大头不在壳；
- 必须能在无显示器的 CI 里自动验收。

## 决策

1. **新增独立渲染层** `apps/executor-desktop-v2`：React 19 + Tailwind v4 + Radix
   （shadcn 约定）+ TanStack Virtual，令牌集中在 `styles.css` 的 `@theme`，页面禁止
   写裸色值/字号。壳无关，产物可被任意 webview 加载。
2. **保留 Electron 外壳**，V2 成为默认渲染层：`resolveRendererIndex()` 默认返回
   `dist/renderer-v2/index.html`；`ACF_RENDERER=v1` 是显式回退；V2 产物缺失时回退 V1
   并落 warn，绝不白屏。`loadPage`、导航守卫、IPC sender 闸共用同一个解析函数。
3. **单一 IPC 边界**：渲染层只依赖 `src/lib/ipc.ts` 的类型化接口。浏览器环境自动落到
   mock（localStorage 持久化 + 定时日志流），Electron 环境走 preload 真桥；页面代码
   不出现 `window.electronAPI`。
4. **生产用 `file://` 加载**：V2 产物 `base: './'`，复制到
   `dist/renderer-v2/`，由 `electron-builder` 的 `files` 收进 asar；构建期注入 CSP
   （`script-src 'self'`，字体允许 `data:`，样式允许内联给 Radix 定位）。
5. **窗口形态**：`#wizard` 渲染无壳独立向导（保存走 `save-and-close-wizard`），
   其余 hash 映射主窗 Tab；托盘 `switch-tab` 事件驱动切页。
6. **验收是决策的一部分**：`verify:v2`（真壳 36 项）、`a11y:v2`（axe + 键盘）、
   `visual:v2`（5 页像素基线）、`verify:v2:packaged`（asar + sidecar）、
   `.github/workflows/v2-verify.yml`（xvfb + openbox + dbus）。
7. **Tauri 暂不采用**：`apps/executor-desktop-tauri` 保留最小 POC（Tauri 2 + WebKitGTK
   能渲染同一份 V2 产物），但不含 IPC/托盘/更新器/sidecar，不可发布。重开条件见
   「后果」。

## 后果

正向：

- UI 迭代从「改页面 CSS」变成「改原语/令牌」，组件画廊是视觉合同，像素基线防回归；
- 壳与 UI 解耦：同一份产物已经证明可跑在 Electron（Chromium/WebView2）与
  Tauri（WebKitGTK）两种 webview；
- IPC 契约集中，mock 让视觉评审与 CI 不依赖 Electron；
- 默认切换可回退（`ACF_RENDERER=v1`），迁移风险可控。

代价与边界：

- 需要同时维护 V1/V2 两套渲染产物，直到 V1 被删除；
- V2 的 `verify:v2` 依赖固定端口 9123 与 seed 数据，属于本机/CI 验收约定；
- Tauri POC 仅证明「渲染层可复用」，不证明壳层能力等价；
- 视觉基线对环境字体敏感，CI 需安装 `fonts-noto-cjk`，阈值可由
  `VISUAL_THRESHOLD` 调整。

可执行验收（当前全部通过）：

- `npm run verify:v2`：加载路径、IPC、托盘、执行器启停/重启、向导落盘、崩溃恢复、
  写操作（配置保存 / 清空历史）、英文全页；
- `npm run a11y:v2`：wcag2a/aa 零 serious/critical，Esc 焦点归还；
- `npm run visual:v2`：5 页 0.000% 差异；
- `npm run verify:v2:packaged`：as packaged 形态加载 asar 并启停 sidecar。

Tauri 重开条件（满足任一即可启动迁移评估）：

1. 需要 Rust 侧的原生能力（更严格的进程隔离、单二进制分发、非 Web 的原生窗口）；
2. Electron 的体积/内存成为实际用户问题（且 sidecar 已完成瘦身）；
3. 团队愿意承担主进程 15.8k 行能力的 Rust 重写与打包签名链路重建。

## 替代方案（被否）

- **继续在 V1 上手写 CSS**：缺原语层，样式漂移不可控；V1 的 `pages.css` 已经证明这条路
  的边际收益递减。
- **直接全量迁移 Tauri**：UI 收益为零（同一套 web 技术），但主进程要重写、更新器/托盘/
  sidecar 全部重做，且安装包不会因换壳显著变小。
- **纯 Rust UI（Dioxus / Slint / egui）**：组件生态与打磨成本不匹配当前产品阶段；
  Dioxus 0.7 的 Radix 等价物仅 28 个原语，缺少日志虚拟化、命令面板等成熟实现。
- **Flutter**：组件现成，但换语言与桌面质感主题化成本高，且无法复用现有 V2 渲染层。

## 关联

- 渲染层：`apps/executor-desktop-v2/`（README 含验收与构建细节）
- 壳层改动：`apps/executor-desktop/src/main/{window-manager,index,ipc-handlers}.ts`
- 验收脚本：`apps/executor-desktop/scripts/{verify-v2-shell,verify-packaged-v2,a11y-v2,visual-v2}.mjs`
- Tauri POC：`apps/executor-desktop-tauri/`
- 相关 ADR：ADR-022（Agent 信任模型）、ADR-028（配置密钥静态加密边界）
