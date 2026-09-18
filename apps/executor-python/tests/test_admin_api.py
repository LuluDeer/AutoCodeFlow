import pytest

from admin_api import build_admin_api_url, check_admin_api_connectivity, get_admin_api_base_url
from config import settings


def test_build_admin_api_url_adds_api_prefix_for_service_root(monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(settings, 'admin_api_url_external', '')

    assert build_admin_api_url('/executions/callback') == 'http://admin.local/api/executions/callback'


def test_build_admin_api_url_keeps_existing_api_prefix(monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local/api')
    monkeypatch.setattr(settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(settings, 'admin_api_url_external', '')

    assert build_admin_api_url('/executors/heartbeat') == 'http://admin.local/api/executors/heartbeat'


def test_build_admin_api_url_accepts_api_prefixed_path(monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local/api/')
    monkeypatch.setattr(settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(settings, 'admin_api_url_external', '')

    assert build_admin_api_url('/api/health') == 'http://admin.local/api/health'


def test_build_admin_api_url_normalizes_trailing_and_leading_slashes(monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local/')
    monkeypatch.setattr(settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(settings, 'admin_api_url_external', '')

    assert build_admin_api_url('executors/register') == 'http://admin.local/api/executors/register'


def test_admin_api_base_url_priority(monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(settings, 'admin_api_url_internal', 'http://admin.internal/api/')
    monkeypatch.setattr(settings, 'admin_api_url_external', 'http://admin.external/api/')

    assert get_admin_api_base_url() == 'http://admin.external/api'

    monkeypatch.setattr(settings, 'admin_api_url_external', '')
    assert get_admin_api_base_url() == 'http://admin.internal/api'

    monkeypatch.setattr(settings, 'admin_api_url_internal', None)
    assert get_admin_api_base_url() == 'http://admin.local'


def test_admin_api_base_url_ignores_blank_priority_values(monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', ' http://admin.local/ ')
    monkeypatch.setattr(settings, 'admin_api_url_internal', '   ')
    monkeypatch.setattr(settings, 'admin_api_url_external', None)

    assert get_admin_api_base_url() == 'http://admin.local'


@pytest.mark.asyncio
async def test_check_admin_api_connectivity_returns_true_on_success(monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(settings, 'admin_api_url_external', '')

    calls = []

    class FakeResponse:
        def raise_for_status(self):
            return None

    class FakeClient:
        async def get(self, url, timeout):
            calls.append((url, timeout))
            return FakeResponse()

    # 网络性能审计（2026-09-18）：check_admin_api_connectivity 改用 O-24 共享
    # 连接池（scheduler.get_http_client），测试桩随之改为桩住该入口。
    monkeypatch.setattr('scheduler.get_http_client', lambda: FakeClient())

    ok = await check_admin_api_connectivity(attempts=1, timeout_seconds=3.0)

    assert ok is True
    assert calls == [('http://admin.local/api/health', 3.0)]


@pytest.mark.asyncio
async def test_check_admin_api_connectivity_returns_false_after_retries(monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(settings, 'admin_api_url_external', '')

    calls = []
    sleeps = []

    class FakeClient:
        async def get(self, url, timeout):
            calls.append((url, timeout))
            raise RuntimeError('down')

    async def fake_sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr('scheduler.get_http_client', lambda: FakeClient())
    monkeypatch.setattr('admin_api.asyncio.sleep', fake_sleep)

    ok = await check_admin_api_connectivity(
        attempts=2,
        initial_delay_seconds=0.5,
        timeout_seconds=3.0,
    )

    assert ok is False
    assert calls == [
        ('http://admin.local/api/health', 3.0),
        ('http://admin.local/api/health', 3.0),
    ]
    assert sleeps == [0.5]
