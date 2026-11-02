# Round 1 总报告 · AutoCodeFlow 自治优化（主 Agent 终审）

> **日期**：2026-11-03 · **轮次**：Round 1（只读审计 + 立项）
> **编排**：主 Agent 调度 5 路 SubAgent 并行探查；子代理派生深度达上限后，多实例域由主 Agent 直接承担。
> **探查方式**：CodeGraph CLI（`codegraph_explore` MCP 未在本会话工具表暴露 → 按 `AGENTS.md` 降级到 CLI v1.6.2）。
> **索引状态**：`codegraph sync` 已同步 202 个变更文件 → **2108 文件 / 42151 节点 / 120271 边**，`codegraph status` 无 pending。
> **本轮性质**：**全程只读**。未修改任何源文件，未执行 git 写操作。唯一新增是本目录下的 6 份审计报告。

---

## 1. 当前顶层目标

**让 AutoCodeFlow 的架构在「任务→派发→执行→回调→终态」这条主链上，从「能跑」升级到「可长期演进」**。

具体化为三条可判据的目标：

| # | 目标 | 判据 |
|---|---|---|
| G1 | **派发内核可拆**：派发决策与副作用编排分离，`executor.service.ts` 从 8488 行降到 ≤3500 行 | `codegraph impact` 从 150 → <60；决策器零 IO 且表驱动用例 ≥60 条 |
| G2 | **执行器侧并发正确**：`executor-python` 的跨进程资源互斥从「进程内 Lock」升级为「跨进程真互斥」 | 跨进程用例（`multiprocessing.Process`）绿；`file_lock` 守卫红可复现 |
| G3 | **跨端契约单一事实源**：失败原因从「文案正则」升级为「结构化码」，派发载荷与协议契约机器对账 | `protocol.json` 承载分类判据；三端加载同一份向量；双轨期有 mismatch 指标可度量收敛 |

---

## 2. 本轮 SubAgent 列表与产出

| # | SubAgent | 域 | 报告 | 规模 | 状态 |
|---|---|---|---|---|---|
| 1 | dispatch-core | 派发内核（admin-api `executor`/`task`） | `dispatch-core.md` + `dispatch-core-oss-research.md` | 88KB + 38KB | ✅ 完成 |
| 2 | python-executor | Python 执行器（`apps/executor-python`） | `python-executor.md` | 95KB | ✅ 完成 |
| 3 | admin-web | 前端架构（`apps/admin-web`） | `admin-web.md` | 72KB | ✅ 完成 |
| 4 | deploy-multiinstance | 应用部署 + 多实例一致性 | `deploy-multiinstance.md` | 823 行 | ✅ 完成 |
| 5 | contract-crosscut | 跨端契约 + 共享 SDK + 观察性 | `contract-crosscut.md` | 93KB | ✅ 完成 |

**并发纪律**：同时 ≤5 路（符合 `docs/AGENT-SWARM-PLAYBOOK.md` §2 的硬约束）；审计阶段全部只读 ⇒ 零写冲突。
**用户指令**：并发代理数收敛为 **2–3 路**（Round 2 攻坚轮按此编排，见 §9）。

**孙Agent 委派偏差（如实记录）**：本会话 `subagent` 派生深度上限为 **1**（实测
`subagent depth 2 exceeds maxDepth 1`），`subagent_fork` 亦不可用（`remaining levels: 0`）——
故**任一 SubAgent 都无法再派孙Agent**，各域「开源调研专项」由该域 SubAgent 自行执行
（dispatch-core 域产出了独立报告 `dispatch-core-oss-research.md`，深读本机 `hatchet-main`/`temporal-main`
源码 + GitHub API 核验 6 个项目 License）。
**缺独立第二视角的抵偿**：主 Agent **亲自**做了交叉校验与独立取证（多实例矩阵 14 项逐条核对、
`leader-gate`/`redis-lock`/`claimTaskTrigger`/`checkMisfiresBody` 源码复读、
跨语言正则不等价与共享卷两条关键事实的实测复核），详见 `00-round1-ledger.md` §1。

---

## 3. CodeGraph 探查摘要

### 3.1 依赖与耦合全景

