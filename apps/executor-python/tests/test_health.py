import json
import pathlib
from unittest.mock import AsyncMock

import pytest

from config import settings
from routers import health as health_module


def test_health_returns_200(client, monkeypatch):
    monkeypatch.setattr(health_module, '_check_admin_api', AsyncMock(return_value=True))

    response = client.get('/health')
    assert response.status_code == 200


def test_health_contains_status_field(client, monkeypatch):
    monkeypatch.setattr(health_module, '_check_admin_api', AsyncMock(return_value=True))

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

        async def get(self, url, **kwargs):
            calls.append((url, kwargs))

            class Response:
                status_code = 200

            return Response()

    # 网络性能审计（2026-09-18）：_check_admin_api 改用 scheduler 共享连接池
    # （O-24），不再直接用 httpx.AsyncClient——mock 目标同步迁移。
    import scheduler

    monkeypatch.setattr(scheduler, 'get_http_client', lambda: FakeClient())

    assert await health_module._check_admin_api() is True
    assert calls == [('http://admin.local/api/health', {'timeout': 5})]


@pytest.mark.asyncio
async def test_readiness_failure_reports_normalized_admin_url(monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local/api/')
    monkeypatch.setattr(settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(settings, 'admin_api_url_external', '')
    monkeypatch.setattr(health_module, '_check_admin_api', AsyncMock(return_value=False))

    # A3: 不再抛 HTTPException——它会把载荷包进 {"detail": {...}}，与 executor-node
    # 的扁平载荷、以及契约「payload 外不得再包一层自定义键」冲突。改为直接返回
    # JSONResponse，状态码与形状三端一致。
    resp = await health_module.readiness()

    assert resp.status_code == 503
    assert json.loads(resp.body) == {
        'status': 'not_ready',
        'reason': 'admin-api unreachable',
        'adminApiUrl': 'http://admin.local/api',
    }


# ---------------------------------------------------------------------------
# E-20（DEEP_REVIEW 0ef3bbe）：就绪探针规范路径 /health/ready——与 admin-api
# /api/health/ready、executor-node /health/ready 全链路对齐；python 旧路径
# /health/readiness 保留为 deprecated alias。
# ---------------------------------------------------------------------------


def test_readiness_canonical_path_ready(client, monkeypatch):
    monkeypatch.setattr(health_module, '_check_admin_api', AsyncMock(return_value=True))
    # 资源维度与宿主负载解耦（高负载 CI 机上 psutil 可能 ≥90% 造成假 503）；
    # 资源判定本身的契约由下方 A3-C schema 用例独立覆盖。
    monkeypatch.setattr(health_module, '_resources_ok', lambda: (True, None))

    resp = client.get('/health/ready')

    assert resp.status_code == 200
    body = resp.json()
    assert body['status'] == 'ready'
    assert body['adminApiReachable'] is True


def test_readiness_canonical_path_not_ready_when_admin_unreachable(client, monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(settings, 'admin_api_url_external', '')
    monkeypatch.setattr(health_module, '_check_admin_api', AsyncMock(return_value=False))

    resp = client.get('/health/ready')

    # A3: 载荷扁平（不再包在 'detail' 里），status 值域统一为 not_ready。
    assert resp.status_code == 503
    body = resp.json()
    assert body['status'] == 'not_ready'
    assert body['reason'] == 'admin-api unreachable'


# ---------------------------------------------------------------------------
# A3（executor-protocol）：三方共享契约的 python 侧断言在
# tests/test_executor_protocol_contract.py——三端加载同一份 protocol.json。
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('path', ['/health/ready', '/health/readiness'])
def test_readiness_alias_paths_agree(client, monkeypatch, path):
    """两个路径必须给出同一结论（alias 只是兼容入口，语义不得漂移）。"""
    monkeypatch.setattr(health_module, '_check_admin_api', AsyncMock(return_value=True))
    # 资源维度与宿主负载解耦（高负载 CI 机假 503），资源契约见 A3-C schema 用例。
    monkeypatch.setattr(health_module, '_resources_ok', lambda: (True, None))

    resp = client.get(path)

    assert resp.status_code == 200
    assert resp.json()['status'] == 'ready'


def test_readiness_alias_still_404_free(client, monkeypatch):
    """存量运维探针打 /health/readiness 时不得 404（一个版本内兼容）。"""
    monkeypatch.setattr(health_module, '_check_admin_api', AsyncMock(return_value=True))
    # 资源维度与宿主负载解耦（高负载 CI 机假 503），资源契约见 A3-C schema 用例。
    monkeypatch.setattr(health_module, '_resources_ok', lambda: (True, None))

    assert client.get('/health/readiness').status_code == 200


# ---------------------------------------------------------------------------
# E-42（DEEP_REVIEW 0ef3bbe）③：/health 的 token 口径——静态 bootstrap token
# 与动态（/token 下发）token 必须分别可见，否则动态链路坏掉时探针仍报
# tokenValid=true，运维无从发现 token 轮换/自愈故障。
# ---------------------------------------------------------------------------


def test_health_exposes_static_and_dynamic_token_state(client, monkeypatch):
    import auth as auth_module

    monkeypatch.setenv('EXECUTOR_SHARED_TOKEN', 'static-secret')
    monkeypatch.setattr(health_module, '_check_admin_api', AsyncMock(return_value=True))
    monkeypatch.setattr(auth_module, '_dynamic_token', 'dynamic-secret')

    body = client.get('/health').json()

    assert body['tokenValid'] is True
    assert body['tokenConfigured'] is True
    assert body['dynamicTokenActive'] is True


def test_health_reports_dynamic_token_missing_when_only_static_exists(client, monkeypatch):
    import auth as auth_module

    monkeypatch.setenv('EXECUTOR_SHARED_TOKEN', 'static-secret')
    monkeypatch.setattr(health_module, '_check_admin_api', AsyncMock(return_value=True))
    monkeypatch.setattr(auth_module, '_dynamic_token', None)

    body = client.get('/health').json()

    # 静态配了、动态没下来 —— 旧探针只有 tokenValid=true，看不出这个区别
    assert body['tokenValid'] is True
    assert body['dynamicTokenActive'] is False


def test_health_reports_no_token_at_all(client, monkeypatch):
    import auth as auth_module

    monkeypatch.delenv('EXECUTOR_SHARED_TOKEN', raising=False)
    monkeypatch.delenv('EXECUTOR_SECRET', raising=False)
    monkeypatch.setattr(settings, 'executor_shared_token', '')
    monkeypatch.setattr(settings, 'executor_secret', '')
    monkeypatch.setattr(health_module, '_check_admin_api', AsyncMock(return_value=True))
    monkeypatch.setattr(auth_module, '_dynamic_token', None)

    body = client.get('/health').json()

    assert body['tokenValid'] is False
    assert body['dynamicTokenActive'] is False


# ---------------------------------------------------------------------------
# A3-C（DEEP_REVIEW 0ef3bbe §七 残差收口）：/health/ready 出参必经生成的
# HealthReadyResponse——status 值域/形状漂移（如退回旧值 'unready'）立即红。
# ---------------------------------------------------------------------------


def test_ready_body_conforms_to_generated_schema(client, monkeypatch):
    from generated.protocol_schemas import HealthReadyResponse as ProtocolReady
    monkeypatch.setattr(health_module, '_check_admin_api', AsyncMock(return_value=True))
    monkeypatch.setattr(health_module, '_resources_ok', lambda: (True, None))

    resp = client.get('/health/ready')
    assert resp.status_code == 200
    ProtocolReady.model_validate(resp.json())  # 不抛即契约一致


def test_not_ready_body_conforms_to_generated_schema(client, monkeypatch):
    from generated.protocol_schemas import HealthReadyResponse as ProtocolReady
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(settings, 'admin_api_url_external', '')
    monkeypatch.setattr(health_module, '_check_admin_api', AsyncMock(return_value=False))

    resp = client.get('/health/ready')
    assert resp.status_code == 503
    ProtocolReady.model_validate(resp.json())  # 不抛即契约一致
