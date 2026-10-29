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
 * ── T4（第 4 轮守卫自检审计）修掉的假绿 ──────────────────────────────
 *
 *   · **只测函数，不测闸门（最贵的一条）**：旧 `--selftest` 直接调
 *     `checkReleaseConfig()`（纯函数）并断言 `problems.length === N`。
 *     把 CLI 里的 `process.exit(1)` 删掉、或让 `checkRepo()` 吞掉 problems，
 *     `--selftest` 照样 22 例全绿——**报告在说话，闸不关门**。现在 selftest 在
 *     临时 fixture 树里跑**真子进程**，逐条断言退出码 + 关键报错文本。
 *   · **只数条数**：`problems.length === 14` 这类断言无法区分「⓪ 缺 root 条目」
 *     与「① 广播面为空」。实测把 ⓪ 的判据整条删掉、只让 ① 级联报 14 条，
 *     `--selftest` 依旧全绿。现在每条用例断言**具体是哪一层**、点名的路径。
 *   · **扫描面塌方 = 永真绿**：①②③ 都是 `for (const dir of matrix)`。`parseReleaseWorkflow`
 *     一旦与 release.yml 的排版脱节（矩阵改成 `dir`/`pkg` 同行、矩阵移到别的 job、
 *     job 改名），`matrix` 变空 ⇒ **零迭代 ⇒ 零问题 ⇒ 全绿**，而仓库可能一个包
 *     都没被广播。同理 `version-guard` 段解析空、`extra-files` 解析空。现在三者
 *     都有**下界**（`MIN_MATRIX_PACKAGES` / `MIN_GUARDED_DIRS` / `MIN_EXTRA_FILES`），
 *     低于下界 = **结构红**（判据失效，不是「配置一致」）。
 *   · **事实源缺失 = 崩栈**：配置/基线/workflow/version.txt 不在时旧实现直接
 *     `readFileSync`/`JSON.parse` 抛错，CI 日志是一段 stack，看不出该补哪个文件。
 *     现在全部是**结构红**并点名路径。
 *   · **④a 在生产路径上是死的（只测函数掩盖了它）**：旧 `checkRepo` 只对
 *     `release-please-config.json` 的 `packages` 键读版本号，而 `publish-npm`
 *     矩阵里的三个待发布包（node-sdk / acf-cli / mcp-server）**不在** `packages`
 *     里——于是 `versions[dir]` 恒为 undefined，④a 的「root 线漂移」比对
 *     **一次都没执行过**。旧 selftest 直接给 `checkReleaseConfig()` 喂构造好的
 *     `versions`，正好绕开了这条断裂。现在版本号按「矩阵成员 ∪ 受管包」读，
 *     selftest 里有子进程用例证明它真的会红（S04）。
 *   · **版本读不到 = 静默跳过（`continue` 跳块）**：旧 `checkRepo` 对每个包
 *     `try { readVersion(...) } catch { … }`（注释原文：读不到就跳过 ④ 对该包的比对）——一个包
 *     的 package.json 被改名/漏生成，它的版本对齐就**静默不再校验**，而 ④ 仍然
 *     报绿。现在「受管包的版本读不到」是结构红。
 *   · **`--root` 缺失 + 路径钉死**：旧实现 `findRepoRoot()` 从脚本目录上溯，
 *     selftest 只能对内存对象断言，**守卫本身在真实仓库上还会不会红从未被验证**。
 *     现在所有路径相对 `root`（默认脚本上级目录），且只在被直接调用时执行。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   node scripts/check-release-config.mjs              # 校验
 *   node scripts/check-release-config.mjs --selftest    # 自测（真子进程 + 反例，证明有牙）
 *   node scripts/check-release-config.mjs --root <dir>  # 把该目录当仓库根（selftest 专用）
 *
 * 退出码：0 = 六层一致；1 = 存在不一致，**或判据本身不可信**（结构错）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认仓库根：脚本位于 `<repo>/scripts/`，由脚本位置推出，不依赖调用方 cwd。 */
export const DEFAULT_ROOT = resolve(HERE, "..");

export const CONFIG_FILE = "release-please-config.json";
export const MANIFEST_FILE = "release-please-manifest.json";
export const WORKFLOW_FILE = ".github/workflows/release.yml";

