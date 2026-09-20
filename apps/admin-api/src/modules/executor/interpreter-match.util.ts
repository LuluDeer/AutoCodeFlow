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
const MAX_INTERPRETER_ENTRIES = 200;

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
  const out: ExecutorInterpreter[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const version = item.version;
    if (typeof version !== "string") return null;
    const trimmed = version.trim();
    if (!INTERPRETER_VERSION_PATTERN.test(trimmed)) return null;
    const entry: ExecutorInterpreter = { version: trimmed };
    if (typeof item.path === "string") entry.path = item.path;
    if (typeof item.available === "boolean") entry.available = item.available;
    if (typeof item.discoveredAt === "string") {
      entry.discoveredAt = item.discoveredAt;
    }
    out.push(entry);
    if (out.length >= MAX_INTERPRETER_ENTRIES) break;
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
