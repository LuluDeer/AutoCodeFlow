"""RT-LOG 反证：python 侧 LogStreamPusher 的出站凭据、行切分与 flush 竞态。

三条缺陷都是真实运行中复现过的（修复前用例转红）：

① 令牌未 await：``auth.get_current_token`` 是 ``async def``，首版
   ``_push_chunk`` 写的是 ``token = get_current_token()``——拿到的是 coroutine
   对象，``if not token`` 判空恒为假，于是 Authorization 头被拼成
   ``Bearer <coroutine object ...>``，admin-api 每个分片都 401，且 Python 只在
   事件循环回收时发一条 RuntimeWarning（生产日志里极易被淹没）。执行中完全
   看不到日志，静默失败。

② flush 自我取消：``flush()`` 开头 ``self.timer.cancel()``，而它**正是 timer
   任务自己调用的目标**（``delayed_flush`` → ``flush``）——cancel 掉当前任务
   后，下一个 await 抛 ``CancelledError``；它是 ``BaseException``，不被
   ``except Exception`` 捕获，于是 ``chunks`` 已经 ``clear()`` 却一条都没发出去
   = 静默丢日志（1s 定时器路径必然命中，即"执行中日志永远不出现"）。

③ 跨 chunk 半行被劈成两行 + 空行被过滤：``proc.stdout`` 按任意字节边界分片，
   首版对每个分片各 split 一次且 ``if sub_line`` 丢空行，行号与回调日志错位。
"""
import asyncio

import pytest

import log_stream_pusher as lsp
from log_stream_pusher import LogStreamPusher


class _FakeResponse:
    def __init__(self, status_code=200, text='ok'):
        self.status_code = status_code
        self.text = text


class _Recorder:
    """拦截出站请求，记录 (url, token, json)。"""

    def __init__(self, status_code=200):
        self.calls = []
        self.status_code = status_code

    async def __call__(self, client, method, url, *, token=None, headers=None, **kwargs):
        # 真实 HTTP 一定会挂起（socket I/O）；这里用 sleep(0) 造出同一个挂起点。
        # 这不是装饰：缺陷②（flush 自我取消）**只在有挂起点时才现形**——
        # CancelledError 是在下一个 await 处才抛出的，若假件一路不挂起，
        # 自我取消就"看起来没事"，反证用例会变成永真断言。
        await asyncio.sleep(0)
        self.calls.append({'url': url, 'token': token, 'json': kwargs.get('json')})
        return _FakeResponse(self.status_code)


@pytest.fixture
def pusher_env(monkeypatch):
    """把 pusher 的两个外部依赖（令牌 / 出站 HTTP）替换为可观测的假件。"""
    recorder = _Recorder()

    async def fake_get_current_token():
        return 'REAL-TOKEN'

    monkeypatch.setattr(lsp, 'get_current_token', fake_get_current_token)
    monkeypatch.setattr(lsp, 'request_with_self_heal', recorder)
    monkeypatch.setattr(
        lsp, 'build_admin_api_url', lambda path: f'http://admin.test/api{path}'
    )
    # get_http_client 在函数体内延迟导入（避免模块级环），故替换 scheduler 属性。
    import scheduler

    monkeypatch.setattr(scheduler, 'get_http_client', lambda: object())
    return recorder


def _run(coro):
    return asyncio.run(coro)


def test_token_is_awaited_not_a_coroutine(pusher_env):
    """① Authorization 必须是真实令牌，绝不能是 coroutine 对象。"""
    pusher = LogStreamPusher('exec-1')
    _run(pusher.add_line('hello'))
    _run(pusher.final_flush())

    assert len(pusher_env.calls) == 1
    call = pusher_env.calls[0]
    assert call['token'] == 'REAL-TOKEN'
    assert 'coroutine' not in str(call['token'])
    assert call['url'] == 'http://admin.test/api/executions/exec-1/logs'
    assert call['json'] == {'fromLine': 0, 'lines': ['hello']}


