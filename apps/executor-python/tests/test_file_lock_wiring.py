"""H-4b：四把跨进程锁的**接线**用例（git 缓存 / pkg 缓存 / 解释器池）。

## 这些用例钉什么

``tests/test_file_lock.py`` 钉的是**锁机制本身**（跨进程互斥、SIGKILL 释放、
命名规则）。本文件钉的是**接线**：每一处共享资源的临界区**确实**取到了那把
跨进程锁，且锁的**位置**落在「必然被共享」的地方。

## 为什么「位置」也要钉

跨进程锁最隐蔽的失效形态是「**锁在了没人共享的地方**」：

* git / pkg 缓存锁若放在**各自实例的私有目录**里 ⇒ 两个实例各锁各的 ⇒
  互斥形同虚设（而且测试全绿，因为进程内互斥仍然成立）；
* 解释器池锁若放在 ``work_dir`` 下 ⇒ 池是**独立卷**（compose 的
  ``interpreter_cache:/data/interpreters``），可能与 ``work_dir`` **不共享**
  ⇒ 同样各锁各的。

⇒ 位置是正确性的一部分，必须被钉住。
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

_APP_DIR = Path(__file__).resolve().parents[1]
if str(_APP_DIR) not in sys.path:
    sys.path.insert(0, str(_APP_DIR))

from lib import file_lock  # noqa: E402


# ---------------------------------------------------------------------------
# ① git 缓存锁
# ---------------------------------------------------------------------------

def test_git_cache_lock_lives_under_work_dir(monkeypatch, tmp_path):
    """git 缓存锁必须在 ``<work_dir>/.cache-locks/`` 下（⇒ 同实例必然共享）。"""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    cache_dir = tmp_path / '.git_cache' / 'repo-abc123'
    lock_path = execute_module._git_cache_lock_path(cache_dir)

    assert lock_path.parent == tmp_path / '.cache-locks'
    assert lock_path.name.startswith(file_lock.LOCK_FILE_PREFIX)
    assert lock_path.name.endswith(file_lock.LOCK_SUFFIX)
    # 键里必须带 git 前缀（⇒ 不会与 pkg 缓存锁撞名）
    assert file_lock.GIT_LOCK_KEY_PREFIX in lock_path.name


def test_git_cache_lock_is_distinct_per_repo(monkeypatch, tmp_path):
    """不同 repo ⇒ 不同锁文件（粒度正确，不会把无关 repo 串行化）。"""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    a = execute_module._git_cache_lock_path(tmp_path / '.git_cache' / 'repo-a')
    b = execute_module._git_cache_lock_path(tmp_path / '.git_cache' / 'repo-b')
    assert a != b


def test_git_cache_lock_dir_is_ttl_sweep_protected():
    """锁目录必须在工作目录的**保护名单**里。

    否则 TTL 清扫会在持有者还持锁时把锁文件删掉 ⇒ 下一个进程建**新 inode**
    ⇒ 互斥彻底失效（且没有任何测试会红）。
    """
    import maintenance

    assert file_lock.CACHE_LOCK_DIR_NAME in maintenance._PROTECTED_WORKDIR_NAMES


def test_node_side_protects_same_lock_dir():
    """两端保护名单同源（node: file-logger.ts PROTECTED_WORKDIR_NAMES）。"""
    node_source = (
        Path(__file__).parents[2] / 'executor-node' / 'src' / 'file-logger.ts'
    ).read_text(encoding='utf-8')
    assert f"'{file_lock.CACHE_LOCK_DIR_NAME}'" in node_source


def test_git_checkout_takes_cross_process_lock(monkeypatch, tmp_path):
    """``git_checkout_to`` 的临界区**确实**取到了跨进程锁（真取，不是摆设）。

    做法：把 ``_git_checkout_to_locked`` 换成替身，在替身里检查锁是否被持有
    （尝试非阻塞获取同一把锁 ⇒ 必须拿不到 ⇒ 说明别人正持有）。
    """
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))

    observed = {}

    def fake_locked(repo_url, cache_dir, ref, dest):
        lock_path = execute_module._git_cache_lock_path(cache_dir)
        observed['lock_path'] = lock_path
        observed['lock_exists'] = lock_path.exists()
        # 锁**正被持有** ⇒ 另一 fd 的非阻塞获取必须失败
        try:
            with file_lock.file_lock(lock_path, timeout=0.2):
                observed['held'] = False
        except file_lock.FileLockTimeout:
            observed['held'] = True

    monkeypatch.setattr(execute_module, '_git_checkout_to_locked', fake_locked)
    execute_module.git_checkout_to('https://example.com/org/r.git', 'main',
                                   tmp_path / 'dest')

    assert observed.get('held') is True, (
        '临界区内没有持有跨进程锁 ⇒ 同机多实例仍会同时 clone 写同一缓存目录')
    assert observed.get('lock_exists') is True


# ---------------------------------------------------------------------------
# ② pkg 缓存锁
# ---------------------------------------------------------------------------

def test_pkg_lock_lives_under_work_dir(monkeypatch, tmp_path):
    """pkg 缓存锁必须在 ``<work_dir>/.cache-locks/`` 下。"""
    import pkg_cache

    monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
    lock_path = pkg_cache._pkg_lock_path('a' * 64)
    assert lock_path.parent == tmp_path / '.cache-locks'
    assert file_lock.PKG_LOCK_KEY_PREFIX in lock_path.name


def test_pkg_lock_is_distinct_per_url(monkeypatch, tmp_path):
    """不同 URL ⇒ 不同锁（不同 URL 的下载互不阻塞）。"""
    import pkg_cache

    monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
    a = pkg_cache._pkg_lock_path('a' * 64)
    b = pkg_cache._pkg_lock_path('b' * 64)
    assert a != b


def test_pkg_download_takes_cross_process_lock(monkeypatch, tmp_path):
    """``download_with_cache`` 的下载临界区**确实**取到了跨进程锁。

    做法：把 ``download`` 替身改成「在下载期间检查锁被持有」。
    """
    import pkg_cache

    monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(pkg_cache, '_max_bytes', lambda: 1024 * 1024)

    observed = {}

    async def fake_download(url, dest, should_cancel=None):
        key = pkg_cache._cache_key(url)
        lock_path = pkg_cache._pkg_lock_path(key)
        observed['lock_path'] = lock_path
        try:
            with file_lock.file_lock(lock_path, timeout=0.2):
                observed['held'] = False
        except file_lock.FileLockTimeout:
            observed['held'] = True
        dest.write_bytes(b'payload')
        return 7

    size = asyncio.run(pkg_cache.download_with_cache(
        fake_download, 'https://example.com/pkg.zip', tmp_path / 'out.zip'))

    assert size == 7
    assert observed.get('held') is True, (
        '下载临界区内没有持有跨进程锁 ⇒ 同机多实例会互踩 <key>.zip.part')


def test_pkg_cache_hit_path_does_not_take_lock(monkeypatch, tmp_path):
    """**快路径**（缓存命中）不进锁 ⇒ 命中不付锁的代价。

    这是既有语义（命中直接复制），H-4b 只在**下载**路径加锁，不改变快路径。
    """
    import pkg_cache

    monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(pkg_cache, '_max_bytes', lambda: 1024 * 1024)

    # 先种一个条目
    key = pkg_cache._cache_key('https://example.com/pkg.zip')
    pkg_cache.pkg_cache_dir().mkdir(parents=True, exist_ok=True)
    (pkg_cache.pkg_cache_dir() / f'{key}.zip').write_bytes(b'cached')
    (pkg_cache.pkg_cache_dir() / f'{key}.meta.json').write_text(
        '{"url": "https://example.com/pkg.zip", "size": 6}', encoding='utf-8')

    called = {'n': 0}

    async def fake_download(url, dest, should_cancel=None):
        called['n'] += 1
        dest.write_bytes(b'network')
        return 6

    dest = tmp_path / 'out.zip'
    size = asyncio.run(pkg_cache.download_with_cache(
        fake_download, 'https://example.com/pkg.zip', dest))

    assert size == 6
    assert called['n'] == 0, '缓存命中不该走网络'
    assert dest.read_bytes() == b'cached'


# ---------------------------------------------------------------------------
# ③ 解释器池锁
# ---------------------------------------------------------------------------

def test_interpreter_lock_lives_inside_pool(monkeypatch, tmp_path):
    """解释器锁必须在**池目录内**（池是独立卷，可能不与 work_dir 共享）。"""
    import interpreters

    pool = tmp_path / 'interpreters'
    pool.mkdir()
    monkeypatch.setattr(interpreters.settings, 'uv_python_install_dir', str(pool))

    lock_path = interpreters._interpreter_lock_path('3.11')
    assert lock_path.parent == pool, (
        f'解释器锁必须在池目录内（池是独立卷），实得 {lock_path.parent}')
    assert file_lock.INTERPRETER_LOCK_KEY_PREFIX in lock_path.name


def test_interpreter_lock_differs_per_platform(monkeypatch, tmp_path):
    """不同平台的解释器锁**不同**（共享卷里 musl/gnu 互不等待）。"""
    import interpreters

    pool = tmp_path / 'interpreters'
    pool.mkdir()
    monkeypatch.setattr(interpreters.settings, 'uv_python_install_dir', str(pool))
    monkeypatch.setattr(interpreters, '_current_platform_token', lambda: 'linux-x86_64-gnu')

    gnu = interpreters._interpreter_lock_path('3.11')
    monkeypatch.setattr(interpreters, '_current_platform_token', lambda: 'linux-x86_64-musl')
    musl = interpreters._interpreter_lock_path('3.11')
    assert gnu != musl


def test_ensure_version_takes_cross_process_lock(monkeypatch, tmp_path):
    """``ensure_version`` 的下载临界区**确实**取到了跨进程锁。

    做法：把 ``_ensure_version_locked`` 换成替身，在替身里检查锁被持有。
    """
    import interpreters

    pool = tmp_path / 'interpreters'
    pool.mkdir()
    monkeypatch.setattr(interpreters.settings, 'uv_python_install_dir', str(pool))
    monkeypatch.setattr(interpreters, 'resolve_python_bin', lambda v: None)
    monkeypatch.setattr(interpreters, '_raise_if_not_downloadable', lambda v: None)

    observed = {}

    def fake_locked(version, timeout):
        lock_path = interpreters._interpreter_lock_path(version)
        observed['lock_path'] = lock_path
        try:
            with file_lock.file_lock(lock_path, timeout=0.2):
                observed['held'] = False
        except file_lock.FileLockTimeout:
            observed['held'] = True
        return pool / 'bin' / 'python'

    monkeypatch.setattr(interpreters, '_ensure_version_locked', fake_locked)
    interpreters.ensure_version('3.11', timeout=1.0)

    assert observed.get('held') is True, (
        '解释器下载临界区内没有持有跨进程锁 ⇒ 同机多实例会同时 uv python install '
        '写同一个平台目录 ⇒ 池条目半写（corrupt）')


def test_pool_lock_files_do_not_break_pool_scanning(monkeypatch, tmp_path):
    """池内的锁文件**不干扰**池扫描（两端都只认 ``cpython-*`` 目录）。

    这是「锁放在池目录内」这个选择的代价，必须被钉住：一旦有人把池扫描改成
    「枚举池内所有条目并当作版本」，这个用例就会红 ⇒ 提醒他锁文件不是版本。
    """
    import interpreters

    pool = tmp_path / 'interpreters'
    pool.mkdir()
    monkeypatch.setattr(interpreters.settings, 'uv_python_install_dir', str(pool))

    lock_path = interpreters._interpreter_lock_path('3.11')
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_bytes(b'')

    entries = interpreters._pool_version_entries(interpreters.pool_root()) \
        if hasattr(interpreters, '_pool_version_entries') else None
    if entries is None:
        import maintenance
        entries = maintenance._pool_version_entries(pool)

    names = [name for name, _p, _s, _m in entries]
    assert names == [], (
        f'池扫描把锁文件当成了版本条目：{names} —— 锁文件不是解释器版本')
