# contract-crosscut 域审计报告（Round 1 · 2026-11-03）

> **审计对象**：`/home/yongsheng/project/AutoCodeFlow`（HEAD 见 `git log -1`）
> **域范围**：跨端契约 + 共享 SDK + 观察性（`packages/executor-protocol`、`packages/contract-fixtures`、`packages/acf-cli`、`packages/mcp-server`、两个 SDK、四个孤立 python 库、`apps/admin-api/src/modules/metrics/` + `apps/admin-web` 指标面）
> **方法**：CodeGraph 优先（`codegraph status` → 索引新鲜，`codegraph sync` 返回 "Already up to date"；Files 2108 / Nodes 42151 / Edges 120271）。CLI 走 `codegraph explore` / `query`；配置、文档、YAML、JSON 走 grep/read（AGENTS.md §1 第 3 条允许）。
> **性质**：**只读审计**。本轮未编辑任何仓内源码，未执行任何 git 写操作。唯一写入是本报告文件（以及 §11 决策项所指向的**建议**改动清单）。
> **前序调研增量**：已读 `/home/yongsheng/project/open_sourse/agent_talk/02_cross_analysis/02-acf-docs-vs-code-audit.md` 与 `03_recommendations/01-priority-register.md`。本报告**不重复**该批已覆盖的结论（A2 版本基线、D4 未分类码计数、D8 审批闭环等），只在其之上报增量。

---

## §1 现状问题分析

### 1.1 本域的六条主结论（先给结论，后面全部有证据）

| # | 结论 | 严重度 | 一句话证据 |
|---|---|---|---|
| **C1** | **失败原因分类存在三份独立正则实现**（admin `inferFailureReason` / node `prepareFailureReason` / python `_refine_failure_reason`），共 **3 × 约 9-10 条规则**，彼此只靠注释互指对齐 —— 这是「文案正则→结构化码」迁移的真正靶心 | **5（正确性）** | `apps/admin-api/src/modules/task/task.service.ts:1067-1122`；`apps/executor-node/src/routes/execute.ts:855-974`；`apps/executor-python/routers/execute.py:570-720` |
| **C2** | **「已知差异」机制目前形同虚设**：`contract.json` 的 `knownDivergence` 段**唯一一条已关闭**（PK-06/PK-07），其余两端真实差异全部**没有进入契约登记**，而是散在源码注释里 | **4（功能缺失）** | `packages/contract-fixtures/contract.json` 的 `knownDivergence.$comment` 自述「Divergence is closed」；真实未登记差异见 §3.3 |
| **C3** | **四个孤立 python 库确实零消费者**（import 图 + 运行时引用 + 依赖装配三重取证），但**它们的语义已被 `autoflow-sdk` 与 node-sdk 逐字"抄"走**（注释互指 parity），是**活的技术债载体**而非死代码 | **4** | `codegraph query "autocodeflow_notify"` 命中仅 4 处全在包自身；`apps/executor-python/.venv/lib/python3.12/site-packages/` 无 `autocodeflow_*` |
| **C4** | **四客户端对「同一后端错误」的表达确实是四种样子**：CLI 有 6 类归类 + 建议、node-sdk 只挂 `errorCode`、python SDK 只挂 `error_code`、MCP 只挂 `structuredContent` —— 但**机读面（errorCode）四端已统一**，分叉在**人读面** | **3（可运维性）** | `packages/acf-cli/src/error-code.ts:122-134`；`packages/autocodeflow-node-sdk/src/http-client.ts:427-495`；`packages/autoflow-sdk/autoflow_sdk/http.py:109-140`；`packages/mcp-server/src/tools.ts:117-200` |
| **C5** | **指标一致性守卫覆盖度很高但有一处真漏网**：Grafana dashboard 引用 24 个指标，**22 个不在 `runtime-metrics.ts` / `prometheus-metrics.service.ts` 两个注册表文件里**（它们在 `INFRA_METRICS` 白名单或另一处字面量），而 `check-alerts-rules.mjs` 的清单口径与 `check-metric-docs.mjs` 的注册表口径**不是同一份** | **3** | 见 §6.3 实测输出 |
| **C6** | **契约源 `executor-protocol` 的覆盖面比预期窄**：它管的是「执行器↔中台」的**线缆协议**，而**不覆盖**（a）CLI/MCP/SDK 面向 admin-api 的 API 契约（那由 openapi + `api-types.ts` 管）、（b）失败原因分类语义、（c）健康端点全集、（d）错误码表 | **3** | `packages/executor-protocol/protocol.json` 11 个顶层段全在执行器域；`apps/admin-api/src/common/errors/catalog/` 427 码不在其中 |

### 1.2 问题的共同形状

本域所有问题都落在同一个形态上：**「协议文本存在，但执行它的判据不在同一处」**。

- `protocol.json` 有 `envForward` 三桶，但**桶里的名单在三处各写一份**（protocol.json / node `ENV_WHITELIST` / python `_ENV_WHITELIST`），靠两侧各一个 spec 断言「自己的 == common ∪ 自己的 runtimeOnly」；
- `contract.json` 有 `knownDivergence` 段，但**没有「新增 knownDivergence 要登记什么」的门禁**，也没人往里写；
- `protocol.json` 有 `failureReason.all / executorReportable`，但**分类规则本身**（怎么从文案判到那个枚举）在三处各写一份正则。

⇒ **契约源统一的是「值域」，没统一「判定逻辑」**。这是本域最重要的结构性发现。

---

## §2 CodeGraph 探查结论（依赖图、影响面量化表）

### 2.1 索引状态

```
$ codegraph status
Project: /home/yongsheng/project/AutoCodeFlow
Index Statistics: Files 2108 / Nodes 42151 / Edges 120271 / DB 245.12 MB
Files by Language: typescript 1464 / tsx 296 / javascript 175 / python 132 / yaml 36
$ codegraph sync → Already up to date
```

### 2.2 契约源的依赖方向（CodeGraph 实证）

`packages/executor-protocol/protocol.json` 的**消费者**（`grep -rln "executor-protocol\|protocol\.json"`，剔除 `__pycache__`/`dist`/`coverage`）：

| 消费面 | 文件 | 消费方式 |
|---|---|---|
| **生成器** | `scripts/generate-executor-protocol.mjs` | 读 `schemas` 段 → 生成 zod + pydantic |
| **生成物（node）** | `apps/executor-node/src/generated/protocol.schemas.ts` | `CallbackPayloadSchema` 等 |
| **生成物（python）** | `apps/executor-python/generated/protocol_schemas.py` | pydantic model |
| **node 契约测试** | `apps/executor-node/src/__tests__/executor-protocol-contract.spec.ts` | 直接 `readFileSync` 读 protocol.json（**不走生成物**） |
| **python 契约测试** | `apps/executor-python/tests/test_executor_protocol_contract.py` | 同上 |
| **admin-api 消费** | `apps/admin-api/src/modules/task/entities/task-execution.entity.ts:116-124`、`apps/admin-api/src/modules/task/dto/execution-callback.dto.ts:23,179`、`apps/admin-api/src/modules/executor/dispatch-params-keys.util.ts:18,35,75` | **注释互指 + 手工对齐**，无生成物 |
| **CI 漂移闸** | `.github/workflows/ci.yml:1344-1358`（`executor-protocol-drift` job） | `npm run gen:protocol` + `git diff --exit-code -- apps/executor-node/src/generated apps/executor-python/generated` |
| **四方枚举守卫** | `scripts/check-failure-reasons.mjs:58-61` | 静态读 4 处（protocol.json / entity.ts / autoflow-sdk callback.py / node callback.ts） |

> ⚠️ **结构性缺口**：`executor-protocol-drift` CI job **只覆盖 `schemas` 段的生成物**。`envForward` / `params` / `secrets` / `failureReason` / `readiness` / `timeout` 这些段**没有生成物**，它们的「一致性」完全靠**两侧各写一个 spec** 断言（如 `apps/executor-node/src/env-whitelist.spec.ts` 与 `apps/executor-python/tests/test_env_forward_parity.py`）。**这两侧 spec 不在同一个 CI job 里**，且比对逻辑是**镜像实现**而非共享实现。

### 2.3 影响面量化表

| 改动对象 | 直接影响文件数（CodeGraph / grep 实测） | 关键触点 |
|---|---|---|
| `protocol.json` 的 `schemas` 段 | **2 个生成物 + 3 个 spec + 1 个 CI job** | `gen:protocol` → CI drift job |
| `protocol.json` 的 `failureReason` 段 | **4 处枚举 + 3 个分类器 + 127 个引用 `failureReason` 的文件** | `check-failure-reasons.mjs` 四方比对 |
| `protocol.json` 的 `envForward` 段 | **2 个白名单实现 + 2 个 spec** | `env-whitelist.spec.ts` / `test_env_forward_parity.py` |
| 四个 python 库（删除方案） | **4 个包目录（4343 行源码 + 测试）+ 1 个 CI job（矩阵 4 项）+ 4 条 release-please 配置 + 2 个 release-please manifest 项 + 1 条 root exclude-paths + 1 个守卫基线（4 条）+ `package.json` 4 条 `test:lib-*` script** | `ci.yml:1564`、`release-please-config.json:10-13,35-38,167+`、`release-please-manifest.json` |
| 错误码表（`catalog/*.ts`，427 码） | **6 个分片 + 1 个合并点 + 2 个生成物 + 1 个守卫 + 4 个客户端消费点** | `check-error-i18n.mjs` / `gen-error-i18n.mjs` |
| `runtime-metrics.ts`（52 指标） | **2 个注册表文件 + 3 个守卫 + 1 个 grafana json + 2 个 yml + 235 篇文档** | `check-metric-docs.mjs` / `check-alerts-rules.mjs` / `dashboard-label-values.spec.ts` |

---

## §3 契约统一现状清单（已统一 / 待收敛 / knownDivergence 判定）

### 3.1 已由契约源统一（✅，有守卫、可复核）

| 契约面 | 事实源 | 生成物 | 守卫 | 状态 |
|---|---|---|---|---|
| **回调载荷 schema** | `protocol.json.schemas.CallbackPayload` | zod + pydantic | `executor-protocol-drift` CI + 双端 spec | ✅ 已统一 |
| **ExecuteRequest / TaskConfig / HeartbeatPayload / ConfigReload* / HealthReady / Kill / Logs / ControlCommand / CommandResult / CallbackArtifact** | 同上 12 个 schema | 同上 | 同上 | ✅ 已统一 |
| **failureReason 值域** | `protocol.json.failureReason.{all,executorReportable,adminInternalOnly}`（15/12/3） | — | `check-failure-reasons.mjs`（四方比对：protocol.json / `task-execution.entity.ts` / `autoflow_sdk/callback.py` / `executor-node/callback.ts`） | ✅ 值域统一，**分类逻辑未统一**（见 3.3-R1） |
| **协议版本协商** | `protocol.json.versioning`（current=9, min=1, 9 条兼容矩阵 + 4 条演化规则） | — | `apps/admin-api/src/modules/executor/__tests__/protocol-version-consistency.spec.ts` + 双端 `PROTOCOL_VERSION = 9`（`apps/executor-node/src/config.ts:651`、`apps/executor-python/config.py:730`） | ✅ 已统一 |
| **就绪探针形状** | `protocol.json.readiness`（statusValues / httpStatus / payloadRules / 2 向量） | — | 双端 spec（`apps/executor-node/src/routes/health.spec.ts`、`apps/executor-python/tests/test_health.py`） | ✅ 形状统一，**端点全集未统一**（见 3.3-R4） |
| **超时语义（0 = 不限时）** | `protocol.json.timeout.vectors`（6 条） | — | 双端 spec | ✅ 已统一 |
| **secrets 键名闸向量** | `protocol.json.secrets.vectors`（16 条） | — | 双端 spec 对真实实现断言 | ✅ 值域统一，**实现仍是两份**（见 3.3-R2） |
| **params 键名闸 + 折叠冲突元数据** | `protocol.json.params.{vectors,keyUniqueness}` | — | 双端 spec | ✅ 同上 |
| **envForward 三桶** | `protocol.json.envForward.{common,runtimeOnly,neverForward}`（common 24 / node 2 / python 3） | — | 双端 spec | ✅ 名单统一，**实现仍是两份**（见 3.3-R2） |
| **信封拆包 / 错误体 detail 提取顺序** | `packages/contract-fixtures/contract.json`（`envelope` / `passthrough` / `statusRange` / `errorBody`） | — | **6 个消费点**（acf-cli / mcp-server / node-sdk / autoflow-sdk / admin-api `response-envelope-contract.spec.ts` / admin-api `channel-list-contract.spec.ts`） | ✅ 已统一 |
| **params→env 序列化（V2）** | `contract.json.executorEnvSerializationV2` | — | node spec + python spec + `param-env.ts` 注释互指 | ✅ 已统一 |
| **日志行切分** | `contract.json.executorLogLineSplitting` | — | node spec + python `test_logs.py` | ✅ 已统一 |
| **通知渠道表** | `contract.json.channelList` | — | admin-api `channel-list-contract.spec.ts` | ✅ 已统一 |

### 3.2 「两端各写一份、靠测试对齐」的清单（⚠️ 真实残留）

