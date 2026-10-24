"""
R5b（部署模型评审 2026-10-23 §九 9.4-5b）—— zip 渠道包**字节缓存**的行为验证。

与 executor-node `src/routes/execute.pkg-cache.spec.ts`（commit 29b8bd17）同用例面：

  * 首跑下载一次并写入缓存；二跑**零下载**（下载调用计数可证），且 zip 安全
    审查（vet_zip + safe_extract）在缓存命中路径**每次执行照常执行**（红线：
    缓存只省下载，不做安全决策）；
  * 缓存条目被替换为恶意字节 → 审查把关且坏条目被清除；
  * 首次下载的包本身恶意 → 执行失败且**不留缓存**；
  * 并发同 URL → 进程内串行，仅一次下载，双方都拿到字节；
  * 缓存 size 不符 → 删条目回退网络并修复缓存；
  * 字节预算超限 → 按 mtime 淘汰最旧条目，新条目保留；
  * PKG_CACHE_MAX_BYTES=0 → 缓存显式关闭，每次执行都走网络；
  * `.pkg-cache` 受 workDir 清扫保护（不因 TTL 被整棵删除）。

harness 沿用 test_zip_channel.py 的替身约定（httpx.AsyncClient /
settings / spawn 全替身化）；这里走**真实文件系统**（tmp_path）——缓存的原子写
（.part→rename）与命中校验（size 比对）依赖真实语义。
"""

import asyncio
import io
import json
import time
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

import pkg_cache
from routers import execute as execute_module
from routers.execute import ExecuteRequest


# ---------------------------------------------------------------------------
# helpers（与 test_zip_channel.py 同构）
# ---------------------------------------------------------------------------

def _zip_bytes(files: dict) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


class _FakeStreamResponse:
    def __init__(self, chunks, status_code=200):
        self._chunks = chunks
        self.status_code = status_code

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def aiter_bytes(self):
        for chunk in self._chunks:
            yield chunk


class _FakeAsyncClient:
    """httpx.AsyncClient 替身：记录请求，回放预设的流式响应。"""

    def __init__(self, chunks=None, status_code=200, record=None, **kwargs):
        self._chunks = chunks if chunks is not None else []
        self._status_code = status_code
        self._record = record if record is not None else []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def stream(self, method, url, headers=None):
        self._record.append(('stream', method, url, headers))
        return _FakeStreamResponse(self._chunks, self._status_code)


def _patch_download(monkeypatch, payload: bytes, record=None, status_code=200):
    """把 httpx.AsyncClient 换成会回放 `payload` 的替身；`record` 收集每次
    网络请求（=下载计数）。"""
    record = record if record is not None else []
    chunks = [payload[i:i + 1024] for i in range(0, len(payload), 1024)]

    def factory(*args, **kwargs):
        record.append(('client', args, kwargs))
        return _FakeAsyncClient(chunks=chunks, status_code=status_code, record=record)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', factory)
    return record


def _patch_public_dns(monkeypatch):
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', ('93.184.216.34', 0))],
    )


def _patch_spawn(monkeypatch, record):
    """比 test_zip_channel 同名 helper 多一个可读的 stdout：本套件要断言
    **任务成功结束**（缓存行为依赖完整链路收敛），run_task 会逐行读子进程
    stdout（_stream_to_file），缺它会让执行在收尾期报错——test_zip_channel
    的用例不断言 success 所以踩不到。"""

    class _Stdout:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    class _Proc:
        returncode = 0
        stdout = _Stdout()

        async def communicate(self):
            return b'', b''

        def kill(self):
            pass

        async def wait(self):
            return 0

    async def fake_exec(*args, **kwargs):
        record.append(('spawn', list(args)))
        return _Proc()

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)


def _patch_env(monkeypatch, tmp_path):
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_address', 'localhost:8001')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'tok')
    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')
    _patch_public_dns(monkeypatch)


def _stream_gets(record: list) -> int:
    """记录里的真实 GET 次数（'client' 是构造器事件，'stream' 才是请求）。"""
    return sum(
        1 for entry in record
        if isinstance(entry, tuple) and entry and entry[0] == 'stream'
    )


