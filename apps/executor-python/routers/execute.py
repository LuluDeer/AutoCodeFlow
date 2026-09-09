import asyncio
import hashlib
import json
import logging
import os
import signal
import stat
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from typing import Any, Optional
import scheduler as sched
from auth import verify_token, get_current_token, request_with_self_heal
from admin_api import build_admin_api_url, get_admin_api_base_url
from config import settings
from execution_callback_token import CALLBACK_TOKEN_GRACE_SECONDS, create_execution_callback_token
from manifest import load_manifest, merge_task_with_manifest
from artifacts import gather_artifacts_for_callback, artifacts_dir_for
try:
    from autocodeflow_sdk.models import ExecuteRequest
except ImportError:
    # Fallback if SDK is not installed — define locally for compatibility
    from pydantic import BaseModel
    from typing import Dict
    class ExecuteRequest(BaseModel):  # type: ignore[no-redef]
        executionId: str
        task: Dict[str, Any]
        params: Optional[Dict[str, Any]] = None


def _repo_dir_name(repo_url: str) -> str:
    """Convert git URL to a safe cache directory name (last segment, strip .git suffix).

    R4-C P2: the name is salted with a URL hash. Sanitization alone maps distinct
    repos (e.g. https://host/a/b.git and https://host/a_b.git) onto the same cache
    directory, silently checking out the wrong repo (cross-repo contamination).
    Mirrors executor-node repoDirName(): `<cleaned>-<sha256(repo_url)[:12]>`.
    """
    name = repo_url.rstrip('/').split('/')[-1]
    name = re.sub(r'\.git$', '', name)
    name = re.sub(r'[^a-zA-Z0-9_.-]', '_', name)
    salt = hashlib.sha256(repo_url.encode('utf-8')).hexdigest()[:12]
    return f'{name}-{salt}'


