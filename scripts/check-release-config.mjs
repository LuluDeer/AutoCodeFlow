#!/usr/bin/env node
/**
 * 发布配置一致性守卫。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * 本仓的发版链路跨了**四份互不校验的配置**，任一处漏配都不会报错，只会让
 * 某个包静默地永远发不出去或永远不 bump 版本：
 *
 *   release-please-config.json     packages（谁被管理）+ plugins（lockstep 组）
 *   release-please-manifest.json   各 path 的「上次发到哪」基线
 *   .github/workflows/release.yml  version-guard（谁被校验）+ publish 矩阵（谁被发布）
 *
 * ── 五层一致性（本守卫逐层校验）────────────────────────────────────────
 *  ① 版本广播面完整：root 条目（`.`）的 `extra-files` 必须覆盖**每一个**
 *     版本承载文件（三个 npm 包的 package.json + package-lock.json 双 slot、
 *     pyproject.toml、py SDK `__init__.py`、docs-site 五页、docs/sdk-guide.md）
 *     ——漏一处即该文件在 Release PR 里不更新，tag 后 version-guard 或
 *     docs-site sync-check 才红。
 *  ② publish-npm 矩阵里每个 `dir` 都必须被版本广播面覆盖
 *     ——否则发了版本号没被 bump 的包（发错编号）。
 *  ③ version-guard 必须校验矩阵里**每个**待发布包的版本号
 *     ——否则「tag 版本 == 包版本」这条闸对该包是空的。
 *  ④ lockstep 版本事实源必须已一致
 *     ——不一致时 version-guard 会在 tag 那一刻才失败，本守卫让它在 PR 阶段可见。
 *  ⑤ release-please-config.json 的 `packages` 与 release-please-manifest.json
 *     的键必须**一一对应**——manifest 是基线，缺条目即基线丢失（版本倒退）。
 *
 * ── 为什么改掉了「packages 每包一个条目 + 顶层 linked-versions」的旧形态 ──
 * 2026-10 实测（release-please 17.6.0，即 release-please-action v5.0.0 内置版本）
 * 的三条硬事实，旧形态对本仓**结构性不可用**：
 *
 *   1. `linked-versions` 是 **plugin**，只能写在 `plugins` 数组里。旧配置把它
 *      写成顶层键——schema 根是 `additionalProperties: false` 且不含该键，
 *      `manifest.js` 只读 `config['plugins']`，于是该键被**静默丢弃**（无任何
 *      报错）。实测 `Manifest.fromManifest` 加载到的 plugins 数量为 0。
 *   2. 即便写进 `plugins`，本仓也**修不好**：`linked-versions.preconfigure()`
 *      用 `strategy.getComponent()` 匹配组员，而 `include-component-in-tag:
 *      false` 时 `BaseStrategy.getComponent()` 恒返回 `''`
 *      （`base.js`：「if (!this.includeComponentInTag) return ''」），
 *      组员匹配直接 `continue` 跳过 → 版本统一**永不执行**（实测日志
 *      「Found 0 group components」）。而同一个开关又控制 tag 命名
 *      （`base.js` 的 `new TagName(..., this.includeComponentInTag ? component
 *      : undefined, ...)`），打开它 tag 就变成 `pkg-vX.Y.Z`，与 release.yml 的
 *      `v*` 触发器和 version-guard 的 `v(\d+\.\d+\.\d+)` 正则不再匹配。
 *      ⇒ 裸 tag 与 linked-versions 在本仓**不可兼得**。上游 issue #1750
 *      （2022-11 报，2024-08 关闭且无修复提交）即此问题，修复 PR #1749 至今未合。
 *   3. 更隐蔽的一条：`manifest.js` 的 `getPathsByComponent()` 以
 *      `getComponent()` 的返回值为键建立「tag component → path」映射。当每包
 *      component 都是 `''` 时，**八个包塌缩成同一个键 `''`**，最后一个包胜出。
 *      于是基线解析（`release.js`）把裸 tag `v1.9.0` 映射到最后一个包
 *      （`autocodeflow-notify`，基线 0.2.2）并因版本不符而**判定为「找不到
 *      该 release」**——每个版本都要靠 `backfillReleasesFromTag` 兜底。
 *
 * 因此改成 release-please 官方推荐的 lockstep 形态：**单一 root 条目（`.`）
 * 承担整条 1.x 版本线**（`include-component-in-tag: false` → 裸 `vX.Y.Z`），
 * 其余版本文件全部用 `extra-files` 广播；py-libs 四包保留 `linked-versions`
 * 组（写进 `plugins`）并**逐包打开 `include-component-in-tag: true`**——
 * 这样既治好了 `getComponent()` 返回 `''` 的根因（组员可匹配），又让它们的
 * tag 变成 `autocodeflow-http-v0.2.2` 形态，**退出 `v*` 命名空间**，不再误触发
 * release.yml（历史实证：PR #29 同时产出 `v1.7.0` 与 `v0.2.2`，后者触发
 * release.yml 并在 version-guard 上失败）。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   node scripts/check-release-config.mjs            # 校验
 *   node scripts/check-release-config.mjs --selftest # 自测（含反例，证明有牙）
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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
  // 注意：不能用 `py.split("[project]", 1)[1]`——limit=1 只保留**第一个**元素，
  // `[1]` 恒为 undefined，正则永远匹配不到 → readVersion 抛错 → ④ 层对所有
  // python 包被静默跳过（本守卫 2026-10 实测踩到的既有缺陷）。
  const sec = py.slice(py.indexOf("[project]"));
  const m = /^version\s*=\s*"([^"]+)"/m.exec(sec);
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

/** root 条目（`.`）——lockstep 单版本线的唯一承担者。 */
export const ROOT_PATH = ".";

