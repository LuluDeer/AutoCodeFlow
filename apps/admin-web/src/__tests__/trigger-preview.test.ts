/**
 * UI-06: trigger-preview 纯函数层测试。
 * 覆盖：cron 解析子集（步进/范围/逗号/DOM·DOW OR/非法拒绝）、
 * 未来 N 次推算、fixed_rate 链、timezone 校验与渲染文本、非法占位。
 */
import { describe, it, expect } from 'vitest';
import {
  parseCronExpression,
  nextCronFireTimes,
  nextFixedRateFireTimes,
  formatFireTime,
  validateTimezone,
} from '../utils/trigger-preview';

describe('parseCronExpression（DTO 子集解析）', () => {
  it('星号/数字/步进/范围/逗号组合均接受', () => {
    expect(parseCronExpression('* * * * *')).not.toBeNull();
    expect(parseCronExpression('0 8 * * 1-5')).not.toBeNull();
    expect(parseCronExpression('*/5 * * * *')).not.toBeNull();
    expect(parseCronExpression('0 9-18/2 * * *')).not.toBeNull();
    expect(parseCronExpression('0,15,30,45 * * * *')).not.toBeNull();
    expect(parseCronExpression('0 0 1 * *')).not.toBeNull();
  });

  it('结构非法（字段数/越界/超出 DTO 语法）拒绝', () => {
    expect(parseCronExpression('')).toBeNull();
    expect(parseCronExpression('60 * * * *')).toBeNull(); // 分钟越界
    expect(parseCronExpression('0 24 * * *')).toBeNull(); // 小时越界
    expect(parseCronExpression('0 8 * *')).toBeNull(); // 4 字段
    expect(parseCronExpression('0 8 * * * *')).toBeNull(); // 6 字段
    expect(parseCronExpression('@daily')).toBeNull();
    expect(parseCronExpression('0 8 * * 8')).toBeNull(); // 周越界
    expect(parseCronExpression('abc * * * *')).toBeNull();
  });

  it('语义非法（逗号展开越界，结构正则不拦）拒绝', () => {
    expect(parseCronExpression('5,70 * * * *')).toBeNull();
    expect(parseCronExpression('0 3,25 * * *')).toBeNull();
  });

  it('7 视同周日 0（POSIX/node-cron 口径）', () => {
    const p = parseCronExpression('0 8 * * 7');
    expect(p).not.toBeNull();
    expect(p!.dayOfWeek.has(0)).toBe(true);
  });
});

