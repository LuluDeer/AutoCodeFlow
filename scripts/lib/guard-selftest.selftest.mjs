#!/usr/bin/env node
/**
 * `scripts/lib/guard-selftest.mjs` 自己的 selftest。
 *
 * 铁律：harness 里每一条断言都必须**有本事失败**。所以这里对每个 API 都同时
 * 造一个负例（断言抛错，且错误信息里带可识别的 marker）和一个正例（断言不抛）。
 * 只写负例的话，「expectExit 无条件抛」也能全绿；只写正例的话，「expectExit
 * 无条件放行」也能全绿。
 *
 * 用法：node scripts/lib/guard-selftest.selftest.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  expectExit,
  makeFixtureRepo,
  reportCases,
  runGuard,
} from "./guard-selftest.mjs";

const BEHAVE = `
const mode = process.argv[2] ?? "ok";
console.log("stdout-line-A");
console.error("stderr-line-B");
if (mode === "exit1") process.exitCode = 1;
if (mode === "exit2") process.exitCode = 2;
if (mode === "sleep") await new Promise((r) => setTimeout(r, 5000));
if (mode === "slow") { const t = Date.now(); while (Date.now() - t < 250) {} }
`;

/** 断言 fn 必须抛错，且 message 含 marker（marker 就是「这条断言真的生效了」的证据）。 */
function expectThrows(fn, marker, caseName) {
  let error = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  if (error === null) {
    throw new Error(`【假断言】${caseName}：本应抛错，却静默通过了 —— ${marker}`);
  }
  const message = String(error?.message ?? error);
  if (!message.includes(marker)) {
    throw new Error(
      `【错误信息不可诊断】${caseName}：抛了，但信息里没有 ${JSON.stringify(marker)}\n实际：\n${message}`,
    );
  }
}

const fixture = makeFixtureRepo({
  "scripts/behave.mjs": BEHAVE,
  "nested/a/b/keep.txt": "x",
  "package.json": { name: "fixture", scripts: {} },
});

const behave = fixture.pathOf("scripts/behave.mjs");
const cases = [];
const run = (mode, extra = {}) => runGuard(behave, { args: [mode], ...extra });

// ── 正例控制组 ─────────────────────────────────────────────────────────────
cases.push({
  name: "正例：退出码 0 + stdout/stderr 两个面都用于 contains 匹配 → 不抛",
  fn: () => {
    const r = run("ok");
    const out = expectExit(r, {
      code: 0,
      contains: ["stdout-line-A", "stderr-line-B"],
      absent: ["stdout-line-Z"],
      label: "正例",
    });
    if (out !== r) throw new Error("expectExit 成功时应原样返回 result（便于链式）");
    if (r.timedOut !== false) throw new Error("正常退出的用例不该标 timedOut");
    if (typeof r.durationMs !== "number" || r.durationMs <= 0) {
      throw new Error("durationMs 必须被记录（否则 withinMs 断言无处安放）");
    }
  },
});

// ── ① 退出码不符 ───────────────────────────────────────────────────────────
cases.push({
  name: "① 退出码不符（实际 0 / 期望 1）→ 抛，且报出实际与期望",
  fn: () => {
    const r = run("ok");
    expectThrows(() => expectExit(r, { code: 1 }), "退出码 0（期望 1）", "退出码不符");
  },
});

cases.push({
  name: "①b 退出码不符（实际 2 / 期望 0|1）→ 抛，且错误里带被测命令",
  fn: () => {
    const r = run("exit2");
    expectThrows(() => expectExit(r, { code: [0, 1] }), "退出码 2", "退出码不符(数组期望)");
    expectThrows(() => expectExit(r, { code: [0, 1] }), "behave.mjs exit2", "错误信息必须带命令");
  },
});

cases.push({
  name: "①c 不给 code 的断言 → 直接拒绝（空断言 = 没断言）",
  fn: () => {
    expectThrows(() => expectExit(run("ok"), { contains: ["stdout-line-A"] }), "必须显式传 code", "缺 code");
  },
});

// ── ② contains 缺失 ────────────────────────────────────────────────────────
cases.push({
  name: "② contains 缺失 → 抛，错误里指明缺哪个片段并附输出尾部",
  fn: () => {
    const r = run("ok");
    expectThrows(
      () => expectExit(r, { code: 0, contains: ["NEEDLE-NOT-THERE"] }),
      '输出缺少片段 "NEEDLE-NOT-THERE"',
      "contains 缺失",
    );
    expectThrows(() => expectExit(r, { code: 0, contains: ["NEEDLE-NOT-THERE"] }), "stdout-line-A", "缺失时仍附输出");
  },
});

