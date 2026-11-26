/**
 * N26 CLI 分发纯判定 selftest（零 Electron、零进程启动）。
 * 控制组：单旗标 / 无旗标 / 未知旗标透传 / 入参不改写。
 * 反证：冲突旗标被猜成某模式、default 分支误带旗标，判据都必须转红。
 */

import * as assert from 'node:assert';
import { parseCliDispatch } from './cli-dispatch';

type Parse = typeof parseCliDispatch;
type Result = ReturnType<Parse>;
type Mode = 'web' | 'tui' | 'agent' | 'default';

const FLAGS: readonly Mode[] = ['web', 'tui', 'agent'];
const DISPATCH_FLAGS = ['--web', '--tui', '--agent'] as const;

let assertions = 0;

function check(condition: boolean, message: string): void {
  assertions += 1;
  assert.ok(condition, message);
}

function checkDeep(actual: unknown, expected: unknown, message: string): void {
  assertions += 1;
  assert.deepStrictEqual(actual, expected, message);
}

/** 同一把尺子同时量真实现与反证变体：冲突必须 fail-closed。 */
function assertConflictFailClosed(parse: Parse): void {
  const conflicts: string[][] = [
    ['--web', '--tui'],
    ['--web', '--agent'],
    ['--tui', '--agent'],
    ['--web', '--tui', '--agent'],
    ['--web', '--web'],
    ['run', '--tui', 'x', '--agent'],
  ];
  for (const argv of conflicts) {
    checkDeep(parse([...argv]), null, `冲突旗标必须 null：${argv.join(' ')}`);
  }
}

/** 显式旗标必须被消费，不能连同 mode=default 一起漏给下游。 */
function assertExplicitFlagsConsumed(parse: Parse): void {
  for (const flag of DISPATCH_FLAGS) {
    const expectedMode: Mode = flag.slice(2) as Mode;
    const argv = [flag, '--unknown', 'value', 'tail'];
    const result = parse([...argv]);
    check(result !== null, `${flag} 必须返回结果`);
    if (result === null) continue;
    checkDeep(result.mode, expectedMode, `${flag} 必须分发到 ${expectedMode}`);
    checkDeep(result.args, ['--unknown', 'value', 'tail'], `${flag} 必须从 args 中消费`);
    for (const leaked of DISPATCH_FLAGS) {
      check(!result.args.includes(leaked), `${flag} 分支 args 不得携带 ${leaked}`);
    }
  }
}

/** default 分支不得凭空带出分发旗标。 */
function assertDefaultClean(parse: Parse): void {
  const baselines: string[][] = [[], ['--unknown', 'value'], ['x', '--debug', 'y']];
  for (const argv of baselines) {
    const result = parse([...argv]);
    check(result !== null, '无分发旗标必须返回 default 结果');
    if (result === null) continue;
    checkDeep(result.mode, 'default', `mode 必须为 default：${argv.join(' ')}`);
    checkDeep(result.args, argv, 'default args 必须原样透传');
    for (const leaked of DISPATCH_FLAGS) {
      check(!result.args.includes(leaked), `default args 不得携带 ${leaked}`);
    }
  }
}

/** 反证变体：冲突旗标取第一个命中猜成某模式。 */
function badConflictGuess(argv: string[]): Result {
  for (const flag of DISPATCH_FLAGS) {
    if (argv.includes(flag)) {
      return { mode: flag.slice(2) as Mode, args: argv.filter((token) => token !== flag) };
    }
  }
  return { mode: 'default', args: [...argv] };
}

/** 反证变体：显式旗标不消费，一律按 default 原样漏给下游。 */
function badDefaultLeak(argv: string[]): Result {
  return { mode: 'default', args: [...argv] };
}

/** 反证变体：default 分支凭空塞入分发旗标。 */
function badDefaultFabricate(argv: string[]): Result {
  return { mode: 'default', args: ['--web', ...argv] };
}

function expectRed(label: string, detector: () => void): void {
  let red = false;
  try {
    detector();
  } catch {
    red = true;
  }
  check(red, `${label}：反证变体必须转红（否则判据没牙）`);
}

interface StartupOutcome {
  startup: 'desktop-shell';
  log: string | null;
}

type StartupResolver = (parsed: Result) => StartupOutcome;

