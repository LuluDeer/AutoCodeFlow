/**
 * CORE-01 回归守卫（e2e 23-25/29 六例红根因）：前端以数字（1-4）提交
 * priority，而 tasks.priority 的 PG enum 只接受 label 字符串——数字直写
 * PG 报 `invalid input value for enum` 500。列级 transformer 在实体写路径
 * 统一转小写 label；本 spec 钉住 transformer 的接线与映射，防止未来重构
 * （或"顺手清理 decorator"）使写路径退回数字直写。
 */
import { getMetadataArgsStorage } from "typeorm";
import { Task, TaskPriority } from "../entities/task.entity";

function getPriorityTransformer(): {
  to: (v?: unknown) => unknown;
  from: (v?: unknown) => unknown;
} {
  const cols = getMetadataArgsStorage().columns.filter(
    (c) => c.target === Task && c.propertyName === "priority",
  );
  expect(cols).toHaveLength(1);
  const transformer = cols[0].options?.transformer as {
    to: (v?: unknown) => unknown;
    from: (v?: unknown) => unknown;
  };
  expect(transformer).toBeDefined();
  expect(typeof transformer.to).toBe("function");
  return transformer;
}

describe("tasks.priority 列 transformer（CORE-01 数字→PG label 写路径）", () => {
  it("数字枚举值写入时映射为小写 label（1→low … 4→critical）", () => {
    const { to } = getPriorityTransformer();
    expect(to(TaskPriority.LOW)).toBe("low");
    expect(to(TaskPriority.NORMAL)).toBe("normal");
    expect(to(TaskPriority.HIGH)).toBe("high");
    expect(to(TaskPriority.CRITICAL)).toBe("critical");
  });

  it("前端提交形态的普通数字与表单默认值 2 均映射为 'normal'", () => {
    const { to } = getPriorityTransformer();
    expect(to(2)).toBe("normal");
    expect(to(3)).toBe("high");
  });

  it("label 字符串透传（读改写场景：读回 'normal' 再 save 不二次转换）", () => {
    const { to } = getPriorityTransformer();
    expect(to("normal")).toBe("normal");
    expect(to("critical")).toBe("critical");
  });

  it("undefined/null 透传（依赖列 default 'normal'）", () => {
    const { to } = getPriorityTransformer();
    expect(to(undefined)).toBeUndefined();
    expect(to(null)).toBeNull();
  });

  it("from 为透传（DB 读回恒为 label 字符串，不做数字还原）", () => {
    const { from } = getPriorityTransformer();
    expect(from("normal")).toBe("normal");
  });

  it("接线断言：transformer 挂在 Task.priority 列上且列类型为 pg enum", () => {
    const cols = getMetadataArgsStorage().columns.filter(
      (c) => c.target === Task && c.propertyName === "priority",
    );
    expect(cols[0].options?.type).toBe("enum");
    expect(cols[0].options?.enum).toBe(TaskPriority);
  });
});
