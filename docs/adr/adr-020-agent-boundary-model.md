# ADR-020: Agent 工具分级与边界闸门（模型行为不可信，全靠代码层闸门）

- 状态：Accepted（agent-and-deployment P3–P5）
- 日期：2026-09
- 关联：设计文档 docs/design/agent-and-deployment/03-agent-tools-and-boundary.md、ADR-019（中台 Agent 运行时）

## 背景

Agent 能调工具 = 能改生产状态。模型输出是不可信输入（可能被提示注入、可能幻觉）；「让模型乖」不构成任何防线。需要一层**机制性的**边界：不是约定，是只有一条路径且路径上有闸门。

## 决策

1. **`ToolExecutorService.execute()` 是工具执行的唯一入口**，强制先过 `AgentBoundaryService.check()`——没有任何工具能绕过。
2. 五道检查**顺序固定**（白名单 → 硬禁用 → 参数 → scope → 速率熔断 → 分级审批），同一份输入恒得到同一个 verdict，`autoflow_agent_denied_total{reason}` 才可聚合。
3. 工具三级（read 31 / write 10 / dangerous 2）+ 逐工具 `approvalRequired` 位（如 `sop_publish`：发布权 = 间接指令注入权，**不随**全局写策略放宽而放宽）。
4. `approve_deployment` / `reject_deployment` **硬编码禁用且不暴露给模型**——DEP-04 双人原则是安全红线，不是可调参数。
5. 参数按不可信输入处理：必填/未知键/**递归**危险模式扫描（shell/换行/路径/SSRF/超长）。
6. 会话 `scopeJson` 交叉验证资源归属；**空 scope = 不可操作任何资源**（安全默认，null 语义被显式排除）。
7. `denied` 不消耗速率预算（否则越权尝试反而放大为对 Agent 的 DoS）。
8. `denied` 与 `awaiting_approval` 同样落库 `agent_tool_calls`——被拒的尝试是安全信号。
9. 写/危险 tier 的工具调用记录保留 ≥180 天（对齐审计保留期，设计文档 10 §调整5）。

## 后果

- 正向：Agent 的"自由"被限制在闸门之内；每次拒绝可归因、可告警。
- 代价：每次工具调用多一次闸门开销（可忽略）；工具集演进必须同时改注册表与白名单（有断言钉住）。
- 验收：`scripts/agent-boundary-check.mjs`（98 项，含 13 类红队用例）。

## 替代方案（被否）

- Prompt 层约束（"请勿调用危险工具"）：无机制保证，注入即穿透。
- 只在执行器侧设防：中台 Agent 与执行器 Agent 是两条注入通道，必须各自设闸。

## 关联

- 计划项：agent-and-deployment P3/P5
- 相关 ADR：ADR-019、ADR-021
