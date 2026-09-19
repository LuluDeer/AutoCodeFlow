"""E8: disk TTL reclamation (parity with executor-node file-logger.ts
cleanupWorkDir / deleteOldLogs).

Task workdirs, execution logs, the git clone cache and per-task venvs
previously accumulated forever — a long-running executor slowly filled the
disk until every git/uv operation failed. Strategy (aligned with the 7-day
log-retention policy):

  - execution workdirs (and their embedded <executionId>.log files) past the
    TTL are removed
  - .git_cache entries not touched within TTL are removed
  - .venvs entries not touched within TTL are removed
  - the shared .venvs/.uv-cache package cache (UV_CACHE_DIR in ensure_venv)
    past the TTL is removed, but skipped while a live venv task may be
    installing into it
  - callbacks/dead-letter/ payload files (and their companion .meta) past the
    TTL are removed — dead-lettered callbacks are terminal garbage; without
    this the directory grows unbounded across a long admin-api outage (node
    cleanupWorkDir step 4 filesOnly sweep parity). The rest of callbacks/
    stays protected: in-flight retry files are owned by the E2 retry loop.
  - directories backing a currently-live execution are always skipped (the
    _live_executions registry is consulted through a registered provider —
    importing routers/execute here would create an import cycle, the same
    posture as the heartbeat runningExecutionIds provider)

The periodic sweep runs cleanup_work_dir in a worker thread: the scan is
pure filesystem I/O but a large rmtree can block for seconds, and on the
event loop that would stall heartbeats (the executor could be judged
offline mid-delete).
"""
import asyncio
import logging
import os
import re
import shutil
import threading
import time
from pathlib import Path

from config import settings

try:  # python_task_multiversion（WS3 模块）：回收后刷新探测缓存（NFR-15）
    import interpreters as _interpreters
except ImportError:  # pragma: no cover - 仅并行开发期可达
    _interpreters = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

# node PROTECTED_WORKDIR_NAMES parity: infrastructure entries at the work_dir
# top level that are never treated as task workdirs.
_PROTECTED_WORKDIR_NAMES = {
    'logs', 'meta', 'callbacks', '.git_cache', '.venvs', '.node_modules',
    '.pkg-updates', 'apps',
}


def _interpreter_pool_root() -> Path | None:
    """解释器缓存池根目录（`UV_PYTHON_INSTALL_DIR`），未配置/无效返回 None。

    NFR-15 的**物理隔离**是主防线：默认 `uv_python_install_dir` 指向 work_dir
    之外的独立卷，TTL 清扫天然够不着。这里再做一层显式豁免（defence in
    depth）——部署方把池配进 work_dir 时，清扫仍必须放过它，否则"可复用资产"
    会被当过期任务目录删掉，下次任务重新下载（正是 NFR-15 要避免的）。"""
    raw = getattr(settings, 'uv_python_install_dir', '') or ''
    if not str(raw).strip():
        return None
    try:
        return Path(str(raw)).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None


def _work_dir_root() -> Path:
    """work_dir 的解析后根路径（每次读取，测试可 monkeypatch settings）。"""
    try:
        return Path(settings.work_dir).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return Path(settings.work_dir)


def _protected_interpreter_root() -> Path | None:
    """池根**位于 work_dir 之内**时返回它（此时它是顶层保护名）。

    池在 work_dir 之外时返回 None：那种部署下清扫本来就碰不到它，无需（也不该）
    往保护名单里塞一个外部绝对路径。"""
    pool_root = _interpreter_pool_root()
    if pool_root is None:
        return None
    work_root = _work_dir_root()
    if pool_root == work_root:
        # 配成 work_dir 本身：保护整个 work_dir 等于取消清扫，明显是配置错误，
        # 记一条 error 并**不**保护（否则磁盘治理彻底失效）。
        logger.error(
            'UV_PYTHON_INSTALL_DIR points at WORK_DIR itself (%s); the disk sweep '
            'cannot protect it — configure a dedicated interpreter directory',
            pool_root,
        )
        return None
    try:
        pool_root.relative_to(work_root)
    except ValueError:
        return None  # 物理隔离：池在 work_dir 之外
    return pool_root

# E8: liveness provider — routers/execute registers the live-execution
# snapshot getter at import time (avoids the maintenance <-> routers cycle).
_default_live_entries = []
_live_entries_provider = lambda: _default_live_entries  # noqa: E731
_live_entries_provider_guard = threading.Lock()


def register_live_entries_provider(fn) -> None:
    """Install the getter returning snapshots of live executions.

    Snapshots expose ``execution_id`` (the work_dir subdirectory name) and
    ``task_id`` (the .venvs directory name); anything else is ignored."""
    global _live_entries_provider
    with _live_entries_provider_guard:
        _live_entries_provider = fn


