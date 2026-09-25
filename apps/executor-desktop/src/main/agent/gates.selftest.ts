/**
 * P7a（agent-and-deployment）selftest：执行器 Agent 硬闸门（07 §7.1 / ADR-022 决策 7）。
 *
 * 闸门是 ADR-022「**受控**的任意代码执行」里那个「受控」的全部内容——
 * 其余设计（档位、workspace、边界）都是外围，闸门才是直接拦住"跑飞"的那道。
 * 所以它必须是最先有回归闸的模块。
 *
 * ## 钉死的两条纪律
 * 1. **闸门在动作之前判**（末尾判 = 副作用已发生，闸门形同虚设）。测试
 *    专门钉「恰好跑到上限就停，不多跑一轮」——即第 N 次被允许、第 N+1 次被拒。
 * 2. **墙钟自首次迭代起算，不随 resume 重置**（否则 2h 上限可反复续命）。
 *
 * ## 反证形态
 * 每组断言都能被一个具体退化实现击穿，不是覆盖率装点：
 *   · 若 checkGate 改成 `>` 而非 `>=`，会多跑一轮（off-by-one，最典型）；
 *   · 若墙钟在 startedAt=0 时判，未开始的会话会被 0 时间戳瞬间判死；
 *   · 若 normalizeLimits 对非法值回落到 0/NaN，闸门会**永久拒绝一切**
 *     （fail-closed 到不可用，与"无闸"同样错）。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import {
  DEFAULT_GATE_LIMITS,
  checkGate,
  createCounters,
  normalizeLimits,
  recordAction,
  summarizeGates,
  type GateCounters,
  type GateLimits,
} from './gates';

const T0 = 1_700_000_000_000;

function snap(counters: GateCounters, limits: GateLimits = DEFAULT_GATE_LIMITS) {
  return { counters, limits };
}

/** 反复执行某动作直到闸门拒绝，返回成功次数与被拒原因。 */
function runUntilBlocked(
  kind: 'iterate' | 'clarify' | 'trial_run' | 'dependency_install',
  limits: GateLimits = DEFAULT_GATE_LIMITS,
): { okCount: number; reason: string | null } {
  let counters = createCounters(T0);
  let okCount = 0;
  for (let i = 0; i < 10_000; i++) {
    const d = checkGate(snap(counters, limits), kind, T0);
    if (!d.allowed) return { okCount, reason: d.reason };
    counters = recordAction(counters, kind, T0);
    okCount++;
  }
  return { okCount, reason: null };
}

