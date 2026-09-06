"""Tests for E2 (callback persistence + background replay + dead-letter).

CONSISTENCY round port of executor-node callback.ts:

- give-up paths of the bounded retry loop now park the payload under
  <workDir>/callbacks/ instead of losing the execution result
- the payload file carries NO Authorization credential — the dynamic
  per-executor token is replay-time state (node persists the bare request
  payload and posts through admin-client, which signs at send time)
- a background sweep replays persisted files with per-file retry budgets
  (.meta counter), dead-letters exhausted/corrupt/oversized files, and
  refreshes the cached deadLetterCount the heartbeat reports
- shutdown drains the sweep with a bounded wait (stopCallbackThread parity)
"""
import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

import scheduler as sched


class _FakeResponse:
    def __init__(self, status_code):
        self.status_code = status_code


def _patch_callback_env(monkeypatch):
    from routers import execute as execute_module
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'tok')
    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')
    monkeypatch.setattr(execute_module.settings, 'executor_address_public', 'pub:9000')
    monkeypatch.setattr(execute_module, 'get_current_token', AsyncMock(return_value=None))


class _DownClient:
    """Always-503 client counting every post."""

    calls = 0

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json, headers):
        type(self).calls += 1
        return _FakeResponse(503)


# ---------------------------------------------------------------------------
# Failure -> persisted file
# ---------------------------------------------------------------------------

def test_run_and_callback_gives_up_persists_payload(monkeypatch, tmp_path):
    """Retry exhaustion must leave the payload on disk (not lost), with no
    Authorization/token material inside the file."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _DownClient)
    monkeypatch.setattr(execute_module, 'CALLBACK_RETRY_BASE_DELAY_SECONDS', 0)
    _patch_callback_env(monkeypatch)

    async def fake_run_task(req, entry=None):
        return {'success': True, 'logs': '', 'exitCode': 0, 'durationMs': 5}

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)

    asyncio.run(execute_module._run_and_callback(
        ExecuteRequest(executionId='exec-persist', task={'name': 'n'})))

    callback_dir = tmp_path / 'callbacks'
    payloads = list(callback_dir.glob('callback-*.json'))
    assert len(payloads) == 1, 'exactly one payload file must be persisted'
    data = json.loads(payloads[0].read_text(encoding='utf-8'))
    assert data['url'] == 'http://admin.local/api/executions/callback'
    assert isinstance(data['payloads'], list) and len(data['payloads']) == 1
    item = data['payloads'][0]
    assert item['executionId'] == 'exec-persist'
    assert item['status'] == 'success'
    # no credential material anywhere in the persisted file
    assert 'Authorization' not in json.dumps(data)
    assert 'tok' not in json.dumps(data)
    # companion retry counter exists and starts at 0
    meta = json.loads((payloads[0].with_name(payloads[0].name + '.meta')).read_text())
    assert meta['retries'] == 0


def test_permanent_4xx_rejection_persists_payload(monkeypatch, tmp_path):
    """E2: terminal 4xx rejections lose the result unless persisted — the
    payload must land in callbacks/ so replay can re-confirm or dead-letter."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    calls = []

    class _RejectingClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            calls.append(url)
            return _FakeResponse(422)

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _RejectingClient)
    _patch_callback_env(monkeypatch)

    async def fake_run_task(req, entry=None):
        return {'success': True, 'logs': '', 'exitCode': 0, 'durationMs': 5}

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)

    asyncio.run(execute_module._run_and_callback(
        ExecuteRequest(executionId='exec-422-persist', task={'name': 'n'})))

    assert len(calls) == 1  # still no retry storm on terminal 4xx
    persisted = list((tmp_path / 'callbacks').glob('callback-*.json'))
    assert len(persisted) == 1


