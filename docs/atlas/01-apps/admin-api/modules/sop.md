# sop 模块 — SOP 协议（P5 起草发布指派 + P6 澄清循环）

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09（P5/P6） · 对应代码: apps/admin-api/src/modules/sop
> 设计文档: [docs/design/agent-and-deployment/](../../../../design/agent-and-deployment/)（04 / 11）

## 职责

SOP（标准作业协议）的**全生命周期**：起草 → 发布（不可变版本）→ 指派 →
协作通道（poll / 澄清 / 进度 / 完成）→ 澄清复核。

SOP = 「文档 + 契约」的合体（04 §1）：

| 载体 | 读者 | 用途 |
|---|---|---|
| `bodyMarkdown` | 人 / LLM | 背景、步骤、已知坑、实现自由度的说明 |
| `frontMatterJson` | 平台代码 | 可执行契约：target / capabilities / **acceptance（唯一目标锚点）** / constraints / clarification |

一句话：Markdown 是血肉，YAML 是骨架——**只有 YAML 平台无法给人读的上下文，
只有 Markdown 平台无法程序化校验「SOP 是否被执行」**。

## 路由

### 管理面（`sop.controller.ts`，全 `@Roles(ADMIN)`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sop` | 列表（status 过滤） |
| GET / PATCH / POST | `/api/sop/:id`、`/api/sop` | 详情 / 编辑工作副本 / 起草 |
| POST | `/api/sop/:id/publish` | 发布（严格校验 + 不可变快照 + contentHash） |
| POST | `/api/sop/:id/assign` | 指派（executorId 或 executorAddress） |
| GET | `/api/sop/:id/versions` / `/api/sop/:id/assignments` | 版本历史 / 指派记录 |
| GET | `/api/sop/assignments/:assignmentId` | 指派详情（含澄清全量） |

### 协作面（`sop-collab.controller.ts`，`@Public()` + 执行器 token）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/agent-collab/poll` | 长轮询（≤25s，低于反代 60s 读超时）；返回指派 + 澄清回复 + **sopPolicy** |
| POST | `/api/agent-collab/capability` | 能力上报（覆盖式；接 SOP 的机器必须显式含 `agent:sop`） |
| POST | `/api/agent-collab/clarifications` | 发起澄清（幂等键 clientClarificationId） |
| POST | `/api/agent-collab/assignments/:id/progress` | 进度心跳（卡死判定依据） |
| POST | `/api/agent-collab/assignments/:id/complete` | 回报完成（幂等键 attempt） |

协作面鉴权复用 `validateTokenByAddress`（与 pull/heartbeat 同一条机器身份链），
**且要求执行器 `capabilities` 显式含 `agent:sop`**——既有「空能力 = runtime 通用」
语义不沿用（10 §缺口2补：空能力 ≠ 能做任何 SOP）。

## 四张表

| 表 | 承载 | 关键设计 |
|---|---|---|
| `sops` | 当前态（**工作副本**） | slug 唯一；published 态也可编辑（准备下一修订） |
| `sop_versions` | **不可变**版本快照 | 只 insert 不 update；`(sopId, version)` 唯一；contentHash = sha256(stable(frontMatter+body)) |
| `sop_assignments` | 指派工单 | maxRounds **指派时快照**；pulledAt/lastProgressAt 判「没人接/卡死」；attempt 幂等 |
| `sop_clarifications` | 澄清对话 | clientClarificationId 唯一（客户端生成，重试重发不产生两条）；question/context/mediaRefs 全按不可信处理 |

### 为什么主表允许编辑 published 的 SOP

已发布版本的**真身是不可变快照**，执行器拉取永远读 `sop_versions`。主表只是
工作副本，编辑它不影响任何已派发内容；「内容未变不得重复发布」的闸门保证
工作副本的漂移必须真的改了什么才能成为新版本。两闸合起来 = 「修订自由 +
历史不可变」同时成立。

## 关键机制

### 发布（`publish`）

