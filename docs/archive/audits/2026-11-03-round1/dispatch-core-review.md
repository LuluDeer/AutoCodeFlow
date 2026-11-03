# dispatch-core 域独立复核报告（对抗式 · Round 1）

> **复核者**：孙 Agent（CodeGraph 探查专项 + 对抗式复核）· **复核日期**：2026-11-03
> **复核对象**：`docs/archive/audits/2026-11-03-round1/dispatch-core.md`（661 行）的关键结论
> **复核基准**：工作区 `HEAD = 77eacda5`（含 `09b5d3c0` / `b5a73734` / `09d69dab` 三个后续提交）
> **纪律**：只读复核，不编辑任何源文件；每条结论给「证实 / 证伪 / 证据不足」+ 可复核证据。

---

## §1 复核方法与工具链

### 1.1 工具链

| 手段 | 用途 |
|---|---|
| `codegraph status` | 索引新鲜度：**2130 文件 / 42517 节点 / 121342 边**，无 pending ✅ |
| `codegraph node <file> --symbols-only` / `--offset/--limit` | 逐行读源码（返回逐字源码，视为已 Read） |
| `codegraph impact <sym> -d 3` / `callers` / `query` | 依赖与影响面量化 |
| `web_fetch` raw.githubusercontent.com | 核实 K8s / Airflow 的 LICENSE 原文 |

### 1.2 孙Agent 委派

**成功派生 1 个孙Agent**（角色：CodeGraph 深度探查专项），委派第 2 条（Q5 selectLeastLoaded affinity）
的独立取证，主题与本报告主线不同、结论**独立产出**（未参考本报告结论），后经我交叉核对一致。
孙Agent 结论已并入 §2 第 2 条。

> ⚠️ **重要的时点事实**：本次复核的基准是 `HEAD = 77eacda5`，而原报告写于 `b5a73734` **之前**。
> 原报告描述的若干状态**已在后续提交中改变**（分类器收拢、过滤链收拢、决策日志 schema 化）。
> 因此本复核必须区分两类结论：
> - **实质结论**（缺陷是否真实存在）——不受后续重构影响，是复核重点；
> - **表述与行号**（代码长什么样）——已过期，须订正。

---

## §2 逐条复核结论表

| # | 结论 | 报告原判 | **我的判定** | 建议动作 |
|---|---|---|---|---|
| 1 | Q1 切缝：S4/S5/S7/S8/S9 是「纯函数面」（~200 行 / 37 个 if 中 ~25 个），可抽无副作用决策器 | 纯 | **✅ 证实**（实质成立） | **纳入重构**（核心切口） |
| 2 | Q5：`selectLeastLoaded` 缺 affinity/anti-affinity ⇒ 部署选机 ≠ 单播派发 | 行为分叉 | **⚠️ 部分证实 / 表述已证伪** | **纳入重构**（但缺陷形态与报告不同） |
| 3 | Q3：21 个构造依赖中只有 1 个跨模块（secretsCrypto），全局化后可拆 forwardRef 环 | 可解 | **⚠️ 部分证实**：单一环成立，但**遗漏第三对模块环** | **纳入重构**（范围要扩） |
| 4 | Q4：两条路径正则链漂移（PACKAGE_FETCH 少 `module not found`、SANDBOX/APPLICATION_MISSING 单边缺、中文容差 120 魔数） | 漂移真实存在 | **✅ 证实（历史事实）**，但**已被 `09b5d3c0` 修复** | **降级为观察项**（方案已被先行实现） |
| 5a | F-13：pinned 满载丢失 pinned 语义（落 `NO_DISPATCHABLE_EXECUTOR`） | 真实缺陷 | **✅ 证实** | **立即修 bug** |
| 5b | F-15：`Task.priority` 完全未接入派发链 | 真实缺陷 | **✅ 证实**（但需精确化表述） | **立即修 bug**（或降级为产品决策） |
| 6 | 开源对标：K8s Apache-2.0 / Hatchet MIT / Airflow Apache-2.0，零协议污染；两个借鉴点可落地 | 全部成立 | **✅ 证实（License 逐字核实）**；借鉴点**部分落地** | **保留**（第二轮借鉴点降级为可选） |

---

### 2.1 【第 1 条】Q1 切缝的纯度 —— **证实**

**复核方法**：逐个读被判为「纯」的函数的实现，检查有无 `await` / `repo.*` / `axios` / `this.logger` 等副作用。

| 段 | 函数 | 位置 | 复核结果 |
|---|---|---|---|
| S4 | `applyInterpreterFilter` | `executor.service.ts:3262-3292` | ✅ **纯**：仅 `.filter()` + 纯工具（`hasRequestedVersion` / `interpreterSatisfies` / `isOnlineDownloadable` / `buildInterpreterMismatchMessage`），**无 await、无 repo、无 http** |
| S5 | 过滤链 | 现已收拢至 `executor-filters.util.ts:224 filterExecutorCandidates` | ✅ **纯**：`applyBasicFilters`（group/tags-AND/runtime-capabilities）+ `applyAffinityFilters`，全内存 `.filter()` |
| S7 | `partitionByDeploymentAffinity` | `executor-deployment-affinity.util.ts:125-…` | ✅ **纯**：仅 `Set` 构建 + 遍历重排，**无 IO** |
| S8 | `partitionByInterpreterCache` | `interpreter-match.util.ts:356-…` | ✅ **纯**：仅数组遍历 + 前缀匹配，**无 IO** |
| S9 | 决策日志组装 | `executor.service.ts:5593+ logExecutionDispatchDecision` | ✅ **纯**（拼 JSON 入参） |
| S6 | `computeExecutorLoadScore` | `executor-score.util.ts:71` | ✅ 纯函数（**但取数 `estimatedDurationsByExecutor` 是 IO** ⇒ 报告的「混合」判定正确） |

