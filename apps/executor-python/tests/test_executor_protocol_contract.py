"""A3（DEEP_REVIEW 0ef3bbe §七 · executor-protocol）：python 侧契约断言。

三端（admin-api / executor-node / executor-python）加载**同一份**
`packages/executor-protocol/protocol.json`。此前这些一致性只靠两侧注释互相
引用维持（"node execute.ts:xxx parity" / "python 侧同步"）——每轮一致性修复
都在补漏。现在任一侧回退即红在 CI。
"""

import json
import pathlib

import pytest

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


# ---------------------------------------------------------------------------
# EXP-01（本轮体验审查）：执行器**实际会产出**的取值必须在契约枚举内
# ---------------------------------------------------------------------------
#
# 上面那条断言只校验契约**自洽**（all = reportable ∪ internal）——它永远发现
# 不了「python 产出了一个契约里根本没有的值」。EXP-01 正是从这个缺口漏出去的：
# `_refine_failure_reason` 自 F-1 起就会返回 `sandbox_unavailable`，而该值在
# protocol.json / ExecutionFailureReason / node CALLBACK_FAILURE_REASONS 三处
# **都不存在**。admin 的 `@IsIn` 命中即 400，python 又把 4xx 当不可重试、
# **整批放弃**——于是一台配错沙箱的执行器会让该机所有任务的终态回调永久送不
# 出去，连同批最多 99 个无关的成功任务一起丢失。
#
# 下面用**穷举输入**驱动真实的 `_refine_failure_reason`，把它的每一个可能返回值
# 都拿去比对契约。这才是「产出面 ⊆ 契约面」的守卫：新增规则若返回契约外取值，
# 这里立刻变红。


def test_refine_failure_reason_only_returns_contract_values():
    """`_refine_failure_reason` 的每个返回值都必须是契约内的可上报取值。"""
    reportable = set(PROTOCOL['failureReason']['executorReportable'])

    # 覆盖每条分类规则的触发文本（含 python 侧真实异常原文形状）。
    messages = [
        # interpreter_unavailable
        'uv venv failed: No interpreter found for Python 3.9',
        'No download found for request: cpython-3.7-x86_64-unknown-linux-gnu',
        'Python 3.7 unavailable (not_downloadable)',
        'interpreter 3.9 unavailable',
        '解释器无法获取',
        # package_fetch_failed
        'package download failed: 404',
        'package exceeds the maximum allowed size',
        'zip package rejected by security review',
        # git_fetch_failed
        "git clone failed: 'git' returned non-zero exit status 128",
        # dependency_install_failed
        'uv pip install failed: no matching distribution',
        'uv venv timed out after 300s',
        'dependency installation failed',
        # runtime_missing
        'spawn uv ENOENT',
        'no such file or directory: uv',
        'runtime python3.9 not supported',
        # EXP-01 本体：沙箱不可用（sandbox.py 的两条真实文案）
        'TASK_SANDBOX=bwrap is configured but the bwrap binary is not on PATH',
        'TASK_SANDBOX=bwrap is not supported on Windows',
        # 无规则命中 → None（交给 admin inferFailureReason 兜底）
        'something entirely unrelated went wrong',
        '',
    ]

    produced = {
        reason
        for reason in (execute_module._refine_failure_reason(m) for m in messages)
        if reason is not None
    }

    # 守卫：如果正则全被改坏，produced 会变空集，下面的 issubset 就成了假绿。
    assert len(produced) >= 5, (
        f'分类规则疑似失效：{len(messages)} 条输入只产出 {produced}'
    )

    illegal = produced - reportable
    assert not illegal, (
        f'_refine_failure_reason 产出了契约外的取值 {sorted(illegal)}——'
        f'admin 的 @IsIn 会 400 拒掉**整批**回调（python 侧对 4xx 不可重试、'
        f'直接放弃），导致该执行器所有任务的终态永久丢失。'
        f'契约可上报集合：{sorted(reportable)}'
    )


