/**
 * 日志行解析回归：V2 状态页/日志面板共用。
 * 覆盖桌面主进程与 executor-node（winston）的四种真实格式。
 */
import assert from 'node:assert';
import { parseLogLine } from '../../executor-desktop-v2/src/lib/log-parse.ts';

const cases = [
  ['2026-10-21 15:29:01.123 [INFO] heartbeat ok', '15:29:01', 'INFO', 'heartbeat ok'],
  ['2026-10-21T07:29:01.123Z [WARN] slow', '07:29:01', 'WARN', 'slow'],
  ['15:29:01 [ERROR] boom', '15:29:01', 'ERROR', 'boom'],
  ['15:29:01 INFO  plain', '15:29:01', 'INFO', 'plain'],
  ['[2026-10-21 15:29:01.123] [info]  main', '15:29:01', 'INFO', 'main'],
  ['{"timestamp":"2026-10-21T15:29:01.123Z","level":"warn","message":"json"}', '15:29:01', 'WARN', 'json'],
  ['untouched text', '', 'INFO', 'untouched text'],
];

for (const [line, time, level, body] of cases) {
  const parsed = parseLogLine(line);
  assert.equal(parsed.time, time, `time: ${line}`);
  assert.equal(parsed.level, level, `level: ${line}`);
  assert.equal(parsed.body, body, `body: ${line}`);
}
console.log(`log-parse selftest: ${cases.length} formats passed`);
