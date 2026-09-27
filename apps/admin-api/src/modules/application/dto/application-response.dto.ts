import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12：应用读面**响应体 DTO**。
 *
 * ## 为什么不能直接标 `type: Application`（实体）
 *
 * 实体类没有 `@ApiProperty` 装饰器，@nestjs/swagger 只会 emit
 * `{type:'object', properties:{}}` —— 一个**空壳 schema**。后果有两层：
 *   ① 前端 `gen:api-types` 生成出 `Record<string, never>`，**比没有类型更坏**
 *      （看着有类型，实际一个字段都写不了）；
 *   ② CI 既有的 PK-15 空 schema 守卫会直接打红（本仓实测踩过：
 *      commit 74afb6f8 的 api-types-drift job 因此失败）。
 * 故必须落成带 `@ApiProperty` 的 DTO。
 *
 * ## 为什么不用 `PickType(Application, ...)`
 *
 * `@nestjs/swagger` 的 PickType 需要源类有 swagger 元数据；实体没有，
 * 映射结果同样为空。故显式声明字段——**顺带把 `webhookSecret` 排除在外**：
 * 它是 `select: false` 的 HMAC 密钥，即便实际响应因 `select:false` 不会带出，
 * 也不该出现在**对外契约文档**里（契约是给第三方照着写的，写明一个永不返回的
 * 密钥字段只会误导）。字段与 `ApplicationService.maskReadSurface` 的输出对齐：
 * `env` 的 secret 类键在读面被掩码为 `***`。
 */
export class ApplicationResponseDto {
  @ApiProperty({ description: "Application id (uuid)" })
  id: string;

  @ApiProperty({ description: "Unique application name" })
  name: string;

  @ApiPropertyOptional({ description: "Human description", nullable: true })
  description: string | null;

  @ApiProperty({ description: "Application version" })
  version: string;

  @ApiProperty({ description: "Runtime identifier (node / python / shell …)" })
  runtime: string;

  @ApiProperty({ description: "Lifecycle status" })
  status: string;

  @ApiPropertyOptional({ description: "Git repository URL", nullable: true })
  gitRepo: string | null;

  @ApiPropertyOptional({ description: "Git branch", nullable: true })
  gitBranch: string | null;

  @ApiPropertyOptional({ description: "Pinned git commit", nullable: true })
  gitCommit: string | null;

  @ApiPropertyOptional({
    description: "Deployment manifest (jsonb)",
    nullable: true,
    type: Object,
  })
  manifest: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description:
      "Environment map; secret-class keys are masked as *** on every read surface",
    nullable: true,
    type: Object,
    example: { LOG_LEVEL: "info", DB_PASSWORD: "***" },
  })
  env: Record<string, string> | null;

  @ApiPropertyOptional({ description: "Entrypoint path", nullable: true })
  entrypoint: string | null;

  @ApiPropertyOptional({ description: "Package download URL", nullable: true })
  packageUrl: string | null;

  @ApiProperty({ description: "Whether deployment requires approval" })
  approvalRequired: boolean;

  @ApiPropertyOptional({
    description: "Owning project id (null = default project view)",
    nullable: true,
  })
  projectId: string | null;

  @ApiPropertyOptional({ description: "Owner user id", nullable: true })
  ownerUserId: number | null;

  @ApiProperty({ description: "Creation time (ISO-8601)" })
  createdAt: Date;

  @ApiProperty({ description: "Last update time (ISO-8601)" })
  updatedAt: Date;

  // 注意：**不声明 webhookSecret**——见类头注。
}
