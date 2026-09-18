"""`interpreters.py` 单测（FR-07/13/14/15、NFR-02/03/10/13/16、AC-14b、EG-06）。

**不调用真实 uv、不联网**：本模块的 uv 子进程入口 `_run_uv_sync` 被替换为可计数
的假实现（`fake_uv` fixture），缓存池用 `tmp_path` 伪造（目录布局与 uv 自己的
命名约定一致：`cpython-<完整版本>-<platform>-none/`）。
"""
import asyncio
import hashlib
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import interpreters
from config import ONLINE_DOWNLOAD_MIN, settings

# 与本机无关的稳定平台串（池目录名只用于解析/展示，不参与平台判定）。
#
# 注意用 **uv 平台三元组**（`linux-x86_64-gnu`），不要用 python-build-standalone
# 的发布三元组（`x86_64-unknown-linux-gnu`）——实测 uv 只识别自己词汇的目录名，
# pbs 三元组会被**静默忽略**（不报错、只是不出现），照抄会让离线预填失效。
# 详见 CONTRACT.md §0.2 勘误与 OFFLINE-PROVISIONING.md。
_PLATFORM = 'linux-x86_64-gnu'

# 与本机平台**不同**的稳定平台串（D-14：共享卷里外来平台条目必须被剔除）。
_FOREIGN_PLATFORM = 'windows-x86_64-none'

# 实测（CONTRACT.md §0）的真实 `uv python list --only-installed` 输出样本：
# 托管池条目 + 系统/非托管解释器（宿主 python3.14）混排。
#
# 注意池目录名的平台段**整段照抄 uv 三元组**：Windows 的 `windows-x86_64-none`
# 本身就以 `-none` 结尾（那是 libc 槽位），Linux 的 libc 槽位是 `gnu`，
# 所以 Linux 目录名**不带** `-none`（实测 `...-linux-x86_64-gnu-none` 会被 uv
# 判为非法请求 / 静默忽略）。见 CONTRACT.md §0.2。
REAL_LIST_OUTPUT = """\
cpython-3.14.6-windows-x86_64-none     C:\\Python314\\python.exe
cpython-3.13.13-windows-x86_64-none    C:\\ProgramData\\chocolatey\\bin\\python3.14.exe
cpython-3.12.3-windows-x86_64-none     /pool/cpython-3.12.3-windows-x86_64-none/python.exe
cpython-3.9.25-windows-x86_64-none     /pool/cpython-3.9.25-windows-x86_64-none/python.exe
cpython-3.7.9-linux-x86_64-gnu  /pool/cpython-3.7.9-linux-x86_64-gnu/bin/python3
"""


def _fake_bin(entry_dir: Path) -> Path:
    """造一个假解释器可执行文件（POSIX 下补可执行位）。"""
    python_bin = entry_dir / 'bin' / 'python3'
    python_bin.parent.mkdir(parents=True, exist_ok=True)
    python_bin.write_text('#!/bin/sh\necho "Python 3"\n')
    if os.name != 'nt':
        python_bin.chmod(0o755)
    return python_bin


# ---------------------------------------------------------------------------
# 夹具：池 + 假 uv
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def clean_module_state():
    """模块级状态（探测缓存/锁表/信号量表/完整性留痕）不得跨用例泄漏。"""
    interpreters.invalidate_cache()
    interpreters._version_locks.clear()
    interpreters._reset_semaphores()
    interpreters._reset_integrity_tracking()
    yield
    interpreters.invalidate_cache()
    interpreters._version_locks.clear()
    interpreters._reset_semaphores()
    interpreters._reset_integrity_tracking()


@pytest.fixture()
def pool(tmp_path, monkeypatch):
    """把缓存池指到 tmp_path/pool（并清掉 TTL 缓存）。"""
    root = tmp_path / 'pool'
    root.mkdir()
    monkeypatch.setattr(settings, 'uv_python_install_dir', str(root))
    monkeypatch.setattr(settings, 'uv_python_install_mirror', '')
    interpreters.invalidate_cache()
    return root


def make_entry(pool: Path, version: str, *, platform: str = _PLATFORM) -> Path:
    """按 uv 的命名约定造一个"已安装"解释器条目，返回其 python 可执行文件路径。

    使用 `bin/python3` 布局（POSIX 风格）——本模块对两种布局都支持，测试固定在
    一种，避免随宿主平台漂移。
    """
    return _fake_bin(pool / f'cpython-{version}-{platform}-none')


class FakeUV:
    """可编程的 `_run_uv_sync` 替身：记录 argv/env，按脚本产生结果。"""

    def __init__(self, pool: Path):
        self.pool = pool
        self.calls: list[list[str]] = []
        self.envs: list[dict] = []
        self.timeouts: list[float] = []
        self.install_result: tuple[int, str] | tuple[str, str] = (0, '')
        self.install_hook = None
        self.in_flight = 0
        self.max_in_flight = 0
        self.concurrent_versions: list[str] = []
        self._guard = threading.Lock()

    # -- 断言辅助 ---------------------------------------------------------
    @property
    def installs(self) -> list[list[str]]:
        return [call for call in self.calls if call[1:3] == ['python', 'install']]

    @property
    def install_versions(self) -> list[str]:
        return [call[3] for call in self.installs]

    # -- 替身实现 ---------------------------------------------------------
    def __call__(self, args, timeout, *, env=None):
        with self._guard:
            self.calls.append(list(args))
            self.envs.append(dict(env or {}))
            self.timeouts.append(timeout)
        if args[1:3] == ['python', 'list']:
            return 0, self.list_output()
        if args[1:3] == ['python', 'install']:
            return self._install(args, timeout)
        if '--version' in args:
            # `<python> --version` 抽查：版本取自池内目录名
            entry = Path(args[0]).parent.parent.name
            return 0, f'Python {entry.split("-")[1]}'
        return 0, ''

    def list_output(self) -> str:
        lines = []
        for entry_dir in sorted(self.pool.iterdir()):
            if not entry_dir.is_dir() or not entry_dir.name.startswith('cpython-'):
                continue
            version = entry_dir.name.split('-')[1]
            python_bin = entry_dir / 'bin' / 'python3'
            lines.append(f'cpython-{version}-{_PLATFORM}-none  {python_bin}')
        return '\n'.join(lines) + ('\n' if lines else '')

    def _install(self, args, timeout):
        version = args[3]
        with self._guard:
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
            self.concurrent_versions.append(version)
        try:
            if self.install_hook is not None:
                return self.install_hook(version, timeout)
            if isinstance(self.install_result, BaseException):
                raise self.install_result
            code, out = self.install_result
            if code == 0:
                make_entry(self.pool, f'{version}.20')
            return code, out
        finally:
            with self._guard:
                self.in_flight -= 1
                self.concurrent_versions.remove(version)


@pytest.fixture()
def fake_uv(pool, monkeypatch):
    fake = FakeUV(pool)
    monkeypatch.setattr(interpreters, '_run_uv_sync', fake)
    return fake


# ---------------------------------------------------------------------------
# 版本白名单（NFR-03 命令注入闸门）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('version', ['3.7', '3.13', '3.10', '4.0'])
def test_validate_version_accepts_major_minor(version):
    assert interpreters.validate_version(version) == version


