"""EXEC-02（审计 P2）：POSIX 任务启动器（``task_launcher.py``）测试。

四层：

1. **纯单元**（in-process）：limits 严格校验、单条 setrlimit 失败、信号还原、
   ``setsid`` 的 EPERM 容忍/其它 errno 上抛、``main`` 的各条失败分支；
2. **真跑**（POSIX）：新 exec 的子进程确实拿到 rlimit、坐在自己的会话/进程组里、
   ``SIGPIPE`` 已还原为 ``SIG_DFL``——这是「限制在任务第一条指令前生效」的
   端到端证据，而不是对实现细节的断言；
3. **失败路径**：畸形 limits / 未知资源 / exec 失败 → 退出码 +
   ``AUTOCF_LAUNCHER_ERROR:`` 标记（execute.py 据此产出可读 errorMessage，
   绝不静默变成「无 rlimit 执行」）；
4. **不可执行**：limits 不合规时命令**一行都没跑**（用副作用文件反证）。
"""
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

if sys.platform == 'win32':  # pragma: no cover - 见文件头：launcher 仅 POSIX
    # 必须在 import task_launcher **之前**跳过：该模块依赖 resource（POSIX only），
    # 在 win32 上 import 就会 ModuleNotFoundError，而 pytest 的 skipif 标记要等
    # 模块导入成功之后才生效（否则是 collection error 而不是 skip）。
    pytest.skip('task_launcher 仅 POSIX（无 resource 模块）', allow_module_level=True)

import task_launcher

LAUNCHER = Path(task_launcher.__file__).resolve()

# 子进程探针：一次性把 rlimit、会话/进程组、SIGPIPE 处置打成一行 JSON。
_PROBE = (
    'import json, os, resource, signal;'
    'print(json.dumps({'
    '"pid": os.getpid(),'
    '"pgrp": os.getpgrp(),'
    '"sid": os.getsid(0),'
    '"nofile": list(resource.getrlimit(resource.RLIMIT_NOFILE)),'
    '"as": list(resource.getrlimit(resource.RLIMIT_AS)),'
    '"fsize": list(resource.getrlimit(resource.RLIMIT_FSIZE)),'
    '}))'
)


def _launch(raw_spec, cmd, **kwargs):
    """跑一次 launcher（raw_spec 原样作为 argv[1]，便于传畸形值）。"""
    return subprocess.run(
        [sys.executable, '-I', str(LAUNCHER), raw_spec, '--', *cmd],
        capture_output=True,
        text=True,
        timeout=60,
        **kwargs,
    )


def _probe(**kwargs):
    proc = _launch(json.dumps(kwargs.pop('spec')), [sys.executable, '-c', _PROBE], **kwargs)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


# ---------------------------------------------------------------------------
# 真跑：限制 + 独立会话 + 信号语义
# ---------------------------------------------------------------------------

def test_launcher_applies_limits_and_opens_new_session():
    """限制生效 + 独立会话/进程组（超时按 pgid 杀树的前提）都在**子进程**里验。"""
    nofile = 256
    address_space = 512 * 1024 * 1024
    fsize = 64 * 1024 * 1024
    probe = _probe(
        spec={
            'RLIMIT_NOFILE': [nofile, nofile],
            'RLIMIT_AS': [address_space, address_space],
            'RLIMIT_FSIZE': [fsize, fsize],
        },
    )
    assert probe['nofile'] == [nofile, nofile]
    assert probe['as'] == [address_space, address_space]
    assert probe['fsize'] == [fsize, fsize]
    # setsid 生效：进程组 == 会话 == 自己的 pid（与父进程的完全不同）
    assert probe['pgrp'] == probe['pid']
    assert probe['sid'] == probe['pid']
    assert probe['pgrp'] != os.getpgrp()


def _sigign_mask(pid: int) -> int:
    """/proc/<pid>/status 的 SigIgn 掩码（探测 exec 后仍生效的「被忽略」信号）。"""
    with open(f'/proc/{pid}/status', encoding='utf-8') as fh:
        for line in fh:
            if line.startswith('SigIgn:'):
                return int(line.split()[-1], 16)
    raise AssertionError(f'/proc/{pid}/status 缺少 SigIgn 行')


