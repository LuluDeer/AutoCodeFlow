"""SEC-NEW: 任务沙箱与资源限制（F-1/B-1）单元测试。

覆盖：
* ``build_rlimit_limits`` —— 配置驱动的 RLIMIT_* 规格组装（win32 跳过、全零返回
  None、prepare 路径可排除 NPROC）。**EXEC-02 起不再返回 preexec_fn**：规格是
  ``{名: (soft, hard)}``，由 ``task_launcher.py`` 在新 exec 的单线程解释器里施加
  （真跑行为见 tests/test_task_launcher.py，spawn 侧见
  tests/test_exec_02_launcher.py）；
* ``build_launcher_cmd`` —— launcher 包装形状（argv 直传、无 shell 拼接）与
  limits 严格校验（畸形 → SandboxUnavailable，fail-closed）；
* ``build_sandbox_cmd`` —— bwrap 包装结构；fail-closed（配置启用但二进制缺失 → 抛
  SandboxUnavailable，绝不静默降级）；'' 默认零变化；
* ``with_task_tmpdir`` —— 私有 tmpdir + TMPDIR/TEMP/TMP 指向。
"""
import json
import sys
from pathlib import Path

import pytest

import sandbox
from sandbox import (
    RLIMIT_NAMES,
    SandboxUnavailable,
    build_launcher_cmd,
    build_rlimit_limits,
    build_sandbox_cmd,
    with_task_tmpdir,
)


class _Settings:
    """最小 settings 替身：只承载 sandbox 模块读取的字段。"""

    def __init__(self, **kw):
        defaults = dict(
            task_sandbox='',
            task_memory_limit_mb=2048,
            task_cpu_limit_seconds=0,
            task_fsize_limit_mb=4096,
            task_nofile_limit=1024,
            task_nproc_limit=0,
        )
        defaults.update(kw)
        for name, value in defaults.items():
            setattr(self, name, value)


@pytest.mark.skipif(sys.platform == 'win32', reason='RLIMIT_* 仅 POSIX 语义')
def test_build_rlimit_limits_builds_expected_spec():
    settings = _Settings()
    limits = build_rlimit_limits(settings, timeout_seconds=120)
    assert limits == {
        'RLIMIT_AS': (2048 * 1024 * 1024, 2048 * 1024 * 1024),
        'RLIMIT_CPU': (180, 190),  # timeout 120 + 60，硬限 +10
        'RLIMIT_FSIZE': (4096 * 1024 * 1024, 4096 * 1024 * 1024),
        'RLIMIT_NOFILE': (1024, 1024),
    }
    # 默认 NPROC=0 不设
    assert 'RLIMIT_NPROC' not in limits


@pytest.mark.skipif(sys.platform == 'win32', reason='RLIMIT_* 仅 POSIX 语义')
def test_build_rlimit_limits_cpu_falls_back_to_timeout_plus_grace():
    settings = _Settings(task_cpu_limit_seconds=0)
    limits = build_rlimit_limits(settings, timeout_seconds=30)
    assert limits is not None
    assert limits['RLIMIT_CPU'] == (90, 100)  # 30 + 60，硬限 +10


@pytest.mark.skipif(sys.platform == 'win32', reason='RLIMIT_* 仅 POSIX 语义')
def test_build_rlimit_limits_includes_nproc_when_configured():
    settings = _Settings(task_nproc_limit=64)
    limits = build_rlimit_limits(settings, timeout_seconds=30)
    assert limits is not None
    assert limits['RLIMIT_NPROC'] == (64, 64)


@pytest.mark.skipif(sys.platform == 'win32', reason='RLIMIT_* 仅 POSIX 语义')
def test_build_rlimit_limits_prepare_excludes_nproc():
    """prepare（git/uv）刻意不套 NPROC——uv 自己会 spawn 辅助进程（沿用旧形状）。"""
    settings = _Settings(task_nproc_limit=64)
    limits = build_rlimit_limits(settings, timeout_seconds=30, include_nproc=False)
    assert limits is not None
    assert 'RLIMIT_NPROC' not in limits
    # 其余限制照旧
    assert limits['RLIMIT_NOFILE'] == (1024, 1024)


