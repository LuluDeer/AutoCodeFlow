import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  RequestTimeoutException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, throwError, TimeoutError } from "rxjs";
import { catchError, timeout } from "rxjs/operators";

// Metadata key to bypass the global request timeout. The SkipTimeout decorator
// (formerly common/decorators/skip-timeout.decorator.ts) was removed as dead
// code — no controller ever applied @SkipTimeout(). The key is kept here so
// long-running routes can still opt out via SetMetadata(SKIP_TIMEOUT_KEY, true).
const SKIP_TIMEOUT_KEY = "skipTimeout";

// OPS-07: Global request timeout — returns 408 instead of hanging forever.
// Default 30 s; override per-deploy via REQUEST_TIMEOUT_MS env var.
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.REQUEST_TIMEOUT_MS ?? "30000",
  10,
);

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Allow handlers decorated with @SkipTimeout() to bypass the limit.
    // This is required for SSE / log-streaming endpoints.
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_TIMEOUT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (skip) return next.handle();

    return next.handle().pipe(
      timeout(REQUEST_TIMEOUT_MS),
      catchError((err) =>
        err instanceof TimeoutError
          ? throwError(() => new RequestTimeoutException("Request timed out"))
          : throwError(() => err),
      ),
    );
  }
}
