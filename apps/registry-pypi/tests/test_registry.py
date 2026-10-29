"""Tests for the AutoFlow PyPI registry service."""
import io
import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Set default credentials before importing the app so the module uses them
os.environ.setdefault("REGISTRY_USER", "testuser")
os.environ.setdefault("REGISTRY_PASS", "testpass")


@pytest.fixture()
def tmp_packages_dir(tmp_path, monkeypatch):
    """Override PACKAGES_DIR to an isolated temp directory per test."""
    pkg_dir = tmp_path / "packages"
    pkg_dir.mkdir()
    monkeypatch.setenv("PACKAGES_DIR", str(pkg_dir))
    monkeypatch.setenv("REGISTRY_USER", "testuser")
    monkeypatch.setenv("REGISTRY_PASS", "testpass")
    return pkg_dir


@pytest.fixture()
def client(tmp_packages_dir):
    """Return a TestClient with a fresh packages directory."""
    # Re-import app with patched env vars
    import importlib
    import sys
    # Remove cached module so env vars take effect
    sys.modules.pop("main", None)
    import main as app_module
    # Patch the packages dir on the already-loaded module
    app_module.PACKAGES_DIR = tmp_packages_dir
    app_module.REGISTRY_USER = "testuser"
    app_module.REGISTRY_PASS = "testpass"
    return TestClient(app_module.app)


AUTH = ("testuser", "testpass")
BAD_AUTH = ("bad", "creds")


