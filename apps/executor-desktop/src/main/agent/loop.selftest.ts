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
    // P2-1：diagnose 的 deliver 不再是交付（见 4b）——这里改用 escalate 收敛
    const { handlers, calls } = makeHandlers({ diagnose: (i) => (i >= 3 ? 'escalate' : 'retry') });
    const r = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers,
    });
    assert.strictEqual(r.outcome, 'escalated');
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

  // ── 4b. ★ P2-1 验收旁路：验收失败后 LLM 自评 deliver → 降级 escalate ────
  {
    const { handlers } = makeHandlers({
      trialOutcomes: [{ ok: false, output: 'still failing' }],
      verifyPass: false,
      diagnose: () => 'deliver',
    });
    const r = await runAgentLoop({ environment: ENV, permissions: perms('standard'), handlers });
    assert.strictEqual(r.outcome, 'escalated', '验收未通过时 LLM 自评 deliver 绝不能产出 delivered');
    assert.notStrictEqual(r.outcome, 'delivered');
    assert.ok(
      (r.stopMessage ?? '').includes('deliver'),
      `降级原因必须如实上报（含 deliver 字样）：${r.stopMessage ?? ''}`,
    );
    assert.ok(r.candidate, '候选要带回来供人工复核（降级转人工的处置对象）');
  }

  // ── 4c. ★ P2-1 对照：verify 通过的 deliver 直返 delivered（语义保留）────
  {
    const { handlers, calls } = makeHandlers({
      trialOutcomes: [{ ok: true, output: 'ok' }, { ok: true, output: 'ok2' }],
      verifyPass: true,
      diagnose: () => 'deliver',
    });
    const r = await runAgentLoop({ environment: ENV, permissions: perms('standard'), handlers });
    assert.strictEqual(r.outcome, 'delivered', 'verify 通过在第 ④ 步直接交付，不经诊断');
    assert.strictEqual(calls.diagnose, 0, 'verify 通过时 diagnose 不应被调用');
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

  // ── 11b. 缺陷 A：plan 抛错（链路不可用）不吃迭代预算 ────────────────────
  {
    // 现场：relay 恒 503 → chatJson 退避重试耗尽 → plan 抛错。
    // 旧行为把这一轮记成「工作轮」（iterations+1），宿主保留 journal 续跑，
    // 几十次 tick 后以「迭代轮次已达上限」收场——把 provider 抖动说成能力
    // 结论。新语义：plan 抛错 = 模型什么都没产出 = 这一轮不记账。
    const T = 1_700_000_000_000;
    const seen: number[] = [];
    let planCalls = 0;
    const handlers: LoopHandlers = {
      plan: async () => {
        planCalls++;
        throw new Error('LLM relay 不可用（已重试 2 次）：llm relay failed (status=503)');
      },
      trialRun: async () => ({ ok: false, output: '' }),
      diagnose: async () => 'retry',
      verify: async () => false,
    };
    const r = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers,
      counters: { ...createCounters(T), iterations: 4, trialRuns: 2 },
      limits: { maxIterations: 15 },
      now: () => T,
      onCounters: (c) => seen.push(c.iterations),
    });
    assert.strictEqual(r.outcome, 'error');
    assert.strictEqual(planCalls, 1);
    assert.strictEqual(r.iterations, 4, 'plan 抛错的这一轮必须回退（否则 503 次数能吃满 15 轮预算）');
    assert.deepStrictEqual(seen, [5, 4], '流出两次：记账后 5、回退后 4（宿主据此抹掉落盘的幻影 +1）');
    assert.strictEqual(r.counters.startedAt, T, 'startedAt 保留：墙钟是真实时间闸，不随工作预算回退');
    assert.strictEqual(r.gateSummary.iterations.used, 4, '闸门摘要同样按回退后的计数展示');
  }

  // ── 11c. 缺陷 A 的反面：plan **返回**后抛错照旧计入预算 ─────────────────
  {
    // 判据必须收窄到这里才不会误伤：模型确实产出了候选，就是一轮真实工作——
    // 哪怕随后试跑/诊断抛错，预算也该照付（否则「跑一轮再崩一次」就成了
    // 新的预算规避通道）。
    const T = 1_700_000_000_000;
    const handlers: LoopHandlers = {
      plan: async () => 'candidate-code',
      trialRun: async () => {
        throw new Error('LLM relay 不可用（已重试 2 次）：llm relay failed (status=503)');
      },
      diagnose: async () => 'retry',
      verify: async () => false,
    };
    const r = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers,
      counters: { ...createCounters(T), iterations: 4, trialRuns: 2 },
      limits: { maxIterations: 15 },
      now: () => T,
    });
    assert.strictEqual(r.outcome, 'error');
    assert.strictEqual(r.iterations, 5, '模型已产出候选 → 这一轮不许回退');
    assert.strictEqual(r.trialRuns, 3, '试跑记账同样保留');
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

  // ── 12c. 计数流出（onCounters）：每次记账后可见最新值，供调用方落盘 ──────
  {
    // onCounters 是崩溃落盘的钩子：host 靠它把计数写进 journal，running
    // 中途被 kill 后重启才能恢复。这里钉住流出的时机与内容——没有流出，
    // host 侧落盘的就是旧值，恢复语义形同虚设。
    const T = 1_700_000_000_000;
    const { handlers } = makeHandlers({ diagnose: () => 'retry' });
    const seen: Array<{ iterations: number; trialRuns: number; startedAt: number }> = [];
    const r = await runAgentLoop({
      environment: ENV,
      permissions: perms('standard'),
      handlers,
      counters: { ...createCounters(T), iterations: 2, trialRuns: 1 },
      limits: { maxIterations: 5 },
      now: () => T,
      onCounters: (c) => seen.push({ iterations: c.iterations, trialRuns: c.trialRuns, startedAt: c.startedAt }),
    });
    assert.strictEqual(r.outcome, 'gate_stopped', '从 2 起跑到 5 触顶（对照场景）');
    assert.strictEqual(seen.length, 6, '每次 iterate + trial_run 记账都必须流出（3 轮 × 2 次）');
    assert.deepStrictEqual(
      seen.map((s) => s.iterations),
      [3, 3, 4, 4, 5, 5],
      'iterate 与 trial_run 交替流出，且沿用带入的起点继续累计',
    );
    assert.deepStrictEqual(
      seen.map((s) => s.trialRuns),
      [1, 2, 2, 3, 3, 4],
      'trial_run 记账紧随本轮 iterate 流出（latest 值可见）',
    );
    assert.ok(seen.every((s) => s.startedAt === T), 'startedAt 保持首次迭代时刻（不被恢复改写）');
    assert.strictEqual(seen[seen.length - 1].iterations, r.iterations, '最后一次流出 = 结果里的终值');
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
