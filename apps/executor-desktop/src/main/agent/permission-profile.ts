/**
 * P7a（agent-and-deployment）：执行器 Agent 权限档位（设计文档 09）。
 *
 * ## 为什么独立成纯函数模块
 * 与 config-sanitize.ts 同款理由：ipc-handlers/config-store 顶层 import
 * electron，裸 node 加载即崩、长期没有回归闸。本模块只依赖语言本身，
 * 可在 `npm run test:main` 直接断言——而它恰恰是最需要测试的部分：
 * 档位是 ADR-022 信任模型的核心，一个拼错的档位名静默落盘 = 行为回落到
 * 未定义状态。
 *
 * ## 档位语义（09 §2/§3，ADR-022）
 * 四个轴：codeExecution / sandboxBackend / hostAccess / taskExecution。
 * 预设五档；**P7a 只实现 minimal + standard**——developer/ops-assist/full-trust
 * 是登记在案的保留名，解析时**显式拒绝**（「尚未实现」而不是静默降级），
 * 后续阶段放开时只需扩 IMPLEMENTED_PRESETS。
 *
 * ## 两条硬纪律
 * 1. **默认最保守**：解析失败的输入一律回落 `minimal`（什么都不允许），
 *    绝不回落到更高档。
 * 2. **企业管控**：`最终档位 = min(本地配置, 中台上限)`（09 §4.2）。
 *    合并是**逐轴取更保守者**——中台只能往下压，不能往上看。
 */

/** 代码执行档位：off（只产出文本）/ sandbox（受限 workspace 试跑）/ host（本机运行）。 */
export const CODE_EXECUTION_MODES = ['off', 'sandbox', 'host'] as const;
export type CodeExecutionMode = (typeof CODE_EXECUTION_MODES)[number];

/** 沙箱后端。P7a 只实现 none/process；container/vm 是登记在案的保留值。 */
export const SANDBOX_BACKEND_MODES = ['none', 'process', 'container', 'vm'] as const;
export type SandboxBackendMode = (typeof SANDBOX_BACKEND_MODES)[number];

/** 本机登录态访问档位。P7c 开放 app-scoped；session 仍不实现。 */
export const HOST_ACCESS_MODES = ['none', 'app-scoped', 'session'] as const;
export type HostAccessMode = (typeof HOST_ACCESS_MODES)[number];

/** 任务执行方式。isolated-runner P7e 前半实现；shared-runner **故意不提供**（08 §2.4）。 */
export const TASK_EXECUTION_MODES = ['deploy-only', 'isolated-runner'] as const;
export type TaskExecutionMode = (typeof TASK_EXECUTION_MODES)[number];

/** 预设名（09 §3）。 */
export const AGENT_PRESETS = [
  'minimal',
  'standard',
  'developer',
  'ops-assist',
  'full-trust',
] as const;
export type AgentPreset = (typeof AGENT_PRESETS)[number];

interface AxisSpec<K extends string> {
  /** 轴的严重度排序：下标越小越保守（min 合并的基础）。 */
  rank: readonly K[];
  /** P7a 实际实现的档位（未实现的档位即使输入合法也拒绝/钳回）。 */
  implemented: readonly K[];
}

const CODE_EXECUTION_SPEC: AxisSpec<CodeExecutionMode> = {
  rank: ['off', 'sandbox', 'host'],
  implemented: ['off', 'sandbox'],
};
const SANDBOX_BACKEND_SPEC: AxisSpec<SandboxBackendMode> = {
  rank: ['none', 'process', 'container', 'vm'],
  implemented: ['none', 'process'],
};
const HOST_ACCESS_SPEC: AxisSpec<HostAccessMode> = {
  rank: ['none', 'app-scoped', 'session'],
  implemented: ['none', 'app-scoped'],
};
const TASK_EXECUTION_SPEC: AxisSpec<TaskExecutionMode> = {
  rank: ['deploy-only', 'isolated-runner'],
  // P7e 前半放开 isolated-runner（desktop 本地独立执行端点，08 §2.4 方案 A）
  implemented: ['deploy-only', 'isolated-runner'],
};

/** P7a 实现的预设（09 §6 分阶段实现表）。 */
export const IMPLEMENTED_PRESETS: readonly AgentPreset[] = ['minimal', 'standard'];

