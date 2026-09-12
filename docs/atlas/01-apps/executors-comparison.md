# 三种执行器横向对比
> 所属: docs/atlas/01-apps · 最后核对: 2026-09-13 · 对应代码: apps/executor-node/src、apps/executor-python、apps/executor-desktop/src

## 选型对比表

| 维度 | executor-node | executor-python | executor-desktop |
|---|---|---|---|
| 技术栈 | Express 4 + axios + ts-node 生态 | FastAPI + uvicorn + httpx + uv | Electron 43 + React 18（托管 node 内核） |
| 默认端口 | 8002（`PORT`） | 8001（`PORT`） | 8002（内核端口，`config.executorPort`） |
| 注册 `type` | `node` | `python` | `node`（随内核注册） |
| 注册 capabilities | 探测：`shell`/`node`/`python`（PATH 探测） | 恒 `['python','shell']` | 同 node 内核 |
| 可执行运行时 | node / python / shell | python（主）/ node / shell | 同 node 内核 |
| 依赖安装 | npm `--prefix` 到 `.node_modules/<taskId>`（支持私服 .npmrc + token） | uv venv `.venvs/<taskId>` + `uv pip install --index-url`（node 依赖不支持） | 同 node 内核 |
| 任务日志落点 | `workDir/logs/<日期>/<executionId>.log`（缓冲写） | `workDir/<executionId>/<executionId>.log`（流式限 64MB） | 同 node 内核（桌面 UI 读同一路径） |
| 产物目录约定 | `<workDir>/<execId>/artifacts/` | `<work_dir>/<execId>/artifacts/` | 同 node 内核 |
| 额外职责 | 应用部署（deploy.ts）、执行器自升级（update-package.ts）、配置热更 | 配置热更、磁盘 TTL 回收（maintenance.py） | 托盘/向导/历史/通知/自更新（electron-updater） |
| 平台 | Linux 容器 + Windows（多轮 windows-findings 修复） | Linux 容器（non-root）+ Windows | Windows/macOS/Linux 桌面包 |
| 测试 | jest（`*.spec.ts`，30+ 文件） | pytest（tests/，20 个文件） | selftest ×4 + Playwright 冒烟 |
| 典型场景 | 服务端常态任务、Node 生态脚本、Docker 集群扩容 | Python 数据/运维脚本、venv 隔离依赖 | 工程师本机/内网 Windows 机器接入，零命令行配置 |

> 三者对同一套 admin-api 协议完全对齐；多处源码注释互相标注 "node XXX.ts parity"。选择依据基本是**任务语言 + 部署位置**。

## 能力差异细节

- **glue 支持**：三者（desktop 随 node 内核）都支持 `glueSource` 内联脚本，写入 `glue_script.js/.py/.sh`（win32 shell 为 `.cmd`），且 glue 任务一律不装依赖、用系统运行时。
- **node 运行时的 requirements**：仅 executor-node 会真正安装；executor-python 遇 `runtime=node` + requirements 时告警忽略（避免静默 MODULE_NOT_FOUND）。
- **回调令牌注入**：node/python 均注入 `AUTOFLOW_CALLBACK_TOKEN` / `AUTOFLOW_ADMIN_API_URL` / `AUTOFLOW_EXECUTOR_ADDRESS` / `AUTOFLOW_ARTIFACTS_DIR` / `AUTOFLOW_TRACE_ID`（字段语义见 [executor-node 执行管线](executor-node/execution-pipeline.md)）。
- **磁盘回收**：node 清日志 + workDir + 死信回调（file-logger.ts）；python 额外覆盖 `.git_cache` 与 `.venvs`（maintenance.py），并保护运行中执行的目录。
- **HTTP API 面**（本机，供 admin 与运维）：两者都有 `/health`（+live/ready 或 readiness）、`GET /api/logs/:executionId`（分页 ≤2000）、`POST /api/config/reload`；node 多出 deploy / update-package。
- **安全姿态对齐点**：入站 `/api/*` 均为 Bearer 门（无 token 默认 dev 放行，`REQUIRE_TOKEN=true` 改为拒绝）；gitRepo SSRF 守卫（scheme 白名单 + 私网拒绝，python 多一个 `EXECUTOR_ALLOW_PRIVATE_NETWORK` 放行开关）；每执行回调令牌注入用户参数之后（用户不可覆盖）。
- **python 独有约束**：node 运行时的 requirements 被忽略并告警（不装 npm 包）；`PYPI_REGISTRY_URL` 禁止 userinfo/query/fragment（凭据不得进 argv）。
- **node 独有能力**：`POST /api/deploy` 应用部署（git/zip → npm/pip 装依赖 → once/daemon/scheduled 运行 + `POST /api/app-deployments/heartbeat` 上报）；`POST /api/update-package` 执行器包自升级（SHA-256 校验）。

## 共享协议（注册 / 心跳 / 回调契约）

