"""任务 zip 包的结构审查与安全解压（FR-03、NFR-04、AC-03a/AC-03b）。

两侧执行器强度对齐（NFR-04/AC-03b）：上限常量**镜像**
`apps/executor-node/src/zip-guard.ts` 的 `ZIP_GUARD_DEFAULT_LIMITS`，并额外接受
该模块读取的环境变量名（`ZIP_MAX_*`），使同一份部署配置在两个执行器上等价。

镜像来源（zip-guard.ts:19-31,49-55,80-85）
-----------------------------------------
===========================  ==========================  ====================
本模块                        zip-guard.ts                值
===========================  ==========================  ====================
`max_ratio`                   `maxRatio`                  100
`max_entries`                 `maxEntries`                10 000
`max_file_bytes`              `maxFileBytes`              1 GiB
`max_total_uncompressed_bytes` `maxTotalUncompressedBytes` 2 GiB
`max_nesting_depth`           `maxNestingDepth`           1
===========================  ==========================  ====================

违规名映射（本模块 → node）：`too_many_entries`→`too_many_entries`、
`entry_too_large`→`single_file_too_large`、
`total_too_large`→`total_uncompressed_exceeded`、
`ratio_too_high`→`ratio_exceeded`、`bad_archive`→`unparseable`、
`nested_zip_too_deep`→`nested_zip_too_deep`；此外 python 侧新增 zip-slip 三类
（`zip_slip` / `absolute_path` / `symlink_entry`），因为本模块**自己解压**
（node 侧的解压由 Expand-Archive/unzip 承担，zip-guard 只做结构审查）。

嵌套包：与 node 的 `maxNestingDepth`（默认 1）**逐字对齐**——急切复审
`max_nesting_depth` 层嵌套 zip（每层按同一套上限复审），更深的层级不急切复审
（其声明尺寸仍全额计入各层父包的总量/压缩比红线），仅当深度达到
`MAX_NESTING_DEPTH_CEILING`（16，node 同值）时才 fail-closed 抛
`nested_zip_too_deep`。为避免把超大内层包读进内存，声明尺寸超过
`NESTED_PROBE_MAX_BYTES` 的嵌套成员不做急切探测。

解压路径穿越（AC-03a）
---------------------
三层，任何一层失败即中止并清理已写出的部分产物：

1. **名称闸门**：拒绝绝对路径（`/x`、`C:\\x`、`\\\\server\\share`）、UNC、驱动器
   相对路径（`C:x`）、任何 `..` 路径段、符号链接/硬链接条目；
2. **解析闸门**：每个条目的目标路径 `Path.resolve()` 后必须 `is_relative_to(dest)`——
   这才是真正的 zip-slip 防线（字符串检查可被 `a/../../b`、符号链接、大小写/
   分隔符差异绕过）；
3. **流式限额**：逐块累加实际写出的字节数，超过单文件/总解压上限立即中止——
   central directory 里声明的尺寸是元数据，**不可信**。

注意 `safe_extract` 先对**整个包**做一次 `vet_zip` 才写出任何字节（默认安全），
因此声明的炸弹包在解压前即被拒。
"""
from __future__ import annotations

import io
import logging
import os
import re
import stat
import zipfile
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

_MIB = 1024 * 1024
_GIB = 1024 * 1024 * 1024

# 流式解压的读块大小（限额按实际写出的字节累加，与声明值无关）。
_CHUNK_SIZE = 64 * 1024

# 嵌套 zip 急切探测的读入上限：只有**声明**解压后大小 ≤ 该值的嵌套成员才会被读进
# 内存复审（防"用 200MB 内层包把执行器读爆"）。超过者不做急切探测，其声明尺寸
# 仍全额计入父包的总量/压缩比红线。
NESTED_PROBE_MAX_BYTES = 64 * _MIB

# `ZIP_MAX_NESTING_DEPTH` 上限（与 zip-guard.ts 的 16 同源）：超过即 fail-closed。
MAX_NESTING_DEPTH_CEILING = 16