def test_persist_failure_does_not_crash_caller(monkeypatch, tmp_path):
    """If even persistence fails (unwritable dir) the give-up path must not
    raise out of _send_callback_with_retry."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    async def fake_run_task(req, entry=None):
        return {'success': True, 'logs': '', 'exitCode': 0, 'durationMs': 5}

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _DownClient)
    monkeypatch.setattr(execute_module, 'CALLBACK_RETRY_BASE_DELAY_SECONDS', 0)
    _patch_callback_env(monkeypatch)
    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)

    def boom(payload, url):
        raise OSError('disk full')

    monkeypatch.setattr(execute_module, '_persist_failed_callback', boom)
    # must complete without raising
    asyncio.run(execute_module._run_and_callback(
        ExecuteRequest(executionId='exec-persist-boom', task={'name': 'n'})))


# ---------------------------------------------------------------------------
# Replay: success / retry budget / dead-letter
# ---------------------------------------------------------------------------

def test_retry_persisted_callbacks_replays_and_removes(monkeypatch, tmp_path):
    """A persisted file whose replay succeeds is removed together with its
    .meta; the dead-letter count stays zero."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    _patch_callback_env(monkeypatch)

    posted = []

    class _OkClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            posted.append((url, json, dict(headers)))
            return _FakeResponse(200)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _OkClient)

    payload_file = execute_module._persist_failed_callback(
        {'executionId': 'exec-replay', 'status': 'success'}, 'http://admin.local/api/executions/callback')
    assert payload_file is not None

    delivered = asyncio.run(execute_module.retry_persisted_callbacks())

    assert delivered == 1
    assert not payload_file.exists()
    assert not payload_file.with_name(payload_file.name + '.meta').exists()
    url, batch, headers = posted[0]
    assert url == 'http://admin.local/api/executions/callback'
    assert batch == [{'executionId': 'exec-replay', 'status': 'success'}]
    # replay re-signs with the current token (here the settings fallback)
    assert headers['Authorization'] == 'Bearer tok'
    assert execute_module.get_dead_letter_count() == 0


def test_retry_replays_with_current_token_not_persisted_one(monkeypatch, tmp_path):
    """The file holds no credential; replay signs with the token valid at
    replay time (node posts through admin-client at send time)."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    _patch_callback_env(monkeypatch)
    monkeypatch.setattr(execute_module, 'get_current_token',
                        AsyncMock(return_value='fresh-dynamic'))

    posted_headers = []

    class _OkClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            posted_headers.append(dict(headers))
            return _FakeResponse(200)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _OkClient)

    execute_module._persist_failed_callback(
        {'executionId': 'exec-resign'}, 'http://admin.local/api/executions/callback')
    asyncio.run(execute_module.retry_persisted_callbacks())

    assert posted_headers[0]['Authorization'] == 'Bearer fresh-dynamic'


def test_retry_failure_increments_meta_and_exhaustion_dead_letters(monkeypatch, tmp_path):
    """Each failed round bumps the .meta counter; reaching
    CALLBACK_FILE_MAX_RETRIES moves the file (not the meta) into
    callbacks/dead-letter/ and stops retrying it."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    _patch_callback_env(monkeypatch)
    # zero the per-file backoff gate: these sweeps run back-to-back
    monkeypatch.setattr(execute_module, 'CALLBACK_REPLAY_BACKOFF_BASE_SECONDS', 0)

    class _DownClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            return _FakeResponse(503)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _DownClient)

    payload_file = execute_module._persist_failed_callback(
        {'executionId': 'exec-dl'}, 'http://admin.local/api/executions/callback')

    for expected_retries in range(1, execute_module.CALLBACK_FILE_MAX_RETRIES):
        asyncio.run(execute_module.retry_persisted_callbacks())
        meta = json.loads(payload_file.with_name(payload_file.name + '.meta').read_text())
        assert meta['retries'] == expected_retries
        assert payload_file.exists(), 'file must stay in callbacks/ until the budget is spent'

    # final failed round crosses the budget -> dead-letter
    asyncio.run(execute_module.retry_persisted_callbacks())
    dead_letter = tmp_path / 'callbacks' / 'dead-letter'
    moved = list(dead_letter.glob('callback-*.json'))
    assert len(moved) == 1
    assert json.loads(moved[0].read_text())['payloads'][0]['executionId'] == 'exec-dl'
    # no stranded meta either in callbacks/ or dead-letter/
    assert not payload_file.with_name(payload_file.name + '.meta').exists()
    assert list(dead_letter.glob('*.meta')) == []
    assert not payload_file.exists()
    assert execute_module.get_dead_letter_count() == 1
    # a further sweep does not resend dead-lettered payloads
    delivered = asyncio.run(execute_module.retry_persisted_callbacks())
    assert delivered == 0


