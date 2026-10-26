"""Thin httpx wrapper for task HTTP calls."""
from typing import Any, Dict, Optional
import httpx

# P3-6: 响应体默认上限（字节），与 packages/autocodeflow-http 的
# DEFAULT_MAX_RESPONSE_BYTES 同值（量级参照 admin-api S3 日志存储的
# MAX_LOG_BYTES=100MB，任务内通用通道取更保守的 50MB）。任务代码可经
# HttpClient / AsyncHttpClient 的同名构造参数调整或传 None 关闭。
DEFAULT_MAX_RESPONSE_BYTES = 50 * 1024 * 1024


class ResponseTooLargeError(RuntimeError):
    """P3-6: 响应体超过 ``max_response_bytes`` 上限（rogue 对端防护）。

    流式读取在超限的当口**中止**（累计到帽即抛，连接随之关闭），不再把
    全量响应灌进任务进程内存。刻意**不**继承 httpx 异常族：这不是传输层
    故障——十有八九是对端就是要吐这么大，重试大概率同错；是否当作"故障"
    由任务代码裁定。与 packages/autocodeflow-http 的同名错误同构（两包无
    依赖关系，各自保留一份同语义实现，改动请成对修改——见
    _extract_error_body 的既有先例）。
    """


def _abort_on_declared_size(headers: httpx.Headers, cap: int) -> None:
    """P3-6: Content-Length 声明已超帽 → 一个字节都不读直接中止。

    声明可伪造也可缺失——不可信/缺失时回落到逐块累计检查（调用方）。
    """
    declared = headers.get("content-length")
    if declared is None:
        return
    try:
        declared_bytes = int(declared)
    except ValueError:
        return
    if declared_bytes > cap:
        raise ResponseTooLargeError(
            f"declared content-length {declared_bytes} exceeds "
            f"max_response_bytes={cap} - read aborted before body"
        )


def _capped_response(raw: httpx.Response, buf: bytearray) -> httpx.Response:
    """以既有非流式形态返回（status/headers/request/text/json 逐面可用）。"""
    return httpx.Response(
        raw.status_code, headers=raw.headers, content=bytes(buf), request=raw.request
    )


def _read_body_capped_sync(
    client: httpx.Client, method: str, url: str, cap: Optional[int], **kwargs: Any
) -> httpx.Response:
    """P3-6: 有帽 → 流式读取、超限中止；无帽（None）→ 旧全量形态。

    cap 按 ``iter_bytes`` 的**解码后**字节计（gzip 等传输编码已解），与任务
    进程内存实际占用对齐。
    """
    if cap is None:
        return client.request(method, url, **kwargs)
    with client.stream(method, url, **kwargs) as raw:
        _abort_on_declared_size(raw.headers, cap)
        buf = bytearray()
        for chunk in raw.iter_bytes():
            buf.extend(chunk)
            if len(buf) > cap:
                raise ResponseTooLargeError(
                    f"response body exceeded max_response_bytes={cap} - "
                    f"read aborted (rogue-peer protection)"
                )
        return _capped_response(raw, buf)


async def _read_body_capped_async(
    client: httpx.AsyncClient, method: str, url: str, cap: Optional[int], **kwargs: Any
) -> httpx.Response:
    """P3-6 异步版（aiter_bytes；其余同 :func:`_read_body_capped_sync`）。"""
    if cap is None:
        return await client.request(method, url, **kwargs)
    async with client.stream(method, url, **kwargs) as raw:
        _abort_on_declared_size(raw.headers, cap)
        buf = bytearray()
        async for chunk in raw.aiter_bytes():
            buf.extend(chunk)
            if len(buf) > cap:
                raise ResponseTooLargeError(
                    f"response body exceeded max_response_bytes={cap} - "
                    f"read aborted (rogue-peer protection)"
                )
        return _capped_response(raw, buf)


def _extract_error_body(response: Any) -> Optional[Dict[str, Any]]:
    """R31-E2: 取出 admin-api 错误体（{ code, message, errorCode, params }）。

    防御式解析：空体 / 非 JSON / 已流式消费（ResponseNotRead）一律返回 None。
    吞掉所有解析异常——透出错误码绝不能让「本来能抛出的 HTTP 错误」变成
    解析异常。与 packages/autocodeflow-http 的 _extract_error_body 同构
    （两包无依赖关系，故各自保留一份同语义实现，改动请成对修改）。
    """
    if response is None:
        return None
    try:
        body = response.json()
    except Exception:  # noqa: BLE001 - 非 JSON 体是常态，不是错误
        return None
    return body if isinstance(body, dict) else None


