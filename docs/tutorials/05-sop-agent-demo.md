# 教程 05 · SOP 生态演示：从种子到 Agent 执行

> 目标：跑通「SOP 起草 → 发布 → 版本 → 指派 → 执行 → 平台复核」的完整链路，
> 并在 Linux X11 会话里演示 GUI 能力域。内容面全程 ≤ 15 分钟、零配置；
> 执行面（§4 起）需要 Agent 执行器在线，前置单独列出。
> 前提：已按[快速上手](../quickstart.md)启动全栈，并跑过一次种子：
>
> ```bash
> npm run demo:seed -- --base-url http://localhost:3105 --username admin --password 'Admin@123456'
> ```
>
> 种子会预置 3 条已发布的演示 SOP（`demo-sop-` 前缀，v1.0.0）+ 3 个演示任务
> （`demo-` 前缀）。**演示 SOP 的机器验收锚点引用了这些任务**——这是零配置
> 能跑通复核链的关键。

## 0. SOP 是什么（与任务的区别）

任务（Task）是「已知的、打包好的」自动化：trigger + glue 脚本，每次执行都一样。
SOP 是**声明式的目标描述**，交给执行器上的 Agent 现场实现——你写「要做什么/
验收是什么/边界在哪里」，不写步骤；Agent 自主决定用 Playwright、curl 还是
GUI 操作，以验收通过为准。契约与安全模型见设计文档
[04-sop-protocol](../design/agent-and-deployment/04-sop-protocol.md)。

front-matter 是 SOP 的机器契约（严格校验、未知键拒绝）：

| 字段 | 含义 | 演示 SOP 里的形态 |
|------|------|------------------|
| `target` | 目标应用/运行时 | `application: Chrome` / `xterm` |
| `capabilities` | 允许的能力域（封闭枚举） | `browser` / `filesystem` / `gui` |
| `acceptance` | **验收锚点**（发布必填，1..10 项） | `kind: platform` 引用演示任务 |
| `constraints` | 平台强制的硬边界 | `maxDurationSec` / `allowedDomains` |
| `clarification` | 澄清路由 | 回问给中台 Agent 或人工，轮次上限 |

三条演示 SOP 一览：

| slug | 能力域 | 演示点 |
|------|--------|--------|
| `demo-sop-portal-morning-check` | browser | 域名白名单 + 澄清回问给中台 Agent |
| `demo-sop-incident-log-archiver` | filesystem | 与 `demo-fragile` 失败样本联动的叙事 |
| `demo-sop-gui-x11-hello` | gui | Linux X11/Xvfb 会话的 GUI 动作（§5） |

## 1. 看懂 SOP 管理面（零配置，≤ 5 分钟）

登录管理台 → **SOP 页面**：三条 `demo-sop-` 前缀的 SOP 已在列表里，状态
published。点开任意一条：

- **front-matter**：对照上表逐字段看一遍——特别看 `acceptance`：每条
  `kind: platform` 的 `task` 字段是一个**任务 id**（不是任务名）。中台复核
  会话触发该任务并用 id 精确比对作用域白名单（[03 §5.3](../design/agent-and-deployment/03-agent-tools-and-boundary.md)），
  所以 SOP 的验收锚点在 seed 时就绑定了真实任务 id。
- **正文**：按「要做什么 / 验收 / 已知情况 / 你不必照做」四段写——最后一段
  是关键：明确告诉 Agent 有实现自由。

等价的 API 路径（ADMIN 角色令牌）：

```bash
curl -s http://localhost:3105/api/sop -H "Authorization: Bearer $TOKEN" | jq '.data.items[].slug'
curl -s http://localhost:3105/api/sop/<sopId> -H "Authorization: Bearer $TOKEN" | jq '.data.frontMatterJson'
```

## 2. 版本快照与「内容未变不得重复发布」（零配置）

SOP 发布产生**不可变版本快照**（v1.0.0，contentHash 锚定），执行器拉取永远
读版本表。演示两个特性：

1. **版本历史**：SOP 详情 → 版本列表（API：`GET /api/sop/<id>/versions`），
   确认 v1.0.0 在案。
