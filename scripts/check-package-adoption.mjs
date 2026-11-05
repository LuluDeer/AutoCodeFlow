#!/usr/bin/env node
/**
 * 「包必须有人用」守卫 —— 治「**零清单包从判据里消失**」这一**类**。
 *
 * ## 由来
 *
 * `packages/` 下不是每个目录都能被现有判据看见。现有判据族（`check-publishable-wiring`、
 * `release.yml` 的 version-guard、publish 矩阵）的入口都是「**有清单**」：
 * 有 `pyproject.toml`，或 `package.json` 且非 `private`。于是三类包**同时从所有判据里
 * 消失**，且没有任何东西会注意到它们的消失：
 *
 *   · **数据包 / 契约包**：`packages/executor-protocol/`（只有 protocol.json +
 *     device-identity.vectors.json）、`packages/contract-fixtures/`（只有 contract.json
 *     + generated/）—— 没有清单，所以「可发布性」这一列对它们恒为「不适用」；
 *   · **private 包**：`packages/docs-site/`（`package.json` 里 `private: true`）——
 *     有清单但被显式排除在发布判定之外。
 *
 * 「不适用」和「合规」在报告里长得一样，这就是本守卫要治的东西。**一个包可以是
 * 数据包、可以是 private、可以只被 CI 读 —— 但它必须能回答「谁在用我」**。
 *
 * ## 判据
 *
 * 扫描面：**只到 `packages/*`**（11 个包目录，2026-11-04 实测）。
 * **`apps/*` 整层豁免**：它们是部署单元，不是被依赖的库；现有判据（release.yml /
 * check-publishable-wiring）也不按「有没有消费者」判 apps。若把 apps 扩进来，
 * `apps/registry-npm` / `apps/executor-python` 这类没有清单的部署单元会立刻噪声红 ——
 * 判据的**作用域必须和它的语义一致**，否则守卫只会被加进豁免名单。
 *
 * 每个 `packages/<name>/` 必须**四选一**：
 *
 *   ① **被 import**：包外的源码里出现该包名（含 `-`→`_` 的 Python 形态、以及
 *      清单里的 `name` 字段，例如 `@autocodeflow/sdk`）；
 *   ② **被声明为依赖**：包外的 `package.json`（dependencies / devDependencies /
 *      peerDependencies / optionalDependencies）或 `pyproject.toml`
 *      （`[project] dependencies` / `optional-dependencies`）里出现该包名；
 *   ③ **在发布线上**：有清单（`package.json` 或 `pyproject.toml`）且不是 `private: true`
 *      —— 这一类的「接线细节」由 `check-publishable-wiring.mjs` 负责，本守卫**不重复判**
 *      （重复判会让两个守卫对同一事实各有一套口径，改一处忘一处）；
 *   ④ **登记为「无消费者」**：进 `scripts/package-kinds.json`，条目必须给
 *      `{ kind, consumers[], why }`，且**至少 1 条 consumer 文件真实存在、文件内真的
 *      出现该包名或它的唯一产物名**（`artifacts[]`）。光写一个路径不算证据 ——
 *      consumer 必须是「能打开、能指出一行」的事实，否则豁免表只是许愿池。
 *
 * 反向（防豁免表腐烂）：
 *   · 登记了但 `packages/<name>/` **已不存在** ⇒ 红；
 *   · 登记了但**所有 consumer 文件都不存在** ⇒ 红；
 *   · 登记了但 consumer 文件里**找不到该包名/产物名** ⇒ 红（"我指向一个文件，但文件里没有它"）；
 *   · 条目缺 `kind` / `why` / `consumers` ⇒ 红。
 *
 * 反永真：包目录数 < `MIN_PACKAGES`（8）⇒ **结构红**。扫不到包的时候
 * 「全部都有人用」是分母塌掉造成的假象。
 *
 * ## 已知会落 ④（首跑即在此，不是失败）
 *
 *   · `executor-protocol` → `kind: contract-source`，产物 `protocol.json`
 *   · `contract-fixtures`  → `kind: fixtures`，产物 `contract.json`
 *   · `docs-site`         → `kind: internal-docs`（`package.json` private）
 *
 * ## 用法
 *
 *   node scripts/check-package-adoption.mjs [--report] [--selftest] [--root <dir>]
 *   --report  ：打印每个包的归属（④ 条目还打印 consumer 命中行），随后仍按判据退出
 *   --selftest：在临时 fixture 树里跑**真子进程**，断言退出码 + 关键文本
 *   --root    ：只给 selftest 用（把 fixture 树当仓库根；默认 `process.cwd()`）
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expectExit,
  expectRequiredFieldsInJson,
  makeFixtureRepo,
  reportCases,
  runGuard,
} from "./lib/guard-selftest.mjs";
import {
  compareEntry,
  readRatchetBaseline,
  renderExpired,
  renderOverLimit,
  sweepBaseline,
  utcDay,
} from "./lib/ratchet-baseline.mjs";

/** 被扫描的包目录。**只到 `packages/`**，`apps/` 整层豁免（见文件头）。 */
export const PKGS_REL = "packages";
/** ④ 的登记表。 */
export const KINDS_REL = "scripts/package-kinds.json";

