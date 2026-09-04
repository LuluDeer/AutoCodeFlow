import pytest
import httpx
from unittest.mock import AsyncMock, patch

import auth as auth_module
from config import settings
from main import register_executor, executor_started_at, executor_startup_id


def _register_response(status_code=201, json_body=None, text=None):
    return httpx.Response(
        status_code,
        json=json_body if json_body is not None else {'code': 0, 'message': 'ok', 'data': {}},
        text=text,
        request=httpx.Request('POST', 'http://admin.local/api/executors/register'),
    )


def _patch_settings(monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(settings, 'admin_api_url_internal', None)
    monkeypatch.setattr(settings, 'admin_api_url_external', None)
    monkeypatch.setattr(settings, 'app_name', 'py-executor')
    monkeypatch.setattr(settings, 'executor_address', 'localhost:8001')
    monkeypatch.setattr(settings, 'executor_address_public', '')


@pytest.mark.asyncio
async def test_register_executor_posts_capacity_metadata(monkeypatch):
    """Python executor registration should report scheduler capacity to admin-api."""
    _patch_settings(monkeypatch)
    monkeypatch.setattr(settings, 'max_concurrent_tasks', 7)

    mock_client = AsyncMock()
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    mock_client.post = AsyncMock(return_value=_register_response())

    with patch('main.httpx.AsyncClient', return_value=mock_client):
        await register_executor()

    mock_client.post.assert_awaited_once()
    args, kwargs = mock_client.post.call_args
    assert args[0] == 'http://admin.local/api/executors/register'
    assert kwargs['json'] == {
        'appName': 'py-executor',
        'address': 'localhost:8001',
        'type': 'python',
        'version': '1.0.0',
        'capabilities': ['python', 'shell'],
        'maxConcurrentTasks': 7,
        'restartedAt': executor_started_at,
        'startupId': executor_startup_id,
    }


@pytest.mark.asyncio
async def test_register_executor_uses_static_bootstrap_token(monkeypatch):
    """P1 fix (VERIFY-round9-e2e §1.4): /executors/register is bootstrap-token
    only — register must carry the shared static token even when a dynamic
    per-executor token is cached (the dynamic token gets 401 there)."""
    _patch_settings(monkeypatch)
    monkeypatch.setenv('EXECUTOR_SHARED_TOKEN', 'bootstrap-token')
    # Simulate R9's now-working dynamic token being cached: register must NOT
    # prefer it (the old get_current_token() behaviour caused the 401).
    monkeypatch.setattr(auth_module, '_dynamic_token', 'dynamic-token')

    mock_client = AsyncMock()
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    mock_client.post = AsyncMock(return_value=_register_response())

    with patch('main.httpx.AsyncClient', return_value=mock_client):
        await register_executor()

    args, kwargs = mock_client.post.call_args
    assert kwargs['headers'] == {'Authorization': 'Bearer bootstrap-token'}


@pytest.mark.asyncio
async def test_register_executor_adopts_token_hash_from_response(monkeypatch):
    """R9 (round-9, W3): the register response carries the stored tokenHash
    (N26) — the executor must adopt it as the callback-token HMAC source."""
    _patch_settings(monkeypatch)
    monkeypatch.setattr(auth_module, '_executor_token_hash', None)

    response = _register_response(201, {'code': 0, 'message': 'ok', 'data': {'tokenHash': 'reg-hash'}})
    mock_client = AsyncMock()
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    mock_client.post = AsyncMock(return_value=response)

    with patch('main.httpx.AsyncClient', return_value=mock_client):
        await register_executor()

    assert auth_module.get_executor_token_hash() == 'reg-hash'


@pytest.mark.asyncio
async def test_register_executor_logs_error_on_non_2xx(monkeypatch, caplog):
    """P1 fix: a rejected register (e.g. 401) must be logged as an error with
    the status code and a body summary — never as a silent success."""
    _patch_settings(monkeypatch)
    monkeypatch.setattr(auth_module, '_executor_token_hash', None)

    response = _register_response(401, text='{"code":401,"message":"Invalid executor token"}')
    mock_client = AsyncMock()
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    mock_client.post = AsyncMock(return_value=response)

    with caplog.at_level('ERROR'), patch('main.httpx.AsyncClient', return_value=mock_client):
        await register_executor()

    errors = [r for r in caplog.records if r.levelname == 'ERROR']
    assert len(errors) == 1
    assert '401' in errors[0].getMessage()
    assert 'Invalid executor token' in errors[0].getMessage()
    # No misleading success line, and no tokenHash adoption from a rejected response.
    assert not [r for r in caplog.records if 'Registered to admin-api' in r.getMessage()]
    assert auth_module.get_executor_token_hash() is None
