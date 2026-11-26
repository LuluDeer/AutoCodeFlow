# AutoCodeFlow 文档中心

> 本文件是 `docs/` 的**唯一入口**。按「我要做什么」找路径，不要凭文件名猜。
> 当前发布：**v2.3.0**（2026-11-22）· 桌面 **desktop-v1.12.1** · 最后核对：2026-11-23 · 维护规则见文末。

---

## 一、按角色选路线

| 你是谁 | 从这几篇开始 |
|---|---|
| **第一次接触项目** | 先跑 `./scripts/demo.sh`（隔离端口 + 自动 seed）→ [快速上手](quickstart.md) → [路线图](ROADMAP.md) → [产品总览](atlas/00-overview/01-product-overview.md) → [核心概念](atlas/00-overview/05-core-concepts.md) |
| **要部署到生产** | [部署指南](deployment.md) → [运维手册](operations.md) → [发布检查清单](release-checklist.md) |
| **要开发后端模块** | [开发指南](development.md) → [新增 API 模块](atlas/08-workflows/add-new-api-module.md) → [数据实体](atlas/03-data/README.md) |
| **要开发前端页面** | [开发指南](development.md) → [新增 Web 页面](atlas/08-workflows/add-new-web-page.md) → [admin-web 拆解](atlas/01-apps/admin-web/README.md) |
| **要接 SDK / CLI / MCP** | [SDK 指南](sdk-guide.md) → [CLI 用法](atlas/05-interfaces/cli.md) → [MCP 工具](atlas/05-interfaces/mcp-tools.md) |
| **要排查线上问题** | [运维手册·故障排查](operations.md) → [已知问题](atlas/08-workflows/troubleshooting/known-issues.md) → [可观测性](observability/README.md) |
| **AI Agent 接任务** | [任务认领板](PLAN-CLAIMS.md) → [任务卡规范](atlas/08-workflows/task-board/README.md) → [会话交接](AGENT_HANDOFF.md) → [多 Agent 审计循环](AGENT-SWARM-PLAYBOOK.md) |

---

## 二、文档地图

### 2.1 主文档（长期维护，改代码要同步改）

| 文档 | 内容 |
|---|---|
| [quickstart.md](quickstart.md) | 一键 demo（隔离栈，首次 3–8 分钟构建镜像 / 之后 ~30 秒）+ 手动 Docker / 源码路径 |
| [ROADMAP.md](ROADMAP.md) | 开源路线图：定位 / 当前阶段 / P0-P2 / 指标 / 不做清单 |
| [deployment.md](deployment.md) | 部署形态、环境变量、升级与回滚 |
| [UPGRADING.md](UPGRADING.md) | **升级手册**：v1.15.0 → v2.0.0 迁移矩阵与破坏性变更（SEC-1/2/3），以及 v2.0.0 → v2.3.0 增量收口与回滚判据 |
| [RELEASE-NOTES-ssrf-posture.md](RELEASE-NOTES-ssrf-posture.md) | SSRF 出站闸姿态收紧的发版公告（运维向，已随 v2.3.0 发布） |
| [operations.md](operations.md) | 日常运维、备份恢复、扩容、故障排查 |
| [health-baseline.md](health-baseline.md) | **全仓健康基线**（四端全量 + 全链 + 度量，`npm run health:snapshot` 生成，勿手改数字） |
| [development.md](development.md) | 本地开发、测试、代码规范 |
| [sdk-guide.md](sdk-guide.md) | 双 SDK 能力矩阵与用法 |
| [api-reference.md](api-reference.md) | REST 端点契约、认证、错误码 |
| [app-development-guide.md](app-development-guide.md) | 应用与任务脚本开发 |
| [release-checklist.md](release-checklist.md) | 发版逐项核对 |
| [rollback-semantics.md](rollback-semantics.md) | 两种 rollback 端点语义对照 |
| [SECURITY-REDLINE-CHECKLIST.md](SECURITY-REDLINE-CHECKLIST.md) | 安全红线回归清单 |
| [compliance-baseline.md](compliance-baseline.md) | 合规基线：等保映射、日志留存、分类分级、公有模型出域与待补项 |
| [DEPENDENCY-REVIEW-LOG.md](DEPENDENCY-REVIEW-LOG.md) | 依赖审计豁免的到期复查记录（常设追加） |
| [AGENT-SWARM-PLAYBOOK.md](AGENT-SWARM-PLAYBOOK.md) | 多 Agent 审计-修复循环：五域划分 / 写冲突规则 / 验证矩阵 / 未修项 backlog |

### 2.2 架构图谱（Atlas — 一棵树、多个小文件）

