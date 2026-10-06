# 13 · 执行器 GUI 能力的 macOS 适配侦察（P7c 残差收口）

> 状态：**侦察稿（2026-10-06）**，未立项实施。结论先行：**可行性成立但缓议**——
> 与 12 号 Wayland 的「本质冲突」不同，macOS 上七条不变量**全部有承载形态**；
> 但成本显著高于 Linux（签名助手二进制 + TCC 双权限 + ScreenCaptureKit 迁移），
> 且本库 macOS 侧**只有打包 CI、没有真机开发/测试矩阵**——本文的 macOS 事实全部
> 来自 Apple 文档与生态事实（诚实声明：**零实测数据**），立项前必须过 §5 的
> POC 判定门（真机 spike）。
> 依据：[12-executor-gui-linux.md](./12-executor-gui-linux.md) §5.3 待拍板项 3
> （「macOS 建议独立侦察，不并入本切片」——本文就此收口）、
> [07-executor-agent.md](./07-executor-agent.md) §6 capabilities 能力声明
> （`gui` 域）、[09-permission-profiles.md](./09-permission-profiles.md) §2.3
> hostAccess 档位、roadmap §9.9 残差行。

## 1. 现有资产与硬不变量（macOS 后端必须逐条继承）

P7c Windows 切片沉淀的七条执行侧不变量（12 §1 表，此处不重复）是安全模型本身
（09 §2.3：app-scoped 的边界语义由「逐动作白名单复核」承载）。集成点现状
（N-06 host 拆子进程后行号漂移，2026-10-06 复核）：

- `agent-host.ts:277`（probe）与 `:458`（动作执行）两处三元选择器：
  `process.platform === 'win32' ? WindowsGuiDriver : X11GuiDriver`。
- macOS **当前落入 X11GuiDriver**：其 probe 因 `DISPLAY` 缺失 / `xdotool` 不存在
  如实返回 false → 能力上报不含 `gui`。所以 macOS 落地 = 三元选择器扩成
  darwin 分支 + 新驱动文件，闸门层与能力上报流程不动——与 Linux 同款**纯增量**，
  不做也不会有半吊子状态。

## 2. macOS 平台现实（纸面 + 生态事实，零实测）

### 2.1 注入：TCC Accessibility 是合法的全局通道，逐动作复核可本进程承载

与 Wayland 的根本差异：macOS **存在**合法的全局输入注入通道——`CGEventPost`
（`kCGHIDEventTap` / `kCGSessionEventTap`），受 TCC **Accessibility**
（`kTCCServiceAccessibility`）门禁。语义与 Wayland 三条全断不同：

| 途径 | 评估 |
|---|---|
| `CGEventPost`（键鼠注入） | **可用**——一次性、按 app（按代码签名 DR）授权；授权后本进程可注入全局键鼠 |
| `NSWorkspace.frontmostApplication` | **免权限**——前台进程核对（不变量 #3）的本进程承载，无需额外授权 |
| `CGWindowListCopyWindowInfo` | **免权限**（`kCGWindowOwnerPID`/`kCGWindowBounds`/`kCGWindowNumber` 免；`kCGWindowName` 自 10.15 起需屏幕录制权限）——窗口枚举 + 目标窗口矩形（不变量 #4 的输入）可免权限取到 |
| 命中测试 | **无 `WindowFromPoint` 公开等价物**；AX hit-test 需 Accessibility（授权后可用，但公开 API 形态弱于 Windows `WindowFromPoint`）——缓解 = bounds 点包 + 前台复核，与 X11 同款弱化（12 §3.3.1），已知差异如实登记 |

**张力评估（本文核心问题的答案）**：12 号稿提出「权限模型 vs 逐动作复核的张力」。
macOS 的实情是：TCC 授权是**进程级一次性**的，不逐动作；但**逐动作复核不需要系统
参与**——前台进程名（`NSWorkspace`）与窗口 bounds（`CGWindowList`）都免权限，
驱动进程内即可完整复刻 Windows 后端「每动作先核对前台窗口进程名 == 白名单 app +
点击坐标落在目标窗口矩形内」的语义。所以张力不在「能不能做复核」，而在
**「一次授权 = 授权后进程持有全局注入权，复核只是本进程自律」**——这与 Windows
形态完全同构（Windows 后端同样是本进程自律），不构成 Wayland 那样的否决级冲突。
差异点如实登记：macOS 授权弹窗 UX 更重（两条 TCC 权限各弹一次），且授权主体按
签名绑定（见 §2.3）。

### 2.2 截图：10.15+ 强制 Screen Recording，窗口级 API 正在换代

