"""
跨进程文件锁（H-4b）。

## 为什么需要它

python 执行器原有 20+ 处**进程内**锁（``threading.Lock`` / ``asyncio.Lock``），
其中 3 处保护的是**同机同一目录**下的共享资源。进程内锁在**跨实例**时形同虚设：
同机两个执行器进程共享同一个 ``WORK_DIR``（``scripts/install.sh:35``
``WORK_DIR="/var/lib/autoflow/tasks"`` —— **无实例维度**），而：

* git 缓存（``.git_cache/<repo>``）：两个实例同时 ``git clone --bare`` 写同一目录 ⇒
  缓存损坏；更糟的是 B 实例会把 A **正在使用的完好缓存**误判为损坏并
  ``_quarantine_broken_cache`` 隔离掉（补救变破坏源）；
* 解释器池（``UV_PYTHON_INSTALL_DIR``）：两个实例同时 ``uv python install`` 写同一
  平台目录 ⇒ 池条目半写；
* pkg 缓存（``.pkg-cache/<sha256(url)>.zip``）：两个实例同时下载同一 URL ⇒
  ``.part`` 文件互踩 ⇒ 发布的 zip 字节损坏。

## 为什么用 flock 而不是 Redis / DB advisory lock

* ``apps/executor-python/requirements.txt`` 只有 8 项依赖，**无 Redis、无 DB**；
  执行器**不直连数据库**。
* 离线私有化部署**没有 Redis**（见
  ``docs/design/python-task-upload-and-multiversion/OFFLINE-PROVISIONING.md``）。
* admin-api 的 ``LeaderGateService`` / ``RedisLockService`` / outbox lease
  **不可复用**：它们是 TS + Redis + admin-api 进程内状态。
* **D-6 已裁决**：executor-python 不允许新增 PyPI 依赖（离线私有化要求零外部依赖）
  ⇒ 本模块**自写**，只用标准库。

## 平台语义差异（如实说明，不假装两侧等价）

**POSIX（Linux/macOS）—— 真互斥**：
``fcntl.flock(fd, LOCK_EX)`` 是**内核级**的 advisory 锁：

* 进程被 ``SIGKILL`` 时，**内核自动释放**（文件描述符随进程关闭而关闭 ⇒ flock 释放）
  ⇒ **不存在死锁残留**。这是 flock 优于「软锁」（写 pid 文件 + TTL 清扫）的核心优势。
* 同一进程的**另一个文件描述符**对同一文件加锁会**冲突**（实测：``BlockingIOError``）
  ⇒ flock 的粒度是「打开的文件描述符」，不是「进程」。

**Windows —— best-effort 降级（如实）**：
``fcntl`` 在 Windows **不存在**；``msvcrt.locking`` 的语义与 flock **不等价**：

* 它锁的是**字节区间**（默认 1 字节），不是整个文件；
* 它的锁是**强制锁**（mandatory lock），读写的字节区间被别的进程访问会失败；
* 锁随**文件句柄关闭**释放 ⇒ 进程被杀（TerminateProcess）时句柄被系统关闭 ⇒
  锁同样释放（**结果**上与 flock 的「内核自动释放」一致）；
* 唯一性判定（``LK_NBLCK``）在**同一进程**的两个句柄上**不冲突**（与 POSIX 不同）
  ⇒ 进程内仍需叠加一层 ``threading.Lock``（调用侧已保留进程内锁）。

因此 Windows 侧走 ``msvcrt`` 字节锁，**与 POSIX 的 flock 不等价**（强制锁 +
字节区间）。本模块对两种后端都提供 ``backend()`` 供调用方与测试断言。

**第三档（永不启用）**：``fcntl`` 与 ``msvcrt`` 都不可用时退化为「原子创建锁文件 +
存在即跳过 + TTL 清扫」的 best-effort 语义——此时**进程被 SIGKILL 会残留锁文件**，
必须靠 TTL 清扫恢复（``supports_kernel_release()`` 为 False）。

## 锁文件放在哪（关键约束）

**锁必须与它保护的资源同处一个「必然被共享」的位置**：

* git / pkg 缓存锁 → ``<work_dir>/.cache-locks/``
  （``.git_cache`` 与 ``.pkg-cache`` 都在 ``<work_dir>`` 下 ⇒ 同实例必然共享；
  ``.cache-locks`` **必须**登记进两端的工作目录保护名单，否则 TTL 清扫会在
  持有者还在持锁时把锁文件删掉 ⇒ 新进程会创建一个**新 inode** ⇒ 互斥失效。
  python 侧：``maintenance._PROTECTED_WORKDIR_NAMES``；
  node 侧：``file-logger.PROTECTED_WORKDIR_NAMES``。
* 解释器池锁 → **池目录内**（``<UV_PYTHON_INSTALL_DIR>/.acf-interp-…lock``）。
  池是**独立卷**（compose 的 ``interpreter_cache:/data/interpreters``），**可能**
  与 ``work_dir`` 不共享 ⇒ 锁必须与资源同处。池内散落文件对两端都无害
  （uv 的探测只认 ``cpython-*`` 目录；python 的 ``_scan_pool_directory`` /
  ``_pool_version_entries`` 只收**目录**）——实测 uv 容忍池根下的无关文件。

## 分层守卫

``lib/`` **不得** import ``routers/``（仓内既有分层守卫范式：
``apps/executor-python/tests/test_interpreters.py`` 的
``test_module_never_imports_routers_execute``）。本模块只依赖标准库。
"""

