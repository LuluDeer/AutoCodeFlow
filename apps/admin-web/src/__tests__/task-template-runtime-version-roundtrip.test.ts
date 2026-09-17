/**
 * 回归：任务模板必须固化 `runtimeVersion` 与 `codeSource`（python_task_multiversion）。
 *
 * 缺陷：`templateConfigFromFormValues`（表单 → 模板）与
 * `templateConfigToFormValues`（模板 → 表单预填）两个映射**都**漏了这两个字段，
 * 于是"存为模板 → 从模板建任务"这条通路会静默丢掉用户显式做过的两个选择：
 *
 *   - `runtimeVersion` 丢失 → 任务落回执行器宿主默认解释器。用户以为钉住了
 *     3.7（并为它预填了解释器缓存卷），实际任务跑在别的版本上。
 *   - `codeSource` 丢失 → 更隐蔽：`gitRepo`/`applicationId` 还在，后端只能按
 *     迁移期的隐式推断（git > glue > application_zip）还原来源。用户选过的
 *     通道被悄悄改写，而"存模板"这个动作本身没有给任何提示。
 *
 * 为什么两个字段是**合法**的模板 config 键：模板 config 落库前按 CreateTaskDto
 * 子集校验（whitelist + forbidNonWhitelisted，见 admin-api
 * task-template.util.ts 的 assertValidTaskTemplateConfig），而 `runtimeVersion`
 * 与 `codeSource` 都声明在 CreateTaskDto 上——后端一直收得下，只是前端没发。
 *
 * 与 task-template-affinity-roundtrip.test.ts 同层次同风格（纯函数 roundtrip）。
 */
import { describe, expect, it } from 'vitest';
import { templateConfigToFormValues } from '../pages/task-template-prefill';
import { templateConfigFromFormValues } from '../utils/task-template-config-from-form';
import { extractTemplateConfigFromTask } from '../utils/task-template-extract';
import type { Task } from '../api/tasks';

describe('任务模板 runtimeVersion / codeSource roundtrip', () => {
  it('runtimeVersion 与 codeSource 双向保留（不再被静默丢弃）', () => {
    const formValues = {
      runtime: 'python',
      entrypoint: 'main.py',
      runtimeVersion: '3.7',
      codeSource: 'application_zip',
    };

    const config = templateConfigFromFormValues(formValues, { executeMode: 'single' });

    expect(config).toMatchObject({
      runtime: 'python',
      entrypoint: 'main.py',
      runtimeVersion: '3.7',
      codeSource: 'application_zip',
    });

    // 反向：模板 config → 表单预填，两个字段都必须回来。
    expect(templateConfigToFormValues(config)).toMatchObject({
      runtimeVersion: '3.7',
      codeSource: 'application_zip',
    });
  });

  it('显式 null（runtime 非 python 时的归一结果）不写入模板', () => {
    // applyRuntimeVersionPayload 对 runtime!=='python' 会显式发 null；模板里
    // 不该固化一个"清空"指令——省略即"未声明"，语义等价且对旧后端更安全。
    const config = templateConfigFromFormValues(
      { runtime: 'node', entrypoint: 'index.js', runtimeVersion: null, codeSource: null },
      { executeMode: 'single' },
    );

    expect(config).not.toHaveProperty('runtimeVersion');
    expect(config).not.toHaveProperty('codeSource');
  });

  it('旧模板缺这两个键时不写入（表单保持默认空态，向后兼容）', () => {
    const values = templateConfigToFormValues({ runtime: 'python', entrypoint: 'main.py' });
    expect(values).not.toHaveProperty('runtimeVersion');
    expect(values).not.toHaveProperty('codeSource');
    // 既有字段不受影响。
    expect(values).toMatchObject({ runtime: 'python', entrypoint: 'main.py' });
  });

  it('codeSource 的三个合法取值都能往返', () => {
    for (const source of ['git', 'glue', 'application_zip'] as const) {
      const config = templateConfigFromFormValues(
        { runtime: 'python', codeSource: source },
        { executeMode: 'single' },
      );
      expect(config.codeSource, `${source} 应写入模板`).toBe(source);
      expect(templateConfigToFormValues(config).codeSource).toBe(source);
    }
  });
});

describe('TaskDetailPage「存为模板」抽取（extractTemplateConfigFromTask）', () => {
  it('runtimeVersion 与 codeSource 必须从 Task 抽进模板 config', () => {
    // 这是表单映射之外的第二条入模通路（TaskDetailPage 的「存为模板」），
    // 漏带与表单侧是同一条用户可见缺陷：模板实例化后 3.7 声明消失、来源被隐式改写。
    const task = {
      runtime: 'python',
      entrypoint: 'main.py',
      runtimeVersion: '3.7',
      codeSource: 'application_zip',
    } as unknown as Task;

    const config = extractTemplateConfigFromTask(task);
    expect(config).toMatchObject({
      runtime: 'python',
      runtimeVersion: '3.7',
      codeSource: 'application_zip',
    });

    // 抽出来还要能经预填映射回到表单（端到端 round-trip）。
    expect(templateConfigToFormValues(config)).toMatchObject({
      runtimeVersion: '3.7',
      codeSource: 'application_zip',
    });
  });

  it('旧任务缺这两个键时不写入（与旧模板同策，向后兼容）', () => {
    const task = { runtime: 'python', entrypoint: 'main.py' } as unknown as Task;
    const config = extractTemplateConfigFromTask(task);
    expect(config).not.toHaveProperty('runtimeVersion');
    expect(config).not.toHaveProperty('codeSource');
  });
});
