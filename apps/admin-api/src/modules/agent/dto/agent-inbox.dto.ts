import { ApiProperty } from "@nestjs/swagger";

/**
 * R278 · 待办收件箱的**服务端聚合**响应契约。
 *
 * ## 为什么这两个端点需要独立 DTO
 *
 * 收件箱此前由前端「先拉会话列表、再逐个拉审批单」拼出来（`api/inbox.ts`）⇒
 * N+1、客户端聚合、三处静默截断（50 / 20 / 100 vs 200）。把聚合搬到服务端后，
 * 契约从「若干裸数组」变成**一个带 `total` / `truncated` / `degraded` 的信封**
 * ——这三个字段是这次搬迁的**全部目的**，不是附加信息：
 *
 *   · `total`     —— 「一共多少」的独立计数（不是 `items.length`）；
 *   · `truncated` —— 「取了 N 条但不保证是全部」必须**可见**（不静默截断）；
 *   · `degraded`  —— 「某个子查询读失败」必须**说不出来**，而不是渲染成 0
 *                    （「没读到」渲染成「没有」是本仓主导缺陷类）。
 *
 * ## 为什么 `null` 而不是 0
 *
 * `null` = **未知**（读失败 / 服务缺席），`0` = **事实是零**。两者语义不同，
 * 前端据此分别渲染「—」与「0」。`queueStall` 的三态同理（`0 | 1 | null`）。
 */

/** 单张待审批单（聚合行的全部字段，逐字对齐 `GET /agent/approvals/pending`）。 */
export class AgentPendingApprovalItemDto {
  @ApiProperty({
    description:
      "审批幂等键（= `agent_tool_calls.approvalId`，`apr-<sessionId>-<指纹>`）；处置端点用它定位",
  })
  approvalKey: string;

  @ApiProperty({ format: "uuid", description: "所属会话 id" })
  sessionId: string;

  @ApiProperty({
    nullable: true,
    description:
      "会话标题；**会话没有标题或标题读不到时一律 null**，绝不退回 uuid（uuid 不是给人看的标题）",
  })
  sessionTitle: string | null;

  @ApiProperty({ description: "触发闸门的工具名" })
  toolName: string;

  @ApiProperty({
    nullable: true,
    description: "闸门给出的审批理由（原样透传）",
  })
  reason: string | null;

  @ApiProperty({ format: "date-time", description: "申请时刻（ISO）" })
  createdAt: string;

  @ApiProperty({
    nullable: true,
    description:
      "人类可读的参数预览（**写入侧已脱敏 + 已截断**，本端点只透出，不新增序列化面）；null = 旧单无预览或本次调用无参数",
  })
  preview: string | null;

  @ApiProperty({
    nullable: true,
    description:
      "被批参数的完整摘要 `sha256(canonicalJson(args))`（64 位 hex）；null = 本列上线前的旧单",
  })
  argsDigest: string | null;
}

/**
 * `GET /agent/approvals/pending` 的响应契约。
 */
export class AgentPendingApprovalsResponseDto {
  @ApiProperty({
    type: [AgentPendingApprovalItemDto],
    description: "按申请时刻升序（最久等待的在前）",
  })
  items: AgentPendingApprovalItemDto[];

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      "待审批单**总数**（独立 `count()`，不是 `items.length` 的别名）；读不到 ⇒ null，**绝不 0**",
  })
  total: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      "这些待审批单涉及的**会话数**（`COUNT(DISTINCT sessionId)`）；读不到 ⇒ null",
  })
  sessionTotal: number | null;

  @ApiProperty({
    type: Number,
    description: "本次实际返回的行数（= items.length）",
  })
  returned: number;

  @ApiProperty({
    description:
      "是否截断（`returned < total`）。`total` 未知时为 false —— 此时「是否截断」本身也不可知，由 `degraded` 表达",
  })
  truncated: boolean;

  @ApiProperty({
    description:
      "是否有子查询读失败（此时对应字段为 null）。**HTTP 仍是 200**：部分可用不等于整页失败",
  })
  degraded: boolean;
}

/**
 * `GET /agent/inbox/counts` 的响应契约（顶栏徽标的唯一计数源）。
 */
export class AgentInboxCountsResponseDto {
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      "待审批单数（口径 = 审批单，与列表行数一致；会话数见 waitingSessions）。读不到 ⇒ null",
  })
  pendingApprovals: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: "`waiting_input` 会话数。读不到 ⇒ null",
  })
  waitingSessions: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      "「卡住」会话数（判据见 `docs/observability/agent-stalled-criterion.md`）。读不到 ⇒ null",
  })
  stalled: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      "调度积压会话数（判据见 `docs/observability/agent-backlog-criterion.md`）。读不到 ⇒ null",
  })
  backlogged: number | null;

  @ApiProperty({
    description:
      "积压对账是否被探测上限截断（`true` ⇒ `backlogged` 是**下界**，前端按 `N+` 渲染）",
  })
  backlogTruncated: boolean;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: "待审批的部署数。读不到 ⇒ null",
  })
  deployments: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      "队列是否停摆：1 = 停摆、0 = 未停摆、null = 判定不可用（**不代表队列正常**）",
  })
  queueStall: number | null;

  @ApiProperty({
    description:
      "是否有任一计数读不到（此时对应字段为 null）。**HTTP 仍是 200**；全部读不到才算整体不可用（503）",
  })
  degraded: boolean;
}
