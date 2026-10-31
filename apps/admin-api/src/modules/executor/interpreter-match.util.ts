/**
 * python_task_multiversion（WS2）：解释器**缓存池匹配**的单一事实源。
 *
 * 上游契约（FROZEN）：`docs/design/python-task-upload-and-multiversion/CONTRACT.md`
 * §1.2（匹配语义）/ §2.2（`executors.interpreters` 形状）/ §2.5（失败分因与消息模板）
 * / §3.1（本文件导出面）。
 *
 * 背景：任务可声明 `runtimeVersion`（"主.次"，如 `3.7` / `3.12`），但执行器缓存池
 * 里装的是**完整补丁版本**（探测所得，如 `3.7.9`）。调度侧要回答的唯一问题是
 * 「这台在线执行器现在能不能跑这个声明版本」——答不出就白占一个并发坑位，任务
 * 在运行时才炸，用户看到的是"派发成功但立刻失败"。
 *
 * 三条硬语义（契约冻结，违反即回退）：
 * 1. **点安全前缀匹配**：`requested="3.7"` 匹配 `"3.7.9"` / `"3.7"`；但
 *    `requested="3.1"` **不得**匹配 `"3.13.0"`（`"3.1."` 不是 `"3.13.0"` 前缀）。
 *    跨版本号前缀必须带点——这是最容易写错、且错了会静默选错解释器的一处。
 * 2. **`null`/缺省 ≠ `[]`**：
 *    - `null` / `undefined` = **未上报**（存量旧执行器）→ 按 `["3.12"]` 兜底
 *      （CONTRACT §2.2 D5，兼容性红线 2：旧执行器不因缺字段被剔除）；
 *    - `[]` = **已上报且缓存池为空** → 视为**无任何版本可满足**，**不兜底**。
 *    两者语义相反，混淆会让"空池执行器"被误判为可跑 3.12。
 * 3. **`requested` 为空 → 恒 true**（不拦截）：存量任务无版本声明时，调度行为
 *    与引入本特性之前逐字节一致（FR-10 / 兼容性红线 1）。
 *
 * 纪律：
 * - **纯函数 + 常量，零依赖零状态**（同 `version-compare.util.ts` 先例）。调度过滤
 *   在候选循环里被调用，NFR-08 要求纯内存 O(清单长度)、**不得**引入 DB/网络往返。
 * - 本模块**只判"缓存池是否满足"**，不判断版本本身是否合法（那是
 *   `modules/task/runtime-version.util.ts` 的职责，AC-06b 写面已拦）。
 *   刻意**不**在此处做"下载尝试"或"在线可下载区间"判定：AC-06c 明确
 *   "先下载后有"，能否下载只有执行器侧说得清。
 */

/** CONTRACT §2.2：执行器上报的单条解释器缓存项。 */
export interface ExecutorInterpreter {
  /** 完整补丁版本（探测所得），如 `"3.7.9"`。 */
  version: string;
  /** 池内解释器绝对路径（执行器侧保证位于 UV_PYTHON_INSTALL_DIR 之内）。 */
  path?: string;
  /** 探测时可执行且 `--version` 通过；缺省视为可用。 */
  available?: boolean;
  /** 探测时刻（ISO8601）。 */
  discoveredAt?: string;
}

/**
 * CONTRACT §2.2 D5：**未上报**解释器清单的旧执行器，调度按此兜底。
 *
 * 语义边界（务必不要扩大）：仅 `interpreters === null | undefined` 时生效；
 * `[]`（已上报且池空）**不得**回退到本清单。
 */
export const LEGACY_DEFAULT_INTERPRETERS: readonly string[] = ["3.12"];

/**
 * CONTRACT §2.5 的失败分因 token。消息里**显式带上**它，是为了让派发阶段的
 * 分类器（`task.processor.ts` 的 failureReason 正则链）能把本类失败与
 * `EXECUTOR_OFFLINE` 区分开——`interpreter_unavailable` 不进默认重试集（D14），
 * 被误判成"执行器离线"会触发无意义的重试。
 *
 * 注意：token 必须出现在消息中**任何拉丁文 `executor` 之前**（消息以 token 开头
 * 即可满足）。既有 `EXECUTOR_OFFLINE` 规则含 `executor.*(offline|unavailable)`，
 * 而候选执行器 appName（如 `executor-python-1`）本身就含 `executor`；若 token 排在
 * 候选清单之后，同一行里就会形成 `executor ... unavailable` 的假匹配。
 */
