/**
 * ① 托盘实时活动计数 selftest（node:assert，无测试框架，对齐 meta-files 形态）。
 *
 * 纯计数 `countRunningTasks` 钉口径：只有 `status === 'running'` 计入，其余终态 /
 * 脏条目不计；`scanRunningCount` 用临时 meta 目录验证容错扫描（读坏文件跳过、
 * 目录缺失返回 0）。Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { countRunningTasks, scanRunningCount } from './running-count';

function main(): void {
  // ── 纯计数口径 ──────────────────────────────────────────────
  assert.equal(countRunningTasks([]), 0, '空列表 → 0');
  assert.equal(
    countRunningTasks([
      { status: 'running' },
      { status: 'success' },
      { status: 'failed' },
      { status: 'running' },
      null,
      undefined,
      { status: 'queued' },
    ]),
    2,
    '仅 running 计入，终态/脏条目跳过',
  );
  assert.equal(countRunningTasks([{ status: 'Running' }, { status: 'RUNNING' }]), 0, '大小写敏感，不兜底');

  // ── fs 容错扫描（临时目录）───────────────────────────────────
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-running-'));
  const metaDir = path.join(dir, 'meta');
  fs.mkdirSync(metaDir, { recursive: true });
  const write = (name: string, body: string) => fs.writeFileSync(path.join(metaDir, name), body);

  write('r1.json', JSON.stringify({ executionId: 'r1', status: 'running' }));
  write('r2.json', JSON.stringify({ executionId: 'r2', status: 'running' }));
  write('ok.json', JSON.stringify({ executionId: 'ok', status: 'success' }));
  write('bad.json', '{ broken json');
  assert.equal(scanRunningCount(metaDir), 2, '扫描只计 running，读坏文件跳过');

  assert.equal(scanRunningCount(null), 0, '空目录 → 0');
  assert.equal(scanRunningCount(path.join(dir, 'missing')), 0, '缺失目录 → 0 不抛错');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('running-count selftest: all assertions passed');
}

main();
