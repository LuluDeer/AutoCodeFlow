/**
 * R289 · `SopAssignmentActionsService` 单测与并发 CAS 反证。
 *
 * 覆盖：
 *  ① 四类非终态（assigned/in_progress/blocked/stalled）均可单条取消，且只写
 *     `status: "cancelled"` 一列，保留 `resultJson` / `progressJson` 历史；
 *  ② 三类终态（completed/failed/cancelled）与并发 CAS 败北一律抛 400
 *     `SOP_ASSIGNMENT_TERMINAL`、不覆写终态、不落审计；
 *  ③ 不存在 → 404 `SOP_ASSIGNMENT_NOT_FOUND`；缺仓储装配 → 503 `DEPENDENCY_UNAVAILABLE`；
 *  ④ 审计复用 `sop.assignment.cancel` + `resource: "sop_assignment"` + `detail.sopId`，
 *     非空 `reason` 必经 `sanitizeSecrets` 脱敏，空串省略 `reason`/`reasonLength`，
 *     审计故障 fail-open + error 留痕；
 *  ⑤ DTO（`CancelSopAssignmentDto`）与 `ParseUuidShapePipe` 的请求边界校验。
 */
import { BadRequestException, ValidationPipe } from "@nestjs/common";

import { ParseUuidShapePipe } from "../../../common/pipes/parse-uuid-shape.pipe";
import {
  CANCELLABLE_ASSIGNMENT_STATUSES,
  SopAssignmentActionsService,
} from "../sop-assignment-actions.service";
import {
  CANCEL_ASSIGNMENT_REASON_MAX_LENGTH,
  CancelSopAssignmentDto,
} from "../sop-assignment-actions.dto";
import type { SopAssignmentStatus } from "../entities/sop-assignment.entity";

type Any = Record<string, any>;

/** 最小 FindOperator 求值器（支持 in / not，未识别操作符抛错防假绿）。 */
function valueMatches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && "type" in (expected as Any)) {
    const op = expected as Any;
    if (op.type === "in") return (op.value as unknown[]).includes(actual);
    if (op.type === "not") return !valueMatches(actual, op.child);
    throw new Error(`fake 不支持的操作符: ${String(op.type)}`);
  }
  return actual === expected;
}

function whereMatches(row: Any, where: Any): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => valueMatches(row[k], v));
}

function harness(
  options: {
    assignment?: Any | null;
    concurrentWrite?: () => void;
    auditThrows?: boolean;
    noAudit?: boolean;
  } = {},
) {
  const now = new Date("2026-11-20T12:00:00.000Z");
  const row: Any | null =
    options.assignment === null
      ? null
      : {
          id: "11111111-1111-4111-8111-111111111111",
          sopId: "22222222-2222-4222-8222-222222222222",
          sopVersion: "1.2.0",
          targetExecutorId: "33333333-3333-4333-8333-333333333333",
          targetAgentSessionId: "agent-sess-1",
          status: "blocked" as SopAssignmentStatus,
          clarificationRound: 5,
          maxRounds: 5,
          resultJson: { priorEvidence: "keep-me" },
          parentSessionId: null,
          pulledAt: now,
          lastProgressAt: now,
          progressJson: { step: 2 },
          attempt: 1,
          lastReplyDeliveredAt: null,
          capabilitySnapshotJson: null,
          permissionProfileAtPull: null,
          assignedBy: "user:1",
          createdAt: now,
          updatedAt: now,
          ...options.assignment,
        };

  let interleave = options.concurrentWrite;
  const assignments = {
    findOne: jest.fn(async ({ where }: Any) => {
      if (!row || !whereMatches(row, where)) return null;
      return { ...row };
    }),
    update: jest.fn(async (where: Any, patch: Any) => {
      if (interleave) {
        const fn = interleave;
        interleave = undefined;
        fn();
      }
      if (!row || !whereMatches(row, where)) return { affected: 0 };
      Object.assign(row, patch, {
        updatedAt: new Date("2026-11-20T13:00:00.000Z"),
      });
      return { affected: 1 };
    }),
  };

  const audit = options.noAudit
    ? undefined
    : {
        log: options.auditThrows
          ? jest.fn(async (_payload: Any) => {
              throw new Error("audit db down");
            })
          : jest.fn(async (_payload: Any) => undefined),
      };

  const service = new SopAssignmentActionsService(
    assignments as never,
    audit as never,
  );
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  (service as Any).logger = logger;

  return { service, row, assignments, audit, logger };
}