from __future__ import annotations

import asyncio
import errno
import logging
import os
import string
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 锁命名规则（python / node 双端**逐字一致** —— 见 scripts/check-shared-cache-lock.mjs）
# ---------------------------------------------------------------------------

#: 锁文件后缀。
LOCK_SUFFIX = '.lock'

#: 锁文件名前缀（点开头 ⇒ 隐藏文件；且不会与 ``cpython-*`` 目录、
#: ``<sha256>.zip`` / ``<sha256>.meta.json`` / ``<sha256>.zip.part`` 撞名）。
LOCK_FILE_PREFIX = '.acf-'

#: 锁目录名（放在 ``<work_dir>`` 下；**必须**登记进两端的工作目录保护名单）。
CACHE_LOCK_DIR_NAME = '.cache-locks'

#: 三类共享资源的锁键前缀。
GIT_LOCK_KEY_PREFIX = 'git-'
PKG_LOCK_KEY_PREFIX = 'pkg-'
INTERPRETER_LOCK_KEY_PREFIX = 'interp-'

#: 允许出现在锁键里的字符（**ASCII 白名单**）。
#:
#: 必须与 node 侧 ``shared-cache-lock.ts`` 的 ``SAFE_CHARS`` 逐字一致 ——
#: 注意**不能**用 ``str.isalnum()``：它在 Python 侧对 ``'中'`` 返回 True，
#: 而 JS 的 ``/[^A-Za-z0-9._-]/g`` 会把它替换成 ``_`` ⇒ 两端算出不同的文件名。
#:
#: 形态必须是**显式字符集字面量**（node 侧是正则字符类 ``[A-Za-z0-9._-]``，
#: python 侧这里是同一个字符串）—— ``scripts/check-shared-cache-lock.mjs``
#: 按「算出来的字符集逐字相同」核对两端。
#:
#: ⚠ 这个字面量是**区间写法**（``A-Z`` 表示整段），**不是**字符集合本身。
#: 实际判定用的集合由 ``_expand_char_ranges`` 展开得到（见下）。
SAFE_CHARS = 'A-Za-z0-9._-'


def _expand_char_ranges(spec: str) -> frozenset:
    """把 ``'A-Za-z0-9._-'`` 这样的**区间写法**展开成字符集合。

    为什么需要它：``SAFE_CHARS`` 是**给两端核对的契约字面量**（必须与 node 侧
    的正则字符类 ``[A-Za-z0-9._-]`` 逐字相同），但 Python 的字符串是
    **字符序列**而非集合 —— 直接 ``ch in SAFE_CHARS`` 会把 ``'b'`` 判成不安全
    （``'b'`` 不在字面量的任何一个字符里）⇒ 锁文件名被无谓地替换 ⇒ 两端
    文件名仍一致，但键被**不可逆地损坏**（不同键可能塌成同一个文件名 ⇒
    互斥过强；更糟的是排障时看不出原键）。
    """
    out = set()
    i = 0
    while i < len(spec):
        ch = spec[i]
        # 区间：`X-Y`（`-` 在最后一位时是字面量）
        if (i + 2 < len(spec) and spec[i + 1] == '-'
                and spec[i] <= spec[i + 2]):
            out.update(chr(c) for c in range(ord(spec[i]), ord(spec[i + 2]) + 1))
            i += 3
            continue
        out.add(ch)
        i += 1
    return frozenset(out)


#: ``SAFE_CHARS`` 的**字符集合**（逐字符判定用；由上面的字面量派生，
#: 保证「判据用的集合」与「被核对的字面量」永远是同一份）。
_SAFE_CHAR_SET = _expand_char_ranges(SAFE_CHARS)


