"""A3（DEEP_REVIEW 0ef3bbe §七 · executor-protocol）：python 侧契约断言。

三端（admin-api / executor-node / executor-python）加载**同一份**
`packages/executor-protocol/protocol.json`。此前这些一致性只靠两侧注释互相
引用维持（"node execute.ts:xxx parity" / "python 侧同步"）——每轮一致性修复
都在补漏。现在任一侧回退即红在 CI。
"""

import json
import pathlib

from routers import execute as execute_module
from routers import health as health_module


def _find_protocol() -> pathlib.Path:
    """向上找到仓库根（硬编码 ../×N 会随文件位置 silent 漂移）。"""
    here = pathlib.Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / 'packages' / 'executor-protocol' / 'protocol.json'
        if candidate.exists():
            return candidate
    raise AssertionError('packages/executor-protocol/protocol.json not found')


PROTOCOL = json.loads(_find_protocol().read_text(encoding='utf-8'))


def test_contract_file_is_reachable():
    """守卫：路径解析失败会让下面所有断言变成假绿。"""
    assert PROTOCOL['$schemaVersion'] > 0


# ---------------------------------------------------------------------------
# readiness
# ---------------------------------------------------------------------------


def test_readiness_contract_shape():
    readiness = PROTOCOL['readiness']

    assert readiness['statusValues'] == ['ready', 'not_ready']
    assert readiness['ready']['httpStatus'] == 200
    assert readiness['notReady']['httpStatus'] == 503
    for vector in readiness['vectors']:
        assert vector['payload']['status'] in readiness['statusValues']
        if vector['payload']['status'] == 'not_ready':
            assert vector['payload']['reason']

    # python 侧落点：/health/ready，无信封（bodyPath 为空串）
    self_component = readiness['perComponent']['executor-python']
    assert self_component['path'] == '/health/ready'
    assert self_component['bodyPath'] == ''
    # admin-api 有全局响应信封，payload 落在 data 下
    assert readiness['perComponent']['admin-api']['bodyPath'] == 'data'


def test_readiness_rejects_unready_when_resources_exhausted(monkeypatch):
    """A3: python 原先只看 admin 连通性——CPU/内存打满照样报 ready。"""
    monkeypatch.setattr(health_module, '_check_admin_api', _ok())
    monkeypatch.setattr(
        health_module.psutil,
        'cpu_percent',
        lambda *a, **k: 99.0,
    )

    ok, reason = health_module._resources_ok()

    assert ok is False
    assert 'Resource usage too high' in reason


def test_readiness_accepts_when_resources_ample(monkeypatch):
    monkeypatch.setattr(
        health_module.psutil,
        'cpu_percent',
        lambda *a, **k: 1.0,
    )
    monkeypatch.setattr(
        health_module.psutil,
        'virtual_memory',
        lambda: _Mem(1.0),
    )

    ok, reason = health_module._resources_ok()

    assert ok is True
    assert reason is None


class _Mem:
    def __init__(self, percent):
        self.percent = percent


def _ok():
    async def _inner():
        return True

    return _inner


# ---------------------------------------------------------------------------
# timeout
# ---------------------------------------------------------------------------


def test_timeout_contract_zero_is_unbounded():
    """0 = 显式不限时（E-02 已实现，此处防回退成 or-链的 falsy 语义）。"""
    assert PROTOCOL['timeout']['unbounded'] == 0
    assert PROTOCOL['timeout']['min'] == 1
    assert PROTOCOL['timeout']['max'] == 86400

    vectors = {v['name']: v for v in PROTOCOL['timeout']['vectors']}
    assert vectors['zero-is-unbounded']['declared'] == 0
    assert vectors['zero-is-unbounded']['unbounded'] is True

    # 解析语义：0 必须穿过，绝不能回落执行器默认值
    assert execute_module._resolve_task_timeout({'timeout': 0}) == 0
    assert execute_module._resolve_task_timeout({'timeoutSeconds': 0}) == 0


def test_timeout_missing_falls_back_to_executor_default():
    resolved = execute_module._resolve_task_timeout({})
    assert resolved >= 1


# ---------------------------------------------------------------------------
# failureReason
# ---------------------------------------------------------------------------


def test_failure_reason_contract_is_self_consistent():
    """python 侧此前没有 failureReason 枚举约束，只靠字符串字面量。"""
    reportable = set(PROTOCOL['failureReason']['executorReportable'])
    internal = set(PROTOCOL['failureReason']['adminInternalOnly'])

    assert reportable | internal == set(PROTOCOL['failureReason']['all'])
    # 两个集合必须互斥——写错会让本断言变相永真
    assert not (reportable & internal)
    assert internal  # 非空，否则 filter 逻辑无从验证
