import { TASK_PROJECTION_WHITELIST } from "../dto/list-tasks-query.dto";

/**
 * PERF-02（本轮体验审查）：`dependencies` 必须在投影白名单内。
 *
 * 缺陷：F-10 引入 `?fields=` 轻量投影时，把 `dependencies` 归类为「重量列」
 * 排除在白名单外（`task.service.ts:1013` 对白名单外字段直接 400）。但它是
 * TaskDependencyGraph 的**唯一**边集来源——`admin-web/src/components/
 * dag-layout.ts:58` 直接读 `t.dependencies`，undefined 即 `continue`。而
 * `useAllTasksForDag` 走的正是 `listAll` 的默认投影 `?fields=id,name`。
 *
 * 后果（生产 100% 复现，与数据规模无关）：任何配了上下游依赖的任务，打开
 * 「依赖」页签都显示空图 + 「该任务没有依赖其他任务，也没有任务依赖它」；
 * 「触发整条链」按钮退化为只触发单任务。
 *
 * 为什么既有测试全绿：`dag-layout.test.ts` 与 `task-dag-chain-trigger.test.tsx`
 * 都直接构造带 `dependencies` 的对象并 mock 掉 `tasksApi.listAll`，**绕过
 * API 层**；而 admin-api 侧此前**没有任何**针对该白名单的测试。
 *
 * 反证：从白名单里删掉 "dependencies"，第一条用例立刻变红。
 */
describe("TASK_PROJECTION_WHITELIST — PERF-02 DAG 边集来源", () => {
  it("包含 dependencies（DAG 的唯一边集来源，缺失则图恒空）", () => {
    expect(TASK_PROJECTION_WHITELIST).toContain("dependencies");
  });

  it("仍然包含 DAG 布局需要的 id 与 name", () => {
    expect(TASK_PROJECTION_WHITELIST).toContain("id");
    expect(TASK_PROJECTION_WHITELIST).toContain("name");
  });

  it("SEC-02：secrets 永不进入投影白名单", () => {
    // 这是安全边界，不是性能取舍——放宽白名单时最容易被顺手加进来的就是它。
    expect(TASK_PROJECTION_WHITELIST).not.toContain("secrets");
  });

  it("F-10 收益保留：重量文本/jsonb 列仍在白名单外", () => {
    // 这些是 F-10 真正要省掉的列；若被加进白名单，轻量投影就失去意义。
    for (const heavy of [
      "params",
      "glueSource",
      "requirements",
      "runbook",
      "maintenanceWindows",
    ]) {
      expect(TASK_PROJECTION_WHITELIST).not.toContain(heavy);
    }
  });

  it("白名单无重复项（重复会让 select 构造出冗余键）", () => {
    const unique = new Set(TASK_PROJECTION_WHITELIST);
    expect(unique.size).toBe(TASK_PROJECTION_WHITELIST.length);
  });
});
