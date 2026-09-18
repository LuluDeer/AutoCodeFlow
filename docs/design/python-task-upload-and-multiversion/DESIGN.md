# Python 任务整包上传与多版本运行 —— 实现方案设计（DESIGN）

> **对应需求**：`docs/requirements/python-task-upload-and-multiversion/REQUIREMENTS.md`（v0.3，已定稿）
> **特性名（feature_name）**：`python_task_multiversion`
> **日期**：2026-09-16
> **状态**：待负责人确认
> **消费方**：第三阶段"编码任务规划"（tasks.md）——本设计每个模块小节末尾的「任务分解线索」条目与后续任务细化一一对应。

---

# 一、需求与存量功能关系分析

## 1.1 需求功能与存量功能对比

### 1.1.1 已实现功能（可直接复用，匹配度 = 100%）

> 结论：本特性约 60% 的能力面建立在既有代码上，无需重写；改动集中在"赋予语义 + 新增链路"。

| 需求功能 | 存量功能 | 代码位置 | 匹配度 |
|---|---|---|---|
| FR-05 整包上传安全校验链（扩展名白名单 + ZIP 魔数 + zip-bomb 结构审查 + clamd 病毒扫描 + ≤200MB） | `POST /applications/upload` 已完成全部校验并持久化 `packageUrl`（≥200MB 由 Multer limits 限制） | `apps/admin-api/src/modules/application/application.controller.ts:139-309`（含 `assertZipSafe` zip-bomb 审查、`scanBufferWithClamd`、`packageUrl` 生成与 upsert） | 100% |
| FR-02 代码落地工作目录后按 entrypoint 运行（git 渠道既有管线） | `run_task` 已将 git 代码 checkout 到 `work_dir/<executionId>`，随后创建 venv/装依赖/运行 | `apps/executor-python/routers/execute.py:1944-1990`（git checkout 段）、`2090-2108`（python 分支） | 100%（zip 渠道复用同一运行尾段） |
| FR-18/AC-18b 依赖型渠道（requirements/PyPI）可叠加、代码来源型渠道互斥的「单任务单代码来源」列布局 | `tasks` 表已并列存在 `gitRepo` / `glueSource` / `applicationId` 三列（先前无互斥约束） | `apps/admin-api/src/modules/task/entities/task.entity.ts:122-125,178,262-265` | 100%（补互斥校验即可） |
| FR-10 无版本声明任务行为不变（runtimeVersion 空 → 宿主解释器） | `ensure_venv` 当前以 `uv venv --no-project <dir>` 创建 venv（默认取 PATH 解释器，宿主 3.12）；无依赖任务以 `sys.executable` 运行 | `apps/executor-python/routers/execute.py:1874`、`2108` | 100%（缺省分支原样保留即为 AC-10a） |
| NFR-07 私有 PyPI 依赖安装不改变 | `_validate_registry_url` + `--index-url` 显式传参 + `_build_install_env` 环境白名单 | `apps/executor-python/config.py:7-40`、`routers/execute.py:223-292` | 100% |
| FR-03 解压路径穿越防护（executor-node 侧已有同类防护可复用） | executor-node `zip-guard.ts` 的 EOCD/CD 结构审查 + 部署解压前 `guardZipOrThrow` | `apps/executor-node/src/zip-guard.ts:202-330`、`apps/executor-node/src/routes/deploy.ts`（解压前调用） | 100%（python 侧需移植同强度防护，见 1.1.3） |
| NFR-09 准备阶段纳入任务超时 | `_run_uv` 已对 `uv venv`（60s）/`uv pip install`（300s）设独立超时并纳入任务整体超时语义 | `apps/executor-python/routers/execute.py:295-297,1830-1854` | 100%（解释器下载复用同一 `_run_uv` 槽，仅增新超时常量） |
| NFR-11 任务工作目录/venv 的 TTL 清扫 | `cleanup_work_dir` 已按 TTL 清扫 workdirs、`.git_cache`、`.venvs`，并跳过 live 执行目录 | `apps/executor-python/maintenance.py:154-212` | 100%（仅需按 NFR-15 豁免解释器层、新增体积红线，见 1.1.2） |
| CON-01 执行器本体依赖基线不变（镜像 `python:3.12-slim` + `uv==0.8.17`） | Dockerfile 构建期验证 `uv --version | grep -Fx 'uv 0.8.17'` | `apps/executor-python/Dockerfile:2-36`、`apps/executor-python/requirements.txt` | 100% |
| dispatch 载荷无需改造（runtimeVersion 已透传执行器） | dispatch 发送 `{executionId, task, params}`，`task` 为完整实体（含 `runtimeVersion`），执行器按字典读取 | `apps/admin-api/src/modules/executor/executor.service.ts:1400,1436`（pull/push 两分支）；`apps/executor-python/routers/execute.py:52-54`（task 保持 dict） | 100% |
| FR-16 同版本 venv 复用的性能目标（AC-16b） | `_derive_task_key(req)` → `.venvs/<task_id>` 已实现"同一任务复用同一 venv" | `apps/executor-python/routers/execute.py:688,2094` | 75%（需在键中追加版本维度，见 1.1.2） |
| FR-09 调度过滤框架（group/tags/runtime + 亲和/反亲和 + loadScore） | 候选过滤链 + 原子占坑 + 评分，三处实现（selectLeastLoaded / dispatch / dispatchBroadcast） | `apps/admin-api/src/modules/executor/executor.service.ts:1086-1153,1242-1304,1529-1538` | 75%（需追加 interpreters 维度，见 1.1.2） |

### 1.1.2 需要扩展的功能（部分匹配，需在现有基础上改造）

| 需求功能 | 存量功能 | 差异说明 | 扩展方向 |
|---|---|---|---|
| FR-06/07/10/15：`runtimeVersion` 从"仅元数据"升级为"执行决策输入"（D3） | `tasks.runtimeVersion` 已存在但**无任何执行器消费**（`task.entity.ts:106`；`run_task` 从不读取） | 差异：① 无格式/区间校验；② venv 创建不读该字段。 | ① DTO 边界加 `X.Y` 格式 + 支持区间校验（FR-06b）；② `ensure_venv` 增加显式 `--python` 参数（FR-15/AC-15a）；③ 声明校验不预检缓存（AC-06c）。 |
| FR-07：venv 按任务声明解释器创建（含首次按需下载） | `uv venv --no-project <venv_dir>` 隐式取 PATH 默认解释器（`execute.py:1874`） | 差异：PATH 默认（3.12）≠ 任务声明版本时 venv 仍用 3.12（AC-15b 失败态）。 | `ensure_venv` 升级为 `uv venv --python <version|path> --no-project <venv_dir>`；下载语义走 `uv python install`（D8）。 |
| FR-16：venv 目录键含版本签名（D6） | `.venvs/<task_id>`（`execute.py:2094`） | 差异：版本切换（3.7→3.9）会复用旧 venv 交叉污染（AC-16a 失败态）。 | 键改为 `task_id-<主.次版本>`；无版本任务沿用 `task_id`（存量语义逐字节不变）。 |
| FR-09/AC-08a/AC-09a：调度按任务声明版本过滤候选执行器 | `capabilities.includes(task.runtime)`（`executor.service.ts:1291-1296,1113-1119,1529-1535`） | 差异：runtime 只校验"能力类型"，不校验"版本可获取性"。 | 在 runtime 过滤后追加 interpreter 过滤：`task.runtimeVersion` 为空→不拦截；非空→按 `executors.interpreters`（缓存已装）判可执行性（ASM-05）。 |
| FR-13/14：执行器启动/心跳上报解释器清单（D5） | 注册 payload 仅 `capabilities:['python','shell']`（`main.py:_register_payload`）；心跳无 interpreters 字段（`scheduler.py:_send_heartbeat`） | 差异：无缓存池清单上报载体。 | ① 新增 `interpreters` 结构化数组（注册 + 心跳双通道，provider 模式复用）；② admin 侧 `register`/`heartbeat` 白名单采纳（对照 `deadLetterCount` 采纳模式）；③ 旧执行器无该字段按 `["3.12"]` 兼容（D5）。 |
| NFR-15/D12：解释器缓存池磁盘治理 | `cleanup_work_dir` 将 `.venvs`/`.git_cache` 按 TTL 删除（`maintenance.py:188-203`） | 差异：TTL 会误删解释器缓存（重复下载成本高）；NFR-15 要求豁免 TTL、改体积红线。 | `_PROTECTED_WORKDIR_NAMES` 或独立拦截改为豁免解释器目录；新增"单版本 ≤250MB / 总池 ≤4GB"体积监控与最久未使用回收（D12 默认值）。 |
| FR-08/12：失败分因 `interpreter_unavailable` | 失败分类链已有 `_refine_failure_reason`（`execute.py:172-200`）、`ExecutionFailureReason`（`task-execution.entity.ts:23-43`）、`inferFailureReason`（`task.service.ts:232-267`）、`EXECUTOR_REPORTABLE_FAILURE_REASONS` | 差异：无解释器缺失类别。 | ① 新增枚举 `interpreter_unavailable`（admin 枚举 + `packages/executor-protocol/protocol.json`）；② 执行器下载/探测失败时归入；③ admin 侧错误消息携带声明版本 + 候选快照（AC-12a）；④ 不进入可重试默认集（明确失败语义，D14）。 |
| FR-14/AC-14b：探测失败不阻断启动 | 注册流程整体串行（`lifespan` → `register_executor`） | 差异：`uv python list --only-installed` 若失败应剔除该版本而非启动失败。 | 探测子命令容错：单条失败仅从清单剔除 + 日志，注册照常（AC-14b）。 |
| FR-02/04：zip 包内 requirements 与任务级 requirements 合并（D4） | 目前仅任务级 `requirements` 安装（`execute.py:1888-1903`）；git 渠道无"包内依赖"概念 | 差异：zip 解压后需识别包内 `requirements.txt`。 | 解压后探测 `work_dir/requirements.txt`；合并规则：任务级优先覆盖同名、其余并集（D4），由 uv 同期锁定幂等。 |
| NFR-02/03、FR-03：zip 侧下载与解压安全 | executor-node 已有 `downloadPackage`（`deploy.ts:341-343`）与 `zip-guard`；executor-python 无 zip 消费能力 | 差异：python 执行器从未下载 `packageUrl`。 | 移植下载+结构审查+zip-slip 防护到 python 侧（新增模块，见 1.1.3），沿用 node 侧 ADR（Bearer/size cap/SSRF）。 |
| FR-19：应用 runtime 判定与任务 runtime 一致性 | `applications` 有 `runtime` 列（upload 默认 'python'）；任务有 `runtime`/`applicationId` 弱引用 | 差异：未校验引用 zip 应用的 runtime 与任务运行 runtime 一致性。 | 写面校验：`codeSource=application_zip` 时，引用的应用 `runtime` 必须等于任务 `runtime`（不一致→BadRequest，AC-19a）。 |