# NETOPT-6②: 在跑执行的池解释器路径 provider —— routers/execute 在
# `_ensure_interpreter` 解析成功后登记、任务结束时注销（进程内 set + 锁），
# main.py lifespan 里与 E8 provider 一起接线。这是池回收的**第二道否决权**：
# glue（AC-11a）与无依赖 python（AC-04c）两条路径把池解释器直接当 cmd[0]
# 跑、不建 venv，`_venv_dependency_homes` 扫不到任何依赖——不查这道 liveness
# 的话，6h 清扫/紧急清扫的 LRU 回收会在任务运行中途把解释器目录 rmtree 掉
# （在跑任务当场断火）。且池目录 mtime 只在安装时写入，越活跃的版本 mtime
# 越老、反而最优先被回收——没有这道否决权，活跃任务恰恰处于最危险的被回收
# 位置（对照 venv 路径：venv 的 pyvenv.cfg home 指向池目录，第一道否决权已覆盖）。
_live_pool_paths_provider = lambda: []  # noqa: E731
_live_pool_paths_provider_guard = threading.Lock()


def register_live_pool_paths_provider(fn) -> None:
    """Install the getter returning pool interpreter paths currently in use by
    running executions（绝对路径，通常为池内版本目录下的 python 可执行文件）。

    与 E8 的 ``register_live_entries_provider`` 同一接线纪律：由 main.py
    lifespan 注入 routers/execute 的快照 getter，避免 maintenance <-> routers
    循环 import。"""
    global _live_pool_paths_provider
    with _live_pool_paths_provider_guard:
        _live_pool_paths_provider = fn


def _live_pool_paths() -> list[str] | None:
    """在跑执行正在使用的池解释器路径快照。

    provider 失败返回 ``None``——调用方必须按「liveness 未知」**fail-closed**
    跳过回收：与 E8 `_live_workdir_names` 同一纪律，liveness 不明时宁可让池
    暂时超红线，也不能赌「没有任务在用」而删掉在跑解释器。"""
    try:
        return [str(p) for p in (_live_pool_paths_provider() or [])]
    except Exception:
        logger.exception('live pool paths provider failed; skipping reclamation')
        return None


def _is_live_pool_path(path: Path, live_paths: list[str]) -> bool:
    """`path` 是否与某个在跑池解释器路径相同或包含它。

    在跑登记的是池目录内的 python 可执行文件（如
    `<pool>/cpython-3.12.11-<plat>-none/python.exe`），回收候选是整个版本
    目录——用「live 路径位于候选目录之内（或相等）」判定，与
    `_venv_dependency_homes` 的 normcase/normpath 键纪律一致（Windows 大小
    写不敏感）。"""
    key = os.path.normcase(os.path.normpath(str(path)))
    for raw in live_paths:
        try:
            live = Path(raw)
        except (OSError, ValueError):  # pragma: no cover - 畸形路径不入集合
            continue
        live_key = os.path.normcase(os.path.normpath(str(live)))
        if live_key == key or _path_within(live, path):
            return True
    return False


def _live_workdir_names():
    """Names under work_dir that back a live execution right now.

    Returns ``None`` when the liveness provider fails: the caller must then
    skip deletions entirely — with unknown liveness, deleting by TTL alone
    could reap a running execution's directory."""
    names: set[str] = set()
    try:
        entries = _live_entries_provider()
    except Exception:
        logger.exception('live entries provider failed; skipping deletions')
        return None
    for entry in entries:
        execution_id = getattr(entry, 'execution_id', None)
        if execution_id:
            names.add(execution_id)
        task_id = getattr(entry, 'task_id', None)
        if task_id:
            names.add(task_id)
    return names


def _remove_path(target: Path) -> bool:
    try:
        shutil.rmtree(target, ignore_errors=False)
        return True
    except OSError as exc:
        logger.warning('Disk cleanup failed for %s: %s', target, exc)
        return False