| # | 契约面 | 两份实现 | 靠什么对齐 | 残余风险 |
|---|---|---|---|---|
| **R-a** | **失败原因分类（文案正则）** | ① `apps/admin-api/src/modules/task/task.service.ts:1067` `inferFailureReason`（兜底，5 条正则）② `apps/executor-node/src/routes/execute.ts:855` `prepareFailureReason`（10 条规则）③ `apps/executor-python/routers/execute.py:570` `_refine_failure_reason`（**9 条规则**：interpreter_unavailable / timeout / package_fetch_failed / git_fetch_failed / dependency_install_failed / runtime_missing / executor_restart / **task_launcher→sandbox_unavailable** / sandbox_unavailable）+ 运行期专用 `runtimeSandboxStartupFailureReason`（node `execute.ts:1005`，python `execute.py:722` 起的 `_SANDBOX_STARTUP_FAILURE_RE`） | **只有注释互指**。node spec：`apps/executor-node/src/routes/prepare-failure-reason.spec.ts`；python spec：`apps/executor-python/tests/test_interpreter_failure.py` + `test_executor_protocol_contract.py:163`（穷举返回值 ⊆ 契约集）。**没有一条断言跨端「同一段文案 → 同一分类」** | **最高**。**已实测的跨端规则集差异**：<br>① node 多 `unknown`（兜底语义），python 返回 `None`（"不设 reason"）—— **同一语义的两种表达**；<br>② **python 多一条 `task_launcher`/`资源限制启动器` → `sandbox_unavailable` 规则**（`execute.py:713-715`），**node 侧完全没有**（实测 `grep -n "task_launcher\|资源限制启动器" apps/executor-node/src/routes/execute.ts` **零命中**）⇒ **同一段「资源限制启动器拒绝启动」文案在 python 侧归 `sandbox_unavailable`、在 node 侧落 `unknown`**（若 node 侧也用该启动器）；<br>③ node 的 sandbox 规则是**宽匹配** `/\btask_sandbox\|\bsandbox\b\|\bbwrap\b/i`（`execute.ts:970`），python 的是 `re.search(r"task_sandbox\|sandbox\|bwrap", lowered)`（`execute.py:717`）—— **边界不等价**（node 的 `\b` 词边界 vs python 无词边界） |
| **R-b** | **环境变量转发白名单** | ① `apps/executor-node/src/env-whitelist.ts` `ENV_WHITELIST`（26 条）+ `SECRET_ENV_DENYLIST` ② `apps/executor-python/routers/execute.py` `_ENV_WHITELIST` | 两侧各一个 spec，各自断言「自己 == common ∪ 自己的 runtimeOnly」+「common 与另一端解析结果逐项相等」 | 中。common 部分被两个 spec 双向断言，**相等性有保障**；但两边的 `neverForward` 剔除实现不同（node 有 `SECRET_ENV_DENYLIST` 显式剔除，python 只靠「不在白名单内」）——protocol.json `envForward.neverForwardReason` 自己承认了这个不对称 |
| **R-c** | **secrets 键名闸 + 保留名** | ① node `apps/executor-node/src/secret-env.ts` `SAFE_SECRET_NAME_RE` / `RESERVED_SECRET_NAMES` ② python `apps/executor-python/secret_env.py` `_SAFE_SECRET_NAME_RE` / `_RESERVED_SECRET_NAMES` | 两侧 spec 各自对 `protocol.json.secrets.vectors` 断言 | 中。两侧源码注释明确写「不是 python 自己的一份清单，是 node 侧的**镜像**」——**镜像靠人维护** |
| **R-d** | **params 键名闸** | ① node `apps/executor-node/src/param-env.ts` `isInjectableParamEnvKey` ② python `apps/executor-python/routers/execute.py:1917` `_PARAM_KEY_RE` + `:1920` `_is_injectable_param_key` | 两侧 spec 对同一份 `protocol.json.params.vectors` 断言 | 中。同 R-c，镜像靠人维护（**但两侧已因 EXEC-07 修过一次**：`python` 侧把 `^...$` 改成 `fullmatch`，node 侧 `$` 语义天然严格——说明这类镜像**已经漂过**，只是被测试抓到了） |
| **R-e** | **JSON.stringify 逐字节一致** | ① node `JSON.stringify`（语言原生）② python `apps/executor-python/js_json.py`（**手写 ECMA-262 Number::toString 实现**） | `contract.json.executorEnvSerializationV2` 向量 | 中。python 侧手写了 JS 数值格式化规则；新增数值形态（如 BigInt、-0）时可能再漂 |
| **R-f** | **就绪探针端点全集** | ① node `/health` `/health/live` `/health/admin-status` `/health/ready` ② python `/health` `/health/ready` `/health/readiness`(deprecated alias) | `protocol.json.readiness.perComponent` **只登记了 `/health/ready` 一条路径** | 中。node 的 `/health/live` `/health/admin-status` 与 python 的 `/health/readiness` alias **均不在契约里**，运维探针在三端写法不统一 |
| **R-g** | **CLI/MCP/SDK 对 admin-api 的错误体拆包** | 四个客户端各一份拆包实现 | `contract.json` 的 `envelope`/`passthrough`/`errorBody` 向量（**这是唯一真正四端共享的契约**） | 低。四端向量对账已在 |
| **R-h** | **admin-api 错误码 → CLI 处置类别** | 只有 CLI 有（`packages/acf-cli/src/error-code.ts` 6 类正则）；node-sdk / python SDK / MCP **无** | `packages/acf-cli/src/__tests__/error-code-coverage.test.ts`（`UNCLASSIFIED_BASELINE`） | 中。**四个客户端对同一后端错误的「人读处置建议」严重不对称**（见 §4.2） |

### 3.3 尚未收敛的残留 —— **不重复历史上已修的 EXEC-01~07**

> 已核对：`EXEC-01`（zod/pydantic 双生成）、`EXEC-02`（协议版本协商）、`EXEC-03`（回调 schema）、`EXEC-04`（超时 0 语义）、`EXEC-05`（envForward 三桶）、`EXEC-06`（数值字段严格）、`EXEC-07`（params 键名闸）均已在 `protocol.json` 登记 + 双端 spec 落地。**以下 4 条是新的**：

**R1（新增·最重）· 失败原因分类：三份正则，无跨端断言**
- 事实：node 10 条规则（`execute.ts:855-974`）/ python 9 条（`execute.py:570-720`）/ admin 5 条兜底（`task.service.ts:1081-1121`）。
- 已发生的真实错报：`apps/executor-node/src/routes/execute.ts` 注释记载 `uv venv timed out` 在 node 侧曾落 `unknown`、python 侧一直归 `dependency_install_failed`（双端分因漂移）；`apps/executor-python/routers/execute.py:600-620` 记载 `interpreters.py` 中文化后用全角括号「（…）」，python 侧旧正则只认 ASCII `\(…\)` ⇒ `_refine_failure_reason` 对**本仓自己抛出的异常**返回 `None`（落 unknown）。
- **共同根因**：三份规则都从**用户可见文案**反推语义。文案一改（尤其中文化后），分类静默失效。两侧已在注释里明确写了这句（`execute.ts:961-970`：「`timeout` 是唯一会被"用户文案改动"静默摧毁的语义」）。
- 影响面：127 个文件引用 `failureReason`（实测 `grep -rln "failureReason\|failure_reason"` 于 apps+packages，剔除 node_modules/.venv/dist/coverage）。
- ⇒ **本域最高价值的切口**。详见 §5。

**R2（新增）· 校验面清单（secrets / params / envForward）的「名单统一、实现两份」**
- 事实：`protocol.json` 登记了名单，但 node 与 python 各有一份**手写实现**（R-b/R-c/R-d）。
- 已发生的漂移证据：EXEC-07 本身就是一次「node 拒绝 / python 静默注入」的双端判定相反事故（`apps/executor-python/secret_env.py:40-52` 与 `apps/executor-python/routers/execute.py:1911-1928` 的注释记载）。
- 守卫形态：两侧 spec **各自**对同一份向量断言 → 「镜像实现漂了但两边各自测试都过」是**可能形态**（只有当某个向量恰好同时命中两侧且结果相同时才被抓）。
- ⇒ 建议：把「白名单/正则本身」也变成**生成物**（见 §6-A）。

**R3（新增）· `knownDivergence` 机制空转**
- 事实：`contract.json` 的 `knownDivergence` 段**只有一条**，且该条已关闭（`$comment` 明写「Divergence is closed; see `passthrough.stringCodeEnvelope`」）。`knownHeuristicEdge` 一条，注释说「这是 documented edge，不是 divergence」。
- 真实两端差异**没有进契约**的清单：
  1. **B4 `adminApiUrls`**：`packages/executor-protocol/protocol.json` 只在 `schemas.ConfigReloadRequest` 里声明了类型（`:675`），**没有登记「python 侧不实现且只列进 `ignored_fields`」这条差异**；`apps/executor-python/routers/config.py:78` 注释自己承认「只在 node 侧支持」。
  2. **B5 `deployedApps` / `installedPackages` / `registrationConflict`**：python 侧**恒缺席**（`apps/executor-python/scheduler.py:451-469`）。`protocol.json` 的 compatibilityMatrix v7/v8 条目里**有**登记（`executorImplementedBy` + `$comment` 说明了缺席），但登记在**版本矩阵**而非 `knownDivergence` 段——位置不统一，导致「查 knownDivergence 查不到」。
  3. **node 独有端点** `/health/live`、`/health/admin-status` vs python 的 `/health/readiness` alias（R-f）。
  4. **失败原因分类器规则集差异**（R1）。
- ⇒ **「knownDivergence 无限增长」的担忧在当前形态下并不成立**（因为根本没人在写它）；**真正的风险是「差异不登记 ⇒ 靠注释互指 ⇒ 漂移无声」**。

**R4（新增）· 契约源边界外的三块地**
- ① **admin-api 错误码表**（`apps/admin-api/src/common/errors/catalog/*.ts`，**427 个码**，实测 `grep -rhoE "^\s+[A-Z][A-Z0-9_]+:"` 计数）与 `protocol.json` **完全不相交** —— 两者管的是不同的枚举（一个管 HTTP 错误码，一个管执行失败原因），但**都在「契约」这个词的覆盖范围内却没有共同守卫**。已有的守卫 `check-error-i18n.mjs` 只管「码表 ↔ 前端词条」，**不管「码表 ↔ 客户端消费面」**。
- ② **admin-api ↔ CLI/MCP/SDK 的 API 契约**：由 openapi + `apps/admin-web/src/types/generated/api-types.ts`（**15147 行**）管，但**那只覆盖 admin-web 一个消费者**；CLI / MCP / 两个 SDK 的请求面**没有共享类型源**，全靠手写 + `contract.json` 的信封向量。
- ③ **`failureReason` 分类语义**（R1）—— 契约源管了值域，没管判定。

### 3.4 knownDivergence 的判定标准与治理建议

**判定「有意差异」vs「忘了收敛的漂移」的四条判据**（建议写进 `contract.json` 的 schema 约束）：

| 判据 | 「有意差异」 | 「忘了收敛的漂移」 |
|---|---|---|
| **D1 产品语义理由** | 差异**源于两端运行时的固有差异**（node 无 venv、python 无 npm），且**在两端各自都自洽** | 差异源于「实现偷懒」或「历史遗留」，两端**都能做但只有一边做了** |
| **D2 登记位置** | 差异登记在 `protocol.json` 的对应段（`envForward.runtimeOnly` / `compatibilityMatrix[i].$comment` / `knownDivergence`）**且带 reason 字段** | 差异只存在于**源码注释**里（本次 4 条残留全部如此） |
| **D3 可复核** | 有一对**共享向量**钉住「差异侧的期望行为」（如 `envForward.common` 被两端 spec 双向断言） | 无向量，只能靠读注释 |
| **D4 责任归属** | 有 issue / ADR 引用（仓内惯例：ARCH-33→ADR-016、ARCH-36→ADR-017、E-01→R31-B 等） | 无引用，或引用的是「将来做」而非「现在不做」 |

**逐条判定本域 4 条真实差异**：

| 差异 | D1 | D2 | D3 | D4 | 判定 |
|---|---|---|---|---|---|
| B4 `adminApiUrls`（node 支持 / python 忽略） | ✅ 两侧独立发版、python 无「多 URL 列表」消费方 | ❌ 只在 `schemas` 声明类型，未登记差异 | ❌ 无向量 | ⚠️ `OPEN-DECISIONS.md` 有条目但那是「待决策」不是「裁定」 | **忘了收敛的漂移（低危）** —— 至少要登记进 `knownDivergence` 并说明「谁负责补」 |
| B5 三键恒缺席（`deployedApps`/`installedPackages`/`registrationConflict`） | ✅ **有明确产品语义**：node 独有路由的事实源在 python 侧不存在；`registrationConflict` 是「无 409 观测就不造状态」的 fail-honest 裁定 | ⚠️ 登记在 `compatibilityMatrix` 的 `$comment`（**不在 `knownDivergence` 段**） | ✅ 有 `protocol.json:49/55` 的 `$comment` 说明 + `schemaVectors` | ✅ 有（v7/v8 条目 + 方案 b 裁定） | **有意的差异，但登记位置不统一** ⇒ 应**迁移**到 `knownDivergence` 段并保留 v7/v8 指针 |
| R-f 健康端点全集 | ❌ node 的 `/health/live`/`/health/admin-status` 与 python 的 `/health/readiness` alias **不是运行时差异，是实现遗漏** | ❌ 未登记 | ❌ 无向量 | ❌ 无 | **忘了收敛的漂移** |
| R1 分类规则差异 | ❌ 三份正则的差异**不是运行时固有**，是**同一语义被抄了三遍** | ❌ 未登记 | ❌ 跨端无向量 | ❌ 无 | **忘了收敛的漂移（最高危）** |

