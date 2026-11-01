"""S4-C2：任务进程树内存看门狗（``task_memory_watchdog.py``）+ run_task 接线。

覆盖（对应规格里的 ①-⑤）：
① 注入 fake sampler 返回 ``[(0, 100MB), (2s, 900MB)]``、limit=768 ⇒
   ``on_exceed`` **恰好一次**；``stop()`` 后不再采样；
② 进程已退出 ⇒ 采样 0 ⇒ 不触发（真实 ``/proc`` 采样器 + 缺文件的假 procfs）；
③ 树聚合：parent 100MB + child 800MB ⇒ 合计 900MB 超限（是**树**不是单进程，
   且同一棵树去掉 child 只有 100MB、不触发）；
④ ``/proc`` 不可用 / 采样器抛异常 ⇒ 不抛、不触发（best-effort）；
⑤ 跨端口径：python 的文案骨架 == node ``routes/execute.ts`` 里那句模板。

外加：run_task 的接线（起/停时机、超限终态文案、limit=0 关闭）。

**不跑真任务**：run_task 用例把 ``create_subprocess_exec`` 换成假进程，
``_kill_process_tree`` 换成"标记退出"的假实现——验证的是接线，不是子进程行为。
"""
import asyncio
import re
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

import task_memory_watchdog as tmw

MB = 1024 * 1024


# ---------------------------------------------------------------------------
# 测试替身
# ---------------------------------------------------------------------------

class ScriptedSampler:
    """按**假时钟**返回 ``[(at_ms, rss_bytes)]`` 中当前时刻生效的最后一个样本。

    规格里的 ``[(0, 100MB), (2s, 900MB)]`` 直接落在这张表上：t<2s 采到 100MB，
    t>=2s 采到 900MB。用可注入的 clock 而不是真等 2 秒，测试因此是确定性的
    毫秒级用例（采样间隔仍走产品默认量级）。
    """

    def __init__(self, samples, clock):
        self._samples = list(samples)
        self._clock = clock
        self.calls = 0

    def sample_rss_bytes(self, pid: int) -> int:
        self.calls += 1
        now_ms = self._clock() * 1000
        current = 0
        for at_ms, rss in self._samples:
            if at_ms <= now_ms:
                current = rss
        return current


class ZeroSampler:
    """进程已退出 / 非 Linux 的采样结果：0（node ``sampleRssBytes`` 同契约）。"""

    def sample_rss_bytes(self, pid: int) -> int:
        return 0


class BoomSampler:
    """采样器抛异常——看门狗必须吞掉（node ``.catch(() => {})`` 同款）。"""

    def sample_rss_bytes(self, pid: int) -> int:
        raise RuntimeError('procfs race')


async def _wait_until(predicate, timeout: float = 2.0, step: float = 0.01) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(step)
    return predicate()


def _write_procfs(root: Path, pid: int, vm_rss_kb: int, children=()) -> None:
    """在 ``root`` 下搭一份最小 procfs 片段（status + children）。"""
    proc_dir = root / str(pid)
    proc_dir.mkdir(parents=True, exist_ok=True)
    (proc_dir / 'status').write_text(
        f'Name:\ttask\nState:\tR (running)\nVmSize:\t{vm_rss_kb * 4} kB\n'
        f'VmRSS:\t{vm_rss_kb} kB\nThreads:\t1\n',
        encoding='utf-8',
    )
    task_dir = proc_dir / 'task' / str(pid)
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / 'children').write_text(
        (' '.join(str(child) for child in children) + '\n') if children else '\n',
        encoding='utf-8',
    )