def test_retry_dead_letters_corrupt_payload(monkeypatch, tmp_path):
    """Unparseable poison files would never succeed — dead-letter instead of
    burning a replay round forever (node SyntaxError branch)."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    _patch_callback_env(monkeypatch)
    callback_dir = tmp_path / 'callbacks'
    callback_dir.mkdir(parents=True)  # sweep must tolerate a dir without dead-letter/
    poison = callback_dir / 'callback-0-0.json'
    poison.write_text('{not json', encoding='utf-8')
    poison.with_name(poison.name + '.meta').write_text('{"retries": 0}')

    asyncio.run(execute_module.retry_persisted_callbacks())

    assert not poison.exists()
    assert list((callback_dir / 'dead-letter').glob('callback-*.json')) == [callback_dir / 'dead-letter' / poison.name]


def test_retry_dead_letters_oversized_payload(monkeypatch, tmp_path):
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    _patch_callback_env(monkeypatch)
    callback_dir = tmp_path / 'callbacks'
    callback_dir.mkdir(parents=True)
    big = callback_dir / 'callback-0-1.json'
    big.write_text(json.dumps({'url': 'http://x', 'payloads': [{'pad': 'x' * 100}]}), encoding='utf-8')

    monkeypatch.setattr(execute_module, 'CALLBACK_FILE_MAX_SIZE_BYTES', 10)

    asyncio.run(execute_module.retry_persisted_callbacks())

    assert not big.exists()
    assert (callback_dir / 'dead-letter' / big.name).exists()


def test_retry_ignores_unrelated_files(monkeypatch, tmp_path):
    """Only callback-*.json payloads are replayed; the dead-letter directory
    and stray files must not be touched (and dead-letter is not descended)."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    callback_dir = tmp_path / 'callbacks'
    (callback_dir / 'dead-letter').mkdir(parents=True, exist_ok=True)
    stray = callback_dir / 'notes.txt'
    stray.write_text('keep me', encoding='utf-8')
    dead = callback_dir / 'dead-letter' / 'callback-9-9.json'
    dead.write_text('{}', encoding='utf-8')

    delivered = asyncio.run(execute_module.retry_persisted_callbacks())

    assert delivered == 0
    assert stray.exists()
    assert dead.exists()


