import {
  IsString,
  IsEnum,
  IsOptional,
  IsObject,
  IsUUID,
  IsInt,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { RunMode } from "../entities/app-deployment.entity";

export class CreateDeploymentDto {
  @ApiPropertyOptional({
    description:
      "Executor ID (leave empty to auto-select the online executor with lowest load)",
  })
  @IsUUID()
  @IsOptional()
  executorId?: string;

  @ApiPropertyOptional({ enum: RunMode, default: RunMode.DAEMON })
  @IsEnum(RunMode)
  @IsOptional()
  runMode?: RunMode;

  @ApiPropertyOptional({ description: "Environment variable overrides" })
  @IsObject()
  @IsOptional()
  env?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      "Startup command override (leave empty to use manifest entrypoint)",
  })
  @IsString()
  @IsOptional()
  startCommand?: string;
}

export class DeploymentHeartbeatDto {
  @ApiProperty({ description: "Deployment ID" })
  @IsUUID()
  deploymentId: string;

  @ApiProperty({
    description: "Runtime status",
    enum: ["running", "stopped", "failed"],
  })
  @IsString()
  @IsEnum(["running", "stopped", "failed"], {
    message: "status must be one of: running, stopped, failed",
  })
  status: string;

  // R17: pid is persisted/compared as a number — without @IsInt a string
  // like "123" (or an object) would pass validation and land in the row.
  @ApiPropertyOptional({ description: "Process PID", type: Number })
  @IsOptional()
  @IsInt()
  pid?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  message?: string;
}
