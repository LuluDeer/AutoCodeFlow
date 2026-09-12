# executor-desktop 应用总览（Electron 桌面执行器）
> 所属: docs/atlas/01-apps/executor-desktop · 最后核对: 2026-09-13 · 对应代码: apps/executor-desktop/src（main/、preload/、renderer/）

## 一句话定位

executor-desktop 是 **Electron 托盘应用**：把 ncc 打包的 executor-node 作为子进程（`ELECTRON_RUN_AS_NODE=1`）托管运行，提供配置向导、状态窗口、任务历史、日志查看、系统通知与开机自启；对 admin-api 而言它就是一个 executor-node 实例，注册/心跳/回调协议不变。

## 技术栈与版本（摘自 apps/executor-desktop/package.json）

| 类别 | 依赖 | 版本 |
|---|---|---|
| 运行时 | electron | ^43.4.0 |
| 构建 | electron-builder / vite / vite-plugin-electron | ^26.15.3 / ^8.2.1 / 0.28.7 |
| UI | react / react-dom + @vitejs/plugin-react | 18.3.1 |
| 更新 | electron-updater | 6.8.9 |
| 存储 | electron-store | 8.2.0 |
| 日志 | electron-log | 5.1.7 |
| 自启 | auto-launch | 5.0.6 |
| 内核打包 | @vercel/ncc | ^0.44.0 |

常用命令：`npm run dev`（vite）、`npm run build`（= build:executor → build:main → build:renderer）、`npm run dist:win|mac|linux`、`npm run test:main`（4 个 selftest：path-domain / token-crypto / updater / notifier-rules）、`npm run test:e2e`（Playwright，e2e/desktop-smoke.spec.js）。

## 架构（主进程 / 预加载 / 渲染）

```
┌─ main 进程（src/main/，tsc 编译到 dist/main）────────────────────────────┐
│ index.ts      装配 + 单实例锁 + before-quit 等子进程退出后再 quit          │
│ config-store  electron-store 配置（schema 默认值；token 加密落盘）        │
│ executor-process  spawn executor-node 内核 + 日志推断注册/心跳状态        │
│ heartbeat     每 10s 轮询 http://127.0.0.1:<port>/health/live（2 失败→offline）│
│ tray          托盘图标（online/offline/pending/stopped 四态）+ 菜单       │
│ window-manager 状态/向导窗口（统一 webPreferences，见 ipc-and-security.md）│
│ ipc-handlers  全部 IPC 通道白名单（config/executor/updater/history/log/apps）│
│ updater       electron-updater：AUTOUPDATE_URL 泛用源 > GitHub Releases   │
│ notifier      DSK-04：轮询 workDir/meta/*.json 捕获任务终态发系统通知      │
│ autolaunch / token-crypto / path-domain / notifier-rules / logger        │
└──────────────────────────────────────────────────────────────────────────┘
        ▲ ipcRenderer.invoke（白名单通道）      │ 'executor:log-line'、
┌─ preload（src/preload/index.ts）─┐            │ 'executor:status-change'、
│ contextBridge.exposeInMainWorld( │◀───────────┘ 'switch-tab'、'updater:*' 单向推送
│   'electronAPI', {…})            │
└──────────────────────────────────┘
┌─ renderer（src/renderer/，React + Vite，hash 路由）──────────────────────┐
│ pages/Wizard.tsx（首次配置向导）· StatusWindow.tsx（状态+日志流）          │
│ pages/ConfigPage.tsx · HistoryPage.tsx（读 workDir/meta）· AppsPage.tsx  │
└──────────────────────────────────────────────────────────────────────────┘
```

## 内核托管（executor-process.ts）

