# 能力矩阵（ECO-01，第十六轮逐项对齐）

> 重组自 [docs/sdk-guide.md「能力矩阵」](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/sdk-guide.md)。
> 每项断言均标注证据文件路径；矩阵之后逐条解释差异。✅=两侧等价，
> ⚠️=有差异（差异格说明语义）。

| 能力项 | Node `@autocodeflow/sdk` | Python `autoflow-sdk` | 状态 |
|--------|--------------------------|----------------------|------|
| **http: get/post/put/delete** | ✅ `HttpClient.get/post/put/delete`（泛型返回已解包 body） — `packages/autocodeflow-node-sdk/src/http-client.ts` | ✅ `HttpClient.get/post/put/delete` + **Async 双版本**（返回 `httpx.Response`，`raise_for_status` 已做） — `packages/autoflow-sdk/autoflow_sdk/http.py` | ⚠️ py 多异步客户端；node 多 envelope 解包（见下） |
| **http: 默认超时** | 10 s（axios，注释对齐 py） — `http-client.ts:62` | 回调客户端 10 s（`callback.py`）；通用 `HttpClient` 30 s（`http.py`） | ⚠️ 通用客户端默认值不同（node 无独立通用客户端，10 s 全局） |
| **http: 错误类型可识别** | axios error 携带 `response.status`；拦截器把 envelope `message` 追加进 `error.message` — `http-client.ts:81-94` | ✅ **ECO-01 起** `HttpClientError`（`httpx.HTTPStatusError` 子类，`isinstance` 可判 SDK 管辖错误；既有 `except httpx.HTTPStatusError` 零破坏） — `autoflow_sdk/http.py` | ✅ 对等 |
| **http: envelope 解包** | get/post/put/delete 全部自动解包 `{code,message,data}`（严格三元组） — `http-client.ts:157-169` | ⚠️ 仅 `CallbackClient.report` 解包（`unwrap_envelope`，同样严格三元组）；通用 `HttpClient` 返回原始 `httpx.Response` — `autoflow_sdk/callback.py:70` | ⚠️ node 通用客户端也解包，py 通用客户端不解（回调路径两侧一致严格） |
| **log: 级别** | `debug/info/warn/error` 四级（`console.*` + 内存 buffer） — `packages/autocodeflow-node-sdk/src/logger.ts` | `logging` 全级别（DEBUG/…/CRITICAL），stdout handler — `autoflow_sdk/logger.py` | ✅ 实用面等价（py 侧底层 logging 能力更宽） |
| **log: 结构化 buffer** | ✅ `getLogs()/clear()`，随 `ctx.success()/failure()` 进 `TaskResult.logs` — `logger.ts`、`context.ts` | ❌ 无内存 buffer（stdout/stderr 由执行器采集为执行日志） — `logger.py` | ⚠️ node 独有（执行器采集路径不同：executor-node 消费 handler 返回的 logs，executor-python 捕获 stdout） |
| **log: meta 字段** | ✅ `logger.info(msg, {meta})` 结构化元数据 | ❌ printf 风格（`ctx.log.info("%s", x)`） | ⚠️ node 独有；py 侧结构化信息走返回值 |
| **callback: report_success** | ✅ `ctx.reportSuccess({ summary?, durationMs? })`（ECO-01 补齐） — `packages/autocodeflow-node-sdk/src/context.ts` | ✅ `ctx.report_success(summary=..., duration_ms=...)` — `autoflow_sdk/context.py:84` | ✅ 对等 |
| **callback: report_failure** | ✅ `ctx.reportFailure(error, { summary?, durationMs?, failureReason? })`（ECO-01 补齐，默认 `script_error`） — `context.ts` | ✅ `ctx.report_failure(error, summary=..., duration_ms=..., failure_reason=...)`（默认 `script_error`） — `context.py:92` | ⚠️ py 客户端白名单校验 failureReason（非法抛 `ValueError`，`callback.py:243`）；node 为薄客户端不做本地校验，非法值由 admin DTO 拒绝 |
| **callback: 批量/自定义字段** | ✅ `ctx.http.post('/api/executions/callback', [items])`（executorAddress 仅对 callback URL 自动补齐） — `http-client.ts:122-138` | ✅ `ctx.callback.report([items])`（executionId/executorAddress 全量自动补齐） — `callback.py:195-208` | ✅ 对等 |
| **callback: 截断上限** | ✅ `ERROR_MESSAGE_MAX_LENGTH=4096` / `LOGS_MAX_LENGTH=512_000`（ECO-01 起导出，与 py 同值） — `context.ts` | 同值常量 — `callback.py:44-45` | ✅ 对等 |
| **callback: 不可用异常** | 请求方法 rejects `Error("HttpClient is disabled: …")`（原因含缺失变量名） — `http-client.ts:52-59,141-146` | `CallbackDisabledError`（原因含缺失变量名） — `callback.py:66,155-156` | ⚠️ 类型不同（语言惯用形态），语义等价 fail-closed |
| **env 注入: AUTOFLOW_\* 参数** | ✅ `ctx.getParam(key, fallback?)` 优先读 `AUTOFLOW_PARAMS_JSON`（**真实类型**），旧执行器回落逐键 `AUTOFLOW_<KEY>` 并做尽力而为的类型还原；`process.env.AUTOFLOW_X` 直读仍可用（字符串裸值） — `context.ts` | ✅ `from_env()` 优先读 `AUTOFLOW_PARAMS_JSON` 归一化为 `ctx.params`（小写键）；旧执行器回落逐键通道（含 A-11 引号容错） — `context.py` | ✅ 语义对等（A-11R 起两端都优先类型化通道；差异：py 收敛进 `ctx.params`，node 走 `ctx.getParam()` 且允许直读 env） |
| **env 注入: 凭证三件套** | ✅ `AUTOFLOW_ADMIN_API_URL`+`AUTOFLOW_CALLBACK_TOKEN`→enabled；`AUTOFLOW_EXECUTOR_ADDRESS`→`ctx.executorAddress`；legacy `ADMIN_API_URL`/`EXECUTOR_TOKEN` 优先 — `context.ts:82-94` | ✅ 同名三键→`ctx.admin_api_url`/`callback_token`/`executor_address` 专用字段，**绝不混入 params**（泄漏面）；repr/to_dict 均脱敏（N40/N27） — `context.py:14-18,40-42` | ✅ 语义对等（差异：node 有 legacy 变量回退，py 无——py 执行器从 N23 起注入，无需 legacy 兼容） |
| **env 注入: 缺变量行为** | `fromEnv()` 缺 `EXECUTION_ID`/`TASK_ID`/`TASK_NAME` **抛错** — `context.ts:72-80` | `from_env()` 缺失回落 `"unknown"` — `context.py:139-142` | ⚠️ node 严格抛错 vs py 宽松兜底（node 语境下 fromEnv 抛错在 worker 侧早失败更利于排障；py 脚本形态常见手工直跑，兜底更友好） |
| **重试语义: http** | ❌ 无自动重试（axios 直传） — `http-client.ts` | ❌ 无自动重试（BUG-15 复审坐实"从未有过"，docstring 已改） — `http.py:6-13` | ✅ 对等：两侧都把重试决策留给任务代码（SAFE_METHODS 重试逻辑在 `autocodeflow-http` 包，非任务 SDK） |
| **重试语义: 回调** | ❌ 无隐式重试（失败即 reject，执行器统一回调兜底） — `http-client.ts` | ❌ 同 — `callback.py` | ✅ 对等：任务内主动回调是补充通道，成败终态由执行器保证 |
| **禁用语义: 构造** | disabled 客户端可构造（不建 axios 实例），`enabled=false` + `disabledReason` — `http-client.ts:50-61` | 同构：可构造、`enabled=False` + `disabled_reason` — `callback.py:112-129` | ✅ 对等 |
| **错误传播: envelope message** | 拦截器把 4xx/5xx envelope `message`（string）追加进 `error.message` — `http-client.ts:81-94` | 4xx/5xx 抛 `HTTPStatusError`，message（str 或 str[]）进异常文案 — `callback.py:168-193` | ⚠️ 小分歧：node 只采纳 string message；py 兼容 message 数组 join。对 admin-api 实际响应（string message）行为一致——见 contract.knownDivergence 注记 |
| **models / 协议模型** | ❌ 无（类型定义在 `types.ts`，`TaskResult` 结构化输出） — `packages/autocodeflow-node-sdk/src/types.ts` | ✅ pydantic 模型（`TaskConfig`/`ExecuteRequest`/`ExecuteResult`，snake/camel 归一化） — `autoflow_sdk/models.py` | ⚠️ py 独有（供执行器/消费方导入校验协议体；node 执行器走 zod-free 手写校验，SDK 不承担） |
| **结果构造器** | ✅ `ctx.success(msg, output)` / `ctx.failure(msg, output)`（自动附 logs） — `context.ts:112-137` | `TaskResult.ok()/fail()`（独立类，非 ctx 方法） — `result.py` | ✅ 实用面等价（形态不同） |
| **Artifacts 目录感知** | ❌（`AUTOFLOW_ARTIFACTS_DIR` 由执行器注入，SDK 未包装） | ❌ 同 | ✅ 对等缺口（执行器直接注入 env，任务 `os.environ`/`process.env` 直读即可；SDK 包装留后续需求） |

