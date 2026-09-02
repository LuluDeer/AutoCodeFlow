import {
  BadRequestException,
  Controller,
  Post,
  Body,
  Headers,
  ParseArrayPipe,
  UnauthorizedException,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { Public } from "../../common/decorators/public.decorator";
import { TaskService } from "./task.service";
import { SystemConfigService } from "../config/config.service";
import { verifyExecutorToken } from "../../common/utils/verify-executor-token.util";
import { CallbackItemDto } from "./dto/execution-callback.dto";
import { ExecutorService } from "../executor/executor.service";

@SkipThrottle()
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
  @ApiOperation({
    summary: "Execution result callback",
    description:
      "Called by executor after task completion to report results. Requires shared token authentication.",
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
}
