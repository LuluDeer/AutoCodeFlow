# AutoCodeFlow Agent Handoff

更新时间：2026-08-13
当前分支：`develop`
最新提交：`76ab59f chore: update executor and migrate admin queue`

## 本轮已完成

- 已提交当前工作区改动：`76ab59f chore: update executor and migrate admin queue`
- 本轮重点包含：
  - executor 相关依赖与桌面执行器资源更新
  - `admin-api` 队列从 Bull 迁移到 BullMQ
  - `admin-api` audit/build/相关队列单测验证通过
- 验证命令与结果：
  - `npm --prefix apps/admin-api audit --audit-level=moderate`：`found 0 vulnerabilities`
  - `npm --prefix apps/admin-api run build`：通过
  - `npm --prefix apps/admin-api test -- --runInBand src/modules/task/__tests__/task.processor.spec.ts src/modules/task/__tests__/task.service.spec.ts src/modules/scheduler/__tests__/scheduler.service.spec.ts`：79/79 通过

## 项目概览

AutoCodeFlow 是一个分布式任务调度与执行平台，核心链路是：

`admin-api` 管理与调度 → `executor-node` / `executor-python` / `executor-desktop` 执行任务 → `admin-web` 管理运营 → SDK / CLI / MCP 支持开发者与 AI agent 集成。

主要模块：

- `apps/admin-api`
  - NestJS 后端主服务。
  - 覆盖 auth、users、task、application、executor、executor-package、notification、registry、metrics、audit、config、scheduler、ai、health 等模块。
  - 重点能力：任务管理、应用部署、执行器注册与心跳、日志与指标、通知、AI 辅助、Webhook 部署。

- `apps/admin-web`
  - React + Vite + Ant Design 管理台。
  - 页面覆盖任务、应用、执行器、执行记录、通知、私有仓库、用户、部署、安装向导、AI 等。
  - 有 Vitest 和 Playwright E2E。

- `apps/executor-node`
  - Node.js 执行器。
  - 包含任务执行、调度、配置、心跳、日志、更新包等路由。

- `apps/executor-python`
  - FastAPI 执行器。
  - 包含注册、执行、健康检查、日志、配置热更新、调度。
  - 测试较完整，适合 Python 任务生态。

- `apps/executor-desktop`
  - Electron 桌面执行器。
  - 包含主进程、托盘、心跳、配置持久化、子进程管理、窗口管理、开机自启、历史记录。
  - 注意：`resources/executor-node/index.js` 是生成物，源码来源是 `apps/executor-node/src`，不要直接手改生成物。

- `packages`
  - `acf-cli`：终端 CLI。
  - `mcp-server`：给 AI agent 用的 MCP 服务。
  - `autoflow-sdk`：Python SDK。
  - `autoflow-sdk-node`：轻量 Node SDK。
  - `autocodeflow-node-sdk`：完整 Node SDK。
  - `autocodeflow-ai` / `autocodeflow-db` / `autocodeflow-http` / `autocodeflow-notify`：辅助库。

- `docs`
  - 有开发、部署、运维、API、SDK、优化建议、版本发布检查等文档。
  - `docs/optimization-notes.md` 很适合作为后续路线图来源。

- `infra`
  - Docker Compose、Nginx 等基础设施配置。

## 长期推进方向

### 1. 补齐版本历史与发布快照

目标：让应用发布、热更新、回滚具备可追溯版本历史，避免 `/applications/:id/versions` 为空导致回滚不可用。

建议切入：

- `apps/admin-api/src/modules/application/app-deployment.service.ts`
- `apps/admin-api/src/modules/task/entities/task-version.entity.ts`
- `apps/admin-web/src/pages/ApplicationDetailPage.tsx`
- `docs/optimization-notes.md`

验收方式：

- 部署成功后自动写入版本快照。
- 前端能看到历史版本列表。
- 回滚接口可从历史版本恢复。
- E2E 覆盖“上传新包 → 部署 → 查询版本 → 回滚”。

### 2. 细化执行失败原因与日志可观测性

目标：把失败原因从笼统的 `failed` 拆成可诊断的枚举，例如包拉取失败、脚本错误、超时、执行器离线。

