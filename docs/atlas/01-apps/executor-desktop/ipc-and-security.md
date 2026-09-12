# executor-desktop IPC 通道白名单与安全收敛
> 所属: docs/atlas/01-apps/executor-desktop · 最后核对: 2026-09-13 · 对应代码: apps/executor-desktop/src/main/ipc-handlers.ts、src/preload/index.ts、src/main/window-manager.ts、src/main/token-crypto.ts、src/main/path-domain.ts

## 渲染层隔离基线（window-manager.ts `sharedWebPreferences()`）

所有窗口（Wizard/Status/Config）共用同一份 `webPreferences`（BUG-12 收敛为单一来源）：

```ts
{ preload: PRELOAD_PATH, contextIsolation: true, nodeIntegration: false, devTools: true }
```

- `contextIsolation: true` + `nodeIntegration: false`：渲染层拿不到 Node 能力，只能经 preload 暴露的 `window.electronAPI` 调用；Electron ≥20 sandbox 默认开启，preload 也无法整包引入 Node 模块。
- `devTools` 保留：桌面工具用户需要自诊；渲染层从不接触机密（见下），故不构成安全边界。
- 页面加载：生产 `loadFile(dist/renderer/index.html, {hash})`，dev 走 `VITE_DEV_SERVER_URL` hash 路由。

## IPC 通道全量清单（ipc-handlers.ts 核实）

| 通道（ipcMain.handle） | 功能 | 入参防线 |
|---|---|---|
| `config:get` / `executor:status` | 读配置 | 返回掩码配置（token 恒 `******`，SEC-NEW-1） |
| `config:save` / `config:save-and-close-wizard` | 写配置 | `isPlainConfig` 拒绝数组/嵌套对象（BUG-12：electron-store 点号 setter 深抛） |
| `config:test-connection` | 探活 admin-api | URL 解析 + 仅 http/https（R24 修复 https 误走 80） |
| `config:check-port` | 端口占用检测 | net Server 试听 0.0.0.0 |
| `executor:start` / `executor:stop` | 内核启停 | 无入参 |
| `autolaunch:get` / `autolaunch:set` | 开机自启 | boolean |
| `updater:check` / `updater:install` | 手动检查/确认安装 | dev 未初始化时静默 ok:false |
| `history:get` / `history:clear` | 任务历史（workDir/meta） | 服务端拼路径，无入参路径 |
| `log:read` | 读任务日志 | executionId 白名单 `^[A-Za-z0-9_-]+$` + 路径域校验 |
| `log:list-files` | 列日志文件 | 服务端枚举，最近 30 天 |
| `log:open-file` | 系统打开日志 | 域校验 + 仅 `.log/.txt`（Windows 下 `shell.openPath` 可执行 .bat/.lnk/.exe，R13） |
| `apps:list` / `apps:log:read` | 已部署应用与日志 | logPath 域校验 |
| `window:minimize` / `window:close` | 无边框窗口控制 | 取 `event.sender` 对应窗口 |
| `network:local-ips` | 本机 IPv4 列表 | 无入参 |

主进程 → 渲染层单向推送（`webContents.send`）：`executor:log-line`、`executor:status-change`、`switch-tab`、`updater:available`、`updater:downloaded`、`updater:error`（通道名常量 `UPDATE_EVENTS` 在 updater.ts）。

```
renderer ──invoke('log:read', executionId)──▶ ipcMain
                                               │ ① isValidExecutionId（防 ../）
                                               │ ② checkPathWithinDomains(路径, 允许域)
                                               ▼
   允许域 = [workDir/logs, workDir/apps, userData/logs]（getAllowedLogDomains()）
```

## 凭据处理（token-crypto.ts + config-store.ts，SEC-NEW-1 / ADR-012）

1. **落盘加密**：`executorToken` 经 Electron `safeStorage` 加密，存为 `enc:ss:<base64>` 信封；启动时 `migratePlaintextToken()` 对旧明文一次性就地加密（原子替换，无双字段兼容窗口）。safeStorage 不可用时按 ADR-012 降级为保留明文 + 一次性告警（绝不丢弃可用凭据）。
2. **IPC 不回传明文**：`getAllMasked()` 把 token 换成 `******`；渲染层保存时若回传掩码或空串（语义为"清除"），config-store 映射为"保持原值"，明文/密文永远只在主进程内存与磁盘之间流转。
3. **唯一明文消费点**：`executor-process.ts resolveToken()` 解密后注入内核子进程 env（`EXECUTOR_SHARED_TOKEN`）——这是整个应用唯一需要明文的地方。
4. 加解密逻辑为纯 Node + 注入式 safeStorage 适配器，可在无 Electron 环境跑 selftest（`npm run test:main` 的 token-crypto.selftest.js）。

## 文件访问域（path-domain.ts，R13）

- `isValidExecutionId()`：渲染层提供的 executionId 必须匹配 `^[A-Za-z0-9_-]+$`（与 admin-api 心跳消毒同规则），从源头杜绝 `../`。
- `checkPathWithinDomains()`：resolve 后校验目标必须落在允许域内（真实 resolve 对抗 symlink/相对路径）。
- `hasAllowedLogExtension()`：`log:open-file` 只放行 `.log/.txt`，防止 `shell.openPath` 在 Windows 上执行任意脚本。

## 安全事件面小结

| 攻击面 | 收敛手段 |
|---|---|
| 渲染层 RCE → Node | contextIsolation + nodeIntegration:false + sandbox 默认 |
| token 经 IPC 泄露 | 掩码返回 + 保存哨兵值语义 + safeStorage 落盘加密 |
| 任意文件读/执行 | executionId 白名单 + 路径域校验 + 扩展名白名单 |
| 配置注入（store 深抛） | `isPlainConfig` 平面对象校验 |
| 内核 env 泄露到渲染层 | env 只在主进程构造（executor-process.ts），渲染层拿到的永远是掩码 |
| 第二实例抢占 | `requestSingleInstanceLock`，二次启动仅聚焦已有窗口 |

## 常见改动场景

- **加一个只读通道**：handler 内先做入参白名单，再走 `checkPathWithinDomains`；preload 只加透传，不拼路径。
- **加一个敏感设置**：先在 config-store 定义掩码语义（参照 `TOKEN_MASKS`），再接 UI；禁止把敏感值放 `executor:status` 等已有载荷。
- **改窗口形态**：新增窗口必须复用 `sharedWebPreferences()`，不得单独传宽松 webPreferences。

## 相关文档

- [executor-desktop 总览](README.md) —— 架构/打包/更新
- [executor-node](../executor-node/README.md) —— 被托管内核（token 由其消费）
- [安全模型](../../04-flows/security-model.md) —— 全平台认证与信任链
- [admin-api executor 模块](../admin-api/modules/executor.md) —— 注册/令牌轮换的服务端视角
