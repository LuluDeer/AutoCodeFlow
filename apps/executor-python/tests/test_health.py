def test_health_returns_200(client):
    response = client.get('/health')
    assert response.status_code == 200


def test_health_contains_status_field(client):
    response = client.get('/health')
    body = response.json()
    assert 'status' in body
