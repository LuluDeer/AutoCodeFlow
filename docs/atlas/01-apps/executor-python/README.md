# executor-python 应用总览（Python 执行器）
> 所属: docs/atlas/01-apps/executor-python · 最后核对: 2026-09-13 · 对应代码: apps/executor-python（main.py、routers/、config.py 等）

## 一句话定位

executor-python 是 **FastAPI + uvicorn 异步任务执行器**：以 Python 为主运行时（uv venv 隔离依赖），兼容执行 node/shell 载体，向 admin-api 注册/心跳/回调的协议与 executor-node 完全对齐（多处源码注释直接标注"node XXX.ts parity"）。

## 技术栈与版本（摘自 apps/executor-python/requirements.txt）

| 类别 | 依赖 | 版本 |
|---|---|---|
| Web 框架 | fastapi | 0.136.3 |
| ASGI 服务 | uvicorn | 0.48.0 |
| HTTP 客户端 | httpx | 0.28.1 |
| 系统指标 | psutil | 7.2.2 |
| 重试 | tenacity | >=8.2.0 |
| 配置 | pydantic-settings | 2.15.0 |
| manifest 解析 | PyYAML | 6.0.3 |
| 依赖安装器 | uv | 0.8.17（支持 `uv venv --no-project`） |

常用命令（apps/executor-python 下）：`python main.py`（uvicorn 启动，`host=0.0.0.0`）、`pytest`（pytest.ini，tests/ 目录）。请求模型优先复用 `autocodeflow_sdk.models.ExecuteRequest`，SDK 未安装时回退本地 pydantic 模型（字段 `executionId` / `task` / `params`）。

## 启动引导链（main.py lifespan）

```
python main.py
 └─ uvicorn main:app (port=settings.port，默认 8001)
     lifespan 启动段：
      ├─ check_admin_api_connectivity()        GET /api/health 探活（3 次指数退避）
      ├─ token 缺失告警（REQUIRE_TOKEN=true 则 /api/* 拒绝，否则 dev 放行）
      ├─ set_on_token_acquired(maybe_re_register)   token 恢复补注册钩子（N41 parity）
      ├─ register_executor()                   POST /executors/register（静态 token）
      ├─ heartbeat_task()                      心跳协程（默认 30s，tenacity 3 次重试）
      ├─ execute.start_callback_retry_task()   回调落盘重放循环（E2，1s 扫描）
      └─ maintenance.start_disk_cleanup_task() 磁盘 TTL 回收（E8，6h 周期，首扫延迟 600s）
     lifespan 关停段：
      └─ 停心跳 → 等 30s → kill_running_task_processes() 树杀
         → await_background_tasks_after_kill() 给 worker 窗口投递终态回调（QA8）
         → stop_callback_retry_task()（10s drain）→ 停磁盘清理 → POST /executors/offline
```

## 目录结构与关键文件

```
apps/executor-python/
├── main.py                       FastAPI 装配、注册/补注册、优雅停机、CORS
├── config.py                     pydantic-settings Settings（含 PYPI_REGISTRY_URL 校验器）
├── admin_api.py                  admin URL 优先级（external>internal>default）与 /api 拼接、探活
├── auth.py                       动态 token 获取/校验、tokenHash 采纳、401 自愈请求封装
├── scheduler.py                  心跳报文（psutil CPU/内存、活性上报、死信数）
├── startup_identity.py           进程生命身份（started_at / startup_id）
├── execution_callback_token.py   v1.<executionId>.<expiresAt>.<hmac> 令牌（N33，与 node/admin 三方同测试向量）
├── manifest.py                   manifest.yaml/yml 合并
├── artifacts.py                  产物收集上传（≤20 个 / ≤100MB，best-effort）
├── maintenance.py                磁盘 TTL 回收：任务目录/.git_cache/.venvs/dead-letter
├── routers/
│   ├── execute.py                核心管线（约 1800 行）：/execute、/kill、回调、uv 安装、glue
│   ├── health.py                 GET /health、GET /health/readiness
│   ├── logs.py                   GET /api/logs/{execution_id}?fromLine=&limit=（≤2000）
│   └── config.py                 POST /api/config/reload（驼峰/下划线双别名）
└── tests/                        pytest：registration / kill / concurrency / callback_persistence ...
```

## 执行管线（routers/execute.py 摘要）

