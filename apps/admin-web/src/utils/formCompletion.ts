/**
 * PLAN-FRONTEND-UX-IMPROVEMENTS §2.3「表单完成度指示」——口径层（纯函数，零 React）。
 *
 * ## 为什么分母不是「字段总数」
 *
 * TaskFormPage 现在有 30+ 个 Form.Item，但其中只有极少数是「不填就跑不起来」
 * 的：其余都有可用的缺省值（timeout 300 / maxRetry 3 / priority 普通 / 告警
 * 渠道空 / 亲和标签空…），缺省本身就是一份合法配置。用「已填字段数 ÷ 字段
 * 总数」算出来的百分比，会让一个只差任务名的表单显示 60%——数字好看，但
 * 没有任何行动价值，属本仓明确禁止的「语义虚假指标」。
 *
 * 因此本模块只统计**用户必须回答的问题**，判据是前端提交门（TaskFormPage
 * handleSubmit 的 missing 清单）+ 后端 CreateTaskDto 的必填面：
 *
 *   · name / runtime / entrypoint：两者都必填，缺了直接拦在提交前；
 *   · cronExpression / fixedRate：**仅当 triggerType 选中对应分支才存在**
 *     （TaskFormTriggerSection 条件渲染）——手动触发时这两项根本不渲染，
 *     计进分母会让「手动任务的表单永远只有 60%」；
 *   · executorId：仅 executorMode === 'pinned' 时要求；
 *   · applicationId：仅代码来源 = application_zip 时要求（FR-18，后端
 *     assertCodeSourceConsistent 会 400）。
 *
 * 条件性字段（appliesWhen 返回 false）**既不进分子也不进分母**——它们连
 * 控件都不在页面上，把它算成「未填」是纯粹的误报。
 *
 * ## 必填 vs 推荐
 *
 * 推荐项（recommended）缺失时该分区 `filled` 仍为 true，只把键放进
 * `recommendedMissing` 供 UI 做「可以再补充」的弱提示。两者绝不能混进
 * 同一个 percent：推荐项写得好不好，与任务能不能跑无关。
 *
 * ## 一处刻意的口径后果
 *
 * 分母随条件变化，所以把触发方式从「手动」切成「Cron」时百分比会**下降**
 * （分母从 3 变 4）。这不是 bug：Cron 表达式是真的必填，切换动作确实新增了
 * 一个必填项。宁可如实下降，也不要为了「数字只涨不跌」去隐藏新的必填项。
 *
 * ## 取键约定
 *
 * `requiredMissing` / `recommendedMissing` 里放的是**既有 i18n 键**（如
 * `taskForm.field.cron`），由调用方 `t(key)` 渲染。本模块因此不依赖 i18n，
 * 可以在纯 node 环境下单测。
 */

/** 表单值（antd Form 的 store 形状：顶层字段名 → 值）。 */
export type FormValues = Record<string, unknown>;

/** 单个受统计字段。 */
export interface CompletionFieldSpec {
  /** Form.Item 的 name（当前全部是顶层字段） */
  name: string;
  /** 缺失时回传的 i18n 键（本模块不做翻译，只给键） */
  missingKey: string;
  /**
   * 条件字段判定：返回 false 表示该字段在当前配置下**不存在于表单上**，
   * 既不进分子也不进分母。缺省 = 恒适用。
   */
  appliesWhen?: (values: FormValues) => boolean;
}

/** 一个分区的完成度定义。 */
export interface CompletionSectionSpec {
  /** 分区 id，与 TaskFormPage 的 SECTION_IDS 同源（sec-basic / sec-trigger / …） */
  id: string;
  /** 必填字段：缺失即该分区未完成（且计入整体 percent） */
  required: readonly CompletionFieldSpec[];
  /** 推荐字段：缺失只提示，不影响 filled / percent */
  recommended?: readonly CompletionFieldSpec[];
}

/** 单个分区的计算结果。 */
export interface CompletionSectionResult {
  id: string;
  /** 该分区**没有必填缺口**（推荐项缺失不影响本值） */
  filled: boolean;
  /** 必填缺口的 i18n 键（filled === false 时非空） */
  requiredMissing: string[];
  /** 推荐缺口的 i18n 键（仅提示用） */
  recommendedMissing: string[];
  /** 本分区实际适用的必填项数量（条件性字段已按当前值筛掉） */
  requiredTotal: number;
  /** 本分区已填的必填项数量 */
  requiredFilled: number;
}

/** 整表计算结果。 */
export interface FormCompletionResult {
  /** 0–100 的整数；只由**必填项**决定 */
  percent: number;
  /** 与输入 spec 同序、同长度 */
  sections: CompletionSectionResult[];
}

