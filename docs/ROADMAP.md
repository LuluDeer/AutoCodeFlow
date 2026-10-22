# AutoCodeFlow Roadmap

> 面向开发者的开源路线图。最后更新：2026-10-22。
> 目标不是「功能更多」，而是「**开发者 10 分钟内跑出第一个结果，并且愿意把第二件事交给它**」。

## 定位

**AutoCodeFlow 是开源的自动化执行运行时**：定时脚本、桌面操作和 AI Agent 共用一张可审计的调度台。

- 稳定的交给脚本：Cron / 固定频率 / Webhook / DAG，JS / Python / Shell。
- 长尾的交给 Agent：SOP 描述目标与验收，执行器 Agent 在真实机器上完成（桌面 GUI / 浏览器 / 脚本），并留下证据。
- 跑在你的网里：执行器 Pull 任务，不需要公网入站端口；私有 npm / PyPI 可用。
- 一切可审计：试跑、审批、版本、日志、产物。

**不是**：托管 SaaS、Spark/Flink 级大数据引擎、纯 RPA 商业套件。

## 当前阶段：激活闭环（2026-10）

已完成：

- [x] 一条命令的隔离 demo：`./scripts/demo.sh`（自动 `.env.demo`、随机口令、Node + Python 执行器、seed、首跑校验）。
- [x] 5 个官方任务模板开箱即跑（内联 `glueSource` + 幂等迁移）。
- [x] 控制台「使用模板」直接实例化，不再卡在 entrypoint 必填。
- [x] 管理员密码重置脚本（pgcrypto bcrypt + 吊销会话），替换会锁死账号的旧文档。
- [x] 开发者叙事：README 首屏、竞品对比、适用/不适用、桌面 Agent 演示。
- [x] Linux X11 GUI 驱动 demo（`./scripts/demo-desktop-gui.sh`，Xvfb，无需 Docker/LLM）。
- [x] 桌面 Agent 端到端 demo（`./scripts/demo-desktop-agent.sh`：SOP → plan → GUI → 试跑 → acceptance → delivered）；默认 mock-plan，`ACF_LLM_*` 可接真实 provider，已用 `deepseek-v4.1-flash-1017` 跑通。
- [x] Headless 执行器 Agent 闭环（`scripts/demo-headless-agent.mjs`：真实 SOP 指派 → `AgentHost` → 中台 LLM relay → 试跑 → 验收 → completed）；真机暴露并修复了 agent-collab DTO 校验 400 与响应信封未拆两个阻断缺陷。
- [x] 多模态 relay：`/agent-collab/llm` 接受 text + `image_url`（http 或 inline `data:image/png;base64`）；runtime 默认把 GUI 截图 inline 附到下一轮（>1.5MB 才回落 `mediaBaseUrl`）。真模型已直接读出截图中的 `gui-demo-ok`。
- [x] 截图诊断闭环：`demo-desktop-agent-diagnose.sh` 先输入 wrong-token，真实模型看截图后清空并修正，2 轮/2 次试跑达到 delivered。
- [x] 中台 ops Agent：`demo-ops-agent.mjs` 在 `ops_watch` 会话里真实调用 `get_execution_stats` / `list_executions` / `get_execution` / `get_execution_logs` / `get_task`，给出可执行的失败归因与建议。
- [x] 瞬态 LLM 失败重试：中台 Agent 与执行器 `chatJson` 各重试一次（仅 transport/`ok:false`，无工具副作用）；selftest 覆盖“失败一次→成功”和“连续失败→如实报错”。
- [x] 中台 Agent 会话上下文注入 + `list_tasks` 紧凑投影：真模型实测 1 次工具调用完成 3 个任务统计（此前 context 被忽略、工具结果截断导致 7 次重复调用）。
- [x] 修复 GUI 截图格式：临时文件保留 `.png` 并校验 PNG 签名，不再把 PostScript 当 PNG。

## P0（下一轮，正确性优先）

