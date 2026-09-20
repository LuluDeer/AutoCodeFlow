"""Tests for autoflow_sdk.callback.CallbackClient (R9, round-9; U14)."""
import json

import httpx
import pytest
import respx

from autoflow_sdk import callback as callback_module
from autoflow_sdk.callback import CALLBACK_MAX_ATTEMPTS, CallbackClient, CallbackDisabledError

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


class TestEnabledState:
    def test_enabled_with_all_three_credentials(self):
        client = make_client()
        assert client.enabled is True
        assert client.disabled_reason is None

    # U14: AUTOFLOW_EXECUTOR_ADDRESS is OPTIONAL (node-SDK / admin-api `v1.`
    # parity) — a N23 executor that never injects it must still be enabled.
    def test_enabled_without_executor_address(self):
        client = make_client(executor_address=None)
        assert client.enabled is True
        assert client.disabled_reason is None

    @pytest.mark.parametrize("missing", ["admin_api_url", "token"])
    def test_disabled_when_required_credential_absent(self, missing):
        client = make_client(**{missing: None})
        assert client.enabled is False
        env_name = {
            "admin_api_url": "AUTOFLOW_ADMIN_API_URL",
            "token": "AUTOFLOW_CALLBACK_TOKEN",
        }[missing]
        assert env_name in client.disabled_reason

    def test_empty_string_counts_as_absent(self):
        client = make_client(token="")
        assert client.enabled is False
        assert "AUTOFLOW_CALLBACK_TOKEN" in client.disabled_reason


class TestCallbackUrl:
    def test_appends_api_path(self):
        assert make_client().callback_url == URL

    def test_strips_trailing_slash(self):
        client = make_client(admin_api_url="http://admin.test/")
        assert client.callback_url == URL

    def test_no_double_api_when_base_already_has_it(self):
        client = make_client(admin_api_url="http://admin.test/api")
        assert client.callback_url == "http://admin.test/api/executions/callback"


class TestReportSuccess:
    @respx.mock
    def test_payload_and_auth_header(self):
        route = respx.post(URL).mock(return_value=httpx.Response(200, json={"results": []}))
        result = make_client().report_success(summary="3 rows written", duration_ms=1234)

        assert result == {"results": []}
        assert route.called
        request = route.calls.last.request
        assert request.headers["Authorization"] == "Bearer v1.exec-1.1700000000.deadbeef"
        assert json.loads(request.content) == [{
            "executionId": "exec-1",
            "status": "success",
            "executorAddress": "executor-py:8001",
            "logs": "3 rows written",
            "durationMs": 1234,
        }]

    @respx.mock
    def test_minimal_payload_omits_optional_fields(self):
        route = respx.post(URL).mock(return_value=httpx.Response(200, json={"results": []}))
        make_client().report_success()
        item = json.loads(route.calls.last.request.content)[0]
        assert item == {
            "executionId": "exec-1",
            "status": "success",
            "executorAddress": "executor-py:8001",
        }


class TestReportFailure:
    @respx.mock
    def test_error_maps_to_message_and_default_reason(self):
        route = respx.post(URL).mock(return_value=httpx.Response(200, json={"results": []}))
        make_client().report_failure(RuntimeError("upstream 503"), summary="partial run")

        item = json.loads(route.calls.last.request.content)[0]
        assert item["status"] == "failed"
        assert item["errorMessage"] == "upstream 503"
        assert item["failureReason"] == "script_error"
        assert item["logs"] == "partial run"
        assert item["executionId"] == "exec-1"
        assert item["executorAddress"] == "executor-py:8001"

    @respx.mock
    def test_custom_failure_reason_accepted(self):
        route = respx.post(URL).mock(return_value=httpx.Response(200, json={"results": []}))
        make_client().report_failure("slow", failure_reason="timeout")
        item = json.loads(route.calls.last.request.content)[0]
        assert item["failureReason"] == "timeout"

    def test_invalid_failure_reason_rejected_before_http(self):
        with pytest.raises(ValueError, match="failure_reason"):
            make_client().report_failure("x", failure_reason="not_a_reason")

    @respx.mock
    def test_error_message_truncated_to_dto_cap(self):
        route = respx.post(URL).mock(return_value=httpx.Response(200, json={"results": []}))
        make_client().report_failure("E" * 10_000)
        item = json.loads(route.calls.last.request.content)[0]
        assert len(item["errorMessage"]) == 4096


class TestReportBatch:
    @respx.mock
    def test_report_fills_defaults_and_keeps_explicit_values(self):
        route = respx.post(URL).mock(return_value=httpx.Response(200, json={"results": []}))
        make_client().report([
            {"status": "success"},
            {"executionId": "other", "status": "failed", "executorAddress": "addr-2"},
        ])
        items = json.loads(route.calls.last.request.content)
        assert items[0]["executionId"] == "exec-1"
        assert items[0]["executorAddress"] == "executor-py:8001"
        assert items[1]["executionId"] == "other"
        assert items[1]["executorAddress"] == "addr-2"

    @respx.mock
    def test_non_2xx_raises(self):
        respx.post(URL).mock(return_value=httpx.Response(401, json={"message": "Unauthorized"}))
        with pytest.raises(httpx.HTTPStatusError):
            make_client().report_success()


