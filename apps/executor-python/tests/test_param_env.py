"""EXEC-07（P3，2026-10-29 执行器域审计）：params 键名**折叠冲突**的两端同判。

与 ``apps/executor-node/src/param-env.spec.ts`` 逐条对等——两侧必须给出**同一个
判断**和**逐字节相同的文案**，否则同一个任务在两个执行器上得到相反的结论
（一台 400、一台静默错参），比两边都拒绝更难排查。

## 缺陷形态

键名闸 ``_PARAM_KEY_RE`` 是**大小写敏感**的，而注入口径 ``f'AUTOFLOW_{k.upper()}'``
把它们**折叠**成同一个 env 名。于是 ``{"limit": 1, "LIMIT": 2}`` 两个键都通过
校验、都注入 ``AUTOFLOW_LIMIT``，后者**静默覆盖**前者——任务读到非预期参数，
零 warn。修法：**参数校验阶段**（``accept_execution``）fail-closed 400。

本文件断言三层：
  ① 「为什么」——折叠是既成事实、两个键都能过键名闸（键名闸单独挡不住）；
  ② 判定与文案对 ``protocol.json`` 的 ``params.keyUniqueness`` 向量逐条断言
     （含 ``expectCollisions`` 与**逐字节** ``expectError``）；
  ③ 端到端闸门 ``accept_execution`` 400，以及「折叠后不冲突的大小写不同键
     照旧被接受」（不扩大拒绝面）。
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from routers import execute as execute_module
from routers.execute import (
    ExecutionRejected,
    _describe_param_env_key_collisions,
    _is_injectable_param_key,
    _param_env_key_collisions,
)

_PROTOCOL_PATH = (
    Path(__file__).resolve().parents[3]
    / 'packages'
    / 'executor-protocol'
    / 'protocol.json'
)
PROTOCOL = json.loads(_PROTOCOL_PATH.read_text(encoding='utf-8'))
SECTION = PROTOCOL['params']['keyUniqueness']


# ---------------------------------------------------------------------------
# ① 缺陷成因：折叠是既成事实，且两个键都通过键名闸
# ---------------------------------------------------------------------------


def test_folding_is_a_fact_and_both_keys_pass_the_name_gate():
    """两条一起构成缺陷：键名闸只看字符集（大小写敏感），注入却折叠。

    反证：删掉 ``accept_execution`` 里的冲突手检（或把 ``_param_env_key_collisions``
    改成恒返回 []），下面的 ``test_protocol_vectors`` 与 accept 闸用例立刻转红。
    """
    assert f'AUTOFLOW_{"limit".upper()}' == f'AUTOFLOW_{"LIMIT".upper()}' == 'AUTOFLOW_LIMIT'
    assert _is_injectable_param_key('limit') is True
    assert _is_injectable_param_key('LIMIT') is True
    assert _param_env_key_collisions({'limit': 1, 'LIMIT': 2}) == [
        {'envKey': 'AUTOFLOW_LIMIT', 'keys': ['LIMIT', 'limit']}
    ]


def test_rule_metadata_matches_protocol():
    """协议段的元数据与实现同源（reasonCode 是两端共享的常量）。"""
    assert SECTION['rule'] == 'reject-case-fold-collision'
    assert SECTION['onCollision'] == 'reject'
    assert SECTION['statusCode'] == 400
    assert SECTION['collisionScope'] == 'injectable-keys-only'
    assert SECTION['reasonCode'] == execute_module._PARAM_KEY_COLLISION_REASON
    assert SECTION['reasonCode'] == 'param_key_case_collision'
    assert f"reason={SECTION['reasonCode']}" in SECTION['messageTemplate']


# ---------------------------------------------------------------------------
# ② 协议向量逐条对真实实现断言（判定 + 逐字节文案）
# ---------------------------------------------------------------------------


def test_vector_scan_surface_is_not_vacuous():
    vectors = SECTION['vectors']
    assert len(vectors) >= 8
    assert sum(1 for v in vectors if v['expectError'] is not None) >= 3
    assert sum(1 for v in vectors if v['expectError'] is None) >= 3


@pytest.mark.parametrize('vector', SECTION['vectors'], ids=lambda v: v['name'])
def test_protocol_vectors_match_runtime(vector):
    collisions = _param_env_key_collisions(vector['params'])
    assert collisions == vector['expectCollisions'], (
        f"params 键名折叠冲突向量「{vector['name']}」判定漂移："
        f"期望 {vector['expectCollisions']}，实际 {collisions}"
    )
    if vector['expectError'] is None:
        assert collisions == []
        return
    # 逐字节相等：node 侧对同一向量断言同一串（两端文案不许漂移）。
    assert _describe_param_env_key_collisions(collisions) == vector['expectError']
    # 可读性硬要求：必须点名冲突的两个键与最终 env 名。
    for c in collisions:
        assert c['envKey'] in vector['expectError']
        for key in c['keys']:
            assert key in vector['expectError']


# ---------------------------------------------------------------------------
# ③ 端到端闸门：accept_execution
# ---------------------------------------------------------------------------


@pytest.fixture
def idle_executor(monkeypatch):
    """把容量/后台任务副作用降到最小，让 accept_execution 可同步调用。"""
    monkeypatch.setattr(execute_module.sched, 'get_running_count', lambda: 0)
    monkeypatch.setattr(execute_module.sched, 'increment_running', lambda: None)
    monkeypatch.setattr(execute_module.settings, 'max_concurrent_tasks', 10)

    def fake_create_task(coro):
        coro.close()  # 避免 "coroutine was never awaited" 告警
        return MagicMock()

    monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)


def test_accept_execution_rejects_case_fold_collision_with_400(idle_executor):
    """`{"limit":1,"LIMIT":2}` → 400，文案与 node 逐字节相同（协议向量对账）。"""
    eid = 'exec-param-fold-collision'
    req = execute_module.ExecuteRequest.model_construct(
        executionId=eid,
        task={'runtime': 'python', 'entrypoint': 'main.py'},
        params={'limit': 1, 'LIMIT': 2},
        secrets=None,
    )
    expected = next(
        v['expectError'] for v in SECTION['vectors'] if v['name'] == 'case-fold-collision-basic'
    )
    with pytest.raises(ExecutionRejected) as excinfo:
        execute_module.accept_execution(req)
    assert excinfo.value.status_code == 400
    assert excinfo.value.detail == expected
    # fail-closed 且**不得留下 live 条目**：登记后 raise 会把这个 executionId
    # 永久钉在 live 表里，重复领取守卫从此永远拒绝它（E-19 踩过的坑）。
    assert execute_module.execution_exists(eid) is False
    assert eid not in execute_module.list_active_execution_ids()


def test_accept_execution_allows_mixed_case_distinct_keys(idle_executor):
    """反向护栏：折叠后不冲突的大小写不同键照旧被接受（不扩大拒绝面）。

    反证：把判定从「按最终 env 名分组」改成「大小写不同的键即拒」，本例转红。
    """
    eid = 'exec-param-fold-ok'
    req = execute_module.ExecuteRequest(
        executionId=eid,
        task={'runtime': 'python', 'entrypoint': 'main.py'},
        params={'Mode': 'a', 'mode_id': 'b', '1ST': 'c'},
    )
    try:
        result = execute_module.accept_execution(req)
        assert result['status'] == 'accepted'
    finally:
        execute_module.unregister_live_execution(eid)


def test_accept_execution_ignores_collisions_between_invalid_keys(idle_executor):
    """两个非法键折叠成同名也不拒：它们本来就走 skip-and-warn、绝不注入。

    反证：把「只分析可注入键」这层去掉，本例会 400（方向反了——凭非法键拒掉
    整份合法配置）。
    """
    eid = 'exec-param-invalid-fold-ok'
    req = execute_module.ExecuteRequest.model_construct(
        executionId=eid,
        task={'runtime': 'python', 'entrypoint': 'main.py'},
        params={'A=B': 1, 'a=b': 2},
        secrets=None,
    )
    try:
        result = execute_module.accept_execution(req)
        assert result['status'] == 'accepted'
    finally:
        execute_module.unregister_live_execution(eid)


def test_collision_helper_tolerates_non_dict_params():
    """畸形载荷（非 dict）不得让判定抛错——交给协议闸门 400。"""
    assert _param_env_key_collisions(None) == []
    assert _param_env_key_collisions(['a']) == []  # type: ignore[arg-type]
    assert _param_env_key_collisions({}) == []


def test_param_key_with_trailing_newline_is_not_injectable() -> None:
    """EXEC-07 残差 3：Python `$` 会在末尾换行前匹配，node `$` 不会。

    若用 `re.match` + `$`，`"LIMIT\\n"` 在 python 侧会被当成合法键（折叠后注入
    `AUTOFLOW_LIMIT`），而 node 侧拒绝——同一载荷两端判定相反。这里钉住
    `fullmatch` 口径：带换行的键一律不可注入、不参与折叠冲突判定。
    """
    from routers.execute import (  # noqa: WPS433 (测试内导入，复用真实实现)
        _is_injectable_param_key,
        _param_env_key_collisions,
    )

    assert _is_injectable_param_key("LIMIT\n") is False
    assert _is_injectable_param_key("LIMIT") is True
    # 带换行的键被忽略后，不与合法的 LIMIT 形成"折叠冲突"（合法键仍注入）
    assert _param_env_key_collisions({"LIMIT\n": 1, "limit": 2}) == []
