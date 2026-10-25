"""P2 批（执行器服务审计 2026-10-26）的修复钉住测试。

覆盖四项审计发现：
- P2-4：心跳载荷补 `maxConcurrentTasks`（admin 容量核算不再依赖注册期快照）；
- P2-5：`heartbeat_interval_seconds` 钳到 5..60（node config.ts 同款）；
- P2-9：accept 对 timeout 三键（timeoutSeconds/timeout_seconds/timeout）的
  1..86400 边界手检——负值此前被 `_clamp_timeout_seconds` 静默钳成 1 秒；
- P2-10：请求体 2MB 上限（对齐 node express.json limit='2mb'）。
"""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

import scheduler as scheduler_module
from config import settings


def _create_mock_response(status_code: int = 200) -> httpx.Response:
    request = httpx.Request('POST', 'http://test.com')
    return httpx.Response(status_code, request=request)


async def _capture_heartbeat_body(mock_client) -> dict:
    """跑一次 _send_heartbeat，返回发往 admin 的 JSON 载荷。"""
    with patch('scheduler.psutil.cpu_percent', return_value=1.0), \
         patch('scheduler.psutil.virtual_memory') as mem_mock:
        mem_mock.return_value = SimpleNamespace(percent=2.0)
        await scheduler_module._send_heartbeat(mock_client, 'test-token')
    return mock_client.post.call_args.kwargs['json']


# ---------------------------------------------------------------------------
# P2-4：心跳载荷补 maxConcurrentTasks
# ---------------------------------------------------------------------------

class TestHeartbeatCarriesMaxConcurrentTasks:
    """P2-4：admin 容量核算不再依赖注册期快照（node scheduler.ts E9 对齐）。"""

    @pytest.mark.asyncio
    async def test_heartbeat_carries_max_concurrent_tasks(self, monkeypatch):
        monkeypatch.setattr(settings, 'max_concurrent_tasks', 7)
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=_create_mock_response(200))
        body = await _capture_heartbeat_body(mock_client)

        assert body['maxConcurrentTasks'] == 7

    @pytest.mark.asyncio
    async def test_heartbeat_reflects_hot_reloaded_value(self, monkeypatch):
        """热更语义：reload 改 settings 后，下一个心跳回传新值（读属性而非
        注册期快照）——这是本修复的存在理由。"""
        monkeypatch.setattr(settings, 'max_concurrent_tasks', 10)
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=_create_mock_response(200))
        body = await _capture_heartbeat_body(mock_client)
        assert body['maxConcurrentTasks'] == 10

        monkeypatch.setattr(settings, 'max_concurrent_tasks', 3)
        mock_client2 = AsyncMock()
        mock_client2.post = AsyncMock(return_value=_create_mock_response(200))
        body2 = await _capture_heartbeat_body(mock_client2)
        assert body2['maxConcurrentTasks'] == 3

    def test_heartbeat_payload_key_always_present(self):
        """逐键断言：键始终存在（三态纪律——发送即事实，缺键 = 旧执行器）。"""
        payload = scheduler_module._heartbeat_payload(1.0, 2.0)
        assert 'maxConcurrentTasks' in payload
        assert payload['maxConcurrentTasks'] == settings.max_concurrent_tasks


# ---------------------------------------------------------------------------
# P2-5：heartbeat_interval_seconds 钳到 5..60
# ---------------------------------------------------------------------------

class TestHeartbeatIntervalClamp:
    """P2-5：0/负值防心跳风暴，>60 防 admin 判死窗外静默摘除。"""

    def _make(self, value: int):
        from config import Settings
        return Settings(heartbeat_interval_seconds=value)

    def test_zero_clamps_to_5(self):
        assert self._make(0).heartbeat_interval_seconds == 5

    def test_negative_clamps_to_5(self):
        assert self._make(-30).heartbeat_interval_seconds == 5

    def test_below_min_clamps_to_5(self):
        assert self._make(1).heartbeat_interval_seconds == 5

    def test_upper_bound_60_kept(self):
        assert self._make(60).heartbeat_interval_seconds == 60

    def test_above_max_clamps_to_60(self):
        assert self._make(300).heartbeat_interval_seconds == 60

    def test_default_30_unchanged(self):
        from config import Settings
        assert Settings().heartbeat_interval_seconds == 30

    def test_in_range_values_unchanged(self):
        assert self._make(5).heartbeat_interval_seconds == 5
        assert self._make(30).heartbeat_interval_seconds == 30