export const INTERPRETER_UNAVAILABLE_TOKEN = "interpreter_unavailable";

/** 消息里最多列出的候选执行器条数（超出折叠为 `…等 N 个`，防消息爆炸）。 */
const MAX_SNAPSHOT_ENTRIES = 10;

/**
 * 采纳面允许的解释器条数上界（刻意独立于 `sanitizeRunningExecutionIds` 的
 * 10000 上限——解释器清单是低频静态配置，200 条足够且防上报面写放大）：
 * jsonb 列由**执行器上报**填充，不设上界等于把写放大权交给对端。
 */
export const MAX_INTERPRETER_ENTRIES = 200;

/**
 * P2-1（2026-10-26 第三轮审计）：单条上报面字符串字段的长度上界——与条数上界
 * 同一立场（防 jsonb 写放大：55MB body 上限内 200 条 × 任意长度 path/discoveredAt
 * 会随读面整体反序列化）。
 *
 * - path ≤ 1024：现实解释器路径是 UV_PYTHON_INSTALL_DIR 内的绝对路径
 *   （几十~百字符量级），1024 留足深目录余量；绝对路径超 1024 本身就是异常产物。
 * - discoveredAt ≤ 64：ISO 8601 时刻现实 ≤ 30 字符（含毫秒 + 时区），64 已有
 *   2 倍余量（对齐 deployed-apps.util.ts 的 lastDeployedAt ≤64 同位字段先例）。
 *
 * 超限与结构非法同策：**整字段拒绝采纳**（返回 null，调用方 warn + DB 保留
 * 旧值），绝不截断单条——interpreters 是执行器缓存池的**全量快照**，截断会让
 * 调度把被截掉的真实条目判为「池里没有」（与 deployedApps「截断让整替语义
 * 误删」同一理由，见 deployed-apps.util.ts MAX_DEPLOYED_APPS 注释）。
 */
export const MAX_INTERPRETER_PATH_LENGTH = 1024;
export const MAX_INTERPRETER_DISCOVERED_AT_LENGTH = 64;

/** CONTRACT §2.2：`version` 合法形态为 `X.Y`（探测回退）或 `X.Y.Z`（完整补丁）。 */
const INTERPRETER_VERSION_PATTERN = /^\d+\.\d+(\.\d+)?$/;

/**
 * CONTRACT §1.2：**点安全**前缀匹配。
 *
 * `matchesVersionPrefix("3.7.9", "3.7") === true`（`"3.7."` 是前缀）
 * `matchesVersionPrefix("3.7", "3.7") === true`（精确相等）
 * `matchesVersionPrefix("3.13.0", "3.1") === false`（跨版本号前缀必须带点）
 *
 * `requested` 为空串 → `false`：空声明的"不拦截"语义由 `interpreterSatisfies`
 * 承担，本函数是纯字符串判据，空串匹配一切会让调用方写出静默放行的 bug。
 */
export function matchesVersionPrefix(
  availableVersion: string,
  requested: string,
): boolean {
  if (typeof availableVersion !== "string" || typeof requested !== "string") {
    return false;
  }
  if (requested.length === 0) return false;
  return (
    availableVersion === requested ||
    availableVersion.startsWith(`${requested}.`)
  );
}

/**
 * CONTRACT §1.2 / §2.2 / §3.1：这台执行器的缓存池能否满足声明版本。
 *
 * 判定顺序（顺序即语义）：
 * 1. `requested` 为空（null/undefined/空串/全空白）→ `true`（不拦截）。
 * 2. `available` 为 `null`/`undefined` → 旧执行器兜底 `LEGACY_DEFAULT_INTERPRETERS`。
 * 3. `available` 为 `[]` → `false`（**不兜底**，已上报且池空）。
 * 4. 逐项：`available === false` 的项**永不满足**；`version` 非法（非字符串）跳过。
 *
 * 非数组（脏数据兜底）：按"未上报"处理走兜底——DB 写入面已由
 * `normalizeInterpreters` 拒绝非法结构，走到这里说明数据被外部绕过写脏，
 * 此时"当旧执行器对待"比"整台执行器被静默剔除"更保守。
 */
