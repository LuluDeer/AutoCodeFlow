import { ServiceUnavailableException } from "@nestjs/common";
import { TaskController } from "../task.controller";
import { SKIP_TIMEOUT_KEY } from "../../../common/decorators/skip-timeout.decorator";

/**
 * TASK-008: SSE 日志流并发上限的控制器行为。
 * - 超限时在任何 SSE 响应头写出之前抛 ServiceUnavailableException（真正的 503）
 * - 连接关闭/结束时释放槽位（release 幂等，双保险不重复释放）
 */
describe("TaskController.streamLogs — SSE concurrency (TASK-008)", () => {
  const makeDeps = () => {
    const taskService = {
      getExecution: jest
        .fn()
        .mockResolvedValue({ id: "exec-1", taskId: "task-1" }),
      acquireSseSlot: jest.fn().mockReturnValue(jest.fn()),
      streamExecutionLogs: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = new TaskController(taskService as any, audit as any);
    const req: any = { on: jest.fn() };
    const res: any = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
    return { controller, taskService, req, res };
  };

  it("acquires the slot before writing any SSE header", async () => {
    const { controller, taskService, req, res } = makeDeps();
    const order: string[] = [];
    taskService.acquireSseSlot.mockImplementation(() => {
      order.push("acquire");
      return jest.fn();
    });
    res.setHeader.mockImplementation(() => order.push("header"));

    await controller.streamLogs("task-1", "exec-1", req, res);

    expect(taskService.getExecution).toHaveBeenCalledWith("exec-1", "task-1");
    expect(order[0]).toBe("acquire");
    expect(order).toContain("header");
  });

  it("rejects with ServiceUnavailableException before headers are flushed when over the limit", async () => {
    const { controller, taskService, req, res } = makeDeps();
    taskService.acquireSseSlot.mockImplementation(() => {
      throw new ServiceUnavailableException("Too many concurrent log streams");
    });

    await expect(
      controller.streamLogs("task-1", "exec-1", req, res),
    ).rejects.toThrow(ServiceUnavailableException);
    // 响应头未写出 → 全局异常过滤器可以正常返回 503 JSON
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });

  it("releases the slot exactly once when the stream completes", async () => {
    const { controller, taskService, req, res } = makeDeps();
    const release = jest.fn();
    taskService.acquireSseSlot.mockReturnValue(release);

    await controller.streamLogs("task-1", "exec-1", req, res);

    expect(taskService.streamExecutionLogs).toHaveBeenCalledWith(
      "exec-1",
      expect.any(Function),
      expect.any(Function),
      expect.anything(),
      release,
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the slot exactly once when the stream errors", async () => {
    const { controller, taskService, req, res } = makeDeps();
    const release = jest.fn();
    taskService.acquireSseSlot.mockReturnValue(release);
    taskService.streamExecutionLogs.mockRejectedValue(new Error("db down"));

    await controller.streamLogs("task-1", "exec-1", req, res);

    expect(res.write).toHaveBeenCalledWith(
      expect.stringContaining("event: error"),
    );
    expect(res.end).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

/**
 * N8: streamLogs 必须豁免全局 TimeoutInterceptor——本 spec 的 req/res 是
 * mock、不经过全局拦截器链，因此这里固化元数据本身（拦截器侧的直通行为
 * 见 common/interceptors/timeout.interceptor.spec.ts）。
 */
describe("TaskController.streamLogs — timeout exemption (N8)", () => {
  it("carries SKIP_TIMEOUT metadata so the global 30s timeout cannot cut the SSE stream", () => {
    expect(
      Reflect.getMetadata(
        SKIP_TIMEOUT_KEY,
        TaskController.prototype.streamLogs,
      ),
    ).toBe(true);
  });
});
