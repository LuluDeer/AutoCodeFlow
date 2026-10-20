"""R134-A1 错误处理 / 资源生命周期审计（autocodeflow-db）的红灯用例。

审计对象：packages/autocodeflow-db/autocodeflow_db/connection.py
- 轴 1：DatabaseSession.session() 在异常路径上若 rollback/close 自身失败，
  会用一个次生异常替换掉原始异常（调用方拿到的是 "rollback failed" 而不是
  真正的业务/SQL 错误，排障信息丢失）。
- 轴 2：DatabaseConfig.build() 是 check-then-set，无锁。并发首次调用会
  创建两个 engine，其中一个永不 dispose（连接池泄漏），并且存在
  "_engine 已赋值但 _session_factory 仍是 None" 的可见窗口。
"""
from __future__ import annotations

import logging
import sys
import threading
import time
import types
from unittest.mock import MagicMock, patch

import pytest

from autocodeflow_db import DatabaseConfig, DatabaseSession
from autocodeflow_db import connection as conn_mod


def _patched_config(session_obj):
    """Build a DatabaseSession whose factory returns session_obj."""
    with patch("autocodeflow_db.connection.create_engine") as ce, \
         patch("autocodeflow_db.connection.sessionmaker") as sm:
        ce.return_value = MagicMock()
        sm.return_value = MagicMock(return_value=session_obj)
        return DatabaseSession(DatabaseConfig())


class TestRollbackFailureDoesNotMaskOriginalError:
    """轴 1：次生异常（rollback 失败）不得掩盖原始异常。"""

    def test_rollback_failure_preserves_original_exception(self, caplog):
        mock_sess = MagicMock()
        mock_sess.rollback.side_effect = RuntimeError("rollback failed: connection invalidated")
        db = _patched_config(mock_sess)

        with caplog.at_level(logging.ERROR, logger="autocodeflow_db.connection"):
            with pytest.raises(ValueError, match="business error") as excinfo:
                with db.session():
                    raise ValueError("business error")

        # 原始异常才是最终抛出的异常（修前：rollback 的 RuntimeError 顶上来）
        assert isinstance(excinfo.value, ValueError)
        # 且次生异常没有被静默丢弃——落日志
        assert any("rollback" in r.getMessage().lower() for r in caplog.records), (
            "a failing rollback must be logged, not swallowed"
        )
        mock_sess.close.assert_called_once()

    def test_rollback_failure_preserves_original_error_from_commit(self):
        mock_sess = MagicMock()
        mock_sess.commit.side_effect = RuntimeError("commit blew up")
        mock_sess.rollback.side_effect = RuntimeError("rollback also failed")
        db = _patched_config(mock_sess)

        with pytest.raises(RuntimeError, match="commit blew up"):
            with db.session():
                pass
        mock_sess.rollback.assert_called_once()
        mock_sess.close.assert_called_once()

    def test_close_failure_on_success_path_still_surfaces(self):
        """回归护栏：成功路径上 close 失败不隐瞒（仍然抛给调用方）。"""
        mock_sess = MagicMock()
        mock_sess.close.side_effect = RuntimeError("close failed")
        db = _patched_config(mock_sess)

        with pytest.raises(RuntimeError, match="close failed"):
            with db.session():
                pass


class TestBuildIsThreadSafe:
    """轴 2：并发首次 build 只允许创建一个 engine（不泄漏连接池）。"""

    def test_concurrent_build_creates_exactly_one_engine(self, monkeypatch):
        created = []

        def slow_create_engine(*args, **kwargs):
            created.append(1)
            time.sleep(0.05)  # 放大 check-then-set 的竞态窗口
            return MagicMock()

        monkeypatch.setattr(conn_mod, "create_engine", slow_create_engine)
        monkeypatch.setattr(conn_mod, "sessionmaker", lambda **kwargs: MagicMock())

        cfg = DatabaseConfig()
        barrier = threading.Barrier(2)
        errors: list[BaseException] = []

        def worker():
            barrier.wait()
            try:
                cfg.build()
            except BaseException as exc:  # pragma: no cover - 竞态失败时才走到
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        assert not errors, f"build() raised under concurrency: {errors}"
        assert len(created) == 1, (
            f"build() created {len(created)} engines under concurrency; "
            "the losers are never disposed (pool leak)"
        )

    def test_build_never_exposes_half_initialised_pair(self, monkeypatch):
        """_engine 已赋值但 _session_factory 仍为 None 的可见窗口必须不存在。

        另一个线程在"engine 建好、factory 还没赋值"的窗口里调 build() 时，
        修前会拿到 (engine, None)，随后 session() 里 self._factory() 直接
        TypeError: 'NoneType' object is not callable。
        """
        cfg = DatabaseConfig()
        results: list[tuple] = []
        spawned: list[threading.Thread] = []

        def sessionmaker_stub(**kwargs):
            # 此刻 self._engine 已经被赋值，_session_factory 还没有
            t = threading.Thread(target=lambda: results.append(cfg.build()))
            spawned.append(t)
            t.start()
            return MagicMock()

        monkeypatch.setattr(conn_mod, "create_engine", lambda *a, **kw: MagicMock())
        monkeypatch.setattr(conn_mod, "sessionmaker", sessionmaker_stub)

        engine, factory = cfg.build()
        for t in spawned:
            t.join(timeout=10)

        assert results, "the racing build() never completed"
        racy_engine, racy_factory = results[0]
        assert racy_factory is not None, (
            "another thread observed _engine set while _session_factory was still "
            "None — DatabaseSession would crash with TypeError"
        )
        racy_factory()  # 修前：None 不可调用
