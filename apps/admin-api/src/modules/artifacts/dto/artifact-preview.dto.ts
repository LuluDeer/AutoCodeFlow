import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

/** GET /artifacts/:name/preview 的预览字节上限（默认 64 KiB，允许 1 KiB..256 KiB）。 */
export const ARTIFACT_PREVIEW_DEFAULT_MAX_BYTES = 65_536;
export const ARTIFACT_PREVIEW_MIN_MAX_BYTES = 1_024;
export const ARTIFACT_PREVIEW_MAX_MAX_BYTES = 262_144;

/** 查询参数 maxBytes 的 DTO；越界值由全局 ValidationPipe 返回 400。 */
export class ArtifactPreviewQueryDto {
  @ApiPropertyOptional({
    description:
      "预览最多读取的字节数（默认 65536，允许 1024..262144）。文本类按 UTF-8 解码返回，图片/二进制 content 为 null。",
    minimum: ARTIFACT_PREVIEW_MIN_MAX_BYTES,
    maximum: ARTIFACT_PREVIEW_MAX_MAX_BYTES,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(ARTIFACT_PREVIEW_MIN_MAX_BYTES)
  @Max(ARTIFACT_PREVIEW_MAX_MAX_BYTES)
  maxBytes?: number;
}

/** 有界预览响应体。 */
export class ArtifactPreviewResponseDto {
  @ApiProperty({ description: "产物文件名（裸文件名）" })
  name: string;

  @ApiProperty({ description: "内容的 MIME 类型" })
  mimeType: string;

  @ApiProperty({ description: "磁盘上产物的完整字节数" })
  size: number;

  @ApiProperty({
    description:
      "是否因 maxBytes 上限而截断（true 表示 content 只是文件开头的一部分）",
  })
  truncated: boolean;

  @ApiProperty({
    enum: ["text", "image", "binary"],
    description:
      "预览类型：text=文本（UTF-8 content 可读）；image/binary=非文本（content 为 null）",
  })
  kind: "text" | "image" | "binary";

  @ApiPropertyOptional({
    nullable: true,
    description:
      "kind=text 时为至多 maxBytes 字节的 UTF-8 文本预览；image/binary 恒为 null",
  })
  content: string | null;
}