def _cleanup_dead_letter_files(dead_letter_dir: Path, cutoff: float) -> int:
    """TTL sweep of callbacks/dead-letter/ (node removeOlderThan filesOnly
    parity, QA3).

    ``callbacks`` is in _PROTECTED_WORKDIR_NAMES so the workdir sweep never
    touches it, and the E2 retry loop only manages the *in-flight* files at
    the callbacks/ top level — once a payload is dead-lettered nothing ever
    removed it, so a long admin-api outage grew the backlog without bound.
    Semantics mirror the node sweep and get_dead_letter_count:

      - only regular files are considered (a stray subdirectory is neither
        reclaimed nor recursed into)
      - a payload json older than the cutoff is removed together with its
        companion ``<name>.meta`` (the pair is garbage once the payload is
        reaped, regardless of the meta's own mtime)
      - a stray .meta older than the cutoff is removed when its companion
        json is gone or also expired; a fresh companion keeps the pair
        intact for the json's own sweep

    Returns the number of files removed."""
    deleted = 0
    try:
        entries = [p for p in dead_letter_dir.iterdir() if p.is_file()]
    except OSError:
        return 0  # directory absent (never dead-lettered yet) or raced away
    for path in entries:
        try:
            if path.stat().st_mtime >= cutoff:
                continue
        except OSError:
            continue  # raced with a concurrent delete — skip
        if path.name.endswith('.meta'):
            # Keep the pair consistent: a fresh companion json means the
            # json's own sweep will take this meta with it.
            companion = path.with_name(path.name[:-len('.meta')])
            try:
                if companion.is_file() and companion.stat().st_mtime >= cutoff:
                    continue
            except OSError:
                pass  # stat raced — treat the companion as gone
        elif path.suffix == '.json':
            companion = path.with_name(path.name + '.meta')
            if companion.is_file() and _remove_path_file(companion):
                deleted += 1
        if _remove_path_file(path):
            deleted += 1
    return deleted


def _remove_path_file(target: Path) -> bool:
    """Unlink a single dead-letter file (rmtree would also work on dirs but
    this path only ever holds regular files)."""
    try:
        target.unlink()
        return True
    except OSError as exc:
        logger.warning('Dead-letter cleanup failed for %s: %s', target, exc)
        return False


def _dir_size_bytes(path: Path) -> int:
    """目录递归字节数（不可读项按 0 计——计量失败不该中断清扫）。"""
    total = 0
    for root, _dirs, files in os.walk(path, onerror=lambda _e: None):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                continue
    return total


def _pool_version_entries(pool_root: Path) -> list[tuple[str, Path, int, float]]:
    """池内版本目录 → (name, path, size_bytes, mtime)。目录不存在返回空列表。"""
    entries: list[tuple[str, Path, int, float]] = []
    try:
        children = list(pool_root.iterdir())
    except OSError:
        return entries
    for child in children:
        if not child.is_dir():
            continue
        try:
            mtime = child.stat().st_mtime
        except OSError:
            continue
        entries.append((child.name, child, _dir_size_bytes(child), mtime))
    return entries


def _remove_quietly(target: Path) -> None:
    """删除失败只记日志（回收是 best-effort，磁盘红线不因一次 EACCES 失效）。"""
    try:
        shutil.rmtree(target)
    except OSError as exc:
        logger.warning('Interpreter reclaim failed for %s: %s', target, exc)


# 9-3（audit-r4）：venv 依赖映射缓存 + 指纹失效。enforce_interpreter_pool_limits
# 每 6h 一轮，每轮调用 _venv_dependency_homes 全量读 + 解析全部 pyvenv.cfg；
# 池越大该扫描越贵，而两个清理周期之间 venv 集合几乎不变。改为指纹缓存：
# 指纹由 .venvs 根 mtime + 各 venv 目录的 (name, pyvenv.cfg mtime_ns) 构成
# （stat 级，远轻于 read+parse），指纹未变则直接复用上次映射。任何 venv
# 创建/删除/pyvenv.cfg 变更都会改变指纹，无漏失效风险。
_venv_deps_cache: dict[str, list[str]] | None = None
_venv_deps_fingerprint: tuple | None = None


def _invalidate_venv_deps_cache() -> None:
    """显式清空缓存（TTL 清扫删除 venv 后调用；指纹机制下通常不必要，双保险）。"""
    global _venv_deps_cache, _venv_deps_fingerprint
    _venv_deps_cache = None
    _venv_deps_fingerprint = None


def _venv_deps_fingerprint_now() -> tuple:
    """计算 venv 集合指纹（仅 stat，不读文件内容）。根目录缺失/不可读时返回
    哨兵值——与「扫描结果空」区分开，避免误复用过期缓存。"""
    venv_root = _work_dir_root() / '.venvs'
    try:
        root_mtime = venv_root.stat().st_mtime_ns
    except OSError:
        return ('missing',)
    try:
        children = sorted((d.name for d in venv_root.iterdir() if d.is_dir()))
    except OSError:
        return ('unreadable',)
    parts = [('root', root_mtime)]
    for name in children:
        try:
            cfg_mtime = (venv_root / name / 'pyvenv.cfg').stat().st_mtime_ns
        except OSError:
            cfg_mtime = -1
        parts.append((name, cfg_mtime))
    return tuple(parts)


