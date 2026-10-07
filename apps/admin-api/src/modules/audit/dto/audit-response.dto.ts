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
    description: "Snapshot of the acting username (survives user deletion)",
    nullable: true,
  })
  username: string | null;

  @ApiProperty({
    description: "Dotted action token, e.g. 'task.trigger' / 'user.create'",
  })
  action: string;

  @ApiProperty({ nullable: true })
  resource: string | null;

  @ApiProperty({ nullable: true })
  resourceId: string | null;

  @ApiProperty({
    description: "Free-form context (ip, detail payloads)",
    nullable: true,
    additionalProperties: true,
  })
  detail: Record<string, unknown> | null;

  @ApiProperty({ nullable: true })
  ip: string | null;

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
