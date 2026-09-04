"""AutoFlow 私有 PyPI 服务

兼容 pip install --index-url http://host:8003/simple/ 协议。
支持：
  - 包上传（twine upload / pip upload）
  - 简单索引（PEP 503 /simple/）
  - 包下载
  - 基本认证（REGISTRY_USER / REGISTRY_PASS）
"""
from pathlib import Path
import hashlib
import os
import re
import tempfile

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
import secrets

app = FastAPI(title="AutoFlow PyPI Registry", version="1.0.0")

# Allow admin-web (and any other frontend) to call the upload endpoint directly
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

security = HTTPBasic()

# Use PACKAGES_DIR env var; default to a local ./packages dir for dev convenience
_default_packages_dir = Path(__file__).parent / "packages"
PACKAGES_DIR = Path(os.getenv("PACKAGES_DIR", str(_default_packages_dir)))
PACKAGES_DIR.mkdir(parents=True, exist_ok=True)

REGISTRY_USER = os.getenv("REGISTRY_USER", "autoflow")
REGISTRY_PASS = os.getenv("REGISTRY_PASS", "autoflow123")

# Warn (don't exit) when using default credentials so dev environment still works
if REGISTRY_USER == "autoflow" and REGISTRY_PASS == "autoflow123":
    import sys
    print(
        "[AutoFlow] WARNING: Using default credentials. "
        "Set REGISTRY_USER and REGISTRY_PASS env vars in production.",
        file=sys.stderr,
    )


def verify_auth(credentials: HTTPBasicCredentials = Depends(security)):
    ok_user = secrets.compare_digest(credentials.username, REGISTRY_USER)
    ok_pass = secrets.compare_digest(credentials.password, REGISTRY_PASS)
    if not (ok_user and ok_pass):
        raise HTTPException(status_code=401, detail="Unauthorized",
                            headers={"WWW-Authenticate": "Basic"})
    return credentials.username


def normalize(name: str) -> str:
    """PEP 503 name normalization."""
    return re.sub(r"[-_.]+", "-", name).lower()


def pkg_dir(name: str) -> Path:
    d = PACKAGES_DIR / normalize(name)
    d.mkdir(parents=True, exist_ok=True)
    return d


# N18: sha256 sidecar helpers.
# Hashes are computed once at upload time and stored in a `<filename>.sha256`
# sidecar next to the artifact, so the per-package index page never has to
# read whole wheels into memory on every pip request.
HASH_CHUNK_SIZE = 1024 * 1024
SIDECAR_SUFFIX = ".sha256"
UPLOAD_SUFFIX = ".upload"
_HEX64 = re.compile(r"[0-9a-f]{64}")


def sidecar_path(path: Path) -> Path:
    return path.with_name(path.name + SIDECAR_SUFFIX)


def is_meta_file(name: str) -> bool:
    """Sidecar / in-flight upload files must never appear in the index."""
    return name.endswith(SIDECAR_SUFFIX) or name.endswith(UPLOAD_SUFFIX)


def hash_file_streamed(path: Path) -> str:
    """sha256 of a file on disk, read in 1 MiB chunks (bounded memory)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(HASH_CHUNK_SIZE), b""):
            h.update(chunk)
    return h.hexdigest()


def artifact_sha256(path: Path) -> str:
    """Read the hash from the sidecar; lazily compute + backfill if missing."""
    sc = sidecar_path(path)
    if sc.is_file():
        try:
            digest = sc.read_text().strip()
            if _HEX64.fullmatch(digest):
                return digest
        except OSError:
            pass
    digest = hash_file_streamed(path)
    try:
        sc.write_text(digest)
    except OSError:
        pass
    return digest


@app.get("/health")
def health():
    return {"status": "ok", "service": "pypi-registry"}


# S9: also protect simple-index and download endpoints so unauthenticated
# clients cannot enumerate or download private packages
@app.get("/simple/", response_class=HTMLResponse)
def simple_index(_user: str = Depends(verify_auth)):
    """PEP 503 root index."""
    pkgs = [d.name for d in PACKAGES_DIR.iterdir() if d.is_dir()]
    links = "".join(f'<a href="/simple/{p}/">{p}</a><br/>\n' for p in sorted(pkgs))
    return f"""<!DOCTYPE html><html><head><title>Simple Index</title></head>