```
                    ┌──────────────────────────────────────────┐
                    │  admin-api (control plane)               │
                    │                                          │
   apps/admin-web ──┤  executor.service.ts  8488行/184符号    │
   (39 pages)      │  ├─ 派发决策 (11 方法)                   │
                    │  ├─ 注册/心跳/地址与指纹冲突              │
                    │  ├─ 令牌缓存 (3 Map)                     │
                    │  ├─ 版本与部署约束 (304行 util)          │
                    │  └─ 审计/事件/指标                       │
                    │         ⇅  forwardRef 模块环 (task↔executor)
                    │  task.service.ts   6990行/149符号        │
                    │  app-deployment.service.ts 4544行/136符号│
                    │  scheduler.service.ts  2899行/100符号    │
                    └──────────────────────────────────────────┘
                              ⇅ 协议契约
                    ┌──────────────────────────────────────────┐
                    │ packages/executor-protocol (protocol.json)│
                    │ packages/contract-fixtures                │
                    └──────────────────────────────────────────┘
                              ⇅
              apps/executor-node (TS) ⇄ apps/executor-python (Py)
              routers/execute.py 5339行/220符号 (7 个子系统混杂)
```

### 3.2 识别到的耦合风险（CodeGraph 实证）

| # | 耦合 | 量化 | 等级 |
|---|---|---|---|
| C-01 | `executor.service.ts` 构造器 **16 个位置参数 + 8 个 `@Optional()`**，注释明写「必须是最后一个位置参数」 | 8488 行 / 184 符号 / **69 文件引用** / `impact -d3` = **150 符号** | 🔴 |
| C-02 | `task` ↔ `executor` 模块级 `forwardRef` 环，环上有 provider 注入 | `task.processor.ts:96` + `executor.module`/`task.module` | 🔴 |
| C-03 | 派发过滤链在 `dispatch`/`dispatchBroadcast`/`selectLeastLoaded` **三处各抄一份**（~140 行），且 `selectLeastLoaded` **缺 affinity/anti-affinity** ⇒ **行为分叉**（部署选机 vs 单播派发） | 3 处 filter 链 | 🔴 行为分叉 |
| C-04 | `dispatch()` 单方法 **613 行 / 37 个 if**，串联 8 类决策 + 占坑 + 传输 + 回滚 | `executor.service.ts:5146` | 🔴 上帝方法 |
| C-05 | 跨文件**文案 ↔ 正则**耦合：pinned 离线文案与 `EXECUTOR_OFFLINE_PATTERN` 中文支容差 `120` 必须逐字对齐 | 8 份分类判据（4 主链 + 4 内联正则） | 🟡 魔数锚定 |
| C-06 | `app-deployment.service.ts` 并存**三套互不感知的状态机**（`status`/`approvalStatus`/`rolloutState`），合法组合矩阵从未定义 | 4544 行 / 136 符号 / 20 文件 / `impact -d3` = **170 符号** | 🔴 设计债 |
| C-07 | 同应用并发灰度是**「读后判」**（`findInFlightRolloutRows` → `markRolloutState` 无原子占坑），批次创建时**无对应 claim** | `app-deployment.service.ts:3362` | 🔴 并发互斥不成立 |
| C-08 | `executor-python` 用**进程内 `threading.Lock`** 做 git 缓存/解释器池的跨进程互斥 | `routers/execute.py:357-383`、`:1056-1070` | 🔴 **并发正确性 P0** |
| C-09 | `apps/admin-web/src/api/queries.ts` 同时是**生成类型源 + 手写领域模型 + 请求 hook** 三重职责；`Executor` 被 **49** 处引用、`Task` 被 **59** 处引用 | 39 页面 | 🟡 职责倒置 |
| C-10 | 四个 python 库（`autocodeflow-{ai,http,notify,db}`）**仓内零消费者**、不在发布线、版本停在 0.3.2（主线 2.0.0） | 4 包 | 🟡 决策待拍板 |

### 3.3 本次探查支撑的核心结论

