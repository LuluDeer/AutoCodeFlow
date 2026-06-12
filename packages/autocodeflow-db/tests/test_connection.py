"""Unit tests for autocodeflow-db connection helpers."""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch, call

from autocodeflow_db import DatabaseConfig, DatabaseSession, get_session


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
        )
