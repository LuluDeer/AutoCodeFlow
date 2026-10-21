"""Notification utilities for AutoCodeFlow task code.

Allows task code to send notifications through the AutoCodeFlow admin API.
"""
from __future__ import annotations

import logging
import re
from enum import Enum
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


class NotifyChannel(str, Enum):
    """Official channel table for task authors (PK-12).

    Must mirror the server-side ``AlertChannel`` enum in
    apps/admin-api/src/modules/notification/notification.service.ts —
    FEISHU added there by NF-05 (飞书自定义机器人).
    """

    EMAIL = "email"
    DINGTALK = "dingtalk"
    WECOM = "wecom"
    SLACK = "slack"
    WEBHOOK = "webhook"
    FEISHU = "feishu"


def _body_digest(body: str, limit: int = 200) -> str:
    """Build a short plain-text digest of an HTTP response body for logs.

    Error pages may be HTML: strip tags, collapse whitespace and truncate so
    log lines stay single-line and bounded.
    """
    plain = re.sub(r"<[^>]+>", " ", body or "")
    plain = re.sub(r"\s+", " ", plain).strip()
    if len(plain) > limit:
        plain = plain[:limit] + "..."
    return plain or "[empty body]"


def _normalise_channels(channels: Any) -> Optional[list[str]]:
    """R134-A1: 把 channels 归一化成 admin-api 接受的字符串数组。

    接受 NotifyChannel、等价的普通字符串（"email"）、单个值或它们的列表。
    非法渠道名抛一条带合法值清单的 ValueError——此前会在 payload 组装时炸
    AttributeError: 'str' object has no attribute 'value'：既不可分类，也没有
    任何可操作信息，而且发生在 notify() "Never raises" 的 try 块之外（于是
    "永不抛"的承诺被一个纯拼写错误击穿）。

    空列表/None -> None（payload 里不出现 channels 键，与旧行为一致）。
    """
    if channels is None:
        return None
    if isinstance(channels, str):
        # NotifyChannel 是 str 子类，这里一并覆盖；单个字符串不再被逐字符迭代。
        channels = [channels]
    values: list[str] = []
    for channel in channels:
        if isinstance(channel, NotifyChannel):
            values.append(channel.value)
            continue
        if isinstance(channel, str):
            try:
                values.append(NotifyChannel(channel).value)
            except ValueError as exc:
                raise ValueError(
                    f"Unknown notification channel {channel!r}; expected one of "
                    f"{[c.value for c in NotifyChannel]}"
                ) from exc
            continue
        raise TypeError(
            "channels entries must be NotifyChannel or str, got "
            f"{type(channel).__name__}: {channel!r}"
        )
    return values or None


