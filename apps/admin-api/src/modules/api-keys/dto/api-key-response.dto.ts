import { ApiProperty } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12（2026-10-07 A1 批）：API Key 域响应契约。
 * 明文 key 仅在 create 响应一次性回显（plaintext-once 纪律），其余读面只见
 * keyPrefix；视图由 service.toView 投影（实体行不直接出站）。
 */

/** API Key 视图（masked 读面）。 */
export class ApiKeyViewDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  name: string;

  @ApiProperty({
    description: "'acf_' + first chars — full key never returned after create",
  })
  keyPrefix: string;

  @ApiProperty({ description: "Coarse scope bucket" })
  scope: string;

  @ApiProperty({
    description: "Extra narrow-domain scopes (word list, e.g. 'task:trigger')",
  })
  scopes: string[];

  @ApiProperty({ nullable: true })
  expiresAt: Date | null;

  @ApiProperty({ description: "Set = revoked (soft-delete)", nullable: true })
  revokedAt: Date | null;

  @ApiProperty({
    description: "Refresh throttled to 60s (LAST_USED_THROTTLE_MS)",
    nullable: true,
  })
  lastUsedAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}

/** POST /api-keys —— 唯一能看到明文 key 的一次。R7 实测修正：controller 把
 *  plaintext **扁平展开进视图**（{...view, plaintext}），不是 {apiKey, plaintext}
 *  嵌套（首版照 service 签名臆测，实响应是平铺的视图字段+plaintext）。 */
export class ApiKeyCreateResponseDto extends ApiKeyViewDto {
  @ApiProperty({
    description: "Plaintext key ('acf_<64 hex>') shown ONCE — store it now",
  })
  plaintext: string;
}

/** POST /api-keys/:id/revoke 与 DELETE /api-keys/:id 的回执。 */
export class ApiKeyRevokeResponseDto {
  @ApiProperty({ enum: [true] })
  success: true;

  @ApiProperty({ type: ApiKeyViewDto })
  apiKey: ApiKeyViewDto;
}