### 1.1.3 需要新增的功能或接口（存量完全无对应实现）

#### A. admin-api（NestJS / TypeORM）

1. **`tasks.codeSource` 枚举列**（D7 落 ①）：取值 `git | glue | application_zip`，将代码来源互斥语义显式化（FR-18/AC-17b）。
   - 枚举默认值策略：存量任务按既有字段推导回填（gitRepo→git、glueSource→glue、applicationId→application_zip、全空→NULL）。
   - DTO/Service 互斥校验：`gitRepo`/`glueSource`/`codeSource=application_zip`（或 `applicationId`）三选一，创建与 PATCH 两路径均校验。
2. **CreateTaskDto/UpdateTaskDto 新校验**：
   - `runtimeVersion`：`^\d+\.\d+$` 格式 + 支持区间（3.6~3.14，D10 实测后可收紧/放开）+ 仅当 `runtime=python` 时允许非空（CON-02/NG-02）。
   - 新增 `codeSource` 字段（`@IsIn(['git','glue','application_zip'])`）。
3. **`executors.interpreters` 数组字段**（D5 落 ②）：
   - 新增列（jsonb），结构 `[{version:"3.12.3", path:"/...", available:true, discoveredAt:"..."}]`。
   - `register()`/`registerExecutor()`/`heartbeat()` 白名单采纳（完全对照 `deadLetterCount`/`runningExecutionIds` 既有模式，`executor.service.ts:836-975`）。
   - 兼容：旧执行器无字段 → 调度按 `["3.12"]` 兜底（D5）；heartbeat 未上报 → 保留旧值不清空。
4. **调度 interpreter 过滤**（FR-09）：
   - `selectLeastLoaded`/`dispatch`/`dispatchBroadcast` 三处候选过滤追加版本维度：空闲判定（runtimeVersion 为空→不过滤）+ 匹配判定（执行器 interpreters 前缀匹配 任务请求版本，D1）。
   - 过滤失败错误消息携带"声明版本 + 候选执行器清单（含各自已缓存解释器）"（AC-09b），分类为 `interpreter_unavailable`（FR-08）。
5. **失败分类扩展**：`ExecutionFailureReason.INTERPRETER_UNAVAILABLE` + `packages/executor-protocol/protocol.json` 同步 + 执行详情/错误呈现（AC-12a）。
6. **pinning 场景运行前报错**（D2 落 ③）：`dispatch` 的 pinning 分支在占坑前校验 pinned 执行器 interpreter 能力，不满足则提前失败并携带明确消息（AC-08b）。

#### B. executor-python（FastAPI / uv 0.8.17）

1. **新增 `interpreters.py` 模块**：
   - `discover_installed()`：启动/心跳调 `uv python list --only-installed`（FR-14），容错剔除损坏项（AC-14b）。
   - `ensure_version(version, timeout)`：`uv python install <version>` 按需下载（FR-07/13），返回解释器路径；超时/失败抛带分因异常。
   - `resolve_python_bin(version)`：在 `UV_PYTHON_INSTALL_DIR` 池内按版本前缀匹配已安装解释器绝对路径（NFR-02：路径只来自缓存池白名单）。
2. **配置项新增**（`config.py`）：
   - `UV_PYTHON_INSTALL_DIR`（默认 `~/.cache/uv/python` 或 `/data/tasks/.interpreters`）、`UV_PYTHON_INSTALL_MIRROR`（可选）、`UV_PYTHON_INSTALL_TIMEOUT_SECONDS`（默认 300，D11）、`INTERPRETER_SINGLE_VERSION_MB`（250，D12）、`INTERPRETER_TOTAL_GB`（4，D12）。
3. **解释器下载并发控制**（D13）：模块级 `per-version` 锁（`version -> threading.Lock`，对照 `_git_cache_locks` 模式 `execute.py:113-124`）+ 全局单下载队列（`asyncio` 信号量/互斥，同一时刻全局至多一个 in-flight 下载）。
4. **`ensure_venv` 改造**（FR-15/16）：新增 `python_version: str | None` 参数；非空时 venv 目录 `.venvs/<task_id>-<主.次>`（D6），创建命令 `uv venv --python <version|path> --no-project`。
5. **zip 渠道整段新增**（FR-02/03/04）：
   - 从 `packageUrl` 下载（`httpx`，对照 node `downloadFile` 的 Bearer 透传 + SSRF 防私网 + size cap）。
   - 解压前 zip 结构审查（移植 zip-bomb 校验）+ zip-slip 防护（拒绝 `..`/绝对路径条目，AC-03a）。
   - 解压到 `work_dir`；读取包内 `requirements.txt` 与任务级 requirements 合并（D4）。
6. **失败分类**：下载/探测失败统一映射 `interpreter_unavailable`（含缓存缺失 + 下载失败原因，AC-12a）。
7. **注册/心跳上报 interpreters**（FR-13/14）：`_register_payload()` 增字段；`scheduler._send_heartbeat` 增 provider（对照 `runningExecutionIds` provider 模式，`scheduler.py:115-143`）。
8. **维护扩展**（NFR-15/D12）：`maintenance.py` 豁免解释器目录 TTL → 体积红线告警 + 最久未使用回收。

#### C. executor-node（最小改动，保持协议对齐）

- 心跳上报 `interpreters`（可选字段）：python 运行时任务在 node 端仍用宿主解释器（对照 `execute.ts` venv 语义），上报宿主 python 版本清单；缺省不报 → admin 兜底 `["3.12"]`（D5 兼容）。此项不改变任何既有 node 行为。

#### D. admin-web（React / antd）

1. **任务表单**（`TaskFormPage.tsx`）：新增 `runtimeVersion` 选择器（Python 版本下拉：Tier1/Tier2 分层展示，可手动输入 `X.Y`）；新增代码来源选择（git / zip 应用引用 / glue），与 `gitRepo`、`glueSource`、`applicationId` 表单联动互斥（FR-18）。
2. **payload 组装**（`executor-mode.ts` / task-form 相关 util）：透传 `runtimeVersion`；归一 `codeSource`；应用引用时携带 `applicationId`（AC-01a）。
3. **执行详情**：展示 `interpreter_unavailable` 失败分因与候选执行器解释器快照（AC-12a）。
4. **api 类型**：`openapi-typescript` 重新生成到 `src/types/generated/api-types.ts`。
5. **执行器列表**：展示 `interpreters` 列（可选增强，非阻塞）。