def _is_bare_git_repo(cache_dir: Path) -> bool:
    """W-23 (windows-findings): validity probe for the clone cache. A process
    kill (taskkill /F, OOM) mid-clone leaves a partial directory behind; the
    old `cache_dir.exists()` check then took the FETCH branch forever and every
    later checkout of that task failed permanently. `HEAD` first (cheap, and
    keeps `rev-parse` from walking up into an unrelated outer repo), then ask
    git itself."""
    if not (cache_dir / 'HEAD').exists():
        return False
    try:
        r = subprocess.run(['git', '-C', str(cache_dir), 'rev-parse', '--is-bare-repository'],
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0 and r.stdout.strip() == 'true'
    except Exception:
        return False


def _quarantine_broken_cache(cache_dir: Path) -> None:
    """Move a corrupt cache aside instead of deleting it: keeps the forensic
    state, and dodges Windows EBUSY on a directory a just-killed process may
    still hold open (a failed rmtree would leave the permanent-failure state
    we are trying to heal). The E8 disk TTL sweep can reclaim *.git_cache
    entries past the retention window (*-broken ones included) later; until
    then a stale partial clone costs only disk."""
    broken = cache_dir.with_name(cache_dir.name + f'-broken-{int(time.time())}')
    try:
        cache_dir.rename(broken)
    except OSError:
        shutil.rmtree(cache_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# E6 (node routes/execute.ts gitCacheQueues parity): per-repo locks around the
# shared .git_cache/<repo> directory. Concurrent executions of the same repo
# would race `git clone --bare` / `git fetch --all` into the same cache and
# the losing side fails the whole execution. threading.Lock (not asyncio.Lock)
# for the same reason as _live_lock below: the checkout runs in an executor
# thread via run_in_executor, and a threading.Lock is loop-agnostic, while an
# asyncio.Lock binds to whichever loop first awaited it (breaking the
# per-test asyncio.run loops used across this suite).
# ---------------------------------------------------------------------------
_git_cache_locks: dict[str, threading.Lock] = {}
_git_cache_locks_guard = threading.Lock()


def _get_git_cache_lock(cache_key: str) -> threading.Lock:
    """Atomically fetch-or-create the per-repo cache lock."""
    with _git_cache_locks_guard:
        lock = _git_cache_locks.get(cache_key)
        if lock is None:
            lock = threading.Lock()
            _git_cache_locks[cache_key] = lock
        return lock


def git_checkout_to(repo_url: str, ref: str, dest: Path) -> None:
    """Clone (with cache) and checkout the specified ref to the dest directory.

    E6: the clone/fetch phase is serialized per cache directory so concurrent
    executions sharing a repo queue instead of corrupting the cache; the
    final checkout (`--work-tree` export) only reads the cache and is left
    outside the critical section (node queues the whole body; keeping the
    export outside shortens the hold time without adding a race the
    bare-repo probe cannot already heal)."""
    _validate_git_ref(ref)
    cache_dir = Path(settings.work_dir) / '.git_cache' / _repo_dir_name(repo_url)
    with _get_git_cache_lock(str(cache_dir)):
        _git_checkout_to_locked(repo_url, cache_dir, ref, dest)


def _git_checkout_to_locked(repo_url: str, cache_dir: Path, ref: str, dest: Path) -> None:
    """Clone/fetch phase — caller holds the per-repo cache lock."""
    if cache_dir.exists() and not _is_bare_git_repo(cache_dir):
        logger.warning('git cache %s is not a valid bare repo (killed clone?) — quarantining and re-cloning', cache_dir)
        _quarantine_broken_cache(cache_dir)
    if not cache_dir.exists():
        cache_dir.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(['git', 'clone', '--bare', repo_url, str(cache_dir)],
                           check=True, timeout=120)
        except Exception:
            # A failed clone leaves a partial bare repo behind; the existence
            # check above would then skip re-cloning forever.
            shutil.rmtree(cache_dir, ignore_errors=True)
            raise
    else:
        subprocess.run(['git', '-C', str(cache_dir), 'fetch', '--all'],
                       check=True, timeout=60)
    dest.mkdir(parents=True, exist_ok=True)
    # --work-tree + checkout exports files at the given ref to dest
    subprocess.run(
        ['git', f'--git-dir={cache_dir}', f'--work-tree={dest}',
         'checkout', ref, '--', '.'],
        check=True, timeout=30,
    )

router = APIRouter()
logger = logging.getLogger(__name__)


def _refine_failure_reason(message: str) -> Optional[str]:
    """BUG-10：从 prepare/运行期异常文本归类细粒度 failureReason。

    对齐 admin ExecutionFailureReason 与 node 侧 prepareFailureReason 的
    细化规则：git 拉取 / 依赖安装（uv venv + uv pip install）/ 运行时缺失
    （uv/git/python 可执行文件不存在）。返回 None 表示不设 reason，交给
    admin 端 inferFailureReason 兜底（旧语义不变）。
    """
    if not message:
        return None
    lowered = message.lower()
    if "git" in lowered and (
        re.search(r"git.{0,40}(clone|fetch|checkout)", lowered)
        or re.search(r"'git'.{0,80}returned non-zero", lowered)
    ):
        return "git_fetch_failed"
    if re.search(
        r"uv (pip install|venv) (install )?failed|uv venv timed out|pip install failed"
        r"|dependency installation failed",
        lowered,
    ):
        return "dependency_install_failed"
    if re.search(
        r"no such file or directory.{0,60}(uv|git|python3?)"
        r"|spawn .*enoent|runtime.{0,20}not (supported|available)",
        lowered,
    ):
        return "runtime_missing"
    return None


def _executor_callback_address() -> str:
    return settings.executor_address_public or settings.executor_address or f'127.0.0.1:{settings.port}'


def _get_admin_api_url() -> str:
    """Get the appropriate Admin API base URL for execution callbacks."""
    return get_admin_api_base_url()


def _get_callback_token() -> str:
    """Return the shared token used to authenticate execution callbacks."""
    return settings.executor_shared_token or settings.executor_secret


# uv executable path (prefer PATH; Dockerfile installs to /root/.cargo/bin/uv)
UV_BIN = shutil.which('uv') or '/root/.local/bin/uv'

# Timeouts for the two uv phases (module-level so tests can shrink them)
UV_VENV_TIMEOUT_SECONDS = 60
UV_PIP_TIMEOUT_SECONDS = 300

# R4-C P1: bounds for task output handling.
# - In-memory accumulation of stdout/stderr is capped: a `while true; echo` task
#   previously grew `log_chunks` without limit and could OOM the whole executor.
# - The on-disk log file (LOG-01 backfill source) is capped separately and
#   receives data in buffered batches instead of one flush per line.
MAX_LOG_MEMORY_CHARS = 10_000_000            # ~10 MB of accumulated task output
MAX_LOG_FILE_BYTES = 64 * 1024 * 1024        # disk log ceiling
_LOG_FLUSH_EVERY_LINES = 64                  # batch file writes; don't flush per line

# R4-C P2: callback payload guards (admin DTO: errorMessage MaxLength 4096,
# logs MaxLength 512_000 — the 10k log truncation below covers logs).
MAX_ERROR_MESSAGE_CHARS = 4000
CALLBACK_RETRY_ATTEMPTS = 3
CALLBACK_RETRY_BASE_DELAY_SECONDS = 1.0

# R4-C P3: task-declared timeouts are clamped (negative/0 would insta-kill the
# task; astronomic values pin the execution slot for effectively forever).
MAX_TASK_TIMEOUT_SECONDS = 86400

# SEC-01: module-level whitelist so tests can import and verify it
_ENV_WHITELIST = {
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'PYTHONPATH', 'PYTHONHASHSEED', 'VIRTUAL_ENV',
    'NODE_PATH', 'TMPDIR', 'TEMP', 'TMP',
    'USER', 'LOGNAME', 'SHELL',
    # R-04 (windows-findings): parity with executor-node's ENV_WHITELIST —
    # Windows system vars (node side already had them) plus home/identity
    # vars. Without USERPROFILE/HOMEDRIVE/HOMEPATH the child's
    # os.path.expanduser('~') returns the literal '~' (breaks pip/npm/git
    # caches); without USERNAME getpass.getuser() raises KeyError. Paths, not
    # secrets — same class as USER/LOGNAME/HOME on POSIX.
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
    'APPDATA', 'LOCALAPPDATA', 'ProgramData',
}


def _build_child_env() -> dict:
    """SEC-01: whitelist-filtered copy of os.environ for the task child.
    W-20 (windows CI): Windows environment blocks are case-insensitive and
    OS/launchers spell keys their own way (`Path`, `TEMP`, `PROGRAMDATA`…).
    An exact-key match silently dropped such vars on real Windows hosts —
    e.g. no PATH reaching the child breaks every PATH-dependent task. On
    win32 we therefore match case-insensitively and forward under a stable
    upper-case key (child processes read them case-insensitively anyway).
    POSIX envs are case-sensitive: exact matching preserved.
    """
    if sys.platform == 'win32':
        wl_upper = {w.upper() for w in _ENV_WHITELIST}
        return {k.upper(): v for k, v in os.environ.items() if k.upper() in wl_upper}
    return {k: v for k, v in os.environ.items() if k in _ENV_WHITELIST}

# R4-C P0 (parity with executor-node 6062bee deploy.ts SAFE charset): shell
# runtime entrypoints come straight from task parameters. Any shell
# metacharacter here is a command-injection vector, so restrict to a safe set
# (no ; & | ` $ ( ) < > " ' # newlines, ...).
_SHELL_ENTRYPOINT_SAFE_RE = re.compile(r'[A-Za-z0-9._/ :\\-]+')


def _validate_shell_entrypoint(entrypoint: str) -> str:
    if not isinstance(entrypoint, str) or not _SHELL_ENTRYPOINT_SAFE_RE.fullmatch(entrypoint):
        raise HTTPException(
            status_code=400,
            detail='Refusing shell entrypoint with unsafe characters; allowed charset is [A-Za-z0-9._/ :\\-]',
        )
    return entrypoint


def _spawn_kwargs_for_platform() -> dict:
    """W-02 (windows-findings): POSIX detaches each task into its own process
    group via preexec_fn=os.setsid so the timeout kill can take the whole
    tree down. Windows has no setsid/process groups and asyncio rejects
    preexec_fn there outright — accessing os.setsid on win32 raised
    AttributeError and every real task failed. The equivalent isolation is
    CREATE_NEW_PROCESS_GROUP; tree kill on timeout uses taskkill /T /F.
    """
    if sys.platform == 'win32':
        return {
            'creationflags': (
                subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
            ),
        }
    return {'preexec_fn': os.setsid}


def _build_shell_cmd(work_dir: Path, entrypoint: str) -> list[str]:
    """Build the shell-runtime command.

    R4-C P0: the old form
        ['bash', '-c', f'cd "{work_dir}" && exec "{entrypoint}"']
    interpolated task-controlled strings into a `bash -c` script — a single
    `"` in the entrypoint broke out of the quoting and gave arbitrary command
    execution. Two independent guards now:
      1. the character whitelist above (fail fast, mirrors executor-node);
      2. positional parameters — `bash -c 'cd "$1" && exec "$2"' _ <workdir> <entrypoint>`
         passes work_dir/entrypoint as $1/$2 so nothing is ever parsed as
         shell syntax, even if a safe-looking value behaves unexpectedly.
    """
    _validate_shell_entrypoint(entrypoint)
    if sys.platform == 'win32':
        # W-09: cmd.exe treats a leading `./` as a command named `.` and reads
        # `/` as an option delimiter — the POSIX-style `./script.sh` that
        # admins commonly submit fails outright (`'.' 不是内部或外部命令`).
        # Normalize to a backslash relative path; the spawn's cwd=work_dir
        # resolves it.
        ep = entrypoint[2:] if entrypoint.startswith('./') else entrypoint
        return ['cmd.exe', '/c', ep.replace('/', '\\')]
    return ['bash', '-c', 'cd "$1" && exec "$2"', 'bash', str(work_dir), entrypoint]


def _validate_git_ref(ref: str) -> str:
    """R4-C P3: option-injection guard for `git checkout <ref>`.

    Arguments are already array-passed (no shell), but a ref like `-b` or
    `--orphan` would still be parsed as a git option. Mirrors deploy.ts:
    reject leading '-' and restrict to a ref-safe charset.
    """
    if not ref or ref.startswith('-') or not re.fullmatch(r'[A-Za-z0-9._/\-]+', ref):
        raise HTTPException(status_code=400, detail=f'Invalid git ref: {ref}')
    return ref


def _validate_requirements(requirements: list[str]) -> None:
    """R4-C P3: uv receives requirement strings as argv (no shell involved),
    so the only injection vector is a leading '-' being parsed as a uv option
    (`--index-url http://evil` hijacks the package index). Reject anything
    option-shaped before it reaches `uv pip install`.
    """
    for spec in requirements:
        if not isinstance(spec, str) or not spec.strip() or spec.strip().startswith('-'):
            raise HTTPException(
                status_code=400,
                detail=f'Invalid requirement (options are not allowed): {spec!r}',
            )


def _clamp_timeout_seconds(value: Any, default: int) -> int:
    """Clamp the task-declared timeout into [1, 86400] seconds."""
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(seconds, MAX_TASK_TIMEOUT_SECONDS))


def _ensure_entrypoint_in_workdir(entrypoint: str, work_dir: Path) -> None:
    """R4-C P3: reject entrypoints that escape the execution work directory
    (`../evil.sh`, or absolute paths pointing elsewhere). Glue scripts run via
    absolute paths *inside* work_dir, so those remain allowed.
    """
    p = Path(entrypoint)
    # W-04 (windows-findings): on win32 `/etc/passwd` and `\Windows\...` are
    # NOT is_absolute() — ntpath requires a drive/UNC prefix — so the old
    # check let rooted escapes through unchallenged. Any leading separator is
    # treated as absolute on every platform (POSIX semantics unchanged).
    if p.is_absolute() or entrypoint.startswith(('/', '\\')):
        try:
            p.relative_to(work_dir)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f'entrypoint escapes the execution work directory: {entrypoint}',
            )
    elif '..' in p.parts:
        raise HTTPException(
            status_code=400,
            detail=f'entrypoint escapes the execution work directory: {entrypoint}',
        )


def _truncate_error_message(message: Any, limit: int = MAX_ERROR_MESSAGE_CHARS) -> Any:
    """R4-C P2: admin's CallbackItemDto caps errorMessage at 4096 chars; a
    longer value makes ParseArrayPipe reject the whole batch (result lost).
    Truncate before sending."""
    if isinstance(message, str) and len(message) > limit:
        return message[:limit] + f' ...[error truncated, total {len(message)} chars]'
    return message


def _truncate_logs(text: str) -> str:
    """Truncate logs to the callback payload size, keeping head and tail."""
    max_length = 10000
    if len(text) <= max_length:
        return text
    half = max_length // 2
    return f'{text[:half]}\n...[truncated, total {len(text)} chars]...\n{text[-half:]}'


def _build_callback_logs(
    log_chunks: list[str],
    captured_truncated: bool,
    log_file: Path,
) -> str:
    """Join the bounded in-memory chunks into the callback payload text."""
    text = ''.join(log_chunks)
    if captured_truncated:
        # Marker format matches admin LOG-01 backfill detection
        # (/\[\s*(?:logs\s+)?truncated\b/i) so the full disk log gets backfilled.
        text += (
            f'\n...[logs truncated in memory after {MAX_LOG_MEMORY_CHARS} chars; '
            f'full output on disk: {log_file.name}]...'
        )
    return _truncate_logs(text)


# R4-C P2: the event loop only holds weak references to asyncio tasks — keep
# strong references here so a queued execution cannot be GC'd mid-run.
_background_tasks: set['asyncio.Task'] = set()


