# AutoCodeFlow 文档中心

> 本文件是 `docs/` 的**唯一入口**。按「我要做什么」找路径，不要凭文件名猜。
> 最后核对：2026-10-19 · 维护规则见文末。

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
| [quickstart.md](quickstart.md) | 60 秒 demo（一键隔离栈）+ 手动 Docker / 源码路径 |
| [ROADMAP.md](ROADMAP.md) | 开源路线图：定位 / 当前阶段 / P0-P2 / 指标 / 不做清单 |
| [deployment.md](deployment.md) | 部署形态、环境变量、升级与回滚 |
| [operations.md](operations.md) | 日常运维、备份恢复、扩容、故障排查 |
| [development.md](development.md) | 本地开发、测试、代码规范 |
| [sdk-guide.md](sdk-guide.md) | 双 SDK 能力矩阵与用法 |
| [api-reference.md](api-reference.md) | REST 端点契约、认证、错误码 |
| [app-development-guide.md](app-development-guide.md) | 应用与任务脚本开发 |
| [release-checklist.md](release-checklist.md) | 发版逐项核对 |
| [rollback-semantics.md](rollback-semantics.md) | 两种 rollback 端点语义对照 |
| [SECURITY-REDLINE-CHECKLIST.md](SECURITY-REDLINE-CHECKLIST.md) | 安全红线回归清单 |
| [DEPENDENCY-REVIEW-LOG.md](DEPENDENCY-REVIEW-LOG.md) | 依赖审计豁免的到期复查记录（常设追加） |
| [AGENT-SWARM-PLAYBOOK.md](AGENT-SWARM-PLAYBOOK.md) | 多 Agent 审计-修复循环：五域划分 / 写冲突规则 / 验证矩阵 / 未修项 backlog |

### 2.2 架构图谱（Atlas — 一棵树、多个小文件）

[`atlas/`](atlas/README.md) 是全项目结构 / 功能 / 关系的彻底拆解，按目录分七层：

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
| [adr/](adr/README.md) | 架构决策记录（ADR-001 ~ ADR-025），**改架构前必读** |
| [design/agent-and-deployment/](design/agent-and-deployment/README.md) | Agent 与部署设计（14 篇，含执行器 GUI 跨平台） |
| [design/desktop-self-contained-runtime/](design/desktop-self-contained-runtime/DESIGN.md) | 桌面端自包含运行时 |
| [design/python-task-upload-and-multiversion/](design/python-task-upload-and-multiversion/) | Python 任务上传与多版本 |
| [requirements/](requirements/python-task-upload-and-multiversion/REQUIREMENTS.md) | 需求文档（Python 任务上传与多版本） |

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
| [PLAN-CLAIMS.md](PLAN-CLAIMS.md) | **多会话并行认领唯一事实源**（含迁移时间戳分配表） |
| [OPEN-DECISIONS.md](OPEN-DECISIONS.md) | **待决策清单**（需人拍板的事，带证据出处与选项代价；不含已完成工作） |
| [AGENT_HANDOFF.md](AGENT_HANDOFF.md) | 跨会话交接与状态快照 |
| [DEVELOPMENT-PLAN-2026-10.md](DEVELOPMENT-PLAN-2026-10.md) | 本期开发计划 |
| [feature-dev-workflow.md](feature-dev-workflow.md) | 新功能开发 checklist |
| [audit-playbook.md](audit-playbook.md) | **常态化审计/优化编排手册**（每轮按同一条流水线推进：体检 → 选题 → 只读并发审计 → 主控复核 → 修复+反证 → 全量门禁） |
| [VERIFY-MATRIX.md](VERIFY-MATRIX.md) | 真机验证矩阵（按变更类型必跑） |
| [vscode-launch.template.json](vscode-launch.template.json) | VSCode 调试配置模板 |
| [skills/](skills/README.md) | 面向 AI 助手的可复用任务规范（Python 任务包等） |

### 2.7 归档区

[`archive/`](archive/README.md) — 历史快照：一次性报告、已完成的优化计划、
轮次进度、会话交接、真机验证记录、事故复盘。**不随代码更新**，仅供追溯。

---

## 三、维护规则

1. **谁改谁更新**：改代码时同步更新对应文档，并在文首「最后核对」写日期。
2. **入口唯一**：新文档必须在本文件挂链，否则视为孤儿（CI 会检查）。
3. **不制造一次性文档**：报告类文档直接进 `docs/archive/`，不要放仓库根目录。
4. **链接必须可解析**：相对链接、无扩展名约定、目录 → README 三种形态都支持；
   死链由 `scripts/docs/check-docs.mjs` 在 CI 拦截。
5. **小文件原则**：单篇建议 80–200 行，超了就按子主题拆并挂链接。
6. **禁止编造**：路径、命令、接口必须与仓库实际一致；未核实的写 `> ⚠️ 待核实`。
