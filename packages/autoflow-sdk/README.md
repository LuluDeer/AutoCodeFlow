# autoflow-sdk — AutoCodeFlow Python SDK

AutoCodeFlow 任务执行器（executor-python）侧的 Python SDK：提供任务上下文
（`TaskContext`）、日志（`ctx.log`）、Admin API 回调客户端
（`CallbackClient` + `ctx.report_success()` / `ctx.report_failure()`）与
通用 HTTP 客户端（`HttpClient` / `AsyncHttpClient`，基于 httpx）。回调契约
与 Node.js SDK [`@autocodeflow/sdk`](../autocodeflow-node-sdk/README.md) 完全
对齐（第九轮），双端共用 `CallbackItemDto` 字段。平台侧完整说明见
[docs/sdk-guide.md](../../docs/sdk-guide.md)。

## 安装

```bash
pip install autoflow-sdk                     # 公共 PyPI（发布后）
# 内网私有 registry（apps/registry-pypi）：
pip install --index-url http://<registry-pypi-host>/simple autoflow-sdk
```

要求 Python ≥ 3.9；运行时依赖 `httpx`、`pyyaml`、`pydantic>=2`
（`autoflow_sdk.models` 的协议模型）；开发/测试依赖另需
`pytest`、`pytest-asyncio`、`respx`（见 `[project.optional-dependencies].dev`）。

## Quickstart

任务脚本由执行器以子进程运行，环境变量注入见下表。
`TaskContext.from_env()` 读取 `EXECUTION_ID` / `TASK_ID` / `TASK_NAME` 与
全部 `AUTOFLOW_*` 触发参数（回调凭证三件套除外——它们暴露为专用字段，
绝不混入 `ctx.params`）：

```python
# tasks/fetch_data.py
from autoflow_sdk import TaskContext

ctx = TaskContext.from_env()
ctx.log.info(f"task {ctx.task_id} started, execution={ctx.execution_id}")

source_url = ctx.get_param("source_url")          # AUTOFLOW_SOURCE_URL
rows = do_work(source_url)

# 主动回调 Admin API（N23 per-execution token）。旧版执行器不注入凭证，
# 此时 ctx.callback.enabled 为 False，结果仍由执行器统一上报。
if ctx.callback.enabled:
    ctx.report_success(summary=f"{rows} rows written", duration_ms=1200)
```

失败上报（`error` 映射为 `errorMessage` 并截断至 4 KB；`failure_reason`
取 admin-api 的 `ExecutionFailureReason` 枚举，默认 `script_error`，非法值
抛 `ValueError`）：

```python
try:
    rows = do_work(source_url)
except Exception as e:
    if ctx.callback.enabled:
        ctx.report_failure(e, failure_reason="script_error")
    raise
```

### 底层回调客户端

批量/自定义字段时直接使用 `ctx.callback.report()`，
`executionId` / `executorAddress` 自动补齐（N27），显式书写的值不会被覆盖：

```python
ctx.callback.report([
    {"status": "success", "durationMs": 800},
    {"status": "success", "durationMs": 900, "logs": "checkpoint 2"},
])
```

凭证缺失时任何上报调用抛 `CallbackDisabledError` 并指明缺失变量
（fail-closed，与 Node `HttpClient.disabledReason` 语义对齐）。

### HttpClient 直用

通用 HTTP 客户端（非回调专用）可独立构造：

```python
from autoflow_sdk import HttpClient, AsyncHttpClient

http = HttpClient(base_url="http://admin-api:3105", timeout=30.0,
                  headers={"Authorization": f"Bearer {token}"})
resp = http.get("/api/tasks")            # 返回 httpx.Response

async with AsyncHttpClient(base_url=...) as ahttp:
    resp = await ahttp.post("/api/x", json={"a": 1})
```

## 执行器注入的环境变量

与 [docs/sdk-guide.md](../../docs/sdk-guide.md) 的注入表逐字一致：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `TASK_ID` | 当前任务的唯一标识 | `task_abc123` |
| `TASK_NAME` | 当前任务名称 | `fetch_data` |
| `EXECUTION_ID` | 本次执行记录的唯一标识 | `exec_xyz789` |
| `AUTOFLOW_<KEY>` | 触发参数，按参数名转大写后注入 | `AUTOFLOW_SOURCE_URL=https://api.example.com` |
| `AUTOFLOW_ADMIN_API_URL` | Admin API 基地址（非机密路由信息，N23 起注入） | `AUTOFLOW_ADMIN_API_URL=http://admin-api:3105` |
| `AUTOFLOW_CALLBACK_TOKEN` | 本次执行的一次性回调 token（`v1.` HMAC，绑定 executionId、随 TTL 过期，N23 起注入） | `AUTOFLOW_CALLBACK_TOKEN=v1.<uuid>.<exp>.<hmac>` |
| `AUTOFLOW_EXECUTOR_ADDRESS` | 当前执行器注册地址（非机密路由信息，N27 起注入；SDK 经 `ctx.executorAddress`（Node）/ `ctx.executor_address`（Python）暴露并自动填入回调请求） | `AUTOFLOW_EXECUTOR_ADDRESS=executor-node:8002` |

## 回调契约（与 Node SDK 一致）

`POST {AUTOFLOW_ADMIN_API_URL}/api/executions/callback`，请求体为
`CallbackItemDto[]`：`executionId` / `status: success|failed` /
`executorAddress` / `logs` / `errorMessage` / `failureReason` /
`durationMs`。per-execution token 仅授权本 `executionId` 的回调，越权或
过期一律 401（fail-closed）；执行器共享 token 绝不进入任务子进程（SEC-01）。

## 版本与发布

- 版本策略：与 `@autocodeflow/sdk`（npm）、`autocodeflow-mcp-server` 走
  **lockstep** 单版本线，当前 `1.0.0`。
- 发布管道：[.github/workflows/release.yml](../../.github/workflows/release.yml)。
  push tag `vX.Y.Z` 触发：版本一致性守卫（tag 必须等于本包
  `pyproject.toml` version 与 `autoflow_sdk.__version__`，不一致直接
  fail）→ `publish-pypi` job（python 3.12，`python -m build` +
  `pypa/gh-action-pypi-publish`）。
- 凭证：GitHub secret `PYPI_API_TOKEN`（pypi.org API token）；如改用
  PyPI Trusted Publishing（OIDC）则删 workflow 中 `password` 行。
- 元数据单一来源：`pyproject.toml`（`setup.py` 仅留 `setup()`）。
- 本地演练（不真发布）：

  ```bash
  cd packages/autoflow-sdk
  python -m pip install build && python -m build --wheel   # 产物在 dist/（已 gitignore）
  ```

- 发布流程与矩阵说明见
  [docs/sdk-guide.md「SDK 矩阵」](../../docs/sdk-guide.md)。
