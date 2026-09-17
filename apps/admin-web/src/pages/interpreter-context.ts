/**
 * python_task_multiversion（FR-12 / AC-12a）：执行记录里 `result.interpreter`
 * 结构化留痕的**防御式**读取层（纯逻辑，独立成文件以满足 react-refresh
 * 只导出组件的限制并便于单测）。
 *
 * 留痕形状（executor-python `_interpreter_failure_result`，CONTRACT §3.3 点 6）：
 * ```jsonc
 * {
 *   "interpreter": {
 *     "requested": "3.7",                 // 任务声明的 主.次
 *     "resolved": null,                   // 成功解析到的绝对路径；失败恒 null
 *     "reason": "not_downloadable",       // 机器可读原因
 *     "detail": "3.7 needs offline prefill",
 *     "pool": { "install_dir": "/pool", "versions": ["3.12.11", "3.9.20"] }
 *   }
 * }
 * ```
 *
 * **为什么必须防御式**：`result` 是 jsonb 自由列，且这个快照是**新**执行器
 * 才开始写的——历史执行记录里 `result` 可能是 null、`{}`、旧结构，甚至
 * 被人工改过。详情页是排障入口，任何一次读取抛错都会把整页打成白屏，比少
 * 显示一行信息严重得多。故本模块**只读已知键、逐层判类型**，任何异常形状
 * 一律退化为"字段缺失"，由调用方渲染稳定的占位。
 *
 * 也刻意**不**信任 `requested`/`reason` 的类型：它们跨语言边界（python →
 * jsonb → TS），数字 3.7（JSON number）是完全可能的写法——非字符串一律
 * 归 null，而不是 `String()` 强转出一个可能误导运维的假版本号。
 */

/** 解释器池快照（executor 侧 `_pool_summary()` 的输出形状）。 */
export interface InterpreterPool {
  /** 池根目录（UV_PYTHON_INSTALL_DIR）；探测失败时为空串 */
  installDir: string;
  /** 池内已缓存的完整补丁版本，如 ["3.12.11", "3.9.20"] */
  versions: string[];
}

/** 归一后的解释器留痕（所有字段都可能为 null = 该项未留痕）。 */
export interface InterpreterContext {
  /** 任务声明的 主.次 版本（如 "3.7"）；未声明/未留痕 → null */
  requested: string | null;
  /** 实际解析到的解释器绝对路径；失败场景恒为 null */
  resolved: string | null;
  /** 机器可读失败原因（uv_missing / not_downloadable / download_failed / …） */
  reason: string | null;
  /** 人可读补充说明（失败场景通常是部署指引原文） */
  detail: string | null;
  /** 解释器池快照；无有效内容 → null */
  pool: InterpreterPool | null;
}

/** 非空字符串 → trim 后的值；其余（数字/null/对象/空串）→ null。 */
function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 非 null 对象 → 该对象；数组/原始值/null → null（`typeof null === 'object'` 陷阱）。 */
function obj(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/**
 * 池快照归一：`versions` 只保留字符串项（执行器写入的必是 string[]，但 jsonb
 * 无 schema 约束，手工订正/未来结构演进都可能混入对象）；`install_dir` 缺省
 * 归空串（与执行器侧 `_pool_summary` 的兜底一致）。
 *
 * 返回 null 的判据：池不是对象，或 installDir 与 versions **都**为空——
 * 一个全空的池快照对排障零价值，渲染成"池：(空)"只会制造噪声。
 */
function normalizePool(v: unknown): InterpreterPool | null {
  const pool = obj(v);
  if (!pool) return null;
  const installDir = str(pool.install_dir) ?? '';
  const rawVersions = Array.isArray(pool.versions) ? pool.versions : [];
  const versions = rawVersions
    .map((x) => str(x))
    .filter((x): x is string => x !== null);
  if (installDir === '' && versions.length === 0) return null;
  return { installDir, versions };
}

/**
 * 从执行记录的 `result` 提取解释器留痕。
 *
 * 返回 null 的判据（调用方据此渲染"该执行未留痕"占位，而不是空白卡片）：
 *  - `result` 不是对象（null / 字符串 / 数组）；
 *  - `result.interpreter` 不是对象（历史执行记录、非解释器类失败）；
 *  - 对象存在但四个字段全为空（脏数据）——即 `interpreter: {}`。
 *
 * 部分字段缺失**不**返回 null：排障时"知道 requested=3.7 但不知道 reason"
 * 依然有用，缺的那几项由 UI 渲染 `—`。
 */
export function extractInterpreterContext(result: unknown): InterpreterContext | null {
  const container = obj(result);
  if (!container) return null;
  const raw = obj(container.interpreter);
  if (!raw) return null;
  const ctx: InterpreterContext = {
    requested: str(raw.requested),
    resolved: str(raw.resolved),
    reason: str(raw.reason),
    detail: str(raw.detail),
    pool: normalizePool(raw.pool),
  };
  const hasAny =
    ctx.requested !== null ||
    ctx.resolved !== null ||
    ctx.reason !== null ||
    ctx.detail !== null ||
    ctx.pool !== null;
  return hasAny ? ctx : null;
}

/**
 * 机器可读 reason → i18n 键后缀（`execDetail.interpreter.reason.*`）。
 * 未知值由调用方原样展示 token——宁可露出 `some_new_reason` 也不要显示
 * "未知原因"把可诊断的信息抹掉（与 failureReason 的 unrecognizedHint 同策）。
 */
export const INTERPRETER_REASON_T_KEY: Record<string, string> = {
  uv_missing: 'execDetail.interpreter.reason.uvMissing',
  not_downloadable: 'execDetail.interpreter.reason.notDownloadable',
  download_failed: 'execDetail.interpreter.reason.downloadFailed',
  cache_miss: 'execDetail.interpreter.reason.cacheMiss',
  corrupt: 'execDetail.interpreter.reason.corrupt',
  unavailable: 'execDetail.interpreter.reason.unavailable',
};

/**
 * 是否应展示"3.7 需离线预填"的专项指引。
 *
 * 判据是 requested 版本落在离线层（< 3.8）**或** reason 明确是
 * not_downloadable——两者任一成立，运维该做的动作都是同一件事（让部署方
 * 预填解释器缓存卷）。刻意不复用 executor-mode 的 runtimeVersionIsOfflineTier：
 * 那一支按可声明区间归一，而这里 requested 来自历史执行记录，可能已超出
 * 当前区间（版本区间将来可配置），不能因为"归一出 null"就丢掉这条指引。
 */
export function interpreterNeedsOfflinePrefill(ctx: InterpreterContext | null): boolean {
  if (!ctx) return false;
  if (ctx.reason === 'not_downloadable') return true;
  const requested = ctx.requested;
  if (requested === null) return false;
  const m = /^(\d+)\.(\d+)$/.exec(requested);
  if (!m) return false;
  return Number(m[1]) === 3 && Number(m[2]) < 8;
}
