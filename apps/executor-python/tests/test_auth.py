def test_no_token_returns_401(client):
    """POST /api/execute without Authorization header should return 401."""
    response = client.post('/api/execute', json={
        'executionId': 'test-exec-1',
        'task': {'name': 'test'},
    })
    assert response.status_code == 401


def test_wrong_token_returns_401(client):
    """POST /api/execute with wrong Bearer token should return 401."""
    response = client.post(
        '/api/execute',
        json={
            'executionId': 'test-exec-2',
            'task': {'name': 'test'},
        },
        headers={'Authorization': 'Bearer wrongtoken'},
    )
    assert response.status_code == 401


def test_correct_token_not_401(auth_client):
    """POST /api/execute with correct token should pass auth (may return other errors for bad payload)."""
    response = auth_client.post(
        '/api/execute',
        json={
            'executionId': 'test-exec-3',
            'task': {'name': 'test'},
        },
        headers={'Authorization': 'Bearer testsecret'},
    )
    assert response.status_code != 401
