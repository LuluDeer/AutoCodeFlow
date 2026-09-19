import asyncio
import hashlib
import inspect
import ipaddress
import json
import logging
import os
import signal
import socket
import stat
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import random
from pathlib import Path
from urllib.parse import urlsplit
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from typing import Any, Callable, Optional
import scheduler as sched
from maintenance import DISK_CRITICAL_PERCENT, disk_usage_percent
from auth import verify_token, get_current_token, request_with_self_heal
from admin_api import build_admin_api_url, get_admin_api_base_url
from config import settings
from execution_callback_token import CALLBACK_TOKEN_GRACE_SECONDS, create_execution_callback_token
from manifest import load_manifest, merge_task_with_manifest
from artifacts import gather_artifacts_for_callback, artifacts_dir_for
from sandbox import (
    SandboxUnavailable,
    build_rlimit_pre_exec,
    build_sandbox_cmd,
    with_task_tmpdir,
)
from pydantic import ValidationError
# A3-C：协议闸门（由 packages/executor-protocol/protocol.json 生成，勿手改产物）。
# 与下面的 ExecuteRequest（autocodeflow_sdk / 本地 fallback）分工不同：那个是
# FastAPI 的**反序列化**模型（task 保持 dict，全代码库按字典访问），这个是
# **协议校验**模型——两者并存是因为改前者要动 2000+ 行的访问方式，风险远大于收益。
from generated.protocol_schemas import (
    ExecuteRequest as ProtocolExecuteRequest,
    KillResponse as ProtocolKillResponse,
)


def _kill_body(ok: bool) -> dict:
    """A3（kill/logs 契约化）：kill 出参必经生成的 KillResponse——两侧逐字段
    同形 `{ok:bool}` 且 forbid 额外键。校验失败 = 本端把响应形状改漂移了，
    直接抛错走 500，而不是发一个 admin 无法解析的载荷。"""
    return ProtocolKillResponse.model_validate({'ok': ok}).model_dump()
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


# ---------------------------------------------------------------------------
# python_task_multiversion (WS4) — 解释器池 / zip 安全两个模块（CONTRACT.md §3.2，
# 由 WS3 提供）。二者是执行器侧的**唯一事实源**，本文件只消费其接口、绝不自己
# 拼 `uv python install` 之类的命令。
#
# 这里包一层 import 守卫的原因：WS3 与本文件并行开发，模块在集成前可能尚不存在。
# 缺失时退化为"空池 + 明确失败"，而不是 ImportError 让**整个执行器**（含存量
# 三渠道）起不来——探测/上报失败不得阻断启动（FR-14/AC-14b 的同一条纪律）。
# 集成时两个模块必然存在，走的是上面的真实分支。
# ---------------------------------------------------------------------------
try:
    import interpreters as _interpreters
except ImportError:  # pragma: no cover - 仅并行开发期可达
    _interpreters = None  # type: ignore[assignment]

try:
    import zip_safety as _zip_safety
except ImportError:  # pragma: no cover - 仅并行开发期可达
    _zip_safety = None  # type: ignore[assignment]


def _interpreter_unavailable_exc() -> type:
    """解释器不可获取的异常类型（WS3 `InterpreterUnavailable`）。

    模块缺席时返回本文件内的等价类，保证 except 子句在任何时候都合法。"""
    if _interpreters is not None:
        return getattr(_interpreters, 'InterpreterUnavailable', RuntimeError)
    return RuntimeError


def _pool_summary() -> dict:
    """解释器池快照（CONTRACT.md §3.2 `pool_summary`），失败返回空快照。

    `result.interpreter.pool` 与失败消息的候选清单都用它；探测失败绝不能让
    任务失败路径再抛一次异常（留痕是 best-effort）。"""
    if _interpreters is None:
        return {'install_dir': '', 'versions': []}
    try:
        summary = _interpreters.pool_summary()
    except Exception as exc:  # noqa: BLE001 - 留痕失败不升级为任务失败
        logger.warning('interpreter pool_summary failed: %s', exc)
        return {'install_dir': '', 'versions': []}
    if not isinstance(summary, dict):
        return {'install_dir': '', 'versions': []}
    versions = summary.get('versions')
    return {
        'install_dir': str(summary.get('install_dir') or ''),
        'versions': [str(v) for v in versions] if isinstance(versions, (list, tuple)) else [],
    }


def _build_uv_env(cache_dir: Path) -> dict[str, str]:
    """uv 子进程环境（venv / pip install 两个阶段共用）。

    D8 硬化（lead 实测确认，uv 0.8.17）：`UV_PYTHON_DOWNLOADS=manual` 让
    `uv venv --python <x>` 在池内缺版本时**硬拒绝**（exit 2，
    "No interpreter found … Python downloads are set to 'manual'"），
    `uv python install` 仍可正常下载。于是"venv 阶段绝不触发下载"这条契约
    由 uv 自己兜底：即便本文件的路径解析出了 bug，也不会绕过 D13 的全局单
    下载队列偷偷下载。

    优先复用 WS3 `interpreters.py` 的公开 builder（两处环境不可能漂移）；
    尚未提供时退化为本文件的 `_build_install_env` + 显式同名开关。
    """
    builder = getattr(_interpreters, 'build_uv_env', None) if _interpreters is not None else None
    if callable(builder):
        try:
            # 集成实测：WS3 的签名是 `build_uv_env(*, cache_dir=None)`——**仅关键字**。
            # 位置传参会 TypeError，进而静默退化成下面的本地兜底（两个 builder
            # 从此漂移）。这里显式按关键字调用。
            env = builder(cache_dir=cache_dir)
            if isinstance(env, dict):
                return {str(k): str(v) for k, v in env.items()}
        except Exception as exc:  # noqa: BLE001 - builder 不可用时退回本地白名单
            logger.warning('interpreters.build_uv_env failed (%s); falling back to local whitelist', exc)
    env = _build_install_env(cache_dir)
    env['UV_PYTHON_DOWNLOADS'] = 'manual'
    return env


