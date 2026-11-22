# AutoCodeFlow Node.js Executor

> **受众**：开发、调试或部署 Node.js / 通用执行器的工程师 · **状态**：稳定 · **最后核对**：2026-11-22

AutoCodeFlow 的 Node.js / 通用执行器，基于 Node.js 24 + Express 5 + Zod 4 构建。除作为独立服务端执行器运行外，也是 [桌面执行器](../executor-desktop/README.md) 内置执行引擎的唯一源码真值源（通过 `ncc` 打包至桌面端 `resources/executor-node/index.js`）。

## 核心能力与协议边界

- **多运行时支持**：支持 `node` / `shell` / `python` 任务执行；工具链探测与执行统一收敛在 `src/toolchain.ts`（支持系统 Python 与 `uv` 多版本解释器池）。
- **协议契约**：当前上报协议版本 `PROTOCOL_VERSION = 9`，执行请求/响应与回调载荷的 JSON Schema 由 `packages/executor-protocol/protocol.json` 统一生成至 `src/generated/protocol.schemas.ts`（契约说明见 [executor-protocol](../../packages/executor-protocol/README.md)）。
- **Push / Pull 双派发模式**：默认 Push 模式监听 HTTP 端口；开启 `EXECUTOR_PULL_MODE=true` 后改走长轮询拉取（无需开放入站端口，适合 NAT / 内网环境）。
- **依赖隔离与私服**：entrypoint 任务的 `requirements` 安装到隔离目录 `.node_modules/<taskId>` 并注入 `NODE_PATH`；配置 `NPM_REGISTRY_URL` 后自动生成 `.npmrc`（支持 `_authToken` 与 Basic 凭据）。
- **优雅停机与热重载**：除 `SIGTERM`/`SIGINT`/`SIGBREAK` 外，提供持执行器凭据鉴权的 `POST /api/shutdown`（供桌面端在 Windows 下排空在途任务与内存态回调队列）。

## HTTP 路由

| 路由 | 鉴权 | 说明 |
|------|------|------|
| `GET /health` · `/health/live` · `/health/ready` | 公开 | 存活与就绪探针 |
| `POST /api/execute` · `POST /api/kill/:executionId` | 执行器令牌 | 接收并执行任务 / 强制终止在跑任务 |
| `GET /api/logs/:executionId` | 执行器令牌 | 分页读取执行日志 |
| `POST /api/deploy` | 执行器令牌 | 应用部署、升级与回滚（`executor-node` 独有） |
| `POST /api/update-package` · `GET /api/update-package/status` | 执行器令牌 | 执行器自更新与状态查询 |
| `POST /api/config/reload` | 执行器令牌 | 运行时并发度、心跳周期等配置热重载 |
| `POST /api/shutdown` | 执行器令牌 | 触发优雅停机排空（返回 202） |

## 快速开始

前置要求：Node.js `>= 24`。

```bash
cd apps/executor-node
npm install

# 开发模式（热重载）
npm run dev

# 生产构建与启动
npm run build
npm start
```

## 常用环境变量

配置定义位于 `src/config.ts`：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8002` | HTTP 监听端口 |
| `ADMIN_API_URL` | `http://admin-api:3105` | Admin API 基地址 |
| `EXECUTOR_ADDRESS` | `executor-node:8002` | 向中台注册的执行器内部地址 |
| `EXECUTOR_ADDRESS_PUBLIC` | 同 `EXECUTOR_ADDRESS` | 对外可达地址（Push 回调/派发地址） |
| `EXECUTOR_SECRET` | — | 与 `admin-api` 对齐的共享注册密钥（兼容旧变量 `EXECUTOR_SHARED_TOKEN`） |
| `EXECUTOR_PULL_MODE` | `false` | 设为 `true` 启用 Pull 长轮询模式 |
| `MAX_CONCURRENT_TASKS` | `10` | 最大并发任务数（钳制范围 `1..10000`） |
| `HEARTBEAT_INTERVAL_SECONDS` | `30` | 心跳间隔秒数（钳制范围 `5..60`） |
| `NPM_REGISTRY_URL` | 空（公共 npm） | 私有 npm 仓库地址（如 `http://registry-npm:4873`，不含内嵌凭据） |
| `NPM_REGISTRY_TOKEN` / `NPM_REGISTRY_USER` / `NPM_REGISTRY_PASS` | 空 | 私有 npm 仓库凭据（token 优先，Basic 回落） |
| `DISK_WARN_PERCENT` / `DISK_CRITICAL_PERCENT` | `90` / `95` | 磁盘水位告警（紧急清理）与临界水位（拒绝新任务） |
| `PACKAGE_DOWNLOAD_MAX_BYTES` | `209715200`（200 MiB） | 单包下载体积上限 |

## 测试与校验

```bash
npm test              # Jest 单元测试（覆盖率门禁见 package.json）
npm run lint          # ESLint 检查
npx tsc --noEmit      # TypeScript 类型检查
```

## 相关文档

- [执行器协议契约（executor-protocol）](../../packages/executor-protocol/README.md)
- [桌面执行器（executor-desktop）](../executor-desktop/README.md)
- [私有 npm 仓库（registry-npm）](../registry-npm/README.md)
- [SDK 使用指南](../../docs/sdk-guide.md)
- [部署指南](../../docs/deployment.md)
