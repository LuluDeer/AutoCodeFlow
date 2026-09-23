import pytest
import httpx
from unittest.mock import AsyncMock, patch

import auth as auth_module
from config import settings
import main as main_module
from main import register_executor, executor_started_at, executor_startup_id, PROTOCOL_VERSION


def _register_response(status_code=201, json_body=None, text=None):
    return httpx.Response(
        status_code,
        json=json_body if json_body is not None else {'code': 0, 'message': 'ok', 'data': {}},
        text=text,
        request=httpx.Request('POST', 'http://admin.local/api/executors/register'),
    )


def _patch_settings(monkeypatch):
    monkeypatch.setattr(settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(settings, 'admin_api_url_internal', None)
    monkeypatch.setattr(settings, 'admin_api_url_external', None)
    monkeypatch.setattr(settings, 'app_name', 'py-executor')
    monkeypatch.setattr(settings, 'executor_address', 'localhost:8001')
    monkeypatch.setattr(settings, 'executor_address_public', '')


@pytest.mark.asyncio
async def test_register_executor_posts_capacity_metadata(monkeypatch):
    """Python executor registration should report scheduler capacity to admin-api."""
    _patch_settings(monkeypatch)
    monkeypatch.setattr(settings, 'max_concurrent_tasks', 7)
    # FR-13/AC-13a（python_task_multiversion）：注册载荷新增 interpreters 字段。
    # 这里钉死探测结果，断言与"真实池内容"解耦（否则本机会因为装了 uv/解释器
    # 而产出不确定的清单）。
    monkeypatch.setattr(main_module, '_discovered_interpreters', [])
    # ARCH-36（ADR-017 阶段 2）：注册载荷新增 deviceFingerprint——它与本机
    # 真实机器标识/安装盐绑定，**天然因机器而异**，直接断言会让本用例在
    # CI 与不同开发机上产出不同期望值。故与上面的 interpreters 同款处理：
    # 钉死采集结果，把断言与"本机身份"解耦。
    pinned_fingerprint = 'b3' * 32
    monkeypatch.setattr(
        main_module, 'get_device_fingerprint', lambda: pinned_fingerprint
    )

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=_register_response())

    with patch('main.get_http_client', return_value=mock_client):
        await register_executor()

    mock_client.post.assert_awaited_once()
    args, kwargs = mock_client.post.call_args
    assert args[0] == 'http://admin.local/api/executors/register'
    assert kwargs['json'] == {
        'appName': 'py-executor',
        'address': 'localhost:8001',
        'type': 'python',
        # R5: EXECUTOR_VERSION 1.0.0 → 2.0.0（新增 interpreters 上报能力）
        'version': '2.0.0',
        # PROTOCOL-VER（B-3/U-2）：协议版本随注册上报（与实现版本门禁解耦）
        'protocolVersion': PROTOCOL_VERSION,
        'capabilities': ['python', 'shell'],
        # ARCH-32: 派发模式自报（默认 push）
        'dispatchMode': 'push',
        # CONTRACT.md §2.3：解释器清单（可缺省；本执行器始终上报）
        'interpreters': [],
        'maxConcurrentTasks': 7,
        'restartedAt': executor_started_at,
        'startupId': executor_startup_id,
        # ARCH-36（ADR-017 阶段 2）：稳定设备指纹（sha256(deviceId:installSalt)，
        # 64 位小写十六进制）。采集成功即计入载荷；失败时**整个键缺席**（不是送
        # null）——见 main.py `_register_payload`。本用例钉死了采集结果，故此处
        # 断言的是"成功路径必须上报"这一契约。
        'deviceFingerprint': pinned_fingerprint,
    }


@pytest.mark.asyncio
async def test_register_executor_omits_device_fingerprint_when_collection_fails(
    monkeypatch,
):
    """ARCH-36（ADR-017 阶段 2）：采集失败/不可用时**整个键缺席**，不是送 null。

    这是与本阶段兼容性红线绑定的形态契约：admin 侧对「键缺席」与「显式 null」
    都保留已存值（`normalizeDeviceFingerprint` 把非 64-hex 一律归为 null →
    "未上报"），但**node 侧**是 `getDeviceFingerprint() ?? undefined`，序列化后
    同样缺席。两端必须**同形**，否则将来有人把某一侧"顺手"改成送 null，
    就会让两端在上报形态上分叉（阶段 3 按指纹做定位时，这类分叉极难排查）。

    更重要的是 fail-open：采集失败绝不能阻断注册（容器无 machine-id、
    注册表不可读、数据目录只读等），本用例同时钉住"注册照常发出"。
    """
    _patch_settings(monkeypatch)
    monkeypatch.setattr(main_module, 'get_device_fingerprint', lambda: None)

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=_register_response())

    with patch('main.get_http_client', return_value=mock_client):
        await register_executor()

    mock_client.post.assert_awaited_once()
    _, kwargs = mock_client.post.call_args
    assert 'deviceFingerprint' not in kwargs['json']
    # 采集失败不影响其余元数据（fail-open：注册主链逐字节如常）。
    assert kwargs['json']['appName'] == 'py-executor'


@pytest.mark.asyncio
async def test_register_executor_uses_static_bootstrap_token(monkeypatch):
    """P1 fix (VERIFY-round9-e2e §1.4): /executors/register is bootstrap-token
    only — register must carry the shared static token even when a dynamic
    per-executor token is cached (the dynamic token gets 401 there)."""
    _patch_settings(monkeypatch)
    monkeypatch.setenv('EXECUTOR_SHARED_TOKEN', 'bootstrap-token')
    # Simulate R9's now-working dynamic token being cached: register must NOT
    # prefer it (the old get_current_token() behaviour caused the 401).
    monkeypatch.setattr(auth_module, '_dynamic_token', 'dynamic-token')

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=_register_response())

    with patch('main.get_http_client', return_value=mock_client):
        await register_executor()

    args, kwargs = mock_client.post.call_args
    assert kwargs['headers'] == {'Authorization': 'Bearer bootstrap-token'}


@pytest.mark.asyncio
async def test_register_executor_adopts_token_hash_from_response(monkeypatch):
    """R9 (round-9, W3): the register response carries the stored tokenHash
    (N26) — the executor must adopt it as the callback-token HMAC source."""
    _patch_settings(monkeypatch)
    monkeypatch.setattr(auth_module, '_executor_token_hash', None)

    response = _register_response(201, {'code': 0, 'message': 'ok', 'data': {'tokenHash': 'reg-hash'}})
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=response)

    with patch('main.get_http_client', return_value=mock_client):
        await register_executor()

    assert auth_module.get_executor_token_hash() == 'reg-hash'


@pytest.mark.asyncio
async def test_register_executor_logs_error_on_non_2xx(monkeypatch, caplog):
    """P1 fix: a rejected register (e.g. 401) must be logged as an error with
    the status code and a body summary — never as a silent success."""
    _patch_settings(monkeypatch)
    monkeypatch.setattr(auth_module, '_executor_token_hash', None)

    response = _register_response(401, text='{"code":401,"message":"Invalid executor token"}')
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=response)

    with caplog.at_level('ERROR'), patch('main.get_http_client', return_value=mock_client):
        await register_executor()

    errors = [r for r in caplog.records if r.levelname == 'ERROR']
    assert len(errors) == 1
    assert '401' in errors[0].getMessage()
    assert 'Invalid executor token' in errors[0].getMessage()
    # No misleading success line, and no tokenHash adoption from a rejected response.
    assert not [r for r in caplog.records if 'Registered to admin-api' in r.getMessage()]
    assert auth_module.get_executor_token_hash() is None