@pytest.mark.parametrize('version', [
    '3', '3.7.9', '3.x', '../evil', '3.7; rm -rf /', '3.7 --mirror http://evil',
    '', '3.7\n', 'v3.7', ' 3.7', '3.7 ', None, 3.7, ['3.7'],
])
def test_validate_version_rejects_everything_else(version):
    with pytest.raises(ValueError):
        interpreters.validate_version(version)


@pytest.mark.parametrize('version', ['3', '3.7.9', '3.x', '../evil', '3.7; rm -rf /'])
def test_resolve_python_bin_rejects_bad_version_without_spawning_uv(
    fake_uv, version, monkeypatch
):
    """NFR-03：非法版本必须在任何子进程之前被拒（命令注入用例）。"""
    spawned = []
    monkeypatch.setattr(
        subprocess, 'Popen',
        lambda *a, **k: spawned.append(a) or pytest.fail('no subprocess allowed'),
    )
    with pytest.raises(ValueError):
        interpreters.resolve_python_bin(version)
    assert spawned == []
    assert fake_uv.calls == []


@pytest.mark.parametrize('version', ['3', '3.7.9', '3.x', '../evil', '3.7; rm -rf /'])
def test_ensure_version_rejects_bad_version_without_spawning_uv(fake_uv, version):
    with pytest.raises(ValueError):
        interpreters.ensure_version(version, timeout=5)
    assert fake_uv.calls == []


def test_ensure_version_rejects_bad_version_before_async_dispatch(fake_uv):
    async def scenario():
        with pytest.raises(ValueError):
            await interpreters.ensure_version_async('../evil', timeout=5)

    asyncio.run(scenario())
    assert fake_uv.calls == []


# ---------------------------------------------------------------------------
# discover_installed（FR-14 / NFR-10 / AC-14b）
# ---------------------------------------------------------------------------

def test_parse_python_list_handles_real_uv_output():
    """真实输出形态：`<key>` + 绝对路径两列，**且只保留本池条目**。

    池归属过滤（集成期修复的真实缺陷，与 executor-node `isInsidePool` 对齐）：
    uv 的输出里混有**系统/非托管**解释器（`C:\\Python314\\python.exe`、PATH 上的
    `.local/bin/python3.x.exe` shim）以及**别的池目录**。这些必须剔除，否则执行器
    会对 admin **谎报**版本可用——实测池里只有 3.11.13 时曾宣称
    `['3.11.13','3.13.13','3.14.6','3.9.23','3.9.25']`，而其中 4 个
    `resolve_python_bin()` 全部返回 None。admin 据此把 3.14 任务路由过来，
    运行期必然 `interpreter_unavailable`，还挤掉了真正预置了 3.14 的执行器。

    因此本用例断言**样本里 5 行中只有落在 `pool` 夹具内的那些会保留**
    （样本路径 `/pool/...` 与宿主 `C:\\Python314\\...` 等均为池外）。
    `available` 仍只做如实标注；可执行性过滤在 `_discover_uncached` 里做。
    """
    entries = interpreters._parse_python_list(REAL_LIST_OUTPUT, discovered_at='2026-09-16T00:00:00Z')

    # 样本中的非池外条目一律剔除；`/pool/...` 相对本机也不是池根 -> 全被过滤。
    assert [entry.version for entry in entries] == [], (
        'REAL_LIST_OUTPUT 里的路径都不是本池条目，必须全部被池归属过滤剔除'
    )
    assert all(entry.discovered_at == '2026-09-16T00:00:00Z' for entry in entries)
    assert all(isinstance(entry.path, str) and entry.path for entry in entries)
    for entry in entries:
        assert entry.available is Path(entry.path).is_file()


def test_parse_python_list_drops_foreign_platform_entries(pool):
    """D-14：同池但**外来平台**的条目必须剔除（CONTRACT.md §0.4）。

    为什么单独钉一条：compose 里把解释器池做成**共享卷**，而 executor-python 是
    Debian/glibc、executor-node 是 Alpine/musl —— **两种平台的产物天然共存**。
    Windows 上 `_is_executable` 只判存在性，Linux 条目的 `bin/python3` 会被判成
    "可用"，于是执行器宣称 3.11 可用、`resolve_python_bin('3.11')` 却返回一个
    **Linux 二进制** → `uv venv --python <它>` 必然失败。这是与 D-13 同类的谎报。

    用例刻意**以本机真实平台为基准**构造（本机 token 由被测函数给出），
    这样在 Windows / Linux / macOS 上跑都成立，不写死平台。
    """
    host = interpreters._current_platform_token()
    if host is None:  # pragma: no cover - 本机平台必定可判定
        pytest.skip('host platform token unavailable')

    native_dir = pool / f'cpython-3.11.13-{host}'
    native_bin = _fake_bin(native_dir)
    # 构一个与宿主**确实不同**的平台串（不写死，避免"宿主恰好等于它"而空转）。
    foreign = 'windows-x86_64-none' if not host.startswith('windows') else 'linux-x86_64-gnu'
    foreign_dir = pool / f'cpython-3.11.13-{foreign}'
    foreign_bin = _fake_bin(foreign_dir)

    output = (
        f'cpython-3.11.13-{host}    {native_bin}\n'
        f'cpython-3.11.13-{foreign}    {foreign_bin}\n'
    )
    entries = interpreters._parse_python_list(output, discovered_at='2026-09-16T00:00:00Z')

    assert len(entries) == 1, f'外来平台条目必须被剔除，实际保留 {len(entries)} 条'
    assert entries[0].path == str(native_bin), (
        f'应保留宿主平台条目 {native_bin}，实际 {entries[0].path}'
    )
    assert foreign not in entries[0].path


def test_platform_filter_is_lenient_when_host_token_unknown(pool, monkeypatch):
    """拿不准本机平台时必须**放行**（不误杀健康条目）。"""
    monkeypatch.setattr(interpreters, '_current_platform_token', lambda: None)
    pool_bin = make_entry(pool, '3.11.13')
    output = f'cpython-3.11.13-{_PLATFORM}    {pool_bin}\n'
    entries = interpreters._parse_python_list(output, discovered_at='t')
    assert len(entries) == 1, '平台判定不出时不得误杀条目'


def test_parse_python_list_keeps_only_pool_entries(pool):
    """正例：池内条目保留、池外（系统/shim/别的池）剔除。

    这是"宣称可用 == 真的解析得到"这条不变量的守卫。
    """
    pool_bin = make_entry(pool, '3.11.13')
    outside = pool.parent / 'somewhere-else' / 'cpython-3.14.6-windows-x86_64-none' / 'python.exe'
    output = (
        f'cpython-3.11.13-{_PLATFORM}-none    {pool_bin}\n'
        f'cpython-3.14.6-{_FOREIGN_PLATFORM}    {outside}\n'
        'cpython-3.13.13-windows-x86_64-none    C:\\Python313\\python.exe\n'
    )
    entries = interpreters._parse_python_list(output, discovered_at='2026-09-16T00:00:00Z')

    versions = [e.version for e in entries]
    assert versions == ['3.11.13'], f'只应保留池内 3.11.13，实际 {versions}'
    assert Path(entries[0].path).resolve().is_relative_to(pool.resolve())


