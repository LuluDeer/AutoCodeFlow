import asyncio
import logging
import uuid
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
from auth import get_current_token, adopt_executor_token_hash, request_with_self_heal

logger = logging.getLogger(__name__)

# R9 (round-9): the process-life identity now lives in startup_identity.py
# (auth.py needs it for POST /token and cannot import scheduler.py — cycle).
# Re-exported here so existing importers (main.py, tests) keep working.
from startup_identity import executor_started_at, executor_startup_id  # noqa: F401

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


# E1 (CONSISTENCY round, parity with executor-node scheduler.ts STALE-01):
# admin's recoverStaleExecutions grants liveness protection ONLY to executors
# that report runningExecutionIds — a missing field means "legacy executor,
# never reported" and skips the protection (scheduler.service.ts:631), so a
# python executor in the prepare stage (git clone + venv, up to ~600s) gets
# its execution misjudged FAILED mid-run. The live-execution registry lives
# in routers/execute.py which imports this module — importing back would form
# a cycle, so the data owner registers its getter here (same posture as node).
# The field must ALWAYS be sent (an empty list = reported & idle); the only
# forbidden shape is omitting it.
def _default_running_execution_ids() -> list:
    return []


_running_execution_ids_provider = _default_running_execution_ids


def register_running_execution_ids_provider(fn) -> None:
    """Install the getter returning currently-live executionIds."""
    global _running_execution_ids_provider
    _running_execution_ids_provider = fn


# E2 (node scheduler.ts deadLetterCountProvider parity): dead-letter backlog
# reported via heartbeat so long disconnections (callbacks parked on disk)
# stay visible to ops. Default provider returns 0 — an executor that has
# never imported routers/execute reports "no dead letters" rather than
# omitting the field.
def _default_dead_letter_count() -> int:
    return 0


_dead_letter_count_provider = _default_dead_letter_count


def register_dead_letter_count_provider(fn) -> None:
    """Install the getter returning the dead-letter file count."""
    global _dead_letter_count_provider
    _dead_letter_count_provider = fn


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
    """ERR-04: single heartbeat attempt — tenacity retries this on transient failures.

    R11 (round-11, port of executor-node R10 gap #3): the request goes through
    ``request_with_self_heal`` so a 401 (admin rotated our per-executor token
    out from under us, e.g. the admin-UI rotate-token button) triggers ONE
    immediate re-fetch + retry instead of waiting for the 30-minute scheduled
    refresh — during which the heartbeat would keep 401ing and the executor
    get marked OFFLINE after 3 missed intervals. The heal is bounded to one
    auth retry per attempt (a persistent 401 still falls through to
    ``raise_for_status`` below and the tenacity loop), and admin-api's
    issueToken is idempotent per (address, startupId), so concurrent 401s
    converge on the same token instead of rotating.
    """
    # OPS-03: propagate trace ID for cross-service tracing
    headers = {'X-Trace-Id': trace_id} if trace_id else {}
    cpu = await asyncio.to_thread(psutil.cpu_percent, 1)
    mem = psutil.virtual_memory().percent
    response = await request_with_self_heal(
        client,
        'post',
        build_admin_api_url('/executors/heartbeat'),
        token=token,
        headers=headers,
        json={
            'address': settings.executor_address_public or settings.executor_address,
            'cpuUsage': cpu,
            'memUsage': mem,
            'runningTaskCount': get_running_count(),
            # E1: liveness report — capped at 200 ids (node parity,
            # scheduler.ts sendHeartbeat). Always present, never omitted.
            'runningExecutionIds': _running_execution_ids_provider()[:200],
            # E2: dead-letter backlog (node scheduler.ts sendHeartbeat sends
            # deadLetterCountProvider()). Always present, never omitted; the
            # provider serves a cached count so this never rescans the disk.
            'deadLetterCount': max(0, int(_dead_letter_count_provider())),
            'restartedAt': executor_started_at,
            'startupId': executor_startup_id,
        },
        timeout=5,
    )
    response.raise_for_status()
    # R9 (round-9, W3 parity with executor-node scheduler.ts): admin
    # heartbeats echo the executor's current stored tokenHash
    # ({code,message,data:{tokenHash}} envelope) — adopt it so the
    # per-execution callback-token HMAC key follows admin-side rotations
    # instead of going stale (picked up within heartbeatIntervalSeconds).
    try:
        adopt_executor_token_hash(response.json())
    except Exception:  # pragma: no cover - non-JSON / empty admin bodies
        pass


async def heartbeat_task() -> None:
    while True:
        try:
            await asyncio.sleep(settings.heartbeat_interval_seconds)
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