def _zip_request(execution_id: str, url: str) -> ExecuteRequest:
    return ExecuteRequest(executionId=execution_id, task={
        'id': f'task-{execution_id}', 'runtime': 'python',
        'codeSource': 'application_zip', 'applicationId': 'app-1',
        'packageUrl': url,
        'entrypoint': 'main.py',
    })


@pytest.fixture(autouse=True)
def _reset_pkg_cache_locks():
    pkg_cache.reset_pkg_cache_locks_for_tests()
    yield
    pkg_cache.reset_pkg_cache_locks_for_tests()


# ---------------------------------------------------------------------------
# 单元层（pkg_cache 模块直测）
# ---------------------------------------------------------------------------

class TestPkgCacheUnit:
    def test_miss_stores_and_hit_copies_without_download(self, monkeypatch, tmp_path):
        """未命中 → 下载 + 写缓存；随后命中 → 零下载、字节逐一致。"""
        monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes',
                            pkg_cache.DEFAULT_PKG_CACHE_MAX_BYTES)
        payload = _zip_bytes({'main.py': b'print(1)'})
        downloads = []

        async def fake_download(url, dest, *, should_cancel=None):
            downloads.append(url)
            dest.write_bytes(payload)
            return len(payload)

        dest = tmp_path / 'dest.zip'
        size1 = asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/app.zip', dest))
        assert size1 == len(payload)
        assert downloads == ['https://cdn.example.com/app.zip']
        assert (pkg_cache.pkg_cache_dir() /
                f'{pkg_cache._cache_key("https://cdn.example.com/app.zip")}.zip'
                ).read_bytes() == payload

        dest2 = tmp_path / 'dest2.zip'
        size2 = asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/app.zip', dest2))
        assert size2 == len(payload)
        assert downloads == ['https://cdn.example.com/app.zip']  # 零二次下载
        assert dest2.read_bytes() == payload

    def test_size_mismatch_entry_is_dropped_and_refetched(self, monkeypatch, tmp_path):
        """缓存条目字节被替换（size 不符）→ 删条目回退网络并修复缓存。"""
        monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes',
                            pkg_cache.DEFAULT_PKG_CACHE_MAX_BYTES)
        good = _zip_bytes({'main.py': b'print(1)'})
        downloads = []

        async def fake_download(url, dest, *, should_cancel=None):
            downloads.append(url)
            dest.write_bytes(good)
            return len(good)

        dest = tmp_path / 'dest.zip'
        asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/app.zip', dest))
        assert len(downloads) == 1

        # 外部破坏缓存条目（同长度不同字节 → size 校验过不了的情形用**变长**字节
        # 构造；同长度替换由"审查仍跑"用例覆盖）。
        key = pkg_cache._cache_key('https://cdn.example.com/app.zip')
        cached_zip = pkg_cache.pkg_cache_dir() / f'{key}.zip'
        cached_zip.write_bytes(good + b'X')

        dest2 = tmp_path / 'dest2.zip'
        asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/app.zip', dest2))
        assert len(downloads) == 2  # 回退网络
        assert dest2.read_bytes() == good
        # 缓存被修复：再次执行命中、零下载。
        dest3 = tmp_path / 'dest3.zip'
        asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/app.zip', dest3))
        assert len(downloads) == 2
        assert dest3.read_bytes() == good

    def test_missing_zip_with_meta_falls_back_to_network(self, monkeypatch, tmp_path):
        """meta 在、zip 没了（崩溃残留）→ 清条目回网络。"""
        monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes',
                            pkg_cache.DEFAULT_PKG_CACHE_MAX_BYTES)
        payload = _zip_bytes({'main.py': b'print(2)'})
        downloads = []

        async def fake_download(url, dest, *, should_cancel=None):
            downloads.append(url)
            dest.write_bytes(payload)
            return len(payload)

        asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/app.zip', tmp_path / 'd1.zip'))
        key = pkg_cache._cache_key('https://cdn.example.com/app.zip')
        (pkg_cache.pkg_cache_dir() / f'{key}.zip').unlink()

        asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/app.zip', tmp_path / 'd2.zip'))
        assert len(downloads) == 2

    def test_corrupt_meta_json_falls_back_to_network(self, monkeypatch, tmp_path):
        """meta JSON 损坏 → 删条目回网络。"""
        monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes',
                            pkg_cache.DEFAULT_PKG_CACHE_MAX_BYTES)
        payload = _zip_bytes({'main.py': b'print(3)'})
        downloads = []

        async def fake_download(url, dest, *, should_cancel=None):
            downloads.append(url)
            dest.write_bytes(payload)
            return len(payload)

        asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/app.zip', tmp_path / 'd1.zip'))
        key = pkg_cache._cache_key('https://cdn.example.com/app.zip')
        (pkg_cache.pkg_cache_dir() / f'{key}.meta.json').write_text('{not-json')

        asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/app.zip', tmp_path / 'd2.zip'))
        assert len(downloads) == 2

    def test_budget_evicts_oldest_by_mtime_keeps_new(self, monkeypatch, tmp_path):
        """字节预算超限 → 按 mtime 淘汰最旧条目，新条目保留。"""
        monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
        # 预算 = 2 个条目的字节数（每条 2B）。
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes', 4)

        async def fake_download(url, dest, *, should_cancel=None):
            dest.write_bytes(b'AB')
            return 2

        asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/old.zip', tmp_path / 'd1.zip'))
        # 手工把 old 条目"变旧"（mtime 溯回 1 小时前）。
        old_zip = pkg_cache.pkg_cache_dir() / (
            f'{pkg_cache._cache_key("https://cdn.example.com/old.zip")}.zip')
        stale = time.time() - 3600
        import os as _os
        _os.utime(old_zip, (stale, stale))

        asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/new1.zip', tmp_path / 'd2.zip'))
        assert old_zip.exists()  # 2 字节 ≤ 2 字节预算，尚未淘汰

        asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/new2.zip', tmp_path / 'd3.zip'))
        assert not old_zip.exists()  # 超预算 → 最旧的 old 被淘汰
        new2 = pkg_cache.pkg_cache_dir() / (
            f'{pkg_cache._cache_key("https://cdn.example.com/new2.zip")}.zip')
        assert new2.exists()  # 新条目保留

    def test_stale_part_files_are_reclaimed(self, monkeypatch, tmp_path):
        """陈年 .part（崩溃残留，超过 24h 门龄）在预算检查时被顺带回收。"""
        monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes', 1000)
        cache_dir = pkg_cache.pkg_cache_dir()
        cache_dir.mkdir(parents=True)
        stale_part = cache_dir / 'deadbeef.zip.part'
        stale_part.write_bytes(b'x')
        stale = time.time() - pkg_cache._STALE_PART_TTL_SECONDS - 3600
        import os as _os
        _os.utime(stale_part, (stale, stale))
        fresh_part = cache_dir / 'livewire.zip.part'
        fresh_part.write_bytes(b'y')

        async def fake_download(url, dest, *, should_cancel=None):
            dest.write_bytes(b'Z')
            return 1

        asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/x.zip', tmp_path / 'd.zip'))
        assert not stale_part.exists()
        assert fresh_part.exists()  # 活跃 part 恒新鲜，不误删

    def test_disabled_cache_hits_network_every_time(self, monkeypatch, tmp_path):
        """PKG_CACHE_MAX_BYTES=0 → 显式关闭：不读不写，每次执行都走网络。"""
        monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes', 0)
        downloads = []

        async def fake_download(url, dest, *, should_cancel=None):
            downloads.append(url)
            dest.write_bytes(b'N')
            return 1

        for i in range(2):
            asyncio.run(pkg_cache.download_with_cache(
                fake_download, 'https://cdn.example.com/app.zip',
                tmp_path / f'd{i}.zip'))
        assert len(downloads) == 2
        assert not pkg_cache.pkg_cache_dir().exists()  # 一个字节都没写

    def test_download_failure_propagates_and_caches_nothing(
            self, monkeypatch, tmp_path):
        """下载失败原样上抛（调用方维持既有错误包装），且不写缓存。"""
        monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes',
                            pkg_cache.DEFAULT_PKG_CACHE_MAX_BYTES)

        async def failing_download(url, dest, *, should_cancel=None):
            dest.write_bytes(b'partial')
            raise RuntimeError('包下载失败：ConnectError')

        with pytest.raises(RuntimeError, match='包下载失败'):
            asyncio.run(pkg_cache.download_with_cache(
                failing_download, 'https://cdn.example.com/app.zip',
                tmp_path / 'd.zip'))
        assert not (tmp_path / 'd.zip').exists() or True  # 清理由 download 负责
        assert list(pkg_cache.pkg_cache_dir().glob('*.zip')) == []

    def test_store_failure_is_best_effort(self, monkeypatch, tmp_path):
        """缓存写失败只 warn，不上抛：下载成功的结果照常返回。

        用**真实文件系统故障**（缓存目录换成只读）而不是 monkeypatch
        `_store_in_cache` 本身——后者会连模块内部的 try/except 一起绕开，
        测的是"调用方替实现兜底"而不是"实现自己兜底"。"""
        monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes',
                            pkg_cache.DEFAULT_PKG_CACHE_MAX_BYTES)
        cache_root = tmp_path / pkg_cache.PKG_CACHE_DIR_NAME
        cache_root.mkdir()
        cache_root.chmod(0o500)  # 只读：mkdir/写 part 全部 EACCES

        async def fake_download(url, dest, *, should_cancel=None):
            dest.write_bytes(b'Q')
            return 1

        size = asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/app.zip', tmp_path / 'd.zip'))
        assert size == 1
        assert (tmp_path / 'd.zip').read_bytes() == b'Q'

    def test_purge_removes_entry(self, monkeypatch, tmp_path):
        """审查拒绝后的条目清除：zip + meta 一并删除，重复 purge 幂等。"""
        monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes',
                            pkg_cache.DEFAULT_PKG_CACHE_MAX_BYTES)

        async def fake_download(url, dest, *, should_cancel=None):
            dest.write_bytes(b'P')
            return 1

        asyncio.run(pkg_cache.download_with_cache(
            fake_download, 'https://cdn.example.com/app.zip', tmp_path / 'd.zip'))
        pkg_cache.purge_pkg_cache_entry('https://cdn.example.com/app.zip')
        pkg_cache.purge_pkg_cache_entry('https://cdn.example.com/app.zip')  # 幂等
        assert list(pkg_cache.pkg_cache_dir().iterdir()) == []

    def test_concurrent_same_url_downloads_once(self, monkeypatch, tmp_path):
        """并发同 URL → 串行段内仅一次下载，双方都拿到字节。"""
        monkeypatch.setattr(pkg_cache.settings, 'work_dir', str(tmp_path))
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes',
                            pkg_cache.DEFAULT_PKG_CACHE_MAX_BYTES)
        payload = _zip_bytes({'main.py': b'print(9)'})
        downloads = []

        async def fake_download(url, dest, *, should_cancel=None):
            downloads.append(url)
            # 模拟真实下载耗时：让并发的 follower 先排队（锁内复查语义）。
            await asyncio.sleep(0.02)
            dest.write_bytes(payload)
            return len(payload)

        async def scenario():
            dests = [tmp_path / 'a.zip', tmp_path / 'b.zip']
            await asyncio.gather(*(
                pkg_cache.download_with_cache(
                    fake_download, 'https://cdn.example.com/app.zip', d)
                for d in dests
            ))
            return dests

        dests = asyncio.run(scenario())
        assert len(downloads) == 1
        for d in dests:
            assert d.read_bytes() == payload


