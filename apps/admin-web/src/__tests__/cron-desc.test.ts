/**
 * CRON-DESC-01：describeCron 纯函数测试——钉住「覆盖子集内可读、子集外
 * 回退 null」的契约，防止后续把误描述（宁缺勿错原则）偷偷带进来。
 */
import { describe, it, expect } from 'vitest';
import { describeCron } from '../utils/cron-desc';

describe('describeCron（CRON-DESC-01）', () => {
  it('常见模式产出中文描述', () => {
    expect(describeCron('* * * * *')).toBe('每分钟');
    expect(describeCron('*/5 * * * *')).toBe('每 5 分钟');
    expect(describeCron('0 * * * *')).toBe('每小时 :00');
    expect(describeCron('30 2 * * *')).toBe('每天 02:30');
    expect(describeCron('0 12,18 * * *')).toBe('每天 12:00, 18:00');
    expect(describeCron('0 9 * * 1-5'.replace('1-5', '1,2,3,4,5'))).toBe('每周一、二、三、四、五 09:00');
    expect(describeCron('30 2 3 * *')).toBe('每月 3 日 02:30');
    expect(describeCron('0 0 1 1 *')).toBe('每年 1 月 1 日 00:00');
  });

  it('子集外表达式回退 null（不产出误导描述）', () => {
    // 小时区间/步长
    expect(describeCron('0 9-18 * * *')).toBeNull();
    expect(describeCron('0 */2 * * *')).toBeNull();
    // 月份列表 / 6 段（秒级）/ 空值
    expect(describeCron('0 0 1 1,6 *')).toBeNull();
    expect(describeCron('0 0 * * * 1')).toBeNull();
    expect(describeCron('')).toBeNull();
    expect(describeCron(null)).toBeNull();
    // dow 名字集合外的值（7 以上）
    expect(describeCron('0 0 * * 8')).toBeNull();
  });

  it('多分钟每小时场景', () => {
    expect(describeCron('0,30 * * * *')).toBe('每小时 :00, :30');
  });
});
