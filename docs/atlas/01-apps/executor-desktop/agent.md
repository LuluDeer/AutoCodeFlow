# executor-desktop Agent 子系统（P7a 骨架 + P7a 续批执行体 + P7b 浏览器/托管）

> 所属: docs/atlas/01-apps/executor-desktop · 最后核对: 2026-09（P7b） · 对应代码: `apps/executor-desktop/src/main/agent/`
> 设计文档: [docs/design/agent-and-deployment/](../../../../design/agent-and-deployment/README.md)（07 执行器 Agent / 08 分工 / 09 权限档位 / 11 协作 API）
> ADR: [ADR-022](../../../../adr/adr-022-executor-agent-arbitrary-code.md)（受控的任意代码执行 · 信任模型变更）

## 定位

内置在**客户端执行器**上的通用自主智能体：读中台下发的 SOP（目标 + 验收），自主探测本机环境、自主决定实现方式、自己写自己跑自己改，回报中台。

**分工红线（08 定案）**：Agent **只**加在 executor-desktop；`executor-node` / `executor-python` 保持纯净、零行为变化。

## 目录结构

```
src/main/agent/
├── perception.ts            环境探测 → EnvironmentReport（OS/资源/运行时/能力域）
├── workspace.ts             ★ 沙箱工作区 <workDir>/agent-workspace/<assignmentId>/
├── permission-profile.ts    ★ 权限档位（四轴五预设 + min(本地, 中台) 合并）
├── gates.ts                 ★ 硬闸门（迭代/墙钟/澄清/试跑/依赖安装）
├── loop.ts                  迭代循环外壳（感知→规划→试跑→诊断；执行体依赖注入）
├── kill-tree.ts             ★ 跨平台进程树终止（P7b：试跑超时杀整树）
├── trial-run.ts             ★ 真实试跑执行体（process 沙箱）
├── browser.ts               ★ 浏览器能力（P7b：封闭动作 + 域名白名单 + 截图/录屏）
├── collab-client.ts         协作 HTTP 客户端（poll/澄清/进度/完成/LLM relay/媒体上传）
├── runtime.ts               装配：LLM 协议 + 试跑 + 浏览器 + SOP 验收 → LoopHandlers
├── agent-host.ts            ★ 指派托管（poll→策略合并→循环→回报/澄清，P7b）
└── *.selftest.ts            十套自检（接进 npm run test:main）
```

前五个模块是**纯函数/纯状态机**——不 import electron、不发网络请求、不调模型。续批与 P7b 的模块有真实副作用（spawn、HTTP、Chromium），但同样**不 import electron**，且失败路径全部收敛为返回值、绝不抛。

## 各模块守的是什么

| 模块 | 守的东西 | 失守的后果 |
|---|---|---|
| `permission-profile` | 档位是 ADR-022 信任模型的载体：默认最保守 + 企业管控 | 拼错的档位名静默落盘 → Agent 行为落到未定义状态；或本地配置突破公司策略 |
| `workspace` | 任何文件操作**出不去** `agent-workspace/<assignmentId>/` | Agent 误删用户文件 / 误改系统配置 |
| `gates` | 迭代/墙钟/试跑/澄清的次数与时长上限 | 无限循环烧资源；两个 Agent 的礼貌循环烧令牌 |
| `loop` | 控制流：档位闸在试跑之前、触顶是合法终态、澄清触顶转人工 | off 档形同虚设；「做不了」被上报成「崩了」 |
| `perception` | 探测**绝不抛** + 只读 + 能力域不超前声明 | 「没装 python」这一最需要报告的场景直接崩；中台把需要浏览器的 SOP 派过来然后卡住 |
| `kill-tree`（P7b） | 超时杀**整棵**进程树（POSIX 进程组 / Windows taskkill /T /F） | 候选代码 spawn 的孙进程在超时后存活，闸门对树形泄漏形同虚设 |
| `trial-run` | 档位闸（off/host 如实拒）+ 解释器封闭枚举 + env 白名单（凭据零透出）+ cwd 锁定 + 超时/输出上限 | 生成代码逃逸沙箱；执行器 token 泄漏进子进程；失控脚本拖垮执行器 |
| `browser`（P7b） | 7 个封闭动作 + **每次导航过域名白名单（空 = 全禁）** + 全新临时 profile | LLM 导航到任意站点；触达用户登录态（违反 hostAccess=none 语义） |
| `collab-client` | 请求形状契约（11 §3）+ 超时强制收敛 + 全错误收敛为 `{ok:false}` | 一次网络悬挂占死整个会话；网络抖动打断状态机 |
| `runtime` | LLM 严格 JSON 协议 + 诊断动作**显式映射** + 验收锚点纪律 | LLM 输出被猜测语义继续跑；「请求澄清」静默变 retry；无验收也判交付 |
| `agent-host`（P7b） | 指派全生命周期 + 单飞行 + 策略合并（中台只能往下压）+ `agentEnabled` 总开关 | 并发双指派互相污染；本地配置突破中台上限；未开启的机器凭空获得 Agent |