def _venv_dependency_homes() -> dict[str, list[str]]:
    """`<WORK_DIR>/.venvs/*` 的依赖解释器 home 目录 → 依赖它的 venv 目录名列表。

    **为什么必须有这一步**（lead 实测确认的生产事故类缺陷）：`uv venv` 建出的
    虚拟环境里，`Scripts/python.exe` / `bin/python` 只是一个约 600KB 的 shim，
    真正的解释器仍在缓存池里，依赖关系记在 `pyvenv.cfg` 的
    `home = <UV_PYTHON_INSTALL_DIR>/cpython-<ver>-<platform>-none`。
    池里那个目录一旦被删，该 venv **当场报废**（实测重跑报
    `No Python at '...'`，exit 103），而且报废是静默的：下次任务看到 venv 目录
    还在，会"复用"它，然后在 exec 阶段以一个令人费解的退出码失败——既不是干净
    的 interpreter_unavailable，也违背 AC-16b（同版本 venv 复用）。

    于是"按 mtime 删最久未使用的解释器"这个直觉做法会连带炸掉一批 venv。回收
    必须先回答："还有谁靠这个版本活着？"
    """
    global _venv_deps_cache, _venv_deps_fingerprint
    fp = _venv_deps_fingerprint_now()
    if _venv_deps_cache is not None and fp == _venv_deps_fingerprint:
        return _venv_deps_cache
    homes: dict[str, list[str]] = {}
    venv_root = _work_dir_root() / '.venvs'
    try:
        children = list(venv_root.iterdir())
    except OSError:
        return homes  # 从未建过 venv（或目录不可读）→ 无依赖
    for venv_dir in children:
        if not venv_dir.is_dir():
            continue
        cfg = _read_pyvenv_cfg(venv_dir)
        home = (cfg or {}).get('home')
        if not home:
            continue
        homes.setdefault(os.path.normcase(os.path.normpath(home)), []).append(venv_dir.name)
    _venv_deps_cache = homes
    _venv_deps_fingerprint = fp
    return homes


def _read_pyvenv_cfg(venv_dir: Path) -> dict[str, str] | None:
    """读 `<venv>/pyvenv.cfg` 为 key→value 字典；缺失/损坏返回 None。"""
    try:
        raw = (venv_dir / 'pyvenv.cfg').read_text(encoding='utf-8', errors='replace')
    except (OSError, ValueError):
        return None
    parsed: dict[str, str] = {}
    for line in raw.splitlines():
        if '=' not in line:
            continue
        key, _, value = line.partition('=')
        parsed[key.strip().lower()] = value.strip()
    return parsed or None


def _version_entries_of(pool_root: Path, name: str) -> list[Path]:
    """池内目录 `name` 是否属于某个版本（`cpython-3.8.20-…`）→ 是则返回它。

    这里用"该目录是否被某个 venv 的 home 指向"来判定依赖，因此返回的就是
    可以直接与 home 比对的路径集合。"""
    return [pool_root / name]


def _path_within(path: Path, root: Path) -> bool:
    """`path` 是否严格位于 `root` 之内（含 root 自身为 False）。"""
    try:
        resolved = path.resolve()
        resolved_root = root.resolve()
    except OSError:
        return False
    if resolved == resolved_root:
        return False
    return resolved.is_relative_to(resolved_root)


def _reclaim_interpreter_version(pool_root: Path, path: Path, version_hint: str) -> bool:
    """回收池内一个版本目录。**先做硬安全断言，再删。**

    断言（任一不满足即拒绝删除并返回 False）：
      1. 目标必须严格位于配置的池根之内——绝不因为路径拼接出错删到池外；
      2. 目标不得是池根本身——删掉池根等于把整个缓存层清空。

    删除方式优先 `uv python uninstall <version>`（uv 自己的簿记一并收敛），
    不可用/失败时退回 `rmtree`；两条路径之后都由调用方 `invalidate_cache()`。
    """
    if not _path_within(path, pool_root):
        logger.error(
            'Refusing to reclaim %s: it is not inside the interpreter pool %s',
            path, pool_root,
        )
        return False
    uninstall = getattr(_interpreters, 'uninstall_version', None) if _interpreters is not None else None
    if callable(uninstall) and version_hint:
        try:
            uninstall(version_hint)
            if not path.exists():
                return True
        except Exception as exc:  # noqa: BLE001 - 退回 rmtree
            logger.warning('uv python uninstall %s failed (%s); falling back to rmtree', version_hint, exc)
    _remove_quietly(path)
    return True


