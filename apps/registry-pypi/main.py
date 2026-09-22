"""AutoFlow 私有 PyPI 服务

兼容 pip install --index-url http://host:8003/simple/ 协议。
支持：
  - 包上传（twine upload / pip upload）
  - 简单索引（PEP 503 /simple/）
  - 人类可读落地页（GET / 与 /simple/ HTML 页）
  - 包下载
  - 基本认证（REGISTRY_USER / REGISTRY_PASS）
"""
from datetime import datetime, timezone
from email.utils import format_datetime, parsedate_to_datetime
from html import escape
from pathlib import Path
import base64
import binascii
import hashlib
import os
import re
import tempfile

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse, Response
import secrets

app = FastAPI(title="AutoFlow PyPI Registry", version="1.0.0")

# E-39（DEEP_REVIEW 0ef3bbe）：CORS 收紧——原 allow_origins=["*"] 对本服务收益
# 为零：pip/twine 不是浏览器、不走 CORS；浏览器也不会跨域自动携带 Basic 凭据
# （且本服务索引面 S9 起一律要求认证）。通配来源唯一实际效果是把预检面开放给
# 任意站点，属净负债。改为显式来源白名单（env REGISTRY_CORS_ORIGINS，逗号
# 分隔）；**未配置时不挂 CORS 中间件**——生产是 admin-web 经 nginx 同源 / 经
# admin-api 代理（apps/admin-web/src/api/registry.ts 注释与 uploadPypiPackage
# 均走代理），本就不需要 CORS 响应头。
_CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("REGISTRY_CORS_ORIGINS", "").split(",")
    if origin.strip()
]
if _CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_CORS_ORIGINS,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )


# Use PACKAGES_DIR env var; default to a local ./packages dir for dev convenience
_default_packages_dir = Path(__file__).parent / "packages"
PACKAGES_DIR = Path(os.getenv("PACKAGES_DIR", str(_default_packages_dir)))
PACKAGES_DIR.mkdir(parents=True, exist_ok=True)

REGISTRY_USER = os.getenv("REGISTRY_USER", "autoflow")
REGISTRY_PASS = os.getenv("REGISTRY_PASS", "")

# E-10（DEEP_REVIEW 0ef3bbe）：fail-closed——未配置 REGISTRY_PASS 或仍用
# 内置默认弱口令时拒绝启动，而非 warn-and-continue。提供 ALLOW_DEFAULT_CREDS=1
# 逃生阀（仅限本地开发）。容器部署由 docker-compose 强制注入 REGISTRY_PASS。
_DEFAULT_USER = "autoflow"
_DEFAULT_PASS = "autoflow123"
_using_default = (
    REGISTRY_USER == _DEFAULT_USER and REGISTRY_PASS == _DEFAULT_PASS
)
if not REGISTRY_PASS or _using_default:
    import sys
    if os.getenv("ALLOW_DEFAULT_CREDS", "") == "1":
        print(
            "[AutoFlow] WARNING: Using default/empty credentials. "
            "Set REGISTRY_USER and REGISTRY_PASS env vars in production.",
            file=sys.stderr,
        )
    else:
        print(
            "[AutoFlow] FATAL: REGISTRY_PASS is not configured or still uses the "
            "built-in default. Set REGISTRY_PASS (and REGISTRY_USER) in the "
            "environment. Set ALLOW_DEFAULT_CREDS=1 to override (development only).",
            file=sys.stderr,
        )
        sys.exit(1)


def verify_auth(request: Request):
    # Parse locally so malformed credentials always use the same response.
    unauthorized = HTTPException(
        status_code=401, detail="Unauthorized",
        headers={"WWW-Authenticate": "Basic"})
    header = request.headers.get("authorization")
    if not header:
        raise unauthorized
    scheme, separator, encoded = header.partition(" ")
    if not separator or scheme.lower() != "basic" or not encoded:
        raise unauthorized
    try:
        decoded = base64.b64decode(encoded, validate=True).decode("ascii")
    except (binascii.Error, UnicodeDecodeError):
        raise unauthorized
    username, separator, password = decoded.partition(":")
    if not separator or not username or not password:
        raise unauthorized
    ok_user = secrets.compare_digest(username, REGISTRY_USER)
    ok_pass = secrets.compare_digest(password, REGISTRY_PASS)
    if not (ok_user and ok_pass):
        raise unauthorized
    return username


