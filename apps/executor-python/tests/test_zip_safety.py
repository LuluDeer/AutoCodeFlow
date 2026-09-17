"""`zip_safety.py` 单测（FR-03、NFR-04、AC-03a/AC-03b）。

覆盖：正常解压、zip-slip（`../`）拒绝且**工作目录外零产物**、绝对路径/盘符路径
拒绝、符号链接条目拒绝、条数/单文件/总解压/压缩比红线、非 zip → `bad_archive`、
部分产物清理、以及"整包先审查、炸弹包在写出任何字节前被拒"。
"""
import os
import stat
import zipfile
from pathlib import Path

import pytest

from zip_safety import (
    ZIP_GUARD_DEFAULT_LIMITS,
    ZipLimits,
    ZipSafetyError,
    get_zip_limits_from_env,
    safe_extract,
    vet_zip,
)


def make_zip(path: Path, entries: dict[str, bytes | str], *, compress=zipfile.ZIP_DEFLATED) -> Path:
    """按 `{条目名: 内容}` 造一个 zip（名字逐字节保留——恶意名也原样写入）。"""
    with zipfile.ZipFile(path, 'w', compress) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return path


def add_symlink_entry(path: Path, name: str, target: str) -> Path:
    """向已有 zip 追加一个 Unix 符号链接条目（外部属性高 16 位 = S_IFLNK）。"""
    info = zipfile.ZipInfo(name)
    info.create_system = 3  # Unix
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(path, 'a') as archive:
        archive.writestr(info, target)
    return path


def patch_declared_uncompressed_size(raw: bytes, size: int) -> bytes:
    """把本地文件头与中央目录里"声明解压后大小"改成 `size`（数据不动）。

    用于验证"声明值不可信"——流式解压必须按**实际写出的字节数**执行红线。
    """
    data = bytearray(raw)
    assert bytes(data[0:4]) == b'PK\x03\x04', 'expected a local file header first'
    data[22:26] = size.to_bytes(4, 'little')
    central = data.find(b'PK\x01\x02')
    assert central != -1, 'expected a central directory record'
    data[central + 24:central + 28] = size.to_bytes(4, 'little')
    return bytes(data)


# ---------------------------------------------------------------------------
# 上限常量（NFR-04 / AC-03b：与 executor-node zip-guard.ts 等强度）
# ---------------------------------------------------------------------------

def test_default_limits_mirror_executor_node_zip_guard():
    assert ZIP_GUARD_DEFAULT_LIMITS.max_ratio == 100
    assert ZIP_GUARD_DEFAULT_LIMITS.max_entries == 10_000
    assert ZIP_GUARD_DEFAULT_LIMITS.max_file_bytes == 1024 * 1024 * 1024
    assert ZIP_GUARD_DEFAULT_LIMITS.max_total_uncompressed_bytes == 2 * 1024 * 1024 * 1024
    assert ZIP_GUARD_DEFAULT_LIMITS.max_nesting_depth == 1


def test_limits_from_env_uses_node_variable_names():
    limits = get_zip_limits_from_env({'ZIP_MAX_RATIO': '50', 'ZIP_MAX_ENTRIES': '7'})
    assert limits.max_ratio == 50
    assert limits.max_entries == 7
    assert limits.max_file_bytes == ZIP_GUARD_DEFAULT_LIMITS.max_file_bytes


def test_limits_from_env_falls_back_on_garbage():
    limits = get_zip_limits_from_env({
        'ZIP_MAX_RATIO': 'bogus', 'ZIP_MAX_ENTRIES': '0', 'ZIP_MAX_TOTAL_BYTES': '-5',
    })
    assert limits.max_ratio == ZIP_GUARD_DEFAULT_LIMITS.max_ratio
    assert limits.max_entries == ZIP_GUARD_DEFAULT_LIMITS.max_entries
    assert limits.max_total_uncompressed_bytes == ZIP_GUARD_DEFAULT_LIMITS.max_total_uncompressed_bytes


# ---------------------------------------------------------------------------
# 正常路径
# ---------------------------------------------------------------------------

def test_safe_extract_extracts_good_zip(tmp_path):
    archive = make_zip(tmp_path / 'good.zip', {
        'main.py': 'print("hi")\n',
        'requirements.txt': 'requests>=2\n',
        'pkg/__init__.py': '',
        'pkg/util.py': 'VALUE = 1\n',
        'data/': '',
    })
    dest = tmp_path / 'work'
    dest.mkdir()

    safe_extract(archive, dest)

    assert (dest / 'main.py').read_text() == 'print("hi")\n'
    assert (dest / 'requirements.txt').read_text() == 'requests>=2\n'
    assert (dest / 'pkg' / 'util.py').read_text() == 'VALUE = 1\n'
    assert (dest / 'data').is_dir()


