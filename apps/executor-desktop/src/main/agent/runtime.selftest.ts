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
 *   · LLM 首次不合法 JSON → 带修复指令重试一次；仍不合法 / 缺 entry →
 *     outcome=error（协议违规如实暴露，绝不猜测语义继续跑）；
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
import type { GuiDriver, GuiDriverInput } from './gui';

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
  /** 原始 content（可能是多模态 part 数组），供图片注入断言。 */
  const seenRaw: Array<unknown> = [];
  return {
    seen,
    seenRaw,
    async chat(input: {
      messages: Array<{
        role: string;
        content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
      }>;
    }) {
      const raw = input.messages[input.messages.length - 1].content;
      seenRaw.push(raw);
      const last = typeof raw === 'string'
        ? raw
        : raw.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
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
        { address: 'a:1', assignmentId: '11111111-1111-1111-1111-111111111111', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws, environment: makeEnv() },
        llm,
      ),
    });
    check('一轮 delivered', result.outcome === 'delivered', `outcome=${result.outcome} msg=${result.stopMessage ?? ''}`);
    check('试跑 1 次、迭代 1 轮', result.trialRuns === 1 && result.iterations === 1);
    check('产物落盘', fs.readFileSync(path.join(ws, 'out.txt'), 'utf8') === 'fine');
    check('plan 的输入含 SOP 与环境（baseContext 注入）', llm.seen[0].includes('selftest-sop') && llm.seen[0].includes('platform'));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 1b. 瞬态 relay 失败：重试一次后继续 ──
  console.log('-- 1b. 瞬态 relay 重试 --');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-'));
    let calls = 0;
    const flaky = {
      async chat() {
        calls += 1;
        if (calls === 1) return { ok: false, error: 'ECONNRESET', content: '' };
        return { ok: true, content: planJson('main.js', MAIN_OK, VERIFY_OK) };
      },
    };
    const result = await runAgentLoop({
      environment: makeEnv(),
      permissions,
      handlers: buildLoopHandlers(
        { address: 'a:1', assignmentId: '11111111-1111-1111-1111-111111111111', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws, environment: makeEnv() },
        flaky,
      ),
    });
    check('首次 relay 失败 → 重试后 delivered', result.outcome === 'delivered', `outcome=${result.outcome} msg=${result.stopMessage ?? ''}`);
    check('恰好 2 次 LLM 调用', calls === 2);
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
        { address: 'a:1', assignmentId: '11111111-1111-1111-1111-111111111111', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws, environment: makeEnv() },
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
        { address: 'a:1', assignmentId: '11111111-1111-1111-1111-111111111111', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws, environment: makeEnv() },
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
        { address: 'a:1', assignmentId: '11111111-1111-1111-1111-111111111111', client: {} as never, permissions: off, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws, environment: makeEnv() },
        llm,
      ),
    });
    check('off 档 → permission_denied', result.outcome === 'permission_denied' && result.stopReason === 'trial_run_not_permitted');
    check('试跑零发生', result.trialRuns === 0 && !fs.existsSync(path.join(ws, 'out.txt')));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 5. 协议违规：首次非 JSON 重试一次；仍不合法才失败 ──
  console.log('-- 5. 协议违规与修复重试 --');
  {
    // 5a. 连续两次非 JSON → 只重试一次，然后如实失败
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-'));
    const llm = makeLlm([
      '我觉得应该先看看目录再说，具体代码我下一步给你。',
      '还是先看看目录吧，代码下次给你。',
    ]);
    const result = await runAgentLoop({
      environment: makeEnv(),
      permissions,
      handlers: buildLoopHandlers(
        { address: 'a:1', assignmentId: '11111111-1111-1111-1111-111111111111', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws, environment: makeEnv() },
        llm,
      ),
    });
    check('连续两次非 JSON → outcome=error（不猜测语义）', result.outcome === 'error' && (result.stopMessage ?? '').includes('已重试 1 次'));
    check('只重试一次（LLM 调用 2 次）', llm.seen.length === 2);
    check('重试输入带修复指令', llm.seen[1].includes('不是合法 JSON') && llm.seen[1].includes('只返回一个 JSON 对象'));
    fs.rmSync(ws, { recursive: true, force: true });

    // 5b. 首次非 JSON，修复后合法 → 继续 delivered
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-'));
    const llm2 = makeLlm([
      '好的，我先规划一下：not json（这里故意不合法）',
      planJson('main.js', MAIN_OK, VERIFY_OK),
    ]);
    const result2 = await runAgentLoop({
      environment: makeEnv(),
      permissions,
      handlers: buildLoopHandlers(
        { address: 'a:1', assignmentId: '11111111-1111-1111-1111-111111111111', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws2, environment: makeEnv() },
        llm2,
      ),
    });
    check('首次非 JSON → 修复后 delivered', result2.outcome === 'delivered', `outcome=${result2.outcome} msg=${result2.stopMessage ?? ''}`);
    check('修复重试恰好 2 次 LLM 调用', llm2.seen.length === 2);
    fs.rmSync(ws2, { recursive: true, force: true });

    // 5c. 合法 JSON 但缺 entry → 原校验仍失败（重试不掩盖语义错误）
    const ws3 = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-'));
    const llm3 = makeLlm([JSON.stringify({ files: [], notes: 'no entry' })]);
    const result3 = await runAgentLoop({
      environment: makeEnv(),
      permissions,
      handlers: buildLoopHandlers(
        { address: 'a:1', assignmentId: '11111111-1111-1111-1111-111111111111', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node verify.js' }]), workspaceRoot: ws3, environment: makeEnv() },
        llm3,
      ),
    });
    check('缺合法 entry → outcome=error', result3.outcome === 'error' && (result3.stopMessage ?? '').includes('entry'));
    fs.rmSync(ws3, { recursive: true, force: true });
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
        { address: 'a:1', assignmentId: '11111111-1111-1111-1111-111111111111', client: {} as never, permissions, sop: makeSop([]), workspaceRoot: ws, environment: makeEnv() },
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
        { address: 'a:1', assignmentId: '11111111-1111-1111-1111-111111111111', client: {} as never, permissions, sop: makeSop([{ kind: 'command', run: 'node -c "console.log(1)"' }]), workspaceRoot: ws2, environment: makeEnv() },
        llm2,
      ),
    });
    check('-c 形态不被偷换成跑别的文件（escalate 而非 delivered）', result2.outcome === 'escalated');
    fs.rmSync(ws2, { recursive: true, force: true });
  }

  // ── 7. P7c GUI 观察：受控动作结果进入下一轮上下文，截图走媒体通道 ──
  console.log('-- 7. GUI 观察 --');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rt-gui-'));
    const guiPermissions = resolveLocalPermissions({
      preset: 'standard', hostAccess: 'app-scoped', allowedApps: ['notepad.exe'],
    });
    const sop = makeSop([{ kind: 'platform', taskId: 't' }]);
    sop.frontMatter.capabilities = ['filesystem', 'gui'];
    const actions: GuiDriverInput[] = [];
    const driver: GuiDriver = {
      async probe() { return true; },
      async run(input) {
        actions.push(input);
        if (input.screenshotPath) fs.writeFileSync(input.screenshotPath, Buffer.from('89504e470d0a1a0a', 'hex'));
        return { ok: true, detail: 'window checked' };
      },
    };
    const uploads: string[] = [];
    const client = {
      async uploadMedia(_address: string, _assignmentId: string, item: { name: string; buf: Buffer }) {
        uploads.push(item.name);
        return { ok: true, mediaPath: '/api/agent-collab/media/gui-test' };
      },
    };
    const first = JSON.stringify({
      files: [], entry: { interpreter: 'node', path: 'main.js' },
      gui: [{ action: 'focus', app: 'notepad' }, { action: 'screenshot', app: 'notepad' }],
    });
    const overBudget = JSON.stringify({
      files: [], entry: { interpreter: 'node', path: 'main.js' },
      gui: Array.from({ length: 39 }, () => ({ action: 'focus', app: 'notepad' })),
    });
    const llm = makeLlm([first, planJson('main.js', MAIN_OK, VERIFY_OK), overBudget]);
    const handlers = buildLoopHandlers({
      address: 'a:1', assignmentId: '11111111-1111-1111-1111-111111111111',
      client: client as never, permissions: guiPermissions, sop, workspaceRoot: ws,
      environment: makeEnv(), guiAvailable: true, guiDriver: driver,
      mediaBaseUrl: 'https://acf.example.com',
    }, llm);
    const output = await handlers.plan({ iteration: 1, environment: makeEnv(), feedback: null });
    check('GUI 动作白名单执行 + 截图上传', actions.length === 2 && uploads.length === 1 && output.includes('mediaPath='));
    await handlers.plan({ iteration: 2, environment: makeEnv(), feedback: null });
    check('GUI 观察进下一轮 LLM 上下文', llm.seen[1].includes('/api/agent-collab/media/gui-test'));
    const rawSecond = llm.seenRaw[1];
    const imageParts = Array.isArray(rawSecond)
      ? rawSecond.filter((p) => (p as { type?: string }).type === 'image_url')
      : [];
    const inlineUrl = (imageParts[0] as { image_url?: { url?: string } } | undefined)?.image_url?.url;
    check(
      '截图作为 inline image_url 进入下一轮（无需公网媒体 host）',
      typeof inlineUrl === 'string' && inlineUrl.startsWith('data:image/png;base64,'),
      String(inlineUrl).slice(0, 80),
    );
    const beforeBudget = actions.length;
    const limited = await handlers.plan({ iteration: 3, environment: makeEnv(), feedback: null });
    check('GUI 动作上限按整个指派累计', actions.length === beforeBudget && limited.includes('超上限'));

    const denied = resolveLocalPermissions({ preset: 'standard', allowedApps: ['notepad'] });
    const deniedLlm = makeLlm([first]);
    const deniedHandlers = buildLoopHandlers({
      address: 'a:1', assignmentId: '11111111-1111-1111-1111-111111111111',
      client: client as never, permissions: denied, sop, workspaceRoot: ws,
      environment: makeEnv(), guiAvailable: true, guiDriver: driver,
    }, deniedLlm);
    const before = actions.length;
    const refused = await deniedHandlers.plan({ iteration: 1, environment: makeEnv(), feedback: null });
    check('hostAccess=none 即使模型请求也不触发原生 GUI', actions.length === before && refused.includes('不可用'));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== runtime selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