export function interpreterSatisfies(
  available: ExecutorInterpreter[] | null | undefined,
  requested: string | null | undefined,
): boolean {
  if (!hasRequestedVersion(requested)) return true;
  const requestedVersion = (requested as string).trim();
  const list = Array.isArray(available) ? available : null;
  if (list === null) {
    // 未上报（含非数组脏数据）→ 旧执行器兜底。
    return LEGACY_DEFAULT_INTERPRETERS.some((v) =>
      matchesVersionPrefix(v, requestedVersion),
    );
  }
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.available === false) continue;
    if (typeof entry.version !== "string") continue;
    if (matchesVersionPrefix(entry.version, requestedVersion)) return true;
  }
  return false;
}

/**
 * 声明版本是否"实际声明了"——`null`/`undefined`/空串/全空白一律视为未声明。
 *
 * 空白串也归入未声明：`"   "` 不是合法声明（写面 `^\d+\.\d+$` 已拦），但若经
 * 迁移/外部写入落到这里，把它当"未声明"放行，与存量任务语义一致；当成声明则
 * 会匹配不到任何版本，把任务变成必然失败。
 */
export function hasRequestedVersion(
  requested: string | null | undefined,
): boolean {
  return typeof requested === "string" && requested.trim().length > 0;
}

/**
 * 注册/心跳采纳面的结构校验 + 归一（CONTRACT §2.2 末条 / §2.3）。
 *
 * 返回 `null` 表示**结构非法 → 整字段拒绝采纳**（调用方保留 DB 旧值并 warn）。
 * 返回数组表示合法（**含空数组**——`[]` 是合法上报，语义为"池空"）。
 *
 * 非法判据（契约字面）：非数组 / 项缺 `version` / `version` 非 `X.Y` 或 `X.Y.Z`。
 * 可选的 `path`/`available`/`discoveredAt` 类型不符时**丢弃该字段**而不整体拒绝
 * （契约未把它们列为拒绝条件）；未知键一律剥除——jsonb 列由对端上报填充，
 * 只落白名单字段，避免任意 blob 入库。
 */
export function normalizeInterpreters(
  value: unknown,
): ExecutorInterpreter[] | null {
  if (!Array.isArray(value)) return null;
  // P3-3（2026-10-26 第三轮审计）：超限**整体拒绝**而非静默截断——interpreters
  // 是缓存池全量快照，截断（旧 `if (out.length >= MAX) break`）会把第 201+ 条
  // 真实条目从调度判据里抹掉（调度以为池里没有该版本），与 deployedApps
  // 「截断让整替语义误删」同一失真形态。上界本身保留（防写放大），只是违规
  // 的后果从「半采纳」改为「不采纳」（调用方 warn + DB 保留旧值，三态不变）。
  if (value.length > MAX_INTERPRETER_ENTRIES) return null;
  const out: ExecutorInterpreter[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const version = item.version;
    if (typeof version !== "string") return null;
    const trimmed = version.trim();
    if (!INTERPRETER_VERSION_PATTERN.test(trimmed)) return null;
    const entry: ExecutorInterpreter = { version: trimmed };
    // P2-1：path/discoveredAt 采纳面加长度上界（常量注释里有取值依据）。
    // 超限整字段拒绝（返回 null），不截断、不剥除该字段——半采纳同样不可信。
    if (typeof item.path === "string") {
      if (item.path.length > MAX_INTERPRETER_PATH_LENGTH) return null;
      entry.path = item.path;
    }
    if (typeof item.available === "boolean") entry.available = item.available;
    if (typeof item.discoveredAt === "string") {
      if (item.discoveredAt.length > MAX_INTERPRETER_DISCOVERED_AT_LENGTH) {
        return null;
      }
      entry.discoveredAt = item.discoveredAt;
    }
    out.push(entry);
  }
  return out;
}

/**
 * 单台执行器的缓存池快照（AC-09b / AC-12a 的"便于定位"载体）。
 *
 * - 未上报（null/undefined/脏数据）→ `appName[未上报，按 3.12 兜底]`：把兜底语义
 *   写进快照，否则运维看到 `[未上报]` 会以为"这台什么都没有"。
 * - 已上报但池空 → `appName[已缓存: 无]`。
 * - 逐项列出探测到的版本；`available === false` 的项标注 `(不可用)`——AC-12a
 *   要求能看出"缓存里有但不可用"与"根本没缓存"的区别。
 */