def test_safe_extract_creates_dest_when_missing(tmp_path):
    archive = make_zip(tmp_path / 'good.zip', {'a.txt': 'a'})
    dest = tmp_path / 'not-yet'

    safe_extract(archive, dest)

    assert (dest / 'a.txt').read_text() == 'a'


def test_safe_extract_does_not_set_executable_bit(tmp_path):
    archive = make_zip(tmp_path / 'good.zip', {'run.sh': '#!/bin/sh\necho hi\n'})
    dest = tmp_path / 'work'

    safe_extract(archive, dest)

    if os.name != 'nt':
        mode = stat.S_IMODE((dest / 'run.sh').stat().st_mode)
        assert mode == 0o644


def test_vet_zip_accepts_good_zip(tmp_path):
    archive = make_zip(tmp_path / 'good.zip', {'a.txt': 'a'})
    vet_zip(archive)  # 不抛即通过


# ---------------------------------------------------------------------------
# zip-slip / 绝对路径 / 符号链接（AC-03a）
# ---------------------------------------------------------------------------

def test_safe_extract_rejects_parent_traversal_and_writes_nothing_outside(tmp_path):
    """AC-03a：含 `../evil` 的包必须被拒，且**工作目录之外零产物**。"""
    archive = make_zip(tmp_path / 'evil.zip', {
        'ok.txt': 'ok',
        '../evil.txt': 'pwned',
    })
    dest = tmp_path / 'work'
    dest.mkdir()

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(archive, dest)

    assert exc.value.violation == 'zip_slip'
    assert not (tmp_path / 'evil.txt').exists(), '不得在解压根之外产生任何文件'
    assert not (dest / 'ok.txt').exists(), '违规包不得留下部分产物'


def test_safe_extract_rejects_deep_parent_traversal(tmp_path):
    archive = make_zip(tmp_path / 'evil.zip', {'a/b/../../../evil.txt': 'pwned'})
    dest = tmp_path / 'work'

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(archive, dest)

    assert exc.value.violation == 'zip_slip'
    assert not (tmp_path / 'evil.txt').exists()


@pytest.mark.parametrize('name', ['/abs/evil.txt', 'C:\\Windows\\evil.txt', 'C:/evil.txt', 'C:evil.txt'])
def test_safe_extract_rejects_absolute_and_drive_paths(tmp_path, name):
    archive = make_zip(tmp_path / 'evil.zip', {name: 'pwned'})
    dest = tmp_path / 'work'

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(archive, dest)

    assert exc.value.violation == 'absolute_path'
    assert not (tmp_path / 'abs').exists()


def test_safe_extract_rejects_unc_path(tmp_path):
    archive = make_zip(tmp_path / 'evil.zip', {'\\\\server\\share\\evil.txt': 'pwned'})
    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(archive, tmp_path / 'work')

    assert exc.value.violation == 'absolute_path'


def test_safe_extract_rejects_symlink_entry(tmp_path):
    """符号链接条目会让后续写入逃逸出解压根——必须在写出任何字节前拒绝。"""
    archive = make_zip(tmp_path / 'evil.zip', {'ok.txt': 'ok'})
    add_symlink_entry(archive, 'link', '/etc/passwd')
    dest = tmp_path / 'work'
    dest.mkdir()

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(archive, dest)

    assert exc.value.violation == 'symlink_entry'
    assert not (dest / 'link').exists()
    assert not (dest / 'ok.txt').exists()


def test_vet_zip_rejects_symlink_entry(tmp_path):
    archive = make_zip(tmp_path / 'evil.zip', {'ok.txt': 'ok'})
    add_symlink_entry(archive, 'link', '/etc/passwd')

    with pytest.raises(ZipSafetyError) as exc:
        vet_zip(archive)

    assert exc.value.violation == 'symlink_entry'


def test_vet_zip_rejects_traversal_before_any_extraction(tmp_path):
    """`vet_zip` 只审查不落盘——解压前调用它，炸弹/逃逸包不产生任何文件。"""
    archive = make_zip(tmp_path / 'evil.zip', {'../evil.txt': 'pwned'})

    with pytest.raises(ZipSafetyError):
        vet_zip(archive)

    assert list(tmp_path.iterdir()) == [archive]


