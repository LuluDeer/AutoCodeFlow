"""Unit tests for autocodeflow-db connection helpers."""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch, call

from autocodeflow_db import (
    DatabaseConfig,
    DatabaseSession,
    dispose_engine,
    get_session,
)
from autocodeflow_db.connection import (
    DATABASE_URL_ENV,
    DEFAULT_POOL_RECYCLE_SECONDS,
    _default_config,
)


class TestDatabaseConfig:
    def test_defaults(self):
        cfg = DatabaseConfig()
        assert "postgresql" in cfg.url
        assert cfg.pool_size == 5
        assert cfg.pool_overflow == 10
        assert cfg.echo is False

    def test_custom_url(self):
        cfg = DatabaseConfig(url="postgresql://user:pass@host:5432/mydb")
        assert cfg.url == "postgresql://user:pass@host:5432/mydb"

    @patch("autocodeflow_db.connection.create_engine")
    @patch("autocodeflow_db.connection.sessionmaker")
    def test_build_creates_engine_once(self, mock_sessionmaker, mock_create_engine):
        mock_engine = MagicMock()
        mock_create_engine.return_value = mock_engine
        mock_factory = MagicMock()
        mock_sessionmaker.return_value = mock_factory

        cfg = DatabaseConfig()
        engine1, factory1 = cfg.build()
        engine2, factory2 = cfg.build()  # should reuse

        assert mock_create_engine.call_count == 1
        assert engine1 is engine2
        assert factory1 is factory2

    @patch("autocodeflow_db.connection.create_engine")
    @patch("autocodeflow_db.connection.sessionmaker")
    def test_build_passes_correct_args(self, mock_sessionmaker, mock_create_engine):
        mock_create_engine.return_value = MagicMock()
        mock_sessionmaker.return_value = MagicMock()

        cfg = DatabaseConfig(pool_size=10, pool_overflow=20, echo=True)
        cfg.build()

        mock_create_engine.assert_called_once_with(
            cfg.url,
            pool_size=10,
            max_overflow=20,
            echo=True,
            # PK-08: connection-hygiene kwargs must ride every engine.
            pool_pre_ping=True,
            pool_recycle=DEFAULT_POOL_RECYCLE_SECONDS,
        )


class TestDatabaseSession:
    @patch("autocodeflow_db.connection.create_engine")
    @patch("autocodeflow_db.connection.sessionmaker")
    def test_session_commits_on_success(self, mock_sessionmaker, mock_create_engine):
        mock_create_engine.return_value = MagicMock()
        mock_sess = MagicMock()
        mock_factory = MagicMock(return_value=mock_sess)
        mock_sessionmaker.return_value = mock_factory

        cfg = DatabaseConfig()
        db = DatabaseSession(cfg)
        with db.session() as sess:
            assert sess is mock_sess

        mock_sess.commit.assert_called_once()
        mock_sess.close.assert_called_once()
        mock_sess.rollback.assert_not_called()

    @patch("autocodeflow_db.connection.create_engine")
    @patch("autocodeflow_db.connection.sessionmaker")
    def test_session_rolls_back_on_exception(self, mock_sessionmaker, mock_create_engine):
        mock_create_engine.return_value = MagicMock()
        mock_sess = MagicMock()
        mock_factory = MagicMock(return_value=mock_sess)
        mock_sessionmaker.return_value = mock_factory

        cfg = DatabaseConfig()
        db = DatabaseSession(cfg)
        with pytest.raises(ValueError):
            with db.session():
                raise ValueError("query failed")

        mock_sess.rollback.assert_called_once()
        mock_sess.close.assert_called_once()
        mock_sess.commit.assert_not_called()


class TestGetSession:
    @patch("autocodeflow_db.connection.create_engine")
    @patch("autocodeflow_db.connection.sessionmaker")
    def test_get_session_returns_database_session(self, mock_sessionmaker, mock_create_engine):
        mock_create_engine.return_value = MagicMock()
        mock_sessionmaker.return_value = MagicMock()

        session_obj = get_session()
        assert isinstance(session_obj, DatabaseSession)

    @patch("autocodeflow_db.connection.create_engine")
    @patch("autocodeflow_db.connection.sessionmaker")
    def test_get_session_accepts_custom_config(self, mock_sessionmaker, mock_create_engine):
        mock_create_engine.return_value = MagicMock()
        mock_sessionmaker.return_value = MagicMock()

        cfg = DatabaseConfig(url="postgresql://custom:pw@db/test")
        session_obj = get_session(cfg)
        assert isinstance(session_obj, DatabaseSession)
        mock_create_engine.assert_called_once_with(
            "postgresql://custom:pw@db/test",
            pool_size=5,
            max_overflow=10,
            echo=False,
            pool_pre_ping=True,
            pool_recycle=DEFAULT_POOL_RECYCLE_SECONDS,
        )


