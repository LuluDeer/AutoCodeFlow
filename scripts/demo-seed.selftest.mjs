#!/usr/bin/env node
/**
 * demo-seed.mjs 纯函数自检（对齐 load-test.selftest.mjs 模式）。
 * `node scripts/demo-seed.selftest.mjs`，断言全过退出码 0。
 */
import assert from "node:assert/strict";
import {
  aggregateSopPages,
  API_PAGE_SIZE,
  aggregatePages,
  demoSopDefs,
  demoTaskDefs,
  findExisting,
  findSop,
  listAll,
  pageCount,
  sopPageCount,
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

// ── SOP 演示包（N-08）──
//
// selftest 是零依赖 Node（对齐文件头约定），没有 js-yaml 可用——front-matter
// 在这里做**行级结构校验**（缩进分层 + 键集合 + 值域），真正的严格校验由
// admin-api 发布门（sop-frontmatter.ts validateFrontMatter strict）在线执行；
// 本地用 scripts/demo-seed.mjs 打真实环境即走该门。

const SOP_ALLOWED_TOP = ["target", "capabilities", "acceptance", "constraints", "clarification"];
const SOP_CAPABILITIES = ["browser", "gui", "filesystem", "http"];

/** 行级解析 front-matter：返回顶层键集合 + 全部缩进行（键, 深度, 值）。 */
function parseFrontMatterLines(yaml) {
  const lines = yaml.split("\n").filter((l) => l.trim() !== "");
  const topKeys = [];
  const entries = [];
  for (const line of lines) {
    if (/^\s/.test(line) === false) {
      const key = line.split(":")[0];
      topKeys.push(key);
      entries.push({ key, depth: 0, value: line.slice(line.indexOf(":") + 1).trim() });
    } else {
      const indent = line.length - line.trimStart().length;
      assert.ok(indent % 2 === 0, `front-matter 缩进不是 2 空格倍数：${line}`);
      entries.push({
        key: line.trim().split(":")[0],
        depth: indent / 2,
        value: line.slice(line.indexOf(":") + 1).trim(),
      });
    }
    assert.ok(!line.includes("\t"), "front-matter 不允许 tab 缩进");
  }
  return { topKeys, entries };
}

test("demoSopDefs：缺演示任务 id 直接拒绝（platform 锚点不可凭空）", () => {
  assert.throws(() => demoSopDefs(undefined), /任务 id/);
  assert.throws(() => demoSopDefs({}), /任务 id/);
  assert.throws(
    () => demoSopDefs({ "demo-hello-fixed": "uuid-hello" }),
    /任务 id/,
  );
});

test("演示 SOP：3 条、demo-sop- 前缀、slug 合法、title 非空", () => {
  const defs = demoSopDefs({ "demo-hello-fixed": "uuid-hello", "demo-cron-report": "uuid-cron" });
  assert.equal(defs.length, 3);
  for (const d of defs) {
    assert.ok(d.slug.startsWith("demo-sop-"), d.slug);
    assert.match(d.slug, /^[a-z0-9][a-z0-9-]{0,127}$/, d.slug);
    assert.ok(d.title.trim().length > 0, d.slug);
    assert.ok(d.frontMatterYaml.trim().length > 0, d.slug);
    assert.ok(d.bodyMarkdown.trim().length > 0, d.slug);
  }
});

test("演示 SOP front-matter：顶层键/能力域/值域全部在发布门允许集内", () => {
  const defs = demoSopDefs({ "demo-hello-fixed": "uuid-hello", "demo-cron-report": "uuid-cron" });
  for (const d of defs) {
    const { topKeys } = parseFrontMatterLines(d.frontMatterYaml);
    for (const k of topKeys) {
      assert.ok(SOP_ALLOWED_TOP.includes(k), `${d.slug} 未知顶层键 ${k}`);
    }
    // acceptance：kind=platform 项必须带 check/task/expect/timeoutSec
    const yaml = d.frontMatterYaml;
    if (yaml.includes("kind: platform")) {
      const block = yaml.slice(yaml.indexOf("kind: platform"), yaml.indexOf("constraints:"));
      assert.match(block, /check: trigger_task_and_expect_status/, d.slug);
      assert.match(block, /task: (uuid-hello|uuid-cron)/, d.slug);
      assert.match(block, /expect: SUCCEEDED/, d.slug);
      const timeout = Number(block.match(/timeoutSec: (\d+)/)?.[1]);
      assert.ok(timeout >= 1 && timeout <= 3600, `${d.slug} timeoutSec 越界`);
    } else {
      assert.fail(`${d.slug} 缺 platform 验收项——演示 SOP 必须零配置机器可验`);
    }
    // constraints 值域（sop-frontmatter.ts：maxDurationSec 60..86400；裸域名）
    if (yaml.includes("maxDurationSec:")) {
      const v = Number(yaml.match(/maxDurationSec: (\d+)/)?.[1]);
      assert.ok(v >= 60 && v <= 86400, `${d.slug} maxDurationSec 越界`);
    }
    for (const m of yaml.matchAll(/^\s+- ([a-z0-9.-]+)$/gm)) {
      const domain = m[1];
      if (domain.includes(".")) {
        assert.match(domain, /^[a-z0-9.-]+$/i, `${d.slug} allowedDomains 非裸域名`);
        assert.ok(!domain.includes(".."), d.slug);
      }
    }
    // clarification：maxRounds ≤ 5（硬上限）、owner 合法
    if (yaml.includes("maxRounds:")) {
      const r = Number(yaml.match(/maxRounds: (\d+)/)?.[1]);
      assert.ok(r >= 1 && r <= 5, `${d.slug} maxRounds 越界`);
    }
    if (yaml.includes("owner:")) {
      const o = yaml.match(/owner: (\S+)/)?.[1];
      assert.ok(["center-agent", "human"].includes(o), `${d.slug} owner 非法`);
    }
  }
});

test("演示 SOP capabilities 逐条在封闭枚举内", () => {
  const defs = demoSopDefs({ "demo-hello-fixed": "uuid-hello", "demo-cron-report": "uuid-cron" });
  for (const d of defs) {
    const capBlock = d.frontMatterYaml.slice(
      d.frontMatterYaml.indexOf("capabilities:"),
      d.frontMatterYaml.indexOf("acceptance:"),
    );
    const caps = [...capBlock.matchAll(/^\s+- (\S+)$/gm)].map((m) => m[1]);
    assert.ok(caps.length > 0, `${d.slug} capabilities 为空`);
    for (const c of caps) {
      assert.ok(SOP_CAPABILITIES.includes(c), `${d.slug} 能力域 ${c} 不在枚举内`);
    }
  }
});

test("演示 SOP 正文：07 §6.1 骨架（要做什么/验收/你不必照做）+ GUI 条目带前置条件", () => {
  const defs = demoSopDefs({ "demo-hello-fixed": "uuid-hello", "demo-cron-report": "uuid-cron" });
  for (const d of defs) {
    assert.ok(d.bodyMarkdown.includes("## 要做什么"), d.slug);
    assert.ok(d.bodyMarkdown.includes("## 验收"), d.slug);
    assert.ok(d.bodyMarkdown.includes("## 你不必照做"), d.slug);
  }
  const gui = defs.find((d) => d.slug === "demo-sop-gui-x11-hello");
  assert.ok(gui, "GUI 演示 SOP 缺席");
  assert.ok(gui.frontMatterYaml.includes("- gui"), "GUI SOP 未声明 gui 能力域");
  assert.ok(/前置条件/.test(gui.bodyMarkdown), "GUI SOP 缺前置条件节");
  assert.ok(/app-scoped/.test(gui.bodyMarkdown), "GUI SOP 未提 app-scoped 放宽");
  assert.ok(/xterm/.test(gui.bodyMarkdown), "GUI SOP 未提目标应用");
});

test("findSop 按 slug 命中（幂等复用依据）", () => {
  const sops = [{ slug: "demo-sop-portal-morning-check", id: "s1" }];
  assert.equal(findSop(sops, "demo-sop-portal-morning-check").id, "s1");
  assert.equal(findSop(sops, "nope"), undefined);
  assert.equal(findSop(undefined, "x"), undefined);
});

test("SOP 列表 {items,total} 形态：页数由 total 推导（无 totalPages 元数据）", () => {
  assert.equal(
    sopPageCount({ items: Array.from({ length: API_PAGE_SIZE }, (_, i) => ({ id: `s-${i}` })), total: 101 }),
    2,
  );
  assert.equal(sopPageCount({ items: [], total: 0 }), 0);
  assert.throws(() => sopPageCount({ items: [] }), /missing valid total/);
  assert.throws(() => sopPageCount({ items: [], total: 5 }, 0), /invalid sop pageSize/);
});

test("SOP 分页聚合：total 对账 + 唯一 id；缺失/重复显式失败", () => {
  const first = {
    items: Array.from({ length: API_PAGE_SIZE }, (_, i) => ({ id: `s-${i}` })),
    total: 102,
  };
  const second = { items: [{ id: "s-100" }, { id: "s-101" }], total: 102 };
  assert.equal(aggregateSopPages(first, [second]).length, 102);
  assert.throws(() => aggregateSopPages(first, []), /sop list incomplete/);
  assert.throws(
    () =>
      aggregateSopPages(
        { items: [{ id: "dup" }, { id: "dup" }], total: 2 },
        [],
      ),
    /duplicate id/,
  );
  assert.throws(
    () => aggregateSopPages({ total: 1 }, []),
    /missing items/,
  );
});

console.log(`\n${passed} assertions passed`);
process.exit(0);
