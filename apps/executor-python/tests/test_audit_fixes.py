"""本轮审计修复（A-1/A-3/A-5/A-7/A-9/A-11 python 侧）的回归守卫。

每条用例对应报告里的一个 A-x 编号；node 侧对齐断言见
apps/executor-node/src/audit-fixes.spec.ts 与契约向量
packages/contract-fixtures/contract.json 的 executorEnvSerialization 段。
"""
import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from routers import execute as execute_module
from routers.execute import ExecuteRequest


# ---------------------------------------------------------------------------
# 共享小工具
# ---------------------------------------------------------------------------

class _FakeLineStream:
    def __init__(self, lines):
        self._lines = lines

    def __aiter__(self):
        async def _gen():
            for line in self._lines:
                yield line
        return _gen()


class _FakeTaskProc:
    def __init__(self, lines=(b'ok\n',)):
        self.returncode = 0
        self.stdout = _FakeLineStream(list(lines))
        self.pid = 4242

    async def wait(self):
        return 0


# ---------------------------------------------------------------------------
# A-1：超时对象覆盖 proc.wait()——关 stdout 的假僵尸进程必须被超时树杀
# ---------------------------------------------------------------------------

def test_run_task_timeout_kills_process_that_closed_stdout(tmp_path, monkeypatch):
    """A-1（P1）：任务 os.close(1) 后继续运行（daemonize 自分离）→ stdout 流
    提前 EOF，旧实现只 wait_for(流) 就返回、`await proc.wait()` 无超时永久
    挂住。修复后超时对象覆盖 (stream, wait) 组合：超时走既有杀树分支，进程
    被杀、run_task 返回 timeout 失败结果（槽位不再无限占用）。"""
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    workdir = tmp_path / 'exec-a1-zombie'
    workdir.mkdir(parents=True)
    alive = workdir / 'alive.txt'
    # 僵尸脚本：打印一行后关掉自己的 stdout，然后靠心跳文件证明自己还活着。
    (workdir / 'zombie.py').write_text(
        'import os, sys, time\n'
        'print("started", flush=True)\n'
        'sys.stdout.flush()\n'
        f'alive = {str(alive)!r}\n'
        'os.close(1)\n'
        'while True:\n'
        '    with open(alive, "a") as f:\n'
        '        f.write("x")\n'
        '    time.sleep(0.1)\n'
    )
    req = ExecuteRequest(
        executionId='exec-a1-zombie',
        task={'name': 'zombie', 'runtime': 'python', 'entrypoint': 'zombie.py',
              'timeoutSeconds': 1},
    )
    started = time.monotonic()
    result = asyncio.run(execute_module.run_task(req))
    elapsed = time.monotonic() - started

    assert result['success'] is False
    assert 'Task timeout after 1s' in result['errorMessage']
    assert result['exitCode'] is None
    # run_task 必须按超时收敛（1s 预算 + 杀树），而不是永久挂在 proc.wait() 上
    assert elapsed < 30

    # 进程确实被树杀：心跳文件停止增长（进程若存活，每 0.1s 追加一个 "x"）
    assert alive.exists()
    size = alive.stat().st_size
    stable = False
    for _ in range(10):
        time.sleep(0.3)
        if alive.stat().st_size == size:
            stable = True
            break
        size = alive.stat().st_size
    assert stable, 'zombie process was not killed after the timeout'


def test_run_task_timeout_unregisters_entry_via_run_and_callback(tmp_path, monkeypatch):
    """A-1 收尾语义：超时僵尸被杀后，_run_and_callback 照常完成终态收敛——
    entry 从 live 注册表摘除（心跳 runningExecutionIds 不再上报）、proc 句柄
    置空。admin_api_url 置空使回调块整体跳过（本用例只验证注册表收尾）。"""
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    workdir = tmp_path / 'exec-a1-live'
    workdir.mkdir(parents=True)
    alive = workdir / 'alive.txt'
    (workdir / 'zombie.py').write_text(
        'import os, time\n'
        f'alive = {str(alive)!r}\n'
        'os.close(1)\n'
        'while True:\n'
        '    with open(alive, "a") as f:\n'
        '        f.write("x")\n'
        '    time.sleep(0.1)\n'
    )
    entry = execute_module.register_live_execution('exec-a1-live')
    req = ExecuteRequest(
        executionId='exec-a1-live',
        task={'name': 'zombie', 'runtime': 'python', 'entrypoint': 'zombie.py',
              'timeoutSeconds': 1},
    )
    result = asyncio.run(execute_module._run_and_callback(req, entry))

    assert result is None  # 终态回调被 admin_api_url 缺省跳过，仅收尾
    assert not execute_module.execution_exists('exec-a1-live')
    assert entry.proc is None


