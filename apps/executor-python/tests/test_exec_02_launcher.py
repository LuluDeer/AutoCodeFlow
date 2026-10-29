"""EXEC-02（审计 P2）：POSIX 上「fork 后 exec 前跑 Python」死锁面的消除。

本文件守的是**执行器侧**的三条不变量（launcher 自身的单测在
tests/test_task_launcher.py）：

1. ``_spawn_kwargs_for_platform`` 在 POSIX 不再返回 ``preexec_fn``（child 里零
   Python 代码），Windows 分支逐字节不变；
2. **真跑**：任务子进程确实拿到 rlimit，且坐在自己的会话/进程组里（超时按 pgid
   杀树依赖它）；
3. **失败路径**：launcher 拒绝启动（参数畸形 / exec 失败）→ 任务失败 + 可读
   errorMessage，绝不静默变成「无 rlimit 执行」。

外加：prepare（git/uv）路径同样改走 launcher、树杀不会误伤执行器自己的进程组。
"""
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import sandbox
from routers import execute as execute_module
from routers.execute import ExecuteRequest, run_task

# POSIX-only 用例（真跑 rlimit/setsid、launcher 包装）：win32 无 RLIMIT 原语，
# 也不包 launcher。win32 的 spawn kwargs 由 test_win32_spawn_kwargs_unchanged
# 在本类宿主上直接断言（不依赖平台跳过）。
posix_only = pytest.mark.skipif(
    sys.platform == 'win32',
    reason='POSIX spawn（start_new_session / RLIMIT / task_launcher）语义',
)

_PROBE_SCRIPT = '''
import json, os, resource
print("@PROBE@" + json.dumps({
    "pid": os.getpid(),
    "pgrp": os.getpgrp(),
    "sid": os.getsid(0),
    "nofile": list(resource.getrlimit(resource.RLIMIT_NOFILE)),
    "as": list(resource.getrlimit(resource.RLIMIT_AS)),
    "fsize": list(resource.getrlimit(resource.RLIMIT_FSIZE)),
}))
'''


def _workdir(tmp_path: Path, execution_id: str, name: str, content: str) -> Path:
    workdir = tmp_path / execution_id
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / name).write_text(content)
    return workdir


# ---------------------------------------------------------------------------
# 1) spawn kwargs：POSIX 无 preexec_fn；win32 不变
# ---------------------------------------------------------------------------

@posix_only
def test_posix_spawn_kwargs_have_no_preexec_fn():
    """EXEC-02 核心断言：POSIX 分支不得再让 CPython 在 fork 与 exec 之间跑代码。"""
    kwargs = execute_module._spawn_kwargs_for_platform()
    assert 'preexec_fn' not in kwargs
    # 独立会话由内核/posix_spawn 建立（同样在 child 里零 Python 代码）
    assert kwargs == {'start_new_session': True}


def test_win32_spawn_kwargs_unchanged(monkeypatch):
    """Windows 分支逐字节不变：CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS。

    Linux 上 subprocess 没有这两个常量，故连 subprocess 一起替换（win32 上它们
    本来就存在，替换只是让断言可在 POSIX CI 上跑）。
    """
    fake_subprocess = SimpleNamespace(
        CREATE_NEW_PROCESS_GROUP=0x00000200, DETACHED_PROCESS=0x00000008,
    )
    monkeypatch.setattr(execute_module, 'subprocess', fake_subprocess)
    monkeypatch.setattr(execute_module, 'sys', SimpleNamespace(platform='win32'))
    assert execute_module._spawn_kwargs_for_platform() == {
        'creationflags': 0x00000200 | 0x00000008,
    }


# ---------------------------------------------------------------------------
# 2) 真跑：任务子进程的 rlimit + 独立会话
# ---------------------------------------------------------------------------

