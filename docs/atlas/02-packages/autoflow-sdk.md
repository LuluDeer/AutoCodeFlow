# autoflow-sdk — Python SDK

> 所属: docs/atlas/02-packages · 最后核对: 2026-09-13 · 对应代码: packages/autoflow-sdk

## 职责

PyPI 包 `autoflow-sdk`（v1.2.0，与 `@autocodeflow/sdk` lockstep 同版本）：Python 任务脚本在执行器里拿到的**运行时基础件**——执行上下文（TaskContext）、结构化日志、执行结果封装，以及向 admin-api 回报执行结果/日志的回调客户端。它服务于两个方向：被 executor-python 注入 env 后加载（平台路径），或任务作者手工构造（自测路径）。

依赖（pyproject.toml 核实）：`httpx>=0.24.0`、`pyyaml>=6.0`、`pydantic>=2.0`；`requires-python >= 3.9`；dev extras 带 pytest/pytest-asyncio/respx。测试：包内 `pytest -q`（根目录 `npm run test:sdk-py`）。

## 目录结构与关键文件

```
packages/autoflow-sdk/
├── pyproject.toml            version = "1.2.0"（lockstep 注释 + release.yml 守卫）
├── setup.py
├── autoflow_sdk/
│   ├── __init__.py           __version__ = "1.2.0"  # x-release-please-version（守卫点）
│   ├── context.py            TaskContext（from_env / get_param / report_*）
│   ├── callback.py           CallbackClient + CallbackDisabledError + unwrap_envelope
│   ├── http.py               HttpClient / AsyncHttpClient / HttpClientError
│   ├── logger.py             get_logger
│   ├── models.py             TaskConfig / ExecuteRequest / ExecuteResult（pydantic）
│   └── result.py             TaskResult（ok/fail 工厂）
└── tests/                    test_contract.py 消费 contract-fixtures
```

## 公开 API 面（`__all__` 核实，共 10 个名字）

### TaskContext（context.py）

- `TaskContext(task_id, execution_id, task_name, params, env, callback_token=None, admin_api_url=None, executor_address=None)`，dataclass。
- `TaskContext.from_env()`：从进程环境构建。必需 `EXECUTION_ID` / `TASK_ID` / `TASK_NAME`；回调凭证 `AUTOFLOW_CALLBACK_TOKEN`（N23 一次性 v1. HMAC）、`AUTOFLOW_ADMIN_API_URL`、`AUTOFLOW_EXECUTOR_ADDRESS`（N27）——三者是专用字段且**刻意排除在 `params` 外**（R9，防 token 泄进参数视图）；`callback_token` 等字段 `repr=False`（N40，防 `print(ctx)` 把 token 写进执行日志）。
- `get_param(key, default)` / `get_env(key, default)`（任务 env 优先，再 OS env）/ `log`（懒加载 logger）/ `to_dict()`。
- `callback()` → 惰性构造 `CallbackClient`；`report_success(summary=None, duration_ms=None)` / `report_failure(error, ...)` 快捷上报。
- 结果构建：`TaskResult.ok(message, data)` / `TaskResult.fail(error, exit_code)` / `.to_dict()`。

### CallbackClient（callback.py）— 回调与降级

- `POST {base}/api/executions/callback`（容忍 base 以 `/api` 结尾），Bearer 回调 token；响应经 `unwrap_envelope` 拆 `{code,message,data}` 信封，data 为 `{results:[...]}`。
- **enabled 降级语义**（U14，与 node SDK 对齐）：`admin_api_url` + `token` 二者齐备才 `enabled=True`；缺任一则禁用，使用时抛 `CallbackDisabledError`（附缺哪些 env 的说明）。`AUTOFLOW_EXECUTOR_ADDRESS` 可选（N27 起自动盖在回调项上，缺失不禁用）。
- 字段截断上限（与 admin-api `execution-callback.dto` 对齐）：`ERROR_MESSAGE_MAX_LENGTH = 4096`、`LOGS_MAX_LENGTH = 512_000`。
- **重试说明**：SDK 自身的 `HttpClient`/`CallbackClient` 是 httpx 直连封装，**无内置自动重试**——平台级重试由任务的重试策略（maxRetry/retryDelay）在 admin-api 侧实现；带重试/熔断的通用 HTTP 客户端在姊妹库 [autocodeflow-http](python-libs/http.md)。

