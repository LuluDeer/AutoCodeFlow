/**
 * FIX-PREFILL-SYMMETRY：模板预填与「保存为模板」两条通路的**键集对称性**守护。
 *
 *  - 写侧：utils/task-template-config-from-form.ts（表单值 → 模板 config）
 *  - 读侧：pages/task-template-prefill.ts（模板 config → 表单值）
 *
 * 此前读侧漏了 requirements/dependencies/retryableErrors/维护窗口/runbook/
 * 执行器策略——"存模板 → 从模板建任务"静默丢字段。本测试固化核心不变式：
 * **写侧固化的每个键，读侧都必须消费**（经字段名桥接表归一后键集合相等），
 * 两侧任何一侧再补键而不同步另一侧，此处即红。
 *
 * 桥接（两侧天然不同名的键）：
 *  - timeoutSeconds（DTO/模板）↔ timeout（表单字段名）
 *  - dependencies（Record<显示名, 上游任务id>）↔ upstreamDependencies（表单载体）
 *  - executeMode（config）↔ templateExecutorMode（表单 executorMode state 不在
 *    字段树里，由调用方 setExecutorMode 同步）
 */
import { describe, expect, it } from 'vitest';
import { templateConfigFromFormValues } from '../utils/task-template-config-from-form';
import {
  templateConfigToFormValues,
  templateDependencySnapshot,
  templateExecutorMode,
} from '../pages/task-template-prefill';
import { buildDependenciesPayload } from '../pages/task-dependencies';

/** 写侧键 → 读侧键 的桥接表（其余键两侧同名）。 */
const WRITE_TO_READ_BRIDGE: Record<string, string> = {
  timeoutSeconds: 'timeout',
  dependencies: 'upstreamDependencies',
};
/** 不以表单字段形态消费、经 templateExecutorMode 派生的键。 */
const MODE_DERIVED_WRITE_KEYS = new Set(['executeMode']);

/** 表单全字段哨兵值（每个键都用真实非空值，保证写侧不因"空值省略"丢键）。 */
const FULL_FORM_VALUES: Record<string, unknown> = {
  triggerType: 'cron',
  cronExpression: '0 9 * * 1-5',
  timezone: 'Asia/Shanghai',
  fixedRate: 600,
  runtime: 'python',
  entrypoint: 'main.py',
  runtimeVersion: '3.12',
  codeSource: 'git',
  gitRepo: 'https://example.com/repo.git',
  gitBranch: 'main',
  requirements: ['requests>=2.31'],
  // 写侧直读该键（真实保存通路里由 applyDependenciesPayload 从
  // upstreamDependencies 载体产出——见 TaskFormPage.handleSaveAsTemplate）。
  dependencies: { 上游任务A: 'task-a-id' },
  params: { city: 'hangzhou' },
  timeout: 300,
  timeoutAction: 'notify_only',
  timeoutWarnRatio: 0.8,
  maxRetry: 3,
  retryDelay: 60,
  retryableErrors: ['ERR_.*'],
  priority: 2,
  runbook: '# 排障手册',
  maintenanceWindows: [{ start: '0 2 * * *', end: '0 4 * * *' }],
  executorAffinityTags: ['gpu'],
  executorAntiAffinityTags: ['maintenance'],
};

const PINNED_EXECUTOR = {
  executeMode: 'single',
  executorId: 'exec-1',
  executorGroup: 'group-a',
  executorTags: ['linux'],
  // 真实保存通路里 executor 参数 = buildExecutorPayload(values, mode) 的产物，
  // 亲和/反亲和正是从这里（而非表单 values）被写侧固化——fixture 需如实携带。
  executorAffinityTags: ['gpu'],
  executorAntiAffinityTags: ['maintenance'],
};

/** 读侧表单键 → 写侧 config 键（桥接表取反），供键集合比较。 */
function normalizeReadKeys(keys: string[]): string[] {
  const readToWrite: Record<string, string> = {};
  for (const [w, r] of Object.entries(WRITE_TO_READ_BRIDGE)) readToWrite[r] = w;
  return keys.map((k) => readToWrite[k] ?? k).sort();
}

