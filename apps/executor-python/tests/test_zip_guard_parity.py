"""R94-A1：zip 闸门跨平面逐项对齐（executor-python / executor-node / admin-api）。

背景（本仓老毛病）：同一道 zip 安全闸有三份实现——
`apps/executor-python/zip_safety.py`、`apps/executor-node/src/zip-guard.ts`、
`apps/admin-api/src/common/utils/zip-guard.util.ts`。2026-09-23 OOM 事故后，
node 与 admin-api 把「单文件声明上限 / 总解压上限」从 1 GiB / 2 GiB 下调到
512 MiB / 1 GiB，**python 侧没跟上**——同一个包在 python 执行器通过、在 node
执行器被拒（NFR-04 / AC-03b 要求两侧等强度）。

本文件直接读另两份实现的源码常量做比对：任何一侧单独改动（再次漂移）都会红，
而不是像此前那样由 python 侧测试把**旧值**钉死（把漂移锁在测试里）。
"""
import os
import re
import zipfile
from pathlib import Path

import pytest

import zip_safety
from zip_safety import ZIP_GUARD_DEFAULT_LIMITS, ZipSafetyError, vet_zip

# tests/ → executor-python/ → apps/ → 仓库根
_REPO_ROOT = Path(__file__).resolve().parents[3]
_NODE_ZIP_GUARD = _REPO_ROOT / 'apps' / 'executor-node' / 'src' / 'zip-guard.ts'
_ADMIN_ZIP_GUARD = (
    _REPO_ROOT / 'apps' / 'admin-api' / 'src' / 'common' / 'utils' / 'zip-guard.util.ts'
)

_LIMIT_LINE_RE = re.compile(r'^\s*(max[A-Za-z]\w*)\s*:\s*([0-9_\s*]+?)\s*,', re.M)


def _ts_int(expr: str) -> int:
    """把 TS 里的 `512 * 1024 * 1024` / `10_000` 常量表达式求值。

    只接受数字、下划线与乘号——不足以求值即断言失败，绝不 eval。
    """
    total = 1
    for part in expr.replace('_', '').split('*'):
        part = part.strip()
        assert part.isdigit(), f'非纯数字常量片段：{part!r}（expr={expr!r}）'
        total *= int(part)
    return total


def _ts_default_limits(path: Path) -> dict[str, int]:
    """从 TS 源码里抽出 `ZIP_GUARD_DEFAULT_LIMITS = {...}` 的每个数值字段。"""
    text = path.read_text(encoding='utf-8')
    anchor = text.index('ZIP_GUARD_DEFAULT_LIMITS')
    block = text[text.index('{', anchor):]
    block = block[: block.index('}')]
    limits = {m.group(1): _ts_int(m.group(2)) for m in _LIMIT_LINE_RE.finditer(block)}
    assert limits, f'{path} 中未解析出任何上限字段（解析器需随源码格式更新）'
    return limits


def test_defaults_equal_executor_node_zip_guard():
    """同名字段逐项等价：maxRatio / maxEntries / maxFileBytes /
    maxTotalUncompressedBytes / maxNestingDepth。"""
    if not _NODE_ZIP_GUARD.exists():  # pragma: no cover - 单仓外运行（如镜像内只带本 app）
        pytest.skip(f'missing {_NODE_ZIP_GUARD}')
    node = _ts_default_limits(_NODE_ZIP_GUARD)
    assert node['maxRatio'] == ZIP_GUARD_DEFAULT_LIMITS.max_ratio
    assert node['maxEntries'] == ZIP_GUARD_DEFAULT_LIMITS.max_entries
    assert node['maxFileBytes'] == ZIP_GUARD_DEFAULT_LIMITS.max_file_bytes
    assert (
        node['maxTotalUncompressedBytes']
        == ZIP_GUARD_DEFAULT_LIMITS.max_total_uncompressed_bytes
    )
    assert node['maxNestingDepth'] == ZIP_GUARD_DEFAULT_LIMITS.max_nesting_depth