function main(): void {
  // ── 1. 上限默认值必须与 07 §7.1 一致 ──────────────────────────────────
  assert.strictEqual(DEFAULT_GATE_LIMITS.maxIterations, 15, '单次迭代最大轮数 15');
  assert.strictEqual(DEFAULT_GATE_LIMITS.maxWallClockMs, 2 * 60 * 60 * 1000, '墙钟 2 小时');
  assert.strictEqual(DEFAULT_GATE_LIMITS.maxClarificationRounds, 5, '澄清轮次 5');
  assert.strictEqual(DEFAULT_GATE_LIMITS.maxTrialRuns, 30, '试跑次数 30');
  assert.strictEqual(DEFAULT_GATE_LIMITS.maxDependencyInstalls, 10, '依赖安装 10');

  // ── 2. ★ 恰好跑到上限就停，不多跑一轮（off-by-one 专项）────────────────
  {
    const cases: [Parameters<typeof runUntilBlocked>[0], number][] = [
      ['iterate', DEFAULT_GATE_LIMITS.maxIterations],
      ['clarify', DEFAULT_GATE_LIMITS.maxClarificationRounds],
      ['trial_run', DEFAULT_GATE_LIMITS.maxTrialRuns],
      ['dependency_install', DEFAULT_GATE_LIMITS.maxDependencyInstalls],
    ];
    for (const [kind, limit] of cases) {
      const r = runUntilBlocked(kind);
      assert.strictEqual(
        r.okCount,
        limit,
        `${kind}：恰好允许 ${limit} 次，第 ${limit + 1} 次必须被拒（实测允许 ${r.okCount} 次）`,
      );
      assert.ok(r.reason !== null, `${kind}：触顶必须给出 reason（如实上报，而非抛异常）`);
    }
  }

  // ── 3. 各类动作互不串味（计数按类别隔离）──────────────────────────────
  {
    let c = createCounters(T0);
    c = recordAction(c, 'trial_run', T0);
    c = recordAction(c, 'trial_run', T0);
    assert.strictEqual(c.trialRuns, 2);
    assert.strictEqual(c.iterations, 0, '试跑不得推进迭代计数（否则迭代上限被间接消耗）');
    assert.strictEqual(c.clarifications, 0);
    // 迭代闸门不受试跑计数影响
    assert.strictEqual(checkGate(snap(c), 'iterate', T0).allowed, true);
    // 澄清会计数、但不影响试跑闸门
    c = recordAction(c, 'clarify', T0);
    assert.strictEqual(checkGate(snap(c), 'trial_run', T0).allowed, true);
  }

  // ── 4. ★ 墙钟：自首次迭代起算，不随后续记账重置 ────────────────────────
  {
    let c = createCounters(0); // startedAt=0 = 尚未开始
    // 未开始的会话不得被墙钟判死（startedAt=0 会算出巨大 elapsed）
    assert.strictEqual(
      checkGate(snap(c), 'iterate', T0).allowed,
      true,
      'startedAt=0（未开始）时不得用 0 时间戳把会话瞬间判死',
    );
    // 首次 iterate 记账才置位 startedAt
    c = recordAction(c, 'iterate', T0);
    assert.strictEqual(c.startedAt, T0, 'startedAt 必须由首次 iterate 置位');
    // 上限前一刻仍允许
    assert.strictEqual(
      checkGate(snap(c), 'iterate', T0 + DEFAULT_GATE_LIMITS.maxWallClockMs - 1).allowed,
      true,
      '墙钟上限前一毫秒仍应允许',
    );
    // 到点即拒（>= 而非 >）
    const atLimit = checkGate(snap(c), 'iterate', T0 + DEFAULT_GATE_LIMITS.maxWallClockMs);
    assert.strictEqual(atLimit.allowed, false, '墙钟到达上限必须拒绝');
    assert.strictEqual(atLimit.reason === 'wall_clock' ? atLimit.reason : '', 'wall_clock');
    // 墙钟对所有动作类别都生效（不只是 iterate）
    for (const kind of ['clarify', 'trial_run', 'dependency_install'] as const) {
      assert.strictEqual(
        checkGate(snap(c), kind, T0 + DEFAULT_GATE_LIMITS.maxWallClockMs).allowed,
        false,
        `墙钟触顶时 ${kind} 也必须被拒（墙钟是会话级的，不是动作级的）`,
      );
    }
    // ★ 再次记账**不得**重置 startedAt（否则 2h 上限可反复续命）
    const after = recordAction(c, 'iterate', T0 + 60_000);
    assert.strictEqual(after.startedAt, T0, '后续迭代不得重置 startedAt（否则墙钟上限形同虚设）');
    // resume 形态：从持久化的计数恢复，startedAt 原样带回
    const resumed: GateCounters = { ...after };
    assert.strictEqual(
      checkGate(snap(resumed), 'iterate', T0 + DEFAULT_GATE_LIMITS.maxWallClockMs).allowed,
      false,
      'resume 后墙钟仍以首次迭代为准',
    );
  }

  // ── 5. 上限归一化：非法值回落默认值（fail-safe 到**有闸**）──────────────
  {
    for (const bad of [null, undefined, {}, { maxIterations: NaN }, { maxIterations: -1 }, { maxIterations: '15' }]) {
      const l = normalizeLimits(bad as never);
      assert.strictEqual(l.maxIterations, 15, `非法上限 ${JSON.stringify(bad)} 必须回落默认，不是回落到 0（永久拒一切）`);
    }
    // 合法自定义值必须生效
    const custom = normalizeLimits({ maxIterations: 3, maxTrialRuns: 2, maxDependencyInstalls: 0 });
    assert.strictEqual(custom.maxIterations, 3);
    assert.strictEqual(custom.maxTrialRuns, 2);
    assert.strictEqual(custom.maxDependencyInstalls, 0, '0 是合法值（禁止依赖安装）');
    // 自定义上限真的生效
    assert.strictEqual(runUntilBlocked('trial_run', custom).okCount, 2);
    assert.strictEqual(runUntilBlocked('dependency_install', custom).okCount, 0, '上限 0 = 该动作完全禁止');
    // 小数取整、其他轴回落默认
    const mixed = normalizeLimits({ maxIterations: 4.9 });
    assert.strictEqual(mixed.maxIterations, 4, '小数向下取整（保守方向）');
    assert.strictEqual(mixed.maxWallClockMs, DEFAULT_GATE_LIMITS.maxWallClockMs);
  }

  // ── 6. 记账不就地改写入参（计数要落盘，中间态与已落盘态必须可区分）──────
  {
    const before = createCounters(T0);
    const snapshotCopy = { ...before };
    const after = recordAction(before, 'trial_run', T0);
    assert.deepStrictEqual(before, snapshotCopy, 'recordAction 不得就地改写入参');
    assert.strictEqual(after.trialRuns, 1);
    assert.notStrictEqual(after, before, '必须返回新对象');
  }

  // ── 7. 计数可序列化（随会话持久化 + resume）──────────────────────────
  {
    const c = recordAction(recordAction(createCounters(T0), 'iterate', T0), 'trial_run', T0);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(c)), c, 'GateCounters 必须可 JSON 序列化');
  }

  // ── 8. 摘要：used/limit 与剩余量供中台决策 ────────────────────────────
  {
    let c = createCounters(T0);
    c = recordAction(c, 'iterate', T0);
    c = recordAction(c, 'trial_run', T0);
    const s = summarizeGates(snap(c), T0 + 5000);
    assert.deepStrictEqual(s.iterations, { used: 1, limit: 15 });
    assert.deepStrictEqual(s.trialRuns, { used: 1, limit: 30 });
    assert.strictEqual(s.elapsedMs, 5000);
    assert.strictEqual(s.wallClockLimitMs, DEFAULT_GATE_LIMITS.maxWallClockMs);
    // 未开始时 elapsed 为 0，不得为负
    const zero = summarizeGates(snap(createCounters(0)), T0);
    assert.strictEqual(zero.elapsedMs, 0, '未开始时 elapsedMs 必须为 0（不得为负）');
  }

  // ── 9. 触顶 reason 可区分（中台据此决定换机器 / 转人工 / 修订 SOP）─────
  {
    const reasons = new Set<string>();
    for (const kind of ['iterate', 'clarify', 'trial_run', 'dependency_install'] as const) {
      const r = runUntilBlocked(kind);
      reasons.add(String(r.reason));
    }
    assert.strictEqual(reasons.size, 4, '四类触顶必须给出四个不同 reason（处置方式不同，不可合并）');
  }

  console.log('agent/gates selftest: all assertions passed (off-by-one, wall-clock, fail-safe limits)');
}

main();
