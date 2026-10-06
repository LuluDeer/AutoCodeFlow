/**
 * N-06①：agent-worker stdio JSON 行协议守卫。
 *
 * fail-closed 面的用例矩阵：合法消息全字段可解析；畸形/缺字段/错型一律 null
 * （调用方丢弃并记日志，绝不带病进入状态机）。Run via: npm run test:main
 */

import * as assert from 'node:assert';
import {
  isAgentHostStats,
  parseAgentWorkerEvent,
  parseAgentWorkerRequest,
} from './agent-worker-protocol';

const VALID_CONFIG = {
  agentEnabled: true,
  adminApiUrl: 'http://127.0.0.1:8080',
  executorToken: 'tok',
  agent: { preset: 'standard' },
};

function main(): void {
  // ── 请求侧：合法五形态 ─────────────────────────────────────────────
  const init = parseAgentWorkerRequest(JSON.stringify({
    t: 'init', address: 'host:9001', workDir: '/tmp/w', config: VALID_CONFIG,
  }));
  assert.ok(init && init.t === 'init');
  assert.strictEqual(init.address, 'host:9001');

  assert.ok(parseAgentWorkerRequest(JSON.stringify({ t: 'config', config: VALID_CONFIG })));
  assert.ok(parseAgentWorkerRequest(JSON.stringify({ t: 'tick' })));
  assert.ok(parseAgentWorkerRequest(JSON.stringify({ t: 'withdraw' })));
  assert.ok(parseAgentWorkerRequest(JSON.stringify({ t: 'shutdown' })));

  // ── 请求侧：fail-closed 矩阵 ───────────────────────────────────────
  for (const bad of [
    'not json',
    '[]',
    'null',
    JSON.stringify({ t: 'init' }),                                    // 缺字段
    JSON.stringify({ t: 'init', address: 'a', workDir: 'b' }),        // 缺 config
    JSON.stringify({ t: 'init', address: 'a', workDir: 'b', config: { agentEnabled: 'yes' } }), // 错型
    JSON.stringify({ t: 'config', config: null }),
    JSON.stringify({ t: 'unknown-kind' }),                            // 未知类型
    JSON.stringify({ t: 'tick-result' }),                             // 事件混入请求通道
  ]) {
    assert.strictEqual(parseAgentWorkerRequest(bad), null, `must reject: ${bad}`);
  }

  // ── 事件侧：合法形态 ───────────────────────────────────────────────
  const ready = parseAgentWorkerEvent(JSON.stringify({
    t: 'ready', playwrightContract: { browsersJson: true },
  }));
  assert.ok(ready && ready.t === 'ready' && ready.playwrightContract.browsersJson === true);

  const tickResult = parseAgentWorkerEvent(JSON.stringify({ t: 'tick-result', worked: true }));
  assert.ok(tickResult && tickResult.t === 'tick-result');

  const withDetail = parseAgentWorkerEvent(JSON.stringify({ t: 'tick-result', worked: false, detail: 'poll failed: x' }));
  assert.ok(withDetail && withDetail.t === 'tick-result' && withDetail.detail === 'poll failed: x');

  assert.ok(parseAgentWorkerEvent(JSON.stringify({ t: 'withdraw-done' })));

  const stats = parseAgentWorkerEvent(JSON.stringify({
    t: 'stats',
    stats: { working: true, lastAssignmentId: 'a1', lastOutcome: null, processed: 2, lastEffectiveProfile: 'standard(ce=sandbox)' },
  }));
  assert.ok(stats && stats.t === 'stats' && stats.stats.working === true && stats.stats.processed === 2);

  const log = parseAgentWorkerEvent(JSON.stringify({ t: 'log', level: 'warn', line: 'x' }));
  assert.ok(log && log.t === 'log' && log.level === 'warn');

  // ── 事件侧：fail-closed 矩阵 ───────────────────────────────────────
  for (const bad of [
    'not json',
    'null',
    JSON.stringify({ t: 'ready', playwrightContract: {} }),           // 缺 browsersJson
    JSON.stringify({ t: 'ready' }),
    JSON.stringify({ t: 'tick-result' }),                             // 缺 worked
    JSON.stringify({ t: 'tick-result', worked: 1 }),                  // 错型
    JSON.stringify({ t: 'tick-result', worked: true, detail: 5 }),    // detail 错型
    JSON.stringify({ t: 'stats', stats: { working: true } }),         // 缺字段
    JSON.stringify({ t: 'stats', stats: { working: true, lastAssignmentId: 'a', lastOutcome: 'x', processed: '2', lastEffectiveProfile: null } }),
    JSON.stringify({ t: 'log', level: 'verbose', line: 'x' }),        // 级别封闭
    JSON.stringify({ t: 'init', address: 'a' }),                      // 请求混入事件通道
  ]) {
    assert.strictEqual(parseAgentWorkerEvent(bad), null, `must reject: ${bad}`);
  }

  // ── isAgentHostStats 直检（托盘快照消费前的形状闸） ──────────────────
  assert.strictEqual(isAgentHostStats(null), false);
  assert.strictEqual(isAgentHostStats({}), false);
  assert.strictEqual(isAgentHostStats({
    working: false, lastAssignmentId: null, lastOutcome: null, processed: 0, lastEffectiveProfile: null,
  }), true);

  console.log('agent-worker-protocol.selftest: all assertions passed');
}

main();
