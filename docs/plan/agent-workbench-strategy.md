# AutoCodeFlow → 企业 Agent 工作台：改造方向与推进方案

> 受众：产品/架构决策者、接手维护者 · 状态：提案（待拍板） · 日期：2026-11-26
> 本文基于「CodeGraph 对本仓现状探查 + 4 路子 agent 对 Octop / ZCode / opencode / magpie+dsh 的深挖」形成，
> 每条关键结论附证据。方法论沿用本仓 ROADMAP 的「每结论配反方」：方案里明确写出**不做什么**和**风险**。

---

## 0. 决策摘要（先看这 8 行）

| 问题 | 结论 |
|---|---|
| 受众窄的根因是什么？ | 不是功能少，是**交互范式错位**：现有两个客户端都是「管运行时」的运维台（cron/executor UUID/glue/审批单），没有「用运行时拿业务结果」的工作台。业务人员被要求理解调度概念。 |
| 推倒重来吗？ | **不**。现有 scheduler + executor + SOP + 审批 + 审计 + 56 工具 MCP 是可审计执行底座，是别人抄不走的护城河；缺的是它上面的一层「工作台 + 能力治理」。 |
| 客户端怎么改？ | **一层解耦、三端协同**：新增「业务工作台 Workbench」（Web 优先，桌面壳可选）；「中台管控 Control」在现有 admin-web 增强；「执行器 Executor」保留原有功能设计、保持基础设施定位，不塞业务 UI。 |
| skill / MCP / 模型渠道怎么管？ | 抽象为统一的 **Capability（能力）注册表**，配 **Scope 作用域链 + Policy 硬策略**，原生支持三档治理：中台统管 / 业务自建 / 中台可见可收回。 |
| 模型渠道 | 复用现有 AI Provider 注册表（已支持 analysis/agent/video 路由、ADMIN-only、密钥信封），扩展为「渠道 + 配额 + failover + 用量归属」，不新起网关。 |
| 最大风险 | 把工作台塞进执行器 → 执行器从「可替换的基础设施」变成「业务入口」，升级即中断业务、权限面被放大到桌面。这是要重点防的架构回退。 |
| 推进节奏 | P0 契约与决策 → P1 能力注册表 → P2 工作台 MVP（会话+工具过程+审批）→ P3 中台管控三档 → P4 生态（市场/隔离/网关）。每阶段有退出条件。 |
| 需要你拍板 | ①工作台主形态（Web 优先 vs 桌面优先）②默认治理档位 ③配置项 schema 走文件还是 DB ④模型渠道是否自建网关。见 §5。 |

---

## 1. 现状诊断

### 1.1 已经做对的（不能推倒重来）

本仓已交付 73 轮改动 / v2.3.0，是一套**成熟的可审计自动化执行底座**（[PROJECT-STATUS.md](../PROJECT-STATUS.md)）：

- **调度与执行**：cron / 固定频率 / webhook / DAG，JS/Python/Shell；日志、重试、超时、并发闸、告警；执行器 Pull 模式（无需入站端口）。
- **桌面执行器**：Electron 客户端，配置向导 / 状态 / 历史 / 应用台账四页 + X11 GUI 驱动 + 应用白名单 + 配置热同步 + IPC sender 守卫（[ipc-sender-guard.ts](../../apps/executor-desktop/src/main/ipc-sender-guard.ts)）。
- **Agent 闭环**：SOP「目标+验收」协议 → AgentHost → 试跑 → 验收四道闸；多模态 relay（截图 inline）；截图诊断回路；中台 ops Agent。
- **审批治理**：四眼原则（申请/审批不得同人）、策略指纹（策略变更使旧授权失效）、`argsDigest`/`preview` 治盲批（[agent-approvals.service.ts](../../apps/admin-api/src/modules/agent/runtime/agent-approvals.service.ts)）。
- **可观测**：TTFV 漏斗 / 北极星 / W4 留存 / SOP 成功率 / 人工接管率，全部可复算；审计日志、产物鉴权上传下载。
- **AI 接入**：provider 注册表 + 按用途路由（analysis/agent/video），ADMIN-only 配置，密钥 SEC-02 信封加密（[ai-providers.ts](../../apps/admin-api/src/modules/ai/ai-providers.ts)）。
- **MCP**：56 工具全量覆盖，让外部 Claude/Cursor 反向编排平台。
- **多用户底座**：JWT + TOTP + API Key + 项目角色（ProjectRole / hasProjectRole / assertCanWriteProjectAware）+ 项目上下文切换（[MainLayout.tsx](../../apps/admin-web/src/layouts/MainLayout.tsx)）。

### 1.2 为什么受众窄（根因不是功能少）

现状两个客户端的**用户心智**都是「我是这台自动化机器的管理员」：

| 客户端 | 技术栈 | 页面/能力 | 面向谁 | 缺口 |
|---|---|---|---|---|
| admin-web | React + AntD | dashboard / tasks / executions / executors / applications / registry / users / projects / audit / settings / sops / agent-sessions / sop-from-video | 开发者 + 运维 | 全是「运行时对象」；业务人员进来先看到 cron、executor UUID、glue source、审批单，没有一个「说清我要什么 → 拿到结果」的入口。 |
| executor-desktop | Electron 45 + React19 | wizard / config / status / history / apps（[ConfigPage.tsx](../../apps/executor-desktop/src/renderer/pages/ConfigPage.tsx)） | 装执行器的人 | 是**执行器配置台**，不是 agent 工作台；没有会话、没有工具过程展示、没有计划/审批 UX。 |

**根因三条**：

1. **入口错位**：能力都有，但暴露成「管理对象」而非「使用入口」。业务人员要的是「帮我把这个月的对账跑出来」，不是「新建一个 cron 任务并选 executor」。
2. **skill 太薄**：现有 skill 只有 1 份（python-task-package）+ 5 个官方任务模板，本质是「给 AI 编码助手的可复用任务规范」（[docs/skills/README.md](../skills/README.md)），不是可被业务人员发现、挂载、运行的能力单元。没有市场、没有 per-agent 挂载、没有可见性/审计。
3. **治理粒度停留在系统级**：provider 是全局注册表 + ADMIN-only；项目角色管的是任务/执行器写权限。**没有「能力（skill/MCP/模型）按项目/个人下发、覆盖、收回」的配置层**，所以「中台提供 / 自行配置 / 中台管控」今天只能靠「管理员手工改全局配置」近似实现。

### 1.3 与参考项目的能力差距盘点