async def _call_ws3(fn, *args, **kwargs):
    """调用 WS3 的解释器接口，同步/异步两种形态都支持。

    CONTRACT.md §3.2 冻结的是**同步**签名，但同一条并行开发纪律下模块可能以
    coroutine 形式落地。这里按返回值判定并 await——同步实现走
    `asyncio.to_thread`，绝不阻塞事件循环（uv 子进程可能跑满 300s 下载预算）。
    """
    if inspect.iscoroutinefunction(fn):
        return await fn(*args, **kwargs)
    result = await asyncio.to_thread(fn, *args, **kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


async def _ensure_interpreter(version: str, timeout: float):
    """获取（必要时下载）指定版本解释器，返回池内绝对路径。

    薄封装：模块缺席 / 接口缺失时抛 RuntimeError，由调用方归类为
    interpreter_unavailable —— 绝不让 AttributeError 之类的实现细节漏给用户。

    集成实测：WS3 同时提供了同步 `ensure_version()` 与 async
    `ensure_version_async()`。**必须优先走 async 入口**——D13/NFR-16 的"全局
    单下载队列"（`asyncio.Semaphore(1)`）只在 `ensure_version_async` 里获取；
    直接 to_thread 调同步版会绕过该队列，并发多版本下载同时开跑，带宽与
    "同一时刻全局至多一个 in-flight 下载"的契约同时失守。
    """
    if _interpreters is None:
        raise RuntimeError(
            f'解释器 {version} 无法获取（解释器池模块不可用：interpreters 缺失）'
        )
    async_fn = getattr(_interpreters, 'ensure_version_async', None)
    if callable(async_fn):
        return await async_fn(version, timeout=timeout)
    fn = getattr(_interpreters, 'ensure_version', None)
    if not callable(fn):
        raise RuntimeError(
            f'解释器 {version} 无法获取（解释器池模块不可用：interpreters.ensure_version 缺失）'
        )
    return await _call_ws3(fn, version, timeout=timeout)


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


def _is_shallow_bare_repo(cache_dir: Path) -> bool:
    """A `git clone --bare --depth 1` leaves a `shallow` sentinel in the bare
    git-dir (O-13 shallow-clone compatibility probe)."""
    try:
        return (cache_dir / 'shallow').is_file()
    except OSError:
        return False


def _unshallow_bare_repo(cache_dir: Path) -> None:
    """Fetch full history into a shallow bare cache (O-13 best-effort).

    A `--depth 1` clone is fast but only contains the tip of the default
    branch; the checkout step exports an *arbitrary* ref (branch/tag/commit)
    that may sit deeper than the shallow boundary. Plain `fetch --all` keeps
    the cache shallow, so the first refresh (and a checkout miss) deepens it
    once back to the original full-clone behavior — arbitrary refs then resolve
    exactly as before, with no regression for existing tasks. Best-effort: an
    already-complete cache (single-commit repo) or an uncooperative remote logs
    a warning and falls through to the normal fetch/checkout."""
    if not _is_shallow_bare_repo(cache_dir):
        return
    try:
        subprocess.run(['git', '-C', str(cache_dir), 'fetch', '--unshallow'],
                       check=True, timeout=_git_clone_timeout())
        logger.info('Unshallowed git cache %s (restored full history)', cache_dir.name)
    except subprocess.CalledProcessError as exc:
        # Already complete / concurrent unshallow / remote does not support it —
        # fall through; the checkout-miss retry handles the remaining case.
        logger.warning('git fetch --unshallow on %s failed (best-effort): %s',
                       cache_dir.name, exc)
    except Exception as exc:  # pragma: no cover - network/timeout guard
        logger.warning('git unshallow on %s raised (best-effort): %s', cache_dir.name, exc)


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
            # O-13: shallow first population (--depth 1) — much faster for the
            # common "check out the tip" case. The cache is deepened on the
            # first refresh (and on a checkout miss) so arbitrary refs keep
            # resolving like the old full clone.
            subprocess.run(['git', 'clone', '--bare', '--depth', '1', repo_url, str(cache_dir)],
                           check=True, timeout=_git_clone_timeout())
        except Exception:
            # A failed clone leaves a partial bare repo behind; the existence
            # check above would then skip re-cloning forever.
            shutil.rmtree(cache_dir, ignore_errors=True)
            raise
    else:
        # O-13: a depth-1 cache stays shallow under plain `fetch --all`; deepen
        # it once so arbitrary-ref checkouts don't regress.
        _unshallow_bare_repo(cache_dir)
        subprocess.run(['git', '-C', str(cache_dir), 'fetch', '--all'],
                       check=True, timeout=60)
    dest.mkdir(parents=True, exist_ok=True)
    # --work-tree + checkout exports files at the given ref to dest.
    try:
        subprocess.run(
            ['git', f'--git-dir={cache_dir}', f'--work-tree={dest}',
             'checkout', ref, '--', '.'],
            check=True, timeout=30,
        )
    except subprocess.CalledProcessError:
        # O-13: the shallow clone may not contain the requested ref (a tag or
        # non-default branch). Deepen once and retry so behavior matches the old
        # full clone for arbitrary refs.
        if not _is_shallow_bare_repo(cache_dir):
            raise
        _unshallow_bare_repo(cache_dir)
        subprocess.run(
            ['git', f'--git-dir={cache_dir}', f'--work-tree={dest}',
             'checkout', ref, '--', '.'],
            check=True, timeout=60,
        )

router = APIRouter()
logger = logging.getLogger(__name__)


def _refine_failure_reason(message: str) -> Optional[str]:
    """BUG-10：从 prepare/运行期异常文本归类细粒度 failureReason。

    对齐 admin ExecutionFailureReason 与 node 侧 prepareFailureReason 的
    细化规则：git 拉取 / 依赖安装（uv venv + uv pip install）/ 运行时缺失
    （uv/git/python 可执行文件不存在）。返回 None 表示不设 reason，交给
    admin 端 inferFailureReason 兜底（旧语义不变）。

    FR-08（python_task_multiversion）：新增 `interpreter_unavailable` 规则，
    **必须排在依赖安装规则之前**。理由：解释器池缺版本时 uv 的原文是
    ``uv venv failed: ... No interpreter found for Python 3.9 ...``——先撞上
    dependency_install_failed 的正则就被误吞，用户看到"依赖装不上"而不是
    "解释器取不到"，排查方向直接跑偏（AC-12a）。
    """
    if not message:
        return None
    lowered = message.lower()
    if re.search(
        r"no interpreter found"
        r"|no download found"
        r"|interpreter .{0,80}(unavailable|not found)"
        r"|interpreterunavailable"
        # WS3 `InterpreterUnavailable.__str__` 的原文形状：
        #   "Python 3.7 unavailable (not_downloadable): …"
        # 以及 reason 取值表（CONTRACT.md §3.2 + uv_missing 扩展）。这两条让
        # 原始异常文本即使没经过执行器的中文包装也能被正确归类。
        r"|python \d+(\.\d+)*( unavailable| not found)"
        r"|\((not_downloadable|download_failed|download_timeout|mirror_unreachable|corrupt|uv_missing)\)"
        r"|解释器.{0,40}(无法获取|不可用|未找到)",
        lowered,
    ):
        return "interpreter_unavailable"
    # FR-08（zip 渠道）：包下载/体积/安全审查失败。`package_fetch_failed` 本就
    # 在协议枚举里（executorReportable），此前执行器没有任何路径会产出它。
    if re.search(
        r"package download failed"
        r"|package exceeds the"
        r"|zip package rejected"
        r"|packageurl",
        lowered,
    ):
        return "package_fetch_failed"
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
    # SEC-NEW (F-1): 沙箱配置启用但不可用（bwrap 缺失 / 用户命名空间被禁）。
    # 独立归类便于 admin 端区分「任务代码问题」与「执行器沙箱配置问题」。
    if re.search(r"task_sandbox|sandbox|bwrap", lowered):
        return "sandbox_unavailable"
    return None


def _executor_callback_address() -> str:
    return settings.executor_address_public or settings.executor_address or f'127.0.0.1:{settings.port}'


def _get_admin_api_url() -> str:
    """Get the appropriate Admin API base URL for execution callbacks."""
    return get_admin_api_base_url()


def _get_callback_token() -> str:
    """Return the shared token used to authenticate execution callbacks."""
    return settings.executor_shared_token or settings.executor_secret


# uv is installed by requirements.txt into /usr/local/bin in the image. Keep a
# PATH lookup only: falling back to root's home would be unusable as appuser and
# could accidentally select an unpinned host installation.
UV_BIN = shutil.which('uv') or 'uv'


def _validate_registry_url(value: str) -> str:
    """Validate the explicit package index URL before passing it to uv.

    Registry URLs are configuration, not task input. Userinfo, query strings,
    and fragments can carry credentials or alter resolution while appearing in
    argv and subprocess diagnostics. Credentials must be supplied by a future
    controlled mechanism (for example a mounted uv keyring/config), never in
    ``PYPI_REGISTRY_URL``.
    """
    if not isinstance(value, str):
        raise RuntimeError('Invalid PYPI_REGISTRY_URL')
    url = value.strip()
    if not url:
        return ''
    try:
        parsed = urlsplit(url)
    except ValueError as exc:
        raise RuntimeError('Invalid PYPI_REGISTRY_URL') from exc
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
        raise RuntimeError('PYPI_REGISTRY_URL must be an http(s) URL')
    if parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
        raise RuntimeError(
            'PYPI_REGISTRY_URL must not contain userinfo, query, or fragment; '
            'provide registry credentials through a controlled credentials mechanism'
        )
    return url


# Dependency installers must not inherit the executor process environment. In
# particular, pip/uv honor PIP_* / UV_* variables and user config files, which
# can contain host credentials or redirect package downloads. Keep only the
# runtime paths and temp/cache locations required by uv. Registry selection is
# passed explicitly with --index-url below.
_INSTALL_ENV_KEYS = {
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'TMPDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR',
    'COMSPEC', 'PATHEXT',
}
_INSTALL_ENV_DENYLIST = {
    'EXECUTOR_SHARED_TOKEN', 'EXECUTOR_SECRET', 'EXECUTION_CALLBACK_SECRET',
    'NPM_REGISTRY_TOKEN', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL',
    'PIP_TRUSTED_HOST', 'UV_INDEX', 'UV_EXTRA_INDEX_URL', 'UV_DEFAULT_INDEX',
    'UV_INSECURE_HOST', 'UV_CONFIG_FILE', 'PYTHONPATH',
}


def _build_install_env(cache_dir: Path) -> dict[str, str]:
    """Return the minimal environment for uv venv/pip subprocesses.

    The task runtime has a separate, richer whitelist; dependency resolution is
    more sensitive because uv/pip consume ambient config variables. Explicitly
    retain only platform path/home/temp values plus an isolated cache and tell
    uv not to consult any user/project configuration.
    """
    env: dict[str, str] = {}
    if sys.platform == 'win32':
        allowed = {key.upper() for key in _INSTALL_ENV_KEYS}
        for key, value in os.environ.items():
            if key.upper() in allowed and key.upper() not in _INSTALL_ENV_DENYLIST:
                env[key.upper()] = value
    else:
        for key, value in os.environ.items():
            if key in _INSTALL_ENV_KEYS and key not in _INSTALL_ENV_DENYLIST:
                env[key] = value
    cache_dir.mkdir(parents=True, exist_ok=True)
    env['UV_CACHE_DIR'] = str(cache_dir)
    env['UV_NO_CONFIG'] = '1'
    env['PIP_CONFIG_FILE'] = os.devnull
    return env


# Timeouts for the two uv phases (module-level so tests can shrink them)
# UV_VENV_TIMEOUT_SECONDS 与 executor-node 的 UV_VENV_TIMEOUT_MS（120s，
# execute.ts:711）对齐——复杂环境（大 requirements / 慢磁盘 / 首次建 venv
# 触发 uv 引导自身）下 60s 更易超时，两侧必须对等。
UV_VENV_TIMEOUT_SECONDS = 120
UV_PIP_TIMEOUT_SECONDS = 300


def _interpreter_download_timeout() -> float:
    """解释器**下载**的独立时间预算（D11/NFR-13）。

    为什么不能复用 `UV_VENV_TIMEOUT_SECONDS`：那个 120s 是"在**本地**建一个
    venv"的预算，而解释器下载要走网络（默认从 GitHub 拉 ~30MB 的
    python-build-standalone，内网镜像还可能更慢）。用 60s 卡下载，等于让
    "首次声明某个版本"的任务在网络稍慢时**必然**超时成
    `interpreter_unavailable`——而这恰恰是 D14 要求"明确失败、绝不回退"的那条
    路径，用户看到的是一个看起来像"这个版本不存在"的失败。

    executor-node 侧读的是 `config.interpreterDownloadTimeoutMs`（默认 300s，
    见 interpreters.ts:645），两侧必须对等，故这里也读 settings 的同名配置
    （默认 300s，config.py:148）。缺省/非法一律回落 300，绝不回落 0
    （0 会让每次下载立即超时）。
    """
    raw = getattr(settings, 'interpreter_download_timeout_seconds', 300)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 300.0
    if not value > 0:
        return 300.0
    return value


def _git_clone_timeout() -> float:
    """执行器侧 `git clone --bare` 超时预算（P3 配置化）。

    默认 120s = 原硬编码值（`_git_checkout_to_locked` 里的 `timeout=120`），
    仅部署方需要调大仓库首克隆预算时经 `GIT_CLONE_TIMEOUT_SECONDS` 覆盖。
    缺省/非法一律回落 120，绝不回落 0（0 会让每次克隆立即超时）。"""
    raw = getattr(settings, 'git_clone_timeout_seconds', 120)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 120.0
    return value if value > 0 else 120.0


def _callback_logs_max_chars() -> int:
    """回调载荷日志截断长度（P3 配置化）。

    默认 10000 = 原硬编码值（`_truncate_logs` 里的 `max_length = 10000`），
    仅在需要放大回调日志窗口时经 `CALLBACK_LOGS_MAX_CHARS` 覆盖。
    缺省/非法一律回落 10000，绝不回落 0（0 会把每条日志截成空串）。"""
    raw = getattr(settings, 'callback_logs_max_chars', 10000)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 10000
    return value if value > 0 else 10000

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


def _spawn_kwargs_for_platform(rlimit_fn: Optional[Callable[[], None]] = None) -> dict:
    """W-02 (windows-findings): POSIX detaches each task into its own process
    group via preexec_fn=os.setsid so the timeout kill can take the whole
    tree down. Windows has no setsid/process groups and asyncio rejects
    preexec_fn there outright — accessing os.setsid on win32 raised
    AttributeError and every real task failed. The equivalent isolation is
    CREATE_NEW_PROCESS_GROUP; tree kill on timeout uses taskkill /T /F.

    SEC-NEW (B-1): ``rlimit_fn`` (from sandbox.build_rlimit_pre_exec) is run
    in the same preexec stage on POSIX — after fork, before exec — so task
    resource caps (RLIMIT_AS/CPU/FSIZE/NOFILE/NPROC) apply to the task process
    tree from its very first instruction.
    """
    if sys.platform == 'win32':
        return {
            'creationflags': (
                subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
            ),
        }
    if rlimit_fn is None:
        return {'preexec_fn': os.setsid}
    preexec_fn = os.setsid

    def _combined() -> None:
        preexec_fn()
        rlimit_fn()

    return {'preexec_fn': _combined}


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


# E-02（P1）timeout=0 三种语义收敛（node routes/execute.ts 改动4 对齐）：
# 0 = 显式不限时——执行等待不设超时（asyncio.wait_for 的 timeout=None 即无限
# 等待，不会触发 TimeoutError 杀树分支），回调 token TTL 取 10 年上限（admin
# 侧僵尸回收对该类任务本就有 1h 兜底窗口，node 同名常量 315_360_000s 对齐：
# 86400s/天 × 3650）。admin 侧 task 实体默认创建的 timeout 就是 0 且派发载荷
# 原样携带——旧 or-链把 0 当 falsy 与「缺省」混为一谈回落 300s 后杀，admin
# 默认创建路径即在 python 执行器上被错误超时杀掉（node 侧无此问题）。
TOKEN_TTL_UNBOUNDED_SECONDS = 315_360_000


def _resolve_task_timeout(task: dict) -> int:
    """E-02: 显式解析任务 timeout——``timeoutSeconds ?? timeout_seconds ??
    timeout``（逐键 is None 判空而非 or-链，0 能穿过）。

    返回值语义（node execute.ts 同构）：
      * 0             → 不限时（执行等待不设 timeout；回调 token TTL 取
                        TOKEN_TTL_UNBOUNDED_SECONDS 上限，见调用点）；
      * 其他可解析值  → 维持既有 clamp 行为（[1, 86400]；负值对齐属另一项，
                        不在本修复范围）；
      * 缺省/不可解析 → settings.task_timeout_seconds 默认。
    """
    raw = task.get('timeoutSeconds')
    if raw is None:
        raw = task.get('timeout_seconds')
    if raw is None:
        raw = task.get('timeout')
    if raw is None:
        return _clamp_timeout_seconds(
            settings.task_timeout_seconds, settings.task_timeout_seconds
        )
    try:
        seconds = int(raw)
    except (TypeError, ValueError):
        # 非法值维持既有 clamp 行为（回落默认值）
        return _clamp_timeout_seconds(raw, settings.task_timeout_seconds)
    if seconds == 0:
        return 0  # 显式不限时
    return _clamp_timeout_seconds(seconds, settings.task_timeout_seconds)


def _ensure_entrypoint_in_workdir(entrypoint: str, work_dir: Path) -> None:
    """R4-C P3: reject entrypoints that escape the execution work directory
    (`../evil.sh`, or absolute paths pointing elsewhere). Glue scripts run via
    absolute paths *inside* work_dir, so those remain allowed.

    R4-C P4（本轮审计）：判定改为**与宿主平台无关**。此前用 Path(entrypoint) 的
    is_absolute()/parts，含义随 OS 变化，于是同一份输入在两平台结论不同：
      - Windows: `C:evil.bat` 是驱动器相对路径（drive='C:'、parts 无 '..'），
        两道分支都不命中 → 放行，实测解析到 C:\\evil.bat（work_dir 之外）；
      - Linux: `..\\evil.bat` 的 parts 是 ('..\\\\evil.bat',) —— 整串一个 part，
        `'..' in parts` 不命中 → 放行。
    安全判定不该取决于执行器恰好跑在哪个系统上，故改为：
      1. 先按 '/' 与 '\\\\' **两种分隔符**切分，任一分段为 '..' 即拒；
      2. 带盘符（`X:` 前缀）或首字符为分隔符 → 按绝对路径处理，交给
         relative_to(work_dir) 裁决；
      3. 绝对路径不在 work_dir 内即拒。
    """
    normalized = entrypoint.replace('\\', '/')
    # 1) 任一 '..' 分段即拒（跨平台，两种分隔符都覆盖）
    if '..' in normalized.split('/'):
        raise HTTPException(
            status_code=400,
            detail=f'entrypoint escapes the execution work directory: {entrypoint}',
        )

    # 2) 带盘符（C:...）或根相对（/... 或 \\...）→ 一律按绝对路径判定
    has_drive = len(entrypoint) >= 2 and entrypoint[1] == ':' and entrypoint[0].isalpha()
    if has_drive or entrypoint.startswith(('/', '\\')):
        # 绝对路径只有在**确实位于 work_dir 之内**时才允许（胶水脚本正是以
        # work_dir 内的绝对路径调用的）。驱动器相对路径（`C:` 后直接跟名字，
        # 无分隔符）无法用 relative_to 可靠判定——它在 Windows 上相对该盘的
        # 当前目录解析，可能落在 work_dir 之外，故一律拒绝。
        drive_relative = has_drive and not entrypoint[2:3] in ('/', '\\')
        if drive_relative:
            raise HTTPException(
                status_code=400,
                detail=f'entrypoint escapes the execution work directory: {entrypoint}',
            )
        try:
            Path(normalized).relative_to(work_dir)
        except ValueError:
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
    max_length = _callback_logs_max_chars()
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


# NETOPT-6②: 在跑执行已解析的池解释器路径登记表（maintenance 池回收的
# liveness 否决权数据源；与上方 _live_executions 同一 threading.Lock 纪律）。
# 背景：glue（AC-11a）与无依赖 python（AC-04c）两条路径把池解释器直接当
# cmd[0] 跑、不建 venv——`_venv_dependency_homes` 的 pyvenv.cfg home 扫描
# 覆盖不了它们；而池目录 mtime 只在安装时写入，活跃版本反而最优先被 LRU
# 回收。不登记的话，6h 清扫/紧急清扫会在任务运行中途 rmtree 掉解释器目录，
# 在跑任务当场断火。登记点：`_ensure_interpreter` 解析成功后（ensure_venv 的
# uv venv 窗口、glue、无依赖 python 三处）；注销点：ensure_venv 的 finally、
# run_task spawn 前 killed 检查点早退、run_task 的 finally（幂等 discard）。
# main.py lifespan 通过 maintenance.register_live_pool_paths_provider 接线。
_live_pool_interpreters: set[str] = set()
_live_pool_interpreters_lock = threading.Lock()


def _register_live_pool_interpreter(path: 'str | Path') -> None:
    """登记一个正在被使用的池解释器路径（幂等；str 化后存集合）。"""
    with _live_pool_interpreters_lock:
        _live_pool_interpreters.add(str(path))


def _unregister_live_pool_interpreter(path: 'str | Path | None') -> None:
    """解除登记（幂等 discard；None 或未登记的路径均为无害 no-op）。"""
    if path is None:
        return
    with _live_pool_interpreters_lock:
        _live_pool_interpreters.discard(str(path))


def list_live_pool_interpreter_paths() -> list[str]:
    """maintenance.register_live_pool_paths_provider 的数据源（快照副本）。"""
    with _live_pool_interpreters_lock:
        return sorted(_live_pool_interpreters)


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


# ---------------------------------------------------------------------------
# python_task_multiversion（WS4）：版本 / zip 渠道的模块级常量与纯函数。
#
# 全部放在模块级（而非 run_task 内联）有两个理由：一是可被 pytest 直接断言，
# 二是 `runtimeVersion` 是**任务提供的字符串**，它要进 uv argv 与目录名，必须
# 有且只有一处过白（NFR-03 防注入）。
# ---------------------------------------------------------------------------

# CONTRACT.md §1.1：主.次版本，无补丁号（D1）。补丁号（"3.7.9"）在本平台不是
# 合法声明值——匹配语义是前缀匹配，声明粒度就是主.次。
RUNTIME_VERSION_PATTERN = re.compile(r'^\d+\.\d+$')

# AC-03a / NFR-04：zip 下载体积上限（与 admin 上传侧 200MB 限制同值，CON-03）。
ZIP_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024
# NFR-09：下载/解压属任务准备阶段。整体超时预算独立于任务超时（任务超时在
# 运行阶段才生效，准备阶段不能不受控挂起）。
ZIP_DOWNLOAD_TIMEOUT_SECONDS = 120.0

# D4/AC-04c：包内 requirements.txt 的解析上限。超限即拒（而不是截断）——
# 一个 8MB 的 requirements.txt 只可能是恶意/损坏输入，截断会静默改变依赖集。
ZIP_REQUIREMENTS_MAX_BYTES = 1024 * 1024

# requirements.txt 里"不是包名"的行前缀：pip 选项（-r/-e/--index-url/--hash…）。
# 与 `_validate_requirements` 同一条纪律——`-` 开头的行会被 uv 当**选项**解析，
# 是索引劫持向量，因此绝不透传给 uv。
_REQUIREMENTS_OPTION_PREFIXES = ('-', '--')


def _is_interpreter_unavailable(exc: BaseException) -> bool:
    """异常是否表示"解释器取不到"。

    WS3 的 `InterpreterUnavailable` 是唯一权威判据；同时按消息兜底匹配 uv 的
    原文——模块形态在集成期可能有出入，但"拿不到解释器"这件事必须归类正确，
    不能因为异常类型漂移就退化成 unknown。"""
    if _interpreters is not None:
        exc_type = getattr(_interpreters, 'InterpreterUnavailable', None)
        if isinstance(exc_type, type) and isinstance(exc, exc_type):
            return True
    return _refine_failure_reason(str(exc)) == 'interpreter_unavailable'


def _package_requirements_path(work_dir: Path) -> Path | None:
    """定位解压后的包内 requirements.txt（大小写不敏感，取首个匹配）。

    Windows 上 `Requirements.txt` 是合法文件名而 Linux 上不是；两侧都接受可以
    让同一个 zip 在任何执行器宿主上行为一致。"""
    try:
        for entry in work_dir.iterdir():
            if entry.is_file() and entry.name.lower() == 'requirements.txt':
                return entry
    except OSError as exc:
        logger.warning('Cannot scan %s for requirements.txt: %s', work_dir, exc)
    return None


def _parse_requirements_file(text: str) -> list[str]:
    """把 requirements.txt 文本解析为需求规格列表（去噪，不做语义解析）。

    只做三件事：去注释（`#`，含行内）、去空白、丢弃 pip **选项行**与其它
    不可解析的结构（`[extras]` 段头、裸 URL/路径）。刻意**不**实现
    `-r other.txt` 的递归展开：那会让包内文本决定执行器去读哪个文件，是
    不必要的攻击面；跳过并记日志即可（与 `_validate_requirements` 拒绝选项
    行同一条纪律，只是包内文件是数据而非任务参数，静默跳过更合适）。
    """
    specs: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.split('#', 1)[0].strip()
        if not line:
            continue
        if line.startswith(_REQUIREMENTS_OPTION_PREFIXES):
            logger.info('Skipping option line in package requirements.txt: %r', line)
            continue
        if line.startswith('[') and line.endswith(']'):
            continue  # pip 的 [global]/[install] 配置段头
        if line.startswith(('http://', 'https://', 'file://', '/', '.', '~')):
            logger.info('Skipping non-spec line in package requirements.txt: %r', line)
            continue
        specs.append(line)
    return specs


def _read_package_requirements(work_dir: Path) -> list[str]:
    """读取包内 requirements.txt（不存在/超限/不可读 → 空列表 + 日志）。

    超限**不**解析：宁可按"无包内依赖"处理并留下明确日志，也不截断后安装一个
    被悄悄改过的依赖集。"""
    path = _package_requirements_path(work_dir)
    if path is None:
        return []
    try:
        if path.stat().st_size > ZIP_REQUIREMENTS_MAX_BYTES:
            logger.warning(
                'Package requirements.txt %s exceeds %d bytes — ignored '
                '(install the dependencies via the task-level requirements instead)',
                path, ZIP_REQUIREMENTS_MAX_BYTES,
            )
            return []
        return _parse_requirements_file(path.read_text(encoding='utf-8', errors='replace'))
    except OSError as exc:
        logger.warning('Failed to read package requirements.txt %s: %s', path, exc)
        return []


def _requirement_key(spec: str) -> str:
    """同一包名的归一化键（D4 的"同名覆盖"判定用）。

    取包名（去掉 extras/环境标记/版本约束）并按 **PEP 503** 归一：小写 + 把
    `-`/`_`/`.` 的连续串折叠成单个 `-`。于是 `Requests>=2`、
    `requests[socks]==2.31`、`requests ; python_version<'3.8'`、`zope.interface`
    与 `zope-interface` 都被视为同一个包——任务级条目据此覆盖包内条目。
    解析不出来时返回整串，保证不同条目永远不会因为解析失败而被误判成同名。"""
    head = re.split(r'[<>=!~;\[\s@]', spec.strip(), maxsplit=1)[0].strip()
    if not head:
        return spec.strip()
    return re.sub(r'[-_.]+', '-', head).lower()


def merge_requirements(package_reqs: list[str], task_reqs: list[str]) -> list[str]:
    """D4：包内 requirements.txt ∪ 任务级 requirements，**任务级同名覆盖**。

    规则（AC-04a/b/c）：
      * 同名条目任务级胜出——uv 不会同时看到两个版本的约束；
      * 其余条目取并集，顺序稳定：先包内（保持文件顺序），再任务级的新增项；
      * 输入顺序即输出顺序，同一输入永远产出同一结果（可重复执行）。

    与 `manifest.merge_task_with_manifest` 的 `dict.fromkeys` 先例同源：字典
    保序去重，只是这里多了一层"按包名覆盖"的语义。
    """
    merged: dict[str, str] = {}
    for spec in package_reqs or []:
        if isinstance(spec, str) and spec.strip():
            merged[_requirement_key(spec)] = spec.strip()
    # 任务级后写入 = 同名覆盖（dict 保序：覆盖不改动首次插入的位置，
    # 于是"包内顺序优先、任务级新增项追加"的稳定性自然成立）。
    for spec in task_reqs or []:
        if isinstance(spec, str) and spec.strip():
            merged[_requirement_key(spec)] = spec.strip()
    return list(merged.values())


def _interpreter_failure_result(
    runtime_version: str,
    exc: BaseException,
    pool: dict,
    started_at: float,
    execution_id: str,
) -> dict:
    """解释器获取失败的统一失败结果（AC-12a 的消息模板 + 结构化留痕）。

    消息模板包含三件事，缺一件运维就得来回猜：请求的版本、失败原因、
    以及**候选执行器/已缓存版本**（"该派到哪台机器上"是调度侧的直接输入）。

    `result.interpreter` **不**放在回调载荷顶层：admin 的 CallbackItemDto 有
    白名单，未知顶层键会被静默剥离（不是 400，是"结果悄悄丢了"）；`result`
    是载荷里唯一被 admin 接受的结构化通道（task.service 把它并入执行记录）。
    """
    logger.error('Interpreter %s unavailable for %s: %s', runtime_version, execution_id, exc)
    return {
        'success': False,
        'logs': '',
        'exitCode': None,
        'errorMessage': _truncate_error_message(
            f'解释器 {runtime_version} 无法获取（缓存缺失 + 下载失败：'
            f'{_decode_interpreter_failure(exc)}）；候选执行器: '
            f'{settings.app_name}[已缓存: {", ".join(pool["versions"]) or "无"}]'
        ),
        'durationMs': int((time.monotonic() - started_at) * 1000),
        'result': {
            'interpreter': {
                'requested': runtime_version,
                'resolved': None,
                'reason': str(getattr(exc, 'reason', '') or 'unavailable'),
                'detail': str(getattr(exc, 'detail', '') or str(exc)),
                'pool': pool,
            }
        },
    }


def _host_is_restricted(host: str) -> bool:
    """主机名是否指向 loopback / 私网 / link-local / 未指定地址。

    镜像 executor-node `lib/ssrf-guard.ts` 的强度，并补上 python 侧更严格的
    一点：**真实 DNS 解析**。node 侧只做字符串判定（其注释已声明 DNS-rebinding
    不在范围内）；执行器侧的 packageUrl 来自 admin，解析一次成本可忽略，而
    字符串判定拦不住 `http://internal.corp/` 这种解析到 10.x 的名字。
    """
    name = (host or '').strip().strip('[]').lower()
    if not name:
        return True
    if name == 'localhost' or name.endswith('.localhost') or name == 'localhost.localdomain':
        return True

    def _restricted_ip(ip: ipaddress._BaseAddress) -> bool:  # type: ignore[attr-defined]
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        # `not ip.is_global` 是**兜底**：CGNAT（100.64.0.0/10）在 Python 3.12 的
        # ipaddress 里既不是 private 也不是 reserved（实测），但显然不该允许
        # 执行器去打。node 侧 ssrf-guard 显式列了 100.64/10，这里用"非全球可路由"
        # 一并覆盖，语义等价且不会随 stdlib 分类表漂移。
        # multicast 单列：224.0.0.1 的 is_global 为 True，不兜底拦不住。
        return bool(
            ip.is_loopback or ip.is_private or ip.is_link_local
            or ip.is_unspecified or ip.is_multicast or ip.is_reserved
            or not ip.is_global
        )

    try:
        return _restricted_ip(ipaddress.ip_address(name))
    except ValueError:
        pass  # 不是 IP 字面量 → 按主机名解析

    try:
        infos = socket.getaddrinfo(name, None)
    except (socket.gaierror, OSError, UnicodeError) as exc:
        logger.warning('SSRF guard: cannot resolve packageUrl host %r: %s', name, exc)
        return True  # fail-closed：解析不出来一律拒绝
    if not infos:
        return True
    for info in infos:
        sockaddr = info[4] if len(info) > 4 else None
        if not sockaddr:
            return True
        try:
            if _restricted_ip(ipaddress.ip_address(sockaddr[0])):
                return True
        except ValueError:
            return True
    return False


def _assert_safe_package_url(url: str) -> str:
    """packageUrl 的 SSRF 闸（fail-closed），返回规范化后的 URL。

    `allow_private_network` 语义与同文件 gitRepo 守卫**逐条对齐**（SEC-NEW-2
    ADR）：
      * 默认 False —— 私网/loopback/link-local 一律拒绝；
      * True —— 放行 RFC1918 私网（内网自建文件服务是文档化拓扑）；
      * loopback **不随开关放行**（git-face 同款裁定：执行器打自己的回环没有
        合法拓扑，只保留绕过成本）。
    """
    if not isinstance(url, str) or not url.strip():
        raise HTTPException(status_code=400, detail='packageUrl is required for application_zip tasks')
    candidate = url.strip()
    try:
        parsed = urlsplit(candidate)
        hostname = parsed.hostname
        # 访问 .port 顺带拒绝畸形端口（与 config.validate_pypi_registry_url 同法）。
        parsed.port
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f'Invalid packageUrl: {url}') from exc
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or not hostname:
        raise HTTPException(
            status_code=400,
            detail=f'packageUrl scheme not allowed (http/https only): {url}',
        )
    if parsed.username is not None or parsed.password is not None:
        # 凭据不进 argv/日志/URL 记录，且 admin 侧生成的 packageUrl 从不带凭据。
        raise HTTPException(
            status_code=400,
            detail='packageUrl must not contain userinfo credentials',
        )

    allow_private = bool(getattr(settings, 'allow_private_network', False))
    if _host_is_restricted(hostname):
        loopback_only = _host_is_loopback(hostname)
        if not (allow_private and not loopback_only):
            raise HTTPException(
                status_code=400,
                detail=f'packageUrl targets a restricted network address: {hostname}',
            )
    return candidate


