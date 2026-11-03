# Round 1 风险台账与主Agent决策记录

> 范围：2026-11-03 自治优化第一轮（探索 + 立项）。
> 本文件是**主Agent（项目总指挥）的裁决记录**，与各域报告（`docs/archive/audits/2026-11-03-round1/*.md`）配套。
> 纪律：CodeGraph 探查结论优先于主观估算；长期综合收益 > 短期成本时优先重构；高风险处标【临时补丁，后续排期重构】。

---

## 1. 本轮输入（5 域 + 2 独立复核 + 1 实施）

> ⚠️ **本文件曾被并行会话改写，现已按实测事实订正（2026-11-03 02:2x 主Agent 记录）**
>
> **订正 1（错误断言撤回）**：本文件曾出现「复核①/复核② 两个复核孙Agent **不成立**、
> `list_agents` 返回无存活子代理」——**该断言为假**。主Agent 于 02:2x 实测
> `list_agents --scope descendants`，返回**三个存活 depth=1 子代理**：
> `bbdb4f95`（dispatch-core 复核，running）、`eff5335a`（python-executor 复核，running）、
> `43bb8fd8`（H-1 实施，running）。**复核确实存在**，报告尚未落盘属「进行中」而非「不存在」。
>
> **订正 2（并行会话隔离）**：本目录还出现一份**非本会话产出**的 `00-ROUND1-SUMMARY.md`
> （27.8 KB，01:57），自称「主 Agent 终审」，含本会话**从未下达**的指令
> （「用户指令：并发代理数收敛为 2–3 路」§2/§236，「Round 2-B 再开 2–3 路」§238），
> 且通篇声称「全程只读」——与 02:0x 起正在进行的 H-1 实施**事实矛盾**。
> **处置（按 `docs/AGENT-SWARM-PLAYBOOK.md` §7 并行工作区纪律）**：不覆盖、不删对方文件；
> **不采信其未核实断言**；冲突时以**本台账 + 当前工作区代码 + 实测命令输出**为准。
>
> **订正 3（能力边界，如实）**：SubAgent **确实无法派孙Agent** —— 5 路 SubAgent 中 4 路
> 报告实测 `subagent depth 2 exceeds maxDepth 1`，其「开源调研专项」改由各自执行。
> 但**主Agent 自身可以** `subagent_fork`（已成功 3 次），这是本轮抵偿第二视角的实际手段。

| 域 | 主责 SubAgent | 报告 | 状态 |
|---|---|---|---|
| dispatch-core | `3ff3d3cc` | `dispatch-core.md`（661 行）+ `dispatch-core-oss-research.md`（536 行） | ✅ 已回传 |
| python-executor | `517c4ae9` | `python-executor.md`（983 行） | ✅ 已回传 |
| admin-web | `142537ca` | `admin-web.md`（931 行） | ✅ 已回传 |
| deploy-multiinstance | `4d42e116` | `deploy-multiinstance.md`（823 行，11 节） | ✅ 已回传 |
| contract-crosscut | `e776e0ab` | `contract-crosscut.md`（700 行） | ✅ 已回传 |
| 复核① dispatch-core | `bbdb4f95`（主Agent fork） | `dispatch-core-review.md` | ⏳ running（实测确认存活） |
| 复核② python-executor | `eff5335a`（主Agent fork） | `python-executor-review.md` | ⏳ running（实测确认存活） |
| 实施 H-1 | `43bb8fd8`（主Agent fork） | 代码改动 + 守卫 spec | ⏳ running |

**主Agent 亲自取证的关键事实（不依赖任何 SubAgent 转述）**：
- `docker-compose.yml:537`（python）与 `:684`（node）挂**同一** `interpreter_cache` 卷（定义 `:1092`）；
  `apps/executor-node/Dockerfile` **零 uv 引用**（`grep -c uv` = 0）⇒ **compose 默认形态下 node 写不了该卷**。
- node `execute.ts:970` 用 `/task_sandbox|\bsandbox\b|\bbwrap\b/i`（**有词边界**）；
  python `execute.py:717` 用 `re.search(r"task_sandbox|sandbox|bwrap", lowered)`（**无词边界**）；
  python 另多一条 `task_launcher → sandbox_unavailable`（`:713-715`），node 侧零命中
  ⇒ **「跨语言正则不等价」是现存实例，非理论风险**。
- 裸机 `scripts/install.sh:35` `WORK_DIR="/var/lib/autoflow/tasks"` **无实例维度** ⇒ 跨实例共享目录前提成立。
- 灰度批次索引 `app-deployment.entity.ts:68` 为**普通 partial index**（非 UNIQUE），迁移 `1790000000026` 亦为普通 `CREATE INDEX` ⇒ 跨实例互斥**无 DB 约束兜底**。

---

## 2. CodeGraph 探查摘要（本轮，主Agent 亲自执行）

**索引状态**：CLI `codegraph` v1.6.2（MCP `codegraph_explore` 未在本会话工具表暴露，已按 AGENTS.md §1 降级 CLI）。
首轮 `codegraph status` 显示 **202 个 pending**（Added 79 / Modified 123）→ 执行 `codegraph sync`（5.0s，
+8,158 节点，+4,211 引用解析，60 未解析）→ 索引基线：**2,108 文件 / 42,151 节点 / 120,271 边 / 245 MB**。

### 2.1 依赖与耦合骨架

| 事实 | 证据 | 耦合性质 |
|---|---|---|
| `executor.service.ts` **8,488 行 / 184 符号**，被 **69 个文件**引用，`impact -d 3` = **150 符号** | `codegraph node ... --symbols-only` / `codegraph impact executor.service -d 3` | **上帝服务**：注册·心跳·令牌缓存·指纹冲突·派发决策·占坑·版本·指标·审计·事件总线 全在一个类 |
| 构造函数 **21 个依赖**、其中 **8 个 `@Optional()`** 仓库/服务，注释自述「必须是最后一个位置参数」以兼容既有 spec 位置装配 | `executor.service.ts:712` 构造器注释 | **拆分历史包袱**（既有 spec 以位置参数 `new ExecutorService(...)` 直接装配） |
| `task ↔ executor` **模块级 forwardRef 环** | `task.processor.ts:96` `@Inject(forwardRef(() => ExecutorService))` | 模块边界倒置 |
| `task.service.ts` 6,990 行 / 149 符号 / 39 文件引用；`app-deployment.service.ts` 4,544 行 / 136 符号 / 20 文件引用 | CodeGraph 同上 | 规模倒挂 |
| `executor-python/routers/execute.py` **5,339 行 / 220 符号**，被 **34 个文件**引用 | CodeGraph | **router 层塞 7 个子系统** |
| `admin-web/src/types/generated/api-types.ts` **15,147 行** | 文件行数 | 生成物，受 CI api-types-drift 守卫 |
| 进程内锁散落：python 侧 21 处进程内锁，全仓仅 4 处真需跨进程互斥 | python-executor 域实测 | **跨实例共享目录竞态** |

### 2.2 关键调用链路（主Agent 实测确认）

- **派发主链**：`task.processor.ts` → `ExecutorService.dispatch`（`executor.service.ts:5146`）→ 候选筛选 → 占坑 → 载荷构建（`dispatch-task-payload.util.ts`）→ 传输。
- **选机分叉（本轮最有价值发现）**：`selectLeastLoaded`（`executor.service.ts:4607`）唯一生产消费方是 `app-deployment.service.ts:1333 deploy`。
  `codegraph impact selectLeastLoaded -d 2` = **10 符号**（含 5 个 spec）→ 影响面**小且可控**。
- **部署选机 ≠ 单播派发**：`selectLeastLoaded` 缺 affinity/anti-affinity 维度，被 deploy 消费 → 两套选机语义不一致（dispatch-core 域 Q5，待复核①裁决）。
- **共享卷真实存在**：`docker-compose.yml:537`（python）与 `:684`（node）挂**同一** `interpreter_cache` 卷（定义 `:1092`）；
  **但 node 的 `Dockerfile` 零 uv 引用**、compose 侧 node `UV_BIN` 为空 → **compose 默认形态下 node 写不了该卷**（主Agent 实测）。
  ⇒ 「跨语言并发写」在 compose 默认形态**不成立**，真实触发条件是裸机混布（`scripts/install.sh:35` `WORK_DIR=/var/lib/autoflow/tasks` **无实例维度**）→ 严重度待复核②裁决。
- **跨端失败分类分叉（主Agent 实测确认）**：node `execute.ts:970` 用 `/task_sandbox|\bsandbox\b|\bbwrap\b/i`，python `execute.py:717` 用 `re.search(r"task_sandbox|sandbox|bwrap", lowered)` —— **node 有 `\b` 词边界、python 没有**；且 python 多一条 `task_launcher → sandbox_unavailable`（`execute.py:713-715`）node 侧零命中。→ 「跨语言正则不等价」是**现存实例**，非理论风险。
- **回调文件名**：`execute.py:3198-3209` = `callback-{毫秒时间戳}-{进程内序号}.json`，序号由 `_persistence_sequence_lock`（进程内 `threading.Lock`）保护 → 跨实例同毫秒同序号 → 文件名碰撞。

### 2.3 识别到的耦合风险（按严重度）

1. **派发决策与执行器注册混居**（`executor.service.ts`）→ 任何派发改动都牵动 69 文件、150 符号。
2. **选机语义双实现**（`selectLeastLoaded` vs `dispatch`）→ 用户可见行为不一致，且修复面小（10 符号）。
3. **失败分类三份手写正则**（admin `task.service.ts:1067` / node `execute.ts:855` / python `execute.py:570`）→ **127 个文件**引用 `failureReason`；已实测跨端不等价。
4. **模块 forwardRef 环** → 装配期耦合，阻碍任何按模块边界的重构。
5. **进程内锁当跨进程锁**（跨实例共享 `WORK_DIR` 时失效）→ git 缓存 / 解释器池 / pkg 缓存 / 回调落盘 4 处。
6. **文案 → 正则的隐式契约**（`EXECUTOR_OFFLINE_PATTERN` 中文容差 120 是实测魔数；PACKAGE_FETCH 规则两端不齐）→ 文案一改，分类即漂移。

---

## 3. 开源参考调研摘要（Round 1 累计）

| 仓库 | License | 借鉴点 | 我方采纳方式 |
|---|---|---|---|
| Kubernetes scheduler | Apache-2.0 | Filter/Score 两阶段 + 硬/软亲和分离 | **借架构**：决策器内部结构（dispatch-core） |
| Hatchet | MIT（本机有源码 `open_sourse/hatchet-main`） | `rankWorkerIds` 分层淘汰 / `computeWeight` 纯函数亲和权重 / `ringOffset` 同分轮转 | 借思想；修「同分恒取第一台」负载不均 |
| Airflow | Apache-2.0 | Pool「占用 + 排队」双计数 | 借语义，用于澄清互斥组占位歧义 |
| Temporal | MIT（本机有源码） | workflow 幂等 / worker 抢占 / 分布式一致性 | 借思想；**整套引入成本高，不推荐** |
| filelock | MIT | 跨进程硬锁原型 | **只借鉴不引入**（需硬锁 + 超时抛异常，`SoftFileLock` 崩溃留死锁） |
| portalocker | BSD-3-Clause | 「拿不到就跳过」TTL 清扫语义 | 与 filelock 二选一 |
| Celery | BSD-3-Clause | prefetch / `acks_late` 语义 | 仅借语义；需 broker，与无状态执行器冲突，**不引入** |
| openapi-typescript / TypeSpec | MIT / MIT | 码表元数据化 + 声明式错误模型 | 借范式（本仓已在用 openapi-typescript），零新依赖 |
| oasdiff / buf breaking | Apache-2.0 | 破坏性变更判据语义 | **零依赖自研脚本**，不引入 buf |
| Pact | MIT | 「消费者声明差异 → 显式报告」形态 | 借形态，**不引入 pact broker** |

**协议合规结论（2026-11-03 复核订正）**：本轮全部参考**无 GPL/AGPL**；
逐条核验官方 LICENSE 原文后：8 个项目中 **7 个为 OSI 开源**（MIT / BSD-3-Clause / Apache-2.0）；
**hashicorp/nomad 当前版本（≥1.7.0）为 Business Source License 1.1**（source-available，含竞品限制，非 OSI；≤1.6.0 才是 MPL-2.0）⇒ **仅可借鉴思路，不可复制代码**（本轮决策本就是「只借鉴不复制」，故**决策不变**，
但「全部无协议风险」的表述已修正）。详见 `dispatch-core-review.md` §4.2。
本项目为 **AGPL-3.0-only**；**严禁复制** LGPL/AGPL 代码（Dramatiq LGPL-3.0、bubblewrap LGPL-2.1 已明确排除，仅可借鉴思路）。
Buf/protobuf 重量级路线**如实评估为不推荐**（改写 12 schema + 双端运行时 + 双协议期，成本 L，收益/成本比差）。

---

## 4. 主Agent 亲自复核记录（防止转述失真）

