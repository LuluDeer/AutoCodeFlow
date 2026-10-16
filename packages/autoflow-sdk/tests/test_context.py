"""Tests for autoflow_sdk.context.TaskContext."""
import os
import pytest
from autoflow_sdk.callback import CallbackClient, CallbackDisabledError
from autoflow_sdk.context import TaskContext

# ADR-017 阶段 3 (protocol v6): the same 64-lowercase-hex shape the executor
# reports on register/heartbeat — sha256(deviceId + ":" + installSalt).
DEVICE_FP = "3f2a1c9d8b7e6f504132a5b6c7d8e9f00a1b2c3d4e5f60718293a4b5c6d7e8f9"


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


class TestFromEnvTypedParamsChannel:
    """A-11R: the typed `AUTOFLOW_PARAMS_JSON` channel (protocol v5).

    The per-key AUTOFLOW_<KEY> values are ALWAYS strings, so they cannot
    express the difference between the string "true" and the boolean True.
    Both executors therefore also inject the whole params object as one JSON
    document, and from_env() must prefer it.
    """

    def test_typed_channel_restores_real_types(self, monkeypatch):
        monkeypatch.setenv(
            "AUTOFLOW_PARAMS_JSON",
            '{"flag":true,"count":3,"ratio":1.5,"nothing":null,'
            '"tags":["a",2],"nested":{"b":true,"a":1},"text":"中文","empty":""}',
        )
        # The per-key copies are present too (that is how the real executor
        # behaves) and must NOT overwrite the properly typed values.
        monkeypatch.setenv("AUTOFLOW_FLAG", "true")
        monkeypatch.setenv("AUTOFLOW_COUNT", "3")
        monkeypatch.setenv("AUTOFLOW_TEXT", "中文")
        monkeypatch.setenv("AUTOFLOW_NESTED", '{"b":true,"a":1}')

        ctx = TaskContext.from_env()
        assert ctx.params["flag"] is True
        assert ctx.params["count"] == 3
        assert ctx.params["ratio"] == 1.5
        assert ctx.params["nothing"] is None
        assert ctx.params["tags"] == ["a", 2]
        assert ctx.params["nested"] == {"b": True, "a": 1}
        assert ctx.params["text"] == "中文"
        # An empty string is a real value, not an absent parameter.
        assert ctx.params["empty"] == ""

    def test_string_true_stays_a_string(self, monkeypatch):
        """The whole point of the channel: "true" != True."""
        monkeypatch.setenv("AUTOFLOW_PARAMS_JSON", '{"flag":"true"}')
        monkeypatch.setenv("AUTOFLOW_FLAG", "true")
        ctx = TaskContext.from_env()
        assert ctx.params["flag"] == "true"
        assert ctx.params["flag"] is not True

    def test_typed_channel_is_not_surfaced_as_a_param(self, monkeypatch):
        monkeypatch.setenv("AUTOFLOW_PARAMS_JSON", '{"a":1}')
        ctx = TaskContext.from_env()
        assert "params_json" not in ctx.params
        assert ctx.params == {"a": 1}

    def test_typed_channel_keys_are_lowercased(self, monkeypatch):
        monkeypatch.setenv("AUTOFLOW_PARAMS_JSON", '{"OrderId":"A-1"}')
        ctx = TaskContext.from_env()
        assert ctx.params["orderid"] == "A-1"

    def test_malformed_typed_channel_falls_back_without_raising(self, monkeypatch):
        # A broken payload must not make from_env() unusable — degrading to the
        # per-key channel only loses type fidelity.
        monkeypatch.setenv("AUTOFLOW_PARAMS_JSON", "{not json")
        monkeypatch.setenv("AUTOFLOW_DATE", "2024-06-01")
        ctx = TaskContext.from_env()
        assert ctx.params["date"] == "2024-06-01"

    def test_non_object_typed_channel_falls_back(self, monkeypatch):
        monkeypatch.setenv("AUTOFLOW_PARAMS_JSON", "[1,2]")
        monkeypatch.setenv("AUTOFLOW_DATE", "2024-06-01")
        ctx = TaskContext.from_env()
        assert ctx.params["date"] == "2024-06-01"


