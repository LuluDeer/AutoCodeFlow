"""Tests for autoflow_sdk.result.TaskResult."""
import pytest
from autoflow_sdk.result import TaskResult


class TestTaskResultOk:
    def test_ok_sets_success_true(self):
        r = TaskResult.ok()
        assert r.success is True

    def test_ok_default_message(self):
        r = TaskResult.ok()
        assert r.message == "OK"

    def test_ok_custom_message(self):
        r = TaskResult.ok(message="done")
        assert r.message == "done"

    def test_ok_with_data(self):
        r = TaskResult.ok(data={"rows": 5})
        assert r.data == {"rows": 5}

    def test_ok_exit_code_zero(self):
        r = TaskResult.ok()
        assert r.exit_code == 0

    def test_ok_error_is_none(self):
        r = TaskResult.ok()
        assert r.error is None


class TestTaskResultFail:
    def test_fail_sets_success_false(self):
        r = TaskResult.fail("something went wrong")
        assert r.success is False

    def test_fail_stores_error(self):
        r = TaskResult.fail("timeout")
        assert r.error == "timeout"

    def test_fail_default_exit_code_one(self):
        r = TaskResult.fail("err")
        assert r.exit_code == 1

    def test_fail_custom_exit_code(self):
        r = TaskResult.fail("err", exit_code=2)
        assert r.exit_code == 2


class TestTaskResultToDict:
    def test_to_dict_all_keys(self):
        r = TaskResult.ok(message="m", data={"x": 1})
        d = r.to_dict()
        assert d["success"] is True
        assert d["message"] == "m"
        assert d["data"] == {"x": 1}
        assert d["error"] is None
        assert d["exit_code"] == 0

    def test_fail_to_dict(self):
        r = TaskResult.fail("boom", exit_code=3)
        d = r.to_dict()
        assert d["success"] is False
        assert d["error"] == "boom"
        assert d["exit_code"] == 3
