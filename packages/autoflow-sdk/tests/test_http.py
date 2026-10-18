"""Tests for autoflow_sdk.http HttpClient and AsyncHttpClient."""
import pytest
import httpx
import respx
from autoflow_sdk.http import HttpClient, AsyncHttpClient, HttpClientError


class TestTrustEnvPinned:
    """NETOPT-D P3-2: http.py 两端 trust_env=False 无属性断言测试——
    SDK 任务 HTTP 走 admin-api/内部通道，禁代理 env（与 callback/notify
    http.py 对齐）。钉死构造 kwargs，防未来被机械改成默认 True 让任务
    回调经代理 env 泄漏。"""

    def test_sync_client_pins_trust_env_false(self, monkeypatch):
        captured: dict = {}
        orig = httpx.Client.__init__

        def spy(self, *a, **kw):
            captured.update(kw)
            return orig(self, *a, **kw)

        monkeypatch.setattr(httpx.Client, "__init__", spy)
        c = HttpClient(base_url="http://api.test")
        c._client()
        assert captured.get("trust_env") is False

    def test_async_client_pins_trust_env_false(self, monkeypatch):
        captured: dict = {}
        orig = httpx.AsyncClient.__init__

        def spy(self, *a, **kw):
            captured.update(kw)
            return orig(self, *a, **kw)

        monkeypatch.setattr(httpx.AsyncClient, "__init__", spy)
        c = AsyncHttpClient(base_url="http://api.test")
        # POOL-01（审计 P2）：底层 client 改为懒初始化（此前在 __init__ 里
        # 就建，导致不写 `async with` 的任务代码从不关闭连接池 → CLOSE_WAIT
        # 累积）。信任策略的断言点因此跟着移到「真正建连接池的那一刻」。
        assert captured == {}, "POOL-01: AsyncHttpClient 不应在构造期建连接池"
        c._get_client()
        assert captured.get("trust_env") is False

    def test_async_client_pool_is_lazy_and_reused(self):
        """POOL-01：懒初始化 + 实例级复用（同一实例多次请求共享一个池）。"""
        c = AsyncHttpClient(base_url="http://api.test")
        assert c._client is None, "构造期不得建池"
        first = c._get_client()
        assert c._get_client() is first, "多次请求必须复用同一连接池"

    @pytest.mark.asyncio
    async def test_async_client_aclose_resets_pool_and_rebuilds(self):
        """POOL-01：aclose 释放池；关闭后再用自动重建（语义不降级）。"""
        c = AsyncHttpClient(base_url="http://api.test")
        first = c._get_client()
        await c.aclose()
        assert c._client is None
        assert first.is_closed
        # 关闭后仍可用：重建新池（而非 AttributeError / 已关闭连接）
        second = c._get_client()
        assert second is not first
        assert not second.is_closed
        await c.aclose()

    @pytest.mark.asyncio
    async def test_async_client_close_is_alias_of_aclose(self):
        """POOL-01：close() 与 aclose() 等价（同步 SDK 习惯写法）。"""
        c = AsyncHttpClient(base_url="http://api.test")
        c._get_client()
        await c.close()
        assert c._client is None

    @pytest.mark.asyncio
    async def test_async_client_context_manager_closes_pool(self):
        """POOL-01：`async with` 退出时释放池（既有用法零变化）。"""
        async with AsyncHttpClient(base_url="http://api.test") as c:
            pool = c._get_client()
            assert not pool.is_closed
        assert pool.is_closed
        assert c._client is None


class TestHttpClientInit:
    def test_base_url_strips_trailing_slash(self):
        c = HttpClient(base_url="http://example.com/")
        assert c.base_url == "http://example.com"

    def test_default_timeout(self):
        c = HttpClient()
        assert c._timeout == 30.0

    def test_custom_headers(self):
        c = HttpClient(headers={"X-Token": "abc"})
        assert c._headers["X-Token"] == "abc"

    def test_default_headers_empty(self):
        c = HttpClient()
        assert c._headers == {}


