# 06 · 分阶段落地路线图

> 原则：**部署脚本先行**（独立、低风险、立刻有用）→ **Agent 底座**（有风险，但无它则一切免谈）→ **SOP 协作**（最复杂，依赖前两者）。

## 1. 阶段总览

| 阶段 | 内容 | 依赖 | 风险 | 可独立交付 |
|---|---|---|---|---|
| **P0** | 一键部署脚本（双模） | 无 | 低 | ✅ 是 |
| **P1** | Qwen provider + 多模态方法 | 无 | 低 | ✅ 是 |
| **P2** | Agent 运行时底座（无工具写能力） | P1 | **中高** | ✅ 是（可只读运维） |
| **P3** | 工具集收编 + 边界闸门 | P2 | **高** | 半个 |
| **P4** | 触发器（定时 + 事件） | P3 | 中 | 是 |
| **P5** | SOP 协议 + 指派 | P3 | 中 | 是 |
| **P6** | 澄清循环 + 视频理解 | P5 + P1 | **高** | 是 |
| **P7** | 执行器 Agent（网页自动化） | P5 | **最高** | 是 |

**关键判断**：P0 和 P1 可以**立刻并行开工**，它们不依赖任何未定项。P7 依赖你还没定的「执行器 Agent 是什么」（[04 §7.1](./04-sop-protocol.md)）——**这个不定，P6/P7 无法收尾**。

## 2. P0 · 一键部署脚本 ✅ 已实现

> **状态：已完成（2026-09）**。产物：`deploy.sh`（双模）、`scripts/deploy.selftest.sh`（29 项自检）、
> `package.json` 的 `test:deploy-script`、`Makefile` 的 `deploy*`/`doctor` 目标、`docs/deployment.md` 同步。

**目标**：`sudo ./deploy.sh --mode source --env production` 一条命令跑起来。

| 任务 | 产出 | 状态 |
|---|---|---|
| 参数解析 + 向后兼容 | `--mode` 默认 `docker`，现有用法零变化 | ✅ |
| 8 阶段流水线骨架 | §[01 §4](./01-deployment.md) | ✅ |
| `doctor` 子命令 + `--json` | Agent 的前置依赖（P3 要用） | ✅ |
| systemd unit 模板 + 生成 | 源码模式核心 | ✅ |
| `.deploy-manifest.json` + rollback | 回滚能力 | ✅ |
| nginx 站点配置生成 | 源码模式的 admin-web 服务 | ✅ |
| 文档同步 | `docs/deployment.md` 更新 | ✅ |

### 实现中发现的真实陷阱（已修 + 已加回归）

| # | 陷阱 | 后果 | 修法 |
|---|---|---|---|
| 1 | `curl ... \|\| echo "000"` | 连接失败时 curl **自身已输出 000**，拼成 `"000000"` | 去掉 `\|\| echo` |
| 2 | curl 非零退出码 + `set -e` | **整个脚本静默中止**（doctor 只输出一半） | 函数内 `\|\| true` 吞掉 |
| 3 | `env_get` 返回 1 + `set -e` | `.env` 缺失时配置阶段静默退出 | 恒返回 0，缺失给空串 |
| 4 | 子命令参数被部署解析器吃掉 | `doctor --json` 报「未知参数」 | 先摘子命令再解析 |
| 5 | 进度行写 stdout | `--json \| jq` 解析失败 | JSON 模式人类输出走 stderr |
| 6 | 裸 `$VAR` 紧跟多字节字符 | macOS Bash 3.2 下 `unbound variable` 中止 | 项目既有 `check-shell-multibyte-var.mjs` 门禁捕获，15+7 处已修 |
| 7 | 预检端口探测 `netstat -ltnp` / `lsof -ti` 非零退出 | Git Bash 的 netstat 不认 `-ltnp`、macOS 的 lsof 在端口空闲时退出 1——`set -euo pipefail` 借命令替换的非零退出码**静默打死脚本**（`2>/dev/null` 只压报错文本压不住退出码，陷阱 #2 的变体） | 探测属 best-effort：命令替换尾部 `|| true`，探不到当「空闲」 |
| 8 | `have python3` 只证明 PATH 上有这个名字 | Windows 的 Microsoft Store 给 python3 装**占位 stub**：`command -v` 判存在、实跑必败且退出码非零（`selftest` 的 `command -v python3` 门与 deploy.sh 的版本探测双双中招） | 实跑一次 `--version` 验真再用；坏 stub 按未安装处理；selftest 的 JSON 校验改用 node（`npm run` 调起时 node 是硬前提） |

> 第 6 条特别值得记：**项目已有这道门禁**，是它主动抓住了跨平台 bug 类。新脚本接入既有
> CI 门禁的价值在此体现——`npm run check:shell-multibyte-var` 已验证通过。

**验收（全部通过）**：
- ✅ `bash -n` 语法检查
- ✅ 29 项自检全绿（`npm run test:deploy-script`）
- ✅ `doctor --json` 输出可被 `python3 json.load` 严格解析
- ✅ 现有 `./deploy.sh`（不带参数）行为不变（默认 docker）
- ✅ `--dry-run` 走完全部 8 阶段且**不修改系统**
- ✅ 项目既有门禁全绿（`check-lint-gates`、`check-shell-multibyte-var`）
- ⏳ 真实 Linux 主机端到端（需你在目标机验证——本环境为 WSL2 且 Docker daemon 不可达）

## 3. P1 · Qwen provider ✅ 已实现

> **状态：已完成（2026-09）**。产物：`ai.service.ts` 的 `chatMultimodal`/`callQwenText`/`hasApiKeyForProvider`、
> `ai.controller.ts` 的 qwen 配置面、`configuration.ts` + `app.module.ts`（Joi）配置注册、
> 前端设置页 Qwen 段、`scripts/qwen-runtime-check.mjs`（34 项运行时断言）、`scripts/ai-qwen-structural-check.mjs`（44 项结构断言）。

见 [05 §5 改造清单](./05-qwen-multimodal.md)（7 项，全部完成）。

### 实现要点

