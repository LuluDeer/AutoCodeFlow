from fastapi import APIRouter, HTTPException
from datetime import datetime, timezone
import psutil
import httpx
import os
from admin_api import build_admin_api_url, get_admin_api_base_url
from auth import has_dynamic_token
from config import settings

router = APIRouter()

# Module-level state updated by heartbeat task
_last_heartbeat_time: str | None = None
_admin_api_reachable: bool | None = None


def _get_health_token() -> str:
    """Return the executor auth token using the same precedence as auth.py."""
    return os.environ.get('EXECUTOR_SHARED_TOKEN') or os.environ.get('EXECUTOR_SECRET') or ''


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
    token = _get_health_token()
    return {
        'status': 'ok',
        'appName': settings.app_name,
        'address': settings.executor_address,
        'cpu': psutil.cpu_percent(),
        'mem': psutil.virtual_memory().percent,
        'adminApiReachable': admin_ok,
        # E-42（DEEP_REVIEW 0ef3bbe）：tokenValid 保持向后兼容（= 静态 token 已配置），
        # 另拆出 dynamicTokenActive 暴露动态 /token 链路是否当前持有凭证——旧探针只报
        # 静态，动态链路坏了不报警；双布尔让运维一眼看出「静态配了但动态没下来」。
        'tokenValid': bool(token),
        'tokenConfigured': bool(token),
        'dynamicTokenActive': has_dynamic_token(),
        'lastHeartbeat': _last_heartbeat_time,
    }


async def _readiness() -> dict:
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


# E-20（DEEP_REVIEW 0ef3bbe）：就绪探针规范路径统一为 /health/ready——与 admin-api
# /api/health/ready、executor-node /health/ready 全链路对齐。旧路径
# /health/readiness 保留为 deprecated alias 一个版本（运维存量探针不致 404）。
@router.get('/health/ready')
async def readiness():
    return await _readiness()


@router.get('/health/readiness')
async def readiness_alias():
    """Deprecated alias for /health/ready — kept for one release, see E-20."""
    return await _readiness()