/** 扫描面下界（2026-11-04 实测 11）。只许增。 */
export const MIN_PACKAGES = 8;

/** `why` 的最小长度：短于此的等于没写理由。 */
export const MIN_WHY_LEN = 24;

/**
 * ④ 登记条目的必填字段（A8，2026-11-04 与 check-version-line / check-publishable-wiring 对齐）。
 *
 * 只写 `why` 是不够的：一条没有 owner、没有复核期限的豁免就是**无限期豁免**，
 * 而「无限期」正是这张表变成没人看的名单的方式。期限判定与文案在
 * `scripts/lib/ratchet-baseline.mjs`（9 个基线共用同一句话，别在这里另写一套）。
 */
export const REQUIRED_FIELDS = ["owner", "review_by"];

/** 参与 ① 扫描的源码扩展名（清单/文档/YAML 由 ② 和 ④ 的 consumer 证据负责）。 */
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"]);

/** 递归扫描时整目录跳过的名字。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".venv",
  "dist",
  "build",
  "coverage",
  ".git",
  "generated",
  "__pycache__",
  ".next",
  ".turbo",
]);

/** 单文件大小上限（超过的当二进制/产物，不读）。 */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * 判据 ① 的「这算不算**运行时**消费」过滤器：测试与示例里的 import **不算**。
 *
 * 为什么：本仓 `apps/executor-node/src/protocol-schemas.spec.ts` 会
 * `import … from "../../../packages/executor-protocol/protocol.json"` —— 这是**测试**在读
 * 契约文件，不是运行时消费（`executor.service.ts` 之类里一个字节都不读它）。若把测试
 * import 算成 ①，`executor-protocol` / `contract-fixtures` 这类「运行时零消费、只被测试
 * 与生成器读」的数据包会全部被判成「被 import」，④（无消费者登记）整类就此消失 ——
 * 而这一类恰恰是本守卫存在的理由。
 *
 * 方向是**变严**：过滤只会让包更难满足 ①，更容易落 ④，而 ④ 要求可证的 consumer 证据。
 */
const TEST_PATH_RE = /(^|\/)(__tests__|__mocks__|tests?|examples?|fixtures)\/|(\.spec\.|\.test\.|_test\.py$|\.stories\.)/;

const toPosix = (p) => p.split(sep).join("/");

function readText(abs) {
  try {
    if (statSync(abs).size > MAX_FILE_BYTES) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * 从源码里抽**模块说明符**（import / from / require / import() 的字符串），用于判据 ①。
 *
 * 为什么必须抽说明符而不是「文件里出现过包名」：本仓的守卫脚本里大量出现
 * `packages/executor-protocol/protocol.json` 这样的**路径字符串**。若按子串匹配，
 * 数据包会因为「有个守卫提过它的路径」而被判成「被 import」—— 那正好把 ④（无消费者登记）
 * 整类吃掉，判据就退化成了「凡是被提到过就算有人用」。所以 ① 的口径是
 * **真的 import 了它（裸说明符 / `packages/<name>/…` 路径 import）**，不是「文档里提过」。
 */
const JS_SPEC_RE =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)["'`]([^"'`\n]+)["'`]/g;
const PY_IMPORT_RE =
  /^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)[ \t]+import|import[ \t]+([A-Za-z_][\w., \t]*))/gm;

/**
 * 剥注释。**必须剥**：`scripts/check-package-adoption.mjs` 自己的文件头就有一句
 * `import … from "../../../packages/executor-protocol/protocol.json"` 作为**说明文字**，
 * 不剥的话这个守卫会把自己的注释当成「executor-protocol 被 import 了」的证据 ——
 * 「注释算代码」是本仓抓过多次的假绿形态（见 check-image-pinned / check-guards-wired）。
 *
 * 口径刻意粗糙（块注释 + 行注释 + Python `#`）：过度剥离只会**少**抽到说明符，
 * 方向是变严（更难满足 ①），不会造成误绿。
 */
export function stripComments(text, ext) {
  let out = String(text ?? "").replace(/\/\*[\s\S]*?\*\//g, " ");
  if (ext === ".py") {
    out = out
      .split(/\r?\n/)
      .map((line) => {
        const idx = line.indexOf("#");
        return idx < 0 ? line : line.slice(0, idx);
      })
      .join("\n");
  } else {
    out = out
      .split(/\r?\n/)
      .map((line) => {
        const idx = line.indexOf("//");
        return idx < 0 ? line : line.slice(0, idx);
      })
      .join("\n");
  }
  return out;
}

function extractSpecifiers(text, ext) {
  const specs = [];
  const body = stripComments(text, ext);
  JS_SPEC_RE.lastIndex = 0;
  let m;
  while ((m = JS_SPEC_RE.exec(body)) !== null) specs.push(m[1].trim());
  PY_IMPORT_RE.lastIndex = 0;
  while ((m = PY_IMPORT_RE.exec(body)) !== null) {
    if (m[1]) specs.push(m[1].trim());
    if (m[2]) {
      for (const part of m[2].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) specs.push(name);
      }
    }
  }
  return specs;
}

/** 一个说明符是否指向该包。 */
export function specifierMatches(spec, alias) {
  if (spec === alias) return true;
  // 裸说明符的子路径：`<alias>/sub`（JS）或 `<alias>.sub`（Python 点号模块路径）
  if (spec.startsWith(`${alias}/`) || spec.startsWith(`${alias}.`)) return true;
  // monorepo 里直接按路径 import：`../../packages/<alias>/src/index`
  const needle = `/packages/${alias}/`;
  if (spec.includes(needle) || spec.endsWith(`/packages/${alias}`)) return true;
  return false;
}

/**
 * 递归收集仓库里的源码文件（相对路径 posix + 已抽好的模块说明符），用于判据 ①。
 *
 * 说明符**只抽一次**并缓存：11 个包 ×「包外全部源码」若各自重新读盘 + 重跑正则，
 * 在 2000+ 文件的仓里会慢到没人愿意跑。
 */
export function collectSourceCorpus(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0) continue;
      if (!SOURCE_EXT.has(entry.name.slice(dot))) continue;
      const text = readText(abs);
      if (text === null) continue;
      const rel = toPosix(relative(root, abs));
      const ext = entry.name.slice(dot);
      files.push({
        rel,
        isTest: TEST_PATH_RE.test(rel),
        specs: extractSpecifiers(text, ext),
      });
    }
  };
  walk(root);
  return files;
}

