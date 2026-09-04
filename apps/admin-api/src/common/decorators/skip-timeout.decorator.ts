import { SetMetadata } from "@nestjs/common";

/**
 * Metadata key consumed by the global TimeoutInterceptor to bypass the
 * REQUEST_TIMEOUT_MS limit. R6 N8: the key previously lived inside
 * timeout.interceptor.ts with no exported decorator and no route ever set
 * it — the documented escape hatch for SSE / log-streaming endpoints was
 * dead. `@SkipTimeout()` restores it.
 */
export const SKIP_TIMEOUT_KEY = "skipTimeout";

/**
 * Exempt a handler (or an entire controller) from the global request
 * timeout. Required for long-lived routes such as the execution-log SSE
 * stream, where the observable stays open for the whole task runtime.
 */
export const SkipTimeout = () => SetMetadata(SKIP_TIMEOUT_KEY, true);