# ---------------------------------------------------------------------------
# E1/E7/E4/E5 (CONSISTENCY round, parity with executor-node liveExecutions):
# module-level registry of accepted-but-not-yet-terminal executions, keyed by
# executionId. Registered at /execute accept time (so prepare-stage executions
# — git clone + venv, up to ~600s — are covered by admin's heartbeat liveness
# protection), removed when the terminal callback path completes or the kill
# endpoint finalizes a not-yet-spawned execution. A threading.Lock guards the
# dict: every mutation is synchronous with no awaits inside the critical
# section, which makes check-and-register atomic for asyncio callers *and*
# safe if a helper is ever invoked from a worker thread / second loop
# (asyncio.Lock would bind to the first loop and break the per-test
# asyncio.run loops used across this suite).
# ---------------------------------------------------------------------------

class _LiveExecution:
    """One accepted, not-yet-terminal execution (node ExecutionEntry parity)."""

    __slots__ = ('execution_id', 'task_id', 'cancelled', 'killed_by_request',
                 'killed_callback_pushed', 'proc', 'traceparent')

    def __init__(self, execution_id: str):
        self.execution_id = execution_id
        # E6/E8: request-level task id (node ExecutionEntry.taskId parity) —
        # the per-task serialization key, and the .venvs/<task_id> name the
        # E8 disk sweep must not reclaim while an execution is live.
        self.task_id: Optional[str] = None
        # kill 已下达（排队/prepare 路径）：run_task 检查点据此静默退出
        self.cancelled = False
        # kill 端点已下达终止指令（运行中路径）：失败回调据此标记
        # failureReason=killed
        self.killed_by_request = False
        # killed 失败回调已推送（kill 端点与 _run_and_callback 共用防双推）
        self.killed_callback_pushed = False
        # 已 spawn 的任务子进程（asyncio subprocess），供 kill/停机树杀使用
        self.proc = None
        # OBS-01: dispatch 请求的 W3C traceparent 头（admin OTEL_ENABLED=false
        # 时缺省）——注入任务 env AUTOFLOW_TRACE_ID 并随回调回传。
        self.traceparent: Optional[str] = None


_live_executions: dict[str, _LiveExecution] = {}
_live_lock = threading.Lock()


def register_live_execution(execution_id: str) -> Optional['_LiveExecution']:
    """Atomically add executionId to the live registry.

    Returns the entry, or ``None`` when the id is already active — the
    duplicate-accept guard (E7, node execute.ts ``liveExecutions.has``)."""
    with _live_lock:
        if execution_id in _live_executions:
            return None
        entry = _LiveExecution(execution_id)
        _live_executions[execution_id] = entry
        return entry


def unregister_live_execution(execution_id: str) -> None:
    with _live_lock:
        _live_executions.pop(execution_id, None)


def get_live_execution(execution_id: str) -> Optional['_LiveExecution']:
    with _live_lock:
        return _live_executions.get(execution_id)


def execution_exists(execution_id: str) -> bool:
    """execution 是否在本执行器的运行表中（重复领取检查用，测试导出）。"""
    with _live_lock:
        return execution_id in _live_executions


def list_active_execution_ids() -> list[str]:
    """当前运行表中所有 executionId（心跳活性上报用，E1）。"""
    with _live_lock:
        return list(_live_executions.keys())


def list_live_execution_entries() -> list['_LiveExecution']:
    """当前运行表条目快照（E8：磁盘清理的活跃目录保护 provider 数据源）。

    entry 上的 execution_id / task_id 由调用方 duck-typing 读取，避免
    maintenance 反向 import 本模块。"""
    with _live_lock:
        return list(_live_executions.values())


def _get_task_lock(task_id: str) -> asyncio.Lock:
    """E6 (node task-worker.ts maxConcurrentPerTask=1 parity): the per-task
    execution lock — same-task executions queue here instead of racing
    (prepare + venv + run are not safe to run concurrently for one task).

    asyncio.Lock 绑定"第一次 await 它"的事件循环；本套件每个测试都用
    asyncio.run 起独立循环，模块级单例锁会在第二个循环上抛 RuntimeError
    （这正是 _live_executions 注册表用 threading.Lock 的原因）。因此锁字典
    按当前运行循环分桶，循环切换时整体失效重建：生产环境只有一个循环，
    行为不变；测试环境每个循环拿到干净的一组锁。dict 读写全程无 await，
    threading.Lock 保证跨线程安全——与注册表同一加锁模式。"""
    global _task_locks, _task_locks_loop
    loop = asyncio.get_running_loop()
    with _task_locks_guard:
        if _task_locks_loop is not loop:
            _task_locks = {}
            _task_locks_loop = loop
        lock = _task_locks.get(task_id)
        if lock is None:
            lock = asyncio.Lock()
            _task_locks[task_id] = lock
        return lock


_task_locks: dict[str, asyncio.Lock] = {}
_task_locks_loop = None
_task_locks_guard = threading.Lock()


def _derive_task_key(req: ExecuteRequest) -> str:
    """QA4: the ONE derivation of the per-task key. Every consumer — the E6
    per-task lock, the E8 live-protection snapshot (``entry.task_id``, i.e.
    the ``.venvs/<id>`` name the disk sweep must not reclaim) and the
    ``.venvs/<id>`` directory itself — must use this exact value.

    Derives from the REQUEST task payload before any manifest merge
    (dispatch-time semantics; no security meaning, serialization only). A
    missing / None / empty-string id falls back to executionId; a non-string
    id (e.g. int) is stringified. Previously the lock fell back on empty
    ids while the venv path used the merged ``task.get('id', executionId)``
    verbatim: an empty task.id collapsed the venv onto the ``.venvs`` root
    itself while the lock and the E8 protection set keyed off a different
    name (and a manifest-only id desynchronised the two entirely)."""
    task = req.task if isinstance(req.task, dict) else {}
    return str(task.get('id') or req.executionId)


# E1: heartbeat enrichment — scheduler cannot import this module (cycle), so
# the data owner registers the getter (node STALE-01 parity).
sched.register_running_execution_ids_provider(list_active_execution_ids)


async def _kill_process_tree(proc) -> None:
    """B-06/W-02: kill a task child and its whole process tree.

    POSIX: the child was spawned with ``preexec_fn=os.setsid`` (its own
    process group), so ``killpg`` takes down grandchildren too. Windows has
    no process groups — ``taskkill /T /F`` walks the pid tree (mirrors
    executor-node killProcessTree). Extracted from the timeout handler so the
    kill endpoint (E4) and shutdown (E5) reuse the exact same platform
    branches.
    """
    if proc.pid is None:
        return
    if sys.platform == 'win32':
        try:
            killer = await asyncio.create_subprocess_exec(
                'taskkill', '/T', '/F', '/PID', str(proc.pid),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(killer.wait(), timeout=5)
        except Exception:
            pass
        # The tree kill above usually reaps the child first; killing an
        # already-closed transport raises ProcessLookupError on win32.
        try:
            proc.kill()
        except (ProcessLookupError, OSError):
            pass
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, OSError):
            try:
                proc.kill()
            except (ProcessLookupError, OSError):
                pass


async def kill_running_task_processes() -> int:
    """E5 (parity with executor-node main.ts killRunningTaskProcesses):
    tree-kill every task process still registered at shutdown so detached
    children don't outlive the executor as unmanaged orphans. Returns the
    number of process trees killed."""
    with _live_lock:
        entries = [e for e in _live_executions.values() if e.proc is not None]
    killed = 0
    for entry in entries:
        proc, entry.proc = entry.proc, None
        if proc is None:
            continue
        try:
            await _kill_process_tree(proc)
            killed += 1
        except Exception:  # pragma: no cover - already-dead children
            pass
    return killed


async def await_background_tasks_after_kill(timeout_seconds: float | None = None) -> int:
    """QA8 (shutdown ordering): after the tree-kill, give the surviving
    ``_run_and_callback`` workers a bounded window to deliver (or persist)
    their terminal callbacks BEFORE the process exits.

    ``kill_running_task_processes`` only kills OS processes — the worker
    coroutine observes the child's exit afterwards and only then produces
    the terminal callback. The shutdown sequence used to go straight from
    the kill to ``stop_callback_retry_task`` (which drains only the
    persisted-file REPLAY loop) and exit, so these live callbacks were
    neither delivered nor persisted: the execution stayed RUNNING on admin
    until the stale sweep repaired it, and the real killed/timeout
    classification was lost.

    Workers still pending when the window expires are cancelled — with the
    CancelledError persistence guard in ``_run_and_callback`` their payloads
    still reach disk for the next process's replay. Returns the number of
    workers that finished within the window. (``timeout_seconds`` defaults
    at call time to CALLBACK_DRAIN_TIMEOUT_SECONDS — the constant is defined
    further down in this module.)"""
    window = timeout_seconds if timeout_seconds is not None else CALLBACK_DRAIN_TIMEOUT_SECONDS
    # isinstance guard: only real asyncio Tasks are awaitable/cancellable —
    # tests may leave stub handles in the set, and a stray non-Task entry must
    # not crash shutdown.
    pending = [t for t in list(_background_tasks)
               if isinstance(t, asyncio.Task) and not t.done()]
    if not pending:
        return 0
    done, still_pending = await asyncio.wait(pending, timeout=window)
    if still_pending:
        for t in still_pending:
            t.cancel()
        await asyncio.gather(*still_pending, return_exceptions=True)
    return len(done)


