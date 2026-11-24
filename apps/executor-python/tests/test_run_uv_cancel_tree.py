"""_run_uv 非正常终止收尾：取消与超时必须同构地树杀 + reap。

缺口复盘：外层 wait_for(shield(gather(drain, wait))) 被 kill 后台 task 取消时，
旧代码只 cancel 了 wait_task、没 cancel drain_task，也没调 _kill_process_tree
—— shield 让内部 gather 存活，uv 及其下载/解包孙进程成孤儿继续写共享 venv。
本文件用内存替身把这条分支钉死，并以 TimeoutError 作正例控制组证明两分支同构。

验收级别：单测 / 内存替身（fake proc + 记录的树杀），不启真进程。
"""
import asyncio

import pytest

from routers import execute as execute_module


@pytest.mark.parametrize('raised,label', [
    (asyncio.CancelledError, 'cancel'),
    (asyncio.TimeoutError, 'timeout'),
], ids=['cancel', 'timeout-control'])
def test_run_uv_abnormal_exit_tree_kills_and_reaps(monkeypatch, raised, label):
    killed = []
    loop_errors = []
    captured = {}

    class FakeStdout:
        async def readline(self):
            # 永不自然结束：只有显式 cancel 才能终止 drain task。
            await asyncio.Event().wait()

        async def read(self, n=-1):
            return b''

    class FakeProc:
        pid = 4242
        returncode = 0

        def __init__(self):
            self.stdout = FakeStdout()
            self.wait_calls = 0

        async def wait(self):
            self.wait_calls += 1
            return self.returncode

    proc = FakeProc()

    async def fake_exec(*args, **kwargs):
        return proc

    async def fake_kill_tree(target):
        killed.append(target)

    async def fake_wait_for(aw, timeout=None):
        # 模拟停机 worker-flush：外层 wait_for 抛 CancelledError / TimeoutError，
        # 而 shield 内部 gather 仍存活（旧代码就在这里漏了 drain 与树杀）。
        await asyncio.sleep(0)  # 让 drain/wait 两个 task 真正启动
        # 真 wait_for 会 await 这个 shield future 并取回其结果；替身不 await，
        # 挂回调回收结果，免得测试自己制造 "Future exception was never retrieved"。
        def _retrieve(fut):
            try:
                fut.exception()
            except asyncio.CancelledError:
                pass

        if hasattr(aw, 'add_done_callback'):
            aw.add_done_callback(_retrieve)
        raise raised()

    real_ensure_future = asyncio.ensure_future

    def spy_ensure_future(coro_or_future, **kwargs):
        is_drain = '_drain' in getattr(coro_or_future, '__qualname__', '')
        task = real_ensure_future(coro_or_future, **kwargs)
        if is_drain:
            captured['drain_task'] = task
        return task

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)
    monkeypatch.setattr(execute_module, '_kill_process_tree', fake_kill_tree)
    monkeypatch.setattr(execute_module.asyncio, 'wait_for', fake_wait_for)
    monkeypatch.setattr(execute_module.asyncio, 'ensure_future', spy_ensure_future)

    loop = asyncio.new_event_loop()
    loop.set_exception_handler(lambda _loop, ctx: loop_errors.append(ctx))
    try:
        with pytest.raises(raised):
            loop.run_until_complete(execute_module._run_uv(['uv', 'venv'], 30))
        # 给被 cancel 的 task 一个 tick 落定回调，pending 若未被回收会在此暴露。
        loop.run_until_complete(asyncio.sleep(0))

        # 1) 树杀恰好一次，且杀的就是本次 uv 进程（取消/超时同构）。
        assert killed == [proc], f'{label}: killed={killed}'
        # 2) drain_task 被显式 cancel（原缺口只 cancel 了 wait_task）。
        drain_task = captured['drain_task']
        assert drain_task.cancelled(), f'{label}: drain task 未被 cancel'
        # 3) 两个 task 都被 gather 回收：均已 done，且 loop 没有 pending-task 告警。
        assert drain_task.done()
        assert not [t for t in asyncio.all_tasks(loop) if not t.done()]
        assert loop_errors == [], f'{label}: {loop_errors}'
        # 4) wait_task 启动一次 + 收尾 reap 一次。
        assert proc.wait_calls >= 2, f'{label}: wait_calls={proc.wait_calls}'
    finally:
        loop.close()