**是否需要一条守卫防止 knownDivergence 无限增长？**

**结论：需要，但不是「防增长」，而是「防不登记」。**

理由：
- 「防增长」的直觉诉求（棘轮只减不增）**在本仓当前形态下是伪需求** —— `knownDivergence` 只有 1 条且已关闭；真正的失败形态是**根本没人往里写**（R1/R-f/B4 全在注释里）。
- 建议的守卫形态（**新增** `scripts/check-known-divergence.mjs`）：
  1. **差异登记完整性**：扫描 `apps/executor-{node,python}/src|routers` 中带「parity / 恒缺席 / 只在…侧支持 / python 不实现」等**差异声明关键词**的注释，**每条必须能在 `protocol.json` 的某个段找到对应登记**；找不到 ⇒ 红（点名 `文件:行`）。
  2. **登记有效性**：`knownDivergence` 每条必须带 `reason` + `owner` + `since`（三字段缺一即红）—— 这把「有意差异」变成**有主的承诺**，而不是一句注释。
  3. **存量条目的棘轮**：`knownDivergence` 条目数**只减不增**（新条目必须显式登记进基线 JSON 并写理由）—— 这才是「防无限增长」的正当形态：**不许无声增长**。
  4. **状态机**：每条带 `status: "accepted" | "planned" | "rejected"`；`planned` 的条目必须带 issue 号，且**到期未动 ⇒ 红**（对齐仓内 `check-agent-event-causation` 的 `EXEMPTIONS` + proof marker 形态）。
- **与现有守卫的兼容性**：与 `check-failure-reasons.mjs`（值域四方比对）、`check-enum-drift.mjs`（TS⊆PG）**无冲突**——三者管的是不同维度（值域 / 存储层枚举 / 语义差异登记）。

---

## §4 四个 python 库：三方案对比 + 推荐

### 4.1 零消费者的**可复核证据**（三重取证）

**取证 ① — CodeGraph import 图**

```
$ codegraph query "autocodeflow_notify"
import autocodeflow_notify
  packages/autocodeflow-notify/tests/test_notify.py:8          ← 包自身测试
  packages/autocodeflow-notify/tests/test_audit_error_lifecycle.py:21  ← 包自身测试
file notify.py      packages/autocodeflow-notify/autocodeflow_notify/notify.py:1
file __init__.py    packages/autocodeflow-notify/autocodeflow_notify/__init__.py:1

$ codegraph query "autocodeflow_db"
import autocodeflow_db
  packages/autocodeflow-db/tests/test_audit_error_lifecycle.py:22   ← 包自身测试
  packages/autocodeflow-db/tests/test_audit_error_lifecycle.py:23
  packages/autocodeflow-db/tests/test_connection.py:7

$ codegraph query "autocodeflow_ai"
import autocodeflow_ai
  packages/autocodeflow-ai/tests/test_audit_error_lifecycle.py:22   ← 包自身测试
  packages/autocodeflow-ai/tests/test_analyzer.py:9

$ codegraph query "autocodeflow_http"
import autocodeflow_http
  packages/autocodeflow-http/tests/test_audit_error_lifecycle.py:24  ← 包自身测试
  packages/autocodeflow-http/tests/test_client.py:9
```

⇒ **四包的全部 import 命中都在包自身目录内**，仓内零外部消费者。

**取证 ② — 全仓文本检索（排除包自身）**

```
$ grep -rn -E "autocodeflow[_-](ai|db|http|notify)\b" . \
    --exclude-dir={node_modules,.git,.codegraph,autocodeflow-ai,autocodeflow-db,autocodeflow-http,autocodeflow-notify,.venv,__pycache__}
```
命中 **全部是注释与 CI 配置**，无一处是真实 import：
- `.github/workflows/release-please.yml:33,35`（注释说明四包退出 `v*` 命名空间）
- `.github/workflows/ci.yml:1564`（`matrix.package: [autocodeflow-http, autocodeflow-notify, autocodeflow-db, autocodeflow-ai]` —— **测试矩阵，不是消费者**）
- `scripts/ci-local.sh:281`（本地跑测试循环）
- `packages/autoflow-sdk/autoflow_sdk/{callback,http}.py`（**注释互指 parity**，见下）
- `packages/acf-cli/src/client.ts:158`、`packages/mcp-server/src/api.ts:53`、`packages/autocodeflow-node-sdk/src/http-client.ts:46-52,89,346,823`（**注释互指 parity**）

**取证 ③ — 运行时依赖装配**

```
$ cat apps/executor-python/requirements.txt
fastapi / uvicorn / httpx / psutil / tenacity / pydantic-settings / PyYAML / uv
   ⇒ 无任何 autocodeflow-* 依赖
$ ls apps/executor-python/.venv/lib/python3.12/site-packages/ | grep -i autocodeflow
   ⇒ （无输出，零命中）
$ cat apps/executor-python/.venv/lib/python3.12/site-packages/*.pth
   ⇒ 只有 coverage 的 process_startup 钩子，无 path 注入
$ ls apps/registry-pypi/packages/
   ⇒ 只有 autoflow-sdk（私有 PyPI 里也只托管 autoflow-sdk）
```

**关于「`.venv` 目录存在容易误判」的提醒**：`packages/autocodeflow-{ai,db,http,notify}/.venv` **确实存在**，但那是**每个包自己的开发虚拟环境**（各自 `uv.lock` + 各自 `pip install -e .`），**不是被 `apps/executor-python` 装配的**。`apps/executor-python/.venv` 的 site-packages 里**没有** `autocodeflow_*` 任何一项（上面第三条实测）。

**取证 ④ — `autocodeflow-db` 是否被间接使用？→ 明确否**

```
$ grep -rn -E "^(from|import) autocodeflow" apps/executor-python/ --include=*.py
   ⇒ （零命中）
$ grep -rn "SQLAlchemy\|sqlalchemy\|psycopg2" apps/executor-python/ --include=*.py --exclude-dir=.venv
   ⇒ （零命中；executor-python 根本不碰数据库）
$ grep -rn "sqlalchemy\|psycopg2" apps/admin-api/package.json apps/executor-python/requirements.txt
   ⇒ （零命中）
```
⇒ **`packages/autocodeflow-db` 零消费者，且 `apps/executor-python` 与 `apps/admin-api` 都不依赖 SQLAlchemy/psycopg2**（admin-api 用 TypeORM，`apps/executor-python` 无 DB 访问）。**结论：删除它不会破坏任何运行时路径。**

**取证 ⑤ — 但它们是「活的技术债载体」，不是死代码**

这是本报告**最关键的一手证据**，也是为什么「直接删」不是无脑选项：

`packages/autoflow-sdk/autoflow_sdk/http.py` 与 `packages/autocodeflow-node-sdk/src/http-client.ts` 的注释**逐字承认**它们的语义是从 `autocodeflow-http` 抄来的：

- `packages/autoflow-sdk/autoflow_sdk/http.py:5` —「响应体默认上限（字节），**与 packages/autocodeflow-http 的** …」
- `packages/autoflow-sdk/autoflow_sdk/http.py:97` —「**与 packages/autocodeflow-http 的 `_extract_error_body` 同构**」
- `packages/autoflow-sdk/autoflow_sdk/http.py:120` —「R31-E2 error-code surface（**与 packages/autocodeflow-http 的**…）」
- `packages/autoflow-sdk/autoflow_sdk/http.py:259` —「**与 `autocodeflow-http` / `autocodeflow-notify` 对齐**为懒初始化」
- `packages/autoflow-sdk/autoflow_sdk/http.py:287` —「**`autocodeflow-http` 的 `_get_client` 同款依据**」
- `packages/autoflow-sdk/autoflow_sdk/callback.py:216` —「现与 `autocodeflow-notify` / `autocodeflow-http` 对齐」
- `packages/autocodeflow-node-sdk/src/http-client.ts:46-52` —「与 python 回调客户端（**autocodeflow-http**）…两者行为…」
- `packages/autocodeflow-node-sdk/src/http-client.ts:89` —「B-4：重试 + 熔断配置（默认值与 **python autocodeflow-http/client.py 对齐**）」

⇒ **`autocodeflow-http` 的熔断/重试/50MB 响应体上限/`ProtocolError` 不重试 契约，是 `autoflow-sdk` 与 `node-sdk` 的「参考实现」**。删掉它 = 删掉**唯一的可运行参考实现**，留下一堆「与已删除包对齐」的注释（正是本仓反复治理的「注释里的 parity」形态）。

**版本与发布状态（实测）**

| 包 | pyproject version | release-please manifest | PyPI | CI 测试 | 仓内消费者 |
|---|---|---|---|---|---|
| `autocodeflow-ai` | `0.3.2`（`packages/autocodeflow-ai/pyproject.toml:7`） | `0.3.2` | **不存在**（`https://pypi.org/pypi/autocodeflow-http/json` → HTTP 404） | `ci.yml:1564` 矩阵 | **0** |
| `autocodeflow-db` | `0.3.2` | `0.3.2` | 未发布 | 同上 | **0** |
| `autocodeflow-http` | `0.3.2` | `0.3.2` | **HTTP 404（未发布）** | 同上 | **0** |
| `autocodeflow-notify` | `0.3.2` | `0.3.2` | 未发布 | 同上 | **0** |
| **平台主线** | — | `2.1.0`（`release-please-manifest.json` 的 `"."`） | — | — | — |

⇒ **四包从未真正发布到 PyPI**（404 实测），却已积累 `0.3.0 → 0.3.2` 三个 release-please 版本与完整 CHANGELOG。**release-please 在为没人能装的包发版**。

**规模**：源码 4 个包共 **4343 行**（ai 1356 / db 753 / http 1538 / notify 696，含测试）；`autoflow-sdk`（真正在用的 python SDK）3848 行。

### 4.2 三方案完整对比

