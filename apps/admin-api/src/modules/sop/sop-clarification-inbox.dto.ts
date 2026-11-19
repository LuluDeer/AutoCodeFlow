import { ApiProperty } from "@nestjs/swagger";

/**
 * R280 · 「升级到人工」澄清的**跨 SOP 聚合读面**响应契约。
 *
 * ## 为什么需要独立 DTO
 *
 * `sop_clarifications.resolution = 'escalated_to_human'` 此前**没有任何可见面**：
 * ① 收件箱七小节不含它；② 按 `status=blocked` 筛不到它（`sop.service.ts` 的
 * 升级落库后立刻把 assignment 从 `blocked` 推回 `in_progress`——「升级即复核完毕」，
 * 见 `sop-clarification-inbox.service.ts` 头注）；③ 唯一的通知出口可被静默规则吞掉。
 * ⇒ 一次请求拿到「升级行 + 总数 + 截断标记 + 降级标记」。
 *
 * ## `null` 与 `0` 的区别（本契约的全部要点）
 *
 *   · `total: null` = **没读到**（读失败）⇒ 前端显示「—」；
 *   · `total: 0`    = **事实是零**（库里真没有待答复的升级）⇒ 前端隐藏整节。
 *
 * 把「没读到」渲染成「没有」是本仓的主导缺陷类：运营会以为活干完了。
 */

/** 一条「升级到人工」的澄清（聚合行的全部字段）。 */
export class SopPendingClarificationItemDto {
  @ApiProperty({ format: "uuid", description: "澄清行 id（答复端点用它定位）" })
  clarificationId: string;

  @ApiProperty({ format: "uuid", description: "所属指派 id" })
  assignmentId: string;

  @ApiProperty({ format: "uuid", description: "所属 SOP id（深链锚点）" })
  sopId: string;

  @ApiProperty({
    nullable: true,
    description:
      "SOP 标题；**读不到或为空时一律 null**，绝不退回 uuid（uuid 不是给人看的标题）",
  })
  sopName: string | null;

  @ApiProperty({ type: Number, description: "澄清轮次（1 起）" })
  round: number;

  @ApiProperty({
    description:
      "执行器 Agent 的原始疑问（**服务端不截断**，截断由前端做——服务端截断会让" +
      "「点开看全文」永远拿不到全文）",
  })
  question: string;

  @ApiProperty({
    format: "date-time",
    description: "提问时刻（ISO，= 澄清行 createdAt）",
  })
  askedAt: string;

  @ApiProperty({
    description:
      "所属指派**当前**状态，如实回。升级后通常是 `in_progress`（不是 `blocked`）——" +
      "「升级后按 blocked 筛不到」正是本端点存在的理由之一",
  })
  assignmentStatus: string;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "处理本次澄清的 `sop_review` 会话（因果链；无会话时为 null）",
  })
  reviewSessionId: string | null;
}

/** `GET /sop/clarifications/pending` 的响应契约。 */
export class SopPendingClarificationsResponseDto {
  @ApiProperty({
    type: [SopPendingClarificationItemDto],
    description:
      "按提问时刻升序（最久没人管的在前——「上周升级还没人管」正是最该被看见的）",
  })
  items: SopPendingClarificationItemDto[];

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      "待人工答复的升级澄清**总数**（独立 `getCount()`，不是 `items.length` 的别名）；" +
      "读不到 ⇒ null，**绝不 0**",
  })
  total: number | null;

  @ApiProperty({
    type: Number,
    description: "本次实际返回的行数（= items.length）",
  })
  returned: number;

  @ApiProperty({
    description:
      "是否截断（`returned < total`）。`total` 未知时为 false——此时「是否截断」" +
      "本身也不可知，由 `degraded` 表达",
  })
  truncated: boolean;

  @ApiProperty({
    description:
      "是否有子查询读失败（此时对应字段为 null）。**HTTP 仍是 200**：部分可用不等于整页失败",
  })
  degraded: boolean;
}
