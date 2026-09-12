# autocodeflow-http — 带重试/鉴权/熔断的 HTTP 客户端库

> 所属: docs/atlas/02-packages/python-libs · 最后核对: 2026-09-13 · 对应代码: packages/autocodeflow-http

## 职责

PyPI 包 `autocodeflow-http`（v0.1.0，Python >= 3.10）：给任务脚本提供一个**开箱即用的健壮 HTTP 客户端** `AutoFlowHttpClient`——内置指数退避重试、Bearer 鉴权头、简单熔断器。定位是"任务调用外部服务"（第三方 API、内部微服务），与 [autoflow-sdk](../autoflow-sdk.md) 里面向 admin-api 回调的 httpx 薄封装互不替代。

依赖（pyproject.toml 核实）：`httpx>=0.25.0`、`tenacity>=8.0.0`（重试原语）。dev extras 含 `pytest-httpx`。

## 目录结构与关键文件

```
packages/autocodeflow-http/
├── pyproject.toml
├── autocodeflow_http/
│   ├── __init__.py          __all__ = ["AutoFlowHttpClient", "CircuitBreaker", "RetryConfig", "SAFE_METHODS"]
│   └── client.py            全部实现
└── tests/
    ├── conftest.py
    └── test_client.py
```

## 公开 API 面（源码核实）

### RetryConfig（dataclass）

```python
@dataclass
class RetryConfig:
    max_retries: int = 3
    min_wait_sec: float = 1.0
    max_wait_sec: float = 30.0
    retryable_statuses: tuple[int, ...] = (429, 500, 502, 503, 504)
    safe_methods_only: bool = True   # U4
```

- `safe_methods_only=True`（U4）是**默认安全姿势**：自动重试仅限 RFC 9110 "safe" 方法（`SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})`）；POST/PUT/PATCH/DELETE 只尝试一次——超时或 5xx 后重放可能在外部服务上造成重复副作用。确要全方法重试，显式传 `safe_methods_only=False`（仅适合自带幂等键的端点）。

### CircuitBreaker（dataclass）

```python
CircuitBreaker(failure_threshold=5, reset_timeout_sec=60.0)
```

- 三态：`closed → open → half_open → closed`。连续失败达 `failure_threshold` 则 open（记 warning 日志）；open 超过 `reset_timeout_sec` 后转 half_open 放行一个探测请求；成功即回 closed。open 期间请求直接 `RuntimeError("Circuit breaker is open — request blocked")`。

### AutoFlowHttpClient

```python
AutoFlowHttpClient(base_url="", auth_token=None, timeout_sec=30.0,
                   retry_config=None, circuit_breaker=None)
await client.get(path) / post(path, data=None) / put(...) / delete(...)
```

- `base_url` 自动去尾斜杠；`auth_token` 存在时所有请求自动带 `Authorization: Bearer <token>`；支持 per-request 追加 headers。
- 请求为 async（httpx.AsyncClient）；重试经 tenacity 按 `RetryConfig` 指数退避（min→max wait），可重试条件 = 网络异常 + `retryable_statuses`。
- 熔断与重试组合：每次请求先问 `breaker.is_open`，结束后回报 `breaker.success()/failure()`。

### 典型用法

```python
from autocodeflow_http import AutoFlowHttpClient, RetryConfig

client = AutoFlowHttpClient(base_url="https://api.example.com", auth_token="xxx")
resp = await client.get("/data")        # GET：自动重试 + 熔断保护
await client.post("/orders", data={...})  # POST：默认只试一次（U4）
```

## 与其他组件的关系

- **被依赖**：仅任务脚本（见 [python-libs 总览](README.md) 的依赖图）。
- **容易混淆的三个 httpx 封装**：
  - 本库 → 任务调任意外部服务，带重试/熔断；
  - [autoflow-sdk](../autoflow-sdk.md) 的 `HttpClient` → admin-api 回调专用，无重试；
  - admin-api 自身出站用 axios——三处互不共享代码。
- 不在 release-please / release.yml lockstep 发布矩阵中。

## 常见改动场景

- **调重试策略**：优先改调用方的 `RetryConfig`（不动库）；要改默认值时同步 `tests/test_client.py` 的既有断言。
- **加熔断指标/日志**：在 `CircuitBreaker.failure()/success()` 处埋点 → 补测试。
- **加同步版客户端**：新公开类 `SyncAutoFlowHttpClient`（httpx.Client），更新 `__init__` 导出、pyproject（无新依赖）与本文档；注意 safe-methods-only 语义必须在同步版同样成立（U4 是行为契约，不只是参数）。

## 相关文档

- [python-libs 总览](README.md) · [ai](ai.md) · [db](db.md) · [notify](notify.md)
- [autoflow-sdk（回调专用客户端）](../autoflow-sdk.md)
