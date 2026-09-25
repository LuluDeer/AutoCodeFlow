/**
 * P7a 续批 self-check：runtime 装配（LLM relay 协议 + 真沙箱 + 真验收）
 * 与 loop 骨架的端到端行为。
 * Run via: npm run test:main
 *
 * 反证锚点：
 *   · happy path：plan 产出文件 → 沙箱试跑 → acceptance 验收 → delivered；
 *   · 试跑失败 → diagnose（retry，带修正文件）→ 二轮通过 → delivered；
 *   · LLM 判定 clarify → 循环以 clarification_requested 收敛（不自行猜测）；
 *   · codeExecution=off → 档位闸拒绝（permission_denied），试跑零发生；
 *   · LLM 输出不合法 JSON / 缺 entry → outcome=error（协议违规如实暴露，
 *     绝不猜测语义继续跑）；
 *   · acceptance 缺失/不合法 → verify=false（验收锚点缺失绝不默认通过）。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAgentLoop } from './loop';
import { resolveLocalPermissions } from './permission-profile';
import type { EnvironmentReport } from './perception';
import { buildLoopHandlers, type SopPayload } from './runtime';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  \u2714 ${name}`);
  else {
    failures++;
    console.error(`  \u2718 ${name}${extra ? ` \u2014 ${extra}` : ''}`);
  }
}

/** 脚本化 LLM：按调用次序回放响应（模拟中台 relay）。 */
function makeLlm(responses: string[]) {
  const seen: string[] = [];
  return {
    seen,
    async chat(input: { messages: Array<{ role: string; content: string }> }) {
      const last = input.messages[input.messages.length - 1].content;
      // 存全文（循环断言要检查上下文注入；响应队列按「每轮 plan + 每次诊断」消耗）
      seen.push(last);
      const next = responses.shift();
      return { ok: true, content: next ?? '{"action":"escalate"}' };
    },
  };
}

function makeEnv(): EnvironmentReport {
  return {
    probedAt: new Date().toISOString(),
    platform: 'test', platformRelease: '1', arch: 'x64', hostname: 'selftest',
    cpuCount: 2, totalMemoryMB: 1024, freeMemoryMB: 512,
    runtimes: [{ name: 'node', available: true, version: 'v24.0.0' }],
    capabilities: ['filesystem', 'http'],
  };
}

function makeSop(acceptance: Array<Record<string, unknown>>): SopPayload {
  return {
    slug: 'selftest-sop', title: 'T', version: '1.0.0', contentHash: 'h',
    frontMatter: { capabilities: ['filesystem'], acceptance, constraints: {} },
    bodyMarkdown: '# 做什么\n产出 out.txt（内容 fine）。',
  };
}

const MAIN_OK = "require('fs').writeFileSync('out.txt', 'fine');\n";
const MAIN_BAD = "require('fs').writeFileSync('out.txt', 'fine');\nprocess.exit(1);\n";
const VERIFY_OK = "require('fs').assert = require('assert');\nconst c = require('fs').readFileSync('out.txt', 'utf8');\nif (c !== 'fine') process.exit(2);\nconsole.log('acceptance ok');\n";

function planJson(entry: string, main: string, verify: string): string {
  return JSON.stringify({
    files: [
      { path: 'main.js', content: main },
      { path: 'verify.js', content: verify },
    ],
    entry: { interpreter: 'node', path: entry },
    notes: 'write file then verify',
  });
}

