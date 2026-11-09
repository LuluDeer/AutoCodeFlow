# dispatch-core 域审计报告（Round 1 · 只读审计）

- **域**：dispatch-core（任务 → 派发 → 占坑 → 回调 → 终态主链）
- **主战场**：`apps/admin-api`（`apps/admin-api/src/modules/executor|scheduler|task`）
- **审计轮次**：2026-11-03 Round 1（**只读审计阶段**：未修改任何源码；本文件是本轮唯一写操作）
- **仓库 HEAD**：`9fc3270c`（2026-11-03 01:16:23 +0800）
- **CodeGraph**：v1.6.2，索引 2108 文件 / 42151 节点 / 120271 边；开工前 `codegraph status` 显示 1 个 pending（`package.json`，与本域无关）。**本轮探查全部经 CodeGraph CLI 完成，未降级到 grep-first**（少数全文检索场景如中文文案枚举，属 CodeGraph 不覆盖的非代码符号检索，已在文中注明）。
- ⚠️ **过程偏差声明（必读）**：任务书要求「必须派孙Agent（Firefox开源调研专项）」。**本会话的 delegation depth 上限为 1**，`subagent` / `subagent_fork` 均返回 `subagent depth 2 exceeds maxDepth 1`（已实测两次，含在派发孙Agent时的显式调用）。因此**开源调研由本 Agent 直接执行**，深读了本机开源副本 `hatchet-main` / `temporal-main` 的真实源码并联网核验了 License。**该偏差不影响报告结论的可执行性，但影响「独立第二视角」——主 Agent 应据此对 §4 的取舍做一次自审。**

---

## §1 现状问题分析

### F-01 【God Method】`dispatch()` 单方法串联 8 类决策 + 派发 + 占坑 + 传输 + 回滚

- **位置**：`apps/admin-api/src/modules/executor/executor.service.ts:5146-5758`（**613 行**）
- **触发路径**：`task.processor.ts:165 handle()` → `executorService.dispatch(task, execution)` → 选执行器 → 占坑 → push/pull 传输
- **量化**（脚本统计该行段）：`if` × **37**、`for` × 1、`await` × **14**、`throw` × **9**、调用 `this.*` **15 个不同方法**
- **为什么是问题**：
  1. **37 个分支在一个方法里，任何一次改动都要人肉证明 37 条路径不受影响**。仓库已因「良性并发被误判成失败」把 version CAS 谓词从占坑 UPDATE 里摘掉（`:5496-5511` 注释自述「QA-05 本机实测：100 并发下成功率被此冲突主导」），这类改动在 613 行方法里做是**高危**的。
  2. **决策与副作用混排**：`dispatch()` 里既有纯内存过滤（`:5245-5352`），又有 DB 写（`:5520-5533` 占坑、`:5730-5749` 回滚），还有 HTTP 出站（`:5710` axios.post）。**纯决策部分无法单测**——现有测试只能靠 `executorRepo.findOne.mockResolvedValue` + `mockedAxios.post` 这种「全链路 mock」来断言，等于把 37 个分支耦合进一个测试夹具。
  3. **决策日志依赖执行顺序**：`scoredSnapshot`（`:5368-5377`）必须在 `candidate.runningTaskCount += 1`（`:5526`）**之前**截取，否则评分被自己的占坑污染——这类「顺序敏感但无编译期保障」的约束散落在方法体里，改动极易破坏。
- **证据**：`codegraph impact ExecutorService::dispatch -d 3` → **29 个受影响符号**（含 `task.processor.ts handle/process`、`executor.service.spec.ts` 的两个 `dispatchTask` 工厂、`executor.interpreters.spec.ts`、`executor.dispatch-estimated.spec.ts`、`executor.service.security.spec.ts` 的 `dispatchAndCaptureBody`、`dispatch-secrets-injection.spec.ts`、`execution-attempt-seq*.spec.ts`、`task.processor.spec.ts`、`executor-desktop/src/main/ipc-handlers.ts`）。
- **对照组（复杂度参照系）**：`dispatchBroadcast()`（`:6142-6394`，253 行）if × 22；`task.service.ts::handleCallback`（`:5886-6541`，656 行）if × 30。**`dispatch()` 是 admin-api 内 if 密度最高的单个方法之一。**

### F-02 【职责混杂】`ExecutorService` 8488 行 / 184 符号，横跨 9 个互不相关的职责域

- **位置**：`apps/admin-api/src/modules/executor/executor.service.ts:552-8488`（class `ExecutorService`）
- **证据**（CodeGraph 符号表按行段切片）：

| # | 职责域 | 行段 | 代表符号（符号数） |
|---|---|---|---|
| G1 | **令牌/缓存** | `:577-674`、`:857-940`、`:7078-7983` | `tokenValidationCache` / `issuedTokenCache` / `packageUrlCache` / `issueToken` / `rotateToken` / `validateExecutorToken` / `authenticateMachineRequest` / `getCallbackSecretById`（**16 方法**） |
| G2 | **心跳注册** | `:2207-3284`、`:3337-4051`、`:4079-4255` | `register` / `registerExecutor` / `heartbeat` / `applyReportedAppVersions` / `sanitizeRunningExecutionIds` / `pickOwnedColumns` / `getAppVersionFacts`（**7 方法**） |
| G3 | **地址与指纹冲突** | `:958-1210`、`:7352-7418` | `observeAddressConflict` / `observeDeviceFingerprint` / `fingerprintConflictTitle` / `describeFingerprintConflict` / `canTakeOverAbandonedAddressRow`（**5 方法**） |
| G4 | **派发决策** | `:4607-5035`、`:5059-5758`、`:5806-6394` | `selectLeastLoaded` / `findFleetCandidates` / `dispatch` / `dispatchBroadcast` / `claimExecutorSlotForExecution` / `estimatedDurationsByExecutor` / `logExecutionDispatchDecision` / `applyInterpreterFilter` / `resolveDeploymentConstraintContext` / `resolveVersionFollowPackage`（**11 方法**） |
| G5 | **占坑/释放/重试** | `:1528-2023`、`:4918-5035` | `releaseExecutorSlot` / `failRunningExecutionsAfterRestart` / `scheduleRetryAfterRecovery` / `hasRetryBudget` / `notifyExecutorKill` / `claimExecutorSlotForExecution`（**6 方法**） |
| G6 | **版本与应用** | `:4177-4255`、`:6032-6130`、`:5806-5886` | `getAppVersionFacts` / `resolveVersionFollowPackage` / `resolveDispatchTask`（**3 方法**） |
| G7 | **指标** | `:8209-8487` | `getTerminalStates` / `getExecutorMetrics` / `getExecutorMetricsHistory`（**3 方法**） |
| G8 | **回调/命令投递** | `:1223-1244`、`:2067-2205` | `publishControlCommandFailure` / `resolveExecutorTransport` / `enqueueExecutorCommand` / `deliverControlCommand`（**4 方法**） |
| G9 | **审计/事件总线/清理** | `:915-940`、`:1340-1404`、`:6407-6943` | `auditHighRisk` / `emitExecutorOffline` / `emitExecutorOnline` / `emitExecutorAddressDrifted` / `cleanupOldRecords` / `markStaleOffline` / `cleanupOfflineExecutors`（**7 方法**） |

- **为什么是问题**：`ExecutorService` 被 **69 个文件**引用，`codegraph impact ExecutorService -d 3` 覆盖 **150 符号**。**任何对它的结构性改动都是全域级改动**，且无法用「小步快跑」稀释风险。

### F-03 【构造器腐化】16 个位置参数 + 8 个 `@Optional()` 依赖，「必须是最后一个位置参数」的历史包袱

- **位置**：`executor.service.ts:712-842`
- **精确参数清单**（CodeGraph + 源码核对，**21 个位置参数**，非 16）：

| # | 参数 | 形态 | # | 参数 | 形态 |
|---|---|---|---|---|---|
| 1 | `repo` (Executor) | 必需 | 12 | `audit` | **@Optional** |
| 2 | `execRepo` (TaskExecution) | 必需 | 13 | `leaderGate` | **@Optional** |
| 3 | `taskRepo` (Task) | 必需 | 14 | `pullService` | **@Optional** |
| 4 | `metricsHistoryRepo` | 必需 | 15 | `applicationRepo` | **@Optional** |
| 5 | `taskQueue` | 必需 | 16 | `appDeploymentRepo` | **@Optional** |
| 6 | `configService` | 必需 | 17 | `tokenCacheSync` | **@Optional** |
| 7 | `notificationService` | 必需 | 18 | `mutexGroupRepo` | **@Optional** |
| 8 | `systemConfigService` | 必需 | 19 | `applicationVersionRepo` | **@Optional** |
| 9 | `secretsCrypto` | **@Inject(forwardRef)** | 20 | `executorAppVersionRepo` | **@Optional** |
| 10 | `eventBus` | **@Optional** | 21 | `dataSource` | 必需（无默认值，末位） |
| 11 | `tracing` | **@Optional** | | | |

- **为什么是问题**：
  1. 源码注释自述：「**必须是最后一个位置参数**：既有 spec 以 14 个位置参数 `new ExecutorService(...)` 直接装配，追加带默认值的尾参不破坏它们」（`:755-757`、`:763-764`、`:770-771`、`:783-784`、`:792-793`）——**同一段注释重复 5 次**，本身就是「这条纪律很难守住」的证据。
  2. **21 个位置参数意味着新增依赖必须追加在末位**，而 `dataSource`（`:799`）已经是无默认值的末位参数——**下一个新增依赖必须插到 `dataSource` 之前**，破坏「尾插」约定。这是一个已经埋好的地雷。
  3. **实测 spec 装配点**：`new ExecutorService(` 全仓 **11 处**，其中 5 处直接 `new ExecutorService(...)` 位置装配（`executor.heartbeat-task-sandbox.spec.ts:122`、`executor-stale-snapshot-write.spec.ts:126`、`executor.register-takeover-cas.spec.ts:259`、`executor.heartbeat-conflict-selfreport.spec.ts:180`、`dispatch-params-keys.util.spec.ts:130 & :252`），`executor.service.spec.ts:6840` 的 `buildService` 以 **21 个 `{} as never` 占位**逐位置装配——**任何构造器重排都会静默错位**（`{} as never` 通过类型检查，但注入的是错的依赖，测试可能仍然绿）。
  4. 另有 **53 处 `provide: ExecutorService` 的 DI 覆盖**（`useValue` 内联对象字面量），改方法签名会连带 53 个 spec。
- **证据**：`grep -c "@Optional()" executor.service.ts` → 11（全文件）；构造器段 `:712-842` 内 `@Optional()` → **8**（`eventBus`/`tracing`/`audit`/`leaderGate`/`pullService`/`applicationRepo`/`appDeploymentRepo`/`tokenCacheSync`/`mutexGroupRepo`/`applicationVersionRepo`/`executorAppVersionRepo` 共 11 个，见上表）。

### F-04 【模块环】`task` ↔ `executor` 模块级 `forwardRef` 环，且环上有 provider 注入

- **位置**：
  - `apps/admin-api/src/modules/executor/executor.module.ts:78`（`forwardRef(() => TaskModule)`）
  - `apps/admin-api/src/modules/task/task.module.ts:61`（`forwardRef(() => ExecutorModule)`）
  - `apps/admin-api/src/modules/task/task.processor.ts:103`（`@Inject(forwardRef(() => ExecutorService)) executorService`）
  - `apps/admin-api/src/modules/executor/executor.service.ts:728`（`@Inject(forwardRef(() => SecretsCryptoService)) secretsCrypto`）
- **触发路径**：`TaskProcessor.handle` → `ExecutorService.dispatch` → `buildDispatchParams` → `secretsCrypto.decryptForDispatch`
- **为什么是问题**：源码注释自述「e2e bootstrap 实证 require 顺序敏感（task 先加载时本模块 imports 元数据拿到 undefined）」（executor.module.ts:74-77）。**模块环的成因是 `SecretsCryptoService` 这个「无状态工具」被放在 TaskModule 里**——而 executor 只需要它的 `decryptForDispatch`。这是典型的**依赖方向反了**：一个纯加解密工具类被业务模块「拥有」，导致两个业务模块互相依赖。
- **证据**：`codegraph impact` 无法直接量化模块环，故用「provider 依赖」量化——`ExecutorService` 的 21 个构造依赖中，**只有 1 个**（`secretsCrypto`）来自 task 模块；其余 20 个来自 executor 自己的 TypeOrmModule / 全局模块 / 自身模块。

