import { PartialType, ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsObject,
  IsEnum,
  IsNotEmpty,
  IsBoolean,
  IsUUID,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { ApplicationStatus } from "../entities/application.entity";
// P3-2（2026-10-25 审计）：env 载荷闸与部署面同口径（A-11：50 键/单值 4KB）。
import { DeploymentEnvSizeConstraint } from "./app-deployment.dto";

/**
 * P3-2（2026-10-25 审计）：manifest 载荷体积红线（对照 CreateDeploymentDto
 * A-11 的 env 闸同口径）。manifest 是自由形状 jsonb（healthCheck 等嵌套对象、
 * 值不全是字符串，不能直接复用 DeploymentEnvSizeConstraint），故按序列化后
 * 总字节封顶——异常调用方不能再借 manifest 塞任意大的 jsonb 进列表读面与
 * 版本快照。64KB 对含健康探针声明的部署清单绰绰有余。
 */
export const APPLICATION_MANIFEST_MAX_BYTES = 65_536;

@ValidatorConstraint({ name: "applicationManifestSize", async: false })
export class ApplicationManifestSizeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return true; // 非对象形态交给 @IsObject/@IsOptional 把关
    }
    try {
      return (
        Buffer.byteLength(JSON.stringify(value), "utf8") <=
        APPLICATION_MANIFEST_MAX_BYTES
      );
    } catch {
      return false; // 循环引用等不可序列化形态直接拒
    }
  }

  defaultMessage(): string {
    return `manifest must serialize to at most ${APPLICATION_MANIFEST_MAX_BYTES} bytes`;
  }
}

export class CreateApplicationDto {
  @ApiProperty({
    maxLength: 100,
    description: "唯一应用名称",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ description: "应用描述" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    example: "1.0.0",
    maxLength: 50,
    description: "应用版本号（上限对齐 UploadApplicationDto.version）",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  version: string;

  @ApiProperty({
    example: "node",
    maxLength: 50,
    description: "运行时类型（上限对齐 UploadApplicationDto.runtime）",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  runtime: string;

  // P3-2：长度闸按 entity 列形态给合理上限（列本身是无长度 varchar——闸在
  // DTO 层收口，防异常载荷落库进列表读面）。gitRepo/packageUrl 是 URL 形态
  // （2048 对 URL 宽裕）；gitCommit 允许完整 sha256（64）加余量；entrypoint
  // 对齐 CreateDeploymentDto.startCommand 的 2000。
  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  gitRepo?: string;
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  gitBranch?: string;
  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  gitCommit?: string;
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  // P3-2：manifest 载荷体积闸（见常量注释）。
  @Validate(ApplicationManifestSizeConstraint)
  manifest?: Record<string, any>;
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  // P3-2：env 与部署面同口径（50 键/单值 4KB，A-11）。
  @Validate(DeploymentEnvSizeConstraint)
  env?: Record<string, string>;
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  entrypoint?: string;
  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  packageUrl?: string;

  /** DEP-04: 部署审批流开关（开启后 deploy 冻结为待审批行，需第二人放行）。 */
  @ApiPropertyOptional({
    default: false,
    description: "DEP-04：新部署派发前是否需要第二人审批",
  })
  @IsOptional()
  @IsBoolean()
  approvalRequired?: boolean;

  /**
   * MUTEX-01（应用互斥组）：挂入的互斥组 id。null/不传 = 不参与互斥（默认，
   * 行为与引入前一致）。服务层校验组存在性（FK 只兜底，前置校验给 400 而非
   * 500）；同一组内的应用在同一台设备上互斥（组内并发数默认 1）。
   */
  @ApiPropertyOptional({
    nullable: true,
    description: "MUTEX-01：该应用加入的互斥组 ID（null = 不参与互斥）",
  })
  @IsOptional()
  @IsUUID()
  mutexGroupId?: string | null;
}

// PK-02（DEEP_REVIEW 0ef3bbe）: 手写 Optional 字段改为 PartialType(CreateApplicationDto)。
export class UpdateApplicationDto extends PartialType(CreateApplicationDto) {
  @ApiPropertyOptional({
    enum: ApplicationStatus,
    description: "应用状态",
  })
  @IsOptional()
  @IsEnum(ApplicationStatus)
  status?: ApplicationStatus;

  /** HMAC-SHA256 secret for webhook signature verification. Set to empty string to disable. */
  @ApiPropertyOptional({
    maxLength: 256,
    description:
      "用于 Webhook 签名校验的 HMAC-SHA256 secret。置为空字符串即关闭。",
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  webhookSecret?: string;
}

/**
 * ARCH-003: multipart upload fields go through the global ValidationPipe
 * (whitelist + forbidNonWhitelisted) instead of bare @Body("name") strings,
 * so overlong/malformed fields are rejected with 400 before touching disk.
 */
export class UploadApplicationDto {
  @ApiProperty({
    maxLength: 100,
    description: "应用名称",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    example: "node",
    maxLength: 50,
    description: "运行时类型",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  runtime?: string;

  /**
   * 上传即产生版本（方案 A）。可选——不传时行为与既往完全一致（只替换包
   * 文件，不动版本号）。传了则把 application.version 抬到该值，并写一条
   * application_versions 快照，使详情页版本列表立刻可见。
   */
  @ApiPropertyOptional({
    example: "1.0.1",
    maxLength: 50,
    description:
      "本次上传要记录的版本号（例如 1.0.1）。省略则保持当前版本不变。",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  version?: string;
}