# ---------------------------------------------------------------------------
# ① on_exceed 恰好一次；stop() 后不再采样
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_on_exceed_fires_exactly_once_then_stop_halts_sampling():
    """规格 ①：[(0,100MB),(2s,900MB)] + limit=768 ⇒ 恰好一次；stop 后不再调用。"""
    clock = [0.0]
    sampler = ScriptedSampler(
        [(0, 100 * MB), (2000, 900 * MB)], lambda: clock[0],
    )
    hits = []
    watchdog = tmw.start_memory_watchdog(
        4242, 768, interval_ms=100,
        on_exceed=lambda: hits.append('exceeded'), sampler=sampler,
    )
    try:
        # t<2s：两个 tick 都是 100MB，远低于 768MB —— 不该触发。
        await asyncio.sleep(0.25)
        assert hits == [], f'未超限不得触发，实际 {hits}'

        # 模拟「2s 时树 RSS 涨到 900MB」（真实场景：子进程开始吃内存）。
        clock[0] = 2.0
        triggered = await _wait_until(lambda: bool(hits))
        assert triggered, '树 RSS 900MB > 768MB 必须触发 on_exceed'

        # 触发后再跑三个 tick：看门狗自身已停机 ⇒ 不会二次触发。
        await asyncio.sleep(0.3)
        assert hits == ['exceeded'], f'on_exceed 必须恰好一次，实际 {len(hits)} 次'
    finally:
        watchdog.stop()

    calls_at_stop = sampler.calls
    await asyncio.sleep(0.3)
    assert sampler.calls == calls_at_stop, 'stop() 之后不得再采样'
    assert hits == ['exceeded']


# ---------------------------------------------------------------------------
# ② 进程已退出 ⇒ 采样 0 ⇒ 不触发
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_dead_process_samples_zero_and_never_triggers(tmp_path):
    """规格 ②：进程退出后 /proc 无条目 ⇒ 采样 0 ⇒ 看门狗静默。"""
    # 真实采样器 + 一份**不含该 pid** 的假 procfs：读文件失败 ⇒ 0（不抛）。
    sampler = tmw.LinuxProcTreeSampler(proc_root=str(tmp_path / 'proc'))
    assert sampler.sample_rss_bytes(404) == 0

    hits = []
    watchdog = tmw.start_memory_watchdog(
        404, 1, interval_ms=100,
        on_exceed=lambda: hits.append('exceeded'), sampler=sampler,
    )
    try:
        await asyncio.sleep(0.35)   # 3 个 tick，全部采到 0
        assert hits == [], '进程已退出（采样 0）时不得触发'
    finally:
        watchdog.stop()


# ---------------------------------------------------------------------------
# ③ 树聚合：parent 100MB + child 800MB ⇒ 900MB
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_tree_aggregation_counts_child_processes(tmp_path):
    """规格 ③：合计超限——验证是**树**不是单进程（parent 自己只有 100MB）。"""
    root = tmp_path / 'proc'
    _write_procfs(root, 123, 100 * 1024, children=[456])   # parent 100MB
    _write_procfs(root, 456, 800 * 1024)                   # child  800MB
    tree_sampler = tmw.LinuxProcTreeSampler(proc_root=str(root))
    assert tree_sampler.sample_rss_bytes(123) == 900 * MB, '树 RSS = 100 + 800'

    # 反证：同一份 parent 数据、把 children 摘掉（= 只有单进程视角）时 100MB，
    # 远低于 768MB —— 若按单进程算，这次超限根本不会发生。
    alone_root = tmp_path / 'proc-alone'
    _write_procfs(alone_root, 123, 100 * 1024)
    alone_sampler = tmw.LinuxProcTreeSampler(proc_root=str(alone_root))
    assert alone_sampler.sample_rss_bytes(123) == 100 * MB
    assert alone_sampler.sample_rss_bytes(123) < 768 * MB

    hits = []
    watchdog = tmw.start_memory_watchdog(
        123, 768, interval_ms=100,
        on_exceed=lambda: hits.append('exceeded'), sampler=tree_sampler,
    )
    try:
        triggered = await _wait_until(lambda: bool(hits))
        assert triggered, '树聚合 900MB > 768MB 必须触发'
        await asyncio.sleep(0.25)
        assert hits == ['exceeded']
    finally:
        watchdog.stop()