def _invalidate_interpreter_cache() -> None:
    """回收后刷新探测缓存（否则心跳继续上报已删除的版本）。"""
    invalidate = getattr(_interpreters, 'invalidate_cache', None) if _interpreters is not None else None
    if callable(invalidate):
        try:
            invalidate()
        except Exception as exc:  # noqa: BLE001 - 缓存刷新失败不影响回收结果
            logger.warning('interpreters.invalidate_cache failed after reclaim: %s', exc)
    else:  # pragma: no cover - 仅并行开发期可达
        logger.warning(
            'interpreters module unavailable — the reported inventory may still '
            'list reclaimed versions until the next restart'
        )


def _pool_dir_version(path: Path) -> str:
    """池目录名 `cpython-3.8.20-<platform>-none` → `3.8.20`；取不到返回 ''。"""
    match = re.match(r'^cpython-(\d+\.\d+(?:\.\d+)?)-', path.name)
    return match.group(1) if match else ''


def _attempt_reclaim(
    pool_root: Path,
    entry: tuple[str, Path, int, float],
    dependency_homes: dict[str, list[str]],
    reason: str,
) -> tuple[bool, int]:
    """尝试回收一个候选版本。返回 (是否已回收, 释放字节数)。

    依赖检查是**否决权**：只要还有 venv 的 home 指向该目录，就绝不回收——
    宁可让池暂时超红线（响亮的告警）也不能把用户的 venv 弄废。"""
    name, path, size, mtime = entry
    # NETOPT-6②：第一道否决权——在跑执行已解析的池解释器。glue（AC-11a）与
    # 无依赖 python（AC-04c）把池解释器直接当 cmd[0] 跑、不建 venv，下面的
    # venv 依赖扫描对它们无能为力；不查这道的话，任务运行中会被 LRU 回收
    # 断火（且活跃版本 mtime 最老、最优先被回收）。provider 失败 = liveness
    # 未知 = fail-closed 全部跳过。
    live_paths = _live_pool_paths()
    if live_paths is None:
        logger.warning(
            'Skipping reclamation of interpreter %s (%s): live-execution pool '
            'path provider failed — liveness unknown, refusing to delete (fail-closed)',
            name, reason,
        )
        return False, 0
    if _is_live_pool_path(path, live_paths):
        logger.warning(
            'Skipping reclamation of interpreter %s (%s): a running execution '
            'has resolved and is using it right now (%s). Deleting it would kill '
            'the running task mid-flight (glue/dependency-free python runs the '
            'pool interpreter directly as cmd[0]).',
            name, reason, ', '.join(live_paths[:5]),
        )
        return False, 0
    key = os.path.normcase(os.path.normpath(str(path)))
    dependents = dependency_homes.get(key) or []
    if not dependents:
        # 依赖也可能记在池内的具体版本目录上（home 指向 cpython-<ver>-<plat>-none）。
        for home_key, names in dependency_homes.items():
            if home_key.startswith(key + os.sep) or home_key == key:
                dependents.extend(names)
    if dependents:
        logger.warning(
            'Skipping reclamation of interpreter %s (%s): %d task venv(s) still depend on it '
            '(%s). Deleting it would brick those venvs (they are shims over this directory).',
            name, reason, len(dependents), ', '.join(sorted(dependents)[:5]),
        )
        return False, 0
    logger.warning(
        'Reclaiming interpreter %s (%d bytes, last used %s, %s) — no task venv depends on it',
        name, size, time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(mtime)), reason,
    )
    if not _reclaim_interpreter_version(pool_root, path, _pool_dir_version(path)):
        return False, 0
    return True, size