class TestFromEnvPerKeyFallback:
    """A-11R: behaviour on executors that predate the typed channel."""

    def test_bare_strings_stay_strings(self, monkeypatch):
        # v5 executors inject strings bare; a bare string is not JSON and must
        # not be mangled. "3" and dates are what the user *typed*, so they must
        # stay text — coercing them would change task behaviour (and would turn
        # "2024-06-01" into a failed parse / "3" into an int).
        monkeypatch.delenv("AUTOFLOW_PARAMS_JSON", raising=False)
        monkeypatch.setenv("AUTOFLOW_REGION", "欧盟")
        monkeypatch.setenv("AUTOFLOW_LIMIT", "3")
        monkeypatch.setenv("AUTOFLOW_DATE", "2024-06-01")
        ctx = TaskContext.from_env()
        assert ctx.params["region"] == "欧盟"
        assert ctx.params["limit"] == "3"
        assert ctx.params["date"] == "2024-06-01"

    def test_json_literals_are_coerced_on_the_fallback(self, monkeypatch):
        """`true`/`false`/`null` are the documented ambiguous case.

        On the fallback channel a bare `true` could be either the boolean True
        (executor rendered a real bool) or the four-character string a user
        typed. They are indistinguishable, so a choice is forced, and we
        coerce. Reason: leaving `false`/`null` as strings makes them TRUTHY —
        the same silent-failure class as A-11's `'""'` — whereas a user who
        genuinely needs the literal string has the typed channel on every v5
        executor. This is best-effort by construction; it is exactly why the
        typed channel exists.
        """
        monkeypatch.delenv("AUTOFLOW_PARAMS_JSON", raising=False)
        monkeypatch.setenv("AUTOFLOW_DRY", "true")
        monkeypatch.setenv("AUTOFLOW_OFF", "false")
        ctx = TaskContext.from_env()
        assert ctx.params["dry"] is True
        assert ctx.params["off"] is False

    def test_json_rendered_non_strings_are_recovered(self, monkeypatch):
        monkeypatch.delenv("AUTOFLOW_PARAMS_JSON", raising=False)
        monkeypatch.setenv("AUTOFLOW_DRY_RUN", "true")
        monkeypatch.setenv("AUTOFLOW_NOTHING", "null")
        monkeypatch.setenv("AUTOFLOW_TAGS", '["a",2]')
        monkeypatch.setenv("AUTOFLOW_NESTED", '{"b":true,"a":1}')
        monkeypatch.setenv("AUTOFLOW_RATIO", "1.5")
        monkeypatch.setenv("AUTOFLOW_TINY", "1e-7")
        ctx = TaskContext.from_env()
        assert ctx.params["dry_run"] is True
        assert ctx.params["nothing"] is None
        assert ctx.params["tags"] == ["a", 2]
        assert ctx.params["nested"] == {"b": True, "a": 1}
        assert ctx.params["ratio"] == 1.5
        assert ctx.params["tiny"] == 1e-7

    def test_recovers_a11_quoted_strings_from_old_executors(self, monkeypatch):
        """A-11 (< v5) injected strings JSON-quoted; recover them.

        This is the regression that silently stopped tasks for 12 days: the
        value carried a stray pair of quotes into business logic.
        """
        monkeypatch.delenv("AUTOFLOW_PARAMS_JSON", raising=False)
        monkeypatch.setenv("AUTOFLOW_REGION", '"欧盟"')
        monkeypatch.setenv("AUTOFLOW_LIMIT", '"3"')
        # A-11 rendered the empty string as '""', which is a TRUTHY value.
        monkeypatch.setenv("AUTOFLOW_MODE", '""')
        ctx = TaskContext.from_env()
        assert ctx.params["region"] == "欧盟"
        assert ctx.params["limit"] == "3"
        assert ctx.params["mode"] == ""


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

    def test_repr_never_leaks_callback_token(self):
        """N40 (round-10): print(ctx) / f-string debug logging must not carry
        the one-shot callback credential (or the routing fields) into the
        executor-captured stdout → admin execution logs chain — same threat
        surface as to_dict, pinned with repr=False on the three fields."""
        ctx = TaskContext(
            task_id="t", execution_id="e", task_name="T",
            callback_token="v1.secret", admin_api_url="http://admin", executor_address="a:1",
        )
        r = repr(ctx)
        assert "v1.secret" not in r
        assert "callback_token" not in r
        assert "http://admin" not in r
        assert "a:1" not in r
        # non-sensitive identity fields stay visible for debugging
        assert "task_id='t'" in r
        assert "execution_id='e'" in r
        # print()/str() share __repr__
        assert "v1.secret" not in str(ctx)
        # the fields themselves remain fully functional
        assert ctx.callback_token == "v1.secret"
        assert ctx.admin_api_url == "http://admin"
        assert ctx.executor_address == "a:1"
        assert ctx.callback.enabled is True