2. **幂等种子**：再跑一次 `demo:seed`——SOP 已存在则复用、已发布则不动，
   不会产生重复版本，也不会覆盖你在演示期间对工作副本的改动。改一版再发布
   走 `PATCH /api/sop/<id>` + `POST /api/sop/<id>/publish`（bump 语义：
   patch/minor/major），内容没变时发布会被拒——这就是「不可变快照」的门。

## 3. 指派与执行链路（前置：Agent 执行器在线）

> **前置**（缺任一则本节只能看不能跑）：
> - 一台 desktop 执行器（AutoFlow 桌面端）在线，且「Agent（实验性）」已启用；
> - Agent 需要真实 LLM——桌面端配置里填好模型与 Key（当前 qwen 分支已就绪，
>   DashScope Key 未开通前本节不可跑，见认领板 N-05 备注）。

指派是管理面动作（ADMIN-only——发布权 = 间接的指令注入权，见
[04 §4.3](../design/agent-and-deployment/04-sop-protocol.md)）：

```bash
curl -s -X POST http://localhost:3105/api/sop/<sopId>/assign \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"executorId": "<desktop 执行器 uuid>"}'
```

之后链路自动走完，逐段在中台可观测：

1. 执行器 poll 领取指派 → Agent 读 SOP（front-matter + 正文）开始实现；
2. **澄清**：信息不足时 Agent 发起澄清提问（演示 SOP 的路由：两条回问人工、
   一条回问中台 Agent），管理台回复后 Agent 继续——轮次上限 5；
3. **交付**：Agent 回报完成后，中台**不信自述**，起独立的 `sop_review`
   复核会话，按 `acceptance` 的 `kind: platform` 项真触发一次演示任务
   （`demo-cron-report` / `demo-hello-fixed`）并轮询到终态核对 `expect`；
4. 复核通过 → 指派完成；不通过 → 澄清循环带回差距描述。

全程在 **Agent 会话页**看时间线；指派记录在 SOP 详情 → 指派列表。

## 4. GUI 能力域演示（前置：Linux + X11 会话）

`demo-sop-gui-x11-hello` 演示 GUI 分支：聚焦 `xterm` → 键入命令 → 回车 →
窗口截图。GUI 是四个能力域里闸门最重的一个，前置逐条对齐：

| 前置 | 说明 |
|------|------|
| Linux 执行器 + X11/XWayland 会话 | 物理会话或 Xvfb 无头均可（`xvfb-run` 包一层即可） |
| `xdotool` + `ffmpeg` | X11 注入与截图后端，`probe` 缺包如实降级 |
| 本地档 `hostAccess=app-scoped` + 白名单含 `xterm` | 桌面端配置里设（[09 §2.3](../design/agent-and-deployment/09-permission-profiles.md)） |
| 中台 `AGENT_SOP_POLICY_ALLOWED` 含 `app-scoped` | `.env` 里把默认 `minimal,standard` 追加 `app-scoped`——standard 档会把本地 app-scoped 钳回 none |

之后重复 §3 的指派动作（选 GUI SOP）。执行时注意两个如实边界：

- **逐动作白名单复核**：每步先核对前台窗口进程名 == `xterm`、坐标越出目标
  窗口矩形即拒——Agent 绕不开；GNOME Wayland 原生窗口则**如实不可达**
  （枚举树看不到、注入不达），能力上报不含 gui。
- 验收的机器锚点仍是平台任务（同 §3 第 3 步）；GUI 产物 marker 文件留在
  执行器工作区，人工核对截图与 marker。

## 5. 卸载

删除 `demo-` 前缀任务与 `demo-sop-` 前缀 SOP 即可（UI 或 API）。种子幂等，
随时可重跑重建。

## 6. 已学到的与下一步

- SOP = 声明式目标 + 机器契约 + 不可变版本；验收锚点决定「零配置可复核」程度
- 复核链路不信执行器自述：platform 验收由中台独立触发任务核对
- GUI 域 = X11 后端 + app-scoped 白名单 + 逐动作复核（macOS 侦察结论见
  [13-executor-gui-macos](../design/agent-and-deployment/13-executor-gui-macos.md)）
- 下一步：[03 · 多执行器扩容](./03-multi-executor-scaling.md)（多执行器给
  SOP 指派做容量池）/ [04 · 告警接入值班](./04-alerting-oncall.md)
