# AutoCodeFlow Agent Handoff

> 跨会话交接文档：新会话从这里恢复。
> 状态以代码与 `docs/optimization-notes.md` 为准，文档可能滞后。

更新时间：2026-09-02
当前分支：`develop`

## 状态快照

- 最新提交：见 `git log -1`
- 测试基线（全绿）：
  - admin-api **669/669** (jest, 47 suites) — 第五轮真机缺陷修复 +64 测试
  - executor-node **119/119** (jest, 5 连跑稳定)
  - executor-python **86/86** (pytest)
  - admin-web vitest **15/15** / acf-cli vitest **41/41** / mcp-server vitest **40/40**
  - admin-api / executor-node / acf-cli / mcp-server `tsc --noEmit` 全部通过
  - admin-web `npm run build` ✓ / lint 0 errors（5 warnings 基线）
- 本轮（2026-09-02 第三轮，4 并行 stream + 集成 + 文档验收，7 个 commit）：
  - `8bb3790` **调度器多实例（P0）**：Leader Election（`scheduler:leader` 锁 TTL 30s、TTL/2 续约校验、Redis 挂时 fail-open）+ `claimTaskTrigger` 条件 UPDATE 原子领取；recoverStaleExecutions 分批；TASK-007 依赖深度上限 64；TASK-008 SSE 并发上限（per-execution 4 / global 64，超限 503）；DB-001 task 软删除；DB-003 N+1 收敛
  - `7851ebd` **通知/AI/Webhook**：NOTIF-002 摘要脱敏截断；NOTIF-003 silences 上限 1000 + 定时清理；AI-002 `fallback` 标记（task 层响应已透传）；APP-001 webhook 失败统一 401；APP-002 缺 API_BASE_URL fail-fast；ARCH-003 上传走 `UploadApplicationDto`
  - `723efbf` **架构（ARCH-001..008）**：CORS 白名单 `CORS_ALLOWED_ORIGINS`；**/uploads 强制鉴权**（JWT 或 executor 共享 token）；全局限流 60/min；`REDIS_TLS`；`DB_SYNCHRONIZE` 显式；swagger 生产关闭；unhandledRejection 优雅退出；死代码 4 处删除
  - `b1fbbef` **数据库（DB-002/004/005/006/007）**：日志保留清理服务（`LOG_RETENTION_DAYS`=30，每日 03:30 分批 DELETE）；application_version 唯一索引；迁移 2685→2694 重命名（幂等）；username varchar(128)；system_config.value 显式 text；migrations.spec 时间戳唯一性守卫
  - `eadedca` **executor-node**：包下载携带 `Authorization: Bearer <共享token>`，跨主机重定向剥离 token
  - `295e3b1` **文档验收阶段发现的 2 个代码 bug 修复**：configuration.ts 补注册 `sse` 配置节（此前 `SSE_MAX_STREAMS_*` env 覆盖是死代码，task.service.ts 读不到）+ CreateExecutorPackageDto 删除必填 `filePath`/`fileSize`（服务端从上传文件推导，真实 multipart 请求被全局 ValidationPipe 400 拒绝）
  - 新增环境变量：`CORS_ALLOWED_ORIGINS`、`THROTTLE_LIMIT`/`THROTTLE_TTL`、`REDIS_TLS`/`REDIS_TLS_REJECT_UNAUTHORIZED`、`DB_SYNCHRONIZE`、`LOG_RETENTION_DAYS`、`SSE_MAX_STREAMS_PER_EXECUTION`/`SSE_MAX_STREAMS_GLOBAL`（自 `295e3b1` 起真正生效）；`API_BASE_URL` 上传包时必需
