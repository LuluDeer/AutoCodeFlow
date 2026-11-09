"""H-4b：跨进程文件锁（flock）的**真·跨进程**用例。

## 为什么必须起真进程

``threading.Lock`` / ``asyncio.Lock`` 的测试**永远绿**——它们只测进程内互斥，
而 H-4b 的缺陷恰恰是「进程内锁当跨进程锁用」。本文件的每条互斥用例都
``multiprocessing``/``subprocess`` 起**独立进程**（独立解释器实例、独立
fd 表、独立 GIL），断言：

* 同机两进程对同一把锁**互斥**（后者必须等前者释放）；
* **SIGKILL 持有者后锁自动释放**（flock 的内核级性质；这是 flock 优于
  「pid 文件 + TTL 软锁」的核心证据，必须是**真 SIGKILL** 用例）；
* 不同键的锁**不**互相阻塞（粒度正确，避免过度串行）。

## 为什么不用 `multiprocessing.Process` 直接跑 lambda

``spawn`` 起点下子进程要 import 主模块，lambda/闭包不可 pickle。本仓测试跑在
Linux（``fork``）但也在 Windows 上被引用（``e2e-full-windows``），为了让用例
两端都能跑，子进程体一律用**模块级函数**（picklable）。
"""

from __future__ import annotations

import multiprocessing
import os
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import errno
import pytest

# 让子进程能 import `lib.file_lock`（pytest 的 rootdir 是 apps/executor-python）。
_APP_DIR = Path(__file__).resolve().parents[1]
if str(_APP_DIR) not in sys.path:
    sys.path.insert(0, str(_APP_DIR))

from lib import file_lock  # noqa: E402


# ---------------------------------------------------------------------------
# 辅助：在子进程里持有锁 N 秒
# ---------------------------------------------------------------------------

def _hold_lock(path_str: str, ready_path: str, hold_seconds: float) -> None:
    """子进程体：拿到锁后写 ready 文件，再持有一会儿（模块级 ⇒ 可 pickle）。"""
    with file_lock.file_lock(Path(path_str), timeout=30):
        Path(ready_path).write_text('locked', encoding='utf-8')
        time.sleep(hold_seconds)


def _try_lock(path_str: str, result_path: str, timeout: float) -> None:
    """子进程体：试着在 ``timeout`` 内拿锁，把结果写进文件。"""
    try:
        with file_lock.file_lock(Path(path_str), timeout=timeout):
            Path(result_path).write_text('acquired', encoding='utf-8')
            time.sleep(0.2)
    except file_lock.FileLockTimeout:
        Path(result_path).write_text('timeout', encoding='utf-8')


