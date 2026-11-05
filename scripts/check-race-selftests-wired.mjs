#!/usr/bin/env node
/**
 * R12（2026-11-05）：**真机用例必须真的被某条链引用**（防腐烂守卫）。
 *
 * ## 为什么需要它
 *
 * 本仓有过多次「写了没人跑」的先例（`check:guards-wired` 的头注里记了一串）。
 * R11/R12 新增的两条用例需要 **docker + 分钟级**，因此进不了离线 `test:guards:repo`；
 * 它们只能挂在 `test:guards:selftests`（真机面）。**只要有人在 package.json 里加了
 * `test:*` 却忘了往链里加**，这条用例就永久不会执行，而它看起来"存在"。
 *
 * 本守卫把这种"存在但没人跑"变成红灯：对每条登记的真机用例，逐条断言
 *   ① 脚本文件存在；
 *   ② `package.json` 里有对应 npm script，且其命令**真的执行了那个文件**；
 *   ③ 该 npm script 被 `test:guards:selftests` 链**引用**（`npm run <name>`）。
 *
 * ## 反向验证（本判据的"牙齿"）
 *
 * `--selftest` 在临时 fixture 仓库上跑**真子进程**，逐个方向证明它会红：
 * 删链里的引用 / 删 npm script / 删脚本文件 —— 三种都断言 exit 1 且报错点名。
 * 没有这三条，本守卫就可能是个恒绿门禁。
 *
 * 用法：`node scripts/check-race-selftests-wired.mjs [--selftest] [--root=<dir>]`
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expectExit,
  expectRequiredPaths,
  makeFixtureRepo,
  reportCases,
  runGuard,
} from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "subprocess");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(HERE, "..", "..");

/** 真机面（需 docker）用例的**登记表**：新增一条就加一行。 */
export const REQUIRED_RACE_SELFTESTS = [
  {
    id: "executor-register-race",
    file: "scripts/executor-register-race-selftest.mjs",
    npmScript: "test:executor-register-race",
    chain: "test:guards:selftests",
    why: "R11：执行器注册接管 CAS 的跨写覆盖窗口（真机 PG + 真进程）",
  },
  {
    id: "heartbeat-dispatch-race",
    file: "scripts/heartbeat-dispatch-race-selftest.mjs",
    npmScript: "test:heartbeat-dispatch-race",
    chain: "test:guards:selftests",
    why: "R16：心跳覆盖写 vs 派发原子占坑的 lost update（真 PG 两连接并发，I1/I2/I3）",
  },
  {
    id: "executor-token-cross-instance",
    file: "scripts/executor-token-cross-instance-selftest.mjs",
    npmScript: "test:executor-token-cross-instance",
    chain: "test:guards:selftests",
    why: "R14：ADR-030 ②′ 的跨实例幂等（两 admin-api 实例 + 同一 PG/Redis，I1–I4）",
  },
  {
    id: "executor-token-idempotency",
    file: "scripts/executor-token-idempotency-selftest.mjs",
    npmScript: "test:executor-token-idempotency",
    chain: "test:guards:selftests",
    why: "R12：issueToken 的 (address,startupId) 并发幂等（真机 4 并发 × N 轮）",
  },
];

/**
 * 判据本体（纯函数，fixture 可驱动）。
 *
 * @returns {string[]} 失败原因列表（空 = 绿）
 */