### F-05 【跨文件文案耦合】pinned 离线文案与失败分类正则必须逐字对齐，任一侧漂移即误报 `script_error`

- **位置**：
  - 文案产出：`apps/admin-api/src/common/errors/catalog/executor.ts:211-214`（`PINNED_EXECUTOR_OFFLINE.zh = '指定的固定执行器 "{{appName}}" ({{executorId}}) 已离线'`）→ `executor.service.ts:5194` 抛出
  - 分类判据：`apps/admin-api/src/modules/task/task.service.ts:664-665`（`EXECUTOR_OFFLINE_PATTERN`）
  - 派发路径判据：`apps/admin-api/src/modules/task/task.processor.ts:455`（复用同一常量，**已修**）
  - 回调路径判据：`task.service.ts:1101`（复用同一常量，**已修**）
- **为什么是问题**：`EXECUTOR_OFFLINE_PATTERN` 的中文支是 `执行器[^\n]{0,120}?(?:离线|不可用|不可达)`——**容差 120 是按中台自己产出的 pinned 文案实测的**（「执行器→离线」间隔实测 **63 字符** = 44 + appName 19；executorId 是 36 位 uuid）。源码注释自述这是 **LANG-ERR-01 复查的教训**：中文支原为容差 20，短于自家文案 → pinned 离线被归成 `SCRIPT_ERROR` → ①用户看到「脚本错误」而非「执行器离线」；②`SCRIPT_ERROR` **在默认重试集里**，白白消耗重试预算。
- **当前状态（好消息）**：`INTERPRETER_UNAVAILABLE_PATTERN` 与 `EXECUTOR_OFFLINE_PATTERN` 已从 `task.service.ts` 私有常量**导出**，`task.processor.ts:34-35` import 复用——**这两条已收敛**。
- **但仍存在的漂移点（未收敛）**：
  1. **`task.processor.ts` 的其余 3 条分类正则仍是内联抄写**，与 `task.service.ts` 的对应规则**逐字不同**：

     | 规则 | `task.service.ts`（回调路径） | `task.processor.ts`（派发路径） | 差异 |
     |---|---|---|---|
     | TIMEOUT | `:1097` `/timeout\|timed out\|etimedout\|execution timed\|超时\|执行已超时/` | `:441` 同 | **一致** |
     | PACKAGE_FETCH | `:1105` 含 `module not found\|cannot find module` | `:457` **缺这两项** | **不一致**（派发路径漏判） |
     | SCRIPT_ERROR | `:1115` 同 | `:461` 同 | 一致 |

     → `task.processor.ts:457` 的 PACKAGE_FETCH 规则**少了 `module not found|cannot find module`**，导致「执行器侧报 Node 模块找不到」在**派发失败路径**落 `UNKNOWN`（可重试，烧预算），在**回调路径**落 `PACKAGE_FETCH_FAILED`（不可重试）。**同一失败因两条路径归因不同 —— 这正是 F-05 的未收敛形态。**
  2. **`task.processor.ts` 独有 2 条规则**（`APPLICATION_MISSING` `:435`、`SANDBOX_UNAVAILABLE` `:83`）在 `task.service.ts` 侧**没有对等物**（`SANDBOX_UNAVAILABLE_PATTERN` 未被 service 引用）→ 沙箱失败在回调路径落 `UNKNOWN`。
  3. **执行器侧有第三、第四份抄写**：`apps/executor-node/src/routes/execute.ts:867`（`prepareFailureReason`）、`apps/executor-python/routers/execute.py:609-617`（`_refine_failure_reason`）——两端各有一份**与 admin 无关但语义重叠**的解释器/超时判据。

### F-06 【文案 × 分类 正则】中英容差不一致（英文无界 `.*`，中文有界 `[^\n]{0,120}`）

- **位置**：`task.service.ts:664-665`
- **证据**：正则 `/executor.*(offline|unavailable)|.../` 的英文支用**无界 `.*`**，中文支用 `[^\n]{0,120}`。源码注释承认「中英容差不一致本身就是隐患」，但**至今未统一**。
- **为什么是问题**：中文支的 `120` 是**对当前 pinned 文案长度的实测值**，不是语义值。一旦 `PINNED_EXECUTOR_OFFLINE` 的 zh 模板改长（如加「连接」二字）或 appName 允许更长（当前 appName 列宽未在注释中固定），**容差就不足 → 再次误报 script_error**。这是**用一个魔数去锚定一条会演进的文案**。

### F-07 【同族重复】派发过滤链在 `dispatch` / `dispatchBroadcast` / `selectLeastLoaded` 三处各抄一份

- **位置**：
  - `executor.service.ts:5266-5352`（`dispatch` 的 group/tags/affinity/anti-affinity/runtime/interpreter 链）
  - `executor.service.ts:6184-6244`（`dispatchBroadcast` 的**同款链**，注释自述「Apply same filters as dispatch」）
  - `executor.service.ts:4632-4668`（`selectLeastLoaded` 的**同款链**的子集：group/tags/runtime/interpreter，**无 affinity/anti-affinity**）
- **量化**：三处合计 **~140 行** 近乎逐字重复的 `.filter()` 链。
- **为什么是问题（不只是 DRY）**：
  1. **`selectLeastLoaded` 缺 affinity/anti-affinity** → 应用部署选执行器（`app-deployment.service.ts:1333` 调用）**不支持亲和性约束**，与单播派发**语义不一致**。这是**行为分叉**，不是风格问题。
  2. `dispatchBroadcast` 的 affinity 语义被**显式裁决**为「收窄扇出面」（`:6195-6203` 注释），与 `dispatch` 的「软偏好」**语义不同**——所以**不能简单合并成一个函数**，必须参数化。
  3. 派发过滤链的**顺序**是有语义的（`:5324-5327` 明写「过滤顺序：group → tags → affinity/anti-affinity → runtime → interpreter → loadScore」），三处手工同步顺序 = 三处漂移风险。

### F-08 【契约面分散】`packages/executor-protocol` 覆盖 params/secrets 键名与 env 转发，但**不覆盖派发决策语义**

- **位置**：`packages/executor-protocol/protocol.json`（顶层段：`versioning` / `readiness` / `timeout` / `failureReason` / `secrets` / `params` / `envForward` / `schemas` / `schemaVectors` / `deviceIdentity`）
- **已覆盖**（三端 spec 加载同一份文件断言）：
  - `params.keyPattern = "^[A-Za-z0-9_]{1,64}$"` → admin `dispatch-params-keys.util.ts:36` 的 `DISPATCH_PARAM_KEY_PATTERN` **逐字符对账**（`dispatch-params-keys.util.spec.ts:53` `expect(DISPATCH_PARAM_KEY_PATTERN).toBe(protocol.params.keyPattern)`）✅
  - `params.keyUniqueness`（折叠冲突 400）→ node `param-env.ts` / python `execute.py` 各一份实现，admin 侧 `findDispatchParamKeyCollisions`（`dispatch-params-keys.util.ts:90`）第三份 ✅
  - `secrets.keyPattern` / `envForward`（两端白名单必须一致）✅
- **未覆盖**（**本域缺口**）：
  1. **`failureReason` 段只登记了「枚举全集 + 可上报子集」，没有登记「失败文案 → reason 的分类判据」**。admin 侧 6 条正则、node 侧 1 份、python 侧 1 份，**共 8 份分类判据**，没有单一事实源。
  2. **没有 `dispatch` 决策段的契约**（候选过滤维度与顺序、评分公式、占坑不变量、失败出口分类）。
  3. `packages/contract-fixtures` 管的是 **HTTP 响应信封拆包**（`{code,message,data}`）——**与本域无关**，不可混用。

### F-09 【契约面重复】node / python 两端的 params 键名闸与折叠冲突判定是**各自抄写**，只有向量对账没有代码共用

- **位置**：
  - node：`apps/executor-node/src/param-env.ts:141`（`isInjectableParamEnvKey`）、`findParamEnvKeyCollisions`
  - python：`apps/executor-python/routers/execute.py:1920`（`_is_injectable_param_key`）、`:1966`（`_param_env_key_collisions`）
  - admin：`apps/admin-api/src/modules/executor/dispatch-params-keys.util.ts:41`（`isInjectableParamKey`）、`:90`（`findDispatchParamKeyCollisions`）
- **已知分叉（源码自述）**：python 用 `fullmatch` 而 node 用 JS `$`——python 注释自述「Python 的 `$` 会在**末尾换行之前**匹配，`"LIMIT\n"` 因此能通过 `^[A-Za-z0-9_]{1,64}$`；而 node 的 JS `$` 不会……统一按更严格的 fullmatch 判」（`execute.py:1920-1930`）。**这说明两侧已发生过一次真实分叉**（EXEC-07 残差 3）。
- **为什么是问题**：`protocol.json` 的向量保证「**当前**行为一致」，但保证不了「**下一次改动**一致」——三份实现各自演进时，只有向量覆盖到的 case 会被抓到。

### F-10 【决策不可观测】决策日志是「拼装在方法里的 JSON 字面量」，无 schema、无落库、无查询面

- **位置**：`executor.service.ts:4805-4891`（`logExecutionDispatchDecision`），`:5563-5581`（调用点）
- **证据**：输出形如 `{"event":"dispatch.decision", task, executionId, poolSize, afterFilters, scoredCount, selected:{address,score,runningTaskCount,maxConcurrentTasks}, topRunners:[...], deploymentAffinity, deploymentConstraint, interpreterCacheAffinity}`
- **为什么是问题**：这是**唯一**回答「为什么派到这台 / 为什么没派到那台」的数据源，但：① 无 JSON Schema → 字段增删无守卫；② 不落库 → 只能 grep 日志，无法按 executionId 回溯历史决策；③ `dispatch` / `selectLeastLoaded` / `dispatchBroadcast` **三个派发面各写一套 JSON**（`selectLeastLoaded.decision` 在 `:4700-4719`），字段集不同（后者无 deploymentAffinity/interpreterCacheAffinity）。

### F-11 【占坑回滚不完整】派发失败回滚只减 `runningTaskCount`，不校验候选身份

- **位置**：`executor.service.ts:5728-5756`
- **证据**：catch 块无条件 `UPDATE executors SET runningTaskCount = GREATEST(...-1, 0) WHERE id = :id`（`:5730-5735`），随后若 `execution.mutexGroupId` 存在则清执行行的 `executorAddress`（条件带地址防误清，`:5741-5749`）。
- **为什么是问题**：这是**正确性尚可但脆**的回滚：① `GREATEST(...-1, 0)` 的钳制意味着**如果计数器已因别的原因偏低，回滚会静默吞掉一次真实占坑**（计数器漂移）；② 回滚不区分「本次占坑」与「其他并发占坑」——若占坑后有另一条路径也修改了 `runningTaskCount`，回滚会减错。**现有不变式靠「同一行锁 + 单条 UPDATE 原子」维持，注释里写得很清楚（`:5504-5510`）——这是正确的，但**回滚路径没有同等强度的论证**。

### F-12 【同族重复】派发载荷 task 白名单在 admin 侧是唯一事实源，但与 `protocol.json` 的 `TaskConfig` **无机器对账**

- **位置**：`apps/admin-api/src/modules/executor/dispatch-task-payload.util.ts:35-50`（`DISPATCH_TASK_FIELD_WHITELIST`，14 字段）
- **证据**：白名单的头注逐条推导了来源（protocol.json schemas.TaskConfig ∪ 三端实际读取面 ∩ 实体字段集），并明确说明「`packageUrl` 由 admin 在派发时解析注入（任务实体无此列）」。**推导是人工的、单向的**——`protocol.json` 改了 `TaskConfig`，白名单**不会红**。
- **对比**：`params.keyPattern` 有 `expect(DISPATCH_PARAM_KEY_PATTERN).toBe(protocol.params.keyPattern)` 这样的**机器对账**（`dispatch-params-keys.util.spec.ts:53`），而 `TaskConfig` ↔ `DISPATCH_TASK_FIELD_WHITELIST` **没有**。
- **补充证据（协议版本豁免）**：`protocol.json` 的 `TaskConfig` 声明了 `timeoutSeconds` / `timeout_seconds`（canonical + snake_case 别名），而 admin 的白名单**只发 `timeout`**——当前无害（执行器三键都读），但若某端改为「只认 timeoutSeconds」，admin 白名单会静默失效。**协议与实现之间存在一个未对账的缺口。**

