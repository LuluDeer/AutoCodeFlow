"""FR-13/FR-14/AC-13a/b/AC-14a/b 解释器清单上报（WS4）。

覆盖：
  * 注册载荷带 `interpreters` 字段且形状符合 CONTRACT.md §2.2
  * 探测失败**不阻断**注册/启动（AC-14b）
  * 心跳 provider 遵循既有 runningExecutionIds/deadLetterCount 模式
  * 探测结果缓存 → 心跳不重复 spawn uv（NFR-10）
"""
import asyncio
import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest

import interpreters as interpreters_module
import main as main_module
import scheduler as scheduler_module
from config import settings


def create_mock_response(status_code: int = 200) -> httpx.Response:
    """与 test_scheduler.create_mock_response 同形（tests 目录不是可导入包，
    跨文件 import 在 pytest rootdir 下不可靠，故本地复刻三行）。"""
    return httpx.Response(status_code, request=httpx.Request('POST', 'http://test.com'))


# ---------------------------------------------------------------------------
# 注册载荷（AC-13a）
# ---------------------------------------------------------------------------

def _patch_settings(monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(settings, 'admin_api_url_internal', None)
    monkeypatch.setattr(settings, 'admin_api_url_external', None)
    monkeypatch.setattr(settings, 'app_name', 'py-executor')
    monkeypatch.setattr(settings, 'executor_address', 'localhost:8001')
    monkeypatch.setattr(settings, 'executor_address_public', '')


def _info(version, path='/pool/x/python', available=True):
    return interpreters_module.InterpreterInfo(
        version=version, path=path, available=available,
        discovered_at='2026-09-16T00:00:00Z',
    )


def test_register_payload_includes_interpreters_in_contract_shape(monkeypatch):
    """CONTRACT.md §2.2：`[{version, path, available, discoveredAt}]`。"""
    monkeypatch.setattr(main_module, '_discovered_interpreters',
                        [{'version': '3.9.20', 'path': '/pool/3.9/python',
                          'available': True, 'discoveredAt': '2026-09-16T00:00:00Z'}])

    payload = main_module._register_payload()

    assert payload['interpreters'] == [{
        'version': '3.9.20',
        'path': '/pool/3.9/python',
        'available': True,
        'discoveredAt': '2026-09-16T00:00:00Z',
    }]


def test_register_payload_field_names_match_the_contract_exactly(monkeypatch):
    monkeypatch.setattr(main_module, '_discovered_interpreters', [])
    payload = main_module._register_payload()
    assert 'interpreters' in payload, (
        '[] means "reported and empty"; an ABSENT field means "legacy executor, '
        'not reported" and makes admin fall back to ["3.12"] — deliberately not '
        'what a 2.0.0 executor should signal'
    )


def test_discovery_maps_interpreter_info_to_the_wire_shape(monkeypatch):
    """`InterpreterInfo.discovered_at` → 线上的 `discoveredAt`（snake→camel）。"""
    monkeypatch.setattr(main_module, '_discovered_interpreters', None)
    monkeypatch.setattr(
        interpreters_module, 'discover_installed',
        lambda **k: [_info('3.12.11'), _info('3.9.20', available=False)],
    )

    discovered = main_module._discover_interpreters()

    assert [d['version'] for d in discovered] == ['3.12.11', '3.9.20']
    assert discovered[0]['discoveredAt'] == '2026-09-16T00:00:00Z'
    assert discovered[1]['available'] is False
    assert set(discovered[0]) == {'version', 'path', 'available', 'discoveredAt'}


def test_discovery_failure_does_not_break_registration(monkeypatch):
    """AC-14b：探测抛异常 → 退化为空列表，注册照常完成。"""
    monkeypatch.setattr(main_module, '_discovered_interpreters', None)

    def boom(**kwargs):
        raise RuntimeError('uv exploded')

    monkeypatch.setattr(interpreters_module, 'discover_installed', boom)

    assert main_module._discover_interpreters() == []
    assert main_module._register_payload()['interpreters'] == []


def test_discovery_bounds_its_time_budget(monkeypatch):
    """NFR-10：启动探测预算 ≤5s（不管下载超时配多大）。"""
    monkeypatch.setattr(main_module, '_discovered_interpreters', None)
    monkeypatch.setattr(settings, 'interpreter_download_timeout_seconds', 300)
    seen = {}

    def spy(**kwargs):
        seen.update(kwargs)
        return []

    monkeypatch.setattr(interpreters_module, 'discover_installed', spy)
    main_module._discover_interpreters()

    assert seen['timeout'] <= 5.0


def test_interpreter_download_budget_is_not_the_local_venv_budget():
    """解释器**下载**的预算必须独立于本地建 venv 的 60s（D11/NFR-13）。

    回归：三个调用点曾一律传 `UV_VENV_TIMEOUT_SECONDS`（60s）。那个预算是"在
    **本地**建 venv"的量级，而解释器下载要走网络（默认从 GitHub 拉 ~30MB 的
    python-build-standalone，内网镜像还可能更慢）。用 60s 卡下载，等于让
    "首次声明某个版本"的任务在网络稍慢时必然超时成 interpreter_unavailable
    —— 而 D14 要求这条路径"明确失败、绝不回退"，用户看到的是一个看起来像
    "这个版本不存在"的失败。executor-node 读的是 300s
    （interpreters.ts:645），两侧必须对等。
    """
    from routers import execute as execute_module

    monkeypatch = pytest.MonkeyPatch()
    try:
        monkeypatch.setattr(settings, 'interpreter_download_timeout_seconds', 300)
        budget = execute_module._interpreter_download_timeout()
        assert budget == 300.0
        assert budget != execute_module.UV_VENV_TIMEOUT_SECONDS, (
            '下载预算不得等于本地 venv 预算（60s）——那会让首次下载必然超时'
        )
        # 非法/缺省一律回落 300，绝不回落 0（0 会让每次下载立即超时）。
        for bad in (0, -1, None, 'abc'):
            monkeypatch.setattr(settings, 'interpreter_download_timeout_seconds', bad)
            assert execute_module._interpreter_download_timeout() == 300.0, bad
    finally:
        monkeypatch.undo()


def test_discovery_entries_without_a_version_are_dropped(monkeypatch):
    monkeypatch.setattr(main_module, '_discovered_interpreters', None)
    monkeypatch.setattr(
        interpreters_module, 'discover_installed',
        lambda **k: [SimpleNamespace(version='', path='/x', available=True,
                                    discovered_at='t'), _info('3.9.20')],
    )
    assert [d['version'] for d in main_module._discover_interpreters()] == ['3.9.20']


def test_snapshot_is_cached_so_registration_probes_only_once(monkeypatch):
    """探测结果缓存：注册与心跳共用一份快照（NFR-10，绝不每次心跳 spawn uv）。"""
    monkeypatch.setattr(main_module, '_discovered_interpreters', None)
    calls = []

    def counting(**kwargs):
        calls.append(1)
        return [_info('3.12.11')]

    monkeypatch.setattr(interpreters_module, 'discover_installed', counting)

    first = main_module.get_interpreters_snapshot()
    second = main_module.get_interpreters_snapshot()

    assert first == second
    assert len(calls) == 1, 'discovery must not re-run on every call'


@pytest.mark.asyncio
async def test_register_executor_sends_the_interpreters_field(monkeypatch):
    """端到端：注册请求体里确实带上了 interpreters（AC-13a）。"""
    _patch_settings(monkeypatch)
    monkeypatch.setattr(main_module, '_discovered_interpreters',
                        [{'version': '3.12.11', 'path': '/pool/p',
                          'available': True, 'discoveredAt': 't'}])

    import httpx
    response = httpx.Response(
        201, json={'code': 0, 'message': 'ok', 'data': {}},
        request=httpx.Request('POST', 'http://admin.local/api/executors/register'),
    )
    mock_client = AsyncMock()
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    mock_client.post = AsyncMock(return_value=response)

    with patch('main.httpx.AsyncClient', return_value=mock_client):
        await main_module.register_executor()

    body = mock_client.post.call_args.kwargs['json']
    assert body['interpreters'] == [{
        'version': '3.12.11', 'path': '/pool/p',
        'available': True, 'discoveredAt': 't',
    }]


# ---------------------------------------------------------------------------
# 心跳 provider（AC-14a）
# ---------------------------------------------------------------------------

def test_scheduler_has_a_provider_registry_like_the_existing_ones():
    """与 runningExecutionIds/deadLetterCount 同一模式（可注入 getter）。"""
    assert hasattr(scheduler_module, 'register_interpreters_provider')
    assert hasattr(scheduler_module, '_collect_interpreters')


def test_provider_registration_is_what_main_wires(monkeypatch):
    """main.lifespan 把真实 provider 接上（而非停留在默认空实现）。"""
    source = inspect.getsource(main_module.lifespan)
    assert 'register_interpreters_provider' in source
    assert 'get_interpreters_snapshot' in source


def test_collect_interpreters_returns_provider_output():
    seen = []

    def provider():
        value = [{'version': '3.9.20', 'path': '/p', 'available': True,
                  'discoveredAt': 't'}]
        seen.append(value)
        return value

    original = scheduler_module._interpreters_provider
    scheduler_module.register_interpreters_provider(provider)
    try:
        assert scheduler_module._collect_interpreters() == seen[0]
    finally:
        scheduler_module.register_interpreters_provider(original)


def test_collect_interpreters_swallows_provider_failures():
    """上报失败绝不能让心跳失败（那会让 admin 判执行器 OFFLINE）。"""
    def boom():
        raise RuntimeError('provider exploded')

    original = scheduler_module._interpreters_provider
    scheduler_module.register_interpreters_provider(boom)
    try:
        assert scheduler_module._collect_interpreters() == []
    finally:
        scheduler_module.register_interpreters_provider(original)


def test_collect_interpreters_normalises_non_list_output():
    original = scheduler_module._interpreters_provider
    scheduler_module.register_interpreters_provider(lambda: {'oops': True})
    try:
        assert scheduler_module._collect_interpreters() == []
    finally:
        scheduler_module.register_interpreters_provider(original)


def test_default_provider_reports_an_empty_list_not_none():
    """默认必须是 `[]`（"已上报且为空"），不是 None（"未上报"）。"""
    assert scheduler_module._default_interpreters() == []


@pytest.mark.asyncio
async def test_heartbeat_body_carries_interpreters(monkeypatch):

    original = scheduler_module._interpreters_provider
    scheduler_module.register_interpreters_provider(
        lambda: [{'version': '3.9.20', 'path': '/p', 'available': True,
                  'discoveredAt': 't'}])
    try:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(200))
        with patch('scheduler.psutil.cpu_percent', return_value=1.0), \
             patch('scheduler.psutil.virtual_memory') as mem_mock:
            mem_mock.return_value = SimpleNamespace(percent=2.0)
            await scheduler_module._send_heartbeat(mock_client, 'test-token')
    finally:
        scheduler_module.register_interpreters_provider(original)

    body = mock_client.post.call_args.kwargs['json']
    assert body['interpreters'] == [{
        'version': '3.9.20', 'path': '/p', 'available': True, 'discoveredAt': 't',
    }]


