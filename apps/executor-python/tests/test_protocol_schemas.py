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