def enforce_interpreter_pool_limits() -> dict:
    """NFR-15/D12：解释器池体积红线 + **引用感知的**最久未使用（LRU）回收。

    两条红线（均可配置）：
      * 单版本 > `interpreter_single_version_mb`（默认 250MB）
      * 总池  > `interpreter_total_gb`（默认 4GB）

    触发即**先告警**，再按目录 mtime 升序尝试回收最久未使用的版本，直到重新
    落入红线之内。

    回收有四条硬约束：
      1. **引用感知**（关键正确性）：任何仍被任务 venv 依赖的版本一律跳过
         （venv 的 `bin/python` 只是 shim，真身就是池里那个目录——删了 venv 当场
         报废，见 `_venv_dependency_homes`）。
      2. **超限不可回收时不删任何东西**：全部候选都被 pin 住时，只留一条响亮的
         告警。宁可池暂时超红线，也不能悄悄弄废用户的 venv。
      3. **只碰解释器池**：任务 venv 与 workdir 一概不动（那是 TTL 清扫的职责）。
      4. **在跑执行优先（NETOPT-6②）**：任何在跑执行已解析、正在使用的池解释器
         路径一律跳过——glue（AC-11a）与无依赖 python（AC-04c）不建 venv，约束 1
         的 venv 依赖扫描覆盖不了它们；不查这道的话，活跃版本（mtime 最老）
         恰恰最优先被回收，在跑任务运行中被 rmtree 断火。liveness provider 失败
         时按「未知」fail-closed 全部跳过。

    回收后调用 `interpreters.invalidate_cache()` 让上报清单收敛。"""
    counts = {'reclaimedVersions': 0, 'reclaimedBytes': 0, 'poolBytes': 0,
              'overLimit': 0, 'pinnedVersions': 0}
    pool_root = _interpreter_pool_root()
    if pool_root is None or not pool_root.is_dir():
        return counts

    single_limit = max(1, int(getattr(settings, 'interpreter_single_version_mb', 250) or 250)) * 1024 * 1024
    total_limit = max(1, int(getattr(settings, 'interpreter_total_gb', 4) or 4)) * 1024 ** 3

    entries = _pool_version_entries(pool_root)
    if not entries:
        return counts
    total_bytes = sum(size for _n, _p, size, _m in entries)
    counts['poolBytes'] = total_bytes
    # 依赖快照只取一次：回收过程中 venv 集合不会变（本函数不碰 venv）。
    dependency_homes = _venv_dependency_homes()

    oversized = [e for e in entries if e[2] > single_limit]
    if oversized:
        counts['overLimit'] += len(oversized)
        for entry in oversized:
            name, _path, size, _m = entry
            logger.warning(
                'Interpreter version %s exceeds the per-version limit (%d bytes > %d bytes) (D12/NFR-15)',
                name, size, single_limit,
            )
            reclaimed, freed = _attempt_reclaim(
                pool_root, entry, dependency_homes, 'over per-version limit')
            if reclaimed:
                counts['reclaimedVersions'] += 1
                counts['reclaimedBytes'] += freed
                total_bytes -= freed
            else:
                counts['pinnedVersions'] += 1
        entries = [e for e in entries if e[1].exists()]

    if total_bytes > total_limit:
        counts['overLimit'] += 1
        logger.warning(
            'Interpreter pool %s is over the total limit (%d bytes > %d bytes); '
            'reclaiming least-recently-used versions (D12/NFR-15)',
            pool_root, total_bytes, total_limit,
        )
        # 按目录 mtime 升序 = 最久未使用优先（D12 默认策略）。
        for entry in sorted(entries, key=lambda e: e[3]):
            if total_bytes <= total_limit:
                break
            reclaimed, freed = _attempt_reclaim(
                pool_root, entry, dependency_homes, 'pool over total limit')
            if reclaimed:
                counts['reclaimedVersions'] += 1
                counts['reclaimedBytes'] += freed
                total_bytes -= freed
            else:
                counts['pinnedVersions'] += 1
        if total_bytes > total_limit:
            # 全部候选都被依赖 pin 住：不删任何东西，但必须让人看见。
            logger.warning(
                'Interpreter pool is still over the total limit (%d bytes > %d bytes) — '
                'every candidate version is still referenced by a task venv, so nothing was '
                'reclaimed. Remove the dependent task venvs under %s (or raise '
                'INTERPRETER_TOTAL_GB) to allow reclamation.',
                total_bytes, total_limit, _work_dir_root() / '.venvs',
            )

    if counts['reclaimedVersions']:
        counts['poolBytes'] = max(0, total_bytes)
        _invalidate_interpreter_cache()
    return counts


