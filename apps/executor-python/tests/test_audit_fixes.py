"""本轮审计修复（A-1/A-3/A-5/A-7/A-9/A-11 python 侧）的回归守卫。

每条用例对应报告里的一个 A-x 编号；node 侧对齐断言见
apps/executor-node/src/audit-fixes.spec.ts 与契约向量
packages/contract-fixtures/contract.json 的 executorEnvSerializationV2 段
（A-11R 起为在用语义；V1 段是 A-11 旧语义的冻结档案）。
"""
import asyncio
import json
import os
import pathlib
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
    assert '任务执行超时（1s）' in result['errorMessage']
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
        assert '载荷校验失败' in reason
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
    assert '已按中台请求终止该执行' in result['errorMessage']
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
    assert '已按中台请求终止该执行' in result['errorMessage']
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
    # P2-7 后 _download_package 的**每一跳**都重跑真实 SSRF 复检
    # （_host_is_restricted 做真实 DNS 且 fail-closed）——本组用例测的是
    # 重定向/Bearer 语义而非 SSRF，故 admin 地址用公网 IP 字面量
    # （不依赖外网 DNS，复检必过）。
    monkeypatch.setattr(execute_module.settings, 'admin_api_url',
                        'http://93.184.216.34')
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
        'http://93.184.216.34/packages/first', dest,
    ))

    assert size == len(b'payload-bytes')
    assert dest.read_bytes() == b'payload-bytes'
    assert [u for u, _ in seen] == [
        'http://93.184.216.34/packages/first',
        'http://93.184.216.34/packages/second.zip',
    ]
    assert seen[0][1] == 'Bearer tok-a9'
    assert seen[1][1] == 'Bearer tok-a9', 'same-host redirect must keep the Bearer'


