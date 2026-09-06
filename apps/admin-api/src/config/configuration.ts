import { parseAllowedOrigins } from "../common/utils/cors-origin.util";

export default () => ({
  app: {
    port: parseInt(process.env.PORT, 10) || 3105,
    nodeEnv: process.env.NODE_ENV || "development",
    protocol: process.env.APP_PROTOCOL || "http",
  },
  database: {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    username: process.env.DB_USERNAME || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_DATABASE || "autocodeflow",
    poolSize: parseInt(process.env.DB_POOL_SIZE || "20", 10),
    // ARCH-006: synchronize 不再依赖 NODE_ENV 推断，改为显式 DB_SYNCHRONIZE 开关
    // （Joi 默认 "false"）；生产环境强制 false 并 warn，见文件尾的 fail-fast 校验块。
    synchronize:
      process.env.DB_SYNCHRONIZE === "true" &&
      process.env.NODE_ENV !== "production",
  },
  // ARCH-004: 全局限流默认收紧为 60 次/分钟（原 100），可用环境变量覆盖
  throttle: {
    ttl: parseInt(process.env.THROTTLE_TTL || "60000", 10),
    limit: parseInt(process.env.THROTTLE_LIMIT || "60", 10),
  },
  // SSE 日志流并发上限（进程内计数）：单 execution / 全局。
  // task.service.ts 读取本配置节；此前 sse 节从未注册，env 覆盖是死代码，现补齐。
  sse: {
    maxStreamsPerExecution: parseInt(
      process.env.SSE_MAX_STREAMS_PER_EXECUTION || "4",
      10,
    ),
    maxStreamsGlobal: parseInt(process.env.SSE_MAX_STREAMS_GLOBAL || "64", 10),
  },
  jwt: {
    // S4: fail-fast on weak/missing secrets — throw at startup rather than silently using defaults
    secret: (() => {
      const s = process.env.JWT_SECRET;
      if (!s || s === "default-secret-change-in-production" || s.length < 32) {
        if (process.env.NODE_ENV === "production") {
          throw new Error(
            "JWT_SECRET must be set to a strong value (>=32 chars) in production",
          );
        }
        return s || "default-secret-change-in-production";
      }
      return s;
    })(),
    refreshSecret: (() => {
      const s = process.env.JWT_REFRESH_SECRET;
      if (!s || s.length < 32) {
        if (process.env.NODE_ENV === "production") {
          throw new Error(
            "JWT_REFRESH_SECRET must be set to a strong value (>=32 chars) in production",
          );
        }
        return s || "default-refresh-secret-change-in-production";
      }
      return s;
    })(),
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
  },
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    // ARCH-005: REDIS_TLS=true 时 ioredis/BullMQ 走 TLS 传输加密；
    // REDIS_TLS_REJECT_UNAUTHORIZED=false 仅建议在自签证书调试时使用（默认校验证书）。
    tls: process.env.REDIS_TLS === "true",
    tlsRejectUnauthorized:
      process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== "false",
  },
  // ARCH-001: CORS 显式白名单 —— 优先 CORS_ALLOWED_ORIGINS，兼容旧的 CORS_ORIGINS。
  // 为空时仅开发环境默认放行 http://localhost:* / http://127.0.0.1:*（见 main.ts）；
  // 私有/LAN 网段不再被自动放行，内网部署需显式配置。
  cors: {
    allowedOrigins: parseAllowedOrigins(
      process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGINS,
    ),
  },
  ai: {
    provider: process.env.AI_PROVIDER || "disabled", // disabled | openai | ollama
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
    ollamaHost: process.env.OLLAMA_HOST || "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_MODEL || "llama3",
  },
  executor: {
    heartbeatInterval:
      parseInt(process.env.EXECUTOR_HEARTBEAT_INTERVAL, 10) || 30000,
    heartbeatTimeoutMultiplier:
      parseInt(process.env.EXECUTOR_HEARTBEAT_TIMEOUT_MULTIPLIER, 10) || 3,
    // S-04: shared token executors must present; empty only allowed in dev (with warning)
    sharedToken: (() => {
      // SEC-04: read EXECUTOR_SECRET (matches docker-compose.yml injection key)
      const t =
        process.env.EXECUTOR_SECRET || process.env.EXECUTOR_SHARED_TOKEN || "";
      if (!t) {
        if (process.env.NODE_ENV === "production") {
          throw new Error(
            "[AutoFlow] EXECUTOR_SECRET must be set in production",
          );
        }
        // eslint-disable-next-line no-console
        console.warn(
          "[AutoFlow] WARNING: EXECUTOR_SECRET is empty — executor auth is disabled (dev only)",
        );
      }
      return t;
    })(),
  },
  // P2: stale sweep 重试预算兑现开关。true（默认）时，sweep 赢得 RUNNING→
  // FAILED 条件 UPDATE 后，对重试预算未耗尽的执行创建新 PENDING execution
  // 并入队（re-enqueue 前 best-effort kill 原执行器进程）；false 恢复旧的
  // "只置 FAILED 不重试"行为。见 scheduler.service.recoverStaleExecutions。
  scheduler: {
    staleRecoveryRetryEnabled:
      process.env.STALE_RECOVERY_RETRY_ENABLED !== "false",
  },
  // N23: dedicated secret for per-execution callback tokens (HMAC key
  // material). Optional: falls back to the executor shared token when
  // unset — executor-node derives the same key from its own env, so both
  // sides must agree on whichever source is active.
  executionCallback: {
    secret: process.env.EXECUTION_CALLBACK_SECRET || "",
  },
  logStorage: {
    // 'db' keeps log lines in execution_log_lines (default);
    // 's3' stores one gzip object per execution (MinIO/S3) and only the
    // object reference in the DB — see optimization-notes 2.6.
    driver: process.env.LOG_STORAGE_DRIVER || "db",
    bucket: process.env.LOG_STORAGE_BUCKET || "autoflow-logs",
    endpoint: process.env.LOG_STORAGE_ENDPOINT || "",
    accessKey: process.env.LOG_STORAGE_ACCESS_KEY || "",
    secretKey: process.env.LOG_STORAGE_SECRET_KEY || "",
    useSSL: process.env.LOG_STORAGE_USE_SSL === "true",
    region: process.env.LOG_STORAGE_REGION || "",
  },
  // R7: Prometheus 抓取端点（GET /api/metrics）开关。
  // enabled=false → 端点 404（多实例下避免重复抓取或安全收紧场景）；
  // defaultMetricsEnabled 控制是否挂载进程默认指标（CPU/内存/GC）。
  metrics: {
    prometheus: {
      enabled: process.env.METRICS_PROMETHEUS_ENABLED !== "false",
      defaultMetricsEnabled:
        process.env.METRICS_PROMETHEUS_DEFAULT_METRICS_ENABLED !== "false",
    },
  },
  // S5: optional Verdaccio service account used by the registry proxy
  // (modules/registry) when listing npm packages. registry-npm requires
  // authentication for every package pattern (`access: $authenticated`),
  // so without these credentials the admin npm package list stays empty
  // (anonymous 401 → []). A pre-issued token (NPM_REGISTRY_TOKEN) wins over
  // user/password login. All three are optional: unset keeps the previous
  // anonymous behavior.
  registry: {
    npm: {
      token: process.env.NPM_REGISTRY_TOKEN || "",
      user: process.env.NPM_REGISTRY_USER || "",
      pass: process.env.NPM_REGISTRY_PASS || "",
    },
  },
  notification: {
    wecomWebhook: process.env.WECOM_WEBHOOK || "",
    dingtalkWebhook: process.env.DINGTALK_WEBHOOK || "",
    slackWebhook: process.env.SLACK_WEBHOOK || "",
    email: {
      host: process.env.EMAIL_HOST || "",
      port: parseInt(process.env.EMAIL_PORT, 10) || 465,
      secure: process.env.EMAIL_SECURE !== "false",
      user: process.env.EMAIL_USER || "",
      pass: process.env.EMAIL_PASS || "",
      from: process.env.EMAIL_FROM || "autocodeflow@noreply.com",
      to: process.env.EMAIL_TO || "",
    },
  },
});