/** 读一个值的字符串形态（非字符串一律算空串），供条件判定用。 */
function str(values: FormValues, name: string): string {
  const raw = values[name];
  return typeof raw === 'string' ? raw : '';
}

/**
 * 「这个字段算填了吗」。
 *
 * 三处容易写错、且都会造成虚假进度的地方：
 *  ① `0` 与 `false` 是**真实取值**（timeout=0 表示不限时、maxRetry=0 表示
 *     不重试），不能被 falsy 判成空；
 *  ② 空数组 / 空对象在 UI 上与 undefined 完全不可区分（多选框一个没选、
 *     依赖映射一条没加），算成「已填」会让进度虚高；
 *  ③ 纯空白串不算填（与后端 IsNotEmpty / 名称校验的 trim 语义一致）。
 */
export function isFieldFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/**
 * 计算整表完成度。
 *
 * @param values 当前表单值（**必须包含**条件判定要读的键：triggerType 来自
 *   字段树；codeSource / executorMode 是页面自持 state，调用方需并入）
 * @param specs  分区定义；默认使用任务表单的实际口径
 */
export function computeFormCompletion(
  values: FormValues | null | undefined,
  specs: readonly CompletionSectionSpec[] = TASK_FORM_COMPLETION,
): FormCompletionResult {
  const source: FormValues = values ?? {};

  const sections: CompletionSectionResult[] = specs.map((spec) => {
    const applicable = spec.required.filter((field) => field.appliesWhen?.(source) ?? true);
    const missing = applicable.filter((field) => !isFieldFilled(source[field.name]));
    const recommendedMissing = (spec.recommended ?? []).filter(
      (field) => (field.appliesWhen?.(source) ?? true) && !isFieldFilled(source[field.name]),
    );
    return {
      id: spec.id,
      filled: missing.length === 0,
      requiredMissing: missing.map((field) => field.missingKey),
      recommendedMissing: recommendedMissing.map((field) => field.missingKey),
      requiredTotal: applicable.length,
      requiredFilled: applicable.length - missing.length,
    };
  });

  // 分母 = 各分区**实际适用**的必填项之和（条件性字段已筛掉）。
  const requiredTotal = sections.reduce((sum, section) => sum + section.requiredTotal, 0);
  const requiredFilled = sections.reduce((sum, section) => sum + section.requiredFilled, 0);
  // 分母为 0 时给 0 而不是 100：一份没有任何必填项的表单，说「已完成 100%」
  // 是替用户做了一个我们并不知道的断言。
  const percent =
    requiredTotal === 0 ? 0 : Math.round((requiredFilled / requiredTotal) * 100);

  return { percent, sections };
}

/**
 * 任务表单的完成度口径（与 TaskFormPage 的五个分区一一对应）。
 *
 * sec-params / sec-glue 没有必填项：参数、凭据、Glue 脚本都是可选的
 * （glue 分区在创建态甚至尚未可编辑），故 required 为空、也不设推荐项——
 * 没有消费方的推荐项只会变成第二套没人维护的清单。
 */
export const TASK_FORM_COMPLETION: readonly CompletionSectionSpec[] = [
  {
    id: 'sec-basic',
    required: [
      { name: 'name', missingKey: 'taskForm.field.name' },
      { name: 'runtime', missingKey: 'taskForm.field.runtime' },
      { name: 'entrypoint', missingKey: 'taskForm.field.entrypoint' },
      // python_task_multiversion（FR-18）：zip 来源必须关联应用，缺了后端
      // assertCodeSourceConsistent 直接 400。其它来源下该控件不渲染。
      {
        name: 'applicationId',
        missingKey: 'taskForm.field.applicationId.zipRequired',
        appliesWhen: (values) => str(values, 'codeSource') === 'application_zip',
      },
    ],
    recommended: [{ name: 'description', missingKey: 'taskForm.field.description.optional' }],
  },
  {
    id: 'sec-trigger',
    required: [
      {
        name: 'cronExpression',
        missingKey: 'taskForm.field.cron',
        appliesWhen: (values) => str(values, 'triggerType') === 'cron',
      },
      {
        name: 'fixedRate',
        missingKey: 'taskForm.field.fixedRate',
        appliesWhen: (values) => str(values, 'triggerType') === 'fixed_rate',
      },
    ],
    recommended: [{ name: 'runbook', missingKey: 'taskForm.runbook.label' }],
  },
  {
    id: 'sec-executor',
    required: [
      {
        name: 'executorId',
        missingKey: 'taskForm.field.executorId',
        appliesWhen: (values) => str(values, 'executorMode') === 'pinned',
      },
    ],
  },
  // 参数与凭据、Glue 脚本均为可选——没有必填项，也就没有状态可言。
  { id: 'sec-params', required: [] },
  { id: 'sec-glue', required: [] },
];
