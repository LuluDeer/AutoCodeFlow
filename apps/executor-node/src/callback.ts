import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
import { post } from './admin-client';

export interface CallbackRequest {
  executionId: string;
  status: 'success' | 'failed';
  exitCode?: number;
  logs?: string;
  errorMessage?: string;
  durationMs?: number;
}

const callbackQueue: CallbackRequest[] = [];
let callbackThread: NodeJS.Timeout | null = null;
let stopped = false;

// Lazily computed so that config.workDir is resolved at call time, not at module load
function getCallbackDir(): string {
  const dir = path.join(config.workDir, 'callbacks');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function pushCallback(request: CallbackRequest): void {
  const existingIndex = callbackQueue.findIndex(r => r.executionId === request.executionId);
  if (existingIndex !== -1) {
    callbackQueue[existingIndex] = request;
    logger.debug(`Overwrote duplicate callback for execution ${request.executionId}`);
  } else {
    callbackQueue.push(request);
    logger.debug(`Pushed callback for execution ${request.executionId}`);
  }
}

async function doCallback(requests: CallbackRequest[]): Promise<boolean> {
  try {
    const response = await post('/api/executions/callback', requests);
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

function persistFailedCallbacks(requests: CallbackRequest[]): void {
  const timestamp = Date.now();
  const filename = path.join(getCallbackDir(), `callback-${timestamp}.json`);
  try {
    fs.writeFileSync(filename, JSON.stringify(requests, null, 2));
    logger.info(`Persisted ${requests.length} failed callbacks to ${filename}`);
  } catch (error: unknown) {
    logger.error(`Failed to persist callbacks: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function retryFailedCallbacks(): Promise<void> {
  try {
    const callbackDir = getCallbackDir();
    const files = fs.readdirSync(callbackDir);
    for (const file of files) {
      if (!file.startsWith('callback-') || !file.endsWith('.json')) continue;

      const filepath = path.join(callbackDir, file);
      try {
        const content = fs.readFileSync(filepath, 'utf-8');
        const requests = JSON.parse(content) as CallbackRequest[];
        
        const success = await doCallback(requests);
        if (success) {
          fs.unlinkSync(filepath);
          logger.info(`Retried and removed ${filepath}`);
        }
      } catch (error: unknown) {
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
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const success = await doCallback(requests);
    if (success) return;
    logger.warn(`Callback attempt ${attempt + 1}/${MAX_RETRIES} failed`);
    if (attempt < MAX_RETRIES - 1) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  logger.error(`Callback failed after ${MAX_RETRIES} attempts, persisting to disk`);
  persistFailedCallbacks(requests);
}

async function processCallbacks(): Promise<void> {
  while (!stopped) {
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

    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

export function startCallbackThread(): void {
  if (callbackThread) return;
  stopped = false;
  logger.info('Starting callback thread');
  processCallbacks();
}

export function stopCallbackThread(): void {
  stopped = true;
  logger.info('Stopping callback thread');
}

export function getPendingCallbackCount(): number {
  return callbackQueue.length;
}