class TestHttpClientRequests:
    @respx.mock
    def test_get_returns_response(self):
        respx.get("http://api.test/items").mock(return_value=httpx.Response(200, json={"items": []}))
        c = HttpClient(base_url="http://api.test")
        resp = c.get("/items")
        assert resp.status_code == 200
        assert resp.json() == {"items": []}

    @respx.mock
    def test_post_sends_json(self):
        respx.post("http://api.test/create").mock(return_value=httpx.Response(201, json={"id": "1"}))
        c = HttpClient(base_url="http://api.test")
        resp = c.post("/create", json={"name": "test"})
        assert resp.status_code == 201

    @respx.mock
    def test_get_raises_on_4xx(self):
        respx.get("http://api.test/missing").mock(return_value=httpx.Response(404))
        c = HttpClient(base_url="http://api.test")
        with pytest.raises(httpx.HTTPStatusError):
            c.get("/missing")

    @respx.mock
    def test_delete_raises_on_error(self):
        respx.delete("http://api.test/item/1").mock(return_value=httpx.Response(500))
        c = HttpClient(base_url="http://api.test")
        with pytest.raises(httpx.HTTPStatusError):
            c.delete("/item/1")


class TestAsyncHttpClientInit:
    def test_base_url_strips_slash(self):
        c = AsyncHttpClient(base_url="http://async.test/")
        assert c.base_url == "http://async.test"

    def test_timeout(self):
        c = AsyncHttpClient(timeout=10.0)
        assert c._timeout == 10.0


class TestAsyncHttpClientRequests:
    @pytest.mark.asyncio
    @respx.mock
    async def test_async_get(self):
        respx.get("http://async.test/data").mock(return_value=httpx.Response(200, json={"ok": True}))
        async with AsyncHttpClient(base_url="http://async.test") as c:
            resp = await c.get("/data")
            assert resp.status_code == 200
            assert resp.json()["ok"] is True

    @pytest.mark.asyncio
    @respx.mock
    async def test_async_post(self):
        respx.post("http://async.test/submit").mock(return_value=httpx.Response(200, json={"done": True}))
        async with AsyncHttpClient(base_url="http://async.test") as c:
            resp = await c.post("/submit", json={"x": 1})
            assert resp.json()["done"] is True

    @pytest.mark.asyncio
    @respx.mock
    async def test_async_get_raises_on_error(self):
        respx.get("http://async.test/err").mock(return_value=httpx.Response(403))
        async with AsyncHttpClient(base_url="http://async.test") as c:
            with pytest.raises(httpx.HTTPStatusError):
                await c.get("/err")


class TestHttpClientErrorSubclass:
    """ECO-01 parity: SDK-managed transport failures raise the HttpClientError
    subclass (node-style identifiable type) while remaining catchable as
    httpx.HTTPStatusError — zero behavior change for existing task code."""

    @respx.mock
    def test_sync_error_is_http_client_error(self):
        respx.get("http://api.test/missing").mock(return_value=httpx.Response(404))
        c = HttpClient(base_url="http://api.test")
        with pytest.raises(HttpClientError) as excinfo:
            c.get("/missing")
        # subclass relationship: existing except-clauses keep working
        assert isinstance(excinfo.value, httpx.HTTPStatusError)
        assert excinfo.value.response.status_code == 404
        assert excinfo.value.request is not None

    @respx.mock
    def test_sync_error_on_5xx(self):
        respx.post("http://api.test/boom").mock(return_value=httpx.Response(502))
        c = HttpClient(base_url="http://api.test")
        with pytest.raises(HttpClientError):
            c.post("/boom", json={})

    @pytest.mark.asyncio
    @respx.mock
    async def test_async_error_is_http_client_error(self):
        respx.get("http://async.test/err").mock(return_value=httpx.Response(403))
        async with AsyncHttpClient(base_url="http://async.test") as c:
            with pytest.raises(HttpClientError) as excinfo:
                await c.get("/err")
            assert isinstance(excinfo.value, httpx.HTTPStatusError)

    @respx.mock
    def test_success_path_raises_nothing(self):
        # 2xx must never raise even with the new _raise helper
        respx.get("http://api.test/ok").mock(return_value=httpx.Response(200, json={"ok": True}))
        c = HttpClient(base_url="http://api.test")
        assert c.get("/ok").status_code == 200
        assert c.get("/ok").json()["ok"] is True

    def test_exported_from_package_root(self):
        import autoflow_sdk

        assert autoflow_sdk.HttpClientError is HttpClientError
