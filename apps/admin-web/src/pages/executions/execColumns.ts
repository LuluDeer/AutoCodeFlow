/**
 * 执行记录列注册表 / 访问器映射 / 选项构造（纯数据，无 React 依赖）。
 *
 * 桌面端缺省全显；移动端卡片降级由既有 CSS 负责。注册表键 → 表格列访问器
 * （dataIndex / key）的映射集中在此，列定义与列宽仍在页面 columns 数组内维护。
 */
import type { ColumnRegistryItem } from '../../utils/columnPrefs';

export const EXEC_COLUMN_REGISTRY: ColumnRegistryItem[] = [
  { key: 'task', defaultHidden: false },
  { key: 'status', defaultHidden: false },
  { key: 'trigger', defaultHidden: false },
  { key: 'executor', defaultHidden: false },
  { key: 'startTime', defaultHidden: false },
  { key: 'duration', defaultHidden: false },
  { key: 'error', defaultHidden: false },
  { key: 'action', defaultHidden: false },
];

/** 注册表键 → 表格列访问器（dataIndex / key） */
export const EXEC_COLUMN_ACCESSOR: Record<string, string> = {
  task: 'taskName',
  status: 'status',
  trigger: 'triggerType',
  executor: 'executorAddress',
  startTime: 'startTime',
  duration: 'duration',
  error: 'errorMessage',
  action: 'action',
};

/** 列键 → i18n 键段（与页面表头 execs.col.* 对齐） */
const EXEC_COLUMN_I18N_SEGMENT: Record<string, string> = {
  task: 'task',
  status: 'status',
  trigger: 'trigger',
  executor: 'executor',
  startTime: 'startTime',
  duration: 'duration',
  error: 'error',
  action: 'action',
};

/** 构造列设置弹层选项（文案经 t() 解析；t 由调用方传入）。 */
export function execColumnOptions(t: (key: string) => string): Array<{ key: string; label: string }> {
  return EXEC_COLUMN_REGISTRY.map((r) => ({
    key: r.key,
    label: t(`execs.col.${EXEC_COLUMN_I18N_SEGMENT[r.key]}`),
  }));
}
