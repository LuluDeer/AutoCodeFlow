# AutoCodeFlow Agent Handoff

> 跨会话交接文档：新会话从这里恢复。
> 状态以代码与 `docs/optimization-notes.md` 为准，文档可能滞后。

更新时间：2026-09-02
当前分支：`develop`

## 状态快照

- 最新提交：见 `git log -1`
- 测试基线（全绿）：
  - admin-api **518/518** (jest, 37 suites) — 第三轮 review 修复 +86 测试
  - executor-node **79/79** (jest)
  - executor-python **44/44** (pytest)
  - admin-api / executor-node / acf-cli / mcp-server `tsc --noEmit` 全部通过
  - admin-web `npm run build` ✓ / lint 0 errors
- 本轮（2026-09-02 第三轮，4 并行 stream + 集成 + 文档验收，7 个 commit）：
  - `8bb3790` **调度器多实例（P0）**：Leader Election（`scheduler:leader` 锁 TTL 30s、TTL/2 续约校验、Redis 挂时 fail-open）+ `claimTaskTrigger` 条件 UPDATE 原子领取；recoverStaleExecutions 分批；TASK-007 依赖深度上限 64；TASK-008 SSE 并发上限（per-execution 4 / global 64，超限 503）；DB-001 task 软删除；DB-003 N+1 收敛
  - `7851ebd` **通知/AI/Webhook**：NOTIF-002 摘要脱敏截断；NOTIF-003 silences 上限 1000 + 定时清理；AI-002 `fallback` 标记（task 层响应已透传）；APP-001 webhook 失败统一 401；APP-002 缺 API_BASE_URL fail-fast；ARCH-003 上传走 `UploadApplicationDto`
  - `723efbf` **架构（ARCH-001..008）**：CORS 白名单 `CORS_ALLOWED_ORIGINS`；**/uploads 强制鉴权**（JWT 或 executor 共享 token）；全局限流 60/min；`REDIS_TLS`；`DB_SYNCHRONIZE` 显式；swagger 生产关闭；unhandledRejection 优雅退出；死代码 4 处删除
  - `b1fbbef` **数据库（DB-002/004/005/006/007）**：日志保留清理服务（`LOG_RETENTION_DAYS`=30，每日 03:30 分批 DELETE）；application_version 唯一索引；迁移 2685→2694 重命名（幂等）；username varchar(128)；system_config.value 显式 text；migrations.spec 时间戳唯一性守卫
  - `eadedca` **executor-node**：包下载携带 `Authorization: Bearer <共享token>`，跨主机重定向剥离 token
  - `295e3b1` **文档验收阶段发现的 2 个代码 bug 修复**：configuration.ts 补注册 `sse` 配置节（此前 `SSE_MAX_STREAMS_*` env 覆盖是死代码，task.service.ts 读不到）+ CreateExecutorPackageDto 删除必填 `filePath`/`fileSize`（服务端从上传文件推导，真实 multipart 请求被全局 ValidationPipe 400 拒绝）
  - 新增环境变量：`CORS_ALLOWED_ORIGINS`、`THROTTLE_LIMIT`/`THROTTLE_TTL`、`REDIS_TLS`/`REDIS_TLS_REJECT_UNAUTHORIZED`、`DB_SYNCHRONIZE`、`LOG_RETENTION_DAYS`、`SSE_MAX_STREAMS_PER_EXECUTION`/`SSE_MAX_STREAMS_GLOBAL`（自 `295e3b1` 起真正生效）；`API_BASE_URL` 上传包时必需
- ⚠️ 部署注意事项：
  - **/uploads 鉴权是破坏性变更**：executor-node 必须升级到含 `eadedca` 的版本，否则下载应用包 401
  - DB-005 重命名迁移会在已有环境重跑一次（幂等 up/down，安全）；DB-002 唯一索引迁移重写 application_version 表，建议维护窗口执行
  - SSE 并发计数为进程内：多实例实际上限 = 实例数 × 64；trigger 锁 TTL 未改（Leader 化后重复触发风险已大幅降低）
