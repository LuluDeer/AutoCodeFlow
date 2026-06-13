"""Database connection helpers for AutoCodeFlow tasks.

Provides a simple SQLAlchemy session factory that task code can use
to interact with databases in a structured way.
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Generator, Optional

from sqlalchemy import create_engine, Engine
from sqlalchemy.orm import Session, sessionmaker

logger = logging.getLogger(__name__)


@dataclass
class DatabaseConfig:
    """Database connection configuration."""
    url: str = "postgresql://localhost:5432/autocodeflow"  # no default credentials; supply via DATABASE_URL env
    pool_size: int = 5
    pool_overflow: int = 10
    echo: bool = False

    _engine: Optional[Engine] = field(default=None, init=False, repr=False)
    _session_factory: Optional[sessionmaker] = field(default=None, init=False, repr=False)

    def build(self) -> tuple[Engine, sessionmaker]:
        if self._engine is None:
            self._engine = create_engine(
                self.url,
                pool_size=self.pool_size,
                max_overflow=self.pool_overflow,
                echo=self.echo,
            )
            self._session_factory = sessionmaker(bind=self._engine)
        return self._engine, self._session_factory  # type: ignore[return-value]


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


def get_session(config: Optional[DatabaseConfig] = None) -> DatabaseSession:
    """Create a database session from config (or environment defaults)."""
    cfg = config or DatabaseConfig()
    return DatabaseSession(cfg)