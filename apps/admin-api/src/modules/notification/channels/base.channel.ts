export interface NotificationPayload {
  title: string;
  content: string;
  level?: 'info' | 'warning' | 'error';
}

export interface RetryConfig {
  maxRetries: number;
  delayMs: number;
  backoffMultiplier: number;
}

export abstract class BaseChannel {
  abstract name: string;
  abstract send(payload: NotificationPayload): Promise<void>;

  protected async withRetry<T>(
    operation: () => Promise<T>,
    config: RetryConfig = { maxRetries: 3, delayMs: 1000, backoffMultiplier: 2 },
  ): Promise<T> {
    let lastError: Error | undefined;
    let delay = config.delayMs;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt < config.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= config.backoffMultiplier;
        }
      }
    }

    throw lastError || new Error('Retry failed');
  }
}
