"""Tests for autoflow_sdk.context.TaskContext."""
import os
import pytest
from autoflow_sdk.callback import CallbackClient, CallbackDisabledError
from autoflow_sdk.context import TaskContext


class TestTaskContextConstructor:
    def test_required_fields(self):
        ctx = TaskContext(task_id="t1", execution_id="e1", task_name="My Task")
        assert ctx.task_id == "t1"
        assert ctx.execution_id == "e1"
        assert ctx.task_name == "My Task"

    def test_default_params_empty(self):
        ctx = TaskContext(task_id="t1", execution_id="e1", task_name="T")
        assert ctx.params == {}

    def test_default_env_empty(self):
        ctx = TaskContext(task_id="t1", execution_id="e1", task_name="T")
        assert ctx.env == {}

    def test_custom_params(self):
        ctx = TaskContext(task_id="t1", execution_id="e1", task_name="T", params={"date": "2024-01-01"})
        assert ctx.params["date"] == "2024-01-01"


class TestGetParam:
    def test_returns_value_when_present(self):
        ctx = TaskContext(task_id="t", execution_id="e", task_name="T", params={"k": "v"})
        assert ctx.get_param("k") == "v"

    def test_returns_default_when_missing(self):
        ctx = TaskContext(task_id="t", execution_id="e", task_name="T")
        assert ctx.get_param("missing") is None
        assert ctx.get_param("missing", "fallback") == "fallback"

    def test_returns_none_for_absent_key_no_default(self):
        ctx = TaskContext(task_id="t", execution_id="e", task_name="T")
        assert ctx.get_param("x") is None


class TestGetEnv:
    def test_prefers_task_env_over_os_env(self, monkeypatch):
        monkeypatch.setenv("MY_VAR", "os_value")
        ctx = TaskContext(task_id="t", execution_id="e", task_name="T", env={"MY_VAR": "task_value"})
        assert ctx.get_env("MY_VAR") == "task_value"

    def test_falls_back_to_os_env(self, monkeypatch):
        monkeypatch.setenv("OS_ONLY", "from_os")
        ctx = TaskContext(task_id="t", execution_id="e", task_name="T")
        assert ctx.get_env("OS_ONLY") == "from_os"

    def test_returns_default_when_not_found(self, monkeypatch):
        monkeypatch.delenv("TOTALLY_ABSENT", raising=False)
        ctx = TaskContext(task_id="t", execution_id="e", task_name="T")
        assert ctx.get_env("TOTALLY_ABSENT", "default") == "default"

    def test_returns_empty_string_by_default(self, monkeypatch):
        monkeypatch.delenv("TOTALLY_ABSENT", raising=False)
        ctx = TaskContext(task_id="t", execution_id="e", task_name="T")
        assert ctx.get_env("TOTALLY_ABSENT") == ""


class TestLogProperty:
    def test_log_is_lazy_and_available(self):
        ctx = TaskContext(task_id="t", execution_id="e", task_name="T")
        log = ctx.log
        assert log is not None
        assert callable(log.info)

    def test_log_returns_same_instance(self):
        ctx = TaskContext(task_id="t", execution_id="e", task_name="T")
        assert ctx.log is ctx.log


class TestFromEnv:
    ORIGINAL = None

    def test_reads_standard_vars(self, monkeypatch):
        monkeypatch.setenv("EXECUTION_ID", "exec-env")
        monkeypatch.setenv("TASK_ID", "task-env")
        monkeypatch.setenv("TASK_NAME", "Env Task")
        ctx = TaskContext.from_env()
        assert ctx.execution_id == "exec-env"
        assert ctx.task_id == "task-env"
        assert ctx.task_name == "Env Task"

    def test_maps_autoflow_vars_to_params(self, monkeypatch):
        monkeypatch.setenv("AUTOFLOW_DATE", "2024-06-01")
        monkeypatch.setenv("AUTOFLOW_OUTPUT_PATH", "/data/out")
        ctx = TaskContext.from_env()
        assert ctx.params["date"] == "2024-06-01"
        assert ctx.params["output_path"] == "/data/out"

    def test_falls_back_to_unknown_when_vars_absent(self, monkeypatch):
        monkeypatch.delenv("EXECUTION_ID", raising=False)
        monkeypatch.delenv("TASK_ID", raising=False)
        monkeypatch.delenv("TASK_NAME", raising=False)
        ctx = TaskContext.from_env()
        assert ctx.execution_id == "unknown"
        assert ctx.task_id == "unknown"
        assert ctx.task_name == "unknown"

    def test_ignores_empty_autoflow_vars(self, monkeypatch):
        monkeypatch.setenv("AUTOFLOW_EMPTY", "")
        ctx = TaskContext.from_env()
        assert "empty" not in ctx.params