```
                 ┌──────────────────── admin-api (NestJS :3105 /api) ───────────────────┐
                 │  POST /executors/register   POST /executors/token                    │
                 │  POST /executors/heartbeat  POST /executors/offline                  │
                 │  POST /executions/callback（批≤100）  PUT /executions/:id/artifacts/:name │
                 └──────────────────────────────────────────────────────────────────────┘
                      ▲ 静态共享 token 引导 → 动态 per-executor token（30min 刷新）
                      │ tokenHash 随 register/token/heartbeat 回显采纳（N26 HMAC 源）
   executor-node ─────┤
   executor-python ───┤  派发：admin ──POST http://<addr>/api/execute──▶ 执行器
   executor-desktop ──┘  kill：admin ──POST /api/executions/:id/kill──▶ 执行器
                         reload：admin ──POST /api/config/reload──▶ 执行器
```

- **注册**：启动时用共享引导 token 调 `POST /executors/register`，携带 `appName/address/type/version/capabilities/maxConcurrent(Tasks)/restartedAt/startupId`；admin 返回执行器行 + `perExecutorToken` + `tokenHash`。幂等键 `(address, startupId)`。
- **心跳**：默认 30s（`HEARTBEAT_INTERVAL_SECONDS`），报文含 `cpuUsage/memUsage/runningTaskCount/runningExecutionIds(≤200)/deadLetterCount`；python 侧恒发送 `runningExecutionIds`（缺失会被 admin 判为旧版执行器、跳过 prepare 期活性保护）；node 侧额外随心跳热更 `maxConcurrentTasks`。
- **派发接收**：`POST /api/execute`（Bearer 共享 token + 可选 traceparent），同步校验后立即 `{status:'accepted', executionId}`（python 额外带 `executorAddress`），prepare/执行后台化；容量满 429。
- **回调上报**：终态批量 `POST /executions/callback`，鉴权可用执行器 token 或每执行 `v1.` HMAC 令牌；字段表见 [执行器协议契约](executor-contract.md)。失败落盘 + 死信重放，执行器重启不丢终态。
- **完整字段与请求/响应示例**：[执行器协议契约](executor-contract.md)；时序：[执行器注册流程](../04-flows/executor-registration.md)、[回调上报](../04-flows/execution-callback.md)。

## 行为一致性对照（同一事件的三个实现）

| 事件 | executor-node | executor-python | executor-desktop |
|---|---|---|---|
| 启动注册失败 | `maybeReRegister` 钩子（token 获取成功后补注册，N41） | `maybe_re_register`（30s 退避 + in-flight 去重，SEC-NEW-3） | 随内核（无自有逻辑） |
| token 被管理端轮换 | 401 → `forceTokenRefresh()` 一次重取 + 单次重试（R10） | `request_with_self_heal`（E3/R11 对等） | 随内核 |
| 重复派发同 executionId | `liveExecutions.has` → 400（改动2） | `register_live_execution` → 400（E7） | 随内核 |
| 同任务并发 | `TaskWorkerManager` 按 taskId 串行队列（空闲 5 分钟回收） | per-task `asyncio.Lock`（E6） | 随内核 |
| 超时处理 | `killProcessTree`（POSIX 组杀 / win32 taskkill /T /F） | `_kill_process_tree`（同两分支） | 随内核 |
| 回调投递失败 | 内存重试 5 次（1s 指数退避）→ 落盘 → 重放 → 死信（callback.ts） | 3 次退避 → 落盘 `{"url","payloads"}` → 1s 扫描重放（按文件指数退避 1..60s）→ 死信（E2） | 随内核 |
| 停机 | 30s 宽限 → 树杀 → drain 回调（≤10s）→ offline | 30s 宽限 → 树杀 → worker 回调窗口（QA8）→ drain → offline | before-quit 等内核 stop()（8s 强杀兜底） |
| 环境变量白名单 | `ENV_WHITELIST` + `SECRET_ENV_DENYLIST`（SEC-01，win32 大小写不敏感 W-20） | `_ENV_WHITELIST`（多 PYTHONPATH/PYTHONHASHSEED/VIRTUAL_ENV） | 随内核（桌面 env 只构造一次传内核） |

## 如何选择与组合

- **容器集群默认**：executor-node（`docker-compose.yml` 默认两台）+ executor-python，按任务 `runtime` 路由；admin 派发时按 `capabilities` 过滤广播、按 `runtime` 匹配。
- **Windows 内网机器**：executor-desktop（NSIS 安装包）——无需命令行，向导填 admin-api 地址与 token 即接入；不适合无 GUI 的服务器。
- **同一台机混跑**：三者端口不同（8001/8002）可并存，但 desktop 与 executor-node 共用 8002 时注意端口冲突（desktop 配置页有 `config:check-port` 端口检测）。

## 相关文档

- [executor-node](executor-node/README.md) · [执行管线](executor-node/execution-pipeline.md)
- [executor-python](executor-python/README.md)
- [executor-desktop](executor-desktop/README.md) · [IPC 与安全](executor-desktop/ipc-and-security.md)
- [执行器协议契约](executor-contract.md) · [admin-api executor 模块](admin-api/modules/executor.md)
