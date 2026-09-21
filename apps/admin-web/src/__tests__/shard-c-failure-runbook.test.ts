/**
 * P1-27（UX-AUDIT-2026-09-21，Shard C：执行器与执行诊断域）：
 * 「被覆盖取消」与「被策略 kill」在 UI 上无任何解释。
 *
 * ## 旧实现怎么错（红）
 *  - `FAILURE_CARD_STATUSES` 只有 `['failed','timeout']`——`killed` 的动作文案
 *    早已写在 `FAILURE_RUNBOOK_ACTIONS.killed`，却因卡片不渲染而成为死代码；
 *  - `cancelled` 在 runbook 表里**根本没有条目**；而 cancelled 来自调度器
 *    COVER_EARLY 自动覆盖（scheduler.service.ts:1065-1071），后端**不落
 *    failureReason**（只写 errorMessage="Task was covered by new trigger"），
 *    于是 `failureRunbookAction(null)` 永远落到 unknown 兜底——用户既不知道是
 *    调度器自动覆盖、也不知道与人工终止的区别。
 *
 * ## 修法（绿）
 *  - `killed`/`cancelled` 纳入 `FAILURE_CARD_STATUSES`（卡片对两类终态渲染）；
 *  - 补 `cancelled` runbook 条目，文案区分「调度器自动覆盖」与「人工终止」；
 *  - `failureRunbookAction` 增加第三参 `status`：`status==='cancelled'` 时按
 *    status 命中（因为 failureReason 恒空），人工 killed 仍按 failureReason 命中。
 */
import { describe, expect, it } from 'vitest';
import {
  FAILURE_CARD_STATUSES,
  FAILURE_RUNBOOK_ACTIONS,
  failureRunbookAction,
} from '../pages/failure-runbook';

describe('P1-27: killed/cancelled 不再无解释', () => {
  it('FAILURE_CARD_STATUSES 纳入 killed 与 cancelled（旧实现只含 failed/timeout）', () => {
    // 旧：['failed','timeout'] → 下列断言红。这是死代码复活与新条目可见性的本体。
    expect(FAILURE_CARD_STATUSES).toContain('failed');
    expect(FAILURE_CARD_STATUSES).toContain('timeout');
    expect(FAILURE_CARD_STATUSES).toContain('killed');
    expect(FAILURE_CARD_STATUSES).toContain('cancelled');
  });

  it('killed 既有动作文案非空（此前是死代码，现已可达）', () => {
    expect(FAILURE_RUNBOOK_ACTIONS.killed.action.length).toBeGreaterThan(0);
    expect(failureRunbookAction('killed').action).toBe(FAILURE_RUNBOOK_ACTIONS.killed.action);
  });

  it('cancelled 有 runbook 条目（旧实现表里没有这个键）', () => {
    expect(FAILURE_RUNBOOK_ACTIONS.cancelled.action.length).toBeGreaterThan(0);
  });

  it('cancelled 必须按 status 命中——failureReason 恒空，只传 failureReason 会落到 unknown', () => {
    // 后端 COVER_EARLY 只写 status=CANCELLED，不写 failureReason。
    // 不传 status：退化为 unknown（旧行为，证明 cancelled 此前不可达）。
    expect(failureRunbookAction(null).action).toBe(FAILURE_RUNBOOK_ACTIONS.unknown.action);
    // 传 status='cancelled'：命中 cancelled 专属条目。
    expect(failureRunbookAction(null, undefined, 'cancelled').action).toBe(
      FAILURE_RUNBOOK_ACTIONS.cancelled.action,
    );
    // 顺带：人工终止走 failureReason='killed'，与 cancelled 互不串味。
    expect(failureRunbookAction('killed', undefined, 'killed').action).toBe(
      FAILURE_RUNBOOK_ACTIONS.killed.action,
    );
  });

  it('cancelled 的 i18n 键为 runbook.cancelled（经 t 解析）', () => {
    const seen: string[] = [];
    const fakeT = (k: string) => {
      seen.push(k);
      return `[${k}]`;
    };
    const entry = failureRunbookAction(null, fakeT, 'cancelled');
    expect(entry.action).toBe('[runbook.cancelled]');
    expect(seen).toContain('runbook.cancelled');
  });
});