class TestHealth:
    def test_health_returns_ok(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_health_no_auth_required(self, client):
        """Health endpoint must be publicly accessible."""
        resp = client.get("/health")
        assert resp.status_code == 200


class TestAuth:
    def test_simple_index_requires_auth(self, client):
        resp = client.get("/simple/")
        assert resp.status_code == 401

    def test_package_index_requires_auth(self, client):
        resp = client.get("/simple/my-pkg/")
        assert resp.status_code in (401, 404)

    def test_download_requires_auth(self, client):
        resp = client.get("/packages/my-pkg/foo-1.0.whl")
        assert resp.status_code in (401, 404)

    def test_upload_requires_auth(self, client):
        resp = client.post("/", data={"name": "pkg", "version": "1.0"},
                           files={"content": ("pkg-1.0.whl", b"data", "application/octet-stream")})
        assert resp.status_code == 401

    def test_bad_credentials_rejected(self, client):
        resp = client.get("/simple/", auth=BAD_AUTH)
        assert resp.status_code == 401
        assert resp.json() == {"detail": "Unauthorized"}
        assert resp.headers["www-authenticate"] == "Basic"

    @pytest.mark.parametrize("authorization", [
        None,
        "Bearer test-token",
        "Basic",
        "Basic ",
        "Basic !!!not-base64!!!",
        "Basic dGVz!dHVzZXI6dGVzdHBhc3M=",
        "Basic " + __import__("base64").b64encode(b"missing-colon").decode(),
        "Basic " + __import__("base64").b64encode("tést:testpass".encode()).decode(),
        "Basic " + __import__("base64").b64encode(b":testpass").decode(),
        "Basic " + __import__("base64").b64encode(b"testuser:").decode(),
    ])
    def test_malformed_basic_auth_matches_bad_credentials(self, client, authorization):
        headers = {} if authorization is None else {"Authorization": authorization}
        malformed = client.get("/simple/", headers=headers)
        bad_credentials = client.get("/simple/", auth=BAD_AUTH)
        assert malformed.status_code == bad_credentials.status_code == 401
        assert malformed.json() == bad_credentials.json() == {"detail": "Unauthorized"}
        assert malformed.headers["www-authenticate"] == bad_credentials.headers["www-authenticate"] == "Basic"

    def test_valid_basic_auth_still_succeeds(self, client):
        resp = client.get("/simple/", auth=AUTH)
        assert resp.status_code == 200


class TestSimpleIndex:
    def test_empty_index(self, client):
        resp = client.get("/simple/", auth=AUTH)
        assert resp.status_code == 200
        assert "Simple Index" in resp.text

    def test_uploaded_package_appears_in_index(self, client):
        client.post("/", auth=AUTH,
                    data={"name": "mypackage", "version": "1.0.0"},
                    files={"content": ("mypackage-1.0.0.whl", b"wheel content", "application/octet-stream")})
        resp = client.get("/simple/", auth=AUTH)
        assert "mypackage" in resp.text

    def test_package_index_lists_files(self, client):
        client.post("/", auth=AUTH,
                    data={"name": "mypackage", "version": "1.0.0"},
                    files={"content": ("mypackage-1.0.0.whl", b"wheel bytes", "application/octet-stream")})
        resp = client.get("/simple/mypackage/", auth=AUTH)
        assert resp.status_code == 200
        assert "mypackage-1.0.0.whl" in resp.text
        # sha256 fragment must be present
        assert "sha256=" in resp.text

    def test_package_index_shows_version_size_time(self, client):
        # FEAT-12: 人类可读增强——版本/体积/时间行；锚点语义不变
        client.post("/", auth=AUTH,
                    data={"name": "richpkg", "version": "1.0.0"},
                    files={"content": ("richpkg-1.0.0-py3-none-any.whl", b"w" * 2048, "application/octet-stream")})
        resp = client.get("/simple/richpkg/", auth=AUTH)
        assert resp.status_code == 200
        # 版本聚合行存在
        assert "1.0.0" in resp.text
        # 体积（>1KB → KB 保留一位小数）
        assert "2.0 KB" in resp.text
        # UTC 时间戳行
        assert "UTC" in resp.text
        # PEP 503 兼容：锚点仍在且带 sha256
        assert 'href="/packages/richpkg/richpkg-1.0.0-py3-none-any.whl#sha256=' in resp.text
        # 计数行
        assert "1 file" in resp.text and "1 version" in resp.text

    def test_simple_index_shows_package_and_file_counts(self, client):
        client.post("/", auth=AUTH,
                    data={"name": "countpkg", "version": "0.2.0"},
                    files={"content": ("countpkg-0.2.0.tar.gz", b"tar bytes", "application/octet-stream")})
        resp = client.get("/simple/", auth=AUTH)
        assert resp.status_code == 200
        assert "countpkg" in resp.text
        # 计数行（包数 + 文件数）
        assert "package" in resp.text and "file" in resp.text
        # PEP 503 兼容：包锚点仍以 /simple/{name}/ 结尾
        assert 'href="/simple/countpkg/"' in resp.text

    def test_missing_package_returns_404(self, client):
        resp = client.get("/simple/nonexistent/", auth=AUTH)
        assert resp.status_code == 404


class TestUpload:
    def test_upload_whl(self, client):
        resp = client.post("/", auth=AUTH,
                           data={"name": "mypkg", "version": "0.1.0"},
                           files={"content": ("mypkg-0.1.0-py3-none-any.whl",
                                             b"fake wheel", "application/octet-stream")})
        assert resp.status_code == 200
        assert "mypkg-0.1.0-py3-none-any.whl" in resp.json()["message"]

    def test_upload_tar_gz(self, client):
        resp = client.post("/", auth=AUTH,
                           data={"name": "mypkg", "version": "0.1.0"},
                           files={"content": ("mypkg-0.1.0.tar.gz",
                                             b"fake sdist", "application/octet-stream")})
        assert resp.status_code == 200

    def test_upload_invalid_format_rejected(self, client):
        resp = client.post("/", auth=AUTH,
                           data={"name": "mypkg", "version": "0.1.0"},
                           files={"content": ("mypkg-0.1.0.exe",
                                             b"malware", "application/octet-stream")})
        assert resp.status_code == 400

    def test_upload_alt_endpoint(self, client):
        resp = client.post("/upload", auth=AUTH,
                           data={"name": "mypkg", "version": "0.2.0"},
                           files={"content": ("mypkg-0.2.0.whl",
                                             b"wheel v2", "application/octet-stream")})
        assert resp.status_code == 200

    def test_name_normalised(self, client):
        """PEP 503: My-Package and my_package should resolve to same dir."""
        client.post("/", auth=AUTH,
                    data={"name": "My_Package", "version": "1.0"},
                    files={"content": ("My_Package-1.0.whl",
                                      b"data", "application/octet-stream")})
        # The normalised name should appear in /simple/
        resp = client.get("/simple/", auth=AUTH)
        assert "my-package" in resp.text

    def test_path_traversal_in_filename_rejected(self, client):
        """Filename with directory components must be stripped safely."""
        resp = client.post("/", auth=AUTH,
                           data={"name": "mypkg", "version": "1.0"},
                           files={"content": ("../evil-1.0.whl",
                                             b"evil", "application/octet-stream")})
        # Either accepted with stripped name or rejected — must NOT write outside packages dir
        if resp.status_code == 200:
            # File should be stored as evil-1.0.whl inside the package dir, not above
            assert "../" not in resp.json().get("message", "")

    # ------------------------------------------------------------------
    # PKG-DIR-01（本轮审计）：上传表单的 `name` 只过 normalize()（PEP 503：
    # 折叠 [-_.]+、转小写），**不剥离前导 `/` 或盘符**。而 pathlib 的
    # `PACKAGES_DIR / seg` 在 seg 为绝对路径时会**整体丢弃**左操作数——
    # 于是 name="/tmp/x"（Linux）或 "C:/tmp/x"（Windows）让制品直接落在
    # PACKAGES_DIR 之外，且 pkg_dir 会 mkdir(parents=True) 主动创建它。
    # 文件名侧的目录分量早已被剥掉，包目录侧此前完全没有对应防护。
    # ------------------------------------------------------------------
    @pytest.mark.parametrize("evil_name", [
        "/tmp/acf-traversal-abs",
        "C:/tmp/acf-traversal-drive",
        "\\\\?\\C:/tmp/acf-traversal-unc",
    ])
    def test_absolute_package_name_rejected(self, client, tmp_packages_dir, evil_name):
        """绝对/带盘符的包名必须被拒，绝不能在 PACKAGES_DIR 之外建目录。"""
        resp = client.post("/", auth=AUTH,
                           data={"name": evil_name, "version": "1.0"},
                           files={"content": ("probe-1.0.whl", b"pwned",
                                              "application/octet-stream")})
        assert resp.status_code == 400
        assert "Invalid package name" in resp.json()["detail"]

    def test_absolute_package_name_creates_nothing_outside(self, client, tmp_packages_dir):
        """反证核心：被拒之后，包根之外不得出现任何新目录/文件。"""
        outside = tmp_packages_dir.parent / "outside-sentinel"
        outside.mkdir()
        before = set(p.name for p in outside.iterdir())

        for evil in ("/tmp/acf-t2", "C:/tmp/acf-t2"):
            client.post("/", auth=AUTH,
                        data={"name": evil, "version": "1.0"},
                        files={"content": ("probe-1.0.whl", b"pwned",
                                           "application/octet-stream")})

        assert set(p.name for p in outside.iterdir()) == before
        # 包根内也不该留下任何痕迹
        assert list(tmp_packages_dir.iterdir()) == []

    @pytest.mark.parametrize("path", ["/", "/upload"])
    def test_alias_shares_the_name_guard(self, client, path):
        """/upload 是 POST / 的薄 alias，必须共享同一道包目录防护。"""
        resp = client.post(path, auth=AUTH,
                           data={"name": "/tmp/acf-t3", "version": "1.0"},
                           files={"content": ("probe-1.0.whl", b"x",
                                              "application/octet-stream")})
        assert resp.status_code == 400

    @pytest.mark.parametrize("good_name", [
        "mypkg", "My_Package", "my.pkg", "my---pkg", "a&b", "1.0",
    ])
    def test_legitimate_names_still_accepted(self, client, good_name):
        """回归护栏：合法 PEP 503 包名（含大小写/分隔符/&）不受影响。"""
        resp = client.post("/", auth=AUTH,
                           data={"name": good_name, "version": "1.0"},
                           files={"content": ("probe-1.0.whl", b"x",
                                              "application/octet-stream")})
        assert resp.status_code == 200


class TestDownload:
    def test_download_uploaded_file(self, client):
        content = b"real wheel bytes"
        client.post("/", auth=AUTH,
                    data={"name": "dl-pkg", "version": "1.0"},
                    files={"content": ("dl-pkg-1.0.whl", content, "application/octet-stream")})
        resp = client.get("/packages/dl-pkg/dl-pkg-1.0.whl", auth=AUTH)
        assert resp.status_code == 200
        assert resp.content == content

    def test_download_missing_file_returns_404(self, client):
        resp = client.get("/packages/nopackage/nofile-1.0.whl", auth=AUTH)
        assert resp.status_code == 404


# ------------------------------------------------------------------------------
# NETOPT-5⑥: 读取路径（package_index / download_package）此前直接
# ``PACKAGES_DIR / normalize(name)``，包名安全闸 is_safe_package_name 只有
# 上传侧在调用。Windows 主机上 ``Path("C:/base") / "C:foo"`` 会丢弃左操作数
# （pathlib 语义），读取路径可落包根之外。两个读取端点现在对非法包名按
# 404 处理（与既有 404 形态一致，对 pip 不可区分）。
#
# 断言分两层：
# - HTTP 层：盘符/绝对名请求 404 的对外契约。注：`C:foo` 这类盘符名在
#   NTFS 上不可能作为目录存在，无闸时 exists() 也是 False → 404，故 HTTP
#   层无法单独区分「闸拒绝」与「路径不存在」；
# - 函数级：直接以非法名调用端点函数（绕过路由器对路径段的约束），
#   无闸时 ``PACKAGES_DIR / ".."`` 与 ``PACKAGES_DIR / "a/b"`` 可被预置为
#   真实存在的目录 → 无闸版本会把父目录/越权目录内容当包索引返回、把
#   包根之外的文件当制品下载 —— 有牙的反证差异。
# ------------------------------------------------------------------------------
class TestReadPathNameGate:
    @pytest.mark.parametrize("evil_name", [
        "C:foo",        # Windows 盘符相对形态：pathlib 丢根的经典形态
        "C:/tmp/x",     # 盘符绝对路径
        r"\\?\C:/tmp/x",  # UNC/长路径前缀
        "/tmp/x",       # POSIX 绝对路径
    ])
    def test_package_index_rejects_unsafe_names(self, client, evil_name):
        assert client.get(f"/simple/{evil_name}/", auth=AUTH).status_code == 404

    @pytest.mark.parametrize("evil_name", ["C:foo", "C:/tmp/x", "/tmp/x"])
    def test_download_rejects_unsafe_names(self, client, evil_name):
        assert client.get(
            f"/packages/{evil_name}/probe-1.0.whl", auth=AUTH
        ).status_code == 404

    def _bare_request(self):
        from starlette.requests import Request
        return Request({"type": "http", "method": "GET",
                        "headers": [], "query_string": b""})

    # 注：`..` 不构成读取路径威胁——normalize() 先把 `..` 折叠为 `-`
    # （PEP 503 语义），is_safe_package_name 的 `.`/`..` 分支只对「绕过
    # normalize 直接调用」的形态兜底，故有牙用例使用归一化后仍含分隔符
    # 的 `a/b` 形态（纵深防御分支）：无闸时 PACKAGES_DIR/a/b 可被预置为
    # 真实存在的目录/文件 → 索引照渲染、文件照下载；有闸时 404。

    def test_package_index_separator_name_cannot_read_nested_dir(
        self, tmp_packages_dir, monkeypatch
    ):
        import main as app_module
        from fastapi import HTTPException
        # 端点读的是模块属性：与 client fixture 同法 patch 到隔离目录
        monkeypatch.setattr(app_module, "PACKAGES_DIR", tmp_packages_dir)
        nested = tmp_packages_dir / "a" / "b"
        nested.mkdir(parents=True)
        (nested / "evil-1.0-py3-none-any.whl").write_bytes(b"x")
        with pytest.raises(HTTPException) as ei:
            app_module.package_index("a/b", self._bare_request(), _user="t")
        assert ei.value.status_code == 404

    def test_download_separator_name_cannot_fetch_nested_file(
        self, tmp_packages_dir, monkeypatch
    ):
        import main as app_module
        from fastapi import HTTPException
        monkeypatch.setattr(app_module, "PACKAGES_DIR", tmp_packages_dir)
        nested = tmp_packages_dir / "a" / "b"
        nested.mkdir(parents=True)
        (nested / "evil-1.0.whl").write_bytes(b"leak")
        with pytest.raises(HTTPException) as ei:
            # request 形参随 P2-2 下载审计加入（同 _bare_request 桩）
            app_module.download_package("a/b", "evil-1.0.whl",
                                        self._bare_request(), _user="t")
        assert ei.value.status_code == 404

    def test_gate_function_rejects_dot_and_dotdot(self):
        """is_safe_package_name 对 `.` / `..` 的兜底（防御 normalize 被
        改动后重新放行相对分量的纵深）。"""
        from main import is_safe_package_name
        assert not is_safe_package_name(".")
        assert not is_safe_package_name("..")
        assert is_safe_package_name("-")  # normalize("..") 的无害折叠产物

    def test_read_path_creates_nothing_outside(self, client, tmp_packages_dir):
        """读取路径的非法包名不得在包根之外创建/触碰任何目录。"""
        outside = tmp_packages_dir.parent / "outside-read-sentinel"
        outside.mkdir()
        before = set(p.name for p in outside.iterdir())

        client.get("/simple/C:foo/", auth=AUTH)
        client.get("/packages/C:foo/probe-1.0.whl", auth=AUTH)

        assert set(p.name for p in outside.iterdir()) == before
        assert list(tmp_packages_dir.iterdir()) == []

    def test_legitimate_read_paths_still_work(self, client):
        """合法回归：上传后 /simple/{name}/ 与 /packages/... 照常工作。"""
        client.post("/", auth=AUTH,
                    data={"name": "gate-ok", "version": "1.0"},
                    files={"content": ("gate_ok-1.0-py3-none-any.whl", b"ok",
                                       "application/octet-stream")})
        assert client.get("/simple/gate-ok/", auth=AUTH).status_code == 200
        resp = client.get("/packages/gate-ok/gate_ok-1.0-py3-none-any.whl", auth=AUTH)
        assert resp.status_code == 200
        assert resp.content == b"ok"


class TestNormalize:
    """Unit tests for the normalize() helper."""

    def test_normalize_lowercases(self):
        from main import normalize
        assert normalize("MyPkg") == "mypkg"

    def test_normalize_replaces_separators(self):
        from main import normalize
        assert normalize("my-pkg") == "my-pkg"
        assert normalize("my_pkg") == "my-pkg"
        assert normalize("my.pkg") == "my-pkg"
        assert normalize("my---pkg") == "my-pkg"


class TestHashSidecar:
    """N18: index-page sha256 anchors come from upload-time sidecars."""

    def test_upload_writes_sidecar(self, client, tmp_packages_dir):
        import hashlib
        payload = b"sidecar wheel bytes"
        resp = client.post("/", auth=AUTH,
                           data={"name": "sc-pkg", "version": "1.0.0"},
                           files={"content": ("sc-pkg-1.0.0.whl", payload, "application/octet-stream")})
        assert resp.status_code == 200
        sidecar = tmp_packages_dir / "sc-pkg" / "sc-pkg-1.0.0.whl.sha256"
        assert sidecar.is_file()
        assert sidecar.read_text().strip() == hashlib.sha256(payload).hexdigest()

    def test_index_anchor_matches_sidecar(self, client, tmp_packages_dir):
        import hashlib
        payload = b"anchor bytes"
        client.post("/", auth=AUTH,
                    data={"name": "sc-pkg", "version": "1.0.0"},
                    files={"content": ("sc-pkg-1.0.0.whl", payload, "application/octet-stream")})
        resp = client.get("/simple/sc-pkg/", auth=AUTH)
        assert resp.status_code == 200
        assert f"#sha256={hashlib.sha256(payload).hexdigest()}" in resp.text

    def test_index_reads_sidecar_not_file(self, client, tmp_packages_dir):
        """Out-of-band file mutation must not change the advertised hash:
        proof the index serves the sidecar value, never re-hashes the file."""
        import hashlib
        payload = b"original bytes"
        client.post("/", auth=AUTH,
                    data={"name": "sc-pkg", "version": "1.0.0"},
                    files={"content": ("sc-pkg-1.0.0.whl", payload, "application/octet-stream")})
        artifact = tmp_packages_dir / "sc-pkg" / "sc-pkg-1.0.0.whl"
        artifact.write_bytes(b"tampered out-of-band")
        resp = client.get("/simple/sc-pkg/", auth=AUTH)
        assert f"#sha256={hashlib.sha256(payload).hexdigest()}" in resp.text
        assert f"#sha256={hashlib.sha256(b'tampered out-of-band').hexdigest()}" not in resp.text

    def test_sidecar_not_listed_in_index(self, client):
        client.post("/", auth=AUTH,
                    data={"name": "sc-pkg", "version": "1.0.0"},
                    files={"content": ("sc-pkg-1.0.0.whl", b"x", "application/octet-stream")})
        resp = client.get("/simple/sc-pkg/", auth=AUTH)
        assert ".sha256" not in resp.text.replace("#sha256=", "")
        assert "sc-pkg-1.0.0.whl.sha256" not in resp.text

    def test_missing_sidecar_backfilled_lazily(self, client, tmp_packages_dir):
        """Legacy artifacts without a sidecar still get a correct hash, and
        the sidecar is written on first index access."""
        import hashlib
        pkg = tmp_packages_dir / "legacy"
        pkg.mkdir(parents=True)
        payload = b"legacy wheel content"
        (pkg / "legacy-1.0.0.whl").write_bytes(payload)
        assert not (pkg / "legacy-1.0.0.whl.sha256").exists()

        resp = client.get("/simple/legacy/", auth=AUTH)
        assert resp.status_code == 200
        assert f"#sha256={hashlib.sha256(payload).hexdigest()}" in resp.text
        sidecar = pkg / "legacy-1.0.0.whl.sha256"
        assert sidecar.is_file()
        assert sidecar.read_text().strip() == hashlib.sha256(payload).hexdigest()


class TestUploadDedup:
    """N21: duplicate (name, filename) uploads are hash-checked, never silently overwritten."""

    def test_reupload_same_content_is_idempotent_200(self, client, tmp_packages_dir):
        payload = b"retry me"
        for _ in range(2):
            resp = client.post("/", auth=AUTH,
                               data={"name": "dup-pkg", "version": "1.0.0"},
                               files={"content": ("dup-pkg-1.0.0.whl", payload, "application/octet-stream")})
            assert resp.status_code == 200
        artifact = tmp_packages_dir / "dup-pkg" / "dup-pkg-1.0.0.whl"
        assert artifact.read_bytes() == payload

    def test_reupload_different_content_rejected_409(self, client, tmp_packages_dir):
        original = b"published artifact"
        resp = client.post("/", auth=AUTH,
                           data={"name": "dup-pkg", "version": "1.0.0"},
                           files={"content": ("dup-pkg-1.0.0.whl", original, "application/octet-stream")})
        assert resp.status_code == 200
        resp = client.post("/", auth=AUTH,
                           data={"name": "dup-pkg", "version": "1.0.0"},
                           files={"content": ("dup-pkg-1.0.0.whl", b"evil replacement", "application/octet-stream")})
        assert resp.status_code == 409
        assert "sha256" in resp.json()["detail"]
        # Original artifact and its sidecar must be untouched
        artifact = tmp_packages_dir / "dup-pkg" / "dup-pkg-1.0.0.whl"
        assert artifact.read_bytes() == original
        assert artifact.with_name(artifact.name + ".sha256").read_text().strip() == \
            __import__("hashlib").sha256(original).hexdigest()

    def test_failed_reupload_leaves_no_temp_files(self, client, tmp_packages_dir):
        client.post("/", auth=AUTH,
                    data={"name": "dup-pkg", "version": "1.0.0"},
                    files={"content": ("dup-pkg-1.0.0.whl", b"v1", "application/octet-stream")})
        client.post("/", auth=AUTH,
                    data={"name": "dup-pkg", "version": "1.0.0"},
                    files={"content": ("dup-pkg-1.0.0.whl", b"v2", "application/octet-stream")})
        leftovers = [f.name for f in (tmp_packages_dir / "dup-pkg").iterdir()
                     if f.name.endswith(".upload")]
        assert leftovers == []

    def test_alt_endpoint_shares_dedup(self, client):
        resp = client.post("/upload", auth=AUTH,
                           data={"name": "dup-pkg", "version": "1.0.0"},
                           files={"content": ("dup-pkg-1.0.0.whl", b"same", "application/octet-stream")})
        assert resp.status_code == 200
        resp = client.post("/upload", auth=AUTH,
                           data={"name": "dup-pkg", "version": "1.0.0"},
                           files={"content": ("dup-pkg-1.0.0.whl", b"changed", "application/octet-stream")})
        assert resp.status_code == 409


class TestConcurrentUpload:
    """N30 (R8): concurrent same-name uploads are first-write-wins via
    os.link's atomic create — the old exists()-precheck + os.replace had a
    TOCTOU window where two racing writers both passed the check and the
    later replace silently clobbered the earlier artifact."""

    @staticmethod
    def _upload(client, payload, name="race-pkg", filename="race-pkg-1.0.0.whl"):
        return client.post("/", auth=AUTH,
                           data={"name": name, "version": "1.0.0"},
                           files={"content": (filename, payload, "application/octet-stream")})

    def test_concurrent_different_content_exactly_one_wins(self, client, tmp_packages_dir):
        """Two threads upload different bytes under the same filename:
        exactly one 200 + one 409, and the surviving artifact is whole
        (never a torn or silently-overwritten mix)."""
        import hashlib
        import threading

        a, b = b"content-alpha-payload", b"content-beta-payload"
        barrier = threading.Barrier(2)
        results = {}

        def worker(key, payload):
            barrier.wait()
            results[key] = self._upload(client, payload).status_code

        t1 = threading.Thread(target=worker, args=("a", a))
        t2 = threading.Thread(target=worker, args=("b", b))
        t1.start()
        t2.start()
        t1.join(timeout=30)
        t2.join(timeout=30)

        assert sorted(results.values()) == [200, 409]
        winner = a if results["a"] == 200 else b
        artifact = tmp_packages_dir / "race-pkg" / "race-pkg-1.0.0.whl"
        assert artifact.read_bytes() == winner
        sidecar = artifact.with_name(artifact.name + ".sha256")
        assert sidecar.read_text().strip() == hashlib.sha256(winner).hexdigest()
        # no temp upload files left behind by the loser
        leftovers = [f.name for f in (tmp_packages_dir / "race-pkg").iterdir()
                     if f.name.endswith(".upload")]
        assert leftovers == []

    def test_concurrent_same_content_both_succeed(self, client, tmp_packages_dir):
        """Identical bytes racing are idempotent: winner 200, loser sees the
        same sha256 and also gets 200 (unchanged)."""
        import threading

        payload = b"identical wheel bytes"
        barrier = threading.Barrier(2)
        results = {}

        def worker(key):
            barrier.wait()
            results[key] = self._upload(client, payload).status_code

        threads = [threading.Thread(target=worker, args=(k,)) for k in ("a", "b")]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

        assert results == {"a": 200, "b": 200}
        artifact = tmp_packages_dir / "race-pkg" / "race-pkg-1.0.0.whl"
        assert artifact.read_bytes() == payload

    def test_stale_precheck_cannot_bypass_the_guard(self, client, tmp_packages_dir, monkeypatch):
        """Deterministic TOCTOU regression: force Path.exists() to lie
        (simulating the racing writer that passed the pre-check before the
        winner published). The old code trusted the pre-check and silently
        overwrote via os.replace; the os.link path must still return 409 and
        leave the published artifact untouched."""
        import hashlib

        original = b"published-original"
        assert self._upload(client, original).status_code == 200

        monkeypatch.setattr(Path, "exists", lambda self: False)
        resp = self._upload(client, b"evil-replacement")
        assert resp.status_code == 409
        assert "sha256" in resp.json()["detail"]

        artifact = tmp_packages_dir / "race-pkg" / "race-pkg-1.0.0.whl"
        assert artifact.read_bytes() == original
        assert artifact.with_name(artifact.name + ".sha256").read_text().strip() == \
            hashlib.sha256(original).hexdigest()


class TestUploadSizeLimit:
    """S10: direct uploads are capped at 50 MB (parity with the admin-api
    proxy's multer limit). Exceeding it returns 413 and leaves no partial
    artifact — neither the destination nor a leftover .upload temp file."""

    def test_oversized_upload_rejected_413(self, client, tmp_packages_dir, monkeypatch):
        import main as app_module
        # Two chunks: the first fits, the second crosses the cumulative cap.
        monkeypatch.setattr(app_module, "MAX_UPLOAD_BYTES",
                            app_module.HASH_CHUNK_SIZE + 1)
        chunk = b"x" * app_module.HASH_CHUNK_SIZE
        payload = chunk + chunk  # 2 MiB > 1 MiB + 1 cap
        resp = client.post("/", auth=AUTH,
                           data={"name": "big-pkg", "version": "1.0"},
                           files={"content": ("big-pkg-1.0.whl", payload,
                                              "application/octet-stream")})
        assert resp.status_code == 413

    def test_oversized_upload_leaves_no_partial_file(self, client, tmp_packages_dir, monkeypatch):
        import main as app_module
        monkeypatch.setattr(app_module, "MAX_UPLOAD_BYTES",
                            app_module.HASH_CHUNK_SIZE + 1)
        chunk = b"x" * app_module.HASH_CHUNK_SIZE
        payload = chunk + chunk
        client.post("/", auth=AUTH,
                    data={"name": "big-pkg", "version": "1.0"},
                    files={"content": ("big-pkg-1.0.whl", payload,
                                       "application/octet-stream")})
        # No published artifact, no sidecar, no .upload temp leftover.
        # B-6：Content-Length 预检短路后**连包目录都不会创建**（此前 handler
        # 内 pkg_dir 先建目录、流式累计才触发 413）——目录可能不存在，存在则
        # 必须为空；用 glob（对不存在目录返回空）而非 iterdir。
        pkg = tmp_packages_dir / "big-pkg"
        assert not (pkg / "big-pkg-1.0.whl").exists()
        assert not (pkg / "big-pkg-1.0.whl.sha256").exists()
        leftovers = [f.name for f in pkg.glob("*")
                     if f.name.endswith(".upload")]
        assert leftovers == []
        assert list(pkg.glob("*")) == [], \
            "only the (pre-created) empty package dir may exist — no files"

    def test_upload_just_under_limit_succeeds(self, client, tmp_packages_dir, monkeypatch):
        """Boundary: a payload exactly at the cap must still be accepted
        (cumulative total, not > cap)."""
        import hashlib
        import main as app_module
        monkeypatch.setattr(app_module, "MAX_UPLOAD_BYTES", 8)
        payload = b"12345678"  # exactly 8 bytes == cap
        resp = client.post("/", auth=AUTH,
                           data={"name": "edge-pkg", "version": "1.0"},
                           files={"content": ("edge-pkg-1.0.whl", payload,
                                              "application/octet-stream")})
        assert resp.status_code == 200
        artifact = tmp_packages_dir / "edge-pkg" / "edge-pkg-1.0.whl"
        assert artifact.read_bytes() == payload
        assert artifact.with_name(artifact.name + ".sha256").read_text().strip() == \
            hashlib.sha256(payload).hexdigest()


class TestEggRejected:
    """S11: the .egg contract is removed from the registry to match the
    admin-api proxy whitelist (.whl/.tar.gz/.zip only)."""

    @pytest.mark.parametrize("path", ["/", "/upload"])
    def test_egg_upload_rejected(self, client, path):
        resp = client.post(path, auth=AUTH,
                           data={"name": "legacy-egg", "version": "1.0"},
                           files={"content": ("legacy-egg-1.0.egg", b"egg bytes",
                                              "application/octet-stream")})
        assert resp.status_code == 400

    def test_all_still_accepted_formats_unchanged(self, client):
        for fname in ("fmt-pkg-1.0.whl", "fmt-pkg-1.0.tar.gz", "fmt-pkg-1.0.zip"):
            resp = client.post("/", auth=AUTH,
                               data={"name": "fmt-pkg", "version": "1.0"},
                               files={"content": (fname, b"fmt bytes",
                                                  "application/octet-stream")})
            assert resp.status_code == 200, fname


class TestRootIndex:
    """FEAT-12: GET / 人类可读落地页（HTML 索引 + 服务信息）。"""

    def test_root_requires_auth(self, client):
        # S9 一致性：索引面一律要求认证，/ 不应是匿名枚举入口
        resp = client.get("/")
        assert resp.status_code == 401

    def test_root_returns_html_with_service_info(self, client):
        resp = client.get("/", auth=AUTH)
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "text/html; charset=utf-8"
        # 服务信息：标题 + 简短说明 + pip 用法
        assert "AutoFlow PyPI Registry" in resp.text
        assert "PEP 503" in resp.text
        assert "pip install" in resp.text

    def test_root_lists_packages_with_links_to_simple(self, client):
        client.post("/", auth=AUTH,
                    data={"name": "homepage-pkg", "version": "1.0.0"},
                    files={"content": ("homepage-pkg-1.0.0.whl", b"x",
                                       "application/octet-stream")})
        resp = client.get("/", auth=AUTH)
        assert "homepage-pkg" in resp.text
        assert 'href="/simple/homepage-pkg/"' in resp.text
        # 包数量
        assert "1 个包" in resp.text

    def test_root_lists_packages_alphabetically(self, client):
        for name, fname in (("beta-pkg", "beta-pkg-1.0.0.whl"),
                            ("alpha-pkg", "alpha-pkg-1.0.0.whl")):
            client.post("/", auth=AUTH,
                        data={"name": name, "version": "1.0.0"},
                        files={"content": (fname, b"x",
                                           "application/octet-stream")})
        resp = client.get("/", auth=AUTH)
        assert resp.text.index("alpha-pkg") < resp.text.index("beta-pkg")

    def test_root_empty_state(self, client):
        resp = client.get("/", auth=AUTH)
        assert resp.status_code == 200
        assert "暂无" in resp.text

    def test_root_no_external_resources(self, client):
        """零外部资源：离线私服不得引用任何 CDN/远程脚本/字体。"""
        client.post("/", auth=AUTH,
                    data={"name": "offline-pkg", "version": "1.0.0"},
                    files={"content": ("offline-pkg-1.0.0.whl", b"x",
                                       "application/octet-stream")})
        for path in ("/", "/simple/", "/simple/offline-pkg/"):
            resp = client.get(path, auth=AUTH)
            lower = resp.text.lower()
            assert "<script" not in lower
            assert "<link " not in lower
            assert 'src="http' not in lower
            assert "url(" not in lower
            assert "cdn." not in lower

    def test_index_pages_cache_headers(self, client):
        # 缓存取舍：no-cache——索引必须在 CI 上传后立即可见，陈旧索引会让
        # pip 漏掉刚推送的版本；页面为 KB 级静态拼装，回源代价可忽略。
        client.post("/", auth=AUTH,
                    data={"name": "cache-pkg", "version": "1.0.0"},
                    files={"content": ("cache-pkg-1.0.0.whl", b"x",
                                       "application/octet-stream")})
        for path in ("/", "/simple/", "/simple/cache-pkg/"):
            resp = client.get(path, auth=AUTH)
            assert resp.headers["cache-control"] == "no-cache"

    def test_index_pages_content_type(self, client):
        client.post("/", auth=AUTH,
                    data={"name": "ct-pkg", "version": "1.0.0"},
                    files={"content": ("ct-pkg-1.0.0.whl", b"x",
                                       "application/octet-stream")})
        for path in ("/", "/simple/", "/simple/ct-pkg/"):
            resp = client.get(path, auth=AUTH)
            assert resp.headers["content-type"] == "text/html; charset=utf-8"


class TestIndexEscaping:
    """FEAT-12 XSS 加固：包名/文件名/版本号来自用户上传，normalize() 不剥离
    <>&'" 等字符，HTML 输出必须全部转义。"""

    def test_render_functions_escape_malicious_names(self):
        # 单测注入：渲染层 escape 验证（不依赖文件系统对 <> 的支持，
        # Windows 测试环境无法创建含 < 的目录名）
        import main as app_module

        html = app_module._render_root_index(
            ['<script>alert("xss")</script>&pkg'], 3)
        assert "<script>" not in html
        assert "&lt;script&gt;" in html
        assert 'href="/simple/&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;&amp;pkg/"' in html

        html = app_module._render_simple_index(
            ['<img src=x onerror=alert(1)>'], [1], 1)
        assert "<img " not in html
        assert "&lt;img" in html

        html = app_module._render_package_index(
            "evil&pkg",
            [("1.0<2", '<script>alert(1)</script>-1.0.whl',
              "a" * 64, "1 B", "2026-01-01 00:00")],
            1, 1)
        assert "<script>" not in html
        assert "&lt;script&gt;alert(1)&lt;/script&gt;-1.0.whl" in html
        assert "#sha256=" + "a" * 64 in html  # sha256 为服务端计算的 hex，不受影响

    def test_page_title_escapes_package_name(self, client, tmp_packages_dir):
        # Windows/Linux 均合法的 & 注入：目录直接落盘（绕过上传层），
        # GET /simple/x&y/ 的路径参数反射进 <h1>/<title> 时必须转义
        pkg = tmp_packages_dir / "x&y"
        pkg.mkdir()
        (pkg / "x&y-1.0.0.zip").write_bytes(b"payload")
        resp = client.get("/simple/x&y/", auth=AUTH)
        assert resp.status_code == 200
        assert "<title>Links for x&amp;y</title>" in resp.text
        assert "<h1>Links for x&amp;y</h1>" in resp.text
        # 未转义的原始形式不得出现在任何标题/文本位置
        assert "Links for x&y<" not in resp.text

    def test_index_escapes_uploaded_filenames(self, client):
        # 文件名同样可控（上传层只校验扩展名）：& 必须转义
        resp = client.post("/", auth=AUTH,
                           data={"name": "esc-pkg", "version": "1.0"},
                           files={"content": ("esc-pkg-1.0-&.zip", b"x",
                                              "application/octet-stream")})
        assert resp.status_code == 200
        page = client.get("/simple/esc-pkg/", auth=AUTH)
        assert "esc-pkg-1.0-&amp;.zip" in page.text
        # 锚点 href 仍完整（转义后的实体在属性内，pip/浏览器解析一致）
        assert 'href="/packages/esc-pkg/esc-pkg-1.0-&amp;.zip#sha256=' in page.text
        root = client.get("/", auth=AUTH)
        assert "esc-pkg" in root.text
        assert "esc-pkg-1.0-&" not in root.text  # 根页不含文件名，原始 & 不泄漏

    def test_simple_index_escapes_package_names(self, client, tmp_packages_dir):
        pkg = tmp_packages_dir / "a&b"
        pkg.mkdir()
        (pkg / "a&b-1.0.0.zip").write_bytes(b"payload")
        resp = client.get("/simple/", auth=AUTH)
        assert 'href="/simple/a&amp;b/">a&amp;b</a>' in resp.text

    def test_root_escapes_package_names(self, client, tmp_packages_dir):
        pkg = tmp_packages_dir / "a&b"
        pkg.mkdir()
        (pkg / "a&b-1.0.0.zip").write_bytes(b"payload")
        resp = client.get("/", auth=AUTH)
        assert 'href="/simple/a&amp;b/">a&amp;b</a>' in resp.text


class TestPackageIndexPipCompat:
    """FEAT-12 回归护栏：/simple/<name>/ 的锚点结构必须保持 pip 消费兼容
    （admin-api parsePypiIndex 也按 <a> 锚点文本解析包名）。"""

    def test_anchor_structure_survives_html_upgrade(self, client):
        import hashlib
        import re
        payload = b"compat bytes"
        client.post("/", auth=AUTH,
                    data={"name": "compat-pkg", "version": "1.0.0"},
                    files={"content": ("compat-pkg-1.0.0-py3-none-any.whl",
                                       payload, "application/octet-stream")})
        resp = client.get("/simple/compat-pkg/", auth=AUTH)
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "text/html; charset=utf-8"
        # pip 消费契约：href 指向 /packages/<file> 且带 sha256 片段
        expected_sha = hashlib.sha256(payload).hexdigest()
        assert (f'href="/packages/compat-pkg/compat-pkg-1.0.0-py3-none-any.whl'
                f'#sha256={expected_sha}"') in resp.text
        # 锚点文本仍为纯文件名（无内嵌标签），正则解析器可提取
        m = re.search(r'<a[^>]*>([^<]+)</a>', resp.text)
        assert m is not None
        assert m.group(1) == "compat-pkg-1.0.0-py3-none-any.whl"

    def test_simple_index_anchor_structure_survives_html_upgrade(self, client):
        import re
        client.post("/", auth=AUTH,
                    data={"name": "compat-idx", "version": "1.0.0"},
                    files={"content": ("compat-idx-1.0.0.whl", b"x",
                                       "application/octet-stream")})
        resp = client.get("/simple/", auth=AUTH)
        assert 'href="/simple/compat-idx/"' in resp.text
        m = re.search(r'<a[^>]*>([^<]+)</a>', resp.text)
        assert m is not None
        assert m.group(1) == "compat-idx"

    def test_version_sort_survives_unparseable_version(self, client):
        # 回归：此前 _version_key 对混合 int/str 段会抛 TypeError——文件名
        # 解析不出版本号（得 "-"）与正常版本同页排序即 500
        client.post("/", auth=AUTH,
                    data={"name": "sort-pkg", "version": "1.0"},
                    files={"content": ("sort-pkg-1.0.0.zip", b"x",
                                       "application/octet-stream")})
        client.post("/", auth=AUTH,
                    data={"name": "sort-pkg", "version": "1.0"},
                    files={"content": ("weird.zip", b"y",
                                       "application/octet-stream")})
        resp = client.get("/simple/sort-pkg/", auth=AUTH)
        assert resp.status_code == 200
        assert "1.0.0" in resp.text
        assert "weird.zip" in resp.text


# E-10（DEEP_REVIEW 0ef3bbe）：fail-closed 凭据守卫——未配置 REGISTRY_PASS
# 或仍用内置默认弱口令时拒绝启动（sys.exit(1)），而非 warn-and-continue。
class TestFailClosedCredentials:
    def test_exits_when_no_registry_pass(self, monkeypatch, tmp_path):
        monkeypatch.delenv("REGISTRY_PASS", raising=False)
        monkeypatch.delenv("ALLOW_DEFAULT_CREDS", raising=False)
        monkeypatch.setenv("REGISTRY_USER", "autoflow")
        monkeypatch.setenv("PACKAGES_DIR", str(tmp_path))
        import sys
        sys.modules.pop("main", None)
        with pytest.raises(SystemExit) as exc_info:
            import main  # noqa: F401
        assert exc_info.value.code == 1

    def test_exits_when_default_credentials(self, monkeypatch, tmp_path):
        monkeypatch.setenv("REGISTRY_USER", "autoflow")
        monkeypatch.setenv("REGISTRY_PASS", "autoflow123")
        monkeypatch.delenv("ALLOW_DEFAULT_CREDS", raising=False)
        monkeypatch.setenv("PACKAGES_DIR", str(tmp_path))
        import sys
        sys.modules.pop("main", None)
        with pytest.raises(SystemExit) as exc_info:
            import main  # noqa: F401
        assert exc_info.value.code == 1

    def test_starts_with_allow_default_creds(self, monkeypatch, tmp_path):
        monkeypatch.setenv("REGISTRY_USER", "autoflow")
        monkeypatch.setenv("REGISTRY_PASS", "autoflow123")
        monkeypatch.setenv("ALLOW_DEFAULT_CREDS", "1")
        monkeypatch.setenv("PACKAGES_DIR", str(tmp_path))
        import sys
        sys.modules.pop("main", None)
        import main as app_module
        assert app_module.REGISTRY_PASS == "autoflow123"

    def test_starts_with_custom_credentials(self, monkeypatch, tmp_path):
        monkeypatch.setenv("REGISTRY_USER", "customuser")
        monkeypatch.setenv("REGISTRY_PASS", "custompass")
        monkeypatch.delenv("ALLOW_DEFAULT_CREDS", raising=False)
        monkeypatch.setenv("PACKAGES_DIR", str(tmp_path))
        import sys
        sys.modules.pop("main", None)
        import main as app_module
        assert app_module.REGISTRY_USER == "customuser"
        assert app_module.REGISTRY_PASS == "custompass"


# ---------------------------------------------------------------------------
# E-39（DEEP_REVIEW 0ef3bbe）：CORS 从 allow_origins=["*"] 收紧为显式白名单
# （env REGISTRY_CORS_ORIGINS），未配置时不挂 CORS 中间件。
# ---------------------------------------------------------------------------


class TestCorsLockdownE39:
    """Basic-auth 接口配 `*` 收益为零（浏览器不会跨域携带 Basic 凭据），却把
    预检面开放给任意站点；pip/twine 根本不走 CORS。"""

    @staticmethod
    def _fresh_client(monkeypatch, tmp_path, origins):
        pkg = tmp_path / "packages"
        pkg.mkdir(exist_ok=True)
        monkeypatch.setenv("PACKAGES_DIR", str(pkg))
        monkeypatch.setenv("REGISTRY_USER", "testuser")
        monkeypatch.setenv("REGISTRY_PASS", "testpass")
        if origins is None:
            monkeypatch.delenv("REGISTRY_CORS_ORIGINS", raising=False)
        else:
            monkeypatch.setenv("REGISTRY_CORS_ORIGINS", origins)
        import sys
        sys.modules.pop("main", None)
        import main as app_module
        app_module.PACKAGES_DIR = pkg
        app_module.REGISTRY_USER = "testuser"
        app_module.REGISTRY_PASS = "testpass"
        return TestClient(app_module.app)

    def test_no_cors_headers_when_unconfigured(self, monkeypatch, tmp_path):
        client = self._fresh_client(monkeypatch, tmp_path, None)

        resp = client.get("/health", headers={"Origin": "http://evil.example"})

        assert "access-control-allow-origin" not in {k.lower() for k in resp.headers}

    def test_wildcard_origin_is_never_emitted(self, monkeypatch, tmp_path):
        client = self._fresh_client(monkeypatch, tmp_path, None)

        resp = client.options("/simple/", headers={
            "Origin": "http://evil.example",
            "Access-Control-Request-Method": "GET",
        })

        assert resp.headers.get("access-control-allow-origin") != "*"

    def test_allowlisted_origin_is_echoed(self, monkeypatch, tmp_path):
        client = self._fresh_client(monkeypatch, tmp_path, "http://localhost:5176")

        resp = client.options("/simple/", headers={
            "Origin": "http://localhost:5176",
            "Access-Control-Request-Method": "GET",
        })

        assert resp.headers.get("access-control-allow-origin") == "http://localhost:5176"

    def test_non_allowlisted_origin_is_refused(self, monkeypatch, tmp_path):
        client = self._fresh_client(monkeypatch, tmp_path, "http://localhost:5176")

        resp = client.options("/simple/", headers={
            "Origin": "http://evil.example",
            "Access-Control-Request-Method": "GET",
        })

        assert resp.headers.get("access-control-allow-origin") is None

    def test_multiple_origins_are_parsed_and_trimmed(self, monkeypatch, tmp_path):
        client = self._fresh_client(
            monkeypatch, tmp_path, " http://localhost:5176 , http://localhost:4173 ")

        for origin in ("http://localhost:5176", "http://localhost:4173"):
            resp = client.options("/simple/", headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
            })
            assert resp.headers.get("access-control-allow-origin") == origin