@pytest.mark.asyncio
async def test_heartbeat_always_sends_the_interpreters_field(monkeypatch):
    """字段恒存在（空池也发 `[]`）——admin 侧据此区分"已上报"与"旧执行器"。"""

    original = scheduler_module._interpreters_provider
    scheduler_module.register_interpreters_provider(lambda: [])
    try:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(200))
        with patch('scheduler.psutil.cpu_percent', return_value=1.0), \
             patch('scheduler.psutil.virtual_memory') as mem_mock:
            mem_mock.return_value = SimpleNamespace(percent=2.0)
            await scheduler_module._send_heartbeat(mock_client, 'test-token')
    finally:
        scheduler_module.register_interpreters_provider(original)

    body = mock_client.post.call_args.kwargs['json']
    assert 'interpreters' in body
    assert body['interpreters'] == []


@pytest.mark.asyncio
async def test_heartbeat_survives_a_broken_interpreters_provider():
    """provider 抛异常时心跳仍必须发出去（能力上报失败 ≠ 执行器离线）。"""

    def boom():
        raise RuntimeError('pool unreadable')

    original = scheduler_module._interpreters_provider
    scheduler_module.register_interpreters_provider(boom)
    try:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(200))
        with patch('scheduler.psutil.cpu_percent', return_value=1.0), \
             patch('scheduler.psutil.virtual_memory') as mem_mock:
            mem_mock.return_value = SimpleNamespace(percent=2.0)
            await scheduler_module._send_heartbeat(mock_client, 'test-token')
    finally:
        scheduler_module.register_interpreters_provider(original)

    body = mock_client.post.call_args.kwargs['json']
    assert body['interpreters'] == []
