"""FR-08/FR-12/AC-12a/D14 解释器获取失败（python_task_multiversion, WS4）。

覆盖：
  * 解释器获取失败 → failureReason **恰好**是 `interpreter_unavailable`
  * 该规则**优先于**依赖安装规则（`uv venv failed: … No interpreter found …`
    的回归测试——顺序错了就会被误吞成 dependency_install_failed）
  * `result.interpreter` 带 requested/reason/pool（FR-12 结构化留痕）
  * **D14：绝不回退宿主解释器**（明确失败，不是"悄悄跑在 3.12 上"）
  * glue 声明版本时用该版本解释器（AC-11a）；无版本时逐字节沿用旧行为（AC-10a）
"""
import asyncio
import sys
from types import SimpleNamespace

import pytest

import interpreters as interpreters_module
from routers import execute as execute_module
from routers.execute import ExecuteRequest


# ---------------------------------------------------------------------------
# _refine_failure_reason：规则与顺序
# ---------------------------------------------------------------------------

def test_interpreter_unavailable_rule_matches_uv_text():
    from routers.execute import _refine_failure_reason as r
    assert r('No interpreter found for Python 3.9 in managed installations') == 'interpreter_unavailable'
    assert r('error: No download found for request: cpython-3.7-x86_64-unknown-linux-gnu') == 'interpreter_unavailable'
    assert r('interpreter 3.9 unavailable') == 'interpreter_unavailable'
    assert r('the requested interpreter was not found') == 'interpreter_unavailable'
    assert r('Python 3.7 unavailable (not_downloadable): ...') == 'interpreter_unavailable'
    assert r('解释器 3.7 无法获取（缓存缺失 + 下载失败）') == 'interpreter_unavailable'
    assert r('解释器 3.9 不可用') == 'interpreter_unavailable'


def test_interpreter_rule_wins_over_dependency_install_text():
    """**顺序回归**：uv 的原文同时命中"uv venv failed"与"no interpreter found"。

    解释器规则必须排在依赖规则之前——否则用户看到"依赖装不上"，
    排查方向直接跑偏（AC-12a 的失败分因就失去意义）。"""
    from routers.execute import _refine_failure_reason as r
    assert r(
        'uv venv failed: error: No interpreter found for Python 3.9 in managed '
        'installations, search path, or registry'
    ) == 'interpreter_unavailable'
    assert r(
        'uv venv failed: No download found for request: cpython-3.7-<platform>'
    ) == 'interpreter_unavailable'


def test_dependency_rule_still_wins_for_genuine_dependency_failures():
    """反向断言：真正的依赖失败不能被新规则吞掉。"""
    from routers.execute import _refine_failure_reason as r
    assert r('uv pip install failed: no matching distribution') == 'dependency_install_failed'
    assert r('uv venv failed: BrokenPipe') == 'dependency_install_failed'


def test_interpreter_unavailable_exception_text_is_classified():
    exc = interpreters_module.InterpreterUnavailable(
        '3.7', 'not_downloadable', 'Python 3.7 cannot be downloaded online')
    assert execute_module._refine_failure_reason(str(exc)) == 'interpreter_unavailable'
    assert execute_module._is_interpreter_unavailable(exc) is True


def test_is_interpreter_unavailable_is_false_for_unrelated_errors():
    assert execute_module._is_interpreter_unavailable(RuntimeError('boom')) is False


# ---------------------------------------------------------------------------
# run_task：无依赖 python + 声明版本
# ---------------------------------------------------------------------------

def _patch_env(monkeypatch, tmp_path):
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(execute_module.settings, 'app_name', 'executor-under-test')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_address', 'localhost:8001')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'tok')
    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')


def _capture_spawns(monkeypatch):
    """拦下子进程 spawn 并记录 argv。

    `_Proc` 必须提供 stdout 异步迭代器：运行阶段是按行读 proc.stdout 的
    （`async for raw_line in proc.stdout`），只给 communicate() 会在运行期炸。
    """
    spawns = []

    class _Proc:
        returncode = 0

        def __init__(self):
            self.stdout = self._lines()

        async def _lines(self):
            if False:  # pragma: no cover - 空异步生成器
                yield b''
            return

        async def communicate(self):
            return b'', b''

        def kill(self):
            pass

        async def wait(self):
            return 0

    async def fake_exec(*args, **kwargs):
        spawns.append(list(args))
        return _Proc()

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)
    return spawns