# ---------------------------------------------------------------------------
# E-39（续）：POST / 是唯一实现（twine 契约），/upload 是它的薄 alias——
# 鉴权、格式白名单、体积上限、sha256 sidecar、409 防覆盖必须完全一致。
# ---------------------------------------------------------------------------


class TestUploadEndpointAliasE39:
    def test_both_endpoints_share_the_response_shape(self, client):
        root = client.post("/", auth=AUTH,
                           data={"name": "alias-a", "version": "1.0.0"},
                           files={"content": ("alias-a-1.0.0.whl", b"a-bytes",
                                              "application/octet-stream")})
        alias = client.post("/upload", auth=AUTH,
                            data={"name": "alias-b", "version": "1.0.0"},
                            files={"content": ("alias-b-1.0.0.whl", b"b-bytes",
                                               "application/octet-stream")})

        assert root.status_code == alias.status_code == 200
        assert set(root.json()) == set(alias.json()) == {"message", "package", "version"}
        assert root.json()["message"] == "Uploaded alias-a-1.0.0.whl"
        assert alias.json()["message"] == "Uploaded alias-b-1.0.0.whl"

    def test_alias_requires_the_same_auth(self, client):
        resp = client.post("/upload", data={"name": "pkg", "version": "1.0"},
                           files={"content": ("pkg-1.0.whl", b"data",
                                              "application/octet-stream")})

        assert resp.status_code == 401
        assert resp.json() == {"detail": "Unauthorized"}

    def test_alias_rejects_non_basic_schemes(self, client):
        resp = client.post("/upload", headers={"Authorization": "Bearer nope"},
                           data={"name": "pkg", "version": "1.0"},
                           files={"content": ("pkg-1.0.whl", b"data",
                                              "application/octet-stream")})

        assert resp.status_code == 401

    def test_alias_shares_the_size_cap(self, client, tmp_path, monkeypatch):
        import main as app_module
        monkeypatch.setattr(app_module, "MAX_UPLOAD_BYTES", 4)

        resp = client.post("/upload", auth=AUTH,
                           data={"name": "big-alias", "version": "1.0"},
                           files={"content": ("big-alias-1.0.whl", b"123456789",
                                              "application/octet-stream")})

        assert resp.status_code == 413

    def test_alias_shares_the_format_whitelist(self, client):
        resp = client.post("/upload", auth=AUTH,
                           data={"name": "fmt-alias", "version": "1.0"},
                           files={"content": ("fmt-alias-1.0.egg", b"egg",
                                              "application/octet-stream")})

        assert resp.status_code == 400
        assert "Invalid package format" in resp.json()["detail"]

    def test_alias_writes_the_same_sidecar_and_index_entry(self, client, tmp_packages_dir):
        import hashlib
        payload = b"alias sidecar bytes"
        resp = client.post("/upload", auth=AUTH,
                           data={"name": "alias-sc", "version": "2.0.0"},
                           files={"content": ("alias-sc-2.0.0.whl", payload,
                                              "application/octet-stream")})
        assert resp.status_code == 200

        sidecar = tmp_packages_dir / "alias-sc" / "alias-sc-2.0.0.whl.sha256"
        assert sidecar.read_text().strip() == hashlib.sha256(payload).hexdigest()
        index = client.get("/simple/alias-sc/", auth=AUTH)
        assert f"#sha256={hashlib.sha256(payload).hexdigest()}" in index.text

    def test_alias_and_root_are_the_same_resource(self, client, tmp_packages_dir):
        """同一 (name, filename) 先走 / 再走 /upload：命中同一个 409 防覆盖闸，
        证明两个路径写的是同一份存储而不是两套逻辑。"""
        payload = b"same artifact"
        assert client.post("/", auth=AUTH,
                           data={"name": "alias-same", "version": "1.0.0"},
                           files={"content": ("alias-same-1.0.0.whl", payload,
                                              "application/octet-stream")}).status_code == 200

        resp = client.post("/upload", auth=AUTH,
                           data={"name": "alias-same", "version": "1.0.0"},
                           files={"content": ("alias-same-1.0.0.whl", b"different",
                                              "application/octet-stream")})

        assert resp.status_code == 409
        assert "sha256" in resp.json()["detail"]
        artifact = tmp_packages_dir / "alias-same" / "alias-same-1.0.0.whl"
        assert artifact.read_bytes() == payload


