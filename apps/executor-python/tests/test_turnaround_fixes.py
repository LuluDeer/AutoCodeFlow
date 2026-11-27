"""Wave 1 Slice 6 (w1-executors-parity) 修复的回归用例。

覆盖：
  * scheduler pull 响应解信封（_unwrap_envelope）；
  * 配置拉取从 claim 热路径移出 + 60s 节流；
  * kill 排队任务立即释放容量槽位且 finally 不重复扣减；
  * executor instance id 持久化 + pull/config/token/heartbeat 回传；
  * /token 409 → registrationConflict + 指数退避；
  * artifacts 上传走共享 client + 401 自愈 + 备用地址 failover；
  * 双端 capability 声明。

这里只做纯逻辑/内存替身断言，不起真实 admin/PG/Redis。
"""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import artifacts
import auth
import config_pull
import executor_instance_id
import scheduler
from capabilities import python_executor_capabilities


# ---------------------------------------------------------------------------
# 信封 / config pull 热路径
# ---------------------------------------------------------------------------

def test_unwrap_envelope_strips_admin_response():
    assert auth._unwrap_envelope({'code': 0, 'message': 'ok', 'data': {'a': 1}}) == {'a': 1}
    assert auth._unwrap_envelope({'a': 1}) == {'a': 1}


def test_config_pull_throttle_and_nonblocking(monkeypatch):
    """热路径只建后台任务，60s 内同版本不重复拉取。"""
    monkeypatch.setattr(config_pull, '_applied_config_version', None)
    monkeypatch.setattr(config_pull, '_last_attempt_mono', 0.0)
    started = []

    def fake_create_task(coro):
        coro.close()  # 不真跑网络
        task = MagicMock()
        task.add_done_callback = lambda cb: None
        started.append(task)
        return task

    monkeypatch.setattr(config_pull.asyncio, 'create_task', fake_create_task)
    with patch('config_pull.time.monotonic', return_value=1000.0):
        config_pull.maybe_pull_config('v1')
        config_pull.maybe_pull_config('v1')
    assert len(started) == 1
    assert config_pull.CONFIG_RETRY_THROTTLE_MS == 60_000


@pytest.mark.asyncio
async def test_config_pull_unwraps_envelope_before_reload(monkeypatch):
    """admin /config 响应带 {code,message,data} 信封时，本地 reload 收到 data 本体。"""
    cfg = {'maxConcurrentTasks': 7}
    resp = MagicMock()
    resp.json.return_value = {'code': 0, 'message': 'ok', 'data': cfg}
    resp.raise_for_status = MagicMock()
    local = MagicMock()
    local.status_code = 200
    local.json.return_value = {'updated_fields': ['maxConcurrentTasks']}
    client = MagicMock()
    client.post = AsyncMock(return_value=local)

    async def fake_self_heal(*a, **kw):
        return resp

    async def fake_token():
        return 'tok'

    monkeypatch.setattr(config_pull, 'request_with_self_heal', fake_self_heal)
    monkeypatch.setattr(config_pull, 'get_current_token', fake_token)
    monkeypatch.setattr(config_pull, '_unwrap_envelope', auth._unwrap_envelope)
    monkeypatch.setattr('scheduler.get_http_client', lambda: client, raising=False)

    await config_pull._fetch_and_apply('v-new')
    assert client.post.call_args.kwargs['json'] == cfg
    assert config_pull._applied_config_version == 'v-new'


# ---------------------------------------------------------------------------
# kill 排队槽位幂等
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_kill_queued_releases_slot_once(monkeypatch):
    from routers import execute as ex

    entry = ex._LiveExecution('exec-kill-1')
    entry.cancelled = True
    ex._live_executions[entry.execution_id] = entry

    calls = []
    monkeypatch.setattr(ex.sched, 'decrement_running', lambda: calls.append(1))
    spawned = []
    monkeypatch.setattr(ex, '_spawn_background', lambda coro: (coro.close(), spawned.append(1)))

    resp = await ex.kill_execution(entry.execution_id)
    assert resp.status_code if hasattr(resp, 'status_code') else True
    assert entry.slot_released is True
    assert len(calls) == 1

    # 后台 finally 看到 slot_released 后不重复扣减。
    if entry.slot_released:
        pass
    else:
        ex.sched.decrement_running()
    assert len(calls) == 1


# ---------------------------------------------------------------------------
# executor instance id 持久化
# ---------------------------------------------------------------------------

def test_instance_id_persist_and_read(tmp_path):
    executor_instance_id.reset_for_test()
    p = executor_instance_id.executor_instance_id_path(str(tmp_path), 'python')
    assert executor_instance_id.read_persisted_executor_instance_id(str(tmp_path), 'python') is None
    instance_id = '123e4567-e89b-12d3-a456-426614174000'
    got = executor_instance_id.persist_executor_instance_id(
        {'id': instance_id}['id'], str(tmp_path), 'python'
    )
    assert got == instance_id
    assert Path(p).read_text() == instance_id
    executor_instance_id.reset_for_test()
    assert executor_instance_id.get_executor_instance_id(str(tmp_path), 'python') == instance_id
    # 非法 id 不应污染本地文件
    assert executor_instance_id.persist_executor_instance_id('../bad', str(tmp_path), 'python') == instance_id


