import { ApiProperty } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12（2026-10-07 A1 批）：AI 配置域响应契约。
 * getEffectiveConfig 返回键值字符串映射（provider/openaiModel/openaiBaseUrl/
 * ollamaHost/ollamaModel/qwenModel/qwenBaseUrl/qwenMaxTokens/qwenTimeoutMs），
 * 密钥不在其中（以 hasApiKey 布尔单独暴露）。
 */

/** GET /ai/config —— 生效配置**扁平键值**（controller 展开返回 {...effective, hasApiKey}）；
 *  密钥值永不出现（以 hasApiKey 布尔单独暴露）。R7 实测修正：首版误建成嵌套
 *  {config:{...}} 形态；数值键（qwenMaxTokens/qwenTimeoutMs）在 config store
 *  里是字符串编码。 */
export class AiConfigResponseDto {
  @ApiProperty({ description: "'qwen' | 'openai' | 'ollama' | 'disabled'" })
  provider: string;

  @ApiProperty()
  openaiModel: string;

  @ApiProperty()
  openaiBaseUrl: string;

  @ApiProperty()
  ollamaHost: string;

  @ApiProperty()
  ollamaModel: string;

  @ApiProperty()
  qwenModel: string;

  @ApiProperty()
  qwenBaseUrl: string;

  @ApiProperty({ description: "string-encoded number (config store values are strings)" })
  qwenMaxTokens: string;

  @ApiProperty({ description: "string-encoded number (ms)" })
  qwenTimeoutMs: string;

  @ApiProperty({ description: "Whether the current provider has an API key configured (key VALUE is never returned)" })
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
