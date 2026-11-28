/**
 * DAG root-only 触发契约：只触发入参子图内零前驱的根节点，下游节点跳过
 * （由根执行终态经依赖扇出自动触发）；每次运行生成 dagRunId 并注入每个根
 * 执行的 params._dagRunId。
 */
import { TaskDagChainController } from "../task-dag-chain.controller";

type DepMap = Record<string, string>;
function makeTaskService(
  tasks: Record<
    string,
    Partial<Record<string, unknown>> & { dependencies?: DepMap }
  >,
) {
  const trigger = jest.fn(
    async (taskId: string, dto: { params?: Record<string, unknown> }) => ({
      id: `exec-${taskId}`,
      status: "pending",
      params: dto.params,
    }),
  );
  const findOne = jest.fn(async (id: string) => {
    const t = tasks[id];
    if (!t) throw new Error(`task ${id} not found`);
    return { id, dependencies: t.dependencies ?? null };
  });
  return { trigger, findOne, service: { trigger, findOne } as never };
}

describe("TaskDagChainController.triggerRoots", () => {
  it("只触发子图内零前驱的根节点，非根节点进入 skippedDependentTaskIds", async () => {
    const { service, trigger, findOne } = makeTaskService({
      A: {},
      B: { dependencies: { up: "A" } },
      C: { dependencies: { up: "B" } },
      D: {},
    });
    const controller = new TaskDagChainController(service);

    const result = await controller.triggerRoots(
      { taskIds: ["A", "B", "C", "D"], params: { foo: "bar" } },
      undefined,
    );

    expect(findOne).toHaveBeenCalledTimes(4);
    expect(result.rootTaskIds).toEqual(["A", "D"]);
    expect(result.skippedDependentTaskIds).toEqual(["B", "C"]);
    expect(result.executions.map((e) => e.taskId)).toEqual(["A", "D"]);
    expect(result.executions[0].executionId).toBe("exec-A");
    expect(result.executions[0].status).toBe("pending");
    // dagRunId 一致且注入每个根执行的 params._dagRunId。
    expect(result.dagRunId).toMatch(/^[0-9a-f-]{36}$/);
    for (const call of trigger.mock.calls) {
      expect(call[1].params?._dagRunId).toBe(result.dagRunId);
      expect(call[1].params?.foo).toBe("bar");
    }
  });

  it("子图外前驱不算子图内前驱：孤立节点仍作为根触发", async () => {
    const { service, trigger } = makeTaskService({
      A: { dependencies: { external: "outside-subgraph" } },
      B: { dependencies: { up: "A" } },
    });
    const controller = new TaskDagChainController(service);

    const result = await controller.triggerRoots(
      { taskIds: ["A", "B"] },
      undefined,
    );

    expect(result.rootTaskIds).toEqual(["A"]);
    expect(result.skippedDependentTaskIds).toEqual(["B"]);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("重复 taskIds 去重，根节点只触发一次", async () => {
    const { service, trigger } = makeTaskService({ A: {} });
    const controller = new TaskDagChainController(service);
    const result = await controller.triggerRoots(
      { taskIds: ["A", "A"] },
      undefined,
    );
    expect(result.rootTaskIds).toEqual(["A"]);
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});