def _host_is_loopback(host: str) -> bool:
    """loopback 单独判定——`allow_private_network` 开关不覆盖它（见上）。"""
    name = (host or '').strip().strip('[]').lower()
    if name == 'localhost' or name.endswith('.localhost') or name == 'localhost.localdomain':
        return True
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        try:
            infos = socket.getaddrinfo(name, None)
        except (socket.gaierror, OSError, UnicodeError):
            return False  # 已由 _host_is_restricted 的 fail-closed 分支拒绝
        return any(
            ipaddress.ip_address(info[4][0]).is_loopback
            for info in infos if len(info) > 4 and info[4]
        )
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return bool(ip.is_loopback)


def _package_download_headers(url: str) -> dict[str, str]:
    """下载 packageUrl 的请求头：**仅**在目标为 admin-api 时带 Bearer。

    镜像 executor-node `lib/download.ts`：首跳带执行器共享令牌（packageUrl 由
    admin 下发，指向 admin 本机的 /uploads/packages/），跨主机/第三方 CDN 一律
    不带——令牌绝不泄漏给非 admin 目标。
    """
    from admin_api import get_admin_api_base_url

    admin_base = (get_admin_api_base_url() or '').strip()
    token = _get_callback_token()
    if not admin_base or not token:
        return {}
    try:
        if urlsplit(url).netloc != urlsplit(admin_base).netloc:
            return {}
    except ValueError:
        return {}
    return {'Authorization': f'Bearer {token}'}


async def _download_package(url: str, dest: Path) -> int:
    """流式下载 packageUrl 到 `dest`（工作目录内的临时文件）。

    NFR-04/NFR-09：SSRF 闸已在调用前过；这里负责 200MB 硬上限（边下边计数，
    超限立即中止并删除半成品）、整体超时预算，以及错误消息里**只出现状态码**、
    绝不回显 URL 上的任何凭据。
    """
    headers = _package_download_headers(url)
    received = 0
    try:
        async with httpx.AsyncClient(
            timeout=ZIP_DOWNLOAD_TIMEOUT_SECONDS,
            follow_redirects=False,
            trust_env=False,
        ) as client:
            async with client.stream('GET', url, headers=headers or None) as response:
                if response.status_code != 200:
                    raise RuntimeError(
                        f'package download failed with HTTP {response.status_code}'
                    )
                with open(dest, 'wb') as handle:
                    async for chunk in response.aiter_bytes():
                        received += len(chunk)
                        if received > ZIP_DOWNLOAD_MAX_BYTES:
                            raise RuntimeError(
                                f'package exceeds the {ZIP_DOWNLOAD_MAX_BYTES} byte limit'
                            )
                        handle.write(chunk)
    except (httpx.HTTPError, OSError, asyncio.TimeoutError) as exc:
        _remove_quietly(dest)
        raise RuntimeError(f'package download failed: {type(exc).__name__}') from exc
    except Exception:
        _remove_quietly(dest)
        raise
    return received