### F-16 【决策不可观测】决策日志缺「占坑尝试轨迹」

- **位置**：`executor.service.ts:4805-4891`（`logExecutionDispatchDecision`）、`:5520-5533`（占坑循环）
- **证据**：决策日志只记「评分前三（`topRunners`）」与「最终选中者（`selected`）」，**不记**实际占坑时试了几个候选、各自的失败原因。占坑循环里收集了 `anyMutexBlocked`（`:5519`、`:5531`）但**未落日志**。
- **为什么是问题**：当「评分最优的那台没被选中」时，运维**无法区分**「它满了」「它离线了」「它被互斥组挡了」——三者对决策的含义完全不同（容量问题 / 健康问题 / 配额问题）。Nomad 的「计划-再验证」思路提示：应把**占坑尝试轨迹**纳入决策日志。

### F-13 【语义丢失】pinned 执行器满载时丢失 pinned 语义

- **位置**：`executor.service.ts:5518-5555`（占坑循环与失败出口）、`catalog/executor.ts` 的 `NO_DISPATCHABLE_EXECUTOR`
- **证据**：pinned 分支（`:5165-5222`）只处理「不存在」与「离线」两种情况，**未对满载单独处理**。占坑循环（`:5525-5532`）只区分 `claimed` / `mutex_full` / `unavailable`，而 `unavailable` 混合了「满载」与「离线」→ pinned 满载时落到 `NO_DISPATCHABLE_EXECUTOR`，文案是「没有可用的执行器（所有候选执行器都已离线或达到容量上限）」——**完全不提 pinned**。
- **为什么是问题**：与 pinned 离线（「指定的固定执行器 "{{appName}}" ({{executorId}}) 已离线」）/ 不存在（「指定的固定执行器 {{executorId}} 不存在」）的文案形态**不一致**。运维无法区分「pinned 设备满了（可等）」与「pinned 设备挂了（要处理）」。
- **来源**：开源调研副产品（见 `dispatch-core-oss-research.md` §9）。

### F-14 【语义歧义】`MutexGroup.maxConcurrentPerDevice` 的名字与实际语义不符

- **位置**：`executor.service.ts:4961-4963`（device/global 分档）、`:5002-5012`（组占用计数谓词）
- **证据**：device 档的计数谓词含 `"executorAddress" = $1`（**按设备计**），global 档只按 `mutexGroupId` 计数（**全平台计**）。
- **为什么是问题**：字段名 `maxConcurrentPerDevice` 本身如实描述了 device 档语义，但**产品语义**上用户常理解为「这个互斥组同时只跑 N 个」。在 device 档下设 1 → **N 台设备上各跑 1 个**（组并发数跨设备不生效）。**这是语义歧义而非实现缺陷**，需在文档/UI 层澄清，或引入 Airflow Pool 式「占用+排队」双计数（需拍板，见 §8 D-1）。

### F-15 【能力缺口】`Task.priority` 未接入派发链

- **位置**：`task.service.ts:713`（`VERSION_ROLLBACK_COLUMNS` 含 `priority`）、`executor.service.ts:5146-5758`（`dispatch()` 内零命中 `priority`）
- **为什么是问题**：实体有 `priority` 列、在版本回滚白名单里（**是产品可见字段**），但派发决策**完全不读它**。优先级语义在调度面未实现——用户配了优先级却观察不到任何效果。**独立缺口，不在本域切口内**，登记为观察项（Celery / Temporal 均有优先级/公平分层机制可参考，见 `dispatch-core-oss-research.md`）。

---

## §2 CodeGraph 探查结论

### 2.1 模块依赖图（dispatch-core 域）

```
                 ┌────────────────────────────────────────────────────────┐
                 │                     admin-api                           │
                 │                                                        │
   scheduler ───►│  SchedulerModule ──(forwardRef)──► TaskModule          │
      ▲          │        │                              │  ▲             │
      │          │        ▼                              │  │             │
      │          │  ExecutorModule ◄──(forwardRef)───────┘  │             │
      │          │        │                                    │             │
      │          │        │  exports: ExecutorService           │             │
      │          │        ▼                                    ▼             │
      │          │  ExecutorService ◄──── ExecutorService ◄── TaskProcessor │
      │          │   (184 符号/8488 行)     (dispatch/dispatchBroadcast)   │
      │          │        │                                    │             │
      │          │        │ SecretsCryptoService                │             │
      │          │        │ (TaskModule export ── forwardRef 注入)         │
      │          │        │                                    │             │
      │          │        ▼                                    ▼             │
      │          │  ExecutorService ──────────► TaskService (6990 行)       │
      │          │   (buildDispatchParams)         (handleCallback 656 行) │
      │          │                                                        │
      └──────────┘  ExecutorModule ──► ApplicationModule ──► ExecutorModule│
                     (forFeature 实体, 不 import 模块)          （实体关系非模块依赖）
                 └────────────────────────────────────────────────────────┘
```

**关键判定**：`executor.module.ts:17-24` 的注释明确说明「只加 Repository、**不** import ApplicationModule——后者反向 import 了 TaskModule + ExecutorModule，引入模块环；实体注册走 TypeORM `forFeature` 即可」。**这是本仓已有的正确解法范式——`forFeature` + 实体，不引模块。** 建议把 `SecretsCryptoService` 按同范式处理（见 §5 阶段 2）。

### 2.2 关键调用链路

**链路 A：单播派发（主链）**
```
BullMQ task-queue
  └─ task.processor.ts:165  handle()
       ├─ 读执行行/任务行（execRepo/taskRepo）
       ├─ applyPinnedVersionSnapshot (dispatch-task-payload.util.ts:106)  ← 快照覆盖
       ├─ task.service.ts:1067 inferFailureReason()（仅失败路径）
       └─ executor.service.ts:5146 dispatch(task, execution)
            ├─ [5165] pinned 分支：repo.findOne → status 检查 → 抛 PINNED_EXECUTOR_*
            ├─ [5229] resolveDeploymentConstraintContext()（DB 读，prefer/strict）
            ├─ [5237] strict: findOnlineExecutorsInDeploymentSet()（DB 读，绕开 Top-K）
            │         否则: findFleetCandidates()（DB 读，SQL 下推过滤 + Top-K）
            ├─ [5245] appName 精确匹配 → applyInterpreterFilter()
            ├─ [5266] group → tags → affinity → anti-affinity → runtime → interpreter
            ├─ [5358] estimatedDurationsByExecutor()（DB 读 ×2）
            ├─ [5362] computeExecutorLoadScore()（纯函数，已在 executor-score.util.ts）
            ├─ [5378] sort by score
            ├─ [5436] partitionByDeploymentAffinity()（纯函数，affinity.util）
            ├─ [5471] partitionByInterpreterCache()（纯函数，interpreter-match.util）
            ├─ [5520] for each candidate → claimExecutorSlotForExecution()（DB 写/事务）
            │              └─ 无组：单条 UPDATE ... WHERE runningTaskCount < max AND status=ONLINE
            │              └─ 有组：事务 + FOR UPDATE 行锁 + 组占用计数
            ├─ [5535] 失败出口：MutexWaitError / DeploymentConstraintWaitError / NO_DISPATCHABLE_EXECUTOR
            ├─ [5563] logExecutionDispatchDecision()（结构化日志）
            ├─ [5595] buildDispatchParams()（解密 secrets + params 键闸）
            ├─ [5606] resolveDispatchTask()（DB 读 + packageUrl 缓存）
            ├─ [5622] resolveVersionFollowPackage()（DB 读，版本跟随）
            ├─ [5661] pull 分支：pullService.enqueue()（Redis）
            └─ [5710] push 分支：assertAndPinExecutorUrl() → axios.post()
                 └─ catch [5728]: 回滚 runningTaskCount + 清 mutex 标记
```

**链路 B：回调收敛（终态写）**
```
executor → HTTP 回调
  └─ task/execution-callback.controller.ts
       └─ task.service.ts:5886 handleCallback()  (656 行, if × 30)
            ├─ :1067 inferFailureReason() ← 分类链（回调路径）
            ├─ 落终态 / 落日志 / 产物索引 / 事件
            └─ :5886→ executor.service.ts:1704 scheduleRetryAfterRecovery()（重试预算）
```

**链路 C：派发失败分类（另一条链）**
```
BullMQ handler catch
  └─ task.processor.ts:387  MUTEX_WAIT_TOKEN?      → WAITING（不烧预算）
  └─ task.processor.ts:403  DEPLOYMENT_WAIT_TOKEN? → WAITING（不烧预算）
  └─ task.processor.ts:428+ 分类链（派发路径）    ← 与链路 B 的 inferFailureReason **两条独立正则链**
```

### 2.3 耦合风险清单

| ID | 耦合 | 证据 | 破坏后果 | 现状 |
|---|---|---|---|---|
| C-01 | `ExecutorService` 构造器 21 位置参数 | `:712-842` | spec 位置装配**静默错位**（`{} as never` 骗过类型检查） | 🔴 高危 |
| C-02 | `dispatch()` 613 行 / 37 分支 | `:5146-5758` | 任一改动影响 37 条路径；纯决策不可单测 | 🔴 高危 |
| C-03 | 派发失败分类链双份（service vs processor） | `task.service.ts:1067` vs `task.processor.ts:428` | 同因两归因（PACKAGE_FETCH 少 2 项；SANDBOX/APPLICATION_MISSING 单边缺） | 🔴 已实证漂移 |
| C-04 | pinned 离线文案 ↔ `EXECUTOR_OFFLINE_PATTERN` 容差 120 | `catalog/executor.ts:213` ↔ `task.service.ts:665` | 文案改长 → 误报 `script_error` → 烧重试预算 | 🟡 已用同一常量缓解，容差仍为魔数 |
| C-05 | task ↔ executor 模块 forwardRef 环 | `executor.module.ts:78` / `task.module.ts:61` | bootstrap 顺序敏感；`SecretsCryptoService` 一人占两模块 | 🟡 注释已详述成因 |
| C-06 | 派发过滤链三处抄写 | `:5245-5352` / `:6184-6244` / `:4632-4668` | `selectLeastLoaded` 缺 affinity → 部署选机与单播派发语义分叉 | 🔴 行为分叉已存在 |
| C-07 | 决策日志三套 JSON 无 schema | `:4860-4890` / `:4700-4719` | 字段增删无守卫；历史不可回溯 | 🟡 |
| C-08 | `TaskConfig` ↔ `DISPATCH_TASK_FIELD_WHITELIST` 无机器对账 | `dispatch-task-payload.util.ts:35` | 协议改字段 → 白名单静默失效 | 🟡 |
| C-09 | node/python/admin 三份 params 键名闸 | 见 F-09 | 已发生过一次真实分叉（`$` vs `fullmatch`） | 🟡 有向量对账兜底 |
| C-10 | 占坑回滚与占坑不变量强度不对称 | `:5728-5756` vs `:5504-5510` | 计数器漂移 | 🟢 低 |

### 2.4 影响范围量化表

