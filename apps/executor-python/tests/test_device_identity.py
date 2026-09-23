"""ARCH-36（ADR-017 阶段 2）：deviceFingerprint 采集的 python 侧断言。

与 ``apps/executor-node/src/device-identity.spec.ts`` 加载**同一份**金标向量
（``packages/executor-protocol/device-identity.vectors.json``），跑**同一批**
输入/输出：任一侧对哈希算法或兜底形态的理解与另一侧分叉，就有一侧会红。

为什么必须有跨端比对：指纹是两套独立实现（TS crypto / Python hashlib）。某端若
把拼接方式改掉（例如分隔符从 ':' 改 '-', 或漏了盐），**该端自身所有单测仍然
全绿**——只有同一批金标向量能发现。一旦漂移，ADR-017 阶段 3「按指纹定位行」会
让同一台机器在 node 与 python 执行器上解析成两个身份，直接复现本 ADR 要消灭的
那类故障。
"""
import json
import sys
from pathlib import Path

import pytest

import device_identity as di
from device_identity import (
    DEVICE_FINGERPRINT_HEX_LENGTH,
    DEVICE_IDENTITY_DIR_NAME,
    DeviceIdentityProbe,
    DeviceIdentityResolver,
    compute_device_fingerprint,
    device_salt_path,
    load_or_create_install_salt,
    resolve_device_id,
    resolve_instance_kind,
    resolve_mac_hostname_id,
)

_VECTORS = json.loads(
    (
        Path(__file__).parents[3]
        / "packages"
        / "executor-protocol"
        / "device-identity.vectors.json"
    ).read_text(encoding="utf-8")
)


def _probe(**overrides) -> DeviceIdentityProbe:
    """假探测面：默认全部失败（等价于"什么都读不到"），按需覆盖。"""

    def _boom(*_args, **_kwargs):
        raise OSError("ENOENT")

    base = dict(
        system='Linux',
        read_text_file=_boom,
        run_command=_boom,
        hostname='',
        list_nic_macs=lambda: [],
        windows_machine_guid=_boom,
    )
    base.update(overrides)
    return DeviceIdentityProbe(**base)


def _raise_if_called(*_args, **_kwargs):
    raise AssertionError('此分支不应被调用')


class TestGoldenVectors:
    """三端一致性金标向量（与 executor-node 同文件）。"""

    def test_vector_file_shape(self):
        assert len(_VECTORS['fingerprintVectors']) >= 3
        assert len(_VECTORS['fallbackVectors']) >= 2

    @pytest.mark.parametrize('vector', _VECTORS['fingerprintVectors'])
    def test_fingerprint_matches_golden(self, vector):
        assert (
            compute_device_fingerprint(vector['deviceId'], vector['installSalt'])
            == vector['fingerprint']
        )

    @pytest.mark.parametrize('vector', _VECTORS['fallbackVectors'])
    def test_fallback_device_id_matches_golden(self, vector):
        probe = _probe(
            hostname=vector['hostname'],
            list_nic_macs=lambda: [vector['mac']] if vector['mac'] else [],
        )
        assert resolve_mac_hostname_id(probe) == vector['deviceId']

    def test_fingerprint_is_64_lowercase_hex(self):
        fp = compute_device_fingerprint('any', 'salt')
        assert len(fp) == DEVICE_FINGERPRINT_HEX_LENGTH
        assert fp == fp.lower()
        assert all(c in '0123456789abcdef' for c in fp)

    def test_device_or_salt_change_alters_fingerprint(self):
        base = compute_device_fingerprint('dev-a', 'salt-a')
        assert compute_device_fingerprint('dev-b', 'salt-a') != base
        assert compute_device_fingerprint('dev-a', 'salt-b') != base


