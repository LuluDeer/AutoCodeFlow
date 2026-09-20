/**
 * DSK-04 self-check for notifier-rules.ts（node:assert，无测试框架，
 * 对齐 path-domain/updater selftest 形态）。
 * notifier-rules.ts 是纯 Node 模块（仅依赖 path-domain.ts），可在裸 Node
 * 下直接 import 断言。Run via: npm run test:main
 */
import * as assert from 'node:assert';
import {
  TASK_NAME_MAX_LEN,
  META_KNOWN_LIMIT,
  decideScan,
  pruneSeenByLiveFiles,
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

  // ── decideScan（NETOPT-G P1-1：水位线决策纯函数，P2-F3 通知风暴回归锁）──
  const fin = (id: string, status: 'success' | 'failed') =>
    ({ file: `${id}.json`, raw: { executionId: id, taskName: 't', status } });
  // 1) silentFirstScan：只推进水位线、零通知（重启/切 workDir 后首扫静默追平）
  {
    const d = decideScan([fin('a1', 'success'), fin('a2', 'failed')], new Map(), new Map(), true);
    assert.equal(d.toNotify.length, 0, 'silent first scan emits nothing');
    assert.equal(d.newSeen.get('a1'), 'success', 'silent first scan still records seen');
    assert.equal(d.newSeen.get('a2'), 'failed', 'silent first scan records failed too');
    assert.ok(d.newKnown.has('a1.json'), 'silent first scan records known');
  }
  // 2) normal：首见 success/failed 产出通知
  {
    const d = decideScan([fin('b1', 'success'), fin('b2', 'failed')], new Map(), new Map(), false);
    assert.equal(d.toNotify.length, 2, 'first-seen terminal emits both');
    assert.equal(d.toNotify[0].event.executionId, 'b1');
    assert.equal(d.toNotify[1].event.status, 'failed');
  }
  // 3) 同 id 同状态二次见不产出（去重；文件已定稿只记 known）
  {
    const seen = new Map([['c1', 'success']]);
    const d = decideScan([fin('c1', 'success')], seen, new Map(), false);
    assert.equal(d.toNotify.length, 0, 'same-status repeat deduped');
    assert.ok(d.newKnown.has('c1.json'), 'dedup still records known');
  }
  // 4) known 被裁后重读同 id 不产出（seen 仍拦截——裁剪只损效率不损正确）
  {
    const known = new Map([['c1.json', 1]]);
    const seen = new Map([['c1', 'success']]);
    const d = decideScan([fin('c1', 'success')], seen, known, false);
    assert.equal(d.toNotify.length, 0, 're-read after known trim still deduped by seen');
  }
  // 5) known 超限只裁 known、**绝不裁 seen**（P2-F3 语义锁——若有人把两表
  //    同节奏裁剪加回，这里立即红）
  {
    const items = Array.from({ length: 60 }, (_, i) => fin(`k${String(i).padStart(3, '0')}`, 'success'));
    const seen = new Map<string, string>();
    const known = new Map<string, number>();
    for (const it of items) { seen.set(it.raw.executionId as string, 'success'); known.set(it.file, 1); }
    // 注入超过 META_KNOWN_LIMIT 的老 known 条目，触发裁剪
    for (let i = 0; i < META_KNOWN_LIMIT; i++) known.set(`old-${i}.json`, 1);
    const d = decideScan(items, seen, known, false);
    assert.ok(d.newKnown.size <= 500, 'known trimmed to retain window');
    assert.equal(d.newSeen.size, 60, 'seen NEVER trimmed with known (P2-F3)');
    assert.equal(d.toNotify.length, 0, 'pre-seen items emit nothing');
  }
  // 6) pruneSeenByLiveFiles：按本轮磁盘存在性删死条目（history:clear/TTL 后）
  {
    const seen = new Map([
      ['live-1', 'success'],
      ['dead-1', 'failed'],
      ['running-1', 'success'], // 不在磁盘也不在 seen 语义外的假想——懒清只看文件
    ]);
    const live = new Set(['live-1.json', 'other-running.json']);
    const pruned = pruneSeenByLiveFiles(seen, live);
    assert.equal(pruned.has('live-1'), true, 'live file keeps seen entry');
    assert.equal(pruned.has('dead-1'), false, 'deleted meta prunes seen entry');
    assert.equal(pruned.size, 1, 'only live entries retained');
  }

  console.log('notifier-rules selftest: all assertions passed');
}

main();
