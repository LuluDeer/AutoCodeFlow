const {
  nextHistoryIndex,
  formatDuration,
  statusTone,
  rowErrorSummary,
  isStaleRunning,
  historyDeepLinkFromDetail,
  resolveHistoryDeepLink,
} = await import('./history-nav.ts');
const { normalizeTabSwitchDetail } = await import('../../tab-switch.ts');

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

// T1/T3 白名单载荷：未知字段必须被剥掉（token / 错误报文 / 路径 / 原型污染）。
const hostile = JSON.parse('{"tab":"history","historyExecutionId":"exec-1","historyTaskQuery":"日报同步","historyStatusFilter":"failed","token":"SECRET","errorMessage":"/private/path leaked","filePath":"/etc/passwd","nested":{"admin":true},"__proto__":{"polluted":true}}');
const detail = normalizeTabSwitchDetail(hostile);
eq(JSON.stringify(Object.keys(detail).sort()),
  JSON.stringify(['historyExecutionId', 'historyStatusFilter', 'historyTaskQuery', 'tab']),
  '白名单只保留 tab + 三枚 history* 字段');
eq(detail.historyExecutionId, 'exec-1', '执行 ID 保留');
eq(detail.historyTaskQuery, '日报同步', '任务检索串保留');
eq(detail.historyStatusFilter, 'failed', '合法状态过滤保留');
eq({}.polluted, undefined, '原型污染字段不得进入全局对象');
eq(normalizeTabSwitchDetail({ tab: 'admin' }), null, '非法 tab 不切换');
eq(normalizeTabSwitchDetail({ tab: 'history', historyStatusFilter: 'bogus' }).historyStatusFilter,
  undefined, '非法状态过滤被剥');
eq(normalizeTabSwitchDetail({ tab: 'bogus' }), null, '未知 tab 被拒');
eq(normalizeTabSwitchDetail('history').tab, 'history', '纯字符串形态向后兼容');
eq(normalizeTabSwitchDetail({ tab: 'history', historyExecutionId: 'x'.repeat(257) }).historyExecutionId,
  undefined, '超长 ID 被拒绝');
// 两份白名单归一（tab-switch / history-nav）必须对同一 hostile 载荷给出同一结论。
const local = historyDeepLinkFromDetail(hostile);
eq(local.executionId, detail.historyExecutionId, '两份归一的 ID 口径一致');
eq(local.query, detail.historyTaskQuery, '两份归一的检索串口径一致');
eq(local.statusFilter, detail.historyStatusFilter, '两份归一的状态过滤口径一致');

// T3 深链命中：先按执行 ID，再按任务名，未知字段不影响命中。
const link = historyDeepLinkFromDetail({ ...hostile, extra: 'ignored' });
eq(link.executionId, 'exec-1', '深链取执行 ID');
eq(link.query, '日报同步', '深链取任务检索串');
const hit = resolveHistoryDeepLink([
  { executionId: 'exec-2', taskId: 't-1', taskName: '日报同步', startTime: 2 },
  { executionId: 'exec-1', taskId: 't-2', taskName: '别的任务', startTime: 1 },
], link);
eq(hit.executionId, 'exec-1', '执行 ID 优先命中具体那次执行');
const byName = resolveHistoryDeepLink([
  { executionId: 'exec-2', taskId: 't-1', taskName: '日报同步', startTime: 2 },
], { query: '日报同步' });
eq(byName.executionId, 'exec-2', '仅任务名时回落到最近一次同任务执行');
eq(historyDeepLinkFromDetail({ tab: 'status', historyExecutionId: 'e' }).executionId,
  undefined, '非 history 深链不命中');
eq(resolveHistoryDeepLink([], { executionId: 'pending' }).executionId,
  'pending', '数据未到达时保留待定位 ID');

console.log('history-nav selftest passed');