/** 预设定义（09 §3 组合矩阵）。 */
export const PRESET_DEFINITIONS: Record<
  AgentPreset,
  {
    codeExecution: CodeExecutionMode;
    sandboxBackend: SandboxBackendMode;
    hostAccess: HostAccessMode;
    taskExecution: TaskExecutionMode;
  }
> = {
  minimal: { codeExecution: 'off', sandboxBackend: 'none', hostAccess: 'none', taskExecution: 'deploy-only' },
  standard: { codeExecution: 'sandbox', sandboxBackend: 'process', hostAccess: 'none', taskExecution: 'deploy-only' },
  developer: { codeExecution: 'sandbox', sandboxBackend: 'container', hostAccess: 'app-scoped', taskExecution: 'isolated-runner' },
  'ops-assist': { codeExecution: 'host', sandboxBackend: 'process', hostAccess: 'app-scoped', taskExecution: 'isolated-runner' },
  'full-trust': { codeExecution: 'host', sandboxBackend: 'process', hostAccess: 'session', taskExecution: 'isolated-runner' },
};

/** 生效档位（归一化产物）。 */
export interface EffectiveAgentPermissions {
  preset: AgentPreset | 'custom';
  codeExecution: CodeExecutionMode;
  sandboxBackend: SandboxBackendMode;
  hostAccess: HostAccessMode;
  taskExecution: TaskExecutionMode;
  /** hostAccess=app-scoped 时的应用白名单。 */
  allowedApps: string[];
  allowedDomains: string[];
  /** 每个轴的最终值来自本地还是中台（审计用：中台下调要留痕）。 */
  source: {
    preset: 'local' | 'center-clamped';
    codeExecution: 'local' | 'center-clamped';
    sandboxBackend: 'local' | 'center-clamped';
    hostAccess: 'local' | 'center-clamped';
    taskExecution: 'local' | 'center-clamped';
  };
}

/** 本地（客户端）Agent 配置输入——形状宽松，解析时逐字段消毒。 */
export interface LocalAgentConfigInput {
  preset?: unknown;
  codeExecution?: unknown;
  sandboxBackend?: unknown;
  hostAccess?: unknown;
  taskExecution?: unknown;
  allowedApps?: unknown;
  allowedDomains?: unknown;
}

/** 中台随 poll 下发的策略上限（agent-collab poll 响应的 sopPolicy）。 */
export interface CenterPolicyInput {
  permissionPolicy?: unknown;
  allowedProfiles?: unknown;
}

function pickAxis<K extends string>(
  value: unknown,
  spec: AxisSpec<K>,
  fallback: K,
): K {
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase() as K;
  if (!spec.rank.includes(v)) return fallback;
  // 未实现的档位一律钳回最保守的已实现档（防"配置成功但行为未定义"）
  return spec.implemented.includes(v) ? v : fallback;
}

function pickStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .map((s) => s.trim().toLowerCase())
    .slice(0, max);
}

/** app-scoped 仅接受进程名，不接受路径、通配符或命令。 */
export function normalizeAllowedApp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  const name = trimmed.endsWith('.exe') ? trimmed.slice(0, -4) : trimmed;
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? name : null;
}

function pickAllowedApps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeAllowedApp).filter((v): v is string => v !== null))].slice(0, 32);
}

function clampToImplemented<K extends string>(v: K, spec: AxisSpec<K>, fallback: K): K {
  return spec.implemented.includes(v) ? v : fallback;
}

/**
 * 解析本地配置为生效档位。
 *
 * 规则（全部 fail-safe 到最保守）：
 *   · preset 非法 / 未实现 → minimal；
 *   · 细粒度覆盖非法 → 该轴回落预设值；覆盖轴若指向**未实现**档 → 钳回该轴
 *     最保守的已实现档；
 *   · minimal 的 codeExecution=off 时 sandboxBackend 恒 none（off 沙箱无意义）。
 */
