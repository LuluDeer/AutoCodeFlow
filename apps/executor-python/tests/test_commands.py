"""ARCH-33（ADR-016）：pull 控制面命令的本地执行分派。

安全相关的断言集中在「路径由本模块按封闭枚举构造，绝不采信中台载荷里的路径」
——这是本模块与「任意 URL 转发器」的唯一区别。

能力缺口的断言同样重要：python 执行器只有 6 类命令中的 2 类有本地路由，其余
4 类必须**如实回报 unsupported**，而不是回环打一个必然 404 的请求（那只会产出
一句无行动价值的 "HTTP 404"）。
"""
import httpx
import pytest

import commands


class _FakeResponse:
    def __init__(self, status_code: int, body=None):
        self.status_code = status_code
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError('no body')
        return self._body


class _FakeClient:
    def __init__(self, response=None, exc=None):
        self.response = response
        self.exc = exc
        self.calls = []

    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.exc is not None:
            raise self.exc
        return self.response


@pytest.fixture()
def local_client(monkeypatch):
    """打桩共享连接池 + 令牌，避免真实外呼。"""
    client = _FakeClient(response=_FakeResponse(200, {'updated_fields': []}))
    monkeypatch.setattr(commands, '_get_http_client', lambda: client)

    async def _token():
        return 'test-token'

    monkeypatch.setattr(commands, 'get_current_token', _token)
    return client


class TestCommandTypeEnum:
    def test_enum_is_closed_six_types(self):
        assert sorted(commands.CONTROL_COMMAND_TYPES) == [
            'app-stop',
            'app-uninstall',
            'config-reload',
            'deploy',
            'kill-execution',
            'update-package',
        ]

    @pytest.mark.parametrize('value', ['deploy', 'app-stop', 'config-reload'])
    def test_known_types_accepted(self, value):
        assert commands.is_control_command_type(value) is True

    @pytest.mark.parametrize('value', ['rm-rf', '', None, 42, ['deploy']])
    def test_unknown_types_rejected(self, value):
        assert commands.is_control_command_type(value) is False


class TestParseControlCommand:
    def test_missing_command_id_rejected(self):
        assert commands.parse_control_command({'type': 'deploy'}) is None

    def test_missing_type_rejected(self):
        assert commands.parse_control_command({'commandId': 'c1'}) is None

    def test_unknown_type_rejected(self):
        assert commands.parse_control_command(
            {'commandId': 'c1', 'type': 'evil'}
        ) is None

    @pytest.mark.parametrize('raw', [None, 'nope', 42, ['x']])
    def test_non_dict_rejected(self, raw):
        assert commands.parse_control_command(raw) is None

    def test_valid_command_parsed(self):
        parsed = commands.parse_control_command(
            {'commandId': 'c1', 'type': 'deploy', 'payload': {'a': 1}, 'issuedAt': 5}
        )
        assert parsed == {
            'commandId': 'c1',
            'type': 'deploy',
            'payload': {'a': 1},
            'issuedAt': 5,
        }

    def test_non_dict_payload_normalised_to_empty(self):
        parsed = commands.parse_control_command(
            {'commandId': 'c1', 'type': 'deploy', 'payload': 'x'}
        )
        assert parsed['payload'] == {}

    def test_non_numeric_issued_at_becomes_none(self):
        parsed = commands.parse_control_command(
            {'commandId': 'c1', 'type': 'deploy', 'issuedAt': 'soon'}
        )
        assert parsed['issuedAt'] is None


class TestPathInjectionDefence:
    def test_quote_path_segment_encodes_slashes(self):
        # urllib.parse.quote 默认 safe='/' —— 斜杠不编码会让 ../../ 穿进 URL
        assert commands.quote_path_segment('../../etc/passwd') == (
            '..%2F..%2Fetc%2Fpasswd'
        )

    def test_quote_path_segment_handles_none_and_non_str(self):
        assert commands.quote_path_segment(None) == ''
        assert commands.quote_path_segment(42) == '42'


