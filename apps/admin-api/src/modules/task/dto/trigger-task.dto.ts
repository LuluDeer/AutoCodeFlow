import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsObject, IsOptional, Min } from "class-validator";
export class TriggerTaskDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  params?: Record<string, any>;

  /**
   * 技术债 A 组（2026-10-01）·按原版本重放：指定以任务版本历史的第 N 个
   * 快照（v<N>）派发本次执行——校验该版本存在且属于该任务（不存在 404）；
   * 派发载荷按该版本快照覆盖执行相关字段（codeSource/gitRepo/gitBranch/
   * gitCommit/entrypoint/runtimeVersion/requirements/glueSource/applicationId，
   * packageUrl 仍按快照 applicationId 在派发时解析）；执行记录 taskVersion
   * 记该钉定版本号。不落库、不建新版本、不影响任务当前配置；不传 version
   * 行为完全不变（沿用任务当前配置）。
   */
  @ApiPropertyOptional({ type: Number, example: 3, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