def normalize(name: str) -> str:
    """PEP 503 name normalization."""
    return re.sub(r"[-_.]+", "-", name).lower()


def is_safe_package_name(normalized: str) -> bool:
    """PKG-DIR-01: 归一化后的包目录名必须是**单个相对路径分量**。

    normalize() 只折叠 `[-_.]+` 并转小写，不处理路径结构：
    - 前导 `/`（POSIX）与盘符（`C:`）/ UNC 前缀（`\\\\?\\`）会原样存活；
    - 而 ``PACKAGES_DIR / seg`` 在 seg 为绝对路径时**整体丢弃**左操作数
      （pathlib 语义），于是 `PACKAGES_DIR / "/tmp/x"` 就是 `/tmp/x`——
      上传制品会落到包根之外，且 pkg_dir 的 mkdir(parents=True) 还会主动
      把那个目录创建出来。文件名侧的目录分量早已被剥掉，这里补上包目录侧
      的同一道闸：只要是绝对路径、带盘符/UNC，或仍含分隔符，一律拒绝。

    合法 PEP 503 名（含 `..`——已被 normalize 折叠为 `-`）与含 `&` 等字符
    的名称都继续放行：它们归一化后都是单个分量。
    """
    if not normalized or normalized in (".", ".."):
        return False
    # 绝对路径（POSIX 的 `/`、Windows 的 `C:`/`\\`），以及归一化后仍存在的
    # 任意分隔符（防御 normalize 未来被改动后重新引入 `a/b` 形态）。
    if normalized.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", normalized):
        return False
    if "/" in normalized or "\\" in normalized:
        return False
    # 归一化后 `..` 已被折叠成 `-`，此处再兜一层，宁可拒也不放行。
    return os.path.basename(normalized) == normalized


def pkg_dir(name: str) -> Path:
    normalized = normalize(name)
    if not is_safe_package_name(normalized):
        # 上传侧的调用点会先校验并转成 400；这里是纵深防御——任何绕过
        # （含未来新增调用方）都不得在包根之外建目录。
        raise ValueError(f"Invalid package name: {name!r}")
    d = PACKAGES_DIR / normalized
    d.mkdir(parents=True, exist_ok=True)
    return d


# N18: sha256 sidecar helpers.
# Hashes are computed once at upload time and stored in a `<filename>.sha256`
# sidecar next to the artifact, so the per-package index page never has to
# read whole wheels into memory on every pip request.
HASH_CHUNK_SIZE = 1024 * 1024
# S10: cumulative per-artifact upload cap — matches the admin-api proxy's
# multer limit (FileInterceptor fileSize: 50 * 1024 * 1024), so a client
# cannot bypass the proxy path by uploading oversized artifacts directly.
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
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
def _human_size(n: int) -> str:
    # FEAT-12: 人类可读体积（索引页展示用；API/pip 语义不变）
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{int(size)} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


def _version_from_filename(name: str) -> str:
    # wheel: {dist}-{version}(-build)?-{python}-{abi}-{platform}.whl
    # sdist: {name}-{version}.tar.gz / .zip
    if name.endswith(".whl"):
        parts = name[:-4].split("-")
        return parts[1] if len(parts) >= 2 else "-"
    stem = name
    for ext in (".tar.gz", ".zip", ".tar.bz2"):
        if stem.endswith(ext):
            stem = stem[: -len(ext)]
            break
    return stem.rsplit("-", 1)[1] if "-" in stem else "-"


