"""FR-01/02/03/04 zip 整包渠道（python_task_multiversion, WS4）。

覆盖：
  * happy path：下载 → vet_zip → safe_extract → 落到任务工作目录（AC-03a）
  * 渠道触发优先级 git > glue > application_zip（存量 gitRepo+applicationId 回归）
  * 缺 packageUrl → 明确失败（绝不静默跑空目录）
  * SSRF：非 http(s) / loopback / 私网 / link-local / 未指定地址一律拒绝（NFR-04）
  * 体积上限（200MB）与超时（NFR-09）
  * ZipSafetyError → 命名 violation 的清晰失败
  * legacy git 任务不进入 zip 分支
"""
import asyncio
import io
import zipfile
from types import SimpleNamespace

import pytest

from routers import execute as execute_module
from routers.execute import ExecuteRequest


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _zip_bytes(files: dict[str, bytes]) -> bytes:
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
    """把 httpx.AsyncClient 换成会回放 `payload` 的替身。"""
    record = record if record is not None else []

    def factory(*args, **kwargs):
        record.append(('client', args, kwargs))
        return _FakeAsyncClient(chunks=[payload], status_code=status_code, record=record)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', factory)
    return record


def _patch_public_dns(monkeypatch):
    """把所有主机名解析成公网地址。

    测试沙箱里没有真实 DNS；不注入的话每次 `_assert_safe_package_url` 都会
    走"解析失败 → fail-closed 拒绝"分支，happy-path 用例会以一种与主题无关的
    方式失败。SSRF 用例各自覆盖自己的解析结果。"""
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', ('93.184.216.34', 0))],
    )


def _patch_spawn(monkeypatch, record):
    """拦下所有子进程 spawn（zip 渠道本身不该 spawn 任何东西）。"""
    class _Proc:
        returncode = 0

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


def _patch_callback_env(monkeypatch, tmp_path):
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_address', 'localhost:8001')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'tok')
    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')
    _patch_public_dns(monkeypatch)


def _patch_git_checkout(monkeypatch):
    """`git_checkout_to` 是**同步**函数，经 run_in_executor 调用 → 替身也必须同步。"""
    calls = []

    def fake_git(repo, ref, work_dir):
        calls.append((repo, ref))

    monkeypatch.setattr(execute_module, 'git_checkout_to', fake_git)
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', True)
    return calls


# ---------------------------------------------------------------------------
# 触发条件与优先级（兼容红线 §4.4）
# ---------------------------------------------------------------------------

def test_legacy_git_repo_plus_application_id_never_enters_the_zip_channel(monkeypatch, tmp_path):
    """**关键回归**：存量 `gitRepo` + `applicationId`（无 codeSource）只走 git。

    DESIGN §2.6 明确记录了这种历史数据形状。applicationId 历史上只是弱引用，
    不代表"代码来自这个 zip"；若只看 bool(applicationId)，git clone 出来的源码
    会被 zip 解压覆盖，既违反兼容红线 §4.4 也是安全意外。
    """
    _patch_callback_env(monkeypatch, tmp_path)
    downloads = []
    monkeypatch.setattr(
        execute_module, '_download_package',
        _boom_download(downloads))

    git_calls = _patch_git_checkout(monkeypatch)

    req = ExecuteRequest(executionId='exec-legacy', task={
        'id': 'task-legacy', 'runtime': 'python',
        'gitRepo': 'https://git.example/repo.git',
        'applicationId': 'app-1',
        'entrypoint': 'main.py',
    })
    asyncio.run(execute_module.run_task(req))

    assert git_calls == [('https://git.example/repo.git', 'main')]
    assert downloads == [], 'the zip channel must NOT fire for a legacy git task'