| 维度 | AutoCodeFlow 现状 | Octop | ZCode | opencode | magpie/dsh |
|---|---|---|---|---|---|
| 工作台会话 UX | 无（agent-sessions 是运营接管台，非对话） | ✅ chatStore 分片/续连/折叠工具块 | ✅ 多窗格 workbench + DiffViewer | ✅ part 判别联合 + permission dock | ✅ 会话日志/session 树 |
| HITL 审批 | ✅ 强（四眼/指纹/digest）但无前端卡 | ✅ HitlApprovalCard + 短语/TTL | ✅ Plan 意图级授权 | ✅ allow/deny/ask + policy | ✅ sandbox/mode 即时生效 |
| Skill 体系 | ⚠️ 1 份规范 + 5 模板 | ✅ 包 + SkillHub 市场 + per-agent 挂载 | ✅ SKILL.md frontmatter + 审计 | ✅ global/project 双 scope + catalog | ✅ marketplace + autoUpdate |
| MCP 治理 | ⚠️ 我方是「对外提供 MCP」，缺「对内配置 MCP」 | ✅ 统一 spec + visibility + OAuth | ✅ mcp__ 命名空间 + 待审 | ✅ 4 级 scope + 同名整替换 | ✅ mcp: 来源 + RPC 隔离 |
| 模型/渠道 | ✅ registry + 路由；⚠️ 无配额/failover/归属 | ✅ per-agent + 全局 provider | ⚠️ 单一 glm | ✅ provider/model#variant + 自定义 | ✅ 网关互译 + failover |
| 配置作用域 | ⚠️ 全局 + 项目（任务维度） | ✅ owner/all/groups + RBAC | ✅ user/workspace | ✅ system>global>project>.opencode + policy | ✅ shared/user + base/patch/dump |
| 多租户 | ⚠️ Project 近似，无显式 tenant | ❌ 未见 | ❌ 未见 | ❌ 未见（Console 有） | ❌ 未见 |
| 桌面形态 | ✅ Electron 执行器（配置台） | ✅ 薄壳（sidecar/WS/设备凭证） | ✅ 三端同构 | ✅ TUI+Desktop+Web 共享 server | ✅ 菜单栏宿主 |

**读法**：差距集中在「工作台 UX」「能力治理层」「配置作用域」三块；**执行/审批/审计不止不差，反而领先**。这是「补上层、不动底座」的直接依据。

---

## 2. 参考项目提炼：6 条设计原则

1. **薄壳客户端 + 共享 server**（Octop / ZCode / opencode 一致）：桌面只管生命周期/窗口/凭证，业务逻辑在后端。→ 工作台先做 Web，桌面壳后补，避免多端逻辑分叉。
2. **配置即声明 + 确定性作用域链**（opencode 的 `system > global > project > .opencode`，每类字段公开合并规则；dsh 的 base/patch/dump-config）：中台下发不可覆盖，项目/个人逐层覆盖。→ 直接支撑「中台提供 / 自行配置 / 中台管控」。
3. **Policy 硬策略与 Permission 软审批分离**（opencode：policy 只收紧、managed 最高、硬 deny 覆盖 "allow always"）：业务能申请，中台能一票否决。→ 复用我方四眼原则，往上加「策略不可被下层撤销」。
4. **扩展即带 frontmatter 的 Markdown / manifest**（ZCode `plugin.json`、opencode SKILL.md、magpie marketplace）：skill/agent/mcp/hook/provider 用统一清单声明，进入市场/审计。→ 把现有 5 个任务模板升级为 Capability。
5. **会话状态在服务端分片，工具过程结构化**（Octop chatStore 按 sessionId、opencode Part 判别联合、ZCode Checkpoint/rewind）：组件重挂不丢、可回退、过程可折叠渲染。→ 现有 SOP 会话数据结构要升级为「消息+Part」模型。
6. **能力注册即可逆**（dsh 三角色 seam / magpie 进程外 host + slots/streams 限流）：插件启停不留残留、崩溃不拖垮宿主。→ 长期做进程隔离，短期先做「启用/停用 + 审计」。

**反方检查（这些不照抄）**：
- 多租户：四个项目都没有显式 tenant，说明「先做 Project 作用域」是对的，**不要为工作台单独造 tenant 模型**。
- 通用 workflow DSL：Octop 明确未见；ZCode 的 dynamic-workflow 很重。我方 SOP 已是「目标+验收」契约，够用，**不要引入第二套工作流语言**。
- 进程外插件隔离：magpie 的 Bun host 是为「第三方可执行插件」设计的；我方能力目前是一等代码，**P4 之前不做进程隔离**。

---

## 3. 战略定位与目标用户

### 3.1 一句话新定位

> **AutoCodeFlow = 自托管的「企业 Agent 工作台 + 可审计执行底座」**
> 业务人员在 Workbench 里用自然语言/能力卡片拿业务结果；开发者继续用 SOP/脚本/SDK 做确定性自动化；
> 中台在 Control 里统一配置、下发、审计全部能力。**三者共用同一张执行底座。**

与现有定位（"The open-source automation runtime"）的关系：不是替换，是**在底座上加一层面向人的界面与治理**，并把"runtime"从卖点变成一个可信的底座事实。

### 3.2 三类角色画像

| 角色 | 诉求 | 入口 | 看到的 | 权限 |
|---|---|---|---|---|
| **业务人员**（财务/运营/HR/销售运营） | 不写脚本、不懂 cron，把重复工作交给 agent 并拿到可交付结果 | Workbench（Web 优先） | 能力卡片库、我的会话、待我审批、我的交付物 | 使用已授权能力、在允许范围内自建、提交审批 |
| **开发者/自动化工程师** | 确定性任务、SOP、SDK 集成、调试 | admin-web + CLI/MCP/SDK + Workbench 高级模式 | 现有全部 + 能力开发/发布 | 创建能力、管理员审批/发布 |
| **中台管理员**（IT/平台/安全） | 统一配置模型渠道、管控 skill/MCP 可用范围、审计 | admin-web「管控」分区 | 能力注册表、作用域下发、策略、用量/审计 | 最高；可设不可覆盖的硬策略 |

### 3.3 产品形态：三端一号

