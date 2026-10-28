"""执行器双端一致性修复包（executor-parity fixes）的回归测试。

覆盖四项 python 侧修复，全部先复核 node 侧语义后对齐：

P1  超长 stdout 单行收尸 —— create_subprocess_exec 补 limit（对齐 node
    BoundedLogBuffer 的内存保留上限），超限 ValueError 落入 except Exception
    时必须先树杀子进程再回报失败载荷（旧行为：进程带活槽位继续跑）。
P2  停机排水守卫 —— accept_execution 首行检查 is_shutting_down，关机中
    503 拒绝（对齐 node acceptExecution 的 isExecutorShuttingDown 检查，
    routes/execute.ts NETOPT-9-1）。
P3  _run_uv 超时树杀 —— proc.kill()（只杀直接子进程）升级为
    _kill_process_tree（对齐 node run-command.ts 走 killProcessTree），
    孙进程必须随 uv 一起死。
P4  LogStreamPusher 背压可观测性 —— 丢行从 debug 升级为每执行限 1 条的
    warn、成功清空缓冲后复位（对齐 node log-stream-pusher.ts A8）。

P1/P3 用**真实子进程 + 心跳文件**断言进程死亡（选更接近真实行为的方案）：
心跳在子进程被树杀后必然停写，回归（不杀）时心跳持续增长——反证可观测，
不依赖平台相关的 pid 探活 API（Windows 的 os.kill(pid, 0) 语义是"杀"而非
"探活"，不能跨平台使用）。
"""
import asyncio
import logging
import sys
import time

import pytest

from routers import execute as execute_module
from routers.execute import ExecutionRejected


def _hb_script_code(hb_path: str) -> str:
    """生成"心跳"子进程代码：向 hb_path 追加行，每 0.1s 一条，持续 30s。

    路径统一正斜杠——Windows 的 Python API 全都接受，规避原始字符串里
    反斜杠转义的坑。"""
    hb = hb_path.replace('\\', '/')
    return (
        'import time\n'
        f"hb = open(r'{hb}', 'a', buffering=1)\n"
        'i = 0\n'
        'end = time.time() + 30\n'
        'while time.time() < end:\n'
        "    hb.write(f'{i}\\n')\n"
        '    i += 1\n'
        '    time.sleep(0.1)\n'
    )


def _assert_heartbeats_stopped(hb_path, settle: float = 0.5, window: float = 1.5):
    """心跳文件在 settle 后必须不再增长（写入者已死）。"""
    time.sleep(settle)
    size1 = hb_path.stat().st_size
    time.sleep(window)
    size2 = hb_path.stat().st_size
    assert size2 == size1, (
        f'heartbeat file kept growing ({size1} -> {size2}): the process tree '
        'survived — corpse sweep did not run'
    )


# ---------------------------------------------------------------------------
# P1: over-long stdout line → failure payload AND tree-killed child
# ---------------------------------------------------------------------------

def test_overlong_stdout_line_fails_task_and_kills_child(tmp_path, monkeypatch):
    """P1: 单行超过 StreamReader limit → 失败载荷 + 子进程被收尸。

    反证：修前该场景 run_task 返回失败载荷但子进程（心跳 30s）继续存活——
    心跳文件持续增长；修后 except Exception 分支先树杀再回报，心跳停写。"""
    from routers.execute import ExecuteRequest, run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))

    hb = tmp_path / 'exec-longline' / 'hb.txt'
    hb.parent.mkdir(parents=True)
    script = hb.parent / 'longline.py'
    script.write_text(
        # 先落一行"已到心跳阶段"的锚，再打出 2 倍上限的超长行（> 1MB limit），
        # 然后进入心跳循环——被杀后心跳必然停止。
        'import sys\n'
        f"hb = open(r'{str(hb).replace(chr(92), '/')}', 'a', buffering=1)\n"
        "hb.write('ready\\n')\n"
        f"sys.stdout.write('x' * (2 * {execute_module.MAX_STREAM_LINE_BYTES}) + '\\n')\n"
        'sys.stdout.flush()\n'
        + _hb_script_code(str(hb))
    )

    # spawn 参数探针：断言任务子进程确实带上了对齐 node 的 limit。
    real_spawn = asyncio.create_subprocess_exec
    spawn_kwargs = []

    def spawn_spy(*args, **kwargs):
        spawn_kwargs.append(kwargs)
        return real_spawn(*args, **kwargs)

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn_spy)

    req = ExecuteRequest(
        executionId='exec-longline',
        task={'runtime': 'python', 'entrypoint': 'longline.py', 'timeoutSeconds': 20},
    )
    result = asyncio.run(run_task(req))

    assert result['success'] is False
    assert result['exitCode'] is None
    assert result['errorMessage'], 'failure payload must carry an error message'
    # a) spawn 时显式传了 limit（asyncio 缺省 64KB → 超长行抛 ValueError）
    assert execute_module.MAX_STREAM_LINE_BYTES == 1_000_000, (
        'cap must stay aligned with node BoundedLogBuffer '
        '(LOG_HEAD_LIMIT + LOG_TAIL_LIMIT = 1_000_000)'
    )
    limited = [kw for kw in spawn_kwargs if 'limit' in kw]
    assert len(limited) == 1, 'exactly one spawn (the task child) carries limit'
    assert limited[0]['limit'] == execute_module.MAX_STREAM_LINE_BYTES
    # b) 进程被收尸：心跳停写
    assert hb.exists(), 'child must have reached its heartbeat phase'
    _assert_heartbeats_stopped(hb)


