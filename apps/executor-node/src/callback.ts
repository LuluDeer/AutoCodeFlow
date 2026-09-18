import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
// A6: 对账端点走 admin-client 的 get（自动带 per-executor 令牌 + failover），
// 响应是 admin ResponseInterceptor 的 {code,message,data} 信封，需 unwrap。
import { post, get } from './admin-client';
import { unwrapAdminResponseData } from './admin-envelope';
import {
  DEAD_LETTER_SIDECAR_SUFFIX,
  deadLetterPayloadName,
} from './dead-letter-sidecar';

/** Structured failure reason — the **runtime-available** list the type is derived
 *  from, so the A3 contract spec can assert it against
 *  `packages/executor-protocol/protocol.json` (此前只有类型，运行期无从校验)。
 *
 *  取值必须与 admin-api 的 ExecutionFailureReason **可上报子集**一致（全集减去
 *  admin 内部专用的 `stale_recovered`）；CallbackItemDto 用 @IsIn 校验，一个非法
 *  取值会让**整批**回调被拒。 */
export const CALLBACK_FAILURE_REASONS = [
  'package_fetch_failed',
  'dependency_install_failed',
  'git_fetch_failed',
  'runtime_missing',
  // WS5（python_task_upload_and_multiversion, CONTRACT.md §2.5）：解释器无法获取。
  // 紧跟 runtime_missing —— 两者都是"环境缺东西"，但处置完全不同：前者要装
  // 运行时二进制，后者要预填/下载解释器缓存池，绝不能混为一类。
  'interpreter_unavailable',
  // EXP-01（本轮体验审查）：沙箱已配置但不可用（bwrap 缺失等）。此前三端枚举
  // 都缺这个值，而 python 执行器早已产出它——回调 DTO 的 @IsIn 命中即 400，
  // 且 python 把 4xx 当不可重试、整批放弃，导致该机所有任务的终态回调永久
  // 丢失。node 侧目前不产出该值，但契约必须三端一致（本数组与 protocol.json
  // 的 executorReportable 逐值比对，见 executor-protocol-contract.spec.ts）。
  'sandbox_unavailable',
  'script_error',
  'timeout',
  'executor_offline',
  'executor_restart',
  'killed',
  'unknown',
] as const;

/** Structured failure reason — values must stay aligned with admin-api's
 *  ExecutionFailureReason enum (apps/admin-api/src/modules/task/entities/
 *  task-execution.entity.ts); CallbackItemDto validates with @IsIn and a
 *  rejected item fails the whole callback batch. */
export type CallbackFailureReason = (typeof CALLBACK_FAILURE_REASONS)[number];

export interface CallbackRequest {
  executionId: string;
  status: 'success' | 'failed';
  executorAddress?: string;
  exitCode?: number;
  logs?: string;
  errorMessage?: string;
  failureReason?: CallbackFailureReason;
  durationMs?: number;
  /** FEAT-05: 执行产物清单（best-effort，随终态回调上报，与 admin CallbackItemDto 对齐）。 */
  artifacts?: Array<{ name: string; size: number; sha256: string }>;
  /**
   * FR-12/AC-12a：结构化执行明细，admin 原样落进 `task_executions.result`。
   *
   * 目前承载解释器快照 `{ interpreter: { requested, resolved, reason, detail, pool } }`
   * ——与 python 侧 `_interpreter_failure_result`（execute.py:1036）同形。为什么
   * 必须带上：`errorMessage` 是给人看的一句话，而"该把这个任务派到哪台执行器"
   * 是调度侧的**机器输入**（pool 里已缓存哪些版本）。只发文本时，admin 侧要
   * 判断"是池里没有、还是下载失败、还是 uv 没装"就得去翻执行器日志。
   *
   * 注意 admin 的 CallbackItemDto 有白名单：未知**顶层**键会被静默剥离，而
   * `result` 是唯一被接受的结构化通道（IsBoundedJsonObject，4KB 上限）。
   */
  result?: Record<string, unknown>;
  /** OBS-01: dispatch 请求携带的 W3C traceparent（admin 追踪开启时存在）。 */
  traceparent?: string;
}

const callbackQueue: CallbackRequest[] = [];
// Real re-entry sentinel — the previous callbackThread variable was never
// assigned, so repeated startCallbackThread() calls spawned parallel loops.
let loopStarted = false;
let stopped = false;
let callbackLoopPromise: Promise<void> | null = null;
const CALLBACK_DRAIN_TIMEOUT_MS = 10_000;
let stopPromise: Promise<void> | null = null;
let drainExpired = false;
const deadlineListeners = new Set<() => void>();