def test_parse_python_list_handles_paths_containing_spaces(pool, monkeypatch):
    """池路径含空格时必须照常解析（回归：曾被 `parts[-1]` 静默丢弃）。

    旧实现用 `line.split()` 取 `parts[-1]` 当路径。`<key>` 不含空白，但路径可以
    ——池落在 `C:\\Program Files\\interpreters`、`/opt/my pool/...` 这类目录时，
    `parts[-1]` 只拿到最后一段（如 `python.exe`），既不是绝对路径也不在池内，
    于是整行被丢弃 → **池里有解释器却报空池** → 该执行器上所有声明了
    runtimeVersion 的任务必然 `interpreter_unavailable`。

    executor-node 不受影响（它用 `uv python list --output-format json`），
    故这是 python 侧独有的缺陷，两侧行为必须一致。
    """
    spaced_pool = pool.parent / 'my pool'
    spaced_pool.mkdir(parents=True, exist_ok=True)
    # 平台段必须用**本机** token：`_PLATFORM` 是固定字面量（linux），在 Windows
    # 上会被"外来平台"过滤剔除，那样测的就不是空格解析了（假阴性）。
    host = interpreters._current_platform_token()
    if host is None:  # pragma: no cover - 本机平台必定可判定
        pytest.skip('host platform token unavailable')
    entry_dir = spaced_pool / f'cpython-3.11.13-{host}'
    entry_bin = _fake_bin(entry_dir)

    monkeypatch.setattr(interpreters, 'pool_root', lambda: spaced_pool)
    output = f'cpython-3.11.13-{host}    {entry_bin}\n'

    entries = interpreters._parse_python_list(output, discovered_at='t')

    versions = [e.version for e in entries]
    assert versions == ['3.11.13'], (
        f'含空格的池路径必须被正确解析，实际 {versions}（空 = 被 parts[-1] 丢弃）'
    )
    assert Path(entries[0].path) == entry_bin


def test_parse_python_list_key_takes_only_first_whitespace_run(pool):
    """uv 用**多个空格**做列对齐；键必须是首段，路径是其余全部（含空格）。"""
    pool_bin = make_entry(pool, '3.12.3')
    # 列对齐：键与路径之间是多个空格（真实 uv 输出形态）。
    output = f'cpython-3.12.3-{_PLATFORM}-none       {pool_bin}\n'
    entries = interpreters._parse_python_list(output, discovered_at='t')
    assert [e.version for e in entries] == ['3.12.3']
    assert Path(entries[0].path) == pool_bin


def test_advertised_versions_equal_resolvable_versions(fake_uv, pool):
    """核心不变量（CONTRACT.md §0.4）：**宣称可用 ⟺ 真的解析得到**。

    背景：uv 的输出里混有系统 Python / PATH shim / 别的池目录。若不过滤，
    执行器会对 admin 谎报版本可用（实测池内只有 3.11.13 时宣称 5 个版本），
    admin 据此把 3.14 任务路由到这台根本没有 3.14 的机器 —— 运行期必然
    失败为 interpreter_unavailable，同时还挤掉了真正预置 3.14 的执行器。

    F-1（审计修复）：输出 key 的平台段曾硬编码 `windows-x86_64-none`，而池内
    条目目录用 `_PLATFORM`（linux-x86_64-gnu）——Linux CI 上平台过滤把池内
    条目全部剔除，`advertised` 为空列表，两个断言在空列表上**空转通过**（假绿），
    核心不变量从未被真正验证。且旧用例 output 里的路径还指向一个从未创建的
    目录（`cpython-3.11.13-{_PLATFORM}` 缺 `-none`），任何平台上 `_path_is_usable`
    都判 False → advertised 恒空。现改为以本机平台 token 动态构造（与
    test_parse_python_list_drops_foreign_platform_entries 行 264-285 同款写法）。

    L-4（审计扩展）：本用例同时覆盖"3+ 池内版本（含离线预填 3.7.9）+ 2 池外
    版本"的多版本混排，断言**每个** advertised 版本都能 resolve 且落在池内。
    """
    host = interpreters._current_platform_token()
    if host is None:  # pragma: no cover - 本机平台必定可判定
        pytest.skip('host platform token unavailable')
    # 构一个与宿主**确实不同**的平台串（不写死，避免"宿主恰好等于它"而空转）。
    foreign = 'windows-x86_64-none' if not host.startswith('windows') else 'linux-x86_64-gnu'

    # 池内 3 个版本：3.7.9（离线预填，低于在线下载下限）+ 3.11.13 + 3.12.3。
    in_pool = ['3.7.9', '3.11.13', '3.12.3']
    pool_bins = {}
    for version in in_pool:
        entry_dir = pool / f'cpython-{version}-{host}'
        pool_bins[version] = _fake_bin(entry_dir)

    # 池外/外来平台 2 个版本（不得被宣称）：
    #   1. 同池根内但平台段是外来 token → 平台过滤剔除（D-14 同款）；
    #   2. 别的池目录（stray-pool）+ 外来平台 → 池归属过滤剔除。
    foreign_in_pool = pool / f'cpython-3.14.6-{foreign}'
    _fake_bin(foreign_in_pool)
    out_of_pool = pool.parent / 'stray-pool' / f'cpython-3.13.13-{foreign}'
    _fake_bin(out_of_pool)

    lines = []
    for version in in_pool:
        lines.append(f'cpython-{version}-{host}    {pool_bins[version]}')
    lines.append(f'cpython-3.14.6-{foreign}    {foreign_in_pool / "bin" / "python3"}')
    lines.append(f'cpython-3.13.13-{foreign}    {out_of_pool / "bin" / "python3"}')
    output = '\n'.join(lines) + '\n'

    monkeypatch = pytest.MonkeyPatch()
    try:
        monkeypatch.setattr(
            interpreters, '_run_uv_sync', lambda args, timeout, env=None: (0, output),
        )
        # 走"uv 成功"分支，确保不是靠兜底扫描掩盖问题
        infos = interpreters.discover_installed()

        advertised = sorted({i.version for i in infos if i.available})
        # 不变量①：池外/外来平台的 3.13.13 / 3.14.6 **不得**被宣称
        assert not any(v.startswith(('3.13', '3.14')) for v in advertised), (
            f'池外的版本被谎报为可用：{advertised}'
        )
        # 不变量②（L-4）：池内 3 个版本必须**全部**可见，且只有它们（多版本混排）。
        assert advertised == sorted(in_pool), (
            f'池内版本必须全部被宣称且只有池内版本，实际 {advertised}'
        )
        # 不变量③：每个宣称可用的版本都必须真的能解析出来，且落在池内。
        # 注意 resolve_python_bin 的入参是**可声明的 X.Y 前缀**（CONTRACT.md §1.1，
        # 补丁号不是合法声明值）——全版本 3.11.13 由前缀 3.11 命中。
        for version in advertised:
            declared = version.rsplit('.', 1)[0]
            interpreters.invalidate_cache()  # 缓存失效后重探（仍走本用例的 uv 替身）
            resolved = interpreters.resolve_python_bin(declared)
            assert resolved is not None, f'宣称 {version} 可用，但 resolve_python_bin({declared!r}) 返回 None'
            assert Path(resolved).resolve() == Path(pool_bins[version]).resolve(), (
                f'前缀 {declared} 必须解析到所宣称的 {version} 条目'
            )
            assert Path(resolved).resolve().is_relative_to(pool.resolve())
    finally:
        monkeypatch.undo()
        interpreters.invalidate_cache()


def test_discover_installed_filters_out_unavailable_paths(pool, monkeypatch):
    """探测只上报**可用**条目；不可用条目被剔除且不抛异常（AC-14b）。"""
    monkeypatch.setattr(
        interpreters, '_run_uv_sync',
        lambda args, timeout, env=None: (0, REAL_LIST_OUTPUT),
    )
    entries = interpreters.discover_installed()

    assert all(entry.available for entry in entries)
    assert all(Path(entry.path).is_file() for entry in entries)


