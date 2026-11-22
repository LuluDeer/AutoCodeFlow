import { ApiProperty } from "@nestjs/swagger";

/**
 * R286 · 「阻塞工单滞后」只读观测面的响应契约（切片 A）。
 *
 * ## 这个端点存在的理由（产品问题，不是重构）
 *
 * `sop.service.ts:1015-1026` 的 **maxRounds 触顶**路径把 assignment 写成
 * `blocked`（先落一条 `escalated_to_human` 澄清，再 CAS 置 `blocked`）。但
 * `sop.service.ts:1544-1546` 的**超时扫描只取** `status IN ('assigned','in_progress')`
 * ⇒ **`blocked` 被整体豁免**。两条事实叠加的后果：
 *
 * | 路径 | 有无服务端兜底 |
 * |---|---|
 * | maxRounds 触顶 ⇒ blocked | **无**：扫描看不见它，状态机里也没有别的边把它推走 |
 * | 澄清升级 ⇒ blocked → in_progress（`:1745-1752`） | 有：升级即复核完毕，状态自己走 |
 *
 * ⇒ maxRounds 这条工单**永远停在 blocked**。它不会失败、不会超时、不会进任何
 * 「待处理」列表——**在生产上看起来像「正在等人工」，实际上没有任何人在等**。
 *
 * ## 为什么是「只读观测」而不是「补一条扫描把它推回 in_progress」
 *
 * 那是**改状态机语义**，裁决已明确否决：`blocked` 的意思是「等人工」，把它改回
 * `in_progress` 会让这个信号消失（另一条升级路径正是这么做的，所以它「看起来
 * 已处理」）。本轮只补**可见性**——让人能看见「这些单卡了多久」，处置由人决定。
 *
 * ## 契约里的 `null` 与 `0`（与 R280 收件箱同一条纪律）
 *
 *   · `total: null` = **没读到**（读失败）⇒ 前端显示「—」+ 降级提示；
 *   · `total: 0`    = **事实是零**（库里真没有滞留的 blocked 工单）⇒ 前端隐藏整节。
 *
 * 把「没读到」渲染成「没有」是本仓反复踩的假事实：运营会以为滞留队列是空的。
 */

/**
 * 一条「滞后的 blocked 工单」。
 *
 * ⚠️ `status` 在这个契约里**恒为 `'blocked'`**（谓词是字面量常量，见
 * `LAGGING_ASSIGNMENT_STATUS`）。保留这个字段是为了让响应**自解释**——
 * 前端不必靠「这个端点的名字」去推断行的状态；将来若放宽谓词（例如把 `stalled`
 * 也纳入），消费方不需要改形状就能正确分流。
 */
export class SopAssignmentLagItemDto {
  @ApiProperty({ format: "uuid", description: "滞留的指派 id" })
  assignmentId: string;

  @ApiProperty({ format: "uuid", description: "所属 SOP id（深链锚点）" })
  sopId: string;

  @ApiProperty({
    nullable: true,
    description:
      "SOP 标题；**读不到或为空时一律 null**，绝不退回 uuid（uuid 不是给人看的标题）",
  })
  sopName: string | null;

  @ApiProperty({
    description:
      "指派状态，本端点目前恒为 `blocked`（谓词是字面量，不混入其它值）",
  })
  status: string;

  @ApiProperty({
    format: "date-time",
    description:
      "进入当前状态的时刻（ISO，= 指派行 `updatedAt`）。**非 null**：谓词本身就是" +
      "`updatedAt <= now - hours`，时间戳缺失的行在构造上不可能被选中；" +
      "前端「已阻塞 X 小时」由它与当前时间算出——**不要拿查询窗口 `hours` 顶替**",
  })
  blockedSince: string;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description:
      "该滞留工单最近一条 `escalated_to_human` 澄清（maxRounds 触顶路径必有一条）；" +
      "无澄清或澄清子查询读失败时为 null——后者伴随 `degraded: true`",
  })
  staleClarificationId: string | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      "上述澄清的轮次（`sop_clarifications.round`，1 起）。**null = 未知或无**" +
      "（没有 escalated 澄清，或该子查询读失败），不是「第 0 轮」——" +
      "前端渲染「第 — 轮」，不要编造数字",
  })
  round: number | null;
}

/** `GET /sop/assignments/lagging` 的响应契约。 */
export class SopAssignmentLagResponseDto {
  @ApiProperty({
    type: [SopAssignmentLagItemDto],
    description:
      "按进入 blocked 的时刻升序（卡得最久的在最前——那正是最该被看见的）",
  })
  items: SopAssignmentLagItemDto[];

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      "滞留 blocked 工单**总数**（独立 `getCount()`，不是 `items.length` 的别名）；" +
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
      "是否有子查询读失败（此时对应字段为 null）。**HTTP 仍是 200**：" +
      "部分可用不等于整页失败；但装配缺失（服务未注入）是 503，不是空信封",
  })
  degraded: boolean;
}