class ZipSafetyError(ValueError):
    """zip 包未通过安全审查 / 解压越界。

    ``violation`` 取值（CONTRACT.md §3.2）：
    ``zip_slip`` | ``absolute_path`` | ``symlink_entry`` | ``too_many_entries`` |
    ``entry_too_large`` | ``total_too_large`` | ``ratio_too_high`` |
    ``nested_zip_too_deep`` | ``bad_archive``。
    """

    def __init__(self, violation: str, detail: str):
        self.violation = violation
        self.detail = detail
        super().__init__(f'[{violation}] {detail}')


@dataclass(frozen=True)
class ZipLimits:
    """结构审查上限——默认值镜像 zip-guard.ts 的 `ZIP_GUARD_DEFAULT_LIMITS`。"""

    max_ratio: float = 100
    max_entries: int = 10_000
    max_file_bytes: int = 1 * _GIB
    max_total_uncompressed_bytes: int = 2 * _GIB
    max_nesting_depth: int = 1


ZIP_GUARD_DEFAULT_LIMITS = ZipLimits()

# 与 zip-guard.ts `getZipGuardLimitsFromEnv` 同名的环境变量（可选用；未设置时
# 用默认值）。python 执行器不从 env 读这些值构造默认 ZipLimits —— 默认必须是
# 常量，避免"宿主环境悄悄放宽安全上限"；该映射表供部署方与 node 侧对齐配置时
# 显式构造 ZipLimits（见 tests/test_zip_safety.py）。
ZIP_LIMIT_ENV_VARS = {
    'max_ratio': 'ZIP_MAX_RATIO',
    'max_entries': 'ZIP_MAX_ENTRIES',
    'max_file_bytes': 'ZIP_MAX_FILE_BYTES',
    'max_total_uncompressed_bytes': 'ZIP_MAX_TOTAL_BYTES',
    'max_nesting_depth': 'ZIP_MAX_NESTING_DEPTH',
}


def get_zip_limits_from_env(env: 'os._Environ | dict | None' = None) -> ZipLimits:
    """按 zip-guard.ts 的环境变量名构造上限（非法/缺省 → 默认值，同 node 语义）。"""
    source = os.environ if env is None else env

    def _num(name: str, default):
        raw = source.get(name)
        try:
            value = int(str(raw), 10)
        except (TypeError, ValueError):
            return default
        return value if value > 0 else default

    defaults = ZIP_GUARD_DEFAULT_LIMITS
    raw_depth = source.get(ZIP_LIMIT_ENV_VARS['max_nesting_depth'])
    try:
        depth = int(str(raw_depth), 10)
    except (TypeError, ValueError):
        depth = defaults.max_nesting_depth
    if depth < 0:
        depth = defaults.max_nesting_depth
    return ZipLimits(
        max_ratio=_num(ZIP_LIMIT_ENV_VARS['max_ratio'], defaults.max_ratio),
        max_entries=_num(ZIP_LIMIT_ENV_VARS['max_entries'], defaults.max_entries),
        max_file_bytes=_num(ZIP_LIMIT_ENV_VARS['max_file_bytes'], defaults.max_file_bytes),
        max_total_uncompressed_bytes=_num(
            ZIP_LIMIT_ENV_VARS['max_total_uncompressed_bytes'],
            defaults.max_total_uncompressed_bytes,
        ),
        max_nesting_depth=depth,
    )


# ---------------------------------------------------------------------------
# 条目名校验
# ---------------------------------------------------------------------------

_WINDOWS_DRIVE_RE = re.compile(r'^[A-Za-z]:')


def _normalize_entry_name(name: str) -> str:
    """zip 条目名分隔符统一为 `/`（zip 规范固定用 `/`，但防御性兼容 `\\`）。"""
    return name.replace('\\', '/')


