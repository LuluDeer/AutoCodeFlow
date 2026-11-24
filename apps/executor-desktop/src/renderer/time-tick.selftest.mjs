import assert from 'node:assert/strict';
import { hasRunningRecord, shouldTickRunning } from './time-tick.ts';

const T0 = 1_700_000_000_000;
const running = [{ status: 'running', startTime: T0 - 30_000 }];
const terminal = [
  { status: 'success', startTime: T0 - 30_000, endTime: T0 },
  { status: 'failed', startTime: T0 - 20_000, endTime: T0 },
];

assert.equal(hasRunningRecord(null), false, '读取失败（null）不得启动 ticker');
assert.equal(hasRunningRecord([]), false, '空列表不启动 ticker');
assert.equal(hasRunningRecord(terminal), false, '只有终态记录不启动 ticker');
assert.equal(hasRunningRecord(running), true, '存在 running 行才启动 ticker');
assert.equal(
  hasRunningRecord([{ status: 'running', startTime: Number.NaN }]),
  false,
  '脏时间戳不得启动 ticker',
);

assert.equal(shouldTickRunning(running, T0 + 999, T0), false, '不足 1s 不推进（定时器漂移）');
assert.equal(shouldTickRunning(running, T0 + 1000, T0), true, '满 1s 推进');
assert.equal(shouldTickRunning(running, T0 + 2500, T0 + 1000), true, '后续每秒继续推进');
assert.equal(shouldTickRunning(terminal, T0 + 5000, T0), false, '终态后停摆');
assert.equal(shouldTickRunning(null, T0 + 5000, T0), false, '读取失败后停摆');
assert.equal(shouldTickRunning(running, Number.NaN, T0), false, '脏时间不推进');
assert.equal(shouldTickRunning(running, T0 + 5000, T0 - 5000), true, '隐藏期恢复后补推进一次');

console.log('time-tick selftest: running-only gating and 1s cadence passed');
