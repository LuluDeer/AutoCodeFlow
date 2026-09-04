import { PartialType } from "@nestjs/mapped-types";
import { CreateTaskDto } from "./create-task.dto";
// PartialType 继承 CreateTaskDto 的全部校验器并置为可选——id 的
// @IsUUID("4")（R6）随之生效，无需重复声明。
export class UpdateTaskDto extends PartialType(CreateTaskDto) {}
