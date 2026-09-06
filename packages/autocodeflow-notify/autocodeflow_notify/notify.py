"""Notification utilities for AutoCodeFlow task code.

Allows task code to send notifications through the AutoCodeFlow admin API.
"""
from __future__ import annotations

import logging
import re
from enum import Enum
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


class NotifyChannel(str, Enum):
    EMAIL = "email"
    DINGTALK = "dingtalk"
    WECOM = "wecom"
    SLACK = "slack"
    WEBHOOK = "webhook"


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

    def __init__(self, admin_api_url: str = "http://localhost:3105", auth_token: Optional[str] = None):
        self._base = admin_api_url.rstrip("/")
        self._token = auth_token

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
        otherwise. Never raises — check the return value to know whether the
        alert was actually delivered.
        """
        payload: dict = {
            "title": f"[{level.upper()}] {task_name}",
            "content": message,
            "level": level,
        }
        if channels:
            payload["channels"] = [c.value for c in channels]
        if task_id:
            payload["taskId"] = task_id
        # Per-request webhook: server DTO field is `webhookUrl`; the server
        # also auto-adds the webhook channel when webhookUrl is present.
        if webhook_url:
            payload["webhookUrl"] = webhook_url

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                # N22: admin-api route is singular `/api/notification/send`
                # (NotificationConfigController @Controller("notification")).
                resp = await client.post(
                    f"{self._base}/api/notification/send",
                    json=payload,
                    headers=self._headers(),
                )
        except Exception as e:
            logger.error(f"Failed to send notification: {e}")
            return False
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