<body><h1>Simple Index</h1>\n{links}</body></html>"""


@app.get("/simple/{package_name}/", response_class=HTMLResponse)
def package_index(package_name: str, _user: str = Depends(verify_auth)):
    """PEP 503 per-package index."""
    d = PACKAGES_DIR / normalize(package_name)
    if not d.exists():
        raise HTTPException(status_code=404, detail="Package not found")
    # N18: hashes come from upload-time sidecars (lazily backfilled for
    # legacy files); no whole-file reads into memory per request.
    files = [f for f in sorted(d.glob("*")) if f.is_file() and not is_meta_file(f.name)]
    links = ""
    for f in files:
        sha256 = artifact_sha256(f)
        links += f'<a href="/packages/{normalize(package_name)}/{f.name}#sha256={sha256}">{f.name}</a><br/>\n'
    return f"""<!DOCTYPE html><html><head><title>Links for {package_name}</title></head>
<body><h1>Links for {package_name}</h1>\n{links}</body></html>"""


@app.get("/packages/{package_name}/{filename}")
def download_package(package_name: str, filename: str, _user: str = Depends(verify_auth)):
    # S9: path-traversal guard — reject filenames that escape the package directory
    safe_name = normalize(package_name)
    safe_filename = Path(filename).name  # strip any directory components
    f = PACKAGES_DIR / safe_name / safe_filename
    if not f.exists() or not f.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(str(f))


@app.post("/")
async def upload_package(
    content: UploadFile = File(...),
    name: str = Form(...),
    version: str = Form(...),
    _user: str = Depends(verify_auth),
):
    """twine-compatible upload endpoint."""
    # N14: strip directory components to prevent path traversal via filename
    filename = Path(content.filename).name if content.filename else ""
    if not filename:
        raise HTTPException(status_code=400, detail="No filename")
    if not re.search(r'\.(whl|tar\.gz|zip|egg)$', filename, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="Invalid package format. Only .whl, .tar.gz, .zip, .egg are allowed")
    d = pkg_dir(name)
    dest = d / filename

    # N21 + memory control: stream the upload to a unique temp file in the
    # package directory while computing sha256 in the same 1 MiB-chunk pass,
    # so peak memory stays O(chunk) instead of O(wheel size). The hash is
    # computed once and reused for both the duplicate check and the sidecar.
    fd, tmp_name = tempfile.mkstemp(dir=d, prefix=filename + ".", suffix=UPLOAD_SUFFIX)
    tmp = Path(tmp_name)
    try:
        h = hashlib.sha256()
        with os.fdopen(fd, "wb") as out:
            while True:
                chunk = await content.read(HASH_CHUNK_SIZE)
                if not chunk:
                    break
                h.update(chunk)
                out.write(chunk)
        sha = h.hexdigest()

        # N30 (R8): atomic check-and-set via os.link replaces the old
        # dest.exists() pre-check + os.replace, which raced: two concurrent
        # uploads (multi-worker/multi-process deployments) could both pass
        # the pre-check and the later os.replace silently clobbered the
        # earlier artifact — the N21 409 guard only covered sequential
        # re-uploads. os.link creates the destination atomically and raises
        # FileExistsError if it already exists, so exactly one writer wins;
        # the loser compares hashes: same sha256 -> idempotent 200, different
        # -> 409. (POSIX hard link; tmp lives in the same directory, hence
        # the same filesystem. Deployment target is Linux — Windows clients
        # without hard-link support are not a concern here.)
        try:
            os.link(tmp, dest)
        except FileExistsError:
            existing = artifact_sha256(dest)
            if existing == sha:
                # Idempotent re-upload (twine retry / CI double-run): same
                # bytes -> 200, original artifact untouched.
                return {"message": f"Uploaded {filename} (unchanged)",
                        "package": name, "version": version, "unchanged": True}
            raise HTTPException(
                status_code=409,
                detail=(f"Artifact {filename} already exists with a different "
                        f"sha256 ({existing} != {sha}); overwriting published "
                        f"packages is not allowed"))

        sidecar_path(dest).write_text(sha)
    finally:
        tmp.unlink(missing_ok=True)  # no-op after a successful rename
    return {"message": f"Uploaded {filename}", "package": name, "version": version}


@app.post("/upload")
async def upload_package_alt(
    content: UploadFile = File(...),
    name: str = Form(...),
    version: str = Form(...),
    _user: str = Depends(verify_auth),
):
    """Alternative upload endpoint."""
    return await upload_package(content=content, name=name, version=version, _user=_user)