def test_discover_installed_drops_unavailable_entries(fake_uv, pool):
    """AC-14b：不可执行/缺失的池条目从上报清单剔除，其余照常。"""
    make_entry(pool, '3.12.3')
    # 3.11 目录存在但可执行文件缺失（损坏条目）
    (pool / f'cpython-3.11.9-{_PLATFORM}-none' / 'bin').mkdir(parents=True)

    entries = interpreters.discover_installed()

    assert [entry.version for entry in entries] == ['3.12.3']


def test_discover_installed_reports_pool_entries_as_available(fake_uv, pool):
    python_bin = make_entry(pool, '3.12.3')
    entries = interpreters.discover_installed()

    assert len(entries) == 1
    assert entries[0].version == '3.12.3'
    assert entries[0].available is True
    assert entries[0].path == str(python_bin)


def test_discover_installed_drops_corrupt_entry_without_raising(fake_uv, pool):
    """AC-14b：某解释器路径损坏 → 只从清单剔除该版本，其余照常上报。"""
    make_entry(pool, '3.12.3')
    make_entry(pool, '3.9.25')
    # 3.11 目录存在但可执行文件缺失（损坏条目）——必须被剔除而不是让探测整体失败
    (pool / f'cpython-3.11.9-{_PLATFORM}-none' / 'bin').mkdir(parents=True)

    entries = interpreters.discover_installed()

    assert sorted(entry.version for entry in entries) == ['3.12.3', '3.9.25']


def test_discover_installed_returns_empty_on_uv_failure(pool, monkeypatch):
    monkeypatch.setattr(
        interpreters, '_run_uv_sync', lambda args, timeout, env=None: (2, 'error: boom'),
    )
    assert interpreters.discover_installed() == []


def test_discover_installed_returns_empty_when_uv_missing(pool, monkeypatch):
    def _raise(*args, **kwargs):
        raise FileNotFoundError(2, 'No such file or directory', 'uv')

    monkeypatch.setattr(interpreters, '_run_uv_sync', _raise)
    assert interpreters.discover_installed() == []


def test_discover_installed_returns_empty_on_timeout(pool, monkeypatch):
    def _timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd='uv', timeout=5)

    monkeypatch.setattr(interpreters, '_run_uv_sync', _timeout)
    assert interpreters.discover_installed() == []


def test_discover_installed_ignores_unparseable_lines(pool, monkeypatch):
    """只有 `<key>  <绝对路径>` 两列的行才进清单；说明行/相对路径行被忽略。"""
    pool_entry = _fake_bin(pool / f'cpython-3.12.3-{_PLATFORM}-none')
    output = (
        'Resolved 2 interpreters\n'
        f'cpython-3.12.3-{_PLATFORM}-none  {pool_entry}\n'
        f'pypy-3.10.14-{_PLATFORM}-none    relative/pypy\n'
        'garbage-line-without-path\n'
        '\n'
    )
    monkeypatch.setattr(
        interpreters, '_run_uv_sync', lambda args, timeout, env=None: (0, output),
    )
    entries = interpreters.discover_installed()

    assert [entry.version for entry in entries] == ['3.12.3']
    assert entries[0].available is True


# ---------------------------------------------------------------------------
# 探测缓存（NFR-10）
# ---------------------------------------------------------------------------

def test_discovery_is_cached_within_ttl(fake_uv, pool):
    """心跳 30s 间隔内不得重复 spawn uv（NFR-10）。"""
    make_entry(pool, '3.12.3')

    first = interpreters.discover_installed()
    second = interpreters.discover_installed()
    third = interpreters.discover_installed()

    assert [e.version for e in first] == [e.version for e in second] == [e.version for e in third]
    assert len(fake_uv.calls) == 1, 'TTL 内的重复探测必须命中缓存'


def test_discovery_cache_expires_after_ttl(fake_uv, pool, monkeypatch):
    make_entry(pool, '3.12.3')
    clock = {'now': 1000.0}
    monkeypatch.setattr(interpreters.time, 'monotonic', lambda: clock['now'])

    interpreters.discover_installed()
    clock['now'] += interpreters.DISCOVERY_CACHE_TTL_SECONDS - 1
    interpreters.discover_installed()
    assert len(fake_uv.calls) == 1

    clock['now'] += 2
    interpreters.discover_installed()
    assert len(fake_uv.calls) == 2, 'TTL 过后必须重新探测'


def test_invalidate_cache_forces_rediscovery(fake_uv, pool):
    make_entry(pool, '3.12.3')
    interpreters.discover_installed()
    assert len(fake_uv.calls) == 1

    interpreters.invalidate_cache()
    make_entry(pool, '3.9.25')
    entries = interpreters.discover_installed()

    assert len(fake_uv.calls) == 2
    assert sorted(e.version for e in entries) == ['3.12.3', '3.9.25']


def test_discovery_default_timeout_is_within_startup_budget(fake_uv, pool):
    """NFR-10：首次探测必须能在 5s 预算内完成。"""
    make_entry(pool, '3.12.3')
    interpreters.discover_installed()
    assert fake_uv.timeouts[0] <= 5.0


# ---------------------------------------------------------------------------
# resolve_python_bin（D1 前缀匹配 + NFR-02 白名单）
# ---------------------------------------------------------------------------

def test_resolve_python_bin_prefix_match_37_hits_379(fake_uv, pool):
    python_bin = make_entry(pool, '3.7.9')
    assert interpreters.resolve_python_bin('3.7') == python_bin.resolve()


def test_resolve_python_bin_exact_version_match(fake_uv, pool):
    python_bin = make_entry(pool, '3.12.3')
    assert interpreters.resolve_python_bin('3.12') == python_bin.resolve()


def test_resolve_python_bin_returns_none_without_match(fake_uv, pool):
    make_entry(pool, '3.12.3')
    assert interpreters.resolve_python_bin('3.9') is None


def test_resolve_python_bin_dot_boundary_31_must_not_match_313(fake_uv, pool):
    """CONTRACT.md §1.2 强制边界：`"3.1"` 不得匹配 `"3.13.0"`。"""
    make_entry(pool, '3.13.0')
    assert interpreters.resolve_python_bin('3.1') is None
    assert interpreters.resolve_python_bin('3.13') is not None


def test_resolve_python_bin_never_returns_path_outside_pool(fake_uv, pool, tmp_path, monkeypatch):
    """NFR-02 安全用例：探测结果指向池外 → 拒绝返回（伪造/符号链接逃逸）。"""
    outside = tmp_path / 'outside'
    outside.mkdir()
    rogue = outside / 'python3'
    rogue.write_text('#!/bin/sh\necho "Python 3.9.9"\n')
    if os.name != 'nt':
        rogue.chmod(0o755)

    monkeypatch.setattr(
        interpreters, 'discover_installed',
        lambda **kwargs: [
            interpreters.InterpreterInfo(
                version='3.9.9', path=str(rogue), available=True, discovered_at='x',
            )
        ],
    )
    assert interpreters.resolve_python_bin('3.9') is None


