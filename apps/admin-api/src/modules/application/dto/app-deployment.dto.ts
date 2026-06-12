import { IsString, IsEnum, IsOptional, IsObject, IsUUID } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { RunMode } from "../entities/app-deployment.entity";

export class CreateDeploymentDto {
  @ApiProperty({ description: "执行器 ID" })
  @IsUUID()
  executorId: string;

  @ApiPropertyOptional({ enum: RunMode, default: RunMode.DAEMON })
  @IsEnum(RunMode)
  @IsOptional()
  runMode?: RunMode;

  @ApiPropertyOptional({ description: "环境变量覆盖" })
  @IsObject()
  @IsOptional()
  env?: Record<string, string>;

  @ApiPropertyOptional({ description: "启动命令覆盖（留空使用 manifest entrypoint）" })
  @IsString()
  @IsOptional()
  startCommand?: string;
}

export class DeploymentHeartbeatDto {
  @ApiProperty({ description: "部署 ID" })
  @IsUUID()
  deploymentId: string;

  @ApiProperty({ description: "运行状态", enum: ["running", "stopped", "failed"] })
  @IsString()
  status: string;

  @ApiPropertyOptional({ description: "进程 PID" })
  @IsOptional()
  pid?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  message?: string;
}