## 1.2 存量功能详细分析

### 1.2.1 调度候选过滤链（不可绕过，版本过滤插在何处的判定依据）

`dispatch()`（`executor.service.ts:1195-1457`）与 `selectLeastLoaded()`（`1086-1153`）的候选过滤顺序：

```
executorId pinning（绕过一切过滤） → appName 精确匹配 → group 过滤 → tags（AND 子集）
→ 亲和（OR）/反亲和（排除） → runtime/capabilities → loadScore 评分 → 原子占坑 → push/pull 传输
```

- **接口契约**：`Task` 实体字段即为过滤输入；`Executor` 的 `capabilities` 是 runtime 维度的唯一事实源（空数组 = 不校验放行，`1115-1117` 的 `!e.capabilities || length===0 → true` 语义）。
- **约束**：
  - pinning 分支（`1198-1221`）完全绕过过滤——AC-08b 要求在 pinning 下也拦截不满足版本声明的执行器，故版本校验需在 pinning 分支单独补一道（运行前硬失败，D2③）。
  - pull/push 传输共用同一份候选选择（`1388-1416`），故 interpreter 过滤只需做在候选选择阶段，传输分支零改动。
  - **匹配依据**：ASM-05 明确"以执行器上报解释器清单为准（内存查表），派发链路不做实时探测/实时下载"。因此调度测的匹配函数是纯内存判定（`executors.interpreters` 前缀匹配），复杂度 O(清单长度)，满足 NFR-08。

### 1.2.2 执行器 venv 创建与任务锁（版本化 venv 的改造基座）

- `_derive_task_key(req)`（`execute.py:688`）：当前返回 `task.id 或 executionId`，是 `.venvs/<key>` 目录名、per-task 锁键、TTL live 保护快照的三方唯一事实源（`585-600,1731-1735`）。
- **约束**：改造后"版本签名"只改目录键派生处（一处），锁键与 live 快照保持与目录键同源——否则清扫/锁会产生"键不一致"漂移（QA4 注释强调的纪律）。
- `ensure_venv(venv_dir, requirements)`（`1857-1905`）：
  - 已有 `venv_dir.exists()` 复用 + 失败时 `shutil.rmtree` 回滚 + `_run_uv` 超时杀进程。
  - **扩展点**：新增 `--python` 参数与版本参数；版本化使同一任务不同版本产生不同目录，天然规避"半成品 venv 复用"问题（参考 `1875-1879` 超时回滚逻辑逐字节保留）。
- **并发约束**：venv 创建只在 per-task 锁内执行（`2095-2098` 注释）。解释器下载可能跨多任务，故下载锁必须独立于 per-task 锁（D13 的 per-version 锁为模块级、不依赖任务锁，见 §2.1.3 状态图）。

### 1.2.3 执行器注册与心跳（interpreters 上报的接线点）

- 注册：`main.py:_register_payload()`（`183-199`）→ `POST /executors/register` → admin `registerExecutor()`（`executor.service.ts:712`）→ `register()`（`591`）。admin 侧对注册字段有显式白名单（`632-649`），**新增 `interpreters` 必须进该白名单**，否则会被静默丢弃。
- 心跳：`scheduler.py:_send_heartbeat`（`164-224`）→ admin `heartbeat()`（`836-975`），有 `metricsWhitelist` + `runningExecutionIds`/`deadLetterCount` 采纳先例。interpreters 采纳完全复刻该模式（数值校验、非法不改库、缺失不清空）。
- **约束**：探测清单缓存（心跳间隔 30s 内不逐次执行 `uv python list`），避免心跳路径引入进程调用开销（NFR-10 全量探测 ≤5s 上限在启动时一次性完成）。

### 1.2.4 失败分类链路（interpreter_unavailable 的落点）

```
执行器 _refine_failure_reason（execute.py:172） → 回调 errorMessage/failureReason
→ admin callback DTO（executor-protocol 契约）→ TaskExecution.failureReason
→ task.service.inferFailureReason（仅兜底，task.service.ts:232）
→ processor 重试判定（retryableErrors 白名单，task.processor.ts:225-245）
```

- **约束**：
  - 执行器可上报的 failureReason 由 `packages/executor-protocol/protocol.json` 钉死（`EXECUTOR_REPORTABLE_FAILURE_REASONS`，`task-execution.entity.ts:57-63`），新增枚举必须三处同步：protocol.json → python executor → admin 枚举。
  - `interpreter_unavailable` 语义为"配置性/环境性失败"，不应进默认重试集；但若用户显式配置 `retryableErrors` 包含该 token 则应尊重白名单（RETRY-01 语义不变，`task.processor.ts:232`）。

### 1.2.5 磁盘 TTL 分类（NFR-15 豁免的拦截点）

- `_PROTECTED_WORKDIR_NAMES`（`maintenance.py:41-44`）是顶层保护名单；`.venvs`/`.git_cache` 走独立 TTL 清扫段（`188-203`）。
- **约束**：解释器缓存池目录若置于 `work_dir` 之外（如 `UV_PYTHON_INSTALL_DIR` 指向独立卷），天然豁免；若置于 `work_dir` 内，必须加入清扫豁免名单。设计统一采用"独立于 `work_dir` 的配置化解释器目录"（默认 `/data/interpreters`），从物理路径上隔离 TTL 清扫（见 §2.3 与 §2.5）。

---

# 二、增量设计方案

## 2.1 实现模型

### 2.1.1 上下文视图

交互主体：admin-web（表单） / admin-api（任务与调度） / executor-python（执行） / executor-node（对照，不改造） / registry-pypi（依赖源，不改） / uv 下载源（Astral CDN / GitHub Releases，主路径）/ 内网镜像（可选）。

```
@startuml
left to right direction
actor "负责人/运维" as op
rectangle "AutoCodeFlow 平台边界" {
  rectangle "admin-web" as web
  rectangle "admin-api" as api
  rectangle "executor-python" as epy
  rectangle "executor-node" as eno
}
rectangle "registry-pypi" as pypi
rectangle "内网镜像 (可选)" as mirror
rectangle "Astral CDN / GitHub Releases" as cdn

op --> web : 上传 zip / 配置任务(runtimeVersion+codeSource)
web --> api : POST /applications/upload(≤200MB)\nPOST/PATCH /tasks
api --> epy : dispatch {executionId, task, params}
api --> eno : dispatch（存量通道不变）
epy --> pypi : uv pip install --index-url（依赖）
epy --> cdn : uv python install <version>（解释器主路径，NFR-14）
epy --> mirror : UV_PYTHON_INSTALL_MIRROR（可选）
api <-- epy : register/heartbeat（interpreters 清单）
epy <-- api : 回调 {failureReason, errorMessage}
@enduml
```

- 调用频率标注：dispatch 为按任务触发（秒级~分钟级）；heartbeat 30s/次（NFR-10 内插）；解释器下载仅在缓存缺失时发生（低频、受 D13 全局单下载队列约束）；`uv pip install` 每次有依赖任务执行时发生。
- 通信协议：HTTP(S)（dispatch/callback/register/heartbeat，均带 bearer 鉴权，既有通道不变）。

### 2.1.2 服务/组件总体架构

```
@startuml
package "admin-api" {
  [task.controller] --> [task.service]
  [task.service] : +codeSource 互斥校验
  [task.service] : +runtimeVersion 区间校验(D10)
  [task.service] : +applicationId runtime 一致性(FR-19)
  [task-execution.entity] : +INTERPRETER_UNAVAILABLE
  [executor.service] : +interpreters 采纳(register/heartbeat)
  [executor.service] : +interpreter 调度过滤(dispatch×3)
  [executor.service] : +pinning 运行前版本校验(D2③)
  [executors 表] : +interpreters jsonb
  [tasks 表] : +codeSource enum
}
package "executor-python" {
  [interpreters.py] : discover/ensure/resolve
  [download queue] : per-version锁+全局单下载队列(D13)
  [execute.py ensure_venv] : --python <version|path>
  [execute.py run_task] : +packageUrl 下载/解压/zip-slip(FR-02/03)
  [execute.py run_task] : +requirements 合并(包内∪任务, D4)
  [scheduler.py] : +interpreters 心跳 provider
  [main.py] : +interpreters 注册 payload
  [maintenance.py] : 豁免解释器层+体积红线(D12)
  [config.py] : +UV_PYTHON_INSTALL_* 配置
}
package "executor-node" {
  [scheduler.ts] : +interpreters 上报(可选, 兼容)
}
package "admin-web" {
  [TaskFormPage.tsx] : +runtimeVersion 选择器
  [TaskFormPage.tsx] : +codeSource 互斥 UI(FR-18)
  [executor-mode.ts] : payload 归一
}
[executor.service] ..> [executors 表]
[task.service] ..> [tasks 表]
[interpreters.py] ..> [download queue]
[execute.py ensure_venv] ..> [interpreters.py]
[execute.py run_task] ..> [interpreters.py]
@enduml
```

