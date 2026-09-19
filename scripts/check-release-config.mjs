#!/usr/bin/env node
/**
 * 发布配置一致性守卫（改名发布 @autocodeflow/cli 时新增）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * 本仓的发版链路跨了**四份互不校验的配置**，任一处漏配都不会报错，只会让
 * 某个包静默地永远发不出去或永远不 bump 版本：
 *
 *   release-please-config.json   packages（谁被管理）+ linked-versions（谁参与 lockstep）
 *   .github/workflows/release.yml  version-guard（谁被校验）+ publish-npm 矩阵（谁被发布）
 *
 * **真实缺陷（本轮实际踩到）**：`packages/acf-cli` 早在 a4dad9b 就写进了
 * release-please 的 `packages`，却**没进** `linked-versions.components`——
 * 于是它被 release-please 管着、却永远不参与 lockstep 版本提升，卡在 `1.0.0`
 * 纹丝不动；同时它也不在 publish-npm 矩阵里（因为包名被 npm 第三方占用），
 * 所以**从来没有被发布过**，而仓库里没有任何东西会为此报警。
 * 这类"配置写了一半"的缺陷，只会在真正要发版的那一天才暴露。
 *
 * ── 四层一致性（本守卫逐层校验）────────────────────────────────────────
 *  ① release-please 的每个 `packages[*].component` 都必须在
 *     `linked-versions.components` 里——否则该包游离在 lockstep 之外。
 *  ② publish-npm 矩阵里每个 `dir` 都必须是被 release-please 管理的包
 *     ——否则发了不该发的包（或矩阵里的路径写错，`npm ci` 才报错）。
 *  ③ version-guard 必须校验矩阵里**每个**待发布包的版本号
 *     ——否则"tag 版本 == 包版本"这条闸对这个包是空的，可能发出编号不符的包。
 *  ④ lockstep 组内所有包的当前版本必须**已经一致**
 *     ——不一致时 version-guard 会在 tag 那一刻才失败（发布被拦），
 *       但那已经是"准备发版"的时刻了；本守卫让问题在 PR 阶段就可见。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   node scripts/check-release-config.mjs            # 校验
 *   node scripts/check-release-config.mjs --selftest # 自测（含反例，证明有牙）
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function findRepoRoot(startDir = HERE) {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(join(dir, "release-please-config.json"), "utf-8");
      return dir;
    } catch {
      /* 继续上溯 */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("找不到仓库根（未找到 release-please-config.json）");
}

/** 从 package.json / pyproject.toml 读版本号（与 release.yml 的 version-guard 同源逻辑）。 */
export function readVersion(root, relDir) {
  const pkgPath = join(root, relDir, "package.json");
  try {
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version;
  } catch {
    /* 不是 node 包，试 pyproject */
  }
  const py = readFileSync(join(root, relDir, "pyproject.toml"), "utf-8");
  const sec = py.split("[project]", 1)[1];
  const m = /^version\s*=\s*"([^"]+)"/m.exec(sec ?? "");
  if (!m) throw new Error(`${relDir} 读不到版本号`);
  return m[1];
}

/**
 * 从 release.yml 里解析 publish-npm 矩阵与 version-guard 的校验清单。
 *
 * 正则而非 YAML 解析：本仓守卫一律零依赖（无 js-yaml），且这里只需要
 * 「矩阵里的 dir/pkg 对」与「version-guard 里出现的包路径」两组事实。
 */
export function parseReleaseWorkflow(text) {
  const matrix = [];
  const matrixStart = text.indexOf("publish-npm:");
  if (matrixStart === -1) throw new Error("release.yml 找不到 publish-npm job");
  // 矩阵段：从 `include:` 到下一个同缩进的 `steps:`
  const seg = text.slice(matrixStart);
  const includeIdx = seg.indexOf("include:");
  const stepsIdx = seg.indexOf("steps:", includeIdx);
  const matrixSeg = seg.slice(includeIdx, stepsIdx === -1 ? undefined : stepsIdx);
  for (const m of matrixSeg.matchAll(
    /-\s*dir:\s*(\S+)\s*\n\s*pkg:\s*['"]?([^'"\n]+)['"]?/g,
  )) {
    matrix.push({ dir: m[1].trim(), pkg: m[2].trim() });
  }
  // version-guard 段：抓 pkg_json_version("...") / pyproject_version("...") 的路径
  const guardStart = text.indexOf("version-guard:");
  const guardEnd = text.indexOf("publish-npm:", guardStart);
  const guardSeg = text.slice(guardStart, guardEnd === -1 ? undefined : guardEnd);
  const guardedDirs = new Set();
  for (const m of guardSeg.matchAll(
    /(?:pkg_json_version|pyproject_version)\(\s*"([^"]+)"/g,
  )) {
    // "packages/x/package.json" 或 "packages/x/pyproject.toml" → packages/x
    guardedDirs.add(m[1].replace(/\/(package\.json|pyproject\.toml)$/, ""));
  }
  return { matrix, guardedDirs };
}

