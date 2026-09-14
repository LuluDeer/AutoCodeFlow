import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ExecutionStatus } from "../../task/entities/task-execution.entity";

/**
 * A6（DEEP_REVIEW 0ef3bbe §七）：死信对账端点的响应契约。
 *
 * 这是**执行器机器面**的只读契约（与 heartbeat/pull 同层），不是用户 UI 契约：
 * 执行器拿它去核对本地死信目录里的回调是否还值得重发。因此字段刻意保持最小
 * ——只回「已经终态了没有」以及「什么时候终态的」，不回日志/结果/产物（那些
 * 字节量级会让对账请求本身变成噪声源）。
 *
 * 三端共载：admin-api（本文件，openapi schema 源）、executor-node
 * （src/callback.ts 的 reconcile 消费方）、executor-python
 * （routers/execute.py 的 reconcile 消费方）。字段名变更必须三端同改，
 * 由各自单测钉住。
 */
export class TerminalStateItemDto {
  @ApiProperty({
    description: "执行 id（与 dispatch 下发、回调上报的 executionId 同源）",
    example: "b3f1c0de-1f2a-4c77-9a10-2f6d2c1e9a01",
  })
  executionId: string;

  @ApiProperty({
    description: "该执行当前的状态；本端点只回终态取值",
    enum: [
      ExecutionStatus.SUCCESS,
      ExecutionStatus.FAILED,
      ExecutionStatus.TIMEOUT,
      ExecutionStatus.KILLED,
      ExecutionStatus.CANCELLED,
    ],
    example: ExecutionStatus.SUCCESS,
  })
  status: ExecutionStatus;

  @ApiProperty({
    description:
      "终态时间（ISO 8601）。endTime 缺失时（如未启动即被取消）回 createdAt 兜底值",
    example: "2026-09-14T08:12:33.120Z",
  })
  endedAt: string;
}

export class TerminalStatesResponseDto {
  @ApiProperty({
    description:
      "已终态的执行清单，按终态时间**升序**（便于调用方按水印增量消费：处理到哪条就把下一条的时间当下次 since）",
    type: [TerminalStateItemDto],
  })
  items: TerminalStateItemDto[];

  @ApiPropertyOptional({
    description:
      "true 表示还有更多未返回（已达 limit）。调用方应在下一轮对账继续取，不要误判为「其余都还没终态」",
    example: false,
  })
  hasMore: boolean;

  @ApiProperty({
    description:
      "服务端当前时间（ISO 8601）。执行器用它校正自己的时钟偏差后再算 since ——执行器与 admin 时钟不一致会让 since 窗口错位，直接漏掉刚终态的行",
    example: "2026-09-14T08:20:00.000Z",
  })
  serverTime: string;
}
