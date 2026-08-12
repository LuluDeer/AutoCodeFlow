from admin_api import build_admin_api_url, get_admin_api_base_url
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
