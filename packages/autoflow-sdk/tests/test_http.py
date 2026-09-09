"""Tests for autoflow_sdk.http HttpClient and AsyncHttpClient."""
import pytest
import httpx
import respx
from autoflow_sdk.http import HttpClient, AsyncHttpClient, HttpClientError


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
