/**
 * R7 刀 3（提交载荷 · H2 = 段 E + 段 G）：`submitTaskForm` 里「cron 规范化 +
 * payload 组装」两步从 `TaskFormPage.tsx` 原样迁出为一个独立 hook（纯搬移 /
 * 零行为变更）。段 E = 原 L669-684，段 G = 原 L725-745。
 *
 * ## 为什么是这两段、且必须**同批**
 *
 * 段 G 是九段里唯一分支密度 0、零 IO、零时序的一段（读 5 个量、调 8 层
 * `apply*Payload`、返回一个对象）。但它读的 `values` **不是普通对象**：
 * 它是 `form.getFieldsValue(true)` 的返回值，也就是 **antd 的活 store 本体**。
 *
 * 实测依据（`@rc-component/form/lib/hooks/useForm.js`）：
 *
 * ```js
 * getFieldsValue = (nameList, filterFunc) => {
 *   if (mergedNameList === true && !mergedFilterFunc) { return this.store; }  // ← 本体，不克隆
 * ```
 *
 * 而段 E `values.cronExpression = canonicalizeInPlace(...)` 与
 * `w.start = ... / w.end = ...` 是**对同一引用的原地改写**。于是「E 写、G 读」
 * 是**同一块内存上的读后写**：
 *   · 若只把 G 搬走、E 留在页面 ⇒ 同一引用的读写分属两个 owner（盘点报告点名的
 *     「搬了一半」中间态）；
 *   · 若把 E/G 拆成两个 hook 各取一次 `getFieldsValue(true)` ⇒ 二次取值拿到的是
 *     另一次快照语义，E 的改写可能不落在 G 读的对象上。
 * ⇒ 两段必须落在**同一个模块**里，并且本模块**自己绝不取 store**：`values`
 * 一律由调用方按引用传入。这是本文件的第一条硬约束。
 *
 * ## 硬约束（搬动不得破坏）
 *
 * 1. **不重新取值**：本 hook 不 import `FormInstance`、不调
 *    `form.getFieldsValue` / `setFieldsValue`。`normalizeCronInPlace(values)` 与
 *    `buildSubmissionPayload(values)` 收到的必须是**同一个对象引用**（即页面从
 *    `runPreSubmitGates()` 的 `gate.values` 拿到的那个活 store 本体，见
 *    `useTaskFormValidation` 头注释「放行时必须把 values 交出去」）。
 *    传引用而不是值，是 E 的原地改写能被 G 看见的**唯一**前提。
 * 2. **调用顺序不可换**：`normalizeCronInPlace` 必须在 `buildSubmissionPayload`
 *    之前（后者读的就是前者改后的 cron）。页面把它们留在**原来的两个调用点**
 *    （E 在 G-2 离线舰队二次确认之前，G 在 `setSaving(true)` 的 try 之内），
 *    因此副作用次序与异常路径（payload 构建抛错仍落到提交失败的 catch）都与
 *    搬移前逐字一致。
 * 3. **8 层 `apply*Payload` 的嵌套顺序不可换**（内 → 外）：
 *    `buildExecutorPayload` → `applyRuntimeVersionPayload` → `applyCodeSourcePayload`
 *    → `applyRequirementsPayload` → 维护窗口/超时/重试 → `applyDependenciesPayload`
 *    → `applySecretsPayload`（最外层，只做减法）。逐层理由见各步原注释。
 * 4. 这些 `apply*` **全部是纯函数**（各自 `{ ...values }` 浅拷贝后再改写，
 *    实测见 executor-mode.ts 各函数首行），只有段 E 会写活 store。
 *
 * ## 两个 ref 的**身份**语义（不是值语义）
 *
 * `previousCodeSourceRef`（页面 `useRef<CodeSource>`）与 `depNameSnapshotRef`
 * （`useTaskFormReferenceData` 产出的 `useRef<Record<string,string>>`）按
 * **ref 对象**传入，而不是 `xxxRef.current` 的值：
 *
 *   · ref 对象在一次挂载内**恒等**（`useRef` 只在首渲染创建），所以本 hook 的入参
 *     不会因 render 抖动；`.current` 在**函数调用时**（点提交那一刻）才读。
 *   · 若改成传 `.current` 的值，则是「调用方那次 render 的**快照**」。而
 *     `depNameSnapshotRef.current` 会被 `useTaskFormReferenceData` 的数据回报
 *     （`depNameSnapshotRef.current[id] = name`）与编辑态回填（L475）**直接改写，
 *     不必然伴随一次渲染** ⇒ 传值会拿到旧快照（显示名回落成裸 taskId、或
 *     「离开 zip 才清 applicationId」判定用错来源）。
 *   · 实测：hook 渲染后把 `previousCodeSourceRef.current` 改成 `'application_zip'`，
 *     再调用 `buildSubmissionPayload` ⇒ 载荷里 `applicationId` 被置 null（走的是
 *     `leavingZip` 分支），证明读的是**调用时刻**的 `.current`，不是渲染时刻的。
 *
 * ## 身份稳定性
 *
 * 两个函数都是**事件处理器链路**里的同步函数（点提交才调用），页面在
 * `submitTaskForm` 内部现调，不进任何 effect 依赖数组 ⇒ 无需 `useCallback`
 * 固定身份。每次渲染重建只捕获当次渲染的 state 与 ref 对象，闭包新鲜度与
 * 搬移前的 `submitTaskForm` 相同。
 *
 * ## 刻意**不**搬的部分
 *
 * - 段 F（G-2 离线舰队二次确认）：依赖页面 memo `fleetOfflineWillFail` 与命令式
 *   `confirmModal`，是 UI 交互不是载荷逻辑。
 * - 段 H（调 API + 成功跳转，16 个页面量）、段 I（错误映射，密度 68.2 含 409
 *   乐观锁分支）：依赖面最宽、密度最高，风险远大于收益，留给后续单独一刀。
 */
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildExecutorPayload,
  applyRequirementsPayload,
  applyRuntimeVersionPayload,
  applyCodeSourcePayload,
  applySecretsPayload,
  type CodeSource,
  type ExecutorMode,
} from '../executor-mode';
import { applyMaintenanceWindowsPayload } from '../maintenance-windows';
import { applyTimeoutPolicyPayload } from '../timeout-policy';
import { applyRetryableErrorsPayload } from '../retry-policy';
import { applyDependenciesPayload } from '../task-dependencies';
import { suggestCronStepRewrite } from '../../utils/trigger-preview';
import type { TaskFormGateValues } from './useTaskFormValidation';
import '../../i18n';

