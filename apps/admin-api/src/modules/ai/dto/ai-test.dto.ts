import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { AI_PURPOSES, type AiPurpose } from "../ai-providers";

/** POST /ai/test —— 连通性测试请求体（所有字段均可选，空体完全兼容存量调用）。 */
export class TestAiProviderDto {
  @ApiPropertyOptional({
    description: "指定待测试的模型接入编号；缺省时按用途路由自动解析",
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  providerId?: string;

  @ApiPropertyOptional({
    description: "测试路由用途：分析、智能体推理或视频理解",
    enum: [...AI_PURPOSES],
  })
  @IsOptional()
  @IsIn([...AI_PURPOSES])
  purpose?: AiPurpose;

  @ApiPropertyOptional({
    description: "是否验证流式增量输出链路（默认否）",
  })
  @IsOptional()
  @IsBoolean()
  testStreaming?: boolean;

  @ApiPropertyOptional({
    description:
      "是否验证工具调用声明透传（开启且未指定用途时默认按智能体用途测试）",
  })
  @IsOptional()
  @IsBoolean()
  testTools?: boolean;
}

/** POST /ai/test —— 连通性测试结构化回执。 */
export class TestAiProviderResponseDto {
  @ApiProperty({ description: "连通性测试是否成功" })
  ok: boolean;

  @ApiProperty({
    description: "实际命中的模型接入编号；未能解析路由时为空",
    nullable: true,
    type: String,
  })
  provider: string | null;

  @ApiProperty({
    description: "实际命中的模型名称；未能解析路由时为空",
    nullable: true,
    type: String,
  })
  model: string | null;

  @ApiProperty({
    description: "本次测试所用的路由用途",
    enum: [...AI_PURPOSES],
  })
  purpose: AiPurpose;

  @ApiProperty({ description: "本次端到端测试耗时（毫秒）" })
  latencyMs: number;

  @ApiProperty({ description: "测试结果说明或真实错误详情" })
  message: string;

  @ApiPropertyOptional({
    description: "失败时的错误分类码（路由拒绝、鉴权失败、超时或网络异常等）",
    nullable: true,
    type: String,
  })
  errorCode?: string | null;

  @ApiPropertyOptional({
    description: "模型返回内容摘要预览（超长时截断展示）",
    nullable: true,
    type: String,
  })
  preview?: string | null;
}
