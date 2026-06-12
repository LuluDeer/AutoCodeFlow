"""Tests for autoflow_sdk.context.TaskContext."""
import os
import pytest
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
