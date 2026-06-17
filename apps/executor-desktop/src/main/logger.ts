import log from 'electron-log';
import { app } from 'electron';
import * as path from 'path';

// 配置日志文件路径
log.transports.file.resolvePathFn = () =>
  path.join(app.getPath('userData'), 'logs', 'main.log');
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB

export default log;
