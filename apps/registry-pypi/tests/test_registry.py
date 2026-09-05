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
