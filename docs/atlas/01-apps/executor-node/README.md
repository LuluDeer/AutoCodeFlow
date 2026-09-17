# executor-node 应用总览（Node.js 执行器）
> 所属: docs/atlas/01-apps/executor-node · 最后核对: 2026-09-13 · 对应代码: apps/executor-node/src

## 一句话定位

executor-node 是 AutoCodeFlow 的 **Express 4 单进程任务执行器**：启动时向 admin-api 注册并心跳保活，接收 `POST /api/execute` 派发，完成 git 拉取 / manifest 合并 / 依赖安装 / 子进程执行 / 日志与产物回收，通过批量回调接口上报终态。它同时也是桌面执行器（executor-desktop）内置的执行内核（经 ncc 打包后随桌面端分发）。

## 技术栈与版本（摘自 apps/executor-node/package.json）

| 类别 | 依赖 | 版本 |
|---|---|---|
| HTTP 服务 | express | 4.22.2 |
| HTTP 客户端 | axios | 1.20.0 |
| 配置 | dotenv | ^17.4.2 |
| manifest 解析 | js-yaml | ^4.1.0 |
| 进程日志 | winston | 3.19.0 |
| 测试 | jest + ts-jest + supertest | 29.7.0 / 29.4.12 / 7.2.2 |
| 语言 | typescript | 5.8.3 |

常用命令（apps/executor-node 下）：`npm run build`（tsc）、`npm start`（node dist/main.js）、`npm run dev`（ts-node-dev）、`npm test`（jest，测试文件为 `src/**/*.spec.ts`）。

## 启动引导链（src/main.ts）

```
main.ts
 ├─ 1. dotenv.config(../.env)                  预载 .env（先于任何 config 读取）
 ├─ 2. crypto polyfill（Node < 19 补 globalThis.crypto）
 ├─ 3. 挂载路由
 │      app.use('/', healthRouter)             /health /health/live /health/ready（免鉴权）
 │      app.use('/api', verifyToken, ...)      execute / logs / deploy / update-package
 │      app.use('/api', configRouter)          /api/config/reload（内部自带 verifyToken）
 ├─ 4. app.listen(config.port)（默认 8002）后：
 │      ├─ initAdminClients(config.adminApiUrls)   多 admin 地址 HA 初始化
 │      ├─ checkAdminApiConnectivity()             GET /api/health 探活（3 次指数退避）
 │      ├─ setOnTokenAcquired(maybeReRegister)     token 恢复钩子（N41 补注册）
 │      ├─ registerExecutor()                      POST /api/executors/register（静态 token）
 │      ├─ startHeartbeat()                        心跳（默认 30s，1s 轮询器驱动）
 │      ├─ startCallbackThread()                   回调发送/重试/落盘线程（1s 循环）
 │      └─ startLogCleanup / startWorkDirCleanup   日志与 workDir 7 天 TTL 回收
 └─ 5. 优雅停机：SIGTERM/SIGINT/SIGBREAK/uncaughtException → gracefulShutdown
        （停心跳 → 关 HTTP → 停 worker → 等 30s → 树杀残留任务 → drain 回调 → POST /api/executors/offline）
```

注册时上报的运行时能力由 `runtime-detection.ts` 的 `detectRuntimesOnHost()` 探测：
恒有 `shell`、`node`；python 走**双通道**——系统 `python3`/`python` 实跑
`--version` 成功，**或**自带 uv 可用（uv 能按 `runtimeVersion` 获取解释器）。

> 历史坑（已修）：原实现用 `which python3|python` 判定。**Windows 上没有
> `which`**（`spawnSync` 返回 ENOENT、`status === null`），而代码只判
> `status === 0`，于是 Windows 客户端**恒定**上报 `shell,node` —— 哪怕机器上
> 装了 Python。由于 admin 侧派发只按 `capabilities` 过滤、且任务 runtime 缺省
> 是 `python`，后果是新设备"注册成功但任务永远派不过来"。现改为实跑探测，
> 并对不存在命令正确回落。

上报的 `type` 由同一份 runtimes 同源推导（`reportedExecutorType()`）：
具备 python 能力 → `universal`，否则 `node`。`type` **只用于后台展示，不参与
派发**；派发只看 `capabilities`。

## 目录结构与关键文件

```
apps/executor-node/src/
├── main.ts                       启动引导、注册/补注册、优雅停机
├── config.ts                     全部环境变量集中解析（含 WORK_DIR 大小写不敏感 getter）
├── admin-client.ts               多 admin URL 故障转移 + 401 自愈（request/forceTokenRefresh）
├── admin-envelope.ts             admin {code,message,data} 信封解包 + tokenHash 采纳
├── admin-api-url.ts              base URL 归一化与 /api 拼接
├── middleware/auth.ts            执行器动态 token 获取/校验（verifyToken 门 + fetchToken）
├── execution-callback-token.ts   v1.<executionId>.<expiresAt>.<hmac> 每执行回调令牌（N23）
├── env-whitelist.ts              子进程环境变量白名单（SEC-01，含 secret 拒传清单）
├── scheduler.ts                  心跳报文组装（CPU/内存/运行数/活性上报/死信数）
├── callback.ts                   回调队列、批量发送、指数退避、落盘与死信
├── task-worker.ts                按 taskId 串行的 TaskWorker 池 + 空闲回收（5 分钟）
├── artifacts.ts                  产物收集（≤20 个、单个 ≤100MB）与 PUT 上传
├── file-logger.ts                workDir/logs/<日期>/<executionId>.log 缓冲写 + TTL 清理
├── manifest.ts                   manifest.yaml/yml 加载与任务字段合并
├── heartbeat-state.ts / startup-identity.ts  心跳状态与进程生命身份
├── run-command.ts / safe-path.ts / zip-guard.ts  子进程运行、路径与 zip 安全工具
└── routes/
    ├── execute.ts                POST /execute + POST /executions/:id/kill（核心管线，见 execution-pipeline.md）
    ├── health.ts                 /health /health/live /health/ready
    ├── logs.ts                   GET /logs/:executionId?fromLine=&limit=（≤2000/页）
    ├── deploy.ts                 应用部署接收（git/zip 包 → 装依赖 → once/daemon/scheduled）
    ├── update-package.ts         POST /update-package（下载→SHA-256 校验→解压替换→回调确认）
    └── config.ts                 POST /config/reload 配置热更（含 workDir 安全切换）
```