| 任务 | 为什么 | 验收 |
|---|---|---|
| **bwrap 默认策略收口** | 基础 compose 默认直跑；`docker-compose.secure.yml` 显式 opt-in。镜像已安装 bwrap，宿主需允许非特权 userns | `npm run test:compose-sandbox` 全绿；默认 `docker compose up` 的 Python 任务成功；secure overlay 在满足前置的宿主机上 bwrap 可用，否则 fail-closed |
| **Node / Python SDK 文档真实性** | README 曾暗示 Glue 脚本有全局 `ctx`，实际必须显式引入 SDK；Glue 任务不安装 requirements | README / SDK 指南 / 示例一致；新增一个「glue 无 SDK」反例测试或文档守卫 |
| **桌面 Agent 中台闭环** | 真实 provider 的 plan→GUI→trial→acceptance 已跑通；还缺中台 SOP 指派/审批与 Windows 真机 | 中台指派 → 澄清 → 审批 → 执行 → 中台验收全链；无 provider 时 mock-plan demo 仍可回归 |
| **Windows GUI 真机清单** | Windows 是桌面主战场；当前为 beta | focus/click/type/screenshot + 应用白名单在真实交互桌面逐项通过；锁屏/RDP 断开的边界写清楚 |

## P1（可运营 / 可分发）

- **首次成功漏斗**：记录 opt-in 的 TTFV（安装 → 首个成功执行），目标中位数 ≤10 分钟；demo 完成率。
- **3 个真实场景示例**：每日报表导出、内网巡检、桌面数据填报；每个含代码、依赖、凭据占位、告警。
- **CLI / MCP 一行接入**：`acf` 与 MCP 配置的复制即用片段；MCP 工具收敛到高频集合，减少 LLM 选择成本。
- **异常接管台**：stalled / escalated 统一队列，运营视角一键接管，而不是只看 Agent 会话日志。
- **安装包瘦身**：桌面安装包按需下载 runtime；首装体积目标 ≤100MB。

## P2（按需求触发）

- 环境隔离（dev/staging/prod）与一键 promote。
- 漏跑监控、调度日历、SLA。
- K8s / 容器执行器（仅在有明确 design partner 需求时）。
- macOS GUI（Windows 主线验证后再评估）。

## 明确不做（当前阶段）

- 继续堆 MCP 工具数量 / 端点数量。
- 把企业 SSO/HA 当开源卖点（保留能力，不做叙事主线）。
- 桌面 V2 渲染层重写（已回退过一次）。
- 覆盖率棘轮、i18n 全量迁移、微基准作为路线图主项——归入维护预算。

## 指标

**北极星**：每周产生「业务结果」的自动化运行数（有产物 / 有证据 / 被业务确认），按活跃实例统计。

**先行指标**：

- TTFV 中位数 ≤10 分钟；
- 24h 激活率 ≥60%；
- 模板 → 成功转化率 ≥80%；
- W4 实例留存 ≥40%；
- 桌面 SOP 成功率 ≥90%，人工接管率 ≤10%；
- 社区：star / fork / 外部 contributor / issue 响应时间。

## 参考实现（只借鉴语义，不引入依赖）

这些项目的 loop / 终止 / 结构化输出实现被用来校准本仓的语义，但**没有**把它们的
运行时依赖引入执行器或 admin-api：

- [Vercel AI SDK `stopWhen` / `maxSteps`](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stop-condition.ts)：
  工具循环必须有可组合的停止条件；本仓对应 `gates.ts` 的迭代/试跑/墙钟闸门。
- [OpenAI Agents SDK](https://github.com/openai/openai-agents-python)：`MaxTurnsExceeded`
  与协议错误分类；本仓对应 `AgentRuntimeService` 的预算终态、`AgentLoopResult.stopReason`。
- [LangGraph `recursion_limit`](https://langchain-ai.github.io/langgraph/)：图执行的硬上限；
  本仓对应 `maxIterations` + 墙钟，不允许无限自我续跑。
- [LangChain `AgentExecutor`](https://python.langchain.com/docs/modules/agents/)：
  `max_iterations` / `early_stopping_method`；本仓对应澄清/升级终态，不静默重试。
- Vercel AI SDK `generateObject` 的 schema 失败处理：本仓 `runtime.ts` 的 `chatJson`
  在首次非 JSON 时带修复指令重试一次，仍失败则如实 `error`，不猜测语义。

结论：**保留自有的 DB 状态机、审批、审计与执行闸门；只借鉴终止条件、结构化输出
修复、重试与上下文压缩的语义。**

## 贡献

- 先跑 `./scripts/demo.sh`，再挑一个 P0/P1 任务开 issue。
- 每个 PR 必须说明：**用户证据、成功指标、不做的后果**。
- 代码规范、测试与提交约定见 [CONTRIBUTING.md](../CONTRIBUTING.md) 与 [development.md](development.md)。