export function describeExecutorInterpreters(snapshot: {
  appName?: string | null;
  interpreters?: ExecutorInterpreter[] | null;
}): string {
  const name =
    snapshot && typeof snapshot.appName === "string" && snapshot.appName
      ? snapshot.appName
      : "unknown";
  const list = snapshot ? snapshot.interpreters : null;
  if (!Array.isArray(list)) {
    return `${name}[未上报，按 ${LEGACY_DEFAULT_INTERPRETERS.join("/")} 兜底]`;
  }
  const parts: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.version !== "string" || entry.version.length === 0)
      continue;
    parts.push(
      entry.available === false ? `${entry.version}(不可用)` : entry.version,
    );
  }
  if (parts.length === 0) return `${name}[已缓存: 无]`;
  return `${name}[已缓存: ${parts.join("；")}]`;
}

/**
 * CONTRACT §2.5 消息模板 / §3.1 过滤失败消息（AC-09b）：
 *
 * `[interpreter_unavailable] 解释器 <X.Y> 无法获取（缓存缺失 + 下载失败：<原因>）；
 *  候选执行器: <appName>[已缓存: 3.12.3]、<appName2>[未上报，按 3.12 兜底]`
 *
 * `<原因>` 在调度侧固定为"无在线执行器缓存该版本"——调度阶段**没有**发起过下载，
 * 如实描述比照抄执行器侧的"下载失败"更不容易误导排查（执行器侧真正的下载失败
 * 原因由 `result.interpreter.reason` 留痕，FR-12）。
 *
 * 候选清单最多 10 条，超出折叠为 `…等 N 个`。
 */
export function buildInterpreterMismatchMessage(
  requested: string,
  snapshots: { appName: string; interpreters?: ExecutorInterpreter[] | null }[],
): string {
  const list = Array.isArray(snapshots) ? snapshots : [];
  const shown = list
    .slice(0, MAX_SNAPSHOT_ENTRIES)
    .map((s) => describeExecutorInterpreters(s));
  if (list.length > MAX_SNAPSHOT_ENTRIES) {
    shown.push(`…等 ${list.length} 个`);
  }
  const candidates = shown.length > 0 ? shown.join("、") : "（无候选执行器）";
  return (
    `[${INTERPRETER_UNAVAILABLE_TOKEN}] 解释器 ${requested} 无法获取` +
    `（缓存缺失 + 下载失败：无在线执行器缓存该版本）；候选执行器: ${candidates}`
  );
}

// ── 2026-10-31：已缓存版本优先（派发软偏好） ──────────────────────────────
//
// ## 为什么需要（先说清它**不是**什么——2026-10-31 实测校准）
//
// ⚠️ 本模块最初的设计理由写错了，这里如实记录以免后人重蹈：
// 曾以为「`applyInterpreterFilter` 对 ≥3.8 不拦截，所以没缓存的设备也会被派
// 到、现场下 250MB」。**实测否证**：该函数先做 `kept = filter(interpreterSatisfies)`，
// **只要有一台满足就硬过滤到那几台**；只有**全员都不满足**时才因
// `isOnlineDownloadable` 放行（避免无缓存机队直接派发失败）。于是：
//   · 有缓存机 + 无缓存机混编 → 无缓存的那台在上游就已被剔除，本函数无差异；
//   · 全员都没缓存 → 全部放行，本函数也无差异（谁都得下）。
//
// ## 那它到底解决什么——唯一真实收益：**区分「真缓存」与「legacy 兜底假设」**
//
// `interpreterSatisfies` 有一条兼容性红线：`interpreters === null`（旧执行器
// **未上报**清单）按 `LEGACY_DEFAULT_INTERPRETERS = ["3.12"]` 兜底。这条兜底
// 是**假设**，不是事实——那些机器可能根本没装 3.12。而它足以让硬过滤把
// 「真缓存 3.12 的机器」与「只是没上报的 legacy 机器」**同样放行**（实测：
// `kept = ['legacy', 'real']`）。此时若负载最优的是 legacy 那台，任务就会被
// 派过去赌一把；赌输就是一次现场下载（或 `interpreter_unavailable`）。
//
// 本函数把「**实际上报且可用**的缓存」与「未知/兜底」分开：真缓存的前置，
// 让任务优先落在**确定**能跑的机器上。legacy 与池空的机器保留在原位，仍然
// 可被尝试（占坑循环逐个往下走）——所以是偏好而非过滤。
//
// ## 为什么必须是「偏好」不是「过滤」
//
// 硬过滤（只派给真缓存的）会踩两个坑：
//   · 真缓存那台全忙/离线时，候选集被清空 → 派发失败，而实际上让 legacy 机器
//     下一下也能跑；
//   · 缓存上报是异步的（心跳 30s），刚装好的版本在窗口内不可见 → 误杀。
// 故本函数做**稳定分区**：真缓存的整体前置，组内严格保持入参（评分升序）
// 顺序；占坑循环逐个尝试、失败即试下一个，天然降级——**零新增失败面**。
//
// ## 与 `interpreterSatisfies` 的分工
//
// `interpreterSatisfies` 回答「能不能跑」（**硬**闸，含 legacy 兜底语义）；
// 本函数回答「谁跑更便宜」（**软**偏好，只认**实际上报且可用**的缓存条目）。
// 特别是：`interpreters === null`（旧执行器未上报）**不计入偏好**——把"未知"
// 当"已缓存"会把偏好系统性地指向旧版本执行器，而它们反而更可能需要下载。