def test_replay_backoff_gate_defers_recent_failure(monkeypatch, tmp_path):
    """E2 指数退避: a file that just failed a replay round is not re-attempted
    before base*2**retries have elapsed (gate reads .meta updatedAt); once the
    gate expires the sweep retries and bumps the counter again."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    _patch_callback_env(monkeypatch)

    class _DownClient:
        calls = 0

        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            type(self).calls += 1
            return _FakeResponse(503)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _DownClient)
    # backdate persistence so the FIRST round is allowed immediately
    monkeypatch.setattr(execute_module, 'CALLBACK_REPLAY_BACKOFF_BASE_SECONDS', 1000.0)

    payload_file = execute_module._persist_failed_callback(
        {'executionId': 'exec-gate'}, 'http://admin.local/api/executions/callback')

    # round 1: persistedAt backdated past the gate -> attempted, fails, meta
    # records updatedAt=now with retries=1
    assert asyncio.run(execute_module.retry_persisted_callbacks()) == 0
    assert _DownClient.calls == 1
    meta = json.loads(payload_file.with_name(payload_file.name + '.meta').read_text())
    assert meta['retries'] == 1

    # round 2: gate = 1000*2**1 s — nowhere near elapsed -> skipped, no post
    assert asyncio.run(execute_module.retry_persisted_callbacks()) == 0
    assert _DownClient.calls == 1
    assert payload_file.exists()

    # age the meta past the (capped) gate -> the sweep retries
    meta['updatedAt'] = int((time.time() - execute_module.CALLBACK_REPLAY_BACKOFF_MAX_SECONDS) * 1000)
    payload_file.with_name(payload_file.name + '.meta').write_text(json.dumps(meta))
    assert asyncio.run(execute_module.retry_persisted_callbacks()) == 0
    assert _DownClient.calls == 2
    meta = json.loads(payload_file.with_name(payload_file.name + '.meta').read_text())
    assert meta['retries'] == 2


def test_stop_mid_replay_leaves_file_durable(monkeypatch, tmp_path):
    """Shutting down while a replay POST is in flight must neither lose the
    payload nor count the interrupted round (node: 'Already durable; do not
    count an interrupted retry')."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    _patch_callback_env(monkeypatch)
    monkeypatch.setattr(execute_module, 'CALLBACK_RETRY_SWEEP_INTERVAL_SECONDS', 0.01)
    monkeypatch.setattr(execute_module, 'CALLBACK_DRAIN_TIMEOUT_SECONDS', 0.2)

    entered = asyncio.Event()
    release = asyncio.Event()

    class _HangingClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            entered.set()
            await asyncio.wait_for(release.wait(), timeout=30)
            return _FakeResponse(200)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _HangingClient)

    payload_file = execute_module._persist_failed_callback(
        {'executionId': 'exec-cancel'}, 'http://admin.local/api/executions/callback')

    async def scenario():
        execute_module.start_callback_retry_task()
        await asyncio.wait_for(entered.wait(), timeout=5)
        started = time.monotonic()
        await execute_module.stop_callback_retry_task()
        elapsed = time.monotonic() - started
        assert elapsed < 5, 'drain must stay bounded'
        assert execute_module._callback_retry_task is None

    asyncio.run(scenario())

    assert payload_file.exists(), 'in-flight payload must remain durable'
    meta = json.loads(payload_file.with_name(payload_file.name + '.meta').read_text())
    assert meta['retries'] == 0, 'interrupted round must not be counted'


# ---------------------------------------------------------------------------
# Heartbeat reporting
# ---------------------------------------------------------------------------

def test_heartbeat_includes_dead_letter_count(monkeypatch):
    """E2: the heartbeat always carries deadLetterCount (node scheduler.ts
    sendHeartbeat sends deadLetterCountProvider()); the provider wired at
    import time reflects the dead-letter directory size."""
    import routers.execute  # noqa: F401  (import = provider wiring)
    from routers import execute as execute_module
    import tempfile

    monkeypatch.setattr(execute_module.settings, 'work_dir', Path(tempfile.mkdtemp(prefix='acf-dlc-')))
    monkeypatch.setattr(execute_module, 'CALLBACK_REPLAY_BACKOFF_BASE_SECONDS', 0)
    monkeypatch.setattr(sched.psutil, 'cpu_percent', lambda *a, **k: 1.0)
    monkeypatch.setattr(sched.psutil, 'virtual_memory',
                        lambda: SimpleNamespace(percent=2.0))

    execute_module._persist_failed_callback({'executionId': 'x'}, 'http://u')
    execute_module._persist_failed_callback({'executionId': 'y'}, 'http://u')
    # simulate one give-up so the file is dead-lettered
    class _DownClient:
        def __init__(self, *a, **k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *exc):
            return False
        async def post(self, url, json, headers):
            return _FakeResponse(503)
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _DownClient)
    for _ in range(execute_module.CALLBACK_FILE_MAX_RETRIES):
        asyncio.run(execute_module.retry_persisted_callbacks())

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=httpx.Response(
        200, request=httpx.Request('POST', 'http://test.com')))
    asyncio.run(sched._send_heartbeat(mock_client, 'test-token'))

    body = mock_client.post.call_args.kwargs['json']
    assert body['deadLetterCount'] == 2


