/**
 * check-admin-api-lock-consistency.mjs —— admin-api manifest ↔ lock 根声明一致性守卫。
 *
 * 事故（CI run 46136854131）：commit 8372175d 只把 apps/admin-api/package.json 的
 * typescript 从 ^6.0.3 改到 ^5.9.3，package-lock.json 的 packages[""].devDependencies.typescript
 * 仍是 ^6.0.3。CI 解析 ^12.0.12 拿到 @nestjs/schematics@12.0.17（peer typescript@^6.0.0），
 * `npm ci` 在 manifest 与 lock 根声明漂移时按 manifest 重解析 peer ⇒ ERESOLVE，
 * 11 个 job 红灯。修法是把 manifest 统一回 ^6.0.3（>=6），并用本守卫钉住不变量。
 *
 * 判据（零依赖、离线、秒级）：
 *   ① 结构：两个文件存在、是合法 JSON、两侧 devDependencies.typescript 都是非空字符串；
 *      任一不成立 ⇒ exit 1（结构红，不许静默绿）。
 *   ② 漂移：manifest 声明 !== lock 根声明 ⇒ exit 1。
 *   ③ 下界：manifest 声明的主版本 < 6 ⇒ exit 1（否则两侧一起回退到 ^5.9.3 也会过）。
 * 两条红都点名两侧真实值，修法可直接照抄：统一到 ^6.0.3。
 *
 * --selftest：真子进程夹具（makeFixtureRepo + runGuard），含正例控制组与真仓库基线。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const REPO_ROOT = resolve(HERE, "..");

export const MANIFEST_REL = "apps/admin-api/package.json";
export const LOCK_REL = "apps/admin-api/package-lock.json";
export const MIN_TS_MAJOR = 6;

/** 与仓库其它守卫同形：`--root <dir>` / `--root=<dir>` 只在自检里换夹具树。 */
export function argRoot(argv, fallback = REPO_ROOT) {
  const eq = argv.find((a) => a.startsWith("--root="));
  if (eq) return resolve(eq.slice("--root=".length));
  const at = argv.indexOf("--root");
  if (at >= 0) return resolve(argv[at + 1] ?? fallback);
  return fallback;
}

/** 从声明里取主版本；解析不出返回 null（调用方判结构红，不猜）。 */
export function majorOf(decl) {
  const m = /^\s*[\^~>=]*\s*(\d+)\.(\d+)\.(\d+)/.exec(String(decl ?? ""));
  return m ? Number(m[1]) : null;
}

/** 读两侧声明；任何读不到 / 解析不出都进 problems（fail-closed）。 */
export function readDeclarations(root) {
  const problems = [];
  const manifestPath = resolve(root, MANIFEST_REL);
  const lockPath = resolve(root, LOCK_REL);
  if (!existsSync(manifestPath)) problems.push(`结构红：读不到 ${MANIFEST_REL}`);
  if (!existsSync(lockPath)) problems.push(`结构红：读不到 ${LOCK_REL}`);
  if (problems.length) return { problems };

  let manifest;
  let lock;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    problems.push(`结构红：${MANIFEST_REL} 不是合法 JSON（${e.message}）`);
  }
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (e) {
    problems.push(`结构红：${LOCK_REL} 不是合法 JSON（${e.message}）`);
  }
  if (problems.length) return { problems };

  const manifestDecl = manifest?.devDependencies?.typescript;
  const lockDecl = lock?.packages?.[""]?.devDependencies?.typescript;
  if (typeof manifestDecl !== "string" || manifestDecl.trim() === "") {
    problems.push(`结构红：${MANIFEST_REL} 的 devDependencies.typescript 缺失/不是非空字符串`);
  }
  if (typeof lockDecl !== "string" || lockDecl.trim() === "") {
    problems.push(`结构红：${LOCK_REL} 的 packages[""].devDependencies.typescript 缺失/不是非空字符串`);
  }
  return { problems, manifestDecl, lockDecl };
}