# ---------------------------------------------------------------------------
# 限额（zip-bomb）
# ---------------------------------------------------------------------------

def test_safe_extract_rejects_too_many_entries(tmp_path):
    archive = make_zip(tmp_path / 'many.zip', {f'f{i}.txt': 'x' for i in range(5)})
    dest = tmp_path / 'work'

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(archive, dest, limits=ZipLimits(max_entries=3))

    assert exc.value.violation == 'too_many_entries'
    assert not (dest / 'f0.txt').exists(), '整包先审查 → 一个文件都不该写出'


def test_safe_extract_rejects_entry_too_large(tmp_path):
    """单文件声明尺寸超限 → `entry_too_large`（检查顺序在压缩比之后）。"""
    archive = make_zip(tmp_path / 'big.zip', {'big.bin': b'x' * 5000})
    dest = tmp_path / 'work'

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(archive, dest, limits=ZipLimits(max_ratio=1000, max_file_bytes=1000))

    assert exc.value.violation == 'entry_too_large'
    assert not (dest / 'big.bin').exists()


def test_safe_extract_rejects_total_too_large(tmp_path):
    archive = make_zip(tmp_path / 'total.zip', {
        'a.bin': b'a' * 800, 'b.bin': b'b' * 800,
    })
    dest = tmp_path / 'work'

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(archive, dest, limits=ZipLimits(
            max_ratio=1000, max_total_uncompressed_bytes=1000,
        ))

    assert exc.value.violation == 'total_too_large'


def test_safe_extract_rejects_high_compression_ratio(tmp_path):
    """1MiB 全零 → deflate 后约 1KB，压缩比远超 100（zip 炸弹特征）。"""
    archive = make_zip(tmp_path / 'bomb.zip', {'bomb.bin': b'\0' * (1024 * 1024)})
    dest = tmp_path / 'work'

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(archive, dest)

    assert exc.value.violation == 'ratio_too_high'
    assert not (dest / 'bomb.bin').exists()


def test_declared_sizes_are_not_trusted_for_extraction(tmp_path):
    """声明值不可信：中央目录谎报 10 字节、实际 1MiB。

    `zipfile` 自己会因 CRC/长度不符而中止（BadZipFile）——同样不会把 1MiB 写到
    磁盘上，且本模块把它归类为 `bad_archive` 并清掉部分产物。这是"声明值不可信"
    的**双层**保证：uv 的声明审查 + 流式写出的实际字节计数（见下一条用例）。
    """
    archive = make_zip(tmp_path / 'liar.zip', {'liar.bin': b'x' * (1024 * 1024)})
    archive.write_bytes(patch_declared_uncompressed_size(archive.read_bytes(), 10))
    dest = tmp_path / 'work'

    # 声明值过审（vet_zip 只看声明，不读数据）
    vet_zip(archive, limits=ZipLimits(max_ratio=1000, max_file_bytes=4096))

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(archive, dest, limits=ZipLimits(max_ratio=1000, max_file_bytes=4096))

    assert exc.value.violation == 'bad_archive'
    assert not (dest / 'liar.bin').exists(), '中止后必须清理部分产物'


def test_safe_extract_aborts_when_streamed_bytes_exceed_file_cap(tmp_path, monkeypatch):
    """流式红线（真实字节数）：把读块压到 4KiB，验证按实际写出量中止。"""
    archive = make_zip(tmp_path / 'big.zip', {'big.bin': b'x' * (256 * 1024)})
    dest = tmp_path / 'work'
    monkeypatch.setattr('zip_safety._CHUNK_SIZE', 4096)

    # 声明值谎报为 10 字节（逃过 vet_zip 的声明审查）——但 CRC 校验会先行中止，
    # 因此这里用真实声明 + 流式累加验证红线：声明值 256KiB、上限 64KiB。
    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(archive, dest, limits=ZipLimits(
            max_ratio=1000, max_file_bytes=64 * 1024,
        ))

    assert exc.value.violation == 'entry_too_large'
    assert not (dest / 'big.bin').exists()


def test_safe_extract_aborts_when_streamed_total_exceeds_cap(tmp_path, monkeypatch):
    archive = make_zip(tmp_path / 'big.zip', {
        'a.bin': b'a' * (64 * 1024), 'b.bin': b'b' * (64 * 1024),
    })
    dest = tmp_path / 'work'
    monkeypatch.setattr('zip_safety._CHUNK_SIZE', 4096)

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(archive, dest, limits=ZipLimits(
            max_ratio=1000, max_total_uncompressed_bytes=96 * 1024,
        ))

    assert exc.value.violation == 'total_too_large'
    assert not dest.exists() or not any(dest.iterdir()), '中止后必须清理部分产物'


