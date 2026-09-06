import { Module, NestModule, MiddlewareConsumer } from "@nestjs/common";
import { TraceIdMiddleware } from "./common/middleware/trace-id.middleware";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { RolesGuard } from "./common/guards/roles.guard";
import * as Joi from "joi";
import configuration from "./config/configuration";
import { AuthModule } from "./modules/auth/auth.module";
import { UsersModule } from "./modules/users/users.module";
import { TaskModule } from "./modules/task/task.module";
import { ExecutorModule } from "./modules/executor/executor.module";
import { SchedulerModule } from "./modules/scheduler/scheduler.module";
import { NotificationModule } from "./modules/notification/notification.module";
import { AiModule } from "./modules/ai/ai.module";
import { MetricsModule } from "./modules/metrics/metrics.module";
import { SystemConfigModule } from "./modules/config/config.module";
import { AuditModule } from "./modules/audit/audit.module";
import { HealthModule } from "./modules/health/health.module";
import { ApplicationModule } from "./modules/application/application.module";
import { ExecutorPackageModule } from "./modules/executor-package/executor-package.module";
import { RegistryModule } from "./modules/registry/registry.module";

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

        // Database
        DB_HOST: Joi.string().hostname().default("localhost"),
        DB_PORT: Joi.number().port().default(5432),
        DB_USERNAME: Joi.string().default("postgres"),
        DB_PASSWORD: Joi.string().min(1).required(),
        DB_DATABASE: Joi.string().default("autocodeflow"),
        // ARCH-006: explicit schema-synchronize switch (default false).
        // In production a value of "true" fails fast in configuration.ts.
        DB_SYNCHRONIZE: Joi.string().valid("true", "false").default("false"),

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
        EXECUTOR_SHARED_TOKEN: Joi.string().min(16).optional(),
        // N23: optional dedicated HMAC secret for per-execution callback
        // tokens; falls back to the executor shared token when unset.
        EXECUTION_CALLBACK_SECRET: Joi.string().min(16).optional(),

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

        // AI (optional)
        AI_PROVIDER: Joi.string()
          .valid("disabled", "openai", "ollama")
          .default("disabled"),
        OPENAI_API_KEY: Joi.string().allow("").optional(),
        OPENAI_MODEL: Joi.string().default("gpt-4o-mini"),
        OLLAMA_HOST: Joi.string().uri().default("http://localhost:11434"),
        OLLAMA_MODEL: Joi.string().default("llama3"),

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
        // users.service admin 种子账号（initialAdmin 节；密码缺省 = 跳过 seed）。
        INITIAL_ADMIN_PASSWORD: Joi.string().allow("").optional(),
        INITIAL_ADMIN_EMAIL: Joi.string().default("admin@autoflow.local"),

        // ARCH-27: logStorage 节（S3 外置日志）此前未注册（审计缺口）；
        // 全部可选，默认与 configuration.ts 回退一致。
        LOG_STORAGE_DRIVER: Joi.string().valid("db", "s3").default("db"),
        LOG_STORAGE_BUCKET: Joi.string().default("autoflow-logs"),
        LOG_STORAGE_ENDPOINT: Joi.string().allow("").optional(),
        LOG_STORAGE_ACCESS_KEY: Joi.string().allow("").optional(),
        LOG_STORAGE_SECRET_KEY: Joi.string().allow("").optional(),
        LOG_STORAGE_USE_SSL: Joi.string()
          .valid("true", "false")
          .default("false"),
        LOG_STORAGE_REGION: Joi.string().allow("").optional(),
      }),
      // Only validate in production and test environments
      validationOptions: {
        allowUnknown: true, // Allow unknown environment variables
        abortEarly: false, // Report all validation errors, not just the first one
      },
    }),

    // ARCH-004: global rate limit — tightened default (60 req/min, was 100)
    // and overridable via THROTTLE_LIMIT / THROTTLE_TTL. Sensitive routes keep
    // their own stricter @Throttle (e.g. auth login via LOGIN_THROTTLE_LIMIT).
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
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
      useFactory: (cfg: ConfigService) => ({
        type: "postgres",
        host: cfg.get("database.host"),
        port: cfg.get<number>("database.port"),
        username: cfg.get("database.username"),
        password: cfg.get("database.password"),
        database: cfg.get("database.database"),
        entities: [__dirname + "/**/*.entity{.ts,.js}"],
        migrations: [__dirname + "/migrations/*{.ts,.js}"],
        migrationsRun: cfg.get("app.nodeEnv") !== "development",
        // ARCH-006: explicit DB_SYNCHRONIZE switch (default false) instead of
        // inferring from NODE_ENV; production additionally forces/fails-fast
        // false in configuration.ts regardless of the env value.
        synchronize: cfg.get<boolean>("database.synchronize"),
        logging: cfg.get("app.nodeEnv") === "development",
        // PERF-04: PostgreSQL connection pool — default 10 is insufficient under concurrent load
        extra: {
          max: cfg.get<number>("database.poolSize"),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        },
      }),
      inject: [ConfigService],
    }),

    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (cfg: ConfigService) => ({
        connection: {
          host: cfg.get("redis.host"),
          port: cfg.get<number>("redis.port"),
          password: cfg.get("redis.password"),
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
          // Connection pool settings for better performance
          maxRedirections: 3, // Maximum redirections for cluster mode
          maxRetriesPerRequest: null,
          retryStrategy: (times: number) => {
            if (times > 10) {
              // Stop retrying after 10 attempts
              return null;
            }
            // Exponential backoff: 100ms, 200ms, 400ms, etc.
            return Math.min(times * 100, 3000);
          },
        },
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
      }),
      inject: [ConfigService],
    }),

    AuthModule,
    UsersModule,
    TaskModule,
    ExecutorModule,
    SchedulerModule,
    NotificationModule,
    AiModule,
    MetricsModule,
    SystemConfigModule,
    AuditModule,
    HealthModule,
    ApplicationModule,
    ExecutorPackageModule,
    RegistryModule,
  ],
  providers: [
    // A-02: apply ThrottlerGuard globally
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // A-03: apply JwtAuthGuard globally — use @Public() decorator to opt-out
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // R4 F-1: apply RolesGuard globally (after JwtAuthGuard so req.user is
    // populated). Routes without @Roles metadata stay available to any
    // authenticated user; @Public() routes carry no @Roles metadata and are
    // therefore unaffected. Enforcement is opt-in per route via @Roles(...).
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  // OPS-03: apply Trace ID middleware to every route
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceIdMiddleware).forRoutes("*");
  }
}