@posix_only
def test_task_child_gets_rlimits_and_own_session(tmp_path, monkeypatch):
    """端到端：真实任务进程里 ``getrlimit``/``getpgrp``/``getsid`` 都必须对。

    这是「限制在任务第一条指令前生效」的**唯一**可信证据——单测只能证明我们
    传了 argv，证明不了内核里的状态。
    """
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(execute_module.settings, 'task_memory_limit_mb', 512)
    monkeypatch.setattr(execute_module.settings, 'task_fsize_limit_mb', 64)
    monkeypatch.setattr(execute_module.settings, 'task_nofile_limit', 256)
    monkeypatch.setattr(execute_module.settings, 'task_cpu_limit_seconds', 0)
    monkeypatch.setattr(execute_module.settings, 'task_nproc_limit', 0)

    # spawn 参数探针：真实 spawn 的同时记录 kwargs（断言 child 里零 Python 代码）
    real_spawn = asyncio.create_subprocess_exec
    seen = []

    def spawn_spy(*args, **kwargs):
        seen.append((args, kwargs))
        return real_spawn(*args, **kwargs)

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn_spy)

    _workdir(tmp_path, 'exec-rlimit', 'probe.py', _PROBE_SCRIPT)
    req = ExecuteRequest(
        executionId='exec-rlimit',
        task={'name': 'probe', 'runtime': 'python', 'entrypoint': 'probe.py',
              'timeoutSeconds': 30},
    )
    result = asyncio.run(run_task(req))

    assert result['success'] is True, result
    probe_lines = [line for line in result['logs'].splitlines() if line.startswith('@PROBE@')]
    assert len(probe_lines) == 1, result['logs']
    probe = json.loads(probe_lines[0][len('@PROBE@'):])

    assert probe['nofile'] == [256, 256]
    assert probe['as'] == [512 * 1024 * 1024, 512 * 1024 * 1024]
    assert probe['fsize'] == [64 * 1024 * 1024, 64 * 1024 * 1024]
    # 独立会话/进程组：pgid == sid == 自己的 pid（与执行器进程组不同）
    assert probe['pgrp'] == probe['pid']
    assert probe['sid'] == probe['pid']

    # spawn 时：launcher 在最外层，且没有任何 preexec_fn
    assert len(seen) == 1
    args, kwargs = seen[0]
    assert args[0] == sys.executable
    assert args[1] == '-I'
    assert args[2] == str(sandbox.LAUNCHER_SCRIPT)
    spec = json.loads(args[3])
    assert spec['RLIMIT_NOFILE'] == [256, 256]
    assert args[4] == '--'
    assert 'preexec_fn' not in kwargs
    assert kwargs['start_new_session'] is True


def test_task_without_limits_spawns_without_launcher(tmp_path, monkeypatch):
    """全部限制关闭（含 timeout=0，即 CPU 兜底也不生效）时保持零变化：
    不包 launcher（少一个进程、少一个失败面）。

    反例正是 RFC 里的 RLIMIT_CPU 兜底：只要 timeout > 0，`build_rlimit_limits`
    就会产出 CPU 上限，届时 launcher 必须出现——见上一个用例。
    """
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    for name in ('task_memory_limit_mb', 'task_cpu_limit_seconds',
                 'task_fsize_limit_mb', 'task_nofile_limit', 'task_nproc_limit'):
        monkeypatch.setattr(execute_module.settings, name, 0)

    spawned = []
    real_spawn = asyncio.create_subprocess_exec

    def spawn_spy(*args, **kwargs):
        spawned.append(args)
        return real_spawn(*args, **kwargs)

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn_spy)
    _workdir(tmp_path, 'exec-nolimit', 'main.py', 'print("ran")\n')
    req = ExecuteRequest(
        executionId='exec-nolimit',
        task={'runtime': 'python', 'entrypoint': 'main.py', 'timeoutSeconds': 0},
    )
    result = asyncio.run(run_task(req))

    assert result['success'] is True, result
    assert len(spawned) == 1
    assert str(sandbox.LAUNCHER_SCRIPT) not in spawned[0]
    assert '-I' not in spawned[0]


# ---------------------------------------------------------------------------
# 3) 失败路径：launcher 启动失败 → 任务失败且错误可读，绝不静默无限制执行
# ---------------------------------------------------------------------------

_FAKE_BAD_LAUNCHER = (
    'import sys\n'
    'print("AUTOCF_LAUNCHER_ERROR: 未知或不支持的资源上限 \'RLIMIT_BOGUS\'", file=sys.stderr)\n'
    'sys.exit(127)\n'
)


@posix_only
def test_task_fails_readably_when_launcher_rejects_spec(tmp_path, monkeypatch):
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    fake_launcher = tmp_path / 'fake_launcher.py'
    fake_launcher.write_text(_FAKE_BAD_LAUNCHER)
    monkeypatch.setattr('sandbox.LAUNCHER_SCRIPT', fake_launcher)

    _workdir(tmp_path, 'exec-launcher-fail', 'main.py', 'print("TASK-MUST-NOT-RUN")\n')
    req = ExecuteRequest(
        executionId='exec-launcher-fail',
        task={'runtime': 'python', 'entrypoint': 'main.py', 'timeoutSeconds': 30},
    )
    result = asyncio.run(run_task(req))

    assert result['success'] is False
    assert result['exitCode'] == 127
    # 可读：指出是资源限制启动器，且明确没有降级
    assert '资源限制启动器' in result['errorMessage']
    assert 'RLIMIT_BOGUS' in result['errorMessage']
    assert '未降级为无资源限制运行' in result['errorMessage']
    # 反证：任务一行都没跑（不是「跑了但没限制」）
    assert 'TASK-MUST-NOT-RUN' not in result['logs']
    # 分类：执行器环境问题（复用 sandbox_unavailable），而不是 script_error
    assert execute_module._refine_failure_reason(result['errorMessage']) == 'sandbox_unavailable'


def test_launcher_failure_reason_parses_marker():
    logs = (
        'some preamble\n'
        'AUTOCF_LAUNCHER_ERROR: 无法执行任务命令 \'nope\': [Errno 2] No such file\n'
        'tail\n'
    )
    message = execute_module._launcher_startup_failure_reason(logs)
    assert message is not None
    assert '无法执行任务命令' in message
    assert '未降级为无资源限制运行' in message