| 项 | 事实 |
|---|---|
| 权限 | `kTCCServiceScreenCapture`（10.15+ 强制）；免权限窗口截图**不存在** |
| 预检 API | `CGPreflightScreenCaptureAccess()` / `CGRequestScreenCaptureAccess()`——probe 序列的判定点 |
| 旧 API | `CGWindowListCreateImage`（窗口级，正合不变量 #5）**macOS 14.0 起 deprecated** |
| 新 API | **ScreenCaptureKit**：`SCShareableContent` 枚举 → `SCContentFilter(desktopIndependentWindow:)` 按**窗口 id 过滤** → `SCStream` 单帧拉取——语义上比旧 API 更贴合「只截目标窗口」 |
| 迁移成本 | ScreenCaptureKit 是 async/回调形态 + 目标 OS 版本门槛（13+），旧 API 在可预见版本仍可用但已废弃——立项时按目标 OS 矩阵定（倾向直接 ScreenCaptureKit，旧 API 仅作 10.13 兜底评估） |

### 2.3 TCC 授权语义：按签名绑定——既是成本也是企业部署正道

- 授权主体是 app 的 **Designated Requirement（代码签名）**：未签名/重签名即授权
  重置——开发期反复弹窗（工程摩擦），发布期反而稳定（签名不变授权不丢）。
- 企业批量授权走 **MDM 隐私偏好 profile**（`TCC` policy 载荷预授权 Accessibility
  + Screen Capture）——这是 macOS 企业部署的标准形态，比 Linux 侧「xdotool root
  属主校验 + 文档化 apt install」更接近 09 的「白名单式授权」哲学。
- **准入的代码签名前提**：本库 desktop 打包已有 macOS 形态（DSK-01），但
  **签名 + 公证（notarytool）流水线尚未接线**——GUI 后端把签名从「可选增强」
  变成**硬前置**（未签名 helper 无法稳定持有 TCC 授权），这是 Linux 切片
  没有的新增工程面。
- 会话前提：无 GUI 会话（SSH/headless）下 `CGEventPost` 投递无效——probe 需
  检查 aqua 会话在场（`launchctl managername` 或 `CGSessionCopyCurrentDictionary`）。

### 2.4 敏感面：Secure Input 与密码字段

前台 app 开启 `SecureEventInput`（登录窗、密码框）时，事件 tap 的**观察**被系统
抑制；**注入 post 仍可达**（纸面结论，需真机钉住）。风险姿态：app-scoped 白名单
语义下，Agent 本就只被授权操作白名单 app 的前台窗口；密码字段的键入属任务语义
层（SOP 的 constraints/acceptance 应约束），驱动层不做额外黑名单——与 Windows
后端同姿态，如实登记差异：macOS 对「正在键入密码框」无系统级事后审计可用。

## 3. 驱动设计（gui-macos.ts）

### 3.1 与 Windows/Linux 方案的结构差异：固定编译助手二进制

三条已落地平台的「固定程序，零插值」（不变量 #1/#2）形态谱系：

| 平台 | 固定程序形态 | 不可替换性 |
|---|---|---|
| Windows | 单一固定 PowerShell（EncodedCommand），模型值只经 JSON stdin | System32 绝对路径解析 |
| Linux | argv 封闭的 xdotool 子命令，模型值只进 argv | `which` 缓存 + root 属主校验（12 §3.1 已诚实注记弱于 Windows） |
| macOS（本稿） | **随 app 打包的 Swift 助手二进制**，JSON stdin → JSON stdout | **bundle 内固定路径 + codesign DR 校验**——签名链使替换二进制即失效，强于 Linux，弱于 Windows 的系统目录（macOS 无 System32 等价物） |

已评估并否决的替代形态（与 12 §2.2 同款纪律）：

| 途径 | 否决点 |
|---|---|
| `osascript` / JXA | 通用脚本解释器——插值面与不变量 #1 正面冲突，同 Windows 不用 wscript 的理由 |
| Electron 主进程 native 模块（node-pty 类 N-API） | 可行备选（TCC 授权主体本就是主 app），但：native 模块崩溃拖死主进程、ABI 与 Electron 版本强耦合、权限面与审计混入主进程——**倾向独立 helper 进程**，与 N-06 刚收口的「Agent host 拆独立子进程」形态同构（stdio JSON 行协议、崩溃自愈、主进程托盘快照全套已就绪） |
| 私有 framework dlopen | 破坏公证与 App Store 沙箱语义，否决 |

助手二进制随主 app bundle 打包、同 Team 签名、硬编码运行时路径
（`process.execPath` 同目录约定）、启动时自校验签名（`SecCodeCheckSelfValidity`
形态）——公证人要求 helper 也在公证包内，恰好与固定路径语义互锁。