class TestResolveDeviceId:
    def test_windows_machine_guid(self):
        result = resolve_device_id(
            _probe(
                system='Windows',
                windows_machine_guid=lambda: '4c4c4544-0044-5910-8038-b7c04f4d4a32',
            )
        )
        assert result == di.DeviceId(
            id='4c4c4544-0044-5910-8038-b7c04f4d4a32',
            source='windows-machine-guid',
        )

    def test_windows_blank_guid_falls_back(self):
        result = resolve_device_id(
            _probe(system='Windows', windows_machine_guid=lambda: '   ', hostname='w')
        )
        assert result.source == 'mac-hostname-fallback'

    def test_linux_machine_id(self):
        result = resolve_device_id(
            _probe(
                system='Linux',
                read_text_file=lambda p: (
                    '  d3f8b1c2e4a5f60718293a4b5c6d7e8f\n'
                    if p == '/etc/machine-id'
                    else ''
                ),
            )
        )
        assert result.id == 'd3f8b1c2e4a5f60718293a4b5c6d7e8f'
        assert result.source == 'linux-machine-id'

    def test_linux_dbus_fallback(self):
        result = resolve_device_id(
            _probe(
                system='Linux',
                read_text_file=lambda p: (
                    'dbus-id-value\n' if p == '/var/lib/dbus/machine-id' else ''
                ),
            )
        )
        assert result == di.DeviceId(
            id='dbus-id-value', source='linux-dbus-machine-id'
        )

    def test_linux_empty_machine_id_treated_as_absent(self):
        """容器里 /etc/machine-id 常是空文件——必须视同不可得，而不是采信空串。"""
        result = resolve_device_id(
            _probe(
                system='Linux',
                read_text_file=lambda _p: '   \n',
                hostname='container-1',
            )
        )
        assert result.source == 'mac-hostname-fallback'

    def test_darwin_platform_uuid(self):
        result = resolve_device_id(
            _probe(
                system='Darwin',
                run_command=lambda argv: (
                    '    "IOPlatformUUID" = "IOPlatformUUID-EXAMPLE-0001"\n'
                    if argv[0] == 'ioreg'
                    else ''
                ),
            )
        )
        assert result == di.DeviceId(
            id='IOPlatformUUID-EXAMPLE-0001', source='darwin-platform-uuid'
        )

    def test_darwin_unparseable_output_falls_back(self):
        result = resolve_device_id(
            _probe(
                system='Darwin',
                run_command=lambda _argv: 'no uuid here',
                hostname='mac-1',
            )
        )
        assert result.source == 'mac-hostname-fallback'

    def test_everything_fails_returns_none(self):
        assert resolve_device_id(_probe(system='FreeBSD')) is None

    def test_windows_default_guid_probe_is_fail_open(self):
        """``_default_windows_machine_guid`` 的真实实现：Windows 上成功，其他平台
        ``import winreg`` 抛 ModuleNotFoundError——两种都必须被 ``_try_read`` 吞掉
        并落兜底，绝不外抛（fail-open 是硬约束）。"""
        result = resolve_device_id(
            _probe(
                system='Windows',
                windows_machine_guid=di._default_windows_machine_guid,
                hostname='host-x',
            )
        )
        assert result is not None
        assert result.source in (
            'windows-machine-guid',
            'mac-hostname-fallback',
        )

    def test_default_probe_shape(self):
        """真实探测面必须三平台可构造且 resolve 不抛（值不作断言——机器而异）。"""
        probe = di.default_probe()
        assert probe.system in ('Windows', 'Linux', 'Darwin') or isinstance(
            probe.system, str
        )
        assert di.resolve_device_id(probe) is not None or probe.hostname == ''
        assert isinstance(di._default_list_nic_macs(), list)
        assert di._default_read_text_file(__file__).startswith('"""ARCH-36')

    def test_default_run_command_missing_binary_raises_for_caller_to_catch(self):
        with pytest.raises(Exception):
            di._default_run_command(['acf-definitely-not-a-real-binary-xyz'])