- 工作区：干净

## 会话恢复速查

```bash
# 各子项目独立运行命令，根目录无统一 workspace 入口
cd apps/admin-api && npx jest && npx tsc --noEmit -p tsconfig.json
cd apps/executor-node && npx jest
cd apps/executor-python && python3 -m pytest -q
cd apps/admin-web && npm run lint && npm run build
cd packages/acf-cli && npx tsc --noEmit
cd packages/mcp-server && npx tsc --noEmit
```

注意：
- `apps/executor-desktop/resources/executor-node/index.js` 是生成物，源码改 `apps/executor-node/src` 后走打包流程更新。
- admin-api 全局 `ResponseInterceptor` 把成功响应包成 `{ code, message, data }`，admin-web 在 `src/api/client.ts` 的 axios interceptor 自动拆包；CLI 与 MCP 已在 `packages/acf-cli/src/client.ts` 与 `packages/mcp-server/src/index.ts` 加上对称拆包逻辑（2026-09-02）。
- 文档可能比代码旧，以代码+测试交叉校验。

## 开发准则

1. 小步提交：一个方向一批改动，先补测试再改实现，提交前跑该子项目验证命令。
2. 每次提交信息用中文 conventional commits（feat/fix/docs/chore/refactor/test）。
3. 功能落地后同步更新 `docs/api-reference.md` 与 `docs/optimization-notes.md` 的状态标记。
4. 会话结束前更新本文件「状态快照」并提交。

## 长期路线图状态

| # | 方向 | 状态 |
|---|------|------|
| 1 | 版本历史与发布快照 | ✅ 已完成（含回滚） |
| 2 | 执行失败原因分类 | ✅ 已完成（executor 侧可再细化） |
| 3 | Webhook / API 认证模型 | ✅ 已完成（rawBody+时间戳 HMAC，Public 路由强制 secret） |
| 4 | 任务超时 / 时区 / 重试 | ✅ 已完成（trigger/rollback/scheduled 三入队路径均带 attempts+指数退避，processor 失败 rethrow 使 BullMQ 重试生效，均有单测） |
| 5 | 执行器重启恢复 + 负载感知 | ✅ 已完成（心跳携带 runningTaskCount，dispatch 按 loadScore=runningTaskCount/max 选最低负载 + 乐观锁防超发，广播模式不占计数，callback 释放槽位，均有单测） |
| 6 | 应用包版本隔离 | ✅ 已完成（不可变 release 目录 + current 软链 + 回退） |
| 7 | 心跳 / 注册稳定化 | ✅ 已完成（连通性自检、退避重试） |
| 8 | Admin Web 与 E2E | ✅ E2E 35/35（Linux x86_64）；平台矩阵未覆盖 |
| 9 | CLI 与 MCP 能力对齐 | ✅ 已完成本轮 P0（CLI: task CRUD/pause/resume/kill/logs/executions、app deploy/deployments/versions；MCP: get_application/deploy_application/kill_execution/pause_task/resume_task/list_deployments + 已有 list/get/analyze 套件）。ResponseInterceptor 拆包已在 CLI/MCP 两侧 client 解决 |
| 10 | SDK 统一与示例 | ⬜ 未系统梳理 |
| 11 | 日志外置存储（MinIO/S3） | ✅ 已完成（`LOG_STORAGE_DRIVER=s3` 可选驱动；callback 写入时优先 S3 失败回退 DB；读取时按 `exec.logStorage` 分流；集成测试 6/6） |
| 12 | 桌面执行器跨平台 | ⬜ 未验证 |

## 下一步建议（按优先级）

