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
import json
import logging
import math
import os
import re
import sys
import tempfile
import time

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse, Response
import secrets
import shutil

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

# P3-6（2026-10-26 审计）：凭据必须还是 ASCII——Basic 认证头按 ascii 解码后与
# REGISTRY_USER/PASS 做 compare_digest，非 ASCII 凭据永远无法匹配；而且
# secrets.compare_digest 对非 ASCII str 直接抛 TypeError，会把「密码错」变成
# 500。与其运行期 500，不如启动期 fail-fast（E-10 一并拒启动），错误信息给出
# 可操作的修法。此处无逃生阀：非 ASCII 凭据在 Basic 语义下不存在可用形态。
for _cred_name, _cred_value in (
        ("REGISTRY_USER", REGISTRY_USER), ("REGISTRY_PASS", REGISTRY_PASS)):
    if not _cred_value.isascii():
        print(
            f"[AutoFlow] FATAL: {_cred_name} contains non-ASCII characters. "
            "Basic auth credentials are ASCII-only (the header is decoded as "
            "ASCII before comparison). Reconfigure with an ASCII-only value.",
            file=sys.stderr,
        )
        sys.exit(1)


# P2-3（2026-10-26 审计）：Basic 凭据防爆破——进程内失败计数 + 指数退避。
# 容器探针实证本服务是单 worker（uvicorn 默认单进程），进程内 dict 即全局
# 状态；键取 TCP 对端 IP（_peer_ip，不可伪造——XFF 从不参与键）。连续失败
# 达到阈值后按 2^n 秒拒答（429 + Retry-After，指数封顶防无界），成功认证
# 清零；失败态带 TTL 清扫防 dict 增长。
# 残余风险（README「安全基线」同步登记）：多 worker/多副本部署时计数退化为
# per-process；同一 NAT 出口后的多用户会互相连坐（任何一次成功登录即清零，
# 也部分缓解了连坐）。中期方向：per-identity token（每个调用方独立凭据，
# 可单独吊销/限速），共享 Basic 口令只作过渡。
AUTH_FAILURE_THRESHOLD = 5        # 连续失败达到 N 次后开始退避
AUTH_BACKOFF_CAP_SECONDS = 300    # 2^n 秒封顶：指数不能无界
AUTH_STATE_TTL_SECONDS = 3600     # 失败态最后更新超过 TTL 视为过期（可清扫）
AUTH_STATE_PRUNE_SIZE = 1024      # dict 超过该规模才做 O(n) 清扫（常态零开销）
_auth_failures: dict[str, dict[str, float]] = {}


def _auth_lockout_remaining(ip: str, now: float) -> int:
    """该对端仍需等待的秒数（向上取整，至少 1）；不在退避期返回 0。"""
    state = _auth_failures.get(ip)
    if not state:
        return 0
    until = state["lockout_until"]
    if now >= until:
        return 0
    # 向上取整且不低于 1——math.ceil 保证 remaining 不超过退避总时长本身
    # （int()+1 的写法会把整秒边界顶成 cap+1）。
    return max(1, math.ceil(until - now))


def _auth_record_failure(ip: str, now: float) -> None:
    if len(_auth_failures) >= AUTH_STATE_PRUNE_SIZE:
        stale = [key for key, value in _auth_failures.items()
                 if now - value["last_seen"] > AUTH_STATE_TTL_SECONDS]
        for key in stale:
            _auth_failures.pop(key, None)
    state = _auth_failures.get(ip)
    count = (state["count"] + 1) if state else 1
    entry = {"count": count, "last_seen": now, "lockout_until": 0.0}
    if count >= AUTH_FAILURE_THRESHOLD:
        backoff = min(2.0 ** count, float(AUTH_BACKOFF_CAP_SECONDS))
        entry["lockout_until"] = now + backoff
        # 只在退避（重）生效时打一条 warn；429 响应本身不再逐请求刷日志，
        # 否则攻击者能用垃圾请求把日志预算刷爆。
        logger.warning(
            "auth backoff engaged: peer reached %d consecutive failures",
            count)
    _auth_failures[ip] = entry


def _auth_record_success(ip: str) -> None:
    _auth_failures.pop(ip, None)


def verify_auth(request: Request):
    # 所有失败路径汇聚到同一个 unauthorized——畸形凭据与错误口令对外完全
    # 同形（401 + WWW-Authenticate: Basic），不泄露是哪一步没过。
    unauthorized = HTTPException(
        status_code=401, detail="Unauthorized",
        headers={"WWW-Authenticate": "Basic"})
    ip = _peer_ip(request) or "unknown"
    now = time.monotonic()
    retry_after = _auth_lockout_remaining(ip, now)
    if retry_after:
        # 退避期内直接拒答（凭据都不看）：爆破方得到的信息只有「稍后再来」，
        # 每次拒答的边际成本是一次 dict 查询。
        raise HTTPException(
            status_code=429,
            detail="Too many failed authentication attempts; retry later",
            headers={"Retry-After": str(retry_after)})
    ok = False
    username = ""
    header = request.headers.get("authorization")
    if header:
        scheme, separator, encoded = header.partition(" ")
        if separator and scheme.lower() == "basic" and encoded:
            decoded = None
            try:
                decoded = base64.b64decode(encoded, validate=True).decode("ascii")
            except (binascii.Error, UnicodeDecodeError):
                pass
            if decoded is not None:
                username, separator, password = decoded.partition(":")
                if separator and username and password:
                    ok = (secrets.compare_digest(username, REGISTRY_USER)
                          and secrets.compare_digest(password, REGISTRY_PASS))
    if ok:
        _auth_record_success(ip)
        return username
    _auth_record_failure(ip, now)
    raise unauthorized


