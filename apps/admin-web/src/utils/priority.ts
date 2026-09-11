/**
 * CORE-01: 任务优先级的双形态契约。
 *
 * admin-api 的不对称形态：DTO @IsEnum(TaskPriority) 接受**数字** 1-4，
 * 而 PG enum 列读回的是 **label 字符串**（'low'..'critical'，N2）。
 * 表单提交用数字，展示层两种形态都要能映射——统一在这里收敛。
 */

export interface PriorityOption {
  value: number;
  label: string;
  color: string;
}

export const TASK_PRIORITY_OPTIONS: PriorityOption[] = [
  { value: 1, label: '低', color: 'default' },
  { value: 2, label: '普通', color: 'blue' },
  { value: 3, label: '高', color: 'orange' },
  { value: 4, label: '紧急', color: 'red' },
];

const LABEL_TO_VALUE: Record<string, number> = {
  low: 1,
  normal: 2,
  high: 3,
  critical: 4,
};

/** 任意读回形态（label 字符串 / 数字 / 整数字符串 / 非法值）→ 表单数字 */
export function toPriorityValue(v: string | number | null | undefined): number {
  if (typeof v === 'number' && v >= 1 && v <= 4) return v;
  if (typeof v === 'string') {
    const byLabel = LABEL_TO_VALUE[v.toLowerCase()];
    if (byLabel != null) return byLabel;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 4) return n;
  }
  return 2; // 与后端 normalizeTaskPriority 的回退一致（NORMAL）
}

/** 列表/详情展示用：Tag 文案 + antd color。t 可选：传参时 label 走 i18n key，
 *  缺省保持中文基线（priority.test.ts 锚定 '低'/'普通'/'高'/'紧急'）。 */
export function priorityTag(
  v: string | number | null | undefined,
  t?: (k: string) => string,
): { label: string; color: string } {
  const value = toPriorityValue(v);
  const opt = TASK_PRIORITY_OPTIONS.find((o) => o.value === value)!;
  if (!t) return { label: opt.label, color: opt.color };
  return { label: t(PRIORITY_T_KEY[value]), color: opt.color };
}

const PRIORITY_T_KEY: Record<number, string> = {
  1: 'priority.low',
  2: 'priority.normal',
  3: 'priority.high',
  4: 'priority.critical',
};
