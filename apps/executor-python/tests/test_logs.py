def test_nonexistent_execution_id_returns_404(client):
    """GET /api/logs/{execution_id} for an unknown id should return 404."""
    response = client.get('/api/logs/nonexistent-id-12345')
    assert response.status_code == 404


def test_path_traversal_returns_400(client):
    """GET /api/logs/{execution_id} with a '..' executionId should return 400."""
    # logs.py explicitly rejects any executionId containing '..' before doing
    # path resolution, so this is reliably caught even without a slash in the ID.
    response = client.get('/api/logs/evil..id')
    assert response.status_code == 400
