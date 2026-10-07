// PK-02（DEEP_REVIEW 0ef3bbe）: PartialType 从 @nestjs/swagger 导入以传播
// @ApiProperty 元数据。
import { PartialType, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";
import { CreateUserDto } from "./create-user.dto";

export class UpdateUserDto extends PartialType(CreateUserDto) {
  // N-12（2026-10-07）：无 swagger 装饰器的属性不会被反射进契约——A-13 的
  // currentPassword 在 API 真实可用却从 openapi.json 消失，前端只能靠手写
  // interface 补。显式声明进契约。
  @ApiPropertyOptional({
    description:
      "Required when a non-admin user changes their own password (SEC-12); stripped by the service before persisting (R19)",
  })
  @IsOptional()
  @IsString()
  currentPassword?: string;
}
