# autocodeflow-http

AutoCodeFlow 任务脚本的 HTTP 客户端库：内置**重试（tenacity）、Bearer 鉴权、
熔断器（circuit breaker）**，基于 httpx 的异步实现。

## 特性

- 自动重试：默认仅安全方法（GET/HEAD/OPTIONS）自动重试（`RetryConfig.safe_methods_only`），可重试状态码为 429/5xx；
- 熔断器：连续失败达到阈值后快速失败，避免对故障下游打雪崩流量；
- 连接池复用：实例级懒初始化 `httpx.AsyncClient`（PK-09），并显式 `trust_env=False`（任务进程出站不走代理 env，与其余库对齐）；
- async context manager：`async with` 兜底释放连接池，忘调 `aclose()` 也不会泄漏。

## 安装

```bash
pip install autocodeflow-http
# 或作为任务依赖（AutoCodeFlow 任务 requirements 字段）：
#   requirements: ["autocodeflow-http"]
```

## 最小示例

```python
from autocodeflow_http import AutoFlowHttpClient

async def run():
    async with AutoFlowHttpClient(
        base_url="https://api.example.com",
        auth_token="xxx",
    ) as client:
        resp = await client.get("/data")
        return resp.json()
```

重试与熔断参数可经 `RetryConfig` / `CircuitBreaker` 注入：

```python
from autocodeflow_http import AutoFlowHttpClient, CircuitBreaker, RetryConfig

async with AutoFlowHttpClient(
    base_url="https://api.example.com",
    retry_config=RetryConfig(max_retries=5),   # 最多 1 + 5 次尝试
    circuit_breaker=CircuitBreaker(failure_threshold=3),
) as client:
    resp = await client.get("/data")
```

> R134-A1：上面这段此前写的是 `RetryConfig(max_attempts=5)`——`RetryConfig`
> 没有 `max_attempts` 字段，照抄会直接 `TypeError`；已改为 `max_retries`。
> 同时示例改为 `async with`：本页声称"忘调 `aclose()` 也不会泄漏"，但那只在
> `async with` 下成立，裸构造且不关闭的客户端仍会漏掉连接池。

## 开发

```bash
pip install -e ".[dev]"
pytest
```