def lock_file_name(key: str) -> str:
    """共享资源键 → 锁文件名（**两端命名规则的唯一入口**）。

    不安全字符（路径分隔符等）一律替换成 ``_``；键可能来自 URL 或文件路径。
    """
    safe = ''.join(ch if ch in _SAFE_CHAR_SET else '_' for ch in str(key))
    return f'{LOCK_FILE_PREFIX}{safe}{LOCK_SUFFIX}'


def cache_lock_dir(work_dir: Path) -> Path:
    """``<work_dir>/.cache-locks``（git / pkg 缓存锁的存放处）。"""
    d = Path(work_dir) / CACHE_LOCK_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def git_lock_key(repo_dir_name: str) -> str:
    """git 缓存锁键（``git-<repoDirName>``）。"""
    return f'{GIT_LOCK_KEY_PREFIX}{repo_dir_name}'


def pkg_lock_key(cache_key: str) -> str:
    """pkg 缓存锁键（``pkg-<sha256(url)>``）。"""
    return f'{PKG_LOCK_KEY_PREFIX}{cache_key}'


def interpreter_lock_key(version: str, platform_token: Optional[str]) -> str:
    """解释器池锁键（``interp-<version>-<platform>``）。

    平台段参与键：共享卷里不同平台（musl/gnu）的条目互不干扰，不必互相等待。
    平台判定不出（``None``）时用 ``any``。
    """
    return f'{INTERPRETER_LOCK_KEY_PREFIX}{version}-{(platform_token or "any")}'


# ---------------------------------------------------------------------------
# 后端实现
# ---------------------------------------------------------------------------

try:  # POSIX
    import fcntl  # type: ignore
    _HAVE_FCNTL = True
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore
    _HAVE_FCNTL = False

try:  # Windows
    import msvcrt  # type: ignore
    _HAVE_MSVCRT = True
except ImportError:
    msvcrt = None  # type: ignore
    _HAVE_MSVCRT = False


def backend() -> str:
    """当前平台实际使用的锁后端。

    * ``'flock'``  —— POSIX 真互斥（内核级，进程被杀自动释放）
    * ``'msvcrt'`` —— Windows 字节区间锁（进程被杀自动释放；**语义与 flock 不等价**）
    * ``'atomic'`` —— 降级：原子创建锁文件 + 存在即跳过 + TTL 清扫（best-effort）
    """
    if _HAVE_FCNTL:
        return 'flock'
    if _HAVE_MSVCRT:
        return 'msvcrt'
    return 'atomic'


def supports_kernel_release() -> bool:
    """True ⇒ 进程被 SIGKILL 时**内核/系统自动释放**锁。

    * ``flock``  —— True（内核级 advisory 锁，fd 关闭即释放）。
    * ``msvcrt`` —— True（Windows 强制锁随句柄关闭释放；进程被杀 ⇒ 句柄被系统
      关闭 ⇒ 锁释放）。
    * ``atomic`` —— **False**（残留锁文件只能靠 TTL 清扫；这正是软锁的弱点）。
    """
    return backend() in ('flock', 'msvcrt')


#: 降级（atomic）后端的残留锁清理门龄（秒）。
_STALE_ATOMIC_LOCK_SECONDS = 300.0

#: 默认等待上限（秒）。取 600：必须**大于**被保护操作自身的最长耗时
#: （git clone 120s / uv python install 数百秒 / 包下载 200MB 预算），
#: 否则「等不到锁」会被误当成「锁坏了」。
DEFAULT_LOCK_TIMEOUT = 600.0


class FileLockTimeout(TimeoutError):
    """在超时窗口内没能拿到锁。"""


class FileLockError(RuntimeError):
    """锁机制本身出错（无法打开锁文件等）。"""


class _FcntlLock:
    """POSIX flock 后端（真互斥，内核级）。"""

    backend_name = 'flock'

    def __init__(self, path: Path, timeout: Optional[float], poll_interval: float):
        self._path = Path(path)
        self._timeout = timeout
        self._poll_interval = poll_interval
        self._fd: Optional[int] = None

    def acquire(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(str(self._path), os.O_RDWR | os.O_CREAT, 0o644)
        except OSError as exc:
            raise FileLockError(f'无法打开锁文件 {self._path}：{exc}') from exc
        self._fd = fd
        deadline = None if self._timeout is None else time.monotonic() + self._timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK):
                    self._close_fd()
                    raise FileLockError(f'flock 加锁失败：{self._path}（{exc}）') from exc
                if deadline is not None and time.monotonic() >= deadline:
                    self._close_fd()
                    raise FileLockTimeout(
                        f'timeout acquiring flock {self._path} after {self._timeout}s')
                time.sleep(self._poll_interval)

    def release(self) -> None:
        fd, self._fd = self._fd, None
        if fd is None:
            return
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            self._close_fd()

    def _close_fd(self) -> None:
        fd, self._fd = self._fd, None
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