def test_resolve_python_bin_rejects_symlink_escape(fake_uv, pool, tmp_path):
    """池内目录是指向池外的符号链接 → resolve 后越界，必须拒绝（NFR-02）。"""
    outside = tmp_path / 'outside'
    (outside / 'bin').mkdir(parents=True)
    rogue = outside / 'bin' / 'python3'
    rogue.write_text('#!/bin/sh\necho "Python 3.9.9"\n')
    if os.name != 'nt':
        rogue.chmod(0o755)
    link = pool / f'cpython-3.9.9-{_PLATFORM}-none'
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):  # pragma: no cover - Windows 无权限
        pytest.skip('symlink creation not permitted on this platform')

    assert interpreters.resolve_python_bin('3.9') is None


def test_resolve_python_bin_skips_unusable_entry(fake_uv, pool):
    """池内条目损坏（无 bin/python3）→ 前缀匹配不命中，返回 None（AC-14b）。"""
    (pool / f'cpython-3.9.25-{_PLATFORM}-none' / 'bin').mkdir(parents=True)
    assert interpreters.resolve_python_bin('3.9') is None


# ---------------------------------------------------------------------------
# is_online_downloadable（CONTRACT.md §0.1）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('version', ['3.8', '3.9', '3.12', '3.13', '3.14'])
def test_is_online_downloadable_for_supported_online_versions(version):
    assert interpreters.is_online_downloadable(version) is True


@pytest.mark.parametrize('version', ['3.6', '3.7'])
def test_is_online_downloadable_false_below_online_min(version):
    assert interpreters.is_online_downloadable(version) is False


def test_online_download_min_constant_matches_contract():
    assert ONLINE_DOWNLOAD_MIN == '3.8'


# ---------------------------------------------------------------------------
# is_supported_version（P2-1：激活 python_runtime_version_min/max 死配置，
# 与 node isSupportedVersion 对等）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('version', ['3.7', '3.8', '3.12', '3.14'])
def test_is_supported_version_inside_default_range(version):
    assert interpreters.is_supported_version(version) is True


@pytest.mark.parametrize('version', ['3.6', '3.15', '3.99'])
def test_is_supported_version_outside_default_range(version):
    assert interpreters.is_supported_version(version) is False


def test_is_supported_version_honours_configured_bounds(monkeypatch):
    """部署方可收紧区间（node 侧是常量；python 侧必须真正读 settings）。"""
    monkeypatch.setattr(settings, 'python_runtime_version_min', '3.10')
    monkeypatch.setattr(settings, 'python_runtime_version_max', '3.12')

    assert interpreters.is_supported_version('3.9') is False
    assert interpreters.is_supported_version('3.10') is True
    assert interpreters.is_supported_version('3.12') is True
    assert interpreters.is_supported_version('3.13') is False


@pytest.mark.parametrize('bad', ['3', '3.11.9', 'python3.11', 'garbage'])
def test_is_supported_version_rejects_bad_format(bad):
    with pytest.raises(ValueError):
        interpreters.is_supported_version(bad)


# ---------------------------------------------------------------------------
# ensure_version（FR-07/13/15、D11/D14）
# ---------------------------------------------------------------------------

def test_ensure_version_cache_hit_never_invokes_uv(fake_uv, pool):
    python_bin = make_entry(pool, '3.12.3')
    resolved = interpreters.ensure_version('3.12', timeout=30)

    assert resolved == python_bin.resolve()
    assert fake_uv.installs == [], '缓存命中必须短路，不得调用 uv python install'


def test_ensure_version_downloads_and_returns_pool_path(fake_uv, pool):
    resolved = interpreters.ensure_version('3.9', timeout=42)

    assert fake_uv.install_versions == ['3.9']
    assert resolved.is_relative_to(pool.resolve())
    assert resolved.is_file()
    # 调用方预算必须原样传给 `uv python install`（产物校验另用短预算）
    install_timeouts = [
        timeout for call, timeout in zip(fake_uv.calls, fake_uv.timeouts)
        if call[1:3] == ['python', 'install']
    ]
    assert install_timeouts == [42]


def test_ensure_version_nonzero_exit_raises_download_failed(fake_uv, pool):
    fake_uv.install_result = (2, 'error: No download found for request: cpython-3.9-<platform>')

    with pytest.raises(interpreters.InterpreterUnavailable) as exc:
        interpreters.ensure_version('3.9', timeout=30)

    assert exc.value.version == '3.9'
    assert exc.value.reason == 'download_failed'
    assert 'No download found' in exc.value.detail


def test_ensure_version_reports_mirror_unreachable_only_when_mirror_configured(
    fake_uv, pool, monkeypatch
):
    """配置了内网镜像且 uv 报连接类错误 → mirror_unreachable（D9/NFR-14）。"""
    fake_uv.install_result = (1, 'error: Failed to connect to mirror.internal: connection refused')
    monkeypatch.setattr(settings, 'uv_python_install_mirror', 'https://mirror.internal/python')

    with pytest.raises(interpreters.InterpreterUnavailable) as exc:
        interpreters.ensure_version('3.9', timeout=30)

    assert exc.value.reason == 'mirror_unreachable'
    assert 'mirror.internal' in exc.value.detail


def test_ensure_version_connection_error_without_mirror_stays_download_failed(fake_uv, pool):
    fake_uv.install_result = (1, 'error: Failed to connect: connection refused')

    with pytest.raises(interpreters.InterpreterUnavailable) as exc:
        interpreters.ensure_version('3.9', timeout=30)

    assert exc.value.reason == 'download_failed'


def test_ensure_version_timeout_raises_download_timeout(fake_uv, pool):
    def _hook(version, timeout):
        raise subprocess.TimeoutExpired(cmd='uv', timeout=timeout)

    fake_uv.install_hook = _hook

    with pytest.raises(interpreters.InterpreterUnavailable) as exc:
        interpreters.ensure_version('3.9', timeout=7)

    assert exc.value.reason == 'download_timeout'
    assert '7' in exc.value.detail


def test_ensure_version_uv_missing_raises_uv_missing(fake_uv, pool):
    def _hook(version, timeout):
        raise FileNotFoundError(2, 'No such file or directory', 'uv')

    fake_uv.install_hook = _hook

    with pytest.raises(interpreters.InterpreterUnavailable) as exc:
        interpreters.ensure_version('3.9', timeout=7)

    assert exc.value.reason == 'uv_missing'


def test_ensure_version_corrupt_product_is_removed_and_cache_invalidated(fake_uv, pool):
    """产物校验失败 → 删除损坏目录 + 失效缓存 + reason='corrupt'。"""
    def _hook(version, timeout):
        # 下载"成功"但产出的解释器不可执行（目录建了，可执行文件没建）
        (pool / f'cpython-{version}.20-{_PLATFORM}-none' / 'bin').mkdir(parents=True, exist_ok=True)
        return 0, 'installed'

    fake_uv.install_hook = _hook

    with pytest.raises(interpreters.InterpreterUnavailable) as exc:
        interpreters.ensure_version('3.9', timeout=30)

    assert exc.value.reason == 'corrupt'
    assert not (pool / f'cpython-3.9.20-{_PLATFORM}-none').exists(), '损坏目录必须被清除'
    # 缓存已失效：下一次探测会重新跑 uv
    before = len(fake_uv.calls)
    interpreters.discover_installed()
    assert len(fake_uv.calls) > before


