/**
 * P7a（agent-and-deployment）selftest：执行器 Agent 迭代循环（07 §7）。
 *
 * 用**注入的假 handler** 驱动真实循环（不 mock 循环本身）：断言的是控制流
 * ——何时停、何时间中台、何时算交付、档位如何生效。
 *
 * ## 钉死的判断
 * 1. **档位先于一切试跑**：`codeExecution=off` 时一次 trialRun 都不能发生。
 *    这是 ADR-022 的核心——off 档是「高合规企业唯一会选的档」，若循环绕过
 *    `allowsTrialRun` 直接跑，该档就只是一句注释。
 * 2. **澄清触顶转人工，且不烧令牌**：转人工分支**不**调用 plan/trialRun
 *    （两个 Agent 的礼貌循环是真实风险，P6 中台侧已设硬闸，执行器侧同样要停）。
 * 3. **触顶是合法终态**：返回完整结果带 `stopReason`，不抛异常——中台要能
 *    区分「做不了」与「崩了」，才能决定换机器还是转人工。
 * 4. **handler 抛错收敛为 outcome='error'**，不冒泡出去炸掉会话。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import {
  runAgentLoop,
  type AgentLoopResult,
  type LoopHandlers,
  type TrialOutcome,
} from './loop';
import { DEFAULT_GATE_LIMITS, createCounters } from './gates';
import { resolveLocalPermissions, type EffectiveAgentPermissions } from './permission-profile';
import type { EnvironmentReport } from './perception';

const ENV: EnvironmentReport = {
  probedAt: new Date(1_700_000_000_000).toISOString(),
  platform: 'win32',
  platformRelease: '10.0.0',
  arch: 'x64',
  hostname: 'pc',
  cpuCount: 8,
  totalMemoryMB: 16384,
  freeMemoryMB: 8192,
  runtimes: [{ name: 'node', available: true, version: 'v24.0.0' }],
  capabilities: ['filesystem', 'http'],
};

/** 记录调用的假 handler（用于验证"某动作到底有没有发生"）。 */
function makeHandlers(opts: {
  planResult?: string;
  trialOutcomes?: TrialOutcome[];
  diagnose?: (i: number) => Parameters<LoopHandlers['diagnose']>[0] extends never ? never : 'retry' | 'needs_clarification' | 'escalate' | 'deliver';
  verifyPass?: boolean;
} = {}) {
  const calls = { plan: 0, trialRun: 0, verify: 0, diagnose: 0 };
  const handlers: LoopHandlers = {
    plan: async () => {
      calls.plan++;
      return opts.planResult ?? 'candidate-code';
    },
    trialRun: async ({ iteration }) => {
      calls.trialRun++;
      return opts.trialOutcomes?.[iteration - 1] ?? { ok: false, output: 'failed' };
    },
    diagnose: async ({ iteration }) => {
      calls.diagnose++;
      return opts.diagnose?.(iteration) ?? 'retry';
    },
    verify: async () => {
      calls.verify++;
      return opts.verifyPass ?? false;
    },
  };
  return { handlers, calls };
}

function perms(preset: 'minimal' | 'standard'): EffectiveAgentPermissions {
  return resolveLocalPermissions({ preset });
}

