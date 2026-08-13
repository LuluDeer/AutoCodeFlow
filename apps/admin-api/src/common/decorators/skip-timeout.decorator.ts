import { SetMetadata } from "@nestjs/common";

/** Apply to a controller or handler to bypass the global TimeoutInterceptor.
 *  Use on SSE/streaming endpoints or any long-running route that must not be
 *  killed by the default REQUEST_TIMEOUT_MS wall clock.
 */
export const SKIP_TIMEOUT_KEY = "skipTimeout";
export const SkipTimeout = () => SetMetadata(SKIP_TIMEOUT_KEY, true);
