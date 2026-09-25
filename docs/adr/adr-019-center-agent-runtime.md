# ADR-019: 中台 Agent 运行时（常驻推理循环与资源隔离）

- 状态：Accepted（agent-and-deployment P2–P4）
- 日期：2026-09
- 关联：设计文档 docs/design/agent-and-deployment/02-agent-architecture.md、ADR-020（边界模型）、ADR-021（SOP 契约）

## 背景

平台需要一个**常驻的、能自主调工具的**中台 Agent（运维巡检、事件处置、SOP 编排）。既有 ai 模块是「一次 prompt → 一次 response」的函数，装不下多轮 tool-calling；mcp-server 是 stdio 单次进程，不能常驻。

## 决策

1. Agent 内置于 admin-api（`modules/agent`），**不新增部署单元**；源码部署即生效。
2. 推理循环**可重入**：每轮「消息 → 模型响应」全量落库（`agent_steps`），进程重启与挂起恢复走同一条从 DB 重建 messages 的路径。
3. **独立 BullMQ 队列** `agent-jobs`，并发固定 2，不与 `task-queue` 混排——Agent 是 LLM 长调用负载，混排会让一个卡住的会话拖住任务派发。
4. **预算四道闸门**（steps/tokens/wallClock/toolCalls）在**循环开头**判定；用量累加与 step 写入同事务；`startedAt` 只在首次置位（resume 不重置墙钟）。
5. 对未预期异常**不重抛**（BullMQ 重试会重复已发生的副作用）。
6. 与主链单向依赖：Agent 依赖 ai/task/executor/application，**不被任何业务模块依赖**——Agent 失败绝不回灌调度/执行主链。

## 后果

- 正向：运维 Agent 价值落地；会话/步骤/工具调用全量可审计可复盘。
- 代价：admin-api 进程内多了一个会烧令牌的常驻组件；配额、成本可视化的看板（设计文档 10 §建议4）尚未实现，为已知残差。
- 验收：`scripts/agent-runtime-check.mjs`（66 项运行时断言）。

## 替代方案（被否）

- 独立进程/独立服务：多一个部署单元，且要给 Agent 签发跨进程凭据（泄露面）。
- 塞进 mcp-server：stdio 生命周期由外部 AI 控制host，无法常驻。

## 关联

- 计划项：agent-and-deployment P2/P4
- 相关 ADR：ADR-020、ADR-021
