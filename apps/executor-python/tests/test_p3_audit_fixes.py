"""P2-7 / P3 批（执行器服务审计 2026-10-26）的修复钉住测试。

- P2-7：包下载重定向逐跳 SSRF 复检（合法首跳 → 302 内网地址 → 拒绝）；
- P3-12：CALLBACK_LOGS_MAX_CHARS 钳到 admin 512000 上限；
- P3-13：解释器失败快照 4KB 预钳（镜像 node clampCallbackResult）；
- P3-14：_run_uv bounded 累积（10MB 上限 + 截断标记）；
- P3-18：runtime=node + requirements 在 prepare 期快速失败。
"""
import asyncio
import sys
from pathlib import Path

import httpx
import pytest

from routers import execute as execute_module
from config import settings

# ---------------------------------------------------------------------------
# P2-7：重定向逐跳 SSRF 复检
# ---------------------------------------------------------------------------


def _patch_http_transport(monkeypatch, handler):
    class PatchedClient(httpx.AsyncClient):
        def __init__(self, *a, **k):
            k['transport'] = httpx.MockTransport(handler)
            super().__init__(*a, **k)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', PatchedClient)


class TestRedirectSsrfRecheck:
    """P2-7：首跳合法不代表目标可信——每跳必须重跑 _host_is_restricted。"""

    def test_legal_first_hop_redirect_to_private_ip_is_rejected(
            self, tmp_path, monkeypatch):
        seen = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            if request.url.host == 'admin.example':
                return httpx.Response(
                    302, headers={'Location': 'http://10.0.0.5/secret'})
            return httpx.Response(200, content=b'internal-bytes')

        _patch_http_transport(monkeypatch, handler)
        dest = tmp_path / '.package.zip'

        with pytest.raises(RuntimeError, match='受限网络'):
            asyncio.run(execute_module._download_package(
                'http://admin.example/packages/p.zip', dest))
        # 只打到首跳；内网地址绝不曾被请求
        assert seen == ['http://admin.example/packages/p.zip']
        assert not dest.exists()

    def test_legal_first_hop_redirect_to_loopback_is_rejected(
            self, tmp_path, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == 'admin.example':
                return httpx.Response(
                    302, headers={'Location': 'http://127.0.0.1:8500/metadata'})
            return httpx.Response(200, content=b'x')

        _patch_http_transport(monkeypatch, handler)
        with pytest.raises(RuntimeError, match='受限网络'):
            asyncio.run(execute_module._download_package(
                'http://admin.example/packages/p.zip', tmp_path / '.package.zip'))

    def test_same_host_redirect_still_followed(self, tmp_path, monkeypatch):
        """回归对照：合法的同 host 重定向照常跟随（修复不得误杀正常链）。

        用 IP 字面量而非假域名：SSRF 守卫做真实 DNS 解析且 fail-closed
        （解析不出即拒），测试不能依赖外网 DNS。"""
        seen = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            if request.url.path == '/first':
                return httpx.Response(302, headers={'Location': '/second.zip'})
            return httpx.Response(200, content=b'ok-bytes')

        _patch_http_transport(monkeypatch, handler)
        size = asyncio.run(execute_module._download_package(
            'http://93.184.216.34/first', tmp_path / '.package.zip'))
        assert size == len(b'ok-bytes')
        assert len(seen) == 2


# ---------------------------------------------------------------------------
# P3-12：CALLBACK_LOGS_MAX_CHARS 钳到 admin 上限
# ---------------------------------------------------------------------------


class TestCallbackLogsMaxCharsClamp:
    """P3-12：超限配置毒丸化整批回调——读取处钳 512000 + warn。"""

    def test_default_10000_unchanged(self, monkeypatch):
        monkeypatch.setattr(settings, 'callback_logs_max_chars', 10000)
        assert execute_module._callback_logs_max_chars() == 10000

    def test_zero_and_garbage_fall_back_to_10000(self, monkeypatch):
        monkeypatch.setattr(settings, 'callback_logs_max_chars', 0)
        assert execute_module._callback_logs_max_chars() == 10000
        monkeypatch.setattr(settings, 'callback_logs_max_chars', 'abc')
        assert execute_module._callback_logs_max_chars() == 10000

    def test_oversized_config_clamped_to_admin_cap(self, monkeypatch):
        monkeypatch.setattr(settings, 'callback_logs_max_chars', 600_000)
        assert execute_module._callback_logs_max_chars() == 512_000

    def test_admin_cap_itself_allowed(self, monkeypatch):
        monkeypatch.setattr(settings, 'callback_logs_max_chars', 512_000)
        assert execute_module._callback_logs_max_chars() == 512_000

    def test_admin_cap_constant_matches_node_dto(self):
        """对齐 admin CallbackItemDto @MaxLength(512_000)——常量漂移即红。"""
        assert execute_module.CALLBACK_LOGS_ADMIN_MAX_CHARS == 512_000


# ---------------------------------------------------------------------------
# P3-13：解释器失败快照 4KB 预钳
# ---------------------------------------------------------------------------


class TestInterpreterResultClamp:
    """P3-13：pool.versions 撑爆 4KB 时整批回调被拒——发送前预钳。"""

    def _make_result(self, versions):
        exc = RuntimeError('No interpreter found for Python 3.7')
        return execute_module._interpreter_failure_result(
            '3.7', exc,
            {'install_dir': '/data/interpreters', 'versions': versions},
            started_at=__import__('time').monotonic(),
            execution_id='exec-clamp',
        )

    def test_small_pool_passes_through_unclamped(self):
        result = self._make_result(['3.8', '3.9'])
        assert result['result']['interpreter']['pool']['versions'] == ['3.8', '3.9']
        assert 'versions_truncated_from' not in result['result']['interpreter']['pool']

    def test_oversized_pool_clamped_under_4kb(self):
        big = [f'3.{i}.10' for i in range(400)]
        result = self._make_result(big)
        serialized = result['result']
        size = len(__import__('json').dumps(serialized, ensure_ascii=False)
                   .encode('utf-8'))
        assert size <= execute_module.CALLBACK_RESULT_MAX_BYTES, (
            f'clamped result is {size} bytes, budget '
            f'{execute_module.CALLBACK_RESULT_MAX_BYTES}')
        pool = result['result']['interpreter']['pool']
        assert pool['versions_truncated_from'] == 400
        # 保尾（最新）：最后一条必须还在
        assert pool['versions'][-1] == big[-1]

    def test_huge_detail_also_clamped(self):
        exc = RuntimeError('x' * 100_000)
        result = execute_module._interpreter_failure_result(
            '3.7', exc, {'install_dir': '', 'versions': []},
            started_at=__import__('time').monotonic(), execution_id='exec-d')
        size = len(__import__('json').dumps(result['result'], ensure_ascii=False)
                   .encode('utf-8'))
        assert size <= execute_module.CALLBACK_RESULT_MAX_BYTES


# ---------------------------------------------------------------------------
# P3-14：_run_uv bounded 累积
# ---------------------------------------------------------------------------


class TestRunUvBoundedOutput:
    """P3-14：communicate() 全量驻留 → 流式 bounded 累积 + 截断标记。"""

    def test_small_output_captured_intact(self, tmp_path):
        script = tmp_path / 'ok.py'
        script.write_text("print('line-one'); print('line-two')")
        code, out = asyncio.run(execute_module._run_uv(
            [sys.executable, str(script)], timeout_seconds=30))
        assert code == 0
        assert 'line-one' in out and 'line-two' in out
        assert 'truncated' not in out

    def test_oversized_output_truncated_with_marker(self, tmp_path):
        script = tmp_path / 'big.py'
        script.write_text(
            "print('A' * 2048)\n" * 8192)  # ~16MB > 10MB 预算
        code, out = asyncio.run(execute_module._run_uv(
            [sys.executable, str(script)], timeout_seconds=60))
        assert code == 0
        assert len(out) <= execute_module.PREPARE_LOG_MEMORY_CHARS + len(
            execute_module.PREPARE_LOG_TRUNCATION_MARKER) + 4096
        assert 'logs truncated in memory' in out

    def test_nonzero_exit_reported(self, tmp_path):
        script = tmp_path / 'fail.py'
        script.write_text("import sys; print('boom'); sys.exit(2)")
        code, out = asyncio.run(execute_module._run_uv(
            [sys.executable, str(script)], timeout_seconds=30))
        assert code == 2
        assert 'boom' in out


# ---------------------------------------------------------------------------
# P3-18：runtime=node + requirements 快速失败
# ---------------------------------------------------------------------------


class TestNodeRequirementsFastFail:
    """P3-18：node 依赖在本侧显式失败（runtime_missing），不再带着警告跑。"""

    @pytest.mark.asyncio
    async def test_node_with_requirements_fails_fast(self, monkeypatch, tmp_path):
        monkeypatch.setattr(settings, 'work_dir', str(tmp_path))
        req = execute_module.ExecuteRequest(
            executionId='exec-node-req',
            task={'runtime': 'node', 'entrypoint': 'index.js',
                  'requirements': ['lodash@4.17.21']},
        )
        result = await execute_module.run_task(req)
        assert result['success'] is False
        assert 'runtime=node' in result['errorMessage']
        assert '依赖' in result['errorMessage']
    @pytest.mark.asyncio
    async def test_failure_reason_classifies_runtime_missing(self, monkeypatch,
                                                             tmp_path):
        """失败文案必须命中 _refine_failure_reason 的 runtime_missing 规则。"""
        monkeypatch.setattr(settings, 'work_dir', str(tmp_path))
        req = execute_module.ExecuteRequest(
            executionId='exec-node-req-2',
            task={'runtime': 'node', 'entrypoint': 'index.js',
                  'requirements': ['lodash@4.17.21']},
        )
        result = await execute_module.run_task(req)
        reason = execute_module._refine_failure_reason(
            str(result.get('errorMessage') or ''))
        assert reason == 'runtime_missing'

    @pytest.mark.asyncio
    async def test_node_without_requirements_still_runs(self, monkeypatch,
                                                        tmp_path):
        """无依赖的 node 任务不受影响（行为零变化）。"""
        monkeypatch.setattr(settings, 'work_dir', str(tmp_path))
        req = execute_module.ExecuteRequest(
            executionId='exec-node-clean',
            task={'runtime': 'node', 'entrypoint': 'index.js'},
        )
        result = await execute_module.run_task(req)
        # 无依赖 node 任务走到 spawn（本机无 node 时是 runtime_missing 的
        # 既有失败文案，**不是** P3-18 的依赖拒绝文案）。
        msg = result.get('errorMessage') or ''
        assert '依赖安装' not in msg or '不支持 runtime=node 的依赖安装' not in msg