def test_download_package_strips_bearer_on_cross_host_redirect(tmp_path, monkeypatch):
    """A-9：跨 host 跳转剥离 Authorization——共享令牌绝不泄漏给非 admin 目标。"""
    _setup_download_auth(monkeypatch)
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers.get('authorization')))
        if request.url.host == '93.184.216.34':
            return httpx.Response(
                301, headers={'Location': 'http://93.184.216.35/payload.zip'})
        return httpx.Response(200, content=b'cdn-bytes')

    _patch_http_transport(monkeypatch, handler)
    dest = tmp_path / '.package.zip'

    size = asyncio.run(execute_module._download_package(
        'http://93.184.216.34/packages/p.zip', dest,
    ))

    assert size == len(b'cdn-bytes')
    assert seen[0] == ('http://93.184.216.34/packages/p.zip', 'Bearer tok-a9')
    assert seen[1][0] == 'http://93.184.216.35/payload.zip'
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

    with pytest.raises(RuntimeError, match='重定向次数过多'):
        asyncio.run(execute_module._download_package(
            'http://93.184.216.34/packages/loop', dest,
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

    with pytest.raises(RuntimeError, match='HTTP 状态码 404'):
        asyncio.run(execute_module._download_package(
            'http://93.184.216.34/packages/missing.zip', dest,
        ))
    assert not dest.exists()


# ---------------------------------------------------------------------------
# A-11R：params→env 逐键通道字符串**裸值** + 类型化通道（A-11 的生产回归修复）
# ---------------------------------------------------------------------------

def test_run_task_params_env_serialization(tmp_path, monkeypatch):
    """A-11R（P1 生产回归修复）：逐键通道里**字符串裸值**、非字符串走 JSON。

    A-11 曾把字符串也 JSON 化（`'"hello"'`），而中台 ParamsEditor 的契约是
    字符串键值对——于是所有经中台 UI 配置的参数都多了一对首尾双引号，按官方
    文档裸读的存量脚本（`int(os.environ["AUTOFLOW_LIMIT"])`）直接 ValueError。
    生产实证：tk-ship-notify 静默停摆 12 天。

    真缺口（布尔/空值/容器的两端字节漂移）仍然修着：那些走 js_json_dumps，
    与 node JSON.stringify 逐字节一致。

    契约向量：contract-fixtures/contract.json 的 executorEnvSerializationV2 段。
    """
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    captured = {}

    async def fake_spawn(*args, **kwargs):
        captured['env'] = dict(kwargs.get('env') or {})
        return _FakeTaskProc()

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_spawn)

    req = ExecuteRequest(
        executionId='exec-a11r',
        task={'name': 'a11r', 'runtime': 'python', 'entrypoint': 'main.py',
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
            'empty': '',
            'ratio_tiny': 1e-7,
        },
    )
    result = asyncio.run(execute_module.run_task(req))

    assert result['success'] is True
    env = captured['env']

    # ① 字符串裸值（A-11 的回归点：此前是 '"hello"' / '"中文"' / '""'）
    assert env['AUTOFLOW_TEXT'] == '中文'
    assert env['AUTOFLOW_OLD_STR'] == 'hello'
    # 空串必须还是空串——A-11 的 '""' 是**真值**，会让 `if os.environ.get(...)`
    # 这类判断全部走错分支（静默，不报错）。
    assert env['AUTOFLOW_EMPTY'] == ''

    # ② 非字符串仍为 JSON（A-11 的真修复，保留）
    assert env['AUTOFLOW_FLAG'] == 'true'
    assert env['AUTOFLOW_COUNT'] == '1'
    assert env['AUTOFLOW_RATIO'] == '1.5'
    assert env['AUTOFLOW_NOTHING'] == 'null'
    assert env['AUTOFLOW_TAGS'] == '["a",2]'
    assert env['AUTOFLOW_NESTED'] == '{"b":true,"a":1}'
    # A-11 自称"两端逐字节一致"并未做到：json.dumps 给 '1e-07'，node 给 '1e-7'。
    assert env['AUTOFLOW_RATIO_TINY'] == '1e-7'

    # ③ 类型化通道：整个 params 一份 JSON（逐键通道恒为字符串，原理上无法
    #    区分字符串 "true" 与布尔 true，故需要这条来做类型还原）。
    params_json = json.loads(env['AUTOFLOW_PARAMS_JSON'])
    assert params_json['flag'] is True
    assert params_json['empty'] == ''
    assert params_json['ratio'] == 1.5
    assert params_json['nested'] == {'b': True, 'a': 1}
    assert params_json['text'] == '中文'


def test_serialize_param_value_matches_contract_vectors():
    """A-11R 单元锚点：逐键序列化逐条命中冻结的契约向量。

    向量在 contract-fixtures 的 executorEnvSerializationV2 段（append-only）。
    V1 段是 A-11 旧语义的历史档案（字符串带引号），**刻意不再断言**——它正是
    本次要修掉的行为。
    """
    repo_root = pathlib.Path(__file__).resolve().parents[3]
    contract = json.loads(
        (repo_root / 'packages' / 'contract-fixtures' / 'contract.json')
        .read_text(encoding='utf-8')
    )
    section = contract['executorEnvSerializationV2']
    for vector in section['vectors']:
        assert execute_module._serialize_param_value(vector['input']) == vector['env'], (
            f"vector {vector['input']!r} drifted from the pinned env bytes"
        )
    for vector in section['paramsJsonVectors']:
        assert execute_module._serialize_params_json(vector['params']) == vector['env'], (
            f"paramsJson vector {vector['params']!r} drifted from the pinned bytes"
        )
    # 空/缺省 params 不注入类型化通道（缺席比空值更清楚，node 侧同判据）。
    assert execute_module._serialize_params_json({}) is None
    assert execute_module._serialize_params_json(None) is None


def test_params_json_cannot_be_overridden_by_user_param(tmp_path, monkeypatch):
    """A-11R：名为 `params_json` 的用户参数不得顶掉平台注入的 PARAMS_JSON。

    平台变量在参数循环**之后**写入（与 AUTOFLOW_CALLBACK_TOKEN 同一纪律）；
    该名字属平台命名空间。若顺序反过来，用户一个手滑的参数名就能让整条类型化
    通道失效——且失效是静默的（SDK 解析失败后回落逐键通道，类型还原丢失）。
    """
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    captured = {}

    async def fake_spawn(*args, **kwargs):
        captured['env'] = dict(kwargs.get('env') or {})
        return _FakeTaskProc()

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_spawn)

    req = ExecuteRequest(
        executionId='exec-a11r-shadow',
        task={'name': 'shadow', 'runtime': 'python', 'entrypoint': 'main.py',
              'timeoutSeconds': 30},
        params={'params_json': '{"hijacked":true}', 'real': 1},
    )
    result = asyncio.run(execute_module.run_task(req))
    assert result['success'] is True

    parsed = json.loads(captured['env']['AUTOFLOW_PARAMS_JSON'])
    assert parsed == {'params_json': '{"hijacked":true}', 'real': 1}
    assert 'hijacked' not in parsed