/** 入参：提交载荷只读这些（**不取表单 store**，`values` 由调用方按引用传入）。 */
export interface UseTaskFormPayloadOptions {
  /** 执行器策略（自持 state，不在字段树里）：`buildExecutorPayload` 的基座参数 */
  executorMode: ExecutorMode;
  /** 声明的 Python 版本（自持 state）：`applyRuntimeVersionPayload` 的第二参 */
  runtimeVersion: string | null;
  /** 当前代码来源（自持 state）：`applyCodeSourcePayload` 的第二参 */
  codeSource: CodeSource;
  /** 任务原本的代码来源——**ref 对象**，调用时读 `.current`（见头注释） */
  previousCodeSourceRef: RefObject<CodeSource>;
  /** 依赖 id → 任务名快照——**ref 对象**，调用时读 `.current`（见头注释） */
  depNameSnapshotRef: RefObject<Record<string, string>>;
}

/** 组装后的提交载荷（`apply*` 链产出；调用点按 DTO 断言，见搬移前的原注释）。 */
export type SubmissionPayload = Record<string, unknown>;

/** 返回值：两个同步函数（页面在原调用点现调，顺序不可换）。 */
export interface TaskFormPayloadController {
  /**
   * 段 E：cron / 维护窗口的裸 `n/step` 写法就地规范化。
   * **原地改写传入的活 store**，返回「规范化已发生」时给用户的那句话（否则 null）。
   */
  normalizeCronInPlace: (values: TaskFormGateValues) => string | null;
  /** 段 G：8 层 `apply*Payload` 组装出提交载荷（纯函数，不写 store）。 */
  buildSubmissionPayload: (values: TaskFormGateValues) => SubmissionPayload;
}

export function useTaskFormPayload({
  executorMode,
  runtimeVersion,
  codeSource,
  previousCodeSourceRef,
  depNameSnapshotRef,
}: UseTaskFormPayloadOptions): TaskFormPayloadController {
  const { t } = useTranslation();

  /**
   * 段 E（原 L669-684）：cron UX 统一——裸 n/step 写法（如 `12/20 6-23 * * *`）
   * 在提交前做等价规范化（12/20 ≡ 12-59/20，POSIX n/step 展开语义严格一致；
   * 后端写边界是同一份规则 admin-api cron-normalize.util，此处前置只为把"实际
   * 存储形态"立刻告知用户——保存成功后 toast 通知，落库与回显均为规范式）。
   * 预览器本就按 POSIX 语义解析，规范前后触发时刻不变。
   *
   * ⚠️ `values` 是 antd 活 store 本体，下面的赋值是**原地写**（头注释约束 1）；
   * 维护窗口 `w.start/w.end` 同样是活 store 里嵌套对象的原地写。
   */
  const normalizeCronInPlace = (values: TaskFormGateValues): string | null => {
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
    return cronNormalizeNote;
  };

  /**
   * 段 G（原 L704-745）：payload 组装。
   *
   * QA-01：applyDependenciesPayload 必须包在最外层——它把表单载体字段
   * upstreamDependencies（DTO 未声明，forbidNonWhitelisted 会判 400）转成
   * DTO 声明的 dependencies 映射并删除载体键，须保证没有任何后续步骤再把
   * 载体键带回请求体（内层 buildExecutorPayload 会整体展开 values）。
   *
   * python_task_multiversion：applyRuntimeVersionPayload / applyCodeSourcePayload
   * 紧贴 buildExecutorPayload（即仍是"最靠近表单原始值"的两层），原因：
   *  - 两者都按**表单原始值**判定——gitRepo/glueSource/applicationId 需原样
   *    读（缺失即视为"本表单未提供"），runtimeVersion 则不在字段树里（组合框
   *    自持 state），必须经第二参显式传入。往后放会让上游各步写入的显式 null
   *    被误读成用户输入，改变自证判定。
   * 顺序（内 → 外）：
   *   buildExecutorPayload（执行器策略基座，不动上述任一字段）
   *   → applyRuntimeVersionPayload（runtime!=='python' 时显式 null）
   *   → applyCodeSourcePayload（互斥三通道，不适用字段显式 null）
   *   → applyRequirementsPayload（依赖渠道，**必须**在来源归一之后——
   *     AC-18b 红线：切换代码来源不得清掉 requirements）
   *   → 维护窗口/超时/重试 → applyDependenciesPayload（载体键删除）
   *   → applySecretsPayload（SEC-02 续：掩码闸门，**最外层**——它只做减法，
   *     删掉"不该发出去"的 secrets 键/掩码叶子；放在最外层才能保证任何内层
   *     步骤都不会把它重新带回来。掩码一旦进请求体就是真实凭据被不可逆覆盖）
   */
  const buildSubmissionPayload = (values: TaskFormGateValues): SubmissionPayload =>
    applySecretsPayload(
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

  return { normalizeCronInPlace, buildSubmissionPayload };
}
