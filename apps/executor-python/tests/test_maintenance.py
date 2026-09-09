"""Tests for E8 (disk TTL reclamation).

CONSISTENCY round port of executor-node file-logger.ts cleanupWorkDir /
startWorkDirCleanup:

- execution workdirs (with their embedded logs), .git_cache and .venvs
  entries past the TTL are removed
- infrastructure names (callbacks, caches, venvs root) are protected
- directories backing a currently-live execution / task are always skipped
  (registry lookup through the registered provider)
- the sweep task defers its first run (boot-storm guard) and the app
  lifespan starts/stops it
"""
import asyncio
import os
import time
from unittest.mock import AsyncMock

import pytest

from config import settings


def _age(path, days=10.0):
    stamp = time.time() - days * 24 * 60 * 60
    os.utime(path, (stamp, stamp))


@pytest.fixture()
def work_root(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'work_dir', str(tmp_path))
    return tmp_path


# ---------------------------------------------------------------------------
# TTL cleanup
# ---------------------------------------------------------------------------

def test_cleanup_removes_stale_workdirs_and_caches(work_root):
    import maintenance

    stale = work_root / 'exec-stale'
    stale.mkdir()
    (stale / 'exec-stale.log').write_text('old run output')
    _age(stale)

    fresh = work_root / 'exec-fresh'
    fresh.mkdir()

    cache_old = work_root / '.git_cache' / 'repo-old'
    cache_old.mkdir(parents=True)
    _age(cache_old)
    cache_fresh = work_root / '.git_cache' / 'repo-fresh'
    cache_fresh.mkdir(parents=True)

    venv_old = work_root / '.venvs' / 'task-old'
    venv_old.mkdir(parents=True)
    _age(venv_old)
    venv_fresh = work_root / '.venvs' / 'task-fresh'
    venv_fresh.mkdir(parents=True)

    counts = maintenance.cleanup_work_dir(ttl_days=7)

    assert not stale.exists()
    assert fresh.exists()
    assert not cache_old.exists()
    assert cache_fresh.exists()
    assert not venv_old.exists()
    assert venv_fresh.exists()
    assert counts == {'workDirs': 1, 'caches': 1, 'venvs': 1, 'deadLetters': 0}


def test_cleanup_protects_infrastructure_names(work_root):
    import maintenance

    for name in ('callbacks', '.git_cache', '.venvs', 'logs', 'meta'):
        (work_root / name).mkdir()
        _age(work_root / name)

    maintenance.cleanup_work_dir(ttl_days=1)

    for name in ('callbacks', '.git_cache', '.venvs', 'logs', 'meta'):
        assert (work_root / name).exists(), f'{name} must never be swept'


def test_cleanup_skips_active_execution_workdir(work_root):
    """E8 hard requirement: the directory of a live execution is never
    deleted, no matter how old its mtime is."""
    import maintenance
    from routers import execute as execute_module

    live_dir = work_root / 'exec-live'
    live_dir.mkdir()
    _age(live_dir, days=30)

    entry = execute_module.register_live_execution('exec-live')
    try:
        maintenance.cleanup_work_dir(ttl_days=7)
        assert live_dir.exists(), 'live execution workdir must be protected'
    finally:
        execute_module.unregister_live_execution('exec-live')

    maintenance.cleanup_work_dir(ttl_days=7)
    assert not live_dir.exists(), 'once terminal, the TTL sweep reclaims it'


def test_cleanup_skips_active_task_venv(work_root):
    """A long-running task's .venvs/<task_id> is protected via the live
    entry's task_id (the venv dir is not named by executionId)."""
    import maintenance
    from routers import execute as execute_module

    venv_dir = work_root / '.venvs' / 'task-live'
    venv_dir.mkdir(parents=True)
    _age(venv_dir, days=30)

    entry = execute_module.register_live_execution('exec-venv-live')
    entry.task_id = 'task-live'
    try:
        maintenance.cleanup_work_dir(ttl_days=7)
        assert venv_dir.exists(), 'live task venv must be protected'
    finally:
        execute_module.unregister_live_execution('exec-venv-live')


