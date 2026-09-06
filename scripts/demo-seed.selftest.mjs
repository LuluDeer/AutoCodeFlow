#!/usr/bin/env node
/**
 * demo-seed.mjs 纯函数自检（对齐 load-test.selftest.mjs 模式）。
 * `node scripts/demo-seed.selftest.mjs`，断言全过退出码 0。
 */
import assert from "node:assert/strict";
import { demoTaskDefs, findExisting, unwrap } from "./demo-seed.mjs";

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

console.log(`\n${passed} assertions passed`);
process.exit(0);