| 维度 | **(A) 接进 PyPI 发布线** | **(B) 删除** | **(C) 降级为仓内私有包** |
|---|---|---|---|
| **改动文件清单** | ① `.github/workflows/release.yml`：version-guard 加 4 条（对齐 `:85-94` 格式）+ 新增 `publish-pypi` 矩阵加 4 项（对齐 `:218` 的 autoflow-sdk 条目）② 4 个 `pyproject.toml` 版本 `0.3.2 → 2.1.0`（或定 2.0.0）③ `release-please-manifest.json` 4 条版本 ④ `release-please-config.json` 的 4 个包条目（**已存在**，但 `extra-files` 只指向 `__init__.py`，需补 `pyproject.toml`）⑤ 4 个包的 README 补「安装 / 用途 / 与 `autoflow-sdk` 的关系」⑥ 4 个包的 CHANGELOG 补「从 0.3.2 跳到 2.x」的说明 ⑦ `docs/` 里加一节 ⑧ 4 个包的 `__init__.py` 版本常量（若有） ⑨ `scripts/check-publishable-wiring.mjs` 的 `UNWIRED_BASELINE` **删 4 条** | ① `rm -rf packages/autocodeflow-{ai,db,http,notify}`（含 `.venv`、`*.egg-info`、`uv.lock`）② `scripts/check-publishable-wiring.mjs` 的 `UNWIRED_BASELINE` **删 4 条** ③ `release-please-config.json` 删 4 个包条目（`:10-13` 的 linked-versions 组、`:35-38` 的 exclude-paths）④ `release-please-manifest.json` 删 4 条 ⑤ `.github/workflows/ci.yml:1564` 的 `python-packages-test` job 删（或整 job 删）⑥ `.github/workflows/release-please.yml:33-35` 的注释删 ⑦ `package.json` 删 4 条 `test:lib-*` script（`:test:lib-http`/`:test:lib-ai`/`:test:lib-notify`/`:test:lib-db`）⑧ `scripts/ci-local.sh:281` 的循环删 ⑨ **6 处「与 autocodeflow-http 对齐」的注释改写**（`autoflow-sdk/http.py:5,97,120,259,287`、`callback.py:216,334,336`；`node-sdk/http-client.ts:46-52,89,346,823`；`acf-cli/src/client.ts:158`；`mcp-server/src/api.ts:53`）⑩ `docs/` 里若有提及 | ① 4 个 `pyproject.toml` 加 `[tool.*]` 或改 `name`（如 `autocodeflow-internal-http`）② `scripts/check-publishable-wiring.mjs` 的 `publishableState()` 判定：现状是「有 `pyproject.toml` 即视为可发布」⇒ 必须**改判据**（识别「private」标记），否则仍会被判为未接线的可发布包 ③ 4 个包加 `private = true` 之类的标记（PEP 621 无 `private` 字段，需自定义约定）④ `release-please-config.json` 删 4 个包条目（否则 release-please 继续为它们发版）⑤ `release-please-manifest.json` 删 4 条 ⑥ CI job 可保留（测试仍要跑）⑦ `package.json` 的 `test:lib-*` 保留 |
| **影响面** | **+**：4 个包成为对外 API 承诺，**不可逆**（一旦发布，兼容性义务生效） | **−**：4343 行代码 + 4343 行测试消失；**6+ 处 parity 注释成为「引用已删除包」的悬空指针** | **0**：功能不变，仅改变「是否对外发布」的声明 |
| **CI 变更** | `release.yml` 加 8 条（4 version-guard + 4 publish）；`ci.yml` 可不动；`check-publishable-wiring.mjs` 基线删 4 条（否则「基线该瘦身」红） | `ci.yml` 删 1 个 job（矩阵 4 项）；`ci-local.sh` 删 1 个循环；`package.json` 删 4 条 script | `release-please` 删 4 个包条目；`check-publishable-wiring.mjs` **改判据本体**（新增「私有包」概念） |
| **用户可见后果** | PyPI 上出现 4 个新包（`pip install autocodeflow-http` 可用）。**对任务用户是净收益**（这四包正是写给任务脚本用的：HTTP 客户端/DB 会话/通知/AI 分析） | **无用户可见后果**（无人用过）。但**丢失**了一个「给任务脚本用的官方库」的产品位 | **无用户可见后果**。任务用户仍无法 `pip install autocodeflow-http`（私有包在 `apps/registry-pypi` 里也没有托管 —— 实测 `apps/registry-pypi/packages/` 只有 `autoflow-sdk`） |
| **不可逆点** | **⚠️ 发布到 PyPI 是不可逆的**（包名一旦占用，PyPI 不允许删除，只能 yank；且 `autocodeflow-db` 这个名字可能已被他人占用）。且 `autocodeflow-ai` 0.3.2 → 2.x 的**语义化跳版**会让未来 `pip install autocodeflow-ai>=1` 的用户拿到行为不同的版本 | **删除是 git 可逆的**（`git revert`），但 **PyPI 上已有同名包的风险不适用**（本仓未发布 ⇒ 无此风险）。**真正的不可逆是「参考实现消失」**——`autoflow-sdk` / `node-sdk` 的 6+ 处「与 autocodeflow-http 对齐」注释失去参照，未来对齐谁？ | **可逆**（改回可发布即可）。唯一「准不可逆」是改 `check-publishable-wiring.mjs` 判据本体（新增「私有包」概念）——但那是**正向能力**（守卫从此能区分「不发布是有意的」与「忘了发布」） |
| **风险** | **高**：① PyPI 包名占用（`autocodeflow-*` 前缀未验证）② 语义化跳版（0.3.2 → 2.x）暗示 API 稳定承诺，而实际上它们零消费者、从未被真实使用 ③ 发布后任何 bug 都是对外事故 ④ 需要真实的 PyPI 凭证与发布流水线 | **中**：① 丢参考实现 ② parity 注释悬空 ③ `uv.lock`/`.egg-info`/`.venv` 删除后无法复现本地环境 | **低**：功能零变化，但**没解决根因**（四包仍然是死代码、仍需人维护、仍与 `autoflow-sdk` 重复实现） |

### 4.3 推荐：**方案 (C) 降级为仓内私有包** —— 但要加一条裁剪

**推荐 (C) 的理由**：

1. **(B) 删除的代价被低估**。四个包不是死代码：`autocodeflow-http` 的熔断/重试/50MB 上限/`ProtocolError` 契约是 `autoflow-sdk`（3848 行，在用）与 `node-sdk` 的**参考实现**，且被 6+ 处注释逐字引用。删掉它 = 把「注释里的 parity」变成「注释里指向虚空的 parity」——**正是本仓反复治理的那类腐烂**。而且 `autocodeflow-db` 的「短进程友好连接池」（`pool_size=2 / max_overflow=0`）是**有产品价值的设计**，删了可惜。
2. **(A) 发布的代价被低估**。`autocodeflow-*` 这个 PyPI 名前缀**未验证可用**（`autocodeflow-http` 已实测 404 ⇒ 未被本仓占用，但**可能已被他人占用**——PyPI 命名空间是全局的，本仓无权假定可用）。发布后 `0.3.2 → 2.x` 的跳版会对从未真实使用过的 API 施加**语义化版本承诺**，而这些 API 的真实 bug 面（0 消费者 ⇒ 从未被真实场景验证过）恰恰最大。
3. **(C) 保住全部资产、切断全部对外承诺、且让守卫判据变强**。改完 (C) 后：
   - `check-publishable-wiring.mjs` 的 `publishableState()` 从「有 `pyproject.toml` ⇒ 可发布」升级为「有 `pyproject.toml` **且未标私有** ⇒ 可发布」。**守卫因此获得新能力**：它从此能区分「这个包不发布是**有意的**（标了 private）」与「这个包忘了发布（没标）」。这是**净增的守卫能力**，不是绕过。
   - `release-please-config.json` 删 4 个包条目 ⇒ release-please **不再为没人能装的包发版**（当前 0.3.0/0.3.1/0.3.2 三个版本就是这么攒出来的）。
   - CI 矩阵保留 ⇒ **测试仍跑**（4343 行代码的回归防护不丢）。

**但 (C) 有个必须说清的残余**：(C) 之后这四包仍是**零消费者的重复实现**，`autoflow-sdk` 与它们的能力重叠（`autoflow_sdk/http.py` 与 `autocodeflow_http/client.py` 都做重试+熔断+响应体上限）。因此推荐 (C) **并配一条裁剪路线**：

- **(C-1)（立即）**：按 (C) 降级 + 改守卫判据 + release-please 摘除。
- **(C-2)（下一轮，需拍板）**：把 `autoflow-sdk` 内的重试/熔断/响应体上限**收敛成一份实现**（抽到 `packages/autoflow-sdk` 内的一个模块，或反过来让 `autoflow-sdk` 依赖 `autocodeflow-http`——**但后者会引入「私有包进公共 SDK 依赖」的问题，不可取**）。落地后 `autocodeflow-http` 的「参考实现」角色由 `autoflow-sdk` 承担，**删除 (B) 重新变得安全**。
- ⇒ **推荐路径 (C) → (C-2) → (B)**。这样 (B) 的不可逆点被推迟到「有第二份实现可对照」之后。

**明确不建议 (A) 的额外理由**：四个包从未发布（PyPI 404 实测）、零消费者、且 `packages/registry-pypi`（私有 PyPI 服务，`apps/registry-pypi/main.py`）**只托管 `autoflow-sdk`**。若产品真要给任务脚本提供这些库，**正确路径是接私有 PyPI（registry-pypi）而非公共 PyPI**——这是 (A) 的一个**改良变体 A′**，但 A′ 需要 registry-pypi 支持多包托管（实测 `apps/registry-pypi/packages/` 只有 `autoflow-sdk`），成本高于 (C)。**若产品确有「任务脚本要能 pip install」的需求，请把 A′ 作为独立议题提给主Agent 拍板**（见 §11-D3）。

---

## §5 错误码结构化迁移方案（双轨 + 影响面）

### 5.1 一页纸结论

**结论：应把「失败原因」从文案正则改为结构化码（`failureReason` 字段已经存在，但它的「填充逻辑」是三份正则）。迁移方向不是「新增一个 code 字段」，而是「让三份正则产出的码由后端下发/统一生成，而不是各自猜」。**

关键澄清（这是本节最重要的判断）：**`failureReason` 这个结构化字段早就存在且已是协议字段**（`protocol.json.schemas.CallbackPayload.properties.failureReason.enum` 12 值、`protocol.json.failureReason.executorReportable` 12 值、admin 的 `task_executions.failure_reason` 列、admin-web 的 `FAILURE_REASON_T_KEYS` 15 值映射）。**真正的问题不是「有没有 code 字段」，而是「code 是怎么被决定出来的」**：

```
执行器侧：文案 →（本端正则）→ failureReason 码  ← 三份正则，规则不同
admin 侧：文案 →（admin 正则兜底）→ failureReason 码  ← 第四份语义来源
admin-web：码 →（FAILURE_REASON_T_KEYS）→ i18n 词条  ← 这一段是好的
```

⇒ **迁移的靶心 = 把「文案 → 码」的判定从三份正则收成「一份可生成的规则集 + 一份码表 + 一个可测的分类契约」**。

### 5.2 双轨迁移设计

#### 阶段 D1：结构化码表下发（后端是唯一事实源）

| 项 | 设计 |
|---|---|
| **码表位置** | **后端** `apps/admin-api/src/common/errors/catalog/` 已有 427 码（错误码面）；**失败原因码表**目前住在 `packages/executor-protocol/protocol.json.failureReason`（15 值）。**决策**：失败原因码表**继续留在 `protocol.json`**（它是**跨端线缆契约**，不是 admin 内部错误码），但**升级为带元数据的码表** |
| **元数据形态** | `protocol.json.failureReason` 从 `string[]` 升级为对象数组：`{ code, label: {zh, en}, owner: "executor"|"admin", reportable: bool, parent?: string, remediationKey?: string }`。**理由**：admin-web 的 `FAILURE_REASON_T_KEYS`（`apps/admin-web/src/utils/failure-reason-label.ts:22-44`）现在是**前端手写的第三份映射**；码表带 i18n key 后可由 `gen-error-i18n.mjs` 同款机制生成 |
| **生成链** | 复用既有 `scripts/generate-executor-protocol.mjs` 的双生成器：新增 `failureReason` 段 → 生成 node `FailureReason` 联合类型 + python `FailureReason` Literal 集 + **admin-web 的 `FAILURE_REASON_T_KEYS`**（第三份生成物） |
| **CI 闸** | 现有 `executor-protocol-drift` job（`ci.yml:1344-1358`）**只 diff `apps/executor-node/src/generated` 与 `apps/executor-python/generated`** ⇒ **必须扩到 admin-web 生成物**（R11 已裁定 admin-web 类型只减不增，但**生成物**不是手写类型，扩 diff 范围不违反 R11） |
| **兼容性** | `failureReason` 的**枚举值集合不变**（15 值不动）⇒ **不 bump `protocolVersion`**（`protocol.json.versioning.evolutionRules` 第 2 条：只有删字段/改语义/改枚举才必须 bump；加元数据不改线缆形状） |

#### 阶段 D2：分类规则生成化（消灭三份正则）

| 项 | 设计 |
|---|---|
| **规则源** | `protocol.json.failureReason.classifiers` 段：每条 `{ code, priority, matchers: [{pattern, flags, lang: "en"\|"zh"\|"both"}] }`。**用 JSON Schema 受控子集**表达（与既有 `schemas` 段同一套 `SUPPORTED` 白名单机制，`generate-executor-protocol.mjs:44-57`） |
| **生成物** | ① node `src/generated/failure-classifier.ts`（正则数组 + `classifyFailureReason(text): FailureReason \| null`）② python `generated/failure_classifier.py`（同构）③ **admin-api 的兜底分类器**（第三份！） |
| **语义等价性保证** | 生成物用**同一份 matcher 列表** ⇒ 三端**逐字同形**。跨端一致性由**共享向量**（新 `contract.json.failureClassification` 段，append-only）断言：同一批输入文本 → 三端产出同一码 |
| **兼容性** | **生成的分类器**与**现有人工正则**行为**不完全等价**（现有人工正则有大量「注释里解释的历史修补」）⇒ 迁移期必须**双跑比对** |

#### 阶段 D3：双轨期（兼容期）设计

| 环节 | 双轨形态 | 收敛判据（度量，不是人肉） |
|---|---|---|
| **执行器 → admin 回调** | 回调载荷**同时**带：① `failureReason`（新码）② `failureReasonLegacy`（**旧文案原样**，不改一个字）③ `failureReasonSource: "classifier" \| "legacy-regex"`（**标明这码是怎么来的**） | 新增指标 `autoflow_failure_reason_source_total{reason, source}`；**收敛判据：classifier 来源占比 ≥ 99% 且连续 7 天** |
| **admin 落库** | `task_executions.failure_reason`（**新码**，现有列，零迁移）**+** `failure_reason_legacy`（新可空列，存旧文案派生码） | 新增指标 `autoflow_failure_reason_mismatch_total{legacy, new}`（**两者不一致的次数**）；**收敛判据：mismatch 率 = 0 且连续 7 天** |
| **admin 兜底分类** | `inferFailureReason` **保留**，但①优先用回调带来的 `failureReason`（**已是现状**：`cb.failureReason ?? this.inferFailureReason(...)`）②当回调**无**码时走**生成的**兜底分类器（替代手写正则）③旧手写正则**降级为第三级兜底** | 兜底命中率：新增指标 `autoflow_failure_reason_fallback_total{stage: "generated"\|"legacy-regex"\|"none"}`；**收敛判据：legacy-regex 占比 = 0** |
| **admin-web 读面** | `FAILURE_REASON_T_KEYS` 改为**生成物**（D1）⇒ 前端映射不再是手写第三份 | 既有 `apps/admin-web/src/__tests__/dashboard-failure-reason-label.test.ts` 保持绿（生成物逐字节等价） |
| **admin-web 展示** | **不改**：用户看到的分类标签**逐字节不变**（因为码值集合不变、映射等价） | 现有 `apps/admin-web/src/__tests__/` 全套绿 |