def test_launcher_failure_reason_absent_without_marker():
    assert execute_module._launcher_startup_failure_reason('division by zero\n') is None
    assert execute_module._launcher_startup_failure_reason('') is None


def test_launcher_failure_reason_truncates_long_detail():
    message = execute_module._launcher_startup_failure_reason(
        'AUTOCF_LAUNCHER_ERROR: ' + 'x' * 1000
    )
    assert message is not None
    assert len(message) < 500
    assert message.endswith('未降级为无资源限制运行。')


# ---------------------------------------------------------------------------
# 4) prepare（git/uv）同款：launcher + start_new_session，无 NPROC
# ---------------------------------------------------------------------------

@posix_only
def test_prepare_limits_exclude_nproc_and_fall_back_to_stage_timeout(monkeypatch):
    monkeypatch.setattr(execute_module.settings, 'task_nproc_limit', 64)
    monkeypatch.setattr(execute_module.settings, 'task_cpu_limit_seconds', 0)
    limits = execute_module._prepare_rlimit_limits(30)
    assert limits is not None
    assert 'RLIMIT_NPROC' not in limits
    assert limits['RLIMIT_CPU'] == (90, 100)

    # 全部关闭 + 无阶段超时 → None（不包 launcher，spawn 参数零变化）
    for name in ('task_memory_limit_mb', 'task_fsize_limit_mb', 'task_nofile_limit'):
        monkeypatch.setattr(execute_module.settings, name, 0)
    assert execute_module._prepare_rlimit_limits(0) is None


@posix_only
def test_run_uv_spawns_through_launcher(monkeypatch):
    captured = {}

    class _Proc:
        returncode = 0
        stdout = None

        async def communicate(self):
            return (b'uv-ok\n', None)

    async def fake_exec(*args, **kwargs):
        captured['args'] = args
        captured['kwargs'] = kwargs
        return _Proc()

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)
    monkeypatch.setattr(execute_module.settings, 'task_cpu_limit_seconds', 0)

    code, out = asyncio.run(execute_module._run_uv(['uv', 'venv', '/tmp/x'], 30))
    assert (code, out) == (0, 'uv-ok\n')

    args, kwargs = captured['args'], captured['kwargs']
    assert args[0] == sys.executable and args[1] == '-I'
    assert args[2] == str(sandbox.LAUNCHER_SCRIPT)
    spec = json.loads(args[3])
    assert spec['RLIMIT_CPU'] == [90, 100]
    assert 'RLIMIT_NPROC' not in spec
    assert args[4] == '--'
    assert args[5:] == ('uv', 'venv', '/tmp/x')
    assert 'preexec_fn' not in kwargs
    assert kwargs['start_new_session'] is True


@posix_only
def test_prepare_run_keeps_unwrapped_command_in_error(monkeypatch):
    """git 失败文案不得暴露 launcher argv（用户看到的是真实命令）。"""
    real_cmd = ['git', 'clone', '--bare', 'url', '/tmp/cache']
    wrapped_holder = {}

    def fake_run(cmd, **kwargs):
        wrapped_holder['cmd'] = cmd
        raise execute_module.subprocess.CalledProcessError(128, cmd)

    monkeypatch.setattr(execute_module.subprocess, 'run', fake_run)
    with pytest.raises(execute_module.subprocess.CalledProcessError) as excinfo:
        execute_module._run_prepare_cmd(real_cmd, {'RLIMIT_AS': (1024, 1024)}, timeout=5)
    # launcher 确实被用上了
    assert wrapped_holder['cmd'][:3] == [sys.executable, '-I', str(sandbox.LAUNCHER_SCRIPT)]
    # 但异常里的 cmd 是真实命令（与改动前逐字一致，分类规则不受影响）
    assert excinfo.value.cmd == real_cmd
    assert excinfo.value.returncode == 128


# ---------------------------------------------------------------------------
# 5) 树杀安全底线：绝不 killpg 执行器自己所在的进程组
# ---------------------------------------------------------------------------

def test_kill_process_tree_never_kills_own_group(monkeypatch):
    calls = []

    class FakeProc:
        pid = 4242

        def kill(self):
            calls.append('proc.kill')

    monkeypatch.setattr(execute_module, 'sys', SimpleNamespace(platform='linux'))
    monkeypatch.setattr(
        execute_module, 'os',
        SimpleNamespace(getpgid=lambda pid: 777,
                        killpg=lambda pgid, sig: calls.append(('killpg', pgid, sig))),
    )
    monkeypatch.setattr(execute_module, 'signal', SimpleNamespace(SIGKILL=9))

    asyncio.run(execute_module._kill_process_tree(FakeProc()))

    # 子进程（据报）与执行器同组 → 只杀该 pid，绝不 killpg 自己
    assert calls == ['proc.kill']