| 报告结论 | 主Agent 验证方式 | 结果 |
|---|---|---|
| python/node 挂同一 `interpreter_cache` 卷 | `grep -n interpreter_cache docker-compose.yml` → :537/:684/:1092 | ✅ 证实 |
| node 镜像无 uv（故写不了共享池） | `grep -c uv apps/executor-node/Dockerfile` = **0**；compose node `UV_BIN` 为空 | ✅ 证实（**比原报告更精确**） |
| 裸机 `WORK_DIR` 无实例维度 | `scripts/install.sh:35` `WORK_DIR="/var/lib/autoflow/tasks"` | ✅ 证实 |
| 回调文件名 = 毫秒 + 进程内序号 | `execute.py:3059-3060,3198-3209` 逐行读 | ✅ 证实 |
| 解释器池锁为进程内 | `interpreters.py:1056-1070`（`_version_locks` + `threading.Lock`）、`interpreters.ts:1294`（`inFlight` Map） | ✅ 证实 |
| `selectLeastLoaded` 唯一生产消费方 = deploy | `codegraph impact selectLeastLoaded -d 2` → `app-deployment.service.ts:1333 deploy` | ✅ 证实 |
| 跨端正则不等价 | node `execute.ts:970` 有 `\b`；python `execute.py:717` 无；python 多 `task_launcher` 规则 | ✅ 证实 |
| **F-15「`Task.priority` 完全未接入派发链」** | 读 `task-priority.util.ts`：`toBullPriority` = `5 - dbPriority`，在 `task.service.ts:3092/4571`、`executor.service.ts:1765` 入队时生效 | ⚠️ **修正**：priority **已接入队列出队顺序**（BullMQ priority），只是**未接入执行器选机维度**。原判「完全未接入」**过重** → 降级为「选机维度未接入」 |
| **admin-web「44 处手写类型与 generated 同名」** | 三重实测：① 严格同名（同名 schema）= **6 处**；② `--report` 模式「剥 `Dto/ResponseDto` 后缀后比对」读数 = **44 处**（既有守卫口径）；③ **字段重叠 ≥60% 的语义重复 = 173 处** | ⚠️ **修正计数口径**：风险成立但数字需分层表述。实证：`Task`↔`TaskResponseDto` 重叠 **49/49**、`TaskExecution`↔`TaskExecutionResponseDto` **24/24**、`Application`↔`ApplicationResponseDto` **16/16**；`Executor`↔`ExecutorResponseDto` 重叠 30/33 且**已实际漂移 6 字段**（`capabilities`/`consecutiveHeartbeatMisses`/`createdAt`/`executorStartedAt`/`executorStartupId`/`updatedAt` 在生成物有、手写版无）→ **静默读到 undefined 的路径真实存在** |
| **既有守卫 `check-web-type-drift.mjs` 覆盖面** | 读脚本头注：已冻结手写类型**名字集合与数量**（基线 `scripts/web-type-drift-baseline.json`），并有 `--report` 输出同名读数 | ⚠️ **修正**：既有守卫已防「新增/陈旧/豁免失效」，但**不检测字段级漂移** ⇒ admin-web 域提的新守卫**必须针对字段层**，否则属重复劳动 |
| **admin-web「WEB-1/3/5 已修复」** | SubAgent 引 `39dd4001`；实测 `check-web-type-drift.mjs --report` 正常 | ✅ 接受（不重复报），衍生缺陷「工厂 visible 路径绕过 `reconnect:false` ⇒ 日志流与轮询兜底双跑」待其 hotfix 提案 |
| **deploy「灰度批次互斥在代码中不成立」** | 读 `app-deployment.service.ts:3362`（`findInFlightRolloutRows` 检查）→ `:3445`（`markRolloutState`）→ `:3513`（`markRolloutState` 实现是**无条件 `repo.update`**，注释自述「只写这两列」）；查实体：`app-deployment.entity.ts:68` 的 `idx_app_deployments_rollout_state_active` 是**普通 partial index，非 UNIQUE**；迁移 `1790000000026` 亦为 `CREATE INDEX`（非 UNIQUE） | ✅ **证实**：DB 层无占坑约束 ⇒ 两实例可同时开灰度，文档 `ARCH-MULTI-INSTANCE-MATRIX.md:155` 的断言**结构上不成立**。`claimRolloutRows`（`:3653`）确实是条件 UPDATE，但**仅在失败终结路径**用，创建路径无对应 claim |
| **deploy「`upgrade()` 无行级占坑」** | `upgrade()` 置 UPGRADING + `saveWithOptimisticLock`（乐观锁防覆盖**不防重复执行**） | ✅ 证实（`:2019`） |
| **admin-api 测试基线** | `npx --node-options=--experimental-vm-modules jest` | ✅ **417 套件 / 7,328 用例全绿**（基线，供后续重构验收对照） |
| **admin-api 测试需 ESM flag** | 直接 `npx jest` → **287 套件失败**（`Must use import to load ES Module`）；`package.json` 的 `test` 脚本自带 `--node-options=--experimental-vm-modules` | 📌 **验收命令必须用 `npm test` 或显式带该 flag**，否则误判为基线红 |

---

## 5. 风险与权衡（为什么这些项值得重构，而不是打补丁）

**决策原则**：长期综合收益（可维护性 / 扩展性 / 正确性）> 短期成本与风险时选重构。
但**成本高只是评估因子，不是否决理由**；唯一例外是「重构风险极高且收益极低」——此类才标【临时补丁，后续排期重构】。

| 项 | 补丁方案 | 重构方案 | 裁决 |
|---|---|---|---|
| 派发决策 613 行上帝方法 | 继续在方法内加分支 | 抽无副作用纯决策器（Filter/Score 两阶段） | **重构**（已出过 2 次真实缺陷：QA-05 并发误判、ARCH-35 部署归属丢失，每次都在 613 行里做手工手术） |
| `selectLeastLoaded` 缺 affinity | 只补一行过滤 | 与 dispatch 收敛到共享决策器 | **重构**（影响面仅 10 符号，收益高成本低） |
| 模块 forwardRef 环 | 留环 + 注释 | 全局化 `SecretsCryptoService` 解环 | **重构**（4 文件；21 依赖中仅 1 个跨模块；仓内已有「不引模块」正解先例） |
| 失败分类三份正则 | 继续手工同步 | 码表元数据化 + 分类器生成化（双轨） | **重构**（127 文件受影响；已实测跨端不等价；历史上已翻车 ≥2 次） |
| 进程内锁跨实例失效 | 加 try/except 容错 | flock 文件锁 + 消除序号 | **重构**（容错不解决「同毫秒同序号覆盖丢终态回调」） |
| `execute.py` 5,339 行 | 继续加函数 | 拆 7 子系统 + `preflight()` 校验门 | **重构**（但须分阶段，每阶段可独立 revert） |
| 四个孤立 python 库 | 直接删除 | 降级为**私有包** + 改守卫判据 | **重构（方案 C）**（不是死代码：其重试/熔断契约被 `autoflow-sdk`/`node-sdk` 抄走并注释互指，删除 = 删掉唯一可运行参考实现） |
| 拆 `ExecutorService` 类边界 | 不动 | 兼容门面 + 工厂迁移 | **暂缓**（风险最高；先做派发决策与过滤链拿走 80% 收益，class 边界推迟到下迭代） |

**明确的「不推荐」项**（对抗式评估的产出）：
- Buf/protobuf 全量迁移 —— 成本 L，收益/成本比差，**不做**。
- 引入 Celery broker / Temporal 整套 —— 与本仓「无状态执行器 + 离线私有化」定位冲突，**不引入**，只借思想。
- Drammatiq(LGPL) / bubblewrap(LGPL) 代码 —— 协议风险，**不复制**。
- 指标面作为 contract-crosscut 主要切口 —— `check-alerts-rules.mjs` 与 `check-metric-docs.mjs` **实测全绿**，「dashboard 引用不存在的指标」实测 **0 个** → **降级为 P3**。

---

## 6. 待主Agent拍板项（合并自各域）

| # | 事项 | 备选 | 主Agent 倾向 | 状态 |
|---|---|---|---|---|
| D-1 | 互斥组占位是否计入「排队中的执行」（Airflow 语义） | 维持现状 / 双计数 | **暂缓**（语义歧义非缺陷，改则影响所有挂组应用；需产品口径） | 🕐 待业务确认 |
| D-2 | `selectLeastLoaded` 补 affinity | 补 / 加 flag 灰度 / 不动 | **补 + flag 默认关灰度**（D-3 同源） | 🕐 待复核① |
| D-3 | 亲和改硬过滤 → 软权重（k8s 式） | 改 / 不改 | **暂缓**（用户可见行为变更，超出技术自主范围） | 🕐 待产品确认 |
| D-4 | 四个 python 库走 A/B/C | 发布 / 删除 / 私有包 | **(C) 私有包** | ✅ 已裁决（待实施） |
| D-5 | 是否需要「任务脚本可 pip install」产品能力 | 需要 / 不需要 | **需独立立项**，不阻塞本轮 | 🕐 待产品确认 |
| D-6 | executor-python 是否允许新增 PyPI 依赖 | 允许 / 不允许 | **不允许**（离线私有化零外部依赖；自写 ~80 行 `fcntl`+`msvcrt`） | ✅ 已裁决 |
| D-7 | `interpreter_cache` 拆卷 vs 共卷加锁 | 拆卷 / 共卷+锁 | **共卷 + 锁**（锁文件命名规则两端须逐字一致 + 新增守卫钉住） | 🕐 待复核② |
| D-8 | 裸机 `WORK_DIR` 默认值是否加实例维度 | 加 / 不加 | **不改默认值**（破坏存量升级）+ 脚本输出警告 + 文件锁兜底 | ✅ 已裁决 |
| D-9 | `preflight` 契约位置 | `protocol.json` / 独立文件 | **进 `protocol.json`**（已有 6 同类段 + `schemas` 段，范式成熟，零新依赖） | ✅ 已裁决 |
| D-10 | `run_task` 拆分后落点 | router / `services/execution.py` | **`services/execution.py`**（router ≤250 行），前提是先统一 `HTTPException` 与 dict 两种错误表达 | ✅ 已裁决 |
| D-11 | 错误码重构投入档位 | 全量 / P1-a+P1-b | **P1-a + P1-b**（码表元数据化 + 分类器生成化）；双轨与收敛待向量绿后启 | ✅ 已裁决 |
| D-12 | 协议破坏性变更守卫 | 做 / 不做 | **做**（成本 S，零依赖自研） | ✅ 已裁决 |
| D-13 | 孙Agent 缺失补偿 | 接受自查 / 独立复核 | **已补派 2 个独立复核孙Agent** | ✅ 已执行 |
| D-14 | 部署约束归属（解除 dispatch-core 阻塞） | 归派发内核 / 归 deployment 域 | **归 deployment 域**，按 TS 契约 `DeploymentConstraintProvider.resolve(q) → {mode, source, rows[], versionFact?}` —— 内核**不得直接查 `app_deployments`** | ✅ 已裁决 |
| D-15 | `cron:leader` TTL 30s → 90s | 改 / 不改 | **改**（2026-10-28 事故实测冻结 28–40s 会打穿 30s）；须与 verify 计数化（N=2）**同批**落地 | ✅ 已裁决 |
| D-16 | 灰度批次互斥修法 | 应用层查 / DB 唯一索引 | **DB 部分唯一索引 + 条件写**（`uq_app_deployments_rollout_in_flight ON ("applicationId") WHERE "rolloutState" IN ('pending','probing')`）—— 应用层查是 TOCTOU，**不采纳**。注意存量脏数据需先去重 | ✅ 已裁决 |
| D-17 | `upgrade()` 行级占坑 | 应用层查 / 条件 UPDATE | **条件 UPDATE**（`WHERE id=:id AND status='running'`，affected=0 ⇒ 409） | ✅ 已裁决 |
| D-18 | 是否引入 fencing token | 引入 / 不引入 | **不引入**（成本过高）；本仓是「效率型锁 + DB 兜底」，正是 Redlock 争议中 Kleppmann 建议的正确用法 | ✅ 已裁决 |
| D-19 | admin-web 手写类型是否迁移 | 迁移 / 不迁 | **不迁**（延续 R11 裁定），改用**字段级**漂移守卫把腐烂变成可数读数 | ✅ 已裁决（待实施） |
| D-20 | admin-web 首个试点域 | tasks / 其他 | **tasks**（已有 `task-form/` 拆分样板 + 33 个任务域测试 + 乐观更新三层护栏 + `api/queries.ts` tasks 段自包含度高） | ✅ 已裁决 |
| D-21 | 日志流双跑缺陷是否单列 hotfix | 是 / 否 | **是**（不依赖任何重构，可独立先修） | ✅ 已裁决 |
| D-22 | `pages/settings/*` + `audit` 零覆盖区（3,750 行） | 先补测试 / 先重构 | **先补测试（B0 批次）** —— 否则全部前端重构都是「回归不可见」 | ✅ 已裁决 |

---

## 7. Hotfix 清单（已复核证实的**真实缺陷**，不依赖任何重构，应优先闭环）

> 与「重构方案」分账：这些是**当前就在产生错误行为**的缺陷，先修；重构随后做。

| # | 缺陷 | 证据（主Agent 实测） | 后果 | 修法 | 域 |
|---|---|---|---|---|---|
| **H-1** | PACKAGE_FETCH 分类正则两端不等价 | `task.processor.ts:457` 的正则**缺** `module not found\|cannot find module`；`task.service.ts:1105` **有** | node 执行器上报 "Cannot find module 'x'" ⇒ 被误判 `SCRIPT_ERROR`（引导用户查自己的脚本），实际是**依赖拉取失败** | 单点抽**共享常量**（两侧共用一份 `PACKAGE_FETCH_PATTERN`），并加守卫防再次分叉 | dispatch-core |
| **H-2** | 灰度批次跨实例互斥**结构上不成立** | `app-deployment.service.ts:3362` 检查 → `:3445` 写 → `:3513` **无条件 `repo.update`**；`app-deployment.entity.ts:68` 索引**非 UNIQUE**；迁移 `1790000000026` 亦为普通 `CREATE INDEX` | 两实例可同时对同一应用开灰度，后写者 `batchId` 覆盖先写者 → 批次追踪丢失、灰度推进错乱 | **DB 部分唯一索引** + `markRolloutState` 改条件写；存量脏数据先去重 | deploy-multiinstance |
| **H-3** | `upgrade()` 无行级占坑 | `:2019` 直接置 UPGRADING + 乐观锁（防覆盖**不防重复执行**）；`all` 策略分支（`:3394`）无批次互斥 | 并发 upgrade-all ⇒ 同一部署行两次 deploy 命令（多一次停机+启动） | 条件 UPDATE（`WHERE id AND status='running'`），affected=0 ⇒ 409 | deploy-multiinstance |
| **H-4** | 回调落盘文件名可碰撞 | `execute.py:3198-3209` = 毫秒时间戳 + **进程内**递增序号 | 跨实例同毫秒同序号 ⇒ 同名覆盖 ⇒ **终态回调丢失，任务永远停在 RUNNING** | 文件名改**唯一名**（uuid/随机后缀），**消除序号**（加锁是次优，因序号本身就是碰撞源） | python-executor |
| **H-5** | 跨端失败分类正则不等价 | node `execute.ts:970` 用 `\b` 词边界；python `execute.py:717` **无** `\b`；python 多一条 `task_launcher → sandbox_unavailable`，node 侧零命中 | 同一文案两端归因不同；中文文案含 `\b` 语义差异 → 误分 | 收敛到 `protocol.json` 码表 + 生成器（双轨，见 contract-crosscut 路线） | contract-crosscut |
| **H-6** | SSE 工厂 visible 路径绕过 `reconnect:false` | admin-web 域实测（`39dd4001` 引入 `visibilitychange` 后衍生） | 日志流与 8s 轮询兜底**双跑** ⇒ 双倍流量 + 状态机不同步 | 工厂路径统一走 `reconnect:false` 语义 | admin-web |
| **H-7** | 文档 `ARCH-MULTI-INSTANCE-MATRIX.md` 多条断言与代码相反 | deploy 域实测 **7 条漂移**（3 硬 + 4 表述过强），主Agent 已复核 H-2 对应条目 | 决策文档误导后续会话（历史上已发生「把已做完的事写成待办」导致返工） | 逐条按代码事实订正；文档守卫加断言 | deploy-multiinstance |
| **H-8** ✅已修 | **存量 P1**：`ModuleNotFoundError` 被误判为「执行器离线」 | `failure-patterns.ts` 的 `EXECUTOR_OFFLINE_PATTERN` 裸子串 `enotfound` 命中 `modulenotfounderror` 内的 `...lenotfound...`；规则序 EXECUTOR_OFFLINE 先于 PACKAGE_FETCH ⇒ **两条路径一致地错** | Python 依赖缺失 ⇒ 用户被告知「执行器离线」（排障方向完全错），且 `executor_offline` 语义下回 WAITING 不暴露真实依赖问题 | `\benotfound\b` 词边界；连带补 `modulenotfounderror`/`no module named` | commit `09b5d3c0` |