// M3: fail-fast in production for critical secrets that have known weak defaults
if (process.env.NODE_ENV === "production") {
  const weakValues = new Set([
    "autocodeflow123",
    "change-this-secret-in-production",
    "change-me-in-production",
    "postgres",
    "",
    "admin123",
    "password",
    "secret",
    "changeme",
    "change-me-at-least-32-chars-in-production",
    "change-me-refresh-secret-at-least-32-chars",
    "change-me-executor-shared-secret",
    "change-me-pypi-password",
    "change-me-pypi-api-key",
    "change_me_to_a_random_secret_32chars",
    "change_me_to_another_random_secret_32chars",
    "change_me_to_a_random_token_16chars",
    "change_me_immediately",
  ]);

  // Validate database password
  const dbPassword = process.env.DB_PASSWORD ?? "";
  if (weakValues.has(dbPassword) || dbPassword.length < 16) {
    throw new Error(
      "[AutoFlow] DB_PASSWORD must be set to a strong value (>=16 chars, not a weak default) in production",
    );
  }

  // Validate JWT secrets
  const jwtSecret = process.env.JWT_SECRET ?? "";
  if (weakValues.has(jwtSecret) || jwtSecret.length < 32) {
    throw new Error(
      "[AutoFlow] JWT_SECRET must be set to a strong value (>=32 chars, not a weak default) in production",
    );
  }

  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET ?? "";
  if (weakValues.has(jwtRefreshSecret) || jwtRefreshSecret.length < 32) {
    throw new Error(
      "[AutoFlow] JWT_REFRESH_SECRET must be set to a strong value (>=32 chars, not a weak default) in production",
    );
  }

  // Validate executor secret
  const executorSecret =
    process.env.EXECUTOR_SECRET || process.env.EXECUTOR_SHARED_TOKEN || "";
  if (weakValues.has(executorSecret) || executorSecret.length < 16) {
    throw new Error(
      "[AutoFlow] EXECUTOR_SECRET must be set to a strong value (>=16 chars, not a weak default) in production",
    );
  }

  // ARCH-001: production 必须配置显式 CORS 白名单。优先 CORS_ALLOWED_ORIGINS；
  // 未设置新变量时回退校验旧的 CORS_ORIGINS（保持向后兼容）。
  const corsAllowed = parseAllowedOrigins(
    process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGINS,
  );
  if (corsAllowed.length === 0) {
    throw new Error(
      "[AutoFlow] CORS_ALLOWED_ORIGINS must be set to explicit production origins in production",
    );
  }
  if (
    corsAllowed.some((o) => o.includes("localhost") || o.includes("127.0.0.1"))
  ) {
    throw new Error(
      "[AutoFlow] CORS_ALLOWED_ORIGINS must not contain localhost/127.0.0.1 in production",
    );
  }

  // ARCH-006: production 显式请求 DB_SYNCHRONIZE=true 时 fail-fast，
  // 防止不受控的 schema 修改；synchronize 一律走 migrations。
  if (process.env.DB_SYNCHRONIZE === "true") {
    throw new Error(
      "[AutoFlow] DB_SYNCHRONIZE=true is forbidden in production — use migrations instead",
    );
  }

  // Validate initial admin password is changed
  const initialAdminPassword = process.env.INITIAL_ADMIN_PASSWORD ?? "";
  if (weakValues.has(initialAdminPassword)) {
    console.warn(
      "[AutoFlow] WARNING: INITIAL_ADMIN_PASSWORD is using a weak default. Change it immediately after first deployment.",
    );
  }
}
