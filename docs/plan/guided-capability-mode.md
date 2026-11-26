# 引导式能力编排模式（GCO）：让业务人员用上中台全部高级功能

> 受众：产品/架构决策者 · 状态：提案（承接 [agent-workbench-strategy.md](agent-workbench-strategy.md)）· 日期：2026-11-26
> 本文回答一个问题：**能否建立一套模式，引导业务人员也使用中台的所有高级功能？**
> 结论：能，但模式不是"给 admin-web 每个表单加向导"，而是建立一条「意图 → 编译 → 确认 → 受控执行」的引导链。
> 证据来自本仓 CodeGraph 实测 + 四参考项目深挖，关键结论附符号名/文件行号。

---

## 0. 一句话回答与三个判断

> **GCO = 业务人员用业务语言说出目标，系统把目标"编译"成高级功能的正确组合，人在关键节点确认，中台策略全程兜底。**
> 业务人员**调用**所有高级功能的**能力**，而不**操作**它们的**配置项**。

| 判断 | 说明 |
|---|---|
| ①"所有高级功能"≠"所有配置项" | 高级功能分三类：A 类业务人员**直接用**（引导）、B 类**系统代用**（业务人员只见结果）、C 类**中台专属**（中台替业务人员用了）。业务人员享受到的是**全部能力**，不是全部配置界面。 |
| ② 不是让业务人员进 admin-web | admin-web 是运行时对象的管理台；把它加向导，等于把复杂度搬了个家。引导链应该长在**工作台**里，admin-web 保持管理视角。 |
| ③ 引导不是绕过治理 | 引导是在**权限框架内**的 UX：编译出的方案要可读可改、执行要走审批、策略变更要使授权失效。引导只会降低认知门槛，不会降低安全门槛。 |

---

## 1. 为什么"加个向导"不够：业务人员的三个断层

| 断层 | 表现（业务人员看到的中台术语） | 后果 |
|---|---|---|
| **术语断层 Terms** | cron 表达式 / executor UUID / glue source / front-matter / 审批策略指纹 / `transport: openai` | 填不对、不敢填，填错了也看不出 |
| **组合断层 Composition** | "每月对账"实际要组合：任务调度 + SOP 验收 + provider 路由 + 产物归集 + 审批 + 通知 | 业务人员不知道一个目标要串哪几个功能 |
| **风险断层 Risk** | 高级功能被 ADMIN 锁住，正是因为配错代价高（任意代码执行、危险工具、成本失控） | 锁住了配置权，连"用"也被挡在门外 |

**GCO 的设计哲学**：用一层"编译"消解术语断层，用一张"方案卡"消解组合断层，用"人确认 + 中台兜底"消解风险断层。

---

## 2. 模式骨架：四层引导链

```text
   ① 意图采集              ② 方案编译              ③ 渐进确认              ④ 受控执行
   Intake                 Compile                Confirm                Execute
 ┌─────────────┐       ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
 │ 说目标       │ ───▶  │ agent 把目标 │ ───▶  │ 人可读可改的 │ ───▶  │ 沙箱试跑 →   │
 │ 自然语言/    │       │ 编译成高级   │       │ 方案卡 +     │       │ 审批 → 正式  │
 │ 表单/录屏    │       │ 功能组合草稿 │       │ 分层确认     │       │ 执行 → 交付  │
 └─────────────┘       └─────────────┘       └─────────────┘       └─────────────┘
  复用：sop-from-video     复用：chatJson +       复用：draft 草稿态 +    复用：toolsForSessionKind
  录屏→草稿、chatJson      56 MCP 工具编排        PlanReadyCard + 四眼   白名单 + 沙箱 + 预算终态
```

### ① 意图采集（Intake）
业务人员用三种方式之一说出要做什么，系统不要求任何运行时术语：
- **自然语言**："每个月 5 号把销售系统的账单拉出来，和财务系统核对，有差异发邮件给张三"
- **结构化表单**：几个业务字段（做什么 / 多久一次 / 数据源 / 通知谁）
- **录屏演示**：复用现成 `AiSopDraftService.fromVideo`（`ai-sop-draft.service.ts:62,31`）——录一遍操作，系统生成 SOP 草稿