def _reject_absolute_or_escaping(name: str) -> None:
    """名称闸门（AC-03a 第一层）。

    拒绝：POSIX 绝对路径、Windows 盘符路径（`C:\\`、`C:/`）、驱动器相对路径
    （`C:evil`）、UNC 路径（`\\\\server\\share`）、任何 `..` 路径段。
    """
    raw = name
    normalized = _normalize_entry_name(name)
    if raw.startswith('/') or raw.startswith('\\'):
        raise ZipSafetyError('absolute_path', f'archive entry uses an absolute path: {raw!r}')
    if _WINDOWS_DRIVE_RE.match(raw):
        raise ZipSafetyError('absolute_path', f'archive entry uses a drive path: {raw!r}')
    if normalized.startswith('//'):
        raise ZipSafetyError('absolute_path', f'archive entry uses a UNC path: {raw!r}')
    parts = [part for part in normalized.split('/') if part not in ('', '.')]
    if any(part == '..' for part in parts):
        raise ZipSafetyError('zip_slip', f'archive entry escapes the target directory: {raw!r}')


def _entry_is_symlink(info: zipfile.ZipInfo) -> bool:
    """Unix 模式位判定符号链接（zip 外置属性高 16 位为 st_mode）。"""
    mode = info.external_attr >> 16
    return stat.S_ISLNK(mode)


# ---------------------------------------------------------------------------
# 结构审查
# ---------------------------------------------------------------------------

def vet_zip(path: Path, *, limits: ZipLimits | None = None) -> None:
    """结构审查（zip-bomb 防线 + 名称闸门）；违规抛 `ZipSafetyError`。

    检查顺序与 zip-guard.ts 的 `assertZipSafe` 一致：逐条目名称/链接闸门 →
    条数 → 总解压量 → 压缩比 → 单文件声明尺寸；随后急切复审一层嵌套 zip。
    """
    limits = limits or ZIP_GUARD_DEFAULT_LIMITS
    try:
        with zipfile.ZipFile(Path(path)) as archive:
            _vet_open_archive(archive, limits)
    except zipfile.BadZipFile as exc:
        raise ZipSafetyError('bad_archive', f'not a readable zip archive: {exc}') from exc
    except OSError as exc:
        raise ZipSafetyError('bad_archive', f'cannot read archive {path}: {exc}') from exc


def _vet_open_archive(archive: zipfile.ZipFile, limits: ZipLimits, depth: int = 0) -> None:
    infos = archive.infolist()
    if len(infos) > limits.max_entries:
        raise ZipSafetyError(
            'too_many_entries',
            f'zip declares {len(infos)} entries (limit {limits.max_entries})',
        )
    total_uncompressed = 0
    total_compressed = 0
    for info in infos:
        if _entry_is_symlink(info):
            raise ZipSafetyError(
                'symlink_entry', f'archive entry is a symbolic link: {info.filename!r}',
            )
        _reject_absolute_or_escaping(info.filename)
        total_uncompressed += info.file_size
        total_compressed += info.compress_size
    if total_uncompressed > limits.max_total_uncompressed_bytes:
        raise ZipSafetyError(
            'total_too_large',
            f'zip declares {total_uncompressed} uncompressed bytes '
            f'(limit {limits.max_total_uncompressed_bytes})',
        )
    if total_compressed > 0 and total_uncompressed / total_compressed > limits.max_ratio:
        raise ZipSafetyError(
            'ratio_too_high',
            f'compression ratio {total_uncompressed / total_compressed:.1f} '
            f'exceeds limit {limits.max_ratio}',
        )
    for info in infos:
        if info.file_size > limits.max_file_bytes:
            raise ZipSafetyError(
                'entry_too_large',
                f'zip declares an entry of {info.file_size} uncompressed bytes '
                f'(limit {limits.max_file_bytes})',
            )
    _vet_nested_archives(archive, infos, limits, depth)