/** 纯函数：给定事实，返回问题清单（便于 selftest 直接喂构造数据）。 */
export function checkReleaseConfig({ rpConfig, matrix, guardedDirs, versions }) {
  const problems = [];

  const linked = new Set(rpConfig.plugins?.[0]?.components ?? []);
  const packages = rpConfig.packages ?? {};
  const components = Object.entries(packages).map(([dir, v]) => ({
    dir,
    component: v.component,
  }));

  // ① packages 里的 component 必须都进 linked-versions
  for (const { dir, component } of components) {
    if (!component) {
      problems.push(`① ${dir} 未声明 component`);
      continue;
    }
    if (!linked.has(component)) {
      problems.push(
        `① ${dir} 的 component "${component}" 不在 linked-versions.components 里`
          + `——该包会被 release-please 管理却永远不参与 lockstep 版本提升`,
      );
    }
  }

  // ② 矩阵里的 dir 必须是被管理的包
  const managedDirs = new Set(components.map((c) => c.dir));
  for (const { dir, pkg } of matrix) {
    if (!managedDirs.has(dir)) {
      problems.push(`② publish-npm 矩阵的 ${dir}（${pkg}）不在 release-please packages 里`);
    }
  }

  // ③ 矩阵里每个待发布包都必须在 version-guard 校验清单里
  for (const { dir, pkg } of matrix) {
    if (!guardedDirs.has(dir)) {
      problems.push(
        `③ ${pkg}（${dir}）不在 version-guard 校验清单里`
          + `——「tag 版本 == 包版本」这条闸对它形同虚设，可能发出编号不符的包`,
      );
    }
  }

  // ④ lockstep 组内版本必须已一致
  const linkedVersions = components
    .filter((c) => linked.has(c.component))
    .map((c) => ({ component: c.component, version: versions[c.dir] }))
    .filter((v) => v.version !== undefined);
  const uniq = [...new Set(linkedVersions.map((v) => v.version))];
  if (uniq.length > 1) {
    problems.push(
      `④ lockstep 组内版本不一致：`
        + linkedVersions.map((v) => `${v.component}=${v.version}`).join(", ")
        + `——version-guard 会在 tag 那一刻拦下发布`,
    );
  }

  return problems;
}

export function checkRepo(root = findRepoRoot()) {
  const rpConfig = JSON.parse(
    readFileSync(join(root, "release-please-config.json"), "utf-8"),
  );
  const wf = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf-8");
  const { matrix, guardedDirs } = parseReleaseWorkflow(wf);
  const versions = {};
  for (const dir of Object.keys(rpConfig.packages ?? {})) {
    try {
      versions[dir] = readVersion(root, dir);
    } catch {
      /* 读不到就跳过 ④ 对该包的比对 */
    }
  }
  return { problems: checkReleaseConfig({ rpConfig, matrix, guardedDirs, versions }), matrix, versions };
}

/** 自测：每个断言都带**反例**，证明守卫真的能发现问题（有牙）。 */
export function selftest() {
  const baseRp = {
    plugins: [{ components: ["a", "b"] }],
    packages: { "packages/one": { component: "a" }, "packages/two": { component: "b" } },
  };
  const baseMatrix = [
    { dir: "packages/one", pkg: "@x/one" },
    { dir: "packages/two", pkg: "@x/two" },
  ];
  const baseGuarded = new Set(["packages/one", "packages/two"]);
  const baseVersions = { "packages/one": "1.0.0", "packages/two": "1.0.0" };
  const run = (over = {}) =>
    checkReleaseConfig({
      rpConfig: over.rpConfig ?? baseRp,
      matrix: over.matrix ?? baseMatrix,
      guardedDirs: over.guardedDirs ?? baseGuarded,
      versions: over.versions ?? baseVersions,
    });

  const cases = [
    ["基线全绿", run(), 0],
    [
      "① component 漏进 linked-versions 被抓",
      run({ rpConfig: { ...baseRp, plugins: [{ components: ["a"] }] } }),
      1,
    ],
    [
      // 注意期望是 2：一个未受管的包会**同时**触发 ②（矩阵不该发它）与
      // ③（它没被 version-guard 校验）。两条都成立、都不是误报——这条用例
      // 本身就是"检查项之间会叠加"的说明。
      "② 矩阵里有未受管的包被抓（同时触发 ③，共 2 条）",
      run({ matrix: [...baseMatrix, { dir: "packages/three", pkg: "@x/three" }] }),
      2,
    ],
    [
      "③ 待发布包不在 version-guard 里被抓",
      run({ guardedDirs: new Set(["packages/one"]) }),
      1,
    ],
    [
      "④ lockstep 版本不一致被抓",
      run({ versions: { "packages/one": "1.0.0", "packages/two": "1.0.1" } }),
      1,
    ],
  ];

  let failed = 0;
  for (const [name, problems, want] of cases) {
    const ok = problems.length === want;
    if (!ok) failed++;
    console.log(`${ok ? "OK " : "BAD"}  ${name}（问题数 ${problems.length}，期望 ${want}）`);
    for (const p of problems) console.log(`       ${p}`);
  }
  if (failed) throw new Error(`selftest 失败：${failed} 个用例不符合预期`);
  console.log("release-config guard selftest: all assertions passed（含 4 个反例）");
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const { problems, matrix, versions } = checkRepo();
    console.log(
      `release 配置：${matrix.length} 个待发布 npm 包 `
        + `(${matrix.map((m) => m.pkg).join(", ")})`,
    );
    for (const [dir, v] of Object.entries(versions)) console.log(`  ${dir} = ${v}`);
    if (problems.length) {
      console.error("\n发布配置一致性问题：");
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log("release-config guard OK：四层一致性（lockstep 覆盖 / 矩阵受管 / 版本受校验 / 版本已对齐）全部通过");
  }
}
