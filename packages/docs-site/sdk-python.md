# Python SDK — autoflow-sdk

> 重组自 [packages/autoflow-sdk/README.md](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/packages/autoflow-sdk/README.md)
> 与 SDK 源码（`autoflow_sdk/context.py` / `callback.py` / `http.py` / `logger.py` / `result.py` / `models.py`）。

AutoCodeFlow 任务执行器（executor-python）侧的 Python SDK：提供任务上下文
（`TaskContext`）、日志（`ctx.log`）、Admin API 回调客户端
（`CallbackClient` + `ctx.report_success()` / `ctx.report_failure()`）与
通用 HTTP 客户端（`HttpClient` / `AsyncHttpClient`，基于 httpx）。

## 安装

```bash
pip install autoflow-sdk                     # 当前 1.2.0，要求 Python ≥ 3.9
# 内网私有 registry（apps/registry-pypi）：
pip install --index-url http://<registry-pypi-host>/simple autoflow-sdk
```

运行时依赖 `httpx`、`pyyaml`、`pydantic>=2`（`autoflow_sdk.models` 的协议模型）。

## TaskContext

```python
from autoflow_sdk import TaskContext

ctx = TaskContext.from_env()
```

| 成员 | 说明 |
|------|------|
| `TaskContext.from_env()` | 读取 `EXECUTION_ID` / `TASK_ID` / `TASK_NAME`（缺失回落 `"unknown"`）与全部 `AUTOFLOW_*` 触发参数（凭证三件套除外，归一化进 `ctx.params`，键小写） |
| `ctx.task_id` / `ctx.execution_id` / `ctx.task_name` | 任务标识 |
| `ctx.params` | `AUTOFLOW_<KEY>` 触发参数字典（小写键，值恒为字符串） |
| `ctx.get_param(key, default=None)` | 读参数 |
| `ctx.get_env(key, default="")` | 读环境变量（任务 env 优先，再 OS env） |
| `ctx.log` | 日志器（懒加载） |
| `ctx.callback` | 回调客户端（懒加载单例） |
| `ctx.admin_api_url` / `ctx.callback_token` / `ctx.executor_address` | 凭证三件套专用字段，**绝不混入 params**；`repr` / `to_dict` 均脱敏（N40/N27） |

## CallbackClient（回调专用）

| API | 说明 |
|-----|------|
| `ctx.callback.enabled` | 凭证齐备为 `True`；旧版执行器下任何上报调用抛 `CallbackDisabledError`（fail-closed，原因含缺失变量名） |
| `ctx.callback.report(items)` | 批量 POST `CallbackItemDto[]`；`executionId` / `executorAddress` 自动补齐（显式书写不覆盖）；返回**已解包** envelope `data`（`{results: [...]}`） |
| `ctx.report_success(summary=None, duration_ms=None)` | 成功上报便捷方法；`summary` 进回调项 `logs`（截断 512 KB） |
| `ctx.report_failure(error, summary=None, duration_ms=None, failure_reason="script_error")` | 失败上报；`error` 字符串化截断 4 KB；`failure_reason` **客户端白名单校验**（非法抛 `ValueError`，枚举含 BUG-10 九类） |
| `ERROR_MESSAGE_MAX_LENGTH` / `LOGS_MAX_LENGTH` | 模块常量 `4096` / `512_000` |
| 默认超时 | 10 s |
| 重试 | **无自动重试**（BUG-15 复审坐实「从未有过」） |

```python
if ctx.callback.enabled:
    ctx.report_success(summary=f"{rows} rows written", duration_ms=1200)
```

```python
try:
    rows = do_work(source_url)
except Exception as e:
    if ctx.callback.enabled:
        ctx.report_failure(e, failure_reason="script_error")
    raise
```

批量/自定义字段：

```python
ctx.callback.report([
    {"status": "success", "durationMs": 800},
    {"status": "success", "durationMs": 900, "logs": "checkpoint 2"},
])
```

## HttpClient / AsyncHttpClient（通用请求）

```python
from autoflow_sdk import HttpClient, AsyncHttpClient

http = HttpClient(base_url="http://admin-api:3105", timeout=30.0,
                  headers={"Authorization": f"Bearer {token}"})
resp = http.get("/api/tasks")            # 返回原始 httpx.Response（含 envelope）

async with AsyncHttpClient(base_url=...) as ahttp:
    resp = await ahttp.post("/api/x", json={"a": 1})
```

| API | 说明 |
|-----|------|
| `get/post/put/delete(path, **kwargs)` | 同步/异步双版本；返回**原始** `httpx.Response`（`raise_for_status` 已做，不替你拆信封） |
| `HttpClientError` | `httpx.HTTPStatusError` 子类（ECO-01 起）——`isinstance` 可判「SDK 管辖的传输错误」；既有 `except httpx.HTTPStatusError` 零破坏 |
| 默认超时 | 30 s（通用客户端；回调客户端 10 s） |
| 重试 | **无自动重试**——重试决策留给任务代码 |

## 日志

```python
from autoflow_sdk import TaskContext

ctx = TaskContext.from_env()
ctx.log.info(f"task {ctx.task_id} started")
ctx.log.warning("fallback used")
```

- `ctx.log` 即 `logging` 标准库 logger（`get_logger(task_name)`，stdout handler，
  `%(asctime)s [%(levelname)s] %(name)s - %(message)s` 格式）——**无内存 buffer**，
  stdout/stderr 由执行器采集为执行日志（与 node 侧采集路径不同，见[能力矩阵](./capability-matrix)）。

## 结果构造器

```python
from autoflow_sdk import TaskResult

result = TaskResult.ok(message="done", output={"rows": 42})
failed = TaskResult.fail(message="boom")
```

`TaskResult.ok()/fail()` 为独立类方法（非 ctx 方法，与 node 的
`ctx.success()/failure()` 形态不同、实用面等价）。

## 协议模型（py 独有）

```python
from autoflow_sdk.models import TaskConfig

config = TaskConfig(
    name="weekday-report",
    runtime="python",
    entrypoint="tasks/report.py",
    timeout_seconds=300,        # snake/camel 归一化：config.timeout == 300 同真
    timezone="Asia/Shanghai",
    max_retry=3,
    retry_delay=15,
)
```

`TaskConfig` / `ExecuteRequest` / `ExecuteResult` 为 pydantic 模型，供执行器与
消费方导入校验协议体（node 执行器走手写校验，SDK 不承担）。

## 公开导出清单

`TaskContext`、`get_logger`、`HttpClient`、`AsyncHttpClient`、`HttpClientError`、
`TaskResult`、`ExecuteRequest`、`ExecuteResult`、`TaskConfig`、`CallbackClient`、
`CallbackDisabledError`（`autoflow_sdk.__version__` 当前 `1.2.0`）。

## 下一步

- [能力矩阵](./capability-matrix)：与 node SDK 的 5 条差异逐条裁定
- [官方示例库](./examples)
