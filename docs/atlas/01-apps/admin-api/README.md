# admin-api 应用总览

> 所属: docs/atlas/01-apps/admin-api · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src

## 一句话定位

admin-api 是 AutoCodeFlow 的 **NestJS 后端单体服务**：承载管理台全部 REST 接口（认证、任务、执行器、应用部署、审计、指标等），同时是执行器的回调入口（执行结果/日志/心跳上报）与 BullMQ 调度的大脑（Cron 入队 + 任务分发）。

## 技术栈与版本（摘自 apps/admin-api/package.json）

| 类别 | 依赖 | 版本 |
|---|---|---|
| 框架 | @nestjs/common、core、platform-express | ^11.1.29 |
| ORM / 数据库 | @nestjs/typeorm、typeorm、pg（PostgreSQL） | ^11.0.3 / ^0.3.17 / ^8.11.3 |
| 队列 | @nestjs/bullmq、bullmq（Redis） | ^11.0.5 / ^6.1.0 |
| Redis 客户端 | ioredis、redis | ^5.3.2 / ^5.12.1 |
| 认证 | @nestjs/jwt、@nestjs/passport、passport-jwt、bcrypt | ^11.0.2 / ^11.0.5 / ^4.0.1 / ^6.0.0 |
| 限流 | @nestjs/throttler | ^6.5.0 |
| 配置校验 | @nestjs/config、joi | ^4.0.4 / ^18.2.1 |
| 文档 | @nestjs/swagger、swagger-ui-express | ^11.4.5 / ^5.0.1 |
| 指标 | prom-client | ^15.1.3 |
| 定时任务 | @nestjs/schedule | ^6.1.3 |
| 安全 | helmet | ^8.2.0 |
| 其他 | minio（产物 S3）、nodemailer（邮件）、axios | ^8.0.7 / ^9.0.5 / ^1.17.0 |
| 语言 | typescript | ^5.1.3 |

常用命令（apps/admin-api 下）：`npm run start:dev`（watch 启动）、`npm run build`、`npm run start:prod`（`node dist/main`）、`npm run migration:run|revert|generate`（走 `src/data-source.ts`）、`npm run typecheck`、`npm run test`、`npm run test:e2e`。

## 启动引导链

```
main.ts
 ├─ 1. loadEnvFile(.env)          预载 .env（先于 app.module 进入 import graph，
 │                                   @Throttle 等装饰器求值期读 env 的 W-22 修复）
 ├─ 2. NestFactory.create(AppModule)
 │      app.module.ts:
 │        ConfigModule.forRoot       .env + configuration() + Joi 校验（isGlobal）
 │        ThrottlerModule            全局限流（THROTTLE_ENABLED=false 全域旁路）
 │        TypeOrmModule.forRootAsync buildTypeOrmDataSourceOptions()（含读写分离）
 │        BullModule.forRootAsync    Redis/BullMQ 连接 + job 保留策略
 │        22 个业务模块 + DomainEventModule/TracingModule（@Global）
 │        APP_GUARD 注册顺序: ThrottlerGuard → JwtAuthGuard → RolesGuard
 │        configure(): TraceIdMiddleware 挂到所有路由
 ├─ 3. 中间件/管道装配
 │      /api/executions/callback 专用 55mb json 解析；全局 1mb
 │      helmet（生产收紧 CSP）；trust proxy 仅 TRUST_PROXY=true 时开启
 │      enableCors（CORS_ALLOWED_ORIGINS 白名单，dev 默认仅 localhost）
 │      /uploads 静态目录 → createUploadAuthMiddleware（JWT 或执行器 token）
 ├─ 4. setGlobalPrefix("api")
 │      ValidationPipe(whitelist+transform+forbidNonWhitelisted)
 │      HttpExceptionFilter；Timeout → ClassSerializer → Response 拦截器
 ├─ 5. Swagger（仅非 production，挂 /api/docs）
 └─ 6. enableShutdownHooks + installShutdownForceExitGuard + listen(app.port)
```

## 全局目录结构（apps/admin-api/src）

| 目录/文件 | 职责 |
|---|---|
| `main.ts` | 引导：预载 .env、中间件装配、全局前缀/管道/过滤器/拦截器、Swagger、优雅停机 |
| `app.module.ts` | 模块装配中心：全部 env 的 Joi schema、DB/Redis/限流注册、全局 guard 注册 |
| `common/` | 跨模块横切件：decorators（`@Public()`/`@Roles()`/`@CurrentUser()`）、guards（jwt-auth、roles）、interceptors（response/timeout）、filters、middleware（trace-id、upload-auth）、services（domain-event-bus、redis-lock）、tracing（OpenTelemetry）、utils |
| `config/` | `configuration.ts`（配置树唯一来源 + `buildTypeOrmDataSourceOptions`）、`env.ts`（`getEnvVar`，供装饰器求值期/迁移 CLI 读取）、`throttle-profiles.ts`（AUTH_THROTTLE/OPS_THROTTLE 限流档） |
| `migrations/` | 60 个 TypeORM 迁移（1717473142678-InitialSchema 起，1790000000015-CreateProjectMembers 止）+ `migrations.spec.ts` 守护测试 |
| `data-source.ts` | 仅供 migration CLI 使用的独立 DataSource（不经 NestDI，经 `getEnvVar` 读 env） |
| `modules/` | 业务模块，见下表 |
| `__tests__/`、`@types/` | 进程级 spec（如 main-env-preload.spec.ts）与类型声明 |

