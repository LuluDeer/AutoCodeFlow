"""attemptSeq（派发世代）在 executor-python 的原样回传定向测试。

覆盖：顶层 attemptSeq 解析 → live 执行上下文 → 终态回调载荷；缺省不新增
undefined/null 键；畸形值安全忽略；显式载荷字段优先（死信重放）。
"""

import asyncio

import pytest

from routers import execute as execute_module


@pytest.fixture(autouse=True)
def _clean_callback_state():
    execute_module._live_callback_queue.clear()
    yield
    for eid in ('exec-7', 'legacy', 'bad', 'explicit', 'route-7'):
        execute_module.unregister_live_execution(eid)
    execute_module._live_callback_queue.clear()


def _queued(execution_id: str) -> dict:
    hits = [p for p in execute_module._live_callback_queue
            if p.get('executionId') == execution_id]
    assert hits, f'{execution_id} 的终态回调未入队'
    return hits[-1]


def test_echoes_attempt_seq_from_dispatch_context():
    entry = execute_module.register_live_execution('exec-7')
    assert entry is not None
    entry.attempt_seq = 7

    execute_module.enqueue_callback({
        'executionId': 'exec-7', 'status': 'success', 'exitCode': 0,
    })

    assert _queued('exec-7')['attemptSeq'] == 7


def test_omitted_attempt_seq_adds_no_key_at_all(monkeypatch):
    warnings = []
    monkeypatch.setattr(
        execute_module.logger, 'warning',
        lambda msg, *a, **k: warnings.append(str(msg) % a if a else str(msg)),
    )

    execute_module.enqueue_callback({
        'executionId': 'legacy', 'status': 'success', 'exitCode': 0,
    })

    assert 'attemptSeq' not in _queued('legacy')
    assert not [w for w in warnings if 'CallbackPayload' in w]


def test_malformed_dispatch_attempt_seq_is_safely_ignored():
    entry = execute_module.register_live_execution('bad')
    assert entry is not None
    # 即便上下文被旁路写入畸形值，盖章处也应安全忽略，绝不回传假世代。
    entry.attempt_seq = '7'

    execute_module.enqueue_callback({'executionId': 'bad', 'status': 'failed'})

    assert 'attemptSeq' not in _queued('bad')


def test_explicit_payload_attempt_seq_wins_over_context():
    entry = execute_module.register_live_execution('explicit')
    assert entry is not None
    entry.attempt_seq = 7

    # 死信重放的落盘载荷已带世代，不得被当前上下文覆盖。
    execute_module.enqueue_callback({
        'executionId': 'explicit', 'status': 'failed', 'attemptSeq': 9,
    })

    assert _queued('explicit')['attemptSeq'] == 9


def test_execute_route_reads_top_level_attempt_seq_from_raw_body(monkeypatch):
    captured = {}

    def fake_accept(req, tp, attempt_seq=None):
        captured['tp'] = tp
        captured['attempt_seq'] = attempt_seq
        return {'status': 'accepted', 'executionId': req.executionId}

    monkeypatch.setattr(execute_module, 'accept_execution', fake_accept)

    class _FakeRequest:
        headers = {'traceparent': '00-' + 'a' * 32 + '-' + 'b' * 16 + '-01'}

        async def json(self):
            return {
                'executionId': 'route-7',
                'task': {'runtime': 'python'},
                'attemptSeq': 7,
            }

    req = execute_module.ExecuteRequest(
        executionId='route-7', task={'runtime': 'python'},
    )
    result = asyncio.run(execute_module.execute(req, _FakeRequest()))

    assert result['status'] == 'accepted'
    assert captured['attempt_seq'] == 7
    assert captured['tp'] == _FakeRequest.headers['traceparent']