class _MsvcrtLock:
    """Windows ``msvcrt.locking`` 后端（字节区间锁）。

    **如实说明：与 POSIX flock 不等价。**

    * 锁的是**字节区间**（第 0 字节，共 1 字节）；持锁期间对**其它进程**的
      该区间读写会失败（强制锁）。
    * ``LK_NBLCK`` 的唯一性判定在同一进程的两个句柄上**不冲突**（与 POSIX 不同）
      ⇒ 进程内仍需叠加一层 ``threading.Lock``（调用侧已保留进程内锁）。
    * 锁随**文件句柄关闭**释放 ⇒ 进程被杀时句柄被系统关闭 ⇒ 锁同样释放。
    """

    backend_name = 'msvcrt'

    def __init__(self, path: Path, timeout: Optional[float], poll_interval: float):
        self._path = Path(path)
        self._timeout = timeout
        self._poll_interval = poll_interval
        self._fh = None

    def acquire(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        try:
            # 必须以 'a+b' 打开：'w+b' 会截断已有文件（截断会让另一进程正在
            # 持有的 msvcrt 锁作用在 0 长度的文件上）。
            self._fh = open(str(self._path), 'a+b')
            if self._fh.tell() == 0:
                self._fh.write(b'\0')
                self._fh.flush()
        except OSError as exc:
            raise FileLockError(f'无法打开锁文件 {self._path}：{exc}') from exc
        deadline = None if self._timeout is None else time.monotonic() + self._timeout
        while True:
            try:
                self._fh.seek(0)
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_NBLCK, 1)
                return
            except OSError:
                if deadline is not None and time.monotonic() >= deadline:
                    self._close()
                    raise FileLockTimeout(
                        f'timeout acquiring msvcrt lock {self._path} after {self._timeout}s')
                time.sleep(self._poll_interval)

    def release(self) -> None:
        if self._fh is None:
            return
        try:
            self._fh.seek(0)
            msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        self._close()

    def _close(self) -> None:
        fh, self._fh = self._fh, None
        if fh is None:
            return
        try:
            fh.close()
        except OSError:
            pass


