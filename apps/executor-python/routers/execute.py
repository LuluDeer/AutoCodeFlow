import asyncio
import logging
import os
import stat
import re
import shutil
import subprocess
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException
from typing import Any, Optional
import scheduler as sched
from auth import verify_token
from config import settings
from manifest import load_manifest, merge_task_with_manifest
try:
    from autoflow_sdk.models import ExecuteRequest
except ImportError:
    # Fallback if SDK is not installed — define locally for compatibility
    from pydantic import BaseModel
    from typing import Dict
    class ExecuteRequest(BaseModel):  # type: ignore[no-redef]
        executionId: str
        task: Dict[str, Any]
        params: Optional[Dict[str, Any]] = None


def _repo_dir_name(repo_url: str) -> str:
    """将 git URL 转成安全缓存目录名（取最后一段，去掉 .git 后缀）"""
    name = repo_url.rstrip('/').split('/')[-1]
    name = re.sub(r'\.git$', '', name)
    return re.sub(r'[^a-zA-Z0-9_.-]', '_', name)


def git_checkout_to(repo_url: str, ref: str, dest: Path) -> None:
    """Clone（带缓存）并 checkout 指定 ref 到 dest 目录。"""
    cache_dir = Path(settings.work_dir) / '.git_cache' / _repo_dir_name(repo_url)
    if not cache_dir.exists():
        cache_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'clone', '--bare', repo_url, str(cache_dir)],
                       check=True, timeout=120)
    else:
        subprocess.run(['git', '-C', str(cache_dir), 'fetch', '--all'],
                       check=True, timeout=60)
    dest.mkdir(parents=True, exist_ok=True)
    # --work-tree 加 checkout 把指定 ref 的文件导出到 dest
    subprocess.run(
        ['git', f'--git-dir={cache_dir}', f'--work-tree={dest}',
         'checkout', ref, '--', '.'],
        check=True, timeout=30,
    )

router = APIRouter()
logger = logging.getLogger(__name__)

# uv 可执行路径（优先 PATH 中，Dockerfile 安装到 /root/.cargo/bin/uv）
UV_BIN = shutil.which('uv') or '/root/.local/bin/uv'


# Q-01: removed duplicate ExecuteRequest definition — use the SDK class (or fallback above)

@router.post('/execute', dependencies=[Depends(verify_token)])
async def execute(req: ExecuteRequest):
    if sched.get_running_count() >= settings.max_concurrent_tasks:
        raise HTTPException(status_code=429, detail='Executor is at capacity')

    sched.increment_running()
    try:
        result = await run_task(req)
        return result
    finally:
        sched.decrement_running()


async def ensure_venv(venv_dir: Path, requirements: list[str]) -> Path:
    """用 uv 创建/复用虚拟环境并安装依赖，返回 python 可执行路径。"""
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
        proc = await asyncio.create_subprocess_exec(
            UV_BIN, 'pip', 'install',
            '--python', str(python_bin),
            *requirements,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=300)
        if proc.returncode != 0:
            raise RuntimeError(f'uv pip install failed: {out.decode()}')

    return python_bin


async def run_task(req: ExecuteRequest) -> dict:
    # 工作目录
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
    except Exception:
        pass

    # --- Git 版本绑定：若任务指定了 gitRepo 则 clone/checkout 到工作目录 ---
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

    # 加载 manifest.yaml 并与 task 合并（task 字段优先）
    manifest = load_manifest(work_dir)
    task = merge_task_with_manifest(req.task, manifest)

    runtime = task.get('runtime', 'python')
    entrypoint = task.get('entrypoint', 'main.py')
    timeout = task.get('timeout', 300)
    requirements: list[str] = task.get('requirements', [])
    task_id = str(task.get('id', req.executionId))

    # SEC-01: only pass a whitelist of env vars to child process — never expose executor secrets
    _ENV_WHITELIST = {
        'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
        'PYTHONPATH', 'PYTHONHASHSEED', 'VIRTUAL_ENV',
        'NODE_PATH', 'TMPDIR', 'TEMP', 'TMP',
        'USER', 'LOGNAME', 'SHELL',
    }
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
            # 每个任务 ID 对应一个持久化 venv，相同任务复用
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
        raise HTTPException(status_code=400, detail=f'Unsupported runtime: {runtime}')

    logger.info(f'Running task {task.get("name")} [{req.executionId}]: {cmd}')

    log_file = work_dir / f'{req.executionId}.log'
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(work_dir),
            env=env,
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

        if proc.returncode != 0:
            raise RuntimeError(f'Process exited with code {proc.returncode}\n{logs}')

        return {'success': True, 'logs': logs, 'exitCode': proc.returncode}
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(status_code=408, detail=f'Task timeout after {timeout}s')
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
