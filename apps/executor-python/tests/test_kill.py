"""Tests for E4 (execution kill endpoint) and E5 (shutdown process-tree kill).

CONSISTENCY round port of executor-node 改动1 + main.ts
killRunningTaskProcesses:

- POST /api/executions/{executionId}/kill — admin's killExecution previously
  only flipped the DB row; the task kept running on the executor. Contract
  (task.service.ts notifyExecutorKill): POST api/executions/:id/kill with the
  shared token, 3s timeout; node answers 200 {ok:true} / 404 {ok:false}.
- Shutdown must tree-kill task processes that outlive the grace period
  instead of orphaning them (Windows taskkill /T /F, POSIX killpg — the same
  platform branches as the timeout path).
"""
import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import scheduler as sched


# ---------------------------------------------------------------------------
# E4: POST /api/executions/{executionId}/kill
# ---------------------------------------------------------------------------

def test_kill_unknown_execution_returns_404(auth_client):
    """Not in the live registry (never accepted / already terminal) →
    404 {ok:false}, node-for-node."""
    from routers import execute as execute_module  # noqa: F401 (import = wiring)

    response = auth_client.post('/api/executions/exec-never-accepted/kill')
    assert response.status_code == 404
    assert response.json() == {'ok': False}


def test_kill_requires_auth(client):
    """Same verify_token middleware as the other python /api routes."""
    response = client.post('/api/executions/exec-x/kill')
    assert response.status_code == 401


def test_kill_queued_execution_cancels_pushes_killed_callback_and_unregisters(
        auth_client, monkeypatch):
    """E4: kill before spawn → 摘除 + 置 cancelled + exactly one terminal
    killed callback (failureReason=killed); response {ok:true}."""
    from routers import execute as execute_module

    posted = []

    class RecordingClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            # the verify_token dependency may fire a /executors/token fetch
            # through the same patched client — record callbacks only
            if 'callback' in url:
                posted.append({'url': url, 'json': json, 'headers': headers})
            return SimpleNamespace(status_code=200)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', RecordingClient)
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'tok')
    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')
    monkeypatch.setattr(execute_module.settings, 'executor_address_public', 'pub:9000')
    monkeypatch.setattr(execute_module, 'get_current_token', AsyncMock(return_value=None))

    entry = execute_module.register_live_execution('exec-queued-kill')
    response = auth_client.post('/api/executions/exec-queued-kill/kill')
    assert response.status_code == 200
    assert response.json() == {'ok': True}
    assert entry.cancelled and entry.killed_by_request
    assert entry.killed_callback_pushed
    assert not execute_module.execution_exists('exec-queued-kill')
    # second kill for the same id: already gone from the registry → 404
    assert auth_client.post('/api/executions/exec-queued-kill/kill').status_code == 404

    # the killed callback is pushed from a background task — wait for it
    deadline = time.time() + 5
    while not posted and time.time() < deadline:
        time.sleep(0.05)
    assert posted, 'killed callback was never sent'
    assert posted[0]['url'] == 'http://admin.local/api/executions/callback'
    payload = posted[0]['json'][0]
    assert payload['executionId'] == 'exec-queued-kill'
    assert payload['status'] == 'failed'
    assert payload['failureReason'] == 'killed'
    assert 'killed by admin request' in payload['errorMessage'].lower()


def test_kill_running_execution_tree_kills_process(auth_client, monkeypatch):
    """E4: kill while a process is live → the platform tree-kill utility is
    invoked; the terminal callback stays owned by _run_and_callback (which
    marks failureReason=killed), so the endpoint does NOT push one itself and
    the registry entry survives until that path completes (node parity:
    close event → runTask failure path)."""
    from routers import execute as execute_module

    entry = execute_module.register_live_execution('exec-running-kill')
    fake_proc = SimpleNamespace(pid=4321)
    entry.proc = fake_proc

    kill_mock = AsyncMock()
    monkeypatch.setattr(execute_module, '_kill_process_tree', kill_mock)

    response = auth_client.post('/api/executions/exec-running-kill/kill')
    assert response.status_code == 200
    assert response.json() == {'ok': True}
    kill_mock.assert_awaited_once_with(fake_proc)
    assert entry.killed_by_request and entry.cancelled
    assert not entry.killed_callback_pushed
    assert execute_module.execution_exists('exec-running-kill')


