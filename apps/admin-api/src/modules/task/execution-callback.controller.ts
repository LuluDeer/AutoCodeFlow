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
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
    const executorAddresses = [
      ...new Set(callbacks.map((item) => item.executorAddress).filter(Boolean)),
    ] as string[];
    if (executorAddresses.length === 1 && token) {
      const isValid = await this.executorService.validateTokenByAddress(
        executorAddresses[0],
        token,
      );
      if (!isValid) {
        throw new UnauthorizedException("Invalid executor token");
      }
    } else {
      await verifyExecutorToken(
        auth,
        this.configService,
        this.systemConfigService,
      );
    }
    const results = await this.taskService.handleCallback(callbacks);
    return { results };
  }
}
