import { Controller, Post, Body } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { TaskService } from "./task.service";

@ApiTags("执行回调")
@Controller("executions")
export class ExecutionCallbackController {
  constructor(private readonly taskService: TaskService) {}

  @Post("callback")
  @Public()
  @ApiOperation({
    summary: "执行结果回调",
    description: "执行器完成任务执行后调用此接口上报执行结果",
  })
  @ApiResponse({
    status: 200,
    description: "回调处理成功",
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
  async callback(
    @Body()
    callbacks: Array<{
      executionId: string;
      status: "success" | "failed";
      exitCode?: number;
      logs?: string;
      errorMessage?: string;
      durationMs?: number;
    }>,
  ) {
    const results = await this.taskService.handleCallback(callbacks);
    return { results };
  }
}