# ── FEAT-12: 人类可读 HTML 索引页 ─────────────────────────────────────────────
# 约束：零外部资源——私服可能离线部署，样式全部内联，不引用任何 CDN/字体/JS。
# 缓存取舍：选 no-cache 而非短 max-age——索引必须在 CI 上传后立即可见，陈旧
# 索引会让 pip 解析不到刚推送的版本；私服页面体量为 KB 级，每次回源代价可
# 忽略。O-26：在 no-cache 之上补 ETag/Last-Modified 弱校验器——no-cache 语义不变
# （每次使用都必须 revalidate），但索引未变时 revalidate 直接命中 304，省去整页
# 重渲染；上传/删包导致 mtime 或条目数变化时校验器变化，立即全量返回。
_CACHE_HEADERS = {"Cache-Control": "no-cache"}


def _http_date(ts: float) -> str:
    """POSIX 时间戳 → HTTP-date（IMF-fixdate，GMT），供 Last-Modified 使用。"""
    return format_datetime(datetime.fromtimestamp(ts, tz=timezone.utc), usegmt=True)


def _all_package_dirs() -> list[Path]:
    try:
        return sorted((d for d in PACKAGES_DIR.iterdir() if d.is_dir()),
                      key=lambda p: p.name)
    except OSError:
        return []


def _artifact_files(pkg_dir: Path) -> list[Path]:
    try:
        return [f for f in sorted(pkg_dir.glob("*"))
                if f.is_file() and not is_meta_file(f.name)]
    except OSError:
        return []


def _root_listing_state() -> tuple[str, float]:
    """全量索引（/ 与 /simple/）的 (weak ETag, Last-Modified 秒)。

    索引只在「包/制品 增删或替换」时变化；取相关条目的最大 mtime 与计数组合。
    上传走 N30 os.link 不可覆盖（同 sha 幂等重传字节不变），故 mtime+计数足以
    区分任何会让索引内容变化的操作。"""
    dirs = _all_package_dirs()
    latest = 0.0
    file_count = 0
    for d in dirs:
        try:
            latest = max(latest, d.stat().st_mtime)
        except OSError:
            pass
        for f in _artifact_files(d):
            file_count += 1
            try:
                latest = max(latest, f.stat().st_mtime)
            except OSError:
                pass
    return f'W/"root-{int(latest)}-{len(dirs)}-{file_count}"', latest


def _package_listing_state(pkg_dir: Path) -> tuple[str, float]:
    """单包索引（/simple/<name>/）的 (weak ETag, Last-Modified 秒)。"""
    files = _artifact_files(pkg_dir)
    latest = 0.0
    for f in files:
        try:
            latest = max(latest, f.stat().st_mtime)
        except OSError:
            pass
    return f'W/"pkg-{int(latest)}-{len(files)}"', latest


def _etag_matches(header_value: str, etag: str) -> bool:
    """弱比较 If-None-Match 中的引用标签是否命中本端 ETag。"""
    our_tag = etag[2:] if etag.startswith("W/") else etag  # 去 weak 前缀
    for _weak, quoted in re.findall(r'(W/)?"([^"]*)"', header_value):
        if quoted and f'"{quoted}"' == our_tag:
            return True
    return False


def _conditional_html_response(request: Request, etag: str,
                               last_modified_ts: float, body: str) -> Response:
    """返回渲染后的 HTML；若请求的 If-None-Match / If-Modified-Since 仍命中则
    返回 304 Not Modified（O-26）。保持 ``Cache-Control: no-cache`` 语义——
    客户端每次都 revalidate，未变的索引走廉价 304。"""
    headers = {
        "ETag": etag,
        "Last-Modified": _http_date(last_modified_ts),
        **_CACHE_HEADERS,
    }
    inm = request.headers.get("if-none-match")
    if inm and _etag_matches(inm, etag):
        return Response(status_code=304, headers=headers)
    ims = request.headers.get("if-modified-since")
    if ims:
        try:
            ims_dt = parsedate_to_datetime(ims)
            if ims_dt is not None and int(last_modified_ts) <= int(ims_dt.timestamp()):
                return Response(status_code=304, headers=headers)
        except (TypeError, ValueError):
            pass  # 畸形日期 → 不命中 304，正常返回内容
    return HTMLResponse(body, headers=headers)