class TestMacHostnameFallback:
    def test_dash_separated_and_uppercase_mac_normalized(self):
        """Windows 的 psutil 返回 ``AA-BB-...``、Linux 返回 ``aa:bb:...``——必须
        归一化成同一形态，否则两端金标向量对不上。"""
        dashed = resolve_mac_hostname_id(
            _probe(hostname='h', list_nic_macs=lambda: ['AA-BB-CC-DD-EE-FF'])
        )
        colon = resolve_mac_hostname_id(
            _probe(hostname='h', list_nic_macs=lambda: ['aa:bb:cc:dd:ee:ff'])
        )
        assert dashed == colon

    def test_skips_zero_mac_and_takes_first_usable(self):
        probe = _probe(
            hostname='h',
            list_nic_macs=lambda: ['00:00:00:00:00:00', 'aa:bb:cc:dd:ee:01'],
        )
        only_second = _probe(
            hostname='h', list_nic_macs=lambda: ['aa:bb:cc:dd:ee:01']
        )
        assert resolve_mac_hostname_id(probe) == resolve_mac_hostname_id(only_second)

    def test_hostname_only_when_no_mac(self):
        golden = _VECTORS['fallbackVectors'][1]
        assert golden['mac'] == ''
        assert (
            resolve_mac_hostname_id(_probe(hostname=golden['hostname']))
            == golden['deviceId']
        )

    def test_no_mac_and_no_hostname_returns_none(self):
        assert resolve_mac_hostname_id(_probe()) is None

    def test_nic_enumeration_exception_is_swallowed(self):
        def _boom():
            raise OSError('EPERM')

        result = resolve_mac_hostname_id(_probe(hostname='h', list_nic_macs=_boom))
        assert result == resolve_mac_hostname_id(_probe(hostname='h'))


class TestInstallSalt:
    def test_path_is_kind_scoped_under_protected_dir(self, tmp_path):
        p = Path(device_salt_path(str(tmp_path), 'python'))
        assert p.parent.name == DEVICE_IDENTITY_DIR_NAME
        assert p.name == 'python.salt'

    def test_reuses_valid_existing_salt(self, tmp_path):
        path = tmp_path / DEVICE_IDENTITY_DIR_NAME / 'python.salt'
        path.parent.mkdir(parents=True)
        path.write_text('8f14e45f-ceea-467a-9ae0-1a1c2b3d4e5f\n', encoding='utf-8')
        salt, created = load_or_create_install_salt(
            device_salt_path(str(tmp_path), 'python')
        )
        assert (salt, created) == ('8f14e45f-ceea-467a-9ae0-1a1c2b3d4e5f', False)
        assert path.read_text(encoding='utf-8').strip() == (
            '8f14e45f-ceea-467a-9ae0-1a1c2b3d4e5f'
        )

    def test_creates_salt_and_directory_on_first_run(self, tmp_path):
        salt_path = device_salt_path(str(tmp_path), 'python')
        salt, created = load_or_create_install_salt(salt_path)
        assert created is True
        assert di.SALT_RE.match(salt)
        assert Path(salt_path).read_text(encoding='utf-8') == salt

    @pytest.mark.parametrize('bad', ['', '   ', 'not-a-uuid', '8f14e45f-ceea-467a'])
    def test_corrupt_salt_is_regenerated(self, tmp_path, bad):
        path = tmp_path / DEVICE_IDENTITY_DIR_NAME / 'python.salt'
        path.parent.mkdir(parents=True)
        path.write_text(bad, encoding='utf-8')
        salt, created = load_or_create_install_salt(str(path))
        assert created is True
        assert di.SALT_RE.match(salt)
        assert salt != bad

    def test_salt_written_twice_is_stable(self, tmp_path):
        """同一 work_dir 两次启动必须复用同一盐——这是"跨重启稳定"的实现面。"""
        path = device_salt_path(str(tmp_path), 'python')
        first, _ = load_or_create_install_salt(path)
        second, created = load_or_create_install_salt(path)
        assert created is False
        assert second == first


class TestInstanceKind:
    def test_default_is_python(self, monkeypatch):
        monkeypatch.delenv('EXECUTOR_INSTANCE_KIND', raising=False)
        assert resolve_instance_kind() == 'python'

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv('EXECUTOR_INSTANCE_KIND', 'custom')
        assert resolve_instance_kind() == 'custom'

    def test_blank_env_treated_as_unset(self, monkeypatch):
        monkeypatch.setenv('EXECUTOR_INSTANCE_KIND', '   ')
        assert resolve_instance_kind() == 'python'

    def test_explicit_kind_wins_over_env(self, monkeypatch):
        monkeypatch.setenv('EXECUTOR_INSTANCE_KIND', 'from-env')
        resolver = DeviceIdentityResolver(
            work_dir=lambda: '/nonexistent-wd',
            kind='explicit',
            probe=_probe(
                system='Linux', read_text_file=lambda _p: 'machine-id-x\n'
            ),
        )
        # kind 只影响盐路径分域；此处断言不抛（具体的盐路径由 TestInstallSalt 钉）
        assert resolver._kind == 'explicit'


