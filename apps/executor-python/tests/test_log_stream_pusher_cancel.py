"""G2（审计轮 #15）：`flush()` 取消正在发网络的定时 flush，尾部日志分片静默丢失。

事实链（读源码确认）：
1. `_flush_now()` 在 `_flush_lock` 内把 `self.chunks` **整体摘走**到局部变量
   `chunks_to_flush`，并清空 `self.chunks`；
2. 随后逐片 `await self._push_chunk(...)` —— 每片 timeout 5s，一轮最坏 片数×5s；
3. 任务结束时的 `flush()` 会 `timer.cancel()` 掉**正在跑这一步**的定时任务；
4. CancelledError 落在 `await self._push_chunk(...)`，剩余分片随协程销毁；
5. `flush()` 紧接着自己调 `_flush_now()`，看到 `self.chunks` 已空 → 直接返回。

于是「任务结束时刻恰好落在某次定时 flush 的发送窗口内」时（有持续输出时是常态），
尾部最多 10 片 / 1MB 日志直接消失，而且**没有任何丢行 marker**——
`_first_dropped_line` 只覆盖背压丢行，不覆盖这条路径。

修法：`_flush_now` 在 CancelledError 里把未发出的分片塞回 `self.chunks` 队首
（并恢复字节记账），交给调用方那次 `_flush_now()` 继续发。
"""
import asyncio

import pytest

from log_stream_pusher import LogStreamPusher


@pytest.mark.asyncio
async def test_flush_requeues_chunks_when_timer_is_cancelled_mid_push():
    pusher = LogStreamPusher("exec-g2")
    # 250 行 → 100/100/50 三片（max_lines_per_chunk=100）
    for i in range(250):
        await pusher.add_line(f"line-{i}")

    attempts: list[int] = []
    sent: list[int] = []
    release = asyncio.Event()

    async def push(chunk):
        attempts.append(len(chunk["lines"]))
        if len(attempts) == 1:
            # 第一片卡在"网络"上，模拟 flush() 取消时正处在发送窗口内
            await release.wait()
        sent.append(len(chunk["lines"]))

    pusher._push_chunk = push  # type: ignore[assignment]

    # 把 timer 换成"已进入发送阶段"的 _flush_now（等价于 1s 定时器刚刚触发）
    pusher.timer = asyncio.create_task(pusher._flush_now())
    for _ in range(50):
        await asyncio.sleep(0.01)
        if attempts:
            break
    assert attempts == [100], "前置条件：第一片必须已经在发送中"

    # 任务结束 → final_flush() → flush()：取消 timer，然后自己再 _flush_now 一次
    await asyncio.wait_for(pusher.flush(), timeout=5)

    assert sum(sent) == 250, (
        f"尾部日志被丢弃：只发出 {sum(sent)} 行（应为 250）；"
        f"attempts={attempts} sent={sent}"
    )
    assert pusher.chunks == [], "全部分片发出后缓冲应为空"


@pytest.mark.asyncio
async def test_flush_still_drains_normally_without_cancellation():
    """回归：没有并发 timer 时 flush 行为不变（一次发完、缓冲清空）。"""
    pusher = LogStreamPusher("exec-g2b")
    for i in range(120):
        await pusher.add_line(f"line-{i}")

    sent: list[int] = []

    async def push(chunk):
        sent.append(len(chunk["lines"]))

    pusher._push_chunk = push  # type: ignore[assignment]
    await pusher.flush()

    assert sum(sent) == 120
    assert pusher.chunks == []
