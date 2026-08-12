from fastapi import APIRouter, HTTPException
from datetime import datetime, timezone
import psutil
import httpx
import os
from admin_api import build_admin_api_url, get_admin_api_base_url
from config import settings

router = APIRouter()

# Module-level state updated by heartbeat task
_last_heartbeat_time: str | None = None
_admin_api_reachable: bool | None = None


def record_heartbeat(success: bool) -> None:
    """Called by the heartbeat task to update last heartbeat state."""
    global _last_heartbeat_time, _admin_api_reachable
    _admin_api_reachable = success
    if success:
        _last_heartbeat_time = datetime.now(timezone.utc).isoformat()


async def _check_admin_api():
    """OPS-02: Check connectivity to admin-api for readiness probe."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(build_admin_api_url('/health'))
            return resp.status_code < 500
    except Exception:
        return False


@router.get('/health')
async def health():
    """Liveness probe - returns resource metrics and connectivity state."""
    # Use cached reachability if available, otherwise probe on demand
    admin_ok = _admin_api_reachable if _admin_api_reachable is not None else await _check_admin_api()
    token = os.environ.get('EXECUTOR_SECRET') or os.environ.get('EXECUTOR_SHARED_TOKEN') or ''
    return {
        'status': 'ok',
        'appName': settings.app_name,
        'address': settings.executor_address,
        'cpu': psutil.cpu_percent(),
        'mem': psutil.virtual_memory().percent,
        'adminApiReachable': admin_ok,
        'tokenValid': bool(token),
        'lastHeartbeat': _last_heartbeat_time,
    }


@router.get('/health/readiness')
async def readiness():
    """OPS-02: Readiness probe - verifies all dependencies are reachable."""
    admin_api_ok = await _check_admin_api()
    if not admin_api_ok:
        raise HTTPException(
            status_code=503,
            detail={
                'status': 'unready',
                'reason': 'admin-api unreachable',
                'adminApiUrl': get_admin_api_base_url(),
            },
        )
    return {
        'status': 'ready',
        'appName': settings.app_name,
        'address': settings.executor_address,
        'adminApiReachable': admin_api_ok,
    }
