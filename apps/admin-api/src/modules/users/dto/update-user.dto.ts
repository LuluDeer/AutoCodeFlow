// PK-02（DEEP_REVIEW 0ef3bbe）: PartialType 从 @nestjs/swagger 导入以传播
// @ApiProperty 元数据。
import { PartialType } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";
import { CreateUserDto } from "./create-user.dto";

export class UpdateUserDto extends PartialType(CreateUserDto) {
  @IsOptional()
  @IsString()
  currentPassword?: string;
}
