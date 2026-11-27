import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/** SOP 会话中的单条消息记录。 */
export class AiSopSessionMessageDto {
  @ApiProperty({
    description: "消息发送角色",
    enum: ["user", "assistant"],
  })
  role: "user" | "assistant";

  @ApiProperty({ description: "消息正文内容" })
  text: string;

  @ApiPropertyOptional({
    description: "本轮附带的视频媒体编号列表",
    type: [String],
  })
  mediaIds?: string[];

  @ApiPropertyOptional({
    description: "助手本轮执行的动作类型（追问或产出草稿）",
    enum: ["ask", "draft"],
  })
  action?: "ask" | "draft";

  @ApiProperty({ description: "消息时间戳" })
  at: string;
}

/** SOP 会话关联的录屏媒体引用。 */
export class AiSopSessionMediaRefDto {
  @ApiProperty({ description: "媒体文件编号" })
  mediaId: string;

  @ApiProperty({ description: "原始文件名" })
  name: string;

  @ApiPropertyOptional({ description: "已签发的直链地址（会话内复用）" })
  url?: string;

  @ApiPropertyOptional({ description: "签名直链过期时间戳（毫秒）" })
  expiresAt?: number;
}

/** SOP 会话生成的草稿内容。 */
export class AiSopSessionDraftDto {
  @ApiProperty({ description: "草稿标题" })
  title: string;

  @ApiProperty({ description: "标准化唯一标识" })
  slug: string;

  @ApiProperty({ description: "前置元数据配置文件内容" })
  frontMatterYaml: string;

  @ApiProperty({ description: "步骤正文内容" })
  bodyMarkdown: string;

  @ApiProperty({
    description: "模型显式列出的假设清单",
    type: [String],
  })
  assumptions: string[];

  @ApiProperty({ description: "生成该草稿所用模型接入编号" })
  provider: string;

  @ApiProperty({ description: "生成该草稿所用模型名称" })
  model: string;
}

/** 单轮推理令牌用量统计。 */
export class AiSopSessionUsageDto {
  @ApiProperty({ description: "输入令牌数" })
  tokensIn: number;

  @ApiProperty({ description: "输出令牌数" })
  tokensOut: number;

  @ApiPropertyOptional({ description: "命中前缀缓存的输入令牌数" })
  cachedTokens?: number;
}

/** SOP 编写会话完整视图。 */
export class AiSopSessionViewDto {
  @ApiProperty({ description: "会话编号" })
  id: string;

  @ApiProperty({
    description: "会话状态（进行中、已出草稿或已保存）",
    enum: ["active", "drafted", "saved"],
  })
  status: string;

  @ApiProperty({
    description: "会话消息历史列表",
    type: [AiSopSessionMessageDto],
  })
  messages: AiSopSessionMessageDto[];

  @ApiProperty({
    description: "会话关联的录屏媒体列表",
    type: [AiSopSessionMediaRefDto],
  })
  media: AiSopSessionMediaRefDto[];

  @ApiProperty({
    description: "当前生成的草稿对象，尚未出稿时为空",
    nullable: true,
    type: AiSopSessionDraftDto,
  })
  draft: AiSopSessionDraftDto | null;

  @ApiProperty({
    description: "会话绑定的模型接入编号，缺省时为空",
    nullable: true,
    type: String,
  })
  provider: string | null;

  @ApiProperty({ description: "累计已追问次数" })
  questionsAsked: number;

  @ApiProperty({ description: "剩余可追问次数" })
  remainingQuestions: number;

  @ApiPropertyOptional({ description: "本轮模型是否要求补录视频" })
  needsVideo?: boolean;

  @ApiPropertyOptional({
    description: "最近一轮推理令牌用量",
    type: AiSopSessionUsageDto,
  })
  lastTurnUsage?: AiSopSessionUsageDto;

  @ApiProperty({ description: "会话创建时间" })
  createdAt: Date;

  @ApiProperty({ description: "会话最近更新时间" })
  updatedAt: Date;
}

/** SOP 编写会话列表摘要项。 */
export class AiSopSessionListItemDto {
  @ApiProperty({ description: "会话编号" })
  id: string;

  @ApiProperty({ description: "会话状态" })
  status: string;

  @ApiProperty({ description: "会话创建时间" })
  createdAt: Date;

  @ApiProperty({ description: "会话最近更新时间" })
  updatedAt: Date;

  @ApiProperty({ description: "已关联的录屏数量" })
  mediaCount: number;

  @ApiProperty({
    description: "草稿标题，尚未出稿时为空",
    nullable: true,
    type: String,
  })
  title: string | null;
}

/** GET /ai/sop-sessions —— 个人会话分页列表响应。 */
export class AiSopSessionListResponseDto {
  @ApiProperty({
    description: "会话摘要列表（按更新时间倒序）",
    type: [AiSopSessionListItemDto],
  })
  items: AiSopSessionListItemDto[];

  @ApiProperty({ description: "会话总数" })
  total: number;
}
