type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * AutoFlowLogger — lightweight logger for task execution.
 * Matches the Python SDK's get_logger() interface.
 */
export class AutoFlowLogger {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${this.name}]`;
    const formatted = args.length > 0 ? `${message} ${args.map(String).join(' ')}` : message;
    console.log(`${prefix} ${formatted}`);
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log('info', message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, ...args);
  }
}

export function getLogger(name: string): AutoFlowLogger {
  return new AutoFlowLogger(name);
}