class HttpClientError(httpx.HTTPStatusError):
    """HTTPStatusError subclass raised by HttpClient / AsyncHttpClient.

    ECO-01 parity addition: the node SDK's axios errors carry the response
    object (``error.response.status``), which task code routinely reads for
    status branching. ``httpx.HTTPStatusError`` does the same — this subclass
    exists so callers can distinguish *SDK-managed* transport failures from
    ``raise_for_status()`` calls made elsewhere on raw responses, without any
    behavioral divergence: catching ``httpx.HTTPStatusError`` still works
    unchanged (subclass), so existing task code is unaffected.

    R31-E2 error-code surface (与 packages/autocodeflow-http 的
    ApiHttpStatusError 对齐): 由 _raise 保留的同一个 response 对象惰性解析
    admin-api 错误体，额外提供 error_code / params。message / request /
    response 三个既有面逐字节/逐引用不变，链路无断点。
    """

    @property
    def error_body(self) -> Optional[Dict[str, Any]]:
        """解析出的错误体（无则 None）；每次访问重新解析。"""
        return _extract_error_body(getattr(self, "response", None))

    @property
    def error_code(self) -> Optional[str]:
        """admin-api 稳定码（如 TASK_NOT_FOUND）；无码/非字符串/空串 → None。"""
        body = self.error_body
        if not body:
            return None
        code = body.get("errorCode")
        return code if isinstance(code, str) and code else None

    @property
    def params(self) -> Dict[str, Any]:
        """同一错误体的插值参数；缺失或非对象 → {}（恒为 dict）。"""
        body = self.error_body
        if not body:
            return {}
        params = body.get("params")
        return params if isinstance(params, dict) else {}


class HttpClient:
    """
    Thin httpx wrapper for task HTTP calls.

    No automatic retry (BUG-15 复审: 原文档串声称 "basic retry logic" 但实现
    从未有过——照写即错)。非幂等方法（post/put/delete）永不被隐式重试；
    幂等重试由任务代码自行决定（raise_for_status 直抛 HttpClientError，
    是 httpx.HTTPStatusError 的子类）。

    P2-3 端间 parity 互指（2026-10-26 如实修订）：带重试+熔断契约的是**管理面**
    客户端 packages/autocodeflow-http（与 node-sdk 两端对齐）；本类是任务内
    通用通道，刻意薄——无重试无熔断（理由如上）。acf-cli / mcp-server 同样
    无（见各自 client 注释）。

    P3-6 响应体上限：``max_response_bytes``（默认 50MB）按**解码后**字节流式
    封顶，超限中止读取并抛 ``ResponseTooLargeError``（rogue 对端防护）。
    这是给任务代码的配置出口——传 None 关闭，或传更大值放开（例如已知要拉
    大文件的通道）。
    """

    def __init__(
        self,
        base_url: str = "",
        timeout: float = 30.0,
        headers: Optional[Dict[str, str]] = None,
        max_response_bytes: Optional[int] = DEFAULT_MAX_RESPONSE_BYTES,
    ):
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._headers = headers or {}
        self._max_response_bytes = max_response_bytes

    def _client(self) -> httpx.Client:
        # NETOPT-E P3-4（trust_env 三分法，反向交叉引用）: 本包是任务内
        # admin-api 回调/通用 HTTP 通道（内部通道）——trust_env=False 禁代理
        # 直连内网。AI 外发（autocodeflow-ai analyzer）**刻意保留**代理+CA
        # （True）；凭据 URL 包下载（executor-python execute.py）False 防凭据
        # 泄漏进代理。改任何一端的取值前先读 analyzer.py 的定调注释。
        return httpx.Client(
            base_url=self.base_url,
            timeout=self._timeout,
            headers=self._headers,
            trust_env=False,
        )

    def get(self, path: str, **kwargs) -> httpx.Response:
        with self._client() as c:
            # P3-6: 响应体封顶走统一的 capped 读取（None = 旧行为）。
            resp = _read_body_capped_sync(c, "GET", path, self._max_response_bytes, **kwargs)
            _raise(resp)
            return resp

    def post(self, path: str, json: Any = None, **kwargs) -> httpx.Response:
        with self._client() as c:
            resp = _read_body_capped_sync(
                c, "POST", path, self._max_response_bytes, json=json, **kwargs
            )
            _raise(resp)
            return resp

    def put(self, path: str, json: Any = None, **kwargs) -> httpx.Response:
        with self._client() as c:
            resp = _read_body_capped_sync(
                c, "PUT", path, self._max_response_bytes, json=json, **kwargs
            )
            _raise(resp)
            return resp

    def delete(self, path: str, **kwargs) -> httpx.Response:
        with self._client() as c:
            resp = _read_body_capped_sync(
                c, "DELETE", path, self._max_response_bytes, **kwargs
            )
            _raise(resp)
            return resp


