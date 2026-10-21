# autocodeflow-db

AutoCodeFlow 任务脚本的数据库连接辅助库：基于 SQLAlchemy 2.0 + psycopg2 的
PostgreSQL 会话管理，为短生命周期任务进程做了连接池收敛。

## 特性

- 短进程友好（D1-P2-6）：默认 `pool_size=2 / max_overflow=0`（每进程最多 2 条
  连接），N 并发任务进程下不会顶满 PG `max_connections`；
- 连接保活（PK-08）：`pool_pre_ping=True` + `pool_recycle=1800s`，
  主动回收空闲连接，避免拿到服务端已掐断的死连接；
- 无内建凭据：默认 URL 不含任何账号密码，`DATABASE_URL` 未设置时在连接时刻
  fail-fast，而不是静默连上一个猜出来的账号；
- 上下文管理器会话：提交/回滚/关闭全自动。

## 安装

```bash
pip install autocodeflow-db
# 或作为任务依赖（AutoCodeFlow 任务 requirements 字段）：
#   requirements: ["autocodeflow-db"]
```

## 最小示例

```python
from sqlalchemy import text

from autocodeflow_db import get_session

with get_session().session() as sess:
    rows = sess.execute(text("SELECT id, name FROM projects LIMIT 10")).fetchall()
```

> R134-A1：SQLAlchemy 2.0 不再接受裸字符串 SQL——`sess.execute("SELECT ...")`
> 会抛 `ArgumentError: Textual SQL expression ... should be explicitly
> declared as text(...)`。示例已改为 `text(...)`。

经环境变量配置（推荐）：

```bash
export DATABASE_URL="postgresql://user:pass@host:5432/autocodeflow"
```

```python
from autocodeflow_db import get_session, dispose_engine

with get_session().session() as sess:  # 省略 config 时读 DATABASE_URL
    ...

dispose_engine()  # 任务进程退出前释放连接池
```

显式配置与自定义池参数：

```python
from autocodeflow_db import DatabaseConfig, DatabaseSession

config = DatabaseConfig(url="postgresql://...", pool_size=5, pool_overflow=2)
try:
    with DatabaseSession(config).session() as sess:
        ...
finally:
    config.dispose()   # 显式释放该 config 的连接池（任务进程退出前）
```

> R134-A1：`DatabaseSession` **不持有** `config`，所以 `DatabaseSession(config)`
> 一旦丢掉 `config` 引用，连接池就没有任何释放出口（只能等进程退出）。
> 上面的 `try/finally` 是必须的；沿用 `get_session()` 的环境变量形态时，
> 出口是同等的 `dispose_engine()`。

## 开发

```bash
pip install -e ".[dev]"
pytest
```
