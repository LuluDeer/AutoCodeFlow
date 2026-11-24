#!/usr/bin/env node
// check-live-probes-intact.mjs 的**真子进程 CLI 黑盒自检**。
//
// 为什么要有这个文件（R229 假绿缺口）：
//   主脚本的 `--selftest`（:166-206）在**进程内**直调 `checkLiveProbesIntact(dir)`，
//   随后自己 `process.exit(failed ? 0 : 1)`；main 的退出码分支（:219/:223/:229）
//   **一个都没被断言**。实测把 :223 的 `process.exit(1)` 改成 `exit(0)` 后，旧自检
//   仍 5/5 全绿，而真 CLI 对坏夹具打印「✘ 真机探针清单不完整」却 exit 0。
//   ⇒ 本文件**只 spawn 真 CLI**，断言 `runGuard` 返回的退出码本身；
//   **不 import 守卫的任何函数**（进程内直调正是缺口来源）。
//
// 范式照 `scripts/check-brand-drift.selftest.mjs`：mkdtemp 夹具 + finally 清理，
// 用 `scripts/lib/guard-selftest.mjs` 的 `runGuard / expectExit`。
//
// ⚠️ `--root` 形态：主脚本用 `argv.indexOf("--root") + 1`（:209-210），
// **只认空格分离**；`--root=<dir>` 会回落 DEFAULT_ROOT 跑真仓库，
// 使「坏夹具」用例假绿。所以下面一律 `args: ["--root", dir]`。
//
// 夹具是**最小自造**的（守卫里的 `makeFixture` :143-161 没有 export）：
// 清单与 PROBES(:54-67) 逐项一致 —— 9 探针 + package.json，
// 探针正文含 `// 需要隔离 Redis（真机探针）`（过判据④），语法可解析（过判据③）。
//
// 运行：node scripts/check-live-probes-intact.selftest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectExit, runGuard } from "./lib/guard-selftest.mjs";

/** 被黑盒 spawn 的主脚本（不是本文件）。 */
const GUARD = fileURLToPath(new URL("./check-live-probes-intact.mjs", import.meta.url));

/** 必须与守卫 PROBES 完全一致：少一项都会让「完整夹具」误判为缺项。 */
const PROBES = [
  { script: "test:r207-queue-idle-live", file: "scripts/r207-queue-idle-live-probe.mjs" },
  { script: "test:r209-queue-idle-http", file: "scripts/r209-queue-idle-http-probe.mjs" },
  { script: "test:r210-stall-live", file: "scripts/r210-stall-live-probe.mjs" },
  { script: "test:r212-degraded-live", file: "scripts/r212-degraded-live-probe.mjs" },
  {
    script: "test:r213-observation-timeout-live",
    file: "scripts/r213-observation-timeout-live-probe.mjs",
  },
  { script: "test:r214-observer-leak-live", file: "scripts/r214-observer-leak-live-probe.mjs" },
  { script: "test:r215-jobid-live", file: "scripts/r215-jobid-live-probe.mjs" },
  { script: "test:r216-auto-requeue-live", file: "scripts/r216-auto-requeue-live-probe.mjs" },
  { script: "test:r217-auto-requeue-e2e", file: "scripts/r217-auto-requeue-e2e-probe.mjs" },
];

/**
 * 照守卫 :143-161 的形态造夹具。
 * @param {{skipFiles?: string[], skipPackageJson?: boolean, redirect?: Record<string,string>}} overrides
 */
function makeFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r229-blackbox-"));
  try {
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    const scripts = {};
    for (const { script, file } of PROBES) {
      if (overrides.skipFiles?.includes(file)) continue;
      scripts[script] = `node ${overrides.redirect?.[file] ?? file}`;
      fs.writeFileSync(
        path.join(dir, file),
        "// 需要隔离 Redis（真机探针）\nexport const x = 1;\n",
      );
    }
    if (!overrides.skipPackageJson) {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts }, null, 2));
    }
    return dir;
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

const cases = [];
const add = (name, fn) => cases.push({ name, fn });

add("CLI ① 完整夹具 → exit 0（断言真子进程退出码，不是进程内 check.ok）", () => {
  const dir = makeFixture();
  try {
    expectExit(runGuard(GUARD, { args: ["--root", dir] }), {
      code: 0,
      contains: ["真机探针完好", "9 个探针文件存在"],
      absent: ["真机探针清单不完整"],
      label: "CLI 完整夹具",
    });
  } finally {
    cleanup(dir);
  }
});

add("CLI ② 删掉一个探针文件 → exit 1 + 报错点名（伪绿改动 :223 会被这条抓到）", () => {
  const dir = makeFixture({ skipFiles: ["scripts/r216-auto-requeue-live-probe.mjs"] });
  try {
    expectExit(runGuard(GUARD, { args: ["--root", dir] }), {
      code: 1,
      contains: [
        "真机探针清单不完整",
        "探针文件不存在",
        "scripts/r216-auto-requeue-live-probe.mjs",
      ],
      absent: ["真机探针完好"],
      label: "CLI 缺探针夹具",
    });
  } finally {
    cleanup(dir);
  }
});

add("CLI ③ 缺 package.json → exit 1 + 报错点名（失败分支的第二条路）", () => {
  const dir = makeFixture({ skipPackageJson: true });
  try {
    expectExit(runGuard(GUARD, { args: ["--root", dir] }), {
      code: 1,
      contains: ["真机探针清单不完整", "缺 package.json"],
      absent: ["真机探针完好"],
      label: "CLI 缺 package.json 夹具",
    });
  } finally {
    cleanup(dir);
  }
});

add("CLI ④ 正例控制组：不带 --root 跑真仓库基线 → exit 0（默认根仍有效）", () => {
  expectExit(runGuard(GUARD), {
    code: 0,
    contains: ["真机探针完好"],
    absent: ["真机探针清单不完整"],
    label: "CLI 默认根（真仓库基线）",
  });
});

const failed = [];
for (const c of cases) {
  try {
    c.fn();
    console.log(`  ✔ ${c.name}`);
  } catch (err) {
    failed.push(c.name);
    console.error(`  ✘ ${c.name}`);
    console.error(`      ${err.message}`);
  }
}
if (failed.length) {
  console.error(`\n✘ check-live-probes-intact 黑盒自检 失败：${failed.length}/${cases.length} 条用例未按预期`);
  process.exit(1);
}
console.log(`\n✔ check-live-probes-intact 黑盒自检 通过：${cases.length}/${cases.length} 条用例`);
