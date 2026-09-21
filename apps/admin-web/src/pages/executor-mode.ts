/**
 * R7 (N19): 任务表单执行器策略的纯逻辑层。
 * 独立成文件是为了同时满足 react-refresh（组件文件只导出组件）与可测性。
 */

export type ExecutorMode = 'auto' | 'group' | 'pinned' | 'broadcast';

/** NF-04：编辑态任务对象的亲和/反亲和字段。保留最小结构类型以避免
 * 将表单纯逻辑层与完整 API 类型耦合。 */
type AffinityTaskFields = {
  executorAffinityTags?: string[] | null;
  executorAntiAffinityTags?: string[] | null;
};

/**
 * NF-04：亲和/反亲和标签归一为「非空数组 | 显式 null」。两列是可空
 * simple-array，PATCH 语义为缺省=保留旧值、显式 null=清除（N28）。antd
 * Select 清空后值可能是 undefined（未挂载/未触碰）或 []（点 clear），
 * 两者都必须归一为 null，否则用户清空后旧约束仍在后端生效。
 */
export function normalizeAffinityTags(v: unknown): string[] | null {
  return Array.isArray(v) && v.length > 0 ? (v as string[]) : null;
}

/**
 * NF-04：后端任务 → 表单亲和/反亲和初值（编辑态回填）。数组原样回填；
 * null/空数组归一 undefined（antd Form 空态），提交侧再由
 * buildExecutorPayload 统一归一为显式 null。
 * 入参为 unknown：调用方任务对象可能来自不同 API 载荷形态。
 */
export function affinityFormValues(task: unknown): {
  executorAffinityTags?: string[];
  executorAntiAffinityTags?: string[];
} {
  const t = (task ?? {}) as AffinityTaskFields;
  const norm = (v?: string[] | null) => (v && v.length > 0 ? v : undefined);
  return {
    executorAffinityTags: norm(t.executorAffinityTags),
    executorAntiAffinityTags: norm(t.executorAntiAffinityTags),
  };
}

/**
 * 从后端任务映射到表单的执行器策略。优先级：
 * broadcast > executorId(真 pinning，后端 dispatch 唯一认可) > executorAppName
 * (legacy appName 语义，仍显示为 pinned 但需按 id 重选) > group/tags > auto。
 * NF-04 亲和/反亲和不参与模式推导——它们是正交约束，auto/group/broadcast
 * 下均可生效（见 buildExecutorPayload 注释）。
 */
export function deriveExecutorMode(task: {
  executeMode?: string | null;
  executorId?: string | null;
  executorAppName?: string | null;
  executorGroup?: string | null;
  executorTags?: string[] | null;
}): ExecutorMode {
  if (task.executeMode === 'broadcast') return 'broadcast';
  if (task.executorId) return 'pinned';
  if (task.executorAppName) return 'pinned';
  if (task.executorGroup || (task.executorTags && task.executorTags.length > 0)) return 'group';
  return 'auto';
}

/**
 * 按当前策略构造提交 payload。executorId 是后端唯一认可的 pinning
 * 字段（pinned 分支完全绕过 appName/group/tags），因此除 pinned 外的所有模式
 * 都显式置 executorId=null，避免 PATCH 白名单保留旧 pin 造成"界面 auto、实际
 * 钉死"的静默错位；pinned 模式则清空 legacy executorAppName 消除并存歧义。
 *
 * R8 (N28)：legacy 三字段 executorAppName/executorGroup/executorTags 的清理
 * 同样必须**显式置 null** 而非 `delete`——PATCH 请求体缺省字段 = 后端
 * Object.assign 保留旧值，而 dispatch 优先级 appName > group/tags，只 delete
 * 会让"界面 auto、实际按 appName pin"的 N19 症状换字段复现。后端
 * UpdateTaskDto 的 @IsOptional() 对 null 放行、entity 列均 nullable、
 * dispatch 以 falsy 判定，null 即清除语义（与 executorId 三端一致）。
 */
