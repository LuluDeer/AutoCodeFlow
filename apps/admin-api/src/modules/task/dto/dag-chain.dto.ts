import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from "class-validator";

/** POST /api/tasks/dag/trigger-roots 入参：任务子图 + 可选触发参数覆盖。 */
export class TriggerDagRootsDto {
  @ApiProperty({
    type: [String],
    description:
      "要触发的任务子图（任务 UUID 列表，1..100 个）。只触发这些任务中在子图内零前驱的根节点；依赖边读取每个任务的 dependencies.value。",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID("4", { each: true })
  taskIds: string[];

  @ApiPropertyOptional({
    description:
      "触发参数覆盖（透传给每个根节点执行；服务层自动注入内部批次标记，用于同批次依赖判定）。",
  })
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

/** 单个根节点的触发结果。 */
export class DagRootExecutionDto {
  @ApiProperty({ description: "被触发的任务 ID" })
  taskId: string;

  @ApiProperty({ description: "新创建并执行入队的执行 ID" })
  executionId: string;

  @ApiProperty({
    description: "执行状态（入队后的初始状态，通常为 pending）",
  })
  status: string;
}

/** POST /api/tasks/dag/trigger-roots 响应体。 */
export class TriggerDagRootsResponseDto {
  @ApiProperty({ description: "本次 DAG 运行的批次标记（UUID），注入到每个根执行 params._dagRunId" })
  dagRunId: string;

  @ApiProperty({
    type: [String],
    description: "实际触发的根节点任务 ID（在入参子图内零前驱）",
  })
  rootTaskIds: string[];

  @ApiProperty({
    type: [String],
    description:
      "入参中被跳过（非根节点）的任务 ID——它们由根节点的执行终态经依赖扇出自动触发，不在此处直接触发",
  })
  skippedDependentTaskIds: string[];

  @ApiProperty({
    type: [DagRootExecutionDto],
    description: "每个根节点的触发结果（taskId/executionId/status）",
  })
  executions: DagRootExecutionDto[];
}