class TestToDict:
    def test_to_dict_contains_expected_keys(self):
        ctx = TaskContext(task_id="t", execution_id="e", task_name="T", params={"k": "v"})
        d = ctx.to_dict()
        assert d["task_id"] == "t"
        assert d["execution_id"] == "e"
        assert d["task_name"] == "T"
        assert d["params"] == {"k": "v"}

    def test_to_dict_excludes_private_fields(self):
        ctx = TaskContext(task_id="t", execution_id="e", task_name="T")
        d = ctx.to_dict()
        assert "_logger" not in d

    def test_to_dict_never_leaks_callback_token(self):
        """The one-shot callback credential must not ride into serialized params."""
        ctx = TaskContext(
            task_id="t", execution_id="e", task_name="T",
            callback_token="v1.secret", admin_api_url="http://admin", executor_address="a:1",
        )
        d = ctx.to_dict()
        assert "callback_token" not in str(d)
        assert "v1.secret" not in str(d)


class TestFromEnvCallbackCredentials:
    """R9 (round-9): the three callback credential vars are exposed as
    dedicated fields and EXCLUDED from params."""

    def test_credentials_read_into_fields(self, monkeypatch):
        monkeypatch.setenv("AUTOFLOW_CALLBACK_TOKEN", "v1.exec.expsig")
        monkeypatch.setenv("AUTOFLOW_ADMIN_API_URL", "http://admin:3105")
        monkeypatch.setenv("AUTOFLOW_EXECUTOR_ADDRESS", "executor-py:8001")
        ctx = TaskContext.from_env()
        assert ctx.callback_token == "v1.exec.expsig"
        assert ctx.admin_api_url == "http://admin:3105"
        assert ctx.executor_address == "executor-py:8001"

    def test_credentials_excluded_from_params(self, monkeypatch):
        monkeypatch.setenv("AUTOFLOW_CALLBACK_TOKEN", "v1.exec.expsig")
        monkeypatch.setenv("AUTOFLOW_ADMIN_API_URL", "http://admin:3105")
        monkeypatch.setenv("AUTOFLOW_EXECUTOR_ADDRESS", "executor-py:8001")
        monkeypatch.setenv("AUTOFLOW_DATE", "2026-09-03")
        ctx = TaskContext.from_env()
        assert ctx.params == {"date": "2026-09-03"}
        for key in ("callback_token", "admin_api_url", "executor_address"):
            assert key not in ctx.params

    def test_partial_credentials_still_excluded(self, monkeypatch):
        monkeypatch.setenv("AUTOFLOW_CALLBACK_TOKEN", "v1.only")
        monkeypatch.delenv("AUTOFLOW_ADMIN_API_URL", raising=False)
        monkeypatch.delenv("AUTOFLOW_EXECUTOR_ADDRESS", raising=False)
        ctx = TaskContext.from_env()
        assert ctx.callback_token == "v1.only"
        assert ctx.admin_api_url is None
        assert ctx.executor_address is None
        assert "callback_token" not in ctx.params

    def test_absent_credentials_leave_fields_none(self, monkeypatch):
        for key in ("AUTOFLOW_CALLBACK_TOKEN", "AUTOFLOW_ADMIN_API_URL", "AUTOFLOW_EXECUTOR_ADDRESS"):
            monkeypatch.delenv(key, raising=False)
        ctx = TaskContext.from_env()
        assert ctx.callback_token is None
        assert ctx.admin_api_url is None
        assert ctx.executor_address is None
        assert ctx.callback.enabled is False


class TestCallbackProperty:
    def _ctx(self):
        return TaskContext(
            task_id="t", execution_id="exec-1", task_name="T",
            callback_token="v1.tok", admin_api_url="http://admin:3105",
            executor_address="exec:8001",
        )

    def test_callback_is_lazy_singleton(self):
        ctx = self._ctx()
        client = ctx.callback
        assert isinstance(client, CallbackClient)
        assert client.enabled is True
        assert ctx.callback is client

    def test_callback_client_bound_to_execution(self):
        ctx = self._ctx()
        assert ctx.callback.execution_id == "exec-1"
        assert ctx.callback.executor_address == "exec:8001"

    def test_report_success_delegates_to_client(self):
        ctx = TaskContext(task_id="t", execution_id="e", task_name="T")
        calls = []

        class Fake:
            def report_success(self, summary=None, duration_ms=None):
                calls.append(("success", summary, duration_ms))
                return {"ok": True}

            def report_failure(self, error, summary=None, duration_ms=None, failure_reason="script_error"):
                calls.append(("failure", str(error), summary, failure_reason))
                return {"ok": True}

        ctx._callback_client = Fake()
        assert ctx.report_success(summary="done", duration_ms=5) == {"ok": True}
        assert ctx.report_failure(RuntimeError("boom"), failure_reason="timeout") == {"ok": True}
        assert calls == [
            ("success", "done", 5),
            ("failure", "boom", None, "timeout"),
        ]

    def test_report_raises_when_disabled(self):
        ctx = TaskContext(task_id="t", execution_id="e", task_name="T")
        with pytest.raises(CallbackDisabledError) as exc:
            ctx.report_success()
        assert "AUTOFLOW_CALLBACK_TOKEN" in str(exc.value)
        with pytest.raises(CallbackDisabledError):
            ctx.report_failure("boom")