# ---------------------------------------------------------------------------
# P2: shutdown-drain guard on accept_execution
# ---------------------------------------------------------------------------

def test_accept_execution_rejects_503_while_shutting_down(monkeypatch):
    """P2: 关机中 accept_execution 必须以 503 'Executor is shutting down'
    拒绝，且先于一切容量账本/登记副作用（node NETOPT-9-1 同位同文）。"""
    import main as main_module

    monkeypatch.setattr(main_module, '_shutting_down', True)
    ledger_touches = []
    monkeypatch.setattr(
        execute_module.sched, 'increment_running',
        lambda: ledger_touches.append(1),
    )
    monkeypatch.setattr(execute_module.sched, 'get_running_count', lambda: 0)

    req = execute_module.ExecuteRequest(executionId='exec-shutdown-1', task={})
    with pytest.raises(ExecutionRejected) as excinfo:
        execute_module.accept_execution(req)

    assert excinfo.value.status_code == 503
    assert excinfo.value.detail == '执行器正在停机'
    assert ledger_touches == [], 'capacity ledger must be untouched by the guard'
    assert not execute_module.execution_exists('exec-shutdown-1')


def test_execute_route_maps_shutdown_rejection_to_503(auth_client, monkeypatch):
    """P2: HTTP 路由把停机拒绝映射为 503（与 node 的
    `{status: 503, payload: {error: 'Executor is shutting down'}}` 同语义）。"""
    import main as main_module

    monkeypatch.setattr(main_module, '_shutting_down', True)
    response = auth_client.post('/api/execute', json={
        'executionId': 'exec-shutdown-2',
        'task': {'name': 'noop', 'runtime': 'python'},
    })
    assert response.status_code == 503
    assert response.json()['detail'] == '执行器正在停机'


# ---------------------------------------------------------------------------
# P3: _run_uv timeout tree-kills (grandchildren die with uv)
# ---------------------------------------------------------------------------

def test_run_uv_timeout_tree_kills_grandchildren(tmp_path):
    """P3: _run_uv 超时后整树必须死——uv 再 spawn 的孙进程（心跳 30s）
    修前随 proc.kill() 幸存（心跳持续增长），修后随树被杀（心跳停写）。"""
    from routers.execute import _run_uv

    hb = tmp_path / 'gc-hb.txt'
    parent = tmp_path / 'uv_parent.py'
    parent.write_text(
        'import subprocess, sys, time\n'
        f"gc = subprocess.Popen([sys.executable, '-c', {str(_hb_script_code(str(hb)))!r}])\n"
        "open(r'" + str(hb).replace('\\', '/') + "', 'a', buffering=1).write('parent-ready\\n')\n"
        'time.sleep(30)\n'
    )

    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(_run_uv([sys.executable, str(parent)], timeout_seconds=1))

    assert hb.exists(), 'grandchild must have been spawned before the timeout'
    _assert_heartbeats_stopped(hb)


# ---------------------------------------------------------------------------
# P4: LogStreamPusher backpressure — warn once per episode, reset on clean flush
# ---------------------------------------------------------------------------

class _FakeResponse:
    def __init__(self, status_code=200, text='ok'):
        self.status_code = status_code
        self.text = text


class _Recorder:
    """拦截出站请求（与 test_log_stream_pusher.py 的同名假件同形）——
    fixture 跨测试模块不可见，这里本地复刻一份。"""

    def __init__(self, status_code=200):
        self.calls = []
        self.status_code = status_code
        self.failing = False

    async def __call__(self, client, method, url, *, token=None, headers=None, **kwargs):
        await asyncio.sleep(0)
        if self.failing:
            raise RuntimeError('admin down')
        self.calls.append({'url': url, 'token': token, 'json': kwargs.get('json')})
        return _FakeResponse(self.status_code)


@pytest.fixture
def pusher_env(monkeypatch):
    """把 pusher 的两个外部依赖（令牌 / 出站 HTTP）替换为可观测的假件。"""
    import log_stream_pusher as lsp
    import scheduler

    recorder = _Recorder()

    async def fake_get_current_token():
        return 'REAL-TOKEN'

    monkeypatch.setattr(lsp, 'get_current_token', fake_get_current_token)
    monkeypatch.setattr(lsp, 'request_with_self_heal', recorder)
    monkeypatch.setattr(
        lsp, 'build_admin_api_url', lambda path: f'http://admin.test/api{path}'
    )
    monkeypatch.setattr(scheduler, 'get_http_client', lambda: object())
    return recorder