```text
                    ┌─────────────── 业务人员 ───────────────┐
                    │  Workbench（Web 优先，桌面壳可选）        │
                    │  会话 / 能力卡片 / 工具过程 / 审批 / 交付物 │
                    └───────────────┬───────────────────────┘
                                    │ 统一 API（会话/能力/审批）
 ┌──────────────────────────────────┼──────────────────────────────────┐
 │  Control（admin-web 增强）         │  Control = 中台管控台               │
 │  能力注册表 · Scope 下发 · Policy · 模型渠道 · 用量审计                  │
 └──────────────────────────────────┼──────────────────────────────────┘
                                    │
 ┌──────────────────────────────────▼──────────────────────────────────▼─┐
 │  执行底座（保持不变）：Scheduler · SOP/AgentHost · 审批 · 审计            │
 │  Executor(Node/Python/Desktop)：配置/状态/历史/应用（保留原有设计）       │
 │  MCP Server 56 工具 · AI Provider 注册表 · 产物/日志存储                 │
 └──────────────────────────────────────────────────────────────────────┘
```

**关键判断（回应你的原始设想）**：你说"把客户端单独改造为 agent 工作台，但保留执行器原有功能"。
我建议**不要把工作台做进 executor-desktop**，理由：

1. 执行器是**基础设施**，业务人员不该接触它的安装/配置；把它变成业务入口，等于把桌面权限面放大给全员。
2. Octop/ZCode 的桌面端都是**薄壳**，业务在 Web/共享 server 上；这已被两个成熟项目验证。
3. 保留执行器原有设计的最佳方式，就是**让它继续只做执行器**，工作台作为独立客户端通过 API 消费它。
4. 若确实需要本地桌面工作台（离线/内网强需求），做成**桌面壳包 Web Workbench**，不是改造执行器本身。

---

## 4. 目标架构：统一 Capability 模型 + Scope 治理

### 4.1 核心抽象：Capability（能力）

把今天散落的 skill / MCP server / agent 模板 / 模型渠道 / 任务模板，统一成一种可注册、可挂载、可审计的 **Capability**。

```yaml
# capability.yaml（声明式，与 opencode/ZCode/magpie 同范式）
id: finance.reconcile.monthly
kind: skill            # skill | mcp | agent | provider | template
version: 1.2.0
label: 月度对账
description: 读取内网账单系统并生成对账表
source: { type: git, url: ..., ref: v1.2.0 }   # 或 builtin / registry / folder
entrypoints: [SKILL.md]                         # 复用现有 manifest 越界守卫
requires:
  capabilities: [finance.erp.readonly]
  providers: [qwen-vl]
permissions:                                   # 该能力声明所需权限
  tools: [http.get, filesystem.read]
  approval: write_requires_approval             # 与现有策略键对齐
visibility: project                            # global | project | private
scope:                                         # 作用域默认值，可被上层 policy 覆盖
  default_mode: supervised                     # managed | self_service | supervised
```

- **复用**现有 `docs/skills/registry.json` + `check-template-manifest.mjs` 的封闭键集合与越界守卫（[manifest-contract.md](../skills/manifest-contract.md)），扩展 kind/scope 字段，**不新起一套 schema**。
- **复用**现有 provider `AiProviderEntry`（id/label/transport/baseUrl/model/...）作为 `kind: provider` 的条目来源。

### 4.2 Scope 作用域链（借鉴 opencode + dsh）

> **v2 修订（6 agent 交叉评审 P0）**：合并规则**不是**一句"列表追加"。opencode 实测：permission/skill/plugin 追加，但 command 同名替换、MCP server 同名**整对象替换**（`mcp-servers.mdx:63`）；dsh patch 按 id 整替换（`architecture.zh.md:25`）。逐字段族规则见 §12.2。`managed` 不可覆盖**不靠 locked 标记**（opencode `config.mdx:60-64` 明说设置挡不住用户新增），靠 **managed policy 名单 + 引擎不可 disable**。

```text
中台 managed（硬策略名单，不靠 locked 标记）
   ↓ 覆盖（逐字段族：标量替换 / map 按 key / 列表追加 / 同名整替换 / policy 只收紧）
项目 project（项目管理员可覆盖大部分字段，不能推翻 managed 策略）
   ↓ 覆盖
个人 private（业务人员自建/收藏，落在允许范围内）
   ↓ 合并结果 + dump-config（分层来源 / 生效值 / 凭据占位符 三栏，见 dsh dump-config.ts:45-75）
```

三档治理模式由此自然表达，正是你说的"中台提供 / 自行配置 / 中台查看管控"。

> **命名收敛（P0）**：治理档位（`scope.mode`）与引导强度（`guidance.level`，见 GCO 文档 §3）是**正交两轴**，不是同一事物两面。合法组合：`managed ⇒ guidance ≤ L2`、`危险能力/模型渠道 ⇒ L1`；默认 **治理 Supervised + 引导 L2**。

| 档位 | 中台 | 项目/个人 | 实现（修订） |
|---|---|---|---|
| **Managed 中台统管** | 配置并锁定 | 只读可用 | managed policy 名单 + 策略引擎不可 disable（非 scope.locked） |
| **Self-service 自行配置** | 设边界（白名单/硬策略） | 自行增删 | 下层可写，Policy 兜底 |
| **Supervised 中台可见可收回** | 可见、可审计、可一键停用 | 可自建 | 写操作进审计，中台有 revoke 权 |

### 4.3 与现有模块的映射

| 新增/改造 | 复用现有 | 新增 |
|---|---|---|
| 能力注册表 | manifest 守卫、provider 注册表、task-template | capability 表 + CRUD API + 启动时加载 |
| Scope/Policy | ProjectRole + JWT/ADMIN 判定 + 审批策略指纹 + SEC-02 密钥信封 | scope 表 + policy 引擎 + dump-config |
| Workbench 会话 | SOP session、agent event projection、审批单、产物 | 消息+Part 数据模型 + 会话 API + Web 前端 |
| 工具过程展示 | 56 MCP 工具的事件流、审批 preview | 结构化 Part 渲染 + 折叠 + Plan 卡片 |
| 模型渠道 | ai-providers（路由/信封/ADMIN-only） | 配额/用量归属/failover（P4） |
| 中台管控台 | admin-web settings/users/projects/audit | 「管控」分区：能力/作用域/策略/用量 |

---

## 5. 需要你拍板的关键决策

> 这四条决定后续工作量和形态，建议先定再排期。每条我给了推荐值和理由。

**决策 A：工作台主形态**
- 推荐：**Web 优先**（浏览器即用、零安装，最贴合业务人员；桌面壳 P3 后补）。
- 备选：桌面优先（适合"内网无 Web 入口"场景，但要复制 Octop 薄壳 + 设备凭证，工期 +1 阶段）。
- 判断依据：你的目标是"业务人员也能使用"→ Web 的触达成本最低。

