"""Thin httpx wrapper for task HTTP calls."""
from typing import Any, Dict, Optional
import httpx


class HttpClient:
    """Async-friendly HTTP client with basic retry logic."""

    def __init__(self, base_url: str = "", timeout: float = 30.0, headers: Optional[Dict[str, str]] = None):
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._headers = headers or {}

    def _client(self) -> httpx.Client:
        return httpx.Client(base_url=self.base_url, timeout=self._timeout, headers=self._headers)

    def get(self, path: str, **kwargs) -> httpx.Response:
        with self._client() as c:
            resp = c.get(path, **kwargs)
            resp.raise_for_status()
            return resp

    def post(self, path: str, json: Any = None, **kwargs) -> httpx.Response:
        with self._client() as c:
            resp = c.post(path, json=json, **kwargs)
            resp.raise_for_status()
            return resp

    def put(self, path: str, json: Any = None, **kwargs) -> httpx.Response:
        with self._client() as c:
            resp = c.put(path, json=json, **kwargs)
            resp.raise_for_status()
            return resp

    def delete(self, path: str, **kwargs) -> httpx.Response:
        with self._client() as c:
            resp = c.delete(path, **kwargs)
            resp.raise_for_status()
            return resp