1. **拆分必须做，且可做**：C-01/C-02/C-04 的影响面已量化，且**存在零风险迁移手段**——
   保留 `ExecutorService` 为 `@Injectable()` 兼容门面 + 引入工厂消除位置参数装配 ⇒
   **53 处 `provide: ExecutorService` 零改动**、6 处 `new ExecutorService(...)` 改为工厂。
2. **并发缺陷是真缺陷，不是风格问题**：C-08 的进程内锁在多 worker 部署下**必然失效**，
   且 python-executor 域已**先证实部署形态**（而非猜测）。
3. **文档质量高于预期**：多实例矩阵 14 项核查中 6 项完全属实、3 项硬漂移、4 项表述过强，
   **0 项「把已做完的事写成待办」** ⇒ 文档债是「颗粒度」问题而非「失真」问题。
4. **跨域重叠已识别**：C-03/C-05/C-06 三处被两个域独立发现且结论一致 ⇒ **不是幻觉，是真债**。

---

## 4. 首批待优化目标清单（按优先级）

> 分级依据：**长期综合收益 vs 短期成本与风险**。每项都有 CodeGraph 影响面数据支撑。

### 🔴 P0 — 硬骨头重构项（必须做，禁止降级为补丁）

| ID | 目标 | 域 | 影响面 | 为什么选重构而非打补丁 |
|---|---|---|---|---|
| **R1** | **`dispatch()` 抽纯决策器**（Filter+Score 两阶段）+ `ExecutorService` 拆 class（保留门面） | dispatch-core | `executor.service.ts` 8488→≤3500；`impact` 150→<60 | 613 行/37 if 的方法**任何局部补丁都会继续腐化**；纯决策器可单测（表驱动 ≥60 条）、可替换策略、后续加亲和权重/环形轮转不用再动编排层 |
| **R2** | **`executor-python` 跨进程互斥根治**（`file_lock` + 原子写 + 守卫） | python-executor | `execute.py:357-383`、`:1056-1070`、`:3186-3223`、`pkg_cache.py` | 进程内锁在多 worker 下**必然失效**，这是**正确性缺陷不是性能问题**；补丁（加锁重试）不能解决「锁本身不互斥」 |
| **R3** | **部署域三套状态机收敛 + 行级原子占坑**（upgrade 占坑 + 灰度批次部分唯一索引） | deploy-multiinstance | `app-deployment.service.ts` 4544→≤1200；`impact` 170→<60 | C-06/C-07 是**「结构上不可能重复」vs「靠应用层读判」**的差距；部分唯一索引是唯一能根除并发批次互斥的手段 |
| **R4** | **失败原因结构化码**（码表元数据化 → 分类器生成化 → 双轨运行时 → 度量收敛） | contract-crosscut | 6+2 = **8 份分类判据**（admin×2 + node + python + 4 内联正则） | C-05 的根因是「用魔数锚定会演进的文案」；只要分类靠正则，双端漂移就会复发（历史已复发过）。**必须双轨 + 度量**，不能一次切换 |

### 🟡 P1 — 中等改造（结构性但收益明确）

| ID | 目标 | 域 | 影响面 |
|---|---|---|---|
| R5 | **派发过滤链收敛为共享 util** + `selectLeastLoaded` 补齐 affinity（消除 C-03 行为分叉，带 flag） | dispatch-core + deploy | 3 处 ~140 行 |
| R6 | **执行前置校验门**（SSRF/zip/env/sandbox 收口为单一入口） | python-executor | `execute.py` 7 子系统 |
| R7 | **前端分层**：generated / features 分离 + 统一数据访问层 + `useEventStream` | admin-web | 39 页面；**必须先建测试护栏** |
| R8 | **多实例一致性收口**：文档 7 条漂移修正 + leader 门禁加固 + 灰度批次租约接管 | deploy-multiinstance | 2 文档 + `leader-gate.service.ts` + rollout |
| R9 | **协议契约上提**：`preflight`/`sandbox`/`failureClassification` 段 + 双向机器对账 | contract-crosscut + python + dispatch | `protocol.json` + 三端 |

### 🟢 P2 — 小优化 / 治理（低风险，必须做但不占主战场）