**结论**：Q1 的切缝**实质成立**——这五段确实无副作用，可抽成零 IO 的纯决策器。
**须订正的细节**：报告给的行段边界（`:5245-5265` / `:5266-5352` / `:5406-5451` 等）**已过期**——
后续重构（`b5a73734` 过滤链收拢）使 S5 现位于 `:5346-5352`，且多出 `executor-filters.util.ts` 这个新文件。
**建议**：重构实施时**以符号边界而非行号边界**切缝（`applyInterpreterFilter` / `filterExecutorCandidates` /
`partitionByDeploymentAffinity` / `partitionByInterpreterCache` / `computeExecutorLoadScore`），
避免再次因行号漂移而切错。

---

### 2.2 【第 2 条】Q5 行为分叉 —— **部分证实 / 表述已证伪**（孙Agent 独立取证）

**报告原述**：「`selectLeastLoaded`（约 :4632-4668）只实现了 group / tags / runtime 三维，**缺 affinity/anti-affinity**」。

**复核结论：表述层已被后续重构证伪，实质缺陷仍成立但形态更窄。**

| 检查点 | 事实（file:line） | 判定 |
|---|---|---|
| 过滤链现状 | 已收拢至 `executor-filters.util.ts`：`applyBasicFilters`（group/tags/runtime）+ `applyAffinityFilters`（affinity/anti-affinity）——**util 五维齐全** | 报告表述**过期** |
| 调用侧传参 | `executor.service.ts:4664-4668` 只传 `{ group, tags, runtime }`，**未传** `affinityTags` / `antiAffinityTags` | 缺陷**仍在** |
| `opts` 签名 | `executor.service.ts:4615-4623`：仅 `group/tags/runtime/runtimeVersion` —— **无 affinity 字段** | **证实** |
| 调用方 | `codegraph callers selectLeastLoaded` = 4：`app-deployment.service.ts:1333 deploy()`（实际调用点 `:1409`/`:1412`，**均零参数**）+ 3 个 spec | **证实** |
| **生产实际** | 生产调用**零参数** ⇒ group/tags/runtime **全为 undefined** ⇒ **候选池 = 全部 ONLINE** | **比报告更严重**：所谓「三维过滤」在生产中是**空的三维** |
| dispatch 侧语义 | `:5346-5352` 传 `task.executorAffinityTags/antiAffinityTags`，mode=`"dispatch"`；`applyAffinityFilters:178-179` 对非 selection **恒 enabled** ⇒ **硬过滤**（非软偏好） | **证实** |
| 开关状态 | `applyAffinityFilters:170-174`：selection 侧 criteria 无亲和 ⇒ `hasAffinityDim` 恒 false ⇒ **早退返回原集**，开关开/关**逐字节相同**（`executor-filters.util.spec.ts:140-143` 已断言） | ⚠️ **开关空转** |
| 配置注释 | `configuration.ts:470-486` **自认**「本开关当前是空转的 / F-07 状态仍为未修复」 | 已被承认为**结构性伪修复** |

**量化「补齐后会改变多少行为」**：改变行为需**三前提同时具备**：
(a) `opts` 增 affinity 字段；(b) `deploy()` 从部署约束真传值；(c) 开关开启。
三前提缺任一 ⇒ 行为**逐字节不变**。补齐后差异 = dispatch 会剔除「无任一 affinity 标签」或
「持有任一 anti-affinity 标签」的执行器，而选机路径照收。
**结果变化条件**：仅当被剔除者**恰为负载最优者**时选机结果才变；否则最空闲者本就满足标签，选机不变。

**建议动作**：**纳入重构，但按「依赖部署域约束契约」立项**，且**先删/改假旋钮**——
留一个开与关行为完全相同的开关是三个选项里最差的状态（运维会误以为开启即生效）。
`codegraph impact selectLeastLoaded -d 2` = **10 符号**，改动面小；难点在部署域的
`DeploymentConstraintProvider` 契约（见 §5）。

---

### 2.3 【第 3 条】Q3 模块环 —— **部分证实（范围被低估）**

**报告原述**：「`ExecutorService` 21 个构造依赖中只有 1 个跨模块（secretsCrypto），
`executor.module.ts:17-24` 的 `forFeature` + 实体注册是本仓已有的『不引模块』正解」。

| 检查点 | 事实 | 判定 |
|---|---|---|
| 跨模块 provider 数量 | `executor.service.ts:736` `@Inject(forwardRef(() => SecretsCryptoService))` —— 由 `TaskModule` export（`executor.module.ts:37-38` 注释自陈） | ✅ **证实**（task↔executor 这对环的唯一跨模块 provider） |
| 本仓已有正解 | `executor.module.ts:15-31` 注释明写：实体（`Task`/`TaskExecution`/`Application`/`AppDeployment`/`ApplicationVersion`）**只加 Repository、不 import 模块**，理由是「ApplicationModule 反向 import 了 TaskModule + ExecutorModule，引入模块环」 | ✅ **证实**（该范式确凿存在） |
| 全局化后可否消除 | 把 `SecretsCryptoService` 收进 `@Global()` 模块（`common/utils/` 下现无 module 收编它 —— 已核实 `common/**/*.module.ts` 中**无** `SecretsCryptoService` 引用）⇒ 环可解 | ✅ **可行** |
| **`task.processor.ts:71`** | `@Inject(forwardRef(() => ExecutorService))` —— **provider 级**注入，与模块级 forwardRef 是两回事；`ExecutorService` 若移出 `ExecutorModule`（Q2），此处亦须同步调整 | ⚠️ **报告未提及的第 2 处** |
| **第三对模块环（报告遗漏）** | `task.module.ts:65` `forwardRef(() => SchedulerModule)` ＋ `scheduler.module.ts:19` `forwardRef(() => TaskModule)` ⇒ **task ↔ scheduler 成环**；provider 侧 `task.service.ts:1046` `@Inject(forwardRef(() => SchedulerService))` | ⚠️ **报告遗漏** |
| **全仓环图** | `grep -rn "forwardRef(() => [A-Za-z]*Module)" modules/*/*.module.ts` ⇒ **`TaskModule` 是枢纽**，与 Executor / Scheduler / Agent / Application **四方**成环：<br>`executor.module:77↔task.module:61`、`scheduler.module:19↔task.module:65`、`agent.module:78↔task.module`、`application.module:42↔task.module` | ⚠️ **报告的「单环」视角严重低估** |

