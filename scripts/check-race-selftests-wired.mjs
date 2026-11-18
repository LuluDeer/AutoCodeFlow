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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expectExit,
  expectRequiredPaths,
  makeFixtureRepo,
  reportCases,
  runGuard,
} from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "push");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(HERE, "..", "..");

/** 真机面（需 docker）用例的**登记表**：新增一条就加一行。 */
export const PARENT_EXEMPT_REL = "scripts/race-selftests-parent-exempt.json";

/**
 * R106：**父脚本必须真的会被链执行**（治「空转守卫」）。
 *
 * 事故：本守卫此前只断言"该真机脚本被 `test:guards:selftests` 引用"，而
 * **`test:guards:selftests` 自身从不被 `test:guards:chain` 执行** ⇒ 整个保证是空转的
 * （它证明"挂到了一条从不运行的命令上"，而链却显示 98/98 全绿）。
 *
 * 判据：每个被引用的父脚本必须出现在 `test:guards:chain` 里；否则红并点名"你对它的接线断言等于空转"。
 * 例外只允许**显式豁免**（`scripts/race-selftests-parent-exempt.json`，带 why + reviewBy），且**每次运行都打印**。
 */
export function checkParentChainWiring(root) {
  const errors = [];
  const printed = [];
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return { errors: ["读不到 package.json —— 父脚本判据失去对象"], printed };
  const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
  const chain = scripts["test:guards:chain"] ?? "";
  const chainParts = chain.split("&&").map((x) => x.trim());

  let exempt = [];
  const exPath = join(root, PARENT_EXEMPT_REL);
  if (existsSync(exPath)) {
    try {
      exempt = JSON.parse(readFileSync(exPath, "utf8")).exempt ?? [];
    } catch (e) {
      errors.push(`${PARENT_EXEMPT_REL} 不是合法 JSON：${e.message}`);
    }
  }
  // ── R252：**「在某个父段的链里」≠「会被执行」**（方法学 465 的活案例） ──────────
  //
  // 本轮实测到的真实缺口：4 条 race 用例都挂在 `test:guards:selftests`，
  // 而那个父段 **本地 chain 不含、CI 也不直接调**（全仓 0 次提及）
  // ⇒ 旧判据只查 `chainParts` 里有没有父段名 —— **它们全绿通过，但从未被执行**。
  //
  // 新判据分两层：
  //   ① 本地：从 `test:guards:chain` 做**递归可达性分析**（父段可能被间接引用）；
  //   ② CI：`ci.yml` 里是否**真的出现**该用例的 `npm run <npmScript>`（直接执行）。
  // 只要**任一**成立 ⇒ 该用例真的会被跑。
  const chainScripts = scripts["test:guards:chain"] ?? "";
  const localReach = new Set();
  const walkLocal = (name, depth) => {
    if (depth > 8 || localReach.has(name)) return;
    const body = scripts[name];
    if (typeof body !== "string") return;
    localReach.add(name);
    for (const m of body.matchAll(/npm run ([\w:-]+)/g)) walkLocal(m[1], depth + 1);
  };
  walkLocal("test:guards:chain", 0);

  const ciDir = join(root, ".github", "workflows");
  let ciText = "";
  if (existsSync(ciDir)) {
    for (const f of readdirSync(ciDir)) {
      if (/\.ya?ml$/.test(f)) ciText += readFileSync(join(ciDir, f), "utf8");
    }
  }

  /** 某条用例是否**真的**会被执行（本地可达 或 CI 直接调）。 */
  const reallyExecuted = (entry) => {
    if (localReach.has(entry.npmScript)) return "局部链可达";
    if (new RegExp(`npm run ${entry.npmScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(ciText)) {
      return "CI 直接调用";
    }
    return null;
  };

  // ── 逐条判「真的会被跑」──────────────────────────────────────────────────
  for (const entry of REQUIRED_RACE_SELFTESTS) {
    const how = reallyExecuted(entry);
    if (how) {
      printed.push(`${entry.id}：会执行（${how}）`);
      continue;
    }
    const ex = exempt.find((x) => x.script === entry.npmScript);
    if (ex && ex.why && String(ex.why).length >= 12) {
      printed.push(
        `${entry.id}：**不执行，显式豁免**：${ex.why}（复核：${ex.reviewBy ?? "未定"}）`,
      );
      continue;
    }
    errors.push(
      `${entry.id}（\`${entry.npmScript}\`）**没有任何真实执行入口** —— ` +
        `本地 \`test:guards:chain\` 递归可达里没有它，\`ci.yml\` 也没直接调它。` +
        `它挂在 \`${entry.chain}\`，而那个段本身**可能从未被执行**（R252 实测：该段两边都不跑）。` +
        `处置：① 把 \`npm run ${entry.npmScript}\` 加进 \`test:guards:chain\` 或 \`ci.yml\`；` +
        `② 或在 ${PARENT_EXEMPT_REL} 里按 **npmScript** 登记豁免（why ≥12 字 + reviewBy）。`,
    );
  }

  const parents = [...new Set(REQUIRED_RACE_SELFTESTS.map((e) => e.chain).filter(Boolean))];
  for (const parent of parents) {
    const runsInChain = chainParts.some((part) => part.includes(`npm run ${parent}`) || part.includes(parent));
    if (runsInChain) continue;
    const ex = exempt.find((x) => x.script === parent);
    if (ex) {
      if (!ex.why || String(ex.why).length < 12) {
        errors.push(`豁免条目 ${parent} 的 why 太短（需 ≥12 字）`);
      } else {
        // R246（→ 460）：**理由里的数量断言必须可重跑**。
        //
        // 病（R245 实测）：本条豁免从 R106 起挂着，理由写「20/20 轮违反 oversell」。
        // 缺陷在 `80e45a3b` 就修好了（实测 0/20），但**没有任何机制会去重测那个数字** ——
        // `reviewBy` 只问「还需不需要豁免」，不问「那个数字还成不成立」。
        // 于是它安静地挡住了 4 条健康用例十余轮。
        //
        // 判据（**不需要时钟即可判定**）：`why` 里若出现数量断言
        // （`N/M 轮`、`N 次中 M 次`、`N%` 等），就必须带 `evidence`：
        //   · `evidence.command`：能**重跑出那个数字**的 npm script，
        //     且该 script **必须真的存在于 package.json**（拼错 = 红，防止写成一句愿望）；
        //   · `evidence.checkedAt`：那次实测的日期（YYYY-MM-DD）。
        // 没有数量断言的 `why`（纯定性理由）不要求 evidence。
        const numeric = /\d+\s*\/\s*\d+\s*轮|\d+\s*次中\s*\d+\s*次|\d+\s*%|≈\s*\d+\s*%/.test(
          String(ex.why),
        );
        if (numeric) {
          const ev = ex.evidence;
          if (!ev || typeof ev !== "object") {
            errors.push(
              `豁免条目 ${parent} 的 why 含**数量断言**，但没有 evidence —— ` +
                `这种理由会随时间腐坏（R245 实测：写着「20/20 轮违反」，实际早已 0/20）。` +
                `请加 evidence: { command: "npm run <真实脚本>", checkedAt: "YYYY-MM-DD" }`,
            );
          } else {
            const cmd = String(ev.command ?? "");
            const m = /^npm run ([\w:-]+)$/.exec(cmd.trim());
            if (!m) {
              errors.push(
                `豁免条目 ${parent} 的 evidence.command 必须是 \`npm run <脚本>\` 形态（当前：${JSON.stringify(cmd)}）` +
                  ` —— 它要能让下一个人**照着重跑**那个数字`,
              );
            } else if (!(m[1] in scripts)) {
              errors.push(
                `豁免条目 ${parent} 的 evidence.command 指向的 \`${m[1]}\` **在 package.json 里不存在** ` +
                  `⇒ 那个数字无法被重跑（拼错的命令等于一句愿望）`,
              );
            }
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ev.checkedAt ?? ""))) {
              errors.push(
                `豁免条目 ${parent} 的 evidence.checkedAt 必须是 YYYY-MM-DD（当前：${JSON.stringify(ev.checkedAt)}）`,
              );
            }
          }
        }
        if (!errors.some((e) => e.includes(parent))) {
          const evHint = ex.evidence?.command
            ? `；重跑：${ex.evidence.command}（实测于 ${ex.evidence.checkedAt}）`
            : "";
          printed.push(
            `${parent} 未进链，**显式豁免**：${ex.why}（复核：${ex.reviewBy ?? "未定"}${evHint}）`,
          );
        }
      }
      continue;
    }
    errors.push(
      `${parent} **不在 test:guards:chain 里** ⇒ 你对它的接线断言等于**空转**` +
        `（把真机用例挂到一条从不执行的命令上，链却显示全绿）。` +
        `处置：把该父脚本接进链，或在 ${PARENT_EXEMPT_REL} 里显式豁免（why ≥12 字 + reviewBy）`,
    );
  }
  return { errors, printed };
}

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
  // R106：先验「父脚本真的会被链执行」，否则后续接线断言都是空转
  const parentCheck = checkParentChainWiring(root);
  for (const line of parentCheck.printed ?? []) console.log(`（父脚本接线：${line}）`);
  if ((parentCheck.errors ?? []).length > 0) return parentCheck.errors;
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
    // R106：夹具也要满足「父脚本必须真的会被链执行」，否则本守卫的新判据会把夹具判红（R49 教训：加断言必须同步夹具）
    "test:guards:chain": "npm run test:guards:selftests",
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

  push("反例①：链里删掉引用 ⇒ exit 1 且点名「没有任何真实执行入口」", () => {
    const scripts = fixtureScripts({
      "test:guards:selftests": "npm run test:executor-register-race",
    });
    const repo = makeFixtureRepo(fixtureTree({ scripts }));
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["test:executor-token-idempotency", "没有任何真实执行入口"],
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
        contains: ["test:executor-token-idempotency"],
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

  // ── R246（→ 460）：豁免理由里的**数量断言必须可重跑** ─────────────────────
  // 这三条反例守的不是「有没有豁免」，而是「豁免的理由还能不能被复现」。
  const exemptFixture = (why, evidence) => {
    // 只覆盖**父脚本的链**（让它「未进链」），selftests 段保持完整 ——
    // 否则 4 条 race 用例会因「selftests 链里没有它们」而先红，掩盖本条判据的观察对象。
    // 正例里引用的 `test:arch31-multi-instance` 必须在夹具的 package.json 里存在
    // （否则 evidence 判据会红 —— 这正是它该做的事）。
    const scripts = fixtureScripts({
      "test:guards:chain": "npm run something-else",
      "test:arch31-multi-instance": "node scripts/arch31-multi-instance-selftest.mjs",
    });
    // ⚠️ R252：新判据要求每条用例有**真实执行入口**（本地链递归 或 CI 直调）。
    // 本夹具故意让父段「未进链」，所以必须在 `ci.yml` 里给出这 4 条的直调，
    // 否则它们会因「没有任何真实执行入口」先红，掩盖本条判据的观察对象。
    const files = fixtureTree({ scripts });
    files[".github/workflows/ci.yml"] =
      REQUIRED_RACE_SELFTESTS.map((e) => `run: npm run ${e.npmScript}\n`).join("");
    const repo = makeFixtureRepo(files);
    const exPath = join(repo.dir, PARENT_EXEMPT_REL);
    const body = { exempt: [{ script: "test:guards:selftests", why, reviewBy: "2026-12-31" }] };
    if (evidence !== undefined) body.exempt[0].evidence = evidence;
    mkdirSync(dirname(exPath), { recursive: true });
    writeFileSync(exPath, JSON.stringify(body, null, 2));
    return repo;
  };

  push("反例⑤：why 含数量断言但**没有 evidence** ⇒ exit 1（理由会腐坏）", () => {
    const repo = exemptFixture("arch31 槽位断言偶发，实测 6 次中 1 次失败，需先有样本再改");
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["数量断言", "evidence"],
        withinMs: 20000,
        label: "缺 evidence",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例⑥：evidence.command 指向**不存在的 npm script** ⇒ exit 1（拼错=愿望）", () => {
    const repo = exemptFixture("arch31 槽位断言偶发（≈17%），需先有样本再改", {
      command: "npm run test:does-not-exist",
      checkedAt: "2026-11-18",
    });
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["不存在", "无法被重跑"],
        withinMs: 20000,
        label: "命令不存在",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("正例：数量断言 + 合法 evidence ⇒ exit 0，且**打印重跑命令**（触发信号）", () => {
    const repo = exemptFixture("arch31 槽位断言偶发（≈17%），需先有样本再改", {
      command: "npm run test:arch31-multi-instance",
      checkedAt: "2026-11-18",
    });
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 0,
        contains: ["重跑：npm run test:arch31-multi-instance"],
        withinMs: 20000,
        label: "带 evidence",
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