class TestExecuteControlCommand:
    @pytest.mark.asyncio
    async def test_config_reload_loops_back_to_local_route(self, local_client):
        result = await commands.execute_control_command(
            {'commandId': 'c1', 'type': 'config-reload', 'payload': {'a': 1}}
        )

        assert result['ok'] is True
        assert result['status'] == 200
        url, kwargs = local_client.calls[0]
        from config import settings
        assert url == f'http://127.0.0.1:{settings.port}/api/config/reload'
        assert kwargs['json'] == {'a': 1}
        assert kwargs['headers']['Authorization'] == 'Bearer test-token'

    @pytest.mark.asyncio
    async def test_kill_execution_encodes_execution_id(self, local_client):
        await commands.execute_control_command({
            'commandId': 'c1',
            'type': 'kill-execution',
            'payload': {'executionId': '../../etc/passwd'},
        })

        url, _ = local_client.calls[0]
        assert url.endswith('/api/executions/..%2F..%2Fetc%2Fpasswd/kill')
        # 原样未编码的穿越串绝不出现在 URL 里
        assert '../../' not in url

    @pytest.mark.asyncio
    async def test_payload_path_field_is_ignored(self, local_client):
        """中台载荷里的 path/url 字段不得成为任意路径转发器。"""
        await commands.execute_control_command({
            'commandId': 'c1',
            'type': 'config-reload',
            'payload': {'path': '/api/../admin/secret', 'url': 'http://evil.example/x'},
        })

        url, _ = local_client.calls[0]
        assert url.endswith('/api/config/reload')
        assert 'evil.example' not in url

    @pytest.mark.asyncio
    async def test_local_route_rejects_with_detail(self, monkeypatch):
        client = _FakeClient(response=_FakeResponse(400, {'detail': 'bad workDir'}))
        monkeypatch.setattr(commands, '_get_http_client', lambda: client)

        async def _token():
            return 't'

        monkeypatch.setattr(commands, 'get_current_token', _token)
        result = await commands.execute_control_command(
            {'commandId': 'c1', 'type': 'config-reload', 'payload': {}}
        )

        assert result['ok'] is False
        assert result['status'] == 400
        assert result['error'] == 'bad workDir'

    @pytest.mark.asyncio
    async def test_non_json_error_body_falls_back_to_status(self, monkeypatch):
        client = _FakeClient(response=_FakeResponse(500, None))
        monkeypatch.setattr(commands, '_get_http_client', lambda: client)

        async def _token():
            return 't'

        monkeypatch.setattr(commands, 'get_current_token', _token)
        result = await commands.execute_control_command(
            {'commandId': 'c1', 'type': 'config-reload', 'payload': {}}
        )

        assert result['ok'] is False
        assert result['error'] == 'HTTP 500'

    @pytest.mark.asyncio
    async def test_transport_error_converges_to_ok_false(self, monkeypatch):
        client = _FakeClient(exc=httpx.ConnectError('connect refused'))
        monkeypatch.setattr(commands, '_get_http_client', lambda: client)

        async def _token():
            return 't'

        monkeypatch.setattr(commands, 'get_current_token', _token)
        result = await commands.execute_control_command(
            {'commandId': 'c1', 'type': 'config-reload', 'payload': {}}
        )

        assert result['ok'] is False
        assert 'connect refused' in result['error']

    @pytest.mark.asyncio
    async def test_result_always_carries_command_id_and_type(self, local_client):
        result = await commands.execute_control_command(
            {'commandId': 'cmd-42', 'type': 'config-reload', 'payload': {}}
        )
        assert result['commandId'] == 'cmd-42'
        assert result['type'] == 'config-reload'
        assert isinstance(result['durationMs'], int)


class TestCapabilityGap:
    """python 执行器缺席的 4 类命令必须如实回报 unsupported。

    这些端点（/api/deploy、/api/app-stop、/api/app-uninstall、
    /api/update-package）是 node-only，protocol.json 的 executorNodeOnly 段已
    登记。回环打一个必然 404 的请求只会产出无行动价值的 "HTTP 404"。
    """

    @pytest.mark.parametrize('command_type', [
        'deploy', 'app-stop', 'app-uninstall', 'update-package',
    ])
    @pytest.mark.asyncio
    async def test_unsupported_types_report_unsupported_without_http(
        self, command_type, local_client,
    ):
        result = await commands.execute_control_command({
            'commandId': 'c1',
            'type': command_type,
            'payload': {},
        })

        assert result['ok'] is False
        assert '未在 python 执行器上实现' in result['error']
        assert 'executorNodeOnly' in result['error']
        # 关键：**没有**发起任何本地 HTTP 请求
        assert local_client.calls == []

    @pytest.mark.asyncio
    async def test_supported_types_are_exactly_two(self):
        """扫描面非空 + 钉死：新增本地路由时必须显式更新本断言。"""
        assert sorted(commands._LOCAL_ROUTES) == ['config-reload', 'kill-execution']
        # 每个本地路由都必须是封闭枚举的成员（防手滑写错键名）
        for key in commands._LOCAL_ROUTES:
            assert commands.is_control_command_type(key)


