import { ApiProperty } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12（2026-10-07 A1 批）：AI 配置域响应契约。
 * getEffectiveConfig 返回键值字符串映射（provider/openaiModel/openaiBaseUrl/
 * ollamaHost/ollamaModel/qwenModel/qwenBaseUrl/qwenMaxTokens/qwenTimeoutMs），
 * 密钥不在其中（以 hasApiKey 布尔单独暴露）。
 */

/** GET /ai/config —— 生效配置（无密钥值）。 */
export class AiConfigResponseDto {
  @ApiProperty({
    description:
      "Effective config key/values (provider, openaiModel, openaiBaseUrl, ollamaHost, ollamaModel, qwenModel, qwenBaseUrl, qwenMaxTokens, qwenTimeoutMs)",
    additionalProperties: { type: "string" },
  })
  config: Record<string, string>;

  @ApiProperty({
    description:
      "Whether the current provider has an API key configured (key VALUE is never returned)",
  })
  hasApiKey: boolean;
}

/** POST /ai/config —— 保存回执。 */
export class AiConfigSaveResponseDto {
  @ApiProperty({ enum: [true] })
  ok: true;
}

/** POST /ai/test —— 样例推理回执（fail-open：provider 未启用也是 200）。 */
export class AiTestResponseDto {
  @ApiProperty({
    description:
      "false when the provider is disabled or returned an empty response",
  })
  ok: boolean;

  @ApiProperty({
    description: "Sample-prompt reply text, or the degraded-state message",
  })
  message: string;
}
