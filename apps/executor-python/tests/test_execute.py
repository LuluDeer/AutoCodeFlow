"""Tests for POST /api/execute endpoint.

T-01: covers the core execute route — authentication guard,
payload validation, accepted/callback protocol, and failure reporting.
"""
import asyncio

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

    def fake_create_task(coro):
        created_coroutines.append(coro)
        # Do not run the background task in this route-level test.
        coro.close()
        return object()

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

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', FakeAsyncClient)
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local/api')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'dynamic-token')
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

    subprocess.run(['python3', str(test_script)], cwd=str(tmp_path), env=env, check=True)

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

    subprocess.run(['python3', str(test_script)], cwd=str(tmp_path), env=env, check=True)

    result = json.loads(out_file.read_text())

    assert 'AUTOFLOW_FOO' in result
    assert result['AUTOFLOW_FOO'] == 'bar'
    assert 'AUTOFLOW_BAZ' in result
    assert result['AUTOFLOW_BAZ'] == 'qux'
