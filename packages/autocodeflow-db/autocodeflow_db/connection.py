"""Database connection helpers for AutoCodeFlow tasks.

Provides a simple SQLAlchemy session factory that task code can use
to interact with databases in a structured way.

PK-08 (DEEP_REVIEW 0ef3bbe): the long-documented ``DATABASE_URL``
environment injection is now actually implemented —
``DatabaseConfig.from_env()`` reads ``DATABASE_URL`` and
``get_session()`` falls back to it when no explicit config is passed
("from config (or environment defaults)" is no longer aspirational).
Engines are created with ``pool_pre_ping``/``pool_recycle`` so long
tasks do not grab server-closed idle connections, and ``dispose_engine()``
gives task code an explicit shutdown hook before process exit.

Note: this library is for tasks talking to *their own* business
database. Pointing ``DATABASE_URL`` at the platform database would
bypass all admin-api RBAC/audit — don't.
"""
from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Generator, Optional

from sqlalchemy import create_engine, Engine
from sqlalchemy.orm import Session, sessionmaker

logger = logging.getLogger(__name__)

#: PK-08: connections idle longer than this are recycled proactively
#: (server-side idle timeouts would otherwise hand back dead connections).
DEFAULT_POOL_RECYCLE_SECONDS = 1800

#: PK-08: env var read by :meth:`DatabaseConfig.from_env`.
DATABASE_URL_ENV = "DATABASE_URL"


@dataclass
class DatabaseConfig:
    """Database connection configuration."""
    url: str = "postgresql://localhost:5432/autocodeflow"  # no default credentials; supply via DATABASE_URL env or DatabaseConfig.from_env()
    pool_size: int = 5
    pool_overflow: int = 10
    echo: bool = False
    pool_recycle: int = DEFAULT_POOL_RECYCLE_SECONDS

    _engine: Optional[Engine] = field(default=None, init=False, repr=False)
    _session_factory: Optional[sessionmaker] = field(default=None, init=False, repr=False)

    @classmethod
    def from_env(cls) -> "DatabaseConfig":
        """Build a config from the ``DATABASE_URL`` environment variable.

        PK-08: this fulfils the "from environment" promise previously only
        made by docs. When the env var is unset/empty the local default URL
        is kept — deliberately without any built-in credentials, so a missing
        ``DATABASE_URL`` fails fast at connect time instead of silently
        authenticating against a guessed account.
        """
        url = (os.environ.get(DATABASE_URL_ENV) or "").strip()
        if url:
            return cls(url=url)
        return cls()

    def build(self) -> tuple[Engine, sessionmaker]:
        if self._engine is None:
            self._engine = create_engine(
                self.url,
                pool_size=self.pool_size,
                max_overflow=self.pool_overflow,
                echo=self.echo,
                # PK-08: keep long-lived task connections healthy.
                pool_pre_ping=True,
                pool_recycle=self.pool_recycle,
            )
            self._session_factory = sessionmaker(bind=self._engine)
        return self._engine, self._session_factory  # type: ignore[return-value]

    def dispose(self) -> None:
        """Close all pooled connections; a later :meth:`build` recreates them."""
        if self._engine is not None:
            self._engine.dispose()
            self._engine = None
            self._session_factory = None


class DatabaseSession:
    """Wrapper around SQLAlchemy session for task code."""

    def __init__(self, config: DatabaseConfig):
        _, self._factory = config.build()

    @contextmanager
    def session(self) -> Generator[Session, None, None]:
        sess = self._factory()
        try:
            yield sess
            sess.commit()
        except Exception:
            sess.rollback()
            raise
        finally:
            sess.close()


#: PK-08: lazily-built default config backing ``get_session()`` without
#: arguments (kept alive so repeated calls reuse one engine/pool).
_DEFAULT_CONFIG: Optional[DatabaseConfig] = None


def _default_config() -> DatabaseConfig:
    global _DEFAULT_CONFIG
    if _DEFAULT_CONFIG is None:
        _DEFAULT_CONFIG = DatabaseConfig.from_env()
    return _DEFAULT_CONFIG


def get_session(config: Optional[DatabaseConfig] = None) -> DatabaseSession:
    """Create a database session from config (or environment defaults).

    When ``config`` is omitted the ``DATABASE_URL`` environment variable is
    honoured via :meth:`DatabaseConfig.from_env`; with the env var unset the
    credential-less local default applies. The default config is cached at
    module level so repeated env-driven calls share one engine.
    """
    cfg = config if config is not None else _default_config()
    return DatabaseSession(cfg)


def dispose_engine(config: Optional[DatabaseConfig] = None) -> None:
    """Dispose an engine and release its pooled connections.

    Call before task process exit so connections are not left for the
    server to reap. With ``config=None`` the module-level default config
    (used by ``get_session()`` without arguments) is disposed and reset —
    the next env-driven ``get_session()`` builds a fresh engine from the
    then-current environment. Passing an explicit config disposes exactly
    that config's engine.
    """
    global _DEFAULT_CONFIG
    if config is not None:
        config.dispose()
        return
    if _DEFAULT_CONFIG is not None:
        _DEFAULT_CONFIG.dispose()
        _DEFAULT_CONFIG = None
