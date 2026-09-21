/**
 * P0（UX-AUDIT-2026-09-21 §P0-5）：切换「代码来源」必须告知会被清空的字段。
 *
 * `applyCodeSourcePayload` 出于正确理由把不适用字段置为**显式 null**（PATCH 是
 * Object.assign 语义，不发 null 会保留旧值 → 任务静默带两个冲突来源）。但配套
 * 的输入框是条件渲染的：用户一改单选，gitRepo/gitBranch 的框立刻从 DOM 消失、
 * 值也已置 null。两条叠加 = 误点一下「Glue 脚本」，用户看不见被清的内容、
 * 也收不到提示，切回来只能凭记忆重填。
 *
 * 本文件钉住"损失预告"这份纯函数——它是确认弹窗的唯一判据，也是唯一可能
 * 与提交路径漂移的地方（因此实现复用 applyCodeSourcePayload，而非另写规则）。
 */
import { describe, expect, it } from 'vitest';
import {
  applyCodeSourcePayload,
  codeSourceSwitchLosses,
} from '../pages/executor-mode';

describe('P0-5: codeSourceSwitchLosses（切换来源的损失预告）', () => {
  it('git → glue：报出将被清空的 gitRepo / gitBranch', () => {
    const losses = codeSourceSwitchLosses(
      {
        gitRepo: 'git@github.com:acme/refund.git',
        gitBranch: 'release/2.x',
        glueSource: '',
      },
      'glue',
      'git',
    );
    const fields = losses.map((l) => l.field);
    expect(fields).toContain('gitRepo');
    expect(fields).toContain('gitBranch');
    // 值要原样带出来，用户才能判断"这就是我要的那份配置"
    expect(losses.find((l) => l.field === 'gitRepo')?.value).toBe(
      'git@github.com:acme/refund.git',
    );
  });

  it('git → application_zip：同样报出 gitRepo / gitBranch', () => {
    const losses = codeSourceSwitchLosses(
      { gitRepo: 'https://git.acme/foo.git', gitBranch: 'main' },
      'application_zip',
      'git',
    );
    expect(losses.map((l) => l.field).sort()).toEqual(['gitBranch', 'gitRepo']);
  });

  it('glue → git：报出将被清空的 Glue 脚本（值只给长度，不塞整段代码进弹窗）', () => {
    const script = 'import os\nprint("hi")\n';
    const losses = codeSourceSwitchLosses(
      { glueSource: script, gitRepo: '', gitBranch: '' },
      'git',
      'glue',
    );
    expect(losses).toHaveLength(1);
    expect(losses[0].field).toBe('glueSource');
    // ENG 审计 E-P2-F4：脚本长度改为结构化 scriptLength（调用方走 i18n 渲染），
    // value 仅为数字字符串——纯函数不再持有任何用户可见文案。
    expect(typeof losses[0].scriptLength).toBe("number");
    expect(losses[0].scriptLength).toBeGreaterThan(10);
    expect(losses[0].value).toBe(String(losses[0].scriptLength));
    expect(losses[0].value).not.toContain('print'); // 不把代码正文塞进提示
  });

  it('全空时切换不打扰（新建任务来回点不该弹确认）', () => {
    expect(
      codeSourceSwitchLosses({ gitRepo: '', gitBranch: '' }, 'glue', 'git'),
    ).toEqual([]);
    expect(
      codeSourceSwitchLosses({ gitRepo: undefined }, 'application_zip', 'git'),
    ).toEqual([]);
  });

  it('同一来源的"切换"不报损失（未变则无副作用）', () => {
    expect(
      codeSourceSwitchLosses({ gitRepo: 'git@x/y.git' }, 'git', 'git'),
    ).toEqual([]);
  });

  it('判定与提交路径同源：预告清空的字段，applyCodeSourcePayload 确实清空', () => {
    // 这条是防"预告与实际漂移"的核心——弹窗承诺不清的字段就不能被清。
    const values = {
      gitRepo: 'git@github.com:acme/refund.git',
      gitBranch: 'release/2.x',
      glueSource: '',
    };
    const losses = codeSourceSwitchLosses(values, 'glue', 'git');
    const after = applyCodeSourcePayload({ ...values }, 'glue', 'git');
    for (const l of losses) {
      expect(after[l.field]).toBeNull();
    }
    // 反向：未被预告的字段不得被静默清掉
    for (const field of ['gitRepo', 'gitBranch', 'glueSource'] as const) {
      const announced = losses.some((l) => l.field === field);
      const cleared = after[field] === null;
      expect(announced).toBe(cleared);
    }
  });
});
