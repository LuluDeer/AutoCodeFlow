# ADR-041: 治理档位 × 引导强度正交

状态：Accepted
- 日期：2026-11-26

## 动机（背景与判据来源）

strategy §12.1 记录了两个方案的硬伤收敛：初稿把"治理档位"与"引导强度"写成"同一事物两面"，并出现三套并存命名（`managed/self_service/supervised`、`L1/L2/L3`、`managed/guided/author`）；更严重的是 GCO 默认 `L1 ≡ 治理 Managed`，与 strategy §5-B 的 `Supervised` 默认直接冲突（strategy §12.2 H1、GCO §11.1 G1）。经 opencode `permission/policy.ts:28-37,50-72` 与 red V2 的实证交叉，六方认账删掉"两面"表述，改判为两个**正交字段**。本仓的治理/引导相关落点分散：写面授权声名在 `@WriteGuard`（`apps/admin-api/src/common/decorators/write-guard.decorator.ts:79`，五档 scope），会话与 SOP 契约在 `SopFrontMatter`（`apps/admin-api/src/modules/sop/sop-frontmatter.ts:56`），桌面端亲和/调度另有 `ExecutorMode`（`apps/admin-web/src/pages/executor-mode.ts:8`）明确把正交约束与模式选择分开——这印证正交字段应各自独立建模，而不是塞进一个枚举。

## 决策（方案）

1. 定义两个**正交**字段，不相互推导：
   - `scope.mode`（治理维：谁能覆盖配置）：`managed`（中台锁定） / `supervised`（可见可收回，默认） / `self_service`（自行配置）。
   - `guidance.level`（引导维：谁编译、披露程度）：`L1` 托管 / `L2` 引导（默认） / `L3` 作者。
2. 合法组合矩阵（GCO §11.2）：
   - `managed ⇒ guidance ≤ L2`（`managed + L3` 非法：锁定却让业务直配，语义冲突）；
   - 危险能力 / 模型渠道 ⇒ `L1`；
   - 默认组合 **`Supervised + L2`**；`L3` 需中台授权；`self_service + L1` 合法但浪费。
3. 命名收敛为上述两套字段值，删除"同一事物两面"表述与 `managed/guided/author` 第三套叫法；凡出现档位收回的场景，方案卡自带 scope/guidance 版本号并在消费时比对（H4/G5），不靠当前 4 键指纹推断档位。
4. 两轴的强制机制不同、不得互相代替：`scope.mode` 走 ADR-040 的 managed policy 名单/策略引擎（不可 disable），`guidance.level` 走编译与披露流程（方案卡、反幻觉闸门 N7）；`WriteGuard` 的五档 scope 是端点授权声明，属另一维，不并入本矩阵。

## 影响面（后果与代价）

- 正向：默认组合唯一确定（Supervised+L2），消除"L1= Managed 还是 =强引导"的分叉；危险能力恒 L1、managed 恒不 L3 成为可断言的边界；档位收回可经版本号失效存量方案卡。
- 代价：两字段需在配置 schema、方案卡、能力解析、前端表单同时落地且保持一致；任何"用一个字段表达两件事"的旧代码/文案需改造。后续增量入口：新增 mode 或 level 取值必须同步更新矩阵与断言。
- 验收：组合矩阵以断言覆盖 3×3 全格（合法/非法/默认/危险能力特例），不靠文档表格人肉核对；外部证据按 §12.6 归属，不把 dsh/opencode/magpie 的特性挂到同一项目名下。

## 替代方案（被否）

- "同一事物两面"单一字段：导致 `managed + L3`、`self_service + L1` 这类真实合法组合无法表达，且默认与危险能力特例互相打架（H1 实证）。
- 保留三套命名（managed/self_service/supervised + L1/L2/L3 + managed/guided/author）：同一概念多叫法，方案卡、策略、UI 无法对齐。
- GCO 初稿默认 `L1 ≡ Managed`：与 Supervised 默认冲突（G1），且让危险能力的 L1 特例失去区分度。

## 回滚

- 两轴尚未落 schema 时，回滚 = 维持现状单一治理枚举，但必须同步回退 GCO §11 的"两面"表述，避免文档与代码分叉。
- 已上线后禁止把两个字段合并回一个枚举（会重新制造 H1 的非法组合无法表达问题）；只能按字段分别复位取值到合法组合 `Supervised + L2`，再逐项下线非法组合。
- 档位收回的版本号比对若误伤存量方案卡，回退"比对开关"而非矩阵本身；`agent-approvals.service.ts:55` 的 4 键指纹不参与档位推断，保持不动。

## 分步计划

1. 定字段：配置 schema 同时加 `scope.mode` 与 `guidance.level`，删除第三套命名与"两面"表述；provider 渠道治理对齐 `ai-providers.ts:42` 的 `AiProviderEntry`。
2. 落组合矩阵断言：3×3 全格逐个断言合法/非法；固定 `managed + L3 = illegal`、默认 `Supervised + L2`、危险能力/模型渠道 ⇒ L1。
3. 接强制机制：`scope.mode` 走 ADR-040 的 managed policy 名单（策略键参照 `agent-approvals.service.ts:55`），`guidance.level` 走方案卡与反幻觉闸门 N7；`write-guard.decorator.ts:79` 的五档 scope 保持独立，不并入矩阵。
4. 方案卡携带 scope/guidance 版本号并在消费时比对；最后做一次跨端一致性核对（schema / 方案卡 / 能力解析 / 前端表单）。

## 明确不做

- 不用单一字段同时表达治理与引导（H1 已证伪）。
- 不保留第三套命名 `managed/guided/author`；不把 `WriteGuard` 五档 scope 当治理档位或引导强度。
- 不把档位变化塞进现有 4 键指纹推断，不默认 `L1 ≡ Managed`。

## 可验证约束

- 组合矩阵有断言：3×3 全格逐个断言合法/非法；固定 `managed + L3 = illegal`、默认 `Supervised + L2`、危险能力/模型渠道 `⇒ L1`、`L3` 需授权。
- 命名：代码中不得出现第三套叫法（`guided`/`author` 作为档位值），矩阵以唯一字段对表示。
- 档位收回：方案卡版本号比对有断言；不把档位变化塞进现有 4 键指纹推断（G5）。

## 关联

- 计划项：strategy §12.1/§12.2 H1/H4、GCO §11.1 G1/G5、§11.2
- 相关 ADR：ADR-040（managed 靠策略不靠 locked）、ADR-042（方案卡暂由 SOP draft/publish 承载）
