import { IsString, IsOptional, IsBoolean } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class AppReleaseWebhookDto {
  @ApiProperty({ description: "应用名称" })
  @IsString()
  appName: string;

  @ApiProperty({ description: "新版本号，例如 1.2.3" })
  @IsString()
  version: string;

  @ApiPropertyOptional({ description: "Git 提交 SHA" })
  @IsString()
  @IsOptional()
  gitCommit?: string;

  @ApiPropertyOptional({ description: "Git 分支" })
  @IsString()
  @IsOptional()
  gitBranch?: string;

  @ApiPropertyOptional({
    default: false,
    description: "是否对所有 RUNNING 状态的部署触发滚动升级",
  })
  @IsBoolean()
  @IsOptional()
  triggerDeploy?: boolean;
}