/** 递归收集清单文件（package.json / pyproject.toml），用于判据 ②③。 */
export function collectManifests(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (entry.name !== "package.json" && entry.name !== "pyproject.toml") continue;
      out.push({ rel: toPosix(relative(root, abs)), abs, name: entry.name });
    }
  };
  walk(root);
  return out;
}

/** 一个包的匹配别名集合（目录名的 `-`/`_` 两种形态 + 清单里的 name）。 */
export function aliasesOf(name, pkgDir) {
  const set = new Set([name, name.replace(/-/g, "_")]);
  const pkgJson = join(pkgDir, "package.json");
  if (existsSync(pkgJson)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgJson, "utf8"));
      if (typeof parsed.name === "string" && parsed.name.trim() !== "") set.add(parsed.name.trim());
    } catch {
      // 清单坏了由 check-version-line / check-publishable-wiring 判红，这里不重复报
    }
  }
  return [...set];
}

/** 清单里的依赖声明里是否出现该名字。 */
function isDeclaredIn(manifestAbs, manifestName, aliases) {
  const text = readText(manifestAbs);
  if (text === null) return false;
  if (manifestName === "package.json") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = parsed?.[field];
      if (!deps || typeof deps !== "object") continue;
      for (const dep of Object.keys(deps)) {
        if (aliases.includes(dep)) return true;
      }
    }
    return false;
  }
  // pyproject.toml：只认 [project] 的 dependencies / optional-dependencies 段里的字符串
  const relevant = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  for (const alias of aliases) {
    const re = new RegExp(`["']\\s*${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:[<>=!~\\[;,"'])`);
    if (re.test(relevant)) return true;
  }
  return false;
}

/** 判断一个包是否有清单、是否 private。 */
function manifestState(pkgDir) {
  const hasPy = existsSync(join(pkgDir, "pyproject.toml"));
  const pkgJson = join(pkgDir, "package.json");
  const hasPkg = existsSync(pkgJson);
  let privateFlag = false;
  if (hasPkg) {
    try {
      privateFlag = JSON.parse(readFileSync(pkgJson, "utf8")).private === true;
    } catch {
      privateFlag = false;
    }
  }
  return { hasManifest: hasPy || hasPkg, privateFlag };
}

/**
 * 读 ④ 的登记表。
 *
 * @returns {{entries: Record<string, object>|null, error: string|null}}
 */
export function readKinds(root) {
  // 读文件 / JSON 不可解析 / 形状非法 —— 三种「判据不可信」都由共用件判，
  // 本函数只保留「这张表叫什么」这一层包装（调用方拿 `{ entries, error }`）。
  const { map, error } = readRatchetBaseline({ root, rel: KINDS_REL, kind: "map", label: "登记表" });
  return { entries: map, error };
}

/**
 * 校验一条 ④ 登记，返回 { findings, hits }。
 * findings 为空表示这条登记**可证**。
 */