def _failing_interpreter(monkeypatch, reason='not_downloadable', detail='3.7 needs offline prefill'):
    async def boom(version, timeout):
        raise interpreters_module.InterpreterUnavailable(version, reason, detail)
    monkeypatch.setattr(execute_module, '_ensure_interpreter', boom)


def test_no_dependency_python_task_fails_when_interpreter_unavailable(monkeypatch, tmp_path):
    """AC-04c + D14：无依赖任务声明版本但取不到解释器 → 明确失败。"""
    _patch_env(monkeypatch, tmp_path)
    spawns = _capture_spawns(monkeypatch)
    _failing_interpreter(monkeypatch)
    monkeypatch.setattr(execute_module, '_pool_summary',
                        lambda: {'install_dir': '/pool', 'versions': ['3.12.11']})

    result = asyncio.run(execute_module.run_task(ExecuteRequest(
        executionId='exec-nodep-ver', task={
            'id': 'task-nodep-ver', 'runtime': 'python',
            'runtimeVersion': '3.7', 'entrypoint': 'main.py',
        })))

    assert result['success'] is False
    assert spawns == [], 'D14: must not fall back to the host interpreter'
    assert '3.7' in result['errorMessage']


def test_interpreter_failure_carries_structured_context(monkeypatch, tmp_path):
    """FR-12/AC-12a：`result.interpreter` = {requested, resolved, reason, pool}。"""
    _patch_env(monkeypatch, tmp_path)
    _capture_spawns(monkeypatch)
    _failing_interpreter(monkeypatch, reason='not_downloadable',
                         detail='3.7 needs offline prefill')
    monkeypatch.setattr(execute_module, '_pool_summary',
                        lambda: {'install_dir': '/pool', 'versions': ['3.12.11', '3.9.20']})

    result = asyncio.run(execute_module.run_task(ExecuteRequest(
        executionId='exec-snapshot', task={
            'id': 'task-snapshot', 'runtime': 'python',
            'runtimeVersion': '3.7', 'entrypoint': 'main.py',
        })))

    snapshot = result['result']['interpreter']
    assert snapshot['requested'] == '3.7'
    assert snapshot['resolved'] is None
    assert snapshot['reason'] == 'not_downloadable'
    assert snapshot['detail'] == '3.7 needs offline prefill'
    assert snapshot['pool'] == {'install_dir': '/pool', 'versions': ['3.12.11', '3.9.20']}


def test_missing_offline_prefill_guidance_is_present_for_37(monkeypatch, tmp_path):
    """CONTRACT §0.1：3.7 不可在线下载 → 错误消息必须明确指引部署方离线预填。"""
    _patch_env(monkeypatch, tmp_path)
    _capture_spawns(monkeypatch)
    _failing_interpreter(
        monkeypatch, reason='not_downloadable',
        detail='Python 3.7 不支持在线下载，需部署方离线预填解释器缓存卷')
    monkeypatch.setattr(execute_module, '_pool_summary',
                        lambda: {'install_dir': '/pool', 'versions': []})

    result = asyncio.run(execute_module.run_task(ExecuteRequest(
        executionId='exec-37-guide', task={
            'id': 'task-37-guide', 'runtime': 'python',
            'runtimeVersion': '3.7', 'entrypoint': 'main.py',
        })))

    assert '离线预填' in result['errorMessage']
    assert '无' in result['errorMessage']  # 候选清单显示池为空


def test_versioned_venv_path_reports_interpreter_unavailable(monkeypatch, tmp_path):
    """有依赖 + 声明版本：venv 阶段拿不到解释器同样归类为解释器不可获取。"""
    _patch_env(monkeypatch, tmp_path)
    _capture_spawns(monkeypatch)
    _failing_interpreter(monkeypatch)
    monkeypatch.setattr(execute_module, '_pool_summary',
                        lambda: {'install_dir': '/pool', 'versions': []})

    result = asyncio.run(execute_module.run_task(ExecuteRequest(
        executionId='exec-venv-fail', task={
            'id': 'task-venv-fail', 'runtime': 'python',
            'runtimeVersion': '3.9', 'entrypoint': 'main.py',
            'requirements': ['requests>=2'],
        })))

    assert result['success'] is False
    assert result['result']['interpreter']['requested'] == '3.9'