## 模块索引（src/modules 下全部真实模块）

| 模块 | 一句话职责 | 文档 |
|---|---|---|
| auth | 登录/JWT 签发/refresh token 轮换/TOTP 2FA/会话管理 | [modules/auth.md](modules/auth.md) |
| users | 用户 CRUD、管理员种子、账号锁定计数 | [modules/users.md](modules/users.md) |
| api-keys | `acf_` 前缀限权 API Key（CI/CD 机器凭证 + 全局 guard 分支） | [modules/api-keys.md](modules/api-keys.md) |
| application | 应用（Application）、版本快照、部署（AppDeployment）与审批/灰度 | [modules/application.md](modules/application.md) |
| project | 多租户项目与项目成员角色（viewer/editor/admin） | [modules/project.md](modules/project.md) |
| audit | 审计日志（append-only 触发器 + 180 天保留） | [modules/audit.md](modules/audit.md) |
| health | 健康/就绪/存活检查（DB/Redis/队列/执行器/调度器） | [modules/health.md](modules/health.md) |
| config | 系统配置键值（system_configs）+ 配置历史与回滚 | [modules/config.md](modules/config.md) |
| metrics | Dashboard 指标查询 + Prometheus 抓取端点 + SSE 流 + execution_reports 日聚合 | [modules/metrics.md](modules/metrics.md) |
| task | 任务 CRUD/触发/执行回调（`/tasks`、`/tasks-batch`、`/executions`） | [任务模块](modules/task.md)（下一批次） |
| scheduler | Cron 调度器（BullMQ 入队、调度指标） | [调度模块](modules/scheduler.md)（下一批次） |
| executor | 执行器注册/心跳/管理（`/executors`） | [执行器模块](modules/executor.md)（下一批次） |
| executor-package | 执行器安装包分发（`/executor-packages`） | [executor-package.md](modules/executor-package.md)（下一批次） |
| artifacts | 执行产物存储与下载（MinIO/S3） | [产物模块](modules/artifacts.md)（下一批次） |
| notification | 通知渠道配置 + 告警入口（`/notification`、`/alerts`） | [通知模块](modules/notification.md)（下一批次） |
| ai | AI 辅助（脚本生成/失败分析，OpenAI/Ollama） | [AI 模块](modules/ai.md)（下一批次） |
| task-template | 任务模板（`/task-templates`） | [任务模板模块](modules/task-template.md)（下一批次） |
| registry | 私有 npm/PyPI 仓库代理（Verdaccio/自建 PyPI 转发） | [registry 模块](modules/registry.md)（下一批次） |
| event-subscriptions | 出站事件订阅（DomainEventBus → webhook） | [出站订阅模块](modules/event-subscriptions.md)（下一批次） |
| runtime | 任务 runtime 注册表（@Global，python/node/shell 描述层） | [runtime 模块](modules/runtime.md)（下一批次） |

## 运行要素

- **端口**：`PORT`（Joi 校验，默认 `3105`），configuration.ts `app.port`。
- **全局前缀**：`api`（`app.setGlobalPrefix("api")`），所有 controller 路由实际路径为 `/api/<prefix>`。
- **Swagger**：仅非 production 暴露在 `/api/docs`。
- **响应包装**：全局 `ResponseInterceptor` 输出 `{code, message, data}`；异常由 `HttpExceptionFilter` 统一格式（见 main.ts Swagger 描述块）。
- **鉴权**：全局 `JwtAuthGuard`（`@Public()` 豁免）+ `RolesGuard`（`@Roles(...)` 按需启用）；Bearer `acf_` 前缀走 API Key 分支，见 [modules/api-keys.md](modules/api-keys.md)。
- **限流**：全局 60/min（`THROTTLE_LIMIT`），auth 严格档 10/min、干预写面中档 30/min（`src/config/throttle-profiles.ts`）。
- **追踪**：`TraceIdMiddleware` 全路由注入 trace id；`OTEL_ENABLED=true` 时启用 OpenTelemetry（W3C traceparent 透传）。

## 相关文档

- 产品全景：[../../00-overview/01-product-overview.md](../../00-overview/01-product-overview.md)
- 总体架构：[../../00-overview/02-system-architecture.md](../../00-overview/02-system-architecture.md)
- 认证与信任链：[../../04-flows/security-model.md](../../04-flows/security-model.md)
- 任务全链路：[../../04-flows/task-lifecycle.md](../../04-flows/task-lifecycle.md)
- 执行器回调：[../../04-flows/execution-callback.md](../../04-flows/execution-callback.md)
- 新增后端模块流程：[../../08-workflows/add-new-api-module.md](../../08-workflows/add-new-api-module.md)
- 数据层实体拆解：[../../03-data/README.md](../../03-data/README.md)（规划中）