def test_legacy_glue_source_plus_application_id_never_enters_the_zip_channel(monkeypatch, tmp_path):
    """glue 优先于 application_zip：glue 任务不下载包。"""
    _patch_callback_env(monkeypatch, tmp_path)
    downloads = []
    monkeypatch.setattr(
        execute_module, '_download_package',
        _boom_download(downloads))
    spawns = []
    _patch_spawn(monkeypatch, spawns)

    req = ExecuteRequest(executionId='exec-glue-app', task={
        'id': 'task-glue-app', 'runtime': 'python',
        'glueSource': 'print("hi")', 'glueLanguage': 'python',
        'applicationId': 'app-1',
    })
    asyncio.run(execute_module.run_task(req))

    assert downloads == []


def test_legacy_application_id_without_code_source_falls_back_when_no_package_url(
        monkeypatch, tmp_path):
    """歧义行（无 codeSource + applicationId + 无 packageUrl）→ 落回既有行为。

    admin 只为真正的 zip 任务附 packageUrl；没有这个正向信号时不进 zip 分支，
    也就不会因为缺 packageUrl 而把存量任务判失败。"""
    _patch_callback_env(monkeypatch, tmp_path)
    spawns = []
    _patch_spawn(monkeypatch, spawns)

    req = ExecuteRequest(executionId='exec-ambiguous', task={
        'id': 'task-ambiguous', 'runtime': 'python',
        'applicationId': 'app-1', 'entrypoint': 'main.py',
    })
    result = asyncio.run(execute_module.run_task(req))

    # 走的是普通 python 路径（无 requirements → sys.executable），不是 zip 失败
    assert result.get('errorMessage') is None or 'packageUrl' not in result['errorMessage']
    assert any(call[0] == 'spawn' for call in spawns)


def test_application_id_with_package_url_enters_the_zip_channel(monkeypatch, tmp_path):
    """无 codeSource 但 applicationId + packageUrl 同时存在 → zip 渠道。"""
    _patch_callback_env(monkeypatch, tmp_path)
    payload = _zip_bytes({'main.py': b'print(1)'})
    _patch_download(monkeypatch, payload)
    spawns = []
    _patch_spawn(monkeypatch, spawns)

    req = ExecuteRequest(executionId='exec-app-zip', task={
        'id': 'task-app-zip', 'runtime': 'python',
        'applicationId': 'app-1',
        'packageUrl': 'https://cdn.example.com/app.zip',
        'entrypoint': 'main.py',
    })
    asyncio.run(execute_module.run_task(req))

    assert (tmp_path / 'exec-app-zip' / 'main.py').exists()


def test_code_source_application_zip_with_git_repo_defers_to_git(monkeypatch, tmp_path):
    """防御性：写面互斥本应拦住这种组合；真出现则按文档优先级让位给 git。"""
    _patch_callback_env(monkeypatch, tmp_path)
    downloads = []
    monkeypatch.setattr(execute_module, '_download_package', _boom_download(downloads))
    git_calls = _patch_git_checkout(monkeypatch)

    req = ExecuteRequest(executionId='exec-conflict', task={
        'id': 'task-conflict', 'runtime': 'python',
        'codeSource': 'application_zip',
        'applicationId': 'app-1',
        'packageUrl': 'https://cdn.example.com/app.zip',
        'gitRepo': 'https://git.example/repo.git',
    })
    asyncio.run(execute_module.run_task(req))

    assert git_calls == [('https://git.example/repo.git', 'main')]
    assert downloads == []