# ── 审计面（R90-A1）───────────────────────────────────────────────────────────
# 本服务是**接受包上传**的面：上传动作必须有可追溯记录，否则投毒/误传无法
# 归因。改动前本服务一条日志都没有——本仓 audit 目录里的 registry.pypi.upload
# 只由 admin-api 的代理写 (apps/admin-api/src/modules/registry/registry.controller.ts
# 的 recordUploadAudit)，而 twine 的默认行为是**直连**本服务
# (http://host:8003/)，那条路径完全不落审计。这里补上服务端自己的审计行：
#
#   logger = audit.registry.pypi   （一行一条 JSON，便于日志平台解析）
#   action = registry.pypi.upload / .delete / .download
#
# P2-1/P2-2（2026-10-26 审计）：删除链与下载面此前完全不落痕——admin-api 没有
# pypi 删除/下载代理，直连 8003 的删除（制品销毁）与下载（私有制品外泄主路径）
# 在两层都看不到。三者共用 _audit_event：
#
# 只记「谁、动了哪个包的什么制品、成功/失败、失败原因码」——**不记**口令、
# 不记 Authorization 头、不记内部绝对路径（审计日志会外流到 SIEM/日志平台）；
# 拒绝原因一律用稳定码（invalid_filename / invalid_format /
# invalid_package_name / invalid_version / too_large / conflict /
# not_found / storage_error / internal_error），不把异常文本或堆栈写进去。
AUDIT_LOGGER_NAME = "audit.registry.pypi"
AUDIT_ACTION_UPLOAD = "registry.pypi.upload"
AUDIT_ACTION_DELETE = "registry.pypi.delete"
AUDIT_ACTION_DOWNLOAD = "registry.pypi.download"
#: 审计里回显的客户端可控字段上限——不能让单条请求把日志行撑爆。
#: filename/package/version 同一上限（P3-4），与 R90-A1 的 filename 闸同风格。
AUDIT_FILENAME_MAX = 120

audit_logger = logging.getLogger(AUDIT_LOGGER_NAME)
logger = logging.getLogger("registry-pypi")


def _setup_audit_logging() -> None:
    """保证审计行真的落 stderr，而不是被宿主 logging 的默认 WARNING 静默吞掉。

    uvicorn 只配置自己的 logger（uvicorn / uvicorn.error / uvicorn.access），
    root 既不设 level 也没有 handler——兜底的 lastResort 只放 WARNING 及以上，
    于是 INFO 级审计行会被整条丢弃（审计面最坏的失败形态：以为记了，其实没记）。
    这里给审计 logger 自备 level + stderr handler。

    propagate 保持 True：宿主若另配了 handler，同一行可能在两处出现——审计的
    第一性质是「不能丢」，重复落行由采集侧去重，不做静默丢弃。
    """
    if audit_logger.level == logging.NOTSET:
        audit_logger.setLevel(logging.INFO)
    if not audit_logger.handlers:
        handler = logging.StreamHandler()  # stderr
        handler.setFormatter(logging.Formatter("%(message)s"))
        audit_logger.addHandler(handler)


_setup_audit_logging()


def _peer_ip(request: Request) -> str | None:
    """真实对端地址。

    X-Forwarded-For 在经 admin-api/nginx 代理时才有意义，但它是**客户端可伪造**
    的：因此 ip 永远取 TCP 对端，XFF 只作为独立字段 x_forwarded_for 附上，绝不
    回填 ip（否则审计可被伪造）。
    """
    client = getattr(request, "client", None)
    return getattr(client, "host", None)


def _audit_event(
    request: Request,
    *,
    action: str,
    result: str,
    user: str,
    package: str | None = None,
    version: str | None = None,
    filename: str | None = None,
    size: int | None = None,
    sha256: str | None = None,
    reason: str | None = None,
    unchanged: bool | None = None,
    artifact_count: int | None = None,
    warning: str | None = None,
) -> None:
    """写一条审计行（best-effort：审计故障绝不影响业务语义）。

    P3-4：客户端可控字段（package/version/filename）统一截断到
    AUDIT_FILENAME_MAX；package 记 normalize 后的值（与索引/落盘形态一致，
    聚合口径稳定）。未提供的可选字段不出现在行里（消费方按需取）。
    """
    record = {
        "action": action,
        "service": "registry-pypi",
        "result": result,
        "user": user,
        "package": (normalize(package)[:AUDIT_FILENAME_MAX]
                    if package else package),
        "version": version[:AUDIT_FILENAME_MAX] if version else version,
        "filename": filename[:AUDIT_FILENAME_MAX] if filename else filename,
        "size": size,
        "sha256": sha256,
        "reason": reason,
        "ip": _peer_ip(request),
    }
    if unchanged is not None:
        record["unchanged"] = unchanged
    if artifact_count is not None:
        record["artifact_count"] = artifact_count
    if warning is not None:
        record["warning"] = warning
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        record["x_forwarded_for"] = forwarded[:AUDIT_FILENAME_MAX]
    try:
        audit_logger.info(json.dumps(record, ensure_ascii=False, sort_keys=True))
    except Exception:  # pragma: no cover - 审计故障不得影响业务语义
        logger.exception("%s audit write failed", action)