def test_ensure_version_removes_pool_dir_when_version_output_mismatches(fake_uv, pool):
    """`--version` 输出与请求版本不符 → corrupt（并清掉错误产物）。"""
    def _hook(version, timeout):
        # uv "装好了 3.9"，但池内目录名/解释器实际是 3.10 —— 产物校验必须拦住
        make_entry(pool, '3.10.13')
        return 0, 'installed'

    fake_uv.install_hook = _hook
    original = fake_uv.list_output

    def _list():
        # 把 3.10 的条目伪装成 3.9（前缀匹配命中），但 `--version` 报 3.10
        return (
            f'cpython-3.9.13-{_PLATFORM}-none  '
            f'{pool / f"cpython-3.10.13-{_PLATFORM}-none" / "bin" / "python3"}\n'
        )

    fake_uv.list_output = _list
    try:
        with pytest.raises(interpreters.InterpreterUnavailable) as exc:
            interpreters.ensure_version('3.9', timeout=30)
    finally:
        fake_uv.list_output = original

    assert exc.value.reason == 'corrupt'
    assert not (pool / f'cpython-3.9.13-{_PLATFORM}-none').exists()


def test_ensure_version_37_with_empty_pool_is_not_downloadable(fake_uv, pool):
    """CONTRACT.md §0.1：3.7 在线不可下载，错误消息必须指引离线预填。"""
    with pytest.raises(interpreters.InterpreterUnavailable) as exc:
        interpreters.ensure_version('3.7', timeout=300)

    assert exc.value.version == '3.7'
    assert exc.value.reason == 'not_downloadable'
    assert '离线预填' in exc.value.detail
    assert 'cpython-3.7.' in exc.value.detail
    assert fake_uv.installs == [], '3.7 不得尝试在线下载'


def test_not_downloadable_detail_warns_against_pbs_platform_triples(pool):
    """回归（WS7 实测缺陷）：指引里的平台三元组必须是 **uv 词汇**。

    uv 对不匹配的目录名**静默忽略**——照 pbs 发布名建目录的运维会得到"文件都
    放对了但执行器始终探测不到"的无解症状。因此指引必须点名 uv 词汇、并显式
    警告不要用 pbs 的发布三元组。
    """
    detail = interpreters._not_downloadable_detail('3.7')

    # uv 词汇（逐字）
    assert 'linux-x86_64-gnu' in detail
    assert 'linux-x86_64-musl' in detail
    assert 'windows-x86_64-none' in detail
    assert 'macos-x86_64-none' in detail
    # 反面例子必须出现（否则运维无从判断自己抄的是哪一套）
    assert 'x86_64-unknown-linux-gnu' in detail
    assert 'x86_64-pc-windows-msvc' in detail
    # 自查手段
    assert 'uv python list --all-versions --all-platforms' in detail
    assert 'uv python list --only-installed' in detail


def test_not_downloadable_detail_does_not_hardcode_a_patch_version(pool):
    """3.6/3.5 也会走到这条分支：**目录名模板**不得写死 `.9` 这个补丁号。"""
    for version in ('3.7', '3.6', '3.5'):
        detail = interpreters._not_downloadable_detail(version)
        # 目录名模板是 `cpython-<ver>.x-<uv平台三元组>`——**三元组后没有 `-none`**
        # （Linux 的 libc 槽位是 gnu/musl；只有 windows/macos 的三元组自带 -none）。
        assert f'cpython-{version}.x-<uv平台三元组>' in detail
        assert f'cpython-{version}.9-' not in detail, f'{version} 的目录模板不得写死 .9'


def test_not_downloadable_detail_never_appends_a_spurious_none_suffix(pool):
    """回归闸：目录名模板不得出现 `-<uv平台三元组>-none`。

    实测（CONTRACT.md §0.2）：`cpython-3.11-linux-x86_64-gnu-none` 被 uv 判为
    `is not a valid Python download request`；手工放同名目录则被静默忽略。
    这条断言把"凭感觉补 -none"钉死，防止再次把运维引向必然失败的命名。
    """
    for version in ('3.7', '3.6'):
        detail = interpreters._not_downloadable_detail(version)
        assert '-<uv平台三元组>-none' not in detail, '三元组之后不得再补 -none'
        assert '不要再加' in detail, '提示里必须显式警告不要补 -none'


def test_ensure_version_37_uses_preprovisioned_pool_entry(fake_uv, pool):
    """离线预填的 3.7.9 必须被识别并直接复用（CONTRACT.md §0 实测结论）。"""
    python_bin = make_entry(pool, '3.7.9')
    resolved = interpreters.ensure_version('3.7', timeout=300)

    assert resolved == python_bin.resolve()
    assert fake_uv.installs == []


def test_ensure_version_36_is_rejected_without_uv(fake_uv, pool):
    with pytest.raises(interpreters.InterpreterUnavailable) as exc:
        interpreters.ensure_version('3.6', timeout=300)

    assert exc.value.reason == 'not_downloadable'
    assert fake_uv.installs == []


def test_ensure_version_above_supported_range_is_not_downloadable(fake_uv, pool):
    """P2-1 回归：3.99 越界必须在下载前归类 not_downloadable（与 node 对等）。

    改动前没有区间闸门，`uv python install 3.99` 真的被执行，再以含糊的
    download_failed 收场——同一个任务只看调度到哪个执行器就得到不同分因。
    """
    with pytest.raises(interpreters.InterpreterUnavailable) as exc:
        interpreters.ensure_version('3.99', timeout=300)

    assert exc.value.version == '3.99'
    assert exc.value.reason == 'not_downloadable'
    assert '3.7' in exc.value.detail and '3.14' in exc.value.detail
    assert fake_uv.installs == [], '越界版本不得尝试在线下载'


def test_ensure_version_async_above_supported_range_is_not_downloadable(fake_uv, pool):
    """async 入口（WS4 run_task 走这个）同样要在信号槽外明确失败。"""
    async def scenario():
        with pytest.raises(interpreters.InterpreterUnavailable) as exc:
            await interpreters.ensure_version_async('3.99', timeout=300)
        return exc.value

    exc = asyncio.run(scenario())
    assert exc.reason == 'not_downloadable'
    assert fake_uv.installs == []


def test_ensure_version_respects_tightened_max_bound(fake_uv, pool, monkeypatch):
    """部署方把上界收紧到 3.12 后，3.13 即便 uv 能下也必须明确拒绝。"""
    monkeypatch.setattr(settings, 'python_runtime_version_max', '3.12')

    with pytest.raises(interpreters.InterpreterUnavailable) as exc:
        interpreters.ensure_version('3.13', timeout=300)

    assert exc.value.reason == 'not_downloadable'
    assert '3.12' in exc.value.detail
    assert fake_uv.installs == []


# ---------------------------------------------------------------------------
# 并发互斥（NFR-16 / D13 / EG-06）
# ---------------------------------------------------------------------------