- 入口：打包态 `process.resourcesPath/executor-node/index.js`，开发态 `resources/executor-node/index.js`（由 `scripts/bundle-executor.sh` 用 @vercel/ncc 从 apps/executor-node 产出，见 `npm run build:executor`）。
- spawn `process.execPath`（即 Electron 二进制）+ `ELECTRON_RUN_AS_NODE: '1'`，env 注入：`APP_NAME`、`PORT`（默认 8002）、`EXECUTOR_ADDRESS`（`<host>:<port>`）、`EXECUTOR_ADDRESS_PUBLIC`、`ADMIN_API_URL`、`WORK_DIR`（默认 `userData/tasks`）、`MAX_CONCURRENT_TASKS`、`EXECUTOR_SHARED_TOKEN`（由 `token-crypto.decryptToken` 解出 `enc:ss:` 信封）。
- 在线状态判定：health 轮询只是"进程存活"信号；真正的 online/offline 由子进程日志文本推断（`Register failed` / `Heartbeat failed` → failed，见到成功日志 → registered），R23 修复了"存活即 online"的误判。
- 停机：`stop()` 等待退出 8s 超时后强杀进程树；`before-quit` 用 `preventDefault` 保证先停执行器再退出。

## 打包（electron-builder.yml）

- `appId: com.autocodeflow.executor-desktop`，`productName: AutoCodeFlow Executor`；extraResources 把 `resources/executor-node/` 与托盘图标 `assets/tray-*.png` 带进包内。
- 目标：win NSIS（x64+arm64）、mac dmg、linux AppImage+deb（deb 显式 maintainer/vendor 与 StartupWMClass，DSK-02）。
- 更新源（DSK-03）：`publish.provider: github`（LuluDeer/AutoCodeFlow）为默认；运行时可用 env `AUTOUPDATE_URL` 切到泛用 HTTP 源（executor-packages 通道/私有化部署）。启动延迟 30s 检查、`autoDownload=false`（用户确认后 `updater:install`）、仅打包态启用（dev 无 app-update.yml 会报错）。

## 与 admin-api 的关系

- 桌面端自身**不直接**与 admin-api 通信（仅 `config:test-connection` 探活 `GET /api/health` 帮用户排错）；注册/心跳/回调全部由内置 executor-node 内核完成，契约见 [执行器协议契约](../executor-contract.md)。
- 用户在向导/配置页填的 `adminApiUrl`、token、并发数等，经 IPC 落入 config-store 后，转换为内核的 env。
- 配置变更即"停内核→按新配置重启"（`config:save` handler），对 admin 而言表现为一次重启（`startupId` 变化触发令牌轮换）。

## 目录结构与关键文件

```
apps/executor-desktop/
├── electron-builder.yml / package.json / vite*.config.ts
├── scripts/bundle-executor.sh        ncc 打包 executor-node 内核
├── resources/executor-node/index.js  内核产物（构建时生成）
├── src/main/…                        主进程（见架构图）
├── src/preload/index.ts              contextBridge 白名单桥
├── src/renderer/…                    React 页面（Wizard/Status/Config/History/Apps）
└── e2e/desktop-smoke.spec.js         Playwright 冒烟（QA-12：env 隔离 userData）
```

## 常见改动场景

- **新增设置项**：`config-store.ts` AppConfig 接口 + schema 默认值 → `ipc-handlers.ts` 校验 → renderer ConfigPage 表单；敏感项必须走掩码/加密通道。
- **新增 IPC 通道**：`ipc-handlers.ts` 注册 handler + `preload/index.ts` 暴露；若涉及文件路径，必须复用 `path-domain.ts` 的 `checkPathWithinDomains()` 域校验（R13）。
- **换更新源**：优先级逻辑在 `src/main/updater.ts resolveGenericFeedUrl()`；发布走 GitHub Releases（见 [发版流程](../../08-workflows/release-process.md)）。
- **升级内置内核**：重跑 `npm run build:executor`；内核行为变更需同步 [executor-node 文档](../executor-node/README.md)。

## 相关文档

- [IPC 通道白名单与安全收敛](ipc-and-security.md) —— contextIsolation / token 掩码 / 路径域
- [executor-node](../executor-node/README.md) —— 被托管内核的完整文档
- [执行器注册流程](../../04-flows/executor-registration.md) · [三种执行器对比](../executors-comparison.md)