// ── ③ absent 命中 ─────────────────────────────────────────────────────────
cases.push({
  name: "③ absent 命中（stdout 与 stderr 两个面）→ 抛，并打印命中的那一行",
  fn: () => {
    const r = run("ok");
    expectThrows(
      () => expectExit(r, { code: 0, absent: ["stdout-line-A"] }),
      '输出不该出现 "stdout-line-A"',
      "absent 命中 stdout",
    );
    expectThrows(
      () => expectExit(r, { code: 0, absent: ["stderr-line-B"] }),
      '输出不该出现 "stderr-line-B"',
      "absent 命中 stderr",
    );
    expectThrows(() => expectExit(r, { code: 0, absent: ["stderr-line-B"] }), "stderr-line-B", "命中行需打印");
  },
});

// ── ④ 超时 ────────────────────────────────────────────────────────────────
cases.push({
  name: "④ 超时 → timedOut=true、code=null，expectExit 报超时而不是「退出码 null」",
  fn: () => {
    const r = run("sleep", { timeoutMs: 150 });
    if (r.timedOut !== true) throw new Error(`超时未被标记（timedOut=${r.timedOut}, signal=${r.signal}）`);
    if (r.code !== null) throw new Error(`被杀掉的子进程 code 应为 null，实际 ${r.code}`);
    expectThrows(() => expectExit(r, { code: 0 }), "守卫超时", "超时未报");
    expectThrows(() => expectExit(r, { code: 0 }), "150ms", "超时信息需带 timeoutMs");
  },
});

// ── ⑤ 脚本不存在 ──────────────────────────────────────────────────────────
cases.push({
  name: "⑤ 脚本不存在 → runGuard 立刻抛（不让 node 的 MODULE_NOT_FOUND 混进断言面）",
  fn: () => {
    expectThrows(
      () => runGuard(join(fixture.dir, "scripts", "no-such-guard.mjs")),
      "守卫脚本不存在",
      "脚本不存在",
    );
    expectThrows(() => runGuard(fixture.pathOf("scripts/behave.mjs"), { cwd: join(fixture.dir, "nope") }), "cwd 不存在", "cwd 不存在");
  },
});

// ── ⑥ withinMs（性能门槛本身也必须能失败）──────────────────────────────────
cases.push({
  name: "⑥ withinMs：慢用例超限 → 抛；快用例不超限 → 不抛",
  fn: () => {
    const slow = run("slow");
    expectThrows(() => expectExit(slow, { code: 0, withinMs: 30 }), "超过上限 30ms", "withinMs 超限未报");
    expectExit(run("ok"), { code: 0, withinMs: 20_000 });
  },
});

// ── ⑦ fixture 造树与清理 ──────────────────────────────────────────────────
cases.push({
  name: "⑦ makeFixtureRepo：造出嵌套文件 + JSON 化非字符串 + 拒绝路径越界 + cleanup 幂等",
  fn: () => {
    const pkg = join(fixture.dir, "package.json");
    if (!existsSync(pkg)) throw new Error("package.json 未生成");
    if (!existsSync(join(fixture.dir, "nested/a/b/keep.txt"))) throw new Error("嵌套目录未按 recursive 生成");
    const pkgText = readFileSync(pkg, "utf8");
    if (!pkgText.includes('"name": "fixture"')) throw new Error("非字符串内容未按 JSON 写入");
    expectThrows(() => fixture.pathOf("../escape"), "fixture 路径越界", "路径越界未拦");
  },
});

// ── ⑧ reportCases：用例抛错即计红，返回失败条数 ─────────────────────────────
cases.push({
  name: "⑧ reportCases：一条绿一条红 → 返回 1（红必须真的被计数）",
  fn: () => {
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    let failed;
    try {
      failed = reportCases([
        { name: "绿", fn: () => {} },
        { name: "红", fn: () => { throw new Error("boom"); } },
      ]);
    } finally {
      console.log = log;
      console.error = err;
    }
    if (failed !== 1) throw new Error(`reportCases 应返回 1，实际 ${failed}`);
  },
});

let failed;
try {
  failed = reportCases(cases, { title: "guard-selftest harness" });
} finally {
  fixture.cleanup();
  fixture.cleanup(); // 幂等
  if (existsSync(fixture.dir)) {
    console.error(`✖ fixture 未被清理：${fixture.dir}`);
    failed = (failed ?? 0) + 1;
  }
}

process.exit(failed > 0 ? 1 : 0);
