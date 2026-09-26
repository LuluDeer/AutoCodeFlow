/**
 * P7e 前半 self-check：isolated-runner——Agent 直接执行任务的独立执行端点
 * （08 §2.4 方案 A / 09 §2.4）。
 * Run via: npm run test:main
 *
 * 覆盖：deploy-only 档如实拒绝（绝不静默执行）/ isolated-runner 档真跑
 * （复用 process 沙箱）/ 证据记录与日志落盘 / 来源标记由平台代码打 /
 * 沙箱拒绝如实进记录（不伪装成运行失败）。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ISOLATED_RUNS_DIR, runIsolatedTask } from './isolated-runner';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  \u2714 ${name}`);
  else {
    failures++;
    console.error(`  \u2718 ${name}${extra ? ` \u2014 ${extra}` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('\n=== isolated-runner selftest ===\n');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-runner-'));
  try {
    console.log('-- 1. deploy-only 档如实拒绝（档位闸在动作之前判）--');
    {
      const r = await runIsolatedTask({
        workspaceRoot: workDir,
        entry: { interpreter: 'node', path: 'main.js' },
        runSeq: 1,
        source: 'agent:sop:test',
        codeExecution: 'sandbox',
        taskExecution: 'deploy-only',
      });
      check('拒绝且未执行任何东西', r.ok === false && r.refusal !== null && r.exitCode === null);
      check('拒绝原因点名档位', (r.refusal ?? '').includes('deploy-only'));
      check('无证据日志（动作没发生）', !fs.existsSync(path.join(workDir, ISOLATED_RUNS_DIR)));
    }

    console.log('-- 2. isolated-runner 档真跑（与试跑同一套沙箱纪律）--');
    {
      fs.writeFileSync(path.join(workDir, 'main.js'), "require('fs').writeFileSync('task-out.txt', 'ran');\n", 'utf8');
      const r = await runIsolatedTask({
        workspaceRoot: workDir,
        entry: { interpreter: 'node', path: 'main.js' },
        runSeq: 1,
        source: 'agent:sop:test',
        codeExecution: 'sandbox',
        taskExecution: 'isolated-runner',
      });
      check('执行成功', r.ok === true && r.exitCode === 0 && r.refusal === null, JSON.stringify(r).slice(0, 160));
      check('来源标记由平台代码打', r.source === 'agent:sop:test');
      check('候选真的执行了（副作用落盘）', fs.existsSync(path.join(workDir, 'task-out.txt')));
      check('证据日志落盘且可读', r.logPath === `${ISOLATED_RUNS_DIR}/run-1.log` &&
        fs.readFileSync(path.join(workDir, ISOLATED_RUNS_DIR, 'run-1.log'), 'utf8').includes('stdout'));
      check('输出摘要非空', r.outputSummary.length === 0 || typeof r.outputSummary === 'string');
    }

    console.log('-- 3. 沙箱拒绝如实进记录（不伪装成运行失败）--');
    {
      const r = await runIsolatedTask({
        workspaceRoot: workDir,
        // LLM 可能在执行时刻改口要 shell——封闭枚举拒绝，且这一事实要进证据
        entry: { interpreter: 'bash', path: 'main.sh' },
        runSeq: 2,
        source: 'agent:sop:test',
        codeExecution: 'sandbox',
        taskExecution: 'isolated-runner',
      });
      check('非枚举解释器被拒且 refusal 说明原因', r.ok === false && (r.refusal ?? '').includes('封闭枚举'));
      check('执行失败但不掩盖拒绝语义', r.exitCode === null);
    }

    console.log('-- 4. codeExecution=off 时沙箱档位闸兜底 --');
    {
      const r = await runIsolatedTask({
        workspaceRoot: workDir,
        entry: { interpreter: 'node', path: 'main.js' },
        runSeq: 3,
        source: 'agent:sop:test',
        codeExecution: 'off',
        taskExecution: 'isolated-runner',
      });
      check('off 档拒绝执行（第二道闸不因 taskExecution 放开而失效）',
        r.ok === false && (r.refusal ?? '').includes('off'));
    }

    console.log('-- 5. 失败运行也留证据（退出码非零）--');
    {
      fs.writeFileSync(path.join(workDir, 'bad.js'), "process.exit(3);\n", 'utf8');
      const r = await runIsolatedTask({
        workspaceRoot: workDir,
        entry: { interpreter: 'node', path: 'bad.js' },
        runSeq: 4,
        source: 'agent:sop:test',
        codeExecution: 'sandbox',
        taskExecution: 'isolated-runner',
      });
      check('非零退出如实记录', r.ok === false && r.exitCode === 3 && r.refusal === null);
      check('日志记录了失败运行', fs.readFileSync(path.join(workDir, ISOLATED_RUNS_DIR, 'run-4.log'), 'utf8').includes('exit=3'));
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  assert.ok(true);
  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== isolated-runner selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
