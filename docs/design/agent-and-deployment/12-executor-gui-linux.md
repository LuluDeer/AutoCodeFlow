# 12 · 执行器 GUI 能力的 Linux 适配侦察（P7c 残差）

> 状态：**侦察稿（2026-09-26）**，未立项实施。结论先行：**做 X11/XWayland 后端（gui-x11.ts），Wayland 原生窗口如实不支持**。
> 依据：[07-executor-agent.md](./07-executor-agent.md) §6 GUI 能力域、[09-permission-profiles.md](./09-permission-profiles.md) §2.3 hostAccess 档位、roadmap §9.9 残差行。
> 本文的全部实测数据来自 Linux 侧开发机（Ubuntu GNOME Wayland 会话，`XDG_SESSION_TYPE=wayland`）——P7c Windows 切片当年没有的验证条件，现在有了。

## 1. 现有资产与硬不变量（Linux 后端必须逐条继承）

P7c Windows 切片把 GUI 能力做成了「闸门（平台无关）+ 驱动（平台特定）」两层，闸门层
`agent/gui.ts` 与驱动契约 `GuiDriver`（`probe()` + `run()`）**零改动复用**。Windows 驱动
`gui-windows.ts` 沉淀了七条执行侧不变量，这是安全模型的一部分（09 §2.3：app-scoped 的
边界语义由「逐动作白名单复核」承载，不是由 sandbox 承载）：

| # | Windows 后端的不变量 | 实现形态 |
|---|---|---|
| 1 | 固定程序，零插值 | 唯一固定 PowerShell 脚本（EncodedCommand），模型值只经 JSON stdin |
| 2 | 二进制不可替换 | `System32` 绝对路径解析，PATH/workDir 同名可执行文件无法劫持 |
| 3 | 逐动作前台复核 | 每个动作（type 逐字符）先核对前台窗口进程名 == 白名单 app |
| 4 | 点击窗口边界 | 坐标相对目标窗口矩形，越界即拒；`PointHitsWindow` 双重复核 |
| 5 | 截图只截目标窗口 | `PrintWindow`（窗口级），非屏幕抓取；PNG 专属、原子 CreateNew、10MB 上限 |
| 6 | 输出/时长有界 | stdout 16KB 上限、15s 超时、JSON-only 响应 |
| 7 | 能力如实上报 | `probe()` 失败 → `agent-host.ts` 能力租约不含 `gui`，中台不派 GUI 单 |

集成点（已核实）：`agent-host.ts:275` 与 `:454` 两处直接 `new WindowsGuiDriver()`。
Linux 落地 = 平台选择器（`platform === 'win32' ? Windows : linux ? X11 : none`）+ 新驱动文件，
闸门层与能力上报流程不动。`probe()` 的平台短路已保证 Linux 今天如实不报 `gui`——
所以这是**纯增量**，不做也不会有半吊子状态。

## 2. Linux 桌面现实（本机实测 + 生态事实）

### 2.1 Wayland 是主流，XWayland 是现实通道

| 实测项 | 本机（Ubuntu GNOME）结果 |
|---|---|
| 会话类型 | `Type=wayland`（`ubuntu-wayland`），同时存在 `DISPLAY=:0`（XWayland） |
| 窗口枚举 | `xwininfo -root -children` **有效**：能看到 XWayland 客户端的 WM_CLASS 与几何（本机正跑的影刀 RPA `"shadowbot"` 窗口可见——RPA/C/S 客户端正是 GUI 自动化的目标类别） |
| `_NET_CLIENT_LIST` | **空**——GNOME Wayland 的 XWayland root 不按原生 X11 WM 方式暴露 client list，枚举必须走 `xwininfo -root -children` 或 `xdotool search` |
| 注入工具 | xdotool / ydotool / wtype 均未预装（部署依赖，见 §5） |

生态事实：现代发行版默认 Wayland 会话（Ubuntu 22.04+ / Fedora 35+），但**目标应用多为
XWayland 客户端**——Electron（VSCode、Slack）、Chrome、Qt/GTK 混合、闭源 C/S 客户端。
原生 Wayland 应用主要是 GNOME/GTK 系自带工具。