def _raise(resp: httpx.Response) -> None:
    """raise_for_status, but throwing our HttpClientError subclass.

    Kept behavior-compatible: same exception base, same message, same
    ``request``/``response`` attributes — just an SDK-identifiable type.

    R177-A1（轴 1 错误面）：单一路径。此前实现先 `if resp.is_error` 包 4xx/5xx，
    再在函数末尾无条件 `resp.raise_for_status()`——而 httpx 的 `is_error` 只覆盖
    4xx/5xx，`raise_for_status()` 对 3xx 同样抛。于是 3xx 从末尾那条**裸路径**
    逃出 SDK 类型：前面挂一层做 302（登录跳转 / 网关）的反代时，任务代码
    `except HttpClientError` 会漏接，也拿不到 error_code。现在只留一条路径：
    任何非 2xx 都被包成 HttpClientError（str(exc) 逐字节保留 httpx 的原始消息，
    含 3xx 的 Redirect location 提示）。2xx 时 raise_for_status() 直接返回。
    """
    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HttpClientError(
            str(exc), request=exc.request, response=exc.response
        ) from exc


class AsyncHttpClient:
    """Async HTTP client backed by httpx.AsyncClient.

    **POOL-01（审计 P2，2026-10-17）**：底层 ``AsyncClient`` 此前在
    ``__init__`` 里就创建，而只有 ``__aexit__`` 会关闭它。任务代码最常见的
    形式 ``client = AsyncHttpClient(); await client.get(...)``（不写
    ``async with``）因此**从不关闭连接池**——httpx 的 AsyncClient 持有
    keep-alive 连接池，长跑任务在循环里反复构造就在进程里累积 CLOSE_WAIT
    socket（审计实测数十个）。

    现与 ``autocodeflow-http`` / ``autocodeflow-notify`` 对齐为**懒初始化
    实例级单例**：首次请求才建，``aclose()`` / ``__aexit__`` 关闭后置空，
    再次请求自动重建（关闭后仍可用，比「关闭即报废」宽容，且与既有
    ``async with`` 用法逐字节兼容）。``close`` 是 ``aclose`` 的同义方法
    （同步 SDK 侧叫 close，任务作者容易照写）。

    未显式关闭的实例由 ``__del__`` 尽力兜底释放——但长跑任务仍应显式
    关闭：析构时机由 GC 决定，且循环引用下可能迟迟不触发。
    """

    def __init__(
        self,
        base_url: str = "",
        timeout: float = 30.0,
        headers: Optional[Dict[str, str]] = None,
        max_response_bytes: Optional[int] = DEFAULT_MAX_RESPONSE_BYTES,
    ):
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._headers = headers or {}
        self._client: Optional[httpx.AsyncClient] = None
        # P3-6: 响应体上限（同 HttpClient——配置出口见该类 docstring）。
        self._max_response_bytes = max_response_bytes

    def _get_client(self) -> httpx.AsyncClient:
        """懒初始化实例级 AsyncClient（复用连接池）。

        asyncio 单线程事件循环内 check-then-set 原子，无需锁——与
        autocodeflow-http 的 ``_get_client`` 同款依据。
        """
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self._timeout,
                headers=self._headers,
                # NETOPT-E P3-4: 同 _client()——内部通道禁代理直连内网
                # （AI 外发例外见 analyzer.py 三分法定调注释）。
                trust_env=False,
            )
        return self._client

    async def aclose(self) -> None:
        """显式关闭底层 AsyncClient（连接池释放；幂等）。"""
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    async def close(self) -> None:
        """``aclose`` 的同义方法（同步 SDK 侧叫 close，作者容易照写）。"""
        await self.aclose()

    async def __aenter__(self) -> "AsyncHttpClient":
        self._get_client()
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        await self.aclose()

    def __del__(self) -> None:  # pragma: no cover - 析构兜底，无法确定性测试
        """析构兜底：尽力而为地释放连接池，**绝不**抛异常。"""
        client = getattr(self, "_client", None)
        if client is None or client.is_closed:
            return
        try:
            import asyncio

            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            if loop is not None and loop.is_running():
                # 事件循环仍在跑：排后台任务关闭（不阻塞析构）。
                loop.create_task(client.aclose())
            else:
                asyncio.run(client.aclose())
        except Exception:  # noqa: BLE001 - 析构路径禁止抛异常
            pass

    async def get(self, path: str, **kwargs) -> httpx.Response:
        resp = await _read_body_capped_async(
            self._get_client(), "GET", path, self._max_response_bytes, **kwargs
        )
        _raise(resp)
        return resp

    async def post(self, path: str, json: Any = None, **kwargs) -> httpx.Response:
        resp = await _read_body_capped_async(
            self._get_client(), "POST", path, self._max_response_bytes, json=json, **kwargs
        )
        _raise(resp)
        return resp

    async def put(self, path: str, json: Any = None, **kwargs) -> httpx.Response:
        resp = await _read_body_capped_async(
            self._get_client(), "PUT", path, self._max_response_bytes, json=json, **kwargs
        )
        _raise(resp)
        return resp

    async def delete(self, path: str, **kwargs) -> httpx.Response:
        resp = await _read_body_capped_async(
            self._get_client(), "DELETE", path, self._max_response_bytes, **kwargs
        )
        _raise(resp)
        return resp
