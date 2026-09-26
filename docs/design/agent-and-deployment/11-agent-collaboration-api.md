# 11 · Agent 协作 API（执行器 Agent ↔ 中台 Agent）

> **这是复审发现的缺失子系统**（见 [10 §一·缺口 3](./10-design-review.md)）。原设计只定义了「中台 Agent」和「执行器 Agent」，但**没说它们之间怎么通信**——而 mcp-server 是 stdio-only，43 个工具全是「管理平台资源」，没有一个能用于 Agent 协作。

## 1. 为什么必须新建

### 1.1 既有通道都不适用

| 既有通道 | 为什么不行 |
|---|---|
| **MCP**（43 工具） | ① 仅 stdio，是给 Claude Desktop 本地拉起的，**不是服务**；② 43 个工具是「管理任务/执行器/应用」的，没有「拉 SOP / 发澄清 / 回报完成」 |
| **任务回调链** | 语义是「执行终态上报」，不是「双向协作」。澄清是需要**来回多轮**的 |
| **控制面 pull 通道**（ADR-016） | 语义是「中台→执行器下发命令」，方向相反 |
| **API Key** | `JWT_ONLY_API_KEY_PATHS` 不含这些路径，技术上可行，但 Agent 用 API Key 语义不对（它是机器，不是用户） |

### 1.2 需要什么

执行器 Agent 需要的动作（[04 §3](./04-sop-protocol.md)）：

```
① 领取指派          ← 拉取 SOP（含版本、contentHash）
② 上报能力          ← capability_report（07 §7 ①感知层）
③ 发起澄清          ← 带问题 + 上下文 + 媒体（视频/截图）
④ 拉取澄清回复      ← 可能附带「SOP 已修订至新版本」
⑤ 回报完成          ← 结果 + 验收自检 + 产物引用
⑥ 上报进度/心跳     ← 长任务的存活信号
⑦ 上传候选应用包    ← 复用既有 executor-package 通道
```

## 2. 设计原则

| 原则 | 说明 |
|---|---|
| **走执行器身份** | 复用既有 `validateTokenByAddress`（per-executor token），**不新造凭据体系** |
| **复用能力标记** | 用 `executors.capabilities` 加 `agent:sop` 域（[10 §缺口2补](./10-design-review.md)），复用既有派发过滤 |
| **拉模式优先** | 执行器多在 NAT 后（这是 ADR-015 pull 模式存在的理由）。**协作也应以拉为主**，避免中台拨入 |
| **幂等** | 网络不可靠，所有上报必须可重放 |
| **有界** | 澄清轮次、载荷大小、媒体时长全部有上限 |

### 2.1 ★ 关键判断：复用 pull 通道，而不是新建长连接

执行器 Agent 与中台通信，**应复用 ADR-016 的控制面 pull 通道**的模式（执行器主动长轮询），而不是要求中台能拨入执行器。

理由：
- 桌面端部署的典型拓扑就是**公网中台 + 内网办公机**（`config-store.ts` 注释明确说了这点）
- 这些机器**没有公网可达地址**，中台拨不进去
- 既有 pull 通道已验证可用（`EXECUTOR_PULL_MODE=true`）

**但不要复用同一个队列**——协作消息与任务派发/控制命令是不同性质，混在一起会让「一条大消息卡住任务派发」。建议**独立的 pull 通道**（同模式、独立队列）。

## 3. API 设计

### 3.1 拉取侧（执行器 → 中台）

```
POST /api/agent-collab/poll
鉴权: per-executor token（Bearer）+ address 身份键
语义: 长轮询，返回待办（指派 / 澄清回复）
```

请求：
```json
{
  "address": "office-pc-07:8002",
  "waitMs": 25000,
  "capabilitiesHash": "sha256:...",     // 能力变更检测（变了才重传）
  "inflight": ["asg-123"],              // 正在处理的指派（中台据此判断存活）
  "resendAssignments": true             // true=全部活跃单重发；["asg-123"]=按单定向重发（P7d 崩溃恢复）
}
```

