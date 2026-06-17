"""Tests for autoflow_sdk.http HttpClient and AsyncHttpClient."""
import pytest
import httpx
import respx
from autoflow_sdk.http import HttpClient, AsyncHttpClient


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
