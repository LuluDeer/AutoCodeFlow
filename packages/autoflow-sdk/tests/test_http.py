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

# ---------------------------------------------------------------------------
# R31-E2: 稳定错误码透出（与 autocodeflow-http 的 ApiHttpStatusError 对等）
# ---------------------------------------------------------------------------
class TestR31E2ErrorCodePassthrough:
    """SDK 抛出的 HttpClientError 必须带 error_code / params，且三个既有面不变。

    反证：删掉 HttpClientError 的 error_code / params 两个 property（或让
    _raise 丢掉 response）后，本类全部用例转红。
    """

    BODY = {
        "code": 404,
        "message": "任务不存在",
        "errorCode": "TASK_NOT_FOUND",
        "params": {"taskId": "t-1"},
    }

    @respx.mock
    def test_sync_error_exposes_code_and_params(self):
        respx.get("http://api.test/tasks/t-1").mock(
            return_value=httpx.Response(404, json=self.BODY)
        )
        c = HttpClient(base_url="http://api.test")
        with pytest.raises(HttpClientError) as excinfo:
            c.get("/tasks/t-1")
        err = excinfo.value
        assert err.error_code == "TASK_NOT_FOUND"
        assert err.params == {"taskId": "t-1"}
        # 既有面不变：仍是 HTTPStatusError、仍有 request/response、message 不变
        assert isinstance(err, httpx.HTTPStatusError)
        assert err.response.status_code == 404
        assert err.request is not None
        assert str(err).startswith("Client error '404 Not Found'")

    @pytest.mark.asyncio
    @respx.mock
    async def test_async_error_exposes_code_and_params(self):
        respx.post("http://async.test/tasks").mock(
            return_value=httpx.Response(409, json={
                "code": 409,
                "message": "任务名已存在",
                "errorCode": "TASK_NAME_CONFLICT",
                "params": {"name": "nightly"},
            })
        )
        async with AsyncHttpClient(base_url="http://async.test") as c:
            with pytest.raises(HttpClientError) as excinfo:
                await c.post("/tasks", json={"name": "nightly"})
        err = excinfo.value
        assert err.error_code == "TASK_NAME_CONFLICT"
        assert err.params == {"name": "nightly"}

    @respx.mock
    def test_response_body_still_readable_after_code_access(self):
        """透出是只读附加面：读 error_code 不得消费掉 response 的 body。"""
        respx.get("http://api.test/x").mock(
            return_value=httpx.Response(500, json=self.BODY)
        )
        c = HttpClient(base_url="http://api.test")
        with pytest.raises(HttpClientError) as excinfo:
            c.get("/x")
        err = excinfo.value
        message_before = str(err)
        assert err.error_code == "TASK_NOT_FOUND"
        assert err.params == {"taskId": "t-1"}
        # body 仍可读，message 逐字节未变
        assert err.response.json()["errorCode"] == "TASK_NOT_FOUND"
        assert str(err) == message_before

    @respx.mock
    def test_missing_code_and_params_degrade_quietly(self):
        respx.get("http://api.test/x").mock(
            return_value=httpx.Response(500, json={"code": 500, "message": "内部错误"})
        )
        c = HttpClient(base_url="http://api.test")
        with pytest.raises(HttpClientError) as excinfo:
            c.get("/x")
        assert excinfo.value.error_code is None
        assert excinfo.value.params == {}

    @respx.mock
    def test_non_json_error_body_does_not_mask_the_http_error(self):
        respx.get("http://api.test/x").mock(
            return_value=httpx.Response(
                502, content=b"<html>bad gateway</html>", headers={"content-type": "text/html"}
            )
        )
        c = HttpClient(base_url="http://api.test")
        with pytest.raises(HttpClientError) as excinfo:
            c.get("/x")
        assert excinfo.value.error_code is None
        assert excinfo.value.params == {}
        assert excinfo.value.response.status_code == 502

# ---------------------------------------------------------------------------
# R177-A1（对外 SDK 健壮性审计）——轴 1：3xx 也必须落在 SDK 类型里
# ---------------------------------------------------------------------------


class TestRedirectStatusIsSdkError:
    """缺陷现场（R177-A1 反证）：``_raise`` 先用 ``if resp.is_error`` 判 4xx/5xx，
    再在函数末尾无条件 ``resp.raise_for_status()``——httpx 的 ``is_error`` 只覆盖
    4xx/5xx，而 ``raise_for_status()`` 对 3xx 也抛。于是 3xx 从**末尾那条路径**
    裸抛 ``httpx.HTTPStatusError``，绕过 ``HttpClientError``：环境前面挂一层反代
    做 302（登录页 / 网关跳转）时，任务代码 ``except HttpClientError`` 会漏接，
    也拿不到 error_code。两端口径必须一致：SDK 抛出的状态错误只有一种类型。
    """

    @respx.mock
    def test_sync_3xx_raises_http_client_error(self):
        respx.get("http://api.test/moved").mock(return_value=httpx.Response(
            302, headers={"Location": "http://api.test/elsewhere"},
        ))
        c = HttpClient(base_url="http://api.test")
        with pytest.raises(HttpClientError) as excinfo:
            c.get("/moved")
        # 既有面不变：仍是 HTTPStatusError 子类，仍带 request/response
        assert isinstance(excinfo.value, httpx.HTTPStatusError)
        assert excinfo.value.response.status_code == 302
        assert excinfo.value.request is not None

    @pytest.mark.asyncio
    @respx.mock
    async def test_async_3xx_raises_http_client_error(self):
        respx.get("http://async.test/moved").mock(return_value=httpx.Response(
            301, headers={"Location": "http://async.test/elsewhere"},
        ))
        async with AsyncHttpClient(base_url="http://async.test") as c:
            with pytest.raises(HttpClientError):
                await c.get("/moved")

    @respx.mock
    def test_3xx_error_code_degrades_quietly(self):
        respx.get("http://api.test/moved").mock(return_value=httpx.Response(
            307, headers={"Location": "http://api.test/elsewhere"},
        ))
        c = HttpClient(base_url="http://api.test")
        with pytest.raises(HttpClientError) as excinfo:
            c.get("/moved")
        assert excinfo.value.error_code is None
        assert excinfo.value.params == {}