/**
 * 从 root 条目的 extra-files 里提取「被广播的仓库相对路径」集合。
 *
 * extra-files 两种形态：字符串（`/a/b.md`、`a/b.py`）与对象（`{type,path,jsonpath}`）。
 * 前导 `/` 表示仓库根相对（`base.js` 的 `addPath()`：root 策略直接去掉前导斜杠），
 * 否则相对**策略路径**；root 策略两者等价，这里统一归一化为仓库相对路径。
 */
export function extraFileTargets(rootPkg) {
  const out = new Set();
  for (const ef of rootPkg?.["extra-files"] ?? []) {
    const p = typeof ef === "object" ? ef?.path : ef;
    if (typeof p !== "string" || !p) continue;
    out.add(p.replace(/^\/+/, ""));
  }
  return out;
}

/** 纯函数：给定事实，返回问题清单（便于 selftest 直接喂构造数据）。 */
export function checkReleaseConfig({ rpConfig, matrix, guardedDirs, versions, manifest, fsFacts }) {
  const problems = [];
  const packages = rpConfig.packages ?? {};
  const rootPkg = packages[ROOT_PATH];

  // ⓪ 形态自检：必须是「root 条目 + plugins 数组里的 linked-versions」形态。
  //    这两条是 2026-10 实证的结构性前提，退化任一条即回到旧缺陷。
  if (!rootPkg) {
    problems.push(
      `⓪ release-please-config.json 缺 root 条目 "${ROOT_PATH}"`
        + `——lockstep 单版本线必须由单一 root 条目承担（多条目 + include-component-in-tag:false`
        + ` 会让 getPathsByComponent() 把全部包塌缩成同一个 '' 键，基线永远解析不到）`,
    );
  }
  const legacyTopLevel = rpConfig["linked-versions"];
  if (legacyTopLevel !== undefined) {
    problems.push(
      `⓪ "linked-versions" 出现在**顶层**——它是 plugin，只能写在 plugins 数组里；`
        + ` 顶层键被 release-please 静默丢弃（schema 根 additionalProperties:false 且不含该键），`
        + ` lockstep 完全不生效`,
    );
  }

  // ① 版本广播面：矩阵里每个待发布包的所有版本承载文件都必须在 extra-files 里
  const targets = extraFileTargets(rootPkg);
  const matrixDirs = matrix.map((m) => m.dir);
  const BROADCAST = [
    "package.json",
    "package-lock.json",   // 顶层 .version
    "package-lock.json",   // packages[""].version（同一文件，需两条 jsonpath）
    "pyproject.toml",
  ];
  for (const dir of matrixDirs) {
    for (const f of BROADCAST) {
      const want = `${dir}/${f}`;
      // npm 包：package.json / package-lock.json；python 包：pyproject.toml
      const isPkgJson = f === "package.json" || f === "package-lock.json";
      const isPy = f === "pyproject.toml";
      const relevant = isPkgJson
        ? matrix.some((m) => m.dir === dir) // 全部矩阵成员都是 npm 包
        : isPy && !matrix.some((m) => m.dir === dir);
      if (!relevant) continue;
      if (!targets.has(want)) {
        problems.push(
          `① ${want} 不在 root 条目的 extra-files 里`
            + `——Release PR 不会 bump 它，tag 后 version-guard 才红`,
        );
      }
    }
  }

  // ①b 二重 jsonpath：package-lock.json 有**两个** version 槽位（顶层 .version 与
  //    packages[""].version）。只写一条会漏掉另一个，npm ci 或守卫读到旧值。
  for (const dir of matrixDirs) {
    const lockEntries = (rootPkg?.["extra-files"] ?? []).filter(
      (ef) => typeof ef === "object" && ef?.path === `/${dir}/package-lock.json`,
    );
    const paths = lockEntries.map((e) => e.jsonpath);
    for (const need of ["$.version", "$.packages[''].version"]) {
      if (!paths.includes(need)) {
        problems.push(
          `① ${dir}/package-lock.json 的 extra-files 缺 jsonpath ${need}`
            + `——lockfile 两个 version 槽位必须各写一条（用 $..version 会连带改写全部依赖版本，禁用）`,
        );
      }
    }
  }

  // ①c 禁止 $..version：实测会改写 lockfile 里全部 165 个依赖版本
  for (const ef of rootPkg?.["extra-files"] ?? []) {
    if (typeof ef === "object" && ef?.jsonpath === "$..version") {
      problems.push(
        `① extra-files 里出现 "$..version"（${ef.path}）`
          + `——递归匹配会改写 package-lock.json 里所有依赖的版本号（实测 165 处），必须改为显式 jsonpath`,
      );
    }
  }

  // ①d extra-files 目标必须真实存在，且 generic 类型必须带
  //    `x-release-please-version` 注解——两者都会**静默失效**：路径写错时
  //    release-please 只打一条 "did not exist" 的 warning 就跳过（版本号不广播，
  //    tag 后 version-guard 才红）；缺注解时 Generic updater 直接原样返回
  //    （实测：无注解的 md 文件内容一字不改）。二者是同一类「配了等于没配」。
  if (fsFacts) {
    const { exists, readText } = fsFacts;
    for (const ef of rootPkg?.["extra-files"] ?? []) {
      const p = typeof ef === "object" ? ef?.path : ef;
      if (typeof p !== "string" || !p) continue;
      const rel = p.replace(/^\/+/, "");
      if (!exists(rel)) {
        problems.push(
          `① extra-files 目标 ${rel} 不存在`
            + `——release-please 只会打一条 "did not exist" 警告后跳过，该文件版本号不被广播`,
        );
        continue;
      }
      const isGeneric = typeof ef === "object"
        ? ef.type === "generic"
        : !/\.(json|ya?ml|toml|xml)$/.test(rel);
      if (isGeneric && !(readText(rel) ?? "").includes("x-release-please-version")) {
        problems.push(
          `① extra-files 目标 ${rel} 缺 \`x-release-please-version\` 注解`
            + `——Generic updater 找不到锚点会原样返回（静默 no-op），该文件版本号永不更新`,
        );
      }
    }
  }

  // ①e exclude-paths 的每个条目都必须**含有 git 跟踪文件**。
  //
  // 判据是「跟踪」而非「磁盘存在」：exclude-paths 的作用对象是提交里的 files
  // 列表，未跟踪目录永远不会出现在任何提交里，因此这类条目是**纯死配置**。
  // 而「磁盘存在」还依赖本地检出状态——CI 干净检出里 .qoder/.turbo/.devin 等
  // 并不存在，用磁盘存在当判据会让守卫在本地与 CI 上给出**不同结论**
  // （实测：本地绿、CI 红 11 条）。死条目本身不危险，但它让配置看起来比实际
  // 更严密，且会掩盖真正的拼写错误（把 .qoder 写成 .qodo 时两者都是
  // 「0 跟踪文件」，仅凭黑名单无法区分，必须删掉死条目才能让拼写错误显形）。
  if (fsFacts?.isTracked) {
    for (const ep of rootPkg?.["exclude-paths"] ?? []) {
      if (!fsFacts.isTracked(ep)) {
        problems.push(
          `① root exclude-paths 里的 "${ep}" 没有任何 git 跟踪文件`
            + `——该条目是死配置（未跟踪目录不会出现在提交文件列表里），应删除以免掩盖真正的拼写错误`,
        );
      }
    }
  }

  // ② 矩阵里的 dir 必须被版本广播面覆盖
  for (const { dir, pkg } of matrix) {
    const covered = [...targets].some((t) => t.startsWith(`${dir}/`));
    if (!covered) {
      problems.push(`② publish-npm 矩阵的 ${dir}（${pkg}）没有任何版本文件在 extra-files 广播面内`);
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

  // ④ 版本事实源必须已一致（root 线内四包 + 组内成员）
  const groups = (rpConfig.plugins ?? [])
    .filter((p) => p?.type === "linked-versions" && Array.isArray(p.components))
    .map((p) => ({ name: p.groupName ?? "(unnamed)", components: p.components }));

  // ④a root 线：root 条目的版本 vs 矩阵里各包的版本
  if (rootPkg && versions[ROOT_PATH] !== undefined) {
    const drift = matrixDirs
      .map((dir) => ({ dir, version: versions[dir] }))
      .filter((v) => v.version !== undefined && v.version !== versions[ROOT_PATH]);
    if (drift.length) {
      problems.push(
        `④ lockstep 单版本线不一致：root(${ROOT_PATH})=${versions[ROOT_PATH]}，`
          + drift.map((d) => `${d.dir}=${d.version}`).join("，")
          + `——version-guard 会在 tag 那一刻拦下发布`,
      );
    }
  }

  // ④b linked-versions 组内一致
  for (const group of groups) {
    const members = Object.entries(packages)
      .filter(([, v]) => group.components.includes(v?.component))
      .map(([dir, v]) => ({ component: v.component, version: versions[dir] }))
      .filter((v) => v.version !== undefined);
    const uniq = [...new Set(members.map((v) => v.version))];
    if (uniq.length > 1) {
      problems.push(
        `④ lockstep 组「${group.name}」内版本不一致：`
          + members.map((v) => `${v.component}=${v.version}`).join("，"),
      );
    }
  }

  // ④c linked-versions 组必须逐包打开 include-component-in-tag，
  //    否则 getComponent() 返回 '' → preconfigure() 匹配零组员 → 版本统一不执行
  for (const [dir, v] of Object.entries(packages)) {
    const inGroup = groups.some((g) => g.components.includes(v?.component));
    if (inGroup && v?.["include-component-in-tag"] !== true) {
      problems.push(
        `④ ${dir}（component=${v?.component}）在 linked-versions 组内，但没有 `
          + `"include-component-in-tag": true——该开关为 false 时 getComponent() 恒返回 ''，`
          + `preconfigure() 会匹配到 0 个组员，版本统一静默不执行`,
      );
    }
  }

  // ⑤ manifest（"上次发到哪了"的基线）与 config 的 packages 必须一一对应。
  if (manifest) {
    const manifestDirs = new Set(Object.keys(manifest));
    for (const dir of Object.keys(packages)) {
      if (!manifestDirs.has(dir)) {
        problems.push(
          `⑤ ${dir} 在 release-please-config.json 里受管，却不在 release-please-manifest.json`
            + `——基线丢失，release-please 会把它当全新包从 1.0.0 起算（版本倒退）`,
        );
      }
    }
    for (const dir of manifestDirs) {
      if (!(dir in packages)) {
        problems.push(
          `⑤ release-please-manifest.json 里的 ${dir} 不在 release-please-config.json`
            + `——manifest 残留条目，会让人误以为该包仍受管`,
        );
      }
    }
  }

  return problems;
}

export function checkRepo(root = findRepoRoot()) {
  const rpConfig = JSON.parse(
    readFileSync(join(root, "release-please-config.json"), "utf-8"),
  );
  const manifest = JSON.parse(
    readFileSync(join(root, "release-please-manifest.json"), "utf-8"),
  );
  const wf = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf-8");
  const { matrix, guardedDirs } = parseReleaseWorkflow(wf);
  const versions = {};
  // root 条目用 version-file（version.txt）作为事实源
  const rootPkg = rpConfig.packages?.[ROOT_PATH];
  if (rootPkg) {
    const vf = rootPkg["version-file"] ?? "version.txt";
    try {
      versions[ROOT_PATH] = readFileSync(join(root, vf), "utf-8").trim();
    } catch {
      /* 读不到就跳过 ④ 的 root 比对 */
    }
  }
  for (const dir of Object.keys(rpConfig.packages ?? {})) {
    if (dir === ROOT_PATH) continue;
    try {
      versions[dir] = readVersion(root, dir);
    } catch {
      /* 读不到就跳过 ④ 对该包的比对 */
    }
  }
  return {
    problems: checkReleaseConfig({
      rpConfig,
      matrix,
      guardedDirs,
      versions,
      manifest,
      fsFacts: {
        exists: (rel) => {
          try {
            statSync(join(root, rel));
            return true;
          } catch {
            return false;
          }
        },
        readText: (rel) => {
          try {
            return readFileSync(join(root, rel), "utf-8");
          } catch {
            return null;
          }
        },
        // 「有没有 git 跟踪文件」——用 git ls-files 而非磁盘存在性，避免
        // 本地检出状态影响结论（CI 干净检出里 .qoder/.turbo 等并不存在）。
        isTracked: (rel) => {
          try {
            const out = execFileSync("git", ["ls-files", "--", rel], {
              cwd: root,
              encoding: "utf-8",
              stdio: ["ignore", "pipe", "ignore"],
            });
            return out.trim().length > 0;
          } catch {
            return true; // git 不可用时不做该层判断，避免误报
          }
        },
      },
    }),
    matrix,
    versions,
    manifest,
  };
}

/** 自测：每个断言都带**反例**，证明守卫真的能发现问题（有牙）。 */
export function selftest() {
  // 基线 = 本仓真实形态（root 条目 + py-libs 组）
  const rootPkgBase = {
    "release-type": "simple",
    "version-file": "version.txt",
    "extra-files": [
      { type: "json", path: "/packages/one/package.json", jsonpath: "$.version" },
      { type: "json", path: "/packages/one/package-lock.json", jsonpath: "$.version" },
      { type: "json", path: "/packages/one/package-lock.json", jsonpath: "$.packages[''].version" },
      { type: "json", path: "/packages/two/package.json", jsonpath: "$.version" },
      { type: "json", path: "/packages/two/package-lock.json", jsonpath: "$.version" },
      { type: "json", path: "/packages/two/package-lock.json", jsonpath: "$.packages[''].version" },
      { type: "generic", path: "/packages/py/__init__.py" },
    ],
  };
  const baseRp = {
    plugins: [
      { type: "linked-versions", groupName: "py", components: ["py", "py2"], merge: true },
    ],
    packages: {
      ".": rootPkgBase,
      "packages/py": { component: "py", "release-type": "python", "include-component-in-tag": true },
      "packages/py2": { component: "py2", "release-type": "python", "include-component-in-tag": true },
    },
  };
  const baseMatrix = [
    { dir: "packages/one", pkg: "@x/one" },
    { dir: "packages/two", pkg: "@x/two" },
  ];
  const baseGuarded = new Set(["packages/one", "packages/two"]);
  const baseVersions = { ".": "1.0.0", "packages/one": "1.0.0", "packages/two": "1.0.0", "packages/py": "0.1.0", "packages/py2": "0.1.0" };
  const baseManifest = { ".": "1.0.0", "packages/py": "0.1.0", "packages/py2": "0.1.0" };
  const run = (over = {}) =>
    checkReleaseConfig({
      rpConfig: over.rpConfig ?? baseRp,
      matrix: over.matrix ?? baseMatrix,
      guardedDirs: over.guardedDirs ?? baseGuarded,
      versions: over.versions ?? baseVersions,
      manifest: over.manifest ?? baseManifest,
      // 默认不传 fsFacts：基线用例保持纯函数（不受磁盘状态影响）。
      fsFacts: over.fsFacts,
    });

  const base = run();
  const cases = [
    ["基线全绿", base, 0],
    [
      // 去掉 root 条目后，除 ⓪ 外还会**级联**触发 ①（广播面为空）与 ②（矩阵无覆盖）
      // ——三条都成立、都不是误报。取 14 而非 1：断言的是"能抓到"，不是"只报一条"。
      "⓪ 缺 root 条目被抓（级联 ①/②，共 14 条）",
      run({ rpConfig: { ...baseRp, packages: { "packages/py": baseRp.packages["packages/py"], "packages/py2": baseRp.packages["packages/py2"] } } }),
      14,
    ],
    [
      "⓪ linked-versions 写回顶层被抓（被静默丢弃）",
      run({ rpConfig: { ...baseRp, "linked-versions": [{ groupName: "py", components: ["py"] }] } }),
      1,
    ],
    [
      "① extra-files 漏一个版本文件被抓",
      run({
        rpConfig: {
          ...baseRp,
          packages: {
            ...baseRp.packages,
            ".": {
              ...rootPkgBase,
              "extra-files": rootPkgBase["extra-files"].filter((e) => e.path !== "/packages/two/package.json"),
            },
          },
        },
      }),
      1,
    ],
    [
      "①b lockfile 缺 packages[\"\"].version 那条被抓",
      run({
        rpConfig: {
          ...baseRp,
          packages: {
            ...baseRp.packages,
            ".": {
              ...rootPkgBase,
              "extra-files": rootPkgBase["extra-files"].filter(
                (e) => !(e.path === "/packages/one/package-lock.json" && e.jsonpath === "$.packages[''].version"),
              ),
            },
          },
        },
      }),
      1,
    ],
    [
      "①c $..version 递归误伤依赖被抓",
      run({
        rpConfig: {
          ...baseRp,
          packages: {
            ...baseRp.packages,
            ".": {
              ...rootPkgBase,
              "extra-files": [
                ...rootPkgBase["extra-files"],
                { type: "json", path: "/packages/one/package-lock.json", jsonpath: "$..version" },
              ],
            },
          },
        },
      }),
      1,
    ],
    [
      // 未受管的包会**同时**触发 ①（广播面缺它）、②（矩阵不该发它）、
      // ③（它没被 version-guard 校验）——三条都成立，取 7 而非 1。
      "② 矩阵里有未覆盖的包被抓（级联 ①/③，共 7 条）",
      run({ matrix: [...baseMatrix, { dir: "packages/three", pkg: "@x/three" }] }),
      7,
    ],
    [
      "③ 待发布包不在 version-guard 里被抓",
      run({ guardedDirs: new Set(["packages/one"]) }),
      1,
    ],
    [
      "④ root 线与包版本漂移被抓",
      run({ versions: { ".": "1.0.0", "packages/one": "1.0.1", "packages/two": "1.0.0", "packages/py": "0.1.0" } }),
      1,
    ],
    [
      "④c 组内包没开 include-component-in-tag 被抓（getComponent() 返回 ''）",
      run({
        rpConfig: {
          ...baseRp,
          packages: {
            ...baseRp.packages,
            "packages/py": { component: "py", "release-type": "python" },
          },
        },
      }),
      1,
    ],
    [
      "④b 组内版本不一致被抓（py=0.1.0 vs py2=0.2.0）",
      run({ versions: { ".": "1.0.0", "packages/one": "1.0.0", "packages/two": "1.0.0", "packages/py": "0.1.0", "packages/py2": "0.2.0" } }),
      1,
    ],
    [
      // py 与 py2 都漏进 manifest → 两条（每个包各一条），不是一条。
      "⑤ 受管包漏进 manifest 被抓（版本会倒退回 1.0.0）",
      run({ manifest: { ".": "1.0.0" } }),
      2,
    ],
    [
      "⑤ manifest 残留未受管条目被抓",
      run({ manifest: { ...baseManifest, "packages/gone": "1.0.0" } }),
      1,
    ],
    [
      "⑤ 不传 manifest 时跳过该层（向后兼容旧调用）",
      run({ manifest: undefined }),
      0,
    ],
    [
      // 静默失效类：extra-files 指向不存在的文件 → release-please 只打 warning。
      "①d extra-files 目标不存在被抓（静默跳过）",
      run({
        fsFacts: {
          exists: (rel) => rel !== "packages/two/package.json",
          readText: () => "with x-release-please-version marker",
        },
      }),
      1,
    ],
    [
      // 静默失效类：generic 目标缺注解 → Generic updater 原样返回（no-op）。
      "①d generic 目标缺 x-release-please-version 注解被抓（静默 no-op）",
      run({
        fsFacts: {
          exists: () => true,
          readText: (rel) => (rel === "packages/py/__init__.py" ? '__version__ = "0.1.0"' : "ok x-release-please-version"),
        },
      }),
      1,
    ],
    [
      // 死配置类：exclude-paths 条目若没有任何 git 跟踪文件，它永远匹配不到
      // 提交文件，是纯死配置——且会掩盖真正的拼写错误（把 .qoder 写成 .qodo 时
      // 两者都是「0 跟踪文件」，只看黑名单无法区分）。
      // 判据刻意用 isTracked（git ls-files）而非磁盘存在性：后者会让本守卫在
      // 本地与 CI 上给出不同结论（实测本地绿 / CI 红 11 条）。
      "①e exclude-paths 里的死条目被抓（无 git 跟踪文件）",
      run({
        rpConfig: { ...baseRp, packages: { ...baseRp.packages, ".": { ...rootPkgBase, "exclude-paths": ["apps", ".qodo"] } } },
        fsFacts: { exists: () => true, readText: () => "x-release-please-version", isTracked: (rel) => rel !== ".qodo" },
      }),
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
  const negative = cases.filter(([, , want]) => want > 0).length;
  console.log(
    `release-config guard selftest: all assertions passed`
      + `（${cases.length} 例：${cases.length - negative} 正向 + ${negative} 反例）`,
  );
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
    console.log("release-config guard OK：五层一致性（广播面完整 / 矩阵受覆盖 / 版本受校验 / 版本已对齐 / manifest 基线对齐）全部通过");
  }
}
