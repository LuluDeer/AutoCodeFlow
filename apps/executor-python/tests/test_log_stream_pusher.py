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
    # R125：首发是**一行 marker**（占用第一条被丢行的行号 0），其后才是真实切片。
    assert bodies[0]['fromLine'] == 0
    assert 'dropped by local backpressure' in bodies[0]['lines'][0]
    real = [b for b in bodies if 'dropped by local backpressure' not in b['lines'][0]]
    assert real[0]['fromLine'] == 100
    assert sum(len(b['lines']) for b in real) == 901


# ---------------------------------------------------------------------------
# R123：**字节**级背压（R94-A1 遗留：只有条数上限、无字节上限）
#
# 改前的算式：条数上限 10 片 × 100 行 = 1000 行；单行上限 1 MB（execute.py:753）
# ⇒ 内存上界 ≈ **1 GB/执行**，单次 POST body 上界 ≈ **100 MB**。
# 条数上限**不构成字节安全边界**，这两个用例钉住新加的两道字节闸。
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_buffer_bytes_are_bounded_by_byte_budget() -> None:
    """200 行 × 64 KB = 12.8 MB 全塞进缓冲 → 必须被字节预算截住（改前 12.8 MB 全驻留）。"""
    pusher = LogStreamPusher('exec-bytes')
    line = 'x' * (64 * 1024)
    for _ in range(200):
        await pusher.add_line(line)

    assert pusher._buffered_bytes <= lsp.MAX_BUFFERED_BYTES, (
        f'缓冲字节 {pusher._buffered_bytes} 超过预算 {lsp.MAX_BUFFERED_BYTES}',
    )
    # 预算生效的直接后果：切片被丢，行数不再等于全部输入
    buffered_lines = sum(len(c['lines']) for c in pusher.chunks)
    assert buffered_lines < 200, '字节预算未生效：200 行全部驻留'
    # 且**保留的是尾部**（失败原因几乎总在最后几行）
    last = pusher.chunks[-1]['lines'][-1]
    assert last == line


@pytest.mark.asyncio
async def test_single_chunk_is_bounded_by_bytes_not_just_line_count() -> None:
    """每行 300 KB × 5 行（条数远未到 100）→ 仍须按字节切成多片。"""
    pusher = LogStreamPusher('exec-chunk')
    line = 'y' * (300 * 1024)
    for _ in range(5):
        await pusher.add_line(line)

    assert len(pusher.chunks) > 1, '只在条数上切片：5×300KB 全挤进同一片（150 KB→1.5 MB 超 MAX_BYTES_PER_CHUNK）'
    for chunk in pusher.chunks:
        assert chunk['bytes'] <= lsp.MAX_BYTES_PER_CHUNK, (
            f'单片字节 {chunk["bytes"]} 超过 {lsp.MAX_BYTES_PER_CHUNK}',
        )


def test_byte_accounting_resets_on_flush(pusher_env) -> None:
    """flush 把切片取走后，字节记账必须归零（否则失败重试会重复计入、提前触发丢弃）。"""
    pusher = LogStreamPusher('exec-reset')

    _run(pusher.add_line('a' * 1024))
    assert pusher._buffered_bytes == 1024
    _run(pusher.flush())
    assert pusher._buffered_bytes == 0, 'flush 后字节记账未归零'


def test_utf8_len_counts_bytes_not_chars() -> None:
    """中文 1 字符 = 3 字节 —— 记账必须是**字节**，否则 3 倍低估（同 R115 的教训）。"""
    assert lsp._utf8_len('abc') == 3
    assert lsp._utf8_len('中') == 3
    assert lsp._utf8_len('中文') == 6