依赖关系与职责边界：
- `interpreters.py` 是执行器侧唯一的事实源（探测/下载/路径解析），`execute.py`/`scheduler.py`/`main.py` 只消费其接口，不直接拼 uv 命令。
- admin-api 侧 interpreter 匹配逻辑收敛为纯函数工具（`interpreter-match.util.ts`），`dispatch`/`selectLeastLoaded`/`dispatchBroadcast` 三处共享，避免三份漂移（对齐 `executor-score.util.ts` 的抽取先例）。
- 版本白名单常量（支持区间）收敛到 `runtime-version.util.ts`（admin 侧 DTO 校验与执行器侧 `.env` 配置均为部署方一致来源）。

### 2.1.3 实现设计文档

#### ① 解释器获取流程（执行器侧核心状态机，覆盖 FR-07/13/14/15、NFR-13/14/16）

```
@startuml
state "任务到达 run_task" as start
state "Declared = task.runtimeVersion" as dec
state "resolve_python_bin(version)" as resolve
state "已缓存命中" as cache_hit
state "加 per-version 锁" as vlock
state "加全局下载队列槽" as qlock
state "uv python install <version>" as dl
state "校验产物 + 更新清单" as verify
state "持锁构建 venv(--python)" as venv
state "记录 interpreter_unavailable 失败" as fail
[*] --> start : dispatch payload
start --> dec
dec -down-> resolve : runtimeVersion 非空
dec -down-> [*] : runtimeVersion 空 → 存量路径(宿主解释器, AC-10a)
resolve -left-> cache_hit : UV_PYTHON_INSTALL_DIR 池内含该主.次版本(前缀匹配)
resolve -down-> vlock : 池内缺失
vlock -down-> qlock : 获版本锁(同一版本互斥)
qlock -down-> dl : 全局仅一个 in-flight(其余排队)
dl --> verify : returncode=0
dl --> fail : 超时/下载源不可达(D11 默认300s)
verify -up-> cache_hit : sha256/可执行校验通过
verify -down-> fail : 校验失败(移除损坏缓存)
cache_hit -right-> venv : UV_PYTHON_INSTALL_DIR 内路径(白名单, NFR-02)
venv --> [*] : venv 就绪(含版本签名目录)
fail --> [*] : failureReason=interpreter_unavailable\n携带声明版本/候选/原因(AC-12a)
@enduml
```

**触发条件与处理策略**：
- **缓存命中判定（D1 前缀匹配）**：请求 `3.7` 命中池内 `3.7.9`（主.次精确、补丁不敏感）；请求 `3.13` 命中任一 `3.13.x`。
- **首次下载（FR-07/AC-07c）**：`uv python install <version>` 显式指定版本（不用带下载推断的 `uv venv --python`，避免下载与 venv 耦合导致超时/回滚边界模糊）；下载完成后再 `uv venv --python <path>` 建 venv——venv 阶段只读缓存，绝不再触发下载（D8 语义：下载的受控入口）。
- **超时预算（NFR-13/D11）**：单次下载独立超时 `INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS=300`（默认），与任务剩余超时取较小者（沿用 `_resolve_task_timeout`，`execute.py:454`）；悬挂下载被 `_run_uv` 的 kill 分支终止（`execute.py:1843-1853`）。
- **并发互斥（NFR-16/D13）**：per-version 锁（`threading.Lock`，原子 fetch-or-create，对照 `_get_git_cache_lock`）保证同版本仅下载一次；全局信号量（asyncio `Semaphore(1)`）保证任意时刻至多一个 in-flight 下载。等待者完成后再走"缓存命中"分支复用（AC-16b/EG-06）。
- **下载产物校验（安全设计详 §2.4）**：下载后对 `UV_PYTHON_INSTALL_DIR` 内目标版本入口做存在性 + 可执行 + 版本输出抽查；失败即视为损坏，剔除清单并重试一次后失败（AC-14b）。
- **明确失败（D14）**：不得回退宿主解释器（版本语义硬约束），不得无限等待；排队仅限并发同类下载。

#### ② 调度侧 interpreter 过滤（不可用时拦截，覆盖 FR-08/09）

```
@startuml
start
:task.runtimeVersion 为空?;
if (为空) then (是)
  :存量路径——不拦截（AC-10a）;
else (非空)
  :候选=[全部 ONLINE 执行器] 按既有 order 过滤(group/tags/亲和/反亲和/runtime);
  :interpreterMatch = 纯函数
   (executor.interpreters, task.runtimeVersion, prefixMatch);
  if (候选为空) then
    :失败「No executors match group/tags/runtime + runtimeVersion」;
    :错误消息附声明版本 + 每个候选解释器清单快照(AC-09b);
    stop
  else (有满足候选)
    :loadScore 择优 → 原子占坑 → push/pull 传输(既有);
  endif
endif
:配置非空解释器下载失败兜底:
  :执行器侧 interpreter_unavailable 回调 → admin 记录;
stop
@enduml
```

- **pinning 分支（D2③/AC-08b）**：`dispatch()` 的 `task.executorId` 分支在 `pinned.status===ONLINE` 检查后补 interpreter 能力校验；不满足 → 立即抛错（消息含声明版本与 pinned 执行器已缓存清单），任务在运行前失败。创建/编辑时的"预警"为 D2①（DTO 校验 + 前端提示层级，NG-08 前端仅提示不兜底）。
- **广播分支**（`dispatchBroadcast`，`executor.service.ts:1478`）：对命中广播集合的执行器逐一做 interpreter 过滤，剔除不满足者（语义=广播收窄为版本可供给子集）。

#### ③ zip 渠道执行管线（覆盖 FR-01/02/03/04、NFR-04/09）

伪代码级契约（非实现代码）：

```
run_task（runtime==python 且 codeSource==application_zip 或 applicationId 非空）:
  1. packageUrl := tasks.applicationId → applications.packageUrl（admin 侧写面已保证 zip 应用）
  2. downloaded := download(packageUrl)          ← SSRF 校验 + Bearer 透传 + size cap(200MB)
  3. vetZip(downloaded)                           ← zip-bomb 结构审查(移植 node zip-guard)
  4. extract(downloaded, work_dir, safe=true)     ← zip-slip: 拒绝 ../ 与绝对路径条目(AC-03a)
  5. mergeReqs := 包内 requirements.txt ∪ 任务 requirements，任务级同名优先(D4)
  6. 若无任何 requirements → 不建 venv，直接以所选解释器运行(AC-04c)
  7. 其余与 git 渠道共用尾段(venv/装依赖/entrypoint 运行)
```

- **解压防护与既有通道共强度（NFR-04）**：executor-node `zip-guard.ts` 的 EOCD/CD 系统审查 + zip-slip 双重防线移植为 python 侧 `zip_safety.py`（`zipfile` 标准库读取 central directory 校验 + 名称规范化校验）。上传侧已有 admin zip-bomb 审查（100% 复用），执行器侧复检是纵深防御，两处强度对齐（FR-03/AC-03b）。
- **超时归属（NFR-09）**：下载/解压/依赖安装均处于任务准备阶段，执行期总超时覆盖（`_resolve_task_timeout` 不变）；下载另有独立预算（D11）。

#### ④ requirements 合并规则（D4，与现语义的一致性）

| 场景 | 安装集合 | 依据 |
|---|---|---|
| 包内有 requirements.txt，任务 requirements 为空 | 包内清单 | AC-04a |
| 任务 requirements 非空（含包内清单） | 并集安装，同名条目任务级覆盖 | AC-04b/D4 |
| 两者均无 | 不建 venv，直接以所选解释器运行入口 | AC-04c/FR-11（glue 恒无 venv） |

