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
  @ApiProperty({
    description: "AI 提供方，取值：'qwen' | 'openai' | 'ollama' | 'disabled'",
  })
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

  @ApiProperty({ description: "字符串编码的数字（配置存储中的值均为字符串）" })
  qwenMaxTokens: string;

  @ApiProperty({ description: "字符串编码的数字（毫秒）" })
  qwenTimeoutMs: string;

  @ApiProperty({
    description: "当前 provider 是否已配置 API key（key 的**值**永不返回）",
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
  @ApiProperty({ description: "provider 被禁用或返回空响应时为 false" })
  ok: boolean;

  @ApiProperty({ description: "样例提示词的回复文本，或降级状态下的提示信息" })
  message: string;
}