### H-8 的重要补充：H-1 的原判断被修正
主Agent 最初记录「回调路径归 `PACKAGE_FETCH_FAILED`、派发路径归 `SCRIPT_ERROR`」——**对 Python 文案不成立**。
Python 原文是**连写的** `modulenotfounderror`，原 `PACKAGE_FETCH_PATTERN` 只写了**带空格的** `module not found` ⇒ 接不住；
且子串碰撞让它先被 EXECUTOR_OFFLINE 吞掉。**即：H-1 的「回调路径本来是对的」是错的** —— 两条路径一致地错。
（此修正由实施 Agent 独立发现并反馈，主Agent 已复核确认。）

### 遗留待评审（实施 Agent 报告、只报告未修）
| # | 事项 | 证据 | 为何要评审 |
|---|---|---|---|
| R-1 | `network error` / `socket hang up` 判据**过宽** | `requests.exceptions.ConnectionError: Network error …`（**用户脚本自己的** HTTP 失败）⇒ 归 `executor_offline` | 用户脚本的网络失败被归成「执行器离线」，排障方向错；且 mutex 场景下会回 WAITING 掩盖真实错误 |
| R-2 | `getaddrinfo ENOTFOUND <registry>` 归因 | 真实 npm 文案 `npm ERR! code ENOTFOUND registry.npmjs.org` ⇒ 现归 `executor_offline` | 语义归属歧义：是「网络/环境故障」（可重试）还是「拉包失败」？**改判会动重试集归属** ⇒ 属语义变更，需独立评审 |
| R-3 | `dependency` / `requirements` 判据过宽 | `Failed to resolve dependency injection`、`Invalid requirements: field 'cpu'` ⇒ 归 `package_fetch_failed` | 用户任务自身的字段错误被归成「拉包失败」 |
| R-4 | 回调路径相对 HEAD **新增** `APPLICATION_MISSING`/`SANDBOX_UNAVAILABLE` 两条规则；派发路径新增 `errorCode` 码化优先通道 | `failure-patterns.ts` `classifyFailure` | **相对 HEAD 有语义增量**（非纯修复）——需确认这两条规则在回调路径上是否本就期望（`failure-patterns.ts:130-139` 注释称回调路径「没有」这两条，是缺陷） |
| R-5 | `task.processor.ts:381` 的 `const failureText` 已成死变量 | tsc 未报（无 `noUnusedLocals`） | 清理项，低优先级 |

---

## 8. Round 2a hotfix 交付状态

| 项 | 状态 | 验证 |
|---|---|---|
| **H-1 + H-8** | ✅ **已闭环** | commit `09b5d3c0`（7 路径，显式 add）；**主Agent 独立复跑全量 = 421 套件 / 7,434 用例全绿**（基线 417/7,328 ⇒ **+4 套件 / +106 用例，只增不减**）；`tsc --noEmit` 0 错；`check-failure-reasons` / `check-guards-wired`（59 个守卫全接线）/ `check-enum-drift` / `check-metric-docs` 全绿 |
| 新增守卫 | ✅ `failure-classification.path-parity.spec.ts`（27 条） | 行为金标 17 行 × 两条路径入参形状 + **反向断言**（ENOTFOUND/ECONNREFUSED 仍归 executor_offline）+ **结构防分叉断言**（判据常量在 `src/` 内唯一定义处；两消费者必须 import `classifyFailure`、不得 `const` 判据、判据令牌 0 处）。守卫**非空自证**：对 HEAD 旧版跑同一判据能命中（旧 processor 6 令牌 / service 9 令牌） |
| H-2 ~ H-7 | 🕐 待派 | H-2/H-3（deploy，DB 唯一索引 + 条件写）、H-4（python 回调文件名）、H-5（跨端正则，需 contract-crosscut 配合）、H-6（admin-web SSE 双跑）、H-7（文档订正） |

**并行工作区提醒（2026-11-03 02:2x 实测）**：除本会话产物外，工作区还出现
`apps/admin-api/src/modules/executor/executor-filters.util.ts`（02:18，**未被任何代码引用**）、
`.env.example` / `apps/admin-api/src/config/configuration.ts` / `executor.service.ts` 的改动 ——
判定为**另一并行会话**在实施 dispatch-core Q5（过滤链收敛，带 `applyAffinityFilters` 默认关闭开关）。
**本会话未收编这些文件**，也未改动 `executor.service.ts`（避免写域冲突）。
⚠️ 需在最终收口时与用户确认两会话口径合并。

---

## 9. 下一步行动（Round 1 收口 → Round 2 攻坚）

### 9.1 已交付（Round 2a 第一批）
- ✅ **H-1 + H-8**（失败分类单一事实源 + 存量 P1 修复 + 27 条防分叉守卫）—— commit `09b5d3c0`
- ✅ **dispatch-core 过滤链收敛**（三处派发/选机路径共用一个纯函数实现，含 `applyAffinityFilters` 显式开关）—— commit `b5a73734`
  （并行会话产出；主Agent 已独立复跑 executor 域 **43 套件 / 1,152 用例全绿**，并确认三处生产路径均已接入）

### 9.2 待办
1. 收齐 2 份独立复核报告（`bbdb4f95` dispatch-core / `eff5335a` python-executor）—— 二者仍在运行。
2. 主Agent 终审：逐条对照本台账，产出**放行 / 修改 / 暂缓**三态决议。
3. **Round 2a 剩余 hotfix**：H-2 / H-3（deploy，DB 唯一索引 + 条件写）、H-4（python 回调文件名唯一化）、
   H-5（跨端正则，需 contract-crosscut 配合）、H-6（admin-web SSE 双跑）、H-7（文档订正）+ R-1 ~ R-5 待评审项。
4. **Round 2b（结构性重构）**：写域隔离并行 ——
   - dispatch-core：`dispatch()` 纯决策器抽取 + 模块 forwardRef 解环（依赖 D-14 契约先行）
   - python-executor：`execute.py` 分阶段拆分 + `preflight()` 校验门
   - contract-crosscut：码表元数据化 + 分类器生成化（**依赖前两者的收敛结果**，排最后）
   - deploy-multiinstance：灰度状态机拆分（**依赖 H-2/H-3 先落地**）
   - admin-web：B0 补测试 → tasks 域试点 `features/` 分层
5. 每域验收：定向 spec + 全量回归（**必须用 `npm test` 或显式 `--experimental-vm-modules`**）+
   `tsc --noEmit` + 相关守卫脚本。
   ⚠️ **基线已更新**：因并行会话新增 executor 过滤链 spec，全量基线升至 **421 套件 / 7,434 用例全绿**（主Agent 02:3x 独立复跑）。
6. 复盘：更新本台账、待优化清单、已参考开源仓库清单、CodeGraph 探查记录清单。
7. **与并行会话的口径合并**：工作区存在另一会话的产出（见 §8 末尾提醒），最终收口时须与用户确认合并口径，
   避免两套裁决记录并存。

---

## 10. 两会话口径合并（主Agent 02:4x 收口记录）

§8 末尾提醒的「另一并行会话产出」经主Agent 逐文件核对，**已全部收编进主线**，
不存在两套并存口径：

| 并行会话产出 | 主Agent 核对结论 | 落点 |
|---|---|---|
| `executor-filters.util.ts`（过滤链收敛） | ✅ **与本会话 dispatch-core 阶段 1.3 同一切口**，实现已在 `b5a73734` 落地；主Agent 已独立复跑 executor 域 43 套件 / 1,152 例全绿，确认 `dispatch` / `dispatchBroadcast` / `selectLeastLoaded` **三处生产路径均已接入** | `b5a73734` |
| `.env.example` + `configuration.ts` 的 `EXECUTOR_SELECTION_AFFINITY_ENABLED` | ✅ 内容与主Agent 的 D-2 裁决（**补 + flag 默认关灰度**）逐字一致；`check-env-drift` 全绿（229 键全覆盖） | `b5a73734` |
| `failure-classification/**` + `error-code-failure-reason.ts`（分类链收敛 + 码化优先） | ✅ 主Agent 本会话产出，与实施 Agent 的 `09b5d3c0` **同批落地**（同一目录、同一裁决） | `09b5d3c0` |
| `dispatch-decision-log.schema.ts`（决策日志 schema 化） | ✅ **主Agent 本会话产出**，dispatch-core 阶段 1.4 项；两个出口字段集统一、取整口径唯一、校验失败不阻断主链 | `09d69dab` |

### 10.1 Round 1 最终交付清单

| 交付 | 提交 | 验证 |
|---|---|---|
| dispatch-core 阶段 1.1 + 1.2（分类链单一事实源 + 码化优先） | `09b5d3c0` | 全量 421 套件 / 7,434 例绿；`check-failure-reasons` / `check-enum-drift` / `check-metric-docs` 全绿 |
| dispatch-core 阶段 1.3（过滤链三路径共用一份纯函数） | `b5a73734` | executor 域 43 套件 / 1,152 例绿；新增 25 例表驱动 spec |
| dispatch-core 阶段 1.4（决策日志 schema 化，两出口字段集统一） | `09d69dab` | 全量 **422 套件 / 7,451 例绿**；`tsc --noEmit` 0 错 |

**全量基线（Round 1 收口）**：**422 套件 / 7,451 例全绿**（起点 417 套件 / 7,328 例 ⇒
**+5 套件 / +123 例，只增不减**）；`tsc --noEmit` 零错误；
`check-failure-reasons` / `check-env-drift` / `check-guards-wired` 全绿。

### 10.2 本会话主Agent 的独立取证（不依赖任何 SubAgent 转述）

- `ModuleNotFoundError` 子串碰撞（`...lenotfound...`）是**存量 P1**，两条路径
  **一致地错**（原台账 H-1 的「回调路径本来是对的」判断已被订正）——此判断由
  实施 Agent 独立发现并反馈，主Agent 已复核确认（`\b` 词边界修复已落地）。
- `EXECUTOR_OFFLINE_PATTERN` 中文支容差 **120**（非 20）——`task.service.ts`
  的注释记录了「20 → 63 字符」的历史缺陷并已修复；本轮**码化优先**通道
  （`PINNED_EXECUTOR_OFFLINE` → `executor_offline`）使该文案**彻底不再依赖
  正则容差**，从「调容差」升级为「与文案长度解耦」。
- `failureReason` **不只是标签**：它决定 ① 是否进 `UnrecoverableError`（烧不烧
  重试预算）② 互斥组任务是否**回 WAITING 等唤醒**而非落死。故主Agent 对
  `ERROR_CODE_FAILURE_REASON` 采取**从严收录**（当前仅 1 条映射），并把
  `NO_EXECUTOR_MATCHING_FILTERS` 等「改判会静默改重试/排队语义」的码**明确
  排除**并在注释中写明排除理由（避免后续评审误判为漏项）。


---

## 10. 独立验收结论与主Agent 订正（2026-11-03 03:1x）

> 验收官：`verify-reconcile`（只读，产出 `verify-reconcile.md` 466 行 / 8 节）。
> 结论**两个 commit 均「有条件放行」**，但放行理由完全不同。以下为**主Agent 已亲自复核确认**的订正。

### 10.1 两个 commit 的真实状态

| commit | 结构改动 | 缺陷修复 | 判定 |
|---|---|---|---|
| `09b5d3c0` 失败分类单一事实源 | ✅ 真做成 | ✅ `\benotfound\b` **真修好**（15 例复刻：12 条真实离线/DNS 文案零漏判，3 条模块缺失正确翻转） | **有条件放行** |
| `b5a73734` 过滤链收拢 | ✅ 真做成（group/tags/affinity/anti-affinity/runtime **五维逐一等价**） | ❌ **F-07 缺陷 0% 修复** | **有条件放行** |

### 10.2 伪修复 #1：`EXECUTOR_SELECTION_AFFINITY_ENABLED` 是**空转开关**
**主Agent 独立复核确认**：`selectLeastLoaded`（`executor.service.ts:4664` 附近）的入参 `opts` **没有**
`affinity`/`antiAffinity` 字段；唯一生产调用方 `app-deployment.service.ts` 的 `deploy()` 是**零参数调用**
⇒ `executor-filters.util.ts:172` 的 `hasAffinityDim` **恒为 false** ⇒ **开与不开行为完全相同**。

- commit message **诚实披露**了该残留（值得肯定）；
- 但 `configuration.ts:465` 原写「置 `true` 后选机路径与派发路径的亲和语义**逐字一致**」——
  **该表述为假**，而配置文件注释才是运维真正会读的地方。
- **已订正**（主Agent 直接改）：`configuration.ts` 该段改为如实说明「本开关当前空转、F-07 状态仍为未修复、
  打开它不会让部署选机尊重亲和」，并指向 D-14 契约项。
- **F-07 状态订正为「未修复」**，不得据 `b5a73734` 认为已修。