# ---------------------------------------------------------------------------
# A-3：pull 载荷漂移（ValidationError）必须补发 failed 回调，不再被吞成 warn
# ---------------------------------------------------------------------------

class TestPullPayloadValidation:
    async def _run_loop_briefly(self, seconds=1.4):
        import scheduler as scheduler_module
        task = asyncio.create_task(scheduler_module.pull_task())
        await asyncio.sleep(seconds)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _setup_common(self, monkeypatch, resp):
        import scheduler as scheduler_module
        token_mock = AsyncMock(return_value='static-token')
        monkeypatch.setattr(scheduler_module, 'get_current_token', token_mock)

        async def fake_heal(client, method, url, **kwargs):
            return resp

        monkeypatch.setattr(scheduler_module, 'request_with_self_heal', fake_heal)

    @pytest.mark.asyncio
    async def test_pull_payload_validation_error_sends_failed_callback(self, monkeypatch):
        """A-3：缺 task 字段的漂移载荷 → ExecuteRequest(**body) 抛
        ValidationError。修复前它悬在内层 try 之外被外层 except 吞成
        'Pull failed' warn（不回调 → admin 僵尸 RUNNING）；修复后与 node
        pull.ts 的 schema 400 → pushCallback failed 同语义收敛。"""
        import scheduler as scheduler_module
        scheduler_module.running_count = 0
        resp = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok',
                  'data': {'task': {'executionId': 'exec-a3-drift'}}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        await self._setup_common(monkeypatch, resp)
        rejections = []

        async def fake_reject(eid, reason, tp=None):
            rejections.append((eid, reason, tp))

        monkeypatch.setattr(execute_module, 'reject_pulled_execution', fake_reject)
        monkeypatch.setattr(execute_module, 'accept_execution',
                            lambda *a, **k: pytest.fail('accept must not be reached'))

        await self._run_loop_briefly()

        assert len(rejections) == 1
        eid, reason, tp = rejections[0]
        assert eid == 'exec-a3-drift'
        assert 'validation failed' in reason
        # 预留已释放，账本归零
        assert scheduler_module.get_running_count() == 0

    @pytest.mark.asyncio
    async def test_pull_payload_validation_error_carries_traceparent(self, monkeypatch):
        """A-3：traceparent 随 failed 回调透传（与 accept 成功路径同口径）。"""
        import scheduler as scheduler_module
        scheduler_module.running_count = 0
        resp = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok',
                  'data': {'task': {'executionId': 'exec-a3-tp',
                                    'traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'}}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        await self._setup_common(monkeypatch, resp)
        rejections = []

        async def fake_reject(eid, reason, tp=None):
            rejections.append((eid, tp))

        monkeypatch.setattr(execute_module, 'reject_pulled_execution', fake_reject)

        await self._run_loop_briefly()

        assert rejections == [
            ('exec-a3-tp',
             '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
        ]
        scheduler_module.running_count = 0


# ---------------------------------------------------------------------------
# A-5：prepare 阶段可取消——检查点命中后不再进入后续阶段、绝不 spawn
# ---------------------------------------------------------------------------

def test_prepare_cancelled_during_git_clone_never_spawns(tmp_path, monkeypatch):
    """A-5：kill 在 git clone（run_in_executor 线程）运行期间下达 → clone
    返回后的检查点命中，run_task 以 killed 结果静默收敛，绝不进入 spawn。"""
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    entry = execute_module.register_live_execution('exec-a5-git')
    spawned = []

    async def fail_spawn(*args, **kwargs):
        spawned.append(args)
        return _FakeTaskProc()

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fail_spawn)

    def fake_git_checkout(repo_url, ref, dest):
        # 模拟 kill 在 clone 进行中下达（kill 端点对未 spawn 执行置 cancelled）
        entry.cancelled = True

    monkeypatch.setattr(execute_module, 'git_checkout_to', fake_git_checkout)

    req = ExecuteRequest(
        executionId='exec-a5-git',
        task={'name': 't', 'runtime': 'python', 'entrypoint': 'main.py',
              'gitRepo': 'https://example.com/x.git'},
    )
    result = asyncio.run(execute_module.run_task(req, entry))

    assert result['success'] is False
    assert 'killed by admin request' in result['errorMessage'].lower()
    assert spawned == [], 'prepare 被取消后绝不能再 spawn'
    execute_module.unregister_live_execution('exec-a5-git')