class _AtomicLock:
    """降级后端：原子创建锁文件 + 存在即跳过 + TTL 清扫（**best-effort**）。

    只在 ``fcntl`` 与 ``msvcrt`` 都不可用时启用（本仓从未走到）。语义**弱于**
    flock：进程被 ``SIGKILL`` ⇒ 锁文件**残留** ⇒ 必须靠 TTL 清扫才能恢复
    （``supports_kernel_release()`` 在此为 False）。
    """

    backend_name = 'atomic'

    def __init__(self, path: Path, timeout: Optional[float], poll_interval: float):
        self._path = Path(path)
        self._timeout = timeout
        self._poll_interval = poll_interval
        self._fd: Optional[int] = None

    def acquire(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        deadline = None if self._timeout is None else time.monotonic() + self._timeout
        while True:
            try:
                self._fd = os.open(
                    str(self._path), os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o644)
                return
            except FileExistsError:
                self._reap_if_stale()
                if deadline is not None and time.monotonic() >= deadline:
                    raise FileLockTimeout(
                        f'timeout acquiring atomic lock {self._path} after {self._timeout}s')
                time.sleep(self._poll_interval)
            except OSError as exc:
                raise FileLockError(f'无法创建锁文件 {self._path}：{exc}') from exc

    def _reap_if_stale(self) -> None:
        """锁文件存在且已过龄 ⇒ 当作「持有者已死」清掉（TTL 清扫）。"""
        try:
            age = time.time() - self._path.stat().st_mtime
        except OSError:
            return
        if age > _STALE_ATOMIC_LOCK_SECONDS:
            try:
                self._path.unlink()
                logger.warning(
                    'Reaped stale atomic lock %s (age %.0fs > %.0fs)',
                    self._path, age, _STALE_ATOMIC_LOCK_SECONDS)
            except OSError:
                pass

    def release(self) -> None:
        fd, self._fd = self._fd, None
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            self._path.unlink()
        except OSError:
            pass


def _make_lock(path: Path, timeout: Optional[float], poll_interval: float):
    name = backend()
    if name == 'flock':
        return _FcntlLock(path, timeout, poll_interval)
    if name == 'msvcrt':
        return _MsvcrtLock(path, timeout, poll_interval)
    return _AtomicLock(path, timeout, poll_interval)


@contextmanager
def file_lock(path: Path, *, timeout: Optional[float] = DEFAULT_LOCK_TIMEOUT,
             poll_interval: float = 0.05) -> Iterator[None]:
    """跨进程互斥地持有 ``path`` 对应的锁。

    * ``timeout=None`` ⇒ 无限等待；``timeout=0`` ⇒ 只试一次。
    * 正常退出、异常退出 ⇒ 锁释放。**进程被 SIGKILL** ⇒ POSIX 上内核自动释放
      （flock）、Windows 上句柄关闭即释放（msvcrt）；只有降级后端会残留。

    用法::

        with file_lock(cache_lock_dir(work_dir) / lock_file_name(git_lock_key(repo))):
            ...  # 跨进程安全的临界区
    """
    lock = _make_lock(Path(path), timeout, poll_interval)
    lock.acquire()
    try:
        yield
    finally:
        lock.release()


@contextmanager
def file_lock_for_key(directory: Path, key: str, **kwargs) -> Iterator[None]:
    """``<directory>/lock_file_name(key)`` 上的跨进程锁（键 ⇒ 文件名的唯一入口）。"""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    with file_lock(directory / lock_file_name(key), **kwargs):
        yield


async def acquire_file_lock_async(path: Path, *, timeout: Optional[float] = DEFAULT_LOCK_TIMEOUT,
                                  poll_interval: float = 0.05):
    """**异步友好**的加锁：加锁动作跑在**专属线程**里，事件循环与共享线程池都不被卡住。

    为什么需要它：``pkg_cache`` 的临界区含 ``await``（下载本身）。若在事件
    循环线程里阻塞等 flock，**整个循环**会停摆（心跳、长轮询全部被掐）。

    为什么用**专属线程**而不是 ``asyncio.to_thread``：``to_thread`` 占用的是
    **默认 ThreadPoolExecutor**（Python 3.12 默认 ``min(32, cpu+4)`` 个 worker）。
    pkg 下载的临界区可以长达数分钟（200MB 预算）⇒ 等待者会**长期占住 worker**
    ⇒ 池被耗尽 ⇒ 事件循环上**所有** ``to_thread`` 调用（git checkout、缓存
    复制…）一起饿死。专属线程（daemon）不受池大小限制。

    锁的**释放**可以在任意线程进行：flock 绑在**打开的文件描述符**上，
    ``flock(LOCK_UN)`` + ``close()`` 从哪个线程调用都有效 ⇒ 事件循环线程可以
    直接释放一个在工作线程里加上的锁。

    返回一个持有者对象，调用 ``.release()`` 释放（幂等）。
    """
    lock = _make_lock(Path(path), timeout, poll_interval)
    loop = asyncio.get_running_loop()
    settled = asyncio.Event()
    outcome: dict = {}

    def _worker() -> None:
        try:
            lock.acquire()
            outcome['ok'] = True
        except BaseException as exc:  # noqa: BLE001 - 原样上抛给等待方
            outcome['exc'] = exc
        finally:
            try:
                loop.call_soon_threadsafe(settled.set)
            except RuntimeError:
                # 事件循环已关闭 ⇒ 没人会来收结果；若已拿到锁，此刻就地释放，
                # 否则锁会一直挂到进程退出。
                if outcome.get('ok'):
                    try:
                        lock.release()
                    except Exception:  # pragma: no cover - best-effort
                        pass

    worker = threading.Thread(target=_worker, name='acf-file-lock-acquire', daemon=True)
    worker.start()
    try:
        await settled.wait()
    except asyncio.CancelledError:
        # 等待被取消：工作线程可能**稍后**才拿到锁 ⇒ 交给后台线程在它结束后
        # 释放，避免「拿到了却没人放」的锁泄漏。
        threading.Thread(target=_release_after_join, args=(lock, outcome, worker),
                         name='acf-file-lock-release', daemon=True).start()
        raise
    if 'exc' in outcome:
        raise outcome['exc']
    return lock


def _release_after_join(lock, outcome: dict, worker: threading.Thread) -> None:
    """工作线程结束后，若锁已到手就释放它（取消路径的清理）。"""
    worker.join()
    if outcome.get('ok'):
        try:
            lock.release()
        except Exception:  # pragma: no cover - best-effort
            pass