export function resolveLocalPermissions(
  input: LocalAgentConfigInput | null | undefined,
): EffectiveAgentPermissions {
  const rawPreset =
    typeof input?.preset === 'string' && (AGENT_PRESETS as readonly string[]).includes(input.preset.trim())
      ? (input.preset.trim() as AgentPreset)
      : 'minimal';

  const implemented = IMPLEMENTED_PRESETS.includes(rawPreset);
  const preset: AgentPreset = implemented ? rawPreset : 'minimal';
  const base = PRESET_DEFINITIONS[preset];

  let codeExecution = pickAxis(input?.codeExecution ?? base.codeExecution, CODE_EXECUTION_SPEC, base.codeExecution);
  let sandboxBackend = pickAxis(input?.sandboxBackend ?? base.sandboxBackend, SANDBOX_BACKEND_SPEC, base.sandboxBackend);
  const hostAccess = pickAxis(input?.hostAccess ?? base.hostAccess, HOST_ACCESS_SPEC, base.hostAccess);
  const taskExecution = pickAxis(input?.taskExecution ?? base.taskExecution, TASK_EXECUTION_SPEC, base.taskExecution);

  // off + 有后端 = 矛盾配置：off 意味着不试跑，后端无意义 → 归 none
  if (codeExecution === 'off') sandboxBackend = 'none';
  // sandbox 必须有非 none 后端（P7a 的非 none 即 process）
  if (codeExecution === 'sandbox' && sandboxBackend === 'none') sandboxBackend = 'process';

  return {
    preset,
    codeExecution,
    sandboxBackend,
    hostAccess,
    taskExecution,
    allowedApps: hostAccess === 'app-scoped' ? pickAllowedApps(input?.allowedApps) : [],
    allowedDomains: pickStringList(input?.allowedDomains, 64),
    source: {
      preset: 'local',
      codeExecution: 'local',
      sandboxBackend: 'local',
      hostAccess: 'local',
      taskExecution: 'local',
    },
  };
}

/**
 * min(本地, 中台) 合并（09 §4.2）。
 *
 * 中台策略语义：`permissionPolicy` 是**允许的最宽预设**，`allowedProfiles`
 * 是允许的预设白名单。合并规则：
 *   · 本地 preset 不在 allowedProfiles → 整体压回两集合中更保守的
 *     `minimal`（宁紧勿松——中台没有授权的档位就是不允许）；
 *   · 中台预设的每一轴比本地**更保守**时取中台值（source 标 center-clamped）；
 *   · 中台比本地宽 → 保持本地值（中台是上限不是指令）。
 *   · 中台策略缺失/形状非法 → 原样保留本地（离线沿用本地，09 §调整4）。
 */
export function mergeWithCenterPolicy(
  local: EffectiveAgentPermissions,
  center: CenterPolicyInput | null | undefined,
): EffectiveAgentPermissions {
  if (!center || typeof center !== 'object') return local;

  const policyPreset =
    typeof center.permissionPolicy === 'string' &&
    (AGENT_PRESETS as readonly string[]).includes(center.permissionPolicy.trim())
      ? (center.permissionPolicy.trim() as AgentPreset)
      : null;

  const allowed = Array.isArray(center.allowedProfiles)
    ? (center.allowedProfiles.filter(
        (p): p is AgentPreset =>
          typeof p === 'string' && (AGENT_PRESETS as readonly string[]).includes(p),
      ) as AgentPreset[])
    : null;

  // 预设白名单存在且不包含本地 preset → 压回 minimal（保守交集）
  // 注意：`local.preset` 名义上可能是 'custom'（细粒度覆盖场景），而
  // allowedProfiles 只枚举预设名——'custom' 不在其中。若直接判包含就会把
  // 「细粒度覆盖」误当成「中台未授权」而整体压回 minimal，用户改一个轴会
  // 连带丢掉其它轴。故只对真实预设名做白名单判定。
  const presetAllowed =
    allowed === null || local.preset === 'custom' || allowed.includes(local.preset);
  let effectivePreset: AgentPreset | 'custom' = local.preset;
  let clamped = false;
  if (!presetAllowed) {
    const merged = mergeAxes(PRESET_DEFINITIONS.minimal, local);
    return {
      ...merged,
      preset: 'minimal',
      source: allCenterClamped(),
    };
  }

  // 中台是**预设上限**：本地细粒度覆盖可能比任何预设都宽——按「中台预设
  // 各轴 vs 本地各轴，逐轴取更保守」合并
  if (policyPreset !== null) {
    const cap = PRESET_DEFINITIONS[policyPreset];
    const merged = mergeAxes(cap, local);
    clamped =
      merged.codeExecution !== local.codeExecution ||
      merged.sandboxBackend !== local.sandboxBackend ||
      merged.hostAccess !== local.hostAccess ||
      merged.taskExecution !== local.taskExecution;
    effectivePreset = clamped ? local.preset : local.preset;
    return {
      ...merged,
      preset: effectivePreset,
      allowedDomains: local.allowedDomains,
      allowedApps: merged.hostAccess === 'app-scoped' ? local.allowedApps : [],
      source: clamped ? allCenterClamped() : local.source,
    };
  }

  // 只有白名单、无 permissionPolicy：本地在白名单内 → 原样
  return local;
}