## 环境变量表（config.ts + .env.example 核实）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `APP_NAME` | `executor-node-1` | 注册显示名 |
| `PORT` | `8002` | HTTP 监听端口 |
| `EXECUTOR_ADDRESS` | `executor-node:8002` | admin-api 回调本执行器的地址 |
| `EXECUTOR_ADDRESS_PUBLIC` | 同 `EXECUTOR_ADDRESS` | 对外注册地址（注册/心跳/回调均携带它） |
| `ADMIN_API_URL` | `http://admin-api:3105` | admin-api 基础地址 |
| `ADMIN_API_URL_INTERNAL` / `_EXTERNAL` / `ADMIN_API_URLS` | 空 | 内网/外网地址、多地址 HA（优先级 URLS > INTERNAL > URL） |
| `EXECUTOR_SHARED_TOKEN` / `EXECUTOR_SECRET` / `--token` | 空 | 共享引导 token（三者优先级从左到右） |
| `EXECUTION_CALLBACK_SECRET` | 空 | 每执行回调令牌的专用 HMAC 源（N26 缺省回退 tokenHash→共享 token） |
| `WORK_DIR` | `/tmp/autocodeflow/tasks` | 任务工作根目录（键名大小写不敏感回退） |
| `MAX_CONCURRENT_TASKS` | `10` | 并发上限（心跳随 E9 上报热更值） |
| `TASK_TIMEOUT_SECONDS` | `300` | 默认任务超时 |
| `HEARTBEAT_INTERVAL_SECONDS` | `30` | 心跳间隔 |
| `LOG_RETENTION_DAYS` | `7` | 日志/工作目录/死信 TTL |
| `NPM_REGISTRY_URL` | 空 | 任务 npm 依赖私服（写入临时 .npmrc） |
| `NPM_REGISTRY_TOKEN` | 空 | 私服 `_authToken`（永不进子进程 env、不打日志） |
| `PYTHON_REGISTRY_URL` | 空 | 仅 deploy.ts 的 pip 安装使用 |
| `REQUIRE_TOKEN` | 空 | `true` 时无 token 则拒绝 /api/*（默认 dev 放行） |
| `LOG_LEVEL` | `info` | winston 级别 |

## 与其他组件的关系

- **依赖 admin-api**：注册/心跳/回调/令牌/日志回捞全部走 admin-api（契约见 [执行器协议契约](../executor-contract.md)、[执行器注册流程](../../04-flows/executor-registration.md)、[回调上报](../../04-flows/execution-callback.md)）；模块级拆解见 [admin-api executor 模块](../admin-api/modules/executor.md)。
- **依赖 registry-npm / registry-pypi（可选）**：任务依赖经 `NPM_REGISTRY_URL` 指向 Verdaccio（见 [registry-npm](../registry-npm.md)）；应用部署的 pip 走 `PYTHON_REGISTRY_URL`（见 [registry-pypi](../registry-pypi/README.md)）。
- **被 executor-desktop 依赖**：桌面端把本执行器经 `scripts/bundle-executor.sh`（@vercel/ncc）打包为 `resources/executor-node/index.js` 子进程运行（见 [executor-desktop](../executor-desktop/README.md)）。
- **被 admin-api 的 executor-package 模块分发**：`GET /api/executors/artifact/executor-node.tar.gz` 安装脚本通道即本应用的打包产物。

## 常见改动场景

- **新增任务入参/字段**：改 `routes/execute.ts` 的 `ExecuteRequest` + `prepareExecution()`，同步 admin 侧派发载荷（`executor.service.ts dispatchExecution`）与 [执行器协议契约](../executor-contract.md)。
- **调整依赖安装策略**：npm 安装在 `routes/execute.ts`（`.node_modules/<taskId>`、临时 .npmrc、`--ignore-scripts`）；pip 安装在 `routes/deploy.ts installDeps()`。
- **接入新私服鉴权**：改 `buildNpmRcContent()`（scope 行/`_authToken` 行生成）；私服侧配置见 [registry-npm](../registry-npm.md)。
- **换心跳字段**：改 `scheduler.ts sendHeartbeat()` 并保持 admin `executor.controller.ts heartbeat()` 白名单同步（额外字段会被丢弃）。

## 相关文档

- [执行管线细节](execution-pipeline.md) —— 领取/prepare/子进程/回调全链路
- [执行器协议契约](../executor-contract.md) —— 注册/心跳/派发/回调字段表
- [三种执行器对比](../executors-comparison.md)
- [Verdaccio 私服](../registry-npm.md) · [PyPI 私服](../registry-pypi/README.md)