### HttpClient / AsyncHttpClient（http.py）

- `HttpClient(base_url="", timeout=30.0, headers=None)` 与同名异步版：`get/post/put/delete` 薄封装，非 2xx 统一 raise `HttpClientError`（继承 httpx.HTTPStatusError）。无重试、无信封拆包（信封拆包只在回调客户端里）。

### 其他

- `get_logger(name="autocodeflow")`：任务名绑定的结构化日志。
- `models.py`：`TaskConfig`（含 `normalize_policy_fields` 兼容旧字段名）、`ExecuteRequest`、`ExecuteResult`。

### 最小使用示例

```python
from autoflow_sdk import TaskContext, TaskResult

ctx = TaskContext.from_env()          # 执行器已注入 EXECUTION_ID / AUTOFLOW_* 等
ctx.log.info("start sync", extra={"batch": ctx.get_param("batch")})
try:
    ...
    ctx.report_success(summary=f"synced {n} rows", duration_ms=elapsed)
    result = TaskResult.ok("done", {"rows": n})
except Exception as e:
    ctx.report_failure(e)
    result = TaskResult.fail(str(e))
```

### 环境变量一览（context.py / callback.py 核实）

| 变量 | 必需 | 作用 |
|---|---|---|
| `EXECUTION_ID` / `TASK_ID` / `TASK_NAME` | 是（from_env 缺失即抛错） | 执行身份 |
| `AUTOFLOW_CALLBACK_TOKEN` | 否（缺则回调禁用） | 一次性 v1. HMAC 回调凭证（N23） |
| `AUTOFLOW_ADMIN_API_URL` | 否（与上者同进退） | admin-api 回调基址 |
| `AUTOFLOW_EXECUTOR_ADDRESS` | 否 | 自动盖在回调项上的执行器地址（N27） |

## 与其他组件的关系

- **被依赖**：apps/executor-python 把本 SDK 作为任务运行环境的一部分（注入 `EXECUTION_ID` 等与 `AUTOFLOW_*` 凭证后调入口脚本）；任务作者 `pip install autoflow-sdk` 或经 [私有 PyPI](../01-apps/registry-pypi/README.md) 安装。
- **回调契约**：`POST /api/executions/callback` 的 DTO 与字段上限以 admin-api `execution-callback.dto.ts` 为源头，见 [执行回调链路](../04-flows/execution-callback.md) 与 [契约夹具](contract-fixtures.md)。
- **镜像关系**：与 [autocodeflow-node-sdk](autocodeflow-node-sdk.md) 按 ECO-01 能力矩阵逐项对齐（enabled 语义、字段上限、`report_*` 签名），已知分歧记录在 contract.json 的 `knownDivergence`。
- docs-site 的 Python SDK 页面（[docs-site](docs-site.md)）重组自本包 README。

## 常见改动场景

**如何加一个 SDK 方法**：
1. 先对照 node SDK 同名能力（[扩展 SDK 能力](../08-workflows/add-new-sdk-capability.md) 的双端同步清单），确定签名与语义；
2. 在对应模块实现并导出到 `__all__`；若涉回调字段，先核对 admin-api DTO 白名单与长度上限；
3. `tests/` 补 pytest（httpx 交互用 respx mock）；契约行为变化走 contract-fixtures 的 append-only 流程（见 [契约夹具](contract-fixtures.md)）；
4. bump 版本必须三包 lockstep（见 [包生态总览](README.md) 发版策略）。

## 相关文档

- [包生态总览](README.md) · [Node SDK 镜像](autocodeflow-node-sdk.md) · [Python 工具库](python-libs/README.md)
- [executor-python](../01-apps/executor-python/README.md) · [SDK 能力矩阵](../05-interfaces/sdks.md)