def test_cleanup_provider_failure_removes_nothing(work_root, monkeypatch):
    """If the liveness provider fails, deletions must be skipped entirely —
    never guess which directory might be live."""
    import maintenance

    stale = work_root / 'exec-stale'
    stale.mkdir()
    _age(stale)

    def broken_provider():
        raise RuntimeError('registry unavailable')

    maintenance.register_live_entries_provider(broken_provider)
    try:
        counts = maintenance.cleanup_work_dir(ttl_days=7)
    finally:
        maintenance.register_live_entries_provider(lambda: [])

    assert stale.exists()
    assert counts == {'workDirs': 0, 'caches': 0, 'venvs': 0, 'deadLetters': 0}


# ---------------------------------------------------------------------------
# QA3: dead-letter TTL reclamation (node cleanupWorkDir step 4 filesOnly)
# ---------------------------------------------------------------------------

def _dead_letter(work_root, name, age_days=None):
    dl = work_root / 'callbacks' / 'dead-letter'
    dl.mkdir(parents=True, exist_ok=True)
    f = dl / name
    f.write_text('{}')
    if age_days is not None:
        _age(f, days=age_days)
    return f


def test_cleanup_reclaims_expired_dead_letter_pair(work_root):
    """Dead-lettered payloads used to be immortal: 'callbacks' is protected,
    so nothing ever swept callbacks/dead-letter/. An expired payload json and
    its companion .meta must now be reclaimed together, fresh files kept."""
    import maintenance

    old_json = _dead_letter(work_root, 'callback-1000-0.json', age_days=10)
    old_meta = _dead_letter(work_root, 'callback-1000-0.json.meta', age_days=10)
    fresh_json = _dead_letter(work_root, 'callback-2000-0.json')
    fresh_meta = _dead_letter(work_root, 'callback-2000-0.json.meta')

    counts = maintenance.cleanup_work_dir(ttl_days=7)

    assert not old_json.exists()
    assert not old_meta.exists()
    assert fresh_json.exists()
    assert fresh_meta.exists()
    assert counts['deadLetters'] == 2


def test_cleanup_dead_letter_json_sweep_takes_fresh_meta(work_root):
    """The pair is garbage once the payload is reaped: an expired json takes
    its companion .meta with it even when the meta's own mtime is fresh."""
    import maintenance

    old_json = _dead_letter(work_root, 'callback-3000-0.json', age_days=10)
    fresh_meta = _dead_letter(work_root, 'callback-3000-0.json.meta')

    counts = maintenance.cleanup_work_dir(ttl_days=7)

    assert not old_json.exists()
    assert not fresh_meta.exists()
    assert counts['deadLetters'] == 2


def test_cleanup_dead_letter_keeps_meta_of_fresh_json(work_root):
    """An aged .meta whose companion json is still within the TTL is left
    alone — the json's own future sweep reclaims the pair."""
    import maintenance

    fresh_json = _dead_letter(work_root, 'callback-4000-0.json')
    old_meta = _dead_letter(work_root, 'callback-4000-0.json.meta', age_days=10)

    counts = maintenance.cleanup_work_dir(ttl_days=7)

    assert fresh_json.exists()
    assert old_meta.exists()
    assert counts['deadLetters'] == 0


def test_cleanup_dead_letter_removes_orphan_meta(work_root):
    """An aged .meta with no companion json (a dead-lettering unlink that
    raced/failed) is reclaimed on its own."""
    import maintenance

    orphan = _dead_letter(work_root, 'callback-5000-0.json.meta', age_days=10)

    counts = maintenance.cleanup_work_dir(ttl_days=7)

    assert not orphan.exists()
    assert counts['deadLetters'] == 1


