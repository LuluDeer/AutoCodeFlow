"""R134-A1 错误处理 / 资源生命周期审计（autocodeflow-http）的红灯用例。

审计对象：packages/autocodeflow-http/autocodeflow_http/client.py

轴 1（重试/退避上限）：_WaitWithRetryAfter 对服务器 Retry-After 取
max(backoff, parsed)，**没有上限**：服务端/代理回 Retry-After: 3600 时
客户端会真睡一小时（RetryConfig.max_wait_sec 只约束自身指数退避），
任务的执行预算被单次退避吃穿。这里要求提供一个可选的、显式的上限开关
（默认 None 保持"无条件尊重服务端"的既有行为，该行为已被
test_retry_after_header_influences_wait 钉死，不破坏）。

注：熔断态抛裸 RuntimeError（调用方无法与编程错误区分）已作为发现记录在
报告中，但按总控指示「纯异常层级美化」不改代码。
"""
from __future__ import annotations

import time

import httpx
import pytest

from autocodeflow_http import AutoFlowHttpClient, RetryConfig

BASE = "http://api.example.com"


class TestRetryAfterHasABound:
    """轴 1：服务器指定的等待时间必须有可配置上限。"""

    def test_retry_config_default_keeps_server_directive(self):
        """默认 None = 继续无条件尊重 Retry-After（既有契约，不改）。"""
        assert RetryConfig().max_retry_after_sec is None

    @pytest.mark.asyncio
    async def test_retry_after_wait_is_capped(self, respx_mock):
        route = respx_mock.get(BASE + "/data").mock(
            side_effect=[
                httpx.Response(429, headers={"Retry-After": "3"}),
                httpx.Response(200, json={"ok": True}),
            ]
        )
        client = AutoFlowHttpClient(
            base_url=BASE,
            retry_config=RetryConfig(
                max_retries=1,
                min_wait_sec=0.001,
                max_wait_sec=0.002,
                max_retry_after_sec=0.05,
            ),
        )
        try:
            start = time.monotonic()
            resp = await client.get("/data")
            elapsed = time.monotonic() - start
        finally:
            await client.aclose()
        assert resp.status_code == 200
        assert route.call_count == 2
        assert elapsed < 1.0, f"Retry-After not capped by max_retry_after_sec: {elapsed:.2f}s"

    @pytest.mark.asyncio
    async def test_unconfigured_client_still_honours_retry_after(self, respx_mock):
        """回归护栏：默认 None 时逐秒尊重服务端指令（不引入隐形上限）。"""
        route = respx_mock.get(BASE + "/data").mock(
            side_effect=[
                httpx.Response(429, headers={"Retry-After": "0.2"}),
                httpx.Response(200, json={"ok": True}),
            ]
        )
        client = AutoFlowHttpClient(
            base_url=BASE,
            retry_config=RetryConfig(max_retries=1, min_wait_sec=0.001, max_wait_sec=0.002),
        )
        try:
            start = time.monotonic()
            resp = await client.get("/data")
            elapsed = time.monotonic() - start
        finally:
            await client.aclose()
        assert resp.status_code == 200
        assert route.call_count == 2
        assert elapsed >= 0.15
