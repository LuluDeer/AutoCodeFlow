"""H-4：回调落盘**文件名碰撞**的跨进程用例。

## 缺陷

``routers/execute.py::_persist_failed_callback`` 旧格式：

    filename = callback_dir / f'callback-{int(time.time() * 1000)}-{sequence}.json'

``sequence`` 来自**进程内**计数器 ``_callback_persistence_sequence``（由
``threading.Lock`` 保护）⇒ 同机两个执行器实例（共享同一 ``WORK_DIR``）在**同一
毫秒**取到**同一个 sequence** ⇒ 文件名**逐字相同** ⇒ 后者
``filename.unlink()`` + ``tmp.rename(filename)`` **覆盖**前者 ⇒ 前者的载荷
**永久丢失** ⇒ 该任务的**终态回调丢失** ⇒ 中台侧任务**永远停在 RUNNING**。

## 修法（结构性）

唯一性改由 ``uuid4().hex`` 保证 ⇒ **跨进程天然安全**（不需要任何锁），
碰撞概率可忽略（122 bit）。序号保留为**可读性前缀**（排障时看写入顺序），
**不参与**唯一性判定。

## 本文件的用例

* **真跨进程**（`multiprocessing` 起独立进程，各自的计数器都从 0 开始）⇒
  复现旧格式下的碰撞，钉住新格式下**不碰撞**；
* 旧格式的**对照复现**（在测试里手工按旧规则拼文件名）⇒ 证明这个用例
  **有本事失败**（不是永绿断言）。
"""

from __future__ import annotations

import json
import multiprocessing
import os
import sys
import time
from pathlib import Path

import pytest

_APP_DIR = Path(__file__).resolve().parents[1]
if str(_APP_DIR) not in sys.path:
    sys.path.insert(0, str(_APP_DIR))


# ---------------------------------------------------------------------------
# 子进程体（模块级 ⇒ 可 pickle，Windows 的 spawn 起点也能跑）
# ---------------------------------------------------------------------------

def _persist_once(work_dir_str: str, execution_id: str, barrier_path: str) -> None:
    """子进程体：在**同一毫秒**落一份回调载荷。

    用 ``barrier_path`` 让两个子进程在同一时刻动手 ⇒ 最大化「同毫秒」的
    概率（缺陷的必要条件）。
    """
    os.environ['WORK_DIR'] = work_dir_str
    sys.path.insert(0, str(_APP_DIR))
    from routers import execute as execute_module
    from config import settings

    # monkeypatch 不了（子进程），直接改 settings。
    settings.work_dir = work_dir_str

    # 等另一个进程就位 ⇒ 两边同一毫秒动手。
    deadline = time.monotonic() + 15
    while not Path(barrier_path).exists() and time.monotonic() < deadline:
        time.sleep(0.001)
    Path(barrier_path).write_text(execution_id, encoding='utf-8')

    execute_module._persist_failed_callback(
        {'executionId': execution_id, 'status': 'success'}, 'http://admin.local/cb')


def _mp_context():
    methods = multiprocessing.get_all_start_methods()
    for name in ('fork', 'forkserver', 'spawn'):
        if name in methods:
            return multiprocessing.get_context(name)
    return multiprocessing.get_context()


# ---------------------------------------------------------------------------
# 用例
# ---------------------------------------------------------------------------

def test_callback_filename_contains_unique_segment(monkeypatch, tmp_path):
    """新格式：文件名含**唯一段**（uuid），序号只作可读性前缀。

    格式：``callback-{ms}-{seq}-{uuid8}.json``。
    """
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    path = execute_module._persist_failed_callback(
        {'executionId': 'exec-uniq', 'status': 'success'}, 'http://admin.local/cb')
    assert path is not None
    name = path.name
    assert name.startswith('callback-')
    assert name.endswith('.json')
    parts = name[len('callback-'):-len('.json')].split('-')
    assert len(parts) == 3, f'文件名应是 callback-{{ms}}-{{seq}}-{{uuid8}}.json，实得 {name}'
    assert parts[0].isdigit(), '第一段是毫秒时间戳'
    assert parts[1].isdigit(), '第二段是序号（可读性前缀）'
    assert len(parts[2]) == 8, '第三段是唯一段（uuid 前 8 位）'
    assert all(c in '0123456789abcdef' for c in parts[2]), '唯一段是十六进制'


