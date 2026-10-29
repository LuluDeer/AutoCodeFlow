"""EXEC-02（执行器审计 P2）：POSIX 任务启动器 —— exec 前的资源上限。

## 为什么需要它

执行器是**多线程**进程（``asyncio.to_thread`` 的 prepare 线程、anyio 的
selector 线程、pydantic-settings 启动线程……）。CPython 明确标注
``subprocess`` 的 ``preexec_fn``（fork 之后、exec 之前跑 Python 代码）在多线程
进程里**可能死锁**：子进程只继承了调用线程，任何需要其它线程持有的锁
（malloc/GIL/import lock……）都可能在 exec 前的 Python 代码里永远等下去——任务
进程还没 exec 就挂住，执行器只能等它超时。

本模块把「exec 前要做的事」搬到一个**新 exec 的单线程解释器**里：

    python3 -I task_launcher.py '<limits-json>' -- <真实命令...>

launcher 自己（此时是单线程新进程，没有继承的锁面）：

1. ``setsid()`` —— 独立会话/进程组（超时按 pgid 杀树的依赖；若父进程已用
   ``start_new_session``/``POSIX_SPAWN_SETSID`` 建好会话，EPERM 属预期，继续）；
2. ``setrlimit()`` —— 按 limits 逐条施加 RLIMIT_AS/CPU/FSIZE/NOFILE/NPROC；
3. 还原 ``SIGPIPE``/``SIGXFZ``/``SIGXFSZ`` 为 ``SIG_DFL``（见 `restore_signals`）；
4. ``os.execvpe(cmd)`` —— **PID 不变**，于是执行器手里的 pid 仍是任务进程的
   pid、pgid 仍等于该 pid，超时/停机/被杀三条树杀路径逐字节不受影响。

## 信任边界

launcher 的 argv 来自执行器自身（不是任务输入），但仍然**不信任**：资源名必须
在 `ALLOWED_LIMITS` 白名单内，soft/hard 必须是正整数且 ``soft <= hard``，
``--`` 之后必须是非空命令。任何不合规 → stderr 打印
``AUTOCF_LAUNCHER_ERROR: <可读原因>`` 并以 `EXIT_BAD_SPEC` 退出，**绝不**在
「限制没生效」的形态下继续 exec（fail-closed：任务失败，而不是静默无限制执行）。

单条 ``setrlimit`` 失败（如超出宿主硬限）沿用既有语义：不阻断其余限制、继续
执行，但把 ``AUTOCF_LAUNCHER_WARN:`` 打进任务日志（stderr 与 stdout 在
run_task 里合并捕获）——**可见的降级**，不是静默降级。
"""
from __future__ import annotations

import errno
import json
import os
import resource
import signal
import sys

#: 启动器失败标记：execute.py 的 ``_launcher_startup_failure_reason`` 据此把
#: 「退出码 127/126」翻成可读文案（否则用户只看到「进程以退出码 127 结束」）。
ERROR_MARKER = 'AUTOCF_LAUNCHER_ERROR'
#: 单条 rlimit 未生效（不致命，但必须可见）。
WARN_MARKER = 'AUTOCF_LAUNCHER_WARN'
#: 参数/limits 不合规：什么都没启动。
EXIT_BAD_SPEC = 127
#: setsid 失败或 exec 失败（例如解释器/入口不存在）。
EXIT_LAUNCH_FAILED = 126

#: 与本模块的调用方 ``sandbox.build_rlimit_limits`` 产出的键集一一对应。
#: 白名单而不是 ``getattr(resource, name)`` 直取：否则 argv 里一个
#: ``RLIMIT_XXX`` 之外的字符串只会让 launcher 自己在 traceback 里崩掉。
ALLOWED_LIMITS: tuple[str, ...] = (
    'RLIMIT_AS',
    'RLIMIT_CPU',
    'RLIMIT_FSIZE',
    'RLIMIT_NOFILE',
    'RLIMIT_NPROC',
)

# 名字 → resource 常量（缺某个资源时从表里消失，parse 时给出可读报错）。
_RESOURCES: dict[str, int] = {
    name: getattr(resource, name) for name in ALLOWED_LIMITS if hasattr(resource, name)
}
_NAMES_BY_RESOURCE: dict[int, str] = {value: key for key, value in _RESOURCES.items()}

# CPython 启动时把 SIGPIPE 设为 SIG_IGN（改抛 BrokenPipeError），而 SIG_IGN 会
# 跨 exec 继承。subprocess 的 restore_signals=True（默认）会在 child 里还原它们；
# 走 launcher 后这层由本模块补上，任务进程看到的信号语义才与直连 spawn 一致。
_SIGNALS_TO_RESTORE = ('SIGPIPE', 'SIGXFZ', 'SIGXFSZ')


def _emit(marker: str, message: str) -> None:
    print(f'{marker}: {message}', file=sys.stderr, flush=True)