function validateRegistration({ name, entry, root }) {
  const findings = [];
  const hits = [];

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { findings: [`${KINDS_REL} 里 "${name}" 的条目不是对象 —— 登记腐烂了。`], hits };
  }
  if (typeof entry.kind !== "string" || entry.kind.trim() === "") {
    findings.push(`${KINDS_REL} 里 "${name}" 缺 kind（这条豁免属于哪一类？数据包 / 契约源 / 文档站…）。`);
  }
  const why = typeof entry.why === "string" ? entry.why.trim() : "";
  if (why.length < MIN_WHY_LEN) {
    findings.push(
      `${KINDS_REL} 里 "${name}" 的 why 太短（${why.length} < ${MIN_WHY_LEN} 字符）—— 短理由等于没有理由。`,
    );
  }
  const consumers = Array.isArray(entry.consumers) ? entry.consumers : null;
  if (consumers === null || consumers.length === 0) {
    findings.push(`${KINDS_REL} 里 "${name}" 缺 consumers[] —— 「谁在用我」必须至少有一个具体证据文件。`);
    return { findings, hits };
  }

  const artifacts = (Array.isArray(entry.artifacts) ? entry.artifacts : []).filter(
    (a) => typeof a === "string" && a.trim() !== "",
  );
  const aliases = [name, name.replace(/-/g, "_"), ...artifacts];
  const missing = [];
  const unproven = [];

  for (const consumer of consumers) {
    if (typeof consumer !== "string" || consumer.trim() === "") {
      findings.push(`${KINDS_REL} 里 "${name}" 的 consumers 含非字符串/空值：${JSON.stringify(consumer)}`);
      continue;
    }
    const abs = join(root, consumer);
    if (!existsSync(abs)) {
      missing.push(consumer);
      continue;
    }
    const text = readText(abs);
    if (text === null) {
      missing.push(`${consumer}（读不到：二进制或超大文件）`);
      continue;
    }
    const hit = aliases.find((alias) => text.includes(alias));
    if (!hit) {
      unproven.push(consumer);
    } else {
      hits.push({ consumer, hit });
    }
  }

  if (missing.length > 0) {
    findings.push(
      `${KINDS_REL} 里 "${name}" 的 consumer 文件不存在/不可读：${missing.join("、")} —— ` +
        `豁免指向一个不存在的证据，等于没有证据。`,
    );
  }
  if (unproven.length > 0) {
    findings.push(
      `${KINDS_REL} 里 "${name}" 的 consumer 文件里既没有包名（${aliases.join(" / ")}）也没有产物名：` +
        `${unproven.join("、")} —— 「指向一个文件」不等于「文件里真的用到它」。`,
    );
  }
  if (missing.length === 0 && unproven.length === 0 && hits.length === 0) {
    findings.push(`${KINDS_REL} 里 "${name}" 没有一条可证的 consumer。`);
  }
  return { findings, hits };
}

/**
 * 判据本体。
 *
 * @param {{root?: string}} [options]
 * @returns {{errors: string[], problems: string[], warnings: string[], rows: object[], counts: object}}
 */