| 设计决策 | 理由 |
|---|---|
| **新开 `chatMultimodal` 而非改造 `callOpenAI`** | 后者的 `max_tokens=500` 是刻意的成本策略；被多模态需求抬高会让既有失败分析链路悄然变贵 |
| **qwen 令牌/超时独立配置** | 多模态推理（4096 令牌）与视频理解（120s）与纯文本分析（500 令牌/30s）不同量级 |
| **新增 `validateMediaUrls()`** | 媒体 URL 由执行器上报（不可信），原样转给 DashScope 是 SSRF 转嫁——只接受 http(s) |
| **新增 `hasApiKeyForProvider()`** | 修既有 bug：`getConfig` 硬编码查 `ai.openaiApiKey`，会让「选了 qwen 却显示未配置密钥」 |
| **保留全部既有 SSRF 姿态** | `assertAndPinHttpUrl` + `pinnedAxiosConfig` + `maxRedirects:0` 逐一保留，**不新开旁路** |

**验收（全部通过）**：
- ✅ `npx tsc --noEmit`（admin-api）+ `tsc -b`（admin-web）均 0 错误
- ✅ 34 项**运行时**断言全绿（真实实例化 + mock axios，验证请求体形状/安全/fail-open/tool-calling）
- ✅ 44 项**结构**断言全绿（防实现被误删/绕过）
- ✅ 回归：openai 的 `max_tokens` 仍是 500（**未被 qwen 污染**）、ollama 分支未动、`sanitizeLogs` 未退化、`WIKI-OPT-3` cron 校验仍在
- ⏳ DashScope 真实账号端到端（需你的账号；`qwen-vl-max` vs `qwen-vl-plus` 效果与视频规格待实测）

> ⚠️ **环境限制说明**：admin-api 的 jest 在本环境整模块不可运行
> （`Must use import to load ES Module`，jest 30 + ts-jest 29 组合），且这是
> **既有问题**——未改动的 `audit`/`task` 模块同样失败。故 P1 验证走
> 「转译 + 直接实例化」的运行时 harness（`qwen-runtime-check.mjs`），
> 验证的是**行为**而非文本匹配。同批单测已写入 `ai.service.spec.ts`，
> 待 jest 环境修复后即会生效。

## 4. P2 · Agent 运行时底座 ✅ 已实现

> **状态：已完成（2026-09）**。产物：三张表 + 迁移 `1790000000040`、
> `AgentSessionService` / `AgentBudgetService` / `AgentRuntimeService` /
> `AgentProcessor` / `AgentController` / `AgentModule`、5 项 Agent 指标、
> `scripts/agent-runtime-check.mjs`（66 项运行时断言）。

**目标**：Agent 能常驻、能多轮推理、能落库、**工具集尚未接入**（P3）。

| 任务 | 产出 | 状态 |
|---|---|---|
| 三张表 + 迁移 | `agent_sessions` / `agent_steps` / `agent_tool_calls` + `task_executions.agentSessionId` | ✅ |
| `AgentRuntimeService` 推理循环 | [02 §4](./02-agent-architecture.md) | ✅ |
| 预算闸门 | 四道（steps/tokens/wallClock/toolCalls） | ✅ |
| 独立 BullMQ 队列 `agent-jobs` | 并发固定 2，与 `task-queue` 分开 | ✅ |
| 挂起/恢复机制 | 可重入的 `run()`（从 DB 重建 messages） | ✅ |
| 指标 | 5 项（sessions/tokens/tool_calls/denied/budget_exceeded） | ✅ |
| HTTP 面 | 会话列表/详情/创建/恢复/预算（全部 ADMIN-only） | ✅ |
| Admin Web 会话查看页 | 只读视图 | ⏳ 留待 P3 一并做（先有数据再看） |

### 实现中的关键判断

| 判断 | 理由 |
|---|---|
| **闸门在循环开头，不在末尾** | 末尾判会让最后一轮的副作用（可能已改生产配置）已经发生，闸门形同虚设。测试专门钉住「恰好跑到 maxSteps 就停，不多跑一轮」 |
| **用量累加与 step 写入同事务** | 分开写会出现「步数涨了用量没涨」的窗口，而闸门正是读用量——那个窗口里 Agent 是**无限制**的 |
| **`startedAt` 只在首次置位** | resume 不重置，否则墙钟预算可被反复续命，「30 分钟上限」形同虚设 |
| **`scopeJson` 缺省为空对象而非 null** | 空 scope 语义 = 「不可操作任何资源」，比 null（易被解释为不限）安全 |
| **循环与工具用接口切开** | P3 实现边界闸门时不必改动循环逻辑，也就不会重新搅乱 P2 已验证的可重入/预算语义 |
| **processor 不重抛未预期异常** | 重抛会让 BullMQ 重试，而重试会**重复执行已发生的副作用**——比不重试更危险 |
| **provider/model 逐条记录** | Agent 会混合模型（日常推理用便宜的、看录屏切 qwen-vl），出问题时「这一步是谁答的」决定排查方向；成本归因也依赖它 |
| **`getActiveRoute()` 由 AiService 暴露** | 路由是 AiService 的内部决策，调用方复刻一份解析逻辑必然漂移（实测：初版硬编码 `"qwen"`，已改） |

**验收（全部通过）**：
- ✅ `npx tsc --noEmit` 0 错误；`npx nest build` 通过（DI 装配正确）
- ✅ 66 项运行时断言全绿（预算四道 / 循环终态 / 可重入 / 幂等 / fail-open / 指标）
- ✅ 迁移注册校验通过（`1790000000040` 已登记 PLAN-CLAIMS）
- ✅ 索引漂移校验通过（实体 `@Index` 与迁移 DDL 一致）
- ✅ 独立队列断言：`agent-jobs` ≠ `task-queue`，并发固定 2
- ⏳ **P2 要求的压测**（内置 Agent 对 admin-api P99 的影响 < 5%）——需在真实 DB/Redis 环境跑，本环境无法执行