### 10.3 伪护栏 #2：27 条守卫**挡不住它要防的回归**
**验收官实测证据（主Agent 已确认结构缺陷成立）**：把裸子串 `enotfound`（正是 `09b5d3c0` 修的缺陷）
**加回消费者**，27 条守卫**全绿**。三重原因：
1. 行为金标表**直接调 `classifyFailure(...)`，不经过任何消费者**（`task.service.ts::inferFailureReason` / `task.processor.ts` catch 链）
   ⇒ 保护的是「函数」而非「两条失败路径」；
2. `TOKENS` 判据**刻意排除**中文词与 `enotfound`（见 parity spec `:244` 附近），结构断言抓不到原始缺陷形态；
3. 两个测试目录**无任何 `ModuleNotFoundError` 端到端用例**。

⇒ **已派 `guard-hardening`**：把守卫从「函数级」升级为「消费端端到端级」，并以
「**把裸 `enotfound` 加回消费者 ⇒ 守卫必须变红**」作为**反向验证**的验收判据。

### 10.4 新发现的语义近似（本轮不改行为，登记待立项）
`PACKAGE_FETCH_PATTERN` 现含 `modulenotfounderror|no module named` ⇒ 「用户脚本 `import pandas` 失败」
被归 `package_fetch_failed`。更精确的语义应是新增 **`dependency_missing`** 码值。
- **本轮不改**：新增 failureReason 码值属**协议变更**（需 bump `protocolVersion`），不适合作 hotfix；
- **已派 `guard-hardening` 钉桩**：用 spec 记录「当前→`package_fetch_failed` 是已知近似、待迁移」，
  并**同时钉死「绝不能回退到 `executor_offline`」**（这才是本轮修复的核心价值）。

### 10.5 台账数字订正（验收官复算 + 主Agent 复核）
| 项 | 台账原值 | **订正值** | 成因 |
|---|---|---|---|
| `task.service.ts` 行数 | 6,990 | **6,903** | 测量发生在 `09b5d3c0` 落地前；该提交净删 87 行 |
| admin-api 全量套件 | （他人宣称）484 套件 / 8,196 例 | **物理不可能**——admin-api 仅 **420~422 个 spec** | 该数字来自**分片并行跑**的累加，非单次全量 |
| 手写类型语义重复 | 173 处 | **口径不可复现**（20 种口径无一命中 173，最接近 138/176） | 该数由验收官与主Agent **各自口径**算出，均非 173 ⇒ 应标注为「口径依赖，需固定判据后重算」 |
| `Executor` 漂移字段 | 6 个 | **6 个确认**；但「30/33 重叠」应订正为 **33/33**（手写 33 字段全部被生成物包含） | 分母取错 |

### 10.6 并发工作流风险（均已**实测发生**，不是理论）
1. `b5a73734` 被 **amend**（同一 ref 两次读出 8,454 / 8,489 行）；
2. 验收窗口内 HEAD 前进两次（`09d69dab` / `77eacda5`）；
3. 台账在 02:52 被改写，致验收基准失效；
4. `contract-source` 改 `packages/executor-protocol/protocol.json` 使**主干确定性红**（在途改造期）。

**主Agent 采纳的纪律（即刻生效）**：
- **验收一律钉 `sha` + 时刻**，台账数字表加「时刻」列；
- **禁止 amend 待验提交**（已提交即冻结）；
- `apps/admin-api/src/modules/executor/executor.service.ts`、`scheduler.service.ts`、`common/leader-gate/` 列为**串行区**，改动须先声明；
- 契约改造（`protocol.json`）**走分支**并公告「**改造中红 ≠ 回归**」——定向测试优先，禁止用全量红绿判断他人改动。

### 10.7 驳回项
- **驳回**域报告「A1 改为已决」：**A1（FIRE_ONCE 补偿是否把窗口内任何执行视为已覆盖）仍为开放项**，
  无实现证据。按「已决」执行会**新增一条文档漂移**（本仓已反复栽在此）。A1 保持 🕐 待产品裁定。

---

## 11. 🔴 主Agent 阻断性发现：H-2 修复方案存在 **P0 回归**（2026-11-03 03:2x）

> **状态：未提交（工作区在途），已阻断，禁止入库。**
> 发现方式：主Agent 在验收 `e04f2616` 的 H-2 改动时，**主动验证「一个灰度批次涉及多少行」**
> ——这正是我在派单时要求「先取证再动手」的那一步。

### 11.1 缺陷机理（已逐行确认）

新迁移 `1790000000094` 建了：
```sql
CREATE UNIQUE INDEX uq_app_deployments_rollout_in_flight
  ON "app_deployments" ("applicationId")
  WHERE "rolloutState" IN ('pending', 'probing')
```
⇒ 语义是「**同一应用至多一行**处于在途灰度态」。

但代码 `app-deployment.service.ts:3522` 是**逐行**写：
```ts
for (const d of canaryRows) {
  const marked = await this.markRolloutState(d.id, RolloutState.PENDING, {...});
  if (!marked.ok) { /* return blockedReason「另一实例在推进」*/ }
}
```
而 `canaryBatchSize()`（`dto/rollout.dto.ts:169`）= `ceil(N × pct/100)`，默认 pct=50，钳 `[1, N]`。
⇒ **N=10 时 canaryCount=5，即 5 行同时被置 `pending`**。

**冲突必然发生**：
| 步 | 行为 | 结果 |
|---|---|---|
| 第 1 行 | `rolloutState='pending'` | ✅ 索引允许（1 行在途） |
| 第 2 行 | `rolloutState='pending'` | ❌ **23505 唯一冲突** |
| 冲突处理 | `isInFlightUniqueViolation` → `{ok:false, reason:"another rollout batch..."}` | 循环立即 `return ok:false` + `blockedReason` |
| **残留** | **第 1 行已写入 `pending` 且无人回滚** | 🔴 **该应用后续所有灰度被永久阻塞**（`findInFlightRolloutRows` 恒命中） |

**同一缺陷在 `:3836` 的 `PROBING` 循环里再犯一次**（多行同时置 probing ⇒ 同样撞索引）。

### 11.2 为什么测试是绿的（测试假绿，典型）
`app-deployment.service.spec.ts` 用 **mock repo** ⇒ **DB 唯一约束根本不存在于测试环境**
⇒ 单测无法覆盖该约束。**这是「单元测试全绿但生产必炸」的教科书案例。**

### 11.3 判定与处置
- **阻断**：该改动**不得入库**（当前未提交，符合「未提交即未发布」）。
- **方案错误根因**：把「**批次级**（一个应用同时只有一个灰度批次）」约束，错误地实现在「**行级**（`rolloutState` 逐行流转）」的列上。
  产品约束是应用维度的，但载体是行状态 —— 二者不匹配。
- **正确设计（主Agent 裁决）**：**批次占坑独立成表**
  `app_rollout_batch_claims (applicationId PK, batchId, state, leasedBy, createdAt, heartbeatAt)`，
  唯一性由该表主键保证 ⇒ 行级 `rolloutState` 可自由多行 pending/probing，不再与批次互斥纠缠。
  释放语义：批次终结（promoted/failed/rolled_back）时删除/置终态该 claim 行。
- **保留可用的部分**：`markRolloutState` 的**条件写**（带状态守卫 + 23505 捕获）与
  `{ok, reason}` 返回类型是**正确的**，可保留；只需把「应用级唯一」从 `app_deployments` 上移走。
- **必须补的测试**：一个**多行 canary（canaryCount>1）**的用例，且**必须在能施加唯一约束的层面验证**
  （集成测试 / 或在单测里显式模拟「第二行抛 23505」并断言**批次仍成功**）。否则同类假绿会复发。

### 11.4 教训（写入本轮方法论）
> **「先取证再动手」不是流程装饰。** 我在派单里明确要求「必须先搞清楚一个批次涉及多少行、
> 若多行则应用级唯一索引会误伤」，执行方给出了应用级唯一索引 —— 说明该取证**没有真正做**。
> 主Agent 的职责就是在放行前补上这一步。**结论：派单里写「必须取证」不等于取证会发生，
> 主Agent 必须亲自复核关键不变量。**

### 11.5 止血执行记录（主Agent 亲自操作，2026-11-03 03:2x）

**决定**：P0 错误方案**不允许以「未提交在途」状态留在工作区**——本仓已发生过「并行会话收编他人文件并提交」，
留着的坏代码随时可能被第三方带走入库。

**操作**：
1. 现场备份到 `/tmp/acf-h2-blocked/`（迁移文件 + service diff + spec diff），供后续正确实现参考；
2. `git checkout --` 回退 4 个部署域文件（`app-deployment.service.ts` + 3 个 spec）；
3. 删除未跟踪的错误迁移 `1790000000094-*`；
4. **复验**：`npx tsc --noEmit` = **0 错**；`jest src/modules/application` = **20 套件 / 467 用例全绿** ⇒ 已回到安全基线。

**保留待用（未丢失）**：前方案中**正确**的部分（`markRolloutState` 条件写 + `{ok, reason}` + 23505 捕获）
已完整保存在 `/tmp/acf-h2-blocked/app-deployment.service.ts.diff`，后续重设计可直接取用。

**后续 owner**：因全局子代理并发已达上限（`active child limit: 10`），未能即时派发；
待槽位释放后交给 `verify-reconcile`（已通过验收证明其辨别真伪修复的能力）接手独立表方案。

---

## 12. 其他并发工作区观察（主Agent 记录，不干预）

| 现象 | 判定 | 处置 |
|---|---|---|
| `apps/executor-python/routers/execute.py` 被改（H-4：`callback-{ms}-{seq}-{uuid8}.json`） | 有人在做 H-4，方向正确（uuid 保证唯一性、注释如实说明「无代码按文件名解析序号」） | **未干预**；⚠️ 但仍保留 `exists()→unlink()→rename()` 非原子三步，验收时要求改 `os.replace` |
| `apps/admin-api/src/__calib2.ts`（未跟踪临时标定脚本，import `typescript` 并读 task.service/processor） | 某 Agent 的临时分析脚本，**误落在 `src/`** | ⚠️ **不得提交**；主Agent 已在验收清单标记，要求其 owner 自行清理（未擅自删除，避免打断在途工作） |
| `packages/executor-protocol/protocol.json` + `contract-fixtures/contract.json` + `generated/` 在途改造 | `contract-source` 正在做码表元数据化（P1-a） | 已知会使主干**确定性红**（改造中），验收时按「改造中红 ≠ 回归」处理 |
| `leader-gate.service.ts` / `scheduler.service.ts` 在途（TTL 30s→90s + verify 计数化） | 另一会话在实现**我在台账里裁决的 D-15** | 协作而非冲突；**串行区**，本会话不碰 |

---

## 13. H-2 重设计：四条硬缺陷门槛 + 并发写者裁决（2026-11-03 03:5x）

### 13.1 写者裁决（本轮最关键的协调决定）
`app-deployment.service.ts` 在 14 分钟内被**三个不同 md5** 覆盖（`1c9206f0` 03:36:25 → `ffd5bd28` 03:50:29 → …），
两个写入方同时实现同一设计 ⇒ 必然产出**半损坏实现**。

**裁决**：该文件唯一 writer = **另一写入方**（它已引用新的 `1790000000095`、已出现
`.set({ rolloutBatchClaimId: batchId })` + `andWhere('"rolloutBatchClaimId" IS NULL')` 的 CAS 接线 5 处）。
**理由**：主Agent 无法命令非本团队会话停手；在「不能停它」与「必须单一 writer」之间，唯一可行解是让实际持有者继续持有。
`verify-reconcile` 转为**验收 + 唯一 spec 作者**（仅可新建 `app-deployment.rollout-claim.spec.ts`，不碰既有文件）。

### 13.2 四条硬缺陷 —— **升为放行前置门槛（缺一不放行）**
| id | 缺陷 | 门槛判据 |
|---|---|---|
| **F-8**（最高） | `isInFlightUniqueViolation` 只认旧索引 ⇒ **新索引 23505 落进通用 catch ⇒ `return {ok:true}`** ⇒ 占坑冲突被当成功 ⇒ **双批次放行** | claim 路径必须显式识别 `uq_app_deployments_rollout_claim`；**任何 claim 冲突不得走 fail-open `{ok:true}`**；需测试：模拟 claim 23505 ⇒ 必须 blocked |
| **F-6** | `deploy()` 行复用清 `rolloutState/meta` 但**不清 claim** ⇒ claim 永久滞留 ⇒ 该应用再也开不了灰度 | 行复用后 `rolloutBatchClaimId IS NULL` |
| **F-1** | `failBatch` 结算集**不含 `promotedIds`** ⇒ 提升轮失败后那些行永久 pending | failBatch 后**无**行残留 pending/probing |
| **F-2** | 重启 sweep 跳过「租约新鲜」行，而租约每 5s 刷 ⇒ **任何 SIGKILL 必落新鲜窗** ⇒ 行永不标 failed ⇒ 永久 blocked | 需区分「活着在刷」与「进程已死但租约新鲜」（进程启动标识校验 / reaper 阈值低于租约） |
| **F-9**（主Agent 补） | claim 残留论证为「≤60s 租约 + 一次 scan」，但**只有启动时扫一次、无周期 reaper** ⇒ 实际 **∞** | 要么补**周期 reaper**（复用 cron + leader 门），要么在风险台账留**带 owner 的跟踪项**；不接受「写进报告算完」 |

### 13.3 崩溃顺序（采纳 `verify-reconcile` 论证）
**「先 settle 行终态 → 最后 release claim」**：
- **P1**（settle 后 release 前崩溃）= claim 残留但行是对的 ⇒ **scan 可恢复** ✓
- **P2**（release 后 settle 前崩溃）= 应用看似空闲 ⇒ 另一实例建新批次 ⇒ **双批次 = 正是要修的缺陷** ✗
- **实现约束**：`release` 必须用**调用前捕获的 `batch.batchId` 局部变量**，不能依赖 `rolloutBatches.get()`
  （`finishBatch` 先 delete 内存态，崩在 delete 后即无从释放）。

### 13.4 成套性纪律（本轮最重要的一条设计约束）
**列 + 索引 + claim 逻辑 + release + scan 兜底，缺一即失效**：
- 只有索引 → 永不触发（伪安全感，**无红信号**）；
- 只有逻辑 → 两实例抢**不同** owner 行时双方 `affected=1` 全成功 ⇒ **claim 完全失效**；
- 缺 release 或缺 scan → **永久阻塞**（等同 P0）。
⇒ **提交要么全带要么全不带。** 并且：P0 的引爆点是**索引**，不带索引时条件写不会炸
（守卫按行、5 行 `rolloutState` 均 NULL）⇒ 当前处于**潜伏态**，一旦有人补上索引即引爆。