def test_cleanup_dead_letter_ignores_stray_subdirectory(work_root):
    """filesOnly parity (node E12): a stray subdirectory under dead-letter/
    is neither counted nor recursively removed — only regular files are."""
    import maintenance

    stray = work_root / 'callbacks' / 'dead-letter' / 'not-a-payload'
    stray.mkdir(parents=True)
    (stray / 'inner.json').write_text('{}')
    _age(stray, days=10)

    counts = maintenance.cleanup_work_dir(ttl_days=7)

    assert stray.exists()
    assert (stray / 'inner.json').exists()
    assert counts['deadLetters'] == 0


def test_cleanup_protects_inflight_retry_files_in_callbacks_root(work_root):
    """The callbacks/ top level stays out of the TTL sweep: in-flight retry
    payloads and their metas are owned by the E2 replay loop, not by E8."""
    import maintenance

    cb = work_root / 'callbacks'
    cb.mkdir(parents=True)
    payload = cb / 'callback-6000-0.json'
    payload.write_text('{"url": "http://x", "payloads": []}')
    meta = cb / 'callback-6000-0.json.meta'
    meta.write_text('{"retries": 1}')
    _age(payload)
    _age(meta)

    counts = maintenance.cleanup_work_dir(ttl_days=1)

    assert payload.exists()
    assert meta.exists()
    assert counts['deadLetters'] == 0


def test_cleanup_dead_letter_missing_dir_is_noop(work_root):
    """A work_dir that never dead-lettered anything has no callbacks/
    directory at all — the sweep must simply report 0."""
    import maintenance

    counts = maintenance.cleanup_work_dir(ttl_days=7)
    assert counts['deadLetters'] == 0


# ---------------------------------------------------------------------------
# Background sweep task + lifespan wiring
# ---------------------------------------------------------------------------

def test_disk_cleanup_task_defers_first_run(work_root, monkeypatch):
    """E8 boot-storm guard: the first sweep runs only after the configured
    delay, then repeats on the interval."""
    import maintenance

    monkeypatch.setattr(settings, 'disk_cleanup_initial_delay_seconds', 0.05)
    monkeypatch.setattr(settings, 'disk_cleanup_interval_seconds', 0.05)

    sweeps = []

    def fake_cleanup(ttl_days=None):
        sweeps.append(time.monotonic())
        return {'workDirs': 0, 'caches': 0, 'venvs': 0}

    monkeypatch.setattr(maintenance, 'cleanup_work_dir', fake_cleanup)

    async def scenario():
        task = asyncio.create_task(maintenance.disk_cleanup_task())
        await asyncio.sleep(0.02)
        assert sweeps == [], 'first sweep must wait for the initial delay'
        await asyncio.sleep(0.15)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert len(sweeps) >= 2, 'sweep must repeat on the interval'


def test_disk_cleanup_task_survives_sweep_errors(work_root, monkeypatch):
    import maintenance

    monkeypatch.setattr(settings, 'disk_cleanup_initial_delay_seconds', 0)
    monkeypatch.setattr(settings, 'disk_cleanup_interval_seconds', 0.05)

    calls = {'n': 0}

    def flaky_cleanup(ttl_days=None):
        calls['n'] += 1
        if calls['n'] == 1:
            raise RuntimeError('boom')
        return {'workDirs': 0, 'caches': 0, 'venvs': 0}

    monkeypatch.setattr(maintenance, 'cleanup_work_dir', flaky_cleanup)

    async def scenario():
        task = asyncio.create_task(maintenance.disk_cleanup_task())
        await asyncio.sleep(0.15)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert calls['n'] >= 2, 'the loop must keep sweeping after an error'