```
POST /api/execute (verify_token)
  ├─ 容量检查 429 → register_live_execution() 重复领取守卫 400
  ├─ 记录 traceparent → sched.increment_running()
  └─ asyncio.create_task(_run_and_callback)   立即返回
       {status:'accepted', executionId, executorAddress}
       │  按 task.id 取 per-task asyncio.Lock（同任务串行，E6）
       ▼
     run_task()
       ├─ work_dir = WORK_DIR/<executionId>（路径穿越守卫 + chmod 0700）
       ├─ gitRepo：scheme 白名单 + 私网 SSRF 守卫（EXECUTOR_ALLOW_PRIVATE_NETWORK
       │   可放行 RFC1918，loopback 恒拒绝）→ git_checkout_to()（.git_cache 裸仓库
       │   缓存，threading.Lock 串行，坏缓存隔离重克隆）
       ├─ manifest 合并 → glue 脚本落盘（glue_script.py/.js/.sh|.cmd）
       ├─ 依赖：uv venv --no-project WORK_DIR/.venvs/<task_id>（60s）
       │        uv pip install --python <venv> --index-url PYPI_REGISTRY_URL（300s）
       │        安装环境经 _build_install_env() 最小白名单 + UV_NO_CONFIG=1 +
       │        PIP_CONFIG_FILE=/dev/null（杜绝宿主 pip/uv 配置与凭据）
       ├─ env 白名单（含 PYTHONPATH/PYTHONHASHSEED/VIRTUAL_ENV）+ 注入
       │   EXECUTION_ID / TASK_ID / TASK_NAME / AUTOFLOW_<PARAM> /
       │   AUTOFLOW_CALLBACK_TOKEN / AUTOFLOW_ADMIN_API_URL /
       │   AUTOFLOW_EXECUTOR_ADDRESS / AUTOFLOW_ARTIFACTS_DIR / AUTOFLOW_TRACE_ID
       └─ spawn：python(venv 或 sys.executable) / node(node 依赖不支持→告警) /
                 shell(bash -c 'cd "$1" && exec "$2"' 位置参数防注入；win32 cmd.exe /c)
       │  asyncio 超时 → _kill_process_tree()（POSIX killpg / win32 taskkill /T /F）
       ▼
     终态回调 POST /executions/callback（单条数组）
       ├─ 3 次指数退避；404/4xx(非401/408/429) 终止重试
       ├─ 失败落盘 WORK_DIR/callbacks/ + 重放循环 + dead-letter（E2）
       └─ 回调前 gather_artifacts_for_callback() 上传产物并把清单并入载荷
```

与 node 侧的差异要点：python 侧依赖安装用 **uv**（不是 pip 直装）；venv 目录 `.venvs/<task_id>` 由磁盘回收保护；`runtime=node` 时 requirements 会被忽略并打 warning（本执行器不装 npm 包）。

## 回调与令牌

- 回调令牌（N33）：`execution_callback_token.py` 与 node/admin 三方由同一测试向量钉死（格式 `v1.<executionId>.<expiresAtUnixSec>.<hmacHex>`，域分隔符 `autocodeflow:execution-callback:v1`）；secret 解析顺序 `EXECUTION_CALLBACK_SECRET` env → admin 回显 tokenHash → 共享 token；TTL = timeout + 900s。
- 401 自愈（E3/R11）：出站请求统一走 `auth.request_with_self_heal`，admin 侧 rotate token 后一次重取即恢复，不必等 30 分钟刷新。

## 配置项（config.py + .env.example 核实）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `APP_NAME` | `executor-python-1` | 注册显示名 |
| `PORT` | `8001` | 监听端口 |
| `EXECUTOR_ADDRESS` / `EXECUTOR_ADDRESS_PUBLIC` | `executor-python:8001` / 空 | 注册与回调地址 |
| `ADMIN_API_URL` / `_INTERNAL` / `_EXTERNAL` | `http://admin-api:3105` | admin-api 地址（external > internal > default） |
| `EXECUTOR_SHARED_TOKEN` / `EXECUTOR_SECRET` | 空 | 共享引导 token（env 优先于 .env） |
| `WORK_DIR` | `/tmp/autocodeflow/tasks` | 任务根目录 |
| `MAX_CONCURRENT_TASKS` | `10` | 并发上限 |
| `TASK_TIMEOUT_SECONDS` | `300` | 默认超时 |
| `HEARTBEAT_INTERVAL_SECONDS` | `30` | 心跳间隔 |
| `PYPI_REGISTRY_URL` | 空 | uv `--index-url`（禁止 userinfo/query/fragment，凭据不得进 URL） |
| `EXECUTOR_ALLOW_PRIVATE_NETWORK` | `false` | gitRepo 私网 SSRF 放行开关（loopback 不受影响） |
| `REQUIRE_TOKEN` | `false` | true 时无 token 拒绝 /api/* |
| `CORS_ORIGINS` | `http://localhost:5176` | CORS 白名单 |
| `DISK_CLEANUP_TTL_DAYS` / `_INTERVAL_SECONDS` / `_INITIAL_DELAY_SECONDS` | `7` / `21600` / `600` | 磁盘回收参数 |

## 与其他组件的关系

- **依赖 admin-api**：注册/心跳/回调/令牌（契约见 [执行器协议契约](../executor-contract.md)）。
- **依赖 registry-pypi（可选）**：`PYPI_REGISTRY_URL`（compose 默认 `http://registry-pypi:8003/simple/`），见 [PyPI 私服](../registry-pypi/README.md)。
- **依赖宿主 uv/git**：uv 与 git 必须在 PATH（`UV_BIN = shutil.which('uv') or 'uv'`，缺列入 `runtime_missing`）。
- **不依赖 registry-npm**：npm 依赖安装是 executor-node 的职责。

## 常见改动场景

- **支持新运行时**：改 `run_task()` 的 runtime 分支与 `runTask` 容错（参考 node 分支的"不装依赖"告警模式）。
- **调整 uv 安装策略**：`ensure_venv()`（超时常量 `UV_VENV_TIMEOUT_SECONDS`/`UV_PIP_TIMEOUT_SECONDS`、`_build_install_env()`）。
- **新增心跳字段**：`scheduler.py _send_heartbeat()` + admin `executor.controller.ts heartbeat()` 白名单同步（python 侧注意 `runningExecutionIds` 必须恒发送——缺失会被 admin 视为旧版执行器而跳过 prepare 期活性保护）。

## 相关文档

- [执行器协议契约](../executor-contract.md) · [三种执行器对比](../executors-comparison.md)
- [执行器注册流程](../../04-flows/executor-registration.md) · [回调上报](../../04-flows/execution-callback.md)
- [PyPI 私服](../registry-pypi/README.md) · [registry-pypi 内部实现](../registry-pypi/internals.md)
