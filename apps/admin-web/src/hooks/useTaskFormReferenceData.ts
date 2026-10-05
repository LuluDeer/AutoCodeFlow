/**
 * REFACTOR-TASKFORM-07：任务表单**参照数据**加载（原 TaskFormPage 首个数据
 * 加载 effect 原样迁出）。
 *
 * 承载与「表单字段回填」无关的候选/参照 state：执行器分组、标签、执行器
 * 清单、应用候选（APP-SELECT-01 富信息选项的读面）、归属项目（TASK-PROJ-01）、
 * 上游依赖候选（NF-02，含名称快照 depNameSnapshotRef 供提交时重建映射）。
 *
 * `?applicationId=`（应用详情页「用此应用建任务」）的表单回填**不在本 effect
 * 内**——原实现把它放在这里（依赖含 t），语言切换重拉参照数据时会连带
 * `form.setFieldValue('applicationId', appId)`，把用户已改的应用绑定静默冲回
 * URL 参数值（BUGFIX，见 TaskFormPage 的独立预填 effect：只挂载时/创建态且
 * 表单未脏时生效）。codeSource 是页面自持 state，由父级在新 effect 内经
 * handleApplicationIdParam 同步。
 *
 * 语言切换重拉参照数据本身可接受（选项/警示文案需重译），且本 effect 只
 * set 选项列表 state、**不写任何表单字段**——重拉不会覆盖用户已修改的表单值。
 *
 * 失败降级哲学原样保留：参照数据各自独立 warn，不阻塞表单（下拉退化为
 * 空态引导 / 未分配仍是合法取值）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { FormInstance } from 'antd';
import { useTranslation } from 'react-i18next';
import { message } from '../utils/toast';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { projectsApi } from '../api/projects';
// python_task_multiversion（P2-4）：缓存池清单供版本能力咨询使用。
import type { ExecutorInterpreterCapability } from '../pages/executor-mode';
import '../i18n';

/**
 * python_task_multiversion（AC-19a）：候选应用带 **runtime**——zip 来源要求
 * 应用 runtime 与任务 runtime 一致，表单需就地提示（服务端仍权威校验）。
 * runtime 可缺省：列表读面未回传时归 ''，deriveRuntimeMismatch 对空串不判定
 * （宁可不提示，也不拿未就绪的数据误报）。
 * APP-SELECT-01：其余字段（version/description/status/updatedAt）供富信息
 * 下拉选项使用；缺省归 ''，选项渲染按「有值才显示」处理。
 */
export interface AppOptionSource {
  id: string;
  name: string;
  runtime: string;
  version: string;
  description: string;
  status: string;
  updatedAt: string;
}

/** 执行器候选（pinned 下拉的读面；offline 状态由分区渲染时标注）。 */
export interface TaskFormExecutorOption {
  id: string;
  appName: string;
  address: string;
  status: string;
  // python_task_multiversion（P2-4）：缓存池清单供版本能力咨询使用。
  // null = 旧执行器未上报（与 [] 池空是相反两态，判据在 executor-mode）。
  interpreters?: ExecutorInterpreterCapability[] | null;
}

export interface TaskFormReferenceData {
  groups: string[];
  allTags: string[];
  executors: TaskFormExecutorOption[];
  apps: AppOptionSource[];
  /** APP-SELECT-01：应用列表加载中（下拉 Spin 态）。失败也归 false。 */
  appsLoading: boolean;
  /** TASK-PROJ-01: Select 选项（含显式"未分配"语义：allowClear 即可，不额外造选项） */
  projectOptions: { value: string; label: string }[];
  /** NF-02: 上游依赖选择——候选任务列表（提交时经 depNameSnapshotRef 重建映射） */
  taskOptions: { id: string; name: string }[];
  /** NF-02：依赖名称快照（提交/存模板时重建 dependencies 映射的显示名） */
  depNameSnapshotRef: RefObject<Record<string, string>>;
}