def test_rlimit_all_disabled_returns_none():
    settings = _Settings(
        task_memory_limit_mb=0,
        task_cpu_limit_seconds=0,
        task_fsize_limit_mb=0,
        task_nofile_limit=0,
        task_nproc_limit=0,
    )
    assert build_rlimit_limits(settings, timeout_seconds=0) is None


def test_rlimit_limits_none_on_win32(monkeypatch):
    """win32 无 RLIMIT_* 原语：返回 None（调用方据此跳过 launcher 包装）。"""
    monkeypatch.setattr(sandbox, 'sys', type('_Sys', (), {'platform': 'win32'})())
    assert build_rlimit_limits(_Settings(), timeout_seconds=60) is None
    # 一次性 info 日志（每个进程只记一行，避免刷屏）也是这条路径的一部分
    assert sandbox._win32_rlimit_noted is True


# ---------------------------------------------------------------------------
# EXEC-02：launcher 包装（child 内零 Python 代码 + limits 严格校验）
# ---------------------------------------------------------------------------

def test_build_launcher_cmd_wraps_in_single_threaded_launcher():
    cmd = ['git', 'clone', '--bare', 'url', '/tmp/cache']
    limits = {'RLIMIT_AS': (1024, 1024)}
    wrapped = build_launcher_cmd(cmd, limits)

    # 新解释器 + launcher 脚本 + JSON 规格 + `--` + 真实命令（逐项 argv，无 shell）
    assert wrapped[0] == sys.executable
    assert wrapped[1] == '-I'                      # 隔离模式：不读 PYTHON* / cwd
    assert wrapped[2] == str(sandbox.LAUNCHER_SCRIPT)
    assert Path(wrapped[2]).is_file()
    assert json.loads(wrapped[3]) == {'RLIMIT_AS': [1024, 1024]}
    assert wrapped[4] == '--'
    assert wrapped[5:] == cmd


def test_launcher_wraps_the_sandbox_wrapper(monkeypatch):
    """bwrap 与 rlimit 的组合顺序：launcher 最外层，bwrap 在 `--` 之后。

    run_task 先 ``build_sandbox_cmd`` 再 ``build_launcher_cmd`` —— 限制施加在
    bwrap 进程上，由它连同任务进程一起继承进用户命名空间（与改前 preexec 施加
    在 bwrap 上逐字同义）；bwrap 自己的 `--` 仍是末尾，任务命令不被 launcher
    的 `--` 抢走。
    """
    monkeypatch.setattr(sandbox, '_get_settings', lambda: _Settings(task_sandbox='bwrap'))
    monkeypatch.setattr(sandbox.shutil, 'which', lambda _name: '/usr/bin/bwrap')

    inner = build_sandbox_cmd(['python', 'main.py'], Path('/tmp/work'))
    outer = build_launcher_cmd(inner, {'RLIMIT_AS': (1024, 1024)})

    assert outer[0] == sys.executable and outer[1] == '-I'
    assert outer[4] == '--'                    # launcher 自己的分隔符
    assert outer[5] == '/usr/bin/bwrap'        # bwrap 是被 launcher exec 的命令
    assert '--unshare-all' in outer
    assert outer[-3:] == ['--', 'python', 'main.py']   # bwrap 的 `--` 仍是末尾


def test_build_launcher_cmd_is_noop_without_limits():
    cmd = ['python3', 'main.py']
    assert build_launcher_cmd(cmd, None) is cmd
    assert build_launcher_cmd(cmd, {}) is cmd


def test_rlimit_names_match_launcher_allowlist():
    """父进程产出的名字必须与 launcher 的白名单逐项一致（跨进程契约）。"""
    import task_launcher

    assert set(RLIMIT_NAMES) == set(task_launcher.ALLOWED_LIMITS)