class TestFromEnv:
    """PK-08: DATABASE_URL 注入必须真实兑现（此前仅文档虚构）。"""

    def test_from_env_reads_database_url(self, monkeypatch):
        monkeypatch.setenv(
            DATABASE_URL_ENV, "postgresql://envuser:envpw@envhost:6543/envdb"
        )
        cfg = DatabaseConfig.from_env()
        assert cfg.url == "postgresql://envuser:envpw@envhost:6543/envdb"

    def test_from_env_falls_back_to_default_when_unset(self, monkeypatch):
        monkeypatch.delenv(DATABASE_URL_ENV, raising=False)
        cfg = DatabaseConfig.from_env()
        assert cfg.url == DatabaseConfig().url
        # 无默认凭据约定不因 env 回落而破坏
        assert "envuser" not in cfg.url

    def test_from_env_ignores_blank_value(self, monkeypatch):
        monkeypatch.setenv(DATABASE_URL_ENV, "   ")
        cfg = DatabaseConfig.from_env()
        assert cfg.url == DatabaseConfig().url

    @patch("autocodeflow_db.connection.create_engine")
    @patch("autocodeflow_db.connection.sessionmaker")
    def test_get_session_without_config_honours_env(
        self, mock_sessionmaker, mock_create_engine, monkeypatch
    ):
        mock_create_engine.return_value = MagicMock()
        mock_sessionmaker.return_value = MagicMock()
        monkeypatch.setenv(
            DATABASE_URL_ENV, "postgresql://envuser:envpw@envhost:6543/envdb"
        )
        # 重置模块级默认配置，隔离其它用例残留
        dispose_engine()

        session_obj = get_session()
        assert isinstance(session_obj, DatabaseSession)
        mock_create_engine.assert_called_once_with(
            "postgresql://envuser:envpw@envhost:6543/envdb",
            pool_size=5,
            max_overflow=10,
            echo=False,
            pool_pre_ping=True,
            pool_recycle=DEFAULT_POOL_RECYCLE_SECONDS,
        )
        # 清理模块级单例，避免影响后续用例
        dispose_engine()

    @patch("autocodeflow_db.connection.create_engine")
    @patch("autocodeflow_db.connection.sessionmaker")
    def test_get_session_explicit_config_beats_env(
        self, mock_sessionmaker, mock_create_engine, monkeypatch
    ):
        mock_create_engine.return_value = MagicMock()
        mock_sessionmaker.return_value = MagicMock()
        monkeypatch.setenv(
            DATABASE_URL_ENV, "postgresql://envuser:envpw@envhost:6543/envdb"
        )
        dispose_engine()

        cfg = DatabaseConfig(url="postgresql://explicit@db/one")
        get_session(cfg)
        called_url = mock_create_engine.call_args[0][0]
        assert called_url == "postgresql://explicit@db/one"
        dispose_engine()


class TestDisposeEngine:
    """PK-08: engine 必须有显式关闭出口（进程退出前释放连接池）。"""

    @patch("autocodeflow_db.connection.create_engine")
    @patch("autocodeflow_db.connection.sessionmaker")
    def test_dispose_default_engine_and_reset(self, mock_sessionmaker, mock_create_engine):
        mock_engine = MagicMock()
        mock_create_engine.return_value = mock_engine
        mock_sessionmaker.return_value = MagicMock()
        dispose_engine()  # ensure clean slate

        get_session()  # builds the module-default engine
        assert mock_create_engine.call_count == 1

        dispose_engine()
        mock_engine.dispose.assert_called_once()

        # reset 后再次 get_session 会重建 engine（读当前环境）
        get_session()
        assert mock_create_engine.call_count == 2
        dispose_engine()

    @patch("autocodeflow_db.connection.create_engine")
    @patch("autocodeflow_db.connection.sessionmaker")
    def test_dispose_specific_config_only(self, mock_sessionmaker, mock_create_engine):
        engine_a, engine_b = MagicMock(), MagicMock()
        mock_create_engine.side_effect = [engine_a, engine_b]
        mock_sessionmaker.return_value = MagicMock()
        dispose_engine()

        cfg_a = DatabaseConfig(url="postgresql://a@db/one")
        cfg_b = DatabaseConfig(url="postgresql://b@db/two")
        get_session(cfg_a)
        get_session(cfg_b)

        dispose_engine(cfg_a)
        engine_a.dispose.assert_called_once()
        engine_b.dispose.assert_not_called()
        # 显式 config 的 dispose 不触碰模块级默认单例
        assert _default_config() is not None
        dispose_engine()

    @patch("autocodeflow_db.connection.create_engine")
    @patch("autocodeflow_db.connection.sessionmaker")
    def test_config_rebuilds_engine_after_dispose(
        self, mock_sessionmaker, mock_create_engine
    ):
        mock_create_engine.return_value = MagicMock()
        mock_sessionmaker.return_value = MagicMock()

        cfg = DatabaseConfig()
        cfg.build()
        cfg.dispose()
        cfg.build()

        assert mock_create_engine.call_count == 2
        dispose_engine(cfg)
