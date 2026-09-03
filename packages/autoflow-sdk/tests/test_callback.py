"""Tests for autoflow_sdk.callback.CallbackClient (R9, round-9)."""
import json

import httpx
import pytest
import respx

from autoflow_sdk.callback import CallbackClient, CallbackDisabledError

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

    @pytest.mark.parametrize("missing", ["admin_api_url", "token", "executor_address"])
    def test_disabled_when_any_credential_absent(self, missing):
        client = make_client(**{missing: None})
        assert client.enabled is False
        env_name = {
            "admin_api_url": "AUTOFLOW_ADMIN_API_URL",
            "token": "AUTOFLOW_CALLBACK_TOKEN",
            "executor_address": "AUTOFLOW_EXECUTOR_ADDRESS",
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