@router.post('/execute', dependencies=[Depends(verify_token)])
async def execute(req: ExecuteRequest, request: Request = None):
    if sched.get_running_count() >= settings.max_concurrent_tasks:
        raise HTTPException(status_code=429, detail='Executor is at capacity')

    # E7: duplicate-accept guard (node execute.ts:339-342 parity) — a still
    # live (queued/prepare/running) executionId must never be accepted twice:
    # the second background task would double-count capacity and double-callback
    # the same execution (the 429→BullMQ retry chain can otherwise re-dispatch
    # an execution whose first attempt is merely slow, not lost).
    entry = register_live_execution(req.executionId)
    if entry is None:
        raise HTTPException(
            status_code=400,
            detail=f'Execution {req.executionId} is already active on this executor',
        )

    # OBS-01: 记录 admin 派发请求的 W3C traceparent 头（缺省=无追踪），
    # 注入任务 env AUTOFLOW_TRACE_ID 并随回调回传关联。
    if request is not None:
        traceparent_header = request.headers.get('traceparent')
        if traceparent_header:
            entry.traceparent = traceparent_header
            logger.info('Execution %s trace: %s', req.executionId,
                        traceparent_header.split('-')[1] if '-' in traceparent_header else 'malformed')

    sched.increment_running()
    bg_task = asyncio.create_task(_run_and_callback(req, entry))
    _background_tasks.add(bg_task)
    bg_task.add_done_callback(_background_tasks.discard)
    return {
        'status': 'accepted',
        'executionId': req.executionId,
        'executorAddress': _executor_callback_address(),
    }


