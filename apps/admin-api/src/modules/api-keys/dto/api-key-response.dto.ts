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
    description: "'acf_' + 前缀若干字符——创建之后不再返回完整 key",
  })
  keyPrefix: string;

  @ApiProperty({ description: "粗粒度范围桶" })
  scope: string;

  @ApiProperty({ description: "额外的细粒度范围（词表，例如 'task:trigger'）" })
  scopes: string[];

  @ApiProperty({ nullable: true })
  expiresAt: Date | null;

  @ApiProperty({
    nullable: true,
    description: "有值 = 已吊销（软删除）",
  })
  revokedAt: Date | null;

  @ApiProperty({
    nullable: true,
    description: "刷新被限流至 60 秒（LAST_USED_THROTTLE_MS）",
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
    description: "明文 key（'acf_<64 hex>'）仅展示一次——请立即保存",
  })
  plaintext: string;
}

/**
 * 撤销回执：`POST /api-keys/:id/revoke`、`DELETE /api-keys/:id`（软删）。
 * `DELETE /api-keys/:id/permanent`（硬删）复用同一形状——success + 行快照
 * （删除前），不为同一形状再造一个 schema。
 */
export class ApiKeyRevokeResponseDto {
  @ApiProperty({ enum: [true] })
  success: true;

  @ApiProperty({ type: ApiKeyViewDto })
  apiKey: ApiKeyViewDto;
}
