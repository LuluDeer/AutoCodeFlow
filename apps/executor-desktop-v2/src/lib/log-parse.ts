export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface ParsedLogLine {
  time: string;
  level: LogLevel;
  body: string;
}

/**
 * 两种真实日志格式：
 *   1) executor / 任务日志：`HH:MM:SS INFO  message`
 *   2) 桌面主进程 logger：`[2026-10-21 02:41:27.424] [info] message`
 *      （也兼容 `INFO  [ts] [lvl] message`）
 */
export function parseLogLine(line: string): ParsedLogLine {
  const simple = /^(\d{2}:\d{2}:\d{2})\s+(INFO|WARN|ERROR)\s+(.*)$/.exec(line);
  if (simple) {
    return { time: simple[1], level: simple[2] as LogLevel, body: simple[3] };
  }
  const main = /^(INFO|WARN|ERROR)\s+\[([^\]]+)\]\s+(?:\[[^\]]*\]\s+)?(.*)$/.exec(line);
  if (main) {
    const clock = /\d{2}:\d{2}:\d{2}/.exec(main[2]);
    return { time: clock ? clock[0] : '', level: main[1] as LogLevel, body: main[3] };
  }
  const bracketed = /^\[([^\]]+)\]\s+\[([a-zA-Z]+)\]\s+(.*)$/.exec(line);
  if (bracketed) {
    const clock = /\d{2}:\d{2}:\d{2}/.exec(bracketed[1]);
    const raw = bracketed[2].toUpperCase();
    const level: LogLevel =
      raw === 'ERROR' ? 'ERROR' : raw === 'WARN' || raw === 'WARNING' ? 'WARN' : 'INFO';
    return { time: clock ? clock[0] : '', level, body: bracketed[3] };
  }
  return { time: '', level: 'INFO', body: line };
}