def _remove_quietly(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


def _extract_package(zip_path: Path, work_dir: Path) -> None:
    """`vet_zip` + `safe_extract`（AC-03a）。WS3 模块缺席时**明确失败**。

    绝不退化成 `zipfile.extractall` 之类的兜底——那正是 zip-slip 的入口。
    """
    if _zip_safety is None:  # pragma: no cover - 仅并行开发期可达
        raise RuntimeError(
            'zip package channel unavailable: zip_safety module is not installed on this executor'
        )
    try:
        _zip_safety.vet_zip(zip_path)
        _zip_safety.safe_extract(zip_path, work_dir)
    except Exception as exc:
        violation = getattr(exc, 'violation', None)
        if violation:
            raise RuntimeError(
                f'zip package rejected by safety check ({violation}): {exc}'
            ) from exc
        raise


def _decode_interpreter_failure(exc: BaseException) -> str:
    """把解释器获取失败翻译成 AC-12a 模板的中文消息。

    `InterpreterUnavailable` 携带 .reason/.detail；其它异常退回异常文本。"""
    reason = getattr(exc, 'reason', None)
    detail = getattr(exc, 'detail', None)
    if reason or detail:
        return '：'.join(str(p) for p in (reason, detail) if p)
    return str(exc)


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
    name (and a manifest-only id desynchronised the two entirely).

    FR-16/D6（python_task_multiversion）：键追加版本签名，`<id>` → `<id>-3.7`。
    **只有这一处**做版本派生——目录名、锁键、TTL live 快照三方同源，否则
    版本切换会退化成"锁住 A、写 B、清扫 C"的漂移（DESIGN §1.2.2 的纪律）。

    兼容红线 §4.1/AC-10a：无声明版本（缺省/None/空串）时**逐字节返回旧值**；
    非法格式（非 `^\\d+\\.\\d+$`，如 "3"、"3.7.9"、"../x"）也一律不加后缀——
    校验在 run_task 里显式拒绝，绝不让任务提供的字符串以任何形式进入路径。
    """
    task = req.task if isinstance(req.task, dict) else {}
    key = str(task.get('id') or req.executionId)
    # VENY-KEY-ALIAS（本轮审计）：snake_case 别名必须与 run_task 的
    # `runtimeVersion ?? runtime_version` 同读（executor-node 的
    # `venvDirName(taskId, declaredVersion)` 同样吃两个别名）。
    #
    # 失败模式（改动前）：只读驼峰。同一条 `{"runtime_version":"3.11"}` 在
    # node 上把 venv 写到 `.venvs/<id>-3.11`、在这里写到 `.venvs/<id>`——
    # 而 run_task 仍会按 3.11 解析解释器并建 venv。于是「声明了 3.11 的 venv」
    # 落在**无版本后缀**的目录里，后续一个**不声明版本**的同任务会命中并复用
    # 它（`_venv_reuse_problem` 只在声明版本时才校验版本），静默跑在 3.11 上
    # ——AC-15b/D14 明令禁止的那类静默降级，且两侧目录名对同一载荷不同。
    version = task.get('runtimeVersion')
    if version is None:
        version = task.get('runtime_version')
    if isinstance(version, str) and RUNTIME_VERSION_PATTERN.fullmatch(version.strip()):
        return f'{key}-{version.strip()}'
    return key


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


async def fail_prepare_stage_executions_on_shutdown() -> int:
    """1-2（audit-r4 parity, executor-node task-worker.ts TaskWorker.stop）：
    停机时对「已领取但从未 spawn 进程」的 prepare/排队阶段执行补发终态 failed
    回调，而不是丢给 admin 的 stale sweep 收敛（stale 修复会丢失真实的
    killed/分类语义，且让 admin 侧多挂一段 RUNNING 行）。

    与 Node 侧逐字段对齐：status=failed、errorMessage='Executor is shutting
    down before this execution started'、**不设** failureReason（admin 按
    errorMessage 推断，与 node 行为一致）。语义要点：

      * 只处理 proc is None 且未 push 过 killed 回调的条目——已 spawn 的由
        kill_running_task_processes + worker 正常收尾负责；
      * 标记 killed_callback_pushed=True：_run_and_callback 的 E4 守卫
        （2413 行附近）看到后直接 return，绝不双发回调；
      * 标记 cancelled=True：run_task 的 cancelled 检查点让后台流程静默退出，
        不会在停机期间继续 spawn；
      * 不触碰 running 计数：槽位归还仍归 _run_and_callback 的 finally
        （decrement_running 幂等语义不变）。

    返回成功推送的回调数。best-effort：网络失败只记日志（停机窗口有界）。"""
    with _live_lock:
        entries = [
            e for e in list(_live_executions.values())
            if e.proc is None and not e.killed_callback_pushed
        ]
        for e in entries:
            e.killed_callback_pushed = True
            e.cancelled = True
    if not entries:
        return 0
    try:
        token = await get_current_token() or _get_callback_token()
    except Exception as exc:  # pragma: no cover - token 链异常不阻断停机
        logger.warning('Shutdown prepare-stage callback: token resolution failed: %s', exc)
        token = None
    pushed = 0
    for entry in entries:
        payload = {
            'executionId': entry.execution_id,
            'status': 'failed',
            'errorMessage': 'Executor is shutting down before this execution started',
            'executorAddress': _executor_callback_address(),
        }
        if entry.traceparent:
            payload['traceparent'] = entry.traceparent
        try:
            ok = await _send_callback_with_retry(
                build_admin_api_url('/executions/callback'),
                payload,
                token,
            )
            if ok:
                pushed += 1
        except asyncio.CancelledError:
            # 停机窗口被取消：至少落盘，交给下个进程重放（与 QA8 同款守卫）。
            _persist_giving_up(payload, build_admin_api_url('/executions/callback'))
            raise
        except Exception as exc:  # noqa: BLE001 - best-effort
            logger.warning(
                'Shutdown prepare-stage callback failed for %s: %s',
                entry.execution_id, exc,
            )
    return pushed


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


class ExecutionRejected(Exception):
    """ARCH-32: 领取被拒（容量/重复领取）。HTTP 路由映射为 HTTPException；
    pull 循环映射为 failed 回调——两条入口共用同一领取核心（node
    acceptExecution 对齐），语义不漂移。"""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def accept_execution(
    req: ExecuteRequest,
    traceparent: Optional[str] = None,
    slot_pre_reserved: bool = False,
) -> dict:
    """领取核心：容量预检 + 重复领取守卫 + 登记 + 后台执行（原 POST /execute
    主体；ARCH-32 抽取供 pull 循环复用）。被拒抛 ExecutionRejected。

    E-01（P1）pull 容量竞态：slot_pre_reserved=True 表示调用方（pull 循环）
    已在发起长轮询之前经 scheduler.try_reserve_running_slot() 于同一 running
    计数账本原子预留了一个槽位——预留即正式占用：本函数在该模式下不再
    increment_running（重复计数会凭空吞掉一个槽位），完成路径
    _run_and_callback 的 decrement_running 归还的正是那一个预留槽位；同步拒
    绝路径（全部发生在计数之前）由调用方统一释放预留，这里同样不触碰计数。
    仅保留防御性复查：账本被异常推高到超过上限（竞态残余/外部计数污染）时
    仍以 429 拒绝，让 pull 循环走「释放预留 + 不回调 failed」的防御分支；
    正常路径预留后 running_count ≤ max，该检查必然通过。"""
    if slot_pre_reserved:
        # E-01 预留模式的防御性复查（不再是 add-then-check 的常规预检）。
        if sched.get_running_count() > settings.max_concurrent_tasks:
            raise ExecutionRejected(429, 'Executor is at capacity')
    elif sched.get_running_count() >= settings.max_concurrent_tasks:
        raise ExecutionRejected(429, 'Executor is at capacity')

    # P2：磁盘临界水位（对齐 node acceptExecution 的 diskUsagePercent 检查）。
    # 磁盘满时任何任务都会在写 workdir/log 阶段失败，提前拒绝新任务比让任务
    # 在准备阶段失败更诚实。计量失败返回 0（无压力），不误拒任务。
    if disk_usage_percent() >= DISK_CRITICAL_PERCENT:
        raise ExecutionRejected(
            503, 'Executor disk is critically full; new tasks are refused'
        )

    # A3-C：协议闸门——形状约束由 `packages/executor-protocol/protocol.json`
    # 生成（pydantic 侧），与 executor-node 同源。
    #
    # **位置是语义的一部分，必须在登记之前**：登记后任何 raise 都会让该
    # executionId 永久留在 live 表里——重复领取守卫从此永远拒绝它（admin 重试
    # 全部 400），心跳还会上报一个并不存在的执行。E-19 的手检此前正好落在这个
    # 位置上，一次畸形 requirements 就能毒死一个 executionId。
    try:
        # strict=True：pydantic 默认 lax 会把字符串 "300" 强转成 int，而 zod 与
        # JSON Schema 的 type:integer 都不强转。与 `routers/config.py` 的同名闸门
        # 同款理由（那里早已是 strict，本处此前漏了）——不加 strict 的话，同一份
        # 畸形载荷在 python 侧被静默洗白、在 node 侧 400，两端对**同一份契约**给出
        # 相反结论，而契约闸门的存在意义正是消除这种分歧。
        #
        # 注意 `task` 在外层 FastAPI 模型里是 `Dict[str, Any]`，值原样透传，故
        # 这里的 strict 是唯一能拦住 `task.timeoutSeconds: "300"` 的一层。
        ProtocolExecuteRequest.model_validate(req.model_dump(), strict=True)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = '.'.join(str(p) for p in first['loc']) or '(root)'
        raise ExecutionRejected(
            400, f'Invalid execute request: {where}: {first["msg"]}'
        )

    # E-19 (parity with executor-node execute.ts): requirements 类型守卫。上游
    # DTO 演进误传字符串会让 `_validate_requirements` 的 `for spec in requirements`
    # 逐字符当包名迭代（静默错装 7 个"包"）。同步 400 直接返回 admin，绝不把
    # "lodash" 拆成字符；缺省（None/absent）仍当空数组。
    # 协议闸门已覆盖「非 list」这一类，这里保留是为了给出比 schema 文案更具体
    # 的错误——真正重要的是它现在位于登记之前（见上方注释）。
    req_requirements = req.task.get('requirements', [])
    if req_requirements is not None and not isinstance(req_requirements, list):
        raise ExecutionRejected(400, 'requirements must be an array of package names')

    # E7: duplicate-accept guard (node execute.ts:339-342 parity) — a still
    # live (queued/prepare/running) executionId must never be accepted twice:
    # the second background task would double-count capacity and double-callback
    # the same execution (the 429→BullMQ retry chain can otherwise re-dispatch
    # an execution whose first attempt is merely slow, not lost).
    entry = register_live_execution(req.executionId)
    if entry is None:
        raise ExecutionRejected(
            400,
            f'Execution {req.executionId} is already active on this executor',
        )

    # OBS-01: 记录派发载荷的 W3C traceparent（HTTP 路由取请求头、pull 路径取
    # 载荷字段；缺省=无追踪），注入任务 env AUTOFLOW_TRACE_ID 并随回调回传关联。
    if traceparent:
        entry.traceparent = traceparent
        logger.info('Execution %s trace: %s', req.executionId,
                    traceparent.split('-')[1] if '-' in traceparent else 'malformed')

    if not slot_pre_reserved:
        # E-01: 预留模式下跳过——调用方已占位（预留即正式占用），再计数即
        # 双计；完成路径的 decrement_running 归还的就是那一个预留槽位。
        sched.increment_running()
    bg_task = asyncio.create_task(_run_and_callback(req, entry))
    _background_tasks.add(bg_task)
    bg_task.add_done_callback(_background_tasks.discard)
    return {
        'status': 'accepted',
        'executionId': req.executionId,
        'executorAddress': _executor_callback_address(),
    }


@router.post('/execute', dependencies=[Depends(verify_token)])
async def execute(req: ExecuteRequest, request: Request = None):
    tp = request.headers.get('traceparent') if request is not None else None
    try:
        return accept_execution(req, tp)
    except ExecutionRejected as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


async def reject_pulled_execution(execution_id: str, reason: str,
                                  traceparent: Optional[str] = None) -> None:
    """ARCH-32: pull 载荷领取被拒时补发 failed 回调——admin 侧不留僵尸
    RUNNING 行（既有 stale sweep 之前先收敛；fail-open 不抛出）。"""
    try:
        token = await get_current_token()
        await _send_callback_with_retry(
            build_admin_api_url('/executions/callback'),
            {
                'executionId': execution_id,
                'status': 'failed',
                # E-42（DEEP_REVIEW 0ef3bbe）：pull 领取被拒（容量竞态/429）的 failed
                # 回调旧版不发 failureReason，admin 侧靠 inferFailureReason 兜底。
                # 该场景既非 killed 也非某类 prepare 失败，枚举里最诚实的中性值是
                # 'unknown'（ExecutionFailureReason.UNKNOWN）；显式上报让 admin 端
                # 无需再猜，观测口径与 node 侧对齐。
                'failureReason': 'unknown',
                'errorMessage': f'Executor rejected pulled dispatch: {reason}',
                **({'traceparent': traceparent} if traceparent else {}),
            },
            token,
        )
        logger.warning('Pulled execution %s rejected: %s', execution_id, reason)
    except Exception as exc:  # pragma: no cover - best-effort 收敛
        logger.warning('Failed to send rejection callback for %s: %s',
                       execution_id, exc)


def _callback_retry_sleep_seconds(attempt: int, rng: Callable[[], float] = random.random) -> float:
    """E-44: 退避乘 (0.5 + rng) 抖动系数，避免多 executor 在同一 admin 窗口后
    同步重试（惊群）。范围对齐 node computeRetryBackoffMs 的 0.5~1.5。"""
    return CALLBACK_RETRY_BASE_DELAY_SECONDS * (2 ** (attempt - 1)) * (0.5 + rng())


async def _send_callback_with_retry(url: str, payload: dict, token: Optional[str]) -> bool:
    """Enqueue the terminal callback and flush the batch queue inline (O-20).

    Previously this POSTed ``json=[payload]`` per execution (one round-trip and
    one connection-pool open each). It now enqueues the payload and drains the
    queue in admin-acceptable batches (≤100/POST); the bounded retry + backoff
    and on-exhaustion persistence live in ``_send_callback_batch_with_retry`` /
    ``_flush_live_callbacks``. The synchronous "deliver-or-persist within this
    call" guarantee is preserved, so a transient admin outage still parks the
    payload on disk for the replay loop. The ``token`` arg is kept for signature
    compatibility; the flush re-signs with the token valid at send time (node
    admin-client parity).
    """
    enqueue_callback(payload)
    delivered = await _flush_live_callbacks()
    return bool(delivered)


# ---------------------------------------------------------------------------
# O-20 (parity with executor-node callback.ts pushCallback / processCallbacks):
# an in-memory terminal-callback batch queue.
#
# Previously every terminal result POSTed ``json=[payload]`` on its own — one
# HTTP round-trip (and one connection-pool open) per execution, so a burst of N
# finishing executions issued N callbacks. Node accumulates callbacks and the
# background thread flushes them in batches of up to 100 (admin hard-rejects
# batches larger than that). We mirror that shape:
#
#   - producers call ``enqueue_callback(payload)``; a later terminal result for
#     the same executionId supersedes an earlier queued one (the final state
#     wins — node pushCallback does the same map-lookup by executionId);
#   - ``_flush_live_callbacks()`` drains the queue in 100-item batches and posts
#     ``json=<items>`` with the SAME bounded retry + backoff as the single-item
#     path; a batch that exhausts its budget is persisted verbatim (the on-disk
#     replay already sends a ``payloads`` list as one batch), so terminal state
#     survives;
#   - the flush runs inline at the terminal-delivery point (the synchronous
#     "deliver-or-persist" guarantee the tests and the never-lose-a-terminal-
#     result semantics rely on), in the 1s retry loop, and once more at shutdown.
# ---------------------------------------------------------------------------
CALLBACK_LIVE_BATCH_SIZE = 100  # admin hard-rejects callback batches > 100
_live_callback_queue: list[dict] = []
_live_callback_lock = threading.Lock()


def enqueue_callback(payload: dict) -> None:
    """Enqueue a terminal callback for batched delivery (node pushCallback
    parity). De-dupes by executionId: a later terminal result for the same
    execution supersedes an earlier queued one."""
    execution_id = payload.get('executionId')
    with _live_callback_lock:
        if execution_id:
            for i, existing in enumerate(_live_callback_queue):
                if existing.get('executionId') == execution_id:
                    _live_callback_queue[i] = payload
                    return
        _live_callback_queue.append(payload)


def _drain_live_callback_queue(
        max_items: int = CALLBACK_LIVE_BATCH_SIZE) -> list[dict]:
    """Atomically pop up to ``max_items`` queued terminal callbacks."""
    with _live_callback_lock:
        if not _live_callback_queue:
            return []
        batch = _live_callback_queue[:max_items]
        del _live_callback_queue[:max_items]
        return batch


async def _send_callback_batch_with_retry(url: str, items: list[dict]) -> bool:
    """POST one batch (≤100) of terminal callbacks with the same bounded retry +
    backoff as the single-item path. Returns True only on 2xx. Terminal 4xx
    (not 401/408/429) is not retried — the whole batch is rejected by admin."""
    token = await get_current_token() or _get_callback_token()
    # node traceparentHeaderFor(requests): pick the first queued traceparent.
    traceparent = next(
        (it['traceparent'] for it in items if it.get('traceparent')), None)
    # B-2 parity: x-executor-address drives admin's per-executor rate limiting
    # (not per-egress-IP), so multi-executor NAT sharing never gets throttled.
    headers: dict = {}
    if traceparent:
        headers['traceparent'] = traceparent
    executor_address = _executor_callback_address()
    if executor_address:
        headers['x-executor-address'] = executor_address
    client = sched.get_http_client()  # O-24: shared per-loop pool
    last_error: Exception | None = None
    for attempt in range(1, CALLBACK_RETRY_ATTEMPTS + 1):
        try:
            response = await request_with_self_heal(
                client, 'post', url, token=token,
                headers=headers or None, json=items)
            if 200 <= response.status_code < 300:
                return True
            if (400 <= response.status_code < 500
                    and response.status_code not in (401, 408, 429)):
                logger.error('Callback batch rejected with HTTP %s (non-retryable); '
                             'giving up %d callback(s)', response.status_code, len(items))
                return False
            last_error = RuntimeError(
                f'callback batch failed with HTTP {response.status_code}')
            logger.warning('Callback batch attempt %d/%d failed: HTTP %s',
                           attempt, CALLBACK_RETRY_ATTEMPTS, response.status_code)
        except Exception as exc:
            last_error = exc
            logger.warning('Callback batch attempt %d/%d failed: %s',
                           attempt, CALLBACK_RETRY_ATTEMPTS, exc)
        if attempt < CALLBACK_RETRY_ATTEMPTS:
            await asyncio.sleep(_callback_retry_sleep_seconds(attempt))
    logger.error('Failed to send callback batch (%d item(s)) after %d attempts: %s',
                 len(items), CALLBACK_RETRY_ATTEMPTS, last_error)
    return False


async def _flush_live_callbacks() -> int:
    """Drain the in-memory queue into admin-acceptable batches (≤100/POST).
    Delivered batches are dropped; exhausted batches are persisted verbatim so
    the on-disk replay loop re-sends them. Returns the number of items
    delivered."""
    delivered = 0
    while True:
        batch = _drain_live_callback_queue()
        if not batch:
            break
        url = build_admin_api_url('/executions/callback')
        if await _send_callback_batch_with_retry(url, batch):
            delivered += len(batch)
        else:
            # E2 parity: park the whole batch on disk (replay sends it as one
            # `payloads` batch). Persistence must never crash the caller.
            try:
                _persist_failed_callback(batch, url)
            except Exception as exc:  # pragma: no cover - defensive
                logger.error('Failed to persist callback batch: %s', exc)
    return delivered


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

# E-05 (P2): replay rounds before dead-lettering. 轮数上限只防毒丸文件（永不可达
# 的回调被无限重发占满磁盘），真正的保护是"时长型预算"——下方指数退避（base 1s，
# cap 600s）配 150 轮上限，实算时长预算：
#   Σ_{k=0..149} min(1s·2^k, 600s) = 1023s + 140×600s = 85023s ≈ 23.6h
# 足以覆盖 admin 的滚动升级窗口（期间 admin 完全不可达、回调只能排队）。
# node 侧 base 5s/cap 600s/150 轮 ≈ 24.0h，两侧同量级。
CALLBACK_FILE_MAX_RETRIES = 150           # replay rounds before dead-lettering
CALLBACK_FILE_MAX_SIZE_BYTES = 64 * 1024 * 1024   # oversized payload guard
CALLBACK_RETRY_SWEEP_INTERVAL_SECONDS = 1.0
CALLBACK_DRAIN_TIMEOUT_SECONDS = 10.0    # node stopCallbackThread drain cap
# E2/E-05: per-file exponential backoff between replay rounds (base * 2**retries,
# capped at 600s). Base 1s matches node's fresh-failure cadence; later rounds
# back off instead of hammering a down admin-api every second. cap 60→600 (node
# parity) 覆盖 admin 滚动升级窗口；dead-letter 轮数上限只防毒丸文件，时长预算
# 约 24h 量级。
CALLBACK_REPLAY_BACKOFF_BASE_SECONDS = 1.0
CALLBACK_REPLAY_BACKOFF_MAX_SECONDS = 600.0
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


# ---------------------------------------------------------------------------
# A6（DEEP_REVIEW §七）：死信目录定期对账（executor-node callback.ts 同语义）
#
# 死信此前是单向终点：文件进去就再也出不来。但两类死信的处置完全相反——
#   ① 重发预算耗尽（E-05，约 24h）：典型成因是 admin 长时间不可达。admin 恢复
#      后该执行可能仍是 RUNNING（admin 的 stale sweep 要等执行器心跳超时才跑），
#      此时回调是 admin 唯一能得知结果、并释放执行器槽位的通道，重发有价值。
#   ② 毒丸（>64MB / 坏 JSON）：重发永远失败，只等人来看。
# 区分二者必须问 admin「这条执行终态了没有」——GET /executors/:address/
# terminal-states 就是这个问句。处置分三层：终态→删；未终态且非毒丸→重发；
# 未终态但毒丸或救回次数用尽→保留待人工。
#
# 三条设计约束（与 node 侧一致，改这里前先读 node 的同名块注释）：
#   - 零死信则零请求：健康执行器不产生额外流量。
#   - 取不到就什么都不做：绝不把「没拿到终态清单」误读成「都没终态」。
#   - 救回次数有上限，否则执行行被删时会无限往返。
# ---------------------------------------------------------------------------

# 侧车后缀与 executor-node 的 src/dead-letter-sidecar.ts 保持一致：两端写同一
# 份磁盘布局，运维拿同一套命令即可排查。
DEAD_LETTER_SIDECAR_SUFFIX = '.deadletter.json'
DEAD_LETTER_RECONCILE_INTERVAL_SECONDS = 600.0
DEAD_LETTER_MAX_REQUEUES = 3
DEAD_LETTER_SINCE_SKEW_SECONDS = 300.0
DEAD_LETTER_MAX_LOOKBACK_SECONDS = 30 * 24 * 3600.0
DEAD_LETTER_RECONCILE_LIMIT = 500
# 超过此大小的死信不解析：多半就是「超大载荷」死信本身，为拿一个 executionId
# 去 parse 几十 MB 不划算。留给人工。
_DEAD_LETTER_MAX_PARSE_BYTES = 8 * 1024 * 1024


def _read_dead_letter_meta(payload_path: Path) -> Optional[dict]:
    """读死信侧车。缺失/损坏返回 None（对账据此退化为保守处置）。"""
    try:
        raw = json.loads(
            payload_path.with_name(payload_path.name + DEAD_LETTER_SIDECAR_SUFFIX
                                   ).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    requeues = raw.get('requeues')
    return {
        'reason': raw.get('reason') if isinstance(raw.get('reason'), str) else 'unknown',
        'poison': raw.get('poison') is True,
        'deadLetteredAt': raw.get('deadLetteredAt') if isinstance(raw.get('deadLetteredAt'), (int, float)) else 0,
        'requeues': int(requeues) if isinstance(requeues, (int, float)) and requeues >= 0 else 0,
    }


def _write_dead_letter_meta(payload_path: Path, meta: dict) -> None:
    try:
        payload_path.with_name(payload_path.name + DEAD_LETTER_SIDECAR_SUFFIX).write_text(
            json.dumps(meta), encoding='utf-8')
    except OSError:
        pass  # 侧车写不进去只影响对账精度，不影响 payload 本身


def _remove_dead_letter_meta(payload_path: Path) -> None:
    try:
        payload_path.with_name(payload_path.name + DEAD_LETTER_SIDECAR_SUFFIX).unlink()
    except OSError:
        pass


def _refresh_dead_letter_count() -> None:
    """Recount dead-letter files and stamp the cache. QA9: this is the only
    cache maintenance point — every dead-letter move happens inside
    retry_persisted_callbacks, which ends with this refresh on each sweep
    (1s cadence), so a separate invalidate hook had no reachable call site
    and was removed.

    A6: **排除 `.deadletter.json` 侧车**。上报的是「积压了多少条没送出去的
    回调」，侧车不是回调——不排除的话这个运维指标会凭空翻倍，而翻倍恰恰会
    掩盖对账的真实效果（对账删 payload 时连带删侧车，指标本该降一半）。"""
    try:
        count = sum(1 for p in _dead_letter_dir().iterdir()
                    if p.is_file() and not p.name.endswith(DEAD_LETTER_SIDECAR_SUFFIX))
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


def _persist_failed_callback(payload, url: str) -> Optional[Path]:
    """Write an undeliverable callback payload to <workDir>/callbacks/.

    Node parity: the file holds ONLY the admin-acceptable payload batch (no
    Authorization header, no dynamic token) — replay re-signs at send time.
    ``payload`` is either a single callback dict or a list of them (O-20 batch:
    a whole 100-item batch that exhausted its retry budget is parked verbatim and
    replayed as one ``payloads`` list). Returns the payload file path, or None
    when persistence itself failed (nothing more can be done; the result was
    already logged)."""
    global _callback_persistence_sequence
    try:
        callback_dir = _callback_dir()
        with _persistence_sequence_lock:
            sequence = _callback_persistence_sequence
            _callback_persistence_sequence += 1
        filename = callback_dir / f'callback-{int(time.time() * 1000)}-{sequence}.json'
        tmp = filename.with_name(filename.name + '.tmp')
        payloads = payload if isinstance(payload, list) else [payload]
        tmp.write_text(json.dumps({'url': url, 'payloads': payloads}, ensure_ascii=False), encoding='utf-8')
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


def _write_retry_count(filepath: Path, retries: int,
                       dead_letter_requeues: Optional[int] = None) -> None:
    """Bump the .meta retry counter. ``updatedAt`` doubles as the
    last-attempt timestamp for the per-file replay backoff gate.

    A6: ``deadLetterRequeues`` 未显式给出时**保留原值**——对账重新入队只改
    retries，不能顺手把「已经被救过几次」抹掉（那样毒丸文件会无限往返）。"""
    try:
        if dead_letter_requeues is None:
            dead_letter_requeues = _read_retry_meta(filepath).get('deadLetterRequeues', 0)
        filepath.with_name(filepath.name + '.meta').write_text(
            json.dumps({'retries': retries,
                        'updatedAt': int(time.time() * 1000),
                        'deadLetterRequeues': dead_letter_requeues}), encoding='utf-8')
    except OSError as exc:
        logger.warning('Failed to update retry counter for %s: %s', filepath, exc)


def _read_retry_meta(filepath: Path) -> dict:
    """A6: 读 .meta 的原始 dict（retries / updatedAt / deadLetterRequeues）。
    缺失或损坏一律回落为空 dict——调用方已有各自的兜底。"""
    try:
        raw = json.loads(filepath.with_name(filepath.name + '.meta').read_text(encoding='utf-8'))
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


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


def _dead_letter_callback_file(filepath: Path, reason: str, poison: bool = False) -> None:
    """Move a permanently-failed callback file to dead-letter/ (node parity):
    the retry loop stops resending it, but the payload stays on disk for
    manual inspection/replay.

    A6: ``poison`` 标记载荷本身是否不可送达（超大 / 坏 JSON）——它决定对账
    能不能把文件救回重发队列（见 ``reconcile_dead_letter_files``）。同时在
    payload 旁写一个侧车，记下 reason / poison / 时间 / 已被救回次数。"""
    requeues = _read_retry_meta(filepath).get('deadLetterRequeues') or 0
    try:
        requeues = int(requeues)
    except (TypeError, ValueError):
        requeues = 0
    try:
        target = _dead_letter_dir() / filepath.name
        if target.exists():
            target.unlink()
        # requeues 由 live .meta 携带（重新入队时写入），跨「死信→重发→再死信」
        # 循环继承，救回次数才不会被无限重置。
        filepath.rename(target)
        _write_dead_letter_meta(target, {
            'reason': reason,
            'poison': bool(poison),
            'deadLetteredAt': int(time.time() * 1000),
            'requeues': requeues,
        })
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
    # O-24: shared per-loop pool (replay sends the whole persisted batch).
    response = await request_with_self_heal(
        sched.get_http_client(), 'post', url, token=token, json=requests)
    # CALLBACK-3XX：同 _send_callback_with_retry —— 只有 2xx 才算投递成功。
    # 旧判据「< 400」会把 3xx 当成功，调用方随即 unlink 持久化文件，
    # 载荷永久丢失（重定向目标并非 admin）。
    if 200 <= response.status_code < 300:
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
                _dead_letter_callback_file(filepath, f'{retries} failed retry rounds', False)
                continue
            if filepath.stat().st_size > CALLBACK_FILE_MAX_SIZE_BYTES:
                _dead_letter_callback_file(filepath, 'oversized payload', True)
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
                    _dead_letter_callback_file(filepath, f'{next_retries} failed retry rounds', False)
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
            _dead_letter_callback_file(filepath, 'corrupt payload', True)
        except OSError as exc:
            logger.warning('Failed to retry callback file %s: %s', filepath.name, exc)
    _refresh_dead_letter_count()
    return delivered


async def _fetch_terminal_states(address: str, since_ms: float) -> Optional[set]:
    """问 admin「这些执行终态了没有」。

    返回已终态的 executionId 集合；**拿不到（不可达 / 响应形状不对）返回
    None**——调用方据此整体放弃本轮，绝不退化成「空集合」（那等于说"都没
    终态"，会把毒丸文件一股脑推回重发队列）。"""
    from urllib.parse import quote, urlencode

    since_iso = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(since_ms / 1000))
    path = (f'/executors/{quote(address, safe="")}/terminal-states?'
            + urlencode({'since': since_iso, 'limit': DEAD_LETTER_RECONCILE_LIMIT}))
    token = await get_current_token() or _get_callback_token()
    # O-24: shared per-loop pool.
    response = await request_with_self_heal(
        sched.get_http_client(), 'get', build_admin_api_url(path), token=token)
    if response.status_code >= 400:
        logger.warning('Terminal-states reconciled failed: HTTP %s', response.status_code)
        return None
    from auth import _unwrap_envelope
    try:
        payload = _unwrap_envelope(response.json())
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    items = payload.get('items')
    if not isinstance(items, list):
        logger.warning('Terminal-states response has no items array — treating as unavailable')
        return None
    terminal = {it.get('executionId') for it in items
                if isinstance(it, dict) and isinstance(it.get('executionId'), str)}
    if payload.get('hasMore') is True:
        logger.warning('Terminal-states page is partial (%d items, hasMore=true); '
                       'remaining dead-letter files handled next round', len(terminal))
    return terminal


