import { IsString, IsOptional, IsBoolean } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class AppReleaseWebhookDto {
  @ApiProperty({ description: "Application name" })
  @IsString()
  appName: string;

  @ApiProperty({ description: "New version number, e.g. 1.2.3" })
  @IsString()
  version: string;

  @ApiPropertyOptional({ description: "Git commit SHA" })
  @IsString()
  @IsOptional()
  gitCommit?: string;

  @ApiPropertyOptional({ description: "Git branch" })
  @IsString()
  @IsOptional()
  gitBranch?: string;

  @ApiPropertyOptional({
    description: "Whether to trigger rolling upgrade on all RUNNING deployments",
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  triggerDeploy?: boolean;
}
