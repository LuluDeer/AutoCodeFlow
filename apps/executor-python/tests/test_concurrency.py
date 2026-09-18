"""Tests for E6 (concurrency protection).

CONSISTENCY round port of executor-node semantics:

- same-task executions serialize on a per-task lock (task-worker.ts
  maxConcurrentPerTask=1: the second execution of a task queues on the lock
  instead of concurrently racing prepare/venv/run)
- the lock map is event-loop local (an asyncio.Lock binds to its first
  awaiting loop — a module-level singleton would break the per-test
  asyncio.run loops the suite uses, the same reason the live-execution
  registry uses threading.Lock)
- git_checkout_to serializes the clone/fetch phase per shared cache dir
  (routes/execute.ts gitCacheQueues parity)
"""
import asyncio
import subprocess
import threading
import time
from unittest.mock import AsyncMock

import pytest

from routers.execute import ExecuteRequest


def _patch_callback_env(monkeypatch, tmp_path):
    """Isolate the terminal-callback send path (same shape as the helper in
    test_execute.py / test_callback_persistence.py)."""
    from routers import execute as execute_module
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'tok')
    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')
    monkeypatch.setattr(execute_module.settings, 'executor_address_public', 'pub:9000')
    monkeypatch.setattr(execute_module, 'get_current_token', AsyncMock(return_value=None))


class _OkClient:
    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json, headers):
        from types import SimpleNamespace
        return SimpleNamespace(status_code=200)


# ---------------------------------------------------------------------------
# Same-task serialization (node maxConcurrentPerTask=1)
# ---------------------------------------------------------------------------

def test_same_task_executions_run_serialized(monkeypatch, tmp_path):
    """Two executions of the SAME task id must not overlap: the second queues
    on the per-task lock until the first leaves run_task."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _OkClient)
    _patch_callback_env(monkeypatch, tmp_path)

    events = []
    active = {'count': 0, 'peak': 0}

    async def fake_run_task(req, entry=None):
        active['count'] += 1
        active['peak'] = max(active['peak'], active['count'])
        events.append(('start', req.executionId))
        await asyncio.sleep(0.05)
        events.append(('end', req.executionId))
        active['count'] -= 1
        return {'success': True, 'logs': '', 'exitCode': 0, 'durationMs': 1}

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)

    async def scenario():
        first = ExecuteRequest(executionId='exec-serial-a', task={'id': 'task-same', 'name': 'n'})
        second = ExecuteRequest(executionId='exec-serial-b', task={'id': 'task-same', 'name': 'n'})
        await asyncio.gather(
            execute_module._run_and_callback(first),
            execute_module._run_and_callback(second),
        )

    asyncio.run(scenario())

    assert active['peak'] == 1, 'same-task executions must never overlap'
    assert events == [
        ('start', 'exec-serial-a'), ('end', 'exec-serial-a'),
        ('start', 'exec-serial-b'), ('end', 'exec-serial-b'),
    ]


def test_different_task_executions_run_concurrently(monkeypatch, tmp_path):
    """Distinct task ids must NOT serialize (node: one worker per taskId)."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _OkClient)
    _patch_callback_env(monkeypatch, tmp_path)

    active = {'count': 0, 'peak': 0}
    both_running = asyncio.Event()

    async def fake_run_task(req, entry=None):
        active['count'] += 1
        active['peak'] = max(active['peak'], active['count'])
        if active['count'] == 2:
            both_running.set()
        # O-4（审计优化）：原 timeout=5——并发不成立（两个任务串行）时第二个任务
        # 永远等不到 both_running.set()，5s 后 wait_for 抛 TimeoutError，以超时
        # 而非断言失败收场，失败信号不清晰；且高负载 CI 上 5s 也可能不够。
        # 降至 2s：两个协程在同一事件循环里交错（互不 await 阻塞），2s 对任何
        # 正常调度都绰绰有余；真串行时 2s 即红，错误类型仍可读。
        await asyncio.wait_for(both_running.wait(), timeout=2)
        active['count'] -= 1
        return {'success': True, 'logs': '', 'exitCode': 0, 'durationMs': 1}

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)

    async def scenario():
        first = ExecuteRequest(executionId='exec-par-a', task={'id': 'task-x', 'name': 'n'})
        second = ExecuteRequest(executionId='exec-par-b', task={'id': 'task-y', 'name': 'n'})
        await asyncio.gather(
            execute_module._run_and_callback(first),
            execute_module._run_and_callback(second),
        )

    asyncio.run(scenario())
    assert active['peak'] == 2


