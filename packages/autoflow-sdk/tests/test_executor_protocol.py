"""A3（executor-protocol）：autoflow-sdk 侧的 failureReason 契约断言。

SDK 的 `VALID_FAILURE_REASONS` 白名单必须与 admin 回调 DTO 的 `@IsIn` 集合
一致——否则 SDK 本地放行、admin 却 400，且一个非法取值会拒掉**整批**回调。

单一事实源：`packages/executor-protocol/protocol.json` 的
`failureReason.executorReportable`（admin-api / executor-node /
executor-python / 本 SDK 四方共载同一份文件）。
"""
import json
import pathlib

from autoflow_sdk.callback import VALID_FAILURE_REASONS

PROTOCOL = json.loads(
    (
        pathlib.Path(__file__).parents[2]
        / "executor-protocol"
        / "protocol.json"
    ).read_text(encoding="utf-8")
)


def test_contract_file_is_reachable():
    """守卫：路径解析失败会让下面所有断言变成假绿。"""
    assert PROTOCOL["$schemaVersion"] > 0


def test_valid_failure_reasons_match_contract():
    reportable = set(PROTOCOL["failureReason"]["executorReportable"])

    assert set(VALID_FAILURE_REASONS) == reportable


def test_valid_failure_reasons_exclude_admin_internal():
    internal = set(PROTOCOL["failureReason"]["adminInternalOnly"])

    assert internal  # 非空，否则本断言变相永真
    assert not (set(VALID_FAILURE_REASONS) & internal)
