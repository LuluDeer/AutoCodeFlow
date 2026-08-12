from unittest.mock import AsyncMock

import pytest

from config import settings
from routers import health as health_module


def test_health_returns_200(client):
    response = client.get('/health')
    assert response.status_code == 200


def test_health_contains_status_field(client):
    response = client.get('/health')
    body = response.json()
    assert 'status' in body


def test_health_token_uses_shared_token_before_legacy_secret(monkeypatch):
    monkeypatch.setenv('EXECUTOR_SHARED_TOKEN', 'shared-token')
    monkeypatch.setenv('EXECUTOR_SECRET', 'legacy-secret')

    assert health_module._get_health_token() == 'shared-token'


@pytest.mark.asyncio
async def test_check_admin_api_uses_public_health_endpoint(monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(settings, 'admin_api_url_external', '')

    calls = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            self.timeout = kwargs.get('timeout')

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, url, **kwargs):
            calls.append((url, kwargs))
            class Response:
                status_code = 200
            return Response()

    monkeypatch.setattr(health_module.httpx, 'AsyncClient', FakeClient)

    assert await health_module._check_admin_api() is True
    assert calls == [('http://admin.local/api/health', {})]


def test_readiness_failure_reports_normalized_admin_url(client, monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local/api/')
    monkeypatch.setattr(settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(settings, 'admin_api_url_external', '')
    monkeypatch.setattr(health_module, '_check_admin_api', AsyncMock(return_value=False))

    response = client.get('/health/readiness')

    assert response.status_code == 503
    assert response.json()['detail'] == {
        'status': 'unready',
        'reason': 'admin-api unreachable',
        'adminApiUrl': 'http://admin.local/api',
    }
