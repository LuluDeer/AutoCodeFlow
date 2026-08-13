import asyncio
import logging
import uuid
from datetime import datetime, timezone
import httpx
import threading
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
    before_sleep_log,
)
from admin_api import build_admin_api_url, get_admin_api_base_url
from config import settings
import psutil
from auth import get_current_token

logger = logging.getLogger(__name__)

executor_started_at = datetime.now(timezone.utc).isoformat()
executor_startup_id = str(uuid.uuid4())

# Global count of currently-running tasks with thread-safe operations
running_count = 0
_running_count_lock = threading.Lock()

def get_running_count() -> int:
    global running_count
    with _running_count_lock:
        return running_count

def increment_running() -> None:
    global running_count
    with _running_count_lock:
        running_count += 1

def decrement_running() -> None:
    global running_count
    with _running_count_lock:
        running_count = max(0, running_count - 1)


def _get_admin_api_url() -> str:
    """Get the appropriate Admin API base URL for heartbeat."""
    return get_admin_api_base_url()


def _heartbeat_retry_exhausted(retry_state):
    """Called when all retries are exhausted — return None to suppress RetryError."""
    logger.warning(f'Heartbeat failed after all retries: {retry_state.outcome.exception()}')
    return None


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException, httpx.TransportError, OSError)),
    before_sleep=before_sleep_log(logger, logging.WARNING),
    retry_error_callback=_heartbeat_retry_exhausted,
)
async def _send_heartbeat(client: httpx.AsyncClient, token: str, trace_id: str = None) -> None:
    """ERR-04: single heartbeat attempt — tenacity retries this on transient failures."""
    headers = {'Authorization': f'Bearer {token}'} if token else {}
    # OPS-03: propagate trace ID for cross-service tracing
    if trace_id:
        headers['X-Trace-Id'] = trace_id
    cpu = psutil.cpu_percent(interval=1)
    mem = psutil.virtual_memory().percent
    response = await client.post(
        build_admin_api_url('/executors/heartbeat'),
        json={
            'address': settings.executor_address_public or settings.executor_address,
            'cpuUsage': cpu,
            'memUsage': mem,
            'runningTaskCount': get_running_count(),
            'restartedAt': executor_started_at,
            'startupId': executor_startup_id,
        },
        headers=headers,
        timeout=5,
    )
    response.raise_for_status()


async def heartbeat_task() -> None:
    while True:
        try:
            await asyncio.sleep(30)
            # SEC-03: use dynamic token with auto-refresh
            token = await get_current_token()
            # OPS-03: generate trace ID for heartbeat
            trace_id = str(uuid.uuid4())
            logger.info(f'[{trace_id}] Sending heartbeat')
            async with httpx.AsyncClient(trust_env=False) as client:
                await _send_heartbeat(client, token, trace_id)
        except Exception as e:
            # ERR-04: all retries exhausted — log as warning and keep the loop alive
            logger.warning(f'Heartbeat failed after all retries: {e}')