| ID | 目标 | 域 |
|---|---|---|
| R10 | **四个孤立 python 库拍板处置**（推荐 (C) 降级为仓内私有包） | contract-crosscut |
| R11 | **`knownDivergence` 治理守卫 + 协议破坏性变更守卫** | contract-crosscut |
| R12 | **指标清单口径统一** + 内部/对外指标标注 | contract-crosscut |
| R13 | **前端守卫三件套**（分层 / queryKey 工厂 / 手写类型棘轮）+ settings/audit/CommandPalette 补测 | admin-web |
| R14 | **运维文档对齐**（`WORK_DIR` 隔离警告、回滚语义、多副本漂移） | python-executor + deploy |

---

## 5. 重点攻坚项标注（★ = 硬骨头）

| ID | 攻坚项 | 为什么是硬骨头 | 预估 |
|---|---|---|---|
| **★R1** | 派发内核拆分 | 8 个 `@Optional()` 依赖 + 16 位置参数 + 模块环 + 613 行上帝方法**互相纠缠**；拆错边界会引入静默行为漂移 | 阶段1 低风险切缝 → 阶段2 主体 → 阶段3 收口 |
| **★R2** | 跨进程互斥 | 触及**部署形态假设**（是否多 worker）；修法涉及文件系统原语，Windows/POSIX 双平台 | 阶段1 封堵（纯增量）→ 阶段2 拆 router → 阶段3 契约上提 |
| **★R3** | 部署域收敛 | 20 文件引用 + 3 套状态机 + 9 个 spec；**误拆会让灰度/审批链行为漂移** | 阶段1 止血（结构性格）→ 阶段2 facade 拆分 → 阶段3 边界重划 |
| **★R4** | 结构化错误码 | 跨 3 语言 8 处判据 + 双轨期数据一致性 + **正则跨语言不等价**（JS vs Python `$`/lookbehind/Unicode） | 阶段1 止血 → 阶段2 码表元数据化 → 阶段3 双轨 → 阶段4 度量收敛 |

---

## 6. 开源参考调研摘要（本轮）

