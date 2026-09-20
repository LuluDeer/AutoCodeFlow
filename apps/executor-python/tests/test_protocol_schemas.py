"""A3（DEEP_REVIEW 0ef3bbe §七）完整形态：executor-protocol 的 **pydantic 侧**向量断言。

与 ``apps/executor-node/src/protocol-schemas.spec.ts`` 加载**同一份**
``packages/executor-protocol/protocol.json``，跑**同一批** valid/invalid 向量：
任一侧对协议的理解与另一侧分叉，就有一侧会红——这才是「不再是注释里的 parity」。

断言有牙的地方在 invalid 分支：不只断言「被拒绝」，还断言**拒绝发生在
``expectErrorPath`` 指定的字段**上。只断言被拒绝会退化成永真（任何拼错字段都能
让它红，那就防不住真正的漂移）。
"""
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from generated import protocol_schemas as ps

_PROTOCOL = json.loads(
    (
        Path(__file__).parents[3]
        / "packages"
        / "executor-protocol"
        / "protocol.json"
    ).read_text(encoding="utf-8")
)

_VECTORS = {
    k: v for k, v in _PROTOCOL["schemaVectors"].items() if not k.startswith("$")
}
_SCHEMAS = {
    name: getattr(ps, name)
    for name in _VECTORS
    if hasattr(ps, name)
}


def test_runtime_model_accepts_valid_vectors():
    """协议里的合法样本必须能被 python 执行器**真正在用的**请求模型接受。

    只让生成物被测试消费的话，schema 与运行时模型仍可能各走各路——python 侧
    ``routers/execute.py`` 在 autocodeflow_sdk 缺席时用的是本地 fallback 模型
    （``task: Dict[str, Any]``，嵌套字段不校验）。本断言把两者钉在一起：协议
    加严到连 admin 的真实载荷都不接受时，这里会红。
    """
    from routers.execute import ExecuteRequest as RuntimeExecuteRequest

    for vec in _VECTORS["ExecuteRequest"].get("valid", []):
        RuntimeExecuteRequest.model_validate(vec)


def test_scan_surface_is_wired():
    """规模下界 + 生成物接线——向量被清空或生成器没跑时不能变成永真断言。"""
    assert len(_VECTORS) >= 5
    total = sum(
        len(v.get("valid", [])) + len(v.get("invalid", []))
        for v in _VECTORS.values()
    )
    assert total >= 20
    # 生成物与协议文件的 schema 名集合必须一致（漏生成 = 契约面缺失）
    assert set(_SCHEMAS) == set(_VECTORS)


def test_every_declared_schema_has_vectors():
    """A3 覆盖闸：protocol.schemas 的**每个** schema 都必须有向量（此前无此守卫）。

    缺口背景（ARCH-33 实施时补）：上面的 ``_SCHEMAS`` 是从 ``_VECTORS`` **反推**
    出来的（``for name in _VECTORS if hasattr(ps, name)``），于是它只能发现
    「有向量无生成类」，**永远看不见「有 schema 无向量」**——往 protocol.json
    的 schemas 段加一个 schema 却不加向量，两侧都悄无声息地通过，新契约面等于
    没有任何测试覆盖。本断言把 schemas 段本身拉进比对。
    """
    declared = {
        k for k in _PROTOCOL["schemas"] if not k.startswith("$")
    }
    assert declared == set(_VECTORS)
    # 反永真：确实存在若干 schema（防止有人把 schemas 段清空后本条恒真）
    assert len(declared) >= 5


def _valid_cases():
    for name, v in _VECTORS.items():
        for i, payload in enumerate(v.get("valid", [])):
            yield name, i, payload


def _invalid_cases():
    for name, v in _VECTORS.items():
        for vec in v.get("invalid", []):
            yield name, vec


@pytest.mark.parametrize(
    "name,index,payload",
    list(_valid_cases()),
    ids=[f"{n}-valid[{i}]" for n, i, _ in _valid_cases()],
)
def test_valid_vectors(name, index, payload):
    _SCHEMAS[name].model_validate(payload)


@pytest.mark.parametrize(
    "name,vec",
    list(_invalid_cases()),
    ids=[f"{n}-{v['name']}" for n, v in _invalid_cases()],
)
def test_invalid_vectors(name, vec):
    with pytest.raises(ValidationError) as exc:
        _SCHEMAS[name].model_validate(vec["payload"])
    paths = {tuple(str(p) for p in err["loc"]) for err in exc.value.errors()}
    expected = tuple(str(p) for p in vec["expectErrorPath"])
    assert expected in paths, (
        f"{name}/{vec['name']} 被拒绝了，但原因不落在 {expected}：实际 {sorted(paths)}"
    )


def test_generated_models_are_strict_no_lax_coercion():
    """生成物必须 `strict=True`——lax 模式会让协议两侧判定相反。

    pydantic 默认 **lax**：把数字字符串强转成数字（`'3600'` → `3600`）、把
    `0/1/'yes'/'true'` 强转成 bool。zod 侧从不做这些强转（`z.number().int()`
    拒 `'3600'`），于是同一个 schema 两侧对同一载荷一收一拒——闸门在 python
    侧形同虚设：**它声称拒绝的东西被悄悄改写后接受了**。

    实爆（本轮）：`{"timeout_seconds": "3600"}` 在 zod 侧被拒、在 pydantic 侧
    通过（强转成 3600）。语义后果比向量本身更脏：`{"timeout": "0"}`（显式
    不限时）也会被 python 静默接受并改写，而 node 直接 400 —— 同一条任务派到
    两台执行器上一台跑一台拒。

    反证有牙：把生成器的 `strict=True` 去掉，本用例立即红。
    """
    for name, model in _SCHEMAS.items():
        assert model.model_config.get("strict") is True, (
            f"{name} 未启用 strict —— lax 强转会让 pydantic 侧接受 zod 侧拒绝的载荷"
        )


def test_no_type_coercion_across_scalar_kinds():
    """端到端坐实「不强制转」：数值字段拒字符串、字符串字段拒数字、bool 拒 0/1。

    上一条只断言配置位在（改配置位即可让它红）；这条断言**实际行为**，
    防止"配了 strict 却被某处 model_validate(strict=False) 覆盖"。
    样本按各 schema 真实字段选取，故与协议形状同步演进。
    """
    # 数值字段：字符串形态必须拒（zod 侧同样拒）
    for payload in (
        {"timeout": "3600"},
        {"timeoutSeconds": "0"},
        {"timeout_seconds": "3600"},
    ):
        with pytest.raises(ValidationError):
            ps.TaskConfig.model_validate(payload)
    # 字符串字段：数字形态必须拒（runtimeVersion 的 IEEE754 尾零陷阱同源）
    for payload in ({"runtimeVersion": 3.11}, {"applicationId": 42}):
        with pytest.raises(ValidationError):
            ps.TaskConfig.model_validate(payload)
    # bool 字段：pydantic lax 会把 0/1/'yes'/'true' 强转成 bool
    with pytest.raises(ValidationError):
        ps.KillResponse.model_validate({"ok": "true"})
    with pytest.raises(ValidationError):
        ps.KillResponse.model_validate({"ok": 1})
    # 顺带确认真正合法的形态没被 strict 误伤（避免"收紧收过头"）
    assert ps.TaskConfig.model_validate({"timeout": 3600}).timeout == 3600
    assert ps.KillResponse.model_validate({"ok": True}).ok is True