_PAGE_STYLE = """<style>
:root{color-scheme:dark}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#101014;color:#e4e4e9;margin:0;padding:2rem 1rem 4rem}
main{max-width:52rem;margin:0 auto}
h1{font-size:1.3rem;margin:0 0 .3rem}
p.meta{color:#9a9aa5;font-size:.85rem;margin:.3rem 0 1.1rem}
ul.pkg{list-style:none;margin:0 0 1.5rem;padding:0;border:1px solid #26262e;border-radius:8px;overflow:hidden}
ul.pkg li{padding:.5rem .9rem;border-bottom:1px solid #1f1f26;font-size:.9rem}
ul.pkg li:nth-child(odd){background:#15151a}
a{color:#7ab3ff;text-decoration:none}
a:hover{text-decoration:underline}
.muted{color:#9a9aa5}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em;background:#1a1a21;border:1px solid #26262e;border-radius:4px;padding:.05rem .3rem}
footer{margin-top:2rem;color:#6e6e78;font-size:.75rem}
</style>"""


def _page(title: str, body_html: str) -> str:
    """共享页面外壳。title 在此处转义；body_html 是受信组装的标记——其中
    一切用户可控值（包名/文件名/版本号）必须先经 _render_* 里的 html.escape
    （quote=True 默认转义引号，属性/文本两个上下文都覆盖）。"""
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>{escape(title)}</title>
{_PAGE_STYLE}
</head>
<body>
<main>
{body_html}
<footer>AutoFlow PyPI Registry · 私有 Python 包服务 · pip 入口 <code>/simple/</code>（PEP 503）</footer>
</main>
</body>
</html>"""


def _render_root_index(packages: list, total_files: int) -> str:
    """GET / 落地页：包名列表（链到 /simple/<name>/）+ 包数量 + 服务说明。"""
    if packages:
        listing = '<ul class="pkg">\n' + "".join(
            f'<li><a href="/simple/{escape(p)}/">{escape(p)}</a></li>\n'
            for p in packages
        ) + "</ul>"
    else:
        listing = '<p class="muted">暂无已上传的包。</p>'
    body = (
        "<h1>AutoFlow PyPI Registry</h1>\n"
        '<p class="meta">AutoCodeFlow 私有 Python 包索引（PEP 503 协议）。'
        "pip 安装示例：<code>pip install --index-url "
        "http://&lt;host&gt;:8003/simple/ &lt;package&gt;</code></p>"
        f'<p class="meta">{len(packages)} 个包 · {total_files} 个文件</p>'
        f"{listing}"
    )
    return _page("AutoFlow PyPI Registry", body)


def _render_simple_index(packages: list, counts: list, total_files: int) -> str:
    """PEP 503 根索引。

    pip 只解析 <a> 锚点（admin-api parsePypiIndex 同样只取锚点文本），锚点
    href/文本语义不变；计数等附加内容为纯文本/span，不影响 PEP 503 兼容性。
    包名来自上传表单——normalize() 不剥离 <>&'" 等字符——必须 escape。
    """
    if packages:
        listing = '<ul class="pkg">\n' + "".join(
            f'<li><a href="/simple/{escape(p)}/">{escape(p)}</a>'
            f' <span class="muted">({c} file{"s" if c != 1 else ""})</span></li>\n'
            for p, c in zip(packages, counts)
        ) + "</ul>"
    else:
        listing = '<p class="muted">No packages published yet.</p>'
    body = (
        "<h1>Simple Index</h1>\n"
        f'<p class="meta">{len(packages)} package{"s" if len(packages) != 1 else ""} · '
        f'{total_files} file{"s" if total_files != 1 else ""}</p>\n'
        f"{listing}"
    )
    return _page("Simple Index", body)


def _render_package_index(package_name: str, rows: list,
                          file_count: int, version_count: int) -> str:
    """PEP 503 包级索引。

    rows: (version, filename, sha256, size, mtime)——version/filename 均可被
    上传方控制，href 属性与文本节点统一 escape；锚点 href#sha256 语义与
    PEP 503 完全不变，pip 解析不受影响。
    """
    links = "".join(
        f'<li><a href="/packages/{escape(normalize(package_name))}/'
        f'{escape(filename)}#sha256={sha256}">{escape(filename)}</a>'
        f'<br/><span class="muted">版本 {escape(version)} · {size} · {mtime} UTC</span></li>\n'
        for version, filename, sha256, size, mtime in rows
    )
    body = (
        f"<h1>Links for {escape(package_name)}</h1>\n"
        f'<p class="meta">{file_count} file{"s" if file_count != 1 else ""} · '
        f'{version_count} version{"s" if version_count != 1 else ""}</p>\n'
        f'<ul class="pkg">\n{links}</ul>'
    )
    return _page(f"Links for {package_name}", body)


def _version_sort_key(v: str):
    # 混合 int/str 版本段此前会让 sorted() 抛 TypeError（文件名解析不出版本
    # 时得到 "-"，与 "1.0.0" 同页排序即 500）；打标签后任意两段均可比。
    return tuple((0, int(x)) if x.isdigit() else (1, x) for x in v.split("."))


@app.get("/", response_class=HTMLResponse)
def root_index(request: Request, _user: str = Depends(verify_auth)):
    """FEAT-12: 人类可读服务首页（HTML，需认证——与 S9 索引保护策略一致）。"""
    # D1-P2-4: 根/simple 索引此前裸用 PACKAGES_DIR.iterdir()——目录不可读/被删
    # 时迭代直接 OSError 500。改用已带 OSError 守卫且排序的 _all_package_dirs()。
    pkgs = [d.name for d in _all_package_dirs()]
    total_files = sum(
        1
        for p in pkgs
        for f in (PACKAGES_DIR / p).glob("*")
        if f.is_file() and not is_meta_file(f.name)
    )
    etag, last_modified = _root_listing_state()
    return _conditional_html_response(
        request, etag, last_modified, _render_root_index(pkgs, total_files))


@app.get("/simple/", response_class=HTMLResponse)
def simple_index(request: Request, _user: str = Depends(verify_auth)):
    """PEP 503 root index (pip 消费入口)."""
    # D1-P2-4: 根/simple 索引此前裸用 PACKAGES_DIR.iterdir()——目录不可读/被删
    # 时迭代直接 OSError 500。改用已带 OSError 守卫且排序的 _all_package_dirs()。
    pkgs = [d.name for d in _all_package_dirs()]
    counts = [
        sum(1 for f in (PACKAGES_DIR / p).glob("*") if f.is_file() and not is_meta_file(f.name))
        for p in pkgs
    ]
    etag, last_modified = _root_listing_state()
    return _conditional_html_response(
        request, etag, last_modified, _render_simple_index(pkgs, counts, sum(counts)))


@app.get("/simple/{package_name}/", response_class=HTMLResponse)
def package_index(package_name: str, request: Request, _user: str = Depends(verify_auth)):
    """PEP 503 per-package index (pip 消费入口)."""
    # NETOPT-5⑥: 读取路径与上传侧（PKG-DIR-01）共用同一道包名安全闸。
    # Windows 主机上 ``Path("C:/base") / "C:foo"`` 会**丢弃左操作数**
    # （pathlib 语义），归一化后仍带盘符/分隔符的包名可让本端点落包根之外。
    # 不合法按 404 处理——对 pip 而言与「包不存在」不可区分，不泄露闸的存在。
    normalized = normalize(package_name)
    if not is_safe_package_name(normalized):
        raise HTTPException(status_code=404, detail="Package not found")
    d = PACKAGES_DIR / normalized
    if not d.exists():
        raise HTTPException(status_code=404, detail="Package not found")
    # N18: hashes come from upload-time sidecars (lazily backfilled for
    # legacy files); no whole-file reads into memory per request.
    files = [f for f in sorted(d.glob("*")) if f.is_file() and not is_meta_file(f.name)]
    by_version: dict = {}
    for f in files:
        by_version.setdefault(_version_from_filename(f.name), []).append(f)
    rows = []
    for version in sorted(by_version, key=_version_sort_key):
        for f in sorted(by_version[version], key=lambda x: x.name):
            rows.append((
                version,
                f.name,
                artifact_sha256(f),
                _human_size(f.stat().st_size),
                datetime.fromtimestamp(
                    f.stat().st_mtime, timezone.utc).strftime("%Y-%m-%d %H:%M"),
            ))
    etag, last_modified = _package_listing_state(d)
    return _conditional_html_response(
        request, etag, last_modified,
        _render_package_index(package_name, rows, len(files), len(by_version)))


@app.get("/packages/{package_name}/{filename}")
def download_package(package_name: str, filename: str, _user: str = Depends(verify_auth)):
    # S9: path-traversal guard — reject filenames that escape the package directory
    safe_name = normalize(package_name)
    # NETOPT-5⑥: 包目录名同样过 is_safe_package_name——文件名侧的目录分量
    # 下一行剥掉，但 `C:foo` 这类盘符名会在此处让 ``PACKAGES_DIR / safe_name``
    # 丢根（pathlib 语义），与上传侧同一威胁模型，同闸同语义（404）。
    if not is_safe_package_name(safe_name):
        raise HTTPException(status_code=404, detail="File not found")
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
    """Canonical upload endpoint — the twine/pip wire contract.

    twine posts a multipart form to the index root, so ``POST /`` is the only
    path a stock client can reach. E-39: this is the single implementation;
    ``POST /upload`` is a thin deprecated alias over it (see below), not a
    second code path — auth, format whitelist, 50 MB cap, sha256 sidecar and
    the 409 no-overwrite guard are shared verbatim.
    """
    # N14: strip directory components to prevent path traversal via filename
    filename = Path(content.filename).name if content.filename else ""
    if not filename:
        raise HTTPException(status_code=400, detail="No filename")
    if not re.search(r'\.(whl|tar\.gz|zip)$', filename, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="Invalid package format. Only .whl, .tar.gz, .zip are allowed")
    # PKG-DIR-01: 文件名侧的目录分量上面已剥掉；包目录名同样必须先判安全再
    # 交给 pkg_dir——否则绝对路径/盘符名会让 ``PACKAGES_DIR / name`` 丢弃
    # 包根（pathlib 语义），制品落到包根之外。
    if not is_safe_package_name(normalize(name)):
        raise HTTPException(
            status_code=400,
            detail="Invalid package name: must be a single relative name "
                   "(no leading '/', drive letter or path separator)")
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
        total = 0
        with os.fdopen(fd, "wb") as out:
            while True:
                chunk = await content.read(HASH_CHUNK_SIZE)
                if not chunk:
                    break
                total += len(chunk)
                # S10: enforce the cap mid-stream — raise before os.link so the
                # destination is never created; the finally below removes the
                # partial .upload temp file.
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(f"Package too large: exceeds the "
                                f"{MAX_UPLOAD_BYTES} byte upload limit"))
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
    """Deprecated alias of ``POST /`` (E-39).

    Kept for one release so existing admin-api proxy routes / scripts that
    target ``/upload`` keep working; it delegates to :func:`upload_package`
    with no semantic difference. New integrations must use ``POST /``
    (twine-compatible). Removal is a breaking change for those callers and
    therefore belongs to a documented release, not this cleanup.
    """
    return await upload_package(content=content, name=name, version=version, _user=_user)
