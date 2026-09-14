/**
 * A4（DEEP_REVIEW §七 A4 · 契约单一事实源收口）：告警渠道选项的单一事实源。
 *
 * `AlarmConfig` 的渠道选项此前是一份独立的手写清单，与 admin-api 的
 * `AlertChannel` 枚举、六个 channel 实现类的 `name` 三处并存、零编译期耦合。
 * 落本文件时实测已经漂了：`feishu` 在后端枚举与实现类里都在、通知设置页也能
 * 配，唯独任务表单的告警渠道选择器里没有——**后端能发的渠道前端选不中**。
 *
 * 现在三处统一由 `packages/contract-fixtures/contract.json` 的 `channelList`
 * 机检：admin-api 侧见 `apps/admin-api/src/modules/notification/__tests__/
 * channel-list-contract.spec.ts`，前端侧即本文件。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import i18n from '../i18n';
import { ALARM_CHANNEL_OPTIONS } from '../components/AlarmConfig';

/** 按标记文件向上找仓库根——不硬编码 `../`×N（层数随文件位置漂移）。 */
function loadContractFixture(): { channelList: { channels: string[] } } {
  for (let dir = resolve(__dirname); ; dir = join(dir, '..')) {
    const candidate = join(dir, 'packages', 'contract-fixtures', 'contract.json');
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8'));
    if (dir === resolve(dir, '..')) throw new Error('contract-fixtures/contract.json not found');
  }
}

describe('AlarmConfig 渠道选项（A4 channelList 契约）', () => {
  const expected: string[] = loadContractFixture().channelList.channels;

  it('选项值集合 == 契约 channelList', () => {
    const values = ALARM_CHANNEL_OPTIONS((k) => k).map((o) => o.value);
    expect([...values].sort()).toEqual([...expected].sort());
  });

  it('每个选项都有真实文案（i18n 键不缺、非空）', () => {
    // i18next 在键缺失时**回退返回键名本身**，故「label === key」即等于没翻译。
    for (const opt of ALARM_CHANNEL_OPTIONS((k) => k)) {
      const label = i18n.t(`alarmConfig.channel.option.${opt.value}`);
      expect({ value: opt.value, label }).not.toEqual({
        value: opt.value,
        label: `alarmConfig.channel.option.${opt.value}`,
      });
      expect(typeof label).toBe('string');
      expect((label as string).length).toBeGreaterThan(0);
    }
  });

  it('选项无重复值（判据自守）', () => {
    const values = ALARM_CHANNEL_OPTIONS((k) => k).map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });
});
