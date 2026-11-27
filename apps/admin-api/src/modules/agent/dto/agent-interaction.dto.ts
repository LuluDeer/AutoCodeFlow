import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { Type } from "class-transformer";
import { ApprovalPhraseResponseDto } from "./approval-phrase.dto";

/**
 * SSE 建连查询白名单：只允许 `ticket` 与 `fromSeq`。
 *
 * ticket 只进白名单做格式校验——鉴权由 JwtStrategy 在
 * `/agent|/workbench/sessions/:id/stream` 路径上读取 `?ticket=`，controller 不
 * 把它当作业务参数。全局 ValidationPipe 的 whitelist 会剥掉其余 query，
 * 防止无关参数被透传到服务层。
 */
export class AgentStreamQueryDto {
  @ApiPropertyOptional({
    description:
      "SSE 专用短效票据（POST /auth/sse-ticket 获取，TTL 30 秒）；仅供 EventSource 建连鉴权，不参与事件查询。长度 1..4096。",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  ticket?: string;

  @ApiPropertyOptional({
    description:
      "断点续传起点：只重放 seq 大于该值的持久化事件；缺省或 0 表示从最早事件开始。非法值由管线判 400，不接受负数。",
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  fromSeq?: number;
}

/** POST /agent/sessions/:id/messages 的请求体。 */
export class AgentMessageDto {
  @ApiProperty({
    description: "用户消息正文（写入前由服务端统一脱敏，长度 1..4000）",
    minLength: 1,
    maxLength: 4000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  content: string;

  @ApiPropertyOptional({
    description:
      "追加方式：followup=作为下一轮输入（默认）；steer=运行中注入步边界。非法值判 400。",
    enum: ["followup", "steer"],
  })
  @IsOptional()
  @IsIn(["followup", "steer"])
  mode?: "followup" | "steer";
}

/** POST /agent/sessions/:id/messages 的响应。 */
export class AgentMessageResponseDto {
  @ApiProperty({ format: "uuid", description: "会话 id" })
  sessionId: string;

  @ApiProperty({
    description:
      "写消息后的会话状态（running=已注入 steer；pending=已重新入队；终态拒绝时保持原状态）",
  })
  status: string;

  @ApiProperty({ description: "新写入的用户步序号" })
  stepSeq: number;

  @ApiProperty({
    description:
      "本次动作：steered=注入运行中会话；enqueued=重新入队 agent-jobs；rejected_terminal=会话已是终态，消息未写入、不触发续跑",
    enum: ["steered", "enqueued", "rejected_terminal"],
  })
  action: "steered" | "enqueued" | "rejected_terminal";

  @ApiPropertyOptional({
    description:
      "仅 action=rejected_terminal 时出现：终态拒绝续跑的原因（可直接展示）",
  })
  reason?: string;
}

/**
 * grant / deny / 短语审批三条处置端点共用的响应 DTO。
 *
 * 继承 `ApprovalPhraseResponseDto` 复用 ok / approval / resumed 三个字段，
 * 只在这里补 deny 后保守自动恢复的失败原因——该字段此前只存在于 controller
 * 的返回对象里，Swagger/OpenAPI 无声明，重导契约后前端看不到。
 */
export class AgentApprovalDecisionResponseDto extends ApprovalPhraseResponseDto {
  @ApiPropertyOptional({
    description:
      "本次处置未自动恢复会话的原因（如会话状态不符、仍有 pending 单、重读/审批查询/入队失败）；成功恢复时省略",
  })
  resumeReason?: string;
}

/** POST /agent/sessions/:id/cancel 的响应。 */
export class AgentCancelResponseDto {
  @ApiProperty({ format: "uuid", description: "会话 id" })
  sessionId: string;

  @ApiProperty({ description: "取消后的会话状态（终态会话保持原状态）" })
  status: string;

  @ApiProperty({
    description:
      "本次请求是否把会话置为 aborted；false 表示会话此前已是终态，没有覆盖既有结论",
  })
  aborted: boolean;
}
