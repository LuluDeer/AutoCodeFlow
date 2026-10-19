"""Thin httpx wrapper for task HTTP calls."""
from typing import Any, Dict, Optional
import httpx


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
    """

    def __init__(self, base_url: str = "", timeout: float = 30.0, headers: Optional[Dict[str, str]] = None):
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._headers = headers or {}

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
            resp = c.get(path, **kwargs)
            _raise(resp)
            return resp

    def post(self, path: str, json: Any = None, **kwargs) -> httpx.Response:
        with self._client() as c:
            resp = c.post(path, json=json, **kwargs)
            _raise(resp)
            return resp

    def put(self, path: str, json: Any = None, **kwargs) -> httpx.Response:
        with self._client() as c:
            resp = c.put(path, json=json, **kwargs)
            _raise(resp)
            return resp

    def delete(self, path: str, **kwargs) -> httpx.Response:
        with self._client() as c:
            resp = c.delete(path, **kwargs)
            _raise(resp)
            return resp


def _raise(resp: httpx.Response) -> None:
    """raise_for_status, but throwing our HttpClientError subclass.

    Kept behavior-compatible: same exception base, same message, same
    ``request``/``response`` attributes — just an SDK-identifiable type.
    """
    if resp.is_error:
        try:
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise HttpClientError(
                str(exc), request=exc.request, response=exc.response
            ) from exc
    resp.raise_for_status()


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

    def __init__(self, base_url: str = "", timeout: float = 30.0, headers: Optional[Dict[str, str]] = None):
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._headers = headers or {}
        self._client: Optional[httpx.AsyncClient] = None

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
        resp = await self._get_client().get(path, **kwargs)
        _raise(resp)
        return resp

    async def post(self, path: str, json: Any = None, **kwargs) -> httpx.Response:
        resp = await self._get_client().post(path, json=json, **kwargs)
        _raise(resp)
        return resp

    async def put(self, path: str, json: Any = None, **kwargs) -> httpx.Response:
        resp = await self._get_client().put(path, json=json, **kwargs)
        _raise(resp)
        return resp

    async def delete(self, path: str, **kwargs) -> httpx.Response:
        resp = await self._get_client().delete(path, **kwargs)
        _raise(resp)
        return resp
