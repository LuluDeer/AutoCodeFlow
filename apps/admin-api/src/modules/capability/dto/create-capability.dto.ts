import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  registerDecorator,
  type ValidationOptions,
} from "class-validator";

/**
 * ADR-040 / P1：创建一条 capability 的请求体。
 *
 * 这里只做**形态**校验（类型/长度/枚举），确定性语义校验（key 形态、kind 枚举、
 * scope 组合 managed⇒guidance≤L2、manifest 封闭键 + 禁止命令字段）统一落在
 * service 层——单测以内存 repo 直接调 service，故语义判定必须住在 service，
 * 不能只靠 DTO 的 class-validator。
 */
export const CAPABILITY_KINDS = [
  "skill",
  "mcp",
  "agent",
  "provider",
  "template",
] as const;

export const CAPABILITY_VISIBILITIES = [
  "global",
  "project",
  "private",
] as const;

/** 语义化版本（可带 prerelease/build）或 40/64 位 hex hash；最长 64 对齐列宽。 */
export const VERSION_PIN_PATTERN =
  /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

const ATTESTATION_KEYS = new Set(["signer", "at", "scope"]);

function isAttestationShape(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => ATTESTATION_KEYS.has(key))) {
    return false;
  }
  return typeof record.signer === "string" && record.signer.trim().length > 0;
}

/** DTO 形态闸：attestation 为封闭键 `{signer, at?, scope?}` 且 signer 非空。 */
function IsAttestationShape(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: "isAttestationShape",
      target: object.constructor,
      propertyName,
      options: validationOptions ?? {
        message:
          "attestation must be {signer, at?, scope?} with a non-empty signer",
      },
      validator: {
        validate: (value: unknown): boolean =>
          value === undefined || value === null || isAttestationShape(value),
      },
    });
  };
}

export class CreateCapabilityDto {
  @ApiProperty({
    example: "browser",
    description: "稳定标识；1-128 位 [a-z0-9._-]，小写字母/数字起头",
  })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]{0,127}$/, {
    message: "key must match /^[a-z0-9][a-z0-9._-]{0,127}$/",
  })
  @MaxLength(128)
  key: string;

  @ApiProperty({
    enum: CAPABILITY_KINDS,
    description: "能力类型：skill | mcp | agent | provider | template",
  })
  @IsString()
  @IsIn([...CAPABILITY_KINDS])
  kind: string;

  @ApiProperty({ example: "Browser", description: "展示名" })
  @IsString()
  @MaxLength(128)
  label: string;

  @ApiPropertyOptional({ description: "能力说明" })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: "1.0.0", description: "语义化版本" })
  @IsString()
  @IsOptional()
  @MaxLength(32)
  version?: string;

  @ApiPropertyOptional({
    example: { type: "builtin" },
    description: "来源：{type: builtin|registry|git|folder, ref?}",
  })
  @IsObject()
  @IsOptional()
  source?: Record<string, unknown>;

  @ApiProperty({
    enum: CAPABILITY_VISIBILITIES,
    description: "可见范围：global | project | private",
  })
  @IsString()
  @IsIn([...CAPABILITY_VISIBILITIES])
  visibility: string;

  @ApiPropertyOptional({
    example: { mode: "supervised", guidance: "L2" },
    description:
      "作用域：{mode: managed|supervised|self_service, guidance: L1|L2|L3}",
  })
  @IsObject()
  @IsOptional()
  scope?: Record<string, unknown>;

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "能力声明（封闭键集合，禁止 command/hook/script 可执行字段）",
  })
  @IsObject()
  manifest: Record<string, unknown>;

  @ApiPropertyOptional({ description: "是否启用（默认 true）" })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional({
    example: "user:42|alice",
    description: "N16 发布者身份键；NULL = 未声明",
  })
  @IsString()
  @MaxLength(128)
  @IsOptional()
  owner?: string;

  @ApiPropertyOptional({
    example: "role:platform-eng",
    description: "N16 部门/角色背书（非个人）；NULL = 未声明",
  })
  @IsString()
  @MaxLength(128)
  @IsOptional()
  backer?: string;

  @ApiPropertyOptional({
    example: "1.2.3",
    description: "N16 钉死版本：语义化版本或 40/64 位 hex hash",
  })
  @IsString()
  @MaxLength(64)
  @Matches(VERSION_PIN_PATTERN, {
    message: "versionPin must be a semver or a 40/64-hex hash",
  })
  @IsOptional()
  versionPin?: string;

  @ApiPropertyOptional({
    example: {
      signer: "user:42|alice",
      at: "2026-11-26T00:00:00Z",
      scope: "global",
    },
    description: "N16 发布背书声明：封闭键 {signer, at?, scope?}，signer 非空",
  })
  @IsObject()
  @IsAttestationShape()
  @IsOptional()
  attestation?: Record<string, unknown>;
}

/** PATCH 复用全部字段、置为可选；语义校验仍由 service 在合并后重跑。 */
export class UpdateCapabilityDto extends PartialType(CreateCapabilityDto) {}