describe('模板预填 ↔ 保存为模板：键集对称性', () => {
  it('写键集合 === 读键集合（single 模式全量字段，经桥接归一）', () => {
    const written = templateConfigFromFormValues(FULL_FORM_VALUES, PINNED_EXECUTOR);
    const writeKeys = Object.keys(written)
      .filter((k) => !MODE_DERIVED_WRITE_KEYS.has(k))
      .sort();

    const readForm = templateConfigToFormValues(written);
    const readKeys = normalizeReadKeys(Object.keys(readForm));

    expect(writeKeys).toEqual(readKeys);
  });

  it('executeMode 经 templateExecutorMode 派生：pinned/group/auto/broadcast 全判对', () => {
    const pinned = templateConfigFromFormValues(FULL_FORM_VALUES, PINNED_EXECUTOR);
    expect(templateExecutorMode(pinned)).toBe('pinned');

    const grouped = templateConfigFromFormValues(FULL_FORM_VALUES, {
      executeMode: 'single',
      executorId: null,
      executorGroup: 'group-a',
      executorTags: null,
    });
    expect(templateExecutorMode(grouped)).toBe('group');

    const auto = templateConfigFromFormValues(FULL_FORM_VALUES, { executeMode: 'single' });
    expect(templateExecutorMode(auto)).toBe('auto');

    const broadcast = templateConfigFromFormValues(FULL_FORM_VALUES, {
      executeMode: 'broadcast',
      // 广播模式不携带 pin/group/tags，但亲和/反亲和仍固化（NF-04 正交约束）
      executorAffinityTags: ['gpu'],
      executorAntiAffinityTags: ['maintenance'],
    });
    expect(templateExecutorMode(broadcast)).toBe('broadcast');
  });

  it('broadcast 模板不携带 pin/group/tags（写侧省略、读侧不回填）', () => {
    const broadcast = templateConfigFromFormValues(FULL_FORM_VALUES, {
      executeMode: 'broadcast',
      // 广播仍固化亲和/反亲和（NF-04 正交约束）
      executorAffinityTags: ['gpu'],
      executorAntiAffinityTags: ['maintenance'],
    });
    expect(broadcast.executeMode).toBe('broadcast');
    expect(broadcast.executorId).toBeUndefined();
    expect(broadcast.executorGroup).toBeUndefined();
    expect(broadcast.executorTags).toBeUndefined();

    const readForm = templateConfigToFormValues(broadcast);
    expect(readForm.executorId).toBeUndefined();
    expect(readForm.executorGroup).toBeUndefined();
    expect(readForm.executorTags).toBeUndefined();
    // 亲和/反亲和与模式正交，广播模板仍然固化并回填
    expect(readForm.executorAffinityTags).toEqual(['gpu']);
    expect(readForm.executorAntiAffinityTags).toEqual(['maintenance']);
  });

  it('本轮补齐的键值逐项可回读（dependencies 走载体桥接 + 名称快照闭环）', () => {
    const written = templateConfigFromFormValues(FULL_FORM_VALUES, PINNED_EXECUTOR);
    const readForm = templateConfigToFormValues(written);

    expect(readForm.requirements).toEqual(['requests>=2.31']);
    expect(readForm.retryableErrors).toEqual(['ERR_.*']);
    expect(readForm.runbook).toBe('# 排障手册');
    expect(readForm.maintenanceWindows).toEqual([{ start: '0 2 * * *', end: '0 4 * * *' }]);
    expect(readForm.timeout).toBe(300);
    expect(readForm.executorId).toBe('exec-1');
    expect(readForm.executorGroup).toBe('group-a');
    expect(readForm.executorTags).toEqual(['linux']);
    expect(readForm.upstreamDependencies).toEqual(['task-a-id']);

    // 闭环：读侧 Select 值 + 名称快照 → 提交侧重建映射 === 原映射
    const rebuilt = buildDependenciesPayload(
      readForm.upstreamDependencies as string[],
      templateDependencySnapshot(written),
    );
    expect(rebuilt).toEqual({ 上游任务A: 'task-a-id' });
  });

  it('空值省略对称：写侧省略的键读侧也不产出', () => {
    const minimal = templateConfigFromFormValues(
      {
        triggerType: 'manual',
        runtime: 'python',
        params: {},
        requirements: [],
        retryableErrors: [],
        maintenanceWindows: [],
        runbook: '',
      },
      { executeMode: 'single' },
    );
    expect(minimal.params).toBeUndefined();
    expect(minimal.requirements).toBeUndefined();
    expect(minimal.retryableErrors).toBeUndefined();
    expect(minimal.maintenanceWindows).toBeUndefined();
    expect(minimal.runbook).toBeUndefined();

    const readForm = templateConfigToFormValues(minimal);
    expect(readForm.params).toBeUndefined();
    expect(readForm.requirements).toBeUndefined();
    expect(readForm.retryableErrors).toBeUndefined();
    expect(readForm.maintenanceWindows).toBeUndefined();
    expect(readForm.runbook).toBeUndefined();
    expect(readForm.upstreamDependencies).toBeUndefined();
  });
});
