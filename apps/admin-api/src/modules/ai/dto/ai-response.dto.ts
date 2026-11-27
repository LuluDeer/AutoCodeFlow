import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

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

/** POST /ai/test —— 历史回执契约（兼容引用保留）。 */
export class AiTestResponseDto {
  @ApiProperty({ description: "模型接入被禁用或返回空响应时为否" })
  ok: boolean;

  @ApiProperty({ description: "样例提示词的回复文本，或降级状态下的提示信息" })
  message: string;
}

/** 单个模型接入条目视图（不含密钥明文）。 */
export class AiProviderViewDto {
  @ApiProperty({ description: "模型接入唯一编号" })
  id: string;

  @ApiProperty({ description: "展示名称" })
  label: string;

  @ApiProperty({
    description: "出站协议类型",
    enum: ["openai", "ollama"],
  })
  transport: "openai" | "ollama";

  @ApiProperty({ description: "接口基础地址" })
  baseUrl: string;

  @ApiProperty({ description: "默认模型名称" })
  model: string;

  @ApiProperty({ description: "默认最大输出令牌数" })
  maxTokens: number;

  @ApiProperty({ description: "默认请求超时毫秒数" })
  timeoutMs: number;

  @ApiProperty({ description: "是否支持视频理解输入" })
  supportsVideo: boolean;

  @ApiProperty({ description: "是否启用该模型接入" })
  enabled: boolean;

  @ApiProperty({ description: "是否已配置密钥（永不回传密钥明文）" })
  hasApiKey: boolean;

  @ApiProperty({ description: "是否由旧版配置键自动合成" })
  legacy: boolean;

  @ApiPropertyOptional({ description: "是否被中台出域策略禁止使用" })
  deniedForUse?: boolean;

  @ApiPropertyOptional({
    description: "允许调用的模型白名单",
    type: [String],
  })
  allowedModels?: string[];

  @ApiPropertyOptional({
    description: "禁止调用的模型黑名单",
    type: [String],
  })
  deniedModels?: string[];

  @ApiPropertyOptional({
    description: "按模型名称单独控制的启停状态映射",
    type: "object",
    additionalProperties: { type: "boolean" },
  })
  modelEnabled?: Record<string, boolean>;
}

/** 单个用途的路由覆盖配置。 */
export class AiRouteAssignmentViewDto {
  @ApiProperty({ description: "指向的模型接入编号；空字符串表示跟随全局默认" })
  provider: string;

  @ApiProperty({ description: "覆盖的模型名称；空字符串表示使用接入默认模型" })
  model: string;

  @ApiProperty({ description: "覆盖的最大输出令牌数（字符串编码）" })
  maxTokens: string;

  @ApiProperty({ description: "覆盖的超时毫秒数（字符串编码）" })
  timeoutMs: string;
}

/** 全部用途的路由映射视图。 */
export class AiRoutesViewDto {
  @ApiProperty({
    description: "分析用途路由配置",
    type: AiRouteAssignmentViewDto,
  })
  analysis: AiRouteAssignmentViewDto;

  @ApiProperty({
    description: "智能体推理用途路由配置",
    type: AiRouteAssignmentViewDto,
  })
  agent: AiRouteAssignmentViewDto;

  @ApiProperty({
    description: "视频理解用途路由配置",
    type: AiRouteAssignmentViewDto,
  })
  video: AiRouteAssignmentViewDto;
}

/** GET/PUT/DELETE /ai/providers 与 PUT /ai/routes —— 管理视图响应。 */
export class AiProviderAdminViewDto {
  @ApiProperty({
    description: "已注册的模型接入列表（脱敏视图）",
    type: [AiProviderViewDto],
  })
  providers: AiProviderViewDto[];

  @ApiProperty({
    description: "注册表解析过程中发现的配置错误列表",
    type: [String],
  })
  errors: string[];

  @ApiProperty({
    description: "各业务用途当前路由配置",
    type: AiRoutesViewDto,
  })
  routes: AiRoutesViewDto;
}