def test_explicit_non_zip_code_source_never_enters_the_zip_channel(monkeypatch, tmp_path):
    """ZIP-PRED-01：显式 codeSource='git' 时，applicationId+packageUrl 不得触发 zip。

    executor-node 的判定是 `codeSource === 'application_zip' || (!codeSource &&
    applicationId && packageUrl)`——**显式声明了非 zip 渠道就不猜**。这里此前是
    裸 `elif application_id and package_url`：只要 applicationId 与 packageUrl
    同在就进 zip，全然不顾 codeSource 已经显式声明了别的渠道。

    注意输入形态：本例刻意**不带** gitRepo/glueSource。带它们时下游还有一道
    `is_zip_channel and (git_repo or glue_source)` 让位逻辑会把结果掩盖成一致，
    测不出这个判定的差异——只有"渠道已声明、但对应来源字段缺失"的自相矛盾
    载荷才能真正打到判定本身（admin 写面互斥下不可达，属于执行器直连派发的
    纵深防御；与 node 同形是这里的目标）。

    反证：把 `elif not code_source and ...` 改回 `elif application_id and ...`，
    本例立即转红（downloads 非空）。
    """
    _patch_callback_env(monkeypatch, tmp_path)
    downloads = []
    monkeypatch.setattr(
        execute_module, '_download_package',
        _boom_download(downloads))
    spawns = []
    _patch_spawn(monkeypatch, spawns)

    req = ExecuteRequest(executionId='exec-explicit-git', task={
        'id': 'task-explicit-git', 'runtime': 'python',
        'codeSource': 'git',
        'applicationId': 'app-1',
        'packageUrl': 'https://cdn.example.com/app.zip',
        'entrypoint': 'main.py',
    })
    asyncio.run(execute_module.run_task(req))

    assert downloads == [], '显式 codeSource=git 不得因残留 applicationId 进 zip 渠道'
    # 走的是普通 python 路径（真的起了进程），不是 zip 失败
    assert any(call[0] == 'spawn' for call in spawns)


def test_explicit_glue_code_source_never_enters_the_zip_channel(monkeypatch, tmp_path):
    """同上，渠道声明为 glue 时亦然（同上，不带 glueSource 以打到判定本身）。"""
    _patch_callback_env(monkeypatch, tmp_path)
    downloads = []
    monkeypatch.setattr(
        execute_module, '_download_package',
        _boom_download(downloads))
    spawns = []
    _patch_spawn(monkeypatch, spawns)

    req = ExecuteRequest(executionId='exec-explicit-glue', task={
        'id': 'task-explicit-glue', 'runtime': 'python',
        'codeSource': 'glue',
        'applicationId': 'app-1',
        'packageUrl': 'https://cdn.example.com/app.zip',
        'entrypoint': 'main.py',
    })
    asyncio.run(execute_module.run_task(req))

    assert downloads == []
    assert any(call[0] == 'spawn' for call in spawns)


# ---------------------------------------------------------------------------
# happy path / 缺 packageUrl / zip 安全
# ---------------------------------------------------------------------------

def test_zip_channel_downloads_and_extracts_into_the_work_dir(monkeypatch, tmp_path):
    """AC-03a：下载 → 审查 → 解压到任务工作目录。"""
    _patch_callback_env(monkeypatch, tmp_path)
    payload = _zip_bytes({'main.py': b'print(1)', 'pkg/data.txt': b'hello'})
    record = _patch_download(monkeypatch, payload)
    spawns = []
    _patch_spawn(monkeypatch, spawns)

    req = ExecuteRequest(executionId='exec-zip-ok', task={
        'id': 'task-zip-ok', 'runtime': 'python',
        'codeSource': 'application_zip', 'applicationId': 'app-1',
        'packageUrl': 'https://cdn.example.com/app.zip',
        'entrypoint': 'main.py',
    })
    result = asyncio.run(execute_module.run_task(req))

    work_dir = tmp_path / 'exec-zip-ok'
    assert (work_dir / 'main.py').read_bytes() == b'print(1)'
    assert (work_dir / 'pkg' / 'data.txt').read_bytes() == b'hello'
    # 包本体是中间产物：解压后必须删除
    assert not (work_dir / '.package.zip').exists()
    assert result['success'] is False or result['exitCode'] == 0
    assert any(call[0] == 'stream' for call in record)


def test_missing_package_url_fails_loudly(monkeypatch, tmp_path):
    """缺 packageUrl → 明确失败，绝不静默跑一个空工作目录。"""
    _patch_callback_env(monkeypatch, tmp_path)
    downloads = []
    monkeypatch.setattr(execute_module, '_download_package', _boom_download(downloads))

    req = ExecuteRequest(executionId='exec-no-url', task={
        'id': 'task-no-url', 'runtime': 'python',
        'codeSource': 'application_zip', 'applicationId': 'app-1',
    })
    result = asyncio.run(execute_module.run_task(req))

    assert result['success'] is False
    assert 'packageUrl' in result['errorMessage']
    assert downloads == []


