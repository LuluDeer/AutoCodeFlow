"""R3-B/P10（协议 v7，2026-10-24）：deployedApps / installedPackages 两键在
python 执行器侧**恒省略**的钉住测试。

背景裁定（完整论证见 config.py PROTOCOL_VERSION 注释）：
- 两键的事实源分别是 /api/deploy 落盘的 `<workDir>/apps/<appId>/` 树与
  /api/update-package 落盘的 `.pkg-updates/manifests/<packageId>.json`；
- 这两条路由是 node-only（protocol.json executorNodeOnly 段 + commands.py
  能力缺口表登记），python 执行器没有它们，因此**从不创建**这些事实；
- admin 侧三态收口（normalizeDeployedApps / normalizeInstalledPackages）对
  省略键的语义 = 「未上报，不动 DB」；空数组 [] 则是「设备明确说没有」——
  在没有事实源的情况下补空数组，等于把「不知道」伪装成「没有」，是本任务
  明令禁止的硬造。

故本文件钉死三件事：
1. register / heartbeat 载荷**永不携带**这两个键（缺省 = 协议合法的「未上报」）；
2. 即使 workDir 里**存在** node 形态的目录树（与 node 执行器共用 workDir 的
   场景），python 侧也不代报——那是另一台执行器的事实，本侧无从区分归属；
3. 心跳本体不因这两键的缺席而残缺（其余键照报），协议版本仍是 v7。

将来 python 补齐 deploy / update-package 路由时，本文件应改为对齐
node 侧 deployed-apps.spec.ts / installed-packages.spec.ts 的扫描面用例
（命中/损坏跳过/目录级失败省略整键），届时恒省略裁定一并废除。
"""
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest

import scheduler as scheduler_module
from main import _register_payload


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


def _plant_node_shaped_tree(work_dir) -> None:
    """在 workDir 里造出 node 执行器事实源的完整形态（apps/ 树 + manifests）。

    与 node 侧 deployed-apps.spec.ts / installed-packages.spec.ts 的命中用例
    同构：合法 appId 目录 + current 软链 + releases + app.json，以及
    .pkg-updates/manifests/<packageId>.json。python 侧若错误地实现了扫描，
    这些事实会被报上去——本测试据此红。
    """
    import json
    from pathlib import Path

    root = Path(work_dir)
    app_root = root / 'apps' / 'demo-app' / 'releases' / '1.0.0-abc123-def456-7890abcd'
    app_root.mkdir(parents=True)
    (root / 'apps' / 'demo-app' / 'current').symlink_to(app_root, target_is_directory=True)
    (root / 'apps' / 'demo-app' / 'app.json').write_text(json.dumps({
        'appName': 'demo-app',
        'runMode': 'daemon',
        'lastVersion': '1.0.0',
        'lastDeployedAt': '2026-10-24T00:00:00.000Z',
    }), encoding='utf-8')
    manifests = root / '.pkg-updates' / 'manifests'
    manifests.mkdir(parents=True)
    (manifests / 'pkg-001.json').write_text(json.dumps({
        'packageId': 'pkg-001',
        'name': 'rpa-runtime',
        'type': 'python',
        'version': '2.3.1',
    }), encoding='utf-8')


class TestProtocolV7KeysAlwaysOmitted:
    """协议 v7 两键恒省略（fail-honest：无事实源 → 不上报，不硬造空数组）。"""

    @pytest.mark.asyncio
    async def test_heartbeat_payload_omits_both_keys_by_default(self):
        """默认（无任何 node 形态目录）心跳不含两键——省略 = 未上报。"""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=_create_mock_response(200))
        body = await _capture_heartbeat_body(mock_client)

        assert 'deployedApps' not in body, (
            'python 侧无 /api/deploy 事实源，deployedApps 必须省略（不得硬造空数组）'
        )
        assert 'installedPackages' not in body, (
            'python 侧无 /api/update-package 事实源，installedPackages 必须省略'
        )

    @pytest.mark.asyncio
    async def test_heartbeat_payload_still_carries_core_fields(self):
        """两键缺席不影响心跳本体：核心字段照报、协议版本跟随 config 常量。

        （v7 时为 `== 7`；方案 b 一次 bump 合并到 v8，v7 两键在 v8 下仍缺席，
        断言从钉字面量改为与 config.PROTOCOL_VERSION 同源——版本常量的三端
        一致性由 admin protocol-version-consistency.spec 钉住，这里不重复抄。）
        """
        from config import PROTOCOL_VERSION

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=_create_mock_response(200))
        body = await _capture_heartbeat_body(mock_client)

        for field in ('address', 'cpuUsage', 'memUsage', 'runningTaskCount',
                      'runningExecutionIds', 'protocolVersion'):
            assert field in body, f'心跳核心字段 {field} 不应因 v7 两键缺席而丢失'
        assert body['protocolVersion'] == PROTOCOL_VERSION
        # 方案 b（v8）：registrationConflict 在本侧也恒缺席（auth.py 无 409
        # 观测——缺口登记见 auth.py._fetch_token 头注）。
        assert 'registrationConflict' not in body

    @pytest.mark.asyncio
    async def test_heartbeat_never_reports_node_shaped_tree(self, monkeypatch, tmp_path):
        """共用 workDir 场景：node 形态的 apps/ 树与 manifests 在场也不代报。"""
        _plant_node_shaped_tree(tmp_path)
        monkeypatch.setattr(scheduler_module.settings, 'work_dir', str(tmp_path))
        # .pkg-updates 的 node 侧根在 cwd 下——模拟同机共用 cwd 的更极端场景。
        # （cwd 只读探测：测试绝不向仓库写任何目录。）
        from pathlib import Path
        assert not Path.cwd().joinpath('.pkg-updates', 'manifests').exists()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=_create_mock_response(200))
        body = await _capture_heartbeat_body(mock_client)

        assert 'deployedApps' not in body
        assert 'installedPackages' not in body

    def test_register_payload_omits_both_keys_by_default(self, monkeypatch, tmp_path):
        """注册载荷同样恒省略两键（register 与 heartbeat 同批可选键）。"""
        from config import settings, PROTOCOL_VERSION

        monkeypatch.setattr(settings, 'app_name', 'py-executor')
        monkeypatch.setattr(settings, 'executor_address', 'localhost:8001')
        monkeypatch.setattr(settings, 'executor_address_public', '')
        monkeypatch.setattr(settings, 'work_dir', str(tmp_path))
        _plant_node_shaped_tree(tmp_path)

        payload = _register_payload()
        assert 'deployedApps' not in payload
        assert 'installedPackages' not in payload
        # 协议版本跟随 config 常量（v7 → 方案 b 一次 bump 合并到 v8，两键在
        # v8 下仍缺席；版本三端一致性由 admin protocol-version-consistency 钉）。
        assert payload['protocolVersion'] == PROTOCOL_VERSION
