/**
 * Agent 权限生效矩阵解析 + 表单错误输入框属性辅助（纯函数，无 Electron 依赖）。
 *
 * 预设默认与实现约束与主进程 `main/agent/permission-profile.ts` 保持一致：
 * - 已实现预设：minimal / standard（其余未实现预设回落 minimal）；
 * - 细粒度覆盖留空或命中未实现档位时，回落该预设的对应轴默认值。
 */

export type AgentMatrixAxis = 'codeExecution' | 'hostAccess' | 'taskExecution';

const PRESET_DEFAULTS: Record<'minimal' | 'standard', Record<AgentMatrixAxis, string>> = {
  minimal: { codeExecution: 'off', hostAccess: 'none', taskExecution: 'deploy-only' },
  standard: { codeExecution: 'sandbox', hostAccess: 'none', taskExecution: 'deploy-only' },
};

const IMPLEMENTED_VALUES: Record<AgentMatrixAxis, readonly string[]> = {
  codeExecution: ['off', 'sandbox'],
  hostAccess: ['none', 'app-scoped'],
  taskExecution: ['deploy-only', 'isolated-runner'],
};

/** 归一化预设名：与主进程 resolveLocalPermissions 同口径（未实现或非法一律回落 minimal）。 */
export function resolveEffectivePreset(presetRaw: unknown): 'minimal' | 'standard' {
  const normalized = typeof presetRaw === 'string' ? presetRaw.trim().toLowerCase() : '';
  return normalized === 'standard' ? 'standard' : 'minimal';
}

/** 解析单个细粒度轴的实际生效值，并标记是否继承自预设。 */
export function resolveAgentAxis(
  presetRaw: unknown,
  overrideRaw: unknown,
  axis: AgentMatrixAxis,
): { value: string; inherited: boolean } {
  const preset = resolveEffectivePreset(presetRaw);
  const fallback = PRESET_DEFAULTS[preset][axis];
  const raw = typeof overrideRaw === 'string' ? overrideRaw.trim().toLowerCase() : '';
  if (raw === '') return { value: fallback, inherited: true };
  if (IMPLEMENTED_VALUES[axis].includes(raw)) return { value: raw, inherited: false };
  return { value: fallback, inherited: false };
}

/** 根据字段错误映射返回输入框错误态类名与 ARIA 属性。 */
export function fieldErrorProps(
  errors: Record<string, string>,
  key: string,
  baseClass = 'input',
): {
  className: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
} {
  if (!errors[key]) return { className: baseClass };
  return {
    className: `${baseClass} error`,
    'aria-invalid': true,
    'aria-describedby': `cfgx-err-${key}`,
  };
}