# ---------------------------------------------------------------------------
# R124：**片内行号必须连续**（admin 按 `fromLine + i` 落库）
#
# 来自 R116 分析里的一条洞察：admin 的 `appendLogChunk` 用 `fromLine + i` 决定每行落哪个
# 行号。所以**一个片里的 lines 必须是连续行号**——只要片内出现缺口，后面所有行都会被写到
# 错位的位置上，而且**没有任何报错**（admin 只会照它算出来的行号写）。
#
# 当前实现天然满足（片是 append-only 的连续块），但这条不变式**没有被任何用例钉住**：
# 将来若把缓冲改成「扁平 (lineNo, text) 列表 + 按需切片」，丢行就会在扁平列表里留下缺口，
# 朴素切片会立刻产出带缺口的片 —— 这类重写很容易做，而后果是静默的数据错位。
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chunks_are_contiguous_so_admin_line_numbers_stay_correct() -> None:
    """丢行发生之后，**存活片的 fromLine 仍与内容严格连续**。"""
    pusher = LogStreamPusher('exec-contig')
    pusher._schedule_flush = lambda: None

    # 1100 行 ⇒ 跨过 1000 行上限 ⇒ 头部的片会被丢弃
    for i in range(1100):
        await pusher.add_line(f'line-{i}')

    assert len(pusher.chunks) == pusher.max_chunks_in_memory
    for prev, nxt in zip(pusher.chunks, pusher.chunks[1:]):
        assert nxt['fromLine'] == prev['fromLine'] + len(prev['lines']), (
            f'片间缺口：{prev["fromLine"]}+{len(prev["lines"])} != {nxt["fromLine"]}',
        )

    # 更强的一条：每片的 (fromLine + i) 必须等于该行**真实的行号**（内容里编码了行号）
    for chunk in pusher.chunks:
        for offset, text in enumerate(chunk['lines']):
            assert text == f'line-{chunk["fromLine"] + offset}', (
                f'行号错位：片 fromLine={chunk["fromLine"]} offset={offset} 期望 line-{chunk["fromLine"] + offset}，实际 {text}',
            )


@pytest.mark.asyncio
async def test_pushed_payload_preserves_true_line_numbers_after_drops(pusher_env) -> None:
    """从**出站请求体**验证：丢行之后推给 admin 的 (fromLine, lines) 仍然自洽。"""
    pusher = LogStreamPusher('exec-wire')

    for i in range(1100):
        await pusher.add_line(f'line-{i}')
    await pusher.flush()

    assert pusher_env.calls, '没有发出任何请求'
    for call in pusher_env.calls:
        body = call['json']
        from_line = body['fromLine']
        # R125：marker 行不是真实日志行，跳过（它有自己的断言，见下一条用例）
        if 'dropped by local backpressure' in body['lines'][0]:
            continue
        for offset, text in enumerate(body['lines']):
            # admin 会把它写到 fromLine + offset —— 必须与内容里的真实行号一致
            assert text == f'line-{from_line + offset}', (
                f'出站体行号错位：fromLine={from_line} offset={offset} 期望 line-{from_line + offset}，实际 {text}',
            )


@pytest.mark.asyncio
async def test_drops_emit_a_visible_marker_line_at_the_gap(pusher_env) -> None:
    """丢行必须在流里**留下一行可见说明**，且落在缺口所在的行号上。"""
    pusher = LogStreamPusher('exec-marker')

    for i in range(1001):  # 第 11 片挤掉第 1 片（行 0..99）
        await pusher.add_line(f'l{i}')
    await pusher.flush()

    bodies = [c['json'] for c in pusher_env.calls]
    markers = [b for b in bodies if 'dropped by local backpressure' in b['lines'][0]]
    assert len(markers) == 1, '丢行没有产生 marker 行 —— 实时视图里会是一个静默缺口'
    m = markers[0]
    # 一行成片；行号 = 第一条被丢行（0），这样它正好落在缺口位置
    assert len(m['lines']) == 1
    assert m['fromLine'] == 0
    assert '100 log lines dropped' in m['lines'][0], m['lines'][0]

    # marker 之后的真实切片行号**不受影响**（每片自带 fromLine）
    real = [b for b in bodies if b is not m]
    assert real[0]['fromLine'] == 100
    for body in real:
        for off, text in enumerate(body['lines']):
            assert text == f'l{body["fromLine"] + off}'


@pytest.mark.asyncio
async def test_marker_is_emitted_once_per_flush_episode(pusher_env) -> None:
    """同一轮里的多次丢行合并成**一条** marker（不是每次丢都加一行）。"""
    pusher = LogStreamPusher('exec-marker2')

    for i in range(1300):  # 丢 300 行，跨 3 个片
        await pusher.add_line(f'l{i}')
    await pusher.flush()

    bodies = [c['json'] for c in pusher_env.calls]
    markers = [b for b in bodies if 'dropped by local backpressure' in b['lines'][0]]
    assert len(markers) == 1
    assert '300 log lines dropped' in markers[0]['lines'][0], markers[0]['lines'][0]

