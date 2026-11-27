"""Pull 模式配置热更新：异步排队 + 节流，避免阻塞任务领取热路径。

admin pull 响应里的 `configVersion` 指纹变化时，需要 GET /executors/config
拉全量配置并回环本地 /api/config/reload 应用。该链路涉及两次 HTTP（网络 +
本地路由校验），旧实现直接 `await` 在 pull 长轮询的响应处理路径上——admin
每次下发新配置都会推迟下一次长轮询，使控制命令与任务派发静默变慢。

本模块把「版本号变化」与「真正拉取」解耦：热路径只做一次纯内存比较与
`asyncio.create_task`，拉配置在后台进行；失败保留旧版本号，下一轮 pull
自然重试。节流窗口保证配置源持续抖动时不会形成拉取风暴。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any
from urllib.parse import quote

import httpx

from admin_api import build_admin_api_url
from auth import get_current_token, request_with_self_heal, _unwrap_envelope
from config import settings
from device_identity import get_device_fingerprint

logger = logging.getLogger(__name__)

# 拉取失败后的冷却窗口（ms）。与 node pull.ts 的 CONFIG_RETRY_THROTTLE_MS 对齐：
# 同一版本在窗口内不重复拉取，避免 admin 暂时不可用时每轮长轮询都发一次
# 注定失败的请求。
CONFIG_RETRY_THROTTLE_MS = 60_000

_applied_config_version: str | None = None
_last_attempt_mono: float = 0.0
_inflight: set[asyncio.Task] = set()


def _throttled(now_mono: float) -> bool:
    return bool(_last_attempt_mono and now_mono - _last_attempt_mono < CONFIG_RETRY_THROTTLE_MS / 1000)


async def _fetch_and_apply(admin_config_version: str) -> None:
    """后台实际拉取动作；失败只记日志，保留旧版本号供下一轮重试。"""
    global _applied_config_version
    try:
        token = await get_current_token()
        # 复用 scheduler 的 per-loop 共享池（延迟导入避免模块级环）。
        from scheduler import get_http_client

        client = get_http_client()
        address = settings.executor_address_public or settings.executor_address
        fingerprint = get_device_fingerprint()
        response = await request_with_self_heal(
            client,
            'get',
            build_admin_api_url(
                f'/executors/config?address={quote(address)}'
                + (f'&deviceFingerprint={quote(fingerprint)}' if fingerprint else '')
            ),
            token=token,
            timeout=10,
        )
        response.raise_for_status()
        # 信封 bug：admin 的全局拦截器把响应包成 {code,message,data}，直接
        # POST 到本地 /config/reload 会把信封壳当成配置，所有字段都被
        # ignored_fields 拒绝，热更新永远不生效。
        body = _unwrap_envelope(response.json())
        if not isinstance(body, dict):
            logger.warning('Pull-mode config fetch returned a non-object payload; '
                           'keeping applied config version')
            return
        local_url = f'http://127.0.0.1:{settings.port}/api/config/reload'
        local = await client.post(
            local_url,
            json=body,
            headers={'Authorization': f'Bearer {token}'},
            timeout=10,
        )
        if 200 <= local.status_code < 300:
            _applied_config_version = admin_config_version
            updated = local.json().get('updated_fields', [])
            logger.info('Pull-mode config hot-reloaded (version %s): %s',
                        admin_config_version, ', '.join(updated) or 'no changes')
        else:
            logger.warning('Pull-mode config reload rejected by local /config/reload (HTTP %s)',
                           local.status_code)
    except Exception as exc:  # noqa: BLE001 - best-effort
        logger.warning('Pull-mode config reload failed: %s', exc)


def maybe_pull_config(admin_config_version: Any) -> None:
    """热路径入口：纯内存比较 + 触发后台任务，永不 await 网络 IO。

    失败/节流期间保持旧 `_applied_config_version`，下一次 pull 携带同一
    指纹时会再次进入本函数（节流窗口过后自然重试）。
    """
    global _last_attempt_mono
    if not isinstance(admin_config_version, str) or not admin_config_version:
        return
    if _applied_config_version == admin_config_version:
        return
    now = time.monotonic()
    if _throttled(now):
        return
    _last_attempt_mono = now
    task = asyncio.create_task(_fetch_and_apply(admin_config_version))
    _inflight.add(task)
    task.add_done_callback(_inflight.discard)


async def wait_for_config_pull() -> None:
    """测试/停机出口：等待在飞的配置拉取结束（生产停机不调用）。"""
    if _inflight:
        await asyncio.gather(*list(_inflight), return_exceptions=True)


def reset_for_test() -> None:
    """测试出口：清空模块级节流/版本状态。"""
    global _applied_config_version, _last_attempt_mono
    _applied_config_version = None
    _last_attempt_mono = 0.0