响应（无待办时 `items: []`）：
```json
{
  "items": [
    {
      "kind": "assignment",
      "assignmentId": "asg-123",
      "sop": {
        "slug": "daily-report",
        "version": "1.0.1",
        "contentHash": "sha256:...",
        "frontMatter": { "target": {...}, "capabilities": [...], "acceptance": [...], "constraints": {...} },
        "bodyMarkdown": "# 每日销售报表生成应用\n..."
      }
    },
    {
      "kind": "clarification_reply",
      "clarificationId": "clr-456",
      "clientClarificationId": "uuid-...",  // 执行器当初生成的幂等键（原样回传，精确对账）
      "assignmentId": "asg-123",
      "round": 2,
      "resolution": "sop_amended",
      "newSopVersion": "1.0.2",
      "newSop": {                            // sop_amended 时附带修订版全量载荷（P7d）
        "version": "1.0.2",
        "contentHash": "sha256:...",
        "frontMatter": {...},
        "bodyMarkdown": "..."
      },
      "answer": "SOP 已补充：需先选择时间范围再点导出"
    }
  ],
  "sopPolicy": {                          // 中台下发的策略上限（09 §4.2）
    "permissionPolicy": "standard",
    "allowedProfiles": ["minimal", "standard"]
  }
}
```

> **`sopPolicy` 随 poll 返回**——这是企业集中管控的落地方式：执行器每次轮询都拿到最新策略，**员工本地改配置也突破不了**（[09 §4.2](./09-permission-profiles.md)）。也顺带解决了[调整 4 的离线问题](./10-design-review.md)：离线时用最近一次缓存。

### 3.2 上报侧（执行器 → 中台）

| 端点 | 用途 | 幂等键 |
|---|---|---|
| `POST /api/agent-collab/capability` | 上报能力清单 | `address`（覆盖式） |
| `POST /api/agent-collab/clarifications` | 发起澄清 | `clarificationId`（客户端生成 UUID） |
| `POST /api/agent-collab/assignments/:id/progress` | 进度心跳 | `(assignmentId, seq)` |
| `POST /api/agent-collab/assignments/:id/complete` | 回报完成 | `(assignmentId, attempt)` |
| `POST /api/agent-collab/assignments/:id/clarifications/ack` | **确认收到澄清回复**（P7d） | 游标单调推进（只前进不后退） |

**为什么幂等键由客户端生成**：网络重试时执行器会重发同一请求，中台按幂等键去重，**不会产生两条澄清**。这与既有 `triggerId`/`executionId` 的去重思路一致。

### 3.2.1 澄清回复的确认投递（双端 ACK，P7d 落地）

回复的投递是**至少一次**语义，闭环由三段组成：

1. **投递**：poll 返回 `resolution` 已落定且晚于游标 `lastReplyDeliveredAt` 的行（按轮次升序）；**投递不推游标**。
2. **消费**：执行器把回复先落盘进本地日志（崩溃恢复锚点），再触发续跑——answered/sop_amended 带着问答历史继续循环；`escalated_to_human` 如实回报 failed 终结（升级后中台不会再有自动答复，人工答复端点对已处置澄清幂等短路）。
3. **确认**：续跑到达终态（或进入下一轮澄清）后调 ack，游标推进到该回复的 `updatedAt`。确认前重发的回复由执行器按 `clarificationId` **幂等去重**，不产生二次消费。

游标在服务端**单调推进**：乱序 ACK 不会让游标回退把已消费的回复重新变成待投递。执行器侧没有可喂的循环时（日志丢失/从未在本机跑过）**同样 ACK 丢弃**——不 ACK 才是毒消息（游标不前进 = 回复永久重发）。

### 3.3 为什么不用 WebSocket

| 方案 | 评价 |
|---|---|
| **长轮询**（推荐） | ✅ 复用 ADR-016 已验证的模式；✅ 穿代理友好（`EXECUTOR_PULL_WAIT_MS` 已考虑「须 < 反代 60s 读超时」）；✅ 无需新基础设施 |
| WebSocket | ❌ ADR-015 明确「弃 WS 反连」——已有决策，不应违背 |