/**
 * 启动层降级语义（index.ts 接线的行为模型）：仓库没有独立 TUI/Agent CLI 入口，
 * 因此任何已解析 mode 都落到既有桌面壳，只以日志区分；冲突 null 同样走默认启动，
 * default 零日志、零新行为。决策本身不抛错，也不凭空构造 launcher。
 */
function fallbackStartup(parsed: Result): StartupOutcome {
  if (parsed === null) {
    return { startup: 'desktop-shell', log: 'CLI 分发参数冲突：按默认桌面壳模式启动' };
  }
  switch (parsed.mode) {
    case 'web':
      return { startup: 'desktop-shell', log: 'CLI 分发模式：web，沿用现有桌面壳窗口' };
    case 'tui':
      return { startup: 'desktop-shell', log: 'CLI 分发模式：tui，降级为默认桌面壳启动' };
    case 'agent':
      return { startup: 'desktop-shell', log: 'CLI 分发模式：agent，降级为默认桌面壳启动' };
    case 'default':
      return { startup: 'desktop-shell', log: null };
  }
}

/** 接线判据：三种 mode + 冲突 + default 都不得跳出既有桌面壳，日志如实标注。 */
function assertLifecycleFallback(resolve: StartupResolver): void {
  const cases: Array<{ argv: string[]; keywords: string[] }> = [
    { argv: [], keywords: [] },
    { argv: ['--web'], keywords: ['web'] },
    { argv: ['--tui'], keywords: ['tui', '降级'] },
    { argv: ['--agent'], keywords: ['agent', '降级'] },
    { argv: ['--web', '--tui'], keywords: ['冲突'] },
  ];
  for (const item of cases) {
    const outcome = resolve(parseCliDispatch([...item.argv]));
    check(outcome.startup === 'desktop-shell', `必须落到既有桌面壳：${item.argv.join(' ')}`);
    if (item.keywords.length === 0) {
      check(outcome.log === null, 'default 模式零日志、零新行为');
      continue;
    }
    check(outcome.log !== null, `非 default 必须留下模式日志：${item.argv.join(' ')}`);
    if (outcome.log === null) continue;
    for (const keyword of item.keywords) {
      check(outcome.log.includes(keyword), `日志须含「${keyword}」：${item.argv.join(' ')}`);
    }
  }
}

function main(): void {
  console.log('\n=== cli-dispatch selftest ===\n');

  // ── 控制组：显式旗标命中，未知旗标保留，输入不被改写 ──
  checkDeep(parseCliDispatch(['--web']), { mode: 'web', args: [] }, '单一 --web');
  checkDeep(parseCliDispatch(['--tui']), { mode: 'tui', args: [] }, '单一 --tui');
  checkDeep(parseCliDispatch(['--agent']), { mode: 'agent', args: [] }, '单一 --agent');
  checkDeep(
    parseCliDispatch(['pre', '--agent', '--verbose', '--token', 't']),
    { mode: 'agent', args: ['pre', '--verbose', '--token', 't'] },
    '未知旗标透传且保持顺序',
  );
  const argv = ['--tui', '--unknown'];
  const snapshot = [...argv];
  checkDeep(parseCliDispatch(argv), { mode: 'tui', args: ['--unknown'] }, '消费分发旗标');
  checkDeep(argv, snapshot, '入参数组不得被改写');

  // ── 判据量真实现 ──
  assertConflictFailClosed(parseCliDispatch);
  assertExplicitFlagsConsumed(parseCliDispatch);
  assertDefaultClean(parseCliDispatch);

  // ── 反证：坏实现必须被同一判据判红 ──
  expectRed('冲突旗标被猜成某模式', () => assertConflictFailClosed(badConflictGuess));
  expectRed('default 分支误带旗标（显式旗标漏传）', () => assertExplicitFlagsConsumed(badDefaultLeak));
  expectRed('default 分支凭空造旗标', () => assertDefaultClean(badDefaultFabricate));

  // ── 接线层：解析结果驱动降级决策，任何分支都不崩、不新建第二套 UI ──
  assertLifecycleFallback(fallbackStartup);
  expectRed('无 launcher 时误直接启动 TUI', () =>
    assertLifecycleFallback((parsed) => {
      if (parsed?.mode === 'tui') throw new Error('虚构的 TUI launcher 不存在却被直接调用');
      return fallbackStartup(parsed);
    }),
  );

  check(FLAGS.length === 3, '分发模式集合封闭');
  console.log(
    `cli-dispatch.selftest: all assertions passed (${assertions} assertions, 4 counterfactuals)`,
  );
}

main();
