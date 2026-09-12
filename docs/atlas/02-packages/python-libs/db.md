# autocodeflow-db — 数据库连接助手库

> 所属: docs/atlas/02-packages/python-libs · 最后核对: 2026-09-13 · 对应代码: packages/autocodeflow-db

## 职责

PyPI 包 `autocodeflow-db`（v0.1.0，Python >= 3.10）：给任务脚本提供一个**极薄的 SQLAlchemy 会话工厂**——统一连接参数（连接池大小、overflow、echo）、统一"正常提交 / 异常回滚 / 最终关闭"的会话生命周期。它不做 ORM 模型定义、不做迁移，只是让任务里的 DB 访问有结构化的入口。

依赖（pyproject.toml 核实）：`sqlalchemy>=2.0`、`psycopg2-binary>=2.9`（PostgreSQL 驱动；其他数据库需自行装对应驱动）。

## 目录结构与关键文件

```
packages/autocodeflow-db/
├── pyproject.toml
├── autocodeflow_db/
│   ├── __init__.py          导出 DatabaseConfig / DatabaseSession / get_session；__version__ = "0.1.0"
│   └── connection.py        全部实现（约 70 行）
└── tests/
    └── test_connection.py
```

## 公开 API 面（源码核实）

### DatabaseConfig（dataclass）

```python
@dataclass
class DatabaseConfig:
    url: str = "postgresql://localhost:5432/autocodeflow"  # 无默认凭据，生产走 DATABASE_URL env
    pool_size: int = 5
    pool_overflow: int = 10
    echo: bool = False
    def build(self) -> tuple[Engine, sessionmaker]   # 惰性建 engine + sessionmaker（缓存复用）
```

- `url` 默认值**不含任何凭据**（源码注释明确）；实际连接串应由任务参数或 `DATABASE_URL` 环境变量注入，避免把密码写进任务代码。

### DatabaseSession / get_session

```python
class DatabaseSession:
    def __init__(self, config: DatabaseConfig)
    @contextmanager
    def session(self) -> Generator[Session, None, None]

def get_session(config: Optional[DatabaseConfig] = None) -> DatabaseSession
```

- `session()` 是唯一的用法入口：进入时从 sessionmaker 取新 Session；**正常退出自动 `commit()`，异常自动 `rollback()` 并 re-raise，最终 `close()`**——任务脚本不需要手写事务样板。
- `DatabaseConfig.build()` 带内部缓存（`_engine`/`_session_factory` 惰性初始化后复用），同一 config 实例多次 `get_session()` 不会重复建引擎；连接池默认 `pool_size=5`、`max_overflow=10`。

### 典型用法（源码 docstring 语义）

```python
from autocodeflow_db import get_session, DatabaseConfig
from sqlalchemy import text

with get_session().session() as sess:          # 或 get_session(DatabaseConfig(url=...))
    rows = sess.execute(text("select ...")).all()
# 正常离开即 commit；抛异常即 rollback
```

测试：`npm run test:lib-db`（即 `cd packages/autocodeflow-db && python -m pytest tests -q`，见 [python-libs 总览](README.md)）。

## 与其他组件的关系

- **被依赖**：仅任务脚本；与平台自身的持久层无关——admin-api 用 TypeORM（见 [admin-api](../../01-apps/admin-api/README.md)），执行器不落业务库，本库纯粹是任务侧便利件。
- **依赖**：sqlalchemy + psycopg2-binary；四库之间零相互依赖（[python-libs 总览](README.md)）。
- 不在 release-please / release.yml lockstep 发布矩阵中。

## 常见改动场景

- **加连接参数透传**（如 `connect_args`、SSL、statement timeout）：在 `DatabaseConfig` 加字段并在 `build()` 传给 `create_engine` → `tests/test_connection.py` 补断言。
- **支持异步引擎**（`create_async_engine`）：属于新公开 API——加 `AsyncDatabaseSession` 并更新 `__init__` 导出与本文档；注意 sqlalchemy async 需要 async 驱动（如 asyncpg），属于新依赖，需同步 pyproject。
- **默认 url 调整**：保持"无凭据"原则（源码注释是安全约束，不是随便写的默认值）。

## 相关文档

- [python-libs 总览](README.md) · [ai](ai.md) · [http](http.md) · [notify](notify.md)
- [03-data 数据层](../../03-data/README.md)（平台自身的库表与迁移，与本库无直接关系但常被一起问到）