// Remove listeners after each operation so normal operation does not retain
// every completed POST until shutdown. Late network rejections remain handled.
function untilDeadline<T>(operation: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const expire = () => resolve(fallback);
    deadlineListeners.add(expire);
    operation.then(resolve, reject).finally(() => deadlineListeners.delete(expire));
    if (drainExpired) expire();
  });
}

async function callbackDelay(ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await untilDeadline(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), undefined);
  } finally {
    clearTimeout(timer);
  }
}

// 9-1（audit-r4）：回调线程空闲等待的**事件唤醒**。旧实现固定
// `callbackDelay(1000)` 轮询——高回调吞吐下每批都白等至多 1s，且停机/唤醒
// 路径只能等下一个 tick。pushCallback 入队时调用 wakeCallbackThread() 立即
// 解除等待（竞速式：事件先到走事件，否则 1s 定时器兜底，循环必然推进）。
// 停机（stopped）期间不建等待，drain 语义不变。
let wakeCallbackLoop: (() => void) | null = null;

function wakeCallbackThread(): void {
  const wake = wakeCallbackLoop;
  wakeCallbackLoop = null;
  wake?.();
}

/** admin-api hard-rejects batches over 100 items (BadRequestException), so
 *  every send and every persisted file must respect this chunk size. */
const CALLBACK_BATCH_SIZE = 100;
let persistenceSequence = 0;

// E-05 (P2): 持久化回调的死信重试轮数上限。轮数上限只防毒丸文件（永不可达的
// 回调被无限重发占满磁盘），真正的保护是"时长型预算"——下方指数退避门控让整
// 个重发周期约为 24h 量级，足以覆盖 admin 的滚动升级窗口（期间 admin 完全
// 不可达、回调只能排队）。node 原固定 1s 间隔（5 轮≈1min）→ 改为 base 5s 指数
// 退避 cap 600s、轮数上限 150，实算时长预算：
//   Σ_{k=0..149} min(5s·2^k, 600s) = 635s + 143×600s = 86435s ≈ 24.0h
// （python 侧 base 1s/cap 600s/150 轮 ≈ 1023s + 140×600s ≈ 23.6h，两侧同量级。）
export const CALLBACK_FILE_MAX_RETRIES = 150;
// E-05: 持久化回调重发的指数退避门控（base 5s，cap 600s）——见上方注释。
export const CALLBACK_REPLAY_BACKOFF_BASE_MS = 5_000;
export const CALLBACK_REPLAY_BACKOFF_MAX_MS = 600_000;
// 门控 base 抽成可注入变量：固定计时器套件（callback.sharding.spec.ts）把 base
// 注入为 0 以恢复"即时重发"语义；生产默认 5s。这样门控既能落在真实时间上实现
// E-05 的时长预算，又不破坏基于冻结 Date.now() 的既有单测。
let replayBackoffBaseMs = CALLBACK_REPLAY_BACKOFF_BASE_MS;
export function setCallbackReplayBackoffBaseMs(ms: number): void {
  replayBackoffBaseMs = ms;
}
// E-44: 实时回调指数退避乘 (0.5 + Math.random()) 抖动系数，避免多 executor 在
// 同一 admin 恢复窗口后同步重试（惊群）。范围与 python _callback_retry_sleep_seconds 对齐。
const CALLBACK_LIVE_BASE_DELAY_MS = 1_000;
export function computeRetryBackoffMs(attempt: number, rng: () => number = Math.random): number {
  return CALLBACK_LIVE_BASE_DELAY_MS * Math.pow(2, attempt) * (0.5 + rng());
}

