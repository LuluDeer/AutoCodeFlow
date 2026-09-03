"""N33 (round-9): executor-python port of the per-execution callback-token
signer. The pinned vector below is the SAME constant used by
apps/admin-api/src/modules/task/__tests__/execution-callback-token.util.spec.ts
and apps/executor-node/src/execution-callback-token.spec.ts — it pins
byte-for-byte algorithm agreement across all three implementations."""
import hashlib
import hmac
import time

import pytest

import auth as auth_module
import execution_callback_token as ecbt
from config import settings

SECRET = 'test-secret-vector'
EXEC_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
PINNED_EXP = 2000000000
PINNED_TOKEN = (
    'v1.f47ac10b-58cc-4372-a567-0e02b2c3d479.2000000000.'
    '29f7b55965d77d10204409c0146d78628d5d06b86f4c32d8a2778cc2fb84e56b'
)


def _clear_all_secrets(monkeypatch):
    monkeypatch.delenv('EXECUTION_CALLBACK_SECRET', raising=False)
    monkeypatch.delenv('EXECUTOR_SHARED_TOKEN', raising=False)
    monkeypatch.delenv('EXECUTOR_SECRET', raising=False)
    monkeypatch.setattr(settings, 'executor_shared_token', '')
    monkeypatch.setattr(settings, 'executor_secret', '')
    monkeypatch.setattr(auth_module, '_executor_token_hash', None)


def test_pinned_cross_component_vector():
    """Same (secret, executionId, exp) must produce the exact token the
    admin-api util and executor-node specs pin — the cross-language
    byte-for-byte agreement check for the HMAC port."""
    assert ecbt.sign_execution_callback_token(SECRET, EXEC_UUID, PINNED_EXP) == PINNED_TOKEN


def test_signature_matches_reference_hmac_chain():
    """key = HMAC-SHA256(secret, domain) raw digest; sig = HMAC-SHA256(key, payload)."""
    key = hmac.new(
        SECRET.encode(), b'autocodeflow:execution-callback:v1', hashlib.sha256
    ).digest()
    payload = f'v1.{EXEC_UUID}.{PINNED_EXP}'
    sig = hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()
    assert ecbt.sign_execution_callback_token(SECRET, EXEC_UUID, PINNED_EXP) == f'{payload}.{sig}'


def test_tampered_fields_fail_recomputation():
    token = ecbt.sign_execution_callback_token(SECRET, EXEC_UUID, PINNED_EXP)
    prefix, exec_id, exp, sig = token.split('.')
    assert prefix == 'v1'
    # expiry bumped by one second must not carry the old signature
    forged = f'v1.{exec_id}.{int(exp) + 1}.{sig}'
    forged_payload = forged[:forged.rindex('.')]
    assert ecbt._compute_signature(SECRET, forged_payload) != sig
    # executionId swapped must not carry the old signature either
    forged2 = f'v1.{"0" * 36}.{exp}.{sig}'
    assert ecbt._compute_signature(SECRET, forged2[:forged2.rindex('.')]) != sig


def test_create_returns_none_without_secret(monkeypatch):
    _clear_all_secrets(monkeypatch)
    assert ecbt.create_execution_callback_token(EXEC_UUID, 60) is None


def test_create_returns_none_without_execution_id(monkeypatch):
    monkeypatch.setenv('EXECUTION_CALLBACK_SECRET', SECRET)
    assert ecbt.create_execution_callback_token('', 60) is None


def test_create_mints_wellformed_token_with_ttl(monkeypatch):
    monkeypatch.setenv('EXECUTION_CALLBACK_SECRET', SECRET)
    now = int(time.time())
    token = ecbt.create_execution_callback_token(EXEC_UUID, 100)
    assert token is not None
    parts = token.split('.')
    assert parts[0] == 'v1'
    assert parts[1] == EXEC_UUID
    exp = int(parts[2])
    assert now + 100 - 2 <= exp <= now + 100 + 2
    assert parts[3] == ecbt._compute_signature(SECRET, '.'.join(parts[:3]))


def test_create_ttl_floor_is_one_second():
    # node parity: Math.max(1, Math.floor(ttl)) — 0/negative/float all clamp up
    token = ecbt.create_execution_callback_token(EXEC_UUID, -5, secret=SECRET)
    exp = int(token.split('.')[2])
    assert exp >= int(time.time()) + 1 - 2


def test_secret_resolution_priority(monkeypatch):
    # 1. dedicated env wins over everything
    _clear_all_secrets(monkeypatch)
    monkeypatch.setattr(auth_module, '_executor_token_hash', 'hash-secret')
    monkeypatch.setattr(settings, 'executor_shared_token', 'shared-secret')
    monkeypatch.setenv('EXECUTION_CALLBACK_SECRET', 'env-secret')
    assert ecbt.resolve_callback_secret() == 'env-secret'
    # 2. then the admin-adopted per-executor tokenHash (N26)
    monkeypatch.delenv('EXECUTION_CALLBACK_SECRET')
    assert ecbt.resolve_callback_secret() == 'hash-secret'
    # 3. then the configured shared token
    monkeypatch.setattr(auth_module, '_executor_token_hash', None)
    assert ecbt.resolve_callback_secret() == 'shared-secret'
    # 4. finally the env-at-call-time static token (auth bootstrap source)
    monkeypatch.setattr(settings, 'executor_shared_token', '')
    monkeypatch.setattr(settings, 'executor_secret', '')
    monkeypatch.setenv('EXECUTOR_SECRET', 'legacy-env-secret')
    assert ecbt.resolve_callback_secret() == 'legacy-env-secret'
    _clear_all_secrets(monkeypatch)
    assert ecbt.resolve_callback_secret() == ''


def test_grace_constant_matches_node():
    # apps/executor-node/src/execution-callback-token.ts CALLBACK_TOKEN_GRACE_SECONDS
    assert ecbt.CALLBACK_TOKEN_GRACE_SECONDS == 900
