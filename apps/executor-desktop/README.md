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

## 目录结构

```
src/
  main/           # Electron 主进程
    index.ts      # 入口，生命周期管理
    tray.ts       # 托盘图标和右键菜单
    executor-process.ts  # 子进程管理（启动/停止/日志）
    heartbeat.ts  # HTTP 心跳检测
    config-store.ts      # 配置持久化
    ipc-handlers.ts      # IPC channel 注册
    window-manager.ts    # 窗口管理
    autolaunch.ts        # 开机自启
  preload/        # contextBridge 安全桥接
  renderer/       # React UI
    pages/Wizard.tsx      # 首次配置向导
    pages/StatusWindow.tsx # 状态/日志主窗口
    pages/ConfigPage.tsx   # 配置编辑页
resources/
  executor-node/  # ncc 打包后的 executor-node 单文件
assets/           # 托盘图标（需自行准备）
scripts/
  bundle-executor.sh  # 打包 executor-node
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
