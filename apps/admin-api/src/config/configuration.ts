import { parseAllowedOrigins } from "../common/utils/cors-origin.util";

/**
 * 配置读取规约（ARCH-27 配置中心收口）
 *
 * 1. 新增配置必须先在 app.module.ts 的 ConfigModule validationSchema（Joi）
 *    注册，再在本文件映射为配置对象；运行时消费方一律注入 ConfigService 并
 *    以 `configService.get("section.key")` 读取。
 * 2. 禁止在业务代码中直读 process.env —— .eslintrc.js 的
 *    no-restricted-properties 规则已封禁，违规会导致 lint 失败。
 * 3. 直读豁免清单（维护位置：.eslintrc.js overrides，每处带理由注释）：
 *    - 本文件（configuration.ts）：唯一合法的 env → 配置映射层（ConfigModule load）；
 *    - src/config/env.ts（getEnvVar）：模块求值期/无 DI 场景的唯一收口 util，
 *      背景是 W-22 前科 —— 装饰器参数求值早于 ConfigModule 生命周期，
 *      main.ts 已在 import app.module 前预载 .env（见 main.ts 头部注释）；
 *    - src/main.ts：bootstrap 预载段（W-22 修复现场，先于 DI 存在）；
 *    - 测试/spec 文件（spec 与 test 目录）：fixture 需直接操纵 env。
 * 4. Joi 未注册但本文件读取的 env 属于审计缺口，发现即补注册
 *    （ARCH-27 已补：LOGIN_THROTTLE_LIMIT、REQUEST_TIMEOUT_MS、
 *    INITIAL_ADMIN_PASSWORD/EMAIL、LOG_RETENTION_DAYS、API_BASE_URL、
 *    APP_PROTOCOL、DB_POOL_SIZE、EXECUTOR_HEARTBEAT_*、LOG_STORAGE_*）。
 */
export default () => ({
  app: {
    port: parseInt(process.env.PORT, 10) || 3105,
    nodeEnv: process.env.NODE_ENV || "development",
    protocol: process.env.APP_PROTOCOL || "http",
    // ARCH-27: 全局请求超时（REQUEST_TIMEOUT_MS）—— 此前由
    // timeout.interceptor 在模块求值期直读 process.env（W-22 风险模式），
    // 现注册后由拦截器经 ConfigService 读取，默认 30s。
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || "30000", 10),
    // ARCH-27: 对外可达的基础 URL —— application.controller 生成 executor
    // 可拉取的 packageUrl 时 fail-fast 校验所需，此前未注册（审计缺口）。
    apiBaseUrl: process.env.API_BASE_URL || "",
    // ARCH-27: TRUST_PROXY 在此登记注册（Joi 已有 schema）。main.ts 仍在
    // bootstrap 期直读（豁免，见 main.ts 头部），注册用于文档化与后续收口。
    trustProxy: process.env.TRUST_PROXY === "true",
    // ARCH-27: OS/容器注入的进程标识（非部署配置，无需 Joi 注册；
    // metrics.instance.hostname 展示用，此前 metrics.service 直读 process.env）。
    hostname: process.env.HOSTNAME ?? "",
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
    // N16 / ARCH-27: 登录路由限流（@Throttle 装饰器求值期约束见
    // auth.controller.ts 头部注释与 W-22 记录）。默认 20。
    loginLimit: parseInt(process.env.LOGIN_THROTTLE_LIMIT || "20", 10),
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
    // ARCH-27: SSRF 豁免开关在此统一注册 —— 运行时消费方
    // （safe-http.util.assertSafeExecutorUrl）经 ConfigService 读取，
    // 不再直读 process.env。
    allowPrivateNetwork: process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK === "true",
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
  // ARCH-27: 初次部署 admin 种子账号（users.service onModuleInit）。
  // 此前 users.service 直读 process.env（未注册，审计缺口）；现注册后经
  // ConfigService 读取。INITIAL_ADMIN_PASSWORD 仅弱值告警（见文件尾）。
  initialAdmin: {
    password: process.env.INITIAL_ADMIN_PASSWORD || "",
    email: process.env.INITIAL_ADMIN_EMAIL || "admin@autoflow.local",
  },
  // ARCH-27: 执行日志保留天数（log-retention-cleanup.service，每日 cron
  // 分批清理 execution_log_lines）。此前该服务直读 process.env 且未注册
  // （审计缺口）；非法值回退逻辑保留在服务内（Joi 注册允许任意字符串）。
  logRetention: {
    days: parseInt(process.env.LOG_RETENTION_DAYS || "30", 10),
  },
  // ARCH-22: execution_log_lines 按日分区的清理路径开关。默认 true——
  // 库已分区化（迁移 1789900000002）时清理走 DETACH PARTITION + 每日
  // 预建未来分区；false 回退 legacy 分批 DELETE 路径（schema 不回滚，
  // 重新开启无需迁移）。
  logPartition: {
    enabled: process.env.LOG_PARTITION_ENABLED !== "false",
  },
  // SEC-02: 任务级 secrets 落库加密的 key（KMS 语义：32 字节 hex/base64，
  // 短口令会被 sha-256 拉伸——建议 openssl rand -hex 32）。未配置时降级
  // 明文存储并 warn 一次（零破坏升级路径），见
  // common/utils/secret-crypto.util.service.ts。
  secrets: {
    key: process.env.SEC_SECRETS_KEY || "",
  },
  // OBS-02: Alertmanager webhook 入站鉴权 secret（POST /api/alerts/webhook
  // 的 HMAC-SHA256 over `${timestamp}.${rawBody}`）。未配置时端点 503 拒绝
  // （安全缺省——绝不退化为无鉴权接收，防告警伪造）。Alertmanager 侧配置
  // 样例见 docs/observability/README.md 的 OBS-02 段。
  alert: {
    webhookSecret: process.env.ALERT_WEBHOOK_SECRET || "",
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

  // SEC-02 / ARCH-27 收编: production 下每个 CORS origin 必须是合法的
  // http(s) URL —— 此前该校验在 main.ts bootstrap 内直读 env 重复实现，
  // 现收编到配置层（fail-fast 时点从 NestFactory.create 前移至 ConfigModule
  // 初始化，仍在监听端口之前），main.ts 保留复核注释。
  for (const origin of corsAllowed) {
    if (!origin.startsWith("https://") && !origin.startsWith("http://")) {
      throw new Error(
        `CORS_ALLOWED_ORIGINS origin "${origin}" must start with http:// or https://`,
      );
    }
    try {
      new URL(origin);
    } catch {
      throw new Error(
        `CORS_ALLOWED_ORIGINS origin "${origin}" is not a valid URL`,
      );
    }
  }

  // ARCH-006: production 显式请求 DB_SYNCHRONIZE=true 时 fail-fast，
  // 防止不受控的 schema 修改；synchronize 一律走 migrations。
  if (process.env.DB_SYNCHRONIZE === "true") {
    throw new Error(
      "[AutoFlow] DB_SYNCHRONIZE=true is forbidden in production — use migrations instead",
    );
  }

  // Validate initial admin password is changed (ARCH-27: seed 逻辑已注册至
  // initialAdmin 节，users.service 经 ConfigService 读取)
  const initialAdminPassword = process.env.INITIAL_ADMIN_PASSWORD ?? "";
  if (weakValues.has(initialAdminPassword)) {
    console.warn(
      "[AutoFlow] WARNING: INITIAL_ADMIN_PASSWORD is using a weak default. Change it immediately after first deployment.",
    );
  }
}
