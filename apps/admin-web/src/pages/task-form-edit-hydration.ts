/**
 * REFACTOR-TASKFORM-08：编辑态表单回填**载荷**（原 TaskFormPage 编辑加载
 * effect 内 setFieldsValue 的内联对象原样迁出为纯函数）。
 *
 * 纯函数、无 React 依赖：输入任务读面，输出 setFieldsValue 的完整字段树。
 * 每个键的回填语义（为什么必须挂载、为什么空态归 undefined 而非 []）见对应
 * 行注释——与迁出前逐字一致，仅改变承载位置，提交链路不受影响。
 */
import type { Task } from '../api/tasks';
import { affinityFormValues } from './executor-mode';
import { toPriorityValue } from '../utils/priority';
import { timeoutPolicyFormValues } from './timeout-policy';
import { retryableErrorsFormValues } from './retry-policy';

export function buildEditFormValues(task: Task): Record<string, unknown> {
  return {
    name: task.name,
    description: task.description,
    runtime: task.runtime,
    entrypoint: task.entrypoint,
    requirements: task.requirements ?? [],
    applicationId: task.applicationId,
    // python_task_multiversion（FR-18）：git 来源两字段与 glueSource 必须
    // 挂载并回填——applyCodeSourcePayload 的"自证"判定读的就是载荷里的这两
    // 个键（glue 分支靠 glueSource 非空才敢声明 codeSource='glue'）。不回填
    // 会让编辑态保存把这些值判成"未提供"从而清掉代码来源声明。
    // glueSource 的唯一写方是 GlueEditor（tasksApi.updateGlue），此处写回
    // 原值是幂等 no-op；空值归一 undefined 以免提交空串。
    gitRepo: task.gitRepo ?? undefined,
    gitBranch: task.gitBranch ?? undefined,
    glueSource: task.glueSource ?? undefined,
    // TASK-PROJ-01: 编辑态回填归属项目（null = 未分配 → undefined 让
    // Select 显示占位符，而不是把 "null" 当值）
    projectId: task.projectId ?? undefined,
    triggerType: task.triggerType || 'manual',
    // A4: 上一轮未结束时新触发的处置策略（null = 存量行未声明 → 后端
    // 默认 serial；表单回填 serial 使控件显示与后端实际生效值一致）。
    blockStrategy: task.blockStrategy ?? 'serial',
    cronExpression: task.cronExpression,
    timezone: task.timezone,
    fixedRate: task.fixedRate,
    priority: toPriorityValue(task.priority),
    timeout: task.timeoutSeconds ?? task.timeout ?? 300,
    // CORE-04: 超时策略（timeoutAction 缺省 kill；预警阈值空态 undefined）
    ...timeoutPolicyFormValues(task),
    maxRetry: task.maxRetry ?? 3,
    retryDelay: task.retryDelay ?? 0,
    // CORE-02: 可重试错误类型白名单（null/缺省 → 空数组占位=全部可重试）
    ...retryableErrorsFormValues(task),
    executorId: task.executorId ?? undefined,
    executorGroup: task.executorGroup,
    executorTags: task.executorTags,
    // NF-04: affinity constraints must be mounted and hydrated in edit mode;
    // otherwise the form submission would normalize absent values to null and
    // silently clear constraints that were never shown to the user.
    ...affinityFormValues(task),
    // FEAT-22 v2: 任务级部署约束模式（'global' 哨兵=跟随全局，Select
    // 需要非 null 的值才能显示选项文案；提交时归一为 null）。
    deploymentPolicy: task.deploymentPolicy ?? 'global',
    params: task.params ?? {},
    // 告警配置（alarmEmail / alarmChannels）：两列是任务级失败通知的唯一
    // 来源（notification.service.notifyFailureWithConfig 直接读 task 实体
    // 的这两列）。此前编辑态**完全没有回填**——前端 Task 接口连字段都没
    // 声明，于是打开已有任务的编辑页时两项恒显示空态；用户只是改个超时
    // 就保存，也会把已配好的接收人与渠道清掉（"界面看着是空的、保存即
    // 删库"）。空态刻意回 undefined 而非 []：undefined 不进请求体，PATCH
    // 缺省=保留旧值，与"用户没碰过这个控件"同义；真正的清空由 Select 的
    // allowClear 产出 []，提交侧原样发送即清除。
    alarmEmail: task.alarmEmail ?? undefined,
    alarmChannels: Array.isArray(task.alarmChannels) ? task.alarmChannels : undefined,
    // FEAT-06: 维护窗口（null/缺省 → 空数组占位，添加行即编辑）
    maintenanceWindows: (task.maintenanceWindows ?? []).map((w) => ({ ...w })),
    // FEAT-11: markdown 运行手册
    runbook: task.runbook ?? '',
  };
}