**决策 B：默认治理档位**
- 推荐：**Supervised（中台可见可收回）为默认**（v2 修订：默认引导强度同步为 **L2**，不再是最初的 L1；L1 等价于 Managed，与 Supervised 冲突）。Managed 用于模型渠道/危险工具，Self-service 用于只读能力。
- 理由：既给业务自主性，又保住中台兜底；与四眼原则一致。

**决策 C：配置存储**
- 推荐：**DB 为主 + 文件导出/导入**（能力清单、Scope、Policy 落 DB 便于中台管控与审计；提供 `dump-config` 导出 YAML 供版本化/灾备）。
- 备选：纯文件（opencode 范式，运维友好但中台管控弱）。
- 理由：你要"中台管控"，DB 是必要条件；文件作为可审计快照补充。

**决策 D：模型渠道**
- 推荐：**扩展现有 provider 注册表**，加配额/用量归属/简单 failover；**不做**独立模型网关（magpie 那种协议互译）。
- 理由：现有已支持 OpenAI 兼容/Ollama/自定义 baseUrl + 三用途路由；网关是为"共享订阅/跨协议"设计的，需求未出现。

---

## 6. 分阶段路线图

> 每阶段有**退出条件**；沿用本仓四级验收口径（静态 < 单测 < 真进程内集成 < 浏览器/真机）。

### P0 — 契约与决策（1 周）
- 拍板 §5 四个决策；写 ADR（Capability 模型 / Scope 链 / 三端职责）。
- 定稿 `capability.yaml` schema（扩展现有 manifest 契约）+ 三档治理语义。
- **退出条件**：ADR 合入 + schema 守则有 selftest + 反方评审记录。

### P1 — 能力注册表（2-3 周）
-  capability 表 + 迁移 + CRUD API + 启动时加载与校验；复用 manifest 越界守卫。
- 把 5 个官方模板 + python-task-package 登记为首批 capability；provider 注册表接入。
- Scope 链解析 + dump-config 导出。
- **退出条件**：真库 CRUD roundtrip + scope 合并 selftest + 现有 `check:template-manifest` 全绿；**验收：真进程内集成**。

### P2 — 工作台 MVP（3-4 周，最关键）
- 会话 API（消息+Part 模型，复用 SOP session）+ 能力卡片库 + 我的会话 + 待我审批 + 交付物。
- 工具过程结构化渲染（折叠/Plan 卡片/审批卡，借鉴 Octop HitlApprovalCard + ZCode DiffViewer）。
- Web 前端（复用 admin-web 工程或独立 Vite，见 §5-A）。
- **退出条件**：真浏览器 + 真后端 e2e：业务人员「选能力→填参数→审批→执行→拿到交付物」全链；**验收：浏览器/真机（最高级）**。

### P3 — 中台管控三档（2-3 周）
- admin-web「管控」分区：能力注册表 UI、Scope 下发、Policy 编辑、用量/审计看板。
- Managed 锁定 + Supervised revoke + Self-service 白名单；策略变更使存量授权失效（复用审批策略指纹）。
- **退出条件**：真库验证三档行为差异 + 反证（下层覆盖 managed 被拒）；**验收：真进程内集成 + 真浏览器**。

### P4 — 生态与规模（按需触发）
- 能力市场（私有 registry / 官方源，借鉴 SkillHub）+ 进程外插件隔离（magpie host）+ 模型 failover + 桌面壳。
- **触发条件**：P2/P3 有真实用户与能力数量（>20 capability）后再做，避免空转。

---

## 7. 详细改造清单（按模块）

### 7.1 能力注册表
- 新增 `capabilities` 表（id/kind/version/source/manifest/enabled/visibility/scope/created_by）。
- API：`GET/POST /capabilities`、`/:id/enable|disable`、`/resolve`（返回合并后运行时配置）、`/dump`。
- 复用：`check-template-manifest.mjs` 的 `validateManifest` + `SKILLS_REL` 封闭键；source 越界即拒。

### 7.2 Scope / Policy 引擎
- `capability_scopes` 表（global/project/private × capability × 覆盖字段 + locked）。
- Policy 规则：`deny` > `managed-locked` > `project` > `private`；last-match-wins 或显式优先级（对齐 opencode）。
- 策略指纹复用 `APPROVAL_POLICY_FINGERPRINT_KEYS` 模式：策略变更 → 存量会话授权重算。
- 密钥走 SEC-02 信封（[ADR-028]），不新增明文落库。

### 7.3 Workbench 会话与 Part 模型
- 新增 `workbench_sessions` / `workbench_parts`（借鉴 opencode Part 判别联合：text/tool/step/plan/artifact/approval/reasoning）。
- 会话状态服务端分片，重连不丢（借鉴 Octop chatStore）。
- Checkpoint/rewind（借鉴 ZCode）：按 generation 隔离，先做 SOP 级回退，不做全分支。

### 7.4 工具过程与审批 UX
- 工具调用渲染为可折叠块 + 状态徽标；审批卡展示 `argsDigest/preview`（已有数据）+ allow/allow-all/deny。
- Plan 模式：执行前展示计划文本 + 所需权限（借鉴 ZCode `allowedPrompts`），复用现有审批四眼。
- Diff/产物展示：复用 ZCode DiffViewer 思路，先做产物预览，暂不引入其依赖。

### 7.5 模型渠道治理
- 扩展 `AiProviderEntry`：+ `quota`/`usedToday`/`ownerProject`/`failoverTo`。
- 用途路由（analysis/agent/video）已有；加"按项目选 provider"覆盖全局默认。
- 用量归属到会话/项目，供中台看板。

### 7.6 中台管控台
- admin-web 新增「管控」菜单组：能力注册表、作用域下发、策略、模型渠道、用量审计。
- 所有写操作进审计日志（复用现有 audit module）。

### 7.7 执行器保持原样
- executor-desktop 的 wizard/config/status/history/apps 四页**不改**；Workbench 通过 API 消费执行底座。
- 仅需为 Workbench 暴露必要的只读执行器状态接口（已有 `/executors`、`runtime-config`）。

---

## 8. 数据模型与接口增量（汇总）

