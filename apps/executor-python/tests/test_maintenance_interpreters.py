"""NFR-15 / D12 解释器池磁盘治理（python_task_multiversion, WS4）。

覆盖：
  * 解释器池**豁免 TTL 清扫**（物理隔离 + work_dir 内的显式豁免，defence in depth）
  * 单版本 / 总池体积红线 → 告警 + LRU 回收
  * **引用感知回收**（lead 实测的生产事故类缺陷）：池目录被删 = 依赖它的
    venv 当场报废（venv 里的 python 只是 shim），所以有依赖者一律跳过
  * 全部候选都被 pin 住 → **什么都不删** + 响亮告警
  * 回收绝不碰任务 venv；删除路径硬断言必须在池根之内
"""
import os
import time

import pytest

import interpreters as interpreters_module
import maintenance
from config import settings


MB = 1024 * 1024
GB = 1024 ** 3


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _restore_interpreter_settings():
    """本文件多处直接改 `settings` 的池体积/路径（它们是 pydantic 字段，直接赋值
    不会被 monkeypatch 记账）。不显式还原的话，`interpreter_single_version_mb=1`
    之类的值会泄漏到后续测试文件，让别的用例莫名其妙地开始回收解释器。"""
    fields = ('interpreter_single_version_mb', 'interpreter_total_gb',
              'uv_python_install_dir', 'work_dir')
    snapshot = {name: getattr(settings, name, None) for name in fields}
    yield
    for name, value in snapshot.items():
        try:
            setattr(settings, name, value)
        except (ValueError, TypeError):  # pragma: no cover - 字段校验拒绝还原
            pass


@pytest.fixture()
def layout(tmp_path, monkeypatch):
    """work_dir 与解释器池（**默认在 work_dir 之外**，NFR-15 物理隔离）。"""
    work_root = tmp_path / 'tasks'
    work_root.mkdir()
    pool_root = tmp_path / 'interpreters'
    pool_root.mkdir()
    monkeypatch.setattr(settings, 'work_dir', str(work_root))
    monkeypatch.setattr(settings, 'uv_python_install_dir', str(pool_root))
    return work_root, pool_root


def _age(path, days=0.0):
    stamp = time.time() - days * 24 * 60 * 60
    os.utime(path, (stamp, stamp))


def _make_version(pool_root, dir_name, size_bytes, mtime=None):
    """造一个"看起来像解释器"的池内版本目录（含实际字节数以参与体积统计）。"""
    version_dir = pool_root / dir_name
    version_dir.mkdir(parents=True, exist_ok=True)
    payload = version_dir / 'python.exe'
    payload.write_bytes(b'\0' * size_bytes)
    if mtime is not None:
        os.utime(version_dir, (mtime, mtime))
        os.utime(payload, (mtime, mtime))
    return version_dir


def _make_venv(work_root, name, home_dir):
    """造一个依赖 `home_dir` 的 venv（真实形状：pyvenv.cfg 记 home + python shim）。"""
    venv_dir = work_root / '.venvs' / name
    venv_dir.mkdir(parents=True, exist_ok=True)
    (venv_dir / 'pyvenv.cfg').write_text(
        f'home = {home_dir}\nimplementation = CPython\n'
        'uv = 0.8.17\nversion_info = 3.9.20\n'
        'include-system-site-packages = false\n',
        encoding='utf-8',
    )
    (venv_dir / 'python').write_bytes(b'shim')
    return venv_dir


def _inflate(monkeypatch, per_version_bytes):
    """让每个池内版本都"看起来"有 `per_version_bytes` 大。

    总池红线在实现里被 `max(1, int(gb))` 兜底成**至少 1GB**，测试里不可能真造出
    1GB 的文件；这里只把"上报体积"放大，测的是 LRU 顺序与引用感知这两条真正的
    逻辑（字节统计本身由 `test_per_version_red_line_*` 用真实文件覆盖）。"""
    monkeypatch.setattr(maintenance, '_dir_size_bytes', lambda path: per_version_bytes)
    # 单版本红线同时抬高，避免"每个版本都超单版本红线"抢在总红线之前回收。
    settings.interpreter_single_version_mb = 100_000


# ---------------------------------------------------------------------------
# 豁免 TTL 清扫
# ---------------------------------------------------------------------------

