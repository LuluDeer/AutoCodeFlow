// PK-02（DEEP_REVIEW 0ef3bbe）: PartialType 从 @nestjs/swagger 导入以传播
// @ApiProperty 元数据——@nestjs/mapped-types 的 PartialType 只克隆 class-validator
// 元数据，不克隆 swagger 元数据，导致 openapi 输出空 schema。
import { PartialType } from "@nestjs/swagger";
import { CreateTaskDto } from "./create-task.dto";
// PartialType 继承 CreateTaskDto 的全部校验器并置为可选——id 的
// @IsUUID("4")（R6）随之生效，无需重复声明。
export class UpdateTaskDto extends PartialType(CreateTaskDto) {}