def test_task_lock_map_is_event_loop_local():
    """asyncio.Lock binds to its first awaiting loop; the map must hand out
    fresh locks per running loop (no RuntimeError on the second asyncio.run)
    while keeping lock identity stable within one loop."""
    from routers import execute as execute_module

    async def grab():
        same_1 = execute_module._get_task_lock('lock-task')
        same_2 = execute_module._get_task_lock('lock-task')
        other = execute_module._get_task_lock('other-task')
        return same_1, same_2, other

    a, b, c = asyncio.run(grab())
    assert a is b, 'same task id on one loop -> same lock'
    assert a is not c, 'different task ids -> different locks'

    # a fresh loop (new asyncio.run) must not blow up on stale bound locks
    d, e, _ = asyncio.run(grab())
    assert d is not a


def test_task_lock_map_bounded_by_distinct_task_ids_and_reset_per_loop():
    """E-4（审计补漏）：锁表规模随不同 task_id 增长、换循环整体重置。

    现状：`_task_locks` 按 task_id 无上限增长（无逐条淘汰），唯一边界是
    **事件循环切换时整体重建**（asyncio.Lock 绑定首个 await 它的循环）。
    本用例把这两个行为钉死：1000 个不同 task_id → 恰好 1000 把锁（互不共享，
    正确性不变量）；换一个新循环 → 表整体清空（当前唯一的内存回收边界）。
    若未来为长生命周期循环引入逐条淘汰，此用例的规模断言需同步更新——
    这正是把它钉在这里的目的。
    """
    from routers import execute as execute_module

    async def touch_many():
        locks = [execute_module._get_task_lock(f'task-{i}') for i in range(1000)]
        return locks

    locks = asyncio.run(touch_many())
    assert len(set(locks)) == 1000, '不同 task_id 必须各有一把独立锁（互不共享）'

    # 同一循环内重复取同一 task_id → 同一把锁（test_task_lock_map_is_event_loop_local
    # 已覆盖身份稳定性）；此处补"换循环即重置"的规模边界：
    fresh = asyncio.run(touch_many())
    assert execute_module._task_locks_loop is not None
    # 新循环里首次 _get_task_lock 会把表重置为空再填充——因此两个循环的表互不相干
    assert len(execute_module._task_locks) == 1000
    assert any(lock is not fresh[0] for lock in locks), \
        '换循环后必须拿到全新锁对象（旧循环的锁不可复用）'


# ---------------------------------------------------------------------------
# QA4: one task-key derivation for lock / E8 protection / .venvs directory
# ---------------------------------------------------------------------------

def test_derive_task_key_fallbacks():
    """_derive_task_key is the single source of truth: empty-string / None /
    missing id fall back to executionId; non-string ids are stringified; a
    malformed (non-dict / None) task payload never crashes."""
    from types import SimpleNamespace

    from routers import execute as execute_module

    def req(task):
        return ExecuteRequest(executionId='exec-42', task=task)

    assert execute_module._derive_task_key(req({'id': 'task-a'})) == 'task-a'
    assert execute_module._derive_task_key(req({'id': ''})) == 'exec-42'
    assert execute_module._derive_task_key(req({'id': None})) == 'exec-42'
    assert execute_module._derive_task_key(req({})) == 'exec-42'
    assert execute_module._derive_task_key(req({'id': 7})) == '7'
    # defensive: request objects without a usable dict task
    assert execute_module._derive_task_key(
        SimpleNamespace(task=None, executionId='exec-9')) == 'exec-9'
    assert execute_module._derive_task_key(
        SimpleNamespace(task='oops', executionId='exec-9')) == 'exec-9'


