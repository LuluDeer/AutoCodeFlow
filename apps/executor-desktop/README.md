# AutoCodeFlow Executor Desktop

在任意设备上安装运行，连接 AutoCodeFlow 平台接收并执行调度任务。常驻系统托盘，无需手动维护。

## 快速开始

### 开发环境

```bash
cd apps/executor-desktop
npm install

# 先打包 executor-node（首次必须）
npm run build:executor

# 启动开发模式
npm run dev
```

### 构建安装包

```bash
# 全平台
npm run dist

# 指定平台
npm run dist:win    # Windows .exe (NSIS)
npm run dist:mac    # macOS .dmg
npm run dist:linux  # Linux .AppImage
```

产物在 `dist-electron/` 目录。

## 使用流程

1. 安装后首次启动，弹出配置向导
2. 填写 Admin API 地址（如 `http://192.168.1.10:8001`）
3. 填写执行器名称、端口、对外地址（供平台回调）、Token
4. 点击「完成并启动」，执行器自动注册到平台
5. 托盘图标绿色 = 在线，红色 = 离线
6. 右键托盘可启动/停止执行器、打开配置、设置开机自启

## 执行器源码边界

- `apps/executor-node/src` 是 executor-node 的唯一源码入口。
- `resources/executor-node/index.js` 是通过 `npm run build:executor` 生成的 ncc 单文件包，不要手工编辑。
- 修改执行器能力时，先改 `apps/executor-node/src/**`，再重新运行 `npm run build:executor` 同步桌面端资源。

## 安全姿态（SEC-DSK-01 / SEC-NEW-1）

渲染层被视为**不可信显示层**，主进程是唯一特权面：

- **桥接**：`contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`，
  经 `contextBridge` 暴露白名单通道；渲染层拿不到 Node。
- **导航守卫**：所有窗口挂 `will-navigate`（只允许留在本应用页面）、
  `setWindowOpenHandler`（一律 deny）、`will-attach-webview`（拦截）。
  防止注入点把窗口整页导航到远端后带走 preload 桥。
- **CSP**：`renderer/index.html` 内置 `script-src 'self'`（不含
  `unsafe-inline`/`unsafe-eval`）、`object-src 'none'`、`base-uri 'none'`。
  改动 `index.html` 时注意别破坏它——renderer selftest 会校验。
- **Token 不过桥**：`config:get` / `executor:status` 只返回 `******` 掩码；
  明文仅经 `getDecryptedToken()` 在派生子进程 env 时使用。
- **Token 静态加密**：经 Electron `safeStorage` 以 `enc:ss:<base64>` 信封
  落盘（ADR-012）；OS keyring 不可用时降级为明文并**每进程告警一次**，
  绝不因迁移问题丢弃可用凭证。
- **路径约束**：渲染层传入的 `logPath` / `filePath` 必须落在允许域内
  （`workDir/logs`、`workDir/apps`、`userData/logs`），经 realpath 归一后
  返回 `resolvedPath`，调用方只读该值；`log:open-file` 额外限制扩展名为
  `.log`/`.txt`（防 `shell.openPath` 执行 `.exe`/`.lnk`）；`executionId`
  走 `^[A-Za-z0-9_-]+$` 白名单阻断穿越。

## 自动更新（DSK-05）

仅生产包（`app.isPackaged`）启用，启动后延迟 30s 检查，失败静默。

- **双源**：`AUTOUPDATE_URL`（generic，优先）→ 否则 GitHub Releases
  （`electron-builder.yml` 的 publish 段）。
- **`autoDownload=false`**：发现新版本只在「状态监控」页顶部横幅提示，
  用户点「下载更新」才下载（进度条走 `updater:progress` 独立通道），
  下载完点「重启并安装」。
- 也可在「配置 → 基本设置 → 版本更新」手动触发检查。

## 目录结构

```
src/
  main/           # Electron 主进程
    index.ts      # 入口，生命周期管理
    tray.ts       # 托盘图标和右键菜单
    executor-process.ts  # 子进程管理（启动/停止/日志/健康轮询）
    heartbeat.ts  # HTTP 心跳检测
    config-store.ts      # 配置持久化（token 加密/掩码）
    token-crypto.ts      # safeStorage 信封加解密（ADR-012）
    path-domain.ts       # 渲染层路径域校验（R13）
    updater.ts    # 自动更新（DSK-03/DSK-05）
    notifier.ts / notifier-rules.ts  # 系统通知（DSK-04）
    ipc-handlers.ts      # IPC channel 注册
    window-manager.ts    # 窗口管理 + 导航硬化（SEC-DSK-01）
    autolaunch.ts        # 开机自启
  preload/        # contextBridge 安全桥接
  renderer/       # React UI
    components/UpdateBanner.tsx  # 更新横幅（DSK-05）
    pages/Wizard.tsx      # 首次配置向导
    pages/StatusWindow.tsx # 状态/日志主窗口
    pages/ConfigPage.tsx   # 配置编辑页
    pages/HistoryPage.tsx  # 历史记录（搜索/统计/状态过滤）
    pages/AppsPage.tsx     # 已部署应用与日志
resources/
  executor-node/  # ncc 打包后的 executor-node 单文件
assets/           # 托盘图标（需自行准备）
scripts/
  bundle-executor.sh  # 打包 executor-node
```

## 测试

```bash
npm run test:main      # 主进程纯函数 selftest（含日志增量读、更新器、通知规则）
npm run test:renderer  # 渲染层守卫（设计令牌/无障碍/对比度/IPC 接线/安全姿态）
npm run test:e2e       # Playwright _electron 冒烟（启动、桥接白名单、干净退出）
```

## 图标准备

打包前需在 `assets/` 目录放置：

| 文件 | 说明 |
|------|------|
| `icon.png` | 应用图标 1024×1024 |
| `icon.ico` | Windows 图标 |
| `icon.icns` | macOS 图标 |
| `tray-online@2x.png` | 托盘：在线（绿色）32×32 |
| `tray-offline@2x.png` | 托盘：离线（红色）32×32 |
| `tray-pending@2x.png` | 托盘：启动中（黄色）32×32 |

可用 [electron-icon-builder](https://www.npmjs.com/package/electron-icon-builder) 从 `icon.png` 自动生成各格式。

## 注意事项

- **Windows**：不支持 SIGTERM 优雅退出，停止执行器时直接 SIGKILL
- **macOS**：非签名 DMG 首次打开需右键选「打开」绕过 Gatekeeper
- **token**：与 admin-api 的 `EXECUTOR_SECRET` 环境变量保持一致（兼容旧版 `EXECUTOR_SHARED_TOKEN`）
- **对外地址**：填本机可被 admin-api 访问的 IP:端口，不要填 `0.0.0.0`