| 层 | 新增表 | 新增 API | 复用 |
|---|---|---|---|
| 能力 | capabilities / capability_scopes | /capabilities (+resolve/dump) | manifest 守卫、provider 注册表 |
| 会话 | workbench_sessions / parts / checkpoints | /workbench/sessions, /parts, /:id/rewind | SOP session、event projection |
| 审批 | （复用 agent_approvals） | /workbench/approvals/:id/decide | 四眼、指纹、digest |
| 治理 | （复用 audit / users / projects） | /admin/capabilities/scope, /admin/policies | ProjectRole、audit、SEC-02 |

---

## 9. 风险、代价与明确不做

### 9.1 主要风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 工作台塞进执行器（架构回退） | 执行器升级即中断业务、桌面权限面扩大 | 三端职责写进 ADR；工作台独立客户端；执行器保持基础设施 |
| 作用域链合并规则歧义 | 中台以为锁住了、实际被覆盖 → 越权 | 每类字段公开合并规则 + selftest + dump-config 可审计 + 反证测试 |
| 能力供应链（skill/MCP 可注入） | 发布权=指令注入权（已有 SOP 正文扫描先例） | 复用 SOP 正文供应链扫描 + source 签名/哈希 + 默认 warn/block 显式开 |
| 上下文/成本失控 | 工作台会话多、工具多 → token 爆炸 | 工具过程折叠 + 摘要可回读（已修过 toolCallId）+ 预算终态 |
| 业务人员误操作 | 危险工具被直接调用 | Supervised 默认 + 危险工具 managed-locked + 四眼审批 |
| 多端逻辑分叉 | Web/桌面行为不一致 | 薄壳 + 共享 server，协议生成类型（opencode 范式） |

### 9.2 明确不做（本轮）

- 不做显式 tenant 模型（四参考项目都没有；Project 作用域够用）。
- 不引入第二套 workflow DSL（SOP 已够）。
- 不做 P4 之前的进程外插件隔离（需求未到）。
- 不做独立模型网关（扩展 provider 注册表即可）。
- 不改造 executor-desktop 的现有四页（保留执行器设计是硬约束）。
- 不在本轮做 i18n 全量/覆盖率棘轮/微基准（ ROADMAP 已归维护预算）。

### 9.3 代价估计（相对）

P1≈中、P2≈高（前端+会话模型，是主投入）、P3≈中、P4≈按需。
主要成本在 P2 的「会话+Part 模型 + Web 前端 + e2e」，其余多为现有模块的扩展。

---

## 10. 验收口径（不许越级上报）

| 阶段 | 最低验收 | 目标验收 | 断言的实际副作用 |
|---|---|---|---|
| P0 | 静态 | 静态 + 反方评审 | ADR 合入、schema 守卫 selftest 通过 |
| P1 | 单测 | 真进程内集成（真 PG） | capability 行 CRUD、scope 合并结果、dump 内容 |
| P2 | 真进程内集成 | **真浏览器 + 真后端 e2e** | 会话落行、审批状态、交付物生成；非 mock |
| P3 | 真进程内集成 | 真浏览器 | 三档行为差异、managed 覆盖被拒、revoke 生效 |
| P4 | 单测 | 真进程/真机 | 市场安装、隔离崩溃不影响宿主、failover 切换 |

"接口返回 200"不是验收结论；必须断言实际副作用（新建了哪些行、能力是否生效、审批状态、交付物）。

---

## 11. 参考证据索引

**本仓现状**（均经 CodeGraph explore 实测）
- 客户端/执行器：`apps/executor-desktop/src/main/index.ts`、`apps/executor-desktop/src/renderer/pages/`
- 导航/菜单：`apps/admin-web/src/layouts/MainLayout.tsx:162-214`
- AI provider：`apps/admin-api/src/modules/ai/ai-providers.ts:33-140`
- 审批策略：`apps/admin-api/src/modules/agent/runtime/agent-approvals.service.ts:52-63`
- 项目角色：`apps/admin-api/src/modules/project/project-access.service.ts`
- skill/template：`docs/skills/README.md`、`scripts/check-template-manifest.mjs:105-119`
- 状态/路线图：`docs/PROJECT-STATUS.md`、`docs/ROADMAP.md`

**参考项目**（4 路子 agent 深挖，CodeGraph + README/DESIGN 双证）
- Octop：`README_CN.md`、`dashboard/src/pages/Control/Workbench/index.tsx`、`infra/gateway/hitl/`
- ZCode：`DESIGN.md:28`、`packages/ui/…/V4WorkspaceChatArea.tsx`、`contracts/src/tools/plan-mode.ts`、`CONTEXT.md:73-75`
- opencode：`packages/schema/…/session.ts`、`packages/*/docs/*/config/permissions/policies/skills.mdx`、`AGENTS.md:2`
- magpie：`internal/plugin/*`、`internal/library/claude_plugins.go`、`README.md`
- deepseek-harness(dsh)：`docs/…/architecture.zh.md`（本仓无该外部文档，按省略号约定标注出处）、`AGENTS.md:135-145`、`packages/mcp-server/src/tools.ts`（本仓对应 MCP 工具注册落点）

---

## 12. 六 agent 交叉评审：裁决与新增开发目标（v2，2026-11-26）

> 本节是两份方案（strategy + GCO）经 6 路 agent（octop/zcode/opencode/magpie+harness/企业落地biz/反方red）**互相发消息、反驳、认账**后的收敛结果。六方对各自质疑均已认账，无未决分歧。分两部分：**A 硬伤修正（已回写正文）**、**B 新增开发目标（纳入后续排期）**。

### 12.1 裁决原则

- 红队的实证质疑优先于初稿措辞；凡"复用现成"必须核实签名与语义是否真匹配。
- 两处**命名/机制硬伤**已在正文修正：①治理档位 × 引导强度正交（§4.2 / GCO §3）；②合并规则逐字段族披露、`managed` 靠策略不靠 locked（§4.2）。
- 被推翻的初稿结论照实记录，避免后续读者踩回同一个坑。

### 12.2 硬伤修正清单（P0 必改，已回写）

