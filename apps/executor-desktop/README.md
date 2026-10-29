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

### Python 多版本支持（uv）

客户端执行器与 python 执行器**功能对等**：任务可以声明 `runtimeVersion`（如 `3.11`），
执行器会用 [uv](https://docs.astral.sh/uv/) 获取该版本的 Python 并建独立虚拟环境。
声明版本的任务**必须**有 uv 可用；**不声明版本的任务完全不碰 uv**，所以没装 uv 不影响存量功能。

uv 的解析顺序（由 executor-node 实现）：

1. 桌面设置里的 `uvPath`（最高优先级，适合内网自建分发）；
2. 随安装包自带的 uv（`resources/uv/uv` 或 `uv.exe`）；
3. 环境变量 `UV_BIN`；
4. 系统 `PATH` 上的 `uv`。

#### 装了客户端后，后台显示「Node.js」而不是「通用」？

`type` 字段**由探测结果推导**：具备 Python 能力 → `universal`（后台显示「通用」），
否则 `node`。Python 能力走**双通道**，任一成立即可：

1. 系统 `python3` / `python` /（Windows）`py` **实跑 `--version` 通过**；
2. **自带 uv 可用** —— 能按 `runtimeVersion` 获取解释器，这正是客户端「通用执行器」的核心能力。

所以装**正式发布包**（自带 uv）后应当显示「通用」。若仍显示「Node.js」，按顺序排查：

1. 确认该包确实自带 uv：安装目录下 `resources/uv/uv.exe` 是否存在；
2. 检查**是否旧版本客户端** —— v1.5.1 及更早的发布包不含 uv，且注册时把
   `type` 硬编码成 `'node'`，**必然**显示 Node.js；
3. 看启动日志：`Registered to admin-api (runtimes: ...)`。含 `python` 即正常。

> **重要**：`type` 只影响后台**展示**，不参与任务派发。派发依据是
> `capabilities`（`runtimes` 上报值）——admin 侧按 `capabilities.includes(task.runtime)`
> 过滤，而任务 runtime 的实体缺省值是 `python`。所以"显示 Node.js"通常伴随
> **Python 任务派不到这台设备**，两者是同一病根。

> 历史坑（v1.5.1 及更早，已修）：能力探测用 `which python3|python`，而
> **Windows 上没有 `which`**（`spawnSync` 返回 ENOENT）。代码只判 `status === 0`，
> 于是 Windows 客户端**恒定**上报 `shell,node` —— 哪怕机器上装了 Python。
> 现改为实跑探测，并让"自带 uv"也算作 Python 能力。

#### 能力上报与"真的能跑"必须同源（2026-10 修复）

排查一起生产事故时发现本客户端存在一类**架构性**问题：**能力上报与任务执行是
两套代码、两个真值源**，于是"上报的"与"能兑现的"可以互不一致，且**双方都不报错**：

- **node 虚报**：执行器由 Electron 以 `ELECTRON_RUN_AS_NODE=1` 启动
  （`process.execPath` 是 **Electron**，不是系统 `node`），而任务执行侧曾经硬编码
  裸 `node.exe`。于是一台**没装 Node.js** 的机器照样上报 `node` 能力，中台持续
  派发 node 任务，任务在 `spawn` 时 ENOENT。
- **python 落到 Store 占位 stub**：无版本 python 任务的兜底是宿主 `python.exe`。
  Windows 上该名字常是 **Microsoft Store 的 App Execution Alias 占位程序**——
  文件真实存在、`spawn` 能命中，实跑却必然失败（exit 9009）并打印一句与平台
  无关的英文商店提示。**应用部署链更彻底**：它当时完全没有接入解释器池
  （`grep -c uv routes/deploy.ts` = **0**），python 应用一律 `python -m venv` 宿主，
  全新机器上必然失败。
- **macOS GUI 的 PATH**：从 Finder/Dock 启动的 `.app` 不继承登录 shell 的 PATH，
  于是机器上装了 Homebrew 的 python/git 也一律找不到。

现在统一收敛到 `apps/executor-node/src/toolchain.ts` 这一处**单一真值源**：
能力上报与任务执行**都**消费它，判定一律用**实跑 `--version`**（存在性判定会把
假解释器当成真解释器）。修复后的行为：

| 情形 | 修复前 | 修复后 |
|---|---|---|
| 无版本 python 任务，宿主只有 Store stub | spawn 命中 stub → exit 9009 + 英文提示 | **明确失败**并归类 `interpreter_unavailable`，消息点名 stub 并给出修复指引 |
| node 任务，宿主没装 Node | `spawn node.exe` ENOENT（且能力仍上报 node） | 复用 Electron 自身当 node 跑（`ELECTRON_RUN_AS_NODE=1`）；确实无解时**如实不上报** node 能力 |
| python 应用部署 | 必失败（未接解释器池） | 优先 uv 池内解释器 → 验真过的宿主解释器 → 明确失败 |
| macOS 从 Dock 启动 | 继承 launchd 的空 PATH | 解析登录 shell 的 PATH 并**前置**合并（用户选的解释器优先于 `/usr/bin` 系统桩） |

> **仍未解决（已知边界，勿误判）**：`git` 与 `npm` **仍是宿主依赖**——两者被工具链
> 探测但调用点尚未改为消费解析结果，全新机器上跑 git 渠道任务或装 node 依赖仍可能
> 失败。这是同一根因的**残余**，见 `docs/design/desktop-self-contained-runtime/DESIGN.md`
> 的 D-4 决策项。另外应用部署**仍不支持声明 `runtimeVersion`**（`Application` 实体
> 无该字段），它只按"池内有什么 → 宿主有什么"顺序解析。

#### 无版本 python 任务：默认按 3.12 经 uv 获取

宿主**没有**可用 Python 时，无声明版本的 python 任务/应用会**经 uv 取得默认版本
3.12**（`DEFAULT_PYTHON_VERSION`，与中台调度侧的 `LEGACY_DEFAULT_INTERPRETERS`
刻意对齐）并用它执行——这就是"带了 uv 就能跑"的兑现方式。两个必须知道的前提：

- **需要能取到解释器**：首次会在约 13~17s 内下载（内网请配「解释器镜像源」，或按
  `OFFLINE-PROVISIONING.md` 离线预填）。**纯离线且池空**时仍会失败，但失败是**可读的**
  `interpreter_unavailable`（带池快照与指引），不再是那句莫名的 Store 英文提示。
- **有宿主 Python 时行为完全不变**：仍走宿主解释器、不建 venv、不碰 uv（兼容红线）。

**正式发布包必须自带 uv**（发布流水线已强制，见下）。本机构建默认不打进安装包
（避免构建期联网、也不改变既有产物哈希）。需要自带时：

```bash
# Linux / macOS（以及 CI）——直接前置于 npm 命令即可
ACF_BUNDLE_UV=1 npm run build:executor                             # 尝试联网下载 uv
ACF_BUNDLE_UV=1 ACF_UV_SOURCE=/path/to/uv npm run build:executor   # 用本地已下载的 uv
ACF_BUNDLE_UV=1 ACF_UV_VERSION=0.8.17 npm run build:executor       # 指定版本（默认 0.8.17）

# 发布用：缺 uv 直接让构建失败，绝不产出残包
ACF_BUNDLE_UV=1 ACF_UV_REQUIRED=1 npm run build:executor
```

#### 为什么要 `ACF_UV_REQUIRED`（desktop-v1.5.1 实爆）

v1.5.1 的正式安装包**不含 uv**：`ACF_BUNDLE_UV` 默认 `0`，而
`release-desktop.yml` 也没设它，加上"下载失败只告警、退出码仍为 0"的
best-effort 契约，于是一个能力残缺的包被正常发布了。全新设备装完的表现是：

```
[WARN] uv is not available (no UV_BIN, not on PATH, no bundled binary) \
       — python tasks that declare runtimeVersion cannot run on this executor
[INFO] Registered to admin-api (runtimes: shell, node, ...)
```

即**只上报 `shell, node`，声明 `runtimeVersion` 的 Python 任务全部不可用**，
而客户端与平台两侧都没有"这个包是残的"的提示。现在：

- 发布流水线（`release-desktop.yml`）固定带
  `ACF_BUNDLE_UV=1 ACF_UV_REQUIRED=1 ACF_UV_VERSION=0.8.17`；
- `ACF_UV_REQUIRED=1` 时，缺 uv（含"忘开 `ACF_BUNDLE_UV`"）→ **`exit 1`**，
  发布被拦下；
- 出包后还会**解包安装产物**断言 uv 确实在包里（`extraResources` 漏带也能发现）；
- CI 的 `desktop-uv-bundle-gate` 在三平台真跑一遍严格打包，并断言落点与
  `uv-paths.ts` / `interpreters.ts` 的解析约定一致。

> ⚠ **校验 NSIS 安装包时不要直接 `7z l` 那个 .exe**（desktop-v1.5.2 实爆）：
> electron-builder 产出的 Windows 安装包只是 NSIS **外壳**，`7z l` 仅能列出
> `$PLUGINSDIR\*`、`$R0\Uninstall*.exe` 等外壳条目，真正的应用负载在**嵌套的**
> `$PLUGINSDIR\app-64.7z` 内。因此形如
> `grep -q 'resources[\\/]uv[\\/]uv\.exe'` 的断言对 .exe **恒定不命中**，
> 与 uv 在不在包里无关（即"恒定假阴性"）。
>
> 实测（对真实安装包）：含 uv 的包直接列外层 → 未命中；先
> `7z e "<setup>.exe" -o<dir> '$PLUGINSDIR/app-64.7z'` 再 `7z l` 该 7z → 命中。
> `release-desktop.yml` 已按后者实现。macOS（挂载 dmg 查 `.app/Contents/Resources`）
> 与 Linux（AppImage `--appimage-extract` 查 `squashfs-root/resources`）不受此坑影响，
> 这也解释了为何同一轮里只有 Windows 单独变红。

> 本地开发**不要**设 `ACF_UV_REQUIRED=1`：不声明版本的存量任务根本不碰 uv，
> 没打进 uv 只是能力降级，不该让本地构建失败——这正是 best-effort 契约的初衷。

> ⚠ **Windows 用户请注意**：`npm run build:executor` 内部走 `bash scripts/bundle-executor.sh`，
> 而 Windows 上 `bash` 常被解析成 `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`
> （WSL 启动器 shim）。该 shim **不会继承 PowerShell 的环境变量**，于是
> `ACF_BUNDLE_UV=1 npm run build:executor` 会**静默走"跳过"分支**（无报错、也没打进 uv）。
> 实测：PowerShell 设 `$env:ACF_BUNDLE_UV='1'` 后 `bash -c 'echo $ACF_BUNDLE_UV'` 输出为空，
> 而 Git Bash 则正常。
>
> Windows 上请改用下列任一方式（二者均已实测可用）：
>
> ```powershell
> # 方式一：直接用 Git Bash 执行脚本（变量在 bash 内生效）
> & "C:\Program Files\Git\bin\bash.exe" -c "ACF_BUNDLE_UV=1 bash scripts/bundle-executor.sh"
>
> # 方式二：先设 PowerShell 环境变量，再用 Git Bash 跑（Git Bash 会继承）
> $env:ACF_BUNDLE_UV='1'; & "C:\Program Files\Git\bin\bash.exe" scripts/bundle-executor.sh
> ```
>
> 打包发布的流水线在 Linux/macOS 上，不受此影响；这条只影响**本机 Windows 打包**。

自带失败**只会告警、不会让构建失败**——因为不声明版本的存量任务根本不需要 uv。
（实测：`ACF_UV_SOURCE` 指向不存在的文件时，脚本打印
`WARN: could not download uv … — skipping (build continues)` 并**退出码 0**。）

#### 解释器缓存目录

下载好的解释器默认放在**用户数据目录**下（`<userData>/interpreters`），
而不是安装目录：Windows 的安装目录通常是 `Program Files`，标准用户无写权限，
uv 会直接下载失败；而且卸载/升级不该连带删掉已下载的解释器（每版本几十 MB）。
可在设置里用 `uvPythonInstallDir` 改到别处（例如大容量磁盘）。

相关可选设置（**设置 → Python 运行环境**，均有 UI 入口，无需手工改配置文件）：

| 设置 | 默认 | 说明 |
|---|---|---|
| `uvPath` | 空 | 指定 uv 可执行文件；空 = 自带 → `UV_BIN` → `PATH` |
| `uvPythonInstallDir` | 空 | 解释器缓存目录；空 = `<userData>/interpreters` |
| `uvPythonInstallMirror` | 空 | 内网镜像源；空 = uv 默认源 |
| `interpreterDownloadTimeoutMs` | 0 | 单个解释器下载超时；0 = 执行器默认 |
| `pypiRegistryUrl` | 空 | 私有 PyPI 源（依赖安装用）；空 = 默认源 |

该页顶部会显示**实际生效**的 uv 路径、解释器池目录与池内已就绪版本 —— 排查
「配置了却没生效」（uvPath 指错、自带 uv 缺失、池目录被配到工作目录）时先看这里。

诊断块刻意区分三种真值，**不把"未静态确认"说成"未找到 uv"**：

| 诊断显示 | 含义 | 该做什么 |
|---|---|---|
| 具体路径 + 「来自 uvPath 配置」/「安装包自带」/「来自系统环境」 | 已静态确认可用 | 无需动作 |
| 「uvPath 已配置但文件不存在」 | 配了却**指错路径** | 改对路径，或留空回落到自带/PATH |
| 「未找到 uv」 | 静态可确认的三处都没有 | 声明 `runtimeVersion` 的任务跑不了 |
| 「系统 PATH 上的 uv（未静态确认）」 | 未显式配置、也没自带，但 PATH 上可能 | 一般无需动作——执行器运行时还会实跑探测 |

> 为什么必须区分后两种：executor-node 的 `resolveUvBin` 在静态解析之后还有
> **系统 `UV_BIN` 与 PATH 实跑探测**两级兜底。旧实现把"没显式配置 + 没自带
> uv"直接渲染成「未找到 uv —— 声明了 Python 版本的任务将无法执行」，于是 uv
> 装在 PATH 上、任务完全能跑的机器也会收到假的致命告警。反向也一样：`uvPath`
> 指到不存在的文件时旧实现仍显示"来自 uvPath 配置"，把配错粉饰成已生效。

> **自带 uv ≠ 自带 Python。** 安装包只带 uv（包管理器），不含 Python 本体。
> 首跑某个版本时由 uv 获取：**能上外网**自动下载；**纯内网**必须配上面镜像源，
> 或按 `docs/design/python-task-upload-and-multiversion/OFFLINE-PROVISIONING.md`
> 离线预填解释器池。**3.7 无法在线获取**，必须离线预填。

#### 3.7 需要离线预填

uv **无法在线下载 Python 3.7**（可下载区间是 3.8~3.14）。要跑 3.7 的任务，
必须由运维把 python-build-standalone 的 3.7.9 产物预填进解释器缓存目录。
目录名有严格约定：`cpython-3.7.9-<uv平台三元组>`，**三元组之后不要再补 `-none`**
（Windows 是 `windows-x86_64-none`，Linux 是 `linux-x86_64-gnu` / `-musl`）。
完整步骤见 `docs/design/python-task-upload-and-multiversion/OFFLINE-PROVISIONING.md`。

> 未预填时，声明 3.7 的任务会**明确失败**并归类为 `interpreter_unavailable`
> （执行器**不会**悄悄回退到宿主解释器运行——那会让"声明了版本"变成一句空话）。

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

### UI 巡检（真实窗口几何）

三个脚本都跑真实 Electron 窗口（不是视口模拟），产物只落本地、不入库：

| 命令 | 关注点 | 产物 |
| --- | --- | --- |
| `npm run audit:ui` | 规则体检：触控目标、文本裁切、对比度、重复 id | `e2e/.ui-audit/` |
| `npm run audit:metrics` | 设计指标：内容覆盖率、字阶、边界层级、对齐网格 | `e2e/.metrics/` |
| `npm run audit:deep` | 内容填充 / 窗口伸缩下的几何破坏 | `e2e/.deep-scan/` |

`audit:deep` 是「挤压 / 溢出 / 原生残留」的专项扫描：

- 遍历全部页面状态：向导 5 步（含空值与超长输入）、状态页与全屏日志、历史页
  （列表/详情/日志浮层/筛选/无结果/菜单）、应用页（表格/紧凑列表/抽屉/确认条/
  应用日志/空态）、配置页 5 分区（含失焦校验态）、更新横幅四态（可用/下载中/
  待重启/失败 + 超长更新日志展开，事件由主进程真实下发）。
- 每个状态在 760×560 / 1440×900 等多档窗口下量，向导额外量 560×480。
- 逐元素检测：`clipped-text` `content-cut` `spill` `child-spill` `squeeze`
  `overlap` `occluded` `row-misalign` `ellipsis-no-title` `long-token`
  `tiny-target` `native-control` `native-scrollbar` `nested-scroll`
  `drag-region-hit` `gap-variance` `row-height-variance` `contrast`。
- 内容样本三档：`rich`（常规混合）、`stress`（60 字中文名/超长英文 token/
  emoji/12 位数字/长错误）、`sparse`（零应用零历史）。
- 断点扫描 `--sweep`：760→2048 共 26 档逐档真实 `setContentSize`，覆盖
  820/900/1100/1400/1600 两侧。
- 活体 resize：宽窗打开抽屉/日志浮层/详情后直接缩到最小窗，抓「浮层写死宽度」。
- 英文界面 `--lang=en`：更长的按钮/标题文案是内容填充回归的高发面。
- 缩放 `--zoom=1.25`：模拟系统缩放，CSS 像素视口变小。
- `--selftest`：向页面注入 8 种已知坏布局并断言全部命中；扫描结果为 0 时，
  先看 selftest 是否 PASS（退出码 2 表示探针失明，而不是页面干净）。
- `--shots=all`：每个状态都出图（否则只在有 err/warn 时截图），便于人工看版式。

```bash
npm run audit:deep -- --fixture=all --sizes=760x560,1440x900 --states=all --shots=1
npm run audit:deep -- --fixture=rich --lang=en --states=all --zoom=1.25
npm run audit:deep -- --fixture=rich --sweep --states=core
# 门禁用法：出现 err（或 warn）即退出码 3；探针自检失败退出码 2
npm run audit:deep -- --states=core --sizes=760x560,1440x900 --fail-on=err
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

### 设置页数值输入框的行为（所见即所存）

「最大并发任务数」「监听端口」「解释器下载超时」三个数值框统一走
`src/renderer/number-input.ts` 的 `parseBoundedInt`，规则是：

- **清空输入框 = 回落该字段的默认值**（并发数 10、端口 8002、超时 0），
  **不是** 0、也**不是**下界；
- **越界值钳到区间内**（并发数 1–100、端口 1–65535）；
- 保存前主进程还会再消毒一次（`config-sanitize.ts`），因此即使渲染层送来脏值，
  也不会出现「整次保存失败 + 部分字段已写入」。

> 历史故障：清空「最大并发任务数」曾得到 `NaN`，界面仍显示 10（显示层 `|| 10`
> 兜住了），但保存的是 `NaN` —— 经 IPC 序列化成 `null` 后撞 electron-store 的
> schema 校验，**整次保存抛错**，而同批次的其它修改（如执行器名称）在此之前
> 已写入内存 store。用户看到的是"改了名、也报了错"，无从判断存了什么。
> 数值字段的解析与消毒现在都有 selftest 钉住（`test:main` / `test:renderer`）。

### 开机自启

「设置 → 基本设置 → 开机自动启动桌面端」与托盘菜单的「开机自启」是**同一个**
开关：两者都即时写入系统自启动项（不经"保存配置"按钮）。配置向导里的同名选项
同样会即时生效——旧版只把它落盘到配置里、从未写系统项，用户看到"已勾选"但
重启后不会自启。