### 3.2 动作映射表

| 动作 | macOS 实现 | 复核形态（对应不变量 #3/#4/#5） |
|---|---|---|
| focus | `CGWindowList` 按 owner pid + bounds 找目标窗口（进程名精确匹配，`NSRunningApplication(pid).localizedName`/executableName，与 Windows 同语义）→ `NSRunningApplication.activate` + `AXRaise`（Accessibility 授权后） | 激活后 `NSWorkspace.frontmostApplication` 复核 pid |
| click | 前台复核 → `kCGWindowBounds` 取目标窗口矩形（全局逻辑坐标）→ 边界校验 → `CGEventPost` mouse down/up（全局逻辑坐标，与 bounds 同坐标系自洽） | 事前 bounds 点包 + 事后 frontmost 复核（X11 同款「点击即聚焦」弱化；无逐点命中 API，已知差异如实登记） |
| type | 逐字符 `CGEventCreateKeyboardEvent`（unicode 载荷键入，1024 字符上限继承闸门层） | 每字符前 frontmost 复核（与 Windows 逐字符同语义） |
| press | 封闭键表（对齐 `WINDOWS_GUI_KEYS` 25 键）→ `kVK_*` 虚拟键码映射 → `CGEventPost` | 动作前 frontmost 复核 |
| screenshot | ScreenCaptureKit：`SCContentFilter` 按**窗口 id** 过滤 → 单帧 → PNG 写临时文件 `fs.renameSync` 到闸门层随机路径（原子无覆写） | 仅目标窗口 id；10MB 上限由闸门层 stat 复核（已有） |

多步编排（复核→动作→再复核）在 **node 侧驱动器内**串接多次 helper 调用——每次
调用 15s 超时、输出 16KB 上限（继承 #6）；helper 本身不持久驻留，逐动作冷启
（与 xdotool 同款，简单优先；若真机实测冷启延迟超阈值，再评估驻留形态——驻留
会引入「助手状态面」，默认不做）。

### 3.3 已知差异与限制（如实登记）

1. **命中校验弱化**：无 `WindowFromPoint` 等价物；bounds 点包 + frontmost 复核
   替代。窗口重叠遮挡区域无法逐点验证——与 X11 已知差异同款（12 §3.3.1），
   ScreenCaptureKit 对遮挡窗口按窗口内容（非屏幕合成结果）截图，截图面反而**强于**
   X11 的 GetImage 遮挡垃圾——立项首日实测钉住。
2. **授权是进程级一次性**，不逐动作——逐动作复核是本进程自律（§2.1 张力结论），
   与 Windows 同构但必须写进企业部署文档，不得表述成「系统逐动作授权」。
3. **签名摩擦**：开发期重签名即重置 TCC 授权（反复弹窗）——开发机建议用
   `Ad-hoc` + 手动授权一次性评估，正式验收走真签名包。
4. **Secure Input**（§2.4）：注入可达但观察被抑制；密码框行为需真机钉。
5. **HiDPI**：`kCGWindowBounds` 与 `CGEventPost` 同为全局逻辑坐标（点），Retina
   自洽；跨缩放混排多屏未验证（X11 同款诚实登记）。
6. **OS 版本矩阵**：ScreenCaptureKit 需 13+；10.15–12.x 若要支持需走已废弃的
   `CGWindowListCreateImage` 兜底——立项时按目标矩阵拍板（倾向 13+ 起点）。

### 3.4 依赖与部署形态

| 依赖 | 必需性 | 提供 |
|---|---|---|
| 代码签名 + 公证流水线 | **硬前置**（TCC 授权稳定性依赖 DR） | release-desktop.yml 扩签名/公证 job + 证书管理；未签名包如实 probe false |
| TCC Accessibility + Screen Capture | 运行时前提 | 手动授权（系统设置）或 MDM profile 预授权；文档化授权清单 |
| aqua GUI 会话 | 运行时前提 | probe 检查会话类型 |
| 外部二进制 | **无**（对比 xdotool/import） | — |

**probe 序列**：aqua 会话在场 → 助手二进制存在且签名自校验通过 →
`AXIsProcessTrusted()` → `CGPreflightScreenCaptureAccess()` → 前台进程可读
（交互桌面在场）。任一失败 → false → 能力上报不含 gui。与 Playwright / xdotool
同款纪律：**包缺失/权限未授 = 能力不存在**，绝不半可用。

### 3.5 测试与验收

- `gui-macos.selftest.ts` 接 `npm run test:main`：driver 层 fake 助手二进制
  （stdin JSON/argv 断言——无插值、二进制路径命中 bundle 约定 + 签名校验桩）；
  闸门层复用既有 gui.selftest 形态。