建议切入：

- `apps/admin-api/src/modules/task/entities/task-execution.entity.ts`
- `apps/admin-api/src/modules/task/task.service.ts`
- `apps/admin-api/src/modules/metrics/metrics.service.ts`
- `apps/admin-web/src/pages/ExecutionDetailPage.tsx`

验收方式：

- 执行记录页面展示明确失败分类。
- 日志与错误提示能对应具体根因。
- 至少覆盖 `package_fetch_failed`、`script_error`、`timeout`、`executor_offline`。

### 3. 强化 Webhook / API 认证模型

目标：减少对长期用户 token 的依赖，提升 CI/CD webhook 安全性。

建议切入：

- `apps/admin-api/src/modules/application/app-deployment.controller.ts`
- `apps/admin-api/src/modules/application/dto/app-release-webhook.dto.ts`
- `apps/admin-api/src/modules/auth`
- `docs/api-reference.md`

验收方式：

- 支持专用 webhook secret 或限权 API key。
- 文档明确不同触发方式的认证边界。
- 旧 token 方案兼容或有清晰迁移路径。

### 4. 任务级超时、时区、重试策略统一

目标：让任务调度更接近生产需要，避免长任务占满执行器、cron 跨时区错乱、失败不可控。

建议切入：

- `apps/admin-api/src/modules/task/dto/create-task.dto.ts`
- `apps/admin-api/src/modules/task/task.service.ts`
- `apps/admin-api/src/modules/scheduler/scheduler.service.ts`
- `packages/autoflow-sdk/tests/test_models.py`
- `docs/sdk-guide.md`

验收方式：

- 任务可配置 `timeoutSeconds`。
- cron 可配置 `timezone`。
- 任务失败重试策略有测试覆盖。
- SDK 和文档同步支持相关字段。

### 5. 执行器重启恢复与负载感知调度

目标：避免执行器重启后运行中任务悬挂，并逐步引入更合理的执行器选择策略。

建议切入：

- `apps/admin-api/src/modules/executor/executor.service.ts`
- `apps/admin-api/src/modules/scheduler/scheduler.service.ts`
- `apps/executor-node/src/main.ts`
- `apps/executor-python/main.py`
- `docs/optimization-notes.md`

验收方式：

- 执行器重启后上报重启时间。
- `admin-api` 可识别并修正悬挂任务状态。
- 调度优先选择低负载执行器。
- 单测或集成测试覆盖负载选择逻辑。

### 6. 应用包版本隔离与回滚路径

目标：让应用热更新具备版本目录隔离，避免新版本失败时覆盖旧版本，提升回滚安全性。

建议切入：

- `apps/executor-node/src/routes/deploy.ts`
- `apps/executor-node/src/routes/update-package.ts`
- `apps/executor-desktop/src/main/executor-process.ts`
- `docs/optimization-notes.md`

验收方式：

- 解压目录按版本隔离。
- 新版本失败可快速切回旧版本。
- 热更新流程有回滚测试或 E2E 验证。

### 7. 执行器心跳、注册与健康检查稳定化

目标：提高 executor 在线状态判断准确性，减少误判下线和环境配置错误排查成本。

建议切入：

- `apps/executor-node/src/routes/health.ts`
- `apps/executor-node/src/middleware/auth.ts`
- `apps/executor-node/src/admin-client.ts`
- `apps/executor-python/routers/health.py`
- `apps/executor-python/admin_api.py`
- `apps/executor-desktop/src/main/heartbeat.ts`

验收方式：

- 启动即做 `/health` 连通性自检。
- 401/429/超时等错误有明确日志。
- 注册、心跳、注销链路在 Node/Python executor 中一致。
- 测试覆盖“错误 API 地址”“token 不一致”“心跳失败”。

### 8. Admin Web 操作流与 E2E 稳定性

目标：把管理后台从“能用”推进到“可长期依赖”，减少回归风险，提升关键操作流体验。

建议切入：

- `apps/admin-web/src/pages/*`
- `apps/admin-web/src/api/*`
- `apps/admin-web/e2e/*.spec.ts`
- `apps/admin-web/playwright.config.ts`