export function buildExecutorPayload(
  values: Record<string, unknown>,
  executorMode: ExecutorMode,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...values };
  // NF-04: 亲和/反亲和是与执行器选择模式正交的调度约束，而非 group 模式
  // 的限定字段——后端单发路径（auto/group）在 group/tags/runtime 过滤之后、
  // loadScore 之前过滤候选（亲和 OR 命中 / 反亲和排除，executor.service.ts
  // 2.2b 段）；broadcast 路径同样过滤，把广播收窄为命中亲和标签的子集
  // （pinning=一台、普通广播=全部、广播+亲和=命中子集，即第三态价值）。
  // 故 auto/group/broadcast 三模式保留其值；清空（undefined/[]）归一为
  // 显式 null——PATCH 缺省=Object.assign 保留旧值（N28），不显式发 null 会
  // 「界面已清空、后端仍生效」。
  payload.executorAffinityTags = normalizeAffinityTags(payload.executorAffinityTags);
  payload.executorAntiAffinityTags = normalizeAffinityTags(
    payload.executorAntiAffinityTags,
  );
  if (executorMode === 'broadcast') {
    payload.executeMode = 'broadcast';
    payload.executorId = null;
    payload.executorAppName = null;
    payload.executorGroup = null;
    payload.executorTags = null;
  } else if (executorMode === 'group') {
    payload.executeMode = 'single';
    payload.executorId = null;
    payload.executorAppName = null;
    // group/tags 是本模式的限定字段：用户清空 Select 后值为 undefined，
    // PATCH 缺省同样会保留旧过滤条件，因此 undefined 也显式置 null。
    if (payload.executorGroup === undefined) payload.executorGroup = null;
    if (payload.executorTags === undefined) payload.executorTags = null;
  } else if (executorMode === 'pinned') {
    payload.executeMode = 'single';
    // executorId 由选择器写入 values；清空 legacy executorAppName 避免与 pin 并存歧义。
    payload.executorAppName = null;
    payload.executorGroup = null;
    payload.executorTags = null;
    // NF-04: pinned 分支在后端 dispatch 直接取 [pinned] 绕过一切过滤
    // （executor.service.ts，含亲和/反亲和），所以两字段在 pinned 下不生效。
    // API 仍允许保存两列，且 PATCH 缺省=保留；不要因为切到 pinned 就
    // 擦除用户已配置的约束。控件在 pinned 下禁用，切回非 pinned 后约束可继续生效。
  } else {
    payload.executeMode = 'single';
    payload.executorId = null;
    payload.executorGroup = null;
    payload.executorTags = null;
    payload.executorAppName = null;
  }
  return payload;
}

/**
 * W-21: requirements 提交序列化（与 buildExecutorPayload 同层的纯逻辑，
 * 独立可测）。表单控件是 antd Select tags 模式，值已是 string[]：
 *  - 逐项 trim、丢空项（标签模式误触空格会产出 ""）；
 *  - 空集必须**显式 null** 而非缺省/delete——后端 PATCH 是
 *    Object.assign 语义（N28 教训：缺省字段=保留旧值），删除全部依赖
 *    若不发 null 会"界面已清空、后端仍安装旧依赖"。
 * 字段未挂载（glue 任务等不渲染该项）→ undefined 同样归一为 null，
 * 与执行器端"glue 任务清零 requirements"的既有语义一致，无副作用。
 */
