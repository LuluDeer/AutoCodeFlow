"""QA-07 shared contract vectors (autoflow-sdk side).

Vector source: packages/contract-fixtures/contract.json — the single source
of truth consumed by acf-cli / mcp-server / autocodeflow-node-sdk / this
package. See contract-fixtures/README.md for the contract description.
"""
import json
import pathlib

import httpx
import pytest
import respx

from autoflow_sdk.callback import CallbackClient, unwrap_envelope

CONTRACT = json.loads(
    (pathlib.Path(__file__).parents[2] / "contract-fixtures" / "contract.json").read_text(
        encoding="utf-8"
    )
)

URL = "http://admin.test/api/executions/callback"


def make_client(**overrides):
    kwargs = {
        "admin_api_url": "http://admin.test",
        "token": "v1.exec-1.1700000000.deadbeef",
        "executor_address": "executor-py:8001",
        "execution_id": "exec-1",
    }
    kwargs.update(overrides)
    return CallbackClient(**kwargs)


class TestContractFixtures:
    """QA-07: 四端共享向量 —— py 端 unwrap_envelope 契约面。"""

    def test_envelope_vectors_unwrap_to_documented_payload(self):
        for name, vector in CONTRACT["envelope"].items():
            assert unwrap_envelope(vector["raw"]) == vector["unwrapped"], f"envelope.{name}"

    def test_passthrough_vectors_returned_unchanged(self):
        for name, vector in CONTRACT["passthrough"].items():
            assert unwrap_envelope(vector["raw"]) == vector["unwrapped"], f"passthrough.{name}"

    def test_known_heuristic_edge_behaves_as_documented(self):
        vector = CONTRACT["knownHeuristicEdge"]
        assert unwrap_envelope(vector["raw"]) == vector["unwrapped"]

    def test_known_divergence_py_side_requires_strict_triple(self):
        # py 端要求 code+message+data 三键齐备（strict form）——与 node-sdk
        # 同侧，cli/mcp 的宽松形态分歧见 contract.knownDivergence 注记。
        vector = CONTRACT["knownDivergence"]
        assert unwrap_envelope(vector["raw"]) == vector["node_py_unwrapped_preserved"]

    @respx.mock
    def test_error_body_vectors_surface_envelope_message(self):
        """py 端对非 2xx：status>=400 抛 HTTPStatusError，message(str/str[])
        进异常文案（与向量 detail 的交集行为对齐——见 knownDivergence 注记）。"""
        for vector in CONTRACT["errorBody"]:
            respx.post(URL).mock(return_value=httpx.Response(400, json=vector["raw"]))
            with pytest.raises(httpx.HTTPStatusError) as excinfo:
                make_client().report_success()
            message = vector["raw"].get("message")
            if isinstance(message, str) and message:
                assert message in str(excinfo.value), f"errorBody.{vector['name']}"
            elif isinstance(message, list) and message:
                for part in message:
                    assert str(part) in str(excinfo.value), f"errorBody.{vector['name']}"
            respx.clear()