def audit_upload(
    request: Request,
    *,
    user: str,
    result: str,
    package: str,
    version: str,
    filename: str,
    size: int | None = None,
    sha256: str | None = None,
    reason: str | None = None,
    unchanged: bool | None = None,
    warning: str | None = None,
) -> None:
    """写一条 registry.pypi.upload 审计（见 _audit_event 的统一形态）。"""
    _audit_event(request, action=AUDIT_ACTION_UPLOAD, result=result, user=user,
                 package=package, version=version, filename=filename,
                 size=size, sha256=sha256, reason=reason, unchanged=unchanged,
                 warning=warning)


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

# B-6（413 预检）+ P1-1（2026-10-26 审计：认证前无界 body 缓冲）：
# FastAPI 0.141 在依赖解析（含 verify_auth）之前就 await request.form() 完整
# 消费 body——401 之前整个 multipart 已被 Starlette MultiPartParser 收进
# SpooledTemporaryFile（>1MB 部分落 /tmp tmpfs）。两级中间件闸在**读 body 之前**
# 短路：
#   ① P1-1 上传路由必须带 Content-Length：twine/pip 恒带；admin-api 代理已同步
#      改为显式 content-length（registry.controller.ts uploadPypiPackage——
#      form-data 的 form.pipe() 默认 chunked，2026-10-26 节点探针实证）。缺失
#      一律 411 Length Required：无界长度让「预检」失去意义，也堵死认证前的
#      tmpfs/内存 DoS 面（一个 body 字节都不读）。
#   ② B-6 Content-Length 超限 413 短路：multipart 有 boundary 与表单字段
#      （name/version）开销，给 64 KiB 余量避免边界误杀；畸形头不预检
#      （交给底层协议栈——h11 会拒畸形 Content-Length）。
# 既有防线保留为纵深：handler 内流式累计闸（S10）与 compose tmpfs size 上限
# （P1-1，/tmp:size=1g）。
#
# 根治方案登记（本轮不做）：改造上传 handler 自行读 request.stream() 的
# raw-body——绕开 MultiPartParser 的整体 spool，边收边写包目录 .upload 临时
# 文件并逐块累计，chunked 形态下也有 O(chunk) 的落盘/内存上限。代价是放弃
# FastAPI 的 multipart 契约（name/version 表单字段要手解）与 python-multipart
# 的边界处理，测试矩阵大改，登记为后续项。
CONTENT_LENGTH_MARGIN = 64 * 1024


@app.middleware("http")
async def content_length_precheck(request: Request, call_next):
    """P1-1/B-6: upload 路由的预认证请求体闸（缺长 411、超限 413 短路）。

    仅拦 POST/PUT 且路径命中上传面（/ 与 /upload——E-39 的单一实现 + 薄
    alias）；其余请求原样放行。411/413 响应体形态与 FastAPI HTTPException
    一致（{"detail": ...}），客户端解析无需分支。
    """
    if request.method in ("POST", "PUT") and request.url.path in ("/", "/upload"):
        raw = request.headers.get("content-length")
        if raw is None:
            # P1-1：chunked（无 Content-Length）一律拒收——正规客户端
            # （twine/pip/admin-api 代理）都带长度；411 稳定码，不读 body。
            return JSONResponse(
                status_code=411,
                content={"detail": (
                    "Length required: uploads must declare Content-Length "
                    "(chunked transfer encoding is not accepted)")},
            )
        try:
            length = int(raw)
        except ValueError:
            length = None  # 畸形头不预检，交给底层协议栈/流式闸处理
        if length is not None and length > MAX_UPLOAD_BYTES + CONTENT_LENGTH_MARGIN:
            return JSONResponse(
                status_code=413,
                content={
                    "detail": (
                        "Payload too large: request body exceeds the "
                        f"{MAX_UPLOAD_BYTES} byte upload limit"
                    )
                },
            )
    return await call_next(request)


def sidecar_path(path: Path) -> Path:
    return path.with_name(path.name + SIDECAR_SUFFIX)


def is_meta_file(name: str) -> bool:
    """Sidecar / in-flight upload files must never appear in the index."""
    return name.endswith(SIDECAR_SUFFIX) or name.endswith(UPLOAD_SUFFIX)


# P3-1（2026-10-26 审计）：.upload 半成品清扫——上传进程崩溃/容器被杀会在包
# 目录留下 mkstemp 的 .upload 残留（is_meta_file 挡住了它们进索引，但磁盘
# 占用只进不出）。mtime 超过 UPLOAD_STALE_SECONDS 即删；启动时清一次（见文
# 件末尾的 startup 钩子），上传路由节流共享（进程内至多每小时实扫一次）。
# 判据与 is_meta_file 同源：能以 .upload 结尾的只可能是上传流程落盘的临时
# 文件（制品后缀白名单 .whl/.tar.gz/.zip 不含 .upload），误删风险为零。
UPLOAD_STALE_SECONDS = 24 * 3600
UPLOAD_SWEEP_MIN_INTERVAL = 3600
_last_upload_sweep = 0.0


def _sweep_stale_uploads(now: float | None = None) -> int:
    """删除 mtime 超阈值的 *.upload 残留，返回删除数（OSError 全守卫）。"""
    now = time.time() if now is None else now
    removed = 0
    for d in _all_package_dirs():
        try:
            candidates = list(d.glob("*"))
        except OSError:
            continue
        for f in candidates:
            if not f.name.endswith(UPLOAD_SUFFIX):
                continue
            try:
                if now - f.stat().st_mtime <= UPLOAD_STALE_SECONDS:
                    continue
                f.unlink()
                removed += 1
            except OSError:
                continue
    return removed


