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
  REPO_ROOT,
  runGuard,
} from "./guard-selftest.mjs";
// R04（2026-11-05）：自检 hermeticity 的注入面与本文件的接线判据。
import {
  HERMETIC_ENV,
  SELFTEST_SKIP_ENV_FILE_KEY,
  hermeticEnv,
  readEnvFileValue,
  scanAdminSpawns,
} from "./selftest-hermetic.mjs";

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

// ── ⑨ 自检 hermeticity：注入面（helper 语义 + 有本事失败的负例）─────────────
cases.push({
  name: "⑨ hermeticEnv：注入 SELFTEST_SKIP_ENV_FILE=1、不改入参、可无参",
  fn: () => {
    const base = { A: "1" };
    const merged = hermeticEnv(base);
    if (merged.A !== "1") throw new Error("原有键丢失");
    if (merged[SELFTEST_SKIP_ENV_FILE_KEY] !== "1") throw new Error("开关未注入");
    if (base[SELFTEST_SKIP_ENV_FILE_KEY] !== undefined) throw new Error("入参被就地修改（应返回新对象）");
    if (HERMETIC_ENV[SELFTEST_SKIP_ENV_FILE_KEY] !== "1") throw new Error("HERMETIC_ENV 常量不一致");
    if (hermeticEnv()[SELFTEST_SKIP_ENV_FILE_KEY] !== "1") throw new Error("无参调用未注入");
  },
});

cases.push({
  name: "⑨ readEnvFileValue：解析引号/裸值、缺文件与缺键返回 null（不是抛错）",
  fn: () => {
    const fx = makeFixtureRepo({
      "a.env": 'EXECUTOR_SECRET=bare-value\nQUOTED="q v"\n# COMMENT=x\n',
    });
    try {
      if (readEnvFileValue(fx.pathOf("a.env"), "EXECUTOR_SECRET") !== "bare-value") {
        throw new Error("裸值解析错");
      }
      if (readEnvFileValue(fx.pathOf("a.env"), "QUOTED") !== "q v") {
        throw new Error("引号未剥离");
      }
      if (readEnvFileValue(fx.pathOf("a.env"), "COMMENT") !== null) {
        throw new Error("注释行被当成键");
      }
      if (readEnvFileValue(fx.pathOf("missing.env"), "X") !== null) {
        throw new Error("缺文件应返回 null");
      }
      if (readEnvFileValue(fx.pathOf("a.env"), "NOPE") !== null) {
        throw new Error("缺键应返回 null");
      }
    } finally {
      fx.cleanup();
    }
  },
});

cases.push({
  name: "⑨ scanAdminSpawns：未接 helper / 已接 / 只起 executor ⇒ 分别 红/绿/不扫（负例必须红）",
  fn: () => {
    const fx = makeFixtureRepo({
      // ① 起 admin-api 但没走 helper ⇒ 必须点名
      "leaky-selftest.mjs": 'import {spawn} from "node:child_process";\nconst API_DIR="/x/apps/admin-api";\nspawn("node",["dist/main.js"],{cwd:API_DIR,env:{}});\n',
      // ② 走 helper ⇒ 绿
      "good-selftest.mjs": 'import {hermeticEnv} from "./lib/selftest-hermetic.mjs";\nconst API_DIR="/x/apps/admin-api";\nspawn("node",["dist/main.js"],{cwd:API_DIR,env:hermeticEnv({})});\n',
      // ③ 只起 executor-node ⇒ 不在判据面内
      "exec-only.mjs": 'spawn("node",["apps/executor-node/dist/main.js"],{env:{}});\n',
      // ④ 与 admin 无关的脚本 ⇒ 不扫
      "other.mjs": "console.log(1);\n",
    });
    try {
      const r = scanAdminSpawns(fx.dir);
      if (r.scanned !== 2) throw new Error(`扫描面应为 2，实际 ${r.scanned}`);
      if (r.offenders.length !== 1 || r.offenders[0] !== "leaky-selftest.mjs") {
        throw new Error(`应点名 leaky-selftest.mjs，实际 ${JSON.stringify(r.offenders)}`);
      }
      if (r.wired.length !== 1 || r.wired[0] !== "good-selftest.mjs") {
        throw new Error(`应记 good-selftest.mjs 已接，实际 ${JSON.stringify(r.wired)}`);
      }
    } finally {
      fx.cleanup();
    }
  },
});

// ── ⑩ 真仓库接线：8 个起 admin-api 的自检全部接上 + 两侧字面量同源 ────────────
cases.push({
  name: "⑩ 真仓库：scripts/ 下起 admin-api 的自检必须全部经 hermeticEnv（漏接即红）",
  fn: () => {
    const r = scanAdminSpawns(join(REPO_ROOT, "scripts"));
    if (r.scanned < 8) throw new Error(`扫描面退化：只扫到 ${r.scanned} 个（预期 ≥8）`);
    if (r.offenders.length > 0) {
      throw new Error(`以下自检起 admin-api 但没接 hermeticEnv：${r.offenders.join(", ")}`);
    }
  },
});

cases.push({
  name: "⑩ 真仓库：app 侧 ignoreEnvFile 绑定同一开关，且键名与 helper 同一字面量",
  fn: () => {
    const appModule = readFileSync(join(REPO_ROOT, "apps/admin-api/src/app.module.ts"), "utf8");
    if (!/ignoreEnvFile:\s*shouldSkipEnvFile\(\)/.test(appModule)) {
      throw new Error("app.module.ts 未把 ignoreEnvFile 绑定到 shouldSkipEnvFile()");
    }
    // **两个** `.env` 入口都要受同一开关约束：main.ts 的 dotenv preload 是真正的
    // 那一个（R04 实测：只改 ConfigModule 时 `.env` 仍被 preload 注入，套件照旧红）。
    const mainTs = readFileSync(join(REPO_ROOT, "apps/admin-api/src/main.ts"), "utf8");
    if (!/if \(!shouldSkipEnvFile\(\)\) \{\s*\n\s*loadEnvFile\(/.test(mainTs)) {
      throw new Error("main.ts 的 dotenv preload 未被 shouldSkipEnvFile() 守卫（.env 仍会被注入）");
    }
    // 第三个入口：migration CLI（data-source.ts 的 dotenv.config()）。三个入口全守卫才算 hermetic。
    const dataSource = readFileSync(join(REPO_ROOT, "apps/admin-api/src/data-source.ts"), "utf8");
    if (!/if \(!shouldSkipEnvFile\(\)\) dotenv\.config\(\);/.test(dataSource)) {
      throw new Error("data-source.ts 的 dotenv.config() 未被守卫（migration CLI 仍会读 .env）");
    }
    const envFile = readFileSync(join(REPO_ROOT, "apps/admin-api/src/config/selftest-env.ts"), "utf8");
    const m = /SELFTEST_SKIP_ENV_FILE_KEY\s*=\s*"([A-Z0-9_]+)"/.exec(envFile);
    if (!m) throw new Error("selftest-env.ts 里找不到键名常量");
    if (m[1] !== SELFTEST_SKIP_ENV_FILE_KEY) {
      throw new Error(`键名漂移：app=${m[1]} helper=${SELFTEST_SKIP_ENV_FILE_KEY}`);
    }
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
