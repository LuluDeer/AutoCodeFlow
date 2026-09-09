"""Tests for FEAT-05 executor-python artifacts collection & upload (artifacts.py)."""
import asyncio
import hashlib
from pathlib import Path

import artifacts
from artifacts import (
    _api_base,
    _sha256_of,
    collect_artifacts,
    gather_artifacts_for_callback,
    MAX_ARTIFACT_COUNT,
)


def _make_art(work_dir: Path, name: str, data: bytes) -> Path:
    d = work_dir / "artifacts"
    d.mkdir(parents=True, exist_ok=True)
    p = d / name
    p.write_bytes(data)
    return p


def test_sha256_of_matches_hashlib(tmp_path):
    data = b"report-bytes-123"
    p = tmp_path / "x.bin"
    p.write_bytes(data)
    assert _sha256_of(p) == hashlib.sha256(data).hexdigest()


def test_collect_artifacts_builds_manifest(tmp_path):
    _make_art(tmp_path, "shot.png", b"png-bytes")
    _make_art(tmp_path, "report.csv", b"a,b,c\n")
    items = collect_artifacts(tmp_path)
    names = [i["name"] for i in items]
    assert names == ["report.csv", "shot.png"]  # 按名排序、确定性
    for i in items:
        assert i["size"] == len(Path(i["path"]).read_bytes())
        assert i["sha256"] == _sha256_of(Path(i["path"]))


def test_collect_no_dir_returns_empty(tmp_path):
    assert collect_artifacts(tmp_path) == []


def test_collect_skips_oversized(tmp_path, monkeypatch):
    monkeypatch.setattr(artifacts, "MAX_ARTIFACT_SIZE", 4)
    _make_art(tmp_path, "big.bin", b"way-too-long-for-cap")
    _make_art(tmp_path, "ok.bin", b"ab")
    names = [i["name"] for i in collect_artifacts(tmp_path)]
    assert names == ["ok.bin"]


def test_collect_skips_subdirectories(tmp_path):
    _make_art(tmp_path, "keep.txt", b"x")
    (tmp_path / "artifacts" / "nested").mkdir()
    (tmp_path / "artifacts" / "nested" / "ignored.txt").write_bytes(b"y")
    names = [i["name"] for i in collect_artifacts(tmp_path)]
    assert names == ["keep.txt"]


def test_collect_enforces_count_cap(tmp_path):
    for i in range(MAX_ARTIFACT_COUNT + 5):
        _make_art(tmp_path, f"file_{i:03d}.txt", b"z")
    items = collect_artifacts(tmp_path)
    assert len(items) == MAX_ARTIFACT_COUNT


def test_api_base_normalizes_api_suffix():
    assert _api_base("http://admin:3105") == "http://admin:3105/api"
    assert _api_base("http://admin:3105/") == "http://admin:3105/api"
    assert _api_base("http://admin:3105/api") == "http://admin:3105/api"  # 不双前缀


def test_gather_returns_only_successfully_uploaded(tmp_path, monkeypatch):
    _make_art(tmp_path, "a.png", b"1")
    _make_art(tmp_path, "b.csv", b"2")
    _make_art(tmp_path, "c.txt", b"3")

    async def fake_upload(client, admin_base_url, execution_id, item, token):
        # b.csv 上传失败 → 不入清单
        return item["name"] != "b.csv"

    monkeypatch.setattr(artifacts, "_upload_one", fake_upload)
    manifest = asyncio.run(
        gather_artifacts_for_callback("exec-1", tmp_path, "http://admin:3105", "tok")
    )
    assert [m["name"] for m in manifest] == ["a.png", "c.txt"]
    assert all(set(m.keys()) == {"name", "size", "sha256"} for m in manifest)


def test_gather_no_admin_url_returns_empty(tmp_path):
    _make_art(tmp_path, "a.png", b"1")
    assert asyncio.run(gather_artifacts_for_callback("e", tmp_path, None, "t")) == []


def test_gather_no_artifacts_returns_empty(tmp_path):
    assert asyncio.run(
        gather_artifacts_for_callback("e", tmp_path, "http://admin:3105", "t")
    ) == []


def test_gather_upload_exception_is_best_effort(tmp_path, monkeypatch):
    _make_art(tmp_path, "a.png", b"1")

    async def boom(client, admin_base_url, execution_id, item, token):
        raise RuntimeError("network down")

    monkeypatch.setattr(artifacts, "_upload_one", boom)
    # _upload_one 内部吞异常返回 False 的语义由 fake 直接抛模拟最外层保护：
    # gather 本身不应抛出。
    result = asyncio.run(
        gather_artifacts_for_callback("e", tmp_path, "http://admin:3105", "t")
    )
    assert result == []