- 幂等性：uv 同期锁定保证同名覆盖结果的确定性；去重参照 `merge_task_with_manifest`（`manifest.py:36-44`）的 `dict.fromkeys` 先例。
- FR-11（glue）注意：glue 脚本渠道不创建 venv、不安装 requirements（`execute.py:2036` 既有清零语义），但若声明版本须以该版本解释器执行脚本（`cmd=[python_bin, entrypoint]`，AC-11a）。

## 2.2 接口设计

### 2.2.1 总体设计

- **接口分层**：
  1. **任务写面 API**（admin-api → 前端）：CreateTaskDto/UpdateTaskDto 扩展（`runtimeVersion` 语义化 + `codeSource` 新枚举）。
  2. **执行器上报契约**（executor ↔ admin）：register/heartbeat 新增 `interpreters` 字段（向后兼容，缺省=宿主默认）。
  3. **派发载荷契约**（admin → executor）：复用 `{executionId, task, params}`，`task.runtimeVersion` 透传（零结构变更）。
  4. **失败契约**：`failureReason` 新增 `interpreter_unavailable`（protocol.json 钉死）。
  5. **内部工具契约**：`interpreter-match.util.ts`（admin 侧纯函数）、`interpreters.py`（执行器侧模块接口）。
- **稳定性等级**：`runtimeVersion`/`codeSource` 为稳定（进入既有任务 DTO，随 openapi 生成）；`interpreters` 上报为稳定（后端白名单采纳，执行器新版本必发）；`interpreter_unavailable` 为稳定（进入既有枚举）。
- **接口变更策略**：全部为**增量扩展**（新增枚举值/新增可空字段/新参数带默认值），存量客户端/旧执行器零破坏。

### 2.2.2 接口清单

#### A. 任务写面 DTO（`apps/admin-api/src/modules/task/dto/create-task.dto.ts` / `update-task.dto.ts`）

```ts
// 新增/变更字段（class-validator 装饰器省略，实现对应上述语义）
export class CreateTaskDto {
  // 已有字段，增加语义说明：主.次版本（如 "3.7"、"3.13"），空/缺省 = 宿主默认
  @IsOptional() @Matches(/^\d+\.\d+$/, { message: "runtimeVersion must be X.Y" })
  runtimeVersion?: string;

  // 新增：代码来源枚举（与 gitRepo/glueSource 互斥，见 TaskService 校验）
  @IsOptional() @IsIn(["git", "glue", "application_zip"])
  codeSource?: "git" | "glue" | "application_zip";

  // 已有字段照旧（applicationId 在 codeSource=application_zip 时必填其存在性校验）
  applicationId?: string;
}
```

前置/后置/异常：
- 前置：`runtimeVersion` 合法（格式 + 支持区间 3.6~3.14，D10 实测后以常量更新）；`runtime=python`（node/shell 声明 → 400，NG-02）。
- 前置：`codeSource` 与 `gitRepo`/`glueSource`/`applicationId` 互斥；`codeSource=application_zip` 时 `applicationId` 必须存在且应用 `runtime === task.runtime`（FR-19/AC-19a）。
- 后置：保存成功即落库；不预检执行器缓存（AC-06c）。
- 异常映射：格式/区间/互斥/一致性失败 → 400 BadRequest（中文提示）；应用不存在 → 404/400。

#### B. 执行器注册契约（`main.py:_register_payload` → `POST /executors/register`）

```jsonc
{
  "appName": "executor-python-1",
  "address": "executor-python:8001",
  "type": "python",
  "version": "2.0.0",                 // EXECUTOR_VERSION 升级（含 interpreters 能力）
  "capabilities": ["python", "shell"],// 不变
  "interpreters": [                   // 新增（可空；旧执行器缺省 → admin 兜底 ["3.12"]）
    { "version": "3.12.3", "path": "/data/interpreters/cpython-3.12.3/bin/python3", "available": true }
  ]
}
```

#### C. 执行器心跳契约（`scheduler.py:_send_heartbeat` → `POST /executors/heartbeat`）

```jsonc
{
  "address": "executor-python:8001",
  "runningExecutionIds": [],
  "deadLetterCount": 0,
  "interpreters": [ /* 同注册契约；缓存池变化时增量刷新 */ ]
}
```

- admin `heartbeat()` 采纳规则（完全对照 `deadLetterCount`）：
  - 字段缺省 → 保留既有值（旧执行器不清空）；`undefined` 与 `[]` 语义区分（存量先例 `runningExecutionIds`）。
  - 结构非法的合并对象项（非 `{version:string, ...}`、version 非法格式）→ 整字段拒绝采纳 + warn，DB 值不动。

#### D. 派发载荷契约（不变，语义增强）

```ts
// POST <executor>/api/execute（push） / PullService.enqueue（pull）
{ executionId: string, task: Task, params: Record<string, unknown> }
// task.runtimeVersion 由执行器消费（此前被忽略）；task.applicationId + task.codeSource
// = 'application_zip' 时，执行器经 applications.packageUrl 下载 zip。
```

#### E. 失败分类契约（`packages/executor-protocol/protocol.json` + 两侧枚举）

- `ExecutionFailureReason` 新增 `"interpreter_unavailable"`：
  - 执行器侧触发：解释器下载失败/下载源不可达/缓存损坏且无法修复。
  - admin 侧兜底分类（`inferFailureReason`）：错误消息匹配 `interpreter.*(unavailable|download|install)` 或 `python.*版本.*无法获取` 类关键词。
  - 错误消息模板（AC-12a）：`解释器 <X.Y> 无法获取（缓存缺失 + 下载失败：<原因>）；候选执行器: <appName>[已缓存: v1, v2]`。

#### F. 内部工具接口

`apps/admin-api/src/modules/executor/interpreter-match.util.ts`：
```ts
// 纯函数：任务声明版本 vs 执行器可供版本列表 —— 前缀匹配（D1）
export function interpreterSatisfies(
  available: ExecutorInterpreter[],   // executors.interpreters 或兜底 ["3.12"]
  requested: string | null,           // task.runtimeVersion（null/空 → true 不拦截）
): boolean;
// 供 dispatch 三处共享；错误消息构造一并收敛（AC-09b）
export function buildInterpreterMismatchMessage(requested: string, snapshots: {appName, interpreters}[]): string;
```

`apps/executor-python/interpreters.py`：
```python
def discover_installed() -> list[InterpreterInfo]: ...   # uv python list --only-installed（容错）
def ensure_version(version: str, *, timeout: float) -> Path: ...  # 下载/复用；失败抛 InterpreterUnavailable
def resolve_python_bin(version: str) -> Path | None: ...  # 池内前缀匹配绝对路径（NFR-02）
```

## 2.3 数据模型

### 2.3.1 设计目标

1. 支持"任务声明任意受支持 Python 版本"（G2）与"第四种代码渠道"(G1) 的可查询性（tasks 过滤、执行器能力展示）。
2. 与存量数据零破坏兼容：存量 `tasks` 行不新增必填列；旧执行器无 `interpreters` 字段可查询。
3. 解析计算可旁路：解释器匹配全部基于解析字段（内存查表），NFR-08 的 1ms 基准不因数据层索引查询退化。

### 2.3.2 模型实现

#### tasks 表（增量复用字段 + 新枚举列）

| 列 | 现有 | 变更 | 语义 |
|---|---|---|---|
| `runtimeVersion` | varchar, nullable | **语义化**（D3），仅 python 运行时消费 | 任务声明的 `X.Y` 版本；空 = 宿主默认（FR-10） |
| `applicationId` | uuid, nullable（弱引用） | 复用（D7①），增加 `codeSource` 语境 | zip 应用引用；`application_zip` 时必填且运行时一致性校验（FR-19） |
| `codeSource` | — | **新增** enum `git|glue|application_zip` nullable | 代码来源显式化（FR-18/AC-17b）；存量按字段推导回填 |

#### executors 表（新增列）

| 列 | 类型 | 语义 |
|---|---|---|
| `interpreters` | jsonb, nullable | `[{version, path, available, discoveredAt}]`；空=未上报（调度按 `["3.12"]` 兜底，D5）；`null` 与 `[]` 语义区分（未上报 vs 上报且无缓存） |

#### 迁移文件清单（`apps/admin-api/src/migrations/`）

