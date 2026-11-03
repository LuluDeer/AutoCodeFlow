import {
  buildAppNameBoundTaskCountWhere,
  buildPinnedTaskCountWhere,
  isBoundToExecutorAppName,
  isPinnedToExecutor,
} from "../executor-removal-impact.util";
import { TaskStatus } from "../../task/entities/task.entity";

/**
 * B0 拆分的独立单测（不走 DI 装配，直接调用纯函数）。
 *
 * ## 这些用例钉住的是「口径」，不是「实现」
 *
 * 执行器删除影响面被**两处**消费（删除前预览 + 自动清理的跳过判定）。两处
 * 若口径不同，预览就会失去意义（预览说"无影响"、清理却删掉 ⇒ 用户的确认
 * 框在骗人）。因此「排除软删除行」「appName 精确匹配」这两条规则必须
 * **只有一份实现**——本文件就是那份实现的守卫。
 */

/** 从 where 构造里取回「非 DELETED」这个 FindOperator 的实际值。 */
function deletedStatusValue(status: unknown): unknown {
  // TypeORM 的 `Not(x)` 产出 FindOperator，其 `value` 字段持有被排除的值。
  return (status as { value?: unknown } | undefined)?.value;
}

describe("buildPinnedTaskCountWhere — 钉定维度口径", () => {
  it("按 executorId 精确钉定", () => {
    const where = buildPinnedTaskCountWhere("exec-42");
    expect(where.executorId).toBe("exec-42");
  });

  it("排除软删除行（软删除的任务不会再被派发，不算破坏面）", () => {
    const where = buildPinnedTaskCountWhere("exec-42");
    expect(deletedStatusValue(where.status)).toBe(TaskStatus.DELETED);
  });
});

describe("buildAppNameBoundTaskCountWhere — 名字绑定维度口径", () => {
  it("按 executorAppName 精确匹配", () => {
    const where = buildAppNameBoundTaskCountWhere("web");
    expect(where.executorAppName).toBe("web");
  });

  it("排除软删除行（与钉定维度同口径）", () => {
    const where = buildAppNameBoundTaskCountWhere("web");
    expect(deletedStatusValue(where.status)).toBe(TaskStatus.DELETED);
  });
});

describe("isBoundToExecutorAppName — appName 等值匹配", () => {
  it("完全相等时命中", () => {
    expect(isBoundToExecutorAppName("web", "web")).toBe(true);
  });

  it("**不做前缀/包含匹配**（`web-1` 不得被算成 `web-10` 的绑定面）", () => {
    expect(isBoundToExecutorAppName("web-1", "web-10")).toBe(false);
    expect(isBoundToExecutorAppName("web-10", "web-1")).toBe(false);
    expect(isBoundToExecutorAppName("my-web", "web")).toBe(false);
  });

  it("null/undefined 视为未绑定", () => {
    expect(isBoundToExecutorAppName(null, "web")).toBe(false);
    expect(isBoundToExecutorAppName(undefined, "web")).toBe(false);
  });
});

describe("isPinnedToExecutor — 钉定判据", () => {
  it("相等时命中", () => {
    expect(isPinnedToExecutor("exec-1", "exec-1")).toBe(true);
  });

  it("不等或缺省时未命中", () => {
    expect(isPinnedToExecutor("exec-2", "exec-1")).toBe(false);
    expect(isPinnedToExecutor(null, "exec-1")).toBe(false);
    expect(isPinnedToExecutor(undefined, "exec-1")).toBe(false);
  });
});
