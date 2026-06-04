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
    secret: process.env.JWT_SECRET || 'default-secret-change-in-production',
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
