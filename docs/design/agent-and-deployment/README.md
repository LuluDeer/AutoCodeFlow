# AutoCodeFlow 中台 Agent + 双模部署 · 设计方案

> 状态：**设计评审稿（未实现）** · 产出日期：2026-09 · 对应代码基线：`apps/admin-api` / `packages/mcp-server`

本目录是本轮"一键部署 + 中台内置 Agent"两个目标的完整设计。**先评审、再实现**。

## 文档索引

| 文档 | 内容 | 读它来解决什么问题 |
|---|---|---|
| [01-deployment.md](./01-deployment.md) | 一键部署：源码模式 + Docker 模式 | 生产端为什么用源码部署？一条命令怎么跑起来？ |
| [02-agent-architecture.md](./02-agent-architecture.md) | 中台 Agent 运行时架构 | Agent 装在哪、怎么常驻、工具怎么调、会话怎么存 |
| [03-agent-tools-and-boundary.md](./03-agent-tools-and-boundary.md) | 工具集与边界控制 | 43 个 MCP 工具怎么收编？危险动作怎么拦？ |
| [04-sop-protocol.md](./04-sop-protocol.md) | SOP 协议与多 Agent 协作 | SOP 长什么样？执行器 Agent 不懂时怎么回问？ |
| [05-qwen-multimodal.md](./05-qwen-multimodal.md) | Qwen / DashScope 多模态接入 | 视频理解怎么接？现有 `ai.service.ts` 怎么改？ |
| [06-roadmap.md](./06-roadmap.md) | 分阶段落地路线图 | 先做什么、后做什么、每阶段的验收标准 |
| [07-executor-agent.md](./07-executor-agent.md) | ★ 执行器 Agent（通用自主智能体） | 它凭什么能自己做？代价是什么？怎么不失控？ |
| [08-executor-agent-scope.md](./08-executor-agent-scope.md) | ★ 执行器 Agent 最终分工（已确认） | 哪些执行器加 Agent？与既有安全防线冲突在哪？ |
| [09-permission-profiles.md](./09-permission-profiles.md) | ★ 企业权限档位模型 | 那四个安全决策怎么变成企业可配的选项？ |
| [10-design-review.md](./10-design-review.md) | ★ 设计复审：缺口与补充 | 对照代码复审发现的 6 个缺口 / 5 处调整 / 5 条建议 |
| [11-agent-collaboration-api.md](./11-agent-collaboration-api.md) | ★ Agent 协作 API（缺失子系统） | 执行器 Agent 和中台 Agent 到底怎么通信？ |

## 一、目标（你的原话拆解）

你提了四件事，它们其实是一条链：

```
① 一键部署脚本（源码部署 + Docker 部署）
        ↓ 部署好了才有"中台"可运维
② 中台内置 Agent —— 不是"AI 分析对话"，是能自主调工具排查环境异常的运维主体
        ↓ 运维之外，还要能"造"
③ AI 写代码 → 新建应用 → 补 SOP 文档 → 指派给执行器 Agent 在网页上自动写应用
        ↓ 执行器 Agent 有疑问 → 回问中台 Agent → 复核补充 → 直到合格
④ 中台 Agent 必须接 Qwen 这类支持视频理解的模型
        ↓ 因为"网页上自动写应用"要看得懂录屏/截图
```

关键判断：**②③④ 是同一个 Agent 运行时的三种工作负载，不是三个系统。**
运维排障、SOP 编写复核、视频理解都复用同一套「工具调用循环 + 会话持久化 + 边界审批」底座。

## 二、现状盘点（设计的事实基础）

### 2.1 已经有的（可直接复用，不要重造）

| 能力 | 位置 | 复用方式 |
|---|---|---|
| 43 个 MCP 工具 | `packages/mcp-server/src/tools.ts` (52 KB) | **收编为 Agent 工具集**——它已经把 admin-api 的 HTTP 面封装好了 |
| AI provider 抽象 | `apps/admin-api/src/modules/ai/ai.service.ts` | 在 `callProvider` 加 `qwen` 分支 |
| SSRF 守卫 + DNS pin | `common/utils/safe-http.util.ts` | Agent 一切出站调用复用，**不新开旁路** |
| 日志脱敏 | `ai.service.ts` `sanitizeLogs()` | Agent 送模型前必须过同一函数 |
| 会话/配置存储 | `system_configs` + `SystemConfigService` | Agent 配置键 `agent.*` |
| 通知渠道路由 | `modules/notification`（企微/钉钉/Slack/飞书/邮件/Webhook） | Agent 汇报结果直接走 `notify()` |
| 事件总线 | `common/events/domain-events.ts` | Agent 订阅执行失败/执行器离线等事件 |
| RBAC | `UserRole` + `@Roles()` + 全局 `RolesGuard` | Agent 高危工具按角色收紧 |
| 部署记录/审批 | `modules/application/app-deployment.service.ts`（DEP-04） | Agent 部署必须走**同一套审批** |
| 一键安装脚本 | `modules/executor/install-script.content.ts` | 双模部署的 executor 分支复用 |
| 定时备份 | `docker-compose.yml` profile `backup` | 部署脚本编排它 |