def test_zip_safety_violation_maps_to_a_clear_failure(monkeypatch, tmp_path):
    """AC-03a：ZipSafetyError → 失败消息**点名** violation。

    准备阶段的失败沿用既有约定以异常抛出（与 `uv pip install failed` 同一条
    路径：`_run_and_callback` 捕获后归类 + 回调），因此这里断言的是抛出内容；
    下面的用例再断言它被归类成 `package_fetch_failed`。"""
    _patch_callback_env(monkeypatch, tmp_path)
    payload = _zip_bytes({'main.py': b'print(1)'})
    _patch_download(monkeypatch, payload)

    class FakeZipSafety:
        class ZipSafetyError(ValueError):
            def __init__(self, violation, detail):
                self.violation = violation
                self.detail = detail
                super().__init__(f'[{violation}] {detail}')

        @staticmethod
        def vet_zip(path, *, limits=None):
            raise FakeZipSafety.ZipSafetyError('zip_slip', 'entry escapes the destination')

        @staticmethod
        def safe_extract(path, dest, *, limits=None):
            raise AssertionError('safe_extract must not run after vet_zip rejected')

    monkeypatch.setattr(execute_module, '_zip_safety', FakeZipSafety)

    req = ExecuteRequest(executionId='exec-slip', task={
        'id': 'task-slip', 'runtime': 'python',
        'codeSource': 'application_zip', 'applicationId': 'app-1',
        'packageUrl': 'https://cdn.example.com/evil.zip',
        'entrypoint': 'main.py',
    })
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(execute_module.run_task(req))

    assert 'zip_slip' in str(exc.value)
    assert execute_module._refine_failure_reason(str(exc.value)) == 'package_fetch_failed'


def test_zip_safety_violation_reaches_the_callback_with_a_named_reason(monkeypatch, tmp_path):
    """端到端：ZipSafetyError → 终态回调带 package_fetch_failed 与可读消息。"""
    _patch_callback_env(monkeypatch, tmp_path)
    posted = {}

    class FakeAsyncClient:
        """同时充当"下载用的流式客户端"和"回调用的 POST 客户端"。

        run_task 的包下载与 _send_callback_with_retry 的回调都经
        `execute_module.httpx.AsyncClient`；两条路径各要一个能力，因此一个替身
        同时实现 stream() 与 post()。"""

        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, headers=None):
            return _FakeStreamResponse([_zip_bytes({'main.py': b'print(1)'})])

        async def post(self, url, json=None, headers=None):
            posted['json'] = json
            return SimpleNamespace(status_code=200)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', FakeAsyncClient)

    class FakeZipSafety:
        class ZipSafetyError(ValueError):
            def __init__(self, violation, detail):
                self.violation = violation
                self.detail = detail
                super().__init__(f'[{violation}] {detail}')

        @staticmethod
        def vet_zip(path, *, limits=None):
            raise FakeZipSafety.ZipSafetyError('zip_slip', 'entry escapes the destination')

        @staticmethod
        def safe_extract(path, dest, *, limits=None):
            pass

    monkeypatch.setattr(execute_module, '_zip_safety', FakeZipSafety)

    asyncio.run(execute_module._run_and_callback(ExecuteRequest(
        executionId='exec-slip-cb', task={
            'id': 'task-slip-cb', 'runtime': 'python',
            'codeSource': 'application_zip', 'applicationId': 'app-1',
            'packageUrl': 'https://cdn.example.com/evil.zip',
            'entrypoint': 'main.py',
        })))

    items = posted['json']          # 回调体是裸列表（json=[payload]）
    assert items[0]['status'] == 'failed'
    assert items[0]['failureReason'] == 'package_fetch_failed'
    assert 'zip_slip' in items[0]['errorMessage']