def _maybe_sweep_stale_uploads() -> None:
    """上传路由的节流入口：每进程至多每小时实际扫一次盘。"""
    global _last_upload_sweep
    now = time.monotonic()
    if now - _last_upload_sweep < UPLOAD_SWEEP_MIN_INTERVAL:
        return
    _last_upload_sweep = now
    try:
        removed = _sweep_stale_uploads()
    except Exception:  # pragma: no cover - 清扫绝不影响上传
        logger.exception("stale .upload sweep failed")
        return
    if removed:
        logger.info("swept %d stale .upload temp file(s)", removed)


# ── 上传面文件名闸（R90-A1）───────────────────────────────────────────────────
# filename 是**客户端完全可控**的字符串，此前直接成为落盘名与 mkstemp 的
# prefix：超过 NAME_MAX 的名字让 mkstemp 抛 OSError(ENAMETOOLONG) 逃逸成 500；
# NUL/换行/Windows 非法字符同样 500；`?` `#` `%` 在 Linux 上虽能落盘，却会
# 破坏索引页 href（`#` 甚至能把 #sha256= 片段截断/重定向）。这里在落盘之前把
# 它收敛成「单分量 + 有界 + URL 干净」的名字，不合法一律 400（稳定错误码），
# 而不是让 OS 层的 OSError 变成 500。
#
# 跨平台一致性：Path(raw).name 的结果依赖运行平台（Windows 剥反斜杠与盘符，
# Linux 不剥），同一请求在两个平台会得到不同落盘名——所以这里不依赖 OS 语义，
# 直接按「出现 / 或 \ 就是带目录分量」拒绝。
MAX_FILENAME_BYTES = 200

#: 控制字符 + Windows 非法字符 + URL 分隔符。% 一并拒：索引页的 href 不做
#: 百分号编码，%2f 这类字面量会在二次解码时变成分隔符。
_UNSAFE_FILENAME_CHARS = re.compile(r'[\x00-\x1f\x7f<>:"|?*\\/%#]')

_ALLOWED_SUFFIX_RE = re.compile(r"\.(whl|tar\.gz|zip)$", re.IGNORECASE)


def _is_safe_artifact_filename(name: str) -> bool:
    """制品名必须是单个、有界、可安全编码进 href 的路径分量。

    上传侧（400）与下载侧（404）共用同一判据，避免两侧闸不一致。
    """
    if not name or name in (".", ".."):
        return False
    if _UNSAFE_FILENAME_CHARS.search(name):
        return False
    try:
        encoded = name.encode("utf-8")
    except UnicodeEncodeError:  # 孤立代理项等不可编码形态
        return False
    return len(encoded) <= MAX_FILENAME_BYTES


def sanitize_artifact_filename(raw: str) -> tuple[str, str | None]:
    """把上传表单里的 filename 收敛成可安全落盘的单分量名。

    返回 (filename, None)；不合法返回 ("", 稳定错误文案)。错误文案会原样回给
    客户端并进审计，因此**不含**内部路径或异常文本。
    """
    if not raw:
        return "", "No filename"
    if not _is_safe_artifact_filename(raw):
        return "", (
            "Invalid filename: must be a single path component, at most "
            f"{MAX_FILENAME_BYTES} bytes, without control characters or any of "
            '<>:"|?*/\\%#')
    return raw, None


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


def _probe_storage_writable() -> None:
    """P3-3（2026-10-26 审计）：轻量可写性探针——包根 touch 一个临时文件并
    立即删除。os.access(W_OK) 查不出卷满（ENOSPC）/只读挂载（EROFS）/属主
    漂移；touch+删三个 syscall 全覆盖。探针文件落在包**根**（非包目录），
    索引面永远扫不到；异常原样上抛，由 /health 决定 503。
    """
    fd, probe_name = tempfile.mkstemp(
        dir=PACKAGES_DIR, prefix=".healthprobe-", suffix=".tmp")
    os.close(fd)
    os.unlink(probe_name)


@app.get("/health")
def health():
    # P3-3：/health 从「进程活着」升级为「存储真的可写」——pypi_data 卷只读/
    # 属主漂移/写满时返回 503（compose healthcheck 语义不变：非 2xx 即
    # unhealthy）。探针本身三个 syscall，无自身 DoS 面。
    try:
        _probe_storage_writable()
    except OSError:
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "service": "pypi-registry"},
        )
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


def _scan_package_entries() -> list[tuple[str, float, float, int]]:
    """B-4②: 根索引（/ 与 /simple/）的**单次遍历**扫描。

    此前一次请求最多扫两到三遍盘：listing 一遍（iterdir + 每包 glob 计数）、
    ETag/Last-Modified 状态再一遍（_root_listing_state 重复 iterdir + glob）。
    现在一次扫描构建条目结构，listing / 计数 / 校验器三处消费同一份结果。
    行为不变：条目按包名排序（继承 _all_package_dirs 的排序），四元组为
    (包名, 目录 mtime, 目录+制品的最大 mtime, 非元数据文件数)。OSError 守卫
    语义与 _all_package_dirs / _artifact_files 一致——枚举失败按空处理。
    """
    entries: list[tuple[str, float, float, int]] = []
    for d in _all_package_dirs():
        dir_mtime = 0.0
        try:
            dir_mtime = d.stat().st_mtime
        except OSError:
            pass
        latest = dir_mtime
        file_count = 0
        for f in _artifact_files(d):
            file_count += 1
            try:
                latest = max(latest, f.stat().st_mtime)
            except OSError:
                pass
        entries.append((d.name, dir_mtime, latest, file_count))
    return entries