def _vet_nested_archives(
    archive: zipfile.ZipFile, infos: list, limits: ZipLimits, depth: int
) -> None:
    """急切复审嵌套 zip（对照 zip-guard.ts 的 `maxNestingDepth` 语义）。

    默认深度 1 = 复审一层；更深的层级不急切复审（与 node 一致：成员声明尺寸已
    计入父包红线，各自解压时再由同一套规则复审）。仅当深度触到
    `MAX_NESTING_DEPTH_CEILING` 且仍有嵌套时 fail-closed。

    不可解析的嵌套成员 → `bad_archive`（"审不了的包就不解"，与 node 的
    `unparseable` 同姿态）。
    """
    nested = [info for info in infos if info.filename.lower().endswith('.zip') and not info.is_dir()]
    if not nested:
        return
    if depth >= MAX_NESTING_DEPTH_CEILING:
        raise ZipSafetyError(
            'nested_zip_too_deep',
            f'zip nesting reached the eager-vetting ceiling of '
            f'{MAX_NESTING_DEPTH_CEILING} levels and still contains nested archives',
        )
    if depth >= limits.max_nesting_depth:
        return
    for info in nested:
        if info.file_size > NESTED_PROBE_MAX_BYTES:
            # 太大不读进内存：声明尺寸已计入父包红线（见模块 docstring）。
            logger.warning(
                'zip_safety: skipping eager vet of nested zip %r (declared %d bytes '
                '> probe cap %d)', info.filename, info.file_size, NESTED_PROBE_MAX_BYTES,
            )
            continue
        try:
            with archive.open(info) as source:
                payload = source.read(NESTED_PROBE_MAX_BYTES + 1)
        except Exception as exc:  # noqa: BLE001 - 读不出内容即无法审查 → fail closed
            raise ZipSafetyError(
                'bad_archive',
                f'nested zip {info.filename!r} could not be read for vetting: {exc}',
            ) from exc
        try:
            with zipfile.ZipFile(io.BytesIO(payload)) as inner:
                _vet_open_archive(inner, limits, depth + 1)
        except zipfile.BadZipFile as exc:
            raise ZipSafetyError(
                'bad_archive',
                f'nested zip {info.filename!r} is corrupt or unreadable: {exc}',
            ) from exc


# ---------------------------------------------------------------------------
# 安全解压
# ---------------------------------------------------------------------------

def _resolve_within_dest(dest_root: Path, target: Path) -> Path:
    """解析闸门（AC-03a 第二层）：目标路径 resolve 后必须仍在 `dest_root` 内。"""
    try:
        resolved = target.resolve()
    except OSError as exc:  # pragma: no cover - 断链/竞态
        raise ZipSafetyError('zip_slip', f'cannot resolve extraction target {target}: {exc}') from exc
    if resolved != dest_root and not resolved.is_relative_to(dest_root):
        raise ZipSafetyError(
            'zip_slip',
            f'archive entry resolves outside the extraction root: {target} -> {resolved}',
        )
    return resolved