/**
 * 扫描面下界（2026-10-29 实测：3 个待发布 npm 包 / 3 个 version-guard 路径 /
 * 21 条 extra-files）。
 *
 * ①②③ 全部 `for (const ... of matrix)`，分母塌成 0 时它们是**永真断言**。
 * 下界按实测值取（extra-files 取 ~1/2：容忍合并同类项，不容忍口径失效）。
 */
export const MIN_MATRIX_PACKAGES = 3;
export const MIN_GUARDED_DIRS = 3;
export const MIN_EXTRA_FILES = 10;

/** SDK-DX-05：四个已发布包的 CHANGELOG 必须是版本可校验的 stub（见 checkChangelogStubs）。 */
export const CHANGELOG_STUB_DIRS = [
  "packages/autocodeflow-node-sdk",
  "packages/acf-cli",
  "packages/mcp-server",
  "packages/autoflow-sdk",
];

export function findRepoRoot(startDir = HERE) {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(join(dir, CONFIG_FILE), "utf-8");
      return dir;
    } catch {
      /* 继续上溯 */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`找不到仓库根（未找到 ${CONFIG_FILE}）`);
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

/**
 * SDK-DX-05（P3）：四个已发布包的 CHANGELOG 必须是**版本可校验的指针 stub**。
 *
 * 根因是结构性的：release-please 只有 root `.` 条目，版本号经 extra-files
 * 广播到 manifest/README，但**不写包级 CHANGELOG**——四份文件因此冻结在
 * 1.9.0（6 个 release 无记录），而版本已经 1.15.0。修法不是让每个包都进
 * release-please（会制造同 commit 重复条目），而是把包级 CHANGELOG 改成
 * 指针 stub，并把「stub 声明版本 == manifest 版本」变成静态判据。
 */
export function checkChangelogStubs(root) {
  // SDK-DX-05（P3）：四个已发布包的 CHANGELOG 必须是**版本可校验的指针 stub**。
  //
  // 根因是结构性的：release-please 只有 root `.` 条目，版本号经 extra-files
  // 广播到 manifest/README，但**不写包级 CHANGELOG**——四份文件因此冻结在
  // 1.9.0（6 个 release 无记录），而版本已经 1.15.0。修法不是让每个包都进
  // release-please（会制造同 commit 重复条目），而是把包级 CHANGELOG 改成
  // 指针 stub，并把「stub 声明版本 == manifest 版本」变成静态判据：stub 一旦
  // 忘记跟着发版更新就红。
  const problems = [];
  for (const dir of CHANGELOG_STUB_DIRS) {
    let manifestVersion = null;
    try {
      manifestVersion = readVersion(root, dir);
    } catch {
      problems.push(`${dir} 读不到版本号（package.json / pyproject.toml）`);
      continue;
    }
    let text = null;
    try {
      text = readFileSync(join(root, dir, "CHANGELOG.md"), "utf-8");
    } catch {
      problems.push(`${dir}/CHANGELOG.md 缺失`);
      continue;
    }
    const declared =
      /<!--\s*stub-version:\s*([0-9A-Za-z.+-]+)\s*-->/.exec(text)?.[1] ?? null;
    if (!declared) {
      problems.push(
        `${dir}/CHANGELOG.md 必须是 stub（含 <!-- stub-version: X -->，指向根 CHANGELOG）——否则会像 1.9.0 那样静默冻结`,
      );
    } else if (declared !== manifestVersion) {
      problems.push(
        `${dir}/CHANGELOG.md 的 stub-version=${declared} 与 manifest 版本 ${manifestVersion} 不一致（stub 忘记随发版更新）`,
      );
    }
  }
  return problems;
}
/**
 * 全量判据。
 *
 * @param {string} [root] 仓库根
 * @returns {{problems: string[], structure: string[], matrix: {dir: string, pkg: string}[],
 *            versions: Record<string, string>, manifest: any,
 *            stats: {matrix: number, guarded: number, extraFiles: number, packages: number}}}
 *   `problems` = 真实不一致；`structure` = **判据本身不可信**（事实源缺失、扫描面塌方）。
 */
