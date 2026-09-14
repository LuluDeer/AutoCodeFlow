import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
import { post } from './admin-client';

/** Structured failure reason — values must stay aligned with admin-api's
 *  ExecutionFailureReason enum (apps/admin-api/src/modules/task/entities/
 *  task-execution.entity.ts); CallbackItemDto validates with @IsIn and a
 *  rejected item fails the whole callback batch. */
export type CallbackFailureReason =
  | 'package_fetch_failed'
  | 'dependency_install_failed'
  | 'git_fetch_failed'
  | 'runtime_missing'
  | 'script_error'
  | 'timeout'
  | 'executor_offline'
  | 'executor_restart'
  | 'killed'
  | 'unknown';

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
}

async function doCallback(requests: CallbackRequest[]): Promise<boolean> {
  try {
    // OBS-01: 回传 traceparent 头（admin 侧 execution-callback.controller 解析关联）
    const response = await untilDeadline(
      post('/api/executions/callback', requests, traceparentHeaderFor(requests)),
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

/** Move a permanently-failed callback file to the dead-letter directory so
 *  the retry loop stops resending it every second (network + log churn) but
 *  the payloads remain on disk for manual inspection/replay. */
function deadLetterCallbackFile(filepath: string, reason: string): void {
  try {
    const target = path.join(getDeadLetterDir(), path.basename(filepath));
    fs.renameSync(filepath, target);
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
function readRetryMeta(filepath: string): { retries: number; updatedAt: number } {
  try {
    const raw = fs.readFileSync(`${filepath}.meta`, 'utf-8');
    const meta = JSON.parse(raw) as { retries?: number; updatedAt?: number; persistedAt?: number };
    const retries = typeof meta.retries === 'number' && meta.retries >= 0 ? meta.retries : 0;
    const updatedAt =
      typeof meta.updatedAt === 'number' ? meta.updatedAt
        : (typeof meta.persistedAt === 'number' ? meta.persistedAt : 0);
    return { retries, updatedAt };
  } catch {
    return { retries: 0, updatedAt: 0 };
  }
}

function readRetryCount(filepath: string): number {
  return readRetryMeta(filepath).retries;
}

function writeRetryCount(filepath: string, retries: number): void {
  try {
    fs.writeFileSync(`${filepath}.meta`, JSON.stringify({ retries, updatedAt: Date.now() }), 'utf-8');
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
          deadLetterCallbackFile(filepath, `${retries} failed retry rounds`);
          continue;
        }
        if (fs.statSync(filepath).size > CALLBACK_FILE_MAX_SIZE_BYTES) {
          deadLetterCallbackFile(filepath, 'oversized payload');
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
            deadLetterCallbackFile(filepath, `${next} failed retry rounds`);
          } else {
            writeRetryCount(filepath, next);
          }
        }
      } catch (error: unknown) {
        // Corrupt/unparseable poison files would never succeed — dead-letter
        // them instead of burning a re-send every second forever.
        if (error instanceof SyntaxError) {
          deadLetterCallbackFile(filepath, 'corrupt payload');
          continue;
        }
        logger.warn(`Failed to retry callback file ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error: unknown) {
    logger.error(`Error during callback retry: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function processCallbacksWithBackoff(requests: CallbackRequest[]): Promise<void> {
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

async function processCallbacks(): Promise<void> {
  while (!stopped || callbackQueue.length > 0) {
    try {
      if (callbackQueue.length > 0) {
        const requests = [...callbackQueue];
        callbackQueue.length = 0;
        await processCallbacksWithBackoff(requests);
      }

      await retryFailedCallbacks();
    } catch (error: unknown) {
      logger.error(`Callback thread error: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (stopped && callbackQueue.length === 0) break;
    if (!stopped) await callbackDelay(1000);
  }
}

export function startCallbackThread(): void {
  if (loopStarted) return;
  loopStarted = true;
  stopped = false;
  stopPromise = null;
  drainExpired = false;
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