describe('nextCronFireTimes（未来 N 次推算）', () => {
  // 用固定锚点保证确定性：本地时区 2026-09-08（周二）10:30:00
  const NOW = new Date(2026, 8, 8, 10, 30, 0, 0);

  it('每天早 8 点：未来 5 次均为 08:00 且逐日递增（含次日补齐）', () => {
    const times = nextCronFireTimes('0 8 * * *', 5, NOW);
    expect(times).toHaveLength(5);
    // 本地时区渲染：第一次=今天 08:00 已过 → 从明天开始
    for (let i = 0; i < 5; i++) {
      expect(times[i].getHours()).toBe(8);
      expect(times[i].getMinutes()).toBe(0);
    }
    expect(times[0].getDate()).toBe(9);
    expect(times[1].getDate()).toBe(10);
    expect(times[4].getDate()).toBe(13);
  });

  it('每 5 分钟步进：连续 5 次间隔 5 分钟（含当前分钟命中）', () => {
    const times = nextCronFireTimes('*/5 * * * *', 5, NOW);
    expect(times).toHaveLength(5);
    expect(times[0].getMinutes()).toBe(30); // 含当前分钟
    for (let i = 1; i < 5; i++) {
      expect(times[i].getTime() - times[i - 1].getTime()).toBe(5 * 60_000);
    }
  });

  it('范围 1-5（工作日）：跳过周末', () => {
    // 2026-09-08 周二；0 9 * * 1-5 → 09-08 当天 9 点已过 → 09/09(三)、09/10(四)、09/11(五)、09/14(一)
    const times = nextCronFireTimes('0 9 * * 1-5', 5, NOW);
    expect(times).toHaveLength(5);
    const dates = times.map((t) => `${t.getMonth() + 1}-${t.getDate()}`);
    expect(dates).toEqual(['9-9', '9-10', '9-11', '9-14', '9-15']);
    for (const t of times) expect(t.getDay()).toBeGreaterThanOrEqual(1);
    for (const t of times) expect(t.getDay()).toBeLessThanOrEqual(5);
  });

  it('DOM/DOW 并存按 POSIX OR（同 admin-api cronMatchesAt 语义）', () => {
    // 0 0 1 * 1：每月 1 号 OR 每周一。9 月 1 号已过 → 最近=周一 09-14（09-08 当天已过 0 点）
    const times = nextCronFireTimes('0 0 1 * 1', 3, NOW);
    expect(times).toHaveLength(3);
    const days = times.map((t) => t.getDate());
    expect(days[0]).toBe(14); // 周一
    expect(days[1]).toBe(21); // 周一
    // 第三个：09-28 周一（10-1 是周四）
    expect(days[2]).toBe(28);
  });

  it('非法表达式返回 []（UI 渲染占位）', () => {
    expect(nextCronFireTimes('abc', 5, NOW)).toEqual([]);
    expect(nextCronFireTimes('60 * * * *', 5, NOW)).toEqual([]);
  });

  it('极稀疏表达式凑不满 count 时返回已找到的部分', () => {
    // 每年 12 月 25 日 0 点——一年内只 1 次
    const times = nextCronFireTimes('0 0 25 12 *', 5, NOW);
    expect(times.length).toBeGreaterThanOrEqual(1);
    expect(times.length).toBeLessThan(5);
    expect(times[0].getMonth()).toBe(11);
    expect(times[0].getDate()).toBe(25);
  });

  it('timezone 感知：Asia/Shanghai 时区下每日 8 点触发对应真实 UTC 0 点', () => {
    const times = nextCronFireTimes('0 8 * * *', 2, NOW, 'Asia/Shanghai');
    expect(times).toHaveLength(2);
    // Asia/Shanghai = UTC+8（9 月无夏令时）：08:00 墙钟 = 00:00 UTC
    for (const t of times) {
      expect(t.getUTCHours()).toBe(0);
      expect(t.getUTCMinutes()).toBe(0);
    }
  });

  it('timezone 感知：UTC 时区下 0 点触发就是 UTC 0 点', () => {
    const times = nextCronFireTimes('0 0 * * *', 2, NOW, 'UTC');
    expect(times).toHaveLength(2);
    for (const t of times) expect(t.getUTCHours()).toBe(0);
  });

  it('非法 timezone 回退本地时区（不抛错、时刻可算）', () => {
    const good = nextCronFireTimes('0 8 * * *', 2, NOW);
    const bad = nextCronFireTimes('0 8 * * *', 2, NOW, 'Not/AZone');
    expect(bad).toHaveLength(2);
    expect(bad.map((t) => t.getTime())).toEqual(good.map((t) => t.getTime()));
  });
});

describe('nextFixedRateFireTimes（fixed_rate 链）', () => {
  const NOW = new Date(2026, 8, 8, 10, 30, 0, 0);

  it('每 600 秒：now+600*i 链', () => {
    const times = nextFixedRateFireTimes(600, 3, NOW);
    expect(times).toHaveLength(3);
    expect(times[0].getTime() - NOW.getTime()).toBe(600_000);
    expect(times[1].getTime() - NOW.getTime()).toBe(1_200_000);
    expect(times[2].getTime() - NOW.getTime()).toBe(1_800_000);
  });

  it('非法 interval（0/负数/NaN）返回 []', () => {
    expect(nextFixedRateFireTimes(0, 3, NOW)).toEqual([]);
    expect(nextFixedRateFireTimes(-5, 3, NOW)).toEqual([]);
    expect(nextFixedRateFireTimes(NaN, 3, NOW)).toEqual([]);
  });
});

describe('validateTimezone / formatFireTime（展示层）', () => {
  it('合法 IANA tz 通过、空值回 null、非法回 null', () => {
    expect(validateTimezone('Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(validateTimezone('UTC')).toBe('UTC');
    expect(validateTimezone('')).toBeNull();
    expect(validateTimezone(undefined)).toBeNull();
    expect(validateTimezone('Not/AZone')).toBeNull();
  });

  it('formatFireTime 按 timezone 渲染（Asia/Shanghai 固定文本含月日时分）', () => {
    // 2026-09-08T00:30:00Z = 上海 08:30
    const d = new Date('2026-09-08T00:30:00.000Z');
    const text = formatFireTime(d, 'Asia/Shanghai');
    expect(text).toContain('09/08');
    expect(text).toContain('08:30');
  });

  it('formatFireTime 非法 tz 回退本地时区不抛错', () => {
    const d = new Date('2026-09-08T00:30:00.000Z');
    expect(formatFireTime(d, 'Not/AZone')).toBeTruthy();
  });
});
