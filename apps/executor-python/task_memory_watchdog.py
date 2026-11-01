"""S4-C2（audit-r4 对齐）：任务**进程树**内存看门狗——RSS 周期采样 + 超限回调。

## 为什么 RLIMIT_AS 不够（本模块存在的理由）

``sandbox.py`` 给任务子进程施加 ``RLIMIT_AS``（地址空间字节数）。它是
**per-process** 的上限：rlimit 被 fork 继承的是「每个进程都不许超过 X」，不是
「整棵树共享一份 X 的账本」。于是——

* **树内聚合无界**：一个任务 ``for _ in range(20): Process(target=hog)`` 起 20
  个各吃 2GB 的子进程，每个都「守规矩」（谁都没撞自己的 RLIMIT_AS），整棵树
  却是 40GB；宿主被压到 OOM，执行器连同**同机其它并发任务**一起死。
* RLIMIT_AS 量的是**虚拟地址空间**而非 RSS：V8/JVM 这类预留大块地址空间的
  运行时会被它误伤（4GB 的 mmap 预留 ≠ 4GB 常驻），而真正压宿主的是常驻。
* 容器部署时 cgroup ``memory.max`` 是最后一道闸；**systemd / 裸机部署没有
  容器 cap**，这道闸不存在，唯一能兜住的就是用户态采样。

node 侧没有 POSIX rlimit 等价物，早已用这套「周期采样进程树 RSS、超限即整树
杀」（``apps/executor-node/src/memory-watchdog.ts``）达成同一防护目标。python
侧缺这一层 ⇒ **同一份任务代码在两端语义不同**：node 上树内存超 2048MB 被杀，
python 上照样跑（只要没有单个进程撞到自己的 RLIMIT_AS）。本模块把这条缺口
补上，**不动 RLIMIT_AS**（它是 per-process 的第一道闸，两者互补：rlimit 拦
单进程失控，看门狗拦树聚合失控）。

## 为什么沿用 node 的口径（而不是另起一套）

1. **树聚合方式逐字相同**：读 ``/proc/<pid>/status`` 的 ``VmRSS``，并经
   ``/proc/<pid>/task/<pid>/children`` 递归求和（栈 + seen 去重，覆盖孙进程）。
   RSS 才是真正压宿主的指标，且 VmRSS 与 node 读的是**同一个字段**。
2. **采样间隔同默认**：2000ms（node ``taskMemoryWatchdogIntervalMs`` 的默认
   值，同名 env ``TASK_MEMORY_WATCHDOG_INTERVAL_MS``）。
3. **默认上限同源**：都取 ``task_memory_limit_mb`` / ``TASK_MEMORY_LIMIT_MB``
   的 2048MB；``0`` = 关闭（两侧都由调用方在启动前判 ``> 0``，语义同款）。
4. **结算时机相同**：spawn 之后起、进程退出之前停。node 在
   ``close``/``error``/timeout/超限四条路径里 ``stop``；本侧在 ``run_task``
   的 ``finally`` 里 ``stop``（覆盖所有退出路径，含取消/异常）。
5. **文案骨架逐字相同**（``MEMORY_LIMIT_MESSAGE_TEMPLATE``）：中台的
   ``inferFailureReason`` 是**文本匹配**分类器，两端同一句才落同一个
   failureReason、runbook 才只需一份判据。改这一句必须同时改两端
   （tests/test_task_memory_watchdog.py 有一条跨端断言钉住它）。
6. **不新增协议枚举值**：``killed`` 的语义已被「人工/停机终止」占用
   （runbook 按它判断"不是任务自身的问题"），把内存超限混进 ``killed`` 会
   误导处置方向。故本侧只产出既有 failed 终态 + 这段可识别的 errorMessage。

## 边界（best-effort，绝不打断任务）

``/proc`` 不存在（非 Linux / 禁用 procfs / pid 已退出）⇒ 采样返回 0 ⇒ 看门狗
**静默不生效**——与 node 侧 Windows 用 tasklist 的"直系子进程、孙进程不在采样
内"同款定位：这是尽力而为的护栏，不是任务成败的判据。采样异常一律吞掉（
看门狗不决定终态，只有超限才干预）；``start_memory_watchdog`` 在任何情况下
都不抛异常打断任务（无事件循环时降级为 no-op 并记一行 warning）。

**明确不做**：不新增平台专用采样器（win32 无 ``/proc``，python 生产路径是
POSIX 容器，开发机 win32 与 ``RLIMIT_*`` 一样跳过）；不改 ``RLIMIT_AS``。
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import os
import re
from typing import Any, Callable, Optional, Protocol, Set, runtime_checkable

logger = logging.getLogger(__name__)

#: 采样间隔默认值（毫秒）——与 node ``taskMemoryWatchdogIntervalMs`` 同默认值。
DEFAULT_INTERVAL_MS = 2000

#: python 侧采样间隔下限（毫秒）。node 用 ``setInterval``，配 0 会退化成每 tick
#: 1ms 的忙轮询；asyncio 侧 ``sleep(0)`` 更糟（占满事件循环饿死任务 IO），故钳
#: 到 100ms。这是**唯一**与 node 不逐字相同的数值，理由见
#: ``Settings.task_memory_watchdog_interval_ms`` 的注释。
MIN_INTERVAL_MS = 100

#: 超限文案的**骨架**——与 node ``routes/execute.ts`` 里
#: ``任务超出了 ${config.taskMemoryLimitMb}MB 的内存上限`` 逐字同口径。
#: 中台按文本匹配分类，改这句话等于改两端共用的 runbook 判据。
MEMORY_LIMIT_MESSAGE_TEMPLATE = '任务超出了 {limit_mb}MB 的内存上限'

_VM_RSS_RE = re.compile(r'^VmRSS:\s*(\d+)\s*kB', re.IGNORECASE | re.MULTILINE)


def format_memory_limit_message(limit_mb: int) -> str:
    """按骨架渲染超限文案（node 侧同一句话的模板字符串等价物）。"""
    return MEMORY_LIMIT_MESSAGE_TEMPLATE.format(limit_mb=limit_mb)


@runtime_checkable
class MemorySampler(Protocol):
    """进程树 RSS 采样器协议（node ``MemorySampler`` 的等价物）。

    ``sample_rss_bytes(pid)`` 返回该 pid **整棵进程树**当前 RSS 总量（字节）；
    进程不存在 / 平台不支持时返回 0（不得抛异常——抛了也会被吞，但返回 0
    才是契约）。可注入：单测用 fake sampler，不依赖真实 ``/proc``。
    """

    def sample_rss_bytes(self, pid: int) -> int:  # pragma: no cover - Protocol
        ...


def _read_proc_file(path: str) -> Optional[str]:
    """读 ``/proc`` 文件；不存在/不可读一律 None（node ``readProcFile`` 同款）。"""
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as fh:
            return fh.read()
    except (OSError, ValueError):
        # OSError 覆盖 ENOENT（进程已退出）/ EACCES（procfs 隐藏）；
        # ValueError 覆盖嵌入 NUL 之类的病态路径。
        return None


class LinuxProcTreeSampler:
    """Linux ``/proc`` 进程树 RSS 采样器（含孙进程）。

    ``proc_root`` 可注入：单测用 tmp_path 下搭一份假的 procfs 树，走**真实**
    读文件 + 真实递归，而不是 mock 掉 IO——这样"是树不是单进程"这条断言
    验证的是产品代码的聚合逻辑。
    """

    def __init__(self, proc_root: str = '/proc') -> None:
        self._proc_root = proc_root

    def _read(self, *parts: str) -> Optional[str]:
        return _read_proc_file(os.path.join(self._proc_root, *parts))

    def _read_vm_rss_kb(self, pid: int) -> int:
        status = self._read(str(pid), 'status')
        if not status:
            return 0
        match = _VM_RSS_RE.search(status)
        return int(match.group(1)) if match else 0

    def _read_children(self, pid: int) -> list[int]:
        # /proc/<pid>/task/<pid>/children 是内核直接给出的**直系子进程**列表
        # （空格分隔，末尾换行）。比扫 /proc/*/stat 的 PPid 便宜一个数量级，
        # 也不会在 pid 复用时把别人的孩子算进来。
        raw = self._read(str(pid), 'task', str(pid), 'children')
        if not raw:
            return []
        return [int(tok) for tok in raw.split() if tok.isdigit() and int(tok) > 0]

    def sample_rss_bytes(self, pid: int) -> int:
        """整棵树（自身 + 子 + 孙 …）的 RSS 总和，单位字节。"""
        total_kb = 0
        stack = [pid]
        seen: Set[int] = set()
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            total_kb += self._read_vm_rss_kb(current)
            stack.extend(self._read_children(current))
        return total_kb * 1024


#: 模块级默认采样器（node ``linuxProcTreeSampler`` 的单例等价物）。
linux_proc_tree_sampler = LinuxProcTreeSampler()


class MemoryWatchdog:
    """看门狗句柄：持后台采样任务，``stop()`` 停采样（幂等）。

    生命周期由调用方掌握（node 返回的也是 ``stop`` 函数）：spawn 之后起、
    退出之前停。``on_exceed`` 的幂等由**看门狗自身**保证（首次超限即停机），
    调用方的 settled 守卫是第二道——node 只靠调用方，这里更严一档，代价是
    零（不会双杀，也不会漏杀）。
    """

    def __init__(
        self,
        pid: int,
        limit_mb: int,
        *,
        interval_ms: int,
        on_exceed: Callable[[], Any],
        sampler: MemorySampler,
    ) -> None:
        self.pid = pid
        self.limit_mb = limit_mb
        self.interval_ms = interval_ms
        self._limit_bytes = limit_mb * 1024 * 1024
        self._on_exceed = on_exceed
        self._sampler = sampler
        self._stopped = False
        self._task: Optional[asyncio.Task] = None

    @property
    def stopped(self) -> bool:
        return self._stopped

    def start(self) -> 'MemoryWatchdog':
        """在当前事件循环上起采样任务。无事件循环时降级 no-op（不抛）。"""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # 契约：看门狗是尽力而为的护栏，绝不为"起不来"打断任务。
            logger.warning(
                'memory watchdog requested outside an event loop (pid=%s); '
                'RSS tree sampling disabled for this task',
                self.pid,
            )
            self._stopped = True
            return self
        self._task = loop.create_task(self._run())
        return self

    def stop(self) -> None:
        """停采样。幂等；也可在 ``on_exceed`` 内部安全调用。"""
        self._stopped = True
        task = self._task
        if task is None or task.done():
            return
        if task is asyncio.current_task():
            # 在 on_exceed 回调里调 stop()：不能取消自己（会在 await 点把回调
            # 拦腰打断），让 _run 自然 return 即可。
            return
        task.cancel()

    async def _run(self) -> None:
        # setInterval 语义：第一次采样发生在**一个间隔之后**，不是立刻
        # （node 用 setInterval，两侧"起步那一秒"的账本因此一致）。
        while not self._stopped:
            await asyncio.sleep(self.interval_ms / 1000)
            if self._stopped:
                return
            try:
                rss = self._sampler.sample_rss_bytes(self.pid)
            except Exception as exc:
                # 进程已退出 / 采样竞态：静默跳过，交给其它路径终态化。
                logger.debug('memory watchdog sample failed (pid=%s): %s', self.pid, exc)
                continue
            # 严格大于（node `rss > limitBytes` 同款）：恰好等于上限不触发。
            if rss <= self._limit_bytes:
                continue
            # 先停机再回调：on_exceed **恰好一次**由结构保证，而不是靠调用方
            # 记得 stop（node 靠调用方，这里加一层）。
            self._stopped = True
            logger.warning(
                'task process tree RSS %d bytes > limit %d MB (pid=%s); '
                'invoking memory-limit callback',
                rss, self.limit_mb, self.pid,
            )
            try:
                result = self._on_exceed()
                if inspect.isawaitable(result):
                    await result
            except Exception as exc:
                logger.warning(
                    'memory watchdog on_exceed callback failed (pid=%s): %s',
                    self.pid, exc,
                )
            return


def start_memory_watchdog(
    pid: int,
    limit_mb: int,
    *,
    interval_ms: int = DEFAULT_INTERVAL_MS,
    on_exceed: Callable[[], Any],
    sampler: Optional[MemorySampler] = None,
) -> MemoryWatchdog:
    """起看门狗：每 ``interval_ms`` 采样一次，树 RSS > ``limit_mb`` 触发回调。

    ``sampler`` 缺省为 ``linux_proc_tree_sampler``（模块属性**调用时**查找，
    测试可 monkeypatch）。返回值持句柄，调用方负责 ``stop()``。

    ``limit_mb <= 0`` **不**在这里短路——node 侧同样把「0 = 关闭」的判定留给
    调用方（``config.taskMemoryLimitMb > 0``），两侧守卫位置一致才不会出现
    「换端口后语义分叉」。``interval_ms`` 钳到 ``MIN_INTERVAL_MS``（见常量
    注释）。``interval_ms=None`` 走默认值（对齐 node ``?? 2000``）。
    """
    effective_sampler = sampler if sampler is not None else linux_proc_tree_sampler
    raw_interval = DEFAULT_INTERVAL_MS if interval_ms is None else int(interval_ms)
    effective_interval = max(MIN_INTERVAL_MS, raw_interval)
    if effective_interval != raw_interval:
        logger.warning(
            'TASK_MEMORY_WATCHDOG_INTERVAL_MS=%s is below the %dms floor; '
            'clamping (asyncio sleep(0) would starve the event loop)',
            raw_interval, MIN_INTERVAL_MS,
        )
    return MemoryWatchdog(
        pid,
        limit_mb,
        interval_ms=effective_interval,
        on_exceed=on_exceed,
        sampler=effective_sampler,
    ).start()
