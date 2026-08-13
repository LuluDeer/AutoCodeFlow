"""Tests for autoflow_sdk.models Pydantic models."""
from autoflow_sdk.models import TaskConfig, ExecuteRequest, ExecuteResult


class TestTaskConfig:
    def test_defaults(self):
        tc = TaskConfig()
        assert tc.runtime == "python"
        assert tc.timeout == 300
        assert tc.timeoutSeconds == 300
        assert tc.requirements == []
        assert tc.gitBranch == "main"
        assert tc.blockStrategy == "SERIAL"

    def test_custom_fields(self):
        tc = TaskConfig(id="t1", name="my-task", runtime="node", timeout=60)
        assert tc.id == "t1"
        assert tc.name == "my-task"
        assert tc.runtime == "node"
        assert tc.timeout == 60
        assert tc.timeoutSeconds == 60

    def test_extra_fields_allowed(self):
        tc = TaskConfig(unknown_field="value")
        assert tc.unknown_field == "value"

    def test_requirements_list(self):
        tc = TaskConfig(requirements=["requests", "pandas"])
        assert "requests" in tc.requirements

    def test_timeout_seconds_alias_sets_legacy_timeout(self):
        tc = TaskConfig(timeoutSeconds=60)
        assert tc.timeout == 60
        assert tc.timeoutSeconds == 60

    def test_snake_case_policy_fields_are_normalized(self):
        tc = TaskConfig(timeout_seconds=90, max_retry=4, retry_delay=15, timezone="Asia/Shanghai")
        assert tc.timeout == 90
        assert tc.timeoutSeconds == 90
        assert tc.maxRetry == 4
        assert tc.retryDelay == 15
        assert tc.timezone == "Asia/Shanghai"


class TestExecuteRequest:
    def test_required_fields(self):
        req = ExecuteRequest(executionId="exec-1", task=TaskConfig())
        assert req.executionId == "exec-1"
        assert isinstance(req.task, TaskConfig)

    def test_optional_params_default_none(self):
        req = ExecuteRequest(executionId="e", task=TaskConfig())
        assert req.params is None

    def test_with_params(self):
        req = ExecuteRequest(executionId="e", task=TaskConfig(), params={"date": "2024-01-01"})
        assert req.params["date"] == "2024-01-01"


class TestExecuteResult:
    def test_success_result(self):
        r = ExecuteResult(success=True, logs="done", exitCode=0)
        assert r.success is True
        assert r.logs == "done"
        assert r.exitCode == 0

    def test_failure_result(self):
        r = ExecuteResult(success=False, error="timeout", exitCode=1)
        assert r.success is False
        assert r.error == "timeout"

    def test_defaults(self):
        r = ExecuteResult(success=True)
        assert r.logs == ""
        assert r.exitCode == 0
        assert r.error is None