| # | 初稿问题 | 实证 | 修正 |
|---|---|---|---|
| H1 | 治理档位与引导强度称"同一事物两面"，且出现三套命名（managed/self_service/supervised、L1/L2/L3、managed/guided/author）；GCO 默认 L1 ≡ 治理 Managed，与 Supervised 默认冲突 | opencode `permission/policy.ts:28-37,50-72`；red V2 | 拆为 `scope.mode × guidance.level` 正交二维；合法组合 `managed⇒L≤2`、危险能力⇒L1；默认 **Supervised + L2**；删"两面"表述 |
| H2 | Scope 链写"列表追加"，会踩同名整替换的坑 | opencode `mcp-servers.mdx:63`、`commands.mdx:246`；dsh `architecture.zh.md:25` | 逐字段族披露合并规则 + selftest 反证；见下表 |
| H3 | `managed` 靠 `scope.locked` 标记 | opencode `config.mdx:60-64`（设置挡不住用户新增） | 改为 managed policy 名单 + 策略引擎不可 disable |
| H4 | 指纹键集只有 4 键，档位收回/scope 变更不在其中，无法支撑"收回后存量方案卡失效" | red V3：`agent-approvals.service.ts:48,811`（明确排除 blockSelfApproval） | 方案卡自带 scope/guidance 版本号，消费时比对；扩指纹键集属**新增工作**、非复用 |
| H5 | 复用声明三处踩空：`toolsForSessionKind` 是静态 kind×phase 白名单且 chat 不限工具；`sop.draft()` 写的是 SOP 行不是方案卡；`chatJson` 在 executor-desktop 且未 export | red V4：`tool-registry.ts:1455`、`agent-boundary-check.mjs:782`、`sop.service.ts:207`、`runtime.ts:243` | 只能在签名层借鉴，机制需重写；新增"业务会话 kind"必须 fail-closed 并进 tripwire |

**逐字段族合并规则（H2 落地，引用 opencode `config.mdx:79-110`）**

| 字段族 | 合并规则 | 反证用例 |
|---|---|---|
| 标量（timeout/maxTokens） | 下层同名替换 | 项目改超时后生效 |
| map（provider 条目） | 按 key 合并 | 项目只改一个 provider 不影响其他 |
| permission / skill / plugin | 追加 | 项目新增 skill 不覆盖中台 skill |
| command / MCP server（同名） | **整对象替换** | 项目同名 MCP 必须完全覆盖，不残留中台字段 |
| policy 规则 | 只收紧（restrict 单调 deny 不可撤销，opencode `policy.ts:58-72`） | 项目 policy 不能放行中台 deny |
| 无规则命中 | 默认 `ask`（opencode `policy.ts:103-104`、Octop `hitlSessionPolicy.ts:9`） | fail-closed，不放行 |

### 12.3 新增开发目标（纳入 P1–P4 排期）

> 每条标注来源 agent 与优先级；已按"是否阻塞后续"排序。原始证据见各 agent 定稿消息，本文只留落点。

**A. P0/P1 — 架构与数据模型（阻塞后续，必须先做）**

| 目标 | 说明 | 来源 | 状态 |
|---|---|---|---|
| N1 外部 agent 旁路接入 | 不改 agent 内核，只原子改写其配置一个 key，中台下发 baseUrl/key 指针，让 Claude Code/Cursor/Codex 原样接入；**Workbench 是第三入口，不是替换**，不把"迁移到 Workbench"设为前置（与现有 56 工具 MCP 反向编排旁路并存） | magpie/zcode | ⬜ 未实现：无中台下发 baseUrl/key 指针改写外部 agent 配置的旁路代码 |
| N2 合并规则 + dump 三栏 | capability resolve 按 §12.2 逐族合并；dump 输出「分层来源/生效值/凭据占位符」三栏，不泄露明文（dsh `dump-config.ts:45-75`） | opencode/magpie | ✅ 已实现（第 3 轮）：scope 逐族合并 + resolve/dump 三栏脱敏（capability/scope/ 与 /capabilities/resolve、dump） |
| N3 Policy 四语义层 | `override/restrict/fallback/rules` + 无规则默认 ask + 多资源 any-deny 聚合（opencode `policy.ts:28-37,103-104,166-171`） | opencode | ✅ 已实现（第 52 轮）：`scope-engine.ts` 新增 `evaluateAll`/`evaluateSemanticPolicy` + `PolicySemantic` 四语义（override/restrict/fallback/rules，restrict 的 deny 单调锁定），空/非法输入默认 ask；旧 `evaluatePolicy`/`aggregateDecisions` 签名行为逐字不变；scope 2 suites/28 tests 绿、反证有牙。未接入 capability.service 真实链（纯函数层）。 |
| N4 最小可验证切片（V5） | **P2 前置证伪闸门，2 周**：只选 1 个已有只读能力 + 用现有 SOP draft/publish 承载方案卡 + 现有四眼/digest 确认 + 一页前端（3 业务字段→预览→审批→看产物），真浏览器 e2e 断言"不填 cron/UUID/glue 拿到报表"。不通则后续全白做——**暂不建注册表/Scope 链/Part 模型/编译 prompt/三档** | red | ✅ 已实现（第 1 轮）：preview-validator + 真浏览器 workbench-preview e2e 已落地 |
| N5 业务结果归因埋点 | capability/session 表加 outcome 字段：基线对照 + 人时节省 + 差错率，做启用组 vs 对照组归因；事后补不出基线 | biz | ✅ 已实现（第 53 轮复核）：迁移 106 加 `baselineMetric`/`improvement`/`confirmed` 三列（存量 NULL 不回填），`capability-activation.service.record` 写入 + `query` 的 `outcome` 过滤（与 result 正交），真 PG 数据层验证 PASS=37（第 12 轮）。未做：人时节省的自动化采集（需业务样本）。 |

**B. P2 — 工作台与引导链**