def test_heartbeat_idle_reports_zero_dead_letter_count(monkeypatch):
    """Idle executor: deadLetterCount must still be present (never omitted),
    reporting 0 (the only forbidden shape is a missing field)."""
    import routers.execute  # noqa: F401
    from routers import execute as execute_module

    monkeypatch.setattr(sched.psutil, 'cpu_percent', lambda *a, **k: 1.0)
    monkeypatch.setattr(sched.psutil, 'virtual_memory',
                        lambda: SimpleNamespace(percent=2.0))

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=httpx.Response(
        200, request=httpx.Request('POST', 'http://test.com')))
    asyncio.run(sched._send_heartbeat(mock_client, 'test-token'))

    body = mock_client.post.call_args.kwargs['json']
    assert 'deadLetterCount' in body
    assert body['deadLetterCount'] == 0


def test_dead_letter_count_needs_no_invalidate_hook(monkeypatch, tmp_path):
    """QA9: _invalidate_dead_letter_count was dead code (defined, never
    called) and has been removed. The design needs no invalidate hook:
    every dead-letter move happens inside retry_persisted_callbacks, which
    refreshes the cache at the end of each sweep — so the heartbeat sees a
    fresh move immediately, without waiting for the TTL."""
    from routers import execute as execute_module

    assert not hasattr(execute_module, '_invalidate_dead_letter_count'), \
        'the dead-code invalidate helper must stay removed'

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    _patch_callback_env(monkeypatch)
    monkeypatch.setattr(execute_module, 'CALLBACK_REPLAY_BACKOFF_BASE_SECONDS', 0)

    class _DownClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            return _FakeResponse(503)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _DownClient)
    execute_module._persist_failed_callback(
        {'executionId': 'exec-invalidate'}, 'http://admin.local/api/executions/callback')
    for _ in range(execute_module.CALLBACK_FILE_MAX_RETRIES):
        asyncio.run(execute_module.retry_persisted_callbacks())

    # the sweep's end-of-pass refresh already tracks the move — no invalidate,
    # no TTL expiry required
    assert execute_module.get_dead_letter_count() == 1


def test_dead_letter_count_cache_serves_repeated_reads(monkeypatch):
    """The provider serves the sweep-maintained cache; a manual refresh only
    happens after the TTL expires (no directory scan per heartbeat)."""
    from routers import execute as execute_module
    import tempfile
    from pathlib import Path as _Path

    monkeypatch.setattr(execute_module.settings, 'work_dir', _Path(tempfile.mkdtemp(prefix='acf-cache-')))
    execute_module._refresh_dead_letter_count()
    assert execute_module.get_dead_letter_count() == 0
    # drop a file directly (bypassing the sweep) — cache must NOT see
    # it until the next sweep refresh or TTL expiry
    dl = execute_module._dead_letter_dir()
    (dl / 'callback-0-0.json').write_text('{}', encoding='utf-8')
    execute_module._dead_letter_count_cache[1] = (
        time.monotonic() + execute_module.DEAD_LETTER_COUNT_CACHE_TTL_SECONDS)  # future stamp
    assert execute_module.get_dead_letter_count() == 0
    # after the cache expires the count is recomputed
    execute_module._dead_letter_count_cache[1] = time.monotonic() - 10_000
    assert execute_module.get_dead_letter_count() == 1