**双轨期的双向兼容保证（明确回答主Agent 的问题）**：
- **向后兼容**（新 admin ← 旧执行器）：旧执行器只发旧文案、不发 `failureReason` ⇒ admin 走**生成的兜底分类器**（D2）+ 旧正则兜底 ⇒ 与今天行为等价。**零破坏**。
- **向前兼容**（旧 admin ← 新执行器）：新执行器**继续发旧文案**（`failureReasonLegacy` 字段**只是附加**，文案本身逐字节不变）⇒ 旧 admin 的 `@IsIn` 校验与文案解析**不受影响**。**零破坏**。
- ⇒ **双向兼容期 = 无需客户端升级**，这是本方案最关键的设计约束。

#### 阶段 D4：收敛（砍掉旧轨）

- 条件：`legacy-regex` 兜底占比 = 0 **且** mismatch = 0 **连续 7 天**（**度量驱动，不是人肉核对**）。
- 动作：① 删 admin 旧手写正则（`task.service.ts:1067-1122` 的 `inferFailureReason` 里的 7 条正则）② 删执行器侧的**旧正则**（node `prepareFailureReason` / python `_refine_failure_reason` 整体替换为生成物）③ 删 `failureReasonLegacy` 字段的**发送**（保留接收兼容若干版本）④ `task_executions.failure_reason_legacy` 列按保留期清理。

### 5.3 影响面量化

| 对象 | 数量 | 证据 |
|---|---|---|
| **引用 `failureReason` / `failure_reason` 的文件** | **127** | `grep -rln "failureReason\|failure_reason" --include=*.ts --include=*.tsx --include=*.py apps packages`（剔除 node_modules/.venv/dist/coverage），实测 127 |
| **分类器实现（手写正则）** | **3 份**，共 **约 24 条规则**（admin 5 / node 10 / python 9）+ 2 处运行期专用扫描器（node `runtimeSandboxStartupFailureReason` / python `_SANDBOX_STARTUP_FAILURE_RE`） | `task.service.ts:1081-1121`；`execute.ts:855-1010`；`execute.py:570-760` |
| **协议枚举值** | 15（全集）/ 12（可上报）/ 3（admin 内部专用） | `protocol.json.failureReason` |
| **admin-web 读面映射** | 1 处手写映射（15 条） | `apps/admin-web/src/utils/failure-reason-label.ts:22-44` |
| **i18n 词条** | zh + en 各 15 条 | `apps/admin-web/src/locales/{zh,en}.ts` 的 `execDetail.failure.*` |
| **实体列** | 1 列（`task_executions.failure_reason`）+ 需新增 1 可空列（legacy） | `apps/admin-api/src/modules/task/entities/task-execution.entity.ts` |
| **守卫** | `check-failure-reasons.mjs`（四方值域比对）+ `check-error-i18n.mjs`（码表↔词条）—— **两者都不管分类逻辑** | `scripts/check-failure-reasons.mjs:58-61` |
| **生成链改动点** | `generate-executor-protocol.mjs`（+1 段、+2 emitter） | `scripts/generate-executor-protocol.mjs:44-57` SUPPORTED 白名单 |

### 5.4 与既有守卫的兼容性（主Agent 特别要求）

| 守卫 | 与本方案的关系 | 需要的改动 |
|---|---|---|
| `check-failure-reasons.mjs`（四方值域比对） | **兼容**。D1 只加元数据、**不改枚举值集合** ⇒ 四方比对仍绿 | 若把 `failureReason` 从 `string[]` 改成对象数组，**该守卫的解析逻辑会失效**（它从 `protocol.json.failureReason.all` 抽字符串）⇒ **必须同批改守卫的解析**（改成抽 `.code`），否则守卫会「解析不到 ⇒ 结构红」。这是**必须同批**的改动 |
| `check-error-i18n.mjs` | **兼容**（管的是 admin 错误码 427 个，不是失败原因 15 个） | 无 |
| `check-enum-drift.mjs`（TS ⊆ PG） | ⚠️ **需检查**：`ExecutionFailureReason` 若被 PG enum 承载，生成物的**联合类型**形态可能被扫描器识别为「枚举声明」但不在 `TS_TO_PG` 映射里 ⇒ **覆盖自检会红**（该守卫要求「每个扫到的枚举要么映射要么带理由豁免」）。**必须同批跑 `--report` 看覆盖去向** | 同批处理（映射或豁免） |
| `check-enum-consumers.mjs` | **兼容**（扫 `apps/admin-api/src` 的数组字面量） | 若生成物移出 admin-api src，扫描面变化需复跑 |
| `check-metric-docs.mjs` | ⚠️ **需注意**：D3 新增 3-4 个指标（`autoflow_failure_reason_source_total` 等）⇒ **必须同批进文档或进基线**（该守卫 B 类判据：注册表里有、文档从未提及 ⇒ 红；基线只减不增 ⇒ **新增必须显式登记进 `scripts/metric-docs-baseline.json`**，而该文件头注写「禁止手改把新指标塞进来」）⇒ **必须走 `npm run check:metric-docs -- --update`** 或补文档 | 同批 |
| `check-alerts-rules.mjs` | **兼容**（新指标若被 dashboard/告警引用需登记） | 若不引用则无改动 |
| `executor-protocol-drift` CI job | ⚠️ **需扩范围**：当前 diff 只覆盖 `apps/executor-node/src/generated` 与 `apps/executor-python/generated` ⇒ **admin-web 的新生成物不在 diff 范围** ⇒ 需扩 diff 路径 | 同批 |

---

## §6 补丁 vs 重构对比（五维评分表）

> 评分：1（差）– 5（好）。**长期收益 > 短期成本 ⇒ 推荐重构**。风险极高处标【临时补丁，后续排期重构】。

### 6.1 候选 A：失败原因结构化码（D2/D3/D4 全套重构）

| 维度 | 评分 | 理由 |
|---|---|---|
| **长期收益** | **5** | 消灭 3 份正则（≈24 条规则）⇒ 三端逐字同形；中文化/文案改动不再能静默摧毁分类语义；「同一段文案 → 同一分类」成为**可断言的向量**而非注释承诺 |
| **维护成本** | **3** | 迁移期**双轨**（生成器 + 旧正则并存）成本最高；收敛后**大幅下降**（改一条规则 = 改 `protocol.json` 一处） |
| **扩展潜力** | **5** | 新增分类 = 协议源加一条 + 重跑生成器；可自然扩展到「子分类」「父类」「严重度」等维度 |
| **技术债风险** | **2** | **高**：① `protocol.json` 的受控子集要扩（`matchers` 段引入正则字符串 ⇒ 生成器要转义与校验）② 跨语言正则语义差异（JS regex vs Python `re`：**lookbehind 支持、`\w` 语义、Unicode 属性**都不同）⇒ **同一份 matcher 列表不能在两个语言里保证逐字等价** |
| **短期成本与风险** | **2** | 高：3 份实现替换 + 生成器扩展 + 4 个既有守卫同批改 + 3 个指标进文档 |

**⇒ 判定：长期收益(5) > 短期成本(2) ⇒ 推荐重构**，但**必须按 §5.2 的 D1→D4 分阶段**，且 **D1（码表元数据 + 生成）与 D2（分类器生成）分两批**。

**★ 关键技术风险（本报告的诚实评估）**：**跨语言正则不是同一门语言**。JS `RegExp` 与 Python `re` 在 `\w`（Python 默认 Unicode）、`$`（Python 允许尾随换行——EXEC-07 已经踩过这个坑！）、lookbehind 宽度、Unicode 属性上都有差异。本仓**已经因为这件事付过一次代价**（`apps/executor-python/secret_env.py:40-52` 记载：`^...$` 在 Python 上放行 `"FOO\n"`，node 侧拒绝）。⇒ **D2 的 matcher 列表必须限定在「两语言语义一致的子集」**（建议：只用字面量 + 字符类 + 显式锚点 + `fullmatch` 等价写法；禁用 lookbehind、禁用 `$`、禁用 Unicode 属性），并**由共享向量双端断言**。
⇒ **实证支持**：node 的 sandbox 规则用了 `\b` 词边界而 python 的没有（`execute.ts:970` vs `execute.py:717`）—— 这正是「同一份 matcher 列表在两语言不等价」的**现存实例**，D2 的子集校验必须能挡住这类写法（建议：**禁用 `\b`**）。

### 6.2 候选 B：四个孤立 python 库

| 维度 | 评分（方案 C） | 理由 |
|---|---|---|
| **长期收益** | **4** | 切断 4 个「从未发布却在发版」的包；**升级守卫判据**（能区分「有意私有」vs「忘了接线」）⇒ 守卫能力净增；保留 4343 行有产品价值的实现与参考实现 |
| **维护成本** | **4** | 降级后维护成本不变（仍在维护），但**停止为没人装的包发版**（省下 release-please 的版本编排） |
| **扩展潜力** | **3** | 若产品要「任务脚本能 pip install」，(C) 不解决 ⇒ 需另开 A′ 议题 |
| **技术债风险** | **3** | 残余：四包仍是零消费者的重复实现，与 `autoflow-sdk` 能力重叠 |
| **短期成本与风险** | **5** | 极低：改 4 个 pyproject + 1 个守卫判据 + 2 个 release-please 配置 |

**⇒ 长期收益(4) > 短期成本(5)? 否（4 < 5）** ⇒ **按「补丁 vs 重构」的口径，(C) 本身是「低成本的正确止血」**，不是重构。**真正的重构是 (C-2)（把 `autoflow-sdk` 的重试/熔断收敛成一份实现），评分 4 / 3 / 4 / 3 / 2 ⇒ 推荐重构，但排在 D 之后。**

### 6.3 候选 C：knownDivergence 治理守卫

| 维度 | 评分 | 理由 |
|---|---|---|
| **长期收益** | **4** | 把「差异只在注释里」变成「差异必须登记且有主」；四条判据（D1-D4）可直接复用为本仓的差异登记模板 |
| **维护成本** | **4** | 一个零依赖 node 脚本 + 一份基线 JSON |
| **扩展潜力** | **4** | 可推广到全仓的「声明式差异」面 |
| **技术债风险** | **3** | 关键词扫描有假阳性（「parity」出现在纯技术说明里）⇒ 需要人工确认期 |
| **短期成本与风险** | **4** | 低 |

**⇒ 长期收益(4) > 短期成本(4)? 持平偏正** ⇒ **推荐做，但列为 P2**（它防的是「未来的漂移」，不修当下的漂移）。

### 6.4 候选 D：指标一致性（漏网之鱼）

| 维度 | 评分 | 理由 |
|---|---|---|
| **长期收益** | **3** | 统一两份清单口径后，「dashboard 引用了不存在的指标」这类静默空图被永久钉死 |
| **维护成本** | **5** | 几乎零成本（复用既有脚本的清单抽取逻辑） |
| **扩展潜力** | **3** | 有限 |
| **技术债风险** | **2** | 中：两份清单的差集有 22 项（含 `autoflow_db_pool_*` 等真实存在的指标），统一口径时**必须逐项判定「在哪个文件里」**，否则会误判 |
| **短期成本与风险** | **4** | 低 |

**⇒ 长期收益(3) vs 短期成本(4)** ⇒ **属于「值得做但不紧急」**。**且实测发现：现有守卫其实已经覆盖了大部分**（见 6.5）——`check-alerts-rules.mjs` 的清单含 `INFRA_METRICS` 白名单（62 个指标）⇒ **dashboard 引用但不在 `runtime-metrics.ts` 的 22 个指标其实全在 `INFRA_METRICS` 或 `prometheus-metrics.service.ts` 里**。⇒ **真漏网之鱼比我最初估计的少**。

### 6.5 指标一致性实测（§6 候选 D 的证据）

**实测 1 — `check-alerts-rules.mjs`（守卫，含 dashboard）**：
```
$ node scripts/check-alerts-rules.mjs
✓ config/monitoring/alerts.yml：1 个 group / 39 条规则全部通过结构、指标名、runbook_url 与 expr 静态体检
✓ docs/observability/grafana-dashboard.json：面板与模板变量引用的指标全部在清单内（指标清单 62 个）
✓ docs/observability/alerting-rules.yml：指标名对账通过 + 语义级对账通过
✓ 告警/看板同源守卫全绿（指标清单 62 个含 INFRA 白名单；gauge 清单 23 个；expr 体检覆盖 39 条规则；warn 0 条）
EXIT=0
```
⇒ **dashboard ↔ 告警 ↔ 指标清单 这条链已被守卫钉死**。这是本域**守卫质量最高**的一面。

**实测 2 — `check-metric-docs.mjs`（文档 ↔ 注册表）**：
```
$ node scripts/check-metric-docs.mjs --report
注册表 52 个指标（counter 23 / gauge 4 / service 25）；扫描 235 篇文档（排除 docs/archive/**）
未文档化的指标：0 个（全部已在基线里，属已登记欠账）
allowlist 命中：50 处（autoflow_sdk 40 处 / autoflow_arch31o_ / autoflow_test / autoflow_use_external_api / autoflow_admin_uploads / autoflow_npm_data）
前缀引用（合法）：6 处
行内豁免（每处都必须有理由）：4 处
EXIT=0
```
⇒ **文档 ↔ 注册表**双向也已钉死（未文档化 = 0）。

