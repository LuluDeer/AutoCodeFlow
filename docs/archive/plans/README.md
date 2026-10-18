# 已完成的优化计划（archive/plans）

> **历史快照。** 这些计划编写于代码演进的不同时点，其中**约 55% 的条目在仓库中
> 早已实现**——若照文本直接实施，会造成重复实现、安全回归或破坏 CI 门禁。
> 当前的实施状态与裁定见 [INDEX.md](INDEX.md) 的「核验与实施状态」段。
>
> 返回 [归档区说明](../README.md) · 当前有效文档见 [文档中心](../../README.md)。

## 这批文档是什么

2026-10 做过一次全栈审计，产出 7 份优化计划（安全、前端 UX、桌面 UX、后端架构、
可观测性、开发者体验、部署运维），外加一份索引。计划本身写得很细，但**写完之后
代码仍在演进**，于是计划与现实的偏差越来越大。

后来做了一轮逐项核验（CodeGraph + 配置对账），把每一条目分成三类：
已实现 / 真缺口 / 建议不采纳。核验结论与理由都写在 [INDEX.md](INDEX.md) 里。

## 怎么用这批文档

| 你想做的事 | 正确做法 |
|---|---|
| 想知道某个优化项做没做 | 先看 [INDEX.md](INDEX.md) 的核验表，**不要**直接照计划文本实施 |
| 想提一个新的优化方向 | 在 [PLAN-CLAIMS.md](../../PLAN-CLAIMS.md) 开新行，不要改历史快照 |
| 想理解某个设计为什么是现在这样 | 查 [ADR](../../adr/README.md)，那里是**已拍板**的决策 |

## 目录

| 文档 | 主题 |
|---|---|
| [INDEX.md](INDEX.md) | 计划索引 + 2026-10-17 逐项核验与实施状态（**先读这篇**） |
| [security-hardening.md](security-hardening.md) | 安全加固 |
| [frontend-ux-improvements.md](frontend-ux-improvements.md) | 前端用户体验 |
| [executor-desktop-ux.md](executor-desktop-ux.md) | 桌面执行器体验 |
| [backend-architecture.md](backend-architecture.md) | 后端架构与性能 |
| [observability.md](observability.md) | 可观测性与监控 |
| [developer-experience.md](developer-experience.md) | 开发者体验 |
| [deployment-ops.md](deployment-ops.md) | 部署与运维 |
| [development-plan-2026-09.md](development-plan-2026-09.md) | 2026-09 开发计划（已清偿） |
| [development-plan-2026-09h2.md](development-plan-2026-09h2.md) | 2026-09 下半期计划（已清偿） |
| [windows-testing-plan.md](windows-testing-plan.md) | Windows 深度测试任务书（已执行完） |
| [a11r-deploy-agent-prompt.md](a11r-deploy-agent-prompt.md) | A-11R 部署代理提示词（一次性） |

> 当前期计划仍在维护，不在归档区：
> [DEVELOPMENT-PLAN-2026-10.md](../../DEVELOPMENT-PLAN-2026-10.md)。