# ---------------------------------------------------------------------------
# Background loop start/stop (drain)
# ---------------------------------------------------------------------------

def test_callback_retry_task_start_stop_drain(monkeypatch):
    """The loop starts once, replays in the background, and stop() drains it:
    the stop call resolves after the loop exited (node stopCallbackThread
    bounded-wait semantics)."""
    from routers import execute as execute_module
    import tempfile
    from pathlib import Path as _Path

    monkeypatch.setattr(execute_module.settings, 'work_dir', _Path(tempfile.mkdtemp(prefix='acf-loop-')))
    _patch_callback_env(monkeypatch)
    monkeypatch.setattr(execute_module, 'CALLBACK_RETRY_SWEEP_INTERVAL_SECONDS', 0.01)

    class _OkClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            return _FakeResponse(200)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _OkClient)
    payload_file = execute_module._persist_failed_callback(
        {'executionId': 'exec-loop'}, 'http://admin.local/api/executions/callback')

    async def scenario():
        execute_module.start_callback_retry_task()
        first = execute_module._callback_retry_task
        assert first is not None
        # idempotent start (node startCallbackThread re-entry guard)
        execute_module.start_callback_retry_task()
        assert execute_module._callback_retry_task is first

        deadline = time.monotonic() + 5
        while payload_file.exists() and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        assert not payload_file.exists(), 'background sweep must replay the payload'

        await execute_module.stop_callback_retry_task()
        assert execute_module._callback_retry_task is None
        assert first.done()

    asyncio.run(scenario())


def test_stop_callback_retry_task_without_start_is_noop():
    from routers import execute as execute_module
    # must not raise when the loop was never started
    asyncio.run(execute_module.stop_callback_retry_task())


def test_lifespan_starts_retry_task_and_drains_on_shutdown(monkeypatch):
    """main.py lifespan wiring: the retry loop starts on startup and the
    shutdown chain drains it (stop_callback_retry_task awaited)."""
    import main as main_module
    from routers import execute as execute_module

    monkeypatch.setattr(main_module, 'check_admin_api_connectivity', AsyncMock())
    monkeypatch.setattr(main_module, 'register_executor', AsyncMock())
    monkeypatch.setattr(main_module, 'notify_offline', AsyncMock())
    monkeypatch.setattr(main_module.execute, 'kill_running_task_processes',
                        AsyncMock(return_value=0))
    stop_drain = AsyncMock()
    monkeypatch.setattr(main_module.execute, 'stop_callback_retry_task', stop_drain)
    start = lambda: None  # real start touches the loop; assert ordering instead
    monkeypatch.setattr(main_module.execute, 'start_callback_retry_task', start)
    monkeypatch.setattr(main_module.maintenance, 'start_disk_cleanup_task', lambda: None)
    monkeypatch.setattr(main_module.maintenance, 'stop_disk_cleanup_task', lambda: None)

    async def scenario():
        async with main_module.lifespan(main_module.app):
            pass
        stop_drain.assert_awaited_once()

    asyncio.run(scenario())


# ── QA8: shutdown worker-flush window ─────────────────────────────────────────
# 树杀（kill_running_task_processes）只杀 OS 进程；_run_and_callback 协程要先
# 观察到子进程退出才会产出终态回调。停机序列若从树杀直接进 stop_callback_retry_task
# （只 drain 已落盘重放环）再退出，这些 live 回调既不投递也不落盘——执行在
# admin 侧只能等 stale sweep 修复，真实 killed/timeout 分类丢失。

def test_await_background_tasks_after_kill_waits_for_in_flight_worker():
    """树杀后登记在册的 worker 协程拿到有限窗口完成终态回调。"""
    from routers import execute as execute_module

    async def scenario():
        async def worker():
            await asyncio.sleep(0.01)
            return 'callback-sent'
        task = asyncio.create_task(worker())
        execute_module._background_tasks.add(task)
        task.add_done_callback(execute_module._background_tasks.discard)
        try:
            flushed = await execute_module.await_background_tasks_after_kill(timeout_seconds=2)
            assert flushed == 1
            assert task.done() and not task.cancelled()
        finally:
            execute_module._background_tasks.clear()

    asyncio.run(scenario())