| 切口 | 涉及文件数（生产） | 涉及符号数 | 涉及 spec 文件数 | CodeGraph 量化依据 |
|---|---|---|---|---|
| **Q1 派发决策抽纯函数** | 3（`executor.service.ts` / `task.processor.ts` / `app-deployment.service.ts`） | 11 个方法（G4 组） | 5（`executor.service.spec.ts` / `executor.interpreters.spec.ts` / `executor.dispatch-estimated.spec.ts` / `executor.service.security.spec.ts` / `executor.mutex-claim.spec.ts`） | `impact ExecutorService::dispatch -d 3` → **29 符号**；`impact claimExecutorSlotForExecution -d 2` → **12 符号**；`impact findFleetCandidates -d 2` → **11 符号** |
| **Q2 拆分注册/心跳 vs 派发** | 8（`executor.service.ts` + `executor.controller.ts` + `task.processor.ts` + `task.service.ts` + `scheduler.service.ts` + `app-deployment.service.ts` + `execution-callback.controller.ts` + `sop-collab.controller.ts`） | 184 → 约 90 + 约 94 | **53 处 `provide: ExecutorService`** + 6 处 `new ExecutorService(...)` | `impact ExecutorService -d 3` → **150 符号**；`ExecutorService` 被 **69 文件**引用 |
| **Q3 forwardRef 环拆除** | 4（`executor.module.ts` / `task.module.ts` / `executor.service.ts` / `task.processor.ts`）+ 1 新文件 | 2 个 provider 注入点 | 需回归 `executor.module` / `task.module` 的 e2e bootstrap | `ExecutorService` 21 构造依赖中**仅 1 个**跨模块（`secretsCrypto`） |
| **Q4 文案/正则收敛到码表** | 6（`task.service.ts` / `task.processor.ts` / `executor-node/routes/execute.ts` / `executor-python/routers/execute.py` / `catalog/executor.ts` / `common/errors/app-error.ts`） | 6+2 = **8 份分类判据** | 5+（`task.processor.spec.ts` / `python-multiversion-write-path.spec.ts` / `interpreter-match.util.spec.ts` / node `param-env.spec.ts` / python `test_interpreter_failure.py`） | `grep` 实证：`EXECUTOR_OFFLINE_PATTERN` 2 处引用 + 2 份内联正则 + 2 份执行器侧判据 |
| **Q5 过滤链收敛为共享决策器** | 3（`executor.service.ts` 3 处）+ 1 新 util | 3 组 filter 链（~140 行） | 5（同 Q1） | `impact selectLeastLoaded -d 2` → **10 符号**；`impact dispatchBroadcast -d 2` → **14 符号** |

---

## §3 补丁方案 vs 重构方案对比

### Q1 — `dispatch()` 上帝方法拆分为「纯决策器 + 副作用编排层」

**方案 A（轻量补丁）**：在 `executor.service.ts` 内部把 `dispatch()` 拆成若干 `private` 方法（`resolveCandidates` / `scoreCandidates` / `claimSlot` / `deliverPayload`），签名不变，`ExecutorService` 仍是唯一 public 入口。
**方案 B（结构性重构）**：新建 `dispatch/` 子目录，抽出
- `dispatch-decision.util.ts`：**纯函数**决策器（输入 `DispatchDecisionInput` = 任务约束 + 候选快照 + 部署上下文 + 估时索引；输出 `DispatchDecision` = 有序候选 + 决策元数据 + 失败出口类型）。
- `dispatch-orchestrator.service.ts`：编排层（DB 查询 → 调纯决策器 → 占坑 → 传输 → 回滚）。
- `ExecutorService` 保留注册/心跳/令牌/指标，**不再持有派发决策**。

| 维度 | 方案 A（私有方法拆分） | 方案 B（纯决策器 + 编排器） |
|---|---|---|
| **长期收益** | 3/5 —— 613 行变 6 个私有方法，可读性提升；但决策逻辑仍**不可独立单测**（依赖 `this`） | 5/5 —— 决策逻辑变成**可单测的纯函数**，策略可替换（未来加「GPU 亲和」「成本优先」等新策略零侵入） |
| **后续维护成本** | 3/5 —— 私有方法间仍共享 `this.*` 依赖与可变状态（`candidates`/`deploymentCtx`/`strictFilterNote` 三个跨方法可变变量需重新组织） | 4/5 —— 新增一个纯函数文件 + 一个编排 service；决策器**零依赖**，测试成本近零 |
| **扩展潜力** | 2/5 —— 想加新调度策略仍要改 `ExecutorService` 内部 | 5/5 —— `DispatchStrategy` 接口化后，新策略 = 新实现 + DI 替换 |
| **技术债堆积风险** | 2/5 —— **只是把上帝方法切成上帝类**，184 符号/69 文件引用的结构问题**完全没解** | 4/5 —— 派发决策从 `ExecutorService` 中析出，`ExecutorService` 降为编排/门面 |
| **短期工作量与风险** | 5/5 —— 约 1-2 人日；纯搬移，行为零变更，回归面 = 现有 5 个 dispatch spec | 3/5 —— 约 3-5 人日；需要**逐分支证明等价**；高风险点是「占坑前评分快照」的顺序敏感 |
| **推荐** | 备选 | ✅ **推荐重构** |

**推荐理由**：长期综合收益（5×5 + 4×5 + 5×5 = 显著高于）> 短期成本（3/5）。关键论据：**派发决策是本域唯一「纯逻辑 + 高变更频 + 难验证」的组合**——它已经出过两次真实缺陷（QA-05 并发误判、ARCH-35 部署归属丢失），且每次修复都在 613 行方法里「手工手术」。把它变成纯函数，是让下一次修复从「祈祷没碰坏别的分支」变成「跑一遍表驱动单测」。

**具体切缝（行段边界 + 纯/副作用判定）**：

| # | 阶段 | 行段 | 性质 | 建议归属 |
|---|---|---|---|---|
| S1 | pinned 分支解析 | `:5165-5222` | **混合**（`repo.findOne` 查库 + 状态判定纯逻辑） | 编排层查库 → 纯判定 |
| S2 | 部署约束上下文 | `:5229-5231` | **IO**（`resolveDeploymentConstraintContext` 查 `app_deployments`） | 编排层 |
| S3 | 候选池查询 | `:5232-5241` | **IO**（`findFleetCandidates` / `findOnlineExecutorsInDeploymentSet`） | 编排层 |
| S4 | appName 精确匹配 + 解释器过滤 | `:5245-5265` | **纯**（`applyInterpreterFilter` 已是纯函数） | 决策器 |
| S5 | group/tags/affinity/anti-affinity/runtime/interpreter 过滤链 | `:5266-5352` | **纯**（全是内存 `.filter()`） | 决策器 |
| S6 | 估时索引 + 评分 + 排序 | `:5358-5380` | **混合**（`estimatedDurationsByExecutor` 查库 ×2；`computeExecutorLoadScore` 纯） | 编排层取数 → 决策器算分 |
| S7 | 部署归属分区 | `:5406-5451` | **纯**（`partitionByDeploymentAffinity` 已是纯函数） | 决策器 |
| S8 | 解释器缓存分区 | `:5466-5487` | **纯**（`partitionByInterpreterCache` 已是纯函数） | 决策器 |
| S9 | 决策日志组装 | `:5563-5581` | **纯**（拼 JSON 输入） | 决策器返回元数据，编排层落日志 |
| S10 | 原子占坑循环 | `:5518-5555` | **IO**（DB 写 + 事务 + 行锁） | 编排层 |
| S11 | 载荷构建（params/secrets/解析） | `:5593-5656` | **混合**（`buildDispatchParams` 含解密 IO；`buildDispatchTaskPayload` 纯） | 编排层 |
| S12 | 版本跟随 | `:5617-5647` | **IO** | 编排层 |
| S13 | pull/push 传输 + 回滚 | `:5658-5757` | **IO** | 编排层 |

> **可单测的纯决策面 = S4 + S5 + S6(算分部分) + S7 + S8 + S9**，约 **200 行**，覆盖当前**绝大部分分支**（37 个 if 中约 25 个落在纯面）。这是本方案最大的价值：**把 80% 的分支变成表驱动单测**。

---

### Q2 — 把 `ExecutorService` 拆成「注册/心跳」与「派发」两个 service

**方案 A（轻量补丁）**：不拆类，只在 `executor.service.ts` 内**加分组注释 + 抽出纯 util**（如 `executor-filters.util.ts`），降低单文件认知负担。
**方案 B（结构性重构）**：拆成
- `ExecutorRegistryService`（G1 令牌 + G2 注册心跳 + G3 指纹冲突 + G6 版本应用 + G7 指标 + G8 回调命令 + G9 审计清理）
- `ExecutorDispatchService`（G4 派发决策 + G5 占坑释放重试）

**构造依赖方案（方案 B 的具体形态）**：

| 目标 service | 构造依赖 | 来源 | 备注 |
|---|---|---|---|
| `ExecutorRegistryService` | `repo(Executor)`、`taskQueue`、`configService`、`notificationService`、`systemConfigService`、`eventBus?`、`tracing?`、`audit?`、`leaderGate?`、`tokenCacheSync?`、`applicationRepo?`、`appDeploymentRepo?`、`applicationVersionRepo?`、`executorAppVersionRepo?`、`dataSource` | 全在 executor 模块内 | **不依赖 TaskModule** |
| `ExecutorDispatchService` | `repo(Executor)`、`execRepo(TaskExecution)`、`taskRepo(Task)`、`configService`、`secretsCrypto`（**唯一跨模块**）、`eventBus?`、`tracing?`、`pullService?`、`applicationRepo?`、`appDeploymentRepo?`、`mutexGroupRepo?`、`applicationVersionRepo?`、`dataSource` | `secretsCrypto` 跨模块 | 见 Q3 |
| 共享窄接口（token） | `ExecutorRegistryService` 提供 `validateExecutorToken` / `getCallbackSecretById` / `issueToken` | 由 `executor.controller.ts` + `execution-callback.controller.ts` + `sop-collab.controller.ts` 消费 | 用**接口**（`Symbol` token）注入，不注入具体类 |

**既有 spec 位置参数装配的迁移策略**：
- **推荐：先加工厂/Builder，再改 spec**（不是直接改 spec）。
  1. 阶段 2a：新增 `apps/admin-api/src/modules/executor/__tests__/helpers/executor-service.factory.ts`，导出 `createExecutorService(overrides)` / `createExecutorDispatchService(overrides)`，用**具名对象**装配。
  2. 阶段 2b：把 6 处 `new ExecutorService(...)` 位置装配的 spec 改为工厂调用（**保持行为完全一致**，用 golden 断言比对旧新服务的关键方法输出）。
  3. 阶段 2c：拆 class，**保持 `ExecutorService` 作为兼容门面**（`@Injectable()`，内部委派给两个新 service），**53 处 `provide: ExecutorService` 全部不动** → 回归面 = 0。
  4. 阶段 2d：门面稳定后，再逐步把 controller / processor 改为直连新 service，逐步删门面。
- **不建议**直接改 spec：`{} as never` 占位会**静默错位**（F-03），一次性改 53+6 处风险极高。

| 维度 | 方案 A（注释+抽 util） | 方案 B（拆两个 service） |
|---|---|---|
| **长期收益** | 2/5 —— 184 符号/69 引用/21 位置参数**全部保留** | 5/5 —— 派发面与注册面解耦；派发 service 构造依赖从 21 降到 ~13；forwardRef 面收窄到 1 个 provider |
| **后续维护成本** | 2/5 —— 单文件仍 8488 行 | 4/5 —— 两个 service 各自内聚 |
| **扩展潜力** | 2/5 | 4/5 —— 派发策略可独立演进；执行器注册协议变更不影响派发面 |
| **技术债堆积风险** | 1/5 —— **债务原样保留** | 4/5 —— 消掉「21 位置参数」这个最硬的约束 |
| **短期工作量与风险** | 5/5 —— 0.5-1 人日，零风险 | 2/5 —— 5-8 人日；**触及 53 处 DI 覆盖 + 69 个引用文件** |
| **推荐** | 备选 | 🟡 **推荐重构，但必须分阶段 + 兼容门面过渡**（见 §5） |

**风险极高部分的降级**：方案 B 的**第 2c 步（真拆 class）**是全域最高风险动作。**降级方案**：先做 Q1（纯决策器）与 Q5（过滤链收敛）——它们**不动 class 边界、不动构造器**，却已经拿走了 80% 的可测性收益；把「拆 class」推迟到 Q1/Q5 落地并稳定一个发布周期之后。**即：Q2 的收益大部分可由 Q1+Q5 间接获得，不必一步到位。**

---

### Q3 — 拆除 `task` ↔ `executor` 模块 forwardRef 环

**方案 A（轻量补丁）**：不动模块图，只在 `task.module.ts` / `executor.module.ts` 的 `forwardRef` 处补更详尽的注释 + 加一条「模块环存在」的守卫脚本。
**方案 B（结构性重构）**：把 `SecretsCryptoService` 从 `TaskModule` 移到**全局模块**（或新建 `common/crypto` 模块），两侧各自 import，环自然消失。

**关键数据**：`ExecutorService` 的 21 个构造依赖中，**只有 `secretsCrypto` 一个**来自 TaskModule（`executor.module.ts:71` 注释：「SEC-02: dispatch 时解密 task.secrets……SecretsCryptoService 由 TaskModule export 提供」）。**环的唯一成因就是这一个 provider。**