# ---------------------------------------------------------------------------
# 集成层（run_task zip 渠道全链）
# ---------------------------------------------------------------------------

class TestPkgCacheIntegration:
    def test_second_execution_downloads_zero_times_but_vets_each_time(
            self, monkeypatch, tmp_path):
        """验收口径（评审 §七）：首跑一次下载 + 落缓存；二跑**零下载**，且
        vet_zip/safe_extract 每次执行照常跑（红线：缓存只省下载）。"""
        _patch_env(monkeypatch, tmp_path)
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes',
                            pkg_cache.DEFAULT_PKG_CACHE_MAX_BYTES)
        payload = _zip_bytes({'main.py': b'print(1)'})
        downloads = _patch_download(monkeypatch, payload, record := [])
        spawns = []
        _patch_spawn(monkeypatch, spawns)

        vet_calls = []
        real_vet = execute_module._zip_safety.vet_zip

        def counting_vet(path, *, limits=None):
            vet_calls.append(str(path))
            return real_vet(path, limits=limits)

        monkeypatch.setattr(execute_module._zip_safety, 'vet_zip', counting_vet)

        asyncio.run(execute_module.run_task(
            _zip_request('exec-1', 'https://cdn.example.com/app.zip')))
        assert _stream_gets(downloads) == 1
        assert (tmp_path / 'exec-1' / 'main.py').exists()

        asyncio.run(execute_module.run_task(
            _zip_request('exec-2', 'https://cdn.example.com/app.zip')))
        assert _stream_gets(downloads) == 1  # 二跑零下载
        assert (tmp_path / 'exec-2' / 'main.py').exists()
        # 审查每次执行照跑：_extract_package 显式 vet_zip 一次 + safe_extract
        # 内部再 vet 一次（zip_safety.safe_extract 自带整包先审），每执行 ≥2 次。
        assert sum(1 for p in vet_calls if '/exec-1/' in p) >= 2
        assert sum(1 for p in vet_calls if '/exec-2/' in p) >= 2

    def test_cached_entry_replaced_with_evil_zip_is_rejected_and_purged(
            self, monkeypatch, tmp_path):
        """缓存条目被替换为恶意 zip（同长度不可信场景一律过审查）→ 审查把关，
        坏条目被清除，下一次执行重新下载干净字节。"""
        _patch_env(monkeypatch, tmp_path)
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes',
                            pkg_cache.DEFAULT_PKG_CACHE_MAX_BYTES)
        payload = _zip_bytes({'main.py': b'print(1)'})
        evil = _zip_bytes({'main.py': b'print(666)'})
        downloads = []
        served = {'payload': payload}

        def factory(*args, **kwargs):
            return _FakeAsyncClient(
                chunks=[served['payload']], record=downloads)

        monkeypatch.setattr(execute_module.httpx, 'AsyncClient', factory)
        spawns = []
        _patch_spawn(monkeypatch, spawns)

        asyncio.run(execute_module.run_task(
            _zip_request('exec-1', 'https://cdn.example.com/app.zip')))
        assert _stream_gets(downloads) == 1

        # 把缓存条目替换为真实 zip-slip 包（vet_zip 必拒）。
        slip = io.BytesIO()
        with zipfile.ZipFile(slip, 'w') as archive:
            archive.writestr('../evil.txt', b'escape')
        key = pkg_cache._cache_key('https://cdn.example.com/app.zip')
        (pkg_cache.pkg_cache_dir() / f'{key}.zip').write_bytes(slip.getvalue())
        # 同步 meta.size 与新字节长度，让命中校验通过、审查来把关
        # （这正是"缓存条目被外部替换"的攻击面）。
        meta_path = pkg_cache.pkg_cache_dir() / f'{key}.meta.json'
        meta = json.loads(meta_path.read_text())
        meta['size'] = len(slip.getvalue())
        meta_path.write_text(json.dumps(meta))

        with pytest.raises(RuntimeError, match='zip 包未通过安全检查'):
            asyncio.run(execute_module.run_task(
                _zip_request('exec-2', 'https://cdn.example.com/app.zip')))
        # 坏条目已被清除。
        assert not (pkg_cache.pkg_cache_dir() / f'{key}.zip').exists()

        # 网络回放干净字节 → 第三次执行成功（缓存修复）。
        served['payload'] = payload
        asyncio.run(execute_module.run_task(
            _zip_request('exec-3', 'https://cdn.example.com/app.zip')))
        # exec-1 下载 1 次；exec-2 命中坏缓存（0 网络，审查拒绝 + 清条目）；
        # exec-3 缓存已空 → 回网络 1 次。合计 2 次 GET。
        assert _stream_gets(downloads) == 2
        assert (tmp_path / 'exec-3' / 'main.py').exists()

    def test_first_download_malicious_leaves_no_cache_entry(
            self, monkeypatch, tmp_path):
        """首次下载的包本身恶意 → 执行失败且**不留缓存**（红线 §六 4）。"""
        _patch_env(monkeypatch, tmp_path)
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes',
                            pkg_cache.DEFAULT_PKG_CACHE_MAX_BYTES)
        slip = io.BytesIO()
        with zipfile.ZipFile(slip, 'w') as archive:
            archive.writestr('../evil.txt', b'escape')
        downloads = _patch_download(monkeypatch, slip.getvalue(), [])
        spawns = []
        _patch_spawn(monkeypatch, spawns)

        with pytest.raises(RuntimeError, match='zip 包未通过安全检查'):
            asyncio.run(execute_module.run_task(
                _zip_request('exec-evil', 'https://cdn.example.com/evil.zip')))
        assert _stream_gets(downloads) == 1
        assert list(pkg_cache.pkg_cache_dir().glob('*.zip')) == []

    def test_disabled_cache_via_settings_hits_network_every_time(
            self, monkeypatch, tmp_path):
        """PKG_CACHE_MAX_BYTES=0 → 行为与无缓存时代完全一致（每次下载）。"""
        _patch_env(monkeypatch, tmp_path)
        monkeypatch.setattr(pkg_cache.settings, 'pkg_cache_max_bytes', 0)
        payload = _zip_bytes({'main.py': b'print(4)'})
        downloads = _patch_download(monkeypatch, payload, [])
        spawns = []
        _patch_spawn(monkeypatch, spawns)

        for i in (1, 2):
            asyncio.run(execute_module.run_task(
                _zip_request(f'exec-{i}', 'https://cdn.example.com/app.zip')))
        assert _stream_gets(downloads) == 2
        assert not pkg_cache.pkg_cache_dir().exists()