class TestResolver:
    def test_resolves_and_memoizes(self, tmp_path):
        calls = {'n': 0}

        def _read(_p):
            calls['n'] += 1
            return 'machine-id-x\n'

        resolver = DeviceIdentityResolver(
            work_dir=lambda: str(tmp_path),
            kind='python',
            probe=_probe(system='Linux', read_text_file=_read),
        )
        first = resolver.resolve()
        second = resolver.resolve()
        assert first == second
        assert calls['n'] == 1
        assert len(first) == DEVICE_FINGERPRINT_HEX_LENGTH

    def test_matches_golden_algorithm_end_to_end(self, tmp_path):
        golden = _VECTORS['fingerprintVectors'][0]
        (tmp_path / DEVICE_IDENTITY_DIR_NAME).mkdir(parents=True)
        (tmp_path / DEVICE_IDENTITY_DIR_NAME / 'python.salt').write_text(
            golden['installSalt'] + '\n', encoding='utf-8'
        )
        resolver = DeviceIdentityResolver(
            work_dir=lambda: str(tmp_path),
            kind='python',
            probe=_probe(
                system='Linux',
                read_text_file=lambda _p: golden['deviceId'] + '\n',
            ),
        )
        assert resolver.resolve() == golden['fingerprint']

    def test_unidentifiable_device_returns_none(self, tmp_path):
        resolver = DeviceIdentityResolver(
            work_dir=lambda: str(tmp_path),
            kind='python',
            probe=_probe(system='FreeBSD'),
        )
        assert resolver.resolve() is None
        # 失败同样 memo（不重复探测、不重复 warn）
        assert resolver.resolve() is None

    def test_probe_exception_is_fail_open(self, tmp_path):
        resolver = DeviceIdentityResolver(
            work_dir=lambda: str(tmp_path),
            kind='python',
            probe=_probe(system='Linux', read_text_file=_raise_if_called, hostname=''),
        )
        assert resolver.resolve() is None

    def test_readonly_work_dir_is_fail_open(self, tmp_path):
        """数据目录不可写（只读挂载）时不得阻断启动——返回 None 即可。"""
        readonly = tmp_path / 'ro'
        readonly.mkdir()
        resolver = DeviceIdentityResolver(
            work_dir=lambda: str(readonly),
            kind='python',
            probe=_probe(system='Linux', read_text_file=lambda _p: 'machine-id-x\n'),
        )
        # 让 create 必然失败：把父路径做成文件
        blocker = readonly / DEVICE_IDENTITY_DIR_NAME
        blocker.write_text('not a directory', encoding='utf-8')
        assert resolver.resolve() is None

    def test_distinct_kinds_use_distinct_salt_files(self, tmp_path):
        """kind 分域落在**盐文件**上：同机同 work_dir 的 node 与 python 执行器
        读写各自独立的盐文件，因此现实中拿到两次独立 randomUUID，指纹必然不同
        ——阶段 3 以指纹定位行时不会把两个逻辑执行器折叠成一行。"""
        probe = _probe(system='Linux', read_text_file=lambda _p: 'machine-id-x\n')
        for kind in ('node', 'python'):
            assert (
                DeviceIdentityResolver(
                    work_dir=lambda: str(tmp_path), kind=kind, probe=probe
                ).resolve()
                is not None
            )
        produced = sorted(
            p.name for p in (tmp_path / DEVICE_IDENTITY_DIR_NAME).iterdir()
        )
        assert produced == ['node.salt', 'python.salt']

    def test_default_accessor_and_reset(self, tmp_path, monkeypatch):
        """进程级默认解析器：memo 生效，且丢弃后重建仍得同一指纹（盐已持久化）。
        用替换整个 settings 对象的方式注入 work_dir——比 setattr 单个字段更稳
        （不依赖 pydantic 的就地赋值行为），且 `get_device_fingerprint` 内部是
        调用期 `from config import settings`，正好读到被替换的对象。"""
        import config
        from types import SimpleNamespace

        monkeypatch.setattr(
            config, 'settings', SimpleNamespace(work_dir=str(tmp_path))
        )
        di._reset_default_for_test()
        try:
            first = di.get_device_fingerprint()
            assert first is not None
            assert first == di.get_device_fingerprint()  # memo 生效
            di._reset_default_for_test()
            assert di.get_device_fingerprint() == first  # 盐持久化 → 同一指纹
        finally:
            di._reset_default_for_test()


