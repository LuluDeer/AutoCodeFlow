"""P2-10（执行器服务审计，2026-10-26）：请求体大小上限中间件。

对齐 executor-node 的 `express.json({ limit: JSON_BODY_LIMIT = '2mb' })`
（main.ts:63）：FastAPI/uvicorn 默认**不限制**请求体长度——一个持有执行器
令牌的调用方（或令牌泄漏后的攻击者）可以向 `/api/execute` 发送任意大的
JSON（glueSource / params / secrets 无上限），单请求即可打爆执行器内存。

实现采用 **Content-Length 预检 + 流式字节计数** 双闸（starlette BaseHTTPMiddleware
形态，零新依赖）：

1. 带 `Content-Length` 的请求在**读 body 之前**就 413（连接上没有任何大
   载荷被物化）；
2. chunked / 无 Content-Length 的请求在接收过程中逐 chunk 计数，超限即
   413 并停止读取（`receive` 包装短路，下游读 body 的 await 处抛出）。

合法上限评估：admin 侧 params 有 64KB 字节门（TASK_PARAMS_MAX_BYTES = 65_536，
params-size.util.ts），glueSource 无显式限长但 node 执行器以 2MB JSON body
上限接收同一载荷（A-6：默认 100KB 会把超长 glueSource 的派发在 node 上
必然 413，python 对齐放宽到 2MB）——2MB 覆盖 admin 现有合法载荷（params
64KB + glue 源码 + requirements），与 node 逐字节同值。执行器入站只有
admin 的 dispatch/kill/logs 轮询与 config 推送，2MB 足够。
"""
from __future__ import annotations

import logging

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger(__name__)

# 与 executor-node config.ts JSON_BODY_LIMIT（'2mb'）同值同语义。
MAX_BODY_BYTES = 2 * 1024 * 1024


class _BodyTooLarge(Exception):
    """receive 流计数超限——由 dispatch 捕获并转 413。"""

    def __init__(self, received: int):
        super().__init__(f'body exceeded limit at {received} bytes')
        self.received = received


class RequestSizeLimitMiddleware(BaseHTTPMiddleware):
    """Reject request bodies larger than MAX_BODY_BYTES with 413."""

    def __init__(self, app, max_bytes: int = MAX_BODY_BYTES):
        super().__init__(app)
        self._max_bytes = max_bytes

    async def dispatch(self, request: Request, call_next):
        content_length = request.headers.get('content-length')
        if content_length:
            # ① Content-Length 预检：读 body 之前拒绝，不物化大载荷。
            try:
                declared = int(content_length)
            except ValueError:
                declared = None
            if declared is not None and declared > self._max_bytes:
                logger.warning(
                    'Request %s %s rejected: Content-Length %s exceeds %s bytes',
                    request.method, request.url.path, declared, self._max_bytes,
                )
                return self._too_large(declared)
        elif request.method in ('POST', 'PUT', 'PATCH'):
            # ② 无 Content-Length（chunked 等）：包装 receive 流式计数，
            # 超限在读 body 的 await 处抛出 → 下方 except 转 413。
            self._wrap_receive(request)

        try:
            return await call_next(request)
        except _BodyTooLarge as exc:
            return self._too_large(exc.received)

    def _wrap_receive(self, request: Request) -> None:
        original_receive = request.receive
        received = 0

        async def counting_receive():
            nonlocal received
            message = await original_receive()
            if message.get('type') == 'http.request':
                body = message.get('body') or b''
                received += len(body)
                if received > self._max_bytes:
                    raise _BodyTooLarge(received)
            return message

        request._receive = counting_receive  # type: ignore[attr-defined]

    def _too_large(self, received: int) -> Response:
        from fastapi.responses import JSONResponse

        return JSONResponse(
            status_code=413,
            content={
                'detail': (
                    f'请求体超过 {self._max_bytes} 字节上限'
                    f'（received ≈ {received}）——与 executor-node 的 2MB JSON '
                    'body 上限对齐'
                )
            },
        )
