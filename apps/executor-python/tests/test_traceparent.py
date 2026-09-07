"""OBS-01: traceparent 贯穿（executor-python 侧）。

形态与 executor-node 对齐：admin 开启追踪（OTEL_ENABLED=true）后 dispatch
指令携带 W3C traceparent 头；执行器侧 ① 记录进 _LiveExecution ② 注入任务
env AUTOFLOW_TRACE_ID（params 注入之后，用户参数不可覆盖）③ 终态回调回传
traceparent 头。admin 未开追踪时不带头——全部路径零行为变化。
"""
import asyncio
from types import SimpleNamespace

import pytest

import scheduler as sched

VALID_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'


def _register_noop_task(monkeypatch, created):
    """拦截 asyncio.create_task——不真正跑后台任务，只捕获协程供断言。"""

    class FakeTaskHandle:
        def add_done_callback(self, cb):
            pass

    def fake_create_task(coro):
        created.append(coro)
        coro.close()
        return FakeTaskHandle()

    monkeypatch.setattr(execute_module_asyncio(), 'create_task', fake_create_task)


def execute_module_asyncio():
    from routers import execute as _module
    return _module.asyncio


# ---------------------------------------------------------------------------
# 端点级：traceparent 头读取 → entry 记录
# ---------------------------------------------------------------------------

def test_execute_with_traceparent_header_returns_accepted(auth_client, monkeypatch):
    """携带 traceparent 头的 dispatch 正常受理（零破坏）。"""
    from routers import execute as execute_module
    created = []

    class FakeTaskHandle:
        def add_done_callback(self, cb):
            pass

    def fake_create_task(coro):
        created.append(coro)
        coro.close()
        return FakeTaskHandle()

    original_count = sched.running_count
    sched.running_count = 0
    monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)
    try:
        response = auth_client.post(
            '/api/execute',
            headers={'traceparent': VALID_TRACEPARENT},
            json={
                'executionId': 'exec-trace-1',
                'task': {'name': 'test', 'runtime': 'python', 'script': 'pass'},
            },
        )
    finally:
        sched.running_count = original_count

    assert response.status_code == 200
    assert response.json()['status'] == 'accepted'


def test_execute_traceparent_recorded_in_live_entry(auth_client, monkeypatch):
    """traceparent 头进入 _LiveExecution（回传与 env 注入的单一事实源）。"""
    from routers import execute as execute_module

    original_count = sched.running_count
    sched.running_count = 0
    monkeypatch.setattr(execute_module.asyncio, 'create_task', _noop_create_task())
    try:
        response = auth_client.post(
            '/api/execute',
            headers={'traceparent': VALID_TRACEPARENT},
            json={
                'executionId': 'exec-trace-2',
                'task': {'name': 'test', 'runtime': 'python', 'script': 'pass'},
            },
        )
        entry = execute_module.get_live_execution('exec-trace-2')
    finally:
        sched.running_count = original_count
        if entry is not None:
            execute_module.unregister_live_execution('exec-trace-2')

    assert response.status_code == 200
    assert entry is not None
    assert entry.traceparent == VALID_TRACEPARENT


def test_execute_without_traceparent_header_entry_field_none(auth_client):
    """无 traceparent 头（admin 未开追踪）→ entry.traceparent 保持 None。"""
    from routers import execute as execute_module

    original_count = sched.running_count
    sched.running_count = 0
    monkeypatch_holder = {}

    class FakeTaskHandle:
        def add_done_callback(self, cb):
            pass

    def fake_create_task(coro):
        coro.close()
        return FakeTaskHandle()

    import routers.execute as em
    monkeypatch_holder['orig'] = em.asyncio.create_task
    em.asyncio.create_task = fake_create_task
    entry = None
    try:
        response = auth_client.post(
            '/api/execute',
            json={
                'executionId': 'exec-trace-3',
                'task': {'name': 'test', 'runtime': 'python', 'script': 'pass'},
            },
        )
        entry = execute_module.get_live_execution('exec-trace-3')
    finally:
        em.asyncio.create_task = monkeypatch_holder['orig']
        sched.running_count = original_count
        if entry is not None:
            execute_module.unregister_live_execution('exec-trace-3')

    assert response.status_code == 200
    assert entry.traceparent is None


def _noop_create_task():
    class FakeTaskHandle:
        def add_done_callback(self, cb):
            pass

    def fake_create_task(coro):
        coro.close()
        return FakeTaskHandle()

    return fake_create_task


# ---------------------------------------------------------------------------
# env 注入与回调回传（单元级）
# ---------------------------------------------------------------------------

def test_send_callback_with_retry_sends_traceparent_header(monkeypatch):
    """载荷带 traceparent 时回传头携带同名头（request_with_self_heal 收到）。"""
    from routers import execute as execute_module

    captured = {}

    class FakeResponse:
        status_code = 200

    async def fake_self_heal(client, method, url, *, token=None, headers=None, **kwargs):
        captured['headers'] = headers
        return FakeResponse()

    monkeypatch.setattr(execute_module, 'request_with_self_heal', fake_self_heal)

    ok = asyncio.run(execute_module._send_callback_with_retry(
        'http://admin:3105/api/executions/callback',
        {'executionId': 'e1', 'status': 'success', 'traceparent': VALID_TRACEPARENT},
        'token',
    ))

    assert ok is True
    assert captured['headers'] == {'traceparent': VALID_TRACEPARENT}


def test_send_callback_with_retry_no_header_when_no_traceparent(monkeypatch):
    """载荷无 traceparent（admin 未开追踪）→ 零头回传（零行为变化）。"""
    from routers import execute as execute_module

    captured = {}

    class FakeResponse:
        status_code = 200

    async def fake_self_heal(client, method, url, *, token=None, headers=None, **kwargs):
        captured['headers'] = headers
        return FakeResponse()

    monkeypatch.setattr(execute_module, 'request_with_self_heal', fake_self_heal)

    ok = asyncio.run(execute_module._send_callback_with_retry(
        'http://admin:3105/api/executions/callback',
        {'executionId': 'e2', 'status': 'success'},
        'token',
    ))

    assert ok is True
    assert captured['headers'] in (None, {})