def test_non_interpreter_prepare_failure_still_propagates(monkeypatch, tmp_path):
    """只有**解释器类**失败才改写留痕；其它准备期异常照旧抛出（既有语义）。"""
    _patch_env(monkeypatch, tmp_path)
    _capture_spawns(monkeypatch)

    async def boom(venv_dir, requirements, *, python_version=None):
        raise RuntimeError('uv pip install failed: no matching distribution')

    monkeypatch.setattr(execute_module, 'ensure_venv', boom)

    with pytest.raises(RuntimeError, match='uv pip install failed'):
        asyncio.run(execute_module.run_task(ExecuteRequest(
            executionId='exec-other-fail', task={
                'id': 'task-other-fail', 'runtime': 'python',
                'runtimeVersion': '3.9', 'entrypoint': 'main.py',
                'requirements': ['requests>=2'],
            })))


# ---------------------------------------------------------------------------
# AC-11a：glue 声明版本
# ---------------------------------------------------------------------------

def test_glue_with_declared_version_uses_that_interpreter(monkeypatch, tmp_path):
    """AC-11a：glue 仍不建 venv（AC-11b），但用声明版本的解释器执行。"""
    _patch_env(monkeypatch, tmp_path)
    spawns = _capture_spawns(monkeypatch)

    pool_python = tmp_path / 'pool' / 'cpython-3.9.20-x' / 'python'
    pool_python.parent.mkdir(parents=True)
    pool_python.write_bytes(b'')

    async def fake_ensure(version, timeout):
        assert version == '3.9'
        return pool_python

    monkeypatch.setattr(execute_module, '_ensure_interpreter', fake_ensure)

    async def boom(*a, **k):
        raise AssertionError('glue must not create a venv (AC-11b)')

    monkeypatch.setattr(execute_module, 'ensure_venv', boom)

    asyncio.run(execute_module.run_task(ExecuteRequest(
        executionId='exec-glue-ver', task={
            'id': 'task-glue-ver', 'runtime': 'python',
            'runtimeVersion': '3.9',
            'glueSource': 'print("hi")', 'glueLanguage': 'python',
        })))

    assert spawns, 'the glue script must run'
    assert spawns[0][0] == str(pool_python)
    assert spawns[0][1] == 'glue_script.py'


def test_glue_fails_cleanly_when_declared_version_is_unavailable(monkeypatch, tmp_path):
    _patch_env(monkeypatch, tmp_path)
    spawns = _capture_spawns(monkeypatch)
    _failing_interpreter(monkeypatch)
    monkeypatch.setattr(execute_module, '_pool_summary',
                        lambda: {'install_dir': '/pool', 'versions': []})

    result = asyncio.run(execute_module.run_task(ExecuteRequest(
        executionId='exec-glue-fail', task={
            'id': 'task-glue-fail', 'runtime': 'python',
            'runtimeVersion': '3.7',
            'glueSource': 'print("hi")', 'glueLanguage': 'python',
        })))

    assert result['success'] is False
    assert spawns == [], 'D14: no host-interpreter fallback for glue either'
    assert result['result']['interpreter']['requested'] == '3.7'


def test_glue_without_version_is_byte_identical_to_legacy(monkeypatch, tmp_path):
    """AC-10a：无声明版本 → `sys.executable`，与改造前逐字节一致。"""
    _patch_env(monkeypatch, tmp_path)
    spawns = _capture_spawns(monkeypatch)

    async def boom(*a, **k):
        raise AssertionError('no interpreter resolution without a declared version')

    monkeypatch.setattr(execute_module, '_ensure_interpreter', boom)

    asyncio.run(execute_module.run_task(ExecuteRequest(
        executionId='exec-glue-legacy', task={
            'id': 'task-glue-legacy', 'runtime': 'python',
            'glueSource': 'print("hi")', 'glueLanguage': 'python',
        })))

    assert spawns[0][0] == sys.executable