def test_real_zip_slip_package_is_rejected_end_to_end(monkeypatch, tmp_path):
    """E-2（审计补漏）：**真实** zip-slip 包经完整 run_task 链路被拒。

    既有用例（test_zip_safety_violation_maps_to_a_clear_failure 等）用替身
    `_zip_safety` 抛错，验证的是 execute 侧的错误包装/回调归类；本用例构造真实
    的越界 zip 包（`../evil.py`），只替身下载环节，让真实的
    `zip_safety.vet_zip` 在 run_task 里拒绝它——补上"接收 → 真实审查 → 拒绝 →
    工作目录零产物"这一段集成守卫（替身用例测不到真实模块的行为）。
    """
    _patch_callback_env(monkeypatch, tmp_path)
    payload = _zip_bytes({'../evil.py': b'print("pwned")'})
    _patch_download(monkeypatch, payload)
    spawns = []
    _patch_spawn(monkeypatch, spawns)

    req = ExecuteRequest(executionId='exec-real-slip', task={
        'id': 'task-real-slip', 'runtime': 'python',
        'codeSource': 'application_zip', 'applicationId': 'app-1',
        'packageUrl': 'https://cdn.example.com/evil.zip',
        'entrypoint': 'main.py',
    })
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(execute_module.run_task(req))

    assert 'zip_slip' in str(exc.value), f'违规名必须点名 zip_slip，实际 {exc.value}'
    assert 'zip package rejected by safety check' in str(exc.value)
    # vet_zip 在任何字节写出之前拒绝：不得解压出任何脚本，临时包文件必须被清理。
    # （run_task 预备阶段会创建空的 artifacts/ 目录——那是任务台面，不是解压产物，
    # 不参与"零残留"判定。）
    work_dir = tmp_path / 'exec-real-slip'
    assert not (work_dir / 'main.py').exists(), 'zip-slip 包不得解压出任何脚本'
    assert not (work_dir / '.package.zip').exists(), '临时包文件必须被清理'
    extracted = [str(p.relative_to(work_dir)) for p in work_dir.rglob('*')
                 if p.name not in ('artifacts',) and p.is_file()]
    assert not extracted, f'zip-slip 包不得在目标目录留下任何文件产物：{extracted}'
    # 真实模块的违规也走同一条归类链（与替身用例逐字一致）
    assert execute_module._refine_failure_reason(str(exc.value)) == 'package_fetch_failed'
    assert spawns == [], '包审查失败后不得执行任何任务代码'


def test_real_zip_safe_package_extracts_without_spawning_uv_before_entrypoint(monkeypatch, tmp_path):
    """E-2 正例对照：真实安全包在 run_task 里解压落盘，且只在解压完成后
    才 spawn 入口进程（顺序纪律：先 vet_zip 再 safe_extract 再执行）。"""
    class _LineStream:
        def __init__(self, lines):
            self._lines = lines

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self._lines:
                raise StopAsyncIteration
            return self._lines.pop(0)

    class _Proc:
        returncode = 0
        stdout = _LineStream([b'print 1\n'])

        async def communicate(self):
            return b'', b''

        def kill(self):
            pass

        async def wait(self):
            return 0

    _patch_callback_env(monkeypatch, tmp_path)
    payload = _zip_bytes({'main.py': b'print(1)'})
    _patch_download(monkeypatch, payload)
    spawns = []

    async def fake_exec(*args, **kwargs):
        spawns.append(('spawn', list(args)))
        return _Proc()

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)

    req = ExecuteRequest(executionId='exec-real-safe', task={
        'id': 'task-real-safe', 'runtime': 'python',
        'codeSource': 'application_zip', 'applicationId': 'app-1',
        'packageUrl': 'https://cdn.example.com/app.zip',
        'entrypoint': 'main.py',
    })
    result = asyncio.run(execute_module.run_task(req))

    work_dir = tmp_path / 'exec-real-safe'
    assert (work_dir / 'main.py').read_bytes() == b'print(1)', '安全包必须真实解压落盘'
    assert result['success'] is True, f'安全包任务应成功，实际 {result}'
    assert result['exitCode'] == 0
    assert any(call[0] == 'spawn' for call in spawns), '入口脚本必须被 spawn 执行'