def test_run_and_callback_marks_killed_by_request(monkeypatch):
    """E4 (node runTask parity): after a running-kill the failure callback is
    re-labelled failureReason=killed with the canonical message."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    posted = []

    async def fake_run_task(req, entry=None):
        return {'success': False, 'logs': '', 'exitCode': -9,
                'errorMessage': 'Process exited with code -9', 'durationMs': 3}

    class RecordingClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            posted.append(json)
            return SimpleNamespace(status_code=200)

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', RecordingClient)
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'tok')
    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')
    monkeypatch.setattr(execute_module.settings, 'executor_address_public', 'pub:9000')
    monkeypatch.setattr(execute_module, 'get_current_token', AsyncMock(return_value=None))

    entry = execute_module.register_live_execution('exec-killed-run')
    entry.killed_by_request = True
    original = sched.running_count
    sched.running_count = 1
    try:
        asyncio.run(execute_module._run_and_callback(
            ExecuteRequest(executionId='exec-killed-run', task={'name': 'n'}), entry))
    finally:
        sched.running_count = original

    payload = posted[0][0]
    assert payload['status'] == 'failed'
    assert payload['failureReason'] == 'killed'
    assert payload['errorMessage'] == 'Task process tree killed by admin request'
    assert not execute_module.execution_exists('exec-killed-run')


def test_run_and_callback_skips_callback_when_kill_already_pushed(monkeypatch):
    """E4 double-callback guard: the queued-kill path already pushed the
    terminal killed callback; the background flow must stay silent (and still
    release its registry entry)."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    posts = []

    async def fake_run_task(req, entry=None):
        return {'success': False, 'logs': '', 'exitCode': None,
                'errorMessage': 'Execution killed by admin request', 'durationMs': 1}

    class RecordingClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            posts.append(json)
            return SimpleNamespace(status_code=200)

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', RecordingClient)
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'tok')
    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')
    monkeypatch.setattr(execute_module.settings, 'executor_address_public', 'pub:9000')
    monkeypatch.setattr(execute_module, 'get_current_token', AsyncMock(return_value=None))

    entry = execute_module.register_live_execution('exec-skip')
    entry.cancelled = True
    entry.killed_callback_pushed = True
    original = sched.running_count
    sched.running_count = 1
    try:
        asyncio.run(execute_module._run_and_callback(
            ExecuteRequest(executionId='exec-skip', task={'name': 'n'}), entry))
    finally:
        sched.running_count = original

    assert posts == []
    assert not execute_module.execution_exists('exec-skip')


def test_run_task_cancelled_entry_skips_spawn(tmp_path, monkeypatch):
    """E4: a kill that lands before the background flow starts makes run_task
    bail at the entry checkpoint — no task process is ever started."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))

    async def fail_spawn(*args, **kwargs):
        raise AssertionError('no subprocess may be spawned for a cancelled execution')

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fail_spawn)

    entry = execute_module.register_live_execution('exec-cancelled-prepare')
    entry.cancelled = True
    req = ExecuteRequest(
        executionId='exec-cancelled-prepare',
        task={'name': 't', 'runtime': 'python', 'entrypoint': 'main.py'},
    )
    result = asyncio.run(run_task(req, entry))
    assert result['success'] is False
    assert 'killed by admin request' in result['errorMessage'].lower()


def test_run_task_killed_during_prepare_bails_before_spawn(tmp_path, monkeypatch):
    """E4 race guard: kill lands after run_task began but before the child
    was spawned — the pre-spawn checkpoint sees entry.cancelled and exits."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))

    entry = execute_module.register_live_execution('exec-prepare-kill')

    async def cancelling_spawn(*args, **kwargs):
        # simulate the kill endpoint firing exactly at spawn time
        entry.cancelled = True
        entry.killed_callback_pushed = True
        raise AssertionError('must not reach spawn after the checkpoint')

    # The checkpoint runs before create_subprocess_exec; make the checkpoint
    # observe the cancellation by having the manifest load yield to the loop.
    real_load = execute_module.load_manifest

    def slow_load(work_dir):
        entry.cancelled = True
        entry.killed_callback_pushed = True
        return real_load(work_dir)

    monkeypatch.setattr(execute_module, 'load_manifest', slow_load)
    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', cancelling_spawn)

    req = ExecuteRequest(
        executionId='exec-prepare-kill',
        task={'name': 't', 'runtime': 'python', 'entrypoint': 'main.py'},
    )
    result = asyncio.run(run_task(req, entry))
    assert result['success'] is False
    assert 'killed by admin request' in result['errorMessage'].lower()