严格校验（未知键拒绝 / acceptance 必填 / capabilities 枚举 / maxRounds ≤ 硬上限 5 /
allowedDomains 裸域名）→ 内容未变即拒 → 版本号 bump（首次 1.0.0）→ 写不可变快照
→ 指针前移。**非法 SOP 无法发布**是 CI 级门槛，不是运行时警告（04 §4.1）。

### 澄清循环（P6 核心，04 §3 ④）

```
执行器 POST /agent-collab/clarifications
  → 幂等去重（clientClarificationId）
  → question 脱敏 + 长度钳位；mediaRefs 只认平台内路径
  → clarificationRound >= maxRounds ？── 是 → escalation_to_human + WARNING 通知（不起会话）
  → 否则 round+1，起 sop_review 会话（parentSessionId 串联编排会话；
      scope = { sops: [sopId] }——只能读被复核的那一份）
  → agent-jobs 入队 → 中台 Agent 复核 → sop_reply_clarification 工具：
      answered（直接答复）/ sop_amended（修订 + 发 patch 新版本）/ escalated_to_human
  → 执行器经 poll（lastReplyDeliveredAt 游标）拿到回复继续
```

**maxRounds 触顶不生效即转人工**：两个 Agent 的「礼貌循环」是真实风险，
第 maxRounds+1 次追问直接升级，不烧令牌。

### 提示注入面（11 §5.3）

执行器的提问会进中台 Agent 上下文——这是**跨 Agent 注入通道**的另一半。
防护是分层的：question 标注为「不可信的对方陈述」与平台指令分隔（会话
context 的 `untrustedQuestion` 字段）→ 脱敏 → 长度钳位 → 修订/升级的安全
决策由代码层闸门（maxRounds、白名单、scope）兜底，**不靠 prompt**。

### sop_amended 的自主修订边界

澄清场景的 patch 修订由 Agent 自主（04 §4.3「后续小版本可配自主」），
但与人工发布走**同一道**严格校验 + 不可变快照；独立发布（`sop_publish`）
则**逐工具默认需审批**——发布权 = 间接的指令注入权。

## 与其他模块的关系

- **agent**（装配期 forwardRef）：澄清上报起 `sop_review` 会话（`AgentSessionService`
  + agent-jobs 队列）；agent 的 `ToolBinderService` 把 6 个 `sop_*` 工具绑定到
  `SopService`。环是装配期的，不是运行期调用环。
- **executor**：协作面鉴权与能力闸；`updateCapabilities` 支持能力上报。
- **notification**：maxRounds 升级通知（fail-open）。
- **executor-protocol**：协作协议**暂不进 protocol.json**——非三方共有语义不进契约
  （executor-protocol README 纪律）；P7 executor-desktop 实现 client 时按 11 §7
  进 `agentCollab` 段（文档型，不参与双生成）。

## 常见改动场景

- **调 maxRounds 硬上限**：`SOP_MAX_ROUNDS_HARD_CAP`（sop-frontmatter.ts）——
  现有指派的 maxRounds 是**指派时快照**，改硬上限不追溯已派工单。
- **加能力域**：`SOP_CAPABILITIES`（sop-frontmatter.ts）；P7 执行器侧按能力域
  装配工具（browser/gui/filesystem/http）。
- **加协作端点**：鉴权必须走 `authenticateAgent`（token + agent:sop 能力闸），
  不要用裸 `authenticate`（那是 capability 上报专用——它必须在能力声明前可用）。
- **加 SOP 工具**：`AGENT_INTERNAL_TOOL_SPECS`（tool-registry.ts）+ ToolBinder 绑定
  + 白名单映射；不要动 `AGENT_TOOL_SPECS`（43 parity 镜像，多一个都红）。

## 相关文档

- [设计文档 04 · SOP 协议](../../../../design/agent-and-deployment/04-sop-protocol.md)
- [设计文档 11 · Agent 协作 API](../../../../design/agent-and-deployment/11-agent-collaboration-api.md)
- [agent 模块](agent.md)（运行时与边界闸门）