def test_interpreter_pool_outside_work_dir_is_untouched_by_the_sweep(layout):
    """物理隔离（默认）：池在 work_dir 之外，清扫根本够不着。"""
    work_root, pool_root = layout
    version_dir = _make_version(pool_root, 'cpython-3.9.20-x', 1024)
    _age(version_dir, days=30)

    maintenance.cleanup_work_dir(ttl_days=7)

    assert version_dir.exists()


def test_interpreter_pool_inside_work_dir_is_exempt_from_the_sweep(layout):
    """defence in depth：即便部署方把池配进 work_dir，也必须豁免。

    池是**可复用资产**，被当成过期任务目录删掉会导致下次任务重新下载
    （正是 NFR-15 要避免的），而且会连带炸掉所有依赖它的 venv。"""
    work_root, _pool_root = layout
    inside_pool = work_root / 'python-pool'
    version_dir = _make_version(inside_pool, 'cpython-3.9.20-x', 1024)
    _age(inside_pool, days=30)
    _age(version_dir, days=30)
    settings.uv_python_install_dir = str(inside_pool)

    maintenance.cleanup_work_dir(ttl_days=7)

    assert inside_pool.exists(), 'the interpreter pool root must never be swept'
    assert version_dir.exists()


def test_sweep_still_removes_ordinary_stale_workdirs_alongside_a_pool(layout):
    """豁免不能把整个清扫废掉：普通过期任务目录照删。"""
    work_root, pool_root = layout
    stale = work_root / 'exec-stale'
    stale.mkdir()
    _age(stale, days=30)
    _make_version(pool_root, 'cpython-3.9.20-x', 1024)

    counts = maintenance.cleanup_work_dir(ttl_days=7)

    assert not stale.exists()
    assert counts == {'workDirs': 1, 'caches': 0, 'venvs': 0, 'deadLetters': 0}, (
        'the sweep return shape is a contract (node cleanupWorkDir parity) — '
        'interpreter enforcement must not add keys'
    )


def test_pool_configured_as_work_dir_itself_is_not_silently_protected(layout, caplog):
    """配成 work_dir 本身 = 保护整个 work_dir = 取消清扫：记 error 且不保护。"""
    work_root, _pool_root = layout
    settings.uv_python_install_dir = str(work_root)
    stale = work_root / 'exec-stale'
    stale.mkdir()
    _age(stale, days=30)

    maintenance.cleanup_work_dir(ttl_days=7)

    assert not stale.exists(), 'disk governance must not be disabled by a config mistake'


# ---------------------------------------------------------------------------
# 体积红线 + LRU
# ---------------------------------------------------------------------------

def test_per_version_red_line_reclaims_an_unreferenced_oversized_version(layout, caplog):
    work_root, pool_root = layout
    settings.interpreter_single_version_mb = 1
    settings.interpreter_total_gb = 4
    big = _make_version(pool_root, 'cpython-3.9.20-x', 2 * MB)

    result = maintenance.enforce_interpreter_pool_limits()

    assert result['reclaimedVersions'] == 1
    assert not big.exists()


def test_disk_full_during_reclaim_never_crashes_enforcement(layout, caplog):
    """E-4（审计补漏）：磁盘满/EACCES 场景——回收删除抛 OSError 时，治理
    循环必须存活（`_remove_quietly` 的 best-effort 契约），版本目录保持原样，
    失败经日志可见，绝不让整个治理任务崩掉（它在 TTL 清扫任务里跑，崩了会
    连带磁盘红线整体失守）。"""
    import logging

    work_root, pool_root = layout
    settings.interpreter_single_version_mb = 1
    settings.interpreter_total_gb = 4
    big = _make_version(pool_root, 'cpython-3.9.20-x', 2 * MB)

    def disk_full(target):
        raise OSError(28, 'No space left on device', str(target))

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(maintenance.shutil, 'rmtree', disk_full)
    try:
        with caplog.at_level(logging.WARNING):
            result = maintenance.enforce_interpreter_pool_limits()
    finally:
        monkeypatch.undo()

    assert big.exists(), 'rmtree 失败时版本目录必须保持原样（绝不能误报已回收）'
    assert 'No space left' in caplog.text, '删除失败必须经日志可见（best-effort 契约）'
    # 回收计数：`_remove_quietly` 吞掉 OSError 后调用方无法感知删除失败，按
    # best-effort 语义照常计数——若未来把 `_remove_quietly` 改为可感知失败并
    # 据此计数，此断言需同步更新（这正是把它钉在这里的目的）。
    assert result['reclaimedVersions'] == 1
    assert result['reclaimedBytes'] == 2 * MB


