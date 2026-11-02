/**
 * S8（迁移 1790000000091）：**失败排障卡把合成行误解释成「被 COVER_EARLY 覆盖」**。
 *
 * ## 缺陷形态（为什么这是个害人的错）
 *
 * `status === 'cancelled'` 在系统里有**两个语义完全相反**的来源：
 *  ① `apps/admin-api/src/modules/task/block-strategy-gate.ts:142` —— COVER_EARLY：
 *     同参新触发到达，把**正在跑**的那次取消掉。**真跑过**，处置=「符合预期就不管，
 *     不想被覆盖就改 blockStrategy」。
 *  ② `apps/admin-api/src/modules/task/task.service.ts` 的 G2 合成行（synthetic=true）——
 *     上游任务失败，下游**因上游坏而没跑**，系统补一条 cancelled 行只为让「没跑」
 *     在列表里可见。**从未运行**，处置=「去查上游」。
 *
 * P1-27 的 `failureRunbookAction` 只看 status，于是 ② 会命中 ① 的文案：
 * 运维被引去把任务的阻断策略从 COVER_EARLY 改掉——配置改了，上游照样失败，
 * 排障方向**整条走反**。本文件锁住「两个来源必须给两条文案」。
 *
 * ## 回归锁（硬要求）
 *
 * `synthetic` 是**第 4 个可选参数**：不传 = 旧行为逐字节不变（`runbook.cancelled`）。
 * 既有 shard-c-failure-runbook.test.ts 的 6 条用例必须仍然绿——它们不传第 4 参。
 */
import { describe, expect, it } from 'vitest';
import {
  RUNBOOK_ACTION_T_KEY,
  RUNBOOK_CANCELLED_SYNTHETIC_T_KEY,
  failureRunbookAction,
} from '../pages/failure-runbook';
import en from '../locales/en';
import zh from '../locales/zh';

/** 记录决议到的 i18n 键（文案本体在 locales，测试只锚定「走了哪条」）。 */
const keyT = () => {
  const seen: string[] = [];
  const t = (k: string) => {
    seen.push(k);
    return `[${k}]`;
  };
  return { t, seen };
};

describe('S8 · cancelled 的两个来源必须给两条文案', () => {
  it('cancelled && synthetic ⇒ 命中「上游失败·从未运行」文案（不是 COVER_EARLY 那条）', () => {
    const { t, seen } = keyT();
    const entry = failureRunbookAction(null, t, 'cancelled', true);

    expect(entry.action).toBe(`[${RUNBOOK_CANCELLED_SYNTHETIC_T_KEY}]`);
    expect(entry.action).toBe('[runbook.cancelledSynthetic]');
    expect(seen).toEqual(['runbook.cancelledSynthetic']);
    // 关键：与 COVER_EARLY 那条**不是同一句**
    expect(entry.action).not.toBe(failureRunbookAction(null, t, 'cancelled').action);
    expect(entry.action).not.toBe(failureRunbookAction('cancelled').action);
  });

  it('回归锁：cancelled && !synthetic（以及不传第 4 参）仍走 COVER_EARLY 文案', () => {
    // 真实尝试被 COVER_EARLY 覆盖 —— 本行**真的跑过**，处置仍是「改 blockStrategy」。
    for (const synthetic of [false, undefined, null] as const) {
      const { t, seen } = keyT();
      expect(failureRunbookAction(null, t, 'cancelled', synthetic).action).toBe(
        '[runbook.cancelled]',
      );
      expect(seen).toEqual(['runbook.cancelled']);
    }
    // 与 P1-27 既有断言同口径：不传 synthetic 时结果逐字节等于只按 status 命中。
    expect(failureRunbookAction(null, undefined, 'cancelled').action).toBe(
      failureRunbookAction('cancelled').action,
    );
  });

  it('非 cancelled 状态不受第 4 参影响（synthetic 只分流 cancelled）', () => {
    // 合成行目前只会是 cancelled；但既然参数是通用的，就得钉住它**不会**污染
    // failed/timeout/killed 的既有命中（failureReason 仍是唯一判据）。
    expect(failureRunbookAction('killed', undefined, 'killed', true).action).toBe(
      failureRunbookAction('killed').action,
    );
    expect(failureRunbookAction('script_error', undefined, 'failed', true).action).toBe(
      failureRunbookAction('script_error').action,
    );
  });

  it('RUNBOOK_ACTION_T_KEY 键集不被污染（与 mcp FAILURE_RUNBOOK 的 16 键一一对应）', () => {
    // synthetic 是**行属性**而非失败分类：塞进这张按 failureReason 索引的表会让
    // mcp 侧出现一个无对应项，也让「16 键全等」的锚定用例失去意义。
    expect(Object.keys(RUNBOOK_ACTION_T_KEY)).not.toContain('cancelledSynthetic');
    expect(Object.keys(RUNBOOK_ACTION_T_KEY)).not.toContain('synthetic');
    expect(RUNBOOK_CANCELLED_SYNTHETIC_T_KEY).toBe('runbook.cancelledSynthetic');
  });
});

describe('S8 · 词条本身必须让运维一眼看出该去查哪（zh/en 成对）', () => {
  const zhText = (zh as Record<string, string>)[RUNBOOK_CANCELLED_SYNTHETIC_T_KEY];
  const enText = (en as Record<string, string>)[RUNBOOK_CANCELLED_SYNTHETIC_T_KEY];

  it('zh/en 词条都存在且非空', () => {
    expect(typeof zhText).toBe('string');
    expect(zhText.length).toBeGreaterThan(40);
    expect(typeof enText).toBe('string');
    expect(enText.length).toBeGreaterThan(40);
  });

  it('zh 文案指向上游任务，并显式否掉「改阻断策略」这个误导方向', () => {
    expect(zhText).toContain('上游');
    expect(zhText).toContain('从未真正运行');
    // 显式否掉 COVER_EARLY 解释 —— 否则运维仍会去改 blockStrategy
    expect(zhText).toContain('COVER_EARLY');
    expect(zhText).toContain('阻断策略');
    // 与 COVER_EARLY 那条必须是**不同**的文本（旧实现两句合一）
    expect(zhText).not.toBe((zh as Record<string, string>)['runbook.cancelled']);
  });

  it('en 文案指向上游任务，并显式否掉 cover-early', () => {
    expect(enText).toContain('upstream');
    expect(enText.toLowerCase()).toContain('never actually ran');
    expect(enText.toLowerCase()).toContain('not a cover-early');
    expect(enText).toContain('block strategy');
    expect(enText).not.toBe((en as Record<string, string>)['runbook.cancelled']);
  });
});
