import { ApiProperty } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12：认证面**响应体 DTO**。
 *
 * 这些端点此前只有 `@ApiResponse({ status, description })`——没有 `type`，
 * 于是 openapi.json 里对应的 2xx 只有 `{ description: "" }`、**没有 schema**。
 * 后果是前端 `gen:api-types` 生成不出类型，只能手写 interface（实测全仓
 * 208 个 2xx 里 174 个如此，84%），这也是「手写 interface 替换过半」这个
 * ARCH-23 验收指标一直卡住的真因——**瓶颈在后端装饰器覆盖，不在生成链**。
 *
 * 注意这里**不直接标注 service 的内联返回对象**：内联字面量无法被
 * @nestjs/swagger 反射成具名 schema，必须落成类。故按端点语义各建一个
 * 响应 DTO，并在控制器上用 `@ApiResponse({ type: ... })` 引用。
 *
 * 字段与 service 实际返回逐一对齐（含可空性），避免"文档说非空、实际返回 null"
 * 这类漂移——那比没有 schema 更坏（前端会按错误的类型写代码）。
 */

/** POST /auth/totp/setup 响应：暂存的 Base32 密钥 + otpauth:// 供扫码。 */
export class TotpSetupResponseDto {
  @ApiProperty({
    description: "Base32-encoded TOTP secret (staged, not yet active)",
  })
  secret: string;

  @ApiProperty({
    description: "otpauth:// URL for authenticator apps",
    example: "otpauth://totp/AutoCodeFlow:admin?secret=...&issuer=AutoCodeFlow",
  })
  otpauthUrl: string;
}

/** POST /auth/totp/enable 响应：验证通过后 TOTP 已生效。 */
export class TotpEnableResponseDto {
  @ApiProperty({ description: "Always true on success (400 otherwise)" })
  enabled: boolean;
}

/**
 * POST /auth/totp/disable 响应。
 *
 * 注意字段名是 `disabled` 而非 `enabled`（与 enable 不对称），且
 * **幂等语义**：对未开启 2FA 的账号调用返回 `{ disabled: false }` 且仍为 200
 * ——不是失败，是"本来就没开"。前端据此区分"关掉了"与"本来就是关的"。
 */
export class TotpDisableResponseDto {
  @ApiProperty({
    description:
      "True when this call actually turned TOTP off; false when it was already off (idempotent no-op)",
  })
  disabled: boolean;
}

/** GET /auth/sessions 的单行：调用方自己那条 `current=true`。 */
export class AuthSessionRowDto {
  @ApiProperty({ description: "refresh_tokens row id (opaque session handle)" })
  id: string;

  @ApiProperty({ description: "JWT id of the session; also the revoke key" })
  jti: string;

  @ApiProperty({ description: "Session creation time (ISO-8601)" })
  createdAt: Date;

  @ApiProperty({ description: "Session expiry (ISO-8601)", nullable: true })
  expiresAt: Date | null;

  @ApiProperty({ description: "User-Agent captured at login", nullable: true })
  userAgent: string | null;

  @ApiProperty({ description: "Client IP captured at login", nullable: true })
  ip: string | null;

  @ApiProperty({ description: "True for the session making this request" })
  current: boolean;
}

/** POST /auth/sessions/revoke-others 响应：被撤销的会话数。 */
export class RevokeOthersResponseDto {
  @ApiProperty({ description: "Number of sessions revoked" })
  revoked: number;
}