| 目标 | 说明 | 来源 | 状态 |
|---|---|---|---|
| N6 IM 一等入口（带前置） | Intake 增 IM adapter（企微/飞书，业务真实驻留地），验收旅程改"企微@→方案卡→审批→交付"；**前置两条**：IM identity→ProjectRole 映射 + 群聊 prompt injection 防护（否则绕过四眼）；身份走 Gateway sender 验证绑定平台 user（非设备凭证），审计记 platform id + IM id 双字段。审核 SLA ≤1 工作日 | octop/biz/red | 🟡 部分实现（第 21 轮）：身份映射/注入防护/Intake 编排已实现，真实企微/飞书 webhook adapter 缺 |
| N7 编译期反幻觉闸门 | 方案卡落库前确定性校验：能力 id 存在性、cron 可回读成业务语句、预算≤中台上限、scope 可解析；失败转澄清不进审批（比"人确认"可靠）。高危字段强制展开不可折叠；确认留痕=方案卡版本 hash + 确认人 + 摘要 | red/biz | ✅ 已实现（第 1 轮）：buildPreview checks/eligible + commit cardHash 防篡改校验已落地 |
| N8 会话 park/drain + blocked 可见面 | 审批期 steer 入 inbox → 模型步边界 drain（Octop `steer/coordinator.py:624-756`、opencode `run-coordinator.ts:146-186`）；`pendingWake` 不复活死意图；补 blocked 看板（本仓 blocked 被超时扫描豁免、无可见面） | octop/opencode/red | 🟡 部分实现（第 54 轮）：`agent/runtime/steer-inbox.ts` 纯状态机落地（park/drain 步边界/pendingWake 不复活死意图），21 例 + 双向反证有牙。未做：接入 agent runtime 真实循环、blocked 可见面看板。 |
| N9 无 API 场景一等降级 | 能力发现加可达性探测；内网 ERP 多为 GUI/导出，降级到 **executor-desktop X11 GUI 驱动 + fromVideo 录屏**——这是 n8n/Dify 抄不走的护城河，初稿把它埋在 B 类低估了。首个 e2e 用已有 API/已就绪文件数据源，不用幽灵能力 `finance.erp.readonly` | red/biz | ⬜ 未实现：无能力发现可达性探测与「无 API→X11 GUI + fromVideo」降级编排 |
| N10 Part 模型扩类 + share | 从 6 类扩到 opencode 12 类（agent/subtask/compaction/snapshot/patch 等，`v1/session.ts:357-383`）；会话级 share（`SessionInfo.share`）；大字段入 blob | opencode | ⬜ 未实现：无 12 类 Part 模型、会话级 share 与大字段入 blob |
| N11 Plan 做成 agent 身份 | 不是 UX 折叠开关：ZCode `enterPlanMode` 换 MemoryFileSystem+PermissionService（`plan-mode.ts:106-113`）、opencode plan 是 primary agent；allowedPrompts 是意图/类别级请求，方案卡一次批准=一次 SOP 发布 scope=once | opencode/zcode | ⬜ 未实现：无换 MemoryFileSystem + PermissionService 的 plan agent 身份与 allowedPrompts |
| N12 上下文成本（P2 必做） | 默认最小工具集 + 按 kind 收窄 + 输出预算（opencode `tool.ts:426-437`、`config.mdx:306-317`）；ToolSearch 式按需检索留 P4 | zcode/opencode | ⬜ 未实现：底座有 toolsForSessionKind/agent-budget，但工作台编译链未接最小工具集与输出预算 |
| N13 provider 黑白名单 | provider 级硬策略 + 模型 enabled 位 + 模型级白名单（ZCode `legacyZCodeConfigProviderReader.ts:109-138`）；凭据走 `{env:NAME}` 占位（`mcp-servers.mdx:125`）；variant 承载 reasoningEffort，方案卡存 `provider/model#variant` | zcode/opencode | 🟡 部分实现（第 52 轮）：`AiService.routeFor` 接入 `isModelAllowed`（黑名单/白名单/modelEnabled 命中即 fail-closed 抛 `AI_PROVIDER_INVALID`，不回落、override 同检），ai 20 suites/283 tests 绿、反证有牙。未做：模型 variant、`{env:NAME}` 凭据占位。 |

**C. P3 — 治理、审计、归责**

| 目标 | 说明 | 来源 | 状态 |
|---|---|---|---|
| N14 在途策略即时失效 | `capability/changed` → interrupt 在途 + 下次工具 check 用新 policy + scopedRules 保住未被通配覆盖的 ask/deny（opencode `session.ts:86`/`policy.ts:204-240`/`run-coordinator.ts:146-186`；dsh `sandbox/mode` `policy-processes.ts:24-34`）。不接此条则"引导在权限框架内"为空 | magpie/opencode/red | 🟡 部分实现（第 52 轮）：运行时代际 + system_configs 持久化 + emit 已落地；本轮补 `workbench/scoped-rules.ts` 纯分类（通配 allow 作废、显式 ask/deny 与作用域不可判定时的 fail-closed 保留），6 例反证有牙。未做：controller/service 实际接线、interrupt 在途工具调用、跨实例 5s TTL 真机。 |
| N15 运行时能力审计 | `capability_activation_log`（session/能力 id/版本/参数摘要/user_id/IM id），与写操作审计并列；企业必问"本月哪个会话用了财务导出" | zcode/biz | ✅ 已实现（第 9 轮）：capability-activation 审计 + 真 PG 数据层验证 + 用量看板已落地 |
| N16 发布背书 + 失败归责 | capability 增 `owner/backer/versionPin/attestation`；版本钉死 + 调用可回放；责任分层定位到能力发布者/编译系统/确认人/中台策略；owner 离职孤儿化 → **部门/角色背书 + 所有权移交是自研必需层**（magpie 的 movers/parity 是宿主对自家插件的内部契约，非通用市场治理，不可照搬） | magpie/biz/red | ✅ 已实现（第 53 轮复核）：迁移 107 加 `owner`/`backer`/`versionPin`/`attestation` 四列（存量 NULL 不回填），`capability.service` 校验 versionPin 形态与封闭键；前端 `CreateCapabilityPayload` 已补四字段。**未做**：所有权移交的流程 UI（[ops-runbook](agent-workbench-ops-runbook.md) §4 有建议流程）、调用可回放的责任分层定位。 |
| N17 审批短语（scoped+TTL） | 只借鉴 Octop"一句话审批"UX，整句精确匹配；授权落 once + TTL + 指纹重算，**不做 all 永久授权**（破坏失效语义）；放 P3 观察期，不进 P2 MVP | octop/red | ✅ 已实现（第 52 轮）：`parseApprovalPhrase` + `decideByPhrase`（once+TTL、无 all、指纹重算）已落地；本轮暴露 ADMIN-only `POST /agent/sessions/:id/approvals/:approvalKey/phrase` 路由，decidedBy/指纹均服务端取值、请求体自报一律忽略，agent 66 suites/1054 tests 绿、反证有牙。HTTP filter 真机未测。 |
| N18 rewind 代际围栏 | 会话/Part 带 generation，回退使旧 generation 的异步写入/通知作废 + 审计"作废 N 任务"（ZCode `branchGeneration` `registry.ts:186-188`）；否则"已撤回对账仍发报表" | zcode/biz | 🟡 部分实现（第 54 轮）：方案卡策略代际 + commit 代际闸已落地；第 53 轮 N10 补 Part generation（12 类 + isStaleGeneration），本轮补 `workbench/rewind-fence.ts` 纯判定（**复用** part-model 的 isStaleGeneration，旧代异步写入作废 + invalidatedCount 审计计数），89 tests 绿、反证 sha 还原。未做：接 controller/真实审计写入/通知作废。 |
| N19 Key 权限分级复用 | 本仓已有 readonly/trigger/manage + revoke（`api-key.util.ts:50-54`）；能力调用走 readonly+trigger scope，revoke 联动能力停用；补 rotate/limit（magpie `access.go:612,641-670`） | magpie | 🟡 部分实现（第 52 轮）：rotate/limit 已落地；本轮补 `capability-scope.gate.ts`（token+纯判定：能力调用需 readonly+trigger 双 scope，manage 全集放行，revoke 联动判定），9 例反证有牙。gate 未接线到 activation.service / revoke（主控接线建议已留），未做真实 HTTP 鉴权链。 |
| N20 成本分摊 + showback | provider 增 showback 计量（token/成功交付双口径）+ 按项目配额 + 软硬阈值告警 + 超支降级（magpie quota/KeySpendCaps） | biz/magpie | 🟡 部分实现（第 18 轮）：调用次数计量/配额/告警/硬阈值 + 前端看板已落地，token 口径与成本分摊因无样本未做 |
| N21 合规基线 | 等保二/三级、日志留存 6 月不可篡改、数据分类分级 + 公有模型出域管控 | biz | ⬜ 文档基线已落（第 24 轮）：[compliance-baseline.md](../compliance-baseline.md) 写明等保二/三级、日志留存 6 月不可篡改、数据分类分级与公有模型出域管控的**目标基线**；系统侧尚无对应强制实现（留存策略/不可篡改存储/出域拦截），是建议基线而非已交付能力。 |
| N22 中台团队与 SLA | 平台工程/能力审核/Agent 训练师/SRE 角色；能力审核 SLA ≤1 工作日，否则业务流失 | biz | ⬜ 建议流程已落（第 24 轮）：[ops-runbook](agent-workbench-ops-runbook.md) 写明四角职责/≤1 工作日审核 SLA/值班四步/所有权移交；仓库当前无中台编制、审核流水线与 SLA 计量实现，是**待建契约**（文档已明示不得当已交付引用）。 |