def test_shell_glue_ignores_a_declared_version(monkeypatch, tmp_path):
    """shell glue 不需要解释器：声明版本不适用，且绝不能因此失败。"""
    _patch_env(monkeypatch, tmp_path)
    spawns = _capture_spawns(monkeypatch)

    async def boom(*a, **k):
        raise AssertionError('shell glue needs no python interpreter')

    monkeypatch.setattr(execute_module, '_ensure_interpreter', boom)

    asyncio.run(execute_module.run_task(ExecuteRequest(
        executionId='exec-shell-glue', task={
            'id': 'task-shell-glue', 'runtime': 'shell',
            'runtimeVersion': '3.7',
            'glueSource': 'echo hi', 'glueLanguage': 'shell',
        })))

    assert spawns


def test_invalid_runtime_version_is_rejected_before_anything_runs(monkeypatch, tmp_path):
    """FR-06b：畸形 runtimeVersion 显式拒绝——绝不静默按宿主解释器跑。"""
    _patch_env(monkeypatch, tmp_path)
    spawns = _capture_spawns(monkeypatch)

    result = asyncio.run(execute_module.run_task(ExecuteRequest(
        executionId='exec-bad-ver', task={
            'id': 'task-bad-ver', 'runtime': 'python',
            'runtimeVersion': '3.7.9', 'entrypoint': 'main.py',
        })))

    assert result['success'] is False
    assert 'runtimeVersion' in result['errorMessage']
    assert spawns == []


def test_declared_version_on_a_node_task_does_not_change_its_argv(monkeypatch, tmp_path):
    """NG-02：node 多版本不在本期范围——声明了也不影响既有 argv（不失败）。"""
    _patch_env(monkeypatch, tmp_path)
    spawns = _capture_spawns(monkeypatch)

    async def boom(*a, **k):
        raise AssertionError('no interpreter resolution for node runtime')

    monkeypatch.setattr(execute_module, '_ensure_interpreter', boom)

    asyncio.run(execute_module.run_task(ExecuteRequest(
        executionId='exec-node-ver', task={
            'id': 'task-node-ver', 'runtime': 'node',
            'runtimeVersion': '3.7', 'entrypoint': 'main.js',
        })))

    assert spawns


# ---------------------------------------------------------------------------
# 端到端回调：failureReason 恰好是 interpreter_unavailable
# ---------------------------------------------------------------------------

def test_callback_reports_interpreter_unavailable_with_snapshot(monkeypatch, tmp_path):
    """FR-08/AC-12a 端到端：终态回调的 failureReason 恰为 `interpreter_unavailable`。"""
    _patch_env(monkeypatch, tmp_path)
    posted = {}

    class FakeAsyncClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None):
            posted['json'] = json
            return SimpleNamespace(status_code=200)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', FakeAsyncClient)
    _failing_interpreter(monkeypatch)
    monkeypatch.setattr(execute_module, '_pool_summary',
                        lambda: {'install_dir': '/pool', 'versions': ['3.12.11']})

    asyncio.run(execute_module._run_and_callback(ExecuteRequest(
        executionId='exec-cb-interp', task={
            'id': 'task-cb-interp', 'runtime': 'python',
            'runtimeVersion': '3.7', 'entrypoint': 'main.py',
        })))

    item = posted['json'][0]
    assert item['status'] == 'failed'
    assert item['failureReason'] == 'interpreter_unavailable'
    # 结构化留痕随回调一起走（admin 的执行详情页消费它）
    assert item['result']['interpreter']['requested'] == '3.7'


def test_callback_omits_result_for_ordinary_failures(monkeypatch, tmp_path):
    """存量形状零变化：普通失败的回调**不新增** result 键。"""
    _patch_env(monkeypatch, tmp_path)
    posted = {}

    class FakeAsyncClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None):
            posted['json'] = json
            return SimpleNamespace(status_code=200)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', FakeAsyncClient)

    async def fake_run_task(req, entry=None):
        raise RuntimeError('uv pip install failed: no matching distribution')

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)

    asyncio.run(execute_module._run_and_callback(ExecuteRequest(
        executionId='exec-cb-plain', task={'name': 'noop', 'runtime': 'python'})))

    item = posted['json'][0]
    assert item['failureReason'] == 'dependency_install_failed'
    assert 'result' not in item
