export default () => ({
  app: {
    port: parseInt(process.env.PORT, 10) || 3001,
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'autoflow',
  },
  jwt: {
    // S4: fail-fast on weak/missing secrets — throw at startup rather than silently using defaults
    secret: (() => {
      const s = process.env.JWT_SECRET;
      if (!s || s === 'default-secret-change-in-production' || s.length < 32) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('JWT_SECRET must be set to a strong value (>=32 chars) in production');
        }
        return s || 'default-secret-change-in-production';
      }
      return s;
    })(),
    refreshSecret: (() => {
      const s = process.env.JWT_REFRESH_SECRET;
      if (!s || s.length < 32) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('JWT_REFRESH_SECRET must be set to a strong value (>=32 chars) in production');
        }
        return s || 'default-refresh-secret-change-in-production';
      }
      return s;
    })(),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },
  ai: {
    provider: process.env.AI_PROVIDER || 'disabled', // disabled | openai | ollama
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3',
  },
  executor: {
    // S-04: shared token executors must present; empty only allowed in dev (with warning)
    sharedToken: (() => {
      // SEC-04: read EXECUTOR_SECRET (matches docker-compose.yml injection key)
      const t = process.env.EXECUTOR_SECRET || process.env.EXECUTOR_SHARED_TOKEN || '';
      if (!t) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('[AutoFlow] EXECUTOR_SECRET must be set in production');
        }
        // eslint-disable-next-line no-console
        console.warn('[AutoFlow] WARNING: EXECUTOR_SECRET is empty — executor auth is disabled (dev only)');
      }
      return t;
    })(),
  },
  notification: {
    wecomWebhook: process.env.WECOM_WEBHOOK || '',
    dingtalkWebhook: process.env.DINGTALK_WEBHOOK || '',
    slackWebhook: process.env.SLACK_WEBHOOK || '',
    email: {
      host: process.env.EMAIL_HOST || '',
      port: parseInt(process.env.EMAIL_PORT, 10) || 465,
      secure: process.env.EMAIL_SECURE !== 'false',
      user: process.env.EMAIL_USER || '',
      pass: process.env.EMAIL_PASS || '',
      from: process.env.EMAIL_FROM || 'autoflow@noreply.com',
      to: process.env.EMAIL_TO || '',
    },
  },
});

// M3: fail-fast in production for critical secrets that have known weak defaults
if (process.env.NODE_ENV === 'production') {
  const weakValues = new Set([
    'autoflow123', 'change-this-secret-in-production',
    'change-me-in-production', 'postgres', '',
  ]);
  if (weakValues.has(process.env.DB_PASSWORD ?? '')) {
    throw new Error('[AutoFlow] DB_PASSWORD is unset or using a weak default in production');
  }
  if (!process.env.EXECUTOR_SECRET || process.env.EXECUTOR_SECRET.length < 16) {
    throw new Error('[AutoFlow] EXECUTOR_SECRET must be set (>=16 chars) in production');
  }
}