> ⚠️ 同 P1：admin-api 的 jest 在本环境整模块不可运行（既有问题），
> 故 P2 验证走「转译 + 直接实例化 + 依赖打桩」的运行时 harness。
> harness 边界已在脚本注释中如实标注（用打桩的 SessionService 时，
> 真正由它发出的埋点不会出现在捕获里，故那部分改用结构断言）。

## 5. P3 · 工具集 + 边界闸门 ✅ 已实现

> **状态：已完成（2026-09）**。产物：43 工具注册表 + 会话白名单、五道边界闸门、
> 工具执行器（超时/截断/脱敏/熔断）、只读工具绑定、`scripts/agent-boundary-check.mjs`
> （98 项含红队）。

| 任务 | 产出 | 状态 |
|---|---|---|
| 工具注册表 | 43 个工具（tier / resourceKind / schema） | ✅ |
| 会话白名单 | 6 种 kind → 工具集映射 | ✅ |
| `AgentBoundaryService` 五道检查 | 白名单 / 硬禁用 / 参数 / scope / 速率 + 审批 | ✅ |
| 工具分级表 | read 31 / write 10 / dangerous 2 | ✅ |
| 硬禁用 | `approve_deployment` / `reject_deployment` | ✅ |
| 执行器 | 超时 + 截断 + 脱敏 + 熔断 + denied/awaiting 落库 | ✅ |
| 只读工具绑定 | 15 个真实执行体（in-process 调 Service） | ✅ |
| 审批落点 | 请求 + 挂起 + 恢复锚点（通知推送留 P4） | ✅ |

### 实现中的关键判断

| 判断 | 理由 |
|---|---|
| **硬禁用工具不暴露给模型** | 纵深防御第一层：连看都看不到，就不会尝试。比「暴露但拒绝」更干净 |
| **`approve_deployment` 不可配置** | 测试专门断言「即使 `allowDangerous=true` 仍被拒」——安全红线不是开关 |
| **denied 不消耗速率预算** | 否则越权尝试会把正常调用也拖到限流，**反而放大攻击效果** |
| **熔断按 (会话, 工具) 隔离** | 一个工具熔断不该冻结整个会话的其他能力 |
| **参数扫描递归到嵌套对象** | 红队用例覆盖 `{a:{b:{c:"$(id)"}}}`——只扫顶层会漏 |
| **未实现工具返回错误而非静默成功** | 静默成功会让模型在错误前提上继续推理，比明确失败更危险 |
| **in-process 调 Service 而非 HTTP** | 中台 Agent 就在同进程；且 API Key 受 `JWT_ONLY_API_KEY_PATHS` 限制碰不到 config 面 |

### 红队验证矩阵（98 项断言的核心）

| 攻击面 | 用例 | 结果 |
|---|---|---|
| 越权工具 | `ops_watch` 调 `trigger_task` / `delete_application` | ✅ 拒（not_in_toolset） |
| 未知类型 | `evil_kind` 会话调只读工具 | ✅ 拒（空白名单） |
| 自审批 | `approve_deployment`（含放开 dangerous 配置后） | ✅ 拒（hard_disabled） |
| Shell 注入 | `; rm -rf /`、`&& curl`、`\| nc`、`$(whoami)`、反引号 | ✅ 全拒 |
| 换行注入 | `a\nrm -rf /` | ✅ 拒 |
| 路径穿越 | `../../etc/passwd`、`..\\windows`、`/etc/shadow`、`~/secrets` | ✅ 全拒 |
| SSRF | `127.0.0.1` / `localhost` / `169.254.169.254` / `192.168.x` / `10.x` | ✅ 全拒 |
| 超长载荷 | 100,001 字符 | ✅ 拒 |
| 嵌套注入 | `{a:{b:{c:"$(id)"}}}` | ✅ 拒 |
| 越出 scope | 授权 app-A 后操作 app-B | ✅ 拒（out_of_scope） |
| 空 scope | 缺省 `{}` 或显式空列表 | ✅ 拒（安全默认） |
| 速率滥用 | 同工具第 16 次调用 | ✅ 拒（rate_limited） |
| 连续失败 | 同工具连失 3 次 | ✅ 熔断（circuit_open） |

**验收（全部通过）**：
- ✅ `npx tsc --noEmit` 0 错误；`npx nest build` 通过
- ✅ 98 项边界断言（含 13 类红队用例）全绿
- ✅ 工具集与 mcp-server 的 43 个工具名**双向逐一对应**（无遗漏、无多余）
- ✅ 项目既有门禁全绿

**风险**：**高**——这是从「只读」到「能改生产」的跨越。缓解已在实现中落地：
分级开放（read 31 / write 10 / dangerous 2）、硬禁用不可配置、scope 安全默认、
五道闸门、13 类红队用例。

## 6. P4 · 触发器 ✅ 已实现

> **状态：已完成（2026-09）**。产物：`AgentTriggerService`（定时 + 事件触发编排）、
> `AgentEventAggregator`（聚合窗口）、`AgentNotifyService`（§7.2 通知）——P3 遗留的
> 「审批通知推送」同批兑现；`scripts/agent-trigger-check.mjs`（触发器 37 项 + 通知 31 项断言）。

**目标**：Agent 能自主醒来。

| 任务 | 产出 | 状态 |
|---|---|---|
| 复用 `scheduler` 做定时触发 | `@Cron` 每小时巡检 + **leader 门禁**（多副本安全） | ✅ |
| 事件订阅 + **聚合窗口** | `execution.failed/killed`、`executor.offline`、`deployment.completed` 白名单 → 窗口聚合 | ✅ |
| 阈值与去重 | 同 (事件, 资源) 窗口内**只触发一次**；离线事件阈值覆盖为 1（单次即重要） | ✅ |
| 静默成功策略 | 成功且无 `summary` 的会话**不通知**；`aborted`（管理员自己的动作）同样不回推 | ✅ |
| 会话通知（§7.2） | 成功有结论→INFO / 失败·预算超限→ERROR / 待审批→WARNING；配置开关 `AGENT_NOTIFY_ENABLED` | ✅ |
| 审批通知（P3 遗留） | `requestApproval` 推送渠道通知（审批不催等于没审） | ✅ |

### 实现中的关键判断