### 13.5 对派单的两处纠正（采纳）
1. **矩阵 ⑤「手工停止」剔除**：admin-api **无停止/暂停灰度端点**（`POST /:id/stop` 只置 `status=STOPPED`，不碰 `rolloutState`）⇒ 照写即假绿。改为 B11/B12/B13 隐式路径释放。
   **同时登记一条产品缺口**：「灰度批次无人工中止能力」（能力缺失，非本任务范围）。
2. **P0 引爆点 = 索引**，已升级为报告**抬头**必写项（后来人最易漏）。

### 13.6 方法论沉淀（本轮三条）
1. **派单里写「必须取证」≠ 取证会发生**：H-2 首版方案错在「把应用级约束实现在行级载体上」，正是取证缺失；
   主Agent 必须**亲自复核关键不变量**（我用「canaryBatchSize 默认 50% ⇒ 5 行」一步戳穿）。
2. **单元测试全绿 ≠ 生产安全**：mock repo 不含 DB 唯一约束，H-2 首版 P0 与失败分类守卫盲区**都是这个形态**。
   验收标准必须包含「**能否施加该约束**」与「**把缺陷加回去会不会红**」。
3. **并发写入下，让单文件多 writer 是最坏选择**：宁可让实际持有者独写、把他人转为验收，也不要"人人可改"。

---

## 14. Round 2 收口状态（2026-11-03 08:5x）

### 14.1 H-2 门槛达成情况（主Agent 亲自复跑）

| 门槛 | 状态 | 证据 |
|---|---|---|
| **F-8** claim 23505 显式识别新索引名 | ✅ **达成** | `app-deployment.service.ts:151` 有 `const ROLLOUT_CLAIM_UNIQUE_INDEX = "uq_app_deployments_rollout_claim"`（**代码**，非注释） |
| **F-9** 误归因分支删除 | ✅ **达成** | 对方独立得出同一结论并修正 |
| **F-6** 复用行清 claim | ✅ **达成** | `:1550` `reusable.rolloutBatchClaimId = null;` |
| **F-1** failBatch 结算集含 promotedIds | 🕐 **延期**（门:service 冻结） | 按裁决不算豁免，最终 sign-off 前必须补 |
| **F-2** 死进程+新鲜租约可恢复 | 🕐 **延期**（门:service 冻结） | 同上 |
| **F-9b** 周期 reaper | ❌ **未达成（硬门槛）** | 见下 14.2 |
| `094` 字符串清零 | ✅ 达成 | `grep -c "1790000000094\|uq_app_deployments_rollout_in_flight"` = **0** |

**门禁 spec 实测**：`app-deployment.rollout-claim.spec.ts` = **11 passed / 11 total**
**部署域全量回归**：**77 套件 / 818 用例全绿**

### 14.2 F-9b 未达成的精确证据 + 修法（写给我方/对方共同执行）
现状（主Agent 实测）：
- `markInterruptedRolloutsFailed`（`:4779`）**仅被 `onModuleInit` 调一次**（`:4768`）；
- 该方法批量 UPDATE 只写 `rolloutState = FAILED` + `rolloutMeta`，**不清 `rolloutBatchClaimId`**；
- 全文件唯一 `@Cron` 是 `detectStuckDeployments`（`:3113`，`"0 */2 * * * *"`），**只写 `status`、不碰 claim**；
- 全文件**无 `reap`/周期回收**痕迹（grep 命中 0）。

⇒ **崩溃后 claim 残留 = ∞**；叠加「灰度批次无人工中止端点」⇒ **零兜底**。

**要求的两处最小改动**：
1. 该批量 UPDATE 的 `set` 里**增加** `rolloutBatchClaimId: null`（否则即使调度了也不释放，等于没修）；
2. 新增 `@Cron` 周期调度（**周期 30s < 租约 TTL 60s**），方法体内**必须**：
   - 用 `guardedCron(...)` 包顶层异常（仓内 `cron-guard.util` 是唯一实现，rt-5 纪律）；
   - 走 `LeaderGateService` 门禁（多实例下仅 cron leader 执行，ARCH-31 §5）。

### 14.3 一处**假红**由主Agent 修正
门禁 spec 的 F-6 判据原只认**对象字面量**语法（`rolloutBatchClaimId: null`），
而复用路径实际用**赋值**语法（`reusable.rolloutBatchClaimId = null`）⇒ 代码已正确修复后**仍报红**。
**假红比不红更糟**（训练读者忽略这盏灯）。已改为同时接受 `[=:]` 两种形态，语义不变。
**教训**：源码文本断言必须与语法形状解耦。

### 14.4 `dispatch-core` 独立复核的三条**推翻性**修正（采纳）
| 项 | 原报告 | 复核结论 | 主Agent 裁决 |
|---|---|---|---|
| **Q5** | 「过滤链缺维度」 | 过滤链**早已收拢齐全**；真实缺口在**调用侧入参与契约**。**更严重**：生产调用方 `app-deployment.service.ts:1333` 是**零参数调用** ⇒ 连 group/tags/runtime 三维都是空的 ⇒ **候选池 = 全部 ONLINE** | **采纳**，缺陷升级；照原描述施工会改错地方 |
| **Q3** | 「4 文件解环」 | **漏第三对模块环** `task.module.ts:65 ↔ scheduler.module.ts:19`；`TaskModule` 是**四方环枢纽**（Executor/Scheduler/Agent/Application）；provider 级 forwardRef 跨模块 **2 处**（非 1 处） | **采纳**，Q3 升为 **Q2 的前置**；工作量被系统性低估 |
| **Q4** | 待修 | **已被 `09b5d3c0` 修复**（两路径共用 `classifyFailure`）⇒ 必须**标记完成**，否则重复施工 | **采纳**，标完成；但中文容差 120 魔数仍在（`failure-patterns.ts:117`）→ 转残留账项 |

**另**：Q1 切缝纯度**逐行核验证实**（`applyInterpreterFilter:3262` / `executor-filters.util.ts:224` / `partitionByDeploymentAffinity:125` / `partitionByInterpreterCache:356` 均无 await/repo/http）；
**但报告的行段边界已过期**（过滤链收拢致行号移位）⇒ 实施**必须用符号边界，不用行号**。
**F-13 证实**（pinned 满载丢 pinned 语义，`executor.service.ts:5584`）→ 真实缺陷，立即修。
**F-15 表述过宽** —— priority **已接入 BullMQ 队列优先级**（`:1773`），未接入的是**选路评分** ⇒ 属**产品决策**（涉抢占语义）。

### 14.5 `guard-hardening` 交付（方法论正确落地）
- 新增 **23 条**守卫（`consumer-e2e` 18 + `dependency-missing.semantic` 5），既有 27 条**一条未删**，**零非测试源码改动**。
- **复现指控**：在 `/tmp` 隔离副本注入裸 `enotfound` → 旧 `path-parity.spec.ts` **PASS（全绿无感）**。
- **反向验证实证（三种注入形态，旧全绿 / 新变红）**：裸 enotfound→service；裸 enotfound→processor catch；**新增第三条分类路径**。
- **消费者全集 = 恰好两处**（CodeGraph 探查 + AST 扫描双证）：`task.service.ts` 与 `task.processor.ts`；`execution-callback.controller.ts` 零 `failureReason` 引用。
- **诚实自评三类仍会漏判**：① 改名（令牌名单是枚举，必然漏）② 内联（`"Module"+"NotFound"` 字面量拼接，AST 看不见）③ **全新文件自带判据挡不住**（全 `src/` 扫描有 47 处合法命中，不能一刀切）。
- **副产品**：判据的 load-bearing 自检**首次运行就抓到自己 5 条死令牌**，据此改成「整段命中 + 包含令牌」双路径。

### 14.6 主Agent 对 `dispatch-core` 复核 7 项请示的裁决
| # | 事项 | 裁决 |
|---|---|---|
| D-1 | pinned 满载丢失 pinned 语义（`:5584`） | ✅ **立即修**（真实产品缺陷，文案与离线/不存在形态不一致） |
| D-2 | `EXECUTOR_SELECTION_AFFINITY_ENABLED` 空转开关 | ✅ **删除**（三方中最差选项：留着=假安全感；补齐需先有字段）。待 deployment 约束契约把 affinity 接进选机路径时**再引入** |
| D-3 | Q3 扩为四方环 | ✅ **采纳**，Q3 定为 Q2 前置 |
| D-4 | `Task.priority` 是否接入选路评分 | 🕐 **待产品裁定**（涉抢占语义，技术不宜单方裁决） |
| D-5 | 同分轮转（`ringOffset`）后置 | ✅ **采纳**（与纯决策器的无状态性冲突，放编排层） |
| D-6 | Q4 标完成 + 转残留账项 | ✅ **采纳**（残留：`ModuleNotFoundError`→`package_fetch_failed` 语义近似、27 条旧守卫挡不住改名/内联） |
| D-7 | 切缝用符号边界而非行号 | ✅ **采纳为纪律**（行号 20 分钟内漂移 4 次已成实证） |

---

## 15. `09d69dab` 独立复核（补覆盖缺口）+ D-8 已闭环（2026-11-03 08:5x）

### 15.1 覆盖缺口说明
本域三个提交中：`09b5d3c0` 由 `verify-reconcile` 复核、`b5a73734` 由 `dispatch-core` 复核，
**唯独 `09d69dab`（决策日志 schema 化）此前无人独立复核**。该缺口现已补齐（`dispatch-core-review.md` §4.1，374 行）。
**判定：6 条声称中 5 条证实、1 条部分证实。**

### 15.2 部分证实的那一条 → 真实契约缺陷
提交声称「缺必填字段即抛 TypeError」，但 `requireCandidate` 里 **`score` 是唯一被静默兜底的必填数值字段**：
`roundScore(...) ?? 0` 把 `undefined` / `NaN` / `null` 全压成 `0` **且不记入 `problems`**。

实测（复核实证）：
```
NO-THROW selected.score=undefined -> {"address":"a","score":0,...}
NO-THROW selected.score=NaN       -> {"address":"a","score":0,...}
THROW    selected.address missing -> 调度决策日志字段校验失败：selected.address 必须是字符串
```

**为什么值得修**：`score=0` 在该日志里的语义是「负载评分最低 = 最空闲 = 最优」——**恰恰是最有误导性的值**。
排障者会得出「这台完全空闲却被别的因素淘汰」的错误结论，而日志里**无任何缺字段痕迹**。
**可达性（如实）**：`computeExecutorLoadScore` 恒返回 number ⇒ **生产当前不可达**，属**契约一致性收口**，非线上缺陷。

**裁决 D-8：修**（成本 3 行 + 3 条测试）。**主Agent 已亲自落地**：
- `dispatch-decision-log.schema.ts` 的 `requireCandidate`：改为先 `roundScore(...)` 判空，
  为 `null` 时 `problems.push(...)`（保留 `?? 0` 仅为维持下游字段形状），并写注释记录 D-8 由来与可达性；
- `dispatch-decision-log.schema.spec.ts` 新增 **3 条**钉桩：`score: undefined` ⇒ 抛 TypeError、
  `score: NaN` ⇒ 抛 TypeError、错误信息含 `selected.score`（可定位）。
- **验证**：`jest src/modules/executor/__tests__/dispatch-decision-log` = **15 passed / 15 total**（原 12，+3）。

### 15.3 另一条「形式统一 vs 信息量」发现
选机路径**完全未传** `deploymentAffinity` / `deploymentConstraint` / `interpreterCacheAffinity` 三维（恒 `null`），
而 dispatch 路径三者齐全 ⇒ 目前是**形式统一**。
- `interpreterCacheAffinity` **有信息量**（选机路径确实调了 `applyInterpreterFilter`，日志却记 `null`）⇒ 值得补；
- `deploymentAffinity` / `deploymentConstraint` **确实不适用**（选机不实施部署归属）⇒ 应在 schema 注释写明「选机路径恒 null」。

**裁决 D-9：列 P2，不阻塞主线。**

### 15.4 ⚠️ 当前主干状态（如实记录）
`npx tsc --noEmit` 当前**红 2 条**，均在 `app-deployment.service.ts`：
```
(3775,50): error TS2304: Cannot find name 'nextMeta'
(3797,25): error TS2304: Cannot find name 'nextMeta'
```
判定：**另一写入方正在编辑该文件的在途半成品**，非本会话改动（我本轮只动
`dispatch-decision-log.schema.ts` 与其 spec、以及门禁 spec 的 F-6/F-9b 判据）。
⇒ **任何人不得在此刻提交 `app-deployment.service.ts`**；提交前必须 `tsc` 绿。

---

## 16. License 总表复核：1 条**证伪**（2026-11-03 09:0x）

> 触发：`dispatch-core` 复核质疑「License 总表」——而这张表是被反复引用的**全局决策前提**
> （「只借鉴思路不复制代码」的安全性立论就在这里）。

**结果：8 个项目 7 准 1 伪。**

| 项 | 报告原判 | 实测 | 判定 |
|---|---|---|---|
| hashicorp/nomad | MPL-2.0 | `raw.githubusercontent.com/hashicorp/nomad/main/LICENSE` = **Business Source License 1.1**（`Licensed Work: Nomad Version 1.7.0 or later` / `Change License: MPL 2.0` / 含 **Additional Use Grant 竞品条款**，Licensor 为 IBM） | ❌ **证伪** |
| 其余 7 项（hatchet / temporal / celery / k8s / airflow / sentinel / resilience4j） | MIT / BSD-3 / Apache-2.0 | 逐字核实一致 | ✅ 证实 |

**主Agent 已独立核验**：亲自 `web_fetch` 该 LICENSE，确认全文为 BSL 1.1（含 IBM 竞品条款段）⇒ **复核正确**。
根因：原报告取到的是 **v1.6.0 旧版**（该版确为 MPL-2.0）；`main` 已是 BSL 1.1。
另：原报告自己记录了「GitHub API 报 `NOASSERTION`」却未深究——**`NOASSERTION` 恰是「非标准/多许可拼接」的红旗，本该追查**。