> ADR-015 的原文是「长轮询拉取，**弃 WS 反连**」。协作通道沿用同一决策。

## 4. 数据模型补充

### 4.1 新表：`agent_assignments`（细化 [04 §2.3](./04-sop-protocol.md))

原 [04 §2.3](./04-sop-protocol.md) 定义了 `sop_assignments`。协作 API 需要额外字段：

| 列 | 说明 |
|---|---|
| `pulledAt` | 首次被领取时间（判断「派出去了但没人接」） |
| `lastProgressAt` | 最后一次进度上报（判断卡死） |
| `progressJson` | 最新进度快照 |
| `attempt` | 重试次数（回报幂等用） |
| `capabilitySnapshotJson` | **领取时该机器的能力快照**——事后复盘「当时它能做什么」 |
| `permissionProfileAtPull` | 领取时的权限档位（审计：它当时被允许做什么） |

### 4.2 新表：`executor_capabilities`（可选）

若 `capabilities` 字段不够用（需要更丰富的结构化能力描述），可独立成表：

| 列 | 说明 |
|---|---|
| `executorAddress` | 外键 |
| `reportJson` | 完整能力报告（os/browsers/runtimes/office/network/limits） |
| `reportedAt` | |
| `hash` | 内容哈希（变更检测，避免重复传输） |

**建议**：`capabilities`（简单数组）用于**派发过滤**，`executor_capabilities.reportJson`（富结构）用于**SOP 可行性预检**（[10 §建议2](./10-design-review.md)）。两者分工明确。

## 5. 安全设计

### 5.1 鉴权

| 项 | 设计 |
|---|---|
| 身份 | per-executor token（`validateTokenByAddress`）——**已验证的机制，不新造** |
| 授权 | 该执行器必须带 `capabilities` 含 `agent:sop`，否则拒绝（**显式能力，不靠"空=通用"**） |
| 限流 | 复用 `throttle-profiles.ts` 的机器回调档；poll 是长轮询，需独立额度 |
| SSRF | 不涉及（执行器主动连中台） |

### 5.2 载荷安全

执行器上报的内容**全部不可信**（它可能被入侵、可能被提示注入）：

| 字段 | 校验 |
|---|---|
| `bodyMarkdown`（SOP 内含） | 平台生成，执行器不回传 |
| `answer`（澄清回复） | 中台生成 |
| **`question`（执行器提问）** | ⚠️ **不可信**——长度上限 + 送模型前脱敏 + 不进 system prompt |
| `mediaRefs`（媒体 URL） | ⚠️ **绝不接受任意 URL**——必须走平台 artifacts 上传（[05 §3.1](./05-qwen-multimodal.md)） |
| `progressJson` / `resultJson` | 大小上限 + schema 校验 |

> ⚠️ **最重要的一条**：执行器 Agent 上传的媒体**不能是任意 URL**。否则就是「执行器让中台去下载任意 URL 然后转给 DashScope」——SSRF 转嫁。必须是**执行器上传文件到平台 artifacts**，再由平台给出不可猜测的 URL 转给 DashScope。

### 5.3 澄清的提示注入面

执行器 Agent 的提问会**进入中台 Agent 的上下文**。这是一条**跨 Agent 注入通道**（与 [04 §4](./04-sop-protocol.md) 的 SOP 注入是对称的另一半）。

| 防护 | 说明 |
|---|---|
| 明确分隔 | 中台 Agent 的 prompt 里，执行器的提问必须**明确标注为「不可信的对方陈述」**，与平台指令分离 |
| 脱敏 | 走 `sanitizeLogs()` 同款 |
| 长度上限 | 防止塞入超长内容冲击上下文 |
| **不赋予指令权** | 提问只能作为**事实输入**，中台 Agent 的安全决策（是否修订 SOP、是否升级人工）**不受提问措辞影响**——这要靠 [03 §5](./03-agent-tools-and-boundary.md) 的代码层闸门兜底，不能靠 prompt |

## 6. 生命周期与超时