# ---------------------------------------------------------------------------
# E4/E5: platform tree-kill utility
# ---------------------------------------------------------------------------

def test_kill_process_tree_posix_uses_killpg(monkeypatch):
    """POSIX branch: SIGKILL to the child's process group (children were
    spawned with setsid, so the group == the tree)."""
    from routers import execute as execute_module

    calls = []

    class FakeProc:
        pid = 4242

        def kill(self):
            calls.append('proc.kill')

        async def wait(self):
            return -9

    def fake_getpgid(pid):
        calls.append(('getpgid', pid))
        return pid

    def fake_killpg(pgid, sig):
        calls.append(('killpg', pgid, sig))

    # Fake the whole os/signal surface used by the branch: os.getpgid and
    # signal.SIGKILL do not exist on Windows, so patching the real module
    # attributes would fail there (the production code only reaches this
    # branch on POSIX, where both exist).
    monkeypatch.setattr(execute_module, 'sys', SimpleNamespace(platform='linux'))
    monkeypatch.setattr(execute_module, 'os',
                        SimpleNamespace(getpgid=fake_getpgid, killpg=fake_killpg))
    monkeypatch.setattr(execute_module, 'signal', SimpleNamespace(SIGKILL=9))

    asyncio.run(execute_module._kill_process_tree(FakeProc()))
    assert ('getpgid', 4242) in calls
    assert ('killpg', 4242, 9) in calls


def test_kill_process_tree_win32_uses_taskkill(monkeypatch):
    """Windows branch: taskkill /T /F /PID walks the tree (no process groups
    on win32), then a guarded direct kill for the transport."""
    from routers import execute as execute_module

    calls = []

    class FakeKiller:
        async def wait(self):
            return 0

    class FakeProc:
        pid = 4242

        def kill(self):
            calls.append('proc.kill')

    async def fake_exec(*args, **kwargs):
        calls.append(tuple(args))
        return FakeKiller()

    monkeypatch.setattr(execute_module, 'sys', SimpleNamespace(platform='win32'))
    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)

    asyncio.run(execute_module._kill_process_tree(FakeProc()))
    assert ('taskkill', '/T', '/F', '/PID', '4242') in calls
    assert 'proc.kill' in calls


def test_kill_process_tree_none_pid_is_noop(monkeypatch):
    """A half-spawned child (pid None) must not blow up the kill path."""
    from routers import execute as execute_module

    class DeadProc:
        pid = None

    asyncio.run(execute_module._kill_process_tree(DeadProc()))


# ---------------------------------------------------------------------------
# E5: shutdown tree-kill
# ---------------------------------------------------------------------------

def test_kill_running_task_processes_tree_kills_registered(monkeypatch):
    """Shutdown helper kills every registered live process tree and clears
    the handles; entries without a process (queued/prepare) are left alone."""
    from routers import execute as execute_module

    entry_run = execute_module.register_live_execution('exec-shutdown-1')
    proc1 = SimpleNamespace(pid=111)
    entry_run.proc = proc1
    entry_prepare = execute_module.register_live_execution('exec-shutdown-2')

    kill_mock = AsyncMock()
    monkeypatch.setattr(execute_module, '_kill_process_tree', kill_mock)

    killed = asyncio.run(execute_module.kill_running_task_processes())
    assert killed == 1
    kill_mock.assert_awaited_once_with(proc1)
    assert entry_run.proc is None
    assert entry_prepare.proc is None


def test_kill_running_task_processes_noop_when_idle():
    from routers import execute as execute_module
    assert asyncio.run(execute_module.kill_running_task_processes()) == 0


@pytest.mark.asyncio
async def test_lifespan_shutdown_tree_kills_running_task_processes(monkeypatch):
    """main.py lifespan: after the wait-for-tasks phase the shutdown chain
    must call the tree-kill helper before notify_offline (parity with node
    gracefulShutdown → killRunningTaskProcesses)."""
    import main as main_module

    monkeypatch.setattr(main_module, 'check_admin_api_connectivity', AsyncMock())
    monkeypatch.setattr(main_module, 'register_executor', AsyncMock())
    notify_offline = AsyncMock()
    monkeypatch.setattr(main_module, 'notify_offline', notify_offline)
    killed = AsyncMock(return_value=1)
    monkeypatch.setattr(main_module.execute, 'kill_running_task_processes', killed)

    async with main_module.lifespan(main_module.app):
        pass

    killed.assert_awaited_once()
    notify_offline.assert_awaited_once()