| 判断 | 理由 |
|---|---|
| **扫描型 tick 过 leader 门禁** | 多副本下每台实例都会跑 `@Cron`，不判 leader 会 N 倍触发且互相看不见；复用 `SchedulerService.getStats().isLeader`，**不另造选举**（两套选举会出现「都认为自己是 leader」的窗口） |
| **事件不进 Agent，先进聚合窗口** | 一次执行器下线会刷出几十条失败事件，逐条触发 = 令牌成本爆炸 + `agent-jobs` 队列拥塞 + 通知风暴 |
| **离线事件阈值覆盖为 1** | 不同事件噪声水平差异大：`execution.failed` 阈值 3 合理，`executor.offline` 本身单次即重要——做成参数而非多配置键，阈值语义只有一处 |
| **聚合状态放内存不放 Redis** | 窗口是秒级瞬时状态，重启丢失「重启前一小段窗口」可接受；事件路径高频，不值得每次多一跳网络 |
| **自动触发会话 scope 为空** | 事件/定时触发的会话只能读、只能上报——自动醒来的东西不该自带写权限 |
| **通知挂在 `finish()`（终态唯一收敛点）** | 一处覆盖全部路径；且 finish 的「已是终态提前返回」守卫同时防住重复通知（resume 撞车不双发） |
| **通知传更新后的快照** | 静默语义读的是**新** summary——传落库前的旧值，「无结论不通知」就判错了 |

### 验收

- ✅ 定时巡检按 cron 执行（每小时第 5 分钟，`AGENT_TRIGGER_CRON_ENABLED` 可关；非 leader 跳过）
- ✅ 47 次执行失败 → 只产生 **1 个** incident 会话（断言钉住「达阈值即触发」「同窗口不重复」「窗口过后可再触发」「非白名单永不触发」）
- ✅ 无结论的会话不通知（静默语义 + 空串摘要同样静默）
- ✅ 通知分级与 fail-open（渠道全挂不上抛，不把已收敛会话搅出第二次失败）
- ⏳ 真实多副本/真实渠道端到端（需 DB/Redis/渠道环境；本环境验证走转译 + 打桩运行时断言）

**风险**：中。事件风暴是真实风险，聚合窗口是核心缓解；通知全链 fail-open，不回灌主链。

## 7. P5 · SOP 协议 ✅ 已实现

> **状态：已完成（2026-09）**。产物：`modules/sop`（四张表 + 迁移 `1790000000041` +
> `SopService` / `SopController` / `SopCollabController`）、front-matter 解析校验
> （`sop-frontmatter.ts`）、6 个 SOP 工具接入注册表/绑定器/白名单、Admin Web SOP 管理页、
> `scripts/agent-sop-check.mjs`（58 项断言）。

**目标**：SOP 能起草、发布、指派。

| 任务 | 产出 | 状态 |
|---|---|---|
| 四张表 | `sops` / `sop_versions`（不可变快照 + contentHash）/ `sop_assignments`（11 §4.1 协作列一次建齐）/ `sop_clarifications`（幂等键） | ✅ |
| front-matter schema + 校验 | 严格模式（发布）：未知键拒绝、acceptance 必填、capabilities 枚举、maxRounds ≤ 5、allowedDomains 裸域名；草稿宽松 | ✅ |
| SOP 工具（6 个） | `sop_list` / `sop_get` / `sop_draft` / `sop_publish`（**逐工具默认审批**）/ `sop_assign` / `sop_reply_clarification` | ✅ |
| 指派 API | ADMIN 面 `POST /sop/:id/assign`（executorId 或 address）；maxRounds 指派时快照 | ✅ |
| Admin Web SOP 管理页 | 列表 / 契约+正文 / 版本历史（contentHash 可复制）/ 指派与澄清 | ✅ |

### 实现中的关键判断

| 判断 | 理由 |
|---|---|
| **版本不可变 + 工作副本分离** | `sop_versions` 只 insert 不 update——执行器靠 contentHash 对账「我执行的是哪份」；`sops` 主表是工作副本（published 态也可编辑以准备下一修订），执行器拉取**永远读版本表** |
| **内容未变拒绝重复发布** | 同内容多版本是纯版本噪音，还会让执行器侧对账复杂化——修订必须真的改了什么 |
| **`sop_publish` 走逐工具 `approvalRequired`** | 发布权 = 间接指令注入权（04 §4.3），这一条**不随全局写审批策略放宽而放宽**；边界闸门为此新增逐工具审批位（`spec.approvalRequired`） |
| **内部工具独立成 `AGENT_INTERNAL_TOOL_SPECS`** | `AGENT_TOOL_SPECS` 是 mcp-server 43 工具的 parity 镜像（双向逐一对应，多一个都红）；内部工具分表后 parity 不变量不破坏，最终在 `ALL_AGENT_TOOL_SPECS`（49）合流供闸门与 LLM 消费 |
| **`capabilities` 取代 `requiredTools`** | 07 §7 定案：SOP 从命令式脚本变声明式目标，acceptance 是唯一锚点 |
| **澄清会话 scope = `{ sops: [sopId] }`** | 澄清来自执行器（不可信），复核 Agent 只能读被复核的那一份 SOP——最小权限 |
| **sop_review 白名单不含 sop_draft/sop_publish** | 修订只经 `sop_reply_clarification` 的受控路径（发 patch 版本），不给复核会话自由发布权 |

### 验收

- ✅ 中台 Agent 能产出合法 SOP（`sop_draft` → `sop_publish` 全链断言通过）
- ✅ 非法 front-matter 无法发布（严格校验 17 项断言：未知键/缺 acceptance/能力域越枚举/maxRounds 超限/js-function 标签等）
- ✅ 能指派给一个模拟的执行器 Agent（手工 HTTP 经 agent-collab poll 领取，见 P6）
- ⏳ front-matter 与 `docs/autoapp-skill.md` 的对齐（P7 起草真实 SOP 时收敛）

**风险**：中。front-matter 与既有 `docs/autoapp-skill.md` 的对齐是关键（[04 §6](./04-sop-protocol.md)）。

## 8. P6 · 澄清循环 + 视频理解 ✅ 已实现（中台侧）

