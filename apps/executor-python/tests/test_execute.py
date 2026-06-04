"""Tests for POST /api/execute endpoint.

T-01: covers the core execute route — authentication guard,
payload validation, and unsupported-runtime rejection.
"""
import pytest


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
