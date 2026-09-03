import {
  BadRequestException,
  Controller,
  Post,
  Body,
  Headers,
  ParseArrayPipe,
  UnauthorizedException,
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
  verifyExecutionCallbackToken,
  ExecutionCallbackTokenClaims,
} from "./execution-callback-token.util";
import { CallbackItemDto } from "./dto/execution-callback.dto";
import { ExecutorService } from "../executor/executor.service";

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
    private readonly executorService: ExecutorService,
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
      const results = await this.taskService.handleCallback(callbacks);
      return { results };
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
          await verifyExecutorToken(
            auth,
            this.configService,
            this.systemConfigService,
          );
        } else {
          throw new UnauthorizedException(
            `Invalid executor token for address ${addr}`,
          );
        }
      }
    }
    const results = await this.taskService.handleCallback(callbacks);
    return { results };
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
      throw new UnauthorizedException(
        "Invalid or expired execution callback token",
      );
    }
    for (const item of callbacks) {
      if (item.executionId !== claims.executionId) {
        throw new UnauthorizedException(
          "Execution callback token is not valid for this execution",
        );
      }
    }
    return claims;
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
      const cfg = await this.systemConfigService.findOne("executor.sharedToken");
      // DB-rotated token slots in ahead of the env fallback.
      candidates.splice(1, 0, cfg?.value ?? null);
    } catch {
      // key not found in DB — env candidates remain
    }
    return candidates.filter((s): s is string => Boolean(s));
  }
}