export function check(root = DEFAULT_ROOT) {
  const problems = [];
  const structure = [];
  const stats = { matrix: 0, guarded: 0, extraFiles: 0, packages: 0 };

  for (const rel of [CONFIG_FILE, MANIFEST_FILE, WORKFLOW_FILE]) {
    if (!existsSync(join(root, rel))) {
      structure.push(
        `事实源缺失：${rel} —— 判据无从比对（路径改名/文件没生成都会这样，不是「配置一致」）。`,
      );
    }
  }
  if (structure.length > 0) {
    return { problems, structure, matrix: [], versions: {}, manifest: null, stats };
  }

  /** @type {any} */
  let rpConfig = null;
  /** @type {any} */
  let manifest = null;
  try {
    rpConfig = JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf-8"));
  } catch (error) {
    structure.push(
      `${CONFIG_FILE} 不可解析：${error.message} —— ①~⑤ 全部无从执行（不是「配置一致」）。`,
    );
  }
  try {
    manifest = JSON.parse(readFileSync(join(root, MANIFEST_FILE), "utf-8"));
  } catch (error) {
    structure.push(`${MANIFEST_FILE} 不可解析：${error.message} —— ⑤ 的基线比对无从执行。`);
  }

  /** @type {{matrix: {dir: string, pkg: string}[], guardedDirs: Set<string>}} */
  let parsed = { matrix: [], guardedDirs: new Set() };
  try {
    parsed = parseReleaseWorkflow(readFileSync(join(root, WORKFLOW_FILE), "utf-8"));
  } catch (error) {
    structure.push(
      `${WORKFLOW_FILE} 解析失败：${error.message} —— ①②③ 的扫描面为空（不是「矩阵完整」）。`,
    );
  }

  const rootPkg = rpConfig?.packages?.[ROOT_PATH];
  const extraFiles = rootPkg?.["extra-files"] ?? [];
  stats.matrix = parsed.matrix.length;
  stats.guarded = parsed.guardedDirs.size;
  stats.extraFiles = extraFiles.length;
  stats.packages = Object.keys(rpConfig?.packages ?? {}).length;

  // ── 扫描面下界（分母塌了不是「没有不一致」）────────────────────────────────
  if (stats.matrix < MIN_MATRIX_PACKAGES) {
    structure.push(
      `只解析出 ${stats.matrix} 个待发布包（下界 ${MIN_MATRIX_PACKAGES}）—— ` +
        `矩阵解析口径与 ${WORKFLOW_FILE} 已失配；这种分母下「矩阵受覆盖 / 版本受校验」` +
        `是永真断言（① ② ③ 全都在 for-of 空集合上）。`,
    );
  }
  if (stats.guarded < MIN_GUARDED_DIRS) {
    structure.push(
      `version-guard 只解析出 ${stats.guarded} 个受校验包（下界 ${MIN_GUARDED_DIRS}）` +
        ` —— ③「每个待发布包都在校验清单里」无从判定。`,
    );
  }
  if (stats.extraFiles < MIN_EXTRA_FILES) {
    structure.push(
      `root 条目只解析出 ${stats.extraFiles} 条 extra-files（下界 ${MIN_EXTRA_FILES}）` +
        ` —— ① 的广播面塌了（不是「广播面完整」）。`,
    );
  }

  // ── 版本事实源（读不到就不是「已对齐」）──────────────────────────────────
  const versions = {};
  const versionFile = rootPkg?.["version-file"] ?? "version.txt";
  if (!existsSync(join(root, versionFile))) {
    structure.push(
      `事实源缺失：${versionFile} —— root 版本线读不到，④ 的版本对齐比对会被跳过（旧实现正是静默跳过）。`,
    );
  } else {
    versions[ROOT_PATH] = readFileSync(join(root, versionFile), "utf-8").trim();
  }
  // 版本号必须按**矩阵成员 ∪ config 受管包**读取：矩阵里的待发布包（node-sdk /
  // acf-cli / mcp-server）根本不在 release-please 的 `packages` 里，旧实现只遍历
  // `packages` 的键 → `versions[dir]` 恒为 undefined → ④a 的漂移比对**永不执行**
  // （而 selftest 直接给纯函数喂了构造数据，所以从未发现这一点）。
  const versionDirs = new Set([
    ...Object.keys(rpConfig?.packages ?? {}),
    ...parsed.matrix.map((m) => m.dir),
  ]);
  for (const dir of versionDirs) {
    if (dir === ROOT_PATH) continue;
    try {
      versions[dir] = readVersion(root, dir);
    } catch {
      structure.push(
        `版本事实源缺失：${dir} —— package.json 与 pyproject.toml 都读不到版本号；` +
          `旧实现 try/catch 后静默跳过该包的 ④ 比对（「版本已对齐」对它形同虚设）。`,
      );
    }
  }

  if (structure.length > 0) {
    return { problems, structure, matrix: parsed.matrix, versions, manifest, stats };
  }

  problems.push(
    ...checkReleaseConfig({
      rpConfig,
      matrix: parsed.matrix,
      guardedDirs: parsed.guardedDirs,
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
  );
  problems.push(...checkChangelogStubs(root));

  return { problems, structure, matrix: parsed.matrix, versions, manifest, stats };
}

/** @deprecated 保留旧名（旧调用方只读 problems）；新代码用 `check()`（多了 structure）。 */
export function checkRepo(root = DEFAULT_ROOT) {
  return check(root);
}

/**
 * 跑一次守卫（供 CLI 与 selftest 共用）。
 *
 * @param {{root?: string}} [options]
 * @returns {number} 退出码
 */
export function run({ root = DEFAULT_ROOT } = {}) {
  const { problems, structure, matrix, versions } = check(root);

  // 结构关在判定之前：判据瞎了就不该给出任何「一致 / 不一致」的结论。
  if (structure.length > 0) {
    console.error("");
    console.error("✘ release-config 守卫结构错误（判据本身不可信，先修事实源）：");
    for (const s of structure) console.error(`   · ${s}`);
    console.error("");
    return 1;
  }

  console.log(
    `release 配置：${matrix.length} 个待发布 npm 包 `
      + `(${matrix.map((m) => m.pkg).join(", ")})`,
  );
  for (const [dir, v] of Object.entries(versions)) console.log(`  ${dir} = ${v}`);
  if (problems.length) {
    console.error("\n发布配置一致性问题：");
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(
    "release-config guard OK：六层一致性（广播面完整 / 矩阵受覆盖 / 版本受校验 / 版本已对齐 / manifest 基线对齐 / CHANGELOG stub 版本）全部通过",
  );
  return 0;
}

// ── 自检（T4：层内文本反证 + 真子进程退出码 + <1s）──────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const FIXTURE_ROOT_VERSION = "1.0.0";
const FIXTURE_PY_VERSION = "0.1.0";
/** 4 个 npm 包（比下界 3 多一个：这样「漏一个」的变异不会先撞上下界结构红）。 */
const FIXTURE_NPM_DIRS = ["packages/one", "packages/two", "packages/three", "packages/four"];
const FIXTURE_PY_DIRS = ["packages/py", "packages/py2"];
const RELEASE_MARKER = "<!-- x-release-please-version -->";

/** root 条目的 extra-files（与真实配置同构：npm 包三 slot + 两条 generic）。 */
function fixtureExtraFiles(dirs = FIXTURE_NPM_DIRS) {
  return [
    ...dirs.flatMap((dir) => [
      { type: "json", path: `/${dir}/package.json`, jsonpath: "$.version" },
      { type: "json", path: `/${dir}/package-lock.json`, jsonpath: "$.version" },
      { type: "json", path: `/${dir}/package-lock.json`, jsonpath: "$.packages[''].version" },
    ]),
    { type: "generic", path: "/packages/autoflow-sdk/pyproject.toml" },
    { type: "generic", path: "/docs/sdk-guide.md" },
  ];
}

function fixtureConfig({ extraFiles = fixtureExtraFiles(), pyIncludeTag = true } = {}) {
  return {
    plugins: [
      { type: "linked-versions", groupName: "py", components: ["py", "py2"], merge: true },
    ],
    packages: {
      ".": {
        "release-type": "simple",
        "version-file": "version.txt",
        "extra-files": extraFiles,
      },
      "packages/py": {
        component: "py",
        "release-type": "python",
        ...(pyIncludeTag ? { "include-component-in-tag": true } : {}),
      },
      "packages/py2": {
        component: "py2",
        "release-type": "python",
        "include-component-in-tag": true,
      },
    },
  };
}

function fixtureWorkflow({ matrixDirs = FIXTURE_NPM_DIRS, guardedDirs = FIXTURE_NPM_DIRS } = {}) {
  return [
    "name: release",
    "on:",
    "  push:",
    "    tags: ['v*']",
    "jobs:",
    "  version-guard:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: verify versions",
    "        run: |",
    ...guardedDirs.map((d) => `          pkg_json_version("${d}/package.json")`),
    "  publish-npm:",
    "    strategy:",
    "      matrix:",
    "        include:",
    ...matrixDirs.flatMap((d) => [
      `          - dir: ${d}`,
      `            pkg: '@x/${d.split("/").pop()}'`,
    ]),
    "    steps:",
    "      - run: echo publish",
    "",
  ].join("\n");
}

/** fixture 仓库树：默认与真实仓库同构且全绿，各处可替换以造变异。 */
function fixtureTree({
  config,
  workflow,
  manifest,
  npmVersions = {},
  stubVersions = {},
  rootVersion = FIXTURE_ROOT_VERSION,
  omit = [],
} = {}) {
  const files = { "package.json": { name: "fixture", private: true } };
  if (rootVersion !== null) files["version.txt"] = `${rootVersion}\n`;
  files[CONFIG_FILE] = config ?? fixtureConfig();
  files[WORKFLOW_FILE] = workflow ?? fixtureWorkflow();
  files[MANIFEST_FILE] = manifest ?? {
    ".": FIXTURE_ROOT_VERSION,
    "packages/py": FIXTURE_PY_VERSION,
    "packages/py2": FIXTURE_PY_VERSION,
  };
  for (const dir of FIXTURE_NPM_DIRS) {
    const name = dir.split("/").pop();
    const version = npmVersions[dir] ?? FIXTURE_ROOT_VERSION;
    files[`${dir}/package.json`] = { name: `@x/${name}`, version };
    files[`${dir}/package-lock.json`] = { name: `@x/${name}`, version, packages: { "": { version } } };
  }
  files["packages/autoflow-sdk/pyproject.toml"] =
    `${RELEASE_MARKER}\n[project]\nname = "autocodeflow-sdk"\nversion = "${FIXTURE_PY_VERSION}"\n`;
  files["docs/sdk-guide.md"] = `${RELEASE_MARKER}\n\n# SDK guide（fixture）\n`;
  for (const dir of FIXTURE_PY_DIRS) {
    files[`${dir}/pyproject.toml`] =
      `[project]\nname = "${dir.split("/").pop()}"\nversion = "${FIXTURE_PY_VERSION}"\n`;
  }
  for (const dir of CHANGELOG_STUB_DIRS) {
    files[`${dir}/package.json`] = { name: dir, version: FIXTURE_ROOT_VERSION };
    files[`${dir}/CHANGELOG.md`] =
      `# Changelog\n\n<!-- stub-version: ${stubVersions[dir] ?? FIXTURE_ROOT_VERSION} -->\n`;
  }
  for (const key of omit) delete files[key];
  return files;
}

/**
 * 断言问题清单的**文本**（而不是条数）。
 *
 * `length === N` 无法区分「⓪ 缺 root 条目」与「① 广播面为空」——把 ⓪ 整条判据删掉、
 * 只让 ① 级联报同样多的条，计数断言照样通过（这就是旧 selftest 的假绿）。
 */
function expectProblems(name, problems, { want = [], none = [], empty = false } = {}) {
  const joined = problems.join("\n");
  const missing = want.filter((needle) => !joined.includes(needle));
  if (missing.length > 0) {
    throw new Error(
      `「${name}」问题清单缺少片段 ${JSON.stringify(missing)}\n  实际（${problems.length} 条）：\n${joined || "（无问题）"}`,
    );
  }
  const hits = none.filter((needle) => joined.includes(needle));
  if (hits.length > 0) {
    throw new Error(
      `「${name}」问题清单不该出现 ${JSON.stringify(hits)}\n  实际（${problems.length} 条）：\n${joined}`,
    );
  }
  if (empty && problems.length > 0) {
    throw new Error(`「${name}」期望零问题，实际 ${problems.length} 条：\n${joined}`);
  }
}

/** 自检：层内文本反证 + 真子进程（退出码 / 文本 / 结构红 / 下界）。 */
export function selftest() {
  const cases = [];

  // ── 第一部分：层内用例（零进程）——把每个判据的「该红」形态钉到文本上 ────────
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
  const baseVersions = {
    ".": "1.0.0",
    "packages/one": "1.0.0",
    "packages/two": "1.0.0",
    "packages/py": "0.1.0",
    "packages/py2": "0.1.0",
  };
  const baseManifest = { ".": "1.0.0", "packages/py": "0.1.0", "packages/py2": "0.1.0" };
  const layer = (over = {}) =>
    checkReleaseConfig({
      rpConfig: over.rpConfig ?? baseRp,
      matrix: over.matrix ?? baseMatrix,
      guardedDirs: over.guardedDirs ?? baseGuarded,
      versions: over.versions ?? baseVersions,
      manifest: "manifest" in over ? over.manifest : baseManifest,
      // 默认不传 fsFacts：基线用例保持纯函数（不受磁盘状态影响）。
      fsFacts: over.fsFacts,
    });
  const withRoot = (patch) => ({
    ...baseRp,
    packages: { ...baseRp.packages, ".": { ...rootPkgBase, ...patch } },
  });
  const layerCase = (name, over, expect) => {
    cases.push({
      name,
      fn: () => expectProblems(name, layer(over), expect),
    });
  };

  layerCase("L01 基线全绿（root 条目 + py 组 + manifest 对齐）", {}, { empty: true });
  layerCase(
    "L02 ⓪ 缺 root 条目被抓（点名 lockstep 单版本线）",
    {
      rpConfig: {
        ...baseRp,
        packages: {
          "packages/py": baseRp.packages["packages/py"],
          "packages/py2": baseRp.packages["packages/py2"],
        },
      },
    },
    { want: ['⓪ release-please-config.json 缺 root 条目 "."', "lockstep 单版本线"] },
  );
  layerCase(
    "L03 ⓪ linked-versions 写回顶层被抓（会被静默丢弃）",
    { rpConfig: { ...baseRp, "linked-versions": [{ groupName: "py", components: ["py"] }] } },
    { want: ['"linked-versions" 出现在**顶层**', "静默丢弃"] },
  );
  layerCase(
    "L04 ① extra-files 漏一个版本文件被抓（Release PR 不 bump 它）",
    {
      rpConfig: withRoot({
        "extra-files": rootPkgBase["extra-files"].filter((e) => e.path !== "/packages/two/package.json"),
      }),
    },
    { want: ["① packages/two/package.json 不在 root 条目的 extra-files 里"] },
  );
  layerCase(
    "L05 ①b lockfile 缺 packages[''].version 那条被抓（两个 slot 必须各写一条）",
    {
      rpConfig: withRoot({
        "extra-files": rootPkgBase["extra-files"].filter(
          (e) => !(e.path === "/packages/one/package-lock.json" && e.jsonpath === "$.packages[''].version"),
        ),
      }),
    },
    { want: ["① packages/one/package-lock.json 的 extra-files 缺 jsonpath $.packages[''].version"] },
  );
  layerCase(
    "L06 ①c $..version 递归误伤依赖被抓（实测会改 165 处）",
    {
      rpConfig: withRoot({
        "extra-files": [
          ...rootPkgBase["extra-files"],
          { type: "json", path: "/packages/one/package-lock.json", jsonpath: "$..version" },
        ],
      }),
    },
    { want: ['① extra-files 里出现 "$..version"'] },
  );
  layerCase(
    "L07 ①d extra-files 目标不存在被抓（release-please 只打 warning 就跳过）",
    {
      fsFacts: {
        exists: (rel) => rel !== "packages/two/package.json",
        readText: () => "with x-release-please-version marker",
      },
    },
    { want: ["① extra-files 目标 packages/two/package.json 不存在", '"did not exist"'] },
  );
  layerCase(
    "L08 ①d generic 目标缺注解被抓（Generic updater 原样返回）",
    {
      fsFacts: {
        exists: () => true,
        readText: (rel) => (rel === "packages/py/__init__.py" ? '__version__ = "0.1.0"' : "ok x-release-please-version"),
      },
    },
    { want: ["① extra-files 目标 packages/py/__init__.py 缺 `x-release-please-version` 注解"] },
  );
  layerCase(
    "L09 ①e exclude-paths 里的死条目被抓（无 git 跟踪文件）",
    {
      rpConfig: withRoot({ "exclude-paths": ["apps", ".qodo"] }),
      fsFacts: {
        exists: () => true,
        readText: () => "x-release-please-version",
        isTracked: (rel) => rel !== ".qodo",
      },
    },
    { want: ['① root exclude-paths 里的 ".qodo" 没有任何 git 跟踪文件'] },
  );
  layerCase(
    "L10 ② 矩阵里有未覆盖的包被抓（级联 ①/③ 也成立）",
    { matrix: [...baseMatrix, { dir: "packages/three", pkg: "@x/three" }] },
    {
      want: [
        "② publish-npm 矩阵的 packages/three（@x/three）没有任何版本文件在 extra-files 广播面内",
        "③ @x/three（packages/three）不在 version-guard 校验清单里",
      ],
    },
  );
  layerCase(
    "L11 ③ 待发布包不在 version-guard 里被抓（「tag 版本 == 包版本」对该包是空闸）",
    { guardedDirs: new Set(["packages/one"]) },
    { want: ["③ @x/two（packages/two）不在 version-guard 校验清单里", "形同虚设"] },
  );
  layerCase(
    "L12 ④ root 线与包版本漂移被抓",
    {
      versions: {
        ".": "1.0.0",
        "packages/one": "1.0.1",
        "packages/two": "1.0.0",
        "packages/py": "0.1.0",
        "packages/py2": "0.1.0",
      },
    },
    { want: ["④ lockstep 单版本线不一致：root(.)=1.0.0", "packages/one=1.0.1"] },
  );
  layerCase(
    "L13 ④b 组内版本不一致被抓（py=0.1.0 vs py2=0.2.0）",
    {
      versions: {
        ".": "1.0.0",
        "packages/one": "1.0.0",
        "packages/two": "1.0.0",
        "packages/py": "0.1.0",
        "packages/py2": "0.2.0",
      },
    },
    { want: ["④ lockstep 组「py」内版本不一致", "py2=0.2.0"] },
  );
  layerCase(
    "L14 ④c 组内包没开 include-component-in-tag 被抓（getComponent() 返回 ''）",
    {
      rpConfig: {
        ...baseRp,
        packages: {
          ...baseRp.packages,
          "packages/py": { component: "py", "release-type": "python" },
        },
      },
    },
    { want: ['④ packages/py（component=py）在 linked-versions 组内，但没有 "include-component-in-tag": true'] },
  );
  layerCase(
    "L15 ⑤ 受管包漏进 manifest 被抓（基线丢失 = 版本退回 1.0.0）",
    { manifest: { ".": "1.0.0" } },
    {
      want: [
        "⑤ packages/py 在 release-please-config.json 里受管，却不在 release-please-manifest.json",
        "⑤ packages/py2 在 release-please-config.json 里受管，却不在 release-please-manifest.json",
      ],
    },
  );
  layerCase(
    "L16 ⑤ manifest 残留未受管条目被抓",
    { manifest: { ...baseManifest, "packages/gone": "1.0.0" } },
    { want: ["⑤ release-please-manifest.json 里的 packages/gone 不在 release-please-config.json"] },
  );
  layerCase("L17 ⑤ 不传 manifest 时跳过该层（向后兼容旧调用）", { manifest: undefined }, { empty: true });

  // CHANGELOG stub 层：一致 → 绿；过期 / 缺标记 → 逐包点名。
  const stubTree = (versionInStub) => {
    const files = {};
    for (const dir of CHANGELOG_STUB_DIRS) {
      files[`${dir}/package.json`] = { name: dir, version: "1.15.0" };
      files[`${dir}/CHANGELOG.md`] =
        versionInStub === null
          ? "# Changelog\n\n## [1.9.0] legacy\n"
          : `# Changelog\n\n<!-- stub-version: ${versionInStub} -->\n`;
    }
    return files;
  };
  const stubCase = (name, versionInStub, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(stubTree(versionInStub), { prefix: "release-stub-selftest-" });
        try {
          expectProblems(name, checkChangelogStubs(repo.dir), expect);
        } finally {
          repo.cleanup();
        }
      },
    });
  };
  stubCase("L18 CHANGELOG stub 版本与 manifest 一致 → 绿", "1.15.0", { empty: true });
  stubCase("L19 CHANGELOG stub 过期 → 红（四个包逐个点名，不是「有 4 条」）", "1.9.0", {
    want: CHANGELOG_STUB_DIRS.map((d) => `${d}/CHANGELOG.md 的 stub-version=1.9.0 与 manifest 版本 1.15.0 不一致`),
  });
  stubCase("L20 CHANGELOG 不是 stub（旧完整文件）→ 红", null, {
    want: CHANGELOG_STUB_DIRS.map((d) => `${d}/CHANGELOG.md 必须是 stub`),
  });

  // ── 第二部分：真子进程（退出码 + 文本 + 结构红 + 下界）──────────────────────
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "release-config-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 1000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess("S01 合规树（4 包 + py 组 + stub 对齐）→ 退出码 0", fixtureTree(), {
    code: 0,
    contains: ["release-config guard OK", "4 个待发布 npm 包"],
    absent: ["结构错误", "发布配置一致性问题"],
  });

  subprocess(
    "S02 ① 广播面漏一个 package.json → 退出码 1（闸真的关门）",
    fixtureTree({
      config: fixtureConfig({
        extraFiles: fixtureExtraFiles().filter((ef) => ef.path !== "/packages/two/package.json"),
      }),
    }),
    {
      code: 1,
      contains: ["① packages/two/package.json 不在 root 条目的 extra-files 里", "发布配置一致性问题"],
      absent: ["release-config guard OK"],
    },
  );

  subprocess(
    "S03 ③ 某待发布包不在 version-guard → 退出码 1",
    fixtureTree({ workflow: fixtureWorkflow({ guardedDirs: FIXTURE_NPM_DIRS.slice(0, 3) }) }),
    {
      code: 1,
      contains: ["③ @x/four（packages/four）不在 version-guard 校验清单里"],
      absent: ["release-config guard OK"],
    },
  );

  subprocess(
    "S04 ④ 包版本与 root 线漂移 → 退出码 1（tag 时才发现的漂移被提前到 PR）",
    fixtureTree({ npmVersions: { "packages/one": "1.0.1" } }),
    {
      code: 1,
      contains: ["④ lockstep 单版本线不一致：root(.)=1.0.0", "packages/one=1.0.1"],
      absent: ["release-config guard OK"],
    },
  );

  subprocess(
    "S05 ⑤ manifest 漏条目 → 退出码 1",
    fixtureTree({ manifest: { ".": FIXTURE_ROOT_VERSION, "packages/py": FIXTURE_PY_VERSION } }),
    {
      code: 1,
      contains: ["却不在 release-please-manifest.json", "⑤ packages/py2"],
      absent: ["release-config guard OK"],
    },
  );

  subprocess(
    "S06 CHANGELOG stub 忘记跟发版更新 → 退出码 1",
    fixtureTree({ stubVersions: { "packages/mcp-server": "1.9.0" } }),
    {
      code: 1,
      contains: ["packages/mcp-server/CHANGELOG.md 的 stub-version=1.9.0 与 manifest 版本 1.0.0 不一致"],
      absent: ["release-config guard OK"],
    },
  );

  subprocess("S07 事实源缺失（release-please-config.json 不在）→ 结构红并点名路径", fixtureTree({ omit: [CONFIG_FILE] }), {
    code: 1,
    contains: ["结构错误", `事实源缺失：${CONFIG_FILE}`],
    absent: ["release-config guard OK", "ENOENT", "Error:"],
  });

  subprocess("S08 事实源缺失（version.txt 不在）→ 结构红（版本线读不到 ≠ 已对齐）", fixtureTree({ rootVersion: null }), {
    code: 1,
    contains: ["结构错误", "事实源缺失：version.txt"],
    absent: ["release-config guard OK"],
  });

  subprocess(
    "S09 【反证·扫描面下界】release.yml 矩阵只剩 1 个包 → 结构红（不是「无一漏配」）",
    fixtureTree({ workflow: fixtureWorkflow({ matrixDirs: ["packages/one"] }) }),
    {
      code: 1,
      contains: ["只解析出 1 个待发布包", `下界 ${MIN_MATRIX_PACKAGES}`, "永真断言"],
      absent: ["release-config guard OK", "发布配置一致性问题"],
    },
  );

  subprocess(
    "S10 【反证·口径塌方】release.yml 没有 publish-npm job → 结构红（矩阵解析失败不许冒充绿）",
    fixtureTree({ workflow: "name: release\njobs:\n  version-guard:\n    steps:\n      - run: echo v\n" }),
    {
      code: 1,
      contains: ["结构错误", "找不到 publish-npm job"],
      absent: ["release-config guard OK"],
    },
  );

  const failed = reportCases(cases, { title: "check-release-config selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    selftest();
  } else {
    const rootArg = argValue(argv, "--root");
    process.exit(run({ root: rootArg ? resolve(rootArg) : DEFAULT_ROOT }));
  }
}
