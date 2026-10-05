import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  deriveExecutorMode,
  buildExecutorPayload,
  applyRequirementsPayload,
  // python_task_multiversion（FR-06/FR-18）：runtimeVersion 声明 + codeSource 互斥
  applyRuntimeVersionPayload,
  applyCodeSourcePayload,
  // SEC-02 续（生产故障）：凭据的掩码闸门（提交前过滤 ******，防掩码落库）
  applySecretsPayload,
  deriveCodeSourceFromTask,
  normalizeRuntimeVersion,
  interpreterFleetAdvisory,
  runtimeVersionIsOfflineTier,
  configureRuntimeVersionConfig,
  type CodeSource,
} from './executor-mode';
// PK-02（DEEP_REVIEW 0ef3bbe）：create/update 改用生成的 DTO 类型，
// payload 由 apply* 链组装后类型收窄为 Record<string, unknown>，调用点显式断言。
import type { components } from '../types/generated/api-types';
import { Form,
  Button,
  Space,
  Typography,
  Tooltip,
  theme,
  Modal } from 'antd';
import { message } from '../utils/toast';
// MODAL-01：命令式 Modal.* 从 utils/modal 取（吃暗色主题 + i18n locale）；<Modal> JSX 仍用 antd。
import { Modal as confirmModal } from '../utils/modal';
import {
  ThunderboltOutlined, ArrowLeftOutlined, SaveOutlined,
} from '@ant-design/icons';
// （APP-SELECT-01 的 Link/空态引导随应用选择器一起迁入 TaskFormBasicSection。）
import { useNavigate, useSearchParams, useParams, useBlocker } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore, isAdminUser } from '../store/auth';
import { configApi } from '../api/config';
import { tasksApi } from '../api/tasks';
// A4（第三轮审计）：保存成功后统一失效任务/执行/metrics 面（30s staleTime
// 内跳转不再读旧数据；NETOPT-10-8 同型）。
import { invalidateTaskData, queryKeys } from '../api/queries';
import { taskTemplatesApi } from '../api/task-templates';
import { getErrMsg, isFormValidationError, showApiError } from '../utils/error';
import {
  templateConfigToFormValues,
  templateDependencySnapshot,
  templateExecutorMode,
  templateTriggerAndRuntime,
} from './task-template-prefill';
import { CronHelper } from '../components/CronHelper';
import PageSkeleton from '../components/PageSkeleton';
import { suggestCronStepRewrite } from '../utils/trigger-preview';
// python_task_multiversion（FR-06）：RuntimeVersionField 随基本分区迁入
// TaskFormBasicSection（编辑态早退与 hook 数的说明见该组件头注释）。
import {
  applyMaintenanceWindowsPayload,
} from './maintenance-windows';
import {
  applyTimeoutPolicyPayload,
} from './timeout-policy';
import {
  applyRetryableErrorsPayload,
} from './retry-policy';
import {
  applyDependenciesPayload,
  dependenciesFormValues,
} from './task-dependencies';
// REFACTOR-TASKFORM-08/09/10：编辑态回填载荷、代码来源切换守卫、存模板 config
// 组装——均为原样迁出的纯函数/hook（语义见各自头注释，提交链路不变）。
import { buildEditFormValues } from './task-form-edit-hydration';
import { useCodeSourceSwitchGuard } from './task-form-code-source';
import { buildTemplateConfigPayload } from './task-form-template-payload';
import PageHeader from '../components/PageHeader';
// REFACTOR-TASKFORM-01/02：参数与 Glue 分区展示组件（原内联 JSX 原样迁出）
import TaskFormParamsSection from '../components/task-form/TaskFormParamsSection';
import TaskFormGlueSection from '../components/task-form/TaskFormGlueSection';
// REFACTOR-TASKFORM-03/04/05：基本/触发/执行器三分区（原内联 JSX 原样迁出，
// 受控 props 下传：状态提升仍保留在本页，提交链路不受影响）
import TaskFormBasicSection from '../components/task-form/TaskFormBasicSection';
import TaskFormTriggerSection from '../components/task-form/TaskFormTriggerSection';
import TaskFormExecutorSection from '../components/task-form/TaskFormExecutorSection';
// REFACTOR-TASKFORM-06：「保存为模板」弹窗（tplForm 与元信息校验随之迁出）
import TaskFormTemplateModal, {
  type TaskFormTemplateMeta,
} from '../components/task-form/TaskFormTemplateModal';
// REFACTOR-TASKFORM-11：锚点条 + 校验播报区（页框架 JSX 原样迁出）
import TaskFormNavRail from '../components/task-form/TaskFormNavRail';
// REFACTOR-TASKFORM-07：参照数据加载 hook（执行器分组/标签/清单、应用、项目、
// 依赖候选；失败降级哲学见其头注释；?applicationId= 回填在本页独立 effect，
// 见 BUGFIX 注释）
import { useTaskFormReferenceData } from '../hooks/useTaskFormReferenceData';
// BUGFIX（P3，commit 7d66a9b0 清单）：创建成功滚 Glue 的等待渲染就绪工具
// （rAF 两连 + 存在性轮询，替代 setTimeout(50) 魔法延时）。
import { scrollToSectionWhenReady } from '../utils/scroll-when-ready';
import { useTranslation } from 'react-i18next';
import '../i18n';

// UI-06: 单页分区锚点。全部 Form.Item 同时挂载，锚点条只负责滚动定位。
const SECTION_IDS = ['sec-basic', 'sec-trigger', 'sec-executor', 'sec-params', 'sec-glue'] as const;

