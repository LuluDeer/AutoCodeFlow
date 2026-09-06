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

/** A persisted callback file gets this many retry rounds before it is moved
 *  to the dead-letter directory and stops being re-sent every second. */
const CALLBACK_FILE_MAX_RETRIES = 5;

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
    const response = await untilDeadline(post('/api/executions/callback', requests), null);
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

function readRetryCount(filepath: string): number {
  try {
    const raw = fs.readFileSync(`${filepath}.meta`, 'utf-8');
    const meta = JSON.parse(raw) as { retries?: number };
    return typeof meta.retries === 'number' && meta.retries >= 0 ? meta.retries : 0;
  } catch {
    return 0;
  }
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
        const retries = readRetryCount(filepath);
        if (retries >= CALLBACK_FILE_MAX_RETRIES) {
          deadLetterCallbackFile(filepath, `${retries} failed retry rounds`);
          continue;
        }
        if (fs.statSync(filepath).size > CALLBACK_FILE_MAX_SIZE_BYTES) {
          deadLetterCallbackFile(filepath, 'oversized payload');
          continue;
        }

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
  const BASE_DELAY_MS = 1000;
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
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
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