| 仓库 | License | 协议适配 | 核心亮点 | 我方采纳方式 | 域 |
|---|---|---|---|---|---|
| [hatchet-dev/hatchet](https://github.com/hatchet-dev/hatchet)（本机副本） | **MIT** | ✅ 兼容 AGPL-3.0 | **调度决策层与副作用层严格分离**；`rankWorkerIds` 分层淘汰 + `computeWeight` 纯函数打分 + `ringOffset` 同分轮转 + `slot_pool` 整池过期 | **架构级借鉴**：Filter+Score 两阶段、纯打分函数、同分环形轮转 | dispatch-core |
| [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes) | **Apache-2.0** | ✅ | **Filter + Score 两阶段调度框架**；硬亲和=过滤 / 软亲和=加分 | **架构级借鉴**：统一 affinity 的两套语义 | dispatch-core |
| [temporalio/temporal](https://github.com/temporalio/temporal)（本机副本） | **MIT** | ✅ | worker 抢占、租约过期接管、确定性重放 | **仅借鉴租约接管语义**；⚠️ 整套引入成本过高，**不推荐** | deploy-multiinstance |
| [hatchet-dev/hatchet](https://github.com/hatchet-dev/hatchet) `lease_manager.go` | **MIT** | ✅ | 租约过期→重入池→他人接管 | **借鉴 CAS 抢占 SQL 形态**（沿用我方 `claimRolloutRows` 既有范式，零新依赖） | deploy-multiinstance |
| [quartz-scheduler/quartz](https://github.com/quartz-scheduler/quartz) | **Apache-2.0** | ✅ | 集群调度 + `misfire` 策略分类 | **借鉴 misfire 策略分类**（我方 FIRE_ONCE 已实装，缺「恢复检查点」） | deploy-multiinstance |
| [celery/celery](https://github.com/celery/celery) | **BSD-3-Clause** | ✅ | beat 定时持久化 + 重复执行抑制 | 概念借鉴 | deploy-multiinstance |
| [redis/redlock](https://github.com/redis/redlock) | **BSD-3-Clause** | ✅ | 单实例 Redis 互斥锁 | **反面教材价值**：我方只用单实例 Redis，不适用其多主争议 —— **记录此点以说明我方选择是安全的** | deploy-multiinstance |
| [filelock](https://github.com/benediktschmitt/py-filelock) / portalocker | **MIT** / **BSD-3-Clause** | ✅ | 跨进程文件锁 | **R2 的直接参考**（OS 级 flock/fcntl，进程崩溃自动释放） | python-executor |
| [Dramatiq](https://github.com/born2py/dramatiq) | **LGPL-3.0** | ⚠️ 冲突 | 任务队列 | **明确不采纳**（LGPL 与 AGPL-3.0-only 混用有传染风险），**仅记录** | python-executor |
| [Celery](https://github.com/celery/celery) | **BSD-3-Clause** | ✅ | 预热/信号处理/worker 池 | 参考 | python-executor |
| [TanStack Query](https://github.com/TanStack/query) | **MIT** | ✅ | `queryOptions` 分层模式、`signal` 取消 | **直接借鉴**（`queryOptions` 让 key/queryFn/类型共处一文件 ⇒ **正好绕开「不迁类型」的既有约束**） | admin-web |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | **MIT** | ✅ | 表单/表格模式 | 参考 | admin-web |
| [refine](https://github.com/refinedev/refine) | **MIT** | ✅ | 资源型 CRUD 后台架构 | 参考 | admin-web |
| [MSW](https://github.com/mswjs/msw) | **MIT** | ✅ | 契约 mock | 参考（**但需评估新增依赖与包体积代价**） | admin-web |
| [openapi-generator](https://github.com/OpenAPITools/openapi-generator) | **Apache-2.0** | ✅ | 契约驱动 SDK 生成 | **仅借思想不引工具**（引入成本高） | contract-crosscut |
| [buf](https://github.com/bufbuild/buf) | **Apache-2.0** | ✅ | 破坏性变更检测 | **借鉴其判据语义，用零依赖 node 脚本实现**（不引入 buf） | contract-crosscut |
| [Spectral](https://github.com/stoplightio/spectral) | **Apache-2.0** | ✅ | 契约 lint | 参考 | contract-crosscut |
| [Pact](https://github.com/pact-foundation/pact-js) | **MIT** | ✅ | 消费者驱动契约测试 | 参考 | contract-crosscut |

**协议结论**：全部推荐项均为 **MIT / Apache-2.0 / BSD-3-Clause**，与本项目 **AGPL-3.0-only** 不冲突。
唯一冲突项 **Dramatiq（LGPL-3.0）明确不采纳**。**无代码复制**，一律仅借鉴架构语义。

---

## 7. 风险与权衡说明

### 7.1 为什么选重构而不是简单打补丁（逐项论证）

| 目标 | 补丁方案的天花板 | 重构的长期收益 | 决策 |
|---|---|---|---|
| **R1** 派发内核 | 抽几个 helper 函数 → 613 行方法变 450 行，仍是「一个方法做 8 类决策」，加亲和权重/换策略要继续动同一坨 | 决策与副作用分离 ⇒ 决策可表驱动单测（≥60 用例）、可替换策略；`ExecutorService` 8488→≤3500 | **重构**（长期 5 + 扩展 5 + 债 5 ≫ 短期 3） |
| **R2** 跨进程锁 | 给进程内锁加重试/加超时 → **锁本身仍不互斥**，多 worker 下两个进程照样同时改缓存 | OS 级 `file_lock`（进程崩溃自动释放）+ 原子写 + 守卫防回归 | **重构**（这是正确性，不是性能） |
| **R3** 部署状态机 | 继续在 4544 行里加条件写 ⇒ 方法越来越长、状态组合矩阵仍无定义 | facade 转发（20 引用文件零改动）+ 一张状态迁移表 + DB 原子占坑 | **重构**（facade 手法把风险降到最低） |
| **R4** 错误码 | 继续维护 8 份正则 + 魔数容差 ⇒ 漂移必然复发（**历史上已复发过**） | 结构化码 + 生成器 + 双轨 + **mismatch 指标做收敛判据**（不靠人肉核对） | **重构**（且必须双轨，不能一次切换） |

**唯一主动选择轻量的项**：
- `cron Leader` demote 容忍对齐（5 行）—— 收益 4 vs 重构成本 2 ⇒ 取轻量，**标记【临时补丁，后续排期重构】**（与调度 Leader 抽共享 `LeaderElectionConfig`，随 R3 阶段 2 一并做）。
- `upgrade()` 的「应用层查状态返 409」临时兜底 —— TOCTOU（A 档），**标记【临时补丁，后续排期重构】**，阶段 1 的 DB 条件 UPDATE 占坑落地后即移除。

### 7.2 CodeGraph 影响评估支撑的「为什么可做」

| 担心 | CodeGraph 实证 | 结论 |
|---|---|---|
| 拆 `ExecutorService` 会炸 53 个装配点 | `provide: ExecutorService` **53 处** + `new ExecutorService(...)` **6 处** | 保留 `@Injectable()` 门面 ⇒ 53 处零改动；6 处改工厂（消除 `{} as never` 静默错位） |
| 拆模块环会破 DI | `forwardRef` 只出现在 3 个 constructor | 移 `SecretsCryptoService` 到 `@Global` 的 `crypto.module` ⇒ 环可拆 |
| 部署域拆分影响 20 文件 | `impact AppDeploymentService -d3` = 170 符号 | facade 转发 ⇒ 9 个 spec 零修改通过；`impact` 目标 <60 |
| python 拆分破坏 34 个测试文件 | `execute.py` 被 34 文件引用 | 纪律：**先搬纯函数，测试只改 import 行就绿**；任何需改断言的搬动单独提交 |
| 前端拆分无护栏 = 回归不可见 | 现有 2162 用例，覆盖集中在部分页面 | **阶段 1 先补护栏与测试**（settings/audit/CommandPalette），护栏绿了再动结构 |

### 7.3 风险台账

| # | 风险 | 概率 | 影响 | 缓解 | 回滚 |
|---|---|---|---|---|---|
| RK-1 | 派发决策器**行为不等价**（golden 对不上） | 中 | 高 | 现有 5 个 dispatch spec **不改断言**全绿 + golden 逐字段相等测试 | git revert 该阶段（门面保留，旧路径可切回） |
| RK-2 | 失败码双轨期**分类漂移复发**（JS/Python 正则不等价） | **高** | 中 | matcher 只用两语言一致子集（禁 lookbehind/`$`/Unicode 属性）+ 共享向量双端断言 + 旧正则兜底 | 单段回滚：生成器停用即回落旧正则 |
| RK-3 | 部署状态机收敛**回填错误** | 中 | 高 | 先写「三列组合 → 新状态」回填脚本，**15 种组合逐一断言** | 迁移可回退；回填脚本幂等 |
| RK-4 | python 改文件锁在 **Windows 平台行为差异** | 中 | 中 | `fcntl`+`msvcrt` 双实现；Windows 走 `msvcrt.locking` | 锁用 feature flag，可回退到进程内锁（并记 warn） |
| RK-5 | 前端重构**回归不可见** | **高** | 高 | 阶段 1 先建护栏 + 补盲区测试，护栏未绿不进入阶段 2 | 逐页切换 + 双栈共存 |
| RK-6 | 并行工作区**他人改动被裹挟** | 中 | 中 | `git add <显式路径>`、禁 `-A`；提交前 `git diff --cached --stat` | `git restore --staged` |
| RK-7 | 多个域同时改 `protocol.json`（R4/R9/contract 三处都碰） | **高** | 中 | **写域隔离**：`protocol.json` 归 contract-crosscut 域**独占**，其他域提需求不直接改 | 单写者串行，由主会话合并 |

---

## 8. 本轮新增待拍板项（需主 Agent / 所有者决策）

| ID | 决策 | 选项 | 我的推荐 | 依据 |
|---|---|---|---|---|
| **D-1** | 四个孤立 python 库（`autocodeflow-{ai,http,notify,db}`） | ① 接 PyPI 发布线 ② 删除 ③ **降级为仓内私有包** | **③**（但要加裁剪：私有标记必须带 reason + 必须在 CI 测试矩阵内） | 零消费者已三重取证；③ 既不删掉已写好的回归用例，也不假装它们是产品 |
| **D-2** | FIRE_ONCE 补偿是否把「窗口内存在任何执行」当已覆盖 | ① 严格 cron 语义 ② 运维语义 | **②**（补偿前查窗口内有无执行，含手动） | A1 原始表述不准；真正会重复的是「手动跑过 + 窗口内无定时触发」这条，② 直接根治 |
| **D-3** | `cron:leader` 与 `scheduler:leader` 锁 TTL 是否统一到 90s | ① 统一 ② 保持不同 | **①**（统一 90s + verify 连续 2 次失败才 demote） | 当前 30s vs 90s 且 demote 容忍 1 次 vs 2 次，双重不一致 |
| **D-4** | 部署约束（affinity/版本跟随）归属 | ① 留派发内核 ② **归 deployment 域** | **②**（`DeploymentConstraintProvider` 接口，派发内核只消费纯数据契约） | 否则部署逻辑会成为 dispatch-core 拆分的**主要阻塞** |
| **D-5** | `modules/agent/**` 的 4 个 @Cron 是否纳入 cron 门禁强制面 | ① 纳入 ② 保持排除 | **①**（其中 `scheduledWatch` 有 LLM 配额副作用，非幂等） | 现 `check-cron-guard.mjs` 明确排除它们；文档却声称 cron 门禁覆盖它们 |
| **D-6** | `agent-trigger.scheduledWatch` 是否迁出 leader 门禁 | ① 迁出改 DB 唯一占坑 ② 保留 | **①** | fail-open 期间非幂等副作用会重复（创建 Agent 会话 + 烧 LLM 配额） |
| **D-7** | 是否需要「真数据回滚」能力（部署域） | ① 不需要 ② 需要 | 需产品判断（回滚是否回滚数据） | 涉及数据安全，需业务底线拍板 |
| **D-8** | `protocol.json` 结构升级是否 bump `protocolVersion` | ① 不 bump ② bump | **①**（分类判据不新增线缆字段，按 README 纪律） | 与 dispatch-core 域 R9 一致 |

---

## 9. 下一步行动（Round 2 攻坚轮）

**并发编排**：按用户指令，**同时最多 3 路 SubAgent**（原 5 路收敛）。分 **2 个批次**推进，
每批次 ≤3 路，写域互不重叠。**Round 2-A 先开 3 路**（都是 P0 硬骨头且写域不交叉），
**Round 2-B 再开 2–3 路**（承接 2-A 的产出）。

### 批次 2-A（P0 硬骨头，并发 3 路）

| 路 | 域 | 任务 | 写域（独占，互不重叠） |
|---|---|---|---|
| **2-A-1** | python-executor | ★R2 阶段 1：跨进程互斥封堵（`file_lock` + 原子写 + 守卫） | `apps/executor-python/{lib,services}/**` + `apps/executor-python/routers/execute.py` + `scripts/check-shared-cache-lock.mjs` |
| **2-A-2** | dispatch-core | ★R1 阶段 1：分类链收敛 + 码化优先 + 过滤链共享 util + 决策日志 schema | `apps/admin-api/src/common/failure-classification/**` + `apps/admin-api/src/modules/executor/executor-filters.util.ts` + `apps/admin-api/src/modules/executor/dispatch-decision-log.schema.ts` |
| **2-A-3** | deploy-multiinstance | R8：多实例矩阵 7 条漂移修正 + leader 门禁加固（TTL 90s + verify 容忍 2 次）+ `modules/agent/**` 4 个 @Cron 纳入门禁 | `docs/ARCH-MULTI-INSTANCE-MATRIX.md` + `docs/OPEN-DECISIONS.md` + `apps/admin-api/src/common/leader-gate/**` + `scripts/check-cron-guard.mjs` |

### 批次 2-B（P1 治理 + 前端护栏，并发 2–3 路）

| 路 | 域 | 任务 | 写域（独占） |
|---|---|---|---|
| **2-B-1** | contract-crosscut | R10/R11：四个 python 库拍板落地 + `knownDivergence` 治理守卫 + 协议破坏性变更守卫 | `packages/autocodeflow-*/pyproject.toml` + `scripts/check-known-divergence.mjs` + `scripts/check-publishable-wiring.mjs` |
| **2-B-2** | admin-web | R13：前端守卫三件套 + settings/audit/CommandPalette 补测（**只做护栏，不动结构**） | `scripts/check-web-*.mjs` + `apps/admin-web/src/__tests__/**` |
| **2-B-3** | dispatch-core（续） | ★R1 阶段 2：纯决策器落地（`decideDispatch` 零 IO + 表驱动用例 ≥60） | `apps/admin-api/src/modules/executor/dispatch/**` |

**串行约束**：
- `protocol.json` 的任何改动**必须**由 contract-crosscut 域**独占**（RK-7）；
- `package.json` 与 `.github/workflows/ci.yml`（守卫挂载）**由主会话统一改**，SubAgent 只交付脚本本体
  （遵循仓库既有「单写者」纪律，见 `docs/AGENT-SWARM-PLAYBOOK.md` §2）；
- 2-B-3 依赖 2-A-2 的分类链收敛产出，**必须排在 2-A 之后**。

**每批次验收硬门**：
```bash
# admin-api 全量（基线 417 套件）
cd apps/admin-api && npx jest
# admin-web 全量（基线 2162 用例）
cd apps/admin-web && npx vitest run
# python 全量
cd apps/executor-python && python3 -m pytest tests/ -q
# 既有守卫全绿（58 个 check-*.mjs）+ 文档守卫
node scripts/check-guards-wired.mjs && npm run test:docs
# 迁移守卫（若动了迁移）
node scripts/check-migrations.mjs
```

**回滚纪律**：每阶段独立可 revert；任何时候可停在新旧并存状态（双轨设计是稳定终态）。

---

## 10. CodeGraph 探查记录清单

| # | 命令 | 产出 |
|---|---|---|
| 1 | `codegraph status` → `codegraph sync` | 202 文件增量同步；2108/42151/120271 |
| 2 | `codegraph node apps/admin-api/src/modules/executor/executor.service.ts --symbols-only` | 184 符号 / 69 文件引用 |
| 3 | `codegraph impact executor.service -d 3` | 150 affected symbols |
| 4 | `codegraph impact task.service -d 2` | 58 |
| 5 | `codegraph impact app-deployment.service -d 2` | 22 |
| 6 | `codegraph node apps/executor-python/routers/execute.py --symbols-only` | 220 符号 / 34 文件引用 |
| 7 | `codegraph query forwardRef` | 3 处构造器注入（task.processor / tool-executor / execution-callback） |
| 8 | `codegraph node leader-gate.service.ts` | 20 符号 / 18 文件；TTL 30s / verify 15s / 单次失败 demote |
| 9 | `codegraph node redis-lock.service.ts` | 30 符号 / 19 文件；watchdog TTL/3、`renew:false` 模式 |
| 10 | `codegraph node scheduler.service.ts --symbols-only` | 100 符号 / 2899 行；两套 leader 常量对比 |
| 11 | `codegraph node scheduler.service.ts --offset 1060/2370/2600` | FIRE_ONCE 补偿主键复核 + `claimTaskTrigger` 条件 UPDATE |
| 12 | `codegraph node app-deployment.service.ts --offset 3660/4173/2028` | `touchRolloutLease` / `rolloutTickInner` / `upgrade` |
| 13 | `codegraph explore "task dispatch 任务调度在 admin-api 与 executor-node 之间如何流转"` | 主链依赖图 + `dispatch()` blast radius |
| 14 | `codegraph explore "灰度批次 rollout 在多实例下如何推进 是否有单写者假设"` | rollout 状态机调用链 + 3 个 rollout spec 识别 |

**CodeGraph 可用性声明**：本会话 **MCP `codegraph_explore` 未在工具表中暴露**，全程按 `AGENTS.md` 降级到 **CLI**（v1.6.2，
`/home/yongsheng/.local/bin/codegraph`）。**CodeGraph 可用**（CLI 路径），无备选探查方式，
影响评估精度未下降。

---

*Round 1 终审完 · 主 Agent · 2026-11-03*
