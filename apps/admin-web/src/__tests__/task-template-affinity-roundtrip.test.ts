import { describe, expect, it } from 'vitest';
import type { Task } from '../api/tasks';
import { templateConfigToFormValues } from '../pages/task-template-prefill';
import { templateConfigFromFormValues } from '../utils/task-template-config-from-form';

describe('任务模板亲和约束 roundtrip', () => {
  it('保留非空亲和/反亲和数组及既有执行器策略字段', () => {
    const formValues = {
      executorAffinityTags: ['gpu', 'edge'],
      executorAntiAffinityTags: ['windows'],
    };
    const config = templateConfigFromFormValues(formValues, {
      executeMode: 'single',
      executorId: 'executor-1',
      executorGroup: 'production',
      executorTags: ['cuda'],
      executorAffinityTags: formValues.executorAffinityTags,
      executorAntiAffinityTags: formValues.executorAntiAffinityTags,
    });

    expect(config).toMatchObject({
      executeMode: 'single',
      executorId: 'executor-1',
      executorGroup: 'production',
      executorTags: ['cuda'],
      executorAffinityTags: ['gpu', 'edge'],
      executorAntiAffinityTags: ['windows'],
    });
    expect(templateConfigToFormValues(config)).toMatchObject(formValues);
  });

  const emptyAffinityValues: Array<undefined | string[] | null> = [undefined, [], null];
  it.each(emptyAffinityValues)(
    '亲和约束值 %s 按现有执行器约束语义省略',
    (emptyValue) => {
      const config = templateConfigFromFormValues(
        {},
        {
          executeMode: 'single',
          executorAffinityTags: emptyValue,
          executorAntiAffinityTags: emptyValue,
        },
      );

      expect(config).not.toHaveProperty('executorAffinityTags');
      expect(config).not.toHaveProperty('executorAntiAffinityTags');
    },
  );

  it('旧模板缺少亲和字段时保持兼容，空数组/null 预填为未设置', () => {
    expect(templateConfigToFormValues({ runtime: 'python' })).toEqual({ runtime: 'python' });
    expect(
      templateConfigToFormValues({
        executorAffinityTags: [],
        executorAntiAffinityTags: null,
      }),
    ).toEqual({});
  });

  it('Task API 使用严格匹配的亲和字段名和可空数组类型', () => {
    const taskAffinity: Pick<Task, 'executorAffinityTags' | 'executorAntiAffinityTags'> = {
      executorAffinityTags: ['gpu'],
      executorAntiAffinityTags: null,
    };
    expect(taskAffinity).toEqual({
      executorAffinityTags: ['gpu'],
      executorAntiAffinityTags: null,
    });
  });
});
