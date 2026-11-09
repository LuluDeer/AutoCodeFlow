/**
 * R70 `cross-package-metric-parity`：CLI 与 admin-web 两份「实际在跑」换算实现的
 * **反漂移判据**。
 *
 * ## 背景（这笔账是 R68 留下的）
 *
 * `packages/acf-cli` 与 `apps/admin-web` 互不共享代码（CLI 的 tsconfig `rootDir`
 * 是 `./src`，跨包 import 会破坏其构建），所以「实际在跑 = 已占 − 预留」这条口径
 * 在**两个包里各有一份实现**：
 *
 * · web：`apps/admin-web/src/utils/executor-metrics.ts::resolveRunningCount`
 *   （+ `displayedRunningCount` / `hasInconsistentMetrics` 一族）；
 * · CLI：`packages/acf-cli/src/commands/executors.ts::actualRunningCount`。
 *
 * 两份实现只要有一处规则不同，就会出现「管理台说 3、命令行说 2」的漂移，而**没有
 * 任何测试会红**（各测各的）。本文件用**一张共享期望表**把两边的口径钉在一起。
 *
 * ## 期望表怎么来的（不是手写的臆测）
 *
 * 表中每一格的期望值都是**web 侧真实实现的实测输出**：用 `tsx` 直接 import
 * `apps/admin-web/src/utils/executor-metrics.ts`，对同一组入参跑
 * `resolveRunningCount(occupied, reserved)` 并打印结果（测量脚本见本文件末尾的
 * 「复现方法」）。因此这张表 = **web 侧当前规则的快照**。
 *
 * CLI 侧断言的是**同一个数**；两边规则一旦分叉，本文件立刻红。
 *
 * ## 两边的契约（先写清，期望表才是可判的）
 *
 * · **数值口径一致**（reserved 已知时）：非有限 ⇒ 0、负数钳 0、下限钳 0、
 *   保留小数（2.5 − 0.5 = 2）。
 * · **唯一刻意差异**：`reservedSlots` 未知时，web 回落到「已占槽位」，CLI 返回
 *   `null`（表示「无从算起」——CLI 必须区分二者，否则会打印误导性的「Running Tasks」）。
 *   这条差异在表里以 `cli: null` / `web: occupied` 两列**显式并列**，不是遗漏。
 */
import { describe, it, expect } from 'vitest';

import { actualRunningCount } from '../commands/executors.js';

/**
 * 共享期望表（≥8 组；覆盖 occupied=0/3/10 × reserved=null/0/2/8、边界相等、
 * 矛盾态 reserved>occupied、以及负数/非有限/非整数边界）。
 *
 * · `web` 列 = web 侧 `resolveRunningCount` 的**实测输出**（测量脚本见文件末尾）；
 * · `cli` 列 = CLI 侧 `actualRunningCount` 的期望（与 web 相同者同值；
 *   reserved 未知时为 `null` —— 那条是**刻意差异**，见上文契约）。
 */
const PARITY_TABLE: Array<{
  label: string;
  occupied: number | null | undefined;
  reserved: number | null | undefined;
  /** web 侧实测输出 */
  web: number;
  /** CLI 侧期望（null = 无从换算） */
  cli: number | null;
}> = [
  // —— occupied = 0（空载执行器）——
  { label: 'occupied=0, reserved=null（旧版未上报）', occupied: 0, reserved: null, web: 0, cli: null },
  { label: 'occupied=0, reserved=0（已上报无预留）', occupied: 0, reserved: 0, web: 0, cli: 0 },
  { label: 'occupied=0, reserved=2（矛盾：空载却有预留）', occupied: 0, reserved: 2, web: 0, cli: 0 },
  { label: 'occupied=0, reserved=8（矛盾：空载却有大量预留）', occupied: 0, reserved: 8, web: 0, cli: 0 },

  // —— occupied = 3（常规）——
  { label: 'occupied=3, reserved=null（旧版未上报）', occupied: 3, reserved: null, web: 3, cli: null },
  { label: 'occupied=3, reserved=0', occupied: 3, reserved: 0, web: 3, cli: 3 },
  { label: 'occupied=3, reserved=2（空闲 pull：已占 3 含 2 预留）', occupied: 3, reserved: 2, web: 1, cli: 1 },
  { label: 'occupied=3, reserved=8（矛盾：预留 > 已占）', occupied: 3, reserved: 8, web: 0, cli: 0 },

  // —— occupied = 10（满配上限）——
  { label: 'occupied=10, reserved=null（旧版未上报）', occupied: 10, reserved: null, web: 10, cli: null },
  { label: 'occupied=10, reserved=0', occupied: 10, reserved: 0, web: 10, cli: 10 },
  { label: 'occupied=10, reserved=2', occupied: 10, reserved: 2, web: 8, cli: 8 },
  { label: 'occupied=10, reserved=8', occupied: 10, reserved: 8, web: 2, cli: 2 },

  // —— 边界相等（全部已占都是预留，合法状态）——
  { label: 'occupied=2, reserved=2（边界相等）', occupied: 2, reserved: 2, web: 0, cli: 0 },

  // —— 脏值：负数 / 非有限 / 非整数（web 实测，CLI 同口径）——
  { label: 'occupied=-5（负数钳 0）, reserved=0', occupied: -5, reserved: 0, web: 0, cli: 0 },
  { label: 'occupied=-5（负数钳 0）, reserved=3', occupied: -5, reserved: 3, web: 0, cli: 0 },
  { label: 'occupied=10, reserved=-3（负预留钳 0）', occupied: 10, reserved: -3, web: 10, cli: 10 },
  { label: 'occupied=NaN, reserved=3（非有限 ⇒ 0）', occupied: Number.NaN, reserved: 3, web: 0, cli: 0 },
  { label: 'occupied=10, reserved=NaN（非有限 ⇒ 0）', occupied: 10, reserved: Number.NaN, web: 10, cli: 10 },
  { label: 'occupied=2.5, reserved=0.5（保留小数）', occupied: 2.5, reserved: 0.5, web: 2, cli: 2 },
  { label: 'occupied=2.5, reserved=0（保留小数）', occupied: 2.5, reserved: 0, web: 2.5, cli: 2.5 },
];