- 本轮（2026-09-02 第四轮，全新对抗性排查：4 路只读 audit → 负责人 triage → 7 路 fix，5 个代码 commit；详见 `docs/PROGRESS-round4-2026-09-02.md` 与 `docs/review_round4_*.md`）：
  - `d2613d6` **调度/任务链 2P0+2P1**：触发去重锁被 watchdog 无限续期致每任务只触发一次（acquireLock 新增 renew 选项，trigger 锁 renew:false）；依赖任务链死代码（worker 永不写 SUCCESS）迁入 handleCallback 赢家路径；多页日志回填丢页（storeLogLines append 语义）；COVER_EARLY 盲写改条件 UPDATE
  - `b0aa67f` **安全 2P1+6P2**：RolesGuard 全局注册 + config 写端点/共享 token/executor-package 收紧 @Roles(ADMIN)（@Public 机器端点用空 @Roles() 覆盖）；heartbeat/register 列注入白名单（原 Object.assign 可覆写 tokenHash 成持久后门）；SSRF 层新增 assertSafeExecutorUrl 接入 dispatch/broadcast/reload/push + 3 通知渠道；登录枚举时序拉平；callback 限流 + token 校验 60s 缓存；trust proxy 改 `TRUST_PROXY=true` 才启用；SSE 仅 /logs/stream 路径接受 `?access_token=`；config/history 与 audit 筛选 QueryDto（修恒 400）
  - `f792e10` **executor-python 1P0+1P1+12 项**：shell entrypoint 注入（白名单+位置参数，对齐 node 6062bee）；日志 10MB/64MB 上限；回调重试退避；git 缓存 hash 盐；REQUIRE_TOKEN fail-closed 等
  - `f0f61e5` **executor-node 5P1+8 项**：callback ≤100 分片 + dead-letter 毒文件终态；部署子进程 env 白名单（共享 token 不再透传给被管应用）；NODE_PATH 修 requirements 不可解析；BoundedLogBuffer；TTL 磁盘回收；共享下载器（Bearer+deadline+防穿越）；spawnSync→async；进程组 kill
  - `75c8d2b` **客户端契约 2P0+7P1**：CLI login accessToken（原字段名错致 CLI 全 401）；应用编辑不发 name；安装向导走 install-cmd（后端删坏 curlCmd）；包下载带 auth fetch；AI 分析字段对齐；SSE 参数名；trigger executorId 移除
  - 新增环境变量：`TRUST_PROXY`（默认 false——**nginx 后部署必须设 true**，否则限流键/审计 IP 全变代理 IP）、`EXECUTOR_ALLOW_PRIVATE_NETWORK`（默认 false：executor 出站放行私网段但拒 loopback/元数据；**同机 127.0.0.1 executor 部署必须设 true**）
- 本轮（2026-09-02 第五轮，收尾 + **首次真机验证**：4 代码流 + V/W1/W2/V2，7 个代码 commit；详见 `docs/PROGRESS-round5-2026-09-02.md`、`docs/VERIFY-round5-e2e.md`、`docs/VERIFY-round5v2-n2.md`）：
  - `0a7ebcb` 依赖扇出 10s DB claim（双上游并发只触发一次）+ checkDependencies take 兜底；storeLogLines DB 路径事务化；**可观测性**：SchedulerMetricsService（tick/claimed/skipped/failed 进程内计数）+ BullMQ 队列深度 + `GET /metrics/scheduler`（零新依赖）
  - `1864597` executor-node flake 元凶坐实：file-logger spec 用 UTC 日期而生产按本地时区（超前时区机器每天 8 小时确定性失败）；4 spec 确定性化，5 连跑全绿 + 5 种 TZ 交叉
  - `51469d6` audit 两端点收紧 ADMIN；删除孤儿 install-token 端点；admin-web 角色门控（role 唯一来源 `GET /auth/profile`——登录响应无 user 字段；RequireAdmin 路由守卫 + 菜单隐藏 + settings 写禁用）
  - `9e8f2ae` CLI/MCP P1 补全（applications CRUD、deploy upgrade/stop、task versions/rollback/compare、executor get、audit list）+ 5 个既有契约 bug 顺带修 + 两包 vitest 基建
  - `2642293` **真机发现 N2(P0) 修复**：PG enum 列运行时返回字符串 label（'normal'），原样传 BullMQ 致**所有调度入队 100% 失败**（单测全 mock queue 故从未暴露）——normalizeTaskPriority 入队边界归一化；N3 readyClient 消 ~15s 假 Leader；N4 register 幂等（同 address+startupId 不再轮换 token）；N5 stale cutoff 动态化；N6 去重锁 TTL 按触发周期（修 15s 任务被压成 300s）
  - `d2be430` **真机发现 N1(P1) 修复**：全新 DB 迁移链 3 处断裂（app_deployments 无建表、version 列撞名、rename 时序）幂等化 + CreateAppDeploymentsTable 补偿迁移 + migrations.spec describe 守卫（修 typeorm CLI 崩）；docker postgres 空库 24/24 + 存量续跑数据无损双验证
  - V 真机验证（`b2be111`）：Leader Election 双实例 80 execution 无重复、kill 后 35s 接管；LOG-11 S3 对象闭环；负载均衡精确 2+2——**三项全通过**；V2 复验 N2/N6/N3/N1 修复全部生效（96/96 success）
