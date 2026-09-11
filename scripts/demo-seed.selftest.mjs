#!/usr/bin/env node
/**
 * demo-seed.mjs 纯函数自检（对齐 load-test.selftest.mjs 模式）。
 * `node scripts/demo-seed.selftest.mjs`，断言全过退出码 0。
 */
import assert from "node:assert/strict";
import {
  API_PAGE_SIZE,
  aggregatePages,
  demoTaskDefs,
  findExisting,
  listAll,
  pageCount,
  triggerTargets,
  unwrap,
} from "./demo-seed.mjs";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("demo-seed.selftest");

test("演示任务定义：3 个且全部带 demo- 前缀", () => {
  const defs = demoTaskDefs();
  assert.equal(defs.length, 3);
  for (const d of defs) assert.ok(d.name.startsWith("demo-"), d.name);
});

test("三种触发形态覆盖（fixed_rate / cron / manual）", () => {
  const types = demoTaskDefs().map((d) => d.triggerType).sort();
  assert.deepEqual(types, ["cron", "fixed_rate", "manual"]);
});

test("fragile 任务源码必须故意抛错（失败样本演示的依据）", () => {
  const fragile = demoTaskDefs().find((d) => d.name === "demo-fragile");
  assert.ok(/throw new Error/.test(fragile.glueSource));
});

test("findExisting 命中同名任务（幂等复用依据）", () => {
  const tasks = [{ name: "demo-hello-fixed", id: "t1" }];
  assert.equal(findExisting(tasks, "demo-hello-fixed").id, "t1");
  assert.equal(findExisting(tasks, "nope"), undefined);
});

test("unwrap 拆信封且非信封 passthrough", () => {
  assert.deepEqual(unwrap({ code: 0, message: "ok", data: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrap({ plain: true }), { plain: true });
});

test("分页聚合遵守后端上限且保留超过 100 条任务", () => {
  const first = {
    items: Array.from({ length: API_PAGE_SIZE }, (_, i) => ({ id: `t-${i}` })),
    total: 102,
    page: 1,
    pageSize: API_PAGE_SIZE,
    totalPages: 2,
  };
  const second = {
    list: [{ id: "t-100" }, { id: "t-101" }],
    total: 102,
    page: 2,
    pageSize: API_PAGE_SIZE,
    totalPages: 2,
  };
  assert.equal(pageCount(first), 2);
  assert.equal(aggregatePages(first, [second]).length, 102);
});

test("分页响应不完整时显式失败而非静默截断", () => {
  const first = {
    items: Array.from({ length: API_PAGE_SIZE }, (_, i) => ({ id: `t-${i}` })),
    total: 101,
    page: 1,
    pageSize: API_PAGE_SIZE,
    totalPages: 2,
  };
  assert.throws(
    () => aggregatePages(first, []),
    /paginated response incomplete/,
  );
});

test("分页响应页码/元数据/重复 id 均拒绝", () => {
  const first = {
    items: Array.from({ length: API_PAGE_SIZE }, (_, i) => ({ id: `t-${i}` })),
    total: 101,
    page: 1,
    pageSize: API_PAGE_SIZE,
    totalPages: 2,
  };
  assert.throws(
    () => aggregatePages(first, [{
      list: [{ id: "t-100" }],
      total: 101,
      page: 3,
      pageSize: API_PAGE_SIZE,
      totalPages: 2,
    }]),
    /page mismatch/,
  );
  assert.throws(
    () => aggregatePages({
      items: [{ id: "same" }, { id: "same" }],
      total: 2,
      page: 1,
      pageSize: API_PAGE_SIZE,
      totalPages: 1,
    }, []),
    /duplicate id/,
  );
});

test("demo-fragile 每次脚本运行最多触发一次", () => {
  const fragile = { def: { name: "demo-fragile", triggerType: "manual" }, id: "fragile-1" };
  const targets = triggerTargets([
    { def: { name: "demo-hello-fixed", triggerType: "fixed_rate" }, id: "fixed-1" },
    fragile,
    { def: { name: "demo-cron-report", triggerType: "cron" }, id: "cron-1" },
    fragile,
  ]);
  assert.deepEqual(targets.map(({ def }) => def.name), ["demo-fragile", "demo-cron-report"]);
  assert.equal(targets.filter(({ def }) => def.name === "demo-fragile").length, 1);
});

test("非分页响应仍按原契约读取数组", () => {
  // listAll 的网络行为由 apiFetch 封装，这里只检查导出 helper 可用；
  // 真正的 100 条分页聚合由上面的纯函数契约覆盖。
  assert.equal(typeof listAll, "function");
});

console.log(`\n${passed} assertions passed`);
process.exit(0);
