import { Module, NestModule, MiddlewareConsumer } from "@nestjs/common";
import { TraceIdMiddleware } from "./common/middleware/trace-id.middleware";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bull";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
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

        // Database
        DB_HOST: Joi.string().hostname().default("localhost"),
        DB_PORT: Joi.number().port().default(5432),
        DB_USERNAME: Joi.string().default("postgres"),
        DB_PASSWORD: Joi.string().min(1).required(),
        DB_DATABASE: Joi.string().default("autocodeflow"),

        // Redis
        REDIS_HOST: Joi.string().hostname().default("localhost"),
        REDIS_PORT: Joi.number().port().default(6379),
        REDIS_PASSWORD: Joi.string().allow("").optional(),

        // JWT
        JWT_SECRET: Joi.string().min(32).required(),
        JWT_REFRESH_SECRET: Joi.string().min(32).required(),
        JWT_EXPIRES_IN: Joi.string().default("7d"),

        // Executor
        EXECUTOR_SECRET: Joi.string().min(16).required(),
        EXECUTOR_SHARED_TOKEN: Joi.string().min(16).optional(),

        // CORS
        CORS_ORIGINS: Joi.string().default("http://localhost:5173"),

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
      }),
      // Only validate in production and test environments
      validationOptions: {
        allowUnknown: true, // Allow unknown environment variables
        abortEarly: false, // Report all validation errors, not just the first one
      },
    }),

    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 100 }],
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
        synchronize: cfg.get("app.nodeEnv") === "development",
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
        redis: {
          host: cfg.get("redis.host"),
          port: cfg.get<number>("redis.port"),
          password: cfg.get("redis.password"),
          // PERF-03: Redis connection pool optimization
          enableOfflineQueue: true, // Queue commands when offline
          connectTimeout: 10000, // 10 seconds connection timeout
          lazyConnect: false, // Connect immediately on startup
          keepAlive: 10000, // Keep-alive interval (10 seconds)
          family: 4, // IPv4
          // Connection pool settings for better performance
          maxRedirections: 3, // Maximum redirections for cluster mode
          retryStrategy: (times: number) => {
            if (times > 10) {
              // Stop retrying after 10 attempts
              return null;
            }
            // Exponential backoff: 100ms, 200ms, 400ms, etc.
            return Math.min(times * 100, 3000);
          },
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
  ],
})
export class AppModule implements NestModule {
  // OPS-03: apply Trace ID middleware to every route
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceIdMiddleware).forRoutes("*");
  }
}