> **状态：中台侧已完成（2026-09）**。产物：agent-collab 协作 API（poll / capability /
> clarifications / progress / complete）、澄清 → `sop_review` 会话触发（parentSessionId
> 串联 + scope 最小化）、`maxRounds` 硬闸 + 升级通知、SOP 修订发新版本（与人工发布同一道
> 严格校验）、媒体只认平台内路径（SSRF 转嫁面封死）。

**目标**：✅ 你强调的核心——执行器 Agent 回问，中台复核补充，直到合格。

| 任务 | 产出 | 状态 |
|---|---|---|
| 澄清 API | `POST /api/agent-collab/clarifications`（幂等键 clientClarificationId） | ✅ |
| 中台 Agent `sop_review` 会话类型 | 独立会话，`parentSessionId` 串联；scope 只授权被复核的 SOP | ✅ |
| SOP 修订 + 发新版本 | `sop_amended` → patch 版本（不可变快照 + contentHash），与人工发布同一道校验 | ✅ |
| `maxRounds` 硬闸门 | 触顶 → 强制 `escalated_to_human` + WARNING 通知，**不再起会话** | ✅ |
| 多模态接入 | mediaRefs 随澄清入库并进会话上下文；模型侧用既有 `chatMultimodal`（qwen 路由） | ✅（多模态推理实测留待 DashScope 账号） |
| 媒体存储 | mediaRefs **只认平台内路径**（`/api/...`），外网 URL 一律拒（11 §5.2） | ✅ |
| 协作 API 全套 | poll（长轮询 ≤25s + sopPolicy 下发）/ capability / progress / complete（幂等 attempt） | ✅ |

### 实现中的关键判断

| 判断 | 理由 |
|---|---|
| **触发触顶不生效即转人工** | 两个 Agent 的「礼貌循环」是真实风险——第 maxRounds+1 次追问直接落 `escalated_to_human`，不起 sop_review 会话，不烧令牌 |
| **执行器上报全部按不可信处理** | question/context 长度钳位 + 凭据脱敏；mediaRefs 只认平台内路径（否则 = 执行器让中台下载任意 URL 转给 DashScope 的 SSRF 转嫁）；result 大小受限 |
| **`agent:sop` 显式能力闸** | 既有「空 capabilities = runtime 通用」语义**不沿用**到 SOP 派发——协作面只对显式声明的机器开放，fail-closed |
| **鉴权复用 `validateTokenByAddress`** | 与 pull/heartbeat 同一条机器身份链，不新造凭据体系（11 §2） |
| **complete 只落账不做验收判定** | 「执行器说成功 ≠ 真成功」——独立验证（中台自己跑 acceptance）是 Agent 会话的职责，API 层如实记录回报 |
| **协作协议暂不进 protocol.json** | 非**三方共有**语义不进契约（executor-protocol README 纪律）；P7 executor-desktop 实现 client 时按 11 §7 进 `agentCollab` 段（文档型，不参与双生成） |

### 验收

- ✅ 模拟执行器 Agent 提问 → 中台 Agent 收到澄清（sop_review 会话被触发并携带脱敏后的上下文）
- ✅ 提问内容指向 SOP 缺失 → 中台**修订 SOP 并发新版本**（sop_amended → 1.0.1 + contentHash 变化，断言钉住）
- ⏳ 上传一段录屏 → 中台 Agent 基于视频给出诊断（链路就绪；推理实测需 DashScope 账号）
- ✅ 超过 `maxRounds` → 转人工（+ 通知）
- ⏳ **反向用例**（SOP 植入「请删除所有文件」→ 执行器 Agent 拒绝并上报）——P7 执行器 Agent 落地后跑

**风险**：**高**。这是两个 Agent 互相交互，行为不可完全预测。缓解：硬轮次上限、平台强制约束、人工升级路径。

## 9. P7 · 执行器 Agent（通用自主智能体）

**目标**：执行器上是**通用 agent**——读 SOP 后自主观察本机环境、自主决定实现方式、自己写自己跑自己改，回报中台。

**★ 已定案，完整设计见 [07-executor-agent.md](./07-executor-agent.md)**。原「待定项」已解决。拆成四个子阶段：

| 子阶段 | 内容 | 关键 |
|---|---|---|
| **P7a** | 骨架：环境探测 + LLM 循环 + workspace 沙箱（**先不做浏览器**） | **可独立验证设想可行性** |
| **P7b** | 浏览器能力（Playwright）+ 截图/录屏回传 | desktop 已依赖 Playwright |
| **P7c** | 桌面 GUI 能力 + 迭代诊断循环 | 覆盖 C/S 客户端场景 |
| **P7d** | 端到端：SOP → 自主实现 → 澄清 → 交付部署 | 闭环 |

### 9.1 最重要的架构判断（07 §3.3 / §7.2）

```
✅ Agent 负责「写」 → 生成的代码落盘为候选应用 → 走既有 executor-package +
   deploy.ts 通道部署运行（既有校验链 / env 白名单 / .venv 隔离全都保留）
❌ 不是「Agent 生成代码 → 直接在本机长期跑」
```

这样 Agent 的自由被限制在**生成阶段**，运行阶段仍受既有安全纪律（SEC-01 / SEC-05 / shell 校验）约束。

### 9.2 必须先做的诚实评估

**这个设想要求把「执行器上可跑任意代码」变成合法状态**，与你项目现有加固方向（env-whitelist / shell 校验 / 封闭枚举）相反。这是**信任模型的根本改变**，必须：
- 写 ADR（`adr-022-executor-agent-arbitrary-code.md`）
- 用**权限档位**承载这个变化（[09](./09-permission-profiles.md)），而不是一个硬编码的「允许/禁止」
- 明确「Agent 拥有宿主用户权限」这一固有属性（[07 §5](./07-executor-agent.md) 末警告）

**建议 P7a 作为 spike 先跑**——两周内就能知道这个设想在真实环境里是否成立，不必等全部做完。

### 9.3 权限档位的实现顺序（[09 §6](./09-permission-profiles.md)）

不必一次做完所有档位：