[`atlas/`](atlas/README.md) 是全项目结构 / 功能 / 关系的彻底拆解，按目录分九层：

| 目录 | 覆盖 |
|---|---|
| [00-overview](atlas/00-overview/) | 产品定位、系统架构、仓库布局、技术栈、核心概念 |
| [01-apps](atlas/01-apps/) | 7 个应用逐一拆解（admin-api / admin-web / 三执行器 / 双私服） |
| [02-packages](atlas/02-packages/) | `packages/*` 全部可复用包 |
| [03-data](atlas/03-data/) | 数据实体逐一拆解 + 迁移机制 + ER 图 |
| [04-flows](atlas/04-flows/) | 跨服务关键流程（时序图） |
| [05-interfaces](atlas/05-interfaces/) | REST / MCP / CLI / SDK 对外接口地图 |
| [06-infra](atlas/06-infra/) | 部署、compose、CI、环境变量、脚本 |
| [07-testing](atlas/07-testing/) | 测试策略与各应用测试 |
| [08-workflows](atlas/08-workflows/) | 面向人的工作流、任务板、故障记录 |

### 2.3 设计文档

| 目录 | 内容 |
|---|---|
| [adr/](adr/README.md) | 架构决策记录（ADR-001 ~ ADR-039），**改架构前必读** |
| [design/agent-and-deployment/](design/agent-and-deployment/README.md) | Agent 与部署设计（14 篇，含执行器 GUI 跨平台） |
| [design/desktop-self-contained-runtime/](design/desktop-self-contained-runtime/DESIGN.md) | 桌面端自包含运行时 |
| [design/python-task-upload-and-multiversion/](design/python-task-upload-and-multiversion/) | Python 任务上传与多版本 |
| [requirements/](requirements/python-task-upload-and-multiversion/REQUIREMENTS.md) | 需求文档（Python 任务上传与多版本） |
| [../design-system/brand/](../design-system/brand/README.md) | 品牌视觉资产：标志 / README 首图 / 架构图 / 桌面图标的生成方式与色板约束 |

### 2.4 运维与可观测性

| 文档 | 内容 |
|---|---|
| [observability/README.md](observability/README.md) | Prometheus 抓取、Grafana、告警规则与 runbook |
| [observability/alerting-rules.yml](observability/alerting-rules.yml) | 告警规则事实源（脚本会读取校验） |
| [observability/grafana-dashboard.json](observability/grafana-dashboard.json) | Grafana 面板 |
| [ARCH-MULTI-INSTANCE-MATRIX.md](ARCH-MULTI-INSTANCE-MATRIX.md) | 多实例行为矩阵 |
| [DB-LEAST-PRIVILEGE.md](DB-LEAST-PRIVILEGE.md) | 数据库最小权限角色方案 |
| [CAPACITY-WHITEPAPER.md](CAPACITY-WHITEPAPER.md) | 容量边界白皮书 |
| [QA-05-capacity-boundaries.md](QA-05-capacity-boundaries.md) | 容量与压测本机参考基线 |

### 2.5 教程

[`tutorials/`](tutorials/index.md) — 五篇按真实上线顺序编排，可独立阅读也可连读。

### 2.6 开发流程与协作