def test_await_background_tasks_after_kill_cancels_pending_workers_when_window_expires():
    """窗口耗尽的 worker 被取消——载荷落盘由 _run_and_callback 的
    CancelledError 守卫负责，本函数只保证不无限阻塞停机。"""
    from routers import execute as execute_module

    async def scenario():
        async def stuck():
            await asyncio.sleep(1000)
        task = asyncio.create_task(stuck())
        execute_module._background_tasks.add(task)
        try:
            flushed = await execute_module.await_background_tasks_after_kill(timeout_seconds=0.05)
            assert flushed == 0
            assert task.cancelled()
        finally:
            execute_module._background_tasks.discard(task)

    asyncio.run(scenario())


def test_run_and_callback_persists_payload_when_send_cancelled(monkeypatch):
    """停机窗口耗尽取消 worker 时，终态载荷必须落盘（下个进程重放），
    而不是随进程一起消失。"""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    persisted = {}

    def fake_persist_giving_up(payload, url):
        persisted['payload'] = payload
        persisted['url'] = url

    async def cancelled_send(url, payload, token):
        raise asyncio.CancelledError()

    async def fake_run_task(req, entry=None):
        return {'success': True, 'logs': 'done', 'exitCode': 0, 'durationMs': 1}

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)
    monkeypatch.setattr(execute_module, '_send_callback_with_retry', cancelled_send)
    monkeypatch.setattr(execute_module, '_persist_giving_up', fake_persist_giving_up)
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'dynamic-token')
    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')
    monkeypatch.setattr(execute_module.settings, 'executor_address_public', 'public-executor:9000')
    monkeypatch.setattr(execute_module, 'get_current_token', AsyncMock(return_value=None))

    req = ExecuteRequest(
        executionId='exec-cancelled-callback',
        task={'name': 'noop', 'runtime': 'python'},
    )

    async def scenario():
        with pytest.raises(asyncio.CancelledError):
            await execute_module._run_and_callback(req)

    asyncio.run(scenario())

    assert persisted['payload']['executionId'] == 'exec-cancelled-callback'
    assert persisted['payload']['status'] == 'success'
    assert persisted['url'].endswith('/executions/callback')


def test_lifespan_flushes_workers_between_kill_and_drain(monkeypatch):
    """QA8 顺序钉死：树杀 → worker flush → 回调 drain。"""
    import main as main_module
    from routers import execute as execute_module

    order = []
    monkeypatch.setattr(main_module, 'check_admin_api_connectivity', AsyncMock())
    monkeypatch.setattr(main_module, 'register_executor', AsyncMock())
    monkeypatch.setattr(main_module, 'notify_offline', AsyncMock())

    async def fake_kill():
        order.append('kill')
        return 0

    async def fake_flush():
        order.append('flush')
        return 0

    async def fake_drain():
        order.append('drain')

    monkeypatch.setattr(main_module.execute, 'kill_running_task_processes', fake_kill)
    monkeypatch.setattr(main_module.execute, 'await_background_tasks_after_kill', fake_flush)
    monkeypatch.setattr(main_module.execute, 'stop_callback_retry_task', fake_drain)
    monkeypatch.setattr(main_module.execute, 'start_callback_retry_task', lambda: None)
    monkeypatch.setattr(main_module.maintenance, 'start_disk_cleanup_task', lambda: None)
    monkeypatch.setattr(main_module.maintenance, 'stop_disk_cleanup_task', lambda: None)

    async def scenario():
        async with main_module.lifespan(main_module.app):
            pass
        assert order == ['kill', 'flush', 'drain']

    asyncio.run(scenario())