- 反证有牙：删逐动作复核 / 放开窗口边界 / probe 恒 true，逐一转红。
- **真机验收前置 = macOS 真机**（带 GUI 会话）：本库 CI 的 mac runner 只有打包
  job（DSK-01），GitHub Actions macos runner 的交互会话能力不支持 TCC 弹窗
  驱动的 GUI 自动化验收——真机矩阵需专用 mac 测试机，这本身是立项成本的一部分。

## 4. 工作量与切片建议

| 切片 | 内容 | 量级 |
|---|---|---|
| **S0（POC 判定门）** | 真机 spike：签名 helper + `AXIsProcessTrusted` + 一次 CGEvent 投递 + ScreenCaptureKit 单帧 + 重签名授权稳定性 | 0.5~1 天（真机） |
| S1 | `gui-macos.ts`（probe + 五动作 + 复核编排）+ Swift 助手二进制 + esbuild/electron-builder 打包接线 + selftest | 1.5~2 天 |
| S2 | 真机三动作验收（白名单 app 正向 + 白名单外如实拒绝）+ Secure Input/遮挡/HiDPI 实测钉结论 | 0.5~1 天 |
| S3 | 签名/公证流水线接线 + MDM 预授权文档 + roadmap/权限档位文档同步 | 1 天 |

**总口径 ~4 天**（高于 Linux 2.5 天），且 S0 与 S3 各引入一块 Linux 切片没有的
新工程面（签名流水线）。风险低于 Wayland 路线（可行性成立），高于 X11
（工程面更宽、验证条件更稀缺）。

## 5. 立项/否决建议

**建议：缓议（2026-10 不立项），条件满足后按 POC 判定门重开。** 理由：

1. **验证条件缺席是硬约束**：本侦察稿零实测（开发机是 Linux），七条不变量的
   macOS 形态全部停留在 Apple 文档语义；没有真机，S0 都无法启动——立项即挂起。
2. **价值链上游未通**：GUI 能力域的商业价值在「SOP → Agent → gui」闭环里；
   N-05（真模型端到端）因 DashScope 暂缓仍未闭环（2026-10-02 拍板）。上游
   不通，macOS 下游先行没有验收对象。
3. **目标类别覆盖度**：GUI 域瞄准闭源 C/S 客户端；浏览器目标 Playwright 已
   覆盖且免权限。macOS C/S 自动化的需求信号目前为零——比 Linux 切片
   （影刀 RPA 真机在案）的立项依据更弱。
4. **签名流水线是外溢收益项**：S3 的签名/公证接线对 desktop 发布本身有价值
   （DSK-01 后的发布成熟度），若签名流水线因其他理由先行（release 成熟度轮），
   本项的立项成本自动下降——可作为重开的触发器之一。

**POC 判定门（S0）清单**——以下三项条件任一满足即重开评估，S0 四项全绿才立项 S1：

| # | 重开触发条件 | S0 钉住的实测项 |
|---|---|---|
| a | macOS 真机就绪（带 GUI 会话的日常机/专用测试机） | ① 签名 helper 的 TCC 授权稳定性（重打包不重弹） |
| b | 出现真实 macOS C/S 自动化需求信号 | ② ScreenCaptureKit 窗口单帧在目标 OS 版本可用且遮挡窗口按窗口内容出图 |
| c | 签名/公证流水线因发布成熟度先行落地 | ③ CGEvent 注入与 Secure Input 共存行为（可达性如实记录） |
|   |  | ④ aqua 会话判定 + 助手签名自校验在真机形态成立 |

四项全绿 → 立项 S1–S3；任一红 → 以实测证据重新评估（登记到本文 §2 对应行，
本文状态从「纸面侦察」升级为「实测侦察」再谈立项）。

## 6. 引用与依据

- [12-executor-gui-linux.md](./12-executor-gui-linux.md)：七条不变量表（§1）、
  已知差异登记形态（§3.3）、切片与验收形态（§4/§3.5）、§5.3 待拍板项 3（本文由来）
- [07-executor-agent.md](./07-executor-agent.md) §6：`capabilities: [browser, gui,
  filesystem, http]` 能力声明（gui 域的定义处）
- [09-permission-profiles.md](./09-permission-profiles.md) §2.3：hostAccess 档位
  （none/app-scoped/session）与 app-scoped 推荐档
- [06-roadmap.md](./06-roadmap.md) §9.9：P7c 残差行（macOS 尚未适配 → 本文收口）
- Apple 平台事实（TCC/CGEvent/ScreenCaptureKit）均为公开文档语义，**零实测**——
  §5 的 POC 判定门就是为此存在