> 现成资产：`sop-from-video` 已是"录屏 → 草稿 → 澄清 → 工具绑定"的完整对话闭环（`sop.service.ts:207` / `AiSopDraftController` `:64`）。GCO 把它的入口从"录屏"扩展到"自然语言/表单"。

### ② 方案编译（Compile）
Agent 把意图编译成一张**高级功能组合方案**。关键设计：**编译产物是人可读、可改的草稿，不是黑盒执行**。
- 编译用现成的 `chatJson` 结构化输出（`runtime.ts:243`，自带失败重试一次）+ 56 个 MCP 工具做编排
- 草稿态复用 `sop.service.ts:207 draft()`：草稿宽松（只挡结构错误、acceptance 可留空），"只记录不阻断"供应链扫描（`sop.service.ts:220-221`）——业务人员能在草稿阶段反复改
- 方案卡内容示例：

```text
方案：月度对账           [编辑] [换一种做法]
├─ 触发器：每月 5 日 09:00        ← cron，但显示成业务语言
├─ 能力：finance.erp.readonly     ← 已授权能力卡片
├─ 验收：差异为 0 或已发通知       ← SOP acceptance
├─ 模型：通义千问（视觉）          ← provider label，不显示 baseUrl/key
├─ 审批：涉及外发，需主管审批      ← 四眼原则
├─ 预算：单次 ≤ 20 轮 / ¥X        ← 成本护栏
└─ 通知：邮件 → 张三              ← 通知渠道
```

### ③ 渐进确认（Confirm）
方案卡分两层披露，避免一上来就压垮业务人员：
- **第一层（业务参数）**：时间、数据源、收件人 —— 必填，业务人员看得懂
- **第二层（高级设置，默认折叠）**：重试、并发、超时、审批策略、provider 细节 —— 想调才展开
- 确认交互复用 Octop `PlanReadyCard` 的"执行 / 继续编辑"双按钮；审批卡展示现成的 `argsDigest`/`preview`（`agent-approvals.service.ts`），治"盲批"
- **业务人员永远只需确认"对不对"，不需要理解"怎么配"**

### ④ 受控执行（Execute）
执行时把高级功能的治理能力全部叠上去：
- 工具白名单：复用 `toolsForSessionKind` + `SESSION_TOOL_ALLOWLIST` / `SESSION_PHASE_TOOL_ALLOWLIST`（`tool-registry.ts:1455`）——按会话类型收窄可用工具
- 沙箱试跑 → 验收 → 正式执行：复用现有 SOP 四道闸
- 策略指纹：审批策略变更使存量授权失效（`agent-approvals.service.ts:52-63`）
- 预算终态 + 折叠摘要可回读（已修过 `toolCallId` 截断），防止 token 失控

---

## 3. 三档引导强度：同一功能，三种带法