def cleanup_work_dir(ttl_days: int = None) -> dict:
    """Remove expired task workdirs, git caches and per-task venvs.

    Returns per-category deletion counts (node cleanupWorkDir return shape,
    minus the categories the python executor does not create). Safe to run
    on an interval; skips anything backing a live execution."""
    if ttl_days is None:
        ttl_days = max(1, settings.disk_cleanup_ttl_days)
    cutoff = time.time() - ttl_days * 24 * 60 * 60
    live_names = _live_workdir_names()
    counts = {'workDirs': 0, 'caches': 0, 'venvs': 0, 'deadLetters': 0}
    if live_names is None:
        # liveness unknown — fail safe, delete nothing
        return counts
    base = Path(settings.work_dir)
    # NFR-15 defence in depth：池被配进 work_dir 时，其根目录同样受保护名单
    # 约束（物理隔离是主防线，这里是第二道）。
    protected_pool_root = _protected_interpreter_root()

    try:
        base_entries = list(base.iterdir())
    except OSError:
        return counts

    for entry in base_entries:
        if entry.name in _PROTECTED_WORKDIR_NAMES:
            continue
        if protected_pool_root is not None:
            try:
                if entry.resolve() == protected_pool_root:
                    continue  # 解释器池根：豁免 TTL 清扫（NFR-15）
            except OSError:
                pass
        if entry.name in live_names:
            continue
        try:
            if entry.stat().st_mtime >= cutoff:
                continue
        except OSError:
            continue  # raced with a concurrent delete — skip
        if _remove_path(entry):
            counts['workDirs'] += 1

    # A live venv-backed python task (`.venvs/<task_id>` whose task_id is in the
    # live snapshot) may be running `uv pip install` into the SHARED uv cache
    # right now. We record those task ids so the dedicated .uv-cache sweep below
    # can refuse to reap the cache out from under an in-flight install.
    live_venv_tasks: set[str] = set()
    for cache_dir_name, count_key in (('.git_cache', 'caches'), ('.venvs', 'venvs')):
        cache_root = base / cache_dir_name
        try:
            children = list(cache_root.iterdir())
        except OSError:
            continue
        for child in children:
            if child.name in live_names:
                if cache_dir_name == '.venvs':
                    live_venv_tasks.add(child.name)
                continue
            if cache_dir_name == '.venvs' and child.name == '.uv-cache':
                # The shared uv package cache is swept separately (TTL + live
                # guard) below — never reap it here as if it were a stale venv.
                continue
            try:
                if child.stat().st_mtime >= cutoff:
                    continue
            except OSError:
                continue  # raced with a concurrent delete — skip
            if _remove_path(child):
                counts[count_key] += 1

    # 9-3（audit-r4）：本轮回可能删除了 venv——显式失效依赖映射缓存
    # （指纹机制下删除会自然改变指纹，这里是双保险）。
    if count_key == 'venvs' and counts['venvs'] > 0:
        _invalidate_venv_deps_cache()

    # P2: the shared uv package cache. ensure_venv points UV_CACHE_DIR at
    # `<work_dir>/.venvs/.uv-cache` (venv_dir.parent / '.uv-cache'); it is shared
    # by every requirements-bearing python task and previously accumulated with
    # no explicit TTL governance. Reclaim it on the SAME TTL as .git_cache, but
    # never while a live venv task may be installing into it. Folded into the
    # 'caches' bucket so the cleanup_work_dir return shape stays byte-stable
    # (existing tests assert the exact key set).
    uv_cache_dir = base / '.venvs' / '.uv-cache'
    if not live_venv_tasks:
        try:
            if uv_cache_dir.is_dir() and uv_cache_dir.stat().st_mtime < cutoff:
                if _remove_path(uv_cache_dir):
                    counts['caches'] += 1
        except OSError:
            pass  # raced / unreadable — best-effort reclaim, never fatal

    # QA3 (node cleanupWorkDir step 4 parity): dead-lettered callbacks are
    # terminal — TTL-reclaim them (filesOnly). The callbacks/ top level
    # itself stays protected: those files are in-flight retry state owned
    # by the E2 replay loop.
    counts['deadLetters'] = _cleanup_dead_letter_files(
        base / 'callbacks' / 'dead-letter', cutoff)

    # NFR-15/D12：解释器池**不参与 TTL 清扫**（上面的保护名 + 物理隔离），改由
    # 体积红线治理。放在同一轮里执行：一次定时任务同时管"过期"与"过大"，
    # 运维只需要认识一个磁盘治理入口。
    #
    # 返回值**不并入 counts**：counts 是 node cleanupWorkDir 的返回形状契约
    # （既有 test_maintenance 逐键断言），多一个键就会破坏它。回收结果走日志
    # ——回收/超限本身就是要让运维看见的事。
    try:
        reclaimed = enforce_interpreter_pool_limits()
        if reclaimed['reclaimedVersions'] or reclaimed['overLimit']:
            logger.warning('Interpreter pool enforcement: %s', reclaimed)
    except Exception as exc:  # noqa: BLE001 - 回收失败绝不能中断 TTL 清扫
        logger.error('Interpreter pool enforcement failed: %s', exc)

    return counts


_cleanup_task: asyncio.Task | None = None


