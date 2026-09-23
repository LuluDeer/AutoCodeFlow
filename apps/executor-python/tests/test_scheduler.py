import asyncio
import re
from pathlib import Path

import pytest
import httpx
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch, MagicMock
from scheduler import _send_heartbeat, heartbeat_task, _http_client_by_loop
# ARCH-33（ADR-016）：控制面命令分派模块（命令执行/回报路径的桩目标）
import commands as commands_module


def test_get_http_client_pins_trust_env_false(monkeypatch):
    """NETOPT-E P3-4: 共享 pull/heartbeat client 必须 trust_env=False（内部
    通道不经系统代理）；被误删/改成 True 时本测试立即红。"""
    captured = {}

    def factory(*args, **kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setattr("scheduler.httpx.AsyncClient", factory)
    _http_client_by_loop.clear()
    client = _get_http_client_for_test()
    assert captured.get("trust_env") is False
    assert captured.get("timeout") == 10.0
    _http_client_by_loop.clear()


def _get_http_client_for_test():
    # get_http_client 需要 running loop；pytest-asyncio 同步用例下没有。
    # 用 asyncio.run 包装，模拟生产调用上下文。
    import asyncio
    import scheduler
    return asyncio.run(_get_in_loop())


async def _get_in_loop():
    import scheduler
    return scheduler.get_http_client()


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
    & idle), mirror the live-execution registry, and be capped at
    MAX_RUNNING_EXECUTION_IDS (10000, node parity — NETOPT-C P2-1)."""

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
    async def test_heartbeat_caps_running_execution_ids_at_max(self):
        """NETOPT-C P2-1 对齐：封顶值 = MAX_RUNNING_EXECUTION_IDS（10000），
        **不是** 200。

        反证（本用例的原意）：旧实现截断到 200，故「注册 250 个 → 上报 200 个」
        曾是期望行为。若这里回退成 200，并发 >200 的第 201+ 个在跑执行会从
        心跳里消失，admin stale sweep 的活性判据（id 是否在数组里）随之失配，
        健康长跑的任务被提前恢复成 FAILED——正是 E1 引入该字段要消灭的误判。
        故此处断言「250 个 id 必须**全部**上报」，200 会被这条用例直接判红。
        """
        import routers.execute as execute_module
        for i in range(250):
            execute_module.register_live_execution(f'exec-{i:03d}')

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(200))
        body = await self._capture_body(mock_client)

        assert len(body['runningExecutionIds']) == 250, (
            'NETOPT-C P2-1: 并发 >200 时 ids 必须全部上报（旧 200 封顶会让'
            '第 201+ 个在跑执行失去 stale sweep 的活性宽限）'
        )

    @pytest.mark.asyncio
    async def test_heartbeat_cap_matches_node_and_admin_bound(self):
        """三端同值守卫：python 封顶必须 === node/admin 的 10000。

        跨端漂移是本次缺陷的根因（python 抄了个不存在的 "node parity" 200），
        故这里把「执行器侧封顶」与「中台采纳上界」钉在一起：任一端改数而另一端
        不改，本用例立即红。node 侧对应常量见 apps/executor-node/src/scheduler.ts
        的 MAX_RUNNING_EXECUTION_IDS，admin 侧见 executor.service.ts 同名常量。
        """
        import scheduler as scheduler_module
        assert scheduler_module.MAX_RUNNING_EXECUTION_IDS == 10_000

        # 与 admin/node 源码里的常量逐字比对（读源码而非硬编码单一数字：两端都改才绿）
        repo_root = Path(__file__).resolve().parents[3]
        admin_service = (
            repo_root
            / 'apps' / 'admin-api' / 'src' / 'modules' / 'executor' / 'executor.service.ts'
        )
        node_scheduler = (
            repo_root / 'apps' / 'executor-node' / 'src' / 'scheduler.ts'
        )
        for path, label in ((admin_service, 'admin-api'), (node_scheduler, 'executor-node')):
            source = path.read_text(encoding='utf-8')
            assert re.search(r'MAX_RUNNING_EXECUTION_IDS\s*=\s*10_000', source), (
                f'{label} 的 MAX_RUNNING_EXECUTION_IDS 不再是 10_000——'
                f'与 python 侧封顶漂移（{path}）'
            )

    @pytest.mark.asyncio
    async def test_heartbeat_overflow_is_trimmed_to_cap(self):
        """超过封顶时截到 MAX_RUNNING_EXECUTION_IDS（而非无界上报）。

        反证有牙：封顶本身仍必须存在——无界上报会把心跳体推向 admin 的 1mb
        body 上限（413 → 中台判执行器 OFFLINE，比少报 id 更严重）。
        """
        import scheduler as scheduler_module
        import routers.execute as execute_module

        provider_calls = []

        def _huge_provider():
            provider_calls.append(1)
            return [f'exec-{i:05d}' for i in range(scheduler_module.MAX_RUNNING_EXECUTION_IDS + 37)]

        original = execute_module.list_active_execution_ids
        try:
            scheduler_module.register_running_execution_ids_provider(_huge_provider)
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=create_mock_response(200))
            body = await self._capture_body(mock_client)
            assert len(body['runningExecutionIds']) == scheduler_module.MAX_RUNNING_EXECUTION_IDS
        finally:
            # provider 是模块级粘性状态，必须还原，否则污染后续用例
            scheduler_module.register_running_execution_ids_provider(original)

    @pytest.mark.asyncio
    async def test_heartbeat_provider_failure_degrades_to_empty_list(self):
        """反证：provider 抛异常时上报 []，绝不整条心跳失败。

        心跳是活性上报的**唯一**通道——若 provider 抖动导致心跳请求本身失败，
        中台会在 30s×3 窗口后把执行器判 OFFLINE，派发静默停止，代价远大于
        少报一轮 id。
        """
        import scheduler as scheduler_module

        def _boom():
            raise RuntimeError('registry corrupted')

        original = scheduler_module._running_execution_ids_provider
        try:
            scheduler_module.register_running_execution_ids_provider(_boom)
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=create_mock_response(200))
            body = await self._capture_body(mock_client)
            assert body['runningExecutionIds'] == []
        finally:
            scheduler_module.register_running_execution_ids_provider(original)

    @pytest.mark.asyncio
    async def test_heartbeat_provider_non_list_degrades_to_empty_list(self):
        """反证：provider 返回非列表（如 dict/None）时同样收敛为 []。"""
        import scheduler as scheduler_module

        original = scheduler_module._running_execution_ids_provider
        try:
            scheduler_module.register_running_execution_ids_provider(lambda: {'not': 'a list'})
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=create_mock_response(200))
            body = await self._capture_body(mock_client)
            assert body['runningExecutionIds'] == []
        finally:
            scheduler_module.register_running_execution_ids_provider(original)


class TestHeartbeatReservedSlots:
    """E-01-RPT（生产实证：RPA5 执行器在中台恒显「当前运行任务 1/10」「活性上报
    0 条，与运行计数 1 不一致」，而该设备上并没有在执行的任务）。

    根因：E-01 让 pull 循环在发起 25s 长轮询【之前】先原子预留一个槽位
    （try_reserve_running_slot），预留计入同一个 running 账本——所以
    runningTaskCount 诚实包含它。但 runningExecutionIds 来自另一个账本
    （_live_executions），空闲执行器稳态就是「1 + []」。两个数字都对，却度量了
    不同的东西。修法：把「预留中」的槽位数单独上报（reservedSlots），中台据此
    把「已占槽位」换算成「实际运行 = runningTaskCount − reservedSlots」。

    字段必须**始终发送**（含 0）——缺席 = 旧版执行器未上报，中台回落旧口径。
    """

    async def _capture_body(self, mock_client):
        with patch('scheduler.psutil.cpu_percent', return_value=1.0), \
             patch('scheduler.psutil.virtual_memory') as mem_mock:
            mem_mock.return_value = SimpleNamespace(percent=2.0)
            await _send_heartbeat(mock_client, 'test-token')
        return mock_client.post.call_args.kwargs['json']

    @pytest.mark.asyncio
    async def test_heartbeat_reports_reserved_slots_always_present(self):
        import scheduler as scheduler_module
        scheduler_module._pull_reserved_slots = 0

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(200))
        body = await self._capture_body(mock_client)

        # 始终发送（含 0）——缺席会让中台无法区分「旧执行器」与「无预留」。
        assert 'reservedSlots' in body
        assert body['reservedSlots'] == 0

    @pytest.mark.asyncio
    async def test_heartbeat_reports_active_pull_reservation(self):
        """反证生产现场：预留 1 + 活性 0 —— 两个字段必须同处一份心跳，中台才能
        靠 reservedSlots 把「1/10」还原成「实际运行 0」。"""
        import scheduler as scheduler_module
        import routers.execute  # noqa: F401 - 装上真实 provider（空注册表）
        # 忠实复刻 pull_task 的预留两连：账本 +1（runningTaskCount 的来源）
        # 与预留计数 +1（reservedSlots 的来源）——两者必须同点发生。
        assert scheduler_module.try_reserve_running_slot() is True
        scheduler_module._track_pull_reservation()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(200))
        body = await self._capture_body(mock_client)

        assert body['reservedSlots'] == 1
        assert body['runningTaskCount'] == 1
        assert body['runningExecutionIds'] == []
        scheduler_module._pull_reserved_slots = 0
        scheduler_module.running_count = 0

    def test_reservation_tracking_is_clamped_at_zero(self):
        """反证：预留计数是纯防御性的 0/1 量——重复撤销不得变成负数（负数上报会
        让中台算出比真值大的「实际运行数」，比误报不一致更糟）。"""
        import scheduler as scheduler_module
        scheduler_module._pull_reserved_slots = 0

        scheduler_module._untrack_pull_reservation()
        assert scheduler_module.get_pull_reserved_slots() == 0

        scheduler_module._track_pull_reservation()
        assert scheduler_module.get_pull_reserved_slots() == 1
        scheduler_module._untrack_pull_reservation()
        scheduler_module._untrack_pull_reservation()
        assert scheduler_module.get_pull_reserved_slots() == 0


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
            # E-01-RPT: 同时捕获长轮询【进行中】的预留上报值。
            self.reserved_during_pull = scheduler_module.get_pull_reserved_slots()
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
        # E-01-RPT: 同一时刻必须上报 reservedSlots=1——否则中台只能看到
        # 「计数 1 + 活性 0 条」并恒亮不一致告警（RPA5 生产现象）。
        assert self.reserved_during_pull == 1
        assert self.pull_request_kwargs.get('json', {}).get('waitMs') == 25000
        assert accept_calls['req'].executionId == 'exec-77'
        assert accept_calls['tp'] == '00-trace-span-01'
        # 预留即正式占用：accept 必须收到预留模式标记，且 pull 循环不再释放
        # （账本保持 +1，由执行完成路径归还）
        assert accept_calls['slot_pre_reserved'] is True
        assert scheduler_module.get_running_count() == 1
        self._reset_running_count()

    @pytest.mark.asyncio
    async def test_pull_loop_reports_reservation_during_long_poll(self, monkeypatch):
        """E-01-RPT: 长轮询【进行中】必须上报 reservedSlots=1——这正是生产现场
        「runningTaskCount=1 + runningExecutionIds=[]」里那个 1 的来源，也是中台
        能把它从「实际运行数」里扣除的唯一依据。"""
        import routers.execute as execute_module
        import scheduler as scheduler_module
        self._reset_running_count()
        scheduler_module._pull_reserved_slots = 0
        resp = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok', 'data': {'task': None}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        await self._setup_common(monkeypatch, resp)
        monkeypatch.setattr(execute_module, 'accept_execution', MagicMock())

        await self._run_loop_briefly()

        # 空窗口归还后归零（否则中台会把空闲执行器永久显示成占用）。
        assert scheduler_module.get_pull_reserved_slots() == 0

    @pytest.mark.asyncio
    async def test_pull_loop_clears_reservation_after_claim(self, monkeypatch):
        """反证：领取成功后预留必须撤销——该执行此后由 runningExecutionIds 代表。
        若不撤销，中台会把它从实际运行数里再减一次（显示比真值少 1）。"""
        import routers.execute as execute_module
        import scheduler as scheduler_module
        self._reset_running_count()
        scheduler_module._pull_reserved_slots = 0
        resp = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok',
                  'data': {'task': {'executionId': 'exec-own', 'task': {}}}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        await self._setup_common(monkeypatch, resp)
        monkeypatch.setattr(execute_module, 'accept_execution',
                            lambda req, tp=None, slot_pre_reserved=False: {'status': 'accepted'})

        await self._run_loop_briefly()

        assert scheduler_module.get_pull_reserved_slots() == 0
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
    async def test_pull_loop_polls_at_capacity_with_free_slots_zero(self, monkeypatch):
        """ARCH-33（ADR-016）：满载语义**已改变**。

        旧实现满载时 `continue`，连长轮询都不发。若沿用，执行器满载时控制面
        命令（deploy/stop/config-reload）永远送不到——运维操作静默失效。
        现在满载仍长轮询，但上报 freeSlots=0，服务端据此只发命令、不派任务。
        """
        import scheduler as scheduler_module
        self._reset_running_count()
        monkeypatch.setattr(scheduler_module.settings, 'max_concurrent_tasks', 0)
        resp = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok', 'data': {'task': None}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        await self._setup_common(monkeypatch, resp)

        await self._run_loop_briefly(1.4)

        # 满载仍发起了 pull，且如实上报 freeSlots=0
        assert self.pull_request_kwargs.get('json', {}).get('freeSlots') == 0
        # 未预留槽位：账本保持 0（max=0，本就无槽可留）
        assert scheduler_module.get_running_count() == 0

    @pytest.mark.asyncio
    async def test_pull_loop_reports_free_slots_when_idle(self, monkeypatch):
        """有空槽时 freeSlots 如实上报（预留后的实际空闲数）。"""
        import scheduler as scheduler_module
        self._reset_running_count()
        monkeypatch.setattr(scheduler_module.settings, 'max_concurrent_tasks', 3)
        resp = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok', 'data': {'task': None}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        await self._setup_common(monkeypatch, resp)

        await self._run_loop_briefly(1.4)

        # 预留已计入账本（1），故 3 - 1 = 2
        assert self.pull_request_kwargs.get('json', {}).get('freeSlots') == 2

    @pytest.mark.asyncio
    async def test_pull_loop_at_capacity_does_not_claim_task(self, monkeypatch):
        """ARCH-33: 满载轮若仍被带回任务（旧中台不认识 freeSlots），**不领取**。

        没有槽位就执行会把瞬态容量问题固化成执行失败（E-01 关闭的那类问题）。
        载荷留给 admin 侧 stale sweep 收敛。
        """
        import routers.execute as execute_module
        import scheduler as scheduler_module
        self._reset_running_count()
        monkeypatch.setattr(scheduler_module.settings, 'max_concurrent_tasks', 0)
        resp = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok',
                  'data': {'task': {'executionId': 'exec-at-cap', 'task': {'id': 't1'}}}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        await self._setup_common(monkeypatch, resp)
        accept_mock = MagicMock()
        monkeypatch.setattr(execute_module, 'accept_execution', accept_mock)

        await self._run_loop_briefly(1.4)

        assert accept_mock.call_count == 0
        assert scheduler_module.get_running_count() == 0


class TestPullControlCommands:
    """ARCH-33（ADR-016）：pull 控制面命令通道。

    固化四条关键不变量：
      ① 命令在**任何** continue 之前被执行（含「无任务」与「满载」两条早退路径）；
      ② 逐条串行执行（app-uninstall 依赖同批 app-stop 的时序）；
      ③ 结果逐条回报 /executors/command-result，上报失败不影响主循环；
      ④ 畸形条目丢弃且不执行。
    """

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
        import scheduler as scheduler_module
        monkeypatch.setattr(
            scheduler_module, 'get_current_token',
            AsyncMock(return_value='static-token'),
        )

        async def fake_heal(client, method, url, **kwargs):
            self.pull_request_kwargs = kwargs
            return resp

        monkeypatch.setattr(scheduler_module, 'request_with_self_heal', fake_heal)

    def _resp(self, commands, task=None):
        return httpx.Response(
            200,
            json={'code': 0, 'message': 'ok',
                  'data': {'task': task, 'commands': commands}},
            request=httpx.Request('POST', 'http://test.com'),
        )

    @pytest.mark.asyncio
    async def test_commands_executed_on_idle_round(self, monkeypatch):
        """无任务轮也执行命令（命令不得随早退路径丢弃）。"""
        import scheduler as scheduler_module
        self._reset_running_count()
        await self._setup_common(monkeypatch, self._resp([
            {'commandId': 'c1', 'type': 'config-reload', 'payload': {}},
        ]))

        executed = []

        async def fake_run(raw_commands):
            for raw in raw_commands:
                executed.append(raw['commandId'])

        monkeypatch.setattr(scheduler_module, 'run_control_commands', fake_run)

        await self._run_loop_briefly()

        assert 'c1' in executed

    @pytest.mark.asyncio
    async def test_commands_executed_at_capacity(self, monkeypatch):
        """满载轮同样执行命令（freeSlots=0 只挡任务，不挡命令）。"""
        import routers.execute as execute_module
        import scheduler as scheduler_module
        self._reset_running_count()
        monkeypatch.setattr(scheduler_module.settings, 'max_concurrent_tasks', 0)
        await self._setup_common(monkeypatch, self._resp([
            {'commandId': 'c2', 'type': 'config-reload', 'payload': {}},
        ]))
        accept_mock = MagicMock()
        monkeypatch.setattr(execute_module, 'accept_execution', accept_mock)

        executed = []

        async def fake_run(raw_commands):
            for raw in raw_commands:
                executed.append(raw['commandId'])

        monkeypatch.setattr(scheduler_module, 'run_control_commands', fake_run)

        await self._run_loop_briefly(1.4)

        assert 'c2' in executed
        assert accept_mock.call_count == 0

    @pytest.mark.asyncio
    async def test_commands_processed_before_task(self, monkeypatch):
        """命令与任务同批：命令先执行，任务照常领取。"""
        import routers.execute as execute_module
        import scheduler as scheduler_module
        self._reset_running_count()
        order = []
        await self._setup_common(monkeypatch, self._resp(
            [{'commandId': 'c3', 'type': 'config-reload', 'payload': {}}],
            task={'executionId': 'exec-with-cmd', 'task': {'id': 't1'}},
        ))

        async def fake_run(_raw):
            order.append('command')

        def fake_accept(req, tp=None, slot_pre_reserved=False):
            order.append('accept')
            return {'status': 'accepted'}

        monkeypatch.setattr(scheduler_module, 'run_control_commands', fake_run)
        monkeypatch.setattr(execute_module, 'accept_execution', fake_accept)

        await self._run_loop_briefly()

        assert order[:2] == ['command', 'accept']
        self._reset_running_count()

    @pytest.mark.asyncio
    async def test_malformed_commands_discarded(self, monkeypatch):
        """畸形条目丢弃且不执行（缺 commandId / 未知 type / 非 dict）。"""
        import scheduler as scheduler_module
        self._reset_running_count()
        executed = []
        await self._setup_common(monkeypatch, self._resp([
            {'type': 'config-reload', 'payload': {}},   # 缺 commandId
            {'commandId': 'x', 'type': 'evil'},         # 未知 type
            'not-a-dict',
            {'commandId': 'ok1', 'type': 'config-reload', 'payload': {}},
        ]))

        async def fake_execute(command):
            executed.append(command['commandId'])
            return {'commandId': command['commandId'], 'type': command['type'],
                    'ok': True, 'durationMs': 1}

        reported = []

        async def fake_report(result):
            reported.append(result['commandId'])

        monkeypatch.setattr(commands_module, 'execute_control_command', fake_execute)
        monkeypatch.setattr(commands_module, 'report_command_result', fake_report)

        await self._run_loop_briefly()

        assert 'ok1' in executed
        assert all(cid == 'ok1' for cid in executed)
        assert 'ok1' in reported

    @pytest.mark.asyncio
    async def test_command_execution_error_does_not_break_loop(self, monkeypatch):
        """命令执行抛错：不冒泡到 pull 循环（下一轮继续取件）。"""
        import scheduler as scheduler_module
        self._reset_running_count()
        await self._setup_common(monkeypatch, self._resp([
            {'commandId': 'c9', 'type': 'config-reload', 'payload': {}},
        ]))

        async def boom(_raw):
            raise RuntimeError('command pipeline exploded')

        monkeypatch.setattr(scheduler_module, 'run_control_commands', boom)
        warns = []
        monkeypatch.setattr(
            scheduler_module.logger, 'warning',
            lambda msg, *a, **k: warns.append(msg % a if a else msg),
        )

        await self._run_loop_briefly(1.4)

        # 异常被 pull 循环的 except 吞掉并记 warn，循环存活
        assert any('Pull failed' in w for w in warns)
        assert scheduler_module.get_running_count() == 0

    @pytest.mark.asyncio
    async def test_old_admin_without_commands_field_is_unchanged(self, monkeypatch):
        """旧中台（无 commands 字段）：行为逐字节不变。"""
        import routers.execute as execute_module
        import scheduler as scheduler_module
        self._reset_running_count()
        resp = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok',
                  'data': {'task': {'executionId': 'legacy', 'task': {'id': 't1'}}}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        await self._setup_common(monkeypatch, resp)
        accept_mock = MagicMock(return_value={'status': 'accepted'})
        monkeypatch.setattr(execute_module, 'accept_execution', accept_mock)

        await self._run_loop_briefly()

        assert accept_mock.call_count >= 1
        self._reset_running_count()


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