## 权限档位（09 / ADR-022 决策 3–4）

四个轴：`codeExecution`（off/sandbox/host）· `sandboxBackend`（none/process/container/vm）· `hostAccess`（none/app-scoped/session）· `taskExecution`（deploy-only/isolated-runner）。预设五档，**P7a 只实现 `minimal` + `standard`**——`developer`/`ops-assist`/`full-trust` 是登记在案的保留名，解析时**显式钳回**而非静默按其定义执行。

两条硬纪律：
1. **默认最保守**：解析失败一律回落 `minimal`（什么都不允许），绝不回落到更高档。
2. **企业管控**：`最终档位 = min(本地配置, 中台上限)`，逐轴取更保守者，中台只能往下压。中台策略随 `agent-collab` poll 的 `sopPolicy` 下发；策略缺失/形状非法时**原样保留本地**（离线沿用本地，绝不回落成无限制，也绝不因一次坏响应掉到 minimal）。

配置存放：`config-store.ts` 的 `agentPermissionProfile` / `agentCodeExecution` / `agentSandboxBackend` / `agentHostAccess` / `agentTaskExecution` / `agentAllowedApps` / `agentAllowedDomains`（全部可选，缺省即最保守）。**枚举值必须进 `config-sanitize.ts` 消毒层**——conf 15 移除 JSON schema 后坏值静默落盘，`sandbox` 拼成 `sandox` 不报错、界面照常显示、解析层却回落最保守档，故障形态是「配置看起来生效了、行为却是另一套」且零日志。消毒策略：非法值归一化为 `''`（= 不覆盖，跟随预设），**不删键**（删键 = 保留旧值，界面无法反映「刚选的没生效」）。

## 沙箱工作区（07 §5）

- 根：`<workDir>/agent-workspace/<assignmentId>/`；`assignmentId` 过封闭字符集校验（它直接拼进路径）。
- 路径解析复用 `path-domain.ts` 的 `checkPathWithinDomains`（realpath 折叠 symlink 祖先 + Windows 大小写不敏感），**再加** realpath 复核——防 symlink 指出域外。
- **列目录不跟随 symlink**：`resolveWithinWorkspace` 只校验**输入**路径，管不到 walk 到达的路径；跟随链接会让一个域外链接把域外文件列进 Agent 观察面（本批自检抓出的真实缺陷）。
- 读写有大小上限（读 256KB / 写 1MB）——防超大文件塞爆 LLM 上下文与磁盘。

## 浏览器能力与媒体回传（P7b）

**`AgentBrowserSession`**：一次指派一个会话，`start()` → 批量 `run()` → `close()`（录屏落盘）。
- **导航域名白名单**（07 §4.1「代码层检查每次导航」）：SOP `constraints.allowedDomains` ∪ 权限档位 `agentAllowedDomains`；**空白名单拒绝启动也拒绝一切导航**。子域语义（`api.erp.corp.com` ⊂ `erp.corp.com`），协议仅 http/https（`file:`/`javascript:` 拒）。
- **动作封闭枚举**：navigate/click/type/press/screenshot/extract_text/wait——没有 `evaluate`/`exec`，就不存在任意 JS。
- **全新临时 profile**：不携带用户 cookie/登录态——browser 能力因此**不**触碰 `hostAccess`（那是「操作已登录软件」的档位，09 §2.3）；两道闸独立，不互相冒充。
- 截图落 `workspace/screenshots/`，录屏落 `workspace/browser-recordings/`（`recordVideo`，close 时落盘）。

**媒体回传**：截图/录屏经 `uploadMedia`（multipart）挂到指派 → 中台 `agent_media` 表登记（迁移 1790000000042）+ 落盘 `uploads/agent-media/<assignmentId>/` → 返回 `mediaPath`（`/api/agent-collab/media/<id>`）——这是澄清 `mediaRefs` 的**唯一合法引用形态**（外网 URL 在 SopService.validateMediaRefs 封死，SSRF 转嫁面）。中台 Admin 经 `GET /api/sop/media/:id`（ADMIN-only）取回，供 Qwen 视频理解与人工复核。