class TestDisabledBehaviour:
    def test_report_raises_disabled_error(self):
        client = make_client(token=None)
        with pytest.raises(CallbackDisabledError, match="AUTOFLOW_CALLBACK_TOKEN"):
            client.report([{"status": "success"}])

    def test_convenience_methods_raise_disabled_error(self):
        client = make_client(admin_api_url=None)
        with pytest.raises(CallbackDisabledError, match="AUTOFLOW_ADMIN_API_URL"):
            client.report_success()
        with pytest.raises(CallbackDisabledError, match="AUTOFLOW_ADMIN_API_URL"):
            client.report_failure("boom")


class TestExecutorAddressOptional:
    """U14: with no AUTOFLOW_EXECUTOR_ADDRESS the client stays enabled and
    simply omits executorAddress from items (admin-api `v1.` path allows it)."""

    @respx.mock
    def test_report_success_omits_executor_address_when_unknown(self):
        route = respx.post(URL).mock(return_value=httpx.Response(200, json={"results": []}))
        make_client(executor_address=None).report_success()
        item = json.loads(route.calls.last.request.content)[0]
        assert "executorAddress" not in item

    @respx.mock
    def test_report_failure_omits_executor_address_when_empty(self):
        route = respx.post(URL).mock(return_value=httpx.Response(200, json={"results": []}))
        make_client(executor_address="").report_failure("boom")
        item = json.loads(route.calls.last.request.content)[0]
        assert "executorAddress" not in item
        assert item["errorMessage"] == "boom"

    @respx.mock
    def test_batch_report_only_fills_known_address(self):
        route = respx.post(URL).mock(return_value=httpx.Response(200, json={"results": []}))
        make_client(executor_address=None).report([{"status": "success"}])
        item = json.loads(route.calls.last.request.content)[0]
        assert item == {"executionId": "exec-1", "status": "success"}


class TestEnvelopeUnwrapping:
    """U14: admin-api's ResponseInterceptor wraps every body in
    {code, message, data}; report() must hand back the inner data so
    callers can read result["results"]."""

    @respx.mock
    def test_report_unwraps_admin_api_envelope(self):
        inner = {"results": [{"executionId": "exec-1", "success": True}]}
        respx.post(URL).mock(return_value=httpx.Response(200, json={
            "code": 200, "message": "success", "data": inner,
        }))
        assert make_client().report_success() == inner

    @respx.mock
    def test_non_enveloped_body_passes_through_unchanged(self):
        respx.post(URL).mock(return_value=httpx.Response(200, json={"results": []}))
        assert make_client().report_failure("boom") == {"results": []}

    @respx.mock
    def test_envelope_with_null_data_returns_null(self):
        respx.post(URL).mock(return_value=httpx.Response(200, json={
            "code": 200, "message": "success", "data": None,
        }))
        assert make_client().report_success() is None


