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
import shutil
import threading
import time
from pathlib import Path

from config import settings

logger = logging.getLogger(__name__)

# node PROTECTED_WORKDIR_NAMES parity: infrastructure entries at the work_dir
# top level that are never treated as task workdirs.
_PROTECTED_WORKDIR_NAMES = {
    'logs', 'meta', 'callbacks', '.git_cache', '.venvs', '.node_modules',
    '.pkg-updates', 'apps',
}

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

    try:
        base_entries = list(base.iterdir())
    except OSError:
        return counts

    for entry in base_entries:
        if entry.name in _PROTECTED_WORKDIR_NAMES:
            continue
        if entry.name in live_names:
            continue
        try:
            if entry.stat().st_mtime >= cutoff:
                continue
        except OSError:
            continue  # raced with a concurrent delete — skip
        if _remove_path(entry):
            counts['workDirs'] += 1

    for cache_dir_name, count_key in (('.git_cache', 'caches'), ('.venvs', 'venvs')):
        cache_root = base / cache_dir_name
        try:
            children = list(cache_root.iterdir())
        except OSError:
            continue
        for child in children:
            if child.name in live_names:
                continue
            try:
                if child.stat().st_mtime >= cutoff:
                    continue
            except OSError:
                continue  # raced with a concurrent delete — skip
            if _remove_path(child):
                counts[count_key] += 1

    # QA3 (node cleanupWorkDir step 4 parity): dead-lettered callbacks are
    # terminal — TTL-reclaim them (filesOnly). The callbacks/ top level
    # itself stays protected: those files are in-flight retry state owned
    # by the E2 replay loop.
    counts['deadLetters'] = _cleanup_dead_letter_files(
        base / 'callbacks' / 'dead-letter', cutoff)

    return counts


_cleanup_task: asyncio.Task | None = None


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
