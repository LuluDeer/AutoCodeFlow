/**
 * PLAN-FRONTEND-UX-IMPROVEMENTS §2.3：表单完成度的**口径**测试。
 *
 * 这里只测纯函数——百分比是否诚实由这些断言负责，UI 是否把数字渲染出来
 * 由 `src/__tests__/task-form-completion-indicator.test.tsx` 负责。两件事
 * 分开测，避免「渲染出来了但数字是错的」这种测试假绿。
 */
import { describe, it, expect } from 'vitest';
import {
  computeFormCompletion,
  isFieldFilled,
  TASK_FORM_COMPLETION,
  type CompletionSectionSpec,
} from '../formCompletion';

describe('isFieldFilled：什么算「填了」', () => {
  it('null / undefined / 空串 / 纯空白 都算未填', () => {
    expect(isFieldFilled(null)).toBe(false);
    expect(isFieldFilled(undefined)).toBe(false);
    expect(isFieldFilled('')).toBe(false);
    expect(isFieldFilled('   ')).toBe(false);
    expect(isFieldFilled('\n\t ')).toBe(false);
  });

  it('0 与 false 是真实取值，算已填（timeout=0 不限时 / maxRetry=0 不重试）', () => {
    expect(isFieldFilled(0)).toBe(true);
    expect(isFieldFilled(false)).toBe(true);
    expect(isFieldFilled(NaN)).toBe(true);
  });

  it('空数组 / 空对象算未填（多选框一个没选、依赖映射一条没加）', () => {
    expect(isFieldFilled([])).toBe(false);
    expect(isFieldFilled({})).toBe(false);
    expect(isFieldFilled(['a'])).toBe(true);
    expect(isFieldFilled({ 'a-name': 'id-1' })).toBe(true);
  });

  it('普通字符串/数字算已填', () => {
    expect(isFieldFilled('daily-report')).toBe(true);
    expect(isFieldFilled(300)).toBe(true);
  });
});

describe('computeFormCompletion：边界', () => {
  it('空表单 = 0%，且每个分区都未完成', () => {
    const result = computeFormCompletion({});
    // 默认 triggerType=manual、codeSource 未声明、executorMode 非 pinned：
    // 分母只有 basic 的 3 项（cron/fixedRate/applicationId 都是条件性字段，
    // 当前配置下不适用）。
    expect(result.percent).toBe(0);
    expect(result.sections).toHaveLength(TASK_FORM_COMPLETION.length);
    expect(result.sections[0].id).toBe('sec-basic');
    expect(result.sections[0].requiredMissing).toEqual([
      'taskForm.field.name',
      'taskForm.field.runtime',
      'taskForm.field.entrypoint',
    ]);
    // 只有 basic 有实际适用的必填项；其余分区在当前配置下分母为 0
    // （cron/fixedRate/executorId 都是条件字段，参数/Glue 本就无必填）。
    const withRequired = result.sections.filter((s) => s.requiredTotal > 0);
    expect(withRequired.map((s) => s.id)).toEqual(['sec-basic']);
    expect(withRequired[0].filled).toBe(false);
    // 分母为 0 的分区没有缺口可言，filled 恒 true
    for (const section of result.sections.filter((s) => s.requiredTotal === 0)) {
      expect(section.filled).toBe(true);
      expect(section.requiredMissing).toEqual([]);
    }
  });

  it('null / undefined 表单值等同空表单，不抛错', () => {
    expect(computeFormCompletion(null).percent).toBe(0);
    expect(computeFormCompletion(undefined).percent).toBe(0);
  });

  it('必填全部填上 = 100%', () => {
    const result = computeFormCompletion({
      name: 'daily-report',
      runtime: 'python',
      entrypoint: 'tasks/main.py',
      triggerType: 'manual',
    });
    expect(result.percent).toBe(100);
    expect(result.sections[0].filled).toBe(true);
    expect(result.sections[0].requiredMissing).toEqual([]);
  });

  it('推荐项未填不影响 percent 与 filled，只进 recommendedMissing', () => {
    const result = computeFormCompletion({
      name: 'daily-report',
      runtime: 'python',
      entrypoint: 'tasks/main.py',
      triggerType: 'manual',
    });
    expect(result.percent).toBe(100);
    // description / runbook 都是推荐项，空表单+空推荐都应有提示
    expect(result.sections[0].recommendedMissing).toContain('taskForm.field.description.optional');
    expect(result.sections[1].recommendedMissing).toContain('taskForm.runbook.label');
    expect(result.sections[0].filled).toBe(true);
  });
});

