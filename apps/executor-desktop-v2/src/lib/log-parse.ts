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
function normalizeLevel(raw: string): LogLevel {
  const level = raw.toUpperCase();
  if (level === 'ERROR' || level === 'FATAL') return 'ERROR';
  if (level === 'WARN' || level === 'WARNING') return 'WARN';
  return 'INFO';
}

function parseLogLineRaw(line: string): ParsedLogLine {
  // executor-node（winston）：`2026-10-21 15:29:01.123 [INFO] message`
  const dated = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?\s+\[([A-Z]+)\]\s*(.*)$/i.exec(
    line,
  );
  if (dated) {
    return { time: dated[2], level: normalizeLevel(dated[3]), body: dated[4] };
  }
  // 无日期的 executor 变体：`15:29:01 [INFO] message`
  const clockBracket = /^(\d{2}:\d{2}:\d{2})\s+\[([A-Z]+)\]\s*(.*)$/i.exec(line);
  if (clockBracket) {
    return { time: clockBracket[1], level: normalizeLevel(clockBracket[2]), body: clockBracket[3] };
  }
  // executor 的 JSON 日志（ACF_LOG_JSON=1）
  if (line.trimStart().startsWith('{')) {
    try {
      const obj = JSON.parse(line) as { timestamp?: string; level?: string; message?: string };
      const clock = /\d{2}:\d{2}:\d{2}/.exec(obj.timestamp ?? '');
      if (obj.message) {
        return {
          time: clock ? clock[0] : '',
          level: normalizeLevel(obj.level ?? 'info'),
          body: obj.message,
        };
      }
    } catch {
      /* 不是合法 JSON，走普通行 */
    }
  }
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


const SOURCE_TAG = /^\[(executor(?::err|:out)?|worker|stdout|stderr)\]\s*/i;
const NESTED_PREFIX =
  /^(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?\s+(?:\[[A-Z]+\]|INFO|WARN|WARNING|ERROR|DEBUG|TRACE)\s*(.*)$/i;

/**
 * 去掉“日志套日志”的前缀：桌面主进程会把子进程 stdout 包成
 * `[executor] 2026-… [INFO] message`，右侧正文不该再重复时间/级别。
 */
function cleanupBody(body: string): string {
  let out = body.trimStart();
  for (let round = 0; round < 3; round += 1) {
    const source = SOURCE_TAG.exec(out);
    if (source) {
      out = out.slice(source[0].length);
      continue;
    }
    const nested = NESTED_PREFIX.exec(out);
    if (nested) {
      out = nested[1];
      continue;
    }
    break;
  }
  return out;
}

export function parseLogLine(line: string): ParsedLogLine {
  const parsed = parseLogLineRaw(line);
  return { ...parsed, body: cleanupBody(parsed.body) };
}
