import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

/**
 * N17「一句话审批」的 HTTP 请求体。
 *
 * 只接受 `phrase` 一个字段：`decidedBy` 由 `@CurrentUser` 提供，
 * `policyFingerprint` 由服务端按当前策略快照重算——两者都**不接受请求体自报**
 * （全局 ValidationPipe 的 whitelist 也会剥掉多余字段）。
 */
export class ApprovalPhraseDto {
  @ApiProperty({
    description:
      "审批短语，整句精确匹配（首尾空白与英文大小写归一化）：allow / allow once / 允许 / 批准 / deny / 拒绝 / reset。reset 在 once+TTL 模型下不支持，会返回校验失败。",
    example: "allow",
    minLength: 1,
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  phrase: string;
}

/** 一句话审批的响应信封（失败走稳定错误码，不在此表达）。 */
export class ApprovalPhraseResponseDto {
  @ApiProperty({
    description: "处置是否成功（成功恒为 true，失败由错误码表示）",
  })
  ok: boolean;

  @ApiProperty({
    description:
      "处置后的审批单行快照（含最新 status / decidedBy / decidedAt）",
    type: "object",
    additionalProperties: true,
    nullable: true,
  })
  approval: object | null;

  @ApiProperty({
    description:
      "本次处置是否把会话重新入队恢复（与 grant/deny 端点同口径：仅允许且会话挂起等待审批、无其它 pending 单时为 true）",
  })
  resumed: boolean;
}