| 维度 | 方案 A（注释+守卫） | 方案 B（SecretsCryptoService 移出 TaskModule） |
|---|---|---|
| **长期收益** | 1/5 —— 环还在，`require` 顺序敏感的隐患还在 | 5/5 —— 环消失；两模块可各自独立测试/独立装配 |
| **后续维护成本** | 1/5 | 4/5 —— 不再需要「新增依赖必须带 forwardRef」的纪律 |
| **扩展潜力** | 1/5 | 4/5 —— 新模块（如未来的 `dispatch-core` 模块）可自由引用 |
| **技术债堆积风险** | 1/5 | 5/5 —— 消除结构性债务 |
| **短期工作量与风险** | 5/5 —— 0.5 人日 | 4/5 —— 1-2 人日；**需回归 e2e bootstrap 装配顺序**（注释自述有实证风险） |
| **推荐** | 备选 | ✅ **推荐重构**（改动面小、收益直接、风险可控） |

**依赖倒转的具体形态**（满足任务书「让 task 模块依赖接口而非具体类」的要求）：
```ts
// apps/admin-api/src/common/crypto/secrets-crypto.service.ts（或 common/crypto.module.ts）
@Global()                       // 已是无状态工具（Key 生命周期全进程一致）
@Module({ providers: [SecretsCryptoService], exports: [SecretsCryptoService] })
export class CryptoModule {}

// executor.module.ts：删除 forwardRef(() => TaskModule)，改 import CryptoModule
// task.module.ts：同理
// executor.service.ts:728：@Inject(forwardRef(() => SecretsCryptoService)) → @Inject(SecretsCryptoService)
```
- `SecretsCryptoService` 已是**无状态**（Key 来自 env `SEC_SECRETS_KEY`）→ 做 `@Global()` 零风险。
- **额外收益**：`task.module.ts` 的 `exports` 里 `SecretsCryptoService` 可保留（兼容既有 import），但 provider 归属移到 `CryptoModule`。

---

### Q4 — 跨文件文案/正则耦合收敛到单一码表

**方案 A（轻量补丁）**：把 `task.processor.ts` 的 3 条内联正则改成 import `task.service.ts` 的导出常量（与已做的 `EXECUTOR_OFFLINE_PATTERN` 同款），修掉 PACKAGE_FETCH 少 `module not found|cannot find module` 的分叉。
**方案 B（结构性重构）**：新建 `apps/admin-api/src/common/failure-classification/` 目录：
- `failure-patterns.ts`：**全部**分类判据的**唯一事实源**（导出 `TIMEOUT_PATTERN` / `EXECUTOR_OFFLINE_PATTERN` / `INTERPRETER_UNAVAILABLE_PATTERN` / `PACKAGE_FETCH_PATTERN` / `SCRIPT_ERROR_PATTERN` / `SANDBOX_UNAVAILABLE_PATTERN` / `APPLICATION_MISSING_PATTERN`）。
- `classify-failure.ts`：`classifyFailure(text, exitCode)` —— **单一分类函数**，回调路径与派发路径**共用同一个**，从根上消除「两条正则链」。
- `dispatch-message-codes.ts`：pinned 离线等**中台自产文案的 token 化**（如 `PINNED_EXECUTOR_OFFLINE` 码 → 分类器**直接按码分类**，不靠文案正则）。

| 维度 | 方案 A（共享常量） | 方案 B（单一分类器 + 码化） |
|---|---|---|
| **长期收益** | 3/5 —— 消除「抄写分叉」，但**两条链仍并行**（规则顺序/新增规则仍要同步两处） | 5/5 —— **一条链**；新增规则只加一处；中台自产失败**按码分类**（不再靠正则猜） |
| **后续维护成本** | 3/5 | 5/5 —— 一处改，一处生效 |
| **扩展潜力** | 2/5 | 5/5 —— 新增 failureReason 只需加一条规则 + 一个码 |
| **技术债堆积风险** | 2/5 | 5/5 |
| **短期工作量与风险** | 5/5 —— 0.5 人日，改 3 行 import + 1 处正则补齐 | 3/5 —— 2-3 人日；**需要重新验证所有分类用例的顺序敏感性**（分类链顺序是刻意的） |
| **推荐** | 备选（**但必须做**——它是已实证的缺陷 F-05 残留） | ✅ **推荐重构** |

**「码化」的具体形态**（这是消除 F-06 魔数容差的关键）：
```ts
// 中台自产失败 → 直接带码，不再靠文案正则反推
throw new AppError("PINNED_EXECUTOR_OFFLINE", {...});   // 已存在
// 分类器读到 AppError.errorCode 时直接映射，不再跑 EXECUTOR_OFFLINE_PATTERN
```
即：**分类器输入从「一段自由文本」升级为「（结构化 errorCode?, 自由文本, exitCode?）」**。`errorCode` 存在时**优先采信**（这与 `task.service.ts:1078` 已有的 `cb.failureReason ?? this.inferFailureReason(...)` 纪律同款），只有**旧执行器/包装异常**才落到正则兜底。这样：
- pinned 离线**永远**归 `EXECUTOR_OFFLINE`，**与文案长度解耦** → **F-06 的 120 魔数可以退休**。
- 但**注意**：`AppError` 的 `errorCode` 只在**同进程**内可见；`task.processor` 捕获的是**同进程异常** → ✅ 可行。而回调路径的失败来自**跨进程 HTTP**（执行器上报 `failureReason`）→ 已有 `cb.failureReason` 优先采信。**两条路径都有结构化通道**，正则只做兜底。

**扩展方案（可选）**：`packages/executor-protocol/protocol.json` 新增 `failureClassification` 段，把**执行器侧**的分类判据也纳入三端向量（当前 `failureReason` 段只登记枚举，不登记判据）。这会让 node/python 的两份判据也进入单一事实源体系。**建议放到阶段 3**（跨语言改动成本更高）。

---

### Q5 — 派发过滤链收敛为共享决策器（顺带修掉 `selectLeastLoaded` 的语义分叉）

**方案 A（轻量补丁）**：抽一个 `executor-filters.util.ts`，三处 filter 链改为调用它，`selectLeastLoaded` 补上 affinity/anti-affinity。
**方案 B（结构性重构）**：与 Q1 合并——把过滤链做成 Q1 纯决策器的一部分（`filterCandidates(input, candidates)`），并引入**语义参数**区分三种派发模式：

```ts
type DispatchMode =
  | { kind: "single" }                              // dispatch：亲和=软偏好，anti=排除
  | { kind: "broadcast" }                           // dispatchBroadcast：亲和=收窄扇出（已裁决语义）
  | { kind: "selection" };                          // selectLeastLoaded：补齐亲和语义
```

| 维度 | 方案 A（共享 util） | 方案 B（并入 Q1 决策器 + 模式参数） |
|---|---|---|
| **长期收益** | 3/5 —— 消除三份抄写；但 `dispatch`/`broadcast` 的**亲和语义差异**仍需外部小心处理 | 5/5 —— 三条派发链共享**同一份过滤实现 + 显式模式参数**，语义差异被**类型化**而非靠注释 |
| **后续维护成本** | 3/5 | 4/5 |
| **扩展潜力** | 2/5 | 5/5 —— 新增过滤维度 = 加一个参数 + 一条规则 |
| **技术债堆积风险** | 3/5 | 4/5 |
| **短期工作量与风险** | 4/5 —— 1-2 人日 | 4/5 —— 与 Q1 同期完成，边际成本低 |
| **推荐** | 备选 | ✅ **推荐重构（与 Q1 合并，不单独排期）** |

**Q5 单独价值**（即使不做 Q1 也值得做）：**修掉 `selectLeastLoaded` 缺 affinity/anti-affinity 的行为分叉**。该方法被 `app-deployment.service.ts:1333` 的 `deploy()` 消费——即**「应用部署选哪台执行器」这条链不支持亲和性约束**，而单播派发支持。**同一产品概念（亲和）在两条链上行为不同 = 用户可感知的缺陷**。

---

## §4 开源参考清单

> **License 合规声明**：我方项目 **AGPL-3.0-only**。下表中 **Celery 是 BSD-3-Clause（可商用、可闭源衍生，兼容 AGPL）**，**Hatchet / Temporal / Nomad 是 MIT**，**Kubernetes / Airflow / Sentinel / Resilience4j 是 Apache-2.0**。**Apache-2.0 与 AGPL-3.0 单向兼容**（Apache 代码可进 AGPL 项目；AGPL 代码不可进 Apache 项目）。**本表所有项目均可安全借鉴思路**；**表中无 GPL/AGPL 项目**，无协议污染风险。若将来引入 GPL/AGPL 实现（如 Celery 的部分周边工具），必须**仅借鉴思路、不复制代码**，并由法务确认。
> **已核对方式**：`hatchet-main` / `temporal-main` 读本机副本源码 + LICENSE 首行；其余 6 项用 `api.github.com/repos/<owner>/<repo>/license` 取官方 LICENSE 原文并读 SPDX 声明。

