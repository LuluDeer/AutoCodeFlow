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
import sys
import threading
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

#: R134-A1: 串行化 build() 的 check-then-set。此前两个线程首次并发调用
#: 会各建一个 engine，输的一方永不 dispose（连接池泄漏），并且会暴露
#: "engine 已赋值、session factory 仍是 None" 的半初始化窗口——旁路线程
#: 从 build() 拿到 (engine, None)，随后 DatabaseSession 里 self._factory()
#: 直接 TypeError。
_BUILD_LOCK = threading.Lock()


@dataclass
class DatabaseConfig:
    """Database connection configuration."""
    url: str = "postgresql://localhost:5432/autocodeflow"  # no default credentials; supply via DATABASE_URL env or DatabaseConfig.from_env()
    # D1-P2-6: 任务是短生命周期进程，每进程 5+10=15 连接会在 N 并发进程下顶满
    # PG max_connections。默认收窄到 pool_size=2 / overflow=0（每进程最多 2 条）；
    # 需要更大并发的长驻服务可显式覆盖。
    pool_size: int = 2
    pool_overflow: int = 0
    echo: bool = False
    pool_recycle: int = DEFAULT_POOL_RECYCLE_SECONDS
    #: P3-9（2026-10-26）: 语句级超时（PostgreSQL ``statement_timeout``，毫秒）。
    #:
    #: 取舍说明：本进程是**短生命周期任务进程**且 pool_size=2（见上）——一条
    #: 挂死的查询（锁等待 / 函数死循环 / 误全表扫）就能占满全部 2 条连接，
    #: 把本进程的 DB 面整个堵死到任务超时被杀。连接级默认 30s 兜底（libpq
    #: ``options`` 传播，池化复用时不会被遗忘，比每条语句手动 SET 可靠）。
    #: 0/负值显式关闭；仅对 postgresql 方言生效（sqlite 等测试/本地方言不注）。
    #: 经 ``DATABASE_URL`` 自带 options 的极端场景会被本字段覆盖——这里是其
    #: 唯一真值源。长驻服务（admin-api 侧）不使用本包，不受影响。
    statement_timeout_ms: int = 30_000

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
        # R134-A1: 双重检查 + 模块级锁——并发首次调用只建一个 engine。
        if self._engine is None:
            with _BUILD_LOCK:
                if self._engine is None:
                    engine = create_engine(
                        self.url,
                        pool_size=self.pool_size,
                        max_overflow=self.pool_overflow,
                        echo=self.echo,
                        # PK-08: keep long-lived task connections healthy.
                        pool_pre_ping=True,
                        pool_recycle=self.pool_recycle,
                        # P3-9: 语句级超时经 libpq options 传播（见字段注释）。
                        connect_args=self._connect_args(),
                    )
                    # 顺序有意义：先发布 factory 再发布 engine，旁路读者不会
                    # 看到 (engine, None) 这种半初始化组合。
                    self._session_factory = sessionmaker(bind=engine)
                    self._engine = engine
        return self._engine, self._session_factory  # type: ignore[return-value]

    def _connect_args(self) -> dict:
        """P3-9: 组装 connect_args——仅 postgresql 方言注入 statement_timeout。

        "postgresql" 前缀同时覆盖 ``postgresql://`` 与
        ``postgresql+psycopg2://`` 等方言变体；sqlite 等非 PG 形态返回空
        （options 是 libpq 专属，注入别的方言直接连接报错）。
        """
        if (
            self.statement_timeout_ms
            and self.statement_timeout_ms > 0
            and self.url.startswith("postgresql")
        ):
            return {
                "options": f"-c statement_timeout={int(self.statement_timeout_ms)}"
            }
        return {}

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
            try:
                yield sess
                sess.commit()
            except BaseException:
                # R134-A1: 原始错误必须原样逃出。rollback 本身也会失败
                # （连接已被服务端/池判死），那只是次生异常——记录后丢弃，
                # 绝不允许它把真正的 SQL/业务错误替换成 "rollback failed"。
                try:
                    sess.rollback()
                except Exception:
                    logger.exception(
                        "session.rollback() failed while handling another error; "
                        "the original error is preserved"
                    )
                raise
        finally:
            # R134-A1: 同理——已有异常在飞时 close 失败只记录（不得掩盖主
            # 异常）；成功路径上没有主异常，仍然抛给调用方，避免悄悄漏掉
            # 一次"连接没还回池"的失败。
            if sys.exc_info()[0] is not None:
                try:
                    sess.close()
                except Exception:
                    logger.exception(
                        "session.close() failed while handling another error; "
                        "the original error is preserved"
                    )
            else:
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
