import { ApiProperty } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12（2026-10-07 A1 批）：审计域响应契约。
 * findAll 是**裸 {data,total} 分页**（非 paginate() 双键信封）。
 */

/** audit_logs 行的响应形态。 */
export class AuditLogDto {
  @ApiProperty()
  id: number;

  @ApiProperty({ nullable: true })
  userId: number | null;

  @ApiProperty({
    nullable: true,
    description: "操作人用户名的快照（用户被删除后仍保留）",
  })
  username: string | null;

  @ApiProperty({
    description: "点分格式的操作标识，例如 'task.trigger' / 'user.create'",
  })
  action: string;

  @ApiProperty({ nullable: true })
  resource: string | null;

  @ApiProperty({ nullable: true })
  resourceId: string | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "自由格式的上下文（ip、明细载荷）",
  })
  detail: Record<string, unknown> | null;

  @ApiProperty({ nullable: true })
  ip: string | null;

  @ApiProperty({ description: "审计落库时记录的写入结果（缺省 'success'）" })
  result: string;

  @ApiProperty()
  createdAt: Date;
}

/** GET /audit —— 裸 {data,total}。 */
export class PaginatedAuditLogsDto {
  @ApiProperty({ type: [AuditLogDto] })
  data: AuditLogDto[];

  @ApiProperty()
  total: number;
}