**判定**：报告的**机制判断正确**（secretsCrypto 全局化 + 实体只加 Repository ⇒ 该环可解），
但**范围判断不完整**：真实是**以 TaskModule 为中心的多环结构**，
且 provider 级 forwardRef 有 **2 处**跨模块（`ExecutorService`、`SecretsCryptoService`）
+ **1 处**跨到 scheduler（`SchedulerService`）。

**建议动作**：**纳入重构，但把 Q3 的范围从「拆一对环」修正为「TaskModule 枢纽解耦」**，
并明确它是 **Q2（拆 ExecutorService）的前置**而非独立小项——否则拆完 `ExecutorService` 仍留
`task.processor.ts:71` 的 forwardRef，环只是搬了个位置。

---

### 2.4 【第 4 条】Q4 文案漂移 —— **证实（历史事实），但已被先行修复**

**报告原述**：`task.processor.ts:457` 的 PACKAGE_FETCH 规则**少** `module not found|cannot find module`；
`SANDBOX_UNAVAILABLE` / `APPLICATION_MISSING` 单边缺；`EXECUTOR_OFFLINE_PATTERN` 中文容差 120 是实测魔数。

**复核结论**：**漂移在 `09b5d3c0` 之前真实存在**（这与 `verify-reconcile.md` §2.2/§2.5 的独立复现一致），
但**当前 HEAD 已修复**：

| 检查点 | 当前事实（file:line） |
|---|---|
| 两路径是否仍各持正则链 | ❌ **已收拢**：`task.processor.ts:36` 与 `task.service.ts:17` **都** `import { classifyFailure } from "../../common/failure-classification/failure-patterns"`；`task.service.ts:1034` `return classifyFailure({...})` |
| 唯一事实源 | `common/failure-classification/failure-patterns.ts` —— 判据常量 + `classifyFailure` 唯一裁决入口（`:200`） |
| PACKAGE_FETCH 判据 | `:175-177` 已含 `module not found|cannot find module|modulenotfounderror|no module named` |
| EXECUTOR_OFFLINE 容差 | `:117-118` 仍为 `[^\n]{0,120}`（**魔数仍在**），但 `econnrefused`/`enotfound` 已加 `\b` 词边界（修掉 `ModuleNotFoundError` 被误吞的存量 P1） |
| 码化优先 | `common/errors/error-code-failure-reason.ts` 已建「错误码 → 失败原因」表，`PINNED_EXECUTOR_OFFLINE` → `EXECUTOR_OFFLINE` |

**判定**：报告的**历史观察全部成立**（是立论基础，且立论正确），
**但方案已被 `09b5d3c0` 先行实现**（比报告的建议更进一步：直接做了「码化优先 + 单一入口」，
而非报告设想的「双轨 + 7 天观察期」）。

**建议动作**：**降级为观察项**。原 R4 计划中「阶段 1 建 `common/failure-classification/`」已提前完成；
主Agent 应把它从「待办」改为「已由 `09b5d3c0` 交付」，**避免重复施工**。
**但须继承 `verify-reconcile.md` §2.3/§2.4 的两条待账项**：
① `ModuleNotFoundError` → `package_fetch_failed` 的语义存疑（用户脚本 `import pandas` 失败 ≠ 平台拉包失败），
建议新设 `dependency_missing` 兄弟类（需三端 + 契约同步）；
② 守卫盲区（27 条结构守卫挡不住「改名 + 内联」与「裸子串 `enotfound` 加回消费者」）。

---

### 2.5 【第 5 条】F-13 —— **证实（真实产品缺陷）**

**报告原述**：pinned 执行器满载时丢失 pinned 语义（落 `NO_DISPATCHABLE_EXECUTOR`，文案不提 pinned）。

| 检查点 | 事实（file:line） | 判定 |
|---|---|---|
| pinned 分支语义 | `executor.service.ts:5219-5225` 注释明写：「a pinned executor at capacity **fails the dispatch** (no fallback to another executor — that is the point of pinning)」 | — |
| pinned 失败码 | `:5229-5234` 行不存在 → `PINNED_EXECUTOR_NOT_FOUND`（**语义正确**，注释自陈「EXECUTOR_OFFLINE would be a lie」）；`:5235+` 离线 → `PINNED_EXECUTOR_OFFLINE` | ✅ 已区分 |
| **但满载走通用出口** | 占坑循环 `:5550-5563` 逐候选尝试；`matched` 为空时 `:5565-5585` 依次判 `anyMutexBlocked` → `deploymentCtx.mode==="strict"` → **兜底 `throw new AppError("NO_DISPATCHABLE_EXECUTOR")`（`:5584`）** | ✅ **证实** |
| 文案是否含 pinned | `common/errors/catalog/executor.ts:221` `NO_DISPATCHABLE_EXECUTOR` —— 通用码，**不含 pinned 语义** | ✅ **证实** |