class TestFromEnvCallbackCredentials:
    """R9 (round-9): the three callback credential vars are exposed as
    dedicated fields and EXCLUDED from params."""

    def test_credentials_read_into_fields(self, monkeypatch):
        monkeypatch.setenv("AUTOFLOW_CALLBACK_TOKEN", "v1.exec.expsig")
        monkeypatch.setenv("AUTOFLOW_ADMIN_API_URL", "http://admin:3105")
        monkeypatch.setenv("AUTOFLOW_EXECUTOR_ADDRESS", "executor-py:8001")
        monkeypatch.setenv("AUTOFLOW_DEVICE_FINGERPRINT", DEVICE_FP)
        ctx = TaskContext.from_env()
        assert ctx.callback_token == "v1.exec.expsig"
        assert ctx.admin_api_url == "http://admin:3105"
        assert ctx.executor_address == "executor-py:8001"
        assert ctx.device_fingerprint == DEVICE_FP

    def test_credentials_excluded_from_params(self, monkeypatch):
        monkeypatch.setenv("AUTOFLOW_CALLBACK_TOKEN", "v1.exec.expsig")
        monkeypatch.setenv("AUTOFLOW_ADMIN_API_URL", "http://admin:3105")
        monkeypatch.setenv("AUTOFLOW_EXECUTOR_ADDRESS", "executor-py:8001")
        monkeypatch.setenv("AUTOFLOW_DEVICE_FINGERPRINT", DEVICE_FP)
        monkeypatch.setenv("AUTOFLOW_DATE", "2026-09-03")
        ctx = TaskContext.from_env()
        assert ctx.params == {"date": "2026-09-03"}
        for key in (
            "callback_token",
            "admin_api_url",
            "executor_address",
            "device_fingerprint",
        ):
            assert key not in ctx.params

    def test_partial_credentials_still_excluded(self, monkeypatch):
        monkeypatch.setenv("AUTOFLOW_CALLBACK_TOKEN", "v1.only")
        monkeypatch.delenv("AUTOFLOW_ADMIN_API_URL", raising=False)
        monkeypatch.delenv("AUTOFLOW_EXECUTOR_ADDRESS", raising=False)
        monkeypatch.delenv("AUTOFLOW_DEVICE_FINGERPRINT", raising=False)
        ctx = TaskContext.from_env()
        assert ctx.callback_token == "v1.only"
        assert ctx.admin_api_url is None
        assert ctx.executor_address is None
        assert ctx.device_fingerprint is None
        assert "callback_token" not in ctx.params

    def test_absent_credentials_leave_fields_none(self, monkeypatch):
        for key in (
            "AUTOFLOW_CALLBACK_TOKEN",
            "AUTOFLOW_ADMIN_API_URL",
            "AUTOFLOW_EXECUTOR_ADDRESS",
            "AUTOFLOW_DEVICE_FINGERPRINT",
        ):
            monkeypatch.delenv(key, raising=False)
        ctx = TaskContext.from_env()
        assert ctx.callback_token is None
        assert ctx.admin_api_url is None
        assert ctx.executor_address is None
        assert ctx.device_fingerprint is None
        assert ctx.callback.enabled is False


class TestCallbackProperty:
    def _ctx(self):
        return TaskContext(
            task_id="t", execution_id="exec-1", task_name="T",
            callback_token="v1.tok", admin_api_url="http://admin:3105",
            executor_address="exec:8001",
            device_fingerprint=DEVICE_FP,
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
        # ADR-017 阶段 3: the fingerprint must reach the client — that is the
        # only path by which it can be stamped onto callback items.
        assert ctx.callback.device_fingerprint == DEVICE_FP

    def test_callback_client_gets_no_fingerprint_when_ctx_has_none(self):
        ctx = TaskContext(
            task_id="t", execution_id="exec-1", task_name="T",
            callback_token="v1.tok", admin_api_url="http://admin:3105",
        )
        assert ctx.callback.device_fingerprint == ""

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
