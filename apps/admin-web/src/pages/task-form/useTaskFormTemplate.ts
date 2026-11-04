/**
 * R7 刀 1（模板子域）：FEAT-13「保存为自定义模板」的整体链路，从
 * `TaskFormPage.tsx` 原样迁出为一个独立 hook（纯搬移 / 零行为变更）。
 *
 * ## 为什么是「第一个该搬的子域」
 *
 * 本页 24 个 useState 分属 8 个子域，其中**模板子域是全页唯一零共享 state
 * 交叉**的一个：`tplModalOpen` / `tplSaving` 只被本页自己读自己写；
 * `openSaveAsTemplate` / `handleTemplateConfirm` 只**读**表单与三个自持 state
 * （runtimeVersion / codeSource / executorMode）+ 两个 ref，**不写**：
 *   · **不写 `dirty`**（未保存守卫的置脏时机只有 4 处直接调用 + 1 处经
 *     `clearFormDirty` 间接写，全部在表单编辑 / 编辑态加载 / 模板**预填** /
 *     草稿恢复 / 提交成功这五条语义上，**存模板**一条都不沾）；
 *   · **不写任何表单字段**（`form.setFieldsValue` / `setFieldValue` 零调用，
 *     只读 `form.validateFields()` 与 `form.getFieldsValue(true)`）；
 *   · **不参与任何 effect 的时序**（无 useEffect，无依赖数组）。
 * ⇒ 搬走它不会动「回填 vs 用户输入」的任何一条竞态。
 *
 * ## 与提交链路的同源纪律
 *
 * 模板 config 的组装复用提交路径的同一组纯函数（`buildTemplateConfigPayload`
 * → `applyCodeSourcePayload` / `applyRuntimeVersionPayload` /
 * `applyDependenciesPayload` / `buildExecutorPayload`），因此模板里存下的
 * codeSource / runtimeVersion / 依赖映射与真实提交时的取值**逐字一致**；
 * 这些纯函数各自先做浅拷贝再改写，**不改 antd 的活 store**（本页
 * `submitTaskForm` 里的 cron 原地改写不在这条链路上）。
 *
 * `runtimeVersion` 与 `codeSource` 是**自持 state、不在 antd 字段树里**，
 * 因此必须像提交路径那样显式注入，否则模板会静默丢掉用户显式做过的选择。
 *
 * ## 身份稳定性
 *
 * `openSaveAsTemplate` / `handleTemplateConfirm` 都是**事件处理器**（点击后
 * 才调用），不是 effect 依赖 ⇒ 无需 `useCallback` 固定身份；页面把它们原样
 * 接到按钮 `onClick` 与弹窗 `onConfirm` 上，行为与搬移前逐字一致。
 */
import { useState } from 'react';
import type { RefObject } from 'react';
import type { FormInstance } from 'antd';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { message } from '../../utils/toast';
import { isFormValidationError, showApiError } from '../../utils/error';
import { taskTemplatesApi } from '../../api/task-templates';
import { queryKeys } from '../../api/queries';
import { buildTemplateConfigPayload } from '../task-form-template-payload';
import type { CodeSource, ExecutorMode } from '../executor-mode';
import type { TaskFormTemplateMeta } from '../../components/task-form/TaskFormTemplateModal';
import '../../i18n';

/** 入参：模板子域读到的表单与自持 state（**只读**，不写 dirty / 不写字段）。 */
export interface UseTaskFormTemplateOptions {
  /** 本页的 antd 表单实例（只读：validateFields / getFieldsValue） */
  form: FormInstance;
  /** 声明的 Python 版本（RuntimeVersionField 自持 state，不在字段树里） */
  runtimeVersion: string | null;
  /** 当前代码来源（选择器自持 state，不在字段树里） */
  codeSource: CodeSource;
  /** 任务原本的代码来源（applyCodeSourcePayload 的「离开 zip 才清」判据） */
  previousCodeSourceRef: RefObject<CodeSource>;
  /** 执行器策略（自持 state，不在字段树里） */
  executorMode: ExecutorMode;
  /** NF-02：上游依赖名称快照（重建 dependencies 映射的显示名） */
  depNameSnapshotRef: RefObject<Record<string, string>>;
}

