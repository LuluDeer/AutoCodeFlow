/**
 * 回归：失败分类的读面展示必须显示**标签**，而不是原始枚举。
 *
 * 缺陷：Dashboard「最近失败」Tag 原先直接渲染后端枚举并按 12 字符截断，于是
 * `interpreter_unavailable`（23 字符）显示成 `interpreter_…` —— 既不是中文
 * 也不是英文，用户与运维都看不出这是什么失败；ExecutionCompare 对比表走
 * 通用格式化器，同样露裸枚举。两处现已统一收敛到
 * utils/failure-reason-label（本用例的被测对象），ExecutionDetailPage 的
 * 富映射（color/hint）仍独立维护。
 *
 * 本用例钉三件事：
 *   1. 每个已知分类都能查到 i18n 键，且键在 zh/en **两套**词条里都存在
 *      （只加键不加词条 = 界面直接露出 key 本身，是更糟的回归）；
 *   2. 键集与 admin 的 ExecutionFailureReason 枚举**逐一对应**（无共享包，
 *      靠本守卫防漏）；
 *   3. 未知值回退原始 token 且仍然截断——绝不显示"未知原因"把可诊断信息抹掉。
 */
import { describe, it, expect } from 'vitest';
import {
  FAILURE_REASON_T_KEYS,
  failureReasonLabel,
} from '../utils/failure-reason-label';
import zh from '../locales/zh';
import en from '../locales/en';

/**
 * admin-api 的 ExecutionFailureReason 枚举（task-execution.entity.ts）。
 * `stale_recovered` 是 admin 内部值（执行器不上报），但执行记录里会出现，
 * 故 Dashboard 也必须能展示它。
 */
const ADMIN_FAILURE_REASONS = [
  'package_fetch_failed',
  'dependency_install_failed',
  'git_fetch_failed',
  'runtime_missing',
  'interpreter_unavailable',
  'script_error',
  'timeout',
  'executor_offline',
  'executor_restart',
  'stale_recovered',
  'killed',
  'unknown',
];

describe('失败分类读面标签（Dashboard / ExecutionCompare 共用）', () => {
  it('枚举里的每一个分类都有标签键（不漏项）', () => {
    for (const reason of ADMIN_FAILURE_REASONS) {
      expect(
        FAILURE_REASON_T_KEYS[reason],
        `分类 ${reason} 缺少展示标签`,
      ).toBeTruthy();
    }
  });

  it('标签键在 zh 与 en 两套词条里都存在（只加键会露出 key 本身）', () => {
    const zhKeys = zh as Record<string, string>;
    const enKeys = en as Record<string, string>;
    for (const [reason, key] of Object.entries(FAILURE_REASON_T_KEYS)) {
      expect(zhKeys[key], `${reason} → ${key} 在 zh 词条缺失`).toBeTruthy();
      expect(enKeys[key], `${reason} → ${key} 在 en 词条缺失`).toBeTruthy();
    }
  });

  it('interpreter_unavailable 显示标签而不是被截断的原始枚举', () => {
    // 关键反证：修回原来的 `slice(0, 12)` 行为，本断言立即失败。
    const label = failureReasonLabel('interpreter_unavailable', (k) => `t:${k}`);
    expect(label).toBe('t:execDetail.failure.interpreterUnavailable');
    expect(label).not.toContain('interpreter_…');
    expect(label).not.toBe('interpreter_…');
  });

  it('未知分类回退原始 token（不显示"未知原因"抹掉可诊断信息）', () => {
    // 用 ≤12 字符的短 token，才能把"回退"与"截断"两件事分开断言。
    const label = failureReasonLabel('new_reason', (k) => `t:${k}`);
    expect(label).toBe('new_reason');
    expect(label).not.toBe('t:execDetail.failure.unknown');
  });

  it('未知且过长的 token 才截断（Tag 很窄）', () => {
    // 12 字符以内原样；超过才截断——与修复前的截断宽度保持一致，
    // 只有**已知分类**改走标签。
    const long = 'some_very_long_unknown_reason_token';
    const label = failureReasonLabel(long, (k) => `t:${k}`);
    expect(label).toBe(`${long.slice(0, 12)}…`);
    expect(label.endsWith('…')).toBe(true);
    expect(label).toBe('some_very_lo…');
  });
});