### 2.2 Wayland 原生路线为什么被否（安全不变量冲突）

| 途径 | 阻断点 |
|---|---|
| 全局注入协议 | **不存在**——Wayland 安全模型禁止一个客户端注入输入到另一个客户端 |
| `ydotool`（uinput） | 需要 root 或 uinput 组权限；事件进内核全局队列，**无窗口感知**——不变量 #3「逐动作核对目标窗口」与 #4「点击窗口边界」无从谈起，等于把宿主全局输入权交给 Agent |
| `wtype`（virtual-keyboard） | 仅部分合成器支持（GNOME 不支持）；同样无窗口感知 |
| 截图 portal | `xdg-desktop-portal` Screenshot 默认弹**交互确认**（每张一次）；无头授权需合成器私有配置 |
| 窗口枚举 | 无标准协议；GNOME 需要 Shell 扩展，KDE 走 kdotool——按合成器碎片化 |

结论：Wayland 原生注入**本质上无法满足「逐动作白名单复核」**——硬上等于把 09 §2.3 的
app-scoped 边界降级成「全局输入权 + 事后审计」。这与 approve_deployment 硬禁用同一条
设计纪律：宁可如实不支持，不做假闸门。Wayland 原生窗口在本方案中**明确出范围**，
probe 如实返回 false，能力上报不含 gui（与 P7a「能力域不得超前声明」同款纪律）。

## 3. X11/XWayland 后端设计（gui-x11.ts）

### 3.1 与 Windows 方案的结构差异（变简单的点）

Windows 需要单一固定 PowerShell 脚本是因为原生 API 要 Add-Type 内联 C#。**Linux 不需要
单一大脚本**：每个动作都是一次 argv 封闭的 `xdotool` 子命令调用，模型值只作为 argv
（`spawn(binary, args, {shell: false})`，无 shell → 天然无注入面）。不变量 #1/#2 的
Linux 形态：

- #1：固定二进制集合 `{xdotool, import}`，**安装时由部署方提供**，运行时用 `which` 解析
  一次并缓存绝对路径；参数只进 argv。
- #2：`xdotool` 无 System32 等价物；缓解 = 缓存解析结果（防 PATH 后半段被 workDir 污染）
  + probe 时校验二进制属主为 root/usr（`fs.statSync(uid===0)`，非 root 属主即拒绝）。
  诚实注记：这条弱于 Windows 的绝对路径解析，已把 workDir 从 PATH 摘除的前提下风险可控。

### 3.2 动作映射表

| 动作 | X11 实现 | 复核形态（对应不变量 #3/#4/#5） |
|---|---|---|
| focus | `xdotool search --onlyvisible --class <app>` → 逐窗口 `getwindowpid` + `/proc/<pid>/comm` 比对（进程名精确匹配，与 Windows 同语义）→ 命中唯一才 `windowactivate --sync` | 激活后 `getactivewindow getwindowpid` 复核 |
| click | 前台复核 → `getwindowgeometry` 取目标窗口绝对矩形 → 边界校验 → `mousemove --sync x y click 1` | 复核 `getactivewindow` == target（X11 点击即聚焦，事前复核 + 事后活动窗比对；**弱于** Windows `PointHitsWindow` 的逐点命中，已知差异如实记录） |
| type | 逐字符 `xdotool type --delay 12 --window <id> <char>` | 每字符前复核前台窗口（与 Windows 逐字符同语义；1024 字符上限继承闸门层） |
| press | 封闭键表（对齐 `WINDOWS_GUI_KEYS` 25 键）→ keysym 映射 `xdotool key <keysym>` | 动作前前台复核 |
| screenshot | `import -window <id> <tmp>.png`（XGetImage 窗口级）→ 写临时文件后 `fs.renameSync` 到闸门层给定的随机路径（原子无覆写） | 仅目标窗口 id；10MB 上限由闸门层 stat 复核（已有） |

多步编排（复核→动作→再复核）在 **node 侧驱动器内**串接多次 spawn——每次调用 15s 超时、
输出 16KB 上限（继承 #6）。