async function main(): Promise<void> {
  console.log('\n=== runtime selftest ===\n');
  const permissions = resolveLocalPermissions({ preset: 'standard' });

  // ── 1. happy path：一轮通过 ──
  console.log('-- 1. happy path --');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-'));
    const llm = makeLlm([planJson('main.js', MAIN_OK, VERIFY_OK)]);
    const result = await runAgentLoop({
      environment: makeEnv(),
      permissions,
      handlers: buildLoopHandlers(
        { address: 'a:1', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws, environment: makeEnv() },
        llm,
      ),
    });
    check('一轮 delivered', result.outcome === 'delivered', `outcome=${result.outcome} msg=${result.stopMessage ?? ''}`);
    check('试跑 1 次、迭代 1 轮', result.trialRuns === 1 && result.iterations === 1);
    check('产物落盘', fs.readFileSync(path.join(ws, 'out.txt'), 'utf8') === 'fine');
    check('plan 的输入含 SOP 与环境（baseContext 注入）', llm.seen[0].includes('selftest-sop') && llm.seen[0].includes('platform'));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 2. 失败 → diagnose(retry) → 二轮 plan → 通过 ──
  console.log('-- 2. 失败与修正 --');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-'));
    const llm = makeLlm([
      planJson('main.js', MAIN_BAD, VERIFY_OK),
      JSON.stringify({ action: 'retry', files: [{ path: 'main.js', content: MAIN_OK }] }),
      // 循环每轮都先 plan——retry 的修正文件已由 diagnose 落盘，第二轮
      // plan 再次产出同样的好文件（模型重写一遍是常态）
      planJson('main.js', MAIN_OK, VERIFY_OK),
    ]);
    const result = await runAgentLoop({
      environment: makeEnv(),
      permissions,
      handlers: buildLoopHandlers(
        { address: 'a:1', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws, environment: makeEnv() },
        llm,
      ),
    });
    check('二轮 delivered', result.outcome === 'delivered' && result.iterations === 2, `outcome=${result.outcome} msg=${result.stopMessage ?? ''}`);
    check('试跑 2 次', result.trialRuns === 2);
    check('diagnose 的输入含试跑输出', llm.seen[1].includes('exit=1'));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 3. LLM 判定 clarify ──
  console.log('-- 3. 澄清收敛 --');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-'));
    const llm = makeLlm([
      planJson('main.js', MAIN_BAD, VERIFY_OK),
      JSON.stringify({ action: 'clarify', question: 'SOP 没说 out.txt 的编码' }),
    ]);
    const result = await runAgentLoop({
      environment: makeEnv(),
      permissions,
      handlers: buildLoopHandlers(
        { address: 'a:1', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws, environment: makeEnv() },
        llm,
      ),
    });
    check('clarification_requested', result.outcome === 'clarification_requested');
    check('澄清问题透传', (result.pendingQuestion ?? '').includes('澄清'));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 4. 档位闸：off 不许试跑 ──
  console.log('-- 4. 档位闸 --');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-'));
    const off = resolveLocalPermissions({ preset: 'minimal' });
    assert.equal(off.codeExecution, 'off');
    const llm = makeLlm([planJson('main.js', MAIN_OK, VERIFY_OK)]);
    const result = await runAgentLoop({
      environment: makeEnv(),
      permissions: off,
      handlers: buildLoopHandlers(
        { address: 'a:1', client: {} as never, permissions: off, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws, environment: makeEnv() },
        llm,
      ),
    });
    check('off 档 → permission_denied', result.outcome === 'permission_denied' && result.stopReason === 'trial_run_not_permitted');
    check('试跑零发生', result.trialRuns === 0 && !fs.existsSync(path.join(ws, 'out.txt')));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 5. 协议违规：LLM 输出不是 JSON / 缺 entry ──
  console.log('-- 5. 协议违规 --');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-'));
    const llm = makeLlm(['我觉得应该先看看目录再说，具体代码我下一步给你。']);
    const result = await runAgentLoop({
      environment: makeEnv(),
      permissions,
      handlers: buildLoopHandlers(
        { address: 'a:1', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws, environment: makeEnv() },
        llm,
      ),
    });
    check('非 JSON 输出 → outcome=error（不猜测语义）', result.outcome === 'error' && (result.stopMessage ?? '').includes('JSON'));
    fs.rmSync(ws, { recursive: true, force: true });

    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-'));
    const llm2 = makeLlm([JSON.stringify({ files: [], notes: 'no entry' })]);
    const result2 = await runAgentLoop({
      environment: makeEnv(),
      permissions,
      handlers: buildLoopHandlers(
        { address: 'a:1', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws2, environment: makeEnv() },
        llm2,
      ),
    });
    check('缺合法 entry → outcome=error', result2.outcome === 'error' && (result2.stopMessage ?? '').includes('entry'));
    fs.rmSync(ws2, { recursive: true, force: true });
  }

  // ── 6. 验收锚点纪律 ──
  console.log('-- 6. 验收锚点 --');
  {
    // acceptance 缺失 → verify 恒 false → 循环进诊断路径，绝不 delivered
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-'));
    const llm = makeLlm([
      planJson('main.js', MAIN_OK, VERIFY_OK),
      JSON.stringify({ action: 'escalate' }),
    ]);
    const result = await runAgentLoop({
      environment: makeEnv(),
      permissions,
      handlers: buildLoopHandlers(
        { address: 'a:1', client: {} as never, permissions, sop: makeSop([]), workspaceRoot: ws, environment: makeEnv() },
        llm,
      ),
    });
    check('无 acceptance → 不得 delivered（验收锚点缺失绝不默认通过）', result.outcome === 'escalated');
    fs.rmSync(ws, { recursive: true, force: true });

    // -c 内联形态 → 本地无法按封闭枚举验证 → 如实判失败进诊断
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-'));
    const llm2 = makeLlm([
      planJson('main.js', MAIN_OK, VERIFY_OK),
      JSON.stringify({ action: 'escalate' }),
    ]);
    const result2 = await runAgentLoop({
      environment: makeEnv(),
      permissions,
      handlers: buildLoopHandlers(
        { address: 'a:1', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node -c "console.log(1)"' }]), workspaceRoot: ws2, environment: makeEnv() },
        llm2,
      ),
    });
    check('-c 形态不被偷换成跑别的文件（escalate 而非 delivered）', result2.outcome === 'escalated');
    fs.rmSync(ws2, { recursive: true, force: true });
  }

  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== runtime selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
