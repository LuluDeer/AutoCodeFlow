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

**协议合规结论**：本轮全部参考为 MIT / BSD-3-Clause / Apache-2.0 / MPL-2.0，**无 GPL/AGPL**。
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

## 8. 下一步行动（Round 1 收口 → Round 2 攻坚）

1. 收齐 2 份独立复核报告（`bbdb4f95` dispatch-core / `eff5335a` python-executor）。
2. 主Agent 终审：逐条对照本台账，产出**放行 / 修改 / 暂缓**三态决议。
3. **Round 2a（hotfix 先行）**：H-1 ~ H-6 六项，独立可交付、互不耦合，可并行；H-7 随 H-2 一起改文档。
4. **Round 2b（结构性重构）**：写域隔离并行 ——
   - dispatch-core：`dispatch()` 纯决策器抽取 + 过滤链收敛 + 模块 forwardRef 解环（依赖 D-14 契约先行）
   - python-executor：`execute.py` 分阶段拆分 + `preflight()` 校验门
   - contract-crosscut：码表元数据化 + 分类器生成化（**依赖前两者的收敛结果**，排最后）
   - deploy-multiinstance：DB 唯一占坑 + 灰度状态机拆分
   - admin-web：B0 补测试 → tasks 域试点 `features/` 分层
5. 每域验收：定向 spec + 全量回归（admin-api 基线 **417 套件 / 7,328 用例全绿**，**必须用 `npm test` 或显式 `--experimental-vm-modules`**）+ `tsc --noEmit` + 相关守卫脚本。
6. 复盘：更新本台账、待优化清单、已参考开源仓库清单、CodeGraph 探查记录清单。