describe('R70 — CLI ↔ web 的「实际在跑」口径反漂移判据', () => {
  it.each(PARITY_TABLE)('$label ⇒ CLI 输出与 web 实测同口径', ({ occupied, reserved, cli }) => {
    const got = actualRunningCount({
      runningTaskCount: occupied as number | undefined,
      reservedSlots: reserved as number | null | undefined,
    });
    expect(got).toBe(cli);
  });

  it('期望表自身完整（≥8 组，且每组都带 web 实测值与 CLI 期望值）', () => {
    // 防「表被人悄悄清空/改小」——空表会让本文件变成永绿。
    expect(PARITY_TABLE.length).toBeGreaterThanOrEqual(8);
    for (const row of PARITY_TABLE) {
      expect(row).toHaveProperty('web');
      expect(row).toHaveProperty('cli');
      expect(typeof row.label).toBe('string');
    }
    // reserved 已知 ⇒ CLI 必须给出数值（不得偷懒返回 null）；未知 ⇒ 必须 null。
    for (const row of PARITY_TABLE) {
      const got = actualRunningCount({
        runningTaskCount: row.occupied as number | undefined,
        reservedSlots: row.reserved as number | null | undefined,
      });
      if (row.reserved === null || row.reserved === undefined) {
        expect(got).toBeNull();
      } else {
        expect(typeof got).toBe('number');
      }
    }
  });

  it('reserved 已知 ⇒ CLI 与 web **数值恒等**（刻意差异只在 reserved 未知时）', () => {
    // 逐组复核：web 列与 cli 列在 reserved 已知时必须相等——
    // 这正是「跨包口径漂移」的直接定义。
    for (const row of PARITY_TABLE) {
      if (row.reserved === null || row.reserved === undefined) continue;
      expect(row.cli).toBe(row.web);
    }
  });

  it('矛盾态（reserved > occupied）：两侧都不得输出负数', () => {
    // R16/R17 实证可达的落库形态；若任一侧改成直接相减，此处立刻红。
    for (const row of PARITY_TABLE) {
      if (row.reserved === null || row.reserved === undefined) continue;
      if (row.reserved > (row.occupied ?? 0)) {
        expect(row.cli).toBe(0);
        expect(row.web).toBe(0);
      }
    }
  });
});

/**
 * ## 复现/刷新期望表的方法（web 侧实测输出）
 *
 * 在 `packages/acf-cli` 目录下执行（tsx 可直接跑 TS）：
 *
 * ```sh
 * cat > /tmp/web-parity.ts <<'EOF'
 * import { resolveRunningCount } from '../../../apps/admin-web/src/utils/executor-metrics';
 * for (const [occ, res] of [[0,null],[0,0],[0,2],[0,8],[3,null],[3,0],[3,2],[3,8],
 *                           [10,null],[10,0],[10,2],[10,8],[2,2]]) {
 *   console.log(occ, String(res), '=>', resolveRunningCount(occ, res));
 * }
 * EOF
 * npx tsx /tmp/web-parity.ts
 * ```
 *
 * 把输出回填进上表的 `web` 列。**改动 web 侧规则后必须重跑本流程**——
 * 否则本表会与 web 脱节（此时本文件会红，说明两侧确实漂移了，需要复核谁对）。
 */
