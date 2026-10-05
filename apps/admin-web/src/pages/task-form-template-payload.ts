/**
 * REFACTOR-TASKFORM-10：「存为模板」的 config 载荷组装（原 TaskFormPage
 * handleSaveAsTemplate 中段原样迁出为纯函数）。
 *
 * python_task_multiversion（FR-06 / FR-18）：`runtimeVersion` 与 `codeSource`
 * **不在表单字段树里**（前者由 RuntimeVersionField 自持 state，后者由
 * CodeSource 选择器自持 state），因此 `values` 上读不到它们——必须像提交路径
 * 那样经 applyRuntimeVersionPayload / applyCodeSourcePayload 归一后显式注入，
 * 否则模板会静默丢掉"Python 版本钉定"与"代码来源"这两个用户显式做过的选择。
 *
 * 复用提交路径的同一组纯函数（而不是在这里另写一遍判定），是为了让模板里
 * 存下的 codeSource 与真实提交时的取值**逐字一致**：两者都遵循同一条
 * "载荷自证才声明"规则（见 executor-mode.ts），否则从模板建出的任务会因
 * 声明漂移被后端 400。
 *
 * NF-02：上游依赖必须与提交路径同样归一后再固化。`dependencies` 不在表单
 * 字段树里（表单载体是 `upstreamDependencies`，DTO 未声明该键），直接拿
 * values 会让"存模板"静默丢掉用户选好的依赖链——从模板建出的任务没有上游
 * 编排关系，而用户在模板里看到的参数却都在，属最易被误判为"模板功能正常"
 * 的丢字段。applyDependenciesPayload 同时完成映射重建与载体键删除，与提交
 * 路径逐字一致（载体键不删会让后端 forbidNonWhitelisted 判 400）。
 */
import {
  applyCodeSourcePayload,
  applyRuntimeVersionPayload,
  buildExecutorPayload,
  type CodeSource,
  type ExecutorMode,
} from './executor-mode';
import { applyDependenciesPayload } from './task-dependencies';
import { templateConfigFromFormValues } from '../utils/task-template-config-from-form';

export function buildTemplateConfigPayload({
  values,
  runtimeVersion,
  codeSource,
  previousCodeSource,
  executorMode,
  depNameSnapshot,
}: {
  /** form.getFieldsValue(true) 的原始表单值 */
  values: Record<string, unknown>;
  /** 声明的 Python 版本（RuntimeVersionField 自持 state） */
  runtimeVersion: string | null;
  /** 当前代码来源（选择器自持 state） */
  codeSource: CodeSource;
  /** 任务原本的代码来源（applyCodeSourcePayload 的"离开 zip 才清"判据） */
  previousCodeSource: CodeSource;
  executorMode: ExecutorMode;
  /** NF-02：上游依赖名称快照（重建 dependencies 映射的显示名） */
  depNameSnapshot: Record<string, string>;
}): ReturnType<typeof templateConfigFromFormValues> {
  const tplValues = applyCodeSourcePayload(
    applyRuntimeVersionPayload(values, runtimeVersion),
    codeSource,
    previousCodeSource,
  );
  const tplPayload = applyDependenciesPayload(tplValues, depNameSnapshot);
  return templateConfigFromFormValues(
    tplPayload,
    buildExecutorPayload(tplPayload, executorMode),
  );
}