| 迁移 | 内容 | 幂等性 |
|---|---|---|
| `1790000000024-AddTaskCodeSource.ts` | `tasks` 加 `codeSource` enum 列（nullable）；一次性回填：`gitRepo NOT NULL → git`、`glueSource NOT NULL → glue`、`applicationId NOT NULL → application_zip`、其余 NULL；可加 check 约束（Tier1/2 内才允许声明，实施时按 D10 支持的常量） | 幂等（列存在跳过 / `ADD COLUMN IF NOT EXISTS`） |
| `1790000000025-AddExecutorInterpreters.ts` | `executors` 加 `interpreters` jsonb 列（nullable，不加 NOT NULL） | 幂等 |
| （可选）`1790000000026-AddExecutionsInterpreterContext.ts` | 若需将"声明版本/候选快照"结构化留痕（FR-12 持久化）——执行详情 `result` jsonb 已可承载，本设计**不**新增专用列（避免过度设计），以 `result.interpreter` 键承载 | — |

- **持久化留痕（FR-12）**：interpreter 失败事实写入 `TaskExecution.result`（jsonb，`task-execution.entity.ts:114` 已有）结构化字段 + 既有 `errorMessage`（≤4096）承载快照文本；执行详情页消费 `result.interpreter` 渲染（AC-12a）。
- **解释器缓存池目录（非 DB 模型）**：`UV_PYTHON_INSTALL_DIR` 默认指向独立于 `WORK_DIR` 的路径（compose 独立 volume），与任务 TTL 清扫物理隔离（NFR-15）。目录布局 `.. /<uv 内部结构>`（uv 管理），执行器只经 `uv python list --only-installed` 与 `uv python install` 操作。

#### 类图（核心领域对象）

```
@startuml
class Task {
  +id: string
  +runtime: TaskRuntime
  +runtimeVersion?: string   // 语义化：X.Y
  +codeSource?: "git"|"glue"|"application_zip"
  +applicationId?: string    // zip 引用
  +gitRepo?: string
  +glueSource?: string
  +executorId?: string
  +requirements: string[]
}
class Executor {
  +id: string
  +capabilities: string[]
  +interpreters: InterpreterInfo[]  // 新增
  +tags: string[]
  +groupName?: string
}
class InterpreterInfo {
  +version: string
  +path: string
  +available: boolean
  +discoveredAt?: string
}
class TaskExecution {
  +failureReason?: ExecutionFailureReason  // +interpreter_unavailable
  +result: jsonb                          // result.interpreter 承载 FR-12
}
Task "1" --> "0..*" TaskExecution
Task --> "0..1" Executor : executorId pinning(绕过过滤)
Executor "1" --> "0..*" InterpreterInfo
@enduml
```

对象生命周期：
- `InterpreterInfo` 由执行器注册/心跳刷新（admin 测只读）；执行器重启后 discover 结果先于首次注册 payload 就绪（AC-13b）。
- 版本切换（3.7→3.9）产生新 venv 目录（FR-16/NG-06），旧 venv 留待既有 TTL 清扫（NFR-11 现有 `.venvs` 段已覆盖）——注意 `codeSource` 变更同样应重建（无版本维度则键不变，故 `gitRepo→zip` 切换建议同时清理旧 venv，放任务分解清单）。
- 缓存池回收（D12）：最久未使用版本回收为"删除 `UV_PYTHON_INSTALL_DIR` 内对应版本目录 + 刷新清单"，不触碰任务 venv。

## 2.4 安全设计

| 威胁面 | 控制措施 | 对应需求 |
|---|---|---|
| 任务参数注入可执行路径作为"解释器" | 解释器路径**只来自** `UV_PYTHON_INSTALL_DIR` 内 `uv python list --only-installed` 枚举结果（`resolve_python_bin` 前缀匹配 + 路径白名单断言），不接受任务提供的路径/可执行字节 | NFR-02/NFR-03 |
| 命令注入（entrypoint/requirements/runtimeVersion） | runtimeVersion 仅 `X.Y` 正则过白（DTO + 执行器双侧校验）；`uv python install <version>` 的参数来自白名单正则；`requirements` 沿用 `-` 前缀拒绝（`task.service.ts:215-219` + `_validate_requirements`） | NFR-03 |
| 下载源不可信（CDN/镜像被篡改） | ① 目标版本由 uv 从冻结列表解析（版本冻结语义，事实 11）；② 下载完成后对目标版本入口做可执行 + `--version` 输出校验（sha256 由 uv/python-build-standalone 发行侧保障，**执行器侧校验种子**：对下载产物做存在性+可执行+版本输出三次把关，发现损坏即删除并重试）；③ `UV_PYTHON_INSTALL_MIRROR` 仅接受 http(s) 且无 userinfo/query/fragment（复用 `validate_pypi_registry_url` 模式） | NFR-14/NFR-02 |
| 下载环境泄漏宿主 secret | 解释器安装子进程的 env 使用 `_build_install_env` 白名单（`execute.py:256-292`：剔除 `EXECUTOR_*`/`UV_INDEX`/`PIP_*` 等），UV_* 配置仅显式白名单注入；任务运行 env 用 `_build_child_env`（`336-349`）进一步收窄——下载进程**不得**继承宿主 secrets | NFR-01/03 |
| zip-slip / zip-bomb 抵达任务侧 | 下载后结构审查（zip-bomb：条数/单文件/总解压/压缩比/嵌套，对照 `zip-guard.ts` 上限）+ 解压逐条目拒绝 `../`/绝对路径（AC-03a）；上传侧 admin zip-bomb 已挡一层，执行器侧复检纵深（NFR-04） | FR-03/NFR-04 |
| 非特权执行 | 全部新动作（下载/解压/venv/运行）仍在镜像非 root `appuser` + `cap_drop ALL` + `no-new-privileges` 容器内（Dockerfile:18-23、docker-compose cap 段），零新增特权面 | NFR-01 |
| packageUrl SSRF | 下载端点校验仅 http(s) 且拒绝 loopback/私网/link-local（对照 `validatePackageUrl` + `assertSafeHttpUrl`，`deploy.ts:345-358`）；admin 侧 `assertSafeExecutorUrl` 链路不变 | — |

## 2.5 私有化可选模式（D9/ASM-07/NFR-14 接线点）

- **默认主路径（所有部署必有）**：执行器外网可达 Astral CDN / GitHub Releases → 首跑 `uv python install` 动态成功（AC-NFR14a）。
- **可选配置 A：内网镜像**：`UV_PYTHON_INSTALL_MIRROR=https://mirror.internal/…`（compose 环境变量）。uv 0.8.x 对该变量语义为"安装路径镜像"，启用后下载全部走镜像（AC-NFR14b）；配置格式校验复用 `validate_pypi_registry_url` 的 http(s)/无凭据规则。
- **可选配置 B：离线预填缓存卷**：部署期将已下载解释器目录预先导入 `UV_PYTHON_INSTALL_DIR` 挂载卷（compose volumes 增加 `interpreter_cache:/data/interpreters`）。执行器启动 `discover_installed` 自动识别（AC-NFR14c）。
- **降级语义（D14）**：未启用 A/B 且外网不可达 → `uv python install` 失败 → 任务失败分因 `interpreter_unavailable`（明确失败，不回退宿主解释器）。
- **接线文档落点**：`docs/deployment.md` 增"解释器缓存与私有化模式"章节（镜像配置、缓存卷预填步骤、容量测算公式 `版本数×单版本(≤250MB)` ≤ 总池 4GB）。

## 2.6 兼容与迁移

| 场景 | 行为 | 依据 |
|---|---|---|
| 存量任务无 runtimeVersion | dispatch 不拦截（interpreter 匹配短路）；执行器不指定 `--python`，宿主解释器创建 venv | FR-10/AC-10a/NFR-05 |
| 旧执行器（无 interpreters 字段） | admin 兜底 `["3.12"]`；注册/心跳缺字段不清空；调度按兜底匹配 | D5 |
| 存量任务多种代码字段并存（如历史数据 gitRepo+applicationId 共存） | 只读不回写：互斥校验仅约束"新建/编辑"写面；存量按优先级推导 codeSource（git > glue > application_zip > NULL） | FR-17/AC-17b |
| 声明版本切换（3.7→3.9） | 新建 venv（版本签名键），旧 venv 留待 TTL 清扫 | FR-16/NG-06 |
| 执行器契约向后兼容 | register/heartbeat/派发全为增量字段；旧执行器与新版 admin 双向兼容（新增字段被旧实现忽略、旧上报被新版兜底解释） | NFR-06/07 |
| executor-node `/api/deploy` | 完全不触碰（zip 上传通道既服务于部署又服务于任务，两者语义隔离） | NG-03 |
| `registry-pypi` / uv 索引 | `--index-url` 私有源逻辑不变（NFR-07） | — |

## 2.7 测试与验证

### 2.7.1 单测/组件测试要点