| 文档 | 内容 |
|---|---|
| [DOCS-STYLE.md](DOCS-STYLE.md) | **文档写作与维护规范**：分层 / 文首三行 / 版本与日期 / 链接 / 图片 / 术语 / 归档 / 提交前检查 |
| [PLAN-CLAIMS.md](PLAN-CLAIMS.md) | **多会话并行认领唯一事实源**（含迁移时间戳分配表）；历史轮次/里程碑/审计复盘已迁至 [plan/rounds/](plan/rounds/README.md) |
| [OPEN-DECISIONS.md](OPEN-DECISIONS.md) | **待决策清单**（需人拍板的事，带证据出处与选项代价；不含已完成工作） |
| [PROJECT-STATUS.md](PROJECT-STATUS.md) | **项目状态总览**（R290–R475 共 73 轮收口快照：交付地图 / 验证数字 / 未决项 / 发布与接手指引，已随 v2.3.0 合入 `main`） |
| [plan/ttfv-funnel-instrumentation.md](plan/ttfv-funnel-instrumentation.md) | **TTFV 首次成功漏斗埋点方案**（安装→首成功的事件模型/口径/隐私/分阶段落地） |
| [plan/approval-lost-wakeup-fix.md](plan/approval-lost-wakeup-fix.md) | R296 审批 granted 丢失唤醒竞态的专项修复方案（方案穷举/反证/实施/验收；R322/R323 已按 E-pure+独立 dedup 命名空间落地，真库验证闭环） |
| [plan/north-star-business-confirmed.md](plan/north-star-business-confirmed.md) | R324 北极星「被业务确认」判据 PM 拍板（严格判据 D / 双口径过渡 / 隐私解耦；纯决策文档） |
| [plan/north-star-enablement.md](plan/north-star-enablement.md) | **R329 北极星 / TTFV 生产启用 runbook**（发布前置：迁移 0101/0102 + SEC_SECRETS_KEY + 执行器指纹 + 授权/验证/隐私口径/故障表） |
| [plan/w4-retention.md](plan/w4-retention.md) | R451 W4 实例留存先行指标口径与可复算脚本（复用漏斗数据，零 DDL） |
| [plan/sop-success-rate.md](plan/sop-success-rate.md) | R452 SOP 成功率/人工接管率先行指标口径与可复算脚本（复用 SOP 数据） |
| [plan/metrics-health.md](plan/metrics-health.md) | R455 先行指标健康度判定（目标数字→机器可判，无样本不算达标） |
| [plan/metrics-health-collect.md](plan/metrics-health-collect.md) | R456 健康度采集入口（一条命令跑三指标→判定，fail-closed） |
| [scripts/north-star-health.mjs](../scripts/north-star-health.mjs) | R432 北极星体系健康自检（一条命令验表/事件/口径/API/看板/双闸，支持真库+静态） |
| [AGENT_HANDOFF.md](AGENT_HANDOFF.md) | 跨会话交接与状态快照 |
| [feature-dev-workflow.md](feature-dev-workflow.md) | 新功能开发 checklist |
| [audit-playbook.md](audit-playbook.md) | **常态化审计/优化编排手册**（每轮按同一条流水线推进：体检 → 选题 → 只读并发审计 → 主控复核 → 修复+反证 → 全量门禁） |
| [VERIFY-MATRIX.md](VERIFY-MATRIX.md) | 真机验证矩阵（按变更类型必跑） |
| [arch-28-workspace-evaluation.md](arch-28-workspace-evaluation.md) | **ARCH-28 评估报告**（内部参考）：monorepo 独立 lockfile / no-hoisting 现状量化与 workspace / turbo 二期评估 |
| [ARCH-28b-turbo-adoption.md](ARCH-28b-turbo-adoption.md) | **ARCH-28b 实测报告**（内部参考）：turbo 多包模式与 no-hoisting 冲突实测结论 + `check:no-hoisting` 守卫由来 |
| [vscode-launch.template.json](vscode-launch.template.json) | VSCode 调试配置模板 |
| [skills/](skills/README.md) | 面向 AI 助手的可复用任务规范（Python 任务包与官方任务模板清单） |
| [autoapp-skill.md](autoapp-skill.md) | **自动化应用开发 Skill（平台侧原文）**：供 AI 助手按真实字段与打包契约开发/上传/验证自动化任务包（与 `skills/python-task-package/` 同源） |

> 历史一次性独立验收报告（14 篇）、真机复演报告（3 篇）及 2026-10 旧期开发计划（[development-plan-2026-10.md](archive/plans/development-plan-2026-10.md)）已归档至 [`archive/reviews/`](archive/reviews/README.md)、[`archive/verifies/`](archive/verifies/README.md) 与 [`archive/plans/`](archive/plans/README.md)。

### 2.7 归档区

[`archive/`](archive/README.md) — 历史快照：一次性报告、已完成的优化计划、
轮次进度、会话交接、真机验证记录、事故复盘。**不随代码更新**，仅供追溯。

---

## 三、维护规则

0. **写作规范**：新建或大改文档先读 [DOCS-STYLE.md](DOCS-STYLE.md)（分层 / 文首三行 / 图片尺寸 / 术语 / 归档）。
1. **谁改谁更新**：改代码时同步更新对应文档，并在文首「最后核对」写日期。
2. **入口唯一**：新文档必须在本文件挂链，否则视为孤儿（CI 会检查）。
3. **不制造一次性文档**：报告类文档直接进 `docs/archive/`，不要放仓库根目录。
4. **链接必须可解析**：相对链接、无扩展名约定、目录 → README 三种形态都支持；
   死链由 `scripts/docs/check-docs.mjs` 在 CI 拦截。
   结构（单 H1 / 层级 / 空表格行）、新鲜度标记与代码围栏语言由
   `scripts/docs/check-doc-style.mjs` 拦截（同样在 `npm run test:docs` 里）。
5. **小文件原则**：单篇建议 80–200 行，超了就按子主题拆并挂链接。
6. **禁止编造**：路径、命令、接口必须与仓库实际一致；未核实的写 `> ⚠️ 待核实`。