export function check(root = REPO_ROOT) {
  const errors = [];
  const pkgPath = join(root, "package.json");
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
  } catch (err) {
    return [`读不到 package.json（${pkgPath}）：${err.message}`];
  }

  for (const entry of REQUIRED_RACE_SELFTESTS) {
    // ① 脚本文件存在
    if (!existsSync(join(root, entry.file))) {
      errors.push(`${entry.id}：脚本文件不存在（${entry.file}）—— 登记表指向了不存在的用例`);
      continue;
    }
    // ② npm script 存在且真的跑那个文件
    const cmd = scripts[entry.npmScript];
    if (typeof cmd !== "string" || cmd.trim() === "") {
      errors.push(`${entry.id}：package.json 里没有 "${entry.npmScript}" —— 用例没有可执行入口`);
      continue;
    }
    if (!cmd.includes(entry.file)) {
      errors.push(
        `${entry.id}："${entry.npmScript}" 没有执行 ${entry.file}（实际：${cmd.slice(0, 120)}）—— ` +
          `入口指向了别的东西`,
      );
    }
    // ③ 被目标链引用
    const chain = scripts[entry.chain];
    if (typeof chain !== "string") {
      errors.push(`${entry.id}：没有 "${entry.chain}" 链 —— 真机用例无处挂载`);
      continue;
    }
    if (!chain.includes(`npm run ${entry.npmScript}`)) {
      errors.push(
        `${entry.id}：${entry.chain} 链里没有 "npm run ${entry.npmScript}" —— ` +
          `用例存在但没有任何链会执行它（这正是本守卫要防的"写了没人跑"）`,
      );
    }
  }
  return errors;
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const at = argv.indexOf("--root");
  const rootArg = eq ? eq.slice("--root=".length) : at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
  const root = resolve(rootArg ?? REPO_ROOT);
  const errors = check(root);
  if (errors.length === 0) {
    console.log(
      `✔ 真机用例接线判据通过：${REQUIRED_RACE_SELFTESTS.length} 条（${REQUIRED_RACE_SELFTESTS.map(
        (e) => e.id,
      ).join(" / ")}）都有可执行入口且在 ${REQUIRED_RACE_SELFTESTS[0].chain} 链内。`,
    );
    return 0;
  }
  console.error(`✘ 真机用例接线判据：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

// ── 自检（真子进程 + 三个反向方向）──────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function fixtureScripts(overrides = {}) {
  const scripts = {
    "test:guards:selftests":
      "npm run test:executor-register-race && npm run test:executor-token-idempotency " +
      "&& npm run test:executor-token-cross-instance && npm run test:heartbeat-dispatch-race",
    "test:executor-register-race": "node scripts/executor-register-race-selftest.mjs",
    "test:executor-token-idempotency": "node scripts/executor-token-idempotency-selftest.mjs",
    "test:executor-token-cross-instance": "node scripts/executor-token-cross-instance-selftest.mjs",
    "test:heartbeat-dispatch-race": "node scripts/heartbeat-dispatch-race-selftest.mjs",
  };
  return { ...scripts, ...overrides };
}

function fixtureTree({ scripts, dropFile = null } = {}) {
  const files = {
    "package.json": JSON.stringify({ name: "fixture", scripts: scripts ?? fixtureScripts() }, null, 2),
    "scripts/executor-register-race-selftest.mjs": "// stub\n",
    "scripts/executor-token-idempotency-selftest.mjs": "// stub\n",
    "scripts/executor-token-cross-instance-selftest.mjs": "// stub\n",
    "scripts/heartbeat-dispatch-race-selftest.mjs": "// stub\n",
  };
  if (dropFile) delete files[dropFile];
  return files;
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });

  // R63：**夹具-必需项一致性**（R59 助手的形态分派版）。
  // 本守卫的必需项是**对象数组**（`{id,file,npmScript,chain}`），夹具是 `files` 树
  // ⇒ 用 `expectRequiredPaths`（按 `file` 判定路径存在且内容非空），而不是硬塞文本比对。
  push("R63：fixtureTree 覆盖 REQUIRED_RACE_SELFTESTS 的每个脚本文件", () => {
    const files = fixtureTree();
    const miss = expectRequiredPaths(REQUIRED_RACE_SELFTESTS, files, {
      pathOf: (item) => item.file,
    });
    if (miss.length > 0) throw new Error(miss.join("；"));
  });

  push("正例：两条用例都接线 ⇒ exit 0（正例控制组）", () => {
    const repo = makeFixtureRepo(fixtureTree());
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), { code: 0, withinMs: 20000, label: "正例" });
    } finally {
      repo.cleanup();
    }
  });

  push("反例①：链里删掉引用 ⇒ exit 1 且点名「没有任何链会执行」", () => {
    const scripts = fixtureScripts({
      "test:guards:selftests": "npm run test:executor-register-race",
    });
    const repo = makeFixtureRepo(fixtureTree({ scripts }));
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["test:executor-token-idempotency", "没有任何链会执行"],
        withinMs: 20000,
        label: "删引用",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例②：删掉 npm script 定义 ⇒ exit 1 且点名", () => {
    const scripts = fixtureScripts();
    delete scripts["test:executor-token-idempotency"];
    const repo = makeFixtureRepo(fixtureTree({ scripts }));
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["没有 \"test:executor-token-idempotency\""],
        withinMs: 20000,
        label: "删脚本",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例③：脚本文件不存在 ⇒ exit 1 且点名", () => {
    const repo = makeFixtureRepo(
      fixtureTree({ dropFile: "scripts/executor-token-idempotency-selftest.mjs" }),
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["脚本文件不存在"],
        withinMs: 20000,
        label: "删文件",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例④：npm script 指向别的文件 ⇒ exit 1（入口被改坏）", () => {
    const scripts = fixtureScripts({
      "test:executor-token-idempotency": "node scripts/other-selftest.mjs",
    });
    const repo = makeFixtureRepo(fixtureTree({ scripts }));
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["没有执行"],
        withinMs: 20000,
        label: "入口漂移",
      });
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "check-race-selftests-wired selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}
