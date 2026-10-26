import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  Matches,
} from "class-validator";

export class TotpCodeDto {
  @ApiProperty({
    example: "123456",
    description: "6 位 TOTP 动态验证码",
  })
  @IsString()
  @Matches(/^\d{6}$/, { message: "code must be a 6-digit number" })
  code: string;
}

export class TotpVerifyDto {
  @ApiProperty({ example: "admin" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  username: string;

  @ApiProperty({ example: "password123" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;

  @ApiProperty({
    example: "123456",
    description: "6 位 TOTP 动态验证码",
  })
  @IsString()
  @Matches(/^\d{6}$/, { message: "code must be a 6-digit number" })
  code: string;
}

/**
 * F-53（UIAUDIT 后端轮 P2-2）：POST /auth/totp/disable 的请求体改为 class DTO。
 *
 * 此前控制器用内联类型 `{ password?: string; code?: string }`（metatype=Object，
 * 全局 ValidationPipe 直接跳过）——任意多余字段（如 `{"foo":"bar"}`）被静默
 * 收下，「多余字段必 400」的全站纪律在这一面失效（UIAUDIT 实测复现）。
 * class 化后全局 whitelist+forbidNonWhitelisted 纪律自动生效。
 *
 * 字段口径对齐同文件既有形态：password 与 TotpVerifyDto.password 同上限
 * （@MaxLength(128)，不设 @MinLength——输错短密码的失败语义由 service 的
 * bcrypt 比对给出，400 会把「确认失败」误报成「格式错误」）；code 与
 * TotpCodeDto 同 6 位数字正则。两字段二选一（都不给 → service 抛
 * TOTP_DISABLE_CONFIRMATION_REQUIRED），故均为 @IsOptional。
 */
export class TotpDisableDto {
  @ApiPropertyOptional({
    example: "password123",
    description: "确认密码（与 6 位动态码二选一）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;

  @ApiPropertyOptional({
    example: "123456",
    description: "6 位 TOTP 动态验证码（与密码二选一）",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: "code must be a 6-digit number" })
  code?: string;
}