def test_launcher_restores_sigpipe_before_exec():
    """CPython 把 SIGPIPE 设成 SIG_IGN，而 SIG_IGN 跨 exec 继承。

    旧 preexec 路径由 subprocess 的 restore_signals=True 兜底；换成 launcher 后
    必须由 launcher 自己还原，否则任务进程会看到「SIGPIPE 被忽略」——写已关闭
    管道时变成 EPIPE 异常而不是按默认动作终止，语义与改动前不同。

    观测方式：让 launcher exec 一个**不碰信号**的进程（``sh -c 'echo $$; exec
    sleep'``，exec 保持 pid），再读它的 /proc SigIgn 掩码。负向对照（一个故意
    不还原 SIGPIPE 的 python 再 exec）实测该掩码会置上 SIGPIPE 位，故这个探针
    对「有没有还原」是敏感的；用 python 自己当探针则不行——CPython 启动时总会
    重新把 SIGPIPE 设成 SIG_IGN。
    """
    if not Path('/proc/self/status').exists():
        pytest.skip('本机无 /proc，无法观测 exec 后的信号处置')
    proc = subprocess.Popen(
        [sys.executable, '-I', str(LAUNCHER), '{}', '--',
         'sh', '-c', 'echo $$; exec sleep 5'],
        stdout=subprocess.PIPE, text=True,
    )
    try:
        pid = int(proc.stdout.readline().strip())
        mask = _sigign_mask(pid)
    finally:
        proc.kill()
        # communicate() 而不是 wait()：顺带读空并关闭管道，否则 pytest 的
        # ResourceWarning 严格模式会把「未关闭的 FileIO」记成用例失败。
        proc.communicate(timeout=10)
    assert mask & (1 << (signal.SIGPIPE - 1)) == 0, (
        f'SIGPIPE 仍被忽略（SigIgn={mask:#x}）——launcher 未还原信号处置'
    )


def test_launcher_tolerates_session_already_created_by_parent():
    """父进程用 start_new_session=True（posix_spawn SETSID）时，launcher 里的
    setsid() 必然 EPERM——那是期望状态，不能变成任务失败。"""
    probe = _probe(spec={'RLIMIT_NOFILE': [512, 512]}, start_new_session=True)
    assert probe['pgrp'] == probe['pid']
    assert probe['sid'] == probe['pid']
    assert probe['nofile'] == [512, 512]


def test_launcher_execs_even_without_limits():
    """空 limits（配置全 0 / 未配置）仍然只做 setsid + exec，不阻断任务。"""
    probe = _probe(spec={})
    assert probe['pgrp'] == probe['pid']
    assert probe['sid'] == probe['pid']


def test_launcher_keeps_pid_across_exec():
    """execvpe 保持 PID：执行器手里的 pid/pgid 仍是任务进程的（树杀不变）。"""
    probe = _probe(spec={'RLIMIT_NOFILE': [512, 512]})
    assert probe['pid'] == probe['pgrp'] == probe['sid']


# ---------------------------------------------------------------------------
# 失败路径：启动器绝不「静默无限制执行」
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    'raw_spec',
    [
        'not-json',
        '[]',
        '"RLIMIT_NOFILE"',
        '{"RLIMIT_NOFILE": 1024}',
        '{"RLIMIT_NOFILE": [1024]}',
        '{"RLIMIT_NOFILE": [1024, 512, 3]}',
        '{"RLIMIT_NOFILE": [0, 0]}',
        '{"RLIMIT_NOFILE": [2048, 1024]}',
        '{"RLIMIT_NOFILE": [true, true]}',
        '{"RLIMIT_NOFILE": ["1024", "1024"]}',
        '{"RLIMIT_BOGUS": [1, 1]}',
        '{"RLIMIT_AS": [1024, 1024], "RLIMIT_NPROC": [-1, -1]}',
    ],
)
def test_launcher_rejects_malformed_limits_and_runs_nothing(raw_spec, tmp_path):
    side_effect = tmp_path / 'ran'
    proc = _launch(
        raw_spec,
        [sys.executable, '-c', f'open({str(side_effect)!r}, "w").close()'],
    )
    assert proc.returncode == task_launcher.EXIT_BAD_SPEC
    assert 'AUTOCF_LAUNCHER_ERROR:' in proc.stderr
    # 反证：命令一行都没跑（不是「跑了但没限制」）
    assert not side_effect.exists()