| 场景 | 检测 | 处置 |
|---|---|---|
| 指派后无人领取 | `pulledAt IS NULL` 且超 `assignmentTtl`（默认 30min） | 标记 `failed` + 通知；中台可换机器重派 |
| 领取后失联 | `lastProgressAt` 超 `progressTtl`（默认 10min） | 标记 `stalled`；中台决定等待或重派 |
| 澄清无人回 | 中台 Agent 会话超时 | 转人工（[04 §3](./04-sop-protocol.md)） |
| 执行器权限档位被下调 | poll 返回的 `sopPolicy` 变化 | 执行器**立即遵守**；正在跑的指派需中止或降权 |

**最后一条很重要**：企业 IT 在中台把某台机器的档位从 `ops-assist` 降到 `standard` 时，**正在运行的 Agent 必须立刻受影响**，而不是等下次重启。所以策略随 poll 下发（[§3.1](#31-拉取侧执行器--中台)）。

## 7. 与既有模块的对接

| 模块 | 对接 |
|---|---|
| `modules/executor` | 复用 `validateTokenByAddress`、`capabilities`、throttle profile |
| `modules/artifacts` | 媒体上传（复用鉴权 + 大小限制 + 保留策略） |
| `modules/notification` | 指派超时/卡死通知 |
| `modules/audit` | 指派/完成/澄清记审计 |
| `packages/executor-protocol` | ⚠️ **协作协议也应纳入契约治理**——项目有「协议单一事实源 + 双端生成 + CI 漂移兜底」的纪律。协作消息结构应同样处理 |
| `pull` 通道（ADR-016） | 独立队列，同模式 |

> **契约治理是很重要的一点**：`packages/executor-protocol` 是你项目里「三方执行器协议」的单一事实源，有双生成器（zod + pydantic）+ CI 漂移守卫。**Agent 协作协议是新的一条执行器↔中台线缆协议，理应纳入同一治理**，否则会重演「四处手抄常量、错位就静默失败」的历史（`protocol-version-consistency.spec.ts` 的注释记录过这个教训）。

**有现成先例可照搬**：`executor-protocol` 里已有 `executorNodeOnly` 段的处理方式——

> `deploy` / `update-package` 端点载荷**仍未** schema 化——它们是 executor-node **独有**（executor-python 无对应 router），按「修改纪律」不拉进两端共享契约。protocol.json 新增顶层 `executorNodeOnly` 段……

同理，**Agent 协作协议也是 executor-desktop 独有的**（python/node 执行器不参与，这是你已定的分工）。所以：

| 做法 | 说明 |
|---|---|
| 新增 `agentCollab` 段 | 与 `executorNodeOnly` 同构——文档型契约，不参与双生成 |
| 若将来 python/node 也支持 | 届时提升进 `schemas` 段（同 `executorNodeOnly` 的升级规则） |
| 遵守修改纪律 | 「只能追加向量，不能修改既有向量」；语义变更属破坏性变更，需 bump `$schemaVersion` |

**并且要遵守一条重要纪律**（`executor-protocol` README 明确写了）：

> 新增契约面前先问：这条语义是否真的三方共有？**只属于一端的实现细节不该进这里**（进来了就是给另外两端凭空加耦合）。

Agent 协作**不是三方共有**（只有 desktop 参与），所以**不应进 `schemas` 段**——进 `agentCollab` 段或独立 protocol 文件才对。这个判断很重要，做错了会给另外两端凭空加耦合。

## 8. 待你确认

1. **协作协议纳入 `executor-protocol` 治理**（放 `agentCollab` 段，**不进 `schemas`**）——我建议是，理由见 §7。
2. **复用 pull 长轮询模式**（而非 WebSocket）——我建议是，ADR-015 已有「弃 WS 反连」决策。
3. **`agent:sop` 能力标记**——复用既有 `capabilities` 字段（[10 §缺口2补](./10-design-review.md)），零新列。
4. **指派超时默认值**（领取 30min / 进度 10min）是否合适？

> 这 4 项我都有明确建议，若无异议我按建议推进。