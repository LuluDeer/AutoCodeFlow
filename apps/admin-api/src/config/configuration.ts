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
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  },
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
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

  // Validate CORS origins
  const corsOrigins = process.env.CORS_ORIGINS ?? "";
  if (
    !corsOrigins ||
    corsOrigins.includes("localhost") ||
    corsOrigins.includes("127.0.0.1")
  ) {
    throw new Error(
      "[AutoFlow] CORS_ORIGINS must be set to production domains (no localhost) in production",
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