def test_disk_cleanup_task_runs_sweep_off_the_event_loop(work_root, monkeypatch):
    """QA2: cleanup_work_dir is blocking filesystem I/O (a large rmtree can
    take seconds) — the sweep task must run it in a worker thread, not on
    the event loop, or heartbeats stall and the executor can be judged
    offline mid-delete."""
    import threading

    import maintenance

    monkeypatch.setattr(settings, 'disk_cleanup_initial_delay_seconds', 0)
    monkeypatch.setattr(settings, 'disk_cleanup_interval_seconds', 0.05)

    main_thread = threading.current_thread()
    seen = {}
    ticks = {'n': 0}

    def fake_cleanup(ttl_days=None):
        seen['thread'] = threading.current_thread()
        time.sleep(0.2)  # simulate a slow recursive delete
        return {'workDirs': 0, 'caches': 0, 'venvs': 0, 'deadLetters': 0}

    monkeypatch.setattr(maintenance, 'cleanup_work_dir', fake_cleanup)

    async def scenario():
        sweep = asyncio.create_task(maintenance.disk_cleanup_task())

        async def ticker():
            while True:
                await asyncio.sleep(0.02)
                ticks['n'] += 1

        t = asyncio.create_task(ticker())
        await asyncio.sleep(0.3)
        t.cancel()
        sweep.cancel()
        with pytest.raises(asyncio.CancelledError):
            await sweep

    asyncio.run(scenario())
    assert 'thread' in seen, 'the sweep must have run'
    assert seen['thread'] is not main_thread, \
        'cleanup_work_dir must execute off the event loop thread'
    assert ticks['n'] >= 5, 'the loop must keep ticking during the sweep'


def test_start_disk_cleanup_task_is_idempotent(work_root):
    import maintenance

    async def scenario():
        maintenance.start_disk_cleanup_task()
        first = maintenance._cleanup_task
        maintenance.start_disk_cleanup_task()
        assert maintenance._cleanup_task is first
        maintenance.stop_disk_cleanup_task()
        await asyncio.sleep(0.01)
        assert first.done()

    asyncio.run(scenario())


def test_lifespan_starts_and_stops_disk_cleanup(monkeypatch, work_root):
    """main.py lifespan: the cleanup provider is registered against the
    execute registry (live view, not a snapshot copy), the task starts on
    startup and is stopped on shutdown."""
    import main as main_module
    import maintenance
    from routers import execute as execute_module

    monkeypatch.setattr(main_module, 'check_admin_api_connectivity', AsyncMock())
    monkeypatch.setattr(main_module, 'register_executor', AsyncMock())
    monkeypatch.setattr(main_module, 'notify_offline', AsyncMock())
    monkeypatch.setattr(main_module.execute, 'kill_running_task_processes',
                        AsyncMock(return_value=0))
    # neutralize the E2 wiring (covered in test_callback_persistence.py)
    monkeypatch.setattr(execute_module, 'start_callback_retry_task', lambda: None)
    monkeypatch.setattr(execute_module, 'stop_callback_retry_task', AsyncMock())

    started = {}

    async def _park():
        await asyncio.sleep(3600)

    def fake_start():
        started['task'] = asyncio.create_task(_park())

    def fake_stop():
        # matches the sync stop_disk_cleanup_task signature main.py calls
        task = started.get('task')
        if task is not None:
            task.cancel()

    monkeypatch.setattr(maintenance, 'start_disk_cleanup_task', fake_start)
    monkeypatch.setattr(maintenance, 'stop_disk_cleanup_task', fake_stop)

    entry = execute_module.register_live_execution('exec-provider-check')
    entry.task_id = 'task-provider-check'
    try:
        async def scenario():
            async with main_module.lifespan(main_module.app):
                # provider wiring happened during startup; it must be a LIVE
                # view of the execute registry (protects in-flight executions)
                names = {
                    getattr(e, 'execution_id', None)
                    for e in maintenance._live_entries_provider()
                }
                assert names == {'exec-provider-check'}
                tasks = {
                    getattr(e, 'task_id', None)
                    for e in maintenance._live_entries_provider()
                }
                assert 'task-provider-check' in tasks
            await asyncio.sleep(0.01)  # let the cancellation land
            assert started['task'].done()

        asyncio.run(scenario())
    finally:
        execute_module.unregister_live_execution('exec-provider-check')