> **v2 修订（多 agent 交叉评审 P0 必改）**：治理档位与引导强度是**正交的两轴**，不是本文初稿所说的"同一事物的两面"。治理 = 谁能覆盖配置（权限模型，字段 `scope.mode`）；引导 = 谁编译、披露到什么程度（UX，字段 `guidance.level`）。下文 L1/L2/L3 **仅指 `guidance.level`**，默认 **L2**（不是初稿的 L1——L1 等价于治理 Managed，与 strategy §5-B 的 Supervised 默认冲突）。危险能力与模型渠道强制 L1。合法/非法组合矩阵见 [§11.2](#112-正交矩阵-p0-必改)。

这是 GCO 最重要的一层：**引导强度是可调的**，业务人员随熟练度从"托管"升到"作者"。它与治理档位**独立配置**（两者正交，详见 §11.2），不能相互推导。

| 档位 | 谁编译 | 业务人员做什么 | 高级设置 | 适用 |
|---|---|---|---|---|
| **L1 托管 Copilot** | 系统全自动编译 | 说目标 + 确认方案卡 | 完全折叠，中台预设 | 业务新手、**危险功能、模型渠道（强制）** |
| **L2 引导 Wizard（默认）** | 系统给方案+默认值 | 逐步填业务参数、逐层确认 | 折叠但可展开调 | 常规业务场景 |
| **L3 作者 Author** | 系统只做校验 | 直接配置，像开发者一样用 | 全展开 + 实时校验/文档提示 | 资深业务人员、自动化骨干 |

> 中台可为每类能力、每个项目设默认档位和上限：例如"模型渠道配置"最低 L1（业务人员只在下拉里选 label），"任务调度"允许到 L2，"SOP 正文"允许到 L3。这样"所有高级功能"都能被触达，但触达强度受控。

---

## 4. 完整映射：所有高级功能怎么被引导用上

回答"所有"——把 admin-web 的高级功能逐项映射到 GCO。三类标记：**A=直接用**（引导）、**B=系统代用**（只见结果）、**C=中台专属**（中台替业务人员用了）。

| 中台高级功能（现有导航） | 类别 | 业务人员看到/做什么 | 系统代做什么 | 中台兜底 |
|---|---|---|---|---|
| 任务调度 tasks / 频率 / webhook / DAG | A | "多久跑一次"→自然语言或下拉 | 编译 cron/频率、选执行器 | 危险 source 走审批 |
| 任务模板 task-templates | A | 从能力卡片库选，填 2-3 个业务参数 | 实例化模板、填 glue 默认值 | 模板发布需审核 |
| 执行历史 executions | A | 看"我的任务"状态、日志摘要 | 关联到业务目标而非 run id | 全量审计在中台 |
| 产物 artifacts | A | "我的交付物"下载/预览 | 归集、鉴权 URL | 上传下载鉴权沿用 |
| 执行器 executors / executor-packages | **B** | 只在卡片里看到"在哪台机器跑" | 自动选在线 executor、拉模式 | 应用白名单、心跳 |
| 应用/包 applications / registry | **B** | 不直接接触 | 能力背后自动绑定应用版本 | 版本/回滚归开发者 |
| 部署/版本/回滚 deployments | **C** | 不可见 | — | 中台/开发者专属 |
| SOP sops | A(L2/L3) | 录屏/对话起草 → 方案卡确认 | 编译 front-matter、绑工具、验收 | 正文供应链扫描 |
| Agent 会话 agent-sessions / inbox | A | "待我处理"的澄清/审批 | stalled/escalated 归类 | 人工接管台兜底 |
| 视频转 SOP sop-from-video | A | 录屏 → 草稿（现成） | 多模态理解、结构化 | 草稿态宽松、发布态严格 |
| AI 模型渠道 settings/AiProviders | **B** | 只在下拉里选模型 label | baseUrl/key/路由/超时全隐藏 | ADMIN-only、密钥信封 |
| 通知/告警 notifications | A | "完成后通知我"→选渠道 | 配 webhook/Alertmanager | 去重键已硬化 |
| 审批策略（四眼/危险工具） | **B** | 只"提交/通过"，看 preview | 四眼校验、指纹失效 | 策略配置中台专属 |
| 审计 audit | A/B | 看"我的操作记录" | 过滤业务相关项 | 全量审计中台 |
| 用户/项目权限 users / projects | **C** | 不可见 | — | 中台专属 |
| 系统设置 settings（全局） | **C** | 不可见 | — | 中台专属 |
| MCP 工具 / SDK / CLI | **B** | 通过工作台间接用，不直连 56 工具 | agent 代调工具 | 工具白名单收窄 |

**结论**：C 类（用户权限、部署回滚、全局设置）不是"业务人员用不了"，而是**中台已经替他们用好了**——业务人员不需要也不应该碰。A+B 覆盖了全部业务相关的高级功能。

---

## 5. 一个端到端业务旅程：财务人员的"每月对账"

串起四层引导链，看业务人员实际怎么"用上"一堆高级功能：

1. **意图**：小张在 Workbench 说"每月 5 号对账，差异发张三"（Intake，自然语言）
2. **编译**：Agent 调 `chatJson` 生成方案卡 → 任务调度（每月5日）+ finance 能力 + SOP验收 + provider路由 + 通知 + 审批（Compile，草稿态）
3. **确认**：小张展开"业务参数"填数据源和收件人；高级设置折叠着没动；点"执行/继续编辑"（Confirm，PlanReadyCard 双按钮）
4. **审批**：涉及外发邮件 → 推送到主管的审批卡，显示 `preview`（差异报表摘要），主管通过（Confirm，四眼）
5. **执行**：沙箱试跑 → 验收 → 正式执行；工具白名单限定只读 + 邮件；预算 20 轮（Execute）
6. **交付**：产物出现在"我的交付物"；日志按业务目标呈现，不显示 executor UUID；小张点了"这个做得好，存成我的能力"（反馈闭环）

**这一步走完，小张实际用上了**：任务调度、能力卡片、SOP、provider 路由、审批、通知、产物、工具白名单、沙箱、预算——**10 个高级功能，他一个配置项都没直接填**。

---

## 6. 复用清单：现成能力 → GCO 组件

GCO 不是从零造，大部分零件现成：

| GCO 组件 | 现成资产（证据） | 需要新建 |
|---|---|---|
| 意图采集·录屏 | `AiSopDraftService.fromVideo`（`ai-sop-draft.service.ts:62,31`） | 入口扩展到自然语言/表单 |
| 方案编译·结构化输出 | `chatJson` + 重试（`runtime.ts:243`）、56 MCP 工具 | 方案卡 schema + 编译 prompt |
| 草稿态宽松校验 | `sop.service.ts:207 draft()` + `:220-221` 只记录不阻断 | 方案卡草稿→正式的发布闸 |
| 工具收窄 | `toolsForSessionKind` + allowlist（`tool-registry.ts:1455`） | 业务会话 kind |
| 审批与防盲批 | 四眼 + 策略指纹 + `argsDigest/preview`（`agent-approvals.service.ts:52-63`） | 工作台审批卡 UI |
| 沙箱/预算/摘要 | SOP 四闸 + `toolCallId` 截断修复 + 预算终态 | 无 |
| 项目上下文/角色 | ProjectRole + 项目切换（`MainLayout.tsx:162-214`） | 三档引导强度的配置 |
| 能力来源 | 5 官方模板 + provider 注册表 + manifest 守卫 | Capability 注册表（上一版 P1） |

> 反方核对：本项目 ROADMAP 明确"子 agent 委派"曾被推迟（权限提升 + 预算摊薄）。GCO 的"agent 代调工具"是**同一会话内的工具调用**，不是派生子 agent，不撞这条决策。

---

## 7. 与上一版方案的关系与落地位置

GCO 是上一版 [agent-workbench-strategy.md](agent-workbench-strategy.md) 的**交互与引导层**，不新增阶段，嵌入既有路线图：

| 阶段 | 嵌入内容 |
|---|---|
| **P1 能力注册表** | Capability 注册 + 两个正交字段 `scope.mode`（managed/supervised/self_service）× `guidance.level`（L1/L2/L3）+ 每类能力的默认组合与约束矩阵（见 §11.2） |
| **P2 工作台 MVP** | GCO 四引导链（Intake→Compile→Confirm→Execute）+ 方案卡 + 渐进披露 + 业务旅程 e2e |
| **P3 中台管控** | 中台设每类能力的引导强度上下限；Supervised 档一键收回；策略变更使存量方案卡失效 |
| **P4 生态** | 高频方案沉淀为能力卡片（反馈闭环）；录屏/自然语言编译准确率随样本提升 |

**建议把 P2 的验收改成 GCO 旅程**："业务人员用自然语言 → 方案卡 → 审批 → 执行 → 交付，全程不填运行时术语"——这比"接口返回 200"更能证明"业务人员真的用上了高级功能"。

---

## 8. 约束、风险与明确排除

| 约束/风险 | 对策 |
|---|---|
| 编译错方案，业务人员照单确认 | 方案卡人可读可改 + 草稿态 + 高危操作强制展开高级设置 |
| 引导绕过审批/权限 | 引导只在权限框架内生效；编译产物执行前过 `toolsForSessionKind` + 四眼 |
| 业务人员升到 L3 后配错 | L3 需中台授权；实时校验 + 供应链扫描 + 沙箱试跑兜底 |
| 模型编译成本失控 | 编译用固定预算、失败重试一次（复用 `chatJson`）、缓存常见方案 |
| 把 GCO 做成"admin-web 加向导" | 引导链长在工作台；admin-web 保持管理视角，不加业务向导 |
| 术语泄漏到业务层 | 方案卡只显示 label/业务字段；运行时术语（cron UUID/glue/front-matter）全部折叠或替换 |

**明确排除（本轮）**：
- 不把 admin-web 改造成业务入口
- 不向业务人员直接暴露 56 个 MCP 工具或 provider 原始配置
- 不让引导替代审批（引导只降认知门槛，不降安全门槛）
- 不做"全自动无人确认"（关键节点必须有人确认，延续四眼原则）

---

## 9. 验收口径（不许越级上报）

| 阶段 | 目标验收 | 断言的实际副作用 |
|---|---|---|
| P1 | 真进程内集成 | capability 行含引导强度字段、默认值生效、档位上限可被中台改 |
| P2 | **真浏览器 + 真后端 e2e** | 业务旅程走通：方案卡落草稿行、审批单生成、执行落 SUCCESS、交付物出现；全程无运行时术语输入 |
| P3 | 真浏览器 | 中台改引导强度后新会话生效；收回档位后存量方案卡失效；策略变更使授权失效 |
| P4 | 真进程/真机 | 高频方案沉淀为能力卡片；录屏/自然语言编译在样本上准确率可复算 |

"方案卡显示成功"不是结论；必须断言草稿行、审批单、执行状态、交付物这四类实际副作用。

---

## 10. 证据索引

本仓 CodeGraph 实测：
- 录屏→草稿闭环：`apps/admin-api/src/modules/ai/ai-sop-draft.service.ts:62,31`、`apps/admin-api/src/modules/sop/sop.service.ts:207,220-221`、`ai-sop-draft.controller.ts:64`
- 结构化输出+重试：`apps/executor-desktop/src/main/agent/runtime.ts:243`、`LlmClient :114`
- 工具收窄：`apps/admin-api/src/modules/agent/tools/tool-registry.ts:1455`（`SESSION_TOOL_ALLOWLIST` / `SESSION_PHASE_TOOL_ALLOWLIST`）
- 审批治理：`apps/admin-api/src/modules/agent/runtime/agent-approvals.service.ts:52-63`
- 导航/角色：`apps/admin-web/src/layouts/MainLayout.tsx:162-214`
- provider：`apps/admin-api/src/modules/ai/ai-providers.ts:33-140`
- 会话/接管：`apps/admin-web/src/pages/AgentSessionsPage.tsx`、`InboxPage.tsx`（见 ROADMAP P1）

参考项目：Octop（PlanReadyCard / HitlApprovalCard / chatStore）、ZCode（Plan 模式 allowedPrompts / checkout / DiffViewer）、opencode（Part 判别联合 / policy 只收紧）、magpie+dsh（能力可逆注册 / dump-config）。

---

## 11. 六 agent 交叉评审后的修订与补充（v2，2026-11-26）

> 本文经 6 路 agent 互相质询、认账后修订。治理档位与引导强度的正交性、复用声明的核实见 strategy 文档 §12。本节只留与 GCO 直接相关的修订。

### 11.1 GCO 专项硬伤修正

| # | 初稿问题 | 修正 |
|---|---|---|
| G1 | 默认引导强度 L1 ≡ 治理 Managed，与 strategy §5-B Supervised 默认冲突 | 默认改 **L2**；L1 仅用于危险能力/模型渠道（已回写 §3） |
| G2 | "人可读可改 + 高危强制展开"被红队判为**纸面防线**：`chatJson`（`runtime.ts:243`）只校验 JSON 合法、不校验语义，幻觉编译（幽灵能力/错 cron）会一路走到执行才失败 | 新增 **N7 编译期反幻觉闸门**：方案卡落库前确定性校验（能力 id 存在性 / cron 可回读成业务语句 / 预算≤中台上限 / scope 可解析），失败转澄清不进审批；确认留痕=方案卡版本 hash + 确认人 + 摘要；责任分层落审计 |
| G3 | `toolsForSessionKind`（`tool-registry.ts:1455`）是静态 kind×phase 白名单、chat 类不限工具；`sop.draft()` 写 SOP 行不是方案卡；`chatJson` 在 executor-desktop 且未 export | 三处只能在签名层借鉴、机制重写；新增"业务会话 kind"必须 **fail-closed + 进 tripwire**，否则 GCO 权限声明落空 |
| G4 | 财务对账旅程的 `finance.erp.readonly` 是示例 id、本仓无此能力；内网 ERP 多无 API | **N9 一等降级**：能力发现加可达性探测，无 API 降级到 executor-desktop X11 GUI 驱动 + fromVideo 录屏（护城河）；首个 e2e 用已有 API/就绪文件数据源 |
| G5 | "收回档位后存量方案卡失效"用现有 4 键指纹做不到（`agent-approvals.service.ts:48` 明确排除 blockSelfApproval） | 方案卡自带 scope/guidance 版本号消费时比对；扩指纹键集属新增工作 |

### 11.2 正交矩阵（P0 必改）

`scope.mode`（治理：谁能覆盖配置）× `guidance.level`（引导：谁编译/披露程度）—— 两轴正交，不相互推导。

| scope.mode ＼ guidance.level | L1 托管 | L2 引导（默认） | L3 作者 |
|---|---|---|---|
| **Managed**（中台锁定） | ✅ 推荐（危险能力/模型渠道） | ✅ 合法 | ❌ **非法**：锁定却让业务直配，语义冲突 |
| **Supervised**（可见可收回，默认） | ✅ 合法 | ✅ **默认组合** | ✅ 合法（首次成功筛出的 champion 经授权） |
| **Self-service**（自行配置） | ⚠️ 合法但浪费 | ✅ 合法 | ✅ 合法 |

约束：`managed ⇒ guidance ≤ L2`；危险能力/模型渠道 ⇒ L1；L3 需中台授权。

### 11.3 GCO 相关新增目标（完整清单见 strategy §12.3）

- **N6 IM 一等入口（带前置）**：Intake 增 IM adapter，验收旅程"企微@→方案卡→审批→交付"；**前置** IM identity→ProjectRole 映射 + 群聊 prompt injection 防护；身份走 Gateway sender 验证、审计双字段。（业务驻留 IM，采纳成本最低，但 red 要求身份前置，故 IM 不进 P2 MVP 首发批，与 N4 最小切片错开）【状态：🟡 部分实现（第 57 轮）：身份映射/注入防护/Intake 编排 + `im-identity/im-webhook.adapter.ts:71-178` 已落地（challenge 回显 + 企微/飞书消息提取，验签复用 `verifyWebhookSignature`），`im-identity.controller.ts:172` 路由已暴露；im-identity 6 suites/83 tests 绿、验签失败/challenge/平台隔离反证有牙。**未做**：真发企微/飞书回调、真实加解密】
- **N8 会话 park/drain**：审批期 steer 入 inbox → 模型步边界 drain；pendingWake 不复活死意图；补 blocked 看板。【状态：✅ 已实现（第 57 轮状态机 + 第 65 轮接线）：steer-inbox 纯状态机 + R286 blocked 看板已落地；第 65 轮补生产接线——`runtime/steer-inbox.service.ts` 进程内 inbox、`agent-runtime.service.ts` run() 每轮 LLM 前 drain 注入、`POST /agent/sessions/:id/steer`（仅 waiting_input），6 例接线断言 + 反证。边界：inbox 仅进程内、不跨副本/重启】
- **N10 Part 扩类 + share**：6 类扩到 opencode 12 类 + 会话级 share + 大字段入 blob。【状态：✅ 已实现（第 53 轮类型 + 第 66 轮 blob/投影接线）：12 类 Part 判别联合 + isStaleGeneration；第 66 轮补 `workbench-blob.store.ts`（S3LogStorage.fromConfig，未配 s3 内存降级）+ `part-projection.service.ts`（大字段→BlobRef、isPartVisible+owner、12 类投影）+ `POST /workbench/part/project`；5/5 + workbench 109 tests + 双反证。边界：share token 完整鉴权流程未做（可见性由 isPartVisible+owner 决定）、真 S3/PG 与跨进程 Part 持久化未做】
- **N11 Plan 做成 agent 身份**：不是 UX 折叠开关，换 MemoryFileSystem + PermissionService；allowedPrompts 意图级批准 = 一次 SOP 发布 scope=once。【状态：✅ 已实现（第 55 轮状态机 + 第 68 轮接 loop，ADR-044 裁决）：`plan-agent-gate.ts` 闸门只收紧+放行回原模式、destructive 恒拒、read 回原模式不裸跑、allowedPrompts 不落永久规则；runtime 经 narrowPlanTools 收窄，plan kind 进 AGENT_SESSION_KINDS/指标/工具只读面；17/17 + 反证 13 真红。边界：进入/退出与审批单落库端到端联动、baseDecision 真实注入待接。toolsForSessionKind 过滤第 63 轮已生产接线，本批纠正文档滞后】
- **N14 在途策略即时失效**：`capability/changed` → interrupt 在途 + 下次 check 用新 policy + scopedRules 保 ask/deny。【状态：🟡 部分实现（第 56 轮）：代际持久化/emit + scopedRules 纯分类（`workbench/scoped-rules.ts:101`）已接 commit 第五闸（`workbench.controller.ts:103,317-321`，quota 后/draft 前；通配 allow 作废即拒、显式 ask/deny 保留，6 例反证 + workbench 8 suites/95 tests）；**未做**：interrupt 在途工具调用、跨实例 5s TTL 真机】
- **N18 rewind 代际围栏**：会话/Part 带 generation，回退使旧异步写入/通知作废 + 审计"作废 N 任务"。【状态：✅ 已实现（第 54 轮纯判定 + 第 65 轮服务端接线）：N10 Part generation + `rewind-fence.ts` 纯判定；第 65 轮补 `rewind-runner.ts`（代际只读服务端、作废组不扇出、字面量 `workbench.rewind` 审计含 invalidatedCount）+ `POST /workbench/rewind`，5/5 单测 + 反证。边界：生产默认 EmptyWriteSource fail-closed、未接 agent runtime 真实在途 source】
- **N24 进程外隔离定位修正**：中间形态（P1/P2）先做进程内能力权限层 + 预算 + 失败降级；slots/streams 背压与进程外 host 留 P4（magpie `host.go:455-511`）。【状态：✅ 中间形态已实现（第 67 轮）：`backpressure.ts` slots/streams 双限流纯状态机 + `inprocess-gate.service.ts`（classify→budget→degrade 严格顺序、`capability.degraded` 审计）+ module 注册；14/14 + capability 287 tests + 双反证。**未做（P4 needs_adr）**：进程外 host / IPC、坏版本回退（需 ADR）；上限当前为可覆盖进程内默认常量，生产取值待配置收口】

### 11.4 最小可验证切片（P2 前置证伪闸门，来自 red V5）

**2 周**：1 个已有只读能力 + 现有 SOP draft/publish 承载方案卡 + 现有四眼/digest 确认 + 一页前端（3 业务字段 → 预览 → 审批 → 看产物），真浏览器 e2e 断言"不填 cron/UUID/glue 拿到报表"。不通则后续全白做——**暂不建注册表/Scope 链/Part 模型/编译 prompt/三档**。这是对 GCO 全部设计最便宜的证伪方式，优先于任何 P2 实现。