export function useTaskFormReferenceData({
  form,
}: {
  form: FormInstance;
}): TaskFormReferenceData {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [executors, setExecutors] = useState<TaskFormExecutorOption[]>([]);
  const [apps, setApps] = useState<AppOptionSource[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);
  // TASK-PROJ-01: 归属项目候选（不选 = 未分配，归默认项目视图）
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  // TASK-PROJ-01: Select 选项（含显式"未分配"语义：allowClear 即可，不额外造选项）
  const projectOptions = useMemo(
    () => projects.map((p) => ({ value: p.id, label: p.name })),
    [projects],
  );
  // NF-02: 上游依赖选择——候选任务列表 + 名称快照（提交时重建 dependencies 映射）
  const [taskOptions, setTaskOptions] = useState<{ id: string; name: string }[]>([]);
  const depNameSnapshotRef = useRef<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const run = <T,>(request: Promise<T>, onSuccess: (data: T) => void, warning: string) => {
      request
        .then((data) => {
          if (active && !controller.signal.aborted) onSuccess(data);
        })
        .catch(() => {
          if (active && !controller.signal.aborted) message.warning(warning);
        });
    };

    run(executorsApi.getGroups(controller.signal), setGroups, t('taskForm.load.groupFail'));
    run(executorsApi.getTags(controller.signal), setAllTags, t('taskForm.load.tagsFail'));
    run(
      executorsApi.list(controller.signal),
      (data) =>
        setExecutors(
          data.map((e) => ({
            id: e.id as string,
            appName: e.appName as string,
            address: e.address as string,
            status: e.status as string,
            // P2-4：透传缓存池清单（后端 findAll 一直返回，此前读模型没接）。
            interpreters: e.interpreters ?? null,
          })),
        ),
      t('taskForm.load.executorsFail'),
    );
    // APP-SELECT-01：成功/失败都要结束 loading（失败仅 warn，同下述项目列表的
    // 降级哲学——下拉仍有空态引导可用）。finally 在 abort 后也触发，需防越界写入。
    run(
      applicationsApi.list(controller.signal).finally(() => {
        if (active && !controller.signal.aborted) setAppsLoading(false);
      }),
      (data) => setApps(
        data.map((a) => ({
          id: a.id,
          name: a.name,
          runtime: a.runtime ?? '',
          version: a.version ?? '',
          description: a.description ?? '',
          status: a.status ?? '',
          updatedAt: a.updatedAt ?? '',
        })),
      ),
      t('taskForm.load.appsFail'),
    );
    // TASK-PROJ-01: 归属项目候选。失败只 warn（不阻塞表单）——未分配仍是合法
    // 取值，故取不到列表时退回"仅能选未分配"，而不是让整个表单不可用。
    run(
      projectsApi.list(),
      (data) => setProjects(data.map((p) => ({ id: p.id, name: p.name }))),
      t('taskForm.load.projectsFail'),
    );
    // NF-02: 上游依赖候选（分页拉全，取 id+name；编辑态在任务加载后过滤自身）
    tasksApi
      .listAll({}, controller.signal)
      .then((data) => {
        if (active && !controller.signal.aborted) {
          const opts = data.items.map((t) => ({ id: t.id, name: t.name }));
          setTaskOptions(opts);
          // NF-02：名称快照顺带按候选列表播种。此前 depNameSnapshot 只在**编辑
          // 态**由 task.dependencies 填充，创建态恒为 {}——于是创建态提交的
          // dependencies 映射退化为 `{ id: id }`（buildDependenciesPayload 的
          // 兜底分支）。依赖名虽只用于展示，但"存为模板/克隆"等通路依赖它还原
          // 编排关系的可读形态；播种后创建态也能带上真实任务名。
          // 不覆盖已有键（编辑态回填的任务自带映射是权威值）。
          for (const o of opts) {
            if (!depNameSnapshotRef.current[o.id]) {
              depNameSnapshotRef.current[o.id] = o.name;
            }
          }
        }
      })
      .catch(() => {
        if (active && !controller.signal.aborted) {
          message.warning(t('taskForm.load.tasksFail'));
        }
      });
    // BUGFIX（P1）：`?applicationId=` 的表单回填与代码来源切换已上移至
    // TaskFormPage 的独立 effect（带 once-ref 与 dirty 守卫）——原先放在本
    // effect 内，t 引用变化触发重拉时会连带给 form.setFieldValue，把用户已改
    // 的应用绑定/代码来源冲回 URL 参数语义。

    return () => {
      active = false;
      controller.abort();
    };
    // 依赖与原实现等价（原 [appId, editId, form, t, onApplicationIdParamApplied]
    // 中 appId/editId/回调仅服务于已上移的回填）：重跑时机 = 挂载 / 语言切换
    // （重拉参照数据可接受，见头注释——不写表单字段）。
  }, [form, t]);

  return { groups, allTags, executors, apps, appsLoading, projectOptions, taskOptions, depNameSnapshotRef };
}
