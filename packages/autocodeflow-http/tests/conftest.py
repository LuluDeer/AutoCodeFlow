"""Pytest fixtures for autocodeflow-http tests."""
import os
import pytest
import respx


@pytest.fixture(autouse=True)
def clear_proxy_env(monkeypatch):
    """Remove proxy env vars so httpx doesn't try to use a system SOCKS proxy."""
    for var in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
                "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"):
        monkeypatch.delenv(var, raising=False)


@pytest.fixture
def respx_mock():
    """Provide a respx mock context for HTTP tests."""
    with respx.mock(assert_all_called=False) as mock:
        yield mock