# ---------------------------------------------------------------------------
# P2-9：accept 对 timeout 三键的 1..86400 边界手检
# ---------------------------------------------------------------------------

@pytest.fixture()
def execute_module():
    from routers import execute as execute_module
    return execute_module


async def _noop_run_and_callback(req, entry=None):
    """accept 用例的后台任务替身：登记路径的真实 _run_and_callback 会跑
    prepare（git/解释器探测/子进程），测试绝不能让它落地。

    语义必须忠实于真身：accept 成功路径已 increment_running（非预留模式），
    真身的 finally 无条件 decrement_running——替身同样要归还，否则账本
    泄漏会让后续用例（如 TestHeartbeatReservedSlots 的预留断言）复现
    「上限满 → 预留 False」的假象。"""
    import scheduler as _sched
    from routers.execute import unregister_live_execution
    _sched.decrement_running()
    unregister_live_execution(req.executionId)


class TestAcceptTimeoutBounds:
    """P2-9：`timeout_seconds: -5` 在 node 上 400、在 python 上曾钳成 1 秒。"""

    @pytest.mark.asyncio
    @pytest.mark.parametrize('key,value', [
        ('timeoutSeconds', -1),
        ('timeout_seconds', -5),
        ('timeout', -1),
        ('timeoutSeconds', 86401),
        ('timeout_seconds', 86401),
        ('timeout', 86401),
    ])
    async def test_out_of_bounds_timeout_rejected_before_registration(
            self, execute_module, key, value):
        req = execute_module.ExecuteRequest(
            executionId='exec-timeout-bound-1',
            task={'runtime': 'python', key: value},
        )
        with pytest.raises(execute_module.ExecutionRejected) as exc:
            await execute_module.accept_execution(req)
        assert exc.value.status_code == 400
        assert '1..86400' in exc.value.detail
        # 400 形态必须发生在登记之前：live 表不得留下该 executionId
        assert not execute_module.execution_exists('exec-timeout-bound-1')

    @pytest.mark.asyncio
    @pytest.mark.parametrize('key,value', [
        ('timeoutSeconds', 0),
        ('timeout_seconds', 0),
        ('timeout', 0),
    ])
    async def test_zero_is_explicitly_unbounded_not_rejected(
            self, execute_module, monkeypatch, key, value):
        """0 = 显式不限时（E-02 契约），手检必须放行——反证：若误拒 0，
        admin 默认创建的任务（timeout=0）会全部 400。run_task 全桩，仅验证
        accept 放行。"""
        monkeypatch.setattr(execute_module, '_run_and_callback',
                            _noop_run_and_callback)
        monkeypatch.setattr(scheduler_module, 'get_running_count', lambda: 0)
        monkeypatch.setattr(execute_module.settings, 'work_dir',
                            '/tmp/acf-p2-zero-wd')
        req = execute_module.ExecuteRequest(
            executionId=f'exec-zero-ok-{key}',
            task={'runtime': 'python', key: 0},
        )
        result = execute_module.accept_execution(req)
        assert result['status'] == 'accepted'

    @pytest.mark.asyncio
    async def test_string_timeout_rejected(self, execute_module):
        """字符串形态在协议闸（strict）就该被拒——本手检不放松它。"""
        req = execute_module.ExecuteRequest(
            executionId='exec-timeout-str',
            task={'runtime': 'python', 'timeout_seconds': '3600'},
        )
        with pytest.raises(execute_module.ExecutionRejected) as exc:
            await execute_module.accept_execution(req)
        assert exc.value.status_code == 400

    @pytest.mark.asyncio
    async def test_in_bounds_timeout_accepted(self, execute_module, monkeypatch):
        """1 与 86400（合法边界）必须穿过 accept 手检。run_task 全桩。"""
        monkeypatch.setattr(execute_module, '_run_and_callback',
                            _noop_run_and_callback)
        monkeypatch.setattr(scheduler_module, 'get_running_count', lambda: 0)
        monkeypatch.setattr(execute_module.settings, 'work_dir',
                            '/tmp/acf-p2-bounds-wd')

        for i, value in enumerate([1, 86400]):
            eid = f'exec-timeout-ok-{i}'
            req = execute_module.ExecuteRequest(
                executionId=eid,
                task={'runtime': 'python', 'timeout_seconds': value},
            )
            result = execute_module.accept_execution(req)
            assert result['status'] == 'accepted'

    @pytest.mark.asyncio
    async def test_protocol_vector_negative_alias_rejected_by_generated_schema(
            self):
        """protocol.json P2-9 向量：生成物必须拒 timeout_seconds 越界。"""
        from generated.protocol_schemas import TaskConfig
        from pydantic import ValidationError

        for payload in (
                {'timeout_seconds': -5},
                {'timeout_seconds': 86401},
                {'timeout_seconds': -1},
        ):
            with pytest.raises(ValidationError) as exc:
                TaskConfig.model_validate(payload)
            assert ('timeout_seconds',) == tuple(
                str(p) for p in exc.value.errors()[0]['loc'])

    def test_protocol_vectors_present_in_contract_file(self):
        """契约文件必须携带 P2-9 新向量（防向量被清掉后断言永真）。"""
        from pathlib import Path
        protocol_path = (Path(__file__).parents[3] / 'packages'
                         / 'executor-protocol' / 'protocol.json')
        protocol = json.loads(protocol_path.read_text(encoding='utf-8'))
        vectors = {v['name']: v for v in
                   protocol['schemaVectors']['TaskConfig']['invalid']}
        assert 'timeout_seconds-below-min' in vectors
        assert vectors['timeout_seconds-below-min']['payload'] == {
            'timeout_seconds': -5}
        assert vectors['timeout_seconds-below-min']['expectErrorPath'] == [
            'timeout_seconds']
        assert 'timeout_seconds-above-max' in vectors
        # schema 边界字段必须在
        field = protocol['schemas']['TaskConfig']['properties']['timeout_seconds']
        assert field.get('minimum') == 0
        assert field.get('maximum') == 86400


