"""失败归因单轨化后的定向回归（读共享契约向量，不写第二份判据）。

- 判据本体：``apps/executor-python/generated/failure_classifier.py``。
- 适配器：``routers.execute._refine_failure_reason``（保持旧入参形态：错误串/日志拼接串）。
- 期望值：``packages/contract-fixtures/contract.json`` 的 ``failureClassification.vectors``。
  ``expected.executor`` 为 None 表示让位给 admin：回调必须省略 failureReason，
  绝不能压成 ``unknown`` 上报。
"""

import asyncio
import inspect
import json
import pathlib
from unittest.mock import AsyncMock

import pytest

from routers import execute as execute_module
from generated.failure_classifier import classify as generated_classify
from generated.failure_classifier import JOIN_WITH


def _find_contract() -> pathlib.Path:
    """向上找仓库根（与 test_executor_protocol_contract 的 _find_protocol 同法）。"""
    here = pathlib.Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / 'packages' / 'contract-fixtures' / 'contract.json'
        if candidate.exists():
            return candidate
    raise AssertionError('packages/contract-fixtures/contract.json not found')


CONTRACT = json.loads(_find_contract().read_text(encoding='utf-8'))
VECTORS = CONTRACT['failureClassification']['vectors']
BY_ID = {v['id']: v for v in VECTORS}


def _wire_text(parts):
    """保持 _refine_failure_reason 的既有入参形态：拼成一个错误串/日志串。"""
    return JOIN_WITH.join(p for p in parts if p)


def _expected(vid):
    return BY_ID[vid]['expected']['executor']


def test_contract_vectors_are_reachable():
    """向量为空会让下面的参数化全部假绿，先钉住扫描面。"""
    assert len(VECTORS) >= 30
    for v in VECTORS:
        assert isinstance(v['parts'], list)
        assert 'executor' in v['expected']


@pytest.mark.parametrize('vector', VECTORS, ids=lambda v: v['id'])
def test_executor_stage_matches_contract_vector(vector):
    """同一批向量：生成物与执行器适配器都必须给出 expected.executor。"""
    expected = vector['expected']['executor']
    assert generated_classify(vector['parts'], 'executor') == expected
    assert execute_module._refine_failure_reason(_wire_text(vector['parts'])) == expected


# ---------------------------------------------------------------------------
# 点名语义格（全部从同一批向量派生，不另写判据）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('vid', ['script-traceback', 'script-zh'])
def test_script_error_vectors(vid):
    assert _expected(vid) == 'script_error'
    assert execute_module._refine_failure_reason(_wire_text(BY_ID[vid]['parts'])) == 'script_error'


@pytest.mark.parametrize('vid', ['pkg-invalid-npm-name', 'pkg-download-failed', 'app-missing'])
def test_package_vectors_including_defer(vid):
    """invalid package name / 下载失败归包渠道；packageUrl 解析失败让位（None）。"""
    expected = _expected(vid)
    assert execute_module._refine_failure_reason(_wire_text(BY_ID[vid]['parts'])) == expected


@pytest.mark.parametrize('vid', ['git-phase-timeout', 'dep-uv-venv-timeout', 'timeout-zh-任务执行超时'])
def test_stage_timeout_vectors_do_not_collide(vid):
    """git/dependency 阶段预算超时各有归处；任务超时骨架不被它们抢走。"""
    expected = _expected(vid)
    assert execute_module._refine_failure_reason(_wire_text(BY_ID[vid]['parts'])) == expected


@pytest.mark.parametrize('vid', ['sandbox-task-launcher-zh', 'sandbox-task-launcher-token',
                                 'sandbox-bwrap-missing', 'sandbox-zh'])
def test_task_launcher_and_sandbox_vectors(vid):
    assert _expected(vid) == 'sandbox_unavailable'
    assert execute_module._refine_failure_reason(_wire_text(BY_ID[vid]['parts'])) == 'sandbox_unavailable'


@pytest.mark.parametrize('vid, transform, expected', [
    ('pkg-invalid-npm-name', lambda s: s.upper(), 'package_fetch_failed'),
    ('script-zh', lambda s: '😀 ' + s, 'script_error'),
])
def test_normalization_boundaries_case_and_astral(vid, transform, expected):
    """ASCII 大小写折叠 + astral 折叠后仍与契约结论一致。"""
    text = transform(_wire_text(BY_ID[vid]['parts']))
    assert expected == _expected(vid)
    assert generated_classify([text], 'executor') == expected
    assert execute_module._refine_failure_reason(text) == expected


def test_normalization_boundary_multiline_parts():
    """多 parts 用 JOIN_WITH 拼接，与 _refine_failure_reason 的单串入参同判。"""
    vector = BY_ID['script-traceback']
    parts = ['context before script', *vector['parts']]
    expected = vector['expected']['executor']
    assert generated_classify(parts, 'executor') == expected
    assert execute_module._refine_failure_reason(_wire_text(parts)) == expected


# ---------------------------------------------------------------------------
# 集成边界：None 让位 / bwrap 独立入口 / 薄适配器
# ---------------------------------------------------------------------------