def test_per_version_red_line_skips_a_referenced_oversized_version(layout):
    """**引用感知**：被 venv 依赖的版本绝不回收（删了 venv 当场报废）。"""
    work_root, pool_root = layout
    settings.interpreter_single_version_mb = 1
    big = _make_version(pool_root, 'cpython-3.9.20-x', 2 * MB)
    _make_venv(work_root, 'task-a-3.9', big)

    result = maintenance.enforce_interpreter_pool_limits()

    assert result['reclaimedVersions'] == 0
    assert result['pinnedVersions'] == 1
    assert big.exists(), 'a version with a dependent venv must survive reclamation'


def test_total_pool_red_line_reclaims_lru_order(layout, monkeypatch):
    """总池超限 → 按目录 mtime 升序回收（最久未使用优先）。"""
    work_root, pool_root = layout
    settings.interpreter_total_gb = 1
    # 每个版本"算"800MB → 三个共 2.4GB > 1GB 红线
    _inflate(monkeypatch, 800 * MB)
    oldest = _make_version(pool_root, 'cpython-3.8.20-x', 512, mtime=time.time() - 9000)
    middle = _make_version(pool_root, 'cpython-3.9.20-x', 512, mtime=time.time() - 5000)
    newest = _make_version(pool_root, 'cpython-3.12.11-x', 512, mtime=time.time() - 1000)

    result = maintenance.enforce_interpreter_pool_limits()

    # 2.4GB → 需回收两个 800MB 才落到 1GB 红线之下；最久未使用的先走。
    assert result['reclaimedVersions'] == 2
    assert not oldest.exists(), 'the least-recently-used version goes first'
    assert not middle.exists(), 'the second-least-recently-used goes next'
    assert newest.exists(), 'the most-recently-used version is never touched'
    assert result['poolBytes'] <= 1 * GB


def test_all_candidates_pinned_deletes_nothing_and_warns(layout, monkeypatch, caplog):
    """全部候选被 pin 住 → 什么都不删 + 响亮告警（绝不弄废用户 venv）。"""
    import logging

    work_root, pool_root = layout
    settings.interpreter_total_gb = 1
    _inflate(monkeypatch, 800 * MB)
    first = _make_version(pool_root, 'cpython-3.8.20-x', 512, mtime=time.time() - 9000)
    second = _make_version(pool_root, 'cpython-3.9.20-x', 512, mtime=time.time() - 5000)
    _make_venv(work_root, 'task-a-3.8', first)
    _make_venv(work_root, 'task-b-3.9', second)

    with caplog.at_level(logging.WARNING):
        result = maintenance.enforce_interpreter_pool_limits()

    assert result['reclaimedVersions'] == 0
    assert result['pinnedVersions'] == 2
    assert first.exists() and second.exists()
    assert any('still over the total limit' in r.getMessage() for r in caplog.records), (
        'an unreclaimable over-budget pool must be loud, not silent'
    )
    assert any('still depend on it' in r.getMessage() for r in caplog.records), (
        'each skip must name the dependent venvs'
    )


def test_reclamation_never_touches_task_venvs(layout, monkeypatch):
    """回收只发生在池内——任务 venv 与 workdir 一概不碰。"""
    work_root, pool_root = layout
    settings.interpreter_single_version_mb = 1
    settings.interpreter_total_gb = 1
    version_dir = _make_version(pool_root, 'cpython-3.9.20-x', 2 * MB)
    venv_dir = _make_venv(work_root, 'task-keep', version_dir)
    other_venv = _make_venv(work_root, 'task-keep-2', pool_root / 'cpython-3.12.11-x')

    maintenance.enforce_interpreter_pool_limits()

    assert venv_dir.exists()
    assert other_venv.exists()
    assert (venv_dir / 'pyvenv.cfg').exists()


def test_reclamation_refuses_paths_outside_the_pool_root(layout):
    """硬安全断言：池根之外的路径一律拒绝删除（防路径拼接出错删到池外）。"""
    work_root, pool_root = layout
    outside = work_root / 'not-the-pool'
    outside.mkdir()
    (outside / 'important.txt').write_text('do not delete')

    assert maintenance._reclaim_interpreter_version(pool_root, outside, '3.9.20') is False
    assert outside.exists()
    assert (outside / 'important.txt').exists()