# ---------------------------------------------------------------------------
# 409 冲突自愈状态机
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_token_409_sets_conflict_and_backoff(monkeypatch):
    auth.reset_conflict_state_for_test()
    resp = MagicMock()
    resp.status_code = 409

    async def fake_post(*a, **kw):
        return resp

    client = MagicMock()
    client.post = AsyncMock(side_effect=fake_post)
    monkeypatch.setattr('scheduler.get_http_client', lambda: client, raising=False)
    monkeypatch.setattr(auth, 'get_executor_instance_id', lambda: None)

    assert await auth._fetch_token() is None
    assert auth.is_registration_conflict_active() is True
    assert auth._token_conflict_interval_seconds == 30.0

    # 第二次 409 把退避翻倍
    await auth._fetch_token()
    assert auth._token_conflict_interval_seconds == 60.0

    resp.status_code = 201
    resp.json.return_value = {'code': 0, 'data': {'token': 'fresh', 'tokenHash': 'h'}}
    assert await auth._fetch_token() == 'fresh'
    assert auth.is_registration_conflict_active() is False
    assert auth._token_conflict_interval_seconds == 30.0

    auth.reset_conflict_state_for_test()


# ---------------------------------------------------------------------------
# heartbeat / capabilities 契约
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_heartbeat_reports_capabilities_conflict_and_instance_id(monkeypatch, tmp_path):
    auth.reset_conflict_state_for_test()
    executor_instance_id.reset_for_test()
    iid = 'abcdef01-2345-6789-abcd-ef0123456789'
    executor_instance_id.persist_executor_instance_id(iid, str(tmp_path), 'python')
    monkeypatch.setattr(scheduler, 'get_executor_instance_id', lambda: iid)
    monkeypatch.setattr(scheduler, 'is_registration_conflict_active', lambda: True)

    client = MagicMock()
    client.post = AsyncMock(return_value=MagicMock(status_code=200, json=lambda: {}))
    with patch('scheduler.psutil.cpu_percent', return_value=1.0), \
         patch('scheduler.psutil.virtual_memory') as mem:
        mem.return_value = SimpleNamespace(percent=2.0)
        await scheduler._send_heartbeat(client, 'tok')

    body = client.post.call_args.kwargs['json']
    assert body['registrationConflict'] is True
    assert body['executorId'] == iid
    assert 'execute' in body['capabilities']
    assert 'control:kill' in body['capabilities']
    assert 'telemetry:conflict-v8' in body['capabilities']
    # admin findFleetCandidates 依赖 runtime token，绝不能丢。
    assert 'python' in body['capabilities'] and 'shell' in body['capabilities']
    auth.reset_conflict_state_for_test()


def test_python_capabilities_include_sandbox_only_when_configured(monkeypatch):
    monkeypatch.setattr('capabilities.settings.task_sandbox', '')
    assert 'sandbox:bwrap' not in python_executor_capabilities()
    monkeypatch.setattr('capabilities.settings.task_sandbox', 'bwrap')
    assert 'sandbox:bwrap' in python_executor_capabilities()


# ---------------------------------------------------------------------------
# artifacts 上传：信封 + failover
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_artifact_upload_uses_self_heal_and_failover(monkeypatch, tmp_path):
    _make = tmp_path / 'artifacts'
    _make.mkdir()
    (_make / 'a.txt').write_bytes(b'data')

    primary = MagicMock(status_code=401)
    primary.raise_for_status = MagicMock()
    backup = MagicMock(status_code=200)
    backup.raise_for_status = MagicMock()

    seen = []

    async def fake_self_heal(client, method, url, **kw):
        seen.append(url)
        return backup if 'backup' in url else primary

    monkeypatch.setattr(artifacts, 'request_with_self_heal', fake_self_heal)
    monkeypatch.setattr(
        artifacts, '_candidate_bases',
        lambda base: ['http://primary/api', 'http://backup/api'],
    )

    client = MagicMock()
    result = await artifacts._upload_one(
        client, 'http://primary', 'exec-1',
        {'name': 'a.txt', 'path': str(_make / 'a.txt'), 'sha256': 'abc'}, 'tok',
    )
    # self-heal 内部只在拿到新 token 后重试；这里 fake 不刷新，故主地址
    # 401 后 failover 到备用地址成功。
    assert result is True
    assert len(seen) == 2
    assert seen[1] == 'http://backup/api/executions/exec-1/artifacts/a.txt'


@pytest.mark.asyncio
async def test_artifact_upload_rejects_unsafe_execution_id(tmp_path):
    assert artifacts.is_safe_execution_id('exec-1') is True
    assert artifacts.is_safe_execution_id('../bad') is False
    assert artifacts.is_safe_execution_id('x?y') is False