def test_refine_failure_reason_is_thin_adapter():
    src = inspect.getsource(execute_module._refine_failure_reason)
    assert "_classify_failure_reason([message], 'executor')" in src
    assert 're.search' not in src


def test_callback_omits_failure_reason_when_executor_defers(monkeypatch):
    """expected.executor=None 的向量走真实 _run_and_callback：字段必须缺席。"""
    from routers.execute import ExecuteRequest

    captured = {}

    async def fake_run_task(req, entry=None):
        return {
            'success': False,
            'logs': '',
            'exitCode': 1,
            'errorMessage': _wire_text(BY_ID['app-missing']['parts']),
            'durationMs': 1,
        }

    async def fake_send(url, payload, token):
        captured['payload'] = payload
        return True

    async def fake_token():
        return None

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)
    monkeypatch.setattr(execute_module, '_send_callback_with_retry', fake_send)
    monkeypatch.setattr(execute_module, '_get_admin_api_url', lambda: 'http://admin.local')
    monkeypatch.setattr(execute_module, 'get_current_token', fake_token)
    monkeypatch.setattr(execute_module, 'gather_artifacts_for_callback', AsyncMock(return_value=None))
    monkeypatch.setattr(execute_module.sched, 'decrement_running', lambda: None)
    monkeypatch.setattr(execute_module, 'unregister_live_execution', lambda _execution_id: None)

    req = ExecuteRequest(executionId='exec-defer-reason', task={'name': 'noop', 'runtime': 'python'})
    asyncio.run(execute_module._run_and_callback(req))

    payload = captured['payload']
    assert payload['status'] == 'failed'
    assert 'failureReason' not in payload


def test_bwrap_log_scan_stays_independent_and_priority(monkeypatch):
    """bwrap 日志扫描仍是独立入口；其文案被分类器稳定归入 sandbox_unavailable。"""
    monkeypatch.setattr(execute_module.settings, 'task_sandbox', execute_module.SANDBOX_BWRAP)
    logs = 'bwrap: failed to create new namespace for task'
    message = execute_module._sandbox_startup_failure_reason(logs)
    assert message is not None and 'bwrap' in message
    assert execute_module._refine_failure_reason(message) == 'sandbox_unavailable'


# ---------------------------------------------------------------------------
# 显式 catch 的结构化归因（git phase / launcher timeout）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('log_line', [
    'bwrap: setting up uid map: Permission denied',
    'bwrap: failed to make / slave',
    'bwrap: execvp /usr/bin/python: No such file or directory',
])
def test_sandbox_startup_regex_survives_as_independent_entry(monkeypatch, log_line):
    """独立日志入口专用正则必须存在；不并入生成物文本规则。"""
    monkeypatch.setattr(execute_module.settings, 'task_sandbox', execute_module.SANDBOX_BWRAP)
    assert execute_module._SANDBOX_STARTUP_FAILURE_RE.search(log_line)
    assert execute_module._sandbox_startup_failure_reason(log_line) is not None


def test_git_prepare_timeout_keeps_both_classification_paths():
    """显式 catch 的异常：结构化码 + 生成物可识别文本，两路同归 git_fetch_failed。"""
    cmd = ['git', 'clone', '--bare', 'https://example.com/org/repo.git', '/tmp/cache']
    exc = execute_module._StructuredPrepareTimeout(
        cmd, 1.0, 'git_fetch_failed', 'git clone timed out')

    assert exc.cmd == cmd
    assert exc.timeout == 1.0
    assert 'timed out after 1.0 seconds' in str(exc)
    assert 'task_launcher' not in str(exc)
    assert exc.failure_reason == 'git_fetch_failed'
    assert execute_module._refine_failure_reason(str(exc)) == 'git_fetch_failed'


def test_callback_prefers_structured_reason_from_prepare_timeout(monkeypatch):
    """回调构造点优先采用异常自带的码，不被文本二次猜测覆盖。"""
    from routers.execute import ExecuteRequest

    captured = {}

    async def fake_run_task(req, entry=None):
        cmd = ['git', 'fetch', 'origin']
        raise execute_module._StructuredPrepareTimeout(
            cmd, 1.0, 'git_fetch_failed', 'git fetch timed out')

    async def fake_send(url, payload, token):
        captured['payload'] = payload
        return True

    async def fake_token():
        return None

    monkeypatch.setattr(execute_module, 'run_task', fake_run_task)
    monkeypatch.setattr(execute_module, '_send_callback_with_retry', fake_send)
    monkeypatch.setattr(execute_module, '_get_admin_api_url', lambda: 'http://admin.local')
    monkeypatch.setattr(execute_module, 'get_current_token', fake_token)
    monkeypatch.setattr(execute_module, 'gather_artifacts_for_callback', AsyncMock(return_value=None))
    monkeypatch.setattr(execute_module.sched, 'decrement_running', lambda: None)
    monkeypatch.setattr(execute_module, 'unregister_live_execution', lambda _execution_id: None)

    req = ExecuteRequest(executionId='exec-git-timeout', task={'name': 'noop', 'runtime': 'python'})
    asyncio.run(execute_module._run_and_callback(req))

    assert captured['payload']['failureReason'] == 'git_fetch_failed'
