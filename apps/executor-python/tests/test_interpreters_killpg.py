"""``interpreters.py`` 的 POSIX 进程组杀回归（EXEC-02 安全底线）。

``_run_uv_sync`` 超时时 uv 派生的孙进程继承 stdout 写端会吊住
``communicate()``；``_kill_process_tree`` 必须与 ``routers/execute.py`` 同款
整组杀，且绝不 killpg 打到执行器自己的进程组。
"""
from types import SimpleNamespace

import pytest

import interpreters


class _FakeProc:
    """``_kill_process_tree`` 只用到 pid 与 kill() 两处契约。"""

    def __init__(self, pid):
        self.pid = pid
        self.kills = 0

    def kill(self):
        self.kills += 1


@pytest.fixture
def posix(monkeypatch):
    """隔离地强制 POSIX 分支（只换模块内的 sys 引用，不动全局 sys.platform）。"""
    monkeypatch.setattr(interpreters, 'sys', SimpleNamespace(platform='linux'))


def test_kill_process_tree_posix_uses_killpg_for_child_group(monkeypatch, posix):
    """独立 pgid：killpg(child_pgid, SIGKILL) 打整棵树（孙进程一并带走）。"""
    child_pgid, executor_pgid, child_pid = 4242, 1000, 1234
    calls = []
    sig = object()

    monkeypatch.setattr(
        interpreters.os, 'getpgid',
        lambda pid: child_pgid if pid == child_pid else executor_pgid,
        raising=False,
    )
    monkeypatch.setattr(
        interpreters.os, 'killpg',
        lambda pgid, _sig: calls.append((pgid, _sig)),
        raising=False,
    )
    monkeypatch.setattr(interpreters.signal, 'SIGKILL', sig, raising=False)

    proc = _FakeProc(child_pid)
    interpreters._kill_process_tree(proc)

    assert calls == [(child_pgid, sig)]
    assert proc.kills == 0


def test_kill_process_tree_posix_never_kills_own_group(monkeypatch, posix):
    """EXEC-02：子进程与执行器同 pgid 时只 proc.kill()，killpg 绝不被调用。"""
    own_pgid, child_pid = 1000, 1234
    calls = []

    monkeypatch.setattr(
        interpreters.os, 'getpgid', lambda pid: own_pgid, raising=False
    )
    monkeypatch.setattr(
        interpreters.os, 'killpg',
        lambda pgid, _sig: calls.append((pgid, _sig)),
        raising=False,
    )
    monkeypatch.setattr(interpreters.signal, 'SIGKILL', object(), raising=False)

    proc = _FakeProc(child_pid)
    interpreters._kill_process_tree(proc)

    assert calls == []
    assert proc.kills == 1