/** 返回值：弹窗态 + 两个事件处理器（页面接到按钮与弹窗上）。 */
export interface TaskFormTemplateController {
  /** 「保存为模板」弹窗是否打开 */
  tplModalOpen: boolean;
  /** 模板保存请求进行中（弹窗按钮 loading） */
  tplSaving: boolean;
  /** 入口按钮：先跑一遍表单校验（同提交门），通过后开弹窗 */
  openSaveAsTemplate: () => Promise<void>;
  /** 弹窗确认：载荷组装 + POST /task-templates + 反馈 + 失效列表 */
  handleTemplateConfirm: (meta: TaskFormTemplateMeta) => Promise<void>;
  /** 弹窗取消 / 保存成功后关闭 */
  closeTemplateModal: () => void;
}

export function useTaskFormTemplate({
  form,
  runtimeVersion,
  codeSource,
  previousCodeSourceRef,
  executorMode,
  depNameSnapshotRef,
}: UseTaskFormTemplateOptions): TaskFormTemplateController {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // FEAT-13：「保存为模板」弹窗（表单校验通过后把当前值固化为自定义模板）
  const [tplModalOpen, setTplModalOpen] = useState(false);
  const [tplSaving, setTplSaving] = useState(false);

  // FEAT-13：「保存为模板」——先跑一遍表单校验（同提交门），通过后把当前值
  // 映射为 CreateTaskDto 子集 config（POST /task-templates 后端再以
  // whitelist + forbidNonWhitelisted 复验），弹小 Modal 收模板元信息。
  const openSaveAsTemplate = async () => {
    try {
      await form.validateFields();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      // UX-11（与上方 handleSubmit 的 catch 同一审查结论）：不手写
      // `err instanceof Error` 判定——client.ts 的拦截器 reject 的是普通对象，
      // instanceof 对其恒 false，可操作的文案会被泛化错误串吞掉。showApiError
      // 内部经 getErrMsg 归一「普通对象 / Error 实例」两种形态后再呈现。
      showApiError(err, t('taskForm.validate.fail'));
      return;
    }
    // F-28（DEEP_REVIEW 0ef3bbe）：原为 `name: cond ? undefined : undefined` 死三元
    // （两分支同值），整段删除——模板名一律留给用户填写（表单 name 是任务标识，
    // 常不满足模板命名习惯）；弹窗 destroyOnHidden 已保证每次打开都是空表单。
    setTplModalOpen(true);
  };

  // FEAT-13：模板元信息校验已在 TaskFormTemplateModal 内完成（原
  // handleSaveAsTemplate 的 validateFields 前半段随之迁出），此处承接校验通过
  // 后的载荷组装与请求——链路与原先逐字一致（saving 状态仍在元信息校验通过
  // 后才置位；模板保存失败不影响表单数据）。
  const handleTemplateConfirm = async (meta: TaskFormTemplateMeta) => {
    const values = form.getFieldsValue(true);
    setTplSaving(true);
    // 载荷组装原样迁出至 task-form-template-payload.buildTemplateConfigPayload：
    // FR-06/FR-18（runtimeVersion/codeSource 不在字段树，须显式注入且与提交路径
    // 逐字一致）与 NF-02（上游依赖归一 + 载体键删除）的语义见该模块头注释。
    const config = buildTemplateConfigPayload({
      values,
      runtimeVersion,
      codeSource,
      previousCodeSource: previousCodeSourceRef.current,
      executorMode,
      depNameSnapshot: depNameSnapshotRef.current,
    });
    try {
      await taskTemplatesApi.create({
        name: meta.name.trim(),
        description: meta.description?.trim() || undefined,
        category: meta.category?.trim() || undefined,
        config,
      });
      message.success(t('taskForm.tpl.saved', { name: meta.name.trim() }));
      setTplModalOpen(false);
      // NETOPT-E P2-3: 与 TaskDetailPage 的存模板路径对齐——写后失效模板列表。
      void queryClient.invalidateQueries({
        queryKey: queryKeys.taskTemplates.list,
      });
    } catch (err: unknown) {
      // validateFields 的 reject 是带 errorFields 的校验对象，不是请求错误——
      // 仅对真正的请求失败弹 toast，表单校验错误由 Form 自带红字呈现。
      if (isFormValidationError(err)) return;
      showApiError(err, t('taskForm.tpl.saveFail'));
    } finally {
      setTplSaving(false);
    }
  };

  return {
    tplModalOpen,
    tplSaving,
    openSaveAsTemplate,
    handleTemplateConfirm,
    closeTemplateModal: () => setTplModalOpen(false),
  };
}
