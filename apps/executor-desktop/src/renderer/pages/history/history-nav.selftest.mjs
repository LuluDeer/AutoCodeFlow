const {
  nextHistoryIndex,
  formatDuration,
  statusTone,
  rowErrorSummary,
  isStaleRunning,
} = await import('./history-nav.ts');

const eq = (got, want, msg) => {
  if (got !== want) {
    throw new Error(`history-nav.selftest: ${msg} (got ${String(got)}, want ${String(want)})`);
  }
};

eq(nextHistoryIndex('ArrowDown', 0, 5), 1, 'ArrowDown 向下移动一行');
eq(nextHistoryIndex('ArrowDown', 4, 5), 4, 'ArrowDown 末行封顶不越界');
eq(nextHistoryIndex('ArrowUp', 3, 5), 2, 'ArrowUp 向上移动一行');
eq(nextHistoryIndex('ArrowUp', 0, 5), 0, 'ArrowUp 首行保底不越界');
eq(nextHistoryIndex('Home', 3, 5), 0, 'Home 跳转首行');
eq(nextHistoryIndex('End', 1, 5), 4, 'End 跳转末行');
eq(nextHistoryIndex('Enter', 1, 5), null, '非方向键不拦截');
eq(nextHistoryIndex('ArrowDown', 0, 0), null, '空列表返回 null');

eq(formatDuration(undefined), '—', '缺失时长显示 —');
eq(formatDuration(500), '500ms', '毫秒档位');
eq(formatDuration(90_000), '1m 30s', '分钟档位');
eq(formatDuration(3_720_000), '1h 2m', '小时档位');
eq(statusTone('failed'), 'is-failed', '失败状态类');
eq(statusTone('running'), 'is-running', '运行中状态类');
eq(
  rowErrorSummary({ executionId: '1', taskId: 't', taskName: 'T', startTime: 1, status: 'failed', errorMessage: 'boom\n  detail' }, (c) => `exit ${c}`),
  'boom detail',
  '错误摘要压缩空白',
);
eq(
  rowErrorSummary({ executionId: '1', taskId: 't', taskName: 'T', startTime: 1, status: 'failed', exitCode: 2 }, (c) => `exit ${c}`),
  'exit 2',
  '无错误消息时回退退出码',
);
eq(
  isStaleRunning({ executionId: '1', taskId: 't', taskName: 'T', startTime: 1000, status: 'running' }, 1000 + 7 * 3600_000, 6 * 3600_000),
  true,
  '超阈值 running 标为僵死',
);

console.log('history-nav selftest passed');
