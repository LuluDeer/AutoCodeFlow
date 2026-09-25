import { Module, NestModule, MiddlewareConsumer, Logger } from "@nestjs/common";
import { TraceIdMiddleware } from "./common/middleware/trace-id.middleware";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import Redis from "ioredis";
import { ThrottlerModule } from "@nestjs/throttler";
import { ExecutorAwareThrottlerGuard } from "./common/guards/executor-aware-throttler.guard";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { RolesGuard } from "./common/guards/roles.guard";
// A2-B（DEEP_REVIEW 0ef3bbe §七）：@WriteGuard 的 ownership / project-role 声明
// 由本拦截器运行时强制——拿不出断言证据的写端点直接 500（缺省拒绝）。
import { WriteGuardEnforcementInterceptor } from "./common/guards/write-guard-enforcement.interceptor";
import * as Joi from "joi";
import configuration, {
  buildTypeOrmDataSourceOptions,
} from "./config/configuration";

// ARCH-24: DB_READ_REPLICA_URL 的 Joi schema 抽为命名导出——validationSchema
// 在 ConfigModule.forRoot 闭包内无法反射取出，spec（typeorm-replica.spec.ts）
// 直接 import 同一 schema 对象断言其行为，保证注册面与测试零漂移。
export const DB_READ_REPLICA_URL_SCHEMA = Joi.string()
  .uri({ scheme: ["postgres", "postgresql"] })
  .allow("")
  .optional();
