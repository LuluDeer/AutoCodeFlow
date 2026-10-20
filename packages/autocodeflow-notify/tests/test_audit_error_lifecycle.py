"""R134-A1 错误处理 / 资源生命周期审计（autocodeflow-notify）的红灯用例。

审计对象：packages/autocodeflow-notify/autocodeflow_notify/notify.py

- 轴 1（错误面）：channels 只接受 NotifyChannel 枚举，传等价的普通字符串
  ("email" / ["email"]) 会在 payload 组装阶段炸 AttributeError:
  'str' object has no attribute 'value' —— 一个不可分类、没有可操作信息的
  内部异常（而且发生在 notify() 承诺 "Never raises" 的 try 块之外）。
  同理，未知渠道名也只得到 AttributeError，而不是一条列出合法值的错误。
- 轴 1（可分类性）：失败只返回 False + 一行日志，调用方拿不到"为什么"——
  网络错 / 4xx / 5xx 无法区分，原始异常对象被丢弃。
"""
from __future__ import annotations

import json
import logging

import httpx
import pytest

from autocodeflow_notify import NotifyChannel, NotifyClient

BASE = "http://localhost:3105"
URL = "http://localhost:3105/api/notification/send"


@pytest.fixture
def client():
    c = NotifyClient(admin_api_url=BASE)
    yield c


class TestChannelArgumentValidation:
    """轴 1：非法/等价形态的 channels 参数必须给出可操作的错误，或正常工作。"""

    @pytest.mark.asyncio
    async def test_plain_string_channels_send_the_right_payload(self, respx_mock, client):
        route = respx_mock.post(URL).mock(return_value=httpx.Response(200, json={}))
        try:
            assert await client.notify("t", "m", channels=["email", "slack"]) is True
        finally:
            await client.aclose()
        body = json.loads(route.calls.last.request.content)
        assert body["channels"] == ["email", "slack"]

    @pytest.mark.asyncio
    async def test_single_string_channel_is_not_split_into_characters(self, respx_mock, client):
        route = respx_mock.post(URL).mock(return_value=httpx.Response(200, json={}))
        try:
            assert await client.notify("t", "m", channels="feishu") is True
        finally:
            await client.aclose()
        body = json.loads(route.calls.last.request.content)
        assert body["channels"] == ["feishu"]

    @pytest.mark.asyncio
    async def test_unknown_channel_raises_clear_value_error(self, client):
        with pytest.raises(ValueError, match="carrier-pigeon"):
            await client.notify("t", "m", channels=["carrier-pigeon"])
        await client.aclose()

    @pytest.mark.asyncio
    async def test_enum_channels_still_work(self, respx_mock, client):
        """回归护栏：原有枚举用法逐字节不变。"""
        route = respx_mock.post(URL).mock(return_value=httpx.Response(200, json={}))
        try:
            await client.notify("t", "m", channels=[NotifyChannel.SLACK, NotifyChannel.EMAIL])
        finally:
            await client.aclose()
        body = json.loads(route.calls.last.request.content)
        assert body["channels"] == ["slack", "email"]


class TestFailureIsClassifiable:
    """轴 1：返回 False 时必须能问出"为什么"。"""

    @pytest.mark.asyncio
    async def test_transport_failure_exposes_last_error_and_traceback(self, respx_mock, client, caplog):
        respx_mock.post(URL).mock(side_effect=httpx.ConnectError("connection refused"))
        try:
            with caplog.at_level(logging.ERROR, logger="autocodeflow_notify.notify"):
                assert await client.notify("t", "m") is False
        finally:
            await client.aclose()

        assert isinstance(client.last_error, httpx.ConnectError)
        assert "connection refused" in str(client.last_error)
        # 原始异常必须带 traceback 落日志，而不是只剩 f"{e}" 一行
        record = next(
            r for r in caplog.records if "Failed to send notification" in r.getMessage()
        )
        assert record.exc_info is not None

    @pytest.mark.asyncio
    async def test_non_2xx_records_status_code(self, respx_mock, client):
        respx_mock.post(URL).mock(return_value=httpx.Response(401, json={"message": "bad token"}))
        try:
            assert await client.notify("t", "m") is False
        finally:
            await client.aclose()
        assert client.last_status_code == 401

    @pytest.mark.asyncio
    async def test_success_resets_carried_failure_state(self, respx_mock, client):
        respx_mock.post(URL).mock(return_value=httpx.Response(200, json={}))
        try:
            assert await client.notify("t", "m") is True
        finally:
            await client.aclose()
        assert client.last_error is None
        assert client.last_status_code == 200
