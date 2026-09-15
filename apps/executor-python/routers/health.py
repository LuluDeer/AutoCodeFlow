from fastapi import APIRouter
from fastapi.responses import JSONResponse
from datetime import datetime, timezone
from pydantic import ValidationError
import psutil
import httpx
import os
from admin_api import build_admin_api_url, get_admin_api_base_url
from auth import has_dynamic_token
from config import settings
# A3-C：就绪出参必经生成的协议 schema（契约不再只是被测试引用的产物）
from generated.protocol_schemas import HealthReadyResponse as ProtocolHealthReadyResponse

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


# A3（executor-protocol）：就绪判定维度与 executor-node 对齐为「资源 + admin 连通性」
# ——此前 python 只看 admin 连通性、node 只看资源，各缺一块。阈值与 node 同为 90%。
# 注意：这里**不**用 HTTPException——它会把载荷包进 {"detail": {...}}，与 node 的
# 扁平载荷、以及契约「payload 外不得再包一层自定义键」冲突。
READY_RESOURCE_LIMIT_PERCENT = 90


def _resources_ok() -> tuple[bool, str | None]:
    """资源维度判定（与 executor-node /health/ready 同阈值）。"""
    cpu = psutil.cpu_percent()
    mem = psutil.virtual_memory().percent
    if cpu >= READY_RESOURCE_LIMIT_PERCENT or mem >= READY_RESOURCE_LIMIT_PERCENT:
        return False, f'Resource usage too high (cpu={cpu:.1f}% mem={mem:.1f}%)'
    return True, None


def _ready_json(status_code: int, content: dict) -> JSONResponse:
    """A3-C：/health/ready 载荷必经**生成的** HealthReadyResponse 校验。

    构造方就是本模块，校验失败 = 探针形状被改漂移（如退回旧值 'unready'），
    直接抛错让上层看见，而不是静默发出 LB 无法理解的状态。
    """
    try:
        ProtocolHealthReadyResponse.model_validate(content)
    except ValidationError as exc:  # pragma: no cover - 仅在本模块改漂移时触发
        first = exc.errors()[0]
        where = '.'.join(str(p) for p in first['loc']) or '(root)'
        raise RuntimeError(
            f'readiness response violates executor-protocol at {where}: {first["msg"]}'
        ) from exc
    return JSONResponse(status_code=status_code, content=content)


async def _readiness() -> JSONResponse:
    """Readiness probe — admin 连通性 + 本机资源（A3 三方契约同形）。"""
    admin_api_ok = await _check_admin_api()
    if not admin_api_ok:
        return _ready_json(
            503,
            {
                'status': 'not_ready',
                'reason': 'admin-api unreachable',
                'adminApiUrl': get_admin_api_base_url(),
            },
        )
    ok, reason = _resources_ok()
    if not ok:
        return _ready_json(
            503,
            {'status': 'not_ready', 'reason': reason},
        )
    return _ready_json(
        200,
        {
            'status': 'ready',
            'appName': settings.app_name,
            'address': settings.executor_address,
            'adminApiReachable': admin_api_ok,
        },
    )


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