**LLM 协议扩展**：plan/diagnose 响应可带 `"browser":[actions]`（≤40 步）——先看页面再写代码；每步结果（页面文本/截图 mediaPath/录屏 mediaPath）进下一轮上下文。能力闸：SOP `capabilities` 含 `browser` **且**本机 playwright 可用，缺一即回拒绝原因给模型（不静默丢弃）。

## Agent 托管（P7b）：`AgentHost`

指派生命周期的属主：`tick()` = poll（0 等待，节奏由 index.ts 的 30s 定时器驱动）→ 缓存 `sopPolicy` → 领工单 → 能力上报（browser 按探测如实声明）→ 建沙箱 → 环境探测 → **策略合并** → `runAgentLoop` → 回报。

- **单飞行**：处理中再 tick 直接跳过——并发双指派会让沙箱/闸门/报告归属互相污染。
- **策略合并**：`min(本地, 中台)` 每轮生效；中台压档后试跑被档位闸拒，**如实回报 failed + effectiveProfile**（selftest 钉住「本地 standard 被压后没有偷偷试跑」）。
- **总开关**：`agentEnabled`（默认 false——ADR-022 显式开启）；进 config-sanitize 布尔消毒（`'false'` 强转会把它变 true，等于用户没开却被偷偷开了）。`syncAgentHostWithConfig()` 在 app ready 与 config:save 时各调一次，启停轮询不销毁 host。
- **架构取舍（如实）**：07 §4.2 要求独立子进程；当前重活已全在子进程（试跑 spawn 解释器、浏览器是 Chromium 子进程、LLM 是网络等待），host 本体只做 I/O 编排，故先在主进程内运行；host 拆子进程留 P7d 打包接线时一并处理。

## 真实试跑执行体（07 §3.3「唯一新增的执行能力」）

`runTrialInSandbox` 是**所有**「在本机执行生成代码」路径的必经点，四道强制纪律：