def parse_limits(raw: str) -> dict[int, tuple[int, int]]:
    """把 ``'{"RLIMIT_NOFILE": [1024, 1024]}'`` 解析成 ``{resource 常量: (soft, hard)}``。

    严格校验（不可信输入）：JSON 对象、键在白名单内、值恰为两个 ``int``
    （``bool`` 是 ``int`` 的子类，故用 ``type(x) is int`` 排除）、
    ``1 <= soft <= hard``。任何不合规抛 ``ValueError``（消息直接面向用户）。
    """
    try:
        spec = json.loads(raw)
    except (TypeError, ValueError):
        raise ValueError('limits 不是合法 JSON') from None
    if not isinstance(spec, dict):
        raise ValueError('limits 必须是 JSON 对象')
    limits: dict[int, tuple[int, int]] = {}
    for name, pair in spec.items():
        rsrc = _RESOURCES.get(name)
        if rsrc is None:
            raise ValueError(
                f'未知或不支持的资源上限 {name!r}；允许：'
                + ', '.join(sorted(_RESOURCES))
            )
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise ValueError(f'{name} 必须是 [soft, hard] 二元数组')
        soft, hard = pair
        if type(soft) is not int or type(hard) is not int:
            raise ValueError(f'{name} 的 soft/hard 必须是整数：{pair!r}')
        if soft < 1 or hard < soft:
            raise ValueError(f'{name} 的取值非法（要求 1 <= soft <= hard）：{pair!r}')
        limits[rsrc] = (soft, hard)
    return limits


def ensure_new_session() -> None:
    """把当前进程放进新会话（pgid == pid，无控制终端）。

    父进程若已用 ``start_new_session=True``（posix_spawn 的 SETSID）建好会话，
    本进程就是会话首进程，``setsid()`` 必然 EPERM——那正是期望状态，继续。
    其它 errno 一律上抛（拿不到独立会话就不能给超时杀树提供 pgid 前提，
    fail-closed 比「跑起来但树杀会打到执行器自己的组」安全）。
    """
    try:
        os.setsid()
    except OSError as exc:
        if exc.errno == errno.EPERM and os.getsid(0) == os.getpid():
            return
        raise


def apply_limits(limits: dict[int, tuple[int, int]]) -> list[str]:
    """逐条 ``setrlimit``；返回未生效项的可读描述（空列表 = 全部生效）。"""
    failures: list[str] = []
    for rsrc, (soft, hard) in limits.items():
        try:
            resource.setrlimit(rsrc, (soft, hard))
        except (ValueError, OSError) as exc:  # 单条失败不阻断其余
            name = _NAMES_BY_RESOURCE.get(rsrc, str(rsrc))
            failures.append(f'setrlimit({name}, ({soft}, {hard})) 失败：{exc}；该上限未生效')
    return failures


def restore_signals() -> None:
    """把 ``SIGPIPE``/``SIGXFZ``/``SIGXFSZ`` 还原为默认处置（对齐 subprocess）。"""
    for name in _SIGNALS_TO_RESTORE:
        sig = getattr(signal, name, None)
        if sig is None:  # pragma: no cover - 非 Linux 的 POSIX 可能没有 SIGXFZ
            continue
        try:
            signal.signal(sig, signal.SIG_DFL)
        except (OSError, ValueError, RuntimeError):  # pragma: no cover - 非主线程等
            continue


def main(argv: list[str] | None = None) -> int:
    """``<limits-json> -- <cmd...>``：施加限制后 exec（不返回，除非失败）。"""
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        _emit(ERROR_MARKER, '缺少 limits 参数；用法：<limits-json> -- <命令...>')
        return EXIT_BAD_SPEC
    if len(args) < 3 or args[1] != '--':
        _emit(ERROR_MARKER, '参数形状必须是：<limits-json> -- <命令...>')
        return EXIT_BAD_SPEC
    raw, cmd = args[0], args[2:]
    try:
        limits = parse_limits(raw)
    except ValueError as exc:
        _emit(ERROR_MARKER, str(exc))
        return EXIT_BAD_SPEC
    try:
        ensure_new_session()
    except OSError as exc:
        _emit(ERROR_MARKER, f'无法建立独立会话（setsid 失败：{exc}）；任务未启动')
        return EXIT_LAUNCH_FAILED
    for failure in apply_limits(limits):
        _emit(WARN_MARKER, failure)
    restore_signals()
    try:
        os.execvpe(cmd[0], cmd, os.environ)
    except OSError as exc:
        _emit(ERROR_MARKER, f'无法执行任务命令 {cmd[0]!r}：{exc}')
        return EXIT_LAUNCH_FAILED
    return EXIT_LAUNCH_FAILED  # pragma: no cover - execvpe 成功即不再返回


if __name__ == '__main__':  # pragma: no cover - 子进程入口
    sys.exit(main())