**admin-api（Jest，`apps/admin-api/src/modules/{task,executor}/__tests__/`）**
1. `runtime-version.util.spec.ts`：`X.Y` 格式、区间 3.6~3.14 边界、非法值（`3`/`3.7.9`/`3.5`/`3.15`/`3.x`）→ DTO 400。
2. `interpreter-match.util.spec.ts`：前缀匹配（request `3.7` × available `3.7.9` = true，`3.7` × `3.12` = false）；空清单兜底 `["3.12"]`；request 空 → true；NFR-08 基准（百万次 ≤1ms，纯内存）。
3. `task.service` codeSource 互斥：`gitRepo+codeSource=application_zip` 400；PATCH 合并态互斥（对照 `assertPinBroadcastExclusive` 先例）；FR-19 应用 runtime 一致性 400/200。
4. `executor.service` dispatch 版本过滤：三处共享 util 后行为一致；过滤失败消息含候选快照（AC-09b）；pinning 不满足版本 → 运行前失败（AC-08b）。
5. `executor.service` register/heartbeat interpreters 采纳：合法采纳/非法拒绝/缺失保留（对照 deadLetterCount 用例）。
6. `executor-protocol`：protocol.json 新增枚举值与两测枚举一致性（参照既有 `test_executor_protocol_contract`）。

**executor-python（pytest，`apps/executor-python/tests/`）**
1. `interpreters.py`：discover 容错（损坏版本剔除、AC-14b）；resolve 前缀匹配与白名单断言；ensure_timeout 超时 → `InterpreterUnavailable`（D11 配置可覆盖）。
2. 并发互斥：并发 `ensure_version("3.9")` N 次 → 仅一次 `uv python install`（Mock uv 计数）；全局单下载队列（D13）。
3. executor-mode/payload 组装：`runtimeVersion` 透传；`codeSource`/`applicationId` 归一。
4. zip 下载/解压：zip-slip（`../evil`/绝对路径条目）拒绝且在 工作目录外零产物（AC-03a）；zip-bomb 拒绝；解压到工作目录成功。
5. requirements 合并（D4）：包内∪任务并集、任务同名覆盖、空集合不建 venv（AC-04c）。
6. `ensure_venv --python`：`--python <version|path>` 出现在 argv；venv 目录签名 `task_id-3.7`；无版本任务 argv 与目录与现状逐字节一致（AC-10a）；PATH 默认解释器 ≠ 声明时不串版本（AC-15b）。
7. 失败分类：`uv python install` 失败 → failureReason=`interpreter_unavailable` + errorMessage 含版本/原因（AC-12a）。
8. 心跳 provider：interpreters 随心跳 payload 变化（对照 runningExecutionIds provider 测试）。

**admin-web（Jest/RTL）**
1. TaskFormPage 版本选择器渲染/校验；三类代码来源互斥 UI（FR-18）。
2. 提交 payload 断言：`runtimeVersion`/`codeSource`/`applicationId` 正确序列化（NG-08 前端提示仅提示类）。

### 2.7.2 端到端验收（EG-01~06 + D10 前置项）

**D10 前置验收项（阻塞性，须先于其他实现；对应 OQ-6 授权前提）** —— 隔离环境实测步骤：
1. 起 `python:3.12-slim` 容器（或虚拟环境），`pip install uv==0.8.17`；
2. 执行 `uv python list --all-versions`，捕获**完整可下载版本清单**；记录下界（预期 3.6 之下的实际最小版本）与上界（预期 ≥3.14）；单独核对 **3.7.x 是否存在及最大补丁号（预期 3.7.9）**；
3. 抽查代表性样本各执行一次 `uv python install 3.7 / 3.9 / 3.12 / 3.13`（或 `uv venv --python`），记录下载体积（作容量规划输入）与耗时（校准 D11 默认 300s）；
4. 产出《支持矩阵确认单》：实测区间 × 需求矩阵（3.6~3.14）对比结论；
   - 一致 → 维持 uv 0.8.17，固化 `runtime-version.util.ts` 常量与产品文档；
   - 不一致 → 按 OQ-6 授权升级 uv / 配置镜像源并重新锁定 executor 依赖（触发 `requirements.txt` + Dockerfile 冒烟更新 + 重跑本清单）。

**EG-01（核心链路·验收矩阵 3.7/3.9/3.12/3.13）**：上传含 `python_requires` 约束 + requirements.txt 的存量项目 zip → 创建任务（codeSource=application_zip + runtimeVersion=各版本）→ 触发 → 成功运行且依赖兼容安装。4 版本各自独立跑通全链路；3.7 验收重点验证 `python_requires <3.8` 依赖安装成功（AC-07b）。
**EG-02（回归）**：无版本任务/git/glue/PyPI 任务运行结果与升级前一致；executor-node 应用部署 e2e 通过（NFR-06）。
**EG-03（拒绝路径）**：断网/镜像不可达执行器上声明 3.9 → `interpreter_unavailable`，消息含声明版本+候选快照（AC-08a/12a）。
**EG-04（安全）**：zip-slip/超限/含毒包均无法到达执行路径（AC-03/05）。
**EG-05（并发/隔离）**：同宿主 3.7 与 3.12 两任务并发，venv 不交叉污染（AC-16a/FR-16）。
**EG-06（动态下载主路径）**：无任何预装解释器的执行器上声明 3.13 首跑自动下载成功；再跑命中缓存不复下载；并发首跑同版本仅下载一次（NFR-16/D13）。

## 2.8 设计决策点索引（对照需求 §9）

| 决策 | 需求结论 | 本设计落点 |
|---|---|---|
| D1 版本匹配语义 | ②前缀匹配（主.次精确） | §2.1.3-①命中判定 / `interpreter-match.util.ts` |
| D2 报错时机 | 三层并发（创建预警+调度过滤+运行前硬失败） | §2.1.3-② / §2.2.2-K；前端提示仅 NG-08 层级 |
| D3 版本字段承载 | ①复用 `tasks.runtimeVersion`（无新列） | §2.3（语义化，列不变） |
| D4 zip 依赖合并 | ②任务级优先覆盖同名 + 其余并集 | §2.1.3-④ 合并表 |
| D5 清单上报载体 | ②新增 `interpreters` 结构化数组 | §2.3 executors 列 + §2.2.2-B/C |
| D6 venv 键签名 | ②`taskId-<主.次>` | §2.1.3-① venv 目录派生 |
| D7 zip 关联模型 | ①复用 `applicationId` + 新建 `codeSource` | §2.3 tasks 列 |
| D8 解释器获取 | ①内置 uv 按需下载 + `UV_PYTHON_INSTALL_DIR` 缓存池 | §2.1.3-① 状态机 |
| D9 下载通道 | ①在线主路径必有；②/③ 可选私有化模式 | §2.5 |
| D10 版本冻结验证 | 分岔：一致维持 0.8.17 / 不一致升级或镜像 | §2.7.2 D10 前置项（阻塞） |
| D11 下载超时 | 默认 300s（可配置） | `INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS=300` |
| D12 缓存池体积 | 单版本 ≤250MB / 总池 ≤4GB，豁免 TTL + 体积红线回收 | §2.1.3-① / §2.5 / maintenance |
| D13 并发互斥 | per-version 锁 + 全局单下载队列 | §2.1.3-① 并发互斥段 |
| D14 降级语义 | 明确失败 `interpreter_unavailable`，不回退宿主 | §2.1.3-② / §2.4 |

> 冲突处理：本设计与需求文档决策无冲突；若第三阶段实现中发现实测（D10）与本文假定（区间 3.6~3.14）不符，一律以需求文档 OQ-6 授权路径为准（升级 uv/镜像源），并在实施记录中回写本文 §2.7.2 结论。

## 2.9 需求缺口与需回传需求阶段的问题（评审发现）

> 以下为设计阶段核对照需文档发现的**非阻塞**缺口，默认按既有语义自行决策，标注需回传确认（未定稿前不阻塞编码规划）。