| 子阶段 | 实现的档位 |
|---|---|
| P7a | `minimal` + `standard`（`off`/`sandbox` + `process` + `deploy-only`） |
| P7b | 加 `sandboxBackend=container` |
| P7c | 加 `hostAccess=app-scoped`（白名单化） |
| P7d | 加 `taskExecution=isolated-runner` |
| 后续 | `session` / `vm` / `full-trust`（**按真实企业需求再定**） |

**建议先不实现 `session` 与 `full-trust`**——风险最高、需求最不确定。等有真实企业提出需求时再做，届时也更清楚要加什么护栏。

### 9.4 P7a 状态（2026-09 落地；同日续批接真实执行体）

> **产物**：`apps/executor-desktop/src/main/agent/`（`perception.ts` / `workspace.ts` /
> `permission-profile.ts` / `gates.ts` / `loop.ts` + 续批 `trial-run.ts` / `collab-client.ts` /
> `runtime.ts`）+ **八套** selftest 接进 `npm run test:main`；权限档位接进
> `config-store.ts` + `config-sanitize.ts` 消毒层；admin-api 新增 LLM relay 端点
> （`POST /agent-collab/llm`）。

| 任务 | 产出 | 状态 |
|---|---|---|
| 环境探测 | `collectEnvironmentReport()`（OS/资源/python·python3·node + 能力域自述） | ✅ |
| workspace 沙箱 | `<workDir>/agent-workspace/<assignmentId>/`，路径域校验 + symlink 不跟随 | ✅ |
| 权限档位 | 四轴 + 五预设，P7a 实现 `minimal`/`standard`；`min(本地, 中台)` 合并 | ✅ |
| 硬闸门 | 迭代 15 / 墙钟 2h / 澄清 5 / 试跑 30 / 依赖安装 10（07 §7.1） | ✅ |
| 迭代循环 | 感知→规划→试跑→诊断状态机 | ✅ |
| **LLM 接入（续批）** | `POST /agent-collab/llm` relay——**API key 不出服务端**，令牌消耗记中台 metrics；`CollabClient`（node:http，超时/非 2xx/坏 JSON 全收敛为 `{ok:false}`） | ✅ |
| **真实试跑执行体（续批）** | `runTrialInSandbox`——process 沙箱：解释器封闭枚举（python/python3/node）、env 白名单（凭据零透出 + `PYTHONUTF8=1` 强制，I18N-01 教训在源头掐断）、cwd 锁定工作区、超时/输出上限 | ✅ |
| **SOP 验收执行（续批）** | acceptance `kind=command` 经沙箱跑（`<interpreter> <工作区脚本>` 封闭形态）；无 acceptance / `-c` 内联形态**如实判不可验证**，绝不默认通过 | ✅ |
| 浏览器能力 | — | ⏳ P7b（能力域**如实**只报 `filesystem`/`http`） |

### 实现中的关键判断

| 判断 | 理由 |
|---|---|
| **闸门在动作**之前**判，不在末尾判** | 末判会让最后一轮的副作用（可能已写文件、已跑代码）先发生再被拦，闸门形同虚设。测试钉死「恰好跑满上限、不多跑一轮」——反证：`>=` 改 `>` 立即红（实测允许 16 次） |
| **墙钟自首次迭代起算，resume 不重置** | 挂起/恢复是常态（等澄清回复、等审批）。重置等于「2 小时上限」可反复续命 |
| **档位闸独立于次数闸，且在试跑之前** | 次数闸管「还能跑几次」，档位闸管「允许不允许跑」。只查一道必漏：off 档下次数再富余也不该跑。**off 是高合规企业唯一会选的档**，绕过它该档就只是一句注释 |
| **触顶是合法终态，不是异常** | 返回完整结果带 `stopReason`，不抛。中台要能区分「机器做不了」与「程序崩了」，才能决定换机器还是转人工 |
| **澄清触顶转人工且不再调 plan** | 两个 Agent 的「礼貌循环」是真实风险（P6 已在中台侧设硬闸）。转人工分支不进下一次规划，不烧令牌 |
| **能力域不得超前声明** | 未实现浏览器就**不能**报 `browser`——否则中台的可行性预检（10 §建议2）会把需要浏览器的 SOP 派过来，然后卡在这台机器上 |
| **档位默认 `minimal` 而非 `standard`** | ADR-022 是信任模型变更，必须「显式开启」。旧配置文件没有这些键，升级**不得**凭空获得「在本机试跑生成代码」的能力。09 §7 的「默认是否改 standard」一旦拍板只改 defaults |
| **档位枚举必须进消毒层** | conf 15 移除 JSON schema 后坏值**静默落盘**：`sandbox` 拼成 `sandox` 不报错、界面照常显示、解析层却回落到最保守档——「配置看起来生效了、行为却是另一套」且零日志（09 §4.1 点名）。故写入前归一化非法值为 `''`（= 不覆盖，跟随预设），**不删键**（删键 = 保留旧值，界面无法反映「刚选的没生效」） |
| **LLM 走中台 relay 而非本地带 key** | key 不出服务端（客户端被入侵不泄露 LLM 凭据）；令牌记中台 metrics 可归因；企业只需在中台配额，不必逐台下发 key。provider 未启用时中台 fail-open 透传空 content，执行器按「模型不可用」降级——不掩盖 |
| **`host` 档如实拒绝而非静默降级** | 部署方选 host 是想要更强能力；静默按 sandbox 跑 = 「以为开的是 A、实际行为是 B」。未实现档位宁可报「尚未实现」 |
| **LLM 诊断动作显式映射，绝不 `as` 强转** | LLM 说 `clarify`、循环语义是 `needs_clarification`——两个名字强转能过编译但**语义错位**：「请求澄清」静默变 retry，继续烧轮次、中台永远收不到澄清（续批 selftest 实测抓出的真缺陷） |
| **无 acceptance 的 SOP 绝不 delivered** | 验收是唯一目标锚点（07 §6），锚点缺失时「跑通了就算交付」= 验收语义归零 |

