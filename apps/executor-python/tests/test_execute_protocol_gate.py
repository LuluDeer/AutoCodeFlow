"""A3-C：协议闸门在 python 侧 `accept_execution` 的**运行时**断言。

与 `tests/test_protocol_schemas.py` 的分工：
  - 后者断言「生成的 pydantic 模型与 protocol.json 一致」；
  - 本文件断言「`accept_execution` 真的按协议拒绝」。

少这一层，schema 就只是一份被测试引用的产物——删掉手检、端点照收不误，
协议也不会红（本项目已多次踩「契约存在但不生效」）。
"""
import asyncio
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from routers import execute as execute_module
from routers.execute import ExecutionRejected


def _load_protocol() -> dict:
    root = Path(__file__).resolve().parents[3]
    return json.loads(
        (root / 'packages' / 'executor-protocol' / 'protocol.json').read_text(
            encoding='utf-8'
        )
    )


@pytest.fixture
def idle_executor(monkeypatch):
    """把容量/后台任务相关副作用降到最小，让 accept_execution 可同步调用。"""
    monkeypatch.setattr(execute_module.sched, 'get_running_count', lambda: 0)
    monkeypatch.setattr(execute_module.sched, 'increment_running', lambda: None)
    monkeypatch.setattr(execute_module.settings, 'max_concurrent_tasks', 10)


def _invalid_vectors() -> list[dict]:
    vectors = _load_protocol()['schemaVectors']['ExecuteRequest']['invalid']
    return vectors


def _neutralize_side_effects(monkeypatch) -> None:
    """掐掉闸门**之后**才会发生的副作用（容量占坑 + 后台任务）。

    只为让「闸门失效」在反证时表现为干净的 `DID NOT RAISE` 断言失败，而不是
    `no running event loop` 这类与被测行为无关的噪声——失败信息应当指向真正的
    缺陷，否则下一个人会去查事件循环而不是查闸门。
    """
    monkeypatch.setattr(execute_module.sched, 'get_running_count', lambda: 0)
    monkeypatch.setattr(execute_module.sched, 'increment_running', lambda: None)
    monkeypatch.setattr(execute_module.settings, 'max_concurrent_tasks', 10)

    def fake_create_task(coro):
        coro.close()  # 避免 "coroutine was never awaited" 告警
        return MagicMock()

    monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)


# ---------------------------------------------------------------------------
# 闸门：协议说非法的载荷，端点必须拒绝
# ---------------------------------------------------------------------------


def test_invalid_vector_scan_surface_is_non_empty():
    """扫描面守卫：向量被清空/键名写错时下面那组断言会变成永真。"""
    vectors = _invalid_vectors()
    assert isinstance(vectors, list)
    assert len(vectors) >= 6


@pytest.mark.filterwarnings(
    # model_construct 出来的畸形对象在 model_dump() 时会发序列化告警——那正是
    # 本组用例要拒的输入，告警本身不是被测行为（生产里只是一行噪声日志）。
    'ignore:Pydantic serializer warnings'
)
@pytest.mark.parametrize(
    'vector', _invalid_vectors(), ids=lambda v: v['name']
)
def test_invalid_vector_is_rejected_with_400(vector, idle_executor):
    # 刻意用 model_construct 绕过外层反序列化模型：FastAPI/SDK 的 ExecuteRequest
    # 会在更外层先拒掉其中一部分（422），那就测不到 accept_execution 自己的闸门。
    # 而 pull 路径与未来的模型演进都可能绕开外层——闸门必须在**它自己那一层**成立。
    payload = dict(vector['payload'])
    req = execute_module.ExecuteRequest.model_construct(
        executionId=payload.get('executionId'),
        task=payload.get('task'),
        params=payload.get('params'),
    )
    with pytest.raises(ExecutionRejected) as excinfo:
        execute_module.accept_execution(req)
    assert excinfo.value.status_code == 400
    assert excinfo.value.detail
    # 被拒路径不得留下 live 条目（见下方泄漏回归用例的注释）
    eid = vector['payload'].get('executionId')
    if isinstance(eid, str):
        assert execute_module.execution_exists(eid) is False


# ---------------------------------------------------------------------------
# 被拒不得残留 live 条目（E-19 手检曾落在登记表之后）
# ---------------------------------------------------------------------------


def test_rejected_execution_leaves_no_live_entry(idle_executor):
    """反证用例：把 E-19 的 requirements 手检挪回 `register_live_execution`
    之后，本例立刻转红。

    后果不是「多一条 400」那么轻：live 表是重复领取守卫与心跳活性上报的数据
    源，残留条目会让该 executionId 在本执行器上**永远**被当成「已在运行」——
    admin 的每一次重试都撞 400，心跳还会上报一个并不存在的执行。
    """
    eid = 'exec-leak-probe'
    req = execute_module.ExecuteRequest(
        executionId=eid, task={'requirements': 'lodash'}
    )
    with pytest.raises(ExecutionRejected) as excinfo:
        execute_module.accept_execution(req)
    assert excinfo.value.status_code == 400

    assert execute_module.execution_exists(eid) is False
    assert eid not in execute_module.list_active_execution_ids()


# ---------------------------------------------------------------------------
# 反向护栏：合法载荷不能被闸门误伤
# ---------------------------------------------------------------------------


