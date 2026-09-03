"""Notification utilities for AutoCodeFlow task code.

Allows task code to send notifications through the AutoCodeFlow admin API.
"""
from __future__ import annotations

import logging
from enum import Enum
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


class NotifyChannel(str, Enum):
    EMAIL = "email"
    DINGTALK = "dingtalk"
    WECOM = "wecom"
    SLACK = "slack"


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
    ) -> None:
        """Send a notification through the admin API."""
        payload: dict = {
            "title": f"[{level.upper()}] {task_name}",
            "content": message,
            "level": level,
        }
        if channels:
            payload["channels"] = [c.value for c in channels]
        if task_id:
            payload["taskId"] = task_id

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                # N22: admin-api route is singular `/api/notification/send`
                # (NotificationConfigController @Controller("notification")).
                await client.post(
                    f"{self._base}/api/notification/send",
                    json=payload,
                    headers=self._headers(),
                )
        except Exception as e:
            logger.error(f"Failed to send notification: {e}")

    async def notify_failure(
        self,
        task_name: str,
        error: str,
        exec_id: str = "",
        channels: Optional[list[NotifyChannel]] = None,
    ) -> None:
        """Send a failure notification."""
        content = f"Error: {error}"
        if exec_id:
            content = f"Execution ID: {exec_id}\n{content}"
        await self.notify(task_name, content, level="error", channels=channels)

    async def notify_success(
        self,
        task_name: str,
        duration_ms: int = 0,
        exec_id: str = "",
        channels: Optional[list[NotifyChannel]] = None,
    ) -> None:
        """Send a success notification."""
        content = f"Duration: {duration_ms}ms"
        if exec_id:
            content = f"Execution ID: {exec_id}\n{content}"
        await self.notify(task_name, content, level="info", channels=channels)