function allCenterClamped(): EffectiveAgentPermissions['source'] {
  return {
    preset: 'center-clamped',
    codeExecution: 'center-clamped',
    sandboxBackend: 'center-clamped',
    hostAccess: 'center-clamped',
    taskExecution: 'center-clamped',
  };
}

function mergeAxes(
  cap: EffectiveAgentPermissions | { codeExecution: CodeExecutionMode; sandboxBackend: SandboxBackendMode; hostAccess: HostAccessMode; taskExecution: TaskExecutionMode },
  local: EffectiveAgentPermissions,
): EffectiveAgentPermissions {
  const clamp = <K extends string>(centerV: K, localV: K, rank: readonly K[], implemented: readonly K[], fallback: K): K => {
    // 取 rank 上更靠前（更保守）者；结果若未实现则钳回保守已实现档
    const stricter = rank.indexOf(centerV) <= rank.indexOf(localV) ? centerV : localV;
    return implemented.includes(stricter) ? stricter : fallback;
  };
  return {
    ...local,
    codeExecution: clamp(cap.codeExecution, local.codeExecution, CODE_EXECUTION_SPEC.rank, CODE_EXECUTION_SPEC.implemented, 'off'),
    sandboxBackend: clamp(cap.sandboxBackend, local.sandboxBackend, SANDBOX_BACKEND_SPEC.rank, SANDBOX_BACKEND_SPEC.implemented, 'none'),
    hostAccess: clamp(cap.hostAccess, local.hostAccess, HOST_ACCESS_SPEC.rank, HOST_ACCESS_SPEC.implemented, 'none'),
    taskExecution: clamp(cap.taskExecution, local.taskExecution, TASK_EXECUTION_SPEC.rank, TASK_EXECUTION_SPEC.implemented, 'deploy-only'),
    allowedApps: clamp(cap.hostAccess, local.hostAccess, HOST_ACCESS_SPEC.rank, HOST_ACCESS_SPEC.implemented, 'none') === 'app-scoped' ? local.allowedApps : [],
  };
}

/** 快捷判定：当前档位是否允许试跑（P7a 的核心开关）。 */
export function allowsTrialRun(p: EffectiveAgentPermissions): boolean {
  return p.codeExecution === 'sandbox' || p.codeExecution === 'host';
}

/**
 * 快捷判定：当前档位是否允许直接执行任务（P7e 前半）。
 * `isolated-runner` = 交付时在本机直接执行一次候选（独立执行端点，08 §2.4
 * 方案 A）；默认 `deploy-only` = 只交付包、执行走既有 deploy 通道。
 */
export function allowsDirectTaskExecution(p: EffectiveAgentPermissions): boolean {
  return p.taskExecution === 'isolated-runner';
}

/**
 * `AppConfig` 的 agent 段 → 生效档位（09 §4.1）。
 *
 * 为什么要有这一层转换而不是把 AppConfig 直接丢给 resolveLocalPermissions：
 * 配置键名与档位轴名不同名（`agentPermissionProfile` vs `preset`），且
 * `AppConfig` 里这些键**全部可选**——`undefined` 与「显式配了 minimal」
 * 在语义上必须等价（都走最保守）。这里承担键名映射，`resolveLocalPermissions`
 * 只认自己的输入形状，两侧职责不混。
 *
 * 调用方拿到结果后仍需 `mergeWithCenterPolicy` 与中台策略合并——本函数
 * **只**产出本地档位（离线场景即最终结果）。
 */
export function permissionsFromConfig(
  cfg: {
    agentPermissionProfile?: unknown;
    agentCodeExecution?: unknown;
    agentSandboxBackend?: unknown;
    agentHostAccess?: unknown;
    agentTaskExecution?: unknown;
    agentAllowedApps?: unknown;
    agentAllowedDomains?: unknown;
  } | null | undefined,
): EffectiveAgentPermissions {
  return resolveLocalPermissions({
    preset: cfg?.agentPermissionProfile,
    codeExecution: cfg?.agentCodeExecution,
    sandboxBackend: cfg?.agentSandboxBackend,
    hostAccess: cfg?.agentHostAccess,
    taskExecution: cfg?.agentTaskExecution,
    allowedApps: cfg?.agentAllowedApps,
    allowedDomains: cfg?.agentAllowedDomains,
  });
}