class NotifyClient:
    """
    Notification client that sends alerts through the AutoCodeFlow admin API.

    Usage::

        client = NotifyClient(admin_api_url="http://localhost:3105")
        await client.notify(
            task_name="daily-report",
            message="Report generation completed",
            level="info",
            channels=[NotifyChannel.WECOM],
        )
    """

    def __init__(
        self,
        admin_api_url: str = "http://localhost:3105",
        auth_token: Optional[str] = None,
        timeout: float = 10.0,
    ):
        self._base = admin_api_url.rstrip("/")
        self._token = auth_token
        self._timeout = timeout
        # NETOPT-10-7: 实例级懒客户端（连接池复用）——任务收尾常见连续
        # notify_failure + notify_success 两次调用，此前每次新建 AsyncClient
        # = 两次完整 TLS 握手。check-then-set 在 asyncio 单线程内原子。
        self._client: Optional[httpx.AsyncClient] = None
        # R134-A1: 排障面——notify() 的返回值契约仍是 bool，但"为什么是
        # False"必须问得出来：最近一次传输失败的原始异常对象 + 最近一次响应
        # 状态码（网络层失败时 last_status_code 保持 None）。每次 notify() 重置。
        self.last_error: Optional[Exception] = None
        self.last_status_code: Optional[int] = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            # NETOPT-C P3: trust_env=False 与其余三端对齐（autoflow-sdk
            # callback/http.py、autocodeflow-http client）——任务进程回调不走
            # 代理，通知也不该走代理（同一进程同一出站策略，避免代理泄漏
            # 通知内容或被代理拦截）。
            self._client = httpx.AsyncClient(timeout=self._timeout, trust_env=False)
        return self._client

    async def aclose(self) -> None:
        """显式关闭底层 AsyncClient（连接池释放；幂等）。"""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    # NETOPT-C P3: async context manager 兜底——任务作者忘调 aclose 时
    # `async with NotifyClient(...) as client:` 保证连接池释放。
    async def __aenter__(self) -> "NotifyClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {}
        if self._token:
            h["Authorization"] = f"Bearer {self._token}"
        return h

    async def notify(
        self,
        task_name: str,
        message: str,
        level: str = "info",
        channels: Optional[list[NotifyChannel]] = None,
        task_id: Optional[str] = None,
        webhook_url: Optional[str] = None,
    ) -> bool:
        """Send a notification through the admin API.

        Returns True when the admin API accepted the request (2xx), False
        otherwise. Never raises for delivery problems (transport errors,
        non-2xx) — check the return value to know whether the alert was
        actually delivered, and read last_error / last_status_code to find
        out *why* it was not.

        Invalid channels values raise ValueError **before** any I/O: a
        misspelt channel name is a programmer error, and silently returning
        False would send the caller looking at the network instead of its own
        argument.
        """
        # R134-A1: 参数校验在 I/O 之前（纯函数，失败即抛，不进 try）。
        channel_values = _normalise_channels(channels)
        self.last_error = None
        self.last_status_code = None
        payload: dict = {
            "title": f"[{level.upper()}] {task_name}",
            "content": message,
            "level": level,
        }
        if channel_values:
            payload["channels"] = channel_values
        if task_id:
            payload["taskId"] = task_id
        # Per-request webhook: server DTO field is `webhookUrl`; the server
        # also auto-adds the webhook channel when webhookUrl is present.
        if webhook_url:
            payload["webhookUrl"] = webhook_url

        try:
            # N22: admin-api route is singular `/api/notification/send`
            # (NotificationConfigController @Controller("notification")).
            resp = await self._get_client().post(
                f"{self._base}/api/notification/send",
                json=payload,
                headers=self._headers(),
            )
        except Exception as e:
            # R134-A1: 原始异常必须留住——对象进 last_error，traceback 进日志
            # （此前只有一行 str(e)，异常对象被丢弃，调用方拿到 False 后无从查起）。
            self.last_error = e
            logger.error(f"Failed to send notification: {e}", exc_info=True)
            return False
        self.last_status_code = resp.status_code
        if resp.is_success:
            return True
        # R14: a non-2xx (401 invalid token, 400 invalid level/channels, ...)
        # used to be indistinguishable from success. Log it clearly and let
        # the caller react via the returned bool.
        logger.error(
            f"Notification rejected by admin API: status={resp.status_code} "
            f"body={_body_digest(resp.text)}"
        )
        return False

    async def notify_failure(
        self,
        task_name: str,
        error: str,
        exec_id: str = "",
        channels: Optional[list[NotifyChannel]] = None,
        webhook_url: Optional[str] = None,
    ) -> bool:
        """Send a failure notification."""
        content = f"Error: {error}"
        if exec_id:
            content = f"Execution ID: {exec_id}\n{content}"
        return await self.notify(
            task_name, content, level="error", channels=channels,
            webhook_url=webhook_url,
        )

    async def notify_success(
        self,
        task_name: str,
        duration_ms: int = 0,
        exec_id: str = "",
        channels: Optional[list[NotifyChannel]] = None,
        webhook_url: Optional[str] = None,
    ) -> bool:
        """Send a success notification."""
        content = f"Duration: {duration_ms}ms"
        if exec_id:
            content = f"Execution ID: {exec_id}\n{content}"
        return await self.notify(
            task_name, content, level="info", channels=channels,
            webhook_url=webhook_url,
        )