@pytest.mark.parametrize(
    'limits',
    [
        ['RLIMIT_AS'],                                   # 不是映射
        {'RLIMIT_BOGUS': (1, 1)},                        # 未知资源
        {'RLIMIT_AS': (1024,)},                          # 不是二元组
        {'RLIMIT_AS': (1024, 1024, 1024)},               # 三元组
        {'RLIMIT_AS': ('1024', '1024')},                 # 非整数
        {'RLIMIT_AS': (True, True)},                     # bool 不是整数语义
        {'RLIMIT_AS': (0, 0)},                           # 0 等于"禁止"该资源
        {'RLIMIT_AS': (2048, 1024)},                     # soft > hard
    ],
)
def test_build_launcher_cmd_rejects_malformed_limits(limits):
    """畸形 limits 必须在 spawn 之前失败，绝不让 launcher 在 exec 前才崩。"""
    with pytest.raises(SandboxUnavailable, match='fail-closed'):
        build_launcher_cmd(['true'], limits)


def test_build_launcher_cmd_requires_sys_executable(monkeypatch):
    """嵌入式解释器没有 sys.executable：宁可失败，不静默丢限制。"""
    monkeypatch.setattr(sandbox.sys, 'executable', '')
    with pytest.raises(SandboxUnavailable, match='fail-closed'):
        build_launcher_cmd(['true'], {'RLIMIT_AS': (1024, 1024)})


def test_build_launcher_cmd_rejects_limits_on_win32(monkeypatch):
    monkeypatch.setattr(sandbox, 'sys', type('_Sys', (), {'platform': 'win32'})())
    with pytest.raises(SandboxUnavailable, match='POSIX'):
        build_launcher_cmd(['true'], {'RLIMIT_AS': (1024, 1024)})


def test_sandbox_none_returns_cmd_unchanged():
    settings = _Settings(task_sandbox='')
    cmd = ['python', 'main.py']
    assert build_sandbox_cmd(cmd, Path('/tmp/work')) is cmd


def test_sandbox_bwrap_missing_is_fail_closed(monkeypatch):
    settings = _Settings(task_sandbox='bwrap')
    monkeypatch.setattr('sandbox._get_settings', lambda: settings)
    monkeypatch.setattr('sandbox.shutil.which', lambda _name: None)
    with pytest.raises(SandboxUnavailable, match='bwrap'):
        build_sandbox_cmd(['python', 'main.py'], Path('/tmp/work'))


@pytest.mark.skipif(sys.platform == 'win32', reason='bwrap 仅 Linux')
def test_sandbox_bwrap_wraps_command(monkeypatch):
    settings = _Settings(task_sandbox='bwrap')
    monkeypatch.setattr('sandbox._get_settings', lambda: settings)
    monkeypatch.setattr('sandbox.shutil.which', lambda _name: '/usr/bin/bwrap')
    wrapped = build_sandbox_cmd(['python', 'main.py'], Path('/tmp/work'))
    assert wrapped[0] == '/usr/bin/bwrap'
    assert '--die-with-parent' in wrapped
    assert '--unshare-all' in wrapped
    assert '--share-net' in wrapped
    assert '--ro-bind' in wrapped and '/' in wrapped
    assert '--tmpfs' in wrapped and '/tmp' in wrapped
    assert wrapped[-3] == '--'
    assert wrapped[-3:] == ['--', 'python', 'main.py']


def test_with_task_tmpdir_sets_env_and_creates_dir(tmp_path):
    env = {'PATH': '/usr/bin'}
    work_dir = tmp_path / 'work'
    work_dir.mkdir()
    with_task_tmpdir(env, work_dir)
    tmpdir = work_dir / '.tmp'
    assert tmpdir.is_dir()
    assert env['TMPDIR'] == str(tmpdir)
    assert env['TEMP'] == str(tmpdir)
    assert env['TMP'] == str(tmpdir)


def test_with_task_tmpdir_does_not_clobber_other_env(tmp_path):
    env = {'PATH': '/usr/bin', 'TMPDIR': '/shared/tmp'}
    work_dir = tmp_path / 'work'
    work_dir.mkdir()
    with_task_tmpdir(env, work_dir)
    assert env['PATH'] == '/usr/bin'
    assert env['TMPDIR'] == str(work_dir / '.tmp')