def _root_state_from_entries(
    entries: list[tuple[str, float, float, int]],
) -> tuple[str, float]:
    """从单次扫描结果推导全量索引的 (weak ETag, Last-Modified 秒)。

    ETag 组成与旧 _root_listing_state 逐字节一致：索引只在「包/制品 增删或
    替换」时变化；上传走 N30 os.link 不可覆盖（同 sha 幂等重传字节不变），
    故 mtime+计数足以区分任何会让索引内容变化的操作。"""
    latest = max((e[2] for e in entries), default=0.0)
    file_count = sum(e[3] for e in entries)
    return f'W/"root-{int(latest)}-{len(entries)}-{file_count}"', latest


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
    # 时迭代直接 OSError 500。改用已带 OSError 守卫且排序的 _all_package_dirs()
    # （B-4②起经 _scan_package_entries 的单次遍历间接使用，守卫语义不变）。
    entries = _scan_package_entries()
    pkgs = [e[0] for e in entries]
    total_files = sum(e[3] for e in entries)
    etag, last_modified = _root_state_from_entries(entries)
    return _conditional_html_response(
        request, etag, last_modified, _render_root_index(pkgs, total_files))


@app.get("/simple/", response_class=HTMLResponse)
def simple_index(request: Request, _user: str = Depends(verify_auth)):
    """PEP 503 root index (pip 消费入口)."""
    # D1-P2-4: 守卫语义见 root_index 注释。B-4②：listing/计数/ETag 合并为
    # 单次遍历（此前同一请求最多扫三遍盘），行为逐字节不变。
    entries = _scan_package_entries()
    pkgs = [e[0] for e in entries]
    counts = [e[3] for e in entries]
    etag, last_modified = _root_state_from_entries(entries)
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
            # P3-2（2026-10-26 审计）：glob 到 stat/读 sidecar 之间制品可能被
            # 并发删除——f.stat()/open 的 OSError 此前会整页 500。守卫语义与
            # _artifact_files 一致：该文件按不存在处理（正在被删除的索引短暂
            # 少一行，好过 pip 拿到 500）。
            try:
                size = f.stat().st_size
                mtime = datetime.fromtimestamp(
                    f.stat().st_mtime, timezone.utc).strftime("%Y-%m-%d %H:%M")
                digest = artifact_sha256(f)
            except OSError:
                continue
            rows.append((
                version,
                f.name,
                digest,
                _human_size(size),
                mtime,
            ))
    etag, last_modified = _package_listing_state(d)
    return _conditional_html_response(
        request, etag, last_modified,
        _render_package_index(package_name, rows, len(files), len(by_version)))


@app.get("/packages/{package_name}/{filename}")
def download_package(package_name: str, filename: str, request: Request,
                     _user: str = Depends(verify_auth)):
    # S9: path-traversal guard — reject filenames that escape the package directory
    safe_name = normalize(package_name)
    # NETOPT-5⑥: 包目录名同样过 is_safe_package_name——文件名侧的目录分量
    # 下一行剥掉，但 `C:foo` 这类盘符名会在此处让 ``PACKAGES_DIR / safe_name``
    # 丢根（pathlib 语义），与上传侧同一威胁模型，同闸同语义（404）。
    if not is_safe_package_name(safe_name):
        raise HTTPException(status_code=404, detail="File not found")
    safe_filename = Path(filename).name  # strip any directory components
    # R90-A1: 索引侧用 is_meta_file 过滤的元数据文件，下载侧此前没有任何闸——
    # .sha256 sidecar（只是哈希，危害低）与 **.upload 半成品**（别人正在上传的
    # 部分字节，可跨请求读走）都能整段下载。这里与索引同一判据；顺带用
    # _is_safe_artifact_filename 兜住 NUL 等会让 Path.exists() 抛 ValueError 的
    # 形态（否则是一个 500 而不是 404）。
    if is_meta_file(safe_filename) or not _is_safe_artifact_filename(safe_filename):
        raise HTTPException(status_code=404, detail="File not found")
    f = PACKAGES_DIR / safe_name / safe_filename
    # P3-2：exists/is_file 与 FileResponse 的 open 之间制品可能被并发删除——
    # 显式 stat 一次（404），否则缺失的文件会让 FileResponse 内部抛 RuntimeError
    # 逃逸成 500。顺手把 size 带给审计。
    try:
        size = f.stat().st_size
    except OSError:
        raise HTTPException(status_code=404, detail="File not found")
    if not f.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    # P2-2（2026-10-26 审计）：下载是私有制品外泄的主路径，直连 8003 时
    # admin-api 完全看不见——FileResponse 前落 best-effort 审计（谁、取了
    # 哪个包的哪个文件、多大）。下载是高频面：_audit_event 内部 try/except
    # 兜底，审计写入失败绝不影响下载本身；行开销 = 一行 JSON 到 stderr，
    # 内网低频可接受。若未来需要压量，降级形态是「只记失败 + 成功按请求
    # 采样」（登记，不做——审计的第一性质是「不能丢」）。
    _audit_event(request, action=AUDIT_ACTION_DOWNLOAD, result="success",
                 user=_user, package=safe_name, filename=safe_filename,
                 size=size)
    return FileResponse(str(f))