def test_executor_env_round_trips_through_the_python_sdk():
    """A-11R 端到端：执行器产出的 env → SDK `from_env()` → 类型正确还原。

    为什么必须有这条**跨模块**断言：执行器序列化与 SDK 解析是两处独立实现，
    各自的单测可以同时全绿而**线缆契约是错的**（这正是 A-11 的形态——两端
    测试都只断言那 10 条向量）。这里用真实的执行器序列化函数产出 env，喂给
    真实的 `autoflow_sdk.TaskContext.from_env()`，验证：
      · 字符串参数**原样**还原（不被引号污染、不被猜测性转成数字/布尔）；
      · 字符串 `"true"` 与布尔 `true` 可区分（类型化通道的意义所在）；
      · 空串仍是空串且为假值。

    若 SDK 未安装（执行器可以独立部署），本用例跳过——它验证的是两者**同在**
    时的契约，缺一方时跳过是诚实的，不能假装通过。
    """
    sdk_context = pytest.importorskip(
        'autoflow_sdk.context',
        reason='autoflow-sdk 未安装：跨模块契约无从验证（非失败）',
    )

    params = {
        'region': '欧盟',      # 字符串（含非 ASCII）
        'limit': '3',          # 用户在界面上填的字符串 "3"
        'flag': 'true',        # 用户在界面上填的字符串 "true"
        'dry_run': True,       # 真实布尔
        'count': 3,            # 真实整数
        'ratio': 1e-7,         # 需要 JS 浮点排版的数
        'tags': ['a', 2],
        'nested': {'b': True, 'a': 1},
        'mode': '',            # 空串——A-11 曾把它变成 '""'（真值）
        'date': '2024-06-01',
    }

    env = {f'AUTOFLOW_{k.upper()}': execute_module._serialize_param_value(v)
           for k, v in params.items()}
    params_json = execute_module._serialize_params_json(params)
    assert params_json is not None
    env['AUTOFLOW_PARAMS_JSON'] = params_json
    env['EXECUTION_ID'] = 'exec-e2e'
    env['TASK_ID'] = 'task-e2e'
    env['TASK_NAME'] = 'e2e'

    saved = dict(os.environ)
    try:
        os.environ.update(env)
        ctx = sdk_context.TaskContext.from_env()
    finally:
        for key in env:
            os.environ.pop(key, None)
        os.environ.update(saved)

    p = ctx.params
    # 字符串原样（这是 A-11 的回归点：此前会带引号）
    assert p['region'] == '欧盟'
    assert p['date'] == '2024-06-01'
    # 用户填的字符串 "3" / "true" 必须**仍是字符串**——不能猜测性转换
    assert p['limit'] == '3' and isinstance(p['limit'], str)
    assert p['flag'] == 'true' and isinstance(p['flag'], str)
    # 真实类型还原
    assert p['dry_run'] is True
    assert p['count'] == 3 and not isinstance(p['count'], bool)
    assert p['ratio'] == 1e-7
    assert p['tags'] == ['a', 2]
    assert p['nested'] == {'b': True, 'a': 1}
    # 空串是空串且为假值（A-11 的 '""' 是真值，会让 if 判断走错分支）
    assert p['mode'] == '' and not p['mode']
    # 平台管道不得被当成用户参数暴露
    assert 'params_json' not in p