def test_launcher_reports_unexecutable_command():
    """真实命令不存在 → 可读错误 + 专属退出码（不是空 stderr 的 exit 1）。"""
    proc = _launch('{}', ['/nonexistent/acf-task-binary'])
    assert proc.returncode == task_launcher.EXIT_LAUNCH_FAILED
    assert 'AUTOCF_LAUNCHER_ERROR:' in proc.stderr
    assert '无法执行' in proc.stderr


# ---------------------------------------------------------------------------
# 纯单元：解析 / 施加 / 信号 / 会话
# ---------------------------------------------------------------------------

def test_parse_limits_returns_resource_constants():
    import resource

    parsed = task_launcher.parse_limits('{"RLIMIT_NOFILE": [64, 128], "RLIMIT_CPU": [5, 15]}')
    assert parsed == {
        resource.RLIMIT_NOFILE: (64, 128),
        resource.RLIMIT_CPU: (5, 15),
    }


def test_parse_limits_rejects_non_object_json():
    with pytest.raises(ValueError, match='JSON 对象'):
        task_launcher.parse_limits('[]')


def test_parse_limits_rejects_bad_json():
    with pytest.raises(ValueError, match='合法 JSON'):
        task_launcher.parse_limits('{oops')


def test_parse_limits_rejects_unknown_resource():
    with pytest.raises(ValueError, match='未知或不支持的资源上限'):
        task_launcher.parse_limits('{"RLIMIT_BOGUS": [1, 1]}')


@pytest.mark.parametrize(
    'raw, message',
    [
        ('{"RLIMIT_NOFILE": 1024}', '二元数组'),
        ('{"RLIMIT_NOFILE": [1024]}', '二元数组'),
        ('{"RLIMIT_NOFILE": [1024, 1024, 1024]}', '二元数组'),
        ('{"RLIMIT_NOFILE": ["1024", "1024"]}', '必须是整数'),
        ('{"RLIMIT_NOFILE": [true, true]}', '必须是整数'),
        ('{"RLIMIT_NOFILE": [0, 0]}', '取值非法'),
        ('{"RLIMIT_NOFILE": [8, 4]}', '取值非法'),
        ('{"RLIMIT_NOFILE": [1, 0]}', '取值非法'),
    ],
)
def test_parse_limits_rejects_bad_pairs(raw, message):
    """逐条校验分支的**消息**也要钉住（launcher 的 stderr 是唯一线索）。"""
    with pytest.raises(ValueError, match=message):
        task_launcher.parse_limits(raw)


def test_apply_limits_reports_single_failure_without_aborting(monkeypatch):
    """单条失败不阻断其余（沿用既有语义），但必须**返回可见原因**。"""
    import resource

    calls = []

    def fake_setrlimit(rsrc, pair):
        calls.append((rsrc, pair))
        if rsrc == resource.RLIMIT_NOFILE:
            raise OSError(1, 'Operation not permitted')

    monkeypatch.setattr(task_launcher.resource, 'setrlimit', fake_setrlimit)
    failures = task_launcher.apply_limits({
        resource.RLIMIT_NOFILE: (64, 64),
        resource.RLIMIT_CPU: (5, 15),
    })
    # 两条都尝试过；只有失败那条被报告
    assert [c[0] for c in calls] == [resource.RLIMIT_NOFILE, resource.RLIMIT_CPU]
    assert len(failures) == 1
    assert 'RLIMIT_NOFILE' in failures[0]
    assert '未生效' in failures[0]


def test_apply_limits_names_unknown_resource_by_value(monkeypatch):
    monkeypatch.setattr(
        task_launcher.resource, 'setrlimit',
        lambda rsrc, pair: (_ for _ in ()).throw(ValueError('boom')),
    )
    failures = task_launcher.apply_limits({123456: (7, 7)})
    assert failures and '123456' in failures[0]


def test_restore_signals_resets_pipe_default():
    """CPython 启动即把 SIGPIPE 设成 SIG_IGN，SIG_IGN 会跨 exec 继承。"""
    saved = signal.getsignal(signal.SIGPIPE)
    try:
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)
        task_launcher.restore_signals()
        assert signal.getsignal(signal.SIGPIPE) == signal.SIG_DFL
    finally:
        signal.signal(signal.SIGPIPE, saved)


def test_ensure_new_session_tolerates_eperm_when_already_leader(monkeypatch):
    def fake_setsid():
        raise OSError(task_launcher.errno.EPERM, 'Operation not permitted')

    monkeypatch.setattr(task_launcher.os, 'setsid', fake_setsid)
    monkeypatch.setattr(task_launcher.os, 'getsid', lambda _pid: os.getpid())
    task_launcher.ensure_new_session()  # 不抛