# ---------------------------------------------------------------------------
# D1-P2-4：GET / 与 GET /simple/ 此前裸用 PACKAGES_DIR.iterdir()——目录被删/
# 不可读时迭代直接抛 OSError → 500。两处现已共用带 OSError 守卫且排序的
# _all_package_dirs()。这里钉死守卫行为：枚举失败返回空列表而非上抛，且
# 正常 listing 保持按名排序。
# ---------------------------------------------------------------------------
class TestAllPackageDirsGuard:
    def test_iterdir_oserror_returns_empty_list(self, monkeypatch):
        import main as app_module

        class _BoomDir:
            def iterdir(self):
                raise OSError("permission denied on packages dir")

        monkeypatch.setattr(app_module, "PACKAGES_DIR", _BoomDir())
        assert app_module._all_package_dirs() == []

    def test_normal_listing_sorted_by_name(self, tmp_packages_dir, monkeypatch):
        import main as app_module
        # 端点读的是模块属性——与 client fixture 同法 patch 到隔离目录。
        monkeypatch.setattr(app_module, "PACKAGES_DIR", tmp_packages_dir)
        (tmp_packages_dir / "b-pkg").mkdir()
        (tmp_packages_dir / "a-pkg").mkdir()
        (tmp_packages_dir / "c-pkg").mkdir()
        names = [d.name for d in app_module._all_package_dirs()]
        assert names == ["a-pkg", "b-pkg", "c-pkg"]

    def test_root_and_simple_endpoints_survive_broken_enumeration(self, client, monkeypatch):
        """端点层反证：枚举失败时 / 与 /simple/ 不再 500，而是渲染空索引(200)。"""
        import main as app_module

        class _BoomDir:
            def iterdir(self):
                raise OSError("removed")

        monkeypatch.setattr(app_module, "PACKAGES_DIR", _BoomDir())
        for path in ("/", "/simple/"):
            resp = client.get(path, auth=AUTH)
            assert resp.status_code == 200, f"{path} must not 500 on broken enumeration"


# ---------------------------------------------------------------------------
# B-4②: 根索引（/ 与 /simple/）单次遍历扫描——listing / 计数 / 校验器三处
# 消费同一份 _scan_package_entries() 结果（此前同一请求最多扫两三遍盘）。
# ---------------------------------------------------------------------------