**实测 3 — 漏网之鱼的真实边界**：
我用「注册表两文件（52 个）」对比「Grafana dashboard（24 个）」，得到 **dashboard 引用但不在两文件里的 22 个**：
```
autoflow_db_pool_active_connections / _idle_connections / _max_connections / _waiting_requests
autoflow_execution_callback_auth_total
autoflow_executor_disk_usage_percent / autoflow_executors_online / autoflow_executors_total
autoflow_http_request_duration_ms_{bucket,count,sum} / autoflow_http_requests_total
autoflow_queue_depth / autoflow_queue_up
autoflow_scheduler_last_tick_duration_ms / _tick_duration_ms_total / _ticks_total
autoflow_scheduler_trigger_latency_ms_{bucket,count,sum} / _triggers_skipped_total
```
⇒ **但这 22 个全部在 `prometheus-metrics.service.ts` 里**（我第一次比对时把 `name: "..."` 的正则切歪了，误判它们「不在注册表」；修正后：**这 22 个是 `prometheus-metrics.service.ts` 的 `name:` 字面量，check-metric-docs 的 52 个里已含 service 25 个**）。**⇒ 严格意义上「dashboard 引用了不存在的指标」= 0 个。**

**真正的漏网之鱼（3 类）**：

| # | 漏网形态 | 证据 | 影响 |
|---|---|---|---|
| **M1** | **两份清单口径不同**：`check-alerts-rules.mjs` 的清单 = 两个注册表文件 + `INFRA_METRICS` 白名单（**62**）；`check-metric-docs.mjs` 的注册表 = 两个注册表文件（**52**）。差集 **10 个** 是 `INFRA_METRICS`（`up` / `redis_*` / `process_*` / `nodejs_*`）⇒ **同一批指标在两个守卫里口径不一致** | `scripts/check-alerts-rules.mjs:109-125`（`INFRA_METRICS` Map）vs `scripts/check-metric-docs.mjs` 的 `COUNTERS_SOURCE`/`SERVICE_SOURCE` 两文件 | 中：一个指标被删时，`check-alerts-rules` 可能因 `INFRA_METRICS` 仍在而放行 |
| **M2** | **admin-web 指标面零守卫**：`apps/admin-web/src` 里**只出现 1 处** `autoflow_*` 形态的标识符（`api-types.ts:2599` 的一段描述文字里的 `autoflow_scheduler_*` / `autoflow_queue_*` 前缀），**没有任何 admin-web 代码按指标名消费 Prometheus** ⇒ **admin-web ↔ 指标名的一致性目前无需守卫**（它走的是 `/api/metrics` 的结构化 DTO，不是 Prometheus 文本） | `grep -rn "autoflow_[a-z0-9_]*" apps/admin-web/src` 只有 1 命中（描述文字） | 低（**不是缺口，是事实**：admin-web 不消费指标名） |
| **M3** | **dashboard ↔ 注册表的**「反向**」**未覆盖**：`check-alerts-rules.mjs` 只查「dashboard 引用的指标**存在**」；**不查「注册表里新增的指标**是否该进 dashboard**」**。实测注册表 52 个中 **28 个未被任何 dashboard 面板引用**（14 个 agent 指标 + `autoflow_ai_*` + `autoflow_callback_business_total` + `autoflow_notification_delivery_total` + `autoflow_sse_*` + `autoflow_metrics_streams_*` + `autoflow_push_auth_retry_total` + `autoflow_stale_finalization_deferred_total` + `autoflow_scheduler_cron_slots_missed_total` + `autoflow_scheduler_dependency_triggers_total` + `autoflow_scheduler_misfires_skipped_dependencies_total` + `autoflow_scheduler_triggers_total`） | 实测差集 | **低-中**：新指标不上看板不一定是缺陷（可能是内部指标）；但「内部 vs 对外」的区分**当前没有任何机制**，全靠人知道 |

**⇒ 对第 6 项的最终判定**：**「指标名 ↔ 运行时注册表」的历史守卫不仅存在，而且质量相当高（两条守卫 + 一个 label 取值 spec，三条都绿）**。**真漏网的是 M1（两份清单口径差 10 个）与 M3（无「内部指标 vs 对外指标」区分机制）**，都不是「某指标已删但 dashboard 仍引用」这类硬缺陷（实测 0 个）。**⇒ 第 6 项不应作为本域的主要切口**。

---

## §7 开源参考清单

> **AGPL-3.0-only 兼容性判定口径**：
> - ✅ **兼容**：仅作为**开发期工具**（独立进程调用，不链接进产物）；或生成物为**本仓自有内容**（生成器的输出版权归本仓，或上游明确授予无传染性许可）。
> - ⚠️ **需谨慎**：生成物/衍生作品的许可证归属需逐个确认。
> - ❌ **不兼容**：许可证为 SSPL / BSL / 专有（且非「独立进程调用」形态）。

| 方案 | 仓库地址 | License | AGPL 兼容性 | 核心亮点 | 可复用点 | 缺陷 | 适配成本（本仓） |
|---|---|---|---|---|---|---|---|
| **OpenAPI Generator** | https://github.com/OpenAPITools/openapi-generator | **Apache-2.0**（GitHub API 实测 `spdx_id: Apache-2.0`） | ✅ **兼容**（开发期工具，独立进程；生成物归属需在 `config` 里确认，但 Apache-2.0 的生成物通常无传染性） | 30+ 语言 SDK 生成器；生态最成熟；模板可定制 | ① **Python SDK 生成**（`python` generator）可替 `autoflow-sdk` 手写 HTTP 客户端 ② **TS SDK 生成** ③ 配置化 generator 模板可做「自定义错误码处理」 | ① **Java 运行时依赖**（重）② 生成代码风格与手写代码风格差异大，混用需纪律 ③ 大量 generator 产出的代码**没有运行时校验**（只是类型）④ 对「协议演进兼容性」无强制 | **中-高**。本仓已有 openapi + `openapi-typescript`（前端），但 **CLI/MCP/两个 SDK 都没有生成链**。若用它生成四端 SDK ⇒ 需要先让 openapi 描述**全部** admin-api 端点（当前 openapi 是 Nest 自动生成，描述质量参差） |
| **Buf / protobuf** | https://github.com/bufbuild/buf | **Apache-2.0**（实测） | ✅ 兼容（CLI 工具 + 运行时库）**但见重量级评估** | ① `buf breaking` 破坏性变更检测 ② `buf lint` 风格规则 ③ `buf generate` 多语言生成 ④ BSR（Buf Schema Registry） | ① **breaking change detection** 的思路可借鉴到本仓 `protocol.json`（新增「协议破坏性变更检测」守卫） | ① **重量级**：要引入 `.proto` 定义 + protoc 插件链 + 两端运行时（node `protobufjs`/`@bufbuild/protobuf`、python `protobuf`/`bufbuild`）③ **既有 JSON 线缆要迁移**（本仓协议是 JSON，迁移 = 双协议期）④ **调试成本**：线上抓包从 JSON 变二进制，运维排障工具链全部重做 ⑤ 学习曲线 | **❌ 高（重量级路线）**。**诚实评估**：本仓的协议是 **JSON over HTTP + SSE**（`apps/executor-node/src/pull.ts` 长轮询、`callback.ts` 落盘重发），且**协议版本协商机制（v1-v9）已经建成并工作良好**（`protocol.json.versioning`）。引入 protobuf 意味着**替换掉一个已建成的兼容矩阵**，收益（破坏性检测）可以用**一个零依赖 node 脚本**在本仓现有 `protocol.json` 上实现。⇒ **不建议引入 Buf/protobuf 作为路线 A**，但**强烈建议借鉴它的 `buf breaking` 方法论**（见 §8 阶段 1） |
| **Microsoft TypeSpec** | https://github.com/microsoft/typespec | **MIT**（实测） | ✅ 兼容 | ① 单一 IDL 同时 emit **OpenAPI 3.1** + **protobuf** + **JSON Schema** ② 声明式装饰器（`@doc` / `@error` / `@statusCode`）③ Azure 生态背书 | ① **`@error` 模型** ⇒ 可以把本仓的 427 个错误码 + 15 个失败原因码**声明式表达**，并 emit 出前端 i18n 骨架与后端码表 ⇒ **直击 §5 的「码表元数据下发」需求** ② 多 emit 避免「一份定义两处手抄」 | ① **Java 运行时**（`tsp compile`）② 生态仍在演进（v1.0 才刚出）③ 迁移需把 427 个 Nest DTO 重写为 TypeSpec —— **成本极高** ④ 只解决 **HTTP 面**，**不解决 executor 协议面**（本仓的 `protocol.json` 不是 OpenAPI） | **❌ 很高**（仅针对 HTTP 面）。**但其「声明式错误模型」的设计思路可零成本借鉴**（在 `protocol.json` 的 `failureReason` 段加 `label`/`remediationKey` 元数据 + 生成器 emit 前端 i18n）⇒ **这是本报告推荐的「借思想不借工具」的方案** |
| **Smithy** | https://github.com/smithy-lang/smithy | **Apache-2.0**（实测） | ✅ 兼容 | ① 协议无关的 IDL ② 面向 **AWS 生态**的 trait 模型（`@required` / `@error` / `@httpError`）③ `smithy build` 多语言生成 | ① **trait 模型**（Smithy 的 `error` trait + `@httpError`）⇒ 与 TypeSpec 的 `@error` 同类，可借鉴 | ① **Java 运行时 + AWS 生态假设**（Smithy 的价值主要在 AWS SDK 生成，本仓无此需求）② 学习成本高 ③ 与 OpenAPI 生态距离远 | **❌ 高**。无 AWS 生态需求 ⇒ 引入 Smithy 是纯负担。**仅借鉴 trait 模型** |
| **Stoplight Spectral** | https://github.com/stoplightio/spectral | **Apache-2.0**（实测） | ✅ 兼容（Node CLI / API） | ① OpenAPI/AsyncAPI/Arazzo **linter**（规则用 JSON/YAML 表达）② 内置 OpenAPI 规则集 ③ 可自定义 ruleset | ① **自定义 ruleset** 可直接表达本仓的契约纪律：「`failureReason` 必须是 `failureReason.executorReportable` 的子集」「分页参数必须叫 `page`/`pageSize`」「错误体必须有 `errorCode`」② 与本仓「零依赖守卫」风格**冲突**（Spectral 是 npm 依赖） | ① 只能校验 **OpenAPI 文档**，不能校验**源码里的手写实现**（本仓问题恰恰是「文档对了、实现分叉」）② npm 依赖引入成本 ③ 自定义 ruleset 的表达力有限（非任意逻辑） | **中**。可作为「openapi.json 的 lint」补一层，**但不解决本域的核心问题**（实现分叉）。**不建议作为主线** |
| **Pact (JS / Python)** | https://github.com/pact-foundation/pact-js<br>https://github.com/pact-foundation/pact-python | **MIT**（实测；`pact-js` 的 LICENSE 文件头部明确 "The MIT License (MIT)"，GitHub 归类为 `NOASSERTION` 但内容是标准 MIT） | ✅ 兼容（测试期依赖，不进产物） | ① **consumer-driven contract**：消费者声明期望，提供者回放验证 ② 契约文件（Pact）**可作为跨语言中介格式** ③ 有 provider verification 报告 | ① **消费者驱动的契约测试范式** ⇒ 正是本域 §3.3-R3「knownDivergence 应该由消费者声明」的对应物 ② **「known divergence」在 Pact 里的对应物 = consumer 的 expectation 与 provider 的实际不符 ⇒ provider verification 报告显式列出** ⇒ **直接可借鉴为本仓 `knownDivergence` 守卫的形态** | ① pact broker 是**独立服务**（可自托管，但要运维）② 契约文件是**另一种格式**（引入第三种契约语言）③ **HTTP 层契约**，不覆盖本仓的**执行器线缆协议**（register/heartbeat/callback/pull） ④ 每个消费者一套 pact，**消费者多则维护成本线性增长**（本仓有 6 个消费面） | **中**（作为**方法论**借鉴：低；作为**工具**引入：中-高）。**本仓已有比 Pact 更贴合的东西**：`contract.json` 的共享向量 + 6 个消费点对账。⇒ **不建议引入 Pact 工具；建议借鉴其「消费者声明差异 → 显式报告」的治理形态** |
| **oasdiff** | https://github.com/oasdiff/oasdiff | **Apache-2.0**（实测） | ✅ 兼容（Go 独立二进制 / Go 库） | ① **OpenAPI 破坏性变更检测**（`oasdiff breaking`）② Go 实现，单二进制，零依赖 ③ 有 GitHub Action | ① **`breaking` 判定的语义分类**（哪些字段变更算 breaking）可直接借鉴为本仓 `protocol.json` 的破坏性变更守卫 | ① 只管 OpenAPI，**不管 `protocol.json`** ② 单二进制需下载（CI 要么 pin SHA 要么装 release） | **中**。**推荐借鉴其判据语义**，实现为本仓的一个**零依赖 node 脚本**（与 `generate-executor-protocol.mjs` 同款纪律）⇒ **成本 S、无新依赖** |
| **openapi-typescript** | https://github.com/openapi-ts/openapi-typescript | **MIT**（实测） | ✅ 兼容（**本仓已在用**） | ① 从 OpenAPI 生成 TS 类型 ② 零运行时 ③ 极快 | **本仓已在用**：`apps/admin-web/package.json:18` `"gen:api-types": "openapi-typescript ../admin-api/openapi.json -o src/types/generated/api-types.ts --default-non-nullable=false"` | ① 只出**类型**，不出运行时校验 ② 不管错误体（`errorCode`） | **已落地**，是 §5「码表元数据 → 前端生成物」的现成范式（照它扩即可） |

