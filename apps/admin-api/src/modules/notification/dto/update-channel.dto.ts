import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsObject,
  IsOptional,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
  type ValidationArguments,
} from "class-validator";

/**
 * 动态键 string→string 映射约束（护栏档位与 ChannelConfigOverridePipe
 * 逐字一致——两处是同一护栏的 DTO 侧与管道侧，改一处必须同步另一处）。
 * 声明在 UpdateChannelDto 之前（装饰器实参引用类，声明顺序不可颠倒）。
 */
@ValidatorConstraint({ name: "channel-config-string-map", async: false })
export class ChannelConfigMapConstraint implements ValidatorConstraintInterface {
  private static readonly MAX_KEYS = 32;
  private static readonly MAX_KEY_LENGTH = 64;
  private static readonly MAX_VALUE_LENGTH = 4096;

  validate(value: unknown): boolean {
    if (value === null || value === undefined) return true; // @IsOptional 已挡
    if (typeof value !== "object" || Array.isArray(value)) return false;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > ChannelConfigMapConstraint.MAX_KEYS) return false;
    for (const [k, v] of entries) {
      if (typeof v !== "string") return false;
      if (k.length > ChannelConfigMapConstraint.MAX_KEY_LENGTH) return false;
      if (v.length > ChannelConfigMapConstraint.MAX_VALUE_LENGTH) return false;
    }
    return true;
  }

  defaultMessage(args?: ValidationArguments): string {
    void args;
    return `config must be a string→string map (≤${ChannelConfigMapConstraint.MAX_KEYS} keys, key ≤${ChannelConfigMapConstraint.MAX_KEY_LENGTH} chars, value ≤${ChannelConfigMapConstraint.MAX_VALUE_LENGTH} chars)`;
  }
}

/**
 * P2-3（2026-10-25 审计，F-53 残留清理）：PATCH /notification/channels/:key
 * 的请求体 DTO。
 *
 * 缺陷现场：updateChannel 此前用内联 `{ enabled?: boolean; config?: Record<
 * string, string> }`——metatype=Object，全局 ValidationPipe（whitelist +
 * forbidNonWhitelisted）对本面**整体跳过**：非 string 的 config 值（数字/
 * 嵌套对象）写穿 DB；此后 GET /notification/channels 的 maskChannel 对非
 * string 调 replace 抛 TypeError → PATCH 500 且读面持续 500
 * （hydrateFromPersisted 回灌坏值），一个 PATCH 打挂整条渠道配置读面。
 *
 * 形态对齐同文件 testChannel 已修的先例：动态键映射不做封闭 class（键集随
 * 渠道类型变化），值必须 string + 键数/长度护栏**逐档对齐**
 * ChannelConfigOverridePipe（≤32 键 / 键 ≤64 / 值 ≤4096）。enabled/config
 * 之外的未知字段由全局 whitelist 纪律 400（恢复全站 forbidNonWhitelisted）。
 */
export class UpdateChannelDto {
  @ApiPropertyOptional({ description: "启用/停用该渠道" })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    type: Object,
    description:
      "渠道配置覆盖（string → string 映射，哨兵 '***' 不覆盖真实机密）",
  })
  @IsOptional()
  @IsObject()
  @Validate(ChannelConfigMapConstraint)
  config?: Record<string, string>;
}