def test_timer_flush_actually_sends(pusher_env):
    """② 1s 定时器触发的 flush 必须真的把分片发出去（不得自我取消丢日志）。"""

    async def scenario():
        pusher = LogStreamPusher('exec-2')
        await pusher.add_line('auto-flushed')
        # 等定时器（flush_interval=1.0s）到点并完成。
        await asyncio.sleep(1.4)
        return pusher

    pusher = _run(scenario())

    assert len(pusher_env.calls) == 1, '定时器路径必须发出分片'
    assert pusher_env.calls[0]['json'] == {
        'fromLine': 0,
        'lines': ['auto-flushed'],
    }
    # 已发过的行不得在 final_flush 时重发。
    _run(pusher.final_flush())
    assert len(pusher_env.calls) == 1
    assert pusher.chunks == []


def test_timer_and_final_flush_do_not_double_send(pusher_env):
    """② final_flush 与定时器并发时，同一行不得发两次。"""

    async def scenario():
        pusher = LogStreamPusher('exec-3')
        await pusher.add_line('once')
        # 定时器与 final_flush 同时进场（此前两个 flush 会各自 splice 同一份
        # chunks，或前者被后者取消而整批丢失）。
        await asyncio.gather(pusher.final_flush(), pusher.final_flush())
        return pusher

    _run(scenario())

    sent_lines = [ln for c in pusher_env.calls for ln in c['json']['lines']]
    assert sent_lines == ['once']


def test_partial_line_across_chunks_is_one_line(pusher_env):
    """③ 一行被劈到两个分片里仍算一行。"""
    pusher = LogStreamPusher('exec-4')
    _run(pusher.add_output('partial-'))
    _run(pusher.add_output('line\n'))
    _run(pusher.final_flush())

    assert pusher_env.calls[0]['json'] == {
        'fromLine': 0,
        'lines': ['partial-line'],
    }
    assert pusher.get_current_line() == 1


def test_empty_lines_are_preserved(pusher_env):
    """③ 空行是真实日志行，不得被过滤（否则行号与回调日志错位）。"""
    pusher = LogStreamPusher('exec-5')
    _run(pusher.add_output('a\n\nb\n'))
    _run(pusher.final_flush())

    assert pusher_env.calls[0]['json'] == {'fromLine': 0, 'lines': ['a', '', 'b']}


def test_crlf_and_missing_trailing_newline(pusher_env):
    """③ \\r\\n 的 \\r 不得留在行尾；末行无换行符时由 final_flush 补发。"""
    pusher = LogStreamPusher('exec-6')
    _run(pusher.add_output('win\r\nline\r\n'))
    _run(pusher.add_output('tail-no-newline'))
    _run(pusher.final_flush())

    assert pusher_env.calls[0]['json'] == {
        'fromLine': 0,
        'lines': ['win', 'line', 'tail-no-newline'],
    }


def test_push_failure_does_not_raise(pusher_env):
    """推送失败只记 debug，绝不打断任务执行。"""

    async def failing(*args, **kwargs):
        raise RuntimeError('admin down')

    import log_stream_pusher

    original = log_stream_pusher.request_with_self_heal
    log_stream_pusher.request_with_self_heal = failing
    try:
        pusher = LogStreamPusher('exec-7')
        _run(pusher.add_line('x'))
        _run(pusher.final_flush())  # 不得抛出
    finally:
        log_stream_pusher.request_with_self_heal = original


def test_no_token_skips_without_raising(monkeypatch, pusher_env):
    """拿不到令牌时跳过发送（不抛），且不得发出空凭据请求。"""

    async def no_token():
        return None

    monkeypatch.setattr(lsp, 'get_current_token', no_token)
    pusher = LogStreamPusher('exec-8')
    _run(pusher.add_line('x'))
    _run(pusher.final_flush())

    assert pusher_env.calls == []


def test_backpressure_drops_oldest(pusher_env):
    """背压：超过 max_chunks_in_memory 时丢最旧分片（内存有界）。"""
    pusher = LogStreamPusher('exec-9')

    async def scenario():
        for i in range(1001):  # 1000 行 = 10 片；第 11 片挤掉第 1 片
            await pusher.add_line(f'l{i}')
        await pusher.final_flush()

    _run(scenario())

    bodies = [c['json'] for c in pusher_env.calls]
    assert bodies[0]['fromLine'] == 100
    assert sum(len(b['lines']) for b in bodies) == 901