class TestScanPackageEntries:
    def test_scan_sorted_with_file_counts(self, tmp_packages_dir, monkeypatch):
        import main as app_module
        monkeypatch.setattr(app_module, "PACKAGES_DIR", tmp_packages_dir)
        (tmp_packages_dir / "b-pkg").mkdir()
        (tmp_packages_dir / "a-pkg").mkdir()
        (tmp_packages_dir / "a-pkg" / "a-1.0.whl").write_bytes(b"x")
        (tmp_packages_dir / "a-pkg" / "a-1.0.whl.sha256").write_text("0" * 64)
        (tmp_packages_dir / "a-pkg" / "a-1.1.whl.upload").write_text("in-flight")
        entries = app_module._scan_package_entries()
        assert [e[0] for e in entries] == ["a-pkg", "b-pkg"]
        # sidecar / .upload 不计入（is_meta_file 语义保持）
        assert entries[0][3] == 1
        assert entries[1][3] == 0

    def test_root_state_composition_unchanged(self, tmp_packages_dir, monkeypatch):
        """ETag 组成与旧 _root_listing_state 一致：root-{int(latest)}-{dirs}-{files}，
        latest 取目录与制品 mtime 的最大值。"""
        import main as app_module
        monkeypatch.setattr(app_module, "PACKAGES_DIR", tmp_packages_dir)
        (tmp_packages_dir / "pkg").mkdir()
        (tmp_packages_dir / "pkg" / "p-1.0.whl").write_bytes(b"y")
        entries = app_module._scan_package_entries()
        etag, latest = app_module._root_state_from_entries(entries)
        dir_mtime = (tmp_packages_dir / "pkg").stat().st_mtime
        file_mtime = (tmp_packages_dir / "pkg" / "p-1.0.whl").stat().st_mtime
        assert etag == f'W/"root-{int(max(dir_mtime, file_mtime))}-1-1"'
        assert int(latest) == int(max(dir_mtime, file_mtime))

    def test_empty_root_uses_zero_latest(self, tmp_packages_dir, monkeypatch):
        """空仓回归：无包时 latest=0（max 的 default 分支），ETag 为 root-0-0-0。"""
        import main as app_module
        monkeypatch.setattr(app_module, "PACKAGES_DIR", tmp_packages_dir)
        etag, latest = app_module._root_state_from_entries(
            app_module._scan_package_entries())
        assert etag == 'W/"root-0-0-0"'
        assert latest == 0.0


# ---------------------------------------------------------------------------
# B-4①: DELETE /admin/packages/{name} —— 制品生命周期最小管理面（整包删除）。
# ---------------------------------------------------------------------------


class TestPackageDeletion:
    @staticmethod
    def _upload(client, name="del-pkg", filename="del-pkg-1.0.0.whl"):
        return client.post("/", auth=AUTH,
                           data={"name": name, "version": "1.0.0"},
                           files={"content": (filename, b"delete me",
                                              "application/octet-stream")})

    def test_delete_returns_204_and_removes_artifacts_and_sidecar(self, client, tmp_packages_dir):
        import hashlib
        assert self._upload(client).status_code == 200
        resp = client.delete("/admin/packages/del-pkg", auth=AUTH)
        assert resp.status_code == 204
        assert resp.content == b""
        # 包目录整体移除：制品、sha256 sidecar 与任何残留一并消失
        assert not (tmp_packages_dir / "del-pkg").exists()
        assert not (tmp_packages_dir / "del-pkg" / "del-pkg-1.0.0.whl.sha256").exists()

    def test_delete_requires_auth(self, client):
        assert self._upload(client).status_code == 200
        resp = client.delete("/admin/packages/del-pkg")
        assert resp.status_code == 401
        # 未删成：索引面仍在
        assert client.get("/simple/del-pkg/", auth=AUTH).status_code == 200

    def test_delete_missing_package_returns_404(self, client):
        resp = client.delete("/admin/packages/nonexistent", auth=AUTH)
        assert resp.status_code == 404

    def test_delete_unsafe_name_returns_404(self, client):
        # NETOPT-5⑥ 同闸同语义：非法名 404，不泄露闸的存在
        assert client.delete("/admin/packages/C:foo", auth=AUTH).status_code == 404

    def test_deleted_package_disappears_from_indexes(self, client):
        self._upload(client)
        for path in ("/", "/simple/"):
            assert "del-pkg" in client.get(path, auth=AUTH).text
        assert client.delete("/admin/packages/del-pkg", auth=AUTH).status_code == 204
        for path in ("/", "/simple/"):
            assert "del-pkg" not in client.get(path, auth=AUTH).text
        assert client.get("/simple/del-pkg/", auth=AUTH).status_code == 404

    def test_index_validators_change_after_deletion(self, client):
        """O-26 语义回归：删除改变 ETag——缓存端不会拿到陈旧索引。"""
        self._upload(client)
        before = client.get("/simple/", auth=AUTH).headers["etag"]
        assert client.delete("/admin/packages/del-pkg", auth=AUTH).status_code == 204
        after = client.get("/simple/", auth=AUTH).headers["etag"]
        assert before != after

    def test_delete_then_reupload_same_name_succeeds(self, client, tmp_packages_dir):
        """生命周期闭环：删除释放包名后可重新上传（409 闸只挡未删除的覆盖）。"""
        payload = b"v1 bytes"
        assert client.post("/", auth=AUTH, data={"name": "cycle-pkg", "version": "1.0"},
                           files={"content": ("cycle-pkg-1.0.whl", payload,
                                              "application/octet-stream")}).status_code == 200
        assert client.delete("/admin/packages/cycle-pkg", auth=AUTH).status_code == 204
        resp = client.post("/", auth=AUTH, data={"name": "cycle-pkg", "version": "2.0"},
                           files={"content": ("cycle-pkg-2.0.whl", payload,
                                              "application/octet-stream")})
        assert resp.status_code == 200
        assert (tmp_packages_dir / "cycle-pkg" / "cycle-pkg-2.0.whl").is_file()

    def test_delete_normalizes_name(self, client, tmp_packages_dir):
        # My_Pkg → my-pkg 归一化删除，与上传/索引侧同语义
        assert client.post("/", auth=AUTH, data={"name": "My_Pkg", "version": "1.0"},
                           files={"content": ("my-pkg-1.0.whl", b"x",
                                              "application/octet-stream")}).status_code == 200
        assert client.delete("/admin/packages/My_Pkg", auth=AUTH).status_code == 204
        assert not (tmp_packages_dir / "my-pkg").exists()


# ---------------------------------------------------------------------------
# B-6: upload 面的 Content-Length 预检中间件——超限 413 短路，不进入
# multipart 解析（此前 50MB 上限要等 handler 逐块累加才判）。
# ---------------------------------------------------------------------------


class TestContentLengthPrecheck:
    OVERSIZED = str(999 * 1024 * 1024)

    def test_oversized_content_length_short_circuits_413(self, client, tmp_packages_dir):
        resp = client.post("/", auth=AUTH,
                           headers={"content-length": self.OVERSIZED},
                           data={"name": "big-cl", "version": "1.0"},
                           files={"content": ("big-cl-1.0.whl", b"tiny",
                                              "application/octet-stream")})
        assert resp.status_code == 413
        assert "limit" in resp.json()["detail"]
        # 短路意味着没有进入 multipart 解析：不产生任何包目录/临时文件
        assert not (tmp_packages_dir / "big-cl").exists()
        assert list(tmp_packages_dir.glob("*")) == []

    def test_alias_endpoint_gets_the_same_precheck(self, client):
        # /upload 是薄 alias（E-39），预检必须同覆盖
        resp = client.post("/upload", auth=AUTH,
                           headers={"content-length": self.OVERSIZED},
                           data={"name": "big-cl", "version": "1.0"},
                           files={"content": ("big-cl-1.0.whl", b"tiny",
                                              "application/octet-stream")})
        assert resp.status_code == 413

    def test_precheck_is_scoped_to_upload_routes(self, client, tmp_packages_dir):
        """预检只拦上传面（POST|PUT 的 / 与 /upload）；索引面同头照常 200。"""
        pkg = tmp_packages_dir / "scoped"
        pkg.mkdir()
        (pkg / "scoped-1.0.0.whl").write_bytes(b"x")
        resp = client.get("/simple/scoped/", auth=AUTH,
                          headers={"content-length": self.OVERSIZED})
        assert resp.status_code == 200

    def test_malformed_content_length_falls_through(self, client, tmp_packages_dir):
        """畸形 Content-Length 不预检（交给底层/流式闸），不 500。"""
        pkg = tmp_packages_dir / "weird-cl"
        pkg.mkdir()
        (pkg / "weird-cl-1.0.0.whl").write_bytes(b"x")
        resp = client.get("/simple/weird-cl/", auth=AUTH,
                          headers={"content-length": "not-a-number"})
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# R90-A1（registry-pypi 私有上传面安全审计）
#
# 本服务是「接受包上传」的面，此前从未被系统审计。以下四组用例分别钉住四条
# 判定表里的缺口（先红后绿，均已做过还原反证）：
#   ① 上传面：用户可控的 filename 直接成为落盘名与 mkstemp 前缀——超过
#      NAME_MAX 的名字让 mkstemp 抛 OSError 逃逸成 500；Windows/URL 敌对字符
#      同样 500，或（Linux）产生 href 里带 ?/#/% 的坏锚点。
#   ② 下载面：/packages/<pkg>/<file> 只做 is_file 判定，索引侧用的
#      is_meta_file 闸没跟到下载侧——.sha256 sidecar 与**并发上传中的
#      .upload 半成品**都能被整段读走。
#   ③ 大小/失败面：pkg_dir 在流式累计闸之前就 mkdir，413 之后空包目录永久
#      留在盘上 → 根索引/包索引里出现「幻影包」。
#   ④ 审计面：本仓 audit 目录登记了 registry.pypi.upload，但那个 action 只由
#      admin-api 的代理（apps/admin-api/src/modules/registry/registry.controller.ts
#      的 recordUploadAudit）写；**直连 8003 的上传（twine 默认行为）不留任何
#      痕迹**——main.py 此前一条日志/审计都没有。
# ---------------------------------------------------------------------------

AUDIT_LOGGER_NAME = "audit.registry.pypi"
AUDIT_ACTION = "registry.pypi.upload"


def _audit_records(caplog):
    """从 caplog 里取本服务写的审计行（JSON），忽略其它 logger 的噪声。"""
    import json
    out = []
    for record in caplog.records:
        if record.name != AUDIT_LOGGER_NAME:
            continue
        try:
            out.append(json.loads(record.getMessage()))
        except ValueError:  # 非 JSON 行不是审计记录
            continue
    return out


def json_dumps_lower(obj) -> str:
    import json
    return json.dumps(obj, ensure_ascii=False).lower()


@pytest.fixture()
def audit_caplog(caplog):
    import logging
    caplog.set_level(logging.INFO, logger=AUDIT_LOGGER_NAME)
    return caplog


class TestR90A1UploadAudit:
    """④ 上传必须落 registry.pypi.upload 审计（成功与失败都要有）。"""

    def test_successful_upload_emits_audit_record(self, client, audit_caplog):
        resp = client.post("/", auth=AUTH,
                           data={"name": "audit-pkg", "version": "1.2.3"},
                           files={"content": ("audit-pkg-1.2.3.whl", b"payload",
                                              "application/octet-stream")})
        assert resp.status_code == 200
        records = _audit_records(audit_caplog)
        assert len(records) == 1, records
        rec = records[0]
        assert rec["action"] == AUDIT_ACTION
        assert rec["result"] == "success"
        assert rec["user"] == AUTH[0]
        assert rec["package"] == "audit-pkg"
        assert rec["version"] == "1.2.3"
        assert rec["filename"] == "audit-pkg-1.2.3.whl"
        assert rec["size"] == len(b"payload")
        import hashlib
        assert rec["sha256"] == hashlib.sha256(b"payload").hexdigest()

    def test_audit_record_never_contains_the_password(self, client, audit_caplog):
        """审计行会进日志聚合：口令绝不能随行。"""
        client.post("/", auth=AUTH,
                    data={"name": "audit-pw", "version": "1.0"},
                    files={"content": ("audit-pw-1.0.whl", b"x",
                                       "application/octet-stream")})
        raw = "\n".join(r.getMessage() for r in audit_caplog.records
                        if r.name == AUDIT_LOGGER_NAME)
        assert AUTH[1] not in raw
        assert "password" not in raw.lower()

    def test_unauthorized_upload_is_not_a_credential_submission(self, client, audit_caplog):
        """401 是「凭据不对」，不该被记成一次上传尝试的内容（避免伪造审计）。"""
        resp = client.post("/", auth=BAD_AUTH,
                           data={"name": "audit-401", "version": "1.0"},
                           files={"content": ("audit-401-1.0.whl", b"x",
                                              "application/octet-stream")})
        assert resp.status_code == 401
        assert _audit_records(audit_caplog) == []

    @pytest.mark.parametrize("file_tuple,data,reason_code", [
        (("bad-1.0.exe", b"x", "application/octet-stream"),
         {"name": "audit-bad", "version": "1.0"}, "invalid_format"),
        (("probe-1.0.whl", b"x", "application/octet-stream"),
         {"name": "/tmp/audit-escape", "version": "1.0"}, "invalid_package_name"),
    ])
    def test_rejected_upload_emits_failure_audit(self, client, audit_caplog,
                                                 file_tuple, data, reason_code):
        resp = client.post("/", auth=AUTH, data=data,
                           files={"content": file_tuple})
        assert resp.status_code == 400
        records = _audit_records(audit_caplog)
        assert len(records) == 1, records
        assert records[0]["result"] == "failure"
        assert records[0]["action"] == AUDIT_ACTION
        # 失败原因用稳定码，不把内部路径/异常文本写进审计
        assert reason_code in json_dumps_lower(records[0])

    def test_conflict_upload_emits_failure_audit(self, client, audit_caplog):
        client.post("/", auth=AUTH, data={"name": "audit-cf", "version": "1.0"},
                    files={"content": ("audit-cf-1.0.whl", b"one",
                                       "application/octet-stream")})
        audit_caplog.clear()
        resp = client.post("/", auth=AUTH,
                           data={"name": "audit-cf", "version": "1.0"},
                           files={"content": ("audit-cf-1.0.whl", b"two",
                                              "application/octet-stream")})
        assert resp.status_code == 409
        records = _audit_records(audit_caplog)
        assert len(records) == 1, records
        assert records[0]["result"] == "failure"
        assert "conflict" in json_dumps_lower(records[0])

    def test_idempotent_reupload_is_audited_as_success_unchanged(self, client, audit_caplog):
        """幂等重传（同 sha）也必须留痕：它同样是「有人往仓库里推字节」。"""
        payload = b"same-bytes"
        for _ in range(2):
            assert client.post("/", auth=AUTH,
                               data={"name": "audit-idem", "version": "1.0"},
                               files={"content": ("audit-idem-1.0.whl", payload,
                                                  "application/octet-stream")}).status_code == 200
        records = _audit_records(audit_caplog)
        assert [r["result"] for r in records] == ["success", "success"]
        assert records[1].get("unchanged") is True

    def test_alias_endpoint_also_audits_once(self, client, audit_caplog):
        """/upload 是薄 alias：审计只能写一条，不能重复也不能漏。"""
        resp = client.post("/upload", auth=AUTH,
                           data={"name": "audit-alias", "version": "1.0"},
                           files={"content": ("audit-alias-1.0.whl", b"x",
                                              "application/octet-stream")})
        assert resp.status_code == 200
        records = _audit_records(audit_caplog)
        assert len(records) == 1, records
        assert records[0]["package"] == "audit-alias"