def test_sandbox_failure_is_classified_as_sandbox_unavailable():
    """EXP-01 回归：沙箱不可用必须归到独立分类，而不是被别的规则吞掉。

    这条用例同时钉住「分类优先级」——若 sandbox 规则被移到 runtime_missing 的
    `no such file or directory.{0,60}(uv|git|python3?)` 之后，bwrap 缺失的文案
    仍应归 sandbox_unavailable（bwrap 不在那条正则的候选里，但未来有人把 bwrap
    加进去就会误吞）。
    """
    assert (
        execute_module._refine_failure_reason(
            'TASK_SANDBOX=bwrap is configured but the bwrap binary is not on PATH'
        )
        == 'sandbox_unavailable'
    )
    assert (
        execute_module._refine_failure_reason(
            'TASK_SANDBOX=bwrap is not supported on Windows'
        )
        == 'sandbox_unavailable'
    )


# ---------------------------------------------------------------------------
# CallbackPayload（本轮协议 SSOT 补全）：执行器→admin 回调载荷的 schema 对账
# ---------------------------------------------------------------------------


def test_callback_payload_failure_reason_enum_matches_executor_reportable():
    """schema 的 failureReason 枚举必须与 failureReason.executorReportable 逐值同集。

    枚举是**独立的一份字面量**（受控子集无法 $ref 非对象值），两处各写一份就会
    漂移——admin 新增可上报取值时只改 failureReason 段、漏改 schema 枚举，闸门
    就比契约松。本断言把两份钉在一起。
    """
    from generated.protocol_schemas import CallbackPayload as ProtocolCallbackPayload
    from pydantic import ValidationError

    schema_enum = set(
        PROTOCOL['schemas']['CallbackPayload']['properties']['failureReason']['enum']
    )
    reportable = set(PROTOCOL['failureReason']['executorReportable'])

    assert schema_enum == reportable, (
        'schemas.CallbackPayload.failureReason 枚举与 failureReason.executorReportable '
        f'漂移：schema 独有 {sorted(schema_enum - reportable)}，'
        f'契约独有 {sorted(reportable - schema_enum)}'
    )

    # 反永真：枚举非空，且 admin 内部专用取值确实不在其中
    assert schema_enum
    assert not schema_enum & set(PROTOCOL['failureReason']['adminInternalOnly'])


def test_callback_payload_every_reportable_reason_passes_schema():
    """**全部 failureReason 枚举分支抽样**：12 个可上报取值逐个过生成的
    CallbackPayload（含 python 实际产出的每个分支：_refine_failure_reason 的
    六类 + killed/unknown 等），adminInternalOnly 的每个取值都被拒。"""
    from generated.protocol_schemas import CallbackPayload as ProtocolCallbackPayload
    from pydantic import ValidationError

    for reason in PROTOCOL['failureReason']['executorReportable']:
        ProtocolCallbackPayload.model_validate(
            {'executionId': 'exec-cb-enum', 'status': 'failed', 'failureReason': reason}
        )

    for reason in PROTOCOL['failureReason']['adminInternalOnly']:
        with pytest.raises(ValidationError):
            ProtocolCallbackPayload.model_validate(
                {'executionId': 'exec-cb-enum', 'status': 'failed', 'failureReason': reason}
            )