def test_legacy_git_task_does_not_enter_the_zip_channel(monkeypatch, tmp_path):
    """codeSource 缺省的纯 git 任务（最常见存量形状）不进 zip 分支。"""
    _patch_callback_env(monkeypatch, tmp_path)
    downloads = []
    monkeypatch.setattr(execute_module, '_download_package', _boom_download(downloads))
    _patch_git_checkout(monkeypatch)

    req = ExecuteRequest(executionId='exec-git-only', task={
        'id': 'task-git-only', 'runtime': 'python',
        'gitRepo': 'https://git.example/repo.git',
    })
    asyncio.run(execute_module.run_task(req))

    assert downloads == []


# ---------------------------------------------------------------------------
# SSRF（NFR-04）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('url', [
    'ftp://cdn.example.com/app.zip',
    'file:///etc/passwd',
    'gopher://cdn.example.com/x',
    'javascript:alert(1)',
    'https:///no-host.zip',
    'not-a-url',
    '',
])
def test_package_url_scheme_guard_rejects_non_http(url, monkeypatch):
    from fastapi import HTTPException
    _patch_public_dns(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        execute_module._assert_safe_package_url(url)
    assert exc.value.status_code == 400


@pytest.mark.parametrize('url', [
    'http://127.0.0.1/app.zip',
    'http://127.1.2.3/app.zip',
    'http://localhost/app.zip',
    'http://[::1]/app.zip',
    'http://169.254.169.254/latest/meta-data/',   # 云元数据
    'http://10.0.0.5/app.zip',
    'http://192.168.1.10/app.zip',
    'http://172.16.0.9/app.zip',
    'http://0.0.0.0/app.zip',
    'http://100.64.0.1/app.zip',                   # CGNAT
    'http://224.0.0.1/app.zip',                    # multicast
    'http://[fe80::1]/app.zip',                    # IPv6 link-local
    'http://[fd00::1]/app.zip',                    # IPv6 ULA
])
def test_package_url_ssrf_guard_rejects_restricted_addresses(url, monkeypatch):
    """默认姿态（allow_private_network=False）：私网/loopback/link-local 全拒。"""
    from fastapi import HTTPException
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', False)
    with pytest.raises(HTTPException) as exc:
        execute_module._assert_safe_package_url(url)
    assert exc.value.status_code == 400
    assert 'restricted' in exc.value.detail


@pytest.mark.parametrize('url', [
    'http://127.0.0.1/app.zip',
    'http://localhost/app.zip',
    'http://[::1]/app.zip',
])
def test_loopback_is_never_allowed_even_with_private_network_enabled(url, monkeypatch):
    """loopback 不随 `allow_private_network` 放行（与 gitRepo 守卫同款裁定）。"""
    from fastapi import HTTPException
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', True)
    with pytest.raises(HTTPException):
        execute_module._assert_safe_package_url(url)


def test_private_network_allowed_only_when_the_setting_is_on(monkeypatch):
    """开关语义与 gitRepo 守卫逐条对齐：True 时放行 RFC1918。"""
    from fastapi import HTTPException
    _patch_public_dns(monkeypatch)
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', False)
    with pytest.raises(HTTPException):
        execute_module._assert_safe_package_url('http://10.1.2.3/app.zip')

    monkeypatch.setattr(execute_module.settings, 'allow_private_network', True)
    assert execute_module._assert_safe_package_url('http://10.1.2.3/app.zip') == 'http://10.1.2.3/app.zip'


def test_package_url_userinfo_is_rejected(monkeypatch):
    from fastapi import HTTPException
    _patch_public_dns(monkeypatch)
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', True)
    with pytest.raises(HTTPException) as exc:
        execute_module._assert_safe_package_url('https://user:secret@cdn.example.com/app.zip')
    assert 'userinfo' in exc.value.detail


def test_dns_name_resolving_to_a_private_address_is_rejected(monkeypatch):
    """字符串级判定拦不住 `http://internal.corp/`——必须真解析（比 node 侧更强）。"""
    from fastapi import HTTPException
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', False)
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', ('10.0.0.7', 0))],
    )
    with pytest.raises(HTTPException) as exc:
        execute_module._assert_safe_package_url('http://internal.corp/app.zip')
    assert 'restricted' in exc.value.detail