def test_prepare_cancelled_before_zip_download_never_spawns(tmp_path, monkeypatch):
    """A-5：kill 在 zip 下载前下达 → 检查点直接收敛（下载/解压/spawn 全跳过）。"""
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    entry = execute_module.register_live_execution('exec-a5-zip')
    entry.cancelled = True
    spawned = []

    async def fail_spawn(*args, **kwargs):
        spawned.append(args)
        return _FakeTaskProc()

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fail_spawn)

    async def boom_download(*args, **kwargs):
        pytest.fail('download must not start after cancellation')

    monkeypatch.setattr(execute_module, '_download_package', boom_download)
    # SSRF 闸与本用例无关（hostname 不做真实 DNS），置直通保持用例自洽
    monkeypatch.setattr(execute_module, '_assert_safe_package_url',
                        lambda url: url)

    req = ExecuteRequest(
        executionId='exec-a5-zip',
        task={'name': 't', 'runtime': 'python', 'entrypoint': 'main.py',
              'codeSource': 'application_zip', 'applicationId': 'app-1',
              'packageUrl': 'http://admin.local/packages/p.zip'},
    )
    result = asyncio.run(execute_module.run_task(req, entry))

    assert result['success'] is False
    assert 'killed by admin request' in result['errorMessage'].lower()
    assert spawned == []
    execute_module.unregister_live_execution('exec-a5-zip')


def test_download_package_cancelled_midstream_cleans_up(tmp_path):
    """A-5：_download_package 的逐 chunk 取消检查——命中抛 _PrepareCancelled，
    半成品被清理（与既有错误路径同一清理分支）。"""
    dest = tmp_path / '.package.zip'

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b'chunk-chunk-chunk')

    class PatchedClient(httpx.AsyncClient):
        def __init__(self, *a, **k):
            k['transport'] = httpx.MockTransport(handler)
            super().__init__(*a, **k)

    real_client = execute_module.httpx.AsyncClient
    execute_module.httpx.AsyncClient = PatchedClient
    try:
        with pytest.raises(execute_module._PrepareCancelled):
            asyncio.run(execute_module._download_package(
                'http://admin.local/packages/p.zip', dest,
                should_cancel=lambda: True,
            ))
    finally:
        execute_module.httpx.AsyncClient = real_client

    assert not dest.exists(), 'cancelled download must clean up the partial file'


def test_ensure_venv_cancelled_before_uv_and_before_pip(tmp_path, monkeypatch):
    """A-5：ensure_venv 的两个检查点——入口（任何 uv 之前）与 venv 建成后 /
    pip install 前。命中即抛 _PrepareCancelled，绝不 spawn uv。"""
    uv_calls = []

    async def fake_run_uv(args, timeout_seconds, *, env=None):
        uv_calls.append(list(args))
        return 0, ''

    monkeypatch.setattr(execute_module, '_run_uv', fake_run_uv)

    # 1) 入口检查：venv 不存在、should_cancel 恒 True → uv 一次都不跑
    with pytest.raises(execute_module._PrepareCancelled):
        asyncio.run(execute_module.ensure_venv(
            tmp_path / '.venvs' / 'task-a5', ['requests'],
            should_cancel=lambda: True,
        ))
    assert uv_calls == []

    # 2) venv 建成后 / pip 前检查：健康 venv 复用 + should_cancel 恒 True →
    #    不再进入 pip install
    venv_dir = tmp_path / '.venvs' / 'task-a5-healthy'
    home = tmp_path / 'pool' / 'cpython-3.12.11-windows-x86_64-none'
    home.mkdir(parents=True)
    python_bin = execute_module._venv_python_bin(venv_dir)
    python_bin.parent.mkdir(parents=True, exist_ok=True)
    python_bin.write_text('shim')
    (venv_dir / 'pyvenv.cfg').write_text(
        f'home = {home}\nversion_info = 3.12.11\n'
    )
    with pytest.raises(execute_module._PrepareCancelled):
        asyncio.run(execute_module.ensure_venv(
            venv_dir, ['requests'], should_cancel=lambda: True,
        ))
    assert uv_calls == [], 'cancelled ensure_venv must never spawn uv'

    # 3) 对照：should_cancel=None（旧调用形态）→ pip install 照常发生
    asyncio.run(execute_module.ensure_venv(venv_dir, ['requests']))
    assert len(uv_calls) == 1
    assert 'pip' in uv_calls[0]


