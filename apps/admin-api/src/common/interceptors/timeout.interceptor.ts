import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  RequestTimeoutException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { Observable, throwError, TimeoutError } from "rxjs";
import { catchError, timeout } from "rxjs/operators";
import { SKIP_TIMEOUT_KEY } from "../decorators/skip-timeout.decorator";

/**
 * OPS-07: Global request timeout — returns 408 instead of hanging forever.
 * Default 30 s; override per-deploy via REQUEST_TIMEOUT_MS (registered in
 * configuration.ts as app.requestTimeoutMs). Long-running routes (SSE /
 * log streaming) opt out via @SkipTimeout().
 *
 * ARCH-27: previously the budget was read from process.env at MODULE-LOAD
 * time (W-22 risk pattern — dead-config if env is injected later). Now the
 * value comes from ConfigService at construction; main.ts resolves it from
 * the app's DI container when installing this interceptor globally.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly reflector: Reflector,
    configService?: ConfigService,
  ) {
    this.requestTimeoutMs =
      configService?.get<number>("app.requestTimeoutMs") ?? 30000;
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Allow handlers decorated with @SkipTimeout() to bypass the limit.
    // This is required for SSE / log-streaming endpoints.
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_TIMEOUT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (skip) return next.handle();

    return next.handle().pipe(
      timeout(this.requestTimeoutMs),
      catchError((err) =>
        err instanceof TimeoutError
          ? throwError(() => new RequestTimeoutException("Request timed out"))
          : throwError(() => err),
      ),
    );
  }
}
