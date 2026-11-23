import assert from 'node:assert/strict';
import {
  formatCopyLiveText,
  formatFailureTime,
  formatFailureTitle,
  formatFullDateTime,
  formatRunningDuration,
  formatRunningTaskTitle,
  isEditableTarget,
} from './status-helpers.ts';

// 1. formatFailureTime: 今日只显 HH:mm，跨日补 MM/DD HH:mm
const now = new Date(2026, 10, 23, 14, 30, 0).getTime(); // 2026-11-23 14:30 local
const sameDay = new Date(2026, 10, 23, 9, 5, 0).getTime();
const prevDay = new Date(2026, 10, 20, 11, 27, 0).getTime();
const prevYear = new Date(2025, 11, 31, 23, 59, 0).getTime();

assert.equal(formatFailureTime(sameDay, now), '09:05');
assert.equal(formatFailureTime(prevDay, now), '11/20 11:27');
assert.equal(formatFailureTime(prevYear, now), '12/31 23:59');
assert.equal(formatFailureTime(undefined, now), '—');
assert.equal(formatFailureTime(Number.NaN, now), '—');

// 2. formatFullDateTime & formatFailureTitle
assert.equal(formatFullDateTime(prevDay), '2026-11-20 11:27');
assert.equal(
  formatFailureTitle(
    { startTime: prevDay, taskName: 'Daily Sync', errorMessage: 'Exit code 1' },
    '未命名任务',
    '查看历史',
  ),
  '2026-11-20 11:27 · Daily Sync — Exit code 1',
);
assert.equal(
  formatFailureTitle({ startTime: sameDay, taskName: '' }, 'Unnamed task', 'View history'),
  '2026-11-23 09:05 · Unnamed task',
);
assert.equal(
  formatFailureTitle({ errorMessage: 'Boom' }, 'Unnamed task', 'View history'),
  'Unnamed task — Boom',
);

// 3. formatRunningTaskTitle & formatRunningDuration
assert.equal(formatRunningTaskTitle('Inventory Sync', 'running 26h 12m'), 'Inventory Sync · running 26h 12m');
assert.equal(formatRunningTaskTitle('Inventory Sync', null), 'Inventory Sync');
assert.equal(
  formatRunningDuration(now - 65 * 60_000, (ms) => `${Math.floor(ms / 60_000)}m`, (d) => `running ${d}`, now),
  'running 65m',
);
assert.equal(
  formatRunningDuration(null, (ms) => `${ms}`, (d) => d, now),
  null,
);

// 4. formatCopyLiveText
assert.equal(formatCopyLiveText('idle', 'Copied', 'Failed'), '');
assert.equal(formatCopyLiveText('copied', 'Copied', 'Failed'), 'Copied');
assert.equal(formatCopyLiveText('error', 'Copied', 'Too large'), 'Too large');

// 5. isEditableTarget
assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
assert.equal(isEditableTarget({ tagName: 'textarea' }), true);
assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: false }), false);
assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false);
assert.equal(isEditableTarget(null), false);

console.log('status-helpers selftest: all assertions passed');
