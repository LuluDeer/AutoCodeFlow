"""FEAT-05: 执行产物（artifacts）收集与上传 —— executor-python 侧。

约定：任务在其工作目录下的 ``artifacts/`` 里写文件（截图 / 报表 / CSV …）。
任务结束时本模块扫描该目录，构造清单 ``[{name, size, sha256}]``，把每个文件以
multipart PUT 上传到 admin 的 ``/api/executions/<execId>/artifacts/<name>``
（复用执行器回调用的同一 token 做机器鉴权），再把清单随终态回调上报。

铁律：artifacts 永远是 best-effort —— 收集 / 上传任何异常都只记日志，绝不抛出、
绝不阻塞任务终态回调。清单只收录"实际上传成功"的条目，保证 DB 清单与可下载文件一致。
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# 与 admin 回调 DTO @ArrayMaxSize / 上传端点上限一致。
MAX_ARTIFACT_COUNT = 20
MAX_ARTIFACT_SIZE = 100 * 1024 * 1024  # 100 MB

_ART_DIR_NAME = "artifacts"
_CHUNK = 1024 * 1024  # 1 MiB，流式哈希


def artifacts_dir_for(work_dir: Path) -> Path:
    """任务工作目录下的产物目录约定路径。"""
    return Path(work_dir) / _ART_DIR_NAME


def _sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def collect_artifacts(work_dir: Path) -> list[dict[str, Any]]:
    """扫描 ``<work_dir>/artifacts/``（仅顶层普通文件，不递归），返回待上传项。

    过滤规则（均 best-effort + 记日志）：
      - 目录 / 非常规文件跳过；
      - 文件名含路径分隔符或非法字符（与 admin 裸文件名规则不一致）跳过；
      - 单文件 > MAX_ARTIFACT_SIZE 跳过；
      - 收集数量达到 MAX_ARTIFACT_COUNT 后跳过其余。

    每项含 name（裸文件名）、size、sha256、path。
    """
    art_dir = artifacts_dir_for(work_dir)
    if not art_dir.is_dir():
        return []

    items: list[dict[str, Any]] = []
    for entry in sorted(art_dir.iterdir(), key=lambda p: p.name):
        if len(items) >= MAX_ARTIFACT_COUNT:
            logger.warning(
                "artifacts: 超过 %d 个上限，跳过 %s 及其后文件",
                MAX_ARTIFACT_COUNT, entry.name,
            )
            break
        if not entry.is_file():
            continue
        # 与 admin SAFE_ARTIFACT_NAME_RE 对齐：裸文件名、无路径分隔符、无非法字符。
        if entry.name != entry.name.strip() or "/" in entry.name or "\\" in entry.name:
            logger.warning("artifacts: 跳过非法文件名 %r", entry.name)
            continue
        try:
            size = entry.stat().st_size
        except OSError as exc:
            logger.warning("artifacts: 无法 stat %s: %s", entry.name, exc)
            continue
        if size > MAX_ARTIFACT_SIZE:
            logger.warning(
                "artifacts: 跳过超限文件 %s (%d bytes > %d)",
                entry.name, size, MAX_ARTIFACT_SIZE,
            )
            continue
        try:
            sha = _sha256_of(entry)
        except OSError as exc:
            logger.warning("artifacts: 哈希失败 %s: %s", entry.name, exc)
            continue
        items.append({
            "name": entry.name,
            "size": size,
            "sha256": sha,
            "path": str(entry),
        })
    return items


def _api_base(admin_base_url: str) -> str:
    """归一化到带 /api 前缀的 API base（与 admin_api.build_admin_api_url 同逻辑）。"""
    base = admin_base_url.rstrip("/")
    if not base.endswith("/api"):
        base = f"{base}/api"
    return base


async def _upload_one(
    client: httpx.AsyncClient,
    admin_base_url: str,
    execution_id: str,
    item: dict[str, Any],
    token: str | None,
) -> bool:
    """PUT 上传单个产物；成功返回 True。任何异常吞掉并记日志。"""
    url = f"{_api_base(admin_base_url)}/executions/{execution_id}/artifacts/{item['name']}"
    try:
        with open(item["path"], "rb") as fh:
            files = {"file": (item["name"], fh, "application/octet-stream")}
            headers = {}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            resp = await client.put(
                url,
                files=files,
                params={"sha256": item["sha256"]},
                headers=headers,
            )
        if 200 <= resp.status_code < 300:
            return True
        logger.warning(
            "artifacts: 上传 %s 返回 HTTP %s（跳过，不阻塞回调）",
            item["name"], resp.status_code,
        )
        return False
    except Exception as exc:  # noqa: BLE001 —— best-effort
        logger.warning("artifacts: 上传 %s 失败: %s", item["name"], exc)
        return False


async def gather_artifacts_for_callback(
    execution_id: str,
    work_dir: Path,
    admin_base_url: str | None,
    token: str | None,
    client: httpx.AsyncClient | None = None,
) -> list[dict[str, str]]:
    """收集 + 上传产物，返回可入库的清单 ``[{name,size,sha256}]``（仅上传成功项）。

    任何失败均 best-effort 吞掉并返回**尽量**的清单（可能为空）。绝不抛异常。
    """
    if not admin_base_url:
        return []
    try:
        items = collect_artifacts(Path(work_dir))
    except Exception as exc:  # noqa: BLE001
        logger.warning("artifacts: 收集阶段异常: %s", exc)
        return []
    if not items:
        return []

    manifest: list[dict[str, str]] = []
    owns_client = client is None
    if owns_client:
        client = httpx.AsyncClient(timeout=30)
    try:
        for item in items:
            try:
                ok = await _upload_one(client, admin_base_url, execution_id, item, token)
            except Exception as exc:  # noqa: BLE001 —— 单文件上传异常不阻断其余/回调
                logger.warning("artifacts: 上传 %s 抛出（跳过）: %s", item["name"], exc)
                ok = False
            if ok:
                manifest.append({
                    "name": item["name"],
                    "size": item["size"],
                    "sha256": item["sha256"],
                })
    finally:
        if owns_client:
            await client.aclose()
    if manifest:
        logger.info("artifacts: 已上传 %d 个产物 for %s", len(manifest), execution_id)
    return manifest