def test_safe_extract_cleans_partial_output_on_violation(tmp_path):
    """先写出的合法文件在后续条目违规时必须一并清除（不留半成品工作目录）。"""
    archive = make_zip(tmp_path / 'mixed.zip', {
        'pkg/good.py': 'x = 1\n',
        'pkg/deep/good2.py': 'y = 2\n',
        '../evil.txt': 'pwned',
    })
    dest = tmp_path / 'work'
    dest.mkdir()

    with pytest.raises(ZipSafetyError):
        safe_extract(archive, dest)

    assert list(dest.iterdir()) == [], 'dest 必须回到空目录（本次产物全清）'
    assert not (tmp_path / 'evil.txt').exists()


def test_safe_extract_preserves_preexisting_dest_content(tmp_path):
    """清理只删本次解压创建的内容——work_dir 里既有的 artifacts/ 等不得误删。"""
    dest = tmp_path / 'work'
    (dest / 'artifacts').mkdir(parents=True)
    (dest / 'artifacts' / 'keep.txt').write_text('keep me')
    archive = make_zip(tmp_path / 'mixed.zip', {'a.txt': 'a', '../evil.txt': 'pwned'})

    with pytest.raises(ZipSafetyError):
        safe_extract(archive, dest)

    assert (dest / 'artifacts' / 'keep.txt').read_text() == 'keep me'
    assert not (dest / 'a.txt').exists()


# ---------------------------------------------------------------------------
# 坏包
# ---------------------------------------------------------------------------

def test_vet_zip_rejects_non_zip(tmp_path):
    not_a_zip = tmp_path / 'not.zip'
    not_a_zip.write_bytes(b'this is definitely not a zip archive')

    with pytest.raises(ZipSafetyError) as exc:
        vet_zip(not_a_zip)

    assert exc.value.violation == 'bad_archive'


def test_safe_extract_rejects_non_zip(tmp_path):
    not_a_zip = tmp_path / 'not.zip'
    not_a_zip.write_bytes(b'plain text')
    dest = tmp_path / 'work'

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(not_a_zip, dest)

    assert exc.value.violation == 'bad_archive'


def test_vet_zip_rejects_missing_file(tmp_path):
    with pytest.raises(ZipSafetyError) as exc:
        vet_zip(tmp_path / 'missing.zip')

    assert exc.value.violation == 'bad_archive'


