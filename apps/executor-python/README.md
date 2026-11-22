# AutoCodeFlow Python Executor

> **受众**：开发、调试或部署 Python 执行器的工程师 · **状态**：稳定 · **最后核对**：2026-11-22

AutoCodeFlow 的服务端 Python 执行器，基于 Python 3.12 + FastAPI + uvicorn + pydantic-settings 构建，内置 `uv`（`0.13.4`）管理 per-task 虚拟环境与多版本 Python 解释器缓存池。

## 核心能力与协议边界

- **多版本 Python 与依赖隔离**：支持任务声明 `runtimeVersion` 与 `requirements`；通过 `uv` 维护独立解释器缓存池与 per-task venv，并拒绝以 `-` 开头的 option 形依赖条目（防索引劫持）。
- **协议契约**：与 `admin-api`、`executor-node` 共享 `packages/executor-protocol/protocol.json`，Pydantic 严格校验模型由生成器产出至 `generated/protocol_schemas.py`（契约说明见 [executor-protocol](../../packages/executor-protocol/README.md)）。
- **Push / Pull 双派发模式**：默认 Push 模式监听 `8001`；设置 `EXECUTOR_PULL_MODE=true` 后经 `POST /executors/pull` 长轮询取件，无需入站端口。
- **可选安全沙箱与看门狗**：支持 bubblewrap 沙箱隔离（见 `docker-compose.secure.yml`、`sandbox.py`）与子进程内存看门狗（`task_memory_watchdog.py`）。

## HTTP 路由

路由注册位于 `routers/`：

| 路由模块 | 主要端点 | 说明 |
|----------|---------|------|
| `routers/health.py` | `GET /health` · `/health/live` · `/health/ready` | 存活与就绪探针 |
| `routers/execute.py` | `POST /api/execute` · `POST /api/kill/{execution_id}` | 协议闸门校验、venv 安装、子进程执行与终止 |
| `routers/logs.py` | `GET /api/logs/{execution_id}` | 分页拉取执行日志 |
| `routers/config.py` | `POST /api/config/reload` | 并发上限、心跳周期等配置热重载 |

## 快速开始

前置要求：Python `>= 3.10`（生产容器镜像基于 Python 3.12）。

```bash
cd apps/executor-python
pip install -r requirements.txt

# 启动开发服务（默认端口 8001）
uvicorn main:app --host 127.0.0.1 --port 8001
```

## 常用环境变量

配置定义位于 `config.py`：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `APP_NAME` | `executor-python-1` | 执行器名称 |
| `PORT` | `8001` | HTTP 监听端口 |
| `ADMIN_API_URL` | `http://admin-api:3105` | Admin API 基地址 |
| `EXECUTOR_ADDRESS` | `executor-python:8001` | 向中台注册的执行器内部地址 |
| `EXECUTOR_ADDRESS_PUBLIC` | 空 | 对外可达地址（留空回落 `EXECUTOR_ADDRESS`） |
| `EXECUTOR_SECRET` | 空 | 与 `admin-api` 对齐的共享注册密钥（兼容 `EXECUTOR_SHARED_TOKEN`） |
| `EXECUTOR_PULL_MODE` | `false` | 设为 `true` 启用 Pull 长轮询模式 |
| `WORK_DIR` | `/tmp/autocodeflow/tasks` | 任务工作目录与日志临时落盘路径 |
| `MAX_CONCURRENT_TASKS` | `10` | 最大并发任务数（钳制范围 `1..10000`） |
| `TASK_TIMEOUT_SECONDS` | `300` | 默认任务超时秒数 |
| `HEARTBEAT_INTERVAL_SECONDS` | `30` | 心跳间隔秒数（钳制范围 `5..60`） |
| `PYPI_REGISTRY_URL` | 空（公共 PyPI） | 私有 PyPI 索引地址（如 `http://registry-pypi:8003/simple/`，禁止内嵌凭据） |
| `PKG_CACHE_MAX_BYTES` | `4294967296`（4 GiB） | 包缓存目录配额上限 |
| `PACKAGE_DOWNLOAD_MAX_BYTES` | `209715200`（200 MiB） | 单包下载体积上限 |
| `LOG_LEVEL` / `LOG_FORMAT` | `INFO` / `text` | 日志级别与格式（设 `json` 输出单行结构化 JSON） |

## 测试

```bash
# 安装测试依赖
cd apps/executor-python
pip install -r requirements-dev.txt

# 隔离 .env 运行单元测试（或在仓库根运行 npm run test:python）
SELFTEST_SKIP_ENV_FILE=1 python3 -m pytest -q
```

## 相关文档

- [执行器协议契约（executor-protocol）](../../packages/executor-protocol/README.md)
- [私有 PyPI 仓库（registry-pypi）](../registry-pypi/README.md)
- [SDK 使用指南](../../docs/sdk-guide.md)
- [部署指南](../../docs/deployment.md)