/** 参与偏好判定的候选执行器最小面（结构类型——不耦合 Executor 实体）。 */
export interface InterpreterCacheCandidate {
  /** `executors.id`；仅用于调用方的稳定排序，不参与匹配。 */
  id?: string | null;
  /** `executors.interpreters`（CONTRACT §2.2 形状）。 */
  interpreters?: ExecutorInterpreter[] | null;
}

export interface InterpreterCacheAffinityResult<T> {
  /** 已缓存该版本的候选（保持入参相对顺序）在前，其余（同样保序）在后。 */
  ordered: T[];
  /** 前置的候选数（= 已缓存命中数）。0 表示顺序未变。 */
  preferredCount: number;
  /** `interpreters === null`（旧执行器未上报）的候选数——不参与偏好。 */
  unreportedCount: number;
}

/**
 * 按「本机缓存池是否已有该版本」对候选列表做**稳定分区**。
 *
 * 前置条件：`candidates` 已由调用方按评分升序排好——本函数只调整分组，
 * **绝不**在组内重排，故组内最优（评分最低）仍是首选。
 *
 * 命中判据（比 `interpreterSatisfies` 更严，理由见上方模块尾注）：
 *   · `interpreters` 必须是**数组**（`null`/`undefined`/非数组 = 未上报，不计入）；
 *   · 条目 `available === false` 不算命中（探测时已确认跑不起来）；
 *   · `version` 必须点安全前缀匹配（`3.7` ↔ `3.7.9`，但 `3.1` ↮ `3.13.0`）。
 *
 * 纯函数、零 IO、零状态（同本文件其余导出面）：调度热路径每次派发调用一次，
 * O(候选数 × 该执行器池条目数)，池条目通常个位数。
 *
 * 快速路径：`requested` 未声明 / 候选 ≤1 → 原序副本（**零行为变化**保证）。
 */
export function partitionByInterpreterCache<
  T extends InterpreterCacheCandidate,
>(
  candidates: readonly T[],
  requested: string | null | undefined,
): InterpreterCacheAffinityResult<T> {
  if (!hasRequestedVersion(requested) || candidates.length <= 1) {
    return {
      ordered: [...candidates],
      preferredCount: 0,
      unreportedCount: 0,
    };
  }
  const requestedVersion = (requested as string).trim();

  const preferred: T[] = [];
  const rest: T[] = [];
  let unreportedCount = 0;

  for (const candidate of candidates) {
    const list = candidate.interpreters;
    if (!Array.isArray(list)) {
      // 未上报（或脏数据）→ 保留在原位，不参与偏好。
      unreportedCount += 1;
      rest.push(candidate);
      continue;
    }
    let hit = false;
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.available === false) continue;
      if (typeof entry.version !== "string") continue;
      if (matchesVersionPrefix(entry.version, requestedVersion)) {
        hit = true;
        break;
      }
    }
    if (hit) preferred.push(candidate);
    else rest.push(candidate);
  }

  return {
    ordered: [...preferred, ...rest],
    preferredCount: preferred.length,
    unreportedCount,
  };
}