## 差异逐条说明与裁定

1. **node 无独立通用 HTTP 客户端**：node 侧 `HttpClient` 一身二职（admin
   回调 + 通用请求），py 侧拆成 `HttpClient/AsyncHttpClient`（通用，
   返回原始 Response）与 `CallbackClient`（回调专用，解包 envelope）。
   行为后果：node 的 `ctx.http.get()` 拿到的 body 已解包，py 的
   `HttpClient.get()` 拿到的是原始 httpx Response（含 envelope）。任务
   代码若跨语言移植，注意这一格。**不收敛裁定**：py 返回 Response 对象
   是刻意的（保留 headers/status 全量信息），收敛会破坏既有任务。
2. **unwrap 严格度**：两侧解包都要求 `code+message+data` 严格三元组；
   cli/mcp 用宽松 `data+(code|message)` 启发式——分歧已留档
   [packages/contract-fixtures/contract.json](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/packages/contract-fixtures/contract.json)
   的 `knownDivergence`（admin-api 恒发 code，真实流量不受影响，
   四端统一需 breaking release）。详见[契约页](contract)。
3. **failureReason 校验位置**：py 在客户端抛 `ValueError`（白名单 = 执行器
   可上报子集 10 项；admin 全集 11 项，其中 `stale_recovered` 为 admin 内部
   专用、上报方不得使用——契约见 `packages/executor-protocol/protocol.json`），
   node 交由服务端 DTO 校验。任务代码建议两侧都只用文档化枚举值。