验收方式：

- 登录、任务 CRUD、应用部署、执行记录查看等主流程 E2E 全通过。
- 前端单测覆盖 auth store 和关键组件。
- 关键页面错误状态与空状态更清晰。
- CI 中前端 build 和 E2E 稳定通过。

### 9. CLI 与 MCP 能力对齐

目标：让人类和 AI agent 都能用一致的命令/工具操作平台，减少“前端有、CLI 没有、MCP 也没有”的能力断层。

建议切入：

- `packages/acf-cli/src/commands/*`
- `packages/mcp-server/src/index.ts`
- `packages/mcp-server/README.md`
- `docs/api-reference.md`

验收方式：

- CLI 与 MCP 的核心 CRUD / trigger / analyze 能力对齐。
- `acf task list/trigger` 与 MCP 工具覆盖同类操作。
- 文档能一一对应到 API 资源。

### 10. SDK 包统一与示例完善

目标：统一 Node/Python SDK 的命名、能力边界和示例质量，减少开发者接入成本。

建议切入：

- `packages/autoflow-sdk/pyproject.toml`
- `packages/autoflow-sdk-node/package.json`
- `packages/autocodeflow-node-sdk/package.json`
- `packages/autocodeflow-http/pyproject.toml`
- `packages/autocodeflow-notify/pyproject.toml`
- `docs/sdk-guide.md`
- `examples/desktop-automation/*`

验收方式：

- 包命名、导出结构、文档说明更一致。
- SDK 单测覆盖 context/http/logger/result 等核心能力。
- 示例可直接跑通，且与文档一致。

### 11. 日志存储与大规模执行历史治理

目标：解决执行日志长期写主库带来的膨胀与查询压力。

建议切入：

- `apps/admin-api/src/modules/task/entities/execution-log-line.entity.ts`
- `apps/admin-api/src/modules/task/task.service.ts`
- `apps/admin-api/src/modules/metrics`
- `infra/docker-compose.yml`

验收方式：

- 日志可按对象存储或文件存储落地。
- 数据库只保留索引与引用。
- 大日志场景仍能流式查看。
- 查询性能有明显改善。

### 12. 桌面执行器跨平台与托盘体验

目标：把 executor-desktop 从“功能可用”推进到“跨平台安装与稳定托盘运行”。

建议切入：

- `apps/executor-desktop/src/main/*`
- `apps/executor-desktop/src/renderer/pages/*`
- `apps/executor-desktop/electron-builder.yml`
- `apps/executor-desktop/README.md`

验收方式：

- 配置向导、托盘、开机自启、状态窗口流程稳定。
- build/dist 在目标平台上可产出。
- 与 executor-node 的打包来源关系清晰，不手改生成物。

## 推荐推进优先级

1. 稳定性和可观测性：版本历史、失败原因、心跳、重启恢复、日志治理。
2. 平台化与体验：Admin Web、CLI/MCP、SDK、一致性文档。
3. 规模与跨平台：desktop 多平台、日志外置、多租户、负载调度。

## 新会话 Agent 注意事项

- 当前仓库更适合按子项目运行命令，不要假设根目录有统一 workspace 入口。
- 修改前先确认对应子项目的 `package.json` / `pyproject.toml` / `pytest.ini` / 测试命令。
- `apps/executor-desktop/resources/executor-node/index.js` 是生成物，源码应改 `apps/executor-node/src`，再通过对应打包流程更新资源。
- 文档有些内容可能比代码更“新”，需要以代码和测试现状交叉校验。
- 优先看测试边界：
  - `apps/admin-web/e2e/*`
  - `apps/executor-node/src/*.spec.ts`
  - `apps/executor-python/tests/*`
  - `packages/*/tests` 和 `src/__tests__`
- 每轮推进建议保持小步提交：先选择一个方向，补测试，再改实现，再跑该子项目验证命令。

## 建议下一步

如果新会话 agent 不知道从哪里开始，建议优先选择“补齐版本历史与发布快照”。这是贯穿 `admin-api`、`admin-web`、执行器更新/回滚、E2E 验证的主线，长期价值最高，也能自然带出后续日志、失败原因和回滚体验优化。
