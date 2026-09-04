"""N33 (round-9): per-execution one-shot callback tokens (executor-python side).

Port of executor-node's ``src/execution-callback-token.ts`` (N23), byte-for-byte
compatible with admin-api's
``apps/admin-api/src/modules/task/execution-callback-token.util.ts`` — pinned by
an IDENTICAL test vector in all three suites
(secret ``test-secret-vector``, executionId ``f47ac10b-58cc-4372-a567-0e02b2c3d479``,
expiresAt 2000000000 → signature ``29f7b559…e56b``). If the algorithm ever
changes on one side only, one of the suites goes red.

Token format (all ASCII, dot-separated)::

    v1.<executionId>.<expiresAtUnixSec>.<hmacHex>

      key      = HMAC-SHA256(secret, "autocodeflow:execution-callback:v1")  # raw 32-byte digest
      hmacHex  = HMAC-SHA256(key, "v1.<executionId>.<expiresAtUnixSec>")

``secret`` resolution order (parity with node's ``resolveCallbackSecret``, N26):

1. ``EXECUTION_CALLBACK_SECRET`` env — fleet-wide dedicated HMAC secret;
2. the per-executor ``tokenHash`` admin-api echoed on register / POST /token /
   heartbeat (``auth.get_executor_token_hash()``) — lets nodes installed with
   their own ``--secret`` mint tokens the admin verifies against the exact
   hash it stores;
3. the executor shared token — legacy fallback for admins that only know the
   shared secret.

The domain-separation step means the raw shared token is never used directly
as an HMAC key, and a per-execution token can never be forged back into a
shared token. Task code receives the minted token as ``AUTOFLOW_CALLBACK_TOKEN``
via the explicit extra-env channel in ``routers/execute.py`` (SEC-01 whitelist
untouched), so it can call ``POST /api/executions/callback`` without ever
seeing the shared token.
"""
import hashlib
import hmac
import math
import os
import time
from typing import Optional

from auth import get_executor_token_hash, get_static_token
from config import settings

DOMAIN_SEPARATOR = 'autocodeflow:execution-callback:v1'

EXECUTION_CALLBACK_TOKEN_PREFIX = 'v1.'

# Extra lifetime beyond the task timeout so a task finishing right at the
# deadline can still deliver its final callback (node parity).
CALLBACK_TOKEN_GRACE_SECONDS = 900


def resolve_callback_secret() -> str:
    """Secret used to derive per-execution callback tokens: dedicated env
    first, then the per-executor tokenHash adopted from admin-api responses
    (N26), then the executor shared token the process already holds."""
    return (
        os.environ.get('EXECUTION_CALLBACK_SECRET')
        or get_executor_token_hash()
        or settings.executor_shared_token
        or settings.executor_secret
        # env-at-call-time fallback (same source auth._get_static_token reads,
        # so test fixtures that only set the env var are honored).
        or get_static_token()
        or ''
    )


def _compute_signature(secret: str, payload: str) -> str:
    key = hmac.new(
        secret.encode('utf-8'), DOMAIN_SEPARATOR.encode('utf-8'), hashlib.sha256
    ).digest()
    return hmac.new(key, payload.encode('utf-8'), hashlib.sha256).hexdigest()


def sign_execution_callback_token(
    secret: str, execution_id: str, expires_at_sec: int
) -> str:
    """Sign a token for (execution_id, expires_at_sec) with an explicit secret."""
    payload = f'{EXECUTION_CALLBACK_TOKEN_PREFIX}{execution_id}.{expires_at_sec}'
    return f'{payload}.{_compute_signature(secret, payload)}'


def create_execution_callback_token(
    execution_id: str,
    ttl_seconds: float,
    secret: Optional[str] = None,
) -> Optional[str]:
    """Mint a per-execution callback token valid for ``ttl_seconds``.

    Returns None when no secret is configured (dev executors without a
    token) — callers then simply omit AUTOFLOW_CALLBACK_TOKEN and the SDK
    stays in its disabled state, exactly as before N23.
    """
    if secret is None:
        secret = resolve_callback_secret()
    if not secret or not execution_id:
        return None
    ttl = max(1, math.floor(ttl_seconds))
    expires_at_sec = int(time.time()) + ttl
    return sign_execution_callback_token(secret, execution_id, expires_at_sec)