class TestRunControlCommands:
    @pytest.mark.asyncio
    async def test_empty_and_non_list_are_noops(self, monkeypatch):
        called = []

        async def _spy(_cmd):
            called.append(_cmd)
            return {'ok': True}

        monkeypatch.setattr(commands, 'execute_control_command', _spy)
        await commands.run_control_commands(None)
        await commands.run_control_commands([])
        await commands.run_control_commands('nope')
        assert called == []

    @pytest.mark.asyncio
    async def test_malformed_entries_skipped_without_execution(self, monkeypatch):
        executed = []

        async def _spy(cmd):
            executed.append(cmd['commandId'])
            return {'commandId': cmd['commandId'], 'type': cmd['type'], 'ok': True}

        async def _report(_r):
            return None

        monkeypatch.setattr(commands, 'execute_control_command', _spy)
        monkeypatch.setattr(commands, 'report_command_result', _report)

        await commands.run_control_commands([
            {'type': 'deploy'},                      # 缺 commandId
            {'commandId': 'x', 'type': 'evil'},      # 未知 type
            'not-a-dict',
            {'commandId': 'ok1', 'type': 'config-reload', 'payload': {}},
        ])

        assert executed == ['ok1']

    @pytest.mark.asyncio
    async def test_serial_execution_preserves_stop_then_uninstall_order(
        self, monkeypatch,
    ):
        seen = []

        async def _spy(cmd):
            seen.append(cmd['type'])
            return {'commandId': cmd['commandId'], 'type': cmd['type'], 'ok': True}

        async def _report(_r):
            return None

        monkeypatch.setattr(commands, 'execute_control_command', _spy)
        monkeypatch.setattr(commands, 'report_command_result', _report)

        await commands.run_control_commands([
            {'commandId': 's1', 'type': 'app-stop', 'payload': {'deploymentId': 'd1'}},
            {'commandId': 's2', 'type': 'app-stop', 'payload': {'deploymentId': 'd2'}},
            {'commandId': 'u1', 'type': 'app-uninstall', 'payload': {'appId': 'a1'}},
        ])

        assert seen == ['app-stop', 'app-stop', 'app-uninstall']

    @pytest.mark.asyncio
    async def test_each_result_is_reported(self, monkeypatch):
        reported = []

        async def _spy(cmd):
            return {'commandId': cmd['commandId'], 'type': cmd['type'], 'ok': True}

        async def _report(result):
            reported.append(result['commandId'])

        monkeypatch.setattr(commands, 'execute_control_command', _spy)
        monkeypatch.setattr(commands, 'report_command_result', _report)

        await commands.run_control_commands([
            {'commandId': 'a', 'type': 'config-reload', 'payload': {}},
            {'commandId': 'b', 'type': 'kill-execution', 'payload': {}},
        ])

        assert reported == ['a', 'b']


class TestReportCommandResult:
    @pytest.mark.asyncio
    async def test_posts_to_command_result_with_address(self, monkeypatch):
        client = _FakeClient(response=_FakeResponse(200, {'ok': True}))
        monkeypatch.setattr(commands, '_get_http_client', lambda: client)

        async def _token():
            return 'tok'

        async def _self_heal(_client, _method, url, **_kwargs):
            client.calls.append((url, _kwargs))
            return _FakeResponse(200, {'ok': True})

        monkeypatch.setattr(commands, 'get_current_token', _token)
        monkeypatch.setattr(commands, 'request_with_self_heal', _self_heal)

        await commands.report_command_result({
            'commandId': 'c1', 'type': 'config-reload', 'ok': True,
        })

        url, kwargs = client.calls[0]
        assert url.endswith('/executors/command-result')
        assert kwargs['json']['commandId'] == 'c1'
        assert 'address' in kwargs['json']

    @pytest.mark.asyncio
    async def test_report_failure_is_swallowed(self, monkeypatch):
        """上报是 best-effort——失败绝不能让 pull 循环炸掉。"""

        async def _boom():
            raise RuntimeError('no token')

        monkeypatch.setattr(commands, 'get_current_token', _boom)

        # 不抛出即通过
        await commands.report_command_result({'commandId': 'c1', 'ok': True})