| 仓库 | License (SPDX) | 核心亮点 | 可复用点（具体到源码） | 缺陷 | 适配成本 | 我方采纳方式 |
|---|---|---|---|---|---|---|
| **[hatchet-dev/hatchet](https://github.com/hatchet-dev/hatchet)** | **MIT** | 分布式工作流引擎；**调度决策层与副作用层严格分离**：调度器单 goroutine run-loop 持有全部可变状态，DB 读在 loop 外 | ① `pkg/scheduling/v1/scheduler.go:1468 rankWorkerIds()` —— **worker 打分/亲和排序**：`Sticky(HARD/SOFT)` → 标签权重 → 稳定排序 → 计算 `topRankCount`（同分并列组）；② `pkg/scheduling/v1/worker.go:13 computeWeight()` —— **纯函数**的标签亲和打分（required 不满足返回 -1 直接淘汰）；③ `pkg/scheduling/v1/action.go:19 ringOffset` —— **环形偏移**在同分组内轮转，避免全部任务压同一台；④ `pkg/scheduling/v1/slot_pool.go` —— **slot 池 + 池级过期**（`defaultSlotExpiry = 1500ms`），过期整池作废而非逐槽排空；⑤ `pkg/scheduling/v1/action.go` `starved`/`RestoreStarved` —— **饥饿检测与唤醒**（miss 记录 → 重建后恢复） | ① Go 实现，我方 TS/NestJS 不可直接复用；② 其 slot 池是**内存态 + 定期 replenish**，我方是**DB 原子 UPDATE**（持久化单点真理），两者模型不同；③ 标签权重模型（`WorkerLabelComparator`）与我方的 group/tags/affinity 三维不同构 | **中**（思路可直接翻译，代码零复用） | **强烈借鉴「纯打分函数 + 显式亲和权重 + 同分并列组轮转」三件套**：<br>① 采纳 `rankWorkerIds` 的**分层淘汰**思想 → 我方 affinity 改为**可配权重**而非硬过滤；<br>② 采纳 `ringOffset` → 我方同分候选**环形轮转**，避免长期压同一台（当前是纯 sort，同分恒取第一台）；<br>③ 采纳 `slot_pool` 的**整池过期**思想 → 我方 `estimatedDurationsByExecutor` 的采样池可整池失效，避免部分陈旧样本 |
| **[temporalio/temporal](https://github.com/temporalio/temporal)** | **MIT** | 工作流引擎；**任务队列 + 抢占 + 公平分发** | ① `service/matching/fairness.md` —— **「公平层级 = (pass, id)」**模型：pass 按公平键分配、id 单调递增，任务**乱序写入但按 level 有序读出**，实现跨 partition 的**公平 round-robin**；② `service/matching/matching_engine.go:75-77 stickyPollerUnavailableWindow = 10s` —— **sticky 队列不可用即降级到普通队列**（对应我方「pinned 执行器离线 → 不换机」与「pinned 不可用 → WAITING」的**语义分歧点**）；③ `service/matching/fair_task_reader.go` —— **ack/read level 分离**（A=已派发、R=已读入内存、M=最大已写），崩溃后允许重复派发（**at-least-once 明确化**）；④ `service/matching/fairness_util.go:39 ditherPass()` —— **抖动化 pass 分配**，避免同键任务批量同 pass | ① Temporal 是**持久化工作流**（activity 超时/重试由 server 保证），我方是**短任务执行器**，无 workflow 概念；② 复杂度远高于我方需求 | **高**（仅理念层） | **借鉴 3 点**：<br>① **sticky 降级策略显式化** → 我方 `pinned` 失败出口应**明确区分**「设备不存在 / 设备离线 / 设备满载」三态（当前 pinned 离线与 pinned 不存在都落 500），并为 pinned 提供**可选**的「降级到全机队」策略（默认关闭，保持现有语义）；<br>② **at-least-once 语义显式化** → 我方占坑+回滚的重复派发窗口应在文档中写明；<br>③ **抖动化** → 我方同分候选的 tie-break 可加确定性抖动 |
| **[celery/celery](https://github.com/celery/celery)** | **BSD-3-Clause**（GitHub 报 `NOASSERTION`，实为 BSD-3-Clause，LICENSE 原文第三段「Celery is licensed under The BSD License (3 Clause)」） | Python 任务队列；**路由（routing）+ worker 池 + 优先级** | ① `celery/app/routes.py` —— **路由表**：`task_type → queue` 映射（我方 `task-queue` 单一队列，无路由层）；② `celery/worker/consumer/consumer.py` —— **prefetch + 公平分发**（每 worker 预取上限，避免单 worker 抢光）；③ `celery/app/amqp.py` —— **优先级队列**（`task_priority` 0-9）；④ `celery/concurrency/prefork.py` —— **进程池 worker 生命周期** | ① **Python-only**，我方执行器是 node/python 双端但**中台是 TS**，路由层要自己实现；② Celery 的 worker 池是**单机进程池**，无跨机调度；③ 优先级模型简单，与我方 `priority` 列语义不对齐 | **高** | **借鉴 1 点**：**prefetch 思想** → 我方 BullMQ worker 并发 5（`task.processor.ts:88`）在派发慢时可能积压；建议把「同一执行器的连续派发」做**在途去抖**（不适用则放弃）。**优先级路由不采纳**（我方已有 `priority` 列但走的是另一条语义） |
| **[hashicorp/nomad](https://github.com/hashicorp/nomad)** | ⚠️ **2026-11-03 复核订正**：**≤v1.6.0 = MPL-2.0**（实测该版本 LICENSE 首行「Mozilla Public License, version 2.0」）；**≥v1.7.0 = Business Source License 1.1**（source-available，含 Additional Use Grant 竞品限制，4 年后转 MPL-2.0）——原判「MPL-2.0」取到的是旧版本 | 集群调度器；**allocation 占坑与抢占** | ① `client/allocation/` —— **allocation 状态机**（`pending` → `running` → `complete`/`failed`）与 **reschedule 抢占**（`client.Reschedule`）；② **plan/alloc 的「声明-再验证」两阶段**（先 plan 出 alloc，再 apply 时校验 placement 是否仍有效） | ① Go 实现；② **Consul/Serf 强依赖**（我方无服务发现层）；③ allocation 生命周期比单次派发重得多 | **高** | **借鉴 1 点**：**「计划-再验证」两阶段** → 我方 `dispatch()` 的候选查询与占坑之间存在**时间窗**（候选池查完 → 评分 → 占坑），窗口内设备可能已被别人占掉。我方当前靠**占坑 UPDATE 的原子性**兜底（正确），但 Nomad 的思路提示：**可以在占坑前对「首选候选」做一次轻量 re-validate**，减少「评分最优但已满」的空转。**低优先级** |
| **[kubernetes/kubernetes](https://github.com/kubernetes/kubernetes)** | **Apache-2.0** | 调度器；**过滤（Filter）+ 打分（Score）两阶段框架** | ① `pkg/scheduler/framework/types.go` —— **Plugin 接口**：`Filter` 返回 `Success/Unschedulable`，`Score` 返回 `int64` 权重；② `pkg/scheduler/framework/plugins/imagelocality` —— **本地性打分**（偏好已部署该应用/镜像的节点）；③ `pkg/scheduler/framework/plugins/nodeaffinity` —— **亲和/反亲和**（硬/软分离） | ① Go 实现；② **k8s 的 filter 是「不可调度则不调度」而非「不可调度则降级」**——我方 dispatch 的「降级回全机队」语义与之不同；③ 需 etcd + kube-apiserver | **中**（架构层高度可借鉴） | **借鉴 2 点（架构级，价值最高）**：<br>① **采纳「Filter + Score 两阶段」显式分层** → 我方 Q1 纯决策器内部就按这两段切：Filter（硬约束：group/tags/anti-affinity/runtime/interpreter）产出 `Unschedulable` 语义，Score（软信号：load/cpu/mem/longTask/deploymentAffinity/interpreterCache）产出有序候选。**当前我方把硬过滤与软偏好混在一个方法里，是 `dispatch()` 复杂度高的根因之一。**<br>② **采纳「亲和=硬/软双态」** → 我方 affinity 当前是**硬过滤**（`dispatch`）/ **收窄扇出**（`broadcast`）两套语义，k8s 的「硬亲和=过滤、软亲和=加分」能**统一**这两套 |
| **[apache/airflow](https://github.com/apache/airflow)** | **Apache-2.0** | 工作流编排；**pool / slot 抽象** | ① `airflow/models/pool.py` —— **Pool** 模型：`slots`（总并发）、`occupied_slots`、`queued_slots`，并有 `include_deferred` 语义；② **`PoolSlotsAvailable` 判定**：调度时检查 `pool.occupied + queued + 1 <= pool.slots`；③ **pool 满了 → 任务进 `queued` 态**（不是失败） | ① Airflow 的 pool 是**DB 计数行**（乐观锁递增），我方是**执行器行上的 `runningTaskCount`**；② Airflow 的排队是**无限等待**，我方有 **WAITING + 10s sweep 唤醒**（更精细） | **中** | **借鉴 2 点**：<br>① **采纳「pool 槽位 = 占用 + 排队」双计数** → 我方互斥组占用只数 `status='running'`（`executor.service.ts:5004-5011`），**排队的执行不占组位**——这意味着「10 个任务等 1 个互斥组」时，第 11 个来了仍会被放行到执行器上再排队，**组位的语义是「在跑的」而不是「在等或跑的」**。Airflow 的双计数能表达「在跑的 + 在等的 ≤ 组并发数」的更强约束。**需拍板**（见 §8）。<br>② 采纳「pool 满 → 排队不是失败」的显式建模 → 我方 WAITING 机制已是此形态，**只需确认互斥组是否也适用** |
| **[alibaba/Sentinel](https://github.com/alibaba/Sentinel)** | **Apache-2.0** | 流量治理；**熔断/限流/降级** | ① `sentinel-core` 的 **CircuitBreaker** 状态机（`OPEN/HALF_OPEN/CLOSED`）；② **DegradeRule**（异常比例降级） | ① **Java-only**（我方 TS）；② Sentinel 是**入口流量治理**，我方的问题是**出站派发** | **高** | **借鉴 1 点（弱）**：**出站熔断** —— 我方对同一离线执行器连续派发失败无短路。若 `dispatch()` 连续 N 次因 `EXECUTOR_OFFLINE` 失败，可对该 address 做**短时熔断**（跳过该候选）。**低优先级**，且需与「pinned 不换机」语义协调 |
| **[resilience4j/resilience4j](https://github.com/resilience4j/resilience4j)** | **Apache-2.0** | 弹性模式库；**Bulkhead / RateLimiter / CircuitBreaker** | ① **Bulkhead**（舱壁隔离）：限制并发对某资源的访问；② **RateLimiter**：令牌桶限流；③ **TimeLimiter**：超时包装 | ① Java-only；② 语义偏「客户端」而非「调度器」 | **高** | **借鉴 1 点（弱）**：**Bulkhead 思想** → 我方对**单个执行器**的派发已有 `maxConcurrentTasks` 闸（= bulkhead），**已是此形态**，无需改造 |

### 4.1 对我方最有价值的 3 条（按可落地性排序）

1. **Kubernetes scheduler 的 Filter/Score 两阶段框架** —— 直接可落地为 Q1 纯决策器的内部结构，且能解释并消除 `dispatch()` 的大部分分支复杂度。
2. **Hatchet 的 `rankWorkerIds` + `computeWeight` + `ringOffset`** —— 纯函数打分 + 显式亲和权重 + 同分轮转，三件套可直接翻译成 TS；解决我方「同分恒取第一台」的负载不均。
3. **Airflow 的 Pool「占用 + 排队」双计数** —— 指出我方互斥组占位语义的一个**可能的**语义缺口（需拍板）。

---

## §5 推荐方案与分阶段路线图

### 阶段 1：低风险切缝（不改 class 边界、不改构造器、不改模块图）

| 项 | 文件 | 验收判据 |
|---|---|---|
| **1.1 分类链收敛（Q4 方案 B 的最小版）** | 新建 `apps/admin-api/src/common/failure-classification/failure-patterns.ts` + `classify-failure.ts`；改 `task.service.ts:1067-1122`（`inferFailureReason` 改为调用 `classifyFailure`）与 `task.processor.ts:428-470`（同一函数） | ① `task.service.ts` 与 `task.processor.ts` **调用同一个** `classifyFailure`；② **PACKAGE_FETCH 分叉修掉**（`task.processor.ts:457` 补 `module not found\|cannot find module`）；③ `SANDBOX_UNAVAILABLE_PATTERN` / `APPLICATION_MISSING` 两条规则**提升为共享**（回调路径也生效）；④ 新增表驱动单测：同一组 20+ 条失败文案 × 两条路径 → **归因必须完全一致**；⑤ 现有 `task.processor.spec.ts` / `python-multiversion-write-path.spec.ts` 全绿 |
| **1.2 中台自产失败的「码化优先」** | `classify-failure.ts` 增 `errorCode?` 入参；`task.processor.ts` catch 中若 `err instanceof AppError` 且有 `errorCode` → **直接映射** failureReason，**跳过正则**；`catalog/executor.ts` 给相关码补 `failureReason` 映射字段 | ① `PINNED_EXECUTOR_OFFLINE` → **无条件**归 `EXECUTOR_OFFLINE`（与文案长度解耦）；② `EXECUTOR_OFFLINE_PATTERN` 的中文支容差 **从 120 改为「不再依赖中文支判中台自产文案」**（英文支保留兜底；中文支容差可降到 40 或保留但降级为纯兜底）；③ 回归：pinned 离线在**派发路径**与**回调路径**归因一致 |
| **1.3 过滤链共享 util（Q5 方案 A，先不动 class）** | 新建 `apps/admin-api/src/modules/executor/executor-filters.util.ts`；`dispatch`（`:5266-5352`）/ `dispatchBroadcast`（`:6184-6244`）/ `selectLeastLoaded`（`:4632-4668`）三处改为调用 | ① 三处 filter 链**共用一份实现**（模式参数区分 single/broadcast/selection）；② **`selectLeastLoaded` 补齐 affinity/anti-affinity**（当前缺失 = 行为分叉）；③ 新增单测：三模式 × (group/tags/affinity/anti-affinity/runtime/interpreter) 六维的**表驱动**断言；④ `app-deployment.service.ts:1333` 的 deploy 选机路径**行为变化需显式评审**（补 affinity 后可能选到不同机器） |
| **1.4 决策日志 schema 化** | 新建 `dispatch-decision-log.schema.ts`（zod 或纯类型 + 运行时校验）；`logExecutionDispatchDecision` 与 `selectLeastLoaded` 的 JSON 出口统一到**一份 shape** | ① 三个派发面（dispatch / dispatchBroadcast / selectLeastLoaded）输出**同一份字段集**（缺的显式 `null`）；② schema 校验失败即抛（不静默输出畸形 JSON）；③ 字段增删有守卫测试 |

**阶段 1 验收**：`npx tsc --noEmit`（当前已通过，本轮实测）+ 上述 4 个 executor spec + 2 个 task spec 全绿；`ExecutorService` **零改动**（仅方法体内部调整）。

---

### 阶段 2：主体改造

| 项 | 文件 | 验收判据 |
|---|---|---|
| **2.1 纯决策器落地（Q1 方案 B）** | 新建 `apps/admin-api/src/modules/executor/dispatch/` ：<br>• `dispatch-decision.types.ts`（`DispatchDecisionInput` / `DispatchDecision` / `DispatchFailureKind`）<br>• `dispatch-decision.ts`（**纯函数** `decideDispatch(input): DispatchDecision`）<br>• `dispatch-decision.spec.ts`（表驱动）<br>• `executor.service.ts:5146` 改为调用纯决策器 | ① `decideDispatch` **零 IO**（无 repo / 无 http / 无 Date.now / 无 logger）——以 lint 规则或依赖注入断言强制；② 覆盖 **S4+S5+S7+S8+S9** 全部 5 个纯面阶段，**表驱动用例 ≥ 60 条**；③ `dispatch()` 行数从 **613 → ≤ 220**；④ 现有 5 个 dispatch spec **不改断言**全绿（行为等价证明） |
| **2.2 `ExecutorService` 拆 class（Q2 方案 B）** | 新建 `executor-registry.service.ts` + `executor-dispatch.service.ts`；`executor.service.ts` 降为**兼容门面**（委派） | ① **`ExecutorService` 保持为 `@Injectable()` 且 export** → **53 处 `provide: ExecutorService` 零改动**；② 6 处 `new ExecutorService(...)` 位置装配**改为工厂**（`__tests__/helpers/executor-service.factory.ts`），工厂内部**具名对象装配**，消除 `{} as never` 静默错位；③ `ExecutorService` 构造依赖 **21 → ≤ 8**；④ 新 `ExecutorDispatchService` 构造依赖 **≤ 13** 且**不含任何 token 缓存相关依赖**；⑤ **golden 测试**：对同一批场景，新旧两条路径产出的「候选顺序 / 失败出口 / 决策日志」**逐字段相等** |
| **2.3 模块环拆除（Q3 方案 B）** | 新建 `apps/admin-api/src/common/crypto/crypto.module.ts`（`@Global()`）；`SecretsCryptoService` provider 归属移出 `TaskModule`；`executor.module.ts` 删 `forwardRef(() => TaskModule)`；`task.module.ts` 删 `forwardRef(() => ExecutorModule)`；`executor.service.ts:728` 去掉 `@Inject(forwardRef(...))`；`task.processor.ts:103` 去掉 `@Inject(forwardRef(() => ExecutorService))` | ① `executor.module.ts` 与 `task.module.ts` **不再有 forwardRef**；② `grep -c forwardRef` 在两模块 = **0**；③ e2e bootstrap **两种装配顺序**（task 先 / executor 先）均能启动（补一条 e2e 用例钉住）；④ `executor.service.spec.ts` / `task.processor.spec.ts` 全绿 |

**阶段 2 验收**：新增/改动的单测全绿；**e2e 回归**（`apps/admin-api` 的 e2e 套件 + `scripts/qa05-callback-tier-selftest.mjs` + `scripts/nginx-sse-selftest.mjs`）全绿。

---

### 阶段 3：收口与清理

| 项 | 文件 | 验收判据 |
|---|---|---|
| **3.1 协议层扩展：failureClassification 段** | `packages/executor-protocol/protocol.json` 新增 `failureClassification` 段（各 reason 的判据向量，含中英双语形态）；node `prepareFailureReason` / python `_refine_failure_reason` / admin `classify-failure` **三端加载同一份向量断言** | ① 三端 spec 加载同一份 `protocol.json` 断言（与现有 `params` 段同款模式）；② 现有 `packages/executor-protocol/protocol.json` 的 `$schemaVersion` **是否 bump 需评估**——分类判据**不新增线缆字段**，按 README 纪律「不 bump」；③ node/python 侧分类器**移除各自抄写的正则**，改从协议常量派生 |
| **3.2 `TaskConfig` ↔ 派发白名单机器对账** | `dispatch-task-payload.util.ts` 的 `DISPATCH_TASK_FIELD_WHITELIST` 增加与 `protocol.json` 的**对账 spec**（`dispatch-task-payload.util.spec.ts` 增 describe） | ① `DISPATCH_TASK_FIELD_WHITELIST` ⊆ `protocol.schemas.TaskConfig.properties`（**每个字段必须在协议里有声明**）；② `packageUrl` 作为协议外的**解析注入字段**显式白名单豁免（带注释）；③ 协议新增执行器必读字段时，**对账 spec 变红**（强制同步） |
| **3.3 同分候选环形轮转 + 亲和权重化** | `dispatch-decision.ts` 的 tie-break 从「sort 稳定 → 取首」改为「同分组内 ringOffset 轮转」（借鉴 Hatchet）；affinity 从硬过滤改为**可选权重**（借鉴 k8s 软亲和） | ① 新增单测：N 个同分候选 + 连续 M 次决策 → **选中分布均匀**（不全落第一台）；② 亲和权重化**默认关闭**（保持现有硬过滤行为），灰度开关可回退 |
| **3.4 清理遗留** | 删除 `executor.service.ts` 中已迁出的方法；`executor.service.spec.ts`（10391 行）按新 service 拆分；`control-plane-mocks.ts` 的 `ExecutorServiceMockKeys` 扩充 | ① `executor.service.ts` 行数 **8488 → ≤ 3500**；② 迁移后的死代码零残留（`codegraph query` 确认无孤立符号）；③ 全部 spec 绿 |

---

## §6 风险清单 + 回滚方案

### 6.1 风险清单

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R-01 | **纯决策器重构后派发顺序变化** → 任务落到不同执行器，可能触发「解释器现场下载」「部署归属不符」等用户可感知差异 | 中 | 高 | ① 阶段 2.1 采用**逐分支搬迁**（不做逻辑改写）；② golden 测试逐字段比对旧新决策输出；③ **决策日志比对**：灰度期同时跑新旧两条决策链，输出 `dispatch.decision` 双份，**用日志对账而非测试断言**兜底 |
| R-02 | **`selectLeastLoaded` 补 affinity 后，部署选机结果变化** → 应用部署到不同执行器 | 中 | 中 | ① 该改动**单独成 PR**，不与决策器重构混做；② 加 feature flag `executor.selection.affinityEnabled`（默认 `false` → 行为不变）；③ 灰度期对比日志 |
| R-03 | **拆 class 后 53 处 DI 覆盖失效** → provider 缺失 → 运行时 `undefined` 调用 | 低（若走兼容门面）| 高 | ① **阶段 2.2 强制走「兼容门面」路线**，`ExecutorService` 签名与 export 不变 → 53 处零改动；② 加一条**守卫脚本**：扫描所有 `provide: ExecutorService` 的 `useValue` 键集，断言 ⊆ 门面暴露的方法集 |
| R-04 | **`new ExecutorService(...)` 位置装配迁移时静默错位** → `{} as never` 骗过类型检查 | 中 | 高 | ① 迁移**必须用工厂**（具名对象），禁止继续用位置参数；② 迁移后每个 spec **保留至少一条 golden 断言**（如「注册后 repo.update 被调用且参数正确」）；③ 加 lint 规则：**禁止** `new ExecutorService(` 出现在 spec 中（工厂是唯一入口） |
| R-05 | **模块环拆除后 bootstrap 顺序问题复发** | 低 | 高 | ① e2e 加**两种装配顺序**的启动用例（当前只有一种）；② `SecretsCryptoService` 做成 `@Global()` → 与模块加载顺序完全解耦；③ 拆除前先跑现有 e2e 取得基线 |
| R-06 | **分类链收敛改变既有归因** → 某些失败从「可重试」变「不可重试」或反之 | 中 | 中 | ① 表驱动单测**先固化现状**（含现有不一致的用例），再逐条对齐；② 对**归因桶变化**逐条评审（尤其 `PACKAGE_FETCH` 补齐后从 `UNKNOWN`→`PACKAGE_FETCH_FAILED` = **不可重试** → 会缩短重试链，需确认这是期望）；③ 保留**旧正则**在一个 release 周期做双跑对比 |
| R-07 | **中台自产失败码化后，执行器侧上报的失败仍走正则** → 两路语义不一致 | 低 | 中 | ① 码化只覆盖**中台自产**失败；执行器上报路径已有 `cb.failureReason` 结构化通道（`task.service.ts:1078` 的 `cb.failureReason ?? ...` 纪律）；② 明确在文档中写「正则只服务旧执行器/包装异常」 |
| R-08 | **阶段 3 的协议扩展需三端（TS/Python/TS）同步改** → 跨语言发版不同步 | 中 | 中 | ① 严格按 `packages/executor-protocol` 的「一份 JSON + N 端断言」模式；② 判据**不 bump 协议版本**（README 明示：「两者都是执行器侧校验面……不需要中台做分支」）；③ 灰度期允许旧执行器行为 |
| R-09 | **决策日志 schema 化后，历史日志无法解析**（新查询工具） | 低 | 低 | ① schema 变更**只加字段不删不改**；② 老字段保留 ≥ 1 个发布周期 |

### 6.2 回滚方案（三选一 / 组合）

| 手段 | 适用阶段 | 具体做法 | 回滚耗时 |
|---|---|---|---|
| **git revert** | 阶段 2.2 / 2.3（class 拆分、模块环拆除） | 单 PR 单主题，`git revert <sha>` 即回滚。**前提**：这两次改动**不涉及 DB 迁移**（纯代码结构）→ revert 后数据面无残留 | 分钟级 |
| **feature flag** | 阶段 1.3（`selectLeastLoaded` 补 affinity）、阶段 3.3（同分轮转、亲和权重化）、阶段 2.1（决策器灰度） | 新增配置项（`executor.<feature>` 形态，与既有 `executor.preferDeployedExecutor` 同款），默认关闭 → 行为不变；灰度期逐实例打开 | 秒级（改配置 + 重启） |
| **双写对账** | 阶段 2.1（纯决策器） | 新旧决策链**并行计算**，但**只有旧链生效**；`dispatch.decision` 日志同时输出两份（旧链 `decision.v1`、新链 `decision.v2`），用**日志对账**比对新旧结果差异；差异率连续 N 分钟为 0 → 切换生效；异常时**只关 flag** 即回到旧链 | 实时（flag 秒级） |
| **组合（推荐）** | 阶段 2.1 | **双写对账 + feature flag**：新链影子运行 → 日志对账 → flag 切换 → 保留旧链一个发布周期 → 清理 | — |

**明确不采用的做法**：❌ 不引入 DB 迁移来「重构派发」（避免数据面回滚复杂度）；❌ 不在同一次发布里同时做「分类链收敛 + 决策器重构 + class 拆分」（三者叠加会让归因变化与派发变化互相掩盖，事故定位成本爆炸）。

---

## §7 测试计划

### 7.1 必跑既有 spec（回归基线）

**executor 域（34 个 spec 文件，`apps/admin-api/src/modules/executor/__tests__/`）**——**全跑**：

| 优先级 | 文件 | 覆盖内容 |
|---|---|---|
| P0 | `executor.service.spec.ts`（10391 行，433 个 describe/it） | register / heartbeat / dispatch / dispatchBroadcast / rotateToken / validateTokenByAddress / cleanup* / markOffline 全覆盖。**含 `describe("dispatch")`（:3402）与 `describe("dispatchBroadcast")`（:3690）与 `describe("pinned executor")`（:3605）** |
| P0 | `executor.mutex-claim.spec.ts` | 互斥组占坑（`claimExecutorSlotForExecution` 的事务路径） |
| P0 | `executor.dispatch-estimated.spec.ts` | 估时索引 + 评分 |
| P0 | `executor.interpreters.spec.ts` | 解释器过滤 + 缓存分区 |
| P0 | `executor.service.security.spec.ts` | SSRF / 载荷 / `dispatchAndCaptureBody` |
| P0 | `executor.version-follow-device-fact.spec.ts` | 版本跟随 |
| P0 | `executor.app-version-report.spec.ts` | `applyReportedAppVersions` |
| P0 | `executor.register-takeover-cas.spec.ts` / `executor.register-address-identity.spec.ts` / `executor-stale-snapshot-write.spec.ts` | 注册 / 接管 CAS / 快照写 |
| P0 | `executor.heartbeat-conflict-selfreport.spec.ts` / `executor.heartbeat-identity.spec.ts` / `executor.heartbeat-task-sandbox.spec.ts` | 心跳 |
| P1 | `executor-deployment-affinity.util.spec.ts` / `executor-score.util.spec.ts` / `interpreter-match.util.spec.ts` / `dispatch-params-keys.util.spec.ts` / `dispatch-task-payload.util.spec.ts` | 纯 util（重构后应**原样通过**） |
| P1 | `executor.controller*.spec.ts`（4 个）/ `executor-pull.service.spec.ts` / `token-cache-sync.service.spec.ts` / `executor-terminal-states.spec.ts` / `protocol-version-consistency.spec.ts` | controller / pull / 令牌 / 协议 |

**task 域（P0）**：`task.processor.spec.ts`（含 `:313` 解释器规则、`:343` pinned 离线中文化回归）、`python-multiversion-write-path.spec.ts`（含 `:958-1003` 用**错误码表渲染真实文案**断言 pinned 离线分类）、`execution-attempt-seq*.spec.ts`、`task.service.spec.ts`、`task.service.broadcast-mutex.spec.ts`、`execution-callback.controller.spec.ts`

**其他域（P1，受影响面）**：`scheduler.service.spec.ts` + `scheduler.service.finalization-guard.spec.ts`（占坑释放/重试）、`app-deployment.*.spec.ts`（9 个，`selectLeastLoaded` 消费方）、`application.service.spec.ts`、`sop.controller.spec.ts`、`sop-media.path-endpoint.contract.spec.ts`、`executor-package.controller.spec.ts`、`tool-executor.service.spec.ts`、`control-plane-mocks` 消费方

**执行器端（P1，协议相关）**：node `executor-protocol-contract.spec.ts` + `param-env.spec.ts`；python `test_executor_protocol_contract.py` + `test_param_env.py` + `test_interpreter_failure.py`

### 7.2 新增用例

| 新用例 | 文件 | 断言 |
|---|---|---|
| **N-1 纯决策器表驱动** | `dispatch/dispatch-decision.spec.ts` | 六维过滤（group/tags/affinity/anti-affinity/runtime/interpreter）× 三模式（single/broadcast/selection）× {有/无 runtimeVersion} × {有/无部署上下文} → **候选顺序与失败出口类型**全覆盖。**≥ 60 条用例** |
| **N-2 决策器纯度守卫** | 同上 + lint 规则 | `decideDispatch` 不引用 `Date.now` / `Math.random` / `this` / 任何 IO；输入相同时输出**逐字段相等**（可用 `Object.freeze` 输入 + 多次调用比对） |
| **N-3 分类链一致性** | `common/failure-classification/classify-failure.spec.ts` | **同一组 ≥ 25 条失败文案 × 两条路径（回调 `inferFailureReason` / 派发 `classifyFailure`）→ 归因必须完全一致**；含：英文/中文 timeout、pinned 离线（长 appName 变体）、解释器缺失（uv 原文 3 条）、沙箱不可用、应用缺失、包拉取失败、模块找不到、脚本错误 |
| **N-4 码化优先** | 同上 | 传入 `errorCode: "PINNED_EXECUTOR_OFFLINE"` → **无条件** `EXECUTOR_OFFLINE`；用**超长 appName（>120 字符）**构造文案 → 仍归 `EXECUTOR_OFFLINE`（证明与文案长度解耦） |
| **N-5 过滤链三模式一致** | `executor-filters.util.spec.ts` | single/broadcast/selection 三模式对**同一输入**的过滤结果**显式断言差异**（broadcast 亲和=收窄、selection 亲和=与 single 一致）——**把语义差异钉成测试而非注释** |
| **N-6 golden 决策比对** | `dispatch/dispatch-decision.golden.spec.ts` | 旧 `dispatch()` 决策输出 vs 新 `decideDispatch()` 输出，在 **20 个真实场景**上**逐字段相等**（候选 id 序列 / 失败出口 / 决策日志字段） |
| **N-7 工厂装配守卫** | `__tests__/helpers/executor-service.factory.spec.ts` + lint | 断言**全仓无** `new ExecutorService(` 出现在 spec 中（除工厂文件自身）；断言所有 `provide: ExecutorService` 的 `useValue` 键集 ⊆ 门面方法集 |
| **N-8 模块环守卫** | `executor.module.spec.ts` / 新增 e2e | ① 静态断言 `executor.module.ts` / `task.module.ts` **无 `forwardRef`**；② e2e：**两种模块装配顺序**均能启动 |
| **N-9 决策日志 schema** | `dispatch-decision-log.schema.spec.ts` | 三派发面输出**同一字段集**；schema 校验对畸形输入抛错 |
| **N-10 协议对账** | `dispatch-task-payload.util.spec.ts`（新增 describe） | `DISPATCH_TASK_FIELD_WHITELIST` 每个字段 ∈ `protocol.schemas.TaskConfig.properties`；`packageUrl` 显式豁免 |
| **N-11 同分轮转** | `dispatch-decision.spec.ts` | N 个同分候选 + 连续 M 次决策 → 选中**分布均匀**（不全落第一台） |
| **N-12 互斥组双计数（若采纳）** | `executor.mutex-claim.spec.ts`（新增 describe） | 组内「在跑 + 在等 ≤ maxConcurrentPerDevice」约束生效 |

### 7.3 回归面（受影响的非本域）

- **admin-web**：`apps/admin-web/src/locales/generated/error-codes.{en,zh}.ts`（错误码文案表，**由 `catalog/executor.ts` 生成** → 分类/码变更需重新生成）；`apps/admin-web/src/utils/error.ts`（`getErrMsg` 回落链）
- **CLI / MCP**：`packages/mcp-server` / `packages/acf-cli` 消费 `errorCode` 字段 → 码变更需确认 `check-consumer-routes.mjs` 守卫
- **执行器端**：`apps/executor-node/src/callback.ts:57`（`CallbackFailureReason` 列表）、`apps/executor-node/src/generated/protocol.schemas.ts:127`（生成的 zod 枚举）→ 协议变更需跑生成器

---

## §8 待主 Agent 决策项

| # | 决策项 | 选项 | 我的倾向 | 影响面 |
|---|---|---|---|---|
| **D-1** | **互斥组占位是否应计入「排队中的执行」**（Airflow Pool 双计数） | (a) 维持现状：只数 `status='running'`；(b) 采纳双计数：「在跑 + 在等 ≤ 组并发数」 | 倾向 (b)，但**需业务确认**——(a) 的现状允许「组并发数=1 时，10 个任务全部占位成功后再排队」，(b) 会把第 2 个就挡住 | `executor.service.ts:5002-5015`；影响所有挂互斥组的应用 |
| **D-2** | **pinned 执行器不可用时是否提供「降级到全机队」选项**（Temporal sticky 降级） | (a) 维持现状（pinned 离线 = 硬失败，不换机，这是 pinning 的语义本质）；(b) 增加任务级/全局可选降级开关 | 倾向 (a) 为主 + (b) 作为**默认关闭**的可选开关（新增能力不改变现有语义） | `executor.service.ts:5165-5222`；影响所有 pinned 任务 |
| **D-3** | **`selectLeastLoaded` 补 affinity/anti-affinity 是否会改变应用部署选机结果** | (a) 直接补（可能改变行为）；(b) 加 flag 默认关闭逐步灰度 | 倾向 (b)——**行为变更必须显式**，不能默默改变部署结果 | `app-deployment.service.ts:1333` → `executor.service.ts:4607` |
| **D-4** | **同分候选是否引入环形轮转**（Hatchet） | (a) 引入（负载更均，但同一任务的重试可能落到不同机器）；(b) 维持「稳定排序取首」（同分恒取第一台） | 倾向 (a) 但**默认关闭**；需确认「同一执行的重试应否回原机器」的语义 | `dispatch-decision.ts` 的 tie-break；影响派发分布 |
| **D-5** | **亲和从「硬过滤」改为「软权重」的优先级** | (a) 保持硬过滤；(b) 改为 k8s 式软亲和（硬约束与软偏好分离） | 倾向 (b) **在阶段 3 推进**，默认关闭；这会**显著简化** `dispatch()` 的分支（硬过滤从 6 维降到 2 维） | 阶段 3.3；影响全部候选筛选 |
| **D-6** | **是否在 `protocol.json` 新增 `failureClassification` 段**（阶段 3.1） | (a) 加（三端统一判据源）；(b) 不加（admin 侧内部收敛即可） | 倾向 (a)——但需确认 node/python 的**发版节奏**是否允许同步改（跨语言三方协同成本高） | `packages/executor-protocol/protocol.json` + 4 个 spec |
| **D-7** | **孙 Agent 缺失的补偿措施** | (a) 接受本 Agent 自查（报告已附源码级证据）；(b) 主 Agent 或另一 Agent 对 §4 独立复核后再放行 | 倾向 (b)——§4 的取舍会影响**长期架构方向**，值得一次独立复核 | 仅 §4 |
| **D-8** | **阶段 2.2（拆 class）的排期优先级** | (a) 阶段 2 内一次做完；(b) 只做 2.1（纯决策器），2.2 推迟到下个迭代 | 倾向 (a)，但**必须走兼容门面 + 工厂迁移**两条降级路径；否则 (b) 是更稳的选择 | `ExecutorService` 184 符号 / 69 文件 / 53 处 DI 覆盖 |
| **D-9** | **是否允许 `ExecutorService` 文件名保留** | (a) 保留 `executor.service.ts` 作为门面（推荐，零外部影响）；(b) 改名并同步改 53 处 DI | 强烈倾向 (a) | 69 个引用文件 |

---

## 附录 A：CodeGraph 探查命令清单（可复现）

```bash
cd /home/yongsheng/project/AutoCodeFlow
/home/yongsheng/.local/bin/codegraph status
/home/yongsheng/.local/bin/codegraph node apps/admin-api/src/modules/executor/executor.service.ts --symbols-only
/home/yongsheng/.local/bin/codegraph node apps/admin-api/src/modules/executor/executor.service.ts --offset 5146 --limit 620
/home/yongsheng/.local/bin/codegraph impact ExecutorService -d 3
/home/yongsheng/.local/bin/codegraph impact "ExecutorService::dispatch" -d 3
/home/yongsheng/.local/bin/codegraph impact "ExecutorService::register" -d 3
/home/yongsheng/.local/bin/codegraph impact "ExecutorService::heartbeat" -d 3
/home/yongsheng/.local/bin/codegraph impact claimExecutorSlotForExecution -d 2
/home/yongsheng/.local/bin/codegraph impact findFleetCandidates -d 2
/home/yongsheng/.local/bin/codegraph impact selectLeastLoaded -d 2
/home/yongsheng/.local/bin/codegraph impact dispatchBroadcast -d 2
/home/yongsheng/.local/bin/codegraph callers dispatch
/home/yongsheng/.local/bin/codegraph node apps/admin-api/src/modules/task/task.processor.ts --symbols-only
/home/yongsheng/.local/bin/codegraph node apps/admin-api/src/modules/task/task.service.ts --symbols-only
```

## 附录 B：关键量化数据速查

| 指标 | 值 | 来源 |
|---|---|---|
| `executor.service.ts` 行数 / 符号数 | **8488 / 184** | CodeGraph |
| 被引用文件数 | **69** | CodeGraph `node` 头部 |
| `impact ExecutorService -d 3` | **150 符号** | CodeGraph |
| `impact ExecutorService::dispatch -d 3` | **29 符号** | CodeGraph |
| 构造参数总数 / `@Optional()` 数 | **21 / 11**（必需 9 + forwardRef 1 + Optional 11） | 源码核对 `:712-842` |
| `new ExecutorService(` 位置装配点 | **11 处**（其中 6 处为完整位置装配） | grep |
| `provide: ExecutorService` DI 覆盖 | **53 处** | grep |
| `dispatch()` 行数 / if / await / throw | **613 / 37 / 14 / 9** | 脚本统计 |
| `dispatchBroadcast()` | 253 行 / if 22 | 脚本统计 |
| `task.service.ts::handleCallback` | 656 行 / if 30 | 脚本统计 |
| 派发过滤链三处重复 | **~140 行** | 源码核对 |
| 失败分类判据份数（admin 2 + node 1 + python 1） | **4 处主链 + 4 条内联正则** | grep |
| `protocol.json` 顶层段 | 9 段（`versioning`/`readiness`/`timeout`/`failureReason`/`secrets`/`params`/`envForward`/`schemas`/`schemaVectors`） | 源码 |
| `dispatch()` 纯决策面占比 | **~200 行 / 37 个 if 中的 ~25 个** | 本报告 §3-Q1 切缝表 |