### 3.3 已知差异与限制（如实登记）

1. **命中校验弱化**：X11 公开 API 无 `WindowFromPoint` 等价物；用「点击后活动窗比对 +
   窗口矩形边界」替代。窗口重叠遮挡区域无法逐点验证（X11 GetImage 对遮挡区返回垃圾，
   XWayland composite 下窗口 pixmap 通常有效——立项首日实测钉住）。
2. **`--clearmodifiers` 不用**：会改变宿主键盘状态语义（Shift 粘滞等），默认不携带。
3. **输入法拦截**：fcitx/ibus 挂在合成器侧时，XTEST 注入可能被输入法重写——企业部署
   需在目标机关闭 IME 或改用剪贴板粘贴路线（出范围，登记不做）。
4. **HiDPI**：XWayland 坐标为逻辑像素，`getwindowgeometry` 与点击坐标同一坐标系，自洽；
   跨 DPI 混排多屏未验证。
5. **GNOME Wayland 原生窗口不可达**（§2.2 出范围项）：枚举树里看不到、注入不达。
   探测手段：`xdotool search` 找不到目标类即如实报 `app_main_window_not_found`。

### 3.4 依赖与部署形态

| 依赖 | 必需性 | 提供 |
|---|---|---|
| `xdotool` | 硬依赖（focus/click/type/press/枚举） | deb/rpm 依赖声明（electron-builder `deb.afterInstall` 或文档化 `apt install`） |
| `imagemagick`（import） | 截图硬依赖 | 同上；也可评估 scrot 单工具替代（包更小） |
| XWayland 会话 | 运行时前提 | probe 检查 `DISPLAY` 存在 + `xdotool getdisplaygeometry` 成功 |

**probe 序列**：`DISPLAY` 非空 → 二进制存在且 root 属主 → `xdotool getdisplaygeometry`
成功 → `getactivewindow` 可读（交互桌面在场）。任一失败 → false → 能力上报不含 gui。
与 Playwright 探测同模式：**包缺失 = 能力不存在**，绝不半可用。

### 3.5 测试与验收

- `gui-x11.selftest.ts` 接 `npm run test:main`：driver 层 fake `spawn`（argc/argv 断言
  ——无 shell、无插值、二进制路径命中缓存）；闸门层复用既有 gui.selftest 形态。
- 反证有牙：删逐动作复核 / 放开窗口边界 / probe 恒 true，逐一转红。
- 真机验收（本机即可）：影刀 RPA（XWayland 客户端）走 focus → screenshot → click 三动作；
  GNOME 原生应用（如 gnome-text-editor）如实拒绝。Windows 真机矩阵补(gui) 已有形态沿用。

## 4. 工作量与切片建议

| 切片 | 内容 | 量级 |
|---|---|---|
| S1 | `gui-x11.ts`（probe + 五动作 + 复核编排）+ selftest + agent-host 平台选择器 | 1~1.5 天 |
| S2 | 真机三动作验收（影刀/拒绝用例）+ HiDPI/遮挡实测钉结论 | 0.5 天 |
| S3 | 打包依赖声明（deb/rpm afterInstall + 文档）+ roadmap/权限档位文档同步 | 0.5 天 |

**总口径 ~2.5 天**，风险低于 Windows 切片（无 PowerShell/C# 边界，argv 封闭更简单）。

## 5. 待拍板项

1. 截图工具选型：`import`（ImageMagick 全家桶，功能冗余）vs `scrot`（轻量，-u 聚焦窗口
   但窗口 id 语义弱）——倾向 import 的 `-window <id>` 精确语义。
2. 依赖交付：包管理器依赖声明 vs 仅文档化 + probe 如实降级（与 Playwright 同款）——
   倾向后者起步（零打包面改动），企业部署文档给出安装清单。
3. macOS 适配是否同批：事件注入走 CGEvent（无窗口命中 API）+ Screen Capture 需屏幕录制
   权限弹窗——与 Linux 同样存在「权限模型 vs 逐动作复核」张力，建议独立侦察，不并入本切片。