# ---------------------------------------------------------------------------
# P2-10：请求体 2MB 上限
# ---------------------------------------------------------------------------

class TestRequestBodySizeLimit:
    """P2-10：uvicorn 默认不限长 → Content-Length 预检 + 流式计数双闸。"""

    @pytest.fixture()
    def size_client(self):
        from main import app

        with TestClient(app, headers={'Authorization': 'Bearer testsecret'}) as c:
            yield c

    def test_oversized_content_length_rejected_413(self, size_client):
        payload = {'executionId': 'exec-big', 'task': {'runtime': 'python'}}
        body = json.dumps(payload).encode()
        resp = size_client.post(
            '/api/execute',
            content=body,
            headers={
                'Authorization': 'Bearer testsecret',
                'Content-Type': 'application/json',
                'Content-Length': str(3 * 1024 * 1024),
            },
        )
        assert resp.status_code == 413

    def test_normal_request_unaffected(self, size_client, monkeypatch):
        """2MB 内的合法载荷照常进入 accept（中间件零误伤）。"""
        import routers.execute as execute_module

        monkeypatch.setattr(execute_module, '_run_and_callback',
                            _noop_run_and_callback)
        monkeypatch.setattr(scheduler_module, 'get_running_count', lambda: 0)
        monkeypatch.setattr(execute_module.settings, 'work_dir',
                            '/tmp/acf-p2-10-workdir')

        payload = {'executionId': 'exec-p2-10-ok', 'task': {'runtime': 'python'}}
        resp = size_client.post('/api/execute', json=payload)
        assert resp.status_code == 200
        assert resp.json()['status'] == 'accepted'

    def test_2mb_limit_constant_matches_node(self):
        from request_size_limit import MAX_BODY_BYTES
        assert MAX_BODY_BYTES == 2 * 1024 * 1024
