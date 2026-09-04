def test_nonexistent_execution_id_returns_404(auth_client):
    """GET /api/logs/{execution_id} for an unknown id should return 404."""
    response = auth_client.get('/api/logs/nonexistent-id-12345')
    assert response.status_code == 404


def test_path_traversal_returns_400(auth_client):
    """GET /api/logs/{execution_id} with a '..' executionId should return 400."""
    # logs.py explicitly rejects any executionId containing '..' before doing
    # path resolution, so this is reliably caught even without a slash in the ID.
    response = auth_client.get('/api/logs/evil..id')
    assert response.status_code == 400


def _write_log(tmp_path, monkeypatch, execution_id: str, lines: list[str]) -> None:
    from config import settings

    monkeypatch.setattr(settings, 'work_dir', str(tmp_path))
    execution_dir = tmp_path / execution_id
    execution_dir.mkdir(parents=True)
    (execution_dir / f'{execution_id}.log').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def test_logs_default_limit_and_has_more(auth_client, tmp_path, monkeypatch):
    """GET /api/logs/{execution_id} returns at most the default page size."""
    execution_id = 'exec-with-many-lines'
    _write_log(tmp_path, monkeypatch, execution_id, [f'line-{i}' for i in range(600)])

    response = auth_client.get(f'/api/logs/{execution_id}')

    assert response.status_code == 200
    body = response.json()
    assert len(body['lines']) == 500
    assert body['lines'][0] == 'line-0'
    assert body['lines'][-1] == 'line-499'
    assert body['totalLines'] == 600
    assert body['hasMore'] is True


def test_logs_limit_from_line_and_has_more_false(auth_client, tmp_path, monkeypatch):
    """GET /api/logs/{execution_id} respects fromLine and limit."""
    execution_id = 'exec-with-offset'
    _write_log(tmp_path, monkeypatch, execution_id, [f'line-{i}' for i in range(10)])

    response = auth_client.get(f'/api/logs/{execution_id}?fromLine=7&limit=5')

    assert response.status_code == 200
    body = response.json()
    assert body['lines'] == ['line-7', 'line-8', 'line-9']
    assert body['totalLines'] == 10
    assert body['hasMore'] is False


def test_logs_rejects_limit_above_cap(auth_client, tmp_path, monkeypatch):
    """GET /api/logs/{execution_id} rejects unbounded log page sizes."""
    execution_id = 'exec-with-limit-cap'
    _write_log(tmp_path, monkeypatch, execution_id, ['line-0'])

    response = auth_client.get(f'/api/logs/{execution_id}?limit=2001')

    assert response.status_code == 422