export default function TaskFormPage() {
  const { t } = useTranslation();
  // BUGFIX（P1，commit 7d66a9b0 清单）：语言切换时 t 引用变化，曾令把 t 列入
  // 依赖的数据回填 effect（编辑态任务加载 / 模板预填）整组重跑——整表重回填 +
  // setDirty(false) 会冲掉用户未保存的修改。这两个 effect 以任务/模板 id 为键
  // 只跑一次（t 已移出依赖数组），失败文案经 tRef 取**调用当时**的语言。
  const tRef = useRef(t);
  tRef.current = t;
  const nav = useNavigate();
  // P1-5：任务写操作仅管理员可用。
  const isAdmin = isAdminUser(useAuthStore((s) => s.user));
  // NETOPT-E P2-3: 保存为模板是 task-templates 写——不失效则列表页 staleTime
  // 30s 内跳转看不到新模板（与 TaskDetailPage 的 NETOPT-D P2-D6 修复同型；
  // 两个"存模板"入口必须对齐失效图）。
  const queryClient = useQueryClient();
  const { id: editId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const appId = searchParams.get('applicationId');
  // CORE-03：创建态带 ?templateId= 时，拉取模板 config 预填表单（显式可改）。
  const templateId = searchParams.get('templateId');
  // F-04（DEEP_REVIEW @0ef3bbe）：详情页「应用建议 Cron」带 ?suggestCron= 跳转
  // 编辑页（此前全仓无消费方=死链）。
  const suggestCron = searchParams.get('suggestCron');
  const isEdit = !!editId;

  const [form] = Form.useForm();
  const [triggerType, setTriggerType] = useState('manual');
  // UI-12：校验失败的读屏播报（antd message 是浮层，读屏不会回读）
  const [validationAnnouncement, setValidationAnnouncement] = useState('');
  const [executorMode, setExecutorMode] = useState<'auto' | 'group' | 'pinned' | 'broadcast'>('auto');
  const [saving, setSaving] = useState(false);
  const [loadingTask, setLoadingTask] = useState(isEdit);
  // A4（第三轮审计·中）：乐观锁——编辑态加载时的任务 updatedAt。提交时随
  // expectedUpdatedAt 回传，服务端比对不符返回 409（另一标签页已抢先修改）。
  // 仅编辑路径参与；null（加载失败/未加载）= 不带该字段 = 服务端跳过检查。
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<string | null>(null);
  // P1-4（UX 审计）：表单 dirty 守卫——用户改过且未保存时，拦截站内跳转与浏览器关闭。
  const [dirty, setDirty] = useState(false);
  // GLUE-DIRTY-01：Glue 脚本编辑器的未保存改动同样要拦——原先 dirty 只覆盖
  // 表单字段，脚本改完不保存直接关页/跳转是无声丢失。
  const [glueDirty, setGlueDirty] = useState(false);
  const navigationBlocker = useBlocker(dirty || glueDirty);
  // P1-4：浏览器关闭/刷新未保存守卫（站内跳转由 navigationBlocker + 确认弹窗兜底）。
  useEffect(() => {
    if (!dirty && !glueDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, glueDirty]);
  const [showCronHelper, setShowCronHelper] = useState(false);
  // Glue: createdTaskId is set after create so GlueEditor can save to the real task id
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [savedRuntime, setSavedRuntime] = useState('python');

  // python_task_multiversion（FR-06）：声明的 Python 主.次版本。null = 不声明
  // （宿主默认解释器）。**刻意不入 antd 字段树**——RuntimeVersionField 是
  // "可选可手输"的受控组合框，中间态（正在输入尚未确认的文本）不应污染表单值；
  // 提交时由 applyRuntimeVersionPayload 显式合成 payload.runtimeVersion。
  // 仍持有 useState 而非 ref：值参与渲染（3.7 警示、宿主默认提示）。
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(null);

  // python_task_multiversion（FR-18/AC-17b）：代码来源三选一（受控 state，同
  // 理由）。编辑态初值由 deriveCodeSourceFromTask 推导——优先后端已回填的
  // codeSource，否则按 gitRepo > glueSource > applicationId 的迁移回填序推断。
  // previousCodeSource 是 applyCodeSourcePayload 的"离开 zip 才清 applicationId"
  // 判据：必须记住**任务原本的**来源，而不是上一次渲染的 state（后者在
  // 重渲染/回填竞态下不可靠），故用 ref 固化加载期推导结果。
  const [codeSource, setCodeSource] = useState<CodeSource>('git');
  const previousCodeSourceRef = useRef<CodeSource>('git');

  /**
   * SEC-02 续（生产故障）：服务端已有凭据（读路径返回的掩码映射）。
   *
   * 刻意**不进表单值**，而是作为 SecretsEditor 的展示源：表单值表达的是"本次
   * 要写什么"，已有凭据由后端按逐键合并语义保留。若把掩码塞进表单值，一次
   * "只改超时"的保存就会把掩码当真实值写回去（真实凭据不可逆损毁）。
   */
  const [secretsExisting, setSecretsExisting] = useState<Record<string, string> | null>(null);

  /**
   * P0（UX-AUDIT-2026-09-21 §P0-1）：编辑态必须把已有 Glue 脚本回填给编辑器。
   *
   * GlueEditor 的 source 初值来自 props（`initialSource || ''`），而保存时
   * **无条件**用当前 state 覆盖服务端。调用方漏传 initialSource 就会形成不可逆
   * 损毁链：打开已有 glue 任务 → Monaco 空白（用户以为脚本没了）→ 顺手点一下
   * 语言下拉（onChange 里 setDirty(true)，保存按钮变可用）→ 一点保存，服务端
   * glueSource 被空串覆盖，且后端 updateGlue 还会把 codeSource 改成 glue、
   * gitRepo 置 null。
   *
   * 全仓 initialSource 只有两个调用点，TaskDetailPage 传了、本文件曾漏传——
   * 这是编辑任务的主入口，也是唯一漏点。语言同理：**不可**用 runtime 兜底
   * （javascript 的脚本会被回填成 python 高亮，一保存就把语言改写成 python）。
   */
  const [glueSource, setGlueSource] = useState<string | undefined>(undefined);
  const [glueLanguage, setGlueLanguage] = useState<string | undefined>(undefined);

  // FEAT-13：「保存为模板」弹窗（表单校验通过后把当前值固化为自定义模板）
  const [tplModalOpen, setTplModalOpen] = useState(false);
  const [tplSaving, setTplSaving] = useState(false);

  // python_task_multiversion：zip 来源的运行时一致性提示需要实时读取 runtime
  // （fleetOfflineWillFail 的离线层判定）；applicationId 走 useWatch 以便在
  // 提交前判定「zip 来源未选应用」（zipApplicationMissing）。二者都是无条件
  // hook 调用；分区渲染各自需要的字段订阅已随分区下沉（TaskFormBasicSection /
  // TaskFormTriggerSection 内 useWatch）。
  const runtimeWatch = Form.useWatch('runtime', form);
  const applicationIdWatch = Form.useWatch('applicationId', form);
  const { token } = theme.useToken();

  // python_task_multiversion：`?applicationId=` 创建态语义 = 以该应用整包为
  // 代码来源。表单回填与来源切换的触发时机由下方独立预填 effect 决定（BUGFIX：
  // 原在参照数据 effect 内、随语言切换重跑会冲掉用户已改的绑定）；codeSource
  // 是本页自持 state，经此回调同步；useCallback 固定引用保持稳定依赖。
  const handleApplicationIdParam = useCallback(() => {
    setCodeSource('application_zip');
    previousCodeSourceRef.current = 'application_zip';
  }, []);

  // 参照数据：分组/标签/执行器/应用/项目/依赖候选。`?applicationId=` 的表单
  // 回填在下方独立 effect（原在参照 hook 内，见 BUGFIX 注释）。
  const {
    groups, allTags, executors, apps, appsLoading, projectOptions, taskOptions, depNameSnapshotRef,
  } = useTaskFormReferenceData({ form });

  /**
   * BUGFIX（P1，commit 7d66a9b0 清单）：`?applicationId=`（应用详情页「用此
   * 应用建任务」入口）的表单回填。
   *
   * 原实现在参照数据加载 effect 内（依赖含 t），语言切换重拉参照数据时会把
   * form.setFieldValue('applicationId', appId) 一并重放——用户已改绑其他应用
   * 或清空绑定的修改被 URL 参数静默冲回。现拆为独立 effect，语义：
   *   - 首次挂载：命中即预填（编辑态只回填字段不切来源，创建态同时把代码
   *     来源切到 application_zip——handleApplicationIdParam 语义原样保留）；
   *   - 后续重跑（仅 appId 参数变化 / dirty 翻转会触发）：只在**创建态且表单
   *     未脏**时生效；表单已脏（用户已动过表单）一律忽略，原实现无「忽略时」
   *     的外显提示，维持无提示；
   *   - 同一 appId 只应用一次（appliedAppIdRef）：dirty 翻转引发的重跑不得
   *     重复回写（否则用户改绑后的每次置脏都会把值冲回去）。
   */
  const appliedAppIdRef = useRef<string | null>(null);
  const appIdFirstRunRef = useRef(true);
  useEffect(() => {
    const isFirstRun = appIdFirstRunRef.current;
    appIdFirstRunRef.current = false;
    if (!appId) return;
    if (appliedAppIdRef.current === appId) return;
    if (!isFirstRun && (isEdit || dirty)) return;
    appliedAppIdRef.current = appId;
    form.setFieldValue('applicationId', appId);
    if (!isEdit) {
      handleApplicationIdParam();
    }
  }, [appId, dirty, isEdit, form, handleApplicationIdParam]);

  // Load existing task data when in edit mode
  useEffect(() => {
    if (!editId) return;
    let active = true;
    const controller = new AbortController();
    setLoadingTask(true);
    tasksApi.get(editId, controller.signal)
      .then((task) => {
        if (!active || controller.signal.aborted) return;
        const mode = deriveExecutorMode(task);
        setExecutorMode(mode);
        setTriggerType(task.triggerType || 'manual');
        setSavedRuntime(task.runtime || 'python');
        // python_task_multiversion（FR-06/AC-06b/AC-17b）：编辑态回填自持 state。
        // runtimeVersion 存的是归一后的值（库内脏值/超区间值一律显示为"未声明"，
        // 不把非法值塞进组合框）；非法值不会因此丢失——它本就不该存在于库里，
        // 且提交侧 normalizeRuntimeVersion 会把它归 null。
        setRuntimeVersion(normalizeRuntimeVersion(task.runtimeVersion));
        const derivedSource = deriveCodeSourceFromTask(task);
        setCodeSource(derivedSource);
        previousCodeSourceRef.current = derivedSource;
        // SEC-02 续（生产故障）：已有凭据只作**展示源**（掩码映射），不进表单值。
        // 用户必须看得见既有键（否则会以为平台没生效而反复重配），但它的值永远
        // 回不来——保存时未重新输入的键由后端按合并语义保留。
        setSecretsExisting(
          task.secrets && Object.keys(task.secrets).length > 0
            ? (task.secrets as Record<string, string>)
            : null,
        );
        // P0-1：Glue 脚本与语言一并回填（编辑器保存时无条件覆盖服务端，
        // 漏回填 = 打开编辑页看到空白脚本，一保存即清空用户代码）。
        setGlueSource(task.glueSource ?? undefined);
        setGlueLanguage(task.glueLanguage ?? undefined);
        // 字段树回填载荷原样迁出至 task-form-edit-hydration.buildEditFormValues
        // （每个键的挂载/空态语义见该模块逐键注释）。
        form.setFieldsValue(buildEditFormValues(task));
        // A4（乐观锁）：记录读取时刻的版本戳，提交时回传 expectedUpdatedAt。
        setLoadedUpdatedAt(task.updatedAt ?? null);
        // NF-02: 上游依赖回填（映射 → Select 值 + 名称快照供提交重建映射）
        const dep = dependenciesFormValues(task.dependencies);
        form.setFieldValue('upstreamDependencies', dep.selected);
        depNameSnapshotRef.current = dep.nameSnapshot;
      })
      .catch(() => {
        if (active && !controller.signal.aborted) message.error(tRef.current('taskForm.load.taskFailed'));
      })
      .finally(() => {
        if (active && !controller.signal.aborted) { setLoadingTask(false); setDirty(false); }
      });

    return () => {
      active = false;
      controller.abort();
    };
    // BUGFIX（P1）：依赖以 editId（taskId）为键——t 已移出（原实现在列，语言
    // 切换会重跑本 effect：整表重回填 + setDirty(false) 冲掉未保存修改，任务
    // 也被重复拉取）。失败文案经 tRef 取当前语言，不构成依赖。
    // depNameSnapshotRef 来自 useTaskFormReferenceData（useRef，恒稳定）——
    // 列入依赖仅为 lint 自证，不构成额外触发源。
  }, [editId, form, depNameSnapshotRef]);

  // CORE-03：创建态带 ?templateId= 时拉取模板，config 预填表单（显式字段仍可改；
  // name 一律由用户填写——模板 name 常含中文，不满足任务名 [a-z0-9_-] 约束）。
  useEffect(() => {
    if (!templateId || isEdit) return;
    let cancelled = false;
    taskTemplatesApi
      .get(templateId)
      .then((tpl) => {
        if (cancelled) return;
        form.setFieldsValue(templateConfigToFormValues(tpl.config));
        if (tpl.description) form.setFieldValue('description', tpl.description);
        setTriggerType(templateTriggerAndRuntime(tpl).triggerType);
        setDirty(false);
        // python_task_multiversion（FR-06/FR-18）：`runtimeVersion` 与 `codeSource`
        // **不在表单字段树里**（前者由 RuntimeVersionField 自持 state，后者由来源
        // 选择器自持 state），因此 `setFieldsValue` 对它们无效——必须像编辑态回填
        // （见下方 tasksApi.get 分支）那样显式同步到 state，否则"从模板建任务"会
        // 显示成默认来源/git 且版本为空，用户看不出模板里其实钉了 3.7。
        //
        // runtimeVersion 走 normalizeRuntimeVersion：模板可能来自旧版本或手工编辑，
        // 脏值/超区间值一律显示为"未声明"而不是塞进组合框（与编辑态同一判据）。
        setRuntimeVersion(normalizeRuntimeVersion(tpl.config.runtimeVersion));
        const tplSource = deriveCodeSourceFromTask(tpl.config);
        setCodeSource(tplSource);
        previousCodeSourceRef.current = tplSource;
        // FIX-PREFILL-SYMMETRY：执行器模式与依赖名称快照同样不在表单字段树里
        // （executorMode 是组件 state；depNameSnapshotRef 供提交时重建依赖映射），
        // 必须显式同步——否则模板钉好的执行器策略提交时被 buildExecutorPayload
        // 按 auto 清掉、上游依赖映射的显示名 key 退化为 id（value=id 语义不丢）。
        setExecutorMode(templateExecutorMode(tpl.config));
        depNameSnapshotRef.current = templateDependencySnapshot(tpl.config);
      })
      .catch(() => message.warning(tRef.current('taskForm.load.templateFailed')));
    return () => {
      cancelled = true;
    };
    // BUGFIX（P1）：t 已移出依赖（同编辑回填 effect——语言切换重跑会整表重回填
    // 并 setDirty(false)，冲掉用户未保存的修改）；以 templateId 变化为键，
    // 失败文案经 tRef 取当前语言。
  }, [templateId, isEdit, form, depNameSnapshotRef]);

  // P0（UX-AUDIT-2026-09-21 §P0-5）：切换代码来源前的损失预告——判定与确认
  // 弹窗交互原样迁出至 useCodeSourceSwitchGuard（判据复用 applyCodeSourcePayload，
  // 与提交路径同源）。codeSource 的持有方与消费方（提交链路）仍在本页。
  const handleCodeSourceChange = useCodeSourceSwitchGuard(form, codeSource, setCodeSource);

  // F-04（DEEP_REVIEW @0ef3bbe）：AI 建议 Cron 应用——编辑态必须等任务回填
  // 完成后再覆盖 cronExpression，否则任务加载 effect 会用库内旧值盖掉建议值；
  // 创建态挂载即应用。cron 值不再二次校验（服务层 WIKI-OPT-3 已校验）。
  // 应用后立即清除 URL 参数（replace 导航，不新增历史记录），防止刷新后重复应用。
  useEffect(() => {
    if (!suggestCron) return;
    if (isEdit && loadingTask) return;
    form.setFieldValue('cronExpression', suggestCron);
    message.info(t('taskForm.suggestCronApplied', { cron: suggestCron }));
    const next = new URLSearchParams(searchParams);
    next.delete('suggestCron');
    setSearchParams(next, { replace: true });
  }, [suggestCron, isEdit, loadingTask, form, searchParams, setSearchParams, t]);

  // P0 (R8) 兜底保留为双保险：单页全挂载后 validateFields() 天然覆盖全部字段，
  // 以下 missing 收集逻辑在正常情况下永远为空集，仅作为防线存在。
  const handleSubmit = async () => {
    try {
      await form.validateFields();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) {
        // UI-12：antd 只在字段旁标红（读屏不主动播报），此处补一条可播报摘要。
        //
        // 但**只有**这条 aria-live 区域是不够的：它是 1×1px 的
        // screen-reader-only 元素（见下方 style），视力正常的用户提交失败后
        // 屏幕**毫无变化**——尤其当出错的字段在滚动视口之外时（本表单是单页
        // 多区块的长表单），用户会以为"按钮没反应"而反复点击。
        //
        // 故补两条可见反馈：一条浮层提示（与其它校验路径一致），以及滚到第一个
        // 出错字段。两者都不改判定逻辑，只是把已经发生的失败**显式呈现**出来。
        const fields = (err as { errorFields?: { errors?: string[]; name?: (string | number)[] }[] })
          .errorFields ?? [];
        const firstError = fields[0]?.errors?.[0];
        if (firstError) {
          setValidationAnnouncement(
            t('taskForm.validate.failed', {
              firstError,
              more: fields.length > 1 ? t('taskForm.validate.more', { count: fields.length }) : '',
            }),
          );
          message.error(
            t('taskForm.validate.failed', {
              firstError,
              more: fields.length > 1 ? t('taskForm.validate.more', { count: fields.length }) : '',
            }),
          );
          // 滚到第一个出错字段（antd 的 name 路径 → 该字段的 DOM 节点）。
          const namePath = fields[0]?.name;
          if (namePath && namePath.length > 0) {
            form.scrollToField(namePath, { behavior: 'smooth', block: 'center' });
          }
        } else {
          // 没有可读的字段级错误时也要给一条反馈，绝不静默 return。
          message.error(t('taskForm.validate.fail'));
        }
        return;
      }
      // UX-11（本轮体验审查）：此前手写 `err instanceof Error ? err.message : ...`。
      // 它比直接取 `e.message` 好，但仍绕过了全站归一：axios 错误的 `message`
      // 是 "Request failed with status code 400" 这类英文技术串，真正的业务
      // 原因在 `response.data.message` 里。getErrMsg 同时覆盖这两种形状，且
      // 本文件第 39 行本就导入了它（同页其它错误路径已在用）——同页两套文案
      // 才是问题所在。
      showApiError(err, t('taskForm.validate.fail'));
      return;
    }
    const values = form.getFieldsValue(true);
    const missing: { label: string; anchor: string }[] = [];
    if (!values.name) missing.push({ label: t('taskForm.field.name'), anchor: SECTION_IDS[0] });
    if (!values.runtime) missing.push({ label: t('taskForm.field.runtime'), anchor: SECTION_IDS[0] });
    if (!values.entrypoint) missing.push({ label: t('taskForm.field.entrypoint'), anchor: SECTION_IDS[0] });
    if (values.triggerType === 'cron' && !values.cronExpression) {
      missing.push({ label: t('taskForm.field.cron'), anchor: SECTION_IDS[1] });
    }
    if (values.triggerType === 'fixed_rate' && !values.fixedRate) {
      missing.push({ label: t('taskForm.field.fixedRate'), anchor: SECTION_IDS[1] });
    }
    if (executorMode === 'pinned' && !values.executorId) {
      missing.push({ label: t('taskForm.field.executorId'), anchor: SECTION_IDS[2] });
    }
    // python_task_multiversion（FR-18）：zip 来源必须关联应用。缺了它后端
    // assertCodeSourceConsistent 会 400，但那时用户只看到一条接口错误；
    // 在这里拦下并滚到字段旁，与其它必填项一致的体验。
    if (zipApplicationMissing) {
      missing.push({ label: t('taskForm.field.applicationId.zipRequired'), anchor: SECTION_IDS[0] });
    }
    if (missing.length > 0) {
      const missingList = missing.map((m) => m.label).join('、');
      message.error(t('taskForm.missing', { list: missingList }));
      // UI-12：同步播报到 role="status" 区域（视觉路径=浮层 + 锚点滚动）
      setValidationAnnouncement(t('taskForm.missingShort', { list: missingList }));
      scrollToSection(missing[0].anchor);
      return;
    }
    setValidationAnnouncement('');
    // cron UX 统一：裸 n/step 写法（如 `12/20 6-23 * * *`）在提交前做等价
    // 规范化（12/20 ≡ 12-59/20，POSIX n/step 展开语义严格一致；后端写边界
    // 是同一份规则 admin-api cron-normalize.util，此处前置只为把"实际存储
    // 形态"立刻告知用户——保存成功后 toast 通知，落库与回显均为规范式）。
    // 预览器本就按 POSIX 语义解析，规范前后触发时刻不变。
    let cronNormalizeNote: string | null = null;
    const canonicalizeInPlace = (raw: unknown): unknown => {
      if (typeof raw !== 'string' || !raw.trim()) return raw;
      const canonical = suggestCronStepRewrite(raw);
      if (!canonical) return raw;
      cronNormalizeNote = t('taskForm.field.cron.normalized', { suggestion: canonical });
      return canonical;
    };
    values.cronExpression = canonicalizeInPlace(values.cronExpression);
    if (Array.isArray(values.maintenanceWindows)) {
      for (const w of values.maintenanceWindows) {
        if (!w || typeof w !== 'object') continue;
        w.start = canonicalizeInPlace(w.start);
        w.end = canonicalizeInPlace(w.end);
      }
    }
    // G-2：离线层（3.7）+ 在线舰队无一台缓存 = 提交后必然 interpreter_unavailable。
    // 不阻断（服务端仍是权威，在线层本就"先下载后有"），但用 Modal.confirm 把
    // "提交即失败"显式化——避免用户忽略 warning 直接提交，到执行时才排障。
    if (fleetOfflineWillFail) {
      const go = await new Promise<boolean>((resolve) => {
        confirmModal.confirm({
          title: t('taskForm.submit.offlineFleetConfirm.title'),
          content: t('taskForm.submit.offlineFleetConfirm.content'),
          okText: t('taskForm.submit.offlineFleetConfirm.ok'),
          cancelText: t('taskForm.submit.offlineFleetConfirm.cancel'),
          okButtonProps: { danger: true },
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!go) return;
    }
    setSaving(true);
    try {
      // QA-01：applyDependenciesPayload 必须包在最外层——它把表单载体字段
      // upstreamDependencies（DTO 未声明，forbidNonWhitelisted 会判 400）转成
      // DTO 声明的 dependencies 映射并删除载体键，须保证没有任何后续步骤再把
      // 载体键带回请求体（内层 buildExecutorPayload 会整体展开 values）。
      //
      // python_task_multiversion：applyRuntimeVersionPayload / applyCodeSourcePayload
      // 紧贴 buildExecutorPayload（即仍是"最靠近表单原始值"的两层），原因：
      //  - 两者都按**表单原始值**判定——gitRepo/glueSource/applicationId 需原样
      //    读（缺失即视为"本表单未提供"），runtimeVersion 则不在字段树里（组合框
      //    自持 state），必须经第二参显式传入。往后放会让上游各步写入的显式 null
      //    被误读成用户输入，改变自证判定。
      // 顺序（内 → 外）：
      //   buildExecutorPayload（执行器策略基座，不动上述任一字段）
      //   → applyRuntimeVersionPayload（runtime!=='python' 时显式 null）
      //   → applyCodeSourcePayload（互斥三通道，不适用字段显式 null）
      //   → applyRequirementsPayload（依赖渠道，**必须**在来源归一之后——
      //     AC-18b 红线：切换代码来源不得清掉 requirements）
      //   → 维护窗口/超时/重试 → applyDependenciesPayload（载体键删除）
      //   → applySecretsPayload（SEC-02 续：掩码闸门，**最外层**——它只做减法，
      //     删掉"不该发出去"的 secrets 键/掩码叶子；放在最外层才能保证任何内层
      //     步骤都不会把它重新带回来。掩码一旦进请求体就是真实凭据被不可逆覆盖）
      const payload = applySecretsPayload(
        applyDependenciesPayload(
          applyRetryableErrorsPayload(
            applyTimeoutPolicyPayload(
              applyMaintenanceWindowsPayload(
                applyRequirementsPayload(
                  applyCodeSourcePayload(
                    applyRuntimeVersionPayload(
                      buildExecutorPayload(values, executorMode),
                      runtimeVersion,
                    ),
                    codeSource,
                    previousCodeSourceRef.current,
                  ),
                ),
              ),
            ),
          ),
          depNameSnapshotRef.current,
        ),
      );
      if (isEdit && editId) {
        // A4（乐观锁）：带读取时刻的 updatedAt 做并发检查——服务端发现行已被
        // 并发修改即 409（见下方 catch 的专门分支）。null = 未曾加载到版本戳
        // （老接口/加载失败），不带该字段 = 服务端跳过检查，保持向后兼容。
        await tasksApi.update(editId, {
          ...payload,
          expectedUpdatedAt: loadedUpdatedAt ?? undefined,
        } as Parameters<typeof tasksApi.update>[1]);
        // A4（第三轮审计）：失效任务/执行/metrics 面——30s staleTime 内跳转
        // 到详情/列表时不再渲染过期数据。
        await invalidateTaskData(queryClient);
        message.success(t('taskForm.submit.updated'));
        if (cronNormalizeNote) message.info(cronNormalizeNote);
        nav(`/tasks/${editId}`);
      } else {
        const created = await tasksApi.create(
          payload as components["schemas"]["CreateTaskDto"],
        );
        await invalidateTaskData(queryClient);
        message.success(t('taskForm.submit.created'));
        if (cronNormalizeNote) message.info(cronNormalizeNote);
        setSavedRuntime(
          typeof payload.runtime === 'string' ? payload.runtime : 'python',
        );
        setCreatedTaskId(created.id);
        setDirty(false);
        // 创建成功后滚到 Glue 区块（原 step3 语义：创建后进入 Glue 编排）。
        // BUGFIX（P3，commit 7d66a9b0 清单）：原 setTimeout(50) 是「赌渲染在
        // 50ms 内完成」的魔法延时——改为 rAF 两连等渲染提交 + 目标存在性轮询
        // （有界），见 utils/scroll-when-ready。
        scrollToSectionWhenReady(SECTION_IDS[4]);
      }
    } catch (err: unknown) {
      // A4（乐观锁冲突，409）：另一标签页/调用方已抢先修改同一任务——留在
      // 表单页**不跳转**，给出「刷新后重试」的专门指引（比通用失败文案更可
      // 操作：用户刷新表单即可拿到最新值再改）。状态码判定沿用 client.ts 的
      // `__status` 打标约定（拦截器 reject 的是 response.data，原始
      // response.status 已剥掉；旧路径兜底直传 axios error 的调用方）。
      const conflictStatus =
        err !== null && typeof err === 'object'
          ? ((err as Record<string, unknown>)['__status'] ??
            (err as { response?: { status?: unknown } })?.response?.status)
          : undefined;
      if (isEdit && conflictStatus === 409) {
        message.error(t('taskForm.submit.conflict'), 6);
        return;
      }
      // client.ts 的错误拦截器 reject 的是**普通对象**（err.response?.data || err），
      // 不是 Error 实例——`err instanceof Error` 对后端 400 恒 false，于是
      // assertCodeSourceConsistent / assertRuntimeVersionValid 返回的可操作
      // 文案被泛化的「创建失败」吞掉。getErrMsg 同时覆盖两种形状（与本文件
      // 模板保存等兄弟 catch 同策）。
      message.error(
        getErrMsg(
          err,
          isEdit ? t('taskForm.submit.updateFail') : t('taskForm.submit.createFail'),
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const scrollToSection = (id: string) => {
    // jsdom 无布局引擎，Element.scrollIntoView 未实现——守卫后调用，
    // 真浏览器生效；测试环境静默跳过（纯定位增强，无业务语义）。
    document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

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

  const glueTaskId = createdTaskId || (isEdit ? editId : null);

  /** zip 来源未选应用（后端会 400，此处前置到提交前拦截并给出可读文案） */
  const zipApplicationMissing = codeSource === 'application_zip' && !applicationIdWatch;

  /**
   * G-1：把后端版本契约注入 executor-mode 的可注入配置。
   *
   * 此前 min/max/onlineMin/legacyDefault 在前端硬编码，注释明言"改动需两侧同步"；
   * 而后端 min/max 支持 PYTHON_RUNTIME_VERSION_MIN/MAX env 覆盖，运维一改，前端
   * 的区间提示（RuntimeVersionField）与舰队能力咨询就静默漂移。这里在打开表单时
   * 拉一次权威值注入纯函数层——纯函数仍保持无 React 依赖、可单测（测试用
   * resetRuntimeVersionConfig() 复位）。
   *
   * 失败一律**静默**（旧后端无此端点 / 网络错误）：沿用前端默认常量，且异常在
   * 此消化、不冒泡到 axios 拦截器，旧后端上不会凭空弹「资源不存在」toast。
   * 注入后 bump revision：下列消费配置的 useMemo 与 RuntimeVersionField 的
   * render 期读取都是**读取时才取值**，需一次重渲染才能让新契约生效。
   */
  const [runtimeVersionRevision, setRuntimeVersionRevision] = useState(0);
  useEffect(() => {
    let active = true;
    configApi
      .getRuntimeVersion()
      .then((cfg) => {
        if (!active || !cfg) return;
        configureRuntimeVersionConfig({
          min: cfg.min,
          max: cfg.max,
          onlineMin: cfg.onlineMin,
          legacyDefaultInterpreter: cfg.legacyDefaultInterpreter,
        });
        setRuntimeVersionRevision((r) => r + 1);
      })
      .catch(() => {
        // 端点不可达 → 静默沿用前端默认常量（见上方注释）
      });
    return () => { active = false; };
  }, []);

  /**
   * python_task_multiversion（P2-4）：版本能力的**读面咨询**（非阻断）。
   *
   * 声明了 runtimeVersion 时，若当前在线舰队没有一台的缓存池满足它，给一条
   * warning——但**绝不阻止提交**：AC-06c「解释器先下载后有」，在线层（3.8+）
   * 执行时仍可按需下载；只有离线层（3.7）必须由部署方预填缓存卷。后端刻意
   * 不做舰队级写前预检（会把"先下载后有"退化成同步依赖），故这里只补读面信号。
   * 无在线执行器 / 列表未加载 → 'unknown'，不提示，避免误报。
   */
  const interpreterFleet = useMemo(
    () => interpreterFleetAdvisory(executors, runtimeVersion),
    // G-1：契约注入后需重算（内部 legacyDefault 兜底读的是可注入配置）
    [executors, runtimeVersion, runtimeVersionRevision],
  );

  /**
   * G-2：必失败情形——离线层（3.7，uv 无法在线下载）且在线舰队无一台缓存它。
   * 与单纯 `unsatisfied` 不同：在线层（3.8+）执行时可按需下载，warning 足够；
   * 但 3.7 离线层舰队无缓存时，提交后必然以 interpreter_unavailable 失败。
   * 这里不阻断（服务端仍是权威），但提交时弹二次确认，把"提交即失败"显式化。
   */
  const fleetOfflineWillFail = useMemo(
    () =>
      runtimeWatch === 'python' &&
      interpreterFleet === 'unsatisfied' &&
      runtimeVersionIsOfflineTier(runtimeVersion),
    // G-1：同上——离线层判定读的是可注入配置的 onlineMin
    [runtimeWatch, interpreterFleet, runtimeVersion, runtimeVersionRevision],
  );

  const anchorItems = useMemo(
    () => [
      { key: SECTION_IDS[0], href: `#${SECTION_IDS[0]}`, title: t('taskForm.section.basic') },
      { key: SECTION_IDS[1], href: `#${SECTION_IDS[1]}`, title: t('taskForm.section.trigger') },
      { key: SECTION_IDS[2], href: `#${SECTION_IDS[2]}`, title: t('taskForm.section.executor') },
      { key: SECTION_IDS[3], href: `#${SECTION_IDS[3]}`, title: t('taskForm.section.params') },
      ...(glueTaskId
        ? [{ key: SECTION_IDS[4], href: `#${SECTION_IDS[4]}`, title: t('taskForm.section.glue') }]
        : []),
    ],
    [glueTaskId, t],
  );

  if (loadingTask) {
    // UI-08：首屏骨架屏替代裸 Spin（仅此加载区块；表单结构不动）
    return <PageSkeleton variant="table" rows={6} style={{ padding: 24 }} />;
  }

  return (
    // FORM-WIDTH-01（修订）：内容列的 1080px 上限**当前生效**，见下方内容列
    // （`maxWidth: 1080`）与 `top: 88` 锚点条的说明。
    //
    // 该上限经历了一个来回，此处曾留下与实际代码相反的注释，特此记清楚：
    //   48e4909b 引入 1080 → 4e0206aa 因「宽屏右侧留白过大、与整宽页不一致」
    //   移除 → f84accc6 重新加回。加回的理由是移除后 1536px+ 视口下单行输入框
    //   被拉伸到近 1500px，可读性与扫视效率明显变差。
    // 因此这不是"忘了删的旧限制"，而是权衡后保留的现行设计；若要再次放开，
    // 应连同本注释与 FORM-WIDTH-01 一起改，避免第二处矛盾。
    <div>
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader，面包屑语义=任务→新建/编辑；
          原返回按钮保留于 extra 首位，行为不变） */}
      <PageHeader
        title={isEdit ? t('taskForm.title.edit') : t('taskForm.title.create')}
        breadcrumb={[
          { title: t('taskForm.breadcrumb.tasks'), to: '/tasks' },
          { title: isEdit ? t('taskForm.breadcrumb.edit') : t('taskForm.breadcrumb.new') },
        ]}
        extra={
          <Button icon={<ArrowLeftOutlined />} type="text" onClick={() => nav(-1)}>
            {t('taskForm.back')}
          </Button>
        }
      />

      {/* UI-06: 分区单页——Steps 四步改锚点导航。全部 Form.Item 同时挂载，
          消除「分步渲染卸载字段 → validateFields 只见当前步」的 P0 缺陷土壤
          （第八轮兜底保留为双保险，见 handleSubmit 注释）。 */}
      <div
        style={{
          display: 'flex',
          gap: 24,
          alignItems: 'flex-start',
        }}
      >
        {/* 页框架（REFACTOR-TASKFORM-11 原样迁出）：左侧锚点条（UI-06 具名
            navigation + G-4 断点显隐）与 UI-12 校验失败播报区（role="status"）。
            jsdom 无布局——测试只断言锚点渲染与点击可滚，不测监听。 */}
        <TaskFormNavRail
          anchorItems={anchorItems}
          announcement={validationAnnouncement}
        />

        {/* FORM-WIDTH-01：内容列限宽 1080px——此前输入框在 1536px+ 视口下全宽
            拉伸（单行输入近 1500px），可读性与扫视效率差。锚点条不受影响；
            Glue 编辑器在此宽度下同样可用。
            注：该上限曾被 4e0206aa 移除、f84accc6 加回（见页面顶部 return 处
            的完整沿革注释）；当前**保留**，改动前请同步那处说明。 */}
        <div style={{ flex: 1, minWidth: 0, maxWidth: 1080 }}>
          <Form
            form={form}
            layout="vertical"
            initialValues={{ triggerType: 'manual', runtime: 'python', timeout: 300, maxRetry: 3, retryDelay: 0, priority: 2, timeoutAction: 'kill', blockStrategy: 'serial' }}
            onValuesChange={(changed) => {
              if (changed.triggerType) setTriggerType(changed.triggerType);
              // P1-4：用户手改即标记未保存（antd setFieldsValue 程序化回填不触发本回调）。
              setDirty(true);
            }}
          >
            {/* 分区一：基本配置（原 step 0）——REFACTOR-TASKFORM-03 迁至
                TaskFormBasicSection（仍在 <Form> 上下文内，字段路径不变） */}
            <TaskFormBasicSection
              form={form}
              isEdit={isEdit}
              codeSource={codeSource}
              onCodeSourceChange={handleCodeSourceChange}
              runtimeVersion={runtimeVersion}
              onRuntimeVersionChange={setRuntimeVersion}
              apps={apps}
              appsLoading={appsLoading}
              projectOptions={projectOptions}
              interpreterFleet={interpreterFleet}
            />

            {/* 分区二：触发与告警（原 step 1 上半 + step 2 告警/runbook/参数）——
                REFACTOR-TASKFORM-04 迁至 TaskFormTriggerSection */}
            <TaskFormTriggerSection
              form={form}
              triggerType={triggerType}
              onOpenCronHelper={() => setShowCronHelper(true)}
            />

            {/* 分区三：执行器策略与超时重试（原 step 1 下半）——
                REFACTOR-TASKFORM-05 迁至 TaskFormExecutorSection */}
            <TaskFormExecutorSection
              executorMode={executorMode}
              onExecutorModeChange={setExecutorMode}
              executors={executors}
              groups={groups}
              allTags={allTags}
              taskOptions={taskOptions}
              editId={editId}
            />

            {/* 分区四：参数配置（原 step 2 上半）
                REFACTOR-TASKFORM-01：区块展示迁至 TaskFormParamsSection（仍在
                <Form> 上下文内，字段路径 params/secrets 不变） */}
            <TaskFormParamsSection secretsExisting={secretsExisting} />
          </Form>

          {/* 分区五：Glue 脚本（原 step 3——创建后才有 taskId，保持既有行为语义：
              创建态在提交成功前不渲染 GlueEditor；编辑态 taskId 已存在直接可编）
              REFACTOR-TASKFORM-02：区块展示迁至 TaskFormGlueSection */}
          <TaskFormGlueSection
            glueTaskId={glueTaskId}
            isEdit={isEdit}
            createdTaskId={createdTaskId}
            glueSource={glueSource}
            glueLanguage={glueLanguage}
            savedRuntime={savedRuntime}
            onGlueDirtyChange={setGlueDirty}
          />

          {/* 提交条：单页常驻（不再依附任一步骤），语义与原 step 2 提交按钮一致 */}
          <div
            data-testid="task-form-submit-bar"
            style={{
              position: 'sticky',
              bottom: 0,
              padding: '12px 0',
              background: token.colorBgLayout,
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex',
              justifyContent: 'flex-end',
              zIndex: 10,
            }}
          >
            <Space>
              {!isEdit && (
                <Button
                  icon={<SaveOutlined />}
                  data-testid="save-as-template"
                  onClick={openSaveAsTemplate}
                >
                  {t('taskForm.saveAsTemplate')}
                </Button>
              )}
              <Tooltip title={isAdmin ? undefined : t('taskList.adminOnly')}>
              <Button type="primary" onClick={handleSubmit} loading={saving} disabled={!isAdmin}
                icon={<ThunderboltOutlined />}>
                {isEdit ? t('taskForm.submit.saveChanges') : t('taskForm.submit.create')}
              </Button>
              </Tooltip>
            </Space>
          </div>
        </div>
      </div>

      <CronHelper
        open={showCronHelper}
        onClose={() => setShowCronHelper(false)}
        onSelect={(expr) => {
          form.setFieldValue('cronExpression', expr);
          setShowCronHelper(false);
        }}
      />

      {/* FEAT-13：保存为自定义模板弹窗——config 由 templateConfigFromFormValues
          白名单抽取（CreateTaskDto 子集，后端 forbidNonWhitelisted 校验），
          此处只填模板元信息（name/描述/分类）。
          REFACTOR-TASKFORM-06：Modal 本体迁至 TaskFormTemplateModal（tplForm 与
          元信息校验随之迁出；载荷组装/请求仍在本页）。 */}
      <TaskFormTemplateModal
        open={tplModalOpen}
        saving={tplSaving}
        onCancel={() => setTplModalOpen(false)}
        onConfirm={handleTemplateConfirm}
      />
      {/* P1-4：未保存守卫——用户在表单有改动时点页头返回/面包屑/浏览器关闭，拦截并二次确认。 */}
      <Modal
        open={navigationBlocker.state === 'blocked'}
        title={t('taskForm.unsaved.title')}
        okText={t('taskForm.unsaved.ok')}
        cancelText={t('taskForm.unsaved.cancel')}
        okButtonProps={{ danger: true }}
        onOk={() => navigationBlocker.proceed?.()}
        onCancel={() => navigationBlocker.reset?.()}
      >
        <Typography.Paragraph>{t('taskForm.unsaved.message')}</Typography.Paragraph>
      </Modal>
    </div>
  );
}