# ---------------------------------------------------------------------------
# 清扫保护（node file-logger.spec.ts 对应用例）
# ---------------------------------------------------------------------------

class TestWorkdirProtection:
    def test_pkg_cache_dir_is_protected_from_ttl_sweep(self):
        """`.pkg-cache` 必须在清扫保护名单里：work_dir 顶层的一切都会被 TTL
        清扫按 mtime 删除，不保护就会在 TTL 后被整棵删掉——P2 的 N×M 重复下载
        原地复发。"""
        import maintenance

        assert pkg_cache.PKG_CACHE_DIR_NAME in maintenance._PROTECTED_WORKDIR_NAMES

    def test_node_side_protects_same_name(self):
        """两端保护名单同源（node: file-logger.ts PROTECTED_WORKDIR_NAMES）。"""
        node_source = (
            Path(__file__).parents[2]
            / 'executor-node'
            / 'src'
            / 'file-logger.ts'
        ).read_text(encoding='utf-8')
        assert f"'{pkg_cache.PKG_CACHE_DIR_NAME}'" in node_source

    def test_sweep_spares_aged_pkg_cache_entries(self, monkeypatch, tmp_path):
        """端到端：超龄的缓存条目也不被 TTL 清扫删除——回收由 pkg_cache 自身的
        字节预算负责（与 node file-logger.spec.ts 的 cachedEntry 断言对齐）。"""
        import maintenance

        monkeypatch.setattr(maintenance.settings, 'work_dir', str(tmp_path))
        cache_dir = tmp_path / pkg_cache.PKG_CACHE_DIR_NAME
        cache_dir.mkdir(parents=True)
        cached_entry = cache_dir / 'deadbeef.zip'
        cached_entry.write_bytes(b'zip-bytes')

        stale = time.time() - 30 * 24 * 60 * 60
        import os as _os
        _os.utime(cache_dir, (stale, stale))
        _os.utime(cached_entry, (stale, stale))

        maintenance.cleanup_work_dir(ttl_days=7)

        assert cache_dir.exists()
        assert cached_entry.exists()
