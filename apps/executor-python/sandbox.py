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
``build_rlimit_pre_exec(settings, timeout_seconds)`` 返回一个 preexec_fn，
在 fork 之后、exec 之前在任务子进程内施加 RLIMIT_*：

* RLIMIT_AS    —— 地址空间上限（``task_memory_limit_mb``，默认 2048MB）。
  ``a=[0]*10**10`` 在**子进程**内 OOM，而不是拖垮执行器上所有并发任务
  （报告 B-1 的原始 DoS 面）；
* RLIMIT_CPU   —— CPU 秒数（``task_cpu_limit_seconds``，0 回落为
  timeout+60s 宽限）；
* RLIMIT_FSIZE —— 单文件写上限（``task_fsize_limit_mb``）；
* RLIMIT_NOFILE—— fd 上限（``task_nofile_limit``）；
* RLIMIT_NPROC —— 进程数上限（``task_nproc_limit``，默认 0 不设，因
  NPROC 按真实 UID 计，任务与执行器同 UID 时会连带约束执行器）。

Windows 无等价原语（Job Object 需额外工程），win32 上这些限制跳过并
记录 warning；沙箱同样只在 POSIX 生效。

环境隔离
--------
``with_task_tmpdir(env, work_dir)`` 为每个任务创建私有 ``<work_dir>/.tmp``
（0o700）并把 TMPDIR/TEMP/TMP 指过去——即便不启用 bwrap，也确保任务
临时文件留在自己的工作目录内（可被 TTL 清扫回收），不写宿主 /tmp。
"""
from __future__ import annotations

import logging
import os
import shutil
import stat
import sys
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)

# TASK_SANDBOX 支持的取值（与 config.py 的校验保持一致）
SANDBOX_NONE = ''
SANDBOX_BWRAP = 'bwrap'

# win32 无 RLIMIT_* 原语：每个任务都打一行会刷屏，只在首个任务子进程上记一次。
_win32_rlimit_noted = False


class SandboxUnavailable(RuntimeError):
    """沙箱配置启用但无法满足（bwrap 缺失 / 用户命名空间被禁）。

    调用方（routers/execute.py）把它转成任务失败，绝不降级运行。
    """


def _rlimit_pre_exec(limits: dict) -> Callable[[], None]:
    """Return a preexec_fn applying the given {resource.RLIMIT_*: (soft, hard)}."""

    def _apply() -> None:
        import resource

        for rsrc, (soft, hard) in limits.items():
            try:
                resource.setrlimit(rsrc, (soft, hard))
            except (ValueError, OSError) as exc:  # 单条失败不阻断其余
                logger.warning('setrlimit(%s, %r) failed in preexec: %s', rsrc, (soft, hard), exc)

    return _apply


def build_rlimit_pre_exec(
    settings,
    timeout_seconds: float,
) -> Optional[Callable[[], None]]:
    """Build the task-process rlimit preexec_fn from settings (POSIX only).

    Returns None on win32 (no resource module semantics) or when every limit
    is disabled, so callers can keep the existing spawn kwargs untouched.
    """
    global _win32_rlimit_noted
    if sys.platform == 'win32':
        # Windows 宿主开发路径：无 RLIMIT_* 原语（Job Object 需额外工程），
        # 跳过但记一行说明——生产跑在 Linux 容器，这里只是开发机不崩。
        if not _win32_rlimit_noted:
            logger.info(
                'RLIMIT_* task resource caps are not available on win32; '
                'skipping them for task children (POSIX containers are the '
                'production path, where the caps apply)'
            )
            _win32_rlimit_noted = True
        return None
    try:
        import resource
    except ImportError:  # pragma: no cover - 非 POSIX 兜底
        return None

    limits: dict = {}
    mb = settings.task_memory_limit_mb
    if mb and mb > 0:
        value = mb * 1024 * 1024
        limits[resource.RLIMIT_AS] = (value, value)

    cpu = settings.task_cpu_limit_seconds or 0
    if not cpu and timeout_seconds and timeout_seconds > 0:
        # 0（不限时）时也不设 CPU 硬限——任务超时路径已负责 kill。
        cpu = int(timeout_seconds) + 60
    if cpu and cpu > 0:
        # 硬限留 10s 余量：让超时 kill 先到场，避免 SIGXCPU 提前打断正常收尾。
        limits[resource.RLIMIT_CPU] = (cpu, cpu + 10)

    fsize_mb = settings.task_fsize_limit_mb
    if fsize_mb and fsize_mb > 0:
        value = fsize_mb * 1024 * 1024
        limits[resource.RLIMIT_FSIZE] = (value, value)

    nofile = settings.task_nofile_limit
    if nofile and nofile > 0:
        limits[resource.RLIMIT_NOFILE] = (nofile, nofile)

    nproc = settings.task_nproc_limit
    if nproc and nproc > 0:
        limits[resource.RLIMIT_NPROC] = (nproc, nproc)

    if not limits:
        return None
    return _rlimit_pre_exec(limits)


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
            'TASK_SANDBOX=bwrap is not supported on Windows; unset TASK_SANDBOX '
            'or run the executor on Linux with bubblewrap installed'
        )
    bwrap = shutil.which('bwrap')
    if not bwrap:
        raise SandboxUnavailable(
            'TASK_SANDBOX=bwrap is configured but the bwrap binary is not on PATH; '
            'install bubblewrap (apt install bubblewrap / apk add bubblewrap) or '
            'unset TASK_SANDBOX — refusing to run the task unsandboxed'
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
