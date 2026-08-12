import asyncio
import logging
import os
import signal
import stat
import re
import shutil
import subprocess
import time
from pathlib import Path
import httpx
from fastapi import APIRouter, Depends, HTTPException
from typing import Any, Optional
import scheduler as sched
from auth import verify_token
from config import settings
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
    """Convert git URL to a safe cache directory name (last segment, strip .git suffix)"""
    name = repo_url.rstrip('/').split('/')[-1]
    name = re.sub(r'\.git$', '', name)
    return re.sub(r'[^a-zA-Z0-9_.-]', '_', name)


def git_checkout_to(repo_url: str, ref: str, dest: Path) -> None:
    """Clone (with cache) and checkout the specified ref to the dest directory."""
    cache_dir = Path(settings.work_dir) / '.git_cache' / _repo_dir_name(repo_url)
    if not cache_dir.exists():
        cache_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'clone', '--bare', repo_url, str(cache_dir)],
                       check=True, timeout=120)
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


# uv executable path (prefer PATH; Dockerfile installs to /root/.cargo/bin/uv)
UV_BIN = shutil.which('uv') or '/root/.local/bin/uv'

# SEC-01: module-level whitelist so tests can import and verify it
_ENV_WHITELIST = {
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'PYTHONPATH', 'PYTHONHASHSEED', 'VIRTUAL_ENV',
    'NODE_PATH', 'TMPDIR', 'TEMP', 'TMP',
    'USER', 'LOGNAME', 'SHELL',
}


# Q-01: removed duplicate ExecuteRequest definition — use the SDK class (or fallback above)

@router.post('/execute', dependencies=[Depends(verify_token)])
async def execute(req: ExecuteRequest):
    if sched.get_running_count() >= settings.max_concurrent_tasks:
        raise HTTPException(status_code=429, detail='Executor is at capacity')

    sched.increment_running()
    asyncio.create_task(_run_and_callback(req))
    return {
        'status': 'accepted',
        'executionId': req.executionId,
        'executorAddress': _executor_callback_address(),
    }


async def _run_and_callback(req: ExecuteRequest):
    try:
        result = await run_task(req)
        payload = {
            'executionId': req.executionId,
            'status': 'success' if result.get('success') else 'failed',
            'exitCode': result.get('exitCode'),
            'logs': result.get('logs'),
            'errorMessage': result.get('errorMessage'),
            'durationMs': result.get('durationMs'),
            'executorAddress': _executor_callback_address(),
        }
    except Exception as exc:
        payload = {
            'executionId': req.executionId,
            'status': 'failed',
            'errorMessage': str(exc),
            'executorAddress': _executor_callback_address(),
        }
    finally:
        sched.decrement_running()

    if settings.admin_api_url:
        headers = {}
        if settings.executor_shared_token:
            headers['Authorization'] = f'Bearer {settings.executor_shared_token}'
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{settings.admin_api_url.rstrip('/')}/executions/callback",
                    json=[payload],
                    headers=headers,
                )
        except Exception as exc:
            logger.warning('Failed to send execution callback: %s', exc)