### 7.1 Top 3 推荐（均为「借思想不借工具」，**不引入重量级依赖**）

1. **【openapi-typescript 的生成范式 + TypeSpec 的 `@error` 声明式错误模型】** —— 用于 §5 的 D1：**把失败原因码表升级为「带 zh/en/remediationKey 元数据的对象数组」，用既有 `generate-executor-protocol.mjs` 双生成 + 第三份 emit 到 admin-web**。理由：范式本仓已有（零学习成本）、零新依赖、直击「127 个文件依赖的语义源头」。
2. **【oasdiff / buf breaking 的判据语义】** —— 用于本域新增守卫：**`protocol.json` 的破坏性变更检测**（改 `schemas` 段的 required 字段 / 删枚举值 / 改 `envForward.common` ⇒ 必须 bump `protocolVersion` 且三端同批）。**用零依赖 node 脚本实现，不引入 buf/oasdiff 工具**。理由：buf 的整套 protobuf 迁移对本仓是**净负收益**（要替换已建成的 v1-v9 兼容矩阵），但其**破坏性变更检测的思路**正是本仓 `protocol.json` 目前缺的（`evolutionRules` 只有 4 条文字规则，无机械执行）。
3. **【Pact 的「消费者声明差异 → provider verification 显式报告」形态】** —— 用于 §3.4 的 `knownDivergence` 守卫：**差异必须由「一侧」显式声明**（当前差异只在注释里 ⇒ 无主）。**用本仓既有的 `contract.json` 承载（不引入 pact broker、不引入 pact 文件格式）**。理由：直接把「差异无主」变成「差异有主 + 有 status + 有到期」。

**重量级路线（protobuf/Buf）的诚实成本评估（必须如实记录）**：
- **要做什么**：① 把 `protocol.json.schemas` 的 12 个 schema 改写成 `.proto` ② node 侧引入 protobuf 运行时、python 侧引入 protobuf 运行时 ③ **线缆从 JSON 改二进制** ⇒ `callback.ts` 的落盘重发、`pull.ts` 的长轮询、SSE、admin-api 的 DTO **全部要改** ④ **兼容期要同时支持 JSON 与 protobuf 两套**（v1-v9 的兼容矩阵作废重来）
- **收益**：破坏性变更自动检测 + 多语言代码生成
- **为什么收益/成本比差**：**本仓的协议已经是「版本化 + 向后兼容 + 双端生成」**，破坏性变更检测可以用 **一个脚本 + `protocol.json` 现有结构**做到（成本 S）；而 protobuf 迁移的成本是 **L + 协议重写 + 全链路双协议期**。
- **结论**：**不推荐 protobuf/Buf 路线**。若未来协议面**急剧扩张**（如新增 gRPC 双向流、大量跨语言消费者），再重新评估。**记录在此以便日后复盘时不必重新论证。**

---

## §8 分阶段路线图

| 阶段 | 内容 | 域 | 成本 | 前置 | 验收 |
|---|---|---|---|---|---|
| **P0-a** | **四个孤立 python 库按 (C) 降级**：4 个 `pyproject.toml` 标私有 → `check-publishable-wiring.mjs` 的 `publishableState()` 增加「私有包」识别 → `release-please-config.json` + `release-please-manifest.json` 摘除 4 个包 → `release-please.yml:33-35` 注释更新 | contract-crosscut | **S** | **需拍板（§11-D1）** | `node scripts/check-publishable-wiring.mjs` 绿（4 个包显示「私有，不适用」）；`npm run test:lib-*` 4 套仍绿 |
| **P0-b** | **已知差异登记缺口补齐**：把 B4（`adminApiUrls`）、B5（三键恒缺席）、R-f（健康端点全集）**登记进 `protocol.json` 的 `knownDivergence` 段**（带 reason/owner/status），并从源码注释里加指针 | contract-crosscut | **S** | 无 | `protocol.json` 的 `knownDivergence` 从 1 条变 ≥4 条；`check-failure-reasons.mjs` 仍绿（不动 `failureReason` 段） |
| **P1-a** | **D1：失败原因码表元数据化**：`protocol.json.failureReason` 从 `string[]` → 对象数组（含 zh/en/remediationKey/owner/reportable）→ 生成器扩 emitter → **三份生成物**（node / python / **admin-web `FAILURE_REASON_T_KEYS`**） | contract-crosscut | **M** | P0-b | ① `executor-protocol-drift` CI job **扩 diff 路径到 admin-web 生成物** ② `check-failure-reasons.mjs` 的解析**同批改成抽 `.code`**（否则结构红） ③ `check-enum-drift.mjs --report` 复核覆盖去向 ④ admin-web 的 `failure-reason-label.ts` 改为 re-export 生成物，**现有 15 条 i18n 词条与全部测试逐字节不变** |
| **P1-b** | **D2：分类器生成化（第一半）**：在 `protocol.json` 加 `failureReason.classifiers` 段（**只用两语言语义一致的 matcher 子集**：禁 lookbehind / 禁 `$` / 禁 Unicode 属性）+ 生成器 emit node/python 分类器 + **`contract.json` 加 `failureClassification` 共享向量段**（append-only） | contract-crosscut | **M** | P1-a | **跨端向量断言**：同一批输入文本 ⇒ node / python / admin 三端产出**同一码**（新 spec） |
| **P1-c** | **D2（第二半）：双轨运行时**：① 回调载荷加 `failureReasonSource` ② admin 兜底链改为「生成器 → 旧正则 → none」③ 新增 3 个指标（`autoflow_failure_reason_source_total` / `autoflow_failure_reason_mismatch_total` / `autoflow_failure_reason_fallback_total`） | contract-crosscut | **M** | P1-b | ① 旧正则**仍在**且仍被兜底调用 ⇒ 行为不变 ② 新指标进 `check-metric-docs` 的基线（走 `--update`）或补文档 |
| **P2-a** | **D4 收敛**：按 `legacy-regex` 占比 = 0 且 mismatch = 0 **连续 7 天**的**度量判据**（不是人肉）→ 删三份旧正则 | contract-crosscut | **M** | P1-c + 7 天观察期 | `inferFailureReason` / `prepareFailureReason` / `_refine_failure_reason` 全部消失或只剩生成物调用；新指标全 0 |
| **P2-b** | **`knownDivergence` 治理守卫**：`scripts/check-known-divergence.mjs`（差异登记完整性 / 登记有效性 / 条目棘轮 / status 到期） | contract-crosscut | **S** | P0-b | selftest ≥12 条；接 `test:guards:repo` |
| **P2-c** | **协议破坏性变更守卫**（借鉴 buf breaking 的判据语义，零依赖 node 脚本）：改 `protocol.json` 的 `schemas`/`failureReason`/`envForward`/`params` 而不 bump `protocolVersion` ⇒ 红 | contract-crosscut | **S** | 无 | selftest ≥10 条；接 `test:guards:repo` |
| **P3-a** | **指标清单口径统一**（M1）：把 `check-alerts-rules.mjs` 的 `INFRA_METRICS` 与 `check-metric-docs.mjs` 的注册表口径**统一到一份共享事实源** | contract-crosscut | **S** | 无 | 两个守卫共用同一份清单模块 |
| **P3-b** | **「内部指标 vs 对外指标」标注**（M3）：在 `runtime-metrics.ts` 的注册表里加 `visibility: "internal" \| "public"`；`check-metric-docs` 对 internal 指标免「必须上看板」 | contract-crosscut | **S** | P3-a | 不改变任何现有指标行为 |
| **P3-c** | **`autoflow-sdk` 重试/熔断收敛**（§4.3 的 C-2）：把 `autoflow_sdk/http.py` 与 `autocodeflow_http/client.py` 的重试/熔断/响应体上限**收敛成一份实现** | contract-crosscut | **M** | P0-a | 收敛后 (B) 删除重新变为安全选项 |

**排序理由**：P0（止血 + 低风险）→ P1（结构化码，本域最高价值）→ P2（治理守卫）→ P3（口径统一与进一步收敛）。**P3-c 之后，(B) 删除方案重新变成安全选项**（此时 `autocodeflow-http` 的参考实现角色已由 `autoflow-sdk` 承担）。

---

## §9 风险 + 回滚方案

| 风险 | 概率 | 后果 | 缓解 | 回滚 |
|---|---|---|---|---|
| **R1 · 跨语言正则不等价**：JS RegExp vs Python `re` 在 `$`/`\w`/lookbehind/Unicode 上语义不同 ⇒ 同一 matcher 列表两端口径不一致 ⇒ **分类漂移复发** | **高** | 分类语义再次分叉（正是本域要消灭的问题） | ① matcher **只用两语言一致的子集**（禁 lookbehind / 禁 `$` / 禁 Unicode 属性 / 显式字符类）② **共享向量双端断言**（同一批输入 ⇒ 同一码）③ 保留旧正则作兜底（双轨） | 单段回滚：生成器停用 ⇒ 回落旧正则（双轨期本就并存） |
| **R2 · `protocol.json` 结构升级连带 4 个守卫同批改**：`check-failure-reasons.mjs` 解析、`check-enum-drift.mjs` 覆盖自检、`check-metric-docs.mjs` 基线、`executor-protocol-drift` diff 路径 —— 任一漏改 ⇒ **CI 红**（不是静默） | **中** | CI 红（可接受，fail-closed） | **同批提交**（R14 单写者纪律） | 整批 revert |
| **R3 · 失败原因码值集合意外变化**：码表元数据化时手滑改了码值 ⇒ 存量 `task_executions.failure_reason` 数据与新枚举不匹配 ⇒ admin-web 展示落「未知」 | **低** | 用户看到裸 token（admin-web 的 `failureReasonLabel` 回退逻辑是「宁可露裸 token 也不要抹掉信息」，故**降级表现良好**） | ① D1 **不改码值集合**（只加元数据）② 加一条守卫：「元数据化的 `all` 集合必须逐值等于旧集合」 | revert 生成物 |
| **R4 · 私有包标记的语义歧义**：PEP 621 没有 `private` 字段 ⇒ 自定义标记可能被误读 ⇒ `check-publishable-wiring.mjs` 判据改动引入**新的假绿**（把真未接线的包误判为「有意私有」） | **中** | 新增未接线包不再报警 | ① 私有标记**必须带 reason**（与 `metric-docs-allowlist.json` 同款纪律）② 私有包**必须仍在 CI 测试矩阵里**（否则「不发布」会退化成「不维护」）③ 守卫 selftest 必须有反证用例 | revert 判据改动 |
| **R5 · 删除 `autocodeflow-http` 后 parity 注释悬空**：若主Agent 选 (B) 而非 (C)，6+ 处「与 autocodeflow-http 对齐」注释变成悬空指针 | **中**（选 B 时） | 注释腐化（仓内反复出现的形态） | 选 (C) **或** 在 (B) 之前先做 P3-c | 不适用 |
| **R6 · `knownDivergence` 守卫的关键词扫描假阳性**：「parity / 恒缺席 / 只在…侧支持」在纯技术说明里也出现 | **中** | 守卫噪音 ⇒ 被人加豁免 ⇒ 失守 | ① 守卫**只报不红**（`--report` 模式）起步 ② 豁免必须带理由（allowlist 形态）③ 真红条件只保留「**有明确差异声明关键词 + 无契约登记**」 | 降级为 report 模式 |
| **R7 · 双轨期数据污染**：双轨期写入的 `failure_reason_legacy` 与 `failure_reason` 不一致的历史行，污染后续统计 | **低** | 看板历史数据口径不一 | ① 收敛后按保留期清理 legacy 列 ② mismatch 指标**本身就是收敛判据** | 忽略 legacy 列 |
| **R8 · P1/P2 跨度大（D1→D4 需要 ≥7 天观察期）**，跨轮次执行时上下文丢失 | **中** | 中途断链 | ① 每个阶段**独立可 revert** ② 每阶段留**可跑的度量**（指标）作为下一阶段的前置判据 ③ 阶段边界写进 `docs/PLAN-CLAIMS.md` | 停在任一阶段（双轨是稳定的终态） |

**总回滚原则**：**所有 P1/P2 阶段都是「双轨共存」设计 ⇒ 任何时刻都可以停在新旧并存状态**（该状态是稳定且可运维的：旧正则仍在兜底、新码已能产生）。**唯一不可逆的是 P3-c 之后的 (B) 删除** ⇒ 故把 (B) 排在最后。

