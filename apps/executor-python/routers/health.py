from fastapi import APIRouter, HTTPException
import psutil
import httpx
import os
from config import settings

router = APIRouter()


async def _check_admin_api():
    """OPS-02: Check connectivity to admin-api for readiness probe."""
    token = os.environ.get('EXECUTOR_SECRET') or os.environ.get('EXECUTOR_SHARED_TOKEN') or ''
    headers = {'Authorization': f'Bearer {token}'} if token else {}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(
                f'{settings.admin_api_url}/api/executors/heartbeat',
                headers=headers,
            )
            return resp.status_code == 200
    except Exception:
        return False


@router.get('/health')
async def health():
    """Liveness probe - basic health check."""
    return {
        'status': 'ok',
        'appName': settings.app_name,
        'address': settings.executor_address,
        'cpu': psutil.cpu_percent(),
        'mem': psutil.virtual_memory().percent,
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
                'adminApiUrl': settings.admin_api_url,
            },
        )
    return {
        'status': 'ready',
        'appName': settings.app_name,
        'address': settings.executor_address,
        'adminApiReachable': admin_api_ok,
    }
