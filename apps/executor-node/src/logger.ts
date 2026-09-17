import { createLogger, format, transports } from 'winston';

// LOG_LEVEL 透传：compose（docker-compose.yml 的 LOG_LEVEL: ${LOG_LEVEL:-info}）
// 与桌面端（buildExecutorChildEnv 把设置页 logLevel 下发为 LOG_LEVEL）共用这一
// 个键。此前本文件把 level 硬编码为 'info'，导致桌面端 config.logLevel 是个
// 没有消费者的死字段、.env.example 里的 LOG_LEVEL 也不生效。白名单校验：
// 非法值静默回落 info，绝不因为一个拼错的级别让日志子系统在启动路径上抛错。
const ALLOWED_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
const requestedLevel = (process.env.LOG_LEVEL || '').toLowerCase();
const logLevel = ALLOWED_LEVELS.includes(requestedLevel) ? requestedLevel : 'info';

export const logger = createLogger({
  level: logLevel,
  format: format.combine(
    format.timestamp(),
    format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    }),
  ),
  transports: [new transports.Console()],
});