@app.delete("/admin/packages/{package_name}")
def delete_package(package_name: str, request: Request,
                   _user: str = Depends(verify_auth)):
    """B-4①: 制品生命周期管理面（最小面：**整包删除**）。

    此前制品只进不出——无任何删除端点，pypi_data 卷无界增长，且误传的
    恶意/错误包没有任何运维出口（只能进容器手动 rm，绕过索引一致性）。
    本端点删整个包目录（制品 + .sha256 sidecar + 残留 .upload 临时文件）。

    取舍：按版本删除刻意不做——PEP 440 版本解析、wheel/sdist 混合命名是
    又一层契约面，最小可信面是「整包删除 + 重新上传」（409 闸允许同 sha
    幂等重传）。认证复用 verify_auth——本服务只有一套 Basic 凭据
    （REGISTRY_USER/PASS），具备上传权即具备删除权，与上传面同一信任级。

    P2-1（2026-10-26 审计）：删除链此前零审计——admin-api 无 pypi 删除代理，
    直连删除在两层都不落痕。这里复用上传审计面新增 registry.pypi.delete，
    成功/失败都记：user / package（归一化）/ 制品数 / 字节数 / ip；失败用
    稳定码（invalid_package_name / not_found / storage_error）。

    返回：204（删除成功，无响应体）/ 404（包不存在或包名不合法——与读取
    路径同闸同语义，不泄露闸的存在）。
    """
    normalized = normalize(package_name)
    # NETOPT-5⑥ 同款读取路径闸：归一化后仍带盘符/分隔符的名字按 404 处理。
    if not is_safe_package_name(normalized):
        _audit_event(request, action=AUDIT_ACTION_DELETE, result="failure",
                     user=_user, package=normalized,
                     reason="invalid_package_name")
        raise HTTPException(status_code=404, detail="Package not found")
    d = PACKAGES_DIR / normalized
    if not d.exists() or not d.is_dir():
        _audit_event(request, action=AUDIT_ACTION_DELETE, result="failure",
                     user=_user, package=normalized, reason="not_found")
        raise HTTPException(status_code=404, detail="Package not found")
    # rmtree 的范围有界：包目录内只可能是上传流程落盘的制品/sidecar/临时
    # 文件（PKG-DIR-01 保证目录名是包根下的单分量，N14 保证文件名无目录
    # 分量，os.link 只在包目录内建链）。
    # P2-1：审计字段在删除前统计（制品数/字节），OSError 守卫——「记账」
    # 失败按 None/0 处理，绝不能反过来挡住「删除」。
    artifacts = _artifact_files(d)
    total_bytes = 0
    for f in artifacts:
        try:
            total_bytes += f.stat().st_size
        except OSError:
            pass
    try:
        shutil.rmtree(d)
    except FileNotFoundError:
        # P3-2：并发删除竞态——exists 预检后另一请求已整包删完。目录确已
        # 不存在 → 与上方 404 预检同语义（幂等 404）；目录仍在 → 属部分删除
        # （rmtree 中途子项消失/并发上传重建了目录），按 storage_error 落 500。
        if d.exists():
            _audit_event(request, action=AUDIT_ACTION_DELETE, result="failure",
                         user=_user, package=normalized,
                         artifact_count=len(artifacts), size=total_bytes,
                         reason="storage_error")
            raise
        _audit_event(request, action=AUDIT_ACTION_DELETE, result="failure",
                     user=_user, package=normalized, reason="not_found")
        raise HTTPException(status_code=404, detail="Package not found")
    except OSError:
        # 非预期存储故障（权限/EBUSY……）：落 storage_error 审计后原样抛给
        # 框架（对外 500，不额外泄露内部路径）——与上传面 storage_error 同形。
        _audit_event(request, action=AUDIT_ACTION_DELETE, result="failure",
                     user=_user, package=normalized,
                     artifact_count=len(artifacts), size=total_bytes,
                     reason="storage_error")
        raise
    _audit_event(request, action=AUDIT_ACTION_DELETE, result="success",
                 user=_user, package=normalized, artifact_count=len(artifacts),
                 size=total_bytes)
    return Response(status_code=204)


@app.post("/")
async def upload_package(
    request: Request,
    content: UploadFile = File(...),
    # P3-5：name/version 不用 Form(...) 必填——缺失/空值在框架层是 422 文案，
    # 收敛不进稳定码体系。默认空串 + handler 内非空闸 → 统一 400。
    name: str = Form(""),
    version: str = Form(""),
    _user: str = Depends(verify_auth),
):
    """Canonical upload endpoint — the twine/pip wire contract.

    twine posts a multipart form to the index root, so ``POST /`` is the only
    path a stock client can reach. E-39: this is the single implementation;
    ``POST /upload`` is a thin deprecated alias over it (see below), not a
    second code path — auth, format whitelist, 50 MB cap, sha256 sidecar and
    the 409 no-overwrite guard are shared verbatim.

    R90-A1：本函数只承载 FastAPI 的线上契约（路由 + 表单解析），校验、落盘与
    审计全在 _store_upload——alias 必须走同一份实现，否则审计会漏或重复。
    """
    return await _store_upload(request, _user, content, name, version)


@app.post("/upload")
async def upload_package_alt(
    request: Request,
    content: UploadFile = File(...),
    # P3-5：name/version 不用 Form(...) 必填——缺失/空值在框架层是 422 文案，
    # 收敛不进稳定码体系。默认空串 + handler 内非空闸 → 统一 400。
    name: str = Form(""),
    version: str = Form(""),
    _user: str = Depends(verify_auth),
):
    """Deprecated alias of ``POST /`` (E-39).

    Kept for one release so existing admin-api proxy routes / scripts that
    target ``/upload`` keep working; it delegates to :func:`_store_upload`
    with no semantic difference. New integrations must use ``POST /``
    (twine-compatible). Removal is a breaking change for those callers and
    therefore belongs to a documented release, not this cleanup.
    """
    return await _store_upload(request, _user, content, name, version)