**D. P4 — 生态与规模**

| 目标 | 说明 | 来源 | 状态 |
|---|---|---|---|
| N23 generation swap 热更新 | capability resolve 老一代继续服务 + 原子切换 disposer + 失败回滚（dsh `mcp-client/src/tools.ts:144-219`）。**Octop 明确不背书**（manifest 重写下一轮生效），标注为 dsh 独有 | magpie | ⬜ 未实现：capability 有 version 但无 generation swap、disposer 原子切换与失败回滚 |
| N24 进程外隔离 + 背压 | 中间形态（P1/P2）：进程内能力权限层 + 预算 + 失败降级（plan agent 只读即范例）；P4 才上 slots/streams 双限流 + 坏版本回退 + 进程外 host（magpie `host.go:455-511,1060-1070`） | magpie/opencode | ⬜ 未实现：能力层无 slots/streams 双限流、坏版本回退与进程外 host |
| N25 marketplace 多源 + autoUpdate | source 五源（npm/git/github/server/mcp:）+ `plugin@marketplace` 启停；autoUpdate 留 P4（Octop 未见） | magpie/octop | ⬜ 未实现：CapabilitySource 仅声明，五源注册/marketplace 启停/autoUpdate 未做 |
| N26 统一 CLI 入口 | 桌面壳沿用同一 CLI 分发 TUI/Web/Agent CLI（ZCode `README.md:93-114`）；桌面壳只做窗口/凭证，Web 内容用现有 renderer webview，**避免重走 ROADMAP:123 桌面 V2 重写** | zcode/red | ⬜ 未实现：桌面壳未做同一 CLI 分发 TUI/Web/Agent CLI |
| N27 ToolSearch 按需检索 | 56 工具按需加载，ZCode 有（`tool/19-tool-search.md:57,576`）、opencode 未见 | zcode | ✅ 已实现（第 52 轮）：`tool_search` 注册为第 57 个 MCP 工具（按关键词/标签检索真实 `_registeredTools`、`readOnlyHint: true`），tool-search 17/17 绿；工具数基线 56→57 已同步（mcp-tool-sources/probe/admin-hints/interface-maps/工具地图），运行时工具面 57/57 绿。SDK 内部字段 `_registeredTools` 为已知耦合点。 |

### 12.4 开源边界校准（P0 决策，推翻初稿措辞）

红队+biz 实证：OIDC SSO（AUTH-04/ADR-014）已随 v1.3.0 发布在开源里；Projects 多租户（AUTH-01）第一批已实现；而 ROADMAP:122 明确"SSO 不做叙事主线"、:90 明确推迟多租户分桶。故"SSO+多租户当企业钩子"是双重错误，校准为：

- **开源核心（护城河全开源）**：执行底座 + 能力注册表 + Workbench + 四眼审批审计 —— 与 §3.1 叙事一致。
- **企业增值**：长期审计留存 / 成本分摊 / 私有化 / 高级合规；**SCIM**（用户生命周期自动化，非 SSO 本身）才是真钩子。
- **tenant 若要做**：必须单独 ADR 说明推翻 §9.2 + ROADMAP:90，不可偷偷塞进企业版。
- **能力市场**：放 P4 开源做生态，不当商业钩子。

### 12.5 红队建设性补充（已吸收）

1. 编译期反幻觉闸门（→ N7）
2. 工作区配置信任审核队列：`pending-review` + bundleDigest/generation 漂移检测。本仓供应链扫描只扫 SOP 正文且 draft 默认 warn（`sop.service.ts:220-221`），能力注册表接 git/manifest 是**安装时注入面**，四眼不覆盖（→ 并入 N16/N15）
3. IM 入口**后置**于身份映射：工作台不替代 IM，把受控执行挂到 IM 后面（→ N6 前置两条）

### 12.6 证据边界声明（防止挂错名）

- Octop **未见**：generation swap / SessionInfo.share / 12 类 Part / autoUpdate —— 这四项分别属 dsh/opencode/magpie，勿挂 Octop。
- magpie 的 movers map / parity 是宿主对**自家官方插件**的内部契约（`magpie AGENTS.md:47,129-130`），非通用市场治理。
- opencode 开源 server 内建多用户与审计表未见（Console 侧文档有 SSO/SCIM）。
- ZCode 的 skill/agent 是 workspace 内敛贡献（`skillsService.ts:840-879`），无外向挂载；故 Workbench 定位第三入口而非替换。