async def reconcile_dead_letter_files() -> dict:
    """对账一轮死信目录。返回处置计数（与 node reconcileDeadLetters 同形）。

    见上方块注释的三条设计约束。零死信时一个请求都不发。"""
    result = {'scanned': 0, 'deleted': 0, 'requeued': 0, 'kept': 0,
              'orphans': 0, 'skipped': 0, 'fetched': -1, 'hasMore': False}
    dead_dir = Path(settings.work_dir) / 'callbacks' / 'dead-letter'
    try:
        entries = list(dead_dir.iterdir())
    except OSError:
        return result  # 目录不存在 = 零死信（刻意不 mkdir：只读动作不造目录）

    payloads = [p for p in entries
                if p.is_file() and p.name.startswith('callback-')
                and p.name.endswith('.json')
                and not p.name.endswith(DEAD_LETTER_SIDECAR_SUFFIX)]
    payload_names = {p.name for p in payloads}

    # 孤儿侧车：payload 已被 TTL 清理（maintenance 的 sweep 不认识侧车）。
    for entry in entries:
        if not entry.name.endswith(DEAD_LETTER_SIDECAR_SUFFIX):
            continue
        owner = entry.name[:-len(DEAD_LETTER_SIDECAR_SUFFIX)]
        if owner in payload_names:
            continue
        try:
            entry.unlink()
            result['orphans'] += 1
        except OSError:
            pass
    if not payloads:
        return result  # 健康路径：零死信 → 零请求

    items = []
    oldest_ms = time.time() * 1000
    for payload in payloads:
        try:
            stat = payload.stat()
        except OSError:
            continue
        meta = _read_dead_letter_meta(payload)
        result['scanned'] += 1
        # 侧车缺失（老版本留下的死信）时用文件 mtime 当水印起点。
        oldest_ms = min(oldest_ms, (meta or {}).get('deadLetteredAt') or stat.st_mtime * 1000)
        if stat.st_size > _DEAD_LETTER_MAX_PARSE_BYTES:
            result['skipped'] += 1
            continue
        try:
            data = json.loads(payload.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            result['skipped'] += 1
            continue
        if isinstance(data, dict):
            data = data.get('payloads')
        if not isinstance(data, list):
            result['skipped'] += 1
            continue
        ids = [row.get('executionId') for row in data
               if isinstance(row, dict) and isinstance(row.get('executionId'), str)]
        if not ids:
            result['skipped'] += 1
            continue
        items.append({'path': payload, 'ids': ids,
                      'poison': bool((meta or {}).get('poison')),
                      'requeues': int((meta or {}).get('requeues') or 0)})
    if not items:
        return result

    since_ms = max(oldest_ms - DEAD_LETTER_SINCE_SKEW_SECONDS * 1000,
                   time.time() * 1000 - DEAD_LETTER_MAX_LOOKBACK_SECONDS * 1000)
    address = settings.executor_address_public or settings.executor_address
    try:
        terminal = await _fetch_terminal_states(address, since_ms)
    except Exception as exc:  # 对账失败绝不能影响重发主循环
        logger.warning('Dead-letter reconciliation failed: %s', exc)
        return result
    if terminal is None:
        logger.warning('Dead-letter reconciliation skipped: terminal states unavailable; '
                       'dead-letter files left untouched')
        return result
    result['fetched'] = len(terminal)

    for item in items:
        path = item['path']
        if all(execution_id in terminal for execution_id in item['ids']):
            # admin 早有终态 —— 再发一次也只会被幂等丢弃。
            try:
                path.unlink()
                _remove_dead_letter_meta(path)
                result['deleted'] += 1
                logger.info('Dead-letter %s dropped: admin already recorded a terminal state',
                            path.name)
            except OSError as exc:
                result['skipped'] += 1
                logger.warning('Failed to drop reconciled dead-letter %s: %s', path.name, exc)
            continue

        if not item['poison'] and item['requeues'] < DEAD_LETTER_MAX_REQUEUES:
            # admin 仍未终态：回调是它唯一的结果通道，救回重发队列。
            try:
                live = _callback_dir() / path.name
                path.rename(live)
                _remove_dead_letter_meta(path)
                _write_retry_count(live, 0, item['requeues'] + 1)
                result['requeued'] += 1
                logger.warning('Dead-letter %s re-queued for retry (attempt %d/%d): '
                               'admin has no terminal state yet',
                               path.name, item['requeues'] + 1, DEAD_LETTER_MAX_REQUEUES)
            except OSError as exc:
                result['skipped'] += 1
                logger.warning('Failed to re-queue dead-letter %s: %s', path.name, exc)
            continue

        result['kept'] += 1
    _refresh_dead_letter_count()
    return result


_dead_letter_reconcile_state = {'last': 0.0, 'in_flight': False,
                                'interval': DEAD_LETTER_RECONCILE_INTERVAL_SECONDS}


def set_dead_letter_reconcile_interval(seconds: float) -> None:
    """测试用：把对账周期注入为 0 以强制每轮都对账。"""
    _dead_letter_reconcile_state['interval'] = seconds


async def _maybe_reconcile_dead_letters() -> None:
    """A6: 死信对账的节流入口（低频、只读、失败无副作用）。停机排空期间不跑——
    那时不该再发起新的 admin 请求。"""
    state = _dead_letter_reconcile_state
    if _callback_retry_stop.is_set() or state['in_flight']:
        return
    if time.monotonic() - state['last'] < state['interval']:
        return
    state['in_flight'] = True
    state['last'] = time.monotonic()
    try:
        await reconcile_dead_letter_files()
    except Exception as exc:  # 对账失败绝不能影响重发主循环
        logger.warning('Dead-letter reconciliation error: %s', exc)
    finally:
        state['in_flight'] = False


async def callback_retry_task() -> None:
    """Background re-send loop (node processCallbacks parity): replays
    persisted callbacks every CALLBACK_RETRY_SWEEP_INTERVAL_SECONDS until
    stopped. The stop flag is polled between sweeps (and checked per file),
    so the shutdown drain only ever waits for one in-flight replay."""
    logger.info('Starting callback retry task')
    try:
        while not _callback_retry_stop.is_set():
            try:
                # O-20: drain the in-memory batch queue (kill-path + any
                # fire-and-forget producer) before replaying on-disk files.
                await _flush_live_callbacks()
                await retry_persisted_callbacks()
                # A6: 死信对账（默认 10min 一次；零死信时零请求）
                await _maybe_reconcile_dead_letters()
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
    # O-20: one last best-effort flush of the in-memory batch queue before exit
    # (node stopCallbackThread drain parity). Anything still undelivered is
    # persisted to disk by _flush_live_callbacks so the next process replays it.
    try:
        await asyncio.wait_for(_flush_live_callbacks(),
                               timeout=CALLBACK_DRAIN_TIMEOUT_SECONDS)
    except (asyncio.TimeoutError, Exception):
        pass
    # O-24: close the shared per-loop HTTP clients.
    try:
        await sched.aclose_http_clients()
    except Exception:
        pass


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
    # O-20: enqueue into the batch queue and flush inline — the kill endpoint
    # (and its tests) expect the terminal result delivered-or-persisted here.
    enqueue_callback(payload)
    await _flush_live_callbacks()


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
        return JSONResponse(status_code=404, content=_kill_body(False))

    entry.killed_by_request = True
    entry.cancelled = True

    proc = entry.proc
    if proc is not None:
        # 已 spawn：终止整个进程树（复用 _kill_process_tree）。子进程死亡后
        # run_task 自然走失败返回，_run_and_callback 据 killed_by_request 推送
        # failureReason=killed 的终态回调并摘除注册表条目——与 node 的
        # "close 事件走 runTask 失败路径" 一致，这里不重复推送。
        await _kill_process_tree(proc)
        return _kill_body(True)

    # 排队/prepare（尚未 spawn）：立刻收尾——推送一次 killed 回调（后台任务，
    # 不阻塞 admin 的 3s 超时）并摘除注册表；run_task 的 cancelled 检查点会让
    # 后台流程静默退出，绝不双发回调、绝不双释放容量（decrement 仍归
    # _run_and_callback 的 finally 所有）。
    if not entry.killed_callback_pushed:
        entry.killed_callback_pushed = True
        _spawn_background(_push_killed_callback(executionId))
    unregister_live_execution(executionId)
    return _kill_body(True)


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
                # FR-12/AC-12a（python_task_multiversion）：解释器失败的结构化
                # 留痕。只有任务侧真的产出了 result（解释器获取失败）才挂上——
                # 既有路径没有 result 键，payload 形状对存量任务零变化。
                if isinstance(result.get('result'), dict):
                    payload['result'] = result['result']
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
                # O-20: the terminal payload goes through the batch queue
                # (enqueue + inline flush, delivered-or-persisted within this
                # call). _send_callback_with_retry is still the call site —
                # it now enqueues into the queue and flushes the batch inline,
                # preserving the synchronous terminal-delivery guarantee.
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


async def _run_uv(args: list[str], timeout_seconds: float, *, env: dict[str, str] | None = None) -> tuple[int | None, str]:
    """Run a uv subprocess with combined output captured.

    R4-C P2: plain `asyncio.wait_for(proc.communicate(), ...)` leaves the uv
    process running as an orphan when it times out — kill it explicitly first.
    """
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
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


def _venv_python_bin(venv_dir: Path) -> Path:
    """venv 内解释器路径（平台相关布局，W-02 follow-up 的单一来源）。"""
    if sys.platform == 'win32':
        return venv_dir / 'Scripts' / 'python.exe'
    return venv_dir / 'bin' / 'python'


def _read_pyvenv_cfg(venv_dir: Path) -> dict[str, str] | None:
    """读 `<venv>/pyvenv.cfg` 为 key→value 字典；缺失/损坏返回 None。

    `maintenance._read_pyvenv_cfg` 是同一实现的副本（那边用它做"这个解释器
    还有没有 venv 依赖"的引用扫描）。刻意不共享：maintenance 明确避免 import
    routers.execute（模块级注释说明了那个依赖方向会成环）。格式是 CPython
    冻结的 `key = value` 文本，两份实现都不该有演化空间。
    """
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


def _venv_reuse_problem(venv_dir: Path, python_bin: Path,
                        python_version: str | None) -> str | None:
    """venv 目录存在但**不可用**时返回原因；健康则返回 None（可复用）。

    为什么需要这一步（lead 实测确认的生产事故类缺陷）：`uv venv` 建出的环境里，
    `bin/python` / `Scripts/python.exe` 只是约 600KB 的 shim，真正的解释器仍在
    缓存池里，依赖记在 `pyvenv.cfg` 的 `home = <UV_PYTHON_INSTALL_DIR>/cpython-…`。
    池里那个目录一旦被回收/换卷/清空，venv 当场报废（实测重跑：
    `No Python at '...'`，exit 103）。而 `venv_dir.exists()` 依旧为真，于是旧逻辑
    会"复用"一个死 venv，任务在 exec 阶段以一个令人费解的退出码失败——既不是
    干净的 interpreter_unavailable，也把 D14（不回退宿主）的语义搅浑。

    纯文件系统判定，**不 spawn 任何进程**（准备阶段的每一毫秒都在任务超时预算
    里）。任何读取/解析异常都按"不可用"处理——宁可多重建一次 venv，也不复用
    一个可能已死的环境。
    """
    if not python_bin.exists():
        return f'the venv python executable is missing ({python_bin})'
    cfg = _read_pyvenv_cfg(venv_dir)
    if cfg is None:
        return 'pyvenv.cfg is missing or unreadable'
    home = cfg.get('home')
    if not home:
        return 'pyvenv.cfg has no "home" entry (cannot tell which interpreter backs it)'
    if not Path(home).exists():
        return f'the interpreter it was built from no longer exists ({home})'
    if python_version is not None:
        # 版本不匹配 = 目录键撞车或 venv 是别的版本建的：必须重建，否则
        # AC-15b（不受 PATH 影响、必须用声明版本）被静默违反。
        recorded = cfg.get('version_info') or Path(home).name
        if not _version_matches(recorded, python_version):
            return (
                f'it was built for Python {recorded!r} but the task declares {python_version!r}'
            )
    return None


def _version_matches(recorded: str, requested: str) -> bool:
    """`recorded` 是否为 `requested` 的补丁版本（3.12.11 属于 3.12）。

    取首个 `X.Y[.Z]` 形状的 token 比对主.次；解析不出来时保守判定为**不匹配**
    （触发一次重建，代价只是重装依赖，远小于用错版本跑任务）。"""
    match = re.search(r'(\d+)\.(\d+)', recorded or '')
    if not match:
        return False
    return f'{match.group(1)}.{match.group(2)}' == requested


async def ensure_venv(
    venv_dir: Path,
    requirements: list[str],
    *,
    python_version: str | None = None,
) -> Path:
    """Create/reuse a virtual environment with uv and install dependencies. Returns python executable path.

    FR-15/AC-15a/b（python_task_multiversion）：新增 **keyword-only**
    `python_version`。

      * `None` → argv 与改造前**逐字节一致**：`uv venv --no-project <dir>`
        （兼容红线 §4.1 / AC-10a：存量任务的 venv 创建行为零变化）。
      * 非空 → 先经 `interpreters.ensure_version()` 拿到**池内绝对路径**，再
        `uv venv --python <abs_path> --no-project <dir>`。

    D8 硬约束：**venv 阶段绝不触发下载**。两道保障——
      1. 传给 uv 的是解析后的绝对路径，不是裸版本号（裸版本号会触发 uv 的
         "缺则自动下载"语义）；
      2. uv 环境带 `UV_PYTHON_DOWNLOADS=manual`（`_build_uv_env`），缺版本时
         uv 直接拒绝而不是偷偷下载，绕过 D13 全局单下载队列成为不可能。
    下载只发生在 `ensure_version()` 这个受控入口里（独立超时预算 + per-version
    锁 + 全局单下载队列）。

    复用前会校验 venv 是否**仍然可用**（`_venv_reuse_problem`）：健康的 venv
    照旧直接复用（AC-16b 的性能语义不变，不产生任何 uv 调用），损坏的（解释器
    被回收、pyvenv.cfg 损坏、版本不符）**删除后重建**而不是带着它往下跑。
    """
    # Validate before spawning even the venv phase. This keeps malformed or
    # credential-bearing registry configuration out of every uv subprocess.
    registry_url = _validate_registry_url(settings.pypi_registry_url)
    install_env = _build_uv_env(venv_dir.parent / '.uv-cache')
    # W-02 follow-up (windows-findings): venv layout is platform-specific —
    # win32 uses Scripts\python.exe, POSIX uses bin/python. The old hardcoded
    # bin/python made every requirements-bearing task fail on Windows.
    python_bin = _venv_python_bin(venv_dir)

    # NFR-03 纵深防御：版本号要进 uv argv 与 `.venvs/<key>` 路径，先过白名单正则。
    # 正常链路里 admin DTO 已校验（FR-06b），这里是执行器侧的最后一道——
    # 一个畸形值（"3.7.9"、"../x"、"--index-url"）在这里就终止，绝不进 argv。
    if python_version is not None and not RUNTIME_VERSION_PATTERN.fullmatch(str(python_version)):
        raise RuntimeError(f'Invalid runtimeVersion (expected X.Y): {python_version!r}')

    if venv_dir.exists():
        problem = _venv_reuse_problem(venv_dir, python_bin, python_version)
        if problem:
            # 重建是安全的：venv 里只有依赖安装结果，requirements 会重新装回来。
            logger.warning(
                'Discarding the cached venv %s and rebuilding it: %s', venv_dir, problem,
            )
            shutil.rmtree(venv_dir, ignore_errors=True)

    if not venv_dir.exists():
        venv_args = [UV_BIN, 'venv']
        if python_version is not None:
            # 已缓存的 venv 直接复用，不需要解释器池参与（AC-16b：同版本复用，
            # 不重复探测/下载）；只有真要新建 venv 时才解析解释器。
            pool_python = await _ensure_interpreter(
                str(python_version), timeout=_interpreter_download_timeout()
            )
            venv_args.extend(['--python', str(pool_python)])
            # NETOPT-6②：`uv venv` 进行中该池目录还没有任何 venv 的 pyvenv.cfg
            # home 指向它（venv 依赖扫描覆盖不了这个窗口），先登记防并发 LRU
            # 回收；venv 建成后由 pyvenv.cfg home 接管，失败清理后自然解除。
            _register_live_pool_interpreter(str(pool_python))
        # 兼容红线 §4.1：无版本分支的剩余 argv 与改造前逐字节相同。
        venv_args.extend(['--no-project', str(venv_dir)])
        logger.info(f'Creating venv with uv: {venv_dir}')
        try:
            try:
                code, out = await _run_uv(venv_args, UV_VENV_TIMEOUT_SECONDS, env=install_env)
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
        finally:
            # NETOPT-6②：成功 → pyvenv.cfg home 已指向池目录（依赖扫描接管）；
            # 失败 → venv 已删/未建成，无依赖者。两条路径都可解除登记。
            # 条件短路保证 python_version 为 None（pool_python 未绑定）时不求值。
            _unregister_live_pool_interpreter(
                str(pool_python) if python_version is not None else None
            )

    if requirements:
        _validate_requirements(requirements)
        logger.info(f'Installing {len(requirements)} packages into {venv_dir}')
        install_args = [
            UV_BIN, 'pip', 'install',
            '--python', str(python_bin),
        ]
        # Use the explicitly configured credential-free private PyPI index.
        # Validate again here because tests/config reloads may mutate settings
        # after startup; never put a credential-bearing URL into uv argv.
        if registry_url:
            install_args.extend(['--index-url', registry_url])
        install_args.extend(requirements)
        code, out = await _run_uv(install_args, UV_PIP_TIMEOUT_SECONDS, env=install_env)
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

        # B-2（SEC-NEW）：gitRepo 拒绝 URL 内嵌凭据（与 admin 侧
        # assertSafeGitRepoUrl 同款规则，双侧对齐）。泄漏面：git clone 失败时
        # stderr 回显完整 URL → errMsg → 日志/回调/审计。
        #   * http(s):// 一律拒绝 userinfo（https://user:pass@host）——http(s)
        #     克隆的凭据只能走 GIT_ASKPASS / credential helper；
        #   * ssh:// 拒绝 password（ssh://user:pass@host）；裸用户名
        #     （ssh://git@host/...）是文档化 SSH 形态，放行；
        #   * scp-like（git@host:path）结构上不可能携带密码，放行。
        try:
            _git_url = urlsplit(git_repo)
            _git_url.port  # 畸形端口一并拒绝（与 packageUrl 守卫同法）
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f'Invalid gitRepo URL: {git_repo}') from exc
        if _git_url.scheme in ('http', 'https') and (
            _git_url.username is not None or _git_url.password is not None
        ):
            raise HTTPException(
                status_code=400,
                detail='gitRepo must not contain embedded credentials (userinfo); '
                       'use GIT_ASKPASS / a credential helper instead',
            )
        if _git_url.scheme == 'ssh' and _git_url.password is not None:
            raise HTTPException(
                status_code=400,
                detail='gitRepo must not contain an embedded password; '
                       'use an SSH key / GIT_ASKPASS instead',
            )

        # S7 (SEC-NEW-2): SSRF guard — block private IP addresses and localhost.
        #
        # ADR — EXECUTOR_ALLOW_PRIVATE_NETWORK 开关（镜像 admin-api 侧
        # safe-http.util.ts 的同名变量）：
        #   * 默认 False = 既有姿态零变化：RFC1918 私网（10/8、172.16/12、
        #     192.168/16）、loopback（localhost、127.0.0.0/8）一律拒绝。
        #   * True 时放行 RFC1918 私网——内网自建 GitLab/Gitea 是文档化
        #     拓扑（executor 与 git 服务同内网），与 admin-api 侧
        #     assertSafeExecutorUrl 的 private-lan 语义对齐。scheme 白名单
        #     与下方其余校验（git ref 注入守卫）不受开关影响。
        #   * loopback 裁定：**不随开关放行**。admin-api 侧的 git 守卫
        #     assertSafeGitRepoUrl 对 loopback（127.0.0.0/8、::1）无条件
        #     拒绝、不受 EXECUTOR_ALLOW_PRIVATE_NETWORK 影响（该开关只门控
        #     assertSafeExecutorUrl 的 executor 地址 face；git face 始终
        #     deny loopback/link-local/restricted）。本守卫镜像该 git-face
        #     语义：即便开关开启，localhost/127.x 仍被拒绝——git clone 打
        #     向执行器自身回环没有合法拓扑，只保留绕过成本。
        #   * 字符串级判定沿用既有实现（无 DNS 解析）：『默认拒绝』下偏
        #     保守（非 IP 形式但含私网字样的主机名会被误拒）；与 admin 侧
        #     assertSafeGitRepoUrl 的 DNS 全答检查相比更弱，属已知差距，
        #     依赖「gitRepo 由 admin 侧同款守卫前置校验后才下发」的链路
        #     约定，不在此处扩大改动面。
        private_ip_pattern = r'(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.1[6-9]\.\d{1,3}\.\d{1,3}|172\.2[0-9]\.\d{1,3}\.\d{1,3}|172\.3[0-1]\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3})'
        if not settings.allow_private_network:
            if _re.search(private_ip_pattern, git_repo, _re.IGNORECASE):
                raise HTTPException(status_code=400, detail=f'gitRepo URL contains restricted address: {git_repo}')
        else:
            # 开关开启：放行 RFC1918，loopback 仍拒绝（见上方 ADR）。
            loopback_pattern = r'(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3})'
            if _re.search(loopback_pattern, git_repo, _re.IGNORECASE):
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
    # E-02: timeout 三语义收敛——0=不限时 / 缺省=settings 默认 / 其他=clamp
    # （_resolve_task_timeout，node routes/execute.ts 改动4 对齐）。
    timeout = _resolve_task_timeout(task)
    requirements: list[str] = task.get('requirements', [])
    # QA4: same derivation as the E6 task lock and the E8 live-protection
    # snapshot (_run_and_callback sets entry.task_id from it) — the venv
    # directory name, the lock key and the disk-sweep protection set can
    # never disagree (an empty request id falls back to executionId here
    # too, instead of collapsing onto the .venvs root).
    task_id = _derive_task_key(req)

    # ---------------------------------------------------------------------
    # FR-06b/FR-15（python_task_multiversion）：任务声明的 Python 版本。
    #
    # 只在 runtime=python 时消费（NG-02：node/shell 的多版本不在本期范围，
    # 声明了也不影响其既有 argv）。非法格式在此显式拒绝——绝不静默忽略，
    # 否则用户以为跑在 3.7 上、实际跑在宿主 3.12 上（最危险的一类静默降级）。
    # ---------------------------------------------------------------------
    runtime_version: str | None = None
    # 两个别名都要读：`runtime_version` 是历史/手写载荷形态，executor-node
    # 两种都收（execute.ts 的 `?? task.runtime_version`），只读驼峰会与 node
    # 分叉——同一条 `{"runtime_version":"3.11"}` 在 node 上按 3.11 跑、在这里
    # 却静默落回宿主默认解释器（D14 明令禁止的静默降级）。
    _raw_runtime_version = task.get('runtimeVersion')
    if _raw_runtime_version is None:
        _raw_runtime_version = task.get('runtime_version')
    if _raw_runtime_version is not None and str(_raw_runtime_version).strip():
        # **只接受真正的字符串**，绝不 `str()` 强转。
        #
        # 为什么不能宽容：JSON 数字会被 IEEE754 吃掉尾零——客户端写
        # `"runtimeVersion": 3.10`，服务端拿到的浮点就是 3.1，`str()` 出来是
        # `'3.1'`，于是用户声明 3.10、任务实际跑 3.1，且**校验通过**（3.1 形状
        # 合法）。这是"静默按错的版本跑"，比直接失败危险得多。
        # 且 node 侧 normalizeRuntimeVersion 要求 typeof === 'string'（数字一律
        # 抛 Invalid runtimeVersion），故强转还会造成两侧对同一载荷一收一拒。
        if not isinstance(_raw_runtime_version, str):
            return {
                'success': False,
                'logs': '',
                'exitCode': None,
                'errorMessage': (
                    f'Invalid runtimeVersion (expected a string like "3.11", '
                    f'got {type(_raw_runtime_version).__name__}): '
                    f'{_raw_runtime_version!r}'
                ),
                'durationMs': int((time.monotonic() - started_at) * 1000),
            }
        declared_version = _raw_runtime_version.strip()
        if runtime != 'python':
            logger.warning(
                'Task %s declares runtimeVersion=%s but runtime=%s — the version '
                'declaration only applies to the python runtime and is ignored',
                task.get('name'), declared_version, runtime,
            )
        elif not RUNTIME_VERSION_PATTERN.fullmatch(declared_version):
            return {
                'success': False,
                'logs': '',
                'exitCode': None,
                'errorMessage': (
                    f'Invalid runtimeVersion (expected X.Y, e.g. 3.7): {declared_version!r}'
                ),
                'durationMs': int((time.monotonic() - started_at) * 1000),
            }
        else:
            runtime_version = declared_version

    # ---------------------------------------------------------------------
    # FR-01/02/03/04（python_task_multiversion）：zip 整包渠道。
    #
    # **优先级显式化：git > glue > application_zip**（DESIGN.md §2.6 的存量推导
    # 优先级）。存量库里存在 `gitRepo` 与 `applicationId` 并存的历史行——
    # applicationId 历史上只是一个"关联到应用记录"的弱引用，**不表示"代码来自
    # 这个 zip"**；迁移正是靠 `git > glue > application_zip > NULL` 的优先级把
    # 这种行判成 git。若这里只看 `bool(applicationId)`，同一份工作目录会先被
    # git clone、再被 zip 解压覆盖（还叠加包内 requirements），既违反兼容红线
    # §4.4（三渠道既有行为与结果不变），也是"包内容覆盖已克隆源码"的安全意外。
    #
    # 触发条件（二选一，且必须没有更高优先级的代码来源）：
    #   1. `codeSource == 'application_zip'` —— 写面校验过的**显式信号**
    #      （CONTRACT.md §2.1：该取值要求 applicationId 必填）；
    #   2. 无 `codeSource` 但 `applicationId` + **`packageUrl` 同时存在**——
    #      历史行/迁移置 NULL 的歧义场景。这里刻意改看 `packageUrl` 这个
    #      **admin 生产出来的正向信号**（admin 只为 zip 任务附 packageUrl），
    #      而不是继续依赖 applicationId 这个歧义列：admin 不当作 zip 任务的行
    #      自然就没有 packageUrl，于是原样落回既有行为。
    #
    # 位置纪律：必须在 `load_manifest` **之前**——manifest 从 work_dir 读取，
    # 而 work_dir 此刻除了刚解压的包内容之外应当为空。若先读 manifest，包内
    # 自带的 manifest.yaml 就能劫持 entrypoint/requirements（把"包内数据"
    # 提权成"任务配置"），那是 zip 渠道独有的攻击面。
    # ---------------------------------------------------------------------
    code_source = task.get('codeSource') or task.get('code_source')
    application_id = task.get('applicationId') or task.get('application_id')
    package_url = task.get('packageUrl') or task.get('package_url')
    glue_source = task.get('glueSource') or task.get('glue_source')
    glue_language = task.get('glueLanguage') or task.get('glue_language')

    if code_source == 'application_zip':
        is_zip_channel = True
    # ZIP-PRED-01（本轮审计）：兜底分支必须带 `not code_source`，与
    # executor-node（`execute.ts` 的 `!codeSource && !!applicationId &&
    # !!packageUrl`）**逐字同形**。
    #
    # 改动前这里写的是裸 `elif application_id and package_url`，于是
    # `codeSource='git'`（或 'glue'）**且** applicationId 残留**且**载荷里带了
    # packageUrl 的任务：node 判非 zip、这里判 zip —— 同一份载荷两个执行器走
    # 不同代码渠道（git clone 出来的源码会被 zip 解压覆盖，即兼容红线 §4.4 要
    # 防的那类事故）。admin 的写面互斥目前使该输入不可达，故这是**潜伏**分叉；
    # 但执行器也接受 admin 之外的直连派发，且显式 codeSource 的语义本就是
    # "渠道已定，不要用其它字段猜"，故按 node 口径补齐。
    elif not code_source and application_id and package_url:
        is_zip_channel = True
    else:
        is_zip_channel = False
    if is_zip_channel and (git_repo or glue_source):
        # 写面互斥（CONTRACT.md §2.1）保证不可达；真出现了就按文档优先级让位，
        # 并留下 ERROR 级日志——静默按其中一个跑才是真正危险的。
        logger.error(
            'Task %s declares codeSource=%r/applicationId=%r together with %s — '
            'applying the documented precedence git > glue > application_zip and '
            'ignoring the zip channel',
            task.get('name'), code_source, application_id,
            'gitRepo' if git_repo else 'glueSource',
        )
        is_zip_channel = False

    if is_zip_channel:
        if not package_url:
            # 绝不静默跑一个空工作目录（那会把"配置缺失"伪装成"脚本报错"）。
            # 只有**确实是** zip 任务（codeSource 显式声明）才会走到这里：歧义
            # 分支本就要求 packageUrl 存在，所以存量 git+applicationId 行不受影响。
            return {
                'success': False,
                'logs': '',
                'exitCode': None,
                'errorMessage': (
                    'application_zip task has no packageUrl in the dispatch payload '
                    '(admin must attach the resolved applications.packageUrl); '
                    f'applicationId={application_id!r}'
                ),
                'durationMs': int((time.monotonic() - started_at) * 1000),
            }
        safe_url = _assert_safe_package_url(str(package_url))
        # 下载到工作目录内的临时文件（不落内存：200MB 上限下内存驻留不可接受）。
        zip_path = work_dir / '.package.zip'
        try:
            size = await _download_package(safe_url, zip_path)
            logger.info(
                'Downloaded package for execution %s (%d bytes)', req.executionId, size
            )
            await asyncio.to_thread(_extract_package, zip_path, work_dir)
        finally:
            # 包本身是中间产物：解压完即删，既省磁盘也让 TTL 清扫不必认识它。
            _remove_quietly(zip_path)
        logger.info('Package extracted into %s', work_dir)

        # D4/AC-04a/b：包内 requirements.txt ∪ 任务级 requirements（任务级同名覆盖）。
        package_requirements = _read_package_requirements(work_dir)
        if package_requirements:
            requirements = merge_requirements(package_requirements, requirements)
            logger.info(
                'Merged package + task requirements for %s: %s',
                req.executionId, requirements,
            )

    # Glue script support: write inline source to a temp file and use it as entrypoint
    if glue_source:
        # GLUE-LANG-01（本轮审计）：语言判定必须与 executor-node **逐字同形**。
        # node（routes/execute.ts）是 `glueLanguage.toLowerCase()` 后同时接受裸
        # 语言名（`python`/`javascript`/`shell`）与历史 `glue_*` 形态
        # （`glue_python`/`glue_node`/`glue_shell`）；协议 enum
        # （protocol.json schemas.TaskConfig.glueLanguage）也是这 6 个取值。
        #
        # 失败模式（改动前）：这里只做**精确字符串**比较，于是同一份
        # `{"glueSource":…, "glueLanguage": "glue_python"}` 在 node 上按 python
        # 跑、在这里被 400 拒掉（存量库里 `glue_*` 是迁移期的真实形态，
        # admin-api 的 `GlueLanguage` 类型与 builtin-runtimes 都还在用）。
        # 「同一载荷两个执行器一收一拒」正是 CONTRACT §3.3 明令禁止的分叉，
        # 且协议已把 `glue_python` 列为**合法**取值——故这里必须补齐。
        #
        # 归一化与 node 一致：lower + strip（node 是 `glueLanguage.toLowerCase()`，
        # python 侧额外 strip 以容忍手写载荷的空白——只放宽不收紧）。
        _glue_lang = glue_language.strip().lower() if isinstance(glue_language, str) else ''
        if _glue_lang in ('python', 'glue_python') or (not _glue_lang and runtime == 'python'):
            glue_file = work_dir / 'glue_script.py'
            glue_runtime = 'python'
        elif _glue_lang in ('javascript', 'glue_node') or (not _glue_lang and runtime == 'node'):
            glue_file = work_dir / 'glue_script.js'
            glue_runtime = 'node'
        elif _glue_lang in ('shell', 'glue_shell') or (not _glue_lang and runtime == 'shell'):
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
    # E-42（DEEP_REVIEW 0ef3bbe）：task.id/name 可能是非 str（上游 DTO 误传数字/
    # 对象）——env dict 的值要求 str，非 str 进 subprocess env 构造时抛 TypeError，
    # 任务失败原因难定位。显式 str() 兜底；用 `or ''` 而不是 dict 默认值，是为了
    # 与 node `String(task.id || '')` / `String(task.name || '')` 逐字对齐：显式
    # null/0/false 在两侧都收敛成空串，而不是 python 的 'None'/'0'/'False'。
    env['TASK_ID'] = str(task.get('id') or '')
    env['TASK_NAME'] = str(task.get('name') or '')
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
    # E-02: timeout=0（不限时）任务的回调 token 必须有数字 TTL——取与 node
    # TOKEN_TTL_UNBOUNDED_SECONDS 一致的 10 年上限（Infinity 不可序列化，
    # 0 又会被 create_execution_callback_token 的 max(1, …) 当成 1s）。
    callback_token = create_execution_callback_token(
        req.executionId,
        (TOKEN_TTL_UNBOUNDED_SECONDS if timeout == 0 else timeout)
        + CALLBACK_TOKEN_GRACE_SECONDS,
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

    # SEC-NEW (F-1/B-1): 任务私有临时目录（<work_dir>/.tmp，0o700）并把
    # TMPDIR/TEMP/TMP 指过去——即便未启用 bwrap 沙箱，任务临时文件也只落在
    # 自己的工作目录内（可被 TTL 清扫回收），不写宿主 /tmp（PrivateTmp 的
    # 轻量等价物；bwrap profile 另有 --tmpfs /tmp 兜底）。
    with_task_tmpdir(env, work_dir)

    # ---------------------------------------------------------------------
    # FR-07/11/12（python_task_multiversion）：解释器获取与解释器失败留痕。
    #
    # 位置在 cmd 构造**之前**、runtime 分派**之外**：glue（AC-11a）与
    # 无依赖 python（AC-04c）两条路径都要以"所选解释器"运行入口，它们都不建
    # venv，所以解释器解析不能藏在 ensure_venv 里。
    #
    # D14 明确失败：声明版本取不到就失败，**绝不回退宿主解释器**——回退会把
    # "版本不匹配"掩盖成"任务跑成功了"，是最坏的一种降级。
    # ---------------------------------------------------------------------
    interpreter_failure: dict | None = None
    resolved_interpreter: str | None = None
    if runtime_version is not None and runtime == 'python' and glue_source:
        # AC-11a：glue 不建 venv（FR-11/AC-11b 既有语义逐字保留），但声明了
        # 版本就必须用该版本的解释器执行脚本（仅 python glue 需要解释器；
        # shell glue 走 _build_shell_cmd，版本声明不适用）。
        try:
            resolved_interpreter = str(
                await _ensure_interpreter(runtime_version, timeout=_interpreter_download_timeout())
            )
            # NETOPT-6②：glue 用池解释器直接当 cmd[0] 跑（不建 venv，pyvenv.cfg
            # 依赖扫描覆盖不了），登记进 liveness 集合阻止 LRU 回收在跑期间删
            # 目录；run_task 的 finally（与 spawn 前 killed 早退）注销。
            _register_live_pool_interpreter(resolved_interpreter)
        except Exception as exc:  # noqa: BLE001 - 全部归类为解释器不可获取
            if not _is_interpreter_unavailable(exc):
                raise
            pool = _pool_summary()
            logger.error(
                'Interpreter %s unavailable for glue execution %s: %s',
                runtime_version, req.executionId, exc,
            )
            return _interpreter_failure_result(
                runtime_version, exc, pool, started_at, req.executionId,
            )

    if runtime == 'python' and not requirements and runtime_version is not None:
        # AC-04c + D14：无依赖的 python 任务**同样**要按声明版本运行——它不建
        # venv，但解释器必须换。这条分支此前只在 glue 里处理，于是无依赖 +
        # 声明版本的任务会静默落回宿主解释器（D14 明令禁止的降级）。取不到
        # 就明确失败，绝不回退。
        try:
            resolved_interpreter = str(
                await _ensure_interpreter(runtime_version, timeout=_interpreter_download_timeout())
            )
            # NETOPT-6②：无依赖 python 同样直接跑池解释器（不建 venv），登记
            # 进 liveness 集合；run_task 的 finally（与 spawn 前 killed 早退）注销。
            _register_live_pool_interpreter(resolved_interpreter)
        except Exception as exc:  # noqa: BLE001 - 全部归类为解释器不可获取
            if not _is_interpreter_unavailable(exc):
                raise
            pool = _pool_summary()
            logger.error(
                'Interpreter %s unavailable for dependency-free execution %s: %s',
                runtime_version, req.executionId, exc,
            )
            return _interpreter_failure_result(
                runtime_version, exc, pool, started_at, req.executionId,
            )

    if runtime == 'python':
        if requirements:
            # Each task ID maps to a persistent venv; same task reuses the same env
            _validate_requirements(requirements)
            # FR-16/D6: task_id already carries the version signature
            # (_derive_task_key) — `.venvs/<id>` vs `.venvs/<id>-3.7` — so a
            # declared-version change can never reuse the old venv (AC-16a).
            venv_dir = Path(settings.work_dir) / '.venvs' / task_id
            # E6: ensure_venv mutates .venvs/<task_id> — its only production
            # call site is here inside run_task, which only runs under the
            # per-task lock from _run_and_callback, so venv creation/install
            # never runs concurrently for the same task (E8 additionally
            # protects a live task's venv dir from the disk TTL sweep).
            try:
                python_bin = await ensure_venv(
                    venv_dir, requirements, python_version=runtime_version
                )
            except Exception as exc:  # noqa: BLE001 - 仅解释器类失败改写留痕
                if not _is_interpreter_unavailable(exc):
                    raise
                return _interpreter_failure_result(
                    str(runtime_version), exc, _pool_summary(), started_at, req.executionId,
                )
            resolved_interpreter = str(python_bin)
            cmd = [str(python_bin), entrypoint]
        else:
            # W-02 follow-up (windows-findings): hardcoded `python3` is absent on
            # Windows (Store stub returns 9009), so every non-venv python runtime
            # and python glue task failed to launch there. sys.executable is the
            # interpreter running this executor and exists on every platform; the
            # task inherits the same stdlib the executor was validated against.
            #
            # AC-10a/AC-04c 兼容红线：无声明版本 → `sys.executable` 逐字节不变。
            # 声明版本 → 用池内该版本解释器（解析已在上面完成，取不到即已返回
            # 失败，绝不落到这里）。
            cmd = [resolved_interpreter or sys.executable, entrypoint]
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
        # NETOPT-6②：尚未 spawn，先解除池解释器 liveness 登记再退出
        # （下方大 try 的 finally 覆盖不到这里；幂等 discard，其余路径为 no-op）。
        _unregister_live_pool_interpreter(resolved_interpreter)
        return {
            'success': False,
            'logs': '',
            'exitCode': None,
            'errorMessage': 'Execution killed by admin request',
            'durationMs': int((time.monotonic() - started_at) * 1000),
        }

    log_file = work_dir / f'{req.executionId}.log'
    try:
        # SEC-NEW (F-1): 沙箱包装——bwrap 用户命名空间 + 只读根文件系统 +
        # PrivateTmp（TASK_SANDBOX=bwrap 时生效）。fail-closed：配置启用但
        # 不可用（bwrap 缺失 / 宿主禁用户命名空间）→ 任务直接失败，绝不静默
        # 降级为无沙箱运行（SandboxUnavailable 在下方 except 转失败结果）。
        cmd = build_sandbox_cmd(cmd, work_dir)
        # SEC-NEW (B-1): 任务资源上限（RLIMIT_AS/CPU/FSIZE/NOFILE/NPROC）。
        # POSIX 经 preexec_fn 在 exec 前施加；win32 无等价原语（返回 None）。
        rlimit_fn = build_rlimit_pre_exec(settings, timeout)
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(work_dir),
            env=env,
            # W-02: setsid on POSIX, process-group flag on win32;
            # SEC-NEW (B-1): 同一 preexec 阶段叠加 RLIMIT_*。
            **_spawn_kwargs_for_platform(rlimit_fn),
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
            # E-02: timeout=0（不限时）→ wait_for(None) 即无限等待——不设执
            # 行等待超时，TimeoutError 杀树分支对不限时任务不可达。
            await asyncio.wait_for(
                asyncio.shield(stream_task),
                timeout=None if timeout == 0 else timeout,
            )
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
        # NETOPT-6②：解除池解释器 liveness 登记（幂等 discard——glue/无依赖
        # python 路径登记过 resolved_interpreter；venv 路径的 python_bin 是
        # venv shim 而非池路径，discard 未登记键为无害 no-op。变量在解释器
        # 解析段无条件初始化为 None，finally 处必已绑定）。
        _unregister_live_pool_interpreter(resolved_interpreter)
