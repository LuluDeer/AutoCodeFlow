/**
 * P1-7（UX-AUDIT-2026-09-21）：「保存为模板」不得系统性丢失 gitRepo/gitBranch。
 *
 * 缺陷：`templateConfigFromFormValues`（表单→模板）与 `extractTemplateConfigFromTask`
 * （Task→模板）两条映射都 `put('codeSource', …)`，却**都漏了** gitRepo/gitBranch。
 * 后果：模板存下 `codeSource:'git'` 却没有仓库地址——从模板建任务时"代码来源"选择
 * 静默失效；且后端 `assertCodeSourceConsistent` 要求 `codeSource='git'` 必须有
 * gitRepo，否则 400。`task-template-prefill`（模板→表单）白名单也未放行，
 * 三处必须一起改。
 *
 * 为什么合法：gitRepo/gitBranch 声明在 CreateTaskDto 上（create-task.dto.ts:139-140），
 * 模板 config 经 whitelist+forbidNonWhitelisted 校验时收得下——后端一直支持，
 * 只是前端没发。与 task-template-runtime-version-roundtrip.test.ts 同层同风格。
 */
import { describe, expect, it } from 'vitest';
import { templateConfigToFormValues } from '../pages/task-template-prefill';
import { templateConfigFromFormValues } from '../utils/task-template-config-from-form';
import { extractTemplateConfigFromTask } from '../utils/task-template-extract';
import type { Task } from '../api/tasks';

describe('P1-7: 表单→模板→预填 gitRepo/gitBranch roundtrip', () => {
  it('git 代码来源的仓库与分支随模板固化并回填（不再静默丢失）', () => {
    const formValues = {
      runtime: 'python',
      entrypoint: 'main.py',
      codeSource: 'git',
      gitRepo: 'https://github.com/acme/data-pipeline.git',
      gitBranch: 'release/2026',
    };

    const config = templateConfigFromFormValues(formValues, { executeMode: 'single' });

    expect(config).toMatchObject({
      codeSource: 'git',
      gitRepo: 'https://github.com/acme/data-pipeline.git',
      gitBranch: 'release/2026',
    });

    // 反向：模板 config → 表单预填，两个 git 字段都必须回来。
    const back = templateConfigToFormValues(config);
    expect(back).toMatchObject({
      gitRepo: 'https://github.com/acme/data-pipeline.git',
      gitBranch: 'release/2026',
    });
  });

  it('空值不写入模板（null/undefined 归一为省略，向后兼容旧模板）', () => {
    const config = templateConfigFromFormValues(
      { runtime: 'python', codeSource: 'glue', gitRepo: null, gitBranch: null },
      { executeMode: 'single' },
    );
    expect(config).not.toHaveProperty('gitRepo');
    expect(config).not.toHaveProperty('gitBranch');

    // 旧模板缺这两个键时，预填不写入（表单保持默认空态）。
    const back = templateConfigToFormValues({ runtime: 'python', codeSource: 'glue' });
    expect(back).not.toHaveProperty('gitRepo');
    expect(back).not.toHaveProperty('gitBranch');
  });
});

describe('P1-7: TaskDetailPage「存为模板」抽取 gitRepo/gitBranch', () => {
  it('从 Task 抽模板 config 时 git 仓库/分支不丢，且能经预填回到表单', () => {
    const task = {
      runtime: 'python',
      entrypoint: 'main.py',
      codeSource: 'git',
      gitRepo: 'https://github.com/acme/jobs.git',
      gitBranch: 'main',
    } as unknown as Task;

    const config = extractTemplateConfigFromTask(task);
    expect(config).toMatchObject({
      codeSource: 'git',
      gitRepo: 'https://github.com/acme/jobs.git',
      gitBranch: 'main',
    });

    expect(templateConfigToFormValues(config)).toMatchObject({
      gitRepo: 'https://github.com/acme/jobs.git',
      gitBranch: 'main',
    });
  });

  it('旧任务无 git 字段时不写入（与旧模板同策）', () => {
    const task = { runtime: 'python', entrypoint: 'main.py' } as unknown as Task;
    const config = extractTemplateConfigFromTask(task);
    expect(config).not.toHaveProperty('gitRepo');
    expect(config).not.toHaveProperty('gitBranch');
  });
});
