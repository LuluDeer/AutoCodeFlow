import { areDependenciesSatisfied } from "../dependency-gate.util";
import { ExecutionStatus } from "../entities/task-execution.entity";

/**
 * B-6（调度域审计）：依赖满足判定的单一事实源（dependency-gate.util）。
 *
 * 判定体自 TaskService.checkDependencies 原样平移——该判定此前只有依赖
 * 扇出（TaskService.trigger）一个消费方；scheduler 的 misfire 补偿经
 * enqueue 直接入队完全绕过它，FIRE_ONCE 任务在上游失败、缺口超阈时被
 * 补偿路径强行触发。抽取后两处共用（scheduler 侧补闸见
 * scheduler.service.spec 的 B-6 用例），本 spec 固化判定语义本身。
 */

const makeRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
});

describe("areDependenciesSatisfied (B-6 util)", () => {
  it("无依赖（null / {}）恒满足且零查询", async () => {
    const repo = makeRepo();
    await expect(areDependenciesSatisfied(repo, null)).resolves.toBe(true);
    await expect(areDependenciesSatisfied(repo, {})).resolves.toBe(true);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it("全部依赖的最新执行均为 SUCCESS 才满足", async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValue([
      { taskId: "up-1", status: ExecutionStatus.SUCCESS },
      { taskId: "up-2", status: ExecutionStatus.SUCCESS },
    ]);
    await expect(
      areDependenciesSatisfied(repo, { a: "up-1", b: "up-2" }),
    ).resolves.toBe(true);
  });

  it("上游最新执行 FAILED → 不满足（misfire 补偿闸拒收的场景）", async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValue([
      { taskId: "up-1", status: ExecutionStatus.FAILED },
    ]);
    await expect(areDependenciesSatisfied(repo, { a: "up-1" })).resolves.toBe(
      false,
    );
  });

  it("依赖从未运行过（无执行行）→ 不满足", async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValue([]);
    repo.findOne.mockResolvedValue(null);
    await expect(areDependenciesSatisfied(repo, { a: "up-1" })).resolves.toBe(
      false,
    );
  });

  it("value 才是依赖任务 id（FIX-1.1 契约）：key 不参与判定", async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValue([
      { taskId: "up-id", status: ExecutionStatus.SUCCESS },
    ]);
    await expect(
      areDependenciesSatisfied(repo, { 显示名: "up-id" }),
    ).resolves.toBe(true);
    // 查询按 value（up-id）而非 key 过滤（TypeORM In 包裹为 FindOperator）
    const findArg = repo.find.mock.calls[0][0] as {
      where: { taskId: { _value: string[] } };
    };
    expect(findArg.where.taskId._value).toEqual(["up-id"]);
  });

  it("主查询按 MAX 上限截断后，缺席依赖用定向查询兜底（截断不破坏判定）", async () => {
    const repo = makeRepo();
    // 主查询只回了 up-1 的行（up-2 被截断挤出窗口）
    repo.find.mockResolvedValue([
      { taskId: "up-1", status: ExecutionStatus.SUCCESS },
    ]);
    repo.findOne.mockResolvedValue({
      taskId: "up-2",
      status: ExecutionStatus.SUCCESS,
    });
    await expect(
      areDependenciesSatisfied(repo, { a: "up-1", b: "up-2" }),
    ).resolves.toBe(true);
    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { taskId: "up-2" } }),
    );
  });
});