def test_sampler_sums_grandchildren_like_node_spec(tmp_path):
    """树聚合递归到孙进程（与 node ``memory-watchdog.spec.ts`` 的用例同构）。"""
    root = tmp_path / 'proc'
    _write_procfs(root, 100, 1024, children=[200, 201])
    _write_procfs(root, 200, 512, children=[300])
    _write_procfs(root, 201, 256)
    _write_procfs(root, 300, 128)
    sampler = tmw.LinuxProcTreeSampler(proc_root=str(root))
    assert sampler.sample_rss_bytes(100) == (1024 + 512 + 256 + 128) * 1024

    # 重复出现的子 pid（pid 复用 / 同一子进程被列两次）只算一次：去重是防止
    # 把同一份内存重复记账、导致误杀。
    dup_root = tmp_path / 'proc-dup'
    _write_procfs(dup_root, 100, 1024, children=[200, 200])
    _write_procfs(dup_root, 200, 512)
    assert tmw.LinuxProcTreeSampler(
        proc_root=str(dup_root),
    ).sample_rss_bytes(100) == (1024 + 512) * 1024


# ---------------------------------------------------------------------------
# ④ /proc 不可用 ⇒ best-effort 不生效，不抛
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_proc_unavailable_is_best_effort(tmp_path):
    """规格 ④：无 /proc（非 Linux）⇒ 采样 0、不触发、不抛（node Windows 同策）。"""
    sampler = tmw.LinuxProcTreeSampler(proc_root=str(tmp_path / 'no-such-proc'))
    assert sampler.sample_rss_bytes(1) == 0

    for bad in (sampler, BoomSampler()):
        hits = []
        watchdog = tmw.start_memory_watchdog(
            1, 1, interval_ms=100,
            on_exceed=lambda: hits.append('exceeded'), sampler=bad,
        )
        try:
            await asyncio.sleep(0.25)
            assert hits == [], '采样不可用/抛异常时不得触发'
        finally:
            watchdog.stop()


def test_start_outside_event_loop_degrades_to_noop():
    """契约：看门狗起不来也绝不打断任务（无事件循环 ⇒ no-op + 不抛）。"""
    hits = []
    watchdog = tmw.start_memory_watchdog(
        1, 1, on_exceed=lambda: hits.append('exceeded'), sampler=ZeroSampler(),
    )
    assert watchdog.stopped is True
    assert hits == []


def test_interval_below_floor_is_clamped():
    """低于下限的间隔钳到 MIN_INTERVAL_MS（与 config 的钳制同源）。"""
    watchdog = tmw.start_memory_watchdog(
        1, 1, interval_ms=10, on_exceed=lambda: None, sampler=ZeroSampler(),
    )
    assert watchdog.interval_ms == tmw.MIN_INTERVAL_MS


@pytest.mark.asyncio
async def test_async_on_exceed_may_stop_itself():
    """run_task 传的是 async 回调；回调里再调 stop() 不得把自己拦腰取消。"""
    holder = {}
    hits = []

    async def on_exceed():
        hits.append('start')
        await asyncio.sleep(0)      # 有 await 点才暴露"取消自己"的风险
        hits.append('done')
        holder['watchdog'].stop()   # 回调内部停自己：安全

    watchdog = tmw.start_memory_watchdog(
        7, 1, interval_ms=100, on_exceed=on_exceed,
        sampler=ScriptedSampler([(0, 5 * MB)], lambda: 0.0),
    )
    holder['watchdog'] = watchdog
    try:
        triggered = await _wait_until(lambda: len(hits) == 2)
        assert triggered, f'async on_exceed 必须完整跑完，实际 {hits}'
        assert hits == ['start', 'done']
    finally:
        watchdog.stop()


