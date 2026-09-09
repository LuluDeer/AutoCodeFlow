import { ValidationPipe, BadRequestException } from "@nestjs/common";
import {
  AllExecutionsQueryDto,
  ExecutionLogsQueryDto,
  TaskExecutionsQueryDto,
} from "../dto/execution-query.dto";
import { TaskController } from "../task.controller";

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

  it("rejects unknown query params such as ?bogus=1", async () => {
    await expect(validate({ page: "1", bogus: "1" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects the legacy CLI `limit` param (removed on the CLI side)", async () => {
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