### 16.1 决策不变，但表述必须改（D-10 采纳）
- **决策不变**：我方全程「**只借鉴思路，不复制代码**」⇒ BSL 与 MPL 在这一用法上**无实质差别**，产出不受影响。
- **表述订正**：
  - License 总表 Nomad 行 → 「≥1.7.0 = BSL 1.1（source-available，含竞品限制）/ ≤1.6.0 = MPL-2.0」；
  - 总表结论 → 从「全部 OSI、零风险」改为「**7/8 为 OSI**；Nomad 当前版本仅可借鉴思路、**不可复制代码**」；
  - 已在 `dispatch-core-oss-research.md`（表行 + §6 标题 + 结论句）、`dispatch-core.md`、本台账三处就地订正，
    `check-doc-style` 全绿。
- **为什么必须改而不只是"记一笔"**：若有人据此判断「MPL-2.0 可安全复制进 AGPL 项目」，**当前版本不可** ——
  这是一条会产生实际法律风险的错误前提。

### 16.2 新增纪律（本轮方法论第四条）
> **License 声明必须钉「URL + 版本/分支」**，不得只写「某个开源项目是 X 许可」。
> 本轮证伪的根因就是「读了旧版本 tag、却按 main 的结论写」。
> 另：**`NOASSERTION` 必须追查**（GitHub API 对非标准/多许可拼接的返回值），不得当作「未知但不重要」。

### 16.3 附带：一处值得肯定的审计写法
`dispatch-core-oss-research.md` §4.2 的 **F-14**（互斥组字段名歧义）在报告内**自我修正了一次**：
先推出「组并发数被突破」→ 再核查 global 档的组行锁（`SELECT ... FOR UPDATE`）**推翻自己** →
最终收敛为准确表述「global 档正确；device 档语义是『单设备内的组并发数』」。
**推演 → 自我推翻 → 收敛**，避免了一个假 P0。这正是审计应有的形态，已作为正面范例记入。

---

## 17. ⚠️ Git 索引竞态事故（2026-11-03 09:07，已如实留档）

### 事故描述
主Agent 执行 `git add <14 个显式路径>` → `git restore --staged`（摘除他人 staged 的 13 个路径）
→ `git commit` 时发现**索引已被清空**。核查 `cf996d78`（并发会话的 `feat(protocol)` 提交）的 stat：
``` 
apps/admin-api/src/config/configuration.ts                 | 23 +-
.../__tests__/app-deployment.rollout-claim.spec.ts         | 335 ++++
.../__tests__/dispatch-decision-log.schema.spec.ts         | 38 +
.../executor/dispatch-decision-log.schema.ts               | 22 +-
.../audits/2026-11-03-round1/00-round1-ledger.md           | 370 +++-
.../audits/2026-11-03-round1/guard-hardening.md            | 589 ++++
.../audits/2026-11-03-round1/verify-reconcile.md           | 466 ++++
```
⇒ **本会话的 14 个路径被并入 `cf996d78`，而该提交信息只描述 protocol 契约工作。**

### 判定与处置
- **内容正确**：我的改动**确实已入库**（内容逐字正确，验证结论仍成立）。
- **提交信息不完整**：`cf996d78` 的 message 未覆盖这 14 个路径 ⇒ 属**审计线索缺失**（不是代码缺陷）。
- **不重写历史**：按本会话自定纪律「**禁止 amend 待验提交**」，且该 commit 含他人产出，
  `git commit --amend` / rebase 会破坏并行会话的工作 ⇒ **不修历史，只留档**。
- 本条记录本身就是补偿：它以「文件 → 实际归属提交」的形式把审计线索补回来。

### 根因与纪律升级（第五条方法论）
1. **`git add` 之后的索引是共享资源**，另一会话的 `git commit`（尤其 `-a` / 带路径 / `-A`）
   会把你的 staged 内容一并带走。**本仓已记录过镜像形态**（自己提交时卷走他人 staged 条目），
   本轮出现的是**反向形态**（他人提交卷走自己的 staged 条目）。
2. **纪律**：跨会话并发写仓库时，**提交必须用 `git commit --only <path...>`**（只提交指定路径，
   不受索引里他人 staged 内容影响），并在提交后 `git show --stat HEAD` **核对 HEAD 是否为自己的提交**。
   仅靠 `git add` + `git commit` 在并发下**不安全**。
3. **提交后必须验证 `HEAD` 的 message 与实际 stat 匹配** —— 本轮正是因为只看了 `git log --oneline`
   才发现异常。

---

## 18. `web-hardening` 交付与两条数字/事实订正（2026-11-03 09:0x）

### 18.1 H-6 已修 + 反向实证
修法：`sse-client.ts` 的 `onVisibilityChange` visible 分支补 `if (!reconnect) { setStatus('reconnecting'); return; }`
——此前该分支**直接 `connect()`**、完全绕开 `scheduleReconnect`，故 `reconnect:false` 在可见性路径上形同虚设。
`reconnect:true`（metrics/executions 流）行为**逐字不变**（有非回归用例钉住）。
**反向实证**：新增 4 例，**把修复回退后 3 例立刻变红**（含消费方路径：换票 +1、EventSource +1），还原即绿。

### 18.2 ⚠️ 事实订正：审计把 H-6 描述成了**不可达**形态
Round 1 审计 §1.7 缺陷 1 的描述是「`gaveUp`（已降级 8s 轮询）后切走再切回 ⇒ 工厂静默重连 ⇒ 双跑」——
**实测证伪**：`gaveUp` 分支先调 `client?.close()`（`ExecutionLogSection.tsx:285`），
而工厂 `close()` 会**摘掉 visibilitychange 监听**（`sse-client.ts:301-303`）
⇒ gaveUp 之后工厂**已不可能**复活流，该双跑路径被这段清理**掩盖、不可达**。

**真实可达的契约破坏**在**重连预算窗口内**（`retryCount < MAX`、客户端未 close、监听还活着）：
此时切走再切回 ⇒ 工厂多换一次票据 + 多建一条 EventSource（占服务端 32 槽之一），
而组件侧状态机**毫不知情**。第 4 例正是打这条。
⇒ **结论：H-6 是真缺陷，但审计描述错了形态。** 这是本轮**第三次**出现「审计描述与真实形态不符」
（前两次：Q5 说过滤链缺维度实为调用侧缺入参；H-2 首版说读后判实为约束维度错配）。

### 18.3 ⚠️ 数字订正：字段漂移不是 173/6，而是 **61 / 7**
`check-web-type-field-drift.mjs` + 基线 `web-type-field-drift-baseline.json` 实测：
生成物 **244 schema** / 手写 **118 处** / **可配对 53 处** / 未配对 56 处 /
**字段漂移 61 处（missing 50 / extra 11）**。
- 台账原写「语义重复 173 处、严格同名 6 处、`Executor` 漂移 6 字段」**均不成立**；
  `Executor→ExecutorResponseDto` 实际漂移 **7 个字段**（多出 `version`）。
- **为什么要额外做「字段重叠 ≥0.6」确认**：否则会把 `LoginResult↔LoginDto`（请求体 vs 响应体，重叠 0）、
  `DeployVersionResult↔DeployVersionDto`（信封 vs 载荷，重叠 50%）这类**假配对**算进来，淹没真漂移。
- 首版按裁决**只做可见性 + 增长闸**（61 处冻入基线，新增即红）。
- **守卫有效性已实证**：真仓删掉 `Executor.executorVersion` 一个字段 ⇒ 守卫 EXIT=1 并点名
  `missing:executorVersion`；还原 ⇒ EXIT=0。17 条 selftest 含正例控制组。

### 18.4 主Agent 裁决
- **D-11（字段级判红是否下一迭代转正）**：✅ **下一迭代转正**，但**前置条件**：
  先把 61 处按语义分组（真缺口 / 请求体-响应体同形 / 信封-载荷 / 可选字段时差），
  真缺口修掉、其余**按组豁免并写明理由**；**不允许**一次性把 61 处全豁免换绿。
- **D-12（B0 测试护栏前提订正）**：采纳「3,750 行零覆盖」不成立（实测该区语句覆盖 **82.96%**），
  真盲区是 `AiProvidersSettings` 58% / `settings/index` 71% ⇒ 按真实盲区建护栏，**不按"零覆盖"堆断言**。

### 18.5 本轮数字可信度小结（三轮被订正的教训）
| 数字 | 初判 | 实测 | 教训 |
|---|---|---|---|
| 手写类型语义重复 | 173 处 | **61 处字段漂移**（口径完全不同） | 口径未定义就先报数 = 不可复现 |
| `Executor` 漂移字段 | 6 | **7** | 少算一个即低估 |
| 首页零覆盖行数 | 3,750 行「零覆盖」 | 语句覆盖 **82.96%** | 「零覆盖」是未测假设，不是测量 |
| `task.service.ts` 行数 | 6,990 | **6,903** | 测量在提交落地前，之后未更新 |
| admin-api 全量 | 「484 套件/8196 例」 | 物理不可能（仅 420~422 spec） | 分片累加被当成单次全量 |

---

## 19. `contract-source` 交付 + **「单一事实源」叙事的根本性限定**（2026-11-03 09:2x）

提交 `0be07473`（15 文件，`--only`，已核对 HEAD）+ `fa55456d`（报告 9 节）。

### 19.1 已完成（有实证）
- **P1-a 码表元数据化**：`failureReason.all` 从 `string[]` → 15 个 `{code,zh,en,remediationKey,owner,reportable}`；
  `adminInternalOnly`/`executorReportable` 降级为**机械投影**。**码值集合与顺序逐字不变 ⇒ 不 bump protocolVersion**
  （三重证明：逐值比对 + 基线 diff 0 + 四方守卫绿）。`check-failure-reasons.mjs` 新增 6 条元数据判据，自检 **18/18**。
- **P1-b 分类器生成化**：`protocol.json` 新增 `failureReason.classifiers`（14 规则 + 受控子集 + 归一 + sentinel + 阶段兜底）；
  生成物落 `contract-fixtures/generated/`；共享向量 33 条；**33/33 向量 node 与 python 双进程真跑逐条相等**。
- **两条守卫**：`check-protocol-breaking.mjs`（三级破坏性判据，零依赖，自检 12/12）、
  `check-failure-classifiers.mjs`（跨语言等价 + 登记完整性 + 结构禁令，自检 9/9）。
  `knownDivergence` **统一登记 21 条**（18 分类器 + 3 能力），判据 = 「差异必须登记 + 登记必须有主 + 棘轮只减不增」。
- 自检合计 **39/39**；生成物 drift 0。

### 19.2 ⚠️ 最重要的发现：**「契约是单一事实源」目前只有 1/8 个段是真的**
孙Agent 查实并经主Agent 独立复核：`protocol.json` 的
`envForward` / `secrets` / `params` / `timeout` / `readiness` / `executorNodeOnly` / `versioning`
**7 个段运行时零消费** —— 只被 spec 读；运行时代码是**手抄**。
**只有 `schemas` 段真被运行时消费**（node 8 处 `safeParse` + python 6 处 `model_validate`）。

主Agent 复核证据（抽样，`grep` 实测）：
- `envForward`：消费点全在 `test_env_forward_parity.py` 与 `env-whitelist.spec.ts`；
  运行时代码（`routers/execute.py:1103-1109`、`env-whitelist.ts`）只有**注释**引用它。
- `timeout` / `secrets` / `params`：消费点在 `executor-protocol-contract.spec.ts` 与
  `dispatch-params-keys.util.spec.ts`；`DISPATCH_PARAM_KEY_PATTERN` 是**手抄常量**再用 spec 比对。

**结论（必须写进对外表述）**：当前形态是「**契约 + 守卫（drift 可检测）**」，**不是**「运行时消费契约（drift 不可能）」。
两者都能防漂移，但强度不同：前者在「代码与 spec 被同一次改动一起改」时**会漏**；后者不会。
⇒ **G3（跨端契约单一事实源）的验收口径据此收紧**：按段声明「运行时消费」或「守卫强制」，
**不得再笼统宣称"单一事实源"**。

### 19.3 另两条重要发现
1. **受控子集自身踩中 `{n,m}` 计数单位差异**：JS 按 UTF-16 code unit、Python 按 code point
   ⇒ `a[^\n]{0,3}b` 对 `a😀😀b` JS 不命中 / Py 命中。已在 normalize 阶段 astral→U+FFFD 修复。
   **这是孙Agent 独立发现、被实现吸收的**（本轮三层委派的直接收益）。
2. **生成物与 admin 现状有 5 处行为差异**（如实报告未偷改）：admin 的 `exitCodeNonZero`（非文本判据）
   与**码化优先通道**生成物未建模 ⇒ 落点时必须补；其余三处等价或已收窄。

### 19.4 主Agent 裁决
| # | 事项 | 裁决 |
|---|---|---|
| **D-13** | 生成物跨包 import：(a) 多产一份到各 app vs (b) 改 tsconfig/packaging | **裁定 (a) + 字节一致 drift 守卫**。理由：**ARCH-20 明确「per-app installs remain independent，no workspace hoisting by design」** ⇒ 跨 app 编译期 import 与该架构前提冲突；(a) 的风险（"多份生成物"）由守卫消除——同一 `protocol.json` 单一来源，多份**派生产物**逐字节一致，正是 protobuf 式标准做法 |
| **D-14** | `.ts` 生成物零消费（死物） | **本轮删除**。仓内有先例（`auth-cookie.util` 作为「死代码假安心」被删）。**不预留投机性出口**——需要时再生成 |
| **D-15** | 三个 python 库降级私有包（原裁决 C） | **延期到下一轮**，登记带 owner 跟踪项（本轮余力投主线，且它与 `check-publishable-wiring` 判据增强同源，宜同轮统一） |
| **D-16** | 7 个段「零运行时消费」 | **必须显式化**：在 `protocol.json` 每段加 `xConsumption` 字段（`runtime` / `guard-only`），
并在 `docs/atlas` 与报告里按段声明。**这是把"假单一事实源"变成"真分级的单一事实源"** |

### 19.5 本轮方法论第六条
> **「契约单一事实源」必须按段声明强度**：`runtime-consumed`（drift 不可能） vs `guard-enforced`（drift 可检测）。
> 把它们混为一谈会产生**虚假的安全感** —— 与"假旋钮""假绿测试"是同一族缺陷：
> **宣称的保证强度 > 实际的保证强度**。

---