def test_callback_payload_python_wire_payloads_conform():
    """python 侧五处手拼载荷的**真实形态**（含显式 null / 字段省略分歧）逐一过
    生成的 CallbackPayload——形状漂移（加键/改 nullable）立即红。"""
    from generated.protocol_schemas import CallbackPayload as ProtocolCallbackPayload

    # _run_and_callback 主路径（成功：errorMessage/exitCode 显式 null 是 python
    # 真实线上形态；node 同场景省略键——分歧点如实收编进 schema 的 nullable）
    ProtocolCallbackPayload.model_validate({
        'executionId': 'exec-cb-1',
        'status': 'success',
        'exitCode': 0,
        'logs': 'done',
        'errorMessage': None,
        'durationMs': 1234,
        'executorAddress': '10.0.0.5:9100',
    })
    # _run_and_callback 运行期失败（exitCode=null + result 结构化明细 + artifacts）
    ProtocolCallbackPayload.model_validate({
        'executionId': 'exec-cb-2',
        'status': 'failed',
        'exitCode': None,
        'logs': '',
        'errorMessage': 'uv venv failed: No interpreter found for Python 3.7',
        'failureReason': 'interpreter_unavailable',
        'durationMs': 5000,
        'executorAddress': '10.0.0.5:9100',
        'result': {'interpreter': {'requested': '3.7', 'resolved': None, 'pool': []}},
        'artifacts': [{'name': 'report.txt', 'size': 3, 'sha256': 'a' * 64}],
        'traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    })
    # _push_killed_callback / reject_pulled_execution（v1 token 路径无
    # executorAddress——与 node withExecutorAddress 恒带的分歧点，optional 收编）
    ProtocolCallbackPayload.model_validate({
        'executionId': 'exec-cb-3',
        'status': 'failed',
        'errorMessage': 'Execution killed by admin request',
        'failureReason': 'killed',
    })
    # fail_prepare_stage_executions_on_shutdown（不设 failureReason）
    ProtocolCallbackPayload.model_validate({
        'executionId': 'exec-cb-4',
        'status': 'failed',
        'errorMessage': 'Executor is shutting down before this execution started',
        'executorAddress': '10.0.0.5:9100',
    })


def test_enqueue_callback_warns_on_protocol_drift(monkeypatch):
    """enqueue_callback 的 SSOT 对账闸有牙：漂移载荷必 warn（载荷照发），合法
    载荷不 warn。反证有牙：删掉 _validate_callback_payload 的调用，本用例即红。"""
    warnings: list[str] = []
    monkeypatch.setattr(
        execute_module.logger, 'warning', lambda msg, *a, **k: warnings.append(str(msg) % a if a else str(msg))
    )

    execute_module._live_callback_queue.clear()
    try:
        # 合法载荷（真实主路径形态）：零 warn
        execute_module.enqueue_callback({
            'executionId': 'exec-cb-ok',
            'status': 'failed',
            'errorMessage': 'x',
        })
        assert not [w for w in warnings if 'CallbackPayload' in w]

        # 漂移载荷：status 不是终态二值（回调通道只承载终态）→ 必 warn
        execute_module.enqueue_callback({
            'executionId': 'exec-cb-drift',
            'status': 'running',
        })
        drift = [w for w in warnings if 'CallbackPayload' in w]
        assert drift, '漂移载荷未触发 SSOT 对账 warn——闸门失效'
        assert 'status' in drift[0]

        # 漂移载荷：未知顶层键（CallbackPayload 是 forbid 额外键）→ 必 warn
        warnings.clear()
        execute_module.enqueue_callback({
            'executionId': 'exec-cb-drift-2',
            'status': 'failed',
            'newTopLevelKey': 1,
        })
        assert [w for w in warnings if 'CallbackPayload' in w]
    finally:
        execute_module._live_callback_queue.clear()


# ---------------------------------------------------------------------------
# secrets（SEC-02 续）：键名白名单/保留名拒绝的运行时语义向量
# ---------------------------------------------------------------------------


def test_secrets_contract_vectors_match_runtime():
    """顶层 secrets 段的向量逐条对真实实现断言（secret_env.is_injectable_secret_name）。

    键名规则**不在** schemas.ExecuteRequest 里闸（非法键的线上语义是静默跳过并
    warn，收进 schema 会把跳过改成 400）——这里是该规则唯一的共享闸。
    """
    from secret_env import is_injectable_secret_name

    section = PROTOCOL['secrets']
    assert section['onInvalidKey'] == 'skip-and-warn'
    assert section['injection'] == 'original-name'

    vectors = section['vectors']
    # 反永真：向量面非空，且合法/非法两侧都有样本
    assert len(vectors) >= 8
    assert any(v['injectable'] for v in vectors)
    assert any(not v['injectable'] for v in vectors)

    for vec in vectors:
        actual = is_injectable_secret_name(vec['key'])
        assert actual is vec['injectable'], (
            f"secrets 向量「{vec['name']}」（key={vec['key']!r}）期望 "
            f"injectable={vec['injectable']}，实际 {actual}——python 侧键名闸与协议漂移"
        )