export function check({ root = process.cwd(), today = utcDay() } = {}) {
  const errors = [];
  const problems = [];
  const warnings = [];
  const rows = [];
  const counts = { packages: 0, imported: 0, declared: 0, releaseLine: 0, registered: 0, root };

  let dirents;
  try {
    dirents = readdirSync(join(root, PKGS_REL), { withFileTypes: true });
  } catch (error) {
    errors.push(
      `读不到目录 ${PKGS_REL}/（${error.code ?? error.message}）—— 扫描面为 0，不是「所有包都有人用」。`,
    );
    return { errors, problems, warnings, rows, counts };
  }
  const all = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
  counts.packages = all.length;
  if (all.length < MIN_PACKAGES) {
    errors.push(
      `只扫到 ${all.length} 个包目录（下界 ${MIN_PACKAGES}）—— 扫描器/路径失效了，不是包变少了。`,
    );
    return { errors, problems, warnings, rows, counts };
  }

  const kinds = readKinds(root);
  if (kinds.error) {
    errors.push(kinds.error);
    return { errors, problems, warnings, rows, counts };
  }
  const entries = kinds.entries;

  const corpus = collectSourceCorpus(root);
  const manifests = collectManifests(root);

  for (const name of all) {
    const pkgDir = join(root, PKGS_REL, name);
    const ownPrefix = `${PKGS_REL}/${name}/`;
    const aliases = aliasesOf(name, pkgDir);
    const { hasManifest, privateFlag } = manifestState(pkgDir);

    // ① 被 import（包外源码里**真的 import 了**它，见 extractSpecifiers 头注）
    const importHits = corpus
      .filter((f) => !f.rel.startsWith(ownPrefix) && !f.isTest)
      .filter((f) => f.specs.some((spec) => aliases.some((a) => specifierMatches(spec, a))))
      .map((f) => f.rel);

    // ② 被声明为依赖（包外清单里）
    const declaredIn = manifests
      .filter((m) => !m.rel.startsWith(ownPrefix))
      .filter((m) => isDeclaredIn(m.abs, m.name, aliases))
      .map((m) => m.rel);

    // ③ 在发布线上（有清单且非 private）
    const releaseLine = hasManifest && !privateFlag;

    const status = importHits.length > 0
      ? "imported"
      : declaredIn.length > 0
        ? "declared"
        : releaseLine
          ? "release-line"
          : entries[name]
            ? "registered"
            : "orphan";

    const row = { name, status, hasManifest, privateFlag, importHits, declaredIn };
    rows.push(row);

    if (status === "imported") {
      counts.imported += 1;
      continue;
    }
    if (status === "declared") {
      counts.declared += 1;
      continue;
    }
    if (status === "release-line") {
      counts.releaseLine += 1;
      continue;
    }

    if (status === "registered") {
      counts.registered += 1;
      // ② 逐条比对：必填字段（owner / review_by）+ 期限 —— 判据与文案都在共用件里。
      const shape = compareEntry({
        at: `packages/${name}`,
        noun: "登记",
        entry: entries[name],
        rel: KINDS_REL,
        label: "登记表",
        requiredFields: REQUIRED_FIELDS,
        today,
      });
      if (shape.incomplete !== null || shape.badDate !== null) {
        for (const f of shape.findings) problems.push(f);
        continue;
      }
      if (shape.expired) {
        problems.push(renderExpired({ at: `packages/${name}`, entry: entries[name], today }));
        continue;
      }
      const { findings, hits } = validateRegistration({ name, entry: entries[name], root });
      row.hits = hits;
      for (const f of findings) problems.push(f);
      continue;
    }

    // orphan：没有任何一类能证明它被用到
    problems.push(
      renderOverLimit({
        key: `packages/${name}`,
        rel: KINDS_REL,
        detail:
          `**四类都不满足**：包外源码里没有它（①）、没有任何清单声明它（②）、` +
          `${hasManifest ? "它有清单但是 private（③ 不成立）" : "它没有清单（③ 不成立）"}、` +
          `也没有登记进 ${KINDS_REL}（④）。\n` +
          `      这类包会同时从**所有**判据里消失（既有判据的入口都是「有清单且非 private」）。`,
        fix:
          `修法：① 让它被真正使用；② 在某个清单里声明它；或 ③ 在 ${KINDS_REL} 登记\n` +
          `        "${name}": { "kind": "<类别>", "artifacts": ["<唯一产物>"], "consumers": ["<仓库相对路径>"], "owner": "<负责人>", "review_by": "<YYYY-MM-DD>", "why": "<≥${MIN_WHY_LEN} 字符，说明为什么允许它没有运行时消费者>" }`,
      }),
    );
  }

  // ── 反向：登记表不许腐烂 / 不许变成永久豁免 ──────────────────────────
  // `missing`   = 包目录没了 ⇒ 基线腐烂；`satisfied` = 这个包已经重新被 ①②③ 证明了
  // ⇒ 登记已经不需要，按棘轮**必须删掉**（否则「只增不减」的名单迟早没人看）。
  const state = new Map();
  for (const name of Object.keys(entries)) {
    if (!all.includes(name)) state.set(name, "missing");
    else if (rows.find((r) => r.name === name)?.status !== "registered") state.set(name, "satisfied");
  }
  problems.push(
    ...sweepBaseline({
      list: Object.keys(entries).map((key) => ({ key })),
      state,
      rel: KINDS_REL,
      label: "登记表",
      detailOf: (key, status) =>
        status === "missing"
          ? `但 packages/${key}/ **已不存在**`
          : `但 packages/${key} 已经重新有「谁在用我」的证据（①/②/③ 之一成立）`,
      fixOf: (_key, status) =>
        status === "missing"
          ? "删掉这条（豁免必须可证，指向空气的条目会让整张表失去意义）。"
          : "删掉这条登记（棘轮只减不增：判据已经不需要它了）。",
    }),
  );

  return { errors, problems, warnings, rows, counts };
}

// ── CLI ────────────────────────────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const STATUS_LABEL = {
  imported: "① 被 import",
  declared: "② 被声明为依赖",
  "release-line": "③ 在发布线上",
  registered: "④ 已登记",
  orphan: "✘ 四类都不满足",
};

function printReport({ rows, counts }) {
  console.log(
    `包目录 ${counts.packages} 个：① import ${counts.imported}、② 依赖声明 ${counts.declared}、` +
      `③ 发布线 ${counts.releaseLine}、④ 登记 ${counts.registered}`,
  );
  for (const row of rows) {
    const extra =
      row.status === "registered"
        ? ` consumers=${(row.hits ?? []).map((h) => `${h.consumer}（命中 ${h.hit}）`).join("; ") || "无"}`
        : row.importHits?.length
          ? ` e.g. ${row.importHits[0]}`
          : row.declaredIn?.length
            ? ` e.g. ${row.declaredIn[0]}`
            : "";
    console.log(`  · packages/${row.name.padEnd(22)} ${STATUS_LABEL[row.status] ?? row.status}${extra}`);
  }
}