## 20. 🔴 重大发现：全仓乐观锁假设**为假**（TypeORM `save()` 不加版本谓词）

> 来源：`e04f2616`（H-2/H-3 攻坚）在真机上实测提出，**主Agent 用 TypeORM 源码级取证确认**。
> 这不是 H-2/H-3 的副产物 —— 它影响 **10 个调用点**，是本仓一条**从未成立过的安全假设**。

### 20.1 断言
`app-deployment.service.ts:558-560` 的注释写：
> 「E-P1-R2：用户动作（stop/upgrade/回滚）read-modify-write save 的乐观锁收口。
> `@VersionColumn` 让 save **自动追加 `AND version = :expected`**；并发后写撞版本时…」

**该假设为假。** `saveWithOptimisticLock()` 包的是 `this.repo.save(deployment)`，
而 TypeORM **1.1.2** 的 `save()` **不会**抛 `OptimisticLockVersionMismatchError`。

### 20.2 主Agent 源码取证（三重）
1. `node_modules/typeorm/persistence/SubjectExecutor.js` —— **零处** `versionColumn`
   用于 WHERE 条件（只有 2 处「特殊列」注释）。
2. `node_modules/typeorm/query-builder/UpdateQueryBuilder.js:436-440` —— 对版本列的
   处理**只有自增**：
   ```js
   if (metadata.versionColumn && updatedColumns.indexOf(metadata.versionColumn) === -1)
       updateColumnAndValues.push(this.escape(versionColumn.databaseName) + " = " + this.escape(versionColumn.databaseName) + " + 1");
   ```
   **没有任何 `WHERE version = ?` 拼接**。
3. `OptimisticLockVersionMismatchError` 的抛出点全仓**只有** `SelectQueryBuilder.js:803/808`，
   且被 `this.expressionMap.lockMode === "optimistic"` 守护 —— 即**只属于 `queryBuilder.lock("optimistic", version)` 这套 API**，
   `repo.save()` 路径**永不进入**。

### 20.3 后果（按严重度）
- `saveWithOptimisticLock()` 的 `catch (OptimisticLockVersionMismatchError)` 是**死分支**
  ⇒ `APP_DEPLOYMENT_CONCURRENT_MODIFICATION`（409）**在生产上永不触发**。
- 并发 `stop` / `upgrade` / `redeploy` 的 read-modify-write 实际是**最后写入者胜（静默覆盖）**，
  不是注释宣称的「后写者 409」。**并发竞态没有被拦截，只是没有被察觉。**
- 仓内 spec 用 **mock repo**，`save` 被替身 ⇒ 无法暴露 ⇒ **典型的假绿**（与本轮已发现的
  另三处假绿同族：H-2 首版 mock 无 DB 约束、失败分类守卫直接调函数、H-6 的 gaveUp 掩盖）。

### 20.4 裁决
| # | 事项 | 裁决 |
|---|---|---|
| **D-17** | `upgrade()` 的 claim 谓词用 `status='running'` 会使 `includeStopped=true` 的 STOPPED 行永久 409 | ✅ **放宽为 `status IN ('running','stopped')`**（CAS 语义不变，保住既有 `includeStopped` 功能；否则是**用新 bug 换旧 bug**） |
| **D-18** | 乐观锁失效 | 🔴 **单独立项，标 P1**。**最短期**：把 `saveWithOptimisticLock` 的虚假注释改为事实（否则每个读代码的人都以为有保护）。**根治**：10 个调用点逐一改为**显式条件 UPDATE**（`WHERE id AND version = :expected` + `version = version + 1`，`affected=0` ⇒ 409）——这与 H-3 已采用的方向一致 |
| **D-19** | `E-P1-R2` 全链核实 | ✅ 纳入下一轮；**不得**因为「已有 409 分支」就认为并发安全 |

### 20.5 主干红修复（主Agent 亲自处理）
`0be07473`（码表元数据化）把 `failureReason.all` 从 `string[]` 改对象数组，
但 **3 个消费点仍按字符串比对** ⇒ 主干 3 红（`executor-protocol-contract.spec.ts` health/task）。
- 判定：**契约改造漏改消费点**，不是契约错。
- 修复：`health` 与 `task` 两个 spec 改为 `.map((r) => r.code)`（并加注释记录成因）。
- 验证：**2 套件 / 18 用例全绿**。
- **教训**：契约形态变更必须**同批扫描全部消费点**；`check-failure-reasons` 已改，但 admin-api 的 3 个 contract spec 漏了。

### 20.6 方法论第七条
> **「防护机制存在」≠「防护机制生效」。**
> 本轮在四类地方撞到同一形态：假旋钮（开关空转）、假绿测试（mock 掉被保护对象）、
> 假单一事实源（7/8 段运行时不消费）、**假乐观锁（异常永不抛）**。
> 共同根因：**守护机制自己没有被验证过**。⇒ 后续凡引入「保护/约束/断言」类机制，
> **必须同时提供一个「构造违反 ⇒ 机制必须报警」的实证用例**。

---

## 21. 契约改造的**跨语言消费点**全部收口（2026-11-03 10:0x）

### 21.1 问题
`0be07473`（码表元数据化 + D-16 `xConsumption`）改了 `protocol.json` 的**形态**，但只同批修了
`check-failure-reasons.mjs`；**三端消费点漏改**，共造成 **6 条红**：
| 侧 | 失败 | 根因 |
|---|---|---|
| admin-api | `executor-protocol-contract.spec.ts`（health / task）**3 红** | `failureReason.all` 由字符串变对象，spec 仍 `sortStr(string[])` |
| python | `test_executor_protocol_contract.py::...self_consistent` **1 红** | 同上，`set(dict)` ⇒ `TypeError: unhashable type: 'dict'` |
| python | `test_protocol_schemas.py` **collect 失败** | `schemaVectors` 里的注解键 `xConsumption`/`xConsumptionNote` 被当成 schema ⇒ `'str' object has no attribute 'get'` |
| node | `protocol-schemas.spec.ts` **2 红** | 同上（只跳过 `$` 前缀，未跳过 `x` 前缀） |

### 21.2 修复（主Agent 亲自执行，跨三端）
1. admin-api 两处：`sortStr(all.map(r => r.code))`。
2. python 契约测试：`{r['code'] for r in PROTOCOL['failureReason']['all']}`。
3. **注解键语义统一**：`schemaVectors` / `schemas` 是「名字 → 载荷」的 **map 形状**段，
   任何注解都会污染命名空间。本仓注解有两种惯例——`$`（JSON Schema）与 `x`（OpenAPI 扩展，D-16 引入）。
   ⇒ 三端消费者统一为 **`$` 与 `x` 双前缀跳过**，并**同时新增反静默断言**：
   除注解外，其余键必须是 dict/object（否则当场红，避免把畸形条目悄悄跳过）。
4. 验证：admin-api **18/18**、python **139/139**、node **116/116** 全绿。

### 21.3 教训（方法论第八条）
> **契约形态变更必须「同批扫描全部消费点」**，而不是只改自己域内的守卫。
> 本次 `0be07473` 只改了 `check-failure-reasons.mjs`，却漏了 admin-api 2 个 spec、
> python 2 个测试文件、node 1 个 spec —— **6 条红全部来自「别人域的消费点」**。
> 落地要求：改 `protocol.json` 形态时，先 `grep` 全仓 `failureReason.all` / `schemaVectors` /
> `protocol.schemas` 的**所有**读取点，逐个确认。

### 21.4 `d17ab4cd` 交付与两处如实说明（采纳）
- **H-4**：`callback-{ms}-{seq}-{uuid12}.json`（48 bit）；兼容期**不需要**（已用可执行用例钉住
  「无任何代码解析文件名序号」）；**多轮加宽是对的**——8 hex=32 bit 按生日界 ~1万文件即 1% 碰撞，
  不够格叫「可忽略」。
- **H-4b**：`lib/file_lock.py`（flock / msvcrt / atomic 三档）；21 处进程内锁独立复核后判定
  **确实只有 3 处需跨进程**（+1 处用消除序号解决），**与我结论完全一致**；
  真 SIGKILL 释放、真两进程同毫秒落盘、真跨进程互斥用例 **51 条 0 skip**，覆盖率 87.64%（基线 86.46%）。
- **⚠️ 它如实报的缺口（重要）**：**node↔python 互斥未闭环**——
  Node 24 core 无 flock API；`O_EXCL` 与 flock **不可互操作**；跨容器 pid 存活检测不可靠。
  且 compose 里 `.git_cache`/`.pkg-cache` 是**不同卷**，仅裸机共享才真共享。
  ⇒ `shared-cache-lock.ts` 目前**只钉命名契约**，`supports_kernel_release()` 如实暴露能力，
  **不假装 node 已在锁**（解释器池靠 uv 自身 `.lock` 兜底）。

### 21.5 裁决
| # | 事项 | 裁决 |
|---|---|---|
| **D-20** | node 侧是否补 flock | **接受现状（①）**：加 native dep 违反「离线零依赖」；`O_EXCL` 与 flock 不可互操作；软锁放弃 SIGKILL 立即释放（本域最需要的能力）。**但要求**：在 `docs/atlas` 与 `check-shared-cache-lock` 注释里**显式写明「node↔python 跨语言互斥未闭环」**，并把「解释器池靠 uv 自身锁」写清——**不允许留成隐性假设** |
| **D-21** | python contract 测试谁修 | ✅ **主Agent 已修**（见 21.2） |
| **D-22** | `xConsumption` 污染 map 段 | ✅ **主Agent 已修**：消费者改为注解感知 + 反静默断言（不是把注解挪走——注解放在段内是 D-16 的设计，应修消费者） |

### 21.6 纪律事故留档（第三次 git 事故）
`d17ab4cd` 报备：它曾 `git commit --amend` **误改了我已提交的 `8778ba25`**，随后
`git reset --soft 8778ba25` 还原并核验。**主Agent 已独立核验 `8778ba25` 完好**
（stat 为我的 3 个文件、`grep uuid12` = 0）。
⇒ 纪律再强化：**`--amend` 在并发仓库里是危险操作**，只能用于「自己刚提交且未经他人读取」的 commit；
任何情况下**不得 amend 他人的 commit**。并发下的安全替代：新提交 + `--only`。

---

## 22. `web-hardening` 域收口 + 三条事实订正（2026-11-03 10:1x）

提交 `d65ef8d3` / `91664a59` / `fd5873de`；报告 `web-hardening.md`。

### 22.1 交付
- **H-6 已修 + 反向实证**：`sse-client.ts` 的 visible 分支原**直接 `connect()`**、绕开 `scheduleReconnect`
  ⇒ `reconnect:false` 在可见性路径上形同虚设。修后 4 例，**回退修复 ⇒ 3 例立刻红**。
- **字段级漂移守卫**：`check-web-type-field-drift.mjs` + 基线；17 条自检；
  **真仓删掉 `Executor.executorVersion` ⇒ EXIT=1 并点名 `missing:executorVersion`**，还原 ⇒ EXIT=0。已接线 npm script + `test:guards:repo` + ci.yml。
- **B0 测试护栏**：新增 **72 例**（5 文件）；`vitest` **280 files / 2305 passed**（基线 2233，**纯增量、零删改零跳过**）；`tsc -b` 0 错。

### 22.2 三条事实订正（均附实证）
1. **「3,750 行零覆盖」证伪**：该区实测 stmt **82.0%** / branch 70.6% / func 78.9%；
   真盲区只有 `AiProvidersSettings`（58%/50%）与 `settings/index`（71%/65%）。基线是 **2233** 而非 2162。
   ⇒ **照原前提会写一堆已覆盖的 happy path**。**这是"派单里的要求 ≠ 执行方真的做了"的镜像：派单里的前提也可能是未测假设。**
2. **H-6 的「双跑」路径不可达**（见 §18.2，与主Agent 复核一致）。
3. **字段漂移 = 7 个字段**（`Executor` 多 `version`）；**必须加「字段重叠 ≥0.6」排除假配对**
   （`LoginResult↔LoginDto` 重叠 0、`DeployVersionResult↔DeployVersionDto` 重叠 50%）
   —— 没有这层会虚报 **169 处**，淹没真漂移。真值：配对 53 / 未配对 56 / **漂移 61（missing 50 / extra 11）**。

### 22.3 附带修掉一个真缺陷（孙Agent 探查暴露）
设置区三处 `form.validateFields()` **裸 await** ⇒ 校验失败变**浮空 rejection**
（`onOk={() => void save()}` 的 `void` 吞掉），而 `dangerouslyIgnoreUnhandledErrors:true` 让它在 CI 上**完全静默**。
已按全仓既有写法（`TaskFormPage:620` + 现成判据 `isFormValidationError`）修掉并加 3 例回归。

**⚠️ 而它的第一版探针也有坑**：观测口写成 `window.addEventListener('unhandledrejection')`，
**回退修复后测试仍全绿**；实测在 jsdom 里 `void save()` 只有 **process** 监听器收得到（window 收 0 条）。
改用 `process.on('unhandledRejection')` 后才真红。
⇒ **本轮第三次「测试通过 ≠ 缺陷不存在」**，且这次是**探针本身没接上**。
**方法论第九条：探针必须被验证过**——"绿"只有两种含义：缺陷不存在，或探针没接上；两者不可从结果区分，必须以「构造违反 ⇒ 变红」排除后者。

### 22.4 裁决
| # | 事项 | 裁决 |
|---|---|---|
| **D-23** | 字段级判红是否下一迭代转正 | ✅ **转正**；**`missing`（50）与 `extra`（11）分开处置**：`missing` = 真缺口，逐条补或按语义分组豁免并写理由；`extra` = 前端合成类型，允许按组豁免。**禁止**一次性全豁免换绿；转正判据是「**新增即红**」而非"总数不涨" |
| **D-24** | `ExecutorDetailPage.tsx:98` 的 `['projects','me','roles']` 前缀冲突 | ✅ **单列 hotfix 立即做**：这是**已在产生错误行为**的缺陷（`ProjectsPage` 失效打不到 roles 查询 ⇒ 角色变更后详情页显示陈旧角色），不依赖任何重构 |
| **D-25** | 字段漂移基线维护责任 | ✅ **不给"人负责"，给"机器负责"**（「需有人定期收紧」不可执行，本仓已反复教训）：① 基线**只能收紧不能增长**，新增即红；② 基线中已消失的条目**必须同步删除**否则红（防基线烂成豁免单）；③ 每条豁免**必带 `reason`**，空理由红；④ `--report` 打印"未处置数量"把欠账变成可读数字 |