def test_ensure_new_session_propagates_other_failures(monkeypatch):
    def fake_setsid():
        raise OSError(task_launcher.errno.EPERM, 'Operation not permitted')

    monkeypatch.setattr(task_launcher.os, 'setsid', fake_setsid)
    monkeypatch.setattr(task_launcher.os, 'getsid', lambda _pid: 999999)
    with pytest.raises(OSError):
        task_launcher.ensure_new_session()


# ---------------------------------------------------------------------------
# main()：参数形状 + 失败映射 + exec 调用
# ---------------------------------------------------------------------------

def test_main_requires_limits_argument(capsys):
    assert task_launcher.main([]) == task_launcher.EXIT_BAD_SPEC
    assert 'AUTOCF_LAUNCHER_ERROR:' in capsys.readouterr().err


@pytest.mark.parametrize('argv', [['{}'], ['{}', '--'], ['{}', 'x', 'cmd']])
def test_main_requires_separator_and_command(argv, capsys):
    assert task_launcher.main(argv) == task_launcher.EXIT_BAD_SPEC
    assert 'AUTOCF_LAUNCHER_ERROR:' in capsys.readouterr().err


def test_main_reports_bad_limits(capsys):
    assert task_launcher.main(['{"RLIMIT_BOGUS": [1, 1]}', '--', 'true']) == (
        task_launcher.EXIT_BAD_SPEC
    )
    assert '未知或不支持的资源上限' in capsys.readouterr().err


def test_main_reports_setsid_failure(monkeypatch, capsys):
    def fake_setsid():
        raise OSError(task_launcher.errno.EPERM, 'Operation not permitted')

    monkeypatch.setattr(task_launcher.os, 'setsid', fake_setsid)
    monkeypatch.setattr(task_launcher.os, 'getsid', lambda _pid: 4242)
    monkeypatch.setattr(
        task_launcher.os, 'execvpe',
        lambda *a, **k: pytest.fail('exec 不得在 setsid 失败后发生'),
    )
    assert task_launcher.main(['{}', '--', 'true']) == task_launcher.EXIT_LAUNCH_FAILED
    assert '无法建立独立会话' in capsys.readouterr().err


def test_main_reports_exec_failure(monkeypatch, capsys):
    monkeypatch.setattr(task_launcher, 'ensure_new_session', lambda: None)
    monkeypatch.setattr(
        task_launcher.os, 'execvpe',
        lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError(2, 'No such file')),
    )
    assert task_launcher.main(['{}', '--', 'nope-binary']) == (
        task_launcher.EXIT_LAUNCH_FAILED
    )
    assert '无法执行' in capsys.readouterr().err


def test_main_passes_command_and_env_to_execvpe(monkeypatch):
    """exec 前不吞参数：argv 逐字传给 execvpe，环境沿用当前进程（无 shell）。"""
    recorded = {}
    monkeypatch.setattr(task_launcher, 'ensure_new_session', lambda: None)
    monkeypatch.setattr(task_launcher, 'apply_limits', lambda limits: [])
    monkeypatch.setattr(
        task_launcher.os, 'execvpe',
        lambda file, args, env: recorded.update(file=file, args=list(args), env=env),
    )
    task_launcher.main(['{"RLIMIT_NOFILE": [64, 64]}', '--', 'task-bin', '--flag', 'a b'])
    assert recorded['file'] == 'task-bin'
    assert recorded['args'] == ['task-bin', '--flag', 'a b']
    assert recorded['env'] is os.environ


def test_main_prints_limit_warnings(monkeypatch, capsys):
    """单条 setrlimit 失败必须可见（AUTOCF_LAUNCHER_WARN），而不是静默降级。"""
    monkeypatch.setattr(task_launcher, 'ensure_new_session', lambda: None)
    monkeypatch.setattr(task_launcher, 'apply_limits', lambda limits: ['RLIMIT_AS 未生效'])
    monkeypatch.setattr(task_launcher.os, 'execvpe', lambda *a, **k: None)
    task_launcher.main(['{"RLIMIT_AS": [1, 1]}', '--', 'task-bin'])
    assert 'AUTOCF_LAUNCHER_WARN: RLIMIT_AS 未生效' in capsys.readouterr().err