function runCli(root, { report }) {
  const { errors, problems, warnings, rows, counts } = check({ root });

  if (report) printReport({ rows, counts });

  if (errors.length > 0) {
    console.error("");
    console.error("✖ 包采纳自检结构错误（判据本身不可信）：");
    for (const e of errors) console.error("  · " + e);
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error("");
    console.error(`✖ ${problems.length} 个包「没人用」且没有合法登记，或登记已腐烂：`);
    for (const p of problems) console.error("  · " + p);
    process.exit(1);
  }

  for (const w of warnings) console.log(`  ⚠ ${w}`);
  console.log(
    `✔ 包采纳自检通过：${counts.packages} 个包目录全部有「谁在用我」的可证答案` +
      `（① import ${counts.imported}、② 依赖声明 ${counts.declared}、③ 发布线 ${counts.releaseLine}、④ 登记 ${counts.registered}）。`,
  );
}

// ── 自检（真子进程：退出码 + 关键文本）────────────────────────────────────
const FIXTURE_PKGS = [
  "pkg-alpha",
  "pkg-beta",
  "pkg-gamma",
  "pkg-delta",
  "pkg-epsilon",
  "pkg-zeta",
  "pkg-eta",
  "pkg-theta",
];

/**
 * 造一棵 fixture 仓库树。
 *
 * 默认：8 个包目录，全部是「有清单且非 private」⇒ 全部落 ③ ⇒ 绿。
 * 用例再逐条改造成 ①/②/④/orphan/结构塌陷。
 *
 * @param {object} [opts]
 */
function fixtureTree({
  entries = {},
  noRegistry = false,
  registryRaw = null,
  extraFiles = {},
  dropPkgs = [],
  pkgFiles = {},
  noManifest = [],
} = {}) {
  const files = {};
  for (const name of [...FIXTURE_PKGS, ...Object.keys(pkgFiles)]) {
    if (dropPkgs.includes(name) || noManifest.includes(name)) continue;
    files[`packages/${name}/package.json`] = {
      name,
      version: "2.1.0",
      ...(pkgFiles[name] ?? {}),
    };
  }
  for (const name of noManifest) {
    // 数据包：目录存在（由下面任意一个文件把它撑出来），但**没有任何清单**
    files[`packages/${name}/README.md`] = `# ${name}\n`;
  }
  files[KINDS_REL] = registryRaw !== null ? registryRaw : { $comment: "fixture", entries };
  if (noRegistry) delete files[KINDS_REL];
  return { ...files, ...extraFiles };
}

