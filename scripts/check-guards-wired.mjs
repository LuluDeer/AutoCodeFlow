#!/usr/bin/env node
/**
 * 「守卫必须被 CI 跑到」的自检 —— 防「加了守卫，但没人跑它」。
 *
 * 由来：这个仓库现在有 30+ 个 `scripts/check-*.mjs`。加一个守卫很便宜，**接进 CI 才是让它生效的那一步**，
 * 而漏接是**完全静默**的：脚本存在、本地能跑、README 里可能还写着它，但 CI 从不执行 —— 于是它保护不了
 * 任何东西。这与「测试写了但没被 include」是同一类失败（本仓踩过：`.spec.ts` 放错目录不被收集）。
 *
 * 判据（对 scripts 下每个 check- 开头的 .mjs，排除 .selftest.mjs）：
 *   ① 文件名出现在任一 `.github/workflows/*.yml` 里；**或**
 *   ② 文件名出现在 package.json 的某个 script 里，且**那个 script 名**出现在任一 workflow 里
 *      （CI 常写 `npm run check:xxx`，不直接写文件名 —— 不解析这层间接就会误报）。
 *
 * 例外：`node scripts/...` 与 `npm run ...` 之外还有「被别的脚本内联调用」的情形，本判据不覆盖；
 * 那类脚本请显式加进 ALLOWLIST 并写明理由。
 *
 * ## 扫描面（2026-10-28 扩）：根 scripts/ + apps/<pkg>/scripts/ + packages/<pkg>/scripts/
 *
 * 原实现只扫根 `scripts/`。子项目的守卫（如 admin-api 的
 * `apps/admin-api/scripts/check-route-authz-matrix.mjs`）因此**完全不在判据内**：
 * 新增一个子项目级守卫，本闸不会提任何要求——正是「脚本存在但没人跑」的同一种
 * 静默失败，只是换了个目录。现在三处都扫；子项目守卫若由该包的 jest/pytest
 * 收集面覆盖，走 ALLOWLIST 显式说明（豁免必须写明为什么「已经有人跑」）。
 *
 * 用法：node scripts/check-guards-wired.mjs
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** 只报告、或按需手动跑的脚本（显式列出，每条给理由）。 */
const ALLOWLIST = {
  "scripts/report-sibling-implementations.mjs": "只报告（雷达），刻意不进 CI —— 它不产生红/绿判定",
  // 本脚本是「让那条 spec 在任意入口一把跑完」的 CLI 外壳；**判据本体**
  // （route-authz-matrix.spec.ts）位于 admin-api 的 src/**/__tests__ 下，已被
  // CI 的 admin-api test job（jest --shard）作为普通 spec 收集执行——矩阵本身
  // 不是「没人跑」，只是没通过本外壳跑。--selftest 的可读输出留给本地/排障用。
  "apps/admin-api/scripts/check-route-authz-matrix.mjs":
    "判据本体 route-authz-matrix.spec.ts 已被 admin-api jest job 收集；本文件只是 CLI 外壳",
};

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".venv") continue;
      walk(p, out);
    } else if (/^check-.*\.mjs$/.test(e.name) && !/\.selftest\.mjs$/.test(e.name)) {
      out.push(p);
    }
  }
}

const guards = [];
walk(join(ROOT, "scripts"), guards);
// 子项目守卫（apps/<pkg>/scripts、packages/<pkg>/scripts）：同样适用「存在 ≠ 在链路里」。
for (const group of ["apps", "packages"]) {
  let children = [];
  try {
    children = readdirSync(join(ROOT, group), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    continue;
  }
  for (const child of children) walk(join(ROOT, group, child, "scripts"), guards);
}
if (guards.length === 0) {
  console.error("✖ 一个守卫脚本都没扫到 —— 路径或正则失效了。");
  process.exit(1);
}
// 规模下界：扫描面收窄（目录改名/正则失效）时不能静默变成「零个守卫全绿」。
if (guards.length < 20) {
  console.error("✖ 只扫到 " + guards.length + " 个守卫 —— 明显少于历史规模（37+），扫描面可能失效。");
  process.exit(1);
}

const wfDir = join(ROOT, ".github", "workflows");
const workflows = readdirSync(wfDir)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((f) => readFileSync(join(wfDir, f), "utf8"))
  .join("\n");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const scripts = pkg.scripts ?? {};

const problems = [];
for (const abs of guards) {
  const rel = abs.slice(ROOT.length + 1).split("\\").join("/");
  if (ALLOWLIST[rel]) continue;
  const base = rel.split("/").pop();

  if (workflows.includes(base)) continue;

  const invoking = Object.entries(scripts).filter(([, cmd]) =>
    String(cmd).includes(base),
  );
  // CI 常写 `npm run check:xxx`；直接子串匹配 script 名即可，不必构造正则。
  const wiredViaNpm = invoking.some(([name]) => workflows.includes("npm run " + name));
  if (wiredViaNpm) continue;

  problems.push({ rel, invoking: invoking.map(([n]) => n) });
}

if (problems.length > 0) {
  console.error("");
  console.error("✖ " + problems.length + " 个守卫**没有被任何 CI workflow 执行**：");
  for (const p of problems) {
    console.error("  · " + p.rel);
    if (p.invoking.length > 0) {
      console.error("    （package.json 里有 " + p.invoking.join(", ") + "，但 workflow 没调用它）");
    } else {
      console.error("    （package.json 里也没有脚本包装它）");
    }
  }
  console.error("");
  console.error("  修法：把它接进 .github/workflows/ci.yml（直接 node scripts/… 或 npm run check:…）。");
  console.error("  若它本就只报告、不该产生红绿判定，加进本脚本的 ALLOWLIST 并写明理由。");
  process.exit(1);
}

console.log(
  "✔ 守卫接线自检通过：" + (guards.length - Object.keys(ALLOWLIST).length) + " 个 check-*.mjs 全部被 CI 执行" +
    "（另有 " + Object.keys(ALLOWLIST).length + " 个显式豁免）。",
);
