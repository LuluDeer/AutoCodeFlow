import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { ProjectRole } from "../../project/entities/project-member.entity";
import type { ImPlatform } from "../entities/im-identity.entity";

/**
 * N6：ImIdentity 实体的读模型（响应 DTO）。
 *
 * im-identity.entity.ts 的实体类没有 @ApiProperty：Swagger 直接以实体为
 * response type 时 emit 出的组件 properties 为空，前端生成类型会缺字段。
 * 本 DTO 逐一标注实体对用户可见的全部字段，供 list / verify-bind 两个端点
 * 的 200 响应引用。
 *
 * 字段类型与 ImIdentity 实体保持一致，service 返回的实体在 TypeScript
 * 结构类型下天然兼容，无需在 service 层做运行时转换。
 */
export class ImIdentityViewDto {
  @ApiProperty({ description: "绑定关系 UUID" })
  id: string;

  @ApiProperty({ description: "IM 平台：wecom | feishu", example: "wecom" })
  platform: ImPlatform;

  @ApiProperty({
    description: "IM 平台内的 sender id",
    example: "zhangsan",
  })
  imSenderId: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "绑定的平台 user id；NULL = 尚未绑定（verified 必为 false）",
  })
  platformUserId: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "项目归属；NULL = 未分配（沿用平台默认项目视图）",
  })
  projectId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "项目角色：viewer | editor | admin；NULL = 未授予",
  })
  projectRole: ProjectRole | null;

  @ApiProperty({
    description: "是否已通过网关发送方签名验证并完成绑定",
    example: true,
  })
  verified: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: "绑定操作人身份键（user:<id>）；NULL = 系统/迁移写入",
  })
  createdBy: string | null;

  @ApiProperty({ type: Date, description: "创建时间（ISO 8601）" })
  createdAt: Date;

  @ApiProperty({ type: Date, description: "更新时间（ISO 8601）" })
  updatedAt: Date;
}