- ⚠️ 部署注意事项：
  - **/uploads 鉴权是破坏性变更**：executor-node 必须升级到含 `eadedca` 的版本，否则下载应用包 401
  - **第四轮 RBAC 是行为变更**：普通用户访问 config 写端点/executor-packages 全部改判 403；前端未做角色门控（可见但操作 403），admin-web 需与 admin-api 同批发布（SSE `?access_token=`、编辑不发 name、下载带 auth 均依赖新后端）
  - **acf-cli 必须重新分发**：`75c8d2b` 前所有 CLI 登录即失效链（token=undefined）
  - executor-node/python 建议随轮升级（callback 分片、env 白名单、注入修复）；部署的应用若曾偷读 EXECUTOR_SHARED_TOKEN 会因 env 白名单失效
  - DB-005 重命名迁移会在已有环境重跑一次（幂等 up/down，安全）；DB-002 唯一索引迁移重写 application_version 表，建议维护窗口执行
  - SSE 并发计数为进程内：多实例实际上限 = 实例数 × 64
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

> 第四轮 11 项中 10 项已在第五轮完成（含首次真机验证三项全通过）。以下为第五轮后剩余：

1. **N6 残留节奏抖动**：fixed_rate 去重锁 TTL=周期存在亚秒竞态，实测 15s/30s 抖动（V2 记录）——建议 TTL=周期×0.9 或收紧 DB claim 双保险窗口；顺带评估 `POST /api/tasks` 字符串 id 报 500（CreateTaskDto 缺 uuid 校验）。
2. **CI 流水线**：测试基建已确定性化（J 修复后 5 连跑全绿 + TZ 交叉），可上 CI 了——建议 GitHub Actions：五端 jest/pytest/vitest + tsc + lint + 迁移链空库/存量双轮验证（W2 的 docker postgres 脚本可直接搬）。
3. **桌面执行器跨平台**：macOS Apple Silicon / WSL2 矩阵验证；executor-node 崩溃后跨重启进程 sweep 需与 desktop 生命周期协同（第四轮 G2 遗留）。
4. **install.sh 一键安装**：实现静态脚本 + install-script 路由（第五轮已删孤儿 install-token 端点，未来随 install.sh 一并重建）；任务级 executor pinning（TriggerTaskDto 扩展）。
5. **可观测性升级**：当前为进程内计数 + JSON 端点（`GET /metrics/scheduler`），如需接 Prometheus 抓 prom-client（评估依赖体积）或 OTel。
6. **通知渠道真机**：企业微信/钉钉/邮件实测（SSRF 收紧后外发 URL 需白名单验证）；私有 npm/PyPI 仓库集成。

## 未覆盖验证项

- macOS / Windows / ARM64 部署
- 通知渠道（企业微信/钉钉/邮件）实测
- 私有 npm/PyPI 仓库集成
- 大规模并发压测
- ~~多执行器负载均衡~~ ✅ 第五轮真机通过（双 executor 4 并发精确 2+2、无超卖）
- ~~LOG-11 S3 真机 E2E~~ ✅ 第五轮真机通过（minio 对象 + gunzip 内容一致 + API 读取闭环）
- ~~Leader Election 双实例~~ ✅ 第五轮真机通过（80 execution 无重复、kill 后 35s 接管；V2 复验修复后 96/96 success）

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