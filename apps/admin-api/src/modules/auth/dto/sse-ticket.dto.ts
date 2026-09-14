import { ApiProperty } from "@nestjs/swagger";

/**
 * A5（DEEP_REVIEW §七 A5）：SSE 短效票据响应。
 *
 * EventSource 不支持自定义请求头，浏览器原生 SSE 只能把凭据放进查询串。此前
 * 前端直接把 access token（15min）放进 `?access_token=`；现在改为先换这枚
 * 30 秒有效的专用票据再建流，泄漏面从「15 分钟全权令牌」降为「30 秒、且只能在
 * 三条 SSE 路径上使用的专用票据」。
 */
export class SseTicketResponseDto {
  @ApiProperty({
    description:
      "SSE 专用短效票据；作为 ?ticket= 查询串使用，30 秒后失效，且只在三条 /stream 路由上被读取",
  })
  ticket: string;

  @ApiProperty({ description: "票据过期时间（ISO 8601）" })
  expiresAt: string;
}