def test_vet_zip_rejects_truncated_archive(tmp_path):
    archive = make_zip(tmp_path / 'good.zip', {'a.txt': 'a' * 100})
    raw = archive.read_bytes()
    archive.write_bytes(raw[:len(raw) // 2])

    with pytest.raises(ZipSafetyError) as exc:
        vet_zip(archive)

    assert exc.value.violation == 'bad_archive'


# ---------------------------------------------------------------------------
# 嵌套包（对照 zip-guard.ts 的 maxNestingDepth 语义）
# ---------------------------------------------------------------------------

def test_nested_zip_member_is_extracted_as_opaque_file(tmp_path):
    """单层嵌套 zip 在 python 侧按普通文件解压（`max_nesting_depth=1` 的急切复审
    通过后），其内容不会在父包解压阶段展开。"""
    inner = make_zip(tmp_path / 'inner.zip', {'lib.py': 'x = 1\n'})
    outer = tmp_path / 'outer.zip'
    with zipfile.ZipFile(outer, 'w') as archive:
        archive.write(inner, 'vendor/inner.zip')
        archive.writestr('main.py', 'print(1)\n')
    dest = tmp_path / 'work'

    safe_extract(outer, dest)

    assert (dest / 'vendor' / 'inner.zip').is_file()
    assert (dest / 'main.py').read_text() == 'print(1)\n'
    assert not (dest / 'vendor' / 'lib.py').exists(), '嵌套包不得被就地展开'


def test_nested_bomb_is_caught_by_parent_totals(tmp_path):
    """嵌套炸弹的压缩数据计入父包 → 父包的压缩比红线先拦住整个包。"""
    inner = make_zip(tmp_path / 'inner.zip', {'bomb.bin': b'\0' * (8 * 1024 * 1024)})
    outer = tmp_path / 'outer.zip'
    with zipfile.ZipFile(outer, 'w') as archive:
        archive.write(inner, 'inner.zip')
    dest = tmp_path / 'work'

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(outer, dest)

    assert exc.value.violation in {'ratio_too_high', 'total_too_large', 'entry_too_large'}


def test_nested_zip_is_eagerly_vetted(tmp_path):
    """内层包自身的违规（zip-slip 条目）在父包审查阶段即被拒（对照 node 急切复审）。"""
    inner = make_zip(tmp_path / 'inner.zip', {'../evil.txt': 'pwned'})
    outer = tmp_path / 'outer.zip'
    with zipfile.ZipFile(outer, 'w') as archive:
        archive.write(inner, 'inner.zip')
    dest = tmp_path / 'work'

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(outer, dest)

    assert exc.value.violation == 'zip_slip'
    assert not (tmp_path / 'evil.txt').exists()
    assert not (dest / 'inner.zip').exists(), '审查失败 → 不解压任何条目'


def test_corrupt_nested_zip_is_rejected(tmp_path):
    """名为 .zip 但内容不是 zip → fail-closed（"审不了的包就不解"）。"""
    outer = tmp_path / 'outer.zip'
    with zipfile.ZipFile(outer, 'w') as archive:
        archive.writestr('vendor/broken.zip', 'definitely not a zip')
        archive.writestr('main.py', 'print(1)\n')
    dest = tmp_path / 'work'

    with pytest.raises(ZipSafetyError) as exc:
        safe_extract(outer, dest)

    assert exc.value.violation == 'bad_archive'
    assert not any(dest.iterdir()) if dest.exists() else True


def test_nested_zip_too_deep_fails_closed(tmp_path):
    """急切复审深度 ≥16（node 同值）且仍有嵌套 → `nested_zip_too_deep`。

    与 zip-guard.ts 的 `else if (summary.nestedZipNames.length > 0 && depth >= 16)`
    逐字对齐：默认 `max_nesting_depth=1` 时永远到不了该分支，只有部署方把深度
    放宽到 ≥16 才可能触发（那时深嵌套包必须 fail-closed）。
    """
    current = make_zip(tmp_path / 'l0.zip', {'lib.py': 'x = 1\n'}).read_bytes()
    for level in range(1, 20):
        wrapper = tmp_path / f'l{level}.zip'
        with zipfile.ZipFile(wrapper, 'w') as archive:
            archive.writestr(f'nested-l{level - 1}.zip', current)
        current = wrapper.read_bytes()

    with pytest.raises(ZipSafetyError) as exc:
        vet_zip(tmp_path / 'l19.zip', limits=ZipLimits(max_nesting_depth=20))

    assert exc.value.violation == 'nested_zip_too_deep'


def test_nested_zip_beyond_vetted_depth_is_not_eagerly_probed(tmp_path):
    """深度 0 限制 = 不急切复审（与 node 的 `maxNestingDepth: 0` 语义一致）：
    嵌套成员按普通文件放行，其声明尺寸仍计入父包红线。"""
    inner = make_zip(tmp_path / 'inner.zip', {'lib.py': 'x = 1\n'})
    outer = tmp_path / 'outer.zip'
    with zipfile.ZipFile(outer, 'w') as archive:
        archive.write(inner, 'inner.zip')

    vet_zip(outer, limits=ZipLimits(max_nesting_depth=0))  # 不抛


def test_oversized_nested_zip_is_skipped_not_read_into_memory(tmp_path, monkeypatch):
    """超大嵌套包不做急切探测（防内存放大），但仍按父包红线放行/拦截。"""
    inner = make_zip(tmp_path / 'inner.zip', {'lib.py': 'x = 1\n'})
    outer = tmp_path / 'outer.zip'
    with zipfile.ZipFile(outer, 'w') as archive:
        archive.write(inner, 'vendor/inner.zip')
    monkeypatch.setattr('zip_safety.NESTED_PROBE_MAX_BYTES', 1)

    vet_zip(outer)  # 跳过急切复审，不抛


def test_safe_extract_is_safe_by_default_without_prior_vet(tmp_path):
    """调用方不必自己先审查：`safe_extract` 内部先 `vet_zip`（默认安全）。"""
    archive = make_zip(tmp_path / 'bomb.zip', {'bomb.bin': b'\0' * (1024 * 1024)})
    dest = tmp_path / 'work'

    with pytest.raises(ZipSafetyError):
        safe_extract(archive, dest)  # 没有显式 vet_zip

    assert not dest.exists() or list(dest.iterdir()) == []
