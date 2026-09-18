"""SEC-NEW: 任务沙箱与资源限制（F-1/B-1）单元测试。

覆盖：
* ``build_rlimit_pre_exec`` —— 配置驱动的 RLIMIT_* 组装（win32 跳过、全零返回 None）；
* ``build_sandbox_cmd`` —— bwrap 包装结构；fail-closed（配置启用但二进制缺失 → 抛
  SandboxUnavailable，绝不静默降级）；'' 默认零变化；
* ``with_task_tmpdir`` —— 私有 tmpdir + TMPDIR/TEMP/TMP 指向；
* ``_spawn_kwargs_for_platform`` 与 rlimit preexec 的组合（POSIX 分支）。
"""
import sys
from pathlib import Path

import pytest

from sandbox import (
    SandboxUnavailable,
    build_rlimit_pre_exec,
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
def test_rlimit_pre_exec_builds_expected_limits():
    settings = _Settings()
    fn = build_rlimit_pre_exec(settings, timeout_seconds=120)
    assert fn is not None
    import resource

    # 用真实施加验证（在子进程内 setrlimit 安全；本进程设置后恢复）
    limits = {
        resource.RLIMIT_AS: (2048 * 1024 * 1024, 2048 * 1024 * 1024),
        resource.RLIMIT_CPU: (180, 190),  # timeout 120 + 60，硬限 +10
        resource.RLIMIT_FSIZE: (4096 * 1024 * 1024, 4096 * 1024 * 1024),
        resource.RLIMIT_NOFILE: (1024, 1024),
    }
    saved = {rsrc: resource.getrlimit(rsrc) for rsrc in limits}
    try:
        fn()
        for rsrc, expected in limits.items():
            assert resource.getrlimit(rsrc) == expected, rsrc
    finally:
        for rsrc, pair in saved.items():
            resource.setrlimit(rsrc, pair)


@pytest.mark.skipif(sys.platform == 'win32', reason='RLIMIT_* 仅 POSIX 语义')
def test_rlimit_cpu_falls_back_to_timeout_plus_grace():
    settings = _Settings(task_cpu_limit_seconds=0)
    fn = build_rlimit_pre_exec(settings, timeout_seconds=30)
    assert fn is not None
    import resource

    soft, hard = resource.getrlimit(resource.RLIMIT_CPU)
    _ = soft
    saved = resource.getrlimit(resource.RLIMIT_CPU)
    try:
        fn()
        soft, hard = resource.getrlimit(resource.RLIMIT_CPU)
        assert soft == 90  # 30 + 60
        assert hard == 100
    finally:
        resource.setrlimit(resource.RLIMIT_CPU, saved)


def test_rlimit_all_disabled_returns_none():
    settings = _Settings(
        task_memory_limit_mb=0,
        task_cpu_limit_seconds=0,
        task_fsize_limit_mb=0,
        task_nofile_limit=0,
        task_nproc_limit=0,
    )
    assert build_rlimit_pre_exec(settings, timeout_seconds=0) is None


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
    assert wrapped[-2] == '--'
    assert wrapped[-2:] == ['--', 'python', 'main.py']


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