@pytest.mark.asyncio
async def test_on_exceed_exception_is_swallowed():
    """回调自己抛异常（如树杀失败）也不得把任务打崩——只记 warning。"""
    def boom():
        raise RuntimeError('tree kill failed')

    watchdog = tmw.start_memory_watchdog(
        7, 1, interval_ms=100, on_exceed=boom,
        sampler=ScriptedSampler([(0, 5 * MB)], lambda: 0.0),
    )
    try:
        await asyncio.sleep(0.3)
        assert watchdog.stopped is True, '抛过异常的看门狗同样已停机（不会重复回调）'
    finally:
        watchdog.stop()


# ---------------------------------------------------------------------------
# ⑤ 跨端口径：文案骨架逐字相同
# ---------------------------------------------------------------------------

def test_message_skeleton_matches_node_executor():
    """规格 ⑤：python 文案骨架 == node ``routes/execute.ts`` 里那句模板。

    node 侧目前没有针对这句话的 spec 断言，而本轮的足迹**禁止**改
    ``apps/executor-node/**``，故把断言放在 python 侧、直接读 node 源码里的
    模板字面量：任一端改字/改措辞都会让这条断言转红，跨端一致因此仍被钉住
    （比"两边各写一份硬编码字符串"更难悄悄漂移）。
    """
    node_source = (
        Path(__file__).resolve().parents[2]
        / 'executor-node' / 'src' / 'routes' / 'execute.ts'
    )
    text = node_source.read_text(encoding='utf-8')
    match = re.search(r'任务超出了 \$\{[^}]*\}MB 的内存上限', text)
    assert match, (
        f'{node_source} 里找不到 node 侧超限文案骨架——文案被改写/搬走了，'
        '先确认两端是否仍同口径'
    )
    node_skeleton = re.sub(r'\$\{[^}]*\}', '{limit_mb}', match.group(0))

    assert node_skeleton == tmw.MEMORY_LIMIT_MESSAGE_TEMPLATE, (
        f'跨端文案骨架不一致：node={node_skeleton!r} '
        f'python={tmw.MEMORY_LIMIT_MESSAGE_TEMPLATE!r}'
    )
    # 渲染后的用户可见文案（两边同形：`任务超出了 <N>MB 的内存上限`）。
    assert tmw.format_memory_limit_message(768) == '任务超出了 768MB 的内存上限'


# ---------------------------------------------------------------------------
# 配置：默认 2000ms、下限钳制（与看门狗同源）
# ---------------------------------------------------------------------------

def test_config_default_and_floor(monkeypatch):
    from config import Settings

    monkeypatch.delenv('TASK_MEMORY_WATCHDOG_INTERVAL_MS', raising=False)
    assert Settings(_env_file=None).task_memory_watchdog_interval_ms == 2000
    # 低于下限 ⇒ 钳到 MIN_INTERVAL_MS（100ms），不是让 sleep(0) 占满事件循环。
    assert Settings(
        _env_file=None, task_memory_watchdog_interval_ms=10,
    ).task_memory_watchdog_interval_ms == tmw.MIN_INTERVAL_MS


# ---------------------------------------------------------------------------
# run_task 接线（不跑真任务：假进程 + 假树杀）
# ---------------------------------------------------------------------------

class _FakeTaskProc:
    """run_task 眼里的任务子进程。

    ``exit_code=None`` ⇒ 一直挂到"被杀"为止（模拟超限路径）；给了 ``exit_code``
    ⇒ 立刻以该码退出（模拟正常收尾）。
    """

    def __init__(self, pid: int = 4242, exit_code=None) -> None:
        self.pid = pid
        self.returncode = exit_code
        self._exited = asyncio.Event()
        if exit_code is not None:
            self._exited.set()
        self.stdout = self._lines()

    async def _lines(self):
        await self._exited.wait()
        if False:  # pragma: no cover - 空异步生成器
            yield b''

    async def wait(self):
        await self._exited.wait()
        return self.returncode

    def kill(self) -> None:
        self.returncode = -9
        self._exited.set()


def _glue_task(name: str) -> dict:
    return {
        'name': name,
        'runtime': 'shell',
        'glueSource': '@echo off' if sys.platform == 'win32' else 'echo hi',
        'glueLanguage': 'shell',
    }


