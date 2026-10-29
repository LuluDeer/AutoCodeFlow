"""任务沙箱与资源限制（SEC-NEW: F-1 / B-1）。

本模块把"任务代码在宿主进程空间直接运行"这一最大短板分层收敛：

F-1 —— 进程隔离（可选，配置驱动）
----------------------------------
``build_sandbox_cmd(cmd, work_dir, tmpdir)`` 在 ``TASK_SANDBOX=bwrap`` 时用
bubblewrap 把任务包进**用户命名空间 + 只读根文件系统 + PrivateTmp**：

    bwrap --die-with-parent --unshare-all --share-net \\
          --ro-bind / / --bind <work_dir> <work_dir> \\
          --tmpfs /tmp --proc /proc --dev /dev \\
          --chdir <work_dir> -- <cmd...>

* ``--unshare-all``（含 user/pid/ipc/uts/cgroup）+ ``--share-net``：任务拥有
  独立命名空间，网络保持可用（任务本质是自动化脚本，断网即废）；
* ``--ro-bind / /``：宿主根文件系统只读——任务无法篡改解释器缓存池
  ``/data/interpreters``、无法改写 ``.git_cache`` 污染后续任务、无法触碰
  宿主二进制；
* ``--tmpfs /tmp`` + ``--bind <work_dir>``：只有任务自己的工作目录可写；
* **用户命名空间**是 F-1 对凭据外泄的核心缓解：跨命名空间后任务进程
  （ns 内 uid 0 → 宿主非特权 uid）对宿主进程的 ``/proc/<pid>/environ``
  访问因 uid 不匹配被 ptrace 拒绝——EXECUTOR_SECRET / EXECUTION_CALLBACK_SECRET
  无法经 ``/proc`` 读到；
* ``--die-with-parent``：执行器 kill 任务进程组时，bwrap 及其子进程随之
  消亡，不留孤儿。

**fail-closed 纪律**：配置了 ``TASK_SANDBOX=bwrap`` 但 bwrap 二进制缺失/
用户命名空间被宿主禁用时，任务**直接失败**（``SandboxUnavailable``），
绝不静默降级为无沙箱运行。``''``（默认）= 不启用，本地开发/测试行为
逐字节不变；生产容器由 docker-compose 显式开启。

B-1 —— 资源上限（始终生效，POSIX）
-----------------------------------
``build_rlimit_limits(settings, timeout_seconds)`` 产出 ``{RLIMIT 名: (soft,
hard)}``（名字而非数值常量：这份 dict 就是 launcher 的 argv 契约，见
``task_launcher.py``），``build_launcher_cmd(cmd, limits)`` 把命令包进
**新 exec 的单线程启动器**：``python3 -I task_launcher.py '<json>' -- <cmd...>``。
启动器在 exec 之前施加 RLIMIT_*：

* RLIMIT_AS    —— 地址空间上限（``task_memory_limit_mb``，默认 2048MB）。
  ``a=[0]*10**10`` 在**子进程**内 OOM，而不是拖垮执行器上所有并发任务
  （报告 B-1 的原始 DoS 面）；
* RLIMIT_CPU   —— CPU 秒数（``task_cpu_limit_seconds``，0 回落为
  timeout+60s 宽限）；
* RLIMIT_FSIZE —— 单文件写上限（``task_fsize_limit_mb``）；
* RLIMIT_NOFILE—— fd 上限（``task_nofile_limit``）；
* RLIMIT_NPROC —— 进程数上限（``task_nproc_limit``，默认 0 不设，因
  NPROC 按真实 UID 计，任务与执行器同 UID 时会连带约束执行器）。

**EXEC-02（审计 P2）：为什么不再是 preexec_fn。** 旧实现返回一个
``preexec_fn`` 在 fork 与 exec 之间跑 Python（``os.setsid`` + setrlimit）。
执行器是**多线程**进程，而 CPython 明确标注「fork 后 exec 前跑 Python 代码」
在多线程下可能死锁（子进程只继承调用线程，`_PyImport_AcquireLock` / malloc
等跨线程锁无人释放 → 任务进程 exec 前挂住）。``task_launcher.py`` 是**新
exec** 的解释器（天然单线程、无继承锁面），它施加限制后 ``os.execvpe`` 真实
命令（PID 不变 → pgid 杀树语义不变）。任务进程的**独立进程组**由父进程的
``start_new_session=True``（posix_spawn SETSID，内核态、child 内零 Python）
建立，launcher 里的 ``setsid()`` 只是兜底。

Windows 无等价原语（Job Object 需额外工程），win32 上这些限制跳过并
记录 warning（``build_rlimit_limits`` 返回 None → 不包 launcher，spawn
kwargs 与任务行为逐字节不变）；沙箱同样只在 POSIX 生效。

环境隔离
--------
``with_task_tmpdir(env, work_dir)`` 为每个任务创建私有 ``<work_dir>/.tmp``
（0o700）并把 TMPDIR/TEMP/TMP 指过去——即便不启用 bwrap，也确保任务
临时文件留在自己的工作目录内（可被 TTL 清扫回收），不写宿主 /tmp。
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import stat
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# TASK_SANDBOX 支持的取值（与 config.py 的校验保持一致）
SANDBOX_NONE = ''
SANDBOX_BWRAP = 'bwrap'

# win32 无 RLIMIT_* 原语：每个任务都打一行会刷屏，只在首个任务子进程上记一次。
_win32_rlimit_noted = False

#: B-1 认的资源白名单。这份名单是**父进程与 task_launcher 的唯一契约**：
#: 父进程只产出名字（JSON 可序列化，不含平台数值常量），launcher 侧再按同一
#: 名单做一次校验（不信任 argv）。
RLIMIT_NAMES: tuple[str, ...] = (
    'RLIMIT_AS',
    'RLIMIT_CPU',
    'RLIMIT_FSIZE',
    'RLIMIT_NOFILE',
    'RLIMIT_NPROC',
)

#: 启动器脚本路径（随执行器代码一起发布）。用 ``Path(__file__)`` 而不是
#: ``sys.path``/cwd：任务子进程的 cwd 是任务工作目录，那里不可信。
LAUNCHER_SCRIPT: Path = Path(__file__).resolve().with_name('task_launcher.py')


class SandboxUnavailable(RuntimeError):
    """沙箱/资源限制配置启用但无法满足（bwrap 缺失 / 用户命名空间被禁 /
    资源限制启动器不可用）。

    调用方（routers/execute.py）把它转成任务失败，绝不降级运行。
    """


def build_rlimit_limits(
    settings,
    timeout_seconds: float,
    *,
    include_nproc: bool = True,
) -> Optional[dict[str, tuple[int, int]]]:
    """Build the task-process rlimit spec from settings (POSIX only).

    Returns ``{name: (soft, hard)}`` or None on win32 (no resource module
    semantics) / when every limit is disabled, so callers can skip the
    launcher wrapper entirely and keep spawn args untouched.

    ``include_nproc=False`` is for the prepare-stage subprocesses (git/uv):
    RLIMIT_NPROC is charged per *real UID*, and uv legitimately spawns helper
    processes of its own, so prepare keeps the historical "no NPROC" shape.
    """
    global _win32_rlimit_noted
    if sys.platform == 'win32':
        # Windows 宿主开发路径：无 RLIMIT_* 原语（Job Object 需额外工程），
        # 跳过但记一行说明——生产跑在 Linux 容器，这里只是开发机不崩。
        if not _win32_rlimit_noted:
            logger.info(
                'RLIMIT_* task resource caps are not available on win32; '
                'skipping them for task children (POSIX containers are the '
                'production path, where the caps apply). Job Object upgrade '
                'plan: docs/deployment.md Windows chapter §4b'
            )
            _win32_rlimit_noted = True
        return None

    limits: dict[str, tuple[int, int]] = {}
    mb = settings.task_memory_limit_mb
    if mb and mb > 0:
        value = mb * 1024 * 1024
        limits['RLIMIT_AS'] = (value, value)

    cpu = settings.task_cpu_limit_seconds or 0
    if not cpu and timeout_seconds and timeout_seconds > 0:
        # 0（不限时）时也不设 CPU 硬限——任务超时路径已负责 kill。
        cpu = int(timeout_seconds) + 60
    if cpu and cpu > 0:
        # 硬限留 10s 余量：让超时 kill 先到场，避免 SIGXCPU 提前打断正常收尾。
        limits['RLIMIT_CPU'] = (cpu, cpu + 10)

    fsize_mb = settings.task_fsize_limit_mb
    if fsize_mb and fsize_mb > 0:
        value = fsize_mb * 1024 * 1024
        limits['RLIMIT_FSIZE'] = (value, value)

    nofile = settings.task_nofile_limit
    if nofile and nofile > 0:
        limits['RLIMIT_NOFILE'] = (nofile, nofile)

    if include_nproc:
        nproc = settings.task_nproc_limit
        if nproc and nproc > 0:
            limits['RLIMIT_NPROC'] = (nproc, nproc)

    if not limits:
        return None
    return limits


def _encode_limits(limits) -> str:
    """Validate + serialize the rlimit spec for the launcher argv.

    The launcher re-validates (it never trusts argv), but failing here keeps
    the failure inside the executor with a readable message **before** a
    process is spawned — and makes it impossible to hand the launcher a spec
    that would make it bail out after the fact.
    """
    if not isinstance(limits, dict):
        raise SandboxUnavailable(
            f'资源限制参数非法（不是映射）：{limits!r}；已 fail-closed，未降级为无资源限制运行'
        )
    payload: dict[str, list[int]] = {}
    for name, pair in limits.items():
        if name not in RLIMIT_NAMES:
            raise SandboxUnavailable(
                f'资源限制参数非法：未知资源 {name!r}（允许：{", ".join(RLIMIT_NAMES)}）；'
                '已 fail-closed，未降级为无资源限制运行'
            )
        if not isinstance(pair, (tuple, list)) or len(pair) != 2:
            raise SandboxUnavailable(
                f'资源限制参数非法：{name} 必须是 (soft, hard)；'
                '已 fail-closed，未降级为无资源限制运行'
            )
        soft, hard = pair
        if type(soft) is not int or type(hard) is not int:
            raise SandboxUnavailable(
                f'资源限制参数非法：{name} 的 soft/hard 必须是整数：{pair!r}；'
                '已 fail-closed，未降级为无资源限制运行'
            )
        if soft < 1 or hard < soft:
            raise SandboxUnavailable(
                f'资源限制参数非法：{name} 要求 1 <= soft <= hard，实际 {pair!r}；'
                '已 fail-closed，未降级为无资源限制运行'
            )
        payload[name] = [soft, hard]
    return json.dumps(payload, sort_keys=True)


def build_launcher_cmd(cmd: list[str], limits) -> list[str]:
    """Wrap ``cmd`` so RLIMIT_* are applied by ``task_launcher.py``.

    ``limits`` is the output of :func:`build_rlimit_limits` (or None). None /
    empty → returns ``cmd`` unchanged (zero-overhead path: no rlimits
    configured, or win32 where RLIMIT has no equivalent).

    The launcher is a **freshly exec'd** interpreter, so no Python runs
    between fork and exec of the task itself (EXEC-02): that is what removes
    the multi-threaded-fork deadlock surface of the old ``preexec_fn``. It
    keeps the PID (``execvpe``), so the executor's pgid-based tree kill still
    targets the task's own process group (established by the spawn's
    ``start_new_session``).
    """
    if not limits:
        return cmd
    if sys.platform == 'win32':
        # 防御性：build_rlimit_limits 在 win32 恒返回 None。真走到这里说明调用
        # 方绕过了配置层——宁可失败，也不静默变成「无资源限制执行」。
        raise SandboxUnavailable(
            '资源限制启动器（task_launcher）仅支持 POSIX；win32 无 RLIMIT_* 原语；'
            '已 fail-closed，未降级为无资源限制运行'
        )
    if not sys.executable:
        # 嵌入式/冻结解释器可能没有 sys.executable。此时无法起 launcher —— 宁可
        # 让任务失败，也不静默丢掉资源上限继续跑。
        raise SandboxUnavailable(
            '资源限制启动器需要 sys.executable，但当前解释器未报告可执行路径；'
            '已 fail-closed，未降级为无资源限制运行'
        )
    spec = _encode_limits(limits)
    return [sys.executable, '-I', str(LAUNCHER_SCRIPT), spec, '--', *cmd]


def build_sandbox_cmd(
    cmd: list[str],
    work_dir: Path,
) -> list[str]:
    """Wrap ``cmd`` in the configured sandbox (F-1).

    * ``settings.task_sandbox == 'bwrap'`` → bubblewrap wrapper;
      bwrap missing or unusable → raise SandboxUnavailable (fail-closed).
    * anything else (default '') → returns ``cmd`` unchanged (零变化).
    """
    settings = _get_settings()
    if settings.task_sandbox != SANDBOX_BWRAP:
        return cmd
    if sys.platform == 'win32':
        raise SandboxUnavailable(
            'TASK_SANDBOX=bwrap 在 Windows 上不受支持；请取消 TASK_SANDBOX，'
            '或改在已安装 bubblewrap 的 Linux 上运行执行器'
        )
    bwrap = shutil.which('bwrap')
    if not bwrap:
        raise SandboxUnavailable(
            'TASK_SANDBOX=bwrap 已配置，但 PATH 上没有 bwrap 二进制；'
            '请安装 bubblewrap（apt install bubblewrap / apk add bubblewrap）'
            '或取消 TASK_SANDBOX —— 拒绝在无沙箱模式下运行任务'
        )
    wd = str(work_dir)
    return [
        bwrap,
        '--die-with-parent',
        '--unshare-all',
        '--share-net',
        '--ro-bind', '/', '/',
        '--bind', wd, wd,
        '--tmpfs', '/tmp',
        '--proc', '/proc',
        '--dev', '/dev',
        '--chdir', wd,
        '--',
        *cmd,
    ]


def with_task_tmpdir(env: dict[str, str], work_dir: Path) -> None:
    """Point TMPDIR/TEMP/TMP at a private per-task dir under work_dir.

    The dir is created 0o700 inside the (already 0o700) work dir so task temp
    files are scoped to the task and reclaimed by the disk TTL sweep.
    """
    tmpdir = work_dir / '.tmp'
    try:
        tmpdir.mkdir(parents=True, exist_ok=True)
        os.chmod(tmpdir, stat.S_IRWXU)
    except OSError as exc:  # 非关键：失败则沿用继承的 TMP 值
        logger.warning('create task tmpdir failed (non-critical): %s', exc)
        return
    env['TMPDIR'] = str(tmpdir)
    env['TEMP'] = str(tmpdir)
    env['TMP'] = str(tmpdir)


def _get_settings():
    # 延迟导入避免循环依赖（config 不依赖本模块；execute 依赖本模块与 config）
    from config import settings

    return settings