# ---------------------------------------------------------------------------
# A-7：_task_locks 空闲回收（node task-worker.ts IDLE_RECYCLE_MS 对齐）
# ---------------------------------------------------------------------------

def test_task_lock_recycled_after_idle_window(monkeypatch):
    """A-7：release 后空闲满回收窗口 → 锁从 _task_locks 摘除；窗口内复用
    （重新 acquire）则取消回收；在用锁绝不回收。"""
    monkeypatch.setattr(execute_module, 'TASK_LOCK_IDLE_RECYCLE_SECONDS', 0.05)

    async def scenario():
        lock = execute_module._get_task_lock('t-a7')
        assert execute_module._task_locks.get('t-a7') is lock

        async with lock:
            # 持有期间越过回收窗口：在用锁绝不回收
            await asyncio.sleep(0.2)
            assert execute_module._task_locks.get('t-a7') is lock
        # release 起算空闲；摘除前复用会取消回收
        lock2 = execute_module._get_task_lock('t-a7')
        assert lock2 is lock
        async with lock2:
            await asyncio.sleep(0.2)
            assert 't-a7' in execute_module._task_locks

        # 真正空闲：窗口后摘除
        await asyncio.sleep(0.3)
        assert 't-a7' not in execute_module._task_locks

        # 重建：拿到的是新锁
        fresh = execute_module._get_task_lock('t-a7')
        assert fresh is not lock

    asyncio.run(scenario())


def test_task_lock_recycle_never_removes_a_rebuilt_lock(monkeypatch):
    """A-7 双保险：旧锁的回收定时器绝不误删同 taskId 重建的新锁。"""
    monkeypatch.setattr(execute_module, 'TASK_LOCK_IDLE_RECYCLE_SECONDS', 0.05)

    async def scenario():
        old = execute_module._get_task_lock('t-a7b')
        async with old:
            pass
        # 手工模拟「旧锁仍挂着回收定时器，但字典里已换成新锁」
        execute_module._task_locks.pop('t-a7b')
        fresh = execute_module._RecyclableTaskLock('t-a7b')
        execute_module._task_locks['t-a7b'] = fresh

        await asyncio.sleep(0.3)

        # 旧锁的定时器触发，但字典里是 fresh → 不得误删
        assert execute_module._task_locks.get('t-a7b') is fresh

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# A-9：包下载跟随重定向（≤5 跳；同 host 保留 Bearer、跨 host 剥离）
# ---------------------------------------------------------------------------

def _patch_http_transport(monkeypatch, handler):
    class PatchedClient(httpx.AsyncClient):
        def __init__(self, *a, **k):
            k['transport'] = httpx.MockTransport(handler)
            super().__init__(*a, **k)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', PatchedClient)


def _setup_download_auth(monkeypatch):
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'tok-a9')
    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')


def test_download_package_follows_same_host_redirect_keeping_bearer(tmp_path, monkeypatch):
    """A-9：301/302 不再直接 RuntimeError；同 host 跳转保留 Authorization
    （与 node lib/download.ts 的 sendAuth 策略同语义）。"""
    _setup_download_auth(monkeypatch)
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers.get('authorization')))
        if request.url.path == '/packages/first':
            return httpx.Response(302, headers={'Location': '/packages/second.zip'})
        return httpx.Response(200, content=b'payload-bytes')

    _patch_http_transport(monkeypatch, handler)
    dest = tmp_path / '.package.zip'

    size = asyncio.run(execute_module._download_package(
        'http://admin.local/packages/first', dest,
    ))

    assert size == len(b'payload-bytes')
    assert dest.read_bytes() == b'payload-bytes'
    assert [u for u, _ in seen] == [
        'http://admin.local/packages/first',
        'http://admin.local/packages/second.zip',
    ]
    assert seen[0][1] == 'Bearer tok-a9'
    assert seen[1][1] == 'Bearer tok-a9', 'same-host redirect must keep the Bearer'


