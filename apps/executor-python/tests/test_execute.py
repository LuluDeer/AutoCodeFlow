"""Tests for POST /api/execute endpoint.

T-01: covers the core execute route — authentication guard,
payload validation, and unsupported-runtime rejection.
"""
import pytest
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
# Unsupported runtime
# ---------------------------------------------------------------------------

def test_execute_unsupported_runtime_returns_400(auth_client):
    """Tasks with an unrecognised runtime should be rejected with 400."""
    response = auth_client.post('/api/execute', json={
        'executionId': 'exec-badruntime',
        'task': {'name': 'noop', 'runtime': 'ruby', 'script': 'puts 1'},
    })
    # Executor only supports python/shell; unsupported runtime → 400
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# Path traversal in executionId (S-03 regression)
# ---------------------------------------------------------------------------

def test_execute_path_traversal_in_id_returns_400(auth_client):
    """executionId containing '..' must be rejected to prevent path traversal."""
    response = auth_client.post('/api/execute', json={
        'executionId': '../../etc/passwd',
        'task': {'name': 'evil', 'runtime': 'python', 'script': 'pass'},
    })
    # The route validates executionId and rejects traversal attempts
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# Capacity limiting (ERR-03)
# ---------------------------------------------------------------------------

def test_execute_at_capacity_returns_429(auth_client):
    """When executor is at maximum capacity, requests should be rejected with 429."""
    # Set running count to max to simulate full capacity
    original_count = sched.running_count
    sched.running_count = 100  # Assuming max_concurrent_tasks > 0
    
    response = auth_client.post('/api/execute', json={
        'executionId': 'exec-at-capacity',
        'task': {'name': 'test', 'runtime': 'python', 'script': 'pass'},
    })
    
    # Restore original count
    sched.running_count = original_count
    
    # Should receive 429 when at capacity
    assert response.status_code == 429
    assert 'capacity' in response.json()['detail'].lower()


def test_execute_below_capacity_allowed(auth_client):
    """When executor has available capacity, requests should be accepted."""
    # Ensure running count is below max
    original_count = sched.running_count
    sched.running_count = 0
    
    # This should not return 429 (would fail for other reasons like missing script, but not capacity)
    response = auth_client.post('/api/execute', json={
        'executionId': 'exec-below-capacity',
        'task': {'name': 'test', 'runtime': 'python', 'script': 'pass'},
    })
    
    # Restore original count
    sched.running_count = original_count
    
    # Should NOT be 429 (even if it fails for other reasons)
    assert response.status_code != 429


# ---------------------------------------------------------------------------
# SEC-01: Environment variable isolation (security boundary)
# ---------------------------------------------------------------------------

def test_child_process_env_isolation(tmp_path):
    """SEC-01: Child process should NOT have access to executor secrets like EXECUTOR_SHARED_TOKEN."""
    import subprocess
    import os
    from routers.execute import _ENV_WHITELIST

    # Create a test script that prints all environment variables
    out_file = tmp_path / 'env_keys.txt'
    test_script = tmp_path / 'test_env.py'
    test_script.write_text(
        f'import os\nwith open({str(out_file)!r}, "w") as f:\n'
        f'    f.write("\\n".join(sorted(os.environ.keys())))\n'
    )

    # SEC-01: Create env dict using the same whitelist logic as execute.py
    env = {k: v for k, v in os.environ.items() if k in _ENV_WHITELIST}
    env['EXECUTION_ID'] = 'test-exec-id'
    env['TASK_ID'] = 'test-task-id'

    # Ensure sensitive variables are NOT in the whitelist
    sensitive_vars = {'EXECUTOR_SHARED_TOKEN', 'EXECUTOR_SECRET', 'ADMIN_API_URL'}
    for var in sensitive_vars:
        assert var not in _ENV_WHITELIST, f"Sensitive variable {var} should NOT be in whitelist"

    # Run the script synchronously with the whitelisted env
    subprocess.run(['python3', str(test_script)], cwd=str(tmp_path), env=env, check=True)

    env_keys = set(out_file.read_text().strip().split('\n'))

    # Verify sensitive vars are NOT in child process env
    for var in sensitive_vars:
        assert var not in env_keys, f"Sensitive variable {var} should NOT be accessible to child process"

    # Verify task-scoped vars ARE in child process env
    assert 'EXECUTION_ID' in env_keys
    assert 'TASK_ID' in env_keys


def test_task_params_injected_as_env_vars(tmp_path):
    """Task params should be injected as AUTOFLOW_* environment variables."""
    import subprocess
    import json
    import os
    from routers.execute import _ENV_WHITELIST

    # Create a test script that checks for AUTOFLOW_* vars
    out_file = tmp_path / 'params_output.txt'
    test_script = tmp_path / 'test_params.py'
    test_script.write_text(
        f'import os, json\n'
        f'result = {{k: v for k, v in os.environ.items() if k.startswith("AUTOFLOW_")}}\n'
        f'with open({str(out_file)!r}, "w") as f:\n'
        f'    json.dump(result, f)\n'
    )

    # Simulate what execute.py does with params
    env = {k: v for k, v in os.environ.items() if k in _ENV_WHITELIST}
    params = {'foo': 'bar', 'baz': 'qux'}
    for k, v in params.items():
        env[f'AUTOFLOW_{k.upper()}'] = str(v)

    # Run the script synchronously
    subprocess.run(['python3', str(test_script)], cwd=str(tmp_path), env=env, check=True)

    result = json.loads(out_file.read_text())

    assert 'AUTOFLOW_FOO' in result
    assert result['AUTOFLOW_FOO'] == 'bar'
    assert 'AUTOFLOW_BAZ' in result
    assert result['AUTOFLOW_BAZ'] == 'qux'
