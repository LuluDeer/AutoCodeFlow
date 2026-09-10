#!/usr/bin/env node
/**
 * demo-failure-seed.mjs 纯函数自检（对齐 demo-seed.selftest.mjs 模式：
 * 只 import 纯函数断言脚本逻辑，不依赖真实 admin-api 起服务）。
 * `node scripts/demo-failure-seed.selftest.mjs`，断言全过退出码 0。
 */
import assert from "node:assert/strict";
import {
  DEFAULT_DEADEND_HOST,
  DEMO_FAILURE_PREFIX,
  approvalAppDef,
  deadLetterSubDef,
  failureTaskDefs,
  findExisting,
  findSubByUrl,
  hasFailedExecution,
  hasPendingApproval,
  unwrap,
} from "./demo-failure-seed.mjs";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("demo-failure-seed.selftest");

test("演练任务定义：2 个且全部带 demo-failure- 前缀", () => {
  const defs = failureTaskDefs();
  assert.equal(defs.length, 2);
  for (const d of defs) assert.ok(d.name.startsWith(DEMO_FAILURE_PREFIX), d.name);
});

test("fragile 与 runbook 双任务覆盖（失败样本 + runbook 样本）", () => {
  const names = failureTaskDefs().map((d) => d.name);
  assert.deepEqual(names, ["demo-failure-fragile", "demo-failure-runbook"]);
});

test("两个演练任务均为 manual 触发（触发节奏由演练者掌控）", () => {
  for (const d of failureTaskDefs()) assert.equal(d.triggerType, "manual");
});

test("fragile 任务源码必须故意抛错（失败样本演示的依据）", () => {
  const fragile = failureTaskDefs().find((d) => d.name === "demo-failure-fragile");
  assert.ok(/throw new Error/.test(fragile.glueSource));
});

test("runbook 任务必须带非空 markdown runbook（FEAT-11 依据）", () => {
  const rb = failureTaskDefs().find((d) => d.name === "demo-failure-runbook").runbook;
  assert.ok(typeof rb === "string" && rb.trim().length > 0);
  assert.ok(rb.includes("## 排障步骤") && rb.includes("## 升级路径"));
});

test("死信订阅：url 为公网形状 IP 且订阅 execution.failed", () => {
  const sub = deadLetterSubDef();
  assert.equal(sub.name, "demo-failure-deadend");
  assert.ok(sub.url.startsWith(`http://${DEFAULT_DEADEND_HOST}/`));
  assert.deepEqual(sub.eventTypes, ["execution.failed"]);
});

test("死信端点主机不是 SSRF 拒绝段（裁定依据：公网形状才可创建）", () => {
  // 203.0.113.1（TEST-NET-3）不在 SSRF_DENY_HOST_PATTERNS 的任何非公网段：
  // 非 0/10/100.64+/127/169.254/172.16-31/192.168/198.18-19/224+/240+，也非
  // 本机 fake-ip 段 198.18/15 —— 可通过 assertSafeHttpUrl 创建，出站必败。
  const [a, b] = DEFAULT_DEADEND_HOST.split(".").map(Number);
  assert.notEqual(a, 127); // 环回
  assert.notEqual(a, 10); // RFC1918
  assert.notEqual(a, 192); // RFC1918
  assert.notEqual(a, 169); // 链路本地/云元数据
  assert.notEqual(a, 0); // 未指定
  if (a === 172) assert.ok(b < 16 || b > 31); // RFC1918 172 段
  if (a === 100) assert.ok(b < 64 || b > 127); // CGNAT
  if (a === 198) assert.ok(b !== 18 && b !== 19); // 基准测试/fake-ip 段
  assert.ok(a < 224, "非组播/保留段");
});

test("deadLetterSubDef 参数化主机（--deadend-host 覆盖面）", () => {
  const sub = deadLetterSubDef("198.51.100.7");
  assert.equal(sub.url, "http://198.51.100.7/hooks/autoflow-drill");
});

test("审批应用：approvalRequired=true（DEP-04 冻结语义依据）", () => {
  const app = approvalAppDef();
  assert.equal(app.name, "demo-failure-gated");
  assert.equal(app.approvalRequired, true);
});

test("findExisting 命中同名资源（幂等复用依据）", () => {
  const tasks = [{ name: "demo-failure-fragile", id: "t1" }];
  assert.equal(findExisting(tasks, "demo-failure-fragile").id, "t1");
  assert.equal(findExisting(tasks, "nope"), undefined);
  assert.equal(findExisting(null, "x"), undefined);
});

test("findSubByUrl 按 url 命中订阅（读面无 name 的幂等依据）", () => {
  const subs = [{ id: "s1", url: "http://203.0.113.1/hooks/autoflow-drill" }];
  assert.equal(findSubByUrl(subs, "http://203.0.113.1/hooks/autoflow-drill").id, "s1");
  assert.equal(findSubByUrl(subs, "http://other/hook"), undefined);
});

test("hasFailedExecution 只认 failed 终态（幂等跳过触发依据）", () => {
  const execs = [
    { taskId: "t1", status: "success" },
    { taskId: "t2", status: "failed" },
  ];
  assert.equal(hasFailedExecution(execs, "t1"), false);
  assert.equal(hasFailedExecution(execs, "t2"), true);
  assert.equal(hasFailedExecution(null, "t1"), false);
});

test("hasPendingApproval 只认 pending_approval 行（DEP-04 幂等依据）", () => {
  const deploys = [
    { applicationId: "a1", approvalStatus: "approved" },
    { applicationId: "a2", approvalStatus: "pending_approval" },
  ];
  assert.equal(hasPendingApproval(deploys, "a1"), false);
  assert.equal(hasPendingApproval(deploys, "a2"), true);
  assert.equal(hasPendingApproval(undefined, "a1"), false);
});

test("unwrap 拆信封且非信封 passthrough", () => {
  assert.deepEqual(unwrap({ code: 0, message: "ok", data: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrap({ plain: true }), { plain: true });
});

console.log(`\n${passed} assertions passed`);
process.exit(0);