### 22.5 又一个正面范例
孙Agent 读完既有 `audit-page.test.tsx`（684 行）+ `audit-keyset-paging.test.tsx`（525 行）后确认
**简报点名的 keyset/去重/边界用例已全部覆盖**，遂**不制造重复覆盖并如实标注**，只把真残余（移动端卡片渲染、
`resourceIdHref` 分支）记入报告。
⇒ 与 `contract-source` 的 `{n,m}` 发现并列，作为**正面范例**：**如实报告"这块已经覆盖了"比凑数更有价值**。

---

## 23. D-24 已修（缓存键前缀冲突）+ D-18 部分交付（2026-11-03 10:2x）

### 23.1 D-24：`['projects','me','roles']` 前缀冲突（主Agent 亲自修复）
**缺陷**：`ExecutorDetailPage.tsx` **内联裸写** `['projects','me','roles']`，不在工厂里；
`ProjectsPage` 的成员增删只失效 `projects.members(id)` + `projects.list`。
TanStack Query 的失效是**纯前缀匹配**，而 `['projects','list']` **不是**
`['projects','me','roles']` 的前缀（第二段就不同）⇒ **成员变更后，非 admin 用户在执行器详情页的
「编辑/配置热更新」入口可见性停在旧快照**，必须整页刷新。**全程无报错**。

**修法（三处 + 一条运行时契约断言）**：
1. `api/queries.ts` 的 `projects` 工厂新增 `myRoles: ['projects','me','roles']`
   ——并写明**不得**恢复 `projects.all` 靠整前缀级联（本仓已因「静默级联刷新 members/candidate-users」刻意移除它），
   正确做法是**显式列出**该失效的键。
2. `ExecutorDetailPage.tsx` 改用 `queryKeys.projects.myRoles`（并引入工厂）。
3. `ProjectsPage.tsx` 的成员失效路径**显式**补 `invalidateQueries({ queryKey: queryKeys.projects.myRoles })`。
4. 新增 `__tests__/projects-my-roles-key-contract.test.tsx`（4 例）：运行时语义
   （注册 myRoles，用 `list` 键失效 ⇒ **不得**命中；用 `myRoles` 键 ⇒ 必须命中）+ 结构断言。
   验证：admin-web 全量 **281 files / 2309 passed**。

**⚠️ 反向实证抓出我自己守卫的洞（值得留档）**：
第一版结构断言直接对原始源码 `toMatch(/queryKeys\.projects\.myRoles/)` ⇒ 把失效行**注释掉**后，
注释里仍有该文本 ⇒ **守卫仍然通过**（4/4 绿）。修正为**剥注释后判定**，再跑反向实证 ⇒ **该例变红**。
⇒ 这与 F-8 的教训**完全同族**（`grep` 到 3 处但全在注释里 ⇒ 误判「代码已接」）。
**方法论第十条：源码文本断言必须先剥注释**——否则「注释写对了、代码没接」会一路绿灯。

### 23.2 D-18：乐观锁（`f8b30f83`）—— **部分交付，不算修完**
**独立复现（复核者自己跑，未采信我的转述）**：四条全中，并**补了第四条更有力的**——
全 `src/**/*.ts`（剥注释、跳过 `__tests__`）扫描 ⇒ **仓内无 `setLock("optimistic")`**，
唯一锁用法是 `users.service.ts` 的 `pessimistic_write`。
⇒ 「409 永不触发」从「很可能」推到「**结构上确定**」（连进入该分支的入口都不存在）。

**假绿实证（8 例）**：4 条结构证据（必然性）+ 2 条**语义复刻**
（按 `SubjectExecutor` 真实语义实现 fake repo：覆盖写 + 版本自增、**无** version 谓词
⇒ 断言过期快照写入**不抛异常 ∧ 列被静默覆盖** —— 既有 `jest.fn()` 替身让覆盖/不覆盖都无从观察）
+ 2 条转正判据（修复前红、修复后绿）。

**顺手删掉两条「证明假路径」的测试**：原 E-P1-R2 用例 mock `repo.save` 抛版本冲突来「证明」乐观锁生效，
并断言 `expect(repo.save).toHaveBeenCalled()` —— **断言的是实现细节，不是「并发被挡住」这个性质**。
这正是它能一路绿到生产的原因。已改写为驱动真实 CAS（`affected=0 ⇒ 409`，且 `save` 不得被调用）。

| 调用点 | 状态 |
|---|---|
| `stop()`（:2249） | ✅ 已改显式条件 UPDATE（`WHERE id AND version=:expected` + `SET version=version+1`，`affected=0 ⇒ 409`），只写本次改变的列 |
| `upgrade()` | ⬜ 不碰（H-3 已改为行级占坑） |
| `pushDeployToExecutor` / `upgradeWithSnapshot` / `deploy()` 复用 | ⬜ **未改 3 处** |

**未改理由不是省事**：`pushDeployToExecutor` 是 `upgrade()` 的**下游**，占坑已 `version+1`，
此处再取版本期望值若取错会**把正常升级打成 409**；`upgradeWithSnapshot` 由其自动触发、异常被 catch 吞成日志，改错难察觉。
**⇒ D-18 在剩余 3 个调用点改完前不算修完。**

**如实短板**：**无真库行为证据**（`DB_HOST=postgres` 不可解析、本地 PG 无 `autoflow` 角色）。
结构证据 + 语义复刻成立，但都不是「真跑一次并发写」；报告 §1.3 给了补证判据（两连接各持不同版本快照，
断言两边都成功且 version 只 +1）。**不接受「8 例全绿」被读成「已在真库证实」。**

**行为变更（需知会前端，已核实文案可读）**：`stop()` 并发时现在**真的返回 409**，
该码此前从未在生产触发。已核实 i18n 存在且可读：
`err.APP_DEPLOYMENT_CONCURRENT_MODIFICATION` = 「部署 {{deploymentId}} 已被并发修改；请重新加载后重试」（zh/en 均有）。

### 23.3 D-24 补充（`web-hardening` 提出，主Agent 核实并收编）
我 23.1 的修复只覆盖了**成员抽屉**路径（`invalidate()`），漏了一条：
**删除项目**同样会让 `myRoles` 陈旧 —— `project_members` 的外键是 `ON DELETE CASCADE`
（`apps/admin-api/src/migrations/1790000000015-CreateProjectMembers.ts:32` 实测确认），
项目一删成员行随之清理 ⇒ `GET /projects/me/roles` 结果变化；
而删除走的是 `invalidateList()`（与新建/编辑**共用**，调用点 `:419` / `:448`）。

**收编理由**：这是**对我修复的真实补强**，不是风格差异。若只失效成员抽屉路径，
「删除项目 → 执行器详情页仍显示该项目下的编辑入口」（保守方向：多显示入口 ⇒ 点了才 403）。
已在 `invalidateList()` 补 `myRoles` 失效 + 新增 1 例断言（从**去注释后**的源码定位 `invalidateList` 函数体），
并写清「本函数被三条路径共用，统一失效最省心且不会漏（myRoles staleTime 60s，代价可忽略）」。

验证：admin-web 全量 **281 files / 2310 passed**（较修复前 +5），`tsc -b` 0 错。

---

## 24. 阶段性收口验证快照（2026-11-03 10:5x，主Agent 亲自复跑）

### 24.1 三端全量回归
| 端 | 结果 | 相对起点 |
|---|---|---|
| **admin-api** | **427 套件 / 7,515 用例全绿** | 起点 417/7,328 ⇒ **+10 套件 / +187 用例** |
| **admin-web** | **281 files / 2,310 用例全绿** | 起点 2162（后实测 2233）⇒ +77 |
| **executor-python** | **1,620 passed**（覆盖率 87.64%，门 86%） | 起点 86.46% ⇒ **未回退反升** |
| `tsc --noEmit`（admin-api）/ `tsc -b`（admin-web） | **0 错** | — |

### 24.2 守卫全绿（14 条关键守卫逐个实跑）
`check-failure-reasons` / `check-failure-classifiers` / `check-protocol-breaking` /
`check-conditional-writes` / `check-migrations` / `check-migration-symmetry` /
`check-index-drift` / `check-guards-wired` / `check-enum-drift` /
`check-web-type-drift` / `check-web-type-field-drift` / `check-shared-cache-lock` /
`check-cron-leader-gate` / `check-env-drift` —— **14/14 OK**。

### 24.3 `web-hardening` D-25 收口（`6a676a07`）
三条棘轮判据**逐条真仓反向实证**：
| 判据 | 实证 |
|---|---|
| 只能收紧不能增长 | 基线塞不存在的条目 ⇒ `基线陈旧 1 处` ⇒ **EXIT=1**；真删手写 `Executor.executorVersion` ⇒ `新增字段漂移 … missing:executorVersion` ⇒ **EXIT=1** |
| `reason` 必填 | 首条 reason 清空 ⇒ `基线豁免缺理由 1 处 … reason 为空` ⇒ **EXIT=1**；旧格式字符串条目亦红 |
| `--report` 打印欠账 | `missing（真缺口）：50 处` / `extra（合成类型）：11 处` / `未配对：56 处` |

三次均还原（`git diff` 确认源码零残留）。基线 117 条（61 漂移 + 56 未配对）**每条带 reason**
（标注「待处置」+ 属哪类欠账 + 处置方向）；处置一条删一条 ⇒ **基线归零那天即可从「增长闸」切到「有漂移即红」**，这是 D-23 的落地路径。
自检 17 → **24 条**，含**正例控制组**（同一条豁免补上 reason ⇒ 绿）——若「空理由即红」是守卫恒红所致，正例组会红，故证明判据按内容判。

**覆盖率订正落实**（按 D-23 要求）：`AiProvidersSettings` 58/63/50 → **100/100/100**；
`settings/index` 71/66/65 → **92/80/94**；`EventSubscriptionsSettings`/`ApiKeysSettings`/`SecuritySettings`
（89~92%）**一个字节未动**；`audit/index.tsx`（88%）**刻意不动** —— 即「按真实盲区建护栏，不是按零覆盖堆断言」。

### 24.4 方法论第十一条（来自 `web-hardening`，主Agent 采纳）
> **凡是「A 改动影响 B」的失效关系，去查那条关系在数据层是怎么实现的，比盯着 UI 路径可靠。**
>
> 本轮实例：D-24 的原修复（含主Agent 的第一版）都只盯着「成员变更」这个**直觉路径**；
> 而「删除项目 ⇒ 成员行消失」的真相在 **`ON DELETE CASCADE`**（外键定义处）——
> 顺着 FK 查才发现漏了删除路径。**UI 路径是表象，数据层因果才是全集。**

### 24.5 工作区状态
仅剩 `apps/admin-api/src/common/leader-gate/*` 与 `apps/admin-api/src/modules/scheduler/*` 的改动——
**属并行会话的在途工作，非本会话产出，未触碰、未提交**。

---

## 25. D-1 已修：pinned 满载时分因丢失（2026-11-03 11:1x）

### 25.1 缺陷（R1 审计 F-13，主Agent 复核确认）
`dispatch()` 的 pinned 分支把 `candidates` 收窄为 `[pinned]`（`const`，作用域在 `if (task.executorId)` 内），
而**占坑全落空的统一出口在 if 之外** ⇒ 那里拿不到 `pinned` ⇒ 只能抛
`NO_DISPATCHABLE_EXECUTOR`，文案是「所有候选执行器都已离线或达到容量上限」。

**为什么是缺陷**：pinning 的候选池**只有 1 台** ⇒ 该文案让用户误判**整个机队**不可用，
而实情是「我钉的那台满了」。更严重的是**三种 pinned 失败的对外表达不一致**：
不存在 → `PINNED_EXECUTOR_NOT_FOUND`；离线 → `PINNED_EXECUTOR_OFFLINE`；
满载 → **通用码**（唯一一个没有专属身份的）。

### 25.2 修法
1. 新增错误码 `PINNED_EXECUTOR_AT_CAPACITY`（status 500，zh/en 双语文案含
   `{{appName}}` / `{{executorId}}` / `{{running}}/{{max}}`，并明写「pinning 不会回退到其他执行器」）。
2. `dispatch()` 新增 `let pinnedTarget: Executor | null`（**仅为失败路径**保留目标，不参与正常派发逻辑），
   在 `candidates = [pinned]` 处捕获；落空出口优先抛专属码。
3. **刻意不映射 `failureReason`**：现有枚举无「容量已满」这一档，硬塞 `executor_offline` 是**说谎**（它在线）。
   沿 `PINNED_EXECUTOR_NOT_FOUND` 的先例留 UNKNOWN。**行为不变**（仍抛错 → BullMQ 重试），
   本改动只订正**对外表达**。
4. 再生成 error i18n（428 码）。

### 25.3 反向实证 + 一条「测试锁定 bug」的处置
- **反向实证**：把 `if (pinnedTarget)` 分支临时改成 `if (false && pinnedTarget)` ⇒
  新增用例立刻红（`1 failed / 9 passed`）⇒ 恢复即绿。**证明守卫非装饰。**
- **既有测试断言被更新（重要）**：`executor.service.spec.ts` 原有的
  `"respects the pinned executor slot cap"` 断言的是**通用文案** `/没有可用的执行器/` ——
  那是**把缺陷行为写成了期望**（本仓 `AGENT-SWARM-PLAYBOOK.md` §1 明确记录过「测试锁定 bug」这一反模式）。
  **用例意图不变**（尊重槽位上限 + 不发起派发 HTTP），只把失败身份改为专属码，
  并**追加一条反向护栏**：断言**不得**再退化成 `/所有候选执行器/`。

### 25.4 验证（主Agent 亲自复跑）
- admin-api 全量 **427 套件 / 7,516 用例全绿**（D-1 前 7,515，+1）
- `tsc --noEmit` 0 错
- 守卫：`check-error-i18n` / `check-error-migration` / `check-failure-reasons` /
  `check-enum-drift` / `check-guards-wired` / `check-conditional-writes` **全绿**；
  `gen-api-reference-appendix.mjs --check` → 「219 个路径全部覆盖，附录与 openapi 逐字节一致」
  （该判据只覆盖端点、不覆盖错误码，故无需再生成）
