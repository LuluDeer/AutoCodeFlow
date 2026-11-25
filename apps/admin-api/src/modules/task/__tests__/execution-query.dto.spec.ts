import { ValidationPipe, BadRequestException } from "@nestjs/common";
import {
  AllExecutionsQueryDto,
  ExecutionLogsQueryDto,
  TaskExecutionsQueryDto,
} from "../dto/execution-query.dto";
import { ListTasksQueryDto } from "../dto/list-tasks-query.dto";
import { TaskController } from "../task.controller";
// NETOPT-3④: 分页基类 page 上限的校验面
import { PageQueryDto } from "../../../common/dto/pagination.dto";

/**
 * N7 regression: both execution-query endpoints used TS intersection types
 * as @Query() metatypes, which emitDecoratorMetadata compiles to `Object` —
 * the global ValidationPipe whitelist was therefore inert and any undeclared
 * query key reached the service. With real DTO classes the
 * forbidNonWhitelisted behaviour is restored.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

describe("ListTasksQueryDto (GET /tasks)", () => {
  const validate = (value: object) =>
    pipe.transform(value, {
      type: "query",
      metatype: ListTasksQueryDto,
    }) as Promise<ListTasksQueryDto>;

  it("accepts the backend maximum pageSize=100", async () => {
    const result = await validate({ page: "1", pageSize: "100" });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(100);
  });

  it("rejects pageSize above the backend maximum", async () => {
    await expect(validate({ page: "1", pageSize: "101" })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe("TaskExecutionsQueryDto (GET /tasks/:id/executions)", () => {
  const validate = (value: object) =>
    pipe.transform(value, {
      type: "query",
      metatype: TaskExecutionsQueryDto,
    }) as Promise<TaskExecutionsQueryDto>;

  it("accepts pagination plus a status filter", async () => {
    const result = await validate({
      page: "1",
      pageSize: "10",
      status: "failed",
    });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
    expect(result.status).toBe("failed");
  });

  // §2.1 游标分页：cursor 必须**通过白名单**（否则全局
  // forbidNonWhitelisted 会把它打成 400，加性参数根本用不了）。
  it("§2.1: accepts the additive `cursor` query param (whitelist)", async () => {
    const result = await validate({ page: "1", cursor: "abc_-123" });
    expect(result.cursor).toBe("abc_-123");
  });

  it("§2.1: cursor is optional (omitting it keeps the OFFSET path reachable)", async () => {
    const result = await validate({ page: "1" });
    expect(result.cursor).toBeUndefined();
  });

  it("§2.1: 格式校验**不**在 DTO 层做（合法性统一由 decodeExecutionCursor 判 400）", async () => {
    // 这不是"宽松"，是刻意的分层：DTO 报的是 VALIDATION_FAILED + 字段名数组，
    // 而游标坏掉需要一条可操作的指引（"请从第一页重新开始"），且语义上是领域
    // 状态不合法而非参数格式错误。纯函数是唯一判定点，见它的单测。
    const result = await validate({ cursor: "!!!not-base64!!!" });
    expect(result.cursor).toBe("!!!not-base64!!!");
  });

  it("rejects unknown query params such as ?bogus=1", async () => {
    await expect(validate({ page: "1", bogus: "1" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects the legacy CLI `limit` param (removed on the CLI side)", async () => {
    // ⚠️ 口径说明（DOC-GHOST-LIMIT）：本用例钉的是**全局管道
    // `forbidNonWhitelisted` 的行为**——`TaskExecutionsQueryDto` 不声明 `limit`，
    // 所以它必然 400；这**不是**"limit 可用"的证据，也不是说它应该被支持。
    //
    // 此前 task.controller.ts 的 `GET :id/executions` 上挂着一行
    // `@ApiQuery({ name: "limit" })`（"每页条数"），于是 OpenAPI 公示了一个
    // **传了就必然 400** 的幽灵参数（文档承诺可用、实现必然失败）。该行已删除；
    // "每页条数"的语义由 DTO 基类 `PaginationDto#pageSize` 承担。
    // 删 `@ApiQuery` 不改变白名单行为，故本用例照旧通过。
    await expect(validate({ limit: "10" })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe("AllExecutionsQueryDto (GET /tasks/executions/all)", () => {
  const validate = (value: object) =>
    pipe.transform(value, {
      type: "query",
      metatype: AllExecutionsQueryDto,
    }) as Promise<AllExecutionsQueryDto>;

  it("accepts the full filter set consumed by getAllExecutions", async () => {
    const result = await validate({
      page: "1",
      pageSize: "20",
      status: "success",
      taskId: "t1",
      taskName: "nightly",
      executorAddress: "10.0.0.5",
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-01-31T23:59:59.000Z",
    });
    expect(result.taskId).toBe("t1");
    expect(result.taskName).toBe("nightly");
    expect(result.executorAddress).toBe("10.0.0.5");
    expect(result.startTime).toBe("2026-01-01T00:00:00.000Z");
    expect(result.endTime).toBe("2026-01-31T23:59:59.000Z");
  });

  it("P2-2: accepts runtime (task enum) and triggerType (execution-row free varchar)", async () => {
    const result = await validate({
      runtime: "python",
      triggerType: "webhook",
    });
    expect(result.runtime).toBe("python");
    expect(result.triggerType).toBe("webhook");
  });

  it("P2-2: runtime outside TaskRuntime enum is rejected (400)", async () => {
    await expect(validate({ runtime: "ruby" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("P2-2: triggerType is free varchar — an unknown token passes the DTO (service matches 0 rows)", async () => {
    const result = await validate({ triggerType: "agent" });
    expect(result.triggerType).toBe("agent");
  });

  it("P2-2: triggerType over 64 chars is rejected", async () => {
    await expect(validate({ triggerType: "x".repeat(65) })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects unknown query params", async () => {
    await expect(validate({ status: "failed", bogus: "1" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects a malformed startTime (not ISO 8601)", async () => {
    await expect(validate({ startTime: "not-a-date" })).rejects.toThrow(
      BadRequestException,
    );
  });

  // §2.1 游标分页推广：cursor 必须**通过白名单**（否则全局
  // forbidNonWhitelisted 会把它打成 400，加性参数根本用不了）。
  it("§2.1: accepts the additive `cursor` query param (whitelist)", async () => {
    const result = await validate({ page: "1", cursor: "abc_-123" });
    expect(result.cursor).toBe("abc_-123");
  });

  it("§2.1: cursor is optional (omitting it keeps the OFFSET path reachable)", async () => {
    const result = await validate({ page: "1" });
    expect(result.cursor).toBeUndefined();
  });

  it("§2.1: cursor combines with the full filter set (same DTO, same whitelist)", async () => {
    // 本端点没有 sortBy/lastStatus 那类与游标冲突的参数：六个过滤器
    // 全部与游标条件是 AND 关系，故 DTO 层不需要任何互斥判定。
    const result = await validate({
      status: "failed",
      taskId: "t1",
      taskName: "nightly",
      executorAddress: "10.0.0.5",
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-01-31T23:59:59.000Z",
      cursor: "abc_-123",
    });
    expect(result.cursor).toBe("abc_-123");
    expect(result.taskId).toBe("t1");
  });

  it("§2.1: 格式校验**不**在 DTO 层做（合法性统一由 decodeExecutionCursor 判 400）", async () => {
    // 与 TaskExecutionsQueryDto 同款分层：游标坏掉要一条可操作的指引
    // （"请从第一页重新开始"），而不是 "cursor must be …"。
    const result = await validate({ cursor: "!!!not-base64!!!" });
    expect(result.cursor).toBe("!!!not-base64!!!");
  });
});

// NETOPT-3④: page 深分页防御——page 只进 OFFSET，无上限的 `?page=99999999`
// 会生成深 OFFSET + getManyAndCount 全量 COUNT，可钉满连接池。UI 翻页远
// 用不到 1 万页（pageSize≤100 → 已覆盖 100 万行），防御性封顶。
describe("PageQueryDto (NETOPT-3④: page upper bound)", () => {
  const validate = (value: object) =>
    pipe.transform(value, {
      type: "query",
      metatype: PageQueryDto,
    }) as Promise<PageQueryDto>;

  it("accepts page at the upper bound (10000)", async () => {
    const result = await validate({ page: "10000", pageSize: "20" });
    expect(result.page).toBe(10000);
  });

  it("rejects page above the upper bound (400, deep OFFSET defense)", async () => {
    await expect(validate({ page: "99999999" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("keeps the existing pageSize upper bound (100)", async () => {
    await expect(validate({ page: "1", pageSize: "101" })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe("ExecutionLogsQueryDto (OBS-03: GET /tasks/:id/executions/:execId/logs)", () => {
  const validate = (value: object) =>
    pipe.transform(value, {
      type: "query",
      metatype: ExecutionLogsQueryDto,
    }) as Promise<ExecutionLogsQueryDto>;

  it("accepts fromLine/limit passthrough plus a valid level", async () => {
    const result = await validate({
      fromLine: "10",
      limit: "100",
      level: "ERROR",
    });
    expect(result.fromLine).toBe("10");
    expect(result.limit).toBe("100");
    expect(result.level).toBe("ERROR");
  });

  it("accepts bare fromLine/limit without level (backward compat)", async () => {
    const result = await validate({ fromLine: "0", limit: "500" });
    expect(result.level).toBeUndefined();
  });

  it("rejects a negative fromLine with 400 VALIDATION_FAILED (no OFFSET -1)", async () => {
    await expect(validate({ fromLine: "-1" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects fractional and non-numeric fromLine (digits-only)", async () => {
    await expect(validate({ fromLine: "1.5" })).rejects.toThrow(
      BadRequestException,
    );
    await expect(validate({ fromLine: "abc" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("accepts fromLine=0 and an oversized all-digit string at the DTO layer", async () => {
    expect((await validate({ fromLine: "0" })).fromLine).toBe("0");
    const big = await validate({ fromLine: "999999999999999999999" });
    expect(big.fromLine).toBe("999999999999999999999");
  });

  it("rejects a negative limit with 400 VALIDATION_FAILED (no limit=-1)", async () => {
    await expect(validate({ limit: "-1" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects non-numeric limit (digits-only)", async () => {
    await expect(validate({ limit: "abc" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("accepts limit=50 (digits-only)", async () => {
    expect((await validate({ limit: "50" })).limit).toBe("50");
  });

  it("level is optional", async () => {
    const result = await validate({});
    expect(result.level).toBeUndefined();
  });

  it("rejects a level outside the enum value domain", async () => {
    await expect(validate({ level: "FATAL" })).rejects.toThrow(
      BadRequestException,
    );
    await expect(validate({ level: "VERBOSE" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects unknown query params (forbidNonWhitelisted)", async () => {
    await expect(validate({ level: "ERROR", bogus: "1" })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe("TaskController query metatypes (N7 root cause)", () => {
  it("executions/allExecutions emit real DTO classes, not Object", () => {
    const executions = Reflect.getMetadata(
      "design:paramtypes",
      TaskController.prototype,
      "executions",
    );
    expect(executions[1]).toBe(TaskExecutionsQueryDto);

    const allExecutions = Reflect.getMetadata(
      "design:paramtypes",
      TaskController.prototype,
      "allExecutions",
    );
    expect(allExecutions[0]).toBe(AllExecutionsQueryDto);
  });

  it("OBS-03: both log endpoints bind ExecutionLogsQueryDto as @Query() metatype", () => {
    const byExecId = Reflect.getMetadata(
      "design:paramtypes",
      TaskController.prototype,
      "executionLogsByExecId",
    );
    expect(byExecId).toContain(ExecutionLogsQueryDto);

    const scoped = Reflect.getMetadata(
      "design:paramtypes",
      TaskController.prototype,
      "executionLogs",
    );
    expect(scoped).toContain(ExecutionLogsQueryDto);
  });
});

/**
 * 纵深防御：HTTP 层由 @Matches 拦负数（400 VALIDATION_FAILED），但 controller
 * 的 Math.max(0, …) 必须在 DTO 校验被绕过的内部直调路径上仍把 fromLine 钳到
 * 非负——否则 execution-log-read.collaborator 的 skip(负数) 会生成 PG OFFSET -1（500）。
 */
