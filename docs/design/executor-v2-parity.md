# 执行器 V1 / V2 功能对照与升级兼容性

> 结论先行：**V2 可以作为覆盖升级包直接装到已安装 V1 的设备上**，前提是版本号必须
> 高于设备现有版本、安装包内确实打进了 `dist/renderer-v2/`、且保持相同的安装身份
> （appId / productName / 包名）与安装模式。数据不需要迁移。
>
> 当前代码里有一个**必须修复的发布链路缺口**：V2 默认渲染层不会自动进入安装包（见 §4，
> 已在 `release-desktop.yml` 中补上，但仍需提交并跑一次真实 release 验证）。

## 1. V1 有、V2 还没有的

| 功能 | V1 实现 | V2 现状 | 影响 |
|---|---|---|---|
| 应用运行状态 | `getRunningApps`（executor `/api/app-status`）合并到列表 | **已补**：adapter 调 `getRunningApps`，按 deploymentId 合并 `runningCount/status` | 已对齐 |
| 配置导入 / 导出 | `config:export` / `config:import`（主进程 saveDialog） | 缺失 | 换机迁移、备份能力缺口 |
| Pull 回连模式 | `pullMode` 开关 | 缺失 | 内网/反连部署不可配置 |
| Agent 权限档位 | `agentEnabled` / profile / codeExecution / hostAccess / taskExecution / allowedApps / allowedDomains | 仅静态说明 | Agent 能力无法在 V2 配置 |
| 状态页更新横幅 | `UpdateBanner` 订阅四个 updater 事件 | 配置页 `UpdatePanel` 有完整状态机，但状态页没有全局入口 | 用户不主动进配置就看不到更新 |
| 桌面日志文件浏览 | `logs:listFiles` + 选择历史日期的日志文件 | 只读当天主日志 | 跨天排障能力缺口 |
| Agent 运行状态 | `agent:get-status` | 缺失（静态卡） | Agent 是否在跑不可见 |
| 向导本地 IP / 镜像探测 | `getLocalIPs`、`testInterpreterSource` | 缺失（手填地址/镜像） | 首启体验弱于 V1 |
| 历史日期分组 / Ctrl+F | 按自然日插入分组头、列表页搜索快捷键 | 无分组；日志面板有搜索但没有 Ctrl+F | 长列表定位效率略低 |

V2 反向多出来的能力：批量卸载、版本列表与按版本日志/目录/删除、日志搜索/行号/放大、
全局命令面板、完整中英切换、表格虚拟化、无障碍与像素回归门禁。

## 2. 升级身份：为什么可以原地覆盖

| 项 | V1 / V2 | 结论 |
|---|---|---|
| `appId` | `com.autocodeflow.executor-desktop` | 相同 → NSIS 视为同一应用升级 |
| `productName` | `AutoCodeFlow Executor` | 相同 |
| `package.json name` | `executor-desktop` | 相同 → `app.getPath('userData')` 不变 |
| userData 内容 | `config.json`、`work/meta`、`work/apps`、日志 | V2 只读同样的键与目录，无 schema 迁移 |
| 安装模式 | NSIS `oneClick:false`，`perMachine` 未设置 → **per-user** | V1/V2 配置一致；若某设备曾用 per-machine 安装，需要保持同一模式 |
| 更新源 | GitHub provider + `latest*.yml` | 版本号更高即会提示升级 |

因此升级后：配置、历史、应用目录、令牌、开机自启都保留；V1 渲染层仍随包保留，
`resolveRendererIndex()` 默认加载 V2。

## 3. 数据兼容

- 配置：V2 读取 V1 同名字段；V2 新增的只是前端状态，不写新键。
- 历史：仍读 `workDir/meta/*.json`；`startTime/endTime/status/taskName` 口径未变。
- 应用：仍读 `workDir/apps/<appId>/releases/<version>-<deploymentId>/`；V2 新增的
  `current` 缺失判断、版本列表、按版本日志都是只读推导。
- 日志：仍读 `workDir/logs/<date>/<executionId>.log` 与主进程日志。

**没有数据库迁移、没有配置迁移、没有目录搬家。**

## 4. 发布前必须做的事（按顺序）

1. **版本号必须提升**：当前已切到 `2.0.0`；V2 首次发布用 tag `desktop-v2.0.0`。与已安装 V1 相同版本的包
   不会触发 electron-updater，后续每次发布都必须继续递增。
2. **V2 必须打进安装包**：`apps/executor-desktop` 的默认 `build` 脚本不包含
   `build:renderer-v2`。本次已：
   - 在 `release-desktop.yml` 增加「安装 V2 依赖 + `npm run build`」；
   - 打包前执行 `npm run build:renderer-v2`；
   - 出包后断言 `dist/renderer-v2/index.html` 存在且已进入 `app.asar`。
   仍需**提交后跑一次真实 release** 验证；`ci.yml` 里其它打包 job 仍只出 V1 渲染层
   （用于冒烟，不是发布）。
3. **签名 / 更新清单**：Windows 建议代码签名；macOS 的 electron-updater 需要签名与
   notarization（当前 release 设置了 `CSC_IDENTITY_AUTO_DISCOVERY=false`，只能出未签名包）。
4. **安装模式一致**：V1 与 V2 都保持 per-user NSIS；如果历史设备是 per-machine，
   需要同样用 per-machine 包升级，否则会出现两套安装。
5. **回退方案**：V1 渲染层仍在包里，但**打包态没有用户可切换的开关**（只有
   `ACF_RENDERER=v1` 环境变量）。建议在正式放量前加一个隐藏配置/安全模式，
   或先小流量灰度。

## 5. 升级路径逐平台

- **Windows（NSIS）**：同 appId + 更高版本 → 安装器覆盖现有目录，用户数据不动。
  NSIS 会按现有安装位置升级；per-user/per-machine 必须一致。
- **Linux AppImage**：`latest-linux.yml` 指向新的 AppImage；electron-updater 在
  `APPIMAGE` 环境存在时替换文件并重启。手动安装则直接替换 AppImage 文件。
- **Linux deb**：同一包名 → `apt/dpkg` 原地升级；包名沿用 `executor-desktop`
  （本地未构建 deb 验证，发布流水线会产出）。
- **macOS dmg**：同一 bundle id 覆盖安装；自动更新依赖签名，未签名包只能手动安装。

## 6. 升级后自检清单

- 窗口默认渲染 V2（标题栏/侧栏是新版），不是 V1；
- 配置页读回原有地址、令牌、并发、uv 镜像；
- 历史页能看到升级前的记录；
- 应用页能看到既有应用（含运行状态与版本列表）；
- 执行器可启动/停止，托盘切页正常；
- 更新面板能检查到「已是最新」。

## 7. 剩余缺口优先级建议

1. 配置导入/导出（换机与备份，成本低）；
2. Pull 回连模式 + Agent 权限档位（部署能力，需产品确认范围）；
3. 状态页全局更新横幅（复用 `UpdatePanel` 的状态机）；
4. 历史日志文件浏览与 Ctrl+F（排障效率）。

关联：`apps/executor-desktop-v2/README.md`、`.github/workflows/release-desktop.yml`、
ADR-029。