**判定**：**真实缺陷**。用户配了「固定执行器」却看到「无可用执行器」，**无法区分**
「我指定的那台满了」与「整个机队都没有」——前者是「等一会就好」，后者是「配置错了」，
运维处置方向完全不同。

**建议动作**：**立即修 bug**（低成本、高用户价值）。
最小修法：在 pinned 分支**单独识别容量满**并抛专属码（如 `PINNED_EXECUTOR_AT_CAPACITY`），
**不进通用兜底**。属「加一个分支」，不涉及重构。

---

### 2.6 【第 5 条】F-15 —— **证实（但须精确化表述）**

**报告原述**：`Task.priority` **完全未接入**派发链（用户配置无效）。

| 检查点 | 事实（file:line） | 判定 |
|---|---|---|
| `priority` 存在 | `task.entity.ts:223` `priority: TaskPriority`（PG 枚举 `task_priority_enum`） | — |
| **是否进选路评分** | `executor.service.ts` 中 `task.priority` **零命中**；`executor-score.util.ts` 的 `computeExecutorLoadScore` 维度 = 任务负载比 50% + CPU 25% + 内存 25% + 长任务惩罚 10% —— **无 priority 维度** | ✅ **证实**（选路不看 priority） |
| **是否完全无效** | ❌ **不是**：`executor.service.ts:67` `import { toBullPriority }`；`:1773` `priority: toBullPriority(normalizeTaskPriority(task.priority))` —— **BullMQ 队列优先级**用它 | ⚠️ **报告表述过宽** |
| 精确表述 | priority **只影响 BullMQ 出队顺序**（紧急任务先被 worker 取走），**不影响「派给哪台执行器」**。在「大量任务排队、候选机队同分」的常见场景下，最终效果是「紧急任务更早开始」；但在「非紧急任务已被派到空闲机、紧急任务被派到忙机」时，**priority 不产生任何影响** | ✅ |

**判定**：**缺陷成立，但报告「完全未接入」的表述过宽**——它**接入了队列优先级**，
只是**未接入选路**。这是两种不同的用户可见后果：
前者（队列优先级）多数场景已满足直觉；后者（选路）才是真正的能力缺口。

**建议动作**：**降级为产品决策项**（不是无争议的 bug）。
理由：把 priority 接入选路会让「高优先级任务抢占正在被低优先级任务占用的执行器槽位」，
这需要**抢占语义**（是否 kill 低优先级在跑任务？），涉及业务取舍而非纯技术修复。
**建议主Agent 明确口径**：「priority 是『更早开始』还是『必须更快』」——前者已满足，后者需立项抢占语义。

---

### 2.7 【第 6 条】开源对标 —— **License 全部证实；两个借鉴点部分落地**

**License 逐字核实**（不采信报告转述）：

