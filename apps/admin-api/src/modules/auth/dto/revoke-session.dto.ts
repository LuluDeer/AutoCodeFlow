import { ApiProperty } from "@nestjs/swagger";
import { IsNumber, IsNotEmpty } from "class-validator";
import { Type } from "class-transformer";

export class RevokeSessionDto {
  @ApiProperty({ example: 42, description: "refresh_tokens 行 id（会话 id）" })
  @Type(() => Number)
  @IsNumber()
  @IsNotEmpty()
  sessionId: number;
}