1. **档位闸**：`codeExecution=off` 拒绝（高合规档 = Agent 只产出文本）；`host` 如实报「尚未实现」——静默按 sandbox 跑会让部署方以为开的是 host。
2. **解释器封闭枚举**：`python` / `python3` / `node`。node 用 `ELECTRON_RUN_AS_NODE=1` 复用 Electron 可执行文件（纯 node selftest 环境下该变量无效，双环境同一路径）。
3. **env 白名单**（SEC-01 精神）：子进程只拿 PATH/系统路径/编码变量，执行器 token、中台地址、任何凭据类变量**零透出**（selftest 注入伪凭据实测验证）；强制 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`——I18N-01（Windows Python stderr 默认 GBK）在源头掐断。
4. **入口路径域**：entry 经 `resolveWithinWorkspace`（绝对路径/盘符/`~`/穿越全拒）。

超时（1s..300s 钳位）后 `kill()` 终止——**进程树残留是已知残差**（Windows kill 单进程，P7b 换 tree-kill）；输出 64KB/流封顶，截断打标记。

## LLM 接入（续批）：中台 relay

执行器 Agent **不带 API key**：推理经 `POST /agent-collab/llm` 由中台代跑（中台侧复用 `AiService.chatMultimodal`，provider 未启用时 fail-open 透传空 content，执行器按「模型不可用」降级——不掩盖）。理由：key 不出服务端（客户端被入侵不泄露凭据）、令牌记中台 metrics 可归因、企业只需在中台配额。

`runtime.ts` 与模型的协议是**严格 JSON 单对象**：plan 返回 `{files, entry:{interpreter,path}, notes}`；diagnose 返回 `{action: retry|clarify|escalate|deliver, question?, files?}`。解析失败的输出按协议违规如实抛（loop 收敛为 `outcome=error`），**绝不猜测语义继续跑**。诊断动作经**显式映射表**转 `LoopNextAction`——LLM 的 `clarify` 与循环的 `needs_clarification` 是两个名字，`as` 强转能过编译但会让「请求澄清」静默变 retry（续批 selftest 实测抓出）。

## SOP 验收（续批）：锚点纪律

`verify` 执行 front-matter 的 `acceptance`：
- `kind=command` 项经沙箱跑，只支持 `<interpreter> <工作区脚本> [args...]` 封闭形态（`-c` 内联码没有可校验的工作区锚点，**如实判不可验证**而非偷换成跑别的文件）；
- `kind=platform` 项留给中台独立验证（04 §3 ⑤ 本就要求中台不复读执行器自评）；
- **无 acceptance 的 SOP 绝不 delivered**——验收是唯一目标锚点，锚点缺失时「跑通了就算交付」= 验收语义归零。

## 硬闸门（07 §7.1）

迭代 15 · 墙钟 2h · 澄清 5 · 试跑 30 · 依赖安装 10。

- **闸门在动作**之前**判**（末判 = 副作用已发生，闸门形同虚设）。测试钉死「恰好跑满上限、不多跑一轮」。
- **墙钟自首次迭代起算，resume 不重置**（否则 2h 上限可反复续命）。
- 触顶是**合法终态**：返回完整结果带 `stopReason`，不抛——中台要能区分「机器做不了」与「程序崩了」，才能决定换机器还是转人工。

## 迭代循环（07 §7）

感知 → 规划（LLM 产出文件+入口）→ 试跑（真沙箱）→ 验收（机器可执行 acceptance）→ 诊断（LLM 定下一步）。

- **档位闸独立于次数闸且在试跑之前**：off 档下一次 `trialRun` 都不会发生（off 是高合规企业唯一会选的档）。
- 澄清触顶 → 转人工且**不再调 plan**（不烧令牌）。
- handler 抛错收敛为 `outcome='error'`，不冒泡炸掉会话。

## 设置面与状态（P7c 前置增量）

- **ConfigPage「Agent（实验性）」组**：agentEnabled 开关、权限预设下拉（minimal/standard 可选；developer/ops-assist/full-trust **显示为禁用**——选了也会被解析层钳回，界面与行为一致比可点更重要）、codeExecution 覆盖、浏览器域名白名单 textarea（逗号/换行分隔 → string[]）。
- **保存通道零新面**：Agent 字段随 config:get/config:save 走既有通道，消毒层（ENUM_FIELDS/STRING_LIST_FIELDS/BOOLEAN_FIELDS）是唯一防线——设置面**不得**绕过 sanitize 直写。
- **状态行**：`agent:get-status` IPC（getAgentHostStatus，只读无敏感字段）→ working/processed/lastOutcome/lastEffectiveProfile；进组与保存后各刷新一次（反映**实际运行**状态，与未保存表单解耦）。
- **热同步**：config:save 后调 syncAgentHostWithConfig()——启停轮询不销毁 host；失败仅记日志不阻塞保存。

## 常见改动场景

- **新增权限档位**：`permission-profile.ts` 扩 `*_SPEC.implemented` + `IMPLEMENTED_PRESETS` → 同步 `config-sanitize.ts` 的 `ENUM_FIELDS`（selftest 有 SYNC 守卫钉住两处不得漂移）→ 更新 09 §6 分阶段表。注意：放开的档位要在 `trial-run.ts` 同步实现对应行为（如 `host`），否则档位解析层会把它钳回保守档。
- **调硬闸门数值**：`gates.ts` 的 `DEFAULT_GATE_LIMITS`；改完同步 07 §7.1 与本文。注意 selftest 钉住了默认值本身。
- **改 LLM 协议**：`runtime.ts` 的 SYSTEM_PROMPT + `extractJsonObject` + 动作映射表是三件一体——改响应形状必须三处同步，selftest 钉住了「错映射 = 澄清变 retry」这一形态。
- **加协作端点**：`collab-client.ts` 加方法 + selftest 的本地 http server 加用例；中台侧同步 `sop-collab.controller.ts`。
- **新增 IPC 面（Agent 状态/只读视图）**：走 `ipc-handlers.ts` 白名单 + `path-domain.ts` 域校验，见 [ipc-and-security.md](./ipc-and-security.md)。

## 相关文档

- [设计 07 执行器 Agent](../../../../design/agent-and-deployment/07-executor-agent.md) · [08 分工](../../../../design/agent-and-deployment/08-executor-agent-scope.md) · [09 权限档位](../../../../design/agent-and-deployment/09-permission-profiles.md)
- [设计 11 协作 API](../../../../design/agent-and-deployment/11-agent-collaboration-api.md)（中台侧 `modules/sop/sop-collab.controller.ts` + LLM relay 已落地；执行器侧 `collab-client.ts` 已落地）
- [中台 agent 模块](../admin-api/modules/agent.md) · [桌面总览](./README.md)
