import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional } from "class-validator";
export class TriggerTaskDto {
  @ApiPropertyOptional() @IsOptional() params?: Record<string, any>;
}
