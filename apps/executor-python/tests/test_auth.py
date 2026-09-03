import asyncio

import httpx
import pytest
from fastapi import HTTPException
from unittest.mock import AsyncMock

import auth as auth_module
from startup_identity import executor_startup_id


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


# ---------------------------------------------------------------------------
# R9 (round-9): _fetch_token must accept 2xx (Nest POST answers 201), unwrap
# the {code,message,data} envelope, send startupId, and adopt tokenHash.
# ---------------------------------------------------------------------------

def _make_response(status_code: int, payload) -> httpx.Response:
    """A real httpx.Response carrying a JSON body (so .json() works)."""
    request = httpx.Request('POST', 'http://admin.local/api/executors/token')
    return httpx.Response(status_code, json=payload, request=request)


def _patch_async_client(monkeypatch, response):
    """Replace auth.httpx.AsyncClient with a mock returning `response`."""
    mock_client = AsyncMock()
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    mock_client.post = AsyncMock(return_value=response)
    monkeypatch.setattr(auth_module.httpx, 'AsyncClient', lambda *a, **k: mock_client)
    return mock_client


class TestUnwrapEnvelope:
    def test_envelope_returns_inner_data(self):
        payload = {'code': 0, 'message': 'ok', 'data': {'token': 'abc'}}
        assert auth_module._unwrap_envelope(payload) == {'token': 'abc'}

    def test_bare_payload_returned_unchanged(self):
        payload = {'token': 'abc'}
        assert auth_module._unwrap_envelope(payload) == {'token': 'abc'}

    def test_non_dict_returned_unchanged(self):
        assert auth_module._unwrap_envelope(None) is None
        assert auth_module._unwrap_envelope('x') == 'x'


class TestAdoptTokenHash:
    def test_adopts_from_envelope(self, monkeypatch):
        monkeypatch.setattr(auth_module, '_executor_token_hash', None)
        auth_module.adopt_executor_token_hash(
            {'code': 0, 'message': 'ok', 'data': {'tokenHash': 'hash-1'}}
        )
        assert auth_module.get_executor_token_hash() == 'hash-1'

    def test_adopts_from_bare_shape(self, monkeypatch):
        monkeypatch.setattr(auth_module, '_executor_token_hash', None)
        auth_module.adopt_executor_token_hash({'tokenHash': 'hash-2'})
        assert auth_module.get_executor_token_hash() == 'hash-2'

    def test_noop_when_absent(self, monkeypatch):
        monkeypatch.setattr(auth_module, '_executor_token_hash', 'keep-me')
        auth_module.adopt_executor_token_hash({'code': 0, 'data': {'other': 1}})
        auth_module.adopt_executor_token_hash(None)
        auth_module.adopt_executor_token_hash({'tokenHash': ''})
        assert auth_module.get_executor_token_hash() == 'keep-me'


class TestFetchToken:
    def test_envelope_201_returns_token_and_adopts_hash(self, monkeypatch):
        """Nest POST /token answers 201 with the {code,message,data} envelope."""
        monkeypatch.setattr(auth_module, '_executor_token_hash', None)
        _patch_async_client(monkeypatch, _make_response(201, {
            'code': 0, 'message': 'ok',
            'data': {'token': 'dyn-token', 'tokenHash': 'hash-9'},
        }))
        token = asyncio.run(auth_module._fetch_token())
        assert token == 'dyn-token'
        assert auth_module.get_executor_token_hash() == 'hash-9'

    def test_bare_200_returns_token(self, monkeypatch):
        """Backwards-compat: a bare (non-enveloped) 200 payload still works."""
        monkeypatch.setattr(auth_module, '_executor_token_hash', None)
        _patch_async_client(monkeypatch, _make_response(200, {'token': 'bare-token'}))
        assert asyncio.run(auth_module._fetch_token()) == 'bare-token'

    def test_non_2xx_returns_none(self, monkeypatch):
        _patch_async_client(monkeypatch, _make_response(401, {'message': 'nope'}))
        assert asyncio.run(auth_module._fetch_token()) is None

    def test_envelope_without_token_returns_none(self, monkeypatch):
        _patch_async_client(monkeypatch, _make_response(201, {
            'code': 0, 'message': 'ok', 'data': None,
        }))
        assert asyncio.run(auth_module._fetch_token()) is None

    def test_request_body_carries_startup_id(self, monkeypatch):
        mock_client = _patch_async_client(monkeypatch, _make_response(201, {
            'code': 0, 'data': {'token': 't'},
        }))
        asyncio.run(auth_module._fetch_token())
        body = mock_client.post.call_args.kwargs['json']
        assert body['startupId'] == executor_startup_id
        assert 'address' in body and 'appName' in body

    def test_transport_error_returns_none(self, monkeypatch):
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = None
        mock_client.post = AsyncMock(side_effect=httpx.ConnectError('refused'))
        monkeypatch.setattr(auth_module.httpx, 'AsyncClient', lambda *a, **k: mock_client)
        assert asyncio.run(auth_module._fetch_token()) is None