export function applyRequirementsPayload(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const payload = { ...values };
  const raw = payload.requirements;
  if (Array.isArray(raw)) {
    const cleaned = raw
      .map((r) => (typeof r === 'string' ? r.trim() : ''))
      .filter((r) => r.length > 0);
    payload.requirements = cleaned.length > 0 ? cleaned : null;
  } else {
    payload.requirements = null;
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * python_task_multiversion：runtimeVersion 声明 + codeSource 互斥
 * （CONTRACT.md §1.1/§2.1，FR-06/FR-18/FR-19，AC-06a/AC-06b/AC-17b/AC-19a）
 *
 * 本段与上面的 applyRequirementsPayload 同层：纯函数、无 React 依赖，
 * 供 TaskFormPage 组装提交 payload，并可被单测直接覆盖。
 * ------------------------------------------------------------------ */

/** 版本号格式（D1）：主.次。与 admin-api runtime-version.util.ts 的
 *  RUNTIME_VERSION_PATTERN 逐字节一致（前端只做便利校验，服务端权威）。 */
export const RUNTIME_VERSION_PATTERN = /^\d+\.\d+$/;

/* ------------------------------------------------------------------ *
 * G-1：可注入的运行时版本配置。
 *
 * 此前区间（3.7~3.14）、在线下界（3.8）、legacy 兜底（3.12）、各 Tier 版本表
 * 都是前端硬编码，与后端常量靠人工同步——Python 3.15 发布或后端调整 legacy
 * 默认时，前端读面咨询会漂移误报。现把这些值收敛到一个可注入配置：
 *  - 默认值与历史硬编码逐字一致（既有单测零回归）；
 *  - 后端 GET /config/runtime-version 上线后，启动时拉取并调用
 *    configureRuntimeVersionConfig() 注入，纯函数无需改签名即可消费新值；
 *  - 纯函数仍保持「无 React 依赖、可单测」——测试在 afterEach 调
 *    resetRuntimeVersionConfig() 复位即可。
 * ------------------------------------------------------------------ */
export interface RuntimeVersionConfig {
  /** 可声明区间下界，如 '3.7' */
  min: string;
  /** 可声明区间上界，如 '3.14' */
  max: string;
  /** 可在线下载的下界（低于此版本 uv 无法在线下载），如 '3.8' */
  onlineMin: string;
  /** 旧执行器未上报 interpreters 时的兜底默认版本，如 '3.12' */
  legacyDefaultInterpreter: string;
  /** Tier 1「完全支持」（uv 官方支持且可在线下载） */
  tier1: readonly string[];
  /** Tier 2「在线可用」（uv 可在线下载，已过活跃支持期） */
  tier2: readonly string[];
  /** Tier 3「需离线预填」（uv 无法在线下载） */
  tier3: readonly string[];
}

/** 可声明区间（D10 实测后冻结，CONTRACT §1.1）：3.7 ~ 3.14。 */
export const RUNTIME_VERSION_MIN = '3.7';
export const RUNTIME_VERSION_MAX = '3.14';
/** 可在线下载的下界：uv 0.8.17 与 0.11.14 均以 3.8 为地板，**3.7 无法在线下载**。 */
export const RUNTIME_VERSION_ONLINE_MIN = '3.8';
/**
 * 旧执行器未上报 interpreters 时的兜底默认版本（与后端
 *  LEGACY_DEFAULT_INTERPRETERS 同值，改动需两侧同步）。 */
export const LEGACY_DEFAULT_INTERPRETER = '3.12';

/** Tier 1「完全支持」：uv 官方支持且可在线下载。 */
export const RUNTIME_VERSION_TIER1: readonly string[] = ['3.14', '3.13', '3.12', '3.11', '3.10'];
/** Tier 2「在线可用」：uv 可在线下载，但已过活跃支持期。 */
export const RUNTIME_VERSION_TIER2: readonly string[] = ['3.9', '3.8'];
/** Tier 3「需离线预填」：uv 无法在线下载，只有预填缓存卷才可用。 */
export const RUNTIME_VERSION_TIER3: readonly string[] = ['3.7'];

/** 默认配置——与历史硬编码逐字一致（直接 import 上述常量的旧调用方零影响）。 */
const DEFAULT_RUNTIME_VERSION_CONFIG: RuntimeVersionConfig = {
  min: RUNTIME_VERSION_MIN,
  max: RUNTIME_VERSION_MAX,
  onlineMin: RUNTIME_VERSION_ONLINE_MIN,
  legacyDefaultInterpreter: LEGACY_DEFAULT_INTERPRETER,
  tier1: RUNTIME_VERSION_TIER1,
  tier2: RUNTIME_VERSION_TIER2,
  tier3: RUNTIME_VERSION_TIER3,
};

let runtimeVersionConfig: RuntimeVersionConfig = DEFAULT_RUNTIME_VERSION_CONFIG;

/** 运行时读取当前版本配置（纯函数内部统一入口）。 */
export function getRuntimeVersionConfig(): RuntimeVersionConfig {
  return runtimeVersionConfig;
}

/**
 * 注入后端下发的版本配置（启动拉取 /config/runtime-version 后调用）。
 * 传 partial 与当前值浅合并；用于前端读面（候选列表/区间提示/舰队咨询）跟随后端权威值。
 */
export function configureRuntimeVersionConfig(partial: Partial<RuntimeVersionConfig>): void {
  runtimeVersionConfig = { ...runtimeVersionConfig, ...partial };
}

/** 复位为默认配置（测试用）。 */
export function resetRuntimeVersionConfig(): void {
  runtimeVersionConfig = DEFAULT_RUNTIME_VERSION_CONFIG;
}

/** 单个候选版本（tier 供 UI 分组渲染；offlineOnly 供 3.7 警示标签）。 */
export interface RuntimeVersionOption {
  value: string;
  tier: 1 | 2 | 3;
  /** true = 需部署方离线预填解释器缓存卷，在线下载必然失败。 */
  offlineOnly: boolean;
}

/** 选择器候选全集（Tier1 → Tier2 → Tier3，组内为推荐优先的降序）。
 *  G-1：候选表来自可注入配置，后端调整支持矩阵后无需改前端代码。 */
export function runtimeVersionOptions(): RuntimeVersionOption[] {
  const cfg = getRuntimeVersionConfig();
  const build = (versions: readonly string[], tier: 1 | 2 | 3): RuntimeVersionOption[] =>
    versions.map((value) => ({ value, tier, offlineOnly: tier === 3 }));
  return [
    ...build(cfg.tier1, 1),
    ...build(cfg.tier2, 2),
    ...build(cfg.tier3, 3),
  ];
}

/**
 * FR-06/AC-06b：版本值归一。
 *  - 空串/空白/undefined/null → null（= 不声明，走宿主默认解释器 FR-10）；
 *  - 格式非 `主.次`（如 `3.12.1`、`abc`、`3`）→ null；
 *  - 超出可声明区间 3.7~3.14（如 `3.6`、`3.15`、`4.0`）→ null。
 *
 * 归 null 而非抛错/原样透传，是「非法值宁可不发也不发垃圾」的落点：
 * 提交侧把 null 当「使用宿主默认解释器」，服务端 @Matches 对 null 放行
 * （@IsOptional），故非法输入不会变成 400 也不会静默存下脏值。
 *
 * 入参 unknown 并容忍数组（取末位）：antd Select 在 tags/combobox 形态下
 * 可能回传数组，防御性取最后一个输入值（与 requirements 的 tags 语义一致）。
 */
export function normalizeRuntimeVersion(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!RUNTIME_VERSION_PATTERN.test(trimmed)) return null;
  // 元组比较而非字符串比较：字符串序会把 "3.9" > "3.14" 判反（D1 的前缀
  // 匹配陷阱同源）。G-1：上下界从可注入配置解析，默认即 3.7~3.14（主版本恒为 3）。
  const cfg = getRuntimeVersionConfig();
  const [major, minor] = trimmed.split('.').map((n) => Number(n));
  const [minMajor, minMinor] = cfg.min.split('.').map((n) => Number(n));
  const [, maxMinor] = cfg.max.split('.').map((n) => Number(n));
  if (major !== minMajor) return null;
  if (minor < minMinor || minor > maxMinor) return null;
  return trimmed;
}

/**
 * 3.7 属「需离线预填」层：uv 无法在线下载 3.7（CONTRACT §0 事实行），
 * 只有部署方预填了解释器缓存卷才可运行。UI 据此渲染警示标签。
 */
export function runtimeVersionIsOfflineTier(raw: unknown): boolean {
  const version = normalizeRuntimeVersion(raw);
  if (version === null) return false;
  const minor = Number(version.split('.')[1]);
  // G-1：在线下界来自可注入配置（默认 3.8）。
  return minor < Number(getRuntimeVersionConfig().onlineMin.split('.')[1]);
}

/**
 * python_task_multiversion（P2-4）：**读面**解释器能力咨询（纯函数，非阻断）。
 *
 * 判据与 admin-api `interpreter-match.util` 逐条对齐（前端无法 import 后端，
 * 同判据复制一份并由单测钉死漂移）：
 *  - requested 空/非法 → 不判定（无版本声明，宿主默认解释器即可）；
 *  - 执行器 interpreters 未上报（null/undefined，旧执行器）→ 按 LEGACY_DEFAULT
 *    3.12 兜底，只有声明 3.12 时满足；
 *  - []（已上报且池空）→ 不满足，**不**走兜底（与"未上报"是相反的两态）；
 *  - 逐项**点安全**前缀匹配（"3.13.0" 不满足 "3.1"），available===false 的项跳过。
 *
 * 红线（AC-06c「解释器先下载后有」）：本族函数**只用于读面咨询提示**，绝不能
 * 变成提交阻断——在线版本（3.8+）执行时可按需下载，写路径预检会把它退化成
 * 同步依赖，违背设计。
 */
export interface ExecutorInterpreterCapability {
  version: string;
  available?: boolean | null;
}
export interface ExecutorCapability {
  status?: string | null;
  interpreters?: ExecutorInterpreterCapability[] | null;
}

/** 点安全前缀匹配：`3.7.9` 满足 `3.7`（相等或 `3.7.` 前缀）；`3.13.0` 不满足 `3.1`。 */
export function matchesInterpreterVersion(availableVersion: unknown, requested: string): boolean {
  if (typeof availableVersion !== 'string') return false;
  return availableVersion === requested || availableVersion.startsWith(`${requested}.`);
}

/** 单台执行器的缓存池是否满足声明版本（未声明版本恒满足）。 */
export function interpreterCapabilitySatisfies(
  interpreters: ExecutorInterpreterCapability[] | null | undefined,
  requested: string | null | undefined,
): boolean {
  const version = normalizeRuntimeVersion(requested);
  if (version === null) return true;
  if (!Array.isArray(interpreters)) {
    // 未上报（旧执行器/非数组脏数据）→ 仅兜底默认版本视为满足。
    // G-1：兜底版本来自可注入配置（默认 3.12），与后端 LEGACY_DEFAULT_INTERPRETERS 同步。
    return version === getRuntimeVersionConfig().legacyDefaultInterpreter;
  }
  return interpreters.some(
    (item) =>
      !!item &&
      item.available !== false &&
      matchesInterpreterVersion(item.version, version),
  );
}

export type InterpreterFleetAdvisory = 'satisfied' | 'unsatisfied' | 'unknown';

/**
 * 舰队级读面咨询：
 *  - 'satisfied'：未声明版本，或至少一台**在线**执行器的缓存池满足该版本；
 *  - 'unsatisfied'：有在线执行器，但按它们上报的缓存池没有一台满足——在线层
 *    （3.8+）仍可能在执行时按需下载，故只是提示；离线层（3.7）则必须先预填；
 *  - 'unknown'：没有在线执行器（舰队离线 / 列表未加载）——不提示，避免误报。
 */
export function interpreterFleetAdvisory(
  executors: ExecutorCapability[] | null | undefined,
  requested: string | null | undefined,
): InterpreterFleetAdvisory {
  const version = normalizeRuntimeVersion(requested);
  if (version === null) return 'satisfied';
  const online = (executors ?? []).filter((e) => e?.status === 'online');
  if (online.length === 0) return 'unknown';
  return online.some((e) => interpreterCapabilitySatisfies(e.interpreters, version))
    ? 'satisfied'
    : 'unsatisfied';
}

/**
 * FR-06/NG-02：runtimeVersion 提交归一。
 *  - runtime !== 'python' → **显式 null**（后端拒绝 node/shell 声明版本，
 *    且 PATCH 缺省 = 保留旧值 N28——从 python 改到 node 后不发 null 会把
 *    旧版本声明留在库里，切回 python 时「凭空」生效）；
 *  - runtime === 'python' → normalizeRuntimeVersion 归一（非法/清空 → null，
 *    = 使用宿主默认解释器 FR-10）。
 *
 * `runtimeVersion` 显式传参优先，缺省回落到 values 上的同名键：表单侧该值
 * 存在组件 state（版本选择器是受控复合控件，不入 antd 字段树），提交时显式
 * 传入；纯函数单测两条通路都能覆盖。
 */
export function applyRuntimeVersionPayload(
  values: Record<string, unknown>,
  runtimeVersion?: unknown,
): Record<string, unknown> {
  const payload = { ...values };
  const raw = runtimeVersion !== undefined ? runtimeVersion : payload.runtimeVersion;
  payload.runtimeVersion = payload.runtime === 'python' ? normalizeRuntimeVersion(raw) : null;
  return payload;
}

/** FR-18：代码来源三选一（CONTRACT §2.1 枚举）。 */
export type CodeSource = 'git' | 'glue' | 'application_zip';

const CODE_SOURCES: readonly string[] = ['git', 'glue', 'application_zip'];

/** 空白/非字符串 → null；否则 trim 后的字符串（PATCH 显式清除语义）。 */
function trimmedOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * FR-18/AC-17b：编辑态代码来源推导。
 *  - 后端已回填 `codeSource` 且取值合法 → 原样采用；
 *  - 否则按 CONTRACT §2.1 的存量回填优先级推断（迁移脚本同序）：
 *    gitRepo > glueSource > applicationId > 默认 git。
 *
 * 默认 git 而非 application_zip：新建任务既有默认行为就是「填 gitRepo」，
 * 保持零迁移手感；`?applicationId=` 创建入口由调用方显式覆盖为 application_zip。
 */
export function deriveCodeSourceFromTask(task: {
  codeSource?: string | null;
  gitRepo?: string | null;
  glueSource?: string | null;
  applicationId?: string | null;
}): CodeSource {
  if (typeof task.codeSource === 'string' && CODE_SOURCES.includes(task.codeSource)) {
    return task.codeSource as CodeSource;
  }
  if (trimmedOrNull(task.gitRepo)) return 'git';
  if (trimmedOrNull(task.glueSource)) return 'glue';
  if (trimmedOrNull(task.applicationId)) return 'application_zip';
  return 'git';
}

/**
 * FR-18/AC-17b/AC-18b：按代码来源归一提交 payload —— **恰好一种**来源通道。
 *
 * N28 纪律：不适用的字段一律**显式 null**（不是 delete、不是省略）——
 * PATCH 是 Object.assign 语义，省略字段 = 后端保留旧值，会出现「界面选了
 * glue、后端仍按 gitRepo 拉代码」的静默错位（与 buildExecutorPayload 的
 * legacy 三字段清理同源教训）。
 *
 * ## `codeSource` 的自证规则（对齐 admin-api `assertCodeSourceConsistent`）
 *
 * 后端拒绝「声明与字段漂移」：`codeSource='git'` 却无 gitRepo、`codeSource='glue'`
 * 却无 glueSource、`codeSource='application_zip'` 却无 applicationId，一律 400。
 * 而本表单的 gitRepo / glueSource **都不是必填**（存量任务与部署清单自动注册
 * 的任务都没有它们，NFR-05 零破坏；且本表单从不编辑 glueSource，它归
 * GlueEditor 所有）。因此只在**载荷自身能自证**时才声明 codeSource，否则发
 * 显式 `null`（= 未声明 → 后端回到"按哪个字段非空隐式推断"的存量语义，该路径
 * 后端明确放行）。这样既不产生 400，也不会把歧义态写进库。
 *
 * ## 各字段的所有权与清除规则
 *
 * | 字段 | git | application_zip | glue |
 * |---|---|---|---|
 * | `gitRepo`/`gitBranch` | 归一（空→null） | 清 null | 清 null |
 * | `glueSource` | 清 null | 清 null | 有值才归一，缺省不写 |
 * | `applicationId` | 见下 | 归一（空→null） | 见下 |
 *
 * **`glueSource` 在 glue 分支"有值才写"**：本表单没有 glue 代码输入框
 * （GlueEditor 在独立区块用 `tasksApi.updateGlue` 写入，后端同时声明
 * codeSource='glue'）。编辑态把任务的 glueSource 回填进表单，写回是幂等的
 * no-op；而创建态该键缺省（尚无脚本）。若在此处无条件 `glueSource = null`，
 * 新建 glue 任务会被自己的表单判成"声明漂移"400，编辑已有任务则会**静默删除
 * 用户的脚本**——两者都不可接受。
 *
 * **`applicationId` 的清除是"离开 zip 才清"**：`applicationId` 在
 * `codeSource='application_zip'` 时是**代码来源载体**，其余时候只是
 * **部署绑定**（部署清单自动注册的任务正是 `applicationId + glueSource` 并存，
 * 后端 NFR-05 明确放行且刻意不查库判定）。故：
 *  - 选中 zip → 归一 applicationId（空 → null，后端另有"必填"校验）；
 *  - 从 zip 切走（`previousCodeSource === 'application_zip'`）→ 清 null
 *    （该绑定本就是 zip 载体，用户已显式放弃）；
 *  - 双方都不是 zip → **保留**（可能是部署绑定，静默清掉 = 悄悄解绑任务与
 *    应用，属数据丢失）。
 *
 * `gitCommit` 是部署时点快照，不属来源声明，此处不触碰（保持既有值）。
 *
 * **requirements 一律不触碰**：依赖型渠道（PyPI/requirements）与任一代码来源
 * 可自然并存（AC-18b/FR-18 红线），本函数不得让切换来源清掉依赖声明。
 */
export function applyCodeSourcePayload(
  values: Record<string, unknown>,
  codeSource: CodeSource,
  previousCodeSource?: CodeSource,
): Record<string, unknown> {
  const payload = { ...values };
  const leavingZip = previousCodeSource === 'application_zip' && codeSource !== 'application_zip';
  if (codeSource === 'application_zip') {
    const applicationId = trimmedOrNull(payload.applicationId);
    payload.applicationId = applicationId;
    payload.gitRepo = null;
    payload.gitBranch = null;
    payload.glueSource = null;
    payload.codeSource = applicationId ? 'application_zip' : null;
  } else if (codeSource === 'glue') {
    const glueSource = trimmedOrNull(payload.glueSource);
    payload.gitRepo = null;
    payload.gitBranch = null;
    if (leavingZip) payload.applicationId = null;
    // glueSource 所有权在 GlueEditor：载荷未携带该键时不得写 null（会删脚本）
    if (glueSource !== null) payload.glueSource = glueSource;
    payload.codeSource = glueSource !== null ? 'glue' : null;
  } else {
    const gitRepo = trimmedOrNull(payload.gitRepo);
    payload.gitRepo = gitRepo;
    payload.gitBranch = trimmedOrNull(payload.gitBranch);
    payload.glueSource = null;
    if (leavingZip) payload.applicationId = null;
    payload.codeSource = gitRepo ? 'git' : null;
  }
  return payload;
}

/**
 * P0（UX-AUDIT-2026-09-21 §P0-5）：切换代码来源会**清空**哪些字段（供确认弹窗）。
 *
 * ## 为什么需要这个
 *
 * `applyCodeSourcePayload` 会把不适用字段显式置 null（PATCH 是 Object.assign
 * 语义，不发 null 会保留旧值 → 任务静默带两个冲突来源），而对应的输入框是
 * **条件渲染**的——用户一改单选，框就从 DOM 消失、值也已置 null。两条叠加的
 * 后果：误点一下「Glue 脚本」，gitRepo/gitBranch 立刻不见了，用户既看不到被清
 * 的内容、也收不到任何提示，切回来只能凭记忆重填。属误操作不可逆。
 *
 * 故在切换前先算"会损失什么"，把选择交给用户——**只列真正有值的字段**，
 * 全空时不打扰（例如新建任务时来回切换不该弹窗）。
 *
 * 复用 applyCodeSourcePayload 的判定，而不是另写一份规则：两处一旦漂移，
 * 弹窗就会承诺"不清 X"而实际清了 X，比不弹更糟。
 *
 * @returns 将被清空的字段清单（人类可读标签 + 值）；空数组 = 无需确认
 */
export function codeSourceSwitchLosses(
  values: Record<string, unknown>,
  next: CodeSource,
  previous: CodeSource,
): Array<{ field: string; value: string }> {
  // 以 next 为参数跑一次真实载荷变换，比较前后差异——判定与提交路径**同源**。
  const before = { ...values };
  const after = applyCodeSourcePayload({ ...values }, next, previous);
  const labels: Record<string, string> = {
    gitRepo: 'Git 仓库地址',
    gitBranch: 'Git 分支',
    glueSource: 'Glue 脚本',
    applicationId: '关联应用',
  };
  const losses: Array<{ field: string; value: string }> = [];
  for (const field of Object.keys(labels)) {
    const prevVal = trimmedOrNull(before[field]);
    const nextVal = trimmedOrNull(after[field]);
    // 只在"原本有值、变换后没了"时计入——全空切换不打扰
    if (prevVal !== null && nextVal === null) {
      losses.push({
        field,
        value: field === 'glueSource' ? `${String(prevVal).length} 个字符的脚本` : String(prevVal),
      });
    }
  }
  return losses;
}

/**
 * AC-19a/FR-19：zip 应用的 runtime 与任务 runtime 一致性。
 *  - 任一侧缺失（未选应用 / 应用列表未加载 / 应用无 runtime）→ null
 *    （不判定，交给服务端权威校验，避免列表未就绪时误报）；
 *  - 一致 → false；不一致 → true。
 *
 * 只对 `codeSource='application_zip'` 有意义（调用方保证）；对裸 applicationId
 * 的存量行后端刻意不判定（NFR-05），前端同样只在 zip 分支据此提示。
 */
export function deriveRuntimeMismatch(
  taskRuntime: unknown,
  appRuntime: unknown,
): boolean | null {
  const a = trimmedOrNull(taskRuntime);
  const b = trimmedOrNull(appRuntime);
  if (a === null || b === null) return null;
  return a !== b;
}

/** 后端读路径给每个 secret 叶子返回的字面量（与 admin-api 的 SECRET_MASK_LITERAL 同值）。 */
const SECRET_MASK_LITERAL = '******';

/**
 * SEC-02 续（生产故障）：secrets 提交前的**掩码闸门**。
 *
 * 掩码（`******`）是读路径的产物，不是凭据。一旦它进入请求体，后端会把字面量
 * `******` 当成真实值落库——真实凭据被不可逆覆盖，而 UI 上键还在、任务却报
 * 「缺少凭据」，正是本次生产故障最难查的形态。后端已按**逐键合并**处理
 * （叶子 = 掩码 → 保留旧值），所以这里的主要职责是"不发出无意义的噪声"，
 * 同时保留一道**与后端无关**的独立防线：**任何情况下都不把掩码发出去**。
 *
 * 语义（与后端 mergeSecretsOnUpdate 对齐）：
 *   · `undefined`        → 删除该键：后端一个 secret 都不碰（用户没动过凭据）；
 *   · `null`             → 整体清空（编辑器"清空全部"的显式信号）；
 *   · 对象               → 逐键过滤掉掩码叶子后原样提交；键的值可以为 null
 *     （显式删除该键）。
 * 过滤后若对象变空（用户只碰了掩码行），仍然提交 `{}`：合并语义下空对象 =
 * 不改任何键，既不销毁凭据也不制造意外写入。
 */
export function applySecretsPayload(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const payload = { ...values };
  const raw = payload.secrets;
  if (raw === undefined) {
    // 显式删除比留 `secrets: undefined` 干净：调用方（CLI/日志）看到的载荷形状
    // 与"后端收到了什么"一致，不留一个"看起来有、其实没有"的键。
    delete payload.secrets;
    return payload;
  }
  if (raw === null) return payload;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    // 形状不对（后端 @IsObject 会 400）：不发出去，交给后端按"未提供"处理，
    // 避免把非对象塞进请求体换来一条与凭据无关的报错。
    delete payload.secrets;
    return payload;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (v === SECRET_MASK_LITERAL) continue;
    cleaned[k] = v;
  }
  payload.secrets = cleaned;
  return payload;
}