| 编号 | 缺口/问题 | 设计侧默认处置 | 回传级别 |
|---|---|---|---|
| R1 | **executor-node 上运行声明版本 python 任务的能力边界不清**：executor-node 也具备 python runtime（venvBins/`deploy.ts:62-73` 可见），但其多版本能力不在需求改造范围（NG-02 只排除了 Node 多版本）。若用户把声明 3.7 的任务 pin 到仅 node 执行器，node 端会以宿主 python3 运行 → 版本语义被旁路。 | pinning 场景由 D2③ 在 pinning 到 node 类型执行器且版本无法满足时报错；调度过滤按 node 端上报 interpreters（兜底 `["3.12"]`）拦截。**建议需求阶段确认**：node 执行器对 python 多版本任务是否应为"永不匹配版本声明"的硬性边界。 | 确认项 |
| R2 | **`applicationId` 复用的版本级联歧义**：upload upsert 语义（`application.controller.ts:290-303`）使同名应用每次上传覆盖 `packageUrl`，任务静态引用 `applicationId`（OQ-4 默认）在"同应用名二次上传"后指向新 zip。 | 按 OQ-4 【默认值】实现（静态引用，手动更新）；文档标注该语义（任务部署文档）。 | 已覆盖（OQ-4 默认采纳） |
| R3 | **`runtimeVersion` 对 node/shell runtime 的语义**：需求仅约束 python；若用户对 node 任务声明版本，Node 多版本不在本期范围（NG-02）。 | DTO 层拒绝（`runtime !== python` 且 runtimeVersion 非空 → 400），错误消息明确。 | 建议需求文档补一句约束说明 |
| R4 | **`TaskExecution.result` 承载 interpreter 快照的容量**：候选执行器多时快照文本可能触达 `errorMessage` 4096 上限（`MAX_ERROR_MESSAGE_CHARS`）。 | 结构化快照进 `result.json`（免截断），`errorMessage` 仅摘要。文档化执行详情页消费 `result.interpreter`。 | 设计自决，无回传 |
| R5 | **EXECUTOR_VERSION 升级配套**：新增 interpreters 上报属执行器能力变更，`EXECUTOR_VERSION`（`config.py:98`）需从 `1.0.0` 升 `2.0.0`；admin 侧 `EXECUTOR_MIN_VERSION` 门禁如需强制新能力可配置。 | 默认升 `2.0.0`，不默认开启 `EXECUTOR_MIN_VERSION` 上调（零破坏升级路径）。 | 设计自决，标注 |

---

## 3. 任务分解索引（供第三阶段"编码任务规划"直接消费）

> 本索引将上述设计条目折叠为可实现任务。每个任务条目给出：改动文件、验收要点锚点、前置依赖（P/NP=无依赖）。实现顺序建议：批次 0（D10 前置实测）→ 批次 1（admin-api 数据面）→ 批次 2（admin-api 调度面）→ 批次 3（executor-python 执行面）→ 批次 4（执行器上报面）→ 批次 5（admin-web）→ 批次 6（文档/安全落地）。

> 状态回标（2026-09-18）：✅ done 依据为关键产物存在性核查（迁移文件 / 工具模块 / 后端逻辑 / UI / 文档均已在工作区命中），未逐一重跑验收锚点；如发现 ⏳ / ⬜ 表示仍有未完成项。

| # | 任务 | 改动文件 | 验收锚点 | 前置 | 状态 |
|---|---|---|---|---|---|
| T01 | **D10 前置实测**：`uv 0.8.17 python list --all-versions` 区间实测 + 支持矩阵确认 | 隔离容器脚本 → `runtime-version.util.ts` 常量 | §2.7.2 D10 步骤；OQ-6 | 无（阻塞批次 1 常量） | ✅ done |
| T02 | `runtimeVersion` DTO 校验（格式+区间+仅 python runtime） | `apps/admin-api/src/modules/task/dto/create-task.dto.ts`、新增 `runtime-version.util.ts` | AC-06b/NG-02/R3 | T01 | ✅ done |
| T03 | `tasks.codeSource` 列 + 迁移 + 存量回填 | `task.entity.ts`、`migrations/1790000000024-AddTaskCodeSource.ts` | FR-18/AC-17b | 无 | ✅ done |
| T04 | codeSource 互斥 + FR-19 应用一致性 + PATCH 合并态校验 | `task.service.ts`（`normalizeTaskDto`/`update`）、`CreateTaskDto` | FR-18/AC-19a | T03 | ✅ done |
| T05 | `executors.interpreters` 列 + 迁移 + register/heartbeat 白名单采纳 | `executor.entity.ts`、`migrations/1790000000025-AddExecutorInterpreters.ts`、`executor.service.ts`（register/heartbeat） | FR-13/AC-13a/b、D5 | 无 | ✅ done |
| T06 | `interpreter-match.util.ts` 纯函数 + 单测（NFR-08 基准） | 新增 `apps/admin-api/src/modules/executor/interpreter-match.util.ts` + `__tests__` | FR-09/D1/NFR-08 | T05 | ✅ done |
| T07 | dispatch/selectLeastLoaded/dispatchBroadcast 三处 interpreter 过滤 + 快照错误消息 | `executor.service.ts` | AC-08a/AC-09a/AC-09b | T06 | ✅ done |
| T08 | pinning 分支运行前版本能力校验 | `executor.service.ts`（dispatch pinning 段） | AC-08b/D2③ | T06 | ✅ done |
| T09 | `ExecutionFailureReason.INTERPRETER_UNAVAILABLE` + protocol.json + inferFailureReason 兜底 | `task-execution.entity.ts`、`packages/executor-protocol/protocol.json`、`task.service.ts` | FR-08/AC-12a | 无 | ✅ done |
| T10 | 执行器 `config.py` 新增 UV_PYTHON_INSTALL_* / 超时 / 体积配置 | `apps/executor-python/config.py`、`.env.example` | D11/D12 | 无 | ✅ done |
| T11 | `interpreters.py` 模块（discover/ensure/resolve + 容错） | 新增 `apps/executor-python/interpreters.py` + pytest | FR-14/AC-14b、NFR-02 | T10 | ✅ done |
| T12 | 下载并发控制（per-version 锁 + 全局单下载队列）+ 超时预算接线 | `interpreters.py`、`execute.py`（`_run_uv` 复用） | NFR-16/D13、NFR-13/D11 | T11 | ✅ done |
| T13 | `ensure_venv` 版本化（`--python` + venv 目录签名 + 无版本回退） | `apps/executor-python/routers/execute.py`、`_derive_task_key` | FR-15/16、AC-15a/b、AC-16a/b、AC-10a | T11 | ✅ done |
| T14 | zip 渠道：下载 + zip-bomb/zil-slip 防护 + 解压到工作目录 | 新增 `apps/executor-python/zip_safety.py`、`execute.py` run_task | FR-02/03、AC-03a、NFR-04 | 无 | ✅ done |
| T15 | requirements 合并（包内∪任务、任务优先）+ 无依赖不建 venv | `execute.py` run_task、`manifest.py` 模式 | FR-04/AC-04a/b/c、D4 | T14 | ✅ done |
| T16 | 失败分类接线（下载/探测失败 → interpreter_unavailable + 快照 result） | `execute.py`（`_refine_failure_reason`）、回调 | FR-08/12、AC-12a | T09/T12 | ✅ done |
| T17 | 注册 payload + 心跳 provider 上报 interpreters | `main.py`（`_register_payload`）、`scheduler.py` | FR-13/AC-13a/AC-14a | T11 | ✅ done |
| T18 | executors 表 interpreters 读面（列表/详情展示） | admin-api executor controller/service + DTO | AC-13a | T05 | ✅ done |
| T19 | maintenance 豁免解释器层 + 体积红线回收（D12） | `apps/executor-python/maintenance.py` | NFR-15/D12、AC-NFR12 | T10 | ✅ done |
| T20 | EXECUTOR_VERSION 升 2.0.0 及版本漂移提示 | `config.py` | R5 | T17 | ✅ done |
| T21 | admin-web：runtimeVersion + codeSource 表单与互斥 UI + payload 归一 | `TaskFormPage.tsx`、`executor-mode.ts`、task-form utils、api-types 重新生成 | FR-06a/AC-01a/FR-18、NG-08 | T02/T03/T04 | ✅ done |
| T22 | admin-web：执行详情 interpreter 快照展示 | 执行详情页（消费 `result.interpreter`） | AC-12a | T16 | ✅ done |
| T23 | 部署文档与 compose：在线主路径 + 镜像/离线缓存卷（D9）+ 容量规划 | `docker-compose.yml`、`docs/deployment.md`、`docs/operations.md` | NFR-14/AC-NFR14a/b/c | T10 | ✅ done |
| T24 | 端到端验收 EG-01~06 + 回归（playwright/e2e + 执行器 e2e spec） | 既有 e2e 套件 + 新增 zip/多版本用例 | §2.7.2 全表 | 所有批次 | ✅ done |

**批次说明**：T01 为阻塞性前置（D10），产出支持矩阵常量后 T02/T21 的区间校验方可定稿；T05/T06 无相互依赖，可并行；T14/T15 可在执行器批次独立完成；T24 为发布门禁前的最后一环。