class TestR90A1FilenameGate:
    """① 上传面的 filename 闸：可控落盘名必须收敛成「安全、有界、URL 干净」。"""

    @pytest.mark.parametrize("bad_filename", [
        "pkg-1.0-" + "a" * 300 + ".whl",  # 超 NAME_MAX：mkstemp/落盘 OSError → 500
        "bad\x00name-1.0.whl",          # NUL：OS 层 ValueError/OSError
        "bad\nname-1.0.whl",            # 换行：日志/响应头注入面
        "bad#name-1.0.whl",             # 索引 href 的 fragment 分隔符（可篡改 #sha256）
        "bad?name-1.0.whl",             # query 分隔符：href 被截断 → 404
        "bad%2fname-1.0.whl",           # 已编码分隔符：二次解码面
        "bad:name-1.0.whl",             # 盘符形态 / Windows 非法
        "bad*name-1.0.whl",
        "bad|name-1.0.whl",
        r"..\..\evil-1.0.whl",          # 反斜杠：Windows 上是分隔符，Linux 上不是
    ])
    def test_hostile_filenames_rejected_with_400(self, client, tmp_packages_dir, bad_filename):
        resp = client.post("/", auth=AUTH,
                           data={"name": "gate-pkg", "version": "1.0"},
                           files={"content": (bad_filename, b"x",
                                              "application/octet-stream")})
        # 稳定 400（此前多种形态直接 500），且 detail 不泄露内部路径
        assert resp.status_code == 400, (bad_filename, resp.status_code, resp.text)
        assert "Internal Server Error" not in resp.text
        assert str(tmp_packages_dir) not in resp.text

    @pytest.mark.parametrize("good_filename", [
        "gate-ok-1.0.whl",
        "Gate_Ok-1.0.0-py3-none-any.whl",
        "gate-ok-1.0.tar.gz",
        "gate-ok-1.0-&.zip",            # & 在 HTML 里被转义，仍是合法文件名
        "gate-ok-1.0+build.7.whl",
        "gate.ok-1.0.whl",
    ])
    def test_legitimate_filenames_still_accepted(self, client, good_filename):
        """回归护栏：真实 wheel/sdist 命名形态（含 +、&、_、.）不受影响。"""
        resp = client.post("/", auth=AUTH,
                           data={"name": "gate-ok", "version": "1.0"},
                           files={"content": (good_filename, b"x",
                                              "application/octet-stream")})
        assert resp.status_code == 200, (good_filename, resp.text)

    def test_rejected_filename_leaves_no_partial_state(self, client, tmp_packages_dir):
        """被拒的上传不得留下包目录/临时文件（否则是幻影包 + 磁盘垃圾）。"""
        client.post("/", auth=AUTH,
                    data={"name": "gate-clean", "version": "1.0"},
                    files={"content": ("gate-clean-1.0-" + "a" * 300 + ".whl", b"x",
                                       "application/octet-stream")})
        pkg = tmp_packages_dir / "gate-clean"
        assert list(pkg.glob("*")) == []
        assert client.get("/simple/gate-clean/", auth=AUTH).status_code == 404


class TestR90A1MetaFileDownload:
    """② 下载面：索引侧过滤的元数据文件，下载侧也必须过滤。"""

    def test_sha256_sidecar_is_not_downloadable(self, client):
        assert client.post("/", auth=AUTH,
                           data={"name": "meta-pkg", "version": "1.0"},
                           files={"content": ("meta-pkg-1.0.whl", b"bytes",
                                              "application/octet-stream")}).status_code == 200
        # 制品本身照常可下
        assert client.get("/packages/meta-pkg/meta-pkg-1.0.whl", auth=AUTH).status_code == 200
        assert client.get("/packages/meta-pkg/meta-pkg-1.0.whl.sha256",
                          auth=AUTH).status_code == 404

    def test_inflight_upload_temp_file_is_not_downloadable(self, client, tmp_packages_dir):
        """上传中的 .upload 半成品被读走等于跨请求数据泄露。"""
        pkg = tmp_packages_dir / "meta-pkg"
        pkg.mkdir(parents=True, exist_ok=True)
        (pkg / "meta-pkg-2.0.whl").write_bytes(b"published")
        (pkg / "meta-pkg-2.0.whl.abc123.upload").write_bytes(b"IN-FLIGHT-SECRET")
        resp = client.get("/packages/meta-pkg/meta-pkg-2.0.whl.abc123.upload", auth=AUTH)
        assert resp.status_code == 404
        assert b"IN-FLIGHT-SECRET" not in resp.content

    def test_meta_download_still_requires_auth(self, client, tmp_packages_dir):
        pkg = tmp_packages_dir / "meta-pkg"
        pkg.mkdir(parents=True, exist_ok=True)
        (pkg / "meta-pkg-1.0.whl.sha256").write_text("0" * 64)
        assert client.get("/packages/meta-pkg/meta-pkg-1.0.whl.sha256",
                          auth=BAD_AUTH).status_code == 401


class TestR90A1FailedUploadLeavesNoPhantomPackage:
    """③ 413 之后不得让「幻影包」出现在索引里（枚举面 + 脏数据）。"""

    def test_streaming_413_leaves_no_package_dir(self, client, tmp_packages_dir, monkeypatch):
        """让 Content-Length 预检放行、由 handler 的流式累计闸触发 413。"""
        import main as m
        monkeypatch.setattr(m, "MAX_UPLOAD_BYTES", 4)
        resp = client.post("/", auth=AUTH, data={"name": "ghost-pkg", "version": "1.0"},
                           files={"content": ("ghost-pkg-1.0.whl", b"0123456789",
                                              "application/octet-stream")})
        assert resp.status_code == 413
        assert not (tmp_packages_dir / "ghost-pkg").exists(), \
            "failed upload must not leave an empty package dir behind"
        assert client.get("/simple/ghost-pkg/", auth=AUTH).status_code == 404
        assert "ghost-pkg" not in client.get("/simple/", auth=AUTH).text

    def test_cleanup_never_touches_a_package_that_already_has_artifacts(self, client, tmp_packages_dir, monkeypatch):
        """失败清理只能删「本次尝试新建的空目录」，不能动已发布的包。"""
        import main as m
        assert client.post("/", auth=AUTH, data={"name": "keep-pkg", "version": "1.0"},
                           files={"content": ("keep-pkg-1.0.whl", b"published",
                                              "application/octet-stream")}).status_code == 200
        # 先发布成功再收紧上限：把 413 精确打在「同包目录已非空」的第二发上
        monkeypatch.setattr(m, "MAX_UPLOAD_BYTES", 4)
        resp = client.post("/", auth=AUTH, data={"name": "keep-pkg", "version": "2.0"},
                           files={"content": ("keep-pkg-2.0.whl", b"0123456789",
                                              "application/octet-stream")})
        assert resp.status_code == 413
        assert (tmp_packages_dir / "keep-pkg" / "keep-pkg-1.0.whl").exists()
        assert client.get("/simple/keep-pkg/", auth=AUTH).status_code == 200


# ---------------------------------------------------------------------------
# 2026-10-26 registry-pypi 修复轮（P1-1 / P2-1..4 / P3 批量）。
# 各组用例与 main.py 内同号注释一一对应；新增先红后绿，均已做还原反证。
# ---------------------------------------------------------------------------


class TestChunkedUploadRejectedP1P1:
    """P1-1：上传路由必须带 Content-Length（411），且在认证/读 body 之前短路。

    背景：FastAPI 0.141 在依赖解析（含 verify_auth）之前 await request.form()
    完整消费 body——chunked 请求可在 401 之前把无界字节收进 /tmp tmpfs。
    注意：admin-api 代理（form-data 的 form.pipe()）默认 chunked，已同步改为
    显式 content-length（registry.controller.ts uploadPypiPackage）。
    """

    @staticmethod
    def _post_chunked(client, path="/", auth=AUTH):
        body = (
            b"--testbound\r\n"
            b'Content-Disposition: form-data; name="name"\r\n\r\nchunked-pkg\r\n'
            b"--testbound\r\n"
            b'Content-Disposition: form-data; name="version"\r\n\r\n1.0\r\n'
            b"--testbound\r\n"
            b'Content-Disposition: form-data; name="content"; '
            b'filename="chunked-pkg-1.0.whl"\r\n'
            b"Content-Type: application/octet-stream\r\n\r\n"
            b"payload-bytes\r\n"
            b"--testbound--\r\n"
        )
        # httpx 对迭代器 content 走 chunked（实测：scope 无 content-length）
        return client.post(
            path, auth=auth,
            headers={"content-type": "multipart/form-data; boundary=testbound",
                     "transfer-encoding": "chunked"},
            content=iter([body]),
        )

    def test_chunked_upload_rejected_411_without_reading_body(
            self, client, tmp_packages_dir):
        resp = self._post_chunked(client)
        assert resp.status_code == 411
        assert "content-length" in resp.json()["detail"].lower()
        # 一个 body 字节都没消费：不产生任何包目录/临时文件
        assert list(tmp_packages_dir.glob("*")) == []

    def test_chunked_rejected_even_without_credentials(self, client,
                                                       tmp_packages_dir):
        # 长度闸在认证之前——无凭据同样 411（不先 401，也不再读 body）
        resp = self._post_chunked(client, auth=None)
        assert resp.status_code == 411
        assert list(tmp_packages_dir.glob("*")) == []

    def test_alias_endpoint_rejects_chunked_too(self, client):
        # /upload 是薄 alias（E-39），预检必须同覆盖
        assert self._post_chunked(client, path="/upload").status_code == 411

    def test_chunked_length_gate_is_scoped_to_upload_routes(self, client):
        # GET /simple/ 即便声明 chunked 也照常——闸只收敛上传面
        resp = client.get("/simple/", auth=AUTH,
                          headers={"transfer-encoding": "chunked"})
        assert resp.status_code == 200

    def test_middleware_unit_missing_length_never_calls_next(self):
        """单元级：无 Content-Length 时 411 且 call_next（body 消费）不被触达。"""
        import asyncio
        import main as m
        from starlette.requests import Request
        scope = {"type": "http", "method": "POST", "path": "/", "scheme": "http",
                 "server": ("testserver", 80), "query_string": b"",
                 "headers": [(b"host", b"testserver")]}
        reached = []

        async def call_next(req):
            reached.append(True)
            from starlette.responses import Response
            return Response(status_code=200)

        async def run():
            return await m.content_length_precheck(Request(scope), call_next)

        resp = asyncio.run(run())
        assert resp.status_code == 411
        assert reached == []

    def test_regular_clients_with_content_length_still_pass(self, client):
        # 既有形态回归护栏：twine/pip/代理（带 Content-Length 的 multipart）不受影响
        resp = client.post("/", auth=AUTH,
                           data={"name": "normal-cl", "version": "1.0"},
                           files={"content": ("normal-cl-1.0.whl", b"bytes",
                                              "application/octet-stream")})
        assert resp.status_code == 200


class TestAuthBackoffP2P3:
    """P2-3：Basic 凭据防爆破——进程内失败计数 + 指数退避 + 成功清零 + TTL 清扫。"""

    def test_backoff_synthetic_timing_threshold_and_cap(self, monkeypatch):
        import main as m
        monkeypatch.setattr(m, "_auth_failures", {})
        ip = "10.9.8.7"
        now = 1000.0
        for _ in range(m.AUTH_FAILURE_THRESHOLD - 1):
            m._auth_record_failure(ip, now)
        assert m._auth_lockout_remaining(ip, now) == 0  # 阈值前不退避
        m._auth_record_failure(ip, now)  # 第 5 次 → 2^5 秒
        assert m._auth_lockout_remaining(ip, now + 0.5) == 32
        assert m._auth_lockout_remaining(ip, now + 32) == 0  # 退避过期自动解除
        m._auth_record_failure(ip, now + 32)  # 第 6 次 → 2^6 秒
        assert m._auth_lockout_remaining(ip, now + 33) == 63
        for _ in range(20):  # 指数封顶：2^n 无界增长被 cap 截断
            m._auth_record_failure(ip, now + 100)
        remaining = m._auth_lockout_remaining(ip, now + 100)
        assert remaining <= m.AUTH_BACKOFF_CAP_SECONDS

    def test_repeated_failures_then_429_then_success_clears(self, client):
        import main as m
        for _ in range(m.AUTH_FAILURE_THRESHOLD):
            assert client.get("/simple/", auth=BAD_AUTH).status_code == 401
        locked = client.get("/simple/", auth=BAD_AUTH)
        assert locked.status_code == 429
        assert int(locked.headers["retry-after"]) >= 1
        # 退避期内「正确凭据」同样被拒（退避优先于便利；NAT 连坐由成功清零缓解）
        assert client.get("/simple/", auth=AUTH).status_code == 429
        # 拨动内部状态模拟退避过期（monotonic 由 lockout_until 承载）
        for state in m._auth_failures.values():
            state["lockout_until"] = 0.0
        assert client.get("/simple/", auth=AUTH).status_code == 200
        assert m._auth_failures == {}  # 成功认证清零

    def test_success_clears_failure_count_below_threshold(self, client):
        import main as m
        for _ in range(m.AUTH_FAILURE_THRESHOLD - 1):
            client.get("/simple/", auth=BAD_AUTH)
        assert client.get("/simple/", auth=AUTH).status_code == 200
        assert m._auth_failures == {}

    def test_failure_state_ttl_prune_bounds_growth(self, monkeypatch):
        import main as m
        monkeypatch.setattr(m, "_auth_failures", {})
        now = 10_000.0
        for i in range(m.AUTH_STATE_PRUNE_SIZE):
            m._auth_failures[f"ip-{i}"] = {
                "count": 1, "last_seen": 0.0, "lockout_until": 0.0}
        m._auth_record_failure("fresh-ip", now)
        # 过期条目（last_seen 远早于 TTL）被清扫，dict 规模有界
        assert len(m._auth_failures) == 1
        assert "fresh-ip" in m._auth_failures

    def test_locked_out_requests_are_429_on_all_authed_routes(self, client):
        import main as m
        for _ in range(m.AUTH_FAILURE_THRESHOLD):
            client.get("/simple/", auth=BAD_AUTH)
        # 下载面/删除面同样收敛在 verify_auth，退避期内一律 429
        assert client.get("/packages/any-pkg/any-1.0.whl",
                          auth=AUTH).status_code == 429
        assert client.delete("/admin/packages/any-pkg",
                             auth=AUTH).status_code == 429


class TestDeleteAuditP2P1:
    """P2-1：删除链审计（成功/失败都记，storage_error 形态覆盖部分失败）。"""

    @staticmethod
    def _upload(client, name, filename=None):
        return client.post("/", auth=AUTH, data={"name": name, "version": "1.0"},
                           files={"content": (filename or f"{name}-1.0.whl",
                                              b"payload-bytes",
                                              "application/octet-stream")})

    def test_successful_delete_emits_audit_record(self, client, audit_caplog):
        self._upload(client, "del-audit")
        audit_caplog.clear()
        assert client.delete("/admin/packages/del-audit",
                             auth=AUTH).status_code == 204
        records = _audit_records(audit_caplog)
        assert len(records) == 1, records
        rec = records[0]
        assert rec["action"] == "registry.pypi.delete"
        assert rec["result"] == "success"
        assert rec["user"] == AUTH[0]
        assert rec["package"] == "del-audit"
        assert rec["artifact_count"] == 1
        assert rec["size"] == len(b"payload-bytes")
        assert rec["ip"] is not None

    def test_missing_package_delete_emits_failure_audit(self, client, audit_caplog):
        assert client.delete("/admin/packages/no-such-pkg",
                             auth=AUTH).status_code == 404
        records = _audit_records(audit_caplog)
        assert len(records) == 1
        assert records[0]["result"] == "failure"
        assert records[0]["action"] == "registry.pypi.delete"
        assert records[0]["reason"] == "not_found"

    def test_invalid_name_delete_emits_failure_audit(self, client, audit_caplog):
        # NETOPT-5⑥ 闸保持 404 不泄露；审计侧用可区分的稳定码
        assert client.delete("/admin/packages/C:foo", auth=AUTH).status_code == 404
        records = _audit_records(audit_caplog)
        assert records and records[0]["reason"] == "invalid_package_name"

    def test_rmtree_oserror_emits_storage_error_audit(
            self, client, tmp_packages_dir, audit_caplog, monkeypatch):
        import errno
        import main as m
        self._upload(client, "del-err")
        audit_caplog.clear()

        def exploding_rmtree(path, *args, **kwargs):
            raise OSError(errno.EACCES, "Permission denied")

        monkeypatch.setattr(m.shutil, "rmtree", exploding_rmtree)
        raw = TestClient(m.app, raise_server_exceptions=False)
        assert raw.delete("/admin/packages/del-err", auth=AUTH).status_code == 500
        records = _audit_records(audit_caplog)
        assert records and records[0]["reason"] == "storage_error"
        assert records[0]["result"] == "failure"

    def test_concurrent_delete_race_is_idempotent_404(
            self, client, tmp_packages_dir, audit_caplog, monkeypatch):
        """P3-2：rmtree 抛 FileNotFoundError 且目录确已不在 → 与 404 预检同语义。"""
        import errno
        import shutil as shutil_mod
        import main as m
        self._upload(client, "race-del")
        audit_caplog.clear()
        real_rmtree = shutil_mod.rmtree

        def racing_rmtree(path, *args, **kwargs):
            real_rmtree(path)  # 模拟「另一请求抢先删完」
            raise FileNotFoundError(errno.ENOENT, "No such file or directory")

        monkeypatch.setattr(m.shutil, "rmtree", racing_rmtree)
        raw = TestClient(m.app, raise_server_exceptions=False)
        assert raw.delete("/admin/packages/race-del", auth=AUTH).status_code == 404
        records = _audit_records(audit_caplog)
        assert records and records[0]["reason"] == "not_found"

    def test_partial_delete_race_is_storage_error_500(
            self, client, tmp_packages_dir, audit_caplog, monkeypatch):
        """P3-2：FileNotFoundError 但目录仍在（部分删除/并发重建）→ storage_error。"""
        import errno
        import main as m
        self._upload(client, "race-part")
        audit_caplog.clear()

        def partial_rmtree(path, *args, **kwargs):
            raise FileNotFoundError(errno.ENOENT, "No such file or directory")

        monkeypatch.setattr(m.shutil, "rmtree", partial_rmtree)
        raw = TestClient(m.app, raise_server_exceptions=False)
        assert raw.delete("/admin/packages/race-part", auth=AUTH).status_code == 500
        records = _audit_records(audit_caplog)
        assert records and records[0]["reason"] == "storage_error"


class TestDownloadAuditP2P2:
    """P2-2：下载面审计（外泄主路径），best-effort 不影响下载语义。"""

    def test_download_emits_audit_record(self, client, audit_caplog):
        assert client.post("/", auth=AUTH,
                           data={"name": "dl-audit", "version": "1.0"},
                           files={"content": ("dl-audit-1.0.whl", b"payload",
                                              "application/octet-stream")}
                           ).status_code == 200
        audit_caplog.clear()
        resp = client.get("/packages/dl-audit/dl-audit-1.0.whl", auth=AUTH)
        assert resp.status_code == 200
        records = _audit_records(audit_caplog)
        assert len(records) == 1, records
        rec = records[0]
        assert rec["action"] == "registry.pypi.download"
        assert rec["result"] == "success"
        assert rec["user"] == AUTH[0]
        assert rec["package"] == "dl-audit"
        assert rec["filename"] == "dl-audit-1.0.whl"
        assert rec["size"] == len(b"payload")
        assert rec["ip"] is not None

    def test_failed_download_is_audited_as_failure(self, client, audit_caplog):
        # REG-AUDIT-1（2026-10-30）反转了此处原有的「404 不落下载审计」取舍：
        # 失败面（穿越包名 / .sha256 与 .upload 探测 / 并发删除）恰恰是最需要
        # 归因的请求，而它的量级远低于成功下载（噪声前提不成立时按「审计不能
        # 丢」优先）。401 仍由认证层拒、不进 handler，因此不产生 download 行
        # （认证面的留痕见 TestAuthAuditRegAuth1 的 registry.pypi.auth）。
        assert client.get("/packages/no-pkg/no-file.whl",
                          auth=AUTH).status_code == 404
        records = _audit_records(audit_caplog)
        assert len(records) == 1, records
        assert records[0]["action"] == "registry.pypi.download"
        assert records[0]["result"] == "failure"
        assert records[0]["reason"] == "not_found"
        audit_caplog.clear()
        assert client.get("/packages/no-pkg/no-file.whl").status_code == 401
        assert _audit_records(audit_caplog) == []


class TestSidecarWriteFailureP2P4:
    """P2-4：sidecar 写入走「tmp → link 到位」，任何失败回滚制品——
    保证「500 必然未发布」（旧实现磁盘写满时 500 但制品已发布）。"""

    @staticmethod
    def _upload_expect_500(client, tmp_packages_dir, monkeypatch, name):
        import errno
        import main as m
        real_write_text = Path.write_text

        def exploding_write_text(self, data, *args, **kwargs):
            # 只炸包目录内的落盘写（sidecar tmp）；测试自身对 tmp_path 的
            # 写不受影响（tmp_path 不在 PACKAGES_DIR 下）
            if str(self).startswith(str(tmp_packages_dir)):
                raise OSError(errno.ENOSPC, "No space left on device")
            return real_write_text(self, data, *args, **kwargs)

        monkeypatch.setattr(Path, "write_text", exploding_write_text)
        raw = TestClient(m.app, raise_server_exceptions=False)
        return raw.post("/", auth=AUTH, data={"name": name, "version": "1.0"},
                        files={"content": (f"{name}-1.0.whl", b"artifact-bytes",
                                           "application/octet-stream")})

    def test_enospc_on_sidecar_write_leaves_artifact_unpublished(
            self, client, tmp_packages_dir, audit_caplog, monkeypatch):
        resp = self._upload_expect_500(client, tmp_packages_dir, monkeypatch,
                                       "sc-fail")
        assert resp.status_code == 500
        pkg = tmp_packages_dir / "sc-fail"
        assert not (pkg / "sc-fail-1.0.whl").exists()
        assert not (pkg / "sc-fail-1.0.whl.sha256").exists()
        leftovers = [f.name for f in pkg.glob("*") if f.name.endswith(".upload")]
        assert leftovers == []
        assert client.get("/simple/sc-fail/", auth=AUTH).status_code == 404
        records = _audit_records(audit_caplog)
        assert records and records[0]["reason"] == "storage_error"

    def test_sidecar_link_failure_rolls_back_published_artifact(
            self, client, tmp_packages_dir, audit_caplog, monkeypatch):
        """P2-4 恢复路径：制品 link 成功后 sidecar link 失败 → unlink 回滚。"""
        import errno
        import os as os_mod
        import main as m
        real_link = os_mod.link
        calls = []

        def flaky_link(src, dst, *args, **kwargs):
            calls.append(str(dst))
            if len(calls) == 1:
                return real_link(src, dst, *args, **kwargs)  # 制品 link 成功
            raise OSError(errno.ENOSPC, "No space left on device")

        monkeypatch.setattr(m.os, "link", flaky_link)
        raw = TestClient(m.app, raise_server_exceptions=False)
        resp = raw.post("/", auth=AUTH, data={"name": "sc-rollback", "version": "1.0"},
                        files={"content": ("sc-rollback-1.0.whl", b"bytes",
                                           "application/octet-stream")})
        assert resp.status_code == 500
        pkg = tmp_packages_dir / "sc-rollback"
        assert not (pkg / "sc-rollback-1.0.whl").exists(), \
            "sidecar 落位失败后刚发布的制品必须被回滚"
        assert client.get("/simple/sc-rollback/", auth=AUTH).status_code == 404
        records = _audit_records(audit_caplog)
        assert records and records[0]["reason"] == "storage_error"

    def test_preexisting_stale_sidecar_is_atomically_corrected(
            self, client, tmp_packages_dir):
        """P2-4 FileExistsError 分支：CAS 新建制品时残留的过期 sidecar 被
        os.replace 原子矫正（旧失败轮孤儿，内容可能错）。"""
        import hashlib
        payload = b"fresh bytes"
        pkg = tmp_packages_dir / "sc-stale"
        pkg.mkdir()
        (pkg / "sc-stale-1.0.whl.sha256").write_text("0" * 64)  # 过期孤儿
        resp = client.post("/", auth=AUTH, data={"name": "sc-stale", "version": "1.0"},
                           files={"content": ("sc-stale-1.0.whl", payload,
                                              "application/octet-stream")})
        assert resp.status_code == 200
        sidecar = pkg / "sc-stale-1.0.whl.sha256"
        assert sidecar.read_text().strip() == hashlib.sha256(payload).hexdigest()


class TestStaleUploadSweepP3P1:
    """P3-1：*.upload 残留清扫（启动 + 上传路由共享判据）。"""

    def test_stale_upload_files_removed_fresh_kept(self, client, tmp_packages_dir):
        import time as time_mod
        import main as m
        pkg = tmp_packages_dir / "sweep-pkg"
        pkg.mkdir()
        stale = pkg / "sweep-pkg-0.9.whl.stale.upload"
        fresh = pkg / "sweep-pkg-1.1.whl.fresh.upload"
        stale.write_bytes(b"old")
        fresh.write_bytes(b"new")
        old = time_mod.time() - m.UPLOAD_STALE_SECONDS - 60
        os.utime(stale, (old, old))
        assert m._sweep_stale_uploads() == 1
        assert not stale.exists()
        assert fresh.exists()

    def test_sweep_never_touches_artifacts_or_sidecars(self, client,
                                                       tmp_packages_dir):
        # 制品后缀白名单（.whl/.tar.gz/.zip）不含 .upload——清扫不可能误删制品
        client.post("/", auth=AUTH, data={"name": "sweep-safe", "version": "1.0"},
                    files={"content": ("sweep-safe-1.0.whl", b"real",
                                       "application/octet-stream")})
        import main as m
        m._sweep_stale_uploads()
        assert (tmp_packages_dir / "sweep-safe" / "sweep-safe-1.0.whl").exists()
        assert (tmp_packages_dir / "sweep-safe" / "sweep-safe-1.0.whl.sha256").exists()

    def test_upload_route_sweeps_with_shared_criteria(self, client,
                                                      tmp_packages_dir):
        import time as time_mod
        import main as m
        pkg = tmp_packages_dir / "sweep-via-route"
        pkg.mkdir()
        residue = pkg / "sweep-via-route-1.0.whl.junk.upload"
        residue.write_bytes(b"junk")
        old = time_mod.time() - m.UPLOAD_STALE_SECONDS - 1
        os.utime(residue, (old, old))
        # 节流复位：_maybe_sweep_stale_uploads 用 time.monotonic()（进程运行秒数），
        # 直接置 0 在「刚启动的进程」里仍落在节流窗内（CI 全套仅 ~25s）——必须把
        # 上次清扫时刻推回到节流窗之前，任何进程年龄下都能触发（否则本地长跑绿、
        # CI 短跑红的时序依赖）。
        m._last_upload_sweep = time_mod.monotonic() - m.UPLOAD_SWEEP_MIN_INTERVAL - 1
        resp = client.post("/", auth=AUTH,
                           data={"name": "sweep-via-route", "version": "1.0"},
                           files={"content": ("sweep-via-route-1.0.whl", b"x",
                                              "application/octet-stream")})
        assert resp.status_code == 200
        assert not residue.exists()

    def test_sweep_survives_missing_directory(self, client, monkeypatch):
        import main as m
        monkeypatch.setattr(m, "PACKAGES_DIR",
                            Path("/nonexistent-sweep-target-xyz"))
        # _all_package_dirs 的 OSError 守卫：清扫失败按 0 处理，不抛
        assert m._sweep_stale_uploads() == 0


class TestHealthProbeP3P3:
    """P3-3：/health 真实化——轻量可写性探针，失败 503。"""

    def test_health_still_ok_with_unchanged_shape(self, client):
        # 成功形态逐字节不变（compose healthcheck 语义不变）
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok", "service": "pypi-registry"}

    def test_storage_failure_returns_503(self, client, monkeypatch):
        import errno
        import main as m

        def broken_probe():
            raise OSError(errno.EROFS, "Read-only file system")

        monkeypatch.setattr(m, "_probe_storage_writable", broken_probe)
        resp = client.get("/health")
        assert resp.status_code == 503
        assert resp.json() == {"status": "unavailable", "service": "pypi-registry"}

    def test_probe_leaves_no_files_behind(self, client, tmp_packages_dir):
        client.get("/health")
        assert list(tmp_packages_dir.glob("*")) == []


class TestUploadNameVersionGateP3P5:
    """P3-5：直连面 name/version 显式校验（非空 + 128/64 字节上限），
    收敛 422 文案与 mkdir ENAMETOOLONG 的 500 面。"""

    @pytest.mark.parametrize("name,version", [
        ("", "1.0"),            # 空名
        ("a" * 129, "1.0"),     # 超长名（此前 mkdir ENAMETOOLONG → 500）
        ("ok-name", ""),        # 空版本（此前静默收进审计行）
        ("ok-name", "1" * 65),  # 超长版本
    ])
    def test_invalid_name_or_version_rejected_400(self, client,
                                                  tmp_packages_dir,
                                                  name, version):
        resp = client.post("/", auth=AUTH, data={"name": name, "version": version},
                           files={"content": ("gate-nv-1.0.whl", b"x",
                                              "application/octet-stream")})
        assert resp.status_code == 400
        # 稳定码而非框架 422 文案/内部异常
        assert "detail" in resp.json()
        # 不得落盘（包目录都不该建）
        assert list(tmp_packages_dir.glob("*")) == []

    def test_boundary_lengths_accepted(self, client, tmp_packages_dir):
        resp = client.post("/", auth=AUTH,
                           data={"name": "n" * 128, "version": "1" * 64},
                           files={"content": ("n" * 128 + "-1.0.whl", b"x",
                                              "application/octet-stream")})
        assert resp.status_code == 200
        assert (tmp_packages_dir / ("n" * 128) / ("n" * 128 + "-1.0.whl")).is_file()

    def test_gate_rejects_carry_stable_reason_codes(self, client, audit_caplog):
        client.post("/", auth=AUTH, data={"name": "", "version": "1.0"},
                    files={"content": ("reason-nv-1.0.whl", b"x",
                                       "application/octet-stream")})
        records = _audit_records(audit_caplog)
        assert records and records[0]["reason"] == "invalid_package_name"


class TestAuditFieldHygieneP3P4:
    """P3-4：审计字段截断（filename/package/version 同一 120 上限）+
    package 记 normalize 后值。"""

    def test_long_client_fields_are_truncated(self, client, audit_caplog):
        resp = client.post("/", auth=AUTH,
                           data={"name": "p" * 300, "version": "v" * 300},
                           files={"content": ("f" * 300 + ".whl", b"x",
                                              "application/octet-stream")})
        assert resp.status_code == 400
        rec = _audit_records(audit_caplog)[0]
        assert len(rec["package"]) == 120
        assert len(rec["version"]) == 120
        assert len(rec["filename"]) == 120

    def test_package_recorded_normalized(self, client, audit_caplog):
        resp = client.post("/", auth=AUTH,
                           data={"name": "My_Test.Pkg", "version": "1.0"},
                           files={"content": ("my-test-pkg-1.0.whl", b"x",
                                              "application/octet-stream")})
        assert resp.status_code == 200
        assert _audit_records(audit_caplog)[0]["package"] == "my-test-pkg"


class TestWheelDistMismatchP3P8:
    """P3-8：wheel dist 段与表单 name 不一致 → warning 审计字段（不 400，
    避免 400 破坏既有发布流——pip 侧匹配已有限制）。"""

    def test_mismatched_wheel_dist_segment_warns_but_publishes(
            self, client, audit_caplog):
        resp = client.post("/", auth=AUTH,
                           data={"name": "declared-name", "version": "1.0"},
                           files={"content": (
                               "other-dist-1.0-py3-none-any.whl", b"x",
                               "application/octet-stream")})
        assert resp.status_code == 200
        rec = _audit_records(audit_caplog)[0]
        assert rec["warning"] == "wheel_dist_name_mismatch"

    def test_matching_wheel_has_no_warning_field(self, client, audit_caplog):
        # PEP 427 转义（下划线折叠）由 normalize 统一，_ 与 - 等价
        resp = client.post("/", auth=AUTH,
                           data={"name": "declared-name", "version": "1.0"},
                           files={"content": (
                               "declared_name-1.0-py3-none-any.whl", b"x",
                               "application/octet-stream")})
        assert resp.status_code == 200
        assert "warning" not in _audit_records(audit_caplog)[0]


class TestAsciiCredentialGateP3P6:
    """P3-6：启动闸补凭据 ASCII 校验（E-10 一并拒启动，错误信息可读）。"""

    @staticmethod
    def _import_with_env(monkeypatch, tmp_path, user, password):
        """设好凭据环境并弹出缓存的 main 模块，返回 True 供调用方 import。"""
        monkeypatch.setenv("REGISTRY_USER", user)
        monkeypatch.setenv("REGISTRY_PASS", password)
        monkeypatch.setenv("PACKAGES_DIR", str(tmp_path))
        import sys
        sys.modules.pop("main", None)
        return True

    def test_exits_when_user_non_ascii(self, monkeypatch, tmp_path):
        assert self._import_with_env(monkeypatch, tmp_path, "用户", "okpass")
        with pytest.raises(SystemExit) as exc_info:
            import main  # noqa: F401
        assert exc_info.value.code == 1

    def test_exits_when_password_non_ascii(self, monkeypatch, tmp_path):
        assert self._import_with_env(monkeypatch, tmp_path, "okuser", "密码123")
        with pytest.raises(SystemExit) as exc_info:
            import main  # noqa: F401
        assert exc_info.value.code == 1

    def test_ascii_credentials_still_start(self, monkeypatch, tmp_path):
        assert self._import_with_env(monkeypatch, tmp_path, "okuser", "okpass")
        import main as app_module  # noqa: F401
        assert app_module.REGISTRY_PASS == "okpass"


# ---------------------------------------------------------------------------
# 2026-10-30 审计面收口（REG-AUDIT-1 / REG-AUTH-1）。
#
# REG-AUDIT-1：README 声称「上传/删除/下载三面都落审计行」，但下载面的三条
# 失败路径（非法包名 / 元数据或非法制品名 / stat OSError）直接 raise，只有
# 成功才落 result="success"——目录穿越、.sha256 sidecar、.upload 半成品探测
# 这类最有价值的请求在审计面完全不可见。以下用例逐路径钉住「先审计后 raise，
# 且 reason 用既有稳定码」。
# ---------------------------------------------------------------------------


class TestDownloadFailureAuditRegAudit1:
    """REG-AUDIT-1：下载 404 必须落 registry.pypi.download / result=failure。"""

    @staticmethod
    def _download_failure_records(caplog):
        return [rec for rec in _audit_records(caplog)
                if rec["action"] == "registry.pypi.download"
                and rec["result"] == "failure"]

    def test_unsafe_package_name_404_is_audited(self, client, audit_caplog):
        """穿越/盘符包名（is_safe_package_name 闸拒绝）必须留痕。"""
        resp = client.get("/packages/C:foo/probe-1.0.whl", auth=AUTH)
        assert resp.status_code == 404
        records = self._download_failure_records(audit_caplog)
        assert len(records) == 1, records
        assert records[0]["reason"] == "invalid_package_name"
        assert records[0]["user"] == AUTH[0]
        assert records[0]["ip"]  # 可归因：谁在探测
        # 不记录口令/Authorization
        raw = "\n".join(rec.getMessage() for rec in audit_caplog.records
                        if rec.name == AUDIT_LOGGER_NAME)
        assert AUTH[1] not in raw
        assert "authorization" not in raw.lower()

    def test_meta_sidecar_404_is_audited(self, client, audit_caplog):
        """.sha256 sidecar（is_meta_file 闸拒绝）必须留痕。"""
        assert client.post(
            "/", auth=AUTH, data={"name": "meta-audit", "version": "1.0"},
            files={"content": ("meta-audit-1.0.whl", b"bytes",
                               "application/octet-stream")}).status_code == 200
        audit_caplog.clear()
        resp = client.get("/packages/meta-audit/meta-audit-1.0.whl.sha256",
                          auth=AUTH)
        assert resp.status_code == 404
        records = self._download_failure_records(audit_caplog)
        assert len(records) == 1, records
        assert records[0]["reason"] == "invalid_filename"
        assert records[0]["package"] == "meta-audit"
        assert records[0]["filename"] == "meta-audit-1.0.whl.sha256"

    def test_missing_artifact_404_is_audited(self, client, audit_caplog):
        """不存在的制品（stat/is_file 失败）必须留痕为 not_found。"""
        resp = client.get("/packages/missing-pkg/missing-1.0.whl", auth=AUTH)
        assert resp.status_code == 404
        records = self._download_failure_records(audit_caplog)
        assert len(records) == 1, records
        assert records[0]["reason"] == "not_found"
        assert records[0]["package"] == "missing-pkg"
        assert records[0]["filename"] == "missing-1.0.whl"

    def test_successful_download_still_audited_once(self, client, audit_caplog):
        """回归护栏：成功路径仍是 result=success，且不叠加 failure 行。"""
        content = b"audit-bytes"
        assert client.post(
            "/", auth=AUTH, data={"name": "dl-audit", "version": "1.0"},
            files={"content": ("dl-audit-1.0.whl", content,
                               "application/octet-stream")}).status_code == 200
        audit_caplog.clear()
        assert client.get("/packages/dl-audit/dl-audit-1.0.whl",
                          auth=AUTH).status_code == 200
        records = _audit_records(audit_caplog)
        assert len(records) == 1, records
        assert records[0]["result"] == "success"
        assert records[0]["size"] == len(content)


# ---------------------------------------------------------------------------
# REG-AUTH-1：认证失败/退避必须可归因（action + ip），且绝不记录口令。
# 取舍：只在「新进入退避」与「退避命中 429」两种低频事件上落行——401 的量
# 由攻击者控制，逐条审计等于把日志预算交给爆破方（与 _auth_record_failure
# 原有的「不逐请求刷日志」同一理由）。
# ---------------------------------------------------------------------------


class TestAuthAuditRegAuth1:
    AUTH_ACTION = "registry.pypi.auth"

    @staticmethod
    def _auth_records(caplog):
        return [rec for rec in _audit_records(caplog)
                if rec["action"] == TestAuthAuditRegAuth1.AUTH_ACTION]

    def test_backoff_engagement_is_audited_with_ip_and_no_secret(
            self, client, audit_caplog):
        import main as m
        for _ in range(m.AUTH_FAILURE_THRESHOLD):
            assert client.get("/simple/", auth=BAD_AUTH).status_code == 401
        records = self._auth_records(audit_caplog)
        assert len(records) == 1, records
        rec = records[0]
        assert rec["result"] == "failure"
        assert rec["reason"] == "auth_failed"
        assert rec["ip"], "审计行必须能归因到对端（此前 warning 无 ip）"
        # 明文口令绝不入审计行（BAD_AUTH 与真实口令都不行）
        raw = "\n".join(r.getMessage() for r in audit_caplog.records
                        if r.name == AUDIT_LOGGER_NAME)
        assert BAD_AUTH[1] not in raw
        assert AUTH[1] not in raw
        assert "authorization" not in raw.lower()

    def test_lockout_hit_is_audited_as_auth_backoff(self, client, audit_caplog):
        import main as m
        for _ in range(m.AUTH_FAILURE_THRESHOLD):
            assert client.get("/simple/", auth=BAD_AUTH).status_code == 401
        audit_caplog.clear()
        # 退避期内第 6 次（正确凭据也拒）：429，且必须留下 auth_backoff 归因
        assert client.get("/simple/", auth=AUTH).status_code == 429
        records = self._auth_records(audit_caplog)
        assert len(records) == 1, records
        assert records[0]["result"] == "failure"
        assert records[0]["reason"] == "auth_backoff"
        assert records[0]["ip"]

    def test_successful_auth_emits_no_auth_audit(self, client, audit_caplog):
        """回归护栏：成功认证不产生认证失败审计（否则噪声淹没归因）。"""
        assert client.get("/simple/", auth=AUTH).status_code == 200
        assert self._auth_records(audit_caplog) == []
