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


# ---------------------------------------------------------------------------
# E-21（DEEP_REVIEW 0ef3bbe）：旧实现 read_text().splitlines() 把整份日志
# （上限 64MB）每请求全量读入内存；admin 按 2000 行/页回填时每页都重读一遍。
# 现改为逐行流式迭代，只保留落在窗口内的行。
# ---------------------------------------------------------------------------


def test_logs_never_reads_the_whole_file_into_memory(auth_client, tmp_path, monkeypatch):
    """回归护栏：读路径不得再调用 Path.read_text（整文件入内存的旧实现）。

    直接让 read_text 抛错——若实现回退到整文件读取，本用例立刻失败。
    """
    from pathlib import Path

    execution_id = 'exec-streaming-guard'
    _write_log(tmp_path, monkeypatch, execution_id, [f'line-{i}' for i in range(50)])

    def _boom(*args, **kwargs):  # pragma: no cover - 触发即回归
        raise AssertionError('log route must stream, not read the whole file')

    monkeypatch.setattr(Path, 'read_text', _boom)

    response = auth_client.get(f'/api/logs/{execution_id}?fromLine=10&limit=5')

    assert response.status_code == 200
    body = response.json()
    assert body['lines'] == [f'line-{i}' for i in range(10, 15)]
    assert body['totalLines'] == 50


def test_logs_window_and_total_on_large_file(auth_client, tmp_path, monkeypatch):
    """大文件（超过单页上限）上窗口与 totalLines 仍正确。"""
    execution_id = 'exec-large-log'
    _write_log(tmp_path, monkeypatch, execution_id, [f'l{i}' for i in range(5000)])

    response = auth_client.get(f'/api/logs/{execution_id}?fromLine=4990&limit=100')

    assert response.status_code == 200
    body = response.json()
    assert body['lines'] == [f'l{i}' for i in range(4990, 5000)]
    assert body['totalLines'] == 5000
    assert body['hasMore'] is False


def test_logs_page_after_the_end_is_empty_with_full_total(auth_client, tmp_path, monkeypatch):
    """fromLine 超过总行数：空窗口 + totalLines 仍为真实行数（分页终止条件）。"""
    execution_id = 'exec-past-end'
    _write_log(tmp_path, monkeypatch, execution_id, [f'x{i}' for i in range(20)])

    response = auth_client.get(f'/api/logs/{execution_id}?fromLine=100&limit=10')

    assert response.status_code == 200
    body = response.json()
    assert body['lines'] == []
    assert body['totalLines'] == 20
    assert body['hasMore'] is False


def test_logs_strips_crlf_like_the_previous_splitlines(auth_client, tmp_path, monkeypatch):
    """CRLF 日志（Windows 任务）不得把 '\\r' 留在行内容里。"""
    from config import settings

    execution_id = 'exec-crlf'
    monkeypatch.setattr(settings, 'work_dir', str(tmp_path))
    execution_dir = tmp_path / execution_id
    execution_dir.mkdir(parents=True)
    (execution_dir / f'{execution_id}.log').write_bytes(b'a\r\nb\r\nc\r\n')

    response = auth_client.get(f'/api/logs/{execution_id}')

    assert response.status_code == 200
    body = response.json()
    assert body['lines'] == ['a', 'b', 'c']
    assert body['totalLines'] == 3