async function main(): Promise<void> {
  // ── 1. ★ 档位 off：一次试跑都不能发生 ────────────────────────────────
  {
    const { handlers, calls } = makeHandlers();
    const r = await runAgentLoop({
      environment: ENV,
      permissions: perms('minimal'), // codeExecution=off
      handlers,
    });
    assert.strictEqual(r.outcome, 'permission_denied', 'off 档必须产出 permission_denied，而不是照跑');
    assert.strictEqual(r.stopReason, 'trial_run_not_permitted');
    assert.strictEqual(calls.trialRun, 0, '★ off 档下 trialRun 一次都不能被调用');
    assert.strictEqual(calls.plan, 1, '规划仍可发生（off 档允许"只产出代码给人看"，09 §2.1）');
    assert.ok(r.stopMessage?.includes('off'), '停止消息必须说明是哪个轴挡住的');
    assert.ok(r.candidate, '已产出的候选代码要带回来（供人工审阅，这正是 off 档的用途）');
  }

  // ── 2. standard 档：可以试跑，失败后按 diagnose 重试 ───────────────────
  {
    const { handlers, calls } = makeHandlers({ diagnose: (i) => (i >= 3 ? 'deliver' : 'retry') });
    const r = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers,
    });
    assert.strictEqual(r.outcome, 'delivered');
    assert.strictEqual(calls.trialRun, 3, '三次迭代 = 三次试跑（闸门按次记账）');
    assert.strictEqual(r.iterations, 3);
    assert.strictEqual(r.trialRuns, 3);
  }

  // ── 3. 试跑通过 + 验收通过 → delivered ────────────────────────────────
  {
    const { handlers } = makeHandlers({
      trialOutcomes: [{ ok: true, output: 'ok' }],
      verifyPass: true,
    });
    const r = await runAgentLoop({ environment: ENV, permissions: perms('standard'), handlers });
    assert.strictEqual(r.outcome, 'delivered');
    assert.strictEqual(r.iterations, 1, '第一轮即达成，不得多跑');
    assert.strictEqual(r.candidate, 'candidate-code');
  }

  // ── 4. ★ 试跑成功但验收不过 → 不算交付（"跑通了"≠"做对了"）─────────────
  {
    const { handlers } = makeHandlers({
      trialOutcomes: [{ ok: true, output: 'ran fine' }],
      verifyPass: false,
      diagnose: () => 'escalate',
    });
    const r = await runAgentLoop({ environment: ENV, permissions: perms('standard'), handlers });
    assert.notStrictEqual(r.outcome, 'delivered', '试跑成功但验收失败不得判为交付');
    assert.strictEqual(r.outcome, 'escalated');
  }

  // ── 5. ★ 迭代触顶 → gate_stopped（合法终态，不抛）─────────────────────
  {
    const { handlers, calls } = makeHandlers({ diagnose: () => 'retry' });
    const r: AgentLoopResult = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers,
      limits: { maxIterations: 3, maxTrialRuns: 100 },
    });
    assert.strictEqual(r.outcome, 'gate_stopped', '触顶是合法终态，不是异常');
    assert.strictEqual(r.stopReason, 'iteration_limit');
    assert.strictEqual(calls.trialRun, 3, '恰好跑满上限，不多跑一轮');
    assert.strictEqual(r.iterations, 3);
    assert.ok(r.stopMessage && r.stopMessage.length > 0, '触顶必须带可上报的原因文本');
    assert.ok(r.gateSummary, '触顶结果必须带闸门摘要（中台据此判断换机器是否有意义）');
  }

  // ── 6. ★ 试跑次数触顶（比迭代上限更早到达时以它为准）───────────────────
  {
    const { handlers, calls } = makeHandlers({ diagnose: () => 'retry' });
    const r = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers,
      limits: { maxIterations: 100, maxTrialRuns: 2 },
    });
    assert.strictEqual(r.stopReason, 'trial_run_limit');
    assert.strictEqual(calls.trialRun, 2);
  }

  // ── 7. ★ 澄清：触顶即转人工，且**不再**试跑（不烧令牌）─────────────────
  {
    const { handlers, calls } = makeHandlers({ diagnose: () => 'needs_clarification' });
    const r = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers,
      limits: { maxIterations: 100, maxClarificationRounds: 0 },
    });
    assert.strictEqual(r.outcome, 'escalated', '澄清上限 0 时遇疑必须直接转人工');
    assert.strictEqual(r.stopReason, 'clarification_limit');
    assert.ok(r.stopMessage?.includes('转人工'), '停止消息必须写明已转人工');
    // 第一次迭代的试跑已经发生，之后不得再跑（转人工分支不进下一次 plan）
    assert.strictEqual(calls.plan, 1, '转人工后不得继续规划（不再烧令牌）');
  }

  // ── 8. 澄清有额度 → clarification_requested + 带问题 ───────────────────
  {
    const { handlers } = makeHandlers({ diagnose: () => 'needs_clarification' });
    const r = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers,
      limits: { maxClarificationRounds: 3 },
    });
    assert.strictEqual(r.outcome, 'clarification_requested');
    assert.strictEqual(r.clarifications, 1, '澄清必须记账（下一轮才知道还剩几轮）');
    assert.ok(r.pendingQuestion && r.pendingQuestion.length > 0, '必须带上要问中台的问题');
  }

  // ── 9. escalate 与 needs_clarification 是不同的终态（处置方式不同）──────
  {
    const a = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers: makeHandlers({ diagnose: () => 'escalate' }).handlers,
    });
    assert.strictEqual(a.outcome, 'escalated');
    assert.ok(!a.pendingQuestion, '转人工不带待问问题（人不在协作 API 上）');
  }

  // ── 10. handler 抛错 → outcome='error'，不冒泡 ────────────────────────
  {
    const handlers: LoopHandlers = {
      plan: async () => {
        throw new Error('LLM 不可用');
      },
      trialRun: async () => ({ ok: false, output: '' }),
      diagnose: async () => 'retry',
      verify: async () => false,
    };
    let threw = false;
    let r: AgentLoopResult | null = null;
    try {
      r = await runAgentLoop({ environment: ENV, permissions: perms('standard'), handlers });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'handler 抛错不得冒泡出循环（会炸掉整个会话）');
    assert.strictEqual(r!.outcome, 'error');
    assert.match(String(r!.stopMessage), /LLM 不可用/, '错误原因必须带回来（否则无法排查）');
  }

  // ── 11. plan 返回空 → error（空候选继续循环没有意义）────────────────────
  {
    const { handlers } = makeHandlers({ planResult: '   ' });
    const r = await runAgentLoop({ environment: ENV, permissions: perms('standard'), handlers });
    assert.strictEqual(r.outcome, 'error');
    assert.match(String(r.stopMessage), /空候选/);
  }

  // ── 12. 计数可从外部带入（resume 语义）────────────────────────────────
  {
    // 时钟必须**钉死**在 startedAt 附近：若用真实 Date.now()，带入的
    // 2023 年 startedAt 会让墙钟瞬间触顶，测到的就不是迭代闸门了。
    const T = 1_700_000_000_000;
    const { handlers, calls } = makeHandlers({ diagnose: () => 'retry' });
    const counters = { ...createCounters(T), iterations: 13 };
    const r = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers,
      counters,
      limits: { maxIterations: 15 },
      now: () => T,
    });
    assert.strictEqual(r.stopReason, 'iteration_limit');
    assert.strictEqual(calls.trialRun, 2, '从 13 起跑到 15，只应再跑 2 轮（resume 不重置计数）');
    assert.strictEqual(r.iterations, 15);
  }

  // ── 12b. resume 后墙钟仍以首次迭代为准（不得因恢复而续命）───────────────
  {
    const T = 1_700_000_000_000;
    const { handlers } = makeHandlers({ diagnose: () => 'retry' });
    // 会话"昨天"开始，今天恢复：墙钟已耗尽 → 必须立刻停，而不是重新开始计时
    const r = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers,
      counters: { ...createCounters(T), iterations: 2 },
      limits: { maxIterations: 100, maxWallClockMs: 60_000 },
      now: () => T + 120_000,
    });
    assert.strictEqual(r.stopReason, 'wall_clock', 'resume 不得重置墙钟（否则 2h 上限可反复续命）');
    assert.strictEqual(r.iterations, 2, '触顶时不得再推进迭代');
  }

  // ── 13. 墙钟触顶在循环中生效（会话级，不只是记账级）─────────────────────
  {
    let now = 1_700_000_000_000;
    const { handlers } = makeHandlers({ diagnose: () => 'retry' });
    const r = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers,
      limits: { maxIterations: 100, maxWallClockMs: 1000 },
      now: () => {
        now += 400; // 每次读取推进 400ms → 第 3 次判定即触顶
        return now;
      },
    });
    assert.strictEqual(r.stopReason, 'wall_clock', '墙钟必须在循环里真实生效');
  }

  // ── 14. 默认上限来自 07 §7.1（不传 limits 时不得是无闸）────────────────
  {
    const { handlers } = makeHandlers({ diagnose: () => 'retry' });
    const r = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers,
      limits: { maxIterations: DEFAULT_GATE_LIMITS.maxIterations },
    });
    assert.strictEqual(r.iterations, DEFAULT_GATE_LIMITS.maxIterations, '默认上限必须是 15 轮');
  }

  console.log('agent/loop selftest: all assertions passed (permission gate, hard stops, clarification, resume)');
}

void main();