def test_concurrent_ensure_version_same_version_downloads_exactly_once(fake_uv, pool):
    """EG-06：N 个并发 `ensure_version("3.9")` → `uv python install` 恰好一次。"""
    callers = 8
    started = threading.Barrier(callers)
    results: list = []
    errors: list = []
    install_calls = {'n': 0}
    counter_guard = threading.Lock()

    def _hook(version, timeout):
        with counter_guard:
            install_calls['n'] += 1
        time.sleep(0.2)  # 让所有等待者都挤在锁上
        make_entry(pool, f'{version}.20')
        return 0, 'installed'

    fake_uv.install_hook = _hook

    def worker():
        try:
            started.wait(timeout=10)
            results.append(interpreters.ensure_version('3.9', timeout=30))
        except Exception as exc:  # noqa: BLE001 - 测试里如实收集
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(callers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert errors == []
    assert len(results) == callers
    assert install_calls['n'] == 1, 'per-version 锁必须让同版本只下载一次'
    assert len(set(results)) == 1, '所有等待者必须复用同一个路径'


def test_concurrent_ensure_version_different_versions_are_serialized_by_global_slot(fake_uv, pool, monkeypatch):
    """D13：全局下载队列——把并发显式钳到 1（旧版"全局单队列"语义），
    两个不同版本的在飞下载不得重叠。

    D13/NFR-16（config 默认 `interpreter_download_concurrency=2`）：本用例钉的
    是**最严档**（N=1）下的串行不变量；有界并发（N=2）的整体行为由
    test_concurrent_ensure_version_backlog_queues_globally_and_all_resolve 覆盖。
    """
    monkeypatch.setattr(settings, 'interpreter_download_concurrency', 1)

    def _hook(version, timeout):
        time.sleep(0.15)
        make_entry(pool, f'{version}.20')
        return 0, 'installed'

    fake_uv.install_hook = _hook

    async def scenario():
        return await asyncio.gather(
            interpreters.ensure_version_async('3.9', timeout=30),
            interpreters.ensure_version_async('3.12', timeout=30),
        )

    resolved = asyncio.run(scenario())

    assert len(resolved) == 2
    assert len(fake_uv.installs) == 2
    assert fake_uv.max_in_flight == 1, '同一时刻全局至多一个 in-flight 下载'


def test_concurrent_ensure_version_backlog_queues_globally_and_all_resolve(fake_uv, pool):
    """E-4（审计补漏）：全局下载队列的**积压**场景——N 个不同版本并发请求。

    既有用例只覆盖 2 个不同版本（test_concurrent_ensure_version_different_
    versions_are_serialized_by_global_slot）。积压（>2）下"排队逐次放行、
    等待者不饿死、每个都最终解析成功"无守卫：若队列实现退化成互斥死锁或
    前 N-1 个完成后最后一个永远等不到槽位，只有本场景能抓到。

    并发上限按 D13/NFR-16 的配置读取（默认 2）：断言**有界**（`max_in_flight
    <= 配置值`），而非旧版的 ==1——有界并发本身就是契约，全开才是 bug。
    """
    concurrency = interpreters._download_concurrency()
    assert concurrency >= 1

    def _hook(version, timeout):
        time.sleep(0.05)
        make_entry(pool, f'{version}.20')
        return 0, 'installed'

    fake_uv.install_hook = _hook
    versions = ['3.8', '3.9', '3.10', '3.11', '3.12']

    async def scenario():
        return await asyncio.gather(
            *[interpreters.ensure_version_async(v, timeout=30) for v in versions]
        )

    resolved = asyncio.run(scenario())

    assert len(fake_uv.installs) == len(versions), (
        f'每个积压版本都必须各下载一次，实际 {len(fake_uv.installs)}'
    )
    assert 1 <= fake_uv.max_in_flight <= concurrency, (
        f'全局下载并发必须有界（配置 {concurrency}），实际峰值 {fake_uv.max_in_flight}'
    )
    assert len(set(resolved)) == len(versions), '每个版本都必须解析到自己的池内路径'
    for path in resolved:
        assert Path(path).resolve().is_relative_to(pool.resolve())


def test_concurrent_async_ensure_version_same_version_downloads_exactly_once(fake_uv, pool):
    """async 入口的并发语义与同步入口一致（N 个协程 → 一次 uv install）。"""
    def _hook(version, timeout):
        time.sleep(0.1)
        make_entry(pool, f'{version}.20')
        return 0, 'installed'

    fake_uv.install_hook = _hook

    async def scenario():
        return await asyncio.gather(
            *[interpreters.ensure_version_async('3.9', timeout=30) for _ in range(6)]
        )

    resolved = asyncio.run(scenario())

    assert len(fake_uv.installs) == 1
    assert len(set(resolved)) == 1


def test_ensure_version_async_does_not_block_the_event_loop(fake_uv, pool):
    """NFR-10/心跳：下载期间的阻塞工作必须在工作线程，事件循环持续可调度。"""
    def _hook(version, timeout):
        time.sleep(0.25)
        make_entry(pool, f'{version}.20')
        return 0, 'installed'

    fake_uv.install_hook = _hook

    ticks = {'n': 0}
    main_thread = threading.current_thread()
    seen = {}

    async def scenario():
        async def ticker():
            while True:
                await asyncio.sleep(0.01)
                ticks['n'] += 1

        ticker_task = asyncio.create_task(ticker())
        try:
            await interpreters.ensure_version_async('3.9', timeout=30)
        finally:
            ticker_task.cancel()
        seen['thread'] = threading.current_thread()

    asyncio.run(scenario())

    assert seen['thread'] is main_thread
    assert ticks['n'] >= 5, '下载期间事件循环必须继续调度'


def test_ensure_version_async_cache_hit_skips_global_download_slot(fake_uv, pool):
    make_entry(pool, '3.12.3')

    async def scenario():
        return await interpreters.ensure_version_async('3.12', timeout=30)

    resolved = asyncio.run(scenario())
    assert resolved.is_file()
    assert fake_uv.installs == []


def test_ensure_version_async_propagates_unavailable(fake_uv, pool):
    fake_uv.install_result = (1, 'error: network unreachable')

    async def scenario():
        with pytest.raises(interpreters.InterpreterUnavailable) as exc:
            await interpreters.ensure_version_async('3.9', timeout=30)
        return exc.value

    exc = asyncio.run(scenario())
    assert exc.reason == 'download_failed'


# ---------------------------------------------------------------------------
# 环境白名单 + mirror（NFR-01/03、D9/NFR-14、D8 硬化）
# ---------------------------------------------------------------------------

def test_build_uv_env_drops_host_secrets_and_pins_pool(pool, monkeypatch):
    monkeypatch.setenv('EXECUTOR_SHARED_TOKEN', 'shared-sentinel')
    monkeypatch.setenv('EXECUTOR_SECRET', 'executor-sentinel')
    monkeypatch.setenv('PIP_INDEX_URL', 'https://evil.example/simple')
    monkeypatch.setenv('UV_INDEX', 'https://evil.example/simple')
    monkeypatch.setenv('UV_CONFIG_FILE', '/tmp/host-uv.toml')
    monkeypatch.setenv('PYPI_REGISTRY_URL', 'https://user:secret@evil.example/simple/')
    # 宿主环境里的同名 UV_* 也不得穿透（池路径只由 settings 决定，NFR-02）
    monkeypatch.setenv('UV_PYTHON_INSTALL_DIR', '/host/rogue-pool')
    monkeypatch.setenv('UV_PYTHON_INSTALL_MIRROR', 'https://host-rogue.example/')
    monkeypatch.setenv('UV_PYTHON_DOWNLOADS', 'automatic')
    monkeypatch.setenv('PATH', '/runtime/bin')

    env = interpreters.build_uv_env()

    for secret in (
        'EXECUTOR_SHARED_TOKEN', 'EXECUTOR_SECRET', 'PIP_INDEX_URL', 'UV_INDEX',
        'UV_CONFIG_FILE', 'PYPI_REGISTRY_URL',
    ):
        assert secret not in env
    assert env['PATH'] == '/runtime/bin'
    assert env['UV_PYTHON_INSTALL_DIR'] == str(pool)
    assert env['UV_NO_CONFIG'] == '1'
    assert env['UV_PYTHON_DOWNLOADS'] == 'manual'
    assert 'UV_PYTHON_INSTALL_MIRROR' not in env, '未配置镜像时不得注入该变量'


def test_build_uv_env_pins_manual_downloads_so_venv_never_downloads(fake_uv, pool):
    """D8 硬化：uv 子进程环境必须钉死 `UV_PYTHON_DOWNLOADS=manual`。

    该变量使 `uv venv --python <缺失版本>` 由 uv 自身拒绝（exit 2 + hint），
    下载因此只能走本模块的 `uv python install`（D13 互斥不被隐式下载绕过）。
    """
    interpreters.ensure_version('3.9', timeout=30)

    assert fake_uv.envs, 'uv 必须被调用'
    for env in fake_uv.envs:
        assert env.get('UV_PYTHON_DOWNLOADS') == 'manual'


def test_build_uv_env_injects_mirror_when_configured(pool, monkeypatch):
    monkeypatch.setattr(settings, 'uv_python_install_mirror', 'https://mirror.internal/python')
    env = interpreters.build_uv_env()
    assert env['UV_PYTHON_INSTALL_MIRROR'] == 'https://mirror.internal/python'


def test_ensure_version_passes_mirror_flag_to_uv(pool, monkeypatch):
    fake = FakeUV(pool)
    monkeypatch.setattr(interpreters, '_run_uv_sync', fake)
    monkeypatch.setattr(settings, 'uv_python_install_mirror', 'https://mirror.internal/python')

    interpreters.ensure_version('3.9', timeout=30)

    install = fake.installs[0]
    assert install[:4] == [interpreters.UV_BIN, 'python', 'install', '3.9']
    assert install[4:6] == ['--mirror', 'https://mirror.internal/python']
    assert fake.envs[0]['UV_PYTHON_INSTALL_MIRROR'] == 'https://mirror.internal/python'


def test_ensure_version_without_mirror_omits_mirror_flag(fake_uv, pool):
    interpreters.ensure_version('3.9', timeout=30)
    assert '--mirror' not in fake_uv.installs[0]


# ---------------------------------------------------------------------------
# pool_summary（FR-12 留痕）
# ---------------------------------------------------------------------------

def test_pool_summary_reports_install_dir_and_versions(pool):
    make_entry(pool, '3.7.9')
    make_entry(pool, '3.12.3')
    (pool / '.uv-cache').mkdir()  # 非版本目录必须被忽略

    summary = interpreters.pool_summary()

    assert summary['install_dir'] == str(pool)
    assert summary['versions'] == ['3.12.3', '3.7.9']


def test_pool_summary_empty_pool(pool):
    # F-2（SEC-NEW）：schema 确定性——integrity_unverified 键恒存在（空列表）。
    assert interpreters.pool_summary() == {
        'install_dir': str(pool),
        'versions': [],
        'integrity_unverified': [],
    }


def test_pool_summary_missing_dir_is_safe(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'uv_python_install_dir', str(tmp_path / 'nope'))
    assert interpreters.pool_summary()['versions'] == []


def test_pool_summary_does_not_spawn_uv(fake_uv, pool):
    interpreters.pool_summary()
    assert fake_uv.calls == []


# ---------------------------------------------------------------------------
# F-2（SEC-NEW）：SHA-256 pin 完整性校验
# ---------------------------------------------------------------------------

def _hash_of_fake_bin():
    """`_fake_bin` 写出的内容确定（'#!/bin/sh\\necho "Python 3"\\n'），直接算期望哈希。"""
    return hashlib.sha256(b'#!/bin/sh\necho "Python 3"\n').hexdigest()


def test_pin_mismatch_marks_corrupt_and_removes(fake_uv, pool, monkeypatch):
    """F-2：pin 与下载产物哈希不匹配 → corrupt，**绝不运行**，且损坏目录被清出池。"""
    monkeypatch.setattr(settings, 'uv_python_sha256_pins', {'3.12': 'f' * 64})
    with pytest.raises(interpreters.InterpreterUnavailable) as ei:
        interpreters.ensure_version('3.12', timeout=30)
    assert ei.value.reason == 'corrupt'
    assert 'does not match' in (ei.value.detail or '')
    assert not any(p.name.startswith('cpython-3.12') for p in pool.iterdir()), \
        'pin 不匹配的产物必须被清出池子，不能留待下一次 resolve 命中'


def _bin_write_hook(pool: Path):
    """安装钩子：以**二进制**写入确定性内容（避开 write_text 在 Windows 的
    \n→\r\n 翻译），使期望哈希跨平台恒定。"""

    def _hook(version: str, _timeout):
        entry = pool / f'cpython-{version}.20-linux-x86_64-gnu-none'
        python_bin = entry / 'bin' / 'python3'
        python_bin.parent.mkdir(parents=True, exist_ok=True)
        python_bin.write_bytes(b'#!/bin/sh\necho "Python 3"\n')
        python_bin.chmod(0o755)  # POSIX 可执行位：CI(Linux) 校验 os.access(X_OK)
        return 0, 'installed'

    return _hook


def test_pin_match_passes(fake_uv, pool, monkeypatch):
    """F-2：pin 匹配 → 正常安装并解析。"""
    expected = hashlib.sha256(b'#!/bin/sh\necho "Python 3"\n').hexdigest()
    monkeypatch.setattr(settings, 'uv_python_sha256_pins', {'3.12': expected})
    fake_uv.install_hook = _bin_write_hook(pool)
    resolved = interpreters.ensure_version('3.12', timeout=30)
    assert resolved.exists()


def test_pin_match_verifies_actual_binary_not_just_report(fake_uv, pool, monkeypatch):
    """F-2：校验对象是**池内二进制文件**本身（对已装条目做哈希比对）。"""
    make_entry(pool, '3.12.20')
    resolved = interpreters._resolve_python_bin_uncached('3.12')
    expected = interpreters._sha256_of(resolved)
    monkeypatch.setattr(settings, 'uv_python_sha256_pins', {'3.12': expected})
    # 直接走 _verify_installed：pin 匹配则返回路径
    assert interpreters._verify_installed('3.12') == resolved


def test_unpinned_install_recorded_as_unverified(fake_uv, pool, monkeypatch):
    """F-2：无 pin 在线下载 → pool_summary.integrity_unverified 留痕（每个版本一次）。"""
    interpreters._reset_integrity_tracking()
    interpreters.ensure_version('3.12', timeout=30)
    assert '3.12' in interpreters.pool_summary()['integrity_unverified']
    # 幂等：重复调用不重复 warn（集合去重）
    assert interpreters.integrity_unverified_versions() == ['3.12']


# ---------------------------------------------------------------------------
# uv 定位
# ---------------------------------------------------------------------------

def test_uv_bin_prefers_env_override(monkeypatch):
    """UV_BIN 环境变量是桌面端"随包内置 uv"的接线点（CONTRACT.md §3.3）。"""
    import importlib

    monkeypatch.setenv('UV_BIN', '/bundled/uv')
    module = importlib.reload(interpreters)
    try:
        assert module.UV_BIN == '/bundled/uv'
    finally:
        monkeypatch.delenv('UV_BIN', raising=False)
        importlib.reload(interpreters)


def test_module_never_imports_routers_execute():
    """架构约束：本模块不得反向 import routers.execute（会成循环导入）。"""
    source = Path(interpreters.__file__).read_text(encoding='utf-8')
    assert 'import routers' not in source
    assert 'from routers' not in source
