/**
 * 推理质量轮（2026-10）：LLM 调用的**分类重试 + 指数退避**。
 *
 * ## 为什么不能「抛了就再试一次」
 * 原实现（`AgentRuntimeService.callLlmWithRetry`）只有一条规则：抛异常就等
 * 250ms 再试一次。两条缺陷在真实故障里都会咬人：
 *
 *   ① **对确定性错误重试**——401 密钥失效、400 上下文超长、403 无配额、
 *      422 参数错，重试除了把失败推迟 250ms、把账单翻一倍以外没有任何作用，
 *      还会把「配置错了」伪装成「偶发抖动」，让运维照着「再试一次」的方向排查。
 *   ② **退避是常数**——provider 抖动时 Agent 队列的 2 个 worker 会在同一毫秒
 *      同时重试，把「一次抖动」放大成「一次小风暴」。
 *
 * ## 参考实现与取舍
 * 判据对齐 langgraph `default_retry_on`（连接错误 / 5xx 重试；`ValueError`
 * 一类确定性错误重试无意义）与 langchain `ModelRetryMiddleware`（指数退避
 * `initial * factor^n`、上限 `max_delay`、±25% 抖动，默认 2 次重试）。
 *
 * 与参考实现的**差异**（都是本项目语义带来的）：
 *   · **多一道墙钟截止**：会话预算（`agent.budget.wallClockMs`）是硬闸门，
 *     重试发生在两道闸门之间。若这一觉睡完预算已到期，重试注定被下一轮
 *     闸门判死，白等 8s 且白烧一次令牌——因此重试前先问截止时间。
 *   · **纯函数 + 可注入时钟/随机源/sleep**：退避与分类是「只在故障时才走到」
 *     的分支，用真实定时器测它既慢又抖；同 `agent-context.ts` 的理由，做成
 *     不依赖网络的纯模块，单测直接钉住每次重试的间隔与判据。
 *
 * ## 不重试什么（比「重试什么」更重要）
 * 4xx 里的 400/401/403/404/409/422 —— 它们由**我们的请求内容或凭据**决定，
 * 同一请求重发必然同样失败。上下文档位超长尤其关键：这类错误只能靠折叠
 * 上下文解决（见 `agent-context.ts`），重试只会烧钱。
 */

/** 重试策略（与 langchain ModelRetryMiddleware 的参数一一对应）。 */
export interface RetryPolicy {
  /** 总尝试次数（含首次），>= 1。默认 3 = 首次 + 2 次重试。 */
  maxAttempts: number;
  /** 首次重试前的等待（毫秒）。 */
  initialDelayMs: number;
  /** 退避倍数：第 n 次重试等待 `initial * factor^n`。 */
  backoffFactor: number;
  /** 单次等待上限（毫秒）——指数退避必须有天花板。 */
  maxDelayMs: number;
  /** 抖动比例（0.25 = ±25%）。多实例同时重试时打散；0 = 关闭（测试）。 */
  jitterRatio: number;
}

/**
 * 默认策略：1s → 2s（上限 8s），共 3 次尝试。
 *
 * 为什么是 3 次而不是 5 次：Agent 的单次推理已经很长（qwen 超时默认 120s），
 * 5 次尝试在最坏情况下会把「一个会话卡 10 分钟」变成常态，而会话预算只有
 * 30 分钟。宁可如实失败，让 `resume` 去续（会话状态是持久化的，续跑不丢
 * 上下文），也不要在一次 run 里死磕。
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  backoffFactor: 2,
  maxDelayMs: 8_000,
  jitterRatio: 0.25,
};

/** 瞬态网络/网关类错误码（axios / Node 通用）。 */
const RETRYABLE_NET_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
]);

/** 可重试的 HTTP 状态码：超时 / 过早 / 限流 / 5xx（5xx 由前缀判定）。 */
const RETRYABLE_STATUS = new Set([408, 425, 429]);

/**
 * 文本兜底：仅当错误体没有结构化状态码时才看文案。
 *
 * **刻意窄**：只认明确表达「限流 / 连接中断 / 网关故障」的词。不认裸数字——
 * 形如 `max_tokens must be <= 500` 的消息里有个 500，把它当 5xx 重试等于
 * 用一次真实调用去验证一个永远不会变的参数错误。
 */
const RETRYABLE_TEXT_RES: ReadonlyArray<RegExp> = [
  /rate limit|too many requests/i,
  /\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|\bECONNABORTED\b/i,
  /socket hang up|connection reset|network error/i,
  /(?:upstream|server|gateway|service)\s*(?:error|unavailable)?\s*[:#-]?\s*5\d{2}\b/i,
  /\b5\d{2}\b\s*(?:bad gateway|service unavailable|internal server error|gateway timeout)/i,
  /bad gateway|service unavailable|gateway timeout|internal server error/i,
];

/** 从各种错误形状里读 HTTP 状态码（axios / Nest / 自定义包装）。 */
function readStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  const response = e.response as { status?: unknown } | undefined;
  const candidates = [
    response?.status,
    e.status,
    e.statusCode,
    typeof e.getStatus === "function"
      ? (e.getStatus as () => unknown).call(err)
      : undefined,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 100 && n <= 599) return n;
  }
  return null;
}

/** 从错误里读 axios/Node 的错误码。 */
function readCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const code = (err as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err ?? "");
}

/**
 * 这一次失败值不值得重试？
 *
 * 判定顺序固定（结构化状态码 → 错误码 → 文案），同一份错误总是得到同一个
 * 结论——否则 `autoflow_agent_llm_retry_total` 的分布会漂移。
 * 主动中止（AbortError）**不重试**：那是调用方收手的信号，重发等于对抗它。
 */
