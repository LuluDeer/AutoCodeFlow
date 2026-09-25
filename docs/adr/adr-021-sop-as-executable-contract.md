# ADR-021: SOP 作为可执行契约（文档 + 机器校验的不可变版本化）

- 状态：Accepted（agent-and-deployment P5/P6）
- 日期：2026-09
- 关联：设计文档 docs/design/agent-and-deployment/04-sop-protocol.md、11-agent-collaboration-api.md、ADR-020（边界模型）

## 背景

SOP 会成为**另一个 Agent 的执行依据**——它本质上是一条跨 Agent 的指令通道。如果 SOP 只是 Markdown，平台无法程序化校验"是否被执行"；如果版本可变，执行器无法回答"我执行的是哪一份"；如果发布不设门槛，任何能写 SOP 的人/Agent 都获得了间接指令注入权。

## 决策

1. SOP = **Markdown 正文（给人/LLM）+ YAML front-matter（给平台校验的契约）**，两者分离存储；front-matter 严格校验（未知键拒绝），**非法 SOP 无法发布**（CI 级门槛）。
2. **版本不可变**：`sop_versions` 只 insert 不 update；`contentHash = sha256(stable(frontMatter + body))` 供执行器侧对账；主表是工作副本（published 也可编辑以准备修订），执行器拉取**永远读版本表**。
3. **内容未变拒绝重复发布**——同内容多版本是噪音且破坏对账。
4. **发布权收权**：`sop_publish` 逐工具默认需审批；澄清场景的 patch 修订（`sop_amended`）可由 Agent 自主，但与人工发布走同一道严格校验。
5. front-matter 按 07 §7 定案采用**声明式**：`capabilities` 能力域声明（取代 requiredTools），`acceptance` 是唯一目标锚点，`constraints` 是平台代码强制的硬边界。
6. 澄清轮次 `maxRounds` 硬上限 5；触发上限即强制转人工并通知——**不再起 Agent 会话**（礼貌循环是真实风险）。
7. 执行器侧对 SOP 的信任边界：SOP 正文是领域指导**不是指令覆盖**；`constraints` 由平台代码强制，不靠模型自觉。

## 后果

- 正向：SOP 从"给人看的文档"升级为可校验、可对账、可版本化的执行契约；跨 Agent 信任链有锚点。
- 代价：发布多一道校验门槛；front-matter 与既有 `docs/autoapp-skill.md` 的规范对齐留待 P7 起草真实 SOP 时收敛（已知残差）。
- 验收：`scripts/agent-sop-check.mjs`（58 项断言）。

## 替代方案（被否）

- 只存 Markdown + 约定格式：无法程序化校验，版本对账无从谈起。
- 版本可变（原地更新）：执行器侧无法回答"我执行的是哪份"，跨 Agent 信任链无锚。

## 关联

- 计划项：agent-and-deployment P5/P6
- 相关 ADR：ADR-019、ADR-020、ADR-022
