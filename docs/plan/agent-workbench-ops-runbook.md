# 中台团队与 SLA runbook（N22 · 建议流程）

> **受众**：中台平台工程 / 能力审核 / Agent 训练师 / SRE 值班人员 · **状态**：草稿 · **最后核对**：2026-11-26
> 一页纸约定「谁做什么、多久内做完、拿什么验收」。**本 runbook 是建议流程，非已实现的系统能力**——仓库当前没有中台编制、能力审核流水线与 SLA 计量落点，下述角色 / 时限 / 证据均为待建契约，目标来源见 [N22 行](agent-workbench-strategy.md)。

---

## 1. 角色矩阵

| 角色 | 主责 | 关键动作 | 边界（不做） |
|------|------|----------|--------------|
| 平台工程 | 能力注册表、合并规则、resolve | 维护 capability key 命名空间；实现逐字段族合并与 `resolve` / `dump` 的运行时；发布前评审合并规则变更 | 不批准单个能力的业务准入 |
| 能力审核 | manifest、供应链扫描、backer 背书 | 校验 manifest 封闭键；跑依赖 / 供应链扫描；核对 owner + backer 双签；对高危能力要求版本钉死 | 不改运行时策略，不跳过四眼 |
| Agent 训练师 | 方案卡编译 prompt、注入规则迭代 | 维护 goal/cadence → 方案卡的编译 prompt 与反幻觉白名单；按失败样本迭代 IM 注入检测规则 | 不绕过审批直接发布能力 |
| SRE | 配额、代际、审计、故障 | 配配额与软硬阈值；管理方案卡 / 策略代际失效；值守审计查询与故障处置复盘 | 不私自放宽能力 scope |

> 角色名对齐 [N22](agent-workbench-strategy.md) 与 [N16 发布背书](agent-workbench-strategy.md)。同一人可兼多角，但「能力审核」与「能力发布者」必须分离。

## 2. SLA 契约

| # | 指标 | 时限 | 谁做 | 触发 | 验收证据 |
|---|------|------|------|------|----------|
| 1 | 能力审核 | **≤1 工作日（N22 硬指标）** | 能力审核 | 新 capability 提交 / manifest 变更 | 审核单含 manifest 校验结果、供应链扫描报告、backer 背书记录与通过时间戳；超时记一次 SLA 违约 |
| 2 | 配额告警响应 | ≤2h | SRE | showback webhook 报软 / 硬阈值 | 告警到认领 ≤2h，处置单关联配额调整动作与恢复时间 |
| 3 | 代际失效验证 | ≤1h | SRE + 平台工程 | 方案卡 / 策略代际切换 | 切换后 ≤1h 内核验旧 generation 的在途写入与通知已作废，并留审计条目 |
| 4 | 审计查询 | ≤5min | SRE | 业务 / 合规取证请求 | 从请求到导出审计结果 ≤5min，结果带查询条件与操作人 |

> 时限是**建议目标**，不是系统保证；仓库尚无 SLA 计时与违约告警实现，落地前需自建计量。

## 3. 值班流程

四步闭环：

1. **告警**：showback webhook 推送配额超限 / 能力异常；值班人认领并在处置单记认领时间。
2. **定位**：用能力用量统计（`capability-activation/stats`）与审计日志交叉查询，确认是配额、代际还是能力本身问题。
3. **处置**：按归因选一种动作——调整配额（软阈值告警 / 硬阈值降级）、`capability disable`（停用问题能力）、`key revoke`（吊销关联 API Key 并联动停用）；每步留操作人与时间。
4. **复盘**：在归因字段 `outcome` 回填根因与处置结果；超时项标注 SLA 违约并进下一轮改进。

> 端点与字段名（`capability-activation/stats`、`outcome`）为规划占位，以最终 API 与审计 schema 为准。

## 4. 交接与所有权

- **owner 离职**：按 [N16](agent-workbench-strategy.md) 的 `backer` 字段由 backer 所在部门继承所有权；无 backer 的能力视为孤儿，先补背书再移交。
- **能力移交步骤**：① 平台工程导出当前 manifest / 合并规则 / policy 快照；② 新 owner 与 backer 部门完成双签；③ 能力审核重跑供应链扫描并记录版本钉死；④ 更新注册表 owner/backer 字段并留审计；⑤ SRE 验证 `resolve` 结果与代际生效，确认无在途旧 generation 写入。

## 5. 与现有文档的关系

- 部署与环境：[operations.md](../operations.md)。
- 审计动作与日志查询：[audit-playbook.md](../audit-playbook.md)。
- 合规基线（N21）：[compliance-baseline.md](../compliance-baseline.md)。
- 目标与状态来源：[agent-workbench-strategy.md](agent-workbench-strategy.md) §12.3 的 N22 / N16 行。

---

## 当前缺口（为何是建议流程）

- 无中台角色编制与值班排班；四角职责为约定，未被系统强制。
- 能力审核无流水线与 SLA 计时；≤1 工作日仅为目标，无违约告警。
- 统计端点、归因字段、key 联动停用均为规划占位，尚未逐项落地。

> 以上缺口关闭前，本文不得作为「已交付能力」引用。
