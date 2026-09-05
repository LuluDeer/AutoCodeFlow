import asyncio
import hashlib
import logging
import os
import signal
import stat
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
import httpx
from fastapi import APIRouter, Depends, HTTPException
from typing import Any, Optional
import scheduler as sched
from auth import verify_token
from admin_api import build_admin_api_url, get_admin_api_base_url
from config import settings
from execution_callback_token import CALLBACK_TOKEN_GRACE_SECONDS, create_execution_callback_token
from manifest import load_manifest, merge_task_with_manifest
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
    we are trying to heal). The TTL log cleanup can sweep *.git_cache/*-broken
    later; until then a stale partial clone costs only disk."""
    broken = cache_dir.with_name(cache_dir.name + f'-broken-{int(time.time())}')
    try:
        cache_dir.rename(broken)
    except OSError:
        shutil.rmtree(cache_dir, ignore_errors=True)


def git_checkout_to(repo_url: str, ref: str, dest: Path) -> None:
    """Clone (with cache) and checkout the specified ref to the dest directory."""
    _validate_git_ref(ref)
    cache_dir = Path(settings.work_dir) / '.git_cache' / _repo_dir_name(repo_url)
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


@router.post('/execute', dependencies=[Depends(verify_token)])
async def execute(req: ExecuteRequest):
    if sched.get_running_count() >= settings.max_concurrent_tasks:
        raise HTTPException(status_code=429, detail='Executor is at capacity')

    sched.increment_running()
    bg_task = asyncio.create_task(_run_and_callback(req))
    _background_tasks.add(bg_task)
    bg_task.add_done_callback(_background_tasks.discard)
    return {
        'status': 'accepted',
        'executionId': req.executionId,
        'executorAddress': _executor_callback_address(),
    }


async def _send_callback_with_retry(url: str, payload: dict, headers: dict) -> bool:
    """POST the execution callback with bounded retries.

    R4-C P2: the original fired exactly one request and only logged transport
    failures — a transient admin-api blip silently lost the execution result
    (only the admin-side zombie sweeper could repair state). 4xx responses
    (except 408/429) are terminal: the payload itself is being rejected, so
    retrying would just hammer admin-api forever.
    """
    last_error: Exception | None = None
    for attempt in range(1, CALLBACK_RETRY_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.post(url, json=[payload], headers=headers)
            if response.status_code < 400:
                return True
            if 400 <= response.status_code < 500 and response.status_code not in (408, 429):
                logger.error('Callback rejected with HTTP %s (non-retryable); giving up', response.status_code)
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
    return False


async def _run_and_callback(req: ExecuteRequest):
    try:
        result = await run_task(req)
        payload = {
            'executionId': req.executionId,
            'status': 'success' if result.get('success') else 'failed',
            'exitCode': result.get('exitCode'),
            'logs': result.get('logs'),
            'errorMessage': _truncate_error_message(result.get('errorMessage')),
            'durationMs': result.get('durationMs'),
            'executorAddress': _executor_callback_address(),
        }
    except Exception as exc:
        payload = {
            'executionId': req.executionId,
            'status': 'failed',
            'errorMessage': _truncate_error_message(str(exc)),
            'executorAddress': _executor_callback_address(),
        }
    finally:
        sched.decrement_running()

    admin_api_url = _get_admin_api_url()
    if admin_api_url:
        headers = {}
        callback_token = _get_callback_token()
        if callback_token:
            headers['Authorization'] = f'Bearer {callback_token}'
        await _send_callback_with_retry(
            build_admin_api_url('/executions/callback'),
            payload,
            headers,
        )


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


async def run_task(req: ExecuteRequest) -> dict:
    started_at = time.monotonic()
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
    task_id = str(task.get('id', req.executionId))

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

    if runtime == 'python':
        if requirements:
            # Each task ID maps to a persistent venv; same task reuses the same env
            _validate_requirements(requirements)
            venv_dir = Path(settings.work_dir) / '.venvs' / task_id
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
        # B-06: kill the entire process group so child processes spawned by the task are also terminated
        # W-02: win32 has no process groups — taskkill /T /F walks the child
        # tree instead (mirrors executor-node's TerminateProcess fallback).
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
                if proc.pid is not None:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, OSError):
                proc.kill()
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
