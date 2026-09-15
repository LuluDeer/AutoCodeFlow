import asyncio

import pytest
import httpx
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch, MagicMock
from scheduler import _send_heartbeat, heartbeat_task


def create_mock_response(status_code: int = 200) -> httpx.Response:
    """Create a mock httpx.Response with a request object."""
    request = httpx.Request("POST", "http://test.com")
    return httpx.Response(status_code, request=request)


class TestHeartbeatRetry:
    """ERR-04: Test heartbeat retry mechanism with tenacity."""

    @pytest.mark.asyncio
    async def test_heartbeat_retries_on_connection_error(self):
        """Test that heartbeat retries on connection errors."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=[
            httpx.ConnectError("Connection refused"),
            httpx.ConnectError("Connection refused"),
            create_mock_response(200),
        ])

        await _send_heartbeat(mock_client, "test-token")

        # Should have retried 3 times (initial + 2 retries)
        assert mock_client.post.call_count == 3

    @pytest.mark.asyncio
    async def test_heartbeat_retries_on_timeout(self):
        """Test that heartbeat retries on timeout."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=[
            httpx.TimeoutException("Timed out"),
            create_mock_response(200),
        ])

        await _send_heartbeat(mock_client, "test-token")

        # Should have retried twice
        assert mock_client.post.call_count == 2

    @pytest.mark.asyncio
    async def test_heartbeat_stops_after_max_retries(self):
        """Test that heartbeat stops retrying after max attempts."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=[
            httpx.ConnectError("Connection refused"),
            httpx.ConnectError("Connection refused"),
            httpx.ConnectError("Connection refused"),
        ])

        # Patch asyncio.sleep so tenacity's wait_exponential doesn't slow tests
        with patch('asyncio.sleep', new_callable=AsyncMock):
            # reraise=False: tenacity swallows the error after exhausting retries
            await _send_heartbeat(mock_client, "test-token")

        # Should have tried exactly 3 times (stop_after_attempt(3))
        assert mock_client.post.call_count == 3

    @pytest.mark.asyncio
    async def test_heartbeat_success_on_first_attempt(self):
        """Test that heartbeat succeeds immediately when connection works."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(200))

        await _send_heartbeat(mock_client, "test-token")

        # Should have been called only once
        assert mock_client.post.call_count == 1

    @pytest.mark.asyncio
    async def test_heartbeat_without_token(self):
        """Test that heartbeat works without authentication token."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(200))

        await _send_heartbeat(mock_client, "")

        # Verify headers don't include Authorization
        call_args = mock_client.post.call_args
        headers = call_args.kwargs.get('headers', {})
        assert 'Authorization' not in headers

    @pytest.mark.asyncio
    async def test_heartbeat_task_uses_configured_interval(self, monkeypatch):
        """Test that heartbeat loop sleeps for the configured interval."""
        monkeypatch.setattr('scheduler.settings.heartbeat_interval_seconds', 7)
        sleep_mock = AsyncMock(side_effect=asyncio.CancelledError)

        with patch('scheduler.asyncio.sleep', sleep_mock):
            with pytest.raises(asyncio.CancelledError):
                await heartbeat_task()

        sleep_mock.assert_awaited_once_with(7)


class TestHeartbeatCpuSampling:
    """R4-C P3: cpu_percent(interval=1) blocked the event loop for a full
    second on every heartbeat; sampling now runs in a worker thread."""

    @pytest.mark.asyncio
    async def test_cpu_sampling_executed_with_interval_via_thread(self):
        with patch('scheduler.psutil.cpu_percent', return_value=42.0) as cpu_mock, \
             patch('scheduler.psutil.virtual_memory') as mem_mock:
            mem_mock.return_value = SimpleNamespace(percent=10.0)
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=create_mock_response(200))

            await _send_heartbeat(mock_client, "test-token")

        # positional interval=1 — dispatched through asyncio.to_thread
        assert cpu_mock.call_args.args == (1,)


class TestHeartbeatSelfHeal:
    """R11 (round-11, port of executor-node R10 gap #3): a 401 on the
    heartbeat (admin rotated our per-executor token out from under us) must
    trigger ONE force_token_refresh + retry within the same attempt instead of
    waiting for the 30-minute scheduled refresh."""

    @pytest.mark.asyncio
    async def test_heartbeat_401_heals_and_retries_once(self, monkeypatch):
        import auth as auth_module
        monkeypatch.setattr(
            auth_module, 'force_token_refresh', AsyncMock(return_value='fresh-token')
        )
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=[
            create_mock_response(401),
            create_mock_response(200),
        ])
        with patch('scheduler.psutil.cpu_percent', return_value=1.0), \
             patch('scheduler.psutil.virtual_memory') as mem_mock:
            mem_mock.return_value = SimpleNamespace(percent=2.0)
            await _send_heartbeat(mock_client, 'stale-token')

        # exactly one auth retry: first attempt stale, second the healed token
        assert mock_client.post.call_count == 2
        first = mock_client.post.call_args_list[0].kwargs['headers']
        second = mock_client.post.call_args_list[1].kwargs['headers']
        assert first['Authorization'] == 'Bearer stale-token'
        assert second['Authorization'] == 'Bearer fresh-token'

    @pytest.mark.asyncio
    async def test_heartbeat_401_unchanged_token_adds_no_auth_retry(self, monkeypatch):
        # force_token_refresh yields the SAME token (admin unreachable /
        # idempotent reuse) — the helper adds no retry, so the only posts are
        # tenacity's own transient-failure attempts (3) on the persistent 401.
        import auth as auth_module
        monkeypatch.setattr(
            auth_module, 'force_token_refresh', AsyncMock(return_value='same-token')
        )
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(401))
        with patch('scheduler.psutil.cpu_percent', return_value=1.0), \
             patch('scheduler.psutil.virtual_memory') as mem_mock, \
             patch('asyncio.sleep', new_callable=AsyncMock):
            mem_mock.return_value = SimpleNamespace(percent=2.0)
            # tenacity swallows the final HTTPStatusError via retry_error_callback
            await _send_heartbeat(mock_client, 'same-token')

        assert mock_client.post.call_count == 3


class TestHeartbeatTokenHashAdoption:
    """R9 (round-9, W3): heartbeat responses echo the stored tokenHash
    ({code,message,data:{tokenHash}}) — the executor must adopt it so the
    per-execution callback-token HMAC key follows admin-side rotations."""

    @pytest.mark.asyncio
    async def test_heartbeat_adopts_token_hash_from_envelope(self, monkeypatch):
        import auth as auth_module
        monkeypatch.setattr(auth_module, '_executor_token_hash', None)
        response = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok', 'data': {'tokenHash': 'hb-hash'}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=response)

        await _send_heartbeat(mock_client, 'test-token')

        assert auth_module.get_executor_token_hash() == 'hb-hash'

    @pytest.mark.asyncio
    async def test_heartbeat_without_tokenhash_leaves_state(self, monkeypatch):
        import auth as auth_module
        monkeypatch.setattr(auth_module, '_executor_token_hash', 'keep-me')
        mock_client = AsyncMock()
        # Bare 200 response with no JSON body at all (as create_mock_response)
        mock_client.post = AsyncMock(return_value=create_mock_response(200))

        await _send_heartbeat(mock_client, 'test-token')

        assert auth_module.get_executor_token_hash() == 'keep-me'


class TestHeartbeatRunningExecutionIds:
    """E1 (CONSISTENCY round, port of executor-node STALE-01): admin's
    recoverStaleExecutions grants liveness protection ONLY to executors that
    report runningExecutionIds — a missing field means "legacy executor, never
    reported" and skips the protection (scheduler.service.ts:631), which got
    python executors' prepare stages (git clone + venv, up to ~600s) misjudged
    FAILED. The field must therefore ALWAYS be present (empty list = reported
    & idle), mirror the live-execution registry, and be capped at 200 ids."""

    async def _capture_body(self, mock_client):
        with patch('scheduler.psutil.cpu_percent', return_value=1.0), \
             patch('scheduler.psutil.virtual_memory') as mem_mock:
            mem_mock.return_value = SimpleNamespace(percent=2.0)
            await _send_heartbeat(mock_client, 'test-token')
        return mock_client.post.call_args.kwargs['json']

    @pytest.mark.asyncio
    async def test_heartbeat_includes_live_execution_ids(self):
        import routers.execute as execute_module
        execute_module.register_live_execution('exec-hb-1')
        execute_module.register_live_execution('exec-hb-2')

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(200))
        body = await self._capture_body(mock_client)

        assert sorted(body['runningExecutionIds']) == ['exec-hb-1', 'exec-hb-2']

    @pytest.mark.asyncio
    async def test_heartbeat_idle_reports_empty_list(self):
        # importing routers.execute installs the real provider (module wiring);
        # an empty registry must still send [] — never omit the field
        import routers.execute  # noqa: F401
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(200))
        body = await self._capture_body(mock_client)

        assert 'runningExecutionIds' in body
        assert body['runningExecutionIds'] == []

    @pytest.mark.asyncio
    async def test_heartbeat_truncates_running_execution_ids_to_200(self):
        import routers.execute as execute_module
        for i in range(250):
            execute_module.register_live_execution(f'exec-{i:03d}')

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(200))
        body = await self._capture_body(mock_client)

        assert len(body['runningExecutionIds']) == 200


class TestVersionDriftWarning:
    """EXE-VER-1: 中心端 EXECUTOR_MIN_VERSION 门禁开启且本执行器版本低于下限时，
    心跳响应回显 versionCompliant=false —— 执行器据此打节流告警（10 分钟一条）；
    门禁关闭时回显恒 true，零开销零告警。"""

    @pytest.mark.asyncio
    async def test_heartbeat_body_carries_executor_version(self):
        import scheduler as scheduler_module
        response = create_mock_response(200)
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=response)

        await _send_heartbeat(mock_client, 'test-token')

        body = mock_client.post.call_args.kwargs['json']
        assert body['version'] == scheduler_module.EXECUTOR_VERSION

    @pytest.mark.asyncio
    async def test_warn_helper_throttles_to_one_per_window(self, monkeypatch):
        # 时钟注入：time.monotonic() 基点随进程/机器而异（CI runner 新启动
        # 时仅数秒——`now - 0.0 < 600s` 会让首次告警也被节流，本机开机久则
        # 侥幸通过，曾致本地绿 CI 红的假阴性）。固定 now 与 clock 注入后
        # 断言与运行环境解耦；不用 caplog（传播链配置差异同理）。
        import scheduler as scheduler_module
        monkeypatch.setattr(scheduler_module.time, 'monotonic', lambda: 1_000_000.0)
        monkeypatch.setattr(scheduler_module, '_last_version_drift_warn_at', 0.0)
        warns: list = []
        monkeypatch.setattr(
            scheduler_module.logger, 'warning',
            lambda msg, *a, **k: warns.append(msg % a if a else msg),
        )
        payload = {'versionCompliant': False, 'minVersion': '1.3.0'}

        scheduler_module._warn_version_drift_if_noncompliant(payload)
        scheduler_module._warn_version_drift_if_noncompliant(payload)
        # 超过节流窗（重置节流时间戳）→ 允许下一条
        monkeypatch.setattr(scheduler_module, '_last_version_drift_warn_at', 0.0)
        scheduler_module._warn_version_drift_if_noncompliant(payload)

        drift = [w for w in warns if 'Version drift' in w]
        assert len(drift) == 2
        assert '1.3.0' in drift[0]

    @pytest.mark.asyncio
    async def test_compliant_or_unshaped_payloads_never_warn(self, monkeypatch):
        import scheduler as scheduler_module
        monkeypatch.setattr(scheduler_module, '_last_version_drift_warn_at', 0.0)
        warns: list = []
        monkeypatch.setattr(
            scheduler_module.logger, 'warning',
            lambda msg, *a, **k: warns.append(msg % a if a else msg),
        )

        for payload in (None, {}, {'versionCompliant': True, 'minVersion': '1.3.0'}):
            scheduler_module._warn_version_drift_if_noncompliant(payload)

        assert not [w for w in warns if 'Version drift' in w]


class TestPullDispatch:
    """ARCH-32（ADR-015）+ E-01（P1）预留槽位: pull 派发循环——先原子预留
    一个执行槽位（与 push 派发同一 running 账本）再发长轮询，长轮询窗口内
    push 派发抢不走最后一个空槽；载荷走与 push 完全相同的 accept_execution
    （slot_pre_reserved=True，预留即正式占用）。400（真失败）仍补发 failed
    回调；429（防御路径，账本异常/竞态残余）释放预留但绝不回调 failed。"""

    async def _run_loop_briefly(self, seconds=1.4):
        import scheduler as scheduler_module
        task = asyncio.create_task(scheduler_module.pull_task())
        await asyncio.sleep(seconds)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    def _reset_running_count(self):
        import scheduler as scheduler_module
        scheduler_module.running_count = 0

    async def _setup_common(self, monkeypatch, resp):
        """Patch token/pull 通道：token 走内存 mock（真实 _fetch_token 会向
        admin 发起网络请求——在 localhost 拒连缓慢的机器上会吃掉整个测试时
        间窗，曾致本地绿 CI 红的假阴性），pull 请求返回给定响应。"""
        import scheduler as scheduler_module
        token_mock = AsyncMock(return_value='static-token')
        monkeypatch.setattr(scheduler_module, 'get_current_token', token_mock)

        async def fake_heal(client, method, url, **kwargs):
            self.pull_request_kwargs = kwargs
            self.count_during_pull = scheduler_module.get_running_count()
            return resp

        monkeypatch.setattr(scheduler_module, 'request_with_self_heal', fake_heal)

    @pytest.mark.asyncio
    async def test_pull_loop_reserves_slot_then_delivers_payload(self, monkeypatch):
        import routers.execute as execute_module
        import scheduler as scheduler_module
        self._reset_running_count()
        resp = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok',
                  'data': {'task': {'executionId': 'exec-77', 'task': {'id': 't1'},
                                    'params': {}, 'traceparent': '00-trace-span-01'}}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        await self._setup_common(monkeypatch, resp)
        accept_calls = {}

        def fake_accept(req, tp=None, slot_pre_reserved=False):
            accept_calls['req'] = req
            accept_calls['tp'] = tp
            accept_calls['slot_pre_reserved'] = slot_pre_reserved
            return {'status': 'accepted'}

        monkeypatch.setattr(execute_module, 'accept_execution', fake_accept)

        await self._run_loop_briefly()

        # 预留后发起 pull：长轮询进行中账本已 +1（心跳 runningTaskCount 同源）
        assert self.count_during_pull == 1
        assert self.pull_request_kwargs.get('json', {}).get('waitMs') == 25000
        assert accept_calls['req'].executionId == 'exec-77'
        assert accept_calls['tp'] == '00-trace-span-01'
        # 预留即正式占用：accept 必须收到预留模式标记，且 pull 循环不再释放
        # （账本保持 +1，由执行完成路径归还）
        assert accept_calls['slot_pre_reserved'] is True
        assert scheduler_module.get_running_count() == 1
        self._reset_running_count()

    @pytest.mark.asyncio
    async def test_pull_loop_no_task_releases_reservation(self, monkeypatch):
        import routers.execute as execute_module
        import scheduler as scheduler_module
        self._reset_running_count()
        resp = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok', 'data': {'task': None}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        await self._setup_common(monkeypatch, resp)
        accept_mock = MagicMock()
        monkeypatch.setattr(execute_module, 'accept_execution', accept_mock)

        await self._run_loop_briefly()

        assert accept_mock.call_count == 0
        # 空窗口：预留立即归还，账本归零
        assert scheduler_module.get_running_count() == 0

    @pytest.mark.asyncio
    async def test_pull_loop_rejection_400_sends_failed_callback_and_releases(self, monkeypatch):
        """accept 因非容量原因（400 校验失败）被拒：释放预留 + 维持既有
        failed 回调语义（真失败，admin 侧不留僵尸 RUNNING 行）。"""
        import routers.execute as execute_module
        import scheduler as scheduler_module
        self._reset_running_count()
        resp = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok',
                  'data': {'task': {'executionId': 'exec-78', 'task': {'id': 't1'}}}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        await self._setup_common(monkeypatch, resp)

        def fake_accept(req, tp=None, slot_pre_reserved=False):
            raise execute_module.ExecutionRejected(400, 'already active')

        monkeypatch.setattr(execute_module, 'accept_execution', fake_accept)
        rejections = []

        async def fake_reject(eid, reason, tp=None):
            rejections.append((eid, reason))

        monkeypatch.setattr(execute_module, 'reject_pulled_execution', fake_reject)

        await self._run_loop_briefly()

        assert rejections == [('exec-78', 'already active')]
        # 预留已释放，账本归零
        assert scheduler_module.get_running_count() == 0

    @pytest.mark.asyncio
    async def test_pull_loop_rejection_429_defense_releases_without_callback(self, monkeypatch):
        """防御路径（账本异常/竞态残余，正常流程不可达）：释放预留 + warning，
        绝不回调 failed——瞬态容量问题不得固化成 admin 侧永久失败，孤儿
        RUNNING 行由 admin 侧 stale sweep 兜底收敛。"""
        import routers.execute as execute_module
        import scheduler as scheduler_module
        self._reset_running_count()
        resp = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok',
                  'data': {'task': {'executionId': 'exec-429', 'task': {'id': 't1'}}}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        await self._setup_common(monkeypatch, resp)

        def fake_accept(req, tp=None, slot_pre_reserved=False):
            raise execute_module.ExecutionRejected(429, 'Executor is at capacity')

        monkeypatch.setattr(execute_module, 'accept_execution', fake_accept)
        rejections = []

        async def fake_reject(eid, reason, tp=None):
            rejections.append((eid, reason))

        monkeypatch.setattr(execute_module, 'reject_pulled_execution', fake_reject)
        warns = []
        monkeypatch.setattr(
            scheduler_module.logger, 'warning',
            lambda msg, *a, **k: warns.append(msg % a if a else msg),
        )

        await self._run_loop_briefly()

        assert rejections == []  # 不补发 failed 回调
        assert any('429 despite pre-reserved slot' in w for w in warns)
        # 预留已释放，账本归零
        assert scheduler_module.get_running_count() == 0

    @pytest.mark.asyncio
    async def test_pull_loop_pull_error_releases_reservation(self, monkeypatch):
        import routers.execute as execute_module
        import scheduler as scheduler_module
        self._reset_running_count()
        resp = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok',
                  'data': {'task': {'executionId': 'exec-77', 'task': {'id': 't1'}}}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        token_mock = AsyncMock(return_value='static-token')
        monkeypatch.setattr(scheduler_module, 'get_current_token', token_mock)

        async def failing_heal(client, method, url, **kwargs):
            raise httpx.ConnectError('connection refused')

        monkeypatch.setattr(scheduler_module, 'request_with_self_heal', failing_heal)
        monkeypatch.setattr(execute_module, 'accept_execution', MagicMock())

        await self._run_loop_briefly()

        assert scheduler_module.get_running_count() == 0

    @pytest.mark.asyncio
    async def test_pull_loop_skips_polling_at_capacity(self, monkeypatch):
        import scheduler as scheduler_module
        self._reset_running_count()
        monkeypatch.setattr(scheduler_module.settings, 'max_concurrent_tasks', 0)

        async def fail_heal(client, method, url, **kwargs):
            raise AssertionError('must not poll at capacity')

        monkeypatch.setattr(scheduler_module, 'request_with_self_heal', fail_heal)

        await self._run_loop_briefly(0.6)


# ---------------------------------------------------------------------------
# E-37（DEEP_REVIEW 0ef3bbe）：执行器版本号双事实源收敛。
# python 侧 config.EXECUTOR_VERSION 是唯一常量源；main.py 的 FastAPI version
# 与 register/心跳上报都必须复用它，不得再各写一个字面量。
# ---------------------------------------------------------------------------


def test_executor_version_is_the_single_source_for_the_fastapi_app():
    import main as main_module
    from config import EXECUTOR_VERSION

    assert main_module.app.version == EXECUTOR_VERSION


def test_executor_version_looks_like_a_release_version():
    from config import EXECUTOR_VERSION

    # 中心端 EXECUTOR_MIN_VERSION 门禁按点分数字比较（畸形值会被判为不合规），
    # 因此常量必须是 x.y.z 形态而不是占位符。
    assert isinstance(EXECUTOR_VERSION, str)
    assert EXECUTOR_VERSION.count('.') == 2
    assert all(part.isdigit() for part in EXECUTOR_VERSION.split('.')), EXECUTOR_VERSION


def test_register_and_heartbeat_report_the_same_version():
    """register 与心跳必须同源上报（EXE-VER-1 的单一上报源约定）。"""
    import inspect

    import main as main_module
    import scheduler as scheduler_module

    # E-37（DEEP_REVIEW 0ef3bbe）：注册载荷经 _register_payload() 组装（其内部
    # 与心跳均从 config.EXECUTOR_VERSION 取版本）。断言同源即可，不要求字面量
    # 出现在 register_executor 函数体内——注册与心跳都绑定同一 config 常量。
    register_payload_src = inspect.getsource(main_module._register_payload)
    register_src = inspect.getsource(main_module.register_executor)
    heartbeat_src = inspect.getsource(scheduler_module)

    assert 'EXECUTOR_VERSION' in register_payload_src  # 注册载荷单源
    assert '_register_payload' in register_src  # register 经该 helper 上报
    assert 'EXECUTOR_VERSION' in heartbeat_src  # 心跳同源


# --------------------------------------------------------------------------
# HEALTH-01（本轮审计）：routers/health.record_heartbeat 此前是**死代码**
# （全仓唯一命中就是它自己的定义），没有任何调用方。
# 后果：
#   - /health 的 _admin_api_reachable 恒为 None，于是每次探针都退化成一次
#     5s 超时的实时外呼（docstring 声称「Use cached reachability」是假的）；
#   - lastHeartbeat 恒为 null，运维无从据此判断心跳链路是否健康。
# --------------------------------------------------------------------------


def test_record_heartbeat_has_a_real_call_site():
    """record_heartbeat 必须真的被心跳任务调用，而不是只被定义。"""
    import inspect

    import scheduler as scheduler_module

    src = inspect.getsource(scheduler_module.heartbeat_task)
    assert 'record_heartbeat(' in src, 'heartbeat_task 必须回灌心跳结果'
    # 成功与失败两条路径都要上报（否则失败时健康面仍显示旧的成功态）
    assert 'record_heartbeat(True)' in src
    assert 'record_heartbeat(False)' in src


def test_record_heartbeat_updates_health_state():
    from routers import health as health_module

    health_module._last_heartbeat_time = None
    health_module._admin_api_reachable = None

    health_module.record_heartbeat(True)
    assert health_module._admin_api_reachable is True
    assert health_module._last_heartbeat_time is not None

    health_module.record_heartbeat(False)
    assert health_module._admin_api_reachable is False
    # 失败不清掉上次成功时间（用于判断「曾经通过、现在断了」）
    assert health_module._last_heartbeat_time is not None


@pytest.mark.asyncio
async def test_heartbeat_task_feeds_health_on_success(monkeypatch):
    """/health 的缓存态必须由真实心跳结果填充（而不是永远 None）。"""
    from routers import health as health_module
    import scheduler as scheduler_module

    health_module._admin_api_reachable = None
    health_module._last_heartbeat_time = None

    async def fake_send(client, token, trace_id=None):
        return None  # 不抛错即代表一次成功的心跳

    monkeypatch.setattr(scheduler_module, '_send_heartbeat', fake_send)
    monkeypatch.setattr(
        scheduler_module, 'get_current_token', AsyncMock(return_value='t')
    )
    # 只把心跳间隔压到 0 —— 不要 monkeypatch asyncio.sleep 本身：那是同一个
    # 全局模块对象，会把测试自己的等待也变成空转，从而饿死事件循环并挂住。
    monkeypatch.setattr(scheduler_module.settings, 'heartbeat_interval_seconds', 0)

    task = asyncio.create_task(scheduler_module.heartbeat_task())
    try:
        for _ in range(100):
            await asyncio.sleep(0.01)
            if health_module._admin_api_reachable is not None:
                break
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert health_module._admin_api_reachable is True, (
        '心跳成功跑过之后 /health 的缓存态应为 True，而不是仍为 None'
    )
    assert health_module._last_heartbeat_time is not None


@pytest.mark.asyncio
async def test_heartbeat_task_feeds_health_on_failure(monkeypatch):
    """心跳失败必须把 /health 的缓存态置为 False（而不是停留在旧的成功态）。"""
    from routers import health as health_module
    import scheduler as scheduler_module

    health_module._admin_api_reachable = True  # 旧的成功态

    async def boom(client, token, trace_id=None):
        raise RuntimeError('admin down')

    monkeypatch.setattr(scheduler_module, '_send_heartbeat', boom)
    monkeypatch.setattr(
        scheduler_module, 'get_current_token', AsyncMock(return_value='t')
    )
    monkeypatch.setattr(scheduler_module.settings, 'heartbeat_interval_seconds', 0)

    task = asyncio.create_task(scheduler_module.heartbeat_task())
    try:
        for _ in range(100):
            await asyncio.sleep(0.01)
            if health_module._admin_api_reachable is False:
                break
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert health_module._admin_api_reachable is False