def _run(req, tmp_path, monkeypatch, proc, *, fake_start=None):
    """跑一次 run_task：假进程 + 假树杀（不跑真任务）。"""
    from routers import execute as execute_module
    from routers.execute import run_task

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    if fake_start is not None:
        monkeypatch.setattr(execute_module, 'start_memory_watchdog', fake_start)

    async def fake_exec(*args, **kwargs):
        return proc

    async def fake_tree_kill(target):
        target.kill()

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)
    monkeypatch.setattr(execute_module, '_kill_process_tree', fake_tree_kill)
    return asyncio.run(run_task(req))


def test_run_task_starts_watchdog_with_shared_settings(tmp_path, monkeypatch):
    """接线：spawn 之后起看门狗，参数取两侧同源的设置项，退出前 stop。"""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    started = []
    stopped = []

    def fake_start(pid, limit_mb, *, interval_ms, on_exceed):
        started.append({'pid': pid, 'limit_mb': limit_mb,
                        'interval_ms': interval_ms, 'on_exceed': on_exceed})
        return SimpleNamespace(stop=lambda: stopped.append(True))

    monkeypatch.setattr(execute_module.settings, 'task_memory_limit_mb', 768)
    monkeypatch.setattr(execute_module.settings, 'task_memory_watchdog_interval_ms', 250)

    result = _run(
        ExecuteRequest(executionId='exec-mem-ok', task=_glue_task('mem-ok')),
        tmp_path, monkeypatch, _FakeTaskProc(pid=4242, exit_code=0),
        fake_start=fake_start,
    )

    assert result['success'] is True, result
    assert started and started[0]['pid'] == 4242
    assert started[0]['limit_mb'] == 768, '上限与 RLIMIT_AS 同源（task_memory_limit_mb）'
    assert started[0]['interval_ms'] == 250
    assert stopped == [True], '退出前必须 stop（finally 无条件）'


def test_run_task_skips_watchdog_when_limit_disabled(tmp_path, monkeypatch):
    """接线：``task_memory_limit_mb = 0`` ⇒ 不起看门狗（node 同款守卫）。"""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    started = []

    def fake_start(*args, **kwargs):
        started.append((args, kwargs))
        return SimpleNamespace(stop=lambda: None)

    monkeypatch.setattr(execute_module.settings, 'task_memory_limit_mb', 0)

    result = _run(
        ExecuteRequest(executionId='exec-mem-off', task=_glue_task('mem-off')),
        tmp_path, monkeypatch, _FakeTaskProc(exit_code=0), fake_start=fake_start,
    )
    assert result['success'] is True, result
    assert started == [], '0 = 关闭，与 node 的 config.taskMemoryLimitMb > 0 同判'


def test_run_task_reports_memory_message_when_watchdog_trips(tmp_path, monkeypatch):
    """接线：超限 ⇒ 整树杀 + node 同骨架文案（不是「退出码 -9」）。"""
    from routers import execute as execute_module
    from routers.execute import ExecuteRequest

    stopped = []

    def fake_start(pid, limit_mb, *, interval_ms, on_exceed):
        async def _trip():
            await asyncio.sleep(0)
            await on_exceed()

        asyncio.ensure_future(_trip())
        return SimpleNamespace(stop=lambda: stopped.append(True))

    monkeypatch.setattr(execute_module.settings, 'task_memory_limit_mb', 768)

    result = _run(
        ExecuteRequest(executionId='exec-mem-trip', task=_glue_task('mem-trip')),
        tmp_path, monkeypatch, _FakeTaskProc(pid=4242), fake_start=fake_start,
    )

    assert result['success'] is False
    assert result['errorMessage'] == '任务超出了 768MB 的内存上限', result['errorMessage']
    # 与 node 同口径：内存超限的终态不带 exitCode（node 的 memErr 没有该字段）。
    assert result['exitCode'] is None
    assert stopped == [True]