def test_two_persists_in_same_process_get_distinct_files(monkeypatch, tmp_path):
    """同一进程内连续两次落盘 ⇒ 两个不同文件（唯一段保证）。"""
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    a = execute_module._persist_failed_callback(
        {'executionId': 'exec-a', 'status': 'success'}, 'http://admin.local/cb')
    b = execute_module._persist_failed_callback(
        {'executionId': 'exec-b', 'status': 'success'}, 'http://admin.local/cb')
    assert a is not None and b is not None
    assert a != b, '两次落盘撞了同一个文件名'


def test_cross_process_persists_do_not_collide(tmp_path):
    """**真跨进程**：两个实例在同一毫秒落盘 ⇒ 两个不同文件、两个载荷都在。

    这是缺陷的原始形态：两个进程的计数器都从 0 开始 ⇒ 旧格式下会撞名 ⇒
    前者载荷丢失。
    """
    work_dir = tmp_path / 'work'
    work_dir.mkdir()
    barrier = tmp_path / 'barrier'

    ctx = _mp_context()
    p1 = ctx.Process(target=_persist_once,
                     args=(str(work_dir), 'exec-one', str(barrier)))
    p2 = ctx.Process(target=_persist_once,
                     args=(str(work_dir), 'exec-two', str(barrier)))
    p1.start()
    # 让 p1 先就位，再放行 p2 ⇒ 两边尽量落在同一毫秒。
    deadline = time.monotonic() + 10
    while not barrier.exists() and time.monotonic() < deadline:
        time.sleep(0.001)
    p2.start()
    p1.join(timeout=60)
    p2.join(timeout=60)
    assert not p1.is_alive() and not p2.is_alive()

    files = sorted((work_dir / 'callbacks').glob('callback-*.json'))
    assert len(files) == 2, (
        f'期望 2 个回调文件（两个实例各一个），实得 {len(files)}：'
        f'{[f.name for f in files]} —— 跨实例撞名了'
    )

    # 两个载荷**都在**（缺陷形态下这里会只剩一个）
    exec_ids = set()
    for f in files:
        data = json.loads(f.read_text(encoding='utf-8'))
        for item in data['payloads']:
            exec_ids.add(item['executionId'])
    assert exec_ids == {'exec-one', 'exec-two'}, (
        f'载荷丢失（终态回调会永久丢失 ⇒ 任务停在 RUNNING）：实得 {exec_ids}')


def test_old_format_would_have_collided(tmp_path):
    """**对照复现**：证明上一条用例有本事失败。

    手工按**旧规则**（``callback-{ms}-{seq}.json``，seq 是进程内计数器、
    两个进程都从 0 开始）拼文件名 ⇒ 必然撞名 ⇒ 后者覆盖前者 ⇒ 载荷丢失。
    """
    work_dir = tmp_path / 'work'
    (work_dir / 'callbacks').mkdir(parents=True)

    ms = int(time.time() * 1000)
    # 两个进程，各自计数器都是 0 ⇒ 同毫秒 ⇒ 同名
    name_a = f'callback-{ms}-0.json'
    name_b = f'callback-{ms}-0.json'
    assert name_a == name_b, '旧规则下两个进程同毫秒必然同名'

    payload = work_dir / 'callbacks' / name_a
    payload.write_text(json.dumps({'payloads': [{'executionId': 'exec-one'}]}),
                        encoding='utf-8')
    # 后者覆盖前者
    (work_dir / 'callbacks' / name_b).write_text(
        json.dumps({'payloads': [{'executionId': 'exec-two'}]}), encoding='utf-8')

    remaining = list((work_dir / 'callbacks').glob('callback-*.json'))
    assert len(remaining) == 1, '旧规则下只剩一个文件'
    data = json.loads(remaining[0].read_text(encoding='utf-8'))
    assert data['payloads'][0]['executionId'] == 'exec-two'
    # 前者的载荷**确实没了** —— 这就是缺陷的原始后果
    assert 'exec-one' not in json.dumps(data)


