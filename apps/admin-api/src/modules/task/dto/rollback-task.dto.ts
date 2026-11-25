import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsOptional, Matches, IsObject } from "class-validator";
// B-9: 与 create/trigger/webhook 面同一 params 体积门与键冲突闸（常量单一出处）
import { TaskParamsMaxBytes } from "./params-size.constraint";
import { TaskParamsNoKeyCaseCollision } from "./param-key-collision.constraint";

export class RollbackTaskDto {
  @ApiProperty({
    description: "回滚到的 git commit SHA（4-40 位小写十六进制字符）",
  })
  @IsString()
  @Matches(/^[0-9a-f]{4,40}$/, {
    message:
      "gitCommit must be a valid git commit SHA (4-40 lowercase hex characters)",
  })
  gitCommit: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  @TaskParamsMaxBytes()
  @TaskParamsNoKeyCaseCollision()
  params?: Record<string, any>;
}