export function isRetryableLlmError(err: unknown): boolean {
  if (!err) return false;

  const name = (err as { name?: unknown }).name;
  if (name === "AbortError" || name === "CanceledError") return false;

  const status = readStatus(err);
  if (status !== null) {
    if (RETRYABLE_STATUS.has(status)) return true;
    if (status >= 500 && status <= 599) return true;
    // 其余带状态码的（含全部 4xx）都是确定性失败
    return false;
  }

  const code = readCode(err);
  if (code) {
    if (RETRYABLE_NET_CODES.has(code)) return true;
    // 有 code 但不认识（如 ERR_BAD_REQUEST）→ 不猜，交给文案判定
  }

  const message = readMessage(err);
  return RETRYABLE_TEXT_RES.some((re) => re.test(message));
}

/** 归一化外部传入的策略（脏值回落默认——重试策略坏了不该让会话直接失败）。 */
export function normalizeRetryPolicy(
  policy?: Partial<RetryPolicy> | null,
): RetryPolicy {
  const p = { ...DEFAULT_RETRY_POLICY, ...(policy ?? {}) };
  const positive = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    maxAttempts: Math.max(1, Math.floor(positive(p.maxAttempts, DEFAULT_RETRY_POLICY.maxAttempts))),
    initialDelayMs: positive(p.initialDelayMs, DEFAULT_RETRY_POLICY.initialDelayMs),
    backoffFactor:
      Number.isFinite(Number(p.backoffFactor)) && Number(p.backoffFactor) >= 1
        ? Number(p.backoffFactor)
        : DEFAULT_RETRY_POLICY.backoffFactor,
    maxDelayMs: positive(p.maxDelayMs, DEFAULT_RETRY_POLICY.maxDelayMs),
    jitterRatio:
      Number.isFinite(Number(p.jitterRatio)) && Number(p.jitterRatio) >= 0
        ? Number(p.jitterRatio)
        : DEFAULT_RETRY_POLICY.jitterRatio,
  };
}

/**
 * 第 n 次重试（0 起）的等待毫秒数——指数增长 + 上限 + 对称抖动。
 *
 * 与 langchain `calculate_delay` 同构：`min(initial * factor^n, max)`，
 * 再叠 `±jitterRatio`（结果下限 0）。抖动是**对称**的（不是只加不减），
 * 长期期望不变，不会把平均等待悄悄拉长。
 */
export function computeBackoffDelay(
  retryNumber: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const n = Math.max(0, Math.floor(retryNumber));
  const base = Math.min(
    policy.initialDelayMs * Math.pow(policy.backoffFactor, n),
    policy.maxDelayMs,
  );
  if (policy.jitterRatio <= 0 || base <= 0) return Math.max(0, Math.round(base));
  // random() ∈ [0,1) → 偏移 ∈ [-1,1)
  const offset = (random() * 2 - 1) * policy.jitterRatio;
  return Math.max(0, Math.round(base * (1 + offset)));
}

/** 一次重试尝试的观测事件（运行时据此打点/记日志）。 */
export interface RetryEvent {
  /** 第几次尝试失败（1 起）。 */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: unknown;
}

/** 放弃重试的原因。 */
export type RetryGiveUpReason = "exhausted" | "fatal" | "deadline";

export interface RetryGiveUp {
  attempts: number;
  error: unknown;
  reason: RetryGiveUpReason;
}

export interface LlmRetryOptions {
  policy?: Partial<RetryPolicy> | null;
  /**
   * 墙钟截止（epoch ms）。`now() + delay > deadlineAt` 时不再重试——睡完
   * 大概率已被预算闸门判死，白等还白烧一次调用。
   */
  deadlineAt?: number | null;
  /** 注入时钟/随机源/sleep（测试用；生产用真实实现）。 */
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 覆盖判据（默认 `isRetryableLlmError`）。 */
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (evt: RetryEvent) => void;
  onGiveUp?: (info: RetryGiveUp) => void;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带分类重试地执行一次 LLM 调用。
 *
 * **只在抛出时重试**——此时还没有任何工具副作用，重发是安全的；而「模型
 * 返回了内容但不合法」属于协议问题，不在这里兜。
 *
 * 最终失败时**抛出最后一个原始错误**（不包装）：上游的失败原因（401 密钥
 * 失效 / 502 网关）是运维判读的第一手信息，包装会把它埋掉。
 */
export async function withLlmRetry<T>(
  call: () => Promise<T>,
  options: LlmRetryOptions = {},
): Promise<T> {
  const policy = normalizeRetryPolicy(options.policy);
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? realSleep;
  const shouldRetry = options.shouldRetry ?? isRetryableLlmError;

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      lastError = err;

      if (!shouldRetry(err)) {
        options.onGiveUp?.({ attempts: attempt, error: err, reason: "fatal" });
        throw err;
      }
      if (attempt >= policy.maxAttempts) {
        options.onGiveUp?.({
          attempts: attempt,
          error: err,
          reason: "exhausted",
        });
        throw err;
      }

      const delayMs = computeBackoffDelay(attempt - 1, policy, random);
      if (
        typeof options.deadlineAt === "number" &&
        now() + delayMs > options.deadlineAt
      ) {
        options.onGiveUp?.({ attempts: attempt, error: err, reason: "deadline" });
        throw err;
      }

      options.onRetry?.({
        attempt,
        maxAttempts: policy.maxAttempts,
        delayMs,
        error: err,
      });
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  // 不可达（循环内必 return 或 throw）；仅为类型收敛
  throw lastError;
}