function runSelftest() {
  const cases = [];

  // R64：**夹具-必需项一致性**（形态：必需项是 **JSON 字段名** owner/review_by，夹具是 package-kinds.json）
  // ⇒ 用 `expectRequiredFieldsInJson`；反向验证**对副本删字段**（不动共享 fixture）。
  cases.push({
    name: "R64：package-kinds 夹具覆盖 REQUIRED_FIELDS（owner/review_by）",
    fn: () => {
      const files = fixtureTree({
        entries: { a: { kind: "lib", artifacts: ["x"], consumers: ["README.md"], owner: "w1", review_by: "2026-12-31", why: "因为没有一个运行时消费者需要它，仅被构建脚本引用" } },
      });
      const raw = files[KINDS_REL];
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      const ok = expectRequiredFieldsInJson(REQUIRED_FIELDS, { [KINDS_REL]: text }, /package-kinds\.json$/);
      if (ok.length > 0) throw new Error(`完整夹具应全覆盖，却报：${ok.join("；")}`);
      const prunedObj = JSON.parse(text);
      for (const e of Object.values(prunedObj.entries ?? {})) delete e.review_by;
      const miss = expectRequiredFieldsInJson(REQUIRED_FIELDS, { [KINDS_REL]: JSON.stringify(prunedObj) }, /package-kinds\.json$/);
      if (miss.length === 0) throw new Error("删掉 review_by 后助手仍报全覆盖 ⇒ 判据没牙");
      if (!miss.some((m) => m.includes("review_by"))) throw new Error(`助手没有点名 review_by：${miss.join("；")}`);
    },
  });

  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "package-adoption-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 2000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  // ① 正例：全部有清单且非 private → ③ → 绿
  subprocess("① 正例：8 个包全都在发布线上（有清单非 private）→ 绿", fixtureTree({}), {
    code: 0,
    contains: ["包采纳自检通过", "8 个包目录", "③ 发布线 8"],
    absent: ["四类都不满足", "结构错误", "登记表腐烂"],
  });

  // ② 正例：被 import（包外源码出现包名）→ 绿
  subprocess(
    "② 正例：private 包被包外源码 import → 绿（① 命中）",
    fixtureTree({
      pkgFiles: { "pkg-alpha": { private: true } },
      extraFiles: {
        "apps/someone/src/use.ts": 'import { x } from "pkg-alpha";\n',
      },
    }),
    {
      code: 0,
      contains: ["包采纳自检通过", "① import 1", "③ 发布线 7"],
      absent: ["四类都不满足"],
    },
  );

  // ③ 正例：被声明为依赖 → 绿
  subprocess(
    "③ 正例：private 包被别的清单声明为依赖 → 绿（② 命中）",
    fixtureTree({
      pkgFiles: { "pkg-beta": { private: true } },
      extraFiles: {
        "apps/consumer/package.json": {
          name: "consumer",
          dependencies: { "pkg-beta": "^1.0.0" },
        },
      },
    }),
    {
      code: 0,
      contains: ["包采纳自检通过", "② 依赖声明 1"],
      absent: ["四类都不满足"],
    },
  );

  // ④ 正例：登记的 consumer 存在且文件里出现唯一产物名 → 绿
  subprocess(
    "④ 正例：无清单的数据包已登记且 consumer 文件里真有产物名 → 绿",
    fixtureTree({
      extraFiles: {
        "packages/pkg-gamma/protocol.json": '{ "v": 1 }\n',
        "scripts/reader.mjs": 'const p = "packages/pkg-gamma/protocol.json";\n',
      },
      noManifest: ["pkg-gamma"],
      entries: {
        "pkg-gamma": {
          owner: "executor-parity",
          review_by: "2099-12-31",
          kind: "contract-source",
          artifacts: ["protocol.json"],
          consumers: ["scripts/reader.mjs"],
          why: "契约单一事实源，只有生成器和契约测试读它，没有运行时消费者",
        },
      },
    }),
    {
      code: 0,
      contains: ["包采纳自检通过", "④ 登记 1"],
      absent: ["四类都不满足", "登记表腐烂"],
    },
  );

  // ⑤ 反例：既没消费者也没登记 → 红，点名包
  subprocess(
    "⑤ 反例：private 包既无消费者也无登记 → 红（点名包）",
    fixtureTree({ pkgFiles: { "pkg-delta": { private: true } } }),
    {
      code: 1,
      contains: ["pkg-delta", "四类都不满足", "没有任何清单声明它"],
      absent: ["包采纳自检通过"],
    },
  );

  // ⑥ 结构塌陷：包目录太少 → 结构红
  subprocess(
    "⑥ 结构塌陷：只扫到 3 个包目录 → 结构红（分母塌了不是「全都有消费者」）",
    (() => {
      const files = fixtureTree({});
      for (const name of FIXTURE_PKGS.slice(3)) delete files[`packages/${name}/package.json`];
      return files;
    })(),
    {
      code: 1,
      contains: ["结构错误", "只扫到 3 个包目录", "下界 8"],
      absent: ["包采纳自检通过"],
    },
  );

  // ⑦ 反向：登记表腐烂（包目录已不存在）→ 红
  subprocess(
    "⑦ 反向：登记的包目录已不存在 → 红（登记表腐烂）",
    fixtureTree({
      entries: {
        "pkg-removed": {
          owner: "executor-parity",
          review_by: "2099-12-31",
          kind: "fixtures",
          artifacts: ["x.json"],
          consumers: ["package.json"],
          why: "这个包早就被删了，但登记没回收",
        },
      },
    }),
    {
      code: 1,
      contains: ["pkg-removed", "已不存在", "登记表腐烂"],
      absent: ["包采纳自检通过"],
    },
  );

  // ⑧ 反向：consumer 文件不存在 → 红
  subprocess(
    "⑧ 反向：登记指向的 consumer 文件不存在 → 红（豁免指向空气）",
    fixtureTree({
      pkgFiles: { "pkg-eta": { private: true } },
      entries: {
        "pkg-eta": {
          owner: "docs-site",
          review_by: "2099-12-31",
          kind: "internal-docs",
          artifacts: ["index.md"],
          consumers: ["docs/does-not-exist.md"],
          why: "文档站私有包，消费方是本仓的文档构建流程（fixture）",
        },
      },
    }),
    {
      code: 1,
      contains: ["pkg-eta", "consumer 文件不存在", "does-not-exist.md"],
      absent: ["包采纳自检通过"],
    },
  );

  // ⑨ 反向：consumer 存在但文件里没有该包名/产物名 → 红（"指向文件" ≠ "文件里真的用了"）
  subprocess(
    "⑨ 反向：consumer 存在但里面对不上包名/产物名 → 红",
    fixtureTree({
      pkgFiles: { "pkg-theta": { private: true } },
      extraFiles: { "scripts/unrelated.mjs": "console.log('nothing to see');\n" },
      entries: {
        "pkg-theta": {
          owner: "docs-site",
          review_by: "2099-12-31",
          kind: "internal-docs",
          artifacts: ["index.md"],
          consumers: ["scripts/unrelated.mjs"],
          why: "文档站私有包，消费方是本仓的文档构建流程（fixture）",
        },
      },
    }),
    {
      code: 1,
      contains: ["pkg-theta", "也没有产物名", "unrelated.mjs"],
      absent: ["包采纳自检通过"],
    },
  );

  // ⑩ 登记条目缺 why → 红
  subprocess(
    "⑩ 登记条目 why 太短/缺失 → 红（短理由等于没理由）",
    fixtureTree({
      pkgFiles: { "pkg-epsilon": { private: true } },
      extraFiles: { "scripts/tiny.mjs": "// pkg-epsilon\n" },
      entries: {
        "pkg-epsilon": {
          owner: "docs-site",
          review_by: "2099-12-31",
          kind: "internal-docs",
          consumers: ["scripts/tiny.mjs"],
          why: "todo",
        },
      },
    }),
    {
      code: 1,
      contains: ["pkg-epsilon", "why 太短"],
      absent: ["包采纳自检通过"],
    },
  );

  // ⑪ 登记表不可解析 → 结构红
  subprocess(
    "⑪ 登记表不可解析 → 结构红（读不到 ≠ 没问题）",
    fixtureTree({ registryRaw: "{ 坏掉的登记表" }),
    {
      code: 1,
      contains: ["结构错误", "不可解析"],
      absent: ["包采纳自检通过"],
    },
  );

  // ⑫ 登记表缺失 → 结构红
  subprocess(
    "⑫ 缺 package-kinds.json → 结构红",
    fixtureTree({ noRegistry: true }),
    {
      code: 1,
      contains: ["结构错误", "读不到 scripts/package-kinds.json"],
      absent: ["包采纳自检通过"],
    },
  );

  // ⑬ `apps/` 整层不参与判据：apps 下没有清单的部署单元不该噪声红
  subprocess(
    "⑬ apps/ 整层豁免：apps 下无清单的目录不产生任何问题 → 绿",
    fixtureTree({
      extraFiles: {
        "apps/registry-npm/index.js": "module.exports = {};\n",
        "apps/executor-python/main.py": "print('x')\n",
      },
    }),
    {
      code: 0,
      contains: ["包采纳自检通过"],
      absent: ["apps/registry-npm", "apps/executor-python"],
    },
  );

  // ⑭ 注释里的 import 不算 ①（本守卫自己的文件头就有这么一句说明文字）
  subprocess(
    "⑭ 注释里的 `import … from \"<包名>\"` 不算被 import → 落 ④ → 未登记即红",
    fixtureTree({
      pkgFiles: { "pkg-alpha": { private: true } },
      extraFiles: {
        "scripts/mentions.mjs": [
          "/**",
          ' * 说明：apps 里的用法是 import x from "pkg-alpha"。',
          " */",
          "// import y from \"pkg-alpha\"",
          "export const z = 1;",
          "",
        ].join("\n"),
      },
    }),
    {
      code: 1,
      contains: ["pkg-alpha", "四类都不满足"],
      absent: ["包采纳自检通过", "① import 1"],
    },
  );

  // ⑮ --report 不吞红灯
  {
    const name = "⑮ --report 打印全表但不吞红灯（未采纳仍 exit 1）";
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(
          fixtureTree({ pkgFiles: { "pkg-delta": { private: true } } }),
          { prefix: "package-adoption-selftest-" },
        );
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir, "--report"] }), {
            code: 1,
            contains: ["包目录 8 个", "packages/pkg-delta", "四类都不满足"],
            withinMs: 2000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  }

  // ⑯ 【A8·到期即红】登记的 review_by 已过 → 红（复核没人做，不是「继续躺着」）
  subprocess(
    "⑯ 登记的 review_by 已过期 → 红（有期限的豁免，不是无限期）",
    fixtureTree({
      entries: {
        "pkg-eta": {
          owner: "docs-site",
          review_by: "2000-01-01",
          kind: "internal-docs",
          artifacts: ["index.md"],
          consumers: ["scripts/reader.mjs"],
          why: "文档站私有包，消费方是本仓的文档构建流程（fixture）",
        },
      },
      pkgFiles: { "pkg-eta": { private: true } },
      extraFiles: { "scripts/reader.mjs": "// 读 pkg-eta 的 index.md（不是 import，① 不成立）\n" },
    }),
    {
      code: 1,
      contains: ["pkg-eta", "复核期限已过", "2000-01-01", "owner = docs-site"],
      absent: ["包采纳自检通过"],
    },
  );

  // ⑰ 【棘轮】登记还在，但该包已经重新有①/②/③的证据 → 红，要求删条目
  subprocess(
    "⑰ 登记该删条目了：登记的包已重新有证据 → 红（棘轮只减不增）",
    fixtureTree({
      entries: {
        "pkg-zeta": {
          owner: "docs-site",
          review_by: "2099-12-31",
          kind: "internal-docs",
          artifacts: ["index.md"],
          consumers: ["scripts/reader.mjs"],
          why: "文档站私有包，消费方是本仓的文档构建流程（fixture）",
        },
      },
      extraFiles: { "packages/pkg-alpha/src/uses-zeta.mjs": 'import { x } from "pkg-zeta";\nexport default x;\n' },
      pkgFiles: { "pkg-zeta": { private: true } },
    }),
    {
      code: 1,
      contains: ["pkg-zeta", "该删条目了", "重新有「谁在用我」的证据"],
      absent: ["包采纳自检通过"],
    },
  );

  const failed = reportCases(cases, { title: "check-package-adoption selftest" });
  if (failed > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  if (process.argv.includes("--selftest")) {
    runSelftest();
  } else {
    runCli(resolve(argValue(process.argv, "--root") ?? process.cwd()), {
      report: process.argv.includes("--report"),
    });
  }
}
