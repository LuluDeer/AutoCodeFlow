import { AgentSessionService } from "../agent-session.service";
import { AgentRuntimeService } from "../agent-runtime.service";

/** 模拟迟到的第二次入队：首份 job 已终结，BullMQ 允许新加，但数据库已到下一轮。 */
describe("人工/审批恢复的执行凭据", () => {
  it("第 0 步也是有效的期望步数；SQL 在认领 running 的同一条 UPDATE 检查进度", async () => {
    const query = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn(async () => ({ affected: 0 })),
    };
    const repo = { createQueryBuilder: () => query, findOne: async () => null };
    const sessions = new AgentSessionService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      sessions.markRunning("s1", { expectTotalSteps: 0 }),
    ).resolves.toBe(false);
    expect(query.andWhere).toHaveBeenCalledWith('"totalSteps" = :steps', {
      steps: 0,
    });
    expect(query.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running" }),
    );
  });

  it("旧轮次 CAS 失败时保持下一轮 waiting_input，不重放、不推理", async () => {
    const sessions = {
      requireById: async () => ({ status: "waiting_input", totalSteps: 2 }),
      markRunning: jest.fn(async () => false),
      listToolCalls: jest.fn(),
    };
    const ai = { chatMultimodal: jest.fn() };
    const runtime = new AgentRuntimeService(
      sessions as never,
      {} as never,
      ai as never,
    );
    await expect(runtime.run("s1", { expectTotalSteps: 1 })).resolves.toEqual({
      status: "waiting_input",
      steps: 2,
    });
    expect(sessions.markRunning).toHaveBeenCalledWith("s1", {
      expectTotalSteps: 1,
    });
    expect(sessions.listToolCalls).not.toHaveBeenCalled();
    expect(ai.chatMultimodal).not.toHaveBeenCalled();
  });
});
