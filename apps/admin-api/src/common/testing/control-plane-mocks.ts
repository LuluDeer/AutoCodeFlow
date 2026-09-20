import type { ExecutorService } from "../../modules/executor/executor.service";

/**
 * ARCH-33（ADR-016）：控制面 pull 通道的测试替身。
 *
 * 引入命令通道后，ExecutorService 多了 `resolveExecutorTransport` /
 * `deliverControlCommand` / `enqueueExecutorCommand` 三个方法。既有单测用
 * 内联对象字面量装配 `{ provide: ExecutorService, useValue: {...} }`，缺这些
 * 方法会在调用点抛 TypeError。
 *
 * 默认返回 **push**——这正是绝大多数既有用例的意图（它们验证的是 push 路径
 * 的载荷/鉴权/SSRF 语义，不该因为 pull 通道的引入而改变）。需要验证 pull
 * 行为的用例显式覆盖返回值。
 *
 * 用法：
 *   { provide: ExecutorService, useValue: { ...pushExecutorMock(), getExecutorUrl } }
 */
export function controlPlaneMocks(overrides?: {
  mode?: "push" | "pull";
  executor?: unknown;
}) {
  const mode = overrides?.mode ?? "push";
  const executor = overrides?.executor ?? null;
  return {
    resolveExecutorTransport: jest.fn().mockResolvedValue({ mode, executor }),
    deliverControlCommand: jest
      .fn()
      .mockResolvedValue(
        mode === "pull"
          ? { delivered: "pull", commandId: "cmd-test-1" }
          : { delivered: "push" },
      ),
    enqueueExecutorCommand: jest.fn().mockResolvedValue("cmd-test-1"),
  };
}

/** 便于在 jest.Mocked<Pick<ExecutorService, ...>> 类型里带上新方法。 */
export type ControlPlaneMockKeys =
  | "resolveExecutorTransport"
  | "deliverControlCommand"
  | "enqueueExecutorCommand";

/** 该 Pick 列表是各 spec 装配 mock 时的推荐键集（含 ARCH-33 新增三项）。 */
export type ExecutorServiceMockKeys =
  | ControlPlaneMockKeys
  | "findOne"
  | "findByAddress"
  | "getExecutorUrl"
  | "getSharedToken"
  | "selectLeastLoaded";

export type ExecutorServiceMock = jest.Mocked<
  Pick<ExecutorService, ExecutorServiceMockKeys>
>;
