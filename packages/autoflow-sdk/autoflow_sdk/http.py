"""Thin httpx wrapper for task HTTP calls."""
from typing import Any, Dict, Optional
import httpx


class HttpClientError(httpx.HTTPStatusError):
    """HTTPStatusError subclass raised by HttpClient / AsyncHttpClient.

    ECO-01 parity addition: the node SDK's axios errors carry the response
    object (``error.response.status``), which task code routinely reads for
    status branching. ``httpx.HTTPStatusError`` does the same — this subclass
    exists so callers can distinguish *SDK-managed* transport failures from
    ``raise_for_status()`` calls made elsewhere on raw responses, without any
    behavioral divergence: catching ``httpx.HTTPStatusError`` still works
    unchanged (subclass), so existing task code is unaffected.
    """


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
    """Async HTTP client backed by httpx.AsyncClient."""

    def __init__(self, base_url: str = "", timeout: float = 30.0, headers: Optional[Dict[str, str]] = None):
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._headers = headers or {}
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=self._timeout,
            headers=self._headers,
            trust_env=False,
        )

    async def __aenter__(self) -> "AsyncHttpClient":
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        await self._client.aclose()

    async def get(self, path: str, **kwargs) -> httpx.Response:
        resp = await self._client.get(path, **kwargs)
        _raise(resp)
        return resp

    async def post(self, path: str, json: Any = None, **kwargs) -> httpx.Response:
        resp = await self._client.post(path, json=json, **kwargs)
        _raise(resp)
        return resp

    async def put(self, path: str, json: Any = None, **kwargs) -> httpx.Response:
        resp = await self._client.put(path, json=json, **kwargs)
        _raise(resp)
        return resp

    async def delete(self, path: str, **kwargs) -> httpx.Response:
        resp = await self._client.delete(path, **kwargs)
        _raise(resp)
        return resp