describe("SopAssignmentActionsService · 单条取消指派（R289）", () => {
  it.each(CANCELLABLE_ASSIGNMENT_STATUSES)(
    "非终态 %s → 条件写置为 cancelled，只写 status 一列并保留 resultJson",
    async (initialStatus) => {
      const h = harness({ assignment: { status: initialStatus } });
      const out = await h.service.cancelAssignment({
        assignmentId: h.row!.id,
        actor: "user:7",
        audit: { userId: 7, username: "alice", ip: "10.0.0.8" },
      });

      expect(out.previousStatus).toBe(initialStatus);
      expect(out.assignment.status).toBe("cancelled");
      expect(out.assignment.resultJson).toEqual({ priorEvidence: "keep-me" });
      expect(h.row!.status).toBe("cancelled");

      // 断言条件写形态：where 同时带 id 与四态 In(...)，patch 只含 status
      expect(h.assignments.update).toHaveBeenCalledTimes(1);
      const [where, patch] = h.assignments.update.mock.calls[0] as Any[];
      expect(where.id).toBe(h.row!.id);
      expect(where.status.type).toBe("in");
      expect([...where.status.value].sort()).toEqual(
        ["assigned", "blocked", "in_progress", "stalled"].sort(),
      );
      expect(patch).toEqual({ status: "cancelled" });
    },
  );

  it.each(["completed", "failed", "cancelled"] as const)(
    "终态 %s → 抛 400 SOP_ASSIGNMENT_TERMINAL，不写库、不落审计",
    async (terminalStatus) => {
      const h = harness({ assignment: { status: terminalStatus } });

      await expect(
        h.service.cancelAssignment({ assignmentId: h.row!.id }),
      ).rejects.toMatchObject({
        errorCode: "SOP_ASSIGNMENT_TERMINAL",
        params: { status: terminalStatus },
      });
      expect(h.assignments.update).not.toHaveBeenCalled();
      expect(h.audit!.log).not.toHaveBeenCalled();
    },
  );

  it("指派不存在 → 抛 404 SOP_ASSIGNMENT_NOT_FOUND，不写库、不落审计", async () => {
    const h = harness({ assignment: null });

    await expect(
      h.service.cancelAssignment({
        assignmentId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toMatchObject({
      errorCode: "SOP_ASSIGNMENT_NOT_FOUND",
    });
    expect(h.assignments.update).not.toHaveBeenCalled();
    expect(h.audit!.log).not.toHaveBeenCalled();
  });

  it("并发竞态：读取为 blocked 后执行器抢先 completed → CAS 败北抛 400、不覆写结果、不写审计", async () => {
    const h = harness({
      assignment: { status: "blocked" },
      concurrentWrite: () => {
        h.row!.status = "completed";
        h.row!.resultJson = { delivered: true };
      },
    });

    await expect(
      h.service.cancelAssignment({
        assignmentId: h.row!.id,
        reason: "超时取消",
      }),
    ).rejects.toMatchObject({
      errorCode: "SOP_ASSIGNMENT_TERMINAL",
      params: { status: "completed" },
    });
    expect(h.row!.status).toBe("completed");
    expect(h.row!.resultJson).toEqual({ delivered: true });
    expect(h.audit!.log).not.toHaveBeenCalled();
  });

  it("并发双取消：读取为 blocked 后另一管理员抢先 cancelled → 第二人抛 400 且不写第二条审计", async () => {
    const h = harness({
      assignment: { status: "blocked" },
      concurrentWrite: () => {
        h.row!.status = "cancelled";
      },
    });

    await expect(
      h.service.cancelAssignment({
        assignmentId: h.row!.id,
        reason: "第二人的理由",
      }),
    ).rejects.toMatchObject({
      errorCode: "SOP_ASSIGNMENT_TERMINAL",
      params: { status: "cancelled" },
    });
    expect(h.audit!.log).not.toHaveBeenCalled();
  });

  it("审计载荷：复用 sop.assignment.cancel + sop_assignment + detail.sopId，非空 reason 脱敏落库", async () => {
    const h = harness({ assignment: { status: "blocked" } });
    const rawReason =
      "  人工放弃：附测试凭据 sk-live-secret1234567890abcdef 与 https://ops:s3cr3tPass@db.internal/app  ";

    await h.service.cancelAssignment({
      assignmentId: h.row!.id,
      reason: rawReason,
      actor: "user:42",
      audit: { userId: 42, username: "ops", ip: "192.168.1.9" },
    });

    expect(h.audit!.log).toHaveBeenCalledTimes(1);
    const payload = h.audit!.log.mock.calls[0][0] as Any;
    expect(payload).toMatchObject({
      userId: 42,
      username: "ops",
      ip: "192.168.1.9",
      action: "sop.assignment.cancel",
      resource: "sop_assignment",
      resourceId: h.row!.id,
      detail: {
        sopId: h.row!.sopId,
        sopVersion: "1.2.0",
        executorId: h.row!.targetExecutorId,
        from: "blocked",
        to: "cancelled",
        scope: "single",
        actor: "user:42",
        reasonLength: rawReason.trim().length,
      },
    });
    expect(typeof payload.detail.reason).toBe("string");
    expect(payload.detail.reason).not.toContain(
      "sk-live-secret1234567890abcdef",
    );
    expect(payload.detail.reason).not.toContain("s3cr3tPass");
  });

  it("未传或纯空白 reason → 审计 detail 不含 reason 与 reasonLength 键", async () => {
    const h = harness({ assignment: { status: "assigned" } });

    await h.service.cancelAssignment({
      assignmentId: h.row!.id,
      reason: "   \t\n  ",
      actor: "user:1",
    });

    const payload = h.audit!.log.mock.calls[0][0] as Any;
    expect(payload.detail).not.toHaveProperty("reason");
    expect(payload.detail).not.toHaveProperty("reasonLength");
  });

  it("审计落库异常时 fail-open：主流程仍返回 cancelled，并记录 logger.error", async () => {
    const h = harness({ auditThrows: true });

    const out = await h.service.cancelAssignment({ assignmentId: h.row!.id });
    expect(out.assignment.status).toBe("cancelled");
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  it("仓储依赖缺席 → 显式抛 503 DEPENDENCY_UNAVAILABLE（绝不静默伪造成功）", async () => {
    const unwired = new SopAssignmentActionsService(null, undefined);
    await expect(
      unwired.cancelAssignment({
        assignmentId: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toMatchObject({
      errorCode: "DEPENDENCY_UNAVAILABLE",
    });
  });
});

describe("CancelSopAssignmentDto & ParseUuidShapePipe · 输入边界校验", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });
  const uuidPipe = new ParseUuidShapePipe();

  function validateBody(value: object): Promise<CancelSopAssignmentDto> {
    return pipe.transform(value, {
      type: "body",
      metatype: CancelSopAssignmentDto,
    }) as Promise<CancelSopAssignmentDto>;
  }

  it("空对象 {} 与 500 字符 reason 放行", async () => {
    expect(await validateBody({})).toEqual({});
    const exact500 = "a".repeat(CANCEL_ASSIGNMENT_REASON_MAX_LENGTH);
    const dto = await validateBody({ reason: exact500 });
    expect(dto.reason).toBe(exact500);
  });

  it("reason 超过 500 字符 → 400", async () => {
    const tooLong = "a".repeat(CANCEL_ASSIGNMENT_REASON_MAX_LENGTH + 1);
    await expect(validateBody({ reason: tooLong })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("未知多余键 → 400（forbidNonWhitelisted）", async () => {
    await expect(
      validateBody({ reason: "ok", unexpectedField: true }),
    ).rejects.toThrow(BadRequestException);
  });

  it("非 UUID assignmentId → ParseUuidShapePipe 抛 400 INVALID_VALUE_FORMAT", async () => {
    await expect(
      uuidPipe.transform("not-a-uuid", {
        type: "param",
        metatype: String,
        data: "assignmentId",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      uuidPipe.transform("not-a-uuid", {
        type: "param",
        metatype: String,
        data: "assignmentId",
      }),
    ).rejects.toMatchObject({ errorCode: "INVALID_VALUE_FORMAT" });
  });
});