describe('computeFormCompletion：条件性字段不进分母', () => {
  const filledBasic = {
    name: 'daily-report',
    runtime: 'python',
    entrypoint: 'tasks/main.py',
  };

  it('手动触发时 cron/fixedRate 不计入分母（分母=3，填满即 100%）', () => {
    const manual = computeFormCompletion({ ...filledBasic, triggerType: 'manual' });
    expect(manual.percent).toBe(100);
    expect(manual.sections[1].requiredTotal).toBe(0);
    expect(manual.sections[1].filled).toBe(true);
  });

  it('切到 cron 后 cronExpression 进分母：百分比如实下降而不是虚高', () => {
    const cron = computeFormCompletion({ ...filledBasic, triggerType: 'cron' });
    // 3/4 = 75%
    expect(cron.percent).toBe(75);
    expect(cron.sections[1].requiredTotal).toBe(1);
    expect(cron.sections[1].requiredMissing).toEqual(['taskForm.field.cron']);
  });

  it('cron 表达式填上后回到 100%', () => {
    const cron = computeFormCompletion({
      ...filledBasic,
      triggerType: 'cron',
      cronExpression: '0 8 * * 1-5',
    });
    expect(cron.percent).toBe(100);
  });

  it('fixed_rate 分支只看 fixedRate，不看 cronExpression', () => {
    const fixed = computeFormCompletion({
      ...filledBasic,
      triggerType: 'fixed_rate',
      cronExpression: '0 8 * * *', // 不该被算作 fixed_rate 的答案
    });
    expect(fixed.sections[1].requiredMissing).toEqual(['taskForm.field.fixedRate']);
    const fixedFilled = computeFormCompletion({
      ...filledBasic,
      triggerType: 'fixed_rate',
      fixedRate: 3600,
    });
    expect(fixedFilled.percent).toBe(100);
  });

  it('executorMode 非 pinned 时 executorId 不进分母', () => {
    for (const mode of ['auto', 'group', 'broadcast'] as const) {
      const result = computeFormCompletion({ ...filledBasic, triggerType: 'manual', executorMode: mode });
      expect(result.sections[2].requiredTotal).toBe(0);
      expect(result.percent).toBe(100);
    }
  });

  it('executorMode = pinned 时 executorId 进分母', () => {
    const pinned = computeFormCompletion({
      ...filledBasic,
      triggerType: 'manual',
      executorMode: 'pinned',
    });
    expect(pinned.sections[2].requiredTotal).toBe(1);
    expect(pinned.percent).toBe(75);
    const pinnedFilled = computeFormCompletion({
      ...filledBasic,
      triggerType: 'manual',
      executorMode: 'pinned',
      executorId: 'exec-1',
    });
    expect(pinnedFilled.percent).toBe(100);
  });

  it('codeSource = application_zip 时 applicationId 进分母（FR-18）', () => {
    const zipMissing = computeFormCompletion({
      ...filledBasic,
      triggerType: 'manual',
      codeSource: 'application_zip',
    });
    expect(zipMissing.sections[0].requiredTotal).toBe(4);
    expect(zipMissing.sections[0].requiredMissing).toEqual(['taskForm.field.applicationId.zipRequired']);
    expect(zipMissing.percent).toBe(75);

    const zipFilled = computeFormCompletion({
      ...filledBasic,
      triggerType: 'manual',
      codeSource: 'application_zip',
      applicationId: 'app-1',
    });
    expect(zipFilled.percent).toBe(100);
  });

  it('git / glue 来源下 applicationId 不参与统计（git 任务不需要应用）', () => {
    for (const codeSource of ['git', 'glue'] as const) {
      const result = computeFormCompletion({ ...filledBasic, triggerType: 'manual', codeSource });
      expect(result.sections[0].requiredTotal).toBe(3);
      expect(result.percent).toBe(100);
    }
  });
});

describe('computeFormCompletion：百分比只由必填项决定', () => {
  it('填了 3 个必填中的 1 个 = 33%（四舍五入）', () => {
    const result = computeFormCompletion({ name: 'x' });
    expect(result.percent).toBe(33);
    expect(result.sections[0].requiredFilled).toBe(1);
    expect(result.sections[0].requiredTotal).toBe(3);
  });

  it('推荐字段填得再多，也不能把必填缺失的表单推过 0%', () => {
    const result = computeFormCompletion({ description: '写了很多', runbook: '# 手册' });
    expect(result.percent).toBe(0);
    expect(result.sections[0].filled).toBe(false);
    // 推荐缺口随之清空
    expect(result.sections[0].recommendedMissing).toEqual([]);
    expect(result.sections[1].recommendedMissing).toEqual([]);
  });

  it('纯空白输入不算填（与后端 IsNotEmpty/名称 trim 语义一致）', () => {
    const result = computeFormCompletion({
      name: '   ',
      runtime: 'python',
      entrypoint: '  ',
      triggerType: 'manual',
    });
    expect(result.percent).toBe(33);
    expect(result.sections[0].requiredMissing).toEqual([
      'taskForm.field.name',
      'taskForm.field.entrypoint',
    ]);
  });

  it('参数/Glue 分区无必填项：永远是 filled=true，且不稀释整体百分比', () => {
    const result = computeFormCompletion({});
    const params = result.sections.find((s) => s.id === 'sec-params');
    const glue = result.sections.find((s) => s.id === 'sec-glue');
    expect(params).toMatchObject({ filled: true, requiredTotal: 0, requiredMissing: [] });
    expect(glue).toMatchObject({ filled: true, requiredTotal: 0, requiredMissing: [] });
  });
});

describe('computeFormCompletion：可注入 spec（纯函数，不绑定任务表单）', () => {
  const spec: readonly CompletionSectionSpec[] = [
    {
      id: 's1',
      required: [
        { name: 'a', missingKey: 'k.a' },
        { name: 'b', missingKey: 'k.b', appliesWhen: (v) => v.mode === 'x' },
      ],
    },
  ];

  it('缺省 spec 之外也能独立工作', () => {
    expect(computeFormCompletion({ a: 1 }, spec).percent).toBe(100);
    expect(computeFormCompletion({ a: 1, mode: 'x' }, spec).percent).toBe(50);
    expect(computeFormCompletion({ mode: 'x' }, spec).percent).toBe(0);
  });

  it('分母为 0 时给 0% 而不是 100%（不替用户断言「已完成」）', () => {
    const empty: readonly CompletionSectionSpec[] = [{ id: 'only', required: [] }];
    const result = computeFormCompletion({ anything: 1 }, empty);
    expect(result.percent).toBe(0);
    expect(result.sections[0].filled).toBe(true);
  });
});