def test_empty_task_id_lock_and_venv_share_execution_id_key(monkeypatch, tmp_path):
    """QA4 regression: with task.id an empty string the E6 lock key, the E8
    live-protection task_id and the .venvs/<id> directory must all be the
    same derived value (executionId). Previously the venv path used the
    merged ``task.get('id', executionId)`` verbatim — '' collapsed it onto
    the .venvs root itself while the lock keyed off executionId."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _OkClient)
    _patch_callback_env(monkeypatch, tmp_path)

    lock_keys = []
    real_get_lock = execute_module._get_task_lock

    def spy_get_lock(task_id):
        lock_keys.append(task_id)
        return real_get_lock(task_id)

    monkeypatch.setattr(execute_module, '_get_task_lock', spy_get_lock)

    venv_dirs = []

    async def fake_ensure_venv(venv_dir, requirements, *, python_version=None):
        venv_dirs.append(venv_dir)
        raise RuntimeError('stop here: venv dir resolution verified')

    monkeypatch.setattr(execute_module, 'ensure_venv', fake_ensure_venv)

    entry = execute_module.register_live_execution('exec-empty-task-id')
    assert entry is not None
    asyncio.run(execute_module._run_and_callback(
        ExecuteRequest(executionId='exec-empty-task-id',
                       task={'id': '', 'runtime': 'python',
                             'requirements': ['some-pkg']})))

    assert lock_keys == ['exec-empty-task-id']
    assert entry.task_id == 'exec-empty-task-id'
    assert venv_dirs == [tmp_path / '.venvs' / 'exec-empty-task-id']
    assert not execute_module.execution_exists('exec-empty-task-id')


def test_venv_dir_ignores_manifest_only_task_id(monkeypatch, tmp_path):
    """QA4: the venv name follows the request-level derivation, never the
    manifest-merged id — otherwise the E8 live protection (keyed off
    entry.task_id, request-level) would guard a different directory than
    the one being written."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    wd = tmp_path / 'exec-mfest'
    wd.mkdir()
    (wd / 'manifest.yaml').write_text(
        'id: manifest-task\nrequirements: ["some-pkg"]\n', encoding='utf-8')

    venv_dirs = []

    async def fake_ensure_venv(venv_dir, requirements, *, python_version=None):
        venv_dirs.append(venv_dir)
        raise RuntimeError('stop here')

    monkeypatch.setattr(execute_module, 'ensure_venv', fake_ensure_venv)

    req = ExecuteRequest(executionId='exec-mfest', task={'runtime': 'python'})
    with pytest.raises(RuntimeError):
        asyncio.run(execute_module.run_task(req))

    assert venv_dirs == [tmp_path / '.venvs' / 'exec-mfest']


# ---------------------------------------------------------------------------
# Git cache per-repo lock (node gitCacheQueues)
# ---------------------------------------------------------------------------

def test_git_cache_lock_identity_per_repo():
    from routers import execute as execute_module

    a1 = execute_module._get_git_cache_lock('repo-a')
    a2 = execute_module._get_git_cache_lock('repo-a')
    b = execute_module._get_git_cache_lock('repo-b')
    assert a1 is a2
    assert a1 is not b


def test_git_checkout_to_serializes_same_repo(tmp_path, monkeypatch):
    """Concurrent checkouts of the same repo must not interleave their
    clone/fetch calls against the shared cache directory."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))

    state = {'active': 0, 'peak': 0, 'overlap': False}
    guard = threading.Lock()

    def fake_run(cmd, **kwargs):
        with guard:
            state['active'] += 1
            if state['active'] > state['peak']:
                state['peak'] = state['active']
            if state['active'] > 1:
                state['overlap'] = True
        time.sleep(0.05)
        with guard:
            state['active'] -= 1
        return subprocess.CompletedProcess(cmd, 0, b'', b'')

    monkeypatch.setattr(execute_module.subprocess, 'run', fake_run)

    url = 'https://example.com/org/serial-repo.git'
    errors = []

    def worker():
        try:
            execute_module.git_checkout_to(url, 'main', tmp_path / f'dest-{threading.get_ident()}')
        except Exception as exc:  # pragma: no cover - surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert errors == []
    assert state['overlap'] is False, 'clone/fetch calls must be serialized per repo'
    assert state['peak'] == 1


def test_git_checkout_to_different_repos_use_distinct_locks(tmp_path, monkeypatch):
    """Per-repo granularity: distinct repos map to distinct locks, so one
    repo's clone cannot block another repo's checkout."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))

    lock_a = execute_module._get_git_cache_lock(
        str(tmp_path / '.git_cache' / execute_module._repo_dir_name('https://example.com/a.git')))
    lock_b = execute_module._get_git_cache_lock(
        str(tmp_path / '.git_cache' / execute_module._repo_dir_name('https://example.com/b.git')))
    assert lock_a is not lock_b
    assert lock_a.acquire(blocking=False), 'a starts unlocked'
    assert lock_b.acquire(blocking=False), 'holding a must not block b (per-repo locks)'
    lock_a.release()
    lock_b.release()