describe("ExecutionLogsQueryDto — controller fromLine clamp (纵深防御)", () => {
  const makeController = () => {
    const taskService = {
      getExecution: jest.fn().mockResolvedValue({ id: "exec-1" }),
      getExecutionLogs: jest
        .fn()
        .mockResolvedValue({ lines: [], totalLines: 0 }),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = new TaskController(
      taskService as any,
      {} as any,
      audit as any,
    );
    return { controller, taskService };
  };

  it("clamps a negative fromLine to 0 even when DTO validation is bypassed", async () => {
    const { controller, taskService } = makeController();

    await controller.executionLogs("task-1", "exec-1", {
      fromLine: "-1",
    } as any);

    expect(taskService.getExecutionLogs).toHaveBeenCalledWith(
      "exec-1",
      0,
      500,
      undefined,
    );
  });

  it("keeps fromLine=0 and parses an oversized numeric string without throwing", async () => {
    const { controller, taskService } = makeController();

    await controller.executionLogs("task-1", "exec-1", {
      fromLine: "0",
    } as any);
    expect(taskService.getExecutionLogs).toHaveBeenLastCalledWith(
      "exec-1",
      0,
      500,
      undefined,
    );

    await controller.executionLogsByExecId("exec-1", {
      fromLine: "999999999999999999999",
    } as any);
    const huge = taskService.getExecutionLogs.mock.calls[1][1];
    expect(typeof huge).toBe("number");
    // 超大 OFFSET 必须钳到 PG int64 安全上界：1e21 虽是 finite number，
    // 但直接下发会让 PG OFFSET 触发 bigint 越界 500。
    expect(huge).toBe(Number.MAX_SAFE_INTEGER);
  });
});
