"""解释器缓存池 —— 执行器侧唯一事实源（FR-07/13/14/15、NFR-02/03/10/13/16）。

本模块是 `apps/executor-python` 里**唯一**允许拼 `uv python …` 命令的地方；
`routers/execute.py` / `main.py` / `scheduler.py` 只消费这里的接口（DESIGN.md
§2.1.2 职责边界）。接口按 CONTRACT.md §3.2 冻结：

    InterpreterInfo / InterpreterUnavailable
    discover_installed(*, timeout=...) -> list[InterpreterInfo]
    resolve_python_bin(version) -> Path | None
    ensure_version(version, *, timeout) -> Path
    ensure_version_async(version, *, timeout) -> Path      # WS4 的 async 入口
    is_supported_version(version) -> bool                  # 可声明区间（settings）
    is_online_downloadable(version) -> bool                # 在线下载下界 3.8
    invalidate_cache() -> None
    pool_summary() -> dict                                 # FR-12 留痕
    build_uv_env() -> dict[str, str]                       # WS4 复用（见下）

安全姿态（§2.4）
---------------
* **路径白名单（NFR-02）**：解释器路径只来自缓存池 `UV_PYTHON_INSTALL_DIR` 内
  `uv python list --only-installed` 的枚举结果，且 `resolve_python_bin` 对返回值
  做 `Path.resolve().is_relative_to(pool_root)` 断言——**不接受任务提供的任何路径**。
* **命令注入（NFR-03）**：`version` 必须先过 `^\\d+\\.\\d+$` 才可能进入 uv argv，
  非法值抛 `ValueError` 且**不 spawn 任何子进程**。
* **环境隔离（NFR-01/03）**：uv 子进程环境为严格白名单（`build_uv_env()`），
  只保留 PATH/HOME 类运行时路径 + 显式注入的 `UV_*`；宿主 `EXECUTOR_*` /
  `PIP_*` / `UV_INDEX*` / `PYPI_*` 等 secret 一律不继承。
* **下载收敛（D8/NFR-16）**：环境里钉死 `UV_PYTHON_DOWNLOADS=manual`，uv 自身
  拒绝在 `uv venv --python` 阶段隐式下载——所有下载只能走本模块的
  `uv python install`，D13 的互斥因此成为 uv 强制保证而非约定。

并发设计（D13 / NFR-16 / EG-06）
-------------------------------
三层，从外到内：

1. **per-version `threading.Lock`**（`_version_locks` + `_version_locks_guard`，
   原子 fetch-or-create，对照 `routers/execute.py` 的 `_get_git_cache_lock`）。
   同一版本的并发请求在这里排队，第一个持锁者下载，其余在**拿到锁之后重查
   缓存**（double-checked locking）直接命中，不再下载。
2. **全局有界下载 `asyncio.Semaphore(N)`**（`_download_semaphore`，N =
   `settings.interpreter_download_concurrency`，默认 2）——D13 的"全局至多 N 个
   in-flight 解释器下载"（1 = 旧版全局单队列）。不同版本写池内不同目录，
   uv 的"同目录并发写不安全"不跨版本；同版本由第 1 层去重。**只在事件循环域
   获取**：信号量槽在 `ensure_version_async` 里 `async with` 拿到后才把阻塞工作
   丢进 `asyncio.to_thread`，因此等待者让出事件循环，心跳不会被阻塞。
3. **同步核心 `ensure_version`** 供非 async 调用方（脚本/维护任务/WS4 的同步
   路径）使用：它只做线程级排队（第 1 层），**不**碰事件循环信号量。

**为什么不互相等待（无死锁）**：`asyncio.Semaphore` 永远只在事件循环线程被
`await`；阻塞工作（`threading.Lock`、子进程、`resolve`）只在工作线程里跑。
两者从不在同一线程交叉持有——不会出现"持线程锁等事件循环、事件循环等线程锁"。
`ensure_version` 若被 async 代码直接调用会阻塞事件循环（这是 WS4 必须用
`ensure_version_async` 的原因），本模块不做任何"偷偷起线程池"的隐式兜底。

**测试隔离**：事件循环是 asyncio 对象，绑定"第一次 await 它"的循环；本套件
每个用例都 `asyncio.run` 起独立循环（对照 `_get_task_lock` 的既有教训），因此
`_download_semaphore` 按**当前运行循环**分桶（`id(loop)` 为键），循环切换时
自动拿到新信号量——生产只有一个循环，行为不变。

超时与失败分因（D11/D14）
------------------------
单次下载独立预算由调用方传入（`settings.interpreter_download_timeout_seconds`
默认 300，与任务剩余超时取较小者）；超时 → `InterpreterUnavailable('download_timeout')`，
非零退出 → `'download_failed'`，产物校验失败 → `'corrupt'`，`< 3.8` 且池内无
→ `'not_downloadable'`，uv 不可执行 → `'uv_missing'`。**明确失败，不回退宿主
解释器**（D14）。
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from config import ONLINE_DOWNLOAD_MIN, RUNTIME_VERSION_PATTERN, settings

logger = logging.getLogger(__name__)

_UV_BIN_ENV = 'UV_BIN'

# uv 由 requirements.txt 装进镜像的 /usr/local/bin。与 routers/execute.py 的
# UV_BIN 同源（`shutil.which('uv') or 'uv'`）；`UV_BIN` 环境变量是 executor-node
# 桌面端"随包内置 uv"的等价接线点（CONTRACT.md §3.3 uv 定位）。
UV_BIN = os.environ.get(_UV_BIN_ENV) or shutil.which('uv') or 'uv'

# 探测结果缓存 TTL（NFR-10）：心跳间隔 30s（settings.heartbeat_interval_seconds），
# 缓存必须覆盖一个心跳周期，否则每次心跳都会 spawn 一个 uv 进程。
DISCOVERY_CACHE_TTL_SECONDS = 60.0

# 启动期首次探测的默认预算（NFR-10 全量探测 ≤5s）。
DISCOVERY_TIMEOUT_SECONDS = 5.0

# 下载产物校验（`--version` 抽查）的短预算——只读本地可执行文件，不联网。
_VERIFY_TIMEOUT_SECONDS = 10.0

# F-2（SEC-NEW）：已记录「无 SHA-256 pin、完整性未验证」的版本集合——
# 每个版本只 warn 一次（首次在线下载时），并在 pool_summary() 里持续留痕，
# 便于运维发现哪些版本只做了「可执行 + 版本号」抽查、未做哈希比对。
_integrity_unverified: set[str] = set()
_integrity_guard = threading.Lock()


def _mark_integrity_unverified(version: str) -> None:
    with _integrity_guard:
        if version not in _integrity_unverified:
            _integrity_unverified.add(version)
            logger.warning(
                'interpreters: Python %s was installed WITHOUT a SHA-256 pin '
                '(uv_python_sha256_pins) — download integrity is unverified; '
                'pin the version after a trusted install (see interpreters.py '
                'F-2 notes) to enforce checksums on every future install',
                version,
            )


def integrity_unverified_versions() -> list[str]:
    """供 pool_summary / 心跳上报：当前未做哈希校验的版本列表。"""
    with _integrity_guard:
        return sorted(_integrity_unverified)


def _reset_integrity_tracking() -> None:
    """测试辅助：清空完整性留痕集合（生产不需要调用，与 _reset_semaphores 同类）。"""
    with _integrity_guard:
        _integrity_unverified.clear()


def _sha256_of(path: Path) -> str:
    """Compute the SHA-256 of a file in streaming fashion (64 KiB chunks)."""
    digest = hashlib.sha256()
    with open(path, 'rb') as fh:
        while True:
            chunk = fh.read(65536)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()

# uv 下载的退出码约定（实测 0.8.17）：无可用下载 / 找不到解释器 → 2。
# 仅用于把失败文案润色成"不可在线获取"，不改变失败分因。
_UV_NOT_FOUND_EXIT_CODE = 2

# 池内版本目录名：`cpython-<完整版本>-<平台>-none`（CONTRACT.md §0 命名约定）。
_POOL_DIR_RE = re.compile(r'^cpython-(\d+\.\d+(?:\.\d+)?)-')

# 版本号提取：`uv python list` 的每一行以 `cpython-3.12.3-windows-x86_64-none`
# 之类的键开头，也可能出现 pypy 等实现前缀，统一取"第一个 X.Y[.Z] 形状的段"。
_VERSION_TOKEN_RE = re.compile(r'(?<![\d.])(\d+\.\d+(?:\.\d+)?)(?![\d.])')


class InterpreterUnavailable(RuntimeError):
    """解释器无法获取。携带 .version / .reason / .detail 供失败分类与留痕。

    reason 取值（CONTRACT.md §3.2 + uv_missing 扩展）：
    ``download_failed`` | ``download_timeout`` | ``not_downloadable`` |
    ``corrupt`` | ``mirror_unreachable`` | ``uv_missing``。
    """

    def __init__(self, version: str, reason: str, detail: str):
        self.version = version
        self.reason = reason
        self.detail = detail
        super().__init__(f'Python {version} unavailable ({reason}): {detail}')


@dataclass(frozen=True)
class InterpreterInfo:
    """缓存池内一个已安装解释器（CONTRACT.md §2.2 executors.interpreters 元素）。"""

    version: str          # 完整补丁版本，如 "3.7.9"
    path: str             # 绝对路径（池内白名单）
    available: bool
    discovered_at: str    # ISO8601


# ---------------------------------------------------------------------------
# 环境白名单（NFR-01/03）——对照 routers/execute.py 的 _build_install_env，
# 但本模块**不 import** 它（execute.py 会 import 本模块，反向依赖成环）。
# ---------------------------------------------------------------------------
_UV_ENV_KEYS = {
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'TMPDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR',
    'COMSPEC', 'PATHEXT',
}
_UV_ENV_DENYLIST = {
    'EXECUTOR_SHARED_TOKEN', 'EXECUTOR_SECRET', 'EXECUTION_CALLBACK_SECRET',
    'NPM_REGISTRY_TOKEN', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL',
    'PIP_TRUSTED_HOST', 'UV_INDEX', 'UV_EXTRA_INDEX_URL', 'UV_DEFAULT_INDEX',
    'UV_INSECURE_HOST', 'UV_CONFIG_FILE', 'PYTHONPATH', 'PYPI_REGISTRY_URL',
    'UV_PYTHON_INSTALL_DIR', 'UV_PYTHON_INSTALL_MIRROR', 'UV_PYTHON_DOWNLOADS',
}


def build_uv_env(*, cache_dir: Path | str | None = None) -> dict[str, str]:
    """返回 uv 子进程的最小环境（公开给 WS4 复用：venv / pip install 同款）。

    与 `_build_install_env` 同一纪律，并额外钉死三件与解释器层有关的事：

    * ``UV_PYTHON_INSTALL_DIR`` —— 缓存池根目录，显式注入（宿主环境里的同名
      变量被 denylist 挡掉，避免"宿主任意路径当解释器来源"绕过 NFR-02）。
    * ``UV_PYTHON_INSTALL_MIRROR`` —— 仅在 `settings.uv_python_install_mirror`
      非空时注入（D9/NFR-14 内网镜像）。
    * ``UV_PYTHON_DOWNLOADS=manual`` —— **关键硬化**：uv 自身拒绝在
      `uv venv --python` 阶段隐式下载（实测 0.8.17 返回 exit 2 + hint），
      下载的唯一入口因此是本模块的 `uv python install`（D8/D13 由 uv 强制）。
    """
    env: dict[str, str] = {}
    if sys.platform == 'win32':
        # Windows 环境块大小写不敏感，系统/启动器各按自己的拼写给键
        # （`Path` / `TEMP` / `PROGRAMDATA`…），精确匹配会静默丢掉 PATH。
        allowed = {key.upper() for key in _UV_ENV_KEYS}
        for key, value in os.environ.items():
            upper = key.upper()
            if upper in allowed and upper not in _UV_ENV_DENYLIST:
                env[upper] = value
    else:
        for key, value in os.environ.items():
            if key in _UV_ENV_KEYS and key not in _UV_ENV_DENYLIST:
                env[key] = value
    if cache_dir is not None:
        cache_path = Path(cache_dir)
        cache_path.mkdir(parents=True, exist_ok=True)
        env['UV_CACHE_DIR'] = str(cache_path)
    env['UV_NO_CONFIG'] = '1'
    env['PIP_CONFIG_FILE'] = os.devnull
    env['UV_PYTHON_INSTALL_DIR'] = str(pool_root())
    env['UV_PYTHON_DOWNLOADS'] = 'manual'
    mirror = (settings.uv_python_install_mirror or '').strip()
    if mirror:
        env['UV_PYTHON_INSTALL_MIRROR'] = mirror
    return env


# ---------------------------------------------------------------------------
# 缓存池根目录 / 版本校验
# ---------------------------------------------------------------------------

def pool_root() -> Path:
    """缓存池根目录（每次读 settings，支持热更/测试 monkeypatch）。"""
    return Path(settings.uv_python_install_dir)


# B-4（SEC-NEW）：池目录权限纪律——只允许执行器用户可写（0o755），同机其他
# 进程/容器不得向池内注入伪造的 `cpython-<ver>-…` 目录（那会让所有使用该版本
# 的任务跑在攻击者提供的解释器上）。Windows 的 os.chmod 只映射只读位、st_uid
# 无意义，故 owner 校验仅在 POSIX 生效；chmod 失败不阻断启动（记录 warning）。
def harden_pool_permissions() -> None:
    """收紧解释器缓存池目录权限 + 校验 owner（B-4）。

    * mkdir（存在则跳过）；
    * POSIX：chmod 0o755；若目录 owner 不是当前 euid，记录 warning（共享只读
      volume 场景可能由其他用户挂载，不据此 fail，但可写性必须收敛）；
      若目录当前 group/world 可写且 chmod 成功，即被收紧为 755。
    """
    root = pool_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:  # pragma: no cover - 只读卷/权限问题
        logger.warning('interpreters: cannot create pool dir %s: %s', root, exc)
        return
    if sys.platform == 'win32':
        return
    try:
        os.chmod(root, 0o755)
        st = root.stat()
        if hasattr(os, 'geteuid') and st.st_uid != os.geteuid():
            logger.warning(
                'interpreters: pool dir %s is owned by uid %s (executor runs as %s); '
                'ensure the owner is trusted and the dir is NOT writable by others '
                '(B-4)',
                root, st.st_uid, os.geteuid(),
            )
    except OSError as exc:  # pragma: no cover - chmod/stat 失败不阻断
        logger.warning('interpreters: cannot harden pool dir %s permissions: %s', root, exc)


def validate_version(version: str) -> str:
    """`X.Y` 白名单校验——**进入 uv argv 之前的唯一闸门**（NFR-03）。

    非法值抛 ``ValueError``；调用方在任何 subprocess 之前调用它。

    **不做任何规范化**（不 strip、不 lower）：闸门必须与 CONTRACT.md §1.2 的
    `^\\d+\\.\\d+$` 逐字一致。宽容化看似友好，实则让 `"3.7\\n"` / `" 3.7"`
    这类"能过闸门但语义可疑"的取值流进 argv；调用方要做规范化就自己做，
    闸门只负责说"是/否"。
    """
    if not isinstance(version, str) or not RUNTIME_VERSION_PATTERN.fullmatch(version):
        raise ValueError(
            f'invalid Python version {version!r}: expected "X.Y" (major.minor)'
        )
    return version


def _version_tuple(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split('.'))


def _matches_prefix(available: str, requested: str) -> bool:
    """D1 前缀匹配：`requested` 与 `available` 相等，或 `available` 以
    ``requested + '.'`` 开头。

    跨版本号前缀必须带点：`"3.1"` **不得**匹配 `"3.13.0"`（CONTRACT.md §1.2）。
    """
    return available == requested or available.startswith(requested + '.')


def is_online_downloadable(version: str) -> bool:
    """该版本能否由 uv 在线下载（CONTRACT.md §0.1：`< 3.8` 不可以）。

    非法版本抛 ``ValueError``（同 `validate_version`）。
    """
    validate_version(version)
    return _version_tuple(version) >= _version_tuple(ONLINE_DOWNLOAD_MIN)


def is_supported_version(version: str) -> bool:
    """该版本是否落在部署方配置的**可声明区间**内（CONTRACT.md §1.1）。

    与 executor-node 的 `isSupportedVersion`（常量 3.7~3.14）对等；区别是这里
    读 `settings.python_runtime_version_min/max`（默认同为 3.7/3.14，部署方可
    收紧）。这两个配置此前在**任何下载路径都没人读**（死配置）：`3.99` 这类
    越界版本会真的去跑 `uv python install`，再以一个含糊的 `download_failed`
    收场，而 node 侧在发起下载前就明确归类为 `not_downloadable`——同一个任务
    只看被调度到哪个执行器就得到不同的失败分因。每次调用都现读 settings，
    支持测试 monkeypatch 与配置热更。

    非法版本抛 ``ValueError``（同 `validate_version`）。
    """
    validate_version(version)
    key = _version_tuple(version)
    return (
        _version_tuple(settings.python_runtime_version_min)
        <= key
        <= _version_tuple(settings.python_runtime_version_max)
    )


def _raise_if_not_downloadable(version: str) -> None:
    """下载前的两道**明确失败**闸门，次序与 node `installVersion` 逐字对齐：

    1. 先查受支持区间（`is_supported_version`）——越界（如 `3.99`）直接
       `not_downloadable`，不浪费一次 uv 调用；
    2. 再查在线可下载下界（`< 3.8`）——3.7 只能离线预填，给出预填指引。

    两道都不触发才允许进入下载/加锁路径。缓存命中在调用本闸门之前短路，
    故离线预填进来的 3.7 不受下界影响。
    """
    if not is_supported_version(version):
        raise InterpreterUnavailable(
            version,
            'not_downloadable',
            f'version {version} is outside the supported range '
            f'{settings.python_runtime_version_min}~'
            f'{settings.python_runtime_version_max} '
            '(uv has no such Python release to download); check the task\'s '
            'runtimeVersion, or ask the operator to adjust '
            'PYTHON_RUNTIME_VERSION_MIN/MAX',
        )
    if not is_online_downloadable(version):
        raise InterpreterUnavailable(
            version, 'not_downloadable', _not_downloadable_detail(version),
        )


def _pool_dir_name(version: str) -> str:
    """返回池内该版本目录名前缀（`cpython-3.9`），用于命中检查与损坏清理。"""
    return f'cpython-{version}'


def _remove_pool_version_dir(version: str) -> None:
    """删除池内属于该主.次版本的目录（仅损坏清理用）。

    只删 `pool_root()` 下、目录名以 `cpython-<version>` 开头（精确到 `.` 边界）
    的目录——`3.1` 不会误删 `3.13.x`。
    """
    root = pool_root()
    if not root.exists():
        return
    for child in root.iterdir():
        if not child.is_dir():
            continue
        if not (child.name == _pool_dir_name(version)
                or child.name.startswith(_pool_dir_name(version) + '.')):
            continue
        resolved = _resolve_within_pool(child)
        if resolved is None:
            # 池根下的条目解析后跑到池外（符号链接）——绝不递归删除。
            logger.warning(
                'interpreters: refusing to remove pool-external entry %s (NFR-02)', child,
            )
            continue
        shutil.rmtree(resolved, ignore_errors=True)
        logger.warning('interpreters: removed corrupt pool entry %s', resolved)


def _python_bin_names() -> tuple[str, ...]:
    if sys.platform == 'win32':
        return ('python.exe', 'python3.exe', 'python')
    return ('python3', 'python')


def _bin_candidates(entry_dir: Path) -> list[Path]:
    """池内条目的解释器可执行文件候选（uv 布局：POSIX `bin/`，Windows 根目录）。"""
    names = _python_bin_names()
    candidates = [entry_dir / name for name in names]
    candidates.extend(entry_dir / 'bin' / name for name in names)
    return candidates


def _first_existing_executable(paths) -> Path | None:
    for candidate in paths:
        try:
            if candidate.is_file():
                return candidate
        except OSError:  # pragma: no cover - 权限/竞态下的防御
            continue
    return None


def _is_executable(path: Path) -> bool:
    """可执行判定：POSIX 用 X_OK；Windows 用存在性（`.exe` 后缀不做硬要求，
    因为本模块自己解析的池条目在 Windows 上同样可能是 `.exe` 之外的包装器）。"""
    if os.name == 'nt':
        return path.is_file()
    return os.access(path, os.X_OK)


def _entry_python_bin(entry_dir: Path) -> Path | None:
    """池内条目目录 → 解释器可执行文件（存在性 + 可执行性都过才返回）。"""
    candidate = _first_existing_executable(_bin_candidates(entry_dir))
    if candidate is None or not _is_executable(candidate):
        return None
    return candidate


def _run_uv_sync(
    args: list[str],
    timeout: float,
    *,
    env: dict[str, str] | None = None,
) -> tuple[int, str]:
    """运行一个 uv 子进程，合并 stdout/stderr。

    超时 → kill 进程树并抛 ``subprocess.TimeoutExpired``（对照 `_run_uv` 的
    kill 分支：`asyncio.wait_for` 不 kill 会留下悬挂的 uv 孤儿进程）。
    """
    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        **(_spawn_kwargs_for_platform()),
    )
    try:
        out, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_process_tree(proc)
        try:
            proc.communicate(timeout=5)
        except Exception:  # pragma: no cover - 收尾尽力而为
            pass
        raise
    return proc.returncode, (out.decode('utf-8', errors='replace') if out else '')


def _spawn_kwargs_for_platform() -> dict:
    """POSIX：新进程组（超时可整树杀）；Windows：新进程组 + taskkill /T。"""
    if sys.platform == 'win32':
        return {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP}
    return {'start_new_session': True}


def _kill_process_tree(proc: 'subprocess.Popen') -> None:
    if sys.platform == 'win32':
        try:
            subprocess.run(
                ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
        except Exception:  # pragma: no cover - 尽力而为
            pass
    try:
        proc.kill()
    except ProcessLookupError:
        pass
    except Exception:  # pragma: no cover - 进程已退出
        pass


def _tail(text: str, limit: int = 1200) -> str:
    """uv 的报错在尾部；保留尾部避免 detail 被进度条刷爆。"""
    if not text:
        return ''
    text = text.strip()
    if len(text) <= limit:
        return text
    return '...' + text[-limit:]


def _is_uv_missing_error(exc: BaseException) -> bool:
    if isinstance(exc, FileNotFoundError):
        return True
    if isinstance(exc, OSError) and getattr(exc, 'errno', None) == 2:
        return True
    return False


# ---------------------------------------------------------------------------
# 探测（FR-14 / NFR-10 / AC-14b）
# ---------------------------------------------------------------------------

_discovery_cache: tuple[float, list[InterpreterInfo]] | None = None
_discovery_guard = threading.Lock()


def _parse_python_list(output: str, *, discovered_at: str) -> list[InterpreterInfo]:
    r"""解析 `uv python list --only-installed` 输出。

    真实输出（实测 0.8.17 / 0.11.14）每行形如::

        cpython-3.13.13-windows-x86_64-none    C:\...\cpython-3.13.13-...\python.exe

    也包含**非托管/系统**解释器（`cpython-3.14.6-windows-x86_64-none  C:\Python314\python.exe`）。

    **池归属过滤（关键，勿删）**：uv 会一并列出系统 Python、PATH 上的
    `.local/bin/python3.x.exe` shim、以及**别的池目录**里的解释器。这些必须按
    池归属剔除——任务声明的版本**只能由本池解释器满足**（`_resolve_python_bin_uncached`
    只认池内路径），若把它们报给 admin，就会出现"执行器宣称有 3.14，实际
    `resolve_python_bin('3.14')` 返回 None"的**谎报**：admin 据此把 3.14 任务
    路由过来，运行期必然失败为 `interpreter_unavailable`，而真正预置了 3.14 的
    执行器却被跳过。这与 executor-node 的 `isInsidePool`（interpreters.ts）是
    **同一道闸**，两侧必须行为一致。

    实测反例（本机）：池里只有 3.11.13 时，未过滤前会宣称
    `['3.11.13','3.13.13','3.14.6','3.9.23','3.9.25']`，其中 4 个都无法解析。

    解析阶段只负责"行 → (版本, 路径)"；池归属在此判定，可执行性由
    `_path_is_usable` 判定。单条损坏只剔除该项（AC-14b），**不抛异常**。
    """
    results: list[InterpreterInfo] = []
    seen: set[tuple[str, str]] = set()
    try:
        root = pool_root().resolve()
    except OSError:  # pragma: no cover - 池根不可解析
        root = None
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        # 按**首个空白串**切分为「键 / 路径」两段，而不是 `line.split()` 后取
        # `parts[-1]`。理由：`<key>` 永远不含空白（形如
        # `cpython-3.13.13-windows-x86_64-none`），但**路径可以含空格**——
        # 例如池落在 `C:\Program Files\interpreters` 或
        # `/opt/my pool/cpython-.../python.exe`。
        #
        # 旧写法 `parts[-1]` 在含空格路径上只会拿到最后一段（如 `python.exe`），
        # 它既不是绝对路径、也不在池内，于是该行被**静默丢弃** → 池明明有解释器
        # 却报空池 → 所有声明了 runtimeVersion 的任务在这台执行器上必然
        # `interpreter_unavailable`。executor-node 侧不受影响（它用
        # `uv python list --output-format json`，见 interpreters.ts:329 的同款
        # 理由），故这是 python 侧独有的"谎报空池"缺陷。
        parts = line.split(None, 1)
        if len(parts) < 2:
            continue
        key = parts[0]
        path_token = parts[1].strip()
        version = None
        dir_match = _POOL_DIR_RE.match(key)
        if dir_match:
            version = dir_match.group(1)
        else:
            token_match = _VERSION_TOKEN_RE.search(key)
            if token_match:
                version = token_match.group(1)
        if not version:
            continue
        if not (path_token.startswith('/') or re.match(r'^[A-Za-z]:[\\/]', path_token)
                or path_token.startswith('\\\\')):
            # 非绝对路径的行（例如 uv 的说明/警告文本）不进入清单。
            continue
        if root is not None and not _is_inside_pool(path_token, root):
            # 系统 Python / PATH shim / 别的池 —— 不属本池，剔除（见上方 docstring）。
            continue
        if not _pool_key_matches_host_platform(key):
            # 同池但**外来平台**的条目（共享卷场景：另一个 libc/OS 的执行器预填的）。
            # 必须剔除：Windows 上 `_is_executable` 只判存在性，Linux 条目的
            # `bin/python3` 会被判成"可用"，于是执行器宣称 3.11 可用、而
            # `resolve_python_bin('3.11')` 返回一个 Linux 二进制 →
            # `uv venv --python <它>` 必然失败。这与 §0.4 是同一类"谎报"。
            # 注意 `key` 只在能解析出平台段时才判定；解析不出则放行（不误杀）。
            continue
        dedupe_key = (version, path_token)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        available = _path_is_usable(path_token)
        results.append(InterpreterInfo(
            version=version,
            path=path_token,
            available=available,
            discovered_at=discovered_at,
        ))
    return results


def _pool_key_matches_host_platform(key: str) -> bool:
    """`uv python list` 的 `<key>` 是否属于本机平台。

    池目录名的平台段必须与 `_current_platform_token()` 一致；`key` 里取不出
    平台段、或本机平台判定不出（`token is None`）时**放行**——宁可不做这层
    过滤，也不能因为拿不准就把健康条目误杀。

    `key` 形如 `cpython-3.11.13-windows-x86_64-none`；平台段是版本之后的三段
    token（`windows-x86_64-none` / `linux-x86_64-gnu` / `macos-aarch64-none`）。
    """
    token = _current_platform_token()
    if token is None:
        return True
    match = _POOL_DIR_FULL_RE.match(key)
    if not match:
        return True
    return match.group(2) == token


def _is_inside_pool(path_token: str, root: 'Path') -> bool:
    """`path_token` 解析后是否落在池根之内（符号链接逃逸同样拦下）。

    与 `_resolve_within_pool` 同源语义，但用于**探测期**：探测不能因为单条
    路径不可解析就整体失败，所以此处任何异常一律判为"不在池内"（剔除该项）。
    """
    try:
        return Path(path_token).resolve().is_relative_to(root)
    except (OSError, ValueError):  # pragma: no cover - 断链/竞态
        return False


def _path_is_usable(path_token: str) -> bool:
    """探测期可用性判定：路径存在 + 可执行。

    刻意**不**调用 `--version`（每次探测都要为每个版本 spawn 一个进程，
    与 NFR-10 的"心跳不产生进程开销"相悖）；下载后的产物校验才做 `--version`
    抽查（`_verify_installed`）。
    """
    try:
        path = Path(path_token)
        if not path.is_file():
            return False
        return _is_executable(path)
    except OSError:
        return False


# 池目录名全形：`cpython-<X.Y.Z>-<平台三元组>`。实测（CONTRACT.md §0.3）
# uv 的**目录名没有**尾随 `-none`：真实名字是 `cpython-3.13.13-windows-x86_64-none`
# 里平台三元组即 `windows-x86_64-none`，整体只有三段版本 + 三段平台。
# 平台三元组恰由三段以 `-` 分隔的 token 组成（`linux-x86_64-gnu`、
# `windows-x86_64-none`、`macos-aarch64-none`…）。
# 也接受 uv 的 `<X.Y>` 短目录名（如 `cpython-3.12-windows-x86_64-none`）。
_POOL_DIR_FULL_RE = re.compile(
    r'^cpython-(\d+\.\d+(?:\.\d+)?)-([^-]+-[^-]+-[^-]+)$',
)

# `platform.machine()` → uv 架构 token。
_ARCH_TOKENS = {
    'amd64': 'x86_64',
    'x86_64': 'x86_64',
    'arm64': 'aarch64',
    'aarch64': 'aarch64',
    'x86': 'i686',
    'i386': 'i686',
    'i686': 'i686',
    'armv7l': 'armv7',
    'armv6l': 'armv6',
}


def _linux_libc_token() -> str:
    """Linux 上判定 gnu / musl（决定 uv 平台三元组第三段）。

    依据 musl 的动态加载器 `/lib/ld-musl-*.so.1` 或 Alpine 的
    `/etc/alpine-release`。判定不出时按 `gnu`（绝大多数发行版）。
    """
    try:
        if Path('/etc/alpine-release').exists():
            return 'musl'
        lib = Path('/lib')
        if lib.is_dir() and any(lib.glob('ld-musl-*')):
            return 'musl'
    except OSError:  # pragma: no cover - 权限/竞态
        pass
    return 'gnu'


def _current_platform_token() -> str | None:
    """本机在 uv 池目录命名中的平台三元组（如 `linux-x86_64-gnu`）。

    只服务于**本地目录兜底扫描**：uv 整体探测失败时直接读池目录，必须把
    外来平台的条目排除掉，否则会在 Windows 上把 Linux 条目也报成可用
    （Windows 的 `_is_executable` 只判存在性，拦不住）。

    判定不出架构时返回 ``None``，调用方退化为不做平台过滤——宁可多报也
    不漏报，因为后续 `resolve_python_bin` 仍会做存在性、可执行性与池内
    白名单三重校验。
    """
    arch = _ARCH_TOKENS.get(platform.machine().strip().lower())
    if not arch:
        return None
    if sys.platform == 'win32':
        return f'windows-{arch}-none'
    if sys.platform == 'darwin':
        return f'macos-{arch}-none'
    if sys.platform.startswith('linux'):
        return f'linux-{arch}-{_linux_libc_token()}'
    return None


def _scan_pool_directory(discovered_at: str) -> list[InterpreterInfo]:
    """本地目录兜底扫描：不 spawn uv，直接从池目录名 + 可执行文件判定。

    存在的理由（实测，CONTRACT.md §0.3）：`uv python list --only-installed`
    只要池内存在**一个同平台但不可运行**的条目就整体 exit 2，并且**连健康
    条目也一并从输出里消失**。若此时把池当作"空"，执行器会对外宣称零解释器
    ——所有声明版本的任务被拒（`interpreter_unavailable`），而池里的健康版本
    实际仍可用（`uv venv --python 3.8` 依旧成功）。这条兜底路径让"一个坏条目"
    不再致盲整个池。

    判定口径与 uv 探测保持一致：目录名版本 + 解释器可执行文件真实存在。
    """
    root = pool_root()
    if not root.is_dir():
        return []
    token = _current_platform_token()
    entries: list[InterpreterInfo] = []
    try:
        children = sorted(root.iterdir(), key=lambda p: p.name)
    except OSError as exc:  # pragma: no cover - 池目录不可读
        logger.warning('interpreters: cannot enumerate pool %s: %s', root, exc)
        return []
    for child in children:
        try:
            if not child.is_dir():
                continue
        except OSError:  # pragma: no cover - 竞态
            continue
        match = _POOL_DIR_FULL_RE.match(child.name)
        if not match:
            continue
        version, dir_platform = match.group(1), match.group(2)
        if token is not None and dir_platform != token:
            # 外来平台条目（共享卷里另一执行器的 libc/OS）：跳过。
            continue
        python_bin = _entry_python_bin(child)
        if python_bin is None:
            logger.warning(
                'interpreters: pool entry %s has no runnable interpreter — skipped',
                child.name,
            )
            continue
        entries.append(InterpreterInfo(
            version=version,
            path=str(python_bin),
            available=True,
            discovered_at=discovered_at,
        ))
    return entries


def _fallback_discovery(reason: str, discovered_at: str) -> list[InterpreterInfo]:
    """uv 探测失败后的兜底：改用本地目录扫描，并如实留痕。"""
    entries = _scan_pool_directory(discovered_at)
    if entries:
        logger.warning(
            'interpreters: uv discovery failed (%s); recovered %d interpreter(s) '
            'from a local pool scan: %s',
            reason, len(entries), ', '.join(e.version for e in entries),
        )
    else:
        logger.warning(
            'interpreters: uv discovery failed (%s) and the local pool scan found '
            'nothing usable — reporting an empty pool (executor keeps running)',
            reason,
        )
    return entries


def _discover_uncached(timeout: float) -> list[InterpreterInfo]:
    """实际执行 `uv python list --only-installed`；任何失败都不抛。

    AC-14b：单条损坏只剔除该项，**整体失败也不得抛**——执行器必须仍能启动
    （FR-14 "运行中不得因单条探测子命令失败而整体启动失败"）。

    §0.3 加固：uv 整体失败时不再直接报"空池"，而是退到本地目录扫描
    （`_scan_pool_directory`）——因为实测"一个同平台坏条目"会让 uv 连健康
    条目一起吞掉，直接报空池等于把一个局部故障放大成全量不可用。
    """
    discovered_at = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    try:
        code, out = _run_uv_sync(
            [UV_BIN, 'python', 'list', '--only-installed'],
            timeout,
            env=build_uv_env(),
        )
    except subprocess.TimeoutExpired:
        return _fallback_discovery(
            f'`uv python list --only-installed` timed out after {timeout}s', discovered_at,
        )
    except Exception as exc:  # noqa: BLE001 - 探测绝不阻断启动
        if _is_uv_missing_error(exc):
            return _fallback_discovery(
                f'uv binary {UV_BIN!r} is not executable', discovered_at,
            )
        return _fallback_discovery(f'discovery raised {exc}', discovered_at)
    if code != 0:
        return _fallback_discovery(
            f'`uv python list --only-installed` exited {code}: {_tail(out)}', discovered_at,
        )
    entries = _parse_python_list(out, discovered_at=discovered_at)
    # 单条损坏只剔除该项（AC-14b）：解析阶段已过滤不可用项，这里只记日志留痕。
    usable = [entry for entry in entries if entry.available]
    dropped = len(entries) - len(usable)
    if dropped:
        logger.warning(
            'interpreters: dropped %d unusable pool entry/entries (AC-14b)', dropped,
        )
    if not usable:
        # uv 成功但一条可用都没有：池里可能确有条目（全坏 / 全是外来平台），
        # 用本地扫描复核一次，避免"有池却报空"。
        scanned = _scan_pool_directory(discovered_at)
        if scanned:
            logger.warning(
                'interpreters: uv listed no usable interpreter but a local pool scan '
                'found %d — using the scan result', len(scanned),
            )
            return scanned
    return usable


def discover_installed(*, timeout: float = DISCOVERY_TIMEOUT_SECONDS) -> list[InterpreterInfo]:
    """缓存池内已安装解释器清单（带 TTL 缓存，NFR-10）。

    * 心跳（30s 间隔）命中缓存，不 spawn uv；
    * 单条损坏只剔除该项（AC-14b）；
    * 整体失败返回 `[]` + 日志，**绝不抛出**（执行器必须仍能启动）。
    """
    global _discovery_cache
    # B-4（SEC-NEW）：池权限加固（0o755 + owner 校验），发现路径与下载路径
    # 共用同一入口，确保任何一次池访问前目录可写面已收敛。
    harden_pool_permissions()
    now = time.monotonic()
    cached = _discovery_cache
    if cached is not None and (now - cached[0]) < DISCOVERY_CACHE_TTL_SECONDS:
        return list(cached[1])
    with _discovery_guard:
        # double-checked：并发探测只跑一次 uv
        cached = _discovery_cache
        if cached is not None and (time.monotonic() - cached[0]) < DISCOVERY_CACHE_TTL_SECONDS:
            return list(cached[1])
        entries = _discover_uncached(timeout)
        _discovery_cache = (time.monotonic(), entries)
        return list(entries)


def invalidate_cache() -> None:
    """清空探测缓存（下载/回收/维护后调用）。"""
    global _discovery_cache
    with _discovery_guard:
        _discovery_cache = None


def pool_summary() -> dict:
    """`{'install_dir': str, 'versions': [str, ...], 'integrity_unverified': [str, ...]}`
    —— FR-12 留痕用。

    只读缓存池**目录**（不 spawn uv）：留痕发生在失败路径上，不能因为留痕再
    引入一次可能同样失败/耗时的 uv 调用。版本来自目录名 `cpython-<ver>-…`，
    与 uv 自己的命名约定一致（CONTRACT.md §0）。

    F-2（SEC-NEW）：``integrity_unverified`` 列出未配置 SHA-256 pin 的版本——
    运维可据此发现「只做了可执行+版本号抽查、未做哈希比对」的版本并补 pin。
    该键**始终存在**（无未验证版本时为空列表）——schema 确定性便于消费方
    （心跳上报/测试）做精确断言，不随运行历史漂移。
    """
    root = pool_root()
    versions: list[str] = []
    try:
        if root.is_dir():
            for child in sorted(root.iterdir(), key=lambda p: p.name):
                if not child.is_dir():
                    continue
                match = _POOL_DIR_RE.match(child.name)
                if match:
                    versions.append(match.group(1))
    except OSError as exc:  # pragma: no cover - 池目录不可读时如实留痕
        logger.warning('interpreters: cannot enumerate pool %s: %s', root, exc)
    return {
        'install_dir': str(root),
        'versions': versions,
        'integrity_unverified': integrity_unverified_versions(),
    }


# ---------------------------------------------------------------------------
# 池内路径解析（NFR-02 白名单）
# ---------------------------------------------------------------------------

def _resolve_within_pool(path: Path) -> Path | None:
    """把 `path` 规范化后断言仍在池内；越界返回 None（不抛，调用方决定语义）。

    `Path.resolve()` 之后用 `is_relative_to` 判定——符号链接逃逸同样被拦。
    """
    try:
        root = pool_root().resolve()
    except OSError:  # pragma: no cover - 池根不可解析
        return None
    try:
        resolved = path.resolve()
    except OSError:  # pragma: no cover - 断链/竞态
        return None
    if resolved == root:
        return None
    if not resolved.is_relative_to(root):
        return None
    return resolved


def _resolve_python_bin_uncached(version: str) -> Path | None:
    """在池内做前缀匹配（D1）并做白名单断言（NFR-02）。"""
    root = pool_root()
    if not root.is_dir():
        return None
    for entry in discover_installed():
        if not _matches_prefix(entry.version, version):
            continue
        candidate = Path(entry.path)
        resolved = _resolve_within_pool(candidate)
        if resolved is None:
            # 探测结果指向池外（伪造/符号链接逃逸）——剔除，绝不返回。
            logger.warning(
                'interpreters: refusing pool-external interpreter path %s (NFR-02)', entry.path,
            )
            continue
        if not resolved.is_file() or not _is_executable(resolved):
            continue
        return resolved
    return None


def resolve_python_bin(version: str) -> Path | None:
    """任务声明版本 → 池内解释器绝对路径；无命中返回 None。

    * 前缀匹配语义见 CONTRACT.md §1.2（`"3.1"` 不匹配 `"3.13.0"`）；
    * 返回值**必然**位于 `UV_PYTHON_INSTALL_DIR` 之内（NFR-02 断言）；
    * 非法版本抛 ``ValueError``。
    """
    validate_version(version)
    return _resolve_python_bin_uncached(version)


# ---------------------------------------------------------------------------
# 并发互斥（D13 / NFR-16）
# ---------------------------------------------------------------------------

# per-version 锁：version -> threading.Lock，原子 fetch-or-create
# （对照 routers/execute.py 的 _get_git_cache_lock）。用 threading.Lock 而非
# asyncio.Lock 的理由同 execute.py：threading.Lock 与事件循环无关，可在
# asyncio.to_thread 的工作线程里安全获取。
_version_locks: dict[str, threading.Lock] = {}
_version_locks_guard = threading.Lock()


def _get_version_lock(version: str) -> threading.Lock:
    """Atomically fetch-or-create the per-version download lock."""
    with _version_locks_guard:
        lock = _version_locks.get(version)
        if lock is None:
            lock = threading.Lock()
            _version_locks[version] = lock
        return lock


# 全局有界下载槽（D13/NFR-16）：asyncio.Semaphore(settings.interpreter_download_
# concurrency，默认 2)。按事件循环分桶——asyncio 原语绑定第一次 await 它的
# 循环，测试套件每个用例一个新循环（对照 _get_task_lock）。不同版本写池内
# 不同目录，uv 的"同目录并发写不安全"不跨版本；同版本由 per-version 锁去重。
_semaphores: dict[int, asyncio.Semaphore] = {}
_semaphores_guard = threading.Lock()


def _download_concurrency() -> int:
    """读取下载并发（settings 可热更）；钳到 [1, 8]，非法回落默认 2。"""
    try:
        raw = int(getattr(settings, 'interpreter_download_concurrency', 2) or 2)
    except (TypeError, ValueError):
        return 2
    return max(1, min(raw, 8))


def _get_download_semaphore() -> asyncio.Semaphore:
    """当前事件循环的全局下载信号量（必须在事件循环线程调用）。

    并发值在**创建时**快照（Semaphore 值创建后不可变）；配置热更后新事件
    循环才生效——与 node 侧 `withDownloadSlot` 的动态读取略有差异，但生产
    中执行器只跑一个事件循环、配置在启动时确定，行为等价。
    """
    loop = asyncio.get_running_loop()
    with _semaphores_guard:
        semaphore = _semaphores.get(id(loop))
        if semaphore is None:
            semaphore = asyncio.Semaphore(_download_concurrency())
            _semaphores[id(loop)] = semaphore
        return semaphore


def _reset_semaphores() -> None:
    """测试辅助：丢弃所有已绑定循环的信号量（生产不需要调用）。"""
    with _semaphores_guard:
        _semaphores.clear()


# ---------------------------------------------------------------------------
# 下载（FR-07/13/15、NFR-13/14/16、D11/D13）
# ---------------------------------------------------------------------------

def _not_downloadable_detail(version: str) -> str:
    """3.7/3.6 的离线预填指引（CONTRACT.md §0.1 语义定稿 + §2.5 模式 B）。

    平台三元组纪律（实测踩坑，勿改）：目录名必须用 **uv 自己的平台词汇**，
    不能用 python-build-standalone 的发布三元组。二者不同名，且 uv 对不匹配的
    目录名**静默忽略**（不报错、只是不出现在 `--only-installed` 里），操作员按
    pbs 三元组命名会得到"文件都放对了但执行器始终探测不到"的无解症状。
      实测（uv 0.8.17 + 0.11.14 双版本一致）：
        * `cpython-3.7.9-x86_64-pc-windows-msvc-none` → 不被识别；
          `cpython-3.7.9-windows-x86_64-none`          → 识别，`uv venv --python 3.7` 成功。
        * uv 的 Linux 词汇是 `linux-x86_64-gnu` / `linux-x86_64-musl`
          （非 `x86_64-unknown-linux-gnu`），macOS 是 `macos-x86_64-none`。

    **不要再补 `-none`**（第二个实测坑）：目录名全形是
    `cpython-<完整版本>-<uv三元组>`，三元组**整段照抄**。
    Windows/macOS 的三元组本身就以 `-none` 结尾（那是 libc 槽位取值，不是后缀），
    Linux 的是 `gnu`/`musl`——所以 Linux 再加 `-none` 就错了：
      * `cpython-3.7.9-linux-x86_64-gnu`       → 正确；
      * `cpython-3.7.9-linux-x86_64-gnu-none`  → 错（实测 `uv python install
        cpython-3.11-linux-x86_64-gnu-none` 直接报
        `is not a valid Python download request`；手工放目录则被静默忽略）。
    """
    return (
        f'Python {version} 不支持在线下载（uv 0.8.17 的在线可下载区间为 '
        f'{ONLINE_DOWNLOAD_MIN}~3.14；`uv python install {version}` 会以 '
        f'"No download found for request: cpython-{version}-<platform>" 失败），'
        f'需部署方离线预填解释器缓存卷：把 python-build-standalone 的 '
        f'{version}.x 产物（如 3.7 用 3.7.9）的 `python/install/*` 内容放入 '
        f'`{pool_root()}/cpython-{version}.x-<uv平台三元组>/`'
        f'（命名约定 `cpython-<完整版本>-<uv平台三元组>`，**三元组后不要再加 '
        f'`-none`**）。'
        f'**注意三元组必须用 uv 的词汇而非 pbs 的发布名**：Linux 为 '
        f'`linux-x86_64-gnu`（非 `x86_64-unknown-linux-gnu`）、'
        f'`linux-x86_64-musl`，Windows 为 `windows-x86_64-none`'
        f'（非 `x86_64-pc-windows-msvc`），macOS 为 `macos-x86_64-none`。'
        f'注意 Windows/macOS 三元组本身以 `-none` 结尾（那是 libc 槽位），'
        f'而 Linux 的是 `gnu`/`musl`——照抄三元组即可，凭感觉补 `-none` 会让 '
        f'uv 静默忽略该目录。'
        f'可先用 `uv python list --all-versions --all-platforms` 查实际词汇；'
        f'放好后 `uv python list --only-installed` 即应列出该版本，'
        f'执行器启动探测亦会识别。'
    )


def _build_install_args(version: str) -> list[str]:
    """构造 `uv python install` argv（version 已在调用方过白）。"""
    args = [UV_BIN, 'python', 'install', version]
    mirror = (settings.uv_python_install_mirror or '').strip()
    if mirror:
        # D9/NFR-14：显式 --mirror 与 UV_PYTHON_INSTALL_MIRROR 双通道，
        # 任一生效即走内网源。
        args.extend(['--mirror', mirror])
    return args


def _verify_installed(version: str) -> Path:
    """下载后产物校验：池内存在 + 可执行 + `--version` 输出主.次匹配 + SHA-256。

    任一环节失败 → 抛 ``InterpreterUnavailable('corrupt')``；调用方负责删除
    损坏目录并 `invalidate_cache()`（DESIGN.md §2.1.3-① 的 verify 分支）。

    F-2（SEC-NEW）：当 ``settings.uv_python_sha256_pins`` 为该版本配置了 pin 时，
    对池内 python 二进制计算 SHA-256 并 **constant-time** 比对——不匹配即判定
    corrupt，**绝不运行**（防"报告正确版本但含后门"的镜像/中间人注入）。未配置
    pin 的版本保留原有「可执行 + 版本号」抽查，并记录到 integrity_unverified
    （pool_summary 留痕 + 一次性 warn），由部署方在可信安装后补 pin。
    """
    resolved = _resolve_python_bin_uncached(version)
    if resolved is None:
        raise InterpreterUnavailable(
            version, 'corrupt',
            f'`uv python install {version}` reported success but no executable '
            f'interpreter was found inside the pool {pool_root()}',
        )
    try:
        code, out = _run_uv_sync(
            [str(resolved), '--version'], _VERIFY_TIMEOUT_SECONDS, env=build_uv_env(),
        )
    except subprocess.TimeoutExpired as exc:
        raise InterpreterUnavailable(
            version, 'corrupt',
            f'interpreter {resolved} did not answer `--version` within '
            f'{_VERIFY_TIMEOUT_SECONDS}s',
        ) from exc
    except Exception as exc:  # noqa: BLE001 - 产物不可执行一律视为损坏
        raise InterpreterUnavailable(
            version, 'corrupt', f'interpreter {resolved} is not runnable: {exc}',
        ) from exc
    if code != 0:
        raise InterpreterUnavailable(
            version, 'corrupt',
            f'interpreter {resolved} exited {code} for `--version`: {_tail(out)}',
        )
    match = _VERSION_TOKEN_RE.search(out or '')
    reported = match.group(1) if match else ''
    if not _matches_prefix(reported, version):
        raise InterpreterUnavailable(
            version, 'corrupt',
            f'interpreter {resolved} reports Python {reported or "?"} '
            f'(expected {version}.x): {_tail(out)}',
        )
    # F-2: SHA-256 pin 校验（constant-time 比对，不匹配 → corrupt，绝不运行）。
    pin = (settings.uv_python_sha256_pins or {}).get(version)
    if pin:
        actual = _sha256_of(resolved)
        expected = pin.lower()
        if not _constant_time_eq(actual, expected):
            raise InterpreterUnavailable(
                version, 'corrupt',
                f'interpreter {resolved} SHA-256 {actual} does not match the '
                f'configured pin for Python {version} — refusing to run a '
                f'possibly tampered interpreter (uv_python_sha256_pins)',
            )
    else:
        _mark_integrity_unverified(version)
    return resolved


def _constant_time_eq(left: str, right: str) -> bool:
    """长度恒定的字符串比较（防时序侧信道推断 pin 前缀）。"""
    if len(left) != len(right):
        return False
    result = 0
    for a, b in zip(left, right):
        result |= ord(a) ^ ord(b)
    return result == 0


def record_sha256_pin(version: str) -> str:
    """运维辅助：为池内已安装版本生成 SHA-256 pin（F-2）。

    首次从**可信源**完成安装后调用，把返回的 hex 写入配置
    （`UV_PYTHON_SHA256_PINS='{"<ver>":"<hex>"}'` 或
    `UV_PYTHON_SHA256_<MAJ>_<MIN>=<hex>`），此后每次在线下载都会做哈希比对。
    池内无该版本 / 不可执行 → 抛 InterpreterUnavailable。
    """
    resolved = _resolve_python_bin_uncached(version)
    if resolved is None:
        raise InterpreterUnavailable(
            version, 'corrupt',
            f'cannot pin Python {version}: no executable interpreter in pool {pool_root()}',
        )
    digest = _sha256_of(resolved)
    logger.info(
        'interpreters: SHA-256 pin for Python %s (%s): %s — add '
        'UV_PYTHON_SHA256_%s_%s=%s to the executor environment to enforce checksums',
        version, resolved, digest, version.split('.')[0], version.split('.')[1], digest,
    )
    return digest


def _classify_install_failure(version: str, code: int, output: str) -> InterpreterUnavailable:
    """把 `uv python install` 的非零退出归类。

    默认 ``download_failed``（CONTRACT.md §3.2：非零退出即下载失败，detail 携带
    uv 的 stderr）。仅当**显式配置了内网镜像**且 uv 的报错是连接/DNS 类时，才
    细分为 ``mirror_unreachable``——这是 D9/NFR-14 私有化模式下最需要运维立刻
    分辨的一类失败（AC-08a"下载源不可达"），未配置镜像时不会误报该分因。
    """
    lowered = (output or '').lower()
    tail = _tail(output)
    mirror = (settings.uv_python_install_mirror or '').strip()
    if mirror and re.search(
        r'connection refused|connection reset|failed to connect|dns error'
        r'|name or service not known|timed? ?out|network is unreachable'
        r'|certificate|tls handshake',
        lowered,
    ):
        return InterpreterUnavailable(
            version, 'mirror_unreachable',
            f'`uv python install {version}` could not reach the configured mirror '
            f'{mirror} (exit {code}): {tail}',
        )
    if code == _UV_NOT_FOUND_EXIT_CODE and (
        'no download found' in lowered or 'no interpreter found' in lowered
    ):
        # 在线区间内却"无下载"：镜像未同步该版本 / 下载索引不可达（分因仍是
        # download_failed，detail 里点明排查方向）。
        return InterpreterUnavailable(
            version, 'download_failed',
            f'`uv python install {version}` found no downloadable build (exit {code}); '
            f'check the configured mirror / download index: {tail}',
        )
    return InterpreterUnavailable(
        version, 'download_failed',
        f'`uv python install {version}` exited {code}: {tail}',
    )


def _ensure_version_locked(version: str, timeout: float) -> Path:
    """per-version 锁内的下载核心（调用方不持有全局信号量）。"""
    # B-4（SEC-NEW）：下载前确保池目录权限已收敛（防同机其他进程在下载
    # 窗口内向池内注入伪造解释器目录）。
    harden_pool_permissions()
    # double-checked：等待者拿到锁时下载方可能已经完成（AC-16b/EG-06）。
    cached = resolve_python_bin(version)
    if cached is not None:
        return cached

    env = build_uv_env(cache_dir=pool_root() / '.uv-cache')
    args = _build_install_args(version)
    logger.info(
        'interpreters: downloading Python %s via `%s` (mirror=%s)',
        version, ' '.join(args), settings.uv_python_install_mirror or '<default>',
    )
    try:
        code, out = _run_uv_sync(args, timeout, env=env)
    except subprocess.TimeoutExpired as exc:
        raise InterpreterUnavailable(
            version, 'download_timeout',
            f'`uv python install {version}` timed out after {timeout}s '
            f'(uv process killed)',
        ) from exc
    except Exception as exc:  # noqa: BLE001
        if _is_uv_missing_error(exc):
            raise InterpreterUnavailable(
                version, 'uv_missing',
                f'uv binary {UV_BIN!r} is not executable; install uv into the '
                f'executor image (or set UV_BIN to a bundled copy)',
            ) from exc
        raise InterpreterUnavailable(
            version, 'download_failed',
            f'could not start `uv python install {version}`: {exc}',
        ) from exc

    if code != 0:
        raise _classify_install_failure(version, code, out)

    # 池内容已变化：先失效探测缓存，否则 `_verify_installed` 会读到下载前那份
    # 空清单并把刚装好的解释器误判为 corrupt。
    invalidate_cache()
    try:
        resolved = _verify_installed(version)
    except InterpreterUnavailable as exc:
        # 损坏产物必须清出池子，否则下一次 resolve 会命中它（AC-14b）。
        _remove_pool_version_dir(version)
        invalidate_cache()
        raise exc
    invalidate_cache()
    logger.info('interpreters: Python %s ready at %s', version, resolved)
    return resolved


def ensure_version(version: str, *, timeout: float) -> Path:
    """确保池内存在该版本解释器并返回其绝对路径（CONTRACT.md §3.2）。

    同步签名（冻结）。**async 调用方必须用 `ensure_version_async`**——直接调用
    本函数会阻塞事件循环。

    流程（DESIGN.md §2.1.3-①）：缓存命中短路 → 不可在线下载且池内无 → 明确失败
    → per-version 锁 → 锁内重查缓存 → `uv python install` → 产物校验 → 失效缓存。
    """
    validate_version(version)
    cached = resolve_python_bin(version)
    if cached is not None:
        return cached
    _raise_if_not_downloadable(version)
    lock = _get_version_lock(version)
    with lock:
        return _ensure_version_locked(version, timeout)


async def ensure_version_async(version: str, *, timeout: float) -> Path:
    """`ensure_version` 的 async 入口（WS4 在 `run_task` 里用这个）。

    并发语义（D13/NFR-16）：

    * 全局有界下载 `asyncio.Semaphore(N)`（N = interpreter_download_concurrency，
      默认 2）在**事件循环**上获取——等待者让出循环，心跳/其他任务不被阻塞；
    * 拿到槽位后，per-version 锁与子进程工作整体 `asyncio.to_thread` 到工作
      线程执行——事件循环上**不**出现 `threading.Lock` 阻塞；
    * 同一版本的 N 个并发调用：第一个下载，其余在线程锁上排队，拿到锁后走
      缓存命中复用（`_ensure_version_locked` 的 double-check），`uv python
      install` 恰好执行一次（EG-06）。

    缓存命中/明确失败（不可在线下载、越界）**不占用**全局下载槽。
    """
    validate_version(version)
    cached = resolve_python_bin(version)
    if cached is not None:
        return cached
    _raise_if_not_downloadable(version)
    semaphore = _get_download_semaphore()
    async with semaphore:
        return await asyncio.to_thread(ensure_version, version, timeout=timeout)