async def ensure_venv(venv_dir: Path, requirements: list[str]) -> Path:
    """Create/reuse a virtual environment with uv and install dependencies. Returns python executable path."""
    python_bin = venv_dir / 'bin' / 'python'

    if not venv_dir.exists():
        logger.info(f'Creating venv with uv: {venv_dir}')
        proc = await asyncio.create_subprocess_exec(
            UV_BIN, 'venv', str(venv_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
        if proc.returncode != 0:
            raise RuntimeError(f'uv venv failed: {out.decode()}')

    if requirements:
        logger.info(f'Installing {len(requirements)} packages into {venv_dir}')
        install_args = [
            UV_BIN, 'pip', 'install',
            '--python', str(python_bin),
        ]
        # Use private PyPI registry if configured (e.g., for internal @autocodeflow packages)
        if settings.pypi_registry_url:
            install_args.extend(['--index-url', settings.pypi_registry_url])
        install_args.extend(requirements)
        proc = await asyncio.create_subprocess_exec(
            *install_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=300)
        if proc.returncode != 0:
            raise RuntimeError(f'uv pip install failed: {out.decode()}')

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
        logger.info(f'Checking out {git_repo}@{ref} to {work_dir}')
        await asyncio.get_event_loop().run_in_executor(
            None, git_checkout_to, git_repo, ref, work_dir
        )

    # Load manifest.yaml and merge with task (task fields take priority)
    manifest = load_manifest(work_dir)
    task = merge_task_with_manifest(req.task, manifest)

    runtime = task.get('runtime', 'python')
    entrypoint = task.get('entrypoint', 'main.py')
    timeout = task.get('timeout', 300)
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
        elif glue_language == 'shell':
            glue_file = work_dir / 'glue_script.sh'
            glue_runtime = 'shell'
        else:
            raise HTTPException(status_code=400, detail=f'Unsupported glue language: {glue_language}')

        glue_file.write_text(glue_source, encoding='utf-8')
        glue_file.chmod(0o755)
        logger.info(f'Glue script written to {glue_file} ({len(glue_source)} bytes)')
        runtime = glue_runtime
        entrypoint = str(glue_file) if glue_runtime == 'shell' else glue_file.name
        requirements = []  # Glue scripts use system Python/node, no per-task venv

    # SEC-01: only pass a whitelist of env vars to child process — never expose executor secrets
    env = {k: v for k, v in os.environ.items() if k in _ENV_WHITELIST}
    # inject task-scoped context
    env['EXECUTION_ID'] = req.executionId
    env['TASK_ID'] = str(task.get('id', ''))
    env['TASK_NAME'] = task.get('name', '')
    if req.params:
        for k, v in req.params.items():
            env[f'AUTOFLOW_{k.upper()}'] = str(v)

    if runtime == 'python':
        if requirements:
            # Each task ID maps to a persistent venv; same task reuses the same env
            venv_dir = Path(settings.work_dir) / '.venvs' / task_id
            python_bin = await ensure_venv(venv_dir, requirements)
            cmd = [str(python_bin), entrypoint]
        else:
            cmd = ['python3', entrypoint]
    elif runtime == 'node':
        import sys
        node_exe = 'node.exe' if sys.platform == 'win32' else 'node'
        cmd = [node_exe, entrypoint]
    elif runtime == 'shell':
        import sys
        if sys.platform == 'win32':
            cmd = ['cmd.exe', '/c', entrypoint]
        else:
            cmd = ['bash', '-c', f'cd "{work_dir}" && exec "{entrypoint}"']
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
            preexec_fn=os.setsid,  # Create a new process group for clean termination
        )
        log_chunks: list[str] = []

        async def _stream_to_file() -> None:
            with open(log_file, 'a', encoding='utf-8') as lf:
                async for raw_line in proc.stdout:  # type: ignore[union-attr]
                    line = raw_line.decode('utf-8', errors='replace')
                    log_chunks.append(line)
                    lf.write(line)
                    lf.flush()

        stream_task = asyncio.ensure_future(_stream_to_file())
        try:
            await asyncio.wait_for(asyncio.shield(stream_task), timeout=timeout)
        except asyncio.TimeoutError:
            stream_task.cancel()
            raise
        await proc.wait()

        logs_full = ''.join(log_chunks)
        # Truncate to keep both beginning and end, preserving important context
        max_length = 10000
        if len(logs_full) > max_length:
            half = max_length // 2
            logs = f'{logs_full[:half]}\n...[truncated, total {len(logs_full)} chars]...\n{logs_full[-half:]}'
        else:
            logs = logs_full

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
        try:
            if proc.pid is not None:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, OSError):
            proc.kill()
        duration_ms = int((time.monotonic() - started_at) * 1000)
        return {
            'success': False,
            'logs': ''.join(log_chunks) if 'log_chunks' in locals() else '',
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
            'errorMessage': str(e.detail),
            'durationMs': int((time.monotonic() - started_at) * 1000),
        }
    except Exception as e:
        logging.exception('Unexpected error during task execution')
        return {
            'success': False,
            'logs': '',
            'exitCode': None,
            'errorMessage': str(e),
            'durationMs': int((time.monotonic() - started_at) * 1000),
        }