def _rollback_published_artifact(dest: Path) -> None:
    """P2-4 恢复路径：sidecar 落位失败时撤下刚发布的制品（best-effort）。

    unlink 不占用新数据块，ENOSPC 场景下几乎必然成功；若它也失败（极少），
    残留的制品没有 sidecar——下载/索引侧 artifact_sha256 的懒回填会在下次
    访问时补上哈希，一致性最终收敛。完整恢复路径见 README「故障恢复」。
    """
    try:
        dest.unlink(missing_ok=True)
    except OSError:
        logger.error(
            "rollback after sidecar write failure failed too; artifact may "
            "remain without its sha256 sidecar (lazy backfill will recover)")


async def _store_upload(
    request: Request,
    user: str,
    content: UploadFile,
    name: str,
    version: str,
):
    """上传的唯一实现：名版闸 → 文件名闸 → 包名闸 → 临时文件 → 原子落盘 → sidecar → 审计。"""
    raw_filename = content.filename or ""
    # P3-1：上传路由节流清扫 .upload 残留（与启动清扫共享判据，每小时至多
    # 实扫一次盘，常态 O(1)）。
    _maybe_sweep_stale_uploads()

    def reject(status: int, detail: str, reason: str, **extra) -> None:
        """拒绝 = 落一条 failure 审计 + 抛稳定 HTTP 错误码。

        reason 是稳定码（不随文案变），审计消费方按它聚合；detail 是回给客户端
        的文案。两者都不含内部绝对路径或异常文本。
        """
        audit_upload(request, user=user, result="failure", package=name,
                     version=version, filename=raw_filename, reason=reason,
                     **extra)
        raise HTTPException(status_code=status, detail=detail)

    # P3-5（2026-10-26 审计）：直连面补 name/version 显式校验——非空 + 长度
    # 上限 128/64 字节（与 admin-api 代理的 A7 闸同值，registry.controller.ts
    # uploadPypiPackage；按字节限对代理白名单里的 ASCII 名字数值一致，且额外
    # 保证 normalize 后的目录名到不了 NAME_MAX——此前超长名由 mkdir 的
    # ENAMETOOLONG 逃逸成 500，空版本则静默收进审计行）。
    if not name or len(name.encode("utf-8", "replace")) > 128:
        reject(400, ("Invalid package name: must be non-empty and at most "
                     "128 bytes"), "invalid_package_name")
    if not version or len(version.encode("utf-8", "replace")) > 64:
        reject(400, ("Invalid package version: must be non-empty and at most "
                     "64 bytes"), "invalid_version")
    # R90-A1: 文件名闸必须在**落盘之前**——包括 mkstemp 的 prefix。此前客户端
    # 可控的 300 字节名字会让 mkstemp 抛 OSError(ENAMETOOLONG) 逃逸成 500；
    # NUL/换行/Windows 非法字符同理，`?` `#` `%` 则在 Linux 上落盘后破坏索引页
    # 的 href（`#` 能把 #sha256= 片段截断或重定向）。
    filename, filename_error = sanitize_artifact_filename(raw_filename)
    if filename_error:
        reject(400, filename_error, "invalid_filename")
    if not _ALLOWED_SUFFIX_RE.search(filename):
        reject(400, "Invalid package format. Only .whl, .tar.gz, .zip are allowed",
               "invalid_format")
    # PKG-DIR-01: 文件名侧的目录分量/非法字符上面已拒；包目录名同样必须先判
    # 安全再交给 pkg_dir——否则绝对路径/盘符名会让 PACKAGES_DIR / name 丢弃
    # 包根（pathlib 语义），制品落到包根之外。
    normalized = normalize(name)
    if not is_safe_package_name(normalized):
        reject(400, "Invalid package name: must be a single relative name "
                    "(no leading '/', drive letter or path separator)",
               "invalid_package_name")
    # P3-8（2026-10-26 审计）：wheel 的 dist 段（文件名首段）与表单 name 理论
    # 上应一致。评估后选「warning 审计字段」而非 400：pip 按归一化名在
    # /simple/<name>/ 里匹配、再按锚点文件名解析，dist 段不一致的 wheel 仍能
    # 被显式安装（受 pip 侧匹配限制），400 会破坏既有发布流；这里只留痕供
    # 聚合告警。wheel dist 段的转义（PEP 427 把 [-_.] 连跑折叠成 _）被
    # normalize 一并折叠，两侧同函数比较。
    warning = None
    if filename.endswith(".whl"):
        dist_segment = filename[:-4].split("-", 1)[0]
        if normalize(dist_segment) != normalized:
            warning = "wheel_dist_name_mismatch"
    # R90-A1: 记下包目录是不是本次新建的——失败清理只删自己新建的空目录
    # （见函数末尾 finally），已发布的包一律不动。
    created_dir = not (PACKAGES_DIR / normalized).is_dir()
    d = pkg_dir(name)
    dest = d / filename

    # N21 + memory control: stream the upload to a unique temp file in the
    # package directory while computing sha256 in the same 1 MiB-chunk pass,
    # so peak memory stays O(chunk) instead of O(wheel size). The hash is
    # computed once and reused for both the duplicate check and the sidecar.
    #
    # P2-4（2026-10-26 审计）：sidecar 与制品同一 CAS 风格——sidecar 的 tmp
    # 文件也放包目录（/data 卷内，同文件系统 os.link 才可行；/tmp 是 tmpfs，
    # 跨设备 link 必失败）。写入顺序保证「500 ⇒ 未发布」：
    #   ① 两个 tmp 先建（含 sidecar tmp，ENOSPC 在此暴露，制品尚未 link；
    #      建临时文件纳入下方 try 的审计面——此前 mkstemp 失败是无审计的 500）；
    #   ② 流式写制品 tmp + 算 sha；
    #   ③ os.link 制品（CAS：409/幂等分支不变）；
    #   ④ os.link sidecar 到位；失败则**回滚 unlink 制品**再抛——回滚窗口内
    #      已开始的下载可能短暂 404，可接受（恢复路径见 README「故障恢复」）。
    total = 0
    sha = None
    tmp: Path | None = None
    sidecar_tmp: Path | None = None
    try:
        # 先建 sidecar tmp 并立即关 fd（mkstemp 失败时不留任何打开的句柄）；
        # 制品 tmp 的 fd 随后由 os.fdopen 接管。两个 tmp 的创建都在审计面内。
        sc_fd, sc_tmp_name = tempfile.mkstemp(
            dir=d, prefix=filename + SIDECAR_SUFFIX + ".", suffix=UPLOAD_SUFFIX)
        os.close(sc_fd)
        sidecar_tmp = Path(sc_tmp_name)
        fd, tmp_name = tempfile.mkstemp(
            dir=d, prefix=filename + ".", suffix=UPLOAD_SUFFIX)
        tmp = Path(tmp_name)
        h = hashlib.sha256()
        with os.fdopen(fd, "wb") as out:
            while True:
                chunk = await content.read(HASH_CHUNK_SIZE)
                if not chunk:
                    break
                total += len(chunk)
                # S10: enforce the cap mid-stream — reject() raises before
                # os.link so the destination is never created; the finally
                # below removes the partial .upload temp file.
                if total > MAX_UPLOAD_BYTES:
                    reject(413, (f"Package too large: exceeds the "
                                 f"{MAX_UPLOAD_BYTES} byte upload limit"),
                           "too_large", size=total)
                h.update(chunk)
                out.write(chunk)
        sha = h.hexdigest()

        # P2-4 ①：先把 sidecar 内容写进 tmp——ENOSPC 在此暴露，此时制品尚未
        # link，「500 ⇒ 未发布」的保证成立（旧实现是制品 link 之后再
        # write_text，磁盘写满时得到「500 但制品已发布」的语义劈叉）。
        sidecar_tmp.write_text(sha)

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
                audit_upload(request, user=user, result="success", package=name,
                             version=version, filename=filename, size=total,
                             sha256=sha, unchanged=True, warning=warning)
                return {"message": f"Uploaded {filename} (unchanged)",
                        "package": name, "version": version, "unchanged": True}
            reject(409, (f"Artifact {filename} already exists with a different "
                         f"sha256 ({existing} != {sha}); overwriting published "
                         f"packages is not allowed"),
                   "conflict", size=total, sha256=sha)

        try:
            os.link(sidecar_tmp, sidecar_path(dest))
        except FileExistsError:
            # 制品是本次 CAS 新建的：同名 sidecar 只可能是旧失败轮残留或懒
            # 回填的过期内容——os.replace 原子矫正（sidecar 是派生数据，制品
            # 才是权威；replace 是 rename，不新增数据块，无 ENOSPC 面）。
            os.replace(sidecar_tmp, sidecar_path(dest))
        except OSError:
            # ENOSPC/权限等：撤下刚发布的制品再抛——保证「500 必然未发布」。
            _rollback_published_artifact(dest)
            raise
    except HTTPException:
        raise  # reject() 已落过 failure 审计，不重复记
    except Exception as exc:
        # 非预期故障（磁盘满、权限、链接失败……）：也留痕，原因码不含异常文本；
        # 异常原样抛给框架（对外仍是 500，但不额外泄露内部路径）。
        audit_upload(request, user=user, result="failure", package=name,
                     version=version, filename=filename, size=total,
                     reason="storage_error")
        logger.error("upload failed while storing artifact (%s)", type(exc).__name__)
        raise
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)  # no-op after a successful os.link
        if sidecar_tmp is not None:
            sidecar_tmp.unlink(missing_ok=True)  # P2-4: sidecar tmp 同样清理
        # R90-A1: 失败路径不留「幻影包」——pkg_dir 在流式累计闸之前就 mkdir，
        # 413/异常之后空目录会永久留在盘上并出现在根索引与包索引里（脏数据，
        # 同时也是「某个包名被尝试过」的枚举面）。只删本次新建且仍为空的目录：
        # rmdir 对非空目录抛 OSError（已发布的包自然保住），并发第二发的临时
        # 文件也让 rmdir 失败——两者都按「不删」处理。
        if created_dir:
            try:
                os.rmdir(d)
            except OSError:
                pass

    audit_upload(request, user=user, result="success", package=name,
                 version=version, filename=filename, size=total, sha256=sha,
                 warning=warning)
    return {"message": f"Uploaded {filename}", "package": name, "version": version}


@app.on_event("startup")
def _startup_sweep_stale_uploads() -> None:
    """P3-1：进程启动时清一次 .upload 残留（uvicorn lifespan 触发；测试里
    不经 with TestClient 不跑 lifespan，清扫判据由 _sweep_stale_uploads 的
    单测直接钉住）。"""
    try:
        removed = _sweep_stale_uploads()
    except Exception:  # pragma: no cover - 清扫绝不阻塞启动
        logger.exception("startup .upload sweep failed")
        return
    if removed:
        logger.info("startup sweep removed %d stale .upload temp file(s)",
                    removed)