1. **端到端真机验证 LOG-11**：起 `docker compose --profile minio up -d minio admin-api`，触发一次任务执行，用 `mc` 验证 `autoflow-logs/execution-logs/<id>.log.gz` 存在，再调 `getExecutionLogs` 确认读到内容（见 LOG-11 subagent 报告的命令清单）。
2. **多执行器负载均衡实测**：单测覆盖 loadScore 选择与并发锁，但缺多实例真机验证——跑 2 个 executor + 高并发任务，看 runningTaskCount 是否均衡增长、callback 释放槽位是否正确。
3. **CLI/MCP P1 补全**：applications CRUD、deploy upgrade/stop、task versions/rollback/compare、executors 详情、audit 列表（subagent 已列缺口清单）。
4. **桌面执行器跨平台**：macOS Apple Silicon / WSL2 矩阵验证。
5. **调度器 Leader Election 真机验证**：起 2 个 admin-api 实例 + 同一 Postgres/Redis，配置密集 cron 任务，确认无重复触发、Leader 切换（kill Leader）后 ≤30s 接管。
6. **可观测性收尾**（REVIEW_MASTER §5.5）：调度 tick histogram / claimed-skipped-failed counter / 队列深度 gauge 接入 MetricsService；review docs 中 39 项此轮后基本清零，剩余为观测性与真机验证类。

## 未覆盖验证项

- macOS / Windows / ARM64 部署
- 通知渠道（企业微信/钉钉/邮件）实测
- 私有 npm/PyPI 仓库集成
- 多执行器负载均衡（逻辑已单测，多实例实测待办）
- 大规模并发压测
- LOG-11 S3 真机 E2E（mock 集成测试已 6/6）

## 本轮变更要点（参考）

- **admin-api**：
  - `task.controller.ts` 新增 `GET /tasks/executions/:execId` 与 `GET /tasks/executions/:execId/logs`（compat alias，供 CLI/MCP 直接按 execId 查询）。
  - `task.service.ts` `getExecutionLogs` / `streamExecutionLogs` 增加 S3 分流；`storeLogLines` callback 路径优先 S3 上传 + 失败回退 DB；新增 enqueue 失败时把 PENDING 行标 FAILED（防 Redis 挂时悬挂）。
  - `executor.entity.ts` 把 executor 上报字段 `version` 重命名为 `executorVersion`，新增 TypeORM `@VersionColumn() version: number`（乐观锁）；`address` 加唯一索引 `uq_executors_address`。
  - `executor.service.ts` `selectLeastLoaded` / `dispatch` / `getTags` / `findAll` 加 `take` 上限；broadcast 路径保留全量（注释说明）。
  - `scheduler.service.ts` 新增「PENDING 超时回收」（10 分钟 grace 后置 FAILED）+ `schedulingTasks` Set 防 reload 与 scheduleOne 同 task 并发注册。
  - `main.ts` `POST /api/executions/callback` 路由单独配 55mb JSON limit（兼容批量回调），其它路由仍 1mb cap。
  - `verify-executor-token.util.ts` fail-closed timingSafeEqual（与 executor-node 端符号对齐）。
  - `task-execution.entity.ts` 新增 `logStorage` / `logObjectKey` 列；迁移 `1717473142690-AddExecutionLogStorage.ts`。
- **executor-node**：deploy/execute/health/logs 路径加固；connectivity 重试；file-logger 截断 marker 与 admin-api LOG-01 检测对齐。
- **admin-web**：`Executor.version → executorVersion`、`auth /me → /profile`、executor shared-token 路由迁移、`any` → `unknown`、未用 imports 删、空 catch 加注释、`_pollStartTime` state 移除；lint 0 errors。
- **acf-cli**：HTTP client 自动拆 ResponseInterceptor envelope；`task create/update/delete/pause/resume/kill/logs`、`app deploy/deployments/versions`、`task executions` 全部走正确路径与字段名。
- **mcp-server**：同 HTTP 拆包；新增 `kill_execution` / `pause_task` / `resume_task` / `list_deployments`；已有 `get_application` / `deploy_application` / `get_execution_logs` 配套。
- **docker-compose.yml**：minio profile（端口 9000/9001，volume，healthcheck）+ admin-api 注入 7 项 `LOG_STORAGE_*` 默认值。