/** 主判据：返回 { problems, facts }。 */
export function check(root) {
  const { problems, manifestDecl, lockDecl } = readDeclarations(root);
  if (problems.length) return { problems, facts: [] };

  const facts = [
    `${MANIFEST_REL}: devDependencies.typescript = ${manifestDecl}`,
    `${LOCK_REL}: packages[""].devDependencies.typescript = ${lockDecl}`,
  ];

  if (manifestDecl !== lockDecl) {
    problems.push(
      `manifest↔lock 根 TypeScript 声明不一致：${manifestDecl} ≠ ${lockDecl} —— ` +
        `npm ci 会按 manifest 重解析 peer；@nestjs/schematics@12.0.17 的 peer typescript@^6.0.0 ` +
        `与之冲突即 ERESOLVE（CI run 46136854131）。两侧统一到 ^6.0.3。`,
    );
  }
  const major = majorOf(manifestDecl);
  if (major === null) {
    problems.push(`结构红：无法从 manifest 声明解析主版本：${manifestDecl}`);
  } else if (major < MIN_TS_MAJOR) {
    problems.push(
      `manifest typescript=${manifestDecl} 主版本 ${major} < ${MIN_TS_MAJOR} —— ` +
        `@nestjs/schematics@^12.0.12 最新版（12.0.17）的 peer 要 typescript@^6.0.0；` +
        `两侧一起降到 ^5.x 也会让 npm ci ERESOLVE。`,
    );
  }
  return { problems, facts };
}

/** 真子进程夹具：每例都构造独立临时仓库树，子进程跑本守卫主流程。 */
export function selftest() {
  const fixture = (manifestDecl, lockDecl) => ({
    [MANIFEST_REL]: { devDependencies: { typescript: manifestDecl } },
    [LOCK_REL]: { packages: { "": { devDependencies: { typescript: lockDecl } } } },
  });
  const cases = [];
  const ok = (name, files, expectations) => {
    cases.push({
      name,
      fn() {
        const repo = makeFixtureRepo(files, { prefix: "admin-api-lock-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expectations,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  ok("① 一致且 >=6 → 绿（正例控制组）", fixture("^6.0.3", "^6.0.3"), {
    code: 0,
    contains: ["manifest↔lock TypeScript 声明一致且 >=6"],
  });
  ok("② manifest ^5.9.3 / lock ^6.0.3（run 46136854131 形态）→ 红", fixture("^5.9.3", "^6.0.3"), {
    code: 1,
    contains: ["不一致", "^5.9.3", "^6.0.3"],
  });
  ok("③ manifest ^6.0.3 / lock ^5.9.3（反向漂移）→ 红", fixture("^6.0.3", "^5.9.3"), {
    code: 1,
    contains: ["不一致", "^5.9.3", "^6.0.3"],
  });
  ok("④ 两侧一起 ^5.9.3（假一致）→ 红", fixture("^5.9.3", "^5.9.3"), {
    code: 1,
    contains: ["主版本 5", "6"],
  });
  ok(
    "⑤ manifest 缺 devDependencies.typescript → 结构红",
    { [MANIFEST_REL]: { devDependencies: {} }, [LOCK_REL]: { packages: { "": { devDependencies: { typescript: "^6.0.3" } } } } },
    { code: 1, contains: ["结构红", "manifest"] },
  );
  ok(
    "⑥ lock 文件缺失 → 结构红（不许静默绿）",
    { [MANIFEST_REL]: { devDependencies: { typescript: "^6.0.3" } } },
    { code: 1, contains: ["结构红", LOCK_REL] },
  );
  cases.push({
    name: "⑦ 真仓库基线（当前工作树已修复）→ 绿",
    fn() {
      expectExit(runGuard(SELF, { args: [] }), {
        code: 0,
        contains: ["manifest↔lock TypeScript 声明一致且 >=6"],
        label: "真仓库基线",
      });
    },
  });

  const failed = reportCases(cases, { title: "check-admin-api-lock-consistency selftest" });
  return failed;
}

function main(argv) {
  if (argv.includes("--selftest")) return selftest();

  const root = argRoot(argv);
  const { problems, facts } = check(root);
  for (const line of facts) console.log(`  · ${line}`);
  if (problems.length > 0) {
    console.error("✖ admin-api manifest↔lock TypeScript 声明守卫未通过");
    for (const line of problems) console.error(`  ✘ ${line}`);
    return 1;
  }
  console.log("✔ admin-api manifest↔lock TypeScript 声明一致且 >=6 —— npm ci peer 解析安全");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