def test_download_package_strips_bearer_on_cross_host_redirect(tmp_path, monkeypatch):
    """A-9：跨 host 跳转剥离 Authorization——共享令牌绝不泄漏给非 admin 目标。"""
    _setup_download_auth(monkeypatch)
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers.get('authorization')))
        if request.url.host == 'admin.local':
            return httpx.Response(
                301, headers={'Location': 'http://mirror.example/payload.zip'})
        return httpx.Response(200, content=b'cdn-bytes')

    _patch_http_transport(monkeypatch, handler)
    dest = tmp_path / '.package.zip'

    size = asyncio.run(execute_module._download_package(
        'http://admin.local/packages/p.zip', dest,
    ))

    assert size == len(b'cdn-bytes')
    assert seen[0] == ('http://admin.local/packages/p.zip', 'Bearer tok-a9')
    assert seen[1][0] == 'http://mirror.example/payload.zip'
    assert seen[1][1] is None, 'cross-host redirect must strip the Bearer'


def test_download_package_too_many_redirects(tmp_path, monkeypatch):
    """A-9：超过 5 跳（第 6 个重定向响应）→ too many redirects，与 node
    maxRedirects=5 同值同语义。"""
    _setup_download_auth(monkeypatch)
    count = {'n': 0}

    def handler(request: httpx.Request) -> httpx.Response:
        count['n'] += 1
        return httpx.Response(302, headers={'Location': '/packages/loop'})

    _patch_http_transport(monkeypatch, handler)
    dest = tmp_path / '.package.zip'

    with pytest.raises(RuntimeError, match='too many redirects'):
        asyncio.run(execute_module._download_package(
            'http://admin.local/packages/loop', dest,
        ))
    assert count['n'] == 6  # 初始请求 + 5 跳，第 6 个重定向响应即失败
    assert not dest.exists()


def test_download_package_plain_404_still_reports_status(tmp_path, monkeypatch):
    """A-9 回归对照：非重定向的失败响应维持既有错误语义（只报状态码）。"""
    _setup_download_auth(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, content=b'nope')

    _patch_http_transport(monkeypatch, handler)
    dest = tmp_path / '.package.zip'

    with pytest.raises(RuntimeError, match='HTTP 404'):
        asyncio.run(execute_module._download_package(
            'http://admin.local/packages/missing.zip', dest,
        ))
    assert not dest.exists()


# ---------------------------------------------------------------------------
# A-11：params→env 统一 JSON 序列化（node JSON.stringify 对齐）
# ---------------------------------------------------------------------------

def test_run_task_params_env_use_json_serialization(tmp_path, monkeypatch):
    """A-11（P3）：AUTOFLOW_* env 统一 JSON 序列化——布尔/空值/容器与 node
    JSON.stringify 产出逐字节一致（此前 str(v) 产出 'True'/'None'/"['a']"）。
    契约向量：contract-fixtures/contract.json 的 executorEnvSerialization 段。"""
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    captured = {}

    async def fake_spawn(*args, **kwargs):
        captured['env'] = dict(kwargs.get('env') or {})
        return _FakeTaskProc()

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_spawn)

    req = ExecuteRequest(
        executionId='exec-a11',
        task={'name': 'a11', 'runtime': 'python', 'entrypoint': 'main.py',
              'timeoutSeconds': 30},
        params={
            'flag': True,
            'count': 1,
            'ratio': 1.5,
            'nothing': None,
            'tags': ['a', 2],
            'nested': {'b': True, 'a': 1},
            'text': '中文',
            'old_str': 'hello',
        },
    )
    result = asyncio.run(execute_module.run_task(req))

    assert result['success'] is True
    env = captured['env']
    assert env['AUTOFLOW_FLAG'] == 'true'
    assert env['AUTOFLOW_COUNT'] == '1'
    assert env['AUTOFLOW_RATIO'] == '1.5'
    assert env['AUTOFLOW_NOTHING'] == 'null'
    assert env['AUTOFLOW_TAGS'] == '["a",2]'
    assert env['AUTOFLOW_NESTED'] == '{"b":true,"a":1}'
    assert env['AUTOFLOW_TEXT'] == '"中文"'
    assert env['AUTOFLOW_OLD_STR'] == '"hello"'


def test_serialize_param_value_matches_json_stringify():
    """A-11 单元锚点：_serialize_param_value 与 JSON.stringify 的可比形态
    （ensure_ascii=False + 紧凑分隔符），契约向量逐条断言。"""
    import json
    import pathlib

    repo_root = pathlib.Path(__file__).resolve().parents[3]
    contract = json.loads(
        (repo_root / 'packages' / 'contract-fixtures' / 'contract.json')
        .read_text(encoding='utf-8')
    )
    section = contract['executorEnvSerialization']
    for vector in section['vectors']:
        assert execute_module._serialize_param_value(vector['input']) == vector['env'], (
            f"vector {vector['input']!r} drifted from the pinned env bytes"
        )