class TestUnsupportedCommandTypeReporting:
    """EXEC-04（第 3 轮并行审计，P2）：未知类型必须产出**可上报**的 ok:false。

    失败模式（改动前）：`parse_control_command` 对未知 type 返回 None →
    `run_control_commands` 只 warn 后 continue，**不上报**；中台那条命令行永远
    停在"已下发"，运维无法区分"执行器拒了"与"命令丢了"。

    安全语义不得放宽：未知类型**绝不执行任何动作**（不投递本地路由）。
    """

    def test_unknown_type_produces_reportable_result(self):
        result = commands.reject_unsupported_control_command(
            {'commandId': 'c1', 'type': 'evil'}
        )

        assert result == {
            'commandId': 'c1',
            'type': 'evil',
            'ok': False,
            'status': None,
            'error': 'unsupported command type: evil',
            'durationMs': 0,
        }

    def test_error_text_matches_node(self):
        """文案与 node `rejectUnsupportedControlCommand` 逐字一致。"""
        assert commands.UNSUPPORTED_COMMAND_TYPE_ERROR.format('rm-rf-slash') == (
            'unsupported command type: rm-rf-slash'
        )

    @pytest.mark.parametrize('command_type', commands.CONTROL_COMMAND_TYPES)
    def test_known_types_are_not_rejected(self, command_type):
        assert commands.reject_unsupported_control_command(
            {'commandId': 'c1', 'type': command_type}
        ) is None

    @pytest.mark.parametrize('raw', [
        None,
        'nope',
        42,
        ['x'],
        {},
        {'type': 'evil'},                   # 缺 commandId → 无从关联，只能丢弃
        {'commandId': '', 'type': 'evil'},
        {'commandId': 'bad id', 'type': 'evil'},   # 形态不合协议（含空格）
        {'commandId': '.leading', 'type': 'evil'},
        {'commandId': 'c1'},                # 缺 type
        {'commandId': 'c1', 'type': 42},
        {'commandId': 'c1', 'type': ''},
    ])
    def test_unreportable_payloads_return_none(self, raw):
        assert commands.reject_unsupported_control_command(raw) is None

    def test_overlong_type_truncated_in_type_field_but_full_in_error(self):
        """中台 DTO 的 type 上限 64——不截断会被 400 丢掉，又回到"没有结果行"。"""
        long_type = 'x' * 200
        result = commands.reject_unsupported_control_command(
            {'commandId': 'c1', 'type': long_type}
        )

        assert len(result['type']) == 64
        assert result['error'] == f'unsupported command type: {long_type}'
        assert len(result['error']) <= 1000


class TestRunControlCommandsReportsUnknownType:
    @pytest.fixture(autouse=True)
    def _reset_stats(self):
        commands.reset_command_stats()
        yield
        commands.reset_command_stats()

    @pytest.mark.asyncio
    async def test_unknown_type_is_reported_and_not_executed(self, monkeypatch):
        executed = []
        reported = []

        async def _exec(cmd):
            executed.append(cmd['commandId'])
            return {'commandId': cmd['commandId'], 'type': cmd['type'], 'ok': True}

        async def _report(result):
            reported.append(result)

        monkeypatch.setattr(commands, 'execute_control_command', _exec)
        monkeypatch.setattr(commands, 'report_command_result', _report)

        await commands.run_control_commands([
            {'commandId': 'x1', 'type': 'rm-rf-slash', 'payload': {}},
        ])

        assert executed == []
        assert len(reported) == 1
        assert reported[0]['ok'] is False
        assert reported[0]['commandId'] == 'x1'
        assert reported[0]['error'] == 'unsupported command type: rm-rf-slash'
        assert commands.get_command_stats() == {
            'executed': 0,
            'reported': 1,
            'reportFailed': 0,
            'unsupportedTypeRejected': 1,
        }

    @pytest.mark.asyncio
    async def test_missing_command_id_still_dropped(self, monkeypatch, caplog):
        reported = []

        async def _report(result):
            reported.append(result)

        monkeypatch.setattr(commands, 'report_command_result', _report)

        with caplog.at_level('WARNING'):
            await commands.run_control_commands([{'type': 'rm-rf-slash', 'payload': {}}])

        assert reported == []
        assert any(
            'Discarded malformed control command' in record.message
            for record in caplog.records
        )
        assert commands.get_command_stats()['unsupportedTypeRejected'] == 0

    @pytest.mark.asyncio
    async def test_report_failure_is_counted_and_warned(self, monkeypatch, caplog):
        async def _exec(cmd):
            return {'commandId': cmd['commandId'], 'type': cmd['type'], 'ok': True}

        async def _boom(_result):
            raise RuntimeError('admin unreachable')

        monkeypatch.setattr(commands, 'execute_control_command', _exec)
        monkeypatch.setattr(commands, 'report_command_result', _boom)

        with caplog.at_level('WARNING'):
            await commands.run_control_commands([
                {'commandId': 'c1', 'type': 'config-reload', 'payload': {}},
            ])

        stats = commands.get_command_stats()
        assert stats['reported'] == 0
        assert stats['reportFailed'] == 1
        assert any('Failed to report result' in r.message for r in caplog.records)