// Lazily computed so that config.workDir is resolved at call time, not at module load
function getCallbackDir(): string {
  const dir = path.join(config.workDir, 'callbacks');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getDeadLetterDir(): string {
  const dir = path.join(getCallbackDir(), 'dead-letter');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function withExecutorAddress(request: CallbackRequest): CallbackRequest {
  return {
    executorAddress: config.executorAddressPublic || config.executorAddress,
    ...request,
  };
}

/** OBS-01: 批次内第一个携带 traceparent 的执行决定回传头（同批多执行在
 *  实际流量中几乎同 trace——同一次触发；无 traceparent 时零头回传）。 */
function traceparentHeaderFor(requests: CallbackRequest[]): Record<string, string> {
  const traceparent = requests.find(r => r.traceparent)?.traceparent;
  return traceparent ? { traceparent } : {};
}

/**
 * B-2（中台↔执行器深度审查）：回调请求附 `x-executor-address` 头——admin 侧
 * 回调限流按此头做**执行器维度**计数，替代按出口 IP 计数（多执行器共享同一
 * NAT/机房出口 IP 时，按 IP 叠加的 60/min 档位会误杀整片回调，触发后与
 * stale sweep 的失败判定赛跑导致误判 FAILED）。admin 的
 * ExecutorAwareThrottlerGuard 优先读此头；旧执行器不带头时回退 IP 计数。
 * 值取自与请求体同源的 executorAddress（withExecutorAddress 同一表达式），
 * 不透传用户可控值。
 */
function executorAddressHeaderFor(): Record<string, string> {
  const address = config.executorAddressPublic || config.executorAddress;
  return address ? { 'x-executor-address': address } : {};
}

export function pushCallback(request: CallbackRequest): void {
  const callbackRequest = withExecutorAddress(request);
  const existingIndex = callbackQueue.findIndex(r => r.executionId === request.executionId);
  if (existingIndex !== -1) {
    callbackQueue[existingIndex] = callbackRequest;
    logger.debug(`Overwrote duplicate callback for execution ${request.executionId}`);
  } else {
    callbackQueue.push(callbackRequest);
    logger.debug(`Pushed callback for execution ${request.executionId}`);
  }
  // 9-1（audit-r4）：入队即唤醒回调线程——空闲等待立即解除，回调延迟从
  // 最高 1s 降到微任务级（1s 定时器仅作兜底）。
  wakeCallbackThread();
}

async function doCallback(requests: CallbackRequest[]): Promise<boolean> {
  try {
    // OBS-01: 回传 traceparent 头（admin 侧 execution-callback.controller 解析关联）
    // B-2: 附带 x-executor-address 头（admin 回调限流按执行器维度计数）。
    const response = await untilDeadline(
      post('/api/executions/callback', requests, {
        ...traceparentHeaderFor(requests),
        ...executorAddressHeaderFor(),
      }),
      null,
    );
    if (!response) return false;
    if (response.status >= 200 && response.status < 300) {
      logger.debug(`Callback successful for ${requests.length} execution(s)`);
      return true;
    }
    return false;
  } catch (error: unknown) {
    logger.warn(`Callback failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Persist failed callbacks in admin-acceptable chunks. A companion
 *  `<file>.meta` records the retry round so the re-send loop can give up
 *  after CALLBACK_FILE_MAX_RETRIES instead of retrying forever. */
function persistFailedCallbacks(requests: CallbackRequest[]): void {
  const timestamp = Date.now();
  const sequence = persistenceSequence++;
  try {
    const chunks: CallbackRequest[][] = [];
    for (let i = 0; i < requests.length; i += CALLBACK_BATCH_SIZE) {
      chunks.push(requests.slice(i, i + CALLBACK_BATCH_SIZE));
    }
    chunks.forEach((chunk, index) => {
      const suffix = chunks.length > 1 ? `-${index}` : '';
      const filename = path.join(getCallbackDir(), `callback-${timestamp}-${sequence}${suffix}.json`);
      fs.writeFileSync(filename, JSON.stringify(chunk, null, 2));
      fs.writeFileSync(`${filename}.meta`, JSON.stringify({ retries: 0, persistedAt: timestamp }), 'utf-8');
      logger.info(`Persisted ${chunk.length} failed callbacks to ${filename}`);
    });
  } catch (error: unknown) {
    logger.error(`Failed to persist callbacks: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * A6（DEEP_REVIEW §七）：死信侧车。
 *
 * 死信目录此前只有 payload 文件本身——**没有任何地方记录它为什么进来**。于
 * 是「admin 长时间不可达导致重发预算耗尽」（admin 恢复后值得重发）和「载荷
 * 本身是毒丸」（重发永远失败）在磁盘上无法区分，二者只能一律等人来看。
 *
 * 侧车就是这份缺失的上下文：`poison` 决定对账时能不能重发，`requeues` 决定
 * 还能救几次，`deadLetteredAt` 是对账水印的起点。
 *
 * 它**不是**回调：getDeadLetterCount / 保留扫描都只数 payload（见 file-logger
 * 的排除逻辑），侧车不进「积压了多少条没送出去的回调」这个运维指标。
 */
interface DeadLetterMeta {
  reason: string;
  /** true = 载荷本身不可送达（超大/坏 JSON），重发无意义，只能等人来看。 */
  poison: boolean;
  deadLetteredAt: number;
  /** 该文件被对账重新入队过几次（跨轮保存，见 writeRetryCount）。 */
  requeues: number;
}

function readDeadLetterMeta(payloadPath: string): DeadLetterMeta | null {
  try {
    const raw = fs.readFileSync(payloadPath + DEAD_LETTER_SIDECAR_SUFFIX, 'utf-8');
    const m = JSON.parse(raw) as Partial<DeadLetterMeta>;
    return {
      reason: typeof m.reason === 'string' ? m.reason : 'unknown',
      poison: m.poison === true,
      deadLetteredAt: typeof m.deadLetteredAt === 'number' ? m.deadLetteredAt : 0,
      requeues:
        typeof m.requeues === 'number' && m.requeues >= 0 ? m.requeues : 0,
    };
  } catch {
    return null;
  }
}

function writeDeadLetterMeta(payloadPath: string, meta: DeadLetterMeta): void {
  try {
    fs.writeFileSync(
      payloadPath + DEAD_LETTER_SIDECAR_SUFFIX,
      JSON.stringify(meta),
      'utf-8',
    );
  } catch {
    /* 侧车写不进去只影响对账精度，不影响 payload 本身 */
  }
}

function removeDeadLetterMeta(payloadPath: string): void {
  try {
    fs.unlinkSync(payloadPath + DEAD_LETTER_SIDECAR_SUFFIX);
  } catch {
    /* already gone */
  }
}

/** Move a permanently-failed callback file to the dead-letter directory so
 *  the retry loop stops resending it every second (network + log churn) but
 *  the payloads remain on disk for manual inspection/replay.
 *
 *  A6: `poison` 标记载荷本身是否不可送达——它决定对账能不能把文件救回重发
 *  队列（见 reconcileDeadLetters）。 */
function deadLetterCallbackFile(
  filepath: string,
  reason: string,
  poison = false,
): void {
  // requeues 由 live meta 携带（重新入队时写入），跨「死信→重发→再死信」
  // 循环继承，救回次数才不会被无限重置。
  const requeues = readRetryMeta(filepath).deadLetterRequeues || 0;
  try {
    const target = path.join(getDeadLetterDir(), path.basename(filepath));
    fs.renameSync(filepath, target);
    writeDeadLetterMeta(target, {
      reason,
      poison,
      deadLetteredAt: Date.now(),
      requeues,
    });
    logger.warn(
      `Callback file ${path.basename(filepath)} moved to dead-letter after ${reason}; manual replay required`,
    );
  } catch (error: unknown) {
    // Last resort: at least stop retrying it.
    try { fs.unlinkSync(filepath); } catch (_) { /* already gone */ }
    logger.error(
      `Failed to move callback file ${filepath} to dead-letter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    fs.unlinkSync(`${filepath}.meta`);
  } catch (_) { /* meta may not exist */ }
}

/** E-05: 读取持久化回调的 .meta：重试轮数 + 上次尝试时间戳（updatedAt，缺省
 *  回退 persistedAt）。上次尝试时间戳驱动下方指数退避门控，避免每秒重发。 */
function readRetryMeta(filepath: string): {
  retries: number;
  updatedAt: number;
  deadLetterRequeues: number;
} {
  try {
    const raw = fs.readFileSync(`${filepath}.meta`, 'utf-8');
    const meta = JSON.parse(raw) as {
      retries?: number;
      updatedAt?: number;
      persistedAt?: number;
      deadLetterRequeues?: number;
    };
    const retries = typeof meta.retries === 'number' && meta.retries >= 0 ? meta.retries : 0;
    const updatedAt =
      typeof meta.updatedAt === 'number' ? meta.updatedAt
        : (typeof meta.persistedAt === 'number' ? meta.persistedAt : 0);
    const requeues =
      typeof meta.deadLetterRequeues === 'number' && meta.deadLetterRequeues >= 0
        ? meta.deadLetterRequeues
        : 0;
    return { retries, updatedAt, deadLetterRequeues: requeues };
  } catch {
    return { retries: 0, updatedAt: 0, deadLetterRequeues: 0 };
  }
}

function _readRetryCount(filepath: string): number {
  return readRetryMeta(filepath).retries;
}

function writeRetryCount(
  filepath: string,
  retries: number,
  deadLetterRequeues?: number,
): void {
  try {
    // A6: 未显式给出时保留原值——重新入队路径只改 retries，不能顺手把
    // 「已经被救过几次」抹掉（那会让毒丸文件无限往返）。
    const prev = readRetryMeta(filepath).deadLetterRequeues;
    fs.writeFileSync(
      `${filepath}.meta`,
      JSON.stringify({
        retries,
        updatedAt: Date.now(),
        deadLetterRequeues: deadLetterRequeues ?? prev,
      }),
      'utf-8',
    );
  } catch (error: unknown) {
    logger.warn(`Failed to update retry counter for ${filepath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Dead-letter files still inside the live callbacks dir from an older
 *  layout would be retried forever — keep a hard stop as belt-and-suspenders. */
const CALLBACK_FILE_MAX_SIZE_BYTES = 64 * 1024 * 1024;

async function retryFailedCallbacks(): Promise<void> {
  try {
    const callbackDir = getCallbackDir();
    const files = fs.readdirSync(callbackDir);
    for (const file of files) {
      if (stopped) break;
      if (!file.startsWith('callback-') || !file.endsWith('.json')) continue;

      const filepath = path.join(callbackDir, file);
      try {
        const meta = readRetryMeta(filepath);
        const retries = meta.retries;
        if (retries >= CALLBACK_FILE_MAX_RETRIES) {
          // A6: poison=false —— admin 恢复后这份回调仍可能救得回来。
          deadLetterCallbackFile(filepath, `${retries} failed retry rounds`, false);
          continue;
        }
        if (fs.statSync(filepath).size > CALLBACK_FILE_MAX_SIZE_BYTES) {
          deadLetterCallbackFile(filepath, 'oversized payload', true);
          continue;
        }
        // E-05: 指数退避门控（见上方常量注释）。轮数上限只防毒丸文件；时长预算
        // 约 24h 量级覆盖 admin 滚动升级窗口。首轮 meta.updatedAt 缺省回退到较早的
        // persistedAt，门控必然通过 → 即时重发；后续轮按 base*2**retries（cap 600s）。
        const gateMs = Math.min(
          replayBackoffBaseMs * Math.pow(2, retries),
          CALLBACK_REPLAY_BACKOFF_MAX_MS,
        );
        if (meta.updatedAt && Date.now() - meta.updatedAt < gateMs) continue;

        const content = fs.readFileSync(filepath, 'utf-8');
        const requests = JSON.parse(content) as CallbackRequest[];

        const success = await doCallback(requests);
        if (drainExpired) return; // Already durable; do not count an interrupted retry.
        if (success) {
          fs.unlinkSync(filepath);
          try { fs.unlinkSync(`${filepath}.meta`); } catch (_) { /* meta may not exist */ }
          logger.info(`Retried and removed ${filepath}`);
        } else {
          const next = retries + 1;
          if (next >= CALLBACK_FILE_MAX_RETRIES) {
            deadLetterCallbackFile(filepath, `${next} failed retry rounds`, false);
          } else {
            writeRetryCount(filepath, next);
          }
        }
      } catch (error: unknown) {
        // Corrupt/unparseable poison files would never succeed — dead-letter
        // them instead of burning a re-send every second forever.
        if (error instanceof SyntaxError) {
          deadLetterCallbackFile(filepath, 'corrupt payload', true);
          continue;
        }
        logger.warn(`Failed to retry callback file ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error: unknown) {
    logger.error(`Error during callback retry: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// A6（DEEP_REVIEW §七）：死信目录定期对账
//
// 死信此前是**单向终点**：文件进去就再也出不来，只能靠人发现。但两类死信的
// 处置其实完全相反——
//
//   ① 重发预算耗尽（E-05，约 24h）：典型成因是 admin 长时间不可达。admin 恢复
//      后该执行可能仍是 RUNNING（admin 的 stale sweep 要等执行器心跳超时才跑），
//      此时**回调是 admin 唯一能得知结果、并释放执行器槽位的通道**，重发有价值。
//   ② 毒丸（>64MB / 坏 JSON）：重发永远失败，只等人来看。
//
// 区分二者必须问 admin「这条执行终态了没有」—— GET /executors/:address/
// terminal-states 就是这个问句。对账据此分三层处置：终态→删；未终态且非毒丸
// →重新入队重发；未终态但毒丸或救回次数用尽→保留待人工。
//
// 设计约束（都是踩过的坑，改这里前请先读）：
//   - **零死信则零请求**：健康执行器不产生任何额外流量，对账不是新的心跳。
//   - **取不到就什么都不做**：admin 不可达 / 响应形状不对时一律原样返回，
//     绝不能把「没拿到终态清单」误读成「都没终态」然后一股脑重发（那会把
//     毒丸文件重新推回重发队列，白烧一轮 24h 预算）。
//   - **救回次数有上限**：执行行若在 admin 侧已被删除，永远查不到终态，没有
//     上限会让文件在 死信→重发→再死信 之间无限往返。
// ---------------------------------------------------------------------------

/** 对账周期。死信是低频事件（要耗尽 24h 重发预算才产生），没必要秒级问。 */
export const DEAD_LETTER_RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
/** 单份死信最多被救回几次。3 次 ≈ 3 个重发预算期，足够覆盖反复断连。 */
export const DEAD_LETTER_MAX_REQUEUES = 3;
/** since 水印向前多看的余量，吸收 admin↔执行器时钟偏差（偏一点就漏行）。 */
export const DEAD_LETTER_SINCE_SKEW_MS = 5 * 60 * 1000;
/** 与 admin 侧 TERMINAL_STATES_MAX_LOOKBACK_MS 对齐的上界。 */
export const DEAD_LETTER_MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** 单页条数（与 admin 默认页一致）。 */
export const DEAD_LETTER_RECONCILE_LIMIT = 500;
/** 超过此大小的死信不解析：它多半就是"超大载荷"死信本身，为拿一个
 *  executionId 去 JSON.parse 几十 MB 不划算（秒级 + 百 MB 内存）。留给人工。 */
const DEAD_LETTER_MAX_PARSE_BYTES = 8 * 1024 * 1024;

export interface DeadLetterReconcileResult {
  scanned: number;
  /** admin 已终态 → 回调作废，删除。 */
  deleted: number;
  /** admin 仍未终态 + 非毒丸 → 重新入队重发。 */
  requeued: number;
  /** 毒丸或救回次数用尽 → 保留待人工。 */
  kept: number;
  /** 无 payload 的孤儿侧车清理数（payload 被 TTL 清掉了）。 */
  orphans: number;
  /** 太大不解析 / 取不到 executionId / 文件操作失败。 */
  skipped: number;
  /** admin 返回的终态条数；-1 = 这一轮没取到（不可达或形状不对），未做任何处置。 */
  fetched: number;
  hasMore: boolean;
}

interface TerminalStatesPayload {
  items: string[];
  hasMore: boolean;
}

/** 拉取终态清单。拿不到（不可达 / 形状不对）返回 null——调用方据此整体放弃，
 *  **绝不**退化成"空清单"。 */
async function fetchTerminalStates(
  address: string,
  since: number,
): Promise<TerminalStatesPayload | null> {
  const url =
    `/api/executors/${encodeURIComponent(address)}/terminal-states` +
    `?since=${encodeURIComponent(new Date(since).toISOString())}` +
    `&limit=${DEAD_LETTER_RECONCILE_LIMIT}`;
  const response = await untilDeadline(
    // 包一层：get() 若同步抛错（mock / 早期失败）也要走 reject 而不是炸栈。
    Promise.resolve().then(() => get<Record<string, unknown>>(url)),
    null,
  );
  if (!response) return null;
  const payload = unwrapAdminResponseData(response.data);
  const items = (payload as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  const ids = items
    .map((it) => (it as { executionId?: unknown })?.executionId)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return {
    items: ids,
    hasMore: (payload as { hasMore?: unknown } | null)?.hasMore === true,
  };
}

/**
 * 对账一轮。见上方块注释的三条设计约束。
 */
export async function reconcileDeadLetters(): Promise<DeadLetterReconcileResult> {
  const result: DeadLetterReconcileResult = {
    scanned: 0,
    deleted: 0,
    requeued: 0,
    kept: 0,
    orphans: 0,
    skipped: 0,
    fetched: -1,
    hasMore: false,
  };

  let deadDir: string;
  let entries: string[];
  try {
    // 刻意**不**用 getDeadLetterDir()：那会 mkdir。对账是只读动作，在没有
    // 死信的健康执行器上不该凭空造出一个空目录（既有单测断言 callbacks/ 下
    // 除 payload 外没有别的条目，见 callback.spec "drains entries queued at
    // stop"）。目录不存在就是「零死信」，直接返回。
    deadDir = path.join(config.workDir, 'callbacks', 'dead-letter');
    entries = fs.readdirSync(deadDir);
  } catch {
    return result;
  }

  const payloads = entries.filter(
    (f) =>
      f.startsWith('callback-') &&
      f.endsWith('.json') &&
      deadLetterPayloadName(f) === null,
  );
  const payloadSet = new Set(payloads);

  // 孤儿侧车：payload 已被 TTL 清理（file-logger 的 removeOlderThan 只认
  // files，不认识侧车），侧车会一直留着。
  for (const f of entries) {
    const owner = deadLetterPayloadName(f);
    if (owner === null) continue;
    if (payloadSet.has(owner)) continue;
    try {
      fs.unlinkSync(path.join(deadDir, f));
      result.orphans++;
    } catch {
      /* raced */
    }
  }

  // 健康路径：没有死信就一个请求都不发。
  if (payloads.length === 0) return result;

  type Item = {
    file: string;
    ids: string[];
    poison: boolean;
    requeues: number;
  };
  const items: Item[] = [];
  let oldest = Date.now();
  for (const file of payloads) {
    const fp = path.join(deadDir, file);
    let mtime = Date.now();
    let size = 0;
    try {
      const st = fs.statSync(fp);
      mtime = Math.floor(st.mtimeMs);
      size = st.size;
    } catch {
      continue;
    }
    const meta = readDeadLetterMeta(fp);
    result.scanned++;
    // 侧车缺失（老版本执行器留下的死信）时用文件 mtime 当水印起点——比
    // "当作刚刚死信"保守得多，能覆盖到它真正的时间窗。
    oldest = Math.min(oldest, meta?.deadLetteredAt || mtime);

    if (size > DEAD_LETTER_MAX_PARSE_BYTES) {
      result.skipped++;
      continue;
    }
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8')) as unknown;
      if (Array.isArray(parsed)) {
        ids = parsed
          .map((x) => (x as { executionId?: unknown })?.executionId)
          .filter((v): v is string => typeof v === 'string' && v.length > 0);
      }
    } catch {
      // 坏 JSON —— 毒丸，解析不出 executionId 就无从对账，留给人工。
    }
    if (ids.length === 0) {
      result.skipped++;
      continue;
    }
    items.push({
      file,
      ids,
      poison: meta?.poison ?? false,
      requeues: meta?.requeues ?? 0,
    });
  }
  if (items.length === 0) return result;

  const since = Math.max(
    oldest - DEAD_LETTER_SINCE_SKEW_MS,
    Date.now() - DEAD_LETTER_MAX_LOOKBACK_MS,
  );
  const address = config.executorAddressPublic || config.executorAddress;

  let terminal: Set<string>;
  try {
    const fetched = await fetchTerminalStates(address, since);
    if (!fetched) {
      logger.warn(
        'Dead-letter reconciliation skipped: could not read terminal states from admin; dead-letter files left untouched',
      );
      return result;
    }
    terminal = new Set(fetched.items);
    result.fetched = terminal.size;
    result.hasMore = fetched.hasMore;
    if (fetched.hasMore) {
      logger.warn(
        `Dead-letter reconciliation got a partial page (${terminal.size} terminal states, hasMore=true); remaining files handled next round`,
      );
    }
  } catch (error: unknown) {
    logger.warn(
      `Dead-letter reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return result;
  }

  for (const item of items) {
    const fp = path.join(deadDir, item.file);
    if (item.ids.every((id) => terminal.has(id))) {
      // admin 早有终态 —— 这份回调再发一次也只是被幂等丢弃，删掉。
      try {
        fs.unlinkSync(fp);
        removeDeadLetterMeta(fp);
        result.deleted++;
        logger.info(
          `Dead-letter ${item.file} dropped: admin already recorded a terminal state`,
        );
      } catch (error: unknown) {
        result.skipped++;
        logger.warn(
          `Failed to drop reconciled dead-letter ${item.file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }

    if (!item.poison && item.requeues < DEAD_LETTER_MAX_REQUEUES) {
      // admin 仍未终态：回调是它唯一的结果通道，救回重发队列。轮数归零 →
      // 重新走完整的 24h 时长预算；requeues+1 写进 meta，下一轮死信侧车继承。
      try {
        const live = path.join(getCallbackDir(), item.file);
        fs.renameSync(fp, live);
        removeDeadLetterMeta(fp);
        writeRetryCount(live, 0, item.requeues + 1);
        result.requeued++;
        logger.warn(
          `Dead-letter ${item.file} re-queued for retry (attempt ${item.requeues + 1}/${DEAD_LETTER_MAX_REQUEUES}): admin has no terminal state yet`,
        );
      } catch (error: unknown) {
        result.skipped++;
        logger.warn(
          `Failed to re-queue dead-letter ${item.file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }

    result.kept++;
  }
  return result;
}

async function processCallbacksWithBackoff(requests: CallbackRequest[]): Promise<void> {
  // 7-1（audit-r4）：两套重试预算，语义不同、互不替代——
  //   1. 这里的 MAX_RETRIES=5 是**实时发送**预算：内存队列里当前这一批对
  //      admin 的即时重试（base 1s 指数退避 + 抖动，见 computeRetryBackoffMs），
  //      5 次内未送达 → 落盘转持久化通道；
  //   2. 落盘后的重发走 retryFailedCallbacks 的 CALLBACK_FILE_MAX_RETRIES=150
  //      轮预算（base 5s 指数退避 cap 600s ≈ 24h 时长预算，见 115 行注释）。
  //  前者管「瞬态失败尽快送达」，后者管「长时间停机/毒丸文件有界收敛」。
  const MAX_RETRIES = 5;
  // admin-api rejects batches > 100 outright — a batch larger than that would
  // fail all 5 attempts and then poison the persisted file forever.
  const failed: CallbackRequest[] = [];
  for (let i = 0; i < requests.length; i += CALLBACK_BATCH_SIZE) {
    if (drainExpired) {
      failed.push(...requests.slice(i));
      break;
    }
    const chunk = requests.slice(i, i + CALLBACK_BATCH_SIZE);
    let delivered = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      delivered = await doCallback(chunk);
      if (delivered || drainExpired) break;
      logger.warn(`Callback attempt ${attempt + 1}/${MAX_RETRIES} failed for ${chunk.length} item(s)`);
      if (attempt < MAX_RETRIES - 1) {
        const delay = computeRetryBackoffMs(attempt);
        await callbackDelay(delay);
        if (drainExpired) break;
      }
    }
    if (!delivered) failed.push(...chunk);
  }
  if (failed.length > 0) {
    logger.error(`Callback failed after ${MAX_RETRIES} attempts, persisting ${failed.length} item(s) to disk`);
    persistFailedCallbacks(failed);
  }
}

// A6: 死信对账的节流状态（常量见上方 A6 段）。lastDeadLetterReconcileAt=0 →
// 线程启动后的第一轮就会对账一次（启动时往往正有上一轮运行留下的死信）。
let lastDeadLetterReconcileAt = 0;
let deadLetterReconcileInFlight = false;
let deadLetterReconcileIntervalMs = DEAD_LETTER_RECONCILE_INTERVAL_MS;
/** 测试用：把对账周期注入为 0 以强制每轮都对账。 */
export function setDeadLetterReconcileIntervalMs(ms: number): void {
  deadLetterReconcileIntervalMs = ms;
}

async function processCallbacks(): Promise<void> {
  while (!stopped || callbackQueue.length > 0) {
    try {
      if (callbackQueue.length > 0) {
        const requests = [...callbackQueue];
        callbackQueue.length = 0;
        await processCallbacksWithBackoff(requests);
      }

      await retryFailedCallbacks();

      // A6: 死信对账——低频（默认 10min）、只读、失败无副作用。stopped 时不跑：
      // 停机排空期间不该再发起新的 admin 请求。
      if (
        !stopped &&
        !deadLetterReconcileInFlight &&
        Date.now() - lastDeadLetterReconcileAt >= deadLetterReconcileIntervalMs
      ) {
        deadLetterReconcileInFlight = true;
        lastDeadLetterReconcileAt = Date.now();
        try {
          await reconcileDeadLetters();
        } catch (error: unknown) {
          logger.warn(
            `Dead-letter reconciliation error: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          deadLetterReconcileInFlight = false;
        }
      }
    } catch (error: unknown) {
      logger.error(`Callback thread error: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (stopped && callbackQueue.length === 0) break;
    if (!stopped) {
      // 9-1（audit-r4）：事件唤醒 + 定时器兜底的竞速等待（pushCallback 入队
      // 即唤醒，见 wakeCallbackThread）。兜底定时器沿用 1s，保证停机/竞态下
      // 循环必然推进；wakeCallbackLoop 在竞速结束置空，避免悬挂引用。
      await Promise.race([
        new Promise<void>((resolve) => {
          wakeCallbackLoop = resolve;
        }),
        callbackDelay(1000),
      ]);
      wakeCallbackLoop = null;
    }
  }
}

export function startCallbackThread(): void {
  if (loopStarted) return;
  loopStarted = true;
  stopped = false;
  stopPromise = null;
  drainExpired = false;
  // A6: 重置对账节流——重开的线程应该立刻对一次账，而不是继承上次的时点。
  lastDeadLetterReconcileAt = 0;
  logger.info('Starting callback thread');
  callbackLoopPromise = processCallbacks().catch(error => {
    logger.error(`Callback thread stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export function stopCallbackThread(): Promise<void> {
  if (stopPromise) return stopPromise;
  if (!loopStarted || !callbackLoopPromise) return Promise.resolve();
  stopped = true;
  logger.info('Stopping callback thread and draining pending callbacks');
  const timer = setTimeout(() => {
    drainExpired = true;
    for (const expire of deadlineListeners) expire();
    deadlineListeners.clear();
  }, CALLBACK_DRAIN_TIMEOUT_MS);
  // The consumer owns in-flight payloads as well as the queue, so it must
  // persist unconfirmed results before stop resolves, even after the deadline.
  stopPromise = callbackLoopPromise.finally(() => {
    clearTimeout(timer);
    loopStarted = false;
    callbackLoopPromise = null;
  });
  return stopPromise;
}

export function getPendingCallbackCount(): number {
  return callbackQueue.length;
}