### 2.2 现在的缺口（要新建的）

| 缺口 | 说明 |
|---|---|
| **没有常驻 Agent** | `mcp-server` 是 stdio 单次进程，由 Claude Desktop 拉起；它自己不"想"事、不定时醒、不订阅事件 |
| **没有工具调用循环** | 现有 AI 是「一次 prompt → 一次 response」，无多轮 tool-calling |
| **没有会话持久化** | 无 agent 会话/步骤/工具调用记录表 |
| **没有边界审批** | 现有 AI 全部只读（分析日志），一旦让它能写就有风险 |
| **没有 SOP 概念** | 全库无 SOP 实体、无版本、无指派、无复核 |
| **没有视频理解** | `ai.service.ts` 只有纯文本 `messages: [{content: prompt}]`，且 `max_tokens: 500` 硬编码 |
| **部署脚本不成体系** | 根 `deploy.sh` 只支持 Docker；源码部署步骤散在 `docs/deployment.md`（76 KB）里靠人手动跟 |

## 三、核心设计决策（已与你确认）

| 决策 | 选择 | 理由 |
|---|---|---|
| Agent 大脑位置 | **admin-api 内置 `modules/agent`** | 常驻需求 + 复用 DI/事件/通知/RBAC；源码部署即生效，不新增部署单元 |
| 本轮产出 | **完整设计文档** | 先评审再动手，避免返工 |
| Qwen 接入 | **新增 `provider=qwen`，走 DashScope OpenAI 兼容端点** | 不动现有 openai/ollama 语义；多模态 content 数组是该 provider 独有路径 |

### 三处必须守住的既有纪律

1. **fail-open 不可破**：现有 AI 全链路「AI 不可用绝不影响任务主链」。Agent 是新链路，**允许它自己失败**，但绝不能让它的失败回灌到调度/执行主链。设计上 Agent 只订阅事件、只调工具，不嵌在 `TaskProcessor` 的关键路径里。
2. **SSRF 守卫不新开旁路**：Agent 的视频/图片 URL 拉取、MCP 工具转发、provider 出站，**全部**走 `assertAndPinHttpUrl` + `pinnedAxiosConfig`。这一条是安全红线，见 [03](./03-agent-tools-and-boundary.md)。
3. **危险动作走既有审批**：Agent 要部署应用/改生产配置，必须命中 DEP-04 的 `pending_approval` 流程，**不允许**给 Agent 开"免审批"后门。

## 四、一句话架构

```
                        ┌─────────────────────────────────────────┐
                        │  中台 Agent Runtime (modules/agent)      │
   事件总线 ───────────► │  ┌─────────┐  ┌──────────┐  ┌────────┐  │
   (执行失败/离线)       │  │ 触发器  │─►│ 推理循环 │─►│ 工具层 │  │
                        │  │ 定时/事件│  │(tool-   │  │43 MCP  │  │
   Admin Web 对话 ─────► │  │ /人工   │  │ calling)│  │+ 内部  │  │
                        │  └─────────┘  └──────────┘  └────────┘  │
   执行器 Agent 回问 ───► │       │            │            │       │
   (SOP 澄清)           │       ▼            ▼            ▼       │
                        │  ┌──────────────────────────────────┐   │
                        │  │ 会话持久化 · 边界闸门 · 审计       │   │
                        │  └──────────────────────────────────┘   │
                        └─────────────────────────────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
        admin-api 内部服务      通知渠道               Qwen/DashScope
        (任务/执行器/部署)   (企微/钉钉/飞书)      (文本 + 视频理解)
```

## 五、评审要点（请重点看这几处）

1. **★ 执行器 Agent 是通用自主智能体** —— 见 [07](./07-executor-agent.md)。这个设想**能做且价值最大**，但它要求把「执行器上可跑任意代码」变成合法状态，与你项目现有加固方向相反。**这是必须你拍板的第一件事**（[07 §10](./07-executor-agent.md)）。
2. **Agent 常驻是否会拖垮 admin-api？** —— 见 [02 §5 资源与隔离](./02-agent-architecture.md)，判断是「会有影响，需要 BullMQ 独立队列 + 并发上限 + 熔断」。
3. **工具集分级而非全开** —— 见 [03 §2](./03-agent-tools-and-boundary.md)。`approve_deployment` 建议**硬编码禁用**（双人原则不能被 Agent 架空）。
4. **SOP 从「操作手册」变成「声明式目标」** —— 见 [04 §7](./04-sop-protocol.md)。这是通用 Agent 带来的关键转变：SOP 不再因目标系统改版而批量失效。
5. **视频理解只用于一条窄路径** —— 见 [05 §4](./05-qwen-multimodal.md)。执行器 Agent 卡住时上传录屏，中台看懂后判断是 SOP 不清还是页面变了。