### 自检抓出的真实缺陷（非预置，写测试时发现）

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| 1 | `listWorkspaceFiles` **跟随 symlink** | `resolveWithinWorkspace` 只校验**输入**路径、管不到 walk 到达的路径——工作区里一个指向域外的链接就把域外文件列进了 Agent 观察面，沙箱可见性边界被悄悄扩大 | 遇 `isSymbolicLink()` 跳过，不跟随也不列出 |
| 2 | `resolveWithinWorkspace` 内 `realpathSync(workspaceRoot)` 在工作区不存在时抛 ENOENT | 打破本模块「返回 `ok:false`、**绝不抛**」的契约——调用方是 LLM 驱动的路径解析，抛出去即一次会话崩溃（`workDir` 指向已清理目录即触发） | catch 后收敛为 `{ ok:false, error:'agent workspace does not exist' }` |
| 3 | LLM 诊断动作 `as LoopNextAction` 强转（续批） | LLM 的 `clarify` 与循环的 `needs_clarification` 名字不同，强转通过编译但语义错位：「请求澄清」静默变 retry，继续烧轮次、澄清永不上报 | 显式映射表 + 未知名如实抛协议违规（outcome=error） |

### 验收（P7a 批次 + 续批）

- ✅ `npx tsc -p tsconfig.json --noEmit` 与 `-p tsconfig.selftest.json` 均 0 错误
- ✅ `npm run test:main` 20 套全绿（含 agent 八套：perception / workspace / permission-profile / gates / loop / **trial-run / collab-client / runtime**）
- ✅ 反证均有牙：删档位闸 / `>=`→`>` / 恢复 symlink 跟随 / 去枚举消毒 / 诊断动作错映射，逐一实测转红
- ✅ admin-api relay：`agent-sop-check.mjs` 64 项全绿（新增 6 项 relay 断言：端点存在、agent:sop 能力闸、messages 条数/单条上限、role 白名单、AiModule 装配）
- ✅ `check:lint-gates` 绿；`check:desktop-bundle-drift` 摘要一致（未触碰 bundle）
- ⏳ 端到端 spike（07 §9：真实 SOP + 真实 LLM 验证「通用 Agent 自主实现」是否成立——需 DashScope 账号）
- ⏳ 试跑超时的进程树残留（→ P7b 已修，见 §9.5）
- ⏳ 默认预设 `standard` 与否待拍板（09 §7）

### 9.5 P7b 状态（2026-09 落地：浏览器能力 + 媒体回传 + 托管）

> **产物**：desktop `agent/kill-tree.ts`（跨平台树杀）、`agent/browser.ts`
> （Playwright 封闭动作枚举）、`agent/agent-host.ts`（指派托管）、`collab-client.uploadMedia`、
> runtime 协议接入 browser 动作；admin-api `agent_media` 表（迁移 `1790000000042`）+
> 媒体上/下载端点；`agentEnabled` 总开关（默认 false）接进 config-store/消毒层/index.ts。
> 自检 +2 套（kill-tree / agent-host 端到端），desktop `test:main` **24 套全绿**。

| 任务 | 产出 | 状态 |
|---|---|---|
| 浏览器能力 | `AgentBrowserSession`：7 个封闭动作（navigate/click/type/press/screenshot/extract_text/wait）+ **每次导航过域名白名单**（SOP constraints ∪ 权限档位，**空 = 全禁**）+ 全新临时 profile（不碰用户登录态，hostAccess=none 语义保持） | ✅ |
| 截图/录屏回传 | 截图/录屏落工作区 → `uploadMedia` 即传中台 → `mediaPath`（/api/agent-collab/media/<id>）供澄清 mediaRefs 引用；admin-api 落盘（uploads/agent-media，100MB 上限、归属校验、路径越界终检）+ ADMIN 下载端点 | ✅ |
| tree-kill | `spawnWithTreeTimeout`：POSIX detached 进程组 `kill(-pid)`、Windows `taskkill /T /F`；**修复 P7a 残差**「超时只杀单进程、孙进程泄漏」（selftest 实测孙进程死亡） | ✅ |
| Agent 托管 | `AgentHost`：poll → 能力上报（browser 按探测如实声明）→ 沙箱工作区 → **策略合并** → 循环 → 回报 completed/failed/澄清；单飞行防并发；`agentEnabled=false` 零动作 | ✅ |
| 总开关 | `agentEnabled`（默认 false，ADR-022 显式开启）+ 消毒层布尔纪律 + index.ts 轮询循环接线（30s tick，host 内部 0 等待） | ✅ |
| LLM 协议扩展 | plan/diagnose 可带 `"browser":[actions]`——先看页面再写代码；输出（页面文本/截图 mediaPath/录屏）进下一轮上下文 | ✅ |
| 桌面 GUI 能力 | — | ⏳ P7c |
| 端到端闭环 | — | ⏳ P7d |

### 实现中的关键判断

| 判断 | 理由 |
|---|---|
| **导航白名单空 = 全禁** | 白名单是浏览器的唯一边界（Playwright 沙箱不隔离网络）；SOP 没写 allowedDomains 就放行导航等于没有边界 |
| **全新 Chromium profile** | Playwright 启动的是临时 profile——不携带用户 cookie/登录态，因此 browser 能力**不**触碰 09 §2.3 的 hostAccess 档位语义（那是「操作已登录软件」）；两道闸独立，不互相冒充 |
| **`killed` 同步置位** | taskkill /F 后进程以 exit code 1 触发 close——异步等 killTree 回调会与 close 竞速，拿到 killed=false/exitCode=1 的失真快照；`timedOut` 时 exitCode 归 null（调用方以 timedOut 判定） |
| **媒体独立小表而非塞 artifacts** | artifacts 的 verifyUploadAuth 强绑 task_execution 执行行；Agent 媒体归属是 sop_assignments——造假 execId 或开特例都不可取 |
| **host 先在主进程内，重活全在子进程** | 07 §4.2 要独立子进程是为了不卡主进程；本实现里重计算已全在子进程（试跑 spawn 解释器、浏览器是 Chromium 子进程、LLM 是网络等待），host 本体只做 I/O 编排。host 本身拆子进程留 P7d 打包接线时一并处理——如实记录的阶段取舍 |
| **能力上报不超前** | browser 只在 `probePlaywright().available` 时声明——中台可行性预检据此派单，不会把需要浏览器的 SOP 派到没浏览器的机器上 |

