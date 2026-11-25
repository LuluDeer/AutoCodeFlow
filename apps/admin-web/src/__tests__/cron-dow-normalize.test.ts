/**
 * Quartz 周日别名 7 的归一回归（纯函数级）。
 *
 * cron-desc.ts 与 maintenance-desc.ts 共用既有 cron.desc.dow.0–.6 词条：
 * 7 必须归一到 dow.0，否则 i18next 解析不到 key，界面直接显示裸 key。
 * 维护窗口对无法安全人文化的 dow 超集（范围/列表）必须 human=null，
 * 让调用方回退原始 Cron（该文件 :37 契约）。
 */
import { describe, it, expect } from 'vitest';
import { describeCron } from '../utils/cron-desc';
import { describeMaintenanceWindow } from '../utils/maintenance-desc';

describe('cron dow=7 归一（Quartz 周日别名）', () => {
  it('describeCron: 0 0 * * 7 → 每周日 00:00，输出无裸 key', () => {
    const text = describeCron('0 0 * * 7');
    expect(text).toBe('每周日 00:00');
    expect(text ?? '').not.toContain('cron.desc.dow');
    expect(describeCron('0 0 * * 8')).toBeNull();
  });

  it('describeMaintenanceWindow: dow=7 窗口人文化含「日」且无裸 key', () => {
    const d = describeMaintenanceWindow('0 9 * * 7', '0 10 * * 7');
    expect(d.human).toBe('周日 09:00–10:00');
    expect(d.human ?? '').toContain('日');
    expect(d.human ?? '').not.toContain('cron.desc.dow');
    expect(d.crossMidnight).toBe(false);
    expect(d.raw).toBe('0 9 * * 7 → 0 10 * * 7');
  });

  it('describeMaintenanceWindow: dow 范围 1-5 → human=null，回退原始 Cron', () => {
    const d = describeMaintenanceWindow('0 9 * * 1-5', '0 10 * * 1-5');
    expect(d.human).toBeNull();
    expect(d.raw).toBe('0 9 * * 1-5 → 0 10 * * 1-5');
  });

  it('describeMaintenanceWindow: dow 列表 1,3 → human=null，回退原始 Cron', () => {
    const d = describeMaintenanceWindow('0 9 * * 1,3', '0 10 * * 1,3');
    expect(d.human).toBeNull();
    expect(d.raw).toBe('0 9 * * 1,3 → 0 10 * * 1,3');
  });

  it('describeMaintenanceWindow: 每日分支的 dow=* 不受严格校验影响', () => {
    const d = describeMaintenanceWindow('30 2 * * *', '0 4 * * *');
    expect(d.human).toBe('每日 02:30–04:00');
  });
});