def safe_extract(path: Path, dest: Path, *, limits: ZipLimits | None = None) -> None:
    """把 zip 解压到 `dest`，全程强制安全闸门；违规即中止并清理部分产物。

    * 先对整包做 `vet_zip`（默认安全：调用方不必自己先审查）；
    * 逐条目做名称/链接/解析三重闸门；
    * 流式写出并按**实际字节数**执行单文件/总解压限额；
    * 任何失败 → 本次解压**自己创建**的文件/目录全部清除（"解压未产生工作
      目录之外的文件"，AC-03a）；`dest` 里既有的内容（如 `artifacts/`、git
      checkout 结果）绝不误删。
    """
    limits = limits or ZIP_GUARD_DEFAULT_LIMITS
    archive_path = Path(path)
    dest_root = Path(dest)

    # 整包先审查：炸弹包在写出任何字节之前被拒。
    vet_zip(archive_path, limits=limits)

    dest_root.mkdir(parents=True, exist_ok=True)
    resolved_root = dest_root.resolve()
    written_files: list[Path] = []
    created_dirs: list[Path] = []
    total_written = 0

    def _mkdir_chain(directory: Path) -> None:
        """mkdir -p，记录本次真正新建的目录（清理时只删自己建的）。"""
        missing: list[Path] = []
        probe = directory
        while probe != resolved_root and not probe.exists():
            missing.append(probe)
            probe = probe.parent
        directory.mkdir(parents=True, exist_ok=True)
        created_dirs.extend(reversed(missing))

    try:
        with zipfile.ZipFile(archive_path) as archive:
            infos = archive.infolist()
            if len(infos) > limits.max_entries:
                raise ZipSafetyError(
                    'too_many_entries',
                    f'zip declares {len(infos)} entries (limit {limits.max_entries})',
                )
            for info in infos:
                if _entry_is_symlink(info):
                    raise ZipSafetyError(
                        'symlink_entry',
                        f'archive entry is a symbolic link: {info.filename!r}',
                    )
                _reject_absolute_or_escaping(info.filename)
                if info.file_size > limits.max_file_bytes:
                    raise ZipSafetyError(
                        'entry_too_large',
                        f'entry {info.filename!r} declares {info.file_size} bytes '
                        f'(limit {limits.max_file_bytes})',
                    )
                if info.is_dir():
                    directory = _resolve_within_dest(resolved_root, resolved_root / info.filename)
                    _mkdir_chain(directory)
                    continue
                target = _resolve_within_dest(resolved_root, resolved_root / info.filename)
                _mkdir_chain(target.parent)
                written = 0
                with archive.open(info) as source, open(target, 'wb') as sink:
                    written_files.append(target)
                    while True:
                        chunk = source.read(_CHUNK_SIZE)
                        if not chunk:
                            break
                        written += len(chunk)
                        total_written += len(chunk)
                        # 声明值不可信：按实际写出的字节数执行红线（流式中止）。
                        if written > limits.max_file_bytes:
                            raise ZipSafetyError(
                                'entry_too_large',
                                f'entry {info.filename!r} exceeds {limits.max_file_bytes} '
                                f'bytes while extracting',
                            )
                        if total_written > limits.max_total_uncompressed_bytes:
                            raise ZipSafetyError(
                                'total_too_large',
                                f'extraction exceeds {limits.max_total_uncompressed_bytes} '
                                f'total bytes while extracting',
                            )
                        sink.write(chunk)
                # 解压出的文件不可执行：包内代码由解释器显式调用，不给可执行位。
                try:
                    os.chmod(target, 0o644)
                except OSError as exc:  # pragma: no cover - 平台差异
                    logger.warning('zip_safety: chmod failed for %s: %s', target, exc)
    except zipfile.BadZipFile as exc:
        _cleanup_partial(written_files, created_dirs, resolved_root)
        raise ZipSafetyError('bad_archive', f'not a readable zip archive: {exc}') from exc
    except ZipSafetyError:
        _cleanup_partial(written_files, created_dirs, resolved_root)
        raise
    except Exception:
        # 任何非预期失败同样清理，绝不留半成品工作目录。
        _cleanup_partial(written_files, created_dirs, resolved_root)
        raise


def _cleanup_partial(
    written_files: list[Path], created_dirs: list[Path], resolved_root: Path
) -> None:
    """清除本次解压的部分产物。

    只删**本次解压创建**的文件与目录（且解析后必须仍在 `resolved_root` 内），
    目录按深度倒序删除——`dest` 中既有内容不受影响。
    """
    for target in written_files:
        try:
            resolved = target.resolve()
            if resolved != resolved_root and not resolved.is_relative_to(resolved_root):
                logger.warning('zip_safety: refusing to clean external path %s', target)
                continue
            target.unlink(missing_ok=True)
        except OSError as exc:  # pragma: no cover - 清理尽力而为
            logger.warning('zip_safety: cannot remove partial file %s: %s', target, exc)
    for directory in sorted(set(created_dirs), key=lambda p: len(p.parts), reverse=True):
        try:
            resolved = directory.resolve()
            if resolved != resolved_root and not resolved.is_relative_to(resolved_root):
                logger.warning('zip_safety: refusing to clean external dir %s', directory)
                continue
            directory.rmdir()
        except OSError:
            # 非空（既有内容/其他条目）时保留——绝不 rmtree 一个可能含既有数据的目录。
            continue