## 六、决策状态

### ✅ 已实现

| 阶段 | 产物 | 验证 |
|---|---|---|
| **P0** 一键部署脚本 | `deploy.sh`（双模 8 阶段）+ `doctor --json` + rollback | 29 项自检 |
| **P1** Qwen 多模态 | `chatMultimodal` / `callQwenText` / `hasApiKeyForProvider` + 前端配置段 | 34 运行时 + 44 结构 |
| **P2** Agent 运行时底座 | 三张表 + 推理循环 + 预算闸门 + 独立队列 + 5 项指标 | 66 运行时 |
| **P3** 工具集与边界闸门 | 43 工具 + 6 类白名单 + 五道闸门 + 执行器 + 15 个只读执行体 | 98 边界（含 13 类红队） |
| **P4** 触发器 | 定时巡检 + 事件聚合窗口 + 会话/审批通知 | 37 + 31 |
| **P5** SOP 协议 | 四张表 + front-matter 严格校验 + 6 个 SOP 工具 + Admin Web 页 | 58 |
| **P6** 澄清循环（中台侧） | 协作 API 全套 + sop_review 会话 + maxRounds 硬闸 | 58（含 P5） |
| **P7a** 执行器 Agent 骨架 | 档位 + 沙箱 + 感知 + 硬闸门 + 循环外壳（**LLM/试跑未接**） | 5 套 selftest 接 `test:main` |

累计 **275+ 项断言全绿**，项目既有门禁（迁移注册/索引漂移/多字节变量/lint gates）全通过。

> **P7a 进度说明**：骨架已落地（`apps/executor-desktop/src/main/agent/`），但 **LLM 与真实
> 试跑执行体尚未接入**——`loop.ts` 已留依赖注入口。能力域**如实**只报 `filesystem` / `http`，
> 未实现浏览器前不声明 `browser`（否则中台的可行性预检会把需要浏览器的 SOP 派过来然后卡住）。
> 详见 [06 §9.4](./06-roadmap.md)。

### P3 安全态势（红队已验证）

| 防线 | 状态 |
|---|---|
| `approve_deployment` / `reject_deployment` 硬禁用 | ✅ 不可配置，放开 dangerous 仍拒 |
| shell / 换行 / 路径穿越 / SSRF 注入 | ✅ 全拒（含嵌套对象） |
| scope 越权 + 空 scope 安全默认 | ✅ 全拒 |
| 速率限流 + 连续失败熔断 | ✅ 生效且按 (会话,工具) 隔离 |
| denied 落库（安全信号不丢） | ✅ |

### ✅ 已定案

| 决策 | 结论 |
|---|---|
| 执行器 Agent 范围 | **只加在客户端执行器（executor-desktop）**；python/node 执行器保持纯净、零行为变化 |
| 客户端 Agent 职责 | 不只「造」，**也能直接执行任务** |
| Agent 交付形态 | **内置 executor-desktop**（Agent 以子进程运行，由 desktop 托管） |
| Qwen 接入方式 | 新增 `provider=qwen`，走 DashScope OpenAI 兼容端点 |
| 四项安全决策 | 转为**企业权限档位**（[09](./09-permission-profiles.md)），默认 `standard` |

### ✅ 自主分析定案（12 项）

`approve_deployment` 硬编码禁用、审批复用 DEP-04、预算并发 2 / 每日 5M 令牌、SOP 首发必须人工批、媒体走 artifacts + 7 天保留、无 Docker 生产环境不支持、多机部署后置、会话保留 30/90 天（写操作对齐审计 180 天）等。清单见 [06 §11](./06-roadmap.md)。

### ⚠️ 复审发现的缺口（开工前需补）

[10-design-review.md](./10-design-review.md) 对照代码复审后发现 **6 个缺口**，其中最严重的三个：

| # | 缺口 | 影响 |
|---|---|---|
| 3 | **执行器 Agent 协作 API 整个缺失** | mcp-server 是 stdio-only，43 工具无一可用于协作 → 已补 [11](./11-agent-collaboration-api.md) |
| 2 | Agent 凭据链未定义 | 直接决定实现方式 → 已定：中台 in-process 走 Service 层；执行器复用 `validateTokenByAddress` + `capabilities` |
| 1 | **Agent 与任务失败分析抢 AI 配额** | 会让任务失败分析**静默失效且不可观测** → 需独立配额 + 指标 |

其余：DEP-04 待审批行占坑会卡死应用（缺口 4）、审计 append-only 表膨胀（缺口 5）、Agent 触发与执行的关联未定义（缺口 6）。

**具体修订清单**（哪份文档哪一节怎么改）见 [10 §六](./10-design-review.md)。
