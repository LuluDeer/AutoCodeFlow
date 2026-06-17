import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsOptional, Matches } from "class-validator";

export class RollbackTaskDto {
  @ApiProperty({ description: "git commit SHA to roll back to (4-40 lowercase hex characters)" })
  @IsString()
  @Matches(/^[0-9a-f]{4,40}$/, {
    message:
      "gitCommit must be a valid git commit SHA (4-40 lowercase hex characters)",
  })
  gitCommit: string;

  @ApiPropertyOptional()
  @IsOptional()
  params?: Record<string, any>;
}