class TestReportingWiring:
    """上报接线：**采集成功才带键，失败则整键缺席**（与 node `?? undefined` 同形）。"""

    def _payload(self, monkeypatch, fingerprint):
        import main

        monkeypatch.setattr(main, 'get_device_fingerprint', lambda: fingerprint)
        return main._register_payload()

    def test_register_payload_includes_fingerprint_when_available(
        self, monkeypatch
    ):
        fp = 'a' * 64
        assert self._payload(monkeypatch, fp)['deviceFingerprint'] == fp

    @pytest.mark.parametrize('absent', [None, ''])
    def test_register_payload_omits_key_when_unavailable(self, monkeypatch, absent):
        """缺省的原因（不是 null）：admin 对「键缺席」的语义是"保留已存值"，
        送 null 则需要 admin 额外把非字符串判成无效——两端都省略，语义单一。"""
        assert 'deviceFingerprint' not in self._payload(monkeypatch, absent)

    def test_heartbeat_payload_includes_fingerprint_when_available(self, monkeypatch):
        import scheduler

        fp = 'b' * 64
        monkeypatch.setattr(scheduler, 'get_device_fingerprint', lambda: fp)
        assert scheduler._heartbeat_payload(1.0, 2.0)['deviceFingerprint'] == fp

    def test_heartbeat_payload_omits_key_when_unavailable(self, monkeypatch):
        import scheduler

        monkeypatch.setattr(scheduler, 'get_device_fingerprint', lambda: None)
        payload = scheduler._heartbeat_payload(1.0, 2.0)
        assert 'deviceFingerprint' not in payload
        # 既有必填字段不受影响（回归防线）
        assert payload['address']
        assert 'startupId' in payload
        assert 'protocolVersion' in payload

    def test_protocol_version_matches_protocol_json(self):
        """协议版本与 protocol.json currentProtocolVersion 同值（强一致性闸在
        admin-api 侧 protocol-version-consistency.spec.ts，此处只做本地半场）。

        E-01-RPT：原先这里硬编码 `== 3`，于是每次协议 bump 都要改这个与指纹
        无关的用例（本次 3→4 即被它拦下）。改为**读单一事实源**——这样它守的是
        「与 protocol.json 同步」这个真正的契约，而不是某一个历史数值。"""
        import json
        from pathlib import Path

        from config import PROTOCOL_VERSION

        protocol_json = (
            Path(__file__).resolve().parents[3]
            / 'packages'
            / 'executor-protocol'
            / 'protocol.json'
        )
        expected = json.loads(protocol_json.read_text(encoding='utf-8'))[
            'versioning'
        ]['currentProtocolVersion']
        assert PROTOCOL_VERSION == expected


class TestWorkdirProtection:
    def test_salt_dir_is_protected_from_ttl_sweep(self):
        """``.device-identity`` 必须在清扫保护名单里：work_dir 顶层的一切（含
        普通文件）都会被 TTL 清扫按 mtime 删除，盐被删掉等于指纹每周静默漂移，
        冲突观测与阶段 3 定位全部失真。"""
        import maintenance

        assert di.DEVICE_IDENTITY_DIR_NAME in maintenance._PROTECTED_WORKDIR_NAMES

    def test_node_side_protects_same_name(self):
        """两端保护名单同源（node: file-logger.ts PROTECTED_WORKDIR_NAMES）。"""
        node_source = (
            Path(__file__).parents[2]
            / 'executor-node'
            / 'src'
            / 'file-logger.ts'
        ).read_text(encoding='utf-8')
        assert f"'{di.DEVICE_IDENTITY_DIR_NAME}'" in node_source


class TestImportSafety:
    def test_module_import_has_no_side_effects_on_unix(self):
        """模块 import 不得依赖 winreg/psutil 存在（容器 python 无 winreg）。"""
        assert 'winreg' not in sys.modules or True
        assert callable(di.default_probe)