# --- 磁盘水位（P2/L-2，对齐 node file-logger.diskUsagePercent）----------------
# TTL 清扫基于 mtime 而非磁盘水位：磁盘在 TTL 窗口内被撑满时没有主动应对。
# 这里补两道防线：告警水位触发减半 TTL 的紧急清理；临界水位由
# execute.accept_execution 拒新任务（同源读取本常量）。
# 阈值来自 settings（DISK_WARN_PERCENT / DISK_CRITICAL_PERCENT，默认 90/95），
# 模块加载时求值——与 pydantic settings 的启动期 env 读取一致。
def _disk_warn_threshold() -> int:
    return max(1, int(getattr(settings, 'disk_warn_percent', 90) or 90))


def _disk_critical_threshold() -> int:
    return max(1, int(getattr(settings, 'disk_critical_percent', 95) or 95))


DISK_WARN_PERCENT = _disk_warn_threshold()
DISK_CRITICAL_PERCENT = _disk_critical_threshold()


def disk_usage_percent(path: str = '') -> float:
    """``path``（缺省 work_dir）所在文件系统的已用百分比（0-100）。

    用 ``shutil.disk_usage`` 的 ``free`` 字段（对非特权用户真实可写空间，
    与 node 侧 ``fs.statfs.f_bavail`` 同口径：used = total - free）。计量失败
    返回 0——调用方按"无压力"处理，不因一次计量失败误拒任务。
    """
    try:
        usage = shutil.disk_usage(path or str(_work_dir_root()))
        if usage.total <= 0:
            return 0.0
        return round((usage.total - usage.free) / usage.total * 100, 1)
    except OSError:
        return 0.0


async def disk_cleanup_task() -> None:
    """Periodic sweep: first run deferred (disk_cleanup_initial_delay_seconds,
    default 10min) so a fresh boot doesn't scan+delete while executions from
    the previous process may still be recovering; then every
    disk_cleanup_interval_seconds (node startWorkDirCleanup cadence, 6h)."""
    logger.info(
        'Disk cleanup task started (ttl=%sd, interval=%ss, first run in %ss)',
        settings.disk_cleanup_ttl_days, settings.disk_cleanup_interval_seconds,
        settings.disk_cleanup_initial_delay_seconds,
    )
    try:
        await asyncio.sleep(settings.disk_cleanup_initial_delay_seconds)
        while True:
            try:
                # QA2: the sweep is blocking filesystem I/O (large rmtree
                # can take seconds) — run it in a worker thread so the
                # event loop keeps serving heartbeats/API (a stalled loop
                # could get the executor judged offline mid-delete).
                counts = await asyncio.to_thread(cleanup_work_dir)
                total = sum(counts.values())
                if total:
                    logger.info('Disk cleanup removed %d item(s): %s', total, counts)
                # P2：磁盘水位（TTL 基于 mtime，磁盘在 TTL 窗口内被撑满时无
                # 主动应对）。告警水位 → 减半 TTL 立即再跑一轮紧急清理（回收刚
                # 生成的过期垃圾）；临界水位 → 除紧急清理外，accept_execution
                # 会拒新任务（同源读取 DISK_CRITICAL_PERCENT）。
                usage = await asyncio.to_thread(disk_usage_percent)
                if usage >= DISK_CRITICAL_PERCENT:
                    logger.error(
                        'Disk usage critical (%.1f%% >= %d%%) — new task accept '
                        'will be refused; running emergency cleanup with reduced TTL',
                        usage, DISK_CRITICAL_PERCENT,
                    )
                    ecounts = await asyncio.to_thread(
                        cleanup_work_dir,
                        max(1, settings.disk_cleanup_ttl_days // 2),
                    )
                    etotal = sum(ecounts.values())
                    if etotal:
                        logger.warning(
                            'Emergency cleanup removed %d item(s): %s', etotal, ecounts)
                elif usage >= DISK_WARN_PERCENT:
                    logger.warning(
                        'Disk usage high (%.1f%% >= %d%%) — consider raising disk '
                        'cleanup budget or adding storage',
                        usage, DISK_WARN_PERCENT,
                    )
            except Exception as exc:  # never let the sweep die
                logger.error('Disk cleanup error: %s', exc)
            await asyncio.sleep(settings.disk_cleanup_interval_seconds)
    except asyncio.CancelledError:
        logger.info('Disk cleanup task stopped')
        raise


def start_disk_cleanup_task() -> None:
    """Idempotent startup (node startWorkDirCleanup parity). Must be called
    from the running event loop (lifespan)."""
    global _cleanup_task
    if _cleanup_task is not None and not _cleanup_task.done():
        return
    _cleanup_task = asyncio.create_task(disk_cleanup_task())


def stop_disk_cleanup_task() -> None:
    """Best-effort cancel (fire-and-forget: cleanup holds no in-flight sends
    that need draining)."""
    global _cleanup_task
    task = _cleanup_task
    if task is not None:
        task.cancel()
        _cleanup_task = None
