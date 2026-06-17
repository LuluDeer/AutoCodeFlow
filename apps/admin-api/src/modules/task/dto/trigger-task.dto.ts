import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsObject, IsOptional } from "class-validator";
export class TriggerTaskDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  params?: Record<string, any>;
}