---

## §10 测试计划

### 10.1 P0-a（python 库降级）

| 测试 | 类型 | 断言 |
|---|---|---|
| `npm run test:lib-http` / `test:lib-ai` / `test:lib-notify` / `test:lib-db` | 既有 | 4 套仍全绿（**降级不改行为**） |
| `node scripts/check-publishable-wiring.mjs --report` | 守卫 | 4 个包显示「私有包，不适用」；`packages/` 总数 ≥ 8 下界不塌 |
| `node scripts/check-publishable-wiring.mjs --selftest` | 守卫自检 | 既有 11 条 + **新增 2 条反证**：① 标了「私有」但**不在 CI 测试矩阵** ⇒ 红 ② 私有标记**缺 reason** ⇒ 红 |
| `node scripts/check-guards-wired.mjs` | 接线 | 新增判据被接进 `test:guards:repo` |
| `npm run test:release-config` | 守卫 | `release-please-config.json` 的包条目与 `packages/` 目录**一致**（删条目后不留孤儿） |

### 10.2 P1-a（码表元数据化）

| 测试 | 类型 | 断言 |
|---|---|---|
| `node scripts/generate-executor-protocol.mjs` + `git diff --exit-code -- apps/executor-node/src/generated apps/executor-python/generated apps/admin-web/src/types/generated` | CI 漂移闸（**扩路径**） | 生成物与源码同 commit |
| `node scripts/check-failure-reasons.mjs` | 守卫 | **四方比对仍绿**（解析改成抽 `.code` 后） |
| `node scripts/check-enum-drift.mjs --report` | 守卫 | 生成的联合类型有明确覆盖去向（映射或带理由豁免） |
| `apps/admin-web/src/__tests__/dashboard-failure-reason-label.test.ts` + `executions-page.test.tsx` | 既有 | **15 条 i18n 词条与展示逐字节不变**（生成物等价性） |
| **新 spec**（admin-web） | 新增 | 生成的 `FAILURE_REASON_T_KEYS` **键集合** == 旧手写映射的键集合（逐值） |
| **新 spec**（protocol） | 新增 | 元数据化后 `all` / `executorReportable` / `adminInternalOnly` 的**码值集合逐值等于**旧集合（防 R3） |

### 10.3 P1-b（分类器生成化）

| 测试 | 类型 | 断言 |
|---|---|---|
| **新 spec（node）** | 新增 | `contract.json.failureClassification` 的向量逐条过**生成的** node 分类器 |
| **新 spec（python）** | 新增 | 同一份向量逐条过**生成的** python 分类器 |
| **新 spec（跨端）** | 新增 | **同一批输入 ⇒ node / python 产出同一码**（含边界：`"FOO\n"`、全角括号 `（…）`、空串、超长文本、emoji、组合字符） |
| **新 spec（admin）** | 新增 | admin 兜底分类器（生成的）产出 ⊆ `executorReportable`（沿用 `test_executor_protocol_contract.py:163` 的穷举形态） |
| **新 spec（matcher 子集校验）** | 新增 | 生成的 matcher **不得**含 lookbehind / 裸 `$` / `\p{...}`（机械校验，杜绝 R1） |
| 既有 `apps/executor-node/src/routes/prepare-failure-reason.spec.ts` | 既有 | **保持绿**（双轨期旧实现仍在） |
| 既有 `apps/executor-python/tests/test_interpreter_failure.py` | 既有 | 保持绿 |

### 10.4 P1-c（双轨运行时）

| 测试 | 类型 | 断言 |
|---|---|---|
| **新 spec（回调载荷）** | 新增 | ① 旧执行器（不带 `failureReason`）⇒ admin 行为**逐字节不变** ② 新执行器（带 `failureReason` + `failureReasonSource`）⇒ 旧 admin 的 `@IsIn` 校验**仍通过**（向后兼容） |
| **新 spec（落库）** | 新增 | `failure_reason`（新码）+ `failure_reason_legacy`（旧码）两列并存；mismatch 时不覆盖任一列 |
| **新 spec（指标）** | 新增 | 3 个新指标的 inc 点各一处；标签取值 ⊆ 注册表（`dashboard-label-values.spec.ts` 同款） |
| `npm run check:metric-docs -- --update` | 守卫 | 新指标进基线（或补文档） |
| `node scripts/check-alerts-rules.mjs` | 守卫 | 若新指标未被引用 ⇒ 无改动 |

### 10.5 P2-a（收敛）

| 测试 | 类型 | 断言 |
|---|---|---|
| **收敛判据脚本** | 新增 | 读 `autoflow_failure_reason_fallback_total{stage="legacy-regex"}` 与 `autoflow_failure_reason_mismatch_total`；任一非 0 ⇒ **红**（度量驱动的收敛闸，非人肉） |
| 回归全套 | 既有 | `npm run test:unit`（14 套）+ `npm run test:guards:repo` 全绿 |

### 10.6 P2-b / P2-c（治理守卫）

| 测试 | 类型 | 断言 |
|---|---|---|
| `node scripts/check-known-divergence.mjs --selftest` | 新增 | ≥12 条，**含正例控制组 + 反证**（差异未登记 ⇒ 红；登记缺 reason ⇒ 红；条目数超基线 ⇒ 红；`planned` 条目到期 ⇒ 红） |
| `node scripts/check-protocol-breaking.mjs --selftest` | 新增 | ≥10 条（含反证：改 `schemas.required` 不 bump ⇒ 红；删 `failureReason.all` 的值 ⇒ 红；改 `envForward.common` 不 bump ⇒ 红） |
| `npm run test:guards:repo` | 接线 | 两个新守卫**真的被跑到**（`check-guards-wired.mjs` 判据） |

### 10.7 P3（口径统一）

| 测试 | 类型 | 断言 |
|---|---|---|
| `node scripts/check-metric-docs.mjs --selftest` + `node scripts/check-alerts-rules.mjs --selftest` | 既有 | 改为**共用一份清单模块**后，两者仍绿 |
| **新反证** | 新增 | 「注册表删一个指标 ⇒ 两个守卫**都**红」（当前 `INFRA_METRICS` 可能让其中一个放行 ⇒ M1 的实测化） |

---

## §11 待决策项（需主Agent / 所有者拍板）

| # | 决策项 | 我的建议 | 若不拍板的后果 | 需要谁拍板 |
|---|---|---|---|---|
| **D1** | **四个孤立 python 库走 (A)/(B)/(C)？** | **(C) 降级为仓内私有包**，并把 (B) 删除推迟到 P3-c 之后（届时 `autoflow-sdk` 已收敛成唯一实现）。**不建议 (A) 公共 PyPI**（包名未验证 + 0.3.2→2.x 的语义化跳版 + 从未被真实场景验证）；**不建议现在 (B)**（会丢参考实现 + 留下 6+ 处悬空 parity 注释） | `scripts/check-publishable-wiring.mjs` 的 4 条基线豁免**永远挂着** ⇒ release-please **继续为没人能装的包发版**（已攒出 0.3.0/0.3.1/0.3.2 三个版本） | **主Agent + 产品负责人**（这是产品决策：这些库是不是要给任务脚本用的？若是，答案是 (A′) 接私有 PyPI，见 D3） |
| **D2** | **失败原因结构化码重构（D1→D4）的投入档位** | **做 P1-a + P1-b**（码表元数据化 + 分类器生成化 + 共享向量），成本 M×2。**P1-c 双轨与 P2-a 收敛待 P1-b 的跨端向量绿后再启动**（需要 ≥7 天观察期） | 127 个文件依赖的失败原因语义**继续由 3 份正则决定** ⇒ 中文化/文案改动的静默失效风险**持续存在**（已发生过 ≥2 次：EXEC-07 的 `^...$`、全角括号 `（…）`） | **主Agent**（架构决策） |
| **D3** | **是否需要「任务脚本可 pip install」的产品能力？** 若需要，正确路径是**接私有 PyPI（`apps/registry-pypi`）而非公共 PyPI** —— 但 `apps/registry-pypi/packages/` 实测只托管 `autoflow-sdk`，多包托管需扩展 | **需要独立立项**（不在本轮范围） | 这四个库的存在意义由它决定：若是 ⇒ (A′)；若否 ⇒ (C)→(B) | **产品负责人** |
| **D4** | **`knownDivergence` 守卫的形态**：(a) 「差异登记完整性」扫描源码注释找未登记差异（可能假阳性） vs (b) 「只登记不扫描」（无假阳性但挡不住新漂移） | **(a) + 允许豁免**，从 `--report` 起步再升红；理由：本域的真问题是「差异不登记」而不是「差异太多」 | 差异继续只在注释里 ⇒ R1/R-f/B4 三条残留永远不被发现 | **主Agent** |
| **D5** | **协议破坏性变更守卫是否做？**（借鉴 buf breaking 判据，零依赖 node 脚本） | **做**（P2-c，成本 S）。`protocol.json.versioning.evolutionRules` 现在只有 4 条**文字规则**，**无机械执行** ⇒ 「删了 `failureReason.all` 的一个值但不 bump `protocolVersion`」今天不红 | 协议破坏性变更继续靠人记 4 条规则 | **主Agent** |
| **D6** | **`failureReason` 码表要不要带 i18n 元数据（zh/en）并生成到 admin-web？** | **要**（P1-a 的一部分）。但注意这会让 `protocol.json` 承担**文案**职责（现在只承担语义）⇒ 需确认「协议文件放文案」是否可接受（仓内已有先例：`error-code-def.ts` 的 `ErrorCodeDef` 同时带 `zh`/`en`） | admin-web 的 `FAILURE_REASON_T_KEYS` 继续是**手写第三份映射**（与 §3.2-R8 同类问题） | **主Agent** |
| **D7** | **四客户端的「人读处置建议」要不要统一？**（现在只有 CLI 有 6 类归类 + 建议，node-sdk / python SDK / MCP 都没有） | **不建议现在做**。理由：① MCP 工具的输出是给 **agent** 读的，agent 需要**原始文案 + 稳定码**而不是「人类处置建议」（现在 `structuredContent` 已给码，够用）② node-sdk / python SDK 是**任务脚本**用的库，脚本应该按码分支而不是读建议 ③ 建议只在 CLI 这一层（人读）有价值 ⇒ **建议：明确「建议文案只在 CLI 呈现」是设计意图，而非缺口** | 会被反复当成「缺口」重提 | **主Agent**（若裁定为「设计意图」，建议写进 `packages/contract-fixtures/README.md` 或 `docs/`） |
| **D8** | **admin-web 是否需要消费 Prometheus 指标名？**（实测：目前不消费，走 `/api/metrics` 的结构化 DTO） | **不需要**。M2 不是缺口 | 会被误当成漏网之鱼反复提 | **主Agent**（仅需知晓） |

---

## 附录 A：本报告的可复核命令清单

```bash
cd /home/yongsheng/project/AutoCodeFlow

# 索引新鲜度
codegraph status && codegraph sync

# 零消费者取证（三重）
codegraph query "autocodeflow_notify"
codegraph query "autocodeflow_db"
codegraph query "autocodeflow_ai"
codegraph query "autocodeflow_http"
grep -rn -E "autocodeflow[_-](ai|db|http|notify)\b" . \
  --exclude-dir={node_modules,.git,.codegraph,autocodeflow-ai,autocodeflow-db,autocodeflow-http,autocodeflow-notify,.venv,__pycache__}
grep -rn -E "^(from|import) autocodeflow" apps/executor-python/ --include=*.py
ls apps/executor-python/.venv/lib/python3.12/site-packages/ | grep -i autocodeflow   # 零命中
ls apps/registry-pypi/packages/                                                    # 只有 autoflow-sdk
grep -rn "sqlalchemy\|psycopg2" apps/executor-python/ apps/admin-api/package.json   # 零命中

# 守卫实跑
node scripts/check-publishable-wiring.mjs --report
node scripts/check-alerts-rules.mjs
node scripts/check-metric-docs.mjs --report
node scripts/check-failure-reasons.mjs
node scripts/check-enum-drift.mjs --report
node scripts/check-enum-consumers.mjs --report
npm run check:error-i18n

# 分类器三份实现
sed -n '1067,1122p' apps/admin-api/src/modules/task/task.service.ts
sed -n '855,974p'  apps/executor-node/src/routes/execute.ts
sed -n '570,760p'  apps/executor-python/routers/execute.py

# 影响面量化
grep -rln "failureReason\|failure_reason" --include=*.ts --include=*.tsx --include=*.py apps packages \
  | grep -v node_modules | grep -v "\.venv" | grep -v __pycache__ | grep -v "/dist/" | grep -v coverage | wc -l   # 127
```

## 附录 B：本报告**未**覆盖（留给其它域或后续轮次）

- `apps/admin-web` 的手写 API 视图模型（133-135 处）：R11 已裁定「只加棘轮守卫、不迁存量」，`check-web-type-drift.mjs` 已在，本域不重复。
- Agent 运行时契约（审批/记忆/子 agent）：R12 已推迟，不在本域。
- `apps/executor-desktop`：只在本域出现于「指标名 ↔ 注册表」的一条描述文字，无契约面。
- `apps/registry-pypi` 的多包托管能力：属 D3 的附属，未展开设计。
