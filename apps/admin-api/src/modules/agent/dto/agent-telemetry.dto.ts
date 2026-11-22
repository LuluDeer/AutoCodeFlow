import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

/**
 * R330（审计 B3）：只拦截「原始 64-hex 设备指纹形状」的 installId。
 *
 * installId 的契约是**不透明安装标识**：ttfv-journey e2e 传
 * `ttfv-e2e-<uuid>`、单测传 `inst-1`、listener 写 HMAC 派生的 32-hex，
 * 它们都是合法值，强制 32-hex 会破坏既有调用方。真正需要拦的只有
 * 「用户把 deviceFingerprint 原文误塞进 installId」这一种情况——它会
 * 与 listener 派生的 HMAC id 永久错配，授权了也零采集。
 *
 * 正则形状与 executor-fingerprint.util.ts 的 FINGERPRINT_RE 完全一致：
 * 小写 64-hex。大写 64-hex 不是执行器产出的指纹形态，故不在拦截范围。
 */
const RAW_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

@ValidatorConstraint({ name: "installIdNotRawFingerprint", async: false })
class InstallIdNotRawFingerprintConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    // fail-open：非字符串与空值交由 @IsOptional / @IsString 处理，
    // 本约束只对确实是字符串的「原始指纹形状」报错。
    if (typeof value !== "string" || value.length === 0) return true;
    return !RAW_FINGERPRINT_RE.test(value);
  }

  defaultMessage(): string {
    return "installId 不接受原始设备指纹（64 位 hex）；请改传 deviceFingerprint 由服务端派生，或传已派生的匿名 installId";
  }
}

/**
 * R308: allowed provenance values persisted to telemetry_optin.source.
 *
 * Deliberately an enum, not free text: the value is returned by the status
 * endpoint and stored alongside the install id, so accepting arbitrary strings
 * would give a caller a channel to persist a raw username or device
 * fingerprint into a column that is meant to hold a stable action label.
 */
export const AGENT_TELEMETRY_CONSENT_SOURCES = ["admin-ui", "api"] as const;

export type AgentTelemetryConsentSource =
  (typeof AGENT_TELEMETRY_CONSENT_SOURCES)[number];

export class AgentTelemetryConsentDto {
  @ApiProperty({ description: "是否启用 TTFV 采集" })
  @IsBoolean()
  optIn: boolean;

  @ApiPropertyOptional({
    description: "不透明的安装标识；优先于设备指纹",
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Validate(InstallIdNotRawFingerprintConstraint)
  installId?: string;

  @ApiPropertyOptional({
    description: "原始设备指纹；派生为匿名安装标识",
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceFingerprint?: string;

  @ApiPropertyOptional({
    description: "本次授权动作的来源标记",
    enum: AGENT_TELEMETRY_CONSENT_SOURCES,
  })
  @IsOptional()
  @IsIn(AGENT_TELEMETRY_CONSENT_SOURCES)
  source?: AgentTelemetryConsentSource;
}

export class AgentTelemetryConsentResultDto {
  @ApiProperty({ description: "本次操作后的系统总闸状态" })
  systemEnabled: boolean;

  @ApiProperty({ description: "是否已授权采集" })
  optedIn: boolean;

  @ApiProperty({
    description: "本次涉及的安装标识（匿名）",
    type: [String],
  })
  installIds: string[];

  @ApiProperty({ description: "本次涉及的安装数量" })
  count: number;

  @ApiProperty({ description: "实际落库的来源标记" })
  source: string;
}

export class TelemetryOptinInstallViewDto {
  @ApiProperty({ description: "匿名安装标识" })
  installId: string;

  @ApiProperty({ description: "当前安装的授权状态" })
  optIn: boolean;

  @ApiPropertyOptional({
    description: "最近一次授权变更时间（ISO-8601；可为空）",
    type: String,
    nullable: true,
  })
  optedAt: string | null;

  @ApiPropertyOptional({
    description: "HMAC 派生的用户标识，绝不是用户名原文",
    type: String,
    nullable: true,
  })
  userIdHash: string | null;

  @ApiProperty({ description: "最近一次变更的来源标记" })
  source: string;
}

export class AgentTelemetryStatusDto {
  @ApiProperty({ description: "系统总闸状态" })
  systemEnabled: boolean;

  @ApiProperty({ description: "当前已授权采集的安装数" })
  count: number;

  @ApiPropertyOptional({
    description: "各安装中最近的授权时间（ISO-8601；可为空）",
    type: String,
    nullable: true,
  })
  latestOptedAt: string | null;

  @ApiProperty({
    description: "按安装维度的授权概览",
    type: [TelemetryOptinInstallViewDto],
  })
  installs: TelemetryOptinInstallViewDto[];

  @ApiProperty({ description: "已知 executor 数（去重 deviceFingerprint 后）" })
  knownExecutorCount: number;

  @ApiProperty({
    description:
      "授权覆盖率状态：gate_off=总闸未开；no_executors=总闸开但无已知执行器（先开闸后装执行器陷阱）；partial=部分执行器已授权；full=全部已授权",
    enum: ["no_executors", "partial", "full", "gate_off"],
  })
  coverage: "no_executors" | "partial" | "full" | "gate_off";
}