def test_unresolvable_host_fails_closed(monkeypatch):
    import socket as _socket
    from fastapi import HTTPException
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', False)

    def boom(*a, **k):
        raise _socket.gaierror('no such host')

    monkeypatch.setattr(execute_module.socket, 'getaddrinfo', boom)
    with pytest.raises(HTTPException):
        execute_module._assert_safe_package_url('http://nope.invalid/app.zip')


def test_public_host_is_accepted(monkeypatch):
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', False)
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', ('93.184.216.34', 0))],
    )
    assert execute_module._assert_safe_package_url(
        'https://cdn.example.com/app.zip') == 'https://cdn.example.com/app.zip'


# ---------------------------------------------------------------------------
# 体积上限 / 超时 / 鉴权头
# ---------------------------------------------------------------------------

def test_oversize_download_is_aborted_and_leaves_no_partial_file(monkeypatch, tmp_path):
    """NFR-04：边下边计数，超限立即中止并删除半成品。"""
    monkeypatch.setattr(execute_module, 'ZIP_DOWNLOAD_MAX_BYTES', 10)
    record = []
    monkeypatch.setattr(
        execute_module.httpx, 'AsyncClient',
        lambda *a, **k: _FakeAsyncClient(chunks=[b'x' * 8, b'y' * 8], record=record),
    )
    dest = tmp_path / 'pkg.zip'

    with pytest.raises(RuntimeError, match='exceeds'):
        asyncio.run(execute_module._download_package('https://cdn.example.com/app.zip', dest))

    assert not dest.exists(), 'a partial download must not survive'


def test_non_200_download_fails_without_echoing_the_url(monkeypatch, tmp_path):
    _patch_public_dns(monkeypatch)
    monkeypatch.setattr(
        execute_module.httpx, 'AsyncClient',
        lambda *a, **k: _FakeAsyncClient(chunks=[], status_code=404),
    )
    dest = tmp_path / 'pkg.zip'
    with pytest.raises(RuntimeError, match='HTTP 404'):
        asyncio.run(execute_module._download_package('https://cdn.example.com/app.zip', dest))
    assert not dest.exists()


def test_download_carries_bearer_token_only_for_the_admin_host(monkeypatch, tmp_path):
    """镜像 executor-node download.ts：只对 admin 首跳带令牌，第三方不带。"""
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local:3105')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'shared-token')

    admin_headers = execute_module._package_download_headers(
        'http://admin.local:3105/uploads/packages/app.zip')
    assert admin_headers.get('Authorization') == 'Bearer shared-token'

    third_party = execute_module._package_download_headers(
        'https://cdn.example.com/app.zip')
    assert 'Authorization' not in third_party


def test_download_follows_no_redirects(monkeypatch, tmp_path):
    """redirect 会绕过首跳的 SSRF 判定与令牌剥离策略 → 一律不跟随。"""
    captured = {}

    def factory(*args, **kwargs):
        captured.update(kwargs)
        return _FakeAsyncClient(chunks=[b'ok'])

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', factory)
    asyncio.run(execute_module._download_package(
        'https://cdn.example.com/app.zip', tmp_path / 'pkg.zip'))

    assert captured.get('follow_redirects') is False
    assert captured.get('trust_env') is False
    assert captured.get('timeout') == execute_module.ZIP_DOWNLOAD_TIMEOUT_SECONDS


def test_extraction_requires_the_zip_safety_module(monkeypatch, tmp_path):
    """模块缺席 → 明确失败，绝不退化成 zipfile.extractall（那正是 zip-slip 入口）。"""
    monkeypatch.setattr(execute_module, '_zip_safety', None)
    with pytest.raises(RuntimeError, match='zip_safety'):
        execute_module._extract_package(tmp_path / 'x.zip', tmp_path)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _boom_download(record):
    async def _inner(url, dest):
        record.append(url)
        raise AssertionError('the package must not be downloaded on this path')
    return _inner
