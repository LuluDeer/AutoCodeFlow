import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { TaskController } from "../task.controller";
import {
  ExecutionLogsQueryDto,
  ExecutionLogsStreamQueryDto,
} from "../dto/execution-query.dto";

/**
 * 真浏览器验收缺陷：createSseClient 用 ?ticket=<jwt> 建连，而 SSE 端点沿用的
 * ExecutionLogsQueryDto 未声明 ticket；全局 ValidationPipe 的
 * whitelist + forbidNonWhitelisted 把每条建连请求判为 400。
 *
 * 这里钉住：专用 stream DTO 放行 ticket、保留白名单、ticket 不进日志查询语义。
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

describe("ExecutionLogsStreamQueryDto — SSE ticket whitelist", () => {
  const validate = (value: object) =>
    pipe.transform(value, {
      type: "query",
      metatype: ExecutionLogsStreamQueryDto,
    }) as Promise<ExecutionLogsStreamQueryDto>;

  it("accepts ticket + fromLine together (the real browser query string)", async () => {
    const result = await validate({
      ticket: "header.eyJ0eXBlIjoic3NlX3RpY2tldCJ9.signature",
      fromLine: "7",
    });
    expect(result.ticket).toBe(
      "header.eyJ0eXBlIjoic3NlX3RpY2tldCJ9.signature",
    );
    expect(result.fromLine).toBe("7");
  });

  it("keeps ticket optional so bearer-header clients are unaffected", async () => {
    const result = await validate({ fromLine: "0" });
    expect(result.ticket).toBeUndefined();
    expect(result.fromLine).toBe("0");
  });

  it("still rejects unknown fields (forbidNonWhitelisted stays on)", async () => {
    await expect(
      validate({ ticket: "jwt.ticket.value", bogus: "1" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("does not widen the REST log endpoint whitelist", async () => {
    await expect(
      pipe.transform(
        { ticket: "jwt.ticket.value", fromLine: "1" },
        { type: "query", metatype: ExecutionLogsQueryDto },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it.each([
    ["empty", ""],
    ["non-string", 12345],
    ["overlong", "a".repeat(4097)],
  ])("rejects a %s ticket", async (_label, ticket) => {
    await expect(validate({ ticket })).rejects.toThrow(BadRequestException);
  });

  it("accepts a ticket at the length boundary (4096)", async () => {
    const ticket = "a".repeat(4096);
    expect((await validate({ ticket })).ticket).toBe(ticket);
  });
});

describe("TaskController.streamLogs — ticket wiring", () => {
  const makeDeps = () => {
    const taskService = {
      getExecution: jest
        .fn()
        .mockResolvedValue({ id: "exec-1", taskId: "task-1" }),
      acquireSseSlot: jest.fn().mockReturnValue(jest.fn()),
      streamExecutionLogs: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new TaskController(
      taskService as any,
      {} as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
    const req: any = { on: jest.fn() };
    const res: any = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
    return { controller, taskService, req, res };
  };

  it("binds the dedicated stream DTO as the @Query() metatype", () => {
    const params = Reflect.getMetadata(
      "design:paramtypes",
      TaskController.prototype,
      "streamLogs",
    );
    expect(params).toContain(ExecutionLogsStreamQueryDto);
  });

  it("passes fromLine through to streamExecutionLogs but never passes ticket", async () => {
    const { controller, taskService, req, res } = makeDeps();
    await controller.streamLogs("task-1", "exec-1", req, res, {
      ticket: "jwt.ticket.value",
      fromLine: "7",
    } as ExecutionLogsStreamQueryDto);

    const call = taskService.streamExecutionLogs.mock.calls[0];
    // 第 7 个实参（index 6）是 fromLine——重连续传语义保持不变
    expect(call[6]).toBe(7);
    // ticket 只做鉴权，不进入日志查询调用的任何参数
    expect(call.slice(1)).not.toContain("jwt.ticket.value");
  });
});