async def _send_callback_with_retry(url: str, payload: dict, token: Optional[str]) -> bool:
    traceparent_headers: dict = {}
    if payload.get('traceparent'):
        # OBS-01: 回传 traceparent 头（admin execution-callback.controller
        # 解析关联）；头与载荷字段同值，载荷字段 admin DTO whitelist 剥离。
        traceparent_headers = {'traceparent': payload['traceparent']}
    """POST the execution callback with bounded retries.

    R4-C P2: the original fired exactly one request and only logged transport
    failures — a transient admin-api blip silently lost the execution result
    (only the admin-side zombie sweeper could repair state). 4xx responses
    (except 401/408/429) are terminal: the payload itself is being rejected,
    so retrying would just hammer admin-api forever.

    E3 (parity with executor-node admin-client.request R10 gap #3): the send
    goes through ``request_with_self_heal`` — a 401 (admin rotated our
    per-executor token out from under us) triggers ONE immediate re-fetch +
    retry instead of being dropped. 401 is therefore no longer in the
    non-retryable branch: if the heal did not turn it into a success (admin
    unreachable / token unchanged), the persistent 401 falls through to the
    bounded retry loop like any other transient failure. The 3-attempt +
    exponential-backoff shape is unchanged.
    """
    last_error: Exception | None = None
    for attempt in range(1, CALLBACK_RETRY_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await request_with_self_heal(
                    client,
                    'post',
                    url,
                    token=token,
                    headers=traceparent_headers or None,
                    json=[payload],
                )
            if response.status_code < 400:
                return True
            if (400 <= response.status_code < 500
                    and response.status_code not in (401, 408, 429)):
                logger.error('Callback rejected with HTTP %s (non-retryable); giving up', response.status_code)
                # E2: terminal rejection still loses the result unless it is
                # persisted — replay will re-confirm or dead-letter it.
                _persist_giving_up(payload, url)
                return False
            last_error = RuntimeError(f'callback failed with HTTP {response.status_code}')
            logger.warning('Callback attempt %d/%d failed: HTTP %s',
                           attempt, CALLBACK_RETRY_ATTEMPTS, response.status_code)
        except Exception as exc:
            last_error = exc
            logger.warning('Callback attempt %d/%d failed: %s', attempt, CALLBACK_RETRY_ATTEMPTS, exc)
        if attempt < CALLBACK_RETRY_ATTEMPTS:
            await asyncio.sleep(CALLBACK_RETRY_BASE_DELAY_SECONDS * (2 ** (attempt - 1)))
    logger.error('Failed to send execution callback after %d attempts: %s',
                 CALLBACK_RETRY_ATTEMPTS, last_error)
    # E2 (node persistFailedCallbacks parity): retries exhausted — park the
    # payload on disk for the background re-send loop instead of losing the
    # execution result to a transient admin-api outage.
    _persist_giving_up(payload, url)
    return False


# ---------------------------------------------------------------------------
# E2 (parity with executor-node callback.ts): callback persistence + a
# background re-send loop + dead-lettering. When the bounded retry loop above
# is exhausted, the payload is written to <workDir>/callbacks/callback-*.json
# and a companion `<file>.meta` tracks the retry rounds; a background task
# periodically replays those files and moves them to callbacks/dead-letter/
# after CALLBACK_FILE_MAX_RETRIES failed rounds. Terminal results therefore
# survive executor restarts instead of being silently lost during a
# transient admin-api outage.
#
# Token policy (verified against node persistFailedCallbacks: node never
# stores credentials either — it queues the payload before post() added the
# Authorization header): the bearer token is deliberately NOT persisted. It
# is a dynamic per-executor credential that admin may rotate at any time;
# replay re-signs each request with the token that is valid at replay time
# (auth.get_current_token, falling back to the shared token), mirroring how
# fresh live callbacks are authenticated.
# ---------------------------------------------------------------------------

CALLBACK_FILE_MAX_RETRIES = 5            # replay rounds before dead-lettering
CALLBACK_FILE_MAX_SIZE_BYTES = 64 * 1024 * 1024   # oversized payload guard
CALLBACK_RETRY_SWEEP_INTERVAL_SECONDS = 1.0
CALLBACK_DRAIN_TIMEOUT_SECONDS = 10.0    # node stopCallbackThread drain cap
# E2: per-file exponential backoff between replay rounds (base * 2**retries,
# capped). Base 1s matches node's 1s re-send cadence for a fresh failure;
# later rounds back off instead of hammering a down admin-api every second.
CALLBACK_REPLAY_BACKOFF_BASE_SECONDS = 1.0
CALLBACK_REPLAY_BACKOFF_MAX_SECONDS = 60.0
DEAD_LETTER_COUNT_CACHE_TTL_SECONDS = 60.0

_callback_retry_task: Optional['asyncio.Task'] = None
_callback_retry_stop = threading.Event()
_callback_persistence_sequence = 0
_persistence_sequence_lock = threading.Lock()
# Dead-letter backlog cache: the retry sweep refreshes it every pass, so the
# heartbeat (and anything else) can read the count without rescanning the
# directory. [count, monotonic timestamp]; count < 0 = cache invalid.
_dead_letter_count_cache: list = [-1, 0.0]


def _callback_dir() -> Path:
    d = Path(settings.work_dir) / 'callbacks'
    d.mkdir(parents=True, exist_ok=True)
    return d


def _dead_letter_dir() -> Path:
    d = _callback_dir() / 'dead-letter'
    d.mkdir(parents=True, exist_ok=True)
    return d


def _refresh_dead_letter_count() -> None:
    """Recount dead-letter files and stamp the cache. QA9: this is the only
    cache maintenance point — every dead-letter move happens inside
    retry_persisted_callbacks, which ends with this refresh on each sweep
    (1s cadence), so a separate invalidate hook had no reachable call site
    and was removed."""
    try:
        count = sum(1 for p in _dead_letter_dir().iterdir() if p.is_file())
    except OSError:
        count = 0
    _dead_letter_count_cache[0] = count
    _dead_letter_count_cache[1] = time.monotonic()


def get_dead_letter_count() -> int:
    """Current dead-letter backlog size (regular-file count, node
    getDeadLetterCount parity). Served from the cache the retry sweep keeps
    fresh (it refreshes at the end of every pass, so dead-letter moves are
    visible without any invalidate hook); a cache older than the TTL (or the
    never-computed initial value) is recomputed lazily so the heartbeat never
    scans a huge directory on every tick."""
    count, cached_at = _dead_letter_count_cache
    if count < 0 or time.monotonic() - cached_at > DEAD_LETTER_COUNT_CACHE_TTL_SECONDS:
        _refresh_dead_letter_count()
    return _dead_letter_count_cache[0]


def _persist_giving_up(payload: dict, url: str) -> None:
    """Give-up wrapper around _persist_failed_callback: persistence failures
    must never escalate into the caller's terminal path — the result was
    already reported as lost in the logs at that point."""
    try:
        _persist_failed_callback(payload, url)
    except Exception as exc:  # pragma: no cover - defensive
        logger.error('Callback persistence failed: %s', exc)


def _persist_failed_callback(payload: dict, url: str) -> Optional[Path]:
    """Write an undeliverable callback payload to <workDir>/callbacks/.

    Node parity: the file holds ONLY the admin-acceptable payload batch (no
    Authorization header, no dynamic token) — replay re-signs at send time.
    Returns the payload file path, or None when persistence itself failed
    (nothing more can be done; the result was already logged)."""
    global _callback_persistence_sequence
    try:
        callback_dir = _callback_dir()
        with _persistence_sequence_lock:
            sequence = _callback_persistence_sequence
            _callback_persistence_sequence += 1
        filename = callback_dir / f'callback-{int(time.time() * 1000)}-{sequence}.json'
        tmp = filename.with_name(filename.name + '.tmp')
        tmp.write_text(json.dumps({'url': url, 'payloads': [payload]}, ensure_ascii=False), encoding='utf-8')
        # Windows rename-over-existing is not atomic-safe; unlink first
        if filename.exists():
            filename.unlink()
        tmp.rename(filename)
        # The replay backoff counts from "last attempt" — the just-failed
        # live POSTs already consumed the round-trip time, so the stored
        # persistedAt is backdated by one gate interval and the sweep can
        # retry immediately instead of sleeping a full gate on a payload
        # that has already been waiting through the live retry budget.
        persisted_at = int((time.time() - CALLBACK_REPLAY_BACKOFF_BASE_SECONDS - 1) * 1000)
        meta_path = filename.with_name(filename.name + '.meta')
        meta_path.write_text(
            json.dumps({'retries': 0, 'persistedAt': persisted_at}), encoding='utf-8')
        logger.info('Persisted failed callback to %s', filename)
        return filename
    except OSError as exc:
        logger.error('Failed to persist callbacks: %s', exc)
        return None


def _write_retry_count(filepath: Path, retries: int) -> None:
    """Bump the .meta retry counter. ``updatedAt`` doubles as the
    last-attempt timestamp for the per-file replay backoff gate."""
    try:
        filepath.with_name(filepath.name + '.meta').write_text(
            json.dumps({'retries': retries, 'updatedAt': int(time.time() * 1000)}), encoding='utf-8')
    except OSError as exc:
        logger.warning('Failed to update retry counter for %s: %s', filepath, exc)


def _replay_backoff_elapsed(filepath: Path, meta: dict, retries: int) -> bool:
    """True when the per-file exponential backoff since the last attempt has
    expired. The last-attempt timestamp is the .meta ``updatedAt`` (or the
    original ``persistedAt``, or the file mtime as a last resort); base*2**n
    grows with the failure count and is capped so a long backlog still
    cycles (node has no gate — it resends every second; the base is chosen
    so a fresh failure keeps that cadence while exhausted files slow down)."""
    now_ms = time.time() * 1000
    last_attempt_ms = None
    for key in ('updatedAt', 'persistedAt'):
        value = meta.get(key)
        if isinstance(value, (int, float)) and value > 0:
            last_attempt_ms = value
            break
    if last_attempt_ms is None:
        try:
            last_attempt_ms = filepath.stat().st_mtime * 1000
        except OSError:
            return True
    gate_ms = min(
        CALLBACK_REPLAY_BACKOFF_BASE_SECONDS * (2 ** retries),
        CALLBACK_REPLAY_BACKOFF_MAX_SECONDS,
    ) * 1000
    return (now_ms - last_attempt_ms) >= gate_ms


def _dead_letter_callback_file(filepath: Path, reason: str) -> None:
    """Move a permanently-failed callback file to dead-letter/ (node parity):
    the retry loop stops resending it, but the payload stays on disk for
    manual inspection/replay."""
    try:
        target = _dead_letter_dir() / filepath.name
        if target.exists():
            target.unlink()
        filepath.rename(target)
        logger.warning('Callback file %s moved to dead-letter after %s; manual replay required',
                       filepath.name, reason)
    except OSError as exc:
        # Last resort: at least stop retrying it.
        try:
            filepath.unlink()
        except OSError:
            pass
        logger.error('Failed to move callback file %s to dead-letter: %s', filepath, exc)
    try:
        filepath.with_name(filepath.name + '.meta').unlink()
    except OSError:
        pass  # meta may not exist


async def _replay_persisted_callback_file(filepath: Path, requests: list[dict], url: str) -> bool:
    """One replay attempt of a persisted callback file, re-signed with the
    token that is valid NOW (node replays through admin-client.post, which
    attaches the current credential)."""
    token = await get_current_token() or _get_callback_token()
    async with httpx.AsyncClient(timeout=10) as client:
        response = await request_with_self_heal(client, 'post', url, token=token, json=requests)
    if response.status_code < 400:
        return True
    raise RuntimeError(f'callback replay failed with HTTP {response.status_code}')


async def retry_persisted_callbacks() -> int:
    """Scan <workDir>/callbacks/ and replay persisted payloads. Returns the
    number of files successfully delivered (dead-letter moves are counted
    separately in logs). Mirrors node retryFailedCallbacks: per-file retry
    budget via the .meta counter, dead-letter on exhaustion, dead-letter for
    corrupt/unparseable poison files, and the oversized-payload hard stop."""
    callback_dir = _callback_dir()
    delivered = 0
    try:
        files = sorted(p for p in callback_dir.iterdir()
                       if p.is_file() and p.name.startswith('callback-') and p.name.endswith('.json'))
    except OSError:
        return 0
    for filepath in files:
        if _callback_retry_stop.is_set():
            break
        try:
            raw_meta = {}
            try:
                raw_meta = json.loads(
                    filepath.with_name(filepath.name + '.meta').read_text(encoding='utf-8'))
                if not isinstance(raw_meta, dict):
                    raw_meta = {}
            except (OSError, ValueError):
                raw_meta = {}
            retries = raw_meta.get('retries')
            if not isinstance(retries, int) or retries < 0:
                retries = 0
            if retries >= CALLBACK_FILE_MAX_RETRIES:
                _dead_letter_callback_file(filepath, f'{retries} failed retry rounds')
                continue
            if filepath.stat().st_size > CALLBACK_FILE_MAX_SIZE_BYTES:
                _dead_letter_callback_file(filepath, 'oversized payload')
                continue

            # Parse + validate BEFORE the backoff gate: a corrupt/poison file
            # must dead-letter on the first sweep (node dead-letters on
            # SyntaxError regardless of cadence), never idle behind a gate.
            data = json.loads(filepath.read_text(encoding='utf-8'))
            # executor-python writes {"url": ..., "payloads": [...]}; a bare
            # list is accepted for manual hand-repair / cross-format replay.
            if isinstance(data, list):
                data = {'payloads': data}
            url = data.get('url') or build_admin_api_url('/executions/callback')
            requests = data.get('payloads')
            if not isinstance(requests, list) or not requests:
                raise ValueError('empty payload batch')
            if not _replay_backoff_elapsed(filepath, raw_meta, retries):
                continue  # per-file exponential backoff not yet expired

            try:
                await _replay_persisted_callback_file(filepath, requests, url)
            except Exception:
                # node parity: an in-flight replay interrupted by shutdown is
                # "already durable" — do not count it as a failed round, the
                # next process replays it from scratch.
                if _callback_retry_stop.is_set():
                    continue
                next_retries = retries + 1
                _write_retry_count(filepath, next_retries)
                if next_retries >= CALLBACK_FILE_MAX_RETRIES:
                    _dead_letter_callback_file(filepath, f'{next_retries} failed retry rounds')
                continue
            delivered += 1
            filepath.unlink()
            try:
                filepath.with_name(filepath.name + '.meta').unlink()
            except OSError:
                pass  # meta may not exist
            logger.info('Retried and removed %s', filepath)
        except (ValueError, json.JSONDecodeError):
            # Corrupt/unparseable poison files would never succeed —
            # dead-letter them instead of burning a re-send forever.
            _dead_letter_callback_file(filepath, 'corrupt payload')
        except OSError as exc:
            logger.warning('Failed to retry callback file %s: %s', filepath.name, exc)
    _refresh_dead_letter_count()
    return delivered


async def callback_retry_task() -> None:
    """Background re-send loop (node processCallbacks parity): replays
    persisted callbacks every CALLBACK_RETRY_SWEEP_INTERVAL_SECONDS until
    stopped. The stop flag is polled between sweeps (and checked per file),
    so the shutdown drain only ever waits for one in-flight replay."""
    logger.info('Starting callback retry task')
    try:
        while not _callback_retry_stop.is_set():
            try:
                await retry_persisted_callbacks()
            except Exception as exc:  # never let the sweep die
                logger.error('Callback retry error: %s', exc)
            if _callback_retry_stop.is_set():
                break
            await asyncio.sleep(CALLBACK_RETRY_SWEEP_INTERVAL_SECONDS)
    finally:
        logger.info('Callback retry task stopped')


def start_callback_retry_task() -> None:
    """node startCallbackThread parity (idempotent re-entry guard). Must be
    called from the running event loop (lifespan)."""
    global _callback_retry_task
    if _callback_retry_task is not None and not _callback_retry_task.done():
        return
    _callback_retry_stop.clear()
    _callback_retry_task = asyncio.create_task(callback_retry_task())


# E2: dead-letter backlog report — same provider pattern as the E1 liveness
# report above (node registerDeadLetterCountProvider(getDeadLetterCount)).
sched.register_dead_letter_count_provider(get_dead_letter_count)


async def stop_callback_retry_task() -> None:
    """Shutdown drain (node stopCallbackThread parity): give the in-flight
    sweep a bounded window to finish (it may be mid-POST), then cancel.
    Payloads that could not be delivered simply stay on disk for the next
    process's replay — durability is the file, not the loop."""
    global _callback_retry_task
    task = _callback_retry_task
    if task is None:
        return
    _callback_retry_stop.set()
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=CALLBACK_DRAIN_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
    except asyncio.CancelledError:
        raise
    except Exception:
        pass
    _callback_retry_task = None


async def _push_killed_callback(executionId: str) -> None:
    """E4: push the terminal killed callback for an execution that never got
    a live process (queued/prepare stage). The kill endpoint already marked
    ``killed_callback_pushed`` and removed the registry entry; the background
    ``_run_and_callback`` sees the flag and skips its own callback, so admin
    receives exactly one terminal result."""
    admin_api_url = _get_admin_api_url()
    if not admin_api_url:
        return
    payload = {
        'executionId': executionId,
        'status': 'failed',
        'errorMessage': 'Execution killed by admin request',
        'failureReason': 'killed',
        'executorAddress': _executor_callback_address(),
    }
    token = await get_current_token() or _get_callback_token()
    await _send_callback_with_retry(
        build_admin_api_url('/executions/callback'),
        payload,
        token,
    )


def _spawn_background(coro) -> None:
    """Keep a strong reference to a fire-and-forget task (R4-C P2)."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


@router.post('/executions/{executionId}/kill', dependencies=[Depends(verify_token)])
async def kill_execution(executionId: str):
    """E4 (改动1 port, node execute.ts:847-895 parity): admin's killExecution
    only flipped the DB row; the task kept running on this executor. Admin
    calls ``POST api/executions/:executionId/kill`` with the shared token and
    a 3s timeout (task.service.ts notifyExecutorKill).

    Response shape is field-for-field node's: running/known → 200 ``{ok:true}``
    (process tree killed, or cancellation flagged for the background flow);
    not in the live registry → 404 ``{ok:false}`` (never accepted / already
    terminal — admin treats both as done and ignores any late callback)."""
    entry = get_live_execution(executionId)
    if entry is None:
        # 不在运行表中（从未领取 / 已结束 / 已清理）
        return JSONResponse(status_code=404, content={'ok': False})

    entry.killed_by_request = True
    entry.cancelled = True

    proc = entry.proc
    if proc is not None:
        # 已 spawn：终止整个进程树（复用 _kill_process_tree）。子进程死亡后
        # run_task 自然走失败返回，_run_and_callback 据 killed_by_request 推送
        # failureReason=killed 的终态回调并摘除注册表条目——与 node 的
        # "close 事件走 runTask 失败路径" 一致，这里不重复推送。
        await _kill_process_tree(proc)
        return {'ok': True}

    # 排队/prepare（尚未 spawn）：立刻收尾——推送一次 killed 回调（后台任务，
    # 不阻塞 admin 的 3s 超时）并摘除注册表；run_task 的 cancelled 检查点会让
    # 后台流程静默退出，绝不双发回调、绝不双释放容量（decrement 仍归
    # _run_and_callback 的 finally 所有）。
    if not entry.killed_callback_pushed:
        entry.killed_callback_pushed = True
        _spawn_background(_push_killed_callback(executionId))
    unregister_live_execution(executionId)
    return {'ok': True}


async def _run_and_callback(req: ExecuteRequest, entry: Optional['_LiveExecution'] = None):
    if entry is None:
        entry = get_live_execution(req.executionId)
    # E6 (node task-worker.ts 同任务串行 parity): task.id groups executions —
    # same-task executions queue on a per-task lock instead of concurrently
    # racing prepare/venv/run. QA4: the key comes from the single
    # _derive_task_key derivation, shared with run_task's .venvs/<id> path
    # and the E8 live-protection snapshot below. The lock covers run_task
    # only — the terminal callback POSTs after release, mirroring node where
    # the worker slot is freed by onComplete before the callback thread
    # delivers.
    task_id = _derive_task_key(req)
    if entry is not None:
        entry.task_id = task_id
    try:
        async with _get_task_lock(task_id):
            try:
                result = await run_task(req, entry)
                payload = {
                    'executionId': req.executionId,
                    'status': 'success' if result.get('success') else 'failed',
                    'exitCode': result.get('exitCode'),
                    'logs': result.get('logs'),
                    'errorMessage': _truncate_error_message(result.get('errorMessage')),
                    'durationMs': result.get('durationMs'),
                    'executorAddress': _executor_callback_address(),
                }
                if entry is not None and entry.traceparent:
                    payload['traceparent'] = entry.traceparent
                # BUG-10: 运行期失败（依赖/Git/运行时）细分类，未命中不设
                # reason（admin inferFailureReason 兜底，旧语义不变）
                if not result.get('success'):
                    reason = _refine_failure_reason(str(result.get('errorMessage') or ''))
                    if reason:
                        payload['failureReason'] = reason
            except Exception as exc:
                payload = {
                    'executionId': req.executionId,
                    'status': 'failed',
                    'errorMessage': _truncate_error_message(str(exc)),
                    'executorAddress': _executor_callback_address(),
                }
                if entry is not None and entry.traceparent:
                    payload['traceparent'] = entry.traceparent
                # BUG-10: prepare 阶段异常（git/venv/pip/uv）细分类
                reason = _refine_failure_reason(str(exc))
                if reason:
                    payload['failureReason'] = reason
            finally:
                sched.decrement_running()

        if entry is not None and entry.killed_callback_pushed:
            # E4: the kill endpoint already pushed the terminal killed callback
            # for this execution — sending another would race admin's terminal
            # transition guard with a redundant (and possibly misleading) one.
            logger.info('Callback skipped (killed callback already pushed): %s',
                        req.executionId)
            return

        if entry is not None and entry.killed_by_request:
            # E4 (node runTask parity): the process tree was killed by admin
            # request — classify the failure callback accordingly instead of
            # surfacing the raw exit-code/-signal text.
            payload['status'] = 'failed'
            payload['errorMessage'] = 'Task process tree killed by admin request'
            payload['failureReason'] = 'killed'

        admin_api_url = _get_admin_api_url()
        if admin_api_url:
            # E3: dynamic-capable token (node callback.ts post() parity) with
            # 401 self-heal inside _send_callback_with_retry; the settings
            # snapshot stays as the fallback for .env-file-only deployments
            # where os.environ carries nothing.
            token = await get_current_token() or _get_callback_token()
            # FEAT-05: 收集 <work_dir>/artifacts/ 并 PUT 上传，把清单随终态回调
            # 上报。best-effort —— 任何异常只记日志，绝不阻塞/污染任务终态。
            try:
                artifact_manifest = await gather_artifacts_for_callback(
                    req.executionId,
                    Path(settings.work_dir) / req.executionId,
                    admin_api_url,
                    token,
                )
                if artifact_manifest:
                    payload['artifacts'] = artifact_manifest
            except Exception as art_err:  # noqa: BLE001
                logger.warning(
                    "artifacts collection/upload failed (non-blocking) for %s: %s",
                    req.executionId, art_err,
                )
            try:
                await _send_callback_with_retry(
                    build_admin_api_url('/executions/callback'),
                    payload,
                    token,
                )
            except asyncio.CancelledError:
                # QA8: 停机 worker-flush 窗口耗尽被取消——投递已不可能，至少把
                # 终态载荷落盘交给下个进程重放（否则该执行只能等 admin 的
                # stale sweep 修复，真实 killed/timeout 分类随之丢失）。
                _persist_giving_up(
                    payload,
                    build_admin_api_url('/executions/callback'),
                )
                raise
    finally:
        # E1: terminal (callback sent or given up) — stop reporting liveness.
        unregister_live_execution(req.executionId)


async def _run_uv(args: list[str], timeout_seconds: float) -> tuple[int | None, str]:
    """Run a uv subprocess with combined output captured.

    R4-C P2: plain `asyncio.wait_for(proc.communicate(), ...)` leaves the uv
    process running as an orphan when it times out — kill it explicitly first.
    """
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        try:
            await proc.wait()
        except Exception:
            pass
        raise
    return proc.returncode, (out.decode('utf-8', errors='replace') if out else '')


async def ensure_venv(venv_dir: Path, requirements: list[str]) -> Path:
    """Create/reuse a virtual environment with uv and install dependencies. Returns python executable path."""
    # W-02 follow-up (windows-findings): venv layout is platform-specific —
    # win32 uses Scripts\python.exe, POSIX uses bin/python. The old hardcoded
    # bin/python made every requirements-bearing task fail on Windows.
    if sys.platform == 'win32':
        python_bin = venv_dir / 'Scripts' / 'python.exe'
    else:
        python_bin = venv_dir / 'bin' / 'python'

    if not venv_dir.exists():
        logger.info(f'Creating venv with uv: {venv_dir}')
        try:
            code, out = await _run_uv([UV_BIN, 'venv', str(venv_dir)], UV_VENV_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            # R4-C P2: a timed-out `uv venv` leaves a half-built directory behind;
            # the `if not venv_dir.exists()` check would then silently reuse the
            # broken venv forever. Remove it before surfacing the failure.
            shutil.rmtree(venv_dir, ignore_errors=True)
            raise RuntimeError(f'uv venv timed out after {UV_VENV_TIMEOUT_SECONDS}s (uv process killed)')
        except Exception:
            shutil.rmtree(venv_dir, ignore_errors=True)
            raise
        if code != 0:
            shutil.rmtree(venv_dir, ignore_errors=True)
            raise RuntimeError(f'uv venv failed: {_truncate_error_message(out)}')

    if requirements:
        _validate_requirements(requirements)
        logger.info(f'Installing {len(requirements)} packages into {venv_dir}')
        install_args = [
            UV_BIN, 'pip', 'install',
            '--python', str(python_bin),
        ]
        # Use private PyPI registry if configured (e.g., for internal @autocodeflow packages)
        if settings.pypi_registry_url:
            install_args.extend(['--index-url', settings.pypi_registry_url])
        install_args.extend(requirements)
        code, out = await _run_uv(install_args, UV_PIP_TIMEOUT_SECONDS)
        if code != 0:
            raise RuntimeError(f'uv pip install failed: {_truncate_error_message(out)}')

    return python_bin


async def run_task(req: ExecuteRequest, entry: Optional['_LiveExecution'] = None) -> dict:
    started_at = time.monotonic()
    if entry is None:
        entry = get_live_execution(req.executionId)
    # E4: kill landed before the background flow even started — the kill
    # endpoint already pushed the terminal callback; do no work at all.
    if entry is not None and entry.cancelled:
        return {
            'success': False,
            'logs': '',
            'exitCode': None,
            'errorMessage': 'Execution killed by admin request',
            'durationMs': int((time.monotonic() - started_at) * 1000),
        }
    # Working directory
    work_dir = Path(settings.work_dir) / req.executionId
    # S6/Q11: path traversal guard — executionId must not escape the base work_dir
    base = Path(settings.work_dir).resolve()
    resolved = work_dir.resolve()
    if not str(resolved).startswith(str(base) + os.sep) and resolved != base:
        raise HTTPException(status_code=400, detail='Invalid executionId: path traversal detected')
    work_dir.mkdir(parents=True, exist_ok=True)
    # S6/Q11: restrict permissions so sibling tasks cannot read this directory
    try:
        os.chmod(work_dir, stat.S_IRWXU)  # 0o700
    except Exception as chmod_err:
        logger.warning("chmod work_dir failed (non-critical): %s", chmod_err)

    # FEAT-05: 预建产物目录约定 <work_dir>/artifacts/，供任务写入截图/报表等；
    # best-effort，失败不阻断（收集阶段目录不存在则视为无产物）。
    try:
        artifacts_dir_for(work_dir).mkdir(parents=True, exist_ok=True)
    except Exception as art_dir_err:
        logger.warning("create artifacts dir failed (non-critical): %s", art_dir_err)

    # --- Git version binding: if task specifies gitRepo, clone/checkout to work dir ---
    git_repo: str | None = req.task.get('gitRepo') or req.task.get('git_repo')
    git_commit: str | None = req.task.get('gitCommit') or req.task.get('git_commit')
    git_branch: str = req.task.get('gitBranch') or req.task.get('git_branch') or 'main'
    if git_repo:
        # S7: SSRF guard — only allow http(s) and ssh git URLs
        import re as _re
        if not _re.match(r'^(https?://|git@|ssh://)', git_repo, _re.IGNORECASE):
            raise HTTPException(status_code=400, detail=f'gitRepo URL scheme not allowed: {git_repo}')

        # S7: SSRF guard — block private IP addresses and localhost
        private_ip_pattern = r'(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.1[6-9]\.\d{1,3}\.\d{1,3}|172\.2[0-9]\.\d{1,3}\.\d{1,3}|172\.3[0-1]\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3})'
        if _re.search(private_ip_pattern, git_repo, _re.IGNORECASE):
            raise HTTPException(status_code=400, detail=f'gitRepo URL contains restricted address: {git_repo}')

        ref = git_commit if git_commit else git_branch
        _validate_git_ref(ref)
        logger.info(f'Checking out {git_repo}@{ref} to {work_dir}')
        await asyncio.get_event_loop().run_in_executor(
            None, git_checkout_to, git_repo, ref, work_dir
        )

    # Load manifest.yaml and merge with task (task fields take priority)
    manifest = load_manifest(work_dir)
    task = merge_task_with_manifest(req.task, manifest)

    runtime = task.get('runtime', 'python')
    entrypoint = task.get('entrypoint', 'main.py')
    timeout = _clamp_timeout_seconds(
        task.get('timeoutSeconds') or task.get('timeout_seconds') or task.get('timeout') or settings.task_timeout_seconds,
        settings.task_timeout_seconds,
    )
    requirements: list[str] = task.get('requirements', [])
    # QA4: same derivation as the E6 task lock and the E8 live-protection
    # snapshot (_run_and_callback sets entry.task_id from it) — the venv
    # directory name, the lock key and the disk-sweep protection set can
    # never disagree (an empty request id falls back to executionId here
    # too, instead of collapsing onto the .venvs root).
    task_id = _derive_task_key(req)

    # Glue script support: write inline source to a temp file and use it as entrypoint
    glue_source = task.get('glueSource') or task.get('glue_source')
    glue_language = task.get('glueLanguage') or task.get('glue_language')
    if glue_source:
        if glue_language == 'python' or (not glue_language and runtime == 'python'):
            glue_file = work_dir / 'glue_script.py'
            glue_runtime = 'python'
        elif glue_language == 'javascript' or (not glue_language and runtime == 'node'):
            glue_file = work_dir / 'glue_script.js'
            glue_runtime = 'node'
        elif glue_language == 'shell' or (not glue_language and runtime == 'shell'):
            # W-11 (windows-findings): parity with executor-node — accept a
            # missing glueLanguage (fall back to task.runtime) so shell glue
            # doesn't 400, and on win32 write `.cmd` so `cmd.exe /c` actually
            # runs it (a `.sh` file neither runs as batch nor exits cleanly —
            # it hangs and holds the task slot).
            ext = 'cmd' if sys.platform == 'win32' else 'sh'
            glue_file = work_dir / f'glue_script.{ext}'
            glue_runtime = 'shell'
        else:
            raise HTTPException(status_code=400, detail=f'Unsupported glue language: {glue_language}')

        glue_file.write_text(glue_source, encoding='utf-8')
        glue_file.chmod(0o755)
        logger.info(f'Glue script written to {glue_file} ({len(glue_source)} bytes)')
        runtime = glue_runtime
        entrypoint = str(glue_file) if glue_runtime == 'shell' else glue_file.name
        requirements = []  # Glue scripts use system Python/node, no per-task venv

    # R4-C P3: entrypoints must stay inside the work directory (glue's absolute
    # in-workdir path is allowed; `../evil.sh` is not).
    _ensure_entrypoint_in_workdir(entrypoint, work_dir)

    # SEC-01: only pass a whitelist of env vars to child process — never expose executor secrets
    env = _build_child_env()
    # inject task-scoped context
    env['EXECUTION_ID'] = req.executionId
    env['TASK_ID'] = str(task.get('id', ''))
    env['TASK_NAME'] = task.get('name', '')
    if req.params:
        for k, v in req.params.items():
            env[f'AUTOFLOW_{k.upper()}'] = str(v)

    # N33 (round-9, parity with executor-node execute.ts N23/N27): per-execution
    # callback credentials — injected AFTER the params loop so user params can
    # never override them. AUTOFLOW_CALLBACK_TOKEN is an HMAC bound to this
    # executionId with a short TTL (task timeout + grace), letting task code
    # call POST /api/executions/callback without ever seeing the shared token
    # (SEC-01 whitelist untouched — this is the explicit extra-env channel).
    # AUTOFLOW_ADMIN_API_URL / AUTOFLOW_EXECUTOR_ADDRESS are non-secret routing
    # info, the same values this executor itself uses for its own callbacks —
    # without them the autoflow-sdk ctx.callback stays disabled on python.
    callback_token = create_execution_callback_token(
        req.executionId, timeout + CALLBACK_TOKEN_GRACE_SECONDS
    )
    if callback_token:
        env['AUTOFLOW_CALLBACK_TOKEN'] = callback_token
    admin_api_url = _get_admin_api_url()
    if admin_api_url:
        env['AUTOFLOW_ADMIN_API_URL'] = admin_api_url
    registered_address = _executor_callback_address()
    if registered_address:
        env['AUTOFLOW_EXECUTOR_ADDRESS'] = registered_address
    # FEAT-05: 告诉任务产物目录约定位置，任务把交付物写入此目录即被收集上传。
    env['AUTOFLOW_ARTIFACTS_DIR'] = str(artifacts_dir_for(work_dir))
    # OBS-01: 把 dispatch 请求的 W3C traceparent 头透传为任务 env（任务代码
    # 可读 AUTOFLOW_TRACE_ID 做下游关联）。在 params 注入之后（用户参数不可
    # 覆盖，与 AUTOFLOW_CALLBACK_TOKEN 同一纪律）。缺省不注入。
    if entry is not None and entry.traceparent:
        env['AUTOFLOW_TRACE_ID'] = entry.traceparent

    if runtime == 'python':
        if requirements:
            # Each task ID maps to a persistent venv; same task reuses the same env
            _validate_requirements(requirements)
            venv_dir = Path(settings.work_dir) / '.venvs' / task_id
            # E6: ensure_venv mutates .venvs/<task_id> — its only production
            # call site is here inside run_task, which only runs under the
            # per-task lock from _run_and_callback, so venv creation/install
            # never runs concurrently for the same task (E8 additionally
            # protects a live task's venv dir from the disk TTL sweep).
            python_bin = await ensure_venv(venv_dir, requirements)
            cmd = [str(python_bin), entrypoint]
        else:
            # W-02 follow-up (windows-findings): hardcoded `python3` is absent on
            # Windows (Store stub returns 9009), so every non-venv python runtime
            # and python glue task failed to launch there. sys.executable is the
            # interpreter running this executor and exists on every platform; the
            # task inherits the same stdlib the executor was validated against.
            cmd = [sys.executable, entrypoint]
    elif runtime == 'node':
        node_exe = 'node.exe' if sys.platform == 'win32' else 'node'
        cmd = [node_exe, entrypoint]
        if requirements:
            # R4-C P3: this executor never installs node dependencies; failing
            # silently used to make the task die later with MODULE_NOT_FOUND.
            logger.warning(
                'Task %s: runtime=node ignores requirements %s '
                '(npm dependency installation is not supported on the python executor)',
                task.get('name'), requirements,
            )
    elif runtime == 'shell':
        cmd = _build_shell_cmd(work_dir, entrypoint)
    else:
        return {
            'success': False,
            'logs': '',
            'exitCode': None,
            'errorMessage': f'Unsupported runtime: {runtime}',
            'durationMs': int((time.monotonic() - started_at) * 1000),
        }

    logger.info(f'Running task {task.get("name")} [{req.executionId}]: {cmd}')

    # E4: kill arrived while still queued/preparing (no live process yet) — the
    # kill endpoint already pushed the terminal killed callback and unregistered
    # the execution; bail out before spawning anything.
    if entry is not None and entry.cancelled:
        return {
            'success': False,
            'logs': '',
            'exitCode': None,
            'errorMessage': 'Execution killed by admin request',
            'durationMs': int((time.monotonic() - started_at) * 1000),
        }

    log_file = work_dir / f'{req.executionId}.log'
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(work_dir),
            env=env,
            **_spawn_kwargs_for_platform(),  # W-02: setsid on POSIX, process-group flag on win32
        )
        if entry is not None:
            # E4/E5: publish the child so the kill endpoint and shutdown can
            # reach its process tree. Re-check cancelled right after: a kill
            # that landed between the checkpoint above and this registration
            # must take the fresh tree down instead of running un-killed.
            entry.proc = proc
            if entry.cancelled:
                await _kill_process_tree(proc)
        log_chunks: list[str] = []
        captured_chars = 0        # chars retained in memory for the callback payload
        captured_truncated = False
        streamed_bytes = 0        # bytes read from the child (drives disk cap)
        file_truncated = False
        file_disabled = False
        lines_since_flush = 0

        async def _stream_to_file() -> None:
            # R4-C P1: stdout/stderr used to accumulate without any cap
            # (OOM on large-output tasks) and flushed the log file once per
            # line (event-loop stall under high throughput). Now:
            # - memory accumulation stops at MAX_LOG_MEMORY_CHARS (marker added);
            # - disk writes stop at MAX_LOG_FILE_BYTES (marker added);
            # - file buffer is flushed in batches, not per line.
            nonlocal captured_chars, captured_truncated, streamed_bytes
            nonlocal file_truncated, file_disabled, lines_since_flush
            with open(log_file, 'a', encoding='utf-8') as lf:
                async for raw_line in proc.stdout:  # type: ignore[union-attr]
                    line = raw_line.decode('utf-8', errors='replace')
                    streamed_bytes += len(raw_line)
                    if captured_chars < MAX_LOG_MEMORY_CHARS:
                        log_chunks.append(line)
                        captured_chars += len(line)
                    else:
                        captured_truncated = True
                    if file_disabled:
                        continue
                    if streamed_bytes <= MAX_LOG_FILE_BYTES:
                        try:
                            lf.write(line)
                        except OSError as io_err:
                            logger.warning('Log file write failed (continuing in memory only): %s', io_err)
                            file_disabled = True
                        else:
                            lines_since_flush += 1
                            if lines_since_flush >= _LOG_FLUSH_EVERY_LINES:
                                try:
                                    lf.flush()
                                except OSError as io_err:
                                    logger.warning('Log file flush failed: %s', io_err)
                                    file_disabled = True
                                lines_since_flush = 0
                    elif not file_truncated:
                        file_truncated = True
                        try:
                            lf.write(f'\n...[file log truncated at {MAX_LOG_FILE_BYTES} bytes]...\n')
                            lf.flush()
                        except OSError as io_err:
                            logger.warning('Log file marker write failed: %s', io_err)
                            file_disabled = True
                try:
                    lf.flush()
                except OSError:
                    pass

        stream_task = asyncio.ensure_future(_stream_to_file())
        try:
            await asyncio.wait_for(asyncio.shield(stream_task), timeout=timeout)
        except asyncio.TimeoutError:
            stream_task.cancel()
            try:
                # Let the streamer unwind so the log file is closed/flushed
                # before the process group is killed.
                await stream_task
            except BaseException:
                pass
            raise
        await proc.wait()

        logs = _build_callback_logs(log_chunks, captured_truncated, log_file)
        duration_ms = int((time.monotonic() - started_at) * 1000)
        if proc.returncode != 0:
            return {
                'success': False,
                'logs': logs,
                'exitCode': proc.returncode,
                'errorMessage': f'Process exited with code {proc.returncode}',
                'durationMs': duration_ms,
            }

        return {'success': True, 'logs': logs, 'exitCode': proc.returncode, 'durationMs': duration_ms}
    except asyncio.TimeoutError:
        # B-06: kill the entire process group so child processes spawned by the
        # task are also terminated. E4/E5: same platform branches now live in
        # _kill_process_tree (win32 taskkill /T /F, POSIX killpg SIGKILL).
        await _kill_process_tree(proc)
        try:
            # Reap the killed child so its transport is finalized on a live
            # loop (otherwise it lingers until GC after the loop closed).
            await asyncio.wait_for(proc.wait(), timeout=5)
        except Exception:
            pass
        duration_ms = int((time.monotonic() - started_at) * 1000)
        return {
            'success': False,
            # R4-C P1: bounded + truncated like the normal path (previously this
            # path returned the untruncated accumulation, which could exceed the
            # admin DTO logs limit and get the callback rejected wholesale).
            'logs': _build_callback_logs(log_chunks, captured_truncated, log_file) if 'log_chunks' in locals() else '',
            'exitCode': None,
            'errorMessage': f'Task timeout after {timeout}s',
            'durationMs': duration_ms,
        }
    except HTTPException as e:
        logging.exception('HTTP error during task execution')
        return {
            'success': False,
            'logs': '',
            'exitCode': None,
            'errorMessage': _truncate_error_message(str(e.detail)),
            'durationMs': int((time.monotonic() - started_at) * 1000),
        }
    except Exception as e:
        logging.exception('Unexpected error during task execution')
        return {
            'success': False,
            'logs': '',
            'exitCode': None,
            'errorMessage': _truncate_error_message(str(e)),
            'durationMs': int((time.monotonic() - started_at) * 1000),
        }
    finally:
        # E4/E5: the child is dead or was never spawned — drop the process
        # handle so kill/shutdown never tree-kills a reaped or absent proc.
        # Registry removal itself stays with _run_and_callback (terminal
        # callback ownership), matching node's release-on-completion posture.
        if entry is not None:
            entry.proc = None
