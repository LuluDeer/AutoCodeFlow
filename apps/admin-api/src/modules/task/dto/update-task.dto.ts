// PK-02（DEEP_REVIEW 0ef3bbe）: PartialType 从 @nestjs/swagger 导入以传播
// @ApiProperty 元数据——@nestjs/mapped-types 的 PartialType 只克隆 class-validator
// 元数据，不克隆 swagger 元数据，导致 openapi 输出空 schema。
import { PartialType, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";
import { CreateTaskDto } from "./create-task.dto";

// PartialType 继承 CreateTaskDto 的全部校验器并置为可选——id 的
// @IsUUID("4")（R6）随之生效，无需重复声明。
export class UpdateTaskDto extends PartialType(CreateTaskDto) {
  /**
   * A4（第三轮审计·中）：乐观锁预期值（可选，向后兼容）。
   *
   * 前端从任务详情读取的 `updatedAt`（ISO 时间串）在提交时原样回传；服务端
   * 与库内行比对，不符 → 409 ConflictException（提示「请刷新后重试」），防止
   * 两个控制台标签页互踩写丢。**缺省（undefined/null）= 跳过检查**——MCP/
   * CLI/SDK 等旧调用方不传该字段，行为零变化。
   *
   * 注意：本字段只服务并发检查，**绝不落库**（update() 在合并前删除该键，
   * 同 normalizeTaskDto 的 timeoutSeconds 消费即弃模式）。
   */
  @ApiPropertyOptional({
    description:
      "乐观锁预期值：编辑前读取的任务 updatedAt（ISO 时间串）。传入即启用并发检查，不匹配返回 409；缺省跳过检查。",
    example: "2026-10-01T08:00:00.000Z",
  })
  @IsOptional()
  @IsString()
  expectedUpdatedAt?: string | null;
}