def test_reclamation_refuses_the_pool_root_itself(layout):
    """池根本身也不许删（删掉等于清空整个缓存层）。"""
    _work_root, pool_root = layout
    assert maintenance._reclaim_interpreter_version(pool_root, pool_root, '') is False
    assert pool_root.exists()


def test_reclamation_invalidates_the_discovery_cache(layout, monkeypatch):
    """回收后必须刷新探测缓存——否则心跳继续上报刚被删掉的版本。"""
    work_root, pool_root = layout
    settings.interpreter_single_version_mb = 1
    _make_version(pool_root, 'cpython-3.9.20-x', 2 * MB)
    invalidated = []

    monkeypatch.setattr(maintenance._interpreters, 'invalidate_cache',
                        lambda: invalidated.append(True))

    maintenance.enforce_interpreter_pool_limits()

    assert invalidated, 'the reported inventory must converge after reclamation'


def test_cleanup_work_dir_runs_pool_enforcement_without_breaking_counts(layout, monkeypatch):
    """TTL 清扫顺带执行体积治理，但返回值形状不变。"""
    work_root, pool_root = layout
    called = []
    monkeypatch.setattr(maintenance, 'enforce_interpreter_pool_limits',
                        lambda: called.append(True) or {
                            'reclaimedVersions': 0, 'reclaimedBytes': 0,
                            'poolBytes': 0, 'overLimit': 0, 'pinnedVersions': 0})

    counts = maintenance.cleanup_work_dir(ttl_days=7)

    assert called == [True]
    assert set(counts) == {'workDirs', 'caches', 'venvs', 'deadLetters'}


def test_pool_enforcement_failure_does_not_break_the_ttl_sweep(layout, monkeypatch):
    work_root, _pool_root = layout
    stale = work_root / 'exec-stale'
    stale.mkdir()
    _age(stale, days=30)

    def boom():
        raise RuntimeError('pool exploded')

    monkeypatch.setattr(maintenance, 'enforce_interpreter_pool_limits', boom)

    counts = maintenance.cleanup_work_dir(ttl_days=7)

    assert counts['workDirs'] == 1, 'a pool error must not abort TTL reclamation'


def test_no_pool_configured_is_a_no_op(layout, monkeypatch):
    _work_root, _pool_root = layout
    monkeypatch.setattr(settings, 'uv_python_install_dir', '')
    result = maintenance.enforce_interpreter_pool_limits()
    assert result['reclaimedVersions'] == 0
    assert result['poolBytes'] == 0


def test_missing_pool_directory_is_a_no_op(layout, tmp_path):
    _work_root, _pool_root = layout
    settings.uv_python_install_dir = str(tmp_path / 'never-created')
    result = maintenance.enforce_interpreter_pool_limits()
    assert result['reclaimedVersions'] == 0


def test_malformed_pyvenv_cfg_is_ignored_during_dependency_scan(layout):
    """损坏的 pyvenv.cfg 不能让依赖扫描崩掉，也不能误判成"有依赖"。"""
    work_root, pool_root = layout
    settings.interpreter_single_version_mb = 1
    broken = work_root / '.venvs' / 'broken'
    broken.mkdir(parents=True)
    (broken / 'pyvenv.cfg').write_bytes(b'\xff\xfe garbage \x00')
    version_dir = _make_version(pool_root, 'cpython-3.9.20-x', 2 * MB)

    result = maintenance.enforce_interpreter_pool_limits()

    assert result['reclaimedVersions'] == 1
    assert not version_dir.exists()
    assert broken.exists(), 'the venv itself is never touched by pool reclamation'


def test_dependency_scan_matches_the_exact_pool_directory(layout):
    """只有 home 真正指向该版本目录才算依赖（不能张冠李戴）。"""
    work_root, pool_root = layout
    settings.interpreter_single_version_mb = 1
    referenced = _make_version(pool_root, 'cpython-3.9.20-x', 2 * MB)
    unreferenced = _make_version(pool_root, 'cpython-3.8.20-x', 2 * MB)
    _make_venv(work_root, 'task-39', referenced)

    result = maintenance.enforce_interpreter_pool_limits()

    assert referenced.exists(), 'the referenced version must survive'
    assert not unreferenced.exists(), 'the unreferenced version is reclaimed'
    assert result['reclaimedVersions'] == 1