def test_backpressure_warns_once_per_episode_and_resets_after_clean_flush(
        pusher_env, caplog):
    """P4: 背压丢行 → 每执行限 1 条 warn（连续丢行只告警一次）；缓冲清空且
    全部推送成功 → 复位，下一次独立背压事件再告警；推送失败的 flush 不得
    复位（对齐 node log-stream-pusher.ts 的 backpressureWarned 语义）。"""
    from log_stream_pusher import LogStreamPusher

    caplog.set_level(logging.DEBUG, logger='log_stream_pusher')

    async def scenario():
        pusher = LogStreamPusher('exec-bp')

        def warnings():
            return [
                r for r in caplog.records
                if r.levelno == logging.WARNING and 'Backpressure' in r.getMessage()
            ]

        # 背压阈值：10 chunks × 100 行 = 1000 行后的新行触发丢行。
        # 1100 行内发生两次丢行（1001、1101 处）——warn 只允许 1 条。
        for i in range(1100):
            await pusher.add_line(f'line-{i}')
        assert len(warnings()) == 1, 'consecutive drops must warn exactly once'
        assert 'Backpressure' in warnings()[0].getMessage()
        assert 'exec-bp' in warnings()[0].getMessage()

        # 干净 flush（recorder 200）→ 复位 → 新一轮背压再产出一条 warn。
        await pusher.flush()
        for i in range(1100):
            await pusher.add_line(f'again-{i}')
        assert len(warnings()) == 2, 'clean flush must re-arm the warn gate'

        # 推送失败的 flush 不得复位：recorder 抛错 → flush 后再丢行不再告警。
        pusher_env.failing = True
        await pusher.flush()
        for i in range(1100):
            await pusher.add_line(f'failing-{i}')
        assert len(warnings()) == 2, 'failed flush must NOT reset the warn gate'

        # 恢复推送成功 → 复位 → 再背压再告警（证明门闩是状态而非终身静默）。
        pusher_env.failing = False
        await pusher.flush()
        for i in range(1100):
            await pusher.add_line(f'recovered-{i}')
        assert len(warnings()) == 3

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# G1（审计轮 #15）：排水闸在**生产启动路径**上从未被置位
#
# 事实链：`_shutting_down = True` 原本只出现在 `if __name__ == '__main__'` 里的
# signal 处理器中，而生产镜像用 `uvicorn main:app` 启动（Dockerfile:58）——
# 那段代码根本不执行；即便 `python main.py`，uvicorn 的 capture_signals() 也会
# 覆盖 SIGTERM 处理器。于是 routers/execute.py 的 503 排水闸恒为假：停机窗口内
# 被领走的任务会被 30s 宽限 + 树杀推成 failed/executor_restart，而中台已收到
# 200、不会再改派。
#
# 既有 4 条用例都是直接 monkeypatch `_shutting_down = True`（测闸门本身），
# 因此从不经过"谁来置位"这条路——本组用例补的正是这个缺口。
# ---------------------------------------------------------------------------
def test_signal_drain_gate_flips_flag_and_chains_uvicorn(monkeypatch):
    """信号到来 → 先置位排水闸，再把控制权交回 uvicorn 原处理器（不吞停机）。"""
    import signal as signal_module

    import main as main_module

    installed: dict = {}
    previous_calls: list[int] = []

    def previous_handler(signum, frame):  # 模拟 uvicorn 的 handle_exit
        previous_calls.append(signum)

    monkeypatch.setattr(main_module, '_shutting_down', False)
    monkeypatch.setattr(
        main_module.signal, 'getsignal', lambda sig: previous_handler, raising=True
    )
    monkeypatch.setattr(
        main_module.signal,
        'signal',
        lambda sig, handler: installed.__setitem__(sig, handler),
        raising=True,
    )

    main_module.install_signal_drain_gate()

    assert signal_module.SIGTERM in installed and signal_module.SIGINT in installed
    installed[signal_module.SIGTERM](signal_module.SIGTERM, None)

    assert main_module.is_shutting_down() is True
    assert previous_calls == [signal_module.SIGTERM], '必须调用 uvicorn 原处理器'


def test_signal_drain_gate_is_installed_from_lifespan(monkeypatch):
    """闸门必须在 lifespan 启动时注册（`__main__` 段在生产不会执行）。"""
    import inspect

    import main as main_module

    src = inspect.getsource(main_module.lifespan)
    assert 'install_signal_drain_gate()' in src, (
        'lifespan 必须调用 install_signal_drain_gate —— 否则 uvicorn main:app 启动下'
        '排水闸仍恒为假（G1 原缺陷）'
    )


def test_signal_drain_gate_is_idempotent(monkeypatch):
    """重复注册不得把自己再套一层（否则一次信号递归调用自己）。"""
    import main as main_module

    handlers: dict = {}

    def self_handler(signum, frame):  # 名字模拟已安装的链
        pass

    self_handler.__name__ = '_handler'

    monkeypatch.setattr(main_module.signal, 'getsignal', lambda sig: self_handler)
    monkeypatch.setattr(
        main_module.signal, 'signal', lambda sig, handler: handlers.__setitem__(sig, handler)
    )

    main_module.install_signal_drain_gate()
    assert handlers == {}, '已安装过的信号不应再次被包装'