| 仓库 | 核实方式 | 结果 | 判定 |
|---|---|---|---|
| [hatchet-dev/hatchet](https://github.com/hatchet-dev/hatchet) | 本地副本 `/home/yongsheng/project/open_sourse/hatchet-main/LICENSE` 第 1 行 | `MIT License / Copyright (c) 2023-present Hatchet Technologies Inc.` | ✅ **MIT 证实** |
| [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes) | `web_fetch` raw.githubusercontent.com/kubernetes/kubernetes/master/LICENSE | `Apache License Version 2.0` | ✅ **Apache-2.0 证实** |
| [apache/airflow](https://github.com/apache/airflow) | `web_fetch` raw.githubusercontent.com/apache/airflow/main/LICENSE | `Apache License Version 2.0`（附字体子组件 OFL-1.1 声明，但**主仓协议仍是 Apache-2.0**） | ✅ **Apache-2.0 证实** |

**协议结论**：三者均为 MIT / Apache-2.0，**与本仓 AGPL-3.0-only 无冲突**（宽松协议可集成进 AGPL 项目），
**零协议污染风险** ✅。报告该结论成立。

**两个借鉴点的可落地性复核**：

**① k8s 式 Filter/Score 两阶段 + 硬/软亲和分离 —— 可落地，但需修正报告的映射**

| 报告设想 | 复核事实 | 判定 |
|---|---|---|
| 「我方把硬过滤与软偏好混在一个方法里，是 dispatch 复杂度高的根因」 | ✅ 与源码一致：`executor.service.ts:5346-5352` 硬过滤（group/tags/affinity/anti-affinity/runtime）+ `:5412+` 部署归属**软偏好**分区，**确实混在一个方法** | ✅ 成立 |
| 「采纳硬亲和=过滤、软亲和=加分，统一两套语义」 | ⚠️ **我方现状是三套而非两套**：① affinity/anti-affinity = **硬过滤**（`applyAffinityFilters` 的 `.filter()`）；② 部署归属 = **分区软偏好**（`partitionByDeploymentAffinity`，只重排不剔除）；③ broadcast 的 affinity = **收窄扇出**（`dispatchBroadcast` 注释自陈，与 dispatch 语义**不同**） | ⚠️ **三套**，k8s 的「硬/软二分」不足以直接覆盖 |
| 「Filter 产出 Unschedulable 语义、Score 产出有序候选」 | ✅ 可直接落地：现有 `filterExecutorCandidates` 已是一个纯 Filter，`computeExecutorLoadScore` 已是一个纯 Score —— **两头都已存在且已解耦**，缺的只是把它们中间的编排显式化 | ✅ **可落地，且比报告设想的更容易** |

**② Hatchet `ringOffset` 同分轮转修「同分恒取第一台」 —— 缺陷成立，但严重性被报告高估**

| 检查点 | 事实（file:line） | 判定 |
|---|---|---|
| 是否真「同分恒取第一台」 | `executor.service.ts:5408-5410` `.sort((a,b) => a.score - b.score)` —— **JS 稳定排序**，同分保持**入数组原序**；`:5414-5417` 注释明写「`withScores.sort` 是稳定排序但键是 score，分组信息不参与比较」 | ✅ **缺陷成立** |
| 同分产生的概率 | 评分 = 50% 负载比 + 25% CPU + 25% 内存 + 10% 长任务惩罚；**空闲机之间 CPU/内存几乎相同** ⇒ 同分极常见 | ✅ 严重性成立 |
| 轮转是否必要 | ✅ 需要（否则长期压同一台）；但注意 `partitionByDeploymentAffinity`（`:5412+`）**已引入分组**，组内保序 ⇒ 「同分恒取第一台」在**同组内**仍成立 | ✅ |
| 报告未提及的约束 | ⚠️ 轮转需要**实例内状态**（游标），而 `dispatch()` 是**无状态纯编排**——引入轮转会给「零 IO 纯决策器」引入**进程内可变状态**，与 Q1 的纯函数目标**冲突** | ⚠️ **关键约束，报告未提** |

**建议动作**：借鉴点 ① **纳入重构**（作为 Q1 纯决策器的内部结构：显式 Filter→Score 两段）；
借鉴点 ② **降级为可选增强**，且**必须与 Q1 分离**——
轮转游标属编排层（session/state），不能进纯决策器；若要实现，需在决策器输入里显式传入
「轮转偏移量」参数（由编排层维护），否则纯度被破坏。

---

## §3 报告中被证伪或需修正之处

| # | 报告原述 | 修正 | 严重度 |
|---|---|---|---|
| M-1 | 「`selectLeastLoaded` 只实现了 group/tags/runtime 三维」 | **表述过期**：过滤链已收拢到 `executor-filters.util.ts`（五维齐全）；真实缺陷是「调用侧只传三维 + `opts` 无亲和字段 + 开关空转」，且**生产调用零参数 ⇒ 连三维都是空的** | 🔴 高（原报告会让人以为「补 3 行即可修」） |
| M-2 | Q3「只有 1 个跨模块依赖，拆环是小项」 | **范围低估**：`TaskModule` 是**枢纽**，与 Executor/Scheduler/Agent/Application **四方**成环；provider 级 forwardRef 有 **2 处跨模块** + 1 处跨到 scheduler | 🔴 高（低估工作量） |
| M-3 | Q4「两条路径正则链漂移」作为**待办** | **已由 `09b5d3c0` 修复**（两条路径共用 `classifyFailure` + 码化优先表）⇒ 重复施工风险 | 🟡 中 |
| M-4 | F-15「`Task.priority` **完全未接入**派发链」 | **过宽**：已接入 BullMQ 队列优先级（`:1773`）；未接入的是**选路评分** | 🟡 中（影响优先级判定） |
| M-5 | Q1 的 S1–S13 **行段边界** | **已过期**（过滤链收拢致行号移位 + 新增 `executor-filters.util.ts`）⇒ 实施时须用**符号边界** | 🟡 中（照行号切会切错） |
| M-6 | 「同分恒取第一台」修法未提轮转游标与纯决策器的**冲突** | 轮转需进程内状态 ⇒ 若进决策器会破坏 Q1 的零 IO 纯度 | 🟡 中 |
| M-7 | 开源对标称 k8s「硬/软亲和二分」可统一我方语义 | 我方是**三套**（硬过滤 / 分区软偏好 / broadcast 收窄扇出）⇒ 二分不足 | 🟢 低 |

---

## §4 新发现（本轮复核新增，原报告未提）

| # | 发现 | 证据 | 价值 |
|---|---|---|---|
| **N-1** | **`task ↔ scheduler` 是第三对模块环**，`TaskModule` 实为**多环枢纽** | `task.module.ts:65` ↔ `scheduler.module.ts:19`；`task.service.ts:1046` `@Inject(forwardRef(() => SchedulerService))` | 🔴 **高**——直接决定 Q3 的工作量估算 |
| **N-2** | **pinned 满载的失败出口未区分**（F-13 的具体落点） | `executor.service.ts:5584` 兜底 `NO_DISPATCHABLE_EXECUTOR` | 🟡 中（F-13 的可执行修法依据） |
| **N-3** | `EXECUTOR_OFFLINE_PATTERN` 的**中文容差 120 魔数仍在**（`failure-patterns.ts:117`） | 虽已码化优先，但旧执行器/无码文案仍走正则兜底 ⇒ 魔数风险未清零 | 🟡 中（Q4 的**残留**，非已清） |
| **N-4** | `common/**/*.module.ts` 中**无** `SecretsCryptoService` 引用 ⇒ 它当前**只**由 `TaskModule` export | 已核实 `grep -rn "SecretsCryptoService" common/ --include="*.module.ts"` 为空 | 🟢 低（证实 Q3 的全局化方案**尚未实施**，可做） |
| **N-5** | `dispatch()` 的「同分取首」与「部署归属分区」**叠加**后，分组信息不参与比较 | `executor.service.ts:5414-5417` 注释自陈 | 🟡 中（轮转改造的约束条件） |
| **N-6** | **提交 `09d69dab`（决策日志 schema 化）是本域唯一无独立复核的提交** —— 已由本复核补上（见 §4.1） | `git log`：本域三提交中 `09b5d3c0` 被 `verify-reconcile.md` 复核、`b5a73734` 被本报告复核、**`09d69dab` 无任何复核** | 🟡 中（覆盖缺口已补） |

---

### 4.1 【追加】提交 `09d69dab`（决策日志 schema 化）独立复核

> 该提交是 R1 阶段 1 的 1.4 项，也是 dispatch-core 域**三个提交中唯一没有独立复核的**。
> 本节由主 Agent 指派的复核 Agent 补做（复核时点晚于该提交，故以其**当前**代码为准）。

#### 4.1.1 结论表

| # | 提交声称 | **我的判定** | 证据 |
|---|---|---|---|
| A-1 | 两个决策日志出口各手写一份 JSON | ✅ **证实**（历史上） | 现 `executor.service.ts:203` `import { buildDispatchDecisionLog }` —— **单一 builder**，两出口 `:4734` / `:4908` 共用 |
| A-2 | 字段集固定，缺失显式 `null` | ✅ **证实** | `dispatch-decision-log.schema.ts:175-187`：所有字段显式 `?? null`；`task`/`executionId` 选机路径显式传 `null`（`:4736-4737`） |
| A-3 | 取整口径唯一（3 位小数） | ✅ **证实** | `:101-105 roundScore` 一律 `Number(score.toFixed(3))` |
| A-4 | 缺必填字段即抛 `TypeError`，信息指出具体字段 | ⚠️ **部分证实**（有例外，见 D-1） | `:143-169 requireCandidate`：`address`/`runningTaskCount` 缺失**确实抛错**并点名字段；**但 `score` 缺失/NaN/null 被 `roundScore(...) ?? 0` 静默转 0 且不记入 `problems`** |
| A-5 | 校验失败降级为 warn，不影响派发主链 | ✅ **证实** | `:4731`/`:4907` 两出口各自 `try/catch`，catch 内 `logger.warn` + 不输出日志 |
| A-6 | 「字段集统一」= 信息量统一 | ⚠️ **形式统一，选机侧信息量仍为空** | 选机路径**完全未传** `deploymentAffinity`/`deploymentConstraint`/`interpreterCacheAffinity` 三维 ⇒ 恒为 `null`；dispatch 路径三者齐全（`:4924-4938`） |

#### 4.1.2 实测证据（D-1 的复现）

用 `tsx` 直接调用 `buildDispatchDecisionLog`（临时脚本已删除，未污染仓库）：

```
NO-THROW selected.score=undefined -> {"address":"a","score":0,"runningTaskCount":0,"maxConcurrentTasks":null}
NO-THROW selected.score=NaN       -> {"address":"a","score":0,...}
NO-THROW selected.score=null       -> {"address":"a","score":0,...}
THROW   selected.address missing   -> 调度决策日志字段校验失败：selected.address 必须是字符串
THROW   selected.runningTaskCount missing -> 调度决策日志字段校验失败：selected.runningTaskCount 必须是有限数字（收到 undefined）
```

**判读**：`score` 是**唯一被静默兜底的必填数值字段**。而 `score=0` 在这份日志里的语义是
「负载评分最低 = 最空闲 = 最优」——**恰恰是最有误导性的值**。一旦 score 因任何原因缺失，
排障者会看到「选中者评分 0」而得出「这台机器完全空闲、却被别的因素淘汰」的错误结论，
且**日志里没有任何缺字段的痕迹**（正是该提交想消灭的那类歧义）。

**可达性评估**：`computeExecutorLoadScore`（`executor-score.util.ts:71-93`）
**恒返回 number**（`cpuUsage ?? 0` / `memUsage ?? 0` / `estimatedDurations ?? []` 全部兜底），
两个出口的 score 均来自它 ⇒ **当前生产路径不可达**。
⇒ 这是**契约与实现不一致**（提交对外承诺「缺必填字段即抛错」，实际有一条例外），
不是现网 bug。**但它恰好落在「这个提交要消灭的那类歧义」上**——防御性缺口与目标自相矛盾。

#### 4.1.3 建议动作

| 项 | 建议 |
|---|---|
| **D-1** | `requireCandidate` 对 `score` 走**与 `runningTaskCount` 同款的必填校验**（缺失/非有限数 ⇒ 记入 `problems`），**或**把 `score` 的类型放宽为 `number \| null` 并在文档里明说「null = 未评分」。**当前实现两头不靠**：类型声明是 `number`（必填），实现却允许静默变 0。**成本极低（3 行），建议随下一批次一并修**。 |
| **D-2** | 「字段集统一」目前是**形式统一**。若要让选机日志有实际排障价值，需在选机路径**补上** `deploymentAffinity`（选机路径**不适用**部署亲和，可确认为 `null` 并在 schema 注释里写明「选机路径恒 null，因其不实施部署归属」）+ 至少补 `interpreterCacheAffinity`（选机路径**确实调了** `applyInterpreterFilter`，有信息量）。**建议列为 P2**，不必阻塞。 |

---

### 4.2 【追加】`dispatch-core-oss-research.md`（536 行开源调研）的 License 总表复核

> 该文件是 dispatch-core 域的**开源对标资产**，其 §0「License 合规总表」被主 Agent 的
> Round 1 总结**反复引用**（「全部 MIT/BSD-3-Clause/MPL-2.0/Apache-2.0，无 GPL/AGPL，零协议污染风险」）。
> 该断言是「可借鉴思路不复制代码」这一**全局决策前提**，值得逐条核验。

#### 4.2.1 逐条核验结果（8 个项目，**7 准 1 伪**）

| 项目 | 报告声称 | **我的核验** | 核验方式 |
|---|---|---|---|
| hatchet-dev/hatchet | MIT | ✅ **准确** | 本机副本 `LICENSE` 第 1 行 `MIT License / Copyright (c) 2023-present Hatchet Technologies Inc.` |
| temporalio/temporal | MIT | ✅ **准确** | `web_fetch` raw `main/LICENSE`：`The MIT License / Copyright (c) 2025 Temporal Technologies Inc.  All rights reserved.` + `Copyright (c) 2020 Uber Technologies, Inc.`（含 Uber 2020 版权） |
| celery/celery | BSD-3-Clause | ✅ **准确** | `web_fetch` raw `main/LICENSE`：`Celery is licensed under The BSD License (3 Clause...)`。⚠️ **附带条件**：同文件声明「**文档部分**（`docs/` 目录）采用 **CC BY-SA 4.0**」⇒ 若将来复制其文档需另议（仅借鉴思路则无碍） |
| kubernetes/kubernetes | Apache-2.0 | ✅ **准确** | `web_fetch` raw `master/LICENSE`：`Apache License Version 2.0` |
| apache/airflow | Apache-2.0 | ✅ **准确** | `web_fetch` raw `main/LICENSE`：`Apache License Version 2.0`（附字体子组件 OFL-1.1 声明，主仓协议仍为 Apache-2.0） |
| alibaba/Sentinel | Apache-2.0 | ✅ **准确** | `web_fetch` raw `master/LICENSE`：`Apache License Version 2.0` |
| resilience4j/resilience4j | Apache-2.0 | ✅ **准确** | `web_fetch` raw `master/LICENSE.txt`：`Apache License Version 2.0` |
| **hashicorp/nomad** | **MPL-2.0** | ❌ **证伪**（当前 main 为 **BSL 1.1**） | 见下 |

#### 4.2.2 Nomad 的证伪细节（本节最实质的发现）

`web_fetch` raw `main/LICENSE` 的**实际内容**是：

```
Licensor:             International Business Machines Corporation (IBM)
Licensed Work:        Nomad Version 1.7.0 or later.
Change Date:          Four years from the date the Licensed Work is published.
Change License:       MPL 2.0
...
Notice
Business Source License 1.1
```

**事实链**：
1. **Nomad ≥ 1.7.0 采用 Business Source License 1.1**（BSL），**不是** MPL-2.0；
2. BSL 的 **Additional Use Grant** 条款禁止「把 Nomad 作为托管/嵌入式产品提供给第三方，
   以与 IBM 的付费版本竞争」——**这是一个带竞品限制的 source-available 许可**，
   与 OSI 开源定义**不同**；
3. `Change License: MPL 2.0` 只是**四年后自动转为** MPL-2.0 的承诺，
   **当前版本仍受 BSL 约束**；
4. 报告核验的应是 **v1.6.0 及更早**——我实测 `web_fetch` raw `v1.6.0/LICENSE` 确为
   `Mozilla Public License, version 2.0`（`Copyright (c) 2015 HashiCorp, Inc.`）⇒
   **报告取到了旧版本**，而非当前版本。

**风险判读（我方语境）**：
- 我方 AGPL-3.0-only 项目**仅「借鉴思路、不复制代码」** ⇒ **BSL 与 MPL-2.0 在这一点上
  对我方**无实质差别**（都不复制代码）。
- 但报告的**表述**「MPL-2.0（文件级 copyleft），✅ MPL-2.0 文件级 copyleft，可进 AGPL 项目」
  是**基于错误前提**的：若有人据此判断「可安全**复制** Nomad 代码进 AGPL 项目」，
  当前版本**不可**（BSL 的竞品条款 + 非 OSI 许可）。
- 报告自己在该行末尾写了「GitHub API 报 `NOASSERTION`」却**未深究**——
  `NOASSERTION` 恰恰是「非标准/多许可拼接」的信号，是应当追查的**红旗**，而非可忽略的噪音。

**建议动作**：
- **D-10**：把 License 总表里 Nomad 一行改为
  「**Nomad ≥1.7.0 = BSL 1.1（source-available，含竞品限制；4 年后转 MPL-2.0）；
  ≤1.6.0 = MPL-2.0**」；
- 同时把总表结论从「全部 OSI 开源、无协议污染风险」修正为
  「**7/8 为 OSI 开源；Nomad 当前版本为 source-available（BSL 1.1），仅可借鉴思路**」；
- **不影响**「借鉴思路不复制代码」的既有决策（该决策对 BSL 依然成立）——
  故这是**表述修正**，非**决策推翻**。

#### 4.2.3 该报告的另一处优点（值得肯定）

§4.2 的 **F-14**（`MutexGroup.maxConcurrentPerDevice` 字段名与 device 档实际语义不符）
是**唯一一条既非重构问题、也非工具问题、而是产品语义歧义**的发现，
且报告在该节**自我修正了一次**：先按 device 档推出「组并发数被突破」的结论，
再通过核查 `global` 档的组行锁（`SELECT ... FOR UPDATE` 串行化竞争者）**推翻了该结论**，
最终收敛为准确表述「**global 档正确；device 档语义是『单设备内的组并发数』，
字段名与直觉不符 ⇒ 文档/UI 需澄清**」。
**这种「推演 → 自我推翻 → 收敛」的写法正是审计报告应有的形态**，
且避免了把一个**非缺陷**误报为 P0。

---

## §5 对重构方案的修正建议

### 5.1 修正后的优先级（按「实证缺陷」而非「原报告排序」）

| 优先 | 事项 | 依据 | 与原报告的关系 |
|---|---|---|---|
| **P0** | **修 pinned 满载的失败出口**（N-2 / F-13） | 真实用户可见缺陷，低成本 | 原报告 F-13 的**具体化** |
| **P0** | **删/改「空转开关」**（M-1） | 假旋钮是最差状态（运维误以为生效） | 原报告未提 |
| **P1** | **Q1 纯决策器**（用符号边界切缝） | 切缝实质成立（第 1 条已证） | 原报告核心，**保留但改切缝依据** |
| **P1** | **Q3 TaskModule 枢纽解耦**（范围修正为四方环） | N-1 | 原报告范围**扩大** |
| **P1** | **Q5 选机亲和对齐**（依赖部署域约束契约） | 第 2 条 | 原报告**改形态**：不是「补过滤」，是「补入参 + 契约」 |
| **P2** | **priority 选路口径拍板** | 第 5b 条 | 原报告**降级**为决策项 |
| **P2** | **knownDivergence / 守卫盲区 / `dependency_missing` 语义** | `verify-reconcile.md` §2.3/§2.4 | 继承原报告 Q4 的**残留账项** |
| **P3** | **同分环形轮转** | 第 6 条 ② | 原报告**降级**为可选，且须与 Q1 分离 |
| — | **Q4「建分类器」** | 已由 `09b5d3c0` 交付 | **标记为已完成**，避免重复施工 |

### 5.2 对 Q1 实施方式的修正（最关键的一条）

原报告要求「`decideDispatch` 零 IO」。本复核**证实该要求成立**，但补充两条实施约束：

1. **时间必须作显式入参**：`decideDispatch` 不得内部取 `Date.now()`——
   否则「同一 input 两次调用结果相同」这条纯度断言无法成立。
2. **轮转游标不得进决策器**（N-5 / 第 6 条 ②）：若将来实现同分轮转，
   游标属编排层状态，须以**参数**形式传入决策器，否则纯度被破坏。
   建议在类型设计上预留 `tieBreakOffset?: number` 字段（默认 0 = 当前行为），
   **当前先不实现**，避免过早引入状态。

### 5.3 对 Q3 实施顺序的修正

Q3 **不是** Q2 的平行项，而是 **Q2 的前置**：拆 `ExecutorService` 会让
`task.processor.ts:71` 的 provider 级 forwardRef 必须同步处理。
建议顺序：**先 Q3（模块环）→ 再 Q2（拆 class）→ 再 Q1（纯决策器）**——
否则 Q1 抽出的决策器仍挂在带环的模块图上，后续每次改模块都要重跑 Q1 的回归。

---

## §6 待主Agent 决策项

| # | 决策项 | 选项 | 我的建议 |
|---|---|---|---|
| **D-1** | **F-13（pinned 满载）是否本轮立即修** | ① 立即修（加专属码）② 纳入重构批次 ③ 降级观察 | **①** —— 真实用户可见缺陷，改动小（pinned 分支单独识别容量满），不触碰重构主线 |
| **D-2** | **`EXECUTOR_SELECTION_AFFINITY_ENABLED` 空转开关如何处置** | ① 删开关 + 改注释为「未实现」 ② 保留但注释自认空转 ③ 补齐入参使开关真正生效 | **③ 为长期解，① 为当下必须**——先做 ①（诚实），再随部署域契约推进 ③。留空转开关是三个选项里最差的 |
| **D-3** | **Q3 的范围是否扩为「TaskModule 枢纽解耦」** | ① 维持原报告的「一对环」② 扩为四方环 | **②** —— 否则工作量被系统性低估（这是本复核对原报告最实质的一处修正） |
| **D-4** | **F-15（priority）的口径** | ① 「更早开始」即满足（现状可接受，撤回） ② 「必须更快」⇒ 立项抢占语义 | **②立项为产品决策**，但**须先由产品明确口径**；不宜由技术单方决定抢占语义 |
| **D-5** | **同分轮转是否进本轮** | ① 进 Q1 纯决策器 ② 编排层后置 ③ 不做 | **②** —— 轮转需进程内状态，进决策器会破坏零 IO 纯度；建议预留 `tieBreakOffset` 参数但**当前不实现** |
| **D-6** | **Q4 是否标记为已完成** | ① 标记完成（继承 `09b5d3c0`）② 仍列为待办 | **①** —— 避免重复施工；但**必须同时把 `verify-reconcile.md` 的两条账项（`dependency_missing` 语义、守卫盲区）转入待办**，否则「标记完成」会掩盖残留 |
| **D-7** | **Q1 实施切缝依据** | ① 按报告行号 ② 按符号边界 | **②** —— 行号已因后续重构漂移（M-5） |
| **D-8** | **`09d69dab` 的 `score` 静默兜底是否修**（§4.1.3 D-1） | ① 改为必填校验（缺失即抛） ② 类型放宽为 `number \| null` ③ 维持现状 | **①** —— 3 行成本，且「score 缺失变 0」恰是该提交想消灭的那类歧义（`score=0` 语义上=最优，最有误导性）；当前生产不可达，属防御性缺口，但**契约与实现不一致**本身就该修 |
| **D-9** | **选机路径的决策日志是否补 `interpreterCacheAffinity`**（§4.1.3 D-2） | ① 本轮补 ② 列为 P2 ③ 不补 | **②** —— 选机路径**确实调了** `applyInterpreterFilter`（有信息量），补上有排障价值；但不阻塞主线 |

---

## 附：本报告的自我限定

- **未跑** `tsc --noEmit`、未跑 jest/pytest —— 本轮职责是**复核既有结论**而非施工，
  构建验证属实施轮。§4.1.2 的行为断言用 `tsx` **直接调用被测函数**取得（临时脚本置于
  `apps/admin-api/.probe-tmp/`，**已删除**，未污染仓库、未提交）。
- **未修改任何源文件**；本文件是本轮唯一产出。
- 第 2 条（Q5）的取证由**独立孙Agent**完成并经我交叉核对一致；其余各条由我亲自取证。
- §4.1 的复核对象（`09d69dab`）是本域**三个提交中唯一无独立复核者**者 —— 本节补齐该覆盖缺口。
- 「建议动作」是基于源码事实的**技术判断**，其中 D-4 涉及产品语义，我明确不单方裁决。

*复核完 · 2026-11-03 · 基准 HEAD 77eacda5*
