"""G3（审计轮 #15）：停机排水超时取消 → 已出队的回调批次被丢弃（不落盘）。

事实链：`stop_callback_retry_task()` 用
`wait_for(_flush_live_callbacks(), CALLBACK_DRAIN_TIMEOUT_SECONDS=10s)` 排水，而
单批重试预算是「3 次 × 10s + 退避」——admin 慢/不可达时**必然**超时被取消。
`_flush_live_callbacks` 先把批次从内存队列 `_drain_live_callback_queue()` 摘走，
再 await 发送：取消落在 await 上时，这批数据既没发出也没落盘，随协程销毁。
同一秒内多个执行结束（默认并发 10）时，一个批次的 N 条终态只剩"发起者自己"
那条（由 `_run_and_callback` 的 CancelledError 守卫单独持久化），其余全丢，
admin 侧留 RUNNING 到 stale sweep。

修法：在 CancelledError 里先 `_persist_failed_callback(batch, url)` 落盘再抛，
让既有的磁盘 replay 循环接手（与「durability is the file」的承诺一致）。
"""
import asyncio
import json

import pytest

from routers import execute as execute_module


@pytest.mark.asyncio
async def test_cancelled_drain_persists_whole_batch(monkeypatch, tmp_path):
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path), raising=False)
    # 清空内存队列，塞 3 条终态回调
    with execute_module._live_callback_lock:
        execute_module._live_callback_queue.clear()
    items = [
        {'executionId': f'e-{i}', 'status': 'failed', 'exitCode': 1} for i in range(3)
    ]
    with execute_module._live_callback_lock:
        execute_module._live_callback_queue.extend(items)

    started = asyncio.Event()

    async def slow_send(url, batch):  # 模拟 admin 慢：一直挂到被取消
        started.set()
        await asyncio.sleep(30)
        return True

    monkeypatch.setattr(
        execute_module, '_send_callback_batch_with_retry', slow_send, raising=True
    )

    task = asyncio.create_task(execute_module._flush_live_callbacks())
    await asyncio.wait_for(started.wait(), timeout=5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    files = list((tmp_path / 'callbacks').glob('callback-*.json'))
    assert files, '取消后必须把整批写到 callbacks/ 让 replay 接手（否则这批终态彻底丢失）'
    payload = json.loads(files[0].read_text())
    stored = payload.get('payloads', payload)
    assert len(stored) == 3, f'必须整批落盘（实际 {len(stored)} 条）'
    assert {p['executionId'] for p in stored} == {i['executionId'] for i in items}

    with execute_module._live_callback_lock:
        execute_module._live_callback_queue.clear()