import { AuthModule } from "./modules/auth/auth.module";
import { UsersModule } from "./modules/users/users.module";
import { TaskModule } from "./modules/task/task.module";
import { ExecutorModule } from "./modules/executor/executor.module";
import { SchedulerModule } from "./modules/scheduler/scheduler.module";
import { NotificationModule } from "./modules/notification/notification.module";
import { AiModule } from "./modules/ai/ai.module";
// P2（agent-and-deployment）：中台 Agent 运行时
import { AgentModule } from "./modules/agent/agent.module";
import { MetricsModule } from "./modules/metrics/metrics.module";
import { SystemConfigModule } from "./modules/config/config.module";
import { AuditModule } from "./modules/audit/audit.module";
import { HealthModule } from "./modules/health/health.module";
import { ApplicationModule } from "./modules/application/application.module";
import { ExecutorPackageModule } from "./modules/executor-package/executor-package.module";
import { RegistryModule } from "./modules/registry/registry.module";
import { ArtifactsModule } from "./modules/artifacts/artifacts.module";
// ARCH-21: 进程内领域事件总线（@Global 单例——emit 侧在 task 模块，
// listener 侧在 notification 模块，FEAT-07 出站 webhook 届时直接订阅）。
import { DomainEventModule } from "./common/services/domain-event-bus.service";
// OBS-01: OpenTelemetry 追踪（@Global——埋点在 task/scheduler/executor/
// execution-callback 多处；OTEL_ENABLED=false 时 TracingService 全短路）。
import { TracingModule } from "./common/tracing/tracing.module";
// ARCH-31 §5: cron 维护任务统一 Leader 门禁（@Global——无门禁 @Cron 在
// executor/task/application/artifacts/audit/auth 多模块，经 LeaderGateService
// 只读 isLeader 短路；Redis 不可用时 fail-open，与 scheduler:leader 选举相互独立）。
import { LeaderGateModule } from "./common/leader-gate/leader-gate.module";
import { TaskTemplateModule } from "./modules/task-template/task-template.module";
// FEAT-07: 出站事件订阅（webhook 出站）——消费 DomainEventBus 事件派发签名回调。
import { EventSubscriptionModule } from "./modules/event-subscriptions/event-subscription.module";
// AUTH-01: 多租户 Project（第一批）——projects CRUD + 默认项目种子语义。
import { ProjectsModule } from "./modules/project/projects.module";
// AUTH-03: 限权 API Key（CI/CD 机器认证）——guard 分流消费 ApiKeysService。
import { ApiKeysModule } from "./modules/api-keys/api-keys.module";
// ARCH-25: 任务 runtime 注册表（@Global 描述层，内置 python/node/shell）。
import { RuntimeModule } from "./modules/runtime/runtime.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ".env",
      // INFRA-04: Add configuration schema validation
      validationSchema: Joi.object({
        // Application
        NODE_ENV: Joi.string()
          .valid("development", "production", "test")
          .default("development"),
        PORT: Joi.number().port().default(3105),
        LOG_LEVEL: Joi.string()
          .valid("error", "warn", "info", "debug", "verbose")
          .default("info"),
        // ARCH-27: 此前 configuration.ts 读取但未注册（审计缺口）。
        APP_PROTOCOL: Joi.string().default("http"),
        DB_POOL_SIZE: Joi.number().integer().min(1).default(20),
        // ARCH-27: executor 心跳参数此前未注册（审计缺口）。
        EXECUTOR_HEARTBEAT_INTERVAL: Joi.number()
          .integer()
          .min(1000)
          .default(30000),
        EXECUTOR_HEARTBEAT_TIMEOUT_MULTIPLIER: Joi.number()
          .integer()
          .min(1)
          .default(3),
        // EXE-VER-1: 执行器最低版本门禁（可选，空=关闭，零行为变化）。
        // 点分数字 1~4 段；configuration.ts executor.minVersion 消费。
        EXECUTOR_MIN_VERSION: Joi.string()
          .allow("")
          .optional()
          .pattern(/^\d{1,9}(\.\d{1,9}){0,3}$/),
        // ARCH-32: pull 派发长轮询参数（configuration.ts executor 节消费）。
        // wait 上限 55s —— 须低于反代/网关通用 60s 读超时（SSE 专用位置除外）。
        EXECUTOR_PULL_WAIT_MS: Joi.number()
          .integer()
          .min(0)
          .max(55000)
          .default(25000),
        EXECUTOR_PULL_TTL_MS: Joi.number().integer().min(1000).default(900000),
        // ARCH-33（ADR-016）：控制面命令队列的载荷过期阈值
        // （configuration.ts executor.cmdTtlMs 消费）。默认 30min，**长于**
        // 任务载荷 TTL——丢任务有 stale sweep 兜底，丢控制命令没有任何兜底。
        EXECUTOR_CMD_TTL_MS: Joi.number().integer().min(1000).default(1800000),
        // F-07（本轮审计）: 调度候选执行器池上限（configuration.ts
        // executor.candidatePoolSize 消费，selectLeastLoaded / dispatch 的
        // take 截断）。默认 500 与既有硬编码一致。
        EXECUTOR_CANDIDATE_POOL_SIZE: Joi.number()
          .integer()
          .min(1)
          .default(500),
        // ARCH-35 P1（生产事故 2026-09-23）：部署归属偏好开关
        // （configuration.ts executor.preferDeployedExecutor 消费）。默认
        // true（修主因）；置 "false" 一行回滚到「不看部署、纯负载择优」。
        EXECUTOR_PREFER_DEPLOYED: Joi.string()
          .valid("true", "false")
          .default("true"),

        // Database
        DB_HOST: Joi.string().hostname().default("localhost"),
        DB_PORT: Joi.number().port().default(5432),
        DB_USERNAME: Joi.string().default("postgres"),
        DB_PASSWORD: Joi.string().min(1).required(),
        DB_DATABASE: Joi.string().default("autocodeflow"),
        // ARCH-006: explicit schema-synchronize switch (default false).
        // In production a value of "true" fails fast in configuration.ts.
        DB_SYNCHRONIZE: Joi.string().valid("true", "false").default("false"),
        // ARCH-24: 可选只读副本连接串（postgres:// 或 postgresql://）。
        // scheme 锁定防误配 http(s)/mysql 等；留空（默认）= 读写分离关闭，
        // TypeORM 保持单连接形态；配置后 SELECT 读面经驱动内建路由走
        // slaves，写面/事务/迁移恒走 master。形态构造见 configuration.ts
        // 的 buildTypeOrmDataSourceOptions；schema 本体抽到
        // DB_READ_REPLICA_URL_SCHEMA（供 spec 直接复用，防漂移）。
        DB_READ_REPLICA_URL: DB_READ_REPLICA_URL_SCHEMA,

        // Redis
        REDIS_HOST: Joi.string().hostname().default("localhost"),
        REDIS_PORT: Joi.number().port().default(6379),
        REDIS_PASSWORD: Joi.string().allow("").optional(),
        // ARCH-005: enable TLS transport for ioredis/BullMQ connections
        REDIS_TLS: Joi.string().valid("true", "false").default("false"),
        REDIS_TLS_REJECT_UNAUTHORIZED: Joi.string()
          .valid("true", "false")
          .default("true"),

        // JWT
        JWT_SECRET: Joi.string().min(32).required(),
        JWT_REFRESH_SECRET: Joi.string().min(32).required(),
        JWT_EXPIRES_IN: Joi.string().default("15m"),

        // Executor
        EXECUTOR_SECRET: Joi.string().min(16).required(),
        EXECUTOR_SHARED_TOKEN: Joi.string().min(16).optional().allow(""),
        // N23: optional dedicated HMAC secret for per-execution callback
        // tokens; falls back to the executor shared token when unset or empty.
        EXECUTION_CALLBACK_SECRET: Joi.string().min(16).optional().allow(""),

        // CORS — ARCH-001: explicit origin whitelist (comma separated).
        // Empty in development = only http://localhost:* / http://127.0.0.1:*
        // are allowed at runtime; production requires an explicit whitelist
        // (fail-fast enforced in configuration.ts).
        CORS_ALLOWED_ORIGINS: Joi.string().allow("").optional(),
        // Legacy variable kept as fallback for CORS_ALLOWED_ORIGINS
        CORS_ORIGINS: Joi.string().allow("").optional(),

        // ARCH-004: global rate-limit overrides (defaults in configuration.ts)
        THROTTLE_LIMIT: Joi.number().integer().min(1).default(60),
        THROTTLE_TTL: Joi.number().integer().min(1000).default(60000),

        // SEC-09: 限流分域三处登记之二（configuration.ts throttle 节 +
        // .env.example；装饰器求值期消费点 src/config/throttle-profiles.ts 为
        // ARCH-27 显式豁免）。
        // THROTTLE_ENABLED=false → ThrottlerModule 顶层 skipIf 全域旁路
        // （灰度/排障逃生门，运行期 ConfigService 读取；默认 true 生效）。
        THROTTLE_ENABLED: Joi.string().valid("true", "false").default("true"),
        // 严格档：auth 敏写面（refresh/totp*），默认 10 次/60s（防爆破，
        // 与 account lockout 互补；login 保留 LOGIN_THROTTLE_LIMIT 契约）。
        THROTTLE_AUTH_LIMIT: Joi.number().integer().min(1).default(10),
        THROTTLE_AUTH_TTL: Joi.number().integer().min(1000).default(60000),
        // 中档：触发/执行干预写面（trigger/kill/rollback/deploy/审批等），
        // 默认 30 次/60s。
        THROTTLE_OPS_LIMIT: Joi.number().integer().min(1).default(30),
        THROTTLE_OPS_TTL: Joi.number().integer().min(1000).default(60000),

        // F-6: opt-in — set true ONLY behind a trusted reverse proxy that
        // overwrites X-Forwarded-For. Default false keeps req.ip equal to the
        // socket address so the throttler tracker cannot be spoofed via XFF.
        TRUST_PROXY: Joi.string().valid("true", "false").default("false"),

        // F-3: executor-target SSRF policy. Default false blocks loopback /
        // link-local / metadata targets for executor-bound outbound calls while
        // still allowing private LAN ranges (docker-compose internal network,
        // 10.x / 172.16-31.x / 192.168.x) required by the standard topology.
        // true additionally allows loopback (same-host dev deployments).
        EXECUTOR_ALLOW_PRIVATE_NETWORK: Joi.string()
          .valid("true", "false")
          .default("false"),

        // SSE log-stream concurrency caps (per-process, defaults in configuration.ts)
        SSE_MAX_STREAMS_PER_EXECUTION: Joi.number().integer().min(1).default(4),
        SSE_MAX_STREAMS_GLOBAL: Joi.number().integer().min(1).default(64),

        // R-12（DEEP_REVIEW 0ef3bbe）: metricsStream / executionsStream 节此前在
        // configuration.ts 读取但未在 Joi 注册（ARCH-27 审计缺口）——env 名 typo 时
        // 静默回退默认值，无法从日志发现拼写错误。默认值与 configuration.ts 既有
        // 回退逐字节一致（maxGlobal 32 / interval 3000ms / metrics idlePing 15000ms
        // / executions idlePing 30000ms）。
        METRICS_STREAM_MAX_GLOBAL: Joi.number().integer().min(1).default(32),
        METRICS_STREAM_INTERVAL_MS: Joi.number().integer().min(1).default(3000),
        METRICS_STREAM_IDLE_PING_MS: Joi.number()
          .integer()
          .min(1)
          .default(15000),
        EXECUTIONS_STREAM_IDLE_PING_MS: Joi.number()
          .integer()
          .min(1)
          .default(30000),

        // AI (optional)
        AI_PROVIDER: Joi.string()
          .valid("disabled", "openai", "ollama", "qwen")
          .default("disabled"),
        OPENAI_API_KEY: Joi.string().allow("").optional(),
        OPENAI_MODEL: Joi.string().default("gpt-4o-mini"),
        OLLAMA_HOST: Joi.string().uri().default("http://localhost:11434"),
        OLLAMA_MODEL: Joi.string().default("llama3"),
        // P1（agent-and-deployment）: Qwen / DashScope 多模态。
        // 走 DashScope 的 OpenAI 兼容端点，故复用 openai 分支的请求骨架
        // （axios + Bearer + SSRF pin + maxRedirects:0）。
        // 全部可选——provider != qwen 时这些键不生效，存量部署零变化。
        QWEN_API_KEY: Joi.string().allow("").optional(),
        QWEN_BASE_URL: Joi.string()
          .uri()
          .default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
        QWEN_MODEL: Joi.string().default("qwen-vl-max"),
        // 多模态输出上限：**独立于** openai 分支硬编码的 max_tokens=500
        // （那个是给失败日志分析用的，刻意省成本；多模态推理 500 远不够）。
        QWEN_MAX_TOKENS: Joi.number().integer().min(1).default(4096),
        // 视频理解延迟显著高于纯文本（上传 + 推理数十秒），故超时默认 2 分钟。
        QWEN_TIMEOUT_MS: Joi.number().integer().min(1000).default(120000),

        // P2（agent-and-deployment）: Agent 预算闸门。
        // 保守默认——Agent 是唯一会主动烧令牌 + 改生产状态的组件，
        // 宁可它慢/少做，也不可失控（设计文档 02 §5.3）。
        // 全部可选：不配置即用 DEFAULT_BUDGET，存量部署零变化。
        AGENT_BUDGET_MAX_STEPS: Joi.number().integer().min(1).default(20),
        AGENT_BUDGET_MAX_TOKENS: Joi.number().integer().min(1).default(200000),
        AGENT_BUDGET_WALL_CLOCK_MS: Joi.number()
          .integer()
          .min(1000)
          .default(1800000),
        AGENT_BUDGET_MAX_TOOL_CALLS: Joi.number().integer().min(1).default(50),

        // P4（agent-and-deployment）: Agent 触发器。
        // 全部可选，默认「启用 + 5 分钟窗口 + 阈值 3」——保守起步。
        AGENT_TRIGGER_ENABLED: Joi.string()
          .valid("true", "false")
          .default("true"),
        // 定时巡检（cron 型）单独开关——有些部署只要事件触发，不要周期性消耗。
        AGENT_TRIGGER_CRON_ENABLED: Joi.string()
          .valid("true", "false")
          .default("true"),
        AGENT_TRIGGER_WINDOW_MS: Joi.number()
          .integer()
          .min(1000)
          .default(300000),
        AGENT_TRIGGER_THRESHOLD: Joi.number().integer().min(1).default(3),

        // P4（agent-and-deployment）: Agent 会话通知开关。默认开——
        // 「静默会话不通知」的策略在服务内，渠道未配置时各渠道自行跳过。
        AGENT_NOTIFY_ENABLED: Joi.string()
          .valid("true", "false")
          .default("true"),

        // AUTH-04: OIDC SSO（授权码模式）。全部可选——OIDC_ENABLED=false 时
        // 其余键不生效，存量部署零变化。
        OIDC_ENABLED: Joi.string().valid("true", "false").default("false"),
        OIDC_ISSUER: Joi.string().uri().allow("").optional(),
        OIDC_CLIENT_ID: Joi.string().allow("").optional(),
        OIDC_CLIENT_SECRET: Joi.string().allow("").optional(),
        OIDC_REDIRECT_URI: Joi.string().uri().allow("").optional(),
        OIDC_SCOPES: Joi.string().allow("").optional(),
        OIDC_USERNAME_CLAIM: Joi.string().allow("").optional(),
        OIDC_GROUPS_CLAIM: Joi.string().allow("").optional(),
        OIDC_ADMIN_GROUPS: Joi.string().allow("").optional(),
        OIDC_AUTO_PROVISION: Joi.string()
          .valid("true", "false")
          .default("false"),
        OIDC_WEB_REDIRECT_URL: Joi.string().uri().allow("").optional(),
        OIDC_ALLOW_PRIVATE_NETWORK: Joi.string()
          .valid("true", "false")
          .default("false"),
        // R17: 通知渠道（webhook 类五渠道共用）私网豁免，语义同上
        NOTIF_ALLOW_PRIVATE_NETWORK: Joi.string()
          .valid("true", "false")
          .default("false"),
        // ARCH-31（2026-09-13）: AI 出站私网豁免。默认 false = 既有 SSRF 姿态
        // 零变化（assertSafeHttpUrl 拒一切非 public，本地 Ollama 的默认
        // localhost:11434 也被拒）；true 放行 loopback/restricted/private-lan
        // （同机自建 Ollama / Tailscale 端点），link-local 云元数据仍恒拒。
        // AI 配置面为 ADMIN-only，信任边界与 executor 开关一致。
        AI_ALLOW_PRIVATE_NETWORK: Joi.string()
          .valid("true", "false")
          .default("false"),
        // ARCH-31（2026-09-13）: 事件订阅 webhook 私网豁免。默认 false = 既有
        // 姿态零变化；true 放行 loopback/restricted/private-lan（内网接收端，
        // 如多实例重复投递自检的 loopback 接收器）。注意：事件订阅普通用户
        // 可建——开启即信任所有登录用户可让平台向内网 endpoint 发 HTTP
        // （签名 webhook），生产环境默认关闭。
        EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK: Joi.string()
          .valid("true", "false")
          .default("false"),

        // Email (optional)
        EMAIL_HOST: Joi.string().allow("").optional(),
        EMAIL_PORT: Joi.number().port().default(465),
        EMAIL_SECURE: Joi.string().valid("true", "false").default("true"),
        EMAIL_USER: Joi.string().allow("").optional(),
        EMAIL_PASS: Joi.string().allow("").optional(),
        EMAIL_FROM: Joi.string().email().allow("").optional(),
        EMAIL_TO: Joi.string().email().allow("").optional(),

        // Notification webhooks (optional)
        WECOM_WEBHOOK: Joi.string().uri().allow("").optional(),
        DINGTALK_WEBHOOK: Joi.string().uri().allow("").optional(),
        SLACK_WEBHOOK: Joi.string().uri().allow("").optional(),
        // NF-05: 飞书自定义机器人（可选；secret 为加签密钥，非 URL 类不加 uri 校验）
        FEISHU_WEBHOOK: Joi.string().uri().allow("").optional(),
        FEISHU_SECRET: Joi.string().allow("").optional(),
        // ARCH-31: 跨实例共享状态读穿刷新周期（ms）——渠道配置 / 通知静默。
        // 下限 1000ms（服务内另有兜底回落），缺省 15000。
        CHANNEL_CONFIG_REFRESH_MS: Joi.number()
          .integer()
          .min(1000)
          .default(15000),
        SILENCE_REFRESH_MS: Joi.number().integer().min(1000).default(15000),

        // R7: Prometheus exposition endpoint (GET /api/metrics) switches.
        // Defaults true; semantics in configuration.ts (metrics.prometheus).
        METRICS_PROMETHEUS_ENABLED: Joi.string()
          .valid("true", "false")
          .default("true"),
        METRICS_PROMETHEUS_DEFAULT_METRICS_ENABLED: Joi.string()
          .valid("true", "false")
          .default("true"),

        // P2: stale sweep retry-budget re-enqueue switch (default true;
        // "false" restores the old FAILED-only recovery). Semantics in
        // configuration.ts (scheduler.staleRecoveryRetryEnabled).
        STALE_RECOVERY_RETRY_ENABLED: Joi.string()
          .valid("true", "false")
          .default("true"),

        // S5: optional Verdaccio service account for the admin-api registry
        // proxy (npm package listing against registry-npm, which requires
        // $authenticated access for every pattern). All optional — unset
        // keeps the previous anonymous behavior (empty list on 401).
        NPM_REGISTRY_TOKEN: Joi.string().allow("").optional(),
        NPM_REGISTRY_USER: Joi.string().allow("").optional(),
        NPM_REGISTRY_PASS: Joi.string().allow("").optional(),
        // R-12（DEEP_REVIEW 0ef3bbe）: Verdaccio registry 基址。此前
        // registry.controller 经 config.get("NPM_REGISTRY_URL") 裸读（注释失实
        // 声称已在 Joi 注册）。现注册并映射到 registry.npm.url；空由 configuration
        // 回退 http://localhost:4873（旧 controller 回退行为不变）。
        NPM_REGISTRY_URL: Joi.string().uri().allow("").optional(),
        // R-12（DEEP_REVIEW 0ef3bbe）: 执行器可回连的 Admin API 对外基址
        // （app.adminApiUrl 消费：getInstallCmd / package push）。此前两个消费点经
        // configService.get("ADMIN_API_URL") 裸读绕过配置中心，typo 静默取空 →
        // 运行时 503。空 = 未配置（运行时端点 fail-fast 503，行为不变）；一旦配置
        // 须为合法 http(s) URL，否则启动即拒绝。
        ADMIN_API_URL: Joi.string().uri().allow("").optional(),

        // ARCH-27（配置中心收口）: 此前存在读取点但未在 Joi 注册的 env，
        // 审计后补齐（默认值与 configuration.ts 既有回退保持一致）。
        // N16: login 路由限流上限（auth.controller @Throttle 装饰器求值期
        // 读取，W-22 模式 —— 见 auth.controller.ts / src/config/env.ts）。
        LOGIN_THROTTLE_LIMIT: Joi.number().integer().min(1).default(20),
        // OPS-07: 全局请求超时（timeout.interceptor 经 ConfigService 读取
        // app.requestTimeoutMs）。
        REQUEST_TIMEOUT_MS: Joi.number().integer().min(1).default(30000),
        // APP-002: executor 拉取 packageUrl 的对外基础 URL（application
        // controller fail-fast 校验；空表示未配置，运行时报 500 提示）。
        API_BASE_URL: Joi.string().uri().allow("").optional(),
        // DB-002: 执行日志保留天数（logRetention.days；非数字会被 Joi 拒绝
        // 并 fail-fast，取代旧运行时回退）。
        LOG_RETENTION_DAYS: Joi.number().integer().min(1).default(30),
        // ARCH-22: execution_log_lines 分区清理路径开关（logPartition.enabled
        // 节；默认 true——分区库走 DETACH PARTITION + 每日预建；false 回退
        // legacy 分批 DELETE）。
        LOG_PARTITION_ENABLED: Joi.string()
          .valid("true", "false")
          .default("true"),
        // FEAT-19: 出站 webhook 跨进程 outbox 开关（eventOutbox.enabled 节；
        // 默认 true——派发入口同步落 event_outbox + 周期扫描补投，
        // at-least-once；false 回退纯进程内派发）。
        EVENT_OUTBOX_ENABLED: Joi.string()
          .valid("true", "false")
          .default("true"),
        // users.service admin 种子账号（initialAdmin 节；密码缺省 = 跳过 seed）。
        INITIAL_ADMIN_PASSWORD: Joi.string().allow("").optional(),
        INITIAL_ADMIN_EMAIL: Joi.string().default("admin@autoflow.local"),

        // ARCH-27: logStorage 节（S3 外置日志）此前未注册（审计缺口）；
        // 全部可选，默认与 configuration.ts 回退一致。
        LOG_STORAGE_DRIVER: Joi.string().valid("db", "s3").default("db"),
        LOG_STORAGE_BUCKET: Joi.string().default("autoflow-logs"),
        LOG_STORAGE_ENDPOINT: Joi.string().allow("").optional(),

        // SEC-02: 任务级 secrets 落库加密 key（secrets.key 节；空 = 降级
        // 明文存储并 warn，见 secret-crypto.util.service.ts）。可选——
        // 未配置保持既有明文行为（零破坏升级路径），配置后写路径全加密。
        SEC_SECRETS_KEY: Joi.string().allow("").optional(),

        // OBS-02: Alertmanager webhook 入站 HMAC secret（alert.webhookSecret
        // 节）。可选——未配置时 POST /api/alerts/webhook 返回 503（安全缺省，
        // 端点禁用），配置后才能接收告警外发。
        ALERT_WEBHOOK_SECRET: Joi.string().allow("").optional(),
        LOG_STORAGE_ACCESS_KEY: Joi.string().allow("").optional(),
        LOG_STORAGE_SECRET_KEY: Joi.string().allow("").optional(),
        LOG_STORAGE_USE_SSL: Joi.string()
          .valid("true", "false")
          .default("false"),
        LOG_STORAGE_REGION: Joi.string().allow("").optional(),

        // SEC-05: 上传面 zip bomb 防护阈值（zipGuard 节）。四项上限均可
        // 调整；缺省即安全值（比率 100 / 条目 10000 / 单文件 1 GiB /
        // 总量 2 GiB / 嵌套探测 1 层）。
        ZIP_MAX_RATIO: Joi.number().integer().min(1).default(100),
        ZIP_MAX_ENTRIES: Joi.number().integer().min(1).default(10000),
        ZIP_MAX_FILE_BYTES: Joi.number()
          .integer()
          .min(1)
          .default(1024 * 1024 * 1024),
        ZIP_MAX_TOTAL_BYTES: Joi.number()
          .integer()
          .min(1)
          .default(2 * 1024 * 1024 * 1024),
        ZIP_MAX_NESTING_DEPTH: Joi.number().integer().min(0).default(1),

        // SEC-05: 可选 clamd 病毒扫描钩子（clamd 节）。默认 false——零影响；
        // true 时上传包流式 INSTREAM 送扫，fail-closed（扫描不可达拒绝包）。
        CLAMD_ENABLED: Joi.string().valid("true", "false").default("false"),
        CLAMD_HOST: Joi.string().hostname().default("127.0.0.1"),
        CLAMD_PORT: Joi.number().port().default(3310),
        CLAMD_TIMEOUT_MS: Joi.number().integer().min(1).default(10000),

        // OBS-01: OpenTelemetry 分布式追踪开关（tracing.enabled 节）。
        // 默认 false——零开销零行为变化（span 生成短路）；true 时 traceId
        // 贯穿 + W3C traceparent 透传（@opentelemetry/api-only 方案）。
        OTEL_ENABLED: Joi.string().valid("true", "false").default("false"),

        // WIKI-OPT-1: 健康检查判定阈值与全量响应缓存（configuration.ts
        // health 节，health.service 构造器经 ConfigService 读取）。队列积压
        // 三项阈值默认与原硬编码一致（failed>100 / delayed>500 /
        // waiting>1000 → degraded）；执行器在线比例下限默认 0.5（0~1）；
        // 缓存 TTL 默认 0 = 关闭（getFullHealth 行为与未缓存完全一致）。
        HEALTH_QUEUE_FAILED_MAX: Joi.number().integer().min(1).default(100),
        HEALTH_QUEUE_DELAYED_MAX: Joi.number().integer().min(1).default(500),
        HEALTH_QUEUE_WAITING_MAX: Joi.number().integer().min(1).default(1000),
        HEALTH_EXECUTOR_ONLINE_RATIO_MIN: Joi.number()
          .min(0)
          .max(1)
          .default(0.5),
        HEALTH_CACHE_TTL_MS: Joi.number().integer().min(0).default(0),
      }),
      // Only validate in production and test environments
      // @nestjs/config 12 迁移到 Standard Schema：对 joi schema 包内默认即
      // allowUnknown=true、abortEarly=false（此前需在这里显式声明），语义不变，
      // 无需再传 validationOptions。
    }),

    // ARCH-004: global rate limit — tightened default (60 req/min, was 100)
    // and overridable via THROTTLE_LIMIT / THROTTLE_TTL. Sensitive routes keep
    // their own stricter @Throttle (e.g. auth login via LOGIN_THROTTLE_LIMIT).
    // SEC-09: 分域档位由各路由自己的 @Throttle({ default: ... }) 覆盖（严格档
    // = auth refresh/totp*，中档 = trigger/kill/rollback/deploy 等干预写面，
    // SSE 建连 @SkipThrottle 豁免——分域矩阵见 src/config/throttle-profiles.ts
    // 头注）。顶层 skipIf = THROTTLE_ENABLED=false 全局旁路逃生门（运行期
    // ConfigService 读取，每次 canActivate 重新求值，无需重启即生效于新请求）。
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        skipIf: () => cfg.get<boolean>("throttle.enabled") === false,
        throttlers: [
          {
            ttl: cfg.get<number>("throttle.ttl"),
            limit: cfg.get<number>("throttle.limit"),
          },
        ],
      }),
    }),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      // ARCH-24: DataSource 配置构造收口到 configuration.ts 的
      // buildTypeOrmDataSourceOptions（纯函数，含读写分离开关：
      // DB_READ_REPLICA_URL 为空 = 旧版单连接形态；非空 = replication
      // { master, slaves } 形态，SELECT 读面走 slaves，写面/迁移恒走
      // master——路由语义与形态细节见该函数头注与 docs/deployment.md）。
      // synchronize：configuration.ts 已按 DB_SYNCHRONIZE/NODE_ENV 收口
      // （production fail-fast false），此处透传。
      useFactory: (cfg: ConfigService) => {
        const options = buildTypeOrmDataSourceOptions({
          database: {
            host: cfg.get("database.host"),
            port: cfg.get<number>("database.port"),
            username: cfg.get("database.username"),
            password: cfg.get("database.password"),
            database: cfg.get("database.database"),
            poolSize: cfg.get<number>("database.poolSize"),
            readReplicaUrl: cfg.get("database.readReplicaUrl"),
          },
          app: { nodeEnv: cfg.get("app.nodeEnv") },
        });
        // ARCH-006: explicit DB_SYNCHRONIZE switch (default false) instead of
        // inferring from NODE_ENV; production additionally forces/fails-fast
        // false in configuration.ts regardless of the env value.
        return {
          ...options,
          synchronize: cfg.get<boolean>("database.synchronize"),
        };
      },
      inject: [ConfigService],
    }),

    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (cfg: ConfigService) => {
        // PERF-03 / BullMQ: maxRetriesPerRequest:null + enableOfflineQueue:true
        // are required by BullMQ and intentionally kept. We construct the ioredis
        // client ourselves (rather than handing BullMQ a plain options object)
        // ONLY to attach read-only offline-queue monitoring: while Redis is
        // unreachable, commands are buffered in ioredis' offline queue; a long
        // outage under high enqueue volume can grow that queue without bound and
        // OOM the process. This neither disables the offline queue nor changes
        // reconnect semantics — it only makes the buffering observable.
        const redisLogger = new Logger("BullMQ-Redis");
        const redis = new Redis({
          host: cfg.get("redis.host"),
          port: cfg.get<number>("redis.port"),
          password: cfg.get("redis.password"),
          db: cfg.get<number>("redis.db", 0),
          // ARCH-005: REDIS_TLS=true → all ioredis/BullMQ connections use TLS.
          // Certificate verification follows REDIS_TLS_REJECT_UNAUTHORIZED
          // (default true; set false only for self-signed-cert environments).
          ...(cfg.get("redis.tls") === true
            ? {
                tls: {
                  rejectUnauthorized:
                    cfg.get("redis.tlsRejectUnauthorized") !== false,
                },
              }
            : {}),
          // PERF-03: Redis connection pool optimization
          enableOfflineQueue: true, // Queue commands when offline
          connectTimeout: 10000, // 10 seconds connection timeout
          lazyConnect: false, // Connect immediately on startup
          keepAlive: 10000, // Keep-alive interval (10 seconds)
          family: 4, // IPv4
          // (maxRedirections only applies to Redis Cluster; this deployment
          // uses a standalone instance, so it is intentionally omitted.)
          maxRetriesPerRequest: null,
          retryStrategy: (times: number) => {
            if (times > 10) {
              // Stop retrying after 10 attempts
              return null;
            }
            // Exponential backoff: 100ms, 200ms, 400ms, etc.
            return Math.min(times * 100, 3000);
          },
        });

        // Observable offline windows: warn when we drop offline, log recovery.
        redis.on("status", (status: string) => {
          if (
            status === "reconnecting" ||
            status === "close" ||
            status === "end"
          ) {
            redisLogger.warn(
              `Redis connection state="${status}"; BullMQ commands are buffered in the offline queue (enableOfflineQueue=true).`,
            );
          } else if (status === "ready") {
            redisLogger.log(
              "Redis connection restored (ready); buffered offline-queue commands have been flushed.",
            );
          }
        });
        // Lightweight depth sample while offline (every 30s). Read-only; the
        // internal queue property is best-effort across ioredis versions and
        // must never throw.
        const offlineMonitor = setInterval(() => {
          if (redis.status !== "ready") {
            const depth = (redis as unknown as { offlineQueue?: unknown[] })
              .offlineQueue?.length;
            if (depth && depth > 0) {
              redisLogger.warn(
                `Redis offline queue depth=${depth} (commands buffered while unreachable — risk of OOM on a long outage).`,
              );
            }
          }
        }, 30_000);
        // Don't let this monitor keep the process alive on its own.
        offlineMonitor.unref?.();

        return {
          connection: redis,
          // OPS-P1: 终态 job 保留策略——cron/fixed_rate 任务每 tick 入队一个
          // job，无保留策略时 completed/failed 集合在 Redis 无界增长。
          // completed 保留 1h（滚动窗口 1000 条上限）供排障；failed 保留 24h
          //（5000 条上限）便于回溯失败。BullMQ 合并语义为
          // {...defaultJobOptions, ...perJobOpts}（per-job 覆盖 default）：
          // 本仓库全部 4 处 add()（task.service trigger/rollback、
          // scheduler.enqueue、executor restart retry）只设 attempts/backoff/
          // priority，不携带 removeOn*，不存在反向覆盖。
          defaultJobOptions: {
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 86400, count: 5000 },
          },
        };
      },
      inject: [ConfigService],
    }),

    AuthModule,
    UsersModule,
    TaskModule,
    ExecutorModule,
    SchedulerModule,
    NotificationModule,
    AiModule,
    // P2: 单向依赖——AgentModule 依赖其他业务模块，但不被任何业务模块依赖
    // （Agent 失败绝不影响调度/执行主链，见 agent.module.ts 头注）。
    AgentModule,
    MetricsModule,
    SystemConfigModule,
    AuditModule,
    HealthModule,
    ApplicationModule,
    ExecutorPackageModule,
    RegistryModule,
    ArtifactsModule,
    DomainEventModule,
    TracingModule,
    LeaderGateModule,
    TaskTemplateModule,
    EventSubscriptionModule,
    ApiKeysModule,
    ProjectsModule,
    RuntimeModule,
  ],
  providers: [
    // A-02: apply ThrottlerGuard globally
    // B-2: 全局节流换成 ExecutorAwareThrottlerGuard——回调限流按
    // x-executor-address 头做执行器维度计数（多执行器共享出口 IP 时不再按 IP
    // 叠加误杀），其余请求回退 IP 键（行为不变）。
    { provide: APP_GUARD, useClass: ExecutorAwareThrottlerGuard },
    // A-03: apply JwtAuthGuard globally — use @Public() decorator to opt-out
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // R4 F-1: apply RolesGuard globally (after JwtAuthGuard so req.user is
    // populated). Routes without @Roles metadata stay available to any
    // authenticated user; @Public() routes carry no @Roles metadata and are
    // therefore unaffected. Enforcement is opt-in per route via @Roles(...).
    { provide: APP_GUARD, useClass: RolesGuard },
    // A2-B: 写面授权**缺省拒绝**——本拦截器不依赖任何人记得在 service 里调
    // assertCanWrite；调了会落证，没落证的 ownership/project-role 写端点一律 500。
    { provide: APP_INTERCEPTOR, useClass: WriteGuardEnforcementInterceptor },
  ],
})
export class AppModule implements NestModule {
  // OPS-03: apply Trace ID middleware to every route
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceIdMiddleware).forRoutes("*");
  }
}