class TestRetrySemantics:
    """NETOPT-10-1: report() retries transport failures and 5xx/429 with
    bounded exponential backoff; 4xx stay single-shot. Backoff is neutralised
    in tests via monkeypatch so the suite stays fast and deterministic."""

    @staticmethod
    def _no_sleep(_attempt):
        return None

    def _patch_sleep(self, monkeypatch):
        monkeypatch.setattr(
            callback_module.CallbackClient,
            "_sleep_before_retry",
            staticmethod(lambda _attempt: None),
        )

    @respx.mock
    def test_transport_error_exhausts_attempts_then_propagates(self, monkeypatch):
        self._patch_sleep(monkeypatch)
        route = respx.post(URL).mock(side_effect=httpx.ReadTimeout("callback timed out"))

        with pytest.raises(httpx.ReadTimeout, match="callback timed out"):
            make_client(timeout=0.1).report_success()

        assert route.call_count == CALLBACK_MAX_ATTEMPTS

    @respx.mock
    def test_transport_error_then_success_recovers(self, monkeypatch):
        self._patch_sleep(monkeypatch)
        route = respx.post(URL).mock(side_effect=[
            httpx.ReadTimeout("blip"),
            httpx.Response(200, json={"results": []}),
        ])

        assert make_client(timeout=0.1).report_success() == {"results": []}
        assert route.call_count == 2

    @respx.mock
    def test_503_then_success_recovers(self, monkeypatch):
        self._patch_sleep(monkeypatch)
        route = respx.post(URL).mock(side_effect=[
            httpx.Response(503, text="Service Unavailable"),
            httpx.Response(200, json={"results": []}),
        ])

        assert make_client().report_success() == {"results": []}
        assert route.call_count == 2

    @respx.mock
    def test_429_then_success_recovers(self, monkeypatch):
        self._patch_sleep(monkeypatch)
        route = respx.post(URL).mock(side_effect=[
            httpx.Response(429, text="Too Many Requests"),
            httpx.Response(200, json={"results": []}),
        ])

        assert make_client().report_success() == {"results": []}
        assert route.call_count == 2

    @respx.mock
    def test_persistent_500_raises_after_all_attempts(self, monkeypatch):
        self._patch_sleep(monkeypatch)
        route = respx.post(URL).mock(return_value=httpx.Response(500, text="boom"))

        with pytest.raises(httpx.HTTPStatusError):
            make_client().report_success()

        assert route.call_count == CALLBACK_MAX_ATTEMPTS

    @respx.mock
    def test_4xx_is_not_retried(self, monkeypatch):
        self._patch_sleep(monkeypatch)
        route = respx.post(URL).mock(return_value=httpx.Response(401, json={
            "code": 401, "message": "Invalid or expired execution callback token", "data": None,
        }))

        with pytest.raises(httpx.HTTPStatusError):
            make_client().report_success()

        assert route.call_count == 1

    @respx.mock
    def test_408_is_not_retried(self, monkeypatch):
        """NETOPT-C P3: 与 executor 侧 401/408 重试的差异是**有意的**——SDK 4xx
        一律单发即抛（含 408），任务作者自管终态上报。钉死单发语义，防止未来
        被顺手加进重试集而放大重复回调。"""
        self._patch_sleep(monkeypatch)
        route = respx.post(URL).mock(return_value=httpx.Response(408, text="Request Timeout"))

        with pytest.raises(httpx.HTTPStatusError):
            make_client().report_success()

        assert route.call_count == 1


class TestNonJson2xxBody:
    """NETOPT-C P3: 2xx 但 body 非 JSON = 服务端契约违约——统一抛
    HTTPStatusError（docstring 承诺的类型契约），不再裸抛 ValueError。"""

    @respx.mock
    def test_2xx_non_json_raises_http_status_error(self):
        route = respx.post(URL).mock(return_value=httpx.Response(200, text="<html>gateway</html>"))

        with pytest.raises(httpx.HTTPStatusError):
            make_client().report_success()

        assert route.call_count == 1

    @respx.mock
    def test_2xx_non_json_message_includes_body_preview(self):
        # NETOPT-E P3-2: 摘要文本必须出现在异常消息里（原实现写死消息无信息量，
        # 排查时不知道服务端回了什么）。断言前 200 字符摘要在场。
        respx.post(URL).mock(return_value=httpx.Response(200, text="<html>gateway boom</html>"))

        with pytest.raises(httpx.HTTPStatusError) as excinfo:
            make_client().report_success()
        assert "<html>gateway boom</html>" in str(excinfo.value)


class TestTrustEnvPinned:
    """NETOPT-E P3-4: SDK 回调出站必须 trust_env=False（admin 内部通道不经
    系统代理）；被误删/改成 True 时本测试立即红。"""

    def test_report_client_pins_trust_env_false(self, monkeypatch):
        captured = {}

        class _FakeResp:
            status_code = 200
            request = httpx.Request("POST", URL)

            def json(self):
                return {"ok": True}

        class _FakeClient:
            def __init__(self, **kwargs):
                captured.update(kwargs)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def post(self, *args, **kwargs):
                return _FakeResp()

        monkeypatch.setattr(callback_module.httpx, "Client", _FakeClient)
        make_client().report_success()
        assert captured.get("trust_env") is False


class TestErrorReadability:
    @respx.mock
    def test_non_2xx_message_includes_envelope_message(self):
        respx.post(URL).mock(return_value=httpx.Response(401, json={
            "code": 401,
            "message": "Invalid or expired execution callback token",
            "data": None,
        }))
        with pytest.raises(httpx.HTTPStatusError) as excinfo:
            make_client().report_success()
        assert "Invalid or expired execution callback token" in str(excinfo.value)

    @respx.mock
    def test_non_2xx_with_validation_message_list(self):
        respx.post(URL).mock(return_value=httpx.Response(400, json={
            "code": 400,
            "message": ["executionId must be a UUID", "status must be one of the following values"],
            "data": None,
        }))
        with pytest.raises(httpx.HTTPStatusError) as excinfo:
            make_client().report_success()
        assert "executionId must be a UUID" in str(excinfo.value)

    @respx.mock
    def test_non_2xx_with_non_json_body_still_raises(self):
        respx.post(URL).mock(return_value=httpx.Response(502, text="Bad Gateway"))
        with pytest.raises(httpx.HTTPStatusError):
            make_client().report_success()
