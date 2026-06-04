import asyncio
import logging
import os
import httpx
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
    before_sleep_log,
)
from config import settings
import psutil

logger = logging.getLogger(__name__)

# Global count of currently-running tasks (updated by routers/execute.py)
running_count = 0


@retry(
    reraise=False,
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException, OSError)),
    before_sleep=before_sleep_log(logger, logging.WARNING),
)
async def _send_heartbeat(client: httpx.AsyncClient, token: str) -> None:
    """ERR-04: single heartbeat attempt — tenacity retries this on transient failures."""
    headers = {'Authorization': f'Bearer {token}'} if token else {}
    cpu = psutil.cpu_percent(interval=1)
    mem = psutil.virtual_memory().percent
    await client.post(
        f'{settings.admin_api_url}/api/executors/heartbeat',
        json={
            'address': settings.executor_address,
            'cpuUsage': cpu,
            'memUsage': mem,
            'runningTaskCount': running_count,
        },
        headers=headers,
        timeout=5,
    )


async def heartbeat_task() -> None:
    while True:
        try:
            await asyncio.sleep(30)
            # SEC-04: unified token variable name
            token = os.environ.get('EXECUTOR_SECRET') or os.environ.get('EXECUTOR_SHARED_TOKEN') or ''
            async with httpx.AsyncClient() as client:
                await _send_heartbeat(client, token)
        except Exception as e:
            # ERR-04: all retries exhausted — log as warning and keep the loop alive
            logger.warning(f'Heartbeat failed after all retries: {e}')