def test_null_requirements_is_accepted(idle_executor, monkeypatch):
    """A3-C 回归：admin 的 `Task.requirements` 是 **nullable jsonb** 列，任务没配
    依赖时派发载荷里就是字面 `None`。

    首版协议把该字段写成纯 `list`（不接受 null），本地 26 个 spec 全绿，但 CI 的
    **selftests（pull 全链路真派发）**当场红：`task.requirements: Expected array,
    received null`。这就是「协议必须描述真实载荷、不能描述想象中的载荷」——
    补进协议后同时成为一条 valid 向量（两侧 protocol-schemas spec 都会断言）。
    """
    created: list = []

    def fake_create_task(coro):
        created.append(coro)
        coro.close()
        return MagicMock()

    monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)

    eid = 'exec-null-requirements'
    req = execute_module.ExecuteRequest(
        executionId=eid, task={'runtime': 'python', 'requirements': None}
    )
    try:
        result = execute_module.accept_execution(req)
        assert result['status'] == 'accepted'
    finally:
        execute_module.unregister_live_execution(eid)


def test_valid_vector_is_accepted(idle_executor, monkeypatch):
    """只断言拒绝会退化成「什么都拒」——必须有一条合法载荷确实被接受。"""
    created: list = []

    def fake_create_task(coro):
        created.append(coro)
        coro.close()  # 避免 "coroutine was never awaited" 告警
        return MagicMock()

    monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)

    valid = _load_protocol()['schemaVectors']['ExecuteRequest']['valid'][0]
    eid = valid['executionId']
    req = execute_module.ExecuteRequest(**valid)
    try:
        result = execute_module.accept_execution(req)
        assert result['status'] == 'accepted'
        assert result['executionId'] == eid
        assert len(created) == 1
    finally:
        execute_module.unregister_live_execution(eid)

    assert execute_module.execution_exists(eid) is False


# ---------------------------------------------------------------------------
# strict=True：两端对同一份契约必须给出相同结论
# ---------------------------------------------------------------------------


def test_gate_is_strict_against_numeric_strings(idle_executor, monkeypatch):
    """反证用例：把闸门退回 `model_validate(req.model_dump())`（去掉 strict=True），
    本例立刻转红。

    背景（本轮审计）：`routers/config.py` 的同名闸门早已用 `strict=True`，并在注释里
    写明理由——「pydantic 默认 lax 会把字符串 "4" 强转成 int，而 zod 与 JSON Schema
    的 type:integer 都不强转；协议闸门要与 executor-node 同语义」。但 `/execute` 的
    闸门**漏了这一条**，于是同一份畸形载荷两端结论相反：

      - executor-node（zod）：`task.timeoutSeconds: "300"` → **400**
      - executor-python（lax） ：同一载荷 → **被接受**，随后 `_resolve_task_timeout`
        的 `int(raw)` 把 `"300"` 解析成 300，任务照常跑

    契约闸门的全部意义就是消除这种分歧，故这里把它钉死。`task` 在外层 FastAPI 模型里
    是 `Dict[str, Any]`（值原样透传），所以这一层是唯一能拦住它的地方。
    """
    # 闸门若失效，载荷会被接受并继续往后走（登记 + create_task）。这里把后台任务
    # 与容量副作用都掐掉，好让「闸门失效」表现为**干净的断言失败**（DID NOT RAISE），
    # 而不是一个难读的事件循环异常。
    _neutralize_side_effects(monkeypatch)

    eid = 'exec-strict-probe'
    req = execute_module.ExecuteRequest(
        executionId=eid,
        task={'runtime': 'python', 'entrypoint': 'main.py', 'timeoutSeconds': '300'},
    )
    with pytest.raises(ExecutionRejected) as excinfo:
        execute_module.accept_execution(req)
    assert excinfo.value.status_code == 400

    # 与其它被拒路径同款：不得留下 live 条目（否则该 executionId 永久被当成在跑）
    assert execute_module.execution_exists(eid) is False


def test_gate_strictness_matches_node_on_a_shared_probe_set(idle_executor, monkeypatch):
    """把「两端同结论」本身变成断言，而不是靠人记得同步两处 strict。

    探针集合刻意只放**类型不符**的载荷：这类载荷在两侧都只可能被协议闸门拦下
    （node 的手检只判数值越界、python 的手检同理），故「两端都拒」正是闸门语义
    一致的直接证据。数值越界类不在本集合——那由两侧手检负责，且已有协议向量覆盖。
    """
    _neutralize_side_effects(monkeypatch)

    probes = [
        {'runtime': 'python', 'entrypoint': 'main.py', 'timeoutSeconds': '300'},
        {'runtime': 'python', 'entrypoint': 'main.py', 'timeout': '300'},
        {'runtime': 'python', 'entrypoint': 'main.py', 'requirements': 'lodash'},
    ]
    for index, task in enumerate(probes):
        eid = f'exec-strict-parity-{index}'
        req = execute_module.ExecuteRequest(executionId=eid, task=task)
        with pytest.raises(ExecutionRejected) as excinfo:
            execute_module.accept_execution(req)
        assert excinfo.value.status_code == 400, task
        assert execute_module.execution_exists(eid) is False
