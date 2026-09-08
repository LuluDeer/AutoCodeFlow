import {
  BadRequestException,
  Controller,
  Post,
  Body,
  Headers,
  ParseArrayPipe,
  UnauthorizedException,
  Optional,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { Public } from "../../common/decorators/public.decorator";
import { TaskService } from "./task.service";
import { SystemConfigService } from "../config/config.service";
import { verifyExecutorToken } from "../../common/utils/verify-executor-token.util";
import {
  EXECUTION_CALLBACK_TOKEN_PREFIX,
  parseExecutionCallbackToken,
  verifyExecutionCallbackToken,
  ExecutionCallbackTokenClaims,
} from "./execution-callback-token.util";
import { ExecutionCallbackMetricsService } from "./execution-callback-metrics.service";
import { CallbackItemDto } from "./dto/execution-callback.dto";
import { ExecutorService } from "../executor/executor.service";
// OBS-01: 回调链路追踪——执行器回传 traceparent 头关联（disabled 时短路）。
import { TracingService } from "../../common/tracing/tracing.service";

/**
 * F-5: this controller used to be fully @SkipThrottle()'d — an unauthenticated
 * caller who knew (or guessed) a registered executor address could force
 * bcrypt compares + 55 MB JSON parsing with zero rate limiting. Restore a
 * RELAXED limit instead (heartbeats/callbacks legitimately arrive at ~2/min
 * per executor; 60/min gives 30x headroom) so abuse is still bounded.
 */
const CALLBACK_THROTTLE = { default: { limit: 60, ttl: 60_000 } };

@ApiTags("Execution Callback")
@Controller("executions")
export class ExecutionCallbackController {
  constructor(
    private readonly taskService: TaskService,
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
    // 跨 task↔executor 模块环的 provider 注入：模块级 forwardRef 配套。
    @Inject(forwardRef(() => ExecutorService))
    private readonly executorService: ExecutorService,
    // N32: 401 分类观测计数（进程内，Prometheus 经快照映射暴露）。
    private readonly callbackMetrics: ExecutionCallbackMetricsService,
    // OBS-01: 回调 traceparent 头解析（@Optional 仅为既有单测装配兼容；
    // disabled/缺失时 extractContext 恒 null）。
    @Optional()
    private readonly tracing: TracingService | null,
  ) {}

  @Post("callback")
  @Public()
  // F-5: relaxed-but-finite rate limit (see CALLBACK_THROTTLE above).
  @Throttle(CALLBACK_THROTTLE)
  @ApiOperation({
    summary: "Execution result callback",
    description:
      "Called by executor (or task code holding a per-execution AUTOFLOW_CALLBACK_TOKEN) after task completion to report results. " +
      "Accepts either the executor shared/per-address token or a per-execution `v1.` HMAC token bound to the batch's executionId (N23).",
  })
  @ApiResponse({
    status: 200,
    description: "Callback processed successfully",
    schema: {
      example: {
        results: [
          { executionId: "exec-uuid-1", success: true },
          {
            executionId: "exec-uuid-2",
            success: false,
            error: "Execution not found",
          },
        ],
      },
    },
  })
  @ApiResponse({ status: 400, description: "Invalid request body" })
  @ApiResponse({ status: 401, description: "Invalid shared token" })
  @ApiBody({
    type: [CallbackItemDto],
    description: "Array of execution callback items (max 100)",
  })
  async callback(
    @Headers("authorization") auth: string | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Body(new ParseArrayPipe({ items: CallbackItemDto, whitelist: true }))
    callbacks: CallbackItemDto[],
  ) {
    if (callbacks.length > 100) {
      throw new BadRequestException("Callback batch size cannot exceed 100");
    }
    if (callbacks.length === 0) {
      throw new BadRequestException("Callback batch is empty");
    }
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
    if (!token) {
      // N32: 完全没带 token —— 与"带了但校验失败"区分开。
      this.callbackMetrics.recordAuthResult("missing_token");
      throw new UnauthorizedException("Missing executor token");
    }

    // N23: per-execution callback token — minted by executor-node (HMAC
    // over executionId + expiry, keyed by the executor shared secret) and
    // injected into task subprocesses as AUTOFLOW_CALLBACK_TOKEN. It is a
    // one-shot authorization for EXACTLY one executionId, so task code can
    // call back without ever holding the shared token (SEC-01 preserved).
    // Any other bearer string keeps flowing down the legacy per-address /
    // shared-token path unchanged (backward compatibility).
    if (token.startsWith(EXECUTION_CALLBACK_TOKEN_PREFIX)) {
      await this.verifyPerExecutionCallbackToken(token, callbacks);
      // N32: 认证通过即计 ok（业务层 per-item 结果不属于认证维度）。
      this.callbackMetrics.recordAuthResult("ok");
      // OBS-01: 解析执行器回传的 traceparent 头关联链路（disabled=恒 null）。
      const cbTraceId = this.tracing?.extractContext(traceparent) ?? null;
      const endSpan = this.tracing?.startSpan(cbTraceId, "callback.receive", {
        items: callbacks.length,
      });
      try {
        const results = await this.taskService.handleCallback(callbacks);
        endSpan?.();
        return { results };
      } catch (err: unknown) {
        endSpan?.(err instanceof Error ? err.message : String(err));
        throw err;
      }
    }

    // TASK-001: per-item per-address token check — a single shared token
    // must NOT be allowed to confirm callbacks for executions belonging
    // to multiple executors, since that would bypass per-executor auth.
    // Each item carries its own executorAddress; we verify the bearer
    // token against the executor's stored hash and additionally ensure
    // every claimed executorAddress actually matches an execution row
    // (the service layer enforces the latter with executionAddress guards).
    const seenAddresses = new Set<string>();
    for (const item of callbacks) {
      const addr = item.executorAddress?.trim();
      if (!addr) {
        // N32: legacy 路径缺 executorAddress —— 归为 bad_address。
        this.callbackMetrics.recordAuthResult("bad_address");
        throw new UnauthorizedException(
          "executorAddress is required on every callback item",
        );
      }
      if (seenAddresses.has(addr)) continue;
      seenAddresses.add(addr);
      const isValid = await this.executorService.validateTokenByAddress(
        addr,
        token,
      );
      if (!isValid) {
        // Fall back to the shared/legacy token sources only when there is
        // exactly ONE unique executor in the batch. Multi-executor batches
        // can never use a shared token.
        if (seenAddresses.size === 1) {
          try {
            await verifyExecutorToken(
              auth,
              this.configService,
              this.systemConfigService,
            );
          } catch (err) {
            // N32: per-address 校验失败且共享 token 兜底也失败。
            this.callbackMetrics.recordAuthResult("legacy_shared_invalid");
            throw err;
          }
        } else {
          this.callbackMetrics.recordAuthResult("legacy_shared_invalid");
          throw new UnauthorizedException(
            `Invalid executor token for address ${addr}`,
          );
        }
      }
    }
    // N32: legacy 路径认证通过。
    this.callbackMetrics.recordAuthResult("ok");
    // OBS-01: legacy 回调路径同样解析 traceparent（disabled=短路）。
    const cbTraceId = this.tracing?.extractContext(traceparent) ?? null;
    const endSpan = this.tracing?.startSpan(cbTraceId, "callback.receive", {
      items: callbacks.length,
    });
    try {
      const results = await this.taskService.handleCallback(callbacks);
      endSpan?.();
      return { results };
    } catch (err: unknown) {
      endSpan?.(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * N23: validate a `v1.` per-execution callback token.
   *
   * Rules (all fail-closed with 401):
   * - signature + TTL must verify against one of the candidate secrets
   *   (EXECUTION_CALLBACK_SECRET → DB executor.sharedToken → env
   *   executor.sharedToken, mirroring verifyExecutorToken's sources);
   * - N26 (round-8): when every fleet-global candidate fails, fall back to
   *   the PER-EXECUTOR credential — for each unique executorAddress in the
   *   batch, the executor's stored tokenHash (the same value the executor
   *   received at register time and uses as its HMAC source secret) is
   *   tried as the key. Lookups ride ExecutorService's 60s positive cache,
   *   mirroring the per-address token-validation pattern;
   * - every callback item's executionId must equal the executionId the
   *   token is bound to — a token authorizes its own execution only;
   * - N27 (round-8): items no longer need to carry executorAddress — the
   *   token is already execution-bound and the service layer
   *   (task.service.handleCallback) still compares any provided address
   *   against the execution row, so requiring it here only broke task code
   *   that cannot know the address.
   */
  private async verifyPerExecutionCallbackToken(
    token: string,
    callbacks: CallbackItemDto[],
  ): Promise<ExecutionCallbackTokenClaims> {
    const secrets = await this.resolveCallbackSecrets();
    let claims = verifyExecutionCallbackToken(token, secrets);
    if (!claims) {
      claims = await this.verifyAgainstPerExecutorSecrets(token, callbacks);
    }
    if (!claims) {
      // N32 分类取舍：token util 层是与 executor-node 签名端共享的纯函数
      // （算法由测试向量双向钉死），刻意不注入 Nest service；expired 与
      // bad-signature 的区分因此收回 controller，用结构重解析派生——
      // parseExecutionCallbackToken 无 HMAC 重算，成本可忽略。畸形 `v1.`
      // 串（解析失败）归入 v1_bad_signature。
      this.callbackMetrics.recordAuthResult(
        this.isV1TokenExpired(token) ? "v1_expired" : "v1_bad_signature",
      );
      throw new UnauthorizedException(
        "Invalid or expired execution callback token",
      );
    }
    for (const item of callbacks) {
      if (item.executionId !== claims.executionId) {
        this.callbackMetrics.recordAuthResult("v1_binding_mismatch");
        throw new UnauthorizedException(
          "Execution callback token is not valid for this execution",
        );
      }
    }
    return claims;
  }

  /**
   * N32: structural expiry probe for the v1_expired vs v1_bad_signature
   * split. Mirrors verifyExecutionCallbackToken's fail-closed ordering
   * (expiry is checked before signatures, so an expired token classifies
   * as expired even if its signature would also have failed). A token that
   * cannot even be parsed is NOT expired — it is a bad signature.
   */
  private isV1TokenExpired(token: string): boolean {
    const parsed = parseExecutionCallbackToken(token);
    if (!parsed) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return (
      !Number.isFinite(parsed.expiresAtSec) || parsed.expiresAtSec <= nowSec
    );
  }

  /**
   * N26: per-executor HMAC fallback. A node installed with its own
   * `--secret` signs AUTOFLOW_CALLBACK_TOKEN with the credential it
   * received at register time (the stored tokenHash), which is not one of
   * the fleet-global candidates. Try each unique batch address' tokenHash
   * as the key; first structural match wins. Unknown addresses / missing
   * hashes are skipped (fail-closed overall).
   */
  private async verifyAgainstPerExecutorSecrets(
    token: string,
    callbacks: CallbackItemDto[],
  ): Promise<ExecutionCallbackTokenClaims | null> {
    const seen = new Set<string>();
    for (const item of callbacks) {
      const addr = item.executorAddress?.trim();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      const secret =
        await this.executorService.getCallbackSecretByAddress(addr);
      if (!secret) continue;
      const claims = verifyExecutionCallbackToken(token, [secret]);
      if (claims) return claims;
    }
    return null;
  }

  /** Candidate HMAC secrets, most-specific first; empty entries dropped. */
  private async resolveCallbackSecrets(): Promise<string[]> {
    const candidates: (string | undefined | null)[] = [
      this.configService.get<string>("executionCallback.secret"),
      this.configService.get<string>("executor.sharedToken"),
    ];
    try {
      const cfg = await this.systemConfigService.findOne(
        "executor.sharedToken",
      );
      // DB-rotated token slots in ahead of the env fallback.
      candidates.splice(1, 0, cfg?.value ?? null);
    } catch {
      // key not found in DB — env candidates remain
    }
    return candidates.filter((s): s is string => Boolean(s));
  }
}