def _wait_for(predicate, timeout=10.0, interval=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


# ---------------------------------------------------------------------------
# 上下文：优先 fork（快、确定），不可用时退回 spawn
# ---------------------------------------------------------------------------

def _mp_context():
    methods = multiprocessing.get_all_start_methods()
    for name in ('fork', 'forkserver', 'spawn'):
        if name in methods:
            return multiprocessing.get_context(name)
    return multiprocessing.get_context()


# ---------------------------------------------------------------------------
# 用例
# ---------------------------------------------------------------------------

def test_backend_is_kernel_release_on_this_platform():
    """本机必须有**内核级**后端（POSIX flock / Windows msvcrt），不是降级软锁。

    降级后端（atomic）在 SIGKILL 后残留锁文件 ⇒ 只能靠 TTL 清扫。若本机落到
    降级档，后面那条 SIGKILL 用例的语义就不再等价，必须先红。
    """
    assert file_lock.backend() in ('flock', 'msvcrt'), (
        f'本机锁后端退化为 {file_lock.backend()!r}（软锁）——'
        '进程被 SIGKILL 会残留锁文件，跨进程互斥不再自动恢复'
    )
    assert file_lock.supports_kernel_release() is True


def test_backend_is_not_flock_on_windows():
    """**语义差异的显式留痕**：Windows 走 msvcrt 字节锁，与 POSIX flock 不等价。

    这条用例在 POSIX 上只是记录事实（不判红）；在 Windows 上它钉住「我们
    没有假装两侧等价」——后端必须是 msvcrt，而不是某个声称是 flock 的东西。
    """
    if sys.platform == 'win32':
        assert file_lock.backend() == 'msvcrt'
    else:
        assert file_lock.backend() == 'flock'


def test_cross_process_mutual_exclusion(tmp_path):
    """**真跨进程互斥**：A 持锁期间，B 必须拿不到。

    进程内锁在这里毫无作用（两个独立进程）⇒ 这条用例只有 flock 能过。
    """
    lock_path = tmp_path / 'mutex.lock'
    ready_a = tmp_path / 'a.ready'
    result_b = tmp_path / 'b.result'

    ctx = _mp_context()
    holder = ctx.Process(target=_hold_lock, args=(str(lock_path), str(ready_a), 2.0))
    holder.start()
    try:
        assert _wait_for(ready_a.exists), '子进程 A 没能在 10s 内拿到锁'
        # B 只有 0.8s 预算，而 A 还要持有约 2s ⇒ 必须超时
        waiter = ctx.Process(target=_try_lock, args=(str(lock_path), str(result_b), 0.8))
        waiter.start()
        waiter.join(timeout=30)
        assert result_b.read_text(encoding='utf-8') == 'timeout', (
            'B 在 A 持锁期间拿到了锁 —— 跨进程互斥失效')
    finally:
        holder.join(timeout=30)
        if holder.is_alive():  # pragma: no cover - 兜底
            holder.terminate()
        if 'waiter' in locals() and waiter.is_alive():  # pragma: no cover
            waiter.terminate()


def test_cross_process_lock_available_after_release(tmp_path):
    """A 释放后 B 必须**立刻**能拿到（锁真的被释放了，不是靠超时兜过来的）。"""
    lock_path = tmp_path / 'release.lock'
    ready_a = tmp_path / 'a.ready'

    ctx = _mp_context()
    holder = ctx.Process(target=_hold_lock, args=(str(lock_path), str(ready_a), 0.3))
    holder.start()
    holder.join(timeout=30)
    assert not holder.is_alive()

    # A 已退出 ⇒ 锁必然已释放（进程退出 ⇒ fd 关闭 ⇒ flock 释放）
    with file_lock.file_lock(lock_path, timeout=5):
        pass


def test_sigkill_releases_lock(tmp_path):
    """**SIGKILL 释放锁**：这是 flock 优于软锁的核心证据（必须有真 SIGKILL）。

    软锁（写 pid 文件）被 SIGKILL 后锁文件残留 ⇒ 必须等 TTL 清扫，期间所有
    实例都被挡住。flock 是内核级：进程死了 fd 就关，锁立刻释放。

    实现：起一个**真子进程**（subprocess，不是 multiprocessing —— 需要对
    pid 发真实信号），它拿锁后打印 ready 并睡去；父进程读到 ready 后
    ``SIGKILL`` 它，然后断言父进程能**立刻**拿到锁（不等 TTL）。
    """
    if sys.platform == 'win32':
        pytest.skip('SIGKILL 是 POSIX 信号；Windows 的等价能力见下方 msvcrt 说明')

    lock_path = tmp_path / 'sigkill.lock'
    holder_script = textwrap.dedent(
        f'''
        import sys, time
        from pathlib import Path
        sys.path.insert(0, {str(_APP_DIR)!r})
        from lib import file_lock
        with file_lock.file_lock(Path({str(lock_path)!r}), timeout=30):
            print('READY', flush=True)
            time.sleep(120)
        '''
    )
    proc = subprocess.Popen(
        [sys.executable, '-c', holder_script],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    # 此时锁在子进程手里。父进程拿不到（确认互斥成立）——**必须**给短超时，
    # 否则默认 600s 会把用例挂死。
    try:
        line = proc.stdout.readline()
        assert line.strip() == 'READY', f'子进程未能拿锁（stdout={line!r}）'
        with pytest.raises(file_lock.FileLockTimeout):
            with file_lock.file_lock(lock_path, timeout=0.2):
                pass
    finally:
        # **真 SIGKILL**：不可捕获、不可清理 ⇒ 只有内核能释放锁
        os.kill(proc.pid, signal.SIGKILL)
        proc.wait(timeout=10)
        # 显式关管道：否则 pytest 的 ResourceWarning(strict) 会把这条用例判红
        # （`filterwarnings = error`，见 pytest.ini）。
        for stream in (proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass

    # 立刻（不等待 TTL）拿锁 —— 这就是「内核自动释放」的证据
    started = time.monotonic()
    with file_lock.file_lock(lock_path, timeout=10):
        elapsed = time.monotonic() - started
    assert elapsed < 5.0, (
        f'SIGKILL 后等了 {elapsed:.1f}s 才拿到锁 —— 锁没有随进程退出立即释放')


def test_sigkill_release_is_not_ttl_based(tmp_path):
    """反证：SIGKILL 后的释放**不是**靠 TTL（降级后端才需要 TTL）。

    本机后端是内核级的 ⇒ ``supports_kernel_release()`` 必须为 True，
    且锁文件 mtime **不**参与释放判定（flock 不读 mtime）。
    """
    if sys.platform == 'win32':
        pytest.skip('SIGKILL 是 POSIX 信号')
    assert file_lock.supports_kernel_release() is True
    # 降级后端才有这个 TTL 常量语义；内核级后端不该依赖它
    assert hasattr(file_lock, '_STALE_ATOMIC_LOCK_SECONDS')


def test_distinct_keys_do_not_block(tmp_path):
    """不同键的两把锁互不阻塞（粒度正确 ⇒ 不会把无关资源串行化）。"""
    lock_a = tmp_path / file_lock.lock_file_name(file_lock.git_lock_key('repo-a'))
    lock_b = tmp_path / file_lock.lock_file_name(file_lock.git_lock_key('repo-b'))
    lock_a.parent.mkdir(parents=True, exist_ok=True)

    with file_lock.file_lock(lock_a, timeout=5):
        # 持有 a 的同时必须能拿到 b
        with file_lock.file_lock(lock_b, timeout=1):
            pass


def test_same_key_blocks_across_threads(tmp_path):
    """同一把锁在**同进程不同 fd** 上也互斥（POSIX flock 的 fd 粒度语义）。

    这条是 POSIX 的实测性质（见模块头注「同一进程的另一个 fd 会冲突」）；
    Windows 的 msvcrt 在同进程两个句柄上**不冲突** ⇒ 该平台跳过。
    """
    if sys.platform == 'win32':
        pytest.skip('msvcrt 字节锁在同一进程两个句柄上不冲突（语义差异，已如实记录）')

    lock_path = tmp_path / 'fd-granularity.lock'
    with file_lock.file_lock(lock_path, timeout=5):
        with pytest.raises(file_lock.FileLockTimeout):
            with file_lock.file_lock(lock_path, timeout=0.1):
                pass


def test_lock_file_is_reusable_after_exception(tmp_path):
    """临界区抛异常也必须释放锁（contextmanager 的 finally 语义）。"""
    lock_path = tmp_path / 'exc.lock'
    with pytest.raises(ValueError):
        with file_lock.file_lock(lock_path, timeout=5):
            raise ValueError('boom')
    # 未释放的话这里会超时
    with file_lock.file_lock(lock_path, timeout=5):
        pass


def test_lock_file_name_is_sanitized():
    """锁键里的路径分隔符/冒号等会被替换（锁文件不能逃出锁目录）。"""
    name = file_lock.lock_file_name(file_lock.pkg_lock_key('https://example.com/a/b.zip'))
    assert '/' not in name and ':' not in name
    assert '\\' not in name
    assert name.startswith(file_lock.LOCK_FILE_PREFIX)
    assert name.endswith(file_lock.LOCK_SUFFIX)


def test_non_ascii_key_is_replaced_not_kept():
    """**ASCII 白名单**：非 ASCII 字符必须被替换。

    这是两端命名一致性的关键坑：python 的 ``str.isalnum()`` 对 ``'中'``
    返回 True，而 JS 的白名单会替换它 ⇒ 若这里用 isalnum，两端会算出
    **不同的文件名** ⇒ 跨端互斥失效。
    """
    name = file_lock.lock_file_name('中' + file_lock.GIT_LOCK_KEY_PREFIX + 'repo')
    assert '中' not in name
    assert '_' in name


def test_lock_file_name_matches_node_naming_contract():
    """锁文件名格式与 node 侧 ``sharedCacheLockName`` 的契约一致。

    契约（`scripts/check-shared-cache-lock.mjs` 逐字核对两端常量）：
    ``<LOCK_FILE_PREFIX><sanitized-key><LOCK_SUFFIX>``。
    """
    assert file_lock.LOCK_FILE_PREFIX == '.acf-'
    assert file_lock.LOCK_SUFFIX == '.lock'
    assert file_lock.CACHE_LOCK_DIR_NAME == '.cache-locks'
    assert file_lock.SAFE_CHARS == 'A-Za-z0-9._-'
    assert file_lock.lock_file_name('abc') == '.acf-abc.lock'


def test_git_pkg_interp_keys_have_distinct_prefixes():
    """三类资源的锁键前缀互不相同（否则不同资源会撞同一把锁）。"""
    keys = [
        file_lock.git_lock_key('x'),
        file_lock.pkg_lock_key('x'),
        file_lock.interpreter_lock_key('3.11', 'linux-x86_64-gnu'),
    ]
    prefixes = [k.split('-')[0] for k in keys]
    assert len(set(prefixes)) == 3, f'锁键前缀有重复：{prefixes}'


def test_interpreter_lock_key_includes_platform():
    """解释器锁键含平台段：共享卷里不同平台互不等待。

    平台判定不出（None）时用 ``any`` 兜底，仍能算出确定的键。
    """
    a = file_lock.interpreter_lock_key('3.11', 'linux-x86_64-gnu')
    b = file_lock.interpreter_lock_key('3.11', 'linux-x86_64-musl')
    assert a != b
    assert file_lock.interpreter_lock_key('3.11', None).endswith('-any')


# ---------------------------------------------------------------------------
# 降级后端（atomic）——**如实覆盖**：本仓不会走到它，但代码路径必须可用，
# 且语义差异（SIGKILL 后残留 ⇒ 只能靠 TTL 清扫）必须被钉住。
# ---------------------------------------------------------------------------

def test_atomic_backend_mutual_exclusion(tmp_path, monkeypatch):
    """降级后端也提供跨进程互斥（原子创建 + 存在即跳过）。"""
    monkeypatch.setattr(file_lock, '_HAVE_FCNTL', False)
    monkeypatch.setattr(file_lock, '_HAVE_MSVCRT', False)
    assert file_lock.backend() == 'atomic'
    # 降级后端**没有**内核级释放 ⇒ 必须如实报告
    assert file_lock.supports_kernel_release() is False

    lock_path = tmp_path / 'atomic.lock'
    with file_lock.file_lock(lock_path, timeout=5):
        assert lock_path.exists()
        # 同进程另一次获取必须冲突（O_EXCL 语义）
        with pytest.raises(file_lock.FileLockTimeout):
            with file_lock.file_lock(lock_path, timeout=0.2):
                pass
    # 释放后锁文件被清掉
    assert not lock_path.exists()


def test_atomic_backend_reaps_stale_lock(tmp_path, monkeypatch):
    """降级后端靠 **TTL** 清扫残留锁文件（软锁的弱点，如实钉住）。

    这正是 flock 优于软锁的地方：进程被 SIGKILL 后，软锁的锁文件**残留**，
    必须等 TTL 才恢复；flock 的内核级释放是**立刻**的。
    """
    monkeypatch.setattr(file_lock, '_HAVE_FCNTL', False)
    monkeypatch.setattr(file_lock, '_HAVE_MSVCRT', False)

    lock_path = tmp_path / 'stale.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text('stale', encoding='utf-8')
    # 把 mtime 拨到很久以前 ⇒ 视为「持有者已死」
    old = time.time() - file_lock._STALE_ATOMIC_LOCK_SECONDS - 60
    os.utime(lock_path, (old, old))

    with file_lock.file_lock(lock_path, timeout=5):
        pass  # 能拿到 ⇒ 残留锁被清扫了


def test_atomic_backend_does_not_reap_fresh_lock(tmp_path, monkeypatch):
    """**反证**：新鲜的残留锁**不会**被清扫（否则两个进程会同时进临界区）。"""
    monkeypatch.setattr(file_lock, '_HAVE_FCNTL', False)
    monkeypatch.setattr(file_lock, '_HAVE_MSVCRT', False)

    lock_path = tmp_path / 'fresh.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text('held', encoding='utf-8')  # mtime = now

    with pytest.raises(file_lock.FileLockTimeout):
        with file_lock.file_lock(lock_path, timeout=0.3):
            pass


def test_async_acquire_release_roundtrip(tmp_path):
    """``acquire_file_lock_async`` 的加锁/释放往返（pkg_cache 走的就是它）。"""
    import asyncio

    lock_path = tmp_path / 'async.lock'

    async def scenario():
        holder = await file_lock.acquire_file_lock_async(lock_path, timeout=5)
        try:
            # 持锁期间，另一路径拿不到
            holder2_task = asyncio.create_task(
                file_lock.acquire_file_lock_async(lock_path, timeout=0.2))
            with pytest.raises(file_lock.FileLockTimeout):
                await holder2_task
        finally:
            holder.release()
        # 释放后能拿到
        h2 = await file_lock.acquire_file_lock_async(lock_path, timeout=2)
        h2.release()

    asyncio.run(scenario())


def test_async_acquire_does_not_block_event_loop(tmp_path):
    """加锁等待期间**事件循环仍在推进**（这是它对 pkg_cache 的全部价值）。

    反证：若实现是在事件循环线程里阻塞等 flock，这里的 ticker 计数会停在 0。
    """
    import asyncio

    lock_path = tmp_path / 'busy.lock'

    async def scenario():
        # 先在后台线程里长期持锁
        import threading
        release_evt = threading.Event()

        def hold():
            with file_lock.file_lock(lock_path, timeout=10):
                release_evt.wait(5)

        t = threading.Thread(target=hold, daemon=True)
        t.start()
        # 等它真的拿到锁
        for _ in range(200):
            await asyncio.sleep(0.01)
            try:
                with file_lock.file_lock(lock_path, timeout=0.0):
                    pass
            except (file_lock.FileLockTimeout, Exception):
                break

        ticks = 0

        async def ticker():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.01)
                ticks += 1

        tick_task = asyncio.create_task(ticker())
        try:
            with pytest.raises(file_lock.FileLockTimeout):
                await file_lock.acquire_file_lock_async(lock_path, timeout=0.3)
        finally:
            tick_task.cancel()
            release_evt.set()
            with pytest.raises(asyncio.CancelledError):
                await tick_task
        assert ticks >= 5, f'事件循环在等锁期间停摆了（只推进了 {ticks} 次）'

    asyncio.run(scenario())


def test_async_acquire_propagates_timeout(tmp_path):
    """异步获取超时也必须抛 ``FileLockTimeout``（异常类型与同步路径一致）。"""
    import asyncio

    lock_path = tmp_path / 'async-timeout.lock'
    with file_lock.file_lock(lock_path, timeout=5):
        async def scenario():
            with pytest.raises(file_lock.FileLockTimeout):
                await file_lock.acquire_file_lock_async(lock_path, timeout=0.2)
        asyncio.run(scenario())


def test_make_lock_dispatch(monkeypatch, tmp_path):
    """``_make_lock`` 按后端分派到实现类（三档都要有映射）。"""
    monkeypatch.setattr(file_lock, '_HAVE_FCNTL', True)
    assert file_lock._make_lock(tmp_path / 'a', 1, 0.05).backend_name == 'flock'
    monkeypatch.setattr(file_lock, '_HAVE_FCNTL', False)
    monkeypatch.setattr(file_lock, '_HAVE_MSVCRT', True)
    assert file_lock._make_lock(tmp_path / 'a', 1, 0.05).backend_name == 'msvcrt'
    monkeypatch.setattr(file_lock, '_HAVE_MSVCRT', False)
    assert file_lock._make_lock(tmp_path / 'a', 1, 0.05).backend_name == 'atomic'


def test_file_lock_for_key_helper(tmp_path):
    """``file_lock_for_key`` 用键派生文件名（键 ⇒ 文件名的唯一入口）。"""
    with file_lock.file_lock_for_key(tmp_path, 'my-key'):
        expected = tmp_path / file_lock.lock_file_name('my-key')
        assert expected.exists()


def test_lock_error_when_path_unopenable(tmp_path):
    """锁文件不可创建时抛 ``FileLockError``（而不是静默降级成「没锁」）。"""
    if sys.platform == 'win32':
        pytest.skip('POSIX 权限语义；Windows 上目录权限模型不同')
    blocked = tmp_path / 'blocked'
    blocked.mkdir()
    os.chmod(blocked, 0o500)  # r-x：不可写
    try:
        with pytest.raises(file_lock.FileLockError):
            with file_lock.file_lock(blocked / 'x.lock', timeout=1):
                pass
    finally:
        os.chmod(blocked, 0o700)


def test_async_acquire_cancellation_does_not_leak_lock(tmp_path):
    """**取消路径不泄漏锁**：等待被取消时，工作线程稍后拿到的锁必须被释放。

    这是异步加锁最危险的形态：``await settled.wait()`` 被取消后，工作线程可能
    **之后**才拿到 flock ⇒ 若没人释放，这把锁会挂到**进程退出**为止（其它实例
    永久阻塞）。实现把清理交给后台线程（``_release_after_join``），本用例钉住它。
    """
    import asyncio
    import threading

    lock_path = tmp_path / 'cancel-leak.lock'

    async def scenario():
        release_evt = threading.Event()

        def holder():
            with file_lock.file_lock(lock_path, timeout=10):
                release_evt.wait(10)

        t = threading.Thread(target=holder, daemon=True)
        t.start()
        # 等 holder 真的拿到锁
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            await asyncio.sleep(0.01)
            try:
                with file_lock.file_lock(lock_path, timeout=0.0):
                    continue
            except Exception:
                break

        # 发起一个会**阻塞等待**的异步获取，然后取消它
        task = asyncio.create_task(
            file_lock.acquire_file_lock_async(lock_path, timeout=30))
        await asyncio.sleep(0.15)  # 让它进入等待
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        # 放行 holder ⇒ 它释放锁 ⇒ 被取消的工作线程随后拿到锁并应立即释放
        release_evt.set()
        await asyncio.sleep(0.6)  # 给后台清理线程时间

    asyncio.run(scenario())

    # 关键断言：现在必须能**立刻**拿到锁（没被泄漏）
    started = time.monotonic()
    with file_lock.file_lock(lock_path, timeout=5):
        pass
    assert time.monotonic() - started < 3.0


def test_async_acquire_worker_exception_propagates(tmp_path, monkeypatch):
    """工作线程里的异常必须**原样上抛**给等待方（不吞成「拿不到锁」）。"""
    import asyncio

    lock_path = tmp_path / 'boom.lock'

    def boom(*a, **k):
        raise file_lock.FileLockError('simulated')

    monkeypatch.setattr(file_lock, '_make_lock', boom)

    async def scenario():
        with pytest.raises(file_lock.FileLockError):
            await file_lock.acquire_file_lock_async(lock_path, timeout=1)

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Windows 后端（msvcrt）—— **用桩在 Linux 上验逻辑**
#
# 本机没有 Windows，但 Windows 代码路径必须被验证过（不能只「写完就交」）。
# 用桩模块注入 msvcrt 的语义：LK_NBLCK 在区间已被别的「句柄」持有时抛 OSError，
# LK_UNLCK 释放。桩只模拟**我们依赖的那部分契约**，用于验证：
#   · 重试 + 超时；
#   · 释放时先 seek(0) 再 unlock（msvcrt.locking 从当前位置开始锁）；
#   · 打开时写 1 字节占位（0 长文件上锁的行为在 Windows 上不可靠）。
# ⚠ 这**不能**替代 Windows 真机验证 —— 语义差异已在模块头注与报告里如实说明。
# ---------------------------------------------------------------------------

class _FakeMsvcrt:
    """极简 msvcrt 桩：按 fd 记录被锁的字节区间。"""

    LK_UNLCK = 0
    LK_NBLCK = 2

    def __init__(self):
        self.locked_fds = {}   # fd -> 是否已锁
        self.calls = []

    def locking(self, fd, mode, nbytes):
        self.calls.append((fd, mode, nbytes))
        if mode == self.LK_NBLCK:
            if self.locked_fds.get(fd):
                raise OSError(13, 'Permission denied')  # 已被占
            self.locked_fds[fd] = True
        elif mode == self.LK_UNLCK:
            self.locked_fds[fd] = False


def test_msvcrt_backend_acquire_and_release(tmp_path, monkeypatch):
    """Windows 后端能加锁/解锁，且**先 seek(0)** 再 unlock。"""
    fake = _FakeMsvcrt()
    monkeypatch.setattr(file_lock, 'msvcrt', fake)
    monkeypatch.setattr(file_lock, '_HAVE_FCNTL', False)
    monkeypatch.setattr(file_lock, '_HAVE_MSVCRT', True)
    assert file_lock.backend() == 'msvcrt'

    lock = file_lock._make_lock(tmp_path / 'win.lock', timeout=2, poll_interval=0.01)
    lock.acquire()
    try:
        assert any(mode == fake.LK_NBLCK for _fd, mode, _n in fake.calls)
    finally:
        lock.release()
    assert any(mode == fake.LK_UNLCK for _fd, mode, _n in fake.calls), (
        '释放时必须调用 LK_UNLCK（否则锁随句柄一直挂着）')


def test_msvcrt_backend_lock_file_has_one_byte(tmp_path, monkeypatch):
    """Windows 后端打开锁文件时写 1 字节占位（0 长文件上的字节锁不可靠）。"""
    fake = _FakeMsvcrt()
    monkeypatch.setattr(file_lock, 'msvcrt', fake)
    monkeypatch.setattr(file_lock, '_HAVE_FCNTL', False)
    monkeypatch.setattr(file_lock, '_HAVE_MSVCRT', True)

    lock_path = tmp_path / 'win-byte.lock'
    with file_lock.file_lock(lock_path, timeout=2):
        assert lock_path.stat().st_size >= 1, '锁文件必须至少 1 字节（供字节区间锁）'


def test_msvcrt_backend_timeout_raises(tmp_path, monkeypatch):
    """Windows 后端在区间被占满超时窗口后抛 ``FileLockTimeout``。"""
    fake = _FakeMsvcrt()
    # 预先把任意 fd 都标记为已锁 ⇒ 永远拿不到
    class _AlwaysLocked(_FakeMsvcrt):
        def locking(self, fd, mode, nbytes):
            if mode == self.LK_NBLCK:
                raise OSError(13, 'Permission denied')
            return super().locking(fd, mode, nbytes)

    monkeypatch.setattr(file_lock, 'msvcrt', _AlwaysLocked())
    monkeypatch.setattr(file_lock, '_HAVE_FCNTL', False)
    monkeypatch.setattr(file_lock, '_HAVE_MSVCRT', True)

    with pytest.raises(file_lock.FileLockTimeout):
        with file_lock.file_lock(tmp_path / 'busy-win.lock', timeout=0.15,
                                 poll_interval=0.01):
            pass


def test_msvcrt_backend_supports_kernel_release(tmp_path, monkeypatch):
    """Windows 后端在「进程退出释放锁」这一点上与 POSIX **结果一致**。

    如实记录差异：msvcrt 是**字节区间强制锁**、同进程两句柄不冲突；但
    「进程被杀 ⇒ 句柄被系统关闭 ⇒ 锁释放」这条与 flock 等价。
    """
    monkeypatch.setattr(file_lock, '_HAVE_FCNTL', False)
    monkeypatch.setattr(file_lock, '_HAVE_MSVCRT', True)
    assert file_lock.backend() == 'msvcrt'
    assert file_lock.supports_kernel_release() is True


# ---------------------------------------------------------------------------
# POSIX 后端（flock）的错误路径
# ---------------------------------------------------------------------------

def test_flock_backend_error_on_unopenable_path(tmp_path):
    """锁文件打不开 ⇒ ``FileLockError``（不是静默「没锁」）。"""
    if sys.platform == 'win32':
        pytest.skip('POSIX 权限语义')
    blocked = tmp_path / 'no-write'
    blocked.mkdir()
    os.chmod(blocked, 0o500)
    try:
        with pytest.raises(file_lock.FileLockError):
            with file_lock.file_lock(blocked / 'x.lock', timeout=1):
                pass
    finally:
        os.chmod(blocked, 0o700)


def test_flock_backend_unexpected_errno_becomes_error(tmp_path, monkeypatch):
    """flock 抛非「已被占用」类 errno ⇒ ``FileLockError``（不吞成超时）。

    区分这两类很重要：EAGAIN/EACCES 是「等一等就好了」，其它 errno 是
    「机制坏了」——后者必须立刻上抛，否则会变成「等 600s 然后报超时」的
    假象。
    """
    real_flock = file_lock.fcntl.flock

    def boom(fd, op):
        raise OSError(errno.EINVAL, 'invalid argument')

    monkeypatch.setattr(file_lock.fcntl, 'flock', boom)
    try:
        with pytest.raises(file_lock.FileLockError):
            with file_lock.file_lock(tmp_path / 'bad.lock', timeout=1):
                pass
    finally:
        monkeypatch.setattr(file_lock.fcntl, 'flock', real_flock)


def test_release_is_idempotent(tmp_path):
    """重复 ``release()`` 不抛（幂等；清理路径会重复调）。"""
    lock = file_lock._make_lock(tmp_path / 'idem.lock', timeout=2, poll_interval=0.01)
    lock.acquire()
    lock.release()
    lock.release()  # 不抛
