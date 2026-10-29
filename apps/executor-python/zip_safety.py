"""任务 zip 包的结构审查与安全解压（FR-03、NFR-04、AC-03a/AC-03b）。

两侧执行器强度对齐（NFR-04/AC-03b）：上限常量**镜像**
`apps/executor-node/src/zip-guard.ts` 的 `ZIP_GUARD_DEFAULT_LIMITS`，并额外接受
同名环境变量（`ZIP_MAX_*`，与 node 的 `getZipGuardLimitsFromEnv` 完全同名）
由 :func:`get_zip_limits_from_env` 求值，生产解压路径（`routers/execute.py` 的
`_extract_package`）与 node 的 `assertZipFileSafe` 同姿态——**每次调用**读环境，
使同一份部署配置在两个执行器上等价。注意"默认常量"与"显式配置"是两件事：
默认值永远不会被宿主环境悄悄放宽（见 `ZIP_LIMIT_ENV_VARS` 注释），只有部署方
显式设置 `ZIP_MAX_*` 才会改变上限（与 node 逐字同义）。

镜像来源（zip-guard.ts:49-58；admin-api zip-guard.util.ts:70-77 同值）
----------------------------------------------------------------------
===========================  ==============================  ====================
本模块                        zip-guard.ts                    值
===========================  ==============================  ====================
`max_ratio`                   `maxRatio`                      100
`max_entries`                 `maxEntries`                    10 000
`max_file_bytes`              `maxFileBytes`                  512 MiB
`max_total_uncompressed_bytes` `maxTotalUncompressedBytes`     1 GiB
`max_nesting_depth`           `maxNestingDepth`               1
===========================  ==============================  ====================

R94-A1（执行面安全审计）：这两条上限曾在 2026-09-23 的 OOM 事故后于 node /
admin-api 侧从 1 GiB / 2 GiB 下调为 512 MiB / 1 GiB，而本模块**没跟上**——
同一份包在 python 执行器通过、在 node 执行器被拒（NFR-04/AC-03b 明令两侧等
强度）。现已对齐；`tests/test_zip_guard_parity.py` 直接读另两个平面的源码常量
做逐项比对，任何一侧再次单独漂移都会红。

违规名映射（本模块 → node）：`too_many_entries`→`too_many_entries`、
`entry_too_large`→`single_file_too_large`、
`total_too_large`→`total_uncompressed_exceeded`、
`ratio_too_high`→`ratio_exceeded`、`bad_archive`→`unparseable`、
`nested_zip_too_deep`→`nested_zip_too_deep`；此外 python 侧新增路径类四类
（`zip_slip` / `absolute_path` / `drive_letter_path` / `symlink_entry`），
因为本模块**自己解压**（node 侧的解压由 Expand-Archive/unzip 承担，zip-guard
只做结构审查）；`drive_letter_path` 与 node `resolveEntryTarget` 同名同义。
`unsupported_method` 两侧同名（node `zip-safety.ts` 的 `inflateEntry`）：node
只用 zlib，解不开 bzip2(12)/lzma(14)，本模块**同样拒绝**以保持强度对齐（见
`_reject_unsupported_method`）。

EXEC-03（第 3 轮并行审计，P2）新增三条 Windows 归一化违规，与 node
`zip-safety.ts` 的 `ZipSafetyViolation` **逐字同名同义**（错误文案也逐字相同）：
`windows_reserved_name` / `windows_trailing_dot_space` / `duplicate_entry`。
归一化规则（大小写折叠 + 逐段尾随点/空格裁剪 + 分隔符归一 + 保留设备名 +
重复目标）两侧是同一套算法，见 `normalize_entry_name_for_win32` 与 node
`normalizeEntryNameForWin32`。

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
   相对路径（`C:x`）、任何 `..` 路径段、符号链接/硬链接条目，以及 EXEC-03 的
   Windows 归一化违规（保留设备名、尾随点/空格、重复目标）；
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
    ``zip_slip`` | ``absolute_path`` | ``drive_letter_path`` | ``symlink_entry`` |
    ``too_many_entries`` | ``entry_too_large`` | ``total_too_large`` |
    ``ratio_too_high`` | ``nested_zip_too_deep`` | ``unsupported_method`` |
    ``bad_archive`` | ``windows_reserved_name`` | ``windows_trailing_dot_space`` |
    ``duplicate_entry``（后三条为 EXEC-03 的 Windows 归一化闸门，与 node
    ``zip-safety.ts:ZipSafetyViolation`` 逐字同名同义）。
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
    # R94-A1：与 node zip-guard.ts:55-56 / admin-api zip-guard.util.ts:73-74 同值
    # （2026-09-23 OOM 事故后的收紧值 512 MiB / 1 GiB。此前这里是 1 GiB / 2 GiB
    # ——python 侧没跟上，同一个包在 python 执行器通过、在 node 执行器被拒。）
    max_file_bytes: int = 512 * _MIB
    max_total_uncompressed_bytes: int = 1 * _GIB
    max_nesting_depth: int = 1


ZIP_GUARD_DEFAULT_LIMITS = ZipLimits()

# 与 zip-guard.ts `getZipGuardLimitsFromEnv` 同名的环境变量（可选用；未设置时
# 用默认值）。**默认 ZipLimits 不从 env 构造** —— 默认必须是常量，避免"宿主
# 环境悄悄放宽安全上限"；显式配置是另一条通道：生产解压路径
# （`routers/execute.py::_extract_package`）每次调用都走
# `get_zip_limits_from_env()`，与 node `assertZipFileSafe` 的
# "disk 路径读 env / 内存路径用常量"分工逐字一致（R94-A1 补齐：此前该函数
# 无人调用，部署方按 `ZIP_MAX_*` 收紧后 python 执行器**静默不生效**）。
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


# ---------------------------------------------------------------------------
# EXEC-03（第 3 轮并行审计，P2）：条目名的 Windows 归一化
#
# 背景：解压结果必须与宿主平台无关。Windows 的落盘语义与 POSIX 有四处差异，
# 任何一处没对齐，同一个 zip 就会「Linux 解出两份内容、Windows 解成一份」，
# 或者「写入成功但文件不存在」：
#
#   ① 保留设备名：`CON` / `NUL` / `AUX` / `PRN` / `COM1..9` / `LPT1..9`（含
#      `CON.txt` 这类带扩展名的形式）在 Win32 上是**设备**而不是文件。
#   ② 尾随点/空格：`a.txt.` 与 `a.txt ` 会被静默裁成 `a.txt`。
#   ③ 大小写不敏感：`A.txt` 与 `a.txt` 是同一个文件，后写覆盖先写。
#   ④ 同目标重复条目：即便同名，解出内容也取决于条目顺序。
#
# 判定策略与 node `zip-safety.ts` 逐条一致：fail-closed 的「拒绝 + 可判定原因」，
# 而不是 warn 后照写（归一化冲突意味着这个包本身自相矛盾）。错误文案
# **逐字**与 node 相同，两端共用同一批 violation 标签：
# ``windows_reserved_name`` / ``windows_trailing_dot_space`` / ``duplicate_entry``。
# ---------------------------------------------------------------------------

#: Windows 保留设备名（小写、不含扩展名）。与 node
#: ``WINDOWS_RESERVED_DEVICE_NAMES`` 逐字一致（两侧各一份是刻意的：运行时互不
#: 依赖；`test_zip_safety.py` / `zip-safety.spec.ts` 各自钉住表内容）。
WINDOWS_RESERVED_DEVICE_NAMES: frozenset[str] = frozenset(
    {'con', 'prn', 'aux', 'nul'}
    | {f'com{i}' for i in range(1, 10)}
    | {f'lpt{i}' for i in range(1, 10)}
)

#: 段分隔符：zip 规范固定用 `/`，但 Windows 工具常混用 `\`。
_ENTRY_SEPARATOR_RE = re.compile(r'[\\/]+')

#: 尾随点/空格（Windows 落盘时静默裁剪）。
_TRAILING_DOT_SPACE_RE = re.compile(r'[. ]+$')


def _split_entry_name(name: str) -> list[str]:
    """按 `/` 与 `\\` 双分隔符切段，丢弃空段与 `.` 段（与 node `splitEntryName` 同）。"""
    return [seg for seg in _ENTRY_SEPARATOR_RE.split(name) if seg not in ('', '.')]


def _strip_trailing_dot_space(segment: str) -> str:
    """逐段裁掉尾随点/空格。

    `..` 段原样保留：它是 `zip_slip` 闸门的判据，归一化绝不能把它悄悄抹成空串
    （那会让 `a/../b` 与 `a/b` 在键上撞车，掩盖真正的逃逸意图）。
    """
    if segment == '..':
        return segment
    return _TRAILING_DOT_SPACE_RE.sub('', segment)


def normalize_entry_name_for_win32(name: str) -> str:
    """归一化键：分隔符归一 → 逐段裁尾随点/空格 → 大小写折叠。

    两个条目的键相同 ⇒ 在 Windows 落盘语义下写到同一个文件。
    与 node ``normalizeEntryNameForWin32`` 同算法（含 `..` 例外）。
    """
    return '/'.join(
        _strip_trailing_dot_space(seg).lower() for seg in _split_entry_name(name)
    )


def _reject_windows_unsafe_name(name: str) -> None:
    """名称闸门（EXEC-03）：逐段拒绝 Windows 保留设备名与尾随点/空格。

    逐段而非整体判定：`pkg/CON.txt`、`dir /x.txt` 里的危险成分在中间段。
    保留名只看 basename 的**主干**（第一个 `.` 之前），故 `aux-data.txt` /
    `console.txt` / `com10.txt` 这类前缀相似项不命中。
    """
    for segment in _split_entry_name(name):
        if segment == '..':
            continue  # 由 _reject_absolute_or_escaping 的 zip_slip 闸门处理
        if segment[-1] in ('.', ' '):
            raise ZipSafetyError(
                'windows_trailing_dot_space',
                f'zip 条目名含有尾随点或空格（Windows 会静默裁剪）：{name}',
            )
        stem = segment.split('.')[0].lower()
        if stem in WINDOWS_RESERVED_DEVICE_NAMES:
            raise ZipSafetyError(
                'windows_reserved_name',
                f'zip 条目使用了 Windows 保留设备名：{name}',
            )


def _reject_duplicate_targets(infos: list) -> None:
    """整包闸门（EXEC-03）：重复/大小写折叠碰撞的目标检测。

    必须是**整包**判定（单条目视角看不出冲突），且在写出任何字节之前调用。
    重复条目在 POSIX 上是"后写覆盖先写"、在 Windows 上是"同名同文件"——两种
    结果都让解出内容取决于条目顺序，不可接受。
    """
    seen: dict[str, str] = {}
    for info in infos:
        key = normalize_entry_name_for_win32(info.filename)
        first = seen.get(key)
        if first is not None:
            raise ZipSafetyError(
                'duplicate_entry',
                f'zip 中存在解压到同一目标的多余条目：{first} 与 {info.filename}'
                f'（归一化后均为 {key}）',
            )
        seen[key] = info.filename


def _reject_nul_in_name(info: zipfile.ZipInfo) -> None:
    """拒绝中央目录名里含 NUL 的条目（与 node `resolveEntryTarget` 同语义）。

    失败模式（改动前）：`zipfile.ZipInfo.__init__` 用 ``_sanitize_filename`` 在
    第一个 NUL 处**截断**名字——``evil.py\\x00.txt`` 于是变成 ``evil.py``，而
    原始名字只留在 ``orig_filename`` 里。本模块此前只检查截断后的
    ``info.filename``，于是这种条目被**静默接受**并按截断名落盘：一个"名字是
    ``evil.py``、扩展名却是 ``.txt``"的错配会绕过按扩展名做的检查，落盘结果与
    包内声明的名字不一致（解压器与调用方看到两个不同的文件名）。截断永远不是
    安全行为——审不了的名字就拒绝。

    必须查 ``orig_filename``：``filename`` 已被截断，NUL 在那里**不可见**。
    """
    if '\x00' in info.orig_filename:
        raise ZipSafetyError(
            'bad_archive',
            f'归档条目名含有 NUL 字节：{info.orig_filename!r}',
        )


def _reject_unsupported_method(info: zipfile.ZipInfo) -> None:
    """拒绝本模块无法校验的压缩方法（与 node `inflateEntry` 同语义）。

    失败模式（改动前）：python 的 ``zipfile`` 原生支持 bzip2(12)/lzma(14)，
    因此本模块接受并解压它们；而 node 侧只用 zlib（仅 stored(0)/deflate(8)），
    对同样的包抛 ``unsupported_method``。同一个包"在 python 执行器上成功、在
    node 执行器上失败"是两侧强度不对齐（NFR-04/AC-03b 要求全对等），且这种
    差异取决于任务被调度到哪个执行器——不可接受。

    对齐方向取**更严**的一侧（fail-closed）：node 无法解开 12/14，若为了对齐而
    让 node"接受"，就只能把未校验的字节落盘（声明尺寸无从验证），那是放宽安全
    边界而不是修 bug。因此 python 侧同样拒绝，并给出与 node 同义的 violation
    （``unsupported_method``）与可操作的提示。

    只在**解压**路径调用：`vet_zip` 与 node 的 `zip-guard` 一样只看中央目录
    声明值，不看压缩方法（node 的 `vetZip` 对 12/14 也是通过的）。
    """
    method = info.compress_type
    if method in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        return
    raise ZipSafetyError(
        'unsupported_method',
        f'条目 {info.filename!r} 使用了压缩方法 {method}，本执行器无法解压它'
        '（仅支持 stored(0) 与 deflate(8)；请用 deflate 重新打包该归档）',
    )


def _reject_absolute_or_escaping(name: str) -> None:
    """名称闸门（AC-03a 第一层）。

    拒绝：POSIX 绝对路径、Windows 盘符路径（`C:\\`、`C:/`）、驱动器相对路径
    （`C:evil`）、UNC 路径（`\\\\server\\share`）、任何 `..` 路径段。
    """
    raw = name
    normalized = _normalize_entry_name(name)
    if raw.startswith('/') or raw.startswith('\\'):
        raise ZipSafetyError('absolute_path', f'归档条目使用了绝对路径：{raw!r}')
    if _WINDOWS_DRIVE_RE.match(raw):
        # 盘符路径（含 `C:\`、`C:/` 与驱动器相对 `C:evil`）必须用**独立标签**
        # `drive_letter_path`，与 node `resolveEntryTarget`（zip-safety.ts:188）
        # 逐字对齐——此前这里归到 absolute_path，同一个包两侧给出不同 violation，
        # 任何按 violation 分流/统计的消费方都会被劈成两份。
        raise ZipSafetyError('drive_letter_path', f'归档条目使用了盘符路径：{raw!r}')
    if normalized.startswith('//'):
        raise ZipSafetyError('absolute_path', f'归档条目使用了 UNC 路径：{raw!r}')
    parts = [part for part in normalized.split('/') if part not in ('', '.')]
    if any(part == '..' for part in parts):
        raise ZipSafetyError('zip_slip', f'归档条目逃出了目标目录：{raw!r}')


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
        raise ZipSafetyError('bad_archive', f'不是可读的 zip 归档：{exc}') from exc
    except OSError as exc:
        raise ZipSafetyError('bad_archive', f'无法读取归档 {path}：{exc}') from exc


def _vet_open_archive(archive: zipfile.ZipFile, limits: ZipLimits, depth: int = 0) -> None:
    infos = archive.infolist()
    if len(infos) > limits.max_entries:
        raise ZipSafetyError(
            'too_many_entries',
            f'zip 声明了 {len(infos)} 个条目（上限 {limits.max_entries}）',
        )
    total_uncompressed = 0
    total_compressed = 0
    for info in infos:
        if _entry_is_symlink(info):
            raise ZipSafetyError(
                'symlink_entry', f'归档条目是符号链接：{info.filename!r}',
            )
        _reject_nul_in_name(info)
        _reject_absolute_or_escaping(info.filename)
        _reject_windows_unsafe_name(info.filename)
        total_uncompressed += info.file_size
        total_compressed += info.compress_size
    # EXEC-03：重复/折叠碰撞是**整包**性质，在尺寸红线之前判定
    # （自相矛盾的包先于"是不是炸弹"被判死，两个结论都成立时取更确定的那个）。
    _reject_duplicate_targets(infos)
    if total_uncompressed > limits.max_total_uncompressed_bytes:
        raise ZipSafetyError(
            'total_too_large',
            f'zip 声明的未压缩总字节数为 {total_uncompressed} '
            f'（上限 {limits.max_total_uncompressed_bytes}）',
        )
    if total_compressed > 0 and total_uncompressed / total_compressed > limits.max_ratio:
        raise ZipSafetyError(
            'ratio_too_high',
            f'压缩比 {total_uncompressed / total_compressed:.1f} '
            f'超过上限 {limits.max_ratio}',
        )
    for info in infos:
        if info.file_size > limits.max_file_bytes:
            raise ZipSafetyError(
                'entry_too_large',
                f'zip 声明某个条目的未压缩大小为 {info.file_size} 字节 '
                f'（上限 {limits.max_file_bytes}）',
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
            f'zip 嵌套层级已达主动审查上限 {MAX_NESTING_DEPTH_CEILING} 层，'
            f'且仍包含嵌套归档',
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
                f'无法读取嵌套 zip {info.filename!r} 以进行安全审查：{exc}',
            ) from exc
        try:
            with zipfile.ZipFile(io.BytesIO(payload)) as inner:
                _vet_open_archive(inner, limits, depth + 1)
        except zipfile.BadZipFile as exc:
            raise ZipSafetyError(
                'bad_archive',
                f'嵌套 zip {info.filename!r} 已损坏或不可读：{exc}',
            ) from exc


# ---------------------------------------------------------------------------
# 安全解压
# ---------------------------------------------------------------------------

def _resolve_within_dest(dest_root: Path, target: Path) -> Path:
    """解析闸门（AC-03a 第二层）：目标路径 resolve 后必须仍在 `dest_root` 内。"""
    try:
        resolved = target.resolve()
    except OSError as exc:  # pragma: no cover - 断链/竞态
        raise ZipSafetyError('zip_slip', f'无法解析解压目标 {target}：{exc}') from exc
    if resolved != dest_root and not resolved.is_relative_to(dest_root):
        raise ZipSafetyError(
            'zip_slip',
            f'归档条目解析后落在解压根目录之外：{target} -> {resolved}',
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
                    f'zip 声明了 {len(infos)} 个条目（上限 {limits.max_entries}）',
                )
            for info in infos:
                if _entry_is_symlink(info):
                    raise ZipSafetyError(
                        'symlink_entry',
                        f'归档条目是符号链接：{info.filename!r}',
                    )
                _reject_nul_in_name(info)
                _reject_absolute_or_escaping(info.filename)
                _reject_windows_unsafe_name(info.filename)
                _reject_unsupported_method(info)
                if info.file_size > limits.max_file_bytes:
                    raise ZipSafetyError(
                        'entry_too_large',
                        f'条目 {info.filename!r} 声明了 {info.file_size} 字节 '
                        f'（上限 {limits.max_file_bytes}）',
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
                                f'条目 {info.filename!r} 在解压过程中超过 '
                                f'{limits.max_file_bytes} 字节',
                            )
                        if total_written > limits.max_total_uncompressed_bytes:
                            raise ZipSafetyError(
                                'total_too_large',
                                f'解压过程中超过 {limits.max_total_uncompressed_bytes} '
                                f'字节的总量上限',
                            )
                        sink.write(chunk)
                # 解压出的文件不可执行：包内代码由解释器显式调用，不给可执行位。
                try:
                    os.chmod(target, 0o644)
                except OSError as exc:  # pragma: no cover - 平台差异
                    logger.warning('zip_safety: chmod failed for %s: %s', target, exc)
    except zipfile.BadZipFile as exc:
        _cleanup_partial(written_files, created_dirs, resolved_root)
        raise ZipSafetyError('bad_archive', f'不是可读的 zip 归档：{exc}') from exc
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