def test_defaults_equal_admin_api_zip_guard():
    """admin-api 是入包侧的第一道闸；执行器闸不得比它松（否则"中台拒了、
    换个执行器就收了"这类不对称照样发生）。"""
    if not _ADMIN_ZIP_GUARD.exists():  # pragma: no cover
        pytest.skip(f'missing {_ADMIN_ZIP_GUARD}')
    admin = _ts_default_limits(_ADMIN_ZIP_GUARD)
    assert admin['maxRatio'] == ZIP_GUARD_DEFAULT_LIMITS.max_ratio
    assert admin['maxEntries'] == ZIP_GUARD_DEFAULT_LIMITS.max_entries
    assert admin['maxFileBytes'] == ZIP_GUARD_DEFAULT_LIMITS.max_file_bytes
    assert (
        admin['maxTotalUncompressedBytes']
        == ZIP_GUARD_DEFAULT_LIMITS.max_total_uncompressed_bytes
    )
    assert admin['maxNestingDepth'] == ZIP_GUARD_DEFAULT_LIMITS.max_nesting_depth
    # 嵌套包"读进内存复审"的预算：admin 侧同名阈值 maxNestedInflateBytes，
    # python 侧 NESTED_PROBE_MAX_BYTES 必须同值。
    assert admin['maxNestedInflateBytes'] == zip_safety.NESTED_PROBE_MAX_BYTES


def test_python_defaults_are_the_hardened_values():
    """数值直接钉死（不依赖兄弟平面源码是否可读）：2026-09-23 OOM 后的收紧值。"""
    assert ZIP_GUARD_DEFAULT_LIMITS.max_ratio == 100
    assert ZIP_GUARD_DEFAULT_LIMITS.max_entries == 10_000
    assert ZIP_GUARD_DEFAULT_LIMITS.max_file_bytes == 512 * 1024 * 1024
    assert ZIP_GUARD_DEFAULT_LIMITS.max_total_uncompressed_bytes == 1024 * 1024 * 1024
    assert ZIP_GUARD_DEFAULT_LIMITS.max_nesting_depth == 1


def _patch_central_sizes(raw: bytes, *, uncompressed: int, compressed: int) -> bytes:
    """只改中央目录里的声明尺寸（数据不动）——模拟"声明值撒谎"的炸弹包。

    `vet_zip` 只看中央目录声明值（与 node zip-guard 同姿态），因此这一处改写
    正好落在审查面上；压缩比保持 ≤ 上限，确保命中的是单文件红线而不是比例线。
    """
    data = bytearray(raw)
    central = data.find(b'PK\x01\x02')
    assert central != -1, 'expected a central directory record'
    data[central + 20:central + 24] = compressed.to_bytes(4, 'little')
    data[central + 24:central + 28] = uncompressed.to_bytes(4, 'little')
    return bytes(data)


def _lying_zip(tmp_path: Path, name: str, *, uncompressed: int, compressed: int) -> Path:
    target = tmp_path / 'lying.zip'
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(name, b'x' * 1024)
    target.write_bytes(
        _patch_central_sizes(
            target.read_bytes(), uncompressed=uncompressed, compressed=compressed
        )
    )
    return target


def test_entry_declaring_600mib_is_rejected(tmp_path):
    """单条目声明 600 MiB：node / admin 都拒（上限 512 MiB），python 不得放行。

    改动前 python 的上限是 1 GiB → 这个包通过审查，同一个包在 node 执行器被拒。
    """
    archive = _lying_zip(
        tmp_path,
        'big.bin',
        uncompressed=600 * 1024 * 1024,
        compressed=6 * 1024 * 1024,  # ratio == 100（不触发 ratio_too_high）
    )
    with pytest.raises(ZipSafetyError) as exc:
        vet_zip(archive)
    assert exc.value.violation == 'entry_too_large'


def test_extract_package_honors_zip_max_env(tmp_path, monkeypatch):
    """生产解压路径必须吃 `ZIP_MAX_*`（与 node `assertZipFileSafe` 同义）。

    改动前 `_extract_package` 两处调用都不传 limits → 永远用模块常量，部署方按
    node 的同一组变量收紧上限后 python 执行器静默不生效（包照样通过）。
    """
    from routers import execute as execute_module

    assert execute_module._zip_safety is not None
    archive = tmp_path / 'pkg.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_STORED) as z:
        z.writestr('main.py', b'print(1)\n' * 40)  # 360 字节
    work = tmp_path / 'work'
    work.mkdir()

    # 缺省（模块默认 512 MiB）→ 通过。
    execute_module._extract_package(archive, work)

    # 部署方收紧到 100 字节 → 必须以命名 violation 拒绝，而不是静默放行。
    monkeypatch.setenv('ZIP_MAX_FILE_BYTES', '100')
    with pytest.raises(RuntimeError) as exc:
        execute_module._extract_package(archive, work)
    assert 'entry_too_large' in str(exc.value)


def test_entry_declaring_500mib_is_still_accepted(tmp_path):
    """500 MiB（< 512 MiB 上限）必须继续通过——收紧不得变成"一律拒绝"。"""
    archive = _lying_zip(
        tmp_path,
        'ok.bin',
        uncompressed=500 * 1024 * 1024,
        compressed=5 * 1024 * 1024,
    )
    vet_zip(archive)  # 不抛即通过