4. **缺变量行为**：node `fromEnv` 抛错 / py `from_env` 兜底 `"unknown"`。
   这是唯一的「失败模式」分歧；执行器恒注入三变量，实际执行不受影响，
   仅影响手工裸跑脚本的行为。
5. **ECO-01 已补齐**（此前单侧缺失的小能力）：
   - node 端 `reportSuccess`/`reportFailure` 便捷方法（原 py 独有，
     node 任务只能手拼 `ctx.http.post` payload）——`context.ts`；
   - py 端 `HttpClientError` 可识别错误子类（原 node 错误对象天然带
     `response.status` 可判别，py 只能裸 catch HTTPStatusError 无法区分
     SDK 管辖与否）——`autoflow_sdk/http.py`。

## 缺口与计划（大能力，未排期）

- ~~**py 侧任务参数类型还原**~~：**A-11R（2026-10-14）已落地**。两个执行器自协议
  v5 起额外注入 `AUTOFLOW_PARAMS_JSON`（整个 params 一份 JSON），两个 SDK 的
  `from_env()` / `getParam()` 优先读它并做类型还原；逐键 `AUTOFLOW_<KEY>` 通道
  保留兼容（字符串裸值）。旧执行器（< v5）上 SDK 回落逐键通道并尽力而为地还原
  类型，对 A-11 的引号形态也做了剥离容错。
- **node 侧 TaskResult → 平台结构化输出的契约固化**：node 任务返回值经
  worker 序列化上报，`TaskResult.output` 的 schema 未在 SDK 层校验；
  与 ARCH-25（插件化 runtime）一并考虑。
- **Artifacts 目录 SDK 包装**（`AUTOFLOW_ARTIFACTS_DIR` helper）与
  **自动重试策略可插拔**（若未来引入，须遵守 SAFE_METHODS 语义）——
  需求出现时再评估。
