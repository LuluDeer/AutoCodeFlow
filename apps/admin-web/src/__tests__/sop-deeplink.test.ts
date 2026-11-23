/**
 * UX-G1 回归：SOP 深链 `assignment=<id>` 先做 UUID 形状校验——非法/残缺值直接忽略
 * （不带着坏 id 去拉详情、也不静默留空高亮）；但页签仍按参数是否存在切到指派 Tab
 * （R289 B 既有契约：非法 id 静默降级停在指派 Tab、不高亮）。
 */
import { describe, it, expect } from 'vitest';
import { resolveSopDeepLink } from '../pages/sops/sop-deeplink';

const VALID_UUID = '7c2e1b90-bbbb-4bcd-9ef0-000000000011';

describe('resolveSopDeepLink UUID 形状校验（UX-G1）', () => {
  it('合法 UUID 保留为高亮 id；非法/残缺/空值置 null', () => {
    expect(resolveSopDeepLink(new URLSearchParams(`sop=sop-1&assignment=${VALID_UUID}`)).assignmentId)
      .toBe(VALID_UUID);
    expect(resolveSopDeepLink(new URLSearchParams('sop=sop-1&assignment=asg-blocked')).assignmentId).toBeNull();
    expect(resolveSopDeepLink(new URLSearchParams('sop=sop-1&assignment=abc')).assignmentId).toBeNull();
    expect(resolveSopDeepLink(new URLSearchParams('sop=sop-1&assignment=7c2e1b90-bbbb-4bcd')).assignmentId).toBeNull();
    expect(resolveSopDeepLink(new URLSearchParams('sop=sop-1')).assignmentId).toBeNull();
  });

  it('非法 assignment 仍切到指派 Tab（静默降级、不高亮）；完全不带参数时回 contract 页签', () => {
    const invalid = resolveSopDeepLink(new URLSearchParams('sop=sop-1&assignment=asg-blocked'));
    expect(invalid.initialTab).toBe('assignments');
    expect(invalid.assignmentId).toBeNull();

    const none = resolveSopDeepLink(new URLSearchParams('sop=sop-1'));
    expect(none.initialTab).toBe('contract');
    expect(none.assignmentId).toBeNull();
  });
});
