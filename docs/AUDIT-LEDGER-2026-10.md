# 功能点审计台账（2026-10-02 起）

> 编排式逐域审计：每轮 ≤2 个 subagent 并行排查，审完即派修复，本地验证后进下一轮。
> 修复与审计产出均落工作区，**等用户确认后统一提交**（沿用既有纪律：只推 develop）。

## 功能点清单（审计顺序）

| 轮次 | 域 | 范围 | 审计 | 修复 | 状态 |
|---|---|---|---|---|---|
| R1 | executor 域（admin-api） | executor module 全量 + 未提交 RBAC 下放改动 | R1-A | R1-fix | 进行中 |
| R1 | admin-web Executor UI | ExecutorList/Detail/Wizard/Packages + api/executors.ts | R1-B | R1-fix | 进行中 |
| R2 | metrics 域 | metrics module + scraper guard（未提交 DI 修复） | R2-A | — | 待开始 |
| R2 | task/scheduler 域 | task module + block-strategy 闸门 + scheduler/cron/依赖/retry | R2-B | — | 待开始 |
| R3 | auth/users/RBAC/项目域 | auth/api-keys/users/project + ADR-013 | R3-A | — | 待开始 |
| R3 | SOP/Agent 协作域 | sop/agent/agent-collab 模块 + AgentSessionsPage/SopsPage | R3-B | — | 待开始 |
| R4 | application/deployment/package 域 | application + executor-package + AppDeploymentPage | R4-A | — | 待开始 |
| R4 | registry 域 | registry / registry-npm / registry-pypi + RegistryPage | R4-B | — | 待开始 |
| R5 | executor-node 执行器侧 | callback/pull/zip-safety/interpreters/heartbeat 等 | R5-A | — | 待开始 |
| R5 | executor-desktop 桌面端 | main/renderer/agent-host/config | R5-B | — | 待开始 |
| R6 | 横切面 | notification/audit/artifacts/task-template/OpenAPI 契约/i18n | R6-A/B | — | 待开始 |

## 发现与处置记录

### R1（进行中）

- R1-A executor 域（admin-api）— 已派发
- R1-B admin-web Executor UI — 已派发

（每条发现：编号 | 严重度 | 位置 | 摘要 | 处置）