### 验收（P7b 批次）

- ✅ desktop `test:main` **24 套全绿**（+kill-tree 9 项含「孙进程也死了」树杀实测 / +agent-host 17 项端到端：本地 http server 全真模拟中台的 poll/llm/progress/complete/clarifications）
- ✅ agent-host 端到端覆盖四条路径：completed / 澄清 / **中台压档 → 档位闸拒 → failed（本地 standard 没有偷偷试跑）** / 单飞行
- ✅ `agent-sop-check` 扩至 **72 项**（+8 媒体通道断言：端点、能力闸、归属校验、文件名封闭、大小上限、越界终检、mediaRefs 放行、迁移登记）
- ✅ 迁移守卫绿（87 个迁移注册）；tsc（desktop 双 tsconfig / admin-api）0 错误；lint 绿
- ⏳ 真实浏览器节（browser.selftest §5）在本机如实跳过（chromium 二进制未安装；`npx playwright install chromium` 后可跑）——跳过显式可见，不是假绿
- ⏳ 打包态 Playwright 浏览器分发（electron-builder extraResources）留 P7d
- ⏳ 托管状态进托盘/状态窗（UI 面）留 P7c

## 10. 立即可开工的建议

**本轮我建议先做 P0**，理由：

1. 完全独立，不依赖任何待定项
2. 立刻产生价值（你现在就要源码部署）
3. 是 P3 的前置（`doctor --json` 是 Agent 的 `run_doctor` 工具）
4. 风险最低，可以在等 Agent 设计定稿期间并行推进

P1（Qwen）同样可以并行——但它需要 DashScope 账号（[05 §6.1](./05-qwen-multimodal.md)）。

## 11. 决策状态（已收敛）

**全部决策已解决**。原先标为「必须你拍板」的 4 项安全决策，已按「企业场景 + 可选权限选项」重构为**权限档位**（[09-permission-profiles.md](./09-permission-profiles.md)）——它们变成企业部署时的配置项，各有保守默认值，不再需要你逐个回答。

### ✅ 已由你定案

| 决策 | 结论 |
|---|---|
| 执行器 Agent 范围 | 只加在客户端执行器（desktop）；python/node 执行器保持纯净 |
| 客户端 Agent 职责 | 不只「造」，也能直接执行任务 |
| Agent 交付形态 | 内置 executor-desktop |
| Qwen 接入 | 新增 `provider=qwen`，DashScope OpenAI 兼容端点 |

### ✅ 四项安全决策 → 企业权限档位

| 原决策 | 配置档 | 默认 |
|---|---|---|
| 任意代码执行 | `codeExecution`：`off`/`sandbox`/`host` | `sandbox` |
| 沙箱强度 | `sandboxBackend`：`none`/`process`/`container`/`vm` | `process` |
| 操作已登录软件 | `hostAccess`：`none`/`app-scoped`/`session` | `none` |
| 直接执行任务 | `taskExecution`：`deploy-only`/`isolated-runner` | `deploy-only` |

企业从 5 个预设（`minimal`/`standard`/`developer`/`ops-assist`/`full-trust`）中选一个即可。

### ✅ 已由我自主分析定案

| 项 | 决定 |
|---|---|
| Agent 身份 | 新增 `agent@system` + `AGENT` 角色 |
| `approve_deployment` | **硬编码禁用** |
| 审批方案 | 复用 DEP-04（方案 C） |
| 中台 Agent 预算 | 并发 2 / 每日 5M 令牌 |
| SOP 存储 | DB 为主 + 可选导出 Git |
| SOP 首发审批 | 必须人工 |
| `maxRounds` | 5 |
| 媒体存储 | artifacts 模块 + 7 天保留 |
| 无 Docker 生产环境 | 不支持（`--infra external`） |
| 多机部署 | P0 不做，后续 `--role center\|executor` |
| 会话保留 | steps 30 天 / tool_calls 90 天 |

### ⏳ 唯一待确认

**默认预设 `standard` 是否符合预期**——它意味着开箱即用时 Agent 能自己试跑验证，但**不能操作你已登录的系统**（需显式升到 `ops-assist`）。

### 仍待补的外部前提

| # | 项 | 出处 |
|---|---|---|
| 1 | DashScope 账号与配额是否就绪 | [05 §6.1](./05-qwen-multimodal.md) |
| 2 | `qwen-vl-max` vs `qwen-vl-plus`（需实测） | [05 §6.4](./05-qwen-multimodal.md) |

## 12. 与项目既有开发纪律的衔接

本项目有明显的工程纪律（从代码注释可见），新功能必须遵守：

| 纪律 | 体现 | 本设计如何遵守 |
|---|---|---|
| **契约单一事实源** | `packages/executor-protocol` 双生成器 | SOP front-matter schema 应同样"单一事实源 + 生成" |
| **文档同步** | `docs/atlas/` 每个模块一份 | Agent/SOP 模块需新增 atlas 文档 |
| **枚举漂移守卫** | `scripts/check-enum-drift.mjs` | 新增 `AGENT` 角色、`provider=qwen`、SOP status 枚举需同步 |
| **迁移守卫** | `scripts/check-migrations.mjs` | 三个阶段的迁移需按序编号 |
| **验证文化** | 大量 `VERIFY-*.md`、`DEEP_REVIEW_*.md` | 每阶段结束产出 `VERIFY-agent-P*.md` |
| **ADR** | `docs/adr/` 18 个 | Agent 架构、SOP 协议、边界模型各需一份 ADR |
| **fail-open 主链** | 现有 AI 全链路 | Agent 单向依赖，绝不回灌主链 |

**建议新增 ADR**：
- `adr-019-center-agent-runtime.md`（Agent 运行时与隔离）
- `adr-020-agent-boundary-model.md`（工具分级与边界闸门）
- `adr-021-sop-as-executable-contract.md`（SOP 文档+契约分离）
