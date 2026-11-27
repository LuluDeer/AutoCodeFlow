import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiOkResponse,
  ApiTags,
} from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { TaskService } from "./task.service";
import {
  TriggerDagRootsDto,
  TriggerDagRootsResponseDto,
  DagRootExecutionDto,
} from "./dto/dag-chain.dto";

/**
 * DAG 链式触发（root-only）：接收一个任务子图，只触发其中在子图内零前驱的
 * 根节点；下游任务由根执行终态经既有依赖扇出（triggerDependentTasks）自动
 * 触发，避免"手动触发整条链"时把依赖节点也直接入队造成重复执行。
 *
 * 每个根执行 params 注入 `_dagRunId`（本次批次 UUID），依赖闸门
 * （dependency-gate.util.areDependenciesSatisfied 的 dagRunId 选项）据此在同
 * 批次内匹配上游执行；该字段不落新列、不进任务配置，随 params 透传。
 */
@ApiTags("Task Management")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("tasks/dag")
export class TaskDagChainController {
  constructor(private readonly taskService: TaskService) {}

  @Post("trigger-roots")
  @HttpCode(HttpStatus.OK)
  @WriteGuard("task", {
    scope: "project-role",
    reason: "仅触发任务子图的根节点；每个根节点的归属由 TaskService.trigger 复核",
  })
  @ApiOperation({
    summary: "按 DAG 只触发根节点",
    description:
      "传入任务子图（taskIds）与可选参数覆盖，仅触发子图内零前驱的根节点；非根节点由根执行成功后经依赖扇出自动触发，本端点返回 dagRunId、实际触发的 rootTaskIds、被跳过的 skippedDependentTaskIds，以及每个根节点的执行结果。dagRunId 注入根执行 params._dagRunId，供同批次依赖判定使用。",
  })
  @ApiOkResponse({
    type: TriggerDagRootsResponseDto,
    description:
      "根节点触发结果（dagRunId / rootTaskIds / skippedDependentTaskIds / executions）",
  })
  async triggerRoots(
    @Body() dto: TriggerDagRootsDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<TriggerDagRootsResponseDto> {
    const taskIds = [...new Set(dto.taskIds)];
    const inSubgraph = new Set(taskIds);

    // 读取每个任务的 dependencies（契约：value 才是上游任务 id），
    // 只把"上游也在本次子图内"的边算作子图内前驱——子图外的前驱由既有
    // 全量依赖闸门判定是否阻断，本端点只负责"不要直接触发非根"。
    const depsByTask = new Map<string, string[]>();
    await Promise.all(
      taskIds.map(async (taskId) => {
        const task = await this.taskService.findOne(taskId);
        const deps = Object.values(task.dependencies ?? {}).filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        );
        depsByTask.set(taskId, deps);
      }),
    );

    const rootTaskIds: string[] = [];
    const skippedDependentTaskIds: string[] = [];
    for (const taskId of taskIds) {
      const hasInternalPredecessor = (depsByTask.get(taskId) ?? []).some((dep) =>
        inSubgraph.has(dep),
      );
      if (hasInternalPredecessor) skippedDependentTaskIds.push(taskId);
      else rootTaskIds.push(taskId);
    }

    const dagRunId = randomUUID();
    const executions: DagRootExecutionDto[] = [];
    for (const taskId of rootTaskIds) {
      const exec = await this.taskService.trigger(
        taskId,
        {
          params: { ...(dto.params ?? {}), _dagRunId: dagRunId },
        },
        user,
      );
      executions.push({
        taskId,
        executionId: exec.id,
        status: String(exec.status),
      });
    }

    return { dagRunId, rootTaskIds, skippedDependentTaskIds, executions };
  }
}
