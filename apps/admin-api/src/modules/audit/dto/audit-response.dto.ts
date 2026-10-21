import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

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

/**
 * GET /audit —— 裸 `{data,total}`（**不是** paginate() 的双键信封）。
 *
 * PLAN-BACKEND-ARCHITECTURE §2.1（游标分页·加性过渡）：本类**只新增**了可选的
 * `nextCursor`，既有两个字段的类型与名字一个都没动—— `{data,total}` 被
 * admin-web 的审计页、`packages/acf-cli` 的 `audit list`（读 `data.data` /
 * `data.total`）消费。改信封形状是破坏性的，故本轮只做加性扩展。
 *
 * `nextCursor` 的**出现条件**（别按"恒下发"理解，与 task 域三个端点逐字一致）：
 *   · 请求不带 `cursor` → 走 OFFSET 分支，该键**根本不出现**（响应与引入游标
 *     之前逐字节一致）。故它不可能是必填。
 *   · 请求带 `cursor` → 走 keyset 分支，该键必然出现：字符串 = 下一页游标，
 *     `null` = 已到末页。调用方据"键是否存在"判断服务端是否在 keyset 模式，
 *     据"是否 null"判断是否翻完。
 *
 * 之所以是 `@ApiPropertyOptional` 而不是 `@ApiProperty({ nullable: true })`：
 * 契约必须能表达"**键可能不存在**"，否则与 OFFSET 分支的真实响应不符——而
 * OFFSET 分支是当前全部消费方唯一在用的路径。
 *
 * 注意 `total`：keyset 分支下**仍然是真实总数**（复用同条件的 COUNT，见
 * audit.service 的 `findAllByKeyset`），不返回 -1/近似值——审计页按 `total`
 * 渲染"共 N 条"，撒谎会让管理员看到错的分页总数。
 */
export class PaginatedAuditLogsDto {
  @ApiProperty({ type: [AuditLogDto] })
  data: AuditLogDto[];

  @ApiProperty()
  total: number;

  /**
   * 仅当请求带 `cursor` 时出现（keyset 分支）：`null` = 已到末页。
   *
   * 与 `PaginatedExecutionListDto#nextCursor` 同款契约；游标里的 id 是本表
   * `integer` 主键的十进制字符串形态（`audit_logs.id` 不是 uuid）。
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      "keyset 分页的下一页游标；null = 已到末页。仅当请求带 cursor 参数时出现（此时走 keyset 分支）；不带 cursor 的请求走 OFFSET 分支，响应中不含该键。游标绑定本端点固定排序（createdAt DESC, id DESC）。",
  })
  nextCursor?: string | null;
}

/**
 * GET /audit/actions —— R67-A1：审计页 action 过滤器的**可发现**数据源。
 *
 * 背景：动作已 61 个（19 个域），而过滤框此前是自由文本——用户不背下动作名就筛不到。
 * 本契约只回一份「库里真实出现过的动作」清单（DB 侧 DISTINCT + ORDER BY，见
 * AuditService#listDistinctActions），**不新增任何审计 action**，也不改 GET /audit 的响应。
 *
 * 形状刻意是最素的 `{ actions: string[] }`（而不是分页信封）：它是一份用于渲染下拉的
 * 小集合，没有翻页语义；空库返回 `{ actions: [] }`（不是 404、不是 null），前端据此
 * 保留"自由输入"这条兜底路径。
 */
export class AuditActionsDto {
  @ApiProperty({
    type: [String],
    description:
      "库里出现过（去重、按字母序）的审计动作取值。来源于 audit_logs.action 的历史写入，故可能包含已下线的动作。",
  })
  actions: string[];
}