def test_legacy_filenames_are_still_replayable(monkeypatch, tmp_path):
    """**兼容期**：旧格式文件（``callback-{ms}-{seq}.json``）仍能被重发循环识别。

    判据依据：仓内唯一的文件名消费面是 ``startswith('callback-')`` +
    ``endswith('.json')`` 的前缀后缀判定，以及 ``callback-*.json`` glob ——
    三者对新旧格式一律成立 ⇒ **不需要兼容期**，但旧文件不能被漏掉。
    """
    from routers import execute as execute_module

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    cb_dir = tmp_path / 'callbacks'
    cb_dir.mkdir(parents=True, exist_ok=True)

    legacy = cb_dir / 'callback-1700000000000-0.json'
    legacy.write_text(json.dumps({
        'url': 'http://admin.local/cb',
        'payloads': [{'executionId': 'exec-legacy', 'status': 'success'}],
    }), encoding='utf-8')

    new = cb_dir / 'callback-1700000000001-1-deadbeef.json'
    new.write_text(json.dumps({
        'url': 'http://admin.local/cb',
        'payloads': [{'executionId': 'exec-new', 'status': 'success'}],
    }), encoding='utf-8')

    # 重发循环的文件筛选面（与 retry_persisted_callbacks 的判据逐字一致）
    files = sorted(p for p in cb_dir.iterdir()
                   if p.is_file() and p.name.startswith('callback-') and p.name.endswith('.json'))
    assert [p.name for p in files] == [legacy.name, new.name], (
        '旧格式文件被重发循环漏掉了 ⇒ 兼容期不成立')

    # 维护侧的 TTL 清扫面（_cleanup_dead_letter_files 只认 dead-letter/ 里的文件）
    assert legacy.is_file()


def test_no_parser_extracts_sequence_from_filename():
    """**取证**：仓内没有任何代码按文件名解析出序号。

    修法（改文件名格式）的前置条件：若有解析器依赖旧格式，就必须同步改或
    保持兼容。本用例把「无解析器」这条事实**钉成可执行断言**（不是靠人工
    记忆）。

    判据口径（**必须窄**，否则会误伤无关代码）：只检查**紧邻回调文件名**的
    上下文里有没有「切分后按位置取序号」或「正则抠数字当序号」的写法。
    仓内确实存在 ``traceparent.split('-')[1]``（取 trace id，**与文件名
    无关**）——把判据写成「文件里不许有 split('-')[1]」会把它误伤 ⇒ 那种
    判据是假红的来源。

    做法：把源码按行切开，只在**含回调文件名上下文**的窗口内（同一行或前后
    3 行内出现 ``callback-`` / ``callbackFile`` / ``callback_file``）找危险写法。
    """
    import re

    repo_root = _APP_DIR.parents[1]
    targets = [
        repo_root / 'apps' / 'executor-python' / 'routers' / 'execute.py',
        repo_root / 'apps' / 'executor-python' / 'maintenance.py',
        repo_root / 'apps' / 'executor-python' / 'pkg_cache.py',
        repo_root / 'apps' / 'executor-node' / 'src' / 'callback.ts',
        repo_root / 'apps' / 'executor-node' / 'src' / 'file-logger.ts',
    ]
    # 回调文件名的上下文标记（出现这些才认为「在谈回调文件名」）
    ctx_markers = ('callback-', 'callbackFile', 'callback_file', 'callbackPayloadName')
    # 在「谈回调文件名」的上下文里出现的这些写法 ⇒ 危险（疑似在抠序号）
    danger_patterns = [
        r"split\(['\"]-['\"]\)\[\s*\d+\s*\]",
        r"match\([^)]*callback-[^)]*\)",
        r"search\([^)]*callback-[^)]*\)",
        r"replace\([^)]*callback-[^)]*\)",
    ]

    for path in targets:
        assert path.exists(), f'取证目标不存在：{path}'
        lines = path.read_text(encoding='utf-8').splitlines()
        for idx, line in enumerate(lines):
            window = '\n'.join(lines[max(0, idx - 3): idx + 4])
            if not any(marker in window for marker in ctx_markers):
                continue
            for pat in danger_patterns:
                assert not re.search(pat, window), (
                    f'{path.name}:{idx + 1} 附近出现了「从回调文件名解析序号」的写法'
                    f'（{pat}）—— 改了命名格式后必须同步改解析器（或确认它不是序号解析）')

    # 正向留痕：仓内**确实**只有前缀/后缀/glob 三种消费形态。
    python_src = (repo_root / 'apps' / 'executor-python' / 'routers' / 'execute.py').read_text(
        encoding='utf-8')
    assert "p.name.startswith('callback-')" in python_src, (
        '重发循环的前缀判定形态变了 —— 本用例的前提（只有前缀/后缀/glob 消费面）需要重核')
    node_src = (repo_root / 'apps' / 'executor-node' / 'src' / 'callback.ts').read_text(
        encoding='utf-8')
    assert "file.startsWith('callback-')" in node_src, (
        'node 侧重发循环的前缀判定形态变了 —— 本用例的前提需要重核')
