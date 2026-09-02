import asyncio

import pytest
from fastapi import HTTPException

import auth as auth_module


def test_no_token_returns_401(client):
    """POST /api/execute without Authorization header should return 401."""
    response = client.post('/api/execute', json={
        'executionId': 'test-exec-1',
        'task': {'name': 'test'},
    })
    assert response.status_code == 401


def test_wrong_token_returns_401(client):
    """POST /api/execute with wrong Bearer token should return 401."""
    response = client.post(
        '/api/execute',
        json={
            'executionId': 'test-exec-2',
            'task': {'name': 'test'},
        },
        headers={'Authorization': 'Bearer wrongtoken'},
    )
    assert response.status_code == 401


def test_correct_token_not_401(auth_client):
    """POST /api/execute with correct token should pass auth (may return other errors for bad payload)."""
    response = auth_client.post(
        '/api/execute',
        json={
            'executionId': 'test-exec-3',
            'task': {'name': 'test'},
        },
        headers={'Authorization': 'Bearer testsecret'},
    )
    assert response.status_code != 401


# ---------------------------------------------------------------------------
# R4-C P2: unconfigured token must be able to fail closed (REQUIRE_TOKEN)
# ---------------------------------------------------------------------------

def _clear_all_tokens(monkeypatch):
    """Remove dynamic + static tokens so verify_token reaches the dev-mode branch."""
    monkeypatch.setattr(auth_module, '_dynamic_token', None)
    monkeypatch.delenv('EXECUTOR_SHARED_TOKEN', raising=False)
    monkeypatch.delenv('EXECUTOR_SECRET', raising=False)


def test_verify_token_dev_mode_allows_when_require_token_unset(monkeypatch):
    """Default: an executor without any token keeps the dev-mode allow-all."""
    _clear_all_tokens(monkeypatch)
    monkeypatch.delenv('REQUIRE_TOKEN', raising=False)
    asyncio.run(auth_module.verify_token(''))  # must not raise


def test_verify_token_require_token_fails_closed(monkeypatch):
    """P2: REQUIRE_TOKEN=true turns an unconfigured token into 503 instead of
    silently accepting arbitrary executions."""
    _clear_all_tokens(monkeypatch)
    monkeypatch.setenv('REQUIRE_TOKEN', 'true')
    with pytest.raises(HTTPException) as exc:
        asyncio.run(auth_module.verify_token(''))
    assert exc.value.status_code == 503


def test_verify_token_require_token_passes_with_valid_token(monkeypatch):
    """REQUIRE_TOKEN=true must not affect properly configured executors."""
    _clear_all_tokens(monkeypatch)
    monkeypatch.setenv('EXECUTOR_SHARED_TOKEN', 'secret-x')
    monkeypatch.setenv('REQUIRE_TOKEN', 'true')
    asyncio.run(auth_module.verify_token('Bearer secret-x'))  # must not raise


def test_execute_endpoint_fails_closed_when_require_token(monkeypatch, client):
    """End to end: REQUIRE_TOKEN=true + no configured token -> 503 on /api/execute."""
    from routers import execute as execute_module  # noqa: F401  (app import side effects)
    _clear_all_tokens(monkeypatch)
    monkeypatch.setenv('REQUIRE_TOKEN', 'true')
    response = client.post('/api/execute', json={
        'executionId': 'exec-require-token',
        'task': {'name': 't'},
    })
    assert response.status_code == 503
    assert 'REQUIRE_TOKEN' in response.json()['detail']
