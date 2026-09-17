import log from 'electron-log';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// 日志保留天数
const LOG_RETENTION_DAYS = 7;

// 按日期命名日志文件：executor-2026-09-16.log
function getLogFileName(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `executor-${y}-${m}-${d}.log`;
}

// 配置日志文件路径——按日期命名，每天一个文件
log.transports.file.resolvePathFn = () => {
  const logDir = path.join(app.getPath('userData'), 'logs');
  // 确保目录存在
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  return path.join(logDir, getLogFileName());
};
log.transports.file.level = 'info';
log.transports.console.level = 'debug';

/**
 * P3-1：把设置页的 logLevel（'info' | 'debug' | 'error'）应用到桌面端**文件**
 * 日志。console transport 保持 debug（仅开发台可见，不影响落盘量）。
 * 此前 config-store 里的 logLevel 既无生产者也无消费者，是个"加了下拉框也
 * 不会生效"的陷阱字段；子进程侧由 buildExecutorChildEnv 透传 LOG_LEVEL 给
 * executor-node 的 winston logger，本函数负责桌面端自身这一侧。
 * 非法/空值统一回落 info，绝不抛错（它在配置保存热路径上）。
 */
export function applyLogLevel(level: string | undefined): void {
  const allowed = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'];
  const next = level && allowed.includes(level) ? level : 'info';
  log.transports.file.level = next as typeof log.transports.file.level;
}
// 单文件最大 10MB（按日期切割为主，大小切割为辅）
log.transports.file.maxSize = 10 * 1024 * 1024;

// 启动时清理 N 天前的旧日志
function cleanOldLogs(): void {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logDir)) return;

    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(logDir);

    for (const file of files) {
      // 只处理 executor-YYYY-MM-DD.log 格式的文件
      if (!file.startsWith('executor-') || !file.endsWith('.log')) continue;
      const fullPath = path.join(logDir, file);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fullPath);
        console.log(`[logger] Cleaned old log: ${file}`);
      }
    }
  } catch (err) {
    console.error('[logger] Failed to clean old logs:', err);
  }
}

// 应用 ready 后执行清理（惰性调用，不在模块顶层执行，避免纯 Node.js 测试环境报错）
export function initLogCleanup(): void {
  app.whenReady().then(() => {
    cleanOldLogs();
    // 每天检查一次
    setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);
  });
}

export default log;
