/**
 * DSK-04 self-check for notifier-rules.ts（node:assert，无测试框架，
 * 对齐 path-domain/updater selftest 形态）。
 * notifier-rules.ts 是纯 Node 模块（仅依赖 path-domain.ts），可在裸 Node
 * 下直接 import 断言。Run via: npm run test:main
 */
import * as assert from 'node:assert';
import {
  TASK_NAME_MAX_LEN,
  sanitizeNotifyText,
  shouldNotifyExecutorStatus,
  shouldNotifyTaskTransition,
  summarizeExecMeta,
} from './notifier-rules';

function main(): void {
  // ── sanitizeNotifyText ────────────────────────────────────
  assert.equal(sanitizeNotifyText('my-task', 40), 'my-task', 'plain name passthrough');
  assert.equal(sanitizeNotifyText('  spaced   out  ', 40), 'spaced out', 'whitespace collapse');
  // 控制字符/换行剥除（通知必须单行；\n/\t 折叠为单空格而非直接吞掉）
  assert.equal(sanitizeNotifyText('line1\nline2', 40), 'line1 line2', 'newline collapses to space');
  assert.equal(sanitizeNotifyText('a\tb', 40), 'a b', 'tab collapses to space');
  assert.equal(sanitizeNotifyText('bad\u0000\u0007ctl', 40), 'badctl', 'control chars stripped');
  assert.equal(sanitizeNotifyText('zero\u200Bwidth', 40), 'zerowidth', 'zero-width stripped');
  // 截断限长
  const long = 'x'.repeat(100);
  const cut = sanitizeNotifyText(long, TASK_NAME_MAX_LEN);
  assert.ok(cut !== null && cut.length <= TASK_NAME_MAX_LEN, 'truncate within limit');
  assert.ok(cut !== null && cut.endsWith('…'), 'truncate appends ellipsis');
  // 非法输入
  assert.equal(sanitizeNotifyText(undefined, 40), null, 'undefined → null');
  assert.equal(sanitizeNotifyText(42, 40), null, 'number → null');
  assert.equal(sanitizeNotifyText('   \n\t ', 40), null, 'whitespace-only → null');

  // ── summarizeExecMeta ─────────────────────────────────────
  // 终态 success：提取事件，taskName 清洗后返回
  const ok = summarizeExecMeta({
    executionId: 'exec-abc_123', taskName: 'nightly  build', status: 'success',
  });
  assert.ok(ok, 'terminal success parsed');
  assert.equal(ok!.executionId, 'exec-abc_123');
  assert.equal(ok!.taskName, 'nightly build');
  assert.equal(ok!.status, 'success');

  // 终态 failed
  const fail = summarizeExecMeta({ executionId: 'e1', taskName: 't', status: 'failed' });
  assert.ok(fail && fail.status === 'failed', 'terminal failed parsed');

  // running → null（开始不通知）
  assert.equal(
    summarizeExecMeta({ executionId: 'e1', taskName: 't', status: 'running' }),
    null,
    'running → null',
  );
  // 缺 status / 缺 executionId → null
  assert.equal(summarizeExecMeta({ taskName: 't', status: 'success' }), null, 'missing id');
  assert.equal(summarizeExecMeta({ status: 'success' }), null, 'missing both fields');
  // executionId 带穿越/非法字符 → null（白名单字符集，与 path-domain 同规）
  assert.equal(
    summarizeExecMeta({ executionId: '../evil', taskName: 't', status: 'success' }),
    null,
    'traversal executionId rejected',
  );
  assert.equal(
    summarizeExecMeta({ executionId: 'has space', taskName: 't', status: 'success' }),
    null,
    'non-whitelist charset rejected',
  );
  // taskName 缺失 → 回落 executionId（终态通知不丢）
  const fallback = summarizeExecMeta({ executionId: 'exec-9', status: 'failed' });
  assert.ok(fallback && fallback.taskName === 'exec-9', 'taskName falls back to executionId');
  // taskName 恶意/超长 → 清洗
  const dirty = summarizeExecMeta({
    executionId: 'e2', taskName: 'evil\ntoken-leak', status: 'failed',
  });
  assert.ok(dirty && dirty.taskName === 'evil token-leak', 'malicious taskName sanitized (whitespace folded, newline stripped)');
  // 非对象输入
  assert.equal(summarizeExecMeta(null), null, 'null → null');
  assert.equal(summarizeExecMeta('string'), null, 'string → null');
  assert.equal(summarizeExecMeta([1, 2]), null, 'array → null');
  assert.equal(summarizeExecMeta(undefined), null, 'undefined → null');

  // ── shouldNotifyTaskTransition（终态去重）─────────────────
  assert.equal(shouldNotifyTaskTransition(undefined, 'success'), true, 'first-seen success notifies');
  assert.equal(shouldNotifyTaskTransition(undefined, 'failed'), true, 'first-seen failed notifies');
  assert.equal(shouldNotifyTaskTransition('running', 'success'), true, 'running→success notifies');
  assert.equal(shouldNotifyTaskTransition('running', 'failed'), true, 'running→failed notifies');
  assert.equal(shouldNotifyTaskTransition('success', 'success'), false, 'success dedup');
  assert.equal(shouldNotifyTaskTransition('failed', 'failed'), false, 'failed dedup');
  assert.equal(shouldNotifyTaskTransition('success', 'failed'), true, 'flip notifies (fail-safe)');

  // ── shouldNotifyExecutorStatus（离线通知转移表）────────────
  // 全状态 × 全前状态穷举：只有 online/pending → offline 报
  const statuses = ['online', 'pending', 'stopped', 'offline'] as const;
  for (const prev of [undefined, ...statuses] as const) {
    for (const next of statuses) {
      const expected =
        next === 'offline' && prev !== undefined && prev !== 'offline' && prev !== 'stopped';
      const got = shouldNotifyExecutorStatus(prev as any, next);
      assert.equal(
        got, expected,
        `transition ${String(prev)}→${next} expected ${expected}`,
      );
    }
  }
  assert.equal(shouldNotifyExecutorStatus('online', 'offline'), true, 'online→offline notifies');
  assert.equal(shouldNotifyExecutorStatus('pending', 'offline'), true, 'pending→offline (start fail) notifies');
  assert.equal(shouldNotifyExecutorStatus('stopped', 'offline'), false, 'stopped→offline silent');
  assert.equal(shouldNotifyExecutorStatus(undefined, 'offline'), false, 'cold-start offline silent');
  assert.equal(shouldNotifyExecutorStatus('online', 'online'), false, 'no repeat');
  assert.equal(shouldNotifyExecutorStatus('offline', 'online'), false, 'recovery not notified');

  console.log('notifier-rules selftest: all assertions passed');
}

main();
