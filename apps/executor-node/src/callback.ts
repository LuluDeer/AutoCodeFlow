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

const callbackDir = path.join(config.workDir, 'callbacks');
fs.mkdirSync(callbackDir, { recursive: true });

export function pushCallback(request: CallbackRequest): void {
  callbackQueue.push(request);
  logger.debug(`Pushed callback for execution ${request.executionId}`);
}

async function doCallback(requests: CallbackRequest[]): Promise<boolean> {
  try {
    const response = await post('/api/executions/callback', requests);
    if (response.status === 200) {
      logger.debug(`Callback successful for ${requests.length} execution(s)`);
      return true;
    }
    return false;
  } catch (error: any) {
    logger.warn(`Callback failed: ${error.message}`);
    return false;
  }
}

function persistFailedCallbacks(requests: CallbackRequest[]): void {
  const timestamp = Date.now();
  const filename = path.join(callbackDir, `callback-${timestamp}.json`);
  try {
    fs.writeFileSync(filename, JSON.stringify(requests, null, 2));
    logger.info(`Persisted ${requests.length} failed callbacks to ${filename}`);
  } catch (error: any) {
    logger.error(`Failed to persist callbacks: ${error.message}`);
  }
}

async function retryFailedCallbacks(): Promise<void> {
  try {
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
      } catch (error: any) {
        logger.warn(`Failed to retry callback file ${file}: ${error.message}`);
      }
    }
  } catch (error: any) {
    logger.error(`Error during callback retry: ${error.message}`);
  }
}

async function processCallbacks(): Promise<void> {
  while (!stopped) {
    try {
      if (callbackQueue.length > 0) {
        const requests = [...callbackQueue];
        callbackQueue.length = 0;
        
        const success = await doCallback(requests);
        if (!success) {
          persistFailedCallbacks(requests);
        }
      }
      
      await retryFailedCallbacks();
    } catch (error: any) {
      logger.error(`Callback thread error: ${error.message}`);
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