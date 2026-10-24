"""
R5b（部署模型评审 2026-10-23 §P2 / §九 9.4-5b）：任务执行链 zip 包**字节缓存**。

与 executor-node `src/pkg-cache.ts`（commit 29b8bd17）逐语义对等的 python 实现：

* 痛点：zip 渠道每次执行都把派发载荷里的 packageUrl 重新下载一遍——同一个包
  在 N 台设备 × M 次执行上重复 N×M 次传输。packageUrl 形如
  `uploads/packages/<name>_<ts>.zip`：一次上传 URL 唯一且字节不变，因此 URL
  字符串的 sha256 可以直接充当缓存键。
* 布局：`<work_dir>/.pkg-cache/<sha256(url)>.zip` + `<sha256(url)>.meta.json`
  （{url, size, fetchedAt}）。点目录命名与 `.git_cache`/`.venvs` 同款，且
  **必须**登记进 maintenance.`_PROTECTED_WORKDIR_NAMES`——workDir 清扫第 1 段
  按"顶层条目 mtime"删除一切非基础设施目录，不保护就会在 TTL 后被整棵删掉。

红线（评审 §六 4/5，与 node 同文）：
  * 只缓存**完整下载成功**的字节：下载仍走既有 `_download_package` 原样落
    `<work_dir>/<executionId>/.package.zip`（SSRF 闸/Bearer/绝对超时/体积上限/
    逐 chunk 取消检查全在 `_download_package` 内），成功后才把成品字节复制进
    缓存；下载失败/中断的半成品由 `_download_package` 自行清理，永远到不了这里。
  * 缓存命中路径**每次执行照常跑 vet_zip + safe_extract**（zip-guard 审查不可被
    缓存跳过——缓存只省下载，不做任何安全决策）。审查拒绝时由调用方经
    `purge_pkg_cache_entry` 清除坏条目（覆盖"下载成功但内容恶意"的首次下载，
    与"缓存条目被外部替换"两种来源）。
  * 缓存损坏（size 不符 / zip 缺失 / meta 不可解析 / 复制失败）→ 删除该条目并
    **回退网络下载**（fail-open 到网络，绝不 fail 任务）。
  * 回收 best-effort：字节预算（`settings.pkg_cache_max_bytes`，默认 4GiB，
    0=关闭）超限按 mtime 淘汰最旧；任何缓存侧失败只降级为"本次不缓存"，
    warn 日志，不上抛。

v1 边界：只做字节缓存，不做解压产物缓存（评审 §9.4-5b：下载是大头，解压便宜）。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable, Optional

from config import settings

logger = logging.getLogger(__name__)

# 点目录名（maintenance._PROTECTED_WORKDIR_NAMES 同名登记，勿单独改）。
PKG_CACHE_DIR_NAME = '.pkg-cache'

# node config.pkgCacheMaxBytes 的默认值同源：4GiB 与解释器池总预算
# （INTERPRETER_TOTAL_GB）同量级——单包上限 200MB 下可容纳 ~20 个不同包。
DEFAULT_PKG_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024

# 陈年 .part 回收门龄：写盘中的 part 恒新鲜（下载预算 120s + 本地复制），超过
# 该门龄的 part 只能是崩溃残留（与 node STALE_PART_TTL_MS 同取 24h）。
_STALE_PART_TTL_SECONDS = 24 * 60 * 60


def pkg_cache_dir() -> Path:
    """缓存根目录：`<work_dir>/.pkg-cache`（每次读取 settings，测试可
    monkeypatch `settings.work_dir`）。"""
    return Path(settings.work_dir) / PKG_CACHE_DIR_NAME


def _max_bytes() -> int:
    """字节预算（每次读取，热重载一致）。**0 = 显式关闭缓存**（不读不写，
    行为与无缓存时代一致）；负数按 0 处理（手滑防御，静默钳制——缓存是性能
    优化，不是红线配置；与 node `Math.max(raw, 0)` 同语义）。"""
    raw = int(getattr(settings, 'pkg_cache_max_bytes', DEFAULT_PKG_CACHE_MAX_BYTES))
    return max(raw, 0)


@dataclass(frozen=True)
class _PkgCacheMeta:
    url: str
    size: int
    fetched_at: str


def _cache_key(url: str) -> str:
    """缓存键 = URL 字符串的 sha256（与 node cacheKeyFor 同式）。"""
    return hashlib.sha256(url.encode('utf-8')).hexdigest()


def _remove_entry_quietly(zip_path: Path) -> None:
    """删条目（zip + meta）。best-effort：残留坏条目只会让下次继续 miss +
    重下，不破坏正确性。"""
    meta_path = zip_path.with_name(zip_path.stem + '.meta.json')
    try:
        zip_path.unlink(missing_ok=True)
        meta_path.unlink(missing_ok=True)
    except OSError:
        pass


def _try_copy_from_cache(key: str, dest: Path) -> bool:
    """命中校验 + 复制。命中条件：meta 存在且可解析，且 `.zip` 实际字节数与
    meta.size 一致。任何不一致（缺 zip / size 不符 / JSON 损坏 / 复制失败）都
    删除该条目并返回 False（fail-open：调用方回退网络下载）。"""
    dir_ = pkg_cache_dir()
    zip_path = dir_ / f'{key}.zip'
    meta_path = dir_ / f'{key}.meta.json'
    try:
        if not meta_path.exists():
            return False
        try:
            meta_raw = json.loads(meta_path.read_text(encoding='utf-8'))
            size = int(meta_raw['size'])
        except (OSError, ValueError, KeyError, TypeError):
            # meta 不可解析 → 条目视为损坏：删掉回网络（node 的 "JSON 损坏 →
            # removeEntryQuietly" 同分支）。
            _remove_entry_quietly(zip_path)
            logger.warning(
                '[pkg-cache] entry %s corrupted (unreadable meta) — '
                'dropped, refetching from network', key[:12],
            )
            return False
        st = zip_path.stat()  # zip 缺失 → OSError → 下方统一清条目回网络
        if st.st_size != size:
            _remove_entry_quietly(zip_path)
            logger.warning(
                '[pkg-cache] entry %s corrupted (size mismatch) — '
                'dropped, refetching from network', key[:12],
            )
            return False
        shutil.copyfile(zip_path, dest)
        # LRU 续期：命中即刷新 mtime，让"淘汰最旧"按最近使用而非首次下载排序。
        try:
            now = time.time()
            os.utime(zip_path, (now, now))
        except OSError:
            pass  # 续期失败不影响命中语义
        logger.info('[pkg-cache] hit %s (%d bytes)', key[:12], size)
        return True
    except OSError as exc:
        _remove_entry_quietly(zip_path)
        logger.warning(
            '[pkg-cache] entry %s unreadable (%s) — dropped, '
            'refetching from network', key[:12], exc,
        )
        return False


def _store_in_cache(key: str, url: str, src_zip: Path) -> None:
    """下载成功后写入缓存。两段原子发布（.part→rename）：条目要么完整出现，
    要么不出现——崩溃在最坏情况下留下孤儿 .part/.zip（无 meta），下次按 miss
    处理。全程 best-effort：任何失败只 warn（本次不缓存），绝不上抛影响执行。"""
    try:
        # meta.size 以盘上实际字节数为准（命中校验将来正是拿它与缓存条目比
        # 对）；回报值不可得时复制本身就已失败，走 except 分支。
        size = src_zip.stat().st_size
        dir_ = pkg_cache_dir()
        dir_.mkdir(parents=True, exist_ok=True)
        zip_part = dir_ / f'{key}.zip.part'
        zip_final = dir_ / f'{key}.zip'
        # 同 key 由串行段保护，part 文件名固定不会互踩；shutil.copyfile 本身
        # 整文件覆盖，无需预清理。
        shutil.copyfile(src_zip, zip_part)
        zip_part.replace(zip_final)
        meta_part = dir_ / f'{key}.meta.json.part'
        meta_part.write_text(
            json.dumps({
                'url': url,
                'size': size,
                'fetchedAt': datetime.now(timezone.utc).isoformat(),
            }),
            encoding='utf-8',
        )
        meta_part.replace(dir_ / f'{key}.meta.json')
        logger.info('[pkg-cache] stored %s (%d bytes)', key[:12], size)
        _evict_over_budget(dir_)
    except OSError as exc:
        logger.warning(
            '[pkg-cache] store failed for %s (%s) — continuing without cache',
            key[:12], exc,
        )


def _evict_over_budget(dir_: Path) -> None:
    """字节预算回收：超限时按 `.zip` 的 mtime 升序（最旧优先）删除条目直到
    回到预算内；顺带回收超过门龄的崩溃残留 `.part`（活跃写者的 part 恒新鲜，
    不会被误删）。best-effort，任何异常只 warn。"""
    try:
        max_bytes = _max_bytes()
        if max_bytes <= 0:
            return
        try:
            entries = list(dir_.iterdir())
        except OSError:
            return  # 目录不存在/不可读 → 无可回收
        items: list[tuple[Path, int, float]] = []
        total = 0
        for entry in entries:
            if not entry.name.endswith('.zip'):
                # 陈年 part 回收（见函数头注）；非 zip/part 的未知文件不动。
                if entry.name.endswith('.part'):
                    try:
                        st = entry.stat()
                        if time.time() - st.st_mtime > _STALE_PART_TTL_SECONDS:
                            entry.unlink(missing_ok=True)
                    except OSError:
                        pass  # raced — skip
                continue
            try:
                st = entry.stat()
                if entry.is_file():
                    items.append((entry, st.st_size, st.st_mtime))
                    total += st.st_size
            except OSError:
                continue  # raced — skip
        if total <= max_bytes:
            return
        items.sort(key=lambda item: item[2])
        evicted = 0
        for zip_path, size, _mtime in items:
            if total <= max_bytes:
                break
            _remove_entry_quietly(zip_path)
            total -= size
            evicted += 1
        if evicted > 0:
            logger.info(
                '[pkg-cache] evicted %d %s to fit budget %d bytes',
                evicted, 'entry' if evicted == 1 else 'entries', max_bytes,
            )
    except OSError as exc:
        logger.warning(
            '[pkg-cache] eviction failed (%s) — best effort, next store retries',
            exc,
        )


# ---------------------------------------------------------------------------
# 并发互斥：同 URL 首次下载进程内串行（node pkgFetchQueues 同语义）。并发的
# 同 URL 执行排队等待；队首下载完成后，follower 在队内复查缓存直接复用——
# 不会双下载。不同 URL 各自独立锁，互不阻塞。
#
# 为什么是 asyncio.Lock 且按事件循环分实例：临界段内含 await（下载本身），
# threading.Lock 会在 follower acquire 时**硬阻塞整个事件循环**（队首的下载
# 永远等不到循环推进 → 死锁）。而单个全局 asyncio.Lock 会绑定第一次 await 它
# 的循环——本套件每个测试各自 asyncio.run(...)（独立循环），跨用例复用即报
# "bound to a different event loop"。因此按"当前运行循环"取锁：同一循环内
# （= 生产进程内）同一把锁串行；跨循环（= 测试用例间）自动换新锁，陈年锁随
# 条目清理被丢弃（_pkg_fetch_locks 的 value 存 (loop, lock)，loop 不再是当前
# 循环时替换——旧循环此时必然已关闭）。
# ---------------------------------------------------------------------------
_pkg_fetch_locks: dict[str, tuple[object, 'asyncio.Lock']] = {}


def _get_pkg_fetch_lock(key: str) -> 'asyncio.Lock':
    """当前事件循环的 per-key 下载锁（fetch-or-create，见上注释）。"""
    loop = asyncio.get_running_loop()
    entry = _pkg_fetch_locks.get(key)
    if entry is not None and entry[0] is loop:
        return entry[1]
    lock = asyncio.Lock()
    _pkg_fetch_locks[key] = (loop, lock)
    return lock


def reset_pkg_cache_locks_for_tests() -> None:
    """测试隔离：清空进程内锁表（生产代码不得调用）。"""
    _pkg_fetch_locks.clear()


async def download_with_cache(
    download: Callable[..., Awaitable[int]],
    url: str,
    dest: Path,
    *,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> int:
    """zip 渠道取件入口：缓存命中 → 复制到 dest；未命中 → **原样**走既有
    `download`（即 routers/execute.`_download_package`）下载到 dest（调用
    参数与无缓存时代逐字节一致），成功后写缓存。返回下载/复制的字节数；下载
    失败原样上抛（调用方维持既有错误包装）；缓存侧一切失败都 fail-open。

    `download` 经参数注入而不是模块级 from-import：routers/execute 的
    `_download_package` 是模块属性、测试常年 monkeypatch 它（test_zip_channel
    的 _boom_download 等替身）——按名 from-import 会把这层替身整个绕开。
    """
    key = _cache_key(url)
    max_bytes = _max_bytes()
    if max_bytes <= 0:
        # 缓存被显式关闭（PKG_CACHE_MAX_BYTES=0）：行为与无缓存时代完全一致。
        return await download(url, dest, should_cancel=should_cancel)
    # 快路径：命中直接复制，不进锁。
    if _try_copy_from_cache(key, dest):
        return dest.stat().st_size
    lock = _get_pkg_fetch_lock(key)
    async with lock:
        # 复查：排队期间队首可能刚把同 URL 的条目写好，直接复用。
        if _try_copy_from_cache(key, dest):
            return dest.stat().st_size
        size = await download(url, dest, should_cancel=should_cancel)
        _store_in_cache(key, url, dest)
        return size


def purge_pkg_cache_entry(url: str) -> None:
    """审查拒绝后清除条目（best-effort，不掩盖原始 ZipSafetyError）：
    vet_zip/safe_extract 在缓存命中路径照常把关，一旦拒绝——无论是首次下载
    的包本身恶意，还是缓存条目事后被替换——本次服务的字节都不可再留在缓存
    里（否则坏字节会被反复命中、反复失败）。"""
    try:
        key = _cache_key(url)
        zip_path = pkg_cache_dir() / f'{key}.zip'
        if zip_path.exists():
            _remove_entry_quietly(zip_path)
            logger.info(
                '[pkg-cache] purged entry rejected by zip-safety (%s)', key[:12],
            )
    except OSError:
        pass  # best-effort：残留坏条目下次命中校验时仍